// 极简 OpenPGP：只认 v4 的 RSA 公钥包与 v4 RSA 分离签名（Termux 仓库的 Release.gpg、Anthropic 的 manifest.json.sig 都是这种）。
// 正本在 devkit/（组件市场的 CI 只检出这个目录），打 APK 时 build.sh 拷进 app/bin，pkg.mjs、install-claude.mjs 从那里导入。
// 以前各抄一份（审查 10-29 L22）。不认的格式一律抛错，不放行
import crypto from "node:crypto";

// Termux 自动构建钥（main / root / x11 仓库的 Release 都由它签）
export const TERMUX_KEYS = {"CC72CF8BA7DBFA0182877D045A897D96E57CF20C":{"kty":"RSA","n":"yBh7FtnoP4xlWnvU-AUwXXYxgv7waUkxQ-4iE-pv_Ro0Lw7siRcYrJbt-VFVEC8se51FV2HsqgAVCfq3JUtiV82QBJa_h7ffLL5EDdRGlgBG16EtjXQ6nMG1l960a8fQYrP762_EFBO-HjQOknYiGzu7dGW8-nxYiNfRAX-fO8yGljur_JWJq-Ud6y6j2anoHlJ-vGuaKBdCoILPldL_nE3-mkyUzgvVZe3QPHvDEwbMDgCINxJd4U6weRn-IGXSfp4bWk4sOjTbPWFRpqzBpfVpS7ABsOdhWgfryfUC3w-fLZw9H_10QJ8ytnWr7i5cCg8jRd97kTmj7uX0I0ATF_ALjqdQ1ZVb5qjShYP67ZP86sAN9N92WLN7CgrIGfABDXKzHzS8U-RztzfiwXbx0jWHwliUyFZDrH2KZVx6PDYb3TICQGMHdF7MG31fGfKx4z_Anl5oqe1S4QB9IwaRlHQwBRGT1uh2g6YQ0S_BSlA0yd1rw-bpD1OB5AmjB8m3m4YrOCXcNWkxVmTibUup7UdYch-ekS3AkQSFGg4lPM4ZQgAKtt7LMSmlKqG2y8YLliQzR-jL_D8V6dA_OQqSAPtfIFHj5vG_-1G_0pB54WRlR5TckdTvXv241XyliDaRnOozf9NpOfji8e0wlqvmNxO69JTYoFPpgP0u7EMK4Jc","e":"AQAB"}};

// Anthropic 的发布签名钥（https://downloads.claude.ai/keys/claude-code.asc，与 keys.openpgp.org 上同指纹的一致）
// （安装脚本 install-claude.mjs 与开发布局的更新 gw/devside.mjs 共用）
export const ANTHROPIC_KEYS = {"31DDDE24DDFAB679F42D7BD2BAA929FF1A7ECACE":{"kty":"RSA","n":"p28rSV5I8HmK8CK9GixBUZR_gtJxeOCsRXO4EJiej40jzBmQA3cWXGosVO82ZfFsRKVTtMC5iB_HH9sxjncrmYNWGroJNbx29m_FgYQBgkCXT4AfFl6rnnXqRGLZOerj_4AqE4yQ1GZbhBgR55Z7ro0ieKK8RHYUspBKAFHyWRhCCz6THW6YRbf0p_hG_08TOY6Sj3cJ7_AEoTRf9ZmVNX1k0KvbUSiVGpGY9OIHWgxRJUF2pArU4o_hk-sqGAgEUh8Bjvjwvz6-quLXPg-y0Y8Ugb1Fg6BUppam_zydYY_Q_-yNjnuF154gD1jEeeir8R5czs6zUHSbo2yXUpAsIdWYo5End8vGsluVmFExnUWm_fTVMGoM5Wm3v1VRepMydEnJ-atz4oQdmPQcKNAip5GJO2uyk--xFr9CpKvlR5jral92toYV_m-mur3va8ydamWBo_qG7_wt0sdS81IwH6lcu0SQ39rgKD-bdoPLv05EqVMYTFRI2QZEsWGYTMs0DOrfCIJFH50qyD0x4sWw1gEWeG3jDgY8cj2StZz-zjqzUd05CibcCzEAGm1EQg5y9D40tIsAU1OI7bpgQ9V0lC8lrqE7zJY66UK9Z1daA8jrdDi6migNjHFrXfT3V4QvMthCIO05q05SS3x2G3ZpIgmI-CePUPB1pDf-lhPkU1M","e":"AQAB"}};

