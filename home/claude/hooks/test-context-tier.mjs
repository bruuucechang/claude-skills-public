#!/usr/bin/env node
/**
 * context-tier.mjs 的迴歸測試（累積層為主）。
 *
 *   node ~/.claude/skills/home/claude/hooks/test-context-tier.mjs
 *
 * ## 兩個設計決定
 *
 * **自己合成 transcript，不依賴這台機器上剛好有哪份檔。** 四台都要跑得起來，
 * 而 Windows 那兩台沒有 Air 的 transcript。合成的那份刻意做到 **> 4 MB**
 * （＝ scanFrom 的 CHUNK），否則「分塊邊界切在中文字中間」那條路徑根本不會被走到，
 * 測試會是綠燈假象。內容全是中文，切壞就會安靜少算——這正是要測的那個失敗模式。
 *
 * **HOME 指到暫存目錄。** hook 的 state 檔在 `~/.claude/session-logs/`，
 * log 在 hook 自己的目錄旁邊。測試複製一份 hook 到暫存目錄再跑，
 * 所以既不會汙染真的 `.tier-state.json`，也不會把測試資料寫進稽核 log。
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync, copyFileSync, cpSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = join(HERE, 'context-tier.mjs');
const SANDBOX = join(tmpdir(), 'context-tier-test-' + process.pid);
const HOOK = join(SANDBOX, 'context-tier.mjs');
const FAKEHOME = join(SANDBOX, 'home');

rmSync(SANDBOX, { recursive: true, force: true });
mkdirSync(join(FAKEHOME, '.claude', 'session-logs'), { recursive: true });
copyFileSync(SRC, HOOK);
cpSync(join(HERE, 'lib'), join(SANDBOX, 'lib'), { recursive: true });

let pass = 0, fail = 0;
const ok = (name, cond, extra = '') => {
  cond ? pass++ : fail++;
  console.log(`  ${cond ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${extra ? '  — ' + extra : ''}`);
};

function run(sid, transcript) {
  const out = execFileSync(process.execPath, [HOOK], {
    input: JSON.stringify({ session_id: sid, transcript_path: transcript }),
    env: { ...process.env, HOME: FAKEHOME, USERPROFILE: FAKEHOME },
    encoding: 'utf8',
  });
  const log = readFileSync(join(SANDBOX, 'context-tier.log'), 'utf8').trim().split('\n');
  return { out, last: JSON.parse(log[log.length - 1]) };
}

/** 獨立算法：整份讀進來逐行算，跟 hook 的增量掃對答案。 */
function truth(file) {
  let cum = 0, turns = 0, last = null;
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (!line || line[0] !== '{') continue;
    let j; try { j = JSON.parse(line); } catch { continue; }
    const u = j?.message?.usage; if (!u) continue;
    const c = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
    if (c < 1000) continue;
    cum += c; turns++; last = c;
  }
  return { cum, turns, last };
}

// 每筆塞一段中文，讓 4 MB 的分塊邊界一定會落在多位元組字元中間。
const FILLER = '這一段刻意寫長，讓每一筆紀錄都夠大，'
  + '整份檔案才跨得過 scanFrom 的 4 MB 分塊邊界——'
  + '切點落在中文字中間時，壞掉的字會變成替代字元，'
  + '那只會弄壞一行 JSON 而不會丟例外，所以症狀是安靜地少算。'.repeat(60);
// ⚠️ 這個 60 是算出來的，不是隨手填的：每筆約 5.2 KB × 1,200 筆 ≈ 6 MB > CHUNK（4 MB）。
// 改小了測試會變成綠燈假象，所以上面第一條斷言就是在守這件事。

const entry = (ctx) => JSON.stringify({
  type: 'assistant',
  timestamp: new Date().toISOString(),
  message: { usage: { input_tokens: 0, cache_read_input_tokens: ctx, cache_creation_input_tokens: 0 } },
  note: FILLER,
});
const block = (n, ctx) => Array.from({ length: n }, () => entry(ctx)).join('\n') + '\n';

const BIG = join(SANDBOX, 'big.jsonl');

console.log('\n  context-tier 累積層\n');

