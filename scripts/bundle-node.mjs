#!/usr/bin/env node
/**
 * bundle-node.mjs — ensure a portable Node.js runtime for the CURRENT platform
 * is unpacked into <project>/resources/node so electron-builder can ship it
 * via extraResources (the dsh engine runs with this bundled node, keeping the
 * native-module ABI consistent with what npm installed).
 *
 * Layout after extraction:
 *   Windows: resources/node/node.exe  +  resources/node/node_modules/...
 *   macOS/Linux: resources/node/bin/node  +  resources/node/lib/node_modules/...
 *
 * 不再每次全量下载：
 *   1. 幂等跳过 —— resources/node 已就位且 version.txt 与目标版本/平台一致时
 *      直接跳过（重复打包不再下载/解压 100+ MiB）；
 *   2. 压缩包缓存 —— 下载过的归档存到 resources/.node-cache/（旁边存 SHA-256
 *      sidecar 自校验，损坏/被改则自动重下），换镜像源也能复用；
 *   3. --force / DSH_NODE_REFRESH=1 —— 强制忽略以上缓存，重新下载并解压。
 *
 * Env overrides:
 *   DSH_NODE_VERSION   e.g. "26.0.0" (default: v26 — see below)
 *   DSH_NODE_MIRROR    e.g. "https://npmmirror.com/mirrors/node/" (default: https://nodejs.org/dist)
 *   DSH_NODE_PLATFORM / DSH_NODE_ARCH   cross-bundle another platform/arch
 */

