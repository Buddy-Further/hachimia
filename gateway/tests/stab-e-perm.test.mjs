// e 组 FIND-043：权限卡超时在界面按 expired 显示「超时」，不冒充用户拒绝。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("FIND-043：界面按 expired 显示「超时」，run.mjs 权限超时标记 expired: true", () => {
  const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "app");
  const permSrc = fs.readFileSync(path.join(APP, "03-perm-status.js"), "utf8");
  assert.match(permSrc, /o\.expired \? t\("超时"\)/, "界面没有区分超时");
  const runSrc = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "gw", "run.mjs"), "utf8");
  assert.match(runSrc, /expired: true/);
});
