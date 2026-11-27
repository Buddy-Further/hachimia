// Wave 5-C Web UI 异步竞态（Bug 5.9）与数学公式 DOM 安全（孤立 Bug 1）回归测试
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const readWeb = (rel) => fs.readFileSync(new URL(`../web/${rel}`, import.meta.url), "utf8");

function loadCoreRenderer(mdImgImpl = null) {
  const src01 = readWeb("app/01-core.js");
  const a = src01.indexOf("  const fileUrl =");
  const b = src01.indexOf("  // ── 本地图片内联", a);
  assert.ok(a > 0 && b > a, "01-core.js 渲染器代码块找不到");
  const ctx = {
    t: (s) => s,
    esc: (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
    mdImgImpl,
  };
  vm.runInNewContext(`
${src01.slice(a, b)}
if (mdImgImpl) mdImg = mdImgImpl;
globalThis.__r = { inlineMd, renderMd };
`, ctx);
  return ctx.__r;
}

function makeMockNode(id = "") {
  const node = {
    id,
    innerHTML: "",
    textContent: "",
    value: "",
    disabled: false,
    checked: false,
    open: false,
    children: [],
    childNodes: [],
    dataset: {},
    style: {},
    isConnected: true,
    listeners: {},
    classList: {
      set: new Set(),
      toggle(c, f) { if (f === undefined) { this.set.has(c) ? this.set.delete(c) : this.set.add(c); } else if (f) this.set.add(c); else this.set.delete(c); },
      contains(c) { return this.set.has(c); },
      add(...cs) { for (const c of cs) this.set.add(c); },
      remove(...cs) { for (const c of cs) this.set.delete(c); },
    },
    addEventListener(type, fn) { (this.listeners[type] ||= []).push(fn); },
    async emit(type, ev) {
      for (const fn of this.listeners[type] || []) await fn(ev);
    },
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    setAttribute() {},
    removeAttribute() {},
    after() {},
    before() {},
    remove() {},
    replaceChildren() { this.children = []; this.innerHTML = ""; },
    scrollIntoView() {},
    focus() {},
  };
  return node;
}

function makeDomEnv() {
  const nodes = new Map();
  const $ = (id) => {
    if (!nodes.has(id)) nodes.set(id, makeMockNode(id));
    return nodes.get(id);
  };
  return { nodes, $ };
}

function defer() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

async function trackUnhandled(fn) {
  const errs = [];
  const onRej = (e) => errs.push(e);
  process.on("unhandledRejection", onRej);
  try {
    await fn();
    await new Promise((r) => setTimeout(r, 20));
  } finally {
    process.off("unhandledRejection", onRej);
  }
  assert.deepEqual(errs, [], `出现未捕获的 Promise Rejection: ${errs.map((e) => e?.stack || e).join("\n")}`);
}

// ── 孤立 Bug 1：inlineMd / holdMath 不破坏 HTML 属性结构 ──────────────────────

test("孤立 Bug 1: inlineMd 对链接文本/URL/alt/filePath 中的 $...$ 不破坏 HTML 属性，正文与反引号正常", () => {
  const R0 = loadCoreRenderer(null);

  // 1) Markdown 链接：文本含 $x$、URL 含 $y$
  const hLink = R0.inlineMd("[a $x$ b](https://example.com/?q=$y$)");
  assert.match(hLink, /^<a class="weblink" href="https:\/\/example\.com\/\?q=\$y\$" target="_blank" rel="noopener">a <span class="math" data-tex="x">\$x\$<\/span> b<\/a>$/);
  const hrefMatch = hLink.match(/href="([^"]*)"/);
  assert.ok(hrefMatch && !hrefMatch[1].includes("<span"), `href 内绝不能出现 <span: ${hLink}`);

  // 2) URL 含带引号的 $...$：必须转义引号，不能提前闭合 href="..."
  const hQuote = R0.inlineMd('[a $x$ b](https://example.com/?q=$"bad"$)');
  assert.match(hQuote, /href="https:\/\/example\.com\/\?q=\$&quot;bad&quot;\$"/);

  // 3) 裸网址含 $y$：href 与显示文本都不得插入 <span
  const hBare = R0.inlineMd("访问 https://example.com/?q=$y$ 结束");
  assert.match(hBare, /href="https:\/\/example\.com\/\?q=\$y\$"[^>]*>https:\/\/example\.com\/\?q=\$y\$<\/a>/);
  assert.ok(!hBare.match(/href="[^"]*<span/), `裸链 href 不得含 <span: ${hBare}`);

  // 4) 图片 alt 含 $z$（mdImg 返回字符串 URL 与外链对象两种路径）
  const Rimg = loadCoreRenderer((u) => u);
  const hImg = Rimg.inlineMd("![img $z$](foo.png)");
  assert.match(hImg, /^<img class="md-img" src="foo\.png" alt="img \$z\$" loading="lazy" referrerpolicy="no-referrer">$/);

  const Rext = loadCoreRenderer((u) => ({ src: u, label: "加载图片" }));
  const hExt = Rext.inlineMd("![img $z$](https://cdn.example/foo.png)");
  assert.match(hExt, /^<button type="button" class="md-img-ext" data-src="https:\/\/cdn\.example\/foo\.png" data-alt="img \$z\$">加载图片<\/button>$/);

  // 5) 文件路径链接：[f $x$](/sdcard/$y$.txt)
  const hFile = R0.inlineMd("[f $x$](/sdcard/$y$.txt)");
  assert.match(hFile, /data-path="\/sdcard\/\$y\$\.txt"/);
  assert.match(hFile, /<span class="math" data-tex="x">\$x\$<\/span>/);

  // 6) 正文数学公式与反引号代码保持原行为
  const hMath = R0.inlineMd("公式 $a+b$ 与 $$c+d$$ 与 \\(e+f\\) 结束");
  assert.match(hMath, /<span class="math" data-tex="a\+b">\$a\+b\$<\/span>/);
  assert.match(hMath, /<span class="math" data-tex="c\+d">\$\$c\+d\$\$<\/span>/);
  assert.match(hMath, /<span class="math" data-tex="e\+f">\\\(e\+f\\\)<\/span>/);

  const hCode = R0.inlineMd("代码 `$notmath$` 和正文 $a+b$");
  assert.match(hCode, /<code>\$notmath\$<\/code>/);
  assert.ok(!hCode.includes('data-tex="notmath"'), "反引号代码内不得解析数学公式");

  const hFence = R0.renderMd("```\n$notmath$\n```");
  assert.ok(!hFence.includes('class="math"'), "围栏代码块内不得解析数学公式");
});

