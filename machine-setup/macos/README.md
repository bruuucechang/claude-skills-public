# machine-setup —— 把新機器接進 tailnet

把一台 MacBook Air 接進 tailnet，設定成能連進 **M5 Pro**（18 核 / 48 GB）跑它自己跑不動的東西。

目標用途：批次運算、開發（含 Claude Code）、以及在 Pro 上跑服務讓 Air 呼叫。

## 前置

在 https://login.tailscale.com/admin/settings/keys 產生一把 auth key：

| 欄位 | 設定 |
| --- | --- |
| Reusable | 關 |
| Ephemeral | 關（開了離線就從裝置清單消失） |
| Tags | 留空 |

key 只顯示一次，複製後直接用掉。**不要寫進任何檔案或提交進版控。**

## 安裝

```bash
bash ~/.claude/skills/machine-setup/macos/scripts/setup.sh tskey-auth-xxxxxxxxxxxx
```

> 2026-08-17 起這裡是 `claude-skills` repo 的一部分（原本是獨立的 `air2-bootstrap`）。
> 新機器先照 `BOOTSTRAP.md` 把 `claude-skills` clone 好，這支腳本就在手上了。

會做五件事：裝 Tailscale、加入 tailnet、產 SSH 金鑰、寫 `~/.ssh/config` 的 `Host pro`、檢查可達性。

跑完會印出一行公鑰。把它交給 M5 Pro 加進 `~/.ssh/authorized_keys`，然後：

```bash
bash scripts/verify.sh
```

## 用法

```bash
ssh pro                              # 進去下指令
ssh pro -t 'tmux new -A -s main'     # 斷線不中斷；下次同一行指令接回原本的階段
```

長時間工作一律開在 tmux 裡，否則關筆電或換網路就斷了。

在 Pro 上跑服務要給這台用時，Pro 端執行 `tailscale serve <port>`，只有 tailnet 內連得到。

## 為什麼是這些選擇

**用 100.x 位址，不用 MagicDNS 名稱。** Tailscale 的節點位址綁定節點，除非把裝置從 tailnet 刪除重加否則不變。而 M5 Pro 那端的 MagicDNS 解析不了 —— 它裝的是 brew formula 版 tailscaled，沒有完整 DNS 整合。

**用傳統 OpenSSH，不用 Tailscale SSH。** Tailscale SSH 的伺服器端在 macOS 不支援（`RunSSH` 設得下去，但 `SSH_HostKeys` 始終是空的），所以公鑰還是得手動派送。

**Pro 端的 AC 電源已設為永不睡眠。** 原本是閒置 1 分鐘就睡，當 worker 必改，否則長時間工作會斷在半路。電池模式維持原樣。
