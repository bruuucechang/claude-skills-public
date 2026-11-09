@AGENTS.md

<!--
上面那行匯入跟工具無關的規則（Codex 也讀同一份）。這裡只寫 Claude Code 才有的機制；
新增前先問「換個 agent 還成立嗎」，成立就寫進 AGENTS.md。情境性的做法放 rules/（帶 paths:）。
-->

# Claude Code 專屬

## 上面的規則用哪個工具做

- 問句與 approve → `AskUserQuestion`（Stop hook `ask-with-options.mjs` 在擋），送出前核對繁體。
- 等一件事完成 → `Bash` 帶 `run_in_background: true`，結束時自動叫醒你；每次發生都要通知才用 `Monitor`。
- 能按的提示直接幫他按（[[auto-click-prompts]]）；密碼／不可逆／花錢／對外發布仍用選項先問。
- 常用流程是指令：`/progress` 彙報進度、`/ship` 驗證後推、`/handoff` 寫交接單、`/recon` 動 repo 前查現況。

## 瀏覽器：五條硬規則（沒讀前端檔就決定開瀏覽器時也成立）

做法、根因與事故細節在 `~/.claude/rules/browser.md`（動到前端檔才載入）。

1. **不准 resize。** MCP 分頁跟他的直播同住一個視窗；`resize_window` 已 deny，用 JS 或 batch 夾帶都算繞道。看手機版用 iframe。
2. **不准把分頁愈開愈多**（0→1 可以，1→2 不行）。`navigate` 不帶 `tabId`；`tabs_create_mcp` 已 deny。
3. **驗收前端預設用 `dev-browser --headless`**；只有非要他的登入／擴充功能／WebGL 才開 MCP 分頁。
4. **開了就收掉，換工具的那一刻就是收尾的那一刻。** 跨 session 搬不動，不關就永遠留著。
5. **只用自己建的分頁**，不碰他正在用的視窗或分頁。

## 規則放在哪

某個 session 載入了什麼：`~/.claude/logs/instructions-loaded.jsonl` 或 `/context`（[[claude-md-context-mechanics]]）。
