'use strict';
/**
 * 企微明细「一句话概述」回归测试。全部虚构数据，可安全进入 public 仓库。
 *   node story_brief_test.js
 *
 * 守护的核心：概述是给内部群看的，但它由模型自由生成 →
 * 必须先过数字白名单（每个数字都要在原文出现过），过不了就弃用、退模板，
 * 绝不能让「一年半」被写成「18 个月」这种东西流进群消息。
 */
const assert = require('assert');
const llm = require('./story_llm');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('PASS ' + name); pass++; }
  catch (e) { console.log('FAIL ' + name + ' -> ' + e.message); fail++; }
}

const BODY = [
  '[00:01:05] 成员甲：',
  '我原来在厂里做了十年销售，一年半做到 1137 万。我老婆总说我不管孩子。现在我自己开了店。',
  '',
  '[00:03:20] 成员乙：',
  '我用了三个月，睡不着的问题好了很多。',
].join('\n');

function effect(over) {
  return Object.assign({
    person: '成员乙', product: '干膜',
    problem: '睡不着', duration: '三个月', result: '睡眠好了很多',
    quote: '我用了三个月，睡不着的问题好了很多。',
    speaker: '成员乙', subject: '', brief: '',
  }, over || {});
}
function person(over) {
  return Object.assign({
    person: '成员甲', subject: '', brief: '',
    sections: [
      { title: '十年销售', excerpts: ['我原来在厂里做了十年销售，一年半做到 1137 万。'] },
      { title: '家里的埋怨', excerpts: ['我老婆总说我不管孩子。'] },
      { title: '自己开店', excerpts: ['现在我自己开了店。'] },
    ],
  }, over || {});
}

t('brief 数字与原文一致 → 保留', () => {
  const v = llm.validate({ effects: [effect({ brief: '成员乙｜三个月睡不好好了，没数字' })], people: [] }, BODY);
  assert.strictEqual(v.effects.length, 1);
  assert.strictEqual(v.effects[0].brief, '成员乙｜三个月睡不好好了，没数字');
  assert.strictEqual(v.rejected.brief, 0);
});

t('brief 数字原文没有 → 整句弃用（不留半句）', () => {
  const v = llm.validate({ effects: [effect({ brief: '成员乙｜花了 5 个月才睡着' })], people: [] }, BODY);
  assert.strictEqual(v.effects[0].brief, '');
  assert.strictEqual(v.rejected.brief, 1);
});

t('brief 把「一年半」换算成「18 个月」→ 弃用', () => {
  const v = llm.validate({ effects: [], people: [person({ brief: '成员甲｜十年销售，18 个月做到 1137 万' })] }, BODY);
  assert.strictEqual(v.people[0].brief, '');
  assert.strictEqual(v.rejected.brief, 1);
});

t('brief 数字对得上（1137）→ 人物条保留概述', () => {
  const v = llm.validate({ effects: [], people: [person({ brief: '成员甲｜十年销售转自己开店，一年半 1137 万' })] }, BODY);
  assert.strictEqual(v.people[0].brief, '成员甲｜十年销售转自己开店，一年半 1137 万');
  assert.strictEqual(v.rejected.brief, 0);
});

t('brief 数字是原文数字的子串（300 vs 3000）→ 仍算没出现', () => {
  const body = '[00:01:05] 成员丙：\n去年做了 3000 单。';
  const v = llm.validate({
    effects: [{
      person: '成员丙', product: '干膜', problem: '身体差', duration: '一年',
      result: '做起来了', quote: '去年做了 3000 单。', brief: '成员丙｜做到 300 单',
    }], people: [],
  }, body);
  assert.strictEqual(v.effects[0].brief, '');
  assert.strictEqual(v.rejected.brief, 1);
});

t('brief 带引号 → 清掉外层引号', () => {
  const v = llm.validate({ effects: [effect({ brief: '「成员乙｜三个月睡好了」' })], people: [] }, BODY);
  assert.strictEqual(v.effects[0].brief, '成员乙｜三个月睡好了');
});

t('brief 超长 → 截到 40 字', () => {
  const long = '成员乙｜' + '睡不着的日子'.repeat(12);
  const v = llm.validate({ effects: [effect({ brief: long })], people: [] }, BODY);
  assert.strictEqual(v.effects[0].brief.length, 40);
});

t('没给 brief → 空串，不报弃用', () => {
  const v = llm.validate({ effects: [effect()], people: [person()] }, BODY);
  assert.strictEqual(v.effects[0].brief, '');
  assert.strictEqual(v.people[0].brief, '');
  assert.strictEqual(v.rejected.brief, 0);
});

t('briefOf 模板兜底：效果条用 问题 → 结果', () => {
  const s = llm.briefOf('effect', { person: '成员乙', problem: '睡不着', duration: '三个月', result: '睡眠好了很多', brief: '' });
  assert.strictEqual(s, '成员乙｜睡不着 → 睡眠好了很多');
});

t('briefOf 模板兜底：人物条用首节标题', () => {
  const s = llm.briefOf('people', { person: '成员甲', brief: '', sections: [{ title: '十年销售', excerpts: [] }] });
  assert.strictEqual(s, '成员甲｜十年销售');
});

t('briefOf 有 brief 时优先用 brief', () => {
  const s = llm.briefOf('effect', { person: '成员乙', problem: '睡不着', result: '好了', brief: '成员乙｜三个月睡好了' });
  assert.strictEqual(s, '成员乙｜三个月睡好了');
});

t('briefOf 上限 40 字', () => {
  const s = llm.briefOf('effect', { person: '甲', problem: '很长的'.repeat(20), result: '也很长的'.repeat(20), brief: '' });
  assert.ok(s.length <= 40, '实际 ' + s.length);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
