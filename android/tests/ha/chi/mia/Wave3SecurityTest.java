package ha.chi.mia;

import java.io.File;
import java.io.FileNotFoundException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Collections;
import java.util.Comparator;
import java.util.HashMap;
import java.util.Map;

/**
 * Wave 3 安全边界与宿主修复回归测试（纯静态逻辑与文件系统测试，不依赖 Android 运行时）。
 */
public final class Wave3SecurityTest {
    private static int passed = 0;

    private static void check(String what, boolean ok) {
        if (!ok) throw new AssertionError("FAIL: " + what);
        passed++;
    }

    private static void eq(String what, Object got, Object want) {
        boolean ok = got == null ? want == null : got.equals(want);
        if (!ok) throw new AssertionError("FAIL: " + what + " (got=" + got + ", want=" + want + ")");
        passed++;
    }

    public static void main(String[] args) throws Exception {
        test41OwnAuthority();
        test43DocsSensitiveAndTruncate();
        test44PrivHostOpGate();
        test45PrivChainTokenNodump();
        test46ShareScrub();
        test25NotifyAskNote();
        test53UpdaterVerifyGuard();
        test15InstallerSymlinks();
        System.out.println("Wave3SecurityTest OK (" + passed + " cases)");
    }

    private static void test41OwnAuthority() {
        String pkg = "ha.chi.mia";
        check("4.1 exact pkg authority", MainActivity.isOwnAuthority("ha.chi.mia", "ha.chi.mia", pkg));
        check("4.1 docs authority", MainActivity.isOwnAuthority("ha.chi.mia.docs", "ha.chi.mia.docs", pkg));
        check("4.1 share authority", MainActivity.isOwnAuthority("ha.chi.mia.share", "ha.chi.mia.share", pkg));
        check("4.1 userId@0 share authority", MainActivity.isOwnAuthority("0@ha.chi.mia.share", "ha.chi.mia.share", pkg));
        check("4.1 userId@10 docs authority", MainActivity.isOwnAuthority("10@ha.chi.mia.docs", "ha.chi.mia.docs", pkg));
        check("4.1 userId@10 uppercase docs authority with null host", MainActivity.isOwnAuthority("10@HA.CHI.MIA.DOCS", null, pkg));
        check("4.1 multi-@ userinfo bypass blocked", MainActivity.isOwnAuthority("0@evil@ha.chi.mia.docs", null, pkg));
        check("4.1 port suffix stripped", MainActivity.isOwnAuthority("0@ha.chi.mia.docs:8080", null, pkg));
        check("4.1 host-only fallback when authority null", MainActivity.isOwnAuthority(null, "HA.CHI.MIA.SHARE", pkg));
        check("4.1 externalstorage allowed", !MainActivity.isOwnAuthority("com.android.externalstorage.documents", "com.android.externalstorage.documents", pkg));
        check("4.1 prefix lookalike allowed", !MainActivity.isOwnAuthority("ha.chi.miab", "ha.chi.miab", pkg));
        check("4.1 subdomain lookalike allowed", !MainActivity.isOwnAuthority("evil.ha.chi.mia", "evil.ha.chi.mia", pkg));
        check("4.1 empty authority/host", !MainActivity.isOwnAuthority("", "", pkg));
    }

