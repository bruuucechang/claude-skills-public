#!/usr/bin/env node
/**
 * 把「每台都該有」的 settings.json 欄位對齊進本機那一份（缺的補、值不同的改回來並印出舊值，已對就不動檔案）。
 *
 *     node ~/.claude/skills/home/claude/tools/settings-fields.mjs [--check]
 *
 * ## 為什麼需要
 *
 * mac 的 `~/.claude/settings.json` 是 symlink 進 repo 的，改 repo 就生效——**但只有 mac**。
 * 兩台 Windows 的 settings.json 是各自的實體檔（沒開 Developer Mode，
 * 檔案不能 symlink；見記憶 settings-hooks）。於是 2026-10-21 在 mac 加的
 * 「子代理預設 Sonnet」「關閉閒置壓縮」（5dfb4a2）在 Windows 上**一個都沒有**，
 * 而缺了的症狀是「什麼都沒發生」——子代理照樣跑，只是跑在貴的模型上。
 *
 * 這支只管下面 FIELDS 列的欄位，其他欄位（權限、各自的 hook 路徑）兩邊本來就不同，不碰。
 * FIELDS 的值以 repo 的 home/claude/settings.json 為準，tests/run.sh 會比對兩邊（手抄的表會安靜漂移）。
 * 要讓某台刻意不同，就把那個欄位從 FIELDS 拿掉，不要靠這支「缺才補」。
 * 由 `sync-rules.cmd` 每次跑。
 *
 * ## --check
 *
 * 只回報不修改。都對回 0，缺任何一項回 1。
 */

import { readFileSync, writeFileSync, copyFileSync, existsSync, renameSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

const CHECK = process.argv.includes("--check");
// 解開 symlink：mac 的 settings.json 是連進 repo 的，rename 蓋在連結上會把連結換成實體檔、從此脫離 repo
const given = process.env.SETTINGS_FIELDS_FILE || join(homedir(), ".claude", "settings.json");
const f = existsSync(given) ? realpathSync(given) : given;

// [路徑, 值, 為什麼]；路徑用 . 分層。加新欄位就加一行。
const FIELDS = [
  ["env.CLAUDE_CODE_SUBAGENT_MODEL", "sonnet", "子代理預設 Sonnet（沒寫 model 的 Agent 不再繼承 Opus）"],
  ["idleCompaction", false, "關閉閒置壓縮"],
];

const die = (m) => {
  console.log(m);
  process.exit(1);
};

if (!existsSync(f)) die(`  [!] 沒有 ${f}`);

// 記事本／PowerShell 5 存過的檔常帶 BOM，JSON.parse 會當成壞檔；肉眼又看不出來
const raw = readFileSync(f, "utf8");
const BOM = raw.startsWith("\uFEFF") ? "\uFEFF" : "";
const EOL = raw.includes("\r\n") ? "\r\n" : "\n";
let s;
try {
  s = JSON.parse(raw.slice(BOM.length));
} catch (e) {
  // 跟 mount-stop-hook 一樣不自己修：壞掉的 settings.json 讓 CLI 起不來，自動修最可能連旁邊的設定一起丟掉。
  die(`  [!] settings.json 不是合法 JSON（${e.message}）—— 先自己看一眼，不要讓工具亂猜`);
}

const get = (o, p) => p.split(".").reduce((x, k) => (x == null ? undefined : x[k]), o);
const set = (o, p, v) => {
  const ks = p.split(".");
  const last = ks.pop();
  for (const k of ks) {
    if (o[k] == null || typeof o[k] !== "object") o[k] = {};
    o = o[k];
  }
  o[last] = v;
};

const missing = FIELDS.filter(([p, v]) => get(s, p) !== v);
for (const [p, v, why] of FIELDS) {
  const ok = !missing.some(([q]) => q === p);
  const was = get(s, p) === undefined ? "" : `，原本是 ${JSON.stringify(get(s, p))}`;
  console.log(`  ${ok ? "OK " : CHECK ? "[!]" : "補上"} ${p}=${JSON.stringify(v)}（${why}${ok ? "" : was}）`);
}

if (!missing.length) process.exit(0);
if (CHECK) die(`  [!] 缺 ${missing.length} 項`);

copyFileSync(f, `${f}.bak-settings-fields`);
for (const [p, v] of missing) set(s, p, v);
const json = `${JSON.stringify(s, null, 2)}\n`;
JSON.parse(json); // 寫之前先自己驗一次
// 寫暫存檔再 rename：寫到一半被打斷時 settings.json 不會只剩半份（半份會讓 CLI 起不來）
writeFileSync(`${f}.tmp-settings-fields`, BOM + json.replace(/\n/g, EOL), "utf8");
renameSync(`${f}.tmp-settings-fields`, f);
console.log(`  已補 ${missing.length} 項。舊的備份在 ${f}.bak-settings-fields`);