console.log('  — 累積量要跟獨立算法一致（檔案 > 4 MB，逼出分塊邊界）');
writeFileSync(BIG, block(1200, 500_000));
const size = statSync(BIG).size;
ok('合成檔真的跨得過分塊邊界', size > 4 * 1024 * 1024, `${(size / 1024 / 1024).toFixed(1)} MB`);
const exp = truth(BIG);
const r1 = run('t-big', BIG);
ok('cum 一致', r1.last.cum === exp.cum, `hook=${r1.last.cum} 基準=${exp.cum}`);
ok('turns 一致', r1.last.turns === exp.turns, `hook=${r1.last.turns} 基準=${exp.turns}`);
ok('lastCtx 一致', r1.last.ctx === exp.last);
ok('第一次是整份補掃', r1.last.scanBytes === size, `${r1.last.scanBytes} bytes / ${r1.last.scanMs} ms`);

console.log('\n  — 增量：第二次不該重掃，也不該重複叫');
const r2 = run('t-big', BIG);
ok('沒有重掃', r2.last.scanBytes === 0, `${r2.last.scanBytes} bytes / ${r2.last.scanMs} ms`);
ok('累積量沒有變', r2.last.cum === r1.last.cum);
ok('同一階不再叫', r2.last.cumFired === false);

console.log('\n  — 門檻：到 500M 叫一次，之後每翻一倍再叫');
const G = join(SANDBOX, 'grow.jsonl');
writeFileSync(G, block(600, 500_000));                    // 300M
const g1 = run('t-grow', G);
ok('300M 不叫', g1.last.cumFired === false, `cum=${(g1.last.cum / 1e6).toFixed(0)}M`);
appendFileSync(G, block(600, 500_000));                   // 600M
const g2 = run('t-grow', G);
ok('跨 500M 開火', g2.last.cumFired === true && g2.last.cumStep === 1, `cum=${(g2.last.cum / 1e6).toFixed(0)}M`);
ok('只掃增量', g2.last.scanBytes < statSync(G).size, `${g2.last.scanBytes} < ${statSync(G).size}`);
ok('建議換手而不是壓縮', g2.out.includes('換手') && g2.out.includes('不會因為'));
appendFileSync(G, block(400, 500_000));                   // 800M，同一階
const g3 = run('t-grow', G);
ok('同一階不再叫', g3.last.cumFired === false, `cum=${(g3.last.cum / 1e6).toFixed(0)}M step=${g3.last.cumStep}`);
appendFileSync(G, block(600, 500_000));                   // 1.1B，跨階
const g4 = run('t-grow', G);
ok('翻倍再叫一次', g4.last.cumFired === true && g4.last.cumStep === 2, `cum=${(g4.last.cum / 1e9).toFixed(2)}B`);
ok('語氣隨倍數加重', g4.out.includes('又翻了一倍'));

console.log('\n  — 檔案變小（/clear、換新 transcript）→ 累積歸零重來');
writeFileSync(G, block(10, 500_000));
const g5 = run('t-grow', G);
ok('偵測到 reset', g5.last.reset === true);
ok('累積歸零重算', g5.last.cum === 5_000_000, `cum=${g5.last.cum}`);
ok('歸零後不叫', g5.last.cumFired === false);

console.log('\n  — 壞掉不准擋住使用者送出 prompt');
ok('檔案不存在 → 無輸出', run('t-missing', join(SANDBOX, 'nope.jsonl')).out === '');
ok('transcript_path 是空的 → 無輸出', run('t-empty', '').out === '');
const TRUNC = join(SANDBOX, 'trunc.jsonl');
writeFileSync(TRUNC, '{"這行是壞的 JSON\n' + block(3, 600_000));
ok('壞行跳過、好行照算', run('t-trunc', TRUNC).last.cum === 1_800_000);
// 半行結尾：offset 不能推過最後一個換行，否則下一輪從半行接，永遠對不齊。
const HALF = join(SANDBOX, 'half.jsonl');
writeFileSync(HALF, block(2, 600_000) + '{"type":"assistant","message":{"usage":{"cache_read');
const h1 = run('t-half', HALF);
ok('半行不算數', h1.last.cum === 1_200_000, `cum=${h1.last.cum}`);
appendFileSync(HALF, '_input_tokens":600000}}}\n');       // 把那半行補完
const h2 = run('t-half', HALF);
ok('補完之後才算進去', h2.last.cum === 1_800_000, `cum=${h2.last.cum}`);

console.log('\n  — 小額呼叫（子代理／小模型）不該灌水累積量');
const SMALL = join(SANDBOX, 'small.jsonl');
writeFileSync(SMALL, block(5, 999) + block(2, 700_000));
ok('< 1k 的呼叫被濾掉', run('t-small', SMALL).last.cum === 1_400_000);

