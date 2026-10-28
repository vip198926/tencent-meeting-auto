/**
 * ctm_fetch.js — 纯 HTTP 抓取腾讯会议录制转写（无需浏览器 / playwright）
 *
 * 解析链：
 *   分享短码/URL  ->  /cw/<code> HTML 提取 sharing UUID   (无需登录)
 *   UUID         ->  common-record-info 取 meeting_id      (需登录 cookie)
 *   UUID         ->  get-multi-record-info 取 recording_id (需登录 cookie)
 *   UUID+ids     ->  minutes/detail (limit 拉满) 取转写全文 (需登录 cookie)
 *
 * 用法：
 *   node ctm_fetch.js <短码或分享链接> [输出文件.md]
 *   或在代码中： const { fetchTranscript } = require('./ctm_fetch');
 *               const r = await fetchTranscript('2qOaRz6Oba');
 */
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
// 支持：/ctm/<code>、/crm/<code>、/cw/<code>、/ct/<code>
// 以及 UUID 直链：/v2/cloud-record/share?id=<uuid>、/meeting-record/shares?id=<uuid>
const CTM_URL_RE = /https?:\/\/meeting\.tencent\.com\/(?:(?:ctm|crm|cw|ct)\/([A-Za-z0-9]+)|(?:v2\/cloud-record\/share|meeting-record\/shares)\?[^"'\s]*?\bid=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}))/gi;

function loadAuth(authPath) {
  const p = authPath || process.env.CTM_AUTH_STATE || 'auth_state.json';
  const state = JSON.parse(fs.readFileSync(p, 'utf8'));
  const cookie = state.cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const accountCorpId = (state.cookies.find(c => c.name === 'account_corp_id') || {}).value || '909122468';
  return { cookie, accountCorpId };
}

function buildQuery(extra, accountCorpId) {
  const q = {
    c_app_id: '', c_os_model: 'web', c_os: 'web', c_os_version: 'Mozilla/5.0',
    c_timestamp: String(Date.now()),
    c_nonce: crypto.randomBytes(5).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 10),
    c_app_version: '', c_instance_id: '5', c_district: '0', platform: 'Web',
    c_app_uid: '', c_lang: 'zh-CN', c_account_corp_id: accountCorpId,
  };
  return Object.entries({ ...q, ...extra }).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
}

function req(method, url, body, cookie) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body ? JSON.stringify(body) : null;
    const r = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method,
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0', Accept: 'application/json', 'Cookie': cookie },
    }, res => { let d = ''; res.on('data', c => d += c); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    if (data) r.write(data);
    r.on('error', e => reject(e));
    r.end();
  });
}

function deepFind(obj, key) {
  const s = JSON.stringify(obj || {});
  const m = new RegExp('"' + key + '"\\s*:\\s*"?([^",}]+)"?').exec(s);
  return m ? m[1] : null;
}

/** 从用户输入（短码 / URL / UUID / 混有标题的整行文本）归一化为 short code 或 UUID */
function normalizeInput(input) {
  if (!input) throw new Error('缺少输入：短码 / 分享链接 / UUID');
  const t = input.trim();
  // 1. 整串就是 UUID
  if (UUID_RE.test(t) && t.replace(UUID_RE, '').trim() === '') {
    return { uuid: t.match(UUID_RE)[0], code: null };
  }
  // 2. 文本里含腾讯会议分享 URL -> 用 URL 里的 code/UUID（优先于零散 UUID）
  CTM_URL_RE.lastIndex = 0;
  const urlMatch = CTM_URL_RE.exec(t);
  if (urlMatch) {
    if (urlMatch[2]) return { uuid: urlMatch[2], code: null };
    const seg = urlMatch[1];
    if (UUID_RE.test(seg)) return { uuid: seg, code: null };
    return { uuid: null, code: seg };
  }
  // 3. 兜底：文本里出现的第一个 UUID
  const u = UUID_RE.exec(t);
  if (u) return { uuid: u[0], code: null };
  // 4. 当作纯短码
  return { uuid: null, code: t };
}

