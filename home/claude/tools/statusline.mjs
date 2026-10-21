#!/usr/bin/env node
// statusline.mjs — Claude Code 底部狀態列（2026-10-12，規格 ~/Projects/office/docs/spec-2026-10-12-claude-workflow.md）。
//
// 兩行：帳號@機器 │ 專案 ⎇分支 ●未commit ↑未push
//       模型 $用量 │ ctx 42%
// context 60% 變黃、80% 變紅：該寫交接單（/handoff）了。
//
// 狀態列每次對話更新都會跑，所以慢的東西都快取在 $TMPDIR：
//   帳號（要問 Keychain，~100ms）60 秒、git 5 秒。單次執行目標 < 100ms。
// 重跑／測試：echo '{"model":{"display_name":"Opus"},"workspace":{"current_dir":"'$PWD'"},"context_window":{"used_percentage":65}}' | node statusline.mjs
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, statSync, openSync, readSync, closeSync, mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";

const C = { dim: "\x1b[2m", reset: "\x1b[0m", yellow: "\x1b[33m", red: "\x1b[31m", green: "\x1b[32m", cyan: "\x1b[36m" };
const SEP = ` ${C.dim}│${C.reset} `;

function cacheFile(key) {
  return join(tmpdir(), "claude-statusline-" + createHash("sha1").update(key).digest("hex").slice(0, 12) + ".json");
}

function cached(key, ttlMs, fn) {
  const hit = readCache(key, ttlMs);
  if (hit !== undefined) return hit;
  const v = fn();
  try { writeFileSync(cacheFile(key), JSON.stringify(v)); } catch {}
  return v;
}

function sh(cmd, args, cwd) {
  try { return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 1500 }).trim(); }
  catch { return null; }
}

function readCache(key, ttlMs) {
  try {
    const f = cacheFile(key);
    if (Date.now() - statSync(f).mtimeMs < ttlMs) return JSON.parse(readFileSync(f, "utf8"));
  } catch {}
  return undefined;
}

async function account() {
  const key = "acct:" + (process.env.CLAUDE_CONFIG_DIR || "~/.claude");
  const hit = readCache(key, 60_000);
  if (hit) return hit;
  let id = null, host = null;
  try {
    const A = await import("./accounts.mjs");
    host = A.hostName();
    id = A.currentActual(A.load().accounts)?.id ?? null;
  } catch {}
  // 「BruuuceMacdeMacBook-Air」→「Air」：狀態列只要認得出哪台
  host = (host || sh("hostname", ["-s"]) || "?").replace(/^.*MacBook-?/i, "");
  const v = { id: id || "?", host };
  try { writeFileSync(cacheFile(key), JSON.stringify(v)); } catch {}
  return v;
}

function git(cwd) {
  return cached("git:" + cwd, 5_000, () => {
    const branch = sh("git", ["rev-parse", "--abbrev-ref", "HEAD"], cwd);
    if (!branch) return null;
    const root = sh("git", ["rev-parse", "--show-toplevel"], cwd);
    const dirty = (sh("git", ["status", "--porcelain", "-uno"], cwd) || "").split("\n").filter(Boolean).length;
    const ahead = Number(sh("git", ["rev-list", "--count", "@{u}..HEAD"], cwd) || 0);
    return { branch, root, dirty, ahead };
  });
}

// 舊版 Claude Code 沒有 context_window.used_percentage：從 transcript 最後一則回覆的 usage 自己算
function contextPct(input) {
  const cw = input.context_window || {};
  if (typeof cw.used_percentage === "number") return cw.used_percentage;
  const size = cw.context_window_size || (/\[1m\]|1m/i.test(input.model?.id || "") ? 1_000_000 : 200_000);
  const tp = input.transcript_path;
  if (!tp || !existsSync(tp)) return null;
  try {
    const fd = openSync(tp, "r");
    const len = statSync(tp).size, n = Math.min(len, 256 * 1024);
    const buf = Buffer.alloc(n);
    readSync(fd, buf, 0, n, len - n);
    closeSync(fd);
    const lines = buf.toString("utf8").split("\n").reverse();
    for (const l of lines) {
      if (!l.includes('"usage"')) continue;
      try {
        const u = JSON.parse(l).message?.usage;
        if (!u) continue;
        const used = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
        return (used / size) * 100;
      } catch {}
    }
  } catch {}
  return null;
}

function colorPct(p) {
  const s = `ctx ${Math.round(p)}%`;
  if (p >= 80) return C.red + s + C.reset;
  if (p >= 60) return C.yellow + s + C.reset;
  return C.green + s + C.reset;
}

async function main() {
  let raw = "";
  for await (const chunk of process.stdin) raw += chunk;
  let input = {};
  try { input = JSON.parse(raw || "{}"); } catch {}
  const cwd = input.workspace?.current_dir || input.cwd || process.cwd();
  const parts = [];

  const a = await account();
  parts.push(`${a.id}@${a.host}`);  // 不上色：上色時 Claude Code 會把顏色碼漏成「peter;153;153m@Air」（2026-10-21）

  const g = git(cwd);
  if (g) {
    // 分支名太長會把整排撐爆（feature/dataviz-tufte-skills 這種），超過 24 字留頭尾
    const br = g.branch.length > 24 ? g.branch.slice(0, 12) + '…' + g.branch.slice(-10) : g.branch;
    let s = `${basename(g.root || cwd)} ⎇${br}`;
    if (g.dirty) s += ` ${C.yellow}●${g.dirty}${C.reset}`;
    if (g.ahead) s += ` ${C.yellow}↑${g.ahead}${C.reset}`;
    parts.push(s);
  } else parts.push(basename(cwd));

  let m = input.model?.display_name || input.model?.id || "?";
  const cost = input.cost?.total_cost_usd;
  if (typeof cost === "number") m += ` ${C.dim}$${cost.toFixed(2)}${C.reset}`;
  const five = input.rate_limits?.five_hour?.used_percentage;
  if (typeof five === "number") m += ` ${C.dim}5h ${Math.round(five)}%${C.reset}`;
  parts.push(m);

  const p = contextPct(input);
  if (p != null) parts.push(colorPct(p));
  // 給手機的 session-remote 看每個 session 用了多少 context（它讀不到 Claude Code 給狀態列的這個數字）
  if (p != null && input.session_id) {
    try {
      const dir = join(process.env.HOME || "", ".claude", "state", "context");
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, input.session_id + ".json"), JSON.stringify({ pct: Math.round(p), updated: new Date().toISOString() }));
    } catch {}
  }

  // 兩行：輸入框下那排塞不下一整行（2026-10-12 使用者回報），每行 stdout 是一排
  process.stdout.write(parts.slice(0, 2).join(SEP) + '\n' + parts.slice(2).join(SEP));
}

main().catch(() => process.stdout.write("statusline 錯誤"));
