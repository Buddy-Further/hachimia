// 等长包名前缀迁移：把按 cccodroid（/data/data/cc.codroid/）打好的组件包就地改写为本应用前缀（如 /data/data/ha.chi.mia/）。
// 与 devkit.mjs / pkg.mjs 同理：com.termux / cc.codroid / ha.chi.mia 均为 10 字节，
// 逐字节等长替换即可修正 ELF RUNPATH/PT_INTERP、shebang、dpkg 清单、脚本与 zip 归档，无需重新编译。
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const ZIP_EXT = [".jmod", ".jar", ".zip", ".whl", ".egg", ".aar", ".apk"];
const looksLikeZip = (name) => ZIP_EXT.some((e) => name.toLowerCase().endsWith(e));
const SMALL_LIMIT = 4 << 20;   // <= 4 MB 整读原地替换
const ZIP_LIMIT = 64 << 20;    // <= 64 MB 进 zip 重建，避免超大资源包撑爆内存
const CHUNK_SIZE = 2 << 20;    // 大文件（如 Chromium 主程序 ~250 MB）按 2 MB 分块原地改写
const OVERLAP = 32;            // 大于最长模式（data/user/0/cc.codroid/ = 23 字节），防跨块漏匹配

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

export function makePairs(fromPkg, toPkg) {
  if (!fromPkg || !toPkg || fromPkg === toPkg || fromPkg.length !== toPkg.length) return [];
  return [
    [Buffer.from(`data/data/${fromPkg}/`), Buffer.from(`data/data/${toPkg}/`)],
    [Buffer.from(`data/user/0/${fromPkg}/`), Buffer.from(`data/user/0/${toPkg}/`)],
  ];
}

/** 原地等长替换 buf 中所有命中；返回命中次数 */
export function swapBufInPlace(buf, pairs) {
  let hits = 0;
  for (const [from, to] of pairs) {
    let i = buf.indexOf(from);
    while (i >= 0) {
      to.copy(buf, i);
      hits++;
      i = buf.indexOf(from, i + from.length);
    }
  }
  return hits;
}

function swapBufCopy(buf, pairs) {
  let has = false;
  for (const [from] of pairs) if (buf.indexOf(from) >= 0) { has = true; break; }
  if (!has) return [buf, 0];
  const out = Buffer.from(buf);
  const hits = swapBufInPlace(out, pairs);
  return [out, hits];
}

function swapStr(s, fromPkg, toPkg) {
  return s
    .split(`data/data/${fromPkg}/`).join(`data/data/${toPkg}/`)
    .split(`data/user/0/${fromPkg}/`).join(`data/user/0/${toPkg}/`);
}

