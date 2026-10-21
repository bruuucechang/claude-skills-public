#!/usr/bin/env node
/**
 * replay-p3.mjs —— 拿近 N 天的真實 transcript 重播 kill-guard 與 lang-guard（規格 P3）。
 *
 *     node ~/.claude/skills/home/claude/hooks/replay-p3.mjs kill [天數=14]
 *     node ~/.claude/skills/home/claude/hooks/replay-p3.mjs lang [天數=14] [輸出 JSON]
 *
 * 兩個帳號都掃（~/.claude/projects、~/.claude-work/projects），子代理的 transcript 不算。
 * 呼叫的是 hook 本身匯出的判斷式，不另外抄一份。
 *
 * kill：列出每一筆提到 pkill／killall／pgrep／kill 的 Bash 指令與判決，最後統計
 *       「真的在跑 pkill／killall／kill $(pgrep)」的筆數 vs 擋下的筆數、以及 `kill <pid>` 有沒有被誤擋。
 *       「真的在跑」用一條比 hook 粗的正規式先抓，不一致的逐筆印出來給人看。
 * lang：每個互動（entrypoint 不是 sdk-*，跟 hook 的放行條件一樣）回合的最後一則助理文字，算中日韓字／拉丁字母，
 *       印出各門檻下會擋幾則；第三個參數給了就把每一則的數字寫成 JSON，方便人工抽查。
 */