console.log('\n  — 同一則回應拆成多行（每個 content block 一行、usage 相同）只算一次');
const msg = (id, ctx, kind = 'text') => JSON.stringify({
  type: 'assistant', requestId: 'req_' + id,
  message: { id, content: [{ type: kind }], usage: { input_tokens: 0, cache_read_input_tokens: ctx, cache_creation_input_tokens: 0 } },
});
const DUP = join(SANDBOX, 'dup.jsonl');
writeFileSync(DUP, [msg('m1', 600_000), msg('m1', 600_000, 'tool_use'), msg('m1', 600_000, 'tool_use'), msg('m2', 700_000)].join('\n') + '\n');
const d1 = run('t-dup', DUP);
ok('三行同 id 算一次', d1.last.cum === 1_300_000 && d1.last.turns === 2, `cum=${d1.last.cum} turns=${d1.last.turns}`);
appendFileSync(DUP, [msg('m2', 700_000, 'tool_use'), msg('m3', 800_000)].join('\n') + '\n');
const d2 = run('t-dup', DUP);
ok('同一則被兩次掃描切開也不重算', d2.last.cum === 2_100_000 && d2.last.turns === 3, `cum=${d2.last.cum} turns=${d2.last.turns}`);
ok('lastCtx 是最後一則', d2.last.ctx === 800_000);

console.log('\n  — 舊格式 state（沒有 v、cum 是灌水的）→ 整份重掃、這一輪累積層不叫');
const STATEF = join(FAKEHOME, '.claude', 'session-logs', '.tier-state.json');
const st = JSON.parse(readFileSync(STATEF, 'utf8'));
st['t-old'] = { tier: 0, at: 0, off: statSync(DUP).size, cum: 999_000_000_000, turns: 9999, cumStep: 1, seen: Date.now() };
writeFileSync(STATEF, JSON.stringify(st));
const o1 = run('t-old', DUP);
ok('舊 state 被重掃成去重後的數字', o1.last.cum === 2_100_000 && o1.last.migrated === true, `cum=${o1.last.cum}`);
ok('遷移那一輪累積層不叫', o1.last.cumFired === false && !o1.out.includes('累積'));
const o2 = run('t-old', DUP);
ok('遷移之後是增量', o2.last.scanBytes === 0 && o2.last.migrated === false);

// REAL=N：拿這台最近 N 份真的 transcript（2〜80 MB）比對「逐行加總」「全域依 id 去重」與 scanFrom 的結果
if (process.env.REAL) {
  console.log('\n  — 真 transcript：scanFrom 的累積量要等於依 message.id 去重的基準');
  const { scanFrom } = await import(SRC);
  const { readdirSync } = await import('node:fs');
  const { homedir } = await import('node:os');
  const files = [];
  for (const r of ['.claude/projects', '.claude-work/projects']) {
    const root = join(homedir(), r);
    let ds = []; try { ds = readdirSync(root); } catch { continue; }
    for (const d of ds) { let fs = []; try { fs = readdirSync(join(root, d)); } catch { continue; }
      for (const f of fs) if (f.endsWith('.jsonl')) { const p = join(root, d, f); const st = statSync(p); if (st.size > 2e6 && st.size < 80e6) files.push({ p, m: st.mtimeMs }); } }
  }
  for (const { p } of files.sort((a, b) => b.m - a.m).slice(0, Number(process.env.REAL) || 8)) {
    const ids = new Map(); let raw = 0;
    for (const l of readFileSync(p, 'utf8').split('\n')) {
      if (!l.includes('"usage"') || l[0] !== '{') continue;
      let j; try { j = JSON.parse(l); } catch { continue; }
      const u = j?.message?.usage; if (!u) continue;
      const c = (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0);
      if (c < 1000) continue;
      raw += c; ids.set(j.message.id ?? j.requestId ?? Symbol(), c);
    }
    const base = [...ids.values()].reduce((a, b) => a + b, 0);
    const got = scanFrom(p, 0).cum;
    ok(`${p.split('/').pop().slice(0, 8)}`, got === base, `逐行 ${(raw / 1e6).toFixed(0)}M／去重 ${(base / 1e6).toFixed(0)}M／scanFrom ${(got / 1e6).toFixed(0)}M／灌水 ${(raw / Math.max(1, base)).toFixed(2)} 倍`);
  }
}

rmSync(SANDBOX, { recursive: true, force: true });
console.log(`\n  ${pass} 過 · ${fail} 失敗\n`);
process.exit(fail === 0 ? 0 : 1);
