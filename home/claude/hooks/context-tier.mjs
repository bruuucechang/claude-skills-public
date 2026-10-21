#!/usr/bin/env node
/**
 * UserPromptSubmit hook —— 前文長到該回收時說一聲，分兩層。
 *
 * ## 為什麼是這個機制，不是「我自己注意一點」
 *
 * **模型自己既不能 `/compact` 也不能關 session**——兩個都是 harness 的動作。
 * 所以這支不「幫你」做，它只做三件事：把回收變成無損（靠 session-journal.mjs
 * 已經把每回合落地）、在該做的時候講、以及讓接續有東西可接。
 * 這個分工是 2026-09-24 從 M5 Pro 上 peter 的 `context-journal` 學來的。
 *
 * ## 門檻是實測來的，不是抄的
 *
 * 2026-09-24 掃 Air 近 7 天 17,775 個助理輪次（`input + cache_read +
 * cache_creation`，也就是模型那一輪實際看到多少）：
 *
 *   中位數 429k   p25 234k   p75 677k   p95 922k   最大 1000k
 *
 * 視窗是 1M，所以中位數已經在半滿。同期 **cache_read 佔全部 token 的 98.5%**
 * ——錢幾乎全花在「每一輪把整份累積的前文重讀一次」。最貴的單一 session
 * 跑了 7,673 輪／10,079 分鐘（七天沒關），一個就吃掉那 7 天總量的 25%。
 *
 * 門檻照著這個分佈訂，不是照別台機器的（peter 的視窗較小，他用 300k/600k）：
 *
 *   TIER1 500k（≈ 半滿，落在中位數與 p75 之間）→ `/compact`，無損
 *   TIER2 800k（≈ p90）→ 產交接單、關掉、另開
 *
 * 為什麼 TIER2 不是「繼續 compact 就好」：compact 是**有損摘要**，而且會讓
 * 整份 prompt cache 失效（下一輪從零重建）。到這個量級，乾淨新 session ＋
 * 一頁交接單起手約 30k，比留著 50k+ 的摘要殘渣繼續滾划算。
 *
 * ## 第三層：累積量（2026-09-26 加）
 *
 * 上面兩層看的是**當下這一輪**的 context，而那漏掉一整類昂貴的 session：
 * **乖乖 compact、尖峰從來不破 800k、但一直不關**的那種。回測 Air 近 30 天
 * 90 個 session（累積 ctx 合計 61.3B）：
 *
 *   p50 43M   p75 320M   p90 1,037M   p95 1,484M   最大 31,602M
 *
 * 最貴的 15 個裡有兩個（632M 與 516M）**尖峰從沒超過 800k**，TIER2 對它們
 * 永遠不開火，但它們各自燒掉半個 B。所以第三層看的是
 * **這個 session 到目前為止累積燒掉多少**。
 *
 * 門檻 `CUM_BASE` = 500M：攔到 16.7% 的 session，涵蓋 **89.3%** 的花費。
 * （1B 是 p90、涵蓋 82.2%，但會漏掉上面那兩條漏網之魚；300M 涵蓋 94.4%，
 * 但會吵到四分之一的 session，叫太多次的下場是連前兩層一起被當雜訊。）
 *
 * **叫一次不夠，所以每翻一倍再叫一次。** 同一份回測：最貴那個 session
 * 若攔在 1B，**之後還會再燒 30.6B——佔它自己的 97%**。叫過一次就繼續跑，
 * 是這件事最常見的結局，所以倍數要寫在訊息裡，而且語氣隨倍數加重。
 *
 * 累積量**不會因為 `/compact` 變少**——compact 只壓下一輪的 context，
 * 已經付掉的不會回來。所以第三層的建議一律是換手，不是壓縮。
 *
 * ## 不連環叫
 *
 * 前兩層：同一層每 `COOLDOWN_MIN` 分鐘最多一次；**升層立刻說**，不等冷卻——
 * 「從建議壓縮變成建議換手」本身就是新資訊。
 * 第三層：只在**跨過新的倍數**時叫，不靠冷卻（翻倍本身就是節流器）。
 *
 * 逃生門：`touch ~/.claude/skills/home/claude/hooks/context-tier.off`
 * 稽核：每次判斷寫進 context-tier.log，之後可以實際量它有沒有效。
 */

