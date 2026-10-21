# claude-skills

這台機器上 Claude Code 的設定：skill 定義 **加上**（2026-08-07 起）原本沒有版控、
換機器就會不見的那些檔案。

## 架構

規則怎麼載入、誰在真的擋、每個專案長什麼樣、四台機器怎麼同步——
四張圖在 **[home/claude/ARCHITECTURE.md](home/claude/ARCHITECTURE.md)**。

最關鍵的是第一張：**同一份知識放在三個位置，context 成本差三個數量級。**

```text
┌─────────────────────────────────────────────────────────────────────────
│ SESSION 開始就載入 · 每一次請求都在
├─────────────────────────────────────────────────────────────────────────
│
│ ~/.claude/CLAUDE.md          65 行
│       └── @import ──▶ ~/.claude/AGENTS.md    189 行  ← Codex 也讀
│
│ <專案>/CLAUDE.md             11 行（橋接）
│       └── @import ──▶ <專案>/AGENTS.md       652 行  ← palrogue
│
│ skills 描述 × 17（只有名稱與一句話）
│ MEMORY.md 索引 67 行（64 個記憶檔本體不載入）
│
└─────────────────────────────────────────────────────────────────────────
                          │
                          │  讀到 *.tsx / *.ts / *.css 時
                          ▼
┌─────────────────────────────────────────────────────────────────────────
│ 按需載入 · 不相關的工作＝零成本
├─────────────────────────────────────────────────────────────────────────
│
│ ~/.claude/rules/browser.md           78 行  paths: 前端副檔名
│ <專案>/.claude/rules/frontend.md            load_reason =
│                                             path_glob_match
│
└─────────────────────────────────────────────────────────────────────────

┌─────────────────────────────────────────────────────────────────────────
│ 從不自動載入 · 需要時才用 Read 去讀
├─────────────────────────────────────────────────────────────────────────
│
│ <專案>/docs/notebook.md   21,911 行       context 成本 ＝ 0
│                           （palrogue）     拆之前這些全部每次載入
│
└─────────────────────────────────────────────────────────────────────────
```

`@import` **不會**省 context（被匯入的檔案一樣在啟動時展開），
真正能省的只有帶 `paths:` 的 `rules/` 與完全不自動載入的 `docs/notebook.md`。

> 圖上的數字是 `home/claude/tools/mkarch.py` 現場量出來的，不是寫死的。
> 重出：`python3 home/claude/tools/mkarch.py --write`
> `home/claude/tools/rules-audit.sh` 每季會比對，數字漂掉會被點名。

## 安裝到另一台機器

```bash
git clone git@github.com:bruuucechang/claude-skills.git ~/.claude/skills
~/.claude/skills/bootstrap.sh
```

`bootstrap.sh` 只做檔案的部分（建 symlink、檢查依賴）。TCC 權限、裝套件、
`gh auth login` 那些它做不到——**完整步驟看 [BOOTSTRAP.md](BOOTSTRAP.md)**，
漏掉第一項（TCC）的症狀特別難懂。

**Windows（BRUCEVICTUS）不是這樣裝的。** 那台的 repo 本體直接就在
`C:\Users\user\.claude\skills`，`~\.claude\memory` 與 `~\.claude\commands` 是
**junction**（不是 symlink——那台沒開 Developer Mode），而且
**junction 一定要用提權的程序建**，否則會靜默變成讀不到的掛載點。
`settings.json` 在那台是**獨立的一份**，不是連結，見下。

## 測試

```bash
bash ~/.claude/skills/tests/run.sh
```

這裡的 skill 大多是文件，測不了；但**它們附帶的腳本測得了**，而且每一條都對應
一個真的發生過的缺陷（`check-paths.mjs` 的路徑切壞、`scaffold.sh` 只驗第一個
字元、`quad` 的兩道防 fork bomb 閘、scaffold 的防覆寫）。

改這些腳本之前先跑一次，改完再跑一次。**加新測試時要把 bug 放回去確認它真的會
紅**——`scaffold.sh` 那組第一版只看 exit code，把「通過驗證後才崩潰」誤判成
「擋下」，是綠燈假象。

外來 skill 與 plugin 不在這個 repo 裡，見 [install-external.sh](install-external.sh)。

## Skill

Claude Code 自動掃 `*/SKILL.md`，不需要註冊或重啟。

