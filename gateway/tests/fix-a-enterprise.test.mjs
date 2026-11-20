// A12：企业登录与个人登录是同一套调用。
// 官方文档核实：`agy acp --login` 只有一个布尔 --login，没有选企业/个人的 flag 或环境
// 变量（企业选择在 ACP authenticate 的 methodId oauth-business 里，run.mjs 已按厂商传）。
// login.mjs 层面能修的是：① 记住并上报真实登录方式，不再一律报 oauth-personal；
// ② start 响应带回 method，企业分支给一句浏览器里选公司账号的提示。
import { after, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { CFG, PATHS } from "../gw/config.mjs";
import { NEXT } from "../gw/http.mjs";
import { routeLogin, authStatus } from "../gw/login.mjs";

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

// 假 agy：acp --login 打印授权地址后等着；models 列出真模型清单
function makeFakeAgy(dir) {
  const script = path.join(dir, "fake-agy-ent");
  fs.writeFileSync(script, `#!/bin/sh
if [ "$1" = "acp" ]; then
  printf 'Visit https://accounts.google.com/o/oauth2/auth?client_id=test\\n'
  sleep 30
elif [ "$1" = "models" ]; then
  printf 'gemini-3.8-flash\\tGemini 3.8 Flash\\n'
  exit 0
fi
exit 1
`, { mode: 0o755 });
  return script;
}

const tmp = fs.mkdtempSync(path.join(CFG.home, "fix-a-ent-"));
const fake = makeFakeAgy(tmp);
const prevAgy = PATHS.agy;
PATHS.agy = fake;
after(() => { PATHS.agy = prevAgy; });

test("A12：企业登录 start 应带回 method=enterprise 与选公司账号的提示，且登录态上报 oauth-business", async () => {
  const go = await serve(routeLogin);
  try {
    const s = await go("POST", "/api/login/start", { method: "enterprise" });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.equal(s.body.ok, true, JSON.stringify(s.body));
    assert.equal(s.body.method, "enterprise", JSON.stringify(s.body));
    assert.match(String(s.body.hint || ""), /公司|企业/, JSON.stringify(s.body));
    const v = await authStatus(true);
    assert.equal(v.loggedIn, true, JSON.stringify(v));
    assert.equal(v.authMethod, "oauth-business", JSON.stringify(v));
  } finally {
    await go("POST", "/api/login/cancel", {}).catch(() => {});
  }
});

test("A12 对照：个人登录上报 oauth-personal", async () => {
  const go = await serve(routeLogin);
  try {
    const s = await go("POST", "/api/login/start", { method: "personal" });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.equal(s.body.method, "personal", JSON.stringify(s.body));
    const v = await authStatus(true);
    assert.equal(v.loggedIn, true, JSON.stringify(v));
    assert.equal(v.authMethod, "oauth-personal", JSON.stringify(v));
  } finally {
    await go("POST", "/api/login/cancel", {}).catch(() => {});
  }
});
