"use strict";

/**
 * Region-aware release lookup for the app's own version.
 *
 * The project is mirrored on three open-source platforms, each publishing the same
 * release tag. Which one answers first depends entirely on where the user is:
 *
 *   - GitHub  api.github.com        — fastest outside mainland China, frequently
 *                                     slow/timing out/blocked inside it;
 *   - Gitee   gitee.com/api/v5      — fast inside mainland China;
 *   - GitCode api.gitcode.com/api/v5— second mainland option, independent of Gitee.
 *
 * So the check walks a *preferred order* (the last source that worked, then the
 * region default), with a short per-source timeout so a blocked host cannot stall
 * the user: a mainland user must never wait on GitHub before trying Gitee. All three
 * answer `{"tag_name":"vX.Y.Z"}` for `GET .../releases/latest`, so one parser covers
 * them. Verified against the live APIs (200 + matching tag on all three).
 *
 * This module only *looks up* a version; comparing it with the running app version is
 * the caller's job (main.js already has semver).
 */

const REPO_OWNER = "itchenshi";
const REPO_NAME = "dsh-ready-gui";

const SOURCES = Object.freeze([
  Object.freeze({
    id: "github",
    label: "GitHub",
    api: `https://api.github.com/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`,
    releases: `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/latest`,
    headers: Object.freeze({ accept: "application/vnd.github+json" }),
  }),
  Object.freeze({
    id: "gitee",
    label: "Gitee",
    api: `https://gitee.com/api/v5/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`,
    releases: `https://gitee.com/${REPO_OWNER}/${REPO_NAME}/releases`,
    headers: Object.freeze({}),
  }),
  Object.freeze({
    id: "gitcode",
    label: "GitCode",
    api: `https://api.gitcode.com/api/v5/repos/${REPO_OWNER}/${REPO_NAME}/releases/latest`,
    releases: `https://gitcode.com/${REPO_OWNER}/${REPO_NAME}/releases`,
    headers: Object.freeze({}),
  }),
]);

/** Default order (outside mainland China) and the mainland-first order. */
const DEFAULT_ORDER = Object.freeze(["github", "gitee", "gitcode"]);
const MAINLAND_ORDER = Object.freeze(["gitee", "gitcode", "github"]);

const SOURCE_IDS = Object.freeze(SOURCES.map((source) => source.id));

function sourceById(id) {
  return SOURCES.find((source) => source.id === id) ?? null;
}

/**
 * Heuristic: is this machine most likely on a mainland-China network?
 * Locale and time zone are both checked, so an English UI installed in China still
 * gets the mainland order; `zh-TW`/`zh-HK` are deliberately NOT treated as mainland.
 */
function likelyMainland({ locale, timeZone } = {}) {
  const tag = String(locale ?? "").toLowerCase();
  if (tag.startsWith("zh-cn") || tag.startsWith("zh-hans")) return true;
  const zone = String(timeZone ?? "");
  return zone === "Asia/Shanghai" || zone === "Asia/Urumqi" || zone === "Asia/Chongqing";
}

/**
 * Build the source order to try.
 * @param {object} [options]
 * @param {string} [options.source] - "auto" (default) or a pinned source id.
 * @param {string|null} [options.lastGood] - source that answered last time; tried first.
 * @param {boolean} [options.mainland] - region hint (see likelyMainland).
 */
function preferredOrder({ source = "auto", lastGood = null, mainland = false } = {}) {
  const region = mainland ? MAINLAND_ORDER : DEFAULT_ORDER;
  if (source !== "auto" && sourceById(source) !== null) {
    // An explicitly pinned source is tried first, but the others stay as fallback:
    // a pinned-but-unreachable source must not turn into "check failed".
    return [source, ...region.filter((id) => id !== source)];
  }
  const remembered = lastGood !== null && sourceById(lastGood) !== null ? lastGood : null;
  return remembered === null ? [...region] : [remembered, ...region.filter((id) => id !== remembered)];
}

/**
 * Extract a version from a release payload.
 * All three platforms answer `{"tag_name":"v0.4.0"}`; a plain-text body containing the
 * tag is also accepted so a proxy/plain endpoint still works.
 * @returns {string|null} the version without a leading `v`, or null when unreadable.
 */
function parseTag(body) {
  if (typeof body !== "string" || body === "") return null;
  const match = body.match(/"tag_name"\s*:\s*"([^"]{1,64})"/u);
  const raw = match === null ? (body.length <= 64 ? body : null) : match[1];
  if (raw === null) return null;
  const version = raw.trim().replace(/^v/iu, "");
  // Reject anything that is not a plain semver-ish token (a stray HTML error page, etc.).
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version) ? version : null;
}

/**
 * Ask ONE source for its latest release tag.
 * @returns {Promise<{id,label,version,releases}|null>} null when unreachable/invalid.
 */
async function fetchFromSource(source, { timeoutMs = 4000, fetchImpl = fetch } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(source.api, {
      signal: controller.signal,
      headers: { accept: "application/json", ...source.headers },
      // 不跟随重定向：注释与行为原先自相矛盾（写着「不得静默跟随」却用了 follow），
      // 那样版本号可能来自最终落到的任意主机。失败即视为该源不可用，换下一个源。
      redirect: "error",
    });
    if (!res || res.ok !== true) return null;
    const version = parseTag(await res.text());
    if (version === null) return null;
    return { id: source.id, label: source.label, version, releases: source.releases };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Walk the order until one source answers.
 * @returns {Promise<{id,label,version,releases,tried:string[]}|null>} null when every
 *   source failed (offline, blocked, or all payloads unreadable).
 */
async function fetchLatestRelease({ order, timeoutMs = 4000, fetchImpl = fetch } = {}) {
  const ids = Array.isArray(order) && order.length > 0 ? order : DEFAULT_ORDER;
  const tried = [];
  for (const id of ids) {
    const source = sourceById(id);
    if (source === null) continue;
    tried.push(id);
    const hit = await fetchFromSource(source, { timeoutMs, fetchImpl });
    if (hit !== null) return { ...hit, tried };
  }
  return null;
}

module.exports = {
  SOURCES,
  SOURCE_IDS,
  DEFAULT_ORDER,
  MAINLAND_ORDER,
  likelyMainland,
  preferredOrder,
  parseTag,
  fetchFromSource,
  fetchLatestRelease,
  sourceById,
};
