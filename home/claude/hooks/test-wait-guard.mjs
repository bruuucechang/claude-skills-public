#!/usr/bin/env node
// wait-guard 的案例表：node test-wait-guard.mjs（全過離開碼 0）。案例多半取自近 14 天的真實指令。
// node test-wait-guard.mjs --replay 14：拿近 14 天 ~/.claude/projects 的真實 Bash 指令重播，列出會擋的。
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

process.env.HOOK_NOLOG = '1';
const { classify, run } = await import('./wait-guard.mjs');

if (process.argv[2] === '--replay') {
  const days = Number(process.argv[3] ?? 14), root = join(homedir(), '.claude', 'projects');
  const hits = {}; let total = 0;
  for (const d of readdirSync(root)) for (const f of readdirSync(join(root, d)).filter((x) => x.endsWith('.jsonl'))) {
    const p = join(root, d, f);
    if (Date.now() - statSync(p).mtimeMs > days * 864e5) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      if (!line.includes('"Bash"')) continue;
      let j; try { j = JSON.parse(line); } catch { continue; }
      for (const b of j.message?.content ?? []) if (b?.type === 'tool_use' && b.name === 'Bash') {
        total++;
        const k = classify(b.input.command, Boolean(b.input.run_in_background));
        if (k) (hits[k] ??= []).push((b.input.run_in_background ? 'BG ' : 'FG ') + b.input.command.replace(/\s+/g, ' ').slice(0, 160));
      }
    }
  }
  console.log(`近 ${days} 天 ${total} 筆 Bash，會擋 ${Object.values(hits).flat().length} 筆`);
  for (const [k, v] of Object.entries(hits)) { console.log(`== ${k} ${v.length}`); for (const x of v) console.log('  ', x); }
  process.exit(0);
}

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${extra && !cond ? '  — ' + extra : ''}`);
};

// [指令, 背景?]
const BLOCK = [
  // 2026-10-25 的事故：兩個路徑一定有一個不存在，ls 永遠失敗
  [`J=x; for i in $(seq 1 120); do ssh mani-ts "ls -d ~/q/done/$J ~/q/failed/$J" >/dev/null 2>&1 && break; sleep 60; done; pixgen fetch $J`, true],
  [`until grep -q "DONE\\|Traceback" /tmp/x/tasks/bu1.output; do sleep 20; done; echo finished`, false],
  [`until ! pgrep -f score-pixgen.sh >/dev/null; do sleep 15; done; tail -3 log`, false],
  [`while pgrep -f 'git push' >/dev/null; do sleep 10; done; cat out`, false],
  [`end=$(( $(date +%s) + 43200 )); while [ $(date +%s) -lt $end ]; do l=$(curl -s localhost:5371/x); sleep 300; done`, true],
  [`while kill -0 73032 2>/dev/null; do sleep 300; done; grep x log`, true],
  [`for i in $(seq 1 80); do ssh mani-ts 'test -f ~/d/done2' && break; sleep 20; done`, false],          // 前景 1600 秒
  [`for i in $(seq 90); do kill -0 $pid 2>/dev/null || break; sleep 2; done`, false],                     // 180 秒
  [`for i in $(seq 1 10); do curl -sf localhost:5173 && break; sleep 1; done`, true],                      // 背景一律擋
  [`for i in $(seq 1 $N); do ssh x test -f y && break; sleep 5; done`, false],                             // 次數估不出來
  [`for i in 1 2 3; do curl -s x && break; sleep $S; done`, false],                                       // 秒數估不出來
  [`ssh mani 'until test -f ~/done; do sleep 30; done; echo ok'`, true],                                  // 遠端的迴圈也是迴圈
  [`bash <<'EOF'\nuntil test -f done; do sleep 5; done\nEOF`, false],                                      // 餵給殼層的 heredoc 是指令
  [`cd x && until curl -sf localhost:3000; do\n  sleep 1\ndone`, false],
  [`while true; do sleep 60; ls; done`, false],
  [`while read l; do echo $l; sleep 1; done < list`, true],                                               // while read 只有背景擋
  [`while :; do sleep 5; done`, false],
  // PR #70 審查：巢狀迴圈、引號、條件裡的 sleep、包在 ssh／bash -c 引號裡
  [`for i in $(seq 1 120); do for id in a b; do grep -q $id st || left=1; done; [ $left = 0 ] && break; sleep 60; done`, true],
  [`until test -f x; do while read x; do :; done < l; sleep 60; done`, true],
  [`until ssh h "echo X" | grep -q X; do echo "waiting"; sleep 60; done`, true],
  [`while sleep 30; do grep -q DONE log && break; done`, true],
  [`ssh mani "while true; do sleep 60; done"`, true],
  [`bash -c 'while ! curl -s localhost:3000; do sleep 2; done'`, true],
  [`timeout 600 bash -c 'until test -f x; do sleep 5; done'`, true],
  [`ls ~/tools/waitfor && while true; do sleep 60; done`, true],
  [`cat <<EOF | ssh host bash\nuntil test -f x; do sleep 5; done\nEOF`, true],
  [`f(){ while true; do sleep 1; done}`, false],
  // 第二輪：case 條件裡的 done、不在指令位置的 sleep、引號裡的指令替換
  [`for i in $(seq 1 20); do case "$s" in running|done|failed) exit 0;; esac; sleep 60; done`, true],
  [`until test -f x; do /bin/sleep 60; done`, false],
  [`while true; do FOO=1 sleep 60; done`, false],
  [`echo "$(while true; do sleep 1; done)"`, false],
];
const PASS = [
  [`sleep 2; curl localhost:3000`, false],                                                                 // 單一 sleep 不是迴圈
  [`for f in *.png; do convert $f x; done`, false],                                                        // 沒有 sleep
  [`T=/opt/homebrew/bin/tmux\nfor w in a4 a5; do\n  ssh mani "$T send-keys -t anim:$w 1"; sleep 1; ssh mani "$T send-keys Enter"\ndone; sleep 6`, false],
  [`for i in $(seq 1 20); do curl -sf localhost:5391/health >/dev/null && break; sleep 0.5; done`, false], // 10 秒，短的重試
  [`for i in 1 2 3 4; do grep -m2 x f; echo; sleep 3; done`, false],
  [`for i in {1..10}; do curl -s x && break; sleep 2; done`, false],                                       // 20 秒
  [`while read l; do echo $l; sleep 1; done < list`, false],                                              // 前景逐行處理
  [`waitfor --every 60 --fail "test -f fail" -- test -f ok && fetch`, true],
  [`~/.claude/skills/home/claude/tools/waitfor --pid 123 -- grep -q DONE log`, true],
  [`for i in $(seq 1 30); do ./batch $i; sleep 10; done  # waitfor-ok: API 限速`, true],
  [`cat > run.sh <<'EOF'\nwhile true; do sleep 60; done\nEOF\nchmod +x run.sh`, false],                   // 寫檔的 heredoc 是資料
  [`python3 - <<'PY'\nimport time\nwhile True:\n    time.sleep(1)\nfor x in y:\n    pass\nPY`, false],
  [`git commit -F - <<'MSG'\nwhile 迴圈改用 waitfor，不再 sleep 到上限\nfor 迴圈也是\ndone\nMSG`, false],
  [`grep -nE 'while|until|sleep|done' x.sh`, false],
  [`echo "until it is done, do not sleep"`, false],
  [`ls`, false],
];

for (const [c, bg] of BLOCK) ok(`擋 ${bg ? '[背景] ' : ''}${c.replace(/\n/g, '⏎').slice(0, 90)}`, classify(c, bg) !== null);
for (const [c, bg] of PASS) ok(`放 ${bg ? '[背景] ' : ''}${c.replace(/\n/g, '⏎').slice(0, 90)}`, classify(c, bg) === null, String(classify(c, bg)));

const out = run({ tool_name: 'Bash', tool_input: { command: BLOCK[0][0], run_in_background: true } });
ok('run() 回 deny 與 waitfor 寫法', out?.hookSpecificOutput?.permissionDecision === 'deny' && /waitfor/.test(out.hookSpecificOutput.permissionDecisionReason));
ok('run() 放行回 null', run({ tool_name: 'Bash', tool_input: { command: 'ls' } }) === null);
ok('run() 沒有 command 不爆', run({ tool_name: 'Bash', tool_input: {} }) === null);

console.log(`\n${pass} 過、${fail} 失敗`);
process.exit(fail ? 1 : 0);
