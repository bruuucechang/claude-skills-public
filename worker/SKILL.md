---
name: worker
description: 把另一台電腦當 worker 用——接機（SSH／金鑰／tailnet）、派工（headless claude -p、tmux 長工、把吃資源的服務丟過去跑）、隔著網路盯它在幹嘛、收尾。要接第四台機器、要把重活丟到 M5 Pro 或 BRUCEVICTUS、或遠端跑到一半沒反應時使用。細節分 enlist.md／dispatch.md／watch.md。
---

# 把別台機器當 worker

這台 Air 是**指揮端**，重活丟給別台跑。同一套流程已經走過三次，每次都在同樣的
地方卡住——這支 skill 是把那條線寫完，不要再從頭推理。

## 現有的機器

**清單在 [fleet.yaml](fleet.yaml)**（宣告式描述：角色、平台、兩個 ssh 別名、規格、專案根目錄、
claude 路徑、適合接的工、已知坑）。要改機器資料就改那份，不要再在這裡加表格。極短摘要：

| id | 機器 | 角色 | 接法 |
|---|---|---|---|
| `air` | 這台 Air（M4 / 16 GB） | 指揮端 | — |
| `pro` | M5 Pro（18 核 / 48 GB） | 算力主機 | `pro`／`pro-ts` |
| `victus` | BRUCEVICTUS（Win 11 家用版 / 15.7 GB） | Windows worker | `victus`／`victus-ts` |
| `desk` | DESKTOP-KR4TOIA（Win 10 Pro / 32 GB） | Windows worker #2，**Windows 吃資源的活優先丟這台** | `desk`／`desk-ts` |

### fleet.py：讀 fleet.yaml 的四個子指令

```bash
F=~/.claude/skills/worker/fleet.py
python3 $F list                                   # 表列機器、角色、規格、適合接的工
python3 $F ping [機器]                            # 先試區網別名，不通再試 tailnet，印出哪條通
python3 $F status [機器]                          # 遠端正在跑的 claude 程序：pid、啟動時間、互動或 headless（只讀）
python3 $F dispatch <機器> <專案相對路徑> <提示詞檔> --dry-run   # 先看會跑什麼
python3 $F dispatch <機器> <專案相對路徑> <提示詞檔>             # 真的派
```

`dispatch` 做的事：自動在提示詞前加「headless 派工須知」（沒有下一輪、不准背景執行；
`--no-preamble` 可關），把提示詞與包裝腳本 `scp` 到遠端 `~/fleet-jobs/<工作 id>/`，
在遠端背景跑 `claude -p`，輸出寫進同目錄的 `run.log`，**最後一行一定是 `DONE` 或 `FAIL rc=N`**；
本機印出查進度、等它結束（三態輪詢）、拉結果、收尾的指令。

- mac（pro）：`nohup bash job.sh`，並帶 `CLAUDE_USER=bruce`——Pro 的 `~/bin/claude` 是選身分的啟動腳本，
  不帶的話 `-p` 會落到 manibari 的 `~/.claude`。
- Windows：註冊 **S4U** 排程工作再 `Start-ScheduledTask`（跑在 session 0、不彈黑視窗、不靠 SSH 連線活著），
  觸發時間設 2099 年避免自己跑，工作跑完自己 `Unregister`。`job.ps1` 刻意是純 ASCII。
- 機器參數可以用 id、顯示名或 ssh 別名（`desk`、`DESKTOP-KR4TOIA`、`desk-ts` 都行）。
- 沒有 PyYAML 也能跑（內建極簡解析器），所以 fleet.yaml 只能用它開頭註解列的 YAML 子集合。

**三台都有「區網」與「tailnet」兩條路**（兩台 Windows 是 2026-09-16 補上的，在那之前
只有區網、不在家就完全派不了工）。不帶 `-ts` 的別名走 Bonjour `.local` 名稱，
只在同一個區網有效但不依賴 tailnet 活著；帶 `-ts` 的走 tailnet，在家時一樣是直連打洞，
不會比較慢。**優先用不帶 `-ts` 的，連不上再換 `-ts`。**

機器本身的身分事實（IP、金鑰怎麼派、踩過的系統坑）在記憶檔：
`windows-machine`、`m5pro-machine`、`desk-kr4toia`。**這支 skill 不重複那些，只寫流程。**

> 兩台 Windows 不一樣：BRUCEVICTUS 是 **Win 11 家用版 / 16 GB**、
> DESKTOP-KR4TOIA 是 **Win 10 Pro / 32 GB**，專案樹在 **E:\Project**（C 槽 2026-08-20 清完已回到 89 GB 可用）。
> 派工前先確認是哪一台，不要照另一台的印象推。

## 三個階段，各自一份

| 階段 | 什麼時候 | 讀哪份 |
|---|---|---|
| **接機** | 這台機器第一次要當 worker | **[enlist.md](enlist.md)** |
| **派工** | 已經接好了，要把工作丟過去 | **[dispatch.md](dispatch.md)** |
| **監看／收尾** | 丟出去之後 | **[watch.md](watch.md)** |

另外有一份 **[WORKER-README.md](WORKER-README.md)**，那份不是給你看的——
**是要交到新機器手上的**（`scp` 過去，或叫那台上的 Claude session 讀）。
內容是 worker 端的注意事項：夠不夠格、必做的六件事、那個平台的靜默失敗、
當 worker 期間的規矩、以及一段自我驗收指令。接機時第一步就把它送過去。

## 先問一句：這件事真的需要 worker 嗎

丟出去的成本是固定的（傳檔、環境差異、看不到畫面、收尾），不會因為工作小而變小。
**下面三種才值得丟**：

1. **本機做不到**——記憶體不夠（Air 的 16 GB 建不出日本的 OTP 圖）、只有那台有那個 OS。
2. **要跑很久而你想繼續做別的**——建圖磚、跑爬蟲、大批次轉檔。
3. **要平行**——同一件事在兩台上跑不同參數。

「順手丟過去比較快」通常是錯覺：光是把提示詞與輸入檔弄到對面、確認它真的跑起來，
就比在本機做完還久。

## 三條共通鐵則

**1. 一開始就決定「結果怎麼回來」。** 是留在對面（服務），還是要拉回來（檔案）？
要拉回來就先想好用 `scp`——**不要用 `ssh ... cat/Get-Content` 拉大檔**，會卡到逾時。

**2. 派出去的東西要能自己講話。** 遠端沒有人會回答問題、沒有下一輪對話。
腳本要自己寫 log，工作要自己跑完，需要決策的地方在派出去之前就決定掉。

**3. 收尾是你的責任，不是對面的。** 排程工作、暫存檔、自己開的程序、自己起的容器——
每一項都要在同一輪清掉。清單見 watch.md，這件事漏掉的代價是下次接手的人
（可能是另一個 session）看到一台狀態不明的機器。
