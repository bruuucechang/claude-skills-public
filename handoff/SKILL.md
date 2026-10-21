---
name: handoff
description: 寫交接單：使用者說「/handoff」「寫交接」「換帳號」「交接給下一個 session」，或 status line 的 context 變紅（≥ 80%）時使用。把目標、已裁示的事、查到的事實、下一步、驗收方式、不要碰的東西寫成一份檔案，讓下一個 session 讀完就能接著做，不用重問。要動 repo 之前查現況是另一支：recon。
---

# 寫交接單

對話會被壓縮、session 會因換帳號被收掉，**檔案不會**。交接單的讀者是下一個沒有任何上下文的 session，
所以寫給「完全不知道今天發生什麼的人」：絕對路徑、可執行的指令、使用者的原話。

## 放哪

- 一律放 `$SCRATCHPAD/handoff/<主題-kebab>.md`（session 的 scratchpad 目錄）；blocks 收一塊也寫在這裡。
  不再另寫 `~/.claude/session-logs/<專案>/HANDOFF.md`：自動換手走 /clear，`session-restore` 在 clear 模式不注入它（2026-10-21 統一）；clear 時只注 handoff-open 組的開場白（見下面）。
- 寫完把**絕對路徑**告訴使用者——下一個 session 的開場就是「讀 <路徑>，照下一步做」。

## 格式（照順序，缺的寫「無」不要省略標題）

```markdown
Account: <實際登入的帳號 id>
cwd: <絕對路徑>

# 交接：<一句話主題>

## 目標
使用者原話：「…」。目前在哪個階段（grilling／規格待確認／開工中／驗收中）。

## 使用者已經裁示過的事
1. <題目> → <答案>（原話照抄，不要轉述成更強的說法）

## 已經查到的事實
- <事實>（附怎麼重查的指令）

## 已完成
- <做了什麼>，commit <hash>（哪個 repo、有沒有 push）

## 下一步
1. <具體動作，含檔案路徑與指令>

## 驗收方式
- <可執行的指令與預期結果>

## 不要碰的東西
- <別的 session 未 commit 的改動、deny 清單、不准重構區…>
```

## 寫之前

1. `git status --short` 與 `git log --oneline -5` 每個動過的 repo 跑一次，未 commit 的改動要寫明是誰的。
2. 背景任務還在跑的，寫出 PID／task id 與怎麼看它的輸出；要收掉的先收掉。
3. 開著的瀏覽器分頁、tmux session 先收；收不了的寫進「不要碰」或「下一步」。

## 做完自動交接（常駐：同一格自己 /clear，2026-10-20 裁示）

**時機**：這次請求全部做完、驗收完、最後一次 push 之後（`ship` 第 7 步）；blocks 每做完一塊、context 太滿也一樣。中途的 push 不算。

```bash
handoff-open <交接單絕對路徑> [--cwd <專案目錄>]   # 預設 cwd 是現在的目錄
handoff-open --dry <交接單>                         # 只印出會做什麼（mode: clear／switch／tmux／split）
```

它做的事（`~/.claude/skills/home/bin/handoff-open`，規格在 `clear-spec.md`）：
1. 寫標記與開場白到 `~/.claude/state/handoff/`，起一支脫離的背景程序（`--inject`），立刻返回。
2. 背景程序等這格的 pane-state 變成 `done`（回合結束）且那格連續 3 秒沒輸出，
   先重組開場白（交接單全文＋`recon-check` 快照，打字前一刻才跑），標記寫 `clearing`，
   對**同一格**打 `/clear` → 等 3 秒 → 打「照開場資料裡的換手開場白做」。送出靠 `ESC[13u`，不搶焦點。
3. `/clear` 觸發的 SessionStart 由 `session-restore` 認出這是 handoff-open 打的（同一個 claude、`clearing` 5 分鐘內、
   還沒有 `.preloaded`），把開場白全文注進去（2026-10-21 W4）。清完的 session 一開場就有交接單與現況，
   **不用再讀檔、不用再 /recon，直接照「下一步」做下去**；只有重大事件才停（定義在 `blocks` skill）。
   換帳號（switch）把開場白檔整份當第一句話帶進去，同樣含全文與快照；切新格（split）沒有 `--inject`、舊 session 之後還會動，
   只附全文不附快照，照舊叫新 session 跑 /recon。開場白超過約 9000 字 hook 只注檔名，叫它讀檔。
4. 結果記在標記檔：`clearing`（打 /clear 前寫、開場白打進去就收回，session-restore 認它）／`cleared`／`prompted`／`started`，失敗寫 `gaveUp`（等 10 分鐘回合沒結束就放棄、不打字）、
   送出後沒開工寫 `unconfirmed`；AppleScript 撞到 `-1719 Invalid index`（別格剛好開關）會重試 3 次。背景程序的輸出在同名 `.log`。
5. **失敗會叫**：launchd 的 `handoff-watch`（每分鐘）讀標記檔，`gaveUp`／`unconfirmed`／背景程序死掉沒留結果
   → 推通知（5391/notify＋系統通知，不搶焦點），每個標記只叫一次。

**換帳號（2026-10-21）**：這格登的帳號週額度到門檻（bruce ≥ 90% → peter，或提前開關開著），
`handoff-open` 會自己改走 `mode: switch`：回合結束後打 `/exit`，等舊的 claude 結束，再在同一格的 shell 開
`eval "$(acct pane peter …)"` 讀交接單。判斷在 `home/claude/tools/acct-drain.mjs`（`node acct-drain.mjs` 看現況、
`on`／`off` 開關提前換）；`--to <帳號>` 指定、`--stay` 不換。標記檔多記 `exited`，失敗同樣寫 `gaveUp`。

跑完 `handoff-open` 就寫最後的回報結束回合——回合一結束這格就會被清掉重來。
- 交接單照上面的格式寫，「下一步」要寫清楚，清完的 session 只剩它。
- 最後一句**不要是問句**：ask-with-options 把回合擋回去的話會拖到背景程序（它會等那格靜下來才打字）。
- **退路**：不在 iTerm2（Terminal.app、沒有 `ITERM_SESSION_ID`）打不進字，改成在 iTerm2 開新視窗接手（`mode: split`，
  細節在 `clear-spec.md` 的「退路」）。不是 macOS／沒有 iTerm2 就直接說，請使用者自己開。

## 不要

- 不要只寫結論不寫指令（原則 7：結論要附上怎麼重跑）。
- 不要把「使用者大概想要…」寫成已裁示。沒問過的就列在「下一步」裡要問。
