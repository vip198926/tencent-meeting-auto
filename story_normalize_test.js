'use strict';
/**
 * 转写错误对照表归一测试。全部为虚构数据（成员甲/阿乙/干摸等），
 * 不含任何真实姓名、地名、note_id。可安全进入 public 仓库。
 *   运行：node story_normalize_test.js
 */
const assert = require('assert');
const nz = require('./story_normalize');
const llm = require('./story_llm');
const { REASON } = llm;

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('PASS ' + name); pass++; }
  catch (e) { console.log('FAIL ' + name + ' -> ' + e.message); fail++; }
}

const TABLE = `# 转写错误对照表

## 一、平台与品牌

| 机器写的 | 应该是 | 出现份数 | 说明 |
| --- | --- | --- | --- |
| 得银天下 | 德赢天下 | 3 | 口音 |

## 二、人名

| 机器写的 | 应该是 | 出现份数 | 说明 |
| --- | --- | --- | --- |
| 成圆甲 | 成员甲 | 5 | 前后鼻音 |
| 成圆嘉／成员加 | 成员甲 | 2 | |
| 阿乙 | 阿乙老师 | 1 | 尊称 |

## 三、产品

| 机器写的 | 应该是 | 出现份数 | 说明 |
| --- | --- | --- | --- |
| 干摸 | 干膜 | 4 | |
| 雪莲铁 | 雪莲贴 | 2 | |

## 六、同名不同人（比错字更危险）

| 情况 | 怎么分 |
| --- | --- |
| 两个同名的人 | 看地区、看入行前做什么 |

## 八、判定原则

- 阿乙 ≠ 另一个同名的人，看地区区分
`;

const doc = (...b) => '## 逐字稿\n\n' + b.join('\n\n');
const eff = o => Object.assign({
  person: '成员甲', product: '干膜', problem: '睡不好', duration: '三个月',
  result: '睡眠改善', quote: '我用了三个月干膜睡眠明显改善了', speaker: '成员甲', subject: '',
}, o || {});

t('解析：人名并列变体拆分 + 产品映射 + 表头不污染', () => {
  const p = nz.parseAsrTable(TABLE);
  assert.strictEqual(p.personMap.get('成圆甲'), '成员甲');
  assert.strictEqual(p.personMap.get('成圆嘉'), '成员甲');
  assert.strictEqual(p.personMap.get('成员加'), '成员甲');
  assert.strictEqual(p.productMap.get('干摸'), '干膜');
  assert.strictEqual(p.productMap.get('雪莲铁'), '雪莲贴');
  assert.ok(!p.personMap.has('机器写的'));
  assert.ok(!p.productMap.has('机器写的'));
});

t('平台/品牌节不进人名映射（只采纳人名列与产品列）', () => {
  const p = nz.parseAsrTable(TABLE);
  assert.ok(!p.personMap.has('得银天下'));
  assert.strictEqual(p.stats.person, 3);
});

t('同名不同人节不进映射（说明性表格不是词典）', () => {
  const p = nz.parseAsrTable(TABLE);
  assert.ok(!p.personMap.has('两个同名的人'));
  assert.ok(!p.productMap.has('两个同名的人'));
});

t('严格名：出现在 X ≠ … 里的名字不做错写归一、不做模糊合并', () => {
  const p = nz.parseAsrTable(TABLE);
  assert.ok(p.strict.has('阿乙'));
  assert.ok(!p.personMap.has('阿乙'));
  const n = nz.build(TABLE);
  assert.strictEqual(n.same('阿乙', '阿乙老师'), false);
  assert.strictEqual(n.same('阿乙', '阿乙'), true);
});

t('歧义：同一错写对应两个标准名 → 整条弃用，不自动选', () => {
  const md = '## 二、人名\n\n| 机器写的 | 应该是 |\n| --- | --- |\n| 阿丙 | 丙一 |\n| 阿丙 | 丙二 |\n';
  const p = nz.parseAsrTable(md);
  assert.ok(!p.personMap.has('阿丙'));
  assert.ok(p.stats.ambiguous >= 1);
});

