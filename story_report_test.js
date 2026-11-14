'use strict';
/**
 * 企微日报渲染回归测试（纯函数，不联网、不发消息）。全部虚构数据。
 *   node story_report_test.js
 */
const assert = require('assert');
const { renderDailyReport } = require('./wecom_webhook');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('PASS ' + name); pass++; }
  catch (e) { console.log('FAIL ' + name + ' -> ' + e.message); fail++; }
}

const base = {
  date: '2026-11-14', meetings: 2, ok: 2, fail: 0, skipped: 0, noRecord: 0,
  lines: Array.from({ length: 12 }, (_, i) => `| 10:0${i % 10} | 某会议 ${i} | 转写 | 成功 |`),
  story: '📖 收故事：处理 1 份｜新增效果故事 1 条、人物篇 1 篇',
};
const briefs = [
  '成员甲｜十年销售转自己开店，一年半 1137 万',
  '成员乙｜睡不着三个月，现在睡整觉',
];

t('无概述时行为不变：会议明细最多 12 行', () => {
  const s = renderDailyReport({ ...base });
  const detailLines = s.split('\n').filter(l => l.includes('某会议'));
  assert.strictEqual(detailLines.length, 12);
  assert.ok(!s.includes('· '), '不该出现概述行');
});

t('有概述：概述在「明细」段内、故事汇总行之后', () => {
  const s = renderDailyReport({ ...base, storyDetails: briefs });
  assert.ok(s.includes('—— 明细 ——'));
  const iStory = s.indexOf('📖 收故事');
  const iBrief = s.indexOf('· ' + briefs[0]);
  const iFirstMeeting = s.indexOf('某会议 0');
  assert.ok(iStory > 0 && iBrief > iStory && iFirstMeeting > iBrief, '顺序应为 汇总 → 概述 → 会议明细');
});

t('有概述：会议明细让位压到 6 行', () => {
  const s = renderDailyReport({ ...base, storyDetails: briefs });
  const detailLines = s.split('\n').filter(l => l.includes('某会议'));
  assert.strictEqual(detailLines.length, 6);
});

t('超出上限时提示剩余条数', () => {
  const s = renderDailyReport({ ...base, storyDetails: briefs, storyDetailsMore: 3 });
  assert.ok(s.includes('另 3 条已写入飞书'));
});

t('6 条满额概述 + 6 行明细仍在企微 2048 字节内', () => {
  const long = Array.from({ length: 6 }, (_, i) => `成员${'甲乙丙丁戊己'[i]}｜` + '睡不着的日子'.repeat(4).slice(0, 37));
  const s = renderDailyReport({ ...base, storyDetails: long, storyDetailsMore: 9 });
  assert.ok(Buffer.byteLength(s) <= 2000, '实际 ' + Buffer.byteLength(s) + ' 字节');
});

t('执行失败分支不渲染明细与概述', () => {
  const s = renderDailyReport({ ...base, error: '登录态失效', storyDetails: briefs });
  assert.ok(s.startsWith('⚠️'));
  assert.ok(!s.includes('· '));
});

t('端到端：validate 产出的 brief 能一路渲染进明细', () => {
  const llm = require('./story_llm');
  const body = '[00:01:05] 成员甲：\n我原来做了十年销售。一年半做到 1137 万。现在自己开了店。';
  const v = llm.validate({
    effects: [],
    people: [{
      person: '成员甲', subject: '', brief: '成员甲｜十年销售转自己开店，一年半 1137 万',
      sections: [
        { title: '做了十年销售', excerpts: ['我原来做了十年销售。'] },
        { title: '做到 1137 万', excerpts: ['一年半做到 1137 万。'] },
        { title: '自己开店', excerpts: ['现在自己开了店。'] },
      ],
    }],
  }, body);
  assert.strictEqual(v.people.length, 1, '人物条应通过归属与格式校验');
  const details = v.people.map(p => llm.briefOf('people', p));
  const s = renderDailyReport({ ...base, storyDetails: details });
  assert.ok(s.includes('· 成员甲｜十年销售转自己开店，一年半 1137 万'), s);
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
