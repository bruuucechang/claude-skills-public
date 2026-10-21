#!/usr/bin/env node
/**
 * Stop hook —— 回合用英文收尾就擋下來，要求用繁體中文重寫。
 *
 * ## 為什麼
 *
 * 「一律繁體字」寫在 AGENTS.md 與記憶檔，還是一直發生（2026-10-21 盤點，規格 P3）：
 * 使用者喊「講中文」26 次、跨 20 個 session，被喊之前那一則 12/12 是英文；
 * 每個回合最後一則長文字以英文為主的比例 bruce 17%、peter 27%。規則是請求，機制才是保證。
 *
 * ## 判準
 *
 * 只看 `last_assistant_message`（使用者實際讀到的那一則）。先拿掉不是散文的部分——
 * 圍欄程式碼、行內 code、網址、路徑、檔名、識別字（含 `_`／`.`／`=`／數字的字）、表格的分隔列——
 * 剩下的數「中日韓字」與「拉丁字母」：
 *
 *     拉丁字母 > RATIO × 中日韓字，而且
 *       （拉丁字母 > MIN_LATIN，或 中日韓字 ≤ SHORT_CJK 而 拉丁字母 > SHORT_LATIN）   →   擋
 *
 * 第二行是為了短的狀態回報（「Waiting on the push.」只有十幾個字母，近 14 天有一百多則）。
 * 只放寬到「幾乎沒有中文字」：短的中文回報（「等 reviewer、net-check／pad／play 與佔位推送。」
 * 6 個中文字、23 個字母）比例也過 3 倍，靠字母數才放得過。
 *
 * RATIO／MIN_LATIN 用近 14 天兩個帳號的 transcript 校準（`node replay-p3.mjs lang 14`，數字寫在 PR 內文）。
 * 中文回報裡夾英文術語（hook、worktree、commit）很正常：一個英文字 5～8 個字母，只抵得上一兩個中文字，
 * 所以門檻用「字母是中文字的好幾倍」而不是「中文佔一半」。
 *
 * ## 不擋的情況
 *
 * - `stop_hook_active`：這個回合已經被某支 Stop hook 擋過一次（跟 ask-with-options 同一條規則，一回合最多擋一次，
 *   不會跟它來回打架；兩支同時擋時 dispatch 會把兩個理由串在一起）。
 * - `stop_reason` 不是 `end_turn`。
 * - 非互動（`CLAUDE_CODE_ENTRYPOINT` 是 `sdk-*`，例如 `claude -p`）：輸出是給程式或派工的 Claude 讀的，
 *   有的還要 JSON，擋了會把產線弄壞。子代理走 SubagentStop，不經過這支。
 *
 * 逃生門：`touch ~/.claude/skills/home/claude/hooks/lang-guard.off`
 * 稽核：只記擋下的那幾次，寫在 lang-guard.log。
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendLog } from './lib/log.mjs';
import { cli, isMain } from './lib/hook-cli.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OFF = join(HERE, 'lang-guard.off');
const LOG = join(HERE, 'lang-guard.log');

export const RATIO = 3;
export const MIN_LATIN = 60;
/** 短的狀態回報（「Waiting on the push.」「Round 5 started.」）：幾乎沒有中文字時，字母少也算英文。 */
export const SHORT_CJK = 2;
export const SHORT_LATIN = 10;

