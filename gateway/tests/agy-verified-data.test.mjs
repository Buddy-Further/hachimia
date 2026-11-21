// P0-6：agy 真机验证通道的数据文件与维护脚本（scripts/agy-verified.mjs）。
// agy-code/verified.json 初始为空（和 claude-code/verified.json 一样），.sig 由维护者在签名机上
// 跑 agy-verified.mjs publish 生成——本机没有签名钥匙，所以这里不断言 .sig 存在，只断言结构。
// CLI 的改动命令最终都要签名发布；测试里把 INDEX_SIGNING_KEY_FILE 指到不存在的路径，
// 让它们在签名前就停下，绝不写仓库文件。
// 运行：node scripts/test.mjs agy-verified-data
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const SCRIPT = path.join(ROOT, "scripts", "agy-verified.mjs");
const FILE = path.join(ROOT, "agy-code", "verified.json");
const run = (args, extraEnv = {}) => spawnSync(process.execPath, [SCRIPT, ...args],
  { cwd: ROOT, encoding: "utf8", env: { ...process.env, INDEX_SIGNING_KEY_FILE: path.join(os.tmpdir(), "no-such-key.pem"), ...extraEnv } });

test("P0-6 agy-code/verified.json：空的初始结构，和 Claude 那份同形", () => {
  const d = JSON.parse(fs.readFileSync(FILE, "utf8"));
  assert.equal(d.v, 1);
  assert.ok(d.versions && typeof d.versions === "object", "versions 应是对象");
  assert.ok(d.bad && typeof d.bad === "object", "bad 应是对象");
  assert.deepEqual(d.versions, {}, "初始没有任何验证记录");
  assert.deepEqual(d.bad, {}, "初始没有任何坏版本");
  assert.ok(!Number.isNaN(Date.parse(d.updated || "")), "updated 应是合法日期");
  for (const v of [...Object.keys(d.versions), ...Object.keys(d.bad)])
    assert.match(v, /^\d+\.\d+\.\d+/, `版本号 ${v} 应是 x.y.z 形式`);
});

test("P0-6 agy-verified.mjs list：空记录能列", () => {
  const r = run(["list"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /还没有验证记录/);
});

test("P0-6 agy-verified.mjs add：没通过验证的结果不能记（签名之前就拦住）", () => {
  const before = fs.readFileSync(FILE, "utf8");
  const f = path.join(os.tmpdir(), "agy-verify-fail.json");
  fs.writeFileSync(f, JSON.stringify({ v: 1, version: "1.5.13", pass: false,
    steps: { version: { pass: true }, acp: { pass: false, detail: "initialize 没回" } } }));
  const r = run(["add", f]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /没通过验证/);
  assert.equal(fs.readFileSync(FILE, "utf8"), before, "拦住的 add 不能改仓库文件");
});

test("P0-6 agy-verified.mjs add：不是在 hachimia 终端里跑的结果不能当真机验证", () => {
  const before = fs.readFileSync(FILE, "utf8");
  const f = path.join(os.tmpdir(), "agy-verify-nodvc.json");
  fs.writeFileSync(f, JSON.stringify({ v: 1, version: "1.5.13", pass: true, sha256: "c".repeat(64),
    at: new Date().toISOString(), device: { maker: "", model: "", android: "", sdk: 0, targetSdk: 0 }, app: "", devkit: "",
    steps: { version: { pass: true }, acp: { pass: true } } }));
  const r = run(["add", f]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /不是在 hachimia 的终端里跑的/);
  assert.equal(fs.readFileSync(FILE, "utf8"), before, "拦住的 add 不能改仓库文件");
});

test("P0-6 agy-verified.mjs add：通过校验的结果走到签名那一步才停（本机没有签名钥匙），文件不动", () => {
  const before = fs.readFileSync(FILE, "utf8");
  const f = path.join(os.tmpdir(), "agy-verify-good.json");
  fs.writeFileSync(f, JSON.stringify({ v: 1, version: "1.5.13", pass: true, sha256: "c".repeat(64), sha512: "ab".repeat(64),
    at: new Date().toISOString(), device: { maker: "Test", model: "VM", android: "15", sdk: 35, targetSdk: 28 },
    app: "0.1.3", devkit: "devkit-2026.11.21.1", steps: { version: { pass: true }, acp: { pass: true } } }));
  const r = run(["add", f]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /no-such-key\.pem/, "应停在读签名钥匙上，而不是校验上");
  assert.equal(fs.readFileSync(FILE, "utf8"), before, "没签出来就不能写仓库文件");
});

test("P0-6 agy-verified.mjs bad：--zh/--en 缺一个就拦住", () => {
  const r = run(["bad", "1.5.13", "--zh", "启动就闪退"]);
  assert.notEqual(r.status, 0);
  assert.match(r.stderr, /--zh 和 --en 都要写/);
});
