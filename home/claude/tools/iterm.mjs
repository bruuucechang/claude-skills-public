// iterm.mjs — 開 iTerm2 視窗／窗格／分頁、跑指令、收掉 session（2026-10-16）。
//
// acct（AgentQuota 面板的按鈕）與 handoff-open（做完自動交接）共用這一份。
// 2026-10-16 使用者裁示：面板開出來的終端機一律是 iTerm2；四宮格照 iTerm2 常規做法，
// 一個視窗切成 2×2 窗格（每格可以是不同帳號，靠各自的 CLAUDE_CONFIG_DIR）。
//
// 實測過的坑（2026-10-16，Air，iTerm2 3.6）：
// - `close w` 對多窗格的視窗會跳確認框，AppleScript 卡到 AppleEvent 逾時。
//   要收就結束那個 session 的 shell（SIGHUP），窗格自己關，不會問。
// - 底色用跳脫序列 `OSC 1337;SetColors=bg=RRGGBB`；還原要 `OSC 111`，
//   `SetColors=bg=default` 沒有作用（讀回 background color 對過）。
// - 換底色一定要連字色一起換（`SetColors=fg=…`，還原是 `OSC 110`）。這台的預設設定檔是淺色主題
//   （字 #101010），只換底色的話 Claude 的灰字在深灰底上幾乎看不見（2026-10-17 使用者回報、截圖對過）。
// - 標籤色用 `OSC 6;1;bg;red|green|blue;brightness;N`，還原是 `OSC 6;1;bg;*;default`。
// - `create window` 會把 iTerm2 帶到最前面；不想搶畫面就事後把原本最前面的 app 叫回來。
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const APP = "/Applications/iTerm.app";

// 色盤（只套 iTerm2）：2026-10-16 改成帳號只靠分頁標籤色分、底色共用（工作中深灰、等你時橘），
// 但單分頁視窗不顯示分頁列、四宮格共用一個分頁，標籤色根本看不到。2026-10-18 使用者裁示「底色不要橘色」：
// 底色改回跟著帳號走（colors.bg），不分工作中／等你；標籤色照送。
export const WORK_BG = "#1E1E1E";   // 清單上沒有 colors.bg 的帳號用這個
export const WORK_FG = "#D4D4D4";   // 各帳號底色共用；換底色就一起送，見檔頭
const TAB_BY_FAMILY = { 暖: "#C0392B", 冷: "#2E6FD8" };
const BG_BY_FAMILY = { 暖: "#3A1414", 冷: "#14233F" };
export const tabColor = (a) => a?.colors?.tab || TAB_BY_FAMILY[a?.colors?.family] || null;
export const bgColor = (a) => a?.colors?.bg || BG_BY_FAMILY[a?.colors?.family] || WORK_BG;

// 深色設定檔「Claude Dark」（2026-10-17 使用者裁示：整套深色、SF Mono 13、留邊、分頁只留標題）。
// 正本是旁邊的 iterm-profile.json，開視窗前同步成 iTerm2 的 Dynamic Profile（iTerm2 會自己重讀那個資料夾）。
// ⚠️ 執行中改 `Default Bookmark Guid` 不會生效（iTerm2 只在啟動時讀，2026-10-17 實測：新窗格照樣是 Default），
// 所以這裡開視窗一律明寫 `with profile "Claude Dark"`，不靠預設設定檔。
// ⚠️ SF Mono 不是叫得到名字的系統字型，只內附在 Terminal.app 裡；沒複製進 ~/Library/Fonts 的話 iTerm2 會退回別的字。
export const PROFILE = "Claude Dark";
const PROFILE_SRC = join(dirname(fileURLToPath(import.meta.url)), "iterm-profile.json");
const PROFILE_DST = join(homedir(), "Library/Application Support/iTerm2/DynamicProfiles/claude-dark.json");
const SF_MONO = "/System/Applications/Utilities/Terminal.app/Contents/Resources/Fonts";

