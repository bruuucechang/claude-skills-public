# 規格：hooks 優化（2026-10-20）

使用者原話：「優化我的hooks」。

## 已裁示

| 問題 | 裁示 |
|---|---|
| 方向 | 三個都做：誤擋／漏擋、速度與數量、整理與清理 |
| 範圍 | 連 `~/Projects/session-remote/hooks/report.mjs`、`~/Projects/office/tools/subagent-hook.mjs` 一起優化 |
| log 保留 | 跟對話紀錄一樣 30 天（Claude Code `cleanupPeriodDays` 預設值） |
| 合併 | 同一事件合成一支分派器 |
| 修誤擋的取捨 | 寧可多擋不要漏：只修確定是誤判的，模糊地帶維持擋下 |
| 追加範圍（看完規格後） | 「把其他的設定都一起修一修」：權限 allow／deny、外掛與市集、autoMode 環境描述、專案層設定檔、控制 Codex 的部分 |
| Codex 範圍 | hooks 跟著分派器一起改、整理 `~/.codex/config.toml`、檢查 codex-drive 的驅動流程（cx.py）、「更多」 |

## 現況（2026-10-20 量的）

- `settings.json` 掛了 33 個 hook；每支 node 腳本單獨跑約 20–30ms。
- 每次 Bash 開 4 個程序（作者檢查 inline shell、commit 訊息、搬畫面、session-remote 回報），
  另外每次工具呼叫前後各一次 `report.mjs`，而它每次最多呼叫 12 次 `ps` 找 tty。
- SessionStart 開 7 個、Stop 開 4 個、UserPromptSubmit 開 4 個。
- 作者檢查與 browser_batch 白名單是寫在 settings.json 裡的長 shell；`hooks/git-author-guard.sh` 已有同內容的檔案版（Codex 在用）。
- log 只增不減：`~/.claude/logs/instructions-loaded.jsonl` 3.3MB、`ask-with-options.log` 5851 行、`context-tier.log` 3735 行。
- 已知誤擋：focus-guard 把 heredoc 內文、grep 樣式、sed 取代字串裡的 `open`／`osascript`／Godot 當成指令（`focus-guard.log` 17 筆裡大多是這種）。

## 要做的

1. **分派器 `hooks/dispatch.mjs <事件>`**：每個事件只開一個 node，讀一次 stdin，依 `tool_name` 把輸入交給各檢查。
   - 各檢查改成 `export function run(input)`，同時保留單獨執行的 CLI（Codex 的 `hooks.json` 繼續直接呼叫）。
   - 單一檢查丟例外或逾時就跳過、記一行 log，不拖垮其他檢查；分派器自己出錯一律 exit 0（不能擋死所有 session）。
   - 合併輸出：PreToolUse 任一 deny 就 deny、理由串起來；additionalContext 串起來；Stop 的 block 照原規則。
   - 作者檢查、browser_batch 白名單從 inline shell 改成 JS 放進分派器。
2. **非同步回報維持獨立的 async 掛法**（不阻塞，不併進分派器），但優化：
   - `report.mjs`：tty 依 Claude 的 pid 快取，不再每次跑一串 `ps`。
   - `subagent-hook.mjs`：去掉 settings.json 裡 `[ -f ] && … || true` 那層 shell，改成 node 直接容錯（檔案不存在時也安靜結束）。
3. **log 共用寫入函式**：每天第一次寫入時把 30 天以前的行刪掉；`instructions-loaded` 的 inline jq 改走同一個函式。
4. **修誤擋**：focus-guard 判斷前先拿掉 heredoc 內文與引號內的字串，再看指令本身。
   把 log 裡每一筆歷史擋下都重播一次，逐筆標「該擋／誤擋」；誤擋的寫成測試，該擋的也寫成測試確保不漏。
   ask-with-options 的 84 筆擋下抽查，確定誤判的才修。
5. **清理**：settings.json 只剩分派器與 async 回報兩類掛法；拿掉重複（Bash 的 matcher 現在分兩組）。

6. **權限**：統一寫法、查清楚怪條目（`echo * PB`、`echo * PD*`）的來由、補漏擋；只准變嚴或等價，要放寬的先用選項問。
7. **外掛與市集**：關掉的外掛連市集一起拿掉（可回復：重加市集即可）；查還開著的有沒有在用。
8. **autoMode 環境描述**：對照現況更新機器、工具清單，刪重複；不改信任邊界的定義。
9. **專案層設定檔**：`~/Projects/*/.claude/settings*.json` 裡累積的 allow，只拿掉已被全域涵蓋或指向已不存在路徑的。
10. **Codex**：`~/.codex/hooks.json` 改走分派器（codex-sync.sh 裝）；整理 config.toml（`.bak` 備份檔要刪先問）；
    翻最近派 Codex 的紀錄找 cx.py 卡住／等太久／驗收漏掉的地方修；「更多」＝Codex 的 AGENTS.md、rules、skills 同步也一起對過。

