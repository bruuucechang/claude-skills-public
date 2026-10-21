#!/usr/bin/env node
/**
 * PreToolUse(Bash) —— git 作者不是 bruuucechang 的有效身分就擋 commit。
 *
 * 2026-10-20 從 settings.json 的 inline shell 搬成 JS（給 dispatch.mjs 呼叫），判斷逐字照舊：
 *   · 指令字串含 `git commit` 才查
 *   · 找第一個以 `cd <路徑>` 開頭的行，到 `&`／`;`／`|` 為止就是路徑（`~` 開頭換成 HOME），
 *     cd 不進去就用目前目錄——跟 `sed -n 's/^[[:space:]]*cd…/p' | head -1` 一樣
 *   · 在那裡 `git config user.email`，不是下面兩個之一就擋
 * Codex 也經分派器跑這一支（2026-10-20 H5 起；以前的 git-author-guard.sh 已拿掉）。
 *
 * 2026-10-21 改：用 lib/shell-words.mjs 找真的會執行的 `git … commit`／`commit-tree`（heredoc 本體、
 * grep 樣式不算），而且認得全域旗標——
 *   · `git -C <dir>`：在 cd 目標底下再進 <dir>（多個 -C 依序疊）查作者
 *   · `git -c user.email=…`／`-c author.email=…`、前綴 `GIT_AUTHOR_EMAIL=…`、`--author=`：那一次 commit 用的就是這個值，直接拿它判
 *   · 每個 commit 用它前面最近的 `cd`；`R=/path; git -C "$R"` 這種同一條指令裡設的變數會代進去
 *   （外面設的變數 hook 看不到，那時退回 cd 目標，跟舊版一樣）
 * 每一個 commit 呼叫都查，任一個不對就擋。拆不了指令才退回舊判法（含 `git commit` 字串就查 cd 目標）。
 * 案例表：node test-git-author-guard.mjs
 */
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { cli, isMain } from './lib/hook-cli.mjs';
import { gitCall, head, parse } from './lib/shell-words.mjs';

const OK = ['you@example.com', '262371352+bruuucechang@users.noreply.github.com'];

/** sed 那一段的 JS 版。回傳要 cd 的路徑字串（原樣，含引號），沒有就 ''。 */
export function cdTarget(cmd) {
  for (const line of cmd.split('\n')) {
    const m = /^[ \t\v\f\r]*cd[ \t\v\f\r]+([^&;|]*)/.exec(line);
    if (m) return m[1].replace(/[ \t\v\f\r]+$/, '');
  }
  return '';
}

const home = (d) => (d === '~' || d.startsWith('~/') ? homedir() + d.slice(1) : d);
const isDir = (p) => { try { return statSync(p).isDirectory(); } catch { return false; } };

/**
 * 暫存目錄裡、沒有 GitHub remote 的 repo（測試腳本的 `git init` 假 repo）不查：推不上 GitHub，身分錯也沒有後果。
 * replay 實測 14 天 9 筆是這種（`T=$S/hooktest; cd $T && git -c user.email=t@t commit`）。
 * scratchpad 裡的 PR worktree 有 GitHub remote，照查。
 */
