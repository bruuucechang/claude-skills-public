#!/usr/bin/env node
// InstructionsLoaded hook：把「這個 session 載入了哪份指令檔」記進 ~/.claude/logs/instructions-loaded.jsonl。
// 原本是 settings.json 裡的 inline jq；改走 lib/log.mjs 才會跟其他 log 一樣只留 30 天。
// 重跑：echo '{"hook_event_name":"InstructionsLoaded","file_path":"/x"}' | node instructions-log.mjs
import { mkdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { appendLog } from './lib/log.mjs';

try {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}');
  const dir = join(homedir(), '.claude', 'logs');
  mkdirSync(dir, { recursive: true });
  appendLog(join(dir, 'instructions-loaded.jsonl'), { ...input, _t: new Date().toISOString() });
} catch {}
