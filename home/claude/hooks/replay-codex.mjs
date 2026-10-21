#!/usr/bin/env node
/**
 * replay-codex.mjs —— Codex 那邊：比對「舊的逐支直接呼叫」與「dispatch.mjs <事件> codex」決定是否一致。
 *
 *     node ~/.claude/skills/home/claude/hooks/replay-codex.mjs [舊版 ref=32191a9] [天數=30]
 *
 * 舊版：從 git 取 ref 當時的 hooks 目錄與 codex-hooks.json，照當時的掛法逐支開程序跑。
 * 新版：目前工作區的 codex-hooks.json 指令（也就是 dispatch.mjs … codex），一樣開程序跑。
 * 輸入（Codex 的格式，欄位跟 Claude 一樣）：最近 N 天 ~/.codex/sessions 的 rollout 裡
 *   exec_command 的 cmd → PreToolUse（tool_name Bash）、task_complete 的 last_agent_message → Stop，
 *   加上 focus-guard.log／commit-message-guard.log 的歷史擋下；SessionStart 跑一次。
 *   Bash 全取跟檢查有關的（git commit／open／osascript／Godot），其餘抽樣 300（全跑 4000 筆要 20 幾分鐘）。
 * 比的是 Codex 看得到的結果：PreToolUse 擋不擋＋理由集合、Stop 擋不擋＋理由、SessionStart 的提示文字集合。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const [REF = '32191a9', DAYS = '30'] = process.argv.slice(2);
const T = realpathSync(mkdtempSync(join(tmpdir(), 'codex-replay-')));
const FAKEHOME = join(T, 'home');
mkdirSync(join(FAKEHOME, '.claude', 'cache'), { recursive: true });
writeFileSync(join(FAKEHOME, '.claude', 'cache', 'update-check.json'), JSON.stringify({ t: Date.now() }));
const ENV = { ...process.env, HOOK_NOLOG: '1', FOCUS_GUARD_NOLOG: '1',
  UPDATE_CHECK_CACHE_DIR: join(FAKEHOME, '.claude', 'cache'), UPDATE_CHECK_BREW: join(T, 'no-brew'), UPDATE_CHECK_PROJECTS: join(T, 'no-projects') };

// ── 舊版：ref 當時的 hooks 目錄 ──
const OLD = join(T, 'old');
mkdirSync(OLD);
execFileSync('/bin/sh', ['-c', `git -C "${REPO}" archive ${REF} home/claude/hooks | tar -x -C "${OLD}"`]);
const cmds = (json, hooksDir) => (event) => (JSON.parse(json).hooks[event] || [])
  .flatMap((g) => g.hooks).map((h) => h.command.replaceAll('$HOME/.claude/skills/home/claude/hooks', hooksDir));
const oldCmds = cmds(execFileSync('git', ['-C', REPO, 'show', `${REF}:home/claude/hooks/codex-hooks.json`], { encoding: 'utf8' }), join(OLD, 'home/claude/hooks'));
const newCmds = cmds(readFileSync(join(HERE, 'codex-hooks.json'), 'utf8'), HERE);

const run = (list, input) => list.map((cmd) => {
  const r = spawnSync('/bin/sh', ['-c', cmd], { input: JSON.stringify(input), encoding: 'utf8', cwd: input.cwd, env: ENV, timeout: 20000, maxBuffer: 64 << 20 });
  if (r.error || r.stdout == null) return `（程序沒跑起來：${r.error?.code ?? r.status}）`;
  let j = null; try { j = JSON.parse(r.stdout); } catch { j = r.stdout.trim() || null; }
  return j;
}).filter((o) => o != null);

/** 把一串輸出化成 Codex 看得到的東西。 */
function view(event, outs) {
  const deny = [], ctx = [], block = [];
  for (const o of outs) {
    if (typeof o === 'string') { ctx.push(o); continue; }
    const h = o.hookSpecificOutput || {};
    if (h.permissionDecision === 'deny') deny.push(h.permissionDecisionReason);
    if (o.decision === 'block') block.push(o.reason);
    if (h.additionalContext) ctx.push(...h.additionalContext.split('\n\n'));
  }
  if (event === 'PreToolUse') return JSON.stringify({ deny: deny.length > 0, why: deny.flatMap((r) => r.split('\n\n')).sort() });
  if (event === 'Stop') return JSON.stringify({ block: block.length > 0, why: block.flatMap((r) => r.split('\n\n')).sort() });
  return JSON.stringify(ctx.map((s) => s.trim()).filter(Boolean).sort());
}

