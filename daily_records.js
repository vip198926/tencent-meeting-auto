/**
 * daily_records.js — 会议转写管线（增量模式 + 按天模式）
 *
 * 两种模式：
 *   增量（主用，云端定时调用）：处理「上次处理截止 → 现在」之间结束的会议。
 *     用户会议多在早上 9 点左右结束，09:36 跑一轮正好把今早的会处理掉。
 *     进度落盘 daily/last_progress.json（processed_until，Unix 秒）。
 *   按天（CLI 补历史用）：node daily_records.js 2026-10-17
 *
 * 链路（全部用网页登录态 auth_state.json）：
 *   1. query_personal_meeting_list(meeting_state=1)  → 会议清单（含 meeting_id）
 *   2. meeting-record-list(meeting_id, c_token=we_meet_token) → 每场会的录制/转写记录（share_id）
 *   3. fetchTranscript(share_id) → 逐字稿 + AI 纪要
 *   4. uploadMarkdown → IMA
 *
 * 输出：daily/records_<标签>.md + .json
 * 去重：daily/processed_records.json 记录已处理的 record_id（仅按 record_id 维度，防增量窗口重叠导致的重复上传）；同一会议号下的不同录制/转写记录各自独立上传，避免误删不同内容的会议
 * 注意：会议列表接口只支持查最近 31 天，增量窗口起点会 clamp 到 now-31d+1d。
 */
'use strict';
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const path = require('path');
const { fetchTranscript, formatTranscript } = require('./ctm_fetch');
const { uploadMarkdown } = require('./ima_upload');
const { pushDailyReport: pushWecom } = require('./wecom_webhook');
const { pushDailyReport: pushPushplus } = require('./pushplus');
const { tokenRemainingDays } = require('./token_refresh');
const { maskId, safeErr } = require('./log_safe');

/**
 * 公开日志约定：本文件所有 log() 只输出数量/状态/段数/错误码与脱敏短 ID。
 * 会议主题、标题、会议号、逐字稿正文、接口响应体一律不进 GitHub Actions 日志。
 * 完整明细仍写入本地 records_*.md 并推送企业微信（私有通道）。
 */

/**
 * 可选交接：把本轮上传成功的逐字稿交给「收故事」步骤。
 * 仅当 workflow 设置了 STORY_BATCH_FILE 时生效；文件位于 $RUNNER_TEMP，
 * runner 结束即销毁，绝不进仓库、日志或 artifact。失败不影响主管线。
 */
function emitStoryBatch(entry) {
  const p = process.env.STORY_BATCH_FILE;
  if (!p) return;
  try { fs.appendFileSync(p, JSON.stringify(entry) + '\n', 'utf8'); } catch { /* 忽略 */ }
}

// 登录态剩余天数（失败返回 null，不阻断主流程）
function safeTokenDays() {
  try { const d = tokenRemainingDays(AUTH_PATH); return typeof d === 'number' ? Math.round(d * 10) / 10 : null; } catch { return null; }
}

/** 推送日报：优先企业微信机器人，其次 PushPlus；两者都未配置则静默跳过 */
async function notify(summary) {
  const errors = [];
  try { const r = await pushWecom(summary); if (r && r.ok) return { via: 'wecom' }; if (r && r.skipped) errors.push('wecom:' + r.reason); }
  catch (e) { errors.push('wecom:' + e.message); }
  try { const r = await pushPushplus(summary); if (r && r.ok) return { via: 'pushplus' }; if (r && r.skipped) errors.push('pushplus:' + r.reason); }
  catch (e) { errors.push('pushplus:' + e.message); }
  return { via: null, errors };
}

/**
 * 发布日报：若 workflow 设置了 CTM_REPORT_FILE，先暂存为 JSON，
 * 等「收故事」结束后由 send_report.js 把收录结果并进同一条消息再推送。
 * 未设置该变量（本地 / 巡检 / 其它调用）时行为完全不变：立即推送。
 * 暂存失败会自动回退为立即推送，绝不静默。
 */
