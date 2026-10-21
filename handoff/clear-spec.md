# 規格：自動交接改成「同一格自己 /clear 再讀交接單」（2026-10-20）

使用者原話：「幫我把自動交接做成常駐的模式 一個session做完如果要交接下一個 每次都自己自動clear再跑交接單」。
裁示：全面取代「切新格、收舊格」；舊做法只在打不進字（不在 iTerm2）時當退路。

## 做什麼

- `handoff-open <交接單>` 的行為改成（iTerm2 裡）：
  1. 寫標記與開場白到 `~/.claude/state/handoff/`。
  2. 在背景起一支脫離的等待程序，立刻返回；舊 session 照常寫最後回報、結束回合。
  3. 等待程序看 `~/.claude/state/panes/<這格 tty>.json` 變成 `done`（Stop hook 寫的，代表這一回合結束了），
     然後對**同一格**打 `/clear` 送出 → 等清完 → 打開場白送出（W4 起改成一行「照開場資料裡的換手開場白做」，見下節）。
     送出用 `ESC[13u`（[[iterm-write-text-enter]]），走 AppleScript `write text`，不搶焦點。
  4. 清完的 session 拿到開場白（W4 起含交接單全文與現況快照）→ 照「下一步」做；只有重大事件才停（定義照舊在 `blocks` skill）。
- 不用 `--close` 收舊的：同一個 claude 程序、同一格，沒有舊的要收。
- 時機不變：請求做完的最後一推、blocks 每塊做完、context 太滿。這些地方的說明改成「自己 clear 接著做」。
- 退路：不在 iTerm2（`TERM_PROGRAM` 不是 iTerm.app 或沒有 `ITERM_SESSION_ID`）→ 照舊切新格／開新視窗。
- 等太久（10 分鐘還沒 `done`，例如卡在問你問題）→ 放棄，不打字，記在標記檔。

## 開場預塞資料（2026-10-21，blocks.md W4）

目標：清完的 session 開場就拿到交接單全文＋repo 快照，省掉讀檔與查現況那 8～11 次呼叫。

- 開場白檔（`<時間>.prompt.md`）= 指示 ＋ `## 交接單全文` ＋ `## 現況快照`（`recon-check` 在 cwd 的輸出與 exit）。
  `recon-check` 沒跑成（不是 repo、fetch 失敗）就照附輸出，改叫新 session 自己跑 /recon。
- 會打字的模式（clear／tmux／switch）在 `--inject` 等到回合結束、要動手前一刻才重組，快照才是新的。
- clear／tmux 只打得進一行字：`--inject` 打 /clear 前在標記寫 `clearing`；`session-restore` 在 SessionStart(clear)
  找 pid 等於這個 claude、`clearing` 5 分鐘內、還沒有同名 `.preloaded` 的標記，注入開場白全文並寫 `.preloaded`。
  打的那行是「照開場資料裡的換手開場白做（沒有的話讀 <開場白檔>）」，注入失敗也接得住。
- 使用者自己打的 /clear 照舊什麼都不注（沒有新的 `clearing`）。
- 測試：`home/bin/test-handoff-open.sh`（`tests/run.sh` 會跑）。

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
