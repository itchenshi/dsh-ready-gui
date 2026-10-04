// End-to-end proof that the bundled plugins **self-heal**.
//
// Requires a DSH engine (and network the first time, to fetch pnpm). It never
// touches your real DSH_HOME: everything happens in a fresh temporary home, and
// the engine is booted only to prove the profile still works.
//
// What it reproduces — the state left behind by the abandoned "install the
// bundled plugins from npm" release:
//   bundles : base, web-app + three of the four bundled plugins
//   deps    : those three are `file:` specs pointing at a **development checkout
//             that no longer exists**; the fourth plugin is missing entirely
//             (its npm install 404'd).
//
// Why the specs point at a path that does not exist: a stale `file:` dependency
// is what broke the repair in the first place — pnpm re-resolves the whole
// dependency set on every install, so one unresolvable spec made *every other*
// plugin's install fail too (measured: repairing A failed with ENOENT on B's
// path). Seeding a path that is gone keeps this a regression test for that.
//
// Checks:
//   0. a staging failure leaves the profile completely untouched (nothing may be
//      pruned before the bundled copy has actually been staged)
//   1. the foreign specs are repaired to the copy shipped in plugins/
//   2. the missing one installs (the path the settings-window checkbox takes)
//   3. a second pass is a no-op (no reinstall churn on every boot)
//   4. the engine boots with all of them
//
// Usage:
//   node scripts/verify-builtin-plugins.cjs [--engine <dsh-engine dir>] [--keep]
//
// The engine directory is taken from --engine, else $DSH_ENGINE_DIR, else the
// one this app downloads into its userData directory.
"use strict";
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, execFileSync } = require("node:child_process");

const REPO = path.join(__dirname, "..");
const pm = require(path.join(REPO, "src", "plugin-manager.js"));

const argv = process.argv.slice(2);
const keep = argv.includes("--keep");
const engineArgIndex = argv.indexOf("--engine");
const ENGINE_DIR = engineArgIndex >= 0 ? argv[engineArgIndex + 1] : defaultEngineDir();
const NODE_EXEC = process.execPath;

/**
 * 被启动的引擎子进程（第 4 步）。必须能**在任何退出路径上**被杀掉：
 *   - `child.kill()` 在 Windows 上杀不掉进程树，引擎的孙进程会继续占着端口与临时目录；
 *   - 早先只在「走到第 4 步之后」显式 kill，而它之后的任何一步抛错都会走 `.catch` →
 *     `process.exit(2)`，把引擎留在后台（一次失败的验证会泄漏一个常驻服务）。
 */
let engineChild = null;
function killEngineChild() {
  const child = engineChild;
  if (!child) return;
  engineChild = null;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
    } else {
      try {
        process.kill(-child.pid, "SIGKILL"); // 负 pid = 整个进程组（spawn 时 detached）
      } catch {
        child.kill("SIGKILL");
      }
    }
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already gone */
    }
  }
}
process.on("exit", killEngineChild);
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    killEngineChild();
    process.exit(130);
  });
}

/** Where the app puts the engine it downloads: <userData>/dsh-engine. */
function defaultEngineDir() {
  if (process.env.DSH_ENGINE_DIR) return process.env.DSH_ENGINE_DIR;
  const appData =
    process.env.APPDATA ?? path.join(os.homedir(), process.platform === "darwin" ? "Library/Application Support" : ".config");
  const productName = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")).productName ?? "DSH Ready GUI";
  return path.join(appData, productName, "dsh-engine");
}

let failures = 0;
const ok = (label) => console.log("  ok  -", label);
const bad = (label) => {
  failures += 1;
  console.log("  FAIL-", label);
};
const check = (condition, label) => (condition ? ok(label) : bad(label));

