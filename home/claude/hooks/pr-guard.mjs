#!/usr/bin/env node
/**
 * PreToolUse(Bash) hook —— 自己 repo 的 git push，確保擋直推的全域 pre-push 真的會跑。
 *
 * ## 為什麼不在這裡判斷要推什麼
 *
 * 「程式碼不准直推目標分支、要走 PR」（2026-10-20 使用者裁示，規格 ~/.claude/skills/ship/pr-flow-spec.md）
 * 真正的擋法在全域 pre-push：`home/bin/pr-prepush.mjs`，git 給確切的 ref 與 sha。
 * 第一版在這裡用正則解析 push 指令，PR #1、#2 的審查各實測出五到九種繞法（絕對路徑的 git、子殼層的 cd、
 * --all、2>&1 被當 refspec……），補不完。這支只管「pre-push 會不會跑」——沒跑就是安靜地失效。
 *
 * ## 判準（任一成立就擋）
 *
 * 指令裡有 git push 的段，cwd（或 cd／pushd／-C）有一個是 owner bruuucechang 的 repo，而且：
 *   · 那段帶 --no-verify，但推的不是 pr/ 分支（refspec 寫明 pr/，或在 pr/ 分支上推 HEAD）。
 *     animyria 推 PR 分支照 ship 5b 帶 --no-verify，pre-push 的長測試由 pushq 在合併前跑。
 *   · 那段實際執行的 git 不到 2.55（`/usr/bin/git`、`xcrun git` 是 Apple 的 2.50，不跑設定檔掛的 hook；2026-10-21 實測）。
 *   · mac 上全域 `hook.pr-guard.command` 沒設（還沒跑 bootstrap）。Windows 不在這次範圍。
 * pushq 登記的 repo 推 master 另有 pushq-guard。

 * ## 威脅模型：防手滑，不防故意
 *
 * 跟 settings.json 擋 force push 的 deny 一樣，這套只防「合作的 agent 不小心直推」。agent 故意繞
 * （偽造 PUSHQ_PUSHER／清掉 CLAUDECODE、`-c hook.*` 蓋掉設定、縮寫成 --no-verif、同一行夾一個 pr/）
 * 不在範圍內——那要靠 GitHub 的 branch protection，而自己的 PR 不能 approve 自己（規格「明確不做」）。
 *
 * ## 逃生門
 *
 *     touch ~/.claude/skills/home/claude/hooks/pr-guard.off
 */

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendLog } from './lib/log.mjs';
import { cli, isMain } from './lib/hook-cli.mjs';
import { git, hasNoVerify, isMine, pushSegments, repoDirs } from './lib/shell-git.mjs';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const OFF = join(HERE, 'pr-guard.off');
const LOG = join(HERE, 'pr-guard.log');
const mine = (dir) => { try { return isMine(git(dir, ['remote', 'get-url', 'origin'], 2000)); } catch { return false; } };

/** 設定檔掛的 hook 實測 2.55 會跑、Apple 的 2.50 不跑（2026-10-21）。沒量過的中間版本一律當不支援。 */
const MIN = [2, 55];
export function hookCapable(bin) {
  try {
    const argv = bin === 'xcrun git' ? ['xcrun', ['git', '--version']] : [bin, ['--version']];
    const v = execFileSync(argv[0], argv[1], { encoding: 'utf8', timeout: 2000 }).match(/(\d+)\.(\d+)/);
    return !!v && (+v[1] > MIN[0] || (+v[1] === MIN[0] && +v[2] >= MIN[1]));
  } catch { return false; }
}

/** 這段推的是不是 pr/ 分支：refspec 裡寫明 pr/，或沒寫目的（HEAD／不寫）而那個目錄目前在 pr/ 分支上。 */
function toPr(seg, dirs) {
  if (/(?:^|[\s:])(?:refs\/heads\/)?pr\//.test(seg)) return true;
  const words = (seg.match(/\spush\b(.*)$/)?.[1] ?? '').trim().split(/\s+/).filter((w) => w && !w.startsWith('-'));
  if (words.length > 2 || (words[1] && words[1] !== 'HEAD')) return false;
  return dirs.some((d) => { try { return git(d, ['branch', '--show-current'], 2000).startsWith('pr/'); } catch { return false; } });
}

/** 回 null＝放行。 */
export function run(input) {
  if (existsSync(OFF)) return null;
  const cmd = input?.tool_input?.command ?? '';
  if (typeof cmd !== 'string' || !/\bpush\b/.test(cmd)) return null;
  // 引號字串與 heredoc 本體裡提到 git push 不算數；cd 的目錄照原字串找（寧可多列）
  const pushSegs = pushSegments(cmd);
  if (!pushSegs.length) return null;
  const cwd = input?.cwd || process.cwd();
  const dirs = repoDirs(cmd, cwd).filter(mine);
  if (!dirs.length) return null;

  const why = [];
  for (const seg of pushSegs) {
    if (hasNoVerify(seg) && !toPr(seg, dirs)) why.push('--no-verify 會跳過 pre-push。推 pr/ 分支可以帶，但 refspec 要寫出 `pr/…`（hook 看不到 "$B" 這種變數），或在 pr/ 分支上推 HEAD。');
    // 這段第一個出現的 git 才是執行的那支（`git -C ~/foo/git push` 的 bin 是 git，不是 ~/foo/git）
    const bin = seg.match(/(?:^|[\s(`$])(xcrun\s+git|\S*\/git|git)(?=\s)/)?.[1] ?? 'git';
    if (!hookCapable(bin)) why.push(`這段用的 ${bin} 不到 git ${MIN.join('.')}，不跑設定檔掛的 pre-push（/usr/bin/git 是 Apple 的 2.50）。用 PATH 上的 Homebrew git。`);
  }
  if (process.platform === 'darwin') {
    try { git(cwd, ['config', '--global', '--get', 'hook.pr-guard.command'], 2000); }
    catch { why.push('這台還沒裝全域 pre-push（hook.pr-guard.*），直推程式碼不會被擋。先跑 ~/.claude/skills/bootstrap.sh 或照它第 77–81 行設好。'); }
  }
  if (!why.length) return null;

  appendLog(LOG, { at: new Date().toISOString(), cwd, cmd: cmd.slice(0, 400) });
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: [
        '自己的 repo 推之前，擋直推的全域 pre-push `pr-prepush.mjs` 必須會跑（2026-10-20 起程式碼走 PR，ship skill 第 0 節 5b）：',
        ...[...new Set(why)].map((w) => '  · ' + w),
        '',
        '（使用者真的要繞過：`touch ~/.claude/skills/home/claude/hooks/pr-guard.off`）',
      ].join('\n'),
    },
  };
}

if (isMain(import.meta.url)) cli(run);
