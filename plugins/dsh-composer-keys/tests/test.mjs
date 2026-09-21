// dsh-composer-keys local behaviour tests (no network, no engine, no DOM).
// Run: node tests/test.mjs

import assert from 'node:assert/strict'

// Host-side pure helpers (./lib/index.js pulls in schemastery, which the GUI
// checkout does not ship — the pure half lives in ./lib/shared.js).
import { ACTIONS, DEFAULTS, normalizePrefs, rejectUntrusted, sanitizePatch } from '../lib/shared.js'

// --- load the client bundle exactly the way the engine does -----------------
// The engine requires a lazy CJS factory registration (NOT plain ESM):
//   window.__ModuleLoader__.load({ id, factory })
const registrations = []
globalThis.window = {
  __ModuleLoader__: {
    load(registration) {
      registrations.push(registration)
    },
  },
}
// Node has no DOM: stub the constructor so the emitted-event shape is assertable.
globalThis.KeyboardEvent = class KeyboardEvent {
  constructor(type, init = {}) {
    this.type = type
    Object.assign(this, init)
  }
}
await import('../client/client.js')
assert.equal(registrations.length, 1, 'bundle must register exactly one factory')
const registration = registrations[0]
assert.equal(registration.id, 'dsh-composer-keys', 'factory id must be the package name')

const clientExports = registration.factory((specifier) => {
  if (specifier === 'react' || specifier === 'react/jsx-runtime') {
    // Minimal stubs: the pure helpers under test never render.
    return {
      useState: (v) => [v, () => {}],
      useSyncExternalStore: (_sub, get) => get(),
      useCallback: (f) => f,
      createContext: () => ({}),
      jsx: () => null,
      jsxs: () => null,
    }
  }
  throw new Error(`unexpected external require: ${specifier}`)
})

assert.ok(Array.isArray(clientExports.inject), 'factory must export an inject array')
for (const svc of ['slots', 'locale']) {
  assert.ok(clientExports.inject.includes(svc), `inject must include ${svc}`)
}

const {
  COMPOSER_SELECTOR,
  ENGINE_DEFAULT,
  FALLBACK_DEFAULTS,
  GESTURES,
  ROW_CSS,
  STYLE_ID,
  createPrefsStore,
  decideGesture,
  engineGestureEvent,
  gestureOf,
  isComposing,
} = clientExports

let passed = 0
function check(label, fn) {
  try {
    fn()
    passed += 1
    console.log('  ✓', label)
  } catch (error) {
    console.error('  ✗', label)
    console.error('   ', error?.message ?? error)
    process.exitCode = 1
  }
}

/** Build a keydown-like object. */
const key = (over = {}) => ({ key: 'Enter', shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, isComposing: false, keyCode: 13, ...over })

console.log('dsh-composer-keys tests\n--- host: shared preference helpers ---')

check('DEFAULTS mirror the engine keymap', () => {
  assert.deepEqual(DEFAULTS, { enter: 'send', shiftEnter: 'newline', ctrlEnter: 'send' })
  assert.deepEqual(ACTIONS, ['send', 'newline'])
})

check('sanitizePatch keeps known fields and drops everything else', () => {
  assert.deepEqual(sanitizePatch({ enter: 'newline' }), { enter: 'newline' })
  assert.deepEqual(sanitizePatch({ enter: 'newline', shiftEnter: 'send', ctrlEnter: 'newline' }), {
    enter: 'newline',
    shiftEnter: 'send',
    ctrlEnter: 'newline',
  })
  // unknown key, unknown value, wrong type
  assert.deepEqual(sanitizePatch({ nope: 'newline' }), {})
  assert.deepEqual(sanitizePatch({ enter: 'explode' }), {})
  assert.deepEqual(sanitizePatch({ enter: 1 }), {})
  // non-objects never throw and never persist
  assert.deepEqual(sanitizePatch(null), {})
  assert.deepEqual(sanitizePatch([]), {})
  assert.deepEqual(sanitizePatch('x'), {})
})

check('normalizePrefs falls back to defaults per field', () => {
  assert.deepEqual(normalizePrefs(undefined), DEFAULTS)
  assert.deepEqual(normalizePrefs({ enter: 'newline' }), { enter: 'newline', shiftEnter: 'newline', ctrlEnter: 'send' })
  assert.deepEqual(normalizePrefs({ enter: 'bogus' }), DEFAULTS)
})

console.log('\n--- client: gesture recognition ---')

check('composer selector targets the engine semantics, not a hashed class', () => {
  assert.equal(COMPOSER_SELECTOR, '[data-composer-input="true"]')
})

