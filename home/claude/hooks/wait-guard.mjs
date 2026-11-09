#!/usr/bin/env node
/**
 * PreToolUse(Bash) hook —— 不准手寫輪詢迴圈（`until …; do sleep; done`、`for i in $(seq 1 120); do …; sleep 60; done`），
 * 一律改用 `tools/waitfor`：成功、失敗、程序死掉、逾時四種結局都會退出，第一輪還會印出每個條件的離開碼。
 *
 * ## 為什麼
 *
 * 2026-10-27 使用者：「常常有空轉的等待回圈」。實測近 7 天 105 個背景輪詢迴圈：
 *   · 10-25 等 mani 出圖寫成 `ls done/$J failed/$J && break`——兩個路徑一定有一個不存在，`ls` 永遠失敗，
 *     工作早就做完，迴圈照樣跑滿 2 小時；同一個 session 寫了 4 次，使用者問了三次「done?」。
 *   · 9 個上限超過 3 小時，條件一錯就是幾小時沒動靜。
 * 「條件要包含它已經死了」寫在記憶 background-wait-filter-traps 裡，每次手寫都靠運氣。規則是請求、機制才是保證。
 *
 * ## 判準
 *
 * 先拿掉確定是資料的部分（寫檔／餵直譯器／git 的 heredoc 本體），再找迴圈：
 *   · `while`／`until` 迴圈本體裡有 `sleep`：擋（前景、背景都擋——前景的一樣在空等，還卡住整個回合）。
 *     `while read …` 是逐行處理，只有背景才擋。
 *   · `for` 迴圈本體裡有 `sleep`：背景就擋；前景估不出、或「次數 × 秒數」超過 120 秒才擋（Bash 前景預設逾時就是 2 分鐘，短的重試放行）。
 * 指令裡已經呼叫 waitfor、或寫了 `# waitfor-ok: <理由>` 就放行。
 *
 * ## 逃生門
 *
 *     touch ~/.claude/skills/home/claude/hooks/wait-guard.off
 *
 * 稽核寫在 wait-guard.log。重播近 N 天真實指令：`node test-wait-guard.mjs --replay 14`。
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendLog } from './lib/log.mjs';
import { cli, isMain } from './lib/hook-cli.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OFF = join(HERE, 'wait-guard.off');
const LOG = join(HERE, 'wait-guard.log');
const WAITFOR = '~/.claude/skills/home/claude/tools/waitfor';

/**
 * heredoc 本體：餵給殼層（bash／sh／zsh／ssh，含 `cat <<EOF | ssh h bash`）的是指令，留著；
 * 其他（cat 寫檔、python、git commit -F -）是資料，拿掉。
 */
