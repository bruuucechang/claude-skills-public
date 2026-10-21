#!/usr/bin/env node
/**
 * StopFailure hook —— bruce 撞到額度上限（error: rate_limit）就馬上換到 peter，不等 90% 預先換手（2026-10-21 W5）。
 *
 * 跟 account-drain 的差別：那支是「快滿了」，叫 Claude 自己寫交接單再跑 handoff-open；
 * 撞上限時 Claude 已經不能再呼叫 API，所以這支**替它**寫交接單、直接跑 `handoff-open --to <帳號>`。
 *
 * 官方 StopFailure（code.claude.com/docs/en/hooks）：輸入多了 `error`（rate_limit、overloaded…）、
 * `error_details`、`last_assistant_message`（錯誤字串）；輸出與 exit code 一律被忽略，只能做副作用。
 *
 * - 只認 rate_limit；換到哪問 tools/acct-drain.mjs 的 limitTarget（只有 bruce→peter，peter 撞牆不反向）。
 * - 只在 handoff-open 換得了的地方換（iTerm2 互動 session，跟 account-drain 同一個 canSwitchHere）。
 * - 同一格 30 分鐘內只換一次（記在 ITERM_SESSION_ID）：換過去之後又撞牆、或 handoff-open 沒換成，都不會一直換。
 * - StopFailure 取代 Stop，pane-state 不會寫 done，handoff-open 的背景程序會一直等；
 *   所以 handoff-open 寫好標記後，這裡自己補跑一次 `pane-state.mjs done`（順序反過來它會認不得）。
 *   handoff-open 失敗或逾時也照跑：回合本來就結束了，而逾時時背景程序可能已經起來在等。
 * - handoff-open 失敗就在 ~/.claude/state/handoff/ 寫一份帶 gaveUp 的標記，讓 handoff-watch 推通知（不然沒人知道這格卡著）。
 * - 時間預算：dispatch.mjs 12 秒就自己退出，handoff-open 7 秒＋pane-state 3 秒要塞得進去。
 *
 * 逃生門：`touch hooks/rate-limit-switch.off`。紀錄：hooks/rate-limit-switch.log。
 * 測試：node test-rate-limit-switch.mjs
 */
import { execFileSync } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendLog } from './lib/log.mjs';
import { cli, isMain } from './lib/hook-cli.mjs';
import { canSwitchHere, claudeAncestor, limitTarget } from '../tools/acct-drain.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OFF = join(HERE, 'rate-limit-switch.off');
const LOG = join(HERE, 'rate-limit-switch.log');
export const HANDOFF_OPEN = join(HERE, '..', '..', 'bin', 'handoff-open');
const STATE = join(homedir(), '.claude', 'state', 'rate-limit-switch.json');
const NOTES = join(homedir(), '.claude', 'state', 'handoff');
const ONCE_MS = 30 * 60_000;

const readJson = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return {}; } };

/** transcript 最後一則使用者打的字（不含工具結果、指令與系統提醒）；讀不到回 null。只讀尾巴 2 MB。 */
export function lastPrompt(path) {
  let text;
  try {
    const size = statSync(path).size, n = Math.min(size, 2 * 1024 * 1024);
    const buf = Buffer.alloc(n), fd = openSync(path, 'r');
    try { readSync(fd, buf, 0, n, size - n); } finally { closeSync(fd); }
    text = buf.toString('utf8');
  } catch { return null; }
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    let o;
    try { o = JSON.parse(lines[i]); } catch { continue; }
    // compact 摘要、ESC 中斷也是 type user，但不是使用者打的字（PR #26 審查）
    if (o?.type !== 'user' || o.isMeta || o.isCompactSummary || o.isVisibleInTranscriptOnly) continue;
    const c = o.message?.content;
    // 一塊一塊判：[系統提醒, 使用者打的字] 這種合在一則的，只丟提醒那塊（PR #26 審查）
    const synthetic = (t) => /^\s*(<(command-|local-command|system-reminder|task-notification)|\[Request interrupted)/.test(t);
    const blocks = typeof c === 'string' ? [c] : Array.isArray(c) ? c.filter((x) => x?.type === 'text').map((x) => x.text) : [];
    const s = blocks.filter((t) => t?.trim() && !synthetic(t)).join('\n');
    if (!s.trim()) continue;
    return s.trim().length > 3000 ? s.trim().slice(0, 3000) + '…（後面略，全文在 transcript）' : s.trim();
  }
  return null;
}

