#!/usr/bin/env node
/**
 * PreToolUse(mcp__claude-in-chrome__browser_batch) —— 內層動作只准白名單上的。
 *
 * browser_batch 的內層動作不會經過 settings.json 的權限檢查，deny 掉的 resize_window／
 * tabs_create_mcp 夾在 batch 裡就繞過去了，所以擋在這裡。
 * 2026-10-20 從 settings.json 的 inline jq 搬成 JS（給 dispatch.mjs 呼叫），判斷照舊。
 */
import { cli, isMain } from './lib/hook-cli.mjs';

export const ALLOWED = ['navigate', 'tabs_context_mcp', 'tabs_close_mcp', 'read_page', 'get_page_text', 'find',
  'computer', 'javascript_tool', 'read_console_messages', 'read_network_requests'];

export function run(input) {
  const actions = input?.tool_input?.actions;
  if (!Array.isArray(actions)) return null;
  const bad = actions.map((a) => a?.name).filter((n) => !ALLOWED.includes(n)).map((n) => n ?? '').join(', ');
  if (!bad) return null;
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: `browser_batch 裡夾了沒有放行的動作：${bad}。browser_batch 的內層動作不會經過 settings.json 的權限檢查，所以改用白名單擋在這裡。resize_window 被禁：它改的是整個 Chrome 視窗，而 MCP 分頁跟使用者自己的分頁同住一個視窗，縮下去會把他正在看的分頁一起壓小。tabs_create_mcp 被禁：那是唯一會讓分頁累積的路徑，要開頁面請用 navigate 不帶 tabId，它會重用群組裡既有的分頁，群組空的時候才開新的。`,
    },
  };
}

if (isMain(import.meta.url)) cli(run);
