---
name: env-doctor
description: 診斷這兩台機器特有的環境故障——檔案讀不到（EPERM/EACCES/dubious ownership）、埠位打不到、Docker 沒反應、背景服務起不來、grep 找不到明明存在的字、環境變數莫名其妙被繼承（Claude Code 說 transcript 沒在存）。**要有一個講得出來的症狀才用這支**，症狀出現時先跑這個、不要從頭推理。細節分 macos.md 與 windows.md。
---

# 環境診斷

這兩台機器各有一組**會反覆出現、而且症狀會互相偽裝**的環境問題。每一條都踩過不只一次。
遇到症狀時照對應平台那份的判斷樹走，**不要憑症狀猜**——很多組合看起來一樣但成因完全不同。

## 先決定要讀哪一份

| 平台 | 判斷方式 | 讀這份 |
|---|---|---|
| macOS | 環境資訊的 `Platform: darwin`，或 `uname -s` 回 `Darwin` | **[macos.md](macos.md)** |
| Windows | 環境資訊的 `Platform: win32`；從 mac 用 SSH 打過去時是 `ssh victus` 或 `ssh desk` | **[windows.md](windows.md)** |

**不要憑印象混用。** 同一個症狀在兩台上的成因往往完全不同，最容易誤判的三組：

| 症狀 | mac 的成因 | Windows 的成因 |
|---|---|---|
| 檔案讀不到 | TCC 授權／iCloud 同步／launchd 判定，三種 | junction 被標成未受信任、提權搬檔改掉了擁有者 |
| grep 找不到明明存在的字 | grep 把含中文的檔當 binary 靜默跳過（要 `-a`） | 檔案被 `>` 寫成 UTF-16，unix grep 讀不到 |
| 背景排的東西沒跑 | launchd `EX_CONFIG`（78），log 永遠是空的 | SSH 在 session 0，碰不到桌面 session 的視窗 |

## 兩台共通的規則

- **診斷一律用 curl／CLI，不要開 Chrome 分頁。** Windows 上要打 `curl.exe`，
  `curl` 在 PowerShell 5.1 是 `Invoke-WebRequest` 的別名（見 windows.md）。
- **服務打不到先試三種位址**（`localhost`、`127.0.0.1`、`[::1]`）。兩台都有
  IPv4/IPv6 分裂的前科，而且兩個方向都咬過人。
- **不要用「重的存活檢查」去測 Docker**——mac 上 `docker info` 在 daemon 沒跑時會卡兩分鐘。
- **先確認是不是誤報**再動手殺程序。一個埠上兩個 pid 常常是父子共用 socket，
  殺下去會殺掉自己剛起好的服務。

## 收尾

診斷完如果發現的是新的成因，寫回**對應平台那一份**（只有兩邊都成立才寫在這裡），
並在對應專案的 CLAUDE.md 留一句。

相關記憶檔在 `~/.claude/memory/`：`icloud-documents-eperm`（mac）、
`windows-machine`（Windows）、`projctl`（兩台都有）。
