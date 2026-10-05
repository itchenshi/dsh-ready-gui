"use strict";

/**
 * engine-patch.js — DSH Ready GUI 对安装好的引擎客户端做的小补丁。
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
const { randomBytes } = require("node:crypto");

const LAST_MARKER = "/* dsh-gui-last-session-patch v4 */";
/**
 * Engines this fallback patch is known to apply to cleanly. NOTE: this is now
 * only a *hint* — the plugin `dsh-gui-last-session` is the primary
 * implementation and does not need this patch at all. See below.
 */
const SUPPORTED_ENGINE = "0.2.0-rc.2";
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
 * 移除锚点之后注入的补丁块（历史版本可能重复插入 v1/v2/v3，例如旧 GUI 补丁过同一
 * 引擎后新 GUI 又打一份），并清掉文件中游离的 vN 标记行。返回 false 表示无法安全
 * 定位边界（引擎布局变化），调用方必须放弃而非冒险删除。
 *
 * 边界**不能**用「下一个 `const slots = ctx.slots;`」来定：那是引擎自己的语句，注入块
 * 与它之间只要多出任何一行引擎代码（引擎升级时的正常改动），那片代码就会被一起删掉，
 * 而且删完仍是合法 JS —— 语法检查发现不了，等于静默破坏引擎页面。这里改为按**花括号
 * 配平**找出注入块自身的结束行：块体第一行是 `if (typeof window !== "undefined") {`，
 * 从它开始数括号，回到 0 即块结束。解不出配平（缺起始行 / 括号不闭合）就返回 false，
 * 交给调用方放弃。
 */
