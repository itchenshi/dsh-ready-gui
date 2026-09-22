// dsh-gui-last-session — client (browser) half.
//
// Records the conversation you are currently in and, on the next page load,
// reopens it. This replaces the old engine-file patch, which broke on every
// engine upgrade because it was pinned to one engine version and located its
// insertion point by matching engine source text.
//
// BUNDLE FORMAT
// -------------
// The engine's client module system does NOT consume plain ESM. A plugin client
// bundle must register a lazy CJS factory:
//
//     window.__ModuleLoader__.load({ id: "<package name>", factory: (require) => ({ ...exports }) })
//
// Executing the bundle only REGISTERS the factory — every side effect lives
// inside the factory closure and runs at materialization (first import). That
// is why all of the code below sits inside the factory. This file is
// hand-written and dependency-free: the plugin needs nothing but `ctx.sessions`,
// so there is no bundler in the loop.
//
// Correctness notes
// -----------------
// * NEVER record the bootstrap session. On page load the engine itself
//   navigates to a workspace and may create/select a BLANK session. If we
//   recorded that, the stored pointer would become "the empty session the
//   engine just made", and the next start would reopen nothing useful. This was
//   a real, observed failure of the previous implementation.
//
//   Two independent guards:
//     1. Recording stays DISARMED until the reopen attempt has settled (or a
//        timeout passes). The engine's bootstrap navigation therefore happens
//        while we are not yet listening for changes.
//     2. Even when armed, a row flagged `blank: true` is never recorded.
//
// * Reopening must wait for the target to become addressable. The session list
//   arrives over the network after the page mounts, so `open()` on a not-yet
//   listed id would fail loud ("unknown ids fail loud" per the contract). We
//   poll for the row to exist before selecting it.

