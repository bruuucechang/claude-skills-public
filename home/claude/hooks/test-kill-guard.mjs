#!/usr/bin/env node
// kill-guard 的案例表：node test-kill-guard.mjs（全過離開碼 0）。案例多半取自近 14 天的真實指令（replay-p3.mjs kill）。
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.HOOK_NOLOG = '1';
const HERE = dirname(fileURLToPath(import.meta.url));
const { classify, run } = await import('./kill-guard.mjs');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${extra && !cond ? '  — ' + extra : ''}`);
};

const BLOCK = [
  `pkill -f "dd if=/dev/urandom bs=1m count=10" ; ls`,
  `pkill -f 'rsync -a --partial --timeout=120 mani:trip-atlas-otp'`,
  `pkill node`,
  `pkill -9 -f vite 2>/dev/null; sleep 1`,
  `sudo pkill -f godot`,
  `cd ~/x && pkill -f "python serve.py" || true`,
  `ssh pro-ts 'pkill -f "build-headway-gtfs.py --osm" ; sleep 1'`,
  `ssh -o ConnectTimeout=5 mani "pkill -f dlxl.py"`,
  `bash -c 'pkill -f foo'`,
  `/usr/bin/pkill -f foo`,
  `killall node`,
  `killall -9 Godot`,
  `kill $(pgrep -f 'git push origin HEAD:master')`,
  `kill -9 \`pgrep -f vite\``,
  `kill $(pgrep -x AgentQuota); sleep 1; open -g ~/Applications/AgentQuota.app`,
  `pgrep -f 'godot --headless' | xargs kill`,
  `pgrep -f foo | xargs -n 1 kill -9`,
  `taskkill /F /IM Godot.exe`,
  `powershell -NoProfile -Command "Stop-Process -Name Godot -Force"`,
  `powershell -c "Get-Process | Where-Object { $_.Path -match 'godot' } | Stop-Process"`,
  `X=1 nohup pkill -f foo &`,
  `timeout 5 pkill -f foo`,
  // PR #11 審查找到的漏擋
  `for i in 1 2; do pkill -f vite; done`,
  `while true; do pkill -f x; sleep 1; done`,
  `if true; then pkill node; fi`,
  `! pkill node`,
  `sudo -n pkill node`,
  `env -i pkill node`,
  `time -p pkill node`,
  `p=$(pgrep -f 'git push origin HEAD:master'); kill $p`,
  `for p in $(pgrep -f vite); do kill $p; done`,
  `pgrep -f x | while read p; do kill $p; done`,
  `kill $(pidof node)`,
  `ps aux | grep vite | awk '{print $2}' | xargs kill`,
  `powershell -c "Get-Process -Name godot | Stop-Process -Force"`,
  `Get-Process godot | Stop-Process`,
  `taskkill /F /FI "IMAGENAME eq godot.exe"`,
  `pkill -f "build.py -P 3"`,
  `pkill -P 1 -f node`,
  `echo x | xargs pkill -f y`,
  // 第二輪審查
  `ps -ef | grep 'git push' | grep -v grep | awk '{print $2}' | xargs kill`,
  `kill -9 $(ps -ef | grep 'git push' | awk '{print $2}')`,
  `ps aux | grep vite | awk '{print $2}' | while read p; do kill $p; done`,
  `cat <<'EOF' | bash\npkill -f vite\nEOF`,
  `python3 - <<'EOF'\nprint(1)\nEOF\npkill -f vite`,             // heredoc 收尾之後的 pkill 照擋
  `python3 x.py && bash <<'EOF'\npkill -f vite\nEOF`,           // heredoc 是 bash 的，不是 python 的（PR #14 審查）
  `node build.js; sh <<'EOF'\nkillall node\nEOF`,
  `cat a.txt && bash <<'EOF'\npkill -f vite\nEOF`,
  `bash ~/perl-tools/run.sh <<'EOF'\npkill -f vite\nEOF`,       // 路徑裡的 perl 不是程式名（第二輪審查）
  `bash -c 'node' <<'EOF'\nkillall x\nEOF`,
  `bash cat.sh <<'EOF'\npkill -f vite\nEOF`,
  `kill $(pgrep -P 1 -f node)`,
  `/bin/kill $(pgrep -f 'git push')`,
  `ssh mani 'killall -s KILL python3'`,
  `killall -s 9 node`,
  `powershell -c "kill -Name godot"`,
  `powershell -c "Get-Process godot | kill"`,
  `spps -Name node`,
  `stdbuf -oL pkill x`,
  `doas pkill node`,
];
const PASS = [
  `kill 93656`,
  `kill -9 70294 70894 90639 2>&1`,
  `kill $PID; kill "$WP" 2>/dev/null`,
  `kill %1`,
  `kill $(cat $L/api.pid) 2>&1`,
  `pkill -P 93656; kill 93656 2>/dev/null`,          // 只殺自己 pid 的子程序
  `pkill -P $WP 2>/dev/null; kill $WP`,
  `pgrep -fl 'godot-desk' | head -3`,
  `pgrep -f vite`,
  `ps -axo pid,command | grep -E 'claude|pkill|install' | grep -v grep`,
  `grep -rn pkill hooks/*.mjs`,
  `rg -n "pkill -f|killall" ~/.claude/skills`,
  `echo "不要用 pkill -f"`,
  `git commit -F - <<'MSG'\n不准 pkill -f、killall\nMSG`,
  `cat > notes.md <<'EOF'\n- 不用 \`pkill -f\`、不 killall\nEOF\nls -la 2>&1 | head`,
  `cd ~/x && python3 - <<'EOF'\ns=s.replace('pkill -f "iTerm2-ime-test"', 'kill $PID')\nEOF\nls`,   // 直譯器的 heredoc 本體是程式碼（replay-p3 2026-10-19）
  `node <<'EOF'\nconst s = "killall node";\nEOF`,
  `lsof -ti :5173 | xargs kill`,
  `killall -l`,                                       // 只列訊號
  `taskkill /F /PID 1234`,
  `Stop-Process -Id 1234`,
  `ls ~/.claude/skills/killall-notes`,
  `command -v pkill`,
  `pkill -P $$`,
  `pgrep -fl desk; kill 93656`,                       // 先查、再殺字面 pid
  `Get-Process -Id 123 | Stop-Process`,
  `for p in $(cat pids); do kill $p; done`,
  `pgrep -f vite >/dev/null && kill $VITE_PID`,          // 自己記的 pid，不是 pgrep 給的
  `pgrep -fl vite; kill $PID`,
  `pgrep x; kill -s TERM 1234`,
  `while kill -0 $(pgrep -f 'run.sh check' | head -1) 2>/dev/null; do sleep 15; done`,
  `pid=$(pgrep -f x); while kill -0 $pid; do sleep 1; done`,
];
for (const c of BLOCK) ok(`擋：${c.replace(/\n/g, '⏎').slice(0, 70)}`, !!classify(c), `classify=${classify(c)}`);
for (const c of PASS) ok(`放：${c.replace(/\n/g, '⏎').slice(0, 70)}`, !classify(c), `classify=${classify(c)}`);

