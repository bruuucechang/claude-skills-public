#!/usr/bin/env node
/**
 * PreToolUse(Bash) hook —— 不准用名字／指令字串比對去殺程序：`pkill`、`killall`、`kill $(pgrep …)`、
 * `pgrep … | xargs kill`、Windows 的 `taskkill /IM`、`Stop-Process -Name`。`kill <pid>` 照常放行。
 *
 * ## 為什麼
 *
 * 2026-10-20 一格想停掉自己的 `git push origin HEAD:master`，用 `pgrep -f` 找 pid——這台 Mac 同時有七、八個
 * animyria lane 在跑一模一樣的指令，結果連四個別的 lane 的 push 一起殺掉（記憶 kill-by-pid-not-pattern）。
 * 那條規則之後只寫在記憶檔裡，hooks 裡沒有任何一支看 pkill（2026-10-21 盤點，規格 P3）。
 * 指令字串在這台機器上不是身分；只有自己記下的 pid／背景任務 id 是。
 *
 * ## 判準
 *
 * 先用 shell-git 的 stripData 拿掉確定是資料的部分（heredoc 本體、echo／grep 的引號參數、commit 訊息），
 * 再照 `&&`／`;`／`|`／`$(`／反引號拆段，跳過 sudo／nohup／timeout／env／xargs／ssh 主機／bash -c 這類前綴，
 * 看每段真正要跑的指令：
 *   · `pkill`：擋，除非旗標位置帶 `-P <pid>`（只殺某個 pid 的子程序，等於用 pid 指定；`-P 1` 不算）
 *   · `killall`：擋（只有 `-l` 列訊號放行；`-s` 在 macOS 是只列出、在 Linux 是送訊號，不放）
 *   · 用 pgrep／pidof／全機 ps 找到的 pid 拿去 kill：`kill $(pgrep …)`、`p=$(pgrep …); kill $p`、for／while read 迴圈、`| xargs kill`：擋
 *   · `taskkill /IM`／`/FI "IMAGENAME…"`、`Stop-Process -Name`、`Get-Process <名字> | Stop-Process`、`-match`／`-like` 篩選後接 Stop-Process：擋
 * `pgrep` 單獨查詢、`kill 123`、`kill -9 $PID`、`kill %1`、`lsof -ti :port | xargs kill` 都放行。
 *
 * ## 逃生門
 *
 *     touch ~/.claude/skills/home/claude/hooks/kill-guard.off
 *
 * 稽核寫在 kill-guard.log。重播近 14 天：`node replay-p3.mjs kill 14`。
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendLog } from './lib/log.mjs';
import { cli, isMain } from './lib/hook-cli.mjs';
import { stripData } from './lib/shell-git.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OFF = join(HERE, 'kill-guard.off');
const LOG = join(HERE, 'kill-guard.log');

/**
 * 這些字開頭的段，真正的指令在後面。值：need＝自己吃掉幾個非旗標參數（ssh 的主機、timeout 的秒數），
 * flags＝哪些旗標後面接一個值（各指令自己的表：sudo -n、env -i 不帶值，共用一張會把 pkill 本身當值吃掉，PR #11 審查）。
 * shell 關鍵字（do／then／!）也算前綴：迴圈與條件式裡的 pkill 才看得到。
 */
const PREFIX = {
  sudo: { flags: 'ugpCUrtTDRh' }, env: { flags: 'uSCP' }, nice: { flags: 'n' }, caffeinate: { flags: 'w' }, watch: { flags: 'nd' },
  timeout: { need: 1, flags: 'sk', long: ['--signal', '--kill-after'] }, gtimeout: { need: 1, flags: 'sk', long: ['--signal', '--kill-after'] },
  xargs: { flags: 'nILPsEdJR' }, ssh: { need: 1, flags: 'bcDEeFIiJLlmOopQRSWwB' },
  doas: { flags: 'uC' }, stdbuf: { flags: 'ioe' },
  nohup: {}, exec: {}, builtin: {}, time: {}, command: {},
  do: {}, then: {}, else: {}, elif: {}, if: {}, while: {}, until: {}, '!': {},
};
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash']);

const base = (w) => w.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '');

