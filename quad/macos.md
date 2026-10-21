# 四宮格 — macOS Terminal.app

`quad` 的 macOS 實作。Windows 那台沒有這支腳本，見 [windows.md](windows.md)。

已經裝好的東西（2026-08-05 建於這台機器，2026-08-06 更新）：

| 檔案 | 作用 |
|---|---|
| `~/.local/bin/quad` | 腳本本體。`quad` 重排／`--auto` 給掛勾／`--dry` 印座標／`--claude` 開四個 claude |
| `~/.zshrc` 的 PATH 行 + 掛勾 | PATH 加 `~/.local/bin`；掛勾呼叫 `quad --auto --claude` |
| `~/.zshrc.bak-*`、`~/.local/bin/quad.bak-*` | 動之前的備份 |

**行為規則只有一句：畫面上沒有別的 Terminal 視窗時開視窗 → 四宮格，每格一個 claude。**
逃生門 `NOQUAD=1`。手動：`quad`（只重排）／`quad --claude`（開四個 claude）。

## ⚠ 冷啟動路徑到今天為止仍未實測通過

`Cmd+Q` 關掉 Terminal 再開——**這條路從 2026-08-04 建好到現在一次都沒跑過**，
因為測試會殺掉當時正在跑的 Claude session，每次都被延後。所以「開 Terminal
沒有四宮格」這個症狀，**被解除安裝**跟**根本沒生效過**兩個原因分不開。
下次有機會就讓使用者做這個測試，並把結果寫回這裡。

替身測（`window_count` 換 `echo 1`、指令換 `sleep`）2026-08-06 通過：
離開碼 0、只開三個新視窗、觸發視窗落左上、焦點正確、既有視窗未被移動。

## 掛勾的歷史（不要重蹈）

2026-08-05 12:22 掛勾曾經消失，使用者以為是自己沒碰過。真相：**是使用者
把前一個 session 反覆貼給他的「出事退路」`cp ~/.zshrc.bak-... ~/.zshrc`
照著貼進對話框**，而那行的作用等於解除安裝。因為打進的是 Claude 對話框
不是 shell，`~/.zsh_history` 查不到，查了半天才從 session transcript 挖出來。

**教訓：給退路指令時要明講「這行等於解除安裝」，不要只寫「退路」。**

---

## ⚠ 動手之前必讀：兩道閘不能拿掉

「每開一個 terminal 就自動開四個」照字面實作**就是 fork bomb**——被開出來的視窗
也會跑 `.zshrc`，4 → 16 → 64，最後只能 `killall Terminal` 收場。

`quad --auto` 裡有兩道獨立的閘：

1. **視窗數 > 1 就結束。** 遞迴斷在這裡：被開出來的三個視窗跑到這行時，
   視窗數已經是 2、3、4。
2. **時間鎖**（`$TMPDIR/.quad.lock`，5 秒 TTL）。純粹是保險——就算計數在競態下
   判斷錯，最多多開一輪。

**改任何東西時這兩道都要留著。** 如果要改觸發條件（例如改成把分頁也算進去），
改的是閘 1 的計數方式，不是把閘拿掉。

在這台機器上測試時要注意：**使用者的 Terminal 視窗經常在跑 Claude Code
（包含當前這個 session）**。移動視窗安全（不影響裡面跑的 process），但
關視窗會殺掉 session。要驗證「視窗數 = 1」那條路徑而不想關視窗，
用替身測（把 `window_count()` 換成 `echo 1`、把 `osascript` 呼叫換成 `echo`）。

---

## 兩套座標系統——這裡最容易寫錯

| | 原點 | y 方向 |
|---|---|---|
| `NSScreen`（Cocoa） | 主螢幕**左下**角 | 向**上** |
| Terminal 的 AppleScript `bounds` | 主螢幕**左上**角 | 向**下** |

轉換（`H0` = 主螢幕 frame 高度，也就是 `screens[0].frame.size.height`）：

```
left   = vf.origin.x
right  = vf.origin.x + vf.size.width
top    = H0 - (vf.origin.y + vf.size.height)
bottom = H0 - vf.origin.y
```

`screens[0]` 永遠是掛選單列的那個螢幕，也就是 AppleScript 座標的原點所在。
用 `visibleFrame` 不要用 `frame`——前者已經扣掉選單列與 Dock。

