// focus-keeper —— 常駐守衛：agent（claude／codex）啟動的程式一跑到最前面，就把使用者原本的 app 切回來。
//
// 為什麼要常駐而不是包在每個啟動指令外面（bgrun）：2026-10-11 剛修好 run.sh，
// 另一個 session 就在 lane worktree（舊版 run.sh）跑 world --shots，Godot 在啟動後 45 秒才搶焦點——
// 包裝式守衛管不到別的分支、別的指令、也管不到幾十秒後的那一次。這支看的是「誰的子孫」，不看怎麼啟動的。
//
// 判準：最前面那個 app 的程序祖先裡有 comm 是 claude 或 codex 的 → 它是 agent 開的 → 切回去。
// 使用者自己從終端機（沒經過 claude）開的 Godot 不受影響。
// 用 `open` 開的東西父程序是 launchd，這支認不出來——那一類由 hooks/focus-guard.mjs 在指令層擋。
//
// 由 LaunchAgent tw.work.focus-keeper 常駐（install.sh）。紀錄：~/Library/Logs/focus-keeper.log
// 暫停：touch ~/.claude/skills/home/claude/tools/focus-keeper/off
ObjC.import("AppKit");
ObjC.import("Foundation");

const app = Application.currentApplication();
app.includeStandardAdditions = true;
const OFF = $("~/.claude/skills/home/claude/tools/focus-keeper/off").stringByExpandingTildeInPath.js;
const fm = $.NSFileManager.defaultManager;

function agentLaunched(pid) {
  const rows = app.doShellScript("ps -axo pid=,ppid=,comm=").split(/\r|\n/);
  const parent = {}, comm = {};
  for (const r of rows) {
    const m = r.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/);
    if (m) { parent[m[1]] = m[2]; comm[m[1]] = m[3]; }
  }
  let p = String(pid);
  for (let i = 0; i < 40 && p && p !== "1" && p !== "0"; i++) {
    const base = (comm[p] || "").split("/").pop();
    if (base === "claude" || base === "codex") return base;
    p = parent[p];
  }
  return null;
}

function log(s) {
  const d = new Date();
  const t = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 23).replace("T", " ");
  console.log(t + " " + s);
}

function run() {
  const ws = $.NSWorkspace.sharedWorkspace;
  let lastPid = 0, userApp = null;
  log("啟動");
  while (true) {
    $.NSRunLoop.currentRunLoop.runUntilDate($.NSDate.dateWithTimeIntervalSinceNow(0.05));
    const f = ws.frontmostApplication;
    if (!f) continue;
    const pid = f.processIdentifier;
    if (pid === lastPid) continue;
    lastPid = pid;
    const who = agentLaunched(pid);
    if (!who) {
      // 只記不切：不是 agent 開的、但啟動 8 秒內就跳到前面的（launchd 排程、`open` 開的，父程序都是
      // launchd，認不出是誰）。2026-10-15 使用者要「還有什麼會彈出的一起修」，沒紀錄就只能猜。
      // 使用者自己點開的 app 也會記到，所以不切回、只留線索。
      const born = f.launchDate;
      if (born && !born.isNil() && -born.timeIntervalSinceNow < 8 && f.activationPolicy === $.NSApplicationActivationPolicyRegular) {
        log(`新啟動的 ${f.localizedName.js}（pid ${pid}，${f.bundleIdentifier.js}）跳到前面——不是 agent 開的，只記錄`);
      }
      // 只記一般 app（有 Dock 圖示）。選單列的 SystemUIServer、Dock 這類點一下就會短暫變成最前面，
      // 記成「使用者原本的 app」的話會切錯（第一版實測踩到）。
      if (f.activationPolicy === $.NSApplicationActivationPolicyRegular) userApp = f.bundleIdentifier.js || userApp;
      continue;
    }
    if (fm.fileExistsAtPath(OFF)) { log(`暫停中，放過 ${f.localizedName.js}`); continue; }
    if (!userApp) continue;
    try {
      Application(userApp).activate();
      log(`${f.localizedName.js}（pid ${pid}，${who} 開的）搶到前面 → 切回 ${userApp}`);
    } catch (e) { log(`切回 ${userApp} 失敗：${e}`); }
    lastPid = 0;
  }
}