export function ensureProfile() {
  try {
    const src = readFileSync(PROFILE_SRC, "utf8");
    if (!existsSync(PROFILE_DST) || readFileSync(PROFILE_DST, "utf8") !== src) {
      mkdirSync(dirname(PROFILE_DST), { recursive: true });
      writeFileSync(PROFILE_DST, src);
    }
    const fonts = join(homedir(), "Library/Fonts");
    if (!existsSync(join(fonts, "SF-Mono-Regular.otf")) && existsSync(SF_MONO)) {
      execFileSync("/bin/sh", ["-c", `cp -n "${SF_MONO}"/SF-Mono-*.otf "${fonts}/"`]);
    }
    return `profile ${as(PROFILE)}`;
  } catch {
    return "default profile";   // 正本讀不到就照舊用預設設定檔，不讓開視窗整個失敗
  }
}

export function osa(script, timeout = 20000) {
  return execFileSync("osascript", ["-e", script], { encoding: "utf8", timeout }).trim();
}

// AppleScript 字串字面值
export const as = (s) => '"' + String(s).replace(/\\/g, "\\\\").replace(/"/g, '\\"') + '"';
// shell 單引號
export const sq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

const hex = (h) => {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(h || "");
  return m ? [m[1], m[2], m[3]].map((x) => parseInt(x, 16)) : null;
};

// 跳脫序列（原始字元，寫進 tty 用）
export function seqTab(color) {
  const c = hex(color);
  if (!c) return "\x1b]6;1;bg;*;default\x07";
  return ["red", "green", "blue"].map((k, i) => `\x1b]6;1;bg;${k};brightness;${c[i]}\x07`).join("");
}
export function seqBg(color) {
  const c = hex(color);
  return c
    ? `\x1b]1337;SetColors=bg=${color.replace("#", "")}\x07\x1b]1337;SetColors=fg=${WORK_FG.replace("#", "")}\x07`
    : "\x1b]111\x07\x1b]110\x07";
}

// 同一串序列寫成 shell 指令（printf 的 \033／\a），給 write text 用
export function printfOf(seq) {
  const body = seq.replace(/\x1b/g, "\\033").replace(/\x07/g, "\\a");
  return `printf ${sq(body)}`;
}

export function seqBadge(text) {
  return `\x1b]1337;SetBadgeFormat=${Buffer.from(text || "").toString("base64")}\x07`;
}

// 一格要跑的整串指令：上色＋badge → cd → 帶設定目錄跑 claude（args 是已經 shell 引號好的字串）。
// 這串由 `acct pane` 印出來、窗格裡 eval，所以畫面上只會出現一行短短的 eval（見 launchLine）。
// ⚠️ 不要加 `clear`：macOS 的 clear 會送「清除捲動紀錄」，iTerm2 每格跳一條要權限的提示列（2026-10-16 實測）。
// ⚠️ 設定目錄一律明寫，不靠繼承：iTerm2 這個 app 的環境是啟動它的那個程序給的，
// 2026-10-16 實測它被一個 work 的 claude session 叫起來，於是每個新窗格都帶著
// CLAUDE_CONFIG_DIR=~/.claude-work——預設目錄那格不寫的話，開出來的是別人。
export function paneCmd({ cwd, configDir, defaultDir, tab, bg, badge = "", args = "", run = "claude" }) {
  const env = configDir && configDir !== defaultDir
    ? `export CLAUDE_CONFIG_DIR=${sq(configDir)}` : "unset CLAUDE_CONFIG_DIR";
  const color = printfOf(seqTab(tab) + seqBg(bg) + seqBadge(badge));
  return `${color}; cd ${sq(cwd)} && { ${env}; ${run}${args ? " " + args : ""}; }`;
}

// 窗格裡實際打的那一行：叫 acct 印出 paneCmd，在這個 shell 裡 eval（claude 直接是 shell 的子程序）
// 參數只在需要時加引號、家目錄寫成 ~，讓那一行短到看得懂：eval "$(acct pane bruce ~/Projects)"
export function launchLine(acctPath, argv, home = process.env.HOME) {
  const show = (a) => {
    const t = home && (a === home || a.startsWith(home + "/")) ? "~" + a.slice(home.length) : a;
    if (/^[\w@%+=:,./~-]+$/.test(t)) return t;
    return t.startsWith("~/") ? "~/" + sq(t.slice(2)) : sq(a);
  };
  return `eval "$(${[acctPath, "pane", ...argv].map(show).join(" ")})"`;
}

export function frontApp() {
  try {
    const asn = execFileSync("lsappinfo", ["front"], { encoding: "utf8" }).trim();
    const out = execFileSync("lsappinfo", ["info", "-only", "bundleid", asn], { encoding: "utf8" });
    return /"([^"]+)"\s*$/.exec(out.trim())?.[1] || null;
  } catch { return null; }
}

