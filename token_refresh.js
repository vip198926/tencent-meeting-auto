/**
 * token_refresh.js — 腾讯会议网页登录态纯 HTTP 自动续期（无需浏览器！）
 *
 * 核心接口（2026-10-18 实测发现）：
 *   POST https://meeting.tencent.com/wemeet-tapi/v2/account/login/refresh-token
 *   body: {"refresh_token": 1}     ← 注意是 1，0 只返回用户信息不刷新
 *   响应 Set-Cookie 带回新的 we_meet_token / token_expire_time / account_corp_id 等
 *   实测一次续期约 7 天（10-20 12:16 → 10-25 16:27）
 *
 * 安全机制：
 *   - 刷新前先备份 auth_state.json（.pre_refresh_bak）
 *   - 刷新后用新 token 调会议列表 API 验证，失败自动回滚
 *   - 全程不需要 Edge/playwright，可在云端容器运行
 */
'use strict';
const fs = require('fs');
const https = require('https');
const crypto = require('crypto');
const path = require('path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36';

function loadAuth(authPath) {
  const state = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  return {
    state,
    cookie: state.cookies.map(c => `${c.name}=${c.value}`).join('; '),
    accountCorpId: (state.cookies.find(c => c.name === 'account_corp_id') || {}).value || '909122468',
  };
}

function buildQuery(accountCorpId) {
  const q = {
    c_app_id: '', c_os_model: 'web', c_os: 'web', c_os_version: '1',
    c_timestamp: String(Date.now()),
    c_nonce: crypto.randomBytes(5).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 10),
    c_app_version: '', c_instance_id: '5', c_district: '0', platform: 'Web',
    c_app_uid: '', c_lang: 'zh-CN', c_account_corp_id: accountCorpId,
  };
  return Object.entries(q).map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
}

function post(url, body, cookie) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = JSON.stringify(body);
    const r = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: {
        'Content-Type': 'application/json', 'User-Agent': UA,
        Accept: 'application/json', 'Cookie': cookie,
        Referer: 'https://meeting.tencent.com/user-center/user-meeting-list',
      },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, setCookie: res.headers['set-cookie'] || [], body: d }));
    });
    r.on('error', e => reject(e));
    r.write(data); r.end();
  });
}

/** 用给定 cookie 调会议列表 API 验证登录态是否有效 */
function verifyLogin(cookie, accountCorpId) {
  const url = `https://meeting.tencent.com/wemeet-tapi/wemeet/manage_service/personal/v1/query_personal_meeting_list?${buildQuery(accountCorpId)}`;
  const body = {
    meetingCode: '', subject: '', begin_time: Math.floor(Date.now() / 1000) - 30 * 86400,
    end_time: Math.floor(Date.now() / 1000), page_index: 1, page_size: 5,
    binary_meeting_type: 0, meeting_state: 1, sort: 1, time_zone: 'Asia/Shanghai',
  };
  return new Promise((resolve) => {
    post(url, body, cookie).then(r => {
      try { const j = JSON.parse(r.body); resolve(j.code === 0 ? `OK（会议列表 ${(j.meeting_list || []).length} 场）` : 'code=' + j.code); }
      catch { resolve('非JSON响应'); }
    }).catch(e => resolve('网络错误: ' + e.message.slice(0, 60)));
  });
}

/**
 * 刷新登录态（纯 HTTP）。
 * @param {string} authPath auth_state.json 路径
 * @returns {Promise<{refreshed: boolean, token_expire?: string, reason?: string}>}
 */
async function refreshToken(authPath) {
  const { state, cookie, accountCorpId } = loadAuth(authPath);
  const oldToken = (state.cookies.find(c => c.name === 'we_meet_token') || {}).value || '';

  // 1. 调用刷新接口
  let r;
  try {
    r = await post('https://meeting.tencent.com/wemeet-tapi/v2/account/login/refresh-token?' + buildQuery(accountCorpId), { refresh_token: 1 }, cookie);
  } catch (e) {
    return { refreshed: false, reason: '网络错误: ' + e.message.slice(0, 80) };
  }
  let j = null;
  try { j = JSON.parse(r.body); } catch { }
  if (!j || j.code !== 0) {
    return { refreshed: false, reason: '刷新接口返回: ' + (j ? 'code=' + j.code : r.body.slice(0, 120)) };
  }

  // 2. 从 Set-Cookie 提取新值
  const updates = {}; // name -> {value, expires}
  for (const sc of r.setCookie) {
    const m = sc.match(/^\s*([^=]+)=([^;]*)/);
    if (!m) continue;
    const name = m[1].trim();
    let value = m[2];
    try { value = decodeURIComponent(value); } catch { }
    if (!value || value === '""') continue;
    let expires = null;
    const em = sc.match(/[Ee]xpires=([^;]+)/);
    if (em) expires = Math.floor(new Date(em[1].trim()).getTime() / 1000);
    updates[name] = { value, expires };
  }
  const newTok = updates.we_meet_token && updates.we_meet_token.value;
  if (!newTok || newTok === oldToken) {
    // 没有下发新 token：可能会话仍有效但未到刷新时机，或已失效
    return { refreshed: false, reason: '服务器未下发新 token' };
  }

  // 3. 应用更新（先备份）
  const backup = authPath + '.pre_refresh_bak';
  try { fs.copyFileSync(authPath, backup); } catch { }
  for (const c of state.cookies) {
    if (updates[c.name]) {
      c.value = updates[c.name].value;
      if (updates[c.name].expires) c.expires = updates[c.name].expires;
    }
  }
  // Set-Cookie 里出现的新 cookie 补进 state
  for (const [name, v] of Object.entries(updates)) {
    if (!state.cookies.some(c => c.name === name)) {
      state.cookies.push({ name, value: v.value, ...(v.expires ? { expires: v.expires } : {}) });
    }
  }

  // 4. 验证新 token，失败回滚
  const newCookie = state.cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const verify = await verifyLogin(newCookie, accountCorpId);
  if (!verify.startsWith('OK')) {
    try { fs.copyFileSync(backup, authPath); } catch { }
    return { refreshed: false, reason: '新 token 验证失败（' + verify + '），已回滚' };
  }

  // 5. 写入
  fs.writeFileSync(authPath, JSON.stringify(state, null, 1), 'utf8');
  const exp = updates.token_expire_time ? Number(updates.token_expire_time.value) : (state.cookies.find(c => c.name === 'we_meet_token') || {}).expires;
  return {
    refreshed: true,
    token_expire: exp ? new Date(exp * 1000).toISOString() : null,
    verify,
  };
}

/** token 剩余天数（<0 表示已过期） */
function tokenRemainingDays(authPath) {
  try {
    const state = JSON.parse(fs.readFileSync(authPath, 'utf8'));
    const w = state.cookies.find(c => c.name === 'we_meet_token');
    if (!w || !w.expires) return 999;
    return (w.expires * 1000 - Date.now()) / 86400000;
  } catch { return 999; }
}

module.exports = { refreshToken, verifyLogin, tokenRemainingDays };
