---
name: ship
description: 「push」「推上去」「/ship」或 commit 之前跑。一氣做完：跑專案測試 → 核對 git 作者身分（有一批舊 commit 作者是錯的）、確認沒把別人的改動掃進自己的 commit、只 add 自己動過的檔 → commit → fetch 確認不撞 non-fast-forward → push → 驗證。mac 與 Windows 通用，Windows 的差異在最後一節。
---

# 提交前的檢查

## 0. /ship 一氣做完的流程（2026-10-12）

使用者打「push」「git push」「/ship」就是要這整串，**不要中途停下來問**（常設授權：commit 就 push；
2026-10-20 起程式碼改走 PR、審查通過就自己合併，也是常設授權）。force push、改寫已推歷史不在授權裡。
只限 `bruuucechang` 的 repo（判準是 remote owner）；Windows 兩台沒裝 `gh` 之前照舊直推。

1. `/recon` 那三行：`git status --short`、`git fetch -q && git status -sb | head -1`。落後就先 `git pull --ff-only`；不能 ff 就停下用選項問。
2. 跑專案自己的驗證（`CLAUDE.md`／`AGENTS.md` 寫的；常見 `./test.sh`、`npm test`、`bash tools/smoke.sh`）。紅了就修，不准帶著紅燈推。
3. 下面第 1 節核對作者身分。
4. **分類**：`~/.claude/skills/home/bin/ship-classify <要提交的檔…>`（用全路徑，別台機器沒有 `~/.local/bin` 的連結）。印 `docs` → 走 5a 直推；印 `code` → 走 5b 開 PR。
   文件類＝`.md`（含交接單、`blocks.md`、記憶檔——使用者裁示記憶檔直推），**但 agent 的規則檔算程式碼**：SKILL.md／AGENTS.md／CLAUDE.md、
   rules/、commands/、agents/ 底下、以及跟 SKILL.md 同一棵目錄的 skill 子文件。`.txt`、`docs/` 底下的非 `.md` 都算程式碼。
5a. **直推**：先看 `git log --oneline @{u}..HEAD`——**有不是你的 commit 就不准在這裡推**（推出去會連別人的一起帶走），
    改照 5b 第 1 步開 worktree，commit 後 `git -C "$W" push origin HEAD:<目標>`（只有 .md 不用 PR）。
    乾淨才在原地：第 2 節只 add 自己的檔，`add && commit` 同一次呼叫 → `git show --stat HEAD` → `git push` → 確認不再 ahead。
    全域 pre-push `pr-prepush.mjs` 會擋 agent 把程式碼推進非 `pr/` 分支；`pr-guard` hook 擋會跳過它的寫法：`--no-verify`、不到 2.55 的 git（`/usr/bin/git` 是 Apple 2.50）、這台還沒裝全域 hook。
