#!/usr/bin/env node
/**
 * 找出 CLAUDE.md 裡提到、但實際上不存在的程式碼檔。
 *
 * 這是 sync-docs 唯一一項**完全機械化、跑得動**的檢查。文件裡的其他斷言
 * （測試幾個、埠位、指令能不能跑）要專案知識才驗得了，但「這個檔案還在嗎」
 * 不用——而檔案被改名或刪掉正是文件腐爛最常見的形式。
 *
 * 實測（2026-09-02，六個專案）：10 個標記裡 4 個是真的漂移
 * （palrogue 的 heroLayers.ts / fetch-hero-layers.py / render_pal.py 整個 repo
 * 都不存在；namecard 的 web/lib/types.ts 實際在 web/src/lib/types.ts）。
 * 另外 4 個誤報是跨 repo 引用與 `{a,b}.ts` 大括號展開，已在下面濾掉。
 *
 * **這是報告不是關卡。** 精確度不到 100%，所以輸出是給人看的清單，
 * 不要拿它去擋 commit。
 *
 *   node check-paths.mjs [專案目錄]      預設是現在的目錄
 *   node check-paths.mjs --quiet         只印一行摘要（給 preflight 用）
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, basename, relative, resolve } from 'node:path';
import { homedir } from 'node:os';

const args = process.argv.slice(2);
const quiet = args.includes('--quiet');
// **一定要正規化成絕對路徑。** 傳進來的是 `.` 的時候（preflight 就是這樣呼叫的），
// `join('.', 'x')` 會把 `.` 正規化掉，於是下面用 `root.length + 1` 去切前綴會砍掉
// 檔名的前兩個字元（`generated.js` → `nerated.js`），整份 onDisk 清單被汙染，
// 「磁碟上有但沒進版控的檔案也算數」那條就完全失效——而且不會有任何錯誤訊息。
const root = resolve(args.find((a) => !a.startsWith('--')) ?? process.cwd());
const doc = join(root, 'CLAUDE.md');

/**
 * quiet 模式的語意：**沒事就完全安靜**，有事才印一行。
 * （第一版寫成 `if (!quiet || code)`，結果 quiet 模式連警告都吞掉，
 * 變成一個永遠不出聲的檢查——比沒有檢查更糟。）
 */
const done = (msg, { evenInQuiet = false } = {}) => {
  if (!quiet || evenInQuiet) console.log(msg);
  process.exit(0);
};

// git 不在或不是 repo 時 execFileSync 仍會把 stderr 噴到終端機，要關掉。
const gitFiles = (dir) => {
  try {
    return execFileSync('git', ['-C', dir, 'ls-files'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean);
  } catch { return null; }
};

if (!existsSync(doc)) done('（這個目錄沒有 CLAUDE.md）');
const tracked = gitFiles(root);
if (tracked === null) done('（不是 git repo，跳過）');

// 沒進版控但實際存在的也算數 —— gitignore 掉的產物、素材、venv 之外的東西。
const SKIP = new Set(['node_modules', '.git', 'dist', 'build', '.venv', '__pycache__', '.vite', 'coverage']);
const onDisk = [];
(function walk(d, depth) {
  if (depth > 6) return;
  let ents; try { ents = readdirSync(d, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (SKIP.has(e.name) || (e.name.startsWith('.') && e.isDirectory())) continue;
    const p = join(d, e.name);
    if (e.isDirectory()) walk(p, depth + 1); else onDisk.push(relative(root, p));
  }
})(root, 0);
const known = [...new Set([...tracked, ...onDisk])];

// 隔壁的專案。文件常常會引用別的 repo 的檔案（最常見的是 projctl/projects.json），
// 那不是漂移。
//
// 專案樹的位置**每台機器不一樣**：這台 Air 是 ~/Projects、M5 Pro 是 ~/Code、
// 兩台 Windows 是 D:\Claude\Projects。寫死 ~/Projects 的話在 Pro 上整段
// 靜默失效（try/catch 吃掉），跨 repo 引用會全部被誤報成漂移。
const siblings = [];
try {
  const base = process.env.PROJECTS_ROOT
    ?? [join(homedir(), 'Projects'), join(homedir(), 'Code')].find((d) => existsSync(d))
    ?? join(homedir(), 'Projects');
  for (const e of readdirSync(base, { withFileTypes: true })) {
    if (!e.isDirectory() || e.name === basename(root)) continue;
    const fs2 = gitFiles(join(base, e.name));
    if (fs2) siblings.push(...fs2.map((f) => e.name + '/' + f));
  }
} catch { /* 沒有 ~/Projects 也無所謂 */ }

const md = readFileSync(doc, 'utf8');
const paths = new Set();
for (const m of md.matchAll(/`([^`\n]+)`/g)) {
  const t = m[1].trim().replace(/^\.\//, '');
  if (/\s|\*|\\|[{}]/.test(t)) continue;              // 指令、萬用字元、{a,b} 展開
  if (/^(https?:|www\.|\d|-|\$|%|~|\/)/.test(t)) continue;
  if (/^[A-Z]:/.test(t)) continue;                     // Windows 路徑，這台驗不到
  if (/^\.[a-z]+$/.test(t)) continue;                  // 裸副檔名 `.mjs`
  if (!/\.(mjs|js|ts|tsx|py|json|sh|ps1|yml|yaml|toml|html|css)$/.test(t)) continue;
  paths.add(t);
}

const has = (list, p) => list.some((f) => f === p || f.endsWith('/' + p));
const missing = [...paths].filter((p) => !has(known, p) && !has(siblings, p));

if (!missing.length) done(`✓ CLAUDE.md 提到的 ${paths.size} 個程式碼檔都在`);
if (quiet) done(`! CLAUDE.md 有 ${missing.length}/${paths.size} 個檔案路徑找不到 —— 跑 sync-docs 的 check-paths.mjs 看細節`,
  { evenInQuiet: true });

console.log(`CLAUDE.md 提到 ${paths.size} 個程式碼檔，${missing.length} 個找不到：\n`);
for (const m of missing) console.log('   ✗ ' + m);
console.log(`
逐一確認是哪一種再改文件：
  · 檔案被改名或搬走  → 文件要跟著改（真的漂移）
  · 檔案已經刪掉      → 那段文件整段可能都過期了
  · 引用別台機器的東西 → 文件裡要講明「只在某某機器上」
精確度不到 100%，這是清單不是判決。`);
