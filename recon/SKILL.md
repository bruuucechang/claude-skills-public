---
name: recon
description: 開始改一個 repo 之前先跑（/recon）。這裡常有多個 Claude session 並行改同一份程式碼，別台機器也可能已經跑在前面——確認現況再動手，不要只信 session 開始時讀到的檔案內容。**這支只查 repo 現況，不查環境**：已經有明確故障症狀用 env-doctor。mac 與 Windows 通用，寫法差異寫在裡面。
---

# 開工前的現況確認

**這台機器常有多個 Claude session 同時在改同一個 repo，另外還有三台機器會推東西上去。**
session 開始時讀到的檔案內容、記憶檔裡的敘述、上一輪對話留下的印象，
到你真正動手的那一刻都可能已經不成立。

實際發生過：
- 在 grill 使用者的那 20 分鐘內，另一個 session 把同一個 bug 修掉並 commit 了
- 本地看起來乾淨且「與 origin 同步」，push 時才發現 origin 領先 17 個 commit

這個檢查只花幾秒，但它擋掉的是「基於過期認知做完一整件事」。

## 為什麼這一支不能省略（2026-09-16 補）

**這四台機器合起來就是一個多 agent 系統，而 GitHub 那份 repo 是它的共享狀態。**
四台機器上的 session 彼此不直接通訊，全靠讀寫同一塊狀態協調——這在多 agent 的
文獻裡叫 blackboard，而它有一個已知的失效模式：

> 多個並行的 agent 共享可變狀態時，會誤以為跨 agent 邊界的更新是同步的，
> 於是產生交易上不一致的資料。

「改動被別的 session 掃進它自己的 commit」（2026-09-08 一天內兩次）不是誰不小心，
就是這個失效模式本身。標準解法是**讓每個 agent 只寫入天然不相交的位置**
（Google ADK 對並行 agent 的規定：各寫各的 state key）。

這套設定目前**沒有**在狀態層做這種隔離——`ship` 的「只 add 自己動過的檔」與這一支的
「動手前重新確認現況」是**應用層的補丁**，靠每個 session 自律。所以：

- **這兩支不是禮貌性的檢查清單，是唯一擋在那個失效模式前面的東西。** 省掉就沒有了。
- `AGENTS.md` 禁止 `rebase`／改寫已 push 的歷史，理由（別台可能已經 pull，而這台
  看不出來）跟文獻上保護共享狀態一致性的理由是同一個。那條不是保守，是必要。

## 有兩個 repo 幾乎永遠有人在動——對它們「等閒下來」是無限等（2026-09-17）

`agent-quota` 與 `projctl`（以前叫 `.projctl`）實測是**常駐工作狀態**：一整天任何時候去看都有未提交的改動，
一批剛提交下一批馬上又出現。

所以**「偵測到別的 session 在動就整個 repo 跳過」這個策略對它們等於永遠不做**。
而放著不做的代價是真的：2026-09-17 就出現過 `.projctl` 的 doc-audit 因為
跨 repo 引用一直是紅的——**而一個永遠紅的檢查等於沒有檢查**。

**對這兩個要降到檔案層級避讓，不是 repo 層級：**

1. `git status --porcelain -- <我要改的檔>` ——**只問我要碰的那幾個檔**有沒有人在動，
   不要看整個 repo 的未提交數。
2. 挑**對方不會碰的檔**下手。實例：對方在改 `quota.md`／`dash.mjs`／`quota.mjs`
   （配額卡重做），我只加 `tools/doc-audit-allow.txt` 三行，零重疊。
3. commit 前再 `git fetch` 一次並 `--ff-only`。那兩個 repo 的 commit 節奏是分鐘級，
   session 開始時的 ahead/behind 到你要提交時多半已經不成立。
4. **只 add 自己動過的那幾個檔**（`ship` 本來就要求），不要 `git add -A`。

判準：**這個 repo 是「偶爾有人在動」還是「幾乎永遠有人在動」？**
前者等得到，後者等不到——等不到的就改成挑不重疊的檔做。

---

## 跑這些

mac 一支做完（2026-10-21 W3）——在 repo 裡跑，後面接**要碰的檔**：

```bash
~/.claude/skills/home/bin/recon-check [<要碰的檔…>]
```

印分支與 upstream、fetch 結果（失敗會明說 ahead/behind 不能信、exit 1）、ahead／behind
（behind 時列出 origin 多的 commit，**碰到要碰的檔的另外標出來**）、要碰的檔各自的狀態與 mtime、
其餘未 commit 的檔（不是你的就別碰、別 add）、最近 5 個 commit。判讀仍是你的事，照下面「怎麼判讀」。

**自動換手接手時（2026-10-21 W4）**：handoff-open 的開場白有 `## 現況快照` 的話（clear／tmux／switch 才有，exit 0 才算數），
不用再跑一次；照快照判讀就好。要碰的檔不在快照裡、或快照之後過了很久才動手，再帶檔名跑一次。

Windows 或要手動跑時，就是這幾行：

