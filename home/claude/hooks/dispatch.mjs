#!/usr/bin/env node
/**
 * dispatch.mjs <事件> —— 每個事件只開一個 node：讀一次 stdin，依事件與 tool_name 把輸入交給各檢查。
 *
 *     node ~/.claude/skills/home/claude/hooks/dispatch.mjs PreToolUse < 輸入.json
 *     node ~/.claude/skills/home/claude/hooks/dispatch.mjs PreToolUse codex < 輸入.json   # Codex 用（~/.codex/hooks.json）
 *
 * ## 為什麼（2026-10-20，規格 optimize-spec.md）
 *
 * 以前 settings.json 每支檢查各掛一個程序：每次 Bash 前開 3 個、SessionStart 開 6 個，
 * 每個 node 冷啟動 20–30ms，作者檢查跟 browser_batch 白名單還是寫在 JSON 裡的長 shell。
 * 現在同步的檢查都在這裡跑；async 的回報（pane-state、session-remote、office、afplay）不擋 Claude，維持獨立掛法。
 *
 * ## 規則
 *
 * - 各檢查是一個模組，`export run(input)` 回 null／物件／字串（約定見 lib/hook-cli.mjs），
 *   單獨執行時也照樣能用。
 * - 第二個參數 `codex` 改用 CODEX_ROUTES：Codex 的輸入欄位跟 Claude 一樣，但只有一部分檢查能搬過去
 *   （哪些沒搬、為什麼見 codex-hooks.md）。Stop 的兩種輸出形狀 merge 本來就都留著。
 * - 單一檢查丟例外或逾時就跳過、記一行 dispatch.log，不拖垮其他檢查。
 *   ⚠ 逾時只攔得住非同步的等待；同步卡住的（execFileSync）要靠它自己的 timeout 參數。
 * - 分派器自己出錯一律 exit 0、不輸出：不能因為這支壞掉擋死所有 session。
 * - 合併：任一 deny 就 deny、理由依序串接；additionalContext／systemMessage 串接；
 *   Stop 的 `decision: block` 任一就 block；sessionTitle 取最後一個。
 *
 * 新增一支檢查：寫成 `export function run(input)` ＋ `if (isMain(import.meta.url)) cli(run)`，
 * 加進下面的 ROUTES，跑 `node test-dispatch.mjs`。
 * 每支花多久：`HOOK_TIMING=1 HOOK_NOLOG=1 node dispatch.mjs <事件> < 輸入.json`（印在 stderr）。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { appendLog } from './lib/log.mjs';
import { readStdin } from './lib/hook-cli.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOG = join(HERE, 'dispatch.log');
const DEFAULT_TIMEOUT = 5000;

/** 不是模組的那一支：開場提醒原本是 `cat` 一個 JSON 檔。 */
const startContext = () => {
  const t = readFileSync(join(HERE, 'session-start-context.txt'), 'utf8');
  try { return JSON.parse(t); } catch { return t; }
};

/** 事件 → 依序要跑的檢查。PreToolUse 再依 tool_name 分。順序就是輸出串接的順序。 */
export const ROUTES = {
  SessionStart: ['session-start-context', 'session-restore', 'blocks-current', 'update-check',
    ['account-check', 8000], 'session-title'],
  UserPromptSubmit: ['context-tier', 'account-drain', 'session-title'],
  Stop: ['ask-with-options', 'lang-guard', 'account-drain', 'session-journal'],
  PreToolUse: {
    Bash: ['git-author-guard', 'commit-message-guard', 'pushq-guard', 'pr-guard', 'focus-guard', 'kill-guard'],
    AskUserQuestion: ['ask-hides-prose'],
    Agent: ['agent-model-guard'],
    Task: ['agent-model-guard'],   // 舊版 Claude Code 的同一個工具
    'mcp__claude-in-chrome__browser_batch': ['browser-batch-guard'],
  },
};

/** Codex 那邊掛的（2026-10-20 H5 以前是逐支直接呼叫，清單照搬）。matcher 已經在 hooks.json 篩過 Bash，這裡不再看 tool_name。 */
export const CODEX_ROUTES = {
  SessionStart: ['session-start-context', 'blocks-current', 'update-check'],
  PreToolUse: ['git-author-guard', 'commit-message-guard', 'pushq-guard', 'pr-guard', 'focus-guard', 'kill-guard'],
  Stop: ['ask-with-options'],
};

