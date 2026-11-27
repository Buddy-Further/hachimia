// hookContext 与项目配置风险检测回归（已移除破甲文本检查，保留项目 hooks / MCP / agents 风险识别）
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { hookContext } from "../gw/stream.mjs";

test("hookContext 正常提取 additionalContext 与 SessionStart stdout", () => {
  const ev1 = { stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: "记得提交前跑 npm test。" } }), hook_event: "SessionStart", exit_code: 0 };
  assert.equal(hookContext(ev1), "记得提交前跑 npm test。");
  const ev2 = { stdout: "项目环境就绪\n", hook_event: "SessionStart", exit_code: 0 };
  assert.equal(hookContext(ev2), "项目环境就绪");
  assert.equal(hookContext({ stdout: "err", hook_event: "PreToolUse", exit_code: 2 }), "");
  assert.equal(hookContext({ stdout: "  ", hook_event: "SessionStart" }), "");
});

test("项目配置风险检测：hooks / .mcp.json / frontmatter hooks 正常上报，无害键不报", async () => {
  const { projectRisks } = await import("../gw/projtrust.mjs");
  const { CFG } = await import("../gw/config.mjs");
  const root = fs.mkdtempSync(path.join(CFG.home, "rt-")), proj = path.join(root, "p");
  fs.mkdirSync(path.join(proj, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(proj, ".claude", "settings.json"), JSON.stringify({ hooks: { SessionStart: [{ command: "echo 准备就绪" }] } }));
  let r = projectRisks(proj);
  assert.ok(r && r.risks.some((x) => /hooks$/.test(x)), JSON.stringify(r));
  // 只有无害键：不问
  fs.writeFileSync(path.join(proj, ".claude", "settings.json"), JSON.stringify({ model: "x" }));
  assert.equal(projectRisks(proj), null);
  // .mcp.json
  fs.writeFileSync(path.join(proj, ".mcp.json"), JSON.stringify({ mcpServers: { demo: { command: "sh" } } }));
  r = projectRisks(proj);
  assert.ok(r && r.risks.some((x) => x.includes("demo")), JSON.stringify(r));
  fs.unlinkSync(path.join(proj, ".mcp.json"));
  // 带 hooks frontmatter 的子代理
  fs.mkdirSync(path.join(proj, ".claude", "agents"), { recursive: true });
  fs.writeFileSync(path.join(proj, ".claude", "agents", "r.md"), "---\nname: r\nhooks:\n  Stop: []\n---\nbody");
  r = projectRisks(proj);
  assert.ok(r && r.risks.some((x) => x.includes("agents/r.md")), JSON.stringify(r));
});
