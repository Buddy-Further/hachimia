// G 分片：G6 git 撤销未跟踪目录 500 EISDIR（fix-G-security，先写失败测试）
//   /api/git/discard 撤销新建目录时 fs.rmSync 缺 recursive: true，目录原地不动；撤销单个未跟踪文件正常。
import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { CFG } from "../gw/config.mjs";
import { NEXT } from "../gw/http.mjs";
import { routeGit } from "../gw/git.mjs";

const srv = http.createServer(async (req, res) => { const u = new URL(req.url, "http://x"); if ((await routeGit(req, res, u, u.pathname)) === NEXT) res.writeHead(404).end(); });
await new Promise((ok) => srv.listen(0, "127.0.0.1", ok));
after(() => srv.close());
const call = async (p, body) => { const r = await fetch(`http://127.0.0.1:${srv.address().port}${p}`, body === undefined ? {} : { method: "POST", body: JSON.stringify(body) }); return { status: r.status, body: await r.json() }; };
{ const real = execFileSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).trim(), bin = path.join(process.env.CCAPP_PREFIX, "bin", "git");
  if (!fs.existsSync(bin)) fs.symlinkSync(real, bin); }

test("G6：撤销未跟踪目录成功、目录消失；撤销未跟踪文件照旧成功", async () => {
  const d = path.join(CFG.workspace, "g6repo");
  fs.rmSync(d, { recursive: true, force: true }); fs.mkdirSync(d, { recursive: true });
  const g = (...a) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...a], { cwd: d, encoding: "utf8" });
  g("init", "-q"); g("commit", "-q", "--allow-empty", "-m", "init");
  fs.mkdirSync(path.join(d, "newdir", "sub"), { recursive: true });
  fs.writeFileSync(path.join(d, "newdir", "sub", "f.txt"), "hello\n");
  fs.writeFileSync(path.join(d, "loose.txt"), "x\n");
  const r1 = await call("/api/git/discard", { dir: d, file: "newdir" });
  assert.equal(r1.status, 200, JSON.stringify(r1.body));
  assert.equal(fs.existsSync(path.join(d, "newdir")), false, "目录应被删掉");
  const r2 = await call("/api/git/discard", { dir: d, file: "loose.txt" });
  assert.equal(r2.status, 200, JSON.stringify(r2.body));
  assert.equal(fs.existsSync(path.join(d, "loose.txt")), false, "文件照旧删掉");
  fs.rmSync(d, { recursive: true, force: true });
});
