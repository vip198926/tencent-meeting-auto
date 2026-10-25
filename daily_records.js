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
 * 去重：daily/processed_records.json 记录已处理的 record_id；同一会议的多条记录（录制/转写）只上传最优一份（优先带AI纪要，其次段落更多），避免重复上传 IMA
 * 注意：会议列表接口只支持查最近 31 天，增量窗口起点会 clamp 到 now-31d+1d。
 */
'use strict';
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const path = require('path');
const { fetchTranscript } = require('./ctm_fetch');
const { uploadMarkdown } = require('./ima_upload');
const { pushDailyReport: pushWecom } = require('./wecom_webhook');
const { pushDailyReport: pushPushplus } = require('./pushplus');
const { tokenRemainingDays } = require('./token_refresh');

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
    log(`[${i + 1}/${dayMeetings.length}] ${mTime} | ${mSubject} | 会议号 ${m.meeting_code}`);

    // 查该会的录制记录（需要 we_meet_token）
    let records = [];
    try {
      const { cookie, accountCorpId, weMeetToken } = loadAuth();
      const rurl = `https://meeting.tencent.com/wemeet-tapi/v2/meetlog/dashboard/meeting-record-list?${buildQuery(accountCorpId, { c_token: weMeetToken })}`;
      const rres = await req('POST', rurl, { page_size: '20', page_index: '1', meeting_id: String(m.meeting_id) }, cookie);
      const rj = JSON.parse(rres.body);
      if (rj.code === 0 && rj.data) records = rj.data.records || [];
      else log(`    ⚠️ 录制列表查询返回 code=${rj.code}: ${(rj.err_detail || rj.msg || '').slice(0, 100)}`);
    } catch (e) {
      log(`    ⚠️ 录制列表查询异常: ${e.message.slice(0, 100)}`);
    }

    if (!records.length) {
      noRecordCount++;
      results.push({ meeting_id: m.meeting_id, subject: mSubject, time: mTime, ok: false, skipped: true, reason: '无录制/转写记录' });
      lines.push(`| ${mTime} | ${mSubject} | — | 无录制/转写 |`);
      continue;
    }

    // 方案 B：同一会议的多条记录（录制 / 转写）只上传最优一份，其余标记已处理避免重复上传 IMA
    const fetched = [];
    for (const rec of records) {
      const rid = rec.record_id;
      const rTitle = rec.title || mSubject;
      const kind = /^转写[_-]/.test(rTitle) ? '转写' : '录制';
      if (processed.has(rid) || processed.has('m:' + m.meeting_id)) {
        skipCount++;
        log(`    ⏭️ 已处理过（同会议去重），跳过：${rTitle}`);
        results.push({ record_id: rid, subject: rTitle, time: mTime, ok: true, skipped: true, reason: '已处理过' });
        lines.push(`| ${mTime} | ${rTitle} | ${kind} | ⏭️ 已处理过 |`);
        continue;
      }
      try {
        const t = await fetchTranscript(rid, { authPath: AUTH_PATH });
        fetched.push({ rid, rTitle, kind, t, paragraphs: t.paragraphs.length, hasSummary: !!t.meta.summary });
      } catch (e) {
        failCount++;
        log(`    ❌ ${rTitle} — ${e.message.slice(0, 150)}`);
        results.push({ record_id: rid, subject: rTitle, time: mTime, kind, ok: false, error: e.message });
        lines.push(`| ${mTime} | ${rTitle} | ${kind} | ❌ ${e.message.slice(0, 60)} |`);
      }
      await new Promise(r => setTimeout(r, 700));
    }

    // 选最优：优先带 AI 纪要，其次段落更多
    let best = null;
    for (const f of fetched) {
      const score = (f.hasSummary ? 1000 : 0) + f.paragraphs;
      if (!best || score > best.score) best = { ...f, score };
    }

    // 上传最优一份；其余同会议记录标记已处理但不重复上传 IMA（保证只有录制无转写时也能正常上传）
    for (const f of fetched) {
      if (f === best) {
        const title = sanitize(f.t.meta.subject) || sanitize(f.rTitle);
        try {
          const up = await uploadMarkdown(title, f.t.text);
          okCount++;
          processed.add(f.rid);
          processed.add('m:' + m.meeting_id);
          saveProcessed(processed);
          log(`    ✅ ${up.title}（${f.paragraphs} 段${f.hasSummary ? '，含AI纪要' : ''}）`);
          results.push({ record_id: f.rid, subject: f.rTitle, time: mTime, kind: f.kind, ok: true, title: up.title, paragraphs: f.paragraphs, hasSummary: f.hasSummary });
          lines.push(`| ${mTime} | ${up.title} | ${f.kind} | ✅ ${f.paragraphs} 段 |`);
        } catch (e) {
          failCount++;
          log(`    ❌ ${f.rTitle} — ${e.message.slice(0, 150)}`);
          results.push({ record_id: f.rid, subject: f.rTitle, time: mTime, kind: f.kind, ok: false, error: e.message });
          lines.push(`| ${mTime} | ${f.rTitle} | ${f.kind} | ❌ ${e.message.slice(0, 60)} |`);
        }
      } else {
        // 次优记录：已抓取，不再上传 IMA，但标记已处理，避免增量窗口重叠时重复 fetch
        processed.add(f.rid);
        saveProcessed(processed);
        skipCount++;
        log(`    ⏭️ 同会议已选更优记录（${best.paragraphs}段${best.hasSummary ? '·含AI纪要' : ''}），跳过：${f.rTitle}（${f.paragraphs}段）`);
        results.push({ record_id: f.rid, subject: f.rTitle, time: mTime, kind: f.kind, ok: true, skipped: true, reason: '同会议次优记录' });
        lines.push(`| ${mTime} | ${f.rTitle} | ${f.kind} | ⏭️ 同会议已选更优 |`);
      }
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
  if (opts.notify !== false) {
    try {
      const r = await notify(summary);
      if (r.via) log(`[NOTIFY] 日报已推送（${r.via}）`);
      else log('[NOTIFY] 无可用推送通道：' + (r.errors || []).join('; '));
    } catch (e) { log('[NOTIFY] 推送失败: ' + e.message.slice(0, 100)); }
  }
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
  if (opts.notify !== false) {
    try {
      const r = await notify(summary);
      if (r.via) log(`[NOTIFY] 日报已推送（${r.via}）`);
      else log('[NOTIFY] 无可用推送通道：' + (r.errors || []).join('; '));
    } catch (e) { log('[NOTIFY] 推送失败: ' + e.message.slice(0, 100)); }
  }
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
    runIncremental({ notify: !noNotify }).catch(e => { console.error('FATAL', e.message); process.exit(1); });
  } else {
    runDaily(arg, { notify: !noNotify }).catch(e => { console.error('FATAL', e.message); process.exit(1); });
  }
}
