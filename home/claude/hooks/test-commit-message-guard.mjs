#!/usr/bin/env node
// commit-message-guard.mjs 的案例表：node test-commit-message-guard.mjs（全過離開碼 0）
// 載入本尊的 run，HOOK_NOLOG 讓測試輸入不進稽核 log（opt/01-hooks.md §2c：測試污染過 log）。
process.env.HOOK_NOLOG = '1';
const { run } = await import('./commit-message-guard.mjs');

const BLOCK = true, PASS = false;
const cases = [
  // ── 照擋 ──
  [BLOCK, 'git commit -m "fix bug"', '雙引號'],
  [BLOCK, 'git commit -m fix', '沒引號'],
  [BLOCK, 'git commit -am \'fix\'', '-am 不在例外裡'],
  [BLOCK, 'git commit -qm \'fix\'', '-qm 不在例外裡'],
  [BLOCK, 'git commit --message=\'fix\'', '--message= 不在例外裡'],
  [BLOCK, 'git commit --message \'fix\'', '--message 不在例外裡'],
  [BLOCK, 'git commit -m\'fix\'', '-m 黏著值'],
  [BLOCK, 'git commit -m \'it\'"s"', '單引號接雙引號'],
  [BLOCK, 'git commit -m \'cost $5\'', '單引號裡有 $'],
  [BLOCK, 'git commit -m \'a\\b\'', '單引號裡有反斜線'],
  [BLOCK, 'git commit -m $\'a\\nb\'', "$'…'"],
  [BLOCK, 'git commit -m "$(printf \'x 6.9%%\')"', '命令替換'],
  [BLOCK, 'git commit -m \'ok\' -m "two"', '第二個 -m 是雙引號'],
  // ── 修漏擋 ──
  [BLOCK, 'git -C ~/Projects/x commit -m "fix"', 'git -C <dir> commit'],
  [BLOCK, 'git -c user.name=x commit -m "fix"', 'git -c k=v commit'],
  [BLOCK, 'git --no-pager -C /tmp commit -am "fix"', '多個全域旗標'],
  [BLOCK, '/usr/bin/git commit -m "x"', '帶路徑的 git'],
  [BLOCK, 'xcrun git commit -m "x"', 'xcrun git'],
  [BLOCK, 'git add a && git commit -F - <<\'MSG\'\nok\nMSG\ngit commit -m "second"', '第二個 commit（第一個是 -F）'],
  [BLOCK, 'git commit -F /tmp/m.txt; git -C x commit -m "y"', '同一行第二個 commit'],
  [BLOCK, 'cd x && (git commit -m "x")', '子殼層'],
  [BLOCK, 'out=$(git commit -m "x")', '命令替換裡'],
  [BLOCK, 'bash -c \'git commit -m "x"\'', 'bash -c 字串'],
  [BLOCK, 'ssh host "cd r && git commit -m x"', 'ssh 遠端指令'],
  [BLOCK, 'cat <<EOF | bash\ngit commit -m "x"\nEOF', 'heredoc 餵給 bash'],
  [BLOCK, 'echo \'git commit -m x\' | sh', 'echo 餵給 sh'],
  [BLOCK, 'git commit -m "x', '引號沒收尾 → 退回舊判法照擋'],
  // ── PR #12 審查實測的退步（舊版擋、第一版新版放） ──
  [BLOCK, 'timeout 60 git commit -m "cost $5"', 'timeout 前綴'],
  [BLOCK, 'ssh host git commit -m "x"', 'ssh 沒加引號'],
  [BLOCK, 'ssh host git commit -m \'a b\'', 'ssh 的遠端殼層會再展開，單引號例外不算'],
  [BLOCK, 'xargs git commit -m "x"', 'xargs'],
  [BLOCK, 'git commit --template=t.txt -m "cost $5"', '--template 不是重用訊息'],
  [BLOCK, 'git commit --template t.txt -m "x"', '--template 分開寫'],
  [BLOCK, 'bash <<< \'git commit -m "x"\'', 'here-string 餵 bash'],
  [BLOCK, 'bash -c "git commit -m \'`date`\'"', 'bash -c 雙引號：外層先展開反引號'],
  [BLOCK, 'git commit -F - <<MSG\nfix: cost $5 and `whoami`\nMSG', 'heredoc 分隔字沒加引號、本體有 $ 與反引號'],
  [BLOCK, 'git commit -F - <<< "cost $5"', 'here-string 雙引號有 $'],
  [PASS, 'git commit -F - <<MSG\nplain message\nMSG', 'heredoc 沒加引號但本體沒有會展開的字'],
  [BLOCK, 'bash -c \'git com' + 'mit -m "x" || true\' 2>/dev/null; echo', 'bash -c 單引號裡的雙引號 -m'],
  // ── PR #12 第二輪審查實測 ──
  [BLOCK, 'cat <<EOF | git commit -F -\ncost $5 `whoami`\nEOF', 'heredoc 經管線送進 -F -'],
  [BLOCK, 'printf "cost $5" | git commit -F -', 'printf 雙引號經管線送進 -F -'],
  [PASS, "cat <<'EOF' | git commit -F -\ncost $5\nEOF", '加引號的 heredoc 經管線送進 -F -'],
  [BLOCK, 'git commit --squash=HEAD -m "cost $5"', '--squash 可以跟 -m 一起用'],
  [BLOCK, 'git commit --fixup HEAD -m "x"', '--fixup 分開寫'],
  [BLOCK, 'git commit --mess="cost $5"', '--message 的縮寫'],
  // ── 放行：單引號例外 ──
  [PASS, 'git commit -m \'fix: 修正 hook\'', '單引號、沒有 \\ 與 $'],
  [PASS, 'git commit -m \'it uses `backticks` and 100% and !bang\'', '單引號裡反引號、%、! 不展開'],
  [PASS, 'git commit -m \'title\' -m \'body\'', '兩個 -m 都是單引號'],
  [PASS, 'git -C ~/x commit -m \'ok\'', 'git -C 也吃例外'],
  // ── 放行：不是 -m ──
  [PASS, 'git commit -F - <<\'MSG\'\nfix\nMSG', 'heredoc'],
  [PASS, 'git commit -F /tmp/m.txt', '-F 檔案'],
  [PASS, 'git commit --amend --no-edit', '--amend --no-edit'],
  [PASS, 'git commit --amend -C HEAD', '-C'],
  [PASS, 'git commit -F f && echo -m', '-m 在別的指令'],
  [PASS, 'git status && grep -m1 x f', 'grep -m1'],
  // ── 修誤擋 ──
  [PASS, 'git commit-tree HEAD^{tree} -p HEAD -m x', 'commit-tree 是 plumbing'],
  [PASS, 'git commit -F - <<\'MSG\'\n修掉 git commit -m "x" 的誤擋\nMSG', 'heredoc 本體寫到 git commit -m'],
  [PASS, 'cat > /tmp/n.md <<\'EOF\'\n不要用 git commit -m "x"\nEOF', 'cat heredoc 寫到 git commit -m'],
  [PASS, 'grep -c \'git commit -m "x"\' ~/.claude/skills/home/claude/hooks/commit-message-guard.log', 'grep 樣式（研究時實際被擋那條）'],
  [PASS, 'echo "用 git commit -m 會被擋"', 'echo 字串'],
  [PASS, 'gh pr create --body "git commit -m x 已修"', 'gh 內文'],
  [PASS, 'git log --grep="git commit -m"', 'git log 的 grep'],
  [PASS, '# git commit -m "x"\nls', '註解'],
  [PASS, 'printf \'%s\\n\' "git commit -m x" > note.txt', 'printf 存檔'],
];

const denied = (cmd) => run({ session_id: 'test', tool_input: { command: cmd } })?.hookSpecificOutput?.permissionDecision === 'deny';
let fail = 0;
for (const [want, cmd, note] of cases) {
  const got = denied(cmd);
  if (got !== want) fail++;
  console.log(`${got === want ? '✓' : '✗'} ${want ? '擋' : '放'}  ${note}  ${got !== want ? JSON.stringify(cmd) : ''}`);
}
const reason = run({ tool_input: { command: 'git commit -m "x"' } })?.hookSpecificOutput?.permissionDecisionReason ?? '';
const msgOk = reason.includes("-F - <<'MSG'") && reason.includes('單引號');
if (!msgOk) fail++;
console.log(`${msgOk ? '✓' : '✗'} 理由寫出 -F - <<'MSG' 與單引號例外`);
console.log(fail ? `${fail} 個不對` : `全部 ${cases.length + 1} 個都對`);
process.exit(fail ? 1 : 0);
