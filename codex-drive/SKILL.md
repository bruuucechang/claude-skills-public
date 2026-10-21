---
name: codex-drive
description: 使用者說「叫 Codex 做／交給 Codex／讓 Codex 寫／用 Codex 產圖」時使用。Claude 在背景 tmux 裡驅動 Codex 互動畫面（不開視窗、不搶使用者畫面）：寫工作單、送出、背景等它做完、驗收（不合格最多退回 2 次）、改寫成繁體回報；context 用到 50% 就交接換新對話。沒有被明確叫到 Codex 時不要用。
---

# codex-drive：在這裡下指令，Claude 驅動 Codex

規格與每項決定的來由見 `SPEC.md`。工具是同目錄的 `cx.py`（下文 `cx` = `python3 ~/.claude/skills/codex-drive/cx.py`）。

## 產圖：開工前先把規格問清楚（AGENTS.md 規定）

每張圖都吃 Codex 週額度，猜錯就是白燒（見 [[imagegen-quota-precision]]）。送出前用 `AskUserQuestion`
**一次一題**問到下面每項都有答案；能從專案檔案查到的自己查，不要問：

1. 用途與放哪裡（哪個專案、哪個檔名、給什麼畫面用）
2. 尺寸／比例、要不要去背、檔案格式
3. 風格與參考圖（最多 5 張，超過要拼成一張設定表，見 [[codex-imagegen-5-refs]]）
4. 是編輯就問：**只改哪裡、哪些逐像素不准動**
5. 張數（預設 1 張，不要撒候選）
6. 怎樣算合格（解剖檢查見 [[generated-image-anatomy-check]]）

問完把規格寫進工作單，給使用者確認一次再送。交圖前先在本機確認合成／切層沒問題，
使用者說「畫錯」時先查是不是自己的程式造成的，再決定要不要重畫。

## 產圖走哪條路（2026-10-13 裁示）

**純產圖／改圖 → 一張一次的 `codex exec`，不開互動畫面。** 量到的價差：互動畫面的工作對話
每個累積 1–6M tokens，一次 exec 約 64K。現成的指令就是 sprite-gen 的產圖層：

```bash
R=~/.claude/skills/sprite-gen
$R/.venv/bin/python $R/scripts/generate_sprite_image.py --provider codex \
  --prompt-file <提示詞.txt> --out <輸出.png> --ref <參考圖1> --ref <參考圖2> [--transparent]
```

- **一定寫 `--provider codex`**：不寫的話 codex 不能用時會換成 grok，雖然有印出來，但額度與風格都不同。
- 參考圖最多 5 張（[[codex-imagegen-5-refs]]）；多張就平行跑，最多 4 個（sprite-gen 實測不會被限流）。
- 整列動畫照 sprite-gen 自己的流程（`/sprite-gen`），不要自己拼。
- 要寫程式才能完成的美術工作（切層、接進遊戲、批次改一整套）才用下面的互動畫面流程，
  而且工作單要規定：**最後只輸出一張對照表**（全部成品排在一張 PNG，標上檔名），
  中途不要一張一張讀圖檢查；我只看那一張驗收。量到的：一天 228 次讀圖，context 漲到 57%。

## 流程（一次做到完，中間不回頭問使用者）

1. **寫工作單**到 scratchpad 的 `.md`：目標、絕對路徑、**可執行的驗收指令**、明確不做什麼、
   最後一行固定加「做完自己跑驗收指令；不要中途停下來問我；用繁體中文回報做了什麼、驗收輸出是什麼」。
   對面沒有這裡的上下文，模糊的工作單＝它自己亂猜。
   **點名它要先讀的 `docs/`**：Codex 只讀專案 `AGENTS.md` 的前 32 KiB，長段落搬去 `docs/` 之後它不會自己讀
   （animyria 做玩法工作 → `docs/gameplay-spec.md`）。`cx start` 偵測到 `AGENTS.md` 超過 32 KiB 會印 `!!`，照做法拆掉再派。
   **Codex 是小弟，不一定讀得到我的 rules／記憶**（2026-10-12 使用者：「他讀不到沒關係，你控制好就行」），
   所以工作單一律附上這段固定規則：繁體中文；不開會搶畫面的視窗或瀏覽器分頁（要看畫面用 `dev-browser --headless`）；
   不 commit、不 push、不開 PR（改動留在工作區，我驗收後用 `/ship` 走 PR；Codex 的 commit 留在共用 checkout 會被別人直推帶出去，2026-10-20）；不碰工作單沒點名的檔與專案 `CLAUDE.md` 的不准重構區；
   不跑會對外請求或花錢的指令（工作單明列的除外）。
