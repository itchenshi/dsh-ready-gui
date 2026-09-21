"use strict";

/**
 * plugin-manager.js — DSH GUI 对 dsh 引擎 web profile 的第三方插件管理。
 *
 * 引擎从 0.1.2-rc.1 起内置官方插件机制：在 <DSH_HOME>/profiles/web 里用 pnpm
 * 安装声明 `dsh.bundle` 的 npm 包，并把包名登记进该 profile 的 package.json
 * `dsh.profile.bundles`（`dsh plugin --profile web add <pkg>` 完成安装+登记；
 * `remove` 反向）。引擎启动时按 bundles 列表加载每个包的 cordis.patch 补丁层。
 *
 * 本模块：
 *   - 维护一个“启动自动挂载”候选目录（经核实的社区插件）；
 *   - 按需用 bundled npm 自举 pnpm（`dsh plugin` 子命令内部转发给 pnpm）；
 *   - 以同一 DSH_HOME 运行 `node <engineBin> plugin --profile web <add|remove>`；
 *   - 提供已装状态（bundles 列表 + profile node_modules 实存）供设置页展示；
 *  - 引擎兼容性门控：目录条目声明 engineRange 且不满足当前引擎时，绝不安装；
 *     已装且由 GUI 勾选管理的会在 spawn 引擎前自动移除（这类插件会让 profile
 *     启动崩溃，如 dsh-agent-teams 0.1.15 ↔ dsh 0.1.2-rc.1）；非 GUI 勾选的
 *     已装插件保留不动，交给“启动失败诊断”弹窗由用户决定，避免误清理。
 *
 * 仓库自带的捆绑插件（CATALOG 中带 `localSource` 的项，位于 <repo>/plugins）
 * 不直接按 app.asar 内路径安装——打包后该目录在 app.asar 里，子进程 pnpm 无法
 * 读取（会把 app.asar 当普通文件，“as it does not exist”）。主进程 Electron fs
 * 能透明读 asar，因此先把捆绑插件 staging 成磁盘上的真实目录（主进程传的无空格
 * 根目录 <home>\.dsh-gui\bundled-plugins，必要时 8.3 短路径），再让 pnpm 安装
 * 那份拷贝（见 stageBundledPlugin / syncEnabledPlugins）。
 *
 * 安全说明：第三方插件=以你的权限在你的机器上运行的第三方代码。设置窗口勾选
 * 即安装、取消即卸载；默认全部关闭（未勾选一律不装）。列表只收录在官方目录
 * 核实过的包名，避免同名误装。
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createRequire } = require("node:module");
const semver = require("semver");

/** 候选目录：id 用于设置持久化；pkg 是 npm 安装名（需与目录核实一致）。
 *  顺序 = 设置窗口里的展示顺序（插件市场 → 最近会话恢复 → OpenCode Go 用量
 *  → OpenCode Go 增强），改这里即可调整界面次序。 */
const CATALOG = [
  {
    id: "dsh-market",
    pkg: "dshmarket",
    zh: "插件市场（dsh-market）",
    en: "Plugin marketplace (dsh-market)",
    zhDesc: "内置的可视化插件市场：浏览、搜索、一键安装社区插件。",
    enDesc: "Visual plugin market inside DeepSeek Harness: browse, search, and one-click install community plugins.",
    url: "https://github.com/dsh-market/dsh-market",
  },
  {
    id: "dsh-gui-last-session",
    // Local source install, same mechanism as dsh-opencode-go below:
    // distributed in this repository under plugins/<localSource>, staged to a
    // real directory before pnpm installs it (see stageBundledPlugin).
    //
    // This plugin replaces the old engine-file patch for "reopen the last
    // conversation" (src/engine-patch.js). That patch edited the engine's own
    // dsh-client-ui-conversation/lib/client.js and gated on an exact engine
    // version, so every engine update silently disabled the feature. The plugin
    // lives in its own package and uses the published ctx.sessions contract, so
    // engine updates no longer delete it.
    //
    // engineRange: 这里**刻意不设**版本门控。
    //
    // 最初写成 "0.1.2-rc.1"（照搬旧补丁的思路），结果在用户实际的 0.1.5-rc.1 上
    // 被门控拦下、无法勾选安装——正是「换版本就失效」的老毛病换了个位置复发。
    // 改写成区间也不成立：npm semver 的预发布规则决定了 `>=0.1.2-0 <0.2.0` 这类
    // 区间**不包含** 0.1.5-rc.1（除非区间在那个 [major,minor,patch] 上显式写了
    // 预发布标识）。而 GUI 默认通道就是会拿到 rc/alpha，所以钉区间等于继续误杀。
    //
    // 关键判断：这个插件依赖的是**公开服务契约**，不是引擎版本号。已逐项核实
    // 0.1.2-rc.1 与 0.1.5-rc.1 上契约一致：
    //   - ISessions.list / open / binding 均在；
    //   - SessionListState.current / byId / blank 均在；
    //   - 宿主服务名仍是 webServer；页内注入包名仍是
    //     @deepseek-ai/dsh-api-session-controller。
    //
    // 所以不拦。万一将来引擎真的改了契约，插件会在启动时**显式报错**（引擎会报
    // 插件加载失败），而不是像旧补丁那样静默失效——那时再按实际报错修适配即可。
    // （对比：dsh-agent-teams 那种「装上去直接把引擎打崩」的插件才需要 engineRange，
    //  这个插件最坏情况只是「没恢复会话」，不会影响引擎启动。）
    pkg: "dsh-gui-last-session",
    localSource: "dsh-gui-last-session",
    zh: "最近会话恢复（dsh-gui-last-session）",
    en: "Reopen last session (dsh-gui-last-session)",
    zhDesc: "启动后自动回到最近一次对话，不再修改引擎文件（引擎更新不会让功能失效）。",
    enDesc: "Reopens the conversation you were last in after a restart, without patching engine files (engine updates can't break it).",
    url: "",
  },
  {
    id: "dsh-model-usage",
    // Local source install，与 dsh-opencode-go / dsh-gui-last-session 同一机制。
    //
    // 在会话标题右侧、打开功能按钮左侧显示**模型用量 / 账户余额**，按该会话当前
    // 选中的模型路由分流（仅在使用对应模型时显示）：
    //   - OpenCode Go 模型 → 套餐用量（滚动/周/月 百分比 + 重置时间）：
    //     宿主侧经 ctx.credentials 取 OPENCODE_GO_API_KEY，请求
    //     GET https://opencode.ai/zen/go/v1/usage；
    //   - DeepSeek 模型（路由 deepseek-official）→ 账户余额（总/赠送/充值）：
    //     取 DEEPSEEK_API_KEY，请求 GET https://api.deepseek.com/user/balance。
    //   两条上游都在宿主侧完成，密钥绝不下发浏览器；页内注册到
    //   conversation.session.header.actions，按 ctx.modelDirectories 的
    //   current.provider 决定显示哪一段（provider→段 的映射由宿主的 sections 下发，
    //   改 cordis.patch.yml 的 providers 即可，无需改页内代码）。
    //
    // 原名 dsh-opencode-go-usage（只管 OpenCode Go），加入 DeepSeek 余额后更名；
    // 旧包名在 LEGACY_PLUGIN_PKGS 里做一次性清理（见 removeLegacyPlugins）。
    //
    // 与 dsh-gui-last-session 同样**不设 engineRange**：依赖的是公开服务契约
    // （ctx.credentials / ctx.webServer / ctx.slots / ctx.modelDirectories），不是
    // 引擎版本号；契约若变，引擎会显式报插件加载失败，而不是静默失效。
    //
    // 注意 dsh.client 里**不要**声明 inject：实测把已加载的包名写进去会让整批
    // 客户端 bundle 被重复执行（duplicate factory registration），进而拖垮页面。
    // 本插件不需要额外的加载顺序约束（页内用 ctx.slots.inject 自行等待 slot）。
    pkg: "dsh-model-usage",
    localSource: "dsh-model-usage",
    zh: "模型用量与余量（dsh-model-usage）",
    en: "Model usage & balance (dsh-model-usage)",
    zhDesc: "在会话标题右侧显示当前模型的用量/余量：OpenCode Go 显示套餐用量与选中模型月上限，DeepSeek 显示账户余额。仅在使用对应模型时出现。",
    enDesc: "Shows usage/balance for the active model right of the session title: OpenCode Go plan usage and the selected model's monthly cap, plus DeepSeek account balance, only for the matching model.",
    url: "",
  },
  {
    id: "dsh-opencode-go",
    // Local source install: this plugin is distributed in this repository under
    // plugins/<localSource> and is never fetched from the npm registry.
    // `pkg` is the TRUE package name (the key used in the profile bundles
    // registry / node_modules / settings UI). The bundled folder cannot be
    // installed straight from the app bundle: in packaged builds it lives
    // inside app.asar, which a child pnpm process cannot read (app.asar looks
    // like a plain file to it). plugin-manager therefore stages a real copy
    // under the pnpm tools dir first and installs that (see stageBundledPlugin).
    //
    // 合并自原 dsh-opencode-go-session + dsh-opencode-go-api（两者在
    // LEGACY_PLUGIN_PKGS 里做一次性迁移）。三件事：
    //   1) cordis.patch.yml（配置层）：给引擎装配层的 `llm-pi-ai` row 补
    //      providers.opencode-go.api: openai-completions。修的是
    //        llm-pi-ai: provider "opencode-go" model "<目录外模型>" needs an api; ...
    //      这类报错——opencode-go 目录内模型横跨三种协议（anthropic-messages /
    //      openai-completions / openai-responses），引擎无法从目录推断共享协议，
    //      目录外模型就必须由路由显式声明 api。补上后，GUI 模型页「添加模型」的
    //      严格校验（保存路径）也能通过。
    //   2) lib/index.js（运行时）：引擎启动后检查模型列表——若存在 opencode-go
    //      路由且 models 里还没有 deepseek-v4.1-*，就自动追加（走与 GUI 模型页
    //      相同的 settings.update 写入路径，幂等）。
    //   3) 为发往 OpenCode / OpenCode Go 的请求附加按会话 x-opencode-session
    //      头（修复 400 MissingSessionID；默认用不透明 UUID，绝不发内部会话 ID）。
    //
    // 与 dsh-gui-last-session / dsh-model-usage 同样**不设 engineRange**：依赖的是
    // 引擎装配层、settings 服务与 llm 事件的公开契约（bundle patch 按 row id 合并
    // + llm-pi-ai 的 profile schema 接受 route 级 `api` 字段 + ctx.settings
    // update/section/describe + llm/stream 瀑布），不是引擎版本号。
    pkg: "dsh-opencode-go",
    localSource: "dsh-opencode-go",
    zh: "OpenCode Go 增强（dsh-opencode-go）",
    en: "OpenCode Go toolkit (dsh-opencode-go)",
    zhDesc: "声明 opencode-go 路由协议并自动补 DeepSeek V4.1 模型；同时附加会话头，修复 400 MissingSessionID。",
    enDesc: "Declares the opencode-go route protocol, auto-adds DeepSeek V4.1 models, and attaches the session header that fixes 400 MissingSessionID.",
    url: "",
  },
];

