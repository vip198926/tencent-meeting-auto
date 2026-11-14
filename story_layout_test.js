'use strict';
/**
 * 章节布局与写入规划回归测试。全部虚构数据，可安全进入 public 仓库。
 *   node story_layout_test.js
 */
const assert = require('assert');
const L = require('./story_layout');
const lib = require('./story_lib');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('PASS ' + name); pass++; }
  catch (e) { console.log('FAIL ' + name + ' -> ' + e.message); fail++; }
}
const txt = s => ({ elements: [{ text_run: { content: s } }] });

const peopleAnchors = [
  { idx: 3, title: '成员甲', type: 3 },
  { idx: 40, title: '成员乙：从老家到城里', type: 3 },
  { idx: 99, title: '成员丙', type: 3 },
];
const effectAnchors = [
  { idx: 5, title: '干膜', type: 4 },
  { idx: 60, title: '磷虾油', type: 4 },
];

t('章节匹配：精确 / 开头 / 分隔符切分', () => {
  assert.strictEqual(L.matchAnchor(peopleAnchors, '成员甲'), 0);
  assert.strictEqual(L.matchAnchor(peopleAnchors, '成员乙'), 1);
  assert.strictEqual(L.matchAnchor(peopleAnchors, '成员丙'), 2);
});

t('章节匹配：不做宽泛包含，避免短名字撞进别人的长标题', () => {
  assert.strictEqual(L.matchAnchor(peopleAnchors, '员乙'), -1);
  assert.strictEqual(L.matchAnchor(peopleAnchors, '小华'), -1);
  assert.strictEqual(L.matchAnchor(peopleAnchors, '甲'), -1);   // 单字不参与匹配
});

t('命中已有章节 → insert 到下一个同级标题之前', () => {
  const plans = L.planWrites({
    people: [{ person: '成员甲', sections: [] }],
    effects: [], unclaimed: [],
    anchorsPeople: peopleAnchors, anchorsEffect: effectAnchors,
    lenPeople: 120, lenEffect: 80,
  });
  const p = plans.find(x => x.doc === 'people');
  assert.strictEqual(p.mode, 'insert');
  assert.strictEqual(p.index, 40);
  assert.strictEqual(p.isNew, false);
});

t('命中最后一个章节 → insert 到 children 末尾', () => {
  const plans = L.planWrites({
    people: [], effects: [{ product: '磷虾油' }], unclaimed: [],
    anchorsPeople: peopleAnchors, anchorsEffect: effectAnchors,
    lenPeople: 120, lenEffect: 80,
  });
  const p = plans.find(x => x.doc === 'effect');
  assert.strictEqual(p.mode, 'insert');
  assert.strictEqual(p.index, 80);
});

t('找不到章节（新人物 / 新产品）→ 新建章节追加末尾', () => {
  const plans = L.planWrites({
    people: [{ person: '新成员丁' }],
    effects: [{ product: '新产品' }], unclaimed: [],
    anchorsPeople: peopleAnchors, anchorsEffect: effectAnchors,
    lenPeople: 120, lenEffect: 80,
  });
  assert.strictEqual(plans.length, 2);
  assert.ok(plans.every(p => p.mode === 'append' && p.index === -1 && p.isNew));
  assert.deepStrictEqual(plans.map(p => p.chapter).sort(), ['新产品', '新成员丁'].sort());
  assert.ok(plans.every(p => p.heading === L.AUTO_PREFIX + p.chapter));
});

t('第二轮命中上轮新建的章节 → 插进去，不重复建（防文档无限堆积）', () => {
  const next = effectAnchors.concat([
    { idx: 70, title: L.AUTO_PREFIX + '新产品', type: 4 },
    { idx: 75, title: L.AUTO_PREFIX + L.UNATTRIBUTED, type: 4 },
  ]);
  const plans = L.planWrites({
    people: [], effects: [{ product: '新产品' }],
    unclaimed: [{ kind: 'effect', quote: 'q', reason: 1 }],
    anchorsPeople: peopleAnchors, anchorsEffect: next,
    lenPeople: 120, lenEffect: 80,
  });
  assert.ok(plans.length >= 2);
  assert.ok(plans.every(p => p.mode === 'insert'));
  assert.strictEqual(plans.filter(p => p.isNew).length, 0);
});

