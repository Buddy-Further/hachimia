package ha.chi.mia;

import java.io.File;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.security.MessageDigest;
import java.util.HashSet;
import java.util.Set;

/**
 * Wave 5-B Android Java 单元测试：
 *   - 9.2 POST_NOTIFICATIONS 前置请求判断与幂等去重
 *   - 9.3 Env.proofCacheFresh 单调钟缓存判断与源码单调钟检查
 *   - 9.4 A11y.shouldRecycleOnSdk / safeRecycle 边界与回收路径检查
 *   - 9.5 MainActivity.isLoopbackHost IPv6 全写/缩写/末尾点与 Camera.newFileInDir 去重
 *   - 9.6 ShizukuSetup.canUseFullScreen 降级与 Updater.isReadyApk / hasZipHeader 校验
 *   - 5.6 SysEvents.boundedWaitMs 封顶与源码 goAsync 超时上限检查
 */
public class Wave5AndroidTest {
    static int fail = 0;

    static void check(String name, boolean ok) {
        if (!ok) fail++;
        System.out.println((ok ? "✓ " : "✗ ") + name);
    }

    static void eq(String name, boolean got, boolean want) {
        boolean ok = got == want;
        if (!ok) fail++;
        System.out.println((ok ? "✓ " : "✗ ") + name + "（得到 " + got + "，期望 " + want + "）");
    }

    static void eql(String name, long got, long want) {
        boolean ok = got == want;
        if (!ok) fail++;
        System.out.println((ok ? "✓ " : "✗ ") + name + "（得到 " + got + "，期望 " + want + "）");
    }

    private static String sha256Hex(byte[] data) throws Exception {
        byte[] d = MessageDigest.getInstance("SHA-256").digest(data);
        StringBuilder sb = new StringBuilder();
        for (byte b : d) sb.append(String.format("%02x", b & 0xff));
        return sb.toString();
    }

    private static String readSrc(String rel) throws Exception {
        Path p = Paths.get(rel);
        if (!Files.exists(p)) p = Paths.get("android/java/ha/chi/mia").resolve(rel);
        return new String(Files.readAllBytes(p), StandardCharsets.UTF_8);
    }

