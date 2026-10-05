// dsh-gui-last-session local behaviour tests (no network, no engine).
// Run: node tests/test.mjs

import assert from 'node:assert/strict'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { isSessionId, lastSessionFile, readLastSession, writeLastSession, rejectUntrusted } from '../lib/index.js'

// --- load the client bundle exactly the way the engine does -----------------
// The engine requires a lazy CJS factory registration, NOT plain ESM:
//   window.__ModuleLoader__.load({ id, factory })
// We mimic that contract here so the test exercises the real artifact. If the
// bundle were still plain ESM, this load would throw and the suite would fail —
// which is exactly the check we want.
const registrations = []
globalThis.window = {
  __ModuleLoader__: {
    load(registration) {
      registrations.push(registration)
    },
  },
}
await import('../client/client.js')
assert.equal(registrations.length, 1, 'bundle must register exactly one factory')
const registration = registrations[0]
assert.equal(registration.id, 'dsh-gui-last-session', 'factory id must be the package name')
assert.equal(typeof registration.factory, 'function', 'factory must be a function')

/** Materialize the factory the way the loader does: factory(require) -> exports. */
const clientExports = registration.factory((specifier) => {
  throw new Error(`unexpected external require: ${specifier}`)
})
const { installLastSession, resolveSessionOpener } = clientExports

// The browser-side cordis runner builds the fiber's inject list from the
// bundle's exported `inject` (SERVICE names). Without it, `ctx.sessions` in
// apply() throws "cannot get property sessions without inject" when the page
// loads — the exact failure the plugin hit. Keep this assertion in the dead
// center of the suite.
assert.ok(Array.isArray(clientExports.inject), 'factory must export an inject array')
assert.ok(
  clientExports.inject.includes('sessions'),
  `factory inject must include the sessions service (got: ${JSON.stringify(clientExports.inject)})`,
)
assert.equal(typeof clientExports.apply, 'function', 'factory must export apply')

let passed = 0
async function check(label, fn) {
  try {
    await fn()
    passed++
    console.log('  ✓', label)
  } catch (error) {
    console.error('  ✗', label)
    console.error('   ', error?.message ?? error)
    process.exitCode = 1
  }
}

console.log('dsh-gui-last-session tests\n--- host half ---')

await check('isSessionId accepts real ids and rejects junk', () => {
  assert.equal(isSessionId('session-abc123'), true)
  assert.equal(isSessionId('session-' + 'a'.repeat(200)), true)
  assert.equal(isSessionId('session-a'), false, 'too short')
  assert.equal(isSessionId('nope-abc123'), false, 'wrong prefix')
  assert.equal(isSessionId('session-' + 'a'.repeat(201)), false, 'too long')
  assert.equal(isSessionId('session-ab\ncd'), false, 'control char')
  assert.equal(isSessionId(12345), false, 'not a string')
  assert.equal(isSessionId(null), false)
  assert.equal(isSessionId(undefined), false)
})

