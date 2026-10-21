#!/usr/bin/env node
/**
 * replay.mjs —— 拿歷史輸入比對「舊的各支掛法」與「新的 dispatch.mjs」決定是否一致。
 *
 *     node ~/.claude/skills/home/claude/hooks/replay.mjs [舊版 ref=d8411d1] [天數=7] [上限 MB=3000]
 *
 * 舊版：從 git 取 ref 當時的 hooks 與 settings.json，照當時 settings.json 的同步掛法逐支開程序跑
 *       （作者檢查與 browser_batch 白名單是 inline shell）。
 * 新版：同一個程序裡呼叫 dispatch.mjs 的 runChecks（log 關掉）。
 * 輸入：最近 N 天 transcript 裡的 Bash／AskUserQuestion／browser_batch 呼叫，加上 focus-guard.log、
 *       commit-message-guard.log 的歷史擋下；Stop 用各 transcript 裡助理的收尾文字。
 *       Bash 只全取跟檢查有關的（git commit／open／osascript／Godot），其餘抽樣。
 * 比的是每一支的「擋不擋＋理由全文」，一字不差才算一致。
 */
import { execFileSync, spawnSync } from 'node:child_process';
import { createReadStream, existsSync, realpathSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';

process.env.HOOK_NOLOG = '1';
process.env.FOCUS_GUARD_NOLOG = '1';
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const [REF = 'd8411d1', DAYS = '7', MAXMB = '3000'] = process.argv.slice(2);
// realpath：mac 的 tmpdir 在 /var/folders（→ /private/var/folders 的 symlink），舊版 ask-with-options 的
// 「是不是直接執行」不解 symlink，放在 symlink 路徑底下它根本不跑，Stop 的比對會全部假一致（2026-10-20 踩到）。
const T = realpathSync(mkdtempSync(join(tmpdir(), 'hook-replay-')));

// ── 舊版 ──
const OLD = join(T, 'old');
mkdirSync(join(OLD, 'hooks', 'lib'), { recursive: true });
const show = (p) => execFileSync('git', ['-C', REPO, 'show', `${REF}:${p}`], { encoding: 'utf8', maxBuffer: 64 << 20 });
// 整個 hooks 目錄照 ref 當時的樣子搬出來：分派器時代（2026-10-20 以後）的 ref 掛的是 dispatch.mjs，要它引用的每一支
const tracked = execFileSync('git', ['-C', REPO, 'ls-tree', '-r', '--name-only', REF, 'home/claude/hooks/'], { encoding: 'utf8' })
  .split('\n').filter((f) => /\.(mjs|txt|json)$/.test(f) && !f.includes('.history.'));
for (const f of tracked) {
  const dst = join(OLD, 'hooks', f.slice('home/claude/hooks/'.length));
  mkdirSync(dirname(dst), { recursive: true });
  writeFileSync(dst, show(f));
}
const oldSettings = JSON.parse(show('home/claude/settings.json'));
const oldHooks = (event, tool) => (oldSettings.hooks[event] || [])
  .filter((g) => !g.matcher || new RegExp(`^(${g.matcher})$`).test(tool))
  .flatMap((g) => g.hooks).filter((h) => !h.async && !h.command.includes('office/tools/subagent-hook'))
  .map((h) => h.command
    .replaceAll('$HOME/.claude/skills/home/claude/hooks/', `${OLD}/hooks/`)
    .replaceAll('~/.claude/skills/home/claude/hooks/', `${OLD}/hooks/`));

function runOld(event, input) {
  const cwd = input.cwd;
  return oldHooks(event, input.tool_name).map((cmd) => {
    const r = spawnSync('/bin/bash', ['-c', cmd], { input: JSON.stringify(input), encoding: 'utf8', cwd, timeout: 20000 });
    let j = null; try { j = JSON.parse(r.stdout); } catch {}
    return j;
  });
}

// ── 新版 ──
const D = await import('./dispatch.mjs');
async function runNew(event, input, checks) {
  return (await D.runChecks(event, input, { log: false, ...(checks ? { checks } : {}) })).map((r) => r.out);
}

const verdict = (outs) => outs
  .map((o) => o?.hookSpecificOutput?.permissionDecision === 'deny' ? `deny:${o.hookSpecificOutput.permissionDecisionReason}`
    : o?.decision === 'block' ? `block:${o.reason}` : null)
  .filter(Boolean);

// ── 收集輸入 ──
const cut = Date.now() - Number(DAYS) * 86_400_000;
const files = [];
for (const root of [join(homedir(), '.claude', 'projects'), join(homedir(), '.claude-work', 'projects')]) {
  if (!existsSync(root)) continue;
  for (const d of readdirSync(root)) {
    let fs_ = [];
    try { fs_ = readdirSync(join(root, d)); } catch { continue; }
    for (const f of fs_) {
      if (!f.endsWith('.jsonl')) continue;
      const p = join(root, d, f);
      const st = statSync(p);
      if (st.mtimeMs >= cut) files.push({ p, size: st.size, m: st.mtimeMs });
    }
  }
}
files.sort((a, b) => b.m - a.m);
let budget = Number(MAXMB) * 1e6;
const pick = files.filter((f) => (budget -= f.size) >= 0);

const RELEVANT = /\bgit\b[^\n]*\bcommit|git commit|open|osascript|Godot/;
const seen = new Set();
const bash = [], other = [], ask = [], batch = [], stop = [];
const fallbackCwd = (c) => (c && existsSync(c) ? c : tmpdir());
for (const { p } of pick) {
  const rl = createInterface({ input: createReadStream(p, 'utf8'), crlfDelay: Infinity });
  let lastText = null, lastCwd = null;
  for await (const line of rl) {
    if (!line.includes('"assistant"')) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type !== 'assistant' || o.isSidechain || !Array.isArray(o.message?.content)) continue;
    for (const b of o.message.content) {
      if (b.type === 'text' && b.text?.trim()) { lastText = b.text; lastCwd = o.cwd; }
      if (b.type !== 'tool_use') continue;
      const input = { session_id: 'replay', cwd: fallbackCwd(o.cwd), hook_event_name: 'PreToolUse', tool_name: b.name, tool_input: b.input };
      const k = b.name + JSON.stringify(b.input) + input.cwd;
      if (seen.has(k)) continue;
      seen.add(k);
      if (b.name === 'Bash' && typeof b.input?.command === 'string') (RELEVANT.test(b.input.command) ? bash : other).push(input);
      else if (b.name === 'AskUserQuestion') ask.push(input);
      else if (b.name === 'mcp__claude-in-chrome__browser_batch') batch.push(input);
    }
  }
  if (lastText) stop.push({ session_id: 'replay', cwd: fallbackCwd(lastCwd), transcript_path: p, stop_reason: 'end_turn', last_assistant_message: lastText });
}
// log 不進版控：在 worktree 裡跑時去共用 checkout 找
const LOGDIR = [HERE, join(homedir(), '.claude', 'skills', 'home', 'claude', 'hooks')].find((d) => existsSync(join(d, 'commit-message-guard.log'))) ?? HERE;
for (const log of ['focus-guard.log', 'commit-message-guard.log']) {
  if (!existsSync(join(LOGDIR, log))) continue;
  for (const l of readFileSync(join(LOGDIR, log), 'utf8').split('\n')) {
    let o; try { o = JSON.parse(l); } catch { continue; }
    if (o.cmd) bash.push({ session_id: 'replay', cwd: tmpdir(), hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: o.cmd } });
  }
}
// 跟檢查無關的 Bash 抽 300 筆就夠證明「放行照舊」
const sample = other.sort(() => Math.random() - 0.5).slice(0, 300);

