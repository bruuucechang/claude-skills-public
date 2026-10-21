#!/usr/bin/env node
/**
 * 把 ask-with-options 這個 Stop hook 掛進本機的 settings.json（沒掛才掛）。
 *
 *     node ~/.claude/skills/home/claude/tools/mount-stop-hook.mjs [--check]
 *
 * ## 為什麼需要一支獨立的工具
 *
 * `settings.json` **刻意不進版控**——四台機器各一份，內容本來就不同（權限清單、
 * 音效、各自的路徑）。於是同步規則的 `sync-rules.cmd` 把規則檔帶過去了，
 * 而**擋那條規則的機制沒有跟著過去**。
 *
 * 2026-09-10 實測到的狀態：BRUCEVICTUS 與 desk 的規則檔跟 Air 逐位元相同
 * （blob `220abdcd580a`），`ask-with-options.mjs` 也在（junction 進來的），
 * 但兩台的 `settings.json` 都沒有掛它。也就是說「問句一律給選項」這條規則
 * 在那兩台上**只是文字**，而使用者自己寫的第 2 條原則是
 * 「規則是請求，機制才是保證」。
 *
 * 這種漂移不會有人發現：hook 沒掛的症狀是「什麼都沒發生」，
 * 跟「hook 掛了而這個回合沒違規」長得一模一樣。**沉默不等於成功。**
 *
 * ## --check
 *
 * 只回報不修改，給 `sync-rules.cmd` 與 `rules-audit.sh` 用。
 * 掛著回 0，沒掛回 1。
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";

const CHECK = process.argv.includes("--check");
const MARK = "ask-with-options";
const HOME = homedir();
const f = join(HOME, ".claude", "settings.json");
const SRC = join(HOME, ".claude", "skills", "home", "claude");

// Windows 上照既有的慣例走 `cmd /c`（settings.json 裡別的 hook 都是那樣，
// 而且 %USERPROFILE% 要靠 cmd 展開）；mac 直接 node 加 $HOME。
const CMD =
  process.platform === "win32"
    ? 'cmd /c node "%USERPROFILE%\\.claude\\skills\\home\\claude\\hooks\\ask-with-options.mjs"'
    : 'node "$HOME/.claude/skills/home/claude/hooks/ask-with-options.mjs"';

const die = (m) => {
  console.log(m);
  process.exit(1);
};

if (!existsSync(f)) die(`沒有 ${f}`);

let s;
try {
  s = JSON.parse(readFileSync(f, "utf8"));
} catch (e) {
  // 這裡**不要**自己修。settings.json 壞掉時整個 CLI 起不來，
  // 而一支自動修 JSON 的工具最可能做的就是把壞掉的地方連同旁邊的設定一起丟掉。
  die(`settings.json 不是合法 JSON（${e.message}）—— 先自己看一眼，不要讓工具亂猜`);
}

/**
 * Codex 那一半：`~/.codex/hooks.json`。
 *
 * Codex 0.152 的 hooks 跟 Claude Code 是同一套（同名事件、同樣的結構、
 * payload 欄位名一字不差），所以共用同一支 ask-with-options.mjs。
 * 細節與踩過的坑在 hooks/codex-hooks.md。
 *
 * **Codex 解析失敗只會印一行 warning 然後照常跑**，所以「沒有錯誤」不等於
 * 「掛上了」——這裡照樣要比對內容，不能只看檔案在不在。
 */
function codex() {
  const dir = join(HOME, ".codex");
  if (!existsSync(dir)) return "這台沒有 ~/.codex —— 沒裝 Codex，跳過";
  const dst = join(dir, "hooks.json");
  const src = join(SRC, "hooks", "codex-hooks.json");
  if (!existsSync(src)) return "[!] 找不到 " + src;

  const want = readFileSync(src, "utf8");
  if (existsSync(dst) && readFileSync(dst, "utf8") === want) return "Codex hooks.json 已是最新";
  if (CHECK) return "[!] ~/.codex/hooks.json 不是最新的 —— Codex 那邊沒有機制在擋";
  writeFileSync(dst, want, "utf8");
  return "Codex hooks.json 已更新";
}

/**
 * 掛上了 ≠ 會動。
 *
 * 2026-09-10 實測到最壞的那種壞法：`ask-with-options.mjs` 的執行守衛寫成
 * `import.meta.url === \`file://\${process.argv[1]}\``，在 Windows 上永遠不成立
 * （argv[1] 是 `C:\\...\\x.mjs`，import.meta.url 是 `file:///C:/.../x.mjs`），
 * 於是 main() 從來不被呼叫。**沒有輸出、連它自己的 log 都不寫**，
 * 跟「這回合沒有違規」完全一樣。settings.json 裡它好端端掛著。
 *
 * 所以每次都真的餵它一個該被擋的回合，看它擋不擋。
 */
function smoke() {
  const hook = join(SRC, "hooks", "ask-with-options.mjs");
  if (!existsSync(hook)) return "[!] 找不到 " + hook;
  const t = join(tmpdir(), "mount-stop-hook-smoke.jsonl");
  writeFileSync(t, '{"type":"user","message":{"content":"go"}}\n', "utf8");
  const payload = JSON.stringify({
    session_id: "smoke", transcript_path: t,
    last_assistant_message: "兩條路各有代價。你想走哪一條？",
  });
  const r = spawnSync(process.execPath, [hook], { input: payload, encoding: "utf8", timeout: 15000 });
  const out = (r.stdout || "") + (r.stderr || "");
  if (!out.includes("Stop")) {
    return "[!] hook 掛著但**不會擋** —— 餵它一個散文問句結尾，它什麼都沒回。"
      + (r.error ? ` (${r.error.message})` : "");
  }
  return "煙霧測試通過：散文問句結尾會被擋";
}

// mac 從 2026-10-20 起 Stop 改掛 hooks/dispatch.mjs（裡面呼叫 ask-with-options），也算掛著
const stopHooks = JSON.stringify(s.hooks?.Stop ?? []);
const mounted = stopHooks.includes(MARK) || /dispatch\.mjs\\?"? Stop/.test(stopHooks);
const cx = codex();
console.log("  " + cx);
const sm = smoke();
console.log("  " + sm);
if (sm.startsWith("[!]")) process.exit(1);

if (mounted) {
  console.log("  Stop hook 已掛著");
  process.exit(cx.startsWith("[!]") ? 1 : 0);
}

if (CHECK) die("  [!] settings.json 沒有掛 ask-with-options —— 「問句一律給選項」在這台只是文字，沒有機制在擋");

copyFileSync(f, `${f}.bak-mount-stop-hook`);
s.hooks ??= {};
s.hooks.Stop ??= [];
s.hooks.Stop.push({ hooks: [{ type: "command", command: CMD }] });

const out = `${JSON.stringify(s, null, 2)}\n`;
JSON.parse(out); // 寫壞的 settings.json 會讓整個 CLI 起不來，寫之前先自己驗一次
writeFileSync(f, out, "utf8");
console.log(`已掛上（Stop 現在有 ${s.hooks.Stop.length} 組）。舊的備份在 ${f}.bak-mount-stop-hook`);
