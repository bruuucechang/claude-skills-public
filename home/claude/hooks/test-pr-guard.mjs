#!/usr/bin/env node
// pr-guard.mjs（PreToolUse，只擋 --no-verify）與 home/bin/pr-prepush.mjs（全域 pre-push）的案例表：
//   node test-pr-guard.mjs（全過離開碼 0）
// pr-prepush 走真的 `git push`：暫存目錄開假 remote（路徑裡帶 owner），用 -c hook.* 掛上去，看推不推得出去。
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
// 在建任何暫存目錄之前跳過，不然每跑一次就留一個 pr-guard-cfg-*
// pr-guard 只部署在 mac：pre-push 走 git ≥ 2.55 的設定式 hook（git config hook.*），兩台 Windows 是 git 2.41 也沒裝。
// 照 mac 的環境寫的案例在 Windows 跑會整片紅，那是「沒部署」不是「壞了」，所以明白印出跳過。
if (process.platform === 'win32') { console.log('跳過：pr-guard 只部署在 mac（Windows 沒有 git ≥ 2.55 的設定式 hook）'); process.exit(0); }
// 不讀這台真的全域設定（主 checkout 那份 pr-prepush 會跟著跑、蓋掉要測的這份），改用暫存的全域設定，
// 照 bootstrap 的寫法掛「這個 worktree 的」pr-prepush.mjs——順便測到 bootstrap 那一行本身。
const GLOBAL = join(mkdtempSync(join(tmpdir(), 'pr-guard-cfg-')), 'gitconfig');
process.env.GIT_CONFIG_GLOBAL = GLOBAL;
process.env.GIT_CONFIG_NOSYSTEM = '1';
const ONELINER = (f) => `f='${f}'; [ -f "$f" ] && command -v node >/dev/null 2>&1 || { cat >/dev/null; exit 0; }; exec node "$f"`;
const PREPUSH = join(HERE, '..', '..', 'bin', 'pr-prepush.mjs');
execFileSync('git', ['config', '--file', GLOBAL, 'hook.pr-guard.event', 'pre-push']);
execFileSync('git', ['config', '--file', GLOBAL, 'hook.pr-guard.command', ONELINER(PREPUSH)]);
const { run } = await import(pathToFileURL(join(HERE, 'pr-guard.mjs')).href);

const root = mkdtempSync(join(tmpdir(), 'pr-guard-'));
// 準備動作用使用者的環境跑（測試行程本身帶著 CLAUDECODE，不拿掉的話準備時的推送也會被全域 hook 擋）
const SETUP = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDECODE|CLAUDE_CODE_SESSION_ID|CODEX_THREAD_ID|PUSHQ_PUSHER)$/.test(k)));
const sh = (dir, ...a) => execFileSync('git', ['-C', dir, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], env: SETUP }).trim();
function repo(owner) {
  const bare = join(root, owner, `r${Math.random().toString(36).slice(2, 8)}.git`);
  mkdirSync(bare, { recursive: true });
  sh(bare, 'init', '-q', '--bare', '-b', 'master');
  const w = bare.replace(/\.git$/, '-w');
  execFileSync('git', ['clone', '-q', bare, w], { stdio: 'ignore', env: SETUP });
  sh(w, 'config', 'user.name', 't'); sh(w, 'config', 'user.email', 't@t');
  writeFileSync(join(w, 'README.md'), 'x\n');
  sh(w, 'add', '.'); sh(w, 'commit', '-qm', 'init'); sh(w, 'push', '-q', 'origin', 'master');
  return w;
}
function commit(w, file) {
  mkdirSync(dirname(join(w, file)), { recursive: true });
  writeFileSync(join(w, file), String(Math.random()));
  sh(w, 'add', file); sh(w, 'commit', '-qm', 'c');
}
const HUMAN = SETUP;
const AGENT = { ...HUMAN, CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'test' };
/** 在 w 裡跑一段 shell，回推送有沒有被擋：看遠端那條分支（預設 master）有沒有變。
 *  離開碼不可信：`echo $(git push)` 永遠回 0。 */