async function publish(summary, log) {
  const file = process.env.CTM_REPORT_FILE;
  if (file) {
    try {
      fs.writeFileSync(file, JSON.stringify(summary), 'utf8');
      log('[NOTIFY] 日报已暂存，等待与收录结果合并推送');
      return;
    } catch (e) { log('[NOTIFY] 日报暂存失败，回退为立即推送：' + safeErr(e)); }
  }
  try {
    const r = await notify(summary);
    if (r.via) log(`[NOTIFY] 日报已推送（${r.via}）`);
    else log('[NOTIFY] 无可用推送通道：' + (r.errors || []).map(safeErr).join('; '));
  } catch (e) { log('[NOTIFY] 推送失败: ' + safeErr(e)); }
}

const AUTH_PATH = process.env.CTM_AUTH_STATE || path.join(__dirname, 'auth_state.json');
const OUT_DIR = path.join(__dirname, 'daily');
const PROCESSED_FILE = path.join(OUT_DIR, 'processed_records.json');
const PROGRESS_FILE = path.join(OUT_DIR, 'last_progress.json'); // 增量进度
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

// 每次调用都重新读取登录态（支持 server 热更新 auth_state.json）
function loadAuth() {
  const state = JSON.parse(fs.readFileSync(AUTH_PATH, 'utf8'));
  return {
    state,
    cookie: state.cookies.map(c => `${c.name}=${c.value}`).join('; '),
    accountCorpId: (state.cookies.find(c => c.name === 'account_corp_id') || {}).value || '909122468',
    weMeetToken: (state.cookies.find(c => c.name === 'we_meet_token') || {}).value || '',
    tokenExpire: Number((state.cookies.find(c => c.name === 'token_expire_time') || {}).value || 0),
  };
}

function buildQuery(accountCorpId, extra) {
  const q = {
    c_app_id: '', c_os_model: 'web', c_os: 'web', c_os_version: '1',
    c_timestamp: String(Date.now()),
    c_nonce: crypto.randomBytes(5).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 10),
    c_app_version: '', c_instance_id: '5', c_district: '0', platform: 'Web',
    c_app_uid: '', c_lang: 'zh-CN', c_account_corp_id: accountCorpId,
    ...(extra || {}),
  };
  return Object.entries(q).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
}

function req(method, url, body, cookie) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method,
      headers: {
        'Content-Type': 'application/json', 'User-Agent': UA,
        Accept: 'application/json', 'Cookie': cookie,
        Referer: 'https://meeting.tencent.com/user-center/user-meeting-list',
      },
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    if (data) r.write(data);
    r.on('error', e => reject(e));
    r.end();
  });
}

