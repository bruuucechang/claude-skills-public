#!/usr/bin/env node
/**
 * ⚠️ 這個 hook **沒有裝進 settings.json，而且不該裝**。留著是為了不要有人再想一次。
 *
 * 2026-09-02 建出來之後拿 1,408 組真實的「助理訊息 → 使用者回覆」配對量過，
 * 每一個門檻都是淨負值（命中 = 救回的「繼續」，誤判 = 本來該讓它收工卻被擋）：
 *
 *   規則                          命中/95   誤判/1313   誤判率   淨效益
 *   原始版（寬鬆的第一人稱樣式）        31       245     18.7%    -214
 *   只看收尾 200 字                 10        48      3.7%     -38
 *   只看收尾 150 字＋最強樣式           6         9      0.7%      -3
 *   改抓「未完成項目」                13        76      5.8%     -63
 *   改抓「要我…就說一聲」               6        26      2.0%     -20
 *   兩者合併                       19        98      7.5%     -79
 *
 * **為什麼不可能成功**：同一句「剩下 A、B」既出現在使用者樂意收工的回合，
 * 也出現在他想要繼續的回合。差別在於那些剩下的事是不是這次請求的範圍內——
 * 那個資訊不在助理的文字裡，正規式看不到。
 *
 * 另外，把 95 則「繼續」前的訊息實際分類之後，Stop hook 本來就治不了大半：
 *   34% 宣告完成但列著沒做的（可偵測，但誤判太高）
 *   35% 其他（多半是「要我…就說一聲」的自我設限徵詢）
 *   17% 在等背景長工 —— 擋了只會再說一次「還在跑」，要治得用背景任務＋Monitor
 *    7% 問句 —— 本來就該停
 *    5% 自述下一步然後停手 —— 我原本以為這是大宗，其實只有 5 則
 *    2% API 過載，使用者在叫它重試
 *
 * ── 2026-09-10 又測了兩個門檻，一樣是淨負值。四個了，不要再試第五個 ──
 *
 *   門檻                                          命中/110   誤判/1263   淨
 *   還有未完成任務（讀 transcript 重建任務清單）        3         84      -81
 *   宣稱「還在跑」但沒有活著的背景任務                  0         10      -10
 *
 * 第一個原本最有希望：2026-09-02 的結論說「範圍資訊不在文字裡」，那它應該
 * 在任務清單裡。**不在**——未完成任務在正當的回合邊界上照樣存在，
 * 而且 137 個 session 裡只有 11 個真的在用任務清單。
 *
 * 第二個是 0 命中：真的有背景任務在跑的時候 harness 會自動叫醒，
 * 使用者本來就不需要打字。那 94 個「等長工」的收尾不是造成「繼續」的那一批。
 *
 * ── 2026-09-10 第五個門檻：ScheduleWakeup 空等。一樣不裝 ──
 *
 * 起因：使用者看到另一個 session「明明可以繼續卻用散文收尾」。查下去發現那不是
 * Stop 的問題——它呼叫了 ScheduleWakeup 排 1500 秒，而要做的第二、三項是本機
 * 逐筆查證的工作，沒有任何外部狀態要等。這是前四個門檻沒涵蓋的切角。
 *
 * 掃全部 138 個 transcript（1.1 GB），只有 3 個 session 用過 ScheduleWakeup，
 * 共 44 次。用「醒來後前 6 個動作」當事實標準分類：
 *
 *   24  真的在等外部（多半是 35 分鐘的建圖，背景等待器掛著）
 *   13  看不出來
 *    6  空等（醒來直接改檔／跑本機測試）—— 合計浪費 30 分鐘
 *    1  還沒醒
 *
 *   候選規則                                    命中/44   誤判   淨
 *   delay ≥ 300s 且 reason 沒指名在等什麼           0        1    -1
 *
 * **為什麼 0 命中**：那 6 次空等的 reason 寫的是「先讓 NAVITIME 的額度退掉」
 * 「備援心跳」，跟真的在等的講法一字不差。文字分不開，跟 2026-09-02 的結論同源。
 *
 * 唯一可能分得開的是客觀訊號：**呼叫當下有沒有活著的背景任務**。
 * 但那**沒辦法從 transcript 事後重建**——`<task-id>` 也出現在 Agent 工具的通知裡，
 * 重建出來的完成數（1326）比啟動數（565）還多，儀器自己先壞了。
 * 要量這個得在呼叫當下記，不是回頭掃。
 *
 * 所以：**第五個也不裝。** 真要往下走，下一步是先加一個只記錄不擋的 PreToolUse
 * 探針，累積幾週再評估——不要在沒有那份資料之前直接裝擋的。
 *
 * ── 2026-09-18 第六個：**根本沒上弦**（不是門檻問題，是漏呼叫） ──
 *
 * trip-atlas の `/loop` で、使用者に 5 回「繼續」を打たせた。調べたら
 * **`ScheduleWakeup` を一度も呼んでいなかった。**
 *
 * `/loop` は interval を書かなければ dynamic モードで、skill の手順は
 * 「回合の最後の動作として `ScheduleWakeup` を呼び、同じ prompt を渡す」。
 * 呼ばなければ**その回で迴圈が死ぬ**——背景タスクの通知で起きることは在るが、
 * それが尽きたら二度と自分では動かない。使用者が打つしかない。
 *
 * **これは門檻の話ではない。** 上の五つは「停まるべきかどうかの判定」が
 * 難しいという話だったが、これは判定以前——**再武装そのものを忘れていた**。
 * 正規式でも背景タスクの有無でも検出できない種類の抜け。
 *
 * だから Stop hook の出番でもない。**skill が渡している機構を使う**だけ。
 * 逆に言えば、`/loop` の dynamic モードで散文で終わっているのを見たら、
 * まず「ScheduleWakeup を呼んだか」を疑うこと——呼んでいなければ
 * 迴圈は生きていない。
 *
 * （2026-09-10 の第五個は「呼んだが空等」だった。今回は「呼んでいない」。
 *   同じ道具の、逆向きの失敗。）
 *
 * ── 那到底該做什麼 ──
 *
 * 2026-09-10 掃 1,373 個回合結尾，「繼續」前一則的實際分布顯示：**多數的停
 * 是對的**（撞到使用者自己的核准規則：推一個沒 commit 過的 repo、rebase 已推
 * 的歷史、超出範圍的清理），錯的只是**問法是散文**，所以他只能打字。
 *
 * 所以方向不是「阻止停下來」，是這兩件：
 *   · 停下來的那一次要變成按一下 → ask-with-options 的 `defersDecision`
 *     （2026-09-10 加，實測會擋 58 次，其中 57% 使用者原本回 ≤12 字）
 *   · 反覆問同幾件事 → 給常設授權，讓它根本不必問
 *
 * 真正該做的還有那些沒有誤判風險的東西（inspect-ui / preflight skill），
 * 以及讓長工用背景任務通知而不是讓使用者去戳。
 *
 * ── 以下是原始設計說明，保留備查 ──
 *
 * Stop hook —— 助理宣告了「接下來要做 X」卻結束回合時，把回合擋下來要它做完。
 *
 * 為什麼需要這個：分析 2026-07-21～09-02 的 139 個 session、1,520 則使用者訊息，
 * 「繼續」類的純推進訊息出現 99 次（佔 6.5%）。看前一則助理訊息的收尾：
 *
 *   56  自述了下一步然後停手（「接著做戰鬥 UI 版面和大地圖 tileset」）
 *   36  宣告完成，但同一則裡還列著沒做完的東西
 *    6  真的在問問題（這種該停，不擋）
 *
 * settings.json 的 SessionStart 早就寫了「DO NOT STOP MID-TASK」，但那是叮嚀：
 * 8/09 那週 9.7%、8/16 掉到 1.9%、8/23 又回到 8.4%。純文字指示會被稀釋，
 * 所以改成機制。
 *
 * 設計原則：**寧可漏擋，不可誤擋。** 誤擋的代價是使用者沒辦法讓它停下來，
 * 那比多打一次「繼續」糟得多。所以問句一律放行、第二人稱一律放行、
 * 一個回合最多只擋一次、而且任何錯誤都 fail-open。
 *
 * 逃生門：`touch ~/.claude/hooks/keep-going.off` 就整個停用。
 * 稽核：每次判斷都寫進 keep-going.log，之後可以實際量命中率與誤判，
 * 不要重蹈「以為 hook 有效、其實一週後就退回去」的覆轍。
 */

