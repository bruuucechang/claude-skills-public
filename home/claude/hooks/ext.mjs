#!/usr/bin/env node
/**
 * ext.mjs <腳本路徑> [參數...] —— 掛別的 repo 的 hook 腳本：檔案在就在同一個程序裡載入它，不在就安靜結束。
 *
 *     node ~/.claude/skills/home/claude/hooks/ext.mjs "$HOME/Projects/session-remote/hooks/report.mjs" Stop
 *
 * ## 為什麼（2026-10-20，規格 optimize-spec.md H4）
 *
 * 以前 settings.json 寫 `f=…; [ -f "$f" ] && node "$f" || true`：多一層 shell，
 * 而且 report.mjs 的 tty 快取是用父程序 pid 當鍵，父程序每次都是新的 shell 就永遠不中。
 * 用 import 而不是再開一個 node：被載入的腳本看到的 process.ppid 就是 Claude（或 Claude 開的那層 sh）。
 *
 * ## 規則
 *
 * - 被載入的腳本看到的 argv 跟直接 `node <腳本> 參數...` 一樣。
 * - 檔案不存在（別台機器沒 clone 那個 repo）、載入失敗都 exit 0、不輸出：外部回報不能擋 Claude。
 */
import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const [script, ...rest] = process.argv.slice(2);
if (!script || !existsSync(script)) process.exit(0);
process.argv = [process.argv[0], script, ...rest];
try {
  await import(pathToFileURL(script).href);
} catch {
  process.exit(0);
}
