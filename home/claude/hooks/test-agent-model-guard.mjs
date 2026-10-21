#!/usr/bin/env node
// agent-model-guard 的案例表：node test-agent-model-guard.mjs（全過離開碼 0）
// 扇出檢查要讀 transcript，所以每個案例都在暫存目錄造一份「一則 assistant 訊息帶 N 個 Agent 呼叫」的 jsonl，
// 格式照真的 transcript：同一個 message.id、每個 tool_use 各寫一行。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run, FANOUT_MAX } from './agent-model-guard.mjs';

process.env.HOOK_NOLOG = '1';
const HERE = dirname(fileURLToPath(import.meta.url));
const T = mkdtempSync(join(tmpdir(), 'agent-guard-test-'));
process.on('exit', () => { try { rmSync(T, { recursive: true, force: true }); } catch {} });
let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${extra && !cond ? '  — ' + extra : ''}`);
};
const deny = (j) => j?.hookSpecificOutput?.permissionDecision === 'deny';
const reason = (j) => j?.hookSpecificOutput?.permissionDecisionReason ?? '';

let seq = 0;
/** 造一份 transcript：前面一則別的訊息（干擾），接著目標訊息帶 inputs 這些 Agent 呼叫。回傳 { path, ids }。 */
function transcript(inputs, { noise = [], tool = 'Agent', pad = 0 } = {}) {
  const p = join(T, `t${seq++}.jsonl`);
  const lines = [];
  for (let k = 0; k < pad; k++) lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: 'x'.repeat(1000) } }));
  lines.push(JSON.stringify({ type: 'user', message: { role: 'user', content: '做事' } }));
  noise.forEach((inp, k) => lines.push(JSON.stringify({ type: 'assistant', message: { id: 'msg_old', role: 'assistant',
    content: [{ type: 'tool_use', id: `toolu_old${k}`, name: 'Agent', input: inp }] } })));
  lines.push(JSON.stringify({ type: 'assistant', message: { id: 'msg_now', role: 'assistant', content: [{ type: 'text', text: '派工' }] } }));
  const ids = inputs.map((inp, k) => {
    const id = `toolu_now${k}`;
    lines.push(JSON.stringify({ type: 'assistant', message: { id: 'msg_now', role: 'assistant',
      content: [{ type: 'tool_use', id, name: tool, input: inp }] } }));
    return id;
  });
  writeFileSync(p, lines.join('\n') + '\n');
  return { path: p, ids };
}
const call = (tr, k, inputs) => run({ hook_event_name: 'PreToolUse', tool_name: 'Agent',
  tool_input: inputs[k], tool_use_id: tr.ids[k], transcript_path: tr.path });
const many = (n, inp) => Array.from({ length: n }, () => ({ prompt: 'p', ...inp }));
const allDeny = (inputs) => { const tr = transcript(inputs); return inputs.every((_, k) => deny(call(tr, k, inputs))); };
const noneDeny = (inputs) => { const tr = transcript(inputs); return inputs.every((_, k) => !deny(call(tr, k, inputs))); };
const GPO = { subagent_type: 'general-purpose', model: 'opus' };

// ── 扇出上限 ──
ok(`上限是 3`, FANOUT_MAX === 3);
ok('同一則訊息 4 個 opus general-purpose：每一個都擋', allDeny(many(4, GPO)));
ok('同一則訊息 10 個：每一個都擋', allDeny(many(10, GPO)));
ok('同一則訊息 3 個 opus general-purpose：放行', noneDeny(many(3, GPO)));
ok('1 個 opus general-purpose：放行', noneDeny(many(1, GPO)));
{
  const inputs = many(4, GPO); const tr = transcript(inputs); const r = call(tr, 0, inputs);
  ok('擋下訊息講數量、上限、改派 writer', /4 個/.test(reason(r)) && /上限 3/.test(reason(r)) && reason(r).includes('writer'), reason(r));
}
ok('不寫類型＋opus 也算 general-purpose（4 個擋）', allDeny(many(4, { model: 'opus' })));
ok('claude 類型＋opus 也算（4 個擋）', allDeny(many(4, { subagent_type: 'claude', model: 'opus' })));
ok('大小寫、空白、完整模型 ID 也算（4 個擋）', allDeny([
  { prompt: 'p', subagent_type: ' General-Purpose ', model: 'Opus' },
  { prompt: 'p', subagent_type: 'general-purpose', model: 'claude-opus-5-5' },
  { prompt: 'p', subagent_type: 'general-purpose', model: 'opus' },
  { prompt: 'p', subagent_type: 'general-purpose', model: 'opus' }]));
ok('3 個 opus＋其他 sonnet／writer／reviewer：放行（只數 opus general-purpose）', noneDeny([
  ...many(3, GPO), ...many(2, { subagent_type: 'general-purpose', model: 'sonnet' }),
  ...many(3, { subagent_type: 'writer' }), { prompt: 'p', subagent_type: 'reviewer' }]));
ok('同一則訊息 6 個帶 model 的 writer（sonnet）：放行', noneDeny(many(6, { subagent_type: 'writer', model: 'sonnet' })));
ok('同一則訊息 6 個不帶 model 的 writer：放行', noneDeny(many(6, { subagent_type: 'writer' })));
ok('同一則訊息 5 個 fork：放行', noneDeny(many(5, { subagent_type: 'fork', model: 'opus' })));
ok('同一則訊息 5 個 reviewer＋opus：放行（具名子代理不數）', noneDeny(many(5, { subagent_type: 'reviewer', model: 'opus' })));
{
  // 前一則訊息已經派過 3 個、這一則再派 3 個：分批派是被鼓勵的寫法，不能合併計算
  const inputs = many(3, GPO); const tr = transcript(inputs, { noise: many(3, GPO) });
  ok('跨訊息不累計（上一則 3 個＋這一則 3 個放行）', inputs.every((_, k) => !deny(call(tr, k, inputs))));
}
{
  const inputs = many(5, GPO);
  ok('讀不到 transcript：放行（不確定不擋）', !deny(run({ tool_input: inputs[0], tool_use_id: 'toolu_x', transcript_path: join(T, 'nope.jsonl') })));
  ok('沒有 tool_use_id：放行', !deny(run({ tool_input: inputs[0], transcript_path: transcript(inputs).path })));
  const tr = transcript(inputs);
  ok('tool_use_id 不在 transcript 裡（例如子代理的呼叫）：放行', !deny(run({ tool_input: inputs[0], tool_use_id: 'toolu_other', transcript_path: tr.path })));
}

{
  // 小檔案整份讀進來時第一行是完整的，不能丟（審查意見：丟了會 4 個算成 3 個）
  const inputs = many(4, GPO);
  const p = join(T, 'first.jsonl');
  const ids = inputs.map((_, k) => `toolu_f${k}`);
  writeFileSync(p, inputs.map((inp, k) => JSON.stringify({ type: 'assistant', message: { id: 'msg_f', content: [{ type: 'tool_use', id: ids[k], name: 'Agent', input: inp }] } })).join('\n') + '\n');
  ok('transcript 第一行就是目標訊息：照樣數到 4 個擋', inputs.every((_, k) => deny(run({ tool_input: inputs[k], tool_use_id: ids[k], transcript_path: p }))));
}
{
  const inputs = many(4, { ...GPO, subagent_type: 'general-purpose' });
  const tr = transcript(inputs, { tool: 'Task' });
  ok('舊版工具名 Task 也數（4 個擋）', inputs.every((_, k) => deny(run({ tool_input: inputs[k], tool_use_id: tr.ids[k], transcript_path: tr.path }))));
  const big = transcript(inputs, { pad: 3000 });   // 約 3MB：尾巴從中間切
  ok('超過 2MB 的 transcript 從尾巴讀：照樣擋', inputs.every((_, k) => deny(call(big, k, inputs))));
}
{
  const inputs = many(4, GPO); const tr = transcript(inputs);
  const r = reason(call(tr, 0, inputs));
  ok('擋下訊息講明 fork 也跑 Opus、帶整段脈絡（不能當成省錢的繞法）', /fork 也跑 Opus/.test(r), r);
}

{
  // 審查實測：檔案剛好 2MB、第一行就是目標訊息 → 舊寫法把完整的第一行丟掉，4 算成 3
  const inputs = many(4, GPO);
  const ids = inputs.map((_, k) => `toolu_e${k}`);
  const body = inputs.map((inp, k) => JSON.stringify({ type: 'assistant', message: { id: 'msg_e', content: [{ type: 'tool_use', id: ids[k], name: 'Agent', input: inp }] } })).join('\n') + '\n';
  const lead = 'x'.repeat(100) + '\n';
  const p = join(T, 'exact.jsonl');
  // 目標訊息後面墊一行，讓尾巴 2MB 剛好從目標訊息的第一行行首開始
  const filler = 2 * 1024 * 1024 - Buffer.byteLength(body);
  writeFileSync(p, lead + body + JSON.stringify({ type: 'user', message: { content: 'y'.repeat(filler - 80) } }).padEnd(filler - 1, ' ') + '\n');
  const r = inputs.every((_, k) => deny(run({ tool_input: inputs[k], tool_use_id: ids[k], transcript_path: p })));
  ok('尾巴 2MB 剛好從行首切：第一行不丟，照樣擋', r);
}
ok('writer 帶 claude-sonnet-5／"Sonnet "（同級）放行', !deny(run({ tool_input: { prompt: 'p', subagent_type: 'writer', model: 'claude-sonnet-5' } })) && !deny(run({ tool_input: { prompt: 'p', subagent_type: 'writer', model: 'Sonnet ' } })));

// ── 原本的規則照舊 ──
ok('沒寫 model 的 general-purpose 照舊擋', deny(run({ tool_input: { prompt: 'p', subagent_type: 'general-purpose' } })));
ok('沒寫類型也沒寫 model 照舊擋', deny(run({ tool_input: { prompt: 'p' } })));
ok('writer 帶 opus 照舊擋', deny(run({ tool_input: { prompt: 'p', subagent_type: 'writer', model: 'opus' } })));
ok('ui-verifier／dispatcher 帶 opus 也擋（frontmatter 固定 Sonnet）', deny(run({ tool_input: { prompt: 'p', subagent_type: 'ui-verifier', model: 'opus' } })) && deny(run({ tool_input: { prompt: 'p', subagent_type: 'dispatcher', model: 'opus' } })));
ok('reviewer 帶 opus 放行', !deny(run({ tool_input: { prompt: 'p', subagent_type: 'reviewer', model: 'opus' } })));
ok('writer 帶 sonnet 放行', !deny(run({ tool_input: { prompt: 'p', subagent_type: 'writer', model: 'sonnet' } })));
ok('general-purpose 帶 sonnet 放行', !deny(run({ tool_input: { prompt: 'p', subagent_type: 'general-purpose', model: 'sonnet' } })));

// ── 經過 dispatch.mjs（真的掛法）也擋 ──
{
  const inputs = many(4, GPO); const tr = transcript(inputs);
  const r = spawnSync(process.execPath, [join(HERE, 'dispatch.mjs'), 'PreToolUse'], { encoding: 'utf8', env: { ...process.env, HOOK_NOLOG: '1' },
    input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: inputs[1], tool_use_id: tr.ids[1], transcript_path: tr.path, cwd: T }) });
  let j = null; try { j = JSON.parse(r.stdout); } catch {}
  ok('經過 dispatch.mjs：4 個擋', deny(j), r.stdout + r.stderr);
}

console.log(`\n  ${pass} 過、${fail} 錯`);
process.exit(fail ? 1 : 0);