export function stripHeredocs(cmd) {
  return cmd.replace(/^([^\n]*?)<<-?\s*(['"]?)(\w+)\2([^\n]*)\n[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/gm, (all, head, _q, _tag, rest) => {
    const seg = head.split(/&&|\|\||[;|(]/).pop().trim();
    const prog = (seg.split(/\s+/)[0] ?? '').replace(/^.*\//, '');
    const shell = /^(bash|sh|zsh|dash|ssh)$/.test(prog) || /\|\s*(?:\S*\/)?(?:bash|sh|zsh|dash|ssh)\b/.test(rest);
    return shell ? all : `${head}${rest}`;
  });
}

const LITERAL = new Set(['echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg', 'jq']);
const SEP = new Set([';', '\n', '&', '|', '(', ')', '{', '}', '`']);

/**
 * 由左到右掃一遍，把「echo／printf／grep… 的引號參數」換成空白——`grep -E 'while|sleep'` 只是字。
 * 其他引號（ssh "…"、bash -c '…'）的內容是指令，保留，引號本身換成 `;` 當段落分隔。
 * 線性時間：hook 是同步的，回溯爆掉會卡住整個 dispatch、連前面幾支 guard 的 deny 一起丟（PR #70 審查）。
 */
export function maskQuotes(c) {
  let out = '', segStart = 0;
  for (let i = 0; i < c.length; i++) {
    const ch = c[i];
    if (ch === '\\') { out += c.slice(i, i + 2); i++; continue; }
    if (ch === "'" || ch === '"') {
      let j = i + 1;
      while (j < c.length && c[j] !== ch) { if (ch === '"' && c[j] === '\\') j++; j++; }
      const first = out.slice(segStart).trim().split(/\s+/).find((w) => !/^\w+=/.test(w)) ?? '';
      const inner = c.slice(i + 1, j);
      // 內容有 $(…)／反引號就是指令替換，不能當成字清掉
      const literal = LITERAL.has(first.replace(/^.*\//, '')) && !/\$\(|`/.test(inner);
      out += literal ? ' '.repeat(inner.length + 2) : `;${inner};`;
      i = j;
      continue;
    }
    if (SEP.has(ch)) segStart = out.length + 1;
    out += ch;
  }
  return out;
}

const DUR = { '': 1, s: 1, m: 60, h: 3600 };
/** `for x in …` 的次數；估不出來回 null。 */
export function forCount(head) {
  let m = /\bin\s+\$\(\s*seq\s+(?:(\d+)\s+)?(\d+)\s*\)/.exec(head);
  if (m) return Number(m[2]) - Number(m[1] ?? 1) + 1;
  m = /\bin\s+\{(\d+)\.\.(\d+)\}/.exec(head);
  if (m) return Number(m[2]) - Number(m[1]) + 1;
  m = /\(\(\s*\w+\s*=\s*(\d+)\s*;\s*\w+\s*<(=?)\s*(\d+)/.exec(head);
  if (m) return Number(m[3]) - Number(m[1]) + (m[2] ? 1 : 0);
  m = /\bin\s+([^;\n$`(*]*)\s*(?:[;\n]|$)/.exec(head);
  if (m && m[1].trim()) return m[1].trim().split(/\s+/).length;
  return null;
}

/** 前一個字是這些，下一個字就在指令位置。 */
const LEAD = new Set(['do', 'then', 'else', 'elif', 'if', '!', 'while', 'until', 'time', 'nohup', 'exec']);
const MAXLEN = 50000;

/** 回傳擋下的理由種類，放行回 null。 */
export function classify(cmd, background = false) {
  if (typeof cmd !== 'string' || cmd.length > MAXLEN || !/\bsleep\b/.test(cmd) || !/\b(?:while|until|for)\b/.test(cmd)) return null;
  if (/#\s*waitfor-ok\b/.test(cmd) || /(?:^|[;&|(\n]\s*)(?:\S*\/)?waitfor\s+-/.test(cmd)) return null;
  const c = maskQuotes(stripHeredocs(cmd));
  // 一個字一個字走：do／done／sleep 只認指令位置（`ls ~/q/done/$J` 的 done 是路徑）；do 深度加一、done 減一，巢狀迴圈也對得上。
  const stack = [];
  // lastSep：do／done 只認 `;`、換行、`&` 之後（`case … in running|done|failed)` 的 done 前面是 `|`，不是迴圈結尾）
  let prevWord = null, prevSep = true, lastSep = ';';
  const tok = /([A-Za-z_][\w.-]*|!)|(\s+)|(.)/gs;
  let m, pendingSleep = false;
  while ((m = tok.exec(c))) {
    const [t, word, space, other] = m;
    if (space !== undefined) { if (space.includes('\n')) { prevSep = true; prevWord = null; lastSep = '\n'; } continue; }
    if (other !== undefined) {
      if (SEP.has(other)) { prevSep = true; prevWord = null; lastSep = other; } else if (other !== '/') { prevSep = false; prevWord = null; }
      continue;
    }
    const atCmd = prevSep || (prevWord !== null && LEAD.has(prevWord));
    const kwPos = atCmd && (prevSep ? ';\n&'.includes(lastSep) : true);
    const top = stack[stack.length - 1];
    if (atCmd && (word === 'while' || word === 'until' || word === 'for')) {
      stack.push({ kw: word, start: m.index, bodyStart: -1, sleepHead: false, sleepBody: false, secs: 0 });
    } else if (kwPos && word === 'do' && top && top.bodyStart < 0) {
      top.bodyStart = m.index;
      top.head = c.slice(top.start, m.index);
    } else if (kwPos && word === 'done' && top && top.bodyStart >= 0) {
      stack.pop();
      const parent = stack[stack.length - 1];
      if (parent && (top.sleepHead || top.sleepBody)) {
        if (parent.bodyStart >= 0) { parent.sleepBody = true; parent.secs = null; } else parent.sleepHead = true;
      }
      const kind = verdict(top, background);
      if (kind) return kind;
    } else if (word === 'sleep' && top) {
      if (top.bodyStart >= 0) { top.sleepBody = true; pendingSleep = true; } else { top.sleepHead = true; top.secs = null; }
    }
    // sleep 後面的秒數直接往後看（數字開頭不是 word）；`sleep $S` 估不出來
    prevWord = word; prevSep = false;
    if (pendingSleep && top) {
      const rest = /^\s+(\d+(?:\.\d+)?)([smh]?)(?=[\s;&|)]|$)/.exec(c.slice(tok.lastIndex));
      top.secs = top.secs === null ? null : rest ? top.secs + Number(rest[1]) * DUR[rest[2]] : null;
      pendingSleep = false;
    }
  }
  return null;
}

function verdict(loop, background) {
  if (loop.kw === 'for') {
    if (!loop.sleepBody) return null;
    if (background) return 'for-bg';
    const n = forCount(loop.head);
    return n == null || loop.secs == null || n * loop.secs > 120 ? 'for-long' : null;
  }
  if (!loop.sleepHead && !loop.sleepBody) return null;
  if (/^(?:while|until)\s+(?:IFS=\S*\s+)?read\b/.test(loop.head) && !background) return null;
  return loop.kw;
}

const REASON =
  '【自動檢查】不准手寫輪詢迴圈（until／while／for 加 sleep）：條件寫錯或程序崩潰時會安靜地空轉到上限' +
  '（2026-10-25 `ls done/J failed/J && break` 永遠不成立，白等 2 小時）。改用 waitfor，失敗和程序死掉都會退出：\n' +
  `  ${WAITFOR} --every 60 --max 3h --fail '<失敗時 exit 0 的指令>' [--pid <pid>] -- <成功時 exit 0 的指令> && <接著要做的事>\n` +
  '例：--fail "ssh mani-ts \'test -d ~/q/failed/$J\'" -- ssh mani-ts "test -d ~/q/done/$J"（遠端指令整段包引號，不然 ~ 會在本機展開）。' +
  '用 Bash 的 run_in_background 跑，結束時會自動叫醒你。\n' +
  '· 等的是自己的背景任務（tasks/*.output）：不用輪詢，它結束時本來就會叫醒你，回合直接結束。\n' +
  '· 要每次有變化都通知（盯幾小時的監看）：用 Monitor 工具，不要寫長迴圈。\n' +
  '· 真的不是在等東西（例如限速的批次、送按鍵中間的停頓）：指令裡加 `# waitfor-ok: <理由>`。';

/** 回 null＝放行。這支壞掉不該擋住任何指令（dispatch 會吃掉例外）。 */
export function run(input) {
  if (existsSync(OFF)) return null;
  const cmd = input?.tool_input?.command;
  const bg = Boolean(input?.tool_input?.run_in_background);
  const kind = classify(cmd, bg);
  if (!kind) return null;
  appendLog(LOG, { at: new Date().toISOString(), session: input?.session_id, kind, bg, cwd: input?.cwd, cmd: String(cmd).slice(0, 400) });
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: REASON,
    },
  };
}

if (isMain(import.meta.url)) cli(run);
