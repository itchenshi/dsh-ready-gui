"use strict";

/**
 * 单元测试：src/plugin-manager.js 的启用/禁用机制（补丁层 + 市场 state.json）
 * 运行：node src/test/plugin-enable.test.cjs
 *
 * 为什么值得单独测：启用/禁用写的是 profile 的用户补丁层 cordis.patch.yml，
 * 而这份文件**写坏了 dsh 会直接拒绝启动该 profile**。市场 patch.js 里踩过的两个
 * 坑必须逐条复现：
 *   1. 模板自带空 `[]` 占位——直接往后追加会得到两个顶层元素（非法 YAML），
 *      所以第一条要先把 `[]` 注释掉再追加；
 *   2. 删掉最后一行会只剩纯注释文件——同样不是顶层数组，必须把 `[]` 还原。
 * 另外市场 state.json 的 disabled 列表用**包名**，补丁层用**row id**，两套命名
 * 都要写对，否则市场 UI 与引擎实际状态会分叉。
 */

const assert = require("assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const pm = require(path.join(__dirname, "..", "plugin-manager.js"));

let checks = 0;
let failures = 0;
/** Promises of async checks; awaited before the summary so a failure cannot hide. */
const asyncChecks = [];

/**
 * Register one check. Async checks MUST be awaited (a bare fn() would leave the
 * assertions inside an unhandled promise, so a broken expectation would still
 * print "ok"); synchronous throws are caught the same way so one failure does
 * not abort the rest of the file.
 */
function ok(name, fn) {
  const fail = (error) => {
    failures += 1;
    console.log("  FAIL - " + name + ": " + ((error && error.message) || error));
    process.exitCode = 1;
  };
  const pass = () => {
    checks += 1;
    console.log("  ok - " + name);
  };
  let result;
  try {
    result = fn();
  } catch (error) {
    fail(error);
    return;
  }
  if (result && typeof result.then === "function") {
    asyncChecks.push(result.then(pass, fail));
    return;
  }
  pass();
}

const TEMPLATE_PATCH = `# Your patch layer for this dsh profile
[]
`;

/**
 * 造一个最小 profile：package.json(bundles + 可选 dependencies) + 已装包 +
 * 市场 state.json + 补丁层。
 * `deps` 缺省为 null（不写 dependencies）；传对象即可模拟真实安装后的依赖声明。
 */
function makeProfile({ bundles = [], deps = null, pkgPatchYml = null, state = null, patch = TEMPLATE_PATCH } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-enable-test-"));
  const dshHome = path.join(root, "dsh-home");
  const profile = path.join(dshHome, "profiles", "web");
  fs.mkdirSync(profile, { recursive: true });
  const manifest = { name: "dsh-profile-web", private: true, dsh: { profile: { bundles } } };
  if (deps !== null) manifest.dependencies = deps;
  fs.writeFileSync(path.join(profile, "package.json"), JSON.stringify(manifest, null, 2));
  if (patch !== null) fs.writeFileSync(path.join(profile, "cordis.patch.yml"), patch);
  if (state !== null) {
    fs.mkdirSync(path.join(profile, ".dsh-market"), { recursive: true });
    fs.writeFileSync(path.join(profile, ".dsh-market", "state.json"), JSON.stringify(state));
  }
  // 已装包（带声明的 dsh.bundle.patch 与约定的 cordis.patch.yml）
  for (const name of bundles) {
    if (name.startsWith("@deepseek-ai/")) continue; // 基础层不是本地包
    const dir = path.join(profile, "node_modules", name);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version: "1.0.0" }));
    if (pkgPatchYml) fs.writeFileSync(path.join(dir, "cordis.patch.yml"), pkgPatchYml);
  }
  return { root, dshHome, profile };
}

const USAGE_PATCH = `- insert:
    - id: model-usage
      name: dsh-model-surplus
      config:
        enabled: true
`;

console.log("plugin-enable:");

