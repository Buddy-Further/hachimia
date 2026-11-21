// F-G4-3 B1 路由触发：项目列表与任务列表的原始读数（listProjects / GET /api/sched
// 直接返回存下的 provider）也必须经过迁移，否则用户先打开项目页/任务页时仍会看到
// 钉在被隐藏厂商上的旧值。本文件只调路由，不直接调任何迁移函数；
// 若将来有人把路由入口的 ensureMigrated 删掉，本测试即红。
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "fix-reg-gemini4-b1-routes-"));
const fakeAgy = path.join(tmpRoot, "agy");
fs.writeFileSync(fakeAgy, "#!/bin/sh\nexit 1\n", { mode: 0o755 });
process.env.CCAPP_AGY = fakeAgy;
delete process.env.CCAPP_CLAUDE;

const { CFG, PATHS } = await import("../gw/config.mjs");
const PROJ_FILE = path.join(CFG.home, "ccapp-projects.json");
const SCHED_FILE = path.join(CFG.home, "ccapp-sched.json");
const NO_CLAUDE = path.join(CFG.home, "fix-reg-gemini4-b1-routes-no-claude");
const projDisk = () => JSON.parse(fs.readFileSync(PROJ_FILE, "utf8"));
const schedDisk = () => JSON.parse(fs.readFileSync(SCHED_FILE, "utf8"));

fs.writeFileSync(PROJ_FILE, JSON.stringify([
  { id: "proj-g4-route", name: "路由项目", path: path.join(tmpRoot, "proj-route"), provider: "anthropic", model: "claude-sonnet-5-5", effort: "", perm: "", created: 1 },
]));
fs.writeFileSync(SCHED_FILE, JSON.stringify({
  tasks: [
    { id: "task-g4-route", name: "路由任务", on: false, provider: "anthropic", model: "claude-sonnet-5-5", effort: "" },
  ],
  dailyBudget: 0, missed: [], pending: [], sids: [], lastTick: 0, allowLogin: false,
  spent: {}, monthly: {}, monthlySeeded: false, retries: [],
}));
after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  for (const f of [PROJ_FILE, SCHED_FILE]) fs.rmSync(f, { force: true });
});

// providers 先 import（TDZ 崩溃的顺序），再 import 待测的两个路由模块。
const prov = await import("../gw/providers.mjs");
const { NEXT } = await import("../gw/http.mjs");
const { routeProjects } = await import("../gw/projects.mjs");
const { routeSched } = await import("../gw/sched.mjs");

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

test("B1 路由触发：只 GET /api/projects，列表里的项目默认即被迁移并落盘", async () => {
  assert.equal(prov.isAgyOnlyMode(), true, "本用例应在 agy-only 模式下跑");
  assert.equal(projDisk()[0].provider, "anthropic", "前置：调用路由前磁盘仍是旧钉选");
  const { srv, call } = await serve(routeProjects);
  try {
    const r = await call("/api/projects");
    assert.equal(r.status, 200);
    const p = r.body.projects.find((x) => x.id === "proj-g4-route");
    assert.equal(p.provider, "antigravity", "只调一次列表接口，项目默认就应已迁回 antigravity");
    assert.equal(p.model, "", "模型应置空");
    assert.equal(projDisk()[0].provider, "antigravity", "迁移应落盘");
  } finally { srv.close(); }
});

test("O3 路由触发：只 GET /api/sched，列表里的任务钉选即被迁移，loginTasks 仍认它是订阅任务", async () => {
  assert.equal(schedDisk().tasks[0].provider, "anthropic", "前置：调用路由前磁盘仍是旧钉选");
  const { srv, call } = await serve(routeSched);
  try {
    const r = await call("/api/sched");
    assert.equal(r.status, 200);
    const t = r.body.tasks.find((x) => x.id === "task-g4-route");
    assert.equal(t.provider, "antigravity", "只调一次列表接口，任务钉选就应已迁回 antigravity");
    assert.equal(t.model, "", "模型应置空");
    assert.ok(r.body.loginTasks.includes("task-g4-route"), "迁到 antigravity 后仍是订阅登录任务，门禁判断不变");
    assert.equal(schedDisk().tasks[0].provider, "antigravity", "迁移应落盘");
  } finally { srv.close(); }
});