/** 对 zip 类归档（.jar/.zip/.whl/.jmod/.egg/.aar/.apk）的条目名与内容做等长前缀改写，按中央目录顺序重建 */
export function rewriteZip(buf, pairs) {
  const LOC = 0x04034b50, CEN = 0x02014b50, EOCD = 0x06054b50;
  let base = -1;
  for (const o of [0, 4, 8]) if (o + 4 <= buf.length && buf.readUInt32LE(o) === LOC) { base = o; break; }
  if (base < 0) return [buf, 0];
  let eocd = -1;
  for (let i = buf.length - 22; i >= base && i >= buf.length - 22 - 65535; i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) return [buf, 0];
  const nent = buf.readUInt16LE(eocd + 10);
  const cdOff = buf.readUInt32LE(eocd + 16) + base;
  if (nent === 0xffff || cdOff === 0xffffffff) return [buf, 0];

  let hits = 0, pos = base, p = cdOff;
  const locals = [], cens = [];
  for (let i = 0; i < nent; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN) return [buf, 0];
    const cen = Buffer.from(buf.subarray(p, p + 46));
    const nlen = cen.readUInt16LE(28), elen = cen.readUInt16LE(30), clen = cen.readUInt16LE(32);
    const name = Buffer.from(buf.subarray(p + 46, p + 46 + nlen));
    const extra = Buffer.from(buf.subarray(p + 46 + nlen, p + 46 + nlen + elen));
    const comment = Buffer.from(buf.subarray(p + 46 + nlen + elen, p + 46 + nlen + elen + clen));
    const method = cen.readUInt16LE(10), csize = cen.readUInt32LE(20), lo = cen.readUInt32LE(42) + base;
    p += 46 + nlen + elen + clen;

    if (lo + 30 > buf.length || buf.readUInt32LE(lo) !== LOC) return [buf, 0];
    const lnlen = buf.readUInt16LE(lo + 26), lelen = buf.readUInt16LE(lo + 28);
    const lh = Buffer.from(buf.subarray(lo, lo + 30));
    const lname = Buffer.from(buf.subarray(lo + 30, lo + 30 + lnlen));
    const lextra = buf.subarray(lo + 30 + lnlen, lo + 30 + lnlen + lelen);

    const [nameOut, kn] = swapBufCopy(name, pairs);
    const [lnameOut] = swapBufCopy(lname, pairs);
    hits += kn;

    let data = Buffer.from(buf.subarray(lo + 30 + lnlen + lelen, lo + 30 + lnlen + lelen + csize));
    let usize = cen.readUInt32LE(24), crc = cen.readUInt32LE(16);
    if (method === 8) {
      let raw;
      try { raw = zlib.inflateRawSync(data); } catch { return [buf, 0]; }
      const k = swapBufInPlace(raw, pairs);
      if (k) {
        hits += k;
        data = zlib.deflateRawSync(raw, { level: 9 });
        usize = raw.length;
        crc = crc32(raw);
        cen.writeUInt32LE(data.length, 20);
        cen.writeUInt32LE(usize, 24);
        cen.writeUInt32LE(crc, 16);
      }
    } else if (method === 0) {
      const k = swapBufInPlace(data, pairs);
      if (k) {
        hits += k;
        crc = crc32(data);
        cen.writeUInt32LE(crc, 16);
      }
    } else {
      return [buf, 0];
    }

    lh.writeUInt16LE(lh.readUInt16LE(6) & ~8, 6);
    cen.writeUInt16LE(cen.readUInt16LE(8) & ~8, 8);
    cen.writeUInt32LE(pos - base, 42);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(usize, 22);
    lh.writeUInt32LE(crc, 14);
    locals.push(lh, lnameOut, lextra, data);
    cens.push(cen, nameOut, extra, comment);
    pos += 30 + lnlen + lelen + data.length;
  }
  if (!hits) return [buf, 0];
  const cd = Buffer.concat(cens);
  const e = Buffer.from(buf.subarray(eocd, eocd + 22));
  e.writeUInt32LE(cd.length, 12);
  e.writeUInt32LE(pos - base, 16);
  return [Buffer.concat([buf.subarray(0, base), ...locals, cd, e, buf.subarray(eocd + 22)]), hits];
}

function breakHardlink(file, mode) {
  const tmp = file + ".reloc-tmp";
  try {
    fs.copyFileSync(file, tmp);
    fs.chmodSync(tmp, mode & 0o7777);
    fs.renameSync(tmp, file);
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch {}
    throw e;
  }
}

async function relocateLargeFile(file, st, pairs, yieldFn, cancelled) {
  if (st.nlink > 1) breakHardlink(file, st.mode);
  const perm = st.mode & 0o7777;
  const needChmod = (perm & 0o200) === 0;
  if (needChmod) fs.chmodSync(file, perm | 0o200);
  const fd = fs.openSync(file, "r+");
  const buf = Buffer.allocUnsafe(CHUNK_SIZE);
  let totalHits = 0;
  try {
    let pos = 0;
    while (pos < st.size) {
      if (cancelled && cancelled()) throw new Error("cancelled");
      const toRead = Math.min(CHUNK_SIZE, st.size - pos);
      const n = fs.readSync(fd, buf, 0, toRead, pos);
      if (n <= 0) break;
      const view = buf.subarray(0, n);
      const k = swapBufInPlace(view, pairs);
      if (k > 0) {
        fs.writeSync(fd, buf, 0, n, pos);
        totalHits += k;
      }
      if (pos + n >= st.size) break;
      pos += n - OVERLAP;
      if (yieldFn) await yieldFn();
    }
  } finally {
    fs.closeSync(fd);
    if (needChmod) { try { fs.chmodSync(file, perm); } catch {} }
  }
  return totalHits;
}

