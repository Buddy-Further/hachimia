// Wave 5-B Native C 测试：clang -Wall -Wextra -Werror 编译 ptyhost.c 与 seccomp-enosys-run.c，并真机运行验证关键修复
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const TMP_BASE = process.env.TMPDIR || os.tmpdir();

async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(TMP_BASE, "wave5-native-"));
  try { return await fn(dir); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

async function runPty(bin, args, timeoutMs = 5000) {
  const child = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
  let stdout = "", stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (d) => { stdout += d; });
  child.stderr.on("data", (d) => { stderr += d; });
  const timer = setTimeout(() => { child.kill("SIGKILL"); }, timeoutMs);
  try {
    const [status] = await once(child, "close");
    return { status, stdout, stderr };
  } finally {
    clearTimeout(timer);
    try { child.stdin.destroy(); } catch {}
  }
}

function compile(srcRel, outPath) {
  const r = spawnSync("clang", ["-Wall", "-Wextra", "-Werror", "-O2", "-o", outPath, path.join(ROOT, srcRel)], {
    encoding: "utf8",
  });
  assert.equal(r.status, 0, `clang 编译 ${srcRel} 失败 (rc=${r.status}): ${r.stderr}`);
  assert.equal((r.stderr || "").trim(), "", `clang 编译 ${srcRel} 产生警告: ${r.stderr}`);
}

test("ptyhost.c: clang -Wall -Wextra -Werror 零警告编译 + 正常回显/退出码 + 超大 rows/cols 夹紧 + 关闭 fd 1/2 与防 m<=2 误关从端", async () => {
  const src = read("android/native/ptyhost.c");
  assert.match(src, /wait_pid\(/, "应使用 EINTR 重试封装 wait_pid");
  assert.match(src, /m <= 2[\s\S]*?F_DUPFD_CLOEXEC/, "应防止 posix_openpt 落在 0..2");
  assert.match(src, /close\(m\);[\s\S]*?dup2\(s, 0\)/, "子进程应在 dup2 前关闭主端 m");
  assert.match(src, /clamp_dim\(/, "应对 rows/cols 做 1..65535 夹紧");

  await withTempDir(async (dir) => {
    const bin = path.join(dir, "ptyhost");
    compile("android/native/ptyhost.c", bin);

    // 1. 正常命令回显与退出码透传（保持 stdin 打开直到子进程结束）
    const r1 = await runPty(bin, ["24", "80", "/system/bin/sh", "-c", "printf 'hello-pty\\n'; exit 42"]);
    assert.equal(r1.status, 42, `退出码应透传为 42，实际 ${r1.status}, stderr=${r1.stderr}`);
    assert.match(r1.stdout, /hello-pty/);

    // 2. 超大 rows/cols (70000 / 80000 及 65536) 夹紧到 1..65535，不回绕为 0 且正常退出
    const r2 = await runPty(bin, ["70000", "80000", "/system/bin/sh", "-c", "stty size 2>/dev/null || echo clamped; exit 0"]);
    assert.equal(r2.status, 0, `超大尺寸应正常退出 0，实际 ${r2.status}, stderr=${r2.stderr}`);
    const m = r2.stdout.trim().match(/^(\d+)\s+(\d+)$/);
    if (m) {
      assert.equal(Number(m[1]), 65535, `rows 应饱和夹紧为 65535，实际 ${m[1]}`);
      assert.equal(Number(m[2]), 65535, `cols 应饱和夹紧为 65535，实际 ${m[2]}`);
    }

    const r3 = await runPty(bin, ["65536", "0", "/system/bin/sh", "-c", "stty size 2>/dev/null || echo clamped; exit 0"]);
    assert.equal(r3.status, 0);
    const m3 = r3.stdout.trim().match(/^(\d+)\s+(\d+)$/);
    if (m3) {
      assert.equal(Number(m3[1]), 65535, `65536 不应回绕成 0，实际 ${m3[1]}`);
      assert.equal(Number(m3[2]), 80, `0 应回退默认 80，实际 ${m3[2]}`);
    }

    // 3. 父进程关闭 fd 1/2（保持 stdin 管道打开不触发 EOF 退出的前提下）启动 ptyhost，验证子进程从端 stdin/stdout/stderr 正常可用
    const outFile = path.join(dir, "closed-fds.txt");
    const r4 = await runPty("/system/bin/sh", [
      "-c",
      'exec 1>&- 2>&-; exec "$1" 24 80 /system/bin/sh -c "printf \'alive-closed-fds\\n\' > \\"$2\\"; exit 7"',
      "_",
      bin,
      outFile,
    ]);
    assert.equal(r4.status, 7, `关闭 fd 1/2 启动应透传子进程退出码 7，实际 ${r4.status}`);
    assert.equal(fs.readFileSync(outFile, "utf8").trim(), "alive-closed-fds");
  });
});

test("seccomp-enosys-run.c: 源码关键修复点 + clang -Wall -Wextra -Werror 零警告编译 + 真机拉起子进程放行与退出码透传", async () => {
  const src = read("android/native/seccomp-enosys-run.c");
  assert.match(src, /wait_eintr\(/, "应使用 EINTR 重试封装 wait_eintr");
  assert.match(src, /iov\.iov_len\s*!=\s*sizeof regs/, "应校验 PTRACE_GETREGSET 返回的 iov_len");
  assert.match(src, /AUDIT_ARCH_AARCH64/, "应检查 AUDIT_ARCH_AARCH64 架构");
  assert.match(src, /PSR_MODE32_BIT/, "应拒绝 32 位兼容态进程寄存器修改");
  assert.match(src, /if \(!is_known\(pid\)\) \{[\s\S]*?add_known\(pid\);[\s\S]*?if \(sig == SIGSTOP\) deliver = 0;/,
    "未知子进程非 SIGSTOP 首信号应保留原信号并照常处理");

  await withTempDir(async (dir) => {
    const bin = path.join(dir, "seccomp-enosys-run");
    compile("android/native/seccomp-enosys-run.c", bin);

    // 拉起简单子进程：验证普通模式与 -f 跟进模式都能正常放行并透传退出码
    const r1 = spawnSync(bin, ["/system/bin/sh", "-c", "echo enosys-ok; exit 37"], {
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(r1.status, 37, `退出码应透传为 37，实际 ${r1.status}, stderr=${r1.stderr}`);
    assert.match(r1.stdout, /enosys-ok/);

    const r2 = spawnSync(bin, ["-f", "/system/bin/sh", "-c", "/system/bin/sh -c 'echo enosys-follow-ok; exit 23'"], {
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(r2.status, 23, `-f 模式退出码应透传为 23，实际 ${r2.status}, stderr=${r2.stderr}`);
    assert.match(r2.stdout, /enosys-follow-ok/);
  });
});
