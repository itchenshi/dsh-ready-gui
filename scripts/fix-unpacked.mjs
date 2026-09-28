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
import {mkdir, open, rename, rm, stat} from "node:fs/promises";
import {randomBytes} from "node:crypto";
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

/**
 * 归档目录必须**可失败而不留半成品**：
 *   - 目标 zip 在打包开始前**绝不能**先删（原实现先 `rm(zipPath)` 再打包，打包一失败，
 *     上一次的好产物就没了，而脚本还会把 dist/ 交给发布流程）；
 *   - 先写进程唯一的临时名，写完**校验**它真的是一份完整 zip，再原子换入；
 *   - 校验不看体积猜，而是读中央目录结束记录（EOCD）—— 截断的 zip 一定没有它。
 */
async function zipDirSafely(dirPath, zipPath, name) {
  const tmp = `${zipPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    await zipDir(dirPath, tmp, name);
    const size = (await stat(tmp)).size;
    if (size < 22) throw new Error(`archive is empty/truncated (${size} bytes)`);
    const fh = await open(tmp, "r");
    try {
      const tail = Buffer.alloc(22);
      await fh.read(tail, 0, 22, size - 22);
      if (tail.readUInt32LE(0) !== 0x06054b50) {
        throw new Error("zip end-of-central-directory record missing (truncated archive)");
      }
    } finally {
      await fh.close();
    }
    // 原子换入：目标已存在时 Node 的 rename 会覆盖它（Windows 上是 MOVEFILE_REPLACE_EXISTING）。
    await rename(tmp, zipPath);
    return size;
  } finally {
    await rm(tmp, { force: true }).catch(() => {});
  }
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
    let parkedOld = false;
    if (existsSync(toPath)) {
      if (!FORCE) {
        console.warn(`skip ${from}: target ${to} already exists (run with --force to replace)`);
        continue;
      }
      await rm(parked, { recursive: true, force: true });
      await rename(toPath, parked);
      parkedOld = true;
    }
    await mkdir(DIST, { recursive: true });
    try {
      await rename(fromPath, toPath);
    } catch (error) {
      if (parkedOld) await rename(parked, toPath).catch(() => {});
      throw error;
    }
    console.log(`renamed ${from} -> ${to}`);

    // 归档必须**在**丢掉 parked 之前完成：packed 目录是上一份产物的唯一副本，而 zip 是
    // 这一次的新产物。打包失败就把旧目录挪回来，别让「这次打包失败」变成「两份都没了」。
    const zipPath = join(DIST, `${to}.zip`);
    try {
      const size = await zipDirSafely(toPath, zipPath, to);
      console.log(`zipped ${to} -> ${zipPath} (${(size / 1024 / 1024).toFixed(1)} MiB)`);
    } catch (error) {
      if (parkedOld) {
        await rm(toPath, { recursive: true, force: true }).catch(() => {});
        await rename(parked, toPath).catch(() => {});
        parkedOld = false;
        console.error(`zip failed for ${to}; restored the previous ${to} directory`);
      }
      throw error;
    }
    if (parkedOld) await rm(parked, { recursive: true, force: true }).catch(() => {});
    changed++;
  }
  console.log(changed === 0 ? "no unpacked dirs renamed" : `done: ${changed} dir(s) renamed + zipped`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});