function stripInjectedBlocks(lines, anchorPatterns) {
  const anchorIdx = findBlock(lines, anchorPatterns);
  if (anchorIdx === -1) return false;
  for (;;) {
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
    // 块体的第一行 `{`（注入块本身是 `if (…) { … }` 一个整体）。
    let bodyStart = -1;
    for (let i = start + 1; i < lines.length && i - start <= 8; i += 1) {
      if (lines[i].trim().endsWith("{")) {
        bodyStart = i;
        break;
      }
    }
    if (bodyStart === -1) return false;
    // 花括号配平：跳过字符串/注释不可能引入花括号的干扰 —— 这段代码是我们自己注入的，
    // 只含 `{` `}` 与不含括号的表达式，直接计数即可。
    let depth = 0;
    let end = -1;
    for (let i = bodyStart; i < lines.length; i += 1) {
      const text = lines[i];
      for (const ch of text) {
        if (ch === "{") depth += 1;
        else if (ch === "}") depth -= 1;
      }
      if (depth === 0) {
        end = i;
        break;
      }
      if (depth < 0) return false; // 配平失败：不敢删
      if (i - bodyStart > 2000) break; // 防御：找不到结束行不冒险
    }
    if (end === -1) return false;
    lines.splice(start, end - start + 1);
    // 循环继续：旧 GUI 可能注入过多份，逐块删干净为止。
  }
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
  // 原文件的行尾风格要保住：这个文件有 16000+ 行，写回时统一 join("\n") 会把整份 CRLF
  // 文件改成 LF —— 虽然 JS 不在乎，但补丁后的文件与包自身的校验/完整性记录差异会变得
  // 没必要地大（也让人在 diff 里看不出真正改了什么）。
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
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
    "// v4：改用引擎 0.2.0 的真实 API —— 列表快照里没有 `current` 字段（会话控制器只发布",
    "// { ids, byId, phase, projectionsBySession }），`sessions.open()` 也已被移除（现在的入口是",
    "// ctx.uiWorkspace.openSession）。旧写法两处都是死代码：既不记录，也打不开。",
    "if (typeof window !== \"undefined\") {",
    "\tconst guiBridge = window.__dshGui;",
    "\tif (guiBridge && typeof guiBridge.setLastSession === \"function\") {",
    "\t\t// 投影元数据在列表状态里有两处（行上的 projectionValues，以及 state 级",
    "\t\t// projectionsBySession[id].values），行上那份只在 manager 附带时才有。",
    "\t\tconst metaOf = (st, id) => {",
    "\t\t\tconst row = st && st.byId ? st.byId[id] : void 0;",
    "\t\t\tconst onRow = row && row.projectionValues ? row.projectionValues.sessionListMetadata : void 0;",
    "\t\t\tif (onRow) return onRow;",
    "\t\t\tconst per = st && st.projectionsBySession ? st.projectionsBySession[id] : void 0;",
    "\t\t\treturn per && per.values ? per.values.sessionListMetadata : void 0;",
    "\t\t};",
    "\t\t// 0.2.0 的 `blank` 是展示位（保守为 true），所以“用过没有”还要看 lastPromptAt。",
    "\t\tconst usedRow = (st, id) => {",
    "\t\t\tconst row = st && st.byId ? st.byId[id] : void 0;",
    "\t\t\tif (row && row.blank === false) return true;",
    "\t\t\tconst meta = metaOf(st, id);",
    "\t\t\treturn !!meta && typeof meta.lastPromptAt === \"number\";",
    "\t\t};",
    "\t\tconst isSubagent = (st, id) => {",
    "\t\t\tconst row = st && st.byId ? st.byId[id] : void 0;",
    "\t\t\treturn !!row && (row.origin === \"subagent\" || row.parentId !== void 0);",
    "\t\t};",
    "\t\t// “最近一次对话”：优先快照里的 current（老引擎会发布），否则取最近被提问的那个。",
    "\t\tconst pickLast = () => {",
    "\t\t\tlet st = null;",
    "\t\t\ttry { st = sessions.list.getSnapshot(); } catch { return \"\"; }",
    "\t\t\tif (!st) return \"\";",
    "\t\t\tconst explicit = st.current;",
    "\t\t\tif (typeof explicit === \"string\" && explicit.indexOf(\"session-\") === 0 && !isSubagent(st, explicit)) return explicit;",
    "\t\t\tconst ids = Array.isArray(st.ids) && st.ids.length > 0 ? st.ids : Object.keys(st.byId || {});",
    "\t\t\tlet best = \"\";",
    "\t\t\tlet bestAt = -1;",
    "\t\t\tfor (const id of ids) {",
    "\t\t\t\tif (typeof id !== \"string\" || id.indexOf(\"session-\") !== 0) continue;",
    "\t\t\t\tif (isSubagent(st, id) || !usedRow(st, id)) continue;",
    "\t\t\t\tconst meta = metaOf(st, id);",
    "\t\t\t\tconst row = st.byId ? st.byId[id] : void 0;",
    "\t\t\t\tconst at = meta && typeof meta.lastPromptAt === \"number\" ? meta.lastPromptAt : (row && typeof row.updatedAt === \"number\" ? row.updatedAt : 0);",
    "\t\t\t\tif (at > bestAt) { bestAt = at; best = id; }",
    "\t\t\t}",
    "\t\t\treturn best;",
    "\t\t};",
    "\t\tlet lastRec = \"\";",
    "\t\tlet lastAt = 0;",
    "\t\tlet recordArmed = false;",
    "\t\tconst recordCurrent = () => {",
    "\t\t\tif (!recordArmed) return;",
    "\t\t\ttry {",
    "\t\t\t\tconst cur = pickLast();",
    "\t\t\t\tif (!cur) return;",
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
    "\t\t// 打开某个会话：0.2.0 用 workspace API（惰性解析 —— 它由另一个客户端插件提供，",
    "\t\t// 这段代码跑起来时未必已挂载），老引擎才回退到 sessions.open。",
    "\t\tconst openSession = (id) => {",
    "\t\t\tconst ws = (typeof ctx.get === \"function\" ? ctx.get(\"uiWorkspace\") : void 0) || ctx.uiWorkspace;",
    "\t\t\tif (ws && typeof ws.openSession === \"function\") return ws.openSession(String(id));",
    "\t\t\tif (typeof sessions.open === \"function\") return sessions.open(String(id));",
    "\t\t\tthrow new Error(\"no session-opening API on this engine\");",
    "\t\t};",
    "\t\tif (typeof guiBridge.getLastSession === \"function\" && window.__dshOpenLast === void 0) {",
    "\t\t\twindow.__dshOpenLast = () => {",
    "\t\t\t\t(async () => {",
    "\t\t\t\t\ttry {",
    "\t\t\t\t\t\tconst g = typeof window !== \"undefined\" ? window.__dshGui : void 0;",
    "\t\t\t\t\t\tif (!g || typeof g.getLastSession !== \"function\") return settleOpen();",
    "\t\t\t\t\t\tconst last = await g.getLastSession();",
    "\t\t\t\t\t\tconst sid = last && last.sessionId;",
    "\t\t\t\t\t\tif (!sid) return settleOpen();",
    "\t\t\t\t\t\tconst wait = (ms) => new Promise((r) => setTimeout(r, ms));",
    "\t\t\t\t\t\t// 会话列表与引擎自身引导都在启动后不久完成；轮询直到目标进入列表。",
    "\t\t\t\t\t\tfor (let i = 0; i < 200; i += 1) {",
    "\t\t\t\t\t\t\tlet listed = false;",
    "\t\t\t\t\t\t\ttry {",
    "\t\t\t\t\t\t\t\tconst st = sessions.list.getSnapshot();",
    "\t\t\t\t\t\t\t\tlisted = !!(st && st.byId && Object.prototype.hasOwnProperty.call(st.byId, String(sid)));",
    "\t\t\t\t\t\t\t} catch {}",
    "\t\t\t\t\t\t\tif (listed) {",
    "\t\t\t\t\t\t\t\ttry { openSession(String(sid)); } catch {}",
    "\t\t\t\t\t\t\t\tawait wait(60);",
    "\t\t\t\t\t\t\t\treturn settleOpen();",
    "\t\t\t\t\t\t\t}",
    "\t\t\t\t\t\t\tawait wait(150);",
    "\t\t\t\t\t\t}",
    "\t\t\t\t\t\ttry { openSession(String(sid)); } catch {}",
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
  const next = lines.join(eol);
  try {
    new Function("window", "__ModuleLoader__", next); // eslint-disable-line no-new-func
  } catch (error) {
    log(`last-session patch: patched file failed syntax check (${error.message}), reverted`);
    return { ok: false, reason: `patched syntax invalid: ${error.message}` };
  }
  // 原子写：这个文件就是引擎页面本身的代码，半个文件落地等于引擎页白屏。临时名必须
  // 唯一——同一台机器上可能存在另一个 GUI 实例在补同一份引擎（与补丁层的写法一致）。
  const tmpClient = `${clientFile}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmpClient, next, "utf8");
    fs.renameSync(tmpClient, clientFile);
  } catch (error) {
    try {
      fs.rmSync(tmpClient, { force: true });
    } catch {
      /* 临时文件清理尽力而为 */
    }
    log(`last-session patch: writing the patched file failed (${error.message}), engine file left unchanged`);
    return { ok: false, reason: `patched write failed: ${error.message}` };
  }
  log("last-session patch: applied v4 (auto reopen last conversation)");
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
  // 内部工具（导出供纯单测）。
  findBlock,
  insertAfter,
  indentOf,
  versionOf,
  injectedState,
  stripInjectedBlocks,
  applyLastSession,
  LAST_MARKER,
  LAST_PKG_REL,
  LAST_CLIENT_REL,
  SUPPORTED_ENGINE,
};
