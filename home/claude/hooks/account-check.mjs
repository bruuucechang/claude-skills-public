#!/usr/bin/env node
// account-check.mjs — SessionStart：這個設定目錄能不能用（有沒有登入、token 有沒有被清空）。
// 只警告、不擋。2026-10-10 起**登的是誰不檢查**——登入哪個帳號就算哪個帳號（使用者裁示）。
//
// 只在 macOS 跑；清單上找不到這個設定目錄就安靜結束。任何錯誤都吞掉。
//
// 快取（2026-10-20）：dirState 要問 Keychain，量過 745ms，是 SessionStart 等待時間的大頭。
// **查過沒問題**才記一筆，OK_TTL 內同一個目錄不再查；有問題時不記，所以每次開場都會再查、再警告。
// 代價：token 在這一小時內被清空，最晚要一小時後的新 session 才會講。
// 快取在 ~/.claude/cache/account-check.json（{ <設定目錄>: 查過沒問題的時間 }），刪掉就會重查。
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { cli, isMain } from "./lib/hook-cli.mjs";

const OK_TTL = 60 * 60 * 1000;
const CACHE_DIR = process.env.ACCOUNT_CHECK_CACHE_DIR || join(homedir(), ".claude", "cache");
const CACHE = join(CACHE_DIR, "account-check.json");

const readCache = () => { try { return JSON.parse(readFileSync(CACHE, "utf8")); } catch { return {}; } };

function markOk(dir, now) {
  try {
    const c = readCache();
    c[dir] = now;
    mkdirSync(CACHE_DIR, { recursive: true });
    writeFileSync(`${CACHE}.${process.pid}.tmp`, JSON.stringify(c));
    renameSync(`${CACHE}.${process.pid}.tmp`, CACHE);
  } catch {}
}

export async function run(_input, { now = Date.now() } = {}) {
  if (process.platform !== "darwin") return null;
  const raw = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const key = resolve(raw.replace(/^~(?=$|\/)/, homedir()));
  const at = readCache()[key];
  if (typeof at === "number" && now - at >= 0 && now - at < OK_TTL) return null;

  const A = await import("../tools/accounts.mjs");
  const accounts = A.load().accounts;
  const dir = process.env.CLAUDE_CONFIG_DIR || A.DEFAULT_DIR;
  if (!A.configDirs(accounts).some((x) => x.dir === A.expand(dir))) return null;
  // 2026-10-10 起登的是誰都不算錯（「登入哪個帳號就回報哪個帳號」），只在這個目錄不能用時警告
  const st = A.dirState(dir, accounts);
  if (!st.problems.length) { markOk(key, now); return null; }
  const home = A.current(accounts);
  const msg = `⚠ 這個 session 的設定目錄 ${home?.config_dir || dir} 不能用：\n` +
    st.problems.map((p) => "  - " + p).join("\n") +
    `\n修法：在終端機跑 acct login <要登的帳號>${home ? `（平常是 ${home.id}）` : ""}，或面板的「安全登入」。`;
  return {
    systemMessage: msg,
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext: msg + "\n（開場檢查 hooks/account-check.mjs 產生。第一次回覆時先把這件事告訴使用者。）",
    },
  };
}

if (isMain(import.meta.url)) cli(run);