    private static void test43DocsSensitiveAndTruncate() throws Exception {
        Path tmp = Files.createTempDirectory("hachimia-docs-w3-");
        try {
            File ws = tmp.toFile();
            check("4.3 .claude dir sensitive", Docs.sensitive(new File(ws, ".claude")));
            check("4.3 .gemini dir sensitive", Docs.sensitive(new File(ws, ".gemini")));
            check("4.3 .ssh dir sensitive", Docs.sensitive(new File(ws, ".ssh")));
            check("4.3 .gnupg dir sensitive", Docs.sensitive(new File(ws, ".gnupg")));
            check("4.3 .ccapp-userconf dir sensitive", Docs.sensitive(new File(ws, ".ccapp-userconf")));
            check("4.3 .gemini/antigravity-cli dir sensitive", Docs.sensitive(new File(ws, ".gemini/antigravity-cli")));
            check("4.3 .local/share/hachimia/agy dir sensitive", Docs.sensitive(new File(ws, ".local/share/hachimia/agy")));
            check("4.3 .local/share/cccodroid/claude dir sensitive", Docs.sensitive(new File(ws, ".local/share/cccodroid/claude")));
            check("4.3 .claude/settings.json sensitive", Docs.sensitive(new File(ws, ".claude/settings.json")));
            check("4.3 .claude/settings.local.json sensitive", Docs.sensitive(new File(ws, ".claude/settings.local.json")));
            check("4.3 .claude/hooks/evil.sh sensitive", Docs.sensitive(new File(ws, ".claude/hooks/evil.sh")));
            check("4.3 .claude/agents/a.md sensitive", Docs.sensitive(new File(ws, ".claude/agents/a.md")));
            check("4.3 .claude/.credentials.json sensitive", Docs.sensitive(new File(ws, ".claude/.credentials.json")));
            check("4.3 proj/.claude/hooks/run.sh sensitive", Docs.sensitive(new File(ws, "proj/.claude/hooks/run.sh")));
            check("4.3 .gemini/foo.json sensitive", Docs.sensitive(new File(ws, ".gemini/foo.json")));
            check("4.3 proj/.gemini/hooks/x.sh sensitive", Docs.sensitive(new File(ws, "proj/.gemini/hooks/x.sh")));
            check("4.3 .ssh/id_rsa sensitive", Docs.sensitive(new File(ws, ".ssh/id_rsa")));
            check("4.3 normal workspace file not sensitive", !Docs.sensitive(new File(ws, "src/settings.json")));
            check("4.3 root settings.json not sensitive", !Docs.sensitive(new File(ws, "settings.json")));
            check("4.3 lookalike .claudefoo not sensitive", !Docs.sensitive(new File(ws, "src/.claudefoo/a.txt")));

            File bundle = new File(ws, "bundle");
            File nestedClaude = new File(bundle, "sub/.claude");
            nestedClaude.mkdirs();
            Files.write(new File(nestedClaude, "settings.json").toPath(), "{}".getBytes());
            check("4.3 containsSensitive detects nested .claude", Docs.containsSensitive(bundle));
            boolean denied = false;
            try { Docs.denySensitiveTree(bundle); } catch (FileNotFoundException expected) { denied = true; }
            check("4.3 denySensitiveTree rejects dir with sensitive descendant", denied);

            File safeDir = new File(ws, "safe");
            safeDir.mkdirs();
            Files.write(new File(safeDir, "readme.txt").toPath(), "ok".getBytes());
            check("4.3 safe dir not sensitive", !Docs.containsSensitive(safeDir));
            Docs.denySensitiveTree(safeDir);
            passed++;

            File link = new File(ws, "alias-claude");
            Files.createSymbolicLink(link.toPath(), nestedClaude.toPath());
            check("4.3 containsSensitive detects symlink to .claude", Docs.containsSensitive(link));

            check("4.3 wantsTruncate(w)", Docs.wantsTruncate("w"));
            check("4.3 wantsTruncate(wt)", Docs.wantsTruncate("wt"));
            check("4.3 wantsTruncate(rwt)", Docs.wantsTruncate("rwt"));
            check("4.3 !wantsTruncate(wa)", !Docs.wantsTruncate("wa"));
            check("4.3 !wantsTruncate(rw)", !Docs.wantsTruncate("rw"));
            check("4.3 !wantsTruncate(r)", !Docs.wantsTruncate("r"));
            check("4.3 !wantsTruncate(null)", !Docs.wantsTruncate(null));
        } finally {
            deleteTree(tmp);
        }
    }

