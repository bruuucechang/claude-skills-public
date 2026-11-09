// peer-msg.mjs 的案例表（tests/run.sh 會跑）：用假的 inbox socket 驗送出的格式、socket 驗證、開工確認。
import net from "node:net";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { socketOf, post, postAndConfirm } from "./peer-msg.mjs";

let pass = 0, fail = 0;
const ok = (c, msg, extra = "") => { if (c) { pass++; console.log("  ✓ " + msg); } else { fail++; console.log("  ✗ " + msg + (extra ? "\n      " + extra : "")); } };

// 官方目錄形狀 /tmp/cc-socks-<數字>，用一個不會撞到真 session 的大數字
const DIR = `/tmp/cc-socks-${900000000 + process.pid}`;
mkdirSync(DIR, { recursive: true });
const PID = 4242;
const SOCK = join(DIR, `${PID}.sock`);
const SFILE = join(DIR, `${PID}.json`);
const session = (o = {}) => ({ pid: PID, status: "idle", statusUpdatedAt: 1, messagingSocketPath: SOCK, ...o });

let got = [];
let onLine = () => {};
const srv = net.createServer((c) => {
  let buf = "";
  c.on("data", (d) => { buf += d; });
  c.on("end", () => { for (const l of buf.split("\n").filter(Boolean)) { got.push(l); onLine(l); } });
});
await new Promise((r) => srv.listen(SOCK, r));

try {
  // socketOf
  ok(socketOf(session()) === SOCK, "官方目錄裡、檔名對得上 pid 的 socket 認得");
  ok(socketOf(session({ messagingSocketPath: "/tmp/evil/4242.sock" })) === null, "不在 cc-socks 目錄的路徑不認");
  ok(socketOf(session({ pid: 1111 })) === null, "檔名跟 pid 對不上不認（別格的 socket）");
  writeFileSync(join(DIR, "5555.sock"), "x");
  ok(socketOf(session({ pid: 5555, messagingSocketPath: join(DIR, "5555.sock") })) === null, "同名但不是 socket 的一般檔不認");
  ok(socketOf({ pid: PID }) === null && socketOf(null) === null, "沒有 messagingSocketPath（舊版 claude）不認");

  // post：一行 JSON，type user、content 是原文
  got = [];
  const text = "推送佇列退回了 x 的 y（測試）：請你接手\n第二行";
  ok(await post(SOCK, text) === true, "送得出去回 true");
  await new Promise((r) => setTimeout(r, 100));
  let msg = null; try { msg = JSON.parse(got[0]); } catch {}
  ok(got.length === 1 && msg?.type === "user" && msg?.message?.role === "user" && msg?.message?.content === text,
    "對方收到剛好一行官方格式 {type:user, message:{role:user, content}}，換行在 JSON 裡沒拆行", JSON.stringify(got));
  const bad = await post(join(DIR, "9999.sock"), "x", { timeoutMs: 1000 });
  ok(typeof bad === "string" && bad.includes("連不上"), "socket 不存在回錯誤字串、不丟例外", String(bad));

  // postAndConfirm：對方收到就把 session 檔改成 busy → ok
  const fast = { sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 50))) };
  writeFileSync(SFILE, JSON.stringify(session()));
  onLine = () => writeFileSync(SFILE, JSON.stringify(session({ status: "busy", statusUpdatedAt: Date.now() })));
  let r = await postAndConfirm(SFILE, "開工", { waitMs: 3000, ...fast });
  ok(r.ok === true && r.sent === true, "對方轉成 busy 就算交出去了", JSON.stringify(r));

  // 回合很短、已經回到 idle，但 statusUpdatedAt 在送出之後 → 也算
  writeFileSync(SFILE, JSON.stringify(session()));
  onLine = () => writeFileSync(SFILE, JSON.stringify(session({ status: "idle", statusUpdatedAt: Date.now() + 1 })));
  r = await postAndConfirm(SFILE, "很短的回合", { waitMs: 3000, ...fast });
  ok(r.ok === true, "送出後 status 更新過（已回到 idle）也算開工", JSON.stringify(r));

  // 送出後轉成 waiting（卡在對話框）不算開工
  writeFileSync(SFILE, JSON.stringify(session()));
  onLine = () => writeFileSync(SFILE, JSON.stringify(session({ status: "waiting", statusUpdatedAt: Date.now() + 1 })));
  r = await postAndConfirm(SFILE, "卡在對話框", { waitMs: 500, ...fast });
  ok(r.ok === false && r.sent === true, "送出後轉成 waiting 不算開工", JSON.stringify(r));

  // 收下但沒開工（bypass 模式扣下等同意）→ sent 但不 ok
  writeFileSync(SFILE, JSON.stringify(session()));
  onLine = () => {};
  r = await postAndConfirm(SFILE, "被扣下", { waitMs: 500, ...fast });
  ok(r.ok === false && r.sent === true && /沒開工/.test(r.why), "送出了但沒開工：回 sent 不回 ok（pushq 才不會再打字）", JSON.stringify(r));

  // 沒有 socket → 沒送
  writeFileSync(SFILE, JSON.stringify({ pid: PID, status: "idle" }));
  r = await postAndConfirm(SFILE, "x", { waitMs: 500, ...fast });
  ok(r.ok === false && r.sent === false, "session 檔沒有 socket：回沒送出（pushq 退回 iTerm 打字）", JSON.stringify(r));
} finally {
  srv.close();
  rmSync(DIR, { recursive: true, force: true });
}

console.log(`\n  ${pass} 過 · ${fail} 失敗`);
process.exit(fail ? 1 : 0);
