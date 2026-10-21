// overlap.js — inspect-ui 第一節的重疊偵測器與不變量，抽成檔案給 replay.py 注入。
// **正本是這個檔**；SKILL.md 第一節的程式碼要跟這裡一致（2026-10-06 抽出）。
// 用法：整段當運算式丟進 page.evaluate，回傳 { 重疊: [...], 不變量: [...] }。
(() => {
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

const bad = [];
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

return { 重疊: overlaps(document.body), 不變量: [...new Set(bad)] };
})()
