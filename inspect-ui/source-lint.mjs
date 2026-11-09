#!/usr/bin/env node
// source-lint.mjs —— 前端原始碼靜態掃描：渲染前就抓得到、或渲染了也看不到的問題。
//
// 出處：規則前五條改寫自 Leonxlnx/taste-skill（MIT，Copyright (c) 2026 Leonxlnx）
//       commit 6010f91a9935f1c167dfc500fb1a475681892e6b，skills/taste-skill/scripts/lint.mjs 第 37-66 行
//       （只取 transition-all、100vh、emoji、lorem、framework-colour；placeholder 改成認得中文假資料）。
//       hex-outside-tokens 的構想參考 nextlevelbuilder/ui-ux-pro-max-skill 的 validate-tokens.cjs，
//       但略過 :root／[data-theme] 這類定義 token 的區塊、tailwind 設定檔與 tokens／theme 檔。
//       no-focus-visible、no-reduced-motion 是新寫的全專案層級檢查（渲染版在 design-scan.js 的 a11y-*）。
//
//   node source-lint.mjs <檔案或資料夾 ...> [--json] [--max N]
//
// 離開碼：0 沒有 error　1 有 error 級的發現　2 參數錯誤或一個檔案都沒掃到（結果不可信）
// 單行停用：那一行寫 source-lint-ignore。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname, basename, relative, resolve } from 'node:path';

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const maxAt = args.indexOf('--max');
const MAX = maxAt >= 0 ? Number(args[maxAt + 1]) : 5;
const roots = args.filter((a, i) => !a.startsWith('--') && !(maxAt >= 0 && i === maxAt + 1));
if (!roots.length) { console.error('用法：node source-lint.mjs <檔案或資料夾 ...> [--json] [--max N]'); process.exit(2); }

const EXT = new Set(['.html', '.htm', '.css', '.scss', '.less', '.js', '.jsx', '.ts', '.tsx', '.mjs', '.vue', '.svelte', '.astro']);
const CSS_EXT = new Set(['.css', '.scss', '.less']);
const SKIP_DIR = new Set(['node_modules', '.git', '.next', '.nuxt', '.output', '.svelte-kit', 'dist', 'build', 'out', 'coverage',
  'vendor', '.venv', 'venv', '__pycache__', '.turbo', '.vercel', '.cache', 'tests', 'test', '__tests__', 'e2e', 'fixtures', 'mocks', '__mocks__']);