check('gestureOf maps modifiers onto the three gestures', () => {
  assert.equal(gestureOf(key()), 'enter')
  assert.equal(gestureOf(key({ shiftKey: true })), 'shiftEnter')
  assert.equal(gestureOf(key({ ctrlKey: true })), 'ctrlEnter')
  assert.equal(gestureOf(key({ metaKey: true })), 'ctrlEnter')
  // Shift wins over Ctrl, mirroring the engine keymap's rule order
  assert.equal(gestureOf(key({ shiftKey: true, ctrlKey: true })), 'shiftEnter')
  // Alt+Enter is the engine's own accelerated gesture: never ours
  assert.equal(gestureOf(key({ altKey: true })), null)
  assert.equal(gestureOf(key({ altKey: true, shiftKey: true })), null)
  // other keys are not ours
  assert.equal(gestureOf(key({ key: 'a' })), null)
  assert.equal(gestureOf(key({ key: 'NumpadEnter' })), null)
})

check('isComposing covers both IME signals', () => {
  assert.equal(isComposing(key({ isComposing: true })), true)
  assert.equal(isComposing(key({ keyCode: 229 })), true)
  assert.equal(isComposing(key()), false)
})

console.log('\n--- client: decideGesture ---')

check('defaults never intervene (engine behaves exactly as shipped)', () => {
  assert.equal(decideGesture(key(), DEFAULTS), null)
  assert.equal(decideGesture(key({ shiftKey: true }), DEFAULTS), null)
  assert.equal(decideGesture(key({ ctrlKey: true }), DEFAULTS), null)
})

check('Enter -> newline re-emits the Shift gesture', () => {
  const prefs = { ...DEFAULTS, enter: 'newline' }
  assert.deepEqual(decideGesture(key(), prefs), { gesture: 'enter', dispatch: 'shift' })
  // the other two are untouched
  assert.equal(decideGesture(key({ shiftKey: true }), prefs), null)
  assert.equal(decideGesture(key({ ctrlKey: true }), prefs), null)
})

check('Shift+Enter -> send re-emits the plain gesture', () => {
  const prefs = { ...DEFAULTS, shiftEnter: 'send' }
  assert.deepEqual(decideGesture(key({ shiftKey: true }), prefs), { gesture: 'shiftEnter', dispatch: 'plain' })
  assert.equal(decideGesture(key(), prefs), null)
})

check('Ctrl/Cmd+Enter -> newline re-emits the Shift gesture', () => {
  const prefs = { ...DEFAULTS, ctrlEnter: 'newline' }
  assert.deepEqual(decideGesture(key({ ctrlKey: true }), prefs), { gesture: 'ctrlEnter', dispatch: 'shift' })
  assert.deepEqual(decideGesture(key({ metaKey: true }), prefs), { gesture: 'ctrlEnter', dispatch: 'shift' })
})

check('all three set to the same action all intervene', () => {
  const nl = { enter: 'newline', shiftEnter: 'newline', ctrlEnter: 'newline' }
  assert.deepEqual(decideGesture(key(), nl), { gesture: 'enter', dispatch: 'shift' })
  assert.equal(decideGesture(key({ shiftKey: true }), nl), null) // already newline
  assert.deepEqual(decideGesture(key({ ctrlKey: true }), nl), { gesture: 'ctrlEnter', dispatch: 'shift' })

  const send = { enter: 'send', shiftEnter: 'send', ctrlEnter: 'send' }
  assert.equal(decideGesture(key(), send), null) // already send
  assert.deepEqual(decideGesture(key({ shiftKey: true }), send), { gesture: 'shiftEnter', dispatch: 'plain' })
  assert.equal(decideGesture(key({ ctrlKey: true }), send), null)
})

check('IME, Alt and foreign keys are never intercepted', () => {
  const aggressive = { enter: 'newline', shiftEnter: 'send', ctrlEnter: 'newline' }
  assert.equal(decideGesture(key({ isComposing: true }), aggressive), null)
  assert.equal(decideGesture(key({ keyCode: 229 }), aggressive), null)
  assert.equal(decideGesture(key({ altKey: true }), aggressive), null)
  assert.equal(decideGesture(key({ key: 'Escape' }), aggressive), null)
})

check('a malformed preference value never intervenes', () => {
  assert.equal(decideGesture(key(), { enter: 'explode' }), null)
  assert.equal(decideGesture(key(), {}), null)
  assert.equal(decideGesture(key(), null), null)
  assert.equal(decideGesture(null, DEFAULTS), null)
})

console.log('\n--- client: emitted event + store ---')

check('engineGestureEvent produces the engine\'s own two gestures', () => {
  const shift = engineGestureEvent('shift')
  assert.equal(shift.type, 'keydown')
  assert.equal(shift.key, 'Enter')
  assert.equal(shift.code, 'Enter')
  assert.equal(shift.shiftKey, true)
  assert.equal(shift.bubbles, true)
  assert.equal(shift.cancelable, true)
  const plain = engineGestureEvent('plain')
  assert.equal(plain.shiftKey, false)
  assert.equal(plain.key, 'Enter')
})