const remoteSha = (w, ref) => sh(w, 'ls-remote', 'origin', `refs/heads/${ref}`);
const push = (w, script, env = AGENT, watch = 'master') => {
  const before = remoteSha(w, watch);
  spawnSync('bash', ['-c', script], { cwd: w, env, stdio: 'ignore' });
  return remoteSha(w, watch) === before;
};

const BLOCK = true, PASS = false;
let fail = 0;
function check(want, label, got) {
  if (got !== want) { fail++; console.log(`✗ ${label}：要 ${want ? '擋' : '放'}，結果 ${got ? '擋' : '放'}`); }
  else console.log(`✓ ${label}`);
}
const denied = (cmd, cwd) => run({ tool_input: { command: cmd }, cwd })?.hookSpecificOutput?.permissionDecision === 'deny';

// ── pre-push：PR #1、#2 審查實測繞得過 PreToolUse 正則的寫法，現在由 git 給確切的 ref
const cases = [
  ['git push', '一般 git push'],
  ['echo $(git push origin master)', '命令替換裡的 push'],
  ['git push -u origin HEAD:pr/x && git push origin master', '第二段才推 master'],
  ['git push origin 2>&1', '2>&1 不是 refspec'],
  ['(git push origin master)', '子殼層'],
  ['git push -o ci.skip origin master', '-o 帶值的旗標'],
  ['git push origin HEAD:pr/x master', '第二個 refspec 才是 master'],
  ['git --no-pager push origin master', '其他全域旗標'],
  ['git -c k=v push origin master', '-c 在前面'],
];
for (const [cmd, label] of cases) { const w = repo('bruuucechang'); commit(w, 'a.py'); check(BLOCK, `pre-push：${label}`, push(w, cmd)); }
{ const w = repo('bruuucechang'); commit(w, 'a.py'); sh(w, 'switch', '-q', '-c', 'pr/1-x');
  check(BLOCK, 'pre-push：--all 連 master 一起推', push(w, 'git push --all origin')); }
{ const w = repo('bruuucechang'); commit(w, 'a.py'); sh(w, 'switch', '-q', '-c', 'pr/1-x');
  check(PASS, 'pre-push：推 pr/ 分支', push(w, 'git push -u origin HEAD', AGENT, 'pr/1-x')); }
{ const w = repo('bruuucechang'); sh(w, 'switch', '-q', '-c', 'autoloop/main'); sh(w, 'push', '-q', '-u', 'origin', 'autoloop/main'); commit(w, 'a.py');
  check(PASS, 'pre-push：產線的 autoloop/ 分支（已存在）', push(w, 'git push', AGENT, 'autoloop/main')); }
{ const w = repo('bruuucechang'); sh(w, 'switch', '-q', '-c', 'autoloopx'); sh(w, 'push', '-q', '-u', 'origin', 'autoloopx'); commit(w, 'a.py');
  check(BLOCK, 'pre-push：autoloopx 不是 autoloop/', push(w, 'git push', AGENT, 'autoloopx')); }
{ const w = repo('bruuucechang'); commit(w, 'notes.md'); check(PASS, 'pre-push：只動 .md', push(w, 'git push')); }
{ const w = repo('bruuucechang'); commit(w, 'SKILL.md'); check(BLOCK, 'pre-push：規則檔 SKILL.md', push(w, 'git push')); }
{ const w = repo('bruuucechang'); commit(w, 'a.py'); sh(w, 'switch', '-q', '-c', 'feature-new');
  check(PASS, 'pre-push：遠端還沒有的新分支', push(w, 'git push -u origin feature-new', AGENT, 'feature-new')); }
{ const w = repo('bruuucechang'); commit(w, 'a.py'); check(PASS, 'pre-push：使用者自己在終端機推', push(w, 'git push', HUMAN)); }
{ const w = repo('bruuucechang'); commit(w, 'a.py');
  check(PASS, 'pre-push：從 Claude 開的 Terminal（繼承 CLAUDECODE、沒有 session id）', push(w, 'git push', { ...HUMAN, CLAUDECODE: '1' })); }
{ const w = repo('bruuucechang');
  // 遠端多一筆 a.py、本機只動 .md，pull 之後在 merge commit 裡改 a.py：程式碼只出現在 merge commit
  const other = w + '-2'; execFileSync('git', ['clone', '-q', sh(w, 'remote', 'get-url', 'origin'), other], { stdio: 'ignore' });
  sh(other, 'config', 'user.name', 't'); sh(other, 'config', 'user.email', 't@t');
  writeFileSync(join(other, 'a.py'), 'theirs\n'); sh(other, 'add', 'a.py'); sh(other, 'commit', '-qm', 'theirs'); sh(other, 'push', '-q', 'origin', 'master');
  writeFileSync(join(w, 'notes.md'), 'x'); sh(w, 'add', '.'); sh(w, 'commit', '-qm', 'mine');   // 本機只動 .md
  sh(w, 'pull', '-q', '--no-rebase', 'origin', 'master');
  writeFileSync(join(w, 'a.py'), 'changed in merge\n'); sh(w, 'add', 'a.py'); sh(w, 'commit', '-q', '--amend', '--no-edit');
  if (!sh(w, 'log', '-1', '--format=%P').includes(' ')) throw new Error('測試前提壞了：HEAD 不是 merge commit');
  check(BLOCK, 'pre-push：merge commit 解衝突改的程式碼', push(w, 'git push origin master')); }
{ const w = repo('bruuucechang'); commit(w, 'a.py');
  sh(w, 'config', 'hook.pr-guard.command', ONELINER('/nonexistent/pr-prepush.mjs'));   // repo 設定蓋過全域的同名 hook
  check(PASS, 'pre-push：hook 檔不見了就放行（bootstrap 的寫法），不擋死整台', push(w, 'git push')); }
{ const w = repo('bruuucechang'); commit(w, 'a.py'); check(BLOCK, 'pre-push：Codex（CODEX_THREAD_ID）', push(w, 'git push', { ...HUMAN, CODEX_THREAD_ID: 't' })); }
{ const w = repo('bruuucechang'); commit(w, 'a.py'); check(PASS, 'pre-push：pushq（PUSHQ_PUSHER）', push(w, 'git push', { ...AGENT, PUSHQ_PUSHER: '1' })); }
{ const w = repo('someoneelse'); commit(w, 'a.py'); check(PASS, 'pre-push：別人的 repo', push(w, 'git push')); }
{ const w = repo('BruuuceChang'); commit(w, 'a.py'); check(BLOCK, 'pre-push：owner 大小寫不同（GitHub 不分）', push(w, 'git push')); }
{ const w = repo('bruuucechang');
  for (let i = 0; i < 30000; i++) { if (i % 1000 === 0) mkdirSync(join(w, `big/d${i / 1000}`), { recursive: true }); writeFileSync(join(w, `big/d${Math.floor(i / 1000)}/f${i}.py`), ''); }
  sh(w, 'add', '.'); sh(w, 'commit', '-qm', 'huge');
  const t0 = Date.now();
  check(BLOCK, 'pre-push：3 萬個 .py（輸出超過 1MB 不能放行）', push(w, 'git push'));
  console.log(`  （${Date.now() - t0} ms）`); }
{ const w = repo('bruuucechang');
  for (let i = 0; i < 1200; i++) { mkdirSync(join(w, 'a/b'), { recursive: true }); writeFileSync(join(w, `a/b/n${i}.md`), 'x'); }
  sh(w, 'add', '.'); sh(w, 'commit', '-qm', 'big'); commit(w, 'SKILL.md');
  const t0 = Date.now();
  check(BLOCK, 'pre-push：1200 個 .md 裡夾一個 SKILL.md（分批）', push(w, 'git push'));
  console.log(`  （${Date.now() - t0} ms）`); }

