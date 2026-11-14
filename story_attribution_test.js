'use strict';
/**
 * 归属门禁回归测试。全部为虚构数据：成员甲/乙/丙、甲哥等均为假名，
 * 不含任何真实姓名、会议标题、原话或资源 ID。可安全进入 public 仓库。
 *   运行：node story_attribution_test.js
 */
const assert = require('assert');
const llm = require('./story_llm');
const { REASON } = llm;

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('PASS ' + name); pass++; }
  catch (e) { console.log('FAIL ' + name + ' -> ' + e.message); fail++; }
}

const doc = (...blocks) => '## 逐字稿\n\n' + blocks.join('\n\n');
const eff = o => Object.assign({
  person: '成员甲', product: '干膜', problem: '睡不好', duration: '三个月',
  result: '睡眠改善', quote: '我用了三个月干膜睡眠明显改善了', speaker: '成员甲', subject: '',
}, o || {});

const A = '[08:23:01] 成员甲：\n我用了三个月干膜睡眠明显改善了，以前半夜总醒。';
const B = '[08:25:10] 成员乙：\n我朋友用了磷虾油体重降了好几斤，这是听他说的。';
const C = '[08:27:00] 成员甲：\n我在长沙朋友不多，那时候真的很难。';
const Q = '我用了三个月干膜睡眠明显改善了';

t('块解析：说话人、时间戳、块数', () => {
  const bs = llm.parseSpeakerBlocks(doc(A, B, C));
  assert.strictEqual(bs.length, 3);
  assert.deepStrictEqual(bs.map(b => b.speaker), ['成员甲', '成员乙', '成员甲']);
  assert.ok(bs.every(b => b.stamp.startsWith('[')));
});

t('L1：块标签与 person 一致 → 正常收录', () => {
  const v = llm.validate({ effects: [eff()], people: [] }, doc(A, B));
  assert.strictEqual(v.effects.length, 1);
  assert.strictEqual(v.effects[0].speaker, '成员甲');
  assert.strictEqual(v.unclaimed.length, 0);
});

t('核心：A 的话被填成 B → 拦下，且不把错名写进待认领', () => {
  const body = doc(A, B);
  // 证明旧的「全文包含」校验确实会放过这条：quote 在全文里，B 的名字也在全文里
  const norm = s => String(s || '').replace(/\s+/g, '');
  assert.ok(norm(body).includes(norm(Q)) && norm(body).includes(norm('成员乙')));
  const v = llm.validate({ effects: [eff({ person: '成员乙' })], people: [] }, body);
  assert.strictEqual(v.effects.length, 0);
  assert.strictEqual(v.unclaimed.length, 1);
  assert.strictEqual(v.unclaimed[0].reason, REASON.CONFLICT);
  assert.strictEqual(v.unclaimed[0].person, '');
  assert.strictEqual(v.unclaimed[0].quote, Q);
  assert.strictEqual(v.rejected.conflict, 1);
});

t('转述第三人（subject 非空）→ 待认领，不算说话人自述', () => {
  const v = llm.validate({ effects: [eff({ subject: '成员丙' })], people: [] }, doc(A, B));
  assert.strictEqual(v.effects.length, 0);
  assert.strictEqual(v.unclaimed[0].reason, REASON.AMBIGUOUS);
});

t('无说话人标签 → 待认领（不猜）', () => {
  const noTag = '没有时间戳也没有名字的一段话，说了三个月干膜。';
  const v = llm.validate({ effects: [eff({ quote: '没有时间戳也没有名字的一段话' })], people: [] }, doc(noTag));
  assert.strictEqual(v.effects.length, 0);
  assert.strictEqual(v.unclaimed[0].reason, REASON.NO_SPEAKER);
});

t('原话跨两个不同说话人的块 → 待认领，不硬归其中一人', () => {
  const b1 = '[09:00:00] 成员甲：我那会儿';
  const b2 = '[09:00:05] 成员乙：用了三个月干膜睡眠明显改善了';
  const v = llm.validate({ effects: [eff({ quote: '我那会儿用了三个月干膜睡眠明显改善了' })], people: [] }, doc(b1, b2));
  assert.strictEqual(v.effects.length, 0);
  assert.strictEqual(v.unclaimed[0].reason, REASON.AMBIGUOUS);
});

t('原话编造（未逐字命中）→ 唯一允许静默丢弃的情形', () => {
  const v = llm.validate({ effects: [eff({ quote: '这句话根本不在逐字稿里面啊' })], people: [] }, doc(A));
  assert.strictEqual(v.effects.length, 0);
  assert.strictEqual(v.unclaimed.length, 0);
  assert.strictEqual(v.rejected.quote, 1);
});

