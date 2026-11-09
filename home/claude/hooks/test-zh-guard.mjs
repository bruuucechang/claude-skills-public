#!/usr/bin/env node
// zh-guard.mjs 的案例表：node test-zh-guard.mjs（全過離開碼 0）
import './lib/test-config.mjs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const dir = mkdtempSync(join(tmpdir(), 'zh-guard-'));
process.env.HOOK_NOLOG = '1';
// 在 claude -p 底下跑時環境會帶 sdk-cli，zh-guard 就走「非互動放行」，要擋的案例全部變放行
process.env.CLAUDE_CODE_ENTRYPOINT = 'cli';
process.env.ZH_GUARD_SEEN = join(dir, 'seen.json');
const { run, findings, askText } = await import('./zh-guard.mjs');

let fail = 0, pass = 0;
const ok = (name, cond) => { if (!cond) { fail++; console.log(`✗ ${name}`); } else { pass++; console.log(`✓ ${name}`); } };
let n = 0;
const stop = (msg, extra = {}) => run({ session_id: `s${++n}`, stop_reason: 'end_turn', last_assistant_message: msg, ...extra });
const ask = (label, description = '說明', sid = `s${++n}`) =>
  run({ session_id: sid, tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: '選哪個？', header: '範圍', options: [{ label, description }] }] } });
const blocked = (r) => r?.decision === 'block';
const denied = (r) => r?.hookSpecificOutput?.permissionDecision === 'deny';
const chars = (f, k) => f[k].map((x) => x.ch).join('');

// 簡體
ok('純繁體放行', stop('我重新查了一遍現況，測試全過，已經推上去。') === null);
ok('回覆有簡體字擋', blocked(stop('我重新查了一遍现况，測試全過。')));
ok('抓出是哪幾個字', chars(findings('用户回答后，那个 session 挡下来'), 'simplified') === '户个挡来');
ok('后／只／里／台／系／面這種繁體也有的字單獨出現不擋', findings('皇后只在公里外的台系面前').simplified.length === 0);
ok('合併字的詞擋（共斗、之后、里面）', chars(findings('多人共斗之后在里面'), 'simplified') === '共斗之后里面');
ok('斗在本來的用法不擋（五斗米、漏斗、北斗、斗笠）', findings('不為五斗米折腰，漏斗、北斗七星、斗笠').simplified.length === 0);
ok('回覆有共斗擋', blocked(stop('首發就要 8 人共斗。')));
ok('同形但台灣幾乎只當簡體用的字擋（价格、确认、种类）', chars(findings('价格确认种类'), 'simplified') === '价确认种类');
ok('台灣照樣用的字不擋（群組、床、秘密、發霉）', findings('群組、床、秘密、高峰、發霉、虱目魚').simplified.length === 0);
ok('行內 code 裡的不算', stop('資料夾是 `~/Desktop/漫画人`，已經刪掉。') === null);
ok('圍欄程式碼裡的不算', stop('結果如下：\n```\n第001话 开始\n```\n都對。') === null);
ok('路徑裡的不算（含中文資料夾名）', stop('檔案在 ~/Desktop/漫画人/a.jpg，已經刪掉。') === null);
ok('路徑後面的句子照樣檢查', blocked(stop('檔案在 ~/Desktop/a.jpg，已经刪掉。')));
ok('全形斜線不是路徑', blocked(stop('冶煉爐／料理台的画面')));
ok('日文（前後有假名）不算', findings('中條彩未（中条あやみ）已經刪掉').simplified.length === 0);
ok('理由講出字與前後文', /「况」（.*现况/.test(stop('我重新查了一遍现况。').reason));

