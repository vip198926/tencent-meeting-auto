/**
 * story_llm.js — 逐字稿预筛 → LLM 结构化抽取 → 原话硬校验
 *
 * 设计要点：
 *   1. 不整篇喂模型。规则召回候选段落（±2 段上下文），1.7 万字压到 <= 6 千字。
 *   2. 输出是「原文摘录」而非改写叙述：每条摘录必须逐字命中逐字稿，挡住编造。
 *   3. 任何响应体 / 正文都不进日志（public 仓库的 Actions 日志是公开的）。
 */
'use strict';

const crypto = require('crypto');
const { httpJson } = require('./story_lib');

/** 技能全本限定的 8 类产品，别名归一后仍归到这 8 类。 */
const PRODUCTS = ['干膜', '党参饮', '雪莲贴', '养发乳', '五星', '卿春宝', '磷虾油', '能量霜'];
const ALIAS = {
  '轻能减脂': '五星', '五星轻能减脂': '五星',
  '岁月葆': '卿春宝', '卿春宝岁月葆': '卿春宝',
};

// 三级信号：产品名权重最高，效果/时长次之，人生线用词最低
const PRODUCT_RE = /干膜|党参饮|雪莲贴|养发乳|五星|轻能减脂|卿春宝|岁月葆|磷虾油|能量霜/g;
const OUTCOME_RE = /用了|吃了|喝了|贴了|个月|半年|斤|公斤|改善|变化|效果|调理|体检|睡眠|体重|掉发|皮肤|疼痛/g;
const WEAK_RE = /以前|原来|后来|之前|现在|感觉|开始/g;

/** 只取 `## 逐字稿` 之后的内容，技能明确禁止用 AI 纪要（会美化原话）。 */
function transcriptBody(text) {
  const i = String(text || '').indexOf('## 逐字稿');
  return i >= 0 ? text.slice(i) : String(text || '');
}

/** 前 1500 字去空白后 md5 前 12 位，与技能 scan.py 的指纹规则一致。 */
function fingerprint(text) {
  const s = String(text || '').slice(0, 1500).replace(/\s/g, '');
  return crypto.createHash('md5').update(s, 'utf8').digest('hex').slice(0, 12);
}

/** 正文里的 `转写时间：YYYY/MM/DD HH:MM`，用于同分钟判重。 */
function transcriptMinute(text) {
  const m = String(text || '').match(/转写时间[：:]\s*(\d{4})[/-](\d{1,2})[/-](\d{1,2})(?:\s+(\d{1,2})[:：](\d{2}))?/);
  if (!m || !m[4]) return '';
  return `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')} ${String(m[4]).padStart(2, '0')}:${m[5]}`;
}

/**
 * 候选段落召回。
 * 逐字稿是「[时间戳] 发言人：\n 正文\n\n」的块结构，按空行切才不会拆散说话人与内容。
 * 打分后按「四段配额」挑选：每段独立预算，保证会议前/中/后段都覆盖，
 * 不会因前半场命中多就把后半场的故事整段丢掉。
 */
function preselect(text, maxChars = 6000) {
  const body = transcriptBody(text);
  let chunks = body.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
  // 兼容无空行的导出格式（IMA / 部分 md 解析器会压掉空行）：按时间戳重新切块
  const stamps = (body.match(/\[\d{1,2}:\d{2}:\d{2}\]/g) || []).length;
  if (stamps > 0 && chunks.length < stamps / 2) {
    chunks = body.split(/(?=\[\d{1,2}:\d{2}:\d{2}\])/).map(s => s.trim()).filter(Boolean);
  }
  const all = chunks.join('\n');
  const productHits = (all.match(PRODUCT_RE) || []).length;
  const outcomeHits = (all.match(OUTCOME_RE) || []).length;
  if (!productHits && outcomeHits < 5) {
    return { body, picked: '', chunkCount: chunks.length, keptChunks: 0 };
  }

  const base = chunks.map(c =>
    (c.match(PRODUCT_RE) || []).length * 12 +
    (c.match(OUTCOME_RE) || []).length * 3 +
    (c.match(WEAK_RE) || []).length);

  // 命中块 ±2 块作为上下文，分数按距离衰减
  const score = new Array(chunks.length).fill(0);
  base.forEach((s, i) => {
    if (!s) return;
    for (let k = Math.max(0, i - 2); k <= Math.min(chunks.length - 1, i + 2); k++) {
      score[k] += s / (1 + Math.abs(k - i));
    }
  });

  const BUCKETS = 4;
  const per = Math.floor(maxChars / BUCKETS);
  const chosen = new Set();
  const buckets = [];
  for (let b = 0; b < BUCKETS; b++) {
    const before = chosen.size;
    const from = Math.floor(chunks.length * b / BUCKETS);
    const to = Math.floor(chunks.length * (b + 1) / BUCKETS);
    const order = [];
    for (let i = from; i < to; i++) if (score[i] > 0) order.push(i);
    order.sort((x, y) => score[y] - score[x]);
    let used = 0;
    for (const i of order) {
      const len = chunks[i].length + 2;
      if (used + len > per) continue;
      chosen.add(i); used += len;
    }
    buckets.push(chosen.size - before);
  }
  const picked = [...chosen].sort((a, b) => a - b).map(i => chunks[i]).join('\n\n').slice(0, maxChars);
  return { body, picked, chunkCount: chunks.length, keptChunks: chosen.size, buckets };
}

