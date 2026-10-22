/**
 * run.js — GitHub Actions 入口（替代云端 server.js）
 *
 * 设计：
 *   - 不写 HTTP 服务，纯命令行；由 workflow 用环境变量注入凭证。
 *   - CTM_AUTH_STATE 指向一个临时文件（由 workflow 从 Secret 写出到 $RUNNER_TEMP，仓库之外）。
 *   - 每次运行先纯 HTTP 续期登录态（延长 7 天），再跑增量/按天管线。
 *   - 状态文件（last_progress.json / processed_records.json）由 workflow 提交回仓库持久化。
 *
 * 用法（workflow 调用）：
 *   node run.js inc                 # 增量：处理「上次截止 -> 现在」
 *   node run.js daily 2026-10-21    # 按天补跑
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { runIncremental, runDaily } = require('./daily_records');
const { refreshToken, tokenRemainingDays } = require('./token_refresh');

const AUTH_PATH = process.env.CTM_AUTH_STATE && process.env.CTM_AUTH_STATE.endsWith('.json')
  ? process.env.CTM_AUTH_STATE
  : path.join(__dirname, 'auth_state.json');

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
  const opts = { log: console.log, notify: true };
  let summary;
  if (mode === 'daily') {
    console.log('[RUN] 模式=按天，目标=' + (dateArg || '昨天'));
    summary = await runDaily(dateArg, opts);
  } else {
    console.log('[RUN] 模式=增量');
    summary = await runIncremental(opts);
  }

  // 3. 汇总（便于 Actions 日志审计；不打印任何凭证）
  const remain = (() => { try { return Math.round(tokenRemainingDays(AUTH_PATH) * 10) / 10; } catch { return null; } })();
  console.log('[RUN] 完成 ->', JSON.stringify({
    mode, date: summary.date, meetings: summary.meetings,
    ok: summary.ok, fail: summary.fail, skipped: summary.skipped, noRecord: summary.noRecord,
    token_remaining_days: remain,
  }));
}

main().catch(e => { console.error('[RUN] FATAL', e.message); process.exit(1); });