/** 迁移暂存树（stageUsr，对应 $PREFIX）：
 *  1) 把 data/data/<fromPkg> 与 data/user/0/<fromPkg> 目录段重命名成 <toPkg>（如 gdb auto-load）；
 *  2) 改写软链目标与普通文件内容（含 zip 类归档；大文件按 2 MB 分块原地改写控制内存）。 */
export async function relocateTree(stageUsr, fromPkg, toPkg, { yieldFn, cancelled } = {}) {
  const pairs = makePairs(fromPkg, toPkg);
  if (!pairs.length) return { files: 0, links: 0, paths: 0, hits: 0 };
  const stats = { files: 0, links: 0, paths: 0, hits: 0 };

  // 1) 自底向上重命名路径中的 data/data/<fromPkg> 与 data/user/0/<fromPkg> 目录
  async function renameDirs(rel) {
    const abs = rel ? path.join(stageUsr, rel) : stageUsr;
    let ents;
    try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const d of ents) {
      if (cancelled && cancelled()) throw new Error("cancelled");
      const r = rel ? rel + "/" + d.name : d.name;
      if (d.isDirectory()) await renameDirs(r);
      if (d.name === fromPkg && /(?:^|\/)data\/(?:data|user\/0)$/.test(rel)) {
        const src = path.join(abs, fromPkg), dst = path.join(abs, toPkg);
        if (!fs.existsSync(dst)) {
          fs.renameSync(src, dst);
          stats.paths++;
        }
      }
    }
  }
  await renameDirs("");

  // 2) 改写全部软链与普通文件
  let seen = 0;
  async function walk(rel) {
    const abs = rel ? path.join(stageUsr, rel) : stageUsr;
    let ents;
    try { ents = fs.readdirSync(abs, { withFileTypes: true }); } catch { return; }
    for (const d of ents) {
      if (cancelled && cancelled()) throw new Error("cancelled");
      const r = rel ? rel + "/" + d.name : d.name;
      const f = path.join(stageUsr, r);
      if (d.isDirectory()) { await walk(r); continue; }
      if (d.isSymbolicLink()) {
        const t = fs.readlinkSync(f);
        const t2 = swapStr(t, fromPkg, toPkg);
        if (t2 !== t) {
          fs.unlinkSync(f);
          fs.symlinkSync(t2, f);
          stats.links++;
          stats.hits++;
        }
      } else if (d.isFile()) {
        const st = fs.lstatSync(f);
        if (st.size > 0) {
          if (looksLikeZip(r) && st.size <= ZIP_LIMIT) {
            const raw = fs.readFileSync(f);
            const [out, k] = rewriteZip(raw, pairs);
            if (k > 0) {
              if (st.nlink > 1) fs.unlinkSync(f);
              const perm = st.mode & 0o7777;
              if (st.nlink <= 1 && (perm & 0o200) === 0) fs.chmodSync(f, perm | 0o200);
              fs.writeFileSync(f, out);
              fs.chmodSync(f, perm);
              stats.files++;
              stats.hits += k;
            }
          } else if (st.size <= SMALL_LIMIT) {
            const raw = fs.readFileSync(f);
            const k = swapBufInPlace(raw, pairs);
            if (k > 0) {
              if (st.nlink > 1) fs.unlinkSync(f);
              const perm = st.mode & 0o7777;
              if (st.nlink <= 1 && (perm & 0o200) === 0) fs.chmodSync(f, perm | 0o200);
              fs.writeFileSync(f, raw);
              fs.chmodSync(f, perm);
              stats.files++;
              stats.hits += k;
            }
          } else {
            const k = await relocateLargeFile(f, st, pairs, yieldFn, cancelled);
            if (k > 0) { stats.files++; stats.hits += k; }
          }
        }
      }
      if ((++seen & 63) === 0 && yieldFn) await yieldFn();
    }
  }
  await walk("");
  return stats;
}
