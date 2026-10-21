---
name: claude-bridge
description: Codex 專屬。Claude Code 有、Codex 沒有的功能在這裡要用什麼替代——記憶檔（~/.claude/memory）、瀏覽器驗收、問句選項、Artifact／文件、subagent、背景等待、/code-review。回答跟這幾台機器／某個專案有關的問題之前、要開瀏覽器之前、要問使用者問題之前、或規則裡提到某個 Claude 工具（AskUserQuestion、Artifact、ScheduleWakeup、Monitor、claude-in-chrome）而你找不到時使用。
---

# Claude 功能在 Codex 的替代品

`AGENTS.md` 是 Claude Code 與 Codex 共用的同一份，裡面點名的工具多半是 Claude 的。
這份對照表告訴你在 Codex 裡改用什麼。**規則本身不變，只是換工具。**

## 記憶檔（Claude 的 recall）

Claude 每個 session 會自動載入 `~/.claude/memory/MEMORY.md`（索引）並按需讀記憶檔，
Codex 不會。所以：

- 問題跟**這幾台機器、某個專案、某個踩過的坑**有關 → 先
  `rg -l '<關鍵字>' ~/.claude/memory/` 或讀 `~/.claude/memory/MEMORY.md` 索引，再回答。
- `AGENTS.md` 裡的 `[[名字]]` ＝ `~/.claude/memory/<名字>.md`（底線／連字號兩種拼法都試）。
- 記憶檔反映的是**寫下當時**的狀態；提到檔案、指令、旗標的，用之前先確認還存在。
- 要新增記憶：一個檔一件事，格式照抄既有檔的 frontmatter（`name`／`description`／
  `metadata.type`），並在 `MEMORY.md` 加一行指標。**改既有檔前先讀完整份**——
  別的 Claude session 可能正在寫同一個目錄。

## 問句與 approve（Claude 的 AskUserQuestion）

Codex 有 `request_user_input` 工具時用它；沒有就列**編號選項**，最後寫「回一個數字就好」。
選項用繁體字、每個附一句話說選了會怎樣、較優解排第一並標 (Recommended)。
一次只問一題。

## 瀏覽器（Claude 的 claude-in-chrome）

驗收前端的預設答案是 **`dev-browser --headless`**（`/opt/homebrew/bin/dev-browser`，
用法見 `dev-browser` skill）：不開視窗、不碰使用者的 Chrome。
只有非要他的登入狀態／擴充功能時才用 Codex 的 browser／Chrome plugin，而且：

1. **不准改視窗大小**——跟使用者正在看的分頁同一個視窗。要看手機版用 iframe。
2. **不准把分頁愈開愈多**：最多從 0 開到 1。
3. **開了就要收**，換工具的那一刻就收。
4. **不准碰使用者正在用的分頁**（他可能在看直播）。

要驗 WebGL 見 `~/.claude/memory/headless-chrome-cdp-webgl.md`（dev-browser 沒有 WebGL）。

## Artifact／Claude Docs

Codex 沒有。要交一份給人看的頁面 → 寫成單一 HTML 檔放在專案的 `scratchpad/`
（或 `/tmp`），用 `open <檔案>` 叫出來給他看。文件 → Markdown 檔。
**不要**為此上傳到任何外部服務。

## subagent／Workflow

Codex 沒有 Claude 的 Agent／Workflow 工具。要平行跑獨立工作 →
背景開 `codex exec --skip-git-repo-check "<極致詳細的工作單>" < /dev/null > log 2>&1 &`，
工作單照 `AGENTS.md`「兩份 prompt 都要寫到極致詳細」辦。`< /dev/null` 不能省。

## 背景等待（Claude 的 run_in_background／Monitor／ScheduleWakeup）

用 `nohup … &` 或 `tmux`，指令寫成「條件成立就退出」，然後回頭收結果。
`AGENTS.md`「長工不要用前景等」那一節一樣適用；過濾要同時寫失敗訊號。

## /code-review、/security-review

改用 `codex review`，或直接照 `security-audit` skill 做。

## 這份對照表是怎麼裝進來的

由 `~/.claude/skills/home/claude/tools/codex-sync.sh` 安裝，同一支腳本也負責把
Claude 的 skill 與 plugin skill 接進 `~/.codex/skills`、把 hooks 裝進 `~/.codex/hooks.json`。
Claude 那邊裝了新 plugin 或 plugin 更新後，重跑那支腳本。