check('store notifies subscribers and replaces state', () => {
  const store = createPrefsStore(FALLBACK_DEFAULTS)
  const first = store.get()
  assert.equal(first.status, 'loading')
  assert.deepEqual(first.value, FALLBACK_DEFAULTS)
  let calls = 0
  const unsubscribe = store.subscribe(() => { calls += 1 })
  store.set({ status: 'ready', value: { ...FALLBACK_DEFAULTS, enter: 'newline' } })
  assert.equal(calls, 1)
  assert.equal(store.get().value.enter, 'newline')
  unsubscribe()
  store.set({ status: 'error' })
  assert.equal(calls, 1, 'unsubscribed listener must not fire again')
  // a fresh store must not share state with the previous one
  assert.deepEqual(createPrefsStore(FALLBACK_DEFAULTS).get().value, FALLBACK_DEFAULTS)
})

check('the settings row lists exactly the three gestures', () => {
  assert.deepEqual(GESTURES.map((g) => g.key), ['enter', 'shiftEnter', 'ctrlEnter'])
})

check('row + control styling mirror the engine settings rows', () => {
  // Guards the "沿用通用设置样式" requirement: the row keeps using the engine's
  // theme variables (light/dark follow for free) and the engine's own metric
  // declarations, instead of hard-coded colours and sizes.
  for (const token of [
    'var(--dsw-alias-border-l2)', // the separator every General row draws
    'var(--dsw-alias-label-primary)', // 14px title / pill text colour
    'var(--dsw-alias-label-tertiary)', // 12px description colour
    'var(--dsw-alias-bg-module-platform)', // pill background
    'var(--dsw-alias-interactive-bg-hover)', // pill + menu-item hover
    'var(--dsw-alias-bg-base)', // menu panel background
  ]) {
    assert.ok(ROW_CSS.includes(token), `stylesheet must reference ${token}`)
  }
  assert.ok(/\.dsh-ck-title\{[^}]*font-size:14px/.test(ROW_CSS), 'title must be 14px like the engine rows')
  assert.ok(/\.dsh-ck-row\{[^}]*padding:16px 0/.test(ROW_CSS), 'row padding must match the engine rows')
  // The control is the engine's pill, NOT a native <select> (which draws its own
  // arrow and inner padding and therefore never matches).
  assert.ok(
    /\.dsh-ck-pill\{[^}]*height:36px[^}]*border-radius:18px[^}]*padding:0 14px/.test(ROW_CSS),
    'control must be the engine 36px/18px pill',
  )
  assert.ok(!/dsh-ck-select/.test(ROW_CSS), 'native select styling must be gone')
  // The popup mirrors the engine Menu: 20px radius, 4px inset, 218px min width,
  // 40px items at a 10px radius, and a check glyph on the selected option.
  const menuRule = (ROW_CSS.match(/\.dsh-ck-menu\{([^}]*)\}/) ?? [])[1] ?? ''
  for (const decl of ['border-radius:20px', 'padding:4px', 'min-width:218px', 'background:var(--dsw-alias-bg-base)']) {
    assert.ok(menuRule.includes(decl), `menu panel must declare ${decl}`)
  }
  const itemRule = (ROW_CSS.match(/\.dsh-ck-item\{([^}]*)\}/) ?? [])[1] ?? ''
  for (const decl of ['min-height:40px', 'padding:8px 10px', 'border-radius:10px']) {
    assert.ok(itemRule.includes(decl), `menu item must declare ${decl}`)
  }
  assert.ok(ROW_CSS.includes('.dsh-ck-check{'), 'the selected item needs its check glyph')
  assert.equal(STYLE_ID, 'dsh-composer-keys-style')
})

check('client fallbacks agree with the host defaults', () => {
  assert.deepEqual(FALLBACK_DEFAULTS, DEFAULTS)
  assert.deepEqual(ENGINE_DEFAULT, DEFAULTS)
})

await Promise.resolve()
// --- route trust fence -------------------------------------------------------
// These routes serve usage/balance and settings writes, so the fence is the
// difference between "only the engine page can reach it" and "any local process, or
// a page that rebound a hostname to 127.0.0.1, can". The assertions pin the
// fail-closed default and the status mapping.
check('rejectUntrusted fails closed when the fence is unavailable', () => {
  const mk = () => ({ statusCode: 0, ended: 0, body: null, end(v) { this.ended += 1; this.body = v } })
  for (const ctx of [{ get: () => undefined }, { get: () => ({}) }, { get: () => null }, {}]) {
    const res = mk()
    assert.equal(rejectUntrusted(ctx, {}, res), true, 'must reject when connection is missing')
    assert.equal(res.statusCode, 403)
    assert.equal(res.ended, 1, 'the response must be ended exactly once')
  }
})

check('rejectUntrusted mirrors the engine fence and lets allowed requests through', () => {
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
