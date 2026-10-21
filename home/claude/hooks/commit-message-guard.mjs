#!/usr/bin/env node
/**
 * PreToolUse(Bash) hook —— `git commit -m` 擋掉（只放行不含 \ 與 $ 的單引號字串），訊息走 `-F - <<'MSG'`。
 *
 * ## 為什麼這件事非得是機制
 *
 * 「commit 訊息一律用 `-F`」這條規則寫在記憶檔 `commit-message-use-file` 裡
 * 已經很久了，而**同一個坑踩了五次**。最後一次（2026-09-24，trip-atlas）：
 *
 *     git commit -m "$(printf '…（−6.9%%）…')"
 *                                    ↑ printf 把 `%` 當格式指示字吃掉
 *     → 推上去的訊息在那裡**整段截斷**
 *
 * 而它已經 push 了，`AGENTS.md` 禁止改寫已推的歷史（別台可能 pull 過），
 * 所以**修不掉**，只能補一個 commit 說明前一個被截斷。
 *
 * 五次的成因各不相同，但形狀完全一樣——**訊息在到達 git 之前先經過一層
 * 殼層展開**，而展開的結果沒有人看：
 *
 *     反引號        `…` 被 zsh 當指令執行，訊息漏字（記憶檔裡記了三次）
 *     `%`          `printf` 的格式指示字，從那裡截斷
 *     `$(…)`／`$X`  命令替換與變數展開
 *     `!`          zsh 的歷史展開
 *
 * **失敗是安靜的。** `git commit` 回 0、`git log` 看起來正常（只是短了），
 * 而錯誤要等推上去、別人讀到，或者下次回頭翻歷史時才看得見。
 *
 * ## 判準：只看有沒有 `-m`，不看訊息內容
 *
 * 一度想「只在訊息含危險字元時才擋」。不行——**能不能安全展開，取決於引號
 * 的層數與誰先展開**，那正是每次都判斷錯的地方。用「有沒有危險字元」當條件，
 * 等於把同一個判斷再做一次，而它已經錯了五次。
 *
 * 所以條件是純語法的：**`git commit` 帶了 `-m`／`--message`／`-am` 就擋**。
 * `-F`／`--file`／`--amend --no-edit`／`-C` 全部放行，它們不經過殼層。
 *
 * 代價是「一個字的 commit 也要先寫檔」。實測那是多一次 Write，
 * 而它換掉的是一個**推上去就修不掉**的錯。
 *
 * ## 唯一的例外：`-m '<單引號字串>'`（2026-10-21 使用者裁示）
 *
 * 138 次擋下裡 87 次是本來就安全的字串（commit-message-guard.log 2026-09-24〜10-21；新舊比對重跑 `node replay.mjs <舊 ref> 14`）。單引號裡殼層什麼都不展開，所以放行
 * **`-m` 後面整個字就是一段單引號、裡面沒有 `\` 也沒有 `$`** 的寫法——這仍是純語法判斷，
 * 不是在判斷「展開安不安全」。`-m "…"`、`-m$'…'`、`-am`、`--message=`、單引號接別的字串一律照擋。
 *
 * ## 認 git 指令的方法（2026-10-21）
 *
 * 以前是 `cmd.includes('git commit')`：heredoc 本體、`grep 'git commit -m'`、`git commit-tree` 被誤擋，
 * `git -C dir commit -m`、`git -c k=v commit -m`、第二個 commit 漏擋。現在用 lib/shell-words.mjs
 * 拆成真的會執行的簡單指令，每一個子指令是 `commit` 的 git 呼叫都看；拆不了才退回舊判法。
 * 案例表：node test-commit-message-guard.mjs
 *
 * ## 逃生門
 *
 *     touch ~/.claude/skills/home/claude/hooks/commit-message-guard.off
 *
 * 稽核寫在 commit-message-guard.log（擋下來的每一筆都留著，
 * 之後可以實際量它有沒有擋到真的東西，還是只在礙事）。
 */

import { existsSync } from 'node:fs';
import { appendLog } from './lib/log.mjs';
import { expands, gitCalls } from './lib/shell-words.mjs';
import { cli, isMain } from './lib/hook-cli.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OFF = join(HERE, 'commit-message-guard.off');
const LOG = join(HERE, 'commit-message-guard.log');

