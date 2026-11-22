// ── Antigravity CLI (agy) 真机验证记录：哪些版本在 hachimia 上验过、哪些有已知问题 ─────────────
//
// 来源：仓库 agy-code/verified.json，维护者用 scripts/verify-agy.mjs 在真机上跑、scripts/agy-verified.mjs 签名发布
// （与应用内通知同一把钥匙、同一条路：直接从 GitHub raw 取）。这里只取 GitHub raw，只认签名对得上的。
// 用处：版本选单标「已验证」/ 有问题的原因（/api/claude/versions 带上）；验过签的那份存到
// home/.cache/cccodroid/agy-verified.json，Java 的自动更新读它——渠道走到有问题的版本时先不自动装。
// 和 Claude 那套（gw/ccverified.mjs）是平行通道，不共用文件、不改名。
import path from "node:path";
import crypto from "node:crypto";
import { CFG, LIVE, log } from "./config.mjs";
import { PUBKEY, loadSigned, saveSigned } from "./notices.mjs";

// CCAPP_AGY_VERIFIED_URL：只用这一个地址（测试用）
const SOURCES = process.env.CCAPP_AGY_VERIFIED_URL ? [process.env.CCAPP_AGY_VERIFIED_URL]
  : ["https://raw.githubusercontent.com/Buddy-Further/hachimia/main/agy-code/verified.json"];
const EVERY = 3 * 3600e3;
export const AGY_VERIFIED_CACHE = path.join(CFG.home, ".cache", "cccodroid", "agy-verified.json");

let data = null, fetchedAt = 0, lastError = "", busy = null;
// 磁盘上那份连同签名一起存（AGY_VERIFIED_CACHE.sig），读回来再验一遍：同 uid 的程序能写这个文件，没签名的不认（审查 11-05 安全 1）
data = loadSigned(AGY_VERIFIED_CACHE);

async function fetchOne(url) {
  const get = async (u) => { const r = await fetch(u, { signal: AbortSignal.timeout(15000), headers: { "cache-control": "no-cache" } }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return Buffer.from(await r.arrayBuffer()); };
  const body = await get(url), sig = (await get(url + ".sig")).toString("utf8").trim();
  if (!crypto.verify(null, body, PUBKEY, Buffer.from(sig, "base64"))) throw new Error("签名对不上");
  const j = JSON.parse(body.toString("utf8"));
  if (!j || typeof j.versions !== "object" || typeof j.bad !== "object") throw new Error("格式不对");
  return { j, body, sig };
}

export function refreshAgyVerified(force = false) {
  if (busy) return busy;
  if (!force && Date.now() - fetchedAt < EVERY) return Promise.resolve();
  busy = (async () => {
    const errs = [];
    for (const u of SOURCES) {
      try {
        const { j, body, sig } = await fetchOne(u);
        // GitHub raw 有几分钟缓存，两个来源可能一新一旧：只往新的换
        if (!data || !(String(j.updated || "") < String(data.updated || ""))) {
          data = j;
          saveSigned(AGY_VERIFIED_CACHE, body, sig);
        }
        fetchedAt = Date.now(); lastError = "";
        return;
      } catch (e) { errs.push(`${new URL(u).host}：${e.cause?.code || e.message}`); }
    }
    fetchedAt = Date.now() - EVERY + 600e3;     // 都失败：10 分钟后再试
    lastError = errs.join("；");
    log(`[agy-verified] 取不到：${lastError}`);
  })().finally(() => { busy = null; });
  return busy;
}

/** 给版本选单：{ verified: {版本: [{device, android, at, app}]}, bad: {版本: {text, fixed}} } —— 最多等 5 秒，取不到就用手上的 */
export async function agyVerifiedInfo(lang = "zh") {
  await Promise.race([refreshAgyVerified().catch(() => {}), new Promise((r) => setTimeout(r, 5000))]);
  const verified = {}, bad = {};
  for (const [v, recs] of Object.entries(data?.versions || {})) if (Array.isArray(recs) && recs.length)
    verified[v] = recs.map((r) => ({ device: String(r.device || ""), android: String(r.android || ""), at: String(r.at || ""), app: String(r.app || ""), targetSdk: +r.targetSdk || 0 }));
  for (const [v, b] of Object.entries(data?.bad || {})) if (b) bad[v] = { text: String((lang === "zh" ? b.zh : b.en) || b.zh || b.en || ""), fixed: String(b.fixed || "") };
  return { verified, bad, verifiedError: lastError };
}

/** 同步读手上那份已验签的 feed：哪些版本有验证记录。只读内存里的 data
 *  （启动时从已签名的磁盘缓存载入，后台按既有节奏刷新），绝不发请求——
 *  建会路径上不能等网络。feed 缺失 / 为空 / 未签名时返回 []，调用方
 *  行为与原来一致。同一版本既在 versions 又在 bad 里时不算已验证。 */
export function agyVerifiedVersions() {
  const out = [];
  for (const [v, recs] of Object.entries(data?.versions || {})) {
    if (Array.isArray(recs) && recs.length && !data?.bad?.[v]) out.push(v);
  }
  return out;
}

// 服务起来 15 秒后取一次（Java 的自动更新要用磁盘上那份），之后每 3 小时
if (LIVE) {
  setTimeout(() => refreshAgyVerified().catch(() => {}), 15000).unref?.();
  setInterval(() => refreshAgyVerified().catch(() => {}), EVERY).unref?.();
}