5b. **PR**（規格 `ship/pr-flow-spec.md`）：
   1. **不要在共用的 checkout 裡切分支**——別的 session 正在同一個工作區，切了它們會 commit 到你的分支上。
      `<目標>`＝這個 checkout 追的分支（`git rev-parse --abbrev-ref @{u}` 去掉 `origin/`；沒有 upstream 就用
      `gh repo view --json defaultBranchRef -q .defaultBranchRef.name`），不一定是 master——claude-skills 的工作在 `feature/dataviz-tufte-skills`。
      worktree 只從 `origin/<目標>` 長；共用 checkout 上別人沒推的 commit 不歸你管，不要替它推、也不要 reset 掉。
      **把自己的改動整包搬進 worktree，共用 checkout 同時拿掉**（之後改動只活在分支上，修幾輪、卡住都不會留殘骸）：
      ```bash
      B=pr/$(date +%y%m%d-%H%M)-<短名>; W=<scratchpad>/wt-${B//\//-}; P=<scratchpad>/${B//\//-}.patch
      git worktree add -b "$B" "$W" "origin/<目標>"
      git restore --staged -- <自己的檔…>                  # 先退回工作區，已暫存的才不會留在共用暫存區被別人 commit 走
      git diff --binary -- <自己的檔…> > "$P"             # 混了別人的 hunk 就照第 2 節刪掉
      git -C "$W" apply "$P" && git apply -R "$P"          # 新檔（untracked）另外 mv 過去
      ```
      在 `$W` 裡照第 2 節 add＋commit，`git -C "$W" push -u origin "$B"`。
      已經在自己的 lane worktree（animyria）就直接在 lane 裡開分支，不必再開。
      **animyria**：推分支加 `--no-verify`——pre-push 的長測試由 pushq 在合併前跑，推分支不必先跑一次（pushq-guard 只擋推 master）。
      這時 refspec **要把分支名寫出來**（`HEAD:pr/261021-0930-xxx`），或在 lane 裡（cwd 在 pr/ 分支上）推 `HEAD`：
      pr-guard 看不到 `"$B"`／`"$W"` 這種變數，寫變數會被當成推別的分支擋下。
   2. `gh pr create --base <目標> --head "$B" --fill-first`（一定帶 `--head`：cwd 是共用 checkout，不帶會拿錯分支），
      內文改寫成：為什麼、驗證跑了什麼、`Claude-Session`、PR attribution 行。
   3. 用 Skill 跑 `code-review`，參數 `high <PR 完整網址> --comment`，結果留在 PR 上。
      **一定給網址不給號碼**：審查跑在 fork 出去的 agent，cwd 不一定是這個 repo——只給 `1` 時它猜成別的 repo 的 PR #1（2026-10-20 實際發生）。`high` 寧可多報，所以**逐條自己判**：
      實測重現、或讀程式能指出確定會壞的正確性問題才算擋下；推論型、清理、文件措辭留在 PR 上不擋，回報時列出。
   4. 擋下 → 在 `$W` 修、**在 `$W` 重跑第 2 步的專案驗證**（缺依賴就把共用 checkout 的 `node_modules`／`.venv` 之類 symlink 過去）、
      commit、push 同一分支、重審。**PR 不留給使用者按**（2026-10-21 裁示）：兩輪後還擋，逐條裁定——
      確定會壞的繼續修；推論型、故意繞（不在威脅模型）、清理建議在 PR 留言寫明理由後合併，回報時列出。
      **不碰 GitHub 規範**：不用別的帳號 approve 自己、不 `gh pr merge --admin`、不改 branch protection、不關 required checks。
   5. 通過 → **先** `git worktree remove "$W"`（分支還被 worktree 佔著時 `--delete-branch` 刪不掉本機分支）→
      `gh pr merge <號> --squash --delete-branch`。
      **animyria 改成** 在 lane 裡 `pushq enqueue`（commit 進 master 後 GitHub 自己把 PR 標成已合併）；
      pushq 回 needs_fix 時修的那一筆**推回同一個 PR 分支、重審過再重新 enqueue**，不准沒審就進 master。
   6. `gh pr view <號> --json state` 是 `MERGED`（animyria 看 `pushq status`）→ 共用 checkout `git pull --ff-only`。不能 ff 通常是別的 session 有沒推的 commit：**不要合併、不要問**，
      留給它們下次推的時候拉；回報寫「已合併，這個 checkout 還沒同步」。
6. 回報：commit hash 或 PR 網址、審查結果、驗證跑了什麼。
7. **如果這是這次請求做完的最後一推**（不是中途的 push），回報完接著走 `handoff` skill 的「做完自動交接」：
   寫交接單 → `handoff-open <交接單>`。這一步之後就結束回合，這格會自己 /clear 再讀交接單接著做。

三件事，每一件都出過事。**這一份 mac 與 Windows 通用**——git 指令本身沒有平台差異，
作者身分要求也一樣（`PreToolUse` 掛勾兩邊都會擋錯身分的 commit）。
Windows 專屬的兩點在最後一節。

---

## 1. 作者身分

**舊 commit 裡有兩種壞掉的作者，數量差 20 倍，容易只抓到小的那種**
（2026-09-03 實測，掃 `~/Projects` 底下所有 repo 加 `.projctl` 與 `claude-skills`）：

| 壞法 | 筆數 | 分布 |
|---|---|---|
| **主機名假信箱**（`xxx@MacBook-Pro.local` 這類） | **141** | interior-designer 77、palrogue 57、News 7 |
| `work@example.com`（位址沒註冊在 GitHub） | 6 | loan-ledger 2、namecard-archive 3、interior-designer 1 |

兩種在 GitHub 上都不會連到帳號。**只 grep `work@example.com` 會漏掉 96% 的問題。**
要重算：

