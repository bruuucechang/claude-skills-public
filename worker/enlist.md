# 接一台新機器當 worker

`worker` 的第一階段。派工看 [dispatch.md](dispatch.md)，監看看 [watch.md](watch.md)。

順序是刻意的：**每一步都要驗過才走下一步**。這條線上失敗的方式幾乎都是靜默的——
看起來成功了，錯誤要到很後面才浮出來。

**第 0 步：把 [WORKER-README.md](WORKER-README.md) 送過去。** 那份是 worker 端的
注意事項與自我驗收清單，讓對面先自己跑一遍，比你隔著 SSH 一項一項問快得多：

```bash
scp ~/.claude/skills/worker/WORKER-README.md <host>:<路徑>
# 對面若有 Claude Code，叫它讀那份並把第六節的自我驗收輸出貼回來
```

---

## 0. 兩條路都要有，不是二選一（2026-09-16 修正）

原本這節寫的是「先決定走區網還是 tailnet」，結果是兩台 Windows 只有區網、
**不在家就完全派不了工，而且沒有任何跡象**——`ssh victus` 只會說連不上。
現在三台 worker 都是兩條路，別名成對：`pro`／`pro-ts`、`victus`／`victus-ts`、`desk`／`desk-ts`。

| | 區網（不帶 `-ts`） | Tailscale（帶 `-ts`，`100.x`） |
|---|---|---|
| 好處 | 不依賴 tailnet 活著 | 換網路、不同地點都連得到 |
| 代價 | 換 Wi-Fi 就斷 | 要裝 tailscaled、要登入一次 |
| 什麼時候用 | **預設用這條** | 前一條連不上時 |

在家時 tailnet 那條也是直連打洞（實測 `direct 192.168.1.147:41642`），不會比較慢。

**兩種都不要在 `~/.ssh/config` 裡寫死 IP。** 區網那條用 Bonjour 名稱
（`<主機名>.local`），tailnet 那條用 `100.x` 位址。

> M5 Pro 上裝的是 brew formula 版 `tailscaled`，**沒有完整 DNS 整合，MagicDNS
> 解析不了**，所以那台反而只能用 `100.x`。這是實測結論，不要「改回」用名稱。

### Windows 加進 tailnet（2026-09-16 兩台都這樣做的，不必 auth key）

```powershell
winget install --id Tailscale.Tailscale --source winget --silent `
  --accept-package-agreements --accept-source-agreements --disable-interactivity
