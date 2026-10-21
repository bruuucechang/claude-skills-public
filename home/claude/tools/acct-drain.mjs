// acct-drain — 一個 Claude 帳號的週額度快用完時，把它上面的 session 逐步換到另一個帳號（2026-10-21）。
//
// 使用者裁示（2026-10-21）：「bruce 帳號用到 90 就先停下，改用 peter 的」；
//   看的是**週窗**；到了之後每個 bruce session 做完手上這一步就寫交接單，同一格改用 peter 開新 session 接著做；
//   「現在就可以逐步交接了」→ 週窗還沒到 90 之前也先開始換（提前開關，見 FLAG）。
//
// 判斷只在這裡做，hook（hooks/account-drain.mjs）與 handoff-open 都問這支：
//   drainFor(configDir) → null（不用換）或 { from, to, reason, pct }
//
//   node acct-drain.mjs                  印出這台每個帳號現在換不換、為什麼
//   node acct-drain.mjs on [到期時間]     提前開始換（預設到 bruce 週窗重置）
//   node acct-drain.mjs off              關掉提前開關（週窗 ≥ 90 照樣會換）
//
// 額度來源：AgentQuota 選單列 app 的快取 last-state.json（每分鐘左右更新，不連網）。
// 讀不到或過期超過 STALE_MIN 分鐘 → 當作不知道、不換（不知道不等於滿了，也不等於沒滿；寧可少換）。
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as A from "./accounts.mjs";

export const RULES = [{ from: "bruce", to: "peter", weekly: 90 }];
export const TO_LIMIT = 95;   // 要換過去的那個帳號自己也快滿了就不換
export const STALE_MIN = 30;
export const CACHE = join(A.HOME, "Library/Application Support/agent-quota/last-state.json");
export const FLAG = join(A.HOME, ".claude/state/acct-drain.json");

const readJson = (p) => { try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; } };

// 帳號 id → 週窗百分比。那個帳號自己 stale 就是 undefined（不知道）；週窗已經過了重置時間但還沒新觀測 → 0。
export function quotas(cache = CACHE, now = Date.now()) {
  const c = readJson(cache);
  if (!c?.state?.accounts || now - Number(c.at) > STALE_MIN * 60_000) return null;
  return Object.fromEntries(c.state.accounts.map((a) => {
    const w = a.weekly;
    const pct = a.stale || w?.percent == null ? undefined : Number(w.resets_at) < now ? 0 : w.percent;
    return [a.id, { weekly: { percent: pct, resets_at: w?.resets_at } }];
  }));
}

export function flag(path = FLAG, now = Date.now()) {
  const f = readJson(path);
  return f && Date.parse(f.until) > now ? f : null;
}

// 給 configDir（預設 ~/.claude）回答：這個目錄登的帳號要不要換、換到哪。
// 先只看額度快取（不碰 Keychain），有規則可能成立才去問 Keychain 這個目錄實際登誰——hook 每回合都會呼叫這支。
export function drainFor(configDir, { accounts = A.load().accounts, q = quotas(), f = flag() } = {}) {
  if (!q) return null;
  const live = RULES.filter((r) => {
    const from = A.find(accounts, r.from), to = A.find(accounts, r.to);
    const pct = q[from?.quota_id]?.weekly?.percent, toPct = q[to?.quota_id]?.weekly?.percent;
    // 目標帳號的額度不知道就不換（不知道不等於有剩）
    return from && to && toPct != null && toPct < TO_LIMIT && (pct >= r.weekly || f?.from === r.from);
  });
  if (!live.length) return null;
  const me = A.actual(accounts, configDir || A.DEFAULT_DIR);
  const rule = me && live.find((r) => r.from === me.id);
  if (!rule) return null;
  const to = A.find(accounts, rule.to);
  const toDir = A.dirFor(accounts, to);
  if (!toDir) return null;
  const pct = q[me.quota_id]?.weekly?.percent;
  const toPct = q[to.quota_id]?.weekly?.percent;
  const reason = pct >= rule.weekly
    ? `${me.id} 週額度 ${pct}%（門檻 ${rule.weekly}%）`
    : `使用者要求提前開始換（${me.id} 週額度 ${pct ?? "?"}%，${f.until} 前有效）`;
  return { from: me.id, to: to.id, toDir, reason, pct, toPct };
}

// handoff-open 換得了帳號的地方：iTerm2 的互動 session（不在 tmux）。
// claude -p 會繼承父 session 的 ITERM_SESSION_ID，換手會把 /exit 打進父 session，所以要排除。
// handoff-open 與 hook 共用這一支，兩邊對「換得了」的判斷才不會分岔。
const ps = (f, pid) => { try { return execFileSync("ps", ["-o", `${f}=`, "-p", String(pid)], { encoding: "utf8" }).trim(); } catch { return ""; } };
export const isClaude = (pid) => !!pid && /(^|\/)claude$/.test(ps("comm", pid));
// 往上找跑著我們的那個 claude（Bash 工具 → shell → claude；hook → claude）
export function claudeAncestor(startPid = process.ppid) {
  let pid = startPid;
  for (let i = 0; i < 8 && pid > 1; i++) {
    if (isClaude(pid)) return pid;
    pid = Number(ps("ppid", pid));
  }
  return null;
}
export const isPrint = (pid) => /(^|\s)(-p|--print)(\s|$)/.test(ps("args", pid));
export function canSwitchHere(env = process.env, pid) {
  if (env.TMUX || env.TERM_PROGRAM !== "iTerm.app" || !env.ITERM_SESSION_ID) return false;
  pid ??= claudeAncestor();   // env 不符就不必往上找（最多 16 次 ps）
  return !!pid && !isPrint(pid);
}

function main(argv) {
  const { accounts } = A.load();
  const q = quotas();
  if (argv[0] === "on") {
    const from = RULES[0].from;
    const reset = q?.[A.find(accounts, from)?.quota_id]?.weekly?.resets_at;
    const until = argv[1] ? new Date(argv[1]) : new Date(reset || Date.now() + 7 * 864e5);
    if (isNaN(until)) { console.error(`看不懂的時間：${argv[1]}（用 ISO 格式，例如 2026-10-25T00:00+08:00）`); process.exit(2); }
    mkdirSync(dirname(FLAG), { recursive: true });
    writeFileSync(FLAG, JSON.stringify({ from, until: until.toISOString(), set: new Date().toISOString() }, null, 2) + "\n");
    console.log(`提前開關已開：${from} 的 session 逐步換走，到 ${until.toISOString()}`);
    return;
  }
  if (argv[0] === "off") { if (existsSync(FLAG)) unlinkSync(FLAG); console.log("提前開關已關"); return; }
  if (!q) console.log(`讀不到額度快取或已過期 ${STALE_MIN} 分鐘以上：${CACHE}（不換）`);
  const f = flag();
  console.log(`提前開關：${f ? `開（${f.from}，到 ${f.until}）` : "關"}`);
  for (const d of A.configDirs(accounts)) {
    const r = drainFor(d.dir, { accounts, q, f });
    const who = A.actual(accounts, d.dir)?.id || "?";
    console.log(`${d.config_dir}（${who}）：${r ? `換到 ${r.to} — ${r.reason}` : "不換"}`);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main(process.argv.slice(2));
