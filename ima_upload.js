/**
 * ima_upload.js — 将 Markdown 正文上传到 IMA 知识库指定文件夹（纯 Node，无依赖）
 * 复刻 upload_ima_kb.js 的 IMA 上传逻辑，封装为可复用函数。
 *
 * 凭证来源优先级：IMA_CLIENT_ID/IMA_API_KEY 环境变量 -> 同目录 ima_creds.json -> ~/.config/ima/client_id|api_key
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const https = require('https');

const BASE_URL = 'https://ima.qq.com';
const API_BASE = '/openapi/wiki/v1';
const SKILL_VERSION = '1.1.10';

const DEFAULT_KB_ID = 'GHG8hApHL9UueCSPl-hD_Zus7IL-tPXgB2floa6eI70='; // DY知识库
const DEFAULT_FOLDER_ID = 'folder_7479402237546408';                  // 腾讯会议转写

function getCreds() {
  // 优先级：环境变量 -> 同目录 ima_creds.json（云端托管打包用）-> ~/.config/ima/*
  let cid = process.env.IMA_CLIENT_ID || '';
  let key = process.env.IMA_API_KEY || '';
  if (!cid || !key) {
    const local = safeRead(path.join(__dirname, 'ima_creds.json'));
    if (local) {
      try {
        const j = JSON.parse(local);
        cid = cid || (j.client_id || '');
        key = key || (j.api_key || '');
      } catch { /* 忽略损坏文件 */ }
    }
  }
  if (!cid || !key) {
    cid = cid || safeRead(path.join(os.homedir(), '.config/ima/client_id'));
    key = key || safeRead(path.join(os.homedir(), '.config/ima/api_key'));
  }
  if (!cid || !key) throw new Error('缺少 IMA 凭证（IMA_CLIENT_ID/IMA_API_KEY、ima_creds.json 或 ~/.config/ima/*）');
  return { cid: cid.trim(), key: key.trim() };
}
function safeRead(p) { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } }

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function callApi(method, body, attempt = 1) {
  const { cid, key } = getCreds();
  return new Promise((resolve, reject) => {
    const url = `${BASE_URL}${API_BASE}/${method}`;
    const data = JSON.stringify(body);
    const req = https.request(url, {
      method: 'POST',
      headers: {
        'ima-openapi-clientid': cid,
        'ima-openapi-apikey': key,
        'ima-openapi-ctx': `skill_version=${SKILL_VERSION}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
      },
    }, (res) => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => {
        let json;
        try { json = JSON.parse(buf); } catch (e) { json = { code: -1, msg: 'bad json: ' + buf.slice(0, 200) }; }
        if (json.code === 0) return resolve(json.data);
        if (json.code === 110021 || json.code === 110010) { // 频控/限流
          if (attempt < 5) return sleep(2000 * attempt).then(() => callApi(method, body, attempt + 1).then(resolve, reject));
        }
        reject(new Error(`[${method}] code=${json.code} msg=${json.msg}`));
      });
    });
    req.on('error', (e) => {
      if (attempt < 5) return sleep(2000 * attempt).then(() => callApi(method, body, attempt + 1).then(resolve, reject));
      reject(e);
    });
    req.write(data);
    req.end();
  });
}

// ---- COS 上传 ----
function hmacSha1(key, data) { return crypto.createHmac('sha1', key).update(data).digest('hex'); }
function sha1(data) { return crypto.createHash('sha1').update(data).digest('hex'); }
function buildAuthorization({ secretId, secretKey, method, pathname, headers, startTime, expiredTime }) {
  const keyTime = `${startTime};${expiredTime}`;
  const signKey = hmacSha1(secretKey, keyTime);
  const headerKeys = Object.keys(headers).sort();
  const httpHeaders = headerKeys.map(k => `${k.toLowerCase()}=${encodeURIComponent(headers[k])}`).join('&');
  const httpString = `${method.toLowerCase()}\n${pathname}\n\n${httpHeaders}\n`;
  const stringToSign = `sha1\n${keyTime}\n${sha1(httpString)}\n`;
  const signature = hmacSha1(signKey, stringToSign);
  const headerList = headerKeys.map(k => k.toLowerCase()).join(';');
  return [
    `q-sign-algorithm=sha1`, `q-ak=${secretId}`, `q-sign-time=${keyTime}`,
    `q-key-time=${keyTime}`, `q-header-list=${headerList}`, `q-url-param-list=`,
    `q-signature=${signature}`,
  ].join('&');
}
function cosUpload({ content, secretId, secretKey, token, bucket, region, cosKey, contentType, startTime, expiredTime }) {
  return new Promise((resolve, reject) => {
    const fileContent = Buffer.isBuffer(content) ? content : Buffer.from(content, 'utf8');
    const hostname = `${bucket}.cos.${region}.myqcloud.com`;
    const pathname = `/${cosKey}`;
    const signHeaders = { 'content-length': String(fileContent.length), host: hostname };
    const authorization = buildAuthorization({ secretId, secretKey, method: 'PUT', pathname, headers: signHeaders, startTime, expiredTime });
    const options = {
      hostname, port: 443, path: pathname, method: 'PUT',
      headers: {
        'Content-Type': contentType,
        'Content-Length': fileContent.length,
        Authorization: authorization,
        'x-cos-security-token': token,
      },
      timeout: 300000,
    };
    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', c => body += c);
      res.on('end', () => {
        if (res.statusCode >= 200 && res.statusCode < 300) resolve();
        else reject(new Error(`COS HTTP ${res.statusCode}: ${body.slice(0, 300)}`));
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('COS upload timeout')); });
    req.on('error', reject);
    req.write(fileContent);
    req.end();
  });
}

function ts() {
  const d = new Date(); const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 上传一段 Markdown 正文到 IMA 知识库文件夹。
 * @param {string} title 文件名/标题（不含 .md 也行，会自动处理）
 * @param {string} content Markdown 正文
 * @param {object} [opts] { kbId, folderId, skipDedup }
 * @returns {Promise<{title:string, media_id:string}>}
 */
async function uploadMarkdown(title, content, opts = {}) {
  const kbId = opts.kbId || DEFAULT_KB_ID;
  const folderId = opts.folderId || DEFAULT_FOLDER_ID;
  const mediaType = 7; // markdown
  const fileExt = 'md';
  const contentType = 'text/markdown';

  let fileName = title.endsWith('.md') ? title : `${title}.md`;
  let sendTitle = fileName;

  // 重名检查：冲突则追加时间戳避免覆盖
  if (!opts.skipDedup) {
    try {
      const cr = await callApi('check_repeated_names', {
        params: [{ name: fileName, media_type: mediaType }],
        knowledge_base_id: kbId, folder_id: folderId,
      });
      const r = (cr.results || [])[0];
      if (r && r.is_repeated) {
        const base = fileName.replace(/\.md$/i, '');
        sendTitle = `${base}_${ts()}.md`;
        fileName = sendTitle;
      }
    } catch (e) { /* 重名检查失败不阻断 */ }
  }

  const buf = Buffer.from(content, 'utf8');
  const size = buf.length;

  const cm = await callApi('create_media', {
    file_name: sendTitle, file_size: size, content_type: contentType,
    knowledge_base_id: kbId, file_ext: fileExt,
  });
  const mediaId = cm.media_id;
  const cred = cm.cos_credential;
  await cosUpload({
    content: buf, secretId: cred.secret_id, secretKey: cred.secret_key, token: cred.token,
    bucket: cred.bucket_name, region: cred.region, cosKey: cred.cos_key,
    contentType, startTime: cred.start_time, expiredTime: cred.expired_time,
  });
  await callApi('add_knowledge', {
    media_type: mediaType, media_id: mediaId, title: sendTitle,
    knowledge_base_id: kbId, folder_id: folderId,
    file_info: { cos_key: cred.cos_key, file_size: size, file_name: sendTitle },
  });
  return { title: sendTitle, media_id: mediaId };
}

module.exports = { uploadMarkdown, DEFAULT_KB_ID, DEFAULT_FOLDER_ID };