const CRC24_INIT = 0xb704ce;
const CRC24_POLY = 0x1864cfb;
function crc24(buf) {
  let crc = CRC24_INIT;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i] << 16;
    for (let j = 0; j < 8; j++) {
      crc <<= 1;
      if (crc & 0x1000000) crc ^= CRC24_POLY;
    }
  }
  return crc & 0xffffff;
}

function dearmor(t, wantType = "") {
  const s = String(t || "").replace(/\r\n?/g, "\n");
  const m = /^\s*-----BEGIN PGP (PUBLIC KEY BLOCK|SIGNATURE)-----\n([\s\S]*?)\n-----END PGP \1-----\s*$/.exec(s);
  if (!m) throw new Error("bad armor");
  const kind = m[1];
  if (wantType && kind !== wantType) throw new Error("unexpected armor type " + kind);
  const inner = m[2];
  if (inner.includes("-----BEGIN PGP ") || inner.includes("-----END PGP ")) throw new Error("bad armor");
  let rest;
  if (inner.startsWith("\n")) {
    rest = inner.slice(1);
  } else {
    const blank = inner.indexOf("\n\n");
    if (blank < 0) throw new Error("bad armor header");
    const hdrs = inner.slice(0, blank);
    for (const line of hdrs.split("\n")) {
      if (!/^[A-Za-z0-9-]+:\s*[^\n]*$/.test(line)) throw new Error("bad armor header");
    }
    rest = inner.slice(blank + 2);
  }
  const lines = rest.trimEnd().split("\n");
  let crcLine = null;
  if (lines.length && lines[lines.length - 1].startsWith("=")) {
    crcLine = lines.pop().trim();
    if (!/^=[A-Za-z0-9+/]{4}$/.test(crcLine)) throw new Error("bad armor crc");
  }
  const b64 = lines.map((l) => l.trim()).join("");
  if (!b64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64) || b64.length % 4 !== 0) throw new Error("bad armor base64");
  const buf = Buffer.from(b64, "base64");
  if (!buf.length) throw new Error("empty armor");
  if (crcLine) {
    const expect = Buffer.from(crcLine.slice(1), "base64");
    const expectVal = (expect[0] << 16) | (expect[1] << 8) | expect[2];
    if (crc24(buf) !== expectVal) throw new Error("bad armor crc24");
  }
  return buf;
}

function packets(b) {
  const out = [];
  for (let o = 0; o < b.length;) {
    const h = b[o++]; if (!(h & 0x80)) throw new Error("bad packet");
    let tag, len;
    if (h & 0x40) {
      tag = h & 63;
      if (o >= b.length) throw new Error("truncated packet");
      const l = b[o++];
      if (l < 192) len = l;
      else if (l < 224) {
        if (o >= b.length) throw new Error("truncated packet");
        len = ((l - 192) << 8) + b[o++] + 192;
      } else if (l === 255) {
        if (o + 4 > b.length) throw new Error("truncated packet");
        len = b.readUInt32BE(o);
        o += 4;
      } else throw new Error("partial len");
    } else {
      tag = (h >> 2) & 15;
      const lt = h & 3;
      if (lt === 0) {
        if (o >= b.length) throw new Error("truncated packet");
        len = b[o++];
      } else if (lt === 1) {
        if (o + 2 > b.length) throw new Error("truncated packet");
        len = b.readUInt16BE(o);
        o += 2;
      } else if (lt === 2) {
        if (o + 4 > b.length) throw new Error("truncated packet");
        len = b.readUInt32BE(o);
        o += 4;
      } else {
        len = b.length - o;
      }
    }
    if (len === undefined || !Number.isInteger(len) || len < 0 || o + len > b.length) {
      throw new Error("truncated packet");
    }
    out.push({ tag, body: b.subarray(o, o + len) });
    o += len;
  }
  return out;
}

