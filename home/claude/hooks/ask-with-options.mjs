#!/usr/bin/env node
/**
 * Stop hook —— 回合把決定丟回給使用者、卻沒用 AskUserQuestion 時擋下來。
 *
 * 兩條規則，各自的量測寫在對應的函式上：
 *   1. 收尾是**問句**（`endsWithQuestion`）—— 2026-09-02 立
 *   2. 收尾**最後一句把決定丟回去**但沒有問號（`defersDecision`）—— 2026-09-10 加
 *
 * 全語料實測（1,378 個回合結尾，用這支的真程式碼跑的）：
 *   問號規則 59 次 · 徵詢規則 58 次 · 合計 8.5% 的回合
 *   徵詢規則那 58 次裡，**33 次使用者當時回的是 12 字以內的短句**
 *   （「要」「繼續」「1.2.3」「全部調整」）—— 他在回答，只是被迫用打的。
 *
 * 使用者的規則（2026-08-15 立、2026-09-02 重申並擴大）：
 * **要問就給選項。** 原本記憶寫的是「選擇題一律用 AskUserQuestion」，
 * 我把「要我去查嗎？」這種當成不是選擇題所以沒套用；使用者重申時把範圍
 * 講死了——**任何問句**都要給可上下鍵選取的選項。
 *
 * 實測（掃四台機器的 transcript，1,431 個「助理講完話、使用者接話」的回合）：
 *
 *   以問號結尾的                     232 (16.2%)
 *   其中那一輪有叫 AskUserQuestion      19
 *   純散文問句（該被擋的）             213 (14.9%)
 *   其中長度 > 60 字                  196
 *
 * 而那 213 則的樣本根本就是把選擇題寫成散文清單：
 * 「A. … B. … C. … 選哪個？」——正是這條規則要求停掉的事。
 *
 * **為什麼這個 hook 可行，而「繼續」那個不可行**（見 keep-going.mjs 的量測）：
 * 那個要判斷「剩下的事是不是這次請求的範圍內」，資訊不在文字裡，每個門檻都是
 * 淨負值。這個不用判斷任何語意——照規則，回合以散文問句結尾**沒有正當情況**，
 * 所以誤判趨近於零。唯一的例外是招呼語（「你好，需要我做什麼？」），
 * 全部 ≤60 字，用長度就濾乾淨了。
 *
 * 逃生門：`touch ~/.claude/hooks/ask-with-options.off`
 * 稽核：每次判斷寫進 ask-with-options.log，之後可以實際量它有沒有效。
 */

import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import { appendLog } from './lib/log.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cli, isMain } from './lib/hook-cli.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OFF = join(HERE, 'ask-with-options.off');
const LOG = join(HERE, 'ask-with-options.log');

/**
 * 唯一該放行的兩種問句：開場招呼、以及「你的訊息被截斷了」這類澄清。
 *
 * **不能用長度分**。實測那 213 則裡有 18 則屬於這兩類，長度落在 10–79 字，
 * 而一句完整的中文真問句（「…各有代價。你想走哪一條？」）只有 37 字，
 * 夾在中間。JS 的 `.length` 對中文是字元數不是位元組，中文問句天生就短。
 * 第一版用 MIN_LEN=60 就是這樣把真問句放掉的。
 */
