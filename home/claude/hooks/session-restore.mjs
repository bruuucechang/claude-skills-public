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
 * | `clear`（handoff-open 打的） | 自動換手 | 那份換手開場白（交接單全文＋recon-check 快照） |
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
 * ## handoff-open 打的 /clear（2026-10-21 W4）
 *
 * 它在打 /clear 前把標記檔（`~/.claude/state/handoff/<時間>.json`）寫上 `clearing`，pid 是這格的 claude。
 * 同一個 claude 程序、`clearing` 在 `PRELOAD_MIN` 分鐘內、還沒注過（同名 `.preloaded`）→ 注開場白檔全文。
 * 這樣新 session 打開就有交接單與現況，第一個動作是做事而不是讀檔。
 *
 * 逃生門：`touch ~/.claude/skills/home/claude/hooks/session-restore.off`
 */

import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cli, isMain } from './lib/hook-cli.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OFF = join(HERE, 'session-restore.off');
const ROOT = join(homedir(), '.claude', 'session-logs');

const TAIL_BYTES = 5 * 1024;
const HANDOFF_FRESH_MIN = 240;
const PRELOAD_MIN = 5;
const PRELOAD_MAX = 9000;

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

// handoff-open 剛替這個 claude 打了 /clear：找它的標記，注開場白（只注一次）
async function preload() {
  const dir = join(homedir(), '.claude', 'state', 'handoff');
  // 先用 mtime 篩（標記目錄不清、幾百個檔），有候選才去找 claude 的 pid（要跑好幾次 ps）（PR #24 審查）
  const since = Date.now() - PRELOAD_MIN * 60_000;
  let names;
  try {
    names = readdirSync(dir).filter((n) => n.endsWith('.json'))
      .filter((n) => { try { return statSync(join(dir, n)).mtimeMs > since; } catch { return false; } })
      .sort().reverse();
  } catch { return null; }
  if (!names.length) return null;
  // acct-drain 拉 accounts 進來：只有這條用，動態載入，壞掉也不拖垮 compact／startup（PR #24 審查）
  const { claudeAncestor } = await import('../tools/acct-drain.mjs');
  const me = Number(process.env.HANDOFF_CLAUDE_PID) || claudeAncestor();   // HANDOFF_CLAUDE_PID：只給測試用
  if (!me) return null;
  for (const n of names) {
    let m;
    try { m = JSON.parse(readFileSync(join(dir, n), 'utf8')); } catch { continue; }
    if (m.pid !== me || !m.clearing || !m.promptFile) continue;
    if (Date.parse(m.clearing) < since) return null;   // 最新的一份太舊就不用往下找
    const done = join(dir, n.replace(/\.json$/, '.preloaded'));
    if (existsSync(done)) return null;
    let body;
    try { body = readFileSync(m.promptFile, 'utf8'); } catch { return null; }
    try { writeFileSync(done, new Date().toISOString()); } catch {}
    // hook 輸出太長會被 Claude Code 截成預覽：那就只注指示＋檔名，叫它讀檔（PR #24 審查）
    if (body.length + 200 > PRELOAD_MAX) {   // 200：外面包的那段字
      return emit(`【自動換手：handoff-open 剛替這格打了 /clear。開場白太長（${body.length} 字）沒有整份注入，`
        + `先讀 \`${m.promptFile}\`，照它做】`);
    }
    return emit(`【自動換手的開場白，handoff-open 剛替這格打了 /clear；原檔 \`${m.promptFile}\`】\n\n${body}`);
  }
  return null;
}

export function run(p) {
  if (existsSync(OFF)) return null;

  const source = p?.source ?? 'startup';
  const cwd = p?.cwd || process.cwd();
  const dir = join(ROOT, slugOf(cwd));

  if (source === 'clear') return preload();

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
