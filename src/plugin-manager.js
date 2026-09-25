"use strict";

/**
 * plugin-manager.js — DSH Ready GUI 对 dsh 引擎 web profile 的第三方插件管理。
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
 * 四个随附插件（会话续接 / 模型余量 / 网关路由 / 按键设置）**内置随包发布**：
 * 源码在 <repo>/plugins，安装前先 staging 成磁盘上的真实目录再交给 pnpm（子进程 pnpm
 * 读不到 app.asar 内部，见 stageBundledPlugin）。它们**同时**各自发布为独立仓库
 * （github.com/itchenshi/<pkg>），供其它 DSH 宿主单独安装；npm 发布通道因注册受阻
 * 尚未打通（见 README）。本壳装的是随包那份，因此不依赖 registry 也能自包含。
 *
 * 安全说明：第三方插件=以你的权限在你的机器上运行的第三方代码。设置窗口勾选
 * 即安装、取消即卸载；默认全部关闭（未勾选一律不装）。列表只收录在官方目录
 * 核实过的包名，避免同名误装。
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { randomBytes } = require("node:crypto");
const { createRequire } = require("node:module");
const semver = require("semver");

/** 候选目录：id 用于设置持久化；pkg 是 npm 安装名（需与目录核实一致）。
 *  顺序 = 设置窗口里的展示顺序（插件市场 → 会话续接 → 模型余量
 *  → 网关路由 → 按键设置），改这里即可调整界面次序。 */
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
    // 内置：源码随本仓库走（plugins/<localSource>），安装前 staging 成磁盘上的真实
    // 目录（见 stageBundledPlugin——子进程 pnpm 读不到 app.asar 内部）。它**同时**
    // 发布为独立包（github.com/itchenshi/dsh-gui-last-session），供其它 DSH 宿主使用；
    // 本壳装的是随包那份，因此不依赖 registry 也能自包含。
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
    client: true,
    zh: "会话续接（dsh-gui-last-session）",
    en: "Session resume (dsh-gui-last-session)",
    zhDesc: "启动后自动回到最近一次对话，不再修改引擎文件（引擎更新不会让功能失效）。",
    enDesc: "Reopens the conversation you were last in after a restart, without patching engine files (engine updates can't break it).",
    url: "",
  },
  {
    id: "dsh-model-surplus",
    // 内置：源码随本仓库走（plugins/<localSource>），staging 后安装；同时发布为独立包
    // （github.com/itchenshi/dsh-model-surplus），本壳装的是随包那份。
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
    pkg: "dsh-model-surplus",
    localSource: "dsh-model-surplus",
    client: true,
    zh: "模型余量（dsh-model-surplus）",
    en: "Model surplus (dsh-model-surplus)",
    zhDesc: "在会话标题右侧显示当前模型的用量/余量：OpenCode Go 显示套餐用量与选中模型月上限，DeepSeek 显示账户余额。仅在使用对应模型时出现。",
    enDesc: "Shows usage/balance for the active model right of the session title: OpenCode Go plan usage and the selected model's monthly cap, plus DeepSeek account balance, only for the matching model.",
    url: "",
  },
  {
    id: "dsh-gateway-models",
    // 内置：源码随本仓库走（plugins/<localSource>），staging 后安装；同时发布为独立包
    // （github.com/itchenshi/dsh-gateway-models）。
    //
    // 原名 `dsh-opencode-go-path`（2026-09-25 改名）。改名原因：它已经不只管 OpenCode Go
    // ——还给 Command Code 声明协议和地址、并从上游目录同步模型清单——所以换成了不带厂商
    // 的名字，也顺手丢掉了当年只为绕开 npm 重名而加的 `-path` 后缀。
    // 旧包名在 LEGACY_PLUGIN_PKGS 里做一次性清理。
    //
    // 补丁层的**行 id 仍是 `opencode-go`**，与包名解耦：GUI 的启用/禁用是写在补丁层上的
    // `- id: <rowId> + disabled:`，所以行 id 不变则用户已有的选择不丢。
    // `pkg` 是真正的包名——profile 的 bundles 登记、node_modules 目录、设置界面显示都用它。
    //
    // 合并自原 dsh-opencode-go-session + dsh-opencode-go-api（两者在
    // LEGACY_PLUGIN_PKGS 里做一次性迁移）。三件事：
    //   1) cordis.patch.yml（配置层）：给引擎装配层的 `llm-pi-ai` row 补
    //      providers.opencode-go.api: openai-completions，以及
    //      providers.commandcode.api + baseURL。修的是
    //        llm-pi-ai: provider "opencode-go" model "<目录外模型>" needs an api; ...
    //      这类报错——opencode-go 目录内模型横跨三种协议（anthropic-messages /
    //      openai-completions / openai-responses），引擎无法从目录推断共享协议，
    //      目录外模型就必须由路由显式声明 api。Command Code 则完全不在自带目录里，
    //      连模型清单都得从它公开的目录接口取。补上后，GUI 模型页「添加模型」的
    //      严格校验（保存路径）也能通过。
    //   2) lib/index.js（运行时）：引擎启动后按**接口地址**识别网关路由（不按名字），
    //      补齐模型清单——OpenCode Go 把 V4.1 排到最前，Command Code 按上游目录补全
    //      （走与 GUI 模型页相同的 settings.update 写入路径，幂等）。
    //   3) 为发往 OpenCode / OpenCode Go 的请求附加按会话 x-opencode-session
    //      头（修复 400 MissingSessionID；默认用不透明 UUID，绝不发内部会话 ID）。
    //
    // 与 dsh-gui-last-session / dsh-model-surplus 同样**不设 engineRange**：依赖的是
    // 引擎装配层、settings 服务与 llm 事件的公开契约（bundle patch 按 row id 合并
    // + llm-pi-ai 的 profile schema 接受 route 级 `api` 字段 + ctx.settings
    // update/section/describe + llm/stream 瀑布），不是引擎版本号。
    pkg: "dsh-gateway-models",
    localSource: "dsh-gateway-models",
    client: false,
    zh: "网关路由（dsh-gateway-models）",
    en: "Gateway routes (dsh-gateway-models)",
    zhDesc: "声明 opencode-go 路由协议并自动补 DeepSeek V4.1 模型；同时附加会话头修复 400 MissingSessionID。也给 Command Code 路由声明协议和 API 地址（所以不用手填地址），并从其公开目录把全部模型补齐。",
    enDesc: "Declares the opencode-go route protocol, auto-adds DeepSeek V4.1 models, and attaches the session header that fixes 400 MissingSessionID. Also declares the Command Code route's protocol and endpoint (so the API address never has to be typed) and completes its model list from the provider's public catalog.",
    url: "",
  },
  {
    id: "dsh-keys-setting",
    // 内置：源码随本仓库走（plugins/<localSource>），staging 后安装；同时发布为独立包
    // （github.com/itchenshi/dsh-keys-setting）。
    // 名字换过两次：最初是 `dsh-composer-keys`（npm 上已被社区占用 —— 见
    // github.com/zlqd123/dsh-composer-keys，功能同名），临时用过
    // `dsh-composer-keys-setting`，最终定为 `dsh-keys-setting`。
    // **补丁层的行 id 与设置命名空间仍是 `composer-keys`**，与包名解耦——禁用行、
    // 市场 state.json 的开关、settings.yaml 里保存的键位都记在那个名字下，改包名
    // 不该让用户的键位设置或启用/禁用选择失效。
    //
    // 按键设置：Enter / Shift+Enter / Ctrl+Enter 各自可设为「发送」或「换行」，
    // 设置行注册在 DSH 设置窗口的**通用**页（settings.general.item，紧挨引擎自带的
    // composer-enter 行）。
    //
    // 两侧配合：
    //   - 宿主 lib/index.js：用引擎设置服务注册 `composer-keys` 命名空间（值落在
    //     settings.yaml）并开放 GET/POST /composer-keys 给页面半边（页面拿不到
    //     插件自有命名空间——设置 RPC 域只服务固定命名空间）。
    //   - 页面 client/client.js：捕获阶段监听 composer 的 keydown，**仅当用户选择
    //     与引擎原生行为不同**时拦截，并重新派发引擎自己的另一种手势。识别 composer
    //     用引擎的语义属性 data-composer-input="true"，不碰哈希类名，也不会误伤
    //     侧边栏插件自己的编辑器；输入法（isComposing / keyCode 229）全程放行。
    //
    // 与其它捆绑插件一样**不设 engineRange**：依赖的是 settings 服务与
    // settings.general.item 槽位的公开契约，不是引擎版本号。
    pkg: "dsh-keys-setting",
    localSource: "dsh-keys-setting",
    client: true,
    zh: "按键设置（dsh-keys-setting）",
    en: "Key bindings (dsh-keys-setting)",
    zhDesc: "在设置窗口的通用页配置 Enter / Shift+Enter / Ctrl+Enter 是发送消息还是换行。",
    enDesc: "Configure in Settings → General whether Enter / Shift+Enter / Ctrl+Enter sends the message or inserts a line break.",
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

/** profile `dependencies[<pkg>]` 的声明值（未声明返回 null）。 */
function profileDependencySpec(dshHome, pkg) {
  const deps = readProfileManifest(dshHome)?.dependencies;
  if (!deps || typeof deps !== "object") return null;
  const value = deps[pkg];
  return typeof value === "string" ? value : null;
}

// ---------------------------------------------------------------------------
// bundled (built-in) plugins
// ---------------------------------------------------------------------------
//
// 打包版里 `plugins/` 随 src/ 一起打进 app.asar；子进程 pnpm 把 app.asar 当作一个
// 普通文件，读不到里面的目录，所以 `pnpm add file:<app.asar 内路径>` 会报
// “as it does not exist”。Electron 主进程的 fs 能透明读 asar 路径，因此这里先把内置
// 插件复制成磁盘上的真实文件夹（staging），再装那份拷贝。开发模式（electron .）下
// source 本身就在磁盘上，逻辑完全相同。
//
// staging 目录必须**稳定**：pnpm 会把 `file:` spec 原样写进 profile 的 dependencies，
// 之后在那个 profile 里再跑 pnpm 仍要能解析到同一路径。主进程传进来的是
// `<home>\.dsh-gui\bundled-plugins`（必要时 8.3 短化，见 main.js 的
// pluginBundledPluginsDir）——它既不在 app 安装目录里（换版本、换安装位置都不变），
// 也不含空格。

/** 仓库内内置插件的根目录（开发=真实目录，打包=app.asar 内路径，都可读）。 */
function bundledPluginsRoot() {
  return path.join(__dirname, "..", "plugins");
}

/** 某个内置条目可读的源目录。 */
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
    // lstat（不跟随链接）：`stat` 会把内置插件源码树里的 junction/软链指向的外部内容
    // 一起拷进将要安装的包里（实测能把仓库外的文件复制进来）。链接一律跳过。
    const st = await fsp.lstat(from);
    if (st.isSymbolicLink()) continue;
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

/** 某个内置条目 staging 后应被安装的绝对目录。 */
function bundledStagedDir(entry, stagingRoot) {
  return path.join(stagingRoot, entry.pkg);
}

/** 该条目应写进 profile 的安装 spec（与 pnpm 记录的写法一致：正斜杠 + file: 前缀）。 */
function bundledStagedSpec(entry, stagingRoot) {
  return `file:${bundledStagedDir(entry, stagingRoot).replace(/\\/gu, "/")}`;
}

/**
 * profile 里那条依赖是不是「我们 staging 出来的那份」？
 *
 * 内置插件的安装来源由应用自己管理：指向别处（开发用的 checkout、旧版 staging、npm
 * 安装、git 安装）都说明当前装着的不是随包那一份，应当换回来——否则应用就不再是
 * 自包含的。
 *
 * 比较用**同一台机器上每次都相同**的 stagingRoot 拼出来的字符串，不做模糊匹配：
 * stagingRoot 由主进程每次以同样方式计算（含必要的 8.3 短化），因此短路径形式也稳定，
 * 不会出现「每次启动都误判成来源不对」而反复重装。
 */
function isBundledStagedSpec(spec, entry, stagingRoot) {
  if (typeof spec !== "string") return false;
  const norm = (s) => s.replace(/\\/gu, "/").toLowerCase();
  return norm(spec) === norm(bundledStagedSpec(entry, stagingRoot));
}

/**
 * 「把原来那份装回去」之前，这个 spec 形状能不能用？
 *
 * previousSpec 取自 profile 的 dependencies —— 那个文件可以被插件市场、甚至引擎进程里的
 * 第三方插件改写，所以不能无条件喂给 pnpm：
 *   - 以 `-` 开头会被 pnpm 当成命令行选项解析（argv 注入）；
 *   - 带 `:` 前缀的（file: / git: / github: / https: / npm:）会把安装指向任意本地目录或
 *     远程仓库 —— 恢复动作等于替别人装一份代码。
 * 内置条目只认我们自己 staging 出来的那一份；目录外的条目（如 dshmarket）允许普通的包名
 * 或版本范围。其它形状一律拒绝：宁可报错，也不装来路不明的东西。
 */
function isRestorableSpec(spec, entry, stagingRoot) {
  if (typeof spec !== "string") return false;
  const value = spec.trim();
  if (value === "" || value.startsWith("-")) return false;
  if (entry.localSource) return isBundledStagedSpec(value, entry, stagingRoot);
  return !value.includes(":");
}

/**
 * 把内置插件 staging 成 <stagingRoot>/<pkg> 的真实目录并返回该目录。
 * 每次安装前整目录刷新，保证装的是当前随应用发布的代码。
 * @returns {Promise<string>} 真实 staging 目录
 */
async function stageBundledPlugin(entry, { stagingRoot, log = () => {} }) {
  const name = entry.pkg;
  const sourceDir = bundledSourceDir(entry);
  if (!fs.existsSync(path.join(sourceDir, "package.json"))) {
    throw new Error(`built-in plugin source missing: ${sourceDir}`);
  }
  const sourceName = readPackageName(sourceDir);
  if (sourceName && sourceName !== name) {
    throw new Error(`built-in plugin name mismatch: ${sourceDir} is "${sourceName}", expected "${name}"`);
  }
  const stagingDir = bundledStagedDir(entry, stagingRoot);
  if (/[\s"&|^%!<>]/u.test(stagingDir)) {
    throw new Error(
      `built-in plugin staging path contains characters the engine's shell cannot carry (${stagingDir}); ` +
        "pass a stagingRoot without spaces or cmd metacharacters",
    );
  }
  await fsp.rm(stagingDir, { recursive: true, force: true });
  await copyDirRecursive(sourceDir, stagingDir);
  if (stagingRoot) pruneStaleStagingDirs(stagingRoot);
  log("built-in plugin staged:", sourceDir, "->", stagingDir);
  return stagingDir;
}

/**
 * 已装着的内置插件要不要重装？（GUI 换版本后随包插件有更新时的自动更新判定）
 *
 * 抽成纯函数是为了能被测：这段判定此前**没有任何用例**，而它是「GUI 更新后内置插件自动更新」
 * 的**唯一**开关 —— 写错一个不等号，要么用户永远拿不到新插件，要么每次启动都被无人值守地
 * 降级回随包那份（应用回滚过、市场侧更新过、或手工换过更新的副本时都会发生）。
 *
 * @param sameSource - 已装的那份是不是我们 staging 出来的随包拷贝。指向别处（开发 checkout、
 *   旧版 staging、npm/git 安装）都算 false —— 那时应用不再自包含：实测过依赖指向某个 checkout、
 *   目录一没了应用就装不上插件。
 * @param sourceVersion - 随包源码 package.json 里的版本。
 * @param installedVersion - 已装那份 package.json 里的版本。
 * @returns `{ wantsUpdate, reason }`；reason 供调用方打日志（`same-version` 不打）。
 */
function planBundledPluginUpdate({ sameSource, sourceVersion, installedVersion }) {
  if (!sameSource) return { wantsUpdate: true, reason: "foreign-source" };
  // 任一侧读不到版本就什么都不做：猜不出新旧，宁可不动现有的安装。
  if (!sourceVersion || !installedVersion) return { wantsUpdate: false, reason: "unknown-version" };
  // 只在**随包更新**时重装。`!==` 会让「已装版本比随包新」也触发 remove+add —— 那是降级。
  // 版本号不可解析时才退回不等式。
  const bothValid = semver.valid(sourceVersion) !== null && semver.valid(installedVersion) !== null;
  const newer = bothValid ? semver.gt(sourceVersion, installedVersion) : sourceVersion !== installedVersion;
  if (newer) return { wantsUpdate: true, reason: "bundled-newer" };
  return { wantsUpdate: false, reason: installedVersion === sourceVersion ? "same-version" : "keeping-newer" };
}

/**
 * 清掉 staging 目录里**已不在目录里**的旧插件拷贝。
 *
 * 这些残留不只是占磁盘：profile 里若有指向它们的 `file:` 依赖，它们让那条依赖始终
 * 「可解析」，于是旧包清理一旦漏一处，引擎的 reconcile 立刻把旧包重新登记回 bundles，
 * 新旧两版同时加载。只删 LEGACY_PLUGIN_PKGS 里、且不在现役目录中的名字（保守：不碰
 * 任何我们不认识的目录）。
 */
function pruneStaleStagingDirs(stagingRoot) {
  const live = new Set(CATALOG.map((entry) => entry.pkg));
  for (const legacy of LEGACY_PLUGIN_PKGS) {
    if (live.has(legacy.pkg)) continue;
    try {
      fs.rmSync(path.join(stagingRoot, legacy.pkg), { recursive: true, force: true });
    } catch {
      /* 删不掉就留着，不影响安装 */
    }
  }
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

/**
 * 引擎 / 宿主自己的 row id：任何插件都不得经设置窗口的开关禁用它们。
 *
 * 为什么必须有这份名单：补丁层是按 **row id** 合并的，写一行 `- id: llm-pi-ai`
 * + `disabled: true` 命中的是引擎那一行，而不是「谁的行」。本仓库自己的插件
 * （dsh-opencode-go）就只是给 `llm-pi-ai` 补一个 provider 的 `api` 字段，一旦
 * 这个 id 被当成插件自己的行禁掉，所有目录外模型立刻报 `needs an api`，等于把
 * 整个 LLM 路由关掉。`session-persistence-jsonl` 同理：关掉它 = 会话历史不再
 * 落盘。名单只增不减，追加时把「关掉它的后果」写在旁边。
 */
const PROTECTED_ROW_IDS = new Set([
  // 引擎的 LLM 路由行：插件只是给它补 config，绝不能被它反过来关掉。
  "llm-pi-ai",
  // 会话 JSONL 落盘行：关掉它等于会话不再写入磁盘。
  "session-persistence-jsonl",
]);

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

/**
 * 逐行扫补丁层文本，取出顶层 `- id: X` + `disabled: true|false` 两类行。
 *
 * 缩进**不敏感**：引擎把补丁层当 YAML 解析，`- id:` 与 `disabled:` 的缩进都不是固定的
 * （市场的解析器同样不敏感）。钉死列 0 / 两空格会让「市场只禁用（state.json）→ GUI 启用」
 * 这种两行同 id 的状态读不出来，于是下一次禁用再追加一行，最终同一 id 出现两行，
 * 生效结果取决于引擎的合并顺序。
 */
function patchTextState(text) {
  const disables = new Set();
  const forced = new Set();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = /^([ \t]*)- id: (['"]?)([A-Za-z0-9_.-]+)\2[ \t]*(?:#.*)?$/.exec(lines[i]);
    if (!m) continue;
    // `disabled:` 必须缩进更深（属于该条目），且允许行尾空白/注释。
    const next = lines[i + 1] ?? "";
    const indent = m[1].length;
    const d = /^([ \t]*)disabled:[ \t]*(true|false)[ \t]*(?:#.*)?$/.exec(next);
    if (!d || d[1].length <= indent) continue;
    if (d[2] === "true") disables.add(m[3]);
    else forced.add(m[3]);
  }
  return { disables, forced };
}

/** 用户补丁层的 disables/forced 集合（读 <profile>/cordis.patch.yml）。 */
function readUserPatchState(dshHome) {
  return patchTextState(readPatchText(userPatchPath(dshHome)));
}

/** `insert:` 键所在行（缩进任意；行尾可有空白/注释）。 */
const INSERT_KEY_RE = /^([ \t]*)- insert:[ \t]*(?:#.*)?$/;
/** `insert:` 块里的条目行（缩进任意；id 的引号可选；行尾可有空白/注释）。 */
const INSERT_ROW_ID_RE = /^([ \t]*)- id:[ \t]*(['"]?)([A-Za-z0-9_.-]+)\2[ \t]*(?:#.*)?$/;

/**
 * 一段补丁文本里 `insert:` 块声明的 row id（**缩进无关**）。
 *
 * 为什么不能钉死 4 空格缩进：引擎把补丁层当 YAML 解析（任何缩进都合法），市场
 * 自己的解析器也与缩进无关。旧实现只认 `^ {4}- id:`，于是 2 / 6 空格缩进的插件
 * 一个 row id 都取不到——setPluginEnabled 只写了市场 state.json 就返回成功，
 * 设置窗口显示「已禁用」，引擎却照常加载这个插件（正是「显示禁用但还在跑」的
 * 根因）。
 *
 * 只取 `insert:` 块里的行：补丁里还有「重配邻居」的行（如顶层 `- id: llm-pi-ai`），
 * 把 `disabled: true` 写到那类行上会连带打掉邻居功能（市场 #147 的教训）。
 */
function insertRowIdsInText(text) {
  const ids = new Set();
  let insertIndent = null;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    // 注释 / 空行不改变 YAML 结构，也不结束 insert 块。
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const open = INSERT_KEY_RE.exec(line);
    if (open) {
      insertIndent = open[1].length;
      continue;
    }
    if (insertIndent === null) continue;
    const indent = /^[ \t]*/.exec(line)[0].length;
    // 缩进回到 `- insert:` 同一层（或更浅）= 下一个条目，insert 块到此结束。
    if (indent <= insertIndent) {
      insertIndent = null;
      continue;
    }
    const m = INSERT_ROW_ID_RE.exec(line);
    if (m) ids.add(m[3]);
  }
  return ids;
}

/**
 * 某个已装包在补丁层里占用的 row id：它自己 `insert:` 的行。
 * 只取该包插入的行——补丁里还可能包含「重配邻居」的行（如某个 bundle 调
 * attachment-local 的 config），把 `disabled: true` 写到那类行上会连带打掉
 * 邻居功能（市场 #147 的教训）。
 *
 * 只读**引擎真正会加载的那一个**补丁文件，且必须落在包目录内：
 *   - `dsh.bundle.patch` 来自第三方 package.json，可以写 `../../..` 指到别的文件
 *     （实测可用它把 `webserver`/`modules` 之类引擎行的 id 认领成自己的，随后被 GUI
 *     名正言顺地 disable）；越界一律忽略。
 *   - 引擎只加载 `join(packageDir, declared)`。包根再放一个**未被声明**的
 *     `cordis.patch.yml` 对引擎是不可见的；GUI 若也去读它，等于任何包都能凭一个没人
 *     加载的文件认领任意 row id（实测能拿到引擎的 `session`）。所以声明了什么就读什么，
 *     只有在**没有声明**时才退回约定文件名 —— 那正是引擎自己的规则。
 */
function packageRowIds(dshHome, pkg) {
  const ids = new Set();
  const pkgDir = path.join(profileDir(dshHome), "node_modules", pkg);
  const collect = (patchFile) => {
    if (patchFile === null) return;
    for (const id of insertRowIdsInText(readPatchText(patchFile))) ids.add(id);
  };
  /** 解析后的路径必须仍在包目录内（相对、非空、不以 .. 开头）。 */
  const contained = (target) => {
    const rel = path.relative(pkgDir, target);
    return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
  };
  let declared = null;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(pkgDir, "package.json"), "utf8"));
    const value = manifest?.dsh?.bundle?.patch;
    if (typeof value === "string" && value !== "") declared = value;
  } catch {
    /* 包未安装：没有可归属的行 */
  }
  if (declared !== null) {
    const resolved = path.resolve(pkgDir, declared);
    // 越界：不读、不认领任何 row id（调用方只会看到「这个包没有可归属的行」）。
    if (contained(resolved)) collect(resolved);
    return [...ids];
  }
  collect(path.join(pkgDir, "cordis.patch.yml"));
  return [...ids];
}

/**
 * profile node_modules 下声明了 `dsh.bundle.patch` 的包名（直接子目录 + @scope/name）。
 * 市场手装的插件不在 CATALOG 里，只能从目录里扫出来——归属校验必须看得见它们。
 */
function declaredPatchPackages(dshHome) {
  const names = [];
  const modulesRoot = path.join(profileDir(dshHome), "node_modules");
  let entries;
  try {
    entries = fs.readdirSync(modulesRoot, { withFileTypes: true });
  } catch {
    return names; // 还没有 node_modules：没有别的包
  }
  const consider = (dir, name) => {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
      if (typeof manifest?.dsh?.bundle?.patch === "string" && manifest.dsh.bundle.patch !== "") {
        names.push(name);
      }
    } catch {
      /* 没有可读 package.json 的目录不是包 */
    }
  };
  for (const entry of entries) {
    // `isDirectory()` 对 symlink/junction 是 false —— 而 pnpm 的非 hoisted 布局、`link:`/`file:`
    // 依赖、开发期软链都属于这种。归属校验若看不见它们，一个共享同一 row id 的软链包就会被
    // 静默一并禁用。这里改成跟随链接的 statSync 判断。
    const isDirOrLink = entry.isDirectory() || entry.isSymbolicLink();
    if (!isDirOrLink || entry.name.startsWith(".")) continue;
    if (entry.isSymbolicLink()) {
      try {
        if (!fs.statSync(path.join(modulesRoot, entry.name)).isDirectory()) continue;
      } catch {
        continue; // 断链
      }
    }
    const dir = path.join(modulesRoot, entry.name);
    if (!entry.name.startsWith("@")) {
      consider(dir, entry.name);
      continue;
    }
    let scoped = [];
    try {
      scoped = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      scoped = [];
    }
    for (const sub of scoped) {
      if (sub.isDirectory()) consider(path.join(dir, sub.name), `${entry.name}/${sub.name}`);
    }
  }
  return names;
}

/**
 * 该 row id 是否被**别的**已装 bundle 的 `insert:` 也声明了。
 *
 * 为什么必须拦：cordis 按 row id 合并补丁层，禁用写的是 `- id: X`，命中的是 id
 * 本身而不是「谁的哪一行」。两个 bundle 都 insert 同一个 id 时，写下去会顺手关掉
 * 另一个插件的功能，而设置窗口还以为只关了自己那个（市场 #147 是同一类事故）。
 * 宁可拒绝并让界面报失败，也不能静默改写别人的行。
 *
 * 候选来源两个都要看：CATALOG 里已装的条目，以及 profile node_modules 下所有
 * 声明了 `dsh.bundle.patch` 的包（市场手装的插件不在目录里）。
 * @returns {string|null} 冲突方的包名（没有冲突返回 null）
 */
function foreignRowIdOwner(dshHome, pkg, rowId) {
  const bundles = new Set(installedBundles(dshHome));
  const candidates = new Set(declaredPatchPackages(dshHome));
  for (const entry of CATALOG) if (bundles.has(entry.pkg)) candidates.add(entry.pkg);
  for (const name of candidates) {
    if (name === pkg) continue;
    if (packageRowIds(dshHome, name).includes(rowId)) return name;
  }
  return null;
}

/**
 * 禁用某个 row id 前必须拒绝的情形；可以写时返回 null。
 * 拒绝原因原样交给设置窗口（main.js 把它放进 error 字段，界面显示「失败：…」）。
 */
function disableRefusalReason(dshHome, pkg, rowId) {
  if (PROTECTED_ROW_IDS.has(rowId)) {
    return `row "${rowId}" belongs to the engine and cannot be disabled`;
  }
  const owner = foreignRowIdOwner(dshHome, pkg, rowId);
  if (owner) {
    return `row "${rowId}" is also inserted by "${owner}"; disabling it would turn that plugin off`;
  }
  return null;
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
 * 补丁层写入队列（按文件路径）：每次改动都是一次「读全文 → 改 → 写回」，两次改动
 * 交错时后写的一方会拿自己读到的旧快照覆盖前一方刚写下的行（禁用行被抹掉，引擎照
 * 常加载）。同步入口（setPluginEnabled / removePatchRows）在一次调用里读完改完写
 * 完、不向事件循环让出，天然互斥；**异步**入口（启动维护、旧插件迁移这类 await
 * 之间会回到事件循环的路径）必须经这里排队，才彼此不交错。
 */
const patchWriteQueues = new Map();

/** 同步睡眠（Atomics.wait 阻塞线程、不空转 CPU）。 */
function sleepSync(ms) {
  if (typeof SharedArrayBuffer !== "function") return;
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * 跨进程互斥：`<patch>.lock` 用 `wx` 独占创建。
 *
 * 进程内的 promise 队列挡不住**另一个 GUI 进程**（更挡不住插件市场在引擎进程里的写入）：
 * 两边各自「读—改—写」，后写的一方用自己那份**陈旧快照**覆盖，先写的行就没了 —— 实测
 * 3 进程 × 40 行会丢 17–28 行，而调用还返回 ok:true。所以整段读改写必须在锁里完成。
 * 锁是同步的（调用方按同步契约使用 setPluginEnabled），因此用 Atomics.wait 等待。
 * 锁文件超过 10 秒视为持有者已崩溃，强删重试。
 */
function withPatchLock(patchPath, task) {
  const lockPath = `${patchPath}.lock`;
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      const fd = fs.openSync(lockPath, "wx");
      try {
        return task();
      } finally {
        try {
          fs.closeSync(fd);
        } catch {
          /* 已关闭 */
        }
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {
          /* 释放尽力而为 */
        }
      }
    } catch (error) {
      if ((error && error.code) !== "EEXIST") {
        return { ok: false, reason: `patch layer lock failed: ${(error && error.message) || error}` };
      }
      // 抢锁失败：先判断是不是陈旧锁（持有者崩了），再判断超时，最后才睡。
      // 这个顺序很重要：早先两处 `continue` 绕过了 deadline 与 sleep，于是 statSync
      // 持续抛错时（EACCES/EPERM、网络盘）这里会变成**不睡的紧循环**，把主进程钉死。
      let stale = false;
      try {
        stale = Date.now() - fs.statSync(lockPath).mtimeMs > 10_000;
      } catch {
        /* 锁刚好被释放：下一轮重试即可 */
      }
      if (stale) {
        try {
          fs.rmSync(lockPath, { force: true });
        } catch {
          /* 删不掉就下一轮再试，超时后放弃 */
        }
      }
      if (Date.now() > deadline) return { ok: false, reason: "patch layer is locked by another writer" };
      sleepSync(25);
    }
  }
}

/** 排队执行一次补丁层改动；前一个任务失败不挡住后一个（失败由它自己的返回值报告）。 */
function queuePatchMutation(patchPath, task) {
  const previous = patchWriteQueues.get(patchPath) ?? Promise.resolve();
  const result = previous.then(task, task);
  const tail = result.then(() => {}, () => {});
  patchWriteQueues.set(patchPath, tail);
  tail.then(() => {
    if (patchWriteQueues.get(patchPath) === tail) patchWriteQueues.delete(patchPath);
  });
  return result;
}

/**
 * 廉价结构检查：文本还是不是一份「顶层条目列表」——补丁层的合法形状。
 *
 * 不是这个形状（空文件、纯注释、被截断成半行、顶层流式 `{...}`）时 dsh 会直接
 * 拒绝启动该 profile，所以每次写回后都要再读一遍确认形状没坏。规则：顶层只能是
 * `- ...` 条目（模板的空占位 `[]` 也算），缩进行必须落在某个条目内部，注释 / 空行
 * 不改变结构。
 */
function isTopLevelEntryList(text) {
  let started = false;
  let inEntry = false;
  let sawPlaceholder = false;
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (/^[ \t]/.test(line)) {
      if (!inEntry) return false; // 缩进行必须属于前面那个顶层条目
      // 缩进行必须是 YAML 的映射项（`key:`）或序列项（`- `）。这能挡住「顶层条目 +
      // 一段垃圾缩进」（如 `  <<< not yaml`）被判为合法 —— 那种层引擎解析会直接失败。
      if (!/^[ \t]*(?:-[ \t]|-[ \t]*$|[^\s#][^:]*:)/.test(line)) return false;
      continue;
    }
    if (sawPlaceholder) return false; // 空占位 `[]` 只能单独出现，其后再有内容就是两个顶层节点
    if (!started && !inEntry && (trimmed === "---" || trimmed.startsWith("%"))) continue; // 文档起始标记 / YAML 指令
    if (trimmed === "[]" || trimmed === "[ ]") {
      if (started || inEntry) return false;
      started = true;
      sawPlaceholder = true;
      continue;
    }
    if (trimmed === "-" || trimmed.startsWith("- ")) {
      started = true;
      inEntry = true;
      continue;
    }
    return false; // 顶层出现了非条目内容
  }
  return started;
}

/**
 * 补丁层的「读—改—写」事务：先写临时文件再 rename（与 writeProfileManifest 同一
 * 套路），中途崩溃只会留下临时文件，绝不会留下被截断的 cordis.patch.yml。
 *
 * 写完后再读一遍做结构检查；形状不对（磁盘写坏、外部程序同时改写）就把改动前的
 * 字节还原回去再报失败——宁可这次改动没生效，也不能把一份能启动的补丁层换成不能
 * 启动的（写坏的补丁层会让整个 profile 起不来，比这次改动失败严重得多）。
 *
 * @param {string} patchPath
 * @param {(text: string) => {ok: boolean, text?: string, reason?: (string|null)}} transform
 *   纯函数：拿当前文本算出新文本（与原文相同则不落盘），或返回拒绝原因。
 * @returns {{ok:boolean, reason:(string|null)}}
 */
function mutatePatchFile(patchPath, transform) {
  // 整段读改写都在跨进程锁里（见 withPatchLock）：只有「写后校验」是不够的 —— 别的进程
  // 可以在我们校验通过之后用它的旧快照覆盖掉我们写的那一行。
  return withPatchLock(patchPath, () => mutatePatchFileLocked(patchPath, transform));
}

function mutatePatchFileLocked(patchPath, transform, attempt = 0) {
  let previous = null;
  let existed = false;
  try {
    previous = fs.readFileSync(patchPath);
    existed = true;
  } catch (error) {
    // 只有 ENOENT 才是「文件还不存在」。EACCES/EBUSY/EISDIR 之类若也当成不存在，变换就会
    // 在空文本上跑、写回时把**整层补丁**（别的插件的行、引擎行的覆盖）替换掉，而且形状
    // 检查还会通过（新内容本身是合法列表）→ 返回 ok:true。
    if ((error && error.code) === "ENOENT") {
      previous = null;
    } else {
      return { ok: false, reason: `patch layer unreadable: ${(error && error.message) || error}` };
    }
  }
  const text = previous === null ? "" : previous.toString("utf8").replace(/^\uFEFF/, "");
  let plan;
  try {
    plan = transform(text);
  } catch (error) {
    return { ok: false, reason: `patch layer transform failed: ${(error && error.message) || error}` };
  }
  if (!plan || !plan.ok) return { ok: false, reason: (plan && plan.reason) || "patch layer write refused" };
  if (plan.text === undefined || plan.text === text) return { ok: true, reason: null };
  // 唯一临时名：固定 `<file>.tmp` 会被同机另一个写者（插件市场在引擎进程里写同一个文件）
  // 抢用——一方 rename 之后发布的是**另一方的字节**，而那份文本同样是合法条目列表，形状
  // 检查根本发现不了，于是「丢了行」还会报 ok:true。
  const tmp = `${patchPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, plan.text);
    fs.renameSync(tmp, patchPath);
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 临时文件清理尽力而为 */
    }
    return { ok: false, reason: `patch layer write failed: ${(error && error.message) || error}` };
  }
  const after = readPatchText(patchPath);
  // 内容必须**正是我们写的那份**：插件市场在引擎进程里也写这个文件（它不走我们的锁），
  // 它的快照同样是合法条目列表、但少了我们这行。这种情况重来一次（读它的新文本再改），
  // 连续失手才如实报失败 —— 绝不让界面显示成「已禁用」而磁盘上没有那一行。
  if (after !== plan.text) {
    if (attempt < 2) return mutatePatchFileLocked(patchPath, transform, attempt + 1);
    return { ok: false, reason: "patch layer was rewritten concurrently; the change did not stick" };
  }
  // 形状不对：回滚并报失败。这里**不能**重试 —— 重试会在「已写进去的坏文本」上重算，
  // 看到目标行已存在而返回 ok:true，把形状损坏掩盖掉。
  if (isTopLevelEntryList(after)) return { ok: true, reason: null };
  try {
    if (!existed) fs.rmSync(patchPath, { force: true });
    else {
      fs.writeFileSync(tmp, previous);
      fs.renameSync(tmp, patchPath);
    }
  } catch {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 还原失败：仍按失败上报，界面不会显示成「已禁用」 */
    }
  }
  return { ok: false, reason: "patch layer is not a top-level entry list after the write; reverted" };
}

/**
 * 追加一条顶层补丁项后的文本；文件不是合法条目列表时**拒绝写入**（拒绝本身就是
 * 保护：已经写坏的补丁层绝不能被弄得更坏）。纯函数，供 disable/enable 在同一个
 * 读—改—写里复用。
 */
function appendPatchEntryText(text, block) {
  const core = text.trim();
  if (core === "") return { ok: true, text: block };
  const withoutComments = text.replace(/^[ \t]*#.*$/gmu, "").trim();
  if (withoutComments === "") {
    const next = text.endsWith("\n") ? text : `${text}\n`;
    return { ok: true, text: `${next}${block}` };
  }
  if (withoutComments === "[]" || withoutComments === "[ ]") {
    // dsh 模板自带一个空的 `[]` 占位；直接往后追加会得到两个顶层元素。
    const commented = text.replace(/^[ \t]*\[[ \t]*\][ \t]*(?:#.*)?(?:\r?\n|$)/mu, "# []\n");
    const next = commented.endsWith("\n") ? commented : `${commented}\n`;
    return { ok: true, text: `${next}${block}` };
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
  return { ok: true, text: `${next}${block}` };
}

/** 禁用一行：追加 `- id: X` + `disabled: true`（幂等：同一份读—改—写里判重）。 */
function disablePatchRow(patchPath, rowId) {
  if (!ROW_ID_RE.test(rowId)) return { ok: false, reason: `row id cannot be written: ${rowId}` };
  return mutatePatchFile(patchPath, (text) => {
    const state = patchTextState(text);
    if (state.disables.has(rowId)) return { ok: true, text };
    // 已经有一行 `disabled: false`（市场只禁用、GUI 启用过）→ 就地翻转那一行。
    // 旧写法会再 append 一行 `disabled: true`，同一 id 两行，生效结果取决于引擎的合并顺序。
    if (state.forced.has(rowId)) {
      const forcedRe = new RegExp(
        `^([ \\t]*)- id: ['"]?${escapeRegExp(rowId)}['"]?[ \\t]*(?:#.*)?\\r?\\n([ \\t]*)disabled:[ \\t]*false[ \\t]*(?:#.*)?$`,
        "mu",
      );
      if (forcedRe.test(text)) {
        return {
          ok: true,
          text: text.replace(forcedRe, (_m, idIndent, disabledIndent) => `${idIndent}- id: ${rowId}\n${disabledIndent}disabled: true`),
        };
      }
    }
    return appendPatchEntryText(text, rowBlock(rowId, true));
  });
}

/** 启用一行：删掉 `disabled: true` 块；被下层按住时写 `disabled: false` 强制启用。 */
function enablePatchRow(patchPath, rowId) {
  if (!ROW_ID_RE.test(rowId)) return { ok: false, reason: `row id cannot be written: ${rowId}` };
  return mutatePatchFile(patchPath, (text) => {
    // 缩进不敏感 + 全局替换：旧写法要求恰好 `- id: x\n  disabled: true\n`（列 0、两空格、
    // 结尾换行），任何一处不同都会走到下面的 append，于是同一 id 留下两行；`replace`
    // 不带 g 时，重复块也只删掉一半。
    const blockRe = new RegExp(
      `^([ \\t]*)- id: ['"]?${escapeRegExp(rowId)}['"]?[ \\t]*(?:#.*)?\\r?\\n[ \\t]*disabled:[ \\t]*true[ \\t]*(?:#.*)?\\r?\\n`,
      "gmu",
    );
    if (blockRe.test(text)) {
      return { ok: true, text: withPlaceholderRestored(text.replace(blockRe, "")) };
    }
    if (patchTextState(text).forced.has(rowId)) return { ok: true, text };
    return appendPatchEntryText(text, rowBlock(rowId, false));
  });
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
 * 禁用前先做归属校验（见 disableRefusalReason）：row id 属于引擎或别的插件时
 * **拒绝**并且什么都不写（连市场 state.json 也不动），返回 `ok:false` + 原因，
 * 让设置窗口报失败——写下去只会造成「界面说已禁用、引擎照常加载」或「顺手关掉
 * 别人的功能」。
 *
 * @param {object} o
 * @param {string} o.dshHome
 * @param {string} o.pkg     包名（市场 state.json 的键）
 * @param {string[]} o.rowIds 该包在补丁层占用的 row id（packageRowIds 的结果）
 * @param {boolean} o.enabled
 * @returns {{ok:boolean, changed:boolean, patchOk:boolean, reason:(string|null)}}
 *   ok:false 表示被拒绝 / 写入失败，reason 是人类可读的原因。
 */
function setPluginEnabled({ dshHome, pkg, rowIds, enabled }) {
  const patchPath = userPatchPath(dshHome);
  const ids = Array.isArray(rowIds) && rowIds.length ? rowIds : [];
  if (!enabled) {
    for (const rowId of ids) {
      const refusal = disableRefusalReason(dshHome, pkg, rowId);
      if (refusal) return { ok: false, changed: false, patchOk: false, reason: refusal };
    }
  }
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
  //
  // 但补丁层写失败时**不能**去翻这个状态：那样磁盘上是「补丁层没改、state.json 说已禁用」，
  // 界面与市场都会显示「已禁用（插件市场）」而引擎照旧加载 —— 正是本模块要消除的那个漂移。
  // 写失败就只报失败，durable state 保持原样（用户重试即可）。
  if (!patchOk) return { ok: false, changed: false, patchOk: false, reason };
  const marketDisabled = readMarketDisabled(dshHome);
  const next = new Set(marketDisabled);
  if (enabled) next.delete(pkg);
  else next.add(pkg);
  writeMarketDisabled(dshHome, [...next]);
  return { ok: true, changed: true, patchOk: true, reason: null };
}

/**
 * 某个目录条目是否带**页面半边**（package.json 的 `dsh.client`）。
 *
 * 这个事实决定了「启用 / 禁用」之后还需不需要刷新 Harness 页面：
 *   - 引擎的 live 补丁重载只重放启动时捕获的 bundle 补丁 + 实时补丁文件，
 *     所以宿主半边随补丁层即时挂载/卸载；
 *   - 但页面里**已经加载**的客户端 bundle 不会自己出现或消失，启用/禁用后
 *     那一半要刷新页面才同步（GUI 会在市场返回 refresh 时给出「刷新页面」按钮）。
 *
 * 已装 → 读 profile node_modules 里的真实 package.json（权威）；未装 → 用目录
 * 条目里核实过的 `entry.client` 声明。拆仓后插件从 npm 安装，本地没有源码可读，
 * 而「是否含页面半边」决定启用/禁用后要不要刷新页面，必须安装前就能显示。
 * @returns {boolean|null}
 */
function pluginHasClientHalf(dshHome, entry) {
  try {
    const file = path.join(profileDir(dshHome), "node_modules", entry.pkg, "package.json");
    const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
    return manifest?.dsh?.client !== undefined && manifest?.dsh?.client !== null;
  } catch {
    /* not installed (or unreadable) — fall back to the catalog declaration */
  }
  return typeof entry.client === "boolean" ? entry.client : null;
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
    // package name (bundles never contains a `file:` spec), so compare against `pkg`.
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
      // 是否含页面半边 → 决定「启用/禁用后是否还需刷新页面」（见该函数注释）。
      client: pluginHasClientHalf(dshHome, entry),
    };
  }
  return out;
}

/**
 * 运行一次 `dsh plugin --profile web <args...>`（引擎会转发给 pnpm 并 reconcile bundles）。
 * @param {object} o
 * @returns {Promise<{ok:boolean, code:number, output:string}>}
 */
function runDshPlugin({ engineDir, dshHome, pnpmBinDir, args, nodeExec, log = () => {}, timeoutMs = 600000 }) {
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
    let settled = false;
    let timer = null;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer !== null) clearTimeout(timer);
      resolve(value);
    };
    const sink = (chunk) => {
      const text = String(chunk ?? "");
      output = (output + text).split(/\r?\n/u).slice(-20).join("\n");
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", sink);
    child.stderr.on("data", sink);
    child.on("error", (error) => finish({ ok: false, code: -1, output: String((error && error.message) || error) }));
    child.on("close", (code) => finish({ ok: code === 0, code: code ?? -1, output }));
    // 没有超时的话，pnpm 卡在 store 锁 / 网络 / 交互提示时这个 Promise **永不 settle**：
    // 设置窗口的进度条永远在转、子进程与管道常驻，重复点击还会继续累积。
    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        /* 已经退出 */
      }
      finish({ ok: false, code: -1, output: `${output}\n[dsh plugin timed out after ${timeoutMs}ms]` });
    }, timeoutMs);
  });
}