t('核心：块标签是错写、LLM 写标准名 → 收录并落标准名', () => {
  const n = nz.build(TABLE);
  const body = doc('[08:23:01] 成圆甲：\n我用了三个月干膜睡眠明显改善了，以前半夜总醒。');
  const v = llm.validate({ effects: [eff()], people: [] }, body, { norm: n });
  assert.strictEqual(v.effects.length, 1);
  assert.strictEqual(v.effects[0].person, '成员甲');
  assert.strictEqual(v.renamed, 0);   // LLM 本来就写对了标准名，不算纠正
});

t('核心：LLM 照抄错写、标签也是错写 → 归一后仍收录，落标准名', () => {
  const n = nz.build(TABLE);
  const body = doc('[08:23:01] 成圆嘉：\n我用了三个月干膜睡眠明显改善了，以前半夜总醒。');
  const v = llm.validate({ effects: [eff({ person: '成圆嘉' })], people: [] }, body, { norm: n });
  assert.strictEqual(v.effects.length, 1);
  assert.strictEqual(v.effects[0].person, '成员甲');
  assert.strictEqual(v.renamed, 1);   // 错写被纠正成标准名
});

t('串篇仍拦得住：错写归一不会把 A 的话送到 B 名下', () => {
  const n = nz.build(TABLE);
  const body = doc(
    '[08:23:01] 成圆甲：\n我用了三个月干膜睡眠明显改善了，以前半夜总醒。',
    '[08:25:10] 阿乙：\n我朋友用了磷虾油体重降了好几斤。');
  const v = llm.validate({ effects: [eff({ person: '阿乙' })], people: [] }, body, { norm: n });
  assert.strictEqual(v.effects.length, 0);
  assert.strictEqual(v.unclaimed[0].reason, REASON.CONFLICT);
});

t('产品错写 → 归到 8 类之一', () => {
  const n = nz.build(TABLE);
  const body = doc('[09:00:00] 成员甲：\n我用了三个月干摸睡眠明显改善了。');
  const v = llm.validate({ effects: [eff({ product: '干摸', quote: '我用了三个月干摸睡眠明显改善了' })], people: [] }, body, { norm: n });
  assert.strictEqual(v.effects.length, 1);
  assert.strictEqual(v.effects[0].product, '干膜');
});

t('原文一个字都没改：quote 仍逐字命中，含错字照样通过', () => {
  const n = nz.build(TABLE);
  const body = doc('[09:10:00] 成圆甲：\n我用了三个月干摸睡眠明显改善了。');
  const v = llm.validate({ effects: [eff({ quote: '我用了三个月干摸睡眠明显改善了' })], people: [] }, body, { norm: n });
  assert.strictEqual(v.effects.length, 1);
  assert.strictEqual(v.effects[0].quote, '我用了三个月干摸睡眠明显改善了');
});

t('预筛：产品错写注入别名后不再被漏召回', () => {
  llm.setProductAliases({ 干摸: '干膜' });
  const body = doc('[09:00:00] 成员甲：\n我用了三个月干摸，睡眠比以前好很多，人也精神了。');
  const s = llm.preselect(body);
  assert.ok(s.picked.length > 0);
  llm.setProductAliases({});   // 复位，避免影响其它用例
});

t('降级：未配置对照表时行为与原逻辑一致', () => {
  const e = nz.empty();
  assert.strictEqual(e.ready, false);
  assert.strictEqual(e.person('成圆甲'), '成圆甲');
  assert.strictEqual(e.product('干摸'), '');
  const body = doc('[08:23:01] 成员甲：\n我用了三个月干膜睡眠明显改善了，以前半夜总醒。');
  const v = llm.validate({ effects: [eff()], people: [] }, body, { norm: e });
  assert.strictEqual(v.effects.length, 1);
  assert.strictEqual(v.renamed, 0);
});

t('不传 norm 也能跑（向后兼容）', () => {
  const body = doc('[08:23:01] 成员甲：\n我用了三个月干膜睡眠明显改善了，以前半夜总醒。');
  const v = llm.validate({ effects: [eff()], people: [] }, body);
  assert.strictEqual(v.effects.length, 1);
});

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
