"use strict";

/**
 * engine-patch.js — DSH GUI 对安装好的引擎客户端做的小补丁。
 *
 * 现仅保留一个：“重启后自动回到最近一次对话”的页内逻辑。它挂在引擎自带的
 * dsh-client-ui-conversation 的 apply(ctx) 开头（该模块已注入 sessions 服务）：
 *   - 记录：订阅 sessions.list 的 current 变化 → 经 window.__dshGui.setLastSession
 *     写入 <userData>/last-session.json（节流 1.5s，跳过 undefined）；
 *   - 重开：暴露 window.__dshOpenLast()，读取 last-session 后等会话绑定就绪并打开。
 *
 * 关键点（v2，修复“重启后不回上次会话”）：
 *   引擎自身在页面启动时也会做一次导航（ui-workspace 会为最近工作区打开/新建一个
 *   会话）。若我们的“记录”在 __dshOpenLast 读到 last-session.json 之前就把引擎自动
 *   打开的那个空白会话写进去，last-session 就被污染成“新建的空白会话”，重启后自然
 *   回不到上次对话。因此 v2 里记录在“重开动作结束（打开成功 / 无记录 / 放弃）”之前
 *   保持不启用：引擎的引导会话不会被记录，__dshOpenLast 始终读到真实的 last-session。
 *   同时给一个 ~4s 兜底定时器（设置关闭 / 无可重开会话时照常开始记录用户切换）。
 *
 * 改动是纯增量、幂等（带标记注释）；锚点缺失会跳过并告警，绝不破坏引擎——
 * 缺了它只是“重启自动回上次会话”失效，其余功能不受影响。
 * 自愈（v3）：不同代 GUI 可能在同一引擎文件上重复插入（旧 GUI 打了 v1、新 GUI 又
 * 插 v2），残留的双份页内逻辑会让“记录”在启动引导阶段就被旧块污染，导致“重启
 * 回最近对话”再次失效。每次应用时统计注入块/标记：不是“恰好一份最新块”就先
 * 移除全部历史注入（v1/v2/v3 均可按块边界定位），再重新插入一份干净的 v3。
 *
 * 适配：补丁按引擎版本校验（当前 rc.1）；引擎升级后若锚点变化会静默跳过并告警，
 * 由 GUI 安装流程在每次引擎安装后调用。
 */

const fs = require("node:fs");
const path = require("node:path");

const LAST_MARKER = "/* dsh-gui-last-session-patch v3 */";
/**
 * Engines this fallback patch is known to apply to cleanly. NOTE: this is now
 * only a *hint* — the plugin `dsh-gui-last-session` is the primary
 * implementation and does not need this patch at all. See below.
 */
const SUPPORTED_ENGINE = "0.1.2-rc.1";
const LAST_PKG = "@deepseek-ai/dsh-client-ui-conversation";
const LAST_CLIENT_REL = path.join("node_modules", LAST_PKG, "lib", "client.js");
const LAST_PKG_REL = path.join("node_modules", LAST_PKG, "package.json");

function indentOf(line) {
  const m = /^\s*/.exec(line);
  return m ? m[0] : "";
}

/**
 * 单行是否匹配某个锚点模式。
 *
 * 以 `*` 结尾表示**前缀**匹配：引擎的函数签名会随版本加参数
 * （`function apply(ctx) {` → `function apply(ctx, config = Config({})) {`），
 * 钉死整行会让补丁在每次引擎小版本更新后静默失效 —— 这正是它现在只作兜底、
 * 主实现改成插件的原因，但兜底本身也不该因为多了个参数就彻底不工作。
 */
function patternMatches(line, pattern) {
  const trimmed = line.trim();
  if (pattern.endsWith("*")) return trimmed.startsWith(pattern.slice(0, -1));
  return trimmed === pattern;
}

/** 在行数组中定位一段“trim 后逐行匹配”的连续块；返回起始行号或 -1。 */
function findBlock(lines, patterns) {
  outer: for (let i = 0; i <= lines.length - patterns.length; i += 1) {
    for (let k = 0; k < patterns.length; k += 1) {
      if (!patternMatches(lines[i + k], patterns[k])) continue outer;
    }
    return i;
  }
  return -1;
}

function insertAfter(lines, patterns, extra) {
  const idx = findBlock(lines, patterns);
  if (idx === -1) return false;
  const at = idx + patterns.length - 1;
  const indent = indentOf(lines[at]);
  lines.splice(at + 1, 0, ...extra.map((line) => `${indent}${line}`));
  return true;
}

