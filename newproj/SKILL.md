---
name: newproj
description: 開新專案。串起 proj new（配埠、登錄、建 private repo）之後它沒做的事——建立前端/後端/資料庫三層骨架與三道守衛（smoke／doc-audit／vitals）、AGENTS.md 正本＋CLAUDE.md 橋接、project-map.json 作業圖、帶 paths: 的 rules、設 local git 身分、修正控制台的登錄表。怎麼跑 scaffold、資料庫從哪來，mac 與 Windows 不同，見 macos.md／windows.md。沒裝 proj 也能用（開頭有手動做法）。
---

# 開新專案

`proj new` 已經處理掉大部分，但它**沒有**做三件會事後很痛的事：
建立分層骨架、設 git 作者身分、建 CLAUDE.md。這個 skill 是把整條線走完。

> **沒有 `proj` 時**（`proj` 是作者自己的專案控制台 projctl，選配）：第 1 步改成手動做，其餘照舊。
>
> ```bash
> mkdir -p "${PROJECTS_ROOT:-$HOME/Projects}/<name>" && cd "$_"
> git init && git commit --allow-empty -m 'init'
> gh repo create <name> --private --source=. --push
> # 自己挑兩個沒人用的連號埠（例：5300 起往上找），先確認沒人在聽：
> lsof -nP -iTCP:5300 -sTCP:LISTEN; lsof -nP -iTCP:5301 -sTCP:LISTEN
> ~/.claude/skills/newproj/scaffold.sh <name> --web-port 5300 --api-port 5301
> ```
>
> 找不到 `projects.json` 時 scaffold 會自動跳過「修正登錄表」那步；第 5 節整節也跳過。
> 專案樹不在 `~/Projects` 的話設 `PROJECTS_ROOT`（scaffold 與 `sync-docs` 都讀它）。

**動手前先確定平台**（環境資訊的 `Platform`，或 `uname -s`）：

| 平台 | 專案放哪 | 資料庫哪來 | 讀哪份 |
|---|---|---|---|
| macOS | `~/Projects/<name>`（或 `$PROJECTS_ROOT/<name>`） | 本機共用的 PostgreSQL（brew 常駐服務） | **[macos.md](macos.md)** |
| Windows | 自己定（例：`D:\Claude\Projects\<name>`），scaffold 一定要給 `--dir` | **Docker 容器**（主機上沒有 psql／createdb） | **[windows.md](windows.md)** |

下面是兩個平台共通的部分：為什麼要這樣做、以及跑完之後要檢查什麼。
**具體指令一律看平台那一份**，這裡寫的指令會在另一個平台上失敗。

---

## 1. `proj new <name>`

```
proj new <name>      # 名稱只能是小寫字母、數字、連字號
```

它一次做完：建目錄、`git init` + 第一個 commit、寫 `.gitignore`、建 GitHub private repo、
**分配兩個沒人用的連號埠**（從 5300 往上）、登記進 `projects.json`。

失敗最常見的是建 repo 那步，它會印出手動補的指令：
`gh repo create <name> --private --source=. --push`。

> 有 `proj` 的話埠位由它分配，**不要自己挑**。撞埠的症狀是「打開網頁看到另一個專案」，
> 而且 mac 與 Windows 都可能有 IPv4/IPv6 分裂，兩個服務可能都綁得成功、不報 EADDRINUSE。

---

## 2. 建立三層骨架（`proj new` 不做）

跑法看平台那一份——mac 直接跑 `scaffold.sh`，Windows 要**指名 Git Bash**
（直接打 `bash` 會跑進 WSL）。埠位它會自己從 `projects.json` 讀回來，不用傳。

### 為什麼一定要跑這一步

**分層只要有一次偷懶就前功盡棄。** 既有專案是活教材：

| 專案 | 結構 |
|---|---|
| loan-ledger | `backend/` + `frontend/` |
| interior-designer | `server/` + `client/` |
| News | `api/`（內部有 routers/services，最成熟） |
| **namecard-archive** | **沒有分層**——`.jsonl`、`.html`、`package.json` 全躺在根目錄 |

