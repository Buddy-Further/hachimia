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
async function sha256Async(f) {
  const h = crypto.createHash("sha256");
  const fh = await fs.promises.open(f, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const b = Buffer.alloc(2 << 20);
  try {
    const st1 = await fh.stat({ bigint: true });
    if (!st1.isFile()) throw new Error("not a regular file");
    let pos = 0;
    while (true) {
      const { bytesRead } = await fh.read(b, 0, b.length, pos);
      if (!bytesRead) break;
      h.update(b.subarray(0, bytesRead));
      pos += bytesRead;
    }
    const st2 = await fh.stat({ bigint: true });
    if (st2.dev !== st1.dev || st2.ino !== st1.ino || st2.size !== st1.size || st2.ctimeNs !== st1.ctimeNs) {
      throw new Error("binary changed during verification");
    }
  } finally { await fh.close().catch(() => {}); }
  return h.digest("hex");
}

const SEAL_INFLIGHT = new Map();
/**
 * 返回 { ok: true }（校验通过）/ { ok: false, why }（检测到篡改、清单缺失/损坏或不符）/ { ok: null, why }（开发模式或二进制不存在，放行）。
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
  const flightKey = `${bin}|${home}|${fp}|${force ? 1 : 0}`;
  if (SEAL_INFLIGHT.has(flightKey)) return SEAL_INFLIGHT.get(flightKey);
  const run = (async () => {
    let res;
    if (fs.existsSync(path.join(dir, ".mismatch"))) {
      res = { ok: false, why: "recheck found agy binary does not match manifest" };
    } else if (!fs.existsSync(mf)) {
      res = { ok: false, why: "no local manifest" };
    } else {
      let j;
      try {
        j = JSON.parse(await fs.promises.readFile(mf, "utf8"));
      } catch (e) {
        res = { ok: false, why: "manifest read error: " + e.message };
      }
      if (!res) {
        const want = j && typeof j.sha256 === "string" ? j.sha256 : "";
        if (!/^[a-f0-9]{64}$/.test(want)) {
          res = { ok: false, why: "manifest has no sha256" };
        } else {
          try {
            const got = await sha256Async(bin);
            if (got !== want) {
              res = { ok: false, why: "agy binary sha256 mismatch" };
            } else {
              res = { ok: true, version: j.version || (isVer(path.basename(dir)) ? path.basename(dir) : "unknown") };
            }
          } catch (e) {
            res = { ok: false, why: "agy binary verify error: " + e.message };
          }
        }
      }
    }

    if (res.ok === false && !(cache.res && cache.res.ok === false && cache.fp === fp)) {
      log(`⚠️ [Antigravity CLI 核验] ${bin}：${res.why}`);
      tamperRecord("agy", [`${path.basename(dir)}/agy: ${res.why}`]);
    }
    cache = { fp, res };
    return res;
  })().finally(() => { if (SEAL_INFLIGHT.get(flightKey) === run) SEAL_INFLIGHT.delete(flightKey); });
  SEAL_INFLIGHT.set(flightKey, run);
  return run;
}
