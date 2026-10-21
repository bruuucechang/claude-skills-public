# claude-skills-public

一套 Claude Code 的 skills、全域規則（`AGENTS.md`）與 hooks，從作者每天在用的私人設定匯出。
內容是繁體中文。支援 macOS 與 Linux；Windows 沒有驗證過。

## 安裝

需要 `git`、`node` 20 以上、`jq`。

```bash
git clone https://github.com/bruuucechang/claude-skills-public.git ~/claude-skills
bash ~/claude-skills/install.sh
```

腳本會問你三件事，也可以用參數直接給：

```bash
bash ~/claude-skills/install.sh --owner <GitHub 帳號> --email <信箱>[,<信箱>] --lang none --yes
```

它做的事（重跑是安全的）：

1. 寫 `home/claude/config.json`，hooks 從這裡讀你的設定。
2. 把每個 skill 連進 `~/.claude/skills/<名字>`。同名的目錄已經存在就跳過，不會覆蓋。
3. 把 `AGENTS.md`、`CLAUDE.md`、`rules`、`commands` 連進 `~/.claude`。原本有的先備份成 `*.bak-<時間>`。
4. 把 hooks **合併**進 `~/.claude/settings.json`。先備份，你原本的設定與 hooks 都會保留。
5. git 2.55 以上時，在**全域 git 設定**加 `hook.pr-guard.*`：agent 推 `github_owner` 的 repo 時，擋它直推目標分支（要走 `pr/` 分支開 PR）。git 太舊就不裝，pr-guard 也跟著關。

有設 `CLAUDE_CONFIG_DIR` 的話，裝到那個目錄而不是 `~/.claude`。
裝完開一個新的 claude session 才會生效。

解除安裝：`bash ~/claude-skills/install.sh --uninstall`。它會移除連結、hooks 與全域 pre-push，但被備份的原檔不會自動還原。

## 設定（`home/claude/config.json`）

| 欄位 | 作用 | 沒設時 |
|---|---|---|
| `github_owner` | `pr-guard` 擋 agent 直推這個帳號 repo 的目標分支；`update-check` 只看這個帳號的 repo | 不擋、不查 |
| `pr_guard` | install.sh 依 git 版本寫入；`false` 時 pr-guard 整支不動作 | 動作 |
| `pr_guard_exempt` | 允許 agent 直推的 repo（`owner/name`），例如自動匯出的鏡像 | 沒有例外 |
| `git_name` | 擋 commit 時提示的修正指令會用到 | — |
| `git_emails` | `git-author-guard` 只放行這些信箱的 commit | 不檢查 |
| `language` | `"zh-TW"`：回報以英文為主就要求用繁中重寫 | 不檢查 |

範例在 `home/claude/config.example.json`。

## 裡面有什麼

**Skills**

| skill | 做什麼 |
|---|---|
| `blocks` | 把剩下的工作切成一個 session 做得完的區塊，一次做一塊 |
| `handoff` | 寫交接單，讓下一個 session 不用重問就能接著做 |
| `recon` | 動 repo 之前先確認現況（別的 session／機器可能跑在前面） |
| `ship` | 跑測試、核對作者、只 add 自己的檔，然後 commit、push、驗證 |
| `sync-docs` | 核對 CLAUDE.md／README 跟實際程式碼還對不對得上 |
| `inspect-ui` | 前端改完，把畫面真的渲染出來掃一遍 |
| `newproj` | 開新專案：三層骨架加三道守衛（沒有 `proj` 也能照手動步驟做） |
| `env-doctor` | macOS／Windows 上常見、症狀互相偽裝的環境故障 |
| `grilling`／`grill-me` | 一題一題追問，把計畫問到底 |
| `codex-drive` | 在背景 tmux 驅動 Codex CLI |
| `dataviz`、`tufte-viz` | 圖表與圖解；`tufte-viz` 是 MIT 授權的第三方 skill，出處見它的 `ORIGIN.md` |

**Hooks**（`home/claude/hooks/`）：每個事件只開一個 `node`，由 `dispatch.mjs` 分派給各個檢查。
例如擋錯的 git 作者、擋 commit 訊息被殼層吃字、擋 agent 用 `--no-verify` 跳過檢查、提醒問句要給選項。
每支檢查各有一個 `test-*.mjs`：

```bash
for t in ~/claude-skills/home/claude/hooks/test-*.mjs; do node "$t" >/dev/null || echo "FAIL $t"; done
```

**規則**：`home/claude/AGENTS.md` 是作者自己的工作規則，`CLAUDE.md` 用一行 `@AGENTS.md` 匯入它。
這份是寫給作者自己的，照你的習慣改。裡面的 `[[名字]]` 原本連到作者的記憶檔，公開版沒有這些檔，會找不到。

## 不在這裡的東西

- 作者的記憶檔、帳號設定、本機排程，以及原始的 `settings.json`。
- 只適用作者機器的部分：多機派工、終端機排版、iTerm 與多帳號切換。所以 `handoff` 裡「自動在新分頁接手」那一段在這裡用不了，手動開新 session 讀交接單就好。
- 外來的 skill：清單在 `install-external.sh`，要的話自己跑。

這個 repo 是自動匯出的快照，沒有 git 歷史，也不收 PR。
