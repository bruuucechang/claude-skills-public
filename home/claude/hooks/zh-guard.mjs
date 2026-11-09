#!/usr/bin/env node
/**
 * Stop ＋ PreToolUse(AskUserQuestion) —— 回覆與選項裡有簡體字或打錯的冷僻字就擋下來重寫。
 *
 * ## 為什麼
 *
 * 「一律繁體字」寫在 AGENTS.md 與記憶檔一個多月，2026-10-22 使用者又說：
 * 「你的回答過程有時候還是會出現簡體字 或是一些根本不正確的字」。當天重播兩帳號近 14 天的紀錄：
 * 選項框 1535 次裡有 42 次帶簡體字（删除、画面、我先拟、档案、环境、暂停），回合收尾 5 則（现况、挡下来）；
 * 另外有一批不是簡體、是根本打錯的冷僻字：闃出（跳出）、闃電（閃電）、一趥（一趟）、金屬鐤（錠）、
 * 撠到（撞到）、擐得住（擋得住）、綳在一起（綁）、髃甲（鎧甲）、擈回來（救回來）、攞截（攔截）。
 * lang-guard 只抓整則變英文，抓不到這些。規則是請求，機制才是保證。
 *
 * ## 判準（字表都在這個資料夾，產法見 build-zh-tables.py）
 *
 * 先用 lang-guard 的 `prose()` 拿掉程式碼、行內 code、網址、路徑——資料夾名、檔名、要引用的字本身可以照原樣寫在 `code` 裡。
 * 再跳過前後 KANA_WINDOW 字內有假名的字（日文的「中条あやみ」「白糸の滝」）。剩下的每個中文字：
 *
 * - 在 zh-simplified.txt（簡體專用字）→ **擋**。
 * - 詞在 zh-merged.txt（共斗、之后：字是繁體、詞是簡體）→ **擋**。
 * - 不在 zh-common.txt（Big5 常用字 5401）、也不在 zh-allow.txt（使用者打過的字、確認過的專有名詞）
 *   → **冷僻字，擋一次**：多半是打錯，但也可能是地名、生物名。同一個 session 同一個字只擋一次
 *   （記在 zh-guard.seen.json），確定沒錯就原樣再送、或回一句已核對。常用到的就加進 zh-allow.txt。
 *
 * - 錯字在 zh-lookalike.txt（劑：字碼跟劍只差 4）、前後緊接劍專屬的字（劑士、劑術、長劑）→ **擋**。
 *
 * ## 不擋的情況（跟 lang-guard 同一套）
 *
 * - Stop：`stop_hook_active`（這個回合已經被擋過一次）、`stop_reason` 不是 `end_turn`、
 *   非互動（`CLAUDE_CODE_ENTRYPOINT` 是 `sdk-*`）、Claude Code 自己的系統訊息。
 * - config 的 `language` 不是 `zh-TW`。
 *
 * 重播：node replay-p3.mjs zh [天數=14]　測試：node test-zh-guard.mjs
 * 逃生門：touch ~/.claude/skills/home/claude/hooks/zh-guard.off
 * 稽核：只記擋下的那幾次，寫在 zh-guard.log。
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { appendLog } from './lib/log.mjs';
import { cli, isMain } from './lib/hook-cli.mjs';
import { config } from './lib/config.mjs';
import { prose, SYSTEM } from './lang-guard.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OFF = join(HERE, 'zh-guard.off');
const LOG = join(HERE, 'zh-guard.log');
const SEEN = process.env.ZH_GUARD_SEEN || join(HERE, 'zh-guard.seen.json');   // 測試換一份
const SEEN_DAYS = 3;

/** 字表檔：# 開頭的行是註解，其餘每個中文字都算。 */
function table(name) {
  const t = readFileSync(join(HERE, name), 'utf8');
  return new Set([...t.split('\n').filter((l) => !l.startsWith('#')).join('')].filter((c) => HAN.test(c)));
}

