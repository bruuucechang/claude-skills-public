#!/usr/bin/env node
/**
 * SessionStart ＋ UserPromptSubmit hook —— 每個 session 自動取名「專案名｜專案細項」。
 *
 * ## 為什麼要有
 *
 * 2026-10-16 使用者：「每開一個新的 session，如果是專案用的就幫它命名，
 * 不要跟我說視窗編號或奇怪的數字，人類看不懂。」
 * 2026-10-22 改成**每個** session 都要（家目錄開的也算），細項要像摘要、不是截第一句話，
 * 裁示用 Haiku 判讀第一句話，例如 `animyria｜git graft 研究`。
 *
 * ## 怎麼做
 *
 *   - SessionStart（startup／clear）：cwd 認得出專案 → 標題先掛 `<專案>`。resume／compact 不動。
 *   - UserPromptSubmit，第一句「不是斜線指令」的話：
 *       1. 馬上給規則版標題 `<專案>｜<截第一句>`（不擋使用者，Haiku 要 5～6 秒，2026-10-22 實測）。
 *       2. 背景開一個 `claude -p --model haiku`（本檔的 --name 模式）挑專案、寫 10 字內細項，
 *          寫進狀態檔，並在 transcript 補一行 custom-title（/resume 清單看得到）。
 *   - 之後任何一句送出時，Haiku 版好了還沒套 → 套上（hook 只有這兩個事件能改標題，
 *     Stop／PostToolUse 回 sessionTitle 沒作用，2026-10-22 實測）。
 *
 * 自動換手（handoff-open 在 /clear 後打的那行固定開場白）：第一句永遠一樣，拿它取名每個換手 session
 * 都叫「照開場資料裡的換手開場白做…」（2026-10-23 使用者：clear 之後名字沒變）——改讀那行指的開場白檔，
 * 用交接單的標題當細項、交接單內文給 Haiku、快照的 cwd 認專案。
 *
 * 專案怎麼認：cwd 在 `~/Projects/<名字>/` → 固定是它；在 `~/.claude*` → `claude設定`；
 * 其他（家目錄…）→ Haiku 從 ~/Projects 清單＋`claude設定`＋`雜項` 挑，規則版先看第一句有沒有提到專案名。
 * 標題欄位是 Claude Code 的 hookSpecificOutput.sessionTitle（2.1.301 起實測可用）。
 *
 * 逃生門：`touch ~/.claude/skills/home/claude/hooks/session-title.off`
 */

import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cli, isMain } from './lib/hook-cli.mjs';
import { appendLog } from './lib/log.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const PROJECTS = join(homedir(), 'Projects');
const STATE = join(tmpdir(), 'claude-session-title');
const MAX_SUMMARY = 18;
const MAX_DETAIL = 10; // 叫 Haiku 守的長度
const HARD_DETAIL = 16; // 超過才截（Haiku 常超個兩三字，截在 12 會斷在半個詞）
const SETTINGS = 'claude設定';
const MISC = '雜項';

const inside = (base, p) => {
  const rel = relative(base, p);
  return rel && rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel) ? rel : null;
};
const within = (base, p) => p === base || inside(base, p) != null;

/** cwd 就決定得了的專案；決定不了回 null。 */
export function projectOf(cwd) {
  if (!cwd) return null;
  const rel = inside(PROJECTS, cwd);
  // 專案名看 git 倉庫，不看資料夾名：animyria-lanes/v4d5、animyria-pixgen 是 animyria 的工作目錄，
  // animyria-lora-xc 是 animyria-lora 的（2026-10-23 使用者：他是哪個專案的就歸哪裡）。沒有 remote 才退回資料夾名。
  // 倉庫名剛好是 ~/Projects 底下另一個資料夾才歸過去；倉庫名跟資料夾名本來就不同的（interior-designer 的倉庫叫 interiordesign）照資料夾名
  if (rel) {
    const dir = rel.split(sep)[0];
    const repo = repoOf(cwd) || repoOf(join(PROJECTS, dir));
    // 比對實際的資料夾名（磁碟不分大小寫，News 的倉庫叫 news 時 existsSync 也會成立）
    if (repo && repo !== dir && dirNames().includes(repo)) return repo;
    return dir.replace(/-lanes$/, '') || null;
  }
  const h = homedir();
  if (/^\.(claude|codex)(-|$)/.test(relative(h, cwd).split(sep)[0]) && within(h, cwd)) return SETTINGS;
  return null;
}

const dirNames = () => { try { return readdirSync(PROJECTS); } catch { return []; } };