/** 从整块粘贴文本中提取所有腾讯会议分享链接，去重，返回 [{uuid,code,url}] */
function extractMeetingLinks(text) {
  if (!text) return [];
  CTM_URL_RE.lastIndex = 0;
  const seen = new Set();
  const out = [];
  let m;
  while ((m = CTM_URL_RE.exec(text)) !== null) {
    let entry;
    if (m[2]) {
      const key = m[2];
      if (seen.has(key)) continue;
      seen.add(key);
      entry = { uuid: m[2], code: null, url: m[0] };
    } else {
      const seg = m[1];
      const isUuid = UUID_RE.test(seg);
      const key = isUuid ? seg : seg.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      entry = { uuid: isUuid ? seg : null, code: isUuid ? null : seg, url: m[0] };
    }
    out.push(entry);
  }
  return out;
}

async function resolveUUID(code, cookie) {
  const html = await req('GET', `https://meeting.tencent.com/cw/${code}`, null, cookie || '');
  // 页面含多个 UUID，真正的分享 UUID 绑定在 short code 上，形如
  //   "long_url":"id=07ea31a3-...  或  short_link=2qOaRz6Oba&id=07ea31a3-...
  // 切勿取第一个 UUID（可能是页面通用的 sharing_id）。
  const idRe = /[?&"']id=([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
  const m = idRe.exec(html.body);
  if (m) return m[1];
  // 兜底：取第一个 UUID（极端情况下）
  const any = UUID_RE.exec(html.body);
  if (any) return any[0];
  throw new Error('在 /cw/' + code + ' 页面未找到 sharing UUID（可能链接失效、需密码或已删除）');
}

function tryBase64Decode(s) {
  if (!s || typeof s !== 'string') return '';
  // 主题常见为 UTF-8 文本的 Base64（含中文时长度明显 > 原文且全是 Base64 字符）
  if (!/^[A-Za-z0-9+/=]+$/.test(s) || s.length < 4) return s;
  try {
    const decoded = Buffer.from(s, 'base64').toString('utf8');
    // 解码结果含可打印中文/ASCII 才采用，避免把正常短英文误判
    if (/[\u4e00-\u9fa5]/.test(decoded) || /^[\x20-\x7e]+$/.test(decoded)) return decoded;
  } catch { /* 保持原值 */ }
  return s;
}

function fmtDateTime(ms) {
  const t = Number(ms);
  if (!t || Number.isNaN(t)) return '';
  const d = new Date(t);
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}/${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

async function getMeetingInfo(uuid, cookie, accountCorpId) {
  const url = `https://meeting.tencent.com/wemeet-tapi/v2/meetlog/public/detail/common-record-info?${buildQuery({ c_lang: 'zh-CN' }, accountCorpId)}`;
  const res = await req('POST', url, {
    pk_meeting_info_id: '', sharing_id: uuid, is_single: false,
    cover_image_style: 'meetlog_detail_webp_1000', ticket: '', randstr: '', pwd: '',
    activity_uid: '', lang: 'zh', is_origin_content: true, is_cve: true,
    forward_cgi_path: 'shares', enter_from: 'share', short_url_code: '', is_short_ctw: false,
  }, cookie);
  const j = JSON.parse(res.body);
  if (j.code !== 0 && !j.data) throw new Error('common-record-info 失败: ' + res.body.slice(0, 200));
  const d = j.data || {};
  const mi = d.meeting_info || {};
  const meeting_id = deepFind(d, 'meeting_id') || deepFind(mi, 'meeting_id');
  const members = (d.meeting_members || []).map(m => m.user_name).filter(Boolean);
  const rawSubject = mi.subject || mi.origin_subject || d.subject || d.title || d.meeting_title || d.name || '';
  const subject = tryBase64Decode(rawSubject);
  const duration = d.total_recording_duration || '';
  const startTime = mi.start_time || d.recording_start_time || '';
  const creator = (d.record_creator && (d.record_creator.creator_name || d.record_creator.creator_nick_name)) || '';
  const sharingState = d.sharing_state;
  return { meeting_id, subject, members, duration, sharingState, startTime, creator, raw: d };
}

async function getSummary({ meeting_id, recording_id, uuid }, cookie, accountCorpId) {
  if (!meeting_id) return '';
  const url = `https://meeting.tencent.com/wemeet-tapi/v2/meetlog/public/record-detail/query-summary-and-note?${buildQuery({ meeting_id, c_lang: 'zh-CN' }, accountCorpId)}`;
  const res = await req('POST', url, {
    record_id: recording_id || '', pwd_token: '', activity_uid: '',
    meeting_id, lang: 'zh', share_id: uuid || '', template_id: '',
  }, cookie);
  let j;
  try { j = JSON.parse(res.body); } catch { return ''; }
  if (j.code !== 0 || !j.data) return '';
  const tmpl = (j.data.official_template_summary) || j.data.template_summary || null;
  const infos = (tmpl && tmpl.summary_infos) || [];
  const parts = [];
  for (const it of infos) {
    const c = (it && it.content || '').trim();
    if (c && c !== '---') parts.push(c);
  }
  return parts.join('\n\n');
}

async function getRecordingId(uuid, cookie, accountCorpId) {
  const url = `https://meeting.tencent.com/wemeet-tapi/v2/meetlog/public/record-detail/get-multi-record-info?${buildQuery({ mock: 1, auth_share_id: uuid, uni_record_share_id: uuid, activity_uid: '', c_lang: 'zh-CN' }, accountCorpId)}`;
  const res = await req('GET', url, null, cookie);
  const j = JSON.parse(res.body);
  const info = (j.data && j.data.base_infos && j.data.base_infos[0]) || {};
  const recording_id = info.recording_id || deepFind(j, 'recording_id');
  if (!recording_id) throw new Error('get-multi-record-info 未返回 recording_id（cookie 可能失效或链接无录制）');
  return recording_id;
}

async function getUniRecordId(uuid, cookie, accountCorpId) {
  const url = `https://meeting.tencent.com/wemeet-tapi/v2/meetlog/public/record-detail/uni-record-id?${buildQuery({ c_lang: 'zh-CN' }, accountCorpId)}`;
  const res = await req('POST', url, { share_id: uuid, record_type: 2 }, cookie);
  const j = JSON.parse(res.body);
  if (j.code !== 0 || !j.data || !j.data.uni_record_id) throw new Error('uni-record-id 未返回 uni_record_id（链接可能失效或类型不支持）');
  return j.data.uni_record_id;
}

async function getTranscript(uuid, meeting_id, recording_id, cookie, accountCorpId) {
  const url = `https://meeting.tencent.com/wemeet-cloudrecording-webapi/v1/minutes/detail?${buildQuery({
    id: uuid, pwd: '', activity_uid: '', page_source: 'record', meeting_id, recording_id,
    share_id: '', short_url_code: '', lang: 'zh', minutes_version: 0, limit: 500,
    return_ori: 0, start_pid: 0, return_ori_minutes_translating: 1, fview: 1,
  }, accountCorpId)}`;
  const res = await req('GET', url, null, cookie);
  const j = JSON.parse(res.body);
  if (j.code !== 0 || !j.minutes) throw new Error('minutes/detail 失败: ' + res.body.slice(0, 200));
  return j.minutes.paragraphs || [];
}

function fmtTime(ms) {
  const s = Math.floor((Number(ms) || 0) / 1000);
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  const p = n => String(n).padStart(2, '0');
  return `${p(h)}:${p(m)}:${p(sec)}`;
}

function formatTranscript(paragraphs, meta) {
  const lines = [];
  lines.push(`# ${meta.subject || '腾讯会议转写'}`);
  lines.push('');
  if (meta.url) lines.push(`- 来源：${meta.url}`);
  if (meta.startTime) lines.push(`- 转写时间：${fmtDateTime(meta.startTime)}`);
  if (meta.duration) {
    const s = Math.floor((Number(meta.duration) || 0) / 1000);
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    lines.push(`- 时长：${h > 0 ? h + ' 小时 ' : ''}${m} 分钟`);
  }
  lines.push(`- 段落数：${paragraphs.length}`);
  if (meta.members && meta.members.length) lines.push(`- 发言人：${meta.members.join('、')}`);
  if (meta.creator) lines.push(`- 录制者：${meta.creator}`);
  lines.push('');
  if (meta.summary) {
    lines.push('## AI 纪要');
    lines.push('');
    lines.push(meta.summary);
    lines.push('');
    lines.push('---');
    lines.push('');
  }
  lines.push('## 逐字稿');
  lines.push('');
  for (const p of paragraphs) {
    const t = fmtTime(p.start_time);
    const speaker = (p.speaker && (p.speaker.user_name || p.speaker.nick_name)) || '未知发言人';
    const text = (p.sentences || []).map(s => (s.words || []).map(w => w.text || '').join('')).join('');
    lines.push(`[${t}] ${speaker}：`);
    lines.push(text);
    lines.push('');
  }
  return lines.join('\n');
}

async function fetchTranscript(input, opts = {}) {
  const { cookie, accountCorpId } = loadAuth(opts.authPath);
  const { uuid: inUuid, code } = normalizeInput(input);
  const uuid = inUuid || await resolveUUID(code, cookie);
  const info = await getMeetingInfo(uuid, cookie, accountCorpId);
  // 注意：record_type=2（发言人多录制）类分享的 common-record-info 返回空，meeting_id 取不到，
  // 但 minutes/detail 接受空 meeting_id，故此处不强制要求；后续 uni-record-id 仍可拿 recording_id。
  // 对 /ctm/ 转写分享，get-multi-record-info 会返回空；浏览器实际用 uni_record_id + 1 作为 recording_id。
  // 实测 /crm/ 录制分享的 recording_id 也等于 uni_record_id + 1，因此统一走这条更稳定。
  const uni_record_id = await getUniRecordId(uuid, cookie, accountCorpId);
  const recording_id = String(BigInt(uni_record_id) + 1n);
  const paragraphs = await getTranscript(uuid, info.meeting_id, recording_id, cookie, accountCorpId);
  // AI 纪要（失败不影响主流程）
  let summary = '';
  try {
    summary = await getSummary(
      { meeting_id: info.meeting_id, recording_id, uuid },
      cookie, accountCorpId
    );
  } catch { /* 忽略 */ }
  const meta = {
    subject: info.subject, members: info.members, duration: info.duration,
    uuid, meeting_id: info.meeting_id, recording_id, uni_record_id,
    startTime: info.startTime, creator: info.creator, summary,
    url: (typeof input === 'string' && /^https?:\/\//i.test(input.trim()))
      ? input.trim()
      : `https://meeting.tencent.com/cw/${code || (inUuid || '').slice(0, 8)}`,
  };
  return { meta, paragraphs, text: formatTranscript(paragraphs, meta) };
}

// CLI
if (require.main === module) {
  (async () => {
    const input = process.argv[2];
    const out = process.argv[3];
    if (!input) { console.error('用法: node ctm_fetch.js <短码或分享链接> [输出.md]'); process.exit(1); }
    try {
      const r = await fetchTranscript(input);
      console.log(`✅ 成功：${r.paragraphs.length} 段转写` + (r.meta.subject ? `｜主题：${r.meta.subject}` : ''));
      console.log(`   meeting_id=${r.meta.meeting_id} recording_id=${r.meta.recording_id} uuid=${r.meta.uuid}`);
      if (out) { fs.writeFileSync(out, r.text, 'utf8'); console.log('   已写入', out); }
      else console.log('\n' + r.text.slice(0, 1500) + '\n…');
    } catch (e) {
      console.error('❌ 失败：', e.message);
      process.exit(1);
    }
  })();
}

module.exports = { fetchTranscript, normalizeInput, extractMeetingLinks, resolveUUID, getMeetingInfo, getSummary, getUniRecordId, getRecordingId, getTranscript, formatTranscript };