t('归属不确定 → 单独「未署名故事」章节，不挂任何人名', () => {
  const plans = L.planWrites({
    people: [], effects: [],
    unclaimed: [{ kind: 'effect', quote: '一句真实原话', person: '', reason: 1 }],
    anchorsPeople: peopleAnchors, anchorsEffect: effectAnchors,
    lenPeople: 120, lenEffect: 80,
  });
  const p = plans[0];
  assert.strictEqual(p.chapter, L.UNATTRIBUTED);
  assert.strictEqual(p.anonymous, true);
  assert.strictEqual(p.isNew, true);
  assert.strictEqual(p.unattributed.length, 1);
});

t('已有「未署名故事」章节 → 插进该章节，不重复建', () => {
  const withAnon = effectAnchors.concat([{ idx: 70, title: L.UNATTRIBUTED, type: 4 }]);
  const plans = L.planWrites({
    people: [], effects: [],
    unclaimed: [{ kind: 'effect', quote: '一句真实原话', person: '', reason: 2 }],
    anchorsPeople: peopleAnchors, anchorsEffect: withAnon,
    lenPeople: 120, lenEffect: 80,
  });
  assert.strictEqual(plans[0].mode, 'insert');
  assert.strictEqual(plans[0].index, 80);
  assert.strictEqual(plans[0].isNew, false);
});

t('同一插入位置的多个组合并，避免两次写入互相挤动 index', () => {
  const plans = L.planWrites({
    people: [{ person: '成员甲' }, { person: '成员乙：从老家到城里' }],
    effects: [], unclaimed: [],
    anchorsPeople: [{ idx: 3, title: '成员甲' }, { idx: 40, title: '成员乙' }],
    anchorsEffect: [], lenPeople: 120, lenEffect: 80,
  });
  // 两个不同 person 命中不同锚点时不合并；构造同一锚点的场景用相同 index
  const merged = L.planWrites({
    people: [], effects: [{ product: '干膜' }, { product: '干膜' }], unclaimed: [],
    anchorsPeople: [], anchorsEffect: effectAnchors, lenPeople: 0, lenEffect: 80,
  });
  assert.strictEqual(merged.length, 1);
  assert.strictEqual(merged[0].effects.length, 2);
  assert.ok(plans.length >= 1);
});

t('执行顺序：insert 按 index 降序，新建章节最后', () => {
  const ordered = L.orderPlans([
    { mode: 'append', index: -1 }, { mode: 'insert', index: 10 }, { mode: 'insert', index: 60 },
  ]);
  assert.deepStrictEqual(ordered.map(p => p.mode + ':' + p.index),
    ['insert:60', 'insert:10', 'append:-1']);
});

t('布局：index 取根 children 下标，不用扁平 items 下标（含嵌套块）', () => {
  const items = [
    { block_id: 'root', block_type: 1, children: ['a', 'b', 'x', 'c', 'd'] },
    { block_id: 'a', block_type: 3, heading1: txt('成员甲'), parent_id: 'root' },
    { block_id: 'b', block_type: 2, text: txt('正文一'), parent_id: 'root' },
    { block_id: 'x', block_type: 2, text: txt('嵌套子块'), parent_id: 'a' },
    { block_id: 'c', block_type: 3, heading1: txt('成员乙'), parent_id: 'root' },
    { block_id: 'd', block_type: 2, text: txt('正文二'), parent_id: 'root' },
  ];
  const lay = lib.documentLayout(items);
  assert.strictEqual(lay.children.length, 5);
  const anc = lib.sectionAnchors(lay, [3]);
  assert.deepStrictEqual(anc.map(a => a.idx), [0, 3]);
  assert.deepStrictEqual(anc.map(a => a.title), ['成员甲', '成员乙']);
  // 若误用 items 下标，第二个标题会是 4 而不是 3
  assert.notStrictEqual(anc[1].idx, items.findIndex(b => b.block_id === 'c'));
});

