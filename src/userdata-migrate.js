"use strict";

/**
 * userdata-migrate.js — 改名带来的 userData 目录一次性迁移。
 *
 * Electron 的 userData 目录由 productName 推导（`app.getPath("userData")`），所以
 * 把应用从「DSH GUI」改名为「DSH Ready GUI」会把目录从 `<appData>\DSH GUI` 换成
 * `<appData>\DSH Ready GUI` —— 而**引擎、dsh-home、settings.json、pnpm-tools 全在
 * 旧目录里**。不迁移的话，已有安装会看起来像全新安装：重新下载引擎（数百 MB）、丢掉
 * 模型配置与会话历史。
 *
 * 纯 Node、不依赖 Electron，因此可以单测（与 home-migrate.js 同样的做法）。
 */

/**
 * 改名**前**的应用目录名。
 *
 * ⚠️ **必须保持旧名，不要跟着应用改名而改。** 它对应磁盘上真实存在的目录；写成新名
 * 会让 legacy 与 current 变成同一个目录，迁移静默失效（曾经被一次批量改名误伤过，
 * 单测里有一条断言专门守住它）。
 */
const LEGACY_APP_DIR_NAME = "DSH GUI";

/** 迁移完成后写进新目录的记录文件名（便于排查）。 */
const MIGRATION_MARKER = "legacy-userdata-migrated.txt";

/**
 * 把旧目录里「新目录还没有」的条目搬到新目录。
 *
 * - **幂等**：再次运行（或新旧目录本来就并存）时目标已存在，该条目跳过。
 * - **绝不删除**：只做 rename，不 unlink；搬不动的条目留在原处并计入 skipped。
 * - **绝不抛**：迁移失败不能让应用起不来——最坏情况是当作全新安装。
 *
 * @param {object} o
 * @param {string} o.appDataDir  平台的应用数据根目录（Windows 上是 `%APPDATA%`）
 * @param {string} o.currentDir  本次启动实际使用的 userData 目录
 * @param {string} [o.legacyName] 旧目录名，默认 {@link LEGACY_APP_DIR_NAME}
 * @param {object} [o.fsImpl]    注入的文件系统（测试用）
 * @param {Function} [o.log]
 * @returns {{moved:string[], skipped:string[], legacyDir:string, currentDir:string, marker:string|null, error:string|null}}
 */
function migrateLegacyUserData({
  appDataDir,
  currentDir,
  legacyName = LEGACY_APP_DIR_NAME,
  fsImpl = require("node:fs"),
  pathImpl = require("node:path"),
  log = () => {},
} = {}) {
  const result = { moved: [], skipped: [], legacyDir: null, currentDir: currentDir ?? null, marker: null, error: null };
  try {
    if (typeof appDataDir !== "string" || appDataDir === "" || typeof currentDir !== "string" || currentDir === "") {
      result.error = "appDataDir and currentDir are required";
      return result;
    }
    const legacyDir = pathImpl.join(appDataDir, legacyName);
    result.legacyDir = legacyDir;
    // 同一个目录（或 legacyName 被误改成新名）→ 无事可做。
    if (pathImpl.resolve(legacyDir) === pathImpl.resolve(currentDir)) return result;
    if (!fsImpl.existsSync(legacyDir)) return result;

    fsImpl.mkdirSync(currentDir, { recursive: true });
    for (const name of fsImpl.readdirSync(legacyDir)) {
      const from = pathImpl.join(legacyDir, name);
      const to = pathImpl.join(currentDir, name);
      if (fsImpl.existsSync(to)) {
        result.skipped.push(name);
        continue;
      }
      try {
        fsImpl.renameSync(from, to);
        result.moved.push(name);
      } catch (error) {
        // 单个条目搬不动（被占用、跨卷等）就跳过，不影响其余条目。
        result.skipped.push(name);
        log("legacy userData entry could not be moved:", name, (error && error.message) || error);
      }
    }
    if (result.moved.length > 0) {
      const marker = pathImpl.join(currentDir, MIGRATION_MARKER);
      try {
        fsImpl.writeFileSync(
          marker,
          `migrated from ${legacyDir} at ${new Date().toISOString()}\n${result.moved.join("\n")}\n`,
        );
        result.marker = marker;
      } catch {
        /* 迁移本身已经成功，记录写不下不影响 */
      }
    }
    return result;
  } catch (error) {
    // 迁移失败绝不能让应用起不来：最坏情况是当作全新安装（引擎会重新下载）。
    result.error = (error && error.message) || String(error);
    log("legacy userData migration failed:", result.error);
    return result;
  }
}

module.exports = { migrateLegacyUserData, LEGACY_APP_DIR_NAME, MIGRATION_MARKER };
