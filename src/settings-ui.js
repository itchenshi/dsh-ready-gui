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
    // 三种情况都是「原文件的内容这次保不住了」，必须一并置 degraded：调用方（main.js）
    // 只在 degraded 为真时记日志。只认 parseErrors 会漏掉「顶层不是映射」——那份文件能被
    // 正常解析，于是既不报错也不记日志，却被整份换成「只有主题」的新文档，用户的其他配置
    // 静默消失（实测：一个序列形态的 settings.yaml 就这样没了）。
    degraded = true;
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

// ---------------------------------------------------------------------------
// Engine 0.2.0: the same two preferences, but in the profile's patch layer
// ---------------------------------------------------------------------------
//
// 0.2.0 retired <DSH_HOME>/settings.yaml — the engine imports it once, leaves
// `settings.yaml.imported` behind and keeps the live values in the profile's overlay
// instead:
//
//     - id: ui-theme
//       name: "@deepseek-ai/dsh-client-ui-theme"
//       config:
//         preference: dark
//     - id: locale
//       name: "@deepseek-ai/dsh-client-locale"
//       config:
//         preference: zh
//
// Reading only settings.yaml is why the shell kept its default theme at startup ("follow
// the engine" silently found nothing), and why changing the theme from the shell had no
// effect. Both files are supported: the patch layer when present, settings.yaml otherwise.

/** Row ids used by the engine's profile overlay. */
const PATCH_ROW_THEME = "ui-theme";
const PATCH_ROW_LOCALE = "locale";

/**
 * Parse a profile patch layer (an array of plugin rows) into validated prefs.
 * Unreadable/invalid input yields null prefs; never throws.
 */
function parseProfilePatch(text) {
  let doc = null;
  try {
    doc = YAML.parseDocument(String(text ?? ""));
  } catch {
    doc = null;
  }
  const parseErrors = Array.isArray(doc?.errors) ? doc.errors : [];
  let parsed = null;
  if (doc !== null && parseErrors.length === 0) {
    try {
      parsed = doc.toJS();
    } catch {
      parsed = null;
    }
  }
  const rowConfig = (rowId) => {
    if (!Array.isArray(parsed)) return null;
    for (const row of parsed) {
      if (row && typeof row === "object" && row.id === rowId) {
        return row.config && typeof row.config === "object" ? row.config : null;
      }
    }
    return null;
  };
  const theme = rowConfig(PATCH_ROW_THEME)?.preference;
  const locale = rowConfig(PATCH_ROW_LOCALE)?.preference;
  return {
    doc,
    theme: ENGINE_THEMES.includes(theme) ? theme : null,
    locale: ENGINE_LOCALES.includes(locale) ? locale : null,
    errors: parseErrors.map((error) => String((error && error.message) || error)),
  };
}

/**
 * Set `config.preference` on the ui-theme / locale rows of a patch document and return the
 * serialized text. Comments and every other row are preserved. Invalid values throw.
 */
function applyProfilePatch(doc, { theme, locale } = {}) {
  const rows = doc?.contents;
  const findRow = (rowId) => {
    if (!YAML.isSeq(rows)) return null;
    for (const item of rows.items) {
      const value = item?.toJSON ? item.toJSON() : null;
      if (value && typeof value === "object" && value.id === rowId) return item;
    }
    return null;
  };
  const write = (rowId, key, value, allowed, label) => {
    if (value === undefined || value === null) return;
    if (!allowed.includes(value)) throw new Error(`invalid engine ${label}: ${value}`);
    const row = findRow(rowId);
    // Only touch rows that are actually there: inventing one would change the engine's
    // plugin graph from the shell, which is not ours to do.
    if (row === null) return;
    row.setIn(["config", key], value);
  };
  write(PATCH_ROW_THEME, "preference", theme, ENGINE_THEMES, "theme");
  write(PATCH_ROW_LOCALE, "preference", locale, ENGINE_LOCALES, "locale");
  return doc.toString();
}

module.exports = {
  APPEARANCE_MODES,
  ENGINE_THEMES,
  ENGINE_LOCALES,
  PATCH_ROW_THEME,
  PATCH_ROW_LOCALE,
  parseEngineSettings,
  applyEngineSettings,
  parseProfilePatch,
  applyProfilePatch,
  engineThemeForAppearance,
};