// ── Bug 5.9 (1): 08-extensions.js Hooks 并发锁、错误处理与 pause 开关方向 ──

test("Bug 5.9 (08-extensions.js): Hooks 删除加 HK.saving 锁、捕获异常不抛 rejection、pause 状态方向与失败回滚正确", async () => {
  await trackUnhandled(async () => {
    const src = readWeb("app/08-extensions.js");
    const { $ } = makeDomEnv();
    const toasts = [];
    const apiCalls = [];
    let hooksState = {
      dir: "/w",
      sealed: false,
      events: ["PreToolUse", "Stop"],
      scopes: [{
        scope: "user",
        file: "/h/.claude/settings.json",
        exists: true,
        disableAll: false,
        hooks: {
          PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo 1" }, { type: "command", command: "echo 2" }] }],
        },
      }],
    };
    let nextSaveHandler = null;

    const box = {
      window: { I18N: { lang: "zh" } },
      I18N: { lang: "zh" },
      $: (id) => (["gh-auth", "llm-dl", "ext-storage"].includes(id) ? null : $(id)),
      t: (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "") : s),
      tk: (s) => s,
      esc: (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
      isZh: () => true,
      document: { querySelectorAll: () => [] },
      localStorage: { getItem: () => null, setItem() {} },
      confirm: () => true,
      toast: (msg, isErr) => toasts.push({ msg, isErr: !!isErr }),
      pageOn: () => true,
      setPageSub() {},
      webUrl: () => false,
      extOffNow: async () => ({ comp: [] }),
      latest: () => () => true,
      api: async (url, opts) => {
        apiCalls.push({ url, opts });
        if (url === "/api/ext/hooks") return JSON.parse(JSON.stringify(hooksState));
        if (url === "/api/ext/hooks/save") {
          const body = JSON.parse(opts.body);
          if (nextSaveHandler) return await nextSaveHandler(body);
          return { ok: true };
        }
        return {};
      },
      setTimeout,
      clearTimeout,
    };

    vm.runInNewContext(src + "\nglobalThis.__ext = { HK, loadExtHooks };", box, { filename: "08-extensions.js" });
    await box.__ext.loadExtHooks();

    // 1) 连点删除：第二次点击必须被 HK.saving / btn.disabled 拦截
    const sec = $("ext-hook-sec");
    const delBtn = makeMockNode("del-btn");
    delBtn.dataset.hk = "del";
    const itemEl = makeMockNode("item-0");
    itemEl.dataset.i = "0";
    delBtn.closest = (sel) => (sel === ".hk-item" ? itemEl : sel === "[data-hk]" ? delBtn : null);

    const d1 = defer();
    nextSaveHandler = () => d1.promise;
    const p1 = sec.emit("click", { target: delBtn, preventDefault() {} });
    const p2 = sec.emit("click", { target: delBtn, preventDefault() {} });
    assert.equal(apiCalls.filter((c) => c.url === "/api/ext/hooks/save").length, 1, "连点删除只能发一次保存请求");
    assert.equal(box.__ext.HK.saving, true);
    assert.equal(delBtn.disabled, true);
    d1.resolve({ ok: true });
    await Promise.all([p1, p2]);
    assert.equal(box.__ext.HK.saving, false);
    assert.equal(delBtn.disabled, false);

    // 2) 删除/保存抛网络异常：toast 报错、解锁、无 unhandledRejection
    apiCalls.length = 0;
    toasts.length = 0;
    nextSaveHandler = async () => { throw new Error("HTTP 500"); };
    await sec.emit("click", { target: delBtn, preventDefault() {} });
    assert.equal(box.__ext.HK.saving, false);
    assert.equal(delBtn.disabled, false);
    assert.ok(toasts.some((x) => x.isErr && x.msg.includes("HTTP 500")), "异常应通过 toast 提示");

    // 3) pause 开关：勾选 => disableAll:true；抛错/ok:false 时回滚 checked 为 false
    const cb = makeMockNode("pause-cb");
    cb.dataset.hk = "pause";
    cb.checked = true; // 用户点击勾选暂停
    toasts.length = 0;
    nextSaveHandler = async () => { throw new Error("network down"); };
    await sec.emit("change", { target: cb });
    assert.equal(cb.checked, false, "网络异常时 pause 开关必须回滚");
    assert.equal(cb.disabled, false);
    assert.equal(box.__ext.HK.saving, false);
    assert.ok(toasts.some((x) => x.isErr && x.msg.includes("network down")));

    // 勾选成功：发出 disableAll: true 并提示已暂停
    cb.checked = true;
    toasts.length = 0;
    let sentBody = null;
    nextSaveHandler = async (b) => { sentBody = b; hooksState.scopes[0].disableAll = b.disableAll; return { ok: true }; };
    await sec.emit("change", { target: cb });
    assert.equal(sentBody.disableAll, true, "勾选暂停应传 disableAll: true");
    assert.ok(toasts.some((x) => !x.isErr && x.msg.includes("已暂停")));

    // 取消勾选：发出 disableAll: false 并提示已恢复
    cb.checked = false;
    toasts.length = 0;
    await sec.emit("change", { target: cb });
    assert.equal(sentBody.disableAll, false, "取消勾选应传 disableAll: false");
    assert.ok(toasts.some((x) => !x.isErr && x.msg.includes("已恢复")));
  });
});

