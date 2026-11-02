/**
 * login_auth.js — 可见窗口扫码登录 → 导出 auth_state.json
 *
 * 用途：本地登录态彻底失效（refresh-token 返回 -51003）时，人工扫码重新登录。
 * 流程：备份 → 打开可见 Edge → 用户扫码 → 轮询检测 we_meet_token → 验证 → 写入 auth_state.json
 * 不破坏原文件：仅在验证通过后才覆盖；否则保留原文件。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');
const { verifyLogin } = require('./token_refresh');

(async () => {
  const authPath = path.join(__dirname, 'auth_state.json');
  const bak = authPath + '.before_login';
  try { fs.copyFileSync(authPath, bak); console.log('[bak] 已备份原文件 →', path.basename(bak)); }
  catch (e) { console.log('[bak] 备份跳过:', e.message); }

  console.log('启动可见 Edge 窗口…');
  const browser = await chromium.launch({ channel: 'msedge', headless: false, args: ['--start-maximized'] });
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  let closed = false;
  browser.on('disconnected', () => { closed = true; console.log('浏览器已关闭'); });

  try {
    await page.goto('https://meeting.tencent.com/user-center/user-meeting-list/ended', {
      waitUntil: 'domcontentloaded', timeout: 60000,
    });
  } catch (e) { console.log('[goto]', e.message.slice(0, 100)); }

  console.log('>>> 请在弹出的 Edge 窗口中扫码登录腾讯会议（最长等 5 分钟）…');
  let ok = false;
  for (let i = 0; i < 100; i++) {
    if (closed) break;
    await new Promise(r => setTimeout(r, 3000));
    try {
      const cookies = await ctx.cookies();
      const w = cookies.find(c => c.name === 'we_meet_token' && c.expires && c.expires * 1000 > Date.now());
      if (w) { ok = true; break; }
    } catch (e) {
      if (!browser.isConnected()) { closed = true; break; }
    }
    if (i % 5 === 0 && i > 0) console.log(`…等待登录 ${i * 3}s`);
  }

  if (!ok) {
    console.log('⚠️ 未检测到有效登录（超时或窗口关闭），保留原 auth_state.json');
    try { await browser.close(); } catch { }
    process.exit(0);
  }

  const state = await ctx.storageState();
  const cookieStr = state.cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const corp = (state.cookies.find(c => c.name === 'account_corp_id') || {}).value || '';
  const v = await verifyLogin(cookieStr, corp);
  console.log('API 验证:', v);

  if (v.startsWith('OK')) {
    fs.writeFileSync(authPath, JSON.stringify(state, null, 1));
    const w = state.cookies.find(c => c.name === 'we_meet_token');
    console.log('✅ 已保存 auth_state.json | we_meet_token 过期:', new Date(w.expires * 1000).toLocaleString('zh-CN'));
    console.log('DONE_OK');
  } else {
    console.log('⚠️ 新状态验证失败，保留原文件');
  }
  try { await browser.close(); } catch { }
})().catch(e => { console.error('FATAL', e.message); process.exit(1); });