切塊與進度在 `~/.claude/skills/blocks.md`。

## 驗收（全部要過）

- `bash ~/.claude/skills/tests/run.sh` 全綠，加上新寫的誤擋／該擋測試。
- 重播：把各 log 裡的歷史輸入餵給新分派器，決定跟舊的一致，只有本規格列出的誤擋改為放行。
- 量測：每個事件開的程序數、耗時，改前改後各量一次寫進這份檔案的附錄（附重跑指令）。
- 實測：開一個新 Claude session，確認 SessionStart 的提醒有出現；用假作者的 repo 跑 `git commit` 會被擋；`open 檔案`（沒 `-g`）會被擋；Stop 的問句檢查照常。
- Codex：`~/.codex/hooks.json` 原本呼叫的三支腳本單獨跑仍正常。

## 明確不做

- 不改任何檢查的規則本身（例如 commit 訊息必須走 `-F`），只修確定的誤判。
- 不動 Windows 的 hooks（`git-author-guard.ps1`、Windows 的 settings）。
- 不改 session-remote／office 的伺服器端，不拿掉它們的回報事件。
- 不 add 別的 session 在 `~/.claude/skills` 留的未 commit 改動；`settings.json` 已經有別人改的 skillOverrides／plugins／statusLine，只 commit hooks 那段。
- 權限不放寬（要放寬的另外問）；不改 autoMode 的信任邊界。
- 不刪任何 log 以外的資料（Codex 的 `.bak` 也要先問）；log 也只刪 30 天以前的行。

## 附錄 A：改前量測（2026-10-20，MacBook Air）

重跑：`node ~/.claude/skills/home/claude/hooks/bench.mjs 5`（同一事件的掛法並行跑，耗時是等最慢那支的時間）

| 事件 | 同步程序 | async 程序 | 同步總耗時 ms（中位數） |
|---|---|---|---|
| SessionStart | 6 | 1 | 906 |
| UserPromptSubmit | 2 | 2 | 183 |
| Stop | 2 | 2 | 171 |
| PreToolUse(Bash) | 3 | 1 | 158 |
| PreToolUse(Read) | 0 | 1 | 9 |
| PostToolUse(Bash) | 0 | 1 | 6 |
| Notification | 0 | 3 | 5 |

- SessionStart 的 906ms 幾乎全是 `account-check.mjs`：`tools/accounts.mjs` 的 `dirState` 跑 `security find-generic-password`
  與 `claude auth status`，單獨量 745ms（`node -e` 分段計時：import 14、load 14、dirState 745）。H2 要處理：結果正常時快取。
- 單支 node 冷啟動約 20–30ms；分派器能省的是程序數，大頭是 account-check。

## 附錄 B：H1 做了什麼

- `lib/log.mjs` 的 `appendLog`：ask-with-options、focus-guard、commit-message-guard、context-tier、keep-going 五支改用它。
- InstructionsLoaded 從 inline jq 改成 `instructions-log.mjs`（時間欄位改 ISO；舊行的 `+0800` 也認得）。
- 首次修剪：`instructions-loaded.jsonl` 4544 → 4185 行，`ask-with-options.log` 5851 → 4731 行（改前備份在當次 session 的 scratchpad，未進版控）。
- 測試：`node lib/log.test.mjs`，已併進 `tests/run.sh`；把保留天數改成 300 會紅。

## 附錄 C：H2 做了什麼、改後量測（2026-10-20，MacBook Air）

- `hooks/dispatch.mjs <事件>`：SessionStart／UserPromptSubmit／Stop／PreToolUse 各只掛一支；路由表 `ROUTES`。
  各檢查改成 `export run(input)`（共用 `lib/hook-cli.mjs` 的 `cli`／`isMain`），單獨執行照舊（Codex 用）。
- 作者檢查、browser_batch 白名單從 settings.json 的 inline shell 搬成 `git-author-guard.mjs`、`browser-batch-guard.mjs`。
- `account-check.mjs`：查過沒問題快取一小時（`~/.claude/cache/account-check.json`）。
- `isMain` 改成先 realpath：舊版 `ask-with-options` 放在 symlink 路徑底下會整支不跑（重播時在 `/var/folders` 踩到）。
- `HOOK_NOLOG=1` 讓所有檢查不寫稽核 log；`HOOK_TIMING=1` 讓分派器把每支耗時印在 stderr。
- `tools/mount-stop-hook.mjs` 把 `dispatch.mjs … Stop` 也認成「已掛」，不會在 mac 重複掛一支 ask-with-options。

**重播**（`node hooks/replay.mjs d8411d1 3 1000`：最近 3 天 149 份 transcript＋兩份 log 的歷史擋下，舊版逐支開程序、新版走 runChecks）：

