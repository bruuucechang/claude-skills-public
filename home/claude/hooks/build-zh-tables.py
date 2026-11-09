#!/usr/bin/env python3
"""產 zh-guard.mjs 用的兩張字表（結果進版控，hook 執行時不需要 Python 也不需要 OpenCC）。

    python3 -m venv /tmp/v && /tmp/v/bin/pip install opencc
    /tmp/v/bin/python build-zh-tables.py

- zh-simplified.txt：簡體專用字。取 OpenCC 的 STCharacters（簡→繁）裡「繁體候選不含自己」的字，
  再拿 s2tw 轉一次、轉完不變的剔除（群、床、秘、峰在 OpenCC 會轉成羣、牀、祕、峯，台灣照樣用前者）。
- zh-common.txt：Big5 第一字面（A440–C67E，5401 字，出自教育部常用國字標準字體表）。用標準函式庫的 big5 codec 解，不靠網路。

zh-allow.txt 是手寫的（使用者自己打過的字、確認過的專有名詞），不由這支產。
"""
import os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
CJK = lambda c: '一' <= c <= '鿿'

def simplified():
    import opencc
    share = os.path.join(os.path.dirname(opencc.__file__), 'clib', 'share', 'opencc')
    tool = os.path.join(os.path.dirname(opencc.__file__), 'clib', 'bin', 'opencc_dict')
    out = os.path.join(HERE, '.st.tmp')
    subprocess.run([tool, '-i', os.path.join(share, 'STCharacters.ocd2'), '-o', out, '-f', 'ocd2', '-t', 'text'], check=True)
    tw = opencc.OpenCC('s2tw')
    chars = set()
    for line in open(out, encoding='utf-8'):
        k, v = line.rstrip('\n').split('\t')
        if len(k) == 1 and CJK(k) and k not in v.split() and tw.convert(k) != k:
            chars.add(k)
    os.remove(out)
    return chars

def common():
    chars = set()
    for hi in range(0xA4, 0xC7):
        for lo in list(range(0x40, 0x7F)) + list(range(0xA1, 0xFF)):
            if (hi, lo) > (0xC6, 0x7E):
                continue
            try:
                c = bytes([hi, lo]).decode('big5')
            except UnicodeDecodeError:
                continue
            if CJK(c):
                chars.add(c)
    return chars

TW_OK = set('霉肴虱苧')                      # 發霉、佳肴、虱目魚、苧麻
SIMPLIFIED_EVEN_IF_BIG5 = set('么儿听坏并扑晒')  # 什么、儿子、听说、坏掉、并且、扑克、晒太阳

# OpenCC 認為繁體也有這個字（候選含自己），所以上面那條規則撈不到；但它們不在常用字表，
# 在台灣的中文句子裡出現幾乎都是簡體（价格、种类、确认、据说）。2026-10-22 從 26 個這種字裡挑的；
# 沒挑的（淀、熏、厘、涂、棱、亘、跖、膻）留給冷僻字檢查：淀是日本地名、厘是公厘、涂是姓。
SAME_SHAPE_SIMPLIFIED = set('适胜苹腊蚝蝎蜡厂叶党广确种极据柜万价')

def write(name, chars, head):
    s = ''.join(sorted(chars))
    with open(os.path.join(HERE, name), 'w', encoding='utf-8') as f:
        f.write(f'# {head}（build-zh-tables.py 產，{len(s)} 字，不要手改）\n')
        for i in range(0, len(s), 80):
            f.write(s[i:i + 80] + '\n')
    print(name, len(s))

if __name__ == '__main__':
    c = common()
    s = simplified()
    assert len(c) == 5401, len(c)
    # 兩邊都有的字：台灣也正常用的不擋，其餘在現代台灣文字裡幾乎都是打成簡體（2026-10-22 逐字判過）
    s -= TW_OK
    s |= SAME_SHAPE_SIMPLIFIED
    assert s & c == SIMPLIFIED_EVEN_IF_BIG5 | (SAME_SHAPE_SIMPLIFIED & c), sorted(s & c)   # OpenCC 或 Big5 表變了就停下來重判
    write('zh-common.txt', c, 'Big5 第一字面：台灣常用字')
    write('zh-simplified.txt', s, '簡體專用字：台灣繁體不用')
