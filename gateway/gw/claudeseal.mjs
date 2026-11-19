// ─────────────────────────────────────────────────────────────────────
//  claudeseal.mjs —— hachimia 二进制完整性校验（Antigravity CLI `agy`）
//
//  校验已安装的 agy 二进制与其版本目录里的 manifest.json sha256 是否一致；
//  不再强依赖 Anthropic PGP 签名清单拦截原生 agy 启动。
// ─────────────────────────────────────────────────────────────────────
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { CFG, PATHS, HERE, log } from "./config.mjs";
import { tamperRecord } from "./tamper.mjs";

const isVer = (v) => /^\d{1,6}\.\d{1,6}\.\d{1,6}(-[0-9A-Za-z.+-]{1,40})?$/.test(v || "");
let cache = { fp: "", res: null };
const DEPLOYED = fs.existsSync(path.join(HERE, "FILES"));
let askRecheck = null;

export const onSealUnknown = (fn) => { askRecheck = fn; };

export const sealStillValid = (bin0 = PATHS.agy || PATHS.claude) => {
  if (!cache.res || cache.res.ok !== true) return true;
  try { return fpFor(fs.realpathSync(bin0)) === cache.fp; } catch { return false; }
};

const fpFor = (bin) => {
  const d = path.dirname(bin);
  return fpOf(bin, path.join(d, "manifest.json"), path.join(d, ".mismatch"));
};

function fpOf(...files) {
  return files.map((f) => {
    try { const s = fs.statSync(f); return `${f}:${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.ino}`; }
    catch { return f + ":-"; }
  }).join("|");
}

function sha256(f) {
  const h = crypto.createHash("sha256"), fd = fs.openSync(f, "r"), b = Buffer.alloc(4 << 20);
  try { let n; while ((n = fs.readSync(fd, b, 0, b.length)) > 0) h.update(b.subarray(0, n)); }
  finally { fs.closeSync(fd); }
  return h.digest("hex");
}

/**
 * 返回 { ok: true }（校验通过）/ { ok: false, why }（检测到篡改或不符）/ { ok: null, why }（开发模式或无清单，放行）。
 */
export async function claudeSeal(bin0 = PATHS.agy || PATHS.claude, { force = false, home = CFG.home } = {}) {
  if (!DEPLOYED && !force) return { ok: null, why: "dev" };
  let bin;
  try { bin = fs.realpathSync(bin0); } catch { return { ok: null, why: "missing" }; }
  const dir = path.dirname(bin);
  const mf = path.join(dir, "manifest.json");
  const fp = fpFor(bin);
  let fresh = false;
  try { fresh = Date.now() - fs.statSync(bin).ctimeMs <= 2000; } catch {}
  if (cache.fp === fp && cache.res && !fresh) return cache.res;

  let res;
  if (fs.existsSync(path.join(dir, ".mismatch"))) {
    res = { ok: false, why: "recheck found agy binary does not match manifest" };
  } else if (!fs.existsSync(mf)) {
    res = { ok: null, why: "no local manifest" };
  } else {
    try {
      const j = JSON.parse(fs.readFileSync(mf, "utf8"));
      const want = j && typeof j.sha256 === "string" ? j.sha256 : "";
      if (!/^[a-f0-9]{64}$/.test(want)) {
        res = { ok: null, why: "manifest has no sha256" };
      } else if (sha256(bin) !== want) {
        res = { ok: false, why: "agy binary sha256 mismatch" };
      } else {
        res = { ok: true, version: j.version || (isVer(path.basename(dir)) ? path.basename(dir) : "unknown") };
      }
    } catch (e) {
      res = { ok: null, why: "manifest read error: " + e.message };
    }
  }

  if (res.ok === false && !(cache.res && cache.res.ok === false && cache.fp === fp)) {
    log(`⚠️ [Antigravity CLI 核验] ${bin}：${res.why}`);
    tamperRecord("agy", [`${path.basename(dir)}/agy: ${res.why}`]);
  }
  cache = { fp, res };
  return res;
}
