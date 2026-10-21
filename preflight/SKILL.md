---
name: preflight
description: 開工前的環境體檢，2 秒跑完。查身分（設定目錄／git 作者／子 session 變數）、設定（settings.json 能不能解析、hook 與 deny 條數、記憶索引）、這台機器（~/Documents 讀不讀得到、控制台、proj doctor）、另外三台機器 ssh 通不通。設定改過之後、或講不出哪裡怪的時候跑，不要再手動打 1+1 試水溫。**這支是不針對症狀的全面體檢**：已經有明確故障症狀用 env-doctor，要動某個 repo 用 recon。
---

# 開工前體檢

```bash
bash ~/.claude/skills/preflight/preflight.sh
```

約 2 秒。所有會等待的檢查（curl、三台 ssh）平行發動。

## 為什麼有這個 skill

分析 2026-07-21～09-02 的 139 個 session：**102 個只有一則訊息，其中約 80 個是
「只回一個數字：1+1」「回一個字：好」「台北今天天氣如何」這種煙霧測試**——
開一個 session 只為了確認環境還活著。

那些測試回答不了真正想知道的事。`1+1` 答對只證明模型在回話，不證明
git 作者是對的、`settings.json` 沒被改壞、控制台還在、遠端機器連得上。

## 它查什麼，以及為什麼查這幾項

每一項都對應一個真的發生過、而且**不會報錯只會怪怪的**的故障：

| 檢查 | 壞掉時的症狀 |
|---|---|
| git 作者 | commit 被 PreToolUse hook 擋下來，做到一半才發現 |
| 子 session 變數 | `CLAUDE_CODE_CHILD_SESSION` 被整棵終端機繼承 → transcript 沒在存 |
| `settings.json` 能否解析 | 壞掉的話權限與 hook **全部靜默失效**，不會有任何錯誤訊息 |
| 記憶索引 | `MEMORY.md` 不見 → 每個 session 都從零開始 |
| `~/Documents` | EPERM（iCloud 同步或 TCC）→ 整棵樹讀不到，`!` 前綴也繞不過 |
| 專案控制台 | 回 500 代表「活著但在噴錯」，跟連不上是兩件事，要分開講 |
| `proj doctor` | 孤兒程序：proj 以為自己管著、其實管的是別人 |
| **文件漂移** | `CLAUDE.md` 提到的檔案已經改名或刪掉 → 照著不存在的架構去改，浪費一整輪 |
| 三台遠端 ssh | 要派工才發現連不上，等於白等 |

> 文件漂移那一項只在**當前目錄有 `CLAUDE.md`** 時才跑，實作在
> `sync-docs/check-paths.mjs`。放在這裡是因為 `sync-docs` 缺的一直是「時機」——
> 三台機器 252 個 transcript、0 次觸發，因為沒有人會開口說「幫我檢查文件」。

## 什麼時候跑

- **設定改過之後**（權限、hook、MCP、換 profile）——這是最該跑的時機。
- 覺得「怪怪的」但講不出哪裡怪。
- 準備把活丟給遠端機器之前。
- 隔了幾天回來繼續一個舊 session。

## 它查不到的

- **Chrome 擴充功能**：那要在瀏覽器裡才驗得到。連不上時先看擴充有沒有登入。
- **「Claude Code 本身活著嗎」**：這個 skill 跑得起來本身就是答案了。

## 改這支腳本的時候

**一定要注入故障實測，不要只看正常環境跑出一排 ✓。** 只會說 ✓ 的健檢比沒有健檢更糟。

寫這支的時候正常路徑一次就過，但注入故障抓到兩個真的 bug：

1. **競態**：`wait` 放在腳本最後，於是讀 `$SP/dash` 時背景的 curl 還沒寫完，
   控制台明明回 200 卻報「連不上」。**謊報故障的健檢比沒有健檢更糟。**
2. **`"$GE（不是…"`**：`$VAR` 後面直接接全形括號時，bash 會把那個多位元組
   字元當成變數名的一部分，配上 `set -u` 就是 `unbound variable` 直接中止。
   這條只在失敗路徑上，正常跑一百次都不會發現。
   → 變數後面接非 ASCII 字元一律用 `${VAR}`。

測法（用改過的副本，不要動真的環境）：

```bash
sed 's|localhost:5250|localhost:59999|' preflight.sh > /tmp/p.sh && bash /tmp/p.sh   # 控制台掛掉
CLAUDE_CONFIG_DIR=/tmp/fakecfg bash preflight.sh                                     # 設定壞掉
(cd /tmp/badrepo && bash preflight.sh)                                               # git 作者錯
```

## Windows

這支是 bash，只在 mac 跑。Windows 那兩台要對應的檢查，用 `proj doctor` 加
`git config user.email`，細節見 `env-doctor/windows.md`。
