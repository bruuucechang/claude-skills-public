#!/usr/bin/env node
/**
 * PreToolUse(Bash) hook —— 擋會整片丟掉工作區改動的 git 指令：`reset --hard`、`checkout .`、`restore .`、
 * `clean -f`、`branch -D`、不帶 pathspec 的 `stash`。`git push` 不管（那是 pr-guard／pushq-guard 的事）。
 *
 * ## 為什麼
 *
 * 這台機器常有好幾個 session 共用同一份工作區（AGENTS.md「只 add 自己動過的檔」）。上面這幾個指令不分是誰改的，
 * 一次把整個 repo 的未 commit 改動清掉，而且收不回來——別的 session 半天的工作會安靜地不見。
 * 來源：mattpocock/skills@5beb35b `skills/misc/git-guardrails-claude-code/scripts/block-dangerous-git.sh:6-16`
 * （規格 home/claude/docs/2026-10-23-borrowed-skills/，X1）；原腳本也擋 push，那條不搬。
 *
 * ## 判準
 *
 * 用 lib/shell-words 拆成真的會執行的 git 呼叫（heredoc 本體、echo／grep 的引號參數、commit 訊息不算；
 * `bash -c`、`ssh host '…'` 裡的照算），逐個看：
 *   · `reset --hard`：擋，**除非**指令會經過的每個目錄（cwd、照順序走過的 cd、疊上去的 `-C`）只要是 repo 就乾淨
 *     （`status --porcelain -uno` 空）——那時它只是移動分支，記憶 only-my-own-repos 的「沒推出去就 `git reset --hard @{u}`」就是這種。
 *     不看目標是不是 `@{u}`：清掉的是工作區，跟退到哪個 commit 無關。git 查不到（逾時、錯誤）、cd 到變數、
 *     `--git-dir`／`--work-tree`／`GIT_DIR`、ssh 遠端、經過一次展開的字串：一律擋。
 *   · `checkout`／`restore` 的 pathspec 是整個 repo（`.`、`..`、`*`、`:/`、`:(top)`、repo 根的絕對路徑、含 `$` 看不到的）：擋；
 *     `restore --staged .`（只取消暫存）、`-p` 逐塊選放行
 *   · `checkout -f`／`switch -f`／`--discard-changes`：擋（切分支時把改動丟掉）
 *   · `clean` 帶 `-f`／`--force`、或 `-c clean.requireForce=false`（不含 `-n` 乾跑）：擋
 *   · `branch -D`／`--delete --force`／`-df`：擋
 *   · `stash`、`stash push`／`save` 沒有 pathspec、`stash clear`：擋；`stash list／show／pop／apply` 放行
 *   · `-c alias.x=…` 臨時別名照展開再判；`!` 開頭（跑 shell）直接擋
 * 不管：`git push`、`worktree remove --force`、`checkout-index -f`、`read-tree -u --reset`（少見，要擋另開）。
 * 已知誤擋：餵給不認得的程式的引號字串寫到這些指令（`codex exec '不要跑 git stash'`）——shell-words 會拆來看。
 *   工作單改用 heredoc 或檔案餵（`codex exec - <<'EOF'` 不會誤擋）。
 * 拆不了（引號沒收尾）就退回對 stripData 後的字串做粗比對，寧可多擋。
 *
 * ## 逃生門
 *
 *     touch ~/.claude/skills/home/claude/hooks/git-wipe-guard.off
 *
 * 稽核寫在 git-wipe-guard.log。
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendLog } from './lib/log.mjs';
import { cli, isMain } from './lib/hook-cli.mjs';
import { git, expand, stripData } from './lib/shell-git.mjs';
import { expands, gitCall, head, parse } from './lib/shell-words.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OFF = join(HERE, 'git-wipe-guard.off');
const LOG = join(HERE, 'git-wipe-guard.log');

/** 代表「整個 repo」的 pathspec：`.`、`./`、`*`、`..`／`../..`（在子目錄裡往上）、`:/`、`:/*`、`:(top)`。 */
const WHOLE = /^(?:\.\.?(?:\/\.\.)*\/?\*?|\*|:\/\.?\*?|:\((?:top|icase|glob|literal|,)+\)\*?)$/;

