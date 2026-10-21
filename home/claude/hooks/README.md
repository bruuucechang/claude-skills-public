# Windows 用的掛勾腳本

**為什麼會有這個目錄**：`settings.json` 的掛勾原本是 POSIX shell 寫的
（`2>/dev/null || true`、`printf`、`jq`＋`case ... esac`）。那在 mac 的 zsh 底下沒問題，
但 **Windows 上 Claude Code 是用 PowerShell 5.1 跑掛勾**，於是：

| 掛勾 | 在 PowerShell 5.1 的下場 |
|---|---|
| `rundll32 ... 2>/dev/null \|\| true` | **剖析錯誤**——`\|\|` 是 PowerShell 7 才有的語法 |
| `printf '%s' '{...}'` | `printf` 這個指令不存在 |
| `c=$(jq -r ...); case "$c" in ... esac` | **剖析錯誤**（2 個） |

`Stop` 掛勾在**每一次回覆結束時**都會跑，所以那段多行剖析錯誤會一直插進
Claude Code 的 TUI 重繪裡——症狀是「文字重疊、排序錯亂、中間穿插奇怪文字」。
兩台 Windows（Win 10 Pro 與 Win 11 家用版）都是 PowerShell 5.1，所以兩台都中；
mac 不中，因為 zsh 看得懂那些語法。

**這跟 Windows 版本、conhost 的臭蟲都無關**——同一台換成 PowerShell 7 也會好，
但真正的修法是掛勾本來就該用執行它的殼層的語法寫。

## 檔案

| | |
|---|---|
| `git-author-guard.ps1` | `PreToolUse` 用：擋下作者身分錯誤的 `git commit`。mac 的 `git-author-guard.mjs`（Codex 用的 `.sh`）的 PowerShell 對應 |
| `session-start-context.txt` | `SessionStart` 要送出的那段 JSON，獨立成檔避免在 settings.json 裡跟引號搏鬥 |

## mac：同步的檢查全部走 `dispatch.mjs`（2026-10-20）

`settings.json` 每個事件只掛一支 `node dispatch.mjs <事件>`，讀一次 stdin、依 `tool_name` 分給各檢查，
輸出合併（任一 deny 就 deny、理由串接；additionalContext 串接）。路由表是 `dispatch.mjs` 的 `ROUTES`。
async 的回報（`pane-state`、session-remote 的 `report.mjs`、office 的 `subagent-hook.mjs`、`afplay`）不擋 Claude，維持各自掛著。
外部 repo 的兩支經 `ext.mjs <腳本> <參數>` 載入（檔案不在就安靜結束、不包 shell；report.mjs 的 tty 快取靠父程序就是 Claude，2026-10-20 H4）。

| 事件 | 分派器裡跑的檢查（依序） |
|---|---|
| `SessionStart` | 開場提醒（`session-start-context.txt`）、`session-restore`、`blocks-current`、`update-check`、`account-check`、`session-title` |
| `UserPromptSubmit` | `context-tier`、`account-drain`、`session-title` |
| `Stop` | `ask-with-options`、`lang-guard`、`account-drain`、`session-journal` |
| `StopFailure`（matcher `rate_limit`） | `rate-limit-switch`（輸出被 Claude Code 忽略，只做副作用） |
| `PreToolUse` Bash | `git-author-guard`、`commit-message-guard`、`pushq-guard`、`pr-guard`、`focus-guard`、`kill-guard` |
| `PreToolUse` AskUserQuestion | `ask-hides-prose` |
| `PreToolUse` browser_batch | `browser-batch-guard` |

- `kill-guard` 擋 pkill／killall／`kill $(pgrep …)`（只准 `kill <自己記的 pid>`）；`lang-guard` 擋英文收尾、一回合最多擋一次。
  測試 `node test-kill-guard.mjs`、`node test-lang-guard.mjs`；拿近 N 天真實紀錄重播：`node replay-p3.mjs kill|lang 14`。
- 每支檢查 `export run(input)`，回 null／物件／字串；**run 裡不准 `process.exit`、不准讀 stdin**（共用 `lib/hook-cli.mjs`）。
  單獨執行照樣能用（除錯用）。
