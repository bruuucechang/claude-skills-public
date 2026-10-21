/**
 * 把一條 Bash 指令拆成「真的會執行的簡單指令」，每個字保留引號資訊。給 commit-message-guard 與 git-author-guard 用。
 *
 * 為什麼不用字串比對（2026-10-21，opt/01-hooks.md §2a）：`cmd.includes('git commit')` 會
 *   · 誤擋 heredoc 本體、`grep 'git commit -m'`、`git commit-tree`；
 *   · 漏擋 `git -C dir commit -m`、`git -c k=v commit -m`、同一條指令裡第二個 commit。
 * 這裡逐字掃：引號、跳脫、`$( )`／反引號（遞迴拆裡面）、heredoc（本體只在餵給會執行它的程式時才遞迴）、
 * 註解、重導向。不是完整的 shell 解析器：拆不了（引號沒收尾、heredoc 沒收尾）就回 null，呼叫端退回舊判法（寧可多擋）。
 *
 * 字：{ value: 去掉引號後的值, raw: 原文, parts: [{ q: "'"|'"'|"$'"|'$'|'\\'|'', s }] }
 * 指令：{ words: [字…], heredocs: [{ body, expand }…], tainted }
 *   · heredocs 也收 here-string（`<<< 字`）；expand＝本體會先被殼層展開（分隔字沒加引號、雙引號字串）
 *   · tainted＝這條指令是從一段**會先被展開**的字串裡拆出來的（`bash -c "…"`、沒加引號的 heredoc 餵給 bash、ssh），
 *     看到的字不是 git 最後收到的字，引號例外不能算數
 *   · group＝這條指令跑在哪個殼層（{ parent, remote? }）：`( … )`、`$( … )`、`bash -c` 各自開新的，裡面的 cd 不影響外面；
 *     ssh 拆出來的標 remote（跑在別台機器）
 * 順序就是執行順序：`$( … )` 裡的在包它的指令前面，bash -c／heredoc 拆出來的緊接在來源指令後面。
 */

