---
paths:
  - "**/*.{tsx,jsx,ts,js,mjs,vue,svelte}"
  - "**/*.{html,css,scss}"
---

# 瀏覽器與前端驗收（動到前端檔案時才載入）

<!--
硬規則（不准 resize、不准把分頁愈開愈多、開了就收掉）留在 CLAUDE.md，
因為那些在「沒有讀任何前端檔就決定開瀏覽器」的情況下也必須成立。
這裡放的是**做法與根因**——只有真的在動前端時才需要，所以用 paths: 限定載入。
-->

## 根因（2026-09-02 實測確認，不要重新推理）

`tabs_context_mcp` 建立分頁群組時**不會另開視窗** —— 它拿的是
`chrome.windows.getLastFocused` 的既有視窗，也就是使用者自己那個開著
twitch／YouTube 的視窗。所以 MCP 分頁跟他的分頁**同住一個視窗**。

`resize_window` 走 `chrome.windows.update({width, height})`，改的是**整個視窗**，
所以 `resize_window(414, 900)` 會把他正在看的分頁一起壓成手機寬。歷史紀錄裡有
10 次這種呼叫，其中一次縮完沒還原，留下一個 808 寬的視窗。

## 要看手機版版面，用 iframe，不要動視窗

`@media` 看的是 iframe 自己的寬度，一次掃完所有斷點，完全不碰任何視窗。
完整寫法在 `inspect-ui` skill 第三節。2026-09-02 實測：斷點在 641→640 精準翻轉，
且分頁全程 `document.hidden: true` 量測照樣準確
（`getBoundingClientRect` 不受背景分頁影響）。

## 開瀏覽器之前先走這四步

1. **只是要把畫面叫出來給人看** → `proj open <name>`（要指定其他埠就加 label）。
   走 AppleScript 找同源分頁**重新載入**，完全不碰 MCP：不建分頁、不建群組、
   不留殘骸。代價是 Claude 讀不到頁面內容 —— 但「給人看」本來就不需要。
2. **後端／API／資料庫** → `curl`、`psql`、CLI。永遠不要為了驗後端開瀏覽器。
3. **要讀 DOM、要量幾何、要截圖** → **`dev-browser --headless run <script>`**。
   自帶 Chromium，**不開視窗、不碰 Chrome、不留任何東西給使用者清**，
   而且沒有「分頁在背景 rAF 就停」那個限制（見 [[dev-browser-no-webgl]]，
   唯一的缺口是沒有 WebGL）。**驗收前端的預設答案是這一條，不是第 4 條。**
4. **只有非用使用者那個 Chrome 不可的時候**（要他的登入狀態、擴充功能、WebGL）
   才開 MCP 分頁：`navigate` 且**不要帶 `tabId`**，它會重用群組裡的第一個分頁，
   只有群組空的時候才建 —— 這就是 0→1 而不會 1→2。

## 分頁群組會累積成書籤列上一排

`tabs_context_mcp` 每個 session 建一個群組，**session 結束後群組不會消失**，
Chrome 存起來掛在書籤列上。**`tabs_close_mcp` 關分頁不會刪群組**，
只有手動右鍵 chip →「刪除群組」才會。**群組開著的時候不要刪**——會連分頁一起關；
要清用右鍵的「Unpin Group from Bookmarks Bar」。

projctl 的擴充會把群組**就地改名**成實際在做的專案（只改標題與顏色、不搬分頁），
細節在 `~/Projects/projctl/chrome-ext/CLAUDE.md`。**改名不會讓數量變少。**

<!-- 鑑識細節，只給人看，不花 context：

✗ 不要再試「開一個專用視窗把分頁引導過去」——2026-09-02 花四次嘗試證明不通：
  `make new window` / 加 `set index to 1` / 加 `activate` /
  `open -a "Google Chrome"` 之後再開視窗 —— 分頁全都仍落在使用者原本的視窗。
  `chrome.windows.getLastFocused` 只認真實的焦點事件，AppleScript 造出來的視窗
  排序與 activate 它一律不理（同 [[chrome-mcp-hidden-tab]]）。而且沒有任何 MCP
  工具能把既有分頁搬到別的視窗。iframe 法更好又零風險，這方向沒有補救價值。

· Claude 擴充功能自始至終只有一個（fcoeoabgfenejglbffodgkkbkcdhcgfn），
  磁碟上留的舊版目錄不會產生圖示。
· 2026-09-07 當時：Default/Sync Data/LevelDB 有 15 筆 saved_tab_group-dt-*，
  書籤列顯示 6 個 chip；Bookmarks 檔裡一個都沒有（查書籤 JSON 會查不到）。
· Chrome 開著時直接改 LevelDB 會被覆寫，而且會同步回帳號，不要碰。
· UI 自動化清理時：確認對話框用 Enter 送出，pixel 點按鈕實測連兩次都沒中。
· 「一個專案只有一個群組」做不到：要合併就得搬分頁，一搬對方群組就空掉被刪、
  工具再開一個，那是有前科的無限迴圈。
· 診斷時 Chrome 常被四宮格終端機蓋住，screencapture -l <CGWindowID> 只拿得到
  網頁內容拿不到瀏覽器 chrome，要從全螢幕截圖量座標。取 CGWindowID 用
  osascript -l JavaScript 的 ObjC.castRefToObject（直接 deepUnwrap 會失敗）。
-->

前端驗收的完整做法見 `inspect-ui` skill 與 [[verify-with-curl]]、[[fully-inspect-before-done]]。

## 事故紀錄（從 CLAUDE.md 搬來，2026-10-12）

- 使用者原話：「我可以接受從 0→1，但不要 1→2、2→3」。
- 2026-09-07 第三次被抓到沒收分頁：05:11 開了一個 MCP 分頁，05:31 起改用 dev-browser，
  那個分頁從 05:31 起就是純死重，一路留到使用者來問。換工具的那一刻就要收。
