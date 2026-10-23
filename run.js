/**
 * run.js — GitHub Actions 入口（替代云端 server.js）
 *
 * 设计：
 *   - 不写 HTTP 服务，纯命令行；由 workflow 用环境变量注入凭证。
 *   - CTM_AUTH_STATE 指向一个临时文件（由 workflow 从 Secret 写出到 $RUNNER_TEMP，仓库之外）。
 *   - 每次运行先纯 HTTP 续期登录态（延长 7 天），再跑增量/按天管线。
 *   - 状态文件（last_progress.json / processed_records.json）由 workflow 提交回仓库持久化。
 *   - 健壮性：无论成功/失败都写心跳日志 daily/run_log.jsonl（确保每次触发在 git 可见），
 *     失败时额外推送企业微信错误通知，杜绝「静默丢失」。
 *
 * 用法（workflow 调用）：
 *   node run.js inc                 # 增量：处理「上次截止 -> 现在」
 *   node run.js daily 2026-10-21    # 按天补跑
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { runIncremental, runDaily, bjDateString } = require('./daily_records');
const { refreshToken } = require('./token_refresh');

const AUTH_PATH = process.env.CTM_AUTH_STATE && process.env.CTM_AUTH_STATE.endsWith('.json')
  ? process.env.CTM_AUTH_STATE
  : path.join(__dirname, 'auth_state.json');

const OUT_DIR = path.join(__dirname, 'daily');
const RUN_LOG = path.join(OUT_DIR, 'run_log.jsonl');

/** 心跳日志：无论成功/失败都追加一行，确保每次触发在 git 可见（解决静默丢失盲区） */
function writeRunLog(entry) {
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.appendFileSync(RUN_LOG, JSON.stringify(entry) + '\n', 'utf8');
  } catch (e) {
    console.error('[RUN] 写心跳日志失败: ' + e.message);
  }
}

async function main() {
  const mode = process.argv[2] || 'inc';
  const dateArg = process.argv[3];

  // 0. 若以 RAW JSON 提供登录态，则写出到 AUTH_PATH（workflow 已指向 $RUNNER_TEMP）
  if (process.env.CTM_AUTH_STATE_RAW) {
    fs.writeFileSync(AUTH_PATH, process.env.CTM_AUTH_STATE_RAW, 'utf8');
    console.log('[RUN] 已从 Secret 写出登录态 -> ' + AUTH_PATH);
  } else if (!fs.existsSync(AUTH_PATH)) {
    throw new Error('缺少登录态：未提供 CTM_AUTH_STATE_RAW 且 ' + AUTH_PATH + ' 不存在');
  }

  // 1. 纯 HTTP 续期（延长约 7 天，无需浏览器）
  try {
    const r = await refreshToken(AUTH_PATH);
    if (r.refreshed) console.log(`[RUN] ✅ 登录态已续期至 ${r.token_expire}（${r.verify}）`);
    else console.log(`[RUN] ℹ️ 登录态未刷新：${r.reason}（将在后续接口调用中验证）`);
  } catch (e) {
    console.log('[RUN] ⚠️ 续期异常：' + e.message.slice(0, 200) + '（继续尝试，可能仍可用）');
  }

  // 2. 跑管线
  // source 标识调用方：patrol（巡检）/ daily（09:36 管线）/ 手动（缺省取 mode）
  const source = process.env.SOURCE || process.env.CTM_JOB_SOURCE || mode;
  const opts = { log: console.log, notify: true, source };
  let summary;
  if (mode === 'daily') {
    console.log('[RUN] 模式=按天，目标=' + (dateArg || '昨天') + '，来源=' + source);
    summary = await runDaily(dateArg, opts);
  } else {
    console.log('[RUN] 模式=增量，来源=' + source);
    summary = await runIncremental(opts);
  }
  return { mode, source, summary };
}

// 顶层包装：保证失败也发声、每次触发都留痕
(async () => {
  const startedAt = new Date().toISOString();
  let status = 'ok';
  let errMsg = null;
  let result = null;
  try {
    result = await main();
  } catch (e) {
    status = 'error';
    errMsg = (e && e.message) ? e.message.slice(0, 500) : String(e);
    console.error('[RUN] FATAL ' + errMsg);
  }

  // 心跳日志（成功/失败都写）
  writeRunLog({
    ts: startedAt,
    finished: new Date().toISOString(),
    mode: process.argv[2] || 'inc',
    source: process.env.SOURCE || 'unknown',
    status,
    error: errMsg,
    summary: result && result.summary ? {
      date: result.summary.date, meetings: result.summary.meetings,
      ok: result.summary.ok, fail: result.summary.fail,
      skipped: result.summary.skipped, noRecord: result.summary.noRecord,
    } : null,
  });

  // 失败时额外推送企业微信错误通知（成功通知已在管线内发送）
  if (status === 'error') {
    try {
      const { pushDailyReport: pushWecom } = require('./wecom_webhook');
      const r = await pushWecom({ source: process.env.SOURCE || 'inc', date: bjDateString(0), error: errMsg });
      console.log('[RUN] 已发送失败通知（wecom）: ' + JSON.stringify(r));
    } catch (e) {
      console.error('[RUN] 失败通知发送异常: ' + e.message);
    }
  }

  process.exit(status === 'error' ? 1 : 0);
})();