// Windows 上前綴比對前換成正斜線＋小寫：不換的話 C:\…\Temp\x 永遠比不到 C:\…\Temp/，磁碟機代號也可能 C:／c: 不一致。
// 只在 win32 做：POSIX 路徑裡的反斜線是合法字元。
const slash = (p) => (process.platform === 'win32' ? p.replace(/\\/g, '/').toLowerCase() : p);
const TMP_ROOTS = [tmpdir(), '/tmp', '/private/tmp', '/var/folders', '/private/var/folders'].map((d) => slash(d).replace(/\/$/, '') + '/');
export function throwaway(dir) {
  if (!TMP_ROOTS.some((r) => (slash(dir) + '/').startsWith(r))) return false;
  try {
    const remotes = execFileSync('git', ['remote', '-v'], { cwd: dir, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    return !/github\.com/i.test(remotes);
  } catch { return false; }
}

/** 這個目錄的身分設定：user／author／committer 的 email 與 name（一次 git 呼叫讀完）。 */
const idConfig = (cwd) => {
  const out = {};
  try {
    const t = execFileSync('git', ['config', '--get-regexp', '^(user|author|committer)\\.(email|name)$'], { cwd, encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    for (const line of t.split('\n')) { const i = line.indexOf(' '); if (i > 0) out[line.slice(0, i).toLowerCase()] = line.slice(i + 1); }
  } catch {}
  return out;
};

/**
 * 要查的每一個 commit：{ dir, author: { email?, name? }, committer: { email?, name? } }（有值＝指令本身覆寫的）。沒有 commit 回 []。
 * 照執行順序走：`cd`／`pushd`／`popd` 換目錄，只影響它所在的殼層（`( … )`、`$( … )`、`bash -c` 裡的 cd 不帶出來）；
 * `X=值` 單獨一條就記下來給 `$X` 用。git 的作者與提交者是兩個身分，兩個都要對：
 *   作者：`--author="名 <信箱>"`＞前綴 `GIT_AUTHOR_EMAIL=`＞`-c author.email`＞`-c user.email`＞設定檔 author.email＞user.email
 *   提交者：前綴 `GIT_COMMITTER_EMAIL=`＞`-c committer.email`＞`-c user.email`＞設定檔 committer.email＞user.email
 * `--author=名字`（沒有 <信箱>，git 拿去比對既有作者）判不了，當沒寫；覆寫的值裡有 `$(…)`／`$X`（展不開）也當沒寫。
 *
 * **判不準就照舊版**（replay 實測：測試腳本常 `cd $(mktemp -d) && git -c user.email=t@t commit`、
 * lane 常 `-c user.email=$(git -C … config user.email)`）：cd／-C 的目標解析不出來（變數、還不存在的目錄）、
 * 或跑在 ssh 的遠端，就不套指令裡的覆寫，只查那個目錄設定檔的身分——跟舊版查 cd 目標一樣，不新增誤擋。
 */
export function commitTargets(c, base) {
  const cmds = parse(c);
  if (cmds === null) {
    let dir = base;
    const d = home(cdTarget(c));
    if (d && isDir(resolve(base, d))) dir = resolve(base, d);
    return c.includes('git commit') ? [{ dir, author: {}, committer: {} }] : [];
  }
  const vars = {};
  const sub = (v) => v.replace(/\$\{?([A-Za-z_]\w*)\}?/g, (m, k) => vars[k] ?? m);
  const to = (from, v) => { const p = resolve(from, home(sub(v))); return isDir(p) ? p : null; };
  // 每個殼層自己的目錄與 pushd 堆疊；第一次用到時從上一層當下的目錄繼承
  const state = new Map();
  const st = (g) => {
    if (!g) return { dir: base, stack: [] };
    if (!state.has(g)) {
      const p = g.parent ? st(g.parent) : { dir: base, unsure: false };
      state.set(g, { dir: p.dir, stack: [], unsure: p.unsure || !!g.remote });
    }
    return state.get(g);
  };
  const out = [];
  for (const cmd of cmds) {
    const ws = cmd.words;
    const { name, at } = head(ws);
    const s = st(cmd.group);
    if (!name) {
      for (const w of ws) { const m = /^([A-Za-z_]\w*)=(.*)$/s.exec(w.value); if (m) vars[m[1]] = sub(m[2]); }
      continue;
    }
    const go = (v) => { const p = to(s.dir, v); if (p) s.dir = p; else s.unsure = true; };
    if (name === 'cd' && ws[at + 1]) { go(ws[at + 1].value); continue; }
    if (name === 'pushd' && ws[at + 1]) { s.stack.push(s.dir); go(ws[at + 1].value); continue; }
    if (name === 'popd') { if (s.stack.length) s.dir = s.stack.pop(); continue; }
    const g = gitCall(cmd);
    if (!g || (g.sub !== 'commit' && g.sub !== 'commit-tree')) continue;
    let dir = s.dir, unsure = s.unsure;
    for (const x of g.C) { const p = to(dir, x); if (p) dir = p; else unsure = true; }
    if (unsure) { out.push({ dir, author: {}, committer: {} }); continue; }
    const lit = (v) => (v == null || /[`$]/.test(v) ? undefined : v);   // 展不開的值當沒寫
    const env = Object.fromEntries(Object.entries(g.env).map(([k, v]) => [k, lit(v)]));
    const cfgo = Object.fromEntries(Object.entries(g.config).map(([k, v]) => [k, lit(v)]));
    const ai = g.args.findIndex((a) => a.value === '--author' || a.value.startsWith('--author='));
    const av = ai < 0 ? '' : g.args[ai].value === '--author' ? (g.args[ai + 1]?.value ?? '') : g.args[ai].value.slice('--author='.length);
    const am = /[`$]/.test(av) ? null : /^(.*?)\s*<([^>]*)>\s*$/.exec(av);
    out.push({
      dir,
      author: {
        email: am?.[2] ?? env.GIT_AUTHOR_EMAIL ?? cfgo['author.email'] ?? cfgo['user.email'],
        name: am?.[1] ?? env.GIT_AUTHOR_NAME ?? cfgo['author.name'] ?? cfgo['user.name'],
      },
      committer: {
        email: env.GIT_COMMITTER_EMAIL ?? cfgo['committer.email'] ?? cfgo['user.email'],
        name: env.GIT_COMMITTER_NAME ?? cfgo['committer.name'] ?? cfgo['user.name'],
      },
    });
  }
  return out;
}

export function run(input) {
  const c = input?.tool_input?.command;
  if (typeof c !== 'string' || !/\bgit\b/.test(c) || !c.includes('commit')) return null;

  const base = input.cwd || process.cwd();
  let e = null, n = null, role = '';
  for (const t of commitTargets(c, base)) {
    if (throwaway(t.dir)) continue;
    const cfg = idConfig(t.dir);
    const who = {
      作者: [t.author.email ?? cfg['author.email'] ?? cfg['user.email'] ?? '', t.author.name ?? cfg['author.name'] ?? cfg['user.name'] ?? ''],
      提交者: [t.committer.email ?? cfg['committer.email'] ?? cfg['user.email'] ?? '', t.committer.name ?? cfg['committer.name'] ?? cfg['user.name'] ?? ''],
    };
    const bad = Object.entries(who).find(([, [email]]) => !OK.includes(email));
    if (bad) { [role, [e, n]] = bad; break; }
  }
  if (e === null) return null;

  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        `這個 repo 的 git ${role}是 "${n} <${e}>"，不是 GitHub 帳號 bruuucechang 底下的任一個有效身分（${OK[0]} 或 ${OK[1]}）。` +
        '這台機器已經有 134 筆 commit 用主機名推導的假信箱、6 筆用 work@example.com，那些推上去不會掛到帳號、顯示成沒有頭像的匿名作者。' +
        `先跑：git config user.name bruce && git config user.email ${OK[0]}`,
    },
  };
}

if (isMain(import.meta.url)) cli(run);