2. `cx start <專案目錄>` → 印出 session 名（`codex-<目錄名>`）。同專案再叫一次會接續同一個對話。
   第一次進某個目錄 Codex 會問「Trust this folder?」：是使用者自己的專案就 `cx keys <名> Enter`；
   不是他的 repo（見 [[only-my-own-repos]]）就先用選項問。按了信任會永久寫進 `~/.codex/config.toml`；
   暫存目錄用完 `cx kill` 後把那條 `[projects."<目錄>"]` 刪掉（2026-10 累積過 141 條失效紀錄，見 hooks 規格附錄 J／K）。
   開場跳「Hooks need review」：**不准代他按 Trust**（核准 hook 是他的事，見 `home/claude/hooks/codex-hooks.md`）；
   選「Continue without trusting」繼續做，回報時請他自己開一次 Codex 按「Trust all and continue」。
3. `cx send <名> <工作單>`，接著 **`cx wait <名> 3600` 用 `run_in_background`**，不要前景等。
4. `wait` 回來後：
   - exit 4＝這一輪帶錯誤結束（看 `!! 錯誤`），exit 2＝Codex 崩潰，exit 3＝逾時 → 看印出的畫面判斷，常見是卡在提示（`cx screen`／`cx keys`）
   - exit 5＝暫時性錯誤（`Selected model is at capacity` 這類）→ 等 1–2 分鐘送一行「繼續」再 `wait`，**不算退回次數、不用問使用者**
   - exit 6＝停滯：送出 2 分鐘還沒開始，或 rollout 15 分鐘沒寫入 → 看印出的畫面；卡在提示就照第 2 步處理，只是長指令在跑就再 `wait`
   - 印出 `!! 錯誤：…usage limit…` → 額度用完，**直接告訴使用者重置時間，不要重試**
5. **驗收**：自己跑驗收指令、`git diff` 看它改了什麼、前端改動照全域規則實際渲染看。
   對照 AGENTS.md：有沒有做一半、有沒有沒驗證就說完成、有沒有改範圍外的檔。
6. 不合格 → 寫一份「哪裡不對、具體證據、要它怎麼修」的退回單再 `send`＋`wait`。
   **最多退回 2 次**；第 3 次還不合格就停下，用 `AskUserQuestion` 問使用者（例：我自己修／再給 Codex 一次／先擱著）。
7. 合格 → 看 `wait` 印的 context %。**≥ 50%**：送「寫一份交接摘要到 `<專案>/scratchpad/codex-handoff.md`
   （目前狀態、決定過的事、還沒做的事）」→ `wait` → `cx kill <名>`；下次 `start` 時工作單第一行叫它先讀那份摘要。
8. **回報**：用繁體、照使用者的格式重寫，不要貼 Codex 原文。要寫：做了什麼、驗收指令與結果、
   退回過幾次與原因、context %、我做了哪些假設。回報附上 `tmux attach -t <名>` 讓他想看時自己看（tmux 留著，閒置 2 小時自動結束）。

## 硬規則

- Codex 要密碼／不可逆／花錢／對外發布 → 停下用選項問使用者，不要替它按。
- 一般核准提示交給 Auto-review（`~/.codex/config.toml` 的 `approvals_reviewer = "auto_review"`）；
  畫面若仍卡在核准提示，判斷屬於上一條就問，否則依 [[auto-click-prompts]] 代按。
- Codex 改的東西由 Codex 負責；commit／push 由我在驗收後用 `/ship` 做（程式碼走 PR），只 add 這次任務動到的檔。
- **不開任何視窗**（2026-10-11 裁示：工作不准搶畫面）；不要開瀏覽器分頁。要給他看的東西用 `bgopen`。
