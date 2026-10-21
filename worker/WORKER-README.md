# 給未來的 worker 機器

**這份是要交到新機器手上的**（`scp` 過去，或直接叫那台機器上的 Claude session 讀）。
指揮端的流程在 [SKILL.md](SKILL.md)／[enlist.md](enlist.md)，那幾份是給 Air 看的，
**這份是給你看的**。

---

## 你在這個架構裡是誰

| | |
|---|---|
| **指揮端** | 一台 MacBook Air（M4 / 16 GB）。所有工作從那裡發起 |
| **你** | worker。跑那台跑不動、或只有你能跑的東西 |
| **溝通方式** | SSH。指揮端會 `scp` 檔案給你、下指令、讀你的輸出檔與 transcript |

**你不是對等的開發機。** 除非被明確指派，不要主動改共用的 repo 然後推上去——
指揮端與另外兩台機器隨時可能正在改同一份程式碼。

---

## 一、夠不夠格

| 條件 | 為什麼 |
|---|---|
| **記憶體比 Air 的 16 GB 多**，或有 Air 沒有的東西（OS、GPU、某個只能在那裡跑的軟體） | 兩邊差不多的話，丟過來的成本（傳檔、環境差異、看不到畫面、收尾）會大於省下的時間 |
| **磁碟空間足夠且說得出數字** | 服務類工作動輒幾十 GB（例如自架 Nominatim 要 50–80 GB） |
| **可以長時間開著，而且不會睡著** | 睡著的 worker 等於不存在 |
| **網路位址是穩定的** | DHCP 租約會變號，見第二節 |

## 二、網路：兩條路，先選一條

| | 區網 | Tailscale |
|---|---|---|
| 位址 | `<主機名>.local`（Bonjour） | `100.x` |
| 適合 | 一直待在同一個地方 | 會移動、或跨網段 |

**不要讓指揮端把 DHCP 的 `192.168.x.x` 寫死進設定**——那是租約，重開機或到期就變號。
區網就用 Bonjour 名稱，tailnet 就用 `100.x` 位址。

> macOS 上若用 brew formula 版的 `tailscaled`：**沒有完整 DNS 整合，MagicDNS 解析不了**，
> 只能用 `100.x`。也**不要開 Tailscale SSH**——伺服器端在 macOS 不支援
> （`RunSSH` 設得下去但 `SSH_HostKeys` 始終是空的），公鑰照樣要手動派。用傳統 OpenSSH。

## 三、必做的六件事

1. **SSH server 開起來、公鑰放好**（細節看第四節你那個平台的部分）
2. **電源設成不會睡**（macOS：接電源時永不睡眠）
3. **`git` 的作者身分設對**——這批 repo 有一票舊 commit 因為身分錯而連不到 GitHub 帳號。
   每個 repo 各自設，新 clone 不會自動帶
4. **GitHub 認證能動**（macOS 用既有金鑰；Windows 那台走 per-repo deploy key，
   因為帳號層級金鑰需要的 scope 拿不到）
5. **裝好會用到的**：`claude`（要派 Claude Code 工作的話）、`tmux`（macOS 的長工靠它）、
   Docker（要跑服務的話）、`git`、`node`
6. **記下你自己的實際狀況**回報給指揮端：規格、位址、`claude`／`python`／`docker` 的
   **實際路徑**（每台都不一樣）、有沒有 GUI 可用

## 四、你這個平台特有的靜默失敗

**這一節的每一條都「看起來成功了」，錯誤要到很後面才浮出來。**

### Windows

- `Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0` 會回
  **`RestartNeeded : True`**——元件裝好了但 `sshd` **要重開機才註冊**。
  串在後面的指令會全部報「找不到服務」，看起來像安裝失敗。**線索在它自己的輸出裡。**
- 帳號是系統管理員的話，公鑰要放
  `C:\ProgramData\ssh\administrators_authorized_keys`（`Match Group administrators`
  會把 `~/.ssh/authorized_keys` **完全忽略**），而且**ACL 太寬 sshd 會靜默不採用**，
  症狀是一直問密碼。
- **junction 一定要用提權的程序建**，否則會變成讀不到的掛載點。
  `mklink /J` 回報成功、`dir /al` 也列得出來，**只有實際去讀才炸**。建完一定要實讀一次。
- **SSH 進來的預設殼層是 `cmd.exe`，`cd` 不換磁碟機**——要 `cd /d D:\...`。
  少了 `/d` 會在 `C:\Users\<你>` 底下跑 git，回 `not a git repository`，看起來像 repo 不見了。
- **編碼三坑**（PowerShell 5.1，主控台碼頁 950）：
  `Get-Content` 預設用 ANSI 讀，UTF-8 的中文會全毀（要 `-Encoding UTF8`）；
  `>` 重導向產生 **UTF-16**，unix 的 grep 讀不到；
  `Out-File -Encoding utf8` 帶 BOM，**那種檔給 bash 執行會炸**。
  要給 bash 吃的檔案用 `[IO.File]::WriteAllText($p,$t,(New-Object Text.UTF8Encoding($false)))`，
  或請指揮端在他那邊寫好再傳過來。
- **SSH 是 session 0，桌面是 session 1，碰不到彼此的視窗。** 要動 GUI 只能走
  `schtasks /ru <你> /it`，而且那支腳本要寫**純 ASCII**、自己寫 log 檔。
- 家用版沒有 RDP 被連端（3389 永遠關著）。

### macOS

