# PR 流程規格：改走 PR＋本機自動審查（2026-10-20，使用者逐題確認）

## 目標

增加 code review 與 PR 的產量。agent 改完程式碼不再直推 master，改開 PR、本機審查、通過就自己合併；
每次改動都留下 PR 與審查紀錄。

## 已裁示（逐題問過）

| 題目 | 決定 |
|---|---|
| 流程 | 改走 PR＋自動審查（不做定時巡檢、不是只審不開 PR） |
| 誰合併 | agent 自己合併——**常設授權**，取代「開 PR 沒有授權」。審查通過就合併；擋兩輪後 agent 裁定（見下面「被擋下」），一樣不留給使用者 |
| 審查在哪跑 | 本機 agent 自己審（`/code-review`），不放 GitHub Actions、不額外花 API 錢 |
| 哪些 repo | 所有自己帳號（`config.json` 的 `github_owner`）底下、未封存的 repo（判準是 remote owner，見 only-my-own-repos） |
| 被擋下 | agent 自己修、重審。~~最多兩輪、還不過就留給使用者~~ → **2026-10-21 改：PR 不留給使用者按，agent 自己處理到合併**（原話：「PR不要讓我自己按好了 你來處理 但不要影響github規章」） |
| 小改動 | 只有程式碼走 PR；diff 只動文件類就照舊直推 |

## 流程（`/ship` 改成這樣）

1. 現有的 recon、測試、作者身分、只 add 自己的檔——全部照舊。
2. **分類**：這次要提交的檔全落在「文件類」→ 照舊直推，結束。
   文件類＝`*.md`（含交接單、`blocks.md`、記憶檔）。其餘任何一個檔就算程式碼。
   **例外**（PR #1 審查補的）：agent 的規則檔（SKILL.md／AGENTS.md／CLAUDE.md、rules/、commands/、agents/、skill 子文件）算程式碼；
   `.txt` 與 `docs/` 底下的非 `.md` 也算程式碼（`requirements.txt`、`docs/conf.py`）。
3. 程式碼：在獨立 worktree 從最新 `origin/<目標分支>`（checkout 追的分支，不一定是 master）開分支 `pr/<日期>-<短名>`，commit 照舊，push 分支。
4. `gh pr create`：標題照 commit 慣例（繁體），內文寫為什麼、驗證跑了什麼、`Claude-Session`、attribution。
5. **審查**：`/code-review high <PR 完整網址> --comment`（只給號碼會猜成別的 repo），結果貼到 PR。
   `high` 寧可多報：只有實測重現或確定會壞的正確性問題才擋。
   通過＝沒有正確性問題（只剩清理建議不擋）。
6. 擋下 → 修、commit、push 到同一分支、重審。兩輪後還擋：agent 逐條裁定——確定會壞的繼續修，
   推論型、超出威脅模型（故意繞）、清理建議在 PR 留言寫明不修的理由，然後合併。不掛 needs-human、不等使用者。
   **GitHub 規範不碰**：不用第二個帳號替自己 approve、不用 `gh pr merge --admin` 或改 branch protection 繞過檢查、
   不關掉 required checks；repo 有設必要檢查就等它過。
7. 通過 → 移掉 worktree、`gh pr merge --squash --delete-branch`，確認 PR 狀態是 MERGED、共用 checkout 原地 pull（**不切分支**）。
8. 之後照舊（最後一推就交接）。

### animyria（有 pushq）

審查通過後**不用** `gh pr merge`，改 `pushq enqueue <分支>`：pushq 照舊合併最新 master、跑 pre-push、依序推。
分支的 commit 進了 master，GitHub 會自動把 PR 標成已合併。這樣 pre-push 的長測試不會被伺服器端合併繞過。

## 一次性設定

- 所有自己的 repo 開 `delete_branch_on_merge`（可回復）。
- `AGENTS.md` 常設授權表加一列「開 PR、審查通過就合併」，「沒有授權」那行拿掉「開 PR」。
- `ship/SKILL.md` 第 0 節改成上面的流程；最後「這四種還是要先問」拿掉「開 PR」。

## 機制（規則是請求）

- 全域 pre-push `home/bin/pr-prepush.mjs`（`git config --global hook.pr-guard.*`，bootstrap 會裝）：agent（`CLAUDECODE=1`／`CODEX_THREAD_ID`）
  把程式碼推進自己 repo 的非 `pr/` 既有分支 → 擋。git 給確切的 ref，不解析指令（PR #1、#2 的審查證明正則補不完）。
  使用者自己在終端機推不擋。
