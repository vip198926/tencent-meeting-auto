'use strict';
/**
 * story_layout.js — 写入规划（纯函数，不联网、不落盘）
 *
 * 规则：
 *   - 故事归属到已有章节 → 插到该章节末尾（下一个同级标题之前）
 *   - 效果篇按产品名「包含匹配」复用现有 8 个章节，不另建同名章节（避免前后重复）
 *   - 人名用严格匹配（精确 / 开头 / 独立分隔段），昵称对不上才新建章节，防止串篇
 *   - 找不到章节 → 新建章节追加到文档末尾；新建章节带稳定前缀，下一轮精确命中，不重复堆
 *   - 归属不确定的条目 → 统一放「未署名故事」章节，不带人名，避免 A 的故事挂到 B 名下
 *   - 绝不 delete / overwrite 已有块；index 必须来自根块 children 顺序，不能用扁平 items 下标
 *
 * 章节标题文字只在进程内存里参与匹配，不落盘、不进日志、不进仓库。
 */
const UNATTRIBUTED = '未署名故事';
// 程序新建的章节用稳定前缀：下一轮精确命中同一标题，避免文档末尾无限堆积重复章节。
const AUTO_PREFIX = '[自动归档] ';
const norm = s => String(s || '').replace(/\s+/g, '');

/**
 * 人名匹配：先精确，再「名字在标题开头」，再「标题按常见分隔符切分后有一段等于名字」。
 * 不用宽泛 includes —— 短人名很容易出现在别人的长标题里，那会造成串篇。
 */
function matchAnchor(anchors, name) {
  const n = norm(name);
  if (n.length < 2 || !Array.isArray(anchors)) return -1;
  const t = a => norm(a.title);
  let i = anchors.findIndex(a => t(a) === n);
  if (i >= 0) return i;
  // startsWith 必须落在词边界：「成员」不能命中「成员甲｜创业与家庭」，否则短昵称会串篇
  i = anchors.findIndex(a => {
    const s = t(a);
    if (!s.startsWith(n)) return false;
    const rest = s.slice(n.length);
    return !rest || !/^[\u4e00-\u9fffA-Za-z0-9]/.test(rest);
  });
  if (i >= 0) return i;
  i = anchors.findIndex(a => t(a).split(/[：:｜|·、，,（(【\[\]—\-]/).some(seg => seg === n));
  return i;
}

/**
 * 产品章节匹配：现有 8 个章节标题形如「序号 + 产品名 + 描述」，产品名被包在长标题里，
 * 既不等于标题、也不在开头、也没被分隔符切成独立段，所以 matchAnchor 会全部落空。
 * 产品词彼此不互相包含，且实测每个标题恰好只含 1 个产品词 → 用 includes 安全。
 * 唯一命中才返回；命中 0 个或 ≥2 个（歧义）一律返回 -1，绝不靠猜归档。
 */
function matchProductAnchor(anchors, name) {
  const n = norm(name);
  if (n.length < 2 || !Array.isArray(anchors)) return -1;
  const hits = [];
  anchors.forEach((a, i) => { if (norm(a.title).includes(n)) hits.push(i); });
  return hits.length === 1 ? hits[0] : -1;
}

const groupBy = (list, keyFn) => {
  const m = new Map();
  for (const x of list || []) {
    const k = keyFn(x);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(x);
  }
  return m;
};

function makePlan(doc, mode, index, isNew, chapter, anonymous, heading) {
  return { doc, mode, index, isNew, chapter, anonymous, heading, people: [], effects: [], unattributed: [] };
}

/** 同一文档、同一插入位置的组合并，避免两次插入互相挤动 index。 */
function mergeInserts(plans) {
  const inserts = new Map(), appends = [];
  for (const p of plans) {
    if (p.mode === 'append') { appends.push(p); continue; }
    const key = p.doc + '|' + p.index;
    if (!inserts.has(key)) { inserts.set(key, p); continue; }
    const q = inserts.get(key);
    q.people.push(...p.people);
    q.effects.push(...p.effects);
    q.unattributed.push(...p.unattributed);
    q.anonymous = q.anonymous || p.anonymous;
  }
  return [...inserts.values(), ...appends];
}

/**
 * 规划一份稿的写入动作。
 * @param {object} i people/effects/unclaimed = validate() 的输出；
 *                   anchorsPeople/anchorsEffect = lib.sectionAnchors() 结果；
 *                   lenPeople/lenEffect = 各文档根块 children 长度
 */
function planWrites(i) {
  const anchorsPeople = i.anchorsPeople || [], anchorsEffect = i.anchorsEffect || [];
  const lenPeople = i.lenPeople || 0, lenEffect = i.lenEffect || 0;
  const plans = [];

  // matcher: 'person' 用严格规则防串篇；'product' 用长标题包含匹配复用现有章节
  const place = (doc, anchors, len, name, anonymous, matcher) => {
    const heading = AUTO_PREFIX + name;
    let pos = matchAnchor(anchors, heading);            // 先命中本程序之前新建的章节，避免重复建
    if (pos < 0) {
      pos = matcher === 'product' ? matchProductAnchor(anchors, name) : matchAnchor(anchors, name);
    }
    if (pos >= 0) {
      const next = anchors[pos + 1];
      return makePlan(doc, 'insert', next ? next.idx : len, false, name, anonymous, heading);
    }
    return makePlan(doc, 'append', -1, true, name, anonymous, heading);
  };

  for (const [name, list] of groupBy(i.people, p => p.person)) {
    const p = place('people', anchorsPeople, lenPeople, name, false, 'person');
    p.people = list;
    plans.push(p);
  }
  for (const [name, list] of groupBy(i.effects, e => e.product)) {
    const p = place('effect', anchorsEffect, lenEffect, name, false, 'product');
    p.effects = list;
    plans.push(p);
  }
  for (const [kind, doc, anchors, len] of [
    ['people', 'people', anchorsPeople, lenPeople],
    ['effect', 'effect', anchorsEffect, lenEffect],
  ]) {
    const list = (i.unclaimed || []).filter(u => u.kind === kind);
    if (!list.length) continue;
    const p = place(doc, anchors, len, UNATTRIBUTED, true, 'person');
    p.unattributed = list;
    plans.push(p);
  }
  return mergeInserts(plans);
}

/** insert 组按 index 降序执行（先插后面，前面的下标不受影响）；新建章节最后追加末尾。 */
function orderPlans(plans) {
  return plans.slice().sort((a, b) => {
    if (a.mode !== b.mode) return a.mode === 'insert' ? -1 : 1;
    if (a.mode === 'insert') return b.index - a.index;
    return 0;
  });
}

/** dry-run 用：只输出纯数字，含章节标题文字一律不外泄。 */
function summarize(plans) {
  return {
    groups: plans.length,
    inserted: plans.filter(p => p.mode === 'insert').length,
    newChapters: plans.filter(p => p.isNew).length,
    anonymousGroups: plans.filter(p => p.anonymous).length,
    unattributedItems: plans.reduce((n, p) => n + p.unattributed.length, 0),
  };
}

module.exports = {
  UNATTRIBUTED, AUTO_PREFIX, matchAnchor, matchProductAnchor,
  planWrites, orderPlans, summarize,
};