// 把原本在前面的 app 叫回來（create window 會把 iTerm2 推到前面）
export function restoreFront(bundle) {
  if (!bundle || bundle === "com.googlecode.iterm2") return;
  try { execFileSync("open", ["-b", bundle]); } catch {}
}

// 開一個新視窗。cmds 一格一個指令：1 格＝整個視窗；4 格＝2×2，順序 左上、右上、左下、右下。
// activate：使用者按按鈕要看的 → true；背景交接 → false（事後把原本的 app 叫回來）。
export function openWindow(cmds, { activate = true } = {}) {
  if (![1, 4].includes(cmds.length)) throw new Error("只支援 1 格或 4 格");
  const before = activate ? null : frontApp();
  const prof = ensureProfile();
  const writes = cmds.length === 1
    ? `tell s1 to write text ${as(cmds[0])}`
    : `tell s1
    set s2 to (split vertically with ${prof})
    set s3 to (split horizontally with ${prof})
  end tell
  tell s2 to set s4 to (split horizontally with ${prof})
  tell s1 to write text ${as(cmds[0])}
  tell s2 to write text ${as(cmds[1])}
  tell s3 to write text ${as(cmds[2])}
  tell s4 to write text ${as(cmds[3])}`;
  const id = osa(`tell application "iTerm2"
  set w to (create window with ${prof})
  set s1 to current session of w
  ${writes}
  ${activate ? "activate" : ""}
  return id of w
end tell`);
  fitWindow(id);
  if (!activate) restoreFront(before);
  return id;
}

// 照所在螢幕調大小：四宮格填滿、一般視窗較小（2026-10-19 裁示，做法在 iterm-fit.js）。
// 常駐的 watcher 也會調，這裡先叫一次是為了不讓使用者看到 176×46 的過渡畫面；失敗不擋開視窗。
const FIT = join(dirname(fileURLToPath(import.meta.url)), "iterm-fit.js");
export function fitWindow(id) {
  try { return execFileSync("osascript", ["-l", "JavaScript", FIT, "fit", String(id)], { encoding: "utf8", timeout: 10000 }).trim(); }
  catch { return null; }
}

// ITERM_SESSION_ID 長得像 "w0t1p0:9D2E…"，冒號後面是 AppleScript 的 unique ID
export function sessionUid(env = process.env) {
  const v = env.ITERM_SESSION_ID || "";
  return v.includes(":") ? v.split(":").pop() : null;
}

// 在某個 session 所在的視窗開新分頁跑 cmd；找不到那個 session 就開新視窗。不 activate。
// ⚠️ 新分頁會變成那個視窗作用中的分頁、把原本的四宮格蓋掉——交接用 splitBeside。
export function openTabBeside(uid, cmd) {
  const before = frontApp();
  const prof = ensureProfile();
  const r = osa(`tell application "iTerm2"
  set target to missing value
  ${uid ? `repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if unique ID of s is ${as(uid)} then set target to w
      end repeat
    end repeat
  end repeat` : ""}
  if target is missing value then
    set target to (create window with ${prof})
    set s to current session of target
    set how to "window"
  else
    tell target to set t to (create tab with ${prof})
    set s to current session of t
    set how to "tab"
  end if
  tell s to write text ${as(cmd)}
  return how & " " & (unique ID of s)
end tell`);
  restoreFront(before);
  const [how, newUid] = r.split(" ");
  return { how, uid: newUid };
}