import { closeSync, existsSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, writeFileSync } from 'node:fs';
import { appendLog } from './lib/log.mjs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { cli, isMain } from './lib/hook-cli.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const OFF = join(HERE, 'context-tier.off');
const LOG = join(HERE, 'context-tier.log');
const STATE = join(homedir(), '.claude', 'session-logs', '.tier-state.json');
/** state 的格式版本。2＝累積量依 message.id 去重；舊版的 cum 是灌水的，版本不符就整份重掃一次。 */
const STATE_V = 2;

const TIER1 = 500_000;
const TIER2 = 800_000;
const CUM_BASE = 500_000_000;
const COOLDOWN_MIN = 20;

/**
 * 從上次掃到的位元組位置接著往下掃，回報這段新增內容裡的
 * 累積 ctx、輪次，以及最後一筆的 ctx。
 *
 * **為什麼要記 offset**：累積量沒辦法從檔尾算，而每次 prompt 都重掃整份
 * 是不能接受的——最大的那份 transcript 是 267 MB。記住掃到哪裡之後，
 * 每次只處理新長出來的那幾 KB。第一次看到某個 session 才會整份補掃一次，
 * 之後每輪是 0 bytes／1 ms。**補掃成本實測**（2026-09-26，Air）：
 *
 *   30 MB   142 ms      267 MB（史上最大那份）  1.2〜1.3 秒，端到端 1.3〜1.5 秒
 *
 * 一個 session 只會付一次，之後歸零。耗時與掃了幾 bytes 都寫進 log，
 * 哪天變慢可以直接查，不用重新推理。
 *
 * ⚠️ **切位元組再解碼，切點會落在多位元組字元中間。** transcript 整段都是中文，
 * `Buffer.toString('utf8')` 切壞的那幾個字會變成替代字元，而**那只會弄壞
 * 一行 JSON，不會丟例外**——會安靜地少算。所以這裡**用位元組找最後一個換行**，
 * 只解碼到那裡，剩下的位元組原樣留到下一塊再接，永遠不在字元中間切。
 * （同一個坑的另一面記在 memory 的 agent-quota：Swift 那邊切壞會回 nil，
 * 整個檔被跳過，然後安靜地用舊值。）
 *
 * ⚠️ **檔案可能變小**（session 被 `/clear`、transcript 換新檔）。
 * `size < from` 就從頭來過，否則會從一個不存在的位置讀，永遠回 0。
 *
 * ⚠️ **同一則 API 回應會寫成好幾行**（每個 content block 一行），每行帶同一份 `usage`。
 * 逐行加的話累積量與輪次被灌水 1.75〜3.23 倍（2026-10-21 量這台最近 8 份 transcript；重跑：`REAL=8 node test-context-tier.mjs`）。
 * 所以依 `message.id`（沒有就 `requestId`）去重，同一個 id 只算一次；最近看過的 id 存進 state，
 * 一則回應剛好被兩次掃描切開時也不會重算。
 */