    private static void test44PrivHostOpGate() {
        check("4.4 live gateway pid accepted even with empty cmdline (nodump)",
            Priv.isGatewayPeerWith(200, 100, (p) -> p == 200, (p) -> 1, (p, f) -> ""));
        check("4.4 direct child server.mjs accepted",
            Priv.isGatewayPeerWith(200, 100, (p) -> false, (p) -> p == 200 ? 100 : 1, (p, f) -> p == 200 && "cmdline".equals(f) ? "node\0boot\0server.mjs\0" : ""));
        check("4.4 npm script child of gateway rejected",
            !Priv.isGatewayPeerWith(300, 100, (p) -> p == 200, (p) -> p == 300 ? 200 : 100, (p, f) -> "npm install"));
        check("4.4 non-server direct child rejected",
            !Priv.isGatewayPeerWith(201, 100, (p) -> p == 200, (p) -> 100, (p, f) -> "logcat"));

        for (String op : new String[]{"upd_set", "dev_set", "share_logs", "share_file"}) {
            check("4.4 " + op + " requires gateway", Priv.hostOpGateError(op, false, true) != null);
            check("4.4 " + op + " requires foreground", Priv.hostOpGateError(op, true, false) != null);
            check("4.4 " + op + " allowed for gateway in foreground", Priv.hostOpGateError(op, true, true) == null);
        }
        for (String op : new String[]{"upd_apply", "upd_verify", "upd_repair", "keepalive", "shz_install", "shz_autostart", "shz_repair", "notify_set"}) {
            check("4.4 " + op + " requires gateway", Priv.hostOpGateError(op, false, true) != null);
            check("4.4 " + op + " allowed for gateway even in background (reconcile)", Priv.hostOpGateError(op, true, false) == null);
        }
        check("4.4 dev:share_file requires ask", Priv.devToolRequiresAsk("share_file"));
        check("4.4 dev:open requires ask", Priv.devToolRequiresAsk("open"));
        check("4.4 dev:clipboard_read requires ask", Priv.devToolRequiresAsk("clipboard_read"));
        check("4.4 dev:clipboard_write requires ask", Priv.devToolRequiresAsk("clipboard_write"));
        check("4.4 dev:notify does not require ask", !Priv.devToolRequiresAsk("notify"));
        check("4.4 exec not blocked by hostOpGateError", Priv.hostOpGateError("exec", false, false) == null);
    }

    private static void test45PrivChainTokenNodump() {
        final String tok = "0123456789abcdef0123456789abcdef";
        // Tree: me(100) -> gw(200) -> claude(300) -> sh(400) -> priv(500)
        java.util.function.IntUnaryOperator ppids = (p) -> p == 500 ? 400 : p == 400 ? 300 : p == 300 ? 200 : p == 200 ? 100 : 1;

        // A: readable gw + readable claude env
        eq("4.5 readable proc chain returns envToken",
            Priv.chainTokenWith(500, 100, ppids,
                (p, f) -> p == 200 && "cmdline".equals(f) ? "node\0/app/server.mjs\0"
                    : p == 300 && "environ".equals(f) ? "CCAPP_PRIV_SESS=" + tok + "\0"
                    : "cmdline".equals(f) ? "sh" : "",
                (a, t) -> "witness-should-not-run"),
            tok);

        // B: gw has nodump (ppid(200)=100 > 0, cmdline=""!), claude readable -> must trigger witness(200, 300)
        eq("4.5 nodump gw with ppid>0 and empty cmdline triggers witness(gw, claude)",
            Priv.chainTokenWith(500, 100, ppids,
                (p, f) -> (p == 200) ? "" : ("cmdline".equals(f) ? "sh" : ""),
                (anc, top) -> (anc == 200 && top == 300) ? tok : null),
            tok);

        // C: claude AND gw both nodump (ppid(300)=200 > 0, cmdline=""!) -> triggers witness(300, 400)
        eq("4.5 nodump claude with ppid>0 and empty cmdline triggers witness(claude, sh)",
            Priv.chainTokenWith(500, 100, ppids,
                (p, f) -> (p == 200 || p == 300) ? "" : ("cmdline".equals(f) ? "sh" : ""),
                (anc, top) -> (anc == 300 && top == 400) ? tok : null),
            tok);

        // D: pp == me with readable gw cmdline but nodump child (environ="") -> falls back to witness(200, 300)
        eq("4.5 pp==me fallback to witness when below environ unreadable",
            Priv.chainTokenWith(300, 100, ppids,
                (p, f) -> p == 200 && "cmdline".equals(f) ? "node\0server.mjs\0" : "",
                (anc, top) -> (anc == 200 && top == 300) ? tok : null),
            tok);

        // E: detached process (ppid -> 1) returns null
        eq("4.5 detached process returns null",
            Priv.chainTokenWith(900, 100, (p) -> 1, (p, f) -> "bash", (a, t) -> tok),
            null);
    }

