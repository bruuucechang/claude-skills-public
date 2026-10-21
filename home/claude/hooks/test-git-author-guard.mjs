#!/usr/bin/env node
// git-author-guard.mjs 的案例表：node test-git-author-guard.mjs（全過離開碼 0）
// 暫存目錄開兩個 repo（作者對／錯），全域設定指到空檔，不讀這台真的 ~/.gitconfig。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 案例把路徑塞進 bash 指令字串：Windows 的 C:\… 反斜線會被當成跳脫吃掉，所以一律換成正斜線（git 與 resolve 都吃）
const root = mkdtempSync(join(tmpdir(), 'git-author-guard-')).replace(/\\/g, '/');
process.env.GIT_CONFIG_GLOBAL = join(root, 'gitconfig');
process.env.GIT_CONFIG_NOSYSTEM = '1';
writeFileSync(process.env.GIT_CONFIG_GLOBAL, '');
const { run } = await import('./git-author-guard.mjs');

const OK_MAIL = 'you@example.com';
function repo(name, email, remote = true) {
  const d = join(root, name).replace(/\\/g, '/');
  mkdirSync(d);
  execFileSync('git', ['init', '-q', d]);
  execFileSync('git', ['-C', d, 'config', 'user.name', 'bruce']);
  execFileSync('git', ['-C', d, 'config', 'user.email', email]);
  // 有 GitHub remote：暫存目錄裡沒有 remote 的 repo 會被當成測試用假 repo 不查
  if (remote) execFileSync('git', ['-C', d, 'remote', 'add', 'origin', 'https://github.com/bruuucechang/x.git']);
  return d;
}
const good = repo('good', OK_MAIL);
const bad = repo('bad', 'x@MacBook-Pro.local');
const scratch = repo('scratch', 't@t', false);

const BLOCK = true, PASS = false;
const cases = [
  [PASS, good, 'git commit -m x', '作者對'],
  [BLOCK, bad, 'git commit -F - <<\'MSG\'\nx\nMSG', '作者錯'],
  [BLOCK, good, `cd ${bad} && git commit -F f`, 'cd 進錯的 repo'],
  [PASS, bad, `cd ${good} && git commit -F f`, 'cd 進對的 repo'],
  // git -C
  [BLOCK, good, `git -C ${bad} commit -F f`, 'git -C <錯的 repo>（以前漏擋）'],
  [PASS, bad, `git -C ${good} commit -F f`, 'git -C <對的 repo>（以前誤擋）'],
  [BLOCK, root, 'git -C bad commit -F f', 'git -C 相對路徑'],
  [BLOCK, good, `git commit -F f && git -C ${bad} commit -F g`, '第二個 commit 在錯的 repo'],
  // git -c
  [BLOCK, good, 'git -c user.email=x@y.local commit -F f', 'git -c user.email=錯的'],
  [PASS, bad, `git -c user.email=${OK_MAIL} -c user.name=bruce commit -F f`, 'git -c user.email=對的'],
  [BLOCK, bad, 'git -c core.editor=vim commit -F f', 'git -c 別的設定不影響作者'],
  // PR #12 審查實測
  [BLOCK, good, `timeout 60 git -C ${bad} commit -F f`, 'timeout 前綴'],
  [BLOCK, good, `bash <<< "git -C ${bad} commit -F f"`, 'here-string 餵 bash'],
  [BLOCK, root, 'cd good && git commit -F f; cd ../bad && git commit -F g', '第二個 commit 在另一個 cd 目標'],
  [BLOCK, good, `R=${bad}; git -C "$R" commit -F f`, '同一條指令裡設的變數'],
  [BLOCK, good, 'git -c author.email=x@y.local commit -F f', '-c author.email'],
  [BLOCK, good, 'GIT_AUTHOR_EMAIL=x@y.local git commit -F f', '前綴 GIT_AUTHOR_EMAIL'],
  [BLOCK, good, 'git commit --author="x <x@y.local>" -F f', '--author='],
  [BLOCK, bad, `git commit --author="bruce <${OK_MAIL}>" -F f`, '--author 對、提交者（user.email）錯'],
  [PASS, bad, `GIT_COMMITTER_EMAIL=${OK_MAIL} git commit --author="bruce <${OK_MAIL}>" -F f`, '作者與提交者都覆寫成對的'],
  // PR #12 第二輪審查實測
  [BLOCK, bad, `(cd ${good} && git pull) && git commit -F f`, '子殼層裡的 cd 不帶出來'],
  [BLOCK, bad, `pushd ${good} && git status && popd && git commit -F f`, 'popd 回到原處'],
  [BLOCK, bad, `top=$(cd ${good} && pwd); git commit -F f`, '$( ) 裡的 cd 不帶出來'],
  [BLOCK, good, `cd ${bad} && bash -c 'git commit -F f'; cd ${good}`, 'bash -c 照執行順序用當下的目錄'],
  [PASS, bad, `cd ${good} && bash -c 'git commit -F f'`, 'bash -c 繼承外層 cd'],
  [BLOCK, good, 'git -c committer.email=x@y.local commit -F f', '-c committer.email'],
  [PASS, good, 'git commit --author=Bruce -F f', '--author=名字（沒有信箱）不當成信箱判'],
  // replay（近 14 天真實紀錄）抓到的：判不準時照舊版只查目錄設定，不套指令裡的覆寫
  [PASS, good, 'cd $(mktemp -d) && git init -q && git -c user.name=t -c user.email=t@t commit -q -F f', 'cd 目標展不開：測試腳本的暫存 repo'],
  [PASS, good, `T=${root}/not-yet; mkdir -p $T && cd $T && git -c user.email=t@t commit -F f`, 'cd 目標還不存在'],
  [PASS, good, 'git -c user.name=bruce -c user.email=$(git -C ~/x config user.email) commit -F f', '覆寫值是 $(…)：展不開當沒寫'],
  [PASS, good, "ssh host 'cd $(mktemp -d) && git -c user.email=t@t commit -F f'", 'ssh 遠端：照舊版查本機目錄'],
  [BLOCK, bad, 'git -c user.email=$(git -C ~/x config user.email) commit -F f', '覆寫值展不開、目錄設定是錯的 → 照擋'],
  [PASS, good, `cd ${scratch} && git commit -F f`, '暫存目錄裡沒有 GitHub remote 的假 repo 不查'],
  [PASS, good, `git -C ${scratch} -c user.email=t@t commit -F f`, '假 repo 加 -c 覆寫也不查'],
  // 不是 commit
  [PASS, bad, 'grep -c \'git commit\' log.txt', 'grep 樣式'],
  [PASS, bad, 'cat > n.md <<\'EOF\'\n記得 git commit 前先查作者\nEOF', 'heredoc 本體'],
  [PASS, bad, 'git status', 'git status'],
  [BLOCK, bad, 'git commit-tree HEAD^{tree} -m x', 'commit-tree 也會用作者身分'],
  [BLOCK, bad, 'git commit -m "x', '拆不了 → 退回舊判法'],
];

const denied = (cwd, cmd) => run({ cwd, tool_input: { command: cmd } })?.hookSpecificOutput?.permissionDecision === 'deny';
let fail = 0;
for (const [want, cwd, cmd, note] of cases) {
  const got = denied(cwd, cmd);
  if (got !== want) fail++;
  console.log(`${got === want ? '✓' : '✗'} ${want ? '擋' : '放'}  ${note}`);
}
rmSync(root, { recursive: true, force: true });
console.log(fail ? `${fail} 個不對` : `全部 ${cases.length} 個都對`);
process.exit(fail ? 1 : 0);
