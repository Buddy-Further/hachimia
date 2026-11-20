// rem/review-fixes：审查新漏报（rem-review-report.md 条件 3）——Share.java 诊断包残留。
// 诊断包文件名用户在系统分享面板/文件管理里可见，包内 diagnostics.txt 首行用户发给维护者时可见。
// 只断言诊断包相关 4 行；~/.cccodroid-env.json（:270/:272）是真实磁盘路径，不在本次范围。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");

test("rem/review-fixes Share.java 诊断包文件名与包内首行写 hachimia，旧前缀清干净", () => {
  const s = read("android/java/ha/chi/mia/Share.java");
  // 诊断包文件名（用户在分享面板/文件管理里可见）
  assert.match(s, /"hachimia-logs-" \+ stamp \+ "\.zip"/);
  assert.doesNotMatch(s, /cccodroid-logs/);
  // 旧包清理前缀须同步改，否则旧包清不掉
  assert.match(s, /startsWith\("hachimia-logs-"\)/);
  // 注释同行改名
  assert.match(s, /files\/cache\/share\/hachimia-logs-\*\.zip/);
  // diagnostics.txt 首行（用户把诊断包发给维护者时第一行就是它）
  assert.match(s, /sb\.append\("hachimia "\)\.append\(c\.getPackageManager\(\)/);
  assert.doesNotMatch(s, /sb\.append\("cccodroid "\)/);
});