- 單一檢查丟例外或逾時：跳過、記一行 `dispatch.log`；分派器自己壞掉：exit 0 不輸出（＝放行）。
- 作者檢查與 browser_batch 白名單原本是 settings.json 裡的 inline shell，現在是 `git-author-guard.mjs`、`browser-batch-guard.mjs`。
- **Codex 也走分派器**：`~/.codex/hooks.json`（正本 `codex-hooks.json`，`tools/codex-sync.sh` 裝）每個事件一條
  `dispatch.mjs <事件> codex`，跑 `CODEX_ROUTES` 那份較短的清單；說明在 `codex-hooks.md`，新舊比對 `node replay-codex.mjs`。
- `account-check` 查過沒問題就快取一小時（`~/.claude/cache/account-check.json`），省掉每次開場 ~750ms 的 Keychain 查詢。
- 測試：`node test-dispatch.mjs`、`test-commit-message-guard.mjs`、`test-git-author-guard.mjs`、`test-ask-hides-prose.mjs`、`test-context-tier.mjs`（都在 `tests/run.sh`）；
  `git commit` 的判斷共用 `lib/shell-words.mjs`（拆成真的會執行的簡單指令，heredoc 本體／grep 樣式不算）；新舊比對：`node replay.mjs [舊 ref] [天數]`；
  agent-model-guard：`node test-agent-model-guard.mjs`，扇出規則拿真實紀錄重播 `node replay-agent-fanout.mjs [舊 ref] [天數=14]`；
  量測：`node bench.mjs 5`；看每支花多久：`HOOK_TIMING=1 HOOK_NOLOG=1 node dispatch.mjs <事件> < 輸入.json`。
- `HOOK_NOLOG=1` 讓所有檢查都不寫稽核 log（重播、量測用）。

## Windows 的 settings.json 該怎麼寫

```json
"Stop": [{ "hooks": [{ "type": "command", "command": "rundll32.exe user32.dll,MessageBeep 0" }] }],
"SessionStart": [{ "hooks": [{ "type": "command",
  "command": "powershell -NoProfile -Command \"Get-Content -Raw -Encoding UTF8 $env:USERPROFILE\\.claude\\skills\\home\\claude\\hooks\\session-start-context.txt\"" }] }],
"PreToolUse": [{ "matcher": "Bash", "hooks": [{ "type": "command",
  "command": "powershell -NoProfile -ExecutionPolicy Bypass -File $env:USERPROFILE\\.claude\\skills\\home\\claude\\hooks\\git-author-guard.ps1" }] }]
```

**不要在 Windows 的掛勾裡用 `2>/dev/null`、`||`、`&&`、`printf`、反引號以外的跳脫。**
改掛勾之前先用這個驗語法，它比等 Claude Code 跑到才發現快得多：

```powershell
$e=$null; [void][System.Management.Automation.Language.Parser]::ParseInput('<你的指令>',[ref]$null,[ref]$e); $e.Count
```


## 掛勾輸出遇到主控台碼頁：別讓 PowerShell 寫 stdout

`SessionStart` 一開始寫成 `powershell -Command "Get-Content -Raw -Encoding UTF8 <檔>"`。
**它會安靜地壞掉**：`Get-Content` 讀進來是對的，但 PowerShell 寫出去要經過
`[Console]::OutputEncoding`（碼頁 950），中文就被換成 `?`。

實測（碼頁 950）：

| 寫法 | 位元組 | JSON | 中文 |
|---|---|---|---|
| `powershell -Command "Get-Content ..."` | 1919 / 1925 | 仍然合法 | **不見了** |
| `cmd /c type "<檔>"` | 1925 / 1925 | 合法 | 完整 |

**JSON 還是合法的**——所以沒有任何錯誤訊息，只是模型收到的那段話少了中文。
掛勾要輸出非 ASCII 就用 `cmd /c type`（原樣搬位元組），不要讓 PowerShell 重新編碼。

同理，`git-author-guard.ps1` 輸出 deny 的理由時是直接寫 UTF-8 位元組到
stdout，不走 `Write-Output`。

## 2026-08-17：兩台已改成系統層 UTF-8

`HKLM\SYSTEM\CurrentControlSet\Control\Nls\CodePage` 的 `ACP`／`OEMCP`／`MACCP`
從 `950`／`950`／`10002` 改成 **65001**（＝控制台的「Beta：使用 UTF-8 提供全球語言支援」）。
**重開機才生效。**

為什麼要動到系統層：這兩台的介面語言是 zh-TW，**每一個失敗指令的系統錯誤訊息都是中文**，
以 big5 送回來、被 Claude Code 當 UTF-8 解，整段變亂碼進到對話裡——模型讀到垃圾就會照著垃圾誤判
（實測 BRUCEVICTUS 某個 session 的 42 個解碼失敗字元全部來自 `tool_result` 的 PowerShell 中文錯誤訊息）。