    private static void test46ShareScrub() {
        String aiza = "AIzaSyDaGmWKa4JsXZ-HjGw7ISLn_3namBZqe4";
        String hf = "hf_abcdefghijklmnopqrstuvwxyz1234";
        String xai = "xai-1234567890abcdefghijklmnop";
        String tp = "tp-1234567890abcdefghijklmnop";
        String glpat = "glpat-1234567890abcdef";
        String out = Share.scrub(
            "a=" + aiza + " b=" + hf + " c=" + xai + " d=" + tp + " e=" + glpat
            + " safe=http-something_long_enough_here");
        check("4.6 AIza scrubbed", !out.contains(aiza));
        check("4.6 hf_ scrubbed", !out.contains(hf));
        check("4.6 xai- scrubbed", !out.contains(xai));
        check("4.6 tp- scrubbed", !out.contains(tp));
        check("4.6 glpat- scrubbed", !out.contains(glpat));
        check("4.6 http-something_long_enough_here preserved", out.contains("http-something_long_enough_here"));
    }

    private static void test25NotifyAskNote() {
        check("2.5 AskUserQuestion isQuestionTool", Notify.isQuestionTool("AskUserQuestion"));
        check("2.5 ask_question isQuestionTool", Notify.isQuestionTool("ask_question"));
        check("2.5 ask_question (clarify) isQuestionTool", Notify.isQuestionTool("ask_question (clarify)"));
        check("2.5 ExitPlanMode isPlanTool", Notify.isPlanTool("ExitPlanMode"));
        check("2.5 exit_plan_mode isPlanTool", Notify.isPlanTool("exit_plan_mode"));
        check("2.5 run_command !isQuestionTool", !Notify.isQuestionTool("run_command"));

        String[] q = Notify.askNoteFields("ask_question", "", "Pick one?", "", "", "{}");
        eq("2.5 ask_question sets question=1", q[0], "1");
        eq("2.5 ask_question title", q[1], Tr.t("Antigravity 想问你"));
        eq("2.5 ask_question body", q[2], "Pick one?");

        String[] qFallback = Notify.askNoteFields("Antigravity Tool", "", "Fallback question?", "", "", "{}");
        eq("2.5 questions fallback sets question=1", qFallback[0], "1");
        eq("2.5 questions fallback title", qFallback[1], Tr.t("Antigravity 想问你"));
        eq("2.5 questions fallback body", qFallback[2], "Fallback question?");

        String[] plan = Notify.askNoteFields("exit_plan_mode", "Plan body", "", "", "", "{}");
        eq("2.5 exit_plan_mode sets question=0", plan[0], "0");
        eq("2.5 exit_plan_mode title", plan[1], Tr.t("计划待批准"));
        eq("2.5 exit_plan_mode body", plan[2], "Plan body");

        Map<String, String> acpCmd = new HashMap<>();
        acpCmd.put("CommandLine", "ls -la");
        eq("2.5 ACP CommandLine extracted", Notify.firstNonEmpty(acpCmd::get, Notify.ASK_INPUT_KEYS), "ls -la");

        Map<String, String> acpTarget = new HashMap<>();
        acpTarget.put("TargetFile", "/tmp/a.java");
        eq("2.5 ACP TargetFile extracted", Notify.firstNonEmpty(acpTarget::get, Notify.ASK_INPUT_KEYS), "/tmp/a.java");

        Map<String, String> acpDesc = new HashMap<>();
        acpDesc.put("Description", "Deploy staging");
        eq("2.5 ACP Description extracted", Notify.firstNonEmpty(acpDesc::get, Notify.ASK_INPUT_KEYS), "Deploy staging");

        Map<String, String> acpDir = new HashMap<>();
        acpDir.put("TargetDirectory", "/workspace/sub");
        eq("2.5 ACP TargetDirectory extracted", Notify.firstNonEmpty(acpDir::get, Notify.ASK_INPUT_KEYS), "/workspace/sub");

        Map<String, String> acpPrompt = new HashMap<>();
        acpPrompt.put("Prompt", "Audit module");
        eq("2.5 ACP Prompt extracted", Notify.firstNonEmpty(acpPrompt::get, Notify.ASK_INPUT_KEYS), "Audit module");

        Map<String, String> acpTask = new HashMap<>();
        acpTask.put("TaskId", "task-42");
        eq("2.5 ACP TaskId extracted", Notify.firstNonEmpty(acpTask::get, Notify.ASK_INPUT_KEYS), "task-42");

        Map<String, String> acpSummary = new HashMap<>();
        acpSummary.put("toolSummary", "Run unit tests");
        acpSummary.put("CommandLine", "sh scripts/java-tests.sh");
        eq("2.5 ACP toolSummary prioritized", Notify.firstNonEmpty(acpSummary::get, Notify.ASK_INPUT_KEYS), "Run unit tests");
    }