// 字碼相近的錯字（劑→劍，2026-10-28）
ok('選項裡的劑士擋（每次都擋）', denied(ask('劑士 → 劑豪', '說明', 'lk')) && denied(ask('劑士 → 劑豪', '說明', 'lk')));
ok('回覆裡的劑術擋', blocked(stop('樹照現在頁面上的版本，但「劑術」跟「加攻擊」是兩條路。')));
ok('理由講出對的字', /多半是「劍」打錯/.test(stop('劍士與劑術').reason));
ok('正當用法不擋（藥劑、劑量、營養劑、空氣清新劑）', findings('怒力藥劑、注意劑量、營養劑、空氣清新劑').typo.length === 0);
ok('正當詞旁邊的錯字照樣抓', chars(findings('抗火藥劑配劑術'), 'typo') === '劑');
ok('自由造詞的劑不擋（安慰劑、氧化劑、第五劑、大劑量、鐵劑）', findings('安慰劑、氧化劑、第五劑疫苗、幾劑、大劑量、鐵劑、單獨一個劑').typo.length === 0);
ok('前接字也抓（長劑、銅劑）', findings('拿長劑').typo.length === 1 && findings('銅劑也能洗出').typo.length === 1);
ok('同一則的每一處都列出來', (stop('劑士……很長一段……劑術').reason.match(/劑士.*劑術/) ?? []).length === 1);
ok('行內 code 引用不算', stop('把 `劑` 改成劍了。') === null);
ok('劍本身放行', stop('劍士轉劍豪，劍術一條路。') === null);

// 冷僻字
ok('冷僻字擋（闃出）', blocked(stop('Mac 上會闃出一個視窗。')));
ok('冷僻字抓得到（趥、鐤、擐）', chars(findings('每一趥都要規劃，金屬鐤，成本擐得住'), 'rare') === '趥鐤擐');
ok('白名單的不擋（日本地名、生物名）', findings('知床岬、淀屋橋、幽暝螈、閾值').rare.length === 0);
ok('使用者打過的日文漢字不擋', findings('駅、鉄、関').rare.length === 0);
ok('同一個 session 同一個冷僻字只擋一次', (() => {
  const a = ask('闃出視窗', '說明', 'same'); const b = ask('闃出視窗', '說明', 'same');
  return denied(a) && b === null;
})());
ok('換一個冷僻字照樣擋', denied(ask('一趥', '說明', 'same')));
ok('簡體字每次都擋（不記 session）', denied(ask('删除', '說明', 'same2')) && denied(ask('删除', '說明', 'same2')));

ok('沒有 session id 不擋冷僻字（記不住就放行）', run({ stop_reason: 'end_turn', last_assistant_message: '每一趥都要規劃。' }) === null);
ok('沒有 session id 照樣擋簡體字', blocked(run({ stop_reason: 'end_turn', last_assistant_message: '我重新查了一遍现况。' })));
{
  const keep = process.env.ZH_GUARD_SEEN;
  process.env.ZH_GUARD_SEEN = join(dir, 'no-such-dir', 'seen.json');
  const { run: run2 } = await import('./zh-guard.mjs?unwritable');
  const a = run2({ session_id: 'w', tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: '每一趥？', options: [] }] } });
  ok('紀錄寫不進去就不擋冷僻字', a === null);
  process.env.ZH_GUARD_SEEN = keep;
}
ok('收尾的理由提到「同時被要求整則重寫就整則重寫」（跟 lang-guard 一起擋時不矛盾）', /整則重寫/.test(stop('现况').reason));

// 選項框
ok('選項的 description 有簡體字擋', denied(ask('刪除按鈕', '画面上約三倍寬')));
ok('選項全繁體放行', ask('只擋選項框', '最常出事的地方先擋；回覆照舊。') === null);
ok('選項的理由寫「選項」', /選項有簡體字/.test(ask('暂停').hookSpecificOutput.permissionDecisionReason));
ok('askText 收 question／header／label／description／preview', askText({ questions: [{ question: 'Q', header: 'H', options: [{ label: 'L', description: 'D', preview: 'P' }] }] }) === 'Q\nH\nL\nD\nP');

// 放行條件
ok('已經被擋過一次的回合放行', stop('现况', { stop_hook_active: true }) === null);
ok('stop_reason 不是 end_turn 放行', stop('现况', { stop_reason: 'tool_use' }) === null);
ok('系統訊息放行', stop("You've hit your limit 现况") === null);
ok('壞輸入放行', run(null) === null && run({}) === null && run({ tool_name: 'AskUserQuestion', tool_input: { questions: 'x' } }) === null);
process.env.CLAUDE_CODE_ENTRYPOINT = 'sdk-cli';
ok('非互動放行', stop('现况') === null);
delete process.env.CLAUDE_CODE_ENTRYPOINT;

rmSync(dir, { recursive: true, force: true });
if (fail) { console.log(`${fail} 個失敗`); process.exit(1); }
console.log(`全過，${pass} 過`);
