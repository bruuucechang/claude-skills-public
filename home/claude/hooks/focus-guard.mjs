#!/usr/bin/env node
/**
 * PreToolUse(Bash) hook —— agent 下的指令不准把視窗推到使用者面前。
 *
 * ## 為什麼這件事非得是機制
 *
 * 2026-10-11 使用者原話：「所有 session 在工作時要用別的視窗，不要一直切我的視角，
 * 直接在隔壁跑完就好，不要一直彈出」。他點名的四個來源：
 *
 *     open <檔案>              → 預覽程式／Chrome 跳到最前面
 *     open -g <html>          → 焦點不搶，但 **Chrome 正在看的分頁被切走**（實測）
 *     osascript … activate    → 直接把 app 推到最前面
 *     osascript … do script   → Terminal 開新視窗（他的四宮格就是 Terminal，一定跳到最前面）
 *     Godot 有視窗模式          → 啟動時自己 activate，`open -g` 與 no_focus 都擋不住（實測）
 *
 * 規則寫在 AGENTS.md，這支是保證。
 *
 * ## 要怎麼做才對（擋下時的訊息也會說）
 *
 *     開檔案／網址給他看     ~/.claude/skills/home/claude/tools/bgopen <檔案或網址>
 *     跑會開視窗的程式       ~/.claude/skills/home/claude/tools/bgrun <指令…>
 *     專案的網頁             proj open <名>（agent 呼叫時自動走背景）
 *
 * ## 判準只看語法
 *
 * 指令依 `&&`／`||`／`;`／`|`／換行切段：
 *   - 開頭是 `open` 的段：沒有 `-g` 擋；有 `-g` 但目標是 html／網址也擋（會切分頁）
 *   - 整條指令有 `osascript`，且內文出現 `activate`／`do script`／`make new window`／
 *     `frontmost to true` 擋
 *   - 段落直接執行 Godot 執行檔、沒有 `--headless`、前面也沒有 bgrun 擋
 *
 * ## 逃生門
 *
 *     touch ~/.claude/skills/home/claude/hooks/focus-guard.off
 *
 * 擋下的每一筆記在 focus-guard.log，之後可以量它是擋到真的東西還是只在礙事。
 */

import { existsSync } from 'node:fs';
import { appendLog } from './lib/log.mjs';
import { cli, isMain, tilde } from './lib/hook-cli.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OFF = join(HERE, 'focus-guard.off');
const LOG = join(HERE, 'focus-guard.log');

/**
 * 拿掉段首的 `VAR=值`、`exec`、`nohup`、`command`，剩下真正被執行的那個字開頭。
 * 整段只有賦值（`G=/…/Godot;`）會變成空字串：賦值不是執行（2026-10-19 四筆誤擋）。
 */
const head = (seg) => seg.trim().replace(/^(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S*|exec|nohup|command)(?:\s+|$))*/, '');

/**
 * 指令裡被賦值成 Godot 執行檔的變數 → 它的值（`G=/…/Godot`，或連旗標一起包 `G="/…/Godot --headless …"`），
 * 之後的 `$G` 也算 Godot，而包在值裡的 `--headless` 也要算進去。
 */