const engineBin = path.join(ENGINE_DIR, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
if (!fs.existsSync(engineBin)) {
  console.error(`engine not found: ${engineBin}`);
  console.error("pass --engine <dir>, set DSH_ENGINE_DIR, or launch the app once so it downloads the engine.");
  process.exit(2);
}

// The three that are registered from a checkout that is gone; the fourth is absent.
const FOREIGN = ["dsh-gui-last-session", "dsh-model-surplus", "dsh-keys-setting"];
const MISSING = "dsh-gateway-models";
const ALL = [...FOREIGN, MISSING];

const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-verify-builtin-"));
const home = path.join(root, "home");
const profile = path.join(home, "profiles", "web");
const stagingRoot = path.join(root, "staging");
// A checkout path that is deliberately never created (see the header).
const goneCheckout = path.join(root, "deleted-checkout").replace(/\\/gu, "/");
// Reused across runs so pnpm is fetched once, not on every invocation.
const pnpmInstallDir = path.join(os.tmpdir(), "dsh-verify-builtin-pnpm");
fs.mkdirSync(profile, { recursive: true });

fs.writeFileSync(
  path.join(profile, "package.json"),
  JSON.stringify(
    {
      name: "dsh-profile-web",
      private: true,
      dsh: { profile: { bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", ...FOREIGN], patchReload: "live" } },
      dependencies: Object.fromEntries(FOREIGN.map((name) => [name, `file:${goneCheckout}/${name}`])),
    },
    null,
    2,
  ),
);

const readDeps = () => JSON.parse(fs.readFileSync(path.join(profile, "package.json"), "utf8")).dependencies ?? {};
const materialised = (name) => fs.existsSync(path.join(profile, "node_modules", name, "package.json"));
const entryOf = (pkg) => pm.CATALOG.find((entry) => entry.pkg === pkg);
const sync = (enabledIds, log, useStagingRoot = stagingRoot) =>
  pm.syncEnabledPlugins({
    enabledIds,
    engineDir: ENGINE_DIR,
    dshHome: home,
    nodeExec: NODE_EXEC,
    pnpmInstallDir,
    stagingRoot: useStagingRoot,
    mode: "install",
    log: log ?? (() => {}),
  });

(async () => {
  console.log(`engine    = ${ENGINE_DIR}`);
  console.log(`DSH_HOME  = ${home}`);
  console.log(`before    = ${JSON.stringify(readDeps())}\n`);

  const pnpmBinDir = await pm.ensurePnpm({ installDir: pnpmInstallDir, pnpmSpec: "pnpm@10", nodeExec: NODE_EXEC, log: () => {} });
  if (!pnpmBinDir) throw new Error("pnpm provisioning failed");

  // Before the repair itself: prove the repair cannot make things worse. A staging
  // root with a space in it is rejected by stageBundledPlugin outright (the engine's
  // shell cannot carry such a path), which is a deterministic way to make staging
  // fail. The profile must then be left exactly as it was — the earlier ordering
  // ("prune the registration first, install after") lost the plugins in this case.
  console.log("0) a staging failure must leave the profile untouched");
  const blockedStagingRoot = path.join(root, "with space");
  const guarded = await sync(FOREIGN, () => {}, blockedStagingRoot);
  check(guarded.changed === false, "nothing was pruned while staging was impossible");
  check(FOREIGN.every((name) => pm.installedBundles(home).includes(name)), "the three registrations are intact");
  check(
    FOREIGN.every((name) => String(readDeps()[name] ?? "").includes("deleted-checkout")),
    "the original dependencies are intact",
  );
  check(guarded.errors.length === FOREIGN.length, `the failure is reported (${guarded.errors.length} error(s))`);

  console.log("\n1) repair the entries registered from a checkout that is gone");
  const first = await sync(FOREIGN, (...a) => console.log("      [pm]", ...a));
  console.log(`      installed=${JSON.stringify(first.installed)} errors=${JSON.stringify(first.errors)}`);
  const deps1 = readDeps();
  for (const name of FOREIGN) {
    check(pm.isBundledStagedSpec(deps1[name], entryOf(name), stagingRoot), `${name}: dep now points at the bundled staging copy`);
    check(materialised(name), `${name}: materialised in node_modules`);
  }
  check(
    !FOREIGN.some((name) => String(deps1[name] ?? "").includes("deleted-checkout")),
    "no dependency still points at the checkout",
  );

  console.log("\n2) install the missing fourth (what the settings checkbox does)");
  const second = await sync([MISSING], (...a) => console.log("      [pm]", ...a));
  console.log(`      installed=${JSON.stringify(second.installed)} errors=${JSON.stringify(second.errors)}`);
  check(materialised(MISSING), `${MISSING}: materialised`);
  check(pm.installedBundles(home).includes(MISSING), `${MISSING}: registered in the bundle list`);

  console.log("\n3) a second boot must be a no-op (no reinstall churn)");
  const third = await sync(ALL);
  check(third.installed.length === 0 && third.errors.length === 0, `idempotent: installed=${JSON.stringify(third.installed)}`);

  console.log("\n4) the engine boots with all four bundled plugins");
  const child = spawn(NODE_EXEC, [engineBin, "web", "--no-open", "--port", "0"], {
    env: { ...process.env, DSH_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
    // POSIX 上要能按进程组杀（见 killEngineChild）；Windows 用 taskkill /T。
    detached: process.platform !== "win32",
  });
  engineChild = child;
  let out = "";
  let err = "";
  child.stdout.on("data", (chunk) => {
    out += chunk;
  });
  child.stderr.on("data", (chunk) => {
    err += chunk;
  });
  const url = await new Promise((resolve) => {
    let interval = null;
    let deadline = null;
    const settle = (value) => {
      clearInterval(interval);
      clearTimeout(deadline);
      resolve(value);
    };
    interval = setInterval(() => {
      const match = /dsh web:\s*(\S+)/u.exec(out);
      if (match) settle(match[1]);
    }, 500);
    deadline = setTimeout(() => settle(null), 120_000);
    child.on("close", () => settle(null));
  });
  check(url !== null, `booted${url ? ` -> ${url}` : ` (stderr tail: ${err.slice(-300)})`}`);

  // ---------------------------------------------------------------------------
  // 4b) runtime liveness — did each plugin actually APPLY?
  //
  // "In the bundle list" only proves a plugin is registered to load. Cordis SKIPS a
  // plugin whose injected service is missing (that is what `inject` is for), so an
  // engine-side change can leave a plugin quietly not running while every check above
  // still passed — and a compatibility claim would be unearned.
  //
  // So each plugin is asked for its own observable effect:
  //   - the three that register an HTTP route must answer on it. Their fence runs
  //     first, so an unauthenticated probe gets 401/403 — and a route that never got
  //     registered is not there at all, which is the difference being tested.
  //   - dsh-gateway-models has no route; its effect is a settings WRITE (it puts the
  //     DeepSeek V4.1 models in front of the opencode-go list the patch declares).
  //
  // NOT OBSERVABLE HERE (this is a limitation of the probe, not a verdict on the
  // plugin): dsh-gateway-models has no HTTP route, and its only effect is a settings
  // write that it only performs once it can DESCRIBE an `opencode-go` model catalog
  // (`llm.discoverModels(NS, { provider: 'opencode-go' })`). This disposable profile
  // configures no opencode-go models and the engine's built-in pi-ai catalog has no
  // such provider, so there is nothing to detect and the plugin correctly does
  // nothing — the probe would report the same "no write" whether the plugin were
  // healthy or dead. Its settings-API port is therefore pinned by unit tests in that
  // repository (settingsEntry/updateEntry against the describe() shape) instead.
  //
  // The other three plugins ARE asserted: if one of them stops applying, the check
  // below fails.
  const INERT_ON_THIS_ENGINE = {
    "dsh-gateway-models": "no observable effect in this profile (no opencode-go catalog to describe)",
  };
  const inertSeen = [];

  if (url !== null) {
    const origin = new URL(url).origin;
    const probe = async (route) => {
      try {
        const res = await fetch(new URL(route, origin), { redirect: "manual" });
        return res.status;
      } catch {
        return null;
      }
    };

    // Control: a path that must not exist, so "not 404" can be judged from real data
    // rather than from an assumption about how the engine answers unknown paths.
    const control = await probe("/dsh-verify-no-such-route");
    console.log(`      control ${"/dsh-verify-no-such-route"} -> HTTP ${control}`);

    const ROUTES = {
      "dsh-keys-setting": "/composer-keys",
      "dsh-model-surplus": "/model-usage",
      "dsh-gui-last-session": "/gui-last-session",
    };
    for (const [pkg, route] of Object.entries(ROUTES)) {
      const status = await probe(route);
      const applied = status === 401 || status === 403;
      if (applied) {
        check(true, `${pkg}: applied (its route ${route} answers HTTP ${status} through the trust fence)`);
      } else if (INERT_ON_THIS_ENGINE[pkg]) {
        inertSeen.push(`${pkg} — ${INERT_ON_THIS_ENGINE[pkg]}`);
        console.log(`      KNOWN INERT ${pkg}: route ${route} -> HTTP ${status} (${INERT_ON_THIS_ENGINE[pkg]})`);
      } else {
        check(false, `${pkg}: applied (its route ${route} answers HTTP ${status} — expected 401/403)`);
      }
    }

    // The settings write can land a moment after the UI URL is printed, so poll.
    const settingsFile = path.join(home, "settings.yaml");
    let wrote = false;
    for (let i = 0; i < 40 && !wrote; i += 1) {
      try {
        wrote = fs.readFileSync(settingsFile, "utf8").includes("deepseek-v4.1-flash");
      } catch {
        wrote = false;
      }
      if (!wrote) await new Promise((r) => setTimeout(r, 500));
    }
    if (wrote) {
      check(true, "dsh-gateway-models: applied (it wrote the V4.1 models into settings.yaml)");
    } else if (INERT_ON_THIS_ENGINE["dsh-gateway-models"]) {
      inertSeen.push(`dsh-gateway-models — ${INERT_ON_THIS_ENGINE["dsh-gateway-models"]}`);
      console.log(`      KNOWN INERT dsh-gateway-models: wrote nothing (${INERT_ON_THIS_ENGINE["dsh-gateway-models"]})`);
    } else {
      check(false, "dsh-gateway-models: applied (it wrote the V4.1 models into settings.yaml)");
    }

    if (inertSeen.length > 0) {
      console.log(`      NOTE: ${inertSeen.length} bundled plugin(s) are inert on this engine:`);
      for (const line of inertSeen) console.log(`        - ${line}`);
    }

    // The engine is quiet about a skipped plugin, so surface anything it did say that
    // could explain an unexpected result.
    const noise = `${out}\n${err}`
      .split(/\r?\n/u)
      .filter((line) => /composer-keys|gateway-models|model-usage|gui-last-session|cannot|unavailable|missing|skip|error|Error/u.test(line))
      .slice(-12);
    if (noise.length > 0) {
      console.log("      engine log (filtered):");
      for (const line of noise) console.log(`        ${line.trim().slice(0, 160)}`);
    }
  }

  killEngineChild();

  const remaining = ALL.filter((name) => !pm.installedBundles(home).includes(name));
  check(remaining.length === 0, `all four plugins are in the bundle list${remaining.length ? ` (missing: ${remaining.join(", ")})` : ""}`);

  // ---------------------------------------------------------------------------
  // 5) the rename path: an install that still carries the OLD package name.
  //
  // This is the situation every existing user is in after the rename. The startup
  // maintenance must (a) unregister the old package from BOTH the bundle list and
  // dependencies, (b) hand the replacement to the install pass, and (c) leave the
  // user's enable/disable choice alone — the old package shares its patch row id
  // (`opencode-go`) with the new one, so a careless cleanup would wipe it.
  // ---------------------------------------------------------------------------
  console.log("\n5) an install carrying the old name is swapped for the new one");
  const OLD = "dsh-opencode-go-path";
  const NEW = "dsh-gateway-models";
  const oldStaged = path.join(stagingRoot, OLD);
  fs.mkdirSync(oldStaged, { recursive: true });
  fs.writeFileSync(
    path.join(oldStaged, "package.json"),
    JSON.stringify({ name: OLD, version: "0.2.0", dsh: { bundle: { patch: "./cordis.patch.yml" } } }, null, 2),
  );
  fs.writeFileSync(path.join(oldStaged, "cordis.patch.yml"), "- insert:\n    - id: opencode-go\n      name: dsh-opencode-go-path\n");
  fs.mkdirSync(path.join(profile, "node_modules", OLD), { recursive: true });
  fs.writeFileSync(path.join(profile, "node_modules", OLD, "package.json"), JSON.stringify({ name: OLD, version: "0.2.0" }));

  const manifestPath = path.join(profile, "package.json");
  const withOld = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  withOld.dsh.profile.bundles.push(OLD);
  withOld.dependencies = { ...(withOld.dependencies ?? {}), [OLD]: `file:${oldStaged.replace(/\\/gu, "/")}` };
  fs.writeFileSync(manifestPath, JSON.stringify(withOld, null, 2));
  // A live row (`disabled: false` — harmless, unlike true) that MUST survive.
  fs.writeFileSync(path.join(profile, "cordis.patch.yml"), "- id: opencode-go\n  disabled: false\n");

  check(pm.installedBundles(home).includes(OLD), "precondition: the old package name is registered");

  const legacy = await pm.removeLegacyPlugins({
    engineDir: ENGINE_DIR,
    dshHome: home,
    nodeExec: NODE_EXEC,
    pnpmInstallDir,
    stagingRoot,
    log: (...a) => console.log("      [pm]", ...a),
  });
  console.log(`      pruned=${JSON.stringify(legacy.pruned)} replaced=${JSON.stringify(legacy.replaced)}`);
  // Unregistration is judged by the END STATE, not by `pruned`: when the engine's own
  // `dsh plugin remove` succeeds there is nothing left for the fallback prune to do,
  // so an empty `pruned` is the healthy case here.
  check(!pm.installedBundles(home).includes(OLD), `${OLD}: unregistered`);
  check(legacy.replaced.includes(NEW), `${NEW}: handed to the install pass`);
  check(
    !Object.prototype.hasOwnProperty.call(readDeps(), OLD),
    `${OLD}: gone from dependencies (a leftover would let the engine reconcile it back)`,
  );
  check(
    /^- id: opencode-go\n {2}disabled: false$/m.test(fs.readFileSync(path.join(profile, "cordis.patch.yml"), "utf8")),
    "the live patch row shared with the new package was left alone",
  );

  // Exactly what the startup maintenance does with `replaced`.
  const enabledAfter = pm
    .CATALOG.filter((entry) => pm.installedBundles(home).includes(entry.pkg))
    .map((entry) => entry.id);
  for (const id of legacy.replaced) if (!enabledAfter.includes(id)) enabledAfter.push(id);
  const swap = await sync(enabledAfter, (...a) => console.log("      [pm]", ...a));
  console.log(`      installed=${JSON.stringify(swap.installed)} errors=${JSON.stringify(swap.errors)}`);
  check(swap.errors.length === 0, "the swap reported no errors");
  check(materialised(NEW) && pm.installedBundles(home).includes(NEW), `${NEW}: installed and registered`);
  check(!fs.existsSync(oldStaged), `${OLD}: stale staged copy pruned`);
  check(
    !pm.installedBundles(home).some((name) => name === OLD),
    "no duplicate: the old name is not registered alongside the new one",
  );

  // ---------------------------------------------------------------------------
  // 6) EVERY bundled plugin whose installed copy is behind gets replaced.
  //
  // The promise is "the GUI updated, so my bundled plugins did too" — and the
  // reported failure was that it seemed to happen for one plugin and not others.
  // So this downgrades ALL of them at once (the way a second data directory would
  // hold them) and asserts each comes back at its shipped version, in a single
  // pass. Covering one plugin would leave "is this generic or specific to
  // dsh-model-surplus?" unproven — which is exactly the question being asked.
  // The old marketplace entry has no `localSource` and must be left alone.
  // ---------------------------------------------------------------------------
  console.log("\n6) every bundled plugin older than the shipped copy is updated in place");
  const bundled = pm.CATALOG.filter((e) => e.localSource);
  const OLD_VERSION = "0.0.1";
  const pkgFileOf = (pkg) => path.join(profile, "node_modules", pkg, "package.json");
  const shippedVersionOf = (e) => JSON.parse(fs.readFileSync(path.join(pm.bundledSourceDir(e), "package.json"), "utf8")).version;
  const setVersion = (pkg, version) => {
    const meta = JSON.parse(fs.readFileSync(pkgFileOf(pkg), "utf8"));
    meta.version = version;
    fs.writeFileSync(pkgFileOf(pkg), JSON.stringify(meta, null, 2));
  };

  check(bundled.length >= 4, `precondition: ${bundled.length} bundled entries in the catalog`);
  for (const e of bundled) setVersion(e.pkg, OLD_VERSION);
  check(
    bundled.every((e) => pm.catalogStatus(home)[e.id].version === OLD_VERSION),
    `precondition: all ${bundled.length} bundled plugins report the older version`,
  );

  const bumped = await sync([...ALL], (...a) => console.log("      [pm]", ...a));
  console.log(`      installed=${JSON.stringify(bumped.installed)} errors=${JSON.stringify(bumped.errors)}`);
  check(bumped.errors.length === 0, "the update pass reported no errors");
  for (const e of bundled) {
    const shipped = shippedVersionOf(e);
    check(bumped.installed.includes(e.id), `${e.pkg}: reinstalled at the shipped version`);
    check(
      pm.catalogStatus(home)[e.id].version === shipped,
      `${e.pkg}: now reports v${shipped}`,
    );
  }

  // The reverse is refused: an install that is AHEAD must be left alone.
  const aheadEntry = bundled[0];
  const AHEAD_VERSION = "99.0.0";
  setVersion(aheadEntry.pkg, AHEAD_VERSION);
  const kept = await sync([...ALL]);
  check(kept.installed.length === 0, "a newer installed copy is not touched (no unattended downgrade)");
  check(
    pm.catalogStatus(home)[aheadEntry.id].version === AHEAD_VERSION,
    `${aheadEntry.pkg}: the newer installed version survives`,
  );

  // A non-bundled catalog entry (the marketplace plugin) has no shipped source to
  // compare against, so the pass must never touch its version. Fabricated here —
  // registered + materialised but with no `localSource` — because that is precisely
  // the shape the guard `if (has && entry.localSource)` excludes, and this costs no
  // pnpm run (nothing needs installing).
  const marketEntry = pm.CATALOG.find((e) => !e.localSource && e.pkg === "dshmarket");
  check(marketEntry !== undefined, "the catalog still carries a non-bundled (marketplace) entry");
  if (marketEntry) {
    const marketDir = path.join(profile, "node_modules", marketEntry.pkg);
    fs.mkdirSync(marketDir, { recursive: true });
    fs.writeFileSync(path.join(marketDir, "package.json"), JSON.stringify({ name: marketEntry.pkg, version: "1.2.3" }, null, 2));
    const withMarket = JSON.parse(fs.readFileSync(path.join(profile, "package.json"), "utf8"));
    if (!withMarket.dsh.profile.bundles.includes(marketEntry.pkg)) withMarket.dsh.profile.bundles.push(marketEntry.pkg);
    fs.writeFileSync(path.join(profile, "package.json"), JSON.stringify(withMarket, null, 2));
    check(
      pm.catalogStatus(home)[marketEntry.id].installed === true,
      "precondition: the marketplace plugin is installed (but not bundled)",
    );

    const untouched = await sync([...ALL]);
    check(
      !untouched.installed.includes(marketEntry.id),
      "the non-bundled marketplace plugin is not version-managed by the GUI",
    );
    check(
      pm.catalogStatus(home)[marketEntry.id].version === "1.2.3",
      "it keeps whatever version it has (updates come from the marketplace, not the shell)",
    );
  }

  // Leave the home in the state the earlier phases expect.
  for (const e of bundled) setVersion(e.pkg, shippedVersionOf(e));

  // ---------------------------------------------------------------------------
  // 7) uninstalling is clean.
  //
  // The store asks for install / start / uninstall evidence on a disposable profile.
  // Install and start are phases 1-4; this is the missing third: remove one bundled
  // plugin through the engine's own path and assert nothing is left behind — neither
  // the bundle registration nor a dependency entry (a leftover `file:` spec is what
  // lets the engine reconcile the package straight back in on the next boot).
  // Done last, because it deliberately changes the home.
  // ---------------------------------------------------------------------------
  console.log("\n7) uninstalling a bundled plugin leaves nothing behind");
  const REMOVE_TARGET = "dsh-keys-setting";
  const removeEntry = entryOf(REMOVE_TARGET);
  check(pm.installedBundles(home).includes(REMOVE_TARGET), `precondition: ${REMOVE_TARGET} is installed`);

  const removed = await pm.removePlugin({
    engineDir: ENGINE_DIR,
    dshHome: home,
    pnpmBinDir,
    pkg: REMOVE_TARGET,
    nodeExec: NODE_EXEC,
    log: (...a) => console.log("      [pm]", ...a),
  });
  console.log(`      removePlugin ok=${removed.ok}`);
  pm.pruneProfilePackages(home, [REMOVE_TARGET]);

  check(!pm.installedBundles(home).includes(REMOVE_TARGET), `${REMOVE_TARGET}: gone from the bundle list`);
  check(
    !Object.prototype.hasOwnProperty.call(readDeps(), REMOVE_TARGET),
    `${REMOVE_TARGET}: gone from dependencies (a leftover would be reconciled back in)`,
  );
  check(
    pm.catalogStatus(home)[removeEntry.id].installed === false,
    `${REMOVE_TARGET}: the settings window would now show it as not installed`,
  );
  // The others must be untouched by the removal.
  const stillThere = bundled.filter((e) => e.pkg !== REMOVE_TARGET && pm.installedBundles(home).includes(e.pkg));
  check(
    stillThere.length === bundled.length - 1,
    `the other ${bundled.length - 1} bundled plugins are unaffected`,
  );

  console.log("\nfinal deps = " + JSON.stringify(readDeps(), null, 2));
  if (keep) console.log(`\nkept: ${root}`);
  else fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
  console.error("HARNESS ERROR", error);
  killEngineChild(); // 别把引擎留在后台（它会占着端口与临时 home）
  process.exit(2);
});
