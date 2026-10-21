#!/usr/bin/env node
/**
 * replay-agent-fanout.mjs —— 拿兩個帳號近 N 天 transcript 裡真實的 Agent 呼叫，
 * 比對 agent-model-guard「舊版（git ref）」與「現在這份」的擋法差在哪。
 *
 *     node ~/.claude/skills/home/claude/hooks/replay-agent-fanout.mjs [舊版 ref=ac683e2] [天數=14]
 *
 * 預設 ref 是加扇出規則之前的 commit；寫成分支名的話合併後就變成新版比新版、安靜地印 0。
 *
 * 每個呼叫都用它的 tool_use_id 餵進去，transcript 截到「那則訊息的最後一行」另存一份給它讀，
 * 等於當時 PreToolUse 看到的樣子（直接給整份，舊訊息會落在 2MB 尾巴外面而假放行）。
 * 印：總呼叫數、每則訊息的扇出分布、新增擋下（舊放行新擋）與新增放行（舊擋新放行）的清單。
 * 新增放行應該是 0；新增擋下應該只出現在「同一則訊息 ≥4 個 opus general-purpose」。
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..', '..', '..');
const [REF = 'ac683e2', DAYS = '14'] = process.argv.slice(2);

const T = realpathSync(mkdtempSync(join(tmpdir(), 'agent-replay-')));
// 裡面是截斷的 transcript 複本（含對話內容），跑完一定清掉
process.on('exit', () => { try { rmSync(T, { recursive: true, force: true }); } catch {} });
mkdirSync(join(T, 'lib'));
const show = (p) => execFileSync('git', ['-C', REPO, 'show', `${REF}:home/claude/hooks/${p}`], { encoding: 'utf8' });
writeFileSync(join(T, 'agent-model-guard.mjs'), show('agent-model-guard.mjs'));
writeFileSync(join(T, 'lib', 'hook-cli.mjs'), show('lib/hook-cli.mjs'));
const OLD = await import(pathToFileURL(join(T, 'agent-model-guard.mjs')).href);
const NEW = await import('./agent-model-guard.mjs');

const cut = Date.now() - Number(DAYS) * 86_400_000;
const files = [];
const walk = (d) => {
  for (const f of readdirSync(d, { withFileTypes: true })) {
    const p = join(d, f.name);
    if (f.isDirectory()) walk(p);
    else if (f.name.endsWith('.jsonl') && statSync(p).mtimeMs >= cut) files.push(p);
  }
};
for (const r of ['.claude/projects', '.claude-work/projects']) {
  const p = join(homedir(), r);
  if (existsSync(p)) walk(p);
}

const denied = (o) => o?.hookSpecificOutput?.permissionDecision === 'deny';
let calls = 0;
const fan = {};
const newDeny = [];
const newAllow = [];
for (const p of files) {
  let txt;
  try { txt = readFileSync(p, 'utf8'); } catch { continue; }
  if (!txt.includes('"name":"Agent"') && !txt.includes('"name":"Task"')) continue;
  const perMsg = new Map();
  const lines = txt.split('\n');
  const lastLine = new Map();
  lines.forEach((l, n) => {
    const m = l.includes('"type":"assistant"') && /"id":"(msg_[^"]+)"/.exec(l);
    if (m) lastLine.set(m[1], n);
  });
  const cutCache = new Map();
  const cutAt = (msgId) => {
    if (!cutCache.has(msgId)) {
      const f = join(T, `cut-${cutCache.size}.jsonl`);
      writeFileSync(f, lines.slice(0, (lastLine.get(msgId) ?? lines.length) + 1).join('\n') + '\n');
      cutCache.set(msgId, f);
    }
    return cutCache.get(msgId);
  };
  for (const l of lines) {
    if (!l.includes('"name":"Agent"') && !l.includes('"name":"Task"')) continue;
    let o;
    try { o = JSON.parse(l); } catch { continue; }
    if (o.type !== 'assistant' || !Array.isArray(o.message?.content)) continue;
    for (const b of o.message.content) {
      if (b?.type !== 'tool_use' || !['Agent', 'Task'].includes(b.name)) continue;
      calls++;
      perMsg.set(o.message.id, (perMsg.get(o.message.id) || 0) + 1);
      const input = { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: b.input, tool_use_id: b.id,
        transcript_path: NEW.isOpusGP(b.input) ? cutAt(o.message.id) : p };
      const a = denied(OLD.run(input)), z = denied(NEW.run(input));
      const tag = `${p.split('/projects/')[1]} ${o.message.id} ${b.input?.subagent_type || '(無類型)'} model=${b.input?.model || '-'}`;
      if (!a && z) newDeny.push(tag);
      if (a && !z) newAllow.push(tag);
    }
  }
  for (const n of perMsg.values()) fan[n] = (fan[n] || 0) + 1;
}
console.log(`transcript ${files.length} 份、Agent 呼叫 ${calls} 次`);
console.log('每則訊息的 Agent 數 → 訊息數', fan);
console.log(`新增擋下 ${newDeny.length} 次：`);
for (const x of newDeny) console.log('  ' + x);
console.log(`新增放行 ${newAllow.length} 次：`);
for (const x of newAllow) console.log('  ' + x);
