/**
 * story_normalize.js — 转写错误对照表 → 人名/产品名确定性归一
 *
 * 数据源是 IMA 笔记（活文档，人工维护、每轮重读），本仓库只存它的 note_id。
 * 解析只认表格里「机器写的 / 应该是」两列，做一对一确定性映射：
 *   - 不做音近、编辑距离、模糊纠错 —— 猜错人就是把 A 的故事挂到 B 名下。
 *   - 同一错写对应两个不同正确名 → 整条弃用并计数，绝不自动选一个。
 *   - 只用于「比对标签」和「写进飞书的姓名」，逐字稿正文一个字都不改，
 *     否则 quote 逐字校验会把真实原话判成编造而丢弃。
 *
 * 隐私：真实姓名/地名只在进程内存里参与比对，不落盘、不进日志、不进仓库。
 *       本文件不含任何真实数据，测试全部使用虚构名。
 */
'use strict';

const lib = require('./story_lib');

/** 技能全本限定的 8 类产品（与 story_llm 保持同一份白名单）。 */
const PRODUCTS = ['干膜', '党参饮', '雪莲贴', '养发乳', '五星', '卿春宝', '磷虾油', '能量霜'];

const CJK_RE = /[\u3400-\u9fff]/;
const LATIN_RE = /^[A-Za-z][A-Za-z.·\s]{1,19}$/;

const cleanCell = s => String(s || '').replace(/^\*+|\*+$/g, '').trim();
/** 去掉尾部的括注（如「张三（湖南）」→「张三」），否则标准名会带着备注，匹配不到章节标题。 */
const stripNote = s => cleanCell(s).replace(/[（(][^（()）]*[）)]\s*$/, '').trim();

/** 一个单元格里可能是多个错写变体（用 、，／/ 或空格并列），逐个拆开。 */
function splitVariants(cell) {
  return stripNote(cell)
    .split(/[、，,／/\s]+/)
    .map(stripNote)
    .filter(x => x.length >= 2 && x.length <= 20);
}

/** 章节归类：只采纳人名列与产品列；同名不同人/判定原则等说明性章节不进映射。 */
function sectionKind(title) {
  const t = cleanCell(title);
  if (/同名|不同人|怎么分|判别/.test(t)) return 'skip';
  if (/人名|姓名|花名/.test(t)) return 'person';
  if (/产品/.test(t)) return 'product';
  return 'skip';
}

function looksLikeName(s) {
  return !!s && (CJK_RE.test(s) || LATIN_RE.test(s)) && !/\d{4,}/.test(s);
}

/** 目标单元格里唯一出现的产品名。0 个或 ≥2 个都返回空（歧义不猜）。 */
function pickProduct(text) {
  const t = cleanCell(text);
  const hit = PRODUCTS.filter(p => t.includes(p));
  return hit.length === 1 ? hit[0] : '';
}

/**
 * 解析对照表的 Markdown，产出三张表：
 *   personMap  错写 → 标准名
 *   productMap 产品错写 → 8 类之一
 *   strict     出现在「X ≠ …」里的短名：允许完全相同，但禁止模糊/子串合并
 */
