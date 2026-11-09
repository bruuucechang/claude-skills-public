#!/usr/bin/env node
// git-wipe-guard 的案例表：node test-git-wipe-guard.mjs（全過離開碼 0）。
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.HOOK_NOLOG = '1';
const HERE = dirname(fileURLToPath(import.meta.url));
const { classify, run } = await import('./git-wipe-guard.mjs');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${extra && !cond ? '  — ' + extra : ''}`);
};

// 純字串的判斷：工作區一律當成有改動（reset --hard 要擋）
const DIRTY = () => false;
const BLOCK = [
  `git reset --hard`,
  `git reset --hard HEAD`,
  `git reset --hard @{u}`,
  `git reset --hard origin/master`,
  `git -C ~/x reset --hard`,
  `cd ~/x && git reset --hard HEAD~1`,
  `git checkout .`,
  `git checkout -- .`,
  `git checkout HEAD -- .`,
  `git checkout HEAD .`,
  `git restore .`,
  `git restore -- .`,
  `git restore --worktree --staged .`,
  `git restore :/`,
  `git restore --source=HEAD .`,
  `git clean -f`,
  `git clean -fd`,
  `git clean -xdf`,
  `git clean --force -d`,
  `git branch -D feature/x`,
  `git branch --delete --force feature/x`,
  `git branch -df feature/x`,
  `git stash`,
  `git stash -u`,
  `git stash -m 'wip'`,
  `git stash push`,
  `git stash push -m "暫存一下"`,
  `git stash save "wip"`,
  `git stash clear`,
  `git stash push -- .`,
  `git status && git stash && git pull`,
  `bash -c 'git checkout .'`,
  `ssh mani 'cd x && git reset --hard'`,
  `sudo git clean -fdx`,
  `git add a.txt; git checkout -- .`,
  `git commit -F - <<'MSG'\nx\nMSG\ngit reset --hard @{u}`,     // heredoc 收尾之後的照擋
  `cat <<'EOF' | bash\ngit restore .\nEOF`,
  `echo "unterminated && git checkout .`,                        // 拆不了 → 粗比對
  // PR #42 審查找到的漏擋
  `git checkout -f`,
  `git checkout -f main`,
  `git checkout --force main`,
  `git switch -f main`,
  `git switch --discard-changes main`,
  `git checkout -- ..`,
  `git restore ..`,
  `git restore ../..`,
  `git restore "$PWD"`,
  `git checkout -- :/*`,
  `git restore ":(top)"`,
  `git restore -- "$(git rev-parse --show-toplevel)"`,
  `git -c clean.requireForce=false clean -dx`,
  `git -c alias.nuke="reset --hard" nuke`,
  `git -c alias.wipe='!git checkout .' wipe`,
  `git -c alias.cf="clean -f" cf`,
  `git --git-dir=/x/.git --work-tree=/x reset --hard`,
  `GIT_DIR=/x/.git GIT_WORK_TREE=/x git reset --hard`,
  `echo don't; git stash -u`,
  `echo don't; git stash push`,
  `echo don't; git -C x stash -k`,
  `echo don't; git branch --delete --force x`,
  `echo don't; git restore -W ./`,
  `echo don't; git switch -f main`,
  `echo don't; git -c alias.n="reset --hard" n`,
  `echo don't; git stash push -m wip`,
  `echo don't; git stash -m wip`,
  `git restore "$(pwd)"`,
];
const PASS = [
  `git push origin HEAD:master`,                                  // 不擋 push
  `git push --force-with-lease`,
  `git reset`,
  `git reset --soft HEAD~1`,
  `git reset HEAD a.txt`,
  `git reset --keep @{u}`,
  `git checkout main`,
  `git checkout -b feature/x`,
  `git checkout -- src/a.ts`,
  `git checkout HEAD~1 -- docs/x.md`,
  `git restore src/a.ts`,
  `git restore --staged .`,
  `git restore -S .`,
  `git clean -n`,
  `git clean -nd`,
  `git clean --dry-run -f`,
  `git branch -d feature/x`,
  `git branch -a`,
  `git stash list`,
  `git stash show -p`,
  `git stash pop`,
  `git stash apply stash@{1}`,
  `git stash push -- a.txt b.txt`,
  `git stash push -m wip a.txt`,
  `git stash -- a.txt`,
  `echo "不要 git reset --hard、git checkout ."`,
  `grep -rn "reset --hard\\|checkout \\." hooks/*.mjs`,
  `rg -n 'git clean -fd' ~/x`,
  `git commit -F - <<'MSG'\n不准 git reset --hard、git stash、git branch -D\nMSG`,
  `cat > notes.md <<'EOF'\n- 不用 \`git checkout .\`\nEOF`,
  `git log --grep='reset --hard'`,
  `ls ~/branch-D-notes`,
  `node -e "console.log('git clean -fd')"`,
  `git checkout -p .`,
  `git restore -p .`,
  `git switch main`,
  `git switch -c feature/x`,
  `git restore ../other/a.ts`,
  `git -c alias.st=status st`,
  `echo don't; git stash list`,
  `echo don't; git stash push -- a.txt`,
  `echo don't; git branch -d x`,
  // 第二輪審查：變數參數不算整個 repo
  `git checkout "$BRANCH"`,
  `git checkout $(git rev-parse HEAD~1)`,
  `git checkout -- "$f"`,
  `git restore "$FILE"`,
  `for f in a b; do git restore -- "$f"; done`,
  `git stash push -- "$f"`,
  `echo don't; git stash push ./src`,
];
for (const c of BLOCK) ok(`擋：${c.replace(/\n/g, '⏎').slice(0, 70)}`, !!classify(c, '/tmp', DIRTY), `classify=${classify(c, '/tmp', DIRTY)}`);
for (const c of PASS) ok(`放：${c.replace(/\n/g, '⏎').slice(0, 70)}`, !classify(c, '/tmp', DIRTY), `classify=${classify(c, '/tmp', DIRTY)}`);