/** 一段 → 真正要跑的指令的字（含參數），前綴剝掉。 */
export function realCommand(seg) {
  const words = seg.trim().split(/\s+/).filter(Boolean);
  let i = 0;
  for (let guard = 0; guard < 20 && i < words.length; guard++) {
    const w = words[i];
    if (/^\w+=/.test(w)) { i++; continue; }                     // VAR=值
    const b = base(w);
    if (Object.hasOwn(PREFIX, b)) {
      const { need: n0 = 0, flags = '', long = [] } = PREFIX[b];
      if (b === 'command' && /^-[vV]$/.test(words[i + 1] ?? '')) return [];   // command -v pkill：只是查路徑
      i++;
      let need = n0;
      while (i < words.length) {
        const x = words[i];
        if (x === '--') { i++; break; }
        if (x.startsWith('-') && x.length > 1) {
          const takes = long.includes(x) || (x.length === 2 && flags.includes(x[1]));
          i += takes ? 2 : 1;
          continue;
        }
        if (/^\w+=/.test(x) && b === 'env') { i++; continue; }
        if (need > 0) { need--; i++; continue; }
        break;
      }
      continue;
    }
    if (SHELLS.has(b) && words[i + 1] === '-c') { i += 2; continue; }   // bash -c '…'（引號已在 stripData 換成空白）
    break;
  }
  return words.slice(i);
}

/** `-P <pid>` 寫在旗標位置（前面只有旗標）而且值是 pid（不是 1＝launchd 底下全部）：只殺自己子程序，等於用 pid 指定。 */
function byParent(args) {
  for (let k = 0; k < args.length; k++) {
    const a = args[k];
    if (!a.startsWith('-')) return false;                       // 先出現 pattern：-P 是 pattern 裡的字
    const v = a === '-P' || a === '--parent' ? args[k + 1] : /^-P(.+)$/.exec(a)?.[1];
    if (v !== undefined) return /^(?:\d+|\$\{?\w+\}?|\$\$)$/.test(v) && v !== '1';
  }
  return false;
}

/** kill 的參數全是字面 pid／訊號／%job 才算「自己記的 pid」。 */
const literalKill = (args) => args.length > 0 && args.every((a) => /^(?:-\w+|-s|\d+|%\d+)$/.test(a)) && args.some((a) => /^(?:\d+|%\d+)$/.test(a));