const CATALOG_IDS = new Set(CATALOG.map((entry) => entry.id));

/** npm 包名 -> catalog 项。 */
function catalogByPkg() {
  const map = new Map();
  for (const entry of CATALOG) map.set(entry.pkg, entry);
  return map;
}

/** 当前引擎版本（<engineDir>/node_modules/@deepseek-ai/dsh 的 version），读不到返回 null。 */
function readEngineVersion(engineDir) {
  try {
    const file = path.join(engineDir, "node_modules", "@deepseek-ai", "dsh", "package.json");
    return JSON.parse(fs.readFileSync(file, "utf8")).version ?? null;
  } catch {
    return null;
  }
}

/**
 * 条目是否兼容指定引擎版本。未声明 engineRange、或引擎版本未知时不拦
 * （保持旧行为）；引擎版本不满足 range 时视为不兼容——这类插件在旧/新宿主上
 * 可能直接让 profile 启动崩溃（如 dsh-agent-teams 0.1.15 ↔ 0.1.2-rc.1）。
 */
function engineSatisfies(entry, engineVersion) {
  if (!entry.engineRange) return true;
  if (!engineVersion) return true;
  try {
    return semver.satisfies(engineVersion, entry.engineRange);
  } catch {
    return true;
  }
}

/** 引擎兼容性概览：id -> { ok: boolean|null, range: string|null }（设置页展示用）。 */
function catalogEngineCompat(engineVersion) {
  const out = {};
  for (const entry of CATALOG) {
    out[entry.id] = entry.engineRange
      ? { ok: engineSatisfies(entry, engineVersion), range: entry.engineRange }
      : { ok: true, range: null };
  }
  return out;
}

/** npm 目录条目的安装 spec：声明了 version 的条目装固定版本（目录核实过的组合）。 */
function registrySpec(entry) {
  return entry.version ? `${entry.pkg}@${entry.version}` : entry.pkg;
}

/** 解析 bundled / 环境 npm 提供者（与主进程逻辑一致，可独立跑）。 */
function resolveNpmCli(nodeExec) {
  const candidates = [
    path.join(path.dirname(nodeExec), "node_modules", "npm", "bin", "npm-cli.js"),
    path.join(path.dirname(nodeExec), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
    process.env.DSH_SHELL_NPM_CLI,
  ].filter(Boolean);
  return candidates.find((p) => p && fs.existsSync(p)) || null;
}

function runNpm(nodeExec, cli, args, { cwd, envExtra = {}, log = () => {}, timeoutMs = 180000, npmCacheDir }) {
  return new Promise((resolve, reject) => {
    log("npm", [cli, ...args].join(" "));
    const child = spawn(nodeExec, [cli, ...args], {
      cwd,
      env: {
        ...process.env,
        ...(npmCacheDir ? { npm_config_cache: npmCacheDir } : {}),
        npm_config_update_notifier: "false",
        npm_config_fund: "false",
        npm_config_audit: "false",
        ...envExtra,
      },
      windowsHide: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let tail = "";
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch {}
    }, timeoutMs);
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => {
      tail = (tail + chunk).split(/\r?\n/u).slice(-8).join("\n");
    });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`npm exited with ${code}\n${tail}`));
    });
  });
}

/**
 * 自举 pnpm：按需用 bundled npm 安装 pnpm（已装且主版本匹配时直接复用）。
 *
 * pnpm 主版本决定 store 布局：pnpm 10 用 store v10，pnpm 12 用 store v11 等。
 * 一个 profile 的 node_modules 由哪个主版本构建（.modules.yaml 的
 * packageManager/pnpmVersion）就只能用同主版本的 pnpm 继续操作，混用会报
 * `ERR_PNPM_UNEXPECTED_STORE`。因此：
 *  - `pnpmSpec` 缺省 "pnpm@10"（GUI 自建 profile 的默认主版本）；
 *  - 非 10 主版本装到 <installDir>/pnpm-<major>/ 子目录，与默认的 pnpm 10
 *    共存，互不干扰；
 *  - 已装目录的主版本与请求不符时整目录重装。
 * @param {object} o
 * @param {string} [o.pnpmSpec] 例如 "pnpm@10" / "pnpm@12.3.4"。
 * @returns {Promise<string>} pnpm bin 目录（把该目录加到 PATH 即可让 `pnpm` 可解析）。
 */
async function ensurePnpm({ installDir, pnpmSpec = "pnpm@10", nodeExec, log = () => {}, npmCacheDir }) {
  const major = /^pnpm@(\d+)/.exec(pnpmSpec)?.[1] || "10";
  // 主版本 10 沿用既有目录布局（<installDir>/node_modules/...），其余主版本隔离
  // 到 <installDir>/pnpm-<major>/，这样同一台机器可同时服务不同 store 的 profile。
  const toolDir = major === "10" ? installDir : path.join(installDir, `pnpm-${major}`);
  const binDir = path.join(toolDir, "node_modules", ".bin");
  const pnpmMeta = path.join(toolDir, "node_modules", "pnpm", "package.json");
  const existingMajor = (() => {
    try {
      const version = JSON.parse(fs.readFileSync(pnpmMeta, "utf8")).version;
      return typeof version === "string" ? version.split(".")[0] : null;
    } catch {
      return null;
    }
  })();
  if (existingMajor === major) return binDir;
  if (existingMajor !== null) log("pnpm major changed, reinstalling:", existingMajor, "->", major);
  await fsp.rm(toolDir, { recursive: true, force: true });
  await fsp.mkdir(toolDir, { recursive: true });
  const npmCli = resolveNpmCli(nodeExec);
  if (!npmCli) throw new Error("npm CLI unavailable; cannot provision pnpm");
  await runNpm(
    nodeExec,
    npmCli,
    ["install", pnpmSpec, "--prefix", toolDir, "--no-save", "--no-audit", "--no-fund", "--loglevel", "error"],
    { log, timeoutMs: 240000, npmCacheDir },
  );
  if (!fs.existsSync(pnpmMeta)) throw new Error("pnpm provisioning failed");
  log("pnpm ready at", toolDir);
  return binDir;
}