function parseAsrTable(md) {
  const personMap = new Map();
  const productMap = new Map();
  const strict = new Set();
  const stats = { sections: 0, person: 0, product: 0, strict: 0, ambiguous: 0, skipped: 0 };

  const addPerson = (wrong, right) => {
    const w = stripNote(wrong), r = stripNote(right);
    if (!w || !r || w === r || !looksLikeName(w) || !looksLikeName(r)) return;
    const cur = personMap.get(w);
    if (cur && cur !== r) {           // 一个错写两个标准名 → 弃用，不猜
      personMap.delete(w);
      stats.ambiguous++;
      return;
    }
    personMap.set(w, r);
  };

  let kind = 'skip';
  let tableStarted = false;
  for (const raw of String(md || '').split(/\r?\n/)) {
    const t = raw.trim();

    const h = t.match(/^#{1,6}\s+(.+)$/);
    if (h) { kind = sectionKind(h[1]); tableStarted = false; stats.sections++; continue; }

    // 「X ≠ …」：X 是容易被误合并的短名，只许精确相同，不许子串合并
    const neq = t.replace(/^\s*[-*+]\s*/, '').match(/^([^\s≠]{2,12})\s*≠/);
    if (neq) { strict.add(neq[1]); stats.strict++; continue; }

    if (!t.startsWith('|')) { tableStarted = false; continue; }

    const cells = t.replace(/^\|/, '').replace(/\|$/, '').split('|').map(cleanCell);
    if (cells.every(c => !c || /^:?-{2,}:?$/.test(c))) continue;   // 分隔行
    if (!tableStarted) { tableStarted = true; continue; }          // 每个表的第一行是表头
    if (kind === 'skip') { stats.skipped++; continue; }

    const [wrongCell, rightCell] = cells;
    if (!wrongCell || !rightCell) { stats.skipped++; continue; }

    if (kind === 'product') {
      const prod = pickProduct(rightCell);
      if (!prod) { stats.skipped++; continue; }
      for (const w of splitVariants(wrongCell)) if (w !== prod) productMap.set(w, prod);
      continue;
    }

    for (const w of splitVariants(wrongCell)) addPerson(w, rightCell);
  }

  // 严格名单里的名字表里明说「和另一个人容易混」：既不做模糊合并，也不做错写归一，
  // 否则等于替人猜了一个身份——这正是串篇的来源。命中即降级为按原文标签判定。
  for (const s of strict) if (personMap.delete(s)) stats.skipped++;

  stats.person = personMap.size;
  stats.product = productMap.size;
  return { personMap, productMap, strict, stats };
}

/** 与 story_llm.samePerson 同一套规则：完全相同或互为子串即视为同一人（不查外部档案）。 */
const baseSame = (a, b) => {
  const x = String(a || '').replace(/\s+/g, ''), y = String(b || '').replace(/\s+/g, '');
  return !!x && !!y && (x === y || (x.length >= 2 && y.length >= 2 && (x.includes(y) || y.includes(x))));
};

/** 空归一器：未配置/读取失败时使用，行为与原逻辑完全一致。 */
function empty() {
  return {
    ready: false,
    stats: { sections: 0, person: 0, product: 0, strict: 0, ambiguous: 0, skipped: 0 },
    productAliases: {},
    person: x => String(x || ''),
    product: () => '',
    same: baseSame,
  };
}

/** 由对照表原文构建归一器（纯函数，便于离线测试）。 */
function build(md) {
  const parsed = parseAsrTable(md);
  const { personMap, productMap, strict } = parsed;

  const person = x => {
    const s = stripNote(x);
    return personMap.get(s) || s;
  };

  const same = (a, b) => {
    const x = person(a), y = person(b);
    if (!x || !y) return false;
    if (x !== y) {
      // 严格名单里的名字不与任何别的写法合并（同名不同人，合并即串篇）
      if (strict.has(x) || strict.has(y)) return false;
      // 错写已被映射到标准名后，不再拿原始标签做子串匹配（否则「章三」会撞进「章三丰」）
      if (personMap.has(stripNote(a)) || personMap.has(stripNote(b))) return x === y;
    }
    return baseSame(x, y);
  };

  const product = x => {
    const s = cleanCell(x);
    if (!s) return '';
    if (PRODUCTS.includes(s)) return s;
    return productMap.get(s) || '';
  };

  return {
    ready: true,
    stats: parsed.stats,
    productAliases: Object.fromEntries(productMap),
    person, product, same,
  };
}

/**
 * 每轮读一次（进程内缓存由调用方保证）。读不到就降级为原逻辑，绝不阻断主管线。
 * STORY_ASR_TABLE_FILE 仅供本地离线自检使用。
 */
async function load() {
  const file = process.env.STORY_ASR_TABLE_FILE;
  if (file) {
    if (!require('fs').existsSync(file)) return empty();
    return build(require('fs').readFileSync(file, 'utf8'));
  }
  const noteId = process.env.STORY_ASR_NOTE_ID;
  if (!noteId) return empty();
  const md = await lib.getNoteContent(noteId);
  return build(md);
}

module.exports = { PRODUCTS, parseAsrTable, build, empty, load, sectionKind, splitVariants };
