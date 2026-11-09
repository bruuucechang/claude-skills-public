#!/usr/bin/env node
/**
 * PreToolUse(AskUserQuestion) —— 選項的 preview 不准長到被藏起來。
 *
 * 2026-10-22 使用者原話：「回答選項給我preview我根本看不到 都寫XX lines hidden我要看啥」。
 * 對話框的 preview 框高度有限（四宮格的一格更矮），超出的部分只顯示「N lines hidden」，
 * 他沒辦法捲動去看。記憶檔寫過「約 15 行」，但那是大視窗量的；四宮格裡遠不到 15 行。
 * 問過後裁示：**限制在 8 行內**（折行也算），超過就擋（不是全面禁用 preview）。
 *
 * ## 怎麼算行數
 *
 * 一行的顯示寬度（中日韓全形字算 2）超過 WRAP 欄就算折成好幾行。WRAP 取 48：
 * preview 框跟選項清單左右並排，四宮格一格約 95〜120 欄寬，preview 只分到一半不到。
 *
 * 被擋時的出路（訊息裡也會說）：縮短；或不用 preview，把長內容寫在回覆裡、結束回合讓他直接回字
 * （對話框會蓋住同一則訊息前面的文字，見 ask-hides-prose.mjs）。
 *
 * 稽核：每次擋下寫一行 ask-preview-length.log。案例表：node test-ask-preview-length.mjs
 * 逃生門：touch ~/.claude/skills/home/claude/hooks/ask-preview-length.off
 */
import { existsSync } from 'node:fs';
import { appendLog } from './lib/log.mjs';
import { cli, isMain } from './lib/hook-cli.mjs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OFF = join(HERE, 'ask-preview-length.off');
const LOG = join(HERE, 'ask-preview-length.log');

export const MAX_LINES = 8;
export const WRAP = 48;

/** 全形字（中日韓、全形標點、注音、韓文）佔 2 欄。 */
const WIDE = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/u;
const width = (line) => [...line].reduce((n, ch) => n + (WIDE.test(ch) ? 2 : 1), 0);

/** 畫面上會佔幾行（含折行）。 */
export function visualLines(text) {
  const t = String(text || '').replace(/\s+$/, '');
  if (!t) return 0;
  return t.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(width(line.replace(/\t/g, '    ')) / WRAP)), 0);
}

export function run(input) {
  if (existsSync(OFF)) return null;
  const qs = input?.tool_input?.questions ?? [];
  if (!Array.isArray(qs)) return null;

  const long = [];
  for (const q of qs) {
    for (const o of Array.isArray(q?.options) ? q.options : []) {
      const n = visualLines(o?.preview);
      if (n > MAX_LINES) long.push(`「${String(o?.label ?? '').slice(0, 20)}」${n} 行`);
    }
  }
  if (!long.length) return null;
  appendLog(LOG, { at: new Date().toISOString(), sid: String(input?.session_id ?? '').slice(0, 8), long });

  const reason =
    `選項的 preview 超過 ${MAX_LINES} 行（折行也算，一行 ${WRAP} 欄、中文字算 2 欄）：${long.join('、')}。` +
    '超出的部分在使用者畫面上只會顯示「N lines hidden」，他看不到（2026-10-22 使用者裁示限制在 8 行內）。\n' +
    `· 能縮就縮到 ${MAX_LINES} 行內（只留要比較的差異）。\n` +
    '· 縮不了 → 不要用 preview：把完整內容用散文寫在回覆裡、結束回合讓他直接回字（對話框會蓋住同一則訊息前面的文字，不能先寫再跳框）。';
  return {
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  };
}

if (isMain(import.meta.url)) cli(run);
