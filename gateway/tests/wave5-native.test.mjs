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

    // 4. 在进入 ptyhost main() 前真实关闭 fd 0（及 fd 0/1/2）：绕开 Android bionic CRT 启动前对 0/1/2 自动补 /dev/null 的机制，
    //    确保真机与 Linux CI 上都真正命中 m == 0 (m <= 2 -> F_DUPFD_CLOEXEC)、in_open == 0 与子进程 s == 0 路径
    const wrapC = path.join(dir, "ptyhost_closed0.c");
    const wrapBin = path.join(dir, "ptyhost_closed0");
    fs.writeFileSync(wrapC, `
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#define main ptyhost_main
#include "${path.join(ROOT, "android/native/ptyhost.c").replace(/\\/g, "\\\\")}"
#undef main

int main(int argc, char **argv) {
  if (argc < 2) return 2;
  if (strcmp(argv[1], "close0") == 0) {
    close(0);
  } else if (strcmp(argv[1], "close012") == 0) {
    close(0); close(1); close(2);
  } else {
    return 2;
  }
  return ptyhost_main(argc - 1, argv + 1);
}
`);
    const cw = spawnSync("clang", ["-Wall", "-Wextra", "-Werror", "-O2", "-o", wrapBin, wrapC], { encoding: "utf8" });
    assert.equal(cw.status, 0, `编译 ptyhost_closed0 失败: ${cw.stderr}`);

    const r5 = await runPty(wrapBin, ["close0", "24", "80", "/system/bin/sh", "-c", "printf 'fd0-closed-ok\\n'; exit 9"]);
    assert.equal(r5.status, 9, `真实关闭 fd 0 启动应命中 m<=2 且透传退出码 9，实际 ${r5.status}, stderr=${r5.stderr}`);
    assert.match(r5.stdout, /fd0-closed-ok/);

    const outFile012 = path.join(dir, "closed-012.txt");
    const r6 = await runPty(wrapBin, ["close012", "24", "80", "/system/bin/sh", "-c", `printf 'all-012-closed\\n' > "${outFile012}"; exit 11`]);
    assert.equal(r6.status, 11, `真实关闭 fd 0/1/2 启动应透传退出码 11，实际 ${r6.status}`);
    assert.equal(fs.readFileSync(outFile012, "utf8").trim(), "all-012-closed");
  });
});

test("seccomp-enosys-run.c: 源码关键修复点 + clang -Wall -Wextra -Werror 零警告编译 + 真机拉起子进程放行与真实 SIGSYS 拦截", async () => {
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
    const shBin = fs.existsSync("/system/bin/sh") ? "/system/bin/sh" : "/bin/sh";
    const r1 = spawnSync(bin, [shBin, "-c", "echo enosys-ok; exit 37"], {
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(r1.status, 37, `退出码应透传为 37，实际 ${r1.status}, stderr=${r1.stderr}`);
    assert.match(r1.stdout, /enosys-ok/);

    const r2 = spawnSync(bin, ["-f", shBin, "-c", `${shBin} -c 'echo enosys-follow-ok; exit 23'`], {
      encoding: "utf8",
      timeout: 5000,
    });
    assert.equal(r2.status, 23, `-f 模式退出码应透传为 23，实际 ${r2.status}, stderr=${r2.stderr}`);
    assert.match(r2.stdout, /enosys-follow-ok/);

    // 真实 SIGSYS 拦截测试：安装 BPF 过滤器对 SYS_getpid 触发 SECCOMP_RET_TRAP (data=0 / data=1)
    const probeC = path.join(dir, "sigsys_probe.c");
    const probeBin = path.join(dir, "sigsys_probe");
    fs.writeFileSync(probeC, `
#include <errno.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <stddef.h>
#include <stdio.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

int main(int argc, char **argv) {
  unsigned int ret_val = SECCOMP_RET_TRAP;
  if (argc > 1 && strcmp(argv[1], "trap1") == 0) ret_val = SECCOMP_RET_TRAP | 1u;
  struct sock_filter filter[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, (unsigned int)offsetof(struct seccomp_data, nr)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, (unsigned int)SYS_getpid, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, ret_val),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog prog = {
    .len = (unsigned short)(sizeof(filter) / sizeof(filter[0])),
    .filter = filter,
  };
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) != 0) { perror("no_new_privs"); return 2; }
  if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &prog) != 0) { perror("seccomp"); return 3; }
  errno = 0;
  long r = syscall(SYS_getpid);
  if (r == -1 && errno == ENOSYS) {
    static const char msg[] = "SIGSYS_TO_ENOSYS_OK\\n";
    (void)write(1, msg, sizeof(msg) - 1);
    _exit(0);
  }
  _exit(4);
}
`);
    const pc = spawnSync("clang", ["-Wall", "-Wextra", "-Werror", "-O2", "-o", probeBin, probeC], { encoding: "utf8" });
    assert.equal(pc.status, 0, `编译 sigsys_probe 失败: ${pc.stderr}`);

    if (process.arch === "arm64") {
      // 1) SECCOMP_RET_TRAP|0（模拟安卓过滤器）必须被改写为 -ENOSYS 并正常退出 0
      const rs0 = spawnSync(bin, ["-v", probeBin, "trap0"], { encoding: "utf8", timeout: 5000 });
      assert.equal(rs0.status, 0, `arm64 SIGSYS(data=0) 应转为 ENOSYS，实际 rc=${rs0.status}, stderr=${rs0.stderr}`);
      assert.match(rs0.stdout, /SIGSYS_TO_ENOSYS_OK/);
      assert.match(rs0.stderr, /拦下 syscall \d+ → ENOSYS/);

      // 2) -f 跟进模式：子进程 fork/exec 后的孙进程触发 SIGSYS 也必须被改写为 -ENOSYS
      const rsf = spawnSync(bin, ["-f", "-v", shBin, "-c", `"$1" trap0`, "_", probeBin], { encoding: "utf8", timeout: 5000 });
      assert.equal(rsf.status, 0, `-f 跟进子进程 SIGSYS(data=0) 应转为 ENOSYS，实际 rc=${rsf.status}, stderr=${rsf.stderr}`);
      assert.match(rsf.stdout, /SIGSYS_TO_ENOSYS_OK/);

      // 3) SECCOMP_RET_TRAP|1（应用自带沙箱非零 data）：绝不能降级成 ENOSYS，必须原样投递 SIGSYS (128+31=159)
      const rs1 = spawnSync(bin, ["-v", probeBin, "trap1"], { encoding: "utf8", timeout: 5000 });
      assert.equal(rs1.status, 128 + 31, `非零 si_errno 的 SIGSYS 必须原样投递退出 159，实际 ${rs1.status}, stderr=${rs1.stderr}`);
    } else {
      // 非 arm64 架构（如 x86_64 CI）：架构校验拒绝改写寄存器，原样投递 SIGSYS (128+31=159)
      const rsx = spawnSync(bin, ["-v", probeBin, "trap0"], { encoding: "utf8", timeout: 5000 });
      assert.equal(rsx.status, 128 + 31, `非 arm64 架构不应改写寄存器，应原样投递 SIGSYS (159)，实际 ${rsx.status}`);
    }
  });
});
