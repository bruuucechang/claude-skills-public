#!/usr/bin/env python3
"""產生 ARCHITECTURE.md 的 ASCII 圖。

三個坑：
1. 中文是全形，len() 算不出顯示寬度 —— 框線一律用顯示寬度算。
2. ⊘ ✗ ⚠ 這些符號的 east_asian_width 是 'A'（ambiguous），換一個字體
   就可能從 1 格變 2 格，框線當場歪掉。所以只用寬度確定的字元。
3. **右邊界一律不封口** —— 「中文＝2 格」只在終端機成立。在 GitHub 的
   code block 上實測（headless Chromium，GitHub 的字型堆疊 ui-monospace,
   SFMono-Regular, "SF Mono", Menlo, Consolas）：

       半形 advance 7.225px   中文 fallback advance 12.000px   比值 1.661

   每個中文字少 2.45px ≈ 0.34 格，所以一行 14 個中文字就往左縮 4.7 格。
   終端機裡每行都剛好 74 格的圖，在 GitHub 上右邊界會散開 34px。
   沒有任何寫法能同時滿足兩邊 —— 所以不封右邊界，讓右側的參差不重要。
   橫線（┌─ ├─ └─）則一律是純框線字元、不夾中文，任何字體都等長。

   重量：python3 home/claude/tools/boxcheck.py <repo…>
"""
import unicodedata, pathlib, sys

# 框線（U+2500 區）與 ▶▼◀ 的 east_asian_width 也是 'A'，但等寬字體一律當窄字，
# 實務上不會歪。真正會在不同字體間變寬的是下面這些符號 —— 用到就直接擋。
RISKY = set("⊘✗⚠✓●◆★☆⚑⛔❗️")

def w(s):
    t = 0
    for c in s:
        if c in RISKY:
            raise SystemExit(f"寬度不定的符號 {c!r} 出現在 {s!r} —— 換掉，不然框會歪")
        t += 2 if unicodedata.east_asian_width(c) in "WF" else 1
    return t

def box(title, rows, width=74):
    """開放式框：左側 rail ＋ 三條純框線橫線，右邊不封口（理由見檔頭第 3 點）。

    標題放在橫線「底下」而不是嵌在橫線裡 —— 標題含中文，嵌進去那條橫線就會
    比另外兩條短一截，而那正是這次要修掉的東西。
    """
    rule = "─" * (width - 1)
    out = ["┌" + rule]
    if title:
        out += ["│ " + title, "├" + rule]
    for r in rows:
        if r == "---":
            out.append("├" + rule); continue
        out.append(("│ " + r).rstrip() if r else "│")
    out.append("└" + rule)
    return out

def cols(*pairs):
    """按顯示寬度補欄，中文才對得齊。pairs = (文字, 欄寬) …

    只有「這一欄之前都沒有中文」的欄位在 GitHub 上才真的對得齊，所以
    含中文的欄位一律排到最後一欄 —— 最後一欄的參差看不出來。
    """
    return "".join(t + " " * max(n - w(t), 1) for t, n in pairs).rstrip()

def down(label, col=26):
    return [" " * col + "│", " " * col + "│  " + label, " " * col + "▼"]


# ── 數字一律現場量，不要寫死 ───────────────────────────────────────────
# 寫死的圖一定會過期，而過期的圖比沒有圖更糟——它看起來還是對的。
HOME = pathlib.Path.home()
CH   = HOME / ".claude" / "skills" / "home" / "claude"
PROJ = HOME / "Projects"

def L(p):
    p = pathlib.Path(p)
    return len(p.read_text(encoding="utf-8", errors="ignore").splitlines()) if p.exists() else 0

