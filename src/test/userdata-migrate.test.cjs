"use strict";

/**
 * userdata-migrate.test.cjs — 改名带来的 userData 目录迁移。
 *
 * 这个迁移保护的是「引擎 + 数据目录 + 设置 + 会话」不因改名而看起来像全新安装，
 * 所以每条失败路径都要有断言：绝不抛、绝不删、幂等、不覆盖新目录已有的东西。
 *
 * 跑法：node src/test/userdata-migrate.test.cjs
 */

const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { migrateLegacyUserData, LEGACY_APP_DIR_NAME, MIGRATION_MARKER } = require("../userdata-migrate");

let passed = 0;
const ok = (label) => {
  passed += 1;
  console.log("  ok -", label);
};

/** 造一个假的 appData：<root>/<legacyName>/{...entries} 与一个空的 <root>/<newName>。 */
function makeTree({ entries = {}, legacyName = LEGACY_APP_DIR_NAME, newName = "DSH Ready GUI", withNewDir = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-udm-"));
  const legacyDir = path.join(root, legacyName);
  const currentDir = path.join(root, newName);
  fs.mkdirSync(legacyDir, { recursive: true });
  if (withNewDir) fs.mkdirSync(currentDir, { recursive: true });
  for (const [name, content] of Object.entries(entries)) {
    const p = path.join(legacyDir, name);
    if (content === null) fs.mkdirSync(p, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, content);
    }
  }
  return { root, legacyDir, currentDir };
}

const cleanup = (root) => {
  try {
    fs.rmSync(root, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
};

// --- 1. 回归守卫：旧目录名必须是改名前的那个 ------------------------------
// 这条断言存在的唯一理由：一次批量改名曾把 "DSH GUI" 也替换成新名，使 legacy 与
// current 变成同一个目录、迁移静默失效。名字写错 = 迁移等于不存在。
assert.equal(LEGACY_APP_DIR_NAME, "DSH GUI", "LEGACY_APP_DIR_NAME must stay the pre-rename name");
ok("LEGACY_APP_DIR_NAME 仍是改名前的名字（批量改名改不动它）");

// --- 2. 正常迁移 ----------------------------------------------------------
{
  const t = makeTree({
    entries: { "settings.json": '{"updatePolicy":"ask"}', "dsh-home": null, "dsh-engine": null },
  });
  try {
    const res = migrateLegacyUserData({ appDataDir: t.root, currentDir: t.currentDir });
    assert.equal(res.error, null, "no error");
    assert.deepStrictEqual(res.moved.sort(), ["dsh-engine", "dsh-home", "settings.json"]);
    assert.ok(fs.existsSync(path.join(t.currentDir, "settings.json")), "settings.json moved");
    assert.ok(fs.existsSync(path.join(t.currentDir, "dsh-home")), "dsh-home moved");
    assert.equal(
      fs.readFileSync(path.join(t.currentDir, "settings.json"), "utf8"),
      '{"updatePolicy":"ask"}',
      "content preserved",
    );
    assert.ok(fs.existsSync(path.join(t.currentDir, MIGRATION_MARKER)), "marker written");
    // 绝不删除：旧目录本身留着（可能还有搬不动的条目）。
    assert.ok(fs.existsSync(t.legacyDir), "the legacy directory is never removed");
    ok("把 settings.json / dsh-home / dsh-engine 搬进新目录，内容不变，并留下记录文件");
  } finally {
    cleanup(t.root);
  }
}

// --- 3. 幂等 --------------------------------------------------------------
{
  const t = makeTree({ entries: { "settings.json": "{}" } });
  try {
    const first = migrateLegacyUserData({ appDataDir: t.root, currentDir: t.currentDir });
    const second = migrateLegacyUserData({ appDataDir: t.root, currentDir: t.currentDir });
    assert.deepStrictEqual(first.moved, ["settings.json"]);
    assert.deepStrictEqual(second.moved, [], "second run moves nothing");
    ok("第二次运行什么都不搬（幂等）");
  } finally {
    cleanup(t.root);
  }
}

// --- 4. 不覆盖新目录已有的条目 --------------------------------------------
{
  const t = makeTree({ entries: { "settings.json": "OLD", "dsh-home": null } });
  try {
    fs.writeFileSync(path.join(t.currentDir, "settings.json"), "NEW");
    const res = migrateLegacyUserData({ appDataDir: t.root, currentDir: t.currentDir });
    assert.deepStrictEqual(res.moved, ["dsh-home"], "only the missing entry moves");
    assert.deepStrictEqual(res.skipped, ["settings.json"]);
    assert.equal(fs.readFileSync(path.join(t.currentDir, "settings.json"), "utf8"), "NEW", "new file wins");
    assert.equal(fs.readFileSync(path.join(t.legacyDir, "settings.json"), "utf8"), "OLD", "old file left in place");
    ok("新目录已有的条目跳过，不覆盖也不删除旧的那份");
  } finally {
    cleanup(t.root);
  }
}

// --- 5. 旧目录不存在 / 新旧同一目录 / 参数缺失：都不抛 ---------------------
{
  const t = makeTree({ entries: {} });
  try {
    const missing = migrateLegacyUserData({ appDataDir: t.root, currentDir: path.join(t.root, "nope") });
    assert.deepStrictEqual(missing.moved, [], "absent legacy dir -> nothing moved");
    assert.equal(missing.error, null);

    const same = migrateLegacyUserData({ appDataDir: t.root, currentDir: t.legacyDir });
    assert.deepStrictEqual(same.moved, [], "legacy === current -> no-op");

    const bad = migrateLegacyUserData({ appDataDir: "", currentDir: "" });
    assert.ok(typeof bad.error === "string" && bad.error !== "", "missing args are reported, not thrown");
    ok("旧目录不存在 / 新旧同一目录 / 参数缺失，一律不抛");
  } finally {
    cleanup(t.root);
  }
}

// --- 6. 单个条目搬不动时，其余照搬 ----------------------------------------
{
  const t = makeTree({ entries: { "a.json": "A", "locked.json": "L", "b.json": "B" } });
  try {
    const fsImpl = Object.create(fs);
    fsImpl.renameSync = (from, to) => {
      if (String(from).includes("locked.json")) {
        const error = new Error("EBUSY: resource busy or locked");
        error.code = "EBUSY";
        throw error;
      }
      return fs.renameSync(from, to);
    };
    const res = migrateLegacyUserData({ appDataDir: t.root, currentDir: t.currentDir, fsImpl });
    assert.deepStrictEqual(res.moved.sort(), ["a.json", "b.json"]);
    assert.deepStrictEqual(res.skipped, ["locked.json"]);
    assert.ok(fs.existsSync(path.join(t.legacyDir, "locked.json")), "the locked file is left where it was");
    ok("一个条目被占用时跳过它，其余照常搬（不半途而废）");
  } finally {
    cleanup(t.root);
  }
}

// --- 7. 整个迁移炸了也不能抛 ----------------------------------------------
{
  const t = makeTree({ entries: { "settings.json": "{}" } });
  try {
    const fsImpl = Object.create(fs);
    fsImpl.existsSync = () => {
      throw new Error("boom");
    };
    const res = migrateLegacyUserData({ appDataDir: t.root, currentDir: t.currentDir, fsImpl });
    assert.ok(typeof res.error === "string" && res.error.includes("boom"), "the failure is reported");
    assert.deepStrictEqual(res.moved, []);
    ok("迁移内部抛错时被吞掉并上报，应用照常启动");
  } finally {
    cleanup(t.root);
  }
}

console.log(`\nuserdata-migrate: ${passed} checks passed`);
