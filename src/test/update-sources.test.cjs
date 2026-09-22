"use strict";

// Region-aware release lookup (src/update-sources.js): the source order must put the
// reachable platform first, and a blocked host must not stall the whole check.
// Run: node src/test/update-sources.test.cjs
const assert = require("node:assert/strict");
const {
  SOURCES,
  DEFAULT_ORDER,
  MAINLAND_ORDER,
  likelyMainland,
  preferredOrder,
  parseTag,
  fetchFromSource,
  fetchLatestRelease,
  sourceById,
} = require("../update-sources.js");

let failures = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log("  ok - " + name);
  } catch (error) {
    failures += 1;
    console.error("  ✗ " + name + "\n      " + (error && error.message));
  }
}

/** A fetch stub: per-host scripted responses, recording call order. */
function stubFetch(script, calls = []) {
  return async (url, init) => {
    const host = new URL(url).host;
    calls.push(host);
    const entry = script[host];
    if (entry === undefined) throw new Error("network down: " + host);
    if (typeof entry === "function") return entry(url, init);
    return {
      ok: entry.ok !== false,
      status: entry.status ?? (entry.ok === false ? 500 : 200),
      text: async () => entry.body ?? "",
    };
  };
}

/** A fetch that never settles until aborted (models a black-holed connection). */
function hangingFetch() {
  return (_url, init) =>
    new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
    });
}

