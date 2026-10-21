# Codex 的 hooks 設定（`codex-hooks.json` 的說明）

JSON 不能寫註解，而這份設定有三件事非解釋不可，所以放這裡。
安裝位置是 `~/.codex/hooks.json`（mac 由 `tools/codex-sync.sh` 裝；Windows 是 `sync-rules.cmd` 的第六步）。

## 為什麼要有這個檔

使用者的規則「問句與 approve 一律用可選取的選項」寫在 `AGENTS.md`，
而 **Codex 讀的就是同一份 `AGENTS.md`**（`~/.codex/AGENTS.md` 指過去）。
所以規則早就到了 Codex 那邊——但一直只是文字。

按使用者自己列在 `AGENTS.md` 開頭的第 2 條原則：**規則是請求，機制才是保證。**
2026-09-10 查了一遍，四台機器兩個工具裡，真的有東西在擋這條規則的只有
Air 上的 Claude Code 一個。

## Codex 0.152 的 hooks 跟 Claude Code 是同一套

實測（`strings` 掃 `/Applications/ChatGPT.app/Contents/Resources/codex`）：

| | 內容 |
|---|---|
| 設定檔 | `~/.codex/hooks.json`（Claude 是 `settings.json` 的 `hooks` 區塊） |
| 事件名 | `PreToolUse` `PermissionRequest` `PostToolUse` `PreCompact` `PostCompact` `SessionStart` `SessionEnd` `UserPromptSubmit` `SubagentStart` `SubagentStop` `Stop` `Interrupt` |
| 結構 | `HookHandlerConfig{description, hooks, matcher}`、`MatcherGroup{matcher, hooks, enabled}` |
| payload 欄位 | `session_id` `transcript_path` `cwd` `hook_event_name` `permission_mode` `agent_transcript_path` **`stop_hook_active`** **`last_assistant_message`** `prompt` `tool_name` `tool_input` |

payload 的欄位名**跟 Claude Code 一字不差**，所以同一支 `ask-with-options.mjs`
兩邊共用，不必維護兩份。（二進位檔裡還看得到 `CLAUDE_PLUGIN_ROOT` 與
從 `settings.json` 遷移的程式碼——這個相容是刻意做的，不是巧合。）

## 唯一的差別：Stop 的「輸出」形狀不同

二進位檔裡的 `hookSpecificOutput*Wire` 只有六種：`PreToolUse`、`PostToolUse`、
`SessionStart`、`SubagentStart`、`UserPromptSubmit`、`PermissionRequest`
——**沒有 `Stop`**。Codex 的 Stop 用的是 `StopCommandOutputWire` +
`BlockDecisionWire`，也就是 `{ decision, reason }`。

Claude Code 這邊實測吃的是 `hookSpecificOutput.permissionDecision = "deny"`。

所以那支 hook **兩種形狀一起吐**，各自忽略不認得的鍵。
只給一種的話，會在另一邊**安靜地不擋**——看起來有守衛，其實沒有。

## 兩個踩過的坑

**一、`$comment` 這個鍵會讓整份設定被丟掉。** schema 是嚴格的
（`unknown field $comment, expected description or hooks`），而 Codex
**只印一行 warning 就繼續跑**：

```
warning: failed to parse hooks config ~/.codex/hooks.json: unknown field `$comment`
```

那一行混在啟動訊息裡很容易略過，而結果是 hook 完全沒掛卻沒有任何東西壞掉。
要寫說明就用 `description` 欄位，長的放這個 .md。

**二、`codex doctor` 不檢查 hooks。** 實測 `0 fail`、輸出裡連 hooks 兩個字
都沒有，而那時候 `hooks.json` 正好是壞的。**要驗就跑一次 `codex exec`
看啟動訊息有沒有那行 warning**，不要拿 doctor 當通過。

## 怎麼重跑這個驗證

```bash
cp ~/.claude/skills/home/claude/hooks/codex-hooks.json ~/.codex/hooks.json
codex exec --sandbox read-only --skip-git-repo-check "只回答一個數字：2+2 等於多少" < /dev/null 2>&1 \
  | grep -i 'hooks config'          # 有輸出＝設定壞了；沒輸出＝解析過了
```

`< /dev/null` 不能省：`codex exec` 在沒有 tty 時會停在
`Reading additional input from stdin...` 等到天荒地老。

hook 真的被呼叫過沒有，看它自己的稽核記錄——這比看畫面可靠，
因為「沒擋」跟「這回合本來就沒違規」長得一樣：

```bash
tail -3 ~/.claude/skills/home/claude/hooks/ask-with-options.log
```

`session` 欄位可以認出是哪一個 session 打的。**這台機器同時有好幾個
Claude Code session 在跑，log 會長，不要看到行數變多就當成是 Codex 寫的**
（2026-09-10 差點這樣誤判：+1 那筆其實是另一個 session）。