// 北京时区的日期字符串（服务器可能在任意时区，必须显式 +8）
function bjDateString(offsetDays) {
  const d = new Date(Date.now() + 8 * 3600000 - (offsetDays || 0) * 86400000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}
// 北京时区的「YYYYMMDD_HHmm」标签（日报文件名用）
function bjTag() {
  const d = new Date(Date.now() + 8 * 3600000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}_${p(d.getUTCHours())}${p(d.getUTCMinutes())}`;
}
// 北京时间人话格式
function bjFmt(ms) {
  const d = new Date(ms + 8 * 3600000);
  const p = n => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

function fmt(ts, withSec) {
  const d = new Date(Number(ts) * 1000);
  const p = n => String(n).padStart(2, '0');
  const base = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  return withSec ? base + ':' + p(d.getSeconds()) : base;
}

function sanitize(s) { return (s || '').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60); }

function loadProcessed() {
  try { return new Set(JSON.parse(fs.readFileSync(PROCESSED_FILE, 'utf8'))); }
  catch { return new Set(); }
}

function saveProcessed(set) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(PROCESSED_FILE, JSON.stringify([...set], null, 1), 'utf8');
}

function loadProgress() {
  try { return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8')); } catch { return null; }
}

function saveProgress(processedUntilSec) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify({ processed_until: processedUntilSec, updated: new Date().toISOString() }, null, 1), 'utf8');
}

/** 登录态预检（过期/缺 token 只告警不阻断，由后续接口报错体现） */
function checkAuth(log) {
  const { weMeetToken, tokenExpire } = loadAuth();
  if (tokenExpire && tokenExpire * 1000 < Date.now()) {
    log(`⚠️ we_meet_token 已过期（${new Date(tokenExpire * 1000).toLocaleString('zh-CN')}），录制列表接口会失败。请在本机跑 sync_auth.bat 刷新并同步`);
  }
  if (!weMeetToken) log('⚠️ auth_state.json 中缺少 we_meet_token，无法查录制列表');
}

// ---- 逐字稿比对 / 合并辅助 ----
// 归一化：去空白、去标点、转小写，仅保留中英文与数字
function normText(s) {
  return (s || '').replace(/\s+/g, '').replace(/[^\u4e00-\u9fa5a-zA-Z0-9]/g, '').toLowerCase();
}
// 字符 n-gram 集合（默认 4 字），用于内容相似度
function grams(s, n = 4) {
  const t = normText(s);
  const set = new Set();
  for (let i = 0; i + n <= t.length; i++) set.add(t.slice(i, i + n));
  return set;
}
// 两份文本的 Jaccard 相似度（0~1）
function textSimilarity(a, b) {
  const A = grams(a), B = grams(b);
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter);
}
// other 中有多少比例的内容是 base 里没有的（互补度）
function uniqueFraction(other, base) {
  const B = grams(base), O = grams(other);
  if (!O.size) return 0;
  let uniq = 0;
  for (const g of O) if (!B.has(g)) uniq++;
  return uniq / O.size;
}
// 段落去重 key
function paraKey(p) {
  const t = (p.sentences || []).map(s => (s.words || []).map(w => w.text || '').join('')).join('');
  return normText(t);
}
// 合并两份段落数组，按内容去重，保留顺序
function mergeParagraphs(p1, p2) {
  const seen = new Set();
  const out = [];
  for (const p of [...(p1 || []), ...(p2 || [])]) {
    const k = paraKey(p);
    if (k && seen.has(k)) continue;
    if (k) seen.add(k);
    out.push(p);
  }
  return out;
}
const SIM_THRESHOLD = 0.35; // 相似度 >= 此值视为同一场会，否则视为两场不同会议

/** 拉取 [startMs, endMs) 内开始的已结束会议 */
async function fetchMeetings(startMs, endMs) {
  const { cookie, accountCorpId } = loadAuth();
  const all = [];
  for (let page = 1; page <= 10; page++) {
    const url = `https://meeting.tencent.com/wemeet-tapi/wemeet/manage_service/personal/v1/query_personal_meeting_list?${buildQuery(accountCorpId)}`;
    const res = await req('POST', url, {
      meetingCode: '', subject: '', begin_time: Math.floor(startMs / 1000), end_time: Math.floor(endMs / 1000),
      page_index: page, page_size: 20, binary_meeting_type: 0, meeting_state: 1, sort: 1, time_zone: 'Asia/Shanghai',
    }, cookie);
    let j;
    try { j = JSON.parse(res.body); } catch { throw new Error('会议列表返回异常: ' + res.body.slice(0, 200)); }
    if (j.code !== 0) throw new Error('会议列表查询失败（可能需要重新登录）: ' + res.body.slice(0, 200));
    const list = j.meeting_list || [];
    all.push(...list);
    if (all.length >= Number(j.total_num || 0) || list.length < 20) break;
  }
  return all.filter(m => {
    const t = Number(m.begin_time) * 1000;
    return t >= startMs && t < endMs;
  });
}

