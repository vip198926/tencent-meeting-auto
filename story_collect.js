/**
 * story_collect.js — 收故事（GitHub Actions 版）
 *
 * 接在每日管线 / 巡检之后运行，把本轮上传的逐字稿自动提取成故事，
 * 增量追加到两份飞书文档，再打 IMA 标签记账。凭证未配齐时静默跳过，不影响主管线。
 *
 * 隐私约定（public 仓库 + 公开的 Actions 日志）：
 *   - 逐字稿正文只在 $RUNNER_TEMP 的交接文件与进程内存里，绝不进仓库、日志、artifact。
 *   - 台账只存指纹 / media_id / record_id / block_id / 时间戳，不存人名、原话、会议主题。
 *   - 所有日志只打数量与错误码，企微简报不含人名与原话。
 *
 * 用法：
 *   node story_collect.js                       正常跑（由 daily.yml / patrol.yml 调用）
 *   node story_collect.js --selftest <file.md>  离线自检预筛，不联网、不写任何外部系统
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const lib = require('./story_lib');
const llm = require('./story_llm');
const layout = require('./story_layout');
const normalize = require('./story_normalize');
const { safeErr } = require('./log_safe');

const STATE_FILE = process.env.STORY_STATE_FILE || path.join(__dirname, 'daily', 'story_state.json');
const BATCH_FILE = process.env.STORY_BATCH_FILE || '';
const RESULT_FILE = process.env.STORY_RESULT_FILE || '';
// 缺 env 就降级为不打标签；公开仓库里绝不写死知识库 ID。
const KB_ID = process.env.IMA_KB_ID || process.env.STORY_KB_ID || '';
const TAG_DONE = '故事已收';
const TAG_NONE = '无故事';

// 缺这些就静默跳过：用户可能还在准备凭证，绝不能因此每天发告警、更不能拖红主管线。
const REQUIRED = [
  'LLM_API_KEY', 'FEISHU_APP_ID', 'FEISHU_APP_SECRET',
  'FEISHU_DOC_PEOPLE', 'FEISHU_DOC_EFFECT', 'STORY_NOTE_ID',
  'IMA_CLIENT_ID', 'IMA_API_KEY',
];
const missing = () => REQUIRED.filter(k => !process.env[k]);

function log(...a) { console.log('[STORY]', ...a); }

// ---- 台账 ----
function loadState() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (j && j.version === 1 && j.seen && Array.isArray(j.pending)) return j;
  } catch { /* 首次运行 */ }
  return { version: 1, updated: '', seen: {}, pending: [], writes: [] };
}

/** 台账每轮被自动提交进 public 仓库，git 历史不可撤回：写入前硬断言。 */
function assertSafeLedger(s) {
  const txt = JSON.stringify(s);
  if (/[\u4e00-\u9fa5]/.test(txt)) throw new Error('台账含中文，拒绝写入');
  for (const k of Object.keys(s.seen || {})) {
    if (!/^[a-f0-9]{7,}$/.test(k)) throw new Error('台账键格式异常，拒绝写入');
  }
}

function saveState(s) {
  assertSafeLedger(s);
  s.updated = new Date().toISOString();
  // 只保留最近 200 条写入记录，避免台账无限膨胀
  if (s.writes.length > 200) s.writes = s.writes.slice(-200);
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2), 'utf8');
  fs.renameSync(tmp, STATE_FILE);
}

// ---- 输入 ----
function loadBatch() {
  if (!BATCH_FILE || !fs.existsSync(BATCH_FILE)) return [];
  return fs.readFileSync(BATCH_FILE, 'utf8').split('\n')
    .filter(Boolean)
    .map(line => { try { return JSON.parse(line); } catch { return null; } })
    .filter(x => x && typeof x.text === 'string' && x.text.length > 200);
}

/** 失败项下一轮按 record_id 重抓：正文不落盘，避免隐私数据持久化。 */
async function recoverPending(state) {
  const out = [], stillFailed = [];
  if (!state.pending.length) return { out, stillFailed };
  let fetchTranscript;
  try { fetchTranscript = require('./ctm_fetch').fetchTranscript; } catch { return { out, stillFailed: [...state.pending] }; }
  const authPath = process.env.CTM_AUTH_STATE;
  if (!authPath || !fs.existsSync(authPath)) return { out, stillFailed: [...state.pending] };
  for (const p of state.pending) {
    try {
      const t = await fetchTranscript(p.record_id, { authPath });
      if (t && t.text) out.push({ record_id: p.record_id, media_id: p.media_id, text: t.text, recovered: true });
      else stillFailed.push(p);
      await lib.sleep(700);
    } catch { stillFailed.push(p); }
  }
  return { out, stillFailed };
}

