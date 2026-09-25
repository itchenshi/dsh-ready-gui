#!/usr/bin/env node
/**
 * ensure-electron.mjs — 把当前 electron 版本的发行 zip 固定到本地缓存
 * (<project>/resources/.electron-cache/dist.zip)，让 electron-builder 每次
 * win 打包都走 `-c.electronDist` 的本地 zip，彻底不再联网下载
 * electron-v<version>-win32-x64.zip / SHASUMS256.txt。
 *
 * 幂等：
 *   1. 缓存存在且 .info {version, platform, arch, sha256} 与目标一致、文件哈希
 *      校验通过 → 直接跳过（零下载）；
 *   2. 不一致/缺失/损坏 → 从镜像重新下载并用官方 SHASUMS256.txt 校验后落盘；
 *   3. --force / DSH_ELECTRON_REFRESH=1 → 忽略缓存强制重下。
 *
 * Env:
 *   DSH_ELECTRON_VERSION   覆盖版本（默认读 node_modules/electron/package.json）
 *   DSH_ELECTRON_PLATFORM / DSH_ELECTRON_ARCH   交叉打包其它平台（默认宿主机）
 *   DSH_ELECTRON_MIRROR    镜像（默认 https://npmmirror.com/mirrors/electron/；
 *                          可选 https://github.com/electron/electron/releases/download/）
 */

import {existsSync} from "node:fs";
import {mkdir, readFile, readdir, rename, rm, stat, writeFile} from "node:fs/promises";
import {dirname, join, resolve} from "node:path";
import {fileURLToPath} from "node:url";
import {randomBytes} from "node:crypto";
import {download, sha256Of} from "./lib/download.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CACHE_DIR = join(ROOT, "resources", ".electron-cache");
const DIST_ZIP = join(CACHE_DIR, "dist.zip");
const DIST_INFO = join(CACHE_DIR, "dist.info");
// 下载临时名带 pid + 随机段：固定名在两个构建并行跑（CI 矩阵 / 本地同时开两条命令）时
// 会互相覆盖，最后 rename 出来的 zip 可能是两者拼起来的字节。与补丁层 / 清单写入同一条规则。
const TMP = join(CACHE_DIR, `.tmp-download.${process.pid}.${randomBytes(4).toString("hex")}.zip`);
const FORCE = process.argv.includes("--force") || process.env.DSH_ELECTRON_REFRESH === "1";

// 平台/架构命名与 electron 发行版一致：win32-x64 / darwin-arm64 / linux-x64 …
const PLATFORM = process.env.DSH_ELECTRON_PLATFORM || process.platform;
const ARCH = process.env.DSH_ELECTRON_ARCH || process.arch;
/** electron 44+ 不再发布 ia32；遇到旧 32 位命名直接失败。 */
const ARCH_NAME = ARCH === "x64" || ARCH === "arm64" ? ARCH : null;
if (!ARCH_NAME) {
  console.error(`unsupported electron arch: ${ARCH}`);
  process.exit(1);
}

const VERSION =
  process.env.DSH_ELECTRON_VERSION ||
  JSON.parse(await readFile(join(ROOT, "node_modules", "electron", "package.json"), "utf8")).version;
const MIRROR = (
  process.env.DSH_ELECTRON_MIRROR || "https://npmmirror.com/mirrors/electron/"
).replace(/\/+$/, "");

const FILE_NAME = `electron-v${VERSION}-${PLATFORM}-${ARCH_NAME}.zip`;
const URL = `${MIRROR}/v${VERSION}/${FILE_NAME}`;
const TAG = `${VERSION} ${PLATFORM}-${ARCH_NAME}`;

/** 官方 SHASUMS256.txt 里该文件行的哈希（失败返回 null，不阻断下载后的自校验）。 */
async function officialSha256() {
  try {
    const res = await fetch(`${MIRROR}/v${VERSION}/SHASUMS256.txt`);
    if (!res.ok) return null;
    const text = await res.text();
    const line = text.split(/\r?\n/u).find((l) => l.trim().endsWith(`*${FILE_NAME}`));
    if (!line) return null;
    return line.trim().split(/\s+/u)[0];
  } catch {
    return null;
  }
}

/** 本地缓存是否就是目标版本/平台且哈希自校验通过。 */
async function isCacheUsable() {
  if (!existsSync(DIST_ZIP) || !existsSync(DIST_INFO)) return false;
  try {
    const info = JSON.parse(await readFile(DIST_INFO, "utf8"));
    if (info.version !== VERSION || info.platform !== PLATFORM || info.arch !== ARCH_NAME) return false;
    const actual = await sha256Of(DIST_ZIP);
    if (actual === info.sha256) return true;
    console.warn("cached electron zip hash mismatch — re-downloading");
    return false;
  } catch {
    return false;
  }
}

async function refreshCache() {
  await mkdir(CACHE_DIR, { recursive: true });
  await download(URL, TMP);
  const actual = await sha256Of(TMP);
  const official = await officialSha256();
  if (official && official !== actual) {
    await rm(TMP, { force: true }).catch(() => {});
    throw new Error(`SHA-256 mismatch for ${FILE_NAME} (official ${official}, got ${actual})`);
  }
  if (!official) console.warn("SHASUMS256.txt unavailable — keeping self-computed sha256");
  await rename(TMP, DIST_ZIP);
  await writeFile(
    DIST_INFO,
    JSON.stringify({ version: VERSION, platform: PLATFORM, arch: ARCH_NAME, sha256: actual, url: URL }, null, 2),
  );
  console.log(`cached electron ${TAG} -> ${DIST_ZIP} (${Math.round((await stat(DIST_ZIP)).size / 1024 / 1024)} MiB)`);
}

async function main() {
  if (!FORCE && (await isCacheUsable())) {
    console.log(`electron ${TAG} already cached — skipping download`);
    return;
  }
  if (FORCE) console.log("--force / DSH_ELECTRON_REFRESH: ignoring cache, re-downloading");
  await refreshCache();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});