```bash
cd <repo>
git log --oneline -5
git status --short
git fetch origin 2>&1 | tail -3
git status -sb | head -1        # ahead / behind 都要看
```

要動的檔案再單獨看一眼 mtime：

```bash
ls -la <要改的檔案>
```

```powershell
Get-Item <要改的檔案> | Select-Object LastWriteTime, Length, FullName
```

`git` 的指令兩台完全一樣，只有看 mtime 這一步要換寫法。

---

## 怎麼判讀

**`behind N`（origin 有你沒有的）**
先 `git log --oneline HEAD..origin/master` 看那些 commit 動了什麼。
**如果它們碰到你要改的區域，先 rebase 再開工**，不要改完才發現要處理衝突。
（**`projctl` 與 `claude-skills` 例外——那兩個有 subtree 合併，rebase 會炸，
要用 `git pull --no-rebase`**。理由與怎麼認出來寫在 `ship` skill。）
更重要的是：那些改動可能已經讓你手上的計畫失效（功能被別人做掉了、介面變了）。

**工作區有未提交的改動，但不是你做的**
先確認那是什麼。可能是另一個 session 做到一半的東西——
**不要 `git add .`**，只 add 你自己動過的檔案。
`git diff <file>` 看得出是不是你熟悉的改動。

**檔案 mtime 比 session 開始時間新**
表示有人在你讀完之後改過它。重讀一次再動手。

**`git log` 裡有你沒印象的 commit**
`Claude-Session:` 那一行可以認出是哪個 session 做的。
是自己人做的就讀懂它再繼續，不要覆蓋回去。

---

## 開工中途也要重來一次的時機

- 你去做了別的事（跑長測試、grill 使用者、等使用者回覆）超過十幾分鐘
- 你要 commit 之前（見 `ship` skill）
- 任何一次 push 被拒絕

---

## 沒有 remote 的 repo

專案根本身不是 repo（mac 是 `~/Projects`、Windows 是 `D:\Claude\Projects`），
底下的專案各自有自己的 repo。確認你在對的那一層——`git rev-parse --show-toplevel` 會告訴你。

有些目錄是 symlink，**進去之前先確認自己站在哪個 repo 裡**：
`git rev-parse --show-toplevel` 是唯一可靠的判斷。

> 同一個 repo 內的 symlink 沒有這個問題（`~/Projects/chrome-tab-groups`
> → `.projctl/chrome-ext` 兩邊是同一個 repo）。**真正跨 repo 的 symlink 才會**
> 讓你以為自己在 A repo、其實站在 B。

**Windows 上那些連結是 junction 不是 symlink**，`Get-ChildItem` 看不出來，要用：

```powershell
Get-Item <路徑> -Force | Select-Object LinkType, Target
```

`~\.claude\memory` 與 `~\.claude\commands` 都是 junction，指進 `~\.claude\skills\home\claude\`——
在那裡面改記憶檔就是在改 skills repo。**但 `~\.claude\settings.json` 不是連結**，
是獨立的一份，改它不會進版控（兩台的內容刻意不同，見 skills repo 的 README）。

## 另一台可能已經跑在前面

**每台機器都可能 clone 同一批 repo**，也各自有 Claude session 在跑。
`git fetch` 只看得到已經推上去的東西——**別台工作區裡沒 commit 的改動你看不到**。

**每台的專案樹路徑不一樣**，這是最容易查錯地方的一點。把你自己的機器列成一張這樣的表
（例：作者的四台）：

| 機器 | 怎麼連 | 專案樹 |
|---|---|---|
| 這台 Air | — | `~/Projects` |
| **M5 Pro** | `ssh pro` | **`~/Code`**（不是 `~/Projects`） |
| BRUCEVICTUS | `ssh victus` | `D:\Claude\Projects` |
| DESKTOP-KR4TOIA | `ssh desk` | `E:\Project` |

機器清單與各自的角色另有一份正本（例：作者的 `worker` skill）；這裡只列查現況要用的路徑。

要動一個「別台最近也在弄」的 repo，先過去看一眼（主機與專案樹換成你那張表的）：

```bash
ssh <mac 或 Linux 主機> 'cd <專案樹>/<repo> && git status --short && git log --oneline -3'
ssh <Windows 主機> 'cd /d <磁碟機>:\<專案樹>\<repo> && git status --short && git log --oneline -3'
```

**不要只查其中一台。** 例：2026-09-03 實測：M5 Pro 的 `~/Code/trip-atlas` 有
**176 個未提交檔案**——記憶檔 `trip-atlas` 記的「2026-08-19 起整個開發環境搬到
M5 Pro」就是這個意思。只 ssh 到 Windows 那台等於完全沒查。

**`/d` 不能省**（Windows 主機）。SSH 過去的預設殼層是 `cmd.exe`，而 cmd 的 `cd`
**不會換磁碟機**——少了 `/d` 就還留在 `%USERPROFILE%`，git 回一句
`not a git repository`，看起來像 repo 不見了（實測踩過）。