/** 目錄的 origin 倉庫名（.../animyria-lora.git → animyria-lora）；不是 git、沒有 origin 回 null。
 *  直接讀 .git/config、不跑 git：listProjects 一次要查 30 幾個資料夾，跑在送出第一句的路徑上（PR #45 審查）。
 *  往上找 .git（cwd 常在子目錄）；.git 是檔案＝worktree，設定在 commondir 指的主倉庫。 */
export function repoOf(dir) {
  try {
    let d = realpathSync(dir);
    const h = homedir();
    for (; within(h, d); d = dirname(d)) {
      const g = join(d, '.git');
      if (!existsSync(g)) continue;
      let gitdir = g;
      if (statSync(g).isFile()) {
        gitdir = resolve(d, readFileSync(g, 'utf8').match(/^gitdir:\s*(.+)$/m)[1].trim());
        const common = join(gitdir, 'commondir');
        if (existsSync(common)) gitdir = resolve(gitdir, readFileSync(common, 'utf8').trim());
      }
      const conf = readFileSync(join(gitdir, 'config'), 'utf8');
      const url = conf.split(/^\[/m).find((sec) => /^remote "origin"\]/.test(sec))?.match(/^\s*url\s*=\s*(.+)$/m)?.[1];
      return url ? url.trim().replace(/\.git$/, '').replace(/\/+$/, '').split(/[/:]/).pop() || null : null;
    }
  } catch {}
  return null;
}

/** 候選專案：~/Projects 底下各資料夾照 projectOf 歸好、去重（同一個 repo 的幾份工作目錄只算一個）。 */
export function listProjects() {
  try {
    const names = readdirSync(PROJECTS, { withFileTypes: true })
      .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
      .map((d) => projectOf(join(PROJECTS, d.name)));
    return [...new Set(names.filter(Boolean))];
  } catch { return []; }
}

/** 第一句裡提到的專案名（取最長的，免得 animyria 蓋掉 animyria-lora）。
 *  前後不能接英數字或 -，「News feed」才不會被 news 以外的字串誤中、「office hours」照樣會中，所以清單裡的普通英文字最好別單獨當專案名。 */