```bash
for d in ~/Projects/*/; do [ -d "$d/.git" ] || continue
  git -C "$d" log --all --format='%ae' | grep -cE '^peter@work\.tw$|@(Mac|MacBook|DESKTOP|BRUCEVICTUS|.*\.local|.*\.lan)'
done
```

正確身分是：

```
bruce <you@example.com>
```

每個 repo 各自設定，新 clone 的 repo 不會自動帶上。commit 前確認：

```bash
git config user.name; git config user.email
```

不對就設 local（**不要設 global 就算了**，要確定這個 repo 是對的）：

```bash
git config user.name bruce
git config user.email you@example.com
```

commit 完再驗一次：

```bash
git log -1 --format='%an <%ae>'
```

---

## 2. 只提交自己動過的東西

**這台機器常有多個 session 並行改同一個 repo**，工作區裡的改動不一定都是你的。

```bash
git status --short
```

- **不要 `git add .` 或 `git add -A`**，也**不要 `git commit -a`**
  （`-a` 跳過暫存區，直接抓走所有被追蹤檔的改動，等於 `add -A` 的變形）
- 逐個檔案 add，加之前 `git diff <file>` 確認那是你熟悉的改動
- 看到不是你做的改動就留著，不要順手帶進去，也不要 checkout 掉

如果不確定某個改動是誰的，`git log --oneline -3` 看看最近的 commit，
`Claude-Session:` 那行可以認出是哪個 session。

### ⚠ `add` 跟 `commit` 之間的空隙不安全

上面那條只防你污染別人。**反方向同樣會發生：你 staged 的檔案會被別人吃掉。**

暫存區是整個 repo 共用的，不是你這個 session 私有的。你 `git add` 之後、
`git commit` 之前，只要另一個 session 跑了 `git add -A` 或 `commit -a`，
你 staged 的東西就會被連同它的改動一起提交，掛在**它的** commit 訊息底下。

2026-09-03 實際發生（claude-skills）：三個檔被掃進一筆叫
「gitignore：hook 的 log 與 .off 開關不進版控」的 commit 並且已經 push。
內容沒壞，但那三個檔的改動理由永久消失了。**遵守上面那條規則並不能避免這件事。**

所以：

- **`add` 跟 `commit` 併成同一次 Bash 呼叫**，把空隙縮到最小：
  ```bash
  git add <路徑…> && git commit -F - <<'MSG'
  …
  MSG
  ```
- **commit 之後一定要驗**，不要假設它成功了：
  ```bash
  git show --stat --format='%h %s' HEAD    # 我的檔在不在我的 commit 裡
  ```
- 看到 `git commit` 回 **`no changes added to commit`** 而你明明 add 過 ——
  這就是被吃掉了，不是你搞錯。用 `git log -1 --format='%h %s' -- <檔案>`
  查它被併進哪一筆，先確認內容完整。
- **內容完整就不要動它**。那筆已經 push 了，拆開要 force push，而這個 repo
  **四台機器都有 clone**，而且路徑各不相同：

  | 機器 | clone 在哪 |
  |---|---|
  | Air | `~/.claude/skills` |
  | M5 Pro | **`~/.profiles/bruce/claude-skills`**（不是 `~/.claude/skills`——那個是另一套 rivendell 的 symlink 農場） |
  | BRUCEVICTUS | `C:\Users\user\.claude\skills` |
  | DESKTOP-KR4TOIA | `C:\Users\peter\.claude\skills` |

  要補紀錄就加一筆 `--allow-empty` 的空 commit 當註腳。

---

## 3. push 前先 fetch

```bash
git fetch origin
git status -sb | head -1
```

`behind N` 就代表直接 push 會被拒絕。**不要 `--force`。**

> 2026-09-03 起 `settings.json` 的 `deny` 有九條擋 force push，涵蓋
> `--force-with-lease`、flags 排在前面、`git -C <dir> push`、以及 `+refspec`
> 這幾種繞法。**但 deny 是字串比對不是安全邊界**——寫成腳本再跑、或
> `git config push.default` 之類的路徑照樣繞得過。它只是防手滑。

正確順序是：

```bash
git rebase origin/<branch>
```

rebase 之後**重新檢查你的改動內容還成不成立**——這是最容易漏掉的一步。
別人的 17 個 commit 可能已經讓你寫的東西過時了（實際發生過：文件裡的測試數、
埠位、目錄結構在 rebase 之後全部要改）。內容要改就 `git commit --amend`，
不要留一個一提交就過期的版本。