const GREETING = [
  /^(hi|hey|hello|good morning|morning|yo)\b/i,
  /^(你好|哈囉|嗨|早安|早)/,
  /(what can i do for you|what are we (doing|working on)|what's up|how can i help)/i,
  /(需要我做什麼|需要幫忙|有什麼(我)?能幫)/,
  /(message got cut off|didn'?t come through|訊息.{0,6}截斷|只收到|沒收到內容)/i,
];
/** 招呼語再長也就這樣。超過就不是招呼了，是夾帶一句 hey 的真問題。 */
const GREETING_MAX = 120;

/** 去掉圍欄程式碼與行內程式碼——裡面的問號不是助理在問。 */
const stripCode = (s) => s
  .replace(/```[\s\S]*?```/g, ' ')
  .replace(/~~~[\s\S]*?~~~/g, ' ')
  .replace(/`[^`\n]*`/g, ' ');

/** 結尾是不是問句。尾巴的 markdown 裝飾與收尾括號要先剝掉。 */
function endsWithQuestion(s) {
  const tail = stripCode(s).replace(/[\s*_>#\-–—·)）」』"']+$/g, '');
  return /[?？]$/.test(tail);
}

/**
 * 沒有問號、但**把決定丟回給使用者**的收尾。
 *
 * 「要推請說一聲。」「那要你點頭我才動。」「要我做 2 或 3 就說一聲。」——
 * 這些是徵詢，只是寫成了陳述句，所以上面那條問號規則完全攔不到。
 * 使用者的規則本文就寫著：**不要把問句改寫成不加問號的陳述句去閃過檢查。**
 *
 * ## 為什麼只看最後一句
 *
 * 2026-09-10 拿 1,377 個回合結尾量過，這是整件事的關鍵：
 *
 *   比對範圍            觸發    使用者回 ≤12 字（＝本來可以按一下）
 *   收尾 220 字         40 次   45%
 *   **只看最後一句**    60 次   **58%**
 *
 * 擴到整段收尾會把「正文順帶提到、但結尾其實已經收乾淨」的回合一起抓進來。
 * 決定是不是被丟回去，看的是**最後一句話**，那是使用者實際讀到的收尾。
 *
 * ## 這條規則的成功標準跟上面那條不一樣
 *
 * 不要拿「救回幾次『繼續』」來評價它——同一天量過四個那種門檻
 * （文字比對未完成項目、不帶問號的徵詢、任務清單還有未完成、
 * 宣稱在跑但沒有背景任務），**全部是淨負值**，寫在 keep-going.mjs 檔頭。
 * 這條的目的不是阻止停下來，是讓「停下來的那一次」變成按一下而不是打字：
 * 那 60 次裡有 35 次使用者回的是「要」「繼續」「1.2.3」「全部調整」。
 */
const DEFER = /(要|想|需要)(不要)?(我|你)?[^。！？\n]{0,30}(就)?(說一聲|跟我說|告訴我|你說|點頭|說了算)|(要|想)的話(我)?(可以|再)|需要的話[^。！？\n]{0,20}(可以|再)|隨時(告訴我|跟我說)|(等|待)你(決定|確認|點頭|回覆)|要推(的話)?請?說|let me know|just say the word/i;

/**
 * 「你做完某件事再跟我說」不是丟決定，是請他動手——那種回合本來就該用散文寫完指令結束，
 * 跳框反而把指令蓋掉（見記憶 ask-dialog-hides-prose）。2026-10-02 擋過一次
 * 「Once you've saved the pages, let me know and I'll parse…」，是這支唯一確定的誤判。
 * 動詞只列「明確是他要動手的」，太寬會把「看完跟我說要不要」這種決定一起放掉。
 */
const USER_ACTION = /\b(?:once|after|when) you(?:'ve| have)? (?:saved|installed|logged in|signed in|pasted|downloaded|plugged|run|ran|restarted)\b[^.!?\n]{0,60}\blet me know\b|(?:存好|裝好|登入|貼上|貼好|下載好|下載完|插上|接上|設好|執行完|重開)(?:之後|以後|後|了)?[，, ]{0,2}再?(?:跟我說|說一聲|告訴我)/i;

function defersDecision(s) {
  const clean = stripCode(s)
    .replace(/^\s*\|.*\|\s*$/gm, ' ')          // 表格列：裡面常有「要你確認」這種欄位值
    .replace(/[*_>#]/g, '');
  const sentences = clean.split(/(?<=[。！？.!?])\s*/).map((x) => x.trim()).filter((x) => x.length > 4);
  const last = sentences[sentences.length - 1] || '';
  return DEFER.test(last) && !USER_ACTION.test(last);
}

/** 讀檔案尾巴的 N 個位元組。transcript 可以到幾十 MB，不能整份讀。 */
function tailBytes(file, bytes) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* 已經關了 */ }
  }
}

/**
 * 這一輪（從最後一則使用者訊息到現在）有沒有叫過 AskUserQuestion。
 *
 * 讀不到 transcript 時回 true —— **不確定就放行**。這個 hook 會擋住回合，
 * 誤擋的代價比漏擋高得多。
 */
function askedThisTurn(transcriptPath) {
  if (!transcriptPath || !existsSync(transcriptPath)) return true;
  const text = tailBytes(transcriptPath, 512 * 1024);
  if (!text) return true;

  const lines = text.split('\n');
  lines.shift();                       // 第一行可能被切斷
  for (let i = lines.length - 1; i >= 0; i--) {
    if (!lines[i]) continue;
    let o;
    try { o = JSON.parse(lines[i]); } catch { continue; }
    if (o.isSidechain) continue;

    if (o.type === 'assistant' && Array.isArray(o.message?.content)) {
      if (o.message.content.some((b) => b.type === 'tool_use' && b.name === 'AskUserQuestion')) return true;
    }
    // 往回走到上一則真的使用者訊息就停——再往前是上一個回合了。
    if (o.type === 'user' && !o.isMeta) {
      const c = o.message?.content;
      const real = typeof c === 'string'
        || (Array.isArray(c) && !c.some((b) => b.type === 'tool_result') && c.some((b) => b.type === 'text'));
      if (real) return false;
    }
  }
  return false;
}

// 這兩段會原封不動印在使用者畫面上（「Stop hook error: …」），所以只寫一句要做什麼；
// 量測與理由留在上面的註解。2026-10-19 使用者：「有時候hook會寫一長串東西 不知道在幹麻」。
const DEFER_REASON =
  '【自動檢查】最後一句在等使用者點頭。不是重大事件（不可逆／花錢／對外發布／要密碼）就直接做完；' +
  '真要他決定才用 AskUserQuestion 給選項。';

const REASON =
  '【自動檢查】以問句收尾。能自己判斷就直接做並說明選了什麼；真要他決定才用 AskUserQuestion 給選項。';

/** 回 null＝放行。任何沒預期到的錯誤也要變成放行（由呼叫端接住）：這支會擋住回合，壞掉的最壞後果必須是「回到現在的狀態」。 */
function run(input) {
  if (existsSync(OFF)) return null;
  if (!input) return null;

  if (input.stop_hook_active) return null;                  // 一個回合只擋一次
  if (input.stop_reason && input.stop_reason !== 'end_turn') return null;

  const msg = input.last_assistant_message || '';
  const asQuestion = endsWithQuestion(msg);
  const asDeferral = !asQuestion && defersDecision(msg);
  let why = null;
  if (!msg.trim()) why = 'empty';
  else if (!asQuestion && !asDeferral) why = 'not-a-question';
  else if (msg.length <= GREETING_MAX && GREETING.some((re) => re.test(msg.trim()))) why = 'greeting-or-clarify';
  else if (askedThisTurn(input.transcript_path)) why = 'already-used-AskUserQuestion';

  {
    appendLog(LOG, {
      at: new Date().toISOString(),
      session: input.session_id,
      decision: why ? 'pass' : 'BLOCK',
      // 兩條規則分開記，之後才量得出各自的命中與誤判。
      // 合在一起記的話，過一陣子就分不出哪一條在做事、哪一條該調。
      why: why ?? (asQuestion ? 'prose-question-without-options' : 'deferral-without-options'),
      len: msg.length,
      tail: msg.slice(-140).replace(/\s+/g, ' '),
    });
  }

  if (why) return null;

  // **兩種形狀一起吐**，因為這支同時掛在 Claude Code 與 Codex 上，而兩邊的
  // Stop 收的欄位不一樣：
  //   · Claude Code   hookSpecificOutput.permissionDecision = "deny"（實測有效）
  //   · Codex 0.152   Stop 走 BlockDecisionWire，也就是 { decision, reason }
  //     （二進位檔裡 hookSpecificOutput*Wire 只有 PreToolUse／PostToolUse／
  //      SessionStart／SubagentStart／UserPromptSubmit／PermissionRequest 六種，
  //      **沒有 Stop**；Stop 那一個是 StopCommandOutputWire + BlockDecisionWire）
  // 兩邊都會忽略自己不認得的鍵，所以同時給是安全的，而只給一種就會在另一邊
  // **安靜地不擋**——那正是最糟的失敗方式：看起來有守衛，其實沒有。
  const reason = asQuestion ? REASON : DEFER_REASON;
  return {
    decision: 'block',
    reason,
    hookSpecificOutput: {
      hookEventName: 'Stop',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
      additionalContext: `（一個回合只攔一次；要停用就 touch ${OFF}）`,
    },
  };
}

// 匯出判斷式給測試用。**測試要載入這一份，不要另外抄一份正規式**——
// 抄的那份會慢慢跟本尊分岔，而分岔的時候測試還是綠的。
export { run, endsWithQuestion, defersDecision, GREETING, GREETING_MAX };

// 只有被當成指令直接執行時才跑；被 import 時不跑，否則測試一載入就開始讀 stdin。
// 判斷「是不是直接執行」一定要走 lib/hook-cli.mjs 的 isMain（pathToFileURL）：Windows 上自己拼
// `file://` + argv[1] 永遠不相等，hook 會變成**完全的空操作而且一聲不吭**（2026-09-10 desk 實測）。
if (isMain(import.meta.url)) cli(run);
