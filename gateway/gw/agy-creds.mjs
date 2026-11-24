// agy 登录凭据文件的探测（login.mjs 与 models.mjs 共用同一口径，reg-models F-3）。
//
// 原来两处各写一份：login.mjs 的 hasAgySessionFiles（MIG-14）递归找，models.mjs 的
// agySessionFilesReady 只扫顶层——凭据在子目录时登录页认登录、选单却标“还没就绪”。
// 口径只能有一份实现：放这里，两模块都 import 它；login.mjs 再原样 re-export，
// 旧的 `import { hasAgySessionFiles } from "./login.mjs"` 不用改。
import fs from "node:fs";
import path from "node:path";
import { CFG } from "./config.mjs";

/**
 * 检测本机 Antigravity CLI 是否有已缓存的 Google 登录态（本地仅检查 JSON 文件是否为非空对象，不提取、不记录、不外传任何 OAuth token 字段）。
 * 只认非空文件：空文件、目录、损坏或空对象的 .json 都不算凭据（A3）。
 * MIG-14：三个目录递归找凭据特征文件（与 logout 同口径，见 listAgyCredentialFiles）。
 */
const AGY_SESSION_DIRS = [
  path.join(CFG.home, ".gemini", "antigravity-cli"),
  path.join(CFG.home, ".config", "antigravity"),
  path.join(CFG.home, ".antigravity"),
];
const AGY_CRED_NAME_RE = /cred|token|auth|oauth|session|profile/i;
/** 三个凭据目录下递归列出凭据特征文件（MIG-14）：只认文件（目录不算）、跳过 .bak；
 *  不跟随符号链接进子目录（防循环），最多下钻 8 层、最多 1000 个文件。 */
export function listAgyCredentialFiles() {
  const out = [];
  const walk = (dir, depth) => {
    if (out.length >= 1000 || depth > 8) return;
    let names;
    try { names = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of names) {
      if (out.length >= 1000) return;
      const fp = path.join(dir, e.name);
      if (e.isDirectory()) { walk(fp, depth + 1); continue; }
      if (!e.isFile()) continue;
      if (!AGY_CRED_NAME_RE.test(e.name) || e.name.endsWith(".bak")) continue;
      out.push(fp);
    }
  };
  for (const d of AGY_SESSION_DIRS) walk(d, 0);
  return out;
}
export function hasAgySessionFiles() {
  for (const fp of listAgyCredentialFiles()) {
    let st;
    try { st = fs.statSync(fp); } catch { continue; }
    if (!st.isFile() || st.size === 0) continue;
    if (/\.json$/i.test(fp)) {
      try {
        const j = JSON.parse(fs.readFileSync(fp, "utf8"));
        if (!j || typeof j !== "object" || Array.isArray(j) || !Object.keys(j).length) continue;
      } catch { continue; }
    }
    return true;
  }
  return false;
}