- `pr-guard` hook（PreToolUse Bash）：只擋跳過 pre-push 的寫法——`--no-verify`（`pr/` 分支除外）與帶路徑的 git（Apple 的 2.50 不跑設定檔的 hook）。
- Codex 不 commit；改動由我驗收後 `/ship`。
- 全域 pre-push 裝到哪了（2026-10-21）：Air、mani 已裝；**M5 Pro 待裝**（使用者確認要裝，常被帶出門，離線中）。
  裝錯不會報錯（指令找不到檔就放行），所以每台都要跑下面的驗收。
  - git 版本門檻 2.55（`pr-guard.mjs` 的 MIN；mani 的 2.51 實測不跑設定檔裡的 hook，升到 2.56 後會跑）。
    要看的是 **agent 的 shell 實際叫到的那支**：`command -v git; git --version`，不只是 `/opt/homebrew/bin/git`；
    PATH 裡 `/usr/bin` 排在前面的話會叫到 Apple 的 2.50。
  - M5 Pro 的 clone 在 `~/.profiles/bruce/claude-skills`，而且可能還停在 master（`pr-prepush.mjs` 只在 `feature/dataviz-tufte-skills` 上）：
    先 `fetch`，再 `checkout feature/dataviz-tufte-skills && pull --ff-only`，`ls home/bin/pr-prepush.mjs` 確認檔案在。
    **之後那份 clone 切回沒有這支檔的分支，hook 會安靜失效**（`pr-guard.mjs` 目前只查有沒有設、不查檔在不在，待補）。
  - 不要整支跑 bootstrap.sh（會把 manibari profile 的 `~/.claude` 換成 symlink），只跑下面三行。
    hook 指令的正本是 bootstrap.sh 裡的 `hook.pr-guard.command` 那一行，這裡是把路徑展開後的副本，兩邊不一致時以正本為準：
    ```bash
    git config --global hook.pr-guard.event pre-push
    git config --global hook.pr-guard.command "f='$HOME/.profiles/bruce/claude-skills/home/bin/pr-prepush.mjs'; [ -f \"\$f\" ] && command -v node >/dev/null 2>&1 || { cat >/dev/null; exit 0; }; exec node \"\$f\""
    chmod +x ~/.profiles/bruce/claude-skills/home/bin/pr-prepush.mjs
    ```
  - M5 Pro 上的逃生門是 `touch ~/.profiles/bruce/claude-skills/home/claude/hooks/pr-guard.off`（`pr-guard.off` 跟著 clone 走），
    擋下時訊息裡寫的 `~/.claude/skills/…` 在那台不對。
  - `~/.gitconfig` 是 manibari 和 bruce 兩個 profile 共用的，所以 manibari 那邊推的時候也會跑這支 hook。可以接受，因為
    這次推的 remote 網址 owner 不是 `github_owner` 就放行，任何例外也一律放行。例外：manibari 有 remote 指到 `github_owner` 的 repo 的話會被擋。
  - 驗收：`git config --global --get hook.pr-guard.command` 有值，然後在暫存目錄開一個假 remote `<tmp>/<github_owner>/x.git`。
    下面的「人推」一律寫成 `env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID -u CODEX_THREAD_ID git push …`
    （agent 的 shell 本來就帶這些變數）；「agent 推」帶 `CLAUDECODE=1 CLAUDE_CODE_SESSION_ID=t`。
    1. 人推一個只有 `README.md` 的 init 到 master 和 `pr/x`（遠端分支先存在，不然新分支會直接放行，什麼都沒驗到）。
    2. commit 一個 `a.py`：agent 推 master 要印「推被擋下來了」；agent 推 `HEAD:pr/x` 要成功；人推 master 要成功。

## 明確不做

- 不動別人的 repo（manibari、mumigood…），就算 clone 在這台。
- 不放 GitHub Actions、不放 API key。
- 不開 branch protection 的「需要 approve」——自己的 PR 不能 approve 自己，會卡死。
- 不做定時巡檢、不回頭審舊 commit。
- force push、改寫已推歷史仍然沒有授權。
- Windows 兩台：`gh` 沒裝之前照舊直推，不在這次範圍。

## 驗收

1. 在一個自己的 repo 做一個小的程式碼改動 → 跑 `/ship` → 看到 PR 開出、審查留言貼上、自動 squash 合併、遠端分支被刪。
   `gh pr list --state merged --limit 1` 看得到。
2. 只改 `.md` 的提交 → 直推 master，沒有開 PR。
3. 所有自己的 repo：`gh api repos/$(gh api user -q .login)/<repo> --jq .delete_branch_on_merge` 全是 `true`。
