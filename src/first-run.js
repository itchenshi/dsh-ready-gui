"use strict";

/**
 * 「首次启动检测 + 一键开启」的决策逻辑（纯函数，可脱离 Electron 单测）。
 *
 * 为什么需要它：GUI 随包**内置**四个插件，但插件目录的勾选框默认全部关闭
 * （见 plugin-manager.js —— 「未勾选一律不装」）。于是「下载解压打开」之后，
 * 用户面对的是一个功能齐全、但那四个修复一个都没生效的壳 —— 而设置窗口在
 * 托盘菜单里，第一次用的人根本不会去找。
 *
 * 这个模块只回答两个问题，别的什么都不做（安装由 main.js 走既有的
 * syncEnabledPlugins 路径）：
 *   1. 现在该不该主动给出「一键开启」？（第一次启动、引擎已装、还有该有的没装）
 *   2. 该装哪几个、哪几个装不了？（逐个列出，界面只显示这些）
 *
 * 三条刻意的设计：
 *   - **不含 dsh-market**：它是社区的插件市场（第三方），不属于「开箱修复」；
 *     一键开启的东西必须是我们自己随包发布、可核对源码的那四个。
 *   - **只推荐缺的**：已经装过（或用户手动装过）的不再重复列出，按钮文案按实际
 *     数量走 —— 少装一个就写「一键开启（3 个）」，不写死 4。
 *   - **用户做过决定就不再主动弹**（done=true）：无论是点了一键开启还是点了
 *     「不用了，我自己选」。设置窗口里仍然可以逐个勾选。
 */

/**
 * 内置随包的四个插件（顺序 = 设置窗口里的展示顺序）。
 *
 * 与 main.js 的 PLUGIN_CATALOG 用 id 对齐：这里只写 id，名字/描述仍由目录提供，
 * 避免同一件事在第二个地方再写一遍文案。
 */
const RECOMMENDED_PLUGIN_IDS = Object.freeze([
  "dsh-gui-last-session",
  "dsh-model-surplus",
  "dsh-gateway-models",
  "dsh-keys-setting",
]);

/**
 * @param {object} o
 * @param {boolean} o.done              用户本次（或此前）已经做过决定。
 * @param {boolean} o.engineInstalled   本地已经有引擎 —— 没有引擎时连插件装到哪都不知道。
 * @param {Array<{id: string, engineOk?: boolean}>} o.catalog 插件目录（含引擎兼容性）。
 * @param {Record<string, {installed?: boolean}>} o.status   每个条目的安装状态。
 * @returns {{offer: boolean, missing: string[], blocked: string[], installed: string[]}}
 *   missing = 该装但没装的；blocked = 与当前引擎不兼容、装了也加载不了的；
 *   installed = 已经装好的。offer 为 true 时界面才显示「首次使用」卡片。
 */
function firstRunOffer({ done, engineInstalled, catalog, status } = {}) {
  const entries = Array.isArray(catalog) ? catalog : [];
  const byId = new Map(entries.map((entry) => [entry && entry.id, entry]));
  const state = status && typeof status === "object" ? status : {};
  const installed = [];
  const missing = [];
  const blocked = [];
  for (const id of RECOMMENDED_PLUGIN_IDS) {
    const entry = byId.get(id);
    // 目录里没有这个 id（改名/裁剪构建）：既不推荐也不报错 —— 推荐列表要能自己收敛。
    if (!entry) continue;
    if (entry.engineOk === false) {
      blocked.push(id);
      continue;
    }
    const st = state[id];
    if (st && st.installed) installed.push(id);
    else missing.push(id);
  }
  const offer = done !== true && engineInstalled === true && missing.length > 0;
  return { offer, missing, blocked, installed };
}

module.exports = {
  RECOMMENDED_PLUGIN_IDS,
  firstRunOffer,
};