/** 這個 pathspec 是不是整個 repo：上面那幾種、一定指向根目錄的變數（`$PWD`、`$(pwd)`、`$(git rev-parse --show-toplevel)`）、或本身就是某個 repo 的根目錄。
 *  其他變數（`"$f"`、`$BRANCH`）放行：日常就這樣寫，剛好指向整個 repo 的很少見。 */
function whole(p, cwd) {
  if (WHOLE.test(p) || /^(?:\$\{?PWD\}?|\$\(pwd\)|`pwd`|\$\(git rev-parse --show-toplevel\))\/?$/.test(p)) return true;
  if (/[$`]/.test(p)) return false;
  if (!/^[~/]/.test(p)) return false;
  return existsSync(join(expand(p, cwd), '.git'));
}

/** 把 `-xdf` 這種合在一起的短旗標拆開看有沒有某個字母。 */
const shortHas = (args, ch) => args.some((a) => /^-[a-zA-Z]+$/.test(a) && a.includes(ch));

/** pathspec：`--` 之後的全部；沒有 `--` 時是不以 - 開頭、也不是某個旗標的值的字。 */
function pathspecs(args, valued = new Set()) {
  const dd = args.indexOf('--');
  if (dd >= 0) return args.slice(dd + 1);
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('-')) { if (valued.has(a)) i++; continue; }
    out.push(a);
  }
  return out;
}

/**
 * 一個 git 呼叫（sub＋參數字串＋`-c` 設定）→ 擋的種類，放行回 null。reset --hard 回 'reset-hard'，由呼叫端看工作區乾不乾淨。
 * `-c alias.x=…` 臨時定義的別名照展開再判；`!` 開頭的別名跑 shell，看不到內容，直接擋。
 */
export function kindOf(sub, args, config = {}, cwd = process.cwd(), depth = 0) {
  const alias = config[`alias.${sub.toLowerCase()}`];
  if (alias !== undefined && depth < 3) {
    if (alias.startsWith('!')) return 'alias';
    const [s2 = '', ...a2] = alias.trim().split(/\s+/);
    return kindOf(s2, [...a2, ...args], config, cwd, depth + 1);
  }
  if (sub === 'reset') return args.includes('--hard') ? 'reset-hard' : null;
  if (sub === 'checkout' || sub === 'switch') {
    if (args.includes('-p') || args.includes('--patch')) return null;    // 互動逐塊選，不會整片清掉
    // `checkout -f <分支>`／`switch -f`／`--discard-changes`：切過去時把改動丟掉
    if (args.includes('--force') || args.includes('--discard-changes') || shortHas(args, 'f')) return 'checkout-all';
    if (sub === 'switch') return null;
    const dd = args.indexOf('--');
    // 沒有 `--` 時 `git checkout . ` 的 . 也是 pathspec；`git checkout main` 是切分支
    const specs = dd >= 0 ? args.slice(dd + 1) : args.filter((a) => !a.startsWith('-'));
    return specs.some((p) => whole(p, cwd)) ? 'checkout-all' : null;
  }
  if (sub === 'restore') {
    if (args.includes('-p') || args.includes('--patch')) return null;
    const staged = args.includes('--staged') || shortHas(args, 'S');
    const worktree = args.includes('--worktree') || shortHas(args, 'W');
    if (staged && !worktree) return null;                       // 只取消暫存，不碰檔案內容
    return pathspecs(args, new Set(['-s', '--source'])).some((p) => whole(p, cwd)) ? 'restore-all' : null;
  }
  if (sub === 'clean') {
    if (args.includes('-n') || args.includes('--dry-run') || shortHas(args, 'n')) return null;
    // `-c clean.requireForce=false` 不帶 -f 也會刪
    return args.includes('--force') || shortHas(args, 'f') || config['clean.requireforce'] === 'false' ? 'clean-f' : null;
  }
  if (sub === 'branch') {
    const del = args.includes('--delete') || shortHas(args, 'd');
    const force = args.includes('--force') || shortHas(args, 'f');
    return shortHas(args, 'D') || (del && force) ? 'branch-D' : null;
  }
  if (sub === 'stash') {
    const [verb = '', ...rest] = args;
    if (verb === 'clear') return 'stash';
    if (['list', 'show', 'pop', 'apply', 'branch', 'drop', 'create', 'store'].includes(verb)) return null;
    // `git stash`、`git stash -u`、`git stash push [-m 訊息]`、`git stash save "訊息"`
    if (verb === 'save') return 'stash';                         // save 的參數是訊息，不是 pathspec
    const opts = verb === 'push' ? rest : args;
    const specs = pathspecs(opts, new Set(['-m', '--message', '--pathspec-from-file']));
    return specs.length && !specs.some((p) => whole(p, cwd)) ? null : 'stash';
  }
  return null;
}

/**
 * 這個目錄的已追蹤檔有沒有改動：true＝乾淨、false＝有改動或查不到（逾時、其他錯誤）、null＝不是 repo（也不存在）。
 */
function clean(dir) {
  if (!existsSync(dir)) return null;
  try { git(dir, ['rev-parse', '--is-inside-work-tree'], 2000); } catch (e) { return e?.status === 128 ? null : false; }
  try { return git(dir, ['status', '--porcelain', '--untracked-files=no'], 2000) === ''; } catch { return false; }
}

/**
 * reset --hard 可能在哪些目錄跑：cwd 加上照順序走過的每個 cd／pushd（拆好的指令，heredoc 與引號裡的不算；`cd ..` 對上一個解析），
 * 再把 `-C` 照 git 的規則疊上去（`-C a -C b`＝a/b）。回 null＝看不出來（cd 到變數、`cd -`）。
 */
function resetDirs(cmds, cwd, C) {
  const bases = [cwd];
  for (const x of cmds) {
    const { name, at } = head(x.words);
    if (name !== 'cd' && name !== 'pushd') continue;
    const w = x.words.slice(at + 1).find((a) => !/^-[LPe@]+$/.test(a.value));
    if (w && (expands(w) || w.value === '-')) return null;
    bases.push(expand(w ? w.value : '~', bases.at(-1)));
  }
  return bases.map((b) => C.reduce((d, x) => expand(x, d), b));
}

/**
 * 回傳擋下的種類，放行回 null。isClean(dir) 可注入（測試用），預設真的問 git。
 */
export function classify(cmd, cwd = process.cwd(), isClean = clean) {
  if (typeof cmd !== 'string' || !/\b(?:reset|checkout|switch|restore|clean|branch|stash)\b|alias\./.test(cmd)) return null;
  const cmds = parse(cmd);
  if (cmds === null) return fallback(cmd);
  for (const c of cmds.map(gitCall).filter(Boolean)) {
    const kind = kindOf(c.sub, c.args.map((a) => a.value), c.config, cwd);
    if (!kind) continue;
    if (kind !== 'reset-hard') return kind;
    // 遠端、展開過的字串、另外指定 git 目錄或工作區：看不到它在哪跑
    if (c.tainted || c.prev || c.words.some((w) => /[$`]/.test(w.raw) || /^--(?:git-dir|work-tree)\b/.test(w.value))) return kind;
    if ('GIT_DIR' in c.env || 'GIT_WORK_TREE' in c.env || /\bGIT_(?:DIR|WORK_TREE)=/.test(cmd)) return kind;
    const dirs = resetDirs(cmds, cwd, c.C);
    if (!dirs) return kind;
    const states = dirs.map(isClean);
    // 查不到（false）或有改動就擋；不是 repo 的中途目錄（null）不算；一個 repo 都沒有也擋
    if (states.includes(false) || !states.includes(true)) return kind;
  }
  return null;
}

