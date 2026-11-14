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

// 对照表里的产品错写：只在预筛打分时补召回，避免整段因错字被打低分而漏掉。
let DYN_PRODUCT_RE = null;
const escapeRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 由转写错误对照表注入产品错写别名；传空对象即恢复内置规则。 */
function setProductAliases(map) {
  const keys = Object.keys(map || {}).filter(k => k && k.length >= 2);
  DYN_PRODUCT_RE = keys.length ? new RegExp(keys.map(escapeRe).join('|'), 'g') : null;
}

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
  const productHits = (all.match(PRODUCT_RE) || []).length
    + (DYN_PRODUCT_RE ? (all.match(DYN_PRODUCT_RE) || []).length : 0);
  const outcomeHits = (all.match(OUTCOME_RE) || []).length;
  if (!productHits && outcomeHits < 5) {
    return { body, picked: '', chunkCount: chunks.length, keptChunks: 0 };
  }

  const base = chunks.map(c =>
    ((c.match(PRODUCT_RE) || []).length + (DYN_PRODUCT_RE ? (c.match(DYN_PRODUCT_RE) || []).length : 0)) * 12 +
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
3. 说话人归因（最重要）：逐字稿每块形如「[时间戳] 发言人：正文」。
   - person 只能照抄该原话所在块的发言人标签，禁止按文件标题、上下文、常识推断，禁止把昵称改写成全名。
   - subject 只有在「说话人讲的是另一个人的事」时才填那个人的名字；讲自己的事必须留空字符串 ""。转述的事绝不能算成说话人自述。
   - speaker 填这句原话实际是谁说的。
4. 产品效果故事只收「有名字的人」用了产品后有具体变化的事。产品只能归这 8 类之一：干膜、党参饮、雪莲贴、养发乳、五星、卿春宝、磷虾油、能量霜。
   不收：产品机理、成分、制度、价格、没有具名的「有个客户」。
5. 人物故事线：有完整人生线（从哪来 → 原来做什么 → 遇到什么坎 → 现在怎样）才输出；分 3-6 小节，每节给标题 + 原文摘录若干条。标题要具体，不超过 20 字。
6. 禁止扩写：problem / duration / result 只能摘原文里明确出现的词句。不许补场景、神态、心理、比喻、总结，不许补原文没有的数字、时间、地点、动作。
7. brief 是给内部群看的一句话概述，格式固定为「人物｜他发生了什么」，长度 12-32 字，不许用引号、书名号、括号。
   - 只允许用原文出现过的词重新组合，禁止新增任何人物、数字、地点、产品、时间。
   - 有具体数字要带上数字，但必须与原文完全一致（原文说「一年半」，就不要写成「18 个月」）。
   - 不许抒情、不许评价、不许写「感人」「励志」「逆袭」这类词。
   - 效果故事写成「原问题 → 现在怎样」；人物线写成「原来的身份 → 现在的状态」。

严格返回 JSON（不要 markdown 代码块、不要解释）：
{
  "effects": [
    {"person":"原话所在块的发言人标签","product":"8类之一","problem":"原问题(<=30字)","duration":"用了多久(<=20字)","result":"具体变化(<=40字)","quote":"逐字稿里的一句原话","speaker":"这句话是谁说的","subject":"讲别人的事才填，讲自己留空","brief":"人物｜一句话概述(12-32字)"}
  ],
  "people": [
    {"person":"发言人标签","subject":"讲别人的事才填，讲自己留空","brief":"人物｜一句话概述(12-32字)","sections":[{"title":"小节标题","excerpts":["逐字稿原句","逐字稿原句"]}]}
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

/** 待认领原因码（纯数字，可安全进公开日志/台账）。 */
const REASON = { NO_SPEAKER: 1, AMBIGUOUS: 2, CONFLICT: 3, FORMAT: 5 };

const SPEAKER_RE = /^\s*(\[\d{1,2}:\d{2}(?::\d{2})?\])\s*([^\n：:]{1,30})[：:]/;
const STAMP_G = /\[\d{1,2}:\d{2}(?::\d{2})?\]/g;

/**
 * 按「[时间戳] 发言人：」把逐字稿切成带说话人归属的块。
 * 切块规则与 preselect 一致（空行优先、时间戳兜底），这样 quote 能定位回
 * 它真正所属的那一块，而不是「全文里出现过就算」——后者在多人轮讲时
 * 会让 A 说的话被算到 B 名下也通过校验。
 */
function parseSpeakerBlocks(body) {
  const text = String(body || '');
  let chunks = text.split(/\n\s*\n/).map(s => s.trim()).filter(Boolean);
  const stamps = (text.match(STAMP_G) || []).length;
  if (stamps > 0 && chunks.length < stamps / 2) {
    chunks = text.split(/(?=\[\d{1,2}:\d{2}(?::\d{2})?\])/).map(s => s.trim()).filter(Boolean);
  }
  // transcriptBody() 保留「## 逐字稿」标题行，它会被切成一个无说话人的伪块：
  // 既污染块索引，又会在跨块窗口拼接时把原话从中间截断，先滤掉纯 markdown 标题。
  return chunks.filter(s => !/^#{1,6}\s/.test(s)).map(raw => {
    const m = raw.match(SPEAKER_RE);
    const head = m ? m[0] : '';
    const content = head ? raw.slice(head.length) : raw;
    return {
      raw,
      normText: norm(raw),
      normContent: norm(content),       // 只用说话内容做匹配，不含 [时间戳] 发言人：
      stamp: m ? m[1] : '',
      speaker: m ? String(m[2]).trim() : '',
    };
  });
}

/**
 * 定位 quote 落在哪些块。优先单块；装不下时允许 2-3 块连续窗口
 * （转写常把一句话切到相邻块）。返回窗口内出现的说话人集合。
 */
function locateQuote(blocks, quote) {
  const q = norm(quote);
  if (q.length < 6) return null;
  for (let i = 0; i < blocks.length; i++) {
    if (blocks[i].normContent.includes(q)) {
      return { idx: i, speakers: blocks[i].speaker ? [blocks[i].speaker] : [], stamp: blocks[i].stamp, scope: 1 };
    }
  }
  for (let w = 2; w <= 3; w++) {
    for (let i = 0; i + w <= blocks.length; i++) {
      const win = blocks.slice(i, i + w);
      if (win.map(b => b.normContent).join('').includes(q)) {
        const speakers = [...new Set(win.map(b => b.speaker).filter(Boolean))];
        return { idx: i, speakers, stamp: win[0].stamp || '', scope: w };
      }
    }
  }
  return null;
}

/** 昵称与全名的宽松归一：完全相同或互为子串即视为同一人（不猜、不查外部档案）。 */
const samePerson = (a, b) => {
  const x = norm(a), y = norm(b);
  return !!x && !!y && (x === y || (x.length >= 2 && y.length >= 2 && (x.includes(y) || y.includes(x))));
};

/**
 * 归属三级判定：
 *   accept    → 块标签唯一且与 person 一致，可写进对应人章节
 *   unclaimed → 证据不足/转述/归属冲突，保留原话到「待认领」，绝不静默丢弃
 *   drop      → 原话不真实（locateQuote 未命中），直接丢弃
 * cmp 是「是否同一人」比较器，默认内置规则；接入转写错误对照表后由调用方注入。
 */
function attribute(loc, person, subject, cmp = samePerson) {
  if (!loc) return { level: 'drop' };
  if (norm(subject)) return { level: 'unclaimed', reason: REASON.AMBIGUOUS };
  const speakers = loc.speakers || [];
  if (!speakers.length) return { level: 'unclaimed', reason: REASON.NO_SPEAKER };
  if (speakers.length > 1) {
    return speakers.some(s => cmp(s, person))
      ? { level: 'unclaimed', reason: REASON.AMBIGUOUS }
      : { level: 'unclaimed', reason: REASON.CONFLICT };
  }
  if (!cmp(speakers[0], person)) return { level: 'unclaimed', reason: REASON.CONFLICT };
  return { level: 'accept', speaker: speakers[0], stamp: loc.stamp };
}

/**
 * 硬校验 + 归属门禁。所有引用必须逐字命中「某一个块」，产品须在 8 类白名单。
 * 原话真实但不达标的条目一律进 unclaimed（保留原话，不写任何人章节），
 * 只有 accept 的条目才会被写进飞书正文。
 */
function validate(parsed, body, opts) {
  const nm = (opts && opts.norm) || null;
  // 比对与落库一律用标准名：块标签可能是转写错字，LLM 可能自作主张写成全名，
  // 两边先归一再比，才能既不错判、又能命中已有章节标题。
  const canon = nm ? (x => nm.person(x)) : (x => String(x || ''));
  const cmp = nm ? ((a, b) => nm.same(a, b)) : samePerson;
  const blocks = parseSpeakerBlocks(body);
  const rejected = { quote: 0, product: 0, fields: 0, duplicate: 0, conflict: 0, brief: 0 };
  const unclaimed = [];
  const unclaimedSeen = new Set();
  const effects = [];
  const people = [];
  const seenEffect = new Set();
  let renamed = 0;   // 被对照表纠正成标准名的条数（只记数字）

  /**
   * brief 只进内部群消息，但仍是 LLM 自由生成 → 必须能对着原文核。
   * 数字白名单：brief 里每个数字都必须在逐字稿里以同样的写法出现，
   * 「一年半」被写成「18 个月」这类换算就是编造，整句丢弃（下一步用模板兜底）。
   */
  const hasNum = n => new RegExp('(^|\\D)' + n.replace(/\./g, '\\.') + '(\\D|$)').test(body);
  const briefOk = raw => {
    let b = String(raw || '').replace(/[\r\n\t]+/g, ' ').trim();
    if (!b) return '';
    b = b.replace(/^[「『"'《【(]+/, '').replace(/[」』"'》】)]+$/, '').trim();
    if (!b) return '';
    const nums = b.match(/\d+(?:\.\d+)?/g) || [];
    if (nums.some(n => !hasNum(n))) return '';
    return b.slice(0, 40);
  };

  // 待认领条目只保留逐字命中原文的内容：LLM 生成的 problem/result 等自由字段
  // 一律不写入，避免把编造的场景/数字带进飞书。reason=3 时不写 person。
  const pushUnclaimed = (kind, reason, quote, person, loc) => {
    const q = String(quote || '').slice(0, 300);
    const key = kind + '|' + norm(q);
    if (!q || unclaimedSeen.has(key)) return;
    unclaimedSeen.add(key);
    unclaimed.push({
      kind, reason, quote: q,
      person: reason === REASON.CONFLICT ? '' : String(canon(person) || '').slice(0, 30),
      speaker: (loc && loc.speakers && loc.speakers[0]) || '',
      stamp: (loc && loc.stamp) || '',
    });
  };

  for (const e of (Array.isArray(parsed.effects) ? parsed.effects : [])) {
    const loc = locateQuote(blocks, e.quote);
    if (!loc) { rejected.quote++; continue; }              // 原话不真实：唯一允许静默丢弃的情形
    const product = PRODUCTS.includes(e.product)
      ? e.product
      : (ALIAS[e.product] || (nm ? nm.product(e.product) : ''));
    const fieldsOk = !!(e.person && e.problem && e.duration && e.result && e.quote);
    if (!product) rejected.product++;
    if (!fieldsOk) rejected.fields++;
    const a = attribute(loc, e.person, e.subject, cmp);
    let reason = 0;
    if (a.level === 'unclaimed') reason = a.reason;
    else if (!product || !fieldsOk) reason = REASON.FORMAT;
    if (reason) {
      if (a.reason === REASON.CONFLICT) rejected.conflict++;
      pushUnclaimed('effect', reason, e.quote, e.person, loc);
      continue;
    }
    const q = norm(e.quote);
    const stdName = canon(e.person);
    if (nm && stdName !== String(e.person || '').trim()) renamed++;
    const dedupKey = norm(stdName) + '|' + product + '|' + q.slice(0, 40);
    if (seenEffect.has(dedupKey)) { rejected.duplicate++; continue; }
    seenEffect.add(dedupKey);
    const brief = briefOk(e.brief);
    if (e.brief && !brief) rejected.brief++;
    effects.push({
      person: String(stdName).slice(0, 30),
      product,
      problem: String(e.problem).slice(0, 30),
      duration: String(e.duration).slice(0, 20),
      result: String(e.result).slice(0, 40),
      quote: String(e.quote).slice(0, 300),
      speaker: a.speaker || '',
      stamp: a.stamp || '',
      brief,
    });
  }

  for (const p of (Array.isArray(parsed.people) ? parsed.people : [])) {
    if (!p.person) continue;
    const sections = [];
    for (const sec of (Array.isArray(p.sections) ? p.sections : [])) {
      const title = String(sec.title || '').trim();
      if (!title) { rejected.fields++; continue; }        // 空标题会产生空 h3 块，触发飞书 1770001
      const excerpts = [];
      for (const x of (Array.isArray(sec.excerpts) ? sec.excerpts : [])) {
        const loc = locateQuote(blocks, x);
        if (!loc) { rejected.quote++; continue; }
        const a = attribute(loc, p.person, p.subject, cmp);
        if (a.level !== 'accept') {
          if (a.reason === REASON.CONFLICT) rejected.conflict++;
          pushUnclaimed('people', a.reason || REASON.FORMAT, x, p.person, loc);
          continue;
        }
        excerpts.push(String(x).slice(0, 300));
      }
      if (!excerpts.length) continue;
      sections.push({ title: title.slice(0, 20), excerpts: excerpts.slice(0, 6) });
    }
    if (sections.length < 3 || sections.length > 6) {
      rejected.fields++;
      // 人物线格式不达标时，已通过归属校验的摘录仍保留到待认领，不静默丢
      sections.forEach(s => s.excerpts.forEach(x => pushUnclaimed('people', REASON.FORMAT, x, p.person, null)));
      continue;
    }
    const stdName = canon(p.person);
    if (nm && stdName !== String(p.person || '').trim()) renamed++;
    const brief = briefOk(p.brief);
    if (p.brief && !brief) rejected.brief++;
    people.push({ person: String(stdName).slice(0, 30), brief, sections });
  }

  return { effects, people, rejected, unclaimed, renamed };
}

/**
 * 企业微信明细里的一行概述：优先用模型给的 brief（已过数字白名单校验），
 * 校验没过就用模板拼——模板只用已过校验的字段，绝不引入新信息。
 * 输出上限 40 字，避免一条概述把企微 2048 字节额度吃掉。
 */
function briefOf(kind, item) {
  if (!item) return '';
  if (item.brief) return String(item.brief).slice(0, 40);
  if (kind === 'effect') {
    return `${item.person}｜${item.problem} → ${item.result}`.slice(0, 40);
  }
  const first = (item.sections && item.sections[0] && item.sections[0].title) || '';
  return `${item.person}｜${first}`.slice(0, 40);
}

module.exports = {
  PRODUCTS, REASON, transcriptBody, fingerprint, transcriptMinute,
  preselect, extractStories, validate, parseJsonLoose, setProductAliases,
  parseSpeakerBlocks, locateQuote, attribute, briefOf,
};
