# design-scan 規則表

`design-scan.js` 是一支可以直接丟進 `page.evaluate` 的掃描檔，在頁面裡跑 61 條
**確定性**（不需要 LLM）的前端設計偵測規則，回傳結構化結果。跟第一節的
「通用重疊偵測器」是同一種用法：渲染出來、用程式量，不靠肉眼。

- 出處：改寫自 [pbakaus/impeccable](https://github.com/pbakaus/impeccable)（Apache-2.0），
  commit `ece38d9904b8a619b3f77cab476eacad09c4fb11`。規則清單來自
  `crates/live/assets/antipatterns.json`，判斷邏輯來自 `crates/core/src/browser/*.rs`、
  `crates/core/src/checks/*.rs` 與 `crates/detect/src/regex_matchers.rs`。
- 規則 id 沿用原作，方便對照原作文件與 `data-impeccable-ignore`。
- 嚴重度對照：原作 `error` → `error`；原作預設 `warning` → `warn`；原作 `advisory` → `info`。
  有幾條會依位置升級（`pulsing-dot` 在首屏或 header／nav 升 `error`；`blinking-cursor` 在 hero 區升 `warn`）。
- 分類：原作 `slop` → **品味類**（AI 生成介面的慣性長相，不一定壞，但一眼看得出來）；
  原作 `quality` → **可讀性／破版類**（實際影響閱讀、可及性或版面）。

## 規則一覽（61 條）

| # | id | 原作類別 | 嚴重度 | 一句話說明 | 分類 |
|---|---|---|---|---|---|
| 1 | `side-tab` | slop | warn | 卡片單邊的粗彩色邊框（含偽元素、條紋子元素、inset 陰影畫的），最典型的 AI 生成介面特徵 | 品味類 |
| 2 | `border-accent-on-rounded` | slop | warn | 圓角卡片的上／下緣加粗強調邊框，和圓角互相打架 | 品味類 |
| 3 | `overused-font` | slop | warn | 主要字型是 Inter、Roboto、Geist、Space Grotesk 這類被用爛的字 | 品味類 |
| 4 | `flat-type-hierarchy` | slop | warn | 標題與內文字級每一級都差不到 1.25 倍，層級是平的 | 品味類 |
| 5 | `gradient-text` | slop | warn | 漸層文字（background-clip: text），裝飾大於意義 | 品味類 |
| 6 | `ai-color-palette` | slop | warn | 紫／藍紫漸層、紫色標題；青色＋紫色霓虹字壓深底（兩種招牌色同時出現才算） | 品味類 |
| 7 | `cream-palette` | slop | warn | 頁面底色是反射性選的奶油／米色 | 品味類 |
| 8 | `nested-cards` | slop | warn | 卡片裡又套卡片，層次過深 | 品味類 |
| 9 | `monotonous-spacing` | slop | warn | 整頁幾乎只用同一個間距值，沒有節奏 | 品味類 |
| 10 | `bounce-easing` | slop | warn | 彈跳／彈性緩動（bounce、elastic、超出範圍的 cubic-bezier） | 品味類 |
| 11 | `pulsing-dot` | slop | warn | 裝飾性的脈動小圓點假裝「即時」；在首屏或 header／nav 升為 error | 品味類 |
| 12 | `blinking-cursor` | slop | info | 首屏裝飾用的閃爍游標，假裝在打字；在 hero 區升為 warn | 品味類 |
| 13 | `shape-assembled-illustration` | slop | info | 大型行內 SVG 用一堆基本圖形拼成的插圖，讀起來像佔位圖 | 品味類 |
| 14 | `organic-clip-path` | quality | warn | 用多頂點 polygon 或曲線 path() 的 clip-path 模擬撕邊／有機輪廓 | 可讀性／破版類 |
| 15 | `buried-raster` | quality | warn | 點陣圖被幾乎不透明的漸層蓋住，或 opacity 低到看不見 | 可讀性／破版類 |
| 16 | `dark-glow` | slop | warn | 彩色光暈陰影：零位移的彩色 box／text-shadow，或深色底上的彩色模糊陰影 | 品味類 |
| 17 | `radial-halo` | slop | warn | 深色頁面上飽和的 radial-gradient 光暈背景 | 品味類 |
| 18 | `radial-spotlight-glow` | slop | warn | 區塊後面低透明度的強調色 radial-gradient「聚光燈」 | 品味類 |
| 19 | `marquee` | slop | warn | 持續自動水平捲動的跑馬燈 | 品味類 |
| 20 | `icon-tile-stack` | slop | warn | 標題上方疊一個圓角方塊圖示，萬用 AI 功能卡模板 | 品味類 |
| 21 | `italic-serif-display` | slop | warn | 超大義大利斜體襯線字當主視覺標題 | 品味類 |
| 22 | `hero-eyebrow-chip` | slop | warn | 超大 h1 上方的小號大寫加寬眉標／膠囊標籤 | 品味類 |
| 23 | `kicker-above-heading` | slop | warn | 標題正上方獨立一行的小號大寫加寬標籤 | 品味類 |
| 24 | `numbered-section-labels` | slop | info | 每節標題旁反覆出現的小號編號（01、02…） | 品味類 |
| 25 | `em-dash-overuse` | slop | info | 內文破折號過密（≥8 個且約每 500 字一個） | 品味類 |
| 26 | `marketing-buzzword` | slop | warn | streamline／empower／world-class／cutting-edge 這類 SaaS 套話 | 品味類 |
| 27 | `aphoristic-cadence` | slop | warn | 「X. No Y.」「Not a feature. A platform.」這類格言句型出現三次以上 | 品味類 |
| 28 | `oversized-h1` | slop | warn | 整句長的 h1 用展示級字級，霸佔首屏 | 品味類 |
| 29 | `extreme-negative-tracking` | slop | warn | 字距收到 ≤ -0.05em，字形擠壞 | 品味類 |
| 30 | `broken-image` | quality | warn | <img> 沒有 src、src 是空的或佔位值，或實際載入失敗 | 可讀性／破版類 |
| 31 | `script-error` | quality | error | 頁面載入時有未攔截的腳本錯誤（需事先安裝錯誤收集器） | 可讀性／破版類 |
| 32 | `content-hidden-at-rest` | quality | error | 大量文字停在 opacity 0／visibility hidden，進場動畫失敗的特徵 | 可讀性／破版類 |
| 33 | `edge-flush-cards` | quality | warn | 水平捲動容器裡的卡片在靜止時貼著一側邊緣，圓角被切掉 | 可讀性／破版類 |
| 34 | `text-occlusion` | quality | warn | 文字被不透明元素或另一段文字蓋住（固定／黏性層不算） | 可讀性／破版類 |
| 35 | `first-viewport-column-overflow` | quality | warn | 首屏多欄區塊有一欄遠超過摺線、另一欄很短 | 可讀性／破版類 |
| 36 | `gray-on-color` | quality | warn | 灰字壓在彩色底上，看起來髒 | 可讀性／破版類 |
| 37 | `low-contrast` | quality | warn | 文字對比不到 WCAG AA（內文 4.5:1、大字 3:1） | 可讀性／破版類 |
| 38 | `layout-transition` | quality | warn | 轉場動到 width／height／padding／margin，會造成版面抖動 | 可讀性／破版類 |
| 39 | `line-length` | quality | warn | 實際渲染出來有兩行以上超過約 80 字 | 可讀性／破版類 |
| 40 | `cramped-padding` | quality | warn | 有邊框／底色的容器裡，文字離邊太近 | 可讀性／破版類 |
| 41 | `body-text-viewport-edge` | quality | warn | 內文段落直接貼到視窗左右邊緣 | 可讀性／破版類 |
| 42 | `tight-leading` | quality | warn | 多行內文行高低於 1.3 倍字級 | 可讀性／破版類 |
| 43 | `skipped-heading` | quality | warn | 標題層級跳級（h1 之後直接 h3） | 可讀性／破版類 |
| 44 | `heading-rhythm` | quality | warn | 標題離上一段比離自己的內容還近（全頁至少兩處） | 可讀性／破版類 |
| 45 | `justified-text` | quality | warn | 左右對齊卻沒開斷字，字距忽大忽小 | 可讀性／破版類 |
| 46 | `tiny-text` | quality | warn | 內文字級小於 12px | 可讀性／破版類 |
| 47 | `undersized-ui-text` | quality | warn | 連結、按鈕、標籤等功能性文字小於 11px（法律小字 10px） | 可讀性／破版類 |
| 48 | `all-caps-body` | quality | warn | 長段內文全大寫 | 可讀性／破版類 |
| 49 | `wide-tracking` | quality | warn | 內文字距大於 0.05em | 可讀性／破版類 |
| 50 | `text-overflow` | quality | warn | 內容比容器寬、溢出去或撐出橫向捲軸 | 可讀性／破版類 |
| 51 | `repeated-container-text` | quality | warn | 同一張卡片裡同一段字在三個不同位置重複出現 | 可讀性／破版類 |
| 52 | `clipped-overflow-container` | quality | warn | overflow:hidden 容器把需要溢出的定位子元素（選單、提示）裁掉 | 可讀性／破版類 |
| 53 | `design-system-font` | quality | warn | 用了 DESIGN.md 沒宣告的字型（需提供設計系統選項） | 可讀性／破版類 |
| 54 | `design-system-color` | quality | info | 用了 DESIGN.md 色盤以外的顏色（需提供設計系統選項） | 可讀性／破版類 |
| 55 | `design-system-radius` | quality | info | 圓角不在 DESIGN.md 級距裡（需提供設計系統選項） | 可讀性／破版類 |
| 56 | `design-system-font-size` | quality | info | 字級不在 DESIGN.md 字級表裡（需提供設計系統選項） | 可讀性／破版類 |
| 57 | `gpt-thin-border-wide-shadow` | slop | info | 髮絲細框同時配大範圍柔和陰影 | 品味類 |
| 58 | `repeating-stripes-gradient` | slop | info | 用 repeating-gradient 畫裝飾條紋 | 品味類 |
| 59 | `codex-grid-background` | slop | info | 用細線漸層鋪成的裝飾格線背景 | 品味類 |
| 60 | `theater-slop-phrase` | slop | info | 把東西貶成「X theater」的生成文案口頭禪 | 品味類 |
| 61 | `image-hover-transform` | slop | info | 滑過圖片就放大或旋轉 | 品味類 |

## 怎麼跑

dev-browser 的腳本跑在沙箱裡，只能讀 `~/.dev-browser/tmp/`，所以先把掃描檔複製過去：

```bash
cp ~/.claude/skills/inspect-ui/design-scan.js ~/.dev-browser/tmp/design-scan.js

dev-browser --browser design-scan --headless --timeout 60 <<'EOF2'
const page = await browser.newPage();
await page.setViewportSize({ width: 1280, height: 900 });

// script-error 要在載入前就開始收；dev-browser 的 addInitScript 目前會失敗，用 pageerror 事件
const errs = [];
page.on('pageerror', e => errs.push(String(e && e.message || e)));

await page.goto('http://127.0.0.1:5173/', { waitUntil: 'load' });
await page.evaluate('window.__designScanErrors = ' + JSON.stringify(errs));

// 選項（可省略）：要跑 design-system-* 四條就給 DESIGN.md 的字型／色盤／圓角／字級
// await page.evaluate('window.__DESIGN_SCAN_OPTIONS__ = ' + JSON.stringify({
//   設計系統: { 字型: ['Charter'], 顏色: ['#111827', '#ffffff'], 圓角: [8, 12], 字級: [14, 16, 24] }
// }));

const 結果 = await page.evaluate(await readFile('design-scan.js'));
console.log('規則', 結果.規則數, '命中', 結果.命中.length, '略過', JSON.stringify(結果.略過), '錯誤', JSON.stringify(結果.錯誤));
for (const h of 結果.命中) console.log(h.嚴重度, h.id, '|', h.選擇器或節點描述, '|', h.細節);
EOF2
```

回傳格式：

```js
{
  規則數: 61,
  命中: [{ id, 嚴重度: 'error'|'warn'|'info', 說明, 選擇器或節點描述, 細節 }],  // 依嚴重度排序
  略過: [{ id, 原因 }],   // 沒給選項而沒跑的規則（script-error、design-system-*）
  錯誤: [{ id, 訊息 }],   // 規則本身拋例外（正常應該是空的）
  耗時毫秒
}
```

選項放在 `window.__DESIGN_SCAN_OPTIONS__`：

| 選項 | 作用 |
|---|---|
| `行長上限` | `line-length` 的字數上限，預設 80 |
| `設計系統` | `{ 字型, 顏色, 圓角, 字級, 允許膠囊圓角, 宣告的選擇器 }`；沒給就略過 design-system-* 四條 |
| `錯誤收集器` | `script-error` 讀的全域陣列名稱，預設 `__designScanErrors` |
| `只列規則` | `true` 時只回傳規則清單，不掃描（本表就是這樣產生的） |

局部停用：在元素上加 `data-impeccable-ignore="side-tab low-contrast"`（或 `data-design-scan-ignore`），
整棵子樹不報那幾條；空值或 `*` 代表全部。

### 注意

- **掃的是當下這一個視窗寬度**。斷點要掃就照 SKILL.md 第三節，用 iframe 逐寬度注入，或換 `setViewportSize` 再跑。
- **首屏以外的遮擋不會報**：`text-occlusion` 用 `elementFromPoint` 取樣，只看得到視窗內。要看下面的區塊先捲過去再跑。
- 進場動畫（scroll reveal）沒觸發的內容會被 `content-hidden-at-rest` 抓到；原作會先從頭捲到尾再量，這裡不自動捲，
  需要的話先在腳本裡捲一輪再注入。

## 與原作的差異

原作是 Rust（編成 WASM）＋ DOM 探針，有些規則是掃原始碼或 CSS 文字。這裡全部改成在頁面上看**計算後樣式與幾何**，
所以有以下取捨（驗收時對照原作 89 個 fixture 的 golden 輸出逐條核對過，見最後一節）：

1. **依賴原始碼／CSS 文字的規則，改看計算後樣式**：`side-tab` 的 inset 陰影條紋、`organic-clip-path`、
   `buried-raster`、`radial-halo`、`repeating-stripes-gradient`、`codex-grid-background`、`pulsing-dot`、
   `marquee` 原作掃 CSS 文字，這裡改看每個元素（含 `::before`／`::after`）的計算後樣式與 `@keyframes`。
   好處是死 CSS、未生效的 `@media`／`@supports`／container query 不會誤報（原作瀏覽器模式也是這個行為）。
   `monotonous-spacing`、`image-hover-transform` 與 `ai-color-palette` 的「樣式表招牌紫」仍然讀樣式表文字
   （`document.styleSheets`），跨網域樣式表讀不到就略過。
2. **`script-error`**：原作由 CDP 收 page error。`page.evaluate` 看不到過去的錯誤，所以要呼叫端先收好放進
   `window.__designScanErrors`（範例見上）；沒放就列在「略過」。
3. **design-system-* 四條**：原作讀專案的 DESIGN.md。這裡不讀檔，要呼叫端把字型／色盤／圓角／字級用選項傳進來；
   沒給就列在「略過」。原作瀏覽器端沒有實作 `design-system-font-size`，這裡依它的說明補上（字級不在表上就報）。
4. **低對比的截圖補救沒有移植**：原作對「文字疊在圖片上」會截圖取樣像素。這裡做不到，改成保守：
   文字框底下有重疊一半以上的 `<img>`／影片／畫布／`url()` 背景時，判定底色算不出來、**不報**
   （寧可漏報也不要「白字在白底」那種假陽性）。代價是 impeccable 的 `image-backed-contrast.html`
   裡「白字壓淺色圖」那一筆抓不到。
5. **`marketing-buzzword`／`aphoristic-cadence`／`em-dash-overuse`／`theater-slop-phrase`** 用 `body.innerText`，
   只算畫得出來的字（原作 CLI 是剝 HTML 標籤，連隱藏文字也算）。
6. **多加的誤報防線**（原作沒有、這裡加的）：
   - 逐元素規則一律先用 `checkVisibility()` 濾掉祖先鏈上 `display:none`／`visibility:hidden`／`opacity:0` 的元素。
   - `skipped-heading` 只看畫得出來的標題。
   - `body-text-viewport-edge` 祖先是 fixed／absolute 也排除；`heading-rhythm` 跳過黏在 fixed／sticky 層裡的標題。
   - `clipped-overflow-container` 不算沒畫出來的定位子元素。
   - `cramped-padding`：文字已經衝出框外（內距為負）時交給 `text-overflow`，不重複報。
   - `layout-transition` 要真的有轉場時間才算。
7. **多抓的東西**：`broken-image` 除了原作的「沒 src／空 src／`#`」，也報 DOM 才看得到的「實際載入失敗」
   （`complete && naturalWidth === 0`，`loading="lazy"` 除外）。
8. `overused-font` 跟原作瀏覽器模式一樣要至少 20 個有字的元素才判斷；原作 CLI（靜態模式）會直接看 CSS 宣告，
   所以小頁面上 CLI 會報、這裡不會。

## 驗收紀錄（2026-10-06）

怎麼重跑：

```bash
SP=<放驗收腳本的暫存目錄>   # 當時是作者那個 session 的 scratchpad；scan-fixture.js 等腳本沒進 repo，要自己重寫
cd $SP && python3 -m http.server <埠> --bind 127.0.0.1 &   # 記下 pid，驗完 kill 那個 pid
cp ~/.claude/skills/inspect-ui/design-scan.js ~/.dev-browser/tmp/
dev-browser --browser design-scan --headless --timeout 60 run $SP/scan-fixture.js    # 自製測試頁
dev-browser --browser design-scan --headless --timeout 400 run $SP/scan-golden.js    # impeccable 的 70 個 HTML fixture
python3 $SP/compare.py                                                                # 跟 golden 逐條比
```

- 自製測試頁 `design-fixture.html`：反例區命中 22 種規則（script-error、side-tab、gradient-text、ai-color-palette、
  nested-cards、bounce-easing、pulsing-dot、dark-glow、icon-tile-stack、kicker-above-heading、marketing-buzzword、
  broken-image、gray-on-color、low-contrast、layout-transition、tight-leading、skipped-heading、heading-rhythm、
  justified-text、tiny-text、all-caps-body、text-overflow）；**乾淨區塊 0 筆**；`display:none` 與
  `visibility:hidden` 的陷阱區塊 0 筆；固定頁首底下的文字沒有被報成 `text-occlusion`。
- impeccable fixture：70 個 HTML 全部跑完、0 個規則例外。和 golden（靜態 CLI 模式）比，
  44 條規則在對應 fixture 上一致命中；差異都歸在上面「與原作的差異」或「靜態模式量不到版面」兩類。