const SKIP_FILE = /\.min\.|\.d\.ts$|\.(test|spec|stories)\.[a-z]+$/;
// 定義 token 的地方：hex 本來就該寫在這裡
const TOKEN_FILE = /^(tailwind|uno|windi)\.config\.|^(tokens?|theme|colou?rs?|palette)\.[a-z]+$/i;
const TOKEN_BLOCK = /:root|\[data-(theme|mode|color-scheme)|^html\b|(^|[\s,])\.(dark|light)\b|prefers-color-scheme/;

const files = [];
const walk = (p, top) => {
  let st; try { st = statSync(p); } catch { return; }
  if (st.isDirectory()) {
    if (!top && (SKIP_DIR.has(basename(p)) || basename(p).startsWith('.'))) return;
    for (const f of readdirSync(p)) walk(join(p, f), false);
  } else if (EXT.has(extname(p)) && (top || !SKIP_FILE.test(basename(p))) && st.size < 1_000_000) files.push(p);
};
for (const r of roots) {
  try { statSync(resolve(r)); } catch { console.error(`找不到：${r}`); process.exit(2); }
  walk(resolve(r), true);
}
if (!files.length) { console.error(`一個前端檔案都沒掃到（${[...EXT].join(' ')}）：${roots.join('、')}——結果不可信`); process.exit(2); }

const HEX = /(?<![&\w/#])(?<!href=["'])(?<!url\()#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3,4})(?![\w-])/g;
const PLACEHOLDER = /\b(?:John|Jane) Doe\b|\bAcme(?: Inc| Corp)?\b|\bFirstname Lastname\b|\b123 Main St\b|(?<![\u4e00-\u9fff])(?:王小明|王大明|陳小美|林小華|張三|李四|王五|趙六)(?![\u4e00-\u9fff])|某某(?:公司|先生|小姐)|測試(?:用戶|使用者|公司)|範例公司|假資料|0912-?345-?678/;
// 每條：[嚴重度, id, 正規式, 說明]，逐行比對
const R = [
  ['warn', 'transition-all', /transition\s*:\s*all\b|\btransition-all\b/, 'transition: all——寫出要動的屬性（transform、opacity）'],
  ['warn', '100vh', /\bh-screen\b|[hH]eight\s*:\s*['"]?100vh/, '100vh 在手機上會跳——用 100svh／100dvh'],
  // 只算以彩色圖畫顯示的（📌🚀🎯，或後面接 U+FE0F 的）；⚠ ◀ ☀ ✓ 這類文字符號照字型的顏色畫，不算
  ['error', 'emoji', /\p{Emoji_Presentation}|\p{Extended_Pictographic}\uFE0F/u, 'emoji 當介面圖示——用文字或同色系的線條圖示'],
  ['error', 'lorem', /lorem ipsum|dolor sit amet/i, '佔位文字上線了'],
  ['error', 'placeholder-data', PLACEHOLDER, '假資料（John Doe、王小明、張三、某某公司…）——用像真的資料'],
  ['warn', 'framework-colour', /#(3b82f6|2563eb|1d4ed8|60a5fa|10b981|22c55e|ef4444|f59e0b)\b/i, 'Tailwind 預設色——主色與狀態色從 tokens 拿'],
];

const findings = [];
const hexByFile = new Map();
let anyMotion = null, anyFocusVisible = false, anyReduced = false;
const add = (sev, id, file, line, text, msg) => findings.push({ 嚴重度: sev, id, 檔案: file, 行: line, 內容: text.trim().slice(0, 120), 說明: msg });

for (const file of files) {
  const rel = relative(process.cwd(), file).split('\\').join('/');
  const src = readFileSync(file, 'utf8');
  const ext = extname(file);
  const tokenFile = TOKEN_FILE.test(basename(file));
  if (/:focus-visible|focus-visible:/.test(src)) anyFocusVisible = true;
  if (/prefers-reduced-motion|motion-reduce:|motion-safe:|useReducedMotion|reducedMotion/.test(src)) anyReduced = true;
  const lines = src.split(/\r?\n/);
  // CSS 區塊堆疊：在 .css 檔或 <style> 裡面才追，用來判斷 hex 是不是寫在定義 token 的區塊裡
  const stack = []; let buf = ''; let inStyle = CSS_EXT.has(ext); let inBlockComment = false; let inHtmlComment = false;
  const slashComments = ext === '.scss' || ext === '.less';
  lines.forEach((raw, i) => {
    const n = i + 1;
    if (!CSS_EXT.has(ext)) { if (/<style\b/i.test(raw)) inStyle = true; }
    // 拿掉註解（粗略：/* */ 跨行、// 行尾、<!-- -->）
    let line = '';
    for (let k = 0; k < raw.length; k++) {
      if (inHtmlComment) { if (raw.startsWith('-->', k)) { inHtmlComment = false; k += 2; } continue; }
      if (raw.startsWith('<!--', k)) { inHtmlComment = true; k += 3; continue; }
      if (inBlockComment) { if (raw.startsWith('*/', k)) { inBlockComment = false; k++; } continue; }
      if (raw.startsWith('/*', k)) { inBlockComment = true; k++; continue; }
      if ((!inStyle || slashComments) && raw.startsWith('//', k) && raw[k - 1] !== ':') break;
      line += raw[k];
    }
    const skip = raw.length > 2000 || /source-lint-ignore/.test(raw) || !line.trim();
    if (!skip) {
      for (const [sev, id, re, msg] of R) if (re.test(line)) add(sev, id, rel, n, raw, msg);
      const moves = inStyle ? /(?:^|[;{\s])(?:transition|animation)\s*:\s*(?!none)/.test(line)
        : /\bclass(?:Name)?\s*=\s*["'`{][^"'`]*\b(?:transition(?:-all|-transform)?|animate-(?!none)[a-z]+)(?![\w-])/.test(line) || /\b(?:transition|animation)\s*:\s*['"`](?!none)/.test(line);
      if (!anyMotion && moves) anyMotion = `${rel}:${n}`;
    }
    // 逐字走一遍，邊走邊記 CSS 區塊；hex 依它所在的區塊決定算不算
    const inToken = () => stack.some(s => TOKEN_BLOCK.test(s));
    let col = 0;
    for (const m of skip ? [] : line.matchAll(HEX)) {
      for (; col < m.index; col++) {
        const ch = line[col];
        if (!inStyle) continue;
        if (ch === '{') { stack.push(buf.trim()); buf = ''; } else if (ch === '}') { stack.pop(); buf = ''; } else if (ch === ';') buf = ''; else buf += ch;
      }
      if (tokenFile || (inStyle && inToken()) || /<meta\b[^>]*theme-color/i.test(line)) continue; // theme-color 只能寫色碼
      hexByFile.set(rel, (hexByFile.get(rel) || 0) + 1);
      add('warn', 'hex-outside-tokens', rel, n, raw, `寫死的色碼 ${m[0]}——改用 tokens 的變數（var(--…)）`);
    }
    if (inStyle) for (; col < line.length; col++) {
      const ch = line[col];
      if (ch === '{') { stack.push(buf.trim()); buf = ''; } else if (ch === '}') { stack.pop(); buf = ''; } else if (ch === ';') buf = ''; else buf += ch;
    }
    if (!CSS_EXT.has(ext) && /<\/style>/i.test(raw)) { inStyle = false; stack.length = 0; buf = ''; }
  });
}
if (!anyFocusVisible) add('warn', 'no-focus-visible', '（整個專案）', 0, '', '整個專案沒有任何 :focus-visible——鍵盤使用者看不到焦點（渲染版：design-scan 的 a11y-focus-ring）');
if (anyMotion && !anyReduced) add('warn', 'no-reduced-motion', '（整個專案）', 0, anyMotion, `有轉場或動畫（第一個在 ${anyMotion}），整個專案沒有 prefers-reduced-motion`);

const sevRank = { error: 0, warn: 1 };
findings.sort((a, b) => sevRank[a.嚴重度] - sevRank[b.嚴重度]);
const counts = {};
for (const f of findings) counts[f.id] = (counts[f.id] || 0) + 1;
const errors = findings.filter(f => f.嚴重度 === 'error').length;
if (asJson) {
  console.log(JSON.stringify({ 檔案數: files.length, 各規則: counts, 色碼最多的檔: [...hexByFile].sort((a, b) => b[1] - a[1]).slice(0, 10), 發現: findings }, null, 1));
} else {
  console.log(`掃了 ${files.length} 個檔，${findings.length} 個發現（error ${errors}）`);
  for (const id of Object.keys(counts)) {
    const list = findings.filter(f => f.id === id);
    console.log(`\n[${list[0].嚴重度}] ${id} × ${counts[id]}　${list[0].說明}`);
    for (const f of list.slice(0, MAX)) console.log(`    ${f.行 ? `${f.檔案}:${f.行}` : f.檔案}　${f.內容}`);
    if (list.length > MAX) console.log(`    …還有 ${list.length - MAX} 個`);
  }
  if (hexByFile.size) console.log('\n色碼最多的檔：' + [...hexByFile].sort((a, b) => b[1] - a[1]).slice(0, 5).map(([f, c]) => `${f}（${c}）`).join('、'));
}
process.exit(errors ? 1 : 0);
