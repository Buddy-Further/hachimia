// E-05：modRemove 对没有 FILES 的已装模块谎报卸载成功，实际什么都没删。
// 失败测试：模块目录含 .ok + MANIFEST、故意不写 FILES，卸载后目录与 .ok 都应消失，removed 应如实包含该模块。
// 运行：node scripts/test.mjs fix-e-modremove
import "../gw/config.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { PREFIX } from "../gw/config.mjs";
import { _modForTest } from "../gw/modules.mjs";

const DK = path.join(PREFIX, "libexec/devkit");
const MODDIR = path.join(PREFIX, "libexec/devkit/modules/tmod1");

test("E-05 modRemove：没有 FILES 的已装模块，卸载要真删目录与 .ok", () => {
  fs.mkdirSync(MODDIR, { recursive: true });
  fs.writeFileSync(path.join(DK, "modules.json"), JSON.stringify({ snapshot: "s1", modules: [
    { id: "base", kind: "base", dir: "libexec/devkit/modules/base" },
    { id: "tmod1", kind: "module", dir: "libexec/devkit/modules/tmod1", deps: ["base"] },
  ] }));
  fs.writeFileSync(path.join(MODDIR, ".ok"), '{"at":1}\n');
  fs.writeFileSync(path.join(MODDIR, "MANIFEST"), "00 1 libexec/devkit/modules/tmod1/.ok\n");
  // 注意：故意不写 FILES（模拟 FILES 丢失/损坏的已装模块）
  const r = _modForTest.modRemove("tmod1");
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.removed, ["tmod1"]);
  assert.equal(fs.existsSync(MODDIR), false, "模块目录应已删掉");
  assert.equal(fs.existsSync(path.join(MODDIR, ".ok")), false, ".ok 应已删掉，模块不应再显示已装");
});
