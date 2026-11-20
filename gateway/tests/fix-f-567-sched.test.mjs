// F-5：clean 部分 PATCH 不丢旧 freq 未给字段；
// F-6：tick 在 WAITING 期间到点要留 skip 记录，不能静默吞掉；
// F-7：失败重试要落盘，重启后新进程仍能恢复。
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { CFG } from "../gw/config.mjs";

const { _schedForTest: S } = await import("../gw/sched.mjs");
const { QUEUE, END_HOOKS } = await import("../gw/queue.mjs");
const { RUNS, maxParallel } = await import("../gw/runs.mjs");

const fake = [];
for (let i = 0; i < maxParallel(); i++) { const id = "fixf-busy" + i; fake.push(id); RUNS.set(id, { id, text: "", startedAt: Date.now(), log: [], idle: false, ended: false, lane: "x" }); }
after(() => { for (const id of fake) RUNS.delete(id); });
S.DB.allowLogin = true;

// ── F-5 ──
test("F-5 clean 部分 PATCH 只改 kind 时，旧 freq 的 time/days 等字段保留", () => {
  const old = { id: "t1", name: "日报", prompt: "x", on: true, freq: { kind: "daily", time: "15:30" } };
  assert.equal(S.clean({ freq: { kind: "weekly" } }, old).freq.time, "15:30");
  assert.equal(S.clean({ freq: { kind: "daily" } }, old).freq.time, "15:30");
  const oldW = { id: "t2", name: "周报", prompt: "x", on: true, freq: { kind: "weekly", days: [1, 3], time: "08:00" } };
  const p = S.clean({ freq: { kind: "weekly", days: [2] } }, oldW);
  assert.deepEqual(p.freq.days, [2]);
  assert.equal(p.freq.time, "08:00", "只改 days 时 time 应保留");
  // 给了新值要覆盖旧值
  assert.equal(S.clean({ freq: { kind: "daily", time: "07:00" } }, old).freq.time, "07:00");
});

// ── F-6 ──
test("F-6 WAITING 期间又到点：第二次 tick 留一条 skip 记录，不再静默丢失", () => {
  const t = { id: "fixf-r6", name: "r6任务", prompt: "做事", on: true, freq: { kind: "daily", time: "09:00" }, nextAt: Date.now() - 60000, busy: "queue", session: "new", projectId: null, perm: "ro" };
  S.DB.tasks.push(t);
  try {
    S.tick(); // 第 1 次：进 WAITING 忙等，nextAt 被推到未来
    assert.ok(S.running().some((r) => r.taskId === t.id && r.waiting), "第 1 次 tick 后应在 WAITING");
    t.nextAt = Date.now() - 60000; // 模拟短间隔任务在等待期间又到点
    const before = S.runlog().filter((r) => r.taskId === t.id).length;
    S.tick(); // 第 2 次：去重不能静默吞掉
    const afterRuns = S.runlog().filter((r) => r.taskId === t.id);
    assert.ok(afterRuns.length > before, "第 2 次到点应留运行记录，实际新增 0");
    assert.equal(afterRuns.at(-1).st, "skip");
  } finally {
    const i = S.DB.tasks.indexOf(t); if (i >= 0) S.DB.tasks.splice(i, 1);
    const qi = QUEUE.findIndex((q) => q.sched && q.sched.taskId === t.id);
    if (qi >= 0) QUEUE.splice(qi, 1);
  }
});

// ── F-7 ──
test("F-7 失败重试落盘：ccapp-sched.json 里有待执行重试；全新进程导入后 hasRetry 仍为 true", async () => {
  const t = { id: "fixf-r7", name: "r7", prompt: "x", on: true, freq: { kind: "daily", time: "09:00" }, nextAt: Date.now() + 3600e3, session: "new", projectId: null, busy: "run", retry: 1, limitCost: 0, limitMin: 15 };
  S.DB.tasks.push(t);
  try {
    const it = await S.fire(t, { reason: "manual" });
    assert.ok(it && QUEUE.includes(it), "应入队");
    for (const h of END_HOOKS) h({ sched: { ...it.sched, taskId: t.id }, sessionId: null, denied: [] }, { costRaw: 0, finalText: "boom", failed: true });
    assert.equal(S.hasRetry(t.id), true, "失败后内存里应有重试");
    const onDisk = JSON.parse(fs.readFileSync(path.join(CFG.home, "ccapp-sched.json"), "utf8"));
    assert.ok(Array.isArray(onDisk.retries) && onDisk.retries.some((r) => r.taskId === t.id), "盘上应有待执行重试，实际：" + JSON.stringify(onDisk.retries));
    // 模拟网关重启：全新进程读同一份 home，导入即恢复重试
    const child = spawnSync(process.execPath, ["--input-type=module", "-e",
      `const { _schedForTest: S } = await import(${JSON.stringify(new URL("../gw/sched.mjs", import.meta.url).pathname)}); console.log('HAS_RETRY=' + S.hasRetry('fixf-r7')); process.exit(0);`],
      { encoding: "utf8", env: { ...process.env } });
    assert.match(child.stdout || "", /HAS_RETRY=true/, "重启后新进程应恢复重试，子进程输出：" + JSON.stringify(child) );
    const qi = QUEUE.indexOf(it); if (qi >= 0) QUEUE.splice(qi, 1);
  } finally {
    S.cancelRetry(t.id);
    S.DB.tasks.splice(S.DB.tasks.indexOf(t), 1);
  }
});
