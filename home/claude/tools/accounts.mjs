// accounts.mjs — 多帳號清單的共用程式庫（2026-10-06）。
//
// 清單在 ../accounts/<LocalHostName>.json，一台機器一份。讀它的有：
//   home/bin/acct（AgentQuota 面板經由 acct status --json）、home/bin/quad、
//   hooks/pane-state.mjs、hooks/account-check.mjs
//
// 「這個設定目錄現在實際登的是誰」的三個來源，可信度由高到低：
//   1. Keychain 的 rateLimitTier（`Claude Code-credentials[-<sha256(路徑)前 8 碼>]`）
//      ——/login 寫的就是這裡，被蓋掉時第一個變
//   2. `claude auth status --json` 的 email（要開一個 node 程序，約 1 秒，只給 doctor 用）
//   3. <設定目錄>/.claude.json 的 oauthAccount.emailAddress（快取，下次啟動才會更新）
// 開場檢查與選單列只用 1＋3（要快）；`acct doctor` 三個都看。
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const HOME = homedir();
export const DEFAULT_DIR = join(HOME, ".claude");

export function hostName() {
  try { return execFileSync("/usr/sbin/scutil", ["--get", "LocalHostName"], { encoding: "utf8" }).trim(); }
  catch { return "unknown"; }
}

export function registryPath() {
  return process.env.ACCT_REGISTRY || resolve(HERE, "..", "accounts", `${hostName()}.json`);
}

export function expand(p) {
  return resolve(p.replace(/^~(?=$|\/)/, HOME));
}

export function load() {
  const p = registryPath();
  if (!existsSync(p)) return { path: p, data: { accounts: [] }, accounts: [] };
  const data = JSON.parse(readFileSync(p, "utf8"));
  return { path: p, data, accounts: data.accounts.map((a) => ({ ...a, dir: expand(a.config_dir) })) };
}

export function save(data) {
  writeFileSync(registryPath(), JSON.stringify(data, null, 2) + "\n");
}

export function find(accounts, key) {
  const k = String(key || "").toLowerCase();
  return accounts.find((a) => a.id === k || (a.aliases || []).includes(k));
}

// 依目前環境的 CLAUDE_CONFIG_DIR 找帳號（沒設＝預設 ~/.claude）
export function current(accounts, env = process.env) {
  const dir = expand(env.CLAUDE_CONFIG_DIR || DEFAULT_DIR);
  return accounts.find((a) => a.dir === dir) || null;
}

// 這個設定目錄**現在實際登的是**清單上哪個帳號；沒登入、token 被清空、登的人不在清單上 → null。
// 2026-10-10 使用者裁示：「登入哪個帳號就回報哪個帳號」——目錄屬於誰一律看實際登入，
// 清單上的 config_dir 只是「這個帳號平常開在哪、安全登入寫到哪」，**不拿來判斷對錯**。
// 判斷順序：Keychain tier（/login 第一個寫的）唯一對得上就是它；多個帳號同 tier 時比 .claude.json 的 email。
export function actual(accounts, dir) {
  const d = expand(dir);
  const cred = credential(d);
  if (!cred.tier || !cred.hasToken) return null;
  const email = cachedEmail(d);
  const sameTier = accounts.filter((a) => a.tier === cred.tier);
  if (sameTier.length === 1) return sameTier[0];
  const pool = sameTier.length ? sameTier : accounts;
  return pool.find((a) => email && a.email === email) || null;
}

// 同 current()，但回傳實際登入的那個帳號（判斷不出來就退回目錄的預設帳號，只給配色用）
export function currentActual(accounts, env = process.env) {
  return actual(accounts, env.CLAUDE_CONFIG_DIR || DEFAULT_DIR) || current(accounts, env);
}

// 這台有哪些設定目錄（清單上各帳號的 config_dir，去重）
export function configDirs(accounts) {
  const seen = new Map();
  for (const a of accounts) if (!seen.has(a.dir)) seen.set(a.dir, a.config_dir);
  return [...seen].map(([dir, config_dir]) => ({ dir, config_dir }));
}

// 帳號 a 現在可以用哪個目錄開：平常那個目錄登的就是它 → 那個；否則任何登著它的目錄；都沒有 → null
export function dirFor(accounts, a) {
  if (actual(accounts, a.dir)?.id === a.id) return a.dir;
  return configDirs(accounts).map((x) => x.dir).find((d) => actual(accounts, d)?.id === a.id) || null;
}

export function keychainService(dir) {
  if (expand(dir) === DEFAULT_DIR) return "Claude Code-credentials";
  return "Claude Code-credentials-" + createHash("sha256").update(expand(dir)).digest("hex").slice(0, 8);
}