import { createReadStream, existsSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

process.env.HOOK_NOLOG = '1';
const [MODE = 'kill', DAYS = '14', OUT] = process.argv.slice(2);
const cut = Date.now() - Number(DAYS) * 86_400_000;

function transcripts() {
  const files = [];
  for (const [acct, root] of [['bruce', join(homedir(), '.claude', 'projects')], ['peter', join(homedir(), '.claude-work', 'projects')]]) {
    if (!existsSync(root)) continue;
    for (const d of readdirSync(root)) {
      let fs_ = [];
      try { fs_ = readdirSync(join(root, d)); } catch { continue; }
      for (const f of fs_) {
        if (!f.endsWith('.jsonl')) continue;
        const p = join(root, d, f);
        try { if (statSync(p).mtimeMs >= cut) files.push({ acct, p }); } catch {}
      }
    }
  }
  return files;
}

async function* lines(p) {
  const rl = createInterface({ input: createReadStream(p, 'utf8'), crlfDelay: Infinity });
  for await (const l of rl) { let o; try { o = JSON.parse(l); } catch { continue; } yield o; }
}

if (MODE === 'kill') {
  const { classify } = await import('./kill-guard.mjs');
  // 粗的「真的在跑」：段首（或 sudo／ssh 主機 '…'／xargs 後面）是 pkill／killall，或 kill 接 $(pgrep
  const RUNS = /(?:^|[;&|(\n]\s*|\bsudo\s+|\bxargs\s+(?:-\S+\s+)*|\bssh\s+\S+\s+['"]?)(?:pkill|killall)\b|\bkill\b[^;&|\n]*(?:\$\(|`)\s*pgrep\b|\bpgrep\b[^;&\n]*\|\s*xargs\s+(?:-\S+\s+)*kill\b/;
  const PID = /(?:^|[;&|(\n]\s*)kill\s+(?:-\S+\s+)*(?:\d+|\$\{?\w+\}?|%\d+)(?:\s+(?:\d+|\$\{?\w+\}?))*\s*(?:$|[;&|)\n])/;
  const seen = new Set();
  const rows = [];
  for (const { acct, p } of transcripts()) {
    for await (const o of lines(p)) {
      if (o.type !== 'assistant' || !Array.isArray(o.message?.content)) continue;
      if (o.timestamp && Date.parse(o.timestamp) < cut) continue;
      for (const b of o.message.content) {
        if (b.type !== 'tool_use' || b.name !== 'Bash' || typeof b.input?.command !== 'string') continue;
        const c = b.input.command;
        if (!/pkill|killall|pgrep|\bkill\b/.test(c) || seen.has(c)) continue;
        seen.add(c);
        rows.push({ acct, day: (o.timestamp || '').slice(0, 10), cmd: c, runs: RUNS.test(c), pid: PID.test(c) && !RUNS.test(c), blocked: classify(c) });
      }
    }
  }
  const runs = rows.filter((r) => r.runs), pid = rows.filter((r) => r.pid);
  const odd = rows.filter((r) => r.runs !== !!r.blocked);
  console.log(`近 ${DAYS} 天 Bash 指令（去重）提到 kill 類：${rows.length} 筆`);
  console.log(`粗判「真的在跑 pkill／killall／kill $(pgrep)」：${runs.length} 筆，hook 擋 ${runs.filter((r) => r.blocked).length}`);
  console.log(`\`kill <pid>\` 類：${pid.length} 筆，hook 擋 ${pid.filter((r) => r.blocked).length}`);
  console.log(`hook 總共擋：${rows.filter((r) => r.blocked).length} 筆`);
  console.log(`\n粗判與 hook 不一致 ${odd.length} 筆（逐筆看）：`);
  for (const r of odd) console.log(`- [${r.blocked ? '擋' : '放'}｜粗判${r.runs ? '在跑' : '沒跑'}] ${r.acct} ${r.day} ${r.cmd.replace(/\s+/g, ' ').slice(0, 220)}`);
  if (OUT) writeFileSync(OUT, JSON.stringify(rows, null, 1));
} else if (MODE === 'lang') {
  const L = await import('./lang-guard.mjs');
  const rows = [];
  for (const { acct, p } of transcripts()) {
    let entry = null, last = null;
    for await (const o of lines(p)) {
      if (!entry && o.entrypoint) entry = o.entrypoint;
      if (o.type === 'assistant' && !o.isSidechain && Array.isArray(o.message?.content)) {
        const t = o.message.content.filter((b) => b.type === 'text' && b.text?.trim()).map((b) => b.text).join('\n');
        if (t) last = { t, day: (o.timestamp || '').slice(0, 10), ts: o.timestamp };
      }
      if (o.type === 'system' && o.subtype === 'turn_duration') {
        if (last && entry && !/^sdk/.test(entry) && Date.parse(last.ts || 0) >= cut) rows.push({ acct, s: p.split('/').pop().slice(0, 8), day: last.day, ...L.counts(last.t), len: last.t.length, text: last.t });
        last = null;
      }
    }
  }
  const n = rows.length;
  console.log(`近 ${DAYS} 天互動回合：${n}（bruce ${rows.filter((r) => r.acct === 'bruce').length}、peter ${rows.filter((r) => r.acct === 'peter').length}）`);
  console.log('\n| RATIO | MIN_LATIN | 擋下 | 比例 |\n|---|---|---|---|');
  for (const ratio of [1, 2, 3, 6]) for (const min of [15, 20, 30, 45, 60, 100]) {
    const k = rows.filter((r) => L.isEnglish(r.text, ratio, min)).length;
    console.log(`| ${ratio} | ${min} | ${k} | ${(k / n * 100).toFixed(1)}% |`);
  }
  // 分三區：A 中文字 ≥ 字母（明確是中文回覆）、B 沒有中文字且字母 > 10（明確是英文；額度用完這類系統訊息除外）、
  // C 其餘（混合，逐則印出給人看）。誤擋率＝A 被擋的比例；英文收尾擋到的比例＝B 被擋的比例＋C 人工判讀。
  const cur = rows.filter((r) => L.isEnglish(r.text));
  const A = rows.filter((r) => r.cjk > 0 && r.cjk >= r.latin);
  const sys = rows.filter((r) => L.SYSTEM.test(r.text));
  const B = rows.filter((r) => r.cjk === 0 && r.latin > 10 && !sys.includes(r));
  const C = rows.filter((r) => !A.includes(r) && !B.includes(r) && !sys.includes(r));
  const pct = (a, b) => `${a}/${b}（${b ? (a / b * 100).toFixed(1) : 0}%）`;
  console.log(`\n現行門檻（RATIO=${L.RATIO}、MIN_LATIN=${L.MIN_LATIN}、SHORT_CJK=${L.SHORT_CJK}、SHORT_LATIN=${L.SHORT_LATIN}）擋 ${pct(cur.length, n)}`);
  console.log(`A 中文為主：誤擋 ${pct(A.filter((r) => L.isEnglish(r.text)).length, A.length)}`);
  console.log(`B 純英文：擋到 ${pct(B.filter((r) => L.isEnglish(r.text)).length, B.length)}`);
  console.log(`系統訊息（額度、API 錯誤）：擋 ${pct(sys.filter((r) => L.isEnglish(r.text)).length, sys.length)}`);
  console.log(`C 混合 ${C.length} 則（逐則看）：`);
  for (const r of C) console.log(`  [${L.isEnglish(r.text) ? '擋' : '放'}] 中${r.cjk} 英${r.latin} ${r.acct} ${r.s} | ${r.text.replace(/\s+/g, ' ').slice(0, 110)}`);
  if (OUT) writeFileSync(OUT, JSON.stringify(rows.map((r) => ({ ...r, en: L.isEnglish(r.text) })), null, 1));
} else {
  console.error('用法：replay-p3.mjs kill|lang [天數] [輸出 JSON]');
  process.exit(2);
}
