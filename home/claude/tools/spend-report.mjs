#!/usr/bin/env node
/**
 * 把四台的 spend.mjs 輸出合成一份報告。
 *
 *   node spend-report.mjs [放 *.json 的目錄，預設現在這個目錄]
 *
 * 通常不直接跑這支，跑 `spend.sh` —— 它會把 spend.mjs 送到三台遠端、收回
 * JSON、再叫這支。
 *
 * ⚠️ **口徑：`input + output + cache_read + cache_creation`，四項都要。**
 * 漏掉 cache read 會差 80 倍，而且已經害過一次（2026-09-25 的交接單）——
 * cache read 佔 token 的 98.3%、佔成本的 77.7%。見 memory 的
 * measure-context-cost-ab。
 */
import fs from 'node:fs';
import path from 'node:path';

// Opus 標準費率（USD / MTok）。訂閱制沒有實際帳單，這裡只當「相對成本權重」用。
const P = { in: 15, out: 75, cw: 18.75, cr: 1.5 };
const cost = p => (p.in * P.in + p.out * P.out + p.cacheCreate * P.cw + p.cacheRead * P.cr) / 1e6;

const DIR = process.argv[2] || '.';
const files = { Air: 'air.json', 'M5 Pro': 'pro.json', VICTUS: 'victus.json', desk: 'desk.json' };
const data = {};
for (const [name, f] of Object.entries(files)) {
  const p = path.join(DIR, f);
  try { data[name] = JSON.parse(fs.readFileSync(p, 'utf8')); }
  // 讀不到要出聲。少一台就少一台的帳，安靜跳過會讓總數看起來很合理但是錯的。
  catch (e) { console.error(`!! ${name}（${p}）讀不到，這一台不列入：${e.message}`); }
}
if (!Object.keys(data).length) { console.error('一台都沒讀到，先跑 spend.sh'); process.exit(1); }

const merged = new Map();  // proj -> agg
const perHost = {};
for (const [host, d] of Object.entries(data)) {
  perHost[host] = { total: 0, cost: 0, scanned: d.scanned, sessions: 0 };
  for (const p of d.projects) {
    let m = merged.get(p.name);
    if (!m) merged.set(p.name, m = { name: p.name, in: 0, out: 0, cacheRead: 0, cacheCreate: 0, turns: 0, sessions: 0, hosts: {} });
    for (const k of ['in', 'out', 'cacheRead', 'cacheCreate', 'turns', 'sessions']) m[k] += p[k];
    m.hosts[host] = (m.hosts[host] || 0) + cost(p);
    perHost[host].total += p.total;
    perHost[host].cost += cost(p);
    perHost[host].sessions += p.sessions;
  }
}

const all = [...merged.values()].map(p => ({ ...p, total: p.in + p.out + p.cacheRead + p.cacheCreate, cost: cost(p) }))
  .sort((a, b) => b.cost - a.cost);
const TOT = all.reduce((a, p) => a + p.total, 0);
const COST = all.reduce((a, p) => a + p.cost, 0);

// commits：四台合併，同名取最大（同一個 repo 可能在兩台都有）
const commits = {};
for (const d of Object.values(data)) for (const [n, c] of Object.entries(d.commits || {})) {
  if (!commits[n] || c.commits > commits[n].commits) commits[n] = c;
  if (c.uncommitted > (commits[n].uncommitted || 0)) commits[n].uncommitted = c.uncommitted;
}

const M = n => (n / 1e6).toFixed(0) + 'M';
const pad = (s, n) => String(s).padEnd(n);
const rpad = (s, n) => String(s).padStart(n);

console.log('# 四台合計（近 30 天）\n');
console.log(`總 token（含 cache read）：${(TOT / 1e9).toFixed(1)}B`);
console.log(`成本權重合計：$${COST.toFixed(0)}（Opus 標準費率換算，訂閱制無實際帳單）\n`);

console.log('## 每台');
console.log(pad('機器', 10), rpad('token', 10), rpad('成本權重', 12), rpad('session', 9), rpad('解析失敗', 9));
for (const [h, v] of Object.entries(perHost))
  console.log(pad(h, 10), rpad(M(v.total), 10), rpad('$' + v.cost.toFixed(0), 12), rpad(v.sessions, 9), rpad(v.scanned.parseErrors, 9));

console.log('\n## 每個專案（依成本權重排序）');
console.log(pad('專案', 30), rpad('成本', 9), rpad('佔比', 7), rpad('token', 9), rpad('輪次', 8), rpad('session', 8), rpad('commit', 8), rpad('每commit', 10));
for (const p of all) {
  const c = commits[p.name];
  const per = c && c.commits ? '$' + (p.cost / c.commits).toFixed(1) : '—';
  console.log(pad(p.name, 30), rpad('$' + p.cost.toFixed(0), 9), rpad(((p.cost / COST) * 100).toFixed(1) + '%', 7),
    rpad(M(p.total), 9), rpad(p.turns, 8), rpad(p.sessions, 8), rpad(c ? c.commits : '—', 8), rpad(per, 10));
}

console.log('\n## token 組成（這是「錢在哪」的關鍵）');
const agg = all.reduce((a, p) => ({ in: a.in + p.in, out: a.out + p.out, cr: a.cr + p.cacheRead, cw: a.cw + p.cacheCreate }), { in: 0, out: 0, cr: 0, cw: 0 });
const rows = [['cache read', agg.cr, agg.cr * P.cr / 1e6], ['cache write', agg.cw, agg.cw * P.cw / 1e6],
['input', agg.in, agg.in * P.in / 1e6], ['output', agg.out, agg.out * P.out / 1e6]];
console.log(pad('類別', 14), rpad('token', 10), rpad('佔token', 9), rpad('成本', 9), rpad('佔成本', 9));
for (const [n, t, c] of rows)
  console.log(pad(n, 14), rpad(M(t), 10), rpad(((t / TOT) * 100).toFixed(1) + '%', 9), rpad('$' + c.toFixed(0), 9), rpad(((c / COST) * 100).toFixed(1) + '%', 9));

console.log('\n## 最貴的 15 個 session');
const sess = [];
for (const [host, d] of Object.entries(data)) for (const s of d.sessions) sess.push({ ...s, host, cost: cost({ in: s.in, out: s.out, cacheRead: s.cacheRead, cacheCreate: s.cacheCreate }) });
sess.sort((a, b) => b.cost - a.cost);
console.log(pad('機器', 8), pad('專案', 22), rpad('成本', 8), rpad('輪次', 7), rpad('每輪ctx', 9), pad('  分帳依據', 10), '天數');
for (const s of sess.slice(0, 15)) {
  const days = s.first && s.last ? ((s.last - s.first) / 86400000).toFixed(1) : '?';
  console.log(pad(s.host, 8), pad(s.proj, 22), rpad('$' + s.cost.toFixed(0), 8), rpad(s.turns, 7),
    rpad(Math.round(s.total / s.turns / 1000) + 'k', 9), pad('  ' + s.how, 10), days);
}

console.log('\n## 未提交的工作（跑了 token 但還沒落地）');
for (const [n, c] of Object.entries(commits).filter(([, c]) => c.uncommitted > 0).sort((a, b) => b[1].uncommitted - a[1].uncommitted))
  console.log(pad(n, 30), rpad(c.uncommitted + ' 個檔', 12), c.path);
