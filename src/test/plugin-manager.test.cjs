// Unit tests for profile-bundle self-heal (plugin-manager.js).
// Node + repo node_modules only; no Electron required.
"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const pm = require("../plugin-manager.js");

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
}

function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-heal-"));
  const engineDir = path.join(root, "engine");
  const dshHome = path.join(root, "home");
  const profile = path.join(dshHome, "profiles", "web");

  // install anchor: dsh package at engine root + hoisted in-box bundle.
  writeJson(path.join(engineDir, "node_modules", "@deepseek-ai", "dsh", "package.json"), { name: "@deepseek-ai/dsh", version: "0.1.5-rc.1" });
  writeJson(path.join(engineDir, "node_modules", "@deepseek-ai", "dsh-base", "package.json"), {
    name: "@deepseek-ai/dsh-base",
    version: "0.1.5-rc.1",
    dsh: { bundle: { patch: "./cordis.patch.yml" } },
  });
  // profile project: one in-box bundle, one declared dep, and one stale
  // registration that is neither resolvable nor declared.
  writeJson(path.join(profile, "node_modules", "dsh-opencode-go", "package.json"), {
    name: "dsh-opencode-go",
    version: "0.1.0",
    dsh: { bundle: { patch: "./cordis.patch.yml" } },
  });
  writeJson(path.join(profile, "package.json"), {
    name: "web",
    version: "1.0.0",
    dependencies: { "dsh-opencode-go": "file:./node_modules/dsh-opencode-go" },
    dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "dsh-opencode-go", "dshmarket-stale"], patchReload: "live" } },
  });
  return { root, engineDir, dshHome, profile };
}

