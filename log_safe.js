/**
 * log_safe.js — 公开日志脱敏工具
 *
 * 本仓库公开，GitHub Actions 的日志任何人可见。凡是要 console.log 的内容，
 * 一律不得包含：会议主题/标题、会议号、record_id、参会人、逐字稿正文、
 * 接口响应体、URL 查询串（含 c_token / webhook key）等。
 *
 * 约定：
 *   - 标识类信息一律用 maskId() 换成稳定的 8 位哈希，便于跨轮次对账，但不可逆。
 *   - 错误一律用 safeErr() 转成「类别 + 错误码」，绝不透传原文。
 *   - 私有通道（企业微信日报、IMA 笔记、本地 records_*.md）不走这里，保持可读。
 */
'use strict';
const crypto = require('crypto');

/** 任意 ID -> 稳定短哈希（不泄露原值，同一 ID 每次相同） */
function maskId(v) {
  const s = String(v === undefined || v === null ? '' : v);
  if (!s) return '#-';
  return '#' + crypto.createHash('sha256').update(s).digest('hex').slice(0, 8);
}

const RULES = [
  [/登录|login|auth|10100001|请先登录|重新登录/i, '登录态异常'],
  [/timeout|超时|ETIMEDOUT|ESOCKETTIMEDOUT/i, '请求超时'],
  [/ENOTFOUND|ECONN|socket|网络错误|网络异常/i, '网络错误'],
  [/minutes|detail|抓取|转写|transcript|fetch/i, '转写抓取失败'],
  [/会议列表|meeting.?list/i, '会议列表失败'],
  [/JSON|解析|parse|非 JSON/i, '响应解析失败'],
  [/凭证|缺少|missing|未配置/i, '凭证缺失'],
  [/无权限|权限不足|forbidden|220030/i, '权限不足'],
  [/限流|rate.?limit|429/i, '接口限流'],
  [/未找到|不存在|not.?found|404/i, '资源不存在'],
  [/上传|upload|COS/i, '上传失败'],
  [/推送|通知|wecom|pushplus/i, '推送失败'],
];

/**
 * Error / 字符串 -> 只含类别与错误码的安全摘要。
 * 绝不返回原始 message（可能夹带响应体、URL、正文）。
 */
function safeErr(e) {
  const s = String((e && e.message) || e || '').replace(/\s+/g, ' ');
  if (!s) return '未知错误';
  const out = [];
  for (const [re, label] of RULES) {
    if (re.test(s) && !out.includes(label)) out.push(label);
  }
  // 只收带标签的错误码 / HTTP 状态，不收裸数字（可能是正文里的号码、ID）
  const codes = s.match(/(?:code|errcode|errno|status|http)\s*[:=]?\s*-?\d{1,12}/gi) || [];
  for (const c of codes) {
    const norm = c.replace(/\s+/g, '').toLowerCase();
    if (!out.includes(norm)) out.push(norm);
    if (out.length >= 6) break;
  }
  return out.length ? out.slice(0, 6).join(' ') : '未知错误';
}

module.exports = { maskId, safeErr };
