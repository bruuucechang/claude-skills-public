#!/usr/bin/env node
/**
 * SessionStart hook —— 把回收掉的前文接回來。session-journal.mjs 的另一半。
 *
 * ## 兩種進場，接回來的東西不一樣
 *
 * | `source` | 發生什麼 | 注回什麼 |
 * |---|---|---|
 * | `compact` / `resume` | 前文被壓縮或從斷點續 | 這個 session 的 journal 尾段（`TAIL_BYTES`） |
 * | `startup` | 全新 session | 夠新的 `HANDOFF.md`（注完就歸檔） |
 * | `clear` | 使用者主動清空 | **什麼都不注**（他就是要乾淨的） |
 *
 * ## 為什麼 startup 預設什麼都不注
 *
 * 「新開一個 session」最常見的意思就是**換一件事做**。無條件把上次的東西
 * 倒回去，等於把我們剛省下來的 context 又加回去，而且方向還是錯的。
 * 所以只有「剛剛才寫下交接單」（`HANDOFF_FRESH_MIN` 分鐘內）才注 ——
 * 那是一個明確的「我要接著做」訊號，不是猜的。
 *
 * ## 注完就歸檔，不留在原地
 *
 * 留著的話下一個 session 會再注一次；而「同一份交接單被接兩次」在畫面上
 * 看不出來，只會讓第二個 session 從一個已經做完的狀態出發。
 * 歸檔成 `HANDOFF-<時間>.md`，要翻得回去。
 *
 * 逃生門：`touch ~/.claude/skills/home/claude/hooks/session-restore.off`
 */

import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cli, isMain } from './lib/hook-cli.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OFF = join(HERE, 'session-restore.off');
const ROOT = join(homedir(), '.claude', 'session-logs');

const TAIL_BYTES = 5 * 1024;
const HANDOFF_FRESH_MIN = 240;

const slugOf = (cwd) => (basename(cwd || 'unknown') || 'unknown').replace(/[^\w.-]/g, '_');

function tail(path, bytes) {
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(bytes, size);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    let s = buf.toString('utf8');
    // 從第一個完整的段落標題開始，不要以半句話起頭。
    const i = s.indexOf('\n## ');
    if (i > 0) s = s.slice(i + 1);
    return s;
  } catch {
    return '';
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
  }
}

const emit = (text) => ({
  hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text },
});

export function run(p) {
  if (existsSync(OFF)) return null;

  const source = p?.source ?? 'startup';
  const cwd = p?.cwd || process.cwd();
  const dir = join(ROOT, slugOf(cwd));

  if (source === 'clear') return null;

  if (source === 'compact' || source === 'resume') {
    const f = join(dir, `${p?.session_id}.md`);
    if (!existsSync(f)) return null;
    const t = tail(f, TAIL_BYTES);
    if (!t.trim()) return null;
    return emit(`【前文被回收了，以下是這個 session 的工作日誌尾段，由 session-journal hook 逐回合落地的】\n`
      + `完整的在 \`${f}\`。\n\n${t}`);
  }

  // startup
  const h = join(dir, 'HANDOFF.md');
  if (!existsSync(h)) return null;
  let age;
  try { age = (Date.now() - statSync(h).mtimeMs) / 60_000; } catch { return null; }
  if (age > HANDOFF_FRESH_MIN) return null;

  let body = '';
  try { body = readFileSync(h, 'utf8'); } catch { return null; }
  if (!body.trim()) return null;

  try {
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 16);
    renameSync(h, join(dir, `HANDOFF-${stamp}.md`));
  } catch {}

  return emit(`【上一個 session ${Math.round(age)} 分鐘前留下的交接單，自動接回】\n\n${body}`);
}

if (isMain(import.meta.url)) cli(run);