/** 這個字在殼層裡會不會被展開（命令替換、變數、跳脫）：單引號以外的部分有 ` $ \ 就算。 */
export const expands = (w) => w.parts.some((p) => p.q === '$' || (p.q !== "'" && /[`$\\]/.test(p.s)));

/** 只是把參數當資料（印、比對、存檔、當訊息）的程式：它們的引號參數與 heredoc 本體不會被當指令跑。 */
export const DATA_CMDS = new Set(['echo', 'printf', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'cat', 'tee', 'jq', 'head', 'tail',
  'wc', 'sort', 'uniq', 'less', 'more', 'pbcopy', 'sed', 'awk', 'git', 'gh', 'diff', 'ls', 'test', '[', 'true', 'false', ':',
  'mkdir', 'touch', 'rm', 'cp', 'mv', 'ln', 'cd', 'pushd', 'popd', 'basename', 'dirname', 'realpath', 'stat', 'date', 'sleep']);

/** 指令開頭可以跳過的前綴（後面接的才是真正的程式名）。 */
const PREFIX = new Set(['env', 'command', 'exec', 'builtin', 'xcrun', 'sudo', 'nice', 'nohup', 'time', 'caffeinate']);
/** 控制結構的關鍵字：出現在指令開頭時跳過。 */
const KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'fi', 'do', 'done', 'while', 'until', '!', '{', '}', 'time']);

/** 去掉前綴、VAR=值之後的程式名（basename）與它在 words 裡的位置。 */
export function head(words) {
  let i = 0;
  while (i < words.length) {
    const w = words[i];
    const v = w.value;
    if (KEYWORDS.has(v) && !w.parts.some((p) => p.q)) { i++; continue; }
    if (/^[A-Za-z_]\w*=/.test(w.raw)) { i++; continue; }
    const name = v.replace(/^.*\//, '');
    if (PREFIX.has(name)) {
      i++;
      // env／sudo 的旗標（-i、-u user 這種）跳過；遇到不是旗標的字就是程式名
      while (i < words.length && /^-/.test(words[i].value)) i += /^-(u|g|C|n)$/.test(words[i].value) ? 2 : 1;
      continue;
    }
    return { name, at: i };
  }
  return { name: '', at: words.length };
}

/** 找對應的 `)`，跳過引號與巢狀括號。i 指向 `$(` 的 `(` 之後。回 `)` 的位置，找不到回 -1。 */
function closeParen(t, i) {
  let depth = 1;
  while (i < t.length) {
    const c = t[i];
    if (c === '\\') { i += 2; continue; }
    if (c === "'") { const j = t.indexOf("'", i + 1); if (j < 0) return -1; i = j + 1; continue; }
    if (c === '"') {
      let j = i + 1;
      while (j < t.length && t[j] !== '"') j += t[j] === '\\' ? 2 : 1;
      if (j >= t.length) return -1;
      i = j + 1; continue;
    }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
    i++;
  }
  return -1;
}

/**
 * 拆成簡單指令。回 null＝拆不了（引號、`$( )`、heredoc 沒收尾）。
 * 會遞迴：`$( )`、反引號、餵給非資料程式的 heredoc 本體、`bash -c`／`eval` 這類的字串。
 */
export function parse(text, depth = 0, tainted = false, group = { parent: null }) {
  if (depth > 6) return null;
  const t = String(text);
  const n = t.length;
  const out = [];
  let words = [];
  let heredocs = [];
  let w = null;
  const pending = [];          // 這一行開的 heredoc：{ tag, tabs, cmd }
  let skipNext = false;        // 重導向的目標檔名不是參數
  let hereStr = false;         // 下一個字是 here-string（`<<<`）的內容
  let pipeFrom = null;         // 上一條指令以 `|` 接過來（`cat <<EOF | bash`、`echo '…' | sh`）
  let fail = false;
  const groups = [group];      // ( … ) 開的子殼層

  const word = () => (w ??= { value: '', raw: '', parts: [] });
  const push = (q, s, raw) => { const x = word(); x.value += s; x.raw += raw; const last = x.parts.at(-1); if (last && last.q === q && !q) last.s += s; else x.parts.push({ q, s }); };
  const endWord = () => {
    if (!w) return;
    if (hereStr) { hereStr = false; heredocs.push({ body: w.value, expand: expands(w) }); }
    else if (skipNext) skipNext = false; else words.push(w);
    w = null;
  };
  const endCmd = () => {
    endWord();
    if (words.length || heredocs.length) { const c = { words, heredocs, prev: pipeFrom, tainted, group: groups.at(-1) }; out.push(c); pipeFrom = null; }
    words = []; heredocs = [];
  };
  const nested = (inner) => {
    const r = parse(inner, depth + 1, tainted, { parent: groups.at(-1) });
    if (r === null) { fail = true; return; }
    out.push(...r);
  };

  let i = 0;
  while (i < n && !fail) {
    const c = t[i];
    // 跳脫：行尾的反斜線是接續行
    if (c === '\\') {
      if (t[i + 1] === '\n') { i += 2; continue; }
      push('\\', t[i + 1] ?? '', t.slice(i, i + 2)); i += 2; continue;
    }
    if (c === "'") {
      const j = t.indexOf("'", i + 1);
      if (j < 0) return null;
      push("'", t.slice(i + 1, j), t.slice(i, j + 1)); i = j + 1; continue;
    }
    if (c === '$' && t[i + 1] === "'") {
      let j = i + 2;
      while (j < n && t[j] !== "'") j += t[j] === '\\' ? 2 : 1;
      if (j >= n) return null;
      push("$'", t.slice(i + 2, j), t.slice(i, j + 1)); i = j + 1; continue;
    }
    if (c === '"') {
      let j = i + 1, s = '';
      while (j < n && t[j] !== '"') {
        if (t[j] === '\\') { s += t.slice(j, j + 2); j += 2; continue; }
        if (t.startsWith('$(', j) && t[j + 2] !== '(') {
          const e = closeParen(t, j + 2);
          if (e < 0) return null;
          nested(t.slice(j + 2, e)); s += t.slice(j, e + 1); j = e + 1; continue;
        }
        if (t[j] === '`') {
          let e = j + 1;
          while (e < n && t[e] !== '`') e += t[e] === '\\' ? 2 : 1;
          if (e >= n) return null;
          nested(t.slice(j + 1, e)); s += t.slice(j, e + 1); j = e + 1; continue;
        }
        s += t[j]; j++;
      }
      if (j >= n) return null;
      push('"', s, t.slice(i, j + 1)); i = j + 1; continue;
    }
    if (c === '$' && t[i + 1] === '(' && t[i + 2] !== '(') {
      const e = closeParen(t, i + 2);
      if (e < 0) return null;
      nested(t.slice(i + 2, e)); push('$', t.slice(i, e + 1), t.slice(i, e + 1)); i = e + 1; continue;
    }
    if (c === '`') {
      let e = i + 1;
      while (e < n && t[e] !== '`') e += t[e] === '\\' ? 2 : 1;
      if (e >= n) return null;
      nested(t.slice(i + 1, e)); push('$', t.slice(i, e + 1), t.slice(i, e + 1)); i = e + 1; continue;
    }
    if (c === '#' && !w) { while (i < n && t[i] !== '\n') i++; continue; }
    // heredoc：<<、<<-，分隔字可帶引號；<<< 是 here-string，後面那個字是資料
    if (t.startsWith('<<', i) && t[i + 2] !== '<') {
      const m = t.slice(i).match(/^<<(-?)[ \t]*(?:'([^'\n]*)'|"([^"\n]*)"|\\?([^\s;&|<>()'"]+))/);
      if (m) {
        if (w && /^\d+$/.test(w.raw)) w = null;
        endWord();
        const quoted = m[2] !== undefined || m[3] !== undefined || m[0].includes('\\');
        pending.push({ tag: m[2] ?? m[3] ?? m[4], tabs: !!m[1], expand: !quoted, at: out.length, words });
        i += m[0].length; continue;
      }
    }
    if (t.startsWith('<<<', i)) { endWord(); i += 3; hereStr = true; continue; }
    if (c === '>' || c === '<' || (c === '&' && t[i + 1] === '>')) {
      if (w && /^\d+$/.test(w.raw)) w = null;   // 2>、1> 的 fd 不是參數
      endWord();
      i += c === '&' ? 2 : 1;
      if (t[i] === '>' || t[i] === '|') i++;
      if (t[i] === '&') { i++; const m = t.slice(i).match(/^(\d+|-)/); if (m) { i += m[0].length; continue; } }
      if (t[i] === '(') { continue; }            // <(…)、>(…)：process substitution，交給下面的 ( 處理
      skipNext = true; continue;
    }
    if (c === '\n') {
      endCmd();
      i++;
      for (const h of pending.splice(0)) {
        let body = '', closed = false;
        while (i <= n) {
          let e = t.indexOf('\n', i); if (e < 0) e = n;
          const line = t.slice(i, e);
          i = e + 1;
          if ((h.tabs ? line.replace(/^\t+/, '') : line) === h.tag) { closed = true; break; }
          body += line + '\n';
          if (e >= n) break;
        }
        if (!closed) return null;
        // 找出開這個 heredoc 的那條指令（它的 words 陣列）
        const cmd = out.slice(h.at).find((x) => x.words === h.words) ?? out.find((x) => x.words === h.words);
        const doc = { body, expand: h.expand };
        if (cmd) cmd.heredocs.push(doc);
        else out.push({ words: h.words, heredocs: [doc], tainted, group: groups.at(-1) });
      }
      continue;
    }
    if (c === '|' && t[i + 1] !== '|') {
      endCmd(); pipeFrom = out.at(-1) ?? null; i += t[i + 1] === '&' ? 2 : 1; continue;
    }
    if (c === '(') { endCmd(); groups.push({ parent: groups.at(-1) }); i++; continue; }
    if (c === ')') { endCmd(); if (groups.length > 1) groups.pop(); i++; continue; }
    if (c === ';' || c === '|' || c === '&') {
      endCmd(); i += c === '|' || (c === '&' && t[i + 1] === '&') ? 2 : 1; continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') { endWord(); i++; continue; }
    push('', c, c); i++;
  }
  if (fail) return null;
  endCmd();
  if (pending.length) return null;

  // 第二輪：會把字串或 heredoc 當指令跑的程式，遞迴拆它們（緊接在來源指令後面）。來源會先被展開的，拆出來的指令標 tainted。
  const result = [];
  let cur = null;
  const sub = (s, expand, strict = true, remote = false) => {
    const r = parse(s, depth + 1, tainted || expand, { parent: cur.group, ...(remote ? { remote: true } : {}) });
    if (r === null) return !strict;
    result.push(...r); return true;
  };
  const strs = (c) => [
    ...c.words.slice(head(c.words).at + 1).filter((a) => a.parts.some((p) => p.q)).map((a) => ({ body: a.value, expand: expands(a) })),
    ...c.heredocs,
  ];
  for (const cmd of out) {
    result.push(cmd);
    cur = cmd;
    const { name, at } = head(cmd.words);
    if (!name) continue;
    const args = cmd.words.slice(at + 1);
    if (/^(?:ba|z|da|k|fi)?sh$/.test(name)) {
      const ci = args.findIndex((a) => /^-\w*c\w*$/.test(a.value));
      if (ci >= 0 && args[ci + 1]) { if (!sub(args[ci + 1].value, expands(args[ci + 1]))) return null; }
      else {
        // 從 stdin 讀指令的殼層：自己的 heredoc／here-string，或管線上一條指令的引號參數與 heredoc
        for (const d of [...cmd.heredocs, ...(cmd.prev ? strs(cmd.prev) : [])]) if (!sub(d.body, d.expand)) return null;
      }
      continue;
    }
    if (name === 'eval') { if (!sub(args.map((a) => a.value).join(' '), args.some(expands))) return null; continue; }
    if (DATA_CMDS.has(name)) continue;
    // 不認得的前綴程式（timeout、xargs、ssh host、stdbuf…）後面直接接 git：從 git 那個字重新當一條指令
    const k = args.findIndex((a) => a.parts.every((p) => !p.q) && a.value.replace(/^.*\//, '') === 'git');
    if (k >= 0) result.push({ words: args.slice(k), heredocs: cmd.heredocs, prev: cmd.prev, tainted: tainted || name === 'ssh', group: name === 'ssh' ? { parent: null, remote: true } : cmd.group });
    // 其他字串或 heredoc 裡寫到 git 就拆來看（ssh '…'、python3 -c、寧可多擋）；ssh 的遠端殼層會再展開一次
    for (const d of strs(cmd)) if (/\bgit\b/.test(d.body)) sub(d.body, d.expand || name === 'ssh', false, name === 'ssh');
  }
  return result;
}

/** git 的全域選項裡，後面要接一個參數的。 */
const GIT_ARG_OPTS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--exec-path', '--super-prefix', '--list-cmds']);

/**
 * 指令裡每一個 git 呼叫：{ sub, args, C: [-C 的目錄…], config: { key: value }, env: { 前綴 VAR: 值 }, words, heredocs, tainted }。
 * 拆不了回 null。
 */
export function gitCalls(text) {
  const cmds = parse(text);
  return cmds === null ? null : cmds.map(gitCall).filter(Boolean);
}

/** 一條簡單指令如果是 git 呼叫就回上面那個形狀，不是回 null。 */
export function gitCall(cmd) {
  const { name, at } = head(cmd.words);
  if (name !== 'git') return null;
  const C = [], config = {};
  let i = at + 1;
  const ws = cmd.words;
  while (i < ws.length) {
    const v = ws[i].value;
    if (!v.startsWith('-')) break;
    const [opt, eq] = v.startsWith('--') && v.includes('=') ? [v.slice(0, v.indexOf('=')), v.slice(v.indexOf('=') + 1)] : [v, null];
    if (GIT_ARG_OPTS.has(opt) && eq === null && opt !== '--exec-path') {
      const val = ws[i + 1]?.value ?? '';
      if (opt === '-C') C.push(val);
      if (opt === '-c') { const k = val.indexOf('='); config[(k < 0 ? val : val.slice(0, k)).toLowerCase()] = k < 0 ? 'true' : val.slice(k + 1); }
      i += 2; continue;
    }
    i++;
  }
  if (i >= ws.length) return null;
  // 指令前綴的 VAR=值（GIT_AUTHOR_EMAIL=… git commit）
  const env = {};
  for (const x of ws.slice(0, at)) { const m = /^([A-Za-z_]\w*)=(.*)$/s.exec(x.value); if (m) env[m[1]] = m[2]; }
  return { sub: ws[i].value, args: ws.slice(i + 1), C, config, env, words: ws, heredocs: cmd.heredocs ?? [], prev: cmd.prev ?? null, tainted: !!cmd.tainted };
}