def nums():
    import json
    st = json.loads((CH / "settings.json").read_text(encoding="utf-8"))
    mem = HOME / ".claude" / "projects" / "-Users-bruuucemac" / "memory"
    ex = max((PROJ.glob("*/docs/notebook.md")), key=L, default=None)
    return {
        "g_claude":  L(CH / "CLAUDE.md"),
        "g_agents":  L(CH / "AGENTS.md"),
        "g_rules":   L(CH / "rules" / "browser.md"),
        "p_claude":  L(PROJ / "palrogue" / "CLAUDE.md"),
        "p_agents":  L(PROJ / "palrogue" / "AGENTS.md"),
        "nb":        L(ex) if ex else 0,
        "nb_proj":   ex.parent.parent.name if ex else "—",
        "mem_idx":   L(mem / "MEMORY.md"),
        "mem_n":     len(list(mem.glob("*.md"))) - 1,
        "skills":    len([d for d in (HOME / ".claude" / "skills").iterdir()
                         if d.is_dir() and (d / "SKILL.md").exists()]),
        "events":    len(st["hooks"]),
        "hooks":     sum(len(g["hooks"]) for a in st["hooks"].values() for g in a),
        "deny":      len(st["permissions"]["deny"]),
        "repos":     len([d for d in PROJ.iterdir() if (d / ".git").exists()]),
        **sync(),
    }

def sync():
    """這台在哪個分支、預設分支上有沒有新版規則 —— 量出來，不要假設。"""
    import subprocess
    R = HOME / ".claude" / "skills"
    def g(*a):
        try:
            return subprocess.run(["git", "-C", str(R), *a], capture_output=True,
                                  text=True, timeout=10).stdout.strip()
        except Exception:
            return ""
    br = g("rev-parse", "--abbrev-ref", "HEAD") or "?"
    default = (g("symbolic-ref", "refs/remotes/origin/HEAD") or "").rsplit("/", 1)[-1] or "master"
    on_default = subprocess.run(["git", "-C", str(R), "cat-file", "-e",
                                 f"origin/{default}:home/claude/AGENTS.md"],
                                capture_output=True).returncode == 0
    ahead = g("rev-list", "--count", f"origin/{default}..HEAD") or "0"
    return {"branch": br, "default": default, "on_default": on_default, "ahead": ahead}

N = nums()

D = {}

# ─────────────────────────────────────────────── ① 載入路徑
D["loading"] = "\n".join(
    box("SESSION 開始就載入 · 每一次請求都在", [
        "",
        f"~/.claude/CLAUDE.md          {N['g_claude']} 行",
        f"      └── @import ──▶ ~/.claude/AGENTS.md    {N['g_agents']} 行  ← Codex 也讀",
        "",
        f"<專案>/CLAUDE.md             {N['p_claude']} 行（橋接）",
        f"      └── @import ──▶ <專案>/AGENTS.md       {N['p_agents']} 行  ← palrogue",
        "",
        f"skills 描述 × {N['skills']}（只有名稱與一句話）",
        f"MEMORY.md 索引 {N['mem_idx']} 行（{N['mem_n']} 個記憶檔本體不載入）",
        "",
    ])
    + down("讀到 *.tsx / *.ts / *.css 時")
    + box("按需載入 · 不相關的工作＝零成本", [
        "",
        f"~/.claude/rules/browser.md           {N['g_rules']} 行  paths: 前端副檔名",
        "<專案>/.claude/rules/frontend.md            load_reason =",
        "                                            path_glob_match",
        "",
    ])
    + [""]
    + box("從不自動載入 · 需要時才用 Read 去讀", [
        "",
        f"<專案>/docs/notebook.md   {N['nb']:,} 行       context 成本 ＝ 0",
        f"                          （{N['nb_proj']}）     拆之前這些全部每次載入",
        "",
    ])
)

# ─────────────────────────────────────────────── ② 強制層
D["enforcement"] = "\n".join(
    ["回合的生命週期 →", "",
     "  session 開始 ──▶ 模型決策 ──▶ 工具呼叫 ──▶ 工具執行 ──▶ 回合結束",
     "       │                          │                          │",
     "       ▼                          ▼                          ▼", ""]
    + box("session 開始", [
        "SessionStart          注入 3 條常設偏好",
        "InstructionsLoaded    記錄這個 session 載入了哪些指令檔",
    ])
    + box("工具呼叫 —— 要權限決策的那一刻", [
        "[!] PreToolUse × 2    git commit 作者身分 / browser_batch 白名單",
        "                      exit 2 ＝ 擋下",
        f"[!] permissions.deny  {N['deny']} 條，工具層直接停用",
    ])
    + box("回合結束", [
        "[!] Stop              回合以問號結尾但沒叫 AskUserQuestion → 退回",
    ])
    + ["",
       "  [!] ＝ 真的會擋下動作。其餘（Notification、Stop 的音效）只觀察。",
       "  deny 與 PreToolUse 都在「要權限決策」那一刻檢查，所以掛在工具呼叫",
       "  底下，不是執行底下。",
       "",
       f"  合計 {N['hooks']} 個 hook 指令 / {N['events']} 個事件 / {N['deny']} 條 deny"]
)

