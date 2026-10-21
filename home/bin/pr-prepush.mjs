#!/usr/bin/env node
// pr-prepush.mjs — 全域 pre-push：agent 不准把程式碼直推自己 repo 的目標分支，要走 PR（2026-10-21）。
// 副檔名一定是 .mjs：沒有的話要靠 Node 22.12 以上自動判斷成模組，判斷不出來會在 try 外面 exit 1、整台推不出去。
//
// 裝法：照 bootstrap.sh 的 hook.pr-guard.* 那幾行（**不要直接指這支檔**：指令寫成「找不到檔或沒有 node 就放行」，
// 不然檔搬走或 GUI 程式的 PATH 沒有 node 時，這台每個 repo 都推不出去）。
// git 2.55 實測：設定檔掛的 hook 跟 repo 自己的 .git/hooks／core.hooksPath 的 pre-push 一起跑，互不取代。
//
// 為什麼不在 PreToolUse 解析指令：PR #1、#2 的審查各實測出五到九種寫法（絕對路徑的 git、子殼層的 cd、
// --all、2>&1 被當 refspec……）能讓正則猜錯要推什麼。pre-push 由 git 給出確切的 ref 與 sha，沒有猜的空間。
// 唯一跳過 pre-push 的是 --no-verify，那個交給 PreToolUse 的 pr-guard.mjs 擋。
//
// 判準：推的人是 agent（CLAUDECODE=1 或 CODEX_THREAD_ID）、origin owner 是 config.json 的 github_owner、
// 遠端分支已存在且不是 pr/、autoloop/ 開頭、推的範圍裡有非 .md 的檔或 agent 規則檔（ship-classify 判 code）→ exit 1。
// 使用者自己在終端機推、pushq（PUSHQ_PUSHER）、新分支、刪分支都放行。判斷不了就放行（壞掉不能擋死推送）。
// 逃生門：touch ~/.claude/skills/home/claude/hooks/pr-guard.off
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const OFF = join(HERE, "..", "claude", "hooks", "pr-guard.off");
const CLASSIFY = process.env.PR_GUARD_CLASSIFY || join(HERE, "ship-classify");
const ZERO = /^0+$/;

async function main() {
  if (existsSync(OFF)) return 0;
  const env = process.env;
  // agent 才擋。CLAUDECODE 會被從 Bash 工具冷啟的 Terminal.app 繼承，~/.zshrc 不清它、但會清 CLAUDE_CODE_SESSION_ID，
  // 所以兩個都要有才算 Claude（使用者在那種 Terminal 手動推不擋）。Codex 的子程序帶 CODEX_THREAD_ID（2026-10-21 實測）。
  const agent = (env.CLAUDECODE === "1" && env.CLAUDE_CODE_SESSION_ID) || env.CODEX_THREAD_ID;
  if (env.PUSHQ_PUSHER || !agent) return 0;
  // import 放在 try 裡面：lib 搬走或壞掉也只是放行，不能讓這台每一個 repo 都推不出去
  const { git: g, isMine, isExempt } = await import("../claude/hooks/lib/shell-git.mjs");
  const [remote, url] = process.argv.slice(2);
  if (!isMine(url) || isExempt(url)) return 0;
  const git = (args) => g(".", args, 60000);

  const top = git(["rev-parse", "--show-toplevel"]);
  const bad = [];
  for (const line of readFileSync(0, "utf8").split("\n").filter(Boolean)) {
    const [, localSha, remoteRef, remoteSha] = line.split(" ");
    const dst = (remoteRef || "").replace(/^refs\/heads\//, "");
    if (!dst || dst === remoteRef || dst.startsWith("pr/")) continue;   // 非分支（tag）、pr/ 分支放行
    // autoloop/ 分支是產線自動合併的結果（自己的關卡＋盲評／審查就是它的審核），驅動器從 Claude session 開、
    // 帶著 CLAUDECODE，不放行的話每次合併 push 都被擋、DB 卻記成已合（2026-10-21 bodyforge 第 26 輪）
    if (dst.startsWith("autoloop/")) continue;
    if (ZERO.test(localSha) || ZERO.test(remoteSha)) continue;          // 刪分支、遠端還沒有的新分支
    // 比的是「樹」不是逐筆 log：merge commit 解衝突時改的程式碼 `log --name-only` 列不出來（PR #2 審查）。
    // 遠端那個 sha 本機沒有（落後）就退回「不在任何 origin ref 上的 commit」逐筆列，merge 用 -m 攤開。
    let files;
    try {
      git(["cat-file", "-e", `${remoteSha}^{commit}`]);
      files = git(["-c", "core.quotepath=off", "diff", "--no-renames", "--name-only", `${remoteSha}...${localSha}`]);
    } catch {
      files = git(["-c", "core.quotepath=off", "log", "-m", "--no-renames", "--name-only", "--format=", localSha, "--not", `--remotes=${remote}`]);
    }
    files = [...new Set(files.split("\n").filter(Boolean))];
    if (!files.length) continue;
    // 非 .md 一定是程式碼，不必叫 ship-classify；.md 才要看是不是規則檔（分批，避免參數過長）
    let code = files.some((f) => !f.endsWith(".md"));
    for (let i = 0; !code && i < files.length; i += 500)
      code = execFileSync(CLASSIFY, files.slice(i, i + 500), { cwd: top, encoding: "utf8", timeout: 30000 }).trim() === "code";
    if (code) bad.push(dst);
  }
  if (!bad.length) return 0;
  process.stderr.write([
    `推被擋下來了：這一推會把程式碼直接推進 ${bad.join("、")}。`,
    "2026-10-20 起自己的 repo 程式碼要走 PR、審查過才合併（ship skill 第 0 節 5b）。",
    "那些 commit 不是你的（別的 session 或 Codex 留的）就不要替它推：你的改動照 5b 搬進 worktree、推 pr/ 分支、開 PR。",
    "（使用者真的要直推：touch ~/.claude/skills/home/claude/hooks/pr-guard.off）",
    "",
  ].join("\n"));
  return 1;
}

let code = 0;
try { code = await main(); } catch { code = 0; }
process.exit(code);