// ── PreToolUse：只擋 --no-verify
{ const w = repo('bruuucechang');
  check(BLOCK, 'PreToolUse：--no-verify 推 master', denied('git push --no-verify origin master', w));
  check(BLOCK, 'PreToolUse：cd 進去再 --no-verify', denied(`cd ${w} && git push --no-verify`, root));
  check(BLOCK, 'PreToolUse：pushd 進去', denied(`pushd ${w} && git push --no-verify`, root));
  check(PASS, 'PreToolUse：--no-verify 推 pr/ 分支', denied('git push --no-verify -u origin pr/1-x', w));
  check(BLOCK, 'PreToolUse：分支名在變數裡（hook 看不到）', denied('git push --no-verify -u origin "$B"', w));
  sh(w, 'switch', '-q', '-c', 'pr/1-lane');
  check(PASS, 'PreToolUse：在 pr/ 分支上 --no-verify 推 HEAD', denied('git push --no-verify -u origin HEAD', w));
  check(BLOCK, 'PreToolUse：在 pr/ 分支上 --no-verify 推 master', denied('git push --no-verify origin master', w));
  sh(w, 'switch', '-q', 'master');
  check(PASS, 'PreToolUse：/opt/homebrew/bin/git（2.55）', denied('/opt/homebrew/bin/git push origin pr/1-x', w));
  check(PASS, 'PreToolUse：-C 的目錄名剛好叫 git', denied(`git -C ${w} push origin master`, w));
  check(PASS, 'PreToolUse：沒帶 --no-verify', denied('git push origin master', w));
  check(BLOCK, 'PreToolUse：/usr/bin/git（Apple 2.50 不跑設定檔的 hook）', denied('/usr/bin/git push origin master', w));
  check(PASS, 'PreToolUse：帶路徑的 git 做別的事', denied('/usr/bin/git status', w));
  check(PASS, 'PreToolUse：前一段有 /git 結尾的路徑', denied('ls ~/tmp/git && git push origin master', w));
  check(PASS, 'PreToolUse：commit --no-verify 之後的 echo push', denied('git commit -F m.txt --no-verify && echo push done', w));
  check(BLOCK, 'PreToolUse：--no-verify 後面緊接分號', denied('git push origin master --no-verify;', w));
  check(BLOCK, 'PreToolUse：xcrun git', denied('xcrun git push origin master', w));
  // 引號字串與 heredoc 本體是資料（2026-10-21 實測誤擋）；但真的會執行的照樣要擋
  check(PASS, 'PreToolUse：printf 字串裡寫到 --no-verify', denied(`printf '%s\\n' 'git push --no-verify origin master' > n.txt`, w));
  check(PASS, 'PreToolUse：grep 樣式裡的 /usr/bin/git push', denied(`grep -n '/usr/bin/git push' a.md && git push origin master`, w));
  check(PASS, 'PreToolUse：heredoc 本體寫到 push', denied(`cat > n.md <<'EOF'\n/usr/bin/git push origin master\ngit push --no-verify\nEOF\ngit push origin master`, w));
  // 白名單外的指令就整串不拿（寧可誤擋）：ssh localhost 會在本機跑，所以 ssh 的 heredoc 也算進來
  check(BLOCK, 'PreToolUse：ssh 的 heredoc（保守誤擋）', denied(`ssh mani <<'EOF'\ngit push --no-verify origin master\nEOF`, w));
  check(BLOCK, 'PreToolUse：ssh … bash -s 的 heredoc（保守誤擋）', denied(`ssh mani 'bash -s' <<'EOF'\ngit push --no-verify origin master\nEOF`, w));
  check(PASS, 'PreToolUse：PR 內文的 heredoc 寫到 push', denied(`git add . && gh pr create --body "$(cat <<'EOF'\n修 git push --no-verify origin master 的誤擋\nEOF\n)"`, w));
  check(PASS, 'PreToolUse：<<\\EOF 的結尾是 EOF', denied(`cat <<\\EOF > n.md\ngit push --no-verify origin master\nEOF`, w));
  check(PASS, 'PreToolUse：git commit -m 的訊息寫到 push', denied(`git commit -m "擋 git push --no-verify origin master"`, w));
  check(PASS, 'PreToolUse：refspec 加了引號仍看得到 pr/', denied('git push --no-verify origin "HEAD:pr/1-x"', w));
  check(BLOCK, 'PreToolUse：bash -c 字串裡的 push', denied(`bash -c 'git push --no-verify origin master'`, w));
  check(BLOCK, 'PreToolUse：eval 字串裡的 push', denied(`eval "git push --no-verify origin master"`, w));
  check(BLOCK, 'PreToolUse：餵給 bash 的 heredoc', denied(`bash <<'EOF'\ngit push --no-verify origin master\nEOF`, w));
  check(BLOCK, 'PreToolUse：加了引號的 /usr/bin/git', denied(`'/usr/bin/git' push origin master`, w));
  check(BLOCK, 'PreToolUse：前面有引號字串，後面真的推', denied(`echo "all done" && git push --no-verify origin master`, w));
  check(PASS, 'PreToolUse：縮排的 EOF 不是 heredoc 結尾', denied(`cat <<'EOF'\n  EOF\ngit push --no-verify\nEOF`, w));
  check(PASS, 'PreToolUse：註解裡寫到 push', denied(`# git push --no-verify 會跳過 hook\ngit status`, w));
  // PR #5 第一輪審查實測：拿掉資料時不准把真的會執行的推吃掉
  const NV = 'git push --no-verify origin master';
  for (const [label, c] of [
    ['命令替換', `out="$(${NV} 2>&1)"`], ['雙引號裡的反引號', 'echo "r: `' + NV + '`"'],
    ['註解裡的撇號', `# don't skip\n${NV} # it's fine`], ['跳脫的撇號', `echo it\\'s ok && ${NV} && echo 'done'`],
    ['here-string', `grep -q x <<< "hello"\n${NV}`], ['算術位移', `n=$((1<<3))\n${NV}`], ['引號裡的 <<EOF', `echo "use <<EOF"\n${NV}`],
    ['cat heredoc | bash', `cat <<'EOF' | bash\n${NV}\nEOF`], ['cd 之後 bash heredoc', `cd ~/x && bash <<'EOF'\n${NV}\nEOF`],
    ['env 之後 bash heredoc', `env FOO=1 bash <<'EOF'\n${NV}\nEOF`], ['bash -o pipefail -c', `bash -o pipefail -c '${NV}'`],
    ['dash -c', `dash -c '${NV}'`], ['路徑有空白的 git', `"/opt/my tools/git" push --no-verify origin master`],
    // 第二輪
    ['here-string 餵 bash', `bash <<< '${NV}'`], ['$\'…\' 裡的 \\\'', `echo $'don\\'t' && ${NV} && echo 'ok'`],
    ['bash<<EOF 沒空白', `bash<<'EOF'\n${NV}\nEOF`], ['| bash; 之後還有指令', `cat <<'EOF' | bash; echo done\n${NV}\nEOF`],
    ['. /dev/stdin', `. /dev/stdin <<'EOF'\n${NV}\nEOF`], ['PR 內文有落單的雙引號', `gh pr create --body "$(cat <<'EOF'\nfix "x\nEOF\n)" && ${NV} && echo "done now"`],
    ['結尾標記有連字號', `cat > n.md <<END-OF-NOTE\nhi\nEND-OF-NOTE\n${NV}`], ['((1<<3))', `((n = 1<<3))\n${NV}`],
    ['bash -ce', `bash -ce '${NV}'`], ['bash -c --', `bash -c -- '${NV}'`], ['tmux 字串', `tmux new -d 'cd ~/x && ${NV}'`],
    ['watch 字串', `watch '${NV}'`], ['su -c', `su u -c '${NV}'`], ['反斜線續行', `git push \\\n  --no-verify origin master`],
    ['echo | bash', `echo '${NV}' | bash`], ['bash <(echo …)', `bash <(echo '${NV}')`],
    ['寫完腳本再跑', `cat > x.sh <<'EOF'\n${NV}\nEOF\nbash x.sh`], ['沒結尾的 heredoc', `cat <<EOF\n${NV}`],
    // 第三輪（白名單）
    ['| /bin/bash', `echo '${NV}' | /bin/bash`], ['| $SHELL', `echo '${NV}' | $SHELL`], ['$(echo …) 當指令', `$(echo '${NV}')`],
    ['git push $(echo …)', `git push origin master $(echo '--no-verify x')`], ['寫完沒副檔名的腳本 ./x', `cat > x <<'EOF'\n${NV}\nEOF\nchmod +x x && ./x`],
    ['python3 -c', `echo '${NV}' | python3 -c 'import os,sys; os.system(sys.stdin.read())'`], ['printf -v', `printf -v c '%s' '${NV}'; $c`],
    ['git -c alias=!sh', `git -c alias.r='!sh' r <<'EOF'\n${NV}\nEOF`], ['引號裡的 <<TAG', `gh pr comment 5 --body "見 <<END-OF-NOTE"\n${NV}\ncat > n.md <<'END-OF-NOTE'\nhi\nEND-OF-NOTE`],
    ['保留的 heredoc 本體有撇號', `cat <<'EOF' | pbcopy\ngrep it's here\nEOF\ngrep -n 'a b' x.md; ${NV}; echo 'ok now'`],
  ]) check(BLOCK, `PreToolUse：${label}`, denied(c, w));
  for (const [label, c] of [
    ['git commit -am', `git commit -am "擋 ${NV}"`], ['gh pr create -b', `gh pr create -t x -b "擋 ${NV}"`],
    ['--message=', `git commit --message="擋 ${NV}"`], ['提到 .sh 檔名', `git add bootstrap.sh && git commit -F - <<'EOF'\n修 ${NV}\nEOF`],
  ]) check(PASS, `PreToolUse：${label}`, denied(c, w)); }