// reset --hard：工作區乾淨就放行（記憶 only-my-own-repos 的 `git reset --hard @{u}`），用真的 repo 量
{
  const root = mkdtempSync(join(tmpdir(), 'wipe-guard-'));
  const d = join(root, 'dirty'), c0 = join(root, 'clean');
  const init = (dir) => {
    mkdirSync(dir);
    const g = (...a) => execFileSync('git', ['-C', dir, ...a], { stdio: 'ignore' });
    g('init', '-q'); g('config', 'user.email', 't@t'); g('config', 'user.name', 't');
    writeFileSync(join(dir, 'a.txt'), '1\n'); g('add', 'a.txt'); g('commit', '-qm', 'x');
  };
  try {
    init(d); init(c0);
    writeFileSync(join(d, 'new.txt'), '沒追蹤的檔\n');            // reset --hard 不碰沒追蹤的檔
    ok('乾淨的 repo：reset --hard @{u} 放行', classify('git reset --hard @{u}', d) === null);
    ok('乾淨的 repo：-C 指過去也放行', classify(`git -C ${d} reset --hard HEAD`, '/tmp') === null);
    ok('乾淨的 repo：cd 過去也放行', classify(`cd ${d} && git reset --hard HEAD`, '/tmp') === null);
    ok('乾淨的 repo：checkout . 照擋', classify('git checkout .', d) === 'checkout-all');
    writeFileSync(join(d, 'a.txt'), '2\n');
    ok('有改動的 repo：reset --hard 擋', classify('git reset --hard @{u}', d) === 'reset-hard');
    ok('有改動的 repo：-C 指過去也擋', classify(`git -C ${d} reset --hard`, '/tmp') === 'reset-hard');
    ok('不是 repo：reset --hard 擋', classify('git reset --hard', tmpdir()) === 'reset-hard');
    ok('變數當目錄（看不到在哪）：擋', classify('git -C "$W" reset --hard', d) === 'reset-hard');
    ok('cd 到變數：擋（cwd 乾淨也一樣）', classify('W=/x; cd "$W" && git reset --hard', c0) === 'reset-hard');
    ok('cd .. 再 cd 進有改動的 repo：擋', classify(`cd .. && cd ${basename(d)} && git reset --hard`, c0) === 'reset-hard');
    ok('cd 進有改動的 repo 再 -C .：擋', classify(`cd ${d} && git -C . reset --hard`, c0) === 'reset-hard');
    ok('-C 疊加（-C 上層 -C 名字）指到有改動的 repo：擋', classify(`git -C ${dirname(d)} -C ${basename(d)} reset --hard`, c0) === 'reset-hard');
    ok('restore <repo 根的絕對路徑>：擋', classify(`git restore ${d}`, '/tmp') === 'restore-all');
    ok('heredoc 裡寫到 cd $W 不算：乾淨就放行', classify(`git commit -F - <<'MSG'\nrun cd $W first\nMSG\ngit reset --hard @{u}`, c0) === null);
    ok('git 查不到（逾時）：擋', classify('git reset --hard', c0, () => false) === 'reset-hard');
  } finally { rmSync(root, { recursive: true, force: true }); }
}

// run() 的輸出形狀
{
  const o = run({ tool_name: 'Bash', cwd: '/tmp', tool_input: { command: 'git checkout .' } });
  const why = o?.hookSpecificOutput?.permissionDecisionReason ?? '';
  ok('run：deny＋繁中理由與替代做法', o?.hookSpecificOutput?.permissionDecision === 'deny' && /git restore <檔>/.test(why) && /收不回來/.test(why), why);
  ok('run：沒有 command 放行', run({ tool_name: 'Bash', tool_input: {} }) === null);
  ok('run：壞輸入放行', run(null) === null);
}
// 經過 dispatch 的整條路（PreToolUse Bash）
{
  const call = (command) => spawnSync(process.execPath, [join(HERE, 'dispatch.mjs'), 'PreToolUse'],
    { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: '/tmp', tool_input: { command } }), encoding: 'utf8', env: { ...process.env, HOOK_NOLOG: '1' } });
  const r = call('git clean -fd');
  let j = null; try { j = JSON.parse(r.stdout); } catch {}
  ok('dispatch PreToolUse Bash：clean -fd 擋下', j?.hookSpecificOutput?.permissionDecision === 'deny', r.stdout.slice(0, 200));
  const r2 = call('git stash list');
  ok('dispatch PreToolUse Bash：stash list 不輸出', r2.stdout === '', r2.stdout.slice(0, 200));
}

console.log(`\n${pass} 過、${fail} 失敗`);
process.exit(fail ? 1 : 0);