**要還原**：每台上有 `C:\Users\<帳號>\revert-codepage.ps1`，提權跑完重開機即可。
已知風險是舊的本地化軟體（例如證券憑證元件）可能不吃 UTF-8 ANSI——真的出事就用那支還原。


## `-File` 不會展開變數——這條讓掛勾每次呼叫都噴一段中文錯誤

`PreToolUse` 一度寫成：

```
powershell -NoProfile -ExecutionPolicy Bypass -File "$env:USERPROFILE\.claude\skills\...\git-author-guard.ps1"
```

**`-File` 的參數是照字面吃的，PowerShell 不會展開 `$env:USERPROFILE`**，而且掛勾是
由 cmd 起的，`$env:` 那段還會被吃掉一半。實際錯誤（每一次 Bash 工具呼叫都跑一遍）：

```
處理 -File ':USERPROFILE\.claude\skills\...\git-author-guard.ps1' 失敗: 不支援指定的路徑格式
```

那段是**中文**，以 big5 回到 Claude Code 就是亂碼；同時 stdout 還多了 PowerShell 的版權橫幅。
所以「掛勾修好了卻還是有亂碼」的下一層就是這個。正確寫法：

```
cmd /c powershell -NoProfile -NoLogo -ExecutionPolicy Bypass -File "%USERPROFILE%\.claude\skills\home\claude\hooks\git-author-guard.ps1"
```

- **`%USERPROFILE%` 不是 `$env:USERPROFILE`**——由 cmd 展開，`-File` 才拿得到真路徑
- **包一層 `cmd /c`**：不管誰來起這條指令，展開行為都一致
- **`-NoLogo`**：否則版權橫幅會混進掛勾的 stdout

驗收要看三件事，缺一不可：`stdout` 是合法 JSON、**`stderr` 是空的**、
以及**位元組層級**確認中文沒壞（不要用主控台看，碼頁 950 會讓正確的 UTF-8 看起來像壞的）：

```powershell
& cmd /c "type payload.json | <掛勾指令> > out.bin"
$b=[IO.File]::ReadAllBytes("out.bin"); [Text.Encoding]::UTF8.GetString($b) | ConvertFrom-Json
```

實測兩台都是 523 bytes、合法 UTF-8、中文正確。

---

## 前文回收三支（2026-09-24 加）

`session-journal.mjs`（Stop）＋ `context-tier.mjs`（UserPromptSubmit）＋
`session-restore.mjs`（SessionStart）。**三支是一組，少一支另兩支就不該裝。**

### 為什麼要有

2026-09-24 量 Air 近 7 天 17,775 個助理輪次：

```
每輪 context（input + cache_read + cache_creation）
  中位數 429k   p25 234k   p75 677k   p95 922k   最大 1000k
cache_read 佔全部 token 的 98.5%
最貴的單一 session：7,673 輪 / 10,079 分鐘（七天沒關）/ spend 31.6M
                    → 一個 session 就吃掉那 7 天總量的 25%
```

錢幾乎全花在「每一輪把整份累積的前文重讀一次」。同期對照 M5 Pro（peter）：
他的形狀**一模一樣**（最貴的 5,912 輪 / 7,090 分鐘 / 佔他 29%），
所以這不是設定問題，是**沒有人敢回收前文**——因為回收是有損的。

### 分工：模型不能 compact、也不能關 session

那兩個都是 harness 的動作。所以這三支不「幫你」做，而是：

| 支 | 事件 | 做什麼 |
|---|---|---|
| `session-journal.mjs` | Stop | 每回合把「請求／做了什麼／新增了哪些 git 改動」追加到 `~/.claude/session-logs/<專案>/<session>.md` |
| `account-drain.mjs` | UserPromptSubmit／Stop | 這格登的帳號週額度到門檻（bruce ≥ 90% → peter，判斷在 `tools/acct-drain.mjs`）就叫它寫交接單、`handoff-open` 換帳號；每個 session 提醒一次、擋一次 |
| `rate-limit-switch.mjs` | StopFailure | bruce 撞到額度上限（`error: rate_limit`）就代寫交接單、直接 `handoff-open --to peter`，再補寫 pane done；peter 撞牆不反向、同一格 30 分鐘一次；換不成寫 gaveUp 標記給 handoff-watch 叫人 |
| `context-tier.mjs` | UserPromptSubmit | 算出當下的 context **與這個 session 累積燒掉多少**，過門檻就說一聲 |
| `session-restore.mjs` | SessionStart | `compact`/`resume` 注回 journal 尾段；`startup` 注回夠新的 `HANDOFF.md` 後歸檔；`clear` 只注 handoff-open 剛打的那次的換手開場白（標記 `clearing`＋同一個 claude，太長就只給檔名），使用者自己的 clear 什麼都不注 |

