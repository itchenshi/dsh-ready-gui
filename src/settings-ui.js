"use strict";

/**
 * Parsing / rewriting helpers for the engine UI settings file
 * (<DSH_HOME>/settings.yaml, keys `ui-theme.preference` and
 * `locale.preference`). Kept side-effect free so the GUI's two-way
 * theme/language sync can be unit-tested without an Electron runtime.
 *
 * The engine's dsh-settings-file service watches this file and hot-publishes
 * changes, so whatever the GUI (or the Harness page itself) writes here is
 * applied to the embedded UI immediately.
 */

const YAML = require("yaml");

/**
 * GUI 外观模式（settings.json 的 `appearance`）：
 *  - engine: 跟随引擎（<DSH_HOME>/settings.yaml 的 ui-theme.preference），默认
 *  - system / light / dark: 显式选择，会同时写回引擎设置文件
 */
const APPEARANCE_MODES = { engine: true, system: true, light: true, dark: true };

/** 引擎 settings.yaml 接受的 ui-theme.preference 值。 */
const ENGINE_THEMES = ["light", "dark", "system"];

/** 引擎 settings.yaml 接受的 locale.preference 值。 */
const ENGINE_LOCALES = ["zh", "en"];

/**
 * Parse <DSH_HOME>/settings.yaml text into a mutable YAML document plus the
 * validated ui-theme.preference / locale.preference values. Unreadable or
 * invalid input yields a fresh empty document and null prefs (callers fall
 * back to their defaults). Comments in the source are preserved by the
 * returned document.
 */
function parseEngineSettings(text) {
  let doc = null;
  try {
    doc = YAML.parseDocument(String(text ?? ""));
  } catch {
    doc = null;
  }
  // yaml 的解析错误**不会抛异常**，而是挂在 `doc.errors` 上 —— 而带错误的文档
  // `toString()` 会抛 `Document with errors cannot be stringified`，于是「改主题 / 改语言」
  // 在引擎侧永远不生效（调用方只把它 catch 成一行日志，用户看不到任何提示）。顶层不是
  // 映射（标量 / 序列）时 `setIn` 也会抛，同样在这里兜住：回退到一份全新文档，并告诉
  // 调用方这次是「降级」写入。
  const parseErrors = Array.isArray(doc?.errors) ? doc.errors : [];
  let degraded = false;
  if (doc === null || parseErrors.length > 0 || !YAML.isMap(doc.contents)) {
    degraded = parseErrors.length > 0;
    doc = YAML.parseDocument("");
  }
  let parsed = null;
  try {
    parsed = doc.toJS();
  } catch {
    parsed = null;
  }
  const theme = parsed && parsed["ui-theme"] && parsed["ui-theme"].preference;
  const locale = parsed && parsed.locale && parsed.locale.preference;
  return {
    doc,
    theme: ENGINE_THEMES.includes(theme) ? theme : null,
    locale: ENGINE_LOCALES.includes(locale) ? locale : null,
    /** true = 原文件解析不了，已回退到全新文档（写入会覆盖掉那些无法解析的内容）。 */
    degraded,
    errors: parseErrors.map((error) => String((error && error.message) || error)),
  };
}

/**
 * Apply validated ui-theme.preference / locale.preference onto a YAML document
 * (comments and unrelated keys preserved) and return the serialized text.
 * Passing null/undefined for a key leaves it untouched; invalid values throw.
 */
function applyEngineSettings(doc, { theme, locale } = {}) {
  if (theme !== undefined && theme !== null) {
    if (!ENGINE_THEMES.includes(theme)) throw new Error("invalid engine theme: " + theme);
    doc.setIn(["ui-theme", "preference"], theme);
  }
  if (locale !== undefined && locale !== null) {
    if (!ENGINE_LOCALES.includes(locale)) throw new Error("invalid engine locale: " + locale);
    doc.setIn(["locale", "preference"], locale);
  }
  return doc.toString();
}

/**
 * The engine-side ui-theme.preference a GUI appearance mode maps to.
 * `engine` mode is read-only (follow the engine) -> null (nothing to write).
 */
function engineThemeForAppearance(mode) {
  if (mode === "light" || mode === "dark" || mode === "system") return mode;
  return null;
}

module.exports = {
  APPEARANCE_MODES,
  ENGINE_THEMES,
  ENGINE_LOCALES,
  parseEngineSettings,
  applyEngineSettings,
  engineThemeForAppearance,
};