#!/usr/bin/env node
// focus-guard.mjs 的案例表：node test-focus-guard.mjs（全過離開碼 0）
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOOK = join(dirname(fileURLToPath(import.meta.url)), 'focus-guard.mjs');
const BLOCK = true, PASS = false;
const cases = [
  [BLOCK, 'open foo.png'],
  [BLOCK, 'FOO=1 open bar.pdf'],
  [BLOCK, 'cd a && open http://x'],
  [BLOCK, 'open -g x/index.html'],
  [BLOCK, 'open -g -a /Applications/Godot.app --args --path x'],
  [BLOCK, '/Applications/Godot.app/Contents/MacOS/Godot --path game'],
  [BLOCK, 'osascript -e "tell application \\"Chrome\\" to activate"'],
  [BLOCK, 'cd x && osascript -e "tell app \\"Terminal\\" to do script \\"ls\\""'],
  [BLOCK, "osascript - <<'AS'\ntell application \"X\" to activate\nAS"],
  [BLOCK, "osascript -e 'tell application \"Google Chrome\" to make new window'"],
  [PASS, 'open -g foo.png'],
  [PASS, 'proj open dash'],
  [PASS, 'grep -n open file'],
  [PASS, 'echo "please open the door"'],
  [PASS, 'xdg-open x'],
  [PASS, '~/.claude/skills/home/claude/tools/bgopen a.html'],
  [PASS, '~/.claude/skills/home/claude/tools/bgrun /Applications/Godot.app/Contents/MacOS/Godot --path g'],
  [PASS, '/Applications/Godot.app/Contents/MacOS/Godot --headless --path game --import'],
  [PASS, 'osascript -e "tell application \\"Terminal\\" to count windows"'],
  [PASS, "osascript -l JavaScript -e 'ObjC.import(\"AppKit\"); $.NSWorkspace.sharedWorkspace.frontmostApplication.localizedName.js'"],
  // heredoc 本體是資料：寫文件時提到 osascript／activate／open 不算
  [PASS, "cat > f.md <<'EOF'\nosascript to activate\nopen foo\nEOF\necho ok"],
  [PASS, "osascript <<AS\ntell application \"X\" to get name\nAS\necho activate"],
  // 引號裡的 | 不是分段
  [PASS, "grep -rn -iE 'playwright|open -|webbrowser' ."],
  [PASS, "grep -n -iE 'open |osascript|activate' a.sh"],
  // 賦值不是執行；但賦值成 Godot 的變數之後被執行就要看
  [PASS, 'G=/Applications/Godot.app/Contents/MacOS/Godot; $G --headless --path game'],
  [PASS, 'G=/Applications/Godot.app/Contents/MacOS/Godot && echo $G'],
  [BLOCK, 'G=/Applications/Godot.app/Contents/MacOS/Godot; "$G" --path game'],
  [BLOCK, 'GD="/Applications/Godot.app/Contents/MacOS/Godot"; ${GD} --path game'],
  [BLOCK, 'export G=/Applications/Godot.app/Contents/MacOS/Godot; $G --path game'],
  [PASS, '/Applications/Godot.app/Contents/MacOS/Godot --version'],
  // 旗標一起包進變數：值裡的 --headless 要算，值裡沒有就照擋（replay 2026-10-20 找到的形狀）
  [PASS, 'G="/Applications/Godot.app/Contents/MacOS/Godot --headless --path game"\nONLY=t.gd $G > m.log'],
  [BLOCK, 'G="/Applications/Godot.app/Contents/MacOS/Godot --path game"\nONLY=t.gd $G > m.log'],
  [BLOCK, '/Applications/Godot.app/Contents/MacOS/Godot --path game --verbose'],
];

// focus-guard.log 每一筆歷史擋下，逐筆標過該擋／誤擋（全文從 transcript 找回，log 只存前 400 字）
const history = JSON.parse(readFileSync(join(dirname(HOOK), 'test-focus-guard.history.json'), 'utf8'));
for (const h of history) cases.push([h.block, h.cmd, h.note]);

let fail = 0;
for (const [want, command, note] of cases) {
  const r = spawnSync('node', [HOOK], {
    input: JSON.stringify({ tool_input: { command } }),
    encoding: 'utf8',
    env: { ...process.env, FOCUS_GUARD_NOLOG: '1' },
  });
  const blocked = r.stdout.includes('"deny"');
  const ok = blocked === want;
  if (!ok) fail++;
  console.log(`${ok ? '✓' : '✖'} ${want ? '擋' : '放'}  ${note ?? command.replace(/\n/g, '⏎').slice(0, 80)}`);
}
console.log(fail ? `${fail} 個不對` : `全部 ${cases.length} 個都對`);
process.exit(fail ? 1 : 0);
