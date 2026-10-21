#!/usr/bin/env node
// ask-with-options.mjs 的判斷式案例表：node test-ask-with-options.mjs（全過離開碼 0）
// 載入本尊的判斷式，不另外抄正規式（抄的那份會分岔，而分岔時測試還是綠的）。
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { endsWithQuestion, defersDecision } from './ask-with-options.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BLOCK = true, PASS = false;
const cases = [
  [BLOCK, '兩條路各有代價。你想走哪一條？'],
  [BLOCK, '測試都過了。要推的話跟我說一聲。'],
  [BLOCK, '做完了。要的話我可以再補測試。'],
  [BLOCK, 'Done. Let me know if you want me to push.'],
  [BLOCK, '要換的話，看完核對頁之後跟我說。'],
  [PASS, '已經推上去了，commit abc123。'],
  [PASS, '指令在上面。Once you\'ve saved the pages, let me know and I\'ll parse them.'],
  [PASS, '照上面三步裝好之後跟我說，我接著設定。'],
  [PASS, '在終端機貼上那行，登入之後跟我說。'],
  [PASS, '`要不要？` 是程式碼裡的字串，不是問句。'],
];

// ask-with-options.log 每一筆歷史 BLOCK 逐筆標過（log 只存最後 140 字，判斷只看最後一句所以夠用）
// 公開版沒有這份（是真實對話的片段），缺了就只跑上面的案例
const HIST = join(HERE, 'test-ask-with-options.history.json');
const history = existsSync(HIST) ? JSON.parse(readFileSync(HIST, 'utf8')) : [];
for (const h of history) cases.push([h.block, h.tail, h.note]);

let fail = 0;
for (const [want, text, note] of cases) {
  const got = endsWithQuestion(text) || defersDecision(text);
  const ok = got === want;
  if (!ok) fail++;
  console.log(`${ok ? '✓' : '✗'} ${want ? '擋' : '放'}  ${note ?? text.slice(-70)}`);
}
console.log(fail ? `${fail} 個不對` : `全部 ${cases.length} 個都對`);
process.exit(fail ? 1 : 0);
