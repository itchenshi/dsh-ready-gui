// dsh-opencode-go-path local behaviour tests (no network, no engine).
// Run: node tests/test.mjs

import assert from 'node:assert/strict'
import { AsyncLocalStorage } from 'node:async_hooks'
import { V4_1_MODELS, headerValueFor, isV41, nextV41Models, patchFetch, redactSessionId, withStore, withV41ModelsFirst } from '../lib/index.js'

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

// --- model half: withV41ModelsFirst ---
check('V4.1 catalog is non-empty and every entry is a v4.1 model', () => {
  assert.ok(V4_1_MODELS.length > 0)
  for (const m of V4_1_MODELS) {
    assert.ok(isV41(m.id), `${m.id} should look like a v4.1 model`)
    assert.equal(typeof m.name, 'string')
    assert.equal(typeof m.contextWindow, 'number')
    assert.equal(typeof m.maxTokens, 'number')
  }
})

check('isV41 matches the family prefix', () => {
  assert.equal(isV41('deepseek-v4.1-flash'), true)
  assert.equal(isV41('deepseek-v4.1-pro'), true)
  assert.equal(isV41('deepseek-v4.1'), true)
  assert.equal(isV41('deepseek-v4-flash'), false)
  assert.equal(isV41('deepseek-v41-flash'), false)
  assert.equal(isV41(undefined), false)
})

check('withV41ModelsFirst puts the models first and keeps the rest in order', () => {
  const existing = [
    { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash' },
    { id: 'kimi-k2', name: 'Kimi K2' },
  ]
  const next = withV41ModelsFirst(existing)
  assert.equal(next.length, existing.length + V4_1_MODELS.length)
  assert.deepEqual(next.slice(0, V4_1_MODELS.length).map((m) => m.id), V4_1_MODELS.map((m) => m.id))
  assert.deepEqual(next.slice(V4_1_MODELS.length).map((m) => m.id), ['deepseek-v4-flash', 'kimi-k2'])
  // the input array is not mutated
  assert.equal(existing.length, 2)
})

check('withV41ModelsFirst moves an already-listed model to the front', () => {
  // The reported bug: an earlier version appended, so users carry it last.
  const next = withV41ModelsFirst([
    { id: 'deepseek-v4-flash' },
    { id: 'kimi-k2' },
    { id: 'deepseek-v4.1-flash' },
  ])
  assert.deepEqual(next.map((m) => m.id), ['deepseek-v4.1-flash', 'deepseek-v4-flash', 'kimi-k2'])
})

check('withV41ModelsFirst keeps the user\'s own entry for our model id', () => {
  const tuned = { id: 'deepseek-v4.1-flash', name: '我的 Flash', contextWindow: 1234 }
  const next = withV41ModelsFirst([{ id: 'a' }, tuned])
  assert.equal(next[0], tuned, 'the same object is reused, not replaced by our default')
  assert.equal(next[0].name, '我的 Flash')
  assert.equal(next[0].contextWindow, 1234)
})

check('withV41ModelsFirst handles a missing/empty list', () => {
  assert.equal(withV41ModelsFirst(undefined).length, V4_1_MODELS.length)
  assert.equal(withV41ModelsFirst([]).length, V4_1_MODELS.length)
  assert.equal(withV41ModelsFirst(null).length, V4_1_MODELS.length)
})

check('withV41ModelsFirst is idempotent (null once the shape is right)', () => {
  const already = [{ id: 'deepseek-v4.1-flash' }, { id: 'deepseek-v4-flash' }]
  assert.equal(withV41ModelsFirst(already), null)
  // a second pass over its own output is a no-op -> no settings write loop
  assert.equal(withV41ModelsFirst(withV41ModelsFirst([{ id: 'x' }])), null)
  assert.equal(withV41ModelsFirst(V4_1_MODELS.map((m) => ({ ...m }))), null)
})

check('an unrelated upstream v4.1 model does not suppress our own', () => {
  // Presence is decided by OUR ids, not by the "deepseek-v4.1" prefix: a future
  // upstream sibling must not keep V4.1 Flash out of the list.
  const next = withV41ModelsFirst([{ id: 'deepseek-v4.1-pro' }])
  assert.deepEqual(next.map((m) => m.id), ['deepseek-v4.1-flash', 'deepseek-v4.1-pro'])
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
  // a user list is extended, with our models in front
  const extended = nextV41Models({ models: [{ id: 'deepseek-v4-flash' }] })
  assert.equal(extended.length, 1 + V4_1_MODELS.length)
  assert.equal(extended[0].id, V4_1_MODELS[0].id)
  assert.equal(extended[1].id, 'deepseek-v4-flash')
  // already in the shape we maintain -> no write
  assert.equal(nextV41Models({ models: [{ id: V4_1_MODELS[0].id }] }), null)
  // apiKey/baseUrl siblings are irrelevant to the decision
  assert.ok(Array.isArray(nextV41Models({ apiKeyRef: 'X', models: [{ id: 'deepseek-v4.1-pro' }] })))
  assert.ok(Array.isArray(nextV41Models({ apiKeyRef: 'X', models: [{ id: 'a' }] })))
})

await Promise.resolve()
console.log(`\nall ${passed} checks passed`)