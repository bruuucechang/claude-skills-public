#!/usr/bin/env node
// dispatch.mjs 與各檢查的 run()／CLI 兩種跑法：node test-dispatch.mjs（全過離開碼 0）
// 不寫任何真的 log／狀態：HOOK_NOLOG=1、HOME 指到暫存目錄（session-journal、context-tier 會寫 HOME 底下）。
import './lib/test-config.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.HOOK_NOLOG = '1';
const HERE = dirname(fileURLToPath(import.meta.url));
const T = mkdtempSync(join(tmpdir(), 'dispatch-test-'));
const FAKEHOME = join(T, 'home');
mkdirSync(join(FAKEHOME, '.claude', 'cache'), { recursive: true });
// 新鮮的 update-check 快取：否則 SessionStart 會在背景派一支去跑 brew update、curl npm
writeFileSync(join(FAKEHOME, '.claude', 'cache', 'update-check.json'), JSON.stringify({ t: Date.now() }));
const ENV = { ...process.env, HOME: FAKEHOME, HOOK_NOLOG: '1', FOCUS_GUARD_NOLOG: '1', TMPDIR: T,
  GIT_CONFIG_GLOBAL: join(FAKEHOME, '.gitconfig'), ACCOUNT_CHECK_CACHE_DIR: T,
  UPDATE_CHECK_BREW: join(T, 'no-brew'), UPDATE_CHECK_PROJECTS: join(T, 'no-projects') };

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${extra && !cond ? '  — ' + extra : ''}`);
};
const sh = (file, args, input, cwd = T) => {
  const r = spawnSync(process.execPath, [join(HERE, file), ...args], { input: typeof input === 'string' ? input : JSON.stringify(input), encoding: 'utf8', env: ENV, cwd });
  let j = null; try { j = JSON.parse(r.stdout); } catch {}
  return { code: r.status, out: r.stdout, json: j };
};
const deny = (j) => j?.hookSpecificOutput?.permissionDecision === 'deny';
const reason = (j) => j?.hookSpecificOutput?.permissionDecisionReason ?? '';

const D = await import('./dispatch.mjs');

// ── merge ──
{
  const a = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'A' } };
  const b = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: 'B' } };
  const m = D.merge('PreToolUse', [a, b]);
  ok('兩個 deny 合成一個 deny、理由依序串接', deny(m) && reason(m) === 'A\n\nB');
  ok('沒有人說話就不輸出', D.merge('PreToolUse', []) === null);
  const ctx = D.merge('SessionStart', [{ hookSpecificOutput: { additionalContext: 'x' } }, '純文字', { systemMessage: 'S', hookSpecificOutput: { additionalContext: 'y' } }]);
  ok('additionalContext 依序串接、純文字也算', ctx.hookSpecificOutput.additionalContext === 'x\n\n純文字\n\ny' && ctx.systemMessage === 'S');
  ok('hookEventName 用分派的事件', ctx.hookSpecificOutput.hookEventName === 'SessionStart');
  const st = D.merge('Stop', [{ decision: 'block', reason: 'R', hookSpecificOutput: { hookEventName: 'Stop', permissionDecision: 'deny', permissionDecisionReason: 'R', additionalContext: 'C' } }]);
  ok('Stop 的 block 兩種形狀都留著（Codex 看 decision、Claude 看 hookSpecificOutput）',
    st.decision === 'block' && st.reason === 'R' && deny(st) && st.hookSpecificOutput.additionalContext === 'C');
  const t = D.merge('UserPromptSubmit', [{ hookSpecificOutput: { sessionTitle: 'p｜x' } }]);
  ok('sessionTitle 傳得出去', t.hookSpecificOutput.sessionTitle === 'p｜x');
}

// ── 路由 ──
{
  const names = (ev, tool) => D.checksFor(ev, { tool_name: tool }).map((c) => c.name).join(',');
  ok('Bash 走六支', names('PreToolUse', 'Bash') === 'git-author-guard,commit-message-guard,pushq-guard,pr-guard,focus-guard,kill-guard');
  ok('Stop 有英文收尾檢查、排在 ask-with-options 後面', names('Stop').startsWith('ask-with-options,lang-guard,'));
  ok('Read 什麼都不跑', names('PreToolUse', 'Read') === '');
  ok('browser_batch 走白名單', names('PreToolUse', 'mcp__claude-in-chrome__browser_batch') === 'browser-batch-guard');
  ok('Agent 走模型檢查', names('PreToolUse', 'Agent') === 'agent-model-guard');
  ok('不認得的事件什麼都不跑', names('Nope') === '');
  const cx = (ev, tool) => D.checksFor(ev, { tool_name: tool }, D.CODEX_ROUTES).map((c) => c.name).join(',');
  ok('Codex：SessionStart 只跑不吃 transcript 的三支', cx('SessionStart') === 'session-start-context,blocks-current,update-check');
  ok('Codex：PreToolUse 不看 tool_name（matcher 已篩過）', cx('PreToolUse', 'Bash') === 'git-author-guard,commit-message-guard,pushq-guard,pr-guard,focus-guard,kill-guard' && cx('PreToolUse', 'shell') === cx('PreToolUse', 'Bash'));
  ok('Codex：Stop 只跑 ask-with-options（lang-guard 不搬）、沒有 UserPromptSubmit', cx('Stop') === 'ask-with-options' && cx('UserPromptSubmit') === '');
  const cj = JSON.parse(readFileSync(join(HERE, 'codex-hooks.json'), 'utf8'));
  const cmds = Object.entries(cj.hooks).flatMap(([ev, gs]) => gs.flatMap((g) => g.hooks.map((h) => [ev, h.command])));
  ok('codex-hooks.json 每個事件都是一條 dispatch.mjs <同名事件> codex',
    cmds.length === Object.keys(cj.hooks).length && cmds.every(([ev, c]) => c.endsWith(`dispatch.mjs" ${ev} codex`)) &&
    Object.keys(cj.hooks).every((ev) => D.CODEX_ROUTES[ev]));
}

