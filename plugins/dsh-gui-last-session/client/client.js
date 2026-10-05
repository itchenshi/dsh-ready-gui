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
    /** How often the safety net re-reads the snapshot (see installLastSession). */
    const RECORD_RECHECK_MS = 15000

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
        // Called after a pointer actually moves. Without it this half is completely
        // silent: "never recorded" and "recorded but ineffective" look identical when
        // the user reports the feature not working (which is exactly how this bug
        // reached a user). apply() wires it to ctx.logger.
        onRecord: opts.io?.onRecord ?? null,
      }
      const wait = opts.wait ?? sleep
      const armFallbackMs = opts.armFallbackMs ?? ARM_FALLBACK_MS
      const recheckMs = opts.recheckMs ?? RECORD_RECHECK_MS

      let armed = false
      let settled = false
      let lastRecorded = ''

      /**
       * Has this session actually been used?
       *
       * Engine 0.2.0's `blank` is a PRESENTATION bit ("an unused New-Session slot, safe to
       * reuse"), and the client keeps it conservatively `true` until the host's
       * `sessionListMetadata.blank === false` reaches it — that projection only flips on
       * the first `turn/start`. Relying on it alone is how this plugin went quiet while
       * the pointer stayed frozen: the row reads blank even for a session the user has
       * been typing in. The projection also carries `lastPromptAt` (set on the first
       * committed `user/message`), which is a direct "the user used this" signal and does
       * not depend on that bit ever being reconciled.
       *
       * So: used = the host says not-blank, OR the session has a recorded user prompt.
       * A genuinely untouched bootstrap session satisfies neither and is still skipped.
       */
      const rowLooksUsed = (row) => {
        if (!row) return false
        if (row.blank === false) return true
        const metadata = row.projectionValues?.sessionListMetadata
        return metadata !== null && metadata !== undefined && metadata.lastPromptAt !== null && metadata.lastPromptAt !== undefined
      }

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
        // Guard 2: an untouched bootstrap session is never worth remembering. A session
        // with NO row yet is a different case — the list simply has not caught up — and
        // is still recorded, exactly as before.
        const row = state?.byId?.[current]
        if (row && !rowLooksUsed(row)) return
        // 子会话（subagent）不是「上次所在会话」：它只在当前 lineage 链上才会被投影出来，
        // 下次启动按 id 找不到 → 恢复静默失效（还会空转约 30s）。跳过它。
        if (row && (row.origin === 'subagent' || row.parentId !== undefined)) return
        // 只在**指针真的变了**时写：订阅源是会话列表投影，会话进行中它会持续变化
        // （running/title/updatedAt…），按 1.5s 节流重写等于同一份指针被反复 POST，
        // 宿主每次都要 mkdir + writeFile + rename —— 而客户端根本不读 updatedAt。
        if (current === lastRecorded) return
        lastRecorded = current
        Promise.resolve(io.storeLast(current))
          .then(() => {
            if (typeof io.onRecord === 'function') io.onRecord(current)
          })
          .catch(() => {})
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

      // Safety net: the subscription is the primary trigger, but a frozen pointer is a
      // SILENT failure — the feature just quietly stops remembering the session and
      // nobody notices until a restart lands somewhere unexpected (observed: the pointer
      // sat unchanged for six days of active use). Re-reading the snapshot on a slow
      // timer cannot miss a state change the way a single missed notification can, and
      // it costs one snapshot read: recordCurrent() returns immediately when the current
      // session is unchanged.
      const recheck = setInterval(recordCurrent, recheckMs)
      // In Node (the unit tests import this bundle) an interval keeps the event loop
      // alive, so the suite would hang instead of exiting. `unref` is a no-op guard in
      // the browser, where setInterval returns a number.
      if (typeof recheck?.unref === 'function') recheck.unref()

      return {
        reopen,
        dispose: () => {
          clearTimeout(timer)
          clearInterval(recheck)
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
      const handle = installLastSession(sessions, {
        // One line per pointer move (a session switch), so support can tell "it never
        // recorded" from "it recorded and something else went wrong".
        io: { onRecord: (id) => ctx.logger?.info?.(`[gui-last-session] remembered ${id}`) },
      })
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
