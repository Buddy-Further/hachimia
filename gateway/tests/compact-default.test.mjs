// 第三方型号没设压缩线时网关给默认线（11-07 群友：deepseek-flash 涨到 1M 也不自动压缩，撞窗口后手动 /compact 也 400）
import "../gw/config.mjs";   // 放最前：没走 scripts/test.mjs（没有临时 home）就在这里拦下
import { test } from "node:test";
import assert from "node:assert/strict";
import { defaultCompactLine } from "../gw/models.mjs";

const P = (o) => ({ id: "custom-cdef", custom: true, baseUrl: "http://127.0.0.1:1", apiKey: "fixture-only", defaultModel: "m-big", fastModel: "m-big", ...o });

test("默认线：窗口八成、给总结留 40k、夹在 claude 认的 100k–1M 里", () => {
  assert.equal(defaultCompactLine(1048576, P()), 838000);
  assert.equal(defaultCompactLine(200000, P()), 160000);
  assert.equal(defaultCompactLine(160000, P()), 120000);       // 留 40k 比八成更紧
  assert.equal(defaultCompactLine(128000, P()), null);          // 88k 够不着 100k
  assert.equal(defaultCompactLine(2000000, P()), 1000000);      // 大了 claude 按 1M 算
  assert.equal(defaultCompactLine(0, P()), null);               // 不知道窗口：不瞎编
  assert.equal(defaultCompactLine(1048576, { nativeModels: true }), null);   // claude 认得的型号自己会算
});