    private static void test53UpdaterVerifyGuard() {
        check("5.3 verifying counts as devkitMoving", Updater.isDevkitMovingState("verifying"));
        check("5.3 downloading counts as devkitMoving", Updater.isDevkitMovingState("downloading"));
        check("5.3 installing counts as devkitMoving", Updater.isDevkitMovingState("installing"));
        check("5.3 uptodate not devkitMoving", !Updater.isDevkitMovingState("uptodate"));
        check("5.3 ready not devkitMoving", !Updater.isDevkitMovingState("ready"));
        check("5.3 canCommitVerifyResult matching gen and state", Updater.canCommitVerifyResult(3L, 3L, "verifying"));
        check("5.3 canCommitVerifyResult rejects stale gen", !Updater.canCommitVerifyResult(3L, 4L, "verifying"));
        check("5.3 canCommitVerifyResult rejects non-verifying state", !Updater.canCommitVerifyResult(3L, 3L, "installing"));
        // Offline / error check() overwrite guards
        check("5.3 canOverwriteDevkitOnCheck rejects verifying", !Updater.canOverwriteDevkitOnCheck("verifying"));
        check("5.3 canOverwriteDevkitOnCheck rejects downloading", !Updater.canOverwriteDevkitOnCheck("downloading"));
        check("5.3 canOverwriteDevkitOnCheck rejects installing", !Updater.canOverwriteDevkitOnCheck("installing"));
        check("5.3 canOverwriteDevkitOnCheck rejects ready", !Updater.canOverwriteDevkitOnCheck("ready"));
        check("5.3 canOverwriteDevkitOnCheck allows uptodate", Updater.canOverwriteDevkitOnCheck("uptodate"));
        check("5.3 canOverwriteDevkitOnCheck allows error", Updater.canOverwriteDevkitOnCheck("error"));
        check("5.3 canOverwriteAppOnCheck rejects downloading", !Updater.canOverwriteAppOnCheck("downloading", false, false));
        check("5.3 canOverwriteAppOnCheck rejects installing", !Updater.canOverwriteAppOnCheck("installing", false, false));
        check("5.3 canOverwriteAppOnCheck rejects appWaiting", !Updater.canOverwriteAppOnCheck("ready", true, false));
        check("5.3 canOverwriteAppOnCheck rejects ready+devkitMoving", !Updater.canOverwriteAppOnCheck("ready", false, true));
        check("5.3 canOverwriteAppOnCheck allows uptodate", Updater.canOverwriteAppOnCheck("uptodate", false, false));
        check("5.3 canOverwriteClaudeOnCheck rejects installing", !Updater.canOverwriteClaudeOnCheck("installing"));
        check("5.3 canOverwriteClaudeOnCheck rejects downloading", !Updater.canOverwriteClaudeOnCheck("downloading"));
        check("5.3 canOverwriteClaudeOnCheck allows uptodate", Updater.canOverwriteClaudeOnCheck("uptodate"));
    }

