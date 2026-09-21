"use strict";

/**
 * 校验 src/settings.html 里内嵌的 <script> 语法，并断言插件行结构的两条硬约束。
 * 运行：node scripts/check-settings-html.cjs
 *
 * 为什么需要它：settings.html 的 JS 是内联在 HTML 里的，`node --check` 管不到；
 * 一处拼写错误会让整个设置窗口白屏，而单元测试看不到。
 *
 * 断言的结构约束（都踩过）：
 *   1. 启用开关必须在安装 <label> **外面**——HTML label 会把内部第一个可标注
 *      控件当成目标，嵌进去会导致「点启用」顺带切换安装勾选框（意外卸载）。
 *   2. 启用开关必须带 class="plg-enable"（渲染层与测试按它取元素）。
 */

const fs = require("node:fs");
const path = require("node:path");

const file = path.join(__dirname, "..", "src", "settings.html");
const html = fs.readFileSync(file, "utf8");

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log("  ok - " + name);
  } catch (error) {
    failures += 1;
    console.log("  FAIL - " + name + ": " + error.message);
  }
}

console.log("settings.html:");

check("内嵌 <script> 语法正确", () => {
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  if (blocks.length === 0) throw new Error("no inline <script> block found");
  for (const block of blocks) {
    // eslint-disable-next-line no-new-func
    new Function(block);
  }
});

check("安装/启用两个状态都在渲染里（不会只剩一个）", () => {
  for (const token of ["plg-check", "plg-enable", "enabledText"]) {
    if (!html.includes(token)) throw new Error("missing " + token);
  }
});

check("启用开关不在安装 <label> 内部（否则点击会连带切换安装）", () => {
  const start = html.indexOf("function renderPlugins");
  if (start < 0) throw new Error("renderPlugins not found");
  const end = html.indexOf("\n    }", start);
  const body = html.slice(start, end > 0 ? end : start + 6000);

  // Scope the check to the returned markup expression. Comparing raw indices over the
  // whole function is useless: `enableRow` is a template string built EARLIER in the
  // body that contains its own literal "</span></label>" (for its own label), so a
  // naive "index of </label> vs index of enableRow +" comparison holds even when the
  // enable row is moved inside the install label. Inside `return ( … )` the pieces are
  // concatenated linearly, so source order really is render order.
  const returnAt = body.indexOf("return (");
  if (returnAt < 0) throw new Error("renderPlugins has no `return (` expression");
  const open = body.indexOf("(", returnAt);
  let depth = 0;
  let close = -1;
  for (let i = open; i < body.length; i += 1) {
    const ch = body[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close < 0) throw new Error("unbalanced parentheses in the render expression");
  const markup = body.slice(open, close + 1);

  const labelOpen = markup.indexOf("'<label");
  const labelClose = markup.indexOf("</label>", labelOpen + 1);
  const enableUse = markup.indexOf("enableRow");
  if (labelOpen < 0) throw new Error("install <label> not found in the returned markup");
  if (labelClose < 0) throw new Error("install </label> not found in the returned markup");
  if (enableUse < 0) throw new Error("enableRow not interpolated in the returned markup");
  if (enableUse < labelClose) {
    throw new Error("enableRow is rendered INSIDE the install label (nested labels toggle the wrong box)");
  }
  // the toggle itself must exist in the row template (not just be referenced)
  const templateAt = body.indexOf("const enableRow");
  if (templateAt < 0) throw new Error("enableRow template not found");
  const template = body.slice(templateAt, templateAt + 1200);
  if (!/class="plg-enable"/.test(template)) throw new Error("enableRow template must render the .plg-enable switch");
});

check("i18n 中英文都有启用/禁用文案", () => {
  const keys = [
    "settings.plugins.enableLabel",
    "settings.plugins.enabled",
    "settings.plugins.disabled",
    "settings.plugins.disabledByMarket",
    "settings.plugins.disabledByPatch",
    "settings.plugins.driftHint",
    "settings.plugins.reloadPage",
    "settings.plugins.needRefresh",
  ];
  for (const key of keys) {
    const occurrences = html.split('"' + key + '"').length - 1;
    if (occurrences < 2) throw new Error(key + " should exist in both zh and en tables (found " + occurrences + ")");
  }
});

check("刷新页面按钮存在、默认隐藏，且由 refresh 信号驱动", () => {
  const tag = /<button id="btnReloadPage"[^>]*>/.exec(html);
  if (!tag) throw new Error("btnReloadPage button tag not found in the markup");
  if (!/\bhidden\b/.test(tag[0])) throw new Error("btnReloadPage must start hidden");
  // The enable/disable handler must react to the market's refresh signal and the
  // button must call the IPC that reloads the engine window.
  if (!/res\.refresh/.test(html)) throw new Error("the toggle handler must react to res.refresh");
  if (!/reloadEngineWindow/.test(html)) throw new Error("the reload button must call api.reloadEngineWindow");
});

check("「待重启引擎」标注存在、默认隐藏，且安装与卸载都会标注", () => {
  const tag = /<span id="restartBadge"[^>]*>/.exec(html);
  if (!tag) throw new Error("restartBadge span not found in the markup");
  if (!/\bhidden\b/.test(tag[0])) throw new Error("restartBadge must start hidden");
  // The label must exist in both language tables.
  const key = '"settings.plugins.needRestartBadge"';
  if (html.split(key).length - 1 < 2) throw new Error("needRestartBadge needs a zh and an en string");
  // One helper owns the badge + button highlight, and BOTH install and uninstall
  // mark it (both change the bundle list, which the engine composes only at boot).
  if (!/function markRestartNeeded\(/.test(html)) throw new Error("markRestartNeeded helper missing");
  if (!/function settleRestartBadge\(/.test(html)) throw new Error("settleRestartBadge helper missing");
  const marks = html.match(/markRestartNeeded\(true\)/g) || [];
  if (marks.length < 2) throw new Error("install AND uninstall must both mark the restart badge");
  if (!/markRestartNeeded\(changed\)/.test(html)) throw new Error("the repair path must follow its own result");
  if (!/settleRestartBadge\(s\)/.test(html)) throw new Error("paint() must settle the badge when the engine restarted");
  if (!/\.plg-need-restart/.test(html)) throw new Error("the badge needs its stylesheet rule");
});

if (failures > 0) {
  console.log("\nsettings.html: " + failures + " check(s) FAILED");
  process.exit(1);
}
console.log("\nsettings.html: all checks passed");