// ── 單一檢查壞掉不拖垮別人 ──
{
  const fakes = {
    boom: () => { throw new Error('壞了'); },
    hang: () => new Promise(() => {}),
    good: () => ({ hookSpecificOutput: { permissionDecision: 'deny', permissionDecisionReason: 'G' } }),
  };
  const checks = [{ name: 'boom', timeout: 100 }, { name: 'hang', timeout: 100 }, { name: 'good', timeout: 100 }];
  const r = await D.runChecks('PreToolUse', {}, { log: false, loader: async (n) => fakes[n], checks });
  ok('丟例外、逾時的那支跳過，其餘照跑', r.length === 1 && r[0].name === 'good');
  const r2 = await D.runChecks('PreToolUse', {}, { log: false, loader: async () => { throw new Error('沒這支'); }, checks });
  ok('模組載入失敗也跳過', r2.length === 0);
}

// ── 分派器端到端（真的開程序） ──
{
  const GC = 'git com' + 'mit';
  const r = sh('dispatch.mjs', ['PreToolUse'], { tool_name: 'Bash', cwd: T, tool_input: { command: `${GC} -m x && open a.png` } });
  ok('commit -m 與 open 一起擋、兩個理由都在', r.code === 0 && deny(r.json) && reason(r.json).includes("-F - <<'MSG'") && reason(r.json).includes('搶使用者的畫面'), r.out.slice(0, 200));
  const p = sh('dispatch.mjs', ['PreToolUse'], { tool_name: 'Bash', cwd: T, tool_input: { command: 'ls -la' } });
  ok('一般指令放行、不輸出', p.code === 0 && p.out === '');
  const g = sh('dispatch.mjs', ['PreToolUse'], 'not json');
  ok('輸入壞掉 exit 0、不輸出', g.code === 0 && g.out === '');
  const u = sh('dispatch.mjs', [], { hook_event_name: 'PreToolUse', tool_name: 'mcp__claude-in-chrome__browser_batch', tool_input: { actions: [{ name: 'navigate' }, { name: 'resize_window' }] } });
  ok('沒帶事件參數時看 hook_event_name；batch 夾 resize_window 擋', deny(u.json) && reason(u.json).includes('resize_window'));
  const a = sh('dispatch.mjs', ['PreToolUse'], { tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: '你跑好了沒？', options: [{ label: '好' }] }] } });
  ok('AskUserQuestion 問「做了沒」擋', deny(a.json));
  const c = sh('dispatch.mjs', ['PreToolUse', 'codex'], { hook_event_name: 'PreToolUse', tool_name: 'Bash', cwd: T, tool_input: { command: `${GC} -m x` } });
  ok('Codex 模式：commit -m 一樣擋', deny(c.json) && reason(c.json).includes("-F - <<'MSG'"), c.out.slice(0, 200));
  const cs = sh('dispatch.mjs', ['SessionStart', 'codex'], { hook_event_name: 'SessionStart', cwd: T, source: 'startup' });
  ok('Codex 模式：SessionStart 帶開場提醒', cs.json?.hookSpecificOutput?.additionalContext?.includes('AGENTS.md'), cs.out.slice(0, 200));

  // 假作者的 repo
  const R = join(T, 'repo').replace(/\\/g, '/'); // 塞進 bash 指令字串，Windows 的反斜線會被當跳脫
  mkdirSync(R);
  execFileSync('git', ['init', '-q', R], { env: ENV });
  execFileSync('git', ['-C', R, 'config', 'user.email', 'someone@host.local'], { env: ENV });
  // 有 GitHub remote 才算真的 repo（暫存目錄裡沒有 remote 的會被 git-author-guard 當成測試用假 repo）
  execFileSync('git', ['-C', R, 'remote', 'add', 'origin', 'https://github.com/octocat/x.git'], { env: ENV });
  const f = sh('dispatch.mjs', ['PreToolUse'], { tool_name: 'Bash', cwd: T, tool_input: { command: `cd ${R} && ${GC} -F msg.txt` } });
  ok('假作者的 repo commit 被擋（cd 進去才查）', deny(f.json) && reason(f.json).includes('someone@host.local'), f.out.slice(0, 200));
  const f2 = sh('dispatch.mjs', ['PreToolUse'], { tool_name: 'Bash', cwd: R, tool_input: { command: `${GC} -F msg.txt` } });
  ok('沒有 cd 時看 hook 的 cwd', deny(f2.json));
  execFileSync('git', ['-C', R, 'config', 'user.email', 'octo@example.com'], { env: ENV });
  const f3 = sh('dispatch.mjs', ['PreToolUse'], { tool_name: 'Bash', cwd: T, tool_input: { command: `cd ${R} && ${GC} -F msg.txt` } });
  ok('正確作者放行', f3.out === '');

  // Stop：散文問句、這一輪沒用 AskUserQuestion → 擋
  const tr = join(T, 't.jsonl');
  writeFileSync(tr, '{"type":"user","message":{"content":"go"}}\n');
  const s = sh('dispatch.mjs', ['Stop'], { session_id: 's', cwd: T, transcript_path: tr, stop_reason: 'end_turn', last_assistant_message: '兩條路各有代價。你想走哪一條？' });
  ok('Stop 散文問句擋（block＋deny 兩種形狀）', s.json?.decision === 'block' && deny(s.json), s.out.slice(0, 200));
  const s2 = sh('dispatch.mjs', ['Stop'], { session_id: 's', cwd: T, transcript_path: tr, last_assistant_message: '做完了。', stop_hook_active: false });
  ok('Stop 正常收尾不輸出', s2.out === '');
  const s3 = sh('dispatch.mjs', ['Stop', 'codex'], { hook_event_name: 'Stop', session_id: 's', cwd: T, transcript_path: tr, last_assistant_message: '兩條路各有代價。你想走哪一條？' });
  ok('Codex 模式：Stop 散文問句擋（Codex 看 decision）', s3.json?.decision === 'block' && s3.json.reason, s3.out.slice(0, 200));

  const ss = sh('dispatch.mjs', ['SessionStart'], { source: 'startup', cwd: T, session_id: 's' });
  ok('SessionStart 開場提醒出現', ss.json?.hookSpecificOutput?.additionalContext?.includes('AGENTS.md'));
}