**目錄一定是平的。** Personal 層的路徑固定是 `~/.claude/skills/<skill-name>/SKILL.md`，
一層——收進 `skills/dev/ship/` 這種分類子目錄**就掃不到了**。官方文件另有一條說
`<skill-name>` 可以是 symlink 指到別處，但那要維護十幾條連結、Windows 那台還得
改成 junction（沒開 Developer Mode），為了目錄好看付這個代價不划算。

**所以分類寫在這張表裡，不在檔案系統上。** 分類軸是「**什麼時候會伸手去拿**」，
因為那才是實際找 skill 的方式：

### 開工前

| Skill | 什麼時候 | 平台 |
|---|---|---|
| `preflight` | 改過設定、或覺得「怪怪的」。2 秒跑完，查身分／設定／這台／另外三台 ssh 通不通 | 共用 |
| `recon` | 要動一個 repo 之前（原名 handoff）。這裡常有多個 session 並行改同一份，另一台也可能跑在前面 | 共用（含 Windows 對照） |

### 做事的時候

| Skill | 什麼時候 | 平台 |
|---|---|---|
| `grilling` / `grill-me` | 要建置／改動／做決定之前，盤問到需求沒有歧義為止 | 共用 |
| `newproj` | 開新專案：三層骨架（`scaffold.sh`）+ git 身分 + CLAUDE.md | **分平台** |
| `inspect-ui` | 前端改完、宣告完成之前。把畫面真的渲染出來用程式掃，不要用肉眼 | 共用 |

### 交付之前

| Skill | 什麼時候 | 平台 |
|---|---|---|
| `ship` | 「push」或 commit 之前（/ship）。測試 → 作者身分 → 只 add 自己的檔 → commit → push 一氣做完 | 共用（含 Windows 對照） |
| `handoff` | 換帳號、context 快滿、交接給下一個 session 時寫交接單（2026-10-12 起；原本的「查現況」改名 `recon`） | 共用 |
| `sync-docs` | 核對 CLAUDE.md／README 與程式碼是否還對得上——用跑的，不是用讀的 | 共用（含 Windows 對照） |

### 出事的時候

| Skill | 什麼時候 | 平台 |
|---|---|---|
| `env-doctor` | 檔案讀不到／埠打不到／Docker 沒反應／grep 找不到明明存在的字／環境變數被繼承 | **分平台** |

### 跨機器

| Skill | 什麼時候 | 平台 |
|---|---|---|
| `worker` | 把另一台當 worker：接機 → 派工 → 盯 → 收尾 | 共用（分三階段附檔） |

### 環境本身

| Skill | 什麼時候 | 平台 |
|---|---|---|
| `quad` | 終端機四宮格（mac 有腳本；Windows 用 Windows Terminal 分割窗格） | **分平台** |

### 分平台的三個是怎麼分的（2026-08-16）

```
env-doctor/
├── SKILL.md      症狀 → 去讀哪一份；兩台共通的規則；最容易誤判的三組對照
├── macos.md      TCC／iCloud／launchd／lsof／Terminal.app 環境繼承
└── windows.md    編碼三坑／指令別名／Get-NetTCPConnection／junction／session 0
```

**`SKILL.md` 是分派器**：只放平台無關的判斷與兩邊共通的鐵則，開頭第一件事是
「先確定平台，然後去讀 macos.md 或 windows.md」。Claude Code 只自動掃
`*/SKILL.md`，附檔是它判斷完平台之後才去讀的——**所以另一台的內容不會被載進來**。

為什麼不是兩個分支、也不是兩份 repo：這兩台跑的是同一份 clone 流程，
共用的部分（三層分層的理由、fork bomb 的兩道閘、作者身分）佔了大半，
分支會讓那些內容每改一次就要 merge 一次。

**寫新的內容時**：只有兩台都成立的才寫進 `SKILL.md`；只在一台驗過的，
寫進那台的附檔，並在另一台的對應段落留一句「這台的成因不同」。
沒實測過的要明著標。

`worker` 用的是**同一種分派器結構，但按階段切**（`enlist` / `dispatch` / `watch`），
因為那支的平台差異是散在每個階段裡的，按平台切會把同一段流程講三次。
機器本身的身分事實（IP、規格、金鑰怎麼派）不寫進 skill，留在記憶檔
`windows-machine`／`m5pro-machine`——skill 寫流程，記憶檔寫身分。

## `home/` —— 接回家目錄的設定

**這個目錄不是 skill。** 它裝的是原本散在家目錄、沒有版控的檔案，
`bootstrap.sh` 用 symlink 把它們接回生效位置。

