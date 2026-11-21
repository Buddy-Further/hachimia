// cccodroid 组件市场兼容：索引与镜像配置、跨底座构建匹配、以及等长包名前缀迁移（cc.codroid → ha.chi.mia）。
// 运行：node scripts/test.mjs fix-e-comp-index
import "../gw/config.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import zlib from "node:zlib";
import { execFileSync } from "node:child_process";
import { PREFIX } from "../gw/config.mjs";
import { relocateTree } from "../gw/comp-relocate.mjs";

const DK_SHA = "919a05cd57dd5942ca973d616b28d3e94b8ec02a8f375910bb1382df34943273";
const CC_OLD = "13ba8abc3e53715175a966a302b1b2913400586899c12a4ece1ede73d042bcc2";
const CC_NEW = "3768afcf79a7cfb3b8db27d9d1d2951aaaade4caa79d5a1179cf495ebd14c67d";
const COMP_DIR = path.join(path.dirname(PREFIX), "components");
const OK = path.join(PREFIX, ".devkit-ok");
const MOD_JSON = path.join(PREFIX, "libexec/devkit/modules.json");

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
function makeZip(entries) {
  const locals = [], cens = [];
  let pos = 0;
  for (const { name, data, deflate = true } of entries) {
    const nb = Buffer.from(name), raw = Buffer.from(data);
    const body = deflate ? zlib.deflateRawSync(raw) : raw;
    const method = deflate ? 8 : 0, crc = crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nb.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(method, 10); cen.writeUInt32LE(crc, 16); cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(raw.length, 24); cen.writeUInt16LE(nb.length, 28); cen.writeUInt32LE(pos, 42);
    locals.push(lh, nb, body);
    cens.push(cen, nb);
    pos += 30 + nb.length + body.length;
  }
  const cd = Buffer.concat(cens);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8); eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.length, 12); eocd.writeUInt32LE(pos, 16);
  return Buffer.concat([...locals, cd, eocd]);
}
function readZipEntry(buf, want) {
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const nent = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < nent; i++) {
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const lo = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf8");
    p += 46 + nlen + elen + clen;
    if (name !== want) continue;
    const d0 = lo + 30 + buf.readUInt16LE(lo + 26) + buf.readUInt16LE(lo + 28);
    const raw = buf.subarray(d0, d0 + csize);
    return method === 8 ? zlib.inflateRawSync(raw) : raw;
  }
  return null;
}

