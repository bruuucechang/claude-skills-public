#!/usr/bin/env node
// node test-session-title.mjs —— session-title 的規則版標題、Haiku 回覆解析、狀態流轉（不真的叫 Haiku、不讀真的 ~/Projects）
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { aboutSettings, firstTitle, handoffBrief, lastTitle, mentioned, parseNamer, projectOf, run } from './session-title.mjs';

const H = homedir();
assert.equal(projectOf(join(H, 'Projects/palrogue/src')), 'palrogue');
assert.equal(projectOf(join(H, '.claude/skills')), 'claude設定');
assert.equal(projectOf(join(H, '.claude-work')), 'claude設定');
assert.equal(projectOf(join(H, '.claudeXYZ')), null);
assert.equal(projectOf(H), null);
assert.equal(projectOf(join(H, 'Projects/animyria-lanes/v4d5')), 'animyria');
assert.equal(projectOf(join(H, 'Projects/animyria-lora')), 'animyria-lora');
// 依倉庫名：同一個 repo 的另一份工作目錄算原專案（本機實際資料夾，沒有就跳過）
if (existsSync(join(H, 'Projects/animyria-lora-xc/.git'))) assert.equal(projectOf(join(H, 'Projects/animyria-lora-xc')), 'animyria-lora');
if (existsSync(join(H, 'Projects/animyria-pixgen/.git'))) assert.equal(projectOf(join(H, 'Projects/animyria-pixgen')), 'animyria');
for (const s of ['修 stripe webhook 驗簽', 'React hooks 重寫', 'login session 過期', 'animyria 的 skill 冷卻太長', '幫 animyria 角色取名']) assert.equal(aboutSettings(s), false, s);
for (const s of ['你的session取名還是沒做好', '改 skills 的 hook', '更新 CLAUDE.md']) assert.equal(aboutSettings(s), true, s);
assert.equal(mentioned('修 animyria-lora 的訓練', ['animyria', 'animyria-lora']), 'animyria-lora');
assert.equal(mentioned('看一下 termkitten', ['termkit']), null);
assert.equal(mentioned('修News的爬蟲', ['News']), 'News');

const c = { fixed: null, candidates: ['animyria', '雜項'] };
assert.equal(parseNamer('{"project":"animyria","detail":"git graft 研究"}', c), 'animyria｜git graft 研究');
assert.equal(parseNamer('好的 {"project":"animyria","detail":"x"} 附註 {a}', c), 'animyria｜x');
assert.equal(parseNamer('{"project":"不存在","detail":"x"}', c), null);
assert.equal(parseNamer('{"project":"雜項","detail":{"a":1}}', c), null);
assert.equal(parseNamer('{"project":"雜項","detail":"一二三四五六七八九十一二三四五六七"}', c), '雜項｜一二三四五六七八九十一二三四五六…');
assert.equal(parseNamer('{"project":"雜項","detail":"x"}', { ...c, fixed: 'palrogue' }), 'palrogue｜x');
assert.equal(parseNamer('沒有 JSON', c), null);

process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
const STATE = join(tmpdir(), 'claude-session-title');
const projects = () => ['animyria'];

// 家目錄：開場不掛名，第一句給規則版並叫 namer，namer 沒好之前不動，好了套一次
{
  const id = randomUUID(); let spawned = 0;
  const ev = (e, extra) => run({ hook_event_name: e, session_id: id, cwd: H, ...extra }, { spawnNamer: () => { spawned++; }, projects });
  assert.equal(ev('SessionStart', { source: 'startup' }), null);
  assert.equal(ev('UserPromptSubmit', { prompt: '/clear' }), null);
  assert.equal(ev('UserPromptSubmit', { prompt: '幫我修 animyria 的存檔' }).hookSpecificOutput.sessionTitle, 'animyria｜修 animyria 的存檔');
  assert.equal(spawned, 1);
  assert.equal(ev('UserPromptSubmit', { prompt: '繼續' }), null);
  writeFileSync(join(STATE, id), JSON.stringify({ phase: 'ready', title: 'animyria｜存檔修復' }));
  assert.equal(ev('UserPromptSubmit', { prompt: '繼續' }).hookSpecificOutput.sessionTitle, 'animyria｜存檔修復');
  assert.equal(ev('UserPromptSubmit', { prompt: '繼續' }), null, '只套一次');
}

