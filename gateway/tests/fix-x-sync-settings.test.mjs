// 跨片遗留 A14：syncAgySettings 无锁非原子读-改-写，且 settings.json 解析失败时重置成 {} 丢配置。
// 修：原子写（写临时文件再 rename）+ 解析失败时保留原文件不动并报错，不得静默重置。
// 密钥全是 fixture。
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CFG } from "../gw/config.mjs";
import { providerById } from "../gw/providers.mjs";
import { syncAgySettings } from "../gw/claude.mjs";

const DIR = path.join(CFG.home, ".gemini", "antigravity-cli");
const FILE = path.join(DIR, "settings.json");
const FAKE_KEY = "fix-x-fake-key-not-real";

function snapshot() {
  try { return fs.readFileSync(FILE, "utf8"); } catch { return null; }
}
function restore(prev) {
  if (prev === null) { try { fs.rmSync(FILE, { force: true }); } catch {} }
  else { fs.mkdirSync(DIR, { recursive: true }); fs.writeFileSync(FILE, prev, "utf8"); }
}

test("A14：settings.json 解析失败时保留原文件不动并报错，不得重置成 {}", () => {
  const prev = snapshot();
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(FILE, '{"modelProvider":"gemini","myCustom":123, broken', "utf8");
    const before = fs.readFileSync(FILE, "utf8");
    const r = syncAgySettings(providerById("gemini-key"), FAKE_KEY);
    assert.equal(fs.readFileSync(FILE, "utf8"), before, "损坏的 settings.json 必须原样保留");
    assert.ok(r && r.error, "应返回 error 说明解析失败：" + JSON.stringify(r));
  } finally { restore(prev); }
});

test("A14：settings.json 不是 JSON 对象时同样保留原文件并报错", () => {
  const prev = snapshot();
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(FILE, "[1, 2, 3]\n", "utf8");
    const before = fs.readFileSync(FILE, "utf8");
    const r = syncAgySettings(providerById("gemini-key"), FAKE_KEY);
    assert.equal(fs.readFileSync(FILE, "utf8"), before, "非对象 JSON 不得被重置");
    assert.ok(r && r.error, "应返回 error：" + JSON.stringify(r));
  } finally { restore(prev); }
});

test("A14：合法文件正常改写后仍是完整 JSON、无残留临时文件", () => {
  const prev = snapshot();
  try {
    fs.mkdirSync(DIR, { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify({ modelProvider: "gemini", keepMe: 1 }, null, 2) + "\n", "utf8");
    // 切到订阅登录：应删掉 modelProvider，保留其他字段
    const r = syncAgySettings(providerById("antigravity"), null);
    assert.equal(r.error, undefined, "合法改写不应报错：" + JSON.stringify(r));
    const after = JSON.parse(fs.readFileSync(FILE, "utf8"));
    assert.equal("modelProvider" in after, false);
    assert.equal(after.keepMe, 1, "无关配置必须保留");
    const leftovers = fs.readdirSync(DIR).filter((f) => f.endsWith(".tmp"));
    assert.deepEqual(leftovers, [], "原子写不得留下临时文件");
  } finally { restore(prev); }
});