const S = { preset: "", community: "", tarGz: null };
const server = http.createServer((req, res) => {
  if (req.url === "/preset.json") { res.writeHead(200, { "content-type": "application/json" }); return res.end(S.preset); }
  if (req.url === "/community.json") { res.writeHead(200, { "content-type": "application/json" }); return res.end(S.community); }
  if (req.url === "/demo-compat.tar.gz" && S.tarGz) {
    res.writeHead(200, { "content-type": "application/gzip", "content-length": S.tarGz.length });
    return res.end(S.tarGz);
  }
  res.writeHead(404); res.end();
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const B = `http://127.0.0.1:${server.address().port}`;
const TMP_WORK = path.join(path.dirname(PREFIX), "tmp-comp-compat-test");
const addedBins = [];
function ensurePrefixBin(name) {
  const dst = path.join(PREFIX, "bin", name);
  if (fs.existsSync(dst)) return dst;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const src = String(execFileSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" })).trim();
  fs.symlinkSync(src, dst);
  addedBins.push(dst);
  return dst;
}
after(() => {
  server.close();
  for (const k of [
    "CCAPP_COMPONENTS_INDEX", "CCAPP_COMPONENTS_INDEX_MIRROR",
    "CCAPP_COMPONENTS_COMMUNITY_INDEX", "CCAPP_COMPONENTS_COMMUNITY_INDEX_MIRROR",
    "CCAPP_COMPONENTS_MIRROR_BASE", "CCAPP_COMPONENTS_ALLOW_UNSIGNED",
    "CCAPP_COMP_TARGET_PKG",
  ]) delete process.env[k];
  fs.rmSync(TMP_WORK, { recursive: true, force: true });
  for (const bin of ["tar", "sh"]) {
    const p = path.join(PREFIX, "bin", bin);
    if (addedBins.includes(p)) fs.rmSync(p, { force: true });
  }
  fs.rmSync(path.join(COMP_DIR, "chromium.json"), { force: true });
  fs.rmSync(path.join(COMP_DIR, "demo-compat.json"), { force: true });
  fs.rmSync(path.join(COMP_DIR, "index.cache"), { force: true });
  fs.rmSync(OK, { force: true });
  fs.rmSync(MOD_JSON, { force: true });
});

let n = 0;
const fresh = () => import("../gw/components.mjs?i=" + ++n);

test("组件市场默认接入 cccodroid 官方与社区索引及镜像，且保留环境变量覆盖能力", () => {
  const src = fs.readFileSync(new URL("../gw/components.mjs", import.meta.url), "utf8");
  assert.ok(src.includes("greyoak111/cccodroid/releases/download/components/components.json"), "预置索引默认接入 cccodroid 官方组件");
  assert.ok(src.includes("greyoak111/cccodroid-components/releases/download/index/components.json"), "社区索引默认接入 cccodroid-components");
  assert.ok(src.includes("https://cccodroid.net/components/official/components.json"), "预置索引镜像默认指向 cccodroid.net");
  assert.ok(src.includes("https://cccodroid.net/components/community/components.json"), "社区索引镜像默认指向 cccodroid.net");
  assert.ok(src.includes("https://dl.cccodroid.net/components"), "组件包镜像默认指向 dl.cccodroid.net");
  assert.ok(src.includes("process.env.CCAPP_COMPONENTS_COMMUNITY_INDEX ??"), "支持用空环境变量显式停用社区源");
});

test("compBuildFor：精确底座优先；未命中时挑选 baseDeps 满足且底座最新的 cccodroid 构建", async () => {
  process.env.CCAPP_COMP_TARGET_PKG = "ha.chi.mia";
  fs.mkdirSync(path.dirname(MOD_JSON), { recursive: true });
  fs.writeFileSync(MOD_JSON, JSON.stringify({
    modules: [
      { id: "base", kind: "base", dir: "libexec/devkit", packages: [{ name: "openssl" }, { name: "zlib" }] },
      { id: "extra", kind: "opt", dir: "libexec/devkit/modules/extra", packages: [{ name: "python" }] },
    ],
  }));
  const m = await fresh();
  const { compBuildFor, compState, compWriteRecord } = m._compForTest;
  const dk = { sha256: DK_SHA };
  const allComps = {
    gh: {
      builds: [
        { base: CC_OLD, baseTag: "devkit-2026.10.14.2", version: "2.105.0-r2", sha256: "1".repeat(64),
          url: "https://github.com/greyoak111/cccodroid-components/releases/download/gh/gh-old.tar.gz", baseDeps: ["openssl"] },
        { base: CC_NEW, baseTag: "devkit-2026.10.28", version: "2.105.0-r2", sha256: "2".repeat(64),
          url: "https://github.com/greyoak111/cccodroid-components/releases/download/gh/gh-new.tar.gz", baseDeps: ["openssl", "python"] },
      ],
    },
    chromium: {
      builds: [
        { base: CC_OLD, version: "155.0.0", sha256: "3".repeat(64),
          url: "https://github.com/greyoak111/cccodroid/releases/download/components/c-old.tar.gz", baseDeps: ["zlib"] },
        { base: CC_NEW, version: "156.0.0", sha256: "4".repeat(64),
          url: "https://github.com/greyoak111/cccodroid/releases/download/components/c-new.tar.gz", baseDeps: ["zlib"] },
      ],
    },
    missingDep: {
      builds: [
        { base: CC_NEW, baseTag: "devkit-2026.10.28", version: "1.0.0", sha256: "5".repeat(64),
          url: "https://github.com/greyoak111/cccodroid-components/releases/download/m/m.tar.gz", baseDeps: ["nonexistent-lib"] },
      ],
    },
    nonCcForeign: {
      builds: [
        { base: CC_NEW, version: "9.9.9", sha256: "6".repeat(64),
          url: "https://github.com/Buddy-Further/hachimia/releases/download/components/other.tar.gz", baseDeps: [] },
      ],
    },
  };

  // 社区组件选出最新底座 devkit-2026.10.28
  const ghPick = compBuildFor(allComps.gh, dk, allComps);
  assert.equal(ghPick?.base, CC_NEW);
  assert.equal(ghPick?._compat, true);

  // 官方预置组件本身没带 baseTag，但复用全索引 baseTag 映射后同样选出最新底座 CC_NEW
  const crPick = compBuildFor(allComps.chromium, dk, allComps);
  assert.equal(crPick?.base, CC_NEW);
  assert.equal(crPick?._compat, true);

  // baseDeps 含当前工具包（含未装模块）完全不存在的包 → 拒绝匹配
  assert.equal(compBuildFor(allComps.missingDep, dk, allComps), null);

  // 非 cccodroid 市场来源且 base 对不上 → 不走跨底座兜底
  assert.equal(compBuildFor(allComps.nonCcForeign, dk, allComps), null);

  // 精确匹配优先且不标 _compat
  const nativeEntry = { builds: [...allComps.chromium.builds, { base: DK_SHA, version: "156.0.1", sha256: "9".repeat(64), url: "https://github.com/Buddy-Further/hachimia/releases/download/components/c.tar.gz" }] };
  const natPick = compBuildFor(nativeEntry, dk, allComps);
  assert.equal(natPick?.base, DK_SHA);
  assert.equal(natPick?._compat, undefined);

  // 已装记录记本机 dk.sha256，更新检测按 sha256 + 版本比对生效
  fs.mkdirSync(COMP_DIR, { recursive: true });
  assert.ok(compWriteRecord("chromium", { state: "ok", base: DK_SHA, upstreamBase: CC_OLD, sha256: "3".repeat(64), version: "155.0.0", bin: [], files: [] }));
  assert.equal(compState("chromium", allComps.chromium, dk, allComps), "update");
  assert.ok(compWriteRecord("chromium", { state: "ok", base: DK_SHA, upstreamBase: CC_NEW, sha256: "4".repeat(64), version: "156.0.0", bin: [], files: [] }));
  assert.equal(compState("chromium", allComps.chromium, dk, allComps), "ok");
  assert.equal(compState("chromium", allComps.chromium, { sha256: "0".repeat(64) }, allComps), "outdated");
});

test("端到端兼容安装：cccodroid 包验签核 MANIFEST 后等长迁移至 ha.chi.mia，状态与对账全绿", async () => {
  process.env.CCAPP_COMP_TARGET_PKG = "ha.chi.mia";
  fs.rmSync(TMP_WORK, { recursive: true, force: true });
  fs.rmSync(MOD_JSON, { force: true });
  const stagePkg = path.join(TMP_WORK, "pkg");
  const usr = path.join(stagePkg, "usr");
  fs.mkdirSync(path.join(usr, "bin"), { recursive: true });
  fs.mkdirSync(path.join(usr, "lib/demo-compat"), { recursive: true });
  fs.mkdirSync(path.join(usr, "share/gdb/auto-load/data/data/cc.codroid/files/usr/lib"), { recursive: true });
  fs.mkdirSync(path.join(usr, "var/lib/dpkg/info"), { recursive: true });
  fs.mkdirSync(path.join(usr, "libexec/devkit/components/demo-compat"), { recursive: true });

  const sh = "#!/data/data/cc.codroid/files/usr/bin/sh\necho /data/user/0/cc.codroid/files/home/workspace\n";
  const fakeElf = Buffer.concat([Buffer.from("\x7fELF\x02\x01\x01\x00"), Buffer.from("/data/data/cc.codroid/files/usr/lib\x00")]);
  const zipBuf = makeZip([{ name: "meta/cfg.txt", data: "RUNPATH=/data/data/cc.codroid/files/usr/lib\n" }]);
  const listTxt = "/data/data/cc.codroid/files/usr/bin/demo-tool\n/data/data/cc.codroid/files/usr/lib/demo-compat/app.bin\n";
  const gdbPy = "# auto-load for /data/data/cc.codroid/files/usr/lib/libdemo.so\n";
  const firstRun = `#!/bin/sh\necho "/data/data/cc.codroid/files/usr" > "${path.join(TMP_WORK, "first-run.out")}"\n`;

  fs.writeFileSync(path.join(usr, "bin/demo-tool"), sh, { mode: 0o755 });
  fs.writeFileSync(path.join(usr, "lib/demo-compat/app.bin"), fakeElf, { mode: 0o755 });
  fs.writeFileSync(path.join(usr, "lib/demo-compat/bundle.zip"), zipBuf, { mode: 0o644 });
  fs.writeFileSync(path.join(usr, "share/gdb/auto-load/data/data/cc.codroid/files/usr/lib/libdemo.so-gdb.py"), gdbPy, { mode: 0o644 });
  fs.writeFileSync(path.join(usr, "var/lib/dpkg/info/demo-compat.list"), listTxt, { mode: 0o644 });
  fs.writeFileSync(path.join(usr, "libexec/devkit/components/demo-compat/first-run.sh"), firstRun, { mode: 0o755 });
  fs.symlinkSync("/data/data/cc.codroid/files/usr/lib/demo-compat/app.bin", path.join(usr, "lib/demo-compat/app.link"));

  // 按原始 cc.codroid 文件字节生成 MANIFEST（校验在迁移之前执行）
  const manFiles = [
    "bin/demo-tool",
    "lib/demo-compat/app.bin",
    "lib/demo-compat/bundle.zip",
    "share/gdb/auto-load/data/data/cc.codroid/files/usr/lib/libdemo.so-gdb.py",
    "var/lib/dpkg/info/demo-compat.list",
    "libexec/devkit/components/demo-compat/first-run.sh",
  ];
  const manLines = manFiles.map((rel) => {
    const b = fs.readFileSync(path.join(usr, rel));
    return `${crypto.createHash("sha256").update(b).digest("hex")} ${b.length} ${rel}`;
  });
  fs.writeFileSync(path.join(usr, "libexec/devkit/components/demo-compat/MANIFEST"), manLines.join("\n") + "\n");

  const tarBin = ensurePrefixBin("tar");
  ensurePrefixBin("sh");
  const tarGzPath = path.join(TMP_WORK, "demo-compat.tar.gz");
  execFileSync(tarBin, ["-czf", tarGzPath, "-C", stagePkg, "usr"]);
  S.tarGz = fs.readFileSync(tarGzPath);
  const tarSha = crypto.createHash("sha256").update(S.tarGz).digest("hex");

  S.preset = JSON.stringify({ components: {} });
  S.community = JSON.stringify({
    components: {
      "demo-compat": {
        name: { zh: "兼容测试组件", en: "Compat Demo" },
        builds: [{
          base: CC_NEW, baseTag: "devkit-2026.10.28", compat: true,
          version: "1.0.0-r1", upstream: "1.0.0",
          url: B + "/demo-compat.tar.gz", asset: "demo-compat.tar.gz",
          sha256: tarSha, bytes: S.tarGz.length, installed: 8192,
          bin: ["demo-tool"], baseDeps: [],
        }],
      },
    },
  });
  fs.mkdirSync(COMP_DIR, { recursive: true });
  fs.rmSync(path.join(COMP_DIR, "index.cache"), { force: true });
  fs.writeFileSync(OK, JSON.stringify({ sha256: DK_SHA }));
  Object.assign(process.env, {
    CCAPP_COMPONENTS_INDEX: B + "/preset.json",
    CCAPP_COMPONENTS_INDEX_MIRROR: B + "/missing-m.json",
    CCAPP_COMPONENTS_COMMUNITY_INDEX: B + "/community.json",
    CCAPP_COMPONENTS_COMMUNITY_INDEX_MIRROR: B + "/missing-cm.json",
    CCAPP_COMPONENTS_MIRROR_BASE: "",
    CCAPP_COMPONENTS_ALLOW_UNSIGNED: "1",
  });

  const m = await fresh();
  const r = await m.compRepair("demo-compat");
  assert.equal(r.ok, true, JSON.stringify(r));
  const err = await r.done;
  assert.equal(err, "", "兼容安装应成功：" + err);

  // 1) 记录身份：base 记本机 devkit，upstreamBase 记上游 cccodroid 底座
  const rec = m.compRecord("demo-compat");
  assert.equal(rec.state, "ok");
  assert.equal(rec.base, DK_SHA);
  assert.equal(rec.upstreamBase, CC_NEW);

  // 2) 脚本、ELF、zip、软链、dpkg 清单、目录名、first-run.sh 全部完成等长迁移
  const installedSh = fs.readFileSync(path.join(PREFIX, "bin/demo-tool"), "utf8");
  assert.ok(installedSh.includes("/data/data/ha.chi.mia/files/usr/bin/sh"));
  assert.ok(installedSh.includes("/data/user/0/ha.chi.mia/files/home/workspace"));
  assert.ok(!installedSh.includes("cc.codroid"));

  const installedElf = fs.readFileSync(path.join(PREFIX, "lib/demo-compat/app.bin"));
  assert.equal(installedElf.length, fakeElf.length, "ELF 长度必须严格保持等长");
  assert.ok(installedElf.includes(Buffer.from("/data/data/ha.chi.mia/files/usr/lib\x00")));
  assert.ok(!installedElf.includes(Buffer.from("cc.codroid")));

  const installedZip = fs.readFileSync(path.join(PREFIX, "lib/demo-compat/bundle.zip"));
  const zipText = readZipEntry(installedZip, "meta/cfg.txt")?.toString("utf8");
  assert.equal(zipText, "RUNPATH=/data/data/ha.chi.mia/files/usr/lib\n");

  assert.equal(
    fs.readlinkSync(path.join(PREFIX, "lib/demo-compat/app.link")),
    "/data/data/ha.chi.mia/files/usr/lib/demo-compat/app.bin",
  );
  assert.ok(fs.existsSync(path.join(PREFIX, "share/gdb/auto-load/data/data/ha.chi.mia/files/usr/lib/libdemo.so-gdb.py")));
  assert.ok(!fs.existsSync(path.join(PREFIX, "share/gdb/auto-load/data/data/cc.codroid")));

  const installedList = fs.readFileSync(path.join(PREFIX, "var/lib/dpkg/info/demo-compat.list"), "utf8");
  assert.ok(installedList.includes("/data/data/ha.chi.mia/files/usr/bin/demo-tool"));
  assert.ok(!installedList.includes("cc.codroid"));

  const frOut = fs.readFileSync(path.join(TMP_WORK, "first-run.out"), "utf8").trim();
  assert.equal(frOut, "/data/data/ha.chi.mia/files/usr", "first-run.sh 应以迁移后的前缀执行");

  // 3) 卸载干净
  const rmRes = await m.compRemove("demo-compat");
  assert.equal(rmRes.ok, true, JSON.stringify(rmRes));
  assert.ok(!fs.existsSync(path.join(PREFIX, "bin/demo-tool")));
});

test("大文件分块原地迁移：跨越 2 MB 块边界与只读权限均正确改写且不损坏长度", async () => {
  const dir = path.join(TMP_WORK, "large");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const big = path.join(dir, "huge.bin");
  const size = (4 << 20) + 128; // > SMALL_LIMIT，走 2 MB 分块路径
  const buf = Buffer.alloc(size, 0x41);
  const pat1 = Buffer.from("/data/data/cc.codroid/files/usr/lib");
  const pat2 = Buffer.from("/data/user/0/cc.codroid/files/home");
  // 故意让 pat1 跨越 2 MB（CHUNK_SIZE）边界
  const boundaryOff = (2 << 20) - 10;
  pat1.copy(buf, boundaryOff);
  pat2.copy(buf, (4 << 20) - 12);
  fs.writeFileSync(big, buf);
  fs.chmodSync(big, 0o400);
  const beforePerm = fs.lstatSync(big).mode & 0o777;

  const st = await relocateTree(dir, "cc.codroid", "ha.chi.mia");
  assert.equal(st.files, 1);
  assert.equal(st.hits, 2);

  const afterStat = fs.lstatSync(big);
  assert.equal(afterStat.size, size);
  assert.equal(afterStat.mode & 0o777, beforePerm, "只读权限位应原样恢复");
  const out = fs.readFileSync(big);
  assert.equal(out.subarray(boundaryOff, boundaryOff + pat1.length).toString(), "/data/data/ha.chi.mia/files/usr/lib");
  assert.equal(out.subarray((4 << 20) - 12, (4 << 20) - 12 + pat2.length).toString(), "/data/user/0/ha.chi.mia/files/home");
  assert.equal(out.indexOf(Buffer.from("cc.codroid")), -1);
});
