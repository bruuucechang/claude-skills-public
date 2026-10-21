---
name: inspect-ui
description: 前端改完、宣告完成之前跑。把頁面真的渲染出來，用程式掃重疊破圖、逼出每一種畫面狀態、掃各種視窗寬度、看 console 錯誤。單元測試綠燈跟畫面沒壞是兩件事——這個 skill 是用跑的不是用看的。
---

# 前端驗收

**規則：改完前端、在說「完成」之前，把頁面真的渲染出來，而且用程式掃過，不要用肉眼。**

## 為什麼有這個 skill

2026-09-02 的實際教訓。控制台前端改完，邏輯用 `node:vm` 載入真正的前端程式碼測過
65 個測試全綠，交付時誠實寫了「畫面我沒實際看過」——使用者下一句就是回報破圖。

兩個 bug 都只有渲染出來才看得到，而且兩個都不是邏輯錯：

- `querySelector('.up')` 抓到的是**狀態點**（它的 class 是 `dot up`），於是每 4 秒
  把時間字串寫進一顆 7px 的圓點裡，文字漏出來壓在專案名稱上。
- `pace()` 在 `document.hidden` 時直接 return，背景開啟的分頁**整頁空白**。

單元測試永遠測不到第一個——它不會去問「這個選擇器實際上會選到誰」。

## 動手前

分頁與視窗的規則**寫在 `~/.claude/CLAUDE.md`**（每個 session 都會載入），
包含根因、被 deny 的兩個工具、以及「開專用視窗把分頁引導過去」為什麼不通。
不要在這裡重複一份，會各自漂移。

只有一條會影響下面的做法，所以在這裡再講一次：
**響應式一律用第三節的 iframe，不准動視窗大小。**

## 一、通用重疊偵測器（最重要的一項）

> **正本是同目錄的 `overlap.js`**（2026-10-06 抽成檔案給第六節的重播器注入）。
> 改偵測器時改那個檔，再把這裡的程式碼同步過來。

不要靠肉眼掃版面。抓所有「含文字的葉節點」，兩兩比 `getBoundingClientRect()` 的交集：