/** 拆不了的指令：粗比對，寧可多擋。reset --hard 在這裡一律擋（不知道在哪個 repo 跑）。 */
function fallback(cmd) {
  const s = stripData(cmd);
  const G = String.raw`(?:^|[\s;&|(\`])(?:\S*\/)?git\b(?:\s+-[cC]\s+\S+|\s+--?[\w-]+(?:=\S+)?)*\s+`;
  const re = (x) => new RegExp(G + x);
  if (/(?:^|\s)-c\s+\S*alias\./.test(s)) return 'alias';
  if (re(String.raw`reset\b[^;&|\n]*\s--hard\b`).test(s)) return 'reset-hard';
  if (re(String.raw`(?:checkout|switch)\b[^;&|\n]*\s(?:-\w*f\w*|--force|--discard-changes)\b`).test(s)) return 'checkout-all';
  if (re(String.raw`(?:checkout|restore)\b[^;&|\n]*\s(?:\.\.?\/?|:\/\S*|:\(\S*|\*|\S*\$\S*)(?=[\s;&|)]|$)`).test(s)) return 'checkout-all';
  if (re(String.raw`clean\b(?![^;&|\n]*\s(?:-\w*n\w*|--dry-run)\b)[^;&|\n]*\s(?:-\w*f\w*|--force)\b`).test(s)) return 'clean-f';
  if (/clean\.requireForce=false/i.test(s)) return 'clean-f';
  if (re(String.raw`branch\b[^;&|\n]*\s(?:-\w*D|-\w*d\w*f|-\w*f\w*d|--delete\b[^;&|\n]*--force|--force\b[^;&|\n]*--delete)`).test(s)) return 'branch-D';
  if (re(String.raw`stash\b(?!\s+(?:list|show|pop|apply|drop|branch|create|store)\b)(?!\s+(?:push\s+)?(?:(?:-m|--message|--pathspec-from-file)\s+\S+(?:\s+|(?=[;&|)]|$))|-(?!m\b|-message\b|-pathspec-from-file\b)\S+\s+)*(?:--\s+)?(?!(?:push|save|clear)\b|\.\/?(?:\s|$)|:)[^\s;&|)\-*$][^\s;&|)]*)`).test(s)) return 'stash';
  return null;
}

