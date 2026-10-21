#!/usr/bin/env node
/**
 * SessionStart ＋ UserPromptSubmit hook —— 專案 session 自動取名。
 *
 * ## 為什麼要有
 *
 * 2026-10-16 使用者：「每開一個新的 session，如果是專案用的就幫它命名，
 * 不要跟我說視窗編號或奇怪的數字，人類看不懂。」裁示的格式是
 * 「專案名｜第一句要做的事」，例如 `palrogue｜修背包圖示`。
 *
 * ## 怎麼做
 *
 *   - SessionStart（startup／clear）：cwd 在 `~/Projects/<名字>/` 底下 → 標題先掛 `<名字>`。
 *     resume／compact 不動，那個 session 早就有名字了。
 *   - UserPromptSubmit：這個 session 第一句「不是斜線指令」的話 → 補成 `<名字>｜<摘要>`。
 *     之後的每一句都不再改（狀態檔記 session_id）。
 *
 * 不在 ~/Projects 底下（家目錄、~/.claude/skills…）就不是專案 session，什麼都不做。
 * 標題欄位是 Claude Code 的 hookSpecificOutput.sessionTitle（2.1.301 起實測可用）。
 *
 * 逃生門：`touch ~/.claude/skills/home/claude/hooks/session-title.off`
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cli, isMain } from './lib/hook-cli.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PROJECTS = join(homedir(), 'Projects');
const STATE = join(tmpdir(), 'claude-session-title');
const MAX_SUMMARY = 18;

function projectOf(cwd) {
  if (!cwd) return null;
  const rel = relative(PROJECTS, cwd);
  if (!rel || rel.startsWith('..') || rel.startsWith(sep)) return null;
  return rel.split(sep)[0] || null;
}

// 第一行、去掉客套開頭與結尾標點，截到 MAX_SUMMARY 個字。
export function summarize(prompt) {
  let s = String(prompt || '')
    .replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, ' ') // 貼上的區塊、系統標籤
    .split('\n').map((l) => l.trim()).find(Boolean) || '';
  s = s.replace(/^((那|好|嗯|欸|ok|OK)[，,、\s]+|那(?=可以|幫|請|你|麻煩)|(請你|請|麻煩你|麻煩|你可以|可以|能不能|你幫我|幫我|幫忙)[，,、\s]*)+/, '')
       .replace(/(嗎|呢)?[。．.！!？?，,、~～\s]*$/, '')
       .trim();
  const chars = [...s];
  return chars.length > MAX_SUMMARY ? chars.slice(0, MAX_SUMMARY).join('') + '…' : s;
}

const emit = (event, title) => ({ hookSpecificOutput: { hookEventName: event, sessionTitle: title } });

export function run(input) {
  if (existsSync(join(HERE, 'session-title.off'))) return null;
  if (!input) return null;
  const event = input.hook_event_name;
  const project = projectOf(input.cwd);
  if (!project || !input.session_id) return null;
  const mark = join(STATE, input.session_id);

  if (event === 'SessionStart') {
    if (input.source !== 'startup' && input.source !== 'clear') return null;
    mkdirSync(STATE, { recursive: true });
    writeFileSync(mark, 'pending');
    return emit(event, project);
  }

  if (event === 'UserPromptSubmit') {
    // 沒有 pending 標記＝不是這支開場命名的（resume 進來的、或已經補過摘要）
    if (!existsSync(mark) || readFileSync(mark, 'utf8') !== 'pending') return null;
    const prompt = String(input.prompt || '').trim();
    if (!prompt || prompt.startsWith('/')) return null;
    const summary = summarize(prompt);
    if (!summary) return null; // 「你好」之類沒內容的，等下一句
    writeFileSync(mark, 'done');
    return emit(event, `${project}｜${summary}`);
  }
  return null;
}

if (isMain(import.meta.url)) cli(run);
