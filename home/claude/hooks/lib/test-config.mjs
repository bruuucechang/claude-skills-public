/**
 * test-config.mjs —— 測試共用的設定檔。要放在測試檔的**第一個** import：
 * ESM 依序執行 import，這支先把 CLAUDE_SKILLS_CONFIG 指到固定的測試值，之後載入的 hook
 * （與 spawn 出去、繼承 process.env 的子程序）讀到的都是它，不會吃到使用者自己的 config.json。
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const TEST_CONFIG = { github_owner: 'octocat', git_name: 'octo', git_emails: ['octo@example.com'], language: 'zh-TW' };
const f = join(mkdtempSync(join(tmpdir(), 'skills-config-')), 'config.json');
writeFileSync(f, JSON.stringify(TEST_CONFIG));
process.env.CLAUDE_SKILLS_CONFIG = f;