# ─────────────────────────────────────────────── ③ 專案樣板
D["scaffold"] = "\n".join(
    ["資料流（newproj scaffold.sh 生出來的骨架）", "",
     "  frontend/src/  元件",
     "        │",
     "        ▼",
     "  api/client.ts   ←── 唯一打後端的地方",
     "        │",
     "        ▼",
     "  routers/        不寫業務邏輯",
     "        │",
     "        ▼",
     "  services/       業務邏輯，不知道 HTTP  ◀── backend/tests/ 打這一層",
     "        │                                    FakeRepo：不起 DB、不起 HTTP",
     "        ▼",
     "  repositories/   唯一碰資料庫的地方",
     "        │",
     "        ▼",
     "  db/schema.sql   資料表的唯一真相", ""]
    + box("同時生出來的文件與守衛", [
        "AGENTS.md           規則正本（含「做過但結論是不做的」表）",
        "CLAUDE.md           一行 @AGENTS.md 橋接",
        "project-map.json    作業圖：節點／泳道／SOP，步驟用 touches 綁回節點",
        ".claude/rules/      帶 paths: 的情境規則",
        "docs/notebook.md    量測與推導，不進 context",
        "---",
        "tools/smoke         每支工具還跑不跑得起來",
        "tools/doc-audit     文件提到的路徑還在不在",
        "tools/vitals        文件引用的數字現在是多少",
        "                    三支都會在掃到 0 個目標時 exit 2，",
        "                    不允許把「什麼都沒掃到」印成「通過」",
    ])
    + ["",
       "  services/ 那一層是整個架構的回報：bug 能在秒級單元測試裡定位。",
       "  測試需要起資料庫，就代表業務邏輯漏到別層去了。"]
)

# ─────────────────────────────────────────────── ④ 四台機器
D["machines"] = "\n".join(
    box("GitHub（private）", [
        "claude-skills   規則 · 設定 · 記憶 · skills",
        f"＋ {N['repos']} 個專案 repo",
    ])
    + ["", "        ├──────────────┬──────────────┬──────────────┐",
       "        ▼              ▼              ▼              ▼", ""]
    + box("四台機器", [
        # 前兩欄刻意全是半形 —— 含中文的說明排在最後一欄，參差才看不出來
        cols(("Air", 14), ("~/Projects", 22), ("這台（client）· 六個 symlink 都在這裡", 2)),
        cols(("BRUCEVICTUS", 14), ("D:\\Claude\\Projects", 22), ("同一份規則（junction）", 2)),
        cols(("desk", 14), ("E:\\Project", 22), ("同一份規則（junction）", 2)),
        cols(("M5 Pro", 14), ("~/Code", 22), ("算力主機 · [!] 獨立的第四套，見下", 2)),
    ])
    + [""]
    + box("每台的 ~/.claude 底下，六個位置都是指向 skills repo 的 symlink", [
        "AGENTS.md · CLAUDE.md · rules/ · settings.json · commands/",
        "以及 ~/.codex/AGENTS.md（Codex 的全域指令檔）",
        "",
        "Windows 兩台沒開 Developer Mode，檔案不能 symlink：CLAUDE.md 是一行",
        "@import 的實體檔、rules/ 是 junction、~/.codex/AGENTS.md 是硬連結。",
        "pull 之後要跑 machine-setup/windows/scripts/sync-rules.cmd 重建。",
        "",
        "→ 改一次，這三台都變。",
    ])
    + [""]
    + box("同步的實際狀態（現場量的，不是假設）", (
        [f"這台在分支 {N['branch']}，比 origin/{N['default']} 多 {N['ahead']} 顆"]
        if N["ahead"] != "0" else
        [f"這台在 {N['branch']}，與 origin/{N['default']} 同步"]
      ) + ([
        f"origin/{N['default']} 已經有新版規則（AGENTS.md）",
        "BRUCEVICTUS 與 desk 都已經接好（2026-09-09 實跑 sync-rules.cmd，",
        "六項存在性檢查全過）。desk 沒裝 Codex，skill 連結先放著。",
      ] if N["on_default"] else [
        f"[!] origin/{N['default']} 上還沒有 AGENTS.md ——",
        "    也就是說另外三台 pull 下去也拿不到新版規則。",
        "    「改一次四台都變」在合併進預設分支之前是不成立的。",
      ]) + [
        "",
        "M5 Pro 不是「還沒同步」，是另一條血脈：194 個 skill（只有 env-doctor",
        "跟這邊重名）、一份來自 client AI tukey-dev-playbook 的 CLAUDE.md，",
        "而且 ~/.claude/skills 是實體目錄不是 repo。刻意不接進來 —— 它自己的",
        "規則檔就寫著「不要混裝多套 skill pack，名稱一撞車就分不清誰是誰」。",
      ])
    + ["",
       "  三台（Air／VICTUS／desk）收斂成一份規則；M5 Pro 獨立。工作沒有收斂 ——",
       "  所以動任何 repo 之前先跑 /recon。",
       "  2026-09-08 一天之內就有兩次改動被別的 session 掃進它自己的 commit。"]
)

