"use strict";

/**
 * after-pack.js — electron-builder afterPack hook.
 *
 * electron-builder's extraResources matcher silently drops node_modules, so
 * the bundled portable Node would ship without npm. This hook copies the
 * whole `resources/node` (bundled by scripts/bundle-node.mjs) into the app's
 * resources dir right after packaging — before the installer/archive is built
 * — with no filter involved.
 *
 * Configured via electron-builder.yml: afterPack: scripts/after-pack.js
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

module.exports = async function afterPack(context) {
  const { appOutDir, packager } = context;
  const projectNode = path.join(packager.projectDir, "resources", "node");
  if (!fs.existsSync(projectNode)) {
    // 只 warn 会让「打包出来的应用里没有内置 Node」静默发版（mkdir/cp 都成功，
    // 构建照样绿灯）。宁可在这里失败。
    throw new Error("afterPack: resources/node missing — run `npm run bundle:node` first");
  }
  const appResources = resolveAppResources(appOutDir, packager);
  const dst = path.join(appResources, "node");

  await fsp.mkdir(dst, { recursive: true });
  await fsp.cp(projectNode, dst, { recursive: true, force: true });

  let files = 0;
  for await (const _file of walk(dst)) files++;
  console.log(`afterPack: bundled portable node -> ${dst} (${files} files)`);
};

/**
 * 应用自己的 resources 目录。
 *
 * macOS 是这里的坑：`appOutDir` 是 `dist/mac-arm64`，而 .app 包在**下一层**
 * （`dist/mac-arm64/<productName>.app`），所以 `appOutDir/Contents/…` 根本不存在 ——
 * 早先那样写会另建一棵树、打出来的 mac 应用里没有任何内置 Node，而且 mkdir/cp 都成功，
 * 构建日志还是「成功」。优先问 packager（electron-builder 自己知道答案），
 * 拿不到再在 appOutDir 里找 .app。
 */
function resolveAppResources(appOutDir, packager) {
  if (process.platform !== "darwin") return path.join(appOutDir, "resources");
  try {
    const dir = packager.getResourcesDir?.(appOutDir);
    if (typeof dir === "string" && dir !== "") return dir;
  } catch {
    /* 退回自己找 .app */
  }
  const bundle = fs
    .readdirSync(appOutDir, { withFileTypes: true })
    .find((entry) => entry.isDirectory() && entry.name.endsWith(".app"));
  if (!bundle) throw new Error(`afterPack: no .app bundle found under ${appOutDir}`);
  return path.join(appOutDir, bundle.name, "Contents", "Resources");
}

async function* walk(dir) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}