const WHY = '這台機器常有好幾個 session 共用同一份工作區，這個指令不分是誰改的、一次清掉整個 repo 的未 commit 改動，收不回來。';
const ALT = {
  'reset-hard': '只還原自己動過的檔：`git restore <檔>`；要退 commit 但保留檔案：`git reset --soft <目標>`／`git reset <目標>`。' +
    '（工作區已追蹤的檔都沒改動時 `reset --hard` 會自動放行——先 `git status` 確認只剩自己的東西、處理掉再跑。）',
  'checkout-all': '只還原自己動過的檔：`git restore <檔>`（或 `git checkout -- <檔>`），逐個列出來。',
  'restore-all': '只還原自己動過的檔：`git restore <檔>`，逐個列出來；只是要取消暫存用 `git restore --staged .`。',
  'clean-f': '先 `git clean -n` 看會刪哪些，再 `rm` 自己建的檔（逐個列出來）。',
  'branch-D': '用 `git branch -d <分支>`（沒合併會拒絕，等於幫你檢查）；確定要丟掉沒合併的 commit，先問使用者。',
  alias: '`-c alias.x=…` 臨時定義的別名看不到最後跑什麼，直接寫出真正的 git 指令。',
  stash: '只收自己的檔：`git stash push -- <檔>…`；`stash clear` 會丟掉所有人的 stash，不要用。',
};

/** 回 null＝放行。這支壞掉不該擋住任何指令（dispatch 會吃掉例外）。 */
export function run(input) {
  if (existsSync(OFF)) return null;
  const cmd = input?.tool_input?.command;
  const kind = classify(cmd, input?.cwd || process.cwd());
  if (!kind) return null;
  appendLog(LOG, { at: new Date().toISOString(), session: input?.session_id, kind, cwd: input?.cwd, cmd: String(cmd).slice(0, 400) });
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `【自動檢查】不准用會整片清掉工作區的 git 指令（${kind}）。${WHY}${ALT[kind]}`,
    },
  };
}

if (isMain(import.meta.url)) cli(run);
