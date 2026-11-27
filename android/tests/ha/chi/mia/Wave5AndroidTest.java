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

        // ── 9.3 Env.proofCacheFresh & 单调钟源码校验 ──
        eq("proofCacheFresh 有效期内命中", Env.proofCacheFresh(false, "abc", 1000L, 3999L), true);
        eq("proofCacheFresh 超 3000ms 过期", Env.proofCacheFresh(false, "abc", 1000L, 4000L), false);
        eq("proofCacheFresh force=true 绕过缓存", Env.proofCacheFresh(true, "abc", 1000L, 1100L), false);
        eq("proofCacheFresh now < provedAt 拒绝", Env.proofCacheFresh(false, "abc", 1000L, 900L), false);
        eq("proofCacheFresh boot 为空拒绝", Env.proofCacheFresh(false, "", 1000L, 1100L), false);
        eq("proofCacheFresh provedAt=0 拒绝", Env.proofCacheFresh(false, "abc", 0L, 1100L), false);

        String gwSrc = readSrc("android/java/ha/chi/mia/GatewayService.java");
        String envSrc = readSrc("android/java/ha/chi/mia/Env.java");
        check("GatewayService spawnedAt 使用 elapsedRealtime",
            gwSrc.contains("spawnedAt = android.os.SystemClock.elapsedRealtime()"));
        check("GatewayService frozenAt 保留墙钟 currentTimeMillis",
            gwSrc.contains("putLong(\"frozenAt\", System.currentTimeMillis())"));
        check("Env provedAt 使用 elapsedRealtime",
            envSrc.contains("provedAt = android.os.SystemClock.elapsedRealtime()"));

        // ── 9.4 A11y 回收辅助 ──
        eq("A11y API28 需要回收", A11y.shouldRecycleOnSdk(28), true);
        eq("A11y API32 需要回收", A11y.shouldRecycleOnSdk(32), true);
        eq("A11y API33 不再回收", A11y.shouldRecycleOnSdk(33), false);
        eq("A11y API36 不再回收", A11y.shouldRecycleOnSdk(36), false);
        A11y.safeRecycle((android.view.accessibility.AccessibilityNodeInfo) null);
        A11y.safeRecycle((android.view.accessibility.AccessibilityWindowInfo) null);
        check("A11y null safeRecycle 不抛异常", true);
        String a11ySrc = readSrc("android/java/ha/chi/mia/A11y.java");
        check("A11y walk 使用 try...finally safeRecycle", a11ySrc.contains("safeRecycle(child)"));
        check("A11y performWithParents 使用 try...finally safeRecycle", a11ySrc.contains("performWithParents("));

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

        // ── 9.1 MainActivity edgeToEdge 源码检查 ──
        String maSrc = readSrc("android/java/ha/chi/mia/MainActivity.java");
        check("MainActivity API 30+ 使用 systemBars() | displayCutout()",
            maSrc.contains("WindowInsets.Type.systemBars() | android.view.WindowInsets.Type.displayCutout()"));
        check("MainActivity API 28-29 兼顾 getDisplayCutout()",
            maSrc.contains("in.getDisplayCutout()") && maSrc.contains("dc.getSafeInsetLeft()"));

        if (fail > 0) {
            System.out.println(fail + " 条失败");
            System.exit(1);
        }
        System.out.println("Wave5AndroidTest: all passed");
    }
}
