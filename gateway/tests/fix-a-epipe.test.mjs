// A1（P0）：/api/login/code 写授权码遇 EPIPE 时网关进程不得退出，
// 应返回 ok:false 并把登录标记为失败、codeSent 复位。
// 复现：假 agy 打印授权地址后关闭 stdin 读端（exec 0<&-）继续活着。
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

// 假 agy：打印授权地址后关掉 stdin 读端、继续活着（复现 login.mjs:253 的 EPIPE 场景）
function makeDeadStdinAgy(dir) {
  const script = path.join(dir, "fake-agy-epipe");
  fs.writeFileSync(script, `#!/bin/sh
printf 'Visit https://accounts.google.com/o/oauth2/auth?client_id=test\\n'
exec 0<&-
sleep 30
`, { mode: 0o755 });
  return script;
}

test("A1：授权码写进已关 stdin 时不崩进程，返回 ok:false 且 codeSent 复位", async (t) => {
  const tmp = fs.mkdtempSync(path.join(CFG.home, "fix-a-epipe-"));
  const fake = makeDeadStdinAgy(tmp);
  const prevAgy = PATHS.agy;
  PATHS.agy = fake;
  const go = await serve(routeLogin);
  try {
    const s = await go("POST", "/api/login/start", { method: "personal" });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.equal(s.body.ok, true, JSON.stringify(s.body));
    assert.match(s.body.url || "", /accounts\.google\.com/, JSON.stringify(s.body));

    // 关键断言：这一行在修之前会以未捕获 EPIPE 杀掉整个测试进程（rc=1）
    const c = await go("POST", "/api/login/code", { code: "4/0-test-code" });
    assert.equal(c.status, 200, JSON.stringify(c.body));
    assert.equal(c.body.ok, false, "写不进 stdin 的授权码不能报 ok:true：" + JSON.stringify(c.body));
    assert.match(String(c.body.message || ""), /授权码|stdin|重新发起/, JSON.stringify(c.body));

    // 界面不能还显示“已提交”：codeSent 必须复位
    const st = await go("GET", "/api/login/status");
    assert.equal(st.body.codeSent, false, JSON.stringify(st.body));
    assert.equal(st.body.waitingCode, false, JSON.stringify(st.body));
  } finally {
    PATHS.agy = prevAgy;
    await go("POST", "/api/login/cancel", {}).catch(() => {});
  }
});