| 輸入 | 筆數 | 一致 | 舊版擋 | 新版擋 |
|---|---|---|---|---|
| Bash（相關：git commit／open／osascript／Godot） | 1933 | 1933 | 131 | 131 |
| Bash（其餘抽樣） | 300 | 300 | 0 | 0 |
| AskUserQuestion | 257 | 257 | 10 | 10 |
| Stop | 141 | 141 | 1 | 1 |

（理由全文一字不差才算一致。最近 3 天沒有 browser_batch 呼叫，白名單靠 `test-dispatch.mjs` 驗。）

**量測**（`node hooks/bench.mjs 7`；舊版用 `BENCH_SETTINGS=<d8411d1 的 settings.json>` 在同一時間前後交替量兩輪。
當時機器很忙，光 `node -e 0` 就要 110–310ms，所以只看同一輪裡新舊的相對差，不跟附錄 A 的絕對值比）：

| 事件 | 同步程序 舊→新 | 第 1 輪 ms 舊→新 | 第 2 輪 ms 舊→新 |
|---|---|---|---|
| SessionStart | 6 → 1 | 448 → 239 | 251 → 136 |
| UserPromptSubmit | 2 → 1 | 384 → 192 | 131 → 133 |
| Stop | 2 → 1 | 207 → 152 | 130 → 169 |
| PreToolUse(Bash) | 3 → 1 | 166 → 152 | 128 → 133 |

- 舊版那兩輪已經吃到 account-check 的快取（腳本是新的），附錄 A 的 906ms 裡 ~745ms 是 Keychain 查詢，快取命中時這段是 0。
- Bash／Stop／UserPromptSubmit 的等待時間差不多：舊的掛法本來就並行跑，省下來的是程序數（每次 Bash 前 3 → 1 個），不是等待。
- 實測（新 session，`claude -p --include-hook-events`，假作者 repo）：開場提醒有出現、假作者 commit 被擋、`open` 沒帶 `-g` 被擋、問句收尾被 Stop 擋一次。

## 附錄 D：H3 修了哪些誤擋（2026-10-20）

**focus-guard.log 22 筆**（log 只存前 400 字，全文從 transcript 找回，逐筆標記存在 `hooks/test-focus-guard.history.json`）：

| 判定 | 筆數 | 內容 |
|---|---|---|
| 該擋 | 12 | `open` 沒 `-g`（html／png／Mission Control／`open -b`／旗標在變數裡）、osascript `activate`／`do script`、`"$G" --path`、Godot 沒 `--headless` |
| 誤擋，之前已修好 | 4 | heredoc 內文、grep 樣式字串裡的 `open`／`activate` |
| 誤擋，這次修 | 6 | `G=/…/Godot` 只是賦值被當成執行（4 筆）、`Godot --version` 只印版本（2 筆，實測前景 app 沒變） |

修法：整段只有賦值不算執行；被賦值成 Godot 的變數之後以 `$G`／`"$G"`／`${G}` 執行照樣檢查（不然 `"$G" --path` 會漏擋）；
`--version`／`--help`／`-h` 跟 `--headless` 一樣放行。
replay 另外找到 `G="/…/Godot --headless …"` 把旗標一起包進變數的形狀：判斷時把變數值一起看，值裡沒 `--headless` 照擋。

**ask-with-options.log 39 筆 BLOCK**（標記在 `hooks/test-ask-with-options.history.json`）：確定誤判只有 1 筆——
「Once you've saved the pages, let me know…」是請他動手，照 [[ask-dialog-hides-prose]] 本來就該散文收尾。
加了「做完某個明確動作（存好／裝好／登入／貼上…）再跟我說」的例外。其他 38 筆維持擋下；
像「結果出來再跟你說」雖然被歸成徵詢，但那個回合本身違反「不准說跑完再回報就結束」，擋下是對的。

全 log 4800 筆收尾重算：舊版 0 筆不一致，新版只有上面那 1 筆變放行。重跑（在 `hooks/` 底下）：

```bash
node --input-type=module -e "import {readFileSync} from 'node:fs'; import {endsWithQuestion as q, defersDecision as d} from './ask-with-options.mjs';
for (const l of readFileSync('ask-with-options.log','utf8').split('\n').filter(Boolean)) { const o=JSON.parse(l);
  if (!o.tail || o.why==='empty') continue; if ((q(o.tail)||d(o.tail)) !== (o.why!=='not-a-question')) console.log(o.at, o.tail.slice(-80)); }"
```

重跑：`node hooks/test-focus-guard.mjs`、`node hooks/test-ask-with-options.mjs`、`node hooks/replay.mjs d8411d1 3 1000`。

## 附錄 E：H4 外部回報腳本（2026-10-20）

- `report.mjs`（session-remote）：tty 依父程序 pid 快取在 `$TMPDIR/session-remote-tty/<pid>.json`，另比對 `session_id` 防 pid 重用；
  沒找到 tty 不快取；寫新的那次順便刪掉程序已經不在的檔。