- 預設**閒置就睡**，要設成接電源時永不睡眠。
- 長時間工作開在 tmux 裡：指揮端會用 `ssh <你> -t 'tmux new -A -s main'`，
  所以 `tmux` 要裝。
- 若那台有 iCloud 同步「桌面與文件」，**不要把工作目錄放在 `~/Documents` 底下**——
  同步會把檔案抽走，症狀是整棵樹突然讀不到（`Operation not permitted`）。
- 終端機 app 的「完全取用磁碟」授權**綁在 process 上**，授權後要整個 app 重開才生效。

## 五、當 worker 期間的規矩

1. **沒有下一輪。** 指揮端派 headless 工作（`claude -p`）時，**沒有人可以回答你的問題**。
   需要什麼就同步跑完，不要說「稍後繼續」——那個「自動繼續」不存在，說了就等於沒做完。
2. **結果要能被找到。** 寫進指定路徑，最後印一個約好的標記（例如 `DONE`），
   指揮端靠它判斷你做完了。長工要自己寫 log，因為排程工作／背景程序的 stdout 沒地方去。
3. **別人的改動不要動。** 工作區裡有不是你做的未提交改動，**留著並回報**，
   不要 `git add .`、不要 checkout 掉。
4. **不要對外開埠。** 跑起來的服務多半沒有認證，只綁區網／tailnet，不要往公網開。
5. **收尾是你的責任**：排程工作、暫存檔、你開的程序與視窗、你起的容器，同一輪清掉。
   要留著的（長跑服務）就明講留了什麼。
6. **回報用繁體中文**，並附上可驗證的東西：實際跑過的指令、輸出的前幾行、檔案路徑與大小。
   「應該可以了」不算回報。
7. **改到機器狀態的事要講**：裝了什麼、改了哪個設定、開了哪個埠。

## 六、自我驗收：跑一次，把輸出貼回去

### macOS

```bash
echo "=== 身分 ==="; hostname; sw_vers -productVersion
echo "核心 $(sysctl -n hw.ncpu) · 記憶體 $(( $(sysctl -n hw.memsize) / 1073741824 )) GB"
echo "=== 位址 ==="; ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1
tailscale ip -4 2>/dev/null || echo "(無 tailscale)"
echo "=== 工具 ==="; for t in git node claude tmux docker python3; do printf '%s=%s\n' "$t" "$(command -v $t || echo MISSING)"; done
echo "=== git 身分 ==="; git config --global user.name; git config --global user.email
echo "=== 電源（sleep 要是 0 或 prevented）==="; pmset -g | grep -E '^ (sleep|disksleep)'
echo "=== 磁碟 ==="; df -h / | tail -1
```

### Windows

```powershell
Write-Output "=== 身分 ==="; hostname; (Get-CimInstance Win32_OperatingSystem).Caption
Write-Output "=== 位址（只列真的網卡）==="
Get-NetIPAddress -AddressFamily IPv4 |
  Where-Object { $_.PrefixOrigin -in "Dhcp","Manual" } |
  Select-Object IPAddress, InterfaceAlias | Format-Table -AutoSize
Write-Output "=== 工具 ==="; foreach($t in "git","node","claude","docker","python"){ "$t=" + $(if($c=Get-Command $t -EA SilentlyContinue){$c.Source}else{"MISSING"}) }
Write-Output "=== git 身分 ==="; git config --global user.name; git config --global user.email
Write-Output "=== sshd ==="; (Get-Service sshd -EA SilentlyContinue).Status
Write-Output "=== 磁碟 ==="; Get-PSDrive -PSProvider FileSystem | Select-Object Name,@{n='FreeGB';e={[int]($_.Free/1GB)}} | Format-Table -AutoSize
Write-Output "=== 殼層與編碼 ==="; $PSVersionTable.PSVersion.ToString(); chcp
```

**位址那段一定要過濾。** 不過濾會列出一堆 `169.254.x`（APIPA）與 WSL／Hyper-V 的
虛擬網卡位址——實測那台一次吐出九個位址，真正能連的只有一個。`InterfaceAlias`
是拿來認出哪個是真網卡的（`Wi-Fi`／`乙太網路` 才是，`vEthernet (WSL ...)` 不是）。

**這段若存成 `.ps1` 檔跑，要存成帶 BOM 的 UTF-8**（裡面有中文），否則 PowerShell 5.1
會用 big5 讀、把引號吃掉，症狀是整支腳本一行都沒跑。從 SSH 跑的話前面再加一行
讓輸出看得懂：

```powershell
chcp 65001 > $null; [Console]::OutputEncoding = [Text.UTF8Encoding]::new()
```

**指揮端還會從他那邊驗一次**（免密碼進得來、檔案傳得進來也讀得回去）。
兩邊都過了才算接好。

> 上面兩段 2026-08-17 都在現役機器上實跑過（Air 與 BRUCEVICTUS），輸出格式如實。

## 七、出事的時候

| 症狀 | 先看哪裡 |
|---|---|
| 連不上、金鑰被無視、junction 讀不到、中文亂碼、埠打不到 | `env-doctor` skill（分 `macos.md`／`windows.md`） |
| 派工的東西靜靜死掉、輸出檔 0 bytes | `worker/dispatch.md` 的 A1（SSH 一斷，遠端程序被帶走） |
| 不知道遠端那個 session 在幹嘛 | `worker/watch.md`（讀 transcript，不要靠截圖） |

**回報的時候把症狀原文貼回去**，不要只說「不能用」——這幾條的成因彼此偽裝，
少了原文就只能重猜一輪。