function run() {
  const t = makeTree();
  // NOTE: cleanup must ride the promise chain (.finally), NOT a try/finally around
  // the returned promise — a try/finally would run synchronously at the return
  // statement, deleting the tree before the .then callbacks execute.
  const chain = Promise.resolve();

  const checkResolve = chain.then(() => {
    // bundleResolveDir mirrors the engine: install anchor first, then profile.
    assert.strictEqual(
      pm.bundleResolveDir(t.engineDir, t.dshHome, "@deepseek-ai/dsh-base"),
      path.join(t.engineDir, "node_modules", "@deepseek-ai", "dsh-base"),
    );
    assert.strictEqual(
      pm.bundleResolveDir(t.engineDir, t.dshHome, "dsh-opencode-go"),
      path.join(t.profile, "node_modules", "dsh-opencode-go"),
    );
    assert.strictEqual(pm.bundleResolveDir(t.engineDir, t.dshHome, "dshmarket-stale"), null);
    console.log("ok - bundleResolveDir mirrors engine resolution (install anchor -> profile)");
  });

  // heal: stale (not declared, unresolvable) gets pruned; healthy bundles stay.
  const checkHeal = checkResolve
    .then(() => pm.healProfileBundles({ engineDir: t.engineDir, dshHome: t.dshHome, nodeExec: process.execPath, log: () => {} }))
    .then((r) => {
      assert.deepStrictEqual(r.pruned, ["dshmarket-stale"]);
      assert.deepStrictEqual(r.repaired, []);
      assert.deepStrictEqual(r.errors, []);
      assert.strictEqual(r.changed, true);
      const manifest = pm.readProfileManifest(t.dshHome);
      assert.ok(manifest, "manifest should parse after heal");
      assert.deepStrictEqual(manifest.dsh.profile.bundles, ["@deepseek-ai/dsh-base", "dsh-opencode-go"]);
      console.log("ok - heal prunes stale unresolvable bundle, keeps healthy ones");

      // idempotent: second run is a no-op.
      return pm.healProfileBundles({ engineDir: t.engineDir, dshHome: t.dshHome, nodeExec: process.execPath }).then((r2) => {
        assert.deepStrictEqual(r2.pruned, []);
        assert.strictEqual(r2.changed, false);
        console.log("ok - heal is idempotent");

        // pruneProfileBundles is a direct remove that returns what it pruned.
        const pruned = pm.pruneProfileBundles(t.dshHome, ["dsh-opencode-go"]);
        assert.deepStrictEqual(pruned, ["dsh-opencode-go"]);
        assert.strictEqual(pm.pruneProfileBundles(t.dshHome, ["dsh-opencode-go"]).length, 0);
        console.log("ok - pruneProfileBundles removes and is idempotent");

        // atomic write leaves a parseable manifest, no temp residue.
        assert.ok(!fs.existsSync(path.join(t.profile, "package.json.dsh-ready-gui-heal.tmp")));
        console.log("ok - atomic manifest write leaves no temp residue");
      });
    });

  return checkHeal.finally(() => {
    try {
      fs.rmSync(t.root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });
}

/** pluginHasClientHalf drives the per-row "does enabling need a page reload?" line. */
function checkClientHalf() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-client-"));
  const dshHome = path.join(root, "home");
  const modules = path.join(dshHome, "profiles", "web", "node_modules");
  const writePkg = (name, manifest) => {
    fs.mkdirSync(path.join(modules, name), { recursive: true });
    fs.writeFileSync(path.join(modules, name, "package.json"), JSON.stringify(manifest));
  };
  try {
    // installed copy WITH a page half
    writePkg("with-client", { name: "with-client", version: "1.0.0", dsh: { client: { platform: "web" } } });
    assert.strictEqual(pm.pluginHasClientHalf(dshHome, { pkg: "with-client" }), true, "dsh.client -> true");
    // installed copy WITHOUT one (host-only plugin)
    writePkg("host-only", { name: "host-only", version: "1.0.0", dsh: { bundle: { patch: "./cordis.patch.yml" } } });
    assert.strictEqual(pm.pluginHasClientHalf(dshHome, { pkg: "host-only" }), false, "no dsh.client -> false");
    // not installed: the entry's verified `client` declaration answers instead.
    // (Plugins are installed from npm since v0.5.0, so there is no local source
    // to read before install — the flag keeps the settings row's
    // "needs a page reload" hint working for uninstalled entries.)
    assert.strictEqual(
      pm.pluginHasClientHalf(dshHome, { pkg: "dsh-keys-setting", client: true }),
      true,
      "declared page half -> true",
    );
    // ...and a declared HOST-ONLY plugin is false, not unknown: this is exactly the
    // per-plugin difference the settings row reports (no page reload needed).
    assert.strictEqual(
      pm.pluginHasClientHalf(dshHome, { pkg: "dsh-gateway-models", client: false }),
      false,
      "declared host-only -> false",
    );
    // the installed copy stays authoritative once it is on disk
    writePkg("dsh-gateway-models", { name: "dsh-gateway-models", version: "1.0.0", dsh: { client: { platform: "web" } } });
    assert.strictEqual(
      pm.pluginHasClientHalf(dshHome, { pkg: "dsh-gateway-models", client: false }),
      true,
      "installed manifest wins over the declaration",
    );
    // unknown: nothing installed and no declaration (e.g. dsh-market)
    assert.strictEqual(pm.pluginHasClientHalf(dshHome, { pkg: "not-installed-yet" }), null, "unknown -> null");
    console.log("ok - pluginHasClientHalf detects the page half (installed copy first, catalog flag second)");
  } finally {
    try {
      fs.rmSync(root, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  }
}

/**
 * A minimal profile for the patch-layer checks: installed packages (each with an
 * optional cordis.patch.yml of its own) + the user patch layer the GUI writes.
 * `packages[name].declaresPatch` mirrors a real bundle manifest's
 * `dsh.bundle.patch`; without it the package is only found by the CATALOG scan.
 */
function makePatchTree({ packages = {}, patch = "# patch layer\n[]\n", state = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pm-patch-"));
  const dshHome = path.join(root, "home");
  const profile = path.join(dshHome, "profiles", "web");
  const modules = path.join(profile, "node_modules");
  fs.mkdirSync(profile, { recursive: true });
  writeJson(path.join(profile, "package.json"), {
    name: "dsh-profile-web",
    dsh: { profile: { bundles: Object.keys(packages) } },
  });
  fs.writeFileSync(path.join(profile, "cordis.patch.yml"), patch);
  if (state !== null) writeJson(path.join(profile, ".dsh-market", "state.json"), state);
  for (const [name, opts] of Object.entries(packages)) {
    const dir = path.join(modules, name);
    fs.mkdirSync(dir, { recursive: true });
    writeJson(path.join(dir, "package.json"), {
      name,
      version: "1.0.0",
      ...(opts.declaresPatch ? { dsh: { bundle: { patch: "./cordis.patch.yml" } } } : {}),
    });
    if (opts.patchYml) fs.writeFileSync(path.join(dir, "cordis.patch.yml"), opts.patchYml);
  }
  return { root, dshHome, profile };
}

function cleanup(root) {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
}

/**
 * packageRowIds must be indentation-agnostic: the engine parses the patch as YAML,
 * so 2-space / 6-space / quoted / commented insert rows are all real rows. The old
 * 4-space-only scan returned none of them, which made the settings window write
 * "disabled" into the market state.json, report success, and leave the engine
 * loading the plugin anyway.
 */
function checkRowIdScan() {
  const t = makePatchTree({
    packages: {
      "pkg-two": { patchYml: "- insert:\n  - id: row-two-space\n    name: pkg-two\n" },
      "pkg-six": { patchYml: "- insert:\n      - id: row-six-space\n" },
      "pkg-quoted": {
        // A top-level `- id:` row is NOT this package's row (cordis merges by row
        // id, so treating it as ours would disable a neighbour's row).
        patchYml:
          "- id: engine-neighbour\n  config:\n    keep: true\n- insert:\n    - id: 'row-single'\n    - id: \"row-double\"\n    - id: row-plain # trailing comment\n",
      },
      "pkg-gaps": {
        // Blank lines and comments inside the insert block do not end it.
        patchYml: "- insert:\n    - id: row-after-blank\n\n    # comment\n    - id: row-last\n",
      },
    },
  });
  try {
    assert.deepStrictEqual(pm.packageRowIds(t.dshHome, "pkg-two"), ["row-two-space"]);
    assert.deepStrictEqual(pm.packageRowIds(t.dshHome, "pkg-six"), ["row-six-space"]);
    assert.deepStrictEqual(
      pm.packageRowIds(t.dshHome, "pkg-quoted").sort(),
      ["row-double", "row-plain", "row-single"],
      "quoted ids and non-insert rows",
    );
    assert.deepStrictEqual(pm.packageRowIds(t.dshHome, "pkg-gaps").sort(), ["row-after-blank", "row-last"]);
    console.log("ok - packageRowIds is indentation-agnostic, reads quoted ids, ignores non-insert rows");
  } finally {
    cleanup(t.root);
  }
}

/**
 * Disabling must refuse to write a row id that is not really this package's own:
 * protected engine rows (llm-pi-ai / session-persistence-jsonl) and rows another
 * installed bundle inserts. A refusal writes nothing at all — not even the market
 * state.json, which would otherwise claim "disabled" while the engine keeps loading.
 */
/*
 * The one switch behind "the GUI updated, so its bundled plugins update too".
 * It had no coverage at all, and both failure directions are bad: a missed update
 * means users never receive the shipped plugin, while an over-eager one means every
 * launch silently DOWNGRADES a plugin the user (or the marketplace) had made newer.
 */
function checkBundledPluginUpdateDecision() {
  const decide = pm.planBundledPluginUpdate;

  // Shipped copy is newer -> reinstall.
  assert.deepStrictEqual(decide({ sameSource: true, sourceVersion: "0.4.0", installedVersion: "0.3.2" }), {
    wantsUpdate: true,
    reason: "bundled-newer",
  });
  // Same version -> leave it alone (this is what makes a second launch a no-op).
  assert.deepStrictEqual(decide({ sameSource: true, sourceVersion: "0.4.0", installedVersion: "0.4.0" }), {
    wantsUpdate: false,
    reason: "same-version",
  });
  // Installed is NEWER -> never downgrade unattended.
  const kept = decide({ sameSource: true, sourceVersion: "0.4.0", installedVersion: "0.5.0" });
  assert.strictEqual(kept.wantsUpdate, false, "a newer installed plugin must not be downgraded");
  assert.strictEqual(kept.reason, "keeping-newer");
  // Prerelease ordering goes through semver, not string comparison.
  assert.strictEqual(
    decide({ sameSource: true, sourceVersion: "0.4.0", installedVersion: "0.4.0-rc.1" }).wantsUpdate,
    true,
    "0.4.0 is newer than 0.4.0-rc.1",
  );
  // Unparseable versions fall back to inequality instead of guessing with semver.
  assert.strictEqual(decide({ sameSource: true, sourceVersion: "not-a-version", installedVersion: "0.4.0" }).wantsUpdate, true);
  assert.strictEqual(
    decide({ sameSource: true, sourceVersion: "not-a-version", installedVersion: "not-a-version" }).wantsUpdate,
    false,
  );
  // A missing version on either side -> touch nothing.
  assert.strictEqual(decide({ sameSource: true, sourceVersion: null, installedVersion: "0.4.0" }).reason, "unknown-version");
  assert.strictEqual(decide({ sameSource: true, sourceVersion: "0.4.0", installedVersion: undefined }).wantsUpdate, false);
  // Installed from elsewhere (a dev checkout, npm, an older staging dir) -> take it back
  // to the shipped copy so the app stays self-contained. Version is irrelevant.
  assert.deepStrictEqual(decide({ sameSource: false, sourceVersion: "0.4.0", installedVersion: "9.9.9" }), {
    wantsUpdate: true,
    reason: "foreign-source",
  });
  assert.strictEqual(
    decide({ sameSource: false, sourceVersion: null, installedVersion: null }).wantsUpdate,
    true,
    "an unknown version must not stop a foreign-source repair",
  );
  console.log("ok - bundled-plugin update decision: newer ships, equal no-ops, newer-installed never downgrades");
}

/*
 * A notice that fired on every launch would be worse than none, and one that never
 * fires is what the user reported. Neither the extraction nor the settings window can
 * be exercised here (they need Electron), so this pends the contract: the catalog id
 * list the notice is given must resolve to real entries with a readable version.
 */
function checkPluginUpdateNoticeInputs() {
  const entries = pm.CATALOG.filter((entry) => entry.localSource);
  assert.ok(entries.length > 0, "there must be bundled entries to report on");
  for (const entry of entries) {
    assert.ok(typeof entry.zh === "string" && entry.zh !== "", `${entry.id} needs a display name for the notice`);
    assert.ok(typeof entry.en === "string" && entry.en !== "", `${entry.id} needs an English display name`);
    const dir = pm.bundledSourceDir(entry);
    assert.ok(fs.existsSync(dir), `${entry.id}: bundled source must exist at ${dir}`);
    // The notice prints this exact version, and planBundledPluginUpdate reads the same
    // file — an unreadable version would silently silence the notice as well.
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8"));
    assert.ok(
      typeof pkg.version === "string" && pkg.version !== "",
      `${entry.id}: package.json needs a version for the notice to report`,
    );
  }
  console.log(`ok - plugin update notice inputs: ${entries.length} bundled entries have names and versions`);
}

function checkDisableRefusals() {
  const t = makePatchTree({
    packages: {
      mine: { declaresPatch: true, patchYml: "- insert:\n    - id: my-row\n" },
      "other-bundle": { declaresPatch: true, patchYml: "- insert:\n  - id: shared-row\n" },
      // A CATALOG entry that is installed but declares the other CATALOG entry's row.
      "dsh-model-surplus": { patchYml: "- insert:\n    - id: model-usage\n" },
      "dsh-keys-setting": { patchYml: "- insert:\n    - id: model-usage\n" },
    },
    state: { disabled: [], region: "china" },
  });
  try {
    const patchFile = path.join(t.profile, "cordis.patch.yml");
    const stateFile = path.join(t.profile, ".dsh-market", "state.json");
    const before = fs.readFileSync(patchFile, "utf8");

    for (const rowId of ["llm-pi-ai", "session-persistence-jsonl"]) {
      const res = pm.setPluginEnabled({ dshHome: t.dshHome, pkg: "mine", rowIds: [rowId], enabled: false });
      assert.strictEqual(res.ok, false, `protected row ${rowId} must be refused`);
      assert.ok(typeof res.reason === "string" && res.reason !== "", "a refusal must carry a reason");
    }

    const foreign = pm.setPluginEnabled({ dshHome: t.dshHome, pkg: "mine", rowIds: ["shared-row"], enabled: false });
    assert.strictEqual(foreign.ok, false, "a row another installed bundle inserts must be refused");
    assert.match(foreign.reason, /other-bundle/, "the reason names the owning bundle");

    const catalogClash = pm.setPluginEnabled({
      dshHome: t.dshHome,
      pkg: "dsh-model-surplus",
      rowIds: ["model-usage"],
      enabled: false,
    });
    assert.strictEqual(catalogClash.ok, false, "another installed CATALOG bundle owns the row");
    assert.match(catalogClash.reason, /dsh-keys-setting/);

    assert.strictEqual(fs.readFileSync(patchFile, "utf8"), before, "a refusal must not touch the patch layer");
    assert.deepStrictEqual(
      JSON.parse(fs.readFileSync(stateFile, "utf8")).disabled,
      [],
      "a refusal must not record the package as disabled either",
    );

    // The guard must not block the package's own row: normal disable still works.
    const own = pm.setPluginEnabled({
      dshHome: t.dshHome,
      pkg: "mine",
      rowIds: pm.packageRowIds(t.dshHome, "mine"),
      enabled: false,
    });
    assert.strictEqual(own.ok, true);
    assert.match(fs.readFileSync(patchFile, "utf8"), /^- id: my-row\n {2}disabled: true\n/m);
    console.log("ok - disable refuses protected rows and rows owned by another bundle (nothing written)");
  } finally {
    cleanup(t.root);
  }
}

/**
 * Patch-layer writes go through a temp file + rename and are re-read for structural
 * validity, so no `*.tmp` may be left behind and the layer must stay a top-level
 * entry list (a truncated / non-list layer makes dsh refuse to boot the profile).
 */
function checkAtomicPatchWrite() {
  const t = makePatchTree({
    packages: { "my-plugin": { declaresPatch: true, patchYml: "- insert:\n    - id: my-plugin\n" } },
    state: { disabled: [] },
  });
  try {
    const patchFile = path.join(t.profile, "cordis.patch.yml");
    const tempFiles = () => fs.readdirSync(t.profile).filter((name) => name.endsWith(".tmp"));

    const res = pm.setPluginEnabled({ dshHome: t.dshHome, pkg: "my-plugin", rowIds: ["my-plugin"], enabled: false });
    assert.strictEqual(res.ok, true);
    assert.match(fs.readFileSync(patchFile, "utf8"), /^- id: my-plugin\n {2}disabled: true\n/m);
    assert.deepStrictEqual(tempFiles(), [], "atomic write must not leave a *.tmp file behind");

    // The removal path (legacy-plugin cleanup) is atomic too and restores `[]`.
    assert.deepStrictEqual(pm.removePatchRows(t.dshHome, ["my-plugin"]), ["my-plugin"]);
    assert.match(fs.readFileSync(patchFile, "utf8"), /^\[\]$/m);
    assert.deepStrictEqual(tempFiles(), [], "atomic removal must not leave a *.tmp file behind");

    // Post-write structural check: a layer that is not a top-level entry list would
    // make dsh refuse to boot the profile, so the write is reverted byte-for-byte
    // and reported as a failure instead.
    const stray = "  stray: true\n";
    fs.writeFileSync(patchFile, stray);
    const refused = pm.setPluginEnabled({ dshHome: t.dshHome, pkg: "my-plugin", rowIds: ["my-plugin"], enabled: false });
    assert.strictEqual(refused.ok, false, "a write that breaks the layer shape must fail");
    assert.match(refused.reason, /not a top-level entry list/);
    assert.strictEqual(fs.readFileSync(patchFile, "utf8"), stray, "the previous bytes must be restored");
    assert.deepStrictEqual(tempFiles(), [], "a reverted write must not leave a *.tmp file behind");
    console.log("ok - patch-layer writes are atomic (tmp + rename) and leave no *.tmp behind");
  } finally {
    cleanup(t.root);
  }
}

/**
 * 四个内置插件必须能从**随包的那份拷贝**装上，完全不经过 registry。有三种情况会让
 * 这件事静默失效：
 *
 *   1. 某个 CATALOG 条目丢了 `localSource` —— 它会退回 npm 安装路径；
 *   2. 仓库里的 `plugins/<localSource>` 丢了或改了名（构建产物就没有该插件）；
 *   3. 「这条依赖是不是随包那份」的判定认不出 pnpm 真正写回来的 spec —— 于是每次启动
 *      都误判成来源不对而反复重装，或者反过来永远修不回正确的来源。
 *
 * 这三条都在这里对着**真实的 CATALOG 与真实的 plugins/ 目录**检查。
 */
function checkBuiltInInstallSource() {
  const stagingRoot = "C:\\Users\\x\\.dsh-gui\\bundled-plugins";
  const builtIns = pm.CATALOG.filter((entry) => entry.localSource);
  assert.ok(builtIns.length >= 4, `expected at least 4 built-in entries, saw ${builtIns.length}`);

  for (const entry of builtIns) {
    const sourceDir = pm.bundledSourceDir(entry);
    const manifestPath = path.join(sourceDir, "package.json");
    assert.ok(fs.existsSync(manifestPath), `${entry.pkg}: built-in source missing at ${sourceDir}`);
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    assert.strictEqual(manifest.name, entry.pkg, `${entry.pkg}: plugins/ copy declares "${manifest.name}"`);
    assert.ok(
      typeof manifest.version === "string" && manifest.version !== "",
      `${entry.pkg}: version is readable (the update comparison needs it)`,
    );
    assert.ok(
      fs.existsSync(path.join(sourceDir, "cordis.patch.yml")),
      `${entry.pkg}: patch file is present in the shipped copy`,
    );

    // The spec we write and the spec pnpm records back must be recognised as ours.
    // `stagingRoot` comes from the main process and is computed the same way on every
    // launch, so this comparison is stable — it must not depend on the app's own
    // install directory (which changes on every update).
    const spec = pm.bundledStagedSpec(entry, stagingRoot);
    assert.strictEqual(
      spec,
      `file:${stagingRoot.replace(/\\/gu, "/")}/${entry.pkg}`,
      `${entry.pkg}: spec shape`,
    );
    assert.strictEqual(pm.isBundledStagedSpec(spec, entry, stagingRoot), true, `${entry.pkg}: own spec recognised`);
    // pnpm normalises separators; Windows paths are case-insensitive.
    assert.strictEqual(
      pm.isBundledStagedSpec(spec.toUpperCase(), entry, stagingRoot),
      true,
      `${entry.pkg}: case-insensitive`,
    );
    assert.strictEqual(
      pm.isBundledStagedSpec(spec.replace(/\//gu, "\\"), entry, stagingRoot),
      true,
      `${entry.pkg}: separator-insensitive`,
    );
    assert.strictEqual(
      pm.bundledStagedSpec(entry, stagingRoot),
      spec,
      `${entry.pkg}: the same stagingRoot always yields the same spec`,
    );
  }

  // Anything that is not the shipped copy must be rejected, so boot maintenance
  // repairs it: a development checkout, the staging dir under a different package
  // name, a registry range, a dist-tag, and "not declared at all".
  const sample = builtIns[0];
  const foreign = [
    `file:D:/AI/WorkBook/${sample.pkg}`,
    "file:C:/Users/x/.dsh-gui/bundled-plugins/some-other-plugin",
    "file:../elsewhere/" + sample.pkg,
    "^1.0.0",
    "latest",
    "",
    undefined,
  ];
  for (const spec of foreign) {
    assert.strictEqual(
      pm.isBundledStagedSpec(spec, sample, stagingRoot),
      false,
      `${sample.pkg}: not the shipped copy -> ${String(spec)}`,
    );
  }
  console.log(
    `ok - ${builtIns.length} built-in plugins resolve to the copy shipped in plugins/; foreign specs are rejected`,
  );
}

run()
  .then(checkClientHalf)
  .then(checkRowIdScan)
  .then(checkBundledPluginUpdateDecision)
  .then(checkPluginUpdateNoticeInputs)
  .then(checkDisableRefusals)
  .then(checkAtomicPatchWrite)
  .then(checkBuiltInInstallSource)
  .then(
    () => console.log("plugin-manager: all checks passed"),
    (e) => {
      console.error("FAILED", e);
      process.exit(1);
    },
  );