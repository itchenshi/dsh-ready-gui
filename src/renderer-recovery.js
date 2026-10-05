// Renderer-crash recovery policy (pure — no timers, no Electron).
//
// The main window renders the harness page, which also runs every installed plugin's
// page half. A renderer that dies (a plugin throwing hard, an OOM, a GPU reset) used to
// leave a blank window with nothing logged and no recovery; reloading is the fix, but an
// unconditional reload loop on a deterministically-crashing page spins forever.
//
// Two details this policy exists to get right:
//
//   1. **Consecutive**, not "N per minute". Page loads here can take a long time (engine
//      boot, plugin reconciliation, pnpm), so a wall-clock-rate bound silently resets
//      between crashes and never trips. The counter instead resets only after the page
//      has stayed up for `healthyAfterMs` — which is what "it recovered" actually means.
//   2. A reload that never comes up is a failure too (a hang, not a crash). The caller
//      feeds its own load timeout back in as another attempt, so a hung page cannot sit
//      there forever either.
//
// Kept separate from main.js so the policy is testable without an Electron app: the
// give-up branch cannot be reached end-to-end (injecting a crash twice is enough for the
// harness to stop reproducing it), and that branch is exactly the part that must not be
// wrong — it is what stops an infinite reload loop.

/** @typedef {'reload' | 'give-up'} RecoveryAction */

/**
 * @param options.maxReloads - consecutive reloads allowed before giving up.
 * @param options.healthyAfterMs - how long the page must stay up to reset the counter.
 */
export function createRecoveryPolicy({ maxReloads = 2, healthyAfterMs = 30000 } = {}) {
  let consecutiveReloads = 0
  let servedOkAt = null

  return {
    /** Current consecutive count (for logging and tests). */
    get attempts() {
      return consecutiveReloads
    },

    /** Record that the page finished loading (starts the "it stayed up" clock). */
    noteServedOk(now) {
      servedOkAt = now
    },

    /**
     * Called by the caller's timer: reset the counter once the page has been up long
     * enough to count as recovered.
     * @param now - milliseconds (injected for tests).
     * @returns true when a non-zero counter was cleared.
     */
    resetIfHealthy(now) {
      if (servedOkAt === null || now - servedOkAt < healthyAfterMs) return false
      servedOkAt = null
      const had = consecutiveReloads > 0
      consecutiveReloads = 0
      return had
    },

    /**
     * Record one failure (a crash, or a reload that never came up).
     * @returns {{action: RecoveryAction, attempt: number}} `attempt` is 1-based for a
     *   reload, and `maxReloads + 1` for the giving-up call.
     */
    noteFailure() {
      consecutiveReloads += 1
      servedOkAt = null
      if (consecutiveReloads > maxReloads) return { action: 'give-up', attempt: consecutiveReloads }
      return { action: 'reload', attempt: consecutiveReloads }
    },

    /** Forget everything (e.g. the engine restarted and the page was loaded cleanly). */
    reset() {
      consecutiveReloads = 0
      servedOkAt = null
    },
  }
}

/** How long to wait for a reloaded page to come up before counting it as a failure. */
export const PAGE_UP_TIMEOUT_MS = 30000

/** How long the page must stay up before the crash counter resets. */
export const HEALTHY_AFTER_MS = 30000