    private static byte[] tarEntry(String name, char type, String linkname, byte[] body, int mode, long mtime) throws Exception {
        byte[] hdr = new byte[512];
        byte[] nb = name.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        System.arraycopy(nb, 0, hdr, 0, Math.min(nb.length, 100));
        byte[] mb = String.format(java.util.Locale.ROOT, "%07o\0", mode).getBytes(java.nio.charset.StandardCharsets.US_ASCII);
        System.arraycopy(mb, 0, hdr, 100, 8);
        long sz = body == null ? 0 : body.length;
        byte[] sb = String.format(java.util.Locale.ROOT, "%011o\0", sz).getBytes(java.nio.charset.StandardCharsets.US_ASCII);
        System.arraycopy(sb, 0, hdr, 124, 12);
        byte[] tb = String.format(java.util.Locale.ROOT, "%011o\0", mtime).getBytes(java.nio.charset.StandardCharsets.US_ASCII);
        System.arraycopy(tb, 0, hdr, 136, 12);
        hdr[156] = (byte) type;
        if (linkname != null) {
            byte[] lb = linkname.getBytes(java.nio.charset.StandardCharsets.UTF_8);
            System.arraycopy(lb, 0, hdr, 157, Math.min(lb.length, 100));
        }
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        out.write(hdr);
        if (body != null && body.length > 0) {
            out.write(body);
            int rem = body.length % 512;
            if (rem != 0) out.write(new byte[512 - rem]);
        }
        return out.toByteArray();
    }

    private static byte[] tarPax(String key, String val) throws Exception {
        String kv = " " + key + "=" + val + "\n";
        int kvBytes = kv.getBytes(java.nio.charset.StandardCharsets.UTF_8).length;
        int total = kvBytes + 1;
        while (String.valueOf(total).length() + kvBytes != total) total = String.valueOf(total).length() + kvBytes;
        byte[] body = (total + kv).getBytes(java.nio.charset.StandardCharsets.UTF_8);
        return tarEntry("PaxHeaders/x", 'x', null, body, 0644, 0);
    }

    private static byte[] buildTar(byte[]... parts) throws Exception {
        java.io.ByteArrayOutputStream out = new java.io.ByteArrayOutputStream();
        for (byte[] p : parts) out.write(p);
        out.write(new byte[1024]);
        return out.toByteArray();
    }

    private static final Installer.TarFs TEST_TAR_FS = new Installer.TarFs() {
        @Override public void chmod(File f, int mode) throws java.io.IOException {
            // Host JVM posix permissions (best-effort; files are already checked for existence/symlink)
            f.setReadable((mode & 0400) != 0, false);
            f.setWritable((mode & 0200) != 0, true);
            f.setExecutable((mode & 0100) != 0, false);
        }
        @Override public void symlink(String target, File link) throws java.io.IOException {
            Files.createSymbolicLink(link.toPath(), java.nio.file.Paths.get(target));
        }
        @Override public void link(File existing, File link) throws java.io.IOException {
            try {
                Files.createLink(link.toPath(), existing.toPath());
            } catch (java.nio.file.AccessDeniedException selinux) {
                // Android untrusted_app SELinux 禁止对 app_data_file 调 link(2)；攻击路径已在调用 fs.link 前被拦截
                Files.copy(existing.toPath(), link.toPath(), java.nio.file.StandardCopyOption.REPLACE_EXISTING);
            }
        }
    };

