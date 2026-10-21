#!/usr/bin/env node
// ask-hides-prose.mjs 的案例表：node test-ask-hides-prose.mjs（全過離開碼 0）
// 載入本尊的 run，不另外抄正規式。HOOK_NOLOG 讓測試不寫進稽核 log。
process.env.HOOK_NOLOG = '1';
const { run } = await import('./ask-hides-prose.mjs');

const BLOCK = true, PASS = false;
const cases = [
  // 真的在問「做了沒」
  [BLOCK, '你跑完了嗎？'],
  [BLOCK, '指令貼上了嗎？'],
  [BLOCK, '你做了沒？'],
  [BLOCK, '弄好了沒？'],
  [BLOCK, '你那邊設定好了嗎？'],
  [BLOCK, '你有沒有重啟 Claude？'],
  [BLOCK, 'Did you run the command?'],
  [BLOCK, 'Have you pasted the token yet?'],
  // 2026-10-10～10-20 被舊版擋下的 12 題（opt/bench/ahp.py 抓的），一題都不是在問做了沒
  [PASS, '產線那一段要做到多大？（測試集給提案者看、保留集留著驗有沒有只是背答案）'],
  [PASS, '產線 8 輪跑完：合進 5 題（第 4–8 題），都已推上去，改的是網頁與伺服器，選單列 app 沒動。產線要不要接著跑？'],
  [PASS, '產線剩下的 8 輪大約明早 9 點跑完，之後 desk 白天只剩影片切片（GPU 多數低於 10%）。要不要多排幾輪，把明天白天也填滿？'],
  [PASS, '第 4 題：驗證「真的通用」要拿什麼試接？（驗收會是：只寫一個設定檔、不改 autoloop 程式就能跑完 3 輪）'],
  [PASS, '創角畫面做好了，已推到 block/b13-creator（cafafce9），三張截圖已經在背景打開。要收嗎？'],
  [PASS, '要爬的是哪個網站？請選「其他」直接貼上網址；不方便給網址的話，先選它屬於哪一類。'],
  [PASS, 'B9 基準輪在總控這邊的驅動程序已經不在了，mani 的保留集還在跑（GPU 100%），但跑完沒人收結果，要怎麼處理？'],
  [PASS, '體型那個 session 說第 18 輪還要 1～1.5 小時，接著另一個 session 會讓 desk 和 Victus 一起跑體型實驗。要等它嗎？'],
  // PR #12 審查實測的漏擋
  [BLOCK, '你按下去了嗎？'],
  [BLOCK, '你設好 token 了嗎？'],
  [BLOCK, '你剛剛有貼嗎？'],
  // PR #12 審查實測的誤擋
  [PASS, '如果你有裝 Docker，選哪個？'],
  [PASS, '你有開發過 Godot 嗎？'],
  [PASS, '分頁可以關了嗎？'],
  [PASS, '要我把 tmux 關了嗎？'],
  [PASS, 'What did you run into?'],
  // PR #12 第二輪審查實測
  [BLOCK, '你有沒有跑「make test」？'],
  [BLOCK, '你按了「允許」嗎？'],
  [BLOCK, '你有沒有登入（GitHub）？'],
  [BLOCK, '你跑完 `npm test` 了嗎？'],
  [PASS, '你有做過類似的專案嗎？'],
  [PASS, '你有設定偏好的編輯器嗎？'],
  [PASS, '你有存檔的習慣嗎？'],
  [BLOCK, '你有沒有跑 run.sh？'],
  [BLOCK, '你貼上了沒呢？'],
  [BLOCK, 'What did you think? Did you run the tests?'],
  // replay 抓到的：問狀態不是問做了沒
  [PASS, '你自己看到完整的，是因為你的瀏覽器有登入嗎？要怎麼做？'],
  // 一般問句
  [PASS, '你要我改嗎？'],
  [PASS, '你覺得要換嗎？'],
  [PASS, '這樣跑完了沒問題嗎？'],
  [PASS, '要不要我先跑一次？'],
];

const ask = (question, preview) => ({
  session_id: 'test', tool_name: 'AskUserQuestion',
  tool_input: { questions: [{ question, options: [{ label: 'a', ...(preview ? { preview } : {}) }, { label: 'b' }] }] },
});
const denied = (o) => o?.hookSpecificOutput?.permissionDecision === 'deny';

let fail = 0;
const check = (ok, label) => { if (!ok) fail++; console.log(`${ok ? '✓' : '✗'} ${label}`); };
for (const [want, q] of cases) check(denied(run(ask(q))) === want, `${want ? '擋' : '放'}  ${q.slice(0, 60)}`);
check(!denied(run(ask('你跑完了嗎？', 'cd ~/x && ./run.sh'))), '放  問做了沒但 preview 附上要做的內容');
check(!denied(run({ tool_input: { questions: 'x' } })), '放  questions 不是陣列');
check(!denied(run({})), '放  沒有 tool_input');

console.log(fail ? `${fail} 個不對` : `全部 ${cases.length + 3} 個都對`);
process.exit(fail ? 1 : 0);
