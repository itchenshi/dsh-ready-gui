"use strict";

// Preload for the MAIN (embedded harness) window — exposes the bridge the engine's
// "reopen last conversation" patch and GUI-managed engine restart use:
//   window.__dshGui = { setLastSession, getLastSession, restartEngine }
// Recording/reading happens in the main process (userData/last-session.json);
// restartEngine asks the DSH Ready GUI main process to kill + respawn the dsh engine
// (the dsh page itself cannot restart the GUI-hosted engine process).

const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("__dshGui", {
  setLastSession: (sessionId) => ipcRenderer.invoke("dsh-gui:set-last-session", sessionId),
  getLastSession: () => ipcRenderer.invoke("dsh-gui:get-last-session"),
  // 重启 GUI 托管的 dsh 引擎（重启后重新加载 profile，插件变更在此生效）。
  restartEngine: () => ipcRenderer.invoke("dsh-gui:restart-engine"),
});
