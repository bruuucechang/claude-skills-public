# 推送佇列（push queue）規格

> 2026-10-20 使用者逐題確認。起因：animyria 同時有 5 格各自重試推 master，每格 pre-push 跑 10〜50 分鐘，
> 跑完 master 已被別格推動，於是一直重來；其中兩格還卡在連 desk 的 ssh 上空等 5.5 小時。
> 使用者原話：「可不可以叫一個session等就好了」。

## 目標

一個 repo 的 master 只由**一個背景程序**依序推。各 session 把分支丟進佇列就可以交接，不再各自等 pre-push。

## 已裁示

| 項目 | 決定 |
|---|---|
| 誰來推 | **背景常駐程式**（launchd），不是 Claude session，不花額度 |
| 範圍 | **先只接 animyria**；程式寫成通用的，別的 repo 之後登記就能用 |
| 失敗誰修 | 合併衝突或 pre-push 紅 → 派給使用者預留的**空白 session**（還沒講過話、閒著的那格），把失敗訊息打進去叫它修、修好再丟回佇列。佇列不自己開新 session（會撞到「確認」的限制）|
| 找不到空白 session | 那件停在佇列裡標「等人修」，推通知給使用者 |
| 強制 | **擋住**：pre-push 發現不是佇列在推 master 就拒絕，並印出改用佇列的指令。留一個使用者手動用的繞道 |
| 下一塊的基準 | 丟進佇列就交接；接手的 session **從丟進去的那個分支接著做**。佇列依丟進來的順序推，後一塊不會比前一塊先上去 |
| 推成功之後 | 佇列**自動收 lane**（worktree＋分支）。分支已進 master 才收；worktree 正被別的分支用著、或有沒 commit 的改動就不收 |
| 現在在重試的 5 格 | 上線那一刻：停掉它們的重試腳本、分支丟進佇列、傳訊息告訴各格「已在排隊，可以交接」。已推上去的不動 |

### 追加（2026-10-20 上線後，使用者再確認）

| 項目 | 決定 |
|---|---|
| `--no-verify` 繞過 | 上線 20 分鐘內就有一格用 `--no-verify` 推了 master（pre-push 整個不跑）。補一道 Claude Code 的 PreToolUse hook（`pushq-guard`）：推登記過的 repo 的 master 又帶 `--no-verify`／`PUSHQ_*` 就擋 |
| mani | **也接進這條佇列**。mani 沒有 ssh 回這台的路，改用 origin 當管道：mani 的 `pushq enqueue` 把 commit 推到 origin 的 `pushq/<機器>/<時間>/<分支>`，這台的佇列每分鐘收一次、處理完刪掉。mani 的 lane 佇列收不到，由 mani 那格自己收 |
| 佔位 commit | **走快速道**：跟 master 比只改 `blocks.md` 的件插到最前面，只跑 `doc-audit` 就推，不跑完整測試；跟一般件並行跑（各用一個 worktree），幾分鐘內進 master。這是放寬守衛，只限 `blocks.md` |
| 快速道推完害一般件被拒 | 一般件推的時候被拒、而 master 在它驗證期間只多了 `blocks.md` 的改動 → 合併後只跑 `doc-audit` 就推，不重跑全套（驗過的樹只多了文件） |

| 生成檔的合併衝突 | 第一輪 14 件有 12 件因為 `docs/notebook.md` 的測試數那一行、`game/locale/*.pot／*.po`（全由 `i18n.py extract` 重產、沒有人工翻譯）被退回。佇列合併撞衝突時先跑專案的解法（`pushq-resolvers/animyria.sh`）：**只解這兩種**，其他衝突照舊退給人修；解完照跑完整 pre-push |
| 合併乾淨但數字過期 | 2026-10-21 BX4：兩邊各加測試、數字那一行只有一邊改 → 合併不撞，pre-push 的 vitals 卻擋。每次真的合併（非快轉、非快速道）之後跑 `resolve --refresh`：只重量 notebook 那一行，有變就由佇列 commit「合併後對齊生成的數字（pushq）」 |
| notebook 兩邊各加一節 | 2026-10-21：解法只認數字那一行時，bd9a、st49c、f5 仍因兩塊都在檔尾加一節被退。notebook 只增不改，所以 diff3 看到 base 是空的就兩邊都留（master 在前）；改到既有段落照舊退給人 |
| hook 被裝回舊版 | 還沒合併新版 master 的 lane 會照 smoke 的提示把舊 hook 裝回共用的 `.git/hooks`。佇列推之前用合併好的樹重裝（`setup = tools/install-hooks.sh`）|

## 流程（每一件）

1. 拿佇列最前面那件，在佇列自己的 worktree 裡把它跟最新的 `origin/master` 合併。
2. 有衝突 → 退回（見「失敗」）。
3. 跑 pre-push 的同一套檢查（`./run.sh check`、`./run.sh test`）。紅 → 退回。
4. 綠 → 推 master（佇列身分，pre-push 放行），收 lane，記一筆結果，下一件。
5. 一件做完才拿下一件，所以下一件的基準就是這次推上去的版本，不會撞車。

後一件的分支如果是從前一件長出來的，前一件被退回時，後一件也停住，等前一件修好。

## 給 session 用的指令（草稿）

```bash
pushq enqueue [--repo .] [分支]   # 丟進佇列，立刻返回；印出佇列位置
pushq status                      # 佇列、正在跑的那件、最近結果
pushq log <id>                    # 某一件的完整輸出
```

## 明確不做

- 不改寫已推上去的歷史、不 force push、不開 PR。
- 不替失敗的件自己改程式（那是空白 session 的事）。
- 不用 `--no-verify` 推；pre-push 對佇列身分放行，但檢查照跑。
- 不碰使用者的主 checkout（`~/Projects/animyria`）。
- 這次不接 animyria 以外的 repo。

## 驗收

前三條在本機假 repo（bare repo 當 origin）上測，不推到 GitHub；真的接上 animyria 之後才由那 5 件實際走一次。

- `pushq enqueue` 兩個互不衝突的假分支 → 依序都進 master，lane 被收掉，中間沒有重跑第二次。
- 一個會衝突的假分支 → 停在「等人修」，有空白 session 就看到修理指示被打進那格；沒有就收到通知。
- 直接 `git push origin HEAD:master` → 被 pre-push 擋下並印出 `pushq enqueue` 的指令。
- 佇列程序被砍掉 → launchd 叫回來，進行到一半的那件從頭重跑，不會推一半。