/** 拿掉 code、網址、路徑、指令、識別字之後剩下的散文。 */
export function prose(text) {
  return String(text ?? '')
    .replace(/```[\s\S]*?(?:```|$)/g, ' ')                 // 圍欄程式碼（沒收尾的也算到結尾）
    .replace(/~~~[\s\S]*?(?:~~~|$)/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')                            // 行內 code
    // 不刪縮排的行與引用：清單續行、`> …` 引用裡的英文散文都要算（PR #11 兩輪審查）；程式碼一律應該在圍欄裡
    .replace(/\]\([^)]*\)/g, ']')                           // markdown 連結的網址
    // 網址與路徑只吃到 ASCII 為止：中文句子沒有空白，用 \S 會把網址後面整句中文一起吃掉（重播實測）
    .replace(/\b[a-z][\w+.-]*:\/\/[\x21-\x7e]+/gi, ' ')    // 網址
    .replace(/(?:^|[\s(（「])[~.]?\/[\x21-\x7e]*/g, ' ')        // 路徑
    .replace(/\S*[\\/_=@#:.]\S*[A-Za-z0-9]\S*/g, (m) => (/[一-鿿]/.test(m) ? m.replace(/[A-Za-z0-9_./\\=@#:-]+/g, ' ') : ' ')) // 檔名、識別字、key=值
    .replace(/\b(?=\w*\d)\w+\b/g, ' ')                     // 帶數字的字（hash、版本、PR 號）
    .replace(/^\s*\|?[\s:|-]+\|?\s*$/gm, ' ');              // 表格分隔列
}

const CJK = /[぀-ヿ㐀-䶿一-鿿豈-﫿]/g;

/** { cjk, latin }：散文裡的中日韓字數與拉丁字母數。 */
export function counts(text) {
  const p = prose(text);
  return { cjk: (p.match(CJK) || []).length, latin: (p.match(/[A-Za-z]/g) || []).length };
}

/** Claude Code 自己塞的系統訊息（額度用完、API 錯誤），不是模型寫的，擋了也只會再撞一次。 */
export const SYSTEM = /^\s*(?:You've hit your|You're out of|API Error|Prompt is too long|Credit balance is too low|Claude AI usage limit|Request timed out|\[Request interrupted)/i;

/** 拿掉表格的列（`|` 開頭）：表格常是一整欄中文名詞，會把旁邊的英文散文平均掉。 */
export function outsideTables(text) {
  return String(text ?? '').replace(/^\s*\|.*$/gm, ' ');
}

const english = ({ cjk, latin }, ratio, minLatin) =>
  latin > ratio * cjk && (latin > minLatin || (cjk <= SHORT_CJK && latin > SHORT_LATIN));

/** 表格以外的散文少於這麼多字（中日韓字＋字母），就退回整則一起算（整則幾乎都是表格的回報）。 */
export const MIN_PROSE = 20;

/**
 * 這一則是不是以英文為主。語言看**表格以外的散文**：
 * 2026-10-21 一則英文散文夾一張 34 列中文地名對照表，整則算中日韓字約 300、放行了，使用者只好又喊「講中文」。
 * 反過來，中文散文配一張 API 原文的英文表格是正常的，不該擋。
 */
export function isEnglish(text, ratio = RATIO, minLatin = MIN_LATIN) {
  if (SYSTEM.test(String(text ?? ''))) return false;
  const out = counts(outsideTables(text));
  return english(out.cjk + out.latin >= MIN_PROSE ? out : counts(text), ratio, minLatin);
}

// 會原封不動印在使用者畫面上，只寫一句要做什麼（2026-10-19「hook 會寫一長串東西不知道在幹麻」）。
const REASON = '【自動檢查】剛才的回報以英文為主。照原意用繁體中文重寫一次（程式碼、路徑、指令維持原文，不要加新的問句）。';

/** 回 null＝放行。壞掉的最壞後果必須是「回到沒有這支的狀態」。 */
export function run(input) {
  if (existsSync(OFF)) return null;
  if (!input || input.stop_hook_active) return null;
  if (input.stop_reason && input.stop_reason !== 'end_turn') return null;
  if (/^sdk/i.test(process.env.CLAUDE_CODE_ENTRYPOINT || '')) return null;
  const msg = input.last_assistant_message || '';
  if (!isEnglish(msg)) return null;
  const c = counts(msg);
  appendLog(LOG, { at: new Date().toISOString(), session: input.session_id, ...c, len: msg.length, tail: msg.slice(-140).replace(/\s+/g, ' ') });
  // 兩種形狀一起給：Claude Code 看 hookSpecificOutput、Codex 看 decision（同 ask-with-options 的說明）
  return {
    decision: 'block',
    reason: REASON,
    hookSpecificOutput: { hookEventName: 'Stop', permissionDecision: 'deny', permissionDecisionReason: REASON },
  };
}

if (isMain(import.meta.url)) cli(run);
