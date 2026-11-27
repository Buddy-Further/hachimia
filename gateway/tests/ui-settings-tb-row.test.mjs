// 设置 → 通用 → 顶栏按钮（.tb-row）与窄屏竖排 .srow 的 flex-wrap 回归测试：
// 防止 .srow 在 flex-direction: column 下残留 flex-wrap: wrap，导致 Blink 按 min-content
// 虚撑 .sl 高度（手机窄屏下 #tb-list 与 #tb-reset 之间出现约 205px 空白）。
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

const css = fs.readFileSync(new URL("../web/style.css", import.meta.url), "utf8");
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "");

function parseRules(src) {
  const rules = [];
  const re = /([^{}@]+)\{([^{}]+)\}/g;
  let m;
  while ((m = re.exec(stripComments(src)))) {
    rules.push({ sel: m[1].trim(), body: m[2].trim() });
  }
  return rules;
}

test(".tb-row 采用单列竖排 nowrap，并移除多余/有隐患的 flex-basis:100%", () => {
  const rules = parseRules(css);
  const tbRules = rules.filter((r) => /\.tb-row\b/.test(r.sel) && !/>/.test(r.sel));
  assert.ok(tbRules.length > 0, "缺少 .tb-row 规则");
  for (const r of tbRules) {
    assert.doesNotMatch(r.body, /flex-wrap\s*:\s*wrap\b/, `.tb-row 不得使用 flex-wrap: wrap (${r.sel})`);
  }
  assert.ok(
    tbRules.some((r) => /flex-direction\s*:\s*column\b/.test(r.body) && /flex-wrap\s*:\s*nowrap\b/.test(r.body) && /gap\s*:\s*8px\b/.test(r.body)),
    ".tb-row 应明确设置 flex-direction:column; flex-wrap:nowrap; gap:8px"
  );
  const slBasis = rules.filter((r) => /\.tb-row\s*>\s*\.sl\b/.test(r.sel) && /flex-basis\s*:\s*100%/.test(r.body));
  assert.equal(slBasis.length, 0, "不应保留 .tb-row > .sl { flex-basis: 100% }");
  const scAlign = rules.filter((r) => /\.tb-row\s*>\s*\.sc\b/.test(r.sel) && /margin-inline-start\s*:\s*auto\b/.test(r.body));
  assert.ok(scAlign.length > 0, ".tb-row > .sc 应保留 margin-inline-start: auto");
});

test("窄屏 #tab-settings.set-one 下所有改为 flex-direction:column 的 .srow 规则都显式设置 flex-wrap:nowrap", () => {
  const rules = parseRules(css);
  const colRules = rules.filter((r) =>
    /#tab-settings\.set-one\b[^\n]*\.srow\b/.test(r.sel) && /flex-direction\s*:\s*column\b/.test(r.body)
  );
  assert.ok(colRules.length >= 3, `预期至少 3 条窄屏竖排 .srow 规则，实际 ${colRules.length}`);
  for (const r of colRules) {
    assert.match(r.body, /flex-wrap\s*:\s*nowrap\b/, `规则缺少 flex-wrap: nowrap: ${r.sel}`);
  }
});