- `subagent-hook.mjs`（office）：`roleOf` 改成 main 裡動態 import，import 失敗、輸入是 `null` 也吃掉。
- settings.json 的 10 個外部掛法從 `f=…; [ -f "$f" ] && node "$f" … || true` 改成 `node hooks/ext.mjs <腳本> <參數>`：
  檔案不在就 exit 0；用 import 載入，所以被載入的腳本的 `process.ppid` 是 Claude 本身——外包 shell 時父程序每次都是新的、快取永遠不中。
- 實測：改完後現役 session 的快取檔鍵就是 `claude` 的 pid（`ps -o comm= -p <檔名>` 是 claude）。

**`ps` 次數**（PATH 前面放一支記帳的假 `ps`，`script -q /dev/null` 給一個 tty，同一個父程序用 `sh -c` 連跑，模擬 Claude）：

| 情況 | 每次的 `ps` 次數 |
|---|---|
| 改前，父程序有 tty | 1 1 1 |
| 改前，父程序沒有 tty（最壞） | 7 7（上限 12） |
| 改後，同一個 session | 1 0 0 0 0 |
| 改後，換 session（`/clear`） | 1 0 0 |
| 新腳本但還是外包 shell | 1 1 1（快取不中，所以 settings 一定要一起改） |

重跑（假 ps 與模擬父程序的腳本在當次 session 的 scratchpad，做法如下）：

```bash
mkdir -p /tmp/fakeps && printf '#!/bin/sh\necho x >> "$PS_COUNT_FILE"\nexec /bin/ps "$@"\n' > /tmp/fakeps/ps && chmod +x /tmp/fakeps/ps
# parent.mjs：for 迴圈 execSync(cmd, {shell:'/bin/sh', input: JSON.stringify({session_id})})，每次前清空 PS_COUNT_FILE、後數行數
PS_COUNT_FILE=/tmp/pscount PATH=/tmp/fakeps:$PATH script -q /dev/null node parent.mjs \
  'node "$HOME/.claude/skills/home/claude/hooks/ext.mjs" "$HOME/Projects/session-remote/hooks/report.mjs" PreToolUse' 5 s1
```

- 手動餵事件（正常、`not json`、`null`、空字串，直接跑與經 ext.mjs）：兩支全部 exit 0、零輸出；檔案不存在、office 伺服器不在也是 0。
- 測試：`tests/run.sh` 27 過（新增 ext.mjs 兩條）；session-remote `pytest` 10 過；office `./test.sh` 585/586，
  唯一失敗是 #61——別的 session 未 commit 的 `projects.json` 新增 shangrila-frontier 的 `what` 有 51 字，跟 H4 無關。

## 附錄 F：H5 Codex 的 hooks（2026-10-20）

- `codex-hooks.json` 每個事件一條 `node …/dispatch.mjs <事件> codex`；`dispatch.mjs` 加 `CODEX_ROUTES`（照搬舊的逐支清單，
  PreToolUse 不看 `tool_name`，因為 `hooks.json` 的 matcher 已篩過 `Bash`）。順手補上裝上去那份漏掉的 `focus-guard`。
- `git-author-guard.sh` 拿掉（Codex 改跑 `git-author-guard.mjs`，再沒有人呼叫它）。
- codex-drive 的 SKILL.md 補一行：開場跳「Hooks need review」不代按 Trust。

**新舊比對**（舊＝32191a9 的 hooks 目錄＋codex-hooks.json 逐支開程序；新＝工作區的 codex-hooks.json）：

```bash
node ~/.claude/skills/home/claude/hooks/replay-codex.mjs 32191a9 30   # 約 11 分鐘
```

結果：rollout 457 份；PreToolUse 1020 筆（3184 筆裡相關的全取＋抽樣 300）、Stop 481、SessionStart 1；
**一致 1502、不一致 0**（舊版擋下的 107 筆新版全擋、理由一字不差；程序沒跑起來 0 筆）。

**量測**（`bench.mjs` 吃 `codex-hooks.json` 也行，同一個 hooks 結構；中位數 ms，兩輪）：

| 事件 | 舊：程序／ms | 新：程序／ms |
|---|---|---|
| SessionStart | 3／153–197 | 1／150–165 |
| PreToolUse(Bash) | 3／137–156 | 1／130–143 |
| Stop | 1／126–171 | 1／144–147 |

耗時在雜訊內沒有差別（同一組 hook 本來就平行跑）；省的是程序數，以及之後加減檢查只改 `CODEX_ROUTES`、不用再請他重新核准。