    private static void expectUntarBlocked(String label, File root, byte[] tar) {
        try {
            Installer.untar(new java.io.ByteArrayInputStream(tar), root, "usr/", TEST_TAR_FS);
            throw new AssertionError("FAIL: " + label + " (expected IOException)");
        } catch (java.io.IOException expected) {
            passed++;
        }
    }

    private static void test15InstallerSymlinks() throws Exception {
        Path tmp = Files.createTempDirectory("hachimia-untar-w3-");
        try {
            File outside = new File(tmp.toFile(), "outside");
            outside.mkdirs();

            // 1. Real tar attack: symlink escape-dir -> outside, followed by regular file escape-dir/pwned.txt
            File r1 = new File(tmp.toFile(), "r1");
            r1.mkdirs();
            byte[] t1 = buildTar(
                tarEntry("usr/escape-dir", '2', outside.getAbsolutePath(), null, 0777, 0),
                tarEntry("usr/escape-dir/pwned.txt", '0', null, "pwned".getBytes(java.nio.charset.StandardCharsets.UTF_8), 0644, 0)
            );
            expectUntarBlocked("1.5 untar blocks file write through symlinked ancestor", r1, t1);
            check("1.5 outside file not created via symlink ancestor", !new File(outside, "pwned.txt").exists());

            // 2. Real tar attack: dangling symlink -> outside/secret, followed by regular file overwrite at same path
            File r2 = new File(tmp.toFile(), "r2");
            r2.mkdirs();
            File secretTarget = new File(outside, "secret");
            byte[] t2 = buildTar(
                tarEntry("usr/dangling", '2', secretTarget.getAbsolutePath(), null, 0777, 0),
                tarEntry("usr/dangling", '0', null, "overwrite".getBytes(java.nio.charset.StandardCharsets.UTF_8), 0644, 0)
            );
            expectUntarBlocked("1.5 untar blocks file overwrite on dangling symlink", r2, t2);
            check("1.5 outside target not created via dangling symlink", !secretTarget.exists());

            // 3. Real tar attack: symlink dirlink -> outside, followed by mkdir dirlink/sub
            File r3 = new File(tmp.toFile(), "r3");
            r3.mkdirs();
            byte[] t3 = buildTar(
                tarEntry("usr/dirlink", '2', outside.getAbsolutePath(), null, 0777, 0),
                tarEntry("usr/dirlink/sub", '5', null, null, 0755, 0)
            );
            expectUntarBlocked("1.5 untar blocks dir creation through symlinked ancestor", r3, t3);
            check("1.5 outside dir not created via symlink ancestor", !new File(outside, "sub").exists());

            // 4. Real tar attack: symlink dirlink -> outside, followed by nested symlink dirlink/inner
            File r4 = new File(tmp.toFile(), "r4");
            r4.mkdirs();
            byte[] t4 = buildTar(
                tarEntry("usr/dirlink", '2', outside.getAbsolutePath(), null, 0777, 0),
                tarEntry("usr/dirlink/inner", '2', "foo", null, 0777, 0)
            );
            expectUntarBlocked("1.5 untar blocks nested symlink inside symlinked ancestor", r4, t4);
            check("1.5 outside symlink not created via symlink ancestor", !Files.isSymbolicLink(new File(outside, "inner").toPath()));

            // 5. Real tar attack: hardlink targeting symlink pointing outside
            File r5 = new File(tmp.toFile(), "r5");
            r5.mkdirs();
            File victim = new File(outside, "victim.txt");
            Files.write(victim.toPath(), "keep".getBytes(java.nio.charset.StandardCharsets.UTF_8));
            byte[] t5 = buildTar(
                tarEntry("usr/sym", '2', victim.getAbsolutePath(), null, 0777, 0),
                tarEntry("usr/hl", '1', "usr/sym", null, 0644, 0)
            );
            expectUntarBlocked("1.5 untar blocks hardlink targeting symlink", r5, t5);
            check("1.5 hardlink not created", !new File(r5, "hl").exists());

            // 6. Real tar attack: direct ../ traversal and PAX path= traversal
            File r6 = new File(tmp.toFile(), "r6");
            r6.mkdirs();
            byte[] t6a = buildTar(
                tarEntry("usr/../escaped.txt", '0', null, "bad".getBytes(java.nio.charset.StandardCharsets.UTF_8), 0644, 0)
            );
            expectUntarBlocked("1.5 untar blocks ustar ../ traversal", r6, t6a);
            check("1.5 ustar ../ target not created", !new File(tmp.toFile(), "escaped.txt").exists());

            byte[] t6b = buildTar(
                tarPax("path", "usr/a/../../pax-escaped.txt"),
                tarEntry("usr/placeholder", '0', null, "bad".getBytes(java.nio.charset.StandardCharsets.UTF_8), 0644, 0)
            );
            expectUntarBlocked("1.5 untar blocks pax ../ traversal", r6, t6b);
            check("1.5 pax ../ target not created", !new File(tmp.toFile(), "pax-escaped.txt").exists());

            // 7. Real tar attack: symlink at sub/.. normalizing to root itself
            File r7 = new File(tmp.toFile(), "r7");
            r7.mkdirs();
            byte[] t7 = buildTar(
                tarEntry("usr/sub/..", '2', "/etc/passwd", null, 0777, 0)
            );
            expectUntarBlocked("1.5 untar blocks symlink normalizing to root", r7, t7);

            // 8. Legitimate devkit tar: dir + file (with mtime) + relative symlink + absolute devkit symlink + hardlink
            File r8 = new File(tmp.toFile(), "r8");
            r8.mkdirs();
            byte[] t8 = buildTar(
                tarEntry("usr/bin", '5', null, null, 0755, 0),
                tarEntry("usr/bin/tool", '0', null, "hello-tar".getBytes(java.nio.charset.StandardCharsets.UTF_8), 0755, 1700000000L),
                tarEntry("usr/bin/sh", '2', "tool", null, 0777, 0),
                tarEntry("usr/bin/sys-sh", '2', "/system/bin/sh", null, 0777, 0),
                tarEntry("usr/bin/tool2", '1', "usr/bin/tool", null, 0755, 0)
            );
            Installer.untar(new java.io.ByteArrayInputStream(t8), r8, "usr/", TEST_TAR_FS);
            eq("1.5 legit file content extracted",
                new String(Files.readAllBytes(new File(r8, "bin/tool").toPath()), java.nio.charset.StandardCharsets.UTF_8),
                "hello-tar");
            eq("1.5 legit relative symlink preserved",
                Files.readSymbolicLink(new File(r8, "bin/sh").toPath()).toString(), "tool");
            eq("1.5 legit absolute devkit symlink preserved",
                Files.readSymbolicLink(new File(r8, "bin/sys-sh").toPath()).toString(), "/system/bin/sh");
            eq("1.5 legit hardlink shares content",
                new String(Files.readAllBytes(new File(r8, "bin/tool2").toPath()), java.nio.charset.StandardCharsets.UTF_8),
                "hello-tar");
            check("1.5 hasSymlinkBetween allows normal subdir",
                !Installer.hasSymlinkBetween(r8, new File(r8, "bin/tool")));
        } finally {
            deleteTree(tmp);
        }
    }

    private static void deleteTree(Path dir) throws Exception {
        try (java.util.stream.Stream<Path> s = Files.walk(dir)) {
            s.sorted(Comparator.reverseOrder()).forEach((p) -> { try { Files.delete(p); } catch (Exception ignored) {} });
        }
    }
}
