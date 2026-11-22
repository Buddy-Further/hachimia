import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const appDir = path.join(root, "gateway/web/app");
const files = fs.readdirSync(appDir).filter((f) => f.endsWith(".js")).sort();
const allSrc = files.map((f) => fs.readFileSync(path.join(appDir, f), "utf8")).join("\n");

test("app.js 跨分段依赖符号均已声明（防止移植遗漏导致 ReferenceError）", () => {
  const requiredDecls = [
    ["viewRead", /\bfunction\s+viewRead\s*\(/],
    ["sameGet", /\bconst\s+sameGet\s*=/],
    ["pageVisit", /\blet\s+pageVisit\b/],
    ["pageVisible", /\bfunction\s+pageVisible\s*\(/],
    ["pausePageReads", /\bfunction\s+pausePageReads\s*\(/],
    ["resumePageReads", /\bfunction\s+resumePageReads\s*\(/],
    ["setVisit", /\blet\s+setVisit\b/],
    ["setVisible", /\bfunction\s+setVisible\s*\(/],
    ["pauseSetReads", /\bfunction\s+pauseSetReads\s*\(/],
    ["enterSetCat", /\bfunction\s+enterSetCat\s*\(/],
    ["setBaseRead", /\bsetBaseRead\b\s*=/],
    ["refreshSettings", /\basync\s+function\s+refreshSettings\s*\(/],
    ["privLater", /\bfunction\s+privLater\s*\(/],
    ["updRev", /\bupdRev\s*=\s*0\b/],
    ["orphanVisit", /\borphanVisit\s*=\s*-1\b/],
    ["readUpdateStatus", /\bfunction\s+readUpdateStatus\s*\(/],
    ["updLater", /\bfunction\s+updLater\s*\(/],
    ["devPoll", /\bdevPoll\s*=\s*0\b/],
    ["fixTimer", /\blet\s+fixTimer\b/],
    ["envFactsTimer", /\blet\s+envFactsTimer\b/],
    ["clearWiTimers", /\bfunction\s+clearWiTimers\s*\(/],
    ["stopLoginWatch", /\bfunction\s+stopLoginWatch\s*\(/],
    ["pauseExtReads", /\bfunction\s+pauseExtReads\s*\(/],
    ["ensureLinMap", /\basync\s+function\s+ensureLinMap\s*\(/],
    ["linPause", /\bfunction\s+linPause\s*\(/],
  ];
  for (const [name, re] of requiredDecls) {
    assert.match(allSrc, re, `app.js 缺少 ${name} 的声明`);
  }

  const s10 = fs.readFileSync(path.join(appDir, "10-settings-device.js"), "utf8");
  const loadPrivStart = s10.indexOf("async function loadPriv()");
  assert.ok(loadPrivStart >= 0, "应存在 loadPriv");
  const loadPrivHead = s10.slice(loadPrivStart, loadPrivStart + 260);
  assert.match(loadPrivHead, /const\s+visit\s*=\s*setVisit,\s*cat\s*=\s*setCatOpen;/,
    "loadPriv 必须在函数开头声明 visit 与 cat，防止 cat is not defined");
});

test("app.js loadPriv 与 loadUpd 在未进入对应分类时安全返回、不抛 ReferenceError", async () => {
  const s10 = fs.readFileSync(path.join(appDir, "10-settings-device.js"), "utf8");
  const privIdx = s10.indexOf("let privBusy = false;");
  const privEnd = s10.indexOf("// 经 priv 执行过的命令", privIdx);
  const privSlice = s10.slice(privIdx, privEnd);
  const box = {
    setVisit: 1,
    setCatOpen: "general",
    privPoll: null,
    setVisible: (c, v) => c === "device" && v === 1,
    api: async () => { throw new Error("should not call api when category hidden"); },
    clearTimeout,
    setTimeout,
  };
  vm.runInNewContext(`${privSlice}\nthis.loadPriv = loadPriv; this.privLater = privLater;`, box);
  await assert.doesNotReject(() => box.loadPriv());
});