/** 同一分钟的多份导出（转写版/原版）只留字数最多的一份，与技能判重规则一致。 */
function dedupeByMinute(items) {
  const best = new Map();
  const noMinute = [];
  for (const it of items) {
    const m = llm.transcriptMinute(it.text);
    if (!m) { noMinute.push(it); continue; }
    const cur = best.get(m);
    if (!cur || it.text.length > cur.text.length) best.set(m, it);
  }
  const kept = [...best.values(), ...noMinute];
  return { kept, dropped: items.length - kept.length };
}

// ---- 飞书块（只 insert / append，绝不 delete / overwrite 已有块）----
/**
 * 按写入规划生成块：
 *   - 新建章节 → 先放章节标题（人物篇 heading1、效果篇 heading2），内容追加到文档末尾
 *   - 插进已有章节 → 不带章节标题，内容插到该章节最后一个块之后
 *   - 未署名条目只放逐字命中的原话与时间戳，绝不写任何人名
 */
function blocksForPlan(date, plan) {
  const blocks = [];
  if (plan.isNew) blocks.push(plan.doc === 'people' ? lib.h1(plan.heading) : lib.h2(plan.heading));

  for (const p of plan.people) {
    blocks.push(lib.h2(`[${date}] ${p.person}`));
    p.sections.forEach(sec => {
      blocks.push(lib.h3(sec.title));
      sec.excerpts.forEach(ex => blocks.push(lib.textBlock(ex)));
    });
  }
  for (const e of plan.effects) {
    blocks.push(lib.textBlock(
      `[${date}] ${e.person}｜${e.problem}｜${e.duration}｜${e.result}\n原话：「${e.quote}」${e.stamp ? '（' + e.stamp + '）' : ''}`));
  }
  for (const u of plan.unattributed) {
    blocks.push(lib.textBlock(`[${date}]${u.stamp ? ' ' + u.stamp : ''} 原话：「${u.quote}」`));
  }
  return blocks;
}

