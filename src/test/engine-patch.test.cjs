/* engine-patch.test.cjs — engine-patch 内部工具纯单测（不依赖已装引擎）。 */
"use strict";

const {
  findBlock,
  insertAfter,
  indentOf,
  versionOf,
  stripInjectedBlocks,
  LAST_MARKER,
  SUPPORTED_ENGINE,
} = require("../engine-patch.js");

let failed = 0;
function check(name, cond, message) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${name}${message ? `\n    ${message}` : ""}`);
  }
}

check("indentOf 提取行首空白", indentOf("\t\tabc") === "\t\t" && indentOf("abc") === "");

{
  const lines = ["function x() {", "  hello();", "world();", "}"];
  const idx = findBlock(lines, ["hello();", "world();"]);
  check("findBlock 定位连续块", idx === 1, `got ${idx}`);
  check("findBlock 缺失返回 -1", findBlock(lines, ["missing"]) === -1);
}

{
  const lines = ["a", "\t\tb,", "c"];
  const ok = insertAfter(lines, ["b,"], ["NEW()", "OTHER()"]);
  check("insertAfter 成功", ok === true);
  check("insertAfter 保留锚点", lines[1] === "\t\tb,");
  check("insertAfter 插入并继承缩进", lines[2].trim() === "NEW()" && lines[2].startsWith("\t\t") && lines[3].trim() === "OTHER()");
}

check("常量 LAST_MARKER/版本", typeof LAST_MARKER === "string" && LAST_MARKER.length > 0 && SUPPORTED_ENGINE === "0.1.2-rc.1");

{
  const os = require("node:os");
  const path = require("node:path");
  check("versionOf 缺文件返回 null", versionOf(os.tmpdir(), "no-such-package.json") === null);
}

{
  // stripInjectedBlocks：注入块可能重复（旧 GUI 打过 v1/v2，新 GUI 又插 v3），它必须
  // 清掉**全部**历史注入、保留锚点与引擎原代码。这里模拟「锚点 → 旧块 → 重复块 → const slots」。
  const anchor = ["function apply(ctx) {", "const sessions = ctx.sessions;"];
  const legacy = [
    "",
    "// dsh-gui: 记住“最近一次对话”并在重启后自动打开（旧版块）。",
    "if (typeof window !== \"undefined\") {",
    "\tconst bridge = window.__dshGui;",
    "\tctx.effect(() => {}, \"dsh-gui: remember last session\");",
    "}",
  ];
  const duplicate = [
    "",
    "// dsh-gui: 记住“最近一次对话”并在重启后自动打开（重复插入的第二份）。",
    "if (typeof window !== \"undefined\") {",
    "\tctx.effect(() => {}, \"dsh-gui: remember last session (dup)\");",
    "}",
  ];
  const tail = [
    "",
    "\tconst slots = ctx.slots;",
    "\tconst after = true;",
    "}",
    "/* dsh-gui-last-session-patch v3 */",
  ];

  const lines = [...anchor, ...legacy, ...duplicate, ...tail];
  check("stripInjectedBlocks 返回 true", stripInjectedBlocks(lines, anchor) === true);
  check("stripInjectedBlocks 清掉全部注入块", lines.every((l) => !l.trim().startsWith("// dsh-gui:")));
  check("stripInjectedBlocks 清掉游离标记", lines.every((l) => !/dsh-gui-last-session-patch v\d+/.test(l)));
  check(
    "stripInjectedBlocks 保留锚点",
    lines[0].trim() === "function apply(ctx) {" && lines[1].trim() === "const sessions = ctx.sessions;",
  );
  const joined = lines.join("\n");
  check(
    "stripInjectedBlocks 保留 slots 与尾随代码",
    joined.includes("const slots = ctx.slots;") && joined.includes("const after = true;"),
  );
  check("stripInjectedBlocks 不留旧块", !joined.includes("remember last session"));

  // 没有注入块、只有游离标记时也必须返回 true（否则 applyLastSession 会误判成“布局变了”而放弃打补丁）。
  const markerOnly = [
    "function apply(ctx) {",
    "const sessions = ctx.sessions;",
    "const slots = ctx.slots;",
    "/* dsh-gui-last-session-patch v1 */",
  ];
  check(
    "stripInjectedBlocks 无块但有标记 → true 且清标记",
    stripInjectedBlocks(markerOnly, anchor) === true && !markerOnly.join("\n").includes("patch v1"),
  );

  // 锚点缺失 → false（调用方据此放弃，绝不冒险删改引擎文件）。
  check("stripInjectedBlocks 锚点缺失返回 false", stripInjectedBlocks([...anchor, ...legacy], ["function nope() {"]) === false);

  // 有注入块但找不到结束行（引擎布局变了）→ false，同样不删。
  const noEnd = [...anchor, ...legacy, "\tconst slotsRenamed = ctx.slots;"];
  check("stripInjectedBlocks 结束行缺失返回 false", stripInjectedBlocks(noEnd, anchor) === false);
}

console.log(`\n${failed === 0 ? "all" : failed + " failed"}`);
if (failed > 0) process.exitCode = 1;