// 使用者在中間 /rename 過：Haiku 版不蓋掉
{
  const id = randomUUID(); const tr = join(STATE, `${id}.jsonl`);
  writeFileSync(tr, '{"type":"custom-title","customTitle":"雜項｜x","sessionId":"s"}\n{"type":"custom-title","customTitle":"我自己取的 \\"名\\"","sessionId":"s"}\n');
  assert.equal(lastTitle(tr), '我自己取的 "名"');
  writeFileSync(join(STATE, id), JSON.stringify({ phase: 'ready', title: '雜項｜Haiku', fallback: '雜項｜x', transcript: tr }));
  assert.equal(run({ hook_event_name: 'UserPromptSubmit', session_id: id, cwd: H, prompt: 'y' }, { projects }), null);
}

// 開場後、第一句前就 /rename：第一句不給標題、也不叫 Haiku
{
  const id = randomUUID(); const tr = join(STATE, `${id}.jsonl`); let spawned = 0;
  writeFileSync(tr, '{"type":"custom-title","customTitle":"我的名字","sessionId":"s"}\n');
  const ev = (e, extra) => run({ hook_event_name: e, session_id: id, cwd: H, transcript_path: tr, ...extra }, { spawnNamer: () => { spawned++; }, projects });
  ev('SessionStart', { source: 'startup' });
  assert.equal(ev('UserPromptSubmit', { prompt: '查天氣' }), null);
  assert.equal(spawned, 0);
}

// /clear 之後：Claude Code 把上一個 session 的名字抄進 transcript 開頭，那不算 /rename，第一句照樣取名
{
  const id = randomUUID(); const tr = join(STATE, `${id}.jsonl`); let spawned = 0;
  const old = '{"type":"custom-title","customTitle":"animyria｜上一個 session","sessionId":"s"}\n';
  writeFileSync(tr, old + '{"attachment":{"type":"hook_success","hookEvent":"SessionStart"}}\n' + old.repeat(2));
  assert.equal(firstTitle(tr), 'animyria｜上一個 session');
  const ev = (e, extra) => run({ hook_event_name: e, session_id: id, cwd: join(H, 'Projects/animyria'), transcript_path: tr, ...extra }, { spawnNamer: () => { spawned++; }, projects });
  ev('SessionStart', { source: 'clear' });
  assert.equal(ev('UserPromptSubmit', { prompt: '/clear' }), null);
  assert.equal(ev('UserPromptSubmit', { prompt: '查天氣' }).hookSpecificOutput.sessionTitle, 'animyria｜查天氣');
  assert.equal(spawned, 1);
}

// /clear 之後、第一句前又 /rename：尊重使用者取的
{
  const id = randomUUID(); const tr = join(STATE, `${id}.jsonl`); let spawned = 0;
  writeFileSync(tr, '{"type":"custom-title","customTitle":"animyria｜上一個 session","sessionId":"s"}\n{"attachment":{"type":"hook_success","hookEvent":"SessionStart"}}\n{"type":"custom-title","customTitle":"我的名字","sessionId":"s"}\n');
  const ev = (e, extra) => run({ hook_event_name: e, session_id: id, cwd: join(H, 'Projects/animyria'), transcript_path: tr, ...extra }, { spawnNamer: () => { spawned++; }, projects });
  ev('SessionStart', { source: 'clear' });
  assert.equal(ev('UserPromptSubmit', { prompt: '查天氣' }), null);
  assert.equal(spawned, 0);
}

// /clear 前的 session 沒名字、第一句前 /rename：開頭沒有抄過來的名字，使用者取的不能被當成抄過來的
{
  const id = randomUUID(); const tr = join(STATE, `${id}.jsonl`); let spawned = 0;
  writeFileSync(tr, '{"attachment":{"type":"hook_success","hookEvent":"SessionStart"}}\n{"type":"custom-title","customTitle":"我的名字","sessionId":"s"}\n');
  assert.equal(firstTitle(tr), null);
  const ev = (e, extra) => run({ hook_event_name: e, session_id: id, cwd: join(H, 'Projects/animyria'), transcript_path: tr, ...extra }, { spawnNamer: () => { spawned++; }, projects });
  ev('SessionStart', { source: 'clear' });
  assert.equal(ev('UserPromptSubmit', { prompt: '查天氣' }), null);
  assert.equal(spawned, 0);
}

