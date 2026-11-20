// 跨片核查 reconcile：纯 agy 模式下 PATHS.claude 指向的文件不存在，
// reconcileNow 不得再报“找不到 Claude Code 程序”error（应按 isAgyOnlyMode() 跳过）。
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CFG, PATHS } from "../gw/config.mjs";
import { isAgyOnlyMode } from "../gw/providers.mjs";
import { reconcileNow } from "../gw/reconcile.mjs";

test("reconcile（纯 agy）：agy 在、claude 不在时不得报 claude 缺失", async () => {
  // 假 agy 放在 PATHS.agy 指的位置；PATHS.claude 指的文件在测试环境里不存在（与设备纯 agy 布局一致）
  fs.mkdirSync(path.dirname(PATHS.agy), { recursive: true });
  fs.writeFileSync(PATHS.agy, "#!/bin/sh\n", { mode: 0o755 });
  try {
    assert.equal(fs.existsSync(PATHS.claude), false, "前置：claude 二进制不存在");
    assert.equal(isAgyOnlyMode(), true, "前置：应处于纯 agy 模式");
    const r = await reconcileNow();
    assert.ok(!r.findings.some((f) => f.key === "claude"),
      "纯 agy 模式下不得报 claude 缺失：" + JSON.stringify(r.findings.filter((f) => f.key === "claude")));
  } finally {
    try { fs.rmSync(PATHS.agy, { force: true }); } catch {}
  }
});
