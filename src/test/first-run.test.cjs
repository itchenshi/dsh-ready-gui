"use strict";

/**
 * 单元测试：src/first-run.js
 * 运行：node src/test/first-run.test.cjs
 *
 * 这个模块决定「要不要在首次启动时主动给出『一键开启』」，以及列出该装/装不了的
 * 条目。它错在两边的代价都不小：
 *   - 该弹不弹 → 内置插件默认关闭这件事就没人告诉用户，文案上的「开箱可用」是假的；
 *   - 不该弹却弹 → 每次启动都弹一个模态窗口，变成一个关不掉的推销。
 * 所以这里把边界逐条钉住（已决定 / 引擎缺失 / 部分已装 / 不兼容 / 目录缺条目）。
 */

const assert = require("assert");
const path = require("path");
const { RECOMMENDED_PLUGIN_IDS, firstRunOffer } = require(path.join(__dirname, "..", "first-run.js"));

let checks = 0;
function ok(name, fn) {
  fn();
  checks += 1;
  console.log("  ok - " + name);
}

console.log("first-run:");

/** 与 main.js 的 PLUGIN_CATALOG 同形的最小目录（外加一个不该被推荐的 dsh-market）。 */
function catalog(engineOk = {}) {
  return [
    { id: "dsh-market", engineOk: engineOk["dsh-market"] !== false },
    ...RECOMMENDED_PLUGIN_IDS.map((id) => ({ id, engineOk: engineOk[id] !== false })),
  ];
}

/** status：给定的 id 视为已装，其余未装。 */
function status(installedIds = []) {
  const out = {};
  for (const id of installedIds) out[id] = { installed: true };
  return out;
}

ok("首次启动（未决定 + 引擎已装 + 一个都没装）→ 给出 4 个", () => {
  const r = firstRunOffer({ done: false, engineInstalled: true, catalog: catalog(), status: status() });
  assert.strictEqual(r.offer, true);
  assert.deepStrictEqual(r.missing, [...RECOMMENDED_PLUGIN_IDS]);
  assert.deepStrictEqual(r.installed, []);
  assert.deepStrictEqual(r.blocked, []);
});

ok("dsh-market 不在推荐集合里（社区市场不属于开箱修复）", () => {
  const r = firstRunOffer({ done: false, engineInstalled: true, catalog: catalog(), status: status() });
  assert.ok(!r.missing.includes("dsh-market"));
  assert.deepStrictEqual(RECOMMENDED_PLUGIN_IDS, [
    "dsh-gui-last-session",
    "dsh-model-surplus",
    "dsh-gateway-models",
    "dsh-keys-setting",
  ]);
});

ok("用户已经做过决定（点过一键开启 / 点过「不用了」）→ 不再主动弹", () => {
  const r = firstRunOffer({ done: true, engineInstalled: true, catalog: catalog(), status: status() });
  assert.strictEqual(r.offer, false);
  // 仍然如实报出缺哪些：设置窗口的卡片可以据此隐藏，别有别的副作用。
  assert.deepStrictEqual(r.missing, [...RECOMMENDED_PLUGIN_IDS]);
});

ok("引擎还没装 → 不弹（装插件要先有引擎）", () => {
  const r = firstRunOffer({ done: false, engineInstalled: false, catalog: catalog(), status: status() });
  assert.strictEqual(r.offer, false);
});

ok("四个都装好了 → 不弹", () => {
  const r = firstRunOffer({
    done: false,
    engineInstalled: true,
    catalog: catalog(),
    status: status([...RECOMMENDED_PLUGIN_IDS]),
  });
  assert.strictEqual(r.offer, false);
  assert.deepStrictEqual(r.missing, []);
  assert.deepStrictEqual(r.installed, [...RECOMMENDED_PLUGIN_IDS]);
});

ok("只装了一部分 → 只列出缺的那些（按钮文案按实际数量走）", () => {
  const r = firstRunOffer({
    done: false,
    engineInstalled: true,
    catalog: catalog(),
    status: status(["dsh-model-surplus"]),
  });
  assert.strictEqual(r.offer, true);
  assert.deepStrictEqual(r.missing, ["dsh-gui-last-session", "dsh-gateway-models", "dsh-keys-setting"]);
  assert.deepStrictEqual(r.installed, ["dsh-model-surplus"]);
});

ok("与当前引擎不兼容的条目算 blocked，不算 missing（装了也加载不了）", () => {
  const r = firstRunOffer({
    done: false,
    engineInstalled: true,
    catalog: catalog({ "dsh-keys-setting": false }),
    status: status(),
  });
  assert.strictEqual(r.offer, true);
  assert.deepStrictEqual(r.blocked, ["dsh-keys-setting"]);
  assert.ok(!r.missing.includes("dsh-keys-setting"));
  assert.strictEqual(r.missing.length, 3);
});

ok("全部不兼容 → 没有可装的，不弹（弹出来也没有动作可做）", () => {
  const allBlocked = Object.fromEntries(RECOMMENDED_PLUGIN_IDS.map((id) => [id, false]));
  const r = firstRunOffer({ done: false, engineInstalled: true, catalog: catalog(allBlocked), status: status() });
  assert.strictEqual(r.offer, false);
  assert.deepStrictEqual(r.missing, []);
  assert.strictEqual(r.blocked.length, 4);
});

ok("目录里没有该 id（裁剪构建 / 改名）→ 忽略它，其余照常，不抛异常", () => {
  const r = firstRunOffer({
    done: false,
    engineInstalled: true,
    catalog: [{ id: "dsh-model-surplus", engineOk: true }],
    status: status(),
  });
  assert.strictEqual(r.offer, true);
  assert.deepStrictEqual(r.missing, ["dsh-model-surplus"]);
});

ok("status 里只有登记、没有 installed 标记（半残状态）→ 仍算该装", () => {
  const r = firstRunOffer({
    done: false,
    engineInstalled: true,
    catalog: catalog(),
    status: { "dsh-model-surplus": { bundle: true, present: false, installed: false } },
  });
  assert.ok(r.missing.includes("dsh-model-surplus"));
});

ok("输入缺失 / 类型不对不抛异常", () => {
  assert.strictEqual(firstRunOffer().offer, false);
  assert.strictEqual(firstRunOffer({}).offer, false);
  assert.strictEqual(firstRunOffer({ done: false, engineInstalled: true }).offer, false);
  assert.strictEqual(firstRunOffer({ done: false, engineInstalled: true, catalog: null, status: null }).offer, false);
});

console.log("\nfirst-run: " + checks + " checks passed");