#!/usr/bin/env node
// pane-state.mjs — 每個 Claude Code session 回報自己的狀態，給 `quad inbox` 彙整
// （借 tuios 的「每格一個狀態＋一個收件匣」，2026-10-06）。
//
// 用法（settings.json 的 hook，一律 async）：
//   UserPromptSubmit → pane-state.mjs working
//   Notification     → pane-state.mjs needs_input   （要授權、或閒置等你回答）
//   Stop             → pane-state.mjs done          （這一輪做完，等你下一句）
//   SessionEnd       → pane-state.mjs end           （刪狀態檔、恢復底色）
//
// 狀態檔：~/.claude/state/panes/<tty>.json，一個 Terminal 分頁一個。
//
// 一冷一暖分帳號，等你的兩種狀態再各一色（2026-10-06 使用者裁示）：
//
//              工作中（設定檔）        等你回答 needs_input   做完了 done
//   5×  暖色   Red Sands 磚紅 #7A2513   深橙 #8A4A00           橄欖金 #5A5200
//   20× 冷色   Ocean 藍 #224EBD         深紫 #4A1A7A           青綠 #0A5A50
//
// 全部選深色：這幾個設定檔的字是淺色，亮色底會讓字看不見。
// 「工作中」不是寫死的顏色，而是**進入等待前記下的那個設定檔**——套回去就還原。
// 上面那張表只管 Terminal.app。**iTerm2 另有色盤**（tools/iterm.mjs）：底色跟著帳號（colors.bg）、
//   不隨狀態變（2026-10-18 裁示「底色不要橘色」），另外送分頁標籤色（colors.tab）。
//   做法是對那格的 tty 直接寫跳脫序列（tools/iterm.mjs），不必找 AppleScript 物件。
// Windows 只寫狀態檔。
// 任何錯誤都吞掉：這支壞掉不能擋到 Claude Code。
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync, unlinkSync, existsSync, openSync, writeSync, closeSync } from "node:fs";
import { homedir } from "node:os";
import { join, basename } from "node:path";

const STATE = process.argv[2];
const DIR = join(homedir(), ".claude", "state", "panes");
const WAIT = new Set(["needs_input", "done"]);
// 帳號與配色讀帳號清單（tools/accounts.mjs）；清單上找不到就退回 5× 的配色
// 2026-10-10 起看的是這個目錄**實際登入**的帳號（A.currentActual）：在 ~/.claude 打 /login
// 換成 work，那一格就要換成冷色（使用者裁示：顏色跟著實際登入走）。
let ACCT = null;
let WORK_PROFILES = new Set();   // 清單上各帳號的工作設定檔：用來分辨分頁原本的外觀是不是我們上的（是的話不當成 orig）
let ACCT_BG = null;              // 工作底色，跟 bg 欄位同格式（"r, g, b"，沒有大括號）
try {
  const A = await import("../tools/accounts.mjs");
  const all = A.load().accounts;
  WORK_PROFILES = new Set(all.map((a) => a.colors?.work_profile).filter(Boolean));
  ACCT = A.currentActual(all);
  if (ACCT) {
    ACCT.osa = { needs_input: A.osaColor(ACCT.colors.ask), done: A.osaColor(ACCT.colors.done) };
    ACCT_BG = A.osaColor(ACCT.colors.work_bg)?.slice(1, -1) || null;
  }
} catch {}
const COLORS = ACCT?.osa || { needs_input: "{35466, 19018, 0}", done: "{23130, 21074, 0}" };
const DEFAULT_PROFILE = ACCT?.colors?.work_profile || "Red Sands";

function ps(field, pid) {
  return execFileSync("ps", ["-o", `${field}=`, "-p", String(pid)], { encoding: "utf8" }).trim();
}

// hook 是 claude 的子程序（中間可能隔一層 shell）：往上找第一個有 tty 的祖先
function findTty() {
  let pid = process.ppid;
  for (let i = 0; i < 6 && pid > 1; i++) {
    const tty = ps("tty", pid);
    if (tty && tty !== "??") return { tty: tty.startsWith("/dev/") ? tty : `/dev/${tty}`, pid };
    pid = Number(ps("ppid", pid));
  }
  return null;
}

function osa(script) {
  return execFileSync("osascript", ["-e", script], { encoding: "utf8", timeout: 5000 }).trim();
}

function tabDo(tty, body) {
  return osa(`tell application "Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is "${tty}" then
        ${body}
      end if
    end repeat
  end repeat
end tell`);
}