const HAN = /[㐀-䶿一-鿿]/;
// 帶中文的路徑（~/Desktop/漫画人/a.jpg）：prose() 的路徑只吃到 ASCII，資料夾名裡的字會留下來。
// 吃到中文標點或空白為止，所以頂多連帶吃掉路徑前面黏著的幾個字（少抓，不會誤擋）。
const PATHISH = /[^\s，。、；：「」『』（）！？【】]*[\\/][^\s，。、；：「」『』（）！？【】]*[\\/][^\s，。、；：「」『』（）！？【】]*/g;
const KANA = /[぀-ヿ]/;
export const KANA_WINDOW = 6;

let tables;
const load = () => (tables ??= {
  simplified: table('zh-simplified.txt'),
  common: table('zh-common.txt'),
  allow: table('zh-allow.txt'),
  merged: readFileSync(join(HERE, 'zh-merged.txt'), 'utf8').split('\n')
    .filter((l) => l.trim() && !l.startsWith('#')).map((l) => l.trim().split(/\s+/)),
  lookalike: readFileSync(join(HERE, 'zh-lookalike.txt'), 'utf8').split('\n')
    .filter((l) => l.trim() && !l.startsWith('#')).map((l) => l.trim().split(/\s+/))
    .map(([bad, good, pre = '', post = '']) => ({ bad, good, pre, post })),
});

/** { simplified: [{ ch, ctx }], rare: [{ ch, ctx }] }，每個字只列一次。 */
export function findings(text) {
  const { simplified, common, allow, merged, lookalike } = load();
  const flat = prose(String(text ?? '').replace(PATHISH, ' '));
  const p = [...flat];
  const out = { simplified: [], rare: [], typo: [] };
  // 字碼相近的錯字（劑→劍）：錯字本身是常用字，只看前後有沒有接到對字專屬的字（zh-lookalike.txt）
  for (const { bad, good, pre, post } of lookalike) {
    const ctxs = [];
    for (let i = flat.indexOf(bad); i >= 0; i = flat.indexOf(bad, i + 1)) {
      if (!pre.includes(flat[i - 1] ?? '\0') && !post.includes(flat[i + 1] ?? '\0')) continue;
      ctxs.push(flat.slice(Math.max(0, i - 6), i + 5).replace(/\s+/g, ' ').trim());
    }
    // 全部位置一起列：Stop 只擋一輪，漏列的那幾處下一輪就不會再被檢查
    if (ctxs.length) out.typo.push({ ch: bad, ctx: `多半是「${good}」打錯：${ctxs.slice(0, 4).join('／')}` });
  }
  // 合併字（共斗、之后）：字本身是繁體，只有在詞裡才錯，所以照詞比對（zh-merged.txt）
  for (const [bad, good] of merged) {
    const i = flat.indexOf(bad);
    if (i >= 0) out.simplified.push({ ch: bad, ctx: `應為「${good}」：${flat.slice(Math.max(0, i - 6), i + bad.length + 4).replace(/\s+/g, ' ').trim()}` });
  }
  const seen = new Set();
  p.forEach((ch, i) => {
    if (!HAN.test(ch) || seen.has(ch)) return;
    const kind = simplified.has(ch) ? 'simplified' : common.has(ch) || allow.has(ch) ? null : 'rare';
    if (!kind) return;
    if (p.slice(Math.max(0, i - KANA_WINDOW), i + KANA_WINDOW + 1).some((c) => KANA.test(c))) return;
    seen.add(ch);
    out[kind].push({ ch, ctx: p.slice(Math.max(0, i - 6), i + 5).join('').replace(/\s+/g, ' ').trim() });
  });
  return out;
}

/** 選項框裡使用者看得到的每一段字。 */
export function askText(toolInput) {
  const qs = Array.isArray(toolInput?.questions) ? toolInput.questions : [];
  return qs.flatMap((q) => [q?.question, q?.header,
    ...(Array.isArray(q?.options) ? q.options : []).flatMap((o) => [o?.label, o?.description, o?.preview])])
    .filter((s) => typeof s === 'string').join('\n');
}

function readSeen(now) {
  try {
    const all = JSON.parse(readFileSync(SEEN, 'utf8'));
    return Object.fromEntries(Object.entries(all).filter(([, v]) => now - Date.parse(v.at) < SEEN_DAYS * 86_400_000));
  } catch { return {}; }
}

