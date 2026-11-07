/**
 * pushplus.js — PushPlus 微信推送（www.pushplus.plus）
 *
 * Token 获取方式（用户侧）：
 *   1. 微信扫码登录 https://www.pushplus.plus
 *   2. 首页「您的 token」一栏复制（形如 32 位十六进制）
 *   3. 写入本目录 pushplus.json：{"token":"xxx"}（或设环境变量 PUSHPLUS_TOKEN）
 *
 * 用法：
 *   const { send, pushDailyReport } = require('./pushplus');
 *   await send('标题', '正文（支持 markdown）');
 *   await pushDailyReport({ date, meetings, ok, fail, skipped, noRecord, md });
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const TOKEN_FILE = path.join(__dirname, 'pushplus.json');

function getToken() {
  if (process.env.PUSHPLUS_TOKEN) return process.env.PUSHPLUS_TOKEN.trim();
  try {
    const j = JSON.parse(fs.readFileSync(TOKEN_FILE, 'utf8'));
    return (j.token || '').trim();
  } catch { return ''; }
}

function post(hostname, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = new URLSearchParams(body).toString();
    const r = https.request({
      hostname, path: urlPath, method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(data), 'User-Agent': 'ctm-cloud/1.0' },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(d) }); }
        catch { resolve({ status: res.statusCode, raw: d }); }
      });
    });
    r.on('error', e => reject(e));
    r.write(data); r.end();
  });
}

/**
 * 发送一条推送。template: 'markdown' | 'html' | 'txt'
 * 未配置 token 时静默跳过（返回 {skipped:true}），不影响主流程。
 */
async function send(title, content, template = 'markdown') {
  const token = getToken();
  if (!token) return { skipped: true, reason: '未配置 PushPlus token' };
  const r = await post('www.pushplus.plus', '/send', { token, title: String(title).slice(0, 100), content: String(content).slice(0, 20000), template });
  if (r.json && r.json.code === 200) return { ok: true, msg: r.json.msg };
  throw new Error('PushPlus 返回: ' + JSON.stringify(r.json || r.raw || r.status).slice(0, 200));
}

/** 每日管线 / 巡检 推送摘要
 *  source === 'patrol' 时标题为「巡检简报」并附登录态剩余天数 + 积压/超时预警。
 */
async function pushDailyReport(summary) {
  const { date, meetings, ok, fail, skipped, noRecord, error, md, source, token_remaining_days, stale_hours } = summary;
  const isPatrol = source === 'patrol';
  const title = error
    ? `⚠️ 会议转写${isPatrol ? '巡检' : '日报'} ${date} 执行异常`
    : `${isPatrol ? '🔍 会议转写巡检简报' : '📋 会议转写日报'} ${date}（${meetings} 场会）`;
  let content;
  if (error) {
    content = `## 执行失败\n\n错误：${error}\n\n请检查腾讯会议登录态（在本机运行 sync_auth.bat 刷新同步）。`;
  } else {
    const head = `**${date}** 共 ${meetings} 场会\n\n- ✅ 成功上传：${ok} 条\n- ❌ 失败：${fail} 条\n- ⏭️ 已上传跳过：${skipped} 条\n- ⬜ 无录制/转写：${noRecord} 场`;
    const extra = [];
    if (typeof token_remaining_days === 'number') extra.push(`- 🔑 登录态剩余约 ${token_remaining_days} 天`);
    if (isPatrol) {
      if (typeof stale_hours === 'number') extra.push(`- ⏱️ 距上次处理 ${stale_hours} 小时`);
      const alerts = [];
      if (typeof token_remaining_days === 'number' && token_remaining_days < 2) alerts.push('登录态即将失效(<2天)');
      if (typeof stale_hours === 'number' && stale_hours > 26) alerts.push(`距上次处理已达 ${stale_hours}h，疑似漏跑`);
      if (alerts.length) extra.push(`- ⚠️ 预警：${alerts.join('；')}`);
    }
    const detail = (md || '').split('| 时间 | 标题 | 类型 | 结果 |')[1];
    content = head
      + (extra.length ? '\n\n' + extra.join('\n') : '')
      + (summary.story ? `\n\n**${String(summary.story)}**` : '')
      + (detail ? `\n\n### 明细\n\n| 时间 | 标题 | 类型 | 结果 |${detail}` : '');
  }
  return send(title, content, 'markdown');
}

module.exports = { send, pushDailyReport, getToken };
