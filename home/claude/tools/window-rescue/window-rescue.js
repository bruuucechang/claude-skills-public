// window-rescue —— Chrome 視窗的標題列跑到任何螢幕都碰不到的地方時，自動拉回螢幕內。
//
// 為什麼要這支（2026-11-09 實測）：接外接螢幕時，Chrome 的視窗偶爾會被系統放到外接螢幕上緣更上面，
// 標題列碰不到就拖不回來。當時同一個視窗，Chrome 自己回報 (-421,-176)、WindowServer 實際在 (-677,-1256)，
// 兩者正好差外接螢幕原點 (-256,-1080)。觸發路徑沒抓到，所以這支不賭原因，只看結果：標題列碰不碰得到。
// Chrome 的 AppleScript `set bounds` 實測能把這種視窗救回來，而且不搶焦點、不需要輔助使用權限。
//
// 由 LaunchAgent tw.work.window-rescue 每 10 秒跑一次（install.sh）。每次都是新程序：
// NSScreen 在長駐程序裡沒跑 run loop 會停在舊值，換螢幕排列時正好就是要用到它的時候。
// 平常只讀 CGWindowList，不對 Chrome 發 Apple Event（實測一次可能卡 20 秒）；發現異常才碰 Chrome。
//
// 用法：osascript -l JavaScript window-rescue.js [--dry-run | --selftest]
// 紀錄：~/Library/Logs/window-rescue.log（只有真的動手才寫）
// 暫停：touch ~/Library/Logs/window-rescue.off
ObjC.import("AppKit");
ObjC.import("CoreGraphics");
ObjC.import("Foundation");

const MIN_W = 400, MIN_H = 300;     // 比這小的是 Chrome 內部的泡泡／輔助視窗
const GRAB_Y = 6;                   // 標題列上用來判斷「碰得到」的那條線，距視窗頂的點數
const MIN_REACH = 120;              // 標題列至少要有這麼寬落在螢幕內才抓得到
const MENU_H = 30;                  // visibleFrame 沒扣掉選單列時（非作用中的螢幕）自己扣
const COOLDOWN_S = 300;             // 同一個視窗救不回來時隔多久再試，避免每 10 秒吵 Chrome 和寫紀錄

// ---- 純邏輯（--selftest 測這段）----
function overlap1(a0, a1, b0, b1) { return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0)); }

function reachable(w, displays) {
  const y = w.y + GRAB_Y;
  return displays.some(d => y >= d.y && y < d.y + d.h && overlap1(w.x, w.x + w.w, d.x, d.x + d.w) >= MIN_REACH);
}

function isFullscreen(w, displays) {
  return displays.some(d => w.x === d.x && w.y === d.y && w.w === d.w && w.h === d.h);
}

function isBroken(w, displays) {
  return w.w >= MIN_W && w.h >= MIN_H && !isFullscreen(w, displays) && !reachable(w, displays);
}

function same(a, b) { return a.x === b.x && a.y === b.y && Math.abs(a.w - b.w) <= 2 && Math.abs(a.h - b.h) <= 2; }

// Chrome 回報的視窗與系統的視窗沒有共同 id。先把「跟健康視窗對得上」的扣掉，剩下的就是壞掉的那幾個。
function matchBroken(chromeWins, healthy, broken) {
  const rest = chromeWins.slice();
  for (const h of healthy) {
    const i = rest.findIndex(a => same(a, h));
    if (i >= 0) rest.splice(i, 1);
  }
  const out = [];
  for (const b of broken) {
    const i = rest.findIndex(a => Math.abs(a.w - b.w) <= 2 && Math.abs(a.h - b.h) <= 2);
    if (i >= 0) out.push({ chrome: rest.splice(i, 1)[0], actual: b });
  }
  return out;
}

function area(w, d) { return overlap1(w.x, w.x + w.w, d.x, d.x + d.w) * overlap1(w.y, w.y + w.h, d.y, d.y + d.h); }

function target(actual, chrome, displays) {
  let best = displays.find(d => d.main) || displays[0], bestA = 0;
  for (const w of [actual, chrome]) {
    for (const d of displays) { const a = area(w, d); if (a > bestA) { bestA = a; best = d; } }
    if (bestA > 0) break;
  }
  const u = best.usable;
  const w = Math.min(actual.w, u.w), h = Math.min(actual.h, u.h);
  return {
    x: Math.max(u.x, Math.min(actual.x, u.x + u.w - w)),
    y: Math.max(u.y, Math.min(actual.y, u.y + u.h - h)),
    w, h,
  };
}