/** 处理会议清单：逐会查录制记录 → 转写 → 上传 IMA。返回统计 + 明细行 */
async function processMeetings(dayMeetings, log) {
  const processed = loadProcessed();
  const results = [];
  const lines = [];
  let okCount = 0, failCount = 0, skipCount = 0, noRecordCount = 0;

  for (let i = 0; i < dayMeetings.length; i++) {
    const m = dayMeetings[i];
    const mTime = fmt(m.begin_time);
    const mSubject = m.subject || '(无主题)';
    log(`[${i + 1}/${dayMeetings.length}] ${mTime} | 会议 ${maskId(m.meeting_id)}`);

    // 查该会的录制记录（需要 we_meet_token）
    let records = [];
    try {
      const { cookie, accountCorpId, weMeetToken } = loadAuth();
      const rurl = `https://meeting.tencent.com/wemeet-tapi/v2/meetlog/dashboard/meeting-record-list?${buildQuery(accountCorpId, { c_token: weMeetToken })}`;
      const rres = await req('POST', rurl, { page_size: '20', page_index: '1', meeting_id: String(m.meeting_id) }, cookie);
      const rj = JSON.parse(rres.body);
      if (rj.code === 0 && rj.data) records = rj.data.records || [];
      else log(`    ⚠️ 录制列表查询返回 ${safeErr('code=' + rj.code)}`);
    } catch (e) {
      log(`    ⚠️ 录制列表查询异常: ${safeErr(e)}`);
    }

    if (!records.length) {
      noRecordCount++;
      results.push({ meeting_id: m.meeting_id, subject: mSubject, time: mTime, ok: false, skipped: true, reason: '无录制/转写记录' });
      lines.push(`| ${mTime} | ${mSubject} | — | 无录制/转写 |`);
      continue;
    }

    // 选稿策略：同一会议若同时有「转写」与「录制」两份逐字稿，先都抓取比对：
    //   - 内容相似度高（>= SIM_THRESHOLD）→ 视为同一场会：保留内容更多的一份；
    //     若两份互补（短份含有长份缺失的内容）则合并后存一份。
    //   - 内容相似度低 → 实为同一会议号下的两场不同会议：两份各自独立上传，互不合并、互不丢弃。
    //   - 只有一类 → 直接上传该类。
    // 去重仍按 record_id；每上传一份就把涉及的所有 record_id 标记已处理，避免增量窗口重叠重复上传。
    const transRecs = records.filter(r => /^转写[_-]/.test(r.title || mSubject));
    const recRecs = records.filter(r => !/^转写[_-]/.test(r.title || mSubject));
    const hasBoth = transRecs.length > 0 && recRecs.length > 0;

    // 抓取：至少一条未处理才抓；若两类都有则需两边都抓来比对（即便某条已上传过也要取文本比对）
    const toFetch = hasBoth ? records : records.filter(r => !processed.has(r.record_id));
    const fetched = [];
    for (const rec of toFetch) {
      const rid = rec.record_id;
      const rTitle = rec.title || mSubject;
      const kind = /^转写[_-]/.test(rTitle) ? '转写' : '录制';
      try {
        const t = await fetchTranscript(rid, { authPath: AUTH_PATH });
        fetched.push({ rid, rTitle, kind, t, paragraphs: t.paragraphs.length, text: t.text, hasSummary: !!t.meta.summary });
      } catch (e) {
        failCount++;
        log(`    ❌ 抓取失败 记录 ${maskId(rid)} — ${safeErr(e)}`);
        results.push({ record_id: rid, subject: rTitle, time: mTime, kind, ok: false, error: e.message });
      }
      await new Promise(r => setTimeout(r, 700));
    }

    // 单条上传（含已处理跳过）
    const uploadOne = async (f) => {
      if (processed.has(f.rid)) {
        skipCount++;
        log(`    ⏭️ 已上传过，跳过：记录 ${maskId(f.rid)}`);
        results.push({ record_id: f.rid, subject: f.rTitle, time: mTime, ok: true, skipped: true, reason: '已上传过' });
        lines.push(`| ${mTime} | ${f.rTitle} | ${f.kind} | ⏭️ 已上传过 |`);
        return;
      }
      const title = sanitize(f.t.meta.subject) || sanitize(f.rTitle);
      const up = await uploadMarkdown(title, f.text);
      emitStoryBatch({ media_id: up.media_id, record_id: f.rid, text: f.text });
      okCount++;
      processed.add(f.rid);
      saveProcessed(processed);
      log(`    ✅ 已上传 记录 ${maskId(f.rid)}（${f.paragraphs} 段${f.hasSummary ? '，含AI纪要' : ''}）`);
      results.push({ record_id: f.rid, subject: f.rTitle, time: mTime, kind: f.kind, ok: true, title: up.title, paragraphs: f.paragraphs, hasSummary: f.hasSummary });
      lines.push(`| ${mTime} | ${up.title} | ${f.kind} | ✅ ${f.paragraphs} 段 |`);
    };

    if (hasBoth && fetched.length >= 2) {
      const tF = fetched.find(f => f.kind === '转写');
      const rF = fetched.find(f => f.kind === '录制');
      const sim = textSimilarity(tF.text, rF.text);
      if (sim >= SIM_THRESHOLD) {
        // 同一场会：取内容更多者；若互补则合并
        const longer = rF.text.length >= tF.text.length ? rF : tF;
        const shorter = longer === rF ? tF : rF;
        let outText = longer.text, outParas = longer.t.paragraphs, note = '保留内容较多的一份';
        if (uniqueFraction(shorter.text, longer.text) > 0.15) {
          outParas = mergeParagraphs(longer.t.paragraphs, shorter.t.paragraphs);
          outText = formatTranscript(outParas, longer.t.meta);
          note = '综合两份互补内容';
        }
        const title = sanitize(longer.t.meta.subject) || sanitize(mSubject);
        try {
          const up = await uploadMarkdown(title, outText);
          emitStoryBatch({ media_id: up.media_id, record_id: tF.rid, text: outText });
          okCount++;
          for (const f of fetched) processed.add(f.rid);
          saveProcessed(processed);
          log(`    ✅ 已上传 会议 ${maskId(m.meeting_id)}（${outParas.length} 段｜${note}｜相似度 ${(sim * 100).toFixed(0)}%）`);
          results.push({ meeting_id: m.meeting_id, subject: mSubject, time: mTime, ok: true, title: up.title, paragraphs: outParas.length, merged: note });
          lines.push(`| ${mTime} | ${up.title} | 综合 | ✅ ${outParas.length} 段｜${note} |`);
        } catch (e) {
          failCount++;
          log(`    ❌ 合并上传失败 会议 ${maskId(m.meeting_id)} — ${safeErr(e)}`);
          results.push({ meeting_id: m.meeting_id, subject: mSubject, time: mTime, ok: false, error: e.message });
          lines.push(`| ${mTime} | ${mSubject} | 综合 | ❌ ${e.message.slice(0, 60)} |`);
        }
      } else {
        // 实为两场不同会议：各自独立上传
        for (const f of fetched) await uploadOne(f);
      }
    } else {
      // 单边或抓取不全：逐条上传未处理的
      for (const f of fetched) await uploadOne(f);
    }
  }
  return { ok: okCount, fail: failCount, skipped: skipCount, noRecord: noRecordCount, results, lines };
}