await check('write then read round-trips the pointer', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-ls-'))
  try {
    const before = await readLastSession(home)
    assert.equal(before, null, 'no pointer initially')
    const written = await writeLastSession('session-roundtrip1', home)
    assert.equal(written.ok, true)
    const after = await readLastSession(home)
    assert.equal(after.sessionId, 'session-roundtrip1')
    assert.ok(Number.isFinite(after.updatedAt))
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

await check('write rejects an invalid session id and leaves no file', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-ls-'))
  try {
    await assert.rejects(() => writeLastSession('not-a-session', home), /invalid session id/)
    assert.equal(await readLastSession(home), null)
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

await check('corrupt / truncated pointer reads as null, never throws', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-ls-'))
  try {
    await writeFile(lastSessionFile(home), '{"sessionId": "session-trunc', 'utf8')
    assert.equal(await readLastSession(home), null, 'truncated JSON')
    await writeFile(lastSessionFile(home), 'null', 'utf8')
    assert.equal(await readLastSession(home), null, 'JSON null')
    await writeFile(lastSessionFile(home), '{"sessionId": "evil\\npath"}', 'utf8')
    assert.equal(await readLastSession(home), null, 'invalid id inside valid JSON')
    await writeFile(lastSessionFile(home), '{"sessionId": "session-ok1234", "updatedAt": "soon"}', 'utf8')
    const loose = await readLastSession(home)
    assert.equal(loose.sessionId, 'session-ok1234')
    assert.equal(loose.updatedAt, null, 'non-numeric updatedAt degrades to null')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

await check('write is atomic: no leftover tmp file', async () => {
  const home = await mkdtemp(join(tmpdir(), 'dsh-ls-'))
  try {
    await writeLastSession('session-atomic1', home)
    const raw = await readFile(lastSessionFile(home), 'utf8')
    assert.deepEqual(Object.keys(JSON.parse(raw)).sort(), ['sessionId', 'updatedAt'])
    // The check's own claim: the temp file used for the atomic rename must be gone,
    // and the home must contain nothing but the pointer (this used to assert neither).
    const entries = await readdir(home)
    assert.deepEqual(entries, ['last-session.json'], `unexpected leftovers: ${entries.join(', ')}`)
    assert.equal(entries.some((name) => name.endsWith('.tmp')), false)
    // A second write replaces the pointer in place, still leaving no temp file.
    await writeLastSession('session-atomic2', home)
    assert.deepEqual(await readdir(home), ['last-session.json'])
    assert.equal(JSON.parse(await readFile(lastSessionFile(home), 'utf8')).sessionId, 'session-atomic2')
  } finally {
    await rm(home, { recursive: true, force: true })
  }
})

console.log('\n--- client half ---')

/** Minimal fake of the ObservableSnapshot + ISessions surface the client uses. */
function fakeSessions(initial) {
  let state = { current: undefined, byId: {}, ...initial }
  const listeners = new Set()
  return {
    list: {
      getSnapshot: () => state,
      subscribe: (fn) => {
        listeners.add(fn)
        return () => listeners.delete(fn)
      },
    },
    open(id) {
      if (!Object.prototype.hasOwnProperty.call(state.byId, id)) {
        throw new Error(`unknown session: ${id}`)
      }
      state = { ...state, current: id }
      for (const fn of listeners) fn()
    },
    /** Test helper: mutate the snapshot and notify. */
    _set(next) {
      state = { ...state, ...next }
      for (const fn of listeners) fn()
    },
    /** Test helper: mutate WITHOUT notifying (models a missed list notification). */
    _setSilently(next) {
      state = { ...state, ...next }
    },
    _listeners: listeners,
  }
}

await check('records the most recently prompted session when the state has NO `current`', async () => {
  // Engine 0.2.0's list store is `{ ids, byId, phase, projectionsBySession }` — there is no
  // `current` field at all (session controller's projectList()). Reading it returned on the
  // very first line, silently and forever: that is what froze the pointer while every other
  // signal looked healthy. This test uses that exact shape.
  const sessions = fakeSessions({
    ids: ['session-old1', 'session-new2'],
    byId: {
      'session-old1': { id: 'session-old1', blank: false, updatedAt: 1, projectionValues: { sessionListMetadata: { blank: false, lastPromptAt: 1000 } } },
      'session-new2': { id: 'session-new2', blank: false, updatedAt: 2, projectionValues: { sessionListMetadata: { blank: false, lastPromptAt: 2000 } } },
    },
    projectionsBySession: {},
  })
  delete sessions.list.getSnapshot().current
  const stored = []
  const handle = installLastSession(sessions, {
    io: { fetchLast: async () => null, storeLast: async (id) => stored.push(id) },
    armFallbackMs: 5,
    wait: () => Promise.resolve(),
    attempts: 1,
  })
  await handle.reopen()
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(stored, ['session-new2'], 'the one with the newest prompt wins')
  handle.dispose()
})

await check('reads the projection metadata from projectionsBySession as well as the row', async () => {
  // projectList() copies the projections onto the row only when the manager attached them;
  // otherwise they live on the list state. Both places must be understood.
  const sessions = fakeSessions({
    ids: ['session-xyz1'],
    byId: { 'session-xyz1': { id: 'session-xyz1', blank: true, updatedAt: 5 } },
    projectionsBySession: { 'session-xyz1': { values: { sessionListMetadata: { blank: true, lastPromptAt: 4321 } } } },
  })
  delete sessions.list.getSnapshot().current
  const stored = []
  const handle = installLastSession(sessions, {
    io: { fetchLast: async () => null, storeLast: async (id) => stored.push(id) },
    armFallbackMs: 5,
    wait: () => Promise.resolve(),
    attempts: 1,
  })
  await handle.reopen()
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(stored, ['session-xyz1'], 'found through the state-level projection')
  handle.dispose()
})

await check('skips subagent rows; an explicit `current` still wins when present', async () => {
  const base = {
    ids: ['session-main1', 'session-sub1'],
    byId: {
      'session-main1': { id: 'session-main1', blank: false, updatedAt: 1, projectionValues: { sessionListMetadata: { blank: false, lastPromptAt: 100 } } },
      'session-sub1': { id: 'session-sub1', blank: false, updatedAt: 9, origin: 'subagent', parentId: 'session-main1', projectionValues: { sessionListMetadata: { blank: false, lastPromptAt: 999 } } },
    },
  }
  const noCurrent = fakeSessions({ ...base, projectionsBySession: {} })
  delete noCurrent.list.getSnapshot().current
  const storedA = []
  const hA = installLastSession(noCurrent, {
    io: { fetchLast: async () => null, storeLast: async (id) => storedA.push(id) },
    armFallbackMs: 5,
    wait: () => Promise.resolve(),
    attempts: 1,
  })
  await hA.reopen()
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(storedA, ['session-main1'], 'a subagent is not "the last conversation"')
  hA.dispose()

  const withCurrent = fakeSessions({ ...base, current: 'session-main1', projectionsBySession: {} })
  const storedB = []
  const hB = installLastSession(withCurrent, {
    io: { fetchLast: async () => null, storeLast: async (id) => storedB.push(id) },
    armFallbackMs: 5,
    wait: () => Promise.resolve(),
    attempts: 1,
  })
  await hB.reopen()
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(storedB, ['session-main1'])
  hB.dispose()
})

await check('resolveSessionOpener: the workspace API wins, sessions.open is the fallback', () => {
  // Engine 0.2.0 REMOVED sessions.open; the UI's entry point is uiWorkspace.openSession.
  // Using the removed method meant "reopen" silently failed for 30s on every launch.
  const calls = []
  const uiWorkspace = { openSession: (id) => calls.push(`ui:${id}`) }
  const sessions = { open: (id) => calls.push(`svc:${id}`) }

  const modern = resolveSessionOpener({ uiWorkspace, sessions })
  modern('session-aaaa1111')
  assert.deepEqual(calls, ['ui:session-aaaa1111'], 'prefers the workspace API')

  const legacy = resolveSessionOpener({ uiWorkspace: undefined, sessions })
  legacy('session-bbbb2222')
  assert.deepEqual(calls, ['ui:session-aaaa1111', 'svc:session-bbbb2222'], 'falls back on older engines')

  // Neither -> no opener (the caller then says so instead of retrying something impossible).
  assert.strictEqual(resolveSessionOpener({ uiWorkspace: {}, sessions: {} }), null)
  assert.strictEqual(resolveSessionOpener({}), null)
  assert.strictEqual(resolveSessionOpener({ uiWorkspace: null, sessions: null }), null)
})

await check('reopen uses the injected opener, and gives up at once when there is none', async () => {
  const target = 'session-cccc3333'
  const state = { byId: { [target]: { id: target, blank: false, updatedAt: 1 } } }
  const io = { fetchLast: async () => target, storeLast: async () => {} }
  const sessionsStub = () => ({ list: { getSnapshot: () => state, subscribe: () => () => {} } })

  // With an opener the target is opened.
  const opened = []
  const withOpener = installLastSession(sessionsStub(), {
    io,
    open: (id) => opened.push(id),
    wait: () => Promise.resolve(),
    attempts: 3,
    armFallbackMs: 5,
  })
  await withOpener.reopen()
  assert.deepEqual(opened, [target], 'the injected opener was used')
  withOpener.dispose()

  // Without one it must not poll for 30s before giving up.
  const noOpener = installLastSession(sessionsStub(), {
    io,
    open: null,
    wait: () => new Promise((r) => setTimeout(r, 1000)),
    attempts: 200,
    interval: 1000,
    armFallbackMs: 5,
  })
  const started = Date.now()
  await noOpener.reopen()
  assert.ok(Date.now() - started < 500, 'no opener -> no pointless polling')
  noOpener.dispose()
})

await check('a reopen whose target is not listed yet is retried when it appears', async () => {
  // The list arrives over the network and is workspace-scoped, so the stored id is often
  // missing on the first attempt; the engine's own bootstrap navigation can also land
  // after us. Retrying on the safety-net tick is what turns "sometimes opens a new
  // session" into a reliable restore.
  const target = 'session-retry77'
  const sessions = fakeSessions({ ids: [], byId: {} }) // target not listed yet
  delete sessions.list.getSnapshot().current
  const opened = []
  const reports = []
  const handle = installLastSession(sessions, {
    io: { fetchLast: async () => target, storeLast: async () => {}, onReport: (t) => reports.push(t) },
    open: (id) => opened.push(id),
    armFallbackMs: 5,
    recheckMs: 5,
    wait: () => Promise.resolve(),
    attempts: 2, // fail fast, then rely on the retry
  })
  await handle.reopen()
  assert.deepEqual(opened, [], 'nothing to open while the session is not listed')
  assert.ok(
    reports.some((r) => r.includes('target ' + target)),
    `the attempt must be reported, got: ${JSON.stringify(reports)}`,
  )

  // Now the session shows up in the list.
  sessions._set({ ids: [target], byId: { [target]: { id: target, blank: false, updatedAt: 1 } } })
  await new Promise((r) => setTimeout(r, 60))
  assert.deepEqual(opened, [target], 'the retry opened it')
  assert.ok(
    reports.some((r) => r.includes('retried successfully')),
    `the successful retry must be reported, got: ${JSON.stringify(reports)}`,
  )
  handle.dispose()
})

await check('prefers the session the engine main view is showing (retainedBy.mainView)', async () => {
  // The engine marks the displayed session by retaining it with { source: "mainView" }, and
  // its own UI answers `isMain()` from exactly that. Recency is a poor substitute: open an
  // OLDER conversation, read it, restart — the newest-prompted session is then the wrong one
  // to reopen, which is the complaint this plugin exists to fix.
  const sessions = fakeSessions({
    ids: ['session-old999', 'session-new999'],
    byId: {
      'session-old999': {
        id: 'session-old999',
        blank: false,
        updatedAt: 1,
        retainedBy: { mainView: 1 },
        projectionValues: { sessionListMetadata: { blank: false, lastPromptAt: 1000 } },
      },
      'session-new999': {
        id: 'session-new999',
        blank: false,
        updatedAt: 2,
        retainedBy: {},
        projectionValues: { sessionListMetadata: { blank: false, lastPromptAt: 2000 } },
      },
    },
    projectionsBySession: {},
  })
  delete sessions.list.getSnapshot().current
  const stored = []
  const handle = installLastSession(sessions, {
    io: { fetchLast: async () => null, storeLast: async (id) => stored.push(id) },
    armFallbackMs: 5,
    wait: () => Promise.resolve(),
    attempts: 1,
  })
  await handle.reopen()
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(stored, ['session-old999'], 'the displayed session wins over the most recent prompt')
  handle.dispose()
})

await check('records a session the host says has been prompted (blank bit still conservative)', async () => {
  // Engine 0.2.0's row `blank` is a presentation bit that the client keeps conservative
  // until the host's sessionListMetadata.blank === false arrives; `lastPromptAt` is set
  // on the first committed user/message. A session the user has typed in must be
  // recorded even while the presentation bit still reads blank — that staleness is what
  // left the pointer frozen for days.
  const sessions = fakeSessions({
    current: 'session-used1',
    byId: {
      'session-used1': {
        id: 'session-used1',
        blank: true,
        projectionValues: { sessionListMetadata: { blank: true, lastPromptAt: 1790000000000 } },
      },
    },
  })
  const stored = []
  const handle = installLastSession(sessions, {
    io: { fetchLast: async () => null, storeLast: async (id) => stored.push(id) },
    armFallbackMs: 5,
    wait: () => Promise.resolve(),
    attempts: 1,
  })
  await handle.reopen()
  sessions._set({})
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(stored, ['session-used1'], 'a prompted session is remembered')
  handle.dispose()
})

await check('the safety net records a change the subscription never announced', async () => {
  // The subscription is the primary trigger, but a missed notification used to mean the
  // pointer stayed frozen indefinitely — a silent failure nobody notices until a restart
  // lands somewhere unexpected. The slow re-check must catch it.
  const sessions = fakeSessions({
    current: 'session-bootstrap',
    byId: { 'session-bootstrap': { id: 'session-bootstrap', blank: true } },
  })
  const stored = []
  const handle = installLastSession(sessions, {
    io: { fetchLast: async () => null, storeLast: async (id) => stored.push(id) },
    armFallbackMs: 5,
    recheckMs: 5,
    wait: () => Promise.resolve(),
    attempts: 1,
  })
  await handle.reopen()
  // Silent mutation: no subscriber is called.
  sessions._setSilently({
    current: 'session-silent1',
    byId: { 'session-silent1': { id: 'session-silent1', blank: false } },
  })
  await new Promise((r) => setTimeout(r, 40))
  assert.deepEqual(stored, ['session-silent1'], 'the re-check picked it up')
  handle.dispose()
})

await check('does NOT record the blank bootstrap session (the v2 bug)', async () => {
  const sessions = fakeSessions({
    current: 'session-bootstrap',
    byId: { 'session-bootstrap': { id: 'session-bootstrap', blank: true } },
  })
  const stored = []
  const handle = installLastSession(sessions, {
    io: { fetchLast: async () => null, storeLast: async (id) => stored.push(id) },
    armFallbackMs: 5,
    wait: () => Promise.resolve(),
    attempts: 1,
  })
  await handle.reopen()
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(stored, [], 'blank bootstrap must never be stored')
  handle.dispose()
})

await check('records a real session selected after settle', async () => {
  const sessions = fakeSessions({
    current: 'session-bootstrap',
    byId: { 'session-bootstrap': { id: 'session-bootstrap', blank: true } },
  })
  const stored = []
  const handle = installLastSession(sessions, {
    io: { fetchLast: async () => null, storeLast: async (id) => stored.push(id) },
    armFallbackMs: 5,
    wait: () => Promise.resolve(),
    attempts: 1,
  })
  await handle.reopen()
  sessions._set({
    current: 'session-real1',
    byId: { 'session-bootstrap': { blank: true }, 'session-real1': { id: 'session-real1', blank: false } },
  })
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(stored, ['session-real1'])
  handle.dispose()
})

await check('stays disarmed until the reopen attempt settles', async () => {
  const sessions = fakeSessions({ current: 'session-bootstrap', byId: {} })
  const stored = []
  let releaseFetch
  const gate = new Promise((r) => {
    releaseFetch = r
  })
  const handle = installLastSession(sessions, {
    io: {
      fetchLast: async () => {
        await gate
        return null
      },
      storeLast: async (id) => stored.push(id),
    },
    // Keep the fallback timer out of the way so this asserts the settle-gate
    // alone (the timer is covered by its own test below).
    armFallbackMs: 60_000,
    wait: () => Promise.resolve(),
    attempts: 1,
  })
  const reopening = handle.reopen()
  // Engine bootstrap navigates while the reopen is still in flight.
  sessions._set({ current: 'session-bootstrap-nav', byId: {} })
  await new Promise((r) => setTimeout(r, 10))
  assert.deepEqual(stored, [], 'nothing recorded before settle')
  releaseFetch()
  await reopening
  handle.dispose()
})

await check('fallback timer arms recording when reopen never settles', async () => {
  const sessions = fakeSessions({ current: 'session-real2', byId: {} })
  const stored = []
  const handle = installLastSession(sessions, {
    io: { fetchLast: async () => null, storeLast: async (id) => stored.push(id) },
    armFallbackMs: 5,
    wait: () => Promise.resolve(),
    attempts: 1,
  })
  await new Promise((r) => setTimeout(r, 40))
  assert.deepEqual(stored, ['session-real2'], 'recording armed by fallback timer')
  handle.dispose()
})

await check('reopen waits for the target to appear, then opens it', async () => {
  // The list arrives LATE (like the real network fetch): the row only shows up
  // on the 3rd poll. Injected from inside getSnapshot so the test is
  // deterministic — a timer-based injection would race the poll loop.
  const sessions = fakeSessions({ current: undefined, byId: {} })
  let polls = 0
  const realSnapshot = sessions.list.getSnapshot
  sessions.list.getSnapshot = () => {
    polls += 1
    if (polls === 3) sessions._set({ byId: { 'session-target1': { id: 'session-target1', blank: false } } })
    return realSnapshot()
  }
  const handle = installLastSession(sessions, {
    io: { fetchLast: async () => 'session-target1', storeLast: async () => {} },
    wait: () => Promise.resolve(),
    attempts: 200,
    interval: 1,
    armFallbackMs: 60_000,
  })
  await handle.reopen()
  assert.equal(sessions.list.getSnapshot().current, 'session-target1')
  assert.ok(polls >= 4, `should have polled until the row appeared (polled ${polls})`)
  handle.dispose()
})

await check('reopen gives up cleanly when the target never appears', async () => {
  const sessions = fakeSessions({ current: undefined, byId: {} })
  const handle = installLastSession(sessions, {
    io: { fetchLast: async () => 'session-gone1', storeLast: async () => {} },
    wait: () => Promise.resolve(),
    attempts: 3,
    interval: 1,
    armFallbackMs: 60_000,
  })
  await handle.reopen()
  assert.equal(sessions.list.getSnapshot().current, undefined, 'nothing opened')
  handle.dispose()
})

await check('a throwing snapshot does not abort the wait', async () => {
  // The snapshot throws a few times (service not ready) BEFORE the row exists.
  // The wait must survive those throws and still open the session once both
  // the throw-storm ends and the row appears.
  const sessions = fakeSessions({ current: undefined, byId: {} })
  const realSnapshot = sessions.list.getSnapshot
  let calls = 0
  sessions.list.getSnapshot = () => {
    calls += 1
    if (calls <= 3) throw new Error('not ready')
    // The row shows up only after the throws have stopped.
    if (calls === 4) sessions._set({ byId: { 'session-late1': { id: 'session-late1', blank: false } } })
    return realSnapshot()
  }
  const handle = installLastSession(sessions, {
    io: { fetchLast: async () => 'session-late1', storeLast: async () => {} },
    wait: () => Promise.resolve(),
    attempts: 50,
    interval: 1,
    armFallbackMs: 60_000,
  })
  await handle.reopen()
  assert.equal(sessions.list.getSnapshot().current, 'session-late1', 'recovered after throws')
  assert.ok(calls > 4, `should keep polling past the throws (polled ${calls})`)
  handle.dispose()
})

await check('invalid stored pointer is ignored', async () => {
  const sessions = fakeSessions({ current: undefined, byId: {} })
  const handle = installLastSession(sessions, {
    io: { fetchLast: async () => 'javascript:alert(1)', storeLast: async () => {} },
    wait: () => Promise.resolve(),
    armFallbackMs: 0,
  })
  await handle.reopen()
  assert.equal(sessions.list.getSnapshot().current, undefined)
  handle.dispose()
})

await check('dispose stops recording', async () => {
  const sessions = fakeSessions({ current: 'session-b1', byId: {} })
  const stored = []
  const handle = installLastSession(sessions, {
    io: { fetchLast: async () => null, storeLast: async (id) => stored.push(id) },
    armFallbackMs: 5,
    wait: () => Promise.resolve(),
    attempts: 1,
  })
  await handle.reopen()
  handle.dispose()
  sessions._set({ current: 'session-after-dispose' })
  await new Promise((r) => setTimeout(r, 20))
  assert.deepEqual(stored, [])
})

// --- route trust fence -------------------------------------------------------
// These routes serve usage/balance and settings writes, so the fence is the
// difference between "only the engine page can reach it" and "any local process, or
// a page that rebound a hostname to 127.0.0.1, can". The assertions pin the
// fail-closed default and the status mapping.
await check('rejectUntrusted fails closed when the fence is unavailable', () => {
  const mk = () => ({ statusCode: 0, ended: 0, body: null, end(v) { this.ended += 1; this.body = v } })
  for (const ctx of [{ get: () => undefined }, { get: () => ({}) }, { get: () => null }, {}]) {
    const res = mk()
    assert.equal(rejectUntrusted(ctx, {}, res), true, 'must reject when connection is missing')
    assert.equal(res.statusCode, 403)
    assert.equal(res.ended, 1, 'the response must be ended exactly once')
  }
})

await check('rejectUntrusted mirrors the engine fence and lets allowed requests through', () => {
  const mk = () => ({ statusCode: 0, ended: 0, body: null, end(v) { this.ended += 1; this.body = v } })
  // allowed: the engine fence returns undefined
  let res = mk()
  assert.equal(rejectUntrusted({ get: () => ({ requestRejection: () => undefined }) }, {}, res), false)
  assert.equal(res.ended, 0, 'the fence must not answer an allowed request')
  // unauthenticated
  res = mk()
  assert.equal(rejectUntrusted({ get: () => ({ requestRejection: () => 401 }) }, {}, res), true)
  assert.equal(res.statusCode, 401)
  assert.equal(res.body, 'unauthorized')
  // untrusted host/origin
  res = mk()
  assert.equal(rejectUntrusted({ get: () => ({ requestRejection: () => 403 }) }, {}, res), true)
  assert.equal(res.statusCode, 403)
  assert.equal(res.body, 'forbidden')
  // the raw request is handed to the engine fence unchanged
  const marker = { headers: { host: '127.0.0.1:1' } }
  let seen = null
  rejectUntrusted({ get: () => ({ requestRejection: (r) => { seen = r; return undefined } }) }, marker, mk())
  assert.equal(seen, marker)
})

console.log(`\n${process.exitCode ? 'FAILED' : `all ${passed} passed`}`)
