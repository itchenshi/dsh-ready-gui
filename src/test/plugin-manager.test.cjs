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
        assert.ok(!fs.existsSync(path.join(t.profile, "package.json.dsh-gui-heal.tmp")));
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
    // not installed, but the repo carries the source (localSource entries)
    assert.strictEqual(
      pm.pluginHasClientHalf(dshHome, { pkg: "dsh-composer-keys", localSource: "dsh-composer-keys" }),
      true,
      "bundled source with a page half -> true",
    );
    assert.strictEqual(
      pm.pluginHasClientHalf(dshHome, { pkg: "dsh-model-usage", localSource: "dsh-model-usage" }),
      true,
      "bundled source with a page half -> true (second case)",
    );
    // ...and a bundled HOST-ONLY plugin is false, not unknown: this is exactly the
    // per-plugin difference the settings row reports (no page reload needed).
    assert.strictEqual(
      pm.pluginHasClientHalf(dshHome, { pkg: "dsh-opencode-go", localSource: "dsh-opencode-go" }),
      false,
      "bundled host-only source -> false",
    );
    // unknown: nothing installed and no bundled source to read (npm entries)
    assert.strictEqual(pm.pluginHasClientHalf(dshHome, { pkg: "not-installed-yet" }), null, "unknown -> null");
    assert.strictEqual(
      pm.pluginHasClientHalf(dshHome, { pkg: "ghost", localSource: "does-not-exist" }),
      null,
      "missing bundled source -> null",
    );
    console.log("ok - pluginHasClientHalf detects the page half (installed copy first, bundled source second)");
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
function checkDisableRefusals() {
  const t = makePatchTree({
    packages: {
      mine: { declaresPatch: true, patchYml: "- insert:\n    - id: my-row\n" },
      "other-bundle": { declaresPatch: true, patchYml: "- insert:\n  - id: shared-row\n" },
      // A CATALOG entry that is installed but declares the other CATALOG entry's row.
      "dsh-model-usage": { patchYml: "- insert:\n    - id: model-usage\n" },
      "dsh-composer-keys": { patchYml: "- insert:\n    - id: model-usage\n" },
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
      pkg: "dsh-model-usage",
      rowIds: ["model-usage"],
      enabled: false,
    });
    assert.strictEqual(catalogClash.ok, false, "another installed CATALOG bundle owns the row");
    assert.match(catalogClash.reason, /dsh-composer-keys/);

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

run()
  .then(checkClientHalf)
  .then(checkRowIdScan)
  .then(checkDisableRefusals)
  .then(checkAtomicPatchWrite)
  .then(
    () => console.log("plugin-manager: all checks passed"),
    (e) => {
      console.error("FAILED", e);
      process.exit(1);
    },
  );