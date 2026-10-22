/**
 * wecom_webhook.js — 企业微信机器人 Webhook 推送
 *
 * 配置方式（任一）：
 *   1. 环境变量 WECOM_WEBHOOK = https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxx
 *   2. 本目录 wecom_webhook.json：{ "webhook": "https://qyapi.weixin.qq.com/..." }
 *
 * 说明：机器人 key 等同于「向该群发消息」的权限，请勿外泄；泄露后可企业微信群设置里轮换。
 * 企业微信 text 消息上限 2048 字节，超长自动截断；markdown 在部分客户端不显示，默认用 text。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const https = require('https');

const CFG_FILE = path.join(__dirname, 'wecom_webhook.json');

function getWebhook() {
  return process.env.WECOM_WEBHOOK || (() => {
    try { return (JSON.parse(fs.readFileSync(CFG_FILE, 'utf8')).webhook || '').trim(); } catch { return ''; }
  })();
}

function post(urlStr, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const data = JSON.stringify(body);
    const r = https.request({
      hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, res => {
      let d = ''; res.on('data', c => d += c);
      res.on('end', () => resolve({ status: res.statusCode, body: d }));
    });
    r.on('error', e => reject(e));
    r.write(data); r.end();
  });
}

/**
 * 发送文本消息（企业微信机器人）。
 * 未配置 webhook 时静默跳过。
 */
async function sendText(content) {
  const webhook = getWebhook();
  if (!webhook) return { skipped: true, reason: '未配置企业微信 webhook' };
  let text = String(content);
  if (Buffer.byteLength(text) > 2000) text = text.slice(0, 1900) + '\n…（过长已截断）';
  const r = await post(webhook, { msgtype: 'text', text: { content: text } });
  let j = null;
  try { j = JSON.parse(r.body); } catch { }
  if (j && j.errcode === 0) return { ok: true };
  throw new Error('企业微信返回: ' + (r.body || '').slice(0, 200));
}

/** 每日管线 / 巡检 推送（纯文本，规避 markdown 兼容问题）
 *  source === 'patrol' 时渲染为「巡检简报」，并附登录态剩余天数 + 积压/超时预警；
 *  其余情况渲染为「日报」。两者标题与字段明显区分。
 */
async function pushDailyReport(summary) {
  const { date, meetings, ok, fail, skipped, noRecord, error, lines, source, token_remaining_days, stale_hours } = summary;
  const isPatrol = source === 'patrol';
  let content;
  if (error) {
    content = `⚠️ 会议转写 ${date} 执行失败\n错误：${error}\n请检查登录态：本机运行 sync_auth.bat 刷新同步。`;
  } else {
    const head = (isPatrol ? `🔍 会议转写巡检简报 ${date}` : `📋 会议转写日报 ${date}`)
      + `\n共 ${meetings} 场会\n✅ 成功上传：${ok} 条\n❌ 失败：${fail} 条\n⏭️ 已上传跳过：${skipped} 条\n⬜ 无录制/转写：${noRecord} 场`;
    const extra = [];
    if (typeof token_remaining_days === 'number') extra.push(`🔑 登录态剩余约 ${token_remaining_days} 天`);
    if (isPatrol) {
      if (typeof stale_hours === 'number') extra.push(`⏱️ 距上次处理 ${stale_hours} 小时`);
      const alerts = [];
      if (typeof token_remaining_days === 'number' && token_remaining_days < 2) alerts.push('登录态即将失效(<2天)，请尽快 sync_auth.bat 续期');
      if (typeof stale_hours === 'number' && stale_hours > 26) alerts.push(`距上次处理已达 ${stale_hours}h，疑似漏跑/积压`);
      if (alerts.length) extra.push(`⚠️ 预警：${alerts.join('；')}`);
    }
    // 明细取前 12 行，避免超长
    const detail = (lines || []).filter(Boolean).slice(0, 12).map(l => l.replace(/^\|\s*/, '').replace(/\s*\|\s*$/, ''));
    content = head
      + (extra.length ? '\n' + extra.join('\n') : '')
      + (detail.length ? `\n\n—— 明细 ——\n${detail.join('\n')}` : '');
  }
  return sendText(content);
}

module.exports = { sendText, pushDailyReport, getWebhook };