| 檔案 | 接到 | 是什麼 |
|---|---|---|
| `home/zshrc` | `~/.zshrc` | PATH 順序、`CLAUDE_CODE_CHILD_SESSION` 清理、quad 掛勾 |
| `home/claude/settings.json` | `~/.claude/settings.json` | 三個行為 hook、權限白名單 |
| `home/claude/commands/` | `~/.claude/commands/` | slash command |
| `~/Projects/office/office/agents/` | `~/.claude/agents/` | subagent（office 四位角色的出差版；定義歸 office repo，有 office 才接） |
| `home/claude/tools/statusline.mjs` | settings.json `statusLine` | 底部狀態列：帳號@機器、專案分支、模型用量、context % |
| `home/claude/memory/` | `~/.claude/memory/` | 記憶檔——這台機器踩過的所有坑 |
| `home/bin/quad` | `~/.local/bin/quad` | 四宮格排版腳本（`.zshrc` 每次開終端機都會叫它） |

改這些檔案有兩條路都可以：直接改生效位置（symlink 會寫進 repo），或直接改
`home/` 底下。**兩者是同一份檔案。**

## `machine-setup/` —— 把新機器接進來

依平台分（2026-09-02）：`macos/` 與 `windows/`，兩支都是 subtree 併進來的，歷史保留。
用法與注意事項看 [machine-setup/README.md](machine-setup/README.md)。

跟 `bootstrap.sh` 的分工：**`bootstrap.sh` 管這台機器自己的 Claude 設定，
`machine-setup/` 管它跟其他機器的連線。**

> ⚠ `windows/` 併進來（2026-09-02）之後，全新 Windows 機器**不能再靠 `git clone`
> 拿到接機腳本**——這個 repo 是 private 而那台當下還沒有認證。替代作法（瀏覽器
> Download ZIP／scp／貼上）寫在 `machine-setup/README.md`。

`settings.json` 現況（2026-09-16 現場量的）：**5 個事件、7 個 hook 指令、
23 條 `permissions.deny`**——跟 ARCHITECTURE.md 第 ② 張圖是同一組數字。

**真的會擋下動作的只有三格**，其餘只觀察：

| 擋得住的 | 擋什麼 |
|---|---|
| `PreToolUse` × 2 | `git commit` 的作者身分；`browser_batch` 的子工具白名單 |
| `permissions.deny` × 23 | 毀滅性指令、9 條 force push、`resize_window`、`tabs_create_mcp` |
| `Stop` → `ask-with-options.mjs` | 回合以問號結尾卻沒叫 `AskUserQuestion` → 退回 |

`SessionStart` 注入的三條常設偏好（有條件才 grill、不要做到一半停、commit 就 push）
是**請求不是保證**，內容在 `settings.json` 的 `SessionStart` 那一格。

**⚠ Windows 的 `settings.json` 是刻意分岔的另一份**（2026-08-16 實測比對）。
它不在版控裡，因為裡面有三處非得不同不可：