四個專案四種長相，換一個專案就要重新認路。而 namecard-archive 那種狀態，
是每次開專案當下都覺得「這個很小不用分」累積出來的。

### 它產生什麼

```
<name>/
├── AGENTS.md           規則正本（跨工具標準檔名，Codex 也讀這一份）
├── CLAUDE.md           一行 @AGENTS.md 橋接
├── project-map.json    作業圖：節點／泳道／SOP，工作分類的單一真相
├── .claude/rules/      帶 paths: 的情境規則，不相關時零 context 成本
├── docs/notebook.md    量測與推導寫這裡，不進 context
├── tools/              doc-audit · smoke · vitals（三道會大聲失敗的守衛）
├── run.sh              一鍵起前後端，埠位從 .env 讀
├── .env.example        進版控（埠位不是祕密）；.env 不進
├── db/
│   ├── schema.sql      資料表的唯一真相
│   └── seed.sql
├── backend/
│   ├── requirements.txt · pytest.ini · conftest.py
│   ├── tests/              services 的單元測試，不起資料庫也不起 HTTP
│   └── app/
│       ├── main.py · config.py · db.py
│       ├── models/         資料表的 ORM 對應
│       ├── schemas/        對外承諾的資料形狀
│       ├── repositories/   ← 唯一可以碰資料庫的地方
│       ├── services/       業務邏輯，不知道 HTTP
│       └── routers/        HTTP 第一站，不寫業務邏輯
└── frontend/
    └── src/
        ├── App.tsx · main.tsx
        ├── api/client.ts   ← 唯一打後端的地方
        └── types.ts        對應後端 schemas
```

**技術選型是固定的**：FastAPI + SQLAlchemy + PostgreSQL · React + TypeScript + Vite。
這不是新增限制，是把既成事實寫下來——loan-ledger、interior-designer、News
三個後端本來就都是 FastAPI。版本釘死在實測可用的組合
（取自 interior-designer 的 requirements.txt）。

要偏離（例如這個專案非 Node 後端不可）**先說出理由**，不要默默改。


### 為什麼骨架要附這三道守衛

**既有專案裡最貴的 bug 全是「安靜壞掉很久才被發現」那種**：palrogue 的
`vitals.mjs` 一跑就 `TypeError`，而它不在 `npm test` 也不在 smoke 裡，
**十三天沒有人知道**，摘要表因此停更而原因不是沒人想重出，是重出不了。

三道守衛各自把一種沉默變成紅燈：

| 工具 | 抓什麼 | 沒有它的話 |
|---|---|---|
| `tools/smoke.sh` | 每支工具還跑不跑得起來 | 工具壞掉沒有任何訊號——它不在測試裡，平常也沒人跑 |
| `tools/doc-audit.py` | 文件提到的路徑還在不在 | 文件腐爛是必然的，差別只在多久後被發現 |
| `tools/vitals.py` | 文件引用的數字現在是多少 | 數字不會自己更新，而底下的東西一直在動 |

**三支都內建「沉默不等於成功」的防呆**：掃到 0 個目標時 exit 2 並明說結果不可信，
不允許印出通過。scaffold 交付前實測過：刪掉一個被文件提到的檔 → doc-audit 紅；
把工具改壞 → smoke 紅；把比對規則改成永不命中 → exit 2 而不是假綠燈。

**但守衛紅了之後修幾次才該停，這三支沒有規定——所以規定寫在這裡（2026-09-16 補）。**
守衛是「改 → 驗 → 再改」迴圈的驗證端，而這種迴圈只有驗收標準、沒有退出條件時，
會一路修到把守衛本身改鬆為止（那是最糟的結局：紅燈消失了，沉默回來了）。

> **同一道守衛連續修三次還是紅，就停下來問，不要修第四次，更不要動守衛的判定條件。**
> 要放寬守衛只有一條路：**先說明為什麼現在的判定是錯的**，經過同意才改。
> 停下來時要交出：哪一道守衛、三次分別改了什麼、每次的輸出、你認為真正的成因。