```js
// **要往上走祖先鏈，不能只看元素自己。**（2026-09-07 實測）
// `.tab` 自己是 static，但它住在 `position: fixed` 的分頁列裡（不透明、
// z-index 40），內容從它底下捲過去是對的。只看自己的話，每一個浮動容器
// 裡的每一段文字都會被報成重疊——trip-atlas 那次一口氣噴出五筆假的。
function floating(el, win) {
  let p = el;
  while (p && p !== win.document.documentElement) {
    const cs = win.getComputedStyle(p);
    if (cs.position === 'absolute' || cs.position === 'fixed') return true;
    p = p.parentElement;
  }
  return false;
}

// **被 overflow 裁掉的部分要夾掉。**（2026-09-07 實測）
// `getBoundingClientRect()` 對「捲出容器外、根本畫不出來」的內容照樣回傳它的
// 幾何位置。於是一個 `overflow:auto` 的容器裡捲出去的東西，會跟容器外面的
// 東西報成重疊——全是假的。作業圖那次一口氣噴出 14 筆，兩個來源：
// `.viewport{max-height:46vh}`（圖在裡面垂直捲）與圖本身水平捲了 48px。
// 夾完之後 12 個斷點全部乾淨。
function clipRect(el, win) {
  const r = el.getBoundingClientRect();
  let l = r.left, t = r.top, ri = r.right, b = r.bottom;
  for (let p = el.parentElement; p && p !== win.document.documentElement; p = p.parentElement) {
    const cs = win.getComputedStyle(p);
    if (cs.overflowX === 'visible' && cs.overflowY === 'visible') continue;
    const pr = p.getBoundingClientRect();
    l = Math.max(l, pr.left); t = Math.max(t, pr.top);
    ri = Math.min(ri, pr.right); b = Math.min(b, pr.bottom);
  }
  return ri - l > 0.5 && b - t > 0.5 ? { left: l, top: t, right: ri, bottom: b } : null;
}

function leaves(root, win = window) {
  const out = [];
  for (const el of root.querySelectorAll('*')) {
    const hasText = [...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim());
    if (!hasText) continue;
    const cs = win.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    // 絕對／固定定位的東西本來就會疊在別人上面（浮動訊息、抽屜），不算破圖
    if (floating(el, win)) continue;
    const clip = clipRect(el, win);          // ← 捲出容器外的部分不算數
    if (!clip) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) continue;
    out.push({ el, r, clip, tag: (el.className || el.tagName) + '«' + el.textContent.trim().slice(0, 18) + '»' });
  }
  return out;
}

// **行內元素要比逐行框，不能比聯集框。**（2026-09-07 實測）
// 一個換行的 inline 元素，`getBoundingClientRect()` 回的是所有行框的**聯集**，
// 橫跨整個容器寬度。於是同一段文字裡相鄰的兩個 `<span>` 幾乎一定「重疊」
// ——而**窄視窗正是最會換行、也最需要這支偵測器的時候**。
//
// trip-atlas 實測 480px：`.tag「班機」` [86,523,41×16] 與旁邊的 `.muted`，
// 聯集框交疊 41×16 看起來像破圖，但 `.muted` 的逐行框是
// [371,522] [390,522] [86,544]——同一行在右邊、下一行才回到左邊，
// 跟 tag 完全沒有交集。改用 getClientRects() 之後 560/480/400/360 全部乾淨。
function boxes(L) {                          // L 是 leaves() 吐出來的那個物件
  const rs = [...L.el.getClientRects()];
  const src = rs.length ? rs : [L.el.getBoundingClientRect()];
  const out = [];
  for (const r of src) {                     // 每一個行框也要被容器夾一次
    const l = Math.max(r.left, L.clip.left), t = Math.max(r.top, L.clip.top);
    const ri = Math.min(r.right, L.clip.right), b = Math.min(r.bottom, L.clip.bottom);
    if (ri - l > 0.5 && b - t > 0.5) out.push({ left: l, top: t, right: ri, bottom: b });
  }
  return out;
}

function overlaps(root, win = window) {
  const L = leaves(root, win), bad = [];
  for (let i = 0; i < L.length; i++) for (let j = i + 1; j < L.length; j++) {
    const a = L[i], b = L[j];
    if (a.el.contains(b.el) || b.el.contains(a.el)) continue;   // 父子當然會疊
    let hit = null;
    for (const ra of boxes(a)) for (const rb of boxes(b)) {
      const ox = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const oy = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (ox > 1 && oy > 1) { hit = `${Math.round(ox)}×${Math.round(oy)}px`; break; }
    }
    if (hit) bad.push(`重疊 ${a.tag} ⨯ ${b.tag} (${hit})`);
  }
  return [...new Set(bad)];
}
```

**這三個修正都是 2026-09-07 實測出來的（前兩個在 trip-atlas、第三個在作業圖），
而且三個都是假陽性。** 假陽性比漏報更傷：它讓人看到一長串「重疊」然後開始忽略
整份輸出，而真的那一個就混在裡面。改之前那一版在 trip-atlas 同一頁噴出 5 筆祖先
假陽性與 3 筆行內假陽性，真正的破圖（選單開到分頁列底下）反而是靠另外量
「被蓋住幾 px」才抓到的；在作業圖則是 14 筆裁切假陽性，而那一頁其實完全乾淨。

> **三個修正的共通點：`getBoundingClientRect()` 回的是幾何位置，不是「看得到什麼」。**
> 疊在別人上面是設計（floating）、聯集框不是實際佔的位置（getClientRects）、
> 捲出容器外根本沒畫（clipRect）——每一次都是拿幾何當成視覺。
> 下次再遇到一長串重疊，先問這一句。

順便斷言幾個不變量，它們抓到的東西跟重疊一樣多：

```js
// 圖示類元素被寫進文字 —— 就是那次破圖的形狀
for (const d of document.querySelectorAll('.dot, .icon, .badge'))
  if (d.textContent.trim()) bad.push(`圖示元素裡有文字「${d.textContent.trim()}」`);

// 內容衝出所屬容器
for (const row of document.querySelectorAll('.row, .card, .item')) {
  const rr = row.getBoundingClientRect();
  for (const el of row.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    if (r.width && (r.right > rr.right + 1 || r.left < rr.left - 1)) { bad.push('溢出容器 ' + el.className); break; }
  }
}

// 整頁橫向捲動
if (document.documentElement.scrollWidth > innerWidth + 1) bad.push('整頁橫向溢出');
```