function versionOf(engineDir, rel) {
  try {
    return JSON.parse(fs.readFileSync(path.join(engineDir, rel), "utf8")).version;
  } catch {
    return null;
  }
}

/** 移除已插入的旧补丁块（任意 vN 标记）。返回是否清除了内容。 */
function stripLegacyPatch(lines, anchorPatterns) {
  let removed = false;
  // 旧块只可能插在锚点之后、引擎原始代码之前。我们从锚点结束位置向后找旧块
  // 的首行（`// dsh-gui:` 注释）与结束行（它后面的下一行是引擎原代码
  // `const slots = ctx.slots;`，这是 ui-conversation apply 紧跟 sessions 解包的语句）。
  const anchorIdx = findBlock(lines, anchorPatterns);
  if (anchorIdx !== -1) {
    let start = -1;
    for (let i = anchorIdx + anchorPatterns.length; i < lines.length; i += 1) {
      if (lines[i].trim().startsWith("// dsh-gui:")) {
        start = i;
        break;
      }
    }
    if (start !== -1) {
      let end = -1;
      for (let i = start + 1; i < lines.length; i += 1) {
        const t = lines[i].trim();
        if (t === "const slots = ctx.slots;") {
          end = i;
          break;
        }
        // 引擎布局若不同，找不到结束行就整段放弃（不冒险）。
        if (i - start > 400) break;
      }
      if (end !== -1) {
        lines.splice(start, end - start);
        removed = true;
      }
    }
  }
  // 清掉行尾的旧版本标记（v1 等在文件末尾追加的注释行）。
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/dsh-gui-last-session-patch v\d+/.test(lines[i])) {
      lines.splice(i, 1);
      removed = true;
    }
  }
  return removed;
}

/** 注入痕迹统计：blocks = 以 `// dsh-gui:` 开头的补丁注释行数；markers = vN 标记行数。 */
function injectedState(lines) {
  let blocks = 0;
  let markers = 0;
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("// dsh-gui:")) blocks += 1;
    if (/dsh-gui-last-session-patch v\d+/.test(t)) markers += 1;
  }
  return { blocks, markers };
}

/**
 * 移除锚点之后、引擎原句 `const slots = ctx.slots;` 之前的**全部**注入块
 * （历史版本可能重复插入 v1/v2/v3，例如旧 GUI 补丁过同一引擎后新 GUI 又打一份），
 * 并清掉文件中游离的 vN 标记行。返回 false 表示无法安全定位边界（引擎布局变化），
 * 调用方必须放弃而非冒险删除。
 */
function stripInjectedBlocks(lines, anchorPatterns) {
  const anchorIdx = findBlock(lines, anchorPatterns);
  if (anchorIdx === -1) return false;
  let start = -1;
  for (let i = anchorIdx + anchorPatterns.length; i < lines.length; i += 1) {
    if (lines[i].trim().startsWith("// dsh-gui:")) {
      start = i;
      break;
    }
  }
  if (start === -1) {
    // 本就没有注入块：只清理可能的游离标记。
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if (/dsh-gui-last-session-patch v\d+/.test(lines[i])) lines.splice(i, 1);
    }
    return true;
  }
  let end = -1;
  for (let i = start + 1; i < lines.length; i += 1) {
    if (lines[i].trim() === "const slots = ctx.slots;") {
      end = i;
      break;
    }
    if (i - start > 2000) break; // 防御：找不到结束行不冒险
  }
  if (end === -1) return false;
  lines.splice(start, end - start);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    if (/dsh-gui-last-session-patch v\d+/.test(lines[i])) lines.splice(i, 1);
  }
  return true;
}

/**
 * 幂等应用“最近一次对话”补丁（dsh-client-ui-conversation）。
 * @returns {{ok:boolean, already?:boolean, reason?:string}}
 */
