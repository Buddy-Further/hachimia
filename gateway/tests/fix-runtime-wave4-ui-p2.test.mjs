// 第 4 波（收官波）专项回归测试：W3-F1..W3-F4 + C-08.1..C-08.5 + A-06..A-10
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { CFG, PATHS } from "../gw/config.mjs";
import { encodeProjectDir, acpSessionFile } from "../gw/acp.mjs";
import { imageRefs } from "../gw/inlineimg.mjs";
import { transcriptItems } from "../gw/transcript.mjs";
import { goalStateOf, goalStateOfAsync, goalCheckAsync } from "../gw/goal.mjs";
import { routeUsage } from "../gw/usage.mjs";
import { QUEUE, laneOfItem } from "../gw/queue.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const readRepo = (rel) => fs.readFileSync(path.join(REPO, rel), "utf8");

// ── Step 0 (W3-F1..W3-F4) 回归校验 ──────────────────────────────────────────
test("W3-F1..W3-F4: acp restrictMode/coldInit 取消 + reconcile .agy-uninstalled + run 自定义指令管线", () => {
  const acpSrc = readRepo("gateway/gw/acp.mjs");
  assert.match(acpSrc, /const serverModeOf\s*=\s*\(m\)\s*=>\s*\(restrictMode/);
  assert.match(acpSrc, /applyMode\(serverModeOf\(mode\)\)/);
  assert.match(acpSrc, /entry\.disallowedTools\s*=/);
  assert.match(acpSrc, /isAcpToolDisallowed\([^)]*entry\.disallowedTools/);
  assert.match(acpSrc, /if\s*\(!state\.promptSent\s*&&\s*!reused\)\s*\{\s*canKeep\s*=\s*false;\s*destroyClient\(\);\s*return;\s*\}/);
  assert.match(acpSrc, /if\s*\(run\?\.aborted\)\s*throw new Error\("aborted"\)/);

  const recSrc = readRepo("gateway/gw/reconcile.mjs");
  assert.ok(recSrc.includes(".agy-uninstalled"), "reconcile.mjs 应识别 .agy-uninstalled");
  assert.ok(recSrc.includes(".claude-uninstalled"), "reconcile.mjs 应兼容 .claude-uninstalled");

  const runSrc = readRepo("gateway/gw/run.mjs");
  assert.match(runSrc, /let isSlashCmd\s*=\s*isCmd/);
  assert.match(runSrc, /if\s*\(cmdExp\.expanded\)\s*\{[\s\S]*?isSlashCmd\s*=\s*false/);
});

// ── C-08.1..C-08.4: hachimia 前端 SPA 断链与 ACP 实时态适配 ────────────────
test("C-08.1..C-08.3: 脉络导览 ensureLinMap + pageOn 遮挡守卫 + 扩展页筛选与折叠委托", () => {
  const tour = readRepo("gateway/web/app/18c-lineage-tour.js");
  assert.match(tour, /let tourRequest\s*=\s*0/);
  assert.match(tour, /async function openTour\(\)/);
  assert.match(tour, /await ensureLinMap\(\)/);
  assert.match(tour, /data-a="retry"/);
  assert.match(tour, /tourRequest\+\+/);

  const nav = readRepo("gateway/web/app/13-nav-menus.js");
  assert.match(nav, /function pageOn\(name\)\s*\{\s*return !document\.hidden && \(name === "settings" \? setOpen : !setOpen && curPage === name && !\$?\("pages"\)\.classList\.contains\("hidden"\)\);\s*\}/);

  const ext = readRepo("gateway/web/app/08-extensions.js");
  assert.match(ext, /if\s*\(c\.dataset\.sec === "comp"\)\s*syncCatalog\(\)/);
  assert.match(ext, /if\s*\(!pageOn\("ext"\)\)\s*return/);
  assert.match(ext, /dataset\.famBound/);
});

test("C-08.4: 后台池 acpBg 徽标/视口保护 + ACP noteWrote + 子代理卡片与取消态", () => {
  const flow = readRepo("gateway/web/app/04-session-flow.js");
  assert.match(flow, /clearTimeout\(resumeTail\);\s*\n\s*resumeTail\s*=\s*setTimeout/);
  assert.match(flow, /ev\.auto !== "bg"/);
  assert.match(flow, /srv\.acpBg\s*=\s*s\.acpBg/);
  assert.match(flow, /acpBgSids/);

  const sess = readRepo("gateway/web/app/07-sessions.js");
  assert.match(sess, /function acpBgActiveSids\(\)/);
  assert.ok(sess.includes("acpBgActiveSids()"), "07-sessions.js 应把 acpBgActiveSids 并入 liveSessCount 与 idleSids");

  const core = readRepo("gateway/web/app/01-core.js");
  assert.match(core, /write_file\|edit_file\|replace_file_content/);
  assert.match(core, /input\.Path\s*\|\|\s*input\.TargetFile/);
  assert.match(core, /var SC\s*=\s*\{[^}]*openSeq:\s*0/);

  const chat = readRepo("gateway/web/app/02-chat-view.js");
  assert.match(chat, /spawn\|invoke/);
  assert.match(chat, /isAgentToolName\(m\.name\)/);
  assert.match(chat, /cancelled\s*\?\s*"cancel"/);
});

// ── C-08.5: 长路径 encodeProjectDir + 桥损坏自救 + overlayfs ctimeNs 豁免 ───
test("C-08.5: encodeProjectDir 长路径截断哈希对齐 projEnc 且 acpSessionFile 兼容旧路径", () => {
  const shortPath = "/data/user/0/ha.chi.mia/files/home/workspace/demo";
  assert.equal(encodeProjectDir(shortPath), shortPath.replace(/[^A-Za-z0-9]/g, "-"));

  const longPath = "/data/user/0/ha.chi.mia/files/home/workspace/" + "very-long-segment-".repeat(20) + "leaf";
  const enc = encodeProjectDir(longPath);
  const raw = longPath.replace(/[^A-Za-z0-9]/g, "-");
  const expected = raw.slice(0, 200) + "-" + crypto.createHash("sha256").update(path.resolve(longPath)).digest("hex").slice(0, 8);
  assert.equal(enc, expected);
  assert.ok(enc.length <= 209, `编码目录长度应 <=209，实际 ${enc.length}`);

  const f = acpSessionFile(longPath, "11111111-2222-4333-8444-555555555555");
  assert.ok(f.includes(path.sep + expected + path.sep), `会话文件应落在截断哈希目录下: ${f}`);
});

test("C-08.5: bridge-config 含损坏映射自救与 overlayfs ctimeNs 豁免，且 projects 含只读记忆端点", () => {
  const bc = readRepo("gateway/gw/bridge-config.mjs");
  assert.ok(bc.includes("function isCorruptMappingError("));
  assert.ok(bc.includes("function quarantineBadMapping("));
  assert.ok(bc.includes("allowCorruptMapping = false"));
  assert.ok(!bc.includes('"ctimeNs"'), "bridge-config.mjs 不应比对 overlayfs 会自发漂移的 ctimeNs");

  const pj = readRepo("gateway/gw/projects.mjs");
  assert.ok(pj.includes('if (sub === "/memory")'));
  assert.ok(pj.includes("function readMemoryFile("));
});

// ── A-06 & A-09: Java 宿主原子同步、PID 持久化、剥离令牌与 bin/claude ────────
test("A-06 & A-09: Java 宿主剥离 CCAPP_TOKEN_FILE、.gateway.pid 收割、AppFiles.ensureSynced、Env.proc 与 bin/claude 延迟 unset", () => {
  const share = readRepo("android/java/ha/chi/mia/Share.java");
  assert.ok(share.includes('pb.environment().remove("CCAPP_TOKEN_FILE")'));
  assert.ok(share.includes("env.proc("));

  const upd = readRepo("android/java/ha/chi/mia/Updater.java");
  assert.ok(upd.includes('pb.environment().remove("CCAPP_TOKEN_FILE")'));
  assert.ok(upd.includes("env.proc("));

  const ins = readRepo("android/java/ha/chi/mia/Installer.java");
  assert.ok(ins.includes('pb.environment().remove("CCAPP_TOKEN_FILE")'));
  assert.ok(ins.includes("env.proc(cmd)"));

  const gw = readRepo("android/java/ha/chi/mia/GatewayService.java");
  assert.ok(gw.includes('GW_PID_FILE = ".gateway.pid"'));
  assert.ok(gw.includes("writeGatewayPid(env.files, gpid, gst)"));
  assert.ok(gw.includes("readGatewayPid(env.files)"));
  assert.ok(gw.includes("AppFiles.ensureSynced("));

  const appf = readRepo("android/java/ha/chi/mia/AppFiles.java");
  assert.ok(appf.includes("static synchronized SyncResult ensureSynced("));

  const main = readRepo("android/java/ha/chi/mia/MainActivity.java");
  assert.ok(main.includes("AppFiles.ensureSynced("));

  const envJava = readRepo("android/java/ha/chi/mia/Env.java");
  assert.ok(envJava.includes("ProcessBuilder proc(String... argv)"));
  assert.ok(envJava.includes('e.put("TERMUX_EXEC__PROC_SELF_EXE", cmd.get(1))'));

  const claudeSh = readRepo("android/assets/bin/claude");
  const idxSed = claudeSh.lastIndexOf("sed -n");
  const idxSeal = claudeSh.lastIndexOf('node "$SEAL"');
  const idxUnset = claudeSh.lastIndexOf("unset LD_PRELOAD");
  const idxExec = claudeSh.lastIndexOf('exec "${CCAPP_LD');
  assert.ok(idxSed > 0 && idxSeal > idxSed && idxUnset > idxSeal && idxExec > idxUnset,
    `unset LD_PRELOAD 必须在 sed/node 之后、exec 紧前 (sed=${idxSed}, seal=${idxSeal}, unset=${idxUnset}, exec=${idxExec})`);
});

// ── A-07: 新会话车道隔离与定时任务忙等含未挂起队列 ──────────────────────────
test("A-07: 新会话独立车道互不串入且 sched fireNow 计入未挂起 QUEUE 项", () => {
  const a = { id: "r_new_a", sessionId: null, follow: null };
  const b = { id: "r_new_b", sessionId: null, follow: null };
  assert.equal(laneOfItem(a), "n:r_new_a");
  assert.equal(laneOfItem(b), "n:r_new_b");
  assert.notEqual(laneOfItem(a), laneOfItem(b));

  const qSrc = readRepo("gateway/gw/queue.mjs");
  assert.ok(qSrc.includes("!!item.follow && (item.follow === run.id || laneOfItem(item) === run.lane)"),
    "新会话（!sessionId && !follow）不得在 tryInject 中误注入已有轮次");

  const scSrc = readRepo("gateway/gw/sched.mjs");
  assert.ok(scSrc.includes("const busySlots = () => RUNS.size + runnableQueueCount();"));
  assert.ok(scSrc.includes("while (busySlots() >= maxParallel())"));
});

// ── A-08: 带空格引号图片路径 @"..." 提取与历史去重 ──────────────────────────
test("A-08: inlineimg imageRefs 与 transcriptItems 正确支持带空格引号附图 @\"/path/with space.png\"", () => {
  const dir = path.join(CFG.workspace, "wave4-img dir");
  fs.mkdirSync(dir, { recursive: true });
  const imgFile = path.join(dir, "my screen shot.png");
  const pngHeader = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d]);
  fs.writeFileSync(imgFile, pngHeader);
  try {
    const refs = imageRefs(`请看这张图 @"${imgFile}" 谢谢`);
    assert.deepEqual(refs, [imgFile]);

    const items = transcriptItems({
      type: "user",
      uuid: "u-img-space",
      message: {
        role: "user",
        content: [
          { type: "text", text: `请看这张图 @"${imgFile}"` },
          { type: "image", source: { type: "base64", media_type: "image/png", data: pngHeader.toString("base64") } },
        ],
      },
    });
    assert.equal(items.length, 1);
    assert.equal(items[0].role, "user");
    assert.ok(!items[0].text.includes("[图片]"), `已有 @\"...\" 路径不应多出 [图片]: ${items[0].text}`);

    const plainItems = transcriptItems({
      type: "user",
      uuid: "u-img-plain",
      message: {
        role: "user",
        content: [
          { type: "text", text: "没有路径的纯图消息" },
          { type: "image", source: { type: "base64", media_type: "image/png", data: pngHeader.toString("base64") } },
        ],
      },
    });
    assert.ok(plainItems[0].text.includes("[图片]"), "无路径图片消息仍应保留 [图片] 占位");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── A-10: goalStateOfAsync 缓存一致性 + usageImport 单文件容错 + 前端生命周期 ─
test("A-10: goalStateOfAsync 大文件缓存写齐 mtimeMs/fp 且同尺寸原地改写能即时失效", async () => {
  const dir = path.join(CFG.workspace, "wave4-goal-cache");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, "big-goal.jsonl");
  try {
    const pad = JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "x".repeat(2000) }] } }) + "\n";
    const chunk = pad.repeat(600); // > 1.2MB (> GOAL_CHUNK)
    const g1 = JSON.stringify({ type: "attachment", timestamp: "2026-11-24T01:00:00Z", attachment: { type: "goal_status", met: false, sentinel: true, condition: "ALPHA_COND" } }) + "\n";
    fs.writeFileSync(file, chunk + g1);

    const a1 = await goalStateOfAsync(file);
    assert.equal(a1?.condition, "ALPHA_COND");
    assert.equal(a1?.active, true);

    // 紧接着同步 goalStateOf 应直接命中同结构缓存
    const s1 = goalStateOf(file);
    assert.equal(s1?.condition, "ALPHA_COND");

    // 同字节数原地改写末尾条件（ALPHA_COND -> BRAVO_COND），即使 mtime 相同，fp 校验也必须发现并重扫
    const st0 = fs.statSync(file);
    const g2 = JSON.stringify({ type: "attachment", timestamp: "2026-11-24T01:00:00Z", attachment: { type: "goal_status", met: false, sentinel: true, condition: "BRAVO_COND" } }) + "\n";
    assert.equal(Buffer.byteLength(g1), Buffer.byteLength(g2));
    fs.writeFileSync(file, chunk + g2);
    fs.utimesSync(file, st0.atime, st0.mtime);

    const a2 = await goalStateOfAsync(file);
    assert.equal(a2?.condition, "BRAVO_COND", "同尺寸同 mtime 原地改写应由 fp 发现并刷新缓存");
    assert.equal(typeof goalCheckAsync, "function");

    assert.ok(readRepo("gateway/gw/queue.mjs").includes("goalCheckAsync(run.sessionId).catch("));
    assert.ok(readRepo("gateway/gw/sessions.mjs").includes("await goalStateOfAsync(found.file)"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("A-10: usageImport 单文件读错（如目录冒名 .jsonl / 并发删除）不中断整轮统计补算", async () => {
  const projDir = path.join(PATHS.projects, "wave4-usage-resilience");
  fs.mkdirSync(projDir, { recursive: true });
  // 用同名目录模拟 createReadStream 异步 EISDIR 错误，且旁边放一个合法历史会话
  const badJsonl = path.join(projDir, "bad-dir.jsonl");
  fs.mkdirSync(badJsonl, { recursive: true });
  const goodSid = "99999999-aaaa-4bbb-8ccc-dddddddddddd";
  const goodJsonl = path.join(projDir, `${goodSid}.jsonl`);
  const oldTs = new Date(Date.now() - 48 * 3600e3).toISOString();
  fs.writeFileSync(goodJsonl, [
    JSON.stringify({ type: "user", uuid: "u-w4-1", sessionId: goodSid, timestamp: oldTs, message: { role: "user", content: "hello usage resilience" } }),
    JSON.stringify({ type: "assistant", uuid: "a-w4-1", sessionId: goodSid, timestamp: oldTs, message: { id: "msg-w4-1", role: "assistant", model: "claude-sonnet-4-6", content: [{ type: "text", text: "ok" }], usage: { input_tokens: 10, output_tokens: 5 } } }),
  ].join("\n") + "\n");
  try {
    let status = 0, body = null;
    const { Readable } = await import("node:stream");
    const req = Object.assign(Readable.from([Buffer.from("{}")]), { method: "POST", headers: {} });
    const res = {
      writeHead(code) { status = code; },
      end(chunk) { body = JSON.parse(String(chunk || "{}")); },
    };
    await routeUsage(req, res, new URL("http://localhost/api/usage/import"), "/api/usage/import");
    assert.equal(status, 200);
    assert.equal(body?.ok, true);
    assert.ok(body.prompts >= 1, `遇到损坏/不可读 .jsonl 后仍应完成其余文件导入，got=${JSON.stringify(body)}`);
  } finally {
    fs.rmSync(projDir, { recursive: true, force: true });
  }
});

test("A-10: 前端切页生命周期收口（visibilitychange/agLoad/stScan/pdfPoll）", () => {
  const ps = readRepo("gateway/web/app/14-projects-sched.js");
  assert.match(ps, /else if \(setOpen\) \{ setBaseRead = refreshSettings\(false\); enterSetCat\(setCatOpen, true\); \}/);
  assert.ok(ps.includes('if (name === "trash") loadTrash();'));
  assert.ok(ps.includes('if (name === "bookmarks") loadBookmarks();'));

  const ag = readRepo("gateway/web/app/03b-agents.js");
  assert.match(ag, /const gen = view\.gen;/);
  assert.match(ag, /if \(view\.sessionId !== sid \|\| view\.gen !== gen\) return;/);

  const st = readRepo("gateway/web/app/10b-storage.js");
  assert.match(st, /if \(!setVisible\("storage", visit\)\) return;\s*\n\s*stLater\(800, visit\);/);

  const pdf = readRepo("gateway/web/app/18-pdf-tools.js");
  assert.match(pdf, /PT\.errs >= 10/);
  assert.match(pdf, /delay = PT\.el \?/);
});