## 二、每一種畫面狀態都要逼出來

**只看健康狀態等於沒驗。** 把假資料塞進頁面的 state 再呼叫真正的 render 函式——
不要另外寫一個模擬的渲染路徑，那樣測到的不是實際跑的程式碼。

```js
clearInterval(timer);                       // 先停掉輪詢，不然假資料會被蓋掉
const base = structuredClone(state);
const run = (name, mutate) => {
  const s = structuredClone(base); mutate(s);
  state = s; paint();                        // ← 真正的 render 函式
  console.log(name, overlaps(document.body));
};
run('錯誤', s => { s.findings = [{ level:'bad', /* … */ }]; });
run('警告', s => { /* … */ });
run('空清單', s => { s.items = []; });
run('超長字串', s => { s.items[0].name = 'x'.repeat(120); });
state = base; paint();                       // 收尾還原
```

一定要涵蓋的：**錯誤／警告／空清單／載入中／離線／超長字串／按鈕 disabled 或 busy**。

## 三、響應式用 iframe，不要動視窗大小

`@media` 看的是 iframe 自己的寬度，而 iframe 同源所以 `contentDocument` 拿得到。
一次掃完所有斷點，完全不碰使用者的視窗：

```js
const f = document.createElement('iframe');
f.style.cssText = 'position:fixed;left:-9999px;top:0;height:900px;border:0';
document.body.appendChild(f);
for (const w of [1200, 900, 700, 641, 640, 560, 480, 400, 360]) {
  await new Promise(res => { f.style.width = w + 'px'; f.onload = res; f.src = '/?t=' + w; });
  const d = f.contentDocument;
  for (let i = 0; i < 40 && !d.querySelectorAll('.row').length; i++) await new Promise(r => setTimeout(r, 100));
  console.log(w, overlaps(d.querySelector('.wrap') || d.body, f.contentWindow));
}
f.remove();
```

**斷點兩側都要測**（640 與 641），只測 640 看不出規則有沒有真的切換。

## 四、console 錯誤

`read_console_messages` **要先呼叫一次才開始收**。第一次呼叫如果回「no messages」，
先 reload 再叫一次，不要當成沒有錯誤。

## ⚠ 隱藏分頁的量測陷阱

分頁在背景時（被別的視窗遮住也算），**這些量不準**：

- `requestAnimationFrame` 完全不觸發 —— 在注入的腳本裡等 rAF 會讓
  CDP `Runtime.evaluate` 直接 45 秒逾時，看起來像頁面當掉。
- **CSS transition 不會推進**，所以 `getComputedStyle(el).opacity` 會一直停在起始值。
  差點把一條正常的 `body.stale .wrap{opacity:.45}` 誤報成失效。
  要驗有 transition 的樣式，先 `el.style.transition = 'none'` 再量。
- **`scroll-behavior: smooth` 底下 `window.scrollTo` 不會動**（2026-09-07）。
  它是動畫，而動畫在背景分頁不推進——**看起來像 scrollTo 沒作用**。
  trip-atlas 那次我照著「其實沒捲」的結果算了九筆選單位置，全部是錯的，
  而數字看起來完全合理（每一筆剛好差一個列高）。
  量之前先 `document.documentElement.style.scrollBehavior = 'auto'`。
- **`setTimeout` 被節流**（2026-09-07）。「點一下、等 250ms、讀一次」的迴圈
  跑九次就會撞 `javascript_tool` 的 45 秒上限，看起來像頁面當掉。
  React 對 click 這種 discrete event 是**同步 flush** 的，
  所以點完直接讀就有，或者用 `await Promise.resolve()`（微任務不被節流）。

**準的**：`getBoundingClientRect`／`getClientRects`、`matches()`、
沒有 transition 的 `getComputedStyle`、`computer` 的截圖（背景分頁截得出來）、
把 `scroll-behavior` 設成 `auto` 之後的 `scrollTo`。

