"use strict";

/**
 * Unit tests for src/settings-ui.js — the pure yaml read/write helpers behind
 * the GUI's two-way theme/language sync with the engine settings file.
 * Run: node src/test/settings-ui.test.cjs
 */

const assert = require("node:assert");
const {
  APPEARANCE_MODES,
  ENGINE_THEMES,
  ENGINE_LOCALES,
  parseEngineSettings,
  applyEngineSettings,
  parseProfilePatch,
  applyProfilePatch,
  engineThemeForAppearance,
} = require("../settings-ui");

let passed = 0;
function ok(name, fn) {
  try {
    fn();
    passed += 1;
    console.log("ok -", name);
  } catch (error) {
    console.error("FAIL -", name);
    console.error(error && error.stack ? error.stack : error);
    process.exitCode = 1;
  }
}

// 1. empty / missing input -> neutral defaults
ok("empty input parses to defaults", () => {
  const r = parseEngineSettings("");
  assert.strictEqual(r.theme, null);
  assert.strictEqual(r.locale, null);
  assert.ok(r.doc);
  assert.strictEqual(parseEngineSettings(undefined).theme, null);
});

// 2. broken yaml -> neutral defaults (no throw)
ok("invalid yaml -> defaults without throwing", () => {
  const r = parseEngineSettings("ui-theme: [unclosed\n:::");
  assert.strictEqual(r.theme, null);
  assert.strictEqual(r.locale, null);
});

// 3. full settings.yaml with comments + unrelated keys parses both prefs
ok("parses ui-theme.preference and locale.preference", () => {
  const text = [
    "# DeepSeek Harness settings",
    "ui-theme:",
    "  preference: dark",
    "locale:",
    "  preference: zh",
    "something-else:",
    "  keep: me",
  ].join("\n");
  const r = parseEngineSettings(text);
  assert.strictEqual(r.theme, "dark");
  assert.strictEqual(r.locale, "zh");
});

// 4. unsupported values are ignored (treated as absent)
ok("unsupported pref values -> null", () => {
  const r = parseEngineSettings("ui-theme:\n  preference: neon\nlocale:\n  preference: fr");
  assert.strictEqual(r.theme, null);
  assert.strictEqual(r.locale, null);
});

// 5. rewriting keeps comments and unrelated keys, edits only the given key
ok("applyEngineSettings is surgical and comment-preserving", () => {
  const text = [
    "# DeepSeek Harness settings",
    "ui-theme:",
    "  preference: dark",
    "locale:",
    "  preference: zh",
    "something-else:",
    "  keep: me",
  ].join("\n");
  const { doc } = parseEngineSettings(text);
  const out = applyEngineSettings(doc, { theme: "light" });
  assert.ok(out.includes("# DeepSeek Harness settings"), "comment preserved");
  assert.ok(out.includes("keeping: me") || out.includes("keep: me"), "unrelated key preserved");
  assert.ok(!/preference: dark/.test(out), "old theme replaced");
  assert.ok(/preference: light/.test(out), "new theme written");
  assert.ok(/preference: zh/.test(out), "locale untouched");
  // untouched locale still parses back
  const back = parseEngineSettings(out);
  assert.strictEqual(back.theme, "light");
  assert.strictEqual(back.locale, "zh");
});

// 6. combined patch updates both keys in one write
ok("combined locale+theme patch", () => {
  const { doc } = parseEngineSettings("ui-theme:\n  preference: system\n");
  const out = applyEngineSettings(doc, { theme: "dark", locale: "en" });
  const back = parseEngineSettings(out);
  assert.strictEqual(back.theme, "dark");
  assert.strictEqual(back.locale, "en");
});

// 7. invalid writes throw loudly
ok("invalid theme write throws", () => {
  const { doc } = parseEngineSettings("");
  assert.throws(() => applyEngineSettings(doc, { theme: "neon" }), /invalid engine theme/);
  assert.throws(() => applyEngineSettings(doc, { locale: "fr" }), /invalid engine locale/);
});

