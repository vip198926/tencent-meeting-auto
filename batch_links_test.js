/** batch_links.js 纯逻辑回归：链接解析 / 标题派生 / 时间格式 / 脱敏。无需登录态。 */
'use strict';
const assert = require('assert');
const b = require('./batch_links');
const fs = require('fs');
const os = require('os');
const path = require('path');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); pass++; console.log('PASS ' + name); }
  catch (e) { fail++; console.log('FAIL ' + name + ' — ' + e.message); }
}

t('parseLinks 支持换行分隔', () => {
  const got = b.parseLinks('https://meeting.tencent.com/crm/AAAA\nhttps://meeting.tencent.com/crm/BBBB');
  assert.strictEqual(got.length, 2);
});
t('parseLinks 支持逗号与空行', () => {
  const got = b.parseLinks('urlA, urlB,\n urlC \n\n');
  assert.deepStrictEqual(got, ['urlA', 'urlB', 'urlC']);
});
t('parseLinks 空输入返回空数组', () => {
  assert.deepStrictEqual(b.parseLinks('  \n, '), []);
});
t('deriveTitle 用主题，剥离非法文件名字符', () => {
  const s = b.deriveTitle('https://meeting.tencent.com/crm/AAAA', { subject: '晨会/回顾:测试', uuid: 'uuid' });
  assert.strictEqual(s, '晨会回顾测试');
});
t('deriveTitle 无主题时用短码兜底', () => {
  const s = b.deriveTitle('https://meeting.tencent.com/crm/AAAA', { uuid: 'uuid' });
  assert.strictEqual(s, '腾讯会议转写_AAAA');
});
t('fmtTime 忽略无效时间', () => {
  assert.strictEqual(b.fmtTime(0), '');
  assert.strictEqual(b.fmtTime('abc'), '');
});
t('fmtTime 输出月-日 时:分', () => {
  const ms = new Date(2026, 1, 5, 8, 1).getTime();
  assert.strictEqual(b.fmtTime(ms), '02-05 08:01');
});

// 脱敏：公开日志不得出现链接 / 主题 / 会议号
t('日志不含链接与主题（脱敏）', () => {
  const src = fs.readFileSync(path.join(__dirname, 'batch_links.js'), 'utf8');
  const forbidden = ['console.log(`[${i + 1}/${links.length}] ✅ 已上传 链接 ${maskId(input)}'];
  for (const f of forbidden) assert.ok(src.includes(f), '脱敏写法应存在: ' + f);
  assert.ok(!/console\.log\([^)]*(input|meta\.subject|r\.meta)/.test(src.replace(/maskId\(input\)/g, '')),
    '不得直接打印 input / subject');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
