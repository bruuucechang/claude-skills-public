#!/usr/bin/env node
/**
 * SessionStart hook —— 每天查一次「有什麼東西該更新了」，有才講、沒有就一個字不注。
 *
 * ## 為什麼要有
 *
 * 2026-09-26 使用者打了一個字「update」，掃下去發現：
 *
 *   - brew 有 **20 個**套件過期，含 `git`（落後 5 個小版本）、`node`（落後一個大版本）
 *   - Claude Code 停在 2.1.223（8/6 裝的），`~/.local/share/claude/versions/` 裡
 *     從頭到尾只有那一個檔 —— **自動更新七週一次都沒成功過**。根因是
 *     `~/.claude.json` 的 `installMethod` 寫 `global` 但實際跑的是 native，
 *     更新程序照著 config 去戳一個不存在的 npm 安裝（那次 `claude update` 已修正）
 *
 * 他問「為什麼沒有提醒我更新」。答案是**沒有任何東西在看**：crontab 只有
 * 07:20 那行 `caffeinate`，16 個 launchd job 沒一個查版本，`brew autoupdate` 沒裝，
 * 而我只在被叫起來的時候存在、不在背景監看。這支就是那條缺掉的機制——
 * 「規則是請求，機制才是保證」。
 *
 * ## 絕對不能阻塞開場
 *
 * 真正的檢查要 `brew update`（打網路）＋ 13 個 repo 的 `git fetch`，加起來十幾秒。
 * 那個成本掛在 session 開場等於每次開 session 都罰站。所以拆成兩半：
 *
 *   - **hook 本身**只讀快取檔，純本地讀檔，微秒級
 *   - 快取過期時**另外 fork 一個脫離的程序**去重算，`unref()` 之後 hook 立刻退出
 *
 * 也就是說你看到的永遠是「最多一天前」的結果，這對「有沒有東西該升級」夠用了。
 * 代價寫清楚：剛升級完的那個 session 還是會看到舊訊息，隔天才會消失。
 *
 * ## 沒事就零 context 成本
 *
 * 三項全乾淨 → 完全不輸出。這支每個 session 都會跑，自己就是固定成本，
 * 所以「沒事的時候安靜」是硬需求，不是禮貌。
 *
 * 逃生門：`touch ~/.claude/skills/home/claude/hooks/update-check.off`
 * 手動重算：`node ~/.claude/skills/home/claude/hooks/update-check.mjs --refresh`
 * 看快取：  `cat ~/.claude/cache/update-check.json`
 */

import { execFileSync } from 'node:child_process';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, unlinkSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cli, isMain } from './lib/hook-cli.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const OFF = join(HERE, 'update-check.off');

// 這三個環境變數只為了「能實測」而存在。三項全乾淨時這支完全不輸出，
// 而「沒東西過期」跟「檢查根本壞了」長得一模一樣——沒有接縫就驗不了它。
const CACHE_DIR = process.env.UPDATE_CHECK_CACHE_DIR || join(homedir(), '.claude', 'cache');
const CACHE = join(CACHE_DIR, 'update-check.json');
const LOCK = join(CACHE_DIR, 'update-check.lock');

/** 快取多久算過期。一天一次——升級這件事沒有更即時的必要。 */
const MAX_AGE_MS = 24 * 60 * 60 * 1000;
/** 重算的鎖多久算是死鎖（程序被砍、機器睡著）。 */
const LOCK_STALE_MS = 30 * 60 * 1000;

const PROJECTS = process.env.UPDATE_CHECK_PROJECTS || join(homedir(), 'Projects');
const BREW = process.env.UPDATE_CHECK_BREW || '/opt/homebrew/bin/brew';
/** 只有這個 owner 的 repo 才查，見 [[only-my-own-repos]]。 */
const OWNER = 'bruuucechang';
/** brew 過期清單裡點名這幾個——天天在用，落後會真的咬到人。 */
const NOTABLE = ['git', 'node', 'gh', 'jq', 'python@3.14', 'postgresql@17', 'ollama', 'ffmpeg'];

function sh(cmd, args, { timeout = 60_000, cwd } = {}) {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', timeout, cwd, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  } catch {
    return null;   // 失敗與「沒東西」在這裡是同一件事：不講話，不要編。
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 重算（跑在脫離的背景程序裡）
// ─────────────────────────────────────────────────────────────────────────────

function checkBrew() {
  if (!existsSync(BREW)) return null;
  // 不先 `brew update` 的話，`brew outdated` 比對的是本地那份可能好幾週沒動的
  // formula 定義 —— 會安靜地回報「沒有東西過期」。
  sh(BREW, ['update', '--quiet'], { timeout: 180_000 });
  const out = sh(BREW, ['outdated', '--quiet'], { timeout: 120_000 });
  if (out === null) return null;
  const pkgs = out.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!pkgs.length) return null;
  const hit = NOTABLE.filter((n) => pkgs.includes(n));
  return { count: pkgs.length, notable: hit.slice(0, 4) };
}