### ⚠ 有兩個 repo 不能 rebase：`projctl` 與 `claude-skills`

它們的歷史裡有 **`git subtree` 的合併**，一共三次：

| 併進去的 | 落在哪 | 何時 |
|---|---|---|
| `chrome-tab-groups` | `projctl/chrome-ext/` | 2026-08-17 |
| `air2-bootstrap` | `claude-skills/machine-setup/macos/` | 2026-08-17 |
| `win-worker-bootstrap` | `claude-skills/machine-setup/windows/` | 2026-09-02 |

**三個來源 repo 都已經從 GitHub 刪掉了**（2026-09-03），但那不影響這條規則——
被匯入的 commit 活在這兩個 repo 自己的歷史裡，rebase 照樣會去重放它們。
`git pull --rebase` 會去**重放那些被匯入的 commit**，然後炸在一個跟你完全無關的
衝突上（實測訊息：`Could not apply 5e03f99... feat: bootstrap script...`），
而且你會停在 rebase 進行中的狀態。

這兩個 repo 一律用合併拉：

```bash
git pull --no-rebase origin master
```

**已經炸了的話**：`git rebase --abort`（`--autostash` 的暫存會自己還原回來），
再改用 `--no-rebase` 拉一次。

怎麼認出一個 repo 有沒有 subtree：

```bash
git log --oneline | grep "^[0-9a-f]* Add '"      # 有 "Add 'xxx/' from commit ..." 就是
```

其餘 repo 照原本的 rebase 流程，**不要因為這條就全部改成 merge**——
那會在每個 repo 的歷史裡長出一堆沒有意義的合併節點。

---

## 分支名不一定是 master

這幾個 repo 混用：`loan-ledger` 是 **`main`**，其餘是 `master`。
`git push origin master` 打錯分支只會得到一個看不出所以然的錯誤。用：

```bash
git push origin "$(git branch --show-current)"
```

---

## commit message

用繁體中文，寫**為什麼**而不是做了什麼——做了什麼看 diff 就知道。
值得寫進去的是：這個改動解決的症狀長什麼樣、你怎麼確認它真的修好了、
以及下一個人容易誤判的地方。

驗證過的事實要寫進 message（實測數字、對照組結果），那是未來唯一還找得到的證據。

結尾兩行：

```
Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
Claude-Session: <當前 session 的 URL>
```

---

## 在 Windows 上多兩件事

**1. 換行。** BRUCEVICTUS 的 `core.autocrlf=true`（實測）：checkout 出來是 CRLF、
commit 回去是 LF，所以正常情況 `git status` 是乾淨的。但看到「整個檔案都被改了」
的 diff 時**先排除換行再說**：

```powershell
git diff --ignore-cr-at-eol --stat
```

兩邊 stat 差很多就是換行造成的，不要把它 commit 進去——那會讓另一台看到整檔變動。

**2. `git status --short` 之前先確認自己在對的磁碟機。** 從 mac SSH 過去的預設殼層
是 `cmd.exe`，`cd` 不換磁碟機，要 `cd /d D:\Claude\Projects\<repo>`。
少了 `/d` 會在 `C:\Users\user` 底下跑 git，回 `not a git repository`。

（GitHub 的認證在那台走 **per-repo deploy key**、七把金鑰七個 Host 別名，
remote 長 `git@github-<repo>:bruuucechang/<repo>.git`。push 被拒且訊息是
權限相關時，先看 remote 是不是那個別名，見記憶檔 `windows-machine`。）

---

## commit 完就 push，不要停下來問

**這是常設授權**（SessionStart hook 也是這樣寫的）：使用者已經單獨打過 9 次
「push」當作一整個回合，那 9 次都是不該存在的回合。commit 完就在同一輪推掉。

一次要推多個 repo 時，逐個報告結果——其中一個被拒絕不該淹沒在成功訊息裡。

**這三種還是要先問**，它們不在常設授權範圍內：

- `--force` / `--force-with-lease`（見上面第 3 節，這個 repo 三台機器 clone）
- 改寫已經 push 出去的歷史（rebase、amend 已推的 commit、`filter-branch`）
- 推到一個你這輪沒有 commit 過的 repo

（「開 PR」原本在這裡，2026-10-20 改成常設授權：程式碼走第 0 節的 5b。）