/** 這個 session 還沒擋過的冷僻字；擋了就記下來（HOOK_NOLOG 時不寫，重播用；測試給了 ZH_GUARD_SEEN 照寫）。 */
function unseenRare(sid, rare, now = Date.now()) {
  // 記不住（沒有 session id、寫不進去）就不擋冷僻字：不然同一個字會每次都擋（2026-10-22 審查）
  if (!rare.length || !sid) return [];
  const all = readSeen(now);
  const had = new Set(all[sid]?.chars ?? '');
  const fresh = rare.filter((r) => !had.has(r.ch));
  if (fresh.length && (!process.env.HOOK_NOLOG || process.env.ZH_GUARD_SEEN)) {
    all[sid] = { at: new Date(now).toISOString(), chars: [...had].join('') + fresh.map((r) => r.ch).join('') };
    // 先寫暫存再改名：直接寫會先清空檔案，並行的 session 剛好讀到空檔就會蓋掉所有人的紀錄
    const tmp = `${SEEN}.${process.pid}.tmp`;
    try { writeFileSync(tmp, JSON.stringify(all)); renameSync(tmp, SEEN); } catch { return []; }
  }
  return fresh;
}

const list = (xs) => xs.map(({ ch, ctx }) => `「${ch}」（${ctx}）`).join('、');

export function reason({ simplified, rare, typo = [] }, where) {
  const parts = ['【自動檢查】'];
  if (typo.length) parts.push(`${where}有字碼相近的錯字（手寫 \\uXXXX 打錯，中文請直接打字）：${list(typo)}。`);
  if (simplified.length) parts.push(`${where}有簡體字：${list(simplified)}。`);
  if (rare.length) parts.push(`${where}有台灣不常用的字，多半是打錯（以前出過：闃→跳／閃、趥→趟、鐤→錠、擐→擋、撠→撞）：${list(rare)}。`);
  if (where === '選項') {
    parts.push(simplified.length || typo.length ? '改成繁體、打錯的改對，再送一次（真的是正當用法就把詞補進 zh-lookalike.txt）。' : '打錯就改對再送；確定沒錯（地名、生物名、日文）就原樣再送一次，這個 session 不會再擋這幾個字。');
  } else {
    parts.push('把有錯的那幾句改對重寫一次（只重寫那幾句，不要加新的問句；同時被要求整則用繁體重寫的話就整則重寫）。');
    if (rare.length) parts.push(simplified.length ? '冷僻字確定沒錯的照留。' : '都確定沒錯（地名、生物名、日文）就只回一句「已核對，字沒錯」。');
  }
  parts.push('要引用字本身就用 `行內 code` 包起來。');
  return parts.join('');
}

/** 回 null＝放行。壞掉的最壞後果必須是「回到沒有這支的狀態」。 */
export function run(input) {
  if (existsSync(OFF) || config().language !== 'zh-TW' || !input) return null;
  const ask = input.tool_name === 'AskUserQuestion';
  let text;
  if (ask) {
    text = askText(input.tool_input);
  } else {
    if (input.stop_hook_active) return null;
    if (input.stop_reason && input.stop_reason !== 'end_turn') return null;
    if (/^sdk/i.test(process.env.CLAUDE_CODE_ENTRYPOINT || '')) return null;
    text = input.last_assistant_message || '';
    if (SYSTEM.test(text)) return null;
  }
  const f = findings(text);
  f.rare = unseenRare(input.session_id, f.rare);
  if (!f.simplified.length && !f.rare.length && !f.typo.length) return null;
  appendLog(LOG, { at: new Date().toISOString(), session: input.session_id, where: ask ? 'ask' : 'stop',
    simplified: f.simplified.map((x) => x.ch).join(''), typo: f.typo.map((x) => x.ch).join(''), rare: f.rare.map((x) => x.ch).join(''),
    ctx: [...f.typo, ...f.simplified, ...f.rare].map((x) => x.ctx).slice(0, 4) });
  if (ask) {
    return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason(f, '選項') } };
  }
  const r = reason(f, '剛才的回覆');
  // 兩種形狀一起給：Claude Code 看 hookSpecificOutput、Codex 看 decision（同 lang-guard）
  return { decision: 'block', reason: r, hookSpecificOutput: { hookEventName: 'Stop', permissionDecision: 'deny', permissionDecisionReason: r } };
}

if (isMain(import.meta.url)) cli(run);