function checkClaude() {
  // 絕對路徑優先：背景程序的 PATH 是繼承來的，別賭它一定找得到 `claude`。
  const bin = join(homedir(), '.local', 'bin', 'claude');
  const local = sh(existsSync(bin) ? bin : 'claude', ['--version'], { timeout: 30_000 });
  const cur = local?.match(/(\d+\.\d+\.\d+)/)?.[1];
  if (!cur) return null;

  const body = sh('/usr/bin/curl', [
    '-sS', '--max-time', '20',
    'https://registry.npmjs.org/@anthropic-ai/claude-code/latest',
  ], { timeout: 30_000 });
  if (!body) return null;

  let latest;
  try { latest = JSON.parse(body)?.version; } catch { return null; }
  if (!latest || latest === cur) return null;

  // 只在真的落後時講話。相等、或本地比 registry 新（預發版），都算乾淨。
  const cmp = (a, b) => {
    const x = a.split('.').map(Number), y = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0);
    return 0;
  };
  if (cmp(cur, latest) >= 0) return null;
  return { cur, latest };
}

function checkRepos() {
  if (!existsSync(PROJECTS)) return null;
  const behind = [];
  let names;
  try { names = readdirSync(PROJECTS); } catch { return null; }

  for (const name of names) {
    const dir = join(PROJECTS, name);
    if (!existsSync(join(dir, '.git'))) continue;

    const url = sh('git', ['-C', dir, 'remote', 'get-url', 'origin'], { timeout: 15_000 });
    if (!url) continue;
    // 只認 bruuucechang 底下的，別人的 repo 不歸我管也不該被我 fetch。
    if (!new RegExp(`[:/]${OWNER}/`).test(url)) continue;

    if (sh('git', ['-C', dir, 'fetch', '--quiet', 'origin'], { timeout: 90_000 }) === null) continue;
    const n = sh('git', ['-C', dir, 'rev-list', '--count', 'HEAD..@{u}'], { timeout: 15_000 });
    const count = Number(n);
    if (Number.isFinite(count) && count > 0) behind.push({ name, count });
  }

  if (!behind.length) return null;
  behind.sort((a, b) => b.count - a.count);
  return behind;
}

function refresh() {
  mkdirSync(CACHE_DIR, { recursive: true });

  // 鎖：重算要十幾秒，同時開兩個 session 會撞在一起。死鎖自動過期。
  if (existsSync(LOCK)) {
    let age = Infinity;
    try { age = Date.now() - statSync(LOCK).mtimeMs; } catch {}
    if (age < LOCK_STALE_MS) return;
    try { unlinkSync(LOCK); } catch {}
  }
  try { writeFileSync(LOCK, String(process.pid)); } catch {}

  try {
    const data = { t: Date.now(), brew: checkBrew(), claude: checkClaude(), repos: checkRepos() };
    const tmp = `${CACHE}.tmp`;
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, CACHE);          // 原子寫入，讀的那邊不會看到半個檔
  } finally {
    try { unlinkSync(LOCK); } catch {}
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// hook 本身（只讀快取）
// ─────────────────────────────────────────────────────────────────────────────

function render(d) {
  const parts = [];

  if (d.brew?.count) {
    const tail = d.brew.notable?.length ? `（含 ${d.brew.notable.join('、')}）` : '';
    parts.push(`brew 有 ${d.brew.count} 個套件可升級${tail}`);
  }
  if (d.claude?.latest) {
    parts.push(`Claude Code ${d.claude.cur} → ${d.claude.latest} 可更新`
      + `（自動更新壞過一次，這行出現代表可能又壞了，順手跑 \`claude doctor\`）`);
  }
  if (d.repos?.length) {
    const top = d.repos.slice(0, 4).map((r) => `${r.name} +${r.count}`).join('、');
    const ellipsis = d.repos.length > 4 ? '…' : '';
    parts.push(`${d.repos.length} 個專案落後 origin：${top}${ellipsis}（別台機器推了這台沒拉）`);
  }
  if (!parts.length) return null;

  const age = Math.round((Date.now() - (d.t || 0)) / 3_600_000);
  return `【每日更新檢查】${parts.join('；')}。`
    + `（${age} 小時前量的，由 update-check hook 在背景更新）`
    + `使用者沒提就不要主動跑升級——這只是讓你知道，他打「update」時你才動手。`;
}

export function run(p) {
  if (existsSync(OFF)) return null;

  // `compact`/`resume` 的前文裡本來就有；`clear` 是使用者主動要乾淨的。
  if ((p?.source ?? 'startup') !== 'startup') return null;

  let data = null;
  let age = Infinity;
  try {
    data = JSON.parse(readFileSync(CACHE, 'utf8'));
    age = Date.now() - (data?.t || 0);
  } catch {}

  // 過期就派一個脫離的程序去重算，然後**立刻**往下走——不等它。
  if (age > MAX_AGE_MS) {
    try {
      spawn(process.execPath, [SELF, '--refresh'], { detached: true, stdio: 'ignore' }).unref();
    } catch {}
  }

  if (!data) return null;
  const msg = render(data);
  if (!msg) return null;

  return {
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: msg },
  };
}

if (isMain(import.meta.url)) {
  if (process.argv.includes('--refresh')) refresh();
  else cli(run);
}
