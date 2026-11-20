// A7：isAgyOnlyMode() 在设备上恒为 false。
// 根因有两半：① config.mjs 里 PATHS.claude 用 CCAPP_AGY 兜底（只设 CCAPP_AGY 也会让
// “claude 存在”）；② Env.java 把 CCAPP_AGY 与 CCAPP_CLAUDE 设成同一路径。
// 本文件只在“只设 CCAPP_AGY、不设 CCAPP_CLAUDE”的设备布局下测 config 这一半，
// 必须在 import config 之前先把环境变量摆好（PATHS 在 import 时快照）。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";

const fakeAgy = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "fix-a7-")), "agy");
fs.writeFileSync(fakeAgy, "#!/bin/sh\n", { mode: 0o755 });
process.env.CCAPP_AGY = fakeAgy;
delete process.env.CCAPP_CLAUDE;

test("A7（config）：只设 CCAPP_AGY 时 PATHS.claude 不得指向 agy，isAgyOnlyMode() 应为 true", async () => {
  const { PATHS } = await import("../gw/config.mjs");
  assert.notEqual(PATHS.claude, fakeAgy, "CCAPP_AGY 不能兜底成 claude 路径");
  assert.equal(PATHS.agy, fakeAgy);
  assert.equal(fs.existsSync(PATHS.agy), true);
  assert.equal(fs.existsSync(PATHS.claude), false, "设备上没有独立的 claude 二进制");
  const { isAgyOnlyMode } = await import("../gw/providers.mjs");
  assert.equal(isAgyOnlyMode(), true);
});

test("A7（Env.java）：设备端不得把 agy 路径同时写进 CCAPP_CLAUDE", () => {
  const envJava = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "android", "java", "ha", "chi", "mia", "Env.java"), "utf8");
  assert.ok(!/e\.put\("CCAPP_CLAUDE",\s*claude\(\)\.getPath\(\)\)/.test(envJava),
    "Env.java 不应再有 e.put(\"CCAPP_CLAUDE\", claude().getPath())");
  assert.match(envJava, /CCAPP_AGY/);
});