// 就地換格（2026-10-17 裁示）：在某個 session 的窗格旁邊切出新的一格跑 cmd，舊格之後由呼叫端收掉，
// 新格就補回原位——不開新分頁（新分頁會變成作用中，把使用者的四宮格蓋到後面）、不開新視窗。
// 切的方向照那格的形狀：寬的左右切、高的上下切。找不到那個 session 才開新視窗。不 activate。
export function splitBeside(uid, cmd) {
  const before = frontApp();
  const prof = ensureProfile();
  const r = osa(`tell application "iTerm2"
  set target to missing value
  ${uid ? `repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if unique ID of s is ${as(uid)} then set target to s
      end repeat
    end repeat
  end repeat` : ""}
  if target is missing value then
    set w to (create window with ${prof})
    set n to current session of w
    set how to "window"
  else
    tell target
      if (columns of target) > (rows of target) * 3 then
        set n to (split vertically with ${prof})
      else
        set n to (split horizontally with ${prof})
      end if
    end tell
    set how to "split"
  end if
  tell n to write text ${as(cmd)}
  return how & " " & (unique ID of n)
end tell`);
  restoreFront(before);
  const [how, newUid] = r.split(" ");
  return { how, uid: newUid };
}

// 逐格找 session 的 AppleScript 是按索引走訪的：別格剛好開關會丟 -1719 Invalid index（10-16〜10-20 兩次把 handoff 的
// --inject 打死）。下面每支 osa 只做「找到那格 → 最多寫一次 → return」，例外只會發生在寫之前，所以整支重試不會重複打字。
// ITERM_FAKE_1719=N：前 N 次「打字」的 osa 假裝撞到（只給測試用；找格、讀狀態的不算，免得被等待迴圈用掉）。
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
let fake1719 = Number(process.env.ITERM_FAKE_1719) || 0;
export function osaRetry(script, tries = 3) {
  for (let i = 1; ; i++) {
    try {
      if (fake1719 > 0 && script.includes("write text")) { fake1719--; throw new Error("execution error: iTerm2 got an error: Invalid index. (-1719)"); }
      return osa(script);
    } catch (e) {
      if (i >= tries || !/-1719/.test(String(e?.message || e))) throw e;
      process.stderr.write(`iterm: AppleScript -1719，第 ${i} 次重試\n`);
      sleepSync(500);
    }
  }
}
// 找到 uid 那格就對它做 body（AppleScript，裡面用 s 指那格），回傳 body 的結果；找不到回 ""
const inSession = (uid, body) => osaRetry(`tell application "iTerm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if unique ID of s is ${as(uid)} then
          ${body}
        end if
      end repeat
    end repeat
  end repeat
  return ""
end tell`);

// 對某個 session 裡的 Claude Code 打一行字並送出（handoff-open 自己 /clear 用，2026-10-20）。
// write text 的換行在 Claude 輸入框只是框內換行，送出要另送 CSI-u 的 Enter（ESC[13u，2026-10-19 實測）。
// 字與 Enter 分兩次 osa、各自重新用 uid 找那格：以前同一支 script 裡 delay 0.3 之後再用索引參照寫 Enter，
// 那 0.3 秒內別格開關就會撞 -1719 或把 Enter 送進別格（PR #10 審查）。
// 不 activate、不用 System Events，不搶焦點。找不到那個 session 回 false。
export function typeInto(uid, text) {
  if (text && inSession(uid, `tell s to write text ${as(text)} newline no
          return "ok"`) !== "ok") return false;
  if (text) sleepSync(300);
  return inSession(uid, `tell s to write text ((ASCII character 27) & "[13u") newline no
          return "ok"`) === "ok";
}

// 對某個 session 的 shell 打一行指令（claude 已經退出、回到 shell 時用；handoff-open 換帳號，2026-10-21）。
// shell 吃一般的換行，不用 typeInto 的 ESC[13u。找不到那個 session 回 false。
export function typeShell(uid, text) {
  return inSession(uid, `tell s to write text ${as(text)}
          return "ok"`) === "ok";
}

// 那格最近有沒有在輸出（Claude 工作中 spinner 會一直重畫；閒著不動）。找不到或出錯回 null。
export function isProcessing(uid) {
  try {
    const r = inSession(uid, `return (is processing of s) as text`);
    return r === "" ? null : r === "true";
  } catch { return null; }
}

// 某個 session 的 tty（給 handoff 收舊格用）；找不到回 null
export function ttyOf(uid) {
  try { return inSession(uid, `return tty of s`) || null; } catch { return null; }
}
