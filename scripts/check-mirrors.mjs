#!/usr/bin/env node
// 核对 hachimia 的发布物是否齐全：最新正式版 APK 两个包都在且大小对、agy 官方 manifest 能取到版本号、
// 预置组件索引在不在（hachimia 尚无 components Release，404 只警告，不算失败——需发布方补 Release）。
// 只读，不验签（验签由客户端和生成器负责），用来发版前或出问题时快速看一眼。用法：node scripts/check-mirrors.mjs
const get = async (url, method = "GET") => {
  const r = await fetch(url, { method, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r;
};
let bad = 0;

// APK：GitHub 最新正式版的两个安装包 hachimia.apk / hachimia-36.apk 都在，直链下回来的大小和资产一致
try {
  const rel = await (await get("https://api.github.com/repos/greyoak111/hachimia/releases/latest")).json();
  const want = rel.assets.filter((x) => /^hachimia(-36)?\.apk$/.test(x.name));
  if (want.length < 2) { bad++; console.log(`✗ APK ${rel.tag_name}：只找到 ${want.map((a) => a.name).join(" ") || "（无）"}，缺 hachimia.apk / hachimia-36.apk`); }
  for (const a of want) {
    const len = await get(a.browser_download_url, "HEAD").then((r) => +r.headers.get("content-length"), () => 0);
    const ok = len === a.size;
    if (!ok) bad++;
    console.log(`${ok ? "✓" : "✗"} APK ${rel.tag_name} ${a.name}：GitHub ${a.size} / 直链 ${len}`);
  }
} catch (e) { bad++; console.log(`✗ APK：${e.message}`); }

// agy 官方 manifest：App 的 --check 拿它当 latest 来源，要能取到、里面要有能解析的版本号
try {
  const m = await (await get("https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests/android_arm64.json")).json();
  const v = String(m.version || m.latest || m.tag || "").replace(/^v/, "");
  const ok = /^\d+\.\d+\.\d+/.test(v);
  if (!ok) bad++;
  console.log(`${ok ? "✓" : "✗"} agy manifest：${ok ? "版本 " + v : "没有可解析的版本号：" + JSON.stringify(m).slice(0, 120)}`);
} catch (e) { bad++; console.log(`✗ agy manifest：${e.message}`); }

// 预置组件索引：404 只是“还没发布”，警告，不算失败
try {
  const r = await fetch("https://github.com/greyoak111/hachimia/releases/download/components/components.json", { signal: AbortSignal.timeout(30000) });
  if (r.status === 404) console.log("⚠ 预置组件索引：尚未发布（需发布方补 components Release），跳过");
  else if (!r.ok) { bad++; console.log(`✗ 预置组件索引：HTTP ${r.status}`); }
  else {
    const j = await r.json();
    const comps = Array.isArray(j.components) ? j.components : Object.entries(j.components || {}).map(([id, c]) => ({ id, ...c }));
    let n = 0, miss = 0;
    for (const c of comps) for (const b of c.builds || []) {
      const asset = b.asset || String(b.url || "").split("/").pop();
      if (!/^https:\/\/github\.com\//.test(b.url || "") || !(b.bytes > 0)) continue;
      n++;
      try {
        const len = +(await get(b.url, "HEAD")).headers.get("content-length");
        if (len !== b.bytes) throw new Error(`大小 ${len} ≠ ${b.bytes}`);
      } catch (e) { miss++; console.log(`✗ ${c.id}/${asset}：${e.message}`); }
    }
    if (miss) bad++;
    console.log(`${miss ? "✗" : "✓"} 预置组件包：${n - miss}/${n}（${comps.length} 个组件）`);
  }
} catch (e) { bad++; console.log(`✗ 预置组件索引：${e.message}`); }
process.exit(bad ? 1 : 0);
