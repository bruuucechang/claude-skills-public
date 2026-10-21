/**
 * 擋 git 指令的 hook 共用的小工具：路徑展開、realpath、問 git、共用的 git 目錄。
 * pushq-guard 與 pr-guard 原本各抄一份，cd 解析的 bug 要修兩次（PR #1 第四次審查）。
 */
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { config } from './config.mjs';

const HOME = homedir();

export const expand = (p, cwd) => resolve(cwd, p.replace(/^["']|["']$/g, '').replace(/^~(?=\/|$)/, HOME).replace(/^\$HOME(?=\/|$)/, HOME).replace(/^\$\{HOME\}(?=\/|$)/, HOME));

export const real = (p) => { try { return realpathSync(p); } catch { return resolve(p); } };

// maxBuffer：上萬個檔的 log 超過預設 1MB 會丟例外，被呼叫端當成「判斷不了」放行（PR #2 審查實測 3 萬個 .py）
export const git = (dir, args, timeout = 3000) =>
  execFileSync('git', ['-C', dir, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout, maxBuffer: 512 * 1024 * 1024 }).trim();

/** 共用的 git 目錄（lane worktree 也指回主 repo）；不是 repo 回 null。 */
export function commonDir(dir) {
  try { return real(resolve(dir, git(dir, ['rev-parse', '--git-common-dir'], 2000))); } catch { return null; }
}

/** 擋直推只管這個帳號的 repo（only-my-own-repos：判準是 remote owner）。GitHub 的 owner 不分大小寫。
 *  帳號讀 config.json 的 github_owner；沒設就是空字串，isMine 永遠 false（等於不擋）。 */
export const OWNER = String(config().github_owner || '').toLowerCase();
export const ownerOf = (url) => (url || '').match(/[:/]([^/:]+)\/[^/]+?(?:\.git)?\/?$/)?.[1]?.toLowerCase() ?? null;
export const isMine = (url) => !!OWNER && ownerOf(url) === OWNER;

/** 照 `&&`／`||`／`;`／`|`／換行拆段。引號裡的分隔符號也會被拆——夠用，不是 shell 解析器。 */
export const segments = (cmd) => cmd.split(/&&|\|\||[;|\n]/);

/** 不會把資料當指令跑的指令。整條指令每一段都在這裡面，stripData 才拿掉資料（PR #5 第三輪審查：改白名單）。 */
const SAFE = new Set(['cat', 'tee', 'git', 'gh', 'echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg', 'pbcopy', 'head', 'tail',
  'wc', 'sort', 'uniq', 'diff', 'ls', 'cd', 'pushd', 'popd', 'pwd', 'mkdir', 'touch', 'cp', 'mv', 'rm', 'ln', 'test', 'true',
  'false', 'jq', 'sleep', 'date', 'basename', 'dirname', 'realpath', 'stat']);
/** heredoc 本體只是餵進去的資料（存檔、commit 訊息、PR 內文）的指令。 */
const HEREDOC_SINKS = new Set(['cat', 'tee', 'git', 'gh']);
/** 引號字串只是要印出或比對的文字的指令。 */
const DATA_CMDS = new Set(['echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg']);
/** 值是文字（commit 訊息、PR 標題內文）的旗標：-m、-am、--body、--body=、gh 的 -b／-t。 */
const DATA_FLAG = /^(?:-[a-zA-Z]*m|--(?:message|body|title|notes)=?|-[bt])$/;

/** 一段指令的指令名（跳過開頭的 VAR=值）。 */
const cmdWord = (seg) => seg.trimStart().replace(/^(?:\w+=\S*\s+)*/, '').match(/^[^\s;&|()<>]*/)[0].replace(/^.*\//, '');

/** 每一段都是 SAFE 的指令、沒有命令替換當指令、沒有 `$x` 當指令。 */
function allSafe(out) {
  if (/(?:^|[;&|\n(])\s*(?:\$\(|`)/.test(out)) return false;
  for (const raw of out.split(/&&|\|\||[;|\n&(){}`]|\$\(/)) {
    const seg = raw.trim().replace(/^(?:\w+=\S*\s+)*/, '');
    if (!seg || /^\w+=\S*$/.test(seg)) continue;
    const word = seg.match(/^\S+/)[0];
    if (word.startsWith('$') || !SAFE.has(word.replace(/^.*\//, ''))) return false;
    if (word.endsWith('printf') && /\s-v\b/.test(seg)) return false;              // printf -v 是賦值
    if (/(?:^|\/)git$/.test(word) && /!|\s-c\s|--exec/.test(seg)) return false;    // git -c alias.x='!sh'
  }
  return true;
}

/**
 * 拿掉指令裡「確定是資料」的部分，給 push 偵測用：餵給 cat／tee／git／gh 的 heredoc 本體、
 * echo／printf／grep 的引號參數、-m／--body 這類旗標的引號值、`#` 註解。
 * 2026-10-21 實測：heredoc 或 `printf '… git push --no-verify …'` 裡寫到這幾個字就被 pr-guard 擋。
 *
 * **白名單**（PR #5 三輪審查）：列「會執行字串的寫法」是黑名單，bash -c、| /bin/sh、./x、python3 -c、
 * git -c alias='!sh'……每輪都漏新的，漏一個就是安靜地放行。改成拿掉之後每一段都是 SAFE 的指令才算數，
 * 否則整串保留、引號換空白（`bash -c 'git push …'` 的 `'git` 才認得出是 git）——認不得頂多誤擋。
 */
export function stripData(cmd) {
  const full = cmd.replace(/\\\n/g, ' ');
  const out = scan(full);
  return out !== null && allSafe(out) ? out : full.replace(/['"]/g, ' ');
}

/** 逐字掃，引號與 heredoc 一起追（`"…<<EOF…"` 才不會被當 heredoc）。有 heredoc 本體得保留就回 null。 */
function scan(text) {
  let out = '';
  let segAt = 0;               // out 裡目前這段的開頭
  let lineAt = 0;              // out 裡這一行的開頭
  let subst = 0;               // 在幾層 $( ) 裡：裡面的 echo 輸出會被拿去用，不算資料
  const pending = [];          // 這一行開的 heredoc：{ tag, tabs, sink }
  const dq = [];               // 含 $( ) 的雙引號開在哪一層 subst
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '\\') { out += text.slice(i, i + 2); i += 2; continue; }
    if (c === '#' && (i === 0 || /[\s;&|()]/.test(text[i - 1]))) { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '"' && dq.at(-1) === subst) { dq.pop(); i++; continue; }   // 收掉含 $( ) 的雙引號
    if (c === "'" || c === '"') {
      const ansi = c === "'" && text[i - 1] === '$';   // $'…' 裡 \' 是跳脫
      let j = i + 1;
      while (j < n && text[j] !== c) j += (c === '"' || ansi) && text[j] === '\\' ? 2 : 1;
      if (j >= n) return null;                         // 沒收尾的引號：判不了
      const inner = text.slice(i + 1, j);
      // "$(cat <<'EOF' … )"：裡面照常掃（heredoc、引號才認得出來），只記住要在這一層收引號
      if (c === '"' && /\$\(|`/.test(inner)) { dq.push(subst); i++; continue; }
      const seg = out.slice(segAt);
      const data = !subst && /\s/.test(inner) && !inner.includes('\n') && !(c === '"' && /\$\(|`/.test(inner))
        && (DATA_CMDS.has(cmdWord(seg)) || DATA_FLAG.test(seg.trimEnd().split(/\s+/).pop()));
      out += data ? '_' : inner;
      i = j + 1; continue;
    }
    if (text.startsWith('<<', i) && text[i + 2] !== '<' && !/[<\d]/.test(text[i - 1] ?? '')) {
      const m = text.slice(i).match(/^<<(-?)\s*(?:'([^'\n]+)'|"([^"\n]+)"|\\?([^\s;&|<>()'"]+))/);
      if (m) {
        pending.push({ tag: m[2] ?? m[3] ?? m[4], tabs: !!m[1], sink: HEREDOC_SINKS.has(cmdWord(out.slice(segAt))) });
        out += m[0]; i += m[0].length; continue;
      }
    }
    if (c === '\n' && pending.length) {
      if (/(?<!\|)\|(?!\|)/.test(out.slice(lineAt))) return null;   // cat <<EOF | 別的程式
      i++;
      for (const { tag, tabs, sink } of pending.splice(0)) {
        if (!sink) return null;
        let closed = false;
        while (i < n) {
          let e = text.indexOf('\n', i); if (e < 0) e = n;
          const line = text.slice(i, e);
          i = e + 1;
          if ((tabs ? line.replace(/^\t+/, '') : line) === tag) { closed = true; break; }
        }
        if (!closed) return null;
      }
      out += '\n'; segAt = lineAt = out.length; continue;
    }
    if (text.startsWith('$(', i) && text[i + 2] !== '(') { subst++; out += '$('; i += 2; segAt = out.length; continue; }
    if (c === ')' && subst) subst--;
    out += c; i++;
    if (/[;&|\n(`)]/.test(c)) segAt = out.length;
    if (c === '\n') lineAt = out.length;
  }
  return pending.length ? null : out;
}

/** 指令裡真的會執行的 git push 段（pr-guard 與 pushq-guard 共用，引號／heredoc 的判法才一致）。 */
export const pushSegments = (cmd) => segments(stripData(cmd)).filter(isPushSeg);

/** 這一段是不是 git push（含帶路徑的 git、xcrun git、git 與 push 之間有全域旗標）。 */
export const isPushSeg = (s) => /(?:^|[\s(`$])(?:\S*\/)?git\b.*\spush\b/.test(s);

/** 這一段有沒有 --no-verify（後面可以緊接 ; ) 引號）。 */
export const hasNoVerify = (s) => /(?:^|\s)--no-verify(?=[\s;&|)'"]|$)/.test(s);

/** 指令可能在哪些目錄跑：cwd、cd／pushd 的目標、-C 的目錄（寧可多列）。變數（"$W"）展不開，hook 看不到。 */
export function repoDirs(cmd, cwd) {
  const dirs = [cwd];
  for (const m of cmd.matchAll(/(?:^|[\s;&(])(?:cd|pushd)\s+("[^"]+"|'[^']+'|[^\s;&|)]+)/g)) dirs.push(expand(m[1], cwd));
  for (const m of cmd.matchAll(/\s-C\s+("[^"]+"|'[^']+'|\S+)/g)) dirs.push(expand(m[1], cwd));
  return dirs;
}
