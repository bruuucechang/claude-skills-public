// iterm-fit.js — 新開的 iTerm2 視窗照它所在的螢幕調大小（2026-10-19）。
//
// 使用者裁示：「在哪種螢幕開就要用適合該螢幕的大小；開四宮格時要填滿，開一般視窗則較小。」
// 設定檔的 Columns／Rows 是固定格數，不會跟著螢幕變，所以用這支事後調 bounds：
//   - 四宮格（第一個分頁有 ≥ 4 格）→ 填滿該螢幕的可用範圍（扣掉選單列與 Dock）
//   - 其他 → 該螢幕可用範圍的 NORMAL_W × NORMAL_H，置中
// 「該螢幕」＝滑鼠游標所在的螢幕（2026-10-19 修：iTerm2 不管你在哪個螢幕按 Cmd+N 都開在筆電上，
//   照視窗中心判斷就永遠調在筆電，人在外接螢幕上用時等於跑錯地方）。
//
// 用法：
//   osascript -l JavaScript iterm-fit.js fit <window id>   iterm.mjs 開完視窗馬上叫，不等 watcher
//   osascript -l JavaScript iterm-fit.js watch              常駐（launchd：com.bruuucemac.iterm-fit）
//                                                           接住手動 Cmd+N 等其他來源開的視窗
// watch 只動「它啟動之後才出現」的視窗，每個視窗只調一次；之後使用者自己拉大小不會被改回去。
//
// 座標：AppleScript 的 bounds 原點在主螢幕左上、y 向下；NSScreen 原點在主螢幕左下、y 向上。
// ⚠️ 不要 activate iTerm2：調 bounds 不會搶畫面，這支也不能搶（見 no-focus-steal）。
ObjC.import("AppKit");

const NORMAL_W = 0.6, NORMAL_H = 0.72;
const POLL = 0.25;  // 秒；看到新視窗就馬上調，縮短「先小後大」那一下

function screens() {
  const sc = $.NSScreen.screens, out = [];
  const mainH = sc.objectAtIndex(0).frame.size.height;
  for (let i = 0; i < sc.count; i++) {
    const f = sc.objectAtIndex(i).frame, v = sc.objectAtIndex(i).visibleFrame;
    const conv = (r) => ({ x: r.origin.x, y: mainH - (r.origin.y + r.size.height), w: r.size.width, h: r.size.height });
    out.push({ frame: conv(f), visible: conv(v) });
  }
  return out;
}

function screenAt(cx, cy, list) {
  return list.find((s) => cx >= s.frame.x && cx < s.frame.x + s.frame.w && cy >= s.frame.y && cy < s.frame.y + s.frame.h);
}

// 滑鼠所在的螢幕；拿不到就退回視窗中心所在的螢幕
function targetScreen(b, list) {
  try {
    const m = $.NSEvent.mouseLocation, mainH = $.NSScreen.screens.objectAtIndex(0).frame.size.height;
    const s = screenAt(m.x, mainH - m.y, list);
    if (s) return s;
  } catch (e) {}
  return screenAt(b.x + b.width / 2, b.y + b.height / 2, list) || list[0];
}

function fit(w) {
  const b = w.bounds();
  const v = targetScreen(b, screens()).visible;
  const quad = w.tabs()[0].sessions().length >= 4;
  const nb = quad
    ? { x: v.x, y: v.y, width: v.w, height: v.h }
    : (() => {
        const width = Math.round(v.w * NORMAL_W), height = Math.round(v.h * NORMAL_H);
        return { x: Math.round(v.x + (v.w - width) / 2), y: Math.round(v.y + (v.h - height) / 2), width, height };
      })();
  w.bounds = nb;
  return `${w.id()} ${quad ? "quad" : "normal"} ${JSON.stringify(nb)}`;
}

function ids(app) {
  try { return app.windows.id(); } catch (e) { return []; }
}

function run(argv) {
  const app = Application("iTerm2");
  if (argv[0] === "fit") {
    const w = app.windows.byId(Number(argv[1]));
    return fit(w);
  }
  if (argv[0] !== "watch") return "用法：fit <window id> | watch";
  const se = Application.currentApplication();
  se.includeStandardAdditions = true;
  let seen = new Set(app.running() ? ids(app) : []);
  // 不等四宮格切完窗格：iterm.mjs 切完會自己再叫一次 fit，後寫的贏
  for (;;) {
    delay(POLL);
    if (!app.running()) { seen = new Set(); continue; }
    const now = ids(app);
    for (const id of now) {
      if (seen.has(id)) continue;
      seen.add(id);
      try { console.log(fit(app.windows.byId(id))); } catch (e) { console.log(`${id} 調整失敗：${e}`); }
    }
    // 關掉的視窗從 seen 拿掉，免得集合一直長
    const alive = new Set(now);
    for (const id of seen) if (!alive.has(id)) seen.delete(id);
  }
}