**不要把座標寫死。** 每次重問 `NSScreen`，Dock 改成自動隱藏、換螢幕、
接不同外接都會自己跟上。這也是刻意不用 Terminal 原生「視窗群組」的原因——
它記死座標，拔掉外接螢幕會把視窗排到不存在的位置。

---

## 常見的修改

**改格子數**（例如 2×3 或上下二分）——改 `geometry()` 最後那個回傳陣列，
每列是一格的 `left top right bottom`。同時要改主流程裡寫死的 `4`
（補開視窗的迴圈、排版迴圈）。

**換目標螢幕**——改 `geometry()` 裡挑 `target` 的那段。目前是比對
`localizedName` 找內建（`/built-?in|color lcd|liquid retina/i`），找不到退回
`screens[0]`。使用者當初明確選「固定內建主螢幕」而不是「外接優先」。

**改觸發條件**——閘 1 目前數的是**視窗數不是分頁數**（一個視窗開十個分頁仍算 1）。
要把分頁算進去就改 `window_count()` 成加總 `count tabs of every window`。

**每格跑指令**——已經有了，但**只在 `--claude` 裡**，見下一節。原本的 `quad`
仍然開空 shell，這是刻意的：版面工具跟任務啟動器分開，想要四個空 shell 時
不必先改設定。要再加別的任務模式就照 `--claude` 的樣子複製一份。

---

## `--claude`：四格各跑一個 Claude Code（2026-08-06 加）

`quad --claude` 開**四個全新視窗**，每格跑 `cd <當前目錄> || exit; claude`，
排進四宮格，焦點停在左上格。

