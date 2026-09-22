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
const { spawn } = require("node:child_process");

const REPO = path.join(__dirname, "..");
const pm = require(path.join(REPO, "src", "plugin-manager.js"));

const argv = process.argv.slice(2);
const keep = argv.includes("--keep");
const engineArgIndex = argv.indexOf("--engine");
const ENGINE_DIR = engineArgIndex >= 0 ? argv[engineArgIndex + 1] : defaultEngineDir();
const NODE_EXEC = process.execPath;

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
const MISSING = "dsh-opencode-go-path";
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
  });
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
  try {
    child.kill();
  } catch {
    /* already gone */
  }

  const remaining = ALL.filter((name) => !pm.installedBundles(home).includes(name));
  check(remaining.length === 0, `all four plugins are in the bundle list${remaining.length ? ` (missing: ${remaining.join(", ")})` : ""}`);

  console.log(`\nfinal deps = ${JSON.stringify(readDeps(), null, 2)}`);
  if (keep) console.log(`\nkept: ${root}`);
  else fs.rmSync(root, { recursive: true, force: true });
  console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
  process.exit(failures === 0 ? 0 : 1);
})().catch((error) => {
  console.error("HARNESS ERROR", error);
  process.exit(2);
});