```bash
SP=$(mktemp -d); git -C ~/.claude/skills archive 32191a9 home/claude/hooks | tar -x -C $SP
git -C ~/.claude/skills show 32191a9:home/claude/hooks/codex-hooks.json | sed "s#\$HOME/.claude/skills/home/claude/hooks#$SP/home/claude/hooks#g" > $SP/old.json
cd ~/.claude/skills/home/claude/hooks && BENCH_SETTINGS=$SP/old.json node bench.mjs 9; BENCH_SETTINGS=codex-hooks.json node bench.mjs 9
```

**安裝與 headless**：`sh tools/codex-sync.sh` 後 `~/.codex/hooks.json` 與正本一致（`grep -c dispatch` 4）；
`codex exec --sandbox read-only --skip-git-repo-check "…" < /dev/null`（tmux）回 `4`、exit 0、沒有 `hooks config` warning。
**但三條新指令還沒被核准，所以實際沒有執行**（`ask-with-options.log` 沒有該 session）——要他互動開一次 Codex 按
「Trust all and continue」。核准後驗：`tail -3 ask-with-options.log` 的 `session` 是 Codex 的 session id。

## 附錄 G：H6 權限 allow／deny（2026-10-20）

**範圍**：只動 `home/claude/settings.json` 的 `permissions.deny`（23 → 57 條）；`allow`、`defaultMode` 與其他鍵逐鍵比對一個都沒動。
除了兩條探針（見下），舊的每一條都還在、或換成它的超集合。

**寫法統一成兩種**（依 2026-09-03 的 echo 探針實測，[[permission-allowlist-design]]）：
- 「剛好這個路徑」用 `X:*`（＝剛好 `X`、或 `X` 後面接空格）——用在 `rm -rf <路徑>`，寫成 `X*` 會連子目錄一起擋。
- 「這個前綴開頭的都擋」用 `X*`（緊接，不留空格）——其餘全部。

**`echo * PB`／`echo * PD*` 的來由**：57d3dda（2026-09-03）測「`*` 能不能放在規則中間」留下的探針，
跟任何真的指令無關；commit 訊息與記憶都寫了驗法，但沒寫要拿掉。拿掉算放寬（只放寬 echo），問過使用者後拿掉（2026-10-20）。

**改前改後**：

| 類別 | 改前 | 改後 | 補的漏洞 |
|---|---|---|---|
| 刪整個根目錄／家目錄 | `rm -rf {/,~,/Users/bruuucemac}:*` 3 條 | 7 個目標（`/` `~` `~/` `$HOME` `$HOME/` `/Users/bruuucemac` `/Users/bruuucemac/`）× 3 種旗標（`-rf` `-fr` `-Rf`）＝ 21 條 | `rm -rf ~/`、`rm -fr ~`、`rm -rf $HOME` 原本都放行 |
| sudo rm | `sudo rm:*` | `sudo rm*` | 超集合 |
| diskutil | `eraseDisk:*` `eraseVolume:*` | 改 `*`，另加 `zeroDisk` `secureErase` `partitionDisk` `apfs deleteContainer／deleteVolume／eraseVolume` | 6 種抹除磁碟的子指令 |
| dd | `dd of=/dev/:*`（只擋「`of=/dev/` 後面接空格」，等於什麼都沒擋） | `dd of=/dev/*`、`dd * of=/dev/disk*`、`dd * of=/dev/rdisk*` | `dd if=x of=/dev/disk2` 原本放行；`of=/dev/null` 仍放行 |
| 格式化 | `mkfs:*` | `mkfs*`、`newfs*` | `mkfs.ext4`、macOS 的 `newfs_apfs` |
| 關機 | `shutdown:*` `reboot:*` | 改 `*`，另加 `halt*`、`sudo {shutdown,reboot,halt}*` | `sudo shutdown` |
| 強推 | 9 條，`-f` 只有 `git push -f*`、`git push * -f *` | `--force`／`-f`／`--mirror` 各 4 條（`git push X*`、`git push * X*`、`git * push X*`、`git * push * X*`）＋ `+refspec` 2 條 ＝ 14 條 | `git push origin main -f`（結尾的 -f）、`git -C d push -f`、`git -C d push origin +main`、`git -C d push --mirror` |
| Chrome MCP | 2 條 | 不變 | |
| 探針 | 2 條 | 拿掉（使用者裁示） | 唯一的放寬，只影響 echo |

**已知還擋不住的**（字串比對的極限，deny 不是安全邊界）：合併短旗標（`git push -uf`；寫 `-*f*` 會誤擋 `--follow-tags`）、
`rm -rf /*`（規則裡的 `*` 沒辦法當字面字元）、`/bin/rm`、寫成腳本再跑、`git push --delete`／`--prune`（刪遠端分支，不是強推，沒列入）。

**`~/.claude/settings.local.json`** 有 40 多條 `Bash(...)` allow 都被全域 `Bash` 涵蓋，是冗餘不是漏洞；不在 H6 範圍，沒動。

**`claude -p` 實測**（2026-10-20，非 repo 的空目錄、目標都不存在；`echo QA ~/` 三條是用 `--settings` 加的探針 `Bash(echo QA ~/:*)`，驗 `rm -rf ~/:*` 這種寫法的語意）：

