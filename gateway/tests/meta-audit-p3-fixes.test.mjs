// Meta-audit P3 & Meta-Law D behavioral regression tests
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import vm from "node:vm";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const TMP_BASE = process.env.TMPDIR || os.tmpdir();

test("P3 priv.mjs: oneShot 强制总超时（抗慢速滴答流）且 exec() 拒绝超大响应帧与支持 stdin 背压", async () => {
  const privPath = path.join(ROOT, "android/assets/bin/priv.mjs");
  const dir = fs.mkdtempSync(path.join(TMP_BASE, "p3-priv-"));
  const sock = path.join(dir, "p.sock");
  let mode = "trickle";
  const sockets = new Set();
  const timers = new Set();
  let receivedStdinBytes = 0;

  const srv = net.createServer((c) => {
    c.on("error", () => {});
    sockets.add(c);
    c.on("close", () => sockets.delete(c));
    let headerDone = false;
    let raw = Buffer.alloc(0);
    c.on("data", (d) => {
      raw = Buffer.concat([raw, d]);
      if (!headerDone) {
        const nl = raw.indexOf(0x0a);
        if (nl < 0) return;
        headerDone = true;
        raw = raw.subarray(nl + 1);
        if (mode === "trickle") {
          c.write("{");
          const iv = setInterval(() => {
            if (c.destroyed || !c.writable) { clearInterval(iv); timers.delete(iv); return; }
            c.write(" ");
          }, 40);
          timers.add(iv);
          return;
        }
        if (mode === "oversized_frame") {
          // 声明 32 MiB 帧（超过 16 MiB MAX_FRAME）
          const h = Buffer.alloc(5);
          h[0] = 1;
          h.writeUInt32BE(32 << 20, 1);
          c.write(h);
          return;
        }
      }
      if (mode === "exec_drain") {
        while (raw.length >= 5) {
          const type = raw[0], len = raw.readUInt32BE(1);
          if (raw.length < 5 + len) break;
          raw = raw.subarray(5 + len);
          if (type === 0) {
            receivedStdinBytes += len;
            if (len === 0) {
              const out = Buffer.from(`GOT=${receivedStdinBytes}\n`);
              const h1 = Buffer.alloc(5); h1[0] = 1; h1.writeUInt32BE(out.length, 1);
              const h3 = Buffer.alloc(9); h3[0] = 3; h3.writeUInt32BE(4, 1); h3.writeInt32BE(0, 5);
              c.end(Buffer.concat([h1, out, h3]));
            }
          }
        }
      }
    });
  });
  await new Promise((r) => srv.listen(sock, r));

  try {
    // 1. oneShot 总超时：每 40ms 滴答 1 字节，250ms 总超时仍须及时中断（空闲超时会永不超时）
    mode = "trickle";
    const t0 = Date.now();
    const rTrickle = await new Promise((res) => {
      const ch = spawn(process.execPath, [privPath, "--status"], {
        env: { ...process.env, CCAPP_PRIV_SOCK: sock, CCAPP_PRIV_TIMEOUT_MS: "250" },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let out = "", err = "";
      ch.stdout.on("data", (d) => (out += d));
      ch.stderr.on("data", (d) => (err += d));
      ch.on("close", (code) => res({ code, out, err }));
    });
    assert.equal(rTrickle.code, 125, `滴答流应超时退出 125，实际 ${rTrickle.code}`);
    assert.match(rTrickle.err, /超时/);
    assert.ok(Date.now() - t0 < 2000, `总超时应在 2s 内结束，实际 ${Date.now() - t0}ms`);

    // 2. exec() 响应帧超上限：立刻拒收并退出 125
    mode = "oversized_frame";
    const rBig = await new Promise((res) => {
      const ch = spawn(process.execPath, [privPath, "--", "echo", "hi"], {
        env: { ...process.env, CCAPP_PRIV_SOCK: sock },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let err = "";
      ch.stderr.on("data", (d) => (err += d));
      ch.on("close", (code) => res({ code, err }));
    });
    assert.equal(rBig.code, 125);
    assert.match(rBig.err, /回应帧过大/);

    // 3. exec() 大 stdin 传输（含背压 resume/pause 路径）完整送达并收齐退出码 0
    mode = "exec_drain";
    receivedStdinBytes = 0;
    const payload = Buffer.alloc(2 * 1024 * 1024, 0x41);
    const rDrain = await new Promise((res) => {
      const ch = spawn(process.execPath, [privPath, "--", "cat"], {
        env: { ...process.env, CCAPP_PRIV_SOCK: sock },
        stdio: ["pipe", "pipe", "pipe"],
      });
      let out = "", err = "";
      ch.stdout.on("data", (d) => (out += d));
      ch.stderr.on("data", (d) => (err += d));
      ch.on("close", (code) => res({ code, out, err }));
      ch.stdin.end(payload);
    });
    assert.equal(rDrain.code, 0, rDrain.err);
    assert.equal(rDrain.out.trim(), `GOT=${payload.length}`);
  } finally {
    for (const iv of timers) clearInterval(iv);
    for (const c of sockets) c.destroy();
    srv.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("Meta-Law D scripts/java-tests.sh: 缺 android.jar 默认非零失败，且 CI 下无视 ALLOW_NO_ANDROID_JAR", () => {
  const script = path.join(ROOT, "scripts/java-tests.sh");
  // 若本机没有 javac，仍可校验脚本分支；有 javac 时真跑脚本直到 android.jar 检查处
  const hasJavac = spawnSync("javac", ["-version"], { encoding: "utf8" }).status === 0;
  const shBin = fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh";
  if (hasJavac) {
    const fakeHome = fs.mkdtempSync(path.join(TMP_BASE, "p3-nojar-"));
    try {
      const baseEnv = {
        ...process.env,
        HOME: fakeHome,
        ANDROID_JAR: path.join(fakeHome, "missing.jar"),
        ANDROID_SDK_ROOT: path.join(fakeHome, "no-sdk"),
        ANDROID_HOME: path.join(fakeHome, "no-sdk"),
      };
      delete baseEnv.CI;
      delete baseEnv.GITHUB_ACTIONS;
      delete baseEnv.ALLOW_NO_ANDROID_JAR;

      // 默认缺失必须非零失败
      const r1 = spawnSync(shBin, [script], { env: baseEnv, encoding: "utf8", timeout: 60000 });
      assert.notEqual(r1.status, 0, "缺 android.jar 时默认必须非零退出");
      assert.match(r1.stderr, /找不到 android\.jar/);

      // CI=true 时即使设了 ALLOW_NO_ANDROID_JAR=1 也必须非零失败
      const r2 = spawnSync(shBin, [script], {
        env: { ...baseEnv, CI: "true", ALLOW_NO_ANDROID_JAR: "1" },
        encoding: "utf8",
        timeout: 60000,
      });
      assert.notEqual(r2.status, 0, "CI=true 时禁止静默跳过 Android Java 测试");
    } finally {
      fs.rmSync(fakeHome, { recursive: true, force: true });
    }
  } else {
    const src = fs.readFileSync(script, "utf8");
    assert.match(src, /ALLOW_NO_ANDROID_JAR/);
    assert.match(src, /exit 1/);
  }
});

test("P3 verify-claude.mjs 与 publish-devkit.mjs 关键修复校验", () => {
  const vcSrc = fs.readFileSync(path.join(ROOT, "scripts/verify-claude.mjs"), "utf8");
  assert.match(vcSrc, /spawnSync\(ENOSYS,\s*\["-v",\s*"-f",\s*"\/system\/bin\/linker64",\s*BIN,\s*"--version"\]/,
    "--bin 探测 linker64 回退必须套 ENOSYS");
  assert.match(vcSrc, /sidEv\?\.session_id\s*\|\|\s*sidEv\?\.conversation_id/,
    "回退提取会话 ID 必须同时支持 conversation_id");

  const pdSrc = fs.readFileSync(path.join(ROOT, "scripts/publish-devkit.mjs"), "utf8");
  const fetchBlock = pdSrc.slice(pdSrc.indexOf("step.fetch ="), pdSrc.indexOf("step.pin ="));
  assert.match(fetchBlock, /devkit\.lock\.json\.sig/, "step.fetch 必须提前下载并校验 devkit.lock.json.sig");
  assert.match(fetchBlock, /lock\.release !== TAG/, "step.fetch 必须校验 lock.release === TAG");
});

test("P3 08-extensions.js: UC.saving 与 mcpSaving 在途锁阻止切作用域/重开表单误关", async () => {
  const src = fs.readFileSync(path.join(ROOT, "gateway/web/app/08-extensions.js"), "utf8");
  // 提取 UC 模块并在 vm 中实测保存期间切作用域被拦截、不会提前关表单
  const ucStart = src.indexOf("  const UC =");
  assert.ok(ucStart > 0);
  const ucCode = src.slice(ucStart);

  const listeners = new Map();
  const elems = new Map();
  const mkEl = (id) => {
    const cls = new Set();
    return {
      id,
      innerHTML: "",
      textContent: "",
      value: "",
      disabled: false,
      dataset: {},
      classList: {
        add: (...c) => c.forEach((x) => cls.add(x)),
        remove: (...c) => c.forEach((x) => cls.delete(x)),
        contains: (c) => cls.has(c),
      },
      addEventListener(ev, fn) { listeners.set(`${id}:${ev}`, fn); },
      querySelector(sel) {
        const m = /\[data-f="(\w+)"\]/.exec(sel);
        if (m) return this._fields[m[1]] || (this._fields[m[1]] = { value: "", focus() {} });
        return null;
      },
      scrollIntoView() {},
      _fields: {},
    };
  };
  let resolveSave;
  let closeCount = 0;
  let saveCalls = 0;
  const ctx = {
    localStorage: { getItem: () => "user", setItem() {} },
    $: (id) => elems.get(id) || (elems.set(id, mkEl(id)), elems.get(id)),
    api: async () => ({ workspace: "/w", scopes: [{ scope: "user", items: [] }, { scope: "project", items: [] }] }),
    post: () => {
      saveCalls++;
      return new Promise((r) => { resolveSave = r; });
    },
    extLatest: () => () => true,
    t: (s) => s,
    esc: (s) => String(s ?? ""),
    toast() {},
    confirm: () => true,
    closePage() {},
    insertAtCursor() {},
    loadCaps() {},
    inputEl: { focus() {} },
    document: { querySelectorAll: () => [] },
    MO: {
      cancel() {},
      play() {},
      on: () => false,
      leave(_f, _c, _ms, cb) { closeCount++; cb(); },
    },
  };
  vm.runInNewContext(ucCode + "\nglobalThis.__UC = UC; globalThis.__ucForm = ucForm; globalThis.__loadExtCmds = loadExtCmds;", ctx);
  await ctx.__loadExtCmds();
  ctx.__ucForm(null);
  const cmdForm = ctx.$("cmd-form");
  cmdForm.querySelector('[data-f="name"]').value = "mycmd";
  cmdForm.querySelector('[data-f="body"]').value = "do work";
  cmdForm.querySelector('[data-f="description"]').value = "";
  cmdForm.querySelector('[data-f="hint"]').value = "";

  const secClick = listeners.get("ext-cmd-sec:click");
  const saveBtn = { disabled: false, dataset: { uc: "f-save" }, closest: (s) => (s === "[data-uc]" ? saveBtn : null) };
  // 启动保存（挂起中）
  const pSave = secClick({ target: { closest: (s) => (s === "[data-uc]" ? saveBtn : null) } });
  assert.equal(ctx.__UC.saving, true, "保存进行中 UC.saving 应为 true");
  assert.equal(saveCalls, 1);

  // 1) 在途尝试切作用域：必须被锁挡住，UC.scope 不变，表单不被关闭
  const scopeChip = { dataset: { cscope: "project" } };
  await secClick({ target: { closest: (s) => (s === "[data-cscope]" ? scopeChip : null) } });
  assert.equal(ctx.__UC.scope, "user", "保存期间禁止切作用域");
  assert.equal(closeCount, 0, "保存期间禁止关闭表单");

  // 2) 在途重复点击保存：被锁挡住
  await secClick({ target: { closest: (s) => (s === "[data-uc]" ? saveBtn : null) } });
  assert.equal(saveCalls, 1, "保存期间禁止重复提交");

  // 3) 保存完成后释放锁并正常关闭表单
  resolveSave({ ok: true, name: "mycmd" });
  await pSave;
  assert.equal(ctx.__UC.saving, false, "保存结束后 UC.saving 应复位");
  assert.equal(closeCount, 1, "保存成功后应关闭表单");
  assert.equal(saveBtn.disabled, false);

  // 4) 核实 MCP 侧也具备对等 mcpSaving + mcpEditSeq 保护
  assert.match(src, /let mcpEdit = null, mcpSaving = false, mcpEditSeq = 0;/);
  assert.match(src, /if \(!mcpEdit \|\| mcpSaving\) return;/);
  assert.match(src, /if \(mcpEdit === editing\) endMcpEdit\(\);/);
});