### 兩層門檻（照 Air 自己的分佈訂，不是抄別台的）

```
TIER1  500k（半滿，落在中位數與 p75 之間）→ /compact，無損
TIER2  800k（≈ p90）                      → 產交接單、關掉、另開
```

TIER2 不繼續 compact 的理由：compact 是**有損摘要**，而且會讓整份 prompt cache
失效（下一輪從零重建）。到這個量級，乾淨新 session ＋ 一頁交接單起手約 30k，
比留著 50k+ 的摘要殘渣繼續滾划算。

同一層每 20 分鐘最多講一次；**升層立刻講不等冷卻**——「從建議壓縮變成建議換手」
本身就是新資訊。降回門檻以下時 tier 會記回去，所以 compact 完再漲上來還會再講。

### 第三層：累積量（2026-09-26 加）

上面兩層看的是**當下這一輪**，而那漏掉一整類：**乖乖 compact、尖峰從來不破 800k、
但一直不關**的 session。回測 Air 近 30 天 90 個 session（累積 ctx 合計 61.3B）：

```
每個 session 的累積 ctx
  p50 43M   p75 320M   p90 1,037M   p95 1,484M   最大 31,602M

最貴的 15 個裡有兩個（632M、516M）尖峰從沒破 800k
  → TIER2 對它們永遠不開火，但它們各自燒掉半個 B
```

```
CUM_BASE  500M  → 攔到 16.7% 的 session，涵蓋 89.3% 的花費
                  （1B 涵蓋 82.2% 但漏掉上面那兩條；300M 涵蓋 94.4% 但會吵到 1/4 的 session）
```

**叫一次不夠，所以每翻一倍再叫一次**（500M / 1B / 2B / 4B…），語氣隨倍數加重。
理由是同一份回測：最貴那個 session 若攔在 1B，**之後還會再燒 30.6B，佔它自己的 97%**。
被叫過一次還繼續跑，是這件事最常見的結局。

這一層的建議**一律是換手不是壓縮**——累積量不會因為 `/compact` 變少，
compact 只壓下一輪的 context，已經付掉的不會回來。

**怎麼算得便宜**：state 裡記 byte offset，每輪只掃新長出來的那幾 KB。
第一次看到一個 session 才整份補掃一次，實測 30 MB／142 ms、
267 MB（史上最大那份）／1.2〜1.3 秒，之後每輪 0 bytes／1 ms。
`scanMs` 與 `scanBytes` 都進 log，哪天變慢直接查。

### 四個踩過的邊界

- **Stop hook 不准寫 stdout。** 那是用來擋回合的（見 `ask-with-options.mjs`），
  journal 寫任何東西都可能變成「擋下來」。
- **切位元組再解碼，切點會落在中文字中間。** 切壞的字變成替代字元，
  **只會弄壞一行 JSON、不會丟例外**——所以症狀是「安靜地少算」。
  累積層改成**用位元組找最後一個換行**，只解碼到那裡，剩下的位元組原樣接到下一塊，
  永遠不在字元中間切；逐行 `try/catch` 仍然保留，不要因為一行壞掉放棄整個檔。
- **offset 只能推進到最後一個完整行。** transcript 可能正被寫到一半，
  推到檔尾會把半行吞掉，而下一輪從那裡接就永遠對不齊。
- **log 放 `~/.claude/session-logs/`，不放 repo。** 放 repo 會進 git、會讓
  `git status` 永遠是髒的，而髒工作樹正是 autopilot 判斷「這輪有沒有產出」的訊號。

### 逃生門與稽核

```bash
touch ~/.claude/skills/home/claude/hooks/{context-tier,session-journal,session-restore}.off
cat  ~/.claude/skills/home/claude/hooks/context-tier.log     # 每次判斷都記
ls   ~/.claude/session-logs/                                  # 日誌與交接單
```