```

從 SSH 跑就行（那兩台的 ssh session `IsInRole(Administrator)` 是 True），
裝完是**正規服務 + TUN 介面**，不是 M5 Pro 那種 userspace 模式，所以兩個方向都直連、
不必穿 SOCKS5。接著：

```powershell
& "$env:ProgramFiles\Tailscale\tailscale.exe" up --unattended --hostname=<節點名>
```

- **`--unattended` 不能省**：沒有它，沒人登入 Windows 桌面時連線會斷，
  而 headless worker 正好永遠沒人登入。驗收看 `tailscale debug prefs` 的
  `"ForceDaemon": true`，還有 `Get-Service Tailscale` 的 `StartType=Automatic`。
- `up` 會停在那裡等你點登入 URL，所以**丟到背景再撈 log**：
  `Start-Process ... -RedirectStandardOutput C:\Windows\Temp\ts-up.log`，睡 12 秒再讀。
  **desk 這樣撈不到（log 是空的），改用 `tailscale login` 並把等待拉到 20 秒才印出來。**
- 登入 URL 開出來的頁面要核對**兩件事再按 Connect**：tailnet 是不是
  `you@example.com`、裝置名是不是你要的那個。按錯 tailnet 是安靜的。
- 最後把 tailnet 位址的 host key 加進 `known_hosts`，而且**要跟區網那條已經信任的
  指紋比對過**再加（同一台機器三把金鑰應該完全一樣），不要用 `accept-new` 帶過。

Tailscale 的 auth key（https://login.tailscale.com/admin/settings/keys ，
Reusable 關／Ephemeral 關／Tags 留空）**讓使用者自己用 `!` 前綴跑**，不要請他貼進對話——
接機腳本本來就會需要他的密碼（`sudo installer`），一起跑掉最乾淨。
（2026-09-16 那兩台是走瀏覽器登入，沒用到 auth key。）

---

## 1. SSH 連得進去

### macOS worker

系統設定開「遠端登入」，公鑰進 `~/.ssh/authorized_keys`。接 M5 Pro 那次用的是 **`~/.claude/skills/machine-setup/macos/scripts/setup.sh`**
（2026-08-17 前是獨立的 `air2-bootstrap` repo）。它會沿用既有的
`~/.ssh/id_ed25519`**不覆蓋**，所以 GitHub 與其他機器的信任不受影響。

**不要用 Tailscale SSH**：伺服器端在 macOS 不支援，`RunSSH` 設得下去但
`SSH_HostKeys` 始終是空的，公鑰照樣要手動派。用傳統 OpenSSH。

**電源**：預設閒置就睡，睡著的 worker 等於不存在。M5 Pro 已設成接 AC 時永不睡眠。

### Windows worker

**有腳本了，不要再手動做一次**——在 `~/.claude/skills/machine-setup/windows/scripts/`。

> 2026-09-02 之前它是獨立的**公開** repo `win-worker-bootstrap`，刻意公開是因為
> 新機器上還沒有 GitHub 認證。同日三個 repo 一起轉 private 並把它 subtree 併進來，
> **所以 `git clone` 這條路現在走不通了**——第一步改成把 `scripts/` 弄過去：
> 瀏覽器登入 github 下載 ZIP、或從指揮端 `scp -r machine-setup/windows/scripts user@<ip>:C:/Users/user/`。

```powershell
cd <剛才放 scripts 的位置>
.\scripts\setup.ps1 -PublicKey "<Mac 的 id_ed25519.pub 整行>" -GitUserName "<名字>" -GitUserEmail "<信箱>"
.\scripts\verify.ps1
```

要在**提權的 PowerShell** 裡跑，第一次通常要跑兩次（OpenSSH 裝完要重開機）。
`-DryRun` 可以先看它會做什麼。它一次做完 OpenSSH、防火牆、公鑰與 ACL、不休眠、
winget 裝 git/node/python/Docker、git 身分。**它不裝 Tailscale 也不裝 claude。**

下面是那支腳本在處理的事，手動接或除錯時要知道：

```powershell
Add-WindowsCapability -Online -Name OpenSSH.Server~~~~0.0.1.0
```

**它會回 `RestartNeeded : True`——元件裝好了但 `sshd` 服務要重開機才註冊。**
用 `;` 串在後面的指令會在那之前就跑掉、全部報「找不到服務」，看起來像安裝失敗。
**線索在 `Add-WindowsCapability` 自己的輸出，不在錯誤訊息裡。**

帳號是系統管理員的話（BRUCEVICTUS 的 `user` 是），公鑰要放
`C:\ProgramData\ssh\administrators_authorized_keys`——`sshd_config` 的
`Match Group administrators` 會把 `~/.ssh/authorized_keys` **完全忽略**。
而且那個檔的 ACL 必須只給 Administrators 與 SYSTEM，**太寬 sshd 會靜默不採用**，
症狀是一直問密碼。

驗收：

```bash
ssh -o BatchMode=yes -o ConnectTimeout=6 <host> 'echo ok'
```

`BatchMode=yes` 是關鍵——它讓「其實還在等密碼」直接失敗，而不是掛在那裡看起來像連線慢。

---

## 2. 知道對面的殼層是什麼

**Windows 的預設殼層是 `cmd.exe`**（實測 `%COMSPEC%`）。兩個立刻會咬人的差異：

- **`cd` 不換磁碟機**，要 `cd /d D:\...`。少了 `/d` 會在 `C:\Users\user` 底下跑 git，
  回 `not a git repository`，**看起來像 repo 不見了**。
- 要 PowerShell 就整段包起來：`ssh <host> 'powershell -NoProfile -Command "..."'`。
  引號一旦要巢狀，**改成寫 `.ps1` 用 `scp` 傳過去再 `powershell -File` 跑**，
  在引號裡搏鬥是浪費時間。

mac worker 就是一般的 zsh，沒有這個問題。

---

## 3. 對面要有的東西

| | 為什麼 |
|---|---|
| `git` + **正確的作者身分** | 兩台機器推同一批 repo，身分錯了會生出連不到帳號的 commit（見 `ship` skill） |
| GitHub 認證 | mac 用既有金鑰；**Windows 那台走 per-repo deploy key**，七把金鑰七個 Host 別名，remote 長 `git@github-<repo>:...`（帳號層級金鑰需要 `admin:public_key`，那台拿不到） |
| `claude` | 要派 Claude Code 工作才需要。位置每台不同（Pro 在 `~/bin/claude`，Windows 在 `~\.local\bin\claude.exe`） |
| `tmux` | mac worker 跑長工用；**Windows 沒有**，那台的長工做法見 dispatch.md |
| Docker | 要跑服務才需要 |

**skills／設定要不要同步過去**：worker 也會跑 Claude Code 的話就要。做法見
skills repo 的 `BOOTSTRAP.md`。**Windows 上連結要用 junction 而且必須提權建**，
否則會被標成未受信任的掛載點——`mklink /J` 回報成功、`dir /al` 也列得出來，
**只有實際去讀才炸**（踩過兩次，一次是 8 個 skill 一個都沒生效）。建完一定要實讀一次：

```powershell
Get-ChildItem $env:USERPROFILE\.claude\memory -ErrorAction Stop
```

---

## 4. 寫進 `~/.ssh/config` 並記到記憶檔

別名要短（`pro`），因為之後每一次派工都要打。

接完在 `~/.claude/memory/` 開一份該機器的 `reference` 記憶：規格、位址、
角色、金鑰怎麼派、以及**那台特有的坑**。這支 skill 只寫流程，
機器的身分事實放記憶檔——第四台接起來的時候，要照抄的是流程，要查的是身分。

## 驗收清單（每一項都要實跑）

```bash
ssh -o BatchMode=yes <host> 'echo ok'                    # 1. 免密碼進得去
ssh <host> '<看規格的指令>'                               # 2. 真的是那台機器
ssh <host> 'git config user.email'                       # 3. 身分對
ssh <host> 'command -v claude tmux docker git'           # 4. 該有的都在（Windows 用 Get-Command）
scp <小檔> <host>:<路徑> && ssh <host> '<讀回來>'         # 5. 檔案進得去也讀得到
```

第 5 項最常被跳過，而它擋掉的是「派工派到一半才發現傳不進去」。
