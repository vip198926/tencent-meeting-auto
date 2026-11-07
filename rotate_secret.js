'use strict';
const { safeErr } = require('./log_safe');
/**
 * rotate_secret.js — 通用 GitHub Repo Secret 写入器（登录态自动轮换 + 一次性初始化）
 *
 * 用途 1（自动轮换，workflow 内）：
 *   GITHUB_PAT=${{ secrets.SECRETS_WRITE_PAT }} \
 *   SECRET_NAME=CTM_AUTH_STATE_RAW \
 *   AUTH_SRC=$RUNNER_TEMP/auth_state.json \
 *   node rotate_secret.js
 *   → 把「运行时刷新后的登录态」加密写回 Repo Secret CTM_AUTH_STATE_RAW，
 *     实现「每次跑完自动续期并落盘」，破解 7 天必过期问题。
 *
 * 用途 2（一次性初始化，本地）：把某个值写入指定 Secret（例如把 PAT 自身写进 SECRETS_WRITE_PAT）。
 *
 * 安全约束：
 *   - 只「写入」、绝不「读取」Secret 明文；依赖 tweetsodium（libsodium sealedbox，GitHub 官方格式）。
 *   - 所有明文仅经本地/runner 内存与 $RUNNER_TEMP，绝不进仓库或日志（日志仅打印长度与状态）。
 */
const fs = require('fs');
const https = require('https');
const path = require('path');
const { seal } = require('tweetsodium');

// Actions 里自带 GITHUB_REPOSITORY（owner/repo），Fork 后自动指向自己的仓库；
// 本地无该变量时回退到作者默认值，行为与之前完全一致。
const [OWNER, REPO] = (process.env.GITHUB_REPOSITORY || 'vip198926/tencent-meeting-auto').split('/');
// 支持从文件读取 PAT（GITHUB_PAT_FILE），避免把明文写进命令行/进程参数。
const PAT = process.env.GITHUB_PAT
  || (process.env.GITHUB_PAT_FILE && fs.existsSync(process.env.GITHUB_PAT_FILE)
    ? fs.readFileSync(process.env.GITHUB_PAT_FILE, 'utf8').trim() : '');
const SECRET_NAME = process.env.SECRET_NAME || 'CTM_AUTH_STATE_RAW';
const AUTH_SRC = process.env.AUTH_SRC || path.join(__dirname, 'auth_state.json');

if (!PAT) { console.error('❌ 缺少 GITHUB_PAT / GITHUB_PAT_FILE（写入 Secret 所需的 PAT）'); process.exit(1); }
if (!fs.existsSync(AUTH_SRC)) {
  console.log(`⚠️ 源文件不存在，跳过写入 ${SECRET_NAME}：${AUTH_SRC}`);
  process.exit(0);
}
const value = fs.readFileSync(AUTH_SRC, 'utf8');
if (!value.trim()) { console.log('⚠️ 源文件为空，跳过'); process.exit(0); }

function api(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path: urlPath, method,
      headers: {
        'Authorization': 'Bearer ' + PAT,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'ctm-rotate',
        'X-GitHub-Api-Version': '2022-11-28',
        ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}),
      },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve({ status: res.statusCode, body: d });
        else reject(new Error(`API ${method} ${urlPath} -> ${res.statusCode}: ${d.slice(0, 300)}`));
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

/** 估算 we_meet_token 剩余天数（仅日志，不影响写入） */
function remainingDaysOf(stateText) {
  try {
    const st = JSON.parse(stateText);
    const w = (st.cookies || []).find(c => c.name === 'we_meet_token');
    if (!w || !w.expires) return null;
    return ((w.expires * 1000 - Date.now()) / 86400000).toFixed(2);
  } catch { return null; }
}

(async () => {
  const pk = await api('GET', `/repos/${OWNER}/${REPO}/actions/secrets/public-key`);
  const { key_id, key } = JSON.parse(pk.body);
  const publicKey = Buffer.from(key, 'base64'); // 32 字节 X25519 公钥
  const sealed = seal(Buffer.from(value, 'utf8'), publicKey);
  const encrypted_value = Buffer.from(sealed).toString('base64');
  await api('PUT', `/repos/${OWNER}/${REPO}/actions/secrets/${SECRET_NAME}`, { encrypted_value, key_id });
  const days = remainingDaysOf(value);
  console.log(`✅ 已写回 Secret: ${SECRET_NAME}（明文长度 ${value.length}${days !== null ? `，token 剩余约 ${days} 天` : ''}）`);
})().catch(e => { console.error('❌ 写回 Secret 失败: ' + safeErr(e)); process.exit(1); });