// 舊版 hook 開場的 session（狀態檔沒有 source）：/clear 抄過來的名字照樣不算 /rename（2026-10-23 這個 session 卡住的情況）
{
  const id = randomUUID(); const tr = join(STATE, `${id}.jsonl`); let spawned = 0;
  writeFileSync(tr, '{"type":"custom-title","customTitle":"雜項｜上一個","sessionId":"s"}\n{"attachment":{"type":"hook_success","hookEvent":"SessionStart"}}\n{"type":"custom-title","customTitle":"雜項｜上一個","sessionId":"s"}\n');
  mkdirSync(STATE, { recursive: true });
  writeFileSync(join(STATE, id), JSON.stringify({ phase: 'pending', cwd: H, transcript: tr }));
  const r = run({ hook_event_name: 'UserPromptSubmit', session_id: id, cwd: H, transcript_path: tr, prompt: '修 animyria 的存檔' }, { spawnNamer: () => { spawned++; }, projects });
  assert.equal(r.hookSpecificOutput.sessionTitle, 'animyria｜修 animyria 的存檔');
  assert.equal(spawned, 1);
}

// 自動換手的固定開場白：不拿那行取名，改用交接單標題、快照 cwd 認專案、交成 Haiku 的是交接單內文
{
  const pf = join(STATE, `${randomUUID()}.prompt.md`);
  writeFileSync(pf, ['交接單（/x/h.md）的全文附在下面，照它接手上一個 session，不用再讀一次。', '只有重大事件才停。', '', '## 交接單全文', '',
    '# 交接：照度分析，從 B7 開工', '', '## 目標', '盤點軟體', '', `## 現況快照（recon-check，cwd ${join(H, 'Projects/animyria')}，exit 0）`, '', '    ok'].join('\n'));
  const line = `照開場資料裡的換手開場白做（沒有的話讀 ${pf}）`;
  const b = handoffBrief(line);
  assert.equal(b.title, '照度分析，從 B7 開工');
  assert.equal(b.cwd, join(H, 'Projects/animyria'));
  assert.ok(b.text.includes('盤點軟體') && !b.text.includes('ok') && !b.text.includes('不用再讀'));
  assert.equal(handoffBrief('查天氣'), null);

  const id = randomUUID(); let spawned = 0;
  const ev = (e, extra) => run({ hook_event_name: e, session_id: id, cwd: H, ...extra }, { spawnNamer: () => { spawned++; }, projects });
  ev('SessionStart', { source: 'clear' });
  assert.equal(ev('UserPromptSubmit', { prompt: line }).hookSpecificOutput.sessionTitle, 'animyria｜照度分析，從 B7 開工');
  assert.equal(spawned, 1);
  const st = JSON.parse(readFileSync(join(STATE, id), 'utf8'));
  assert.equal(st.fixed, 'animyria');
  assert.equal(st.handoff, true);
  assert.ok(st.prompt.startsWith('# 交接：照度分析'));

  // 交接單標題以專案名開頭：細項不再重複專案名
  writeFileSync(pf, ['交接單（/x/h.md）的全文附在下面。', '## 交接單全文', '', '# 交接：animyria 存檔修正', '', `## 現況快照（recon-check，cwd ${join(H, 'Projects/animyria')}，exit 0）`].join('\n'));
  const id3 = randomUUID();
  run({ hook_event_name: 'SessionStart', session_id: id3, cwd: H, source: 'clear' });
  assert.equal(run({ hook_event_name: 'UserPromptSubmit', session_id: id3, cwd: H, prompt: line }, { spawnNamer: () => {}, projects }).hookSpecificOutput.sessionTitle, 'animyria｜存檔修正');

  // 前綴是別的專案名（animyria-lanes）不切；沒快照就用「工作目錄是」那行，不拿交接單路徑當 cwd；沒有 H1 不抓 code block 的註解
  writeFileSync(pf, ['交接單（/Users/x/.claude-work/jobs/j/h.md）的全文附在下面。', `工作目錄是 ${join(H, 'Projects/animyria')}（不一樣就 cd 過去）。`, '## 交接單全文', '', '# 交接：animyria-lanes 修 lane'].join('\n'));
  assert.equal(handoffBrief(line).cwd, join(H, 'Projects/animyria'));
  const id4 = randomUUID();
  run({ hook_event_name: 'SessionStart', session_id: id4, cwd: H, source: 'clear' });
  assert.equal(run({ hook_event_name: 'UserPromptSubmit', session_id: id4, cwd: H, prompt: line }, { spawnNamer: () => {}, projects }).hookSpecificOutput.sessionTitle, 'animyria｜animyria-lanes 修 l…');
  writeFileSync(pf, ['交接單（/x/h.md）的全文附在下面。', '## 交接單全文', '', '交接：照度', '```bash', '# 先跑測試', '```'].join('\n'));
  assert.equal(handoffBrief(line).title, null);
  assert.equal(handoffBrief(line).cwd, null);

  // 在 animyria 那格 /clear、接手的是改 skills 的交接單：照交接單的工作目錄，不照那格的 cwd（2026-10-23）
  writeFileSync(pf, ['交接單（/x/h.md）的全文附在下面。', `工作目錄是 ${join(H, '.claude/skills')}（不一樣就 cd 過去）。`, '## 交接單全文', '', '# 交接：外部 skill 搬運＋前端全面改造'].join('\n'));
  const id5 = randomUUID();
  run({ hook_event_name: 'SessionStart', session_id: id5, cwd: join(H, 'Projects/animyria'), source: 'clear' });
  assert.equal(run({ hook_event_name: 'UserPromptSubmit', session_id: id5, cwd: join(H, 'Projects/animyria'), prompt: line }, { spawnNamer: () => {}, projects }).hookSpecificOutput.sessionTitle, 'claude設定｜外部 skill 搬運＋前端全面改造');

  // 開場白檔不見了：也不拿那行取名
  const id2 = randomUUID();
  const ev2 = (e, extra) => run({ hook_event_name: e, session_id: id2, cwd: H, ...extra }, { spawnNamer: () => {}, projects });
  ev2('SessionStart', { source: 'clear' });
  assert.equal(ev2('UserPromptSubmit', { prompt: '照開場資料裡的換手開場白做（沒有的話讀 /nope/x.prompt.md）' }).hookSpecificOutput.sessionTitle, '雜項｜接手上一個 session');
}

