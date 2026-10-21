# 開新專案 — macOS

`newproj` 的 mac 半邊：怎麼跑 scaffold、資料庫哪來、怎麼驗。
共通的部分（為什麼要三層、什麼時候可以降級、CLAUDE.md 要補什麼）在 [SKILL.md](SKILL.md)。
Windows 看 [windows.md](windows.md)，**指令不通用**。

| | |
|---|---|
| 專案根 | `~/Projects/<name>`，或設 `PROJECTS_ROOT` 換位置（別放 `~/Documents`：iCloud／TCC 會讓它讀不到，見 `env-doctor`） |
| `proj` | 選配（作者的專案控制台 projctl；例：`/opt/homebrew/bin/proj` → `~/Projects/projctl/proj.mjs`）。沒有就照 SKILL.md 開頭的手動做法 |
| 資料庫 | **本機共用的 PostgreSQL**（brew 裝的常駐服務），不是每個專案一個容器 |

---

## 跑 scaffold

```bash
proj new <name>
~/.claude/skills/newproj/scaffold.sh <name>
# 沒有 proj：自己建目錄與 repo 後
~/.claude/skills/newproj/scaffold.sh <name> --web-port <n> --api-port <n+1>
```

`--dir` 不給的話預設就是 `${PROJECTS_ROOT:-~/Projects}/<name>`。

## 資料庫

scaffold 會自己做這兩件事（`--no-createdb` 可以跳過）：

```bash
createdb <db_name>
psql -q -d <db_name> -f db/schema.sql
psql -q -d <db_name> -f db/seed.sql
```

找不到 `createdb` 時它會跳過並印一行提示，那通常表示服務沒起來：

```bash
brew services start postgresql@17
```

**為什麼是共用的 PostgreSQL 而不是每個專案一個 Docker 容器**：`proj start` 的
`deps: ["postgres"]` 已經會預檢它，而 mac 上 Docker 的存活檢查有坑
（`docker info` 在 daemon 沒跑時會卡兩分鐘，見 `env-doctor` 的 macos.md）。

> 這一段整段是 mac 專屬的。例：作者的 Windows 機器**主機上根本沒有 `psql` 與 `createdb`**，
> 資料庫是跑在容器裡的。

## 起服務與驗證

```bash
proj start <name>          # 或 cd <專案目錄> && ./run.sh
```

`run.sh` 首次執行會自己建 venv 並裝相依：

```bash
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt
cd frontend && npm install
```

驗證（`/health` 會連資料庫一起檢查）：

```bash
curl -sS http://localhost:<api_port>/health      # 要回 {"ok":true,"db":"ok"}
curl -sS http://localhost:<api_port>/api/items   # 要看到 seed 的兩筆
curl -sS -o /dev/null -w '%{http_code}\n' http://localhost:<web_port>/
```

跑測試：

```bash
cd backend && ./.venv/bin/pytest        # 4 個測試，0.4 秒
```

打不到就 `localhost` 與 `127.0.0.1` 兩種都試，mac 常見 IPv4/IPv6 分裂。
