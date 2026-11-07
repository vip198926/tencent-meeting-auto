/**
 * send_report.js — 统一推送日报（转写明细 + 收录结果合并为同一条企微消息）
 *
 * 由 daily.yml 在「收故事」之后以 if: always() 调用：
 *   主管线把 summary 暂存到 $RUNNER_TEMP/ctm_report.json（不立即推送），
 *   收故事把结果写到 $RUNNER_TEMP/story_result.json，
 *   本脚本合并两者后发一条消息，保证「转写」和「收录」一起到达、绝不静默。
 *
 * 公开仓库日志约束：只打印固定文案，绝不打印 summary / 结果文件内容（含会议标题）。
 */
'use strict';
const fs = require('fs');
const { pushDailyReport: pushWecom } = require('./wecom_webhook');
const { pushDailyReport: pushPushplus } = require('./pushplus');

const REPORT_FILE = process.env.CTM_REPORT_FILE || '';
const STORY_FILE = process.env.STORY_RESULT_FILE || '';

function readJson(p) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

(async () => {
  const summary = readJson(REPORT_FILE);
  if (!summary) {
    // 主管线异常时 run.js 已单独发过失败通知，这里不重复推送，避免刷屏。
    console.log('[REPORT] 未找到转写日报文件，跳过合并推送（失败通知已由 run.js 发出）');
    return;
  }
  const res = readJson(STORY_FILE);
  summary.story = res && res.line
    ? res.line
    : '📖 收故事：本轮未产生结果（步骤未执行或异常，请查看 Actions 日志）';
  console.log('[REPORT] 已合并转写与收录结果，准备推送');

  const channels = [['wecom', pushWecom], ['pushplus', pushPushplus]];
  for (const [name, fn] of channels) {
    try {
      const r = await fn(summary);
      if (r && r.ok) { console.log(`[REPORT] 合并日报已推送（${name}）`); return; }
    } catch (e) { /* 换下一个通道 */ }
  }
  console.log('[REPORT] 无可用推送通道，请检查 WECOM_WEBHOOK / PUSHPLUS_TOKEN');
})();
