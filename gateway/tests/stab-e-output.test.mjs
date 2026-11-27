// e 组 FIND-045：工具结果截断无标记、终端 cwd 静默回落、信号统一报 128、回放环溢出无提示。
import { CFG } from "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fs.mkdtempSync(path.join(process.env.CCAPP_WORKSPACE, "stab-e-out-"));
const { translate } = await import("../gw/stream.mjs");
const { resolveTermCwd, _termForTest } = await import("../gw/terminal.mjs");
after(() => { fs.rmSync(root, { recursive: true, force: true }); });

test("FIND-045：工具结果超过 20000 字符时带截断标记", () => {
  const out = [];
  const bigTxt = "b".repeat(20001);
  translate({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu-1", content: bigTxt }] } }, { sse: (e) => out.push(e) });
  assert.equal(out.length, 1);
  assert.equal(out[0].type, "tool_result");
  assert.equal(out[0].text.includes(bigTxt), false);
  assert.equal(out[0].text.endsWith("…（已截断）"), true, "截断没有标记：" + out[0].text.slice(-40));
  const small = [];
  translate({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu-2", content: "short" }] } }, { sse: (e) => small.push(e) });
  assert.equal(small[0].text, "short", "没超长的不该加标记");
});

test("FIND-045：终端带来的目录不存在时回落到工作区，并给出提示用的原目录", () => {
  const missing = path.join(root, "no-such-dir");
  const r = resolveTermCwd(missing);
  assert.equal(r.cwd, CFG.workspace);
  assert.equal(r.note, missing);
  const ok = resolveTermCwd(root);
  assert.equal(ok.cwd, root);
  assert.equal(ok.note, "");
  const none = resolveTermCwd(undefined);
  assert.equal(none.cwd, CFG.workspace);
  assert.equal(none.note, "");
});

test("FIND-045：终端被信号结束时按 128+信号号报", () => {
  assert.equal(_termForTest.exitCodeOf(null, "SIGKILL"), 128 + (os.constants.signals.SIGKILL || 0));
  assert.equal(_termForTest.exitCodeOf(null, "SIGTERM"), 143);
  assert.equal(_termForTest.exitCodeOf(7, null), 7);
  assert.equal(_termForTest.exitCodeOf(null, null), null);
});

test("FIND-045：回放环溢出时前端留一句已截断", () => {
  const APP = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "web", "app");
  const src = fs.readFileSync(path.join(APP, "18-terminal.js"), "utf8");
  assert.match(src, /const lost = typeof total === "number"/);
  assert.match(src, /xt\.write\("\\x18\\x1bc" \+ \(lost \? "\\x1b\[2m" \+ t\("…（已截断）"\)/, "回放环溢出提示已截断");
  assert.match(src, /t\("…（已截断）"\)/);
});