export function mentioned(prompt, projects) {
  const p = String(prompt || '');
  const esc = (n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return projects.filter((n) => new RegExp(`(^|[^A-Za-z0-9-])${esc(n)}($|[^A-Za-z0-9-])`, 'i').test(p))
    .sort((a, b) => b.length - a.length)[0] || null;
}

/** 第一句在講 Claude Code 本身（取名、hook、skill、記憶檔…）→ claude設定。
 *  先於 mentioned()：「session 取名把 animyria 弄錯了」講的是設定，不是 animyria（2026-10-23）。
 *  session／hook／skill／取名 單獨出現太普通（webhook、login session、角色取名），要兩個不同的一起出現才算；強訊號一個就算。 */
const STRONG = /CLAUDE\.md|AGENTS\.md|settings\.json|記憶檔|status ?line|斜線指令/i;
const WEAK = [/(?<![A-Za-z-])sessions?(?![-A-Za-z])/i, /(?<![A-Za-z-])hooks?(?![-A-Za-z])/i, /(?<![A-Za-z-])skills?(?![-A-Za-z])/i, /取名|命名/];
export const aboutSettings = (text) => {
  const t = String(text || '');
  return STRONG.test(t) || WEAK.filter((r) => r.test(t)).length >= 2;
};

/** handoff-open 打的開場白 → { title, text, cwd }；不是開場白回 null，讀不到檔回空的（照樣不拿開場白那行取名）。 */
const OPENER = /^照開場資料裡的換手開場白做（沒有的話讀 (.+?\.prompt\.md)）/;
export function handoffBrief(prompt) {
  const m = String(prompt || '').trim().match(OPENER);
  if (!m) return null;
  let all;
  try { all = readFileSync(m[1], 'utf8'); } catch { return { title: null, text: '', cwd: null }; }
  const body = (all.split(/^## 交接單全文$/m)[1] ?? all).split(/^## 現況快照/m)[0].trim();
  // 只找第一個 code block 之前的：沒有 H1 時，code block 裡的 `# 註解` 不能被當成標題（H1 前面常有 Account／cwd 兩行，不能只認第一行）
  const title = body.split(/^```/m)[0].match(/^# (?:交接[：:]\s*)?(.+)$/m)?.[1].trim() || null;
  // 交接單路徑不能拿來當 cwd（常放在 ~/.claude-*/jobs/… 底下，會被認成 claude設定）
  const cwd = all.match(/^## 現況快照（recon-check，cwd (.+?)，exit/m)?.[1] || all.match(/^工作目錄是 (.+?)（不一樣就 cd 過去）/m)?.[1] || null;
  return { title, text: body, cwd };
}

const stripTags = (s) => String(s || '').replace(/<[^>]+>[\s\S]*?<\/[^>]+>/g, ' ');

// 第一行、去掉客套開頭與結尾標點，截到 MAX_SUMMARY 個字。
export function summarize(prompt) {
  let s = stripTags(prompt).split('\n').map((l) => l.trim()).find(Boolean) || '';
  s = s.replace(/^((那|好|嗯|欸|ok|OK)[，,、\s]+|那(?=可以|幫|請|你|麻煩)|(請你|請|麻煩你|麻煩|你可以|可以|能不能|你幫我|幫我|幫忙)[，,、\s]*)+/, '')
       .replace(/(嗎|呢)?[。．.！!？?，,、~～\s]*$/, '')
       .trim();
  const chars = [...s];
  return chars.length > MAX_SUMMARY ? chars.slice(0, MAX_SUMMARY).join('') + '…' : s;
}

/** Haiku 的回覆 → 標題；不合格回 null。fixed 有值時專案不讓 Haiku 改。 */
export function parseNamer(text, { fixed, candidates }) {
  const m = String(text || '').match(/\{[^{}]*\}/);
  if (!m) return null;
  let j;
  try { j = JSON.parse(m[0]); } catch { return null; }
  const project = fixed || (candidates.includes(j.project) ? j.project : null);
  if (typeof j.detail !== 'string') return null;
  let detail = j.detail.replace(/[｜|。．！!？?\n]/g, ' ').replace(/\s+/g, ' ').trim();
  if (!project || !detail) return null;
  const chars = [...detail];
  if (chars.length > HARD_DETAIL) detail = chars.slice(0, HARD_DETAIL).join('') + '…';
  return `${project}｜${detail}`;
}

const emit = (event, title) => ({ hookSpecificOutput: { hookEventName: event, sessionTitle: title } });

const readState = (mark) => { try { return JSON.parse(readFileSync(mark, 'utf8')); } catch { return null; } };
// 先寫暫存檔再 rename：hook 跟背景 namer 會同時讀寫，不能讓對方讀到寫一半的檔
const writeState = (mark, s) => {
  mkdirSync(STATE, { recursive: true });
  const tmp = `${mark}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(s));
  renameSync(tmp, mark);
};

/** 狀態檔一個 session 一個，開場時順手清掉 7 天前的。 */
function sweep() {
  try {
    const old = Date.now() - 7 * 86400e3;
    for (const f of readdirSync(STATE)) {
      const p = join(STATE, f);
      if (statSync(p).mtimeMs < old) unlinkSync(p);
    }
  } catch {}
}

/** transcript 最前面 64KB（/clear 抄過來的舊名字寫在開頭）。 */
function head(file, n = 65536) {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.alloc(n);
    return buf.toString('utf8', 0, readSync(fd, buf, 0, n, 0));
  } finally { closeSync(fd); }
}

/** transcript 最後 64KB（長 session 的 transcript 動輒幾十 MB，這在送出訊息的路徑上）。 */
function tail(file, n = 65536) {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const len = Math.min(n, size);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    return buf.toString('utf8');
  } finally { closeSync(fd); }
}

/** transcript 裡最後一個 custom-title；使用者 /rename 過就跟我們給的不一樣。
 *  只看尾端：custom-title 每輪都會被 Claude Code 重寫一次，不會只出現在很前面。 */
export function lastTitle(transcript) {
  try {
    const t = tail(transcript);
    const all = [...t.matchAll(/"type":"custom-title","customTitle":"((?:[^"\\]|\\.)*)"/g)];
    return all.length ? JSON.parse(`"${all.at(-1)[1]}"`) : null;
  } catch { return null; }
}
/** /clear 時 Claude Code 把上一個 session 的名字抄進新 transcript 的開頭（2026-10-22 實測，2.1.307），
 *  那不是使用者取的，不能當成 /rename。只認 SessionStart hook 那一行之前的：
 *  上一個 session 沒名字時開頭沒有這行，之後使用者 /rename 的一定排在 SessionStart 後面。 */
export function firstTitle(transcript) {
  try {
    const h = head(transcript);
    const cut = h.indexOf('"hookEvent":"SessionStart"');
    if (cut < 0) return null;
    const m = h.slice(0, cut).match(/"type":"custom-title","customTitle":"((?:[^"\\]|\\.)*)"/);
    return m ? JSON.parse(`"${m[1]}"`) : null;
  } catch { return null; }
}
const renamedByUser = (st) => {
  if (!st.transcript) return false;
  const t = lastTitle(st.transcript);
  return t != null && t !== st.title && t !== st.fallback && t !== st.inherited;
};

