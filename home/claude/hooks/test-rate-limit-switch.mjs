#!/usr/bin/env node
// rate-limit-switch 的案例表：node test-rate-limit-switch.mjs（全過離開碼 0）。
// 不碰真的 iTerm／Keychain／handoff-open：換得了沒、換到哪、開交接都用替身，狀態檔與交接單寫在暫存目錄。
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const { run, lastPrompt, HANDOFF_OPEN, PANE_STATE } = await import('./rate-limit-switch.mjs');
import { existsSync } from 'node:fs';
const { limitTarget, TO_LIMIT } = await import('../tools/acct-drain.mjs');
const { ROUTES, checksFor } = await import('./dispatch.mjs');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${extra && !cond ? '  — ' + extra : ''}`);
};

const T = mkdtempSync(join(tmpdir(), 'rls-'));
const transcript = join(T, 't.jsonl');
writeFileSync(transcript, [
  { type: 'user', message: { content: '舊的那則' } },
  { type: 'user', message: { content: [{ type: 'text', text: '<system-reminder>附帶的提醒</system-reminder>' }, { type: 'text', text: '把 W5 做完' }] } },
  { type: 'assistant', message: { content: [{ type: 'text', text: '好' }] } },
  { type: 'user', message: { content: [{ type: 'tool_result', content: 'ok' }] } },
  { type: 'user', message: { content: '<system-reminder>不是使用者</system-reminder>' } },
  { type: 'user', isCompactSummary: true, message: { content: 'This session is being continued from a previous conversation…' } },
  { type: 'user', message: { content: [{ type: 'text', text: '[Request interrupted by user]' }] } },
].map((o) => JSON.stringify(o)).join('\n') + '\n');

const INPUT = {
  session_id: 'abcdef12-3456', hook_event_name: 'StopFailure', error: 'rate_limit', error_details: '429 Too Many Requests',
  last_assistant_message: 'API Error: Rate limit reached', cwd: '/tmp/somewhere', transcript_path: transcript,
};
const BRUCE = { from: 'bruce', to: 'peter', toDir: '/x/.claude-work', toPct: 40 };

// 每個案例一份乾淨的狀態檔與交接單目錄；回傳 open／done 有沒有被叫、叫的參數
let n = 0;
function go(input, o = {}) {
  const dir = join(T, `c${n++}`), calls = { open: [], done: 0, log: [] };
  const out = run(input, {
    env: { ITERM_SESSION_ID: 'w0t0p0:PANE', CLAUDE_CONFIG_DIR: '/x/.claude', ...(o.env || {}) },
    target: o.target || (() => BRUCE), here: o.here || (() => true), findPid: () => 4242,
    open: o.open || ((...a) => calls.open.push(a)), done: () => { calls.done++; },
    state: o.state || join(dir, 'state.json'), notes: join(dir, 'notes'), log: (x) => calls.log.push(x), off: join(dir, 'off'),
  });
  return { out, calls, dir };
}

// 會換
{
  const r = go(INPUT);
  ok('rate_limit＋bruce＋換得了 → 叫 handoff-open --to peter', r.calls.open.length === 1 && r.calls.open[0][2] === 'peter');
  ok('帶 cwd 與 claude 的 pid 給 handoff-open', r.calls.open[0]?.[1] === '/tmp/somewhere' && r.calls.open[0]?.[3] === 4242);
  ok('handoff-open 之後補寫 pane done', r.calls.done === 1);
  ok('輸出一律 null（StopFailure 的輸出本來就被忽略）', r.out === null);
  const body = readFileSync(r.calls.open[0][0], 'utf8');
  ok('交接單附使用者最後一則訊息', body.includes('> 把 W5 做完'), body.slice(0, 300));
  ok('交接單附 transcript 路徑與錯誤字串', body.includes(transcript) && body.includes('Rate limit reached'));
}

// 不換
for (const [name, input] of [
  ['不是 rate_limit（overloaded）', { ...INPUT, error: 'overloaded' }],
  ['不是 rate_limit（billing_error）', { ...INPUT, error: 'billing_error' }],
  ['不是 StopFailure（Stop）', { ...INPUT, hook_event_name: 'Stop' }],
  ['沒有 session_id', { ...INPUT, session_id: undefined }],
]) {
  const r = go(input);
  ok(`${name} → 不換`, r.calls.open.length === 0 && r.calls.done === 0);
}
{
  const r = go(INPUT, { target: () => null });
  ok('limitTarget 說不換（peter 撞牆）→ 不換、不寫交接單', r.calls.open.length === 0 && r.calls.log[0]?.skip);
}
{
  const r = go(INPUT, { here: () => false });
  ok('換不了的地方（tmux／claude -p）→ 不叫 handoff-open', r.calls.open.length === 0 && r.calls.done === 0);
  const m = JSON.parse(readFileSync(join(r.dir, 'notes', readdirSync(join(r.dir, 'notes')).find((f) => f.endsWith('Z.json'))), 'utf8'));
  ok('換不了的地方 → 寫 gaveUp 標記叫人手動換', /換不了/.test(m.gaveUp) && m.handoff?.endsWith('-rate-limit.md'));
  const p = go(INPUT, { here: () => false, target: () => null });
  ok('不用換的（peter）在換不了的地方也不叫人', !existsSync(join(p.dir, 'notes')));
}
{
  const state = join(T, 'shared-state.json');
  const a = go(INPUT, { state }), b = go({ ...INPUT, session_id: 'zzzzzzzz-new' }, { state });
  ok('同一格 30 分鐘內第二次撞牆不再換（不迴圈）', a.calls.open.length === 1 && b.calls.open.length === 0);
  const c = go(INPUT, { state, env: { ITERM_SESSION_ID: 'w0t1p0:OTHER' } });
  ok('別格照樣換', c.calls.open.length === 1);
  writeFileSync(state, JSON.stringify({ 'w0t0p0:PANE': new Date(Date.now() - 31 * 60_000).toISOString() }));
  ok('30 分鐘後同一格又撞牆會再換', go(INPUT, { state }).calls.open.length === 1);
}
{
  const state = join(T, 'fail-state.json');
  const a = go(INPUT, { state, open: () => { throw Object.assign(new Error('x'), { stderr: 'handoff-open: 這裡換不了帳號' }); } });
  ok('handoff-open 失敗 → 記 log、照樣補 pane done（逾時時背景程序可能已經在等）', a.calls.done === 1 && /換不了/.test(a.calls.log[0]?.err || ''));
  const marks = readdirSync(join(a.dir, 'notes')).filter((f) => /^[\dT-]+Z\.json$/.test(f));
  const m = marks.length === 1 ? JSON.parse(readFileSync(join(a.dir, 'notes', marks[0]), 'utf8')) : {};
  ok('handoff-open 失敗 → 寫 handoff-watch 認得的 gaveUp 標記', /換不了/.test(m.gaveUp || '') && m.created && m.handoff?.endsWith('-rate-limit.md'), marks.join());
  const t = go(INPUT, { open: () => { throw Object.assign(new Error('spawnSync node ETIMEDOUT'), { code: 'ETIMEDOUT', signal: 'SIGTERM' }); } });
  const tm = JSON.parse(readFileSync(join(t.dir, 'notes', readdirSync(join(t.dir, 'notes')).find((f) => f.endsWith('Z.json'))), 'utf8'));
  ok('handoff-open 逾時 → 標記寫「可能已經在換」，不說失敗', /逾時/.test(tm.gaveUp) && !/失敗/.test(tm.gaveUp), tm.gaveUp);
  const w = go(INPUT, { state: join(T, 'warn.json'), open: () => { throw Object.assign(new Error('x'), { stderr: '(node:1) Warning: something\nhandoff-open: 帳號清單裡沒有 peter' }); } });
  ok('stderr 第一行是 node 警告也抓得到真正的原因', /帳號清單裡沒有 peter/.test(w.calls.log.at(-1)?.err || ''), JSON.stringify(w.calls.log));
  ok('成功時不寫 gaveUp 標記', readdirSync(join(go(INPUT).dir, 'notes')).every((f) => !f.endsWith('.json')));
  ok('handoff-open 失敗也算換過（不會每次撞牆都再開一份）', go(INPUT, { state }).calls.open.length === 0);
}
{
  const dir = join(T, 'offcase'); const calls = [];
  run(INPUT, { env: {}, target: () => BRUCE, here: () => true, findPid: () => 1, open: (...a) => calls.push(a), done: () => {},
    state: join(dir, 's.json'), notes: dir, log: () => {}, off: transcript });
  ok('逃生門 .off 在就不換', calls.length === 0);
}

// lastPrompt
ok('lastPrompt 跳過工具結果、系統提醒、compact 摘要與 ESC 中斷', lastPrompt(transcript) === '把 W5 做完', lastPrompt(transcript));
ok('lastPrompt 讀不到檔回 null', lastPrompt(join(T, 'nope.jsonl')) === null);

// limitTarget：只有 bruce→peter，peter 撞牆不反向
const ACC = [
  { id: 'bruce', dir: '/a', quota_id: 'qb', tier: 'max20' },
  { id: 'peter', dir: '/b', quota_id: 'qp', tier: 'max5' },
];
// 替身：目錄 /a 登 bruce、/b 登 peter（真的 A.actual 會去讀 Keychain）
const who = (accs, d) => accs.find((a) => a.dir === d) || null;
const lt = (dir, q, o = {}) => limitTarget(dir, { accounts: ACC, q, actual: who, dirFor: (accs, a) => a.dir, ...o });
const q = (b, p) => ({ qb: { weekly: { percent: b } }, qp: { weekly: { percent: p } } });
ok('bruce 撞牆 → 換到 peter（不看 90% 門檻：bruce 才 30% 也換）', lt('/a', q(30, 40))?.to === 'peter');
ok('peter 撞牆 → 不反向換回 bruce', lt('/b', q(10, 100)) === null);
ok(`peter 也 ≥ ${TO_LIMIT}% → 不換`, lt('/a', q(100, 96)) === null);
ok('額度快取讀不到（q=null）→ 照樣換', lt('/a', null)?.to === 'peter');
ok('沒有任何目錄登 peter → 不換', lt('/a', q(100, 10), { dirFor: () => null }) === null);
ok('這個目錄登誰認不出來 → 不換', lt('/zzz', q(100, 10)) === null);
ok('TO_LIMIT 還是 95（沒動門檻）', TO_LIMIT === 95);

// 真的會叫到的兩支檔案在那裡（替身測不到路徑寫錯）
ok('HANDOFF_OPEN 指到 home/bin/handoff-open', existsSync(HANDOFF_OPEN) && HANDOFF_OPEN.endsWith('/home/bin/handoff-open'), HANDOFF_OPEN);
ok('PANE_STATE 檔存在', existsSync(PANE_STATE));

// dispatch 路由
ok('dispatch 的 StopFailure 會跑 rate-limit-switch', checksFor('StopFailure', INPUT).map((c) => c.name).join() === 'rate-limit-switch');
ok('Stop 路由沒有 rate-limit-switch', !ROUTES.Stop.includes('rate-limit-switch'));

rmSync(T, { recursive: true, force: true });
console.log(`\n  ${pass} 過 · ${fail} 失敗`);
process.exit(fail ? 1 : 0);
