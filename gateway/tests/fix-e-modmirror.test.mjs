// E-06：模块下载镜像已死（dl.cccodroid.net/devkit/ 全是 404）。
// 修复后模块安装只走 GitHub Release，不应再向 cccodroid 镜像发任何请求。
// 测试做法：把 $PREFIX/bin/curl 换成记日志的包装脚本；本地服务第一次对模块包返回 404
// （逼下载循环换源重试），随后返回 200。修好前第二次尝试会去 dl.cccodroid.net，日志里留痕；修好后全程只走 GitHub。
// 运行：node scripts/test.mjs fix-e-modmirror
import "../gw/config.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { PREFIX } from "../gw/config.mjs";

const DK = path.join(PREFIX, "libexec/devkit");
const STAGE = path.join(path.dirname(PREFIX), "devkit-stage");
const OK = path.join(PREFIX, ".devkit-ok");
const ID = "mmod1";
const MODREL = `libexec/devkit/modules/${ID}`;
const TAR = spawnSync("sh", ["-c", "command -v tar"], { encoding: "utf8" }).stdout.trim();
const SH = spawnSync("sh", ["-c", "command -v sh"], { encoding: "utf8" }).stdout.trim();
const REAL_CURL = spawnSync("sh", ["-c", "command -v curl"], { encoding: "utf8" }).stdout.trim();
const SRC = fs.mkdtempSync(path.join(os.tmpdir(), "mmod1-"));
const LOG = path.join(SRC, "curl.log");

// 造一个真模块包
const HELLO = "hello module\n";
const H = crypto.createHash("sha256").update(HELLO).digest("hex");
fs.mkdirSync(path.join(SRC, "usr", MODREL), { recursive: true });
fs.writeFileSync(path.join(SRC, "usr", MODREL, "hello.txt"), HELLO);
fs.writeFileSync(path.join(SRC, "usr", MODREL, "MANIFEST"), `${H} ${Buffer.byteLength(HELLO)} ${MODREL}/hello.txt\n`);
const GZFILE = path.join(SRC, `${ID}.tar.gz`);
const tarred = TAR ? spawnSync(TAR, ["-czf", GZFILE, "-C", SRC, "usr"], { encoding: "utf8" }) : null;
const GZ = tarred && tarred.status === 0 ? fs.readFileSync(GZFILE) : null;
const SHA = GZ ? crypto.createHash("sha256").update(GZ).digest("hex") : "";
const SKIP = !TAR ? "环境里没有 tar" : !SH ? "环境里没有 sh" : !GZ ? "造不出测试包" : !REAL_CURL ? "环境里没有 curl" : false;

// 第一次请求 404，之后 200（逼下载循环换源重试）
let hits = 0;
const server = http.createServer((req, res) => {
  if (req.url === `/dl/${ID}.tar.gz`) {
    hits++;
    if (hits === 1) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { "content-type": "application/gzip", "content-length": GZ.length });
    return res.end(GZ);
  }
  res.writeHead(404); res.end();
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const B = `http://127.0.0.1:${server.address().port}/dl/`;

after(() => {
  server.close();
  fs.rmSync(path.join(DK, "modules.json"), { force: true });
  fs.rmSync(path.join(PREFIX, MODREL), { recursive: true, force: true });
  fs.rmSync(path.join(STAGE, ID), { recursive: true, force: true });
  fs.rmSync(path.join(STAGE, `${ID}-${SHA.slice(0, 12)}.tar.gz`), { force: true });
  fs.rmSync(SRC, { recursive: true, force: true });
  fs.rmSync(OK, { force: true });
});

test("E-06 模块下载不再请求已死的 dl.cccodroid.net 镜像", { skip: SKIP }, async () => {
  // curl 换成记日志的包装（记下每个参数，照原样 exec 真 curl）
  const curlLink = path.join(PREFIX, "bin", "curl");
  fs.rmSync(curlLink, { force: true });
  fs.writeFileSync(curlLink, `#!/bin/sh\nprintf '%s\\n' "$@" >> "${LOG}"\nexec "${REAL_CURL}" "$@"\n`, { mode: 0o755 });
  for (const [name, target] of [["tar", TAR], ["sh", SH]]) {
    const p = path.join(PREFIX, "bin", name);
    if (!fs.existsSync(p)) fs.symlinkSync(target, p);
  }
  fs.mkdirSync(DK, { recursive: true });
  fs.writeFileSync(OK, JSON.stringify({ sha256: "dk0600", base: B }));
  fs.writeFileSync(path.join(DK, "modules.json"), JSON.stringify({ snapshot: "s1", modules: [
    { id: "base", kind: "base", dir: "libexec/devkit/modules/base" },
    { id: ID, kind: "module", dir: MODREL, deps: ["base"], installed: 4096,
      gz: { file: `${ID}.tar.gz`, bytes: GZ.length, sha256: SHA } },
  ] }));

  const { modInstall, MOD_JOBS } = (await import("../gw/modules.mjs"))._modForTest;
  const r = await modInstall(ID);
  assert.equal(r.ok, true, JSON.stringify(r));
  const job = MOD_JOBS.get(ID);
  for (let i = 0; i < 400 && !(job && job.finished); i++) await new Promise((ok) => setTimeout(ok, 25));
  assert.ok(job && job.finished, "安装任务要跑完");
  assert.ok(!job.error, "安装不应失败：" + (job.error || ""));
  assert.ok(fs.existsSync(path.join(PREFIX, MODREL, ".ok")), "模块应装好（.ok 在）");
  assert.ok(hits >= 2, "本地服务应至少被请求两次（第一次 404 逼换源）");
  const logged = fs.existsSync(LOG) ? fs.readFileSync(LOG, "utf8") : "";
  // 注意：临时目录名本身就叫 hachimia-test-*，只查镜像域名，别误伤路径
  assert.ok(!logged.includes("dl.cccodroid.net"), "下载全程不应请求 cccodroid 镜像，实际请求：\n" + logged);
});