export function checksFor(event, input, routes = ROUTES) {
  const r = routes[event];
  if (!r) return [];
  const list = Array.isArray(r) ? r : (r[input?.tool_name] ?? []);
  return list.map((c) => (Array.isArray(c) ? { name: c[0], timeout: c[1] } : { name: c, timeout: DEFAULT_TIMEOUT }));
}

/** 公開版拿掉的檢查（多帳號、iTerm）：檔案不在就當作沒有這支，不記錯誤。其他檢查不見照樣記進 dispatch.log。 */
const OPTIONAL = new Set(['account-check', 'account-drain', 'pane-state']);
const absent = () => null;

async function load(name) {
  if (name === 'session-start-context') return startContext;
  const f = join(HERE, `${name}.mjs`);
  if (OPTIONAL.has(name) && !existsSync(f)) return absent;
  const m = await import(pathToFileURL(f).href);
  return m.run;
}

function withTimeout(p, ms) {
  let t;
  return Promise.race([p, new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`逾時 ${ms}ms`)), ms); })])
    .finally(() => clearTimeout(t));
}

/** 跑一個事件的所有檢查，回傳 [{ name, out }]（壞掉的那支不在裡面）。 */
export async function runChecks(event, input, { log = true, loader = load, checks = checksFor(event, input) } = {}) {
  const results = [];
  for (const { name, timeout } of checks) {
    const t0 = performance.now();
    try {
      const run = await loader(name);
      const out = await withTimeout(Promise.resolve().then(() => run(input)), timeout);
      if (out != null) results.push({ name, out });
      if (process.env.HOOK_TIMING) process.stderr.write(`${name} ${(performance.now() - t0).toFixed(1)}ms\n`);
    } catch (e) {
      if (log) appendLog(LOG, { at: new Date().toISOString(), event, check: name, err: String(e?.message ?? e).slice(0, 300) });
    }
  }
  return results;
}

/** 把各檢查的輸出合成一個。沒有任何東西要說就回 null（不輸出）。 */
export function merge(event, outs) {
  const ctx = [], sys = [], deny = [], block = [];
  let decision = null, title = null;
  for (const o of outs) {
    if (typeof o === 'string') { if (o.trim()) ctx.push(o.trim()); continue; }
    if (!o || typeof o !== 'object') continue;
    if (o.systemMessage) sys.push(o.systemMessage);
    if (o.decision === 'block') block.push(o.reason ?? '');
    const h = o.hookSpecificOutput;
    if (!h) continue;
    if (h.permissionDecision === 'deny') deny.push(h.permissionDecisionReason ?? '');
    else if (h.permissionDecision && !decision) decision = { d: h.permissionDecision, r: h.permissionDecisionReason };
    if (h.additionalContext) ctx.push(h.additionalContext);
    if (h.sessionTitle) title = h.sessionTitle;
  }
  const out = {};
  if (block.length) { out.decision = 'block'; out.reason = block.join('\n\n'); }
  if (sys.length) out.systemMessage = sys.join('\n');
  const h = {};
  if (deny.length) { h.permissionDecision = 'deny'; h.permissionDecisionReason = deny.join('\n\n'); }
  else if (decision) { h.permissionDecision = decision.d; if (decision.r) h.permissionDecisionReason = decision.r; }
  if (ctx.length) h.additionalContext = ctx.join('\n\n');
  if (title) h.sessionTitle = title;
  if (Object.keys(h).length) out.hookSpecificOutput = { hookEventName: event, ...h };
  return Object.keys(out).length ? out : null;
}

async function main() {
  // 最後一道保險：整支卡住就安靜離開（不輸出＝放行），不要讓 Claude 等到 hook 的 timeout。
  setTimeout(() => process.exit(0), 12_000).unref();
  let input;
  try { input = JSON.parse(await readStdin()); } catch { process.exit(0); }
  const event = process.argv[2] || input?.hook_event_name;
  const routes = process.argv[3] === 'codex' ? CODEX_ROUTES : ROUTES;
  const results = await runChecks(event, input, { checks: checksFor(event, input, routes) });
  const outs = results.map((r) => r.out);
  // config.json 壞掉時讀設定的檢查全部退回「不動作」，開場講一次，不要安靜關掉
  if (event === 'SessionStart') {
    const { config } = await import('./lib/config.mjs');
    if (config().error) outs.push({ systemMessage: `⚠ config.json 讀不懂，git 作者／直推／語言檢查都停了：${config().error}` });
  }
  const out = merge(event, outs);
  if (out) process.stdout.write(JSON.stringify(out));
  process.exit(0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main().catch(() => process.exit(0));
