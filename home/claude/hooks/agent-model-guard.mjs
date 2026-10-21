#!/usr/bin/env node
/**
 * PreToolUse(Agent) —— 派 general-purpose（或不寫類型）時一定要明寫 model。
 *
 * 不寫的話：settings.json 有 env.CLAUDE_CODE_SUBAGENT_MODEL=sonnet 時跑 Sonnet，沒設（別台機器、
 * 舊設定）就跟著主 session 跑 Opus。照擋是要派工的人每次明講用哪個。2026-10-20 香格里拉 B11～B16 派了約 90 個寫手，
 * 全是不寫 model 的 general-purpose，平均 60～100 次呼叫、context 長到 200～500K，
 * 兩天把 bruce 的週額度從 26% 燒到 85%，86% 花在子代理。
 * 擋下來不是要禁 Opus，是要派工的人每次都想一下：苦工用 writer（Sonnet），判斷才用 opus。
 * 具名子代理不管：writer／ui-verifier／dispatcher 的 frontmatter 寫 Sonnet（只擋它們被換成更貴的）；
 * reviewer／researcher 這類判斷角色 frontmatter 寫 opus。
 * fork 不管：它一律用主 session 的模型、model 參數無效，擋了也沒得改。
 *
 * 扇出上限（2026-10-21 使用者裁示）：同一則 assistant 訊息裡 ≥ FANOUT_MAX+1 個
 * 「general-purpose（或不寫類型）＋ model: opus」就擋。近 14 天兩個帳號共 7 則訊息
 * 一次扇出 5～10 個 opus 寫手（重查：`node replay-agent-fanout.mjs [舊版 ref] [天數=14]`）。
 * 數法：PreToolUse 拿到 tool_use_id → 讀 transcript 尾巴找出含它的那則訊息（同一個
 * message.id 的 tool_use 各寫一行）→ 數同訊息裡的 opus general-purpose。
 * 實測（2.1.305）：平行呼叫時第一個工具執行當下，同訊息後面的 tool_use 已寫進 transcript；
 * 就算之後版本改成邊串流邊跑，第 FANOUT_MAX+1 個起也一定看得到前面的，照樣擋。
 * 找不到（讀不到檔、子代理的 transcript 不是這份）就放行：不確定不擋。
 */
import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
import { cli, isMain } from './lib/hook-cli.mjs';

export const GUARDED = ['', 'general-purpose', 'claude'];
export const CHEAP = ['sonnet', 'haiku'];
const isCheap = (m) => CHEAP.some((c) => norm(m).includes(c));   // 也認 claude-sonnet-5 這類完整 ID
export const FANOUT_MAX = 3;
/** frontmatter 固定 Sonnet 的具名子代理（~/.claude/agents → office/agents）。 */
export const SONNET_AGENTS = ['writer', 'ui-verifier', 'dispatcher'];
const AGENT_TOOLS = ['Agent', 'Task'];   // Task 是舊版 Claude Code 的同一個工具

const norm = (v) => String(v ?? '').trim().toLowerCase();
export const isOpusGP = (i) => GUARDED.includes(norm(i?.subagent_type)) && norm(i?.model).includes('opus');

/** 讀檔案尾巴的 N 個位元組（transcript 可以到幾十 MB）。cut：是不是從檔案中間開始讀。 */
function tailBytes(file, bytes) {
  let fd;
  try {
    fd = openSync(file, 'r');
    const size = fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    readSync(fd, buf, 0, len, size - len);
    // 切點前一個位元組是換行 → 第一行其實是完整的
    let cut = size > len;
    if (cut) { const b = Buffer.alloc(1); readSync(fd, b, 0, 1, size - len - 1); cut = b[0] !== 0x0a; }
    return { text: buf.toString('utf8'), cut };
  } catch {
    return { text: '', cut: false };
  } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* 已經關了 */ }
  }
}

/**
 * 跟 toolUseId 同一則 assistant 訊息裡，有幾個 opus general-purpose 的 Agent 呼叫。
 * 找不到這個 tool_use 回 0（放行）。
 */
export function opusFanout(transcriptPath, toolUseId) {
  if (!transcriptPath || !toolUseId) return 0;
  const { text, cut } = tailBytes(transcriptPath, 2 * 1024 * 1024);
  if (!text.includes(toolUseId)) return 0;
  const lines = text.split('\n');
  if (cut) lines.shift();              // 只有真的從行中間切才丟第一行
  const byMsg = new Map();
  let target = null;
  for (const l of lines) {
    if (!l.includes('"tool_use"')) continue;
    let o;
    try { o = JSON.parse(l); } catch { continue; }
    if (o.type !== 'assistant' || !Array.isArray(o.message?.content)) continue;
    const id = o.message.id ?? o.uuid;
    for (const b of o.message.content) {
      if (b?.type !== 'tool_use' || !AGENT_TOOLS.includes(b.name)) continue;
      if (!byMsg.has(id)) byMsg.set(id, new Set());
      if (isOpusGP(b.input)) byMsg.get(id).add(b.id);
      if (b.id === toolUseId) target = id;
    }
  }
  return target == null ? 0 : byMsg.get(target).size;
}

export function run(input) {
  const i = input?.tool_input;
  if (!i) return null;
  const type = String(i.subagent_type ?? '').trim().toLowerCase();
  // 帶 model 會蓋掉 frontmatter 的 Sonnet：只准往更省的方向換。
  if (SONNET_AGENTS.includes(type) && i.model && !isCheap(i.model)) {
    return deny(`${type} 固定跑 Sonnet，帶 model: "${i.model}" 會把它換成更貴的模型。照做的工作就不要帶 model；真的需要判斷，改派 reviewer 或 general-purpose 加 model: "opus"。`);
  }
  if (isOpusGP(i)) {
    const n = opusFanout(input.transcript_path, input.tool_use_id);
    if (n > FANOUT_MAX) {
      return deny(`這則訊息一次派了 ${n} 個 general-purpose 加 model: "opus"，上限 ${FANOUT_MAX} 個（2026-10-21 裁示：扇出的 Opus 子代理最燒額度）。照工作單做的苦工改派 subagent_type: "writer"（固定 Sonnet、不要帶 model）；真的要 Opus 判斷，就把數量降到 ${FANOUT_MAX} 個以下分批派；fork 也跑 Opus 而且帶著整段主 session 脈絡，只在子工作非要那段脈絡時才改用。`);
    }
    return null;
  }
  if (i.model || !GUARDED.includes(type)) return null;
  return deny(`派 ${i.subagent_type || 'general-purpose'} 要明寫 model：沒寫就看環境變數 CLAUDE_CODE_SUBAGENT_MODEL，別台機器沒設時跟著主 session 跑 Opus（2026-10-20 香格里拉的寫手這樣兩天燒掉六成週額度）。照工作單做的苦工（讀素材、摘錄、照格式寫）改用 subagent_type: "writer"（固定 Sonnet）或加 model: "sonnet"；要判斷取捨、審查、抽查事實才加 model: "opus"。工作單也要先切好素材、一個子代理只給 5～10 項。`);
}

function deny(reason) {
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    },
  };
}

if (isMain(import.meta.url)) cli(run);