/**
 * 安装单个包（幂等：已在 bundles **且确实落地**则跳过）。`pkg` 是给 pnpm 的安装 spec。
 */
async function installPlugin({ engineDir, dshHome, pnpmBinDir, pkg, name, nodeExec, log = () => {} }) {
  const target = name ?? pkg;
  if (installedBundles(dshHome).includes(target)) {
    // 「登记在 bundles 里」不等于「装好了」：登记还在、node_modules 的拷贝却被删掉时，早退
    // 会让调用方拿到「什么都没装、也没有错误」→ 界面显示 `失败：?`，点多少次都不修复（只有
    // 下次引擎启动的 heal 才会补）。这里要求落地文件确实存在，否则继续走安装。
    const materialised = fs.existsSync(path.join(profileDir(dshHome), "node_modules", target, "package.json"));
    if (materialised) {
      log("plugin already installed:", target);
      return { ok: true, already: true };
    }
    log("plugin is registered but missing on disk; reinstalling:", target);
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
    replacedBy: "dsh-model-surplus",
  },
  // 两个 OpenCode Go 插件合并为 dsh-opencode-go（协议声明 + V4.1 模型 + 会话头）。
  // 旧包各自带着自己的 row id，两者都要清——否则补丁层会留下指向不存在行的
  // `disabled: true`（启动期 orphan），而且旧包登记不摘掉会与新包同时加载。
  {
    pkg: "dsh-opencode-go-session",
    rowIds: ["opencode-go-session-header"],
    replacedBy: "dsh-gateway-models",
  },
  {
    pkg: "dsh-opencode-go-api",
    rowIds: ["opencode-go-api"],
    replacedBy: "dsh-gateway-models",
  },
  // v0.4.0/v0.4.1 把三个插件**随壳捆绑**在 plugins/ 下，用 `file:` 装进 profile——
  // 它们当时都从未发布到 npm。拆仓后改为从 registry 安装，而其中两个在 npm 上的
  // 同名包已被别人占用，于是各换了名字。旧包名仍留在老用户的 profile 里（bundles
  // 登记 + package.json 的 file: 依赖），必须清掉，否则新旧两份会被引擎同时加载。
  {
    pkg: "dsh-opencode-go",
    rowIds: ["opencode-go"],
    replacedBy: "dsh-gateway-models",
  },
  // 纯改名：`dsh-opencode-go-path` → `dsh-gateway-models`（2026-09-25）。它已经不只管
  // OpenCode Go，还给 Command Code 声明协议+地址并同步模型清单，所以换了个不带厂商的
  // 名字，顺手丢掉了当年只为绕开 npm 重名而加的 `-path` 后缀（`dsh-opencode-go` 与
  // `dsh-opencode-go-plus` 都被社区占着）。
  //
  // rowIds 写 `opencode-go` 是**照实记录旧包占过哪个行**，不是要清它：新包用着同一个
  // 行 id，而 removeLegacyPlugins 会按 liveCatalogRowIds() 把现役行过滤掉，所以那条
  // `disabled` 永远不会被写坏 —— 用户保存的启用/禁用选择正好跟着新包走。
  {
    pkg: "dsh-opencode-go-path",
    rowIds: ["opencode-go"],
    replacedBy: "dsh-gateway-models",
  },
  {
    pkg: "dsh-composer-keys",
    rowIds: ["composer-keys"],
    replacedBy: "dsh-keys-setting",
  },
  // `dsh-model-usage` 是每一个 v0.4.x 用户都装着的那个名字（随壳捆绑）。npm 上
  // 那个名字本身是空的，但 GitHub 上已经有三个别人的同名仓库、其中两个的
  // package.json 也写着这个名字——谁先 publish 谁拿到，所以拆仓时直接换成了
  // `dsh-model-surplus`。补丁层行 id 仍是 `model-usage`（新包也用同一个），
  // 因此禁用行不会失配。
  {
    pkg: "dsh-model-usage",
    rowIds: ["model-usage"],
    replacedBy: "dsh-model-surplus",
  },
  // `dsh-composer-keys-setting` 只是一个短暂的中间名——它从未发布到 npm，v0.5.0 也
  // 没随壳发过。留着这条是为了兜住开发机/本地 `file:` 装过它的环境：这个包一旦残留在
  // profile 里，引擎仍会加载它，于是与新包同时挂载、设置行出现两遍。清理成本为零，
  // 与上面 `dsh-opencode-go`（同样从未上过 npm）的处理保持一致。
  {
    pkg: "dsh-composer-keys-setting",
    rowIds: ["composer-keys"],
    replacedBy: "dsh-keys-setting",
  },
];

