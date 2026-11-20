// A7 另一半：只设 CCAPP_CLAUDE 时 PATHS.agy 不得用它兜底。
// 与 fix-a-agyonly.test.mjs 分文件：PATHS 在 import 时快照，同一进程只能测一种环境布局。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const fakeClaude = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fix-a7b-")), "claude");
fs.writeFileSync(fakeClaude, "#!/bin/sh\n", { mode: 0o755 });
delete process.env.CCAPP_AGY;
process.env.CCAPP_CLAUDE = fakeClaude;

test("A7（config）：只设 CCAPP_CLAUDE 时 PATHS.agy 不得指向它", async () => {
  const { PATHS } = await import("../gw/config.mjs");
  assert.notEqual(PATHS.agy, fakeClaude, "CCAPP_CLAUDE 不能兜底成 agy 路径");
  assert.equal(PATHS.claude, fakeClaude);
});
