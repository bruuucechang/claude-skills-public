// 跨 session 訊息：腳本直接寫另一個 claude session 的 inbox socket（2026-10-21 W6）。
// 官方文件 https://code.claude.com/docs/en/cross-session-messaging 的「The session's inbox socket」：
// 每個 session 綁一個 socket（sessions/<pid>.json 的 messagingSocketPath），一行一個 JSON；macOS／Linux 不用 auth 行。
// 實測（報告 handoff/session-messages-report.md）：
// - 送得到、對方閒著會開新回合；跨設定目錄（bruce↔peter）也送得到——ListAgents／SendMessage 才看不到彼此。
// - 對方收到的是「另一個 session 傳來的訊息」，不是使用者輸入：/clear 之類的指令不會執行，換手的 /clear 仍要打字。
// - 寫完不會回任何東西；對方是 bypassPermissions 的話會扣下等使用者同意。所以「送出」≠「開工」，要看 status。
import net from "node:net";
import { readFileSync, statSync } from "node:fs";
import { basename } from "node:path";

// 只認官方放 socket 的目錄（/tmp/cc-socks、/tmp/cc-socks-<uid>，macOS 上是 /private/tmp 的別名），檔名是 <pid>.sock
const SOCK_RE = /^(\/private)?\/tmp\/cc-socks(-\d+)?\/\d+\.sock$/;

export function socketOf(session) {
  const p = session?.messagingSocketPath;
  if (typeof p !== "string" || !SOCK_RE.test(p)) return null;
  if (session.pid && basename(p) !== `${session.pid}.sock`) return null;
  try { const st = statSync(p); return st.isSocket() && st.uid === process.getuid() ? p : null; } catch { return null; }
}

// 送出一則訊息；連上並寫完回 true，否則回錯誤字串（不丟例外）
export function post(sock, text, { timeoutMs = 5000 } = {}) {
  return new Promise((done) => {
    let settled = false, grace = null;
    const finish = (v) => { if (!settled) { settled = true; clearTimeout(t); clearTimeout(grace); c.destroy(); done(v); } };
    const c = net.createConnection(sock);
    const t = setTimeout(() => finish("連 socket 逾時"), timeoutMs);
    c.on("error", (e) => finish(`socket 連不上：${e.code || e.message}`));
    c.on("connect", () => {
      // 寫完先等對方收尾（close），最多 1 秒；不立刻 destroy，免得對方還沒讀完就被 reset
      c.end(JSON.stringify({ type: "user", message: { role: "user", content: text } }) + "\n", () => {
        c.once("close", () => finish(true));
        grace = setTimeout(() => finish(true), 1000);
      });
    });
  });
}

// 送出後等那格開工：sessions/<pid>.json 轉成 busy，或送出之後更新過而且是 idle（回合很短、已經做完）；waiting 等別的狀態不算
export async function postAndConfirm(sessionFile, text, { waitMs = 15_000, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const read = () => { try { return JSON.parse(readFileSync(sessionFile, "utf8")); } catch { return null; } };
  const sock = socketOf(read());
  if (!sock) return { ok: false, sent: false, why: "這格沒有可用的 inbox socket" };
  const t0 = Date.now();
  const r = await post(sock, text);
  if (r !== true) return { ok: false, sent: false, why: r };
  for (let waited = 0; waited < waitMs; waited += 250) {
    await sleep(250);
    const s = read();
    if (!s) return { ok: false, sent: true, why: "送出後那格的 session 檔不見了（結束了？）" };
    if (s.status === "busy" || (s.status === "idle" && (s.statusUpdatedAt || 0) > t0)) return { ok: true, sent: true };
  }
  return { ok: false, sent: true, why: `送出了，但 ${waitMs / 1000} 秒內那格沒開工（可能被扣下等同意）` };
}
