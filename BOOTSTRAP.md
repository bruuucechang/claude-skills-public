# 換一台新機器

```bash
git clone git@github.com:bruuucechang/claude-skills.git ~/.claude/skills
~/.claude/skills/bootstrap.sh
```

`bootstrap.sh` 只做**檔案**的部分（建 symlink、檢查依賴在不在）。裝套件、開權限、
登入那些它做不到，跑完會列清單。下面是完整的一次。

---

## 這個 repo 裝了什麼

| 路徑 | 接到哪 | 是什麼 |
|---|---|---|
| `home/zshrc` | `~/.zshrc` | PATH 順序、`CLAUDE_CODE_CHILD_SESSION` 清理、quad 掛勾 |
| `home/claude/settings.json` | `~/.claude/settings.json` | 三個行為 hook、權限白名單 |
| `home/claude/commands/` | `~/.claude/commands/` | slash command（`查補助`） |
| `home/claude/memory/` | `~/.claude/memory/` | 19 個記憶檔——這台機器踩過的所有坑 |
| `home/bin/quad` | `~/.local/bin/quad` | Terminal 四宮格排版 |
| `*/SKILL.md` | 原地 | 8 個 skill（Claude Code 自己掃這個目錄） |

**用 symlink 不是複製**：以後改設定就等於改 repo，兩邊不會分岔。缺點是如果哪個
程式用「寫臨時檔再 rename」的方式存檔，symlink 會被換成一般檔案——重跑
`bootstrap.sh` 會偵測到、先備份再重新連。

`settings.json` 裡的 `autoMemoryDirectory` 釘死成 `~/.claude/memory`，這是刻意的：
預設路徑是 `~/.claude/projects/<把 cwd 消毒過的名字>/memory`，那個名字編碼了使用者
帳號，換帳號名就對不上，記憶就跟不走。

---

## 另外兩個 repo

這個 repo 不含它們，要各自 clone：

```bash
git clone git@github.com:bruuucechang/projctl.git ~/Projects/projctl
ln -s ~/Projects/projctl/proj.mjs /opt/homebrew/bin/proj

ln -s projctl/chrome-ext ~/Projects/chrome-tab-groups
```

**Chrome 擴充不用另外 clone 了**（2026-08-17 起併進 `projctl` 的 `chrome-ext/`）。
上面那條反過來的 symlink 是歷史遺留：2026-10-01 以前這個目錄叫 `.projctl`、是隱藏目錄，
Chrome 的「載入未封裝項目」選不進去。現在直接選 `projctl/chrome-ext` 也行。

**`projctl` 的位置不能改。** `lib.mjs` 是用 `ROOT = resolve(HERE, '..')` 推算專案
目錄的——它靠「我住在專案目錄裡面」找到專案，搬走就什麼都找不到。

---

## 腳本做不到的四件事

### 1. TCC「完全取用磁碟」← 最容易漏

系統設定 → 隱私權與安全性 → 完全取用磁碟，加入**兩個**：

- **Terminal.app**（`/System/Applications/Utilities/Terminal.app`）
  不加的話，Claude Code 對 `~/Documents` 整棵樹一律 EPERM——連 `ls` 都不行，
  `proj` 任何子指令都跑不動。關掉 sandbox 沒有用，這是 OS 層不是沙箱層。
- **node 的實體路徑**（含版本號，例如 `/opt/homebrew/Cellar/node/25.6.1/bin/node`）
  **加 symlink 沒有用**，Finder 會解析掉。不加的話 launchd 起的 node 讀不到
  `dash.mjs`，只回 `EX_CONFIG(78)`、log 全空，毫無線索。
  `brew upgrade node` 之後路徑會變、權限靜默失效 → `proj doctor` 有專門檢查。

**加完要整個 app ⌘Q 再開**（關視窗不算）。TCC 判定綁在 process 上，授權不會回溯
套用到已在跑的程序。

判斷有沒有生效：`ls ~/Documents` 不通但 `ls ~/Desktop` 通 → 是 TCC。
（長得一樣但成因不同的還有 iCloud 同步造成的 EPERM，那個重開終端機沒有用。）

### 2. 裝依賴

```bash
brew install node jq gh postgresql@17 ollama
brew services start postgresql@17
brew services start ollama
# Docker Desktop 從官網裝
gh auth login
```

`jq` 不是可有可無的——擋錯作者 commit 的那個 hook 用它解析輸入，沒有 jq
hook 會靜默失效。

`postgresql` 的版本號**不要寫死在任何設定裡**。這台是 `@17`，之前有設定寫成
`@18`，結果 PostgreSQL 一停掉，控制台的啟動鈕就以「找不到 formula」失敗——
而那個錯誤完全看不出是設定寫錯。

### 3. 重開終端機

`~/.zshrc` 要重新載入才生效。重開之後 quad 會接管視窗排版並自動起 claude。

跳過排版：`NOQUAD=1 open -a Terminal`

### 4. `proj dash install`

讓控制台開機自動起。它會先用一次性 probe agent 實測 TCC 權限，沒過就不往下走。

---

## 驗證

```bash
proj doctor                    # 埠衝突、孤兒程序、TCC 權限
proj status                    # 專案清單
ls -l ~/.claude/settings.json  # 要是 symlink 指向 repo
ls ~/.claude/memory | wc -l    # 記憶檔數量
```

Hook 有沒有活著（最直接的一招）——在一個作者身分故意寫錯的 repo 裡試著 commit，
應該要被擋下：

```bash
cd /tmp && rm -rf hooktest && mkdir hooktest && cd hooktest
git init -q && git config user.email wrong@example.com
echo x > a.txt && git add a.txt
git commit -m test          # 要被 hook 擋下來
cd /tmp && rm -rf hooktest
```

---

## 怎麼確認 bootstrap 真的能在新機器上跑

**在現有機器上跑一次不算驗證**——那台機器每個檔案本來就在，腳本只是把它們換成
symlink，證明的是「不會弄壞現有環境」，不是「能從零還原」。

真的要驗證就用一個假的家目錄，整條路徑走一遍（不需要新帳號，也不會動到現有設定）：

```bash
FAKE=/tmp/fakehome && rm -rf "$FAKE" && mkdir -p "$FAKE"
git clone https://github.com/bruuucechang/claude-skills.git "$FAKE/.claude/skills"
HOME="$FAKE" bash "$FAKE/.claude/skills/bootstrap.sh"

# symlink 要解得開、內容要讀得到
for f in .zshrc .claude/settings.json .claude/commands .claude/memory .local/bin/quad; do
  [ -L "$FAKE/$f" ] && [ -e "$FAKE/$f" ] && echo "OK   $f" || echo "壞掉 $f"
done
jq -r '.hooks|keys|join(", ")' "$FAKE/.claude/settings.json"
ls "$FAKE/.claude/memory"/*.md | wc -l

rm -rf "$FAKE"
```

2026-08-07 實測結果：5 條 symlink 全部解得開、4 個 hook 讀得到、19 個記憶檔、
8 個 skill、`quad` 有執行權限。

依賴檢查那一段會對照**真實的 PATH**（不是假家目錄的），所以那部分的結果不代表
新機器的狀況——新機器上那些多半是缺的，照著它印的指令裝就好。

## 這裡沒有涵蓋的

- **專案本身**——七個專案各自有 repo，要另外 clone
- **各專案的 `.env`**——不進版控，要重建
- **各專案的資料庫內容**——`proj new` 建的骨架只會建空的 schema
- **Chrome 擴充功能的載入**——要在 `chrome://extensions` 手動「載入未封裝項目」
