// node ~/.claude/skills/home/claude/hooks/lib/log.test.mjs —— lib/log.mjs 的測試
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { appendLog, lineTime, prune } from './log.mjs';

const dir = mkdtempSync(join(tmpdir(), 'hooklog-'));
const now = Date.parse('2026-10-20T12:00:00Z');
const iso = (d) => new Date(now - d * 86_400_000).toISOString();

// 三種時間欄位都認得，包括 date +%FT%T%z 的 +0800 寫法
assert.equal(lineTime(`{"at":"${iso(1)}"}`), now - 86_400_000);
assert.equal(lineTime('{"t":"2026-10-20T12:00:00.000Z"}'), now);
assert.equal(lineTime('{"x":1,"_t":"2026-10-20T20:00:00+0800"}'), now);
assert.equal(lineTime('沒有時間的行'), null);

// 31 天前的刪、29 天前的留、沒時間的留
const f = join(dir, 'a.log');
writeFileSync(f, [`{"at":"${iso(31)}"}`, `{"t":"${iso(29)}"}`, 'plain', `{"_t":"${iso(40)}"}`, ''].join('\n'));
assert.equal(prune(f, now), 2);
assert.deepEqual(readFileSync(f, 'utf8').split('\n'), [`{"t":"${iso(29)}"}`, 'plain', '']);

// 鎖在時不修剪
writeFileSync(f, `{"at":"${iso(31)}"}\n`);
const { mkdirSync, rmdirSync, utimesSync } = await import('node:fs');
mkdirSync(`${f}.prune-lock`);
utimesSync(`${f}.prune-lock`, now / 1000, now / 1000);
assert.equal(prune(f, now), 0);
rmdirSync(`${f}.prune-lock`);

// 鎖放超過 10 分鐘＝死鎖，清掉（這次不修剪，下次才修）
mkdirSync(`${f}.prune-lock`);
utimesSync(`${f}.prune-lock`, (now - 700_000) / 1000, (now - 700_000) / 1000);
assert.equal(prune(f, now), 0);
assert.ok(!existsSync(`${f}.prune-lock`));
assert.equal(prune(f, now), 1);

// appendLog：一天只修剪一次
const g = join(dir, 'b.log');
writeFileSync(g, `{"at":"${iso(31)}"}\n`);
appendLog(g, { at: iso(0), n: 1 }, now);
assert.ok(!readFileSync(g, 'utf8').includes(iso(31)), '第一次寫入要修剪');
assert.ok(existsSync(`${g}.pruned`));
writeFileSync(g, readFileSync(g, 'utf8') + `{"at":"${iso(31)}"}\n`);
appendLog(g, 'raw line', now + 3_600_000);
assert.ok(readFileSync(g, 'utf8').includes(iso(31)), '同一天第二次不修剪');
appendLog(g, 'next day', now + 86_400_000);
assert.ok(!readFileSync(g, 'utf8').includes(iso(31)), '隔天再修剪');

console.log('log.test: ok');
