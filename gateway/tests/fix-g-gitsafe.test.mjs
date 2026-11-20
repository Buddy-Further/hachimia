// G 分片：G7 gitsafe 托管块缺 END 行时旧信任永久残留（fix-G-security，先写失败测试）
//   BEGIN 在、END 丢了（手改/损坏/写一半被中断），之后无论同步多少次，旧的 safe.directory 条目都删不掉，
//   被移出登记表的项目仍被 git 信任；新块还会追加在后面，造成新旧块并存。
import "../gw/config.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { CFG } from "../gw/config.mjs";
import { syncGitSafe } from "../gw/gitsafe.mjs";

const gc = () => path.join(CFG.home, ".gitconfig");
const BROKEN = "[user]\n\tname = t\n# >>> cccodroid 托管：git 只信任登记过的项目目录（自动生成，别手改；见 gateway/gw/gitsafe.mjs）\n[safe]\n\tdirectory = /sdcard/evil-proj\n\tdirectory = /sdcard/evil-proj/*\n";
const read = () => fs.readFileSync(gc(), "utf8");

test("G7：缺 END 的残块，同步空表要清掉旧信任、用户配置保留", () => {
  fs.writeFileSync(gc(), BROKEN);
  syncGitSafe([]);
  assert.equal(read().includes("/sdcard/evil-proj"), false, "旧信任应清掉：\n" + read());
  assert.ok(read().includes("[user]"), "用户自己的配置保留：\n" + read());
  assert.equal(read().includes("directory ="), false, "不应残留任何 directory 行");
});

test("G7：缺 END 的残块，同步新项目表只留新块、不新旧并存", () => {
  fs.writeFileSync(gc(), BROKEN);
  syncGitSafe(["/tmp/g-ws2"]);
  assert.equal(read().includes("/sdcard/evil-proj"), false, "旧信任应清掉：\n" + read());
  assert.ok(read().includes("/tmp/g-ws2"), "新项目应写进去：\n" + read());
  assert.equal(read().indexOf("# >>> cccodroid"), read().lastIndexOf("# >>> cccodroid"), "只能有一个托管块：\n" + read());
});

test("G7 回归：完整块同步空表照旧清干净、同步新表照旧替换", () => {
  syncGitSafe(["/tmp/g-ws2"]);
  assert.ok(read().includes("/tmp/g-ws2"));
  syncGitSafe([]);
  assert.equal(read().includes("directory ="), false, "完整块同步空表应清干净：\n" + read());
});