/** 回傳擋下的理由種類，放行回 null。 */
export function classify(cmd) {
  if (typeof cmd !== 'string' || !/pkill|killall|pgrep|pidof|\bps\b|taskkill|stop-process|spps|get-process|\bgps\b|-name\b/i.test(cmd)) return null;
  // `2>&1`／`&>` 先拿掉：stripData 的白名單照單一 `&` 拆段，`2>&1` 會被拆出一個叫 `1` 的指令，
  // 整串就退回「引號換空白、heredoc 全留」，heredoc 裡寫到 `pkill -f` 的文件也被擋（重播實測）。
  // grep／awk／sed 的引號參數是 pattern，裡面的 `|` 不是管線（`grep -E 'claude|pkill'`）：先換成空白。
  let c = cmd.replace(/\d*[<>]&\d*-?|&>>?/g, ' ');
  for (let k = 0, prev = null; k < 10 && prev !== c; k++) {
    prev = c;
    c = c.replace(/(\b(?:grep|egrep|fgrep|rg|awk|sed|jq)\b[^|;&\n'"]*)(['"])[^'"\n]*\2/g, '$1 ');
  }
  // 寫檔的 heredoc（cat／tee <<'EOF'，同一行沒有接 `| bash`）本體是資料：其他段落不在 stripData 的白名單時它會整段留著，自己先拿掉。
  // 餵給 python／node 這類直譯器的也一樣：本體是那個語言的程式，不是殼層指令（`python3 - <<'EOF'` 改檔案裡寫到 pkill 的字串，重播實測 1 筆）。
  // 程式名要是那一段的第一個字（`bash ~/perl-tools/run.sh <<'EOF'` 的 perl 不算），到 `<<` 之間不准有 `;`／`&`／`|`：
  // `python3 x.py && bash <<'EOF'` 的 heredoc 是 bash 的（PR #14 兩輪審查）。
  c = c.replace(/((?:^|[\n;&|(])\s*(?:\S*\/)?(?:cat|tee|python3?|node|ruby|perl)(?=[ \t])[^\n|;&]*<<-?\s*(['"])(\w+)\2[^\n|]*\n)[\s\S]*?\n\s*\3[ \t]*(?=\n|$)/g, '$1');
  const s = stripData(c);
  // 用名字找 pid 的指令：pgrep（-P <pid> 除外）、pidof、看全機程序表的 ps（-e／-A／ax／aux）
  const FIND = String.raw`(?:\S*\/)?(?:pgrep|pidof|ps\s+(?:-?[a-zA-Z]*[eAx][a-zA-Z]*)(?=\s|$))`;
  // 從找名字的指令拿到 pid 的變數：p=$(pgrep …)、for p in $(ps -ef | grep …)、pgrep … | while read p
  const vars = new Set();
  for (const m of s.matchAll(new RegExp(String.raw`(\w+)=\$\(\s*${FIND}`, 'g'))) vars.add(m[1]);
  for (const m of s.matchAll(new RegExp(String.raw`\bfor\s+(\w+)\s+in\s+\$\(\s*${FIND}`, 'g'))) vars.add(m[1]);
  for (const m of s.matchAll(new RegExp(String.raw`${FIND}[^;\n]*\|\s*while\s+read\s+(?:-\w+\s+)*(\w+)`, 'g'))) vars.add(m[1]);
  for (const seg of s.split(/&&|\|\||[;\n&(){}`|]|\$\(/)) {
    const w = realCommand(seg);
    if (!w.length) continue;
    const b = base(w[0]).toLowerCase();
    const args = w.slice(1);
    if (b === 'pkill') { if (byParent(args)) continue; return 'pkill'; }
    // killall 一律擋（只列訊號的 -l 除外）：macOS 的 -s 是「只列出」，Linux（psmisc）的 -s 是送訊號，分不出來
    if (b === 'killall') { if (args.length && args.every((a) => a === '-l')) continue; return 'killall'; }
    // 10-20 的事故：p=$(pgrep -f …); kill $p。kill 自己記的 $PID（不是從 pgrep 來的）放行；kill -0 只是查還活著沒。
    if (b === 'kill' && vars.size && !args.includes('-0') && args.some((x) => [...vars].some((v) => x.includes(`$${v}`) || x.includes(`\${${v}}`)))) return 'kill-pgrep';
  }
  // kill $(pgrep …)／kill `pidof …`／kill $(ps -ef | grep … | awk …)，含 /bin/kill；kill -0 不算
  if (new RegExp(String.raw`(?:^|[\s;&|(])(?:\S*\/)?kill\b(?![^;&|\n]*\s-0\b)[^;&|\n]*(?:\$\(|` + '`' + String.raw`)\s*${FIND}`).test(s)) return 'kill-pgrep';
  // 管線一路接到 xargs kill：pgrep … | xargs kill、ps aux | grep x | awk … | xargs kill（lsof -ti :port | xargs kill 不算）
  if (new RegExp(String.raw`(?:^|[\s;&|(])${FIND}[^;\n]*\|\s*(?:\S+\s+)*?xargs\s+(?:-\S+\s+(?:\d+\s+)?)*(?:\S*\/)?kill\b`).test(s)) return 'kill-pgrep';
  // Windows：常包在 `powershell -Command "…"`／`ssh desk '…'` 裡，直接看整串
  if (/(?:^|[\s;&|(])taskkill(?:\.exe)?\b[^;&|\n]*\s[/-]IM\b/i.test(s)) return 'taskkill';
  if (/(?:^|[\s;&|(])taskkill(?:\.exe)?\b[^;&|\n]*\s[/-]FI\b[^;&|\n]*IMAGENAME/i.test(s)) return 'taskkill';
  // PowerShell 的 Stop-Process 有別名 spps、kill
  if (/\b(?:Stop-Process|spps|kill)\b[^;|\n]*\s-(?:Name|ProcessName)\b/i.test(s)) return 'stop-process';
  if (/\b(?:Get-Process|gps)\s+(?!-Id\b)(?:-(?:Name|ProcessName)\s+)?[\w*.-]+[^|;\n]*\|\s*(?:Stop-Process|spps|kill)\b/i.test(s)) return 'stop-process';
  if (/-(?:match|like)\b[^;\n]*\|\s*(?:Stop-Process|spps|kill)\b/i.test(s)) return 'stop-process';
  return null;
}

const REASON =
  '【自動檢查】不准用名字或指令字串殺程序（pkill／killall／kill $(pgrep …)）：同一台機器上別的 session 跑著一樣的指令，會一起被殺' +
  '（2026-10-20 誤殺四個 lane 的 push）。改用自己記下的 pid：`kill <pid>`，背景任務用 TaskStop（Claude Code）／自己記的 tmux 窗格（Codex）；' +
  '真的只能找就先 `pgrep -f …` 列出來、`lsof -a -p <pid> -d cwd` 確認是自己的，再逐個 `kill <pid>`。';

/** 回 null＝放行。這支壞掉不該擋住任何指令（dispatch 會吃掉例外）。 */
export function run(input) {
  if (existsSync(OFF)) return null;
  const cmd = input?.tool_input?.command;
  const kind = classify(cmd);
  if (!kind) return null;
  appendLog(LOG, { at: new Date().toISOString(), session: input?.session_id, kind, cwd: input?.cwd, cmd: String(cmd).slice(0, 400) });
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: REASON,
    },
  };
}

if (isMain(import.meta.url)) cli(run);
