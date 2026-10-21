# codex-drive 規格（2026-10-06 grilling 結果，待使用者確認）

## 目標

使用者在 Claude Code 裡說「叫 Codex 做 X」→ Claude 把 X 寫成極致詳細的工作單，
在**背景 tmux 的 Codex 互動畫面**裡交給 Codex 做，盯著它做完、驗收、整理成使用者習慣的
格式回報。使用者不用自己操作 Codex。

要解決的痛點（使用者選的）：
1. **Codex 不照規則做事**（不用選項問、做一半停、不自己驗證）→ Claude 當監工
2. **Codex 的回報很難讀**（格式、簡繁、詳略）→ Claude 改寫後再回報

## 決定（每條都是使用者選的）

| 項目 | 決定 |
|---|---|
| 控制方式 | Codex **互動 TUI**，Claude 代為輸入 |
| 畫面 | 背景 tmux session 跑 Codex，**不開任何視窗**（2026-10-11 改：原本另開 Terminal 視窗，但會跳到最前面搶畫面、還被 quad 重排）；想看就 `tmux attach -t codex-<名>` |
| 核准提示 | 開 Codex **Auto-review**（`approvals_reviewer`／guardian），沙盒維持 `workspace-write` |
| 觸發 | **語意觸發** skill：對話中提到「叫 Codex 做／交給 Codex」 |
| 對話生命週期 | **同一專案接續同一個 Codex 對話**；context 用量 **≥ 50%** 時請 Codex 寫交接摘要 → 關掉 → 用摘要開新對話（省 token） |
| 不合格處理 | 最多**退回 2 次**；第 3 次仍不合格 → 停下用選項問使用者 |

## 流程

1. 解析需求 → 寫工作單（絕對路徑、可執行的驗收指令、明確不做什麼）
2. 找／建該專案的 tmux session（名稱 `codex-<專案名>`）
3. 用 `tmux send-keys` 送工作單；用背景等待（Codex `notify` turn-ended 或 capture-pane 輪詢）等它這一輪結束
4. 驗收：跑驗收指令、看 diff、前端改動要實際渲染看過；對照 AGENTS.md 的規則
5. 不合格 → 退回（附具體理由），最多 2 次
6. 合格 → 讀 Codex 狀態列的 context 用量，≥ 50% 就交接換新對話
7. 用繁體、使用者習慣的格式回報，附上 attach 指令；tmux 留著

## 明確不做

- 不改 Codex 那邊的 hook／skill 行為（使用者沒選這個痛點）
- ~~不用 `codex exec` 無頭模式取代互動畫面~~ → **2026-10-13 改：純產圖／改圖走 `codex exec`**（sprite-gen 的 `generate_sprite_image.py`），互動畫面留給要寫程式的工作。理由：量到互動畫面的工作對話每個 1–6M tokens，一次 exec 約 64K
- `cx start` 會關掉 `worker-skills-off.txt` 列的 skill（用 `-c skills.config`；`-p` profile 實測無效），每次請求省約 2.4K tokens
- 不把所有寫程式工作預設丟給 Codex（只有被叫到才觸發）
- Codex 要密碼／不可逆／花錢／對外發布 → 照樣停下用選項問使用者

## 前置

- `brew install tmux`（目前沒裝）
- 確認 Auto-review 在 config.toml 的正確設定鍵（`guardian_approval` feature 已是 stable/true）

## 我的假設（待確認）

- tmux session 留著直到換新對話或閒置 2 小時自動結束
- Codex 端的 Stop hook（ask-with-options）在被 Claude 驅動時仍保留