// ── 比對 ──
console.error(`輸入：Bash 相關 ${bash.length}、抽樣 ${sample.length}、AskUserQuestion ${ask.length}、browser_batch ${batch.length}、Stop ${stop.length}`);
let done = 0;
const tick = () => { if (++done % 200 === 0) console.error(`  已比 ${done} 筆`); };
const stats = {};
const diffs = [];
async function compare(kind, event, input, checks) {
  const a = verdict(runOld(event, input));
  const b = verdict(await runNew(event, input, checks));
  const same = JSON.stringify(a) === JSON.stringify(b);
  tick();
  const s = (stats[kind] ??= { n: 0, same: 0, oldDeny: 0, newDeny: 0 });
  s.n++; if (same) s.same++; if (a.length) s.oldDeny++; if (b.length) s.newDeny++;
  if (!same) diffs.push({ kind, input: kind === 'Stop' ? input.last_assistant_message.slice(-200) : input.tool_input, old: a.map((x) => x.slice(0, 120)), new: b.map((x) => x.slice(0, 120)) });
}
for (const i of bash) await compare('Bash（相關）', 'PreToolUse', i);
for (const i of sample) await compare('Bash（抽樣）', 'PreToolUse', i);
for (const i of ask) await compare('AskUserQuestion', 'PreToolUse', i);
for (const i of batch) await compare('browser_batch', 'PreToolUse', i);
// Stop：舊的同步掛法是 ask-with-options＋session-journal，journal 不輸出、會寫日誌，所以新舊都只比 ask-with-options
// 分派器時代的 Stop 掛的是 dispatch.mjs（會連 session-journal 一起跑、寫日誌），改成直接跑那一版的 ask-with-options
let stopOld = oldHooks('Stop').filter((c) => c.includes('ask-with-options'));
if (!stopOld.length) stopOld = [`node "${OLD}/hooks/ask-with-options.mjs"`];
{
  // 先確認舊版真的會擋，否則下面的「一致」可能只是兩邊都沒跑
  const tr = join(T, 'probe.jsonl');
  writeFileSync(tr, '{"type":"user","message":{"content":"go"}}\n');
  const r = spawnSync('/bin/bash', ['-c', stopOld[0]], { input: JSON.stringify({ transcript_path: tr, last_assistant_message: '你想走哪一條？' }), encoding: 'utf8' });
  if (!r.stdout.includes('block')) { console.error('舊版 ask-with-options 沒有擋探針問句——比對無效'); process.exit(2); }
}
for (const i of stop) {
  tick();
  const r = spawnSync('/bin/bash', ['-c', stopOld[0]], { input: JSON.stringify(i), encoding: 'utf8', cwd: i.cwd });
  let j = null; try { j = JSON.parse(r.stdout); } catch {}
  const a = verdict([j]);
  const b = verdict(await runNew('Stop', i, [{ name: 'ask-with-options', timeout: 5000 }]));
  const s = (stats.Stop ??= { n: 0, same: 0, oldDeny: 0, newDeny: 0 });
  s.n++; if (JSON.stringify(a) === JSON.stringify(b)) s.same++; else diffs.push({ kind: 'Stop', input: i.last_assistant_message.slice(-200), old: a, new: b });
  if (a.length) s.oldDeny++; if (b.length) s.newDeny++;
}

console.log(`transcript：${pick.length} 份（最近 ${DAYS} 天、上限 ${MAXMB} MB），舊版 ${REF}\n`);
console.log('| 輸入 | 筆數 | 一致 | 舊版擋 | 新版擋 |\n|---|---|---|---|---|');
for (const [k, s] of Object.entries(stats)) console.log(`| ${k} | ${s.n} | ${s.same} | ${s.oldDeny} | ${s.newDeny} |`);
if (diffs.length) {
  writeFileSync(join(T, 'diffs.json'), JSON.stringify(diffs, null, 2));
  console.log(`\n不一致 ${diffs.length} 筆，明細：${join(T, 'diffs.json')}`);
  process.exit(1);
}
console.log('\n全部一致。');
