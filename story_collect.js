/**
 * story_collect.js — 收故事（GitHub Actions 版）
 *
 * 接在 09:36 会议转写管线之后运行，把本轮上传的逐字稿自动提取成故事，
 * 增量追加到两份飞书文档，再打 IMA 标签记账。凭证未配齐时静默跳过，不影响主管线。
 *
 * 隐私约定（public 仓库 + 公开的 Actions 日志）：
 *   - 逐字稿正文只在 $RUNNER_TEMP 的交接文件与进程内存里，绝不进仓库、日志、artifact。
 *   - 台账只存指纹 / media_id / record_id / block_id / 时间戳，不存人名、原话、会议主题。
 *   - 所有日志只打数量与错误码，企微简报不含人名与原话。
 *
 * 用法：
 *   node story_collect.js                       正常跑（由 daily.yml 调用）
 *   node story_collect.js --selftest <file.md>  离线自检预筛，不联网、不写任何外部系统
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const lib = require('./story_lib');
const llm = require('./story_llm');

const STATE_FILE = process.env.STORY_STATE_FILE || path.join(__dirname, 'daily', 'story_state.json');
const BATCH_FILE = process.env.STORY_BATCH_FILE || '';
const KB_ID = process.env.IMA_KB_ID || process.env.STORY_KB_ID || 'ima_kb_3nebCJv6';
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
function safeErr(e) {
  // 只保留固定文案 + 错误码；绝不把响应体、正文、token 带进日志
  return String((e && e.message) || e).replace(/[^\x20-\x7E一-龥0-9=_-]/g, ' ').slice(0, 120);
}

// ---- 台账 ----
function loadState() {
  try {
    const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    if (j && j.version === 1 && j.seen && Array.isArray(j.pending)) return j;
  } catch { /* 首次运行 */ }
  return { version: 1, updated: '', seen: {}, pending: [], writes: [] };
}

function saveState(s) {
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

// ---- 飞书块（v1：只追加，绝不 overwrite / 不改目录 / 不改条数）----
function blocksForPeople(date, people) {
  const blocks = [];
  for (const p of people) {
    blocks.push(lib.h2(`[自动追加 ${date}] ${p.person}`));
    p.sections.forEach(sec => {
      blocks.push(lib.h3(sec.title));
      sec.excerpts.forEach(ex => blocks.push(lib.textBlock(ex)));
    });
  }
  return blocks;
}

function blocksForEffects(date, effects) {
  const groups = new Map();
  effects.forEach(e => {
    if (!groups.has(e.product)) groups.set(e.product, []);
    groups.get(e.product).push(e);
  });
  const blocks = [];
  for (const [product, list] of groups) {
    blocks.push(lib.h3(`[${date}] ${product}`));
    for (const e of list) {
      const speaker = e.speaker ? `\n（${e.speaker} 说）` : '';
      blocks.push(lib.textBlock(`${e.person}｜${e.problem}｜${e.duration}｜${e.result}\n原话：「${e.quote}」${speaker}`));
    }
  }
  return blocks;
}

function deterministicToken(fp, docId, batchIdx) {
  const h = crypto.createHash('md5').update(`${fp}|${docId}|${batchIdx}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// ---- 企微简报（只报数字，不含人名/原话/会议主题）----
async function notify(text) {
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
    return 0;
  }

  const state = loadState();
  const date = lib.bjDate();
  const batch = loadBatch();
  const { out: recovered, stillFailed } = await recoverPending(state);
  const items = [...batch, ...recovered];

  if (!items.length) {
    log('本轮无新增逐字稿，静默结束');
    return 0;
  }

  const { kept, dropped } = dedupeByMinute(items);
  const todo = kept.filter(it => !state.seen[llm.fingerprint(it.text)]);
  log('待处理', todo.length, '份 | 同分钟判掉', dropped, '份 | 指纹已收', kept.length - todo.length, '份 | 重试恢复', recovered.length, '份');

  if (!todo.length) return 0;

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
    await notify(`收故事 · ${date}\n自检失败，本轮 ${todo.length} 份未处理，未打标签，下轮自动重试。`);
    return 0;
  }

  const stats = { processed: 0, none: 0, effects: 0, people: 0, rejectedQuote: 0, rejectedOther: 0, failed: 0 };
  const productCount = {};
  const failedNow = [];

  for (const it of todo) {
    const fp = llm.fingerprint(it.text);
    const rec = { record_id: it.record_id || '', media_id: it.media_id || '', fp, ts: new Date().toISOString() };
    try {
      const sel = llm.preselect(it.text);
      if (!sel.picked) {
        if (rec.media_id) await lib.addTag(rec.media_id, TAG_NONE, KB_ID);
        state.seen[fp] = { ts: rec.ts, stories: 0, media_id: rec.media_id };
        stats.none++;
        continue;
      }

      const parsed = await llm.extractStories(sel.picked);
      const v = llm.validate(parsed, sel.body);
      stats.rejectedQuote += v.rejected.quote;
      stats.rejectedOther += v.rejected.product + v.rejected.fields + v.rejected.duplicate;

      const pBlocks = blocksForPeople(date, v.people);
      const eBlocks = blocksForEffects(date, v.effects);
      const writes = [];

      if (pBlocks.length) {
        const ids = await lib.appendInBatches(process.env.FEISHU_DOC_PEOPLE, token, pBlocks,
          i => deterministicToken(fp, 'people', i));
        writes.push({ doc: 'people', blocks: ids.length, fp });
      }
      if (eBlocks.length) {
        const ids = await lib.appendInBatches(process.env.FEISHU_DOC_EFFECT, token, eBlocks,
          i => deterministicToken(fp, 'effect', i));
        writes.push({ doc: 'effect', blocks: ids.length, fp });
      }

      // 只有飞书写入成功后才追加索引、打标签
      await lib.appendNote(process.env.STORY_NOTE_ID,
        `- ${date}：自动收故事 1 份（指纹 ${fp}）→ 人物篇 ${v.people.length} 篇、效果故事 ${v.effects.length} 条（${[...new Set(v.effects.map(e => e.product))].join('、') || '无'}）`);
      if (rec.media_id) await lib.addTag(rec.media_id, TAG_DONE, KB_ID);

      v.effects.forEach(e => { productCount[e.product] = (productCount[e.product] || 0) + 1; });
      stats.effects += v.effects.length;
      stats.people += v.people.length;
      state.seen[fp] = { ts: rec.ts, stories: v.effects.length + v.people.length, media_id: rec.media_id };
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
  saveState(state);

  const products = Object.entries(productCount).map(([k, n]) => `${k} ${n}`).join('、') || '无';
  log(`完成：处理 ${stats.processed} | 无故事 ${stats.none} | 效果 ${stats.effects} | 人物 ${stats.people} | 存疑丢弃 ${stats.rejectedQuote + stats.rejectedOther} | 失败 ${stats.failed}`);

  if (stats.processed || stats.failed) {
    await notify([
      `收故事 · ${date}`,
      `处理 ${stats.processed} 份｜无故事 ${stats.none} 份｜失败 ${stats.failed} 份`,
      `新增效果故事 ${stats.effects} 条（${products}）｜人物篇 ${stats.people} 篇`,
      `原话校验丢弃 ${stats.rejectedQuote} 条｜其他不合规 ${stats.rejectedOther} 条`,
      stats.failed ? '失败项未打标签，下轮自动重试。' : '',
    ].filter(Boolean).join('\n'));
  }
  return 0;
}

(async () => {
  try { process.exit(await main()); }
  catch (e) { log('顶层异常：' + safeErr(e)); process.exit(0); } // 绝不拖红主管线
})();