// ---- 讀系統狀態 ----
function displays() {
  const screens = $.NSScreen.screens, n = screens.count;
  const mainH = screens.objectAtIndex(0).frame.size.height;
  const out = [];
  for (let i = 0; i < n; i++) {
    const s = screens.objectAtIndex(i), f = s.frame, v = s.visibleFrame;
    const d = { x: f.origin.x, y: mainH - f.origin.y - f.size.height, w: f.size.width, h: f.size.height, main: i === 0 };
    let top = mainH - v.origin.y - v.size.height, bottom = top + v.size.height;
    if (top < d.y + MENU_H) top = d.y + MENU_H;
    d.usable = { x: v.origin.x, y: top, w: v.size.width, h: bottom - top };
    out.push(d);
  }
  return out;
}

function chromeCGWindows() {
  const arr = ObjC.castRefToObject($.CGWindowListCopyWindowInfo(16 /* excludeDesktop */, 0));
  const out = [], n = arr.count;
  for (let i = 0; i < n; i++) {
    const d = arr.objectAtIndex(i);
    if (ObjC.unwrap(d.objectForKey($("kCGWindowOwnerName"))) !== "Google Chrome") continue;
    if (ObjC.unwrap(d.objectForKey($("kCGWindowLayer"))) !== 0) continue;
    const b = d.objectForKey($("kCGWindowBounds"));
    const g = k => ObjC.unwrap(b.objectForKey($(k)));
    const w = { id: ObjC.unwrap(d.objectForKey($("kCGWindowNumber"))), x: g("X"), y: g("Y"), w: g("Width"), h: g("Height") };
    if (w.w >= MIN_W && w.h >= MIN_H) out.push(w);
  }
  return out;
}

function chromeASWindows(chrome) {
  const out = [];
  for (const w of chrome.windows()) {
    if (w.minimized()) continue;
    const b = w.bounds();
    out.push({ ref: w, id: w.id(), x: b.x, y: b.y, w: b.width, h: b.height });
  }
  return out;
}

// ---- 紀錄與冷卻 ----
const HOME = ObjC.unwrap($.NSHomeDirectory());
const LOG = HOME + "/Library/Logs/window-rescue.log";
const COOL = HOME + "/Library/Logs/window-rescue.cooldown";
const fm = $.NSFileManager.defaultManager;

function log(msg) {
  const line = new Date().toISOString() + " " + msg + "\n";
  const existing = fm.fileExistsAtPath(LOG) ? ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(LOG, 4, null)) : "";
  $(existing + line).writeToFileAtomicallyEncodingError(LOG, true, 4, null);
}

// 冷卻記在每個視窗上（CG window id → 到期的 epoch 秒）：救不回來的那個不該擋住別的視窗。
function loadCool() {
  try {
    const now = Date.now() / 1000, raw = JSON.parse(ObjC.unwrap($.NSString.stringWithContentsOfFileEncodingError(COOL, 4, null)));
    const out = {};
    for (const k of Object.keys(raw)) if (raw[k] > now) out[k] = raw[k];
    return out;
  } catch (e) { return {}; }
}

function saveCool(c) { $(JSON.stringify(c)).writeToFileAtomicallyEncodingError(COOL, true, 4, null); }

function coolDown(c, id) { c[id] = Date.now() / 1000 + COOLDOWN_S; }

