/* renderer-recovery.test.cjs — crash-recovery policy unit tests (no Electron needed).
 *
 * The give-up branch cannot be exercised end to end: injecting a renderer crash twice is
 * enough for the test harness to stop reproducing it, so the e2e smoke only proves
 * "detected + reloaded". The bound that prevents an infinite reload loop is pinned here
 * instead — it is the part that must not be wrong.
 */
"use strict";

const assert = require("node:assert");
const { createRecoveryPolicy, PAGE_UP_TIMEOUT_MS, HEALTHY_AFTER_MS } = require("../renderer-recovery.js");

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log("  ok - " + name);
  } catch (error) {
    failures += 1;
    console.error("  FAIL - " + name + ": " + error.message);
  }
}

check("a fresh policy reloads, and the third consecutive failure gives up", () => {
  const p = createRecoveryPolicy({ maxReloads: 2 });
  assert.deepStrictEqual(p.noteFailure(), { action: "reload", attempt: 1 });
  assert.deepStrictEqual(p.noteFailure(), { action: "reload", attempt: 2 });
  // The bound: one more and it must stop rather than reload forever.
  assert.deepStrictEqual(p.noteFailure(), { action: "give-up", attempt: 3 });
  assert.strictEqual(p.attempts, 3);
});

check("the counter resets only after the page has actually stayed up", () => {
  const p = createRecoveryPolicy({ maxReloads: 2, healthyAfterMs: 30_000 });
  p.noteFailure();
  p.noteFailure();
  // Loaded, but not long enough yet: a crash now must still count as the third failure.
  p.noteServedOk(1_000);
  assert.strictEqual(p.resetIfHealthy(1_000 + 10_000), false, "10s is not healthy yet");
  assert.deepStrictEqual(p.noteFailure(), { action: "give-up", attempt: 3 });

  // Now let it stay up for the whole window: the counter clears, so a crash much later
  // starts over instead of inheriting an unrelated old failure.
  const q = createRecoveryPolicy({ maxReloads: 2, healthyAfterMs: 30_000 });
  q.noteFailure();
  q.noteFailure();
  q.noteServedOk(5_000);
  assert.strictEqual(q.resetIfHealthy(5_000 + 30_000), true, "30s of uptime clears it");
  assert.strictEqual(q.attempts, 0);
  assert.deepStrictEqual(q.noteFailure(), { action: "reload", attempt: 1 });
});

check("a reload that never comes up counts as another failure (hang, not crash)", () => {
  const p = createRecoveryPolicy({ maxReloads: 1 });
  assert.deepStrictEqual(p.noteFailure(), { action: "reload", attempt: 1 });
  // No noteServedOk in between: the caller's load timeout reports in instead.
  assert.deepStrictEqual(p.noteFailure(), { action: "give-up", attempt: 2 });
});

check("resetIfHealthy is a no-op until the page has reported a load", () => {
  const p = createRecoveryPolicy();
  assert.strictEqual(p.resetIfHealthy(Date.now()), false);
  assert.strictEqual(p.attempts, 0);
});

check("reset() clears both the counter and the clock", () => {
  const p = createRecoveryPolicy({ maxReloads: 1 });
  p.noteFailure();
  p.noteServedOk(1);
  p.reset();
  assert.strictEqual(p.attempts, 0);
  assert.strictEqual(p.resetIfHealthy(1 + 10 * HEALTHY_AFTER_MS), false, "nothing to reset");
});

check("the exported timings are sane", () => {
  assert.ok(PAGE_UP_TIMEOUT_MS > 5_000 && PAGE_UP_TIMEOUT_MS <= 120_000, "load timeout is reasonable");
  assert.ok(HEALTHY_AFTER_MS >= 5_000, "the healthy window is not a blink");
});

console.log(failures === 0 ? "\nrenderer-recovery: all checks passed" : `\n${failures} FAILED`);
if (failures > 0) process.exitCode = 1;