// 第一句在講取名／skill，順帶提到 animyria：規則版是 claude設定，不是 animyria（2026-10-23）
{
  const id = randomUUID();
  run({ hook_event_name: 'SessionStart', session_id: id, cwd: H, source: 'startup' });
  const r = run({ hook_event_name: 'UserPromptSubmit', session_id: id, cwd: H, prompt: '你的session取名還是沒做好 有些雜項根本是animyria' }, { spawnNamer: () => {}, projects: () => ['animyria', 'session-remote'] });
  assert.match(r.hookSpecificOutput.sessionTitle, /^claude設定｜/);
  const id2 = randomUUID();
  run({ hook_event_name: 'SessionStart', session_id: id2, cwd: H, source: 'startup' });
  const r2 = run({ hook_event_name: 'UserPromptSubmit', session_id: id2, cwd: H, prompt: '修 session-remote 的連線' }, { spawnNamer: () => {}, projects: () => ['animyria', 'session-remote'] });
  assert.match(r2.hookSpecificOutput.sessionTitle, /^session-remote｜/);
}

// startup：`claude -n 名字` 的名字寫在 SessionStart 之前，那是使用者取的，不能被當成 /clear 抄來的
{
  const id = randomUUID(); const tr = join(STATE, `${id}.jsonl`); let spawned = 0;
  writeFileSync(tr, '{"type":"last-prompt"}\n{"type":"custom-title","customTitle":"我的名字","sessionId":"s"}\n{"attachment":{"hookName":"SessionStart:startup","hookEvent":"SessionStart"}}\n');
  const ev = (e, extra) => run({ hook_event_name: e, session_id: id, cwd: H, transcript_path: tr, ...extra }, { spawnNamer: () => { spawned++; }, projects });
  ev('SessionStart', { source: 'startup' });
  assert.equal(ev('UserPromptSubmit', { prompt: '修 animyria 的存檔' }), null);
  assert.equal(spawned, 0);
}

// headless：給規則版、不叫 Haiku
{
  const id = randomUUID(); let spawned = 0;
  process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-cli';
  const ev = (e, extra) => run({ hook_event_name: e, session_id: id, cwd: H, ...extra }, { spawnNamer: () => { spawned++; }, projects });
  ev('SessionStart', { source: 'startup' });
  assert.equal(ev('UserPromptSubmit', { prompt: '查天氣' }).hookSpecificOutput.sessionTitle, '雜項｜查天氣');
  assert.equal(spawned, 0);
  process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
}

assert.equal(run({ hook_event_name: 'UserPromptSubmit', session_id: randomUUID(), cwd: H, prompt: 'x' }, { projects }), null, 'resume 進來的不動');
console.log('session-title: ok');
