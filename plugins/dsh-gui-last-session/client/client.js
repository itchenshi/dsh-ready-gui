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

    /** Where the host half accepts one line of reopen diagnostics (it logs them). */
    const REPORT_PATH = '/gui-last-session/report'

    /** How long a failed reopen keeps retrying when the target shows up later. */
    const REOPEN_RETRY_WINDOW_MS = 300000

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

    /**
     * Send one line of reopen diagnostics to the host half, which logs it.
     *
     * The recording side reaches the app log through the host's own log line; the reopen
     * side had no such path, so its failures were invisible. Best-effort by design.
     */
    function reportToHost(text) {
      try {
        fetch(REPORT_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ text: String(text) }),
          keepalive: true,
        }).catch(() => {})
      } catch {
        /* diagnostics must never break the feature */
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
     * How should a session be opened on this engine?
     *
     * Engine 0.2.0 **removed** the `sessions.open(id)` method the client half used to call
     * (the service now exposes retain/using/create/fork/scope/… and nothing named `open`),
     * and the UI's own entry point became `ctx.uiWorkspace.openSession(id)`. Calling the
     * old method therefore threw on every attempt, the wait loop retried it for the full
     * ~30s and then gave up — which is why starting the app opened a NEW session while the
     * pointer was recorded correctly all along.
     *
     * Both are supported here: the workspace API when the host has it, the old method
     * otherwise (older engines, and any host that still exposes it).
     *
     * @returns a function that opens a session id, or null when neither exists (the caller
     *   then says so instead of retrying something impossible).
     */
    function resolveSessionOpener({ uiWorkspace, sessions }) {
      if (uiWorkspace && typeof uiWorkspace.openSession === 'function') {
        return (id) => uiWorkspace.openSession(String(id))
      }
      if (sessions && typeof sessions.open === 'function') {
        return (id) => sessions.open(String(id))
      }
      return null
    }

    /**
     * Wait until `id` is present in the list snapshot, then open it.
     * @returns true when the session was opened.
     */
    async function openWhenReady(sessions, id, opts = {}) {
      const wait = opts.wait ?? sleep
      const attempts = opts.attempts ?? WAIT_ATTEMPTS
      const interval = opts.interval ?? WAIT_INTERVAL_MS
      const open = opts.open ?? (typeof sessions?.open === 'function' ? (sid) => sessions.open(sid) : null)
      if (open === null) return false
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
            open(id)
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
        // Reopen diagnostics: the host half logs them, which is how "it opened a new
        // session" becomes answerable (no pointer / target never listed / no opener API).
        onReport: opts.io?.onReport ?? reportToHost,
      }
      const wait = opts.wait ?? sleep
      const armFallbackMs = opts.armFallbackMs ?? ARM_FALLBACK_MS
      const recheckMs = opts.recheckMs ?? RECORD_RECHECK_MS

      let armed = false
      let settled = false
      let lastRecorded = ''
      /** The id we are trying to reopen, while the attempt is still unfinished. */
      let pendingId = null
      /** Set to the id once it was opened (so retries stop), null while unopened. */
      let reopenOutcome = null
      /** Retries stop after this, so the plugin never yanks the user back much later. */
      const retryDeadline = Date.now() + REOPEN_RETRY_WINDOW_MS
      const report = (text) => {
        try {
          if (typeof io.onReport === 'function') io.onReport(text)
          else reportToHost(text)
        } catch {
          /* diagnostics are best-effort */
        }
      }

      /** The session projection metadata for one row (see the note below on the two places). */
      const metadataFor = (state, id) =>
        state?.byId?.[id]?.projectionValues?.sessionListMetadata ??
        state?.projectionsBySession?.[id]?.values?.sessionListMetadata ??
        null

      const isSubagentRow = (row) => Boolean(row) && (row.origin === 'subagent' || row.parentId !== undefined)

      /**
       * Has this session actually been used?
       *
       * `blank` is a PRESENTATION bit ("an unused New-Session slot, safe to reuse") and the
       * client keeps it conservatively `true` until the host's
       * `sessionListMetadata.blank === false` arrives. The same projection carries
       * `lastPromptAt` (set on the first committed `user/message`), which is a direct "the
       * user used this" signal and does not depend on that bit ever being reconciled.
       *
       * The projection reaches the list state in TWO places — the state's
       * `projectionsBySession[id].values`, and a copy on the row as `projectionValues`
       * (only when the manager had attached one) — so both are consulted.
       */
      const rowLooksUsed = (state, id) => {
        const row = state?.byId?.[id]
        if (row && row.blank === false) return true
        return typeof metadataFor(state, id)?.lastPromptAt === 'number'
      }

      /** Newest user prompt first, then newest activity. */
      const mostRecentlyUsedFirst = (state) => {
        const rows = state?.byId ?? {}
        const ids = Array.isArray(state?.ids) && state.ids.length > 0 ? state.ids : Object.keys(rows)
        const promptAt = (id) => {
          const value = metadataFor(state, id)?.lastPromptAt
          return typeof value === 'number' ? value : -1
        }
        const updatedAt = (id) => (typeof rows[id]?.updatedAt === 'number' ? rows[id].updatedAt : 0)
        return [...ids].sort((a, b) => promptAt(b) - promptAt(a) || updatedAt(b) - updatedAt(a))
      }

      /**
       * Which session is "the last conversation"?
       *
       * `state.current` is used when present, but **engine 0.2.0 does not publish it**: the
       * session controller's list store is `{ ids, byId, phase, projectionsBySession }`
       * (see its `projectList()` → `this.list.set({ ids, byId, phase, projectionsBySession })`),
       * so `current` is always `undefined` and the previous implementation returned on its
       * very first line — silently, forever. That is exactly why the pointer stopped
       * moving while everything looked healthy: the plugin loaded, its route answered, and
       * nothing was ever written.
       *
       * Without that field, the honest definition of "the last conversation" is the one the
       * user most recently prompted in (then the most recently active), skipping untouched
       * bootstrap sessions and subagent rows.
       */
      const pickLastSession = (state) => {
        const explicit = state?.current
        if (isSessionId(explicit) && !isSubagentRow(state?.byId?.[explicit])) {
          // A session with no row yet simply means the list has not caught up — trust it,
          // as before. But a row that says "untouched" must never be recorded: that is the
          // blank-bootstrap bug this plugin already shipped once.
          const row = state?.byId?.[explicit]
          if (!row || rowLooksUsed(state, explicit)) return explicit
        }
        // The row the ENGINE's main view is currently showing. `retainedBy.mainView` is the
        // engine's own "which session is displayed" signal — the UI retains what it shows
        // (`replaceMain` → `retain(id, { source: "mainView" })`) and dsh-client-ui-session
        // answers `isMain()` from exactly this. Recency alone is a poor substitute: switch
        // to an older conversation, read it, restart — and the newest-prompted session is
        // the wrong one to reopen, which is the complaint this plugin exists to fix.
        const shown = Object.entries(state?.byId ?? {}).find(([, row]) => (row?.retainedBy?.mainView ?? 0) > 0)
        if (shown !== undefined && isSessionId(shown[0]) && !isSubagentRow(shown[1])) return shown[0]
        for (const id of mostRecentlyUsedFirst(state)) {
          if (!isSessionId(id)) continue
          if (isSubagentRow(state?.byId?.[id])) continue
          if (!rowLooksUsed(state, id)) continue
          return id
        }
        return null
      }

      const recordCurrent = () => {
        if (!armed) return
        let state
        try {
          state = sessions.list.getSnapshot()
        } catch {
          return
        }
        const current = pickLastSession(state)
        if (!isSessionId(current)) return
        // 只在**指针真的变了**时写：订阅源是会话列表投影，会话进行中它会持续变化
        // （running/title/updatedAt…），按 1.5s 节流重写等于同一份指针被反复 POST，
        // 宿主每次都要 mkdir + writeFile + rename —— 而客户端根本不读 updatedAt。
        if (current === lastRecorded) return
        // Only remember it once the host accepted it: assigning optimistically meant a
        // failed write was never retried (the safety net returns early on an unchanged
        // pointer), so a switch made while the host was restarting was lost silently.
        Promise.resolve(io.storeLast(current))
          .then(() => {
            lastRecorded = current
            if (typeof io.onRecord === 'function') io.onRecord(current)
          })
          .catch(() => {
            lastRecorded = ''
          })
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
        // Say what we found, every time. The recording side has a host-side log line, but
        // the reopen side was completely silent — so "it opened a new session" could mean
        // "no pointer", "the target never showed up", "no API to open it" or "the engine
        // navigated away afterwards", and there was no way to tell them apart.
        if (!isSessionId(id)) {
          report('reopen: no usable pointer')
          return settle()
        }
        report(`reopen: target ${id}`)
        pendingId = id // retried by reopenPending() if it is not listable yet
        const outcome = await (async () => {
          try {
            return await openWhenReady(sessions, id, {
              wait,
              attempts: opts.attempts,
              interval: opts.interval,
              open: opts.open,
            })
          } finally {
            settle()
          }
        })()
        reopenOutcome = outcome === true ? id : null
        report(
          outcome === true
            ? `reopen: open() called for ${id}`
            : `reopen: FAILED — the session never appeared in the list (${opts.attempts ?? WAIT_ATTEMPTS} attempts)`,
        )
        return outcome
      }

      /**
       * Retry a failed reopen when the list later shows the target.
       *
       * The session list arrives over the network and is workspace-scoped, so the stored
       * id may simply be missing during the first attempt — and the engine's own bootstrap
       * navigation can also land after us. Retrying on the safety-net tick covers both,
       * within a bounded window so the plugin never yanks the user back much later.
       */
      const reopenPending = () => {
        if (reopenOutcome !== null || pendingId === null) return
        if (Date.now() > retryDeadline) {
          pendingId = null
          report('reopen: giving up (the target never became listable)')
          return
        }
        const state = (() => {
          try {
            return sessions.list.getSnapshot()
          } catch {
            return undefined
          }
        })()
        if (!state?.byId || !Object.prototype.hasOwnProperty.call(state.byId, pendingId)) return
        try {
          if (typeof opts.open !== 'function') {
            pendingId = null
            report('reopen: no way to open a session on this engine')
            return
          }
          opts.open(pendingId)
          reopenOutcome = pendingId
          pendingId = null
          report(`reopen: retried successfully for ${reopenOutcome}`)
        } catch (error) {
          report(`reopen: retry failed — ${String((error && error.message) || error)}`)
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
      const recheck = setInterval(() => {
        recordCurrent()
        reopenPending()
      }, recheckMs)
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
      // Engine 0.2.0 has no `sessions.open`; the UI entry point is
      // `uiWorkspace.openSession(id)` ("select a Session and show its Conversation").
      //
      // Resolved LAZILY, at the moment we actually want to open something: `uiWorkspace` is
      // provided by another client plugin and may not be mounted yet while this fiber is
      // activating. Looking it up once here meant a null opener on a slow boot — the plugin
      // would then disable itself and stay disabled for the whole session.
      const open = (id) => {
        const resolved =
          resolveSessionOpener({ uiWorkspace: ctx.get?.('uiWorkspace'), sessions }) ??
          resolveSessionOpener({ uiWorkspace: ctx.uiWorkspace, sessions })
        if (resolved === null) {
          throw new Error('this engine exposes no way to open a session')
        }
        resolved(id)
      }
      const handle = installLastSession(sessions, {
        open,
        io: {
          // One line per pointer move (a session switch), so support can tell "it never
          // recorded" from "it recorded and something else went wrong".
          onRecord: (id) => ctx.logger?.info?.(`[gui-last-session] remembered ${id}`),
          // Reopen diagnostics. Posted to the host half as well as logged locally: the
          // browser console only reaches the app's own log when the shell runs with its
          // page-debug flag, so relying on it alone would leave this invisible — which is
          // exactly the gap that made "it opens a new session" undiagnosable.
          onReport: (text) => {
            ctx.logger?.info?.(`[gui-last-session] ${text}`)
            reportToHost(text)
          },
        },
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
      resolveSessionOpener,
    }
  },
})