const mpi = (b, o) => {
  if (o + 2 > b.length) throw new Error("truncated mpi");
  const bits = b.readUInt16BE(o), n = (bits + 7) >> 3;
  if (o + 2 + n > b.length) throw new Error("truncated mpi");
  return [b.subarray(o + 2, o + 2 + n), o + 2 + n];
};
const b64u = (x) => Buffer.from(x).toString("base64url");
/** 公钥块里所有 RSA 钥（主钥 + 子钥）：[{fpr, jwk}] */
export function rsaKeys(armored) {
  const keys = [];
  for (const p of packets(dearmor(armored, "PUBLIC KEY BLOCK"))) {
    if ((p.tag !== 6 && p.tag !== 14) || p.body.length < 8 || p.body[0] !== 4 || p.body[5] !== 1) continue;
    const [n, o1] = mpi(p.body, 6), [e] = mpi(p.body, o1);
    const hdr = Buffer.from([0x99, p.body.length >> 8, p.body.length & 255]);
    keys.push({ fpr: crypto.createHash("sha1").update(hdr).update(p.body).digest("hex").toUpperCase(), primary: p.tag === 6, jwk: { kty: "RSA", n: b64u(n), e: b64u(e) } });
  }
  return keys;
}
/** 验分离签名：data 是被签的原始字节，keys 是 {指纹: jwk}。返回签名用的指纹，不通过抛错 */
export function verifyDetached(data, sigArmored, keys, opts = {}) {
  const sp = packets(dearmor(sigArmored, "SIGNATURE")).find((p) => p.tag === 2);
  if (!sp) throw new Error("no signature packet");
  const s = sp.body;
  if (s.length < 10 || s[0] !== 4 || s[1] !== 0 || s[2] !== 1) throw new Error("unsupported signature (want v4 binary RSA)");
  const hashName = { 8: "sha256", 9: "sha384", 10: "sha512" }[s[3]];
  if (!hashName) throw new Error("unsupported hash " + s[3]);
  const hl = s.readUInt16BE(4);
  if (6 + hl + 2 > s.length) throw new Error("truncated signature");
  const hashed = s.subarray(0, 6 + hl);
  let fpr = "";
  let creationTime = null;
  let expDelta = null;
  const parseSubs = (buf, isHashed) => {
    for (let o = 0; o < buf.length;) {
      let l = buf[o++];
      if (l === undefined) throw new Error("truncated subpacket");
      if (l >= 192 && l < 255) {
        if (o >= buf.length) throw new Error("truncated subpacket");
        l = ((l - 192) << 8) + buf[o++] + 192;
      } else if (l === 255) {
        if (o + 4 > buf.length) throw new Error("truncated subpacket");
        l = buf.readUInt32BE(o);
        o += 4;
      }
      if (l < 1 || o + l > buf.length) throw new Error("bad subpacket length");
      const rawType = buf[o];
      const critical = (rawType & 0x80) !== 0;
      const t = rawType & 0x7f;
      const body = buf.subarray(o + 1, o + l);
      if (t === 33) {
        if (body.length === 21 && body[0] === 4) {
          if (!fpr) fpr = body.subarray(1).toString("hex").toUpperCase();
        } else if (critical) {
          throw new Error("bad critical issuer fingerprint");
        }
      } else if (isHashed && t === 2) {
        if (body.length !== 4) throw new Error("bad signature creation time");
        creationTime = body.readUInt32BE(0);
      } else if (isHashed && t === 3) {
        if (body.length !== 4) throw new Error("bad signature expiration time");
        expDelta = body.readUInt32BE(0);
      } else if (critical) {
        throw new Error("unsupported critical subpacket " + t);
      }
      o += l;
    }
  };
  parseSubs(s.subarray(6, 6 + hl), true);
  const ul = s.readUInt16BE(6 + hl);
  if (8 + hl + ul + 2 > s.length) throw new Error("truncated signature");
  parseSubs(s.subarray(8 + hl, 8 + hl + ul), false);
  if (expDelta !== null && expDelta > 0) {
    if (creationTime === null) throw new Error("signature expiration without creation time");
    const nowSec = opts.now !== undefined ? Number(opts.now) : Math.floor(Date.now() / 1000);
    if (!Number.isFinite(nowSec) || nowSec >= creationTime + expDelta) {
      throw new Error("signature expired");
    }
  }
  const jwk = keys[fpr];
  if (!jwk) throw new Error("signed by unknown key " + (fpr || "?"));
  const [sig, sigEnd] = mpi(s, 8 + hl + ul + 2);
  if (sigEnd !== s.length) throw new Error("trailing signature data");
  const trailer = Buffer.alloc(6); trailer[0] = 4; trailer[1] = 0xff; trailer.writeUInt32BE(hashed.length, 2);
  const pub = crypto.createPublicKey({ key: jwk, format: "jwk" });
  const nlen = Buffer.from(jwk.n, "base64url").length, sigp = Buffer.concat([Buffer.alloc(Math.max(0, nlen - sig.length)), sig]);
  const msg = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (!crypto.verify(hashName, Buffer.concat([msg, hashed, trailer]), pub, sigp)) throw new Error("bad signature");
  return fpr;
}
