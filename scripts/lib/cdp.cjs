// scripts/lib/cdp.cjs — shared CDP plumbing for the E2E smoke tests.
//
// Why this exists: every smoke test that drives a window used to inline its own copy of
// "find the target page over /json, open a WebSocket, correlate ids, evaluate an
// expression" — three near-identical ~60-line blocks (smoke-first-run, smoke-plugin-enable,
// smoke-profile-watch). A fix in one (e.g. the 30s RPC timeout) silently left the other two
// behind, and the target-selection rules drifted (one matched `settings.html`, another the
// main window). This module is the single place those rules live.
//
// Usage from a driver script (the PowerShell side writes a small .cjs and runs it):
//
//   const { connectToPage, evaluate, waitFor } = require("<repo>/scripts/lib/cdp.cjs");
//   const page = await connectToPage({ port, urlIncludes: "settings.html" });
//   const state = await page.evaluate("(() => ({ title: document.title }))()");
//   await page.waitFor({ timeoutMs: 60000, describe: "the card to appear",
//     probe: "(() => document.getElementById('firstRun').hidden === false)()" });
//   page.close();
"use strict";

const DEFAULT_RPC_TIMEOUT_MS = 30_000;
const DEFAULT_TARGET_TIMEOUT_MS = 60_000;

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wait for a CDP page target whose URL contains `urlIncludes` (omit to take the first page).
 * @returns {Promise<{webSocketDebuggerUrl: string, url: string, id: string}>}
 */
async function findTarget({ port, urlIncludes = null, timeoutMs = DEFAULT_TARGET_TIMEOUT_MS, label = "page" }) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "no targets";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json`);
      if (res.ok) {
        const targets = await res.json();
        const pages = targets.filter((x) => x.type === "page");
        const hit = urlIncludes ? pages.find((x) => String(x.url).includes(urlIncludes)) : pages[0];
        if (hit) return hit;
        lastError = `pages=${JSON.stringify(pages.map((p) => p.url))}`;
      } else {
        lastError = `HTTP ${res.status}`;
      }
    } catch (error) {
      lastError = String((error && error.message) || error); // app not up yet
    }
    await wait(500);
  }
  throw new Error(`CDP ${label} target not found (urlIncludes=${urlIncludes}); last=${lastError}`);
}

/**
 * Connect to a CDP page target and return a small client.
 * @param {object} o
 * @param {number} o.port             remote-debugging-port of the app under test
 * @param {string} [o.urlIncludes]    substring the target URL must contain
 * @param {number} [o.timeoutMs]      how long to wait for the target
 * @param {number} [o.rpcTimeoutMs]   per-call timeout
 */
async function connectToPage({ port, urlIncludes = null, timeoutMs, rpcTimeoutMs = DEFAULT_RPC_TIMEOUT_MS, label }) {
  const target = await findTarget({ port, urlIncludes, timeoutMs, label: label ?? urlIncludes ?? "page" });
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener("open", resolve, { once: true });
    ws.addEventListener("error", () => reject(new Error("CDP websocket error")), { once: true });
  });

  let nextId = 1;
  const pending = new Map();
  ws.addEventListener("message", (ev) => {
    const msg = JSON.parse(String(ev.data));
    if (msg.id && pending.has(msg.id)) {
      pending.get(msg.id)(msg);
      pending.delete(msg.id);
    }
  });

  function rpc(method, params) {
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP rpc timeout: ${method}`));
      }, rpcTimeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** Evaluate an expression in the page and return its value (exceptions surface as errors). */
  async function evaluate(expression) {
    const r = await rpc("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("evaluate failed: " + JSON.stringify(r.exceptionDetails));
    return r.result.value;
  }

  /**
   * Poll `probe` (an expression returning a truthy value) until it is truthy.
   * On timeout the message includes the last observed value, so a failure report says what
   * the page actually looked like instead of only "timed out".
   */
  async function waitFor({ probe, timeoutMs: waitMs = 60_000, intervalMs = 300, describe = "condition" }) {
    const deadline = Date.now() + waitMs;
    let last = null;
    while (Date.now() < deadline) {
      last = await evaluate(probe);
      if (last) return last;
      await wait(intervalMs);
    }
    throw new Error(`timeout waiting for ${describe} (last=${JSON.stringify(last)})`);
  }

  return {
    target,
    evaluate,
    waitFor,
    wait,
    close: () => {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    },
  };
}

/**
 * Standard driver wrapper: runs `main`, prints `DRIVER FAIL: …` and exits non-zero on throw,
 * so the PowerShell side can just check the exit code.
 */
function runDriver(main) {
  Promise.resolve()
    .then(main)
    .catch((e) => {
      console.error("DRIVER FAIL: " + ((e && e.stack) || e));
      process.exit(1);
    });
}

module.exports = { connectToPage, findTarget, runDriver, wait };
