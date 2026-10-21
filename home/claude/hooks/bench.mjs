#!/usr/bin/env node
// bench.mjs —— 量 settings.json 每個事件實際會開幾個程序、同步那些要等多久。
// 重跑：node ~/.claude/skills/home/claude/hooks/bench.mjs [次數=5]
// 只跑同步的掛法（async 的不擋 Claude，另外列數量）；輸入是假的，量的是啟動成本不是判斷結果。
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

const N = Number(process.argv[2] || 5);
// BENCH_SETTINGS=<檔> 量別份設定（例如舊版：git show d8411d1:home/claude/settings.json > /tmp/old.json），同一時間前後量才比得準
const settings = JSON.parse(readFileSync(process.env.BENCH_SETTINGS || `${homedir()}/.claude/settings.json`, 'utf8'));
const sample = (ev, tool) => JSON.stringify({
  session_id: 'bench', transcript_path: '/dev/null', cwd: '/tmp', hook_event_name: ev,
  prompt: 'hi', tool_name: tool, tool_input: { command: 'ls' }, last_assistant_message: '好了。',
});
const cases = [
  ['SessionStart'], ['UserPromptSubmit'], ['Stop'], ['PreToolUse', 'Bash'], ['PreToolUse', 'Read'],
  ['PostToolUse', 'Bash'], ['Notification'],
];
const match = (m, tool) => !m || !tool || new RegExp(`^(${m})$`).test(tool);
console.log('| 事件 | 同步程序 | async 程序 | 同步總耗時 ms（中位數） |\n|---|---|---|---|');
for (const [ev, tool] of cases) {
  const hs = (settings.hooks[ev] || []).filter((g) => match(g.matcher, tool)).flatMap((g) => g.hooks);
  const sync = hs.filter((h) => !h.async), asyncN = hs.length - sync.length;
  const runs = [];
  for (let i = 0; i < N; i++) {
    const t = process.hrtime.bigint();
    // Claude Code 同一事件的掛法是並行跑的，所以量最慢那支（並行等待時間）
    const ps = sync.map((h) => `( ${h.command} ) >/dev/null 2>&1 <<'__IN__' &\n${sample(ev, tool)}\n__IN__`);
    execSync(`${ps.join('\n')}\nwait`, { shell: '/bin/bash', env: { ...process.env, FOCUS_GUARD_NOLOG: '1', HOOK_NOLOG: '1', HOOK_BENCH: '1' } });
    runs.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  runs.sort((a, b) => a - b);
  console.log(`| ${ev}${tool ? `(${tool})` : ''} | ${sync.length} | ${asyncN} | ${runs[N >> 1].toFixed(0)} |`);
}