export function note(input, d, prompt) {
  const cwd = input.cwd || process.cwd();
  return [
    `Account: ${d.from} → ${d.to}（撞額度上限自動換手）`,
    `cwd: ${cwd}`,
    '',
    `# 交接：${d.from} 撞到額度上限，自動換到 ${d.to}`,
    '',
    '## 目標',
    `上一個 session（${d.from}，session ${input.session_id}）做到一半撞到額度上限（StopFailure：${input.error}${input.error_details ? `，${input.error_details}` : ''}），`,
    '沒機會寫交接單；這份是 hook（rate-limit-switch）代寫的。接著把它沒做完的事做完。',
    '',
    '## 使用者最後一則訊息',
    '',
    ...(prompt ? prompt.split('\n').map((l) => '> ' + l) : ['（transcript 裡找不到，自己讀 transcript）']),
    '',
    '## 已經查到的事實',
    `- 上一個 session 的完整紀錄：${input.transcript_path || '（StopFailure 沒給 transcript_path）'}（JSONL，一行一則）。`,
    `- 撞牆時畫面上的錯誤：${input.last_assistant_message || '（沒給）'}`,
    '- 換手時舊的 claude 已經 /exit，它的背景任務與 Monitor 跟著被殺。',
    '',
    '## 下一步',
    '1. 讀 transcript 最後一段（從上面那則使用者訊息往後），弄清楚做到哪、哪些背景任務要重跑。',
    '2. 照開場白附的現況快照確認 repo 現況，接著把事情做完。',
    '3. 上一個 session 若正在等使用者回答，就把那題重新用選項問一次。',
    '',
    '## 不要碰的東西',
    '- 不是上一個 session 動的未 commit 改動照常不碰、不 add。',
    '',
  ].join('\n');
}

const openHandoff = (file, cwd, to, pid) => execFileSync(process.execPath, [HANDOFF_OPEN, file, '--to', to, '--cwd', cwd], {
  encoding: 'utf8', timeout: 7000, stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...process.env, HANDOFF_OLD_PID: String(pid) },
});
export const PANE_STATE = join(HERE, 'pane-state.mjs');
const paneDone = (input) => execFileSync(process.execPath, [PANE_STATE, 'done'], {
  input: JSON.stringify(input), timeout: 3000, stdio: ['pipe', 'ignore', 'ignore'],
});

export function run(input, {
  env = process.env, target = limitTarget, here = canSwitchHere, findPid = claudeAncestor,
  open = openHandoff, done = paneDone, state = STATE, notes = NOTES, log = (o) => appendLog(LOG, o), off = OFF,
} = {}) {
  if (input?.hook_event_name !== 'StopFailure' || input.error !== 'rate_limit' || !input.session_id) return null;
  if (existsSync(off)) return null;
  const sid = env.ITERM_SESSION_ID || input.session_id;
  const at = new Date().toISOString();
  const rec = (o) => log({ at, sid: input.session_id.slice(0, 8), pane: env.ITERM_SESSION_ID || null, ...o });
  const s = readJson(state);
  if (s[sid] && Date.now() - Date.parse(s[sid]) < ONCE_MS) { rec({ skip: `這格 ${s[sid]} 換過了` }); return null; }
  const d = target(env.CLAUDE_CONFIG_DIR);
  if (!d) { rec({ skip: '沒有規則要換（不是 bruce，或 peter 也快滿了／沒登）' }); return null; }
  // 先記「換過」再動手：handoff-open 半途失敗、或這裡換不了，下一次撞牆都不會再開一份（失敗的已經推通知叫人）
  s[sid] = at;
  mkdirSync(dirname(state), { recursive: true });
  writeFileSync(state, JSON.stringify(Object.fromEntries(Object.entries(s).sort((a, b) => b[1].localeCompare(a[1])).slice(0, 200))));
  mkdirSync(notes, { recursive: true });
  const file = join(notes, `${at.replace(/[:.]/g, '-')}-rate-limit.md`);
  writeFileSync(file, note(input, d, input.transcript_path ? lastPrompt(input.transcript_path) : null));
  // 檔名要符合 handoff-watch 認的 <時間>Z.json；它看到 gaveUp 就推通知
  const giveUp = (why) => writeFileSync(file.replace(/-rate-limit\.md$/, '.json'), JSON.stringify({
    mode: 'rate-limit', created: at, handoff: file, cwd: input.cwd || null, gaveUp: `${d.from} 撞額度上限，${why}`,
  }, null, 2));
  const pid = findPid();
  // 要換卻換不了（tmux、claude -p、不在 iTerm2）：不能安靜放著，叫人手動換（PR #26 審查）
  if (!here(env, pid)) {
    giveUp(`但這裡換不了帳號（tmux／claude -p／不在 iTerm2），要手動改用 ${d.to} 讀交接單接手`);
    rec({ from: d.from, to: d.to, note: file, err: '這裡換不了帳號' });
    return null;
  }
  let err = null;
  try { open(file, input.cwd || process.cwd(), d.to, pid); }
  catch (e) {
    // 逾時時背景程序可能已經起來在換：說「不確定」，不說失敗（PR #26 審查）
    err = e?.code === 'ETIMEDOUT' || e?.signal === 'SIGTERM' ? 'handoff-open 逾時（背景可能已經在換，看一下那格）'
      : 'handoff-open 失敗：' + (String(e?.stderr || e?.message || e).split('\n').map((l) => l.trim()).find((l) => l.startsWith('handoff-open:'))?.replace(/^handoff-open: /, '')
        || String(e?.message || e).trim().split('\n')[0] || '沒有輸出');
  }
  try { done(input); } catch (e) { rec({ warn: 'pane-state done 沒跑成：' + String(e?.message || e).split('\n')[0] }); }
  if (err) giveUp(`換到 ${d.to} 沒確定成功：${err}`);
  rec({ from: d.from, to: d.to, note: file, ...(err ? { err } : {}), error_details: input.error_details || null });
  return null;
}

if (isMain(import.meta.url)) cli(run);