window.__ModuleLoader__.load({
  id: 'dsh-gui-last-session',
  factory: (require) => {
    // --- constants ---------------------------------------------------------

    /** Where the host half stores the pointer. */
    const POINTER_PATH = '/gui-last-session'

    /** Poll cadence and ceiling while waiting for the session list to arrive. */
    const WAIT_INTERVAL_MS = 150
    const WAIT_ATTEMPTS = 200 // ~30s — covers a slow cold start
    /** Grace period before recording arms when there is nothing to reopen. */
    const ARM_FALLBACK_MS = 4000
    /** Don't re-POST the same id within this window. */
    const RECORD_THROTTLE_MS = 1500

    /** Conservative session id shape; mirrors the host half's validation. */
    const SESSION_ID_RE = /^session-[A-Za-z0-9_-]{4,200}$/u

    // --- helpers -----------------------------------------------------------

    /** True when a value looks like a usable session id. */
    function isSessionId(value) {
      return typeof value === 'string' && SESSION_ID_RE.test(value)
    }

    /** Read the stored pointer. Any failure means "no memory" — never throws. */
    async function fetchLastSession() {
      try {
        const res = await fetch(POINTER_PATH, { headers: { accept: 'application/json' } })
        if (!res.ok) return null
        const body = await res.json()
        const id = body?.sessionId
        return isSessionId(id) ? id : null
      } catch {
        return null
      }
    }

    /** Persist the pointer. Failures are non-fatal (the feature is best-effort). */
    async function storeLastSession(sessionId) {
      try {
        await fetch(POINTER_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId }),
          keepalive: true,
        })
      } catch {
        // Offline / server restarting: the previous pointer simply stays.
      }
    }

    const sleep = (ms) => new Promise((resolveDone) => setTimeout(resolveDone, ms))

    /**
     * Wait until `id` is present in the list snapshot, then select it.
     * @returns true when the session was selected.
     */
    async function openWhenReady(sessions, id, opts = {}) {
      const wait = opts.wait ?? sleep
      const attempts = opts.attempts ?? WAIT_ATTEMPTS
      const interval = opts.interval ?? WAIT_INTERVAL_MS
      for (let attempt = 0; attempt < attempts; attempt += 1) {
        let state
        try {
          state = sessions.list.getSnapshot()
        } catch {
          // A throwing snapshot (service tearing down / not ready yet) must not
          // abort the wait — just keep polling until the attempts run out.
          state = undefined
        }
        if (state && state.byId && Object.prototype.hasOwnProperty.call(state.byId, id)) {
          try {
            sessions.open(id)
            return true
          } catch {
            // The contract says unknown ids fail loud; a race here just retries.
          }
        }
        try {
          await wait(interval)
        } catch {
          return false
        }
      }
      return false
    }

    /**
     * Install recording + reopen behaviour.
     *
     * Exported separately from `apply` so it can be unit-tested with a fake
     * `sessions` service and a fake transport.
     */
    function installLastSession(sessions, opts = {}) {
      const io = {
        fetchLast: opts.io?.fetchLast ?? fetchLastSession,
        storeLast: opts.io?.storeLast ?? storeLastSession,
      }
      const wait = opts.wait ?? sleep
      const armFallbackMs = opts.armFallbackMs ?? ARM_FALLBACK_MS

      let armed = false
      let settled = false
      let lastRecorded = ''
      let lastRecordedAt = 0

      const recordCurrent = () => {
        if (!armed) return
        let state
        try {
          state = sessions.list.getSnapshot()
        } catch {
          return
        }
        const current = state?.current
        if (!isSessionId(current)) return
        // Guard 2: a blank bootstrap session is never worth remembering.
        const row = state?.byId?.[current]
        if (row && row.blank === true) return
        const now = Date.now()
        if (current === lastRecorded && now - lastRecordedAt < RECORD_THROTTLE_MS) return
        lastRecorded = current
        lastRecordedAt = now
        Promise.resolve(io.storeLast(current)).catch(() => {})
      }

      const armRecording = () => {
        if (armed) return
        armed = true
        recordCurrent()
      }

      const settle = () => {
        if (settled) return
        settled = true
        armRecording()
      }

      const reopen = async () => {
        let id
        try {
          id = await io.fetchLast()
        } catch {
          id = null
        }
        if (!isSessionId(id)) return settle()
        try {
          await openWhenReady(sessions, id, { wait, attempts: opts.attempts, interval: opts.interval })
        } finally {
          settle()
        }
      }

      // Guard 1: subscribe immediately so user navigation right after the
      // reopen attempt is never missed, but stay disarmed until settle().
      const dispose = sessions.list.subscribe(recordCurrent)

      // Fallback: if the reopen path never completes (no pointer, server down),
      // start recording anyway so the feature still works from the first manual
      // navigation onward.
      const timer = setTimeout(armRecording, armFallbackMs)

      return {
        reopen,
        dispose: () => {
          clearTimeout(timer)
          if (typeof dispose === 'function') dispose()
        },
      }
    }

    // --- plugin face -------------------------------------------------------

    const name = 'gui-last-session'

    /**
     * Services this bundle's `apply` reads off `ctx`. These are SERVICE NAMES
     * (like the engine's own client bundles: `dsh-client-ui-session` exports
     * `inject = ["sessions", "slots"]`), NOT the package names from
     * `dsh.client.inject` in package.json. The manifest package list drives
     * bundle load order in the browser module graph; this export drives the
     * cordis fiber's inject — omit it and `ctx.sessions` throws
     * "cannot get property sessions without inject" when the page loads.
     */
    const inject = ['sessions']

    /**
     * The engine activates this after `ctx.sessions` exists (see
     * `dsh.client.inject` in package.json). A client plugin registers cleanup
     * through `ctx.effect`.
     */
    function apply(ctx) {
      const sessions = ctx.sessions
      if (!sessions || !sessions.list || typeof sessions.list.getSnapshot !== 'function') {
        ctx.logger?.warn?.('[gui-last-session] sessions service unavailable; auto-restore disabled')
        return
      }
      const handle = installLastSession(sessions)
      if (typeof ctx.effect === 'function') {
        ctx.effect(() => () => handle.dispose(), 'gui-last-session')
      }
      handle.reopen().catch(() => {})
    }

    return {
      name,
      inject,
      apply,
      // Exported for tests / advanced consumers.
      installLastSession,
      isSessionId,
    }
  },
})
