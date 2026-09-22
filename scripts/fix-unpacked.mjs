#!/usr/bin/env node
/**
 * fix-unpacked.mjs — rename electron-builder's unpacked output dirs to their
 * branded platform names and produce a zip archive of each program dir.
 *
 *   win-unpacked  -> DSH-READY-GUI-WIN   + dist/DSH-READY-GUI-WIN.zip
 *   mac-unpacked  -> DSH-READY-GUI-MAC   + dist/DSH-READY-GUI-MAC.zip
 *   linux-unpacked-> DSH-READY-GUI-LINUX + dist/DSH-READY-GUI-LINUX.zip
 *
 * electron-builder hardcodes the "-unpacked" suffix and offers no config for
 * it, so we rename (and archive) after the build finishes.
 *
 * Usage: node scripts/fix-unpacked.mjs [--force]   (run after electron-builder)
 *   Skips dirs that do not exist; refuses to overwrite an existing target.
 *   With --force, replaces the target dir and zip if present.
 */

import {createWriteStream, existsSync} from "node:fs";
import {mkdir, rename, rm} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {createRequire} from "node:module";
import {fileURLToPath} from "node:url";

// archiver v8 is ESM; Node's require(esm) exposes its named exports.
const require = createRequire(import.meta.url);
const { ZipArchive } = require("archiver");

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");
const FORCE = process.argv.includes("--force");

const MAPPINGS = [
  ["win-unpacked", "DSH-READY-GUI-WIN"],
  // electron-builder 从不产出 `mac-unpacked`：mac 的输出目录按架构命名（`mac` 是 x64、
  // `mac-arm64` 是 arm64、`mac-universal` 是通用包）。早先那条 `mac-unpacked` 永远匹配
  // 不到，于是 README 承诺的 dist/DSH-READY-GUI-MAC.zip 从来没被生成过，而脚本仍然退出 0。
  ["mac", "DSH-READY-GUI-MAC-x64"],
  ["mac-arm64", "DSH-READY-GUI-MAC-arm64"],
  ["mac-universal", "DSH-READY-GUI-MAC-universal"],
  ["linux-unpacked", "DSH-READY-GUI-LINUX"],
];

/** Zip `dirPath` (as top-level entry `name`) into `zipPath`. */
async function zipDir(dirPath, zipPath, name) {
  await mkdir(dirname(zipPath), { recursive: true });
  const output = createWriteStream(zipPath);
  // level 6 而不是 9：目录里大部分是已经压过的产物，9 只换来百分之几的体积、却让打包
  // 多花几分钟（win 上这个 zip 约 190 MB）。
  const archive = new ZipArchive({ zlib: { level: 6 } });
  const completion = new Promise((resolveClose, rejectClose) => {
    output.on("close", resolveClose);
    output.on("error", rejectClose);
    archive.on("error", rejectClose);
  });
  archive.pipe(output);
  archive.directory(dirPath, name);
  await archive.finalize();
  await completion;
}

async function main() {
  let changed = 0;
  for (const [from, to] of MAPPINGS) {
    const fromPath = join(DIST, from);
    const toPath = join(DIST, to);
    if (!existsSync(fromPath)) {
      console.log(`skip ${from} (absent)`);
      continue;
    }
    // --force：先把旧产物挪到一边，rename 失败再挪回来 —— 早先是「先 rm 再 rename」，
    // rename 一旦失败两份都没了。
    const parked = `${toPath}.old`;
    if (existsSync(toPath)) {
      if (!FORCE) {
        console.warn(`skip ${from}: target ${to} already exists (run with --force to replace)`);
        continue;
      }
      await rm(parked, { recursive: true, force: true });
      await rename(toPath, parked);
    }
    await mkdir(DIST, { recursive: true });
    try {
      await rename(fromPath, toPath);
    } catch (error) {
      if (existsSync(parked)) await rename(parked, toPath).catch(() => {});
      throw error;
    }
    if (existsSync(parked)) await rm(parked, { recursive: true, force: true }).catch(() => {});
    console.log(`renamed ${from} -> ${to}`);

    // Archive the program directory.
    const zipPath = join(DIST, `${to}.zip`);
    await rm(zipPath, { force: true });
    await zipDir(toPath, zipPath, to);
    console.log(`zipped ${to} -> ${zipPath}`);
    changed++;
  }
  console.log(changed === 0 ? "no unpacked dirs renamed" : `done: ${changed} dir(s) renamed + zipped`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});