import {execFileSync} from "node:child_process";
import {existsSync} from "node:fs";
import {mkdir, readFile, readdir, rename, rm, stat, writeFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {download, sha256Of} from "./lib/download.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = join(ROOT, "resources", "node");
const CACHE_DIR = join(ROOT, "resources", ".node-cache");

// The engine currently depends on Node >= 23's zstd API (node:zlib
// createZstdDecompress / zstdCompress). LTS v22 lacks it, so default to a
// recent stable that ships it; override with DSH_NODE_VERSION.
const NODE_VERSION = process.env.DSH_NODE_VERSION || "26.0.0";
const MIRROR = (process.env.DSH_NODE_MIRROR || "https://nodejs.org/dist").replace(/\/+$/, "");

const MATRIX = {
  "win32-x64": { os: "win", arch: "x64", ext: "zip" },
  "darwin-arm64": { os: "darwin", arch: "arm64", ext: "tar.gz" },
  "darwin-x64": { os: "darwin", arch: "x64", ext: "tar.gz" },
  "linux-x64": { os: "linux", arch: "x64", ext: "tar.gz" },
  "linux-arm64": { os: "linux", arch: "arm64", ext: "tar.gz" },
};
const NODE_PLATFORM = process.env.DSH_NODE_PLATFORM || process.platform;
const NODE_ARCH = process.env.DSH_NODE_ARCH || process.arch;
const KEY = `${NODE_PLATFORM}-${NODE_ARCH}`;
const entry = MATRIX[KEY];
if (!entry) {
  console.error(`unsupported platform: ${KEY}`);
  process.exit(1);
}

const BASE = `node-v${NODE_VERSION}-${entry.os}-${entry.arch}`;
const URL = `${MIRROR}/v${NODE_VERSION}/${BASE}.${entry.ext}`;
const TMP = join(ROOT, "resources", `.node-tmp-${BASE}`);
const FORCE = process.argv.includes("--force") || process.env.DSH_NODE_REFRESH === "1";

const CACHE_ARCHIVE = join(CACHE_DIR, `${BASE}.${entry.ext}`);
const CACHE_HASH = `${CACHE_ARCHIVE}.sha256`;
const VERSION_TAG = `v${NODE_VERSION} ${KEY}`;

/** 已就位的 bundled node 是否就是目标版本+平台（幂等跳过的主要依据）。 */
async function isBundleUpToDate() {
  if (!existsSync(join(OUT_DIR, "node.exe")) && !existsSync(join(OUT_DIR, "bin", "node"))) return false;
  try {
    const tag = (await readFile(join(OUT_DIR, "version.txt"), "utf8")).trim();
    // 旧版只写 "v26.0.0"（无平台后缀）：重建一次以补全标记。
    return tag === VERSION_TAG;
  } catch {
    return false;
  }
}

/** 缓存里是否有校验通过的归档（sidecar SHA-256 自校验，损坏自动作废）。 */
async function cachedArchiveUsable() {
  if (!existsSync(CACHE_ARCHIVE) || !existsSync(CACHE_HASH)) return false;
  try {
    const expected = (await readFile(CACHE_HASH, "utf8")).trim().split(/\s+/)[0];
    const actual = await sha256Of(CACHE_ARCHIVE);
    if (actual === expected) return true;
    console.warn("cached node archive hash mismatch — re-downloading");
    await rm(CACHE_ARCHIVE, { force: true }).catch(() => {});
    await rm(CACHE_HASH, { force: true }).catch(() => {});
    return false;
  } catch {
    return false;
  }
}

async function ensureArchive() {
  if (!FORCE && (await cachedArchiveUsable())) {
    console.log(`using cached archive ${CACHE_ARCHIVE} (sha256 verified)`);
    return CACHE_ARCHIVE;
  }
  await mkdir(CACHE_DIR, { recursive: true });
  await mkdir(TMP, { recursive: true });
  const tmpArchive = join(TMP, `${BASE}.${entry.ext}`);
  await download(URL, tmpArchive);
  const hash = await sha256Of(tmpArchive);
  await rename(tmpArchive, CACHE_ARCHIVE);
  await writeFile(CACHE_HASH, `${hash}  ${BASE}.${entry.ext}\n`);
  console.log(`cached archive -> ${CACHE_ARCHIVE}`);
  return CACHE_ARCHIVE;
}

async function extractArchive(archive) {
  await rm(OUT_DIR, { recursive: true, force: true });
  await rm(TMP, { recursive: true, force: true });
  await mkdir(TMP, { recursive: true });

  // tar.exe (bsdtar) on Windows and system tar on macOS/Linux both handle zip and tar.gz.
  execFileSync("tar", ["-xf", archive, "-C", TMP], { stdio: "inherit" });

  const extracted = join(TMP, BASE);
  if (!existsSync(extracted)) throw new Error(`unexpected archive layout: ${BASE} missing`);

  await mkdir(OUT_DIR, { recursive: true });
  execFileSync(
    process.platform === "win32" ? "xcopy" : "cp",
    process.platform === "win32"
      ? [extracted, OUT_DIR, "/E", "/I", "/Y", "/Q"]
      : ["-R", `${extracted}/.`, OUT_DIR],
    { stdio: "ignore" },
  );

  const executable =
    process.platform === "win32"
      ? join(OUT_DIR, "node.exe")
      : join(OUT_DIR, "bin", "node");
  if (!existsSync(executable)) throw new Error(`node executable missing: ${executable}`);

  const version = execFileSync(executable, ["--version"], { encoding: "utf8" }).trim();
  await writeFile(join(OUT_DIR, "version.txt"), `${VERSION_TAG}\n`);

  // Recursive size of the bundled runtime (stat on the dir itself is not recursive).
  let sizeBytes = 0;
  for await (const file of walkFiles(OUT_DIR)) sizeBytes += (await stat(file)).size;

  await rm(TMP, { recursive: true, force: true });
  console.log(`bundled node ${version} [${KEY}] -> ${OUT_DIR} (${(sizeBytes / 1024 / 1024).toFixed(1)} MiB)`);
}

async function main() {
  await mkdir(dirname(OUT_DIR), { recursive: true });

  if (!FORCE && (await isBundleUpToDate())) {
    console.log(`bundled node ${VERSION_TAG} already up to date — skipping download/unpack`);
    return;
  }
  if (FORCE) console.log("--force / DSH_NODE_REFRESH: ignoring caches, re-downloading");

  const archive = await ensureArchive();
  await extractArchive(archive);
}

/** Yield every file path under a directory. */
async function* walkFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walkFiles(full);
    else yield full;
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});