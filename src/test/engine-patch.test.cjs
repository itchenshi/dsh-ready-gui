/* engine-patch.test.cjs — engine-patch 内部工具纯单测（不依赖已装引擎）。 */
"use strict";

const {
  findBlock,
  insertAfter,
  indentOf,
  versionOf,
  stripInjectedBlocks,
  injectedState,
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

  // 有注入块但块体括号不闭合（文件被截断 / 布局异常）→ false，同样不删。
  // 注意判据是**块自身**的括号配平，不是「后面有没有 const slots」——后者曾经是判据，
  // 而那正是下面这条回归用例要防的破坏。
  const truncated = [
    "function apply(ctx) {",
    "const sessions = ctx.sessions;",
    "// dsh-gui: 半截块",
    "if (typeof window !== \"undefined\") {",
    "\tctx.effect(() => {}, \"x\");",
  ];
  const truncatedCopy = truncated.slice();
  check("stripInjectedBlocks 块体不闭合返回 false", stripInjectedBlocks(truncated, anchor) === false);
  check("stripInjectedBlocks 放弃时一行都不删", JSON.stringify(truncated) === JSON.stringify(truncatedCopy));

  // 回归：注入块与引擎原句 `const slots = ctx.slots;` 之间只要多出**任何一行引擎代码**，
  // 旧实现（用「下一个 const slots」当结束边界）就会把那片引擎代码一起删掉，而且删完仍是
  // 合法 JS —— 语法检查发现不了，等于静默破坏引擎页面。结束边界必须取自块自身的括号配平。
  const between = [
    "function apply(ctx) {",
    "const sessions = ctx.sessions;",
    "",
    "// dsh-gui: 记住“最近一次对话”并在重启后自动打开。",
    "if (typeof window !== \"undefined\") {",
    "\tconst bridge = window.__dshGui;",
    "\tif (bridge) {",
    "\t\tctx.effect(() => {}, \"dsh-gui: remember last session\");",
    "\t}",
    "}",
    "\tconst localeService = ctx.locale;",
    "\tctx.effect(() => {});",
    "\tconst slots = ctx.slots;",
    "\treturn { slots };",
    "}",
  ];
  const okBetween = stripInjectedBlocks(between, anchor);
  const betweenJoined = between.join("\n");
  check("stripInjectedBlocks 块后仍有引擎代码时返回 true", okBetween === true);
  check(
    "stripInjectedBlocks 只删注入块，块后的引擎代码原样保留",
    betweenJoined.includes("const localeService = ctx.locale;") &&
      betweenJoined.includes("ctx.effect(() => {});") &&
      betweenJoined.includes("const slots = ctx.slots;") &&
      !betweenJoined.includes("dsh-gui:"),
  );
  check(
    "stripInjectedBlocks 删除行数恰好等于块体行数",
    between.length === 8,
    `expected 8 lines left, got ${between.length}: ${JSON.stringify(between)}`,
  );

  // injectedState 是「这个兜底补丁现在处于什么状态」的唯一判据（注入过没有、是哪个版本），
  // 而它此前只有生产调用、没有用例。它的两个计数各有精确契约，写错就会让补丁要么重复注入、
  // 要么以为没注入而跳过。
  check("injectedState 干净文件为 0/0", JSON.stringify(injectedState(["const a = 1;", "", "// 普通注释"])) === '{"blocks":0,"markers":0}');

  const withBlocks = [
    "\t// dsh-gui: injected block one",
    "\tconst x = 1;",
    "\t// dsh-gui: injected block two",
    "\t// dsh-gui-last-session-patch v1",
    "\t// dsh-gui-last-session-patch v7",
    "\t// dsh-gui: 中文注释也算（按前缀判定，不看内容）",
    "\t// dsh-gui-last-session-patch v",
  ];
  const state = injectedState(withBlocks);
  check("injectedState 数 `// dsh-gui:` 前缀块（含缩进与中文）", state.blocks === 3, `got ${state.blocks}`);
  check("injectedState 只数带数字版本号的标记", state.markers === 2, `got ${state.markers}`);

  // 关键不变量：在**真实夹具**上清理之后计数必须归零 —— 这正是「可以安全再次注入」的前提。
  // （用一个不存在的锚点去调用会被正确地拒绝，那样什么都不会变，所以必须复用上面的 anchor。）
  const before = injectedState([...anchor, ...legacy, ...duplicate, ...tail]);
  check("injectedState 在真实夹具上看到注入痕迹", before.blocks === 2 && before.markers === 1, JSON.stringify(before));
  const cleaned = [...anchor, ...legacy, ...duplicate, ...tail];
  stripInjectedBlocks(cleaned, anchor);
  const after = injectedState(cleaned);
  check("injectedState 在 strip 之后归零", after.blocks === 0 && after.markers === 0, JSON.stringify(after));
}

console.log(`\n${failed === 0 ? "all" : failed + " failed"}`);
if (failed > 0) process.exitCode = 1;