## 2026-10-02：從一支擴成 Claude 能搬的全部

安裝改由 `tools/codex-sync.sh` 負責（同時接 skills）。搬了／沒搬的：

| Claude 的 hook | Codex | 理由 |
|---|---|---|
| SessionStart 的 grill／不要停／commit 就 push | 搬（`cat session-start-context.txt`） | |
| `blocks-current.mjs`、`update-check.mjs` | 搬 | 只讀 repo／快取，不吃 transcript |
| PreToolUse git 作者守衛 | 搬（2026-10-20 起跟 Claude 共用 `git-author-guard.mjs`） | |
| `commit-message-guard.mjs` | 搬 | |
| `pr-guard.mjs`、`pushq-guard.mjs` | 搬（2026-10-21） | pr-guard 擋 `--no-verify` 與帶路徑的 git、pushq-guard 擋 `--no-verify` 與 `PUSHQ_*` 環境變數，都是繞過 pre-push 的寫法；直推程式碼由全域 pre-push `pr-prepush.mjs` 擋（Codex 子程序帶 `CODEX_THREAD_ID`，2026-10-21 實測） |
| `kill-guard.mjs` | 搬（2026-10-21） | Codex 在 tmux 裡跟 Claude 的 lane 同住一台機器，`pkill -f` 一樣會殺到別人的程序；只看指令字串，不吃 transcript |
| Stop `lang-guard.mjs` | **沒搬** | Codex 的收尾不是直接給使用者讀的：codex-drive 由 Claude 讀過再改寫成繁體回報；`codex exec` 也沒有 `CLAUDE_CODE_ENTRYPOINT=sdk-*` 可以分辨非互動，擋了會弄壞要英文／JSON 輸出的產線 |
| Stop `ask-with-options.mjs` | 搬 | 本來就有；提示音 2026-10-12 拿掉（背景平行跑的 Codex 每結束一個就叮，疊成連續聲音） |
| `session-journal`／`session-restore`／`context-tier` | **沒搬** | 解析的是 Claude 的 transcript 格式（token 用量欄位），Codex 的 rollout 格式不同，接上去會安靜地算錯 |
| `InstructionsLoaded`、`Notification` | 沒搬 | Codex 沒有這兩個事件 |
| claude-in-chrome 的 `browser_batch` 守衛 | 沒搬 | Codex 沒有那個工具 |

**新 hook 要在 Codex 裡核准一次才會跑**：`config.toml` 的
`[hooks.state."…/hooks.json:<事件>:<群組>:<序號>"] trusted_hash`。沒核准的 hook
**一聲不吭地不跑**（2026-10-02 實測：加了 PreToolUse／SessionStart 的記錄器，
`codex exec` 只觸發了已核准的 Stop）。這個雜湊不要由 agent 代算——那是在繞過使用者的核准。

**還沒驗證的一件事**：Codex 的 shell 工具在 PreToolUse 的 `tool_name` 是不是 `Bash`。
核准之後跑一次會觸發 commit 守衛的指令確認；不是的話改 `matcher`。

## 2026-10-20：改走分派器（hooks 優化 H5）

`codex-hooks.json` 每個事件只剩一條 `node …/dispatch.mjs <事件> codex`，各事件跑哪幾支看
`dispatch.mjs` 的 `CODEX_ROUTES`（清單照搬上表的「搬」，外加 PreToolUse 的 `focus-guard`——
repo 版早就有、裝上去那份漏了）。每個事件從開 2–3 個程序變成 1 個，加一支檢查只改 `CODEX_ROUTES`、
**不用再讓使用者重新核准**（`hooks.json` 的指令沒變，雜湊就沒變）。

- `codex` 這個參數讓分派器改用短清單；PreToolUse 不看 `tool_name`（`hooks.json` 的 matcher 已篩過 `Bash`）。
- Stop 的兩種輸出形狀（`decision`／`hookSpecificOutput`）`merge` 本來就都留著。
- 新舊比對：`node replay-codex.mjs [舊 ref] [天數]`——拿 `~/.codex/sessions` 裡的 `exec_command` 指令與
  `task_complete` 收尾文字，比「舊版逐支呼叫」與「新的分派器」Codex 看得到的決定。
- **換掉指令＝新的 hook，要在 Codex 裡核准一次**（三條：SessionStart、PreToolUse、Stop）：
  互動開一次 `codex`，開場的「Hooks need review」選「Trust all and continue」。agent 不代按（codex-drive 碰到就選
  「Continue without trusting」）。沒核准之前那三條一聲不吭地不跑，`codex exec` 也不會提示。核准後用 `tail -3 ask-with-options.log` 對 `session` 欄位確認有被呼叫。
