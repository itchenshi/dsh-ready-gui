// dsh-opencode-go-path local behaviour tests (no network, no engine).
// Run: node tests/test.mjs

import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { V4_1_MODELS, appendV41Models, headerValueFor, isV41, nextV41Models, patchFetch, redactSessionId, withStore } from '../lib/index.js'

let passed = 0
function check(label, fn) {
  fn()
  passed++
  console.log('  ✓', label)
}

async function checkAsync(label, fn) {
  await fn()
  passed++
  console.log('  ✓', label)
}

console.log('dsh-opencode-go-path tests')

// --- header half: headerValueFor defaults to an opaque uuid ---
check('uuid mode: value is opaque, not the session id', () => {
  const table = new Map()
  const value = headerValueFor('conv-123', 'uuid', table)
  assert.ok(typeof value === 'string' && value.length > 0)
  assert.notEqual(value, 'conv-123')
  // stable across calls for the same session
  assert.equal(headerValueFor('conv-123', 'uuid', table), value)
  // distinct sessions get distinct values
  assert.notEqual(headerValueFor('conv-456', 'uuid', table), value)
})

check('uuid mode matches UUID format', () => {
  const table = new Map()
  const value = headerValueFor('abc', 'uuid', table)
  assert.match(value, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
})

check('session-id mode: value equals the session id', () => {
  const table = new Map()
  assert.equal(headerValueFor('conv-123', 'session-id', table), 'conv-123')
})

check('control characters are rejected (both modes)', () => {
  const table = new Map()
  assert.equal(headerValueFor('a\nInjected: x', 'uuid', table), undefined)
  assert.equal(headerValueFor('a\nInjected: x', 'session-id', table), undefined)
})

check('empty / non-string session ids are rejected', () => {
  const table = new Map()
  assert.equal(headerValueFor('', 'uuid', table), undefined)
  assert.equal(headerValueFor(null, 'uuid', table), undefined)
})

check('redactSessionId is a stable hashed digest', () => {
  const a = redactSessionId('conv-secret-1')
  const b = redactSessionId('conv-secret-1')
  assert.ok(/^[0-9a-f]{16}$/.test(a))
  assert.equal(a, b)
  assert.notEqual(a, 'conv-secret-1')
})

await checkAsync('withStore keeps store active across pulls', async () => {
  const als = new AsyncLocalStorage()
  const seen = []
  // The store is active inside the downstream generator body (where the real
  // HTTP request would happen), not in the consuming for-await loop.
  async function* gen() {
    seen.push(als.getStore()?.value)
    yield 'a'
    seen.push(als.getStore()?.value)
    yield 'b'
  }
  const wrapped = withStore(gen(), { value: 'V' }, als)
  const out = []
  for await (const chunk of wrapped) out.push(chunk)
  assert.deepEqual(out, ['a', 'b'])
  assert.deepEqual(seen, ['V', 'V'])
})

// --- header half: patchFetch only acts inside a store ---
await checkAsync('patchFetch injects the header only inside a store', async () => {
  const als = new AsyncLocalStorage()
  const calls = []
  const original = async (input, init) => {
    calls.push({ input, headers: init?.headers })
    return 'ok'
  }
  const patched = patchFetch(original, als)

  // outside any store: the request passes through untouched
  await patched('https://x.test/v1', { headers: { a: '1' } })
  assert.equal(new Headers(calls[0].headers).get('x-opencode-session'), null)

  // inside a store: the header is added and existing headers survive
  await als.run({ value: 'UUID-1' }, () => patched('https://x.test/v1', { headers: { a: '1' } }))
  const inside = new Headers(calls[1].headers)
  assert.equal(inside.get('x-opencode-session'), 'UUID-1')
  assert.equal(inside.get('a'), '1')

  // a caller-supplied session header is never overwritten
  await als.run({ value: 'UUID-2' }, () =>
    patched('https://x.test/v1', { headers: { 'x-opencode-session': 'mine' } }))
  assert.equal(new Headers(calls[2].headers).get('x-opencode-session'), 'mine')
})

// --- model half: appendV41Models ---
check('V4.1 catalog is non-empty and every entry is a v4.1 model', () => {
  assert.ok(V4_1_MODELS.length > 0)
  for (const m of V4_1_MODELS) {
    assert.ok(isV41(m.id), `${m.id} should look like a v4.1 model`)
    assert.equal(typeof m.name, 'string')
    assert.equal(typeof m.contextWindow, 'number')
    assert.equal(typeof m.maxTokens, 'number')
  }
})

check('isV41 matches the family prefix (wildcard semantics)', () => {
  assert.equal(isV41('deepseek-v4.1-flash'), true)
  assert.equal(isV41('deepseek-v4.1-pro'), true)
  // a bare family prefix also counts: over-matching only suppresses an add,
  // which is safer than duplicating an entry.
  assert.equal(isV41('deepseek-v4.1'), true)
  assert.equal(isV41('deepseek-v4-flash'), false)
  assert.equal(isV41('deepseek-v41-flash'), false)
  assert.equal(isV41(undefined), false)
})

check('appendV41Models appends to an existing list and keeps it intact', () => {
  const existing = [{ id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' }]
  const next = appendV41Models(existing)
  assert.equal(next.length, existing.length + V4_1_MODELS.length)
  assert.equal(next[0].id, 'deepseek-v4-flash') // order preserved
  assert.ok(next.some((m) => m.id === 'deepseek-v4.1-flash'))
  // the input array is not mutated
  assert.equal(existing.length, 1)
})

check('appendV41Models handles a missing/empty list', () => {
  assert.equal(appendV41Models(undefined).length, V4_1_MODELS.length)
  assert.equal(appendV41Models([]).length, V4_1_MODELS.length)
  assert.equal(appendV41Models(null).length, V4_1_MODELS.length)
})

check('appendV41Models is a no-op when a v4.1 model is already listed', () => {
  assert.equal(appendV41Models([{ id: 'deepseek-v4.1-flash' }]), null)
  // any v4.1 sibling counts — no duplicates from a future upstream release
  assert.equal(appendV41Models([{ id: 'deepseek-v4.1-pro' }]), null)
  assert.equal(
    appendV41Models([{ id: 'deepseek-v4-flash' }, { id: 'deepseek-v4.1-flash' }]),
    null,
  )
})

check('nextV41Models only extends a models list the USER configured', () => {
  // The engine treats a non-empty configured list as the provider's COMPLETE model
  // set, so writing one where the user had none would replace the whole built-in
  // catalog with a single model. The decision must therefore read the user layer.
  assert.equal(nextV41Models(undefined), null, 'route not configured by the user')
  assert.equal(nextV41Models(null), null)
  assert.equal(nextV41Models({}), null, 'no models key -> catalog stays authoritative')
  assert.equal(nextV41Models({ models: [] }), null, 'empty list -> nothing to extend')
  assert.equal(nextV41Models({ models: 'nope' }), null, 'non-array -> refuse')
  // a user list is extended, and an existing v4.1 still makes it a no-op
  const extended = nextV41Models({ models: [{ id: 'deepseek-v4-flash' }] })
  assert.equal(extended.length, 1 + V4_1_MODELS.length)
  assert.equal(extended[0].id, 'deepseek-v4-flash')
  assert.equal(nextV41Models({ models: [{ id: 'deepseek-v4.1-flash' }] }), null)
  // apiKey/baseUrl siblings are irrelevant to the decision
  assert.equal(nextV41Models({ apiKeyRef: 'X', models: [{ id: 'deepseek-v4.1-pro' }] }), null)
  assert.ok(Array.isArray(nextV41Models({ apiKeyRef: 'X', models: [{ id: 'a' }] })))
})

await Promise.resolve()
console.log(`\nall ${passed} checks passed`)