ok("packageRowIds 从包的 cordis.patch.yml 取 insert 行 id", () => {
  const { root, dshHome, profile } = makeProfile({
    bundles: ["dsh-model-surplus"],
    pkgPatchYml: USAGE_PATCH,
  });
  try {
    const ids = pm.packageRowIds(dshHome, "dsh-model-surplus");
    assert.deepStrictEqual(ids, ["model-usage"]);
    // 补丁层为空 → 状态是启用
    const st = pm.catalogStatus(dshHome)["dsh-model-surplus"];
    assert.strictEqual(st.installed, true);
    assert.strictEqual(st.enabled, true);
    assert.strictEqual(st.disabledBy, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

ok("禁用：写补丁层 `- id: X` + disabled: true（并把模板 [] 注释掉）", () => {
  const { root, dshHome, profile } = makeProfile({
    bundles: ["dsh-model-surplus"],
    pkgPatchYml: USAGE_PATCH,
    state: { disabled: [], groups: {}, region: "china" },
  });
  try {
    const res = pm.setPluginEnabled({
      dshHome,
      pkg: "dsh-model-surplus",
      rowIds: ["model-usage"],
      enabled: false,
    });
    assert.strictEqual(res.ok, true);
    const text = fs.readFileSync(path.join(profile, "cordis.patch.yml"), "utf8");
    assert.match(text, /^- id: model-usage\n {2}disabled: true\n/m);
    // 模板的 [] 必须被注释掉，否则文件会有两个顶层元素
    assert.match(text, /^# \[\]$/m);
    assert.doesNotMatch(text, /^\[\]$/m);
    // 状态变成禁用，且来源是补丁层
    const st = pm.catalogStatus(dshHome)["dsh-model-surplus"];
    assert.strictEqual(st.enabled, false);
    assert.strictEqual(st.patchDisabled, true);
    // 市场 state.json 同步记下包名
    const state = JSON.parse(fs.readFileSync(path.join(profile, ".dsh-market", "state.json"), "utf8"));
    assert.deepStrictEqual(state.disabled, ["dsh-model-surplus"]);
    assert.strictEqual(state.region, "china", "写入时应保留 state.json 的其余键");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

ok("禁用幂等：重复禁用不重复追加行", () => {
  const { root, dshHome, profile } = makeProfile({
    bundles: ["dsh-model-surplus"],
    pkgPatchYml: USAGE_PATCH,
    state: { disabled: [] },
  });
  try {
    const rowIds = ["model-usage"];
    pm.setPluginEnabled({ dshHome, pkg: "dsh-model-surplus", rowIds, enabled: false });
    const first = fs.readFileSync(path.join(profile, "cordis.patch.yml"), "utf8");
    pm.setPluginEnabled({ dshHome, pkg: "dsh-model-surplus", rowIds, enabled: false });
    const second = fs.readFileSync(path.join(profile, "cordis.patch.yml"), "utf8");
    assert.strictEqual(second, first);
    assert.strictEqual((second.match(/- id: model-usage/g) || []).length, 1);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

ok("启用：删掉禁用行，并把 [] 占位还原（否则 profile 无法启动）", () => {
  const { root, dshHome, profile } = makeProfile({
    bundles: ["dsh-model-surplus"],
    pkgPatchYml: USAGE_PATCH,
    state: { disabled: [] },
  });
  try {
    const rowIds = ["model-usage"];
    pm.setPluginEnabled({ dshHome, pkg: "dsh-model-surplus", rowIds, enabled: false });
    pm.setPluginEnabled({ dshHome, pkg: "dsh-model-surplus", rowIds, enabled: true });
    const text = fs.readFileSync(path.join(profile, "cordis.patch.yml"), "utf8");
    // 关键：不能剩一个纯注释文件，必须还原顶层 []
    assert.doesNotMatch(text, /- id: model-usage/);
    assert.match(text, /^\[\]$/m);
    const st = pm.catalogStatus(dshHome)["dsh-model-surplus"];
    assert.strictEqual(st.enabled, true);
    assert.strictEqual(st.disabledBy, null);
    const state = JSON.parse(fs.readFileSync(path.join(profile, ".dsh-market", "state.json"), "utf8"));
    assert.deepStrictEqual(state.disabled, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

ok("市场上禁用（state.json 有、补丁层没有）→ 状态为禁用且来源是 market", () => {
  const { root, dshHome } = makeProfile({
    bundles: ["dsh-model-surplus"],
    pkgPatchYml: USAGE_PATCH,
    state: { disabled: ["dsh-model-surplus"], groups: {} },
  });
  try {
    const st = pm.catalogStatus(dshHome)["dsh-model-surplus"];
    assert.strictEqual(st.enabled, false, "市场禁用了就必须显示为禁用");
    assert.strictEqual(st.marketDisabled, true);
    assert.strictEqual(st.patchDisabled, false, "补丁层还没落下 → 引擎其实仍会加载它（漂移）");
    assert.strictEqual(st.disabledBy, "market");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

ok("reconcilePluginEnabled 把「市场禁用但补丁层没写」补实", () => {
  const { root, dshHome, profile } = makeProfile({
    bundles: ["dsh-model-surplus"],
    pkgPatchYml: USAGE_PATCH,
    state: { disabled: ["dsh-model-surplus"] },
  });
  try {
    const res = pm.reconcilePluginEnabled({ dshHome });
    assert.deepStrictEqual(res.healed, ["dsh-model-surplus"]);
    assert.strictEqual(res.changed, true);
    const text = fs.readFileSync(path.join(profile, "cordis.patch.yml"), "utf8");
    assert.match(text, /^- id: model-usage\n {2}disabled: true\n/m);
    const st = pm.catalogStatus(dshHome)["dsh-model-surplus"];
    assert.strictEqual(st.patchDisabled, true, "对账后补丁层也禁用了 → 真正不加载");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

ok("对账尊重补丁层的 disabled: false（显式要它开着时不覆盖）", () => {
  const { root, dshHome } = makeProfile({
    bundles: ["dsh-model-surplus"],
    pkgPatchYml: USAGE_PATCH,
    state: { disabled: ["dsh-model-surplus"] },
    patch: `- id: model-usage\n  disabled: false\n`,
  });
  try {
    const res = pm.reconcilePluginEnabled({ dshHome });
    assert.deepStrictEqual(res.healed, [], "补丁层显式 false = 用户要它开着，state.json 才是过时的一方");
    assert.strictEqual(res.changed, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

ok("补丁层坏成顶层流式结构时拒绝写入（绝不把 YAML 弄得更坏）", () => {
  const { root, dshHome, profile } = makeProfile({
    bundles: ["dsh-model-surplus"],
    pkgPatchYml: USAGE_PATCH,
    state: { disabled: [] },
    patch: "[1, 2]\n",
  });
  try {
    const before = fs.readFileSync(path.join(profile, "cordis.patch.yml"), "utf8");
    const res = pm.setPluginEnabled({
      dshHome,
      pkg: "dsh-model-surplus",
      rowIds: ["model-usage"],
      enabled: false,
    });
    assert.strictEqual(res.patchOk, false, "应当拒绝写入");
    assert.strictEqual(fs.readFileSync(path.join(profile, "cordis.patch.yml"), "utf8"), before, "文件必须原样不动");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

ok("未安装的插件不会因为市场 state.json 而报成已装", () => {
  const { root, dshHome } = makeProfile({
    bundles: [],
    state: { disabled: ["dsh-model-surplus"] },
  });
  try {
    const st = pm.catalogStatus(dshHome)["dsh-model-surplus"];
    assert.strictEqual(st.installed, false);
    assert.strictEqual(st.bundle, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

ok("补丁层带 UTF-8 BOM 时仍能写入禁用行（真实 profile 就是这种）", () => {
  // Windows 上的 profile 模板 cordis.patch.yml 带 BOM（EF BB BF），而 Node 的
  // readFileSync('utf8') 不会剥掉它：带 BOM 时第一行是 `\uFEFF# 注释`，注释正则
  // 匹配不到，`[]` 占位既认不出来、又被最后一行判成流式结构 → 市场直接拒绝写入。
  // 这正是「市场 state.json 记了 disabled、补丁层却始终是空的」的根因。
  const { root, dshHome, profile } = makeProfile({
    bundles: ["dsh-model-surplus"],
    pkgPatchYml: USAGE_PATCH,
    state: { disabled: [] },
    patch: "\uFEFF" + TEMPLATE_PATCH,
  });
  try {
    const patchFile = path.join(profile, "cordis.patch.yml");
    assert.strictEqual(fs.readFileSync(patchFile)[0], 0xef, "前置条件：文件确实带 BOM");
    const res = pm.setPluginEnabled({
      dshHome,
      pkg: "dsh-model-surplus",
      rowIds: ["model-usage"],
      enabled: false,
    });
    assert.strictEqual(res.patchOk, true, "带 BOM 也必须能写进去");
    const text = fs.readFileSync(patchFile, "utf8");
    assert.match(text, /^- id: model-usage\n {2}disabled: true\n/m);
    // 写回时不带 BOM：顺带把文件修好，市场的开关之后也能正常写
    assert.strictEqual(fs.readFileSync(patchFile)[0] === 0xef, false, "写回不应再带 BOM");
    const st = pm.catalogStatus(dshHome)["dsh-model-surplus"];
    assert.strictEqual(st.patchDisabled, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// --- 旧插件迁移（目录条目改名后的一次性清理）------------------------------
//
// 目录条目改名时，profile 里会留着旧包名的 bundle 登记与补丁行。启动维护只按当前
// CATALOG 对账、看不见旧包名，于是新旧两版会同时被引擎加载（两个页内控件、路由
// 冲突）——比没装上更糟。下面覆盖：摘登记、清补丁行、清市场禁用列表、以及把
// 「原来装着/被禁用」的意图搬到替代条目上。

ok("LEGACY_PLUGIN_PKGS 指向当前 CATALOG 里真实存在的替代条目", () => {
  assert.ok(pm.LEGACY_PLUGIN_PKGS.length > 0, "应当至少有一条历史改名记录");
  for (const legacy of pm.LEGACY_PLUGIN_PKGS) {
    assert.ok(typeof legacy.pkg === "string" && legacy.pkg !== "", "旧包名必填");
    assert.ok(Array.isArray(legacy.rowIds), "rowIds 必须是数组");
    // 替代条目必须真的在目录里，否则迁移会把功能搬到不存在的 id 上。
    if (legacy.replacedBy) {
      const entry = pm.CATALOG.find((c) => c.id === legacy.replacedBy);
      assert.ok(entry, `replacedBy ${legacy.replacedBy} 不在 CATALOG 里`);
      assert.strictEqual(entry.pkg, legacy.replacedBy, "本次改名 id 与 pkg 同名");
    }
  }
});

ok("removePatchRows 删掉指定行并还原 [] 占位", () => {
  const { root, dshHome, profile } = makeProfile({ bundles: [], state: null });
  try {
    const patchFile = path.join(profile, "cordis.patch.yml");
    fs.writeFileSync(patchFile, "- id: model-usage\n  disabled: true\n- id: other\n  disabled: true\n");
    const removed = pm.removePatchRows(dshHome, ["model-usage"]);
    assert.deepStrictEqual(removed, ["model-usage"]);
    const text = fs.readFileSync(patchFile, "utf8");
    assert.doesNotMatch(text, /model-usage/);
    assert.match(text, /^- id: other\n {2}disabled: true$/m, "其它行必须原样保留");
    // 删空了要还原顶层 []（纯注释/空文件会被 dsh 拒绝启动）。
    const root2 = pm.removePatchRows(dshHome, ["other"]);
    assert.deepStrictEqual(root2, ["other"]);
    assert.match(fs.readFileSync(patchFile, "utf8"), /^\[\]$/m);
    // 不存在的行不报错也不改文件。
    assert.deepStrictEqual(pm.removePatchRows(dshHome, ["nope"]), []);
    assert.deepStrictEqual(pm.removePatchRows(dshHome, []), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

ok("旧插件未安装时只清残留（补丁行 + 市场禁用列表），并报告替代条目", async () => {
  const legacyPkg = pm.LEGACY_PLUGIN_PKGS[0].pkg;
  const legacyRow = pm.LEGACY_PLUGIN_PKGS[0].rowIds[0];
  const { root, dshHome, profile } = makeProfile({
    bundles: [],
    state: { disabled: [legacyPkg], groups: { g: ["x"] }, region: "china" },
    patch: `- id: ${legacyRow}\n  disabled: true\n`,
  });
  try {
    const res = await pm.removeLegacyPlugins({ dshHome, engineDir: root, nodeExec: "node", pnpmInstallDir: root });
    assert.deepStrictEqual(res.pruned, [], "未安装就没什么可摘");
    assert.deepStrictEqual(res.replaced, [], "未安装 → 不该顺带装替代条目");
    assert.deepStrictEqual(res.removedRows, [legacyRow]);
    assert.strictEqual(res.changed, true);
    // 市场的禁用列表里旧包名被清掉，其余键保留。
    const state = JSON.parse(fs.readFileSync(path.join(profile, ".dsh-market", "state.json"), "utf8"));
    assert.deepStrictEqual(state.disabled, []);
    assert.deepStrictEqual(state.groups, { g: ["x"] });
    assert.strictEqual(state.region, "china");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

ok("旧插件装着时报告替代条目，并把「已禁用」意图搬过去", async () => {
  const legacyPkg = pm.LEGACY_PLUGIN_PKGS[0].pkg;
  const replacement = pm.LEGACY_PLUGIN_PKGS[0].replacedBy;
  const { root, dshHome, profile } = makeProfile({
    bundles: [legacyPkg],
    state: { disabled: [legacyPkg], groups: {} },
  });
  try {
    // engineDir 指向不存在的目录 → `dsh plugin remove` 必然失败，走 prune 兜底。
    const res = await pm.removeLegacyPlugins({
      dshHome,
      engineDir: path.join(root, "no-engine"),
      nodeExec: "node",
      pnpmInstallDir: path.join(root, "pnpm"),
    });
    assert.deepStrictEqual(res.pruned, [legacyPkg], "prune 兜底必须摘掉旧登记");
    assert.deepStrictEqual(res.replaced, [replacement], "原来装着 → 交给调用方装替代条目");
    // 旧包名从 bundles 里消失。
    const manifest = JSON.parse(fs.readFileSync(path.join(profile, "package.json"), "utf8"));
    assert.ok(!manifest.dsh.profile.bundles.includes(legacyPkg));
    // 禁用意图搬到替代包名上，改名不改变用户的选择。
    const state = JSON.parse(fs.readFileSync(path.join(profile, ".dsh-market", "state.json"), "utf8"));
    assert.deepStrictEqual(state.disabled, [replacement]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

ok("迁移必须同时摘掉 dependencies，否则引擎会把旧插件重新登记回来", async () => {
  // 这是实测踩中的回归：只摘 bundles 而留着 `file:` 依赖声明，引擎自己的
  // reconcile 会把「依赖里能解析、且声明了 dsh.bundle」的包重新登记回 bundles，
  // 于是改名后新旧两版同时加载 —— 页面上同一个用量控件显示了两遍。
  const legacyPkg = pm.LEGACY_PLUGIN_PKGS[0].pkg;
  const { root, dshHome, profile } = makeProfile({
    bundles: [legacyPkg],
    // A `file:` spec like the one a bundled install writes — resolvable, so the
    // engine's reconcile would adopt it again if the entry survived.
    deps: { [legacyPkg]: "file:/staged/bundled-plugins/" + legacyPkg, "dsh-market": "^1.45.1" },
    state: { disabled: [] },
  });
  try {
    const manifestPath = path.join(profile, "package.json");
    assert.ok(
      JSON.parse(fs.readFileSync(manifestPath, "utf8")).dependencies[legacyPkg],
      "前置条件：依赖里确实有旧包",
    );
    await pm.removeLegacyPlugins({
      dshHome,
      engineDir: path.join(root, "no-engine"),
      nodeExec: "node",
      pnpmInstallDir: path.join(root, "pnpm"),
    });
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.ok(!manifest.dsh.profile.bundles.includes(legacyPkg), "bundles 里必须没有旧包");
    assert.ok(
      !Object.prototype.hasOwnProperty.call(manifest.dependencies, legacyPkg),
      "dependencies 里也必须没有旧包，否则引擎 reconcile 会把它装回来",
    );
    assert.strictEqual(manifest.dependencies["dsh-market"], "^1.45.1", "其它依赖不能被动到");
    assert.strictEqual(pm.isRegisteredInProfile(dshHome, legacyPkg), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

ok("pruneProfilePackages 是幂等的，且不动无关包", () => {
  const { root, dshHome } = makeProfile({
    bundles: ["gone", "kept"],
    deps: { gone: "file:/tmp/gone", kept: "^1.0.0" },
  });
  try {
    assert.deepStrictEqual(pm.pruneProfilePackages(dshHome, ["gone"]).sort(), ["gone"]);
    assert.strictEqual(pm.isRegisteredInProfile(dshHome, "gone"), false);
    assert.strictEqual(pm.isRegisteredInProfile(dshHome, "kept"), true);
    // 再摘一次什么都不变（幂等），也不会把 kept 弄丢。
    assert.deepStrictEqual(pm.pruneProfilePackages(dshHome, ["gone"]), []);
    assert.strictEqual(pm.isRegisteredInProfile(dshHome, "kept"), true);
    // 只摘依赖、bundles 里本来就没有的包同样算数。
    assert.deepStrictEqual(pm.pruneProfilePackages(dshHome, ["kept"]).sort(), ["kept"]);
    assert.strictEqual(pm.isRegisteredInProfile(dshHome, "kept"), false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

ok("旧包清理不碰现役插件的补丁行（旧包名与现役 row id 同名）", async () => {
  // 改名时刻意保留了补丁层行 id，于是 `model-usage` / `composer-keys` / `opencode-go`
  // 三个旧包名的 rowIds 与**现役**插件完全同名。旧包清理若照着旧包名的 rowIds 直接删，
  // 就等于每次启动都把用户对现役插件的禁用行抹掉 —— 界面上「已禁用」的插件下次启动
  // 静默恢复加载（reconcilePluginEnabled 只在市场 state.json 记着禁用时才补行）。
  // 只有真正只属于旧包的行（如 opencode-go-usage）才该被清掉。
  //
  // `opencode-go` 尤其要紧：它现在是 dsh-gateway-models（由 dsh-opencode-go-path 改名）
  // 占用的行 id，而 dsh-opencode-go-path 自己的 LEGACY 条目也写着 rowIds: ["opencode-go"]。
  // 一旦 liveCatalogRowIds() 漏掉它，改名这件事本身就会按启动次数反复清掉用户的选择。
  const { root, dshHome, profile } = makeProfile({
    bundles: [],
    patch:
      "- id: opencode-go\n  disabled: true\n- id: model-usage\n  disabled: true\n- id: composer-keys\n  disabled: true\n- id: opencode-go-usage\n  disabled: true\n",
  });
  try {
    const res = await pm.removeLegacyPlugins({
      dshHome,
      engineDir: path.join(root, "no-engine"),
      nodeExec: "node",
      pnpmInstallDir: path.join(root, "pnpm"),
    });
    const text = fs.readFileSync(path.join(profile, "cordis.patch.yml"), "utf8");
    assert.match(text, /^- id: opencode-go\n {2}disabled: true$/m, "现役插件的禁用行必须保留");
    assert.match(text, /^- id: model-usage\n {2}disabled: true$/m, "现役插件的禁用行必须保留");
    assert.match(text, /^- id: composer-keys\n {2}disabled: true$/m, "现役插件的禁用行必须保留");
    assert.doesNotMatch(text, /opencode-go-usage/, "只属于旧包的行必须清掉");
    assert.deepStrictEqual(res.removedRows, ["opencode-go-usage"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

ok("改名记录覆盖 dsh-opencode-go-path → dsh-gateway-models，且沿用同一行 id", () => {
  const renamed = pm.LEGACY_PLUGIN_PKGS.find((l) => l.pkg === "dsh-opencode-go-path");
  assert.ok(renamed, "改名后必须留下一条旧包名的迁移记录，否则老用户的新旧两版会同时加载");
  assert.strictEqual(renamed.replacedBy, "dsh-gateway-models");
  // 与现役插件共用行 id 是**有意**的：用户保存的启用/禁用选择正好跟着新包走。
  assert.deepStrictEqual(renamed.rowIds, ["opencode-go"]);
  const entry = pm.CATALOG.find((c) => c.id === "dsh-gateway-models");
  assert.ok(entry, "替代条目必须在目录里");
  assert.strictEqual(entry.pkg, "dsh-gateway-models");
});

// Await the async checks before reporting, so their failures are counted.
Promise.all(asyncChecks).then(() => {
  if (failures > 0) {
    console.log("\nplugin-enable: " + failures + " check(s) FAILED");
    process.exit(1);
  }
  console.log("\nplugin-enable: " + checks + " checks passed");
});