// run() 的輸出形狀、逃生門以外的路徑
{
  const o = run({ tool_name: 'Bash', tool_input: { command: 'pkill -f foo' } });
  ok('run：deny＋理由指向 kill <pid>', o?.hookSpecificOutput?.permissionDecision === 'deny' && /kill <pid>/.test(o.hookSpecificOutput.permissionDecisionReason));
  ok('run：沒有 command 放行', run({ tool_name: 'Bash', tool_input: {} }) === null);
  ok('run：壞輸入放行', run(null) === null);
}
// 經過 dispatch 的整條路（PreToolUse Bash）
{
  const r = spawnSync(process.execPath, [join(HERE, 'dispatch.mjs'), 'PreToolUse'],
    { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: '/tmp', tool_input: { command: 'killall node' } }), encoding: 'utf8', env: { ...process.env, HOOK_NOLOG: '1' } });
  let j = null; try { j = JSON.parse(r.stdout); } catch {}
  ok('dispatch PreToolUse Bash：killall 擋下', j?.hookSpecificOutput?.permissionDecision === 'deny', r.stdout.slice(0, 200));
  const r2 = spawnSync(process.execPath, [join(HERE, 'dispatch.mjs'), 'PreToolUse'],
    { input: JSON.stringify({ hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: '/tmp', tool_input: { command: 'kill 12345' } }), encoding: 'utf8', env: { ...process.env, HOOK_NOLOG: '1' } });
  ok('dispatch PreToolUse Bash：kill <pid> 不輸出', r2.stdout === '', r2.stdout.slice(0, 200));
}

console.log(`\n${pass} 過、${fail} 失敗`);
process.exit(fail ? 1 : 0);
