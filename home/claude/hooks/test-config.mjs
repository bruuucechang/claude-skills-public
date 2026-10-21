#!/usr/bin/env node
// config.json 沒設（公開版剛 clone、還沒跑 install.sh）時，讀設定的檢查都要「不動作」：
//   node test-config.mjs（全過離開碼 0）
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const f = join(mkdtempSync(join(tmpdir(), 'skills-config-')), 'config.json');
writeFileSync(f, '{}');
process.env.CLAUDE_SKILLS_CONFIG = f;

const { run: author } = await import('./git-author-guard.mjs');
const { run: lang } = await import('./lang-guard.mjs');
const { isMine } = await import('./lib/shell-git.mjs');
const { checksFor, runChecks } = await import('./dispatch.mjs');

let fail = 0;
const check = (ok, label) => { console.log(`${ok ? '✓' : '✗'} ${label}`); if (!ok) fail++; };

check(author({ tool_input: { command: 'git commit -m x' }, cwd: process.cwd() }) === null, '沒設 git_emails：不擋 commit');
check(lang({ last_assistant_message: 'This is a long English report. '.repeat(20) }) === null, 'language 沒設：不擋英文');
check(isMine('https://github.com/octocat/x.git') === false, '沒設 github_owner：沒有 repo 算自己的');
const r = await runChecks('X', {}, { log: false, checks: [{ name: 'no-such-check', timeout: 1000 }] });
check(r.length === 0, '路由裡的檢查檔不存在：安靜跳過');
check(checksFor('Stop', {}).length > 0, '路由本身照舊');

const r2 = await runChecks('X', {}, { log: false, checks: [{ name: 'account-check', timeout: 1000 }, { name: 'typo-guard', timeout: 1000 }] });
check(r2.length === 0, '選配的檢查不在：跳過；不認得的檢查：照樣當錯誤（runChecks 吞掉、記 log）');

// config.json 壞掉要講出來
import { spawnSync } from 'node:child_process';
import { dirname as dn } from 'node:path';
import { fileURLToPath as f2p } from 'node:url';
const bad = join(mkdtempSync(join(tmpdir(), 'skills-config-')), 'config.json');
writeFileSync(bad, '{ <<<<<<< HEAD');
const s = spawnSync(process.execPath, [join(dn(f2p(import.meta.url)), 'dispatch.mjs'), 'SessionStart'],
  { input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 't', cwd: tmpdir() }), encoding: 'utf8',
    env: { ...process.env, CLAUDE_SKILLS_CONFIG: bad, HOOK_NOLOG: '1' } });
check(/config\.json 讀不懂/.test(s.stdout), 'config.json 壞掉：SessionStart 用 systemMessage 講出來');

// pr_guard: false（install.sh 在 git 不到 2.55 時寫的）：推自己的 repo 不能因為「沒裝 pre-push」被擋
{
  const R = mkdtempSync(join(tmpdir(), 'prg-'));
  spawnSync('git', ['init', '-q', R]); spawnSync('git', ['-C', R, 'remote', 'add', 'origin', 'https://github.com/octocat/x.git']);
  const cfg = (o) => { const p = join(mkdtempSync(join(tmpdir(), 'skills-config-')), 'config.json'); writeFileSync(p, JSON.stringify(o)); return p; };
  const empty = join(mkdtempSync(join(tmpdir(), 'gitcfg-')), 'gitconfig'); writeFileSync(empty, '');
  const push = (c) => spawnSync(process.execPath, [join(dn(f2p(import.meta.url)), 'pr-guard.mjs')],
    { input: JSON.stringify({ tool_input: { command: 'git push -u origin pr/1-x' }, cwd: R }), encoding: 'utf8',
      env: { ...process.env, CLAUDE_SKILLS_CONFIG: c, GIT_CONFIG_GLOBAL: empty, HOOK_NOLOG: '1' } }).stdout;
  check(!/deny/.test(push(cfg({ github_owner: 'octocat', pr_guard: false }))), 'pr_guard false：沒裝 pre-push 也放行');
  if (process.platform === 'darwin') check(/deny/.test(push(cfg({ github_owner: 'octocat' }))), 'pr_guard 沒寫（私人版）：沒裝 pre-push 照樣擋');
}

// 私人版：追蹤進 repo 的 config.json 要有值（被清空的話所有保護會安靜關掉，測試要紅）
const own = join(dn(f2p(import.meta.url)), '..', 'config.json');
const tracked = spawnSync('git', ['ls-files', '--error-unmatch', own], { cwd: dn(own), stdio: 'ignore' }).status === 0;
if (tracked) {
  const c = JSON.parse(readFileSync(own, 'utf8'));
  check(c.github_owner && c.git_emails?.length && c.language === 'zh-TW', '私人版 config.json 有 owner、email、語言');
}

console.log(fail ? `${fail} 個失敗` : '全過');
process.exit(fail ? 1 : 0);