t('收全：产品不在白名单但原话真实 → 保留到待认领，不静默丢', () => {
  const v = llm.validate({ effects: [eff({ product: '未知类产品' })], people: [] }, doc(A));
  assert.strictEqual(v.effects.length, 0);
  assert.strictEqual(v.unclaimed.length, 1);
  assert.strictEqual(v.unclaimed[0].reason, REASON.FORMAT);
  assert.strictEqual(v.unclaimed[0].quote, Q);
});

t('收全：字段缺失但原话真实 → 保留到待认领', () => {
  const v = llm.validate({ effects: [eff({ duration: '' })], people: [] }, doc(A));
  assert.strictEqual(v.unclaimed.length, 1);
  assert.strictEqual(v.unclaimed[0].reason, REASON.FORMAT);
});

t('老人物出新会议：两场独立判定、互不串扰（无状态）', () => {
  const d1 = doc(A);
  const d2 = doc('[11:10:00] 成员甲：\n这次是另一场会，我又用了三个月干膜睡眠明显改善了。');
  const q2 = '我又用了三个月干膜睡眠明显改善了';
  const v1 = llm.validate({ effects: [eff()], people: [] }, d1);
  const v2 = llm.validate({ effects: [eff({ quote: q2 })], people: [] }, d2);
  assert.strictEqual(v1.effects.length, 1);
  assert.strictEqual(v2.effects.length, 1);
  assert.strictEqual(v2.effects[0].speaker, '成员甲');
});

t('昵称与全名宽松归一 → 仍可收录', () => {
  const nick = '[12:00:00] 甲哥：\n我用了三个月干膜睡眠明显改善了，真的。';
  const v = llm.validate({ effects: [eff({ person: '甲哥老师' })], people: [] }, doc(nick));
  assert.strictEqual(v.effects.length, 1);
});

t('产品别名归一仍然生效', () => {
  const v = llm.validate({ effects: [eff({ product: '轻能减脂' })], people: [] }, doc(A));
  assert.strictEqual(v.effects.length, 1);
  assert.strictEqual(v.effects[0].product, '五星');
});

const P1 = '[10:00:00] 成员甲：我以前在老家做木工，干了十几年。';
const P2 = '[10:01:00] 成员甲：后来生意不好做，就出来了。';
const P3 = '[10:02:00] 成员甲：现在带着一帮人一起干，慢慢好起来了。';
const line = () => ({
  person: '成员甲', subject: '', sections: [
    { title: '从哪来', excerpts: ['我以前在老家做木工，干了十几年'] },
    { title: '遇到什么坎', excerpts: ['后来生意不好做，就出来了'] },
    { title: '现在怎样', excerpts: ['现在带着一帮人一起干，慢慢好起来了'] },
  ],
});

t('人物线：3 节全部块级绑定一致 → 正常收录', () => {
  const v = llm.validate({ effects: [], people: [line()] }, doc(P1, P2, P3));
  assert.strictEqual(v.people.length, 1);
  assert.strictEqual(v.people[0].sections.length, 3);
  assert.strictEqual(v.unclaimed.length, 0);
});

t('人物线：空标题小节不产生空块（1770001 回归）', () => {
  const p = line(); p.sections[0].title = '';
  const v = llm.validate({ effects: [], people: [p] }, doc(P1, P2, P3));
  assert.strictEqual(v.people.length, 0);
  assert.ok(v.rejected.fields >= 1);
});

t('人物线：摘录属于甲却填成乙 → 全部待认领，不写人物章节', () => {
  const p = line(); p.person = '成员乙';
  const v = llm.validate({ effects: [], people: [p] }, doc(P1, P2, P3));
  assert.strictEqual(v.people.length, 0);
  assert.ok(v.unclaimed.length >= 3);
  assert.ok(v.unclaimed.every(u => u.reason === REASON.CONFLICT && u.person === ''));
});

t('待认领去重：同一原话不重复入列', () => {
  const v = llm.validate({ effects: [eff({ person: '成员乙' }), eff({ person: '成员丙' })], people: [] }, doc(A, B));
  assert.strictEqual(v.unclaimed.length, 1);
});

t('preselect 仍能在带 ## 逐字稿 前缀时正常召回', () => {
  const s = llm.preselect(doc(A, B, C));
  assert.ok(s.picked.length > 0);
  assert.ok(s.chunkCount >= 3);
});

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