    public static void main(String[] args) throws Exception {
        // ── 9.5 MainActivity.isLoopbackHost ──
        eq("isLoopbackHost 放行 localhost", MainActivity.isLoopbackHost("localhost"), true);
        eq("isLoopbackHost 放行 localhost.", MainActivity.isLoopbackHost("localhost."), true);
        eq("isLoopbackHost 放行 LOCALHOST.", MainActivity.isLoopbackHost("LOCALHOST."), true);
        eq("isLoopbackHost 放行 127.0.0.1", MainActivity.isLoopbackHost("127.0.0.1"), true);
        eq("isLoopbackHost 放行 ::1", MainActivity.isLoopbackHost("::1"), true);
        eq("isLoopbackHost 放行 [::1]", MainActivity.isLoopbackHost("[::1]"), true);
        eq("isLoopbackHost 放行 [0:0:0:0:0:0:0:1]", MainActivity.isLoopbackHost("[0:0:0:0:0:0:0:1]"), true);
        eq("isLoopbackHost 放行 [0000:0000:0000:0000:0000:0000:0000:0001]",
            MainActivity.isLoopbackHost("[0000:0000:0000:0000:0000:0000:0000:0001]"), true);
        eq("isLoopbackHost 放行 [::0:1]", MainActivity.isLoopbackHost("[::0:1]"), true);
        eq("isLoopbackHost 放行 [0::1]", MainActivity.isLoopbackHost("[0::1]"), true);
        eq("isLoopbackHost 放行 [::ffff:127.0.0.1]", MainActivity.isLoopbackHost("[::ffff:127.0.0.1]"), true);
        eq("isLoopbackHost 放行 ::ffff:7f00:1", MainActivity.isLoopbackHost("::ffff:7f00:1"), true);

        eq("isLoopbackHost 拒绝 [::2]", MainActivity.isLoopbackHost("[::2]"), false);
        eq("isLoopbackHost 拒绝 ::", MainActivity.isLoopbackHost("::"), false);
        eq("isLoopbackHost 拒绝 evil.localhost", MainActivity.isLoopbackHost("evil.localhost"), false);
        eq("isLoopbackHost 拒绝 127.0.0.2", MainActivity.isLoopbackHost("127.0.0.2"), false);
        eq("isLoopbackHost 拒绝 [::ffff:127.0.0.2]", MainActivity.isLoopbackHost("[::ffff:127.0.0.2]"), false);
        eq("isLoopbackHost 拒绝 [::ffff:8.8.8.8]", MainActivity.isLoopbackHost("[::ffff:8.8.8.8]"), false);
        eq("isLoopbackHost 拒绝 [1::1]", MainActivity.isLoopbackHost("[1::1]"), false);
        eq("isLoopbackHost 拒绝畸形 :::1", MainActivity.isLoopbackHost(":::1"), false);
        eq("isLoopbackHost 拒绝未闭合括号 [::1", MainActivity.isLoopbackHost("[::1"), false);
        eq("isLoopbackHost 拒绝 null", MainActivity.isLoopbackHost(null), false);
        eq("isLoopbackHost 拒绝空串", MainActivity.isLoopbackHost(""), false);

        // ── P3: MainActivity.isUiHost / isUiHostDot2 走 parseIpv6 全写/缩写 IPv4-mapped ──
        eq("isUiHostDot2 放行 127.0.0.2", MainActivity.isUiHostDot2("127.0.0.2"), true);
        eq("isUiHostDot2 放行 127.2", MainActivity.isUiHostDot2("127.2"), true);
        eq("isUiHostDot2 放行 0x7f000002", MainActivity.isUiHostDot2("0x7f000002"), true);
        eq("isUiHostDot2 放行 [::ffff:127.0.0.2]", MainActivity.isUiHostDot2("[::ffff:127.0.0.2]"), true);
        eq("isUiHostDot2 放行 ::ffff:127.0.0.2", MainActivity.isUiHostDot2("::ffff:127.0.0.2"), true);
        eq("isUiHostDot2 放行全写 [0:0:0:0:0:ffff:127.0.0.2]", MainActivity.isUiHostDot2("[0:0:0:0:0:ffff:127.0.0.2]"), true);
        eq("isUiHostDot2 放行全写 [0000:0000:0000:0000:0000:ffff:7f00:0002]",
            MainActivity.isUiHostDot2("[0000:0000:0000:0000:0000:ffff:7f00:0002]"), true);
        eq("isUiHostDot2 放行 [::ffff:7f00:2]", MainActivity.isUiHostDot2("[::ffff:7f00:2]"), true);
        eq("isUiHostDot2 放行 [::ffff:127.2]", MainActivity.isUiHostDot2("[::ffff:127.2]"), true);
        eq("isUiHostDot2 拒绝 [::ffff:127.0.0.1]", MainActivity.isUiHostDot2("[::ffff:127.0.0.1]"), false);
        eq("isUiHostDot2 拒绝 [::ffff:127.0.0.3]", MainActivity.isUiHostDot2("[::ffff:127.0.0.3]"), false);
        eq("isUiHostDot2 拒绝 [::1]", MainActivity.isUiHostDot2("[::1]"), false);
        eq("isUiHostDot2 拒绝未闭合括号 [::ffff:127.0.0.2", MainActivity.isUiHostDot2("[::ffff:127.0.0.2"), false);
        eq("isUiHost 匹配默认 Env.HOST 全写 IPv6", MainActivity.isUiHost("[0:0:0:0:0:ffff:127.0.0.2]"),
            !"127.0.0.1".equals(Env.HOST));

        // ── 9.5 Camera.newFileInDir 连续创建不重名 ──
        Path camTmp = Files.createTempDirectory("wave5-cam");
        Set<String> names = new HashSet<>();
        for (int i = 0; i < 8; i++) {
            File f = Camera.newFileInDir(camTmp.toFile());
            check("Camera.newFileInDir 文件已创建且唯一 #" + i, f.isFile() && names.add(f.getName()));
        }
        for (File f : camTmp.toFile().listFiles()) f.delete();
        camTmp.toFile().delete();

        // ── 9.2 POST_NOTIFICATIONS 前置请求判断 ──
        eq("notifyPerm API33+ target33+ 未授未问：应请求",
            MainActivity.shouldRequestNotifyPerm(33, 33, false, false, false), true);
        eq("notifyPerm API36 target36 未授未问：应请求",
            MainActivity.shouldRequestNotifyPerm(36, 36, false, false, false), true);
        eq("notifyPerm 已授权：不请求",
            MainActivity.shouldRequestNotifyPerm(36, 36, true, false, false), false);
        eq("notifyPerm 本会话已请求过：不重复请求",
            MainActivity.shouldRequestNotifyPerm(36, 36, false, true, false), false);
        eq("notifyPerm 历史已请求过：不重复请求",
            MainActivity.shouldRequestNotifyPerm(36, 36, false, false, true), false);
        eq("notifyPerm targetSdk28：不请求",
            MainActivity.shouldRequestNotifyPerm(36, 28, false, false, false), false);
        eq("notifyPerm API32：不请求",
            MainActivity.shouldRequestNotifyPerm(32, 33, false, false, false), false);

        // ── 9.3 单调钟行为测试（Env.proofCacheFresh / Installer.Slow / GatewayService / ShizukuSetup / A11y） ──
        eq("proofCacheFresh 有效期内命中", Env.proofCacheFresh(false, "abc", 1000L, 3999L), true);
        eq("proofCacheFresh 超 3000ms 过期", Env.proofCacheFresh(false, "abc", 1000L, 4000L), false);
        eq("proofCacheFresh force=true 绕过缓存", Env.proofCacheFresh(true, "abc", 1000L, 1100L), false);
        eq("proofCacheFresh now < provedAt 拒绝", Env.proofCacheFresh(false, "abc", 1000L, 900L), false);
        eq("proofCacheFresh boot 为空拒绝", Env.proofCacheFresh(false, "", 1000L, 1100L), false);
        eq("proofCacheFresh provedAt=0 拒绝", Env.proofCacheFresh(false, "abc", 0L, 1100L), false);

        // Installer.Slow 行为实测：窗口内不报错、达标重置窗口、低速抛 SlowException
        Installer.Slow slow = new Installer.Slow(10_000L);
        slow.add(300 << 10, 20_000L);
        slow.add(350 << 10, 40_000L); // 650 KB >= 600 KB -> 窗口重置
        check("Installer.Slow 达标后重置窗口", slow.t0 == 40_000L && slow.n == 0);
        boolean slowThrew = false;
        try {
            slow.add(100 << 10, 55_000L);
            slow.add(100 << 10, 70_000L); // 200 KB < 600 KB over 30s -> SlowException
        } catch (Installer.SlowException expected) {
            slowThrew = true;
        }
        check("Installer.Slow 30 秒低于 600KB 抛 SlowException", slowThrew);

        // GatewayService.shouldFetchGwRuntime & ShizukuSetup.pairCheckCooldownActive & A11y.idleExpired
        eq("GatewayService 首次(lastFetchAt=-1)即使刚开机也允许拉取",
            GatewayService.shouldFetchGwRuntime(-1L, 1_000L), true);
        eq("GatewayService 30 分钟冷却内跳过",
            GatewayService.shouldFetchGwRuntime(1_000L, 1_000L + 29 * 60_000L), false);
        eq("GatewayService 超过 30 分钟重新拉取",
            GatewayService.shouldFetchGwRuntime(1_000L, 1_000L + 30 * 60_000L + 1L), true);
        eq("ShizukuSetup 首次(checkedAt=-1)即使刚开机也不受冷却限制",
            ShizukuSetup.pairCheckCooldownActive(-1L, 1_000L), false);
        eq("ShizukuSetup 5 分钟冷却内拦截",
            ShizukuSetup.pairCheckCooldownActive(1_000L, 1_000L + 4 * 60_000L), true);
        eq("ShizukuSetup 满 5 分钟放行",
            ShizukuSetup.pairCheckCooldownActive(1_000L, 1_000L + 5 * 60_000L), false);
        eq("A11y.idleExpired 未超时不关闭", A11y.idleExpired(5_000L, 5_000L + 10 * 60_000L, 10), false);
        eq("A11y.idleExpired 超时触发关闭", A11y.idleExpired(5_000L, 5_000L + 10 * 60_000L + 1L, 10), true);

        String gwSrc = readSrc("android/java/ha/chi/mia/GatewayService.java");
        check("GatewayService frozenAt 保留持久化墙钟 currentTimeMillis",
            gwSrc.contains("putLong(\"frozenAt\", System.currentTimeMillis())"));

        // ── 9.4 A11y 回收行为实测（含逐级回溯与异常路径防泄漏） ──
        eq("A11y API28 需要回收", A11y.shouldRecycleOnSdk(28), true);
        eq("A11y API32 需要回收", A11y.shouldRecycleOnSdk(32), true);
        eq("A11y API33 不再回收", A11y.shouldRecycleOnSdk(33), false);
        eq("A11y API36 不再回收", A11y.shouldRecycleOnSdk(36), false);
        A11y.safeRecycle((android.view.accessibility.AccessibilityNodeInfo) null);
        A11y.safeRecycle((android.view.accessibility.AccessibilityWindowInfo) null);
        check("A11y null safeRecycle 不抛异常", true);

        java.util.Map<String, String> parentMap = new java.util.HashMap<>();
        parentMap.put("leaf", "mid");
        parentMap.put("mid", "root");
        java.util.List<String> recycled = new java.util.ArrayList<>();
        // 1) 命中起点：不回收起点
        eq("A11y.walkParentsAndRecycle 命中起点返回 true",
            A11y.walkParentsAndRecycle("leaf", parentMap::get, "leaf"::equals, recycled::add), true);
        check("A11y.walkParentsAndRecycle 命中起点不回收起点", recycled.isEmpty());
        // 2) 命中祖节点：mid 和 root 各回收 1 次，leaf 不回收
        recycled.clear();
        eq("A11y.walkParentsAndRecycle 命中祖节点返回 true",
            A11y.walkParentsAndRecycle("leaf", parentMap::get, "root"::equals, recycled::add), true);
        check("A11y.walkParentsAndRecycle 命中祖节点精确回收 mid+root 且不回收 leaf",
            recycled.equals(java.util.Arrays.asList("mid", "root")));
        // 3) 全部未命中：mid 和 root 各回收 1 次
        recycled.clear();
        eq("A11y.walkParentsAndRecycle 全部未命中返回 false",
            A11y.walkParentsAndRecycle("leaf", parentMap::get, x -> false, recycled::add), false);
        check("A11y.walkParentsAndRecycle 未命中仍回收所有中间父节点",
            recycled.equals(java.util.Arrays.asList("mid", "root")));
        // 4) 回调抛异常：finally 仍回收当前父节点
        recycled.clear();
        boolean walkThrew = false;
        try {
            A11y.walkParentsAndRecycle("leaf", parentMap::get, x -> {
                if ("mid".equals(x)) throw new RuntimeException("boom");
                return false;
            }, recycled::add);
        } catch (RuntimeException expected) {
            walkThrew = true;
        }
        check("A11y.walkParentsAndRecycle 异常路径仍由 finally 回收当前父节点",
            walkThrew && recycled.equals(java.util.Collections.singletonList("mid")));

        // ── 9.6 ShizukuSetup.canUseFullScreen ──
        eq("canUseFullScreen API33 放行", ShizukuSetup.canUseFullScreen(33, false), true);
        eq("canUseFullScreen API34 已授权放行", ShizukuSetup.canUseFullScreen(34, true), true);
        eq("canUseFullScreen API34 未授权降级", ShizukuSetup.canUseFullScreen(34, false), false);
        eq("canUseFullScreen API36 未授权降级", ShizukuSetup.canUseFullScreen(36, false), false);

        // ── 9.6 Updater.isReadyApk / hasZipHeader ──
        Path updTmp = Files.createTempDirectory("wave5-upd");
        byte[] validZip = new byte[] { 0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00 };
        byte[] badZip = new byte[] { 0x00, 0x00, 0x00, 0x00, 0x14, 0x00, 0x00, 0x00 };
        File validApk = new File(updTmp.toFile(), "valid.apk");
        File badApk = new File(updTmp.toFile(), "bad.apk");
        File emptyApk = new File(updTmp.toFile(), "empty.apk");
        Files.write(validApk.toPath(), validZip);
        Files.write(badApk.toPath(), badZip);
        Files.write(emptyApk.toPath(), new byte[0]);
        String validSha = sha256Hex(validZip);
        String badSha = sha256Hex(badZip);
        String wrongSha = "0000000000000000000000000000000000000000000000000000000000000000";

        eq("Updater.hasZipHeader 识别 PK\\x03\\x04", Updater.hasZipHeader(validApk), true);
        eq("Updater.hasZipHeader 拒绝非 ZIP 头", Updater.hasZipHeader(badApk), false);
        eq("Updater.hasZipHeader 拒绝空文件", Updater.hasZipHeader(emptyApk), false);
        eq("Updater.isReadyApk 长度+ZIP头+sha256全匹配返回 true",
            Updater.isReadyApk(validApk, validZip.length, validSha), true);
        eq("Updater.isReadyApk sha256 不匹配返回 false",
            Updater.isReadyApk(validApk, validZip.length, wrongSha), false);
        eq("Updater.isReadyApk 长度不匹配返回 false",
            Updater.isReadyApk(validApk, validZip.length + 1, validSha), false);
        eq("Updater.isReadyApk 非 ZIP 头即使 sha 匹配也返回 false",
            Updater.isReadyApk(badApk, badZip.length, badSha), false);
        eq("Updater.isReadyApk 无 sha 时验证非空+ZIP头返回 true",
            Updater.isReadyApk(validApk, validZip.length, null), true);
        eq("Updater.isReadyApk 无 sha 且非 ZIP 头返回 false",
            Updater.isReadyApk(badApk, badZip.length, null), false);
        eq("Updater.isReadyApk 期望长度 0 返回 false",
            Updater.isReadyApk(emptyApk, 0, null), false);
        validApk.delete(); badApk.delete(); emptyApk.delete(); updTmp.toFile().delete();

        // ── 5.6 SysEvents 超时上限 ──
        check("SysEvents REOPEN_BUDGET_MS <= 8000", SysEvents.REOPEN_BUDGET_MS > 0 && SysEvents.REOPEN_BUDGET_MS <= 8000L);
        eql("SysEvents boundedWaitMs 正常步长", SysEvents.boundedWaitMs(10000L, 8000L, 500L), 500L);
        eql("SysEvents boundedWaitMs 接近截止截断", SysEvents.boundedWaitMs(10000L, 9750L, 500L), 250L);
        eql("SysEvents boundedWaitMs 到点归零", SysEvents.boundedWaitMs(10000L, 10000L, 500L), 0L);
        eql("SysEvents boundedWaitMs 超时归零", SysEvents.boundedWaitMs(10000L, 10200L, 500L), 0L);

        // ── 9.1 MainActivity.computeEdgeInsets 边到边与挖孔安全区行为实测 ──
        int[] api30Web = MainActivity.computeEdgeInsets(35, 12, 88, 12, 48, 0, 0, 0, 0, 0, true);
        check("computeEdgeInsets API35 网页无输入法：底边转交 insetBot(--safe-b)",
            java.util.Arrays.equals(api30Web, new int[] { 12, 88, 12, 0, 48 }));
        int[] api30Ime = MainActivity.computeEdgeInsets(35, 12, 88, 12, 48, 0, 0, 0, 0, 620, true);
        check("computeEdgeInsets API35 网页弹输入法：padBot 取 max(ime,sysB) 且 insetBot 归零",
            java.util.Arrays.equals(api30Ime, new int[] { 12, 88, 12, 620, 0 }));
        int[] api30Setup = MainActivity.computeEdgeInsets(35, 0, 88, 0, 48, 0, 0, 0, 0, 0, false);
        check("computeEdgeInsets API35 安装页无 WebView：底边留在 padBot",
            java.util.Arrays.equals(api30Setup, new int[] { 0, 88, 0, 48, 0 }));
        int[] api28Cutout = MainActivity.computeEdgeInsets(28, 0, 48, 0, 40, 64, 96, 20, 52, 0, true);
        check("computeEdgeInsets API28 挖孔安全区四边取 max",
            java.util.Arrays.equals(api28Cutout, new int[] { 64, 96, 20, 52, 0 }));
        int[] api27NoCut = MainActivity.computeEdgeInsets(27, 0, 48, 0, 40, 64, 96, 20, 52, 0, true);
        check("computeEdgeInsets API27 不叠加 DisplayCutout",
            java.util.Arrays.equals(api27NoCut, new int[] { 0, 48, 0, 40, 0 }));

        if (fail > 0) {
            System.out.println(fail + " 条失败");
            System.exit(1);
        }
        System.out.println("Wave5AndroidTest: all passed");
    }
}