/** 写日报文件（records_<tag>.md/.json） */
function writeReport(tag, title, stats) {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const md = [
    `# ${title}`,
    '',
    `- 成功上传：${stats.ok} 份`,
    `- 失败：${stats.fail} 条`,
    `- 跳过（已上传）：${stats.skipped} 条`,
    `- 无录制/转写的会：${stats.noRecord} 场`,
    '',
    '| 时间 | 标题 | 类型 | 结果 |',
    '|---|---|---|---|',
    ...stats.lines,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(OUT_DIR, `records_${tag}.md`), md, 'utf8');
  fs.writeFileSync(path.join(OUT_DIR, `records_${tag}.json`), JSON.stringify({ tag, ...stats }, null, 1), 'utf8');
  return md;
}

/**
 * 增量管线：处理「上次截止 → 现在」之间结束的会议。
 * @param {object} opts { log: fn, notify: bool }
 * @returns {Promise<object>} { date, meetings, ok, fail, skipped, noRecord, window:{from,to}, stale_hours, md, lines }
 */
async function runIncremental(opts = {}) {
  const log = opts.log || console.log;
  checkAuth(log);

  const now = Date.now();
  const earliest = now - 31 * 86400000 + 86400000; // 会议列表只支持最近 31 天
  const prog = loadProgress();
  const staleMs = prog ? now - prog.processed_until * 1000 : 24 * 3600000;
  let windowStart = prog ? prog.processed_until * 1000 : now - 24 * 3600000; // 无进度记录时兜底看最近 24 小时
  if (windowStart < earliest) windowStart = earliest;

  log(`[INC] 增量窗口：${bjFmt(windowStart)} → ${bjFmt(now)}（此前 ${(staleMs / 3600000).toFixed(1)} 小时未处理）`);
  const meetings = await fetchMeetings(windowStart, now);
  log(`[INC] 窗口内共 ${meetings.length} 场会`);

  const stats = await processMeetings(meetings, log);
  const tag = bjTag();
  const md = writeReport(tag, `会议转写日报（${bjFmt(windowStart)} → ${bjFmt(now)}，${meetings.length} 场会）`, stats);
  saveProgress(Math.floor(now / 1000));

  log(`\n[INC] 完成：✅ ${stats.ok} | ❌ ${stats.fail} | ⏭️ ${stats.skipped} | 无录制 ${stats.noRecord} 场`);
  log(`[INC] 报告：${path.join(OUT_DIR, `records_${tag}.md`)}`);

  const summary = {
    source: opts.source || 'inc',
    date: bjDateString(0), meetings: meetings.length,
    ok: stats.ok, fail: stats.fail, skipped: stats.skipped, noRecord: stats.noRecord,
    window: { from: Math.floor(windowStart / 1000), to: Math.floor(now / 1000) },
    stale_hours: Math.round(staleMs / 3600000), md, lines: stats.lines,
    token_remaining_days: safeTokenDays(),
  };
  if (opts.notify !== false) await publish(summary, log);
  return summary;
}

