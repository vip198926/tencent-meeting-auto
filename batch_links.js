/**
 * batch_links.js — 按指定会议链接抓取转写并上传 IMA（GitHub Actions 单链接入口）
 *
 * 与 run.js 的 inc/daily（按时间窗口拉列表）互补：
 *   node batch_links.js            # 从环境变量 CTM_LINKS 读链接，一行/逗号分隔
 *   CTM_LINKS='url1,url2' node batch_links.js
 *
 * 约定（与仓库公开日志规则一致）：
 *   - 日志只打固定文案、数字、maskId 摘要；链接/主题/会议号/正文一律不打印。
 *   - IMA 笔记与企微日报在内部通道，标题保持完整可读。
 *   - 逐条容错：某条失败不中断其余；结果写 CTM_REPORT_FILE 供 send_report.js 合并推送。
 *   - 不写 daily/ 状态文件、不做按天去重，不干扰 inc/daily 管线。
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { fetchTranscript, normalizeInput } = require('./ctm_fetch');
const { uploadMarkdown } = require('./ima_upload');
const { maskId, safeErr } = require('./log_safe');

const AUTH_PATH = process.env.CTM_AUTH_STATE && process.env.CTM_AUTH_STATE.endsWith('.json')
  ? process.env.CTM_AUTH_STATE
  : path.join(__dirname, 'auth_state.json');

function sanitize(s) { return String(s || '').replace(/[\\/:*?"<>|]/g, '').replace(/\s+/g, ' ').trim().slice(0, 60); }

/** 从环境变量取链接；支持换行、逗号、空格分隔（URL 内无空格）。 */
function parseLinks(raw) {
  return String(raw || '').split(/[\r\n,]+/).map(s => s.trim()).filter(Boolean);
}

/** 标题：优先会议主题（内部笔记可读），兜底用短码。 */
function deriveTitle(input, meta) {
  const { code } = normalizeInput(input);
  const tag = code || (meta.uuid ? meta.uuid.slice(0, 8) : 'unknown');
  return sanitize(meta.subject) || `腾讯会议转写_${tag}`;
}

/** 时间列：meta.startTime 是毫秒时间戳；无效则留空，不猜。 */
function fmtTime(ms) {
  const n = Number(ms);
  if (!n || !Number.isFinite(n)) return '';
  const d = new Date(n);
  if (isNaN(d.getTime())) return '';
  const p = x => String(x).padStart(2, '0');
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function writeReport(stats) {
  const p = process.env.CTM_REPORT_FILE;
  if (!p) return;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(stats), 'utf8');
  } catch (e) {
    console.log('[LINK] ⚠️ 日报交接文件写入失败：' + safeErr(e));
  }
}

/** 逐条交接给收故事步骤（与 daily_records.emitStoryBatch 同结构，位于 runner 临时目录）。 */
function emitStoryBatch(entry) {
  const p = process.env.STORY_BATCH_FILE;
  if (!p) return;
  try { fs.appendFileSync(p, JSON.stringify(entry) + '\n', 'utf8'); } catch { /* 忽略 */ }
}

async function main() {
  const links = parseLinks(process.env.CTM_LINKS);
  if (!links.length) {
    console.log('[LINK] 未提供链接（CTM_LINKS 为空），跳过。');
    writeReport({ source: 'link', date: '', meetings: 0, ok: 0, fail: 0, skipped: 0, noRecord: 0, lines: [] });
    return;
  }
  console.log(`[LINK] 收到 ${links.length} 条链接`);

  const stats = {
    source: 'link', date: new Date().toISOString().slice(0, 10),
    meetings: links.length, ok: 0, fail: 0, skipped: 0, noRecord: 0, lines: [],
  };

  for (let i = 0; i < links.length; i++) {
    const input = links[i];
    const t0 = Date.now();
    try {
      const r = await fetchTranscript(input, { authPath: AUTH_PATH });
      if (!r.paragraphs.length) {
        stats.noRecord++;
        console.log(`[${i + 1}/${links.length}] ⬜ 无转写内容 链接 ${maskId(input)}`);
        continue;
      }
      const title = deriveTitle(input, r.meta);
      const up = await uploadMarkdown(title, r.text);
      stats.ok++;
      emitStoryBatch({ media_id: up.media_id, record_id: r.meta.recording_id || r.meta.uuid || '', text: r.text });
      const secs = ((Date.now() - t0) / 1000).toFixed(1);
      console.log(`[${i + 1}/${links.length}] ✅ 已上传 链接 ${maskId(input)}（${r.paragraphs.length} 段｜${secs}s）`);
      // lines 进内部企微日报，保留标题；不进公开日志
      stats.lines.push(`| ${fmtTime(r.meta.startTime)} | ${title} | 指定链接 | ✅ ${r.paragraphs.length} 段 |`);
    } catch (e) {
      stats.fail++;
      console.log(`[${i + 1}/${links.length}] ❌ 失败 链接 ${maskId(input)} — ${safeErr(e)}`);
      stats.lines.push(`| | （已脱敏） | 指定链接 | ❌ ${safeErr(e)} |`);
    }
    writeReport(stats); // 实时落盘：中断也能看到已处理进度
    if (i < links.length - 1) await new Promise(res => setTimeout(res, 700));
  }
  console.log(`[LINK] 完成：成功 ${stats.ok} / 失败 ${stats.fail} / 无内容 ${stats.noRecord} / 共 ${links.length}`);
}

if (require.main === module) {
  main().catch(e => { console.log('[LINK] 致命错误：' + safeErr(e)); process.exitCode = 1; });
}

module.exports = { parseLinks, deriveTitle, fmtTime };