/** 摘掉补丁层里这些 row id 的 `disabled: true|false` 行（含 `[]` 占位还原）。 */
function removePatchRows(dshHome, rowIds) {
  if (!Array.isArray(rowIds) || rowIds.length === 0) return [];
  const patchPath = userPatchPath(dshHome);
  const removed = [];
  const res = mutatePatchFile(patchPath, (text) => {
    let next = text;
    for (const rowId of rowIds) {
      if (!ROW_ID_RE.test(rowId)) continue;
      // 与 enablePatchRow 用同一条缩进不敏感正则，并且带 `g`：钉死「列 0 的 `- id:` +
      // 恰好两空格 + 结尾换行」时，任何手写或其它工具用别的缩进写的行都删不掉，而读者
      // （patchTextState）是缩进无关的 —— 界面上读到「已禁用」，磁盘上这个 orphan 却
      // 永远清不掉，旧包清理也静默地什么都不做。
      const blockRe = new RegExp(
        `^([ \\t]*)- id: ['"]?${escapeRegExp(rowId)}['"]?[ \\t]*(?:#.*)?\\r?\\n[ \\t]*disabled:[ \\t]*(?:true|false)[ \\t]*(?:#.*)?\\r?\\n`,
        "gmu",
      );
      if (!blockRe.test(next)) continue;
      next = next.replace(blockRe, "");
      removed.push(rowId);
    }
    return removed.length > 0 ? { ok: true, text: withPlaceholderRestored(next) } : { ok: true, text };
  });
  // 被拒 / 写后校验失败 = 什么都没落地：报「没摘掉」，不能假成功。
  return res.ok ? removed : [];
}

