#!/usr/bin/env node
/**
 * UserPromptSubmit／Stop hook —— 這個 session 登的帳號週額度快用完了，叫它做完手上這一步就換到另一個帳號。
 *
 * 使用者裁示（2026-10-21）：「bruce 帳號用到 90 就先停下，改用 peter 的」、看週窗、
 * 每個 session 寫交接單後同一格改用 peter 開；「現在就可以逐步交接了」。
 * 要不要換、換到哪只問 tools/acct-drain.mjs（handoff-open 也問它，所以照常跑 handoff-open 就會換帳號）。
 *
 * - UserPromptSubmit：附一段說明（同一個 session 只說一次）。
 * - Stop：同一個 session 擋一次，讓它寫交接單、跑 handoff-open 再結束；擋過就放行，不會一直擋。
 *   不判斷回合內容：在等使用者動手的情況由訊息請它自己判斷、直接結束回合。
 * - 「說過／擋過」記在**這格**（ITERM_SESSION_ID），不是 session_id：handoff-open 萬一沒換成（快取過期、
 *   peter 剛過門檻），/clear 後的新 session 也不會被同一格再叫一次；記號 2 小時後失效。
 * - 只在 handoff-open 換得了帳號的地方說（iTerm2 互動 session，不含 tmux、claude -p）；
 *   換不了還叫它交接，/clear 後新的 session_id 又會被叫一次，變成無限交接。
 *
 * 逃生門：`node tools/acct-drain.mjs off` 關提前開關；整支關掉 `touch hooks/account-drain.off`。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendLog } from './lib/log.mjs';
import { cli, isMain } from './lib/hook-cli.mjs';
import { canSwitchHere, drainFor } from '../tools/acct-drain.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OFF = join(HERE, 'account-drain.off');
const LOG = join(HERE, 'account-drain.log');
const STATE = join(homedir(), '.claude', 'state', 'acct-drain-sessions.json');

const load = () => { try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return {}; } };
const DONE_MS = 2 * 3600_000;
function mark(sid, key, value = new Date().toISOString()) {
  const s = load();
  s[sid] = { ...(s[sid] || {}), [key]: value, seen: Date.now() };
  // 依最後寫入時間留 200 筆（skipUntil 存的是未來時間，不能拿值本身排）
  const keep = Object.entries(s).sort((a, b) => (b[1].seen || 0) - (a[1].seen || 0)).slice(0, 200);
  mkdirSync(dirname(STATE), { recursive: true });
  writeFileSync(STATE, JSON.stringify(Object.fromEntries(keep)));
}

const howTo = (d) => `做法：做完手上這一步（不要做到一半丟下）、等自己的背景任務與 Monitor 跑完或寫進交接單`
  + `（換手會 /exit 這支 claude，背景任務會跟著被殺），再寫交接單（handoff skill），`
  + `跑 \`handoff-open <交接單>\`——它會自己判斷要換帳號：回合結束後這格的 claude 會退出，`
  + `同一格改用 ${d.to} 的設定目錄開新 session 讀交接單接著做。不用問使用者。`;

export function run(input, { drain = drainFor, env = process.env, here = canSwitchHere } = {}) {
  if (existsSync(OFF)) return null;
  const event = input?.hook_event_name;
  if (!input?.session_id || (event !== 'UserPromptSubmit' && event !== 'Stop')) return null;
  const sid = env.ITERM_SESSION_ID || input.session_id;
  const done = load()[sid] || {};
  const key = event === 'Stop' ? 'blocked' : 'told';
  if (done[key] && Date.now() - Date.parse(done[key]) < DONE_MS) return null;
  // 便宜的先判（ps 幾毫秒），drain 才會去查 Keychain；「這格不用換」記 10 分鐘，不每回合重查
  if (done.skipUntil && Date.parse(done.skipUntil) > Date.now()) return null;
  const d = here(env) ? drain(env.CLAUDE_CONFIG_DIR) : null;
  if (!d) { mark(sid, 'skipUntil', new Date(Date.now() + 10 * 60_000).toISOString()); return null; }
  mark(sid, key);
  appendLog(LOG, { t: new Date().toISOString(), sid: input.session_id.slice(0, 8), pane: env.ITERM_SESSION_ID || null, event, from: d.from, to: d.to, pct: d.pct, reason: d.reason });
  const head = `【換帳號：這個 session 用的是 ${d.from}，要換到 ${d.to}】${d.reason}。`;
  if (event === 'UserPromptSubmit') {
    return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: head + howTo(d) + '（這是機制提醒，不是使用者說的；先把這則訊息要做的事做完。）' } };
  }
  return { decision: 'block', reason: head + howTo(d) + '（這是機制擋的，只擋這一次；已經寫好交接單並跑過 handoff-open、或正在等使用者動手的話，不要再跑一次，直接結束回合。）' };
}

if (isMain(import.meta.url)) cli(run);
