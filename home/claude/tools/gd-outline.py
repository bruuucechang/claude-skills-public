#!/usr/bin/env python3
"""GDScript 大綱：只留簽名，函式本體換成 `pass # body elided`，輸出仍是合法 GDScript。

用法：python3 gd-outline.py 檔案.gd [...]   → stdout（多個檔時每個前面加一行 `# ==> 路徑`）

留下的：extends／class_name／signal／enum／const／var／@export 等註記、內部 class、
所有 func 的簽名（含多行簽名與 static）、檔頭與 `##` 文件註解。
換掉的：func 的本體（有回傳型別的換成 `return {}.get(0)`）（含本體裡的註解、多行字串、巢狀 lambda）。

規則抄自 caveman 的 code_gdscript.go（只讀過、沒執行），寫法是自己的：
GDScript 靠縮排定範圍，所以本體＝簽名之後縮排比 func 深的行；
但多行字串與括號裡的續行不看縮排，要一路追蹤字串與括號的狀態。
"""
import re
import sys

FUNC_RE = re.compile(r'^([ \t]*)(?:@[A-Za-z_]+(?:\([^)]*\))?[ \t]+)*(?:static[ \t]+)?func[ \t]+[A-Za-z_][A-Za-z0-9_]*[ \t]*\(')


class Scan:
    """跨行追蹤「在字串裡嗎、括號深幾層」。一行一行餵。"""

    def __init__(self):
        self.quote = None   # 目前在哪一種字串裡：'"""'、"'''"、'"'、"'"
        self.depth = 0

    def feed(self, line, stop_at_colon=False):
        """吃一行。stop_at_colon：回傳括號外第一個 `:` 的位置（簽名結尾），沒有就 -1。"""
        i, n = 0, len(line)
        while i < n:
            c = line[i]
            if self.quote:
                if c == '\\':
                    i += 2
                    continue
                if line.startswith(self.quote, i):
                    i += len(self.quote)
                    self.quote = None
                    continue
                i += 1
                continue
            if c == '#':
                break
            if line.startswith('"""', i) or line.startswith("'''", i):
                self.quote = line[i:i + 3]
                i += 3
                continue
            if c in '"\'':
                self.quote = c
            elif c in '([{':
                self.depth += 1
            elif c in ')]}':
                self.depth -= 1
            elif c == ':' and stop_at_colon and self.depth == 0:
                return i
            i += 1
        if self.quote in ('"', "'"):   # 單引號字串不會跨行；壞掉就重設，別讓整份檔跟著歪
            self.quote = None
        return -1

    @property
    def open(self):
        return self.quote is not None or self.depth > 0


def indent_of(line):
    return len(line) - len(line.lstrip(' \t'))


def is_code(line):
    s = line.strip()
    return s != '' and not s.startswith('#')


RET_RE = re.compile(r'->\s*([A-Za-z_][\w.\[\], ]*?)\s*$')


def elided(sig):
    """本體換成什麼。有回傳型別的不能只寫 pass（Godot：Not all code paths return a value）；
    `{}.get(0)` 是 Variant，靜態檢查對任何回傳型別都放行（2026-10-23 用 Godot 4.7 --check-only 驗過）。"""
    m = RET_RE.search(sig)
    if m and m.group(1) != 'void':
        return 'return {}.get(0) # body elided'
    return 'pass # body elided'


def outline(src):
    lines = src.split('\n')
    out, warn = [], []
    i, n = 0, len(lines)
    outer = Scan()   # 本體以外的行也要追字串與括號：多行字串裡長得像 func 的行不是函式
    while i < n:
        line = lines[i]
        m = None if outer.open else FUNC_RE.match(line)
        if not m:
            outer.feed(line)
            out.append(line)
            i += 1
            continue

        base = len(m.group(1))
        # ── 簽名：可能跨好幾行，結尾是括號外的第一個 `:` ──
        sc = Scan()
        sig = []
        colon = -1
        while i < n:
            colon = sc.feed(lines[i], stop_at_colon=True)
            sig.append(lines[i])
            i += 1
            if colon >= 0:
                break
        if colon < 0:            # 找不到簽名結尾：原樣吐回去，不猜，但要出聲
            out.extend(sig)
            warn.append(f'第 {i - len(sig) + 1} 行的 func 找不到簽名結尾，之後原樣輸出')
            continue
        last = sig[-1]
        stub = elided(' '.join(sig[:-1] + [last[:colon]]))
        rest = last[colon + 1:]
        if rest.split('#', 1)[0].strip():   # 單行函式 `func f(): return 1`
            sig[-1] = last[:colon + 1] + ' ' + stub
            out.extend(sig)
            sc = Scan()      # 單行本體也可能開了括號或多行字串，續行一起吃掉
            sc.feed(rest)
            while sc.open and i < n:
                sc.feed(lines[i])
                i += 1
            continue
        out.extend(sig)

        # ── 本體：縮排比 func 深的行，加上字串與括號裡的續行 ──
        body_indent = None
        sc = Scan()
        while i < n:
            cur = lines[i]
            if not sc.open:
                if not is_code(cur):
                    # 空行與註解：看下一行程式碼還在不在本體裡
                    j = i + 1
                    while j < n and not is_code(lines[j]):
                        j += 1
                    if j < n and indent_of(lines[j]) > base:
                        i += 1
                        continue
                    break
                if indent_of(cur) <= base:
                    break
                if body_indent is None:
                    body_indent = cur[:indent_of(cur)]
            sc.feed(cur)
            i += 1
        if body_indent is None:
            body_indent = m.group(1) + '\t'
        out.append(body_indent + stub)
    if outer.open:
        warn.append('檔尾時字串或括號還沒關，之後的 func 可能沒有被換掉')
    return '\n'.join(out), warn


def main(argv):
    sys.stdout.reconfigure(encoding='utf-8')   # .gd 滿是中文註解；Windows 的 cp950 主控台會 UnicodeEncodeError
    if not argv:
        print(__doc__.strip().split('\n')[2], file=sys.stderr)
        return 2
    rc = 0
    for k, path in enumerate(argv):
        with open(path, encoding='utf-8-sig') as f:
            src = f.read()
        if len(argv) > 1:
            print(('\n' if k else '') + '# ==> ' + path)
        text, warn = outline(src)
        sys.stdout.write(text)
        for w in warn:   # 大綱不完整要出聲：沉默的「大綱」會被當成完整的讀
            print(f'gd-outline: {path}: {w}', file=sys.stderr)
            rc = 1
        if not src.endswith('\n'):
            sys.stdout.write('\n')
    return rc


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