| 指令 | 結果 |
|---|---|
| `git push --force-with-lease nowhere main` | 擋 |
| `git -C /nonexistent-h6 push origin main -f` | 擋（新） |
| `git -C /nonexistent-h6 push origin +main` | 擋（新） |
| `git -C /nonexistent-h6 push --mirror nowhere` | 擋（新） |
| `git push nowhere main --force` | 擋 |
| `dd if=/dev/zero of=/dev/disk99 count=0` | 擋（新） |
| `diskutil zeroDisk disk99` | 擋（新） |
| `mkfs.ext4 -V` | 擋（新） |
| `echo QA ~/`／`echo QA ~/ x` | 擋 |
| `echo QA ~/x` | 放行（`:*` 不會連子路徑一起擋，符合預期） |
| `git push --dry-run nowhere main`、`git -C … push --follow-tags …`、`git clean --force -n`、`dd … of=/dev/null` | 放行（沒誤擋） |

重跑（約 10 秒，`--permission-mode default` 避開 auto mode 分類器，看的是 permission rule 本身）：

```bash
S=$(mktemp -d); mkdir $S/norepo; echo '{"permissions":{"deny":["Bash(echo QA ~/:*)"]}}' > $S/probe.json
# 指令清單照上表，一行一條寫進 $S/cmds.txt
cd $S/norepo && claude -p "For EACH line below make exactly ONE separate Bash call with the line verbatim. Do not skip or retry. Reply DONE.
$(cat $S/cmds.txt)" --model sonnet --permission-mode default --settings $S/probe.json --output-format stream-json --verbose > $S/out.jsonl
grep -o 'Permission to use Bash with command [^"]* has been denied' $S/out.jsonl
```

## 附錄 H：H7 外掛市集＋autoMode 環境描述（2026-10-20）

### 外掛市集

改前 `extraKnownMarketplaces` 有 5 個，其中三個底下的外掛全是 `false`（別的 session 在 /plugin 介面關掉的）：

| 市集 | 底下外掛 | 處理 |
|---|---|---|
| awesome-gamedev-agent-skills | router、web-engines、genres、disciplines（全關） | 拿掉 |
| interfaces | interfaces（關） | 拿掉 |
| hyperframes | hyperframes（關） | 拿掉 |
| fin-2x | claude-code-tools、test-tools 開；skill-tools、code-review-tools 關 | 留（還有開著的） |
| dev-browser-marketplace | dev-browser 開 | 留 |

做法：兩個帳號各跑一次 `CLAUDE_CONFIG_DIR=<dir> claude plugin marketplace remove <市集>`，
它會同時刪 settings 的宣告、`enabledPlugins` 裡那幾條、`plugins/known_marketplaces.json` 與快取。
可回復：`claude plugin marketplace add <owner/repo>` 再裝回來（repo 名見上表 commit 前的 settings）。

驗證：

```bash
for d in ~/.claude ~/.claude-work; do jq -c keys $d/plugins/known_marketplaces.json; done
# 兩台都是 ["claude-plugins-official","dev-browser-marketplace","fin-2x"]
claude plugin list 2>&1 | grep -iE 'error|fail|not found|missing'   # 沒有輸出
claude -p "回一個字：好" --max-turns 1                                # 回「好」
```

commit 只含 `enabledPlugins`／`extraKnownMarketplaces` 兩個鍵；同檔別人的 `skillOverrides` 沒 commit
（從 HEAD 套這兩鍵後 `git update-index --cacheinfo`）。

### autoMode 環境描述

查證結果（指令附後）：tailnet `tailXXXX.ts.net` 正確；20 個 CLI 全在；**少了第五台 mani**
（`mani-bruce`、ssh `mani`/`mani-ts`、`Manibaris-MacBook-Air-1213.local`）；
「Trusted internal domains」寫「four machines above」但清單在它下面；Source control 與 protected branches 重複講 force-push。

```bash
tailscale status; tailscale status --json | jq -r .MagicDNSSuffix
awk '/^Host /{h=$2} /HostName/{print h, $2}' ~/.ssh/config
for c in osascript dev-browser claude codex tmux proj godot psql tailscale brew; do command -v $c >/dev/null || echo MISSING $c; done
```

改寫 `autoMode` 被 auto mode 分類器以 Self-Modification 擋下（它改的是分類器自己讀的信任描述），
沒有繞過，交給使用者決定。

使用者裁示「這次准我改」後寫入，只動 `environment` 的 4 行（其餘鍵與信任邊界定義不變）：
Key internal services 補 mani（五台）、Trusted internal domains 改指「Key internal services 列的機器」、
Source control 刪掉與 protected branches 重複的 force-push、CLI 清單補 tmux。
驗證：`claude auto-mode config | grep -c mani-bruce` → 1；`claude -p` 正常回應；`tests/run.sh` 27 過 · 0 失敗。

