/**
 * config.mjs —— 個人設定（帳號、git 身分、語言）集中從 home/claude/config.json 讀。
 *
 * 為什麼（2026-10-21，規格 public-generic-spec.md）：公開版要讓別人裝了就能用，
 * hooks 不能寫死作者的帳號。私人 repo 的 config.json 放我的值（不匯出），
 * 公開版由 install.sh 依 config.example.json 產生。
 *
 * 找不到檔或欄位就用 DEFAULTS：全部是「不動作」——沒設 git_emails 就不擋 commit、
 * 沒設 github_owner 就不認任何 repo 是自己的、language 不是 zh-TW 就不擋英文。
 * 測試或臨時換一份：CLAUDE_SKILLS_CONFIG=<路徑>。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const CONFIG_PATH = join(HERE, '..', '..', 'config.json');

export const DEFAULTS = { github_owner: '', git_name: '', git_emails: [], language: null, pr_guard: true };

let cached;
export function config() {
  if (cached) return cached;
  let raw = {}, error = null;
  const f = process.env.CLAUDE_SKILLS_CONFIG || CONFIG_PATH;
  // 檔在、卻讀不懂（合併衝突標記、手改壞了）不能安靜退回預設：那等於所有保護一起關掉。
  // error 由 dispatch.mjs 在 SessionStart 用 systemMessage 講出來。
  if (existsSync(f)) {
    try { raw = JSON.parse(readFileSync(f, 'utf8')); } catch (e) { error = `${f}：${e.message}`; }
  }
  cached = { ...DEFAULTS, ...raw, error };
  if (!Array.isArray(cached.git_emails)) cached.git_emails = [];
  return cached;
}
