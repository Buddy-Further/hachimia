// D-01：到 GitHub 反馈必须发到本仓库 Buddy-Further/hachimia，不能发到 greyoak111/cccodroid
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs 就在这里拦下
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { NEXT } from "../gw/http.mjs";
import { routeFeedback } from "../gw/feedback.mjs";

async function serve(route) {
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    if ((await route(req, res, u, u.pathname)) !== NEXT) return;
    res.writeHead(404).end();
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  return {
    srv,
    call: async (p) => {
      const r = await fetch(`http://127.0.0.1:${srv.address().port}${p}`);
      return { status: r.status, body: await r.json() };
    },
  };
}

test("D-01 issue-draft URL 指向本仓库 Buddy-Further/hachimia", async (t) => {
  const { srv, call } = await serve(routeFeedback);
  t.after(() => srv.close());
  const r = await call("/api/issue-draft");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.ok(String(r.body.url).startsWith("https://github.com/Buddy-Further/hachimia/issues/new?"),
    "实际 URL: " + r.body.url);
  assert.doesNotMatch(String(r.body.url), /greyoak111\/cccodroid/);
});

test("D-01 issue 正文用 hachimia / Antigravity CLI，不写 cccodroid / Claude Code", async (t) => {
  const { srv, call } = await serve(routeFeedback);
  t.after(() => srv.close());
  const r = await call("/api/issue-draft");
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.doesNotMatch(String(r.body.body), /cccodroid/);
  assert.doesNotMatch(String(r.body.body), /Claude Code/);
  assert.match(String(r.body.body), /hachimia/);
  assert.match(String(r.body.body), /Filled in by hachimia/);
  // agy 那行只在装了 agy 才有值（row() 会省掉空行）：行标签本身在源码里断言
  const src = fs.readFileSync(new URL("../gw/feedback.mjs", import.meta.url), "utf8");
  assert.match(src, /row\("Antigravity CLI \(agy\)", ver\("agy"\) \|\| ver\("claude"\)\)/);
});
