#!/usr/bin/env node
// ask-preview-length.mjs 的案例表：node test-ask-preview-length.mjs（全過離開碼 0）
process.env.HOOK_NOLOG = '1';
const { run, visualLines, MAX_LINES } = await import('./ask-preview-length.mjs');

let fail = 0;
const ok = (name, cond) => { if (!cond) { fail++; console.log(`✗ ${name}`); } else console.log(`✓ ${name}`); };
const ask = (...previews) => run({ tool_input: { questions: [{ question: '選哪個？', options: previews.map((p, i) => ({ label: `選項${i}`, description: 'x', preview: p })) }] } });
const denied = (r) => r?.hookSpecificOutput?.permissionDecision === 'deny';
const lines = (n, s = 'abc') => Array.from({ length: n }, () => s).join('\n');

ok('沒有 preview 放行', ask(undefined, undefined) === null);
ok('8 行放行', ask(lines(8)) === null);
ok('9 行擋', denied(ask(lines(9))));
ok('尾端空行不算', ask(lines(8) + '\n\n\n') === null);
ok('只有一個選項超過也擋', denied(ask(lines(2), lines(12))));
ok('48 個半形字是 1 行', visualLines('a'.repeat(48)) === 1);
ok('49 個半形字折成 2 行', visualLines('a'.repeat(49)) === 2);
ok('24 個中文字是 1 行、25 個是 2 行', visualLines('中'.repeat(24)) === 1 && visualLines('中'.repeat(25)) === 2);
ok('4 行長中文（各折 3 行）＝ 12 行，擋', denied(ask(lines(4, '中'.repeat(60)))));
ok('空行算 1 行', visualLines('a\n\nb') === 3);
ok('擋下的理由講出哪一個選項', /選項1」12 行/.test(ask(lines(2), lines(12)).hookSpecificOutput.permissionDecisionReason));
ok('壞輸入放行', run({}) === null && run({ tool_input: { questions: 'x' } }) === null);
ok(`上限是 ${MAX_LINES}`, MAX_LINES === 8);

if (fail) { console.log(`${fail} 個失敗`); process.exit(1); }
console.log('全過');
