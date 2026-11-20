// D-06/E-07 数据侧：claude-code/verified.json 不应再只有 Claude Code 2.1.308 一条旧记录——
// 那个版本号空间与 agy（1.x）无交集，「已验证」标记与 knownBad 拦截永远落空。
// 机制侧（Updater.checkClaude 接 knownBad）由 Java 代码保证，这里只看数据文件本身：
// 结构完整、无 stale 的 Claude Code 版本号。真机验证记录由维护者后续按 agy 版本补。
// 运行：node scripts/test.mjs fix-e-verified
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("D-06 verified.json：无 stale Claude Code 记录，结构可供 agy 版本查表", () => {
  const f = new URL("../../claude-code/verified.json", import.meta.url);
  const d = JSON.parse(fs.readFileSync(f, "utf8"));
  assert.equal(d.v, 1);
  assert.ok(d.versions && typeof d.versions === "object", "versions 应是对象");
  assert.ok(d.bad && typeof d.bad === "object", "bad 应是对象");
  assert.ok(!("2.1.308" in d.versions), "不应再留 Claude Code 2.1.308 的旧验证记录");
  for (const v of [...Object.keys(d.versions), ...Object.keys(d.bad)])
    assert.match(v, /^\d+\.\d+\.\d+/, `版本号 ${v} 应是 x.y.z 形式`);
  assert.ok(!Number.isNaN(Date.parse(d.updated || "")), "updated 应是合法日期");
  assert.ok(fs.existsSync(new URL("../../claude-code/verified.json.sig", import.meta.url)),
    "verified.json.sig 应在（改动数据文件后需维护者重签，见修复报告）");
});
