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
  ["mac-unpacked", "DSH-READY-GUI-MAC"],
  ["linux-unpacked", "DSH-READY-GUI-LINUX"],
];

/** Zip `dirPath` (as top-level entry `name`) into `zipPath`. */
async function zipDir(dirPath, zipPath, name) {
  await mkdir(dirname(zipPath), { recursive: true });
  const output = createWriteStream(zipPath);
  const archive = new ZipArchive({ zlib: { level: 9 } });
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
    if (existsSync(toPath)) {
      if (!FORCE) {
        console.warn(`skip ${from}: target ${to} already exists (run with --force to replace)`);
        continue;
      }
      await rm(toPath, { recursive: true, force: true });
    }
    await mkdir(DIST, { recursive: true });
    await rename(fromPath, toPath);
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