// ── Bug 5.9 (2): 09-settings.js 切卡竞态与 /api/login/cancel 异常防护 ────────

test("Bug 5.9 (09-settings.js): loadBill 切卡后 catch 不污染新卡，/api/login/cancel 捕获异常且校验视图", async () => {
  await trackUnhandled(async () => {
    const src = readWeb("app/09-settings.js");
    const { $ } = makeDomEnv();
    const toasts = [];
    const apiHandlers = new Map();
    const state = { provView: "deepseek", providers: [{ id: "deepseek", label: "DeepSeek" }], settings: {} };

    const box = {
      window: { I18N: { lang: "zh" }, location: { origin: "http://127.0.0.1" } },
      I18N: { lang: "zh" },
      location: { origin: "http://127.0.0.1" },
      $,
      state,
      ctxBar: makeMockNode("ctx-bar"),
      setOpen: true,
      setCatOpen: "provider",
      curPage: "",
      t: (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "") : s),
      tk: (s) => s,
      esc: (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
      toast: (msg, isErr) => toasts.push({ msg, isErr: !!isErr }),
      api: async (url, opts) => {
        for (const [prefix, fn] of apiHandlers) if (url.startsWith(prefix)) return await fn(url, opts);
        return {};
      },
      uiGet: () => null,
      uiSet() {},
      MutationObserver: class { observe() {} },
      document: { documentElement: {}, addEventListener() {}, querySelectorAll: () => [] },
      localStorage: { getItem: () => null, setItem() {} },
      Intl,
      setTimeout,
      clearTimeout,
    };

    vm.runInNewContext(src + "\nglobalThis.__set = { loadBill, paintLoginState };", box, { filename: "09-settings.js" });

    // 1) loadBill：切走后 /api/billing 报错不得覆盖当前卡片的 #pc-bill
    const dBill = defer();
    apiHandlers.set("/api/billing", () => dBill.promise);
    const billEl = $("pc-bill");
    billEl.innerHTML = "";
    state.provView = "deepseek";
    const pBill = box.__set.loadBill({ id: "deepseek" });
    state.provView = "openai";
    billEl.innerHTML = "<div>OPENAI_BILL</div>";
    dBill.reject(new Error("bill-boom"));
    await pBill;
    assert.equal(billEl.innerHTML, "<div>OPENAI_BILL</div>", "loadBill catch 不得在切卡后覆盖新卡余额区");

    // 3) /api/login/cancel：切走后失败不抛 rejection 且不弹出过时错误；仍在原卡时失败通过 toast 提示
    state.provView = "antigravity";
    box.__set.paintLoginState({ loggedIn: false, pending: true }, { id: "antigravity", label: "Google" });
    const dCancel1 = defer();
    apiHandlers.set("/api/login/cancel", () => dCancel1.promise);
    $("login-actions").onclick({ target: { dataset: { act: "cancel" } } });
    state.provView = "deepseek";
    dCancel1.reject(new Error("cancel-stale-err"));
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(toasts.length, 0, "切卡后 /api/login/cancel 失败不应在旧视图弹 toast");

    state.provView = "antigravity";
    box.__set.paintLoginState({ loggedIn: false, pending: true }, { id: "antigravity", label: "Google" });
    apiHandlers.set("/api/login/cancel", async () => { throw new Error("cancel-err"); });
    $("login-actions").onclick({ target: { dataset: { act: "cancel" } } });
    await new Promise((r) => setTimeout(r, 20));
    assert.ok(toasts.some((x) => x.isErr && x.msg.includes("cancel-err")), "同视图 /api/login/cancel 失败应提示错误且无未捕获 rejection");
  });
});

