#!/usr/bin/env node
// lang-guard 的案例表：node test-lang-guard.mjs（全過離開碼 0）。案例取自近 14 天的真實收尾（replay-p3.mjs lang）。
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

process.env.HOOK_NOLOG = '1';
process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';     // 在 claude -p 裡跑測試時也要當成互動
const HERE = dirname(fileURLToPath(import.meta.url));
const { isEnglish, counts, run } = await import('./lang-guard.mjs');

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${extra && !cond ? '  — ' + extra : ''}`);
};

const EN = [
  'Round 11 is done and pushed to `block/b30-camp-art` (commit `3cdd8c5d`). The review page now has this round\'s 5 screenshots: https://example.com/x',
  'I\'ll fill in all six hashes together once 菊地 finishes. The background wait will wake me.',
  'The new rule works. It\'s continuing the half-downloaded "いおりんキュバス 1" without using quota (8 left). Next should be "要誘惑你喔".',
  'Tests are still running in the background; I\'ll wait for the notification.',
  'Waiting on the push.',
  'Round 6 won too.',
  '1. Done\n    The tests pass and everything has been pushed to the branch, review page updated.',
  '> Everything is pushed and the review page has been updated with the new screenshots.',
  '1. 狀態\n    - The tests all pass and the branch is pushed, the review page is updated too.\n    - Nothing else is pending on this side.',
  'Batch 1 done (5/8). Waiting on 4, 5, 6.',
  // 2026-10-21 漏網：英文散文＋一張全是中文地名的表
  'Sorry, the preview box was cut off. Here are both sets side by side:\n\n| Region | A | B |\n|---|---|---|\n| 平原 | 萬穗醒原0 | 醒穗原0 |\n| 平原 | 萬穗醒原1 | 醒穗原1 |\n| 平原 | 萬穗醒原2 | 醒穗原2 |\n| 平原 | 萬穗醒原3 | 醒穗原3 |\n| 平原 | 萬穗醒原4 | 醒穗原4 |\n| 平原 | 萬穗醒原5 | 醒穗原5 |\n| 平原 | 萬穗醒原6 | 醒穗原6 |\n| 平原 | 萬穗醒原7 | 醒穗原7 |\n| 平原 | 萬穗醒原8 | 醒穗原8 |\n| 平原 | 萬穗醒原9 | 醒穗原9 |\n| 平原 | 萬穗醒原10 | 醒穗原10 |\n| 平原 | 萬穗醒原11 | 醒穗原11 |\n| 平原 | 萬穗醒原12 | 醒穗原12 |\n| 平原 | 萬穗醒原13 | 醒穗原13 |\n| 平原 | 萬穗醒原14 | 醒穗原14 |\n| 平原 | 萬穗醒原15 | 醒穗原15 |\n| 平原 | 萬穗醒原16 | 醒穗原16 |\n| 平原 | 萬穗醒原17 | 醒穗原17 |\n| 平原 | 萬穗醒原18 | 醒穗原18 |\n| 平原 | 萬穗醒原19 | 醒穗原19 |\n| 平原 | 萬穗醒原20 | 醒穗原20 |\n| 平原 | 萬穗醒原21 | 醒穗原21 |\n| 平原 | 萬穗醒原22 | 醒穗原22 |\n| 平原 | 萬穗醒原23 | 醒穗原23 |\n| 平原 | 萬穗醒原24 | 醒穗原24 |\n| 平原 | 萬穗醒原25 | 醒穗原25 |\n| 平原 | 萬穗醒原26 | 醒穗原26 |\n| 平原 | 萬穗醒原27 | 醒穗原27 |\n| 平原 | 萬穗醒原28 | 醒穗原28 |\n| 平原 | 萬穗醒原29 | 醒穗原29 |\n| 平原 | 萬穗醒原30 | 醒穗原30 |\n| 平原 | 萬穗醒原31 | 醒穗原31 |\n| 平原 | 萬穗醒原32 | 醒穗原32 |\n| 平原 | 萬穗醒原33 | 醒穗原33 |\n\nI\'d go with **B**. Its short, hard feel matches the other names you just picked. Reply with **A**, **B**, or a mix, and I\'ll write this round\'s decisions into the spec and push it.',
  'All workers are paused, so you can take the computer out now.\n\n- **The three workers (mani, desk, victus):** I turned off each one\'s loop.\n- Nothing is lost.',
];
const ZH = [
  '等 reviewer、net-check／pad／play 與佔位推送。',
  'Baseline 存好了。等 pre-push。',
  '等 net-view 結果。',
  'mutant 紅了。等模擬器 sweep 跑完（背景）。',
  'PR 已開（https://github.com/bruuucechang/manga-lore/pull/1），程式碼審查正在背景跑，結果出來後我再決定要不要合併。',
  'test 全過（2154／0 失敗）、check exit 0；現在在背景跑 `./run.sh play`，跑完再 commit。',
  '家目錄裡最大的四塊是 Library 103 GB、code 72 GB、Downloads 45 GB、Pictures 12 GB。我正在往裡面細查是哪些東西占掉的，例如 Docker、Xcode。',
  '改好了，`~/.claude/skills/home/claude/hooks/lang-guard.mjs` 加進 Stop。\n\n```bash\nnode test-lang-guard.mjs && node replay-p3.mjs lang 14 --with a very long english explanation inside the code block that should not count\n```\n\n測試全過。',
  '全端沒有通用縮寫。業界常見的寫法是：- **FSE / DBA**：Full-Stack Engineer 縮成 FSE，DBA 本身就是縮寫，可以直接用。',
  '做完了。',
  '兩個帳號的用量如下，表格是 API 回傳的原文：\n\n| account | weekly usage | resets at |\n|---|---|---|\n| bruce | ninety percent of the weekly limit | Monday morning |\n| peter | twelve percent of the weekly limit | Monday morning |\n\n照規則 bruce 到 90% 要換到 peter。',
  '',
  "You've hit your weekly limit · resets 12am (Asia/Taipei)",
  'API Error: Your computer went to sleep mid-response. The response above may be incomplete.',
];
for (const t of EN) ok(`英文擋：${t.replace(/\s+/g, ' ').slice(0, 60)}`, isEnglish(t), JSON.stringify(counts(t)));
for (const t of ZH) ok(`放行：${t.replace(/\s+/g, ' ').slice(0, 60) || '（空字串）'}`, !isEnglish(t), JSON.stringify(counts(t)));

// run()：輸出形狀、一回合最多一次、非互動不擋
{
  const base = { session_id: 's', stop_reason: 'end_turn', last_assistant_message: EN[0] };
  const o = run(base);
  ok('run：block＋deny 兩種形狀', o?.decision === 'block' && o?.hookSpecificOutput?.permissionDecision === 'deny' && /繁體中文/.test(o.reason));
  ok('run：stop_hook_active（這回合已擋過）放行——不會無限迴圈', run({ ...base, stop_hook_active: true }) === null);
  ok('run：stop_reason 不是 end_turn 放行', run({ ...base, stop_reason: 'max_tokens' }) === null);
  process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-cli';
  ok('run：claude -p（sdk-cli）放行', run(base) === null);
  process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
  ok('run：中文收尾放行', run({ ...base, last_assistant_message: ZH[5] }) === null);
  ok('run：壞輸入放行', run(null) === null);
}

// 經過 dispatch 的整條路：跟 ask-with-options 同時擋時理由串在一起；第二次（stop_hook_active）兩支都放行
{
  const T = mkdtempSync(join(tmpdir(), 'lang-guard-test-'));
  const tr = join(T, 't.jsonl');
  writeFileSync(tr, JSON.stringify({ type: 'user', message: { content: 'go' } }) + '\n');
  const env = { ...process.env, HOOK_NOLOG: '1', CLAUDE_CODE_ENTRYPOINT: 'cli', HOME: T };
  const sh = (input) => {
    const r = spawnSync(process.execPath, [join(HERE, 'dispatch.mjs'), 'Stop'], { input: JSON.stringify(input), encoding: 'utf8', env, cwd: T });
    let j = null; try { j = JSON.parse(r.stdout); } catch {}
    return { out: r.stdout, j };
  };
  const both = sh({ session_id: 's', cwd: T, transcript_path: tr, stop_reason: 'end_turn', last_assistant_message: 'There are two ways to do this, each with its own trade-offs. Which one do you want?' });
  ok('dispatch Stop：英文問句兩支一起擋、理由串接', both.j?.decision === 'block' && /問句/.test(both.j.reason) && /繁體中文/.test(both.j.reason), both.out.slice(0, 300));
  const again = sh({ session_id: 's', cwd: T, transcript_path: tr, stop_reason: 'end_turn', stop_hook_active: true, last_assistant_message: 'Still English after the retry, sorry about that.' });
  ok('dispatch Stop：stop_hook_active 時不再擋', again.out === '', again.out.slice(0, 200));
  const zh = sh({ session_id: 's', cwd: T, transcript_path: tr, stop_reason: 'end_turn', last_assistant_message: '做完了，測試全過。' });
  ok('dispatch Stop：中文收尾不輸出', zh.out === '', zh.out.slice(0, 200));
}

console.log(`\n${pass} 過、${fail} 失敗`);
process.exit(fail ? 1 : 0);