/**
 * 该 profile 的 node_modules 由哪个 pnpm 构建（读 .modules.yaml 的
 * packageManager / pnpmVersion，如 "pnpm@12.3.4"），读不到返回 null。
 * 调用方据此选用相同主版本的 pnpm，避免 ERR_PNPM_UNEXPECTED_STORE。
 */
function readProfilePnpmManager(dshHome) {
  try {
    const raw = fs.readFileSync(
      path.join(profileDir(dshHome), "node_modules", ".modules.yaml"),
      "utf8",
    );
    // key/value 都可能带 JSON 引号：`"packageManager": "pnpm@12.3.4",`
    // 或 YAML 风格 `packageManager: pnpm@12.3.4`（旧字段 pnpmVersion 值不带前缀）。
    const m = /"?((?:packageManager|pnpmVersion))"?\s*:\s*"?(?:pnpm@)?(\d+\.\d+\.\d+)/.exec(raw);
    return m ? `pnpm@${m[2]}` : null;
  } catch {
    return null;
  }
}

/** 返回 dsh 引擎 bin 路径。 */
function engineBin({ engineDir }) {
  const bin = path.join(engineDir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  return fs.existsSync(bin) ? bin : null;
}

function profileDir(dshHome) {
  return path.join(dshHome, "profiles", "web");
}

/** 读取 profile 清单（不存在返回 null）。 */
function readProfileManifest(dshHome) {
  const file = path.join(profileDir(dshHome), "package.json");
  try {
    const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function installedBundles(dshHome) {
  const manifest = readProfileManifest(dshHome);
  const bundles = manifest?.dsh?.profile?.bundles;
  return Array.isArray(bundles) ? bundles : [];
}

// ---------------------------------------------------------------------------
// 启用 / 禁用（与 dshmarket 共用同一套官方机制）
// ---------------------------------------------------------------------------
//
// 插件有**两个正交状态**，必须分别显示、分别同步：
//   1. 安装 / 卸载 —— profile 的 dsh.profile.bundles（+ node_modules 实存），
//      由 `dsh plugin add|remove` 改写；设置窗口的勾选框镜像它。
//   2. 启用 / 禁用 —— profile 用户补丁层 <profile>/cordis.patch.yml 里
//      `- id: <rowId>` + `disabled: true|false` 行；插件市场（dshmarket）的
//      开关写的就是这里，DSH 的 HMR 约 1s 内重组合、每次启动由加载器重新应用。
//      市场另外把包名记进 <profile>/.dsh-market/state.json 的 `disabled` 数组
//      作为它自己的 UI 状态。
//
// 市场 README 明确：**手写进补丁层的行会显示为徽标**，所以补丁层就是两侧共享
// 的同步通道——GUI 不需要、也不应该去调用市场的私有 HTTP 接口。这里逐行复刻
// 市场的 patch.js 语义（含 `[]` 占位符处理，否则「禁用→再启用」会把 profile 写
// 成纯注释文件，dsh 直接拒绝启动）。
//
// 有效状态判定与市场保持一致：
//   off = state.json 的 disabled 含该包 **或** 补丁层禁用了它的任一 row id。

/** 允许写入补丁层的 row id 字符集（与市场 ROW_ID_RE 一致）。 */
const ROW_ID_RE = /^[A-Za-z0-9_.-]+$/;

/** 市场自己的持久状态文件（禁用列表按**包名**记录）。 */
function marketStatePath(dshHome) {
  return path.join(profileDir(dshHome), ".dsh-market", "state.json");
}

/** profile 的用户补丁层路径——启用/禁用的官方通道。 */
function userPatchPath(dshHome) {
  return path.join(profileDir(dshHome), "cordis.patch.yml");
}

/** 读市场 state.json 的 `disabled` 列表（包名）；缺失/损坏按空集处理。 */
function readMarketDisabled(dshHome) {
  try {
    const raw = JSON.parse(fs.readFileSync(marketStatePath(dshHome), "utf8"));
    const list = Array.isArray(raw?.disabled) ? raw.disabled : [];
    return new Set(list.filter((n) => typeof n === "string" && n !== ""));
  } catch {
    return new Set();
  }
}

/**
 * 读补丁层文本并**去掉 UTF-8 BOM**。
 *
 * 这不是洁癖，是必需：Windows 上的 profile 模板 cordis.patch.yml 带 BOM
 * （EF BB BF），而 Node 的 readFileSync(..., "utf8") **不会**像 .NET/PowerShell
 * 那样剥掉它。带 BOM 时第一行是 `\uFEFF# 注释`，`/^[ \t]*#.*$/mu` 匹配不到它
 * ——于是市场 patch.js 的 appendPatchEntry 既认不出「空 `[]` 占位」、又把最后
 * 一行判成 `[]` 流式结构，直接**拒绝写入禁用行**。结果就是实测到的现象：市场
 * state.json 记了 disabled、补丁层却始终是空的，引擎照常加载插件，而市场 UI 与
 * 设置窗口各说各话。
 *
 * 写回时不带 BOM，顺带把文件修好——之后市场自己的开关也能正常写入。
 */
function readPatchText(file) {
  try {
    return fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
  } catch {
    return "";
  }
}

/** 逐行扫补丁层，取出 `- id: X` + `disabled: true|false` 两类行。 */
function readUserPatchState(dshHome) {
  const disables = new Set();
  const forced = new Set();
  const text = readPatchText(userPatchPath(dshHome));
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^- id: (['"]?)([A-Za-z0-9_.-]+)\1\s*$/.exec(lines[i]);
    if (!m) continue;
    const next = lines[i + 1] ?? "";
    if (/^ {2}disabled: true\s*$/.test(next)) disables.add(m[2]);
    else if (/^ {2}disabled: false\s*$/.test(next)) forced.add(m[2]);
  }
  return { disables, forced };
}

/**
 * 某个已装包在补丁层里占用的 row id：它自己 `insert:` 的行。
 * 只取该包插入的行——补丁里还可能包含「重配邻居」的行（如某个 bundle 调
 * attachment-local 的 config），把 `disabled: true` 写到那类行上会连带打掉
 * 邻居功能（市场 #147 的教训）。声明位置（dsh.bundle.patch）与约定位置
 * （包根 cordis.patch.yml）都读。
 */
function packageRowIds(dshHome, pkg) {
  const ids = new Set();
  const pkgDir = path.join(profileDir(dshHome), "node_modules", pkg);
  const collect = (patchFile) => {
    const text = readPatchText(patchFile);
    if (text === "") return;
    let inInsert = false;
    for (const line of text.split(/\r?\n/)) {
      if (/^- insert:\s*$/.test(line)) {
        inInsert = true;
        continue;
      }
      if (/^- /.test(line)) inInsert = false;
      if (!inInsert) continue;
      const m = /^ {4}- id: (['"]?)([A-Za-z0-9_.-]+)\1\s*$/.exec(line);
      if (m) ids.add(m[2]);
    }
  };
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    const declared = manifest?.dsh?.bundle?.patch;
    if (typeof declared === "string" && declared !== "") collect(path.join(pkgDir, declared));
  } catch {
    /* 包未安装：没有可归属的行 */
  }
  collect(path.join(pkgDir, "cordis.patch.yml"));
  return [...ids];
}

function rowBlock(rowId, disabled) {
  return `- id: ${rowId}\n  disabled: ${disabled ? "true" : "false"}\n`;
}

/**
 * 去掉最后一行为空占位时把 `[]` 补回来。
 *
 * 追加第一行会把模板里的 `[]` 注释掉，所以删掉最后一行会剩下一个纯注释文件——
 * 那不是顶层数组，dsh 会拒绝启动该 profile。禁用再启用就等于把 profile 写坏。
 */
function withPlaceholderRestored(text) {
  if (text.replace(/^[ \t]*#.*$/gmu, "").trim() !== "") return text;
  const uncommented = text.replace(/^[ \t]*#[ \t]*\[[ \t]*\][ \t]*(?:\r?\n|$)/mu, "[]\n");
  if (uncommented !== text) return uncommented;
  return text === "" || text.endsWith("\n") ? `${text}[]\n` : `${text}\n[]\n`;
}

/**
 * 追加一条顶层补丁项；文件不是合法条目列表时**拒绝写入**（拒绝本身就是保护：
 * 已经写坏的补丁层绝不能被弄得更坏）。
 */
function appendPatchEntry(patchPath, block) {
  const text = readPatchText(patchPath);
  const core = text.trim();
  if (core === "") {
    fs.writeFileSync(patchPath, block);
    return { ok: true, reason: null };
  }
  const withoutComments = text.replace(/^[ \t]*#.*$/gmu, "").trim();
  if (withoutComments === "") {
    const next = text.endsWith("\n") ? text : `${text}\n`;
    fs.writeFileSync(patchPath, `${next}${block}`);
    return { ok: true, reason: null };
  }
  if (withoutComments === "[]" || withoutComments === "[ ]") {
    // dsh 模板自带一个空的 `[]` 占位；直接往后追加会得到两个顶层元素。
    const commented = text.replace(/^[ \t]*\[[ \t]*\][ \t]*(?:#.*)?(?:\r?\n|$)/mu, "# []\n");
    const next = commented.endsWith("\n") ? commented : `${commented}\n`;
    fs.writeFileSync(patchPath, `${next}${block}`);
    return { ok: true, reason: null };
  }
  const lastContentLine =
    text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line !== "" && !line.startsWith("#"))
      .pop() ?? "";
  if (/^[[{]/.test(lastContentLine)) {
    return { ok: false, reason: "patch layer ends in a top-level flow structure" };
  }
  const next = text.endsWith("\n") ? text : `${text}\n`;
  fs.writeFileSync(patchPath, `${next}${block}`);
  return { ok: true, reason: null };
}

/** 禁用一行：追加 `- id: X` + `disabled: true`（幂等）。 */
function disablePatchRow(patchPath, rowId) {
  if (!ROW_ID_RE.test(rowId)) return { ok: false, reason: `row id cannot be written: ${rowId}` };
  if (readPatchFileState(patchPath).disables.has(rowId)) return { ok: true, reason: null };
  return appendPatchEntry(patchPath, rowBlock(rowId, true));
}

/** 启用一行：删掉 `disabled: true` 块；被下层按住时写 `disabled: false` 强制启用。 */
function enablePatchRow(patchPath, rowId) {
  if (!ROW_ID_RE.test(rowId)) return { ok: false, reason: `row id cannot be written: ${rowId}` };
  const text = readPatchText(patchPath);
  const blockRe = new RegExp(`^- id: ['"]?${escapeRegExp(rowId)}['"]?\\r?\\n  disabled: true\\r?\\n`, "mu");
  if (blockRe.test(text)) {
    fs.writeFileSync(patchPath, withPlaceholderRestored(text.replace(blockRe, "")));
    return { ok: true, reason: null };
  }
  if (readPatchFileState(patchPath).forced.has(rowId)) return { ok: true, reason: null };
  return appendPatchEntry(patchPath, rowBlock(rowId, false));
}

/** 补丁层某文件的 disables/forced 集合（按路径，供写入函数内部用）。 */
function readPatchFileState(patchPath) {
  const disables = new Set();
  const forced = new Set();
  const text = readPatchText(patchPath);
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^- id: (['"]?)([A-Za-z0-9_.-]+)\1\s*$/.exec(lines[i]);
    if (!m) continue;
    const next = lines[i + 1] ?? "";
    if (/^ {2}disabled: true\s*$/.test(next)) disables.add(m[2]);
    else if (/^ {2}disabled: false\s*$/.test(next)) forced.add(m[2]);
  }
  return { disables, forced };
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 把市场 state.json 的 disabled 列表改写为 nextDisabled（保留其余键）。
 * 返回是否真的写入了（内容没变就不写，避免触发无意义的 watch 事件）。
 */
function writeMarketDisabled(dshHome, nextDisabled) {
  const file = marketStatePath(dshHome);
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return false; // 市场还没建出 state.json：只走补丁层，别凭空造市场状态
  }
  if (!raw || typeof raw !== "object") return false;
  const current = Array.isArray(raw.disabled) ? raw.disabled.filter((n) => typeof n === "string") : [];
  const next = [...new Set(nextDisabled.filter((n) => typeof n === "string" && n !== ""))];
  if (current.length === next.length && current.every((n) => next.includes(n))) return false;
  raw.disabled = next;
  // 紧凑 JSON、不加尾随换行：与市场 writeMarketState 的序列化逐字节一致，
  // 避免同一份文件在两种格式之间来回翻转。
  fs.writeFileSync(file, JSON.stringify(raw));
  return true;
}

/**
 * 设置某个插件的启用/禁用（写补丁层 + 同步市场 state.json）。
 *
 * @param {object} o
 * @param {string} o.dshHome
 * @param {string} o.pkg     包名（市场 state.json 的键）
 * @param {string[]} o.rowIds 该包在补丁层占用的 row id（packageRowIds 的结果）
 * @param {boolean} o.enabled
 * @returns {{ok:boolean, changed:boolean, patchOk:boolean, reason:(string|null)}}
 */
function setPluginEnabled({ dshHome, pkg, rowIds, enabled }) {
  const patchPath = userPatchPath(dshHome);
  const ids = Array.isArray(rowIds) && rowIds.length ? rowIds : [];
  let patchOk = true;
  let reason = null;
  for (const rowId of ids) {
    const res = enabled ? enablePatchRow(patchPath, rowId) : disablePatchRow(patchPath, rowId);
    if (!res.ok) {
      patchOk = false;
      reason = res.reason ?? reason;
    }
  }
  // 市场 state.json 只对**已装且有 row id** 的包有意义；client-only 包没有 row
  // id，市场本身就靠 state.json 覆盖，这时也照写。
  const marketDisabled = readMarketDisabled(dshHome);
  const next = new Set(marketDisabled);
  if (enabled) next.delete(pkg);
  else next.add(pkg);
  const marketChanged = writeMarketDisabled(dshHome, [...next]);
  return { ok: patchOk, changed: patchOk || marketChanged, patchOk, reason };
}

/** 每个候选目录项的已装 / 启用状态：bundles 登记 + 实存 + 补丁层/市场禁用。 */
function catalogStatus(dshHome) {
  const modulesRoot = path.join(profileDir(dshHome), "node_modules");
  const bundles = new Set(installedBundles(dshHome));
  const marketDisabled = readMarketDisabled(dshHome);
  const patch = readUserPatchState(dshHome);
  const out = {};
  for (const entry of CATALOG) {
    // The materialised name in node_modules / the bundles registry is the true
    // package name (bundles never contains a `file:` spec), so compare against
    // `pkg` (== the registry name for npm entries, == the localSource package
    // name for bundled entries).
    const bundleName = entry.pkg;
    const pkgDir = path.join(modulesRoot, bundleName);
    let installed = bundles.has(bundleName) && fs.existsSync(path.join(pkgDir, "package.json"));
    let version = null;
    if (installed) {
      try {
        version = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8")).version ?? null;
      } catch {
        version = null;
      }
    }
    // 有效启用状态 = 市场没禁 且 补丁层没禁（与市场 verifyActivation 的 off 判定一致）。
    const rowIds = packageRowIds(dshHome, bundleName);
    const byMarket = marketDisabled.has(bundleName);
    const byPatch = rowIds.length > 0 && rowIds.some((r) => patch.disables.has(r));
    out[entry.id] = {
      installed,
      version,
      bundle: bundles.has(bundleName),
      present: fs.existsSync(pkgDir),
      enabled: !byMarket && !byPatch,
      // 市场说禁用、但补丁层还没落下 → 引擎实际上仍会加载它（漂移）。
      // 这个组合就是「市场禁用了、设置窗口也该显示」的那条路径，同时提示
      // 修复动作需要把它写实。
      disabledBy: byPatch ? "patch" : byMarket ? "market" : null,
      marketDisabled: byMarket,
      patchDisabled: byPatch,
      rowIds,
    };
  }
  return out;
}

// ---------------------------------------------------------------------------
// bundled (local-source) plugins
// ---------------------------------------------------------------------------
//
// 打包版里 `plugins/` 随 src/ 一起打进 app.asar；子进程 pnpm 把 app.asar 当作
// 一个普通文件，读不到里面的目录，所以 `pnpm add file:<app.asar 内路径>` 会报
// “as it does not exist”。Electron 主进程的 fs 能透明读 asar 路径，因此这里
// 先把捆绑插件复制成 pnpm-tools 目录下的真实文件夹（staging），再装那份拷贝。
// 开发模式（electron .）下 source 本身就在磁盘上，逻辑完全相同。

/** 仓库内捆绑插件的根目录（本进程可读：开发=真实目录，打包=app.asar 内路径）。 */
function bundledPluginsRoot() {
  return path.join(__dirname, "..", "plugins");
}

/** 某个捆绑插件条目可读的源目录。 */
function bundledSourceDir(entry) {
  return path.join(bundledPluginsRoot(), entry.localSource ?? entry.pkg);
}

/** 递归复制目录（read/readdir/stat 均可被 Electron 的 asar fs 透明处理）。 */
async function copyDirRecursive(src, dst) {
  await fsp.mkdir(dst, { recursive: true });
  const names = await fsp.readdir(src);
  for (const name of names) {
    const from = path.join(src, name);
    const to = path.join(dst, name);
    const st = await fsp.stat(from);
    if (st.isDirectory()) await copyDirRecursive(from, to);
    else await fsp.writeFile(to, await fsp.readFile(from));
  }
}

/** 读取某目录 package.json 的 version（读不到返回 null）。 */
function readPackageVersion(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).version ?? null;
  } catch {
    return null;
  }
}

/** 读取某目录 package.json 的 name（读不到返回 null）。 */
function readPackageName(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")).name ?? null;
  } catch {
    return null;
  }
}

/** 已装插件在 profile node_modules 里的版本（未装/不可读返回 null）。 */
function installedBundleVersion(dshHome, pkg) {
  return readPackageVersion(path.join(profileDir(dshHome), "node_modules", pkg));
}

/**
 * 把捆绑插件 staging 成 <stagingRoot>/<pkg> 的真实目录并返回该目录。
 * 每次安装前都整目录刷新，保证装的是当前随应用发布的代码。staging 路径必须
 * 稳定（pnpm 会把 `file:` spec 原样写进 profile 的 dependencies，之后在该
 * profile 里再跑 pnpm 仍要能解析到这份拷贝）。
 *
 * stagingRoot 还必须不含空格：引擎把 `pnpm <args>` 用 shell 转发（Node 26 起
 * shell:true 不再转义参数），file: spec 路径里出现空格会被拆词。主进程从
 * <home>\.dsh-gui\bundled-plugins（必要时 8.3 短路径）传入；这里仅作最后防线。
 * @returns {Promise<string>} 真实 staging 目录
 */
async function stageBundledPlugin(entry, { stagingRoot, log = () => {} }) {
  const name = entry.pkg;
  const sourceDir = bundledSourceDir(entry);
  if (!fs.existsSync(path.join(sourceDir, "package.json"))) {
    throw new Error(`bundled plugin source missing: ${sourceDir}`);
  }
  const sourceName = readPackageName(sourceDir);
  if (sourceName && sourceName !== name) {
    throw new Error(`bundled plugin name mismatch: ${sourceDir} is "${sourceName}", expected "${name}"`);
  }
  const stagingDir = path.join(stagingRoot, name);
  if (/\s/u.test(stagingDir)) {
    throw new Error(
      `bundled plugin staging path contains a space (${stagingDir}); pnpm cannot install ` +
        "file: specs with spaces through the engine — use a space-free stagingRoot",
    );
  }
  await fsp.rm(stagingDir, { recursive: true, force: true });
  await copyDirRecursive(sourceDir, stagingDir);
  log("bundled plugin staged:", sourceDir, "->", stagingDir);
  return stagingDir;
}

/**
 * 运行一次 `dsh plugin --profile web <args...>`（引擎会转发给 pnpm 并 reconcile bundles）。
 * @param {object} o
 * @returns {Promise<{ok:boolean, code:number, output:string}>}
 */
function runDshPlugin({ engineDir, dshHome, pnpmBinDir, args, nodeExec, log = () => {} }) {
  return new Promise((resolve) => {
    const bin = engineBin({ engineDir });
    if (!bin) return resolve({ ok: false, code: -1, output: "engine bin missing" });
    const env = {
      ...process.env,
      ...(dshHome ? { DSH_HOME: dshHome } : {}),
      // 让引擎子命令里 spawn 的 `pnpm` 解析到自举目录（win 上 shell:true 需要 pnpm.cmd）。
      PATH: pnpmBinDir ? `${pnpmBinDir}${path.delimiter}${process.env.PATH ?? ""}` : process.env.PATH,
    };
    log("dsh plugin", ["--profile", "web", ...args].join(" "));
    const child = spawn(nodeExec, [bin, "plugin", "--profile", "web", ...args], {
      cwd: dshHome || process.cwd(),
      env,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const sink = (chunk) => {
      const text = String(chunk ?? "");
      output = (output + text).split(/\r?\n/u).slice(-20).join("\n");
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", sink);
    child.stderr.on("data", sink);
    child.on("error", (error) => resolve({ ok: false, code: -1, output: String((error && error.message) || error) }));
    child.on("close", (code) => resolve({ ok: code === 0, code: code ?? -1, output }));
  });
}

/** 安装单个包（幂等：已在 bundles 则跳过）。`pkg` 是给 pnpm 的安装 spec。 */
async function installPlugin({ engineDir, dshHome, pnpmBinDir, pkg, name, nodeExec, log = () => {} }) {
  if (installedBundles(dshHome).includes(name ?? pkg)) {
    log("plugin already installed:", name ?? pkg);
    return { ok: true, already: true };
  }
  const res = await runDshPlugin({ engineDir, dshHome, pnpmBinDir, args: ["add", pkg], nodeExec, log });
  if (!res.ok) log("plugin install failed:", pkg, res.output);
  return res;
}

/** 移除单个包。 */
async function removePlugin({ engineDir, dshHome, pnpmBinDir, pkg, nodeExec, log = () => {} }) {
  const res = await runDshPlugin({ engineDir, dshHome, pnpmBinDir, args: ["remove", pkg], nodeExec, log });
  if (!res.ok) log("plugin remove failed:", pkg, res.output);
  return res;
}

// ---------------------------------------------------------------------------
// 启动前自愈：修剪不可解析 / 失效的 profile bundle 登记
// ---------------------------------------------------------------------------
//
// 引擎 loadProfileDirectory 会逐一 resolve `dsh.profile.bundles` 里的每个包，
// 解析不到（`cannot resolve profile bundle`）或包没声明 `dsh.bundle` 都会直接
// 抛错挡住启动。而引擎自己的 reconcile 只在新装/卸载时维护 bundles：一个曾在
// 列表里、后来依赖被外部移除/没装出来的条目，reconcile 不会清理（它只映射
// “依赖里成功解析且声明 dsh.bundle 的包”），`dsh plugin remove` 也会因为依赖
// 已不在 package.json 里而报 ERR_PNPM_CANNOT_REMOVE_MISSING_DEPS —— 于是只能
// 由 GUI 在 spawn 引擎前直接修剪 manifest。坏掉的安装/卸载因此永远卡不死启动。

/** 与引擎 resolveBundleDir 相同的候选查找路径（createRequire 的 node_modules 顺序）。 */
function resolutionSearchPaths(anchorFile, packageName) {
  try {
    return createRequire(anchorFile).resolve.paths(packageName) ?? [];
  } catch {
    return [];
  }
}

/** 复刻引擎 resolveBundleDir：先安装锚点（dsh 包内）、后 profile 锚点，逐级查找。 */
function bundleResolveDir(engineDir, dshHome, packageName) {
  const anchors = [
    path.join(engineDir, "node_modules", "@deepseek-ai", "dsh", "package.json"),
    path.join(profileDir(dshHome), "package.json"),
  ];
  for (const anchor of anchors) {
    if (!fs.existsSync(anchor)) continue;
    for (const searchPath of resolutionSearchPaths(anchor, packageName)) {
      const candidate = path.join(searchPath, packageName);
      if (fs.existsSync(path.join(candidate, "package.json"))) return candidate;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 旧插件迁移（改名 / 合并后的一次性清理）
// ---------------------------------------------------------------------------
//
// 目录条目的 id/pkg 变过名时，profile 里仍可能留着**旧包名**的 bundle 登记与
// node_modules 拷贝。启动维护只按当前 CATALOG 对账，看不见它们，于是旧插件会
// 被引擎照常加载 —— 与新版同时运行（两个页内控件、路由冲突），比“没装上”更糟。
// 所以这些旧包名由 GUI 主动清理一次：摘 bundle 登记 + 删补丁层的遗留禁用行。
//
// 补丁层的行 id 与包名不同（如 opencode-go-usage ↔ dsh-opencode-go-usage），
// 两者都要清：留下一个指向不存在行的 `disabled: true` 是启动期的 orphan。

/**
 * 已改名/合并的旧插件。
 *   pkg        旧包名（profile bundles / node_modules 里的键）
 *   rowIds     它在补丁层留下的 row id（与包名不同，两者都要清）
 *   replacedBy 当前 CATALOG 里接替它的 id；旧插件原本装着时，调用方应把新插件
 *              也装上，别让改名把用户已经在用的功能弄丢
 */
const LEGACY_PLUGIN_PKGS = [
  {
    pkg: "dsh-opencode-go-usage",
    rowIds: ["opencode-go-usage"],
    replacedBy: "dsh-model-usage",
  },
  // 两个 OpenCode Go 插件合并为 dsh-opencode-go（协议声明 + V4.1 模型 + 会话头）。
  // 旧包各自带着自己的 row id，两者都要清——否则补丁层会留下指向不存在行的
  // `disabled: true`（启动期 orphan），而且旧包登记不摘掉会与新包同时加载。
  {
    pkg: "dsh-opencode-go-session",
    rowIds: ["opencode-go-session-header"],
    replacedBy: "dsh-opencode-go",
  },
  {
    pkg: "dsh-opencode-go-api",
    rowIds: ["opencode-go-api"],
    replacedBy: "dsh-opencode-go",
  },
];

/** 摘掉补丁层里这些 row id 的 `disabled: true|false` 行（含 `[]` 占位还原）。 */
function removePatchRows(dshHome, rowIds) {
  if (!Array.isArray(rowIds) || rowIds.length === 0) return [];
  const patchPath = userPatchPath(dshHome);
  let text = readPatchText(patchPath);
  if (text.trim() === "") return [];
  const removed = [];
  for (const rowId of rowIds) {
    if (!ROW_ID_RE.test(rowId)) continue;
    const blockRe = new RegExp(
      `^- id: ['"]?${escapeRegExp(rowId)}['"]?\\r?\\n  disabled: (?:true|false)\\r?\\n`,
      "mu",
    );
    if (!blockRe.test(text)) continue;
    text = text.replace(blockRe, "");
    removed.push(rowId);
  }
  if (removed.length > 0) fs.writeFileSync(patchPath, withPlaceholderRestored(text));
  return removed;
}

/**
 * 清理已改名的旧插件：摘 bundle 登记（先试引擎 remove，失败退回直接修剪）+
 * 清补丁层遗留行 + 清市场 state.json 里的旧包名。
 *
 * 若旧插件原本装着且有 `replacedBy`，把替代条目的 id 放进 `replaced`，并把它的
 * 启用/禁用意图一并搬过去（旧插件是被禁用的，新插件也保持禁用）——改名不该改变
 * 用户的选择。
 *
 * @returns {{pruned:string[], removedRows:string[], replaced:string[], changed:boolean}}
 */
async function removeLegacyPlugins({ engineDir, dshHome, nodeExec, pnpmInstallDir, log = () => {} }) {
  const result = { pruned: [], removedRows: [], replaced: [], changed: false };
  let bundles;
  try {
    bundles = new Set(installedBundles(dshHome));
  } catch (error) {
    log("legacy plugin cleanup: cannot read bundles:", (error && error.message) || error);
    return result;
  }
  for (const legacy of LEGACY_PLUGIN_PKGS) {
    const wasInstalled = bundles.has(legacy.pkg);
    // 禁用意图可能记在市场的 state.json（包名）或补丁层（row id）任一处。
    let wasDisabled = false;
    try {
      wasDisabled =
        readMarketDisabled(dshHome).has(legacy.pkg) ||
        legacy.rowIds.some((rowId) => readUserPatchState(dshHome).disables.has(rowId));
    } catch {
      /* 读不到就当没禁用 */
    }

    // 补丁层与市场状态即使包已不在 bundles 里也可能残留，因此独立清理。
    try {
      const removedRows = removePatchRows(dshHome, legacy.rowIds);
      if (removedRows.length > 0) {
        result.removedRows.push(...removedRows);
        result.changed = true;
        log("legacy plugin: removed stale patch rows:", removedRows.join(", "));
      }
    } catch (error) {
      log("legacy plugin: patch-row cleanup failed:", legacy.pkg, (error && error.message) || error);
    }
    try {
      const marketDisabled = readMarketDisabled(dshHome);
      if (marketDisabled.has(legacy.pkg)) {
        marketDisabled.delete(legacy.pkg);
        if (writeMarketDisabled(dshHome, [...marketDisabled])) {
          result.changed = true;
          log("legacy plugin: dropped from marketplace disabled list:", legacy.pkg);
        }
      }
    } catch (error) {
      log("legacy plugin: market-state cleanup failed:", legacy.pkg, (error && error.message) || error);
    }

    if (wasInstalled) {
      // 1) 先走引擎自己的卸载（顺带清 node_modules 与锁文件）。
      try {
        const pnpmBinDir = await ensurePnpm({
          installDir: pnpmInstallDir,
          pnpmSpec: readProfilePnpmManager(dshHome) ?? "pnpm@10",
          nodeExec,
          log,
        });
        const res = await removePlugin({ engineDir, dshHome, pnpmBinDir, pkg: legacy.pkg, nodeExec, log });
        if (!res.ok) log("legacy plugin: engine remove did not succeed, pruning the registration:", legacy.pkg);
      } catch (error) {
        log("legacy plugin: engine remove failed, pruning instead:", legacy.pkg, (error && error.message) || error);
      }
      // 2) 然后**无论如何**都把登记摘干净（bundles + dependencies）。
      //    只靠第 1 步是不够的：`dsh plugin remove` 在依赖已不在 package.json 时
      //    会报 ERR_PNPM_CANNOT_REMOVE_MISSING_DEPS；而只摘 bundles 又会被引擎的
      //    reconcile 依据残留依赖重新登记回来（实测就是这个原因导致改名后新旧两版
      //    同时加载、控件显示两遍）。这里以「摘完再查一遍」为准，不信任何返回值。
      try {
        pruneProfilePackages(dshHome, [legacy.pkg]);
      } catch (error) {
        log("legacy plugin: prune failed:", legacy.pkg, (error && error.message) || error);
      }
      const removed = !isRegisteredInProfile(dshHome, legacy.pkg);
      if (removed) {
        result.pruned.push(legacy.pkg);
        result.changed = true;
        log("legacy plugin removed (renamed):", legacy.pkg);
      } else {
        log("legacy plugin could not be removed:", legacy.pkg);
      }
    }

    // 迁移：替代条目由调用方安装；禁用意图搬到替代包名上（补丁行由随后运行的
    // reconcilePluginEnabled 依据市场 state.json 落成）。
    if (wasInstalled && legacy.replacedBy) {
      result.replaced.push(legacy.replacedBy);
      log("legacy plugin replaced by:", legacy.pkg, "->", legacy.replacedBy);
      if (wasDisabled) {
        try {
          const replacementEntry = CATALOG.find((entry) => entry.id === legacy.replacedBy);
          const replacementPkg = replacementEntry?.pkg ?? legacy.replacedBy;
          const marketDisabled = readMarketDisabled(dshHome);
          marketDisabled.add(replacementPkg);
          if (writeMarketDisabled(dshHome, [...marketDisabled])) {
            log("legacy plugin: carried the disabled state over to", replacementPkg);
          }
        } catch (error) {
          log("legacy plugin: could not carry disabled state:", (error && error.message) || error);
        }
      }
    }
  }
  return result;
}

/** 原子写回 profile manifest（先写临时文件再 rename，中途崩溃不会留下残缺 JSON）。 */
function writeProfileManifest(dshHome, manifest) {
  const file = path.join(profileDir(dshHome), "package.json");
  const tmp = `${file}.dsh-gui-heal.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n");
  fs.renameSync(tmp, file);
}

/** 只修剪，不自愈性补齐。给“禁用并重启”等需要直接摘 bundle 的调用方复用。 */
function pruneProfileBundles(dshHome, names) {
  const manifest = readProfileManifest(dshHome);
  if (!manifest) return [];
  const bundles = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [];
  const remove = new Set(names);
  const kept = bundles.filter((name) => !remove.has(name));
  if (kept.length === bundles.length) return [];
  manifest.dsh.profile.bundles = kept;
  writeProfileManifest(dshHome, manifest);
  return bundles.filter((name) => remove.has(name));
}

/**
 * 彻底摘除这些包的 profile 登记：`dsh.profile.bundles` **和** `dependencies`。
 *
 * 为什么必须两者一起摘——引擎自己的 reconcile 会把「dependencies 里能解析、且
 * 声明了 `dsh.bundle`」的包**重新登记回 bundles**。只摘 bundles 而留着依赖声明，
 * 下一次引擎组合就会把包原样装回来。实测踩中：改名迁移摘掉
 * `dsh-opencode-go-usage` 的 bundles 登记后，它靠残留的 `file:` 依赖又被引擎复活，
 * 于是新旧两版同时加载 —— 页面上同一个用量控件出现了两遍。
 *
 * @returns {string[]} 实际摘掉的包名（bundles 或 dependencies 任一命中即算）。
 */
function pruneProfilePackages(dshHome, names) {
  const manifest = readProfileManifest(dshHome);
  if (!manifest) return [];
  const remove = new Set(names);
  const removed = [];
  const bundles = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [];
  const kept = bundles.filter((name) => !remove.has(name));
  if (kept.length !== bundles.length) {
    manifest.dsh.profile.bundles = kept;
    removed.push(...bundles.filter((name) => remove.has(name)));
  }
  if (manifest.dependencies && typeof manifest.dependencies === "object") {
    for (const name of remove) {
      if (!Object.prototype.hasOwnProperty.call(manifest.dependencies, name)) continue;
      delete manifest.dependencies[name];
      if (!removed.includes(name)) removed.push(name);
    }
  }
  if (removed.length > 0) writeProfileManifest(dshHome, manifest);
  return removed;
}

/** 该包是否还留在 profile 的任一处登记（bundles 或 dependencies）。 */
function isRegisteredInProfile(dshHome, name) {
  try {
    if (installedBundles(dshHome).includes(name)) return true;
    const deps = readProfileManifest(dshHome)?.dependencies;
    return Boolean(deps && Object.prototype.hasOwnProperty.call(deps, name));
  } catch {
    return false;
  }
}

/**
 * 引擎启动前的 profile bundle 自检/自愈。逐条对账 bundles 登记：
 *  - 可解析且声明了 `dsh.bundle` → 保留（含引擎自带的 @deepseek-ai/dsh-base、
 *    @deepseek-ai/dsh-web-app，它们从安装锚点解析，永不被误动）；
 *  - 不可解析但声明在 dependencies 里（依赖在、materialize 缺失）→ 先按引擎
 *    报错里自带的处方跑一次 `dsh plugin --profile web install` 补装；仍失败才
 *    修剪并记入 errors（宁可不加载也绝不挡启动）；
 *  - 不可解析且没有依赖声明（dshmarket 这类 stale 登记）→ 直接修剪；
 *  - 可解析但包没声明 `dsh.bundle`（引擎会抛 "declares no dsh.bundle"）→ 修剪。
 * 另：`dsh.profile.patchReload` 非 "live"/"startup" 时会挡启动，重置回 "live"。
 *
 * 所有读写都包在 try/catch 里，任何失败只记入 errors、绝不 throw，保证自愈
 * 自身永远不可能成为新的启动挡点。
 * @returns {Promise<{pruned:string[], repaired:string[], errors:string[], changed:boolean}>}
 */
async function healProfileBundles({ engineDir, dshHome, nodeExec, pnpmInstallDir, log = () => {} }) {
  const result = { pruned: [], repaired: [], errors: [], changed: false };
  let manifest;
  try {
    manifest = readProfileManifest(dshHome);
  } catch (error) {
    result.errors.push(`read profile manifest: ${(error && error.message) || error}`);
    return result;
  }
  if (!manifest || !manifest.dsh?.profile) return result;
  const profile = manifest.dsh.profile;
  const bundles = Array.isArray(profile.bundles) ? profile.bundles : [];
  const declared = new Set(Object.keys(manifest.dependencies ?? {}));
  let changed = false;

  const rawReload = profile.patchReload;
  if (rawReload !== undefined && rawReload !== "live" && rawReload !== "startup") {
    profile.patchReload = "live";
    changed = true;
    result.repaired.push("<patchReload>");
    log("reset invalid dsh.profile.patchReload:", JSON.stringify(rawReload), "->", '"live"');
  }

  const unresolvable = [];
  const noBundle = [];
  for (const name of bundles) {
    const dir = bundleResolveDir(engineDir, dshHome, name);
    if (!dir) {
      unresolvable.push(name);
      continue;
    }
    let declares = false;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
      declares = Boolean(parsed?.dsh?.bundle?.patch);
    } catch {
      declares = false;
    }
    if (!declares) noBundle.push(name);
  }

  // 依赖声明在、但 materialize 缺失：先补装（引擎错误信息里给的处方）。只有
  // 需要时才碰 pnpm 自举，避免每次启动都多跑一遍。
  const declaredMissing = unresolvable.filter((name) => declared.has(name));
  if (declaredMissing.length > 0) {
    try {
      const pnpmSpec = readProfilePnpmManager(dshHome) ?? "pnpm@10";
      const pnpmBinDir = await ensurePnpm({ installDir: pnpmInstallDir, pnpmSpec, nodeExec, log });
      const res = await runDshPlugin({ engineDir, dshHome, pnpmBinDir, args: ["install"], nodeExec, log });
      if (!res.ok) result.errors.push(`materialize install failed: ${res.output.slice(-160)}`);
    } catch (error) {
      result.errors.push(`materialize install: ${(error && error.message) || error}`);
    }
    for (const name of declaredMissing) {
      if (bundleResolveDir(engineDir, dshHome, name)) {
        result.repaired.push(name);
        log("re-materialized declared bundle:", name);
      }
    }
  }
  const repairedSet = new Set(result.repaired);
  const stillUnresolvable = unresolvable.filter((name) => !repairedSet.has(name));
  const pruneList = [...new Set([...stillUnresolvable, ...noBundle])];

  if (pruneList.length > 0) {
    profile.bundles = bundles.filter((name) => !pruneList.includes(name));
    changed = true;
    for (const name of pruneList) {
      result.pruned.push(name);
      const why = noBundle.includes(name) && !unresolvable.includes(name)
        ? "(package does not declare dsh.bundle)"
        : "(unresolvable)";
      log("pruned profile bundle:", name, why);
    }
  }

  if (changed) {
    try {
      writeProfileManifest(dshHome, manifest);
      result.changed = true;
    } catch (error) {
      result.errors.push(`write profile manifest: ${(error && error.message) || error}`);
    }
  }
  return result;
}

/**
 * 对账插件（两种模式）：`enabledIds` 是“应当已安装”的期望集合。
 *
 * 设置窗口的勾选框 = 安装状态实时镜像（不再持久化期望集合），因此本函数现在
 * 只被三类调用点使用：
 *  - 勾选/取消勾选即时安装/卸载（single-id 调用，install / sync）；
 *  - 启动前维护（enabledIds = 当前已安装集合，install 模式）：补拉捆绑插件
 *    随包更新、移走会让引擎启动崩溃的不兼容已装插件；
 *  - 设置页「修复 / 重试」（enabledIds = 当前已安装集合，install 模式）。
 *
 * `mode: "sync"`——完整收敛：勾选 + 未安装 → 安装；勾选 + 已安装 → 跳过
 *  （捆绑插件源版本变化时重装，见下）；未勾选 + 已安装 → 卸载（结果记入
 *  result.removed）；未勾选 + 未安装 → 跳过。卸载走 `dsh plugin remove`
 *  （与 dsh-market 一致：从 bundles 摘掉，保留 node_modules 文件）。
 *
 * `mode: "install"`（启动前对账，默认）——只增不删：仅安装勾选项，绝不因为
 *  “没勾选”而卸载。启动是无人值守的自动化流程，profile 里可能还有用户通过
 *  dsh-market 手动装的插件，静默卸载会误删用户自己装的东西。
 *
 * 两种模式共有的引擎兼容性门控：目录条目声明了 engineRange 且不满足当前引擎
 * 版本时——
 *  - 未装且被勾选：不安装，结果记入 result.skipped（避免装完即崩）；
 *  - 已装且被 GUI 勾选：移除（该引擎上会让引擎启动崩溃，结果记入 removed），
 *    调用方随即清掉勾选；
 *  - 已装但未勾选：sync 模式按“未勾选”卸载；install 模式不静默清理，留给
 *    “启动失败诊断”弹窗由用户知情后处理。
 *
 * 其他：幂等（已装且版本未变则跳过；捆绑插件随应用更新会先 remove 再 add，
 * 让 profile 里的拷贝跟上随包发布的代码）；捆绑（localSource）插件从不直接
 * 指向 app.asar 内的源目录安装，先 staging 成真实目录（子进程 pnpm 读不到
 * app.asar 内部）再装那份。
 * @param {object} o
 * @param {"sync"|"install"} [o.mode] 默认 "install"（只增不删）。
 * @param {string} [o.stagingRoot] 捆绑插件的 staging 根目录。默认取
 *   <pnpmInstallDir>/bundled-plugins；主进程应传入无空格的路径（见 stageBundledPlugin）。
 * @returns {Promise<{installed:string[], removed:string[], skipped:string[], errors:string[], changed:boolean}>}
 *   changed 表示已装集合真的变了（调用方据此提示“需重启引擎”）。
 */
async function syncEnabledPlugins({
  enabledIds,
  engineDir,
  dshHome,
  nodeExec,
  pnpmInstallDir,
  stagingRoot,
  mode = "install",
  log = () => {},
}) {
  const removeUnchecked = mode === "sync";
  const result = { installed: [], removed: [], skipped: [], errors: [], changed: false };
  const enabled = new Set((enabledIds ?? []).filter((id) => CATALOG_IDS.has(id)));
  let pnpmBinDir = null;
  // 用「构建该 profile node_modules 的 pnpm 主版本」操作它（marketplace 可能用
  // pnpm 12 建过，混用 pnpm 10 会 ERR_PNPM_UNEXPECTED_STORE）；新 profile 无
  // node_modules 时回落到默认 pnpm@10。
  const pnpmSpec = readProfilePnpmManager(dshHome) ?? "pnpm@10";
  try {
    pnpmBinDir = await ensurePnpm({ installDir: pnpmInstallDir, pnpmSpec, nodeExec, log });
  } catch (error) {
    result.errors.push(`pnpm provisioning failed: ${(error && error.message) || error}`);
    log("pnpm provisioning failed:", error);
    return result;
  }
  // 捆绑插件 staging 根目录（保持稳定：pnpm 会把 `file:` spec 原样写进 profile
  // 的 dependencies，之后在该 profile 里再跑 pnpm 仍需能解析到同一路径）。
  const bundledStagingRoot = stagingRoot ?? path.join(pnpmInstallDir, "bundled-plugins");
  const engineVersion = readEngineVersion(engineDir);
  for (const entry of CATALOG) {
    const name = entry.pkg;
    const has = installedBundles(dshHome).includes(name);
    const compatible = engineSatisfies(entry, engineVersion);

    // 引擎不兼容：绝不安装。
    if (!compatible && enabled.has(entry.id)) {
      if (!has) {
        result.skipped.push(entry.id);
        log("plugin skipped (engine incompatible):", name, "engine", engineVersion, "needs", entry.engineRange);
        continue;
      }
    }

    const wanted = enabled.has(entry.id) && compatible;
    if (!wanted) {
      // 期望“未安装”。install 模式绝不卸载：profile 里可能有用户通过
      // dsh-market 手动装的插件，静默卸载会误删；只有勾选框取消（sync 模式，
      // 单目标）或“修复 / 重试”时才按需移除——此时语义就是“让已装集合等于
      // 期望集合”。移除走引擎的 `dsh plugin remove`（与 dsh-market 一致）。
      if (!has) continue;
      const guiManagedIncompatible = !compatible && enabled.has(entry.id);
      if (!guiManagedIncompatible && !removeUnchecked) {
        // install 模式 + 未勾选：保留（需要的用户可去设置页点「修复 / 重试」）。
        log(
          "plugin left in place (not GUI-managed, install-only mode):",
          name,
          compatible ? "" : `engine ${engineVersion} needs ${entry.engineRange}`,
        );
        continue;
      }
      try {
        const rm = await removePlugin({ engineDir, dshHome, pnpmBinDir, pkg: name, nodeExec, log });
        if (rm.ok) {
          result.removed.push(entry.id);
          result.changed = true;
          log(
            "plugin removed:",
            name,
            compatible ? "(unchecked by user)" : `(engine incompatible; engine ${engineVersion} needs ${entry.engineRange})`,
          );
        } else {
          result.errors.push(`${name}: remove failed (${rm.output.slice(-160)})`);
        }
      } catch (error) {
        result.errors.push(`${name}: ${(error && error.message) || error}`);
      }
      continue;
    }

    // 捆绑插件随应用更新：安装的版本落后于随包发布的源版本时强制重装。
    let wantsUpdate = false;
    if (has && entry.localSource) {
      const sourceVersion = readPackageVersion(bundledSourceDir(entry));
      const installedVersion = installedBundleVersion(dshHome, name);
      wantsUpdate = Boolean(sourceVersion && installedVersion && sourceVersion !== installedVersion);
      if (wantsUpdate) log("bundled plugin version changed:", name, installedVersion, "->", sourceVersion);
    }
    if (has && !wantsUpdate) continue;
    try {
      // 先准备好可安装的 spec（捆绑插件先 staging 成真实目录——子进程 pnpm
      // 读不到 app.asar 内部路径；npm 条目按目录声明的 version 固定），再做
      // remove/add，失败时不至于先拆了旧的。
      const spec = entry.localSource
        ? `file:${await stageBundledPlugin(entry, { stagingRoot: bundledStagingRoot, log })}`
        : registrySpec(entry);
      if (wantsUpdate) {
        const rm = await removePlugin({ engineDir, dshHome, pnpmBinDir, pkg: name, nodeExec, log });
        if (!rm.ok) {
          result.errors.push(`${name}: remove failed (${rm.output.slice(-160)})`);
          continue;
        }
      }
      const res = await installPlugin({ engineDir, dshHome, pnpmBinDir, pkg: spec, name, nodeExec, log });
      if (res.ok) {
        result.installed.push(entry.id);
        result.changed = true;
      } else result.errors.push(`${name}: ${res.output.slice(-200)}`);
    } catch (error) {
      result.errors.push(`${name}: ${(error && error.message) || error}`);
    }
  }
  return result;
}

/**
 * 对账启用/禁用：把「市场已禁用、但补丁层还没落下」的插件写实。
 *
 * 市场把包名记进自己的 state.json，**但真正让引擎不加载它的是补丁层的
 * `disabled: true` 行**。两者不一致时（实测过：市场里关了 opencode-go 用量，
 * state.json 有记录、补丁层却是空的，引擎照常加载），市场的 UI 显示「已禁用」
 * 而引擎其实还在跑——设置窗口据此也会显示矛盾状态。这里以市场的 state.json 为
 * 用户意图，把缺失的补丁行补上，让两侧真正一致（“同步设置”）。
 *
 * 尊重显式反对：补丁层若已经有该行 `disabled: false`（用户/市场明确要它开着），
 * 不动它——那说明 state.json 才是过时的一方。没有 row id 的 client-only 包也
 * 跳过（补丁层无处可写，市场自身靠 state.json 覆盖）。
 *
 * @returns {{healed:string[], changed:boolean}}
 */
function reconcilePluginEnabled({ dshHome, log = () => {} }) {
  const status = catalogStatus(dshHome);
  const patch = readUserPatchState(dshHome);
  const healed = [];
  for (const entry of CATALOG) {
    const st = status[entry.id];
    if (!st || !st.installed) continue;
    if (!st.marketDisabled || st.patchDisabled) continue;
    if (st.rowIds.length === 0) continue;
    // 补丁层明确要求启用（disabled: false）时，以补丁层为准，不覆盖。
    if (st.rowIds.every((r) => patch.forced.has(r))) continue;
    const res = setPluginEnabled({ dshHome, pkg: entry.pkg, rowIds: st.rowIds, enabled: false });
    if (res.ok && res.changed) {
      healed.push(entry.id);
      log("plugin disabled to match marketplace state:", entry.pkg);
    } else if (!res.ok) {
      log("cannot sync disabled state for:", entry.pkg, res.reason ?? "");
    }
  }
  return { healed, changed: healed.length > 0 };
}

module.exports = {
  CATALOG,
  CATALOG_IDS,
  catalogByPkg,
  catalogEngineCompat,
  readEngineVersion,
  readProfilePnpmManager,
  ensurePnpm,
  engineBin,
  profileDir,
  readProfileManifest,
  writeProfileManifest,
  installedBundles,
  catalogStatus,
  setPluginEnabled,
  reconcilePluginEnabled,
  removeLegacyPlugins,
  removePatchRows,
  LEGACY_PLUGIN_PKGS,
  packageRowIds,
  readMarketDisabled,
  readUserPatchState,
  marketStatePath,
  userPatchPath,
  bundleResolveDir,
  pruneProfileBundles,
  pruneProfilePackages,
  isRegisteredInProfile,
  healProfileBundles,
  runDshPlugin,
  installPlugin,
  removePlugin,
  syncEnabledPlugins,
};