// ── Bug 5.9 (3): 06-files.js 大目录清搜索加载期间立即输入新搜索词不被还原回 "" ──

test("Bug 5.9 (06-files.js): 大目录清搜索加载期间（fsHere 尚未就绪）立即输入新词不被 :88 还原为空，加载完自动搜新词", async () => {
  await trackUnhandled(async () => {
    const src = readWeb("app/06-files.js");
    const { $ } = makeDomEnv();
    const filesEl = $("files");
    filesEl.classList.remove("hidden");
    const state = {
      fs: { path: "/big", parent: "/", entries: [], roots: ["/big"], hidden: false, q: "", truncated: false, qRemote: false, sel: null, arc: null, multi: null },
      settings: { workspace: "/big" },
    };
    let seq = 0;
    const latest = () => { const my = ++seq; return () => my === seq; };
    const apiUrls = [];
    let nextFilesHandler = null;

    const box = {
      $,
      filesEl,
      state,
      latest,
      dropReq: () => { seq++; },
      t: (s, vars) => (vars ? s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? "") : s),
      tk: (s) => s,
      esc: (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
      toast() {},
      fmtSize: (n) => n + " B",
      fileUrl: (p) => "/api/file?path=" + encodeURIComponent(p),
      fsGitDots() {},
      document: { addEventListener() {}, querySelectorAll: () => [] },
      api: async (url) => {
        apiUrls.push(url);
        if (nextFilesHandler) return await nextFilesHandler(url);
        return { path: "/big", parent: "/", entries: [{ name: "alpha.txt", kind: "text", size: 10 }], roots: ["/big"], truncated: true };
      },
      setTimeout,
      clearTimeout,
    };

    vm.runInNewContext(src + "\nglobalThis.__fs = { fsLoad, fsSearchTyped };", box, { filename: "06-files.js" });

    // 1) 首次进入大目录
    await box.__fs.fsLoad("/big");
    assert.equal(state.fs.truncated, true);

    // 2) 模拟处于远程搜索状态（如刚搜完 "foo"）
    state.fs.q = "foo";
    state.fs.qRemote = true;
    $("fs-search").value = "foo";

    // 3) 清空搜索触发 fsLoad("/big", { keepSel: true, keepQ: true })，让该请求挂起
    const dReload = defer();
    nextFilesHandler = () => dReload.promise;
    $("fs-search").value = "";
    const pClear = box.__fs.fsSearchTyped("");
    assert.equal(state.fs.q, "");

    // 4) 在 fsLoad 尚未完成（fsHere() 仍为 false）时，用户立即输入 "bar"
    $("fs-search").value = "bar";
    box.__fs.fsSearchTyped("bar");
    assert.equal($("fs-search").value, "bar", "清搜索加载期间输入的新词不得被强行还原回 ''");
    assert.equal(state.fs.q, "bar");

    // 5) 清空目录加载完成后，仍保留 "bar" 并自动向网关请求 q=bar
    nextFilesHandler = async () => ({
      path: "/big", parent: "/",
      entries: [{ name: "bar-result.txt", kind: "text", size: 12 }],
      roots: ["/big"], truncated: true,
    });
    dReload.resolve({
      path: "/big", parent: "/",
      entries: [{ name: "alpha.txt", kind: "text", size: 10 }],
      roots: ["/big"], truncated: true,
    });
    await pClear;
    await new Promise((r) => setTimeout(r, 20));
    assert.equal($("fs-search").value, "bar", "清搜索异步完成后不得覆盖用户刚输入的新词");
    assert.equal(state.fs.q, "bar");
    assert.ok(apiUrls.some((u) => u.includes("&q=bar")), `加载完成后应对新词发起远端搜索，实际请求: ${JSON.stringify(apiUrls)}`);
  });
});
