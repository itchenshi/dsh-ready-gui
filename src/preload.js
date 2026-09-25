"use strict";

// Preload for the settings window only — exposes a narrow, safe API for
// reading/updating the persisted settings and triggering a manual engine
// update check.
//
// The main window gets a DIFFERENT, even narrower preload (workspace-preload.js:
// setLastSession / getLastSession / restartEngine). It must never receive this
// one: the main window renders the harness page, which runs third-party plugin
// client halves, while this bridge carries plugin install/uninstall and settings
// writes.

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("dshSettings", {
  get: () => ipcRenderer.invoke("settings:get"),
  set: (patch) => ipcRenderer.invoke("settings:set", patch),
  checkUpdate: () => ipcRenderer.invoke("settings:update-check"),
  // 勾选框 = 安装状态实时镜像：勾选→立即安装，取消→立即卸载（不再持久化勾选状态）。
  installPlugin: (id) => ipcRenderer.invoke("plugins:install", id),
  uninstallPlugin: (id) => ipcRenderer.invoke("plugins:remove", id),
  // 启用/禁用开关 = 加载状态实时镜像。走的是插件市场自己的开关接口
  //（POST /dsh-market/toggle），因此在线生效时机、保护规则、restart/refresh
  // 信号都与市场页面上的那个开关一致。
  setPluginEnabled: (id, enabled) => ipcRenderer.invoke("plugins:set-enabled", id, enabled),
  // 禁用/启用带客户端半体的插件后，页面里已加载的那半需要刷新页面才与引擎一致
  //（市场的开关同样返回 refresh 并提示「刷新后生效」）。
  reloadEngineWindow: () => ipcRenderer.invoke("dsh-gui:reload-engine-window"),
  // 重试/修复按钮：以“当前已安装集合”为目标再对账（补拉捆绑插件更新，绝不卸载）。
  syncPlugins: () => ipcRenderer.invoke("settings:plugin-sync"),
  // 请求 DSH Ready GUI 重启托管的 dsh 引擎（插件安装/挂载后需重启生效）。
  restartEngine: () => ipcRenderer.invoke("settings:restart-engine"),
  // 内容高度变化时通知主进程自适应窗口高度（≤ 屏幕工作区）。
  autoSize: (height) => ipcRenderer.invoke("settings:autosize", height),
  onChanged: (callback) => {
    ipcRenderer.on("settings:changed", (_event, settings) => callback(settings));
  },
  // 安装/卸载/修复逐阶段进度（主进程推送；渲染层驱动进度条文案）。
  onPluginProgress: (callback) => {
    ipcRenderer.on("plugins:progress", (_event, progress) => callback(progress));
  },
  // 主进程在引擎页面主题变化（或外观设置变更）时推送，实时切换本窗口深浅色。
  onTheme: (callback) => {
    ipcRenderer.on("app:theme", (_event, theme) => callback(theme));
  },
});