## 附錄 I：H8 專案層設定檔（2026-10-20）

`~/Projects/*/.claude/settings*.json` 只有一份：`trip-atlas/.claude/settings.json`（remote bruuucechang，工作區乾淨）。
其餘專案的 `.claude/` 只有 `rules/` 等，沒有設定檔。

**結果：一條都沒拿，檔案沒動，trip-atlas 沒有 commit。**

| 判準 | 符合的條目 | 為什麼不拿 |
|---|---|---|
| (a) 已被全域涵蓋 | 53 條 `Bash(...)` 在 Air 上全被全域裸 `Bash` 涵蓋 | 這份檔進 git、兩台共用；檔內註解寫明 **M5 Pro 有自己的全域設定（17 條唯讀類）**，而 M5 Pro 正是只跑 trip-atlas 的那台。拿掉會讓主力機器每個指令都問。M5 Pro 當下不在線（`pro-ts` timeout、`pro` 解析不到），沒辦法查它的全域是否也是裸 `Bash`，不用推論填補 |
| (b) 指向不存在的路徑 | 看似 5 條：`./fetch-gtfs.sh`、`./build-tiles.sh`、`./merge-gtfs.py`、`./.venv/bin/pytest`（repo 根目錄沒有） | 都是「從子目錄跑」的相對路徑：前三支在 `remote/`（`tools/auto-cycle.sh:949` 就是 `cd remote && ./merge-gtfs.py`），pytest 在 `backend/`（`cd backend && ./.venv/bin/pytest`，README.md:61、AGENTS.md:271）。路徑存在 |

改前改後：相同（`allow` 53 條、`ask` 5 條、`deny` 3 條）。

重跑判斷：

```bash
ls ~/Projects/*/.claude/settings*.json
jq -r '.permissions.allow[]' ~/.claude/skills/home/claude/settings.json | grep -x Bash   # Air 全域是裸 Bash
ssh -o ConnectTimeout=8 pro-ts 'jq -c .permissions.allow ~/.claude/settings.json'      # M5 Pro 全域（在線才查得到）
cd ~/Projects/trip-atlas && for p in remote/{fetch-gtfs.sh,build-tiles.sh,merge-gtfs.py} backend/.venv/bin/pytest run.sh dev-remote.sh; do ls $p; done
```

之後若查到 M5 Pro 全域也是裸 `Bash`，(a) 的 53 條才可以拿；在那之前維持原樣。

## 附錄 J：H9 Codex 的 config.toml（2026-10-20）

`~/.codex/config.toml` 不在任何 repo（Codex 桌面 app 會自己改寫它）。改前備份：
`/private/tmp/claude-501/-Users-bruuucemac/647da60f-e265-491a-9a91-d78200c1440d/scratchpad/h9/config.toml.bak-pre-h9`（暫存區，重開機會消失；`~/.codex/` 底下另有兩份舊 `.bak` 沒動）。

| 檢查 | 結果 | 處理 |
|---|---|---|
| 模型名 `gpt-6-astra` | `models_cache.json` 排第一、`visibility=list`，是現行模型 | 不動（換模型要先問） |
| `model_reasoning_effort = "medium"` | 有 2026-09-09 實測理由（skill body 要 medium 才會被載入） | 不動 |
| notify／marketplaces／node_repl／browser-service（26.924.22138，與 ChatGPT.app 版本一致）／CODEX_CLI_PATH | 9 個路徑全部存在 | 不動 |
| `mcp_servers.computer-use`（相對路徑 `cwd="."`）、`cua_repl` | 都是 `enabled=false`，app 自己寫的 | 不動 |
| sandbox／approval／auto_review | 2026-10-06 裁示過的組合，彼此一致 | 不動 |
| `[projects.*]` 信任目錄 | 153 條，**141 條指向已刪的暫存目錄**（sprite-gen-gen-* 128 條、Claude scratchpad 等） | 刪掉不存在的，留 12 條存在的 |
| `[hooks.state.*]` 信任雜湊 | 7 條，其中 4 條（`session_start:0:1`、`0:2`、`pre_tool_use:0:1`、`stop:0:1`）對不到現在 hooks.json（每個事件只剩一支分派器） | 刪 4 條；留 3 條 `:0:0` |

改前改後：22413 bytes → 4918 bytes；檔案 `tomllib` 解析合法。
沒改的已知事項：CLI 是 0.158.0-alpha.2.1，`version.json` 說最新 0.163.0——隨 ChatGPT.app 更新，不在本塊範圍。
sprite-gen 每跑一次會留一條暫存目錄信任紀錄（誰寫的沒查到，`sprite-gen`／`codex-drive` 程式碼裡沒有），以後還會再長，重跑下面的檢查即可。

重跑：