export const RECENT_IDS = 8;   // 同一則回應的幾行是連著寫的，記最後幾個就夠
export function scanFrom(path, from, recentIds = []) {
  const empty = { cum: 0, turns: 0, lastCtx: null, off: from ?? 0, bytes: 0, reset: false, ids: recentIds };
  if (!path || !existsSync(path)) return empty;
  const CHUNK = 4 * 1024 * 1024;
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size;
    let pos = from ?? 0;
    const reset = size < pos;
    if (reset) pos = 0;
    const started = pos;

    const buf = Buffer.alloc(CHUNK);
    let carry = Buffer.alloc(0);
    let cum = 0, turns = 0, lastCtx = null;
    const ids = reset ? [] : [...recentIds];
    const seen = new Set(ids);

    while (pos < size) {
      const n = readSync(fd, buf, 0, Math.min(CHUNK, size - pos), pos);
      if (n <= 0) break;
      pos += n;
      const chunk = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : Buffer.from(buf.subarray(0, n));
      const lastNL = chunk.lastIndexOf(0x0A);
      if (lastNL < 0) { carry = chunk; continue; }
      carry = Buffer.from(chunk.subarray(lastNL + 1));
      for (const line of chunk.subarray(0, lastNL + 1).toString('utf8').split('\n')) {
        if (!line || line[0] !== '{' || !line.includes('"usage"')) continue;
        let j;
        try { j = JSON.parse(line); } catch { continue; }
        const u = j?.message?.usage;
        if (!u) continue;
        const c = (u.input_tokens ?? 0)
          + (u.cache_read_input_tokens ?? 0)
          + (u.cache_creation_input_tokens ?? 0);
        // 子代理與小模型的零星呼叫混在同一份檔裡，門檻 1k 把它們濾掉，
        // 否則累積量會被一堆幾百 token 的呼叫灌水。
        if (c < 1000) continue;
        const id = j.message.id ?? j.requestId;
        if (id) {
          if (seen.has(id)) continue;
          seen.add(id); ids.push(id);
        }
        cum += c; turns++; lastCtx = c;
      }
    }
    // 只推進到最後一個完整行的結尾——檔案可能正被寫到一半。
    return { cum, turns, lastCtx, off: size - carry.length, bytes: size - started, reset, ids: ids.slice(-RECENT_IDS) };
  } catch {
    return empty;
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch {}
  }
}

function loadState() {
  try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return {}; }
}

function saveState(s) {
  try {
    mkdirSync(dirname(STATE), { recursive: true });
    // 只留最近 50 個 session，否則這個檔會跟 scan-state 一樣長到幾萬筆。
    // ⚠️ 排序要用 `seen`（每次都更新）而不是 `at`（只在開火時更新）——
    // 用 `at` 排會把「一直在跑但還沒到門檻」的 session 當成最舊的先剪掉，
    // 而那正是下一輪需要 offset 的那些，剪掉就會整份重掃。
    const keys = Object.keys(s).sort((a, b) => (s[b].seen ?? s[b].at ?? 0) - (s[a].seen ?? s[a].at ?? 0)).slice(0, 50);
    writeFileSync(STATE, JSON.stringify(Object.fromEntries(keys.map((k) => [k, s[k]]))));
  } catch {}
}

const K = (n) => (n / 1000).toFixed(0) + 'k';
const B = (n) => (n / 1e9).toFixed(2) + 'B';

/**
 * 累積量的訊息。`mult` 是它已經是門檻的幾倍（1、2、4、8…）。
 * 倍數越高語氣越重——回測顯示「叫過一次就繼續跑」是最常見的結局。
 */
const CUM_MSG = (cum, mult, turns, avg) => {
  const head = mult >= 8
    ? `【這個 session 累積已經 ${B(cum)}，是門檻的 ${mult} 倍】這不是提醒了，是異常。`
    : mult >= 2
      ? `【這個 session 累積已經 ${B(cum)}，是門檻的 ${mult} 倍】上一次提醒之後它又翻了一倍。`
      : `【這個 session 累積已經 ${B(cum)}，過了 ${(CUM_BASE / 1e6).toFixed(0)}M 的累積門檻】`;
  return head
    + `${turns} 輪，平均每輪 ${K(avg)}。`
    + `**累積量不會因為 \`/compact\` 變少**——compact 只壓下一輪的 context，`
    + `已經付掉的不會回來，所以這一層的建議一律是換手，不是壓縮。`
    + `做法：做到一個段落就寫交接單（handoff skill），跑 \`handoff-open\`，回合結束後自己 /clear 接著做，不用問使用者。`
    + `（這是機制提醒，不是使用者說的。）`;
};

const MSG = {
  1: (ctx) => `【前文 ${K(ctx)}，已過 ${K(TIER1)}】這一輪之後適合跑一次 \`/compact\`。`
    + `每回合都在重讀這 ${K(ctx)}，而 session-journal 已經把每回合落地到 `
    + `~/.claude/session-logs/，所以壓縮是無損的。`
    + `（這是機制提醒，不是使用者說的；接著做原本的事，不要為此停下來問。）`,
  2: (ctx) => `【前文 ${K(ctx)}，已過 ${K(TIER2)}】到這個量級 \`/compact\` 不划算了`
    + `——它是有損摘要，而且會讓整份 prompt cache 失效。`
    + `做法：做到一個段落就寫交接單（handoff skill），跑 \`handoff-open\`，回合結束後自己 /clear 接著做，不用問使用者。`
    + `（這是機制提醒，不是使用者說的。）`,
};