/** 這個 session 的終端機 { tty: '/dev/ttysNNN', pid }。hook 不一定掛在終端機上，沿父程序往上找到 claude 那層；
 *  pid 是掛在那個終端機上的程序，寫標題前拿它確認終端機沒換人（namer 最多跑 45 秒，分頁可能關掉又被別格拿去用）。 */
const psTty = (pid) => execFileSync('ps', ['-o', 'ppid=,tty=', '-p', String(pid)], { encoding: 'utf8', timeout: 1000 }).trim().split(/\s+/);
export function sessionTty(pid = process.pid) {
  for (let i = 0; i < 6 && pid > 1; i++) {
    try {
      const [ppid, tty] = psTty(pid);
      if (/^ttys?\d+$/.test(tty)) return { tty: `/dev/${tty}`, pid };
      pid = Number(ppid);
    } catch { return null; }
  }
  return null;
}
const stillOn = ({ tty, pid }) => { try { return `/dev/${psTty(pid)[1]}` === tty; } catch { return false; } };

function startNamer(mark) {
  try {
    spawn(process.execPath, [SELF, '--name', mark], { detached: true, stdio: 'ignore' }).unref();
  } catch {}
}

export function run(input, { spawnNamer = startNamer, projects: list = listProjects } = {}) {
  if (existsSync(join(HERE, 'session-title.off'))) return null;
  if (!input || !input.session_id) return null;
  const event = input.hook_event_name;
  const mark = join(STATE, input.session_id);

  if (event === 'SessionStart') {
    if (input.source !== 'startup' && input.source !== 'clear') return null;
    const project = projectOf(input.cwd);
    sweep();
    writeState(mark, { phase: 'pending', cwd: input.cwd, transcript: input.transcript_path || null, source: input.source });
    return project ? emit(event, project) : null;
  }

  if (event !== 'UserPromptSubmit') return null;
  const st = readState(mark);
  // 沒有狀態檔＝不是這支開場命名的（resume 進來的）
  if (!st) return null;

  if (st.phase === 'ready') {
    writeState(mark, { ...st, phase: 'done' });
    return renamedByUser(st) ? null : emit(event, st.title);
  }
  if (st.phase !== 'pending') return null;
  const transcript = input.transcript_path || st.transcript || null;
  // /clear 抄過來的上一個 session 的名字（開場時 transcript 還沒寫，所以第一句才讀）
  // startup 不算：`claude -n 名字`、開場 /rename 的名字也寫在 SessionStart 那行之前（2.1.307 實測）。
  // 但沒有 source 的要算：source 是 #39 才記的，之前開場的 session 沒有它（2026-10-23 這個 session 就這樣卡在舊名字）
  const inherited = transcript && st.source !== 'startup' ? firstTitle(transcript) : null;
  // 開場後、第一句之前就 /rename 過：不動（開場沒掛名時，抄過來的以外任何 custom-title 都是使用者給的）
  if (transcript && renamedByUser({ transcript, title: projectOf(input.cwd), inherited })) {
    writeState(mark, { ...st, phase: 'done' });
    return null;
  }

  const prompt = String(input.prompt || '').trim();
  if (!prompt || prompt.startsWith('/')) return null;
  const brief = handoffBrief(prompt);
  const text = brief ? brief.text : stripTags(prompt);
  const projects = list();
  // 換手的 session 以交接單的工作目錄為準：handoff-open 在哪一格 /clear，cwd 就是那格原本的目錄，
  // 跟接手的工作無關（在 animyria 那格接手改 skills，會被叫成 animyria，2026-10-23）
  const fixed = (brief && projectOf(brief.cwd)) || projectOf(input.cwd);
  const about = brief ? brief.title || '' : text;
  const project = fixed || (aboutSettings(about) ? SETTINGS : mentioned(about, projects)) || MISC;
  // 交接單標題常以專案名開頭（「interior-designer 照度分析…」），標題前面已經有專案了，不重複
  // 後面要接分隔字元才算，「animyria-lanes …」不能被切成「-lanes …」
  const lead = new RegExp(`^${project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?=$|[^A-Za-z0-9-])`, 'i');
  const summary = brief
    ? summarize((brief.title || '').replace(lead, '').replace(/^[\s：:，,]+/, '') || '接手上一個 session')
    : summarize(prompt);
  if (!summary) return null; // 「你好」之類沒內容的，等下一句
  const title = `${project}｜${summary}`;
  // headless（claude -p、Agent SDK、派工的背景 session）沒人看標題，不為它多花一次 Haiku、不把 prompt 再送一次。
  // Windows 也不叫：claude 是 claude.cmd，非經 cmd.exe 不可，而 cmd.exe 不會好好跳脫 prompt 裡的 & | "
  const ep = process.env.CLAUDE_CODE_ENTRYPOINT || '';
  if (/^(sdk|mcp)/.test(ep) || process.platform === 'win32') {
    writeState(mark, { phase: 'done', title });
    return emit(event, title);
  }
  writeState(mark, {
    phase: 'naming', title, fallback: title, fixed, candidates: [...projects, SETTINGS, MISC],
    cwd: input.cwd, prompt: [...(text.trim() || summary)].slice(0, 800).join(''), handoff: !!brief,
    transcript, session: input.session_id, inherited, term: sessionTty(),
  });
  spawnNamer(mark);
  return emit(event, title);
}

