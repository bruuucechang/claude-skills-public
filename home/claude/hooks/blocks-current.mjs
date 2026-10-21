#!/usr/bin/env node
/**
 * SessionStart hook —— 這個 repo 有區塊計畫的話，一進來就講「現在在哪一塊」。
 *
 * ## 為什麼要有
 *
 * 2026-09-25 實測：Air 近 7 天 `cache_read` 佔全部 token 的 **98.5%**，
 * 最貴的單一 session 跑了 7,673 輪／七天沒關，一個就吃掉那週 25%。
 * 錢不是花在做事，是花在**每一輪把整份累積的前文重讀一次**。
 *
 * 止血只有一種：**做完一段就把那段的前文丟掉**。而要敢丟，得先有兩樣東西——
 * 「這一塊做完的判準」（`blocks.md` 的驗收）與「下一塊的起手」（`HANDOFF.md`）。
 * 這支負責前者，`session-restore.mjs` 負責後者。
 *
 * ## 只注入「當前那一塊」，不是整份檔
 *
 * 這支每個 session 都會跑，所以它自己就是固定成本。整份 `blocks.md` 塞進來
 * 等於把我們正在砍的東西加回去——所以只挑一塊、而且截到 `MAX_INJECT`。
 * 完成的區塊一個字都不注（它們已經做完了，下一塊不需要它們）。
 *
 * ## 挑哪一塊
 *
 *   1. 第一個 `[進行中]`
 *   2. 沒有的話，第一個 `[未開始]`
 *   3. 都沒有 → 全部做完了，講一句就好（這也是資訊：該收工或該重新切塊）
 *
 * 逃生門：`touch ~/.claude/skills/home/claude/hooks/blocks-current.off`
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cli, isMain } from './lib/hook-cli.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OFF = join(HERE, 'blocks-current.off');

/** 一塊最多注入這麼多字元。超過就是那一塊切太大了，截斷本身就是訊號。 */
const MAX_INJECT = 1400;

/**
 * 從 cwd 往上找 `blocks.md`，最多 5 層。
 *
 * 往上找是因為 session 常開在子目錄（`frontend/`、`backend/`），而區塊計畫
 * 跟 `project-map.json` 一樣住在 repo 根。停在 `.git` 那一層就夠，
 * 再往上是別的專案甚至家目錄——那裡的 `blocks.md` 跟這次工作無關。
 */
function findBlocks(cwd) {
  let dir = cwd;
  for (let i = 0; i < 5 && dir; i++) {
    const f = join(dir, 'blocks.md');
    if (existsSync(f)) return f;
    if (existsSync(join(dir, '.git'))) return null;   // 到 repo 根了還沒有
    const up = dirname(dir);
    if (up === dir) return null;
    dir = up;
  }
  return null;
}

/**
 * `blocks.md` 加上同一個 repo 的 `docs/blocks.d/*.md`（碎片檔，2026-10-21 animyria 起用）。
 * 中途冒出來的新塊寫在碎片裡（各 lane 不改同一個檔），只讀 `blocks.md` 會把它們安靜地漏掉，
 * 而全部打勾時還會報「區塊計畫已經全部完成」。碎片照檔名排、排在 `blocks.md` 的塊後面。
 * 每個檔分開切：碎片裡的落地紀錄（`## X 落地紀錄`，不帶狀態）不能被併進別的檔的最後一塊。
 */
function readPlan(f) {
  const out = parse(readFileSync(f, 'utf8'), f, false);
  const d = join(dirname(f), 'docs', 'blocks.d');
  let names = [];
  // 數字照大小排（bx2 在 bx10 前面）
  try { names = readdirSync(d).filter((n) => n.endsWith('.md') && n !== 'README.md').sort((a, b) => a.localeCompare(b, 'en', { numeric: true })); } catch {}
  for (const n of names) {
    try { out.push(...parse(readFileSync(join(d, n), 'utf8'), join(d, n), true)); } catch {}
  }
  return out;
}

/**
 * 切成 `## ` 段落，每段帶它的狀態標記與所在的檔。
 * `blocks.md` 照舊切到下一個帶狀態的標題；碎片（`fragment`）切到下一個 `## ` 標題（程式碼圍欄裡的不算），
 * 同一個檔裡不帶狀態的節（落地紀錄）不算進前一塊。
 */
function parse(text, file, fragment) {
  const out = [];
  // 標題形如：`## B2 前端進度條  [進行中]`
  const re = /^## +(.+?)\s*\[(未開始|進行中|完成|封存)\]\s*$/gm;
  const hits = [...text.matchAll(re)];
  const bounds = [];
  if (fragment) {
    let fence = false, pos = 0;
    for (const line of text.split('\n')) {
      if (/^\s*```/.test(line)) fence = !fence;
      else if (!fence && line.startsWith('## ')) bounds.push(pos);
      pos += line.length + 1;
    }
  }
  for (let i = 0; i < hits.length; i++) {
    const start = hits[i].index;
    let end = i + 1 < hits.length ? hits[i + 1].index : text.length;
    if (fragment) end = Math.min(end, bounds.find((b) => b > start) ?? text.length);
    out.push({ title: hits[i][1].trim(), status: hits[i][2], body: text.slice(start, end).trim(), file });
  }
  return out;
}

export function run(p) {
  if (existsSync(OFF)) return null;

  // `clear` 是使用者主動要乾淨的；`compact`/`resume` 的前文裡本來就有這些。
  if ((p?.source ?? 'startup') !== 'startup') return null;

  const f = findBlocks(p?.cwd || process.cwd());
  if (!f) return null;

  let blocks;
  try { blocks = readPlan(f); } catch { return null; }
  if (!blocks.length) return null;

  const doing = blocks.find((b) => b.status === '進行中');
  const next = blocks.find((b) => b.status === '未開始');
  const left = blocks.filter((b) => b.status === '進行中' || b.status === '未開始').length;
  const done = blocks.filter((b) => b.status === '完成').length;

  let msg;
  if (doing || next) {
    const b = doing ?? next;
    let body = b.body;
    if (body.length > MAX_INJECT) {
      // 截斷是訊號不是失敗：一塊講不完 1400 字，那一塊就該再切小。
      body = body.slice(0, MAX_INJECT) + `\n…（這一塊的描述超過 ${MAX_INJECT} 字被截斷了——通常代表它該再切小）`;
    }
    msg = `【這個 repo 有區塊計畫】\`${f}\`：完成 ${done}／剩 ${left}。`
      + (b.file !== f ? `這一塊寫在碎片檔 \`${b.file}\`（狀態與落地紀錄改那個檔，不要改 blocks.md）。` : '')
      + `${doing ? '目前這一塊' : '還沒有進行中的，下一塊是'}：\n\n${body}\n\n`
      + `一個 session 做一塊，不問使用者直接做。做完跑驗收 → 打勾 → push → 寫交接單 → \`handoff-open\`（回合結束後自己 /clear）接下一塊`
      + `（不在同一個 session 接著做）。只有重大事件才停下來問，見 blocks skill。`;
  } else {
    msg = `【這個 repo 的區塊計畫已經全部完成】\`${f}\`：${done} 塊全部打勾。`
      + `接著做別的事之前，先確認是不是該重新切一批新的區塊。`;
  }

  return {
    hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: msg },
  };
}

if (isMain(import.meta.url)) cli(run);