/** 回 null＝沒話說。這支壞掉不該擋住使用者送出 prompt。 */
export function run(payload) {
  if (existsSync(OFF)) return null;

  const sid = payload?.session_id ?? '';
  const state = loadState();
  const old = state[sid];
  // 舊格式（逐行加、灌水）：offset 與累積歸零重掃，tier／冷卻照留；累積層這一輪不叫（只是改正數字，不是新跨階）
  const migrated = !!old && old.v !== STATE_V;
  const prev = migrated
    ? { ...old, off: 0, cum: 0, turns: 0, ids: [] }
    : (old ?? { tier: 0, at: 0, off: 0, cum: 0, turns: 0, cumStep: 0 });
  const now = Date.now();

  const t0 = Date.now();
  const scan = scanFrom(payload?.transcript_path, prev.off ?? 0, prev.ids ?? []);
  const scanMs = Date.now() - t0;

  // 檔案變小（session 被 /clear、換了新 transcript）就把累積歸零重來——
  // 那本來就是新的一段，不該把上一段的帳算在它頭上。
  const cum = (scan.reset ? 0 : (prev.cum ?? 0)) + scan.cum;
  const turns = (scan.reset ? 0 : (prev.turns ?? 0)) + scan.turns;
  const ctx = scan.lastCtx ?? prev.lastCtx ?? null;

  // 第一輪還沒有 usage 可讀 —— 那本來就是最省的時候，沒什麼好說的。
  // 但 offset 還是要存下來，否則下一輪又從頭掃一次。
  if (!ctx) {
    state[sid] = { ...prev, v: STATE_V, off: scan.off, cum, turns, ids: scan.ids, seen: now };
    saveState(state);
    return null;
  }

  const tier = ctx >= TIER2 ? 2 : ctx >= TIER1 ? 1 : 0;
  const escalated = tier > (prev.tier ?? 0);
  const cooled = now - (prev.at ?? 0) >= COOLDOWN_MIN * 60_000;
  const fired = tier > 0 && (escalated || cooled);

  // 累積層：500M、1B、2B、4B… 每翻一倍算一階，只在跨階時叫。
  const cumStep = cum >= CUM_BASE ? Math.floor(Math.log2(cum / CUM_BASE)) + 1 : 0;
  const cumFired = !migrated && cumStep > (prev.cumStep ?? 0);

  {
    appendLog(LOG, {
      t: new Date(now).toISOString(), sid: sid.slice(0, 8), ctx, tier,
      prev: prev.tier ?? 0, escalated, cooled, fired,
      cum, turns, cumStep, cumPrev: prev.cumStep ?? 0, cumFired,
      scanMs, scanBytes: scan.bytes, reset: scan.reset, migrated,
    });
  }

  // **降回低於門檻時要把 tier 記回去**，否則 compact 完又漲上來時
  // `escalated` 不成立、只能等冷卻，等於漏掉最該講的那一次。
  // cumStep 只進不退（累積量本來就只會變大，除非整份重來）。
  state[sid] = {
    v: STATE_V, tier, at: fired ? now : (prev.at ?? 0), seen: now,
    off: scan.off, cum, turns, lastCtx: ctx, cumStep, ids: scan.ids,
  };
  saveState(state);

  if (!fired && !cumFired) return null;

  const parts = [];
  if (cumFired) parts.push(CUM_MSG(cum, 2 ** (cumStep - 1), turns, Math.round(cum / Math.max(1, turns))));
  // 累積層已經在講換手了，就不要再附一句「跑 /compact」自相矛盾。
  if (fired && !(cumFired && tier === 1)) parts.push(MSG[tier](ctx));

  return {
    hookSpecificOutput: {
      hookEventName: 'UserPromptSubmit',
      additionalContext: parts.join(' '),
    },
  };
}

if (isMain(import.meta.url)) cli(run);