### 文件分三層，不要都往 AGENTS.md 疊

`AGENTS.md` 每個 session 完整載入（官方建議 200 行以內，超過會降低**所有**指令的
遵從度）。所以：

- **每次都要遵守的約束、踩過的坑、使用者裁示** → `AGENTS.md`
- **只在特定檔案相關的規則** → `.claude/rules/*.md`，**一定要有 `paths:`**
  （沒有 `paths:` 就跟寫在 AGENTS.md 一樣，每次都載入，沒省到）
- **量測、推導、被推翻的假設** → `docs/notebook.md`，零 context 成本
- **只給人看的考據** → 原地用 `<!-- -->` 包起來（注入前會被剝除）

沒有這條路由的話，那些內容會往 `AGENTS.md` 疊——palrogue 實測疊到 **21,983 行、
1.34 MB**，每個 session 完整載入。

### 骨架第一天就有測試

測的是 **services 那一層**：把 `item_repo` 換成 `FakeRepo`，所以**不起資料庫、
不起 HTTP**（實測把資料庫 drop 掉照樣全過）。這是三層分層唯一的實質回報，
骨架附一個能跑的範例是為了讓下一個測試照著抄。

專案第一天是補測試最容易的時候——只有一條示範 CRUD。錯過就很難回頭：
`loan-ledger` 是唯一沒經過骨架直接長出來的專案，也是唯一 0 個測試的
（News 37、interior-designer 19、palrogue 15、namecard-archive 6）。

`backend/conftest.py` 是空的但**不能刪也不能搬**——pytest 靠它所在的位置把
`backend/` 加進 `sys.path`，`from app...` 才 import 得到。

### 它還會做兩件容易漏的事

1. **建資料庫並套用 `db/schema.sql`** — **怎麼建 mac 與 Windows 完全不同**，看平台那一份。
2. **修正 `projects.json` 那筆** — `proj new` 寫進去的 `start` 是
   `npm run dev`（見 `newproject.mjs:128`），對前後端分離的專案是錯的：
   它只會起前端，後端沒人管。scaffold 會改成 `./run.sh` 並補上 `deps`。

### 什麼時候可以不做滿三層

**預設一律三層。** 只有這三種情況降級，而且**建完要主動告訴使用者判了哪一種、
為什麼**（不用先問，但要講）：

| 情況 | 怎麼做 |
|---|---|
| 純畫布／遊戲（前端就是本體，如 palrogue） | `--no-db`，後端只在真的要存檔時才建 |
| CLI 工具、一次性分析腳本 | `--no-frontend` |
| 完全沒有持久化需求 | `--no-db` |

`--no-db` **不會**把 `repositories/` 拿掉——分層目錄照建，只是不產生任何
會連資料庫的程式碼（`db.py`、`models/`、示範 CRUD 都不生成，`/health` 也
不去 ping 資料庫）。之後要接資料庫時位置已經留好，`repositories/__init__.py`
裡寫了該怎麼接。

> 這裡刻意不產生「連得到資料庫的程式碼但沒有資料庫」——那種骨架起得來、
> `/health` 卻回 `ok:false`、`/api/items` 直接 500，比沒有更糟，因為它
> 看起來像是能用的。

判斷準則：**問「這個專案三個月後會不會有人要改它」**。會，就三層都建。
「現在很小」不是理由——分層的成本是在專案長大之後才回收的，而開專案當下
永遠覺得不需要。

### 選項

```
--dir <path>       專案目錄
--web-port <n>     覆寫前端埠（預設從 projects.json 讀）
--api-port <n>     覆寫後端埠
--db <name>        資料庫名（預設專案名的連字號換成底線）
--no-registry      不改 projects.json（測試用）
--no-createdb      不執行 createdb
--no-db / --no-frontend
```

已經有 `backend/app/` 的話它會拒絕執行，不會蓋掉改過的程式碼。

---

## 3. 設 local git 身分（`proj new` 不做）