// Keychain 裡這個設定目錄的憑證：{ tier, mdat } 或 null（沒登入）
export function credential(dir) {
  const svc = keychainService(dir);
  try {
    const raw = execFileSync("/usr/bin/security", ["find-generic-password", "-w", "-s", svc], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
    const o = JSON.parse(raw).claudeAiOauth || {};
    let mdat = null;
    try {
      const meta = execFileSync("/usr/bin/security", ["find-generic-password", "-s", svc], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
      const m = meta.match(/"mdat"<timedate>=0x[0-9A-F]+\s+"(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)(\d\d)Z/);
      if (m) mdat = new Date(Date.UTC(+m[1], m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
    } catch {}
    // ⚠ 只看 tier 不夠（2026-10-06 實測）：續期失敗時 Claude Code 會把兩個 token 清成空字串，
    //   tier 與 subscriptionType 卻原封不動留著——看起來是「登著 Max 20×」，實際上是登出狀態。
    return { service: svc, tier: o.rateLimitTier || null, subscription: o.subscriptionType || null, mdat,
             hasToken: Boolean(o.refreshToken || o.accessToken) };
  } catch {
    return { service: svc, tier: null, mdat: null };
  }
}

export function cachedEmail(dir) {
  const f = expand(dir) === DEFAULT_DIR ? join(HOME, ".claude.json") : join(expand(dir), ".claude.json");
  try { return JSON.parse(readFileSync(f, "utf8")).oauthAccount?.emailAddress || null; } catch { return null; }
}

export function liveEmail(dir) {
  try {
    const out = execFileSync("claude", ["auth", "status", "--json"], {
      encoding: "utf8", timeout: 20000, stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, CLAUDE_CONFIG_DIR: expand(dir) },
    });
    const j = JSON.parse(out);
    return j.loggedIn ? j.email : null;
  } catch { return undefined; }   // undefined＝查不到（跟「沒登入」的 null 分開）
}

// 這個帳號現在開著幾個 session：<設定目錄>/sessions/<pid>.json 而 pid 還活著
export function sessions(dir) {
  const d = join(expand(dir), "sessions");
  let n = 0;
  try {
    for (const f of readdirSync(d)) {
      const m = f.match(/^(\d+)\.json$/);
      if (!m) continue;
      try { process.kill(+m[1], 0); n++; } catch {}
    }
  } catch {}
  return n;
}

// 一個設定目錄的現況。**只有「這個目錄不能用」才是 problems**（目錄不存在、沒登入、token 被清空）；
// 登的是誰都不算問題（2026-10-10 拿掉「登錯帳號」）。live=true 時多問一次 claude auth status（慢）。
export function dirState(dir, accounts, { live = false } = {}) {
  const d = expand(dir);
  const cred = credential(d);
  const problems = [];
  if (!existsSync(d)) problems.push("設定目錄不存在");
  else if (!cred.tier) problems.push("沒有登入（Keychain 沒有這個目錄的憑證）");
  else if (!cred.hasToken) problems.push("憑證已被清空（token 是空的，通常是續期失敗）——等於登出");
  let email = cachedEmail(d);
  if (live) { const le = liveEmail(d); if (le !== undefined) email = le; }
  return { dir: d, cred, email, account: problems.length ? null : actual(accounts, d), problems, sessions: sessions(d) };
}

// ---- 顏色 -------------------------------------------------------------

// Terminal 的 AppleScript 顏色是 0–65535（8 位元值 × 257）
export function osaColor(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "");
  if (!m) return null;
  return "{" + [m[1], m[2], m[3]].map((h) => parseInt(h, 16) * 257).join(", ") + "}";
}

// 第三個以後的帳號自動配色（使用者裁示：自動分配不問）。依序取還沒被用過的色系。
// 全部深色：Basic Clear 的字是淺色。
export const PALETTE = [
  { family: "綠", tab: "#2E8B57", work_profile: "Basic Clear", work_bg: "#123A22", ask: "#2E6A00", done: "#00504A" },
  { family: "紫", tab: "#8E44AD", work_profile: "Basic Clear", work_bg: "#2E1A40", ask: "#6A1A6A", done: "#3A2A7A" },
  { family: "灰", tab: "#7F8C8D", work_profile: "Basic Clear", work_bg: "#2A2A2A", ask: "#5A3A3A", done: "#3A4A5A" },
  { family: "褐", tab: "#A0522D", work_profile: "Basic Clear", work_bg: "#3A2A18", ask: "#7A4A1A", done: "#4A4A2A" },
];

export function nextColors(accounts) {
  const used = new Set(accounts.map((a) => a.colors?.family));
  return PALETTE.find((p) => !used.has(p.family)) || PALETTE[accounts.length % PALETTE.length];
}

// 給 shell 用：node accounts.mjs get <id> <欄位>
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, id, field] = process.argv.slice(2);
  const { accounts } = load();
  const pick = (a) => field.split(".").reduce((o, k) => (o == null ? o : o[k]), a);
  if (cmd === "get" || cmd === "dir-for") {
    const a = find(accounts, id);
    if (!a) { console.error(`清單上沒有帳號：${id}`); process.exit(2); }
    if (cmd === "dir-for") {
      // 現在登著 <id> 的目錄；這台沒有任何目錄登它 → exit 3
      const d = dirFor(accounts, a);
      if (!d) { console.error(`這台沒有任何設定目錄登 ${id}，先 acct login ${id}`); process.exit(3); }
      console.log(d);
    } else console.log(pick(a) ?? "");
  } else if (cmd === "get-for-dir") {
    // get-for-dir <目錄> <欄位>：那個目錄實際登入的帳號的欄位（配色用）
    const a = actual(accounts, id) || accounts.find((x) => x.dir === expand(id));
    console.log((a && pick(a)) ?? "");
  } else {
    console.error("用法：accounts.mjs get <id> <欄位> | dir-for <id> | get-for-dir <目錄> <欄位>");
    process.exit(2);
  }
}