// ── 各檢查單獨跑（CLI 保留：除錯、Windows 那台） ──
{
  const GC = 'git com' + 'mit';
  ok('commit-message-guard 單獨跑', deny(sh('commit-message-guard.mjs', [], { tool_input: { command: `${GC} -m x` } }).json));
  ok('focus-guard 單獨跑', deny(sh('focus-guard.mjs', [], { tool_input: { command: 'open a.png' } }).json));
  ok('ask-hides-prose 單獨跑', deny(sh('ask-hides-prose.mjs', [], { tool_input: { questions: [{ question: '貼了嗎', options: [] }] } }).json));
  ok('browser-batch-guard 單獨跑', deny(sh('browser-batch-guard.mjs', [], { tool_input: { actions: [{ name: 'tabs_create_mcp' }] } }).json));
  const ag = (i) => sh('agent-model-guard.mjs', [], { tool_input: { prompt: 'p', ...i } }).json;
  ok('agent-model-guard：沒寫類型也沒寫 model 就擋（大小寫、空白也算）', deny(ag({})) && deny(ag({ subagent_type: 'general-purpose' })) && deny(ag({ subagent_type: 'claude' })) && deny(ag({ subagent_type: ' General-Purpose ' })));
  ok('agent-model-guard：經過 dispatch.mjs 也擋', deny(sh('dispatch.mjs', ['PreToolUse'], { hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_input: { subagent_type: 'general-purpose', prompt: 'p' } }).json));
  ok('agent-model-guard：writer 帶 opus 擋、帶 sonnet／haiku 放行', deny(ag({ subagent_type: 'writer', model: 'opus' })) && !ag({ subagent_type: 'writer', model: 'haiku' }) && !ag({ subagent_type: 'writer', model: 'sonnet' }));
  ok('agent-model-guard：寫了 model、具名子代理、fork 都放行',
    !ag({ subagent_type: 'general-purpose', model: 'sonnet' }) && !ag({ subagent_type: 'writer' }) && !ag({ subagent_type: 'reviewer' }) && !ag({ subagent_type: 'fork' }));
  const tr = join(T, 't.jsonl');
  const s = sh('ask-with-options.mjs', [], { session_id: 's', transcript_path: tr, last_assistant_message: '你想走哪一條？' });
  ok('ask-with-options 單獨跑會擋', s.json?.decision === 'block');
  // 用這個 repo 自己的 blocks.md 當素材；公開版沒有那份就跳過
  if (existsSync(join(HERE, '..', '..', '..', 'blocks.md')))
    ok('blocks-current 單獨跑', sh('blocks-current.mjs', [], { source: 'startup', cwd: join(HERE, '..', '..', '..') }).json?.hookSpecificOutput?.additionalContext?.includes('區塊計畫'));
  {
    // 新塊寫在 docs/blocks.d/ 的碎片裡（animyria 2026-10-21）：blocks.md 全部打勾也不能報「全部完成」
    const R = join(T, 'frag-repo');
    mkdirSync(join(R, '.git'), { recursive: true }); mkdirSync(join(R, 'docs', 'blocks.d'), { recursive: true });
    writeFileSync(join(R, 'blocks.md'), '# 計畫\n\n## A1 舊塊  [完成]\n- 做完了\n');
    writeFileSync(join(R, 'docs', 'blocks.d', 'xy1.md'), '## XY1 碎片裡的新塊  [未開始]\n- 目標：測試\n');
    writeFileSync(join(R, 'docs', 'blocks.d', 'README.md'), '## 說明  [未開始]\n');
    const msg = sh('blocks-current.mjs', [], { source: 'startup', cwd: R }).json?.hookSpecificOutput?.additionalContext ?? '';
    ok('blocks-current 讀 docs/blocks.d 的新塊、跳過 README、講出碎片檔路徑', msg.includes('XY1 碎片裡的新塊') && msg.includes('完成 1／剩 1') && msg.includes(join('docs', 'blocks.d', 'xy1.md')));
    // 既有塊的落地紀錄（不帶狀態）不能被併進別的塊的內容
    writeFileSync(join(R, 'blocks.md'), '# 計畫\n\n## A1 舊塊  [完成]\n- 做完了\n\n## A2 下一塊  [未開始]\n- 驗收：A2\n');
    writeFileSync(join(R, 'docs', 'blocks.d', 'a1.md'), '## A1 落地紀錄\n- 紀錄內容ZZZ\n');
    writeFileSync(join(R, 'blocks.md'), '# 計畫\n\n## A1 舊塊  [完成]\n- 做完了\n');
    writeFileSync(join(R, 'docs', 'blocks.d', 'xy1.md'), '## XY1 新塊  [完成]\n- 好了\n');
    writeFileSync(join(R, 'docs', 'blocks.d', 'bx10.md'), '## BX10 後面的塊  [未開始]\n- 不該先挑\n');
    writeFileSync(join(R, 'docs', 'blocks.d', 'bx2.md'), '## BX2 新塊  [未開始]\n```bash\n# 先建置\n./run.sh check\n```\n- 驗收WWW\n\n## BX2 落地紀錄\n- 紀錄內容QQQ\n');
    const m2 = sh('blocks-current.mjs', [], { source: 'startup', cwd: R }).json?.hookSpecificOutput?.additionalContext ?? '';
    ok('blocks-current：碎片照數字排、圍欄裡的 # 不切段、不帶狀態的落地紀錄不併進前一塊',
      m2.includes('BX2 新塊') && m2.includes('驗收WWW') && !m2.includes('QQQ') && !m2.includes('ZZZ') && m2.includes('完成 2／剩 2'));
  }
  ok('update-check 單獨跑 exit 0', sh('update-check.mjs', [], { source: 'resume' }).code === 0);
  ok('壞輸入單獨跑 exit 0', sh('focus-guard.mjs', [], 'x').code === 0 && sh('ask-with-options.mjs', [], '').code === 0);
}

// ── account-check 的快取 ──（公開版拿掉了多帳號那支，沒有就跳過）
if (existsSync(join(HERE, 'account-check.mjs'))) {
  process.env.ACCOUNT_CHECK_CACHE_DIR = T;   // 模組載入時就讀，要先設
  const A = await import('./account-check.mjs');
  const key = process.env.CLAUDE_CONFIG_DIR || join(process.env.HOME, '.claude');
  writeFileSync(join(T, 'account-check.json'), JSON.stringify({ [key]: Date.now() }));
  const t0 = performance.now();
  const r = await A.run({});
  ok('一小時內查過沒問題就不再查（< 20ms）', r === null && performance.now() - t0 < 20, `${(performance.now() - t0).toFixed(1)}ms`);
}

console.log(`\n  ${pass} 過 · ${fail} 失敗`);
process.exit(fail ? 1 : 0);