分頁是不是背景，用 `document.hidden` 直接問，不要猜。

## ⚠ iframe 掃斷點要確認它真的載到東西

第三節那份 iframe 掃描有一個安靜的失敗模式：**每個寬度都回「無重疊」，
而頁面根本沒載到你要驗的那一頁**。trip-atlas 那次九個斷點全綠，
一路到我順手印了 `天數` 才發現全是 0——我掃的是首頁不是行程頁。

**空頁面永遠不會有重疊，跟「這個版面是好的」印出來一模一樣。**

所以每一列都要帶一個「載到了幾筆」的計數，沒載到就明講這一列不算數：

```js
const days = d.querySelectorAll('.timeline-day').length;
report.push({ w, days, overlaps: days ? overlaps(d.body, cw) : ['**沒載到，這一列不算數**'] });
```

順帶一提，等的目標要選對。第一版等的是「按鈕數 > 3」，而框架的骨架按鈕
一開始就在，於是第 0 輪就通過，然後在 API 還沒回來的時候去找資料——
**要等的是你真正要操作的那個元素**，不是「頁面看起來活了」。

## 五、把抓到的不變量寫成測試

破圖修完之後，回頭想「有沒有辦法在沒有 DOM 的情況下守住這個」。那次的答案是有：

- uptime 的 class 不准跟狀態點的 class 撞（用正規式從 HTML 抽出來比對）
- 就地更新的 `querySelector` 必須限定在容器底下

**測試寫完要把 bug 放回去確認它真的會紅**。寫了不會失敗的測試比沒寫更糟——
它讓你以為守住了。

## 六、狀態腳本：走過一次就錄下來，下次直接重播（2026-10-06，借 tester-army/e2e）

第二節「每一種狀態都要逼出來」每次都從頭摸索很貴。**第一次驗收某個專案時，
把「怎麼進到每一種畫面」寫成 `<repo>/.inspect/states.json`**，之後改前端就直接重播：

```bash
python3 ~/.claude/skills/inspect-ui/replay.py ~/Projects/<專案>            # 全部狀態 × 全部寬度
python3 ~/.claude/skills/inspect-ui/replay.py ~/Projects/<專案> --state 名冊打開 --width 1024
```

- 跑在 `dev-browser --headless`：自帶 Chromium、不開視窗、不碰使用者的 Chrome。
  寬度用 headless 的 viewport，**不是**使用者的視窗，不違反「不准 resize」。
- 每次重播跑三樣：`overlap.js`（第一節）、`design-scan.js`（第七節）、console 錯誤與頁面例外。
- 離開碼：`0` 乾淨、`1` 有發現、**`3` 有狀態進不去**——選擇器找不到、`expect` 看不見、
  `minCount` 不夠。**3 代表畫面改了、腳本過期：重錄那個狀態，不要把它刪掉了事。**
- 格式寫在 `replay.py` 開頭。`minCount` 一定要給有資料的頁面設——
  「空頁面永遠沒有重疊」那個陷阱（見上面 iframe 那節）在這裡一樣成立。
- `ignore` 用來排除 canvas 遊戲畫面這類偵測器看不懂的區塊。
- **步驟只放「打開畫面」的動作**：送出表單、建任務、重新整理資料這種會寫資料或對外
  發請求的，一律不准放——重播會被反覆跑。

已經錄好的：**office**（`~/Projects/office/.inspect/states.json`，5 個狀態 × 1440／1024，
2026-10-06 全部乾淨；故意改壞選擇器與 `minCount` 都正確回 3）。

## 七、設計規則掃描（2026-10-06，改寫自 pbakaus/impeccable）

`design-scan.js` 是 impeccable 的確定性偵測規則（不需要 LLM）改寫成的頁面內掃描，
規則清單、分類與怎麼單獨跑見 **[design-rules.md](design-rules.md)**。
第六節的重播器會自動帶上它；只有 `error` 級會讓離開碼變 1，其他級別只列數量。

## 收尾

- 把自己開的分頁關掉。
- 講清楚哪些是實際看過的、哪些沒有。「畫面我沒看過」如果出現在交付訊息裡，
  代表這個 skill 沒跑完。
