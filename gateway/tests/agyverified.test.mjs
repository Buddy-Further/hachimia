// Antigravity CLI (agy) 真机验证记录（gw/agyverified.mjs）：验签、落盘给 Java 读、只往新的换、按语言给原因
// 用一把测试钥匙签名（CCAPP_TEST_PUBKEY 只在 CCAPP_TEST=1 时生效），本机起服务当发布地址
// 与 ccverified.test.mjs 同构：agy 通道和 Claude 通道是平行的，两份测试各自覆盖各自的文件与地址
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下，下面一行都不跑
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import crypto from "node:crypto";

const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
const other = crypto.generateKeyPairSync("ed25519").privateKey;
const S = { body: Buffer.alloc(0), sig: "" };
const publish = (d, key = privateKey) => { S.body = Buffer.from(JSON.stringify(d)); S.sig = crypto.sign(null, S.body, key).toString("base64"); };
const server = http.createServer((req, res) => {
  if (req.url === "/verified.json") return res.end(S.body);
  if (req.url === "/verified.json.sig") return res.end(S.sig);
  res.writeHead(404); res.end();
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
after(() => server.close());
process.env.CCAPP_TEST_PUBKEY = publicKey.export({ type: "spki", format: "pem" });
process.env.CCAPP_AGY_VERIFIED_URL = `http://127.0.0.1:${server.address().port}/verified.json`;
const { refreshAgyVerified, agyVerifiedInfo, AGY_VERIFIED_CACHE } = await import("../gw/agyverified.mjs");

const rec = { at: "2026-11-21", device: "Pixel 9", android: "15", sdk: 35, targetSdk: 36, app: "0.1.3", devkit: "devkit-2026.11.21.1", sha256: "cd" };
const doc = (updated, extra = {}) => ({ v: 1, updated, versions: { "1.5.13": [rec] }, bad: { "1.5.14": { zh: "启动就闪退", en: "Crashes on launch", fixed: "1.5.15" } }, ...extra });

test("签名对：取到、存盘（Java 的自动更新读这份），选单拿到验证记录和按语言的原因", async () => {
  publish(doc("2026-11-21T01:00:00Z"));
  await refreshAgyVerified(true);
  const zh = await agyVerifiedInfo("zh"), en = await agyVerifiedInfo("en");
  assert.equal(zh.verified["1.5.13"][0].device, "Pixel 9");
  assert.equal(zh.verified["1.5.13"][0].android, "15");
  assert.equal(zh.verified["1.5.13"][0].sha256, undefined, "选单只要显示用的字段");
  assert.deepEqual(zh.bad["1.5.14"], { text: "启动就闪退", fixed: "1.5.15" });
  assert.equal(en.bad["1.5.14"].text, "Crashes on launch");
  assert.equal(JSON.parse(fs.readFileSync(AGY_VERIFIED_CACHE, "utf8")).bad["1.5.14"].zh, "启动就闪退");
  assert.equal(zh.verifiedError, "");
});

test("签名不对（别的钥匙签的）：不认，手上的和磁盘上的都不动", async () => {
  publish(doc("2026-11-22T00:00:00Z", { bad: { "1.5.13": { zh: "假的", en: "fake" } } }), other);
  await refreshAgyVerified(true);
  const r = await agyVerifiedInfo("zh");
  assert.equal(r.bad["1.5.13"], undefined);
  assert.match(r.verifiedError, /签名对不上/);
  assert.equal(JSON.parse(fs.readFileSync(AGY_VERIFIED_CACHE, "utf8")).updated, "2026-11-21T01:00:00Z");
});

test("取到的比手上的旧：不往回换", async () => {
  publish(doc("2026-11-20T00:00:00Z", { bad: {} }));
  await refreshAgyVerified(true);
  assert.ok((await agyVerifiedInfo("zh")).bad["1.5.14"]);
});

test("新的一份：换上，撤掉的「有问题」随之消失", async () => {
  publish(doc("2026-11-23T00:00:00Z", { bad: {} }));
  await refreshAgyVerified(true);
  const r = await agyVerifiedInfo("zh");
  assert.deepEqual(r.bad, {});
  assert.ok(r.verified["1.5.13"]);
});

test("格式不对：不认", async () => {
  publish({ v: 1, updated: "2026-11-24T00:00:00Z" });
  await refreshAgyVerified(true);
  assert.match((await agyVerifiedInfo("zh")).verifiedError, /格式不对/);
  assert.ok((await agyVerifiedInfo("zh")).verified["1.5.13"]);
});

test("磁盘上那份被人改过（同 uid 能写）：重启后不认，验过签的原样那份照认（审查 11-05 安全 1）", async () => {
  publish(doc("2026-11-23T00:00:00Z"), other);          // 发布地址取不到可信的：只能靠磁盘
  const good = fs.readFileSync(AGY_VERIFIED_CACHE);
  assert.ok(fs.existsSync(AGY_VERIFIED_CACHE + ".sig"), "签名跟着存");
  const fresh = await import("../gw/agyverified.mjs?reload=1");
  assert.ok((await fresh.agyVerifiedInfo("zh")).verified["1.5.13"], "原样的那份：认");
  const forged = JSON.parse(good.toString("utf8")); forged.updated = "2099-01-01T00:00:00Z"; forged.bad = { "1.5.13": { zh: "假的", en: "fake" } };
  fs.writeFileSync(AGY_VERIFIED_CACHE, JSON.stringify(forged));
  const again = await import("../gw/agyverified.mjs?reload=2");
  const r = await again.agyVerifiedInfo("zh");
  assert.equal(r.bad["1.5.13"], undefined);
  assert.deepEqual(r.verified, {});
  fs.writeFileSync(AGY_VERIFIED_CACHE, good);
});