t('块构造：h1/h2/h3 空内容填单空格（1770001 回归）', () => {
  assert.strictEqual(lib.h1('').heading1.elements[0].text_run.content, ' ');
  assert.strictEqual(lib.h2('  ').heading2.elements[0].text_run.content, ' ');
  assert.strictEqual(lib.h3('').heading3.elements[0].text_run.content, ' ');
});

// 真实文档里 8 个产品章节标题形如「序号 + 产品名 + 描述」，产品名被包在长标题中间
const longEffectAnchors = [
  { idx: 48, title: '01｜干膜 使用反馈汇编', type: 4 },
  { idx: 195, title: '02｜党参饮 真实案例', type: 4 },
  { idx: 330, title: '03｜雪莲贴 效果记录', type: 4 },
  { idx: 364, title: '04｜养发乳 变化摘录', type: 4 },
  { idx: 430, title: '05｜五星 故事集', type: 4 },
  { idx: 464, title: '06｜卿春宝 反馈', type: 4 },
  { idx: 488, title: '07｜磷虾油 记录', type: 4 },
  { idx: 501, title: '08｜能量霜 案例', type: 4 },
];

t('长标题里的产品名：旧的严格匹配全落空（这正是会重复建章节的原因）', () => {
  assert.strictEqual(L.matchAnchor(longEffectAnchors, '干膜'), -1);
  assert.strictEqual(L.matchAnchor(longEffectAnchors, '党参饮'), -1);
});

t('产品包含匹配：8 个现有章节全部命中，一一对应', () => {
  const names = ['干膜', '党参饮', '雪莲贴', '养发乳', '五星', '卿春宝', '磷虾油', '能量霜'];
  assert.deepStrictEqual(names.map(n => L.matchProductAnchor(longEffectAnchors, n)),
    [0, 1, 2, 3, 4, 5, 6, 7]);
});

t('产品歧义（两个标题含同一产品）→ 拒绝自动归档，不靠猜', () => {
  const dup = longEffectAnchors.concat([{ idx: 520, title: '09｜干膜 补充记录', type: 4 }]);
  assert.strictEqual(L.matchProductAnchor(dup, '干膜'), -1);
  assert.strictEqual(L.matchProductAnchor(dup, '能量霜'), 7);
});

t('复用现有 8 个产品章节 → 全部 insert、0 新建章节（前后不重复）', () => {
  const names = ['干膜', '党参饮', '雪莲贴', '养发乳', '五星', '卿春宝', '磷虾油', '能量霜'];
  const plans = L.planWrites({
    people: [], effects: names.map(product => ({ product })), unclaimed: [],
    anchorsPeople: peopleAnchors, anchorsEffect: longEffectAnchors,
    lenPeople: 120, lenEffect: 528,
  });
  assert.strictEqual(plans.length, 8);
  assert.ok(plans.every(p => p.mode === 'insert' && !p.isNew));
  assert.strictEqual(L.summarize(plans).newChapters, 0);
});

t('人名仍用严格匹配：短名不会撞进别人的长标题（防串篇）', () => {
  const p = [{ idx: 3, title: '成员甲｜创业与家庭', type: 3 },
    { idx: 40, title: '成员乙｜从老家到城里', type: 3 }];
  const plans = L.planWrites({
    people: [{ person: '成员' }], effects: [], unclaimed: [],
    anchorsPeople: p, anchorsEffect: [], lenPeople: 120, lenEffect: 80,
  });
  assert.strictEqual(plans[0].mode, 'append');   // 判不准就新建，不硬塞进某人章节
  assert.strictEqual(plans[0].isNew, true);
});

t('summarize 只输出数字，不含任何章节名', () => {
  const s = L.summarize(L.planWrites({
    people: [{ person: '成员甲' }, { person: '新成员丁' }],
    effects: [{ product: '干膜' }], unclaimed: [{ kind: 'effect', quote: 'q', reason: 1 }],
    anchorsPeople: peopleAnchors, anchorsEffect: effectAnchors,
    lenPeople: 120, lenEffect: 80,
  }));
  assert.deepStrictEqual(Object.keys(s).sort(),
    ['anonymousGroups', 'groups', 'inserted', 'newChapters', 'unattributedItems']);
  assert.ok(Object.values(s).every(v => typeof v === 'number'));
  assert.ok(!JSON.stringify(s).includes('成员'));
});

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