**有一批舊 commit 作者是壞的**——主要是主機名假信箱（141 筆），
`work@example.com` 只有 6 筆，兩種都不會連到 GitHub 帳號（細節與重算指令見 `ship`）。
新 repo 不會自動帶對的身分。正確身分讀 `~/.claude/skills/home/claude/config.json`
（`git_name` 與 `git_emails` 的第一個；安裝時填的）：

```bash
CFG=~/.claude/skills/home/claude/config.json
git config user.name  "$(jq -r '.git_name' "$CFG")"
git config user.email "$(jq -r '.git_emails[0]' "$CFG")"
git log -1 --format='%an <%ae>'      # 驗證
```

第一個 commit 已經被 `proj new` 做掉了，所以它的作者可能是錯的。
在專案還很小的時候修掉最容易：`git commit --amend --reset-author --no-edit`。

> 但**先看一眼再 amend**：`proj new` 建的第一個 commit 有時候作者本來就是對的
> （記憶檔 `trip-atlas` 記過這件事），改之前先 `git log -1 --format='%an <%ae>'`。

---

## 4. 把 CLAUDE.md 補完

scaffold 已經產生一份，裡面**分層規則的部分是完整的**（哪一層不准做什麼、
資料表改動要同步改哪兩個地方）。要補的是它填不了的：

- **Overview** — 這是什麼、解決什麼問題，兩三句
- **Tech Stack** 的「為什麼」——尤其是刻意避開某個常見選項的話
- **這些坑踩過了，別重犯** — 一開始是空的，每次踩到就補一條
- **這個專案只在哪台機器上跑得起來**（如果有這種限制的話，例如只有一台裝了資料庫）

不要寫成空模板。**只寫「下一個人動手之前不知道就會做錯」的東西**，其餘的看程式碼就好。

---

## 5. 確認控制台那筆（有 `proj` 才做）

scaffold 已經把 `start` 與 `deps` 改對了。剩下要確認的欄位：

- **`ports`** — 要如實填，衝突偵測與 Chrome 擴充的分頁分組都靠它
- **`ready`** — 判斷「起來了沒」看哪個埠
- **Docker 專案** 一定要設 `stop` 與 `detached`——殺掉 `docker compose up`
  那個程序不會停掉容器；沒設 `detached` 的話容器明明在跑，proj 卻因為找不到
  pid 檔而顯示「外部佔用」且拒絕停止
- **`logs`** — Docker 的輸出在 daemon 手上，不在 `logs/*.log` 裡

```
proj status
proj ports        # 看有沒有跟別人撞
```

---

## 6. 第一次啟動之後

`/health` 是**連資料庫一起檢查**的。只回 `{"ok":true}` 的健康檢查沒有用——
服務活著但連不上資料庫是最常見的故障型態，純 HTTP 檢查在那種狀態下一樣是 200。

驗證指令看平台那一份（**Windows 上 `curl` 是 `Invoke-WebRequest` 的別名，要打 `curl.exe`**）。
打不到就三種位址都試（`localhost`、`127.0.0.1`、`[::1]`），細節見 `env-doctor`。

**後端用 curl／CLI 驗就好，前端要照 `inspect-ui` 實際渲染過。** 骨架產的是
React + Vite，`/health` 回 200 不代表畫面起得來——那是兩件事（CLAUDE.md 第 3 節
與記憶檔 `verify-with-curl` 是同一條規則）。不要先問要不要看，直接看。

---

## 不要漏掉的收尾

- `.gitignore` 確認蓋掉了 `.env`、`.venv/`、`node_modules/`、`__pycache__/`、資料庫檔
- 真的有金鑰的話，`.env.example` 要進版控，`.env` 不能進
- **示範用的 `items` 那條線可以整條刪掉**——它只是分層的活文件。
  開始寫真功能時刪掉或改名沿用
- 專案有自己的重複流程（啟動順序、資料匯入、比較實驗）就放進
  該專案的 `.claude/skills/`，不要每次重講
- **如果這個專案不只一台機器會開**，在 CLAUDE.md 寫清楚各自的路徑與起法，
  不要假設另一台跟這台一樣
