---
name: quad
description: 終端機四宮格排版。mac 是 Terminal.app 的自動排版腳本（改格子數、換螢幕、調觸發條件、排查「視窗沒排好／一直冒視窗」、新機器重裝）；Windows 沒有這支腳本，用 Windows Terminal 的分割窗格，做法在 windows.md。
---

# 終端機四宮格

一個畫面四格、每格一個 Claude Code。**兩台機器的實作完全不同**，
mac 有一支自動化腳本，Windows 沒有（刻意的，見下）。

| 平台 | 怎麼做 | 讀哪份 |
|---|---|---|
| macOS | `~/.local/bin/quad`（osascript 排版）＋ `.zshrc` 掛勾，開終端機自動四宮格 | **[macos.md](macos.md)** |
| Windows | Windows Terminal 的分割窗格，手動一行指令，**沒有腳本** | **[windows.md](windows.md)** |

## 哪一格在等你：`quad inbox`（mac，2026-10-06）

每個 session 用 hook 回報狀態；等你回答或做完時那格換等待色（5× 暖色系：等你回答深橙、做完了橄欖金；20× 冷色系：深紫、青綠），
你一送出就恢復。`quad inbox` 列出誰在等、等多久，`quad inbox <n>` 跳過去。細節見 [macos.md](macos.md) 最後一節。

## 多帳號：用 `acct`（2026-10-06）

帳號、設定目錄、底色、Chrome profile 都在帳號清單 `home/claude/accounts/<LocalHostName>.json`。
`acct open <id> 4` ＝ `quad --claude --account=<id>`；`--20x` 保留成 `--account=peter` 的捷徑。
AgentQuota 面板裡各帳號的配額列底下也有同樣的按鈕。細節見記憶 `claude-two-accounts-same-mac`。

## 一個帳號一組四宮格（mac，2026-09-18）

Air 上兩個 Claude 帳號靠 `CLAUDE_CONFIG_DIR` 並存，所以四宮格也分兩組：

| 這組 | 怎麼開 | 帳號 | 底色 |
|---|---|---|---|
| Max 5× | 冷開機時 `.zshrc` 掛勾自動排（`quad --auto --claude`） | `~/.claude`（預設） | Red Sands（暖，2026-10-06 起） |
| Max 20× | **手動打 `quad20`**（＝`quad --claude --20x`） | `~/.claude-work` | Ocean |

**20× 那組刻意是手動的**：新視窗只會開在**當下所在的那個桌面（Space）**，
AppleScript 沒有指定 Space 的能力。要它待在桌面 3，就先切到桌面 3 再打 `quad20`。
自動模式永遠不帶 `--20x`，冷開機那組固定是預設帳號。

**底色是唯一分得出來的記號**——claude 會把終端機標題改成自己的狀態，
標題標不住，只有 Terminal 的設定檔（profile）留得下來。

⚠️ `/login` 是針對**當下那個設定目錄**登入的，在 5× 那組裡打就會蓋掉 `~/.claude`
的憑證。這個坑與鑑識法見 `~/.claude/memory/claude-two-accounts-same-mac.md`。

⚠️ **`quad20` 開出來的四格會先停在「Is this a project you trust?」**——
`~/.claude-work` 的 `hasTrustDialogAccepted` 對 `$HOME` 是 `false`，
而且按過之後也沒寫回檔案，所以**每次都會再問一次**。
沒按下去 claude 不會啟動，而畫面上看起來就只是「四格開好了」。
按法：把每個視窗叫到最前面再 `keystroke return`（預設就停在「1. Yes」）。

半透明是 Terminal 設定檔的屬性，不是視窗屬性，改法見 [macos.md](macos.md) 的
「半透明」那節（**AppleScript 設不動，偏好設定要重開才生效**）。

## 為什麼 Windows 不做一支對等的腳本（2026-08-16 決定）

**`wt` 一行就能開四格，而且已經實測過會動**（見 windows.md）。mac 那支 200 行腳本
裡有一大半在處理 AppleScript 與 NSScreen 兩套座標系統的換算，Windows 這邊沒有那個
問題——分割窗格是 Windows Terminal 自己按比例排的。多寫一支腳本只是多一個要維護、
要驗證的東西。

> **從 mac 驗得到 Windows 的桌面版面**：`schtasks /ru user /it` 可以在桌面
> session 跑東西，腳本裡截圖存檔再 `scp` 回 mac 就看得到結果。四宮格就是這樣驗的。
> （所以「驗不到」不是不做腳本的理由，上面那個才是。）

要改主意就照 macos.md 的兩道閘設計，別重新發明。

## 兩台共通的鐵則

**「每開一個終端機就自動開四個」照字面實作就是 fork bomb**——被開出來的視窗也會跑
啟動檔，4 → 16 → 64。任何自動觸發的版本都要有這兩道獨立的閘：

1. **視窗數 > 1 就結束**（遞迴斷在這裡）
2. **時間鎖**（幾秒 TTL），純粹是保險：計數在競態下判斷錯，最多多開一輪

**不要對既有的視窗下指令。** 打這道指令的視窗常常自己就在跑 Claude Code，
對它送指令等於把那幾個字打進別人的輸入框。寧可多開一個視窗被蓋在後面。

**不要把座標寫死**（mac）／不要固定像素尺寸（Windows）。接不同螢幕、
改 Dock、改工作列都會讓寫死的版面排到不存在的位置。
