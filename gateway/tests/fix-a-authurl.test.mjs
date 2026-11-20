// A8：pickAuthUrl 抓错授权地址——授权 URL 不含 accounts.google.com/oauth 时，
// 不能把输出里的第一个 https 链接（文档/官网页）当授权地址返回。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { CFG, PATHS } from "../gw/config.mjs";
import { NEXT } from "../gw/http.mjs";
import { routeLogin } from "../gw/login.mjs";

async function serve(...routes) {
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    for (const r of routes) if ((await r(req, res, u, u.pathname)) !== NEXT) return;
    res.writeHead(404).end();
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  after(() => srv.close());
  const call = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}${p}`, {
      method, ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, body: await r.json() };
  };
  call.url = `http://127.0.0.1:${srv.address().port}`;
  return call;
}

function makeFakeAgy(dir, body) {
  const script = path.join(dir, "fake-agy-authurl");
  fs.writeFileSync(script, `#!/bin/sh
${body}
`, { mode: 0o755 });
  return script;
}

test("A8：先印文档链接、再印 antigravity.google 授权地址时，应返回授权地址而非文档页", async () => {
  const tmp = fs.mkdtempSync(path.join(CFG.home, "fix-a-authurl-"));
  const fake = makeFakeAgy(tmp, `printf 'Learn more: https://antigravity.google/docs\\nVisit https://antigravity.google/auth/start?x=1\\n'
sleep 30`);
  const prevAgy = PATHS.agy;
  PATHS.agy = fake;
  const go = await serve(routeLogin);
  try {
    const s = await go("POST", "/api/login/start", { method: "personal" });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.equal(s.body.ok, true, JSON.stringify(s.body));
    assert.equal(s.body.url, "https://antigravity.google/auth/start?x=1", JSON.stringify(s.body));
  } finally {
    PATHS.agy = prevAgy;
    await go("POST", "/api/login/cancel", {}).catch(() => {});
  }
});

test("A8：输出里只有文档链接、没有授权地址时，不能把文档链接当授权地址返回", async () => {
  const tmp = fs.mkdtempSync(path.join(CFG.home, "fix-a-authurl-2-"));
  const fake = makeFakeAgy(tmp, `printf 'Learn more: https://antigravity.google/docs\\n'
exit 0`);
  const prevAgy = PATHS.agy;
  PATHS.agy = fake;
  const go = await serve(routeLogin);
  try {
    const s = await go("POST", "/api/login/start", { method: "personal" });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.notEqual(s.body.url, "https://antigravity.google/docs", JSON.stringify(s.body));
  } finally {
    PATHS.agy = prevAgy;
    await go("POST", "/api/login/cancel", {}).catch(() => {});
  }
});