**它一個既有視窗都不碰**——不重排、不下指令、不關閉。就算螢幕上已經有十個
視窗也一樣。理由：打這道指令的視窗常常自己就在跑 Claude Code，對它
`do script "claude"` 等於把那幾個字打進別人的輸入框送出去。寧可多一個視窗
被蓋在後面（`Cmd+`` 切得回去），也不要污染正在跑的 session。

三個實作細節，改的時候不要弄丟：

1. **用 window id 排版，不用 `window 1..4` 索引。** 新視窗會插到最前面，
   既有視窗的索引整個往後飄；用索引就會排到別人的視窗上。`open_window()`
   在同一個 osascript 裡 `do script` 完立刻取 `id of front window`。
2. **`cd ... || exit` 的 `|| exit` 是保護。** `~/Documents` 有 iCloud 同步的
   EPERM 問題（見 `icloud-documents-eperm`），`cd` 掛掉時繼續跑 claude 會讓它
   在 `$HOME` 啟動、看錯專案。失敗就收掉那一格，另外三格不受影響。
   路徑用 `${(qq)PWD}` 包單引號，空白與中文目錄名都安全。
3. **`--auto --claude` 是掛勾用的組合，跟手動的 `--claude` 走不同分支。**
   手動開四個全新視窗；掛勾只開**三個**，第四格是觸發的那個視窗本身
   （閘二保證那時它是唯一的視窗，而且是剛開機還在跑 `.zshrc` 的空 shell）。
   不這樣做就會變成 5 個視窗：觸發的那個空 shell + 4 個 claude。
   腳本不對觸發視窗下指令（子行程做不到），claude 由 `.zshrc` 掛勾接手跑。

**離開碼的約定**（掛勾靠它決定自己要不要跑 claude，不要改）：
`0` = 有排　`10` = 兩道閘之一擋下來什麼都沒做。用 10 不用 1 是為了跟真正的
錯誤分得開。`.zshrc` 那邊是 `if quad --auto --claude; then claude; fi`。

掛勾用 `claude` 不是 `exec claude`——離開 claude 之後回到正常 shell，
而不是整個視窗消失；claude 沒裝或掛掉也只是回到 shell。

### 沒有人輸入的 claude 視窗不會自己動——不要為它加防護

2026-08-06 我一度以為「quad 自動開的視窗前面沒有人，SessionStart 掛勾會叫它
開場跑 grill-me，模型找不到主題就會從 `MEMORY.md` 挑一個專案自己挖」，於是加了
`QUAD_NO_GRILL=1` 去擋。**前提是錯的，同一天全部拆掉了。**

兩個決定性反證：

1. 開一個**沒帶**任何變數的 claude 視窗晾 2.5 分鐘 → 連 session 檔都沒產生。
   SessionStart 只是塞一段 context，**沒有使用者訊息模型就不會有任何動作**。
2. 那個「失控挖 namecard-archive」的 session（`2840d63e`）翻開一看，
   第一則使用者訊息是 `名片還沒工作完`，後面 12 則 `a`/`c`/`d` 的回答——
   **是使用者本人在那個視窗裡工作**，主題是他給的，不是模型自己挑的。

教訓：看到「自動開的 session 在跑東西」，**先翻 transcript 裡的使用者訊息**
再下結論。`~/.claude/projects/-Users-bruuucemac/<id>.jsonl`，過濾 `type=="user"`
且不是 tool_result 的那些。四個視窗同時開，很可能其中一個就是使用者本人在用。

所以 `quad --claude` 跑的是**裸的 `claude`**，四格都照常被 SessionStart 訪談。

`quad --dry --claude` 會印座標 + 那道指令，不開任何視窗。

**測試技巧**：驗證開窗／抓 id／設 bounds 這套機制時，把指令換成
`echo x; sleep 30` 這種替身，不要真的燒四個 claude session。要測
`--auto` 那條「視窗數 == 1」的路徑，把 `window_count()` 換成 `echo 1`、
把「`id of window 1`」換成一個拋棄式視窗的 id。收尾時**先 `pkill` 掉
裡面的程序再關視窗**——直接關會跳「有程序正在執行」的確認窗，那個
modal 會把後續所有自動化卡死。

**⚠ `close ... saving no` 不可靠**：2026-08-06 實測它回傳 exit 0 但視窗
留著不動，過一段時間才真的消失。**不要用「關完立刻數視窗」來判斷成功**，
會得到錯誤結論。要確認就隔幾秒再數一次。

## 排查

```
quad --dry     # 印算出來的四格座標 + 目前視窗數，完全不碰視窗
quad --dry --claude   # 同上，外加會下的那道指令
osascript -e 'tell application "Terminal" to get {id, bounds} of every window'   # 誰在哪一格
zsh -n ~/.local/bin/quad ; zsh -n ~/.zshrc     # 語法檢查
osascript -e 'tell application "Terminal" to count windows'
```

- **視窗排到畫面外** → 幾乎都是座標系統轉換寫反了。用 `--dry` 對照
  `system_profiler SPDisplaysDataType` 的實際解析度。
- **一直冒視窗** → `killall Terminal`，然後還原備份的 `.zshrc`，再檢查兩道閘。
- **完全沒觸發** → 確認 `TERM_PROGRAM == Apple_Terminal`（掛勾有這個條件，
  VS Code 內建終端機不會觸發）、`NOQUAD` 沒被設、`~/.local/bin` 在 PATH 裡。
- **權限** → `osascript` 對 Terminal 下指令在這台機器上**本來就是通的**，
  不會跳授權窗。看到 EPERM 之類的先看 `icloud-documents-eperm` 那份記憶，
  跟自動化權限無關。

---

## 在新的 mac 上重裝

1. 複製 `~/.local/bin/quad`，`chmod +x`
2. `.zshrc` 加 PATH 與掛勾（先備份 `.zshrc`）
3. `quad --dry` 確認座標合理
4. `quad` 測手動重排
5. 冷啟動測試（`Cmd+Q` 再開）——**這一步會結束正在跑的 Claude session**，
   要讓使用者自己挑時機

## 半透明：只有一條路能「立刻」生效（2026-09-18）

現值：`Basic Clear`／`Ocean`／`Pro` 都是 **80% 不透明**（Blur 各自維持原值）。

不透明度存在設定檔 `BackgroundColor` 那顆封存 NSColor 的 alpha 裡。三條實測結論：

1. **AppleScript 的 `background color` 是三元色**，傳四個值第四項被安靜丟掉——
   設完讀回來還是三項，窗疊窗一點都沒透。**它不會報錯，所以很容易誤判成成功。**
2. **直接改偏好設定只有下次啟動才算數。** 用 `NSKeyedUnarchiver` 解開、
   `colorWithAlphaComponent` 之後重新封存寫回去，`defaults` 讀得到新值，
   但 Terminal 把設定檔**快取在記憶體**，連當下新開的視窗都還是不透明。
3. **要立刻生效只能走它自己的設定面板**：Profiles ▸ 選設定檔 ▸ Text ▸
   `Background` 色塊 ▸ 色票面板的 **Opacity** 滑桿。改下去當場套用到所有
   用該設定檔的視窗，**不用重開、不會動到正在跑的 session**。

用 AX 自動化第 3 條（需 Accessibility 權限，`System Events` 的 `UI elements enabled` 要是 true）：

```applescript
tell application "System Events" to tell process "Terminal"
  -- 先選設定檔，選完務必回頭驗 selected 的那列真的是你要的那個
  set tbl to table 1 of scroll area 1 of group 1 of (first window whose name is "Profiles")
  repeat with r in rows of tbl
    if value of text field 1 of r is "Ocean" then set selected of r to true
  end repeat
  click radio button "Text" of tab group 1 of group 1 of (first window whose name is "Profiles")
  -- 點 static text「Background」後面第一個 color well，色票面板才會出現
  set value of slider 2 of splitter group 1 of (first window whose name is "Colors") to 0.8
