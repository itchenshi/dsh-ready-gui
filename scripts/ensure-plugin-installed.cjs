// scripts/ensure-plugin-installed.cjs — pre-install a bundled plugin into an isolated profile.
//
// Why this exists: the smoke tests copy a profile into a temp directory and then assert
// migration behaviour that presupposes certain plugins are already installed. They used to
// inherit that precondition from the developer's live profile, so they failed with a
// misleading message ("boot never removed the pre-rename plugin") whenever the live profile
// had been cleaned up. Setting the precondition explicitly makes the test self-sufficient.
//
// It reuses the app's own install path (syncEnabledPlugins -> staging -> `dsh plugin add`),
// so no network is needed: bundled entries are staged from <repo>/plugins.
//
// Usage: node scripts/ensure-plugin-installed.cjs <userDataDir> <homeDir> <pluginId...>
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const REPO = path.join(__dirname, "..");
const pm = require(path.join(REPO, "src", "plugin-manager.js"));

async function main() {
  const [userDataDir, homeDir, ...ids] = process.argv.slice(2);
  if (!userDataDir || !homeDir || ids.length === 0) {
    console.error("usage: node ensure-plugin-installed.cjs <userDataDir> <homeDir> <pluginId...>");
    process.exit(2);
  }
  const engineDir = path.join(userDataDir, "dsh-engine");
  const engineBin = path.join(engineDir, "node_modules", "@deepseek-ai", "dsh", "lib", "bin.js");
  if (!fs.existsSync(engineBin)) {
    console.error(`engine not found: ${engineBin}`);
    process.exit(2);
  }

  const known = new Set(pm.CATALOG.map((entry) => entry.id));
  const unknown = ids.filter((id) => !known.has(id));
  if (unknown.length > 0) {
    console.error(`unknown plugin id(s): ${unknown.join(", ")}`);
    process.exit(2);
  }

  const result = await pm.syncEnabledPlugins({
    enabledIds: ids,
    mode: "install",
    engineDir,
    dshHome: homeDir,
    nodeExec: process.execPath,
    // pnpm tools live in the copied userData (the smokes copy them).
    pnpmInstallDir: path.join(userDataDir, "pnpm-tools"),
    // IMPORTANT: must be the SAME staging root the app itself uses. The profile records a
    // `file:` dependency pointing at this exact path, and the app treats a dependency that
    // points elsewhere as "installed from a foreign source" and reinstalls it - which would
    // silently throw away the precondition this helper just set up. The app derives it from
    // <os.homedir()>/.dsh-gui/bundled-plugins (see pluginBundledPluginsDir in main.js), NOT
    // from the userData dir.
    stagingRoot: path.join(os.homedir(), ".dsh-gui", "bundled-plugins"),
    log: (...args) => console.log("[preinstall]", ...args),
  });

  if (result.errors.length > 0) {
    console.error("pre-install errors:\n  " + result.errors.join("\n  "));
    process.exit(1);
  }
  console.log(`[preinstall] installed: ${result.installed.join(", ") || "(nothing to do)"}`);
}

main().catch((error) => {
  console.error("pre-install failed:", (error && error.stack) || error);
  process.exit(1);
});
