// ── 界面定制的统一存储（0.4.20 起）：home/ccapp-ui.json ─────────────────────
// 用户自己摆的界面选择（顶栏按钮、侧栏常驻项……）放网关这边：换 WebView、清缓存都不丢。
// 前端本地留一份镜像（localStorage cc.ui）好让启动时直接摆好不闪，启动后再和这里对一次，以这里为准。
// 只收白名单里的键，值整个替换（不做深合并）；null 表示删掉这一项、回到默认。
import path from "node:path";
import { CFG, log } from "./config.mjs";
import { NEXT, readBody, sendJson } from "./http.mjs";
import { readSmallFile } from "./saferead.mjs";
import { writeAtomic } from "./statefile.mjs";

const FILE = path.join(CFG.home, "ccapp-ui.json");
export const UI_KEYS = ["topbar", "navPins", "accent", "msgActs", "extImg", "gcPaper"];
const MAX = 16 * 1024;

export function readUi() {
  try { const raw = readSmallFile(FILE, 64 << 10); if (raw != null) { const j = JSON.parse(raw); if (j && typeof j === "object" && !Array.isArray(j)) return j; } } catch {}
  return {};
}
export function patchUi(patch) {
  const cur = readUi();
  for (const [k, v] of Object.entries(patch || {})) {
    if (!UI_KEYS.includes(k)) continue;
    if (v === null) delete cur[k]; else cur[k] = v;
  }
  const s = JSON.stringify(cur);
  if (s.length > MAX) throw new Error("too large");
  if (!writeAtomic(FILE, s)) throw new Error("write failed");
  return cur;
}

// ── 路由：GET/POST /api/ui 界面定制；POST /api/freeze 滚动冻结脱困日志 ──
export async function routeUi(req, res, u, p) {
  if (req.method === "POST" && p === "/api/freeze") {
    let j = {};
    try { j = JSON.parse(await readBody(req)); } catch {}
    // 去掉换行：不能借它在日志里伪造一行（v0514 审查低-8）
    const touch = Array.isArray(j.touch) ? j.touch.slice(-40).map((x) => String(x).replace(/[\x00-\x1f\x7f]/g, " ").slice(0, 80)).join(" | ") : "";
    log(`滚动冻结脱困（${j.why === "auto" ? "自动" : "手动"}）${touch ? "，触摸：" + touch : ""}`);
    return sendJson(res, 200, { ok: true });
  }
  if (p !== "/api/ui") return NEXT;
  if (req.method === "GET") return sendJson(res, 200, readUi());
  if (req.method === "POST") {
    let b; try { b = JSON.parse((await readBody(req)) || "{}"); } catch { return sendJson(res, 400, { error: "bad json" }); }
    try { const d = patchUi(b); log(`[ui] 改了 ${Object.keys(b).filter((k) => UI_KEYS.includes(k)).join(", ") || "（无）"}`); return sendJson(res, 200, d); }
    catch (e) { return sendJson(res, 400, { error: e.message }); }
  }
  return NEXT;
}