// 8. round-trip / idempotence: applying the same value is a stable no-op write
ok("same-value rewrite is idempotent", () => {
  const text = "ui-theme:\n  preference: dark\nlocale:\n  preference: zh\n";
  const first = parseEngineSettings(text);
  const once = applyEngineSettings(first.doc, { theme: "dark", locale: "zh" });
  const second = parseEngineSettings(once);
  const twice = applyEngineSettings(second.doc, { theme: "dark", locale: "zh" });
  assert.strictEqual(twice, once);
});

// 9. engineThemeForAppearance mapping (engine mode = read-only)
ok("engineThemeForAppearance mapping", () => {
  const map = (mode) => engineThemeForAppearance(mode);
  assert.strictEqual(map("light"), "light");
  assert.strictEqual(map("dark"), "dark");
  assert.strictEqual(map("system"), "system");
  assert.strictEqual(map("engine"), null);
  assert.strictEqual(map(undefined), null);
});

// 10. appearance modes catalog sanity
ok("appearance modes cover the settings popup", () => {
  for (const m of ["engine", "system", "light", "dark"]) assert.ok(APPEARANCE_MODES[m], m);
  assert.strictEqual(Object.keys(APPEARANCE_MODES).length, 4);
  assert.deepStrictEqual(ENGINE_THEMES, ["light", "dark", "system"]);
  assert.deepStrictEqual(ENGINE_LOCALES, ["zh", "en"]);
});

// 11. engine 0.2.0 puts the same prefs in the profile patch layer, not settings.yaml
const PATCH = [
  "# generated overlay",
  "- id: model",
  "  name: '@deepseek-ai/dsh-model'",
  "  config:",
  "    provider: deepseek-official",
  "- id: ui-theme",
  "  name: '@deepseek-ai/dsh-client-ui-theme'",
  "  config:",
  "    preference: dark",
  "- id: locale",
  "  name: '@deepseek-ai/dsh-client-locale'",
  "  config:",
  "    preference: zh",
  "",
].join("\n");

ok("parseProfilePatch reads the theme/locale rows (the 0.2.0 location)", () => {
  const r = parseProfilePatch(PATCH);
  assert.strictEqual(r.theme, "dark");
  assert.strictEqual(r.locale, "zh");
  assert.deepStrictEqual(r.errors, []);
});

ok("parseProfilePatch tolerates junk without throwing", () => {
  for (const input of [undefined, "", "not: [valid", "- 3\n- 4\n", "a: b\n"]) {
    const r = parseProfilePatch(input);
    assert.strictEqual(r.theme, null);
    assert.strictEqual(r.locale, null);
  }
  // A value the engine would not accept must not be trusted either.
  const bad = parseProfilePatch("- id: ui-theme\n  config:\n    preference: neon\n");
  assert.strictEqual(bad.theme, null, "unknown theme value is ignored, not passed through");
});

ok("applyProfilePatch rewrites only the pref, keeping every other row and comment", () => {
  const { doc } = parseProfilePatch(PATCH);
  const out = applyProfilePatch(doc, { theme: "light" });
  assert.ok(out.includes("# generated overlay"), "comments survive");
  assert.ok(out.includes("provider: deepseek-official"), "other plugin rows survive");
  assert.strictEqual(parseProfilePatch(out).theme, "light");
  assert.strictEqual(parseProfilePatch(out).locale, "zh", "untouched pref stays");
  assert.strictEqual(out.split("\n").length, PATCH.split("\n").length, "no structural churn");
  // An invalid value is refused rather than written into the engine's config.
  assert.throws(() => applyProfilePatch(parseProfilePatch(PATCH).doc, { theme: "neon" }), /invalid engine theme/);
});

ok("applyProfilePatch leaves a missing row alone instead of inventing one", () => {
  const { doc } = parseProfilePatch("- id: model\n  name: x\n");
  const out = applyProfilePatch(doc, { theme: "dark", locale: "en" });
  assert.ok(!out.includes("ui-theme"), "the shell must not add rows to the engine's plugin graph");
  assert.ok(!out.includes("locale"));
});

console.log(`\n${passed} checks passed`);