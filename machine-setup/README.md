# machine-setup —— 把一台新機器接進來

「接機」跟 `bootstrap.sh` 是兩件事，不要混：

| | 管什麼 |
|---|---|
| `bootstrap.sh`（repo 根目錄） | **這台機器自己的** Claude 設定——建 symlink、檢查依賴 |
| `machine-setup/` | **這台機器跟其他機器的連線**——tailnet、SSH、免密碼指揮 |

## 依平台分

| 平台 | 目錄 | 做什麼 |
|---|---|---|
| macOS | [`macos/`](macos/) | 把一台 MacBook 接進 tailnet，設成 M5 Pro 的 client |
| Windows | [`windows/`](windows/) | 把一台 Windows 桌機設成可被 SSH 指揮的 worker |

兩支的共通設計：**機器資訊全部從參數傳進去**——沒有 IP、沒有主機名、沒有帳號、
沒有金鑰寫死在檔案裡。所以這兩個目錄本身不含任何機密。

機器本身的身分事實（IP、規格、金鑰怎麼派、ssh 別名）**不寫在這裡**，在記憶檔
`windows-machine`／`m5pro-machine`／`desk-kr4toia`。**這裡寫流程，記憶檔寫身分。**
派工與盯梢的流程在 `worker/` skill。

## ⚠ Windows 那支現在要先有 GitHub 認證才拿得到

`win-worker-bootstrap` 2026-08-16 建立時**刻意是公開的**，理由是新機器上還沒有
任何 GitHub 認證，private repo 在那個當下 clone 不下來。2026-09-02 轉 private 併進來、
2026-09-03 **從 GitHub 刪除**，**那個性質就沒有了，而且舊 URL 也回不來了**。

所以在一台全新的 Windows 上，`git clone` 這條路走不通（沒有認證），要改用下面
任一種把 `windows/scripts/` 弄過去：

| 方法 | 怎麼做 |
|---|---|
| **瀏覽器下載**（最省事） | 在那台機器的瀏覽器登入 github.com → `claude-skills` → Code → Download ZIP |
| **從指揮端推過去** | 已經接得上的話：`scp -r machine-setup/windows/scripts user@<ip>:C:/Users/user/` |
| **直接貼** | `setup.ps1` 不長，用 `Set-Clipboard` 從指揮端送過去再貼進檔案 |

> 這是收攏 repo 換來的代價，記在這裡免得下次在一台空機器前面才發現。
> 這個 repo 本身**不能**轉公開——裡面有記憶檔與 dotfiles。真要恢復
> 「零認證可取得」，只能把 `windows/` **重新推成一個新的公開 repo**；
> 舊的 `win-worker-bootstrap` 已經刪掉，那個 URL 拿不回來了。

## 用法

### macOS

```bash
bash ~/.claude/skills/machine-setup/macos/scripts/setup.sh tskey-auth-xxxxxxxxxxxx
bash ~/.claude/skills/machine-setup/macos/scripts/verify.sh
```

auth key 從 <https://login.tailscale.com/admin/settings/keys> 產生，Reusable 關、
Ephemeral 關。**key 只顯示一次，不要寫進任何檔案或提交進版控。**

### Windows

在那台機器上，用「以系統管理員身分執行」的 PowerShell：

```powershell
cd <解壓縮或 scp 過去的位置>
.\scripts\setup.ps1 -PublicKey "ssh-ed25519 AAAA... me@mac" `
                    -GitUserName "bruce" -GitUserEmail "you@example.com"
.\scripts\verify.ps1
```

公鑰在指揮端 `cat ~/.ssh/id_ed25519.pub` 整行複製。**貼過去的是 `.pub`，不是私鑰。**
第一次跑之前建議先 `-DryRun` 看一遍。其餘選項見 [`windows/README.md`](windows/README.md)。
