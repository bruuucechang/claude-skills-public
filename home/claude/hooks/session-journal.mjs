#!/usr/bin/env node
/**
 * Stop hook —— 每回合把「做了什麼」追加到磁碟，讓回收前文變成無損操作。
 *
 * ## 它存在的唯一理由
 *
 * 前文是**唯一**的記憶來源時，`/compact` 與「關掉重開」都是有損的，
 * 所以人會拖著不做，然後每一輪重讀 400k+。2026-09-24 實測 Air 近 7 天：
 * **cache_read 佔全部 token 的 98.5%**，最貴的單一 session 跑了 7,673 輪／
 * 七天沒關，一個就吃掉那 7 天總量的 25%。
 *
 * 這支把每回合落地之後，前文就不再是唯一來源 —— context-tier.mjs 才敢叫你回收。
 * 兩支是一組的，少一支另一支就不該裝。
 *
 * ## 三個刻意的決定
 *
 * 1. **log 放 `~/.claude/session-logs/`，不放 repo 裡。** 放 repo 會進 git、
 *    會觸發別的 hook、會讓 `git status` 永遠是髒的——而髒的工作樹正是
 *    autopilot 那類機制用來判斷「這一輪有沒有產出」的訊號。
 * 2. **git 改動只記「這回合相對上一筆的新增」**，不每回合重印整棵工作樹。
 *    整棵樹重印的話，一個改了 30 個檔的 session 會在 log 裡留下 30×N 行。
 * 3. **永遠 exit 0、永遠不寫 stdout。** Stop hook 的 stdout 是用來擋回合的
 *    （見 ask-with-options.mjs），這支寫任何東西都可能變成「擋下來」。
 *
 * 逃生門：`touch ~/.claude/skills/home/claude/hooks/session-journal.off`
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { cli, isMain } from './lib/hook-cli.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OFF = join(HERE, 'session-journal.off');
const ROOT = join(homedir(), '.claude', 'session-logs');

/** 專案 slug：取工作目錄最後一段，不能當檔名的字元換掉。 */
const slugOf = (cwd) => (basename(cwd || 'unknown') || 'unknown').replace(/[^\w.-]/g, '_');

/** 從檔尾讀一段就好——七千輪的 transcript 不能整份讀。 */
function tailLines(path, bytes = 512 * 1024) {
  if (!path || !existsSync(path)) return [];
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8').split('\n');
  } catch {
    return [];
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
  }
}

const textOf = (msg) => {
  const c = msg?.content;
  if (typeof c === 'string') return c;
  if (!Array.isArray(c)) return '';
  return c.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
};

const squeeze = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** 這一輪的觸發請求，以及助理最後說了什麼。 */
function turnOf(path) {
  const lines = tailLines(path);
  let assistant = '', user = '';
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l || l[0] !== '{') continue;
    let j;
    try { j = JSON.parse(l); } catch { continue; }
    if (!assistant && j.type === 'assistant') {
      const t = textOf(j.message);
      if (t.trim()) assistant = t;
      continue;
    }
    // 助理那句抓到之後，再往回找觸發它的使用者訊息。
    // `isMeta` 是系統注入的（hook 的 additionalContext 之類），不是人打的。
    if (assistant && j.type === 'user' && !j.isMeta) {
      const t = textOf(j.message);
      if (t.trim() && !t.startsWith('<')) { user = t; break; }
    }
  }
  return { user, assistant };
}

/** `git status --porcelain` 的集合；不是 repo 或 git 不在就回 null（不是空集合）。 */
function gitState(cwd) {
  try {
    const out = execFileSync('git', ['status', '--porcelain'], {
      cwd, encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

/** 什麼都不輸出（Stop 的 stdout 會被當成要擋），一律回 null。 */
export function run(p) {
  if (existsSync(OFF)) return null;

  const sid = p?.session_id;
  const cwd = p?.cwd || process.cwd();
  if (!sid) return null;

  const dir = join(ROOT, slugOf(cwd));
  const logFile = join(dir, `${sid}.md`);
  const stateFile = join(dir, `.${sid}.state.json`);

  const { user, assistant } = turnOf(p?.transcript_path);
  // 助理一個字都沒說的回合（純工具、被擋下的回合）不值得留一筆。
  if (!assistant) return null;

  let prev = [];
  try { prev = JSON.parse(readFileSync(stateFile, 'utf8')).git ?? []; } catch {}
  const now = gitState(cwd);
  const fresh = now === null ? [] : now.filter((x) => !prev.includes(x));

  const ts = new Date().toISOString().replace('T', ' ').slice(0, 16);
  const parts = [`## ${ts}`];
  if (user) parts.push(`**請求**：${squeeze(user, 300)}`);
  parts.push(`**做了**：${squeeze(assistant, 700)}`);
  if (fresh.length) parts.push(`**新增改動**：${fresh.slice(0, 20).join(' · ')}${fresh.length > 20 ? ` …共 ${fresh.length}` : ''}`);

  try {
    mkdirSync(dir, { recursive: true });
    if (!existsSync(logFile)) {
      writeFileSync(logFile, `# session ${sid}\n\n工作目錄：\`${cwd}\`\n\n`);
    }
    appendFileSync(logFile, parts.join('\n') + '\n\n');
    if (now !== null) writeFileSync(stateFile, JSON.stringify({ git: now }));
  } catch {}

  return null;
}

if (isMain(import.meta.url)) cli(run);