import { readFileSync, existsSync } from 'node:fs';
import { appendLog } from './lib/log.mjs';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OFF_SWITCH = join(HERE, 'keep-going.off');
const LOG = join(HERE, 'keep-going.log');

/** 放行並結束。所有非「確定要擋」的路徑都走這裡。 */
const pass = () => process.exit(0);

// ── 觸發樣式 ────────────────────────────────────────────
//
// 每一條都對應真實紀錄裡出現過的句型，不是想像出來的。

/** 第一人稱、未來式的自述：「我接著做 X」。 */
const SELF_NEXT = [
  /我(現在|等下|馬上|先)?(就|再|接著|繼續)?(往下|往後)?(去|來)?(做|寫|改|修|補|處理|實作|驗證|跑|加|接|開始)/,
  /我繼續(往下|做|處理)/,
  /接下來(我|由我|就)/,
  /(接著|再來|下一步|下一項|下一個)(做|處理|是|要做|來)/,
  /(先|接著)把[^。\n]{2,30}(做|補|修|改|處理|寫)(完|好|掉)/,
  /\bI(?:'ll| will| am going to)\s+(now\s+)?(do|start|move|continue|fix|implement|add|write|run|check)/i,
  /\bnext(,| up| I)\b/i,
];

/** 明示還有沒做完的東西：「剩下：A・B」「還沒解決的：」。 */
const TODO_LIST = [
  /剩下[的]?\s*[:：]/,
  /^\s*[*#-]*\s*剩下\s/m,
  /還(沒|未)(解決|做|處理|完成|驗|寫|改|補)/,
  /(未完成|待辦|尚未完成|還缺)/,
  /還有\s*\d+\s*(項|個|件|步)/,
  /\b(remaining|still to do|not yet done|todo)\b\s*[:：]/i,
];

/**
 * 一律放行的訊號。這些比觸發樣式優先——它們代表「該停」。
 *
 * 第二人稱是最重要的一條：「接下來**你**可以…」是在給建議，不是自述，
 * 而它跟「接下來我要…」只差一個字。
 */
const NEVER_BLOCK = [
  /(要不要|需不需要|你要|你想|你決定|請你|你來|交給你|由你)/,
  /(接下來|下一步)[^。\n]{0,6}(你|您)/,
  /(確認|同意|批准|拍板)[^。\n]{0,8}[嗎？?]/,
  /(等你|等候|等待你|等你回覆|等你決定|還等你)/,
  /\b(do you want|should I|would you like|let me know|your call)\b/i,
];

/** 去掉圍欄程式碼與行內程式碼——裡面的字不是助理在講話。 */
function stripCode(s) {
  return s
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/~~~[\s\S]*?~~~/g, ' ')
    .replace(/`[^`\n]*`/g, ' ');
}

/** 結尾是不是問句。看的是最後一個非空白、非 markdown 裝飾的字元。 */
function endsWithQuestion(s) {
  const tail = s.replace(/[\s*_>#\-–—·]+$/g, '');
  return /[?？]$/.test(tail);
}

function decide(msg) {
  const text = stripCode(msg || '');
  if (!text.trim()) return { block: false, why: 'empty' };

  // 問句一律放行。它在問你，該停。
  if (endsWithQuestion(text)) return { block: false, why: 'question' };

  // 最後 400 字裡有徵詢訊號就放行——收尾才算數，
  // 中間提過一句「要不要」不代表整則是在徵詢。
  const tail = text.slice(-400);
  const asking = NEVER_BLOCK.find((re) => re.test(tail));
  if (asking) return { block: false, why: 'asking:' + asking.source.slice(0, 24) };

  const self = SELF_NEXT.find((re) => re.test(text));
  if (self) return { block: true, why: 'self-next', pattern: self.source.slice(0, 34) };

  const todo = TODO_LIST.find((re) => re.test(text));
  if (todo) return { block: true, why: 'todo-list', pattern: todo.source.slice(0, 34) };

  return { block: false, why: 'no-match' };
}

const REASON =
  '你剛剛說了接下來要做什麼，然後就結束回合了——沒有做。' +
  '使用者為了這件事打過 99 次「繼續」，每一次都是本來不該存在的來回。\n\n' +
  '現在就把你說要做的做完，不要再宣告一次。' +
  '真的需要使用者決定才能往下時，用 AskUserQuestion 問，' +
  '不要用敘述句結尾然後停手。' +
  '如果那件事其實不在這次的範圍內，就明講「這個我不做，因為…」，也不要含糊帶過。';

async function main() {
  if (existsSync(OFF_SWITCH)) pass();

  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;

  let input;
  try { input = JSON.parse(raw); } catch { pass(); }

  // 已經擋過一次就不再擋。這是官方用來防無限迴圈的旗標，
  // 也是「一個回合最多多推一次」這條上限的實作。
  if (input.stop_hook_active) pass();
  // max_tokens 被截斷不是它自己選擇停的，擋了也沒用。
  if (input.stop_reason && input.stop_reason !== 'end_turn') pass();

  const d = decide(input.last_assistant_message);

  try {
    appendLog(LOG, {
      at: new Date().toISOString(),
      session: input.session_id,
      cwd: input.cwd,
      decision: d.block ? 'BLOCK' : 'pass',
      why: d.why,
      pattern: d.pattern,
      tail: (input.last_assistant_message || '').slice(-180).replace(/\s+/g, ' '),
    });
  } catch { /* 記錄失敗不能影響判斷 */ }

  if (!d.block) pass();

  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'Stop',
      permissionDecision: 'deny',
      permissionDecisionReason: REASON,
      additionalContext:
        `（Stop hook 攔截：偵測到 ${d.why}。一個回合只會攔一次；` +
        `要永久停用就 touch ${OFF_SWITCH}）`,
    },
  }));
  process.exit(0);
}

// 任何沒預期到的錯誤都放行。fail-open 是刻意的：
// 這個 hook 壞掉的最壞後果應該是「回到現在的狀態」，不是「回合結束不了」。
main().catch(() => pass());