// iTerm2：對那格的 tty 寫跳脫序列（標籤色＋底色）。end 時還原成設定檔原本的樣子。
async function itermPaint(tty, state) {
  const IT = await import("../tools/iterm.mjs");
  const seq = state === "end"
    ? IT.seqTab(null) + IT.seqBg(null) + IT.seqBadge("")
    : IT.seqTab(IT.tabColor(ACCT)) + IT.seqBg(IT.bgColor(ACCT));
  const fd = openSync(tty, "w");
  try { writeSync(fd, seq); } finally { closeSync(fd); }
}

async function main() {
  let input = {};
  try { input = JSON.parse(readFileSync(0, "utf8") || "{}"); } catch {}
  const found = findTty();
  if (!found) return;
  const { tty, pid } = found;
  mkdirSync(DIR, { recursive: true });
  const file = join(DIR, basename(tty) + ".json");
  let prev = {};
  try { prev = JSON.parse(readFileSync(file, "utf8")); } catch {}

  const colorable = process.platform === "darwin" && process.env.TERM_PROGRAM === "Apple_Terminal";
  if (process.platform === "darwin" && process.env.TERM_PROGRAM === "iTerm.app") {
    try { await itermPaint(tty, STATE); } catch {}
  }
  let profile = prev.profile;
  let bg = prev.bg;
  // 2026-10-11 改成**每次都對到該有的顏色**，不再靠「偵測換帳號」：
  // 舊寫法只在工作中偵測 prev.account 變了才重上色，而在等待狀態裡 /login 時，
  // 帳號先被記成新的、顏色卻沒換，之後就再也偵測不到（~/.claude-work 登成 XXXXX 後一直是 Ocean）。
  // 2026-10-11 使用者裁示：**所有跑 claude 的分頁都配色**（不只 quad／面板開的）。
  // 本來不是帳號配色的分頁，第一次上色前記下原本的設定檔（orig），SessionEnd 時還原。
  const ours = () => Boolean(ACCT);
  const mine = () => [ACCT.colors.work_profile, ACCT_BG];
  let orig = prev.orig || null;
  const remember = (cur) => { if (!orig && cur && !WORK_PROFILES.has(cur)) orig = cur; };

  if (colorable) {
    try {
      if (WAIT.has(STATE)) {
        // 從非等待進來：先記下工作色，離開等待時套回去
        if (!WAIT.has(prev.state)) {
          profile = tabDo(tty, `return name of current settings of t`) || DEFAULT_PROFILE;
          remember(profile);
          bg = tabDo(tty, `return background color of t`) || null;   // 例如 "6447, 7462, 10000"
        }
        // 要套回去的是**現在這個帳號**的工作色（等待中 /login 換了帳號也對）
        if (ours(profile)) [profile, bg] = mine();
        // 每次都上等待色（便宜），等待中換帳號時顏色跟著換
        tabDo(tty, `set background color of t to ${COLORS[STATE]}`);
      } else if (STATE === "end") {
        // claude 結束：原本不是帳號配色的分頁還原；本來就是帳號配色的（quad／面板開的）留著
        if (orig) tabDo(tty, `set current settings of t to settings set "${orig}"`);
      } else if (WAIT.has(prev.state)) {
        // 離開等待：套回工作色（連帶把底色換回來）
        if (ours(profile)) [profile, bg] = mine();
        tabDo(tty, `set current settings of t to settings set "${profile || DEFAULT_PROFILE}"`);
        // 底色若是蓋在設定檔上的（自動配色的帳號），再蓋回去
        if (bg) tabDo(tty, `set background color of t to {${bg}}`);
      } else {
        // 工作中：設定檔是我們上的、但不是這個帳號的 → 換成這個帳號的
        const cur = tabDo(tty, `return name of current settings of t`);
        remember(cur);
        if (ours(cur) && cur !== ACCT.colors.work_profile) {
          [profile, bg] = mine();
          tabDo(tty, `set current settings of t to settings set "${profile}"`);
          if (bg) tabDo(tty, `set background color of t to {${bg}}`);
        }
      }
    } catch {}
  }

  if (STATE === "end") {
    if (existsSync(file)) unlinkSync(file);
    return;
  }

  const now = new Date().toISOString();
  writeFileSync(file, JSON.stringify({
    tty,
    pid,
    state: STATE,
    since: prev.state === STATE ? prev.since : now,
    updated: now,
    cwd: input.cwd || process.cwd(),
    session: input.session_id || prev.session || "",
    account: ACCT?.id || "?",
    label: ACCT?.label || "",
    profile,
    bg,
    orig,
    message: input.message || "",
  }, null, 2));
}

try { await main(); } catch {}
