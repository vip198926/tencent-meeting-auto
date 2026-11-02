'use strict';
/**
 * set_secrets.js — 本地一次性工具：把 4 个凭证加密写入 GitHub Repo Secrets。
 * 用法：GITHUB_PAT=<你的PAT> node set_secrets.js
 * 依赖：tweetsodium（libsodium，GitHub 官方推荐）、已安装。不会把任何明文提交到仓库。
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const { seal } = require('tweetsodium');

// Actions 里自带 GITHUB_REPOSITORY（owner/repo），Fork 后自动指向自己的仓库；
// 本地无该变量时回退到作者默认值，行为与之前完全一致。
const [OWNER, REPO] = (process.env.GITHUB_REPOSITORY || 'vip198926/tencent-meeting-auto').split('/');
const PAT = process.env.GITHUB_PAT;
if (!PAT) { console.error('❌ 缺少环境变量 GITHUB_PAT（请传入你的 Personal Access Token）'); process.exit(1); }

const SRC = path.resolve(__dirname, '..', 'ctm-cloud');
const readJson = p => JSON.parse(fs.readFileSync(p, 'utf8'));

const secrets = {
  CTM_AUTH_STATE_RAW: fs.readFileSync(path.join(SRC, 'auth_state.json'), 'utf8'),
  IMA_CLIENT_ID: readJson(path.join(SRC, 'ima_creds.json')).client_id,
  IMA_API_KEY: readJson(path.join(SRC, 'ima_creds.json')).api_key,
  WECOM_WEBHOOK: readJson(path.join(SRC, 'wecom_webhook.json')).webhook,
};

function api(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = https.request({
      hostname: 'api.github.com',
      path: urlPath,
      method,
      headers: {
        'Authorization': 'Bearer ' + PAT,
        'Accept': 'application/vnd.github+json',
        'User-Agent': 'ctm-setup',
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

(async () => {
  const pk = await api('GET', `/repos/${OWNER}/${REPO}/actions/secrets/public-key`);
  const { key_id, key } = JSON.parse(pk.body);
  const publicKey = Buffer.from(key, 'base64'); // 32 字节 X25519 公钥

  for (const [name, value] of Object.entries(secrets)) {
    // tweetsodium.seal = libsodium crypto_box_seal（GitHub 要求的格式）
    const sealed = seal(Buffer.from(String(value), 'utf8'), publicKey);
    const encrypted_value = Buffer.from(sealed).toString('base64');
    await api('PUT', `/repos/${OWNER}/${REPO}/actions/secrets/${name}`, { encrypted_value, key_id });
    console.log(`✅ 已设置 Secret: ${name}（明文长度 ${String(value).length}）`);
  }
  console.log('🎉 全部 Secret 设置完成。该 PAT 仅用于此步，可立即在 GitHub 撤销。');
})().catch(e => { console.error('❌', e.message); process.exit(1); });
