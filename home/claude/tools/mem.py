#!/usr/bin/env python3
"""記憶的分層查詢（借 claude-mem 的「先搜摘要、再取全文」做法，2026-10-06）。

MEMORY.md 每個 session 整份載入，所以只留「裁示過的規則」；其餘條目放在
INDEX.md（不自動載入），要用時用這支查：

  mem.py search <關鍵字...>   第一層：只回 名字 — 描述（每筆一行，便宜）
  mem.py show <名字...>       第二層：印出那幾個記憶檔的全文
  mem.py index [章節關鍵字]   印 INDEX.md（可只印某一節）

搜尋比對 name、description、本文；所有關鍵字都要命中（AND），不分大小寫。
排序：命中在 name > description > 本文。
"""
import os
import re
import sys
from pathlib import Path

MEM = Path(os.environ.get("CLAUDE_MEMORY_DIR", Path.home() / ".claude" / "memory"))


def parse(p: Path):
    text = p.read_text(encoding="utf-8", errors="replace")
    name, desc, body = p.stem, "", text
    m = re.match(r"^---\n(.*?)\n---\n?(.*)$", text, re.S)
    if m:
        fm, body = m.group(1), m.group(2)
        n = re.search(r"^name:\s*(.+)$", fm, re.M)
        d = re.search(r"^description:\s*(.+)$", fm, re.M)
        name = n.group(1).strip() if n else name
        desc = d.group(1).strip() if d else ""
    return name, desc, body


def files():
    for p in sorted(MEM.glob("*.md")):
        if p.name in ("MEMORY.md", "INDEX.md"):
            continue
        yield p


def search(terms):
    terms = [t.lower() for t in terms]
    hits = []
    for p in files():
        name, desc, body = parse(p)
        fields = (name.lower() + " " + p.stem.lower(), desc.lower(), body.lower())
        if not all(any(t in f for f in fields) for t in terms):
            continue
        score = sum(3 * (t in fields[0]) + 2 * (t in fields[1]) + (t in fields[2]) for t in terms)
        hits.append((score, p.stem, desc))
    hits.sort(key=lambda h: (-h[0], h[1]))
    for _, stem, desc in hits:
        print(f"{stem} — {desc}")
    if not hits:
        print("（沒有命中。換個關鍵字，或 mem.py index 看全部標題）", file=sys.stderr)
        return 1
    return 0


def show(names):
    rc = 0
    for n in names:
        p = MEM / (n if n.endswith(".md") else n + ".md")
        if not p.exists():
            cand = [q for q in files() if parse(q)[0] == n]
            p = cand[0] if cand else p
        if not p.exists():
            print(f"找不到記憶：{n}", file=sys.stderr)
            rc = 1
            continue
        print(f"===== {p.name}")
        print(p.read_text(encoding="utf-8", errors="replace"))
    return rc


def index(section=None):
    text = (MEM / "INDEX.md").read_text(encoding="utf-8")
    if not section:
        print(text)
        return 0
    out, on = [], False
    for line in text.splitlines():
        if line.startswith("## "):
            on = section.lower() in line.lower()
        if on:
            out.append(line)
    print("\n".join(out) if out else f"（INDEX.md 沒有含「{section}」的章節）")
    return 0 if out else 1


def main(argv):
    if len(argv) < 2 or argv[1] in ("-h", "--help"):
        print(__doc__)
        return 0
    cmd, args = argv[1], argv[2:]
    if cmd == "search" and args:
        return search(args)
    if cmd == "show" and args:
        return show(args)
    if cmd == "index":
        return index(args[0] if args else None)
    print(__doc__)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv))
