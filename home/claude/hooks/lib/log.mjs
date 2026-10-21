/**
 * hook 共用的 log 寫入：append 一行，每天第一次寫入時順手刪掉 30 天以前的行。
 *
 * 為什麼是 30 天：跟 Claude Code 的對話紀錄（cleanupPeriodDays 預設 30）一樣長。
 * log 常要對照那個 session 的對話，對話沒了 log 留著也對不上（2026-10-20 使用者裁示）。
 *
 * 時間欄位依序找 `at`、`t`、`_t`；找不到或解析不了的行一律留著（寧可多留，不誤刪）。
 * 修剪是「讀全檔 → 寫暫存檔 → rename」，用 mkdir 當鎖，同一天只有一個程序會做。
 * 讀與 rename 之間別的程序 append 的那幾行會掉——一天一次、毫秒等級的窗口，可以接受。
 *
 * 重跑測試：node ~/.claude/skills/home/claude/hooks/lib/log.test.mjs
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';

export const KEEP_DAYS = 30;
const DAY = 86_400_000;

/** 一行的時間（毫秒）；拿不到就回 null。 */
export function lineTime(line) {
  const m = /"(?:at|t|_t)":"([^"]+)"/.exec(line);
  if (!m) return null;
  const ms = Date.parse(m[1]);
  return Number.isNaN(ms) ? null : ms;
}

/** 刪掉 file 裡早於 now - KEEP_DAYS 的行。回傳刪掉幾行。 */
export function prune(file, now = Date.now()) {
  if (!existsSync(file)) return 0;
  const lock = `${file}.prune-lock`;
  try { mkdirSync(lock); } catch {
    // 鎖超過 10 分鐘還在＝上一個程序死在半路，清掉，下次再修
    try { if (now - statSync(lock).mtimeMs > 600_000) rmdirSync(lock); } catch {}
    return 0;
  }
  try {
    const cut = now - KEEP_DAYS * DAY;
    const lines = readFileSync(file, 'utf8').split('\n');
    const keep = lines.filter((l) => { const t = lineTime(l); return t === null || t >= cut; });
    const dropped = lines.length - keep.length;
    if (dropped) {
      writeFileSync(`${file}.tmp`, keep.join('\n'));
      renameSync(`${file}.tmp`, file);
    }
    return dropped;
  } finally {
    try { rmdirSync(lock); } catch {}
  }
}

/** 今天修剪過了沒：用 `<file>.pruned` 的 mtime 記。 */
function dueForPrune(file, now) {
  const mark = `${file}.pruned`;
  try { if (new Date(statSync(mark).mtimeMs).toDateString() === new Date(now).toDateString()) return false; } catch {}
  try { writeFileSync(mark, ''); utimesSync(mark, now / 1000, now / 1000); } catch {}
  return true;
}

/**
 * append 一筆（物件會 JSON 化）。任何錯誤都吞掉：記不了 log 不能影響 hook 的判斷。
 * `HOOK_NOLOG=1` 時不寫（重播、量測用，免得假輸入混進稽核紀錄）。
 */
export function appendLog(file, entry, now = Date.now()) {
  if (process.env.HOOK_NOLOG) return;
  try {
    appendFileSync(file, (typeof entry === 'string' ? entry : JSON.stringify(entry)) + '\n');
    if (dueForPrune(file, now)) prune(file, now);
  } catch {}
}