驗收：22 條合成 payload 測試（每條路徑都逼過，含中文切點、payload 空、
交接單過期不注），加上累積層自己的 22 條（累積量與獨立算法逐位元組對答案、
增量不重掃、跨階才叫、檔案變小歸零、壞行不擋人）。
來源：M5 Pro 上 peter 的 `context-journal` 的分工設計，
**只參考做法，沒有複製任何檔案**（那是 `manibari/rivendell`，不是我的 repo）。

## `update-check.mjs`：每天講一次「有什麼該更新了」（2026-09-26 加）

### 為什麼要有

使用者打了一個字「update」，掃下去才發現 brew 有 20 個套件過期（含 `git` 落後
5 個小版本、`node` 落後一個大版本），而 Claude Code 停在 8/6 裝的 2.1.223 ——
`~/.local/share/claude/versions/` 裡從頭到尾只有那一個檔，**自動更新七週一次都沒成功過**。
根因是 `~/.claude.json` 的 `installMethod` 寫 `global` 但實際跑的是 native，
更新程序照著 config 去戳一個不存在的 npm 安裝。

他問「為什麼沒有提醒我更新」。答案是**沒有任何東西在看**：crontab 只有 07:20 那行
`caffeinate`，16 個 launchd job 沒一個查版本，`brew autoupdate` 沒裝，而模型只在
被叫起來的時候存在、不在背景監看。這支就是那條缺掉的機制。

### 一天一次，而且不阻塞開場

真正的檢查要 `brew update`（打網路）＋ 每個 repo 的 `git fetch`，十幾秒。掛在開場
等於每次開 session 都罰站。所以拆兩半：**hook 只讀快取**（純讀檔，實測 182 ms，
幾乎全是 node 啟動），快取超過 24 小時就 `spawn(..., {detached:true}).unref()`
派一個脫離的程序去重算，hook 不等它。代價是剛升級完的那個 session 還會看到舊訊息。

三項全乾淨 → **一個字都不輸出**。這支每個 session 都跑，自己就是固定成本。

### 三項檢查

| 查什麼 | 怎麼查 | 陷阱 |
|---|---|---|
| brew 過期 | `brew update --quiet` 再 `brew outdated --quiet` | **不先 `update` 的話 `outdated` 比的是本地那份幾週沒動的 formula 定義，會安靜地回報「沒東西過期」** |
| Claude Code 落後 | 本地 `claude --version` 比 npm registry 的 `latest` | 本地比 registry 新（預發版）算乾淨，不要報 |
| 專案落後 origin | `~/Projects` 底下 owner 是 `bruuucechang` 的 repo，`git fetch` 後數 `HEAD..@{u}` | 只認自己的 repo，見 [[only-my-own-repos]] |

### 三個環境變數是為了能實測而存在

三項全乾淨時這支完全不輸出，而**「沒東西過期」跟「檢查根本壞了」長得一模一樣**。
沒有接縫就驗不了它，所以留了 `UPDATE_CHECK_CACHE_DIR` / `UPDATE_CHECK_PROJECTS` /
`UPDATE_CHECK_BREW`。驗收就是拿假的 brew（吐四個套件）＋ 假的專案樹
（一個落後 2 個 commit 的自己的 repo、一個別人的 repo、一個非 git 目錄）跑一次，
確認數字對、別人的 repo 沒被算進去、`clear` 與 `.off` 都真的零輸出。

### 逃生門與稽核

```bash
touch ~/.claude/skills/home/claude/hooks/update-check.off      # 關掉
node  ~/.claude/skills/home/claude/hooks/update-check.mjs --refresh   # 手動重算
cat   ~/.claude/cache/update-check.json                        # 看快取
```

## session-title.mjs（SessionStart ＋ UserPromptSubmit）

專案 session 自動取名（2026-10-16 使用者裁示：不要視窗編號，要人看得懂的名字）。
cwd 在 `~/Projects/<名字>/` 底下才算專案：開場標題掛 `<名字>`，第一句非斜線指令的話送出後補成
`<名字>｜<摘要>`（去客套開頭、截 18 字）。resume／compact 不動。走 `hookSpecificOutput.sessionTitle`。

重跑驗證：`cd ~/Projects/palrogue && claude -p --model haiku "回答 1+1"`，再到
`~/.claude-work/projects/-Users-bruuucemac-Projects-palrogue/<session>.jsonl` 找 `"type":"custom-title"`。
逃生門：`touch hooks/session-title.off`。
