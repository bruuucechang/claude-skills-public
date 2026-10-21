# 規格：自動交接改成「同一格自己 /clear 再讀交接單」（2026-10-20）

使用者原話：「幫我把自動交接做成常駐的模式 一個session做完如果要交接下一個 每次都自己自動clear再跑交接單」。
裁示：全面取代「切新格、收舊格」；舊做法只在打不進字（不在 iTerm2）時當退路。

## 做什麼

- `handoff-open <交接單>` 的行為改成（iTerm2 裡）：
  1. 寫標記與開場白到 `~/.claude/state/handoff/`。
  2. 在背景起一支脫離的等待程序，立刻返回；舊 session 照常寫最後回報、結束回合。
  3. 等待程序看 `~/.claude/state/panes/<這格 tty>.json` 變成 `done`（Stop hook 寫的，代表這一回合結束了），
     然後對**同一格**打 `/clear` 送出 → 等清完 → 打「讀 <開場白檔> 照做」送出。
     送出用 `ESC[13u`（[[iterm-write-text-enter]]），走 AppleScript `write text`，不搶焦點。
  4. 清完的 session 讀交接單 → /recon → 照「下一步」做；只有重大事件才停（定義照舊在 `blocks` skill）。
- 不用 `--close` 收舊的：同一個 claude 程序、同一格，沒有舊的要收。
- 時機不變：請求做完的最後一推、blocks 每塊做完、context 太滿。這些地方的說明改成「自己 clear 接著做」。
- 退路：不在 iTerm2（`TERM_PROGRAM` 不是 iTerm.app 或沒有 `ITERM_SESSION_ID`）→ 照舊切新格／開新視窗。
- 等太久（10 分鐘還沒 `done`，例如卡在問你問題）→ 放棄，不打字，記在標記檔。

## 不做

- 不改交接單格式、不改重大事件的定義。
- 不碰 `acct`、四宮格、pane-state 的配色。

## 驗收

- `handoff-open --dry <交接單>` 印出 mode=clear。
- 在一格測試用 claude 裡實跑一次：回合結束後那格自己出現 `/clear`、接著出現開場白並開始讀交接單；
  標記檔記下 `cleared`／`prompted` 時間。

## 退路：切新格、收舊格（2026-10-16 版，只在打不進字時用）

原本寫在 `SKILL.md` 的「做完自動交接（iTerm2，2026-10-16 裁示）」，2026-10-21 移來這裡（`SKILL.md` 只留同一格 /clear）。
`handoff-open --dry` 印出 `mode: split` 時走這條：

1. 在 iTerm2 開新視窗（舊的不在 iTerm2，切不了格），不 activate；同一個 `CLAUDE_CONFIG_DIR`、同一個 cwd，經 `acct pane` 上帳號標籤色。
2. 新的 claude 開場就被叫去讀交接單 → 跑 `handoff-open --close <標記>` 收掉舊的
   （結束舊 claude；舊的在 iTerm2 就關那格，在 Terminal.app 視窗留著）→ /recon → 直接照「下一步」做下去。
3. cwd 是 `~`（或任何沒信任過的目錄）時，新格會先停在 Claude Code 的「信任這個資料夾？」，要使用者按；專案目錄不會。