end tell
```

⚠️ 色票面板裡有**兩組** Opacity／Blur（第二組是「Inactive Windows」），
`slider 2` 是正確那個；`slider 1` 是色相條。設完用 `text field 1` 讀回「80%」確認，
**最後一定要截圖看**——前兩條路都是「指令成功、畫面沒變」。

## 移除

刪掉 `.zshrc` 裡的掛勾區塊（有註解標示），或直接還原 `~/.zshrc.bak-*`。
`~/.local/bin/quad` 留著不會自己執行。

---

## 每格回報狀態＋收件匣（2026-10-06，借 tuios）

每個 Claude Code session 透過 hook 回報自己的狀態，`quad inbox` 彙整：

| 事件（settings.json 的 hook，async） | 狀態 | 底色 |
|---|---|---|
| `UserPromptSubmit` | `working` 工作中 | 恢復成原本的設定檔 |
| `Notification`（要授權／閒置等你） | `needs_input` 等你回答 | 5× 深橙 #8A4A00／20× 深紫 #4A1A7A |
| `Stop`（這輪做完） | `done` 做完了等你 | 5× 橄欖金 #5A5200／20× 青綠 #0A5A50 |
| `SessionEnd` | 刪掉狀態檔 | — |

- 實作：`home/claude/hooks/pane-state.mjs`；狀態檔在 `~/.claude/state/panes/<tty>.json`。
- **一冷一暖分帳號**（2026-10-06 裁示）：5× 平常是 **Red Sands 磚紅**（暖），20× 是 **Ocean 藍**（冷）；
  只套在 `quad` 開出來跑 claude 的視窗，自己另開的 Terminal 維持預設。
  等你的兩種狀態各一色、留在同一個色系裡（見上表），帳號用 `CLAUDE_CONFIG_DIR` 含不含 `work` 判斷。
  全部選**深色**：這幾個設定檔的字是淺色，亮色底字會看不見。
- 換色用的是分頁的 `background color`，恢復時把**進入等待前記下的設定檔**套回去
  （`set current settings`），所以就算那格不是 Basic Clear／Ocean 也會還原成原樣。
- 上面的表只管 Terminal.app。**iTerm2 用新色盤**（2026-10-16）：帳號只靠分頁標籤色（清單的 `colors.tab`），
  底色兩帳號共用——工作中 `#1E1E1E`、等你回答／做完了 `#8A4A00`；hook 直接對 tty 寫跳脫序列（`tools/iterm.mjs`）。
- AgentQuota 面板的「開一格／開四宮格／混合四格」2026-10-16 起開 iTerm2（一個視窗切 2×2），不再呼叫這支 quad。
- `quad inbox` 列出全部、等你的排前面、等最久的第一；`quad inbox -w` 只列等你的；
  `quad inbox <n>` 把第 n 個分頁帶到最前面。pid 已死的狀態檔會被當殘骸刪掉
  （Ctrl+C 或直接關視窗時 `SessionEnd` 不一定跑得到）。

**驗過的**：模擬 hook 走 工作中→等你回答→做完了→等你回答→工作中，每一步讀回顏色，5× 與 20× 兩組四色都對、最後都還原；`quad --dry` 印出 5× Red Sands、20× Ocean；
`quad inbox` 列表正確。**沒實測的**：`quad inbox <n>` 的跳轉（會把 Terminal 拉到最前面，
測的時候使用者正在用別的視窗）。