| | mac | Windows |
|---|---|---|
| 提示音 | `afplay /System/Library/Sounds/*.aiff` | `rundll32.exe user32.dll,MessageBeep` |
| `permissions.deny` | `rm -rf /Users/bruuucemac`、`diskutil eraseDisk` | `rm -rf C:\`、`Format-Volume`、`diskpart` |
| 外掛 | `swift-lsp` | `superpowers`、`example-skills`、`planning-with-files` |

**共通的兩個 hook（SessionStart 的行為約定、PreToolUse 的作者身分檢查）內容是一樣的**，
改動要記得兩邊都改——目前沒有任何機制會提醒你。

## 兩個 repo 的邊界（2026-09-02 收斂完）

環境相關的東西現在只剩**兩個** repo，都是 private：

| repo | 裝什麼 | 位置 |
|---|---|---|
| **`claude-skills`**（這個） | 11 個 skill、`home/` dotfiles 與記憶檔、`machine-setup/{macos,windows}/` | **必須**在 `~/.claude/skills` |
| **`projctl`** | `proj` 控制台（CLI + web dash + `chrome-ext/`） | mac `~/Projects/projctl`（2026-10-01 前叫 `.projctl`）／Windows `D:\Claude\Projects\projctl`（**各自位置不能改**，`lib.mjs` 靠自己住的目錄推算 ROOT） |

已經併掉的三個。**2026-09-03 三個都從 GitHub 刪除了**——不是封存，是刪掉，URL 會 404：

| 原 repo | 何時併 | 併去哪 |
|---|---|---|
| `air2-bootstrap` | 2026-08-17 | `claude-skills/machine-setup/macos/` |
| `chrome-tab-groups` | 2026-08-17 | `projctl/chrome-ext/`。`~/Projects/chrome-tab-groups` 是指進去的 symlink，當初是因為 `.projctl` 是隱藏目錄、Chrome 選不進去才留的；2026-10-01 改名後留著無害 |
| `win-worker-bootstrap` | 2026-09-02 | `claude-skills/machine-setup/windows/`（併之前先從 public 轉 private） |

`~/.archive/` 的本機 clone 同日也清掉了，所以主要的還原管道是：那三段歷史
活在合併後 repo 的 `git log` 裡（來源 commit `5e03f99` / `1a6f747` / `1234dff`，
用 `git cat-file -e <sha>^{commit}` 驗得到）。

> ⚠ **這兩個 repo 現在是那三段歷史唯一的載體。** 本機與 GitHub 各一份，
> 所以 `git push` 之後才算真的有備援——**不要 force-push、不要改寫歷史**，
> 也不要對這兩個 repo 用 `rebase`（本來就不行，見 `ship` skill 的 subtree 那節）。

### ⚠ 更正（2026-09-16 逐顆比對）：上面那段有兩處不準

**一、`subtree` 併進來的不是完整歷史，至少 `air2-bootstrap` 不是。**

拿 M5 Pro 上倖存的那份 clone 逐顆比對，結論是：

| repo | GitHub | 倖存的 clone | 那份 clone 的 commit 有幾顆**不在**合併後的 repo |
|---|---|---|---|
| `air2-bootstrap` | **404** | M5 Pro `~/Code/air2-bootstrap`（14 顆） | **13 顆** |
| `win-worker-bootstrap` | **404** | desk `E:\Project\win-worker-bootstrap`（2 顆） | 0 顆（完全涵蓋） |
| `chrome-tab-groups` | **404** | 四台都沒找到 | 無從比對 |

也就是說 **`air2-bootstrap` 只有 tip commit `5e03f99` 進了 `claude-skills`，
其餘 13 顆歷史目前只存在於 M5 Pro 的那份 clone 裡**，而它的 `origin` 指向一個
已經 404 的 URL——推不出去、拉不下來、沒有任何備援。

> **所以清理 M5 Pro 的 `~/Code` 時，`air2-bootstrap` 必須排除在外。**
> 它現在是那 13 顆 commit 唯一的載體。要讓它安全，得先在 GitHub 上重建一個
> private repo 再 push 上去——在那之前，刪掉它就是真的沒了。

`win-worker-bootstrap` 相反：desk 上那份的兩顆 commit（`69116fd`、`1a6f747`）
在 `claude-skills` 裡都找得到，是純冗餘副本，刪掉沒關係。

**二、那三顆 SHA 不在同一個 repo，照著上面那行驗會有一顆查不到。**

| commit | 原 repo | 要在**哪個** repo 裡驗 |
|---|---|---|
| `5e03f99` | air2-bootstrap | `claude-skills` |
| `1a6f747` | win-worker-bootstrap | `claude-skills` |
| `1234dff` | chrome-tab-groups | **`projctl`**（不是 `claude-skills`） |

在 `claude-skills` 裡跑 `git cat-file -e 1234dff^{commit}` 會回「不在」，
那不是歷史遺失，是查錯 repo——`chrome-tab-groups` 當初是併進 `projctl` 的。

三個都用 `git subtree` 併，歷史保留。**所以這個 repo 與 `projctl` 都不能 `rebase`**
（會去重放被匯入的 commit，炸在一個跟你無關的衝突上）——一律 `git pull --no-rebase`。
認法：`git log --oneline | grep "^[0-9a-f]* Add '"`。

### 為什麼 `projctl` 不併進來

它是會跑的服務（launchd agent、常駐 web server、`proj` 掛在 PATH、79 個測試），
跟「設定與文件」是不同性質的東西。併進來只會讓 `~/.claude/skills` 這個每台新機器
都要 clone 的目錄多背一個 dashboard，而且兩者的改動節奏差很多。

| 其他 | 在哪 |
|---|---|
| 七個專案本身 | 各自的 repo |

## 寫 skill 的原則

只寫**下一個人不知道就會做錯**的東西。內容要來自實際踩過的事，
附上可重跑的指令與當時的實測結果——判斷方法比數字重要，數字會過時。

### 一條規則該放哪一層：先問觸發條件能不能用 glob 表達

第 ① 張圖說的是「同一份知識放三個位置，成本差三個數量級」。那是**觀察**；
下面這條是從它推出來的**決策規則**，寫新規則之前照著問一次：

| 觸發條件 | 放這裡 | 分類器是誰 | 成本 |
|---|---|---|---|
| 能用 glob 表達（副檔名、路徑） | `rules/*.md` 的 `paths:` | **檔案路徑比對，不是模型** | 不相關時為 0 |
| 不能，但能用一句話描述場景 | skill 的 `description` | 模型 | 一句話 |
| 兩者都不行，且**必須每次成立** | `AGENTS.md` | 沒有分類器，永遠載入 | 全額 × 每次請求 |

**能用 glob 的就不要交給模型判斷**——路徑比對不會抽籤，模型會。
`browser.md` 就是這樣搬下去的：硬規則（不准 resize、開了要收）留在 `CLAUDE.md`，
因為它們在「沒讀任何前端檔就決定開瀏覽器」時也必須成立；做法與根因用 `paths:` 限定。

**推論**：`description` 不是說明文，是路由信號。所以**多個 skill 的 description 不能
宣稱同一個時機**，否則模型只能抽籤。`preflight`／`handoff`（現 `recon`）／`env-doctor` 一度三個
都寫「開工前／怪怪的時候」，2026-09-16 各自補上邊界（不針對症狀的全面體檢／
只查 repo 現況／要有講得出來的症狀）。

### 要加自動檢查之前：它看得到判斷所需的資訊嗎

**判準：這個檢查要判「通過」，需要的資訊在它看得到的輸入裡嗎？不在就不要加。**

兩個相反的結論都來自這一條：

- **三道守衛（`smoke`／`doc-audit`／`vitals`）成立**——檔案在不在、指令跑不跑得起來、
  數字是多少，全部在它看得到的範圍內。所以它們能做出穩定的紅綠判定。
- **`hooks/keep-going.mjs` 不成立，而且刻意不裝**——它要判的是「這件事做完了嗎」，
  但決定答案的資訊（剩下的事在不在這次請求的範圍內）**不在助理的文字裡**。
  拿 1,408 組真實配對量過，六個門檻全部淨負值。完整數據在那個檔案的開頭註解。

加了看不到判斷依據的檢查，得到的不是「多一層保護」，是**淨負值的誤判**。

### 迴圈型的 skill 一定要寫退出條件

有驗收標準、沒有退出條件的「改 → 驗 → 再改」迴圈，最後會演變成把驗證本身改鬆。
**紅燈消失了，沉默回來了**，比一開始沒有那道檢查更糟。

所以每一支會反覆修東西的 skill 都要寫三件事：**修幾次算數、觸頂之後做什麼、
交出什麼資訊**。已經寫了的：`inspect-ui`、`sync-docs`（兩次）、`newproj` 的三道守衛
（三次，且不准動判定條件）。

### 外來 skill 不要就地改

`install-external.sh` 管的那幾支（`agents-best-practices`／`archify`／`security-audit`／
`sprite-gen`）**不在版控裡**，而且釘在上游的某個 commit。在那裡面加規則，
下次重裝就沒了，也不會跟著 repo 上其他三台機器。要給它們加約束，寫在這裡或
`AGENTS.md`，不要寫進它們的 `SKILL.md`。

### subagent 的邊界：機制過得去，觀測過不去（2026-09-16 實測）

派 subagent 之前需要知道的三件事，實測結果如下（拋棄式 repo，刻意設成無效的
git 身分，主 session 先做對照組）：

| 東西 | 跨得過 subagent 邊界嗎 | 怎麼測的 |
|---|---|---|
| `PreToolUse` 作者身分檢查 | **會擋**，回傳同一段中文訊息 | subagent 跑 `git commit`，指令沒進到 shell |
| `permissions.deny` | **會擋**，回傳 harness 制式拒絕訊息 | subagent 跑 `git push --force`，同樣沒執行 |
| `CLAUDE.md`／`AGENTS.md`／`MEMORY.md` | **有載入**，以 system-reminder 注入在 context 開頭 | 零工具呼叫的記憶探針，五題全答得出來 |
| `InstructionsLoaded` hook | **不觸發** | subagent 跑完，`instructions-loaded.jsonl` 沒有新事件 |

**所以強制層在 subagent 底下是完整的**——「不要用 subagent」是使用者的偏好，
不是因為它會繞過 hook。

**但 `instructions-loaded.jsonl` 少算 subagent。** 拿它稽核「這個 session 載入了什麼」
時要記得：subagent 的 context 載入完全不在那份 log 裡，看到的是下限不是全貌。
