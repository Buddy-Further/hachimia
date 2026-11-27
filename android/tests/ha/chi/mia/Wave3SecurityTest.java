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
            check("4.3 .ssh/id_rsa sensitive", Docs.sensitive(new File(ws, ".ssh/id_rsa")));
            check("4.3 normal workspace file not sensitive", !Docs.sensitive(new File(ws, "src/settings.json")));
            check("4.3 root settings.json not sensitive", !Docs.sensitive(new File(ws, "settings.json")));

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
        for (String op : new String[]{"upd_apply", "upd_repair", "shz_install", "shz_repair", "notify_set"}) {
            check("4.4 " + op + " requires gateway", Priv.hostOpGateError(op, false, true) != null);
            check("4.4 " + op + " allowed for gateway even in background (reconcile)", Priv.hostOpGateError(op, true, false) == null);
        }
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
        check("2.5 run_command !isQuestionTool", !Notify.isQuestionTool("run_command"));

        String[] q = Notify.askNoteFields("ask_question", "", "Pick one?", "", "", "{}");
        eq("2.5 ask_question sets question=1", q[0], "1");
        eq("2.5 ask_question title", q[1], Tr.t("Antigravity 想问你"));
        eq("2.5 ask_question body", q[2], "Pick one?");

        Map<String, String> acpCmd = new HashMap<>();
        acpCmd.put("CommandLine", "ls -la");
        eq("2.5 ACP CommandLine extracted", Notify.firstNonEmpty(acpCmd::get, Notify.ASK_INPUT_KEYS), "ls -la");

        Map<String, String> acpTarget = new HashMap<>();
        acpTarget.put("TargetFile", "/tmp/a.java");
        eq("2.5 ACP TargetFile extracted", Notify.firstNonEmpty(acpTarget::get, Notify.ASK_INPUT_KEYS), "/tmp/a.java");

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
    }

    private static void test15InstallerSymlinks() throws Exception {
        Path tmp = Files.createTempDirectory("hachimia-untar-w3-");
        try {
            File root = new File(tmp.toFile(), "usr.new");
            root.mkdirs();
            String rootPath = root.getCanonicalPath();
            new File(root, "bin").mkdirs();
            new File(root, "bin/sub").mkdirs();

            check("1.5 relative symlink inside root allowed",
                Installer.symlinkTargetInside(root, new File(root, "bin/sh"), "bash", rootPath));
            check("1.5 parent-relative symlink staying inside root allowed",
                Installer.symlinkTargetInside(root, new File(root, "bin/sub/tool"), "../bash", rootPath));
            check("1.5 relative escape symlink rejected",
                !Installer.symlinkTargetInside(root, new File(root, "bin/evil"), "../../outside", rootPath));
            check("1.5 absolute escape symlink rejected",
                !Installer.symlinkTargetInside(root, new File(root, "evil"), "/etc/passwd", rootPath));
            check("1.5 sibling prefix escape symlink rejected",
                !Installer.symlinkTargetInside(root, new File(root, "evil"), "../usr.newEvil/x", rootPath));
            check("1.5 NUL byte in symlink target rejected",
                !Installer.symlinkTargetInside(root, new File(root, "evil"), "bash\0evil", rootPath));

            File outside = new File(tmp.toFile(), "outside");
            outside.mkdirs();
            File symDir = new File(root, "escape-dir");
            Files.createSymbolicLink(symDir.toPath(), outside.toPath());
            check("1.5 hasSymlinkBetween catches symlink dir itself", Installer.hasSymlinkBetween(root, symDir));
            check("1.5 hasSymlinkBetween catches child under symlink dir", Installer.hasSymlinkBetween(root, new File(symDir, "payload")));
            check("1.5 symlinkTargetInside rejects link inside symlinked ancestor",
                !Installer.symlinkTargetInside(root, new File(symDir, "nested"), "target", rootPath));
            File dangling = new File(root, "dangling-escape");
            Files.createSymbolicLink(dangling.toPath(), new File(tmp.toFile(), "nonexistent-target").toPath());
            check("1.5 isSymlinkPath catches dangling symlink before file write/chmod", Installer.isSymlinkPath(dangling));
            check("1.5 hasSymlinkBetween allows normal subdir",
                !Installer.hasSymlinkBetween(root, new File(root, "bin/sub/bash")));
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