// pushq-guard 走同一個 pushSegments：直接驗共用的那層（pushq-guard 本身要登記 repo 才會動）
{ const { pushSegments, stripData } = await import(pathToFileURL(join(HERE, 'lib', 'shell-git.mjs')).href);
  check(BLOCK, 'pushSegments：bash -c 裡的推', pushSegments(`bash -c 'git push --no-verify origin master'`).length === 1);
  check(PASS, 'pushSegments：heredoc 本體不算', pushSegments(`cat > n.md <<'EOF'\ngit push origin master\nEOF`).length === 1);
  check(PASS, 'pushq bypassEnv：heredoc 裡寫到 PUSHQ_BYPASS 不算', /PUSHQ_BYPASS=/.test(stripData(`cat > n.md <<'EOF'\nPUSHQ_BYPASS=1\nEOF`))); }
{ const w = repo('someoneelse'); check(PASS, 'PreToolUse：別人的 repo', denied('git push --no-verify', w)); }
{ const w = repo('bruuucechang');
  writeFileSync(GLOBAL, '');   // 還沒跑 bootstrap
  check(BLOCK, 'PreToolUse：這台還沒裝全域 pre-push', denied('git push origin master', w)); }

rmSync(root, { recursive: true, force: true });
rmSync(dirname(GLOBAL), { recursive: true, force: true });
console.log(fail ? `${fail} 個失敗` : '全過');
process.exit(fail ? 1 : 0);
