/**
 * story_lib.js — 收故事的 IMA / 飞书 / HTTP 公共层（纯 Node，无第三方依赖）
 *
 * 隐私约定（本仓库 public，Actions 运行日志任何人可见）：
 *   - 任何错误都不带响应体、不带正文、不带 token。
 *   - 只抛固定文案 + 数字错误码，便于排障而不泄露会议内容。
 */
'use strict';

const https = require('https');

/** 通用 JSON 请求。响应体永不外抛。 */
function httpJson(method, url, headers, body, timeoutMs = 90000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const data = body === undefined ? null : Buffer.from(JSON.stringify(body), 'utf8');
    const h = Object.assign({}, headers);
    if (data) {
      h['Content-Type'] = 'application/json; charset=utf-8';
      h['Content-Length'] = data.length;
    }
    const req = https.request({
      hostname: u.hostname, port: 443,
      path: u.pathname + u.search, method, headers: h, timeout: timeoutMs,
    }, (res) => {
      let buf = '';
      res.on('data', c => { if (buf.length < 3000000) buf += c; });
      res.on('end', () => {
        let json;
        try { json = JSON.parse(buf); } catch { return reject(new Error(`HTTP ${res.statusCode} 非 JSON 响应`)); }
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', e => reject(new Error('网络错误 ' + (e.code || 'unknown'))));
    if (data) req.write(data);
    req.end();
  });
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- IMA OpenAPI ----
const IMA_BASE = 'https://ima.qq.com';

function imaHeaders() {
  const cid = process.env.IMA_CLIENT_ID;
  const key = process.env.IMA_API_KEY;
  if (!cid || !key) throw new Error('缺少 IMA 凭证');
  return {
    'ima-openapi-clientid': cid,
    'ima-openapi-apikey': key,
    'ima-openapi-ctx': 'skill_version=1.1.10',
  };
}

async function imaPost(pathname, body) {
  const { status, json } = await httpJson('POST', IMA_BASE + pathname, imaHeaders(), body);
  if (status !== 200 || json.code !== 0) {
    throw new Error(`IMA code=${json.code === undefined ? status : json.code}`);
  }
  return json.data || {};
}

/** 打标签。技能规定不能传 item_name / kb_name，否则录音会报「文件名称不匹配」。 */
async function addTag(mediaId, tagName, kbId) {
  if (!mediaId) throw new Error('缺少 media_id');
  return imaPost('/openapi/wiki/v1/tag_add', {
    knowledge_base_id: kbId,
    item_id: mediaId,
    tag_name: tagName,
  });
}

/** 追加索引笔记。调用方保证 content 不含人名/原话/正文。 */
async function appendNote(noteId, content) {
  return imaPost('/openapi/note/v1/append_doc', {
    note_id: noteId, content_format: 1, content,
  });
}

// ---- 飞书 OpenAPI ----
const FEISHU_BASE = 'https://open.feishu.cn/open-apis';

async function feishuToken() {
  const appId = process.env.FEISHU_APP_ID;
  const secret = process.env.FEISHU_APP_SECRET;
  if (!appId || !secret) throw new Error('缺少飞书凭证');
  const { json } = await httpJson('POST', FEISHU_BASE + '/auth/v3/tenant_access_token/internal', {}, {
    app_id: appId, app_secret: secret,
  });
  if (json.code !== 0 || !json.tenant_access_token) throw new Error(`飞书 token code=${json.code}`);
  return json.tenant_access_token;
}

const textBlock = content => ({ block_type: 2, text: { elements: [{ text_run: { content } }] } });
const h2 = content => ({ block_type: 4, heading2: { elements: [{ text_run: { content } }] } });
const h3 = content => ({ block_type: 5, heading3: { elements: [{ text_run: { content } }] } });

/**
 * 追加块到文档末尾（index:-1）。绝不 overwrite。返回新 block_id 列表用于回滚定位。
 * clientToken 用于幂等：同一批内容重试时飞书不会重复插入（避免半完成状态导致重复写入）。
 */
async function appendBlocks(docId, token, children, clientToken) {
  const id = encodeURIComponent(docId);
  let url = `${FEISHU_BASE}/docx/v1/documents/${id}/blocks/${id}/children?document_revision_id=-1`;
  if (clientToken) url += `&client_token=${encodeURIComponent(clientToken)}`;
  const { status, json } = await httpJson('POST', url, { Authorization: 'Bearer ' + token }, {
    children, index: -1,
  });
  if (json.code !== 0) throw new Error(`飞书追加 code=${json.code} http=${status}`);
  return ((json.data || {}).children || []).map(b => b.block_id).filter(Boolean);
}

/** 飞书限流：单文档每秒最多 3 次编辑。分批追加，每批 <= 8 块。tokenFn(batchIdx) 生成确定性幂等键。 */
async function appendInBatches(docId, token, blocks, tokenFn = null) {
  const ids = [];
  let batch = 0;
  for (let i = 0; i < blocks.length; i += 8) {
    const ct = tokenFn ? tokenFn(batch++) : undefined;
    ids.push(...await appendBlocks(docId, token, blocks.slice(i, i + 8), ct));
    if (i + 8 < blocks.length) await sleep(450);
  }
  return ids;
}

function bjDate() {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10);
}

module.exports = {
  httpJson, sleep, imaPost, addTag, appendNote,
  feishuToken, textBlock, h2, h3, appendBlocks, appendInBatches, bjDate,
};