function selftest() {
  const ext = { x: -256, y: -1080, w: 1920, h: 1080, main: false, usable: { x: -256, y: -1050, w: 1920, h: 1050 } };
  const mac = { x: 0, y: 0, w: 1470, h: 956, main: true, usable: { x: 0, y: 33, w: 1470, h: 858 } };
  const D = [mac, ext];
  const win = (x, y, w, h) => ({ x, y, w, h });
  const fails = [];
  const ok = (name, got, want) => { if (JSON.stringify(got) !== JSON.stringify(want)) fails.push(name + " got " + JSON.stringify(got) + " want " + JSON.stringify(want)); };

  // 2026-11-09 真實事故的數字
  ok("事故視窗算壞掉", isBroken(win(-677, -1256, 1920, 1050), D), true);
  ok("外接螢幕正常視窗", isBroken(win(-256, -1050, 1920, 1050), D), false);
  ok("內建螢幕正常視窗", isBroken(win(0, 33, 1470, 847), D), false);
  ok("全螢幕不算壞掉", isBroken(win(-256, -1080, 1920, 1080), D), false);
  ok("小泡泡不管", isBroken(win(-289, -1500, 1560, 138), D), false);
  ok("跨兩個螢幕但標題列還在", isBroken(win(-421, -176, 1920, 1050), D), false);
  ok("標題列在兩螢幕間的空白區", isBroken(win(-900, 300, 800, 600), D), true);
  ok("使用者故意推到右邊只露一截，抓得到就不動", isBroken(win(1300, 100, 1000, 700), D), false);
  ok("推到幾乎全出去，抓不到", isBroken(win(1420, 100, 1000, 700), D), true);

  const incident = win(-677, -1256, 1920, 1050), chromeView = win(-421, -176, 1920, 1050);
  ok("事故視窗的目標位置", target(incident, chromeView, D), win(-256, -1050, 1920, 1050));
  ok("太大的視窗縮到螢幕內", target(win(5000, 33, 3000, 2000), win(5000, 33, 3000, 2000), D), win(1470 - 1470, 33, 1470, 858));

  const healthy = [win(0, 33, 1470, 847), win(-256, -1050, 1920, 1050)];
  const asWins = [win(0, 33, 1470, 847), win(-256, -1050, 1920, 1050), chromeView];
  ok("對到 Chrome 回報的那個視窗", matchBroken(asWins, healthy, [incident]).map(m => m.chrome), [chromeView]);
  // 壞掉的視窗 Chrome 回報的位置剛好跟另一個健康視窗一樣：不能因此漏掉
  const twin = [win(-256, -1050, 1920, 1050), win(-256, -1050, 1920, 1050)];
  ok("雙胞胎座標也救得到", matchBroken(twin, [win(-256, -1050, 1920, 1050)], [incident]).length, 1);
  ok("別的 Chrome 程序的壞視窗對不上就不動", matchBroken([win(0, 33, 1470, 847)], [win(0, 33, 1470, 847)], [incident]).length, 0);

  if (fails.length) throw new Error("selftest FAIL\n" + fails.join("\n"));
  return "selftest ok";
}

function run(argv) {
  if (argv[0] === "--selftest") return selftest();
  const dry = argv[0] === "--dry-run";
  if (!dry && fm.fileExistsAtPath(HOME + "/Library/Logs/window-rescue.off")) return;

  const D = displays();
  let all = chromeCGWindows();
  let broken = all.filter(w => isBroken(w, D));
  if (dry) return JSON.stringify({ displays: D, windows: all, broken });
  const cool = loadCool();
  if (!broken.some(w => !cool[w.id])) return;

  // 排除拖曳中與螢幕正在重新排列的瞬間：等 1.5 秒還壞、滑鼠也沒按著才算數
  $.NSThread.sleepForTimeInterval(1.5);
  if (Number(ObjC.unwrap($.NSEvent.pressedMouseButtons)) !== 0) return;
  const D2 = displays();
  all = chromeCGWindows();
  const healthy = all.filter(w => !isBroken(w, D2));
  broken = all.filter(w => isBroken(w, D2) && !cool[w.id]);
  if (!broken.length) return;

  let matches;
  try {
    matches = matchBroken(chromeASWindows(Application("Google Chrome")), healthy, broken);
  } catch (e) {   // 沒授權、Chrome 忙或正在關：要留紀錄，也不能每 10 秒重試
    log("ERROR 讀 Chrome 視窗失敗：" + e);
    broken.forEach(w => coolDown(cool, w.id));
    saveCool(cool);
    return;
  }
  // 對不上的是別的 Chrome 程序（爬蟲用的設定檔）或內部視窗，AppleScript 管不到；不記紀錄，但別每 10 秒去問 Chrome
  broken.filter(b => !matches.some(m => m.actual.id === b.id)).forEach(w => coolDown(cool, w.id));

  for (const { chrome: a, actual } of matches) {
    const t = target(actual, a, D2);
    const rect = { x: t.x, y: t.y, width: t.w, height: t.h };
    let err = "";
    try {
      // Chrome 以為自己已經在目標位置時 set bounds 可能什麼都不做，先偏一點逼它真的動
      if (a.x === t.x && a.y === t.y && a.w === t.w && a.h === t.h) a.ref.bounds = { x: t.x, y: t.y + 1, width: t.w, height: t.h };
      a.ref.bounds = rect;
    } catch (e) { err = " err=" + e; }
    $.NSThread.sleepForTimeInterval(0.3);
    const now = chromeCGWindows().find(w => w.id === actual.id);
    const fixed = now && !isBroken(now, D2);
    if (!fixed) coolDown(cool, actual.id);
    log((fixed ? "rescued" : "FAILED") + err + " chrome=" + a.id + " actual=" + JSON.stringify(actual) + " chromeView=" + JSON.stringify([a.x, a.y, a.w, a.h]) + " to=" + JSON.stringify(t) + " now=" + JSON.stringify(now || null));
  }
  saveCool(cool);
}
