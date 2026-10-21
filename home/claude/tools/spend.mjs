#!/usr/bin/env node
// 掃這台機器所有 Claude Code transcript，依專案分帳算 token 花費。
// 用法：node spend.mjs [天數，預設 30]  → stdout 印一份 JSON
// 設計原則：解析失敗要出聲（parseErrors），不要靜靜回一個看起來合理的數字。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import { execFileSync } from 'node:child_process';

const DAYS = Number(process.argv[2] || 30);
const HOME = os.homedir();
const CUTOFF = Date.now() - DAYS * 86400_000;

// ---- 找出所有 config dir（同一台可能有兩個帳號：~/.claude、~/.claude-xxx）----
const configDirs = fs.readdirSync(HOME)
  .filter(n => n === '.claude' || n.startsWith('.claude-'))
  .map(n => path.join(HOME, n))
  .filter(d => { try { return fs.statSync(path.join(d, 'projects')).isDirectory(); } catch { return false; } });

// ---- 專案名稱推定 ----
const PROJ_RE = /(?:Projects?|Code|repos)[\/\\]([A-Za-z0-9._\-]+)/g;
const SKIP = new Set(['node_modules', 'scratchpad', '.git']);

function projFromPath(p) {
  if (!p) return null;
  PROJ_RE.lastIndex = 0;
  let m, last = null;
  while ((m = PROJ_RE.exec(p)) !== null) if (!SKIP.has(m[1])) last = m[1];
  return last;
}

const stats = new Map();   // proj -> {in,out,cacheRead,cacheCreate,turns,sessions:Set}
const sessions = new Map();// sessionId -> {proj,total,turns,first,last,cwd,mentions:Map}
let parseErrors = 0, linesRead = 0, filesRead = 0, outOfWindow = 0;

function bump(proj, u) {
  let s = stats.get(proj);
  if (!s) stats.set(proj, s = { in: 0, out: 0, cacheRead: 0, cacheCreate: 0, turns: 0, sessions: new Set() });
  s.in += u.input_tokens || 0;
  s.out += u.output_tokens || 0;
  s.cacheRead += u.cache_read_input_tokens || 0;
  s.cacheCreate += u.cache_creation_input_tokens || 0;
  s.turns++;
  return s;
}

async function scanFile(file) {
  filesRead++;
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line) continue;
    linesRead++;
    let e;
    try { e = JSON.parse(line); } catch { parseErrors++; continue; }
    const ts = e.timestamp ? Date.parse(e.timestamp) : NaN;
    if (!Number.isNaN(ts) && ts < CUTOFF) { outOfWindow++; continue; }

    const sid = e.sessionId || path.basename(file, '.jsonl');
    let sess = sessions.get(sid);
    if (!sess) sessions.set(sid, sess = { total: 0, turns: 0, first: ts, last: ts, cwd: e.cwd || null, mentions: new Map(), file });
    if (!Number.isNaN(ts)) { if (!sess.first || ts < sess.first) sess.first = ts; if (!sess.last || ts > sess.last) sess.last = ts; }
    if (!sess.cwd && e.cwd) sess.cwd = e.cwd;

    // 專案提及：只在這一行真的帶路徑時才跑 regex
    if (line.includes('Projects') || line.includes('Project\\') || line.includes('/Code/')) {
      PROJ_RE.lastIndex = 0;
      let m;
      const seen = new Set();
      while ((m = PROJ_RE.exec(line)) !== null) {
        if (SKIP.has(m[1]) || seen.has(m[1])) continue;
        seen.add(m[1]);
        sess.mentions.set(m[1], (sess.mentions.get(m[1]) || 0) + 1);
      }
    }

    const u = e.message?.usage;
    if (u) {
      const t = (u.input_tokens || 0) + (u.output_tokens || 0) +
                (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
      sess.total += t;
      sess.turns++;
      (sess.usage ||= []).push(u);
    }
  }
}

async function main() {
  for (const cd of configDirs) {
    const projDir = path.join(cd, 'projects');
    let entries = [];
    try { entries = fs.readdirSync(projDir); } catch { continue; }
    for (const d of entries) {
      const full = path.join(projDir, d);
      let files = [];
      try { files = fs.readdirSync(full).filter(f => f.endsWith('.jsonl')); } catch { continue; }
      for (const f of files) {
        const fp = path.join(full, f);
        try {
          if (fs.statSync(fp).mtimeMs < CUTOFF) { continue; }   // 整份都比窗口舊就跳過
        } catch { continue; }
        await scanFile(fp);
      }
    }
  }

  // ---- 分帳：cwd 優先，家目錄的 session 用「提及最多的專案」回推 ----
  const out = [];
  for (const [sid, s] of sessions) {
    if (!s.usage) continue;
    let proj = projFromPath(s.cwd);
    let how = proj ? 'cwd' : null;
    if (!proj && s.mentions.size) {
      const [top, n] = [...s.mentions].sort((a, b) => b[1] - a[1])[0];
      // 門檻：至少被提到 5 次，才算得上這個 session 在做那個專案
      if (n >= 5) { proj = top; how = 'mentions'; }
    }
    if (!proj) { proj = '未歸屬'; how = 'none'; }
    const st = { in: 0, out: 0, cacheRead: 0, cacheCreate: 0 };
    for (const u of s.usage) {
      const r = bump(proj, u);
      st.in += u.input_tokens || 0; st.out += u.output_tokens || 0;
      st.cacheRead += u.cache_read_input_tokens || 0; st.cacheCreate += u.cache_creation_input_tokens || 0;
    }
    stats.get(proj).sessions.add(sid);
    out.push({ sid, proj, how, total: s.total, turns: s.turns, cwd: s.cwd,
               first: s.first, last: s.last, ...st });
  }

  // ---- 每個專案近 N 天的 commit 數（找得到 repo 才算）----
  const commits = {};
  const roots = [path.join(HOME, 'Projects'), path.join(HOME, 'Code'), 'D:\\Projects', 'E:\\Project', 'C:\\Projects'];
  for (const root of roots) {
    let names = [];
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const n of names) {
      const repo = path.join(root, n);
      try { if (!fs.statSync(path.join(repo, '.git')).isDirectory() && !fs.statSync(path.join(repo, '.git')).isFile()) continue; } catch { continue; }
      try {
        const c = execFileSync('git', ['-C', repo, 'rev-list', '--count', `--since=${DAYS}.days.ago`, 'HEAD'],
                               { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
        const dirty = execFileSync('git', ['-C', repo, 'status', '--porcelain'],
                               { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean).length;
        commits[n] = { commits: Number(c), uncommitted: dirty, path: repo };
      } catch { /* 不是 repo 或 git 不在 */ }
    }
  }

  const projects = [...stats].map(([name, s]) => ({
    name, ...s, sessions: s.sessions.size,
    total: s.in + s.out + s.cacheRead + s.cacheCreate,
  })).sort((a, b) => b.total - a.total);

  console.log(JSON.stringify({
    host: os.hostname(), days: DAYS, configDirs,
    scanned: { files: filesRead, lines: linesRead, parseErrors, outOfWindow },
    projects, commits,
    sessions: out.sort((a, b) => b.total - a.total).slice(0, 25),
  }));
}

main().catch(e => { console.error('FATAL', e); process.exit(1); });