(async () => {
  await check("every platform is declared with an api + releases URL", () => {
    assert.deepEqual(SOURCES.map((s) => s.id), ["github", "gitee", "gitcode"]);
    for (const source of SOURCES) {
      assert.match(source.api, /^https:\/\//, source.id + " api must be https");
      assert.match(source.releases, /^https:\/\//, source.id + " releases must be https");
      assert.ok(source.label.length > 0);
    }
    assert.equal(sourceById("nope"), null);
  });

  await check("parseTag reads all three platforms' payloads", () => {
    // The real shape: {"tag_name":"v0.4.0"} — verified live on GitHub, Gitee, GitCode.
    assert.equal(parseTag('{"tag_name":"v0.4.0","name":"DSH Ready GUI 0.4.0"}'), "0.4.0");
    assert.equal(parseTag('{"tag_name":"0.4.0"}'), "0.4.0");
    assert.equal(parseTag('{"tag_name": "v0.5.0-rc.1"}'), "0.5.0-rc.1");
    assert.equal(parseTag("v0.4.0"), "0.4.0"); // plain-text endpoint
  });

  await check("parseTag rejects junk instead of inventing a version", () => {
    assert.equal(parseTag(""), null);
    assert.equal(parseTag(null), null);
    assert.equal(parseTag(undefined), null);
    assert.equal(parseTag("<html><body>404</body></html>"), null);
    assert.equal(parseTag('{"message":"Not Found"}'), null);
    assert.equal(parseTag('{"tag_name":""}'), null);
    assert.equal(parseTag('{"tag_name":"latest"}'), null);
    assert.equal(parseTag('{"tag_name":"v"}'), null);
    // an HTML error page longer than the plain-text allowance must never be parsed
    assert.equal(parseTag("x".repeat(200)), null);
  });

  await check("mainland detection uses locale AND time zone", () => {
    assert.equal(likelyMainland({ locale: "zh-CN", timeZone: "Asia/Shanghai" }), true);
    assert.equal(likelyMainland({ locale: "zh-Hans", timeZone: "UTC" }), true);
    assert.equal(likelyMainland({ locale: "en-US", timeZone: "Asia/Shanghai" }), true);
    assert.equal(likelyMainland({ locale: "zh-TW", timeZone: "Asia/Taipei" }), false);
    assert.equal(likelyMainland({ locale: "en-US", timeZone: "America/New_York" }), false);
    assert.equal(likelyMainland({}), false);
  });

  await check("order puts the reachable platform first", () => {
    assert.deepEqual(preferredOrder({ mainland: false }), [...DEFAULT_ORDER]);
    assert.deepEqual(preferredOrder({ mainland: true }), [...MAINLAND_ORDER]);
    // a previously working source is remembered and tried first
    assert.deepEqual(preferredOrder({ mainland: false, lastGood: "gitee" }), ["gitee", "github", "gitcode"]);
    assert.deepEqual(preferredOrder({ mainland: true, lastGood: "gitcode" }), ["gitcode", "gitee", "github"]);
    assert.deepEqual(preferredOrder({ mainland: true, lastGood: "bogus" }), [...MAINLAND_ORDER]);
    // an explicit choice is honoured first but never removes the fallbacks
    assert.deepEqual(preferredOrder({ source: "github", mainland: true }), ["github", "gitee", "gitcode"]);
    assert.deepEqual(preferredOrder({ source: "gitee", mainland: false }), ["gitee", "github", "gitcode"]);
    assert.deepEqual(preferredOrder({ source: "bogus", mainland: false }), [...DEFAULT_ORDER]);
  });

  await check("a mainland user never waits on a blocked GitHub", async () => {
    // GitHub black-holes; Gitee answers. With the mainland order the FIRST call must
    // already be Gitee — the check must not burn a timeout on GitHub first.
    const calls = [];
    const hit = await fetchLatestRelease({
      order: preferredOrder({ mainland: true }),
      fetchImpl: stubFetch({ "gitee.com": { body: '{"tag_name":"v9.9.9"}' } }, calls),
      timeoutMs: 50,
    });
    assert.deepEqual(calls, ["gitee.com"]);
    assert.equal(hit.id, "gitee");
    assert.equal(hit.version, "9.9.9");
    assert.deepEqual(hit.tried, ["gitee"]);
    assert.match(hit.releases, /^https:\/\/gitee\.com\//);
  });

  await check("falls through to the next platform when one fails", async () => {
    const calls = [];
    const hit = await fetchLatestRelease({
      order: ["github", "gitee", "gitcode"],
      fetchImpl: stubFetch(
        { "gitee.com": { body: '{"tag_name":"v0.5.0"}' } },
        calls,
      ),
      timeoutMs: 50,
    });
    assert.deepEqual(calls, ["api.github.com", "gitee.com"]);
    assert.equal(hit.id, "gitee");
    assert.deepEqual(hit.tried, ["github", "gitee"]);
  });

  await check("an HTTP error or unreadable payload counts as a failure, not a version", async () => {
    const calls = [];
    const hit = await fetchLatestRelease({
      order: ["github", "gitee", "gitcode"],
      fetchImpl: stubFetch(
        {
          "api.github.com": { ok: false, status: 403, body: '{"message":"rate limit"}' },
          "gitee.com": { body: "<html>maintenance</html>" },
          "api.gitcode.com": { body: '{"tag_name":"v1.2.3"}' },
        },
        calls,
      ),
      timeoutMs: 50,
    });
    assert.deepEqual(calls, ["api.github.com", "gitee.com", "api.gitcode.com"]);
    assert.equal(hit.id, "gitcode");
    assert.equal(hit.version, "1.2.3");
  });

  await check("a hanging source is aborted by the timeout and the check moves on", async () => {
    const started = Date.now();
    let aborted = false;
    const fetchImpl = (url, init) => {
      if (new URL(url).host === "gitee.com") {
        return Promise.resolve({ ok: true, text: async () => '{"tag_name":"v0.6.0"}' });
      }
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          aborted = true;
          reject(new Error("aborted"));
        });
      });
    };
    const hit = await fetchLatestRelease({ order: ["github", "gitee"], fetchImpl, timeoutMs: 60 });
    assert.equal(aborted, true, "the hanging request must have been aborted");
    assert.equal(hit.id, "gitee");
    assert.ok(Date.now() - started < 3000, "must not wait for the default timeout");
  });

  await check("returns null (not a crash) when every platform is unreachable", async () => {
    assert.equal(await fetchLatestRelease({ order: ["github", "gitee", "gitcode"], fetchImpl: stubFetch({}), timeoutMs: 40 }), null);
    assert.equal(await fetchLatestRelease({ order: ["github"], fetchImpl: hangingFetch(), timeoutMs: 40 }), null);
    // a source id that is not in the table is skipped, and an empty order falls back
    assert.equal(await fetchLatestRelease({ order: ["bogus"], fetchImpl: stubFetch({}), timeoutMs: 40 }), null);
    const fallback = await fetchLatestRelease({
      order: [],
      fetchImpl: stubFetch({ "api.github.com": { body: '{"tag_name":"v2.0.0"}' } }),
      timeoutMs: 40,
    });
    assert.equal(fallback.id, "github");
  });

  await check("fetchFromSource sends https, the platform's accept header and an abort signal", async () => {
    let seen = null;
    const hit = await fetchFromSource(sourceById("github"), {
      timeoutMs: 40,
      fetchImpl: async (url, init) => {
        seen = { url: String(url), init };
        return { ok: true, text: async () => '{"tag_name":"v0.4.0"}' };
      },
    });
    assert.match(seen.url, /^https:\/\/api\.github\.com\//);
    assert.equal(seen.init.headers.accept, "application/vnd.github+json");
    assert.ok(seen.init.signal instanceof AbortSignal);
    assert.equal(hit.version, "0.4.0");
  });

  if (failures > 0) {
    console.error(`\nupdate-sources: ${failures} check(s) FAILED`);
    process.exit(1);
  }
  console.log("\nupdate-sources: all checks passed");
})();
