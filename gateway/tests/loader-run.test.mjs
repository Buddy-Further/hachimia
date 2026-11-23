import "../gw/config.mjs";
import { test, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { agyEnv, ensureLoaderBin } from "../gw/claude.mjs";
import { loginBrowserEnv } from "../gw/login.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "loader-run-test-"));
after(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

test("ensureLoaderBin：仅在 CCAPP_EXEC=loader 且 libccrun.so 存在时生成软链，并随目标变更自动刷新", () => {
  const fakeRun1 = path.join(tmpDir, "libccrun-v1.so");
  const fakeRun2 = path.join(tmpDir, "libccrun-v2.so");
  const loaderBin = path.join(tmpDir, "loader-bin");
  const extraBin = path.join(tmpDir, "extra-bin");
  fs.writeFileSync(fakeRun1, "#!/bin/sh\n", { mode: 0o755 });
  fs.writeFileSync(fakeRun2, "#!/bin/sh\n", { mode: 0o755 });
  fs.mkdirSync(extraBin, { recursive: true });
  fs.writeFileSync(path.join(extraBin, "mytool"), "#!/bin/sh\n", { mode: 0o755 });

  // direct 模式下不创建跳板目录
  assert.equal(ensureLoaderBin({ CCAPP_EXEC: "direct", CCAPP_LOADER_RUN: fakeRun1, CCAPP_LOADER_BIN: loaderBin }), "");
  assert.ok(!fs.existsSync(loaderBin));

  // loader 模式下为核心命令及 extraDirs 建软链
  const got1 = ensureLoaderBin(
    { CCAPP_EXEC: "loader", CCAPP_LOADER_RUN: fakeRun1, CCAPP_LOADER_BIN: loaderBin },
    { extraDirs: [extraBin] }
  );
  assert.equal(got1, loaderBin);
  assert.equal(fs.readlinkSync(path.join(loaderBin, "bash")), fakeRun1);
  assert.equal(fs.readlinkSync(path.join(loaderBin, "xdg-open")), fakeRun1);
  assert.equal(fs.readlinkSync(path.join(loaderBin, "mytool")), fakeRun1);

  // APK 升级导致 nativeLibraryDir 路径变化时，软链目标自动刷新到新路径
  const got2 = ensureLoaderBin(
    { CCAPP_EXEC: "loader", CCAPP_LOADER_RUN: fakeRun2, CCAPP_LOADER_BIN: loaderBin },
    { extraDirs: [extraBin] }
  );
  assert.equal(got2, loaderBin);
  assert.equal(fs.readlinkSync(path.join(loaderBin, "bash")), fakeRun2);
  assert.equal(fs.readlinkSync(path.join(loaderBin, "mytool")), fakeRun2);
});

test("agyEnv 与 loginBrowserEnv：loader 模式下把 loader-bin 挂在 PATH 首位且 SHELL 指向 loader-bin/bash", () => {
  const fakeRun = path.join(tmpDir, "libccrun-env.so");
  const loaderBin = path.join(tmpDir, "loader-bin-env");
  fs.writeFileSync(fakeRun, "#!/bin/sh\n", { mode: 0o755 });

  const prevExec = process.env.CCAPP_EXEC;
  const prevRun = process.env.CCAPP_LOADER_RUN;
  const prevBin = process.env.CCAPP_LOADER_BIN;
  const prevShell = process.env.CCAPP_SHELL;
  try {
    process.env.CCAPP_EXEC = "loader";
    process.env.CCAPP_LOADER_RUN = fakeRun;
    process.env.CCAPP_LOADER_BIN = loaderBin;
    process.env.CCAPP_SHELL = "/fake/usr/bin/bash";

    const env = agyEnv({ sync: false });
    assert.equal(env.SHELL, path.join(loaderBin, "bash"));
    assert.equal(env.CCAPP_SHELL, "/fake/usr/bin/bash");
    assert.equal(env.PATH.split(":")[0], loaderBin);

    const loginDir = path.join(tmpDir, "login");
    const browser = path.join(loginDir, "browser.sh");
    fs.mkdirSync(loginDir, { recursive: true });
    fs.writeFileSync(browser, "#!/bin/sh\necho \"$1\"\n", { mode: 0o700 });
    const lenv = loginBrowserEnv(env, loginDir, browser);
    const ldirs = lenv.PATH.split(":");
    assert.equal(ldirs[0], loaderBin, "loader 模式下 loader-bin 必须仍在首位供 Go 直接 exec");
    assert.equal(ldirs[1], path.join(loginDir, "bin"), "登录垫片目录应紧随 loader-bin 之后");
  } finally {
    if (prevExec === undefined) delete process.env.CCAPP_EXEC; else process.env.CCAPP_EXEC = prevExec;
    if (prevRun === undefined) delete process.env.CCAPP_LOADER_RUN; else process.env.CCAPP_LOADER_RUN = prevRun;
    if (prevBin === undefined) delete process.env.CCAPP_LOADER_BIN; else process.env.CCAPP_LOADER_BIN = prevBin;
    if (prevShell === undefined) delete process.env.CCAPP_SHELL; else process.env.CCAPP_SHELL = prevShell;
  }
});

test("loader-run.c：编译后通过软链运行真实 bash、脚本与环境清理（剥离 loader-bin、还原 SHELL）", (t) => {
  const cc = fs.existsSync(path.join(os.homedir(), ".bldtools", "cc4"))
    ? path.join(os.homedir(), ".bldtools", "cc4")
    : "clang";
  const probe = spawnSync(cc, ["--version"], { encoding: "utf8" });
  if (probe.status !== 0) {
    t.skip("无可用 C 编译器");
    return;
  }

  const binPath = path.join(tmpDir, "libccrun.so");
  const srcPath = path.join(root, "android", "native", "loader-run.c");
  const comp = spawnSync(cc, ["-O2", "-Wall", "-Wextra", "-o", binPath, srcPath], { encoding: "utf8" });
  assert.equal(comp.status, 0, `编译 loader-run.c 失败:\n${comp.stderr}`);

  const lbin = path.join(tmpDir, "lbin");
  const realBin = path.join(tmpDir, "rbin");
  fs.mkdirSync(lbin, { recursive: true });
  fs.mkdirSync(realBin, { recursive: true });
  fs.symlinkSync(binPath, path.join(lbin, "bash"));
  fs.symlinkSync(binPath, path.join(lbin, "demo-script"));

  const sysSh = fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh";
  const realBash = process.env.PREFIX && fs.existsSync(path.join(process.env.PREFIX, "bin", "bash"))
    ? path.join(process.env.PREFIX, "bin", "bash")
    : (fs.existsSync("/bin/bash") ? "/bin/bash" : sysSh);
  fs.writeFileSync(path.join(realBin, "demo-script"), `#!${sysSh}\necho "SCRIPT:$1:$PATH:$SHELL"\n`, { mode: 0o755 });

  const runEnv = {
    ...process.env,
    CCAPP_EXEC: fs.existsSync("/system/bin/linker64") ? "loader" : "direct",
    CCAPP_LOADER_RUN: binPath,
    CCAPP_LOADER_BIN: lbin,
    CCAPP_SHELL: realBash,
    SHELL: path.join(lbin, "bash"),
    PATH: `${lbin}:${realBin}:${path.dirname(realBash)}:/system/bin:/usr/bin:/bin`,
  };

  // 1) 通过 loader-bin/bash 软链执行命令：子进程应看到剥离 loader-bin 后的 PATH 与还原后的 SHELL
  const r1 = spawnSync(path.join(lbin, "bash"), ["-c", 'printf "OK|%s|%s" "$SHELL" "$PATH"'], {
    env: runEnv,
    encoding: "utf8",
  });
  assert.equal(r1.status, 0, `bash 执行失败: stderr=${r1.stderr}`);
  assert.ok(r1.stdout.startsWith(`OK|${realBash}|`), `SHELL 未还原: ${r1.stdout}`);
  assert.ok(!r1.stdout.includes(lbin), `PATH 未剥离 loader-bin: ${r1.stdout}`);

  // 2) 通过 loader-bin/demo-script 软链执行 #! 脚本
  const r2 = spawnSync(path.join(lbin, "demo-script"), ["hello"], {
    env: runEnv,
    encoding: "utf8",
  });
  assert.equal(r2.status, 0, `demo-script 执行失败: stderr=${r2.stderr}`);
  assert.ok(r2.stdout.startsWith("SCRIPT:hello:"), `输出不符: ${r2.stdout}`);
  assert.ok(!r2.stdout.includes(lbin), `脚本 PATH 未剥离 loader-bin: ${r2.stdout}`);

  // 3) 直接以 libccrun.so 名字调用（模拟 caller 对 SHELL 做了 realpath/EvalSymlinks）仍回落到 bash
  const r3 = spawnSync(binPath, ["-c", "echo FALLBACK_OK"], {
    env: runEnv,
    encoding: "utf8",
  });
  assert.equal(r3.status, 0, `libccrun.so 回落 bash 失败: stderr=${r3.stderr}`);
  assert.equal(r3.stdout.trim(), "FALLBACK_OK");
});
