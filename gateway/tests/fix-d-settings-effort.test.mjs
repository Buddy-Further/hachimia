// D-10：换厂商后 effort 旧值不能残留。先在 deepseek 上设 effort=high，再切到 antigravity，
// 回执里的 effort 必须被清掉（null），否则设置页下拉显示默认、内存仍存 high。
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { PATHS } from "../gw/config.mjs";
import { NEXT } from "../gw/http.mjs";

async function serve(route) {
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://x");
    if ((await route(req, res, u, u.pathname)) !== NEXT) return;
    res.writeHead(404).end();
  });
  await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
  return {
    srv,
    call: async (p, body) => {
      const r = await fetch(`http://127.0.0.1:${srv.address().port}${p}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) });
      return { status: r.status, body: await r.json() };
    },
  };
}

test("D-10 换厂商清掉 effort（连同 model / titleModel）", async (t) => {
  const had = fs.existsSync(PATHS.settings);
  const before = had ? fs.readFileSync(PATHS.settings, "utf8") : null;
  fs.mkdirSync(path.dirname(PATHS.settings), { recursive: true });
  fs.writeFileSync(PATHS.settings, JSON.stringify({ provider: "deepseek", model: "deepseek-flash", effort: "high", titleModel: "deepseek-flash", permMigrated: 1 }, null, 2));
  const { routeSettings } = await import("../gw/settings.mjs");
  const { srv, call } = await serve(routeSettings);
  t.after(() => {
    srv.close();
    try { fs.rmSync(PATHS.settings + ".tmp", { force: true }); } catch {}
    if (had) fs.writeFileSync(PATHS.settings, before); else fs.rmSync(PATHS.settings, { force: true });
  });
  const seed = await call("/api/settings");
  assert.equal(seed.body.effort, "high", "预置 effort 应为 high，实际: " + JSON.stringify(seed.body));
  const r = await call("/api/settings", { provider: "antigravity" });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.settings.effort, null, "切厂商后 effort 必须清掉，实际: " + JSON.stringify(r.body.settings));
  assert.equal(r.body.settings.model, null);
  assert.equal(r.body.settings.titleModel, null);
  const after = await call("/api/settings");
  assert.equal(after.body.effort, null, "落盘后重读 effort 仍应是 null，实际: " + JSON.stringify(after.body));
});
