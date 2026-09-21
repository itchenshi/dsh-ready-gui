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

run().then(
  () => console.log("plugin-manager: all checks passed"),
  (e) => {
    console.error("FAILED", e);
    process.exit(1);
  },
);