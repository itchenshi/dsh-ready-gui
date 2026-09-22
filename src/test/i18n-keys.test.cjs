/* i18n-keys.test.cjs — 界面文案键的一致性检查（纯静态，不需要 Electron）。
 *
 * 为什么需要：`L()` 在找不到键时会**回退成键名本身**，所以一个漏定义的键不会报错，
 * 而是直接把 `common.cancel` 这样的字面量显示给用户。实际发生过：数据目录切换确认框的
 * 「取消」按钮用了 `common.cancel`，而这个键从未定义 —— 按钮上写着 `common.cancel`。
 *
 * 检查三件事：
 *   1. 每个 `L("键")` 都能在 zh 表里找到；
 *   2. 也能在 en 表里找到；
 *   3. zh 与 en 的键集合完全一致（防止只补一种语言）。
 *
 * 用法：node src/test/i18n-keys.test.cjs [main.js 路径]
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const file = process.argv[2] ?? path.join(__dirname, "..", "main.js");
const source = fs.readFileSync(file, "utf8");
const lines = source.split(/\r?\n/);

const zhStart = lines.findIndex((line) => /^\s{2}zh:\s*\{/u.test(line));
const enStart = lines.findIndex((line, index) => index > zhStart && /^\s{2}en:\s*\{/u.test(line));
const tableEnd = lines.findIndex((line, index) => index > enStart && /^\};/u.test(line));

let failures = 0;
const fail = (message) => {
  failures += 1;
  console.error(`  ✗ ${message}`);
};
const ok = (message) => console.log(`  ✓ ${message}`);

if (zhStart === -1 || enStart === -1 || tableEnd === -1) {
  console.error("i18n-keys: cannot locate the zh / en string tables in", file);
  process.exit(2);
}

/** `"key":` 形式的定义，限定在给定行范围内。 */
function keysIn(from, to) {
  const keys = new Set();
  for (let i = from; i < to; i += 1) {
    const match = /^\s*"([^"]+)"\s*:/u.exec(lines[i]);
    if (match) keys.add(match[1]);
  }
  return keys;
}

const zh = keysIn(zhStart, enStart);
const en = keysIn(enStart, tableEnd);

/** 所有 L("key") 调用（本文件的调用全部是字面量）。 */
const used = new Set();
for (const match of source.matchAll(/\bL\("([^"]+)"/gu)) used.add(match[1]);

console.log(`i18n-keys: ${path.relative(process.cwd(), file)}`);
console.log(`  zh 表 ${zh.size} 键 / en 表 ${en.size} 键 / 调用处用到 ${used.size} 键`);

const missingZh = [...used].filter((key) => !zh.has(key));
const missingEn = [...used].filter((key) => !en.has(key));
if (missingZh.length > 0) fail(`zh 表缺少这些被用到的键：${missingZh.join(", ")}`);
else ok("每个 L() 用到的键在 zh 表里都有定义");

if (missingEn.length > 0) fail(`en 表缺少这些被用到的键：${missingEn.join(", ")}`);
else ok("每个 L() 用到的键在 en 表里都有定义");

const onlyZh = [...zh].filter((key) => !en.has(key));
const onlyEn = [...en].filter((key) => !zh.has(key));
if (onlyZh.length > 0) fail(`只在 zh 表里：${onlyZh.join(", ")}`);
if (onlyEn.length > 0) fail(`只在 en 表里：${onlyEn.join(", ")}`);
if (onlyZh.length === 0 && onlyEn.length === 0) ok("zh / en 的键集合完全一致");

const unused = [...zh].filter((key) => !used.has(key));
if (unused.length > 0) console.log(`  · 未被 L() 直接引用的键（${unused.length}）：${unused.join(", ")}`);

console.log(`\n${failures === 0 ? "i18n-keys: all checks passed" : `i18n-keys: ${failures} check(s) FAILED`}`);
process.exitCode = failures === 0 ? 0 : 1;