const SYSTEM_PROMPT = `你是「收故事」抽取器。从会议逐字稿里找出真实发生过的故事，只做摘录，不做创作。

铁律：
1. 只使用逐字稿里出现过的原句。excerpts / quote 里的每一条都必须能从原文逐字找到，一个字都不能改（保留口语、重复、错字）。
2. 不许总结、不许抒情、不许补写、不许推断。没有就说没有，输出空数组。
3. 说话人归因：别人转述的事要写明是谁说的（speaker 字段），不能当成当事人自述。
4. 产品效果故事只收「有名字的人」用了产品后有具体变化的事。产品只能归这 8 类之一：干膜、党参饮、雪莲贴、养发乳、五星、卿春宝、磷虾油、能量霜。
   不收：产品机理、成分、制度、价格、没有具名的「有个客户」。
5. 人物故事线：有完整人生线（从哪来 → 原来做什么 → 遇到什么坎 → 现在怎样）才输出；分 3-6 小节，每节给标题 + 原文摘录若干条。标题要具体，不超过 20 字。

严格返回 JSON（不要 markdown 代码块、不要解释）：
{
  "effects": [
    {"person":"姓名或花名","product":"8类之一","problem":"原问题(<=30字)","duration":"用了多久(<=20字)","result":"具体变化(<=40字)","quote":"逐字稿里的一句原话","speaker":"这句话是谁说的"}
  ],
  "people": [
    {"person":"姓名","sections":[{"title":"小节标题","excerpts":["逐字稿原句","逐字稿原句"]}]}
  ]
}`;

/** OpenAI 兼容 chat/completions。DeepSeek / Qwen / Kimi 均可，通过 LLM_BASE_URL / LLM_MODEL 切换。 */
async function extractStories(picked) {
  const key = process.env.LLM_API_KEY;
  if (!key) throw new Error('缺少 LLM_API_KEY');
  const base = (process.env.LLM_BASE_URL || 'https://api.deepseek.com').replace(/\/$/, '');
  // deepseek-chat / deepseek-reasoner 已于 2026-07-24 弃用；当前官方模型名为 deepseek-flash / deepseek-v4-pro。
  const model = process.env.LLM_MODEL || 'deepseek-flash';
  const payload = {
    model,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: '以下是会议逐字稿片段（只在这些内容里找，不要引用片段以外的任何文字）：\n\n' + picked },
    ],
    temperature: 0.1,
    max_tokens: 4000,
    stream: false,
  };
  // DeepSeek V4 系列默认开启思考模式（effort=high）：temperature 不生效，且思维链会占用
  // max_tokens 导致 content 为空。摘录是确定性任务，显式关闭；其它厂商端点不发送此字段。
  if (/api\.deepseek\.com/i.test(base)) payload.thinking = { type: 'disabled' };
  const { status, json } = await httpJson('POST', base + '/chat/completions', {
    Authorization: 'Bearer ' + key,
  }, payload, 180000);
  if (json.error) throw new Error(`LLM code=${json.error.code || status}`);
  const raw = json.choices?.[0]?.message?.content;
  if (!raw) throw new Error('LLM 返回为空');
  const parsed = parseJsonLoose(raw);
  if (!parsed) throw new Error('LLM 返回无法解析为 JSON');
  return parsed;
}

function parseJsonLoose(raw) {
  const s = String(raw).trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b <= a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch { return null; }
}

const norm = s => String(s || '').replace(/\s+/g, '');

/**
 * 硬校验：所有引用必须逐字命中原文，产品必须在 8 类白名单，字段必须齐全。
 * 任何不达标条目直接丢弃并计数，绝不写入飞书。
 */
function validate(parsed, body) {
  const nBody = norm(body);
  const rejected = { quote: 0, product: 0, fields: 0, duplicate: 0 };
  const effects = [];
  const seenEffect = new Set();

  for (const e of (Array.isArray(parsed.effects) ? parsed.effects : [])) {
    const product = PRODUCTS.includes(e.product) ? e.product : (ALIAS[e.product] || '');
    if (!product) { rejected.product++; continue; }
    if (!e.person || !e.problem || !e.duration || !e.result || !e.quote) { rejected.fields++; continue; }
    const q = norm(e.quote);
    if (q.length < 6 || !nBody.includes(q)) { rejected.quote++; continue; }
    const dedupKey = norm(e.person) + '|' + product + '|' + q.slice(0, 40);
    if (seenEffect.has(dedupKey)) { rejected.duplicate++; continue; }
    seenEffect.add(dedupKey);
    effects.push({
      person: String(e.person).slice(0, 30),
      product,
      problem: String(e.problem).slice(0, 30),
      duration: String(e.duration).slice(0, 20),
      result: String(e.result).slice(0, 40),
      quote: String(e.quote).slice(0, 300),
      speaker: String(e.speaker || '').slice(0, 30),
    });
  }

  const people = [];
  for (const p of (Array.isArray(parsed.people) ? parsed.people : [])) {
    if (!p.person) continue;
    const sections = [];
    for (const sec of (Array.isArray(p.sections) ? p.sections : [])) {
      const title = String(sec.title || '').trim();
      if (!title) { rejected.fields++; continue; }          // 无标题小节丢弃，避免空 h3 块触发飞书 1770001
      const excerpts = (Array.isArray(sec.excerpts) ? sec.excerpts : [])
        .map(x => String(x))
        .filter(x => norm(x).length >= 6 && nBody.includes(norm(x)));
      if (!excerpts.length) { rejected.quote++; continue; }  // 无摘录小节丢弃
      sections.push({ title: title.slice(0, 20), excerpts: excerpts.slice(0, 6).map(x => x.slice(0, 300)) });
    }
    if (sections.length < 3 || sections.length > 6) continue;  // 人物线需 3-6 节
    people.push({ person: String(p.person).slice(0, 30), sections });
  }

  return { effects, people, rejected };
}

module.exports = {
  PRODUCTS, transcriptBody, fingerprint, transcriptMinute,
  preselect, extractStories, validate, parseJsonLoose,
};
