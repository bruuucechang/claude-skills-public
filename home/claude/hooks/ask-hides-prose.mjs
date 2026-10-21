#!/usr/bin/env node
/**
 * PreToolUse(AskUserQuestion) —— 擋「叫他去做事、再用對話框問做了沒」。
 *
 * 2026-10-15 實測：AskUserQuestion 的對話框會**蓋住同一則訊息裡寫在它前面的文字**，
 * 而且那段文字連 transcript 都不記（搜原文 0 筆）。所以「先寫指令、再跳框問跑好了沒」
 * 等於他只看到框、看不到指令。使用者原話：「上面一大串都遮住一直問我有沒有做」。
 *
 * 因為前文不進 transcript，這支沒辦法檢查「前面有沒有寫東西」，只能看框本身：
 * 問的是「你做了沒／跑好了沒」，而且框裡沒有附上要做的內容（preview）→ 擋。
 *
 * ## 只認「問他做完了沒」的問法（2026-10-21 收緊）
 *
 * 舊版的詞表收了 `有沒有|跑完|貼上|做好了|完成了嗎`，那些在陳述句裡太常見：近 10 天擋下 12 次（那 12 題在 test-ask-hides-prose.mjs 的案例表裡），
 * 沒有一次是真的在問做了沒（「產線 8 輪跑完：…要不要接著跑？」「請選『其他』直接貼上網址」）。
 * 被擋的 agent 改用散文問，又撞上 Stop 的 ask-with-options，兩支把它夾在中間。
 * 現在只認：第二人稱＋動作＋完成態問句（你跑完了嗎／你貼上了沒／你有沒有重啟），
 * 或不帶「你」但整句就是在問完成（做了沒／貼上了嗎／弄好了沒），以及英文的 did you／have you。
 * 案例表：node test-ask-hides-prose.mjs
 *
 * 稽核：每次擋下寫一行 ask-hides-prose.log（at、sid、問題前 140 字），跟其他 hook 同格式。
 * 逃生門：touch ~/.claude/skills/home/claude/hooks/ask-hides-prose.off
 */
import { existsSync } from 'node:fs';
import { appendLog } from './lib/log.mjs';
import { cli, isMain } from './lib/hook-cli.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OFF = join(HERE, 'ask-hides-prose.off');
const LOG = join(HERE, 'ask-hides-prose.log');

/** 叫他做的那類動作（不收 開／關／改／換：「分頁可以關了嗎」「你有開發過嗎」是別的問法）。 */
const ACT = '(?:跑|貼上|貼|做|執行|裝|安裝|設定|設|試|按|輸入|打開|重開|重啟|登入|填|存|弄|處理|操作|更新|下載|上傳|複製)';
/** 句子裡有這些就是在徵求同意或假設，不是問他做完沒。 */
const NOT_DONE_Q = /要我|我來|我先|我把|讓我|可以|能不能|要不要|需要我|如果|的話/;
const DONE_PATTERNS = [
  // 你跑完了嗎／你設好 token 了嗎／你按下去了嗎／你跑完 `npm test` 了嗎（不收「過」：你做過類似的嗎是問經驗）
  new RegExp(String.raw`你們?.{0,10}?${ACT}.{0,30}?(?:完|好|了)(?:「[^」]*」|（[^）]*）|.){0,3}?(?:嗎|沒有?)$`),
  // 你有沒有重啟 Claude／你剛剛有貼嗎／你有沒有跑「make test」（動作後面接「過」或帶「的」是問經驗、習慣；
  // 「你的瀏覽器有登入嗎」問的是狀態，不是叫他做的事）
  new RegExp(String.raw`你們?[^的]{0,6}?有(?:沒有)?${ACT}(?!過)[^的]{0,20}?(?:嗎|沒有?)?$`),
  new RegExp(String.raw`${ACT}(?:完|好)?了(?:沒有|沒|嗎)$`),                                 // 做了沒／貼上了嗎
  new RegExp(String.raw`${ACT}(?:完|好)沒有?$`),                                             // 跑完沒
];
const EN = /\b(?:did|have) you (?:already |just )?(?:run|ran|do|done|paste|pasted|try|tried|install|installed|finish|finished|restart|restarted)\b(?! into| across| out)/i;
const EN_WH = /\b(?:what|which|how|where|why|when)\s+(?:did|have) you\b/i;

/** 是不是在問「你做完了沒」：逐句看問號前的最後一個子句。 */
export function asksIfDone(text) {
  const t = String(text || '');
  for (const sentence of t.split(/[？?]/)) {
    if (EN.test(sentence) && !EN_WH.test(sentence)) return true;
    // 「」（）不當分隔：問句常引用指令或按鈕名稱（你按了「允許」嗎）
    const clause = sentence.split(/[，,。；;：:！!\n]/).pop().trim().replace(/[呢啊呀啦]+$/, '');
    if (!clause || NOT_DONE_Q.test(clause)) continue;
    if (DONE_PATTERNS.some((re) => re.test(clause))) return true;
  }
  return false;
}

export function run(input) {
  if (existsSync(OFF)) return null;
  const qs = input?.tool_input?.questions ?? [];
  if (!Array.isArray(qs)) return null;

  const bad = qs.find((q) => asksIfDone(q?.question) && !(q?.options || []).some((o) => (o?.preview || '').trim()));
  if (!bad) return null;
  appendLog(LOG, { at: new Date().toISOString(), sid: String(input?.session_id ?? '').slice(0, 8), question: String(bad.question).slice(0, 140) });

  const reason =
    'AskUserQuestion 的對話框會蓋住你這則訊息前面寫的所有文字（使用者看不到，transcript 也不記）。' +
    '你正在問他「做了沒」，但他根本沒看到要做什麼。\n' +
    '· 要他去做事 → **不要跳框**，用散文把完整指令寫出來就結束回合，等他回來說好了。\n' +
    '· 真的非用框不可 → 把要貼的指令／要做的步驟整段放進選項的 preview。';
  return {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  };
}

if (isMain(import.meta.url)) cli(run);