function applyLastSession(engineDir, log = () => {}) {
  const pkgFile = path.join(engineDir, LAST_PKG_REL);
  const clientFile = path.join(engineDir, LAST_CLIENT_REL);
  if (!fs.existsSync(pkgFile) || !fs.existsSync(clientFile)) {
    log("last-session patch: package not found, skipped");
    return { ok: false, reason: "client package missing" };
  }
  // 锚点：ui-conversation apply(ctx…) 的开头（sessions 服务已解包）。第一行用前缀匹配，
  // 免得引擎给 apply 加个 config 参数就让整个兜底补丁失效。
  const anchor = [
    "function apply(ctx*",
    "const sessions = ctx.sessions;",
  ];

  const text = fs.readFileSync(clientFile, "utf8");
  const lines = text.split(/\r?\n/);
  const { blocks, markers } = injectedState(lines);

  // 版本告警（不再是硬门槛）：这个补丁是 `dsh-gui-last-session` 插件的**兜底**，
  // 插件才是主实现。过去这里用 `!== SUPPORTED_ENGINE` 直接放弃，导致每次引擎
  // 更新都静默失效——这正是改用插件的原因。现在版本不匹配只记一条日志，真正
  // 的判断交给下面的锚点探测：锚点在就照常打（引擎多半兼容），锚点不在就放弃。
  const installedVersion = versionOf(engineDir, LAST_PKG_REL);
  if (installedVersion !== SUPPORTED_ENGINE) {
    log(
      `last-session patch: engine version ${installedVersion} differs from the verified ${SUPPORTED_ENGINE}; ` +
        "probing anchors instead of skipping",
    );
  }

  // 幂等快路径：恰好一份 v3 补丁块 + 一个 v3 标记 → 无需改动。
  if (blocks === 1 && markers === 1 && text.includes(LAST_MARKER)) {
    return { ok: true, already: true };
  }

  // 锚点探测：找不到说明引擎布局已变，放弃（绝不破坏引擎文件）。
  if (findBlock(lines, anchor) === -1) {
    log("last-session patch: apply(ctx) anchor missing on this engine build, engine file left unchanged");
    return { ok: false, reason: "apply(ctx) anchor missing" };
  }

  const block = [
    "",
    "// dsh-gui: 记住“最近一次对话”并在重启后自动打开（原 dsh-undo 页内逻辑，现由引擎补丁承载）。",
    "if (typeof window !== \"undefined\") {",
    "\tconst guiBridge = window.__dshGui;",
    "\tif (guiBridge && typeof guiBridge.setLastSession === \"function\") {",
    "\t\tlet lastRec = \"\";",
    "\t\tlet lastAt = 0;",
    "\t\tlet recordArmed = false;",
    "\t\tconst recordCurrent = () => {",
    "\t\t\tif (!recordArmed) return;",
    "\t\t\ttry {",
    "\t\t\t\tconst cur = sessions.list.getSnapshot().current;",
    "\t\t\t\tif (cur === void 0) return;",
    "\t\t\t\tconst now = Date.now();",
    "\t\t\t\tif (cur === lastRec && now - lastAt < 1500) return;",
    "\t\t\t\tlastRec = cur;",
    "\t\t\t\tlastAt = now;",
    "\t\t\t\tguiBridge.setLastSession(String(cur)).catch(() => {});",
    "\t\t\t} catch {}",
    "\t\t};",
    "\t\tconst armRecording = () => {",
    "\t\t\tif (recordArmed) return;",
    "\t\t\trecordArmed = true;",
    "\t\t\trecordCurrent();",
    "\t\t};",
    "\t\tctx.effect(() => {",
    "\t\t\trecordCurrent();",
    "\t\t\tconst dispose = sessions.list.subscribe(recordCurrent);",
    "\t\t\treturn () => {",
    "\t\t\t\tif (typeof dispose === \"function\") dispose();",
    "\t\t\t};",
    "\t\t}, \"dsh-gui: remember last session\");",
    "\t\t// 兜底：即便没有“回上次会话”意图（设置关闭 / 无可开），几秒后也启用记录。",
    "\t\tconst armTimer = setTimeout(armRecording, 4000);",
    "\t\tlet openSettled = false;",
    "\t\tconst settleOpen = () => {",
    "\t\t\tif (openSettled) return;",
    "\t\t\topenSettled = true;",
    "\t\t\tclearTimeout(armTimer);",
    "\t\t\tarmRecording();",
    "\t\t};",
    "\t\tif (typeof guiBridge.getLastSession === \"function\" && window.__dshOpenLast === void 0) {",
    "\t\t\tlet openLastAttempted = false;",
    "\t\t\twindow.__dshOpenLast = () => {",
    "\t\t\t\tif (openLastAttempted) return;",
    "\t\t\t\topenLastAttempted = true;",
    "\t\t\t\t(async () => {",
    "\t\t\t\t\ttry {",
    "\t\t\t\t\t\tconst g = typeof window !== \"undefined\" ? window.__dshGui : void 0;",
    "\t\t\t\t\t\tif (!g || typeof g.getLastSession !== \"function\") return settleOpen();",
    "\t\t\t\t\t\tconst last = await g.getLastSession();",
    "\t\t\t\t\t\tconst sid = last && last.sessionId;",
    "\t\t\t\t\t\tif (!sid) return settleOpen();",
    "\t\t\t\t\t\tconst wait = (ms) => new Promise((r) => setTimeout(r, ms));",
    "\t\t\t\t\t\t// 会话列表与引擎自身引导都在启动后不久完成；轮询直到目标绑定可用。",
    "\t\t\t\t\t\tfor (let i = 0; i < 200; i += 1) {",
    "\t\t\t\t\t\t\ttry {",
    "\t\t\t\t\t\t\t\tif (typeof sessions.binding === \"function\" && sessions.binding(String(sid)) !== void 0) {",
    "\t\t\t\t\t\t\t\t\tsessions.open(String(sid));",
    "\t\t\t\t\t\t\t\t\tawait wait(60);",
    "\t\t\t\t\t\t\t\t\treturn settleOpen();",
    "\t\t\t\t\t\t\t\t}",
    "\t\t\t\t\t\t\t} catch {}",
    "\t\t\t\t\t\t\tawait wait(150);",
    "\t\t\t\t\t\t}",
    "\t\t\t\t\t\ttry { sessions.open(String(sid)); } catch {}",
    "\t\t\t\t\t\tawait wait(60);",
    "\t\t\t\t\t\treturn settleOpen();",
    "\t\t\t\t\t} catch {",
    "\t\t\t\t\t\treturn settleOpen();",
    "\t\t\t\t\t}",
    "\t\t\t\t})();",
    "\t\t\t};",
    "\t\t}",
    "\t}",
    "}",
  ];

  // 自愈（v3）：清掉所有历史/重复注入（早期 GUI 可能在旧 GUI 打过 v1/v2 的引擎上
  // 又插了一份 v2，双份页内逻辑会让记录在启动引导阶段就被旧块污染 → “重启回最近
  // 对话”失效），再重新插入一份干净的 v3。幂等：已是最新且无重复则走上面快路径。
  try {
    const stripped = stripInjectedBlocks(lines, anchor);
    if (!stripped) {
      log("last-session patch: engine layout changed (cannot locate injected-block boundaries), engine file left unchanged");
      return { ok: false, reason: "engine layout changed" };
    }
    if (blocks > 0 || markers > 0) {
      log(`last-session patch: removed stale/duplicate injection (blocks=${blocks}, markers=${markers})`);
    }
  } catch (error) {
    log(`last-session patch: stale strip failed (${error.message}), aborting`);
    return { ok: false, reason: `stale strip failed: ${error.message}` };
  }

  if (!insertAfter(lines, anchor, block)) {
    log("last-session patch: apply(ctx) anchor missing, engine file left unchanged");
    return { ok: false, reason: "apply(ctx) anchor missing" };
  }
  lines.push(LAST_MARKER);
  const next = lines.join("\n");
  try {
    new Function("window", "__ModuleLoader__", next); // eslint-disable-line no-new-func
  } catch (error) {
    log(`last-session patch: patched file failed syntax check (${error.message}), reverted`);
    return { ok: false, reason: `patched syntax invalid: ${error.message}` };
  }
  fs.writeFileSync(clientFile, next, "utf8");
  log("last-session patch: applied v3 (auto reopen last conversation)");
  return { ok: true };
}

/** 幂等：对已安装引擎应用补丁（若已打或版本不符则跳过）。 */
function ensureEnginePatches({ engineDir, log = () => {} }) {
  try {
    const lastSession = applyLastSession(engineDir, log);
    return { ok: lastSession.ok, lastSession };
  } catch (error) {
    log("last-session patch failed:", error.message);
    return { ok: false, reason: String(error && error.message) };
  }
}

module.exports = {
  ensureEnginePatches,
  ensureLastSessionPatches: ({ engineDir, log = () => {} }) => {
    try {
      return applyLastSession(engineDir, log);
    } catch (error) {
      log("last-session patch failed:", error.message);
      return { ok: false, reason: String(error && error.message) };
    }
  },
  // 内部工具（导出供纯单测）。
  findBlock,
  insertAfter,
  indentOf,
  versionOf,
  stripLegacyPatch,
  injectedState,
  stripInjectedBlocks,
  LAST_MARKER,
  SUPPORTED_ENGINE,
};
