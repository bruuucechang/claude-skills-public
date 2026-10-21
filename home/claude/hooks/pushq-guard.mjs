#!/usr/bin/env node
/**
 * PreToolUse(Bash) hook —— 推送佇列（pushq）登記過的 repo，不准繞過 pre-push 直接推 master。
 *
 * ## 為什麼 pre-push 擋不夠
 *
 * 2026-10-20 animyria 改成「master 只由背景程序 pushq 依序推」（規格 ~/.claude/skills/handoff/push-queue-spec.md），
 * 擋法放在 pre-push。但 **`git push --no-verify` 整個不跑 pre-push**：上線 20 分鐘內就有一格用它推了 BD10b，
 * 佇列推的那件因此被拒、要重新合併再跑 10〜50 分鐘的測試——又回到原本撞車的問題。
 * 從紀錄看 `--no-verify` 當天已經被好幾格當成「搶空檔」的辦法。
 *
 * ## 判準
 *
 * 同一段（到 `&&`／`;`／`|` 為止）裡有 `git … push`，而且：
 *   · 帶 `--no-verify`，或指令裡設了 `PUSHQ_BYPASS`／`PUSHQ_PUSHER`（佇列與使用者手動用的，不是給 session 的）
 *   · 那段提到登記分支的名字（`HEAD:master`、`origin master`、`refs/heads/master`）
 *   · 而 cwd 或指令裡 `cd`／`git -C` 的目錄屬於登記過的 repo（共用的 git 目錄比對，lane worktree 也算）
 * 才擋。推別的分支、推別的 repo、沒帶繞道旗標的一般推（pre-push 自己會擋、會印改用佇列的說明）都放行。
 *
 * 使用者自己在終端機打的指令不經過這支 hook，所以 `PUSHQ_BYPASS=1 git push` 仍是他的繞道。
 *
 * ## 逃生門
 *
 *     touch ~/.claude/skills/home/claude/hooks/pushq-guard.off
 *
 * 稽核寫在 pushq-guard.log。
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendLog } from './lib/log.mjs';
import { cli, isMain, tilde } from './lib/hook-cli.mjs';
import { commonDir, hasNoVerify, pushSegments, real, repoDirs, stripData } from './lib/shell-git.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OFF = join(HERE, 'pushq-guard.off');
const LOG = join(HERE, 'pushq-guard.log');
const HOME = homedir();
const REPOS = process.env.PUSHQ_HOME ? join(process.env.PUSHQ_HOME, 'repos.json') : join(HOME, '.claude', 'state', 'pushq', 'repos.json');


/** 回 null＝放行。這支壞掉不該擋住任何指令。 */
export function run(input) {
  if (existsSync(OFF)) return null;
  const cmd = input?.tool_input?.command ?? '';
  if (typeof cmd !== 'string' || !/\bpush\b/.test(cmd) || !/\bgit\b/.test(cmd)) return null;
  let repos;
  try { repos = JSON.parse(readFileSync(REPOS, 'utf8')); } catch { return null; }
  if (!repos || !Object.keys(repos).length) return null;

  const bypassEnv = /\bPUSHQ_(BYPASS|PUSHER)=/.test(stripData(cmd));   // heredoc／echo 裡寫到不算
  const hit = pushSegments(cmd).find((s) => bypassEnv || hasNoVerify(s));
  if (!hit) return null;
  const branches = new Set(Object.values(repos).map((r) => r.branch || 'master'));
  if (![...branches].some((b) => new RegExp(`(^|[\\s:/])${b}(\\s|$)`).test(hit))) return null;

  const cwd = input?.cwd || process.cwd();
  const dirs = repoDirs(cmd, cwd);
  const wanted = new Map(Object.entries(repos).map(([n, r]) => [real(resolve(r.path, '.git')), n]));
  const name = dirs.map(commonDir).map((c) => c && wanted.get(c)).find(Boolean);
  if (!name) return null;
  const br = repos[name].branch || 'master';

  appendLog(LOG, { at: new Date().toISOString(), repo: name, cwd, cmd: cmd.slice(0, 400) });
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: [
        `${name} 的 ${br} 只由推送佇列推（pushq，2026-10-20 使用者裁示），不准用 --no-verify／PUSHQ_* 繞過。`,
        '',
        '繞過的那一推會讓佇列正在驗證的那件被拒、重跑 10〜50 分鐘的測試——就是佇列要解決的撞車。',
        '',
        '改成：在 lane 裡 commit 好，然後',
        '',
        '    pushq enqueue',
        '',
        '它立刻返回，排進去就可以交接；佇列會合併最新的 ' + br + '、跑守衛與測試、推上去，失敗交給空白 session 修。',
        '進度：pushq status ' + name + '　規格：~/.claude/skills/handoff/push-queue-spec.md',
        '',
        `（使用者真的要繞過：\`touch ${tilde(join(HERE, 'pushq-guard.off'))}\`）`,
      ].join('\n'),
    },
  };
}

if (isMain(import.meta.url)) cli(run);