// ── 輸入 ──
const since = Date.now() - Number(DAYS) * 86400_000;
const rollouts = [];
const walk = (d) => { for (const n of readdirSync(d)) { const p = join(d, n); const s = statSync(p); s.isDirectory() ? walk(p) : (n.endsWith('.jsonl') && s.mtimeMs > since && rollouts.push(p)); } };
const SESS = join(homedir(), '.codex', 'sessions');
if (existsSync(SESS)) walk(SESS);
const bash = new Map(), stops = new Set();
const CMD_RE = /exec_command\(\{\s*cmd:\s*"((?:[^"\\]|\\.)*)"/g;
for (const f of rollouts) {
  let cwd = homedir();
  // 逐行讀：長跑的 rollout 會超過 node 單一字串的上限（512MB）
  for await (const line of createInterface({ input: createReadStream(f), crlfDelay: Infinity })) {
    if (!line || line.length > 4 << 20) continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    const p = j.payload || {};
    if (j.type === 'turn_context' && p.cwd) cwd = p.cwd;
    const found = [];
    if (p.type === 'custom_tool_call' && typeof p.input === 'string') for (const m of p.input.matchAll(CMD_RE)) { try { found.push(JSON.parse(`"${m[1]}"`)); } catch {} }
    if (p.type === 'function_call' && p.name === 'exec_command') { try { found.push(JSON.parse(p.arguments).cmd); } catch {} }
    for (const c of found) if (typeof c === 'string' && !bash.has(c)) bash.set(c, existsSync(cwd) ? cwd : homedir());
    if (p.type === 'task_complete' && p.last_agent_message) stops.add(p.last_agent_message);
  }
}
for (const log of ['focus-guard.log', 'commit-message-guard.log']) {
  const p = join(HERE, log);
  if (!existsSync(p)) continue;
  for (const l of readFileSync(p, 'utf8').split('\n')) { try { const c = JSON.parse(l).cmd; if (c && !bash.has(c)) bash.set(c, homedir()); } catch {} }
}

const RELEVANT = /git commit|open|osascript|Godot/;
const all = [...bash];
const rel = all.filter(([c]) => RELEVANT.test(c));
const sample = all.filter(([c]) => !RELEVANT.test(c)).sort(() => Math.random() - 0.5).slice(0, 300);
console.error(`輸入：Bash 共 ${all.length}（相關 ${rel.length}、抽樣 ${sample.length}）、Stop ${stops.size}`);
const cases = [{ event: 'SessionStart', input: { hook_event_name: 'SessionStart', session_id: 'replay', cwd: REPO, source: 'startup' } }];
for (const [command, cwd] of [...rel, ...sample]) cases.push({ event: 'PreToolUse', input: { hook_event_name: 'PreToolUse', session_id: 'replay', cwd, tool_name: 'Bash', tool_input: { command } } });
for (const m of stops) cases.push({ event: 'Stop', input: { hook_event_name: 'Stop', session_id: 'replay', cwd: homedir(), stop_hook_active: false, last_assistant_message: m, transcript_path: join(T, 'none.jsonl') } });

let same = 0, diff = 0, blocked = 0, broken = 0;
for (const { event, input } of cases) {
  const a = view(event, run(oldCmds(event), input)), b = view(event, run(newCmds(event), input));
  if (a.includes('"deny":true') || a.includes('"block":true')) blocked++;
  if ((a + b).includes('程序沒跑起來')) broken++;
  if (a === b) { same++; continue; }
  diff++;
  console.log(`✗ ${event} ${JSON.stringify(input.tool_input?.command ?? input.last_assistant_message ?? '').slice(0, 160)}\n   舊 ${a.slice(0, 300)}\n   新 ${b.slice(0, 300)}`);
}
console.log(`rollout ${rollouts.length} 份；PreToolUse ${rel.length + sample.length}（共 ${all.length}）、Stop ${stops.size}、SessionStart 1；一致 ${same}、不一致 ${diff}（其中舊版擋下 ${blocked} 筆；程序沒跑起來 ${broken} 筆）`);
process.exit(diff ? 1 : 0);
