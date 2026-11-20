// E-01：组件扩展页的索引来源与构建匹配。
// 预置索引应指向 hachimia 的 components Release（当前尚无该 Release，见修复报告）；
// 社区索引在 hachimia 尚无对应仓库时应停用，而不是继续拉 cccodroid 的索引——
// 那些构建的 base 全是 cccodroid 工具包的 gz sha，永远匹配不上 hachimia 工具包。
// 构建匹配本身只认 base === 当前工具包 gz sha256（与 components-index.mjs 的约定一致）。
// 运行：node scripts/test.mjs fix-e-comp-index
import "../gw/config.mjs";
import test, { after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { PREFIX } from "../gw/config.mjs";

const DK_SHA = "919a05cd57dd5942ca973d616b28d3e94b8ec02a8f375910bb1382df34943273"; // devkit-pin.json 钉的 devkit-2026.11.19 gz sha
const CC_SHA = "3768afcf79a7deadbeef0000000000000000000000000000000000000000".slice(0, 64);
const COMP_DIR = path.join(path.dirname(PREFIX), "components");
const OK = path.join(PREFIX, ".devkit-ok");

const S = { preset: "" };
const server = http.createServer((req, res) => {
  if (req.url === "/preset.json") { res.writeHead(200, { "content-type": "application/json" }); return res.end(S.preset); }
  res.writeHead(404); res.end();
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const B = `http://127.0.0.1:${server.address().port}`;
after(() => {
  server.close();
  for (const k of ["CCAPP_COMPONENTS_INDEX", "CCAPP_COMPONENTS_INDEX_MIRROR", "CCAPP_COMPONENTS_COMMUNITY_INDEX", "CCAPP_COMPONENTS_COMMUNITY_INDEX_MIRROR", "CCAPP_COMPONENTS_ALLOW_UNSIGNED"]) delete process.env[k];
  fs.rmSync(path.join(COMP_DIR, "chromium.json"), { force: true });
  fs.rmSync(OK, { force: true });
});

let n = 0;
const fresh = () => import("../gw/components.mjs?i=" + ++n);

test("E-01 索引地址：预置索引默认走 hachimia，社区索引与 cccodroid 镜像默认停用", () => {
  const src = fs.readFileSync(new URL("../gw/components.mjs", import.meta.url), "utf8");
  assert.ok(src.includes("greyoak111/hachimia/releases/download/components/components.json"), "预置索引应默认指向 hachimia 的 components Release");
  assert.ok(!src.includes("greyoak111/cccodroid/releases/download/components/components.json"), "不应再默认拉 cccodroid 的预置索引");
  assert.ok(!src.includes("greyoak111/cccodroid-components/releases/download/index/components.json"), "不应再默认拉 cccodroid 的社区索引");
  assert.ok(!src.includes("cccodroid.net/components/"), "不应再默认走 cccodroid.net 的组件镜像");
});

test("E-01 社区源未配置时静默跳过：只拉预置索引，不报错、不混入 cccodroid 社区组件", async () => {
  S.preset = JSON.stringify({ components: { chromium: {
    name: { zh: "浏览器", en: "Chromium" },
    builds: [{ base: DK_SHA, version: "156.0.0", sha256: "b".repeat(64), bytes: 100, installed: 200, asset: "chromium.tar.gz", url: B + "/chromium.tar.gz" }],
  } } });
  Object.assign(process.env, {
    CCAPP_COMPONENTS_INDEX: B + "/preset.json", CCAPP_COMPONENTS_INDEX_MIRROR: B + "/missing-m.json",
    CCAPP_COMPONENTS_COMMUNITY_INDEX: "", CCAPP_COMPONENTS_COMMUNITY_INDEX_MIRROR: "",
    CCAPP_COMPONENTS_ALLOW_UNSIGNED: "1",
  });
  const m = await fresh();
  const r = await m.compIndex(true);
  assert.equal(r.error, "", "社区源未配置不应产生索引错误");
  assert.ok(r.data.components.chromium, "预置索引的组件应列出");
  assert.ok(!Object.keys(r.data.components).some((id) => id !== "chromium"), "不应混入任何社区来源的组件");
});

test("E-01 构建匹配：只有 base 等于当前工具包 gz sha 的构建才被选中", async () => {
  fs.mkdirSync(COMP_DIR, { recursive: true });
  fs.writeFileSync(OK, JSON.stringify({ sha256: DK_SHA, base: "https://github.com/greyoak111/hachimia/releases/download/devkit-2026.11.19/" }));
  const m = await fresh();
  const { compState, compWriteRecord } = m._compForTest;
  assert.ok(compWriteRecord("chromium", { state: "ok", base: DK_SHA, sha256: "a".repeat(64), version: "1.0", bin: [], files: [] }));
  const dk = { sha256: DK_SHA };
  const matchEntry = { builds: [{ base: DK_SHA, version: "1.1", sha256: "b".repeat(64) }] };
  assert.equal(compState("chromium", matchEntry, dk), "update", "base 对得上的新构建应报可更新");
  const ccOnlyEntry = { builds: [{ base: CC_SHA, version: "9.9", sha256: "c".repeat(64) }] };
  assert.equal(compState("chromium", ccOnlyEntry, dk), "ok", "只有 cccodroid 底座构建时，不应报可更新（构建匹配不上当前工具包）");
});