function deterministicToken(fp, docId, batchIdx) {
  const h = crypto.createHash('md5').update(`${fp}|${docId}|${batchIdx}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// ---- 收录结果交接（供统一日报合并推送）----
/**
 * 只写固定文案 + 数字到日志；明细（含人名/概述）只进 $RUNNER_TEMP 交接文件，
 * 由 send_report.js 直推内部群，绝不进仓库、artifact 与 Actions 日志。
 */
function setResult(line, stats, details) {
  if (!RESULT_FILE) return;
  const list = (Array.isArray(details) ? details : []).filter(x => typeof x === 'string' && x);
  const MAX = 6;                       // 企微 text 上限 2048 字节，概述按条占位（6 条约 750 字节）
  const shown = list.slice(0, MAX);
  try {
    fs.writeFileSync(RESULT_FILE, JSON.stringify({
      line,
      stats: stats || {},
      details: shown,
      detailsMore: Math.max(0, list.length - shown.length),
      ts: new Date().toISOString(),
    }), 'utf8');
  } catch { /* 忽略：不影响收故事结果 */ }
}

// ---- 企微简报（只报数字，不含人名/原话/会议主题）----
async function notify(text) {
  // 合并日报模式：由 send_report.js 统一发一条，此处不再单独推送，避免重复消息
  if (RESULT_FILE) return;
  if (!process.env.WECOM_WEBHOOK) return;
  try {
    const { sendText } = require('./wecom_webhook');
    await sendText(text);
  } catch (e) { log('通知发送失败（不影响处理结果）'); }
}

async function selfTest(file) {
  const text = fs.readFileSync(file, 'utf8');
  const r = llm.preselect(text);
  log('selftest 正文字符:', r.body.length);
  log('selftest 段落块:', r.chunkCount, '| 选中块:', r.keptChunks, '| 四段分布:', (r.buckets || []).join('/'));
  log('selftest 送入模型字符:', r.picked.length, '| 压缩比:', (r.picked.length / Math.max(1, r.body.length) * 100).toFixed(0) + '%');
  log('selftest 指纹:', llm.fingerprint(text), '| 转写分钟:', llm.transcriptMinute(text) || '(无)');
  return 0;
}

async function main() {
  if (process.argv[2] === '--selftest') return selfTest(process.argv[3]);

  const lack = missing();
  if (lack.length) {
    log('未配置完整凭证（缺 ' + lack.length + ' 项），跳过收故事；主管线不受影响');
    setResult(`📖 收故事：未配置完整凭证（缺 ${lack.length} 项），已跳过`);
    return 0;
  }

  const state = loadState();
  const date = lib.bjDate();
  const batch = loadBatch();
  const { out: recovered, stillFailed } = await recoverPending(state);
  const items = [...batch, ...recovered];

  if (!items.length) {
    log('本轮无新增逐字稿，收录结果已记入日报');
    setResult('📖 收故事：本轮无新增逐字稿（0 份待处理）');
    return 0;
  }

  const { kept, dropped } = dedupeByMinute(items);
  const todo = kept.filter(it => !state.seen[llm.fingerprint(it.text)]);
  log('待处理', todo.length, '份 | 同分钟判掉', dropped, '份 | 指纹已收', kept.length - todo.length, '份 | 重试恢复', recovered.length, '份');

  if (!todo.length) {
    setResult(`📖 收故事：${kept.length} 份均为已收或同分钟重复，无新增`);
    return 0;
  }

  // ⓿ 自检：飞书 token + 两份文档可读。任一失败 → 不打标签，下轮重试。
  let token;
  try {
    token = await lib.feishuToken();
    for (const docId of [process.env.FEISHU_DOC_PEOPLE, process.env.FEISHU_DOC_EFFECT]) {
      const { json } = await lib.httpJson('GET',
        `https://open.feishu.cn/open-apis/docx/v1/documents/${encodeURIComponent(docId)}`,
        { Authorization: 'Bearer ' + token });
      if (json.code !== 0) throw new Error(`飞书文档自检 code=${json.code}`);
    }
  } catch (e) {
    log('自检失败：' + safeErr(e) + '；本轮不打标签，下轮自动重试');
    setResult(`📖 收故事：自检失败，本轮 ${todo.length} 份未处理，未打标签，下轮自动重试`);
    await notify(`收故事 · ${date}\n自检失败，本轮 ${todo.length} 份未处理，未打标签，下轮自动重试。`);
    return 0;
  }

  // ⓪.5 转写错误对照表：本轮有稿才读，整轮只读一次、进程内共用。
  // 读不到/格式异常一律降级为按原文标签判定，绝不阻断主管线。
  let norm = null;
  try {
    norm = await normalize.load();
    if (norm.ready) {
      const s = norm.stats;
      log(`对照表：人名映射 ${s.person} | 产品映射 ${s.product} | 严格名 ${s.strict} | 歧义弃用 ${s.ambiguous}`);
      llm.setProductAliases(norm.productAliases);
    } else {
      log('对照表未配置（缺 STORY_ASR_NOTE_ID），按原文标签判定');
    }
  } catch (e) {
    log('对照表读取失败，按原文标签判定：' + safeErr(e));
    norm = null;
  }

  const stats = { processed: 0, none: 0, effects: 0, people: 0, rejectedQuote: 0, rejectedOther: 0, newChapters: 0, renamed: 0, briefDrop: 0, failed: 0 };
  const productCount = {};
  const failedNow = [];
  const details = [];        // 只进内部群消息，不落仓库、不进日志

  /** 每份稿处理前重读布局：上一份稿的插入会让 index 漂移，且刚新建的章节要能被下一份命中。 */
  async function readLayouts() {
    const out = {};
    for (const [key, docId, types] of [
      ['people', process.env.FEISHU_DOC_PEOPLE, [3]],   // 人物篇按 heading1 分章
      ['effect', process.env.FEISHU_DOC_EFFECT, [4]],   // 效果篇按 heading2 分章
    ]) {
      const items = await lib.getDocumentBlocks(docId, token);
      const lay = lib.documentLayout(items);
      out[key] = { anchors: lib.sectionAnchors(lay, types), len: lay.children.length };
    }
    return out;
  }

  for (const it of todo) {
    const fp = llm.fingerprint(it.text);
    const rec = { record_id: it.record_id || '', media_id: it.media_id || '', fp, ts: new Date().toISOString() };
    try {
      const sel = llm.preselect(it.text);
      if (!sel.picked) {
        if (rec.media_id && KB_ID) await lib.addTag(rec.media_id, TAG_NONE, KB_ID);
        state.seen[fp] = { ts: rec.ts, stories: 0, media_id: rec.media_id };
        stats.none++;
        continue;
      }

      const parsed = await llm.extractStories(sel.picked);
      const v = llm.validate(parsed, sel.body, { norm });
      stats.rejectedQuote += v.rejected.quote;
      stats.rejectedOther += v.rejected.product + v.rejected.fields + v.rejected.duplicate;
      stats.renamed += v.renamed || 0;
      stats.briefDrop += v.rejected.brief || 0;

      const total = v.effects.length + v.people.length + v.unclaimed.length;
      if (!total) {                       // 一条可写内容都没有：不碰两份文档
        if (rec.media_id && KB_ID) await lib.addTag(rec.media_id, TAG_NONE, KB_ID);
        state.seen[fp] = { ts: rec.ts, stories: 0, media_id: rec.media_id };
        stats.none++;
        continue;
      }

      const lays = await readLayouts();
      const plans = layout.orderPlans(layout.planWrites({
        people: v.people, effects: v.effects, unclaimed: v.unclaimed,
        anchorsPeople: lays.people.anchors, anchorsEffect: lays.effect.anchors,
        lenPeople: lays.people.len, lenEffect: lays.effect.len,
      }));
      const writes = [];
      for (const plan of plans) {
        const blocks = blocksForPlan(date, plan);
        if (!blocks.length) continue;
        const docId = plan.doc === 'people' ? process.env.FEISHU_DOC_PEOPLE : process.env.FEISHU_DOC_EFFECT;
        // 每个规划组必须独立幂等键，否则飞书会把第二批当成同一次请求吞掉
        const key = `${plan.doc}|${plan.index}|${plan.chapter}`;
        const tokenFn = i => deterministicToken(fp, key, i);
        const ids = plan.mode === 'insert'
          ? await lib.insertInBatches(docId, token, blocks, plan.index, tokenFn)
          : await lib.appendInBatches(docId, token, blocks, tokenFn);
        writes.push({ doc: plan.doc, blocks: ids.length, fp });
        if (plan.isNew) stats.newChapters++;
      }

      // 飞书写入成功即视为主流程完成。IMA 笔记索引已移除（210005 作者限制），
      // 索引信息只存 story_state.json 的 writes 台账；打标签失败不阻断主流程。
      try {
        if (rec.media_id && KB_ID) await lib.addTag(rec.media_id, TAG_DONE, KB_ID);
      } catch (te) {
        log('打标签失败（不影响飞书落库）：' + safeErr(te));
      }

      // 内部群明细：人物在前、效果在后，一行一条，供人直接扫读
      v.people.forEach(p => details.push(llm.briefOf('people', p)));
      v.effects.forEach(e => {
        details.push(llm.briefOf('effect', e));
        productCount[e.product] = (productCount[e.product] || 0) + 1;
      });
      stats.effects += v.effects.length;
      stats.people += v.people.length;
      state.seen[fp] = { ts: rec.ts, stories: total, media_id: rec.media_id };
      state.writes.push({ ts: rec.ts, fp, docs: writes.map(w => w.doc), blocks: writes.reduce((a, w) => a + w.blocks, 0) });
      stats.processed++;
    } catch (e) {
      stats.failed++;
      failedNow.push(rec);
      // 关键：失败绝不打「故事已收」，否则素材会被永久判成已处理
      log('处理失败：' + safeErr(e) + '（未打标签，下轮重试）');
    }
    await lib.sleep(450);
  }

  // 台账：本轮失败的项 + 重抓仍失败的旧项都保留，其余清掉
  state.pending = [...stillFailed, ...failedNow];
  try { saveState(state); }
  catch (e) { log('台账写入被拒：' + safeErr(e) + '（本轮内容已由幂等键保护）'); }

  const products = Object.entries(productCount).map(([k, n]) => `${k} ${n}`).join('、') || '无';
  log(`完成：处理 ${stats.processed} | 无故事 ${stats.none} | 效果 ${stats.effects} | 人物 ${stats.people} | 新建章节 ${stats.newChapters} | 错名纠正 ${stats.renamed} | 概述弃用 ${stats.briefDrop} | 原话未命中丢弃 ${stats.rejectedQuote + stats.rejectedOther} | 失败 ${stats.failed}`);
  setResult(
    `📖 收故事：处理 ${stats.processed} 份｜无故事 ${stats.none} 份｜新增效果故事 ${stats.effects} 条（${products}）、人物篇 ${stats.people} 篇｜新建章节 ${stats.newChapters} 个｜失败 ${stats.failed} 份`,
    stats, details);

  if (stats.processed || stats.failed) {
    await notify([
      `收故事 · ${date}`,
      `处理 ${stats.processed} 份｜无故事 ${stats.none} 份｜失败 ${stats.failed} 份`,
      `新增效果故事 ${stats.effects} 条（${products}）｜人物篇 ${stats.people} 篇`,
      `原话校验丢弃 ${stats.rejectedQuote} 条｜其他不合规 ${stats.rejectedOther} 条`,
      stats.failed ? '失败项未打标签，下轮自动重试。' : '',
      details.length ? '\n—— 明细 ——\n' + details.slice(0, 6).join('\n') : '',
    ].filter(Boolean).join('\n'));
  }
  return 0;
}

(async () => {
  try { process.exit(await main()); }
  catch (e) {
    log('顶层异常：' + safeErr(e));
    setResult('📖 收故事：执行异常，已跳过（不影响转写管线）');
    process.exit(0); // 绝不拖红主管线
  }
})();
