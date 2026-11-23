package ha.chi.mia;

import java.io.IOException;
import java.net.ServerSocket;

/**
 * G1/A6：GatewayService.squatted() 第二轮清扫只凭 CCAPP_TOKEN_FILE 环境变量就 SIGKILL，
 * 正在安装 agy 的子进程（install-agy.sh / 下载）也会被杀，安装失败 rc=137（agycodroid 1.0.2 同类事故原样重现）。
 * 修复方向：清扫准入必须同时有端口证据——候选进程占着网关端口（/proc/net/tcp{,6} + /proc/<pid>/fd），
 * 且 cmdline 不是安装子进程；只带标记、不占端口的进程（安装子进程、网关后代）一律不碰。
 * 纯逻辑回归：用安卓桩（android.jar）编译运行，不碰安卓运行时；端口证据在 JVM 上用真实 ServerSocket 验。
 */
public class GatewaySquattedTest {
    static int fail = 0;
    static void eq(String what, boolean got, boolean want) {
        boolean ok = got == want;
        if (!ok) fail++;
        System.out.println((ok ? "✓ " : "✗ ") + what + "（得到 " + got + "，期望 " + want + "）");
    }

    public static void main(String[] a) throws IOException {
        // ── 安装子进程的 cmdline：认得出来就挡一道 ──
        eq("G1 install-agy.sh 是安装子进程",
            GatewayService.isInstallerCmd("bash /data/usr/bin/install-agy.sh --yes"), true);
        eq("G1 install-agy.mjs --check 是安装子进程",
            GatewayService.isInstallerCmd("node /data/usr/bin/install-agy.mjs --check"), true);
        eq("G1 install-claude.mjs 是安装子进程",
            GatewayService.isInstallerCmd("node /data/usr/bin/install-claude.mjs"), true);
        eq("G1 网关本体不是安装子进程",
            GatewayService.isInstallerCmd("node --input-type=module -e /data/files/app 9793"), false);
        eq("G1 claude 子进程不是安装子进程",
            GatewayService.isInstallerCmd("node /data/usr/bin/claude.mjs"), false);

        // ── 清扫准入：标记 + 占端口 + 非安装，三者缺一不可 ──
        eq("G1 标记+占端口+非安装：可清扫（冒牌网关）",
            GatewayService.squattableLeftover(true, true, "node /tmp/evil-gw.mjs"), true);
        eq("G1 只带标记、不占端口：不可清扫（安装子进程/网关后代）",
            GatewayService.squattableLeftover(true, false, "bash /data/usr/bin/install-agy.sh"), false);
        eq("G1 占端口但 cmdline 是安装子进程：不可清扫（安装器万一起本地服务也不杀）",
            GatewayService.squattableLeftover(true, true, "bash /data/usr/bin/install-agy.sh"), false);
        eq("G1 占端口但没带标记：不可清扫（别的应用，别碰）",
            GatewayService.squattableLeftover(false, true, "node /tmp/other.mjs"), false);
        eq("G1 既无标记又不占端口：不可清扫",
            GatewayService.squattableLeftover(false, false, "node /tmp/other.mjs"), false);

        // ── 端口解析纯逻辑（Android 10+ 真机 SELinux 禁止 untrusted_app 读 /proc/net/tcp{,6}，样本解析两端必跑）──
        java.util.Set<String> parsed = new java.util.HashSet<>();
        GatewayService.parseListenSocketInodes(java.util.Arrays.asList(
            "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode",
            "   0: 0100007F:2641 00000000:0000 0A 00000000:00000000 00:00000000 00000000 10305        0 11111 1 00000000",
            "   1: 0100007F:2641 0100007F:9999 01 00000000:00000000 00:00000000 00000000 10305        0 22222 1 00000000"
        ), false, 9793, parsed);
        GatewayService.parseListenSocketInodes(java.util.Arrays.asList(
            "   0: 0000000000000000FFFF00000200007F:2641 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000 10305        0 33333 1 00000000"
        ), true, 9793, parsed);
        eq("G1 /proc/net/tcp{,6} 解析：命中 127.0.0.1 LISTEN 与 ::ffff:127.0.0.2 LISTEN，排除 ESTABLISHED",
            parsed.contains("socket:[11111]") && parsed.contains("socket:[33333]") && !parsed.contains("socket:[22222]"), true);

        // ── 端口证据（真 socket）：宿主机允许读 /proc/net/tcp{,6} 时（桌面 CI）跑端到端断言 ──
        boolean procNetReadable = java.nio.file.Files.isReadable(java.nio.file.Paths.get("/proc/net/tcp"))
            || java.nio.file.Files.isReadable(java.nio.file.Paths.get("/proc/net/tcp6"));
        if (procNetReadable) {
            long pid = ProcessHandle.current().pid();
            try (ServerSocket ss = new ServerSocket(0, 50, java.net.InetAddress.getByName("127.0.0.1"))) {
                int port = ss.getLocalPort();
                eq("G1 本进程监听 127.0.0.1 端口：端口证据为真",
                    GatewayService.holdsGatewayPort((int) pid, port), true);
                eq("G1 本进程没监听的端口：端口证据为假",
                    GatewayService.holdsGatewayPort((int) pid, port == 1 ? 2 : 1), false);
            }
        }

        if (fail > 0) { System.out.println(fail + " 条失败"); System.exit(1); }
        System.out.println("全部通过");
    }
}