TITLES = {
    "loading":     "① 指令載入路徑：成本壓在該壓的地方",
    "enforcement": "② 強制層：規則是請求，這一排才是保證",
    "scaffold":    "③ 每個新專案的樣板：五層一次生出來",
    "machines":    "④ 四台機器：規則同一份，工作各自跑",
}
NOTES = {
    "loading": "同一份知識放在三個位置，成本差三個數量級。`@import` **不會**省 context"
               "——省下來的是下面兩層：`paths:` 規則與 notebook。",
    "enforcement": "官方文件寫明 `CLAUDE.md` 是在系統提示之後、以使用者訊息送進去的，"
                   "**沒有嚴格遵從保證**。必須每次成立的事只有落在 `[!]` 那幾格裡才算數。",
    "scaffold": "`services/` 那一層是整個架構的回報：bug 能在秒級單元測試裡定位，"
                "不用起資料庫也不用開瀏覽器。",
    "machines": "規則透過 symlink 收斂成一份；**工作沒有收斂**——這就是"
                "「改動被別的 session 掃進它的 commit」的來源。",
}

def render():
    out = ["# 這台機器的規則架構", "",
           "四張圖，分別是這套設定的四個面：**什麼時候載入什麼、誰在真的擋、"
           "每個專案長什麼樣、四台機器怎麼同步。**", "",
           "> **圖上的數字是 `tools/mkarch.py` 現場量出來的，不是寫死的。**",
           "> 覺得跟現況對不上就重跑：`python3 ~/.claude/skills/home/claude/tools/mkarch.py --write`",
           "> `rules-audit.sh` 每季會比對這個檔跟現況，數字漂移會被點名。", ""]
    for k in TITLES:
        out += [f"## {TITLES[k]}", "", "```text", D[k], "```", "", NOTES[k], ""]
    out += ["---", "",
            "這四張圖合起來就是那條路由規則的具體樣子：第 ① 張決定內容放哪、",
            "第 ② 張決定哪些事不能只靠自律、第 ③ 張讓 bug 有地方被定位、",
            "第 ④ 張說明為什麼動手前一定要先跑 /recon。",
            "缺任何一張，另外三張都會慢慢退化回原狀。", ""]
    return "\n".join(out)

if __name__ == "__main__":
    if "--write" in sys.argv:
        p = CH / "ARCHITECTURE.md"
        p.write_text(render(), encoding="utf-8")
        print(f"寫好 {p}（{L(p)} 行）")
    else:
        print(render())
