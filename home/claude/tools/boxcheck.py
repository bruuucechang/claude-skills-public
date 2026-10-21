#!/usr/bin/env python3
"""掃 Markdown 裡的 ASCII 方框，找出「在終端機或在 GitHub 上會歪掉」的圖。

為什麼需要這支：2026-09-16 使用者回報 claude-skills 的 README 架構圖在 GitHub
上沒對齊。那張圖在終端機裡每行都剛好 74 格、一格不差 —— 錯的不是排版，是
「中文＝2 格」這個前提在瀏覽器裡不成立。

在 GitHub code block 的字型堆疊下實測（headless Chromium，字型堆疊為
ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono"）：

    半形 M          7.225px   1.000 格
    ─ │ ┌ ↑ ▲ ▂ █ ← ▶ · ⊘ ✗ ⚠ ✓ ●
                    7.225px   1.000 格   ← 框線與符號都是安全的
    中（CJK）      12.000px   1.661 格   ← 少 0.34 格
    ＝（全形符號） 12.000px   1.661 格
    （（全形括號）  6.300px   0.872 格   ← 少 1.13 格，比中文還糟三倍
    ℹ️ 🟢 📊（emoji）15.000px  2.076 格

所以一行裡每個中文字往左縮 0.34 格、每個全形括號縮 1.13 格、每個 emoji 撐開
0.076 格。右邊界封了口就一定散開。

兩類問題分開報：
  BAD  閉合框的各行顯示寬度本來就不一致 —— 終端機裡也歪，純粹算錯，一定要修。
  GH   寬度一致（終端機正確），但框內有中文／全形／emoji —— 只在 GitHub 上歪。
       修法：把右邊界拿掉改成開放式框（見 mkarch.py 的 box()）。

用法：
    python3 boxcheck.py                 # 預設掃 ~/.claude/skills 與 ~/Projects/*
    python3 boxcheck.py <repo|檔案>…    # 指定目標
    python3 boxcheck.py --quiet         # 只印摘要一行（給 rules-audit.sh 用）

exit code：有 BAD → 1；只有 GH → 0；掃到 0 個檔 → 2（沉默不等於成功）。

重量那些數字：見 README 的「架構」節，或直接用 dev-browser 對著 GitHub 的字型
堆疊量一次 —— 只留數字不留指令的紀錄，過期的時候沒有人會發現。
"""
import os, re, subprocess, sys, unicodedata

BOX = set("─│┌┐└┘├┤┬┴┼━┃┏┓┗┛┣┫┳┻╋═║╔╗╚╝╠╣╦╩╬╭╮╰╯")
EDGE_L, EDGE_R = "┌└├│╔╚╠║┏┗┣┃╭╰", "┐┘┤│╗╝╣║┓┛┫┃╮╯"

# 帶日期的歷史報告：圖確實是歪的，但那是當時的產出，改了等於篡改紀錄。
# 2026-09-16 當面裁示不動 —— 所以這裡明講豁免，而不是讓季檢永遠紅一格。
EXEMPT = [re.compile(r"/reports/(daily|weekly)-\d{4}-\d{2}-\d{2}")]


def cw(c):
    """終端機的顯示寬度（east_asian_width，ambiguous 當 1 格）。"""
    if unicodedata.combining(c):
        return 0
    return 2 if unicodedata.east_asian_width(c) in ("W", "F") else 1


def width(s):
    return sum(cw(c) for c in s)


def risky(s):
    """會在瀏覽器等寬字體裡「不是整數格」的字元：中文、全形、emoji。"""
    return [c for c in s if c not in BOX and cw(c) == 2]


def diagrams(path):
    """切出每一段連續的框線區塊。空白行不切段，兩段之間才切。"""
    try:
        lines = open(path, encoding="utf-8", errors="replace").read().split("\n")
    except OSError:
        return
    run, start = [], None
    for i, line in enumerate(lines):
        if any(c in BOX for c in line):
            if start is None:
                start = i
            run.append(line)
        elif run and not line.strip():
            run.append(line)
        else:
            if run:
                yield start, run
            run, start = [], None
    if run:
        yield start, run


def check(path):
    out = []
    for start, run in diagrams(path):
        while run and not run[-1].strip():
            run.pop()
        # 注意：光禿禿的一根 `│`（開放式框的空行）同時滿足「開頭是左邊界」與
        # 「結尾是右邊界」—— 少了 len>=2 這個條件，開放式框會被誤判成閉合框。
        edges = [(start + i, width(l.rstrip()))
                 for i, l in enumerate(run)
                 if len(l.rstrip()) >= 2 and l.rstrip()[0] in EDGE_L and l.rstrip()[-1] in EDGE_R]
        if len(edges) < 2:          # 開放式框，右邊沒封口 —— 天生不會歪
            continue
        widths = sorted({w for _, w in edges})
        bad_chars = [c for l in run for c in risky(l)]
        if len(widths) > 1:
            out.append(("BAD", path, start + 1, f"閉合框各行寬度 {widths}，終端機裡就歪"))
        elif bad_chars:
            kinds = "".join(sorted(set(bad_chars)))[:12]
            out.append(("GH", path, start + 1,
                        f"閉合框含 {len(bad_chars)} 個非整數格字元（{kinds}…），GitHub 上會歪"))
    return out


def targets(argv):
    roots = argv or [os.path.expanduser("~/.claude/skills")] + [
        os.path.join(os.path.expanduser("~/Projects"), d)
        for d in sorted(os.listdir(os.path.expanduser("~/Projects")))
        if os.path.isdir(os.path.join(os.path.expanduser("~/Projects"), d, ".git"))
    ]
    for root in roots:
        if os.path.isfile(root):
            yield root
            continue
        if not os.path.isdir(root):
            continue
        listed = subprocess.run(["git", "-C", root, "ls-files", "*.md", "*.mdx", "*.txt"],
                                capture_output=True, text=True).stdout.split("\n")
        for f in listed:
            p = os.path.join(root, f)
            if f.strip() and os.path.isfile(p):
                yield p


def main():
    argv = [a for a in sys.argv[1:] if not a.startswith("--")]
    quiet = "--quiet" in sys.argv
    home = os.path.expanduser("~")
    seen, findings = 0, []
    for p in targets(argv):
        seen += 1
        findings += check(p)
    if seen == 0:
        print("boxcheck: 掃到 0 個 Markdown 檔 —— 路徑八成壞了，結果不可信")
        return 2
    def exempt(p):
        return any(rx.search(p) for rx in EXEMPT)

    bad = [f for f in findings if f[0] == "BAD" and not exempt(f[1])]
    gh = [f for f in findings if f[0] == "GH" and not exempt(f[1])]
    skipped = [f for f in findings if exempt(f[1])]
    if not quiet:
        for kind, path, line, msg in bad + gh:
            print(f"{kind:4s} {path.replace(home, '~')}:{line}  {msg}")
        for _, path, line, _ in skipped:
            print(f"豁免 {path.replace(home, '~')}:{line}  帶日期的歷史報告，不改")
        print()
    print(f"boxcheck: 掃了 {seen} 個檔，{len(bad)} 個框終端機就歪、"
          f"{len(gh)} 個框只在 GitHub 上歪，{len(skipped)} 個豁免")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