/** namer 失敗：記一行 log、狀態標 failed（留著規則版標題，不再等）。 */
const fail = (mark, msg) => {
  appendLog(join(HERE, 'session-title.log'), { at: new Date().toISOString(), session: mark.split(sep).at(-1), msg });
  const st = readState(mark);
  if (st && st.phase === 'naming') writeState(mark, { ...st, phase: 'failed' });
};

/** 背景模式：叫 Haiku 取名，寫回狀態檔與 transcript。任何失敗就留著規則版標題。 */
function name(mark) {
  const st = readState(mark);
  if (!st || st.phase !== 'naming') return;
  const ask = [
    '幫一個 Claude Code 工作階段取標題。只輸出一行 JSON：{"project":"…","detail":"…"}',
    st.fixed ? `project 固定是「${st.fixed}」。` : `project 從這份清單挑一個最符合的，原樣照抄：${st.candidates.join('、')}。改 Claude Code 設定、hook、skill、記憶檔選「${SETTINGS}」；都不像就選「${MISC}」。`,
    `detail：用繁體中文寫這次要做的事，${MAX_DETAIL} 個字以內，名詞片語，不要客套、不要標點，專有名詞保留原文。`,
    `工作目錄：${st.cwd}`,
    st.handoff ? `這個 session 接手的交接單（節錄）：\n${st.prompt}` : `使用者的第一句話：\n${st.prompt}`,
  ].join('\n');
  let out;
  try {
    out = execFileSync('claude', ['-p', ask, '--model', 'haiku', '--setting-sources', '',
      '--settings', '{"disableAllHooks":true}', '--no-session-persistence', '--tools', '',
      '--strict-mcp-config', '--system-prompt', '你只輸出 JSON，不輸出其他文字。'],
    { encoding: 'utf8', timeout: 45000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (e) { fail(mark, `claude -p 失敗：${e.code || e.status || e.message}`); return; }
  const title = parseNamer(out, st);
  const now = readState(mark);
  if (!title) { fail(mark, `Haiku 回覆不合格：${String(out).slice(0, 200)}`); return; }
  if (!now || now.phase !== 'naming') return;
  writeState(mark, { ...now, phase: 'ready', title });
  // 直接改那一格的終端機標題（OSC 0）：hook 只能在下一句送出時改名，自動換手的 session 自己跑、不會有下一句，
  // 規則版標題就一直掛著（2026-10-23 使用者：還是寫雜項啊）。下一句送出時 hook 照樣再套一次同一個名字。
  if (st.term && stillOn(st.term) && !(st.transcript && renamedByUser(st))) {
    try { appendFileSync(st.term.tty, `\x1b]0;${title.replace(/[\x00-\x1f\x7f-\x9f]/g, '')}\x07`); } catch {}
  }
  // 補一行 custom-title 讓 /resume 清單看得到。這是 Claude Code 自己 /rename 寫的格式（非公開），
  // 單行 O_APPEND 寫入；使用者已經 /rename 過、或檔尾不是完整一行就不寫，免得黏在半行後面
  if (st.transcript && existsSync(st.transcript) && !renamedByUser(st) && tail(st.transcript, 1) === '\n') {
    try {
      appendFileSync(st.transcript, JSON.stringify({ type: 'custom-title', customTitle: title, sessionId: st.session }) + '\n');
    } catch {}
  }
}

if (isMain(import.meta.url)) {
  const i = process.argv.indexOf('--name');
  if (i > 0) name(process.argv[i + 1]);
  else cli(run);
}
