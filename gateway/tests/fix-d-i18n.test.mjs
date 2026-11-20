// D-05：Web i18n 扫描必须过（默认 en 扫描 exit 0；--all 各语言零缺译）。
// 扫描本身是验收标准，这里把它包成测试：红 → 补完词典后变绿。
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

test("D-05 node i18n/scan.mjs（en）exit 0：无未接入中文、无缺译键", () => {
  const r = spawnSync(process.execPath, ["i18n/scan.mjs"], { cwd: ROOT, encoding: "utf8", timeout: 120000 });
  assert.equal(r.status, 0, "scan.mjs 应 exit 0，实际 " + r.status + "，输出：\n" + (r.stdout || "") + (r.stderr || ""));
});

test("D-05 node i18n/scan.mjs --all：九语全部译完（en 缺 0、其余各语缺 0）", () => {
  const r = spawnSync(process.execPath, ["i18n/scan.mjs", "--all"], { cwd: ROOT, encoding: "utf8", timeout: 120000 });
  assert.equal(r.status, 0, "scan --all 应 exit 0，实际 " + r.status);
  const lines = String(r.stdout || "").split("\n").filter((l) => /已译/.test(l));
  assert.ok(lines.length >= 9, "应有 9 行语言统计，实际：\n" + r.stdout);
  for (const l of lines) {
    const m = /已译 (\d+)\/(\d+)/.exec(l);
    assert.ok(m, "解析不到已译数：" + l);
    assert.equal(m[1], m[2], "仍有缺译：" + l.trim());
  }
});