/**
 * 现役目录条目在补丁层占用的 row id。
 *
 * 为什么必须有这个：改名时**刻意保留**了补丁层行 id（`model-usage` / `composer-keys` /
 * `opencode-go`），好让用户保存的启用/禁用选择跟着新包走 —— 于是旧包名的 rowIds 与现役
 * 条目**完全同名**。清理旧包遗留行时若不排除这些 id，就等于每次启动都把用户对现役插件的
 * 禁用行删掉：界面上「已禁用」的插件在下次启动后静默恢复加载（补丁行没了，而
 * reconcilePluginEnabled 只在市场 state.json 记着禁用时才会补行）。
 *
 * 两处都看：已装包（权威，与 catalogStatus 同源）与随包副本（插件尚未安装时也认得出）。
 */
function liveCatalogRowIds(dshHome) {
  const ids = new Set();
  for (const entry of CATALOG) {
    for (const id of packageRowIds(dshHome, entry.pkg)) ids.add(id);
    try {
      const patchFile = path.join(bundledSourceDir(entry), "cordis.patch.yml");
      if (fs.existsSync(patchFile)) {
        for (const id of insertRowIdsInText(readPatchText(patchFile))) ids.add(id);
      }
    } catch {
      /* 随包副本不可读（未打包运行且 plugins/ 缺失）：已装包那条路径已经覆盖 */
    }
  }
  return ids;
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
async function removeLegacyPlugins({ engineDir, dshHome, nodeExec, pnpmInstallDir, stagingRoot = null, log = () => {} }) {
  const result = { pruned: [], removedRows: [], replaced: [], changed: false };
  let bundles;
  try {
    bundles = new Set(installedBundles(dshHome));
  } catch (error) {
    log("legacy plugin cleanup: cannot read bundles:", (error && error.message) || error);
    return result;
  }
  // 现役条目占用的 row id —— 旧包名与它们同名，必须排除（见 liveCatalogRowIds 的说明）。
  const liveRowIds = liveCatalogRowIds(dshHome);
  for (const legacy of LEGACY_PLUGIN_PKGS) {
    const wasInstalled = bundles.has(legacy.pkg);
    const staleRowIds = legacy.rowIds.filter((rowId) => !liveRowIds.has(rowId));
    // 禁用意图可能记在市场的 state.json（包名）或补丁层（row id）任一处。
    let wasDisabled = false;
    try {
      wasDisabled =
        readMarketDisabled(dshHome).has(legacy.pkg) ||
        staleRowIds.some((rowId) => readUserPatchState(dshHome).disables.has(rowId));
    } catch {
      /* 读不到就当没禁用 */
    }

    // 补丁层与市场状态即使包已不在 bundles 里也可能残留，因此独立清理。
    // 只清「不再属于现役条目」的行：现役插件的禁用行是用户的当前选择，不是遗留物。
    if (staleRowIds.length > 0) {
      try {
        // 经补丁层写入队列：启动维护是异步路径（await 之间会回到事件循环），与
        // 其它异步改动排队后才不会互相覆盖。
        const removedRows = await queuePatchMutation(userPatchPath(dshHome), () =>
          removePatchRows(dshHome, staleRowIds),
        );
        if (removedRows.length > 0) {
          result.removedRows.push(...removedRows);
          result.changed = true;
          log("legacy plugin: removed stale patch rows:", removedRows.join(", "));
        }
      } catch (error) {
        log("legacy plugin: patch-row cleanup failed:", legacy.pkg, (error && error.message) || error);
      }
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
    }

    // 2) **无论如何**都把登记摘干净（bundles + dependencies）—— 不只在 wasInstalled 时：
    //    旧包可能只剩 dependencies 里的声明（自愈剪掉了不可解析的 bundles 条目、依赖还在），
    //    留着它，下一次 `dsh plugin add` 会连带把旧包装回来，引擎的 reconcile 又会把它重新
    //    登记进 bundles，于是新旧两版同时加载（这正是本函数存在的理由）。
    //    只靠第 1 步是不够的：`dsh plugin remove` 在依赖已不在 package.json 时会报
    //    ERR_PNPM_CANNOT_REMOVE_MISSING_DEPS；而只摘 bundles 又会被引擎的 reconcile 依据
    //    残留依赖重新登记回来（实测就是这个原因导致改名后新旧两版同时加载、控件显示两遍）。
    //    这里以「实际摘掉了什么」为准，不信任何返回值。
    let removedNames = [];
    try {
      removedNames = pruneProfilePackages(dshHome, [legacy.pkg]);
    } catch (error) {
      log("legacy plugin: prune failed:", legacy.pkg, (error && error.message) || error);
    }
    if (removedNames.length > 0) {
      if (!result.pruned.includes(legacy.pkg)) result.pruned.push(legacy.pkg);
      result.changed = true;
      log(wasInstalled ? "legacy plugin removed (renamed):" : "legacy plugin registration pruned:", legacy.pkg);
    } else if (wasInstalled && isRegisteredInProfile(dshHome, legacy.pkg)) {
      log("legacy plugin could not be removed:", legacy.pkg);
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
  // 旧包的 staging 拷贝也要在这里清掉，而不是只等下一次 staging 顺带清（pruneStaleStagingDirs
  // 是 stageBundledPlugin 调的）。否则「替代条目早就装着、这次没有东西要 staging」的启动
  // 永远留着那份拷贝 —— 它正是让指向它的 `file:` 依赖保持可解析、进而让引擎把旧包重新登记回
  // bundles 的东西，本函数的注释里已经写过这个后果。清理完整不该依赖「后面恰好有人 staging」。
  if (stagingRoot !== null) {
    try {
      pruneStaleStagingDirs(stagingRoot);
    } catch (error) {
      log("legacy plugin: staging cleanup failed:", (error && error.message) || error);
    }
  }
  return result;
}

/** 原子写回 profile manifest（先写临时文件再 rename，中途崩溃不会留下残缺 JSON）。 */
function writeProfileManifest(dshHome, manifest) {
  const file = path.join(profileDir(dshHome), "package.json");
  // 唯一临时名：固定名会被同机另一个写者（另一个 GUI 实例、或 pnpm 正在写同一个文件）
  // 抢用，一方的 rename 可能发布另一方写了一半的字节（补丁层写入者为此也用了唯一名）。
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n");
    fs.renameSync(tmp, file);
  } catch (error) {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      /* 临时文件清理尽力而为 */
    }
    throw error;
  }
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
      // 写之前**重读**：这份 manifest 是在若干次 `await`（pnpm 自举、`dsh plugin install`）
      // 之前读的，而启动维护与「修复 / 重试」是两条独立的异步路径，各自都持有旧快照 ——
      // 直接写回会把对方刚写进去的 bundles/dependencies 覆盖掉（刚装/刚卸的插件被悄悄还原）。
      // 这里只把本次真正决定的东西（要摘掉的 bundles / 依赖）应用到**最新**的清单上。
      const fresh = readProfileManifest(dshHome);
      const target = fresh ?? manifest;
      if (fresh) {
        const currentBundles = Array.isArray(fresh.dsh?.profile?.bundles) ? fresh.dsh.profile.bundles : [];
        fresh.dsh = fresh.dsh ?? {};
        fresh.dsh.profile = fresh.dsh.profile ?? {};
        fresh.dsh.profile.bundles = currentBundles.filter((name) => !pruneList.includes(name));
      }
      writeProfileManifest(dshHome, target);
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
 * 其他：幂等（已装、来源正确且版本不落后时跳过）。内置插件随包代码更新、或安装来源
 * 不是随包那一份时会先 remove 再 add，让 profile 里的拷贝跟上随包发布的代码；内置
 * （localSource）插件从不直接指向 app.asar 内的源目录安装，先 staging 成真实目录
 * （子进程 pnpm 读不到 app.asar 内部）再装那份。
 * @param {object} o
 * @param {"sync"|"install"} [o.mode] 默认 "install"（只增不删）。
 * @param {string} [o.stagingRoot] 内置插件的 staging 根目录。默认取
 *   <pnpmInstallDir>/bundled-plugins；主进程应传入**稳定且无空格**的路径（见 main.js 的
 *   pluginBundledPluginsDir）——它会被原样写进 profile 的 dependencies。
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
  // 内置插件的 staging 根目录（必须**稳定**：pnpm 会把 `file:` spec 原样写进 profile
  // 的 dependencies，之后在那个 profile 里再跑 pnpm 仍要能解析到同一路径）。
  const bundledStagingRoot = stagingRoot ?? path.join(path.dirname(pnpmInstallDir), "bundled-plugins");
  // 内置条目的安装来源由应用自己管理。**先摘掉所有「即将安装、但来源不对」的登记，再
  // 统一安装**：残留的 `file:` 依赖会被 pnpm 在下一次安装里一起重新解析，那条路径一旦
  // 解析不了，就会让**别的**插件的安装一起失败——实测：修 A 时因为我们自己的 B 依赖
  // 指向一个失效的 `file:` 路径而报 ENOENT，于是 A 也装不上，只能等下一轮启动才补上。
  // 先清干净就没有这种交叉污染，一次启动全部修好。只动「已勾选」的条目：install 模式
  // 承诺不动用户没勾选的东西。
  const prunedSpecs = new Map();
  const foreignEntries = [];
  for (const entry of CATALOG) {
    if (!entry.localSource || !enabled.has(entry.id)) continue;
    if (!installedBundles(dshHome).includes(entry.pkg)) continue;
    if (isBundledStagedSpec(profileDependencySpec(dshHome, entry.pkg), entry, bundledStagingRoot)) continue;
    foreignEntries.push(entry);
  }
  if (foreignEntries.length > 0) {
    log("pruning built-in plugins installed from elsewhere:", foreignEntries.map((e) => e.pkg).join(", "));
    // 记下原 spec：万一随后装不上，还能把它装回去（见循环里的还原分支）。
    for (const entry of foreignEntries) prunedSpecs.set(entry.pkg, profileDependencySpec(dshHome, entry.pkg));
    // **staging 成功过才摘登记**。staging 只是复制文件——不跑 pnpm、不需要网络——所以它
    // 失败只可能是磁盘/权限问题，而这时唯一正确的做法是**什么都不动**：保留 profile 里
    // 原来那份（下面的循环再试一次 staging，同样会在动 profile 之前就抛错退出）。
    // 少了这一步，「先摘登记再装」在 staging 失败时会把已经装好的插件摘没。
    const stageable = [];
    for (const entry of foreignEntries) {
      try {
        await stageBundledPlugin(entry, { stagingRoot: bundledStagingRoot, log });
        stageable.push(entry);
      } catch (error) {
        log("cannot stage the bundled copy, leaving the existing install alone:", entry.pkg, (error && error.message) || error);
      }
    }
    if (stageable.length > 0) {
      // **先摘登记，再跑 pnpm**：摘登记是纯改文件，而只要 profile 里还留着任何一条解析
      // 不了的 `file:` 依赖，接下来每一次 pnpm 调用都会整体失败——连累的正是我们想修的那
      // 个插件。实测顺序颠倒时的后果：第一个插件的 `remove` 就 ENOENT，四个里只修好两个。
      pruneProfilePackages(dshHome, stageable.map((e) => e.pkg));
      result.changed = true;
    }
    // 这里**不再**跑 `dsh plugin remove`：登记已经摘掉，那一步只剩 ERR_PNPM_CANNOT_REMOVE_
    // MISSING_DEPS（没依赖可删），而 node_modules 里那份旧的会被随后按新 spec 的 `add`
    // 重新链接；装不上时还有下面的还原分支兜底。
  }
  const engineVersion = readEngineVersion(engineDir);
  for (const entry of CATALOG) {
    const name = entry.pkg;
    const registered = installedBundles(dshHome).includes(name);
    // 「登记在 bundles 里」不等于「装好了」：登记还在、node_modules 里的拷贝却被删掉时，
    // 把 has 当成 true 会让下面 `has && !wantsUpdate → continue` 直接跳过，installPlugin
    // 里那条「缺文件就重装」的保护**永远不可达** —— 设置页点多少次「修复 / 重试」都修不好
    // 这类条目，只能等启动期的 heal 兜。所以 has 还要求落地文件确实存在。
    const materialised = fs.existsSync(path.join(profileDir(dshHome), "node_modules", name, "package.json"));
    const has = registered && materialised;
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
      // 这里用 registered 而不是 has：登记还在、文件已丢的条目也应当被清掉。
      if (!registered) continue;
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

    // 已装且被勾选：判断要不要重装。
    //
    // 内置条目（带 localSource）的安装来源由应用自己管理——profile 里那条依赖必须是
    // **我们 staging 出来的那份**。指向别处（开发用的 checkout、旧版 staging、npm 或
    // git 安装）都说明当前装着的不是随包那一份，要换回来；否则应用就不再是自包含的：
    // 实测过后果——依赖指向某个 checkout，那个目录一没了应用就装不上插件。
    // 随包代码更新（bundled 版本更新）时同样重装；但绝不因为「已装版本更高」而降级。
    let wantsUpdate = false;
    if (has && entry.localSource) {
      const currentSpec = profileDependencySpec(dshHome, name);
      const sourceVersion = readPackageVersion(bundledSourceDir(entry));
      const installedVersion = installedBundleVersion(dshHome, name);
      const plan = planBundledPluginUpdate({
        sameSource: isBundledStagedSpec(currentSpec, entry, bundledStagingRoot),
        sourceVersion,
        installedVersion,
      });
      wantsUpdate = plan.wantsUpdate;
      if (plan.reason === "foreign-source") {
        log("plugin is installed from somewhere other than the bundled copy; reinstalling:", name, currentSpec);
      } else if (plan.reason === "bundled-newer") {
        log("bundled plugin is newer:", name, installedVersion, "->", sourceVersion);
      } else if (plan.reason === "keeping-newer") {
        log("keeping the newer installed plugin:", name, installedVersion, "(bundled " + sourceVersion + ")");
      }
    }
    if (has && !wantsUpdate) continue;
    // 预清理阶段摘掉的那些条目此时已不在 bundles 里（has === false），但它们原本装着
    // 一份（来源不对的）拷贝——装不回去时用它还原，别让插件凭空消失。
    const previousSpec = has ? profileDependencySpec(dshHome, name) : prunedSpecs.get(name) ?? null;
    try {
      // 先把要装的 spec 准备好再做 remove/add：内置插件先 staging 成真实目录（子进程
      // pnpm 读不到 app.asar 内部路径），staging 失败就抛——此时还没动现有安装。
      const spec = entry.localSource
        ? `file:${await stageBundledPlugin(entry, { stagingRoot: bundledStagingRoot, log })}`
        : registrySpec(entry);
      if (has) {
        // 必须**显式 remove**，不能指望 `add` 原地改写那条 spec。实测（引擎
        // 0.1.5-rc.2 / pnpm 12）：对一个已登记进 bundles 的包执行
        // `dsh plugin add <name>` 会 exit 0、pnpm 也确实跑了一遍，但打印的是
        // "Lockfile is up to date, resolution step is skipped"，package.json 里的
        // `file:` spec **原样保留**——包不会重解析，等于什么都没做。
        // 所以走与 LEGACY_PLUGIN_PKGS 完全相同的已验证路径：remove → prune → add。
        const rm = await removePlugin({ engineDir, dshHome, pnpmBinDir, pkg: name, nodeExec, log });
        if (!rm.ok) log("plugin removal did not succeed, pruning the registration:", name);
        // 只 remove 不够：残留的 dependencies 会被引擎的 reconcile 重新登记回
        // bundles（实测过），旧的那份于是照旧生效。
        try {
          pruneProfilePackages(dshHome, [name]);
        } catch (error) {
          log("plugin prune failed:", name, (error && error.message) || error);
        }
      }
      const res = await installPlugin({
        engineDir,
        dshHome,
        pnpmBinDir,
        pkg: spec,
        name,
        nodeExec,
        log,
      });
      if (res.ok) {
        result.installed.push(entry.id);
        result.changed = true;
      } else {
        // 重装失败时**把原来那份装回去**，绝不让插件凭空消失。实测过没有这一步的后果：
        // remove + prune 成功、add 失败，插件直接从 dsh.profile.bundles 里没了。
        result.errors.push(`${name}: ${res.output.slice(-200)}`);
        // 恢复前先校验 spec 形状：它来自 profile 的 dependencies，而那个文件可以被市场
        // 或引擎内的插件改写 —— 以 `-` 开头会被 pnpm 当成选项解析，带 `:` 前缀
        // （file:/git:/github:/https:）则是「去装一份来路不明的代码」。宁可报错。
        if (previousSpec && !isRestorableSpec(previousSpec, entry, bundledStagingRoot)) {
          log("not restoring an unrecognised dependency spec:", name, previousSpec);
        } else if (previousSpec) {
          try {
            const back = await installPlugin({
              engineDir,
              dshHome,
              pnpmBinDir,
              pkg: previousSpec,
              name,
              nodeExec,
              log,
            });
            log(
              back.ok
                ? "reinstall failed; restored the previous install:"
                : "reinstall failed AND the previous install could not be restored:",
              name,
            );
          } catch (error) {
            log("restoring the previous install failed:", name, (error && error.message) || error);
          }
        }
      }
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
 * 被拒绝的行（引擎行 / 别的插件也 insert 的行）记入 `refused`，绝不当作「已同步」；
 * 调用方与日志都能看见这次对账没写实。
 *
 * @returns {{healed:string[], refused:string[], changed:boolean}}
 */
function reconcilePluginEnabled({ dshHome, log = () => {} }) {
  const status = catalogStatus(dshHome);
  const patch = readUserPatchState(dshHome);
  const healed = [];
  const refused = [];
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
      // 拒绝（引擎行 / 别人的行 id / 写入失败）：照原样报出来，界面据此显示失败。
      refused.push(entry.id);
      log("cannot sync disabled state for:", entry.pkg, res.reason ?? "");
    }
  }
  return { healed, refused, changed: healed.length > 0 };
}

// 只导出**别的模块真的会用**的东西（main.js 的 IPC handler 与测试套件）。
// 这里曾经多导出 10 个只在文件内使用的内部函数（catalogByPkg / profileDir /
// profileDependencySpec / readEngineVersion / writeProfileManifest / marketStatePath /
// userPatchPath / readMarketDisabled / readUserPatchState / runDshPlugin）—— 它们不是死代码
// （内部都在用），但对外暴露会让「这个模块的公共面」看起来比实际大，也邀请调用方去依赖
// 内部实现。逐个 grep 确认没有任何外部引用后移除。
module.exports = {
  CATALOG,
  CATALOG_IDS,
  catalogEngineCompat,
  readProfilePnpmManager,
  ensurePnpm,
  engineBin,
  readProfileManifest,
  installedBundles,
  bundledSourceDir,
  planBundledPluginUpdate,
  bundledStagedSpec,
  isBundledStagedSpec,
  stageBundledPlugin,
  catalogStatus,
  pluginHasClientHalf,
  setPluginEnabled,
  reconcilePluginEnabled,
  removeLegacyPlugins,
  removePatchRows,
  LEGACY_PLUGIN_PKGS,
  packageRowIds,
  bundleResolveDir,
  pruneProfileBundles,
  pruneProfilePackages,
  isRegisteredInProfile,
  healProfileBundles,
  installPlugin,
  removePlugin,
  syncEnabledPlugins,
};