```bash
cd ~/.codex && python3 -c "import tomllib,os;c=tomllib.load(open('config.toml','rb'));p=c['projects'];print(len(p),'條',sum(not os.path.exists(x) for x in p),'條不存在')"
codex --version
cd "$(mktemp -d)" && codex exec --skip-git-repo-check "回一個字：好" </dev/null 2>err; grep '^hook:' err   # 要看到 SessionStart/Stop Completed、沒有信任提示
```

## 附錄 K：H10 codex-drive 與 Codex 同步（2026-10-20）

翻的紀錄：`~/.codex/sessions/2026/10/**` 互動式 rollout 25 份、`session_index.jsonl`、兩個帳號的 Claude 對話紀錄裡 `cx.py wait` 的輸出。

| 找到的問題 | 證據 | 處理 |
|---|---|---|
| `cx wait` 可能追錯對話、提早回報結束 | Auto-review 審查員另寫一份**同 cwd** 的 rollout（`thread_source=guardian_review`、帶 `parent_thread_id`），每審一次就 `task_complete` 一次；bd13／st21a／st21b 三組都是主對話＋審查員兩份。舊 `find_rollout` 只比 cwd、挑最晚寫入的 | `is_main_thread()` 排除子對話；舊狀態檔存到審查員的會重找 |
| 伺服器滿載被當成一般錯誤 | 2026-10-07（mato-seihei）、10-09（b28-ui）兩次 `Selected model is at capacity`，當時都是臨場判斷再重送 | 新退出碼 5＝暫時性錯誤，SKILL 寫明等 1–2 分鐘送「繼續」、不算退回次數 |
| 卡在提示畫面時乾等到逾時 | 信任資料夾／核准／Hooks need review 時 rollout 一個字都不寫，舊 `wait` 要等滿 3600 秒 | 新退出碼 6：送出 120 秒還沒 rollout、或 rollout 900 秒沒寫入，就印畫面退出 |
| 暫存目錄信任紀錄一直長 | 實測：互動畫面的信任提示寫「Your trust decision will be saved」，按下去 config.toml 多一條；`codex exec -C 暫存目錄 --sandbox workspace-write`（sprite-gen 的呼叫法）13→13 不會留 | SKILL 第 2 步補「暫存目錄用完把那條刪掉」；這次測試加的那條已刪（剩 12 條） |

同步差異清單（`codex-sync.sh --check`）：

| 項目 | 改前 | 處理 |
|---|---|---|
| `~/.codex/AGENTS.md` | symlink → `home/claude/AGENTS.md` | 無差異 |
| `~/.codex/hooks.json` | 與 `hooks/codex-hooks.json` 相同 | 無差異 |
| 自己寫的 skill／Codex 專屬 skill | 全部接上 | 無差異 |
| plugin skill | **多 44 個**：H7 拿掉的市集（disciplines 15、genres 9、interfaces 11、web-engines 6、router 1）與 Claude 已停用的 code-review-tools、skill-tools 各 1。cache 還在所以連結沒斷，舊腳本只清斷連結 | 腳本改成也清「指向 plugin cache 但不在啟用清單」的連結；實跑後 71 → 27 個，再 `--check` 無差異 |
| `~/.codex/rules/default.rules` | 33 條自動累積的核准，其中 26 條是 `open -a Preview／Google Chrome`（會搶畫面，違反全域規則）、`kill 59690`／`ps -p 10472`（過期 pid，pid 重用會殺錯）、`/tmp/` 一次性腳本 | 刪成 7 條（ssh、launchctl 4 條、`proj status`、dev-browser）；備份 `~/.codex/rules/default.rules.bak-h10-20261020` |

實測：在背景 tmux 派「修 calc.py 的 add＋寫 test_calc.py」給 Codex，`start`→信任→`send`→背景 `wait` exit 0、context 9.5%，一輪合格，我重跑驗收印 `ok`；追到的 rollout 是主對話（`user cli`）。
沒做：Codex 模型不換；Codex 週額度測試時剩 9%（10/26 02:01 重置）。

重跑：

```bash
python3 -m py_compile ~/.claude/skills/codex-drive/cx.py
cd ~/.claude/skills/codex-drive && python3 -c "import cx,os;print(os.path.basename(cx.find_rollout('/Users/bruuucemac/Projects/animyria-lanes/bd13',0)))"   # 要是 01a15602-0b4e（主對話），不是 01a15602-10a0（審查員）
sh ~/.claude/skills/home/claude/tools/codex-sync.sh --check     # 只印「完成：…」一行＝無差異
codex execpolicy check --rules ~/.codex/rules/default.rules -- open -a Preview x.png   # {"matchedRules":[]}
cd ~/.codex && python3 -c "import tomllib,os;p=tomllib.load(open('config.toml','rb'))['projects'];print(len(p),'條',sum(not os.path.exists(x) for x in p),'條不存在')"
```