/** `-m` 類旗標：-m、--message、--message=…、短旗標叢集裡的 m（-am、-qm）。回旗標文字，不是回 null。 */
function messageFlags(args, tainted) {
  const found = [];
  let stdin = false;                                // -F -：訊息從 stdin（heredoc／here-string）進來
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const v = a.value;
    if (v === '--') break;                          // 之後是路徑
    if (a.parts.some((p) => p.q === "'" || p.q === '"' || p.q === "$'") && !/^-/.test(a.parts[0]?.s ?? '')) continue;
    // --message 與它的縮寫（git 認唯一的前綴：--mes、--mess=…）
    const lm = /^--(m[a-z]*)(=|$)/.exec(v);
    if (lm && 'message'.startsWith(lm[1])) { found.push({ flag: v.split('=')[0], safe: false }); if (!lm[2]) i++; continue; }
    if (v === '--file=-' || ((v === '--file' || v === '-F') && args[i + 1]?.value === '-') || v === '-F-') { stdin = true; continue; }
    if (/^--(file|reuse-message|reedit-message)(=|$)/.test(v)) return { reuse: true };
    if (/^--(squash|fixup)$/.test(v)) { i++; continue; }   // 可以跟 -m 一起用，-m 照樣要看
    // 帶值的長旗標：值不是旗標（--template 只是編輯器的範本，-m 照樣經過殼層，不算重用訊息）
    if (/^--(template|author|date|trailer|cleanup|pathspec-from-file)$/.test(v)) { i++; continue; }
    if (!/^-[a-zA-Z]/.test(v)) continue;
    // 短旗標叢集：m／F／C／c／t 後面（同一個字剩下的，或下一個字）是它的值
    for (let k = 1; k < v.length; k++) {
      const ch = v[k];
      if (ch === 'F' && (v.slice(k + 1) === '-' || (k === v.length - 1 && args[i + 1]?.value === '-'))) { stdin = true; if (k === v.length - 1) i++; break; }
      if ('FCc'.includes(ch)) return { reuse: true };
      if (ch === 'm') {
        const attached = k < v.length - 1;
        const val = attached ? null : args[i + 1];
        // 放行的只有：`-m` 獨立一個字，下一個字整個是單引號字串、裡面沒有 \ 也沒有 $
        const safe = !tainted && v === '-m' && !!val && val.parts.length === 1 && val.parts[0].q === "'" && !/[\\$]/.test(val.parts[0].s);
        found.push({ flag: v, safe });
        if (!attached) i++;
        break;
      }
      if ('tuS'.includes(ch)) break;               // 帶值的旗標，剩下的字是它的值
    }
  }
  return { found, stdin };
}

/** 舊判法：整條字串找第一個 `git commit` 之後到分隔符為止。只在拆不了指令時用（寧可多擋）。 */
function legacy(cmd) {
  if (!cmd.includes('git commit')) return null;
  const seg = cmd.slice(cmd.indexOf('git commit') + 'git commit'.length).split(/&&|\|\||[;|]/)[0];
  const flag = seg.match(/(?:^|\s)(-{1,2}m(?:essage)?|-[a-zA-Z]*m[a-zA-Z]*)(?=[\s=]|$)/);
  if (!flag) return null;
  if (/(?:^|\s)(-F|--file|-C|--reuse-message|--squash|--fixup)(?=[\s=]|$)/.test(seg)) return null;
  return flag[1];
}

/** 回要擋的旗標（字串），放行回 null。 */
export function badFlag(cmd) {
  const calls = gitCalls(cmd);
  if (calls === null) return legacy(cmd);
  for (const c of calls) {
    if (c.sub !== 'commit') continue;               // commit-tree 是 plumbing，不是這裡管的
    const r = messageFlags(c.args, c.tainted);
    if (r.reuse) continue;                          // `-F`／`-C` 同時在：人自己知道在做什麼（例如 `--amend -C HEAD`）
    const bad = r.found.find((f) => !f.safe);
    if (bad) return bad.flag;
    // `-F - <<MSG`（分隔字沒加引號）或 `<<< "…"`：本體一樣先被殼層展開，有 ` $ \ 就擋
    // 管線送進來的也一樣：`cat <<EOF | git commit -F -`、`printf "…$x" | git commit -F -`
    const piped = c.prev ? [...c.prev.heredocs, ...c.prev.words.filter((w) => expands(w)).map((w) => ({ body: w.raw, expand: true }))] : [];
    if (r.stdin && [...c.heredocs, ...piped].some((d) => d.expand && /[`$\\]/.test(d.body))) return "-F - <<MSG（分隔字沒加引號，本體照樣展開；改成 <<'MSG'）";
  }
  return null;
}

/** 回 null＝放行。這支壞掉不該擋住任何指令。 */
export function run(input) {
  if (existsSync(OFF)) return null;

  const cmd = input?.tool_input?.command ?? '';
  if (typeof cmd !== 'string' || !/\bgit\b/.test(cmd) || !cmd.includes('commit')) return null;
  const flag = badFlag(cmd);
  if (!flag) return null;

  const reason = [
    `commit 訊息不要用 \`${flag}\`，改成 \`git commit -F - <<'MSG'\`（訊息從 heredoc 進、不經殼層展開）。`,
    '',
    '**理由是這個坑已經踩了五次，而且每次都安靜地成功。** 訊息在到達 git 之前',
    '會先被殼層展開一輪，而展開的結果沒有人看：',
    '',
    '    反引號 `…`   被 zsh 當指令執行 → 訊息漏字（記憶檔裡記了三次）',
    '    `%`         `printf` 的格式指示字 → **從那裡整段截斷**（2026-09-24）',
    '    `$(…)`／`$X` 命令替換與變數展開',
    '    `!`         zsh 的歷史展開',
    '',
    '`git commit` 會回 0，`git log` 看起來正常（只是短了）。而一旦 push，',
    'AGENTS.md 禁止改寫已推的歷史，所以**修不掉**。',
    '',
    '改成：',
    '',
    '    git commit -F - <<\'MSG\'      ← 引號要在 MSG 上，否則裡面照樣展開',
    '    <訊息>',
    '    MSG',
    '',
    '唯一放行的 `-m` 寫法：`-m \'<單引號字串>\'`，裡面沒有 `\\` 也沒有 `$`。',
    '',
    '（真的需要繞過：`touch ~/.claude/skills/home/claude/hooks/commit-message-guard.off`）',
  ].join('\n');

  appendLog(LOG, { at: new Date().toISOString(), sid: String(input?.session_id ?? '').slice(0, 8), flag, cmd: cmd.slice(0, 400) });

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

if (isMain(import.meta.url)) cli(run);