const godotVars = (text) => {
  const vars = new Map([['GODOT', '']]);
  for (const m of text.matchAll(/(?:^|[\s;&|(])([A-Za-z_][A-Za-z0-9_]*)=(?:"([^"]*)"|'([^']*)'|([^\s;&|]*))/g)) {
    const val = m[2] ?? m[3] ?? m[4] ?? '';
    if (/^\S*Godot(\s|$)/.test(val)) vars.set(m[1], val);
  }
  return vars;
};

/** 只印東西就結束、不開視窗的旗標（Godot 在建立顯示伺服器之前就處理掉）。 */
const NO_WINDOW = /\s--(?:headless|version|help)\b|\s-h(?:\s|$)/;

/** heredoc 本體是資料不是指令（寫文件時常有一行剛好以 open 開頭），切段前先拿掉。 */
const stripHeredocs = (text) => {
  const out = [];
  const ls = text.split('\n');
  for (let i = 0; i < ls.length; i++) {
    out.push(ls[i]);
    const hd = ls[i].match(/<<-?\s*['"]?(\w+)['"]?/);
    if (hd) while (i + 1 < ls.length && ls[++i].trim() !== hd[1]);
  }
  return out.join('\n');
};

/** 引號裡的 `|`、`;`、`&` 不是分段符號（`grep -E 'a|open -x'` 曾被誤切成一段 `open`）。 */
const maskQuoted = (text) => text.replace(/'[^'\n]*'|"(?:[^"\\\n]|\\.)*"/g, (q) => q.replace(/[;|&]/g, ' '));

/** 回 null＝放行。這支壞掉不該擋住任何指令。 */
export function run(input) {
  if (existsSync(OFF)) return null;
  const cmd = input?.tool_input?.command ?? '';
  if (typeof cmd !== 'string') return null;
  if (!/open|osascript|Godot/.test(cmd)) return null;

  const segs = maskQuoted(stripHeredocs(cmd)).split(/&&|\|\||[;|\n]/).map(head);
  const gvars = godotVars(stripHeredocs(cmd));
  const viaVar = new RegExp(`^"?\\$\\{?(${[...gvars.keys()].join('|')})\\}?"?(\\s|$)`);
  const problems = [];

  for (const s of segs) {
    if (/^open(\s|$)/.test(s)) {
      const flags = s.split(/\s+/).filter((w) => /^-[A-Za-z]+$/.test(w)).join('');
      if (!flags.includes('g')) {
        problems.push('`open` 沒帶 `-g`：會把預覽程式／瀏覽器推到最前面');
      } else if (/(https?:\/\/|file:\/\/|\.html?\b|\.svg\b)/.test(s)) {
        problems.push('`open -g` 開 html／網址：焦點不搶，但 Chrome 正在看的分頁會被切走（2026-10-11 實測）');
      } else if (/-a\s+["']?[^\s"']*Godot/.test(s)) {
        problems.push('`open -g -a Godot`：Godot 啟動時自己 activate，-g 擋不住');
      }
    }
    const v = s.match(viaVar);
    if (/(^|\/)Godot(\s|$)/.test(s.split(/\s+/)[0] ?? '') || /^"[^"]*\/Godot"(\s|$)/.test(s) || v) {
      if (!NO_WINDOW.test(`${s} ${v ? gvars.get(v[1]) : ''}`)) problems.push('直接跑有視窗的 Godot：它啟動時會搶焦點');
    }
  }

  /**
   * 只看「真的在執行 osascript」的那一段：指令開頭的 osascript 那一行，
   * 加上它若吃 heredoc，就連 heredoc 本體一起看。整條指令字串都掃的話，
   * 寫文件的 heredoc 裡同時提到 osascript 與 activate 就會被誤擋（2026-10-11 第一版踩到）。
   */
  const osaBodies = [];
  const lines = cmd.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const parts = maskQuoted(lines[i]).split(/&&|\|\||[;|]/).map(head);
    const at = parts.findIndex((p) => /^osascript\b/.test(p));
    if (at < 0) {
      // 別的指令（cat > f <<EOF）的 heredoc 本體整段跳過
      const other = lines[i].match(/<<-?\s*['"]?(\w+)['"]?/);
      if (other) while (i + 1 < lines.length && lines[++i].trim() !== other[1]);
      continue;
    }
    const seg = parts.slice(at).join(' ');
    let body = seg;
    const hd = seg.match(/<<-?\s*['"]?(\w+)['"]?/);
    if (hd) {
      let j = i + 1;
      while (j < lines.length && lines[j].trim() !== hd[1]) body += '\n' + lines[j++];
      i = j;
    }
    osaBodies.push(body);
  }
  for (const body of osaBodies) {
    const m = body.match(/\bactivate\b(?!WithOptions)|\bdo script\b|\bmake new window\b|\bfrontmost\s+(?:of\s+\S+\s+)?to\s+true\b/);
    if (m) problems.push(`osascript 裡有 \`${m[0]}\`：會把視窗推到使用者面前`);
  }

  if (problems.length === 0) return null;

  const reason = [
    '這條指令會搶使用者的畫面，擋下來了：',
    ...problems.map((p) => `  - ${p}`),
    '',
    '使用者裁示（2026-10-11）：所有 session 工作時一律在背景跑，**連交付預覽也是背景開、回報裡說一聲**。',
    '改用：',
    `    開檔案／網址       ${tilde(join(HERE, '..', 'tools', 'bgopen'))} <檔案或網址>`,
    `    會開視窗的程式     ${tilde(join(HERE, '..', 'tools', 'bgrun'))} <指令…>`,
    '    專案網頁           proj open <名>（agent 呼叫時自動走背景）',
    '    Codex             codex-drive（只跑 tmux，不開 Terminal 視窗）',
    '',
    `（真的需要繞過：\`touch ${tilde(join(HERE, 'focus-guard.off'))}\`）`,
  ].join('\n');

  if (!process.env.FOCUS_GUARD_NOLOG) appendLog(LOG, { at: new Date().toISOString(), problems, cmd: cmd.slice(0, 400) });

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

if (isMain(import.meta.url)) cli(run);