/**
 * 按天管线（CLI 补历史用）：处理指定日期的会议。
 * @param {string} targetDate YYYY-MM-DD（默认：北京时间的昨天）
 * @param {object} opts { log: fn, notify: bool }
 */
async function runDaily(targetDate, opts = {}) {
  const log = opts.log || console.log;
  checkAuth(log);

  const target = targetDate || bjDateString(1);
  const dayStart = new Date(target + 'T00:00:00+08:00').getTime();
  const dayEnd = dayStart + 86400000;
  log(`[DAILY] 目标日期：${target}`);

  const dayMeetings = await fetchMeetings(dayStart, dayEnd);
  log(`[DAILY] ${target} 当天共 ${dayMeetings.length} 场会`);

  const stats = await processMeetings(dayMeetings, log);
  const md = writeReport(target, `${target} 会议转写日报（${dayMeetings.length} 场会）`, stats);

  log(`\n[DAILY] 完成：✅ ${stats.ok} | ❌ ${stats.fail} | ⏭️ ${stats.skipped} | 无录制 ${stats.noRecord} 场`);
  log(`[DAILY] 报告：${path.join(OUT_DIR, `records_${target}.md`)}`);

  const summary = { source: opts.source || 'daily', date: target, meetings: dayMeetings.length, ok: stats.ok, fail: stats.fail, skipped: stats.skipped, noRecord: stats.noRecord, md, lines: stats.lines, token_remaining_days: safeTokenDays() };
  if (opts.notify !== false) await publish(summary, log);
  // 按天补跑：若该日结束时间晚于当前进度，推进进度（避免增量重复拉）
  const prog = loadProgress();
  if (!prog || Math.floor(dayEnd / 1000) > prog.processed_until) saveProgress(Math.floor(dayEnd / 1000));
  return summary;
}

module.exports = { runDaily, runIncremental, bjDateString, bjTag, bjFmt, loadProgress, saveProgress, loadProcessed };

// CLI 入口：node daily_records.js            → 按天（昨天）
//           node daily_records.js 2026-10-17 → 按天（指定日期）
//           node daily_records.js inc [--no-notify] → 增量
if (require.main === module) {
  const arg = process.argv[2];
  const noNotify = process.argv.includes('--no-notify');
  if (arg === 'inc' || arg === 'incremental') {
    runIncremental({ notify: !noNotify }).catch(e => { console.error('FATAL', safeErr(e)); process.exit(1); });
  } else {
    runDaily(arg, { notify: !noNotify }).catch(e => { console.error('FATAL', safeErr(e)); process.exit(1); });
  }
}
