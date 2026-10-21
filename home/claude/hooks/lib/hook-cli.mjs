/**
 * 每支檢查的兩種跑法共用這裡：
 *   · 被 dispatch.mjs import，呼叫 `run(input)` 拿回結果（Claude Code 走這條）
 *   · 被直接執行（Codex 的 ~/.codex/hooks.json、測試、手動餵 stdin）
 *
 * `run(input)` 的約定：回傳 null（放行、沒話說）、要印的物件（會 JSON 化），或字串（原樣印）。
 * **run 裡不准 process.exit、不准讀 stdin**——它跟別的檢查住在同一個程序裡。
 */
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * 這個模組是不是被當成指令直接執行。
 * argv[1] 要先 realpath：import.meta.url 是解開 symlink 之後的路徑（~/.claude/hooks → skills/…），
 * Windows 也要走 pathToFileURL，自己拼 `file://` 會永遠不相等、hook 安靜地變空操作（2026-09-10 desk 實測）。
 */
export function isMain(metaUrl) {
  const a = process.argv[1];
  if (!a) return false;
  try { return pathToFileURL(realpathSync(a)).href === metaUrl; } catch { return false; }
}

export async function readStdin() {
  let raw = '';
  for await (const c of process.stdin) raw += c;
  return raw;
}

/** 讀 stdin → run → 印結果。任何錯誤都 exit 0：檢查壞掉不能擋住任何東西。 */
export async function cli(run) {
  try {
    let input;
    try { input = JSON.parse(await readStdin()); } catch { process.exit(0); }
    const out = await run(input);
    if (out != null) process.stdout.write(typeof out === 'string' ? out : JSON.stringify(out));
  } catch {}
  process.exit(0);
}

/** 訊息裡給使用者看的路徑：家目錄縮成 ~。repo 不一定在 ~/.claude/skills（公開版建議 clone 到別處），所以路徑一律從檔案位置算。 */
export function tilde(p) {
  const h = process.env.HOME || '';
  return h && (p === h || p.startsWith(h + '/')) ? '~' + p.slice(h.length) : p;
}
