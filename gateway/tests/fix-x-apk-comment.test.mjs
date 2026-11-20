// apk.yml 注释过时（E02 跟进）：D 片已把 README 指纹改成实测 D3:41…，
// apk.yml 约 100 行注释仍说“README 里还写着旧的 cccodroid 指纹（B7:03…）”。
// EXPECT=d341… 本身是对的，不要动；只改注释与现状一致。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const yml = fs.readFileSync(path.join(ROOT, ".github", "workflows", "apk.yml"), "utf8");
const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");

test("apk.yml：注释不得再说 README 是旧指纹，EXPECT 保持实测值", () => {
  assert.ok(!yml.includes("B7:03"), "注释里不得再提旧的 B7:03 指纹");
  assert.ok(yml.includes("EXPECT=d341c391a825bbb730397f009f7b8254b97a00db57cae254fa14aa3a2ff45a48"),
    "EXPECT 本身是对的，不得改动");
  // README 指纹与 EXPECT 是同一张证书：去掉冒号比对
  const readmeFp = (readme.match(/D3:41(?::[0-9A-F]{2})+/i) || [""])[0].replace(/:/g, "").toLowerCase();
  assert.equal(readmeFp, "d341c391a825bbb730397f009f7b8254b97a00db57cae254fa14aa3a2ff45a48",
    "README 指纹应与 EXPECT 一致");
});
