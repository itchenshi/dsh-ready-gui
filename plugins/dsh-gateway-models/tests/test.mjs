// dsh-gateway-models local behaviour tests (no network, no engine).
// Run: node tests/test.mjs

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { AsyncLocalStorage } from 'node:async_hooks'
import { CC_PROVIDER, V4_1_MODELS, catalogMemoValue, commandCodeEntry, commandCodeRouteIds, fetchCommandCodeCatalog, headerValueFor, isCommandCodeRoute, isV41, patchFetch, planCommandCodeUpdate, planRouteUpdate, redactSessionId, withStore, withV41Defaults, withV41ModelsFirst } from '../lib/index.js'

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

console.log('dsh-gateway-models tests')

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
  assert.equal(next[0].name, '我的 Flash', 'the user name wins')
  assert.equal(next[0].contextWindow, 1234, 'the user limits win')
  assert.equal(next[0].maxTokens, V4_1_MODELS[0].maxTokens, 'a field the user left out is filled in')
})

check('withV41Defaults adds the wire facts a catalog-unknown model needs', () => {
  // The 400 fix: without these, the replayed assistant turns omit
  // reasoning_content and DeepSeek refuses every multi-turn conversation.
  const def = V4_1_MODELS[0]
  assert.equal(def.compat.requiresReasoningContentOnAssistantMessages, true)
  assert.equal(def.compat.thinkingFormat, 'deepseek')
  assert.deepEqual(def.reasoningEfforts, { off: null, low: 'low', high: 'high', max: 'max' })

  // an entry written before this plugin knew about them gets completed
  const upgraded = withV41Defaults({ id: def.id, name: '我的 Flash', contextWindow: 1234 }, def)
  assert.equal(upgraded.name, '我的 Flash')
  assert.equal(upgraded.contextWindow, 1234)
  assert.deepEqual(upgraded.compat, def.compat)
  assert.deepEqual(upgraded.reasoningEfforts, def.reasoningEfforts)

  // the user's own compat switches win; ours fill the gaps
  const partial = withV41Defaults({ id: def.id, compat: { supportsStore: true } }, def)
  assert.equal(partial.compat.supportsStore, true, 'an explicit user switch is never overwritten')
  assert.equal(partial.compat.requiresReasoningContentOnAssistantMessages, true, 'the rest is filled in')

  // an explicit non-reasoning decision is a whole answer and is respected
  assert.equal(withV41Defaults({ id: def.id, reasoningEfforts: false }, def).reasoningEfforts, false)
})

check('withV41ModelsFirst handles a missing/empty list', () => {
  assert.equal(withV41ModelsFirst(undefined).length, V4_1_MODELS.length)
  assert.equal(withV41ModelsFirst([]).length, V4_1_MODELS.length)
  assert.equal(withV41ModelsFirst(null).length, V4_1_MODELS.length)
})

check('withV41ModelsFirst is idempotent (null once the shape is right)', () => {
  const already = [{ ...V4_1_MODELS[0] }, { id: 'deepseek-v4-flash' }]
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

// --- model half: planRouteUpdate ---

// The installed catalog as `llm.discoverModels()` reports it: a few models that
// each carry their own per-model baseUrl, and none of them V4.1 Flash.
const CATALOG = [
  { id: 'minimax-m3', name: 'MiniMax-M3', contextWindow: 1000000, maxTokens: 131072 },
  { id: 'deepseek-v4-flash', name: 'DeepSeek V4 Flash', contextWindow: 1000000, maxTokens: 384000 },
  { id: 'kimi-k3', name: 'Kimi K3', contextWindow: 1048576, maxTokens: 131072 },
]

check('planRouteUpdate seeds a full list when the user configured none', () => {
  // The bug this fixes: nothing was written at all, so V4.1 Flash never appeared
  // in the picker for a route that relies on the served catalog.
  const patch = planRouteUpdate(undefined, { api: 'openai-completions' }, CATALOG)
  assert.ok(patch, 'a patch is produced')
  assert.deepEqual(patch.models.map((m) => m.id), [
    V4_1_MODELS[0].id,
    'minimax-m3',
    'deepseek-v4-flash',
    'kimi-k3',
  ])
  // our entry keeps its own limits; the detected ones stay catalog-shaped
  assert.equal(patch.models[0].contextWindow, V4_1_MODELS[0].contextWindow)
  assert.deepEqual(patch.models[1], { id: 'minimax-m3', name: 'MiniMax-M3' })
  // a catalog-unknown model is listed -> the route needs an endpoint, or the
  // engine refuses the very write that adds it ("needs a baseURL").
  assert.equal(patch.baseURL, 'https://opencode.ai/zen/go/v1')
})

check('planRouteUpdate extends a user list and keeps its order', () => {
  const patch = planRouteUpdate(
    { models: [{ id: 'deepseek-v4-flash' }, { id: 'kimi-k3' }] },
    { baseURL: 'https://opencode.ai/zen/go/v1' },
    CATALOG,
  )
  assert.deepEqual(patch.models.map((m) => m.id), [V4_1_MODELS[0].id, 'deepseek-v4-flash', 'kimi-k3'])
  assert.equal(patch.models[1].id, 'deepseek-v4-flash', 'the user entry is reused verbatim')
  assert.equal(patch.baseURL, undefined, 'the route already has an endpoint')
})

check('planRouteUpdate repairs an already-hoisted list that has no baseURL', () => {
  // A hand-written settings.yaml can hold the right ORDER while the route still
  // has no endpoint — the engine then drops the catalog-unknown model silently.
  const patch = planRouteUpdate(
    { models: [{ ...V4_1_MODELS[0] }, { id: 'kimi-k3' }] },
    { api: 'openai-completions' },
    CATALOG,
  )
  assert.equal(patch.models, undefined, 'the order is already right')
  assert.equal(patch.baseURL, 'https://opencode.ai/zen/go/v1')
})

check('planRouteUpdate upgrades an entry that predates the reasoning compat', () => {
  // THE 400 FIX: a user who already has V4.1 Flash — added by an earlier version
  // of this plugin, the GUI model page, or by hand — carries no compat block, so
  // DeepSeek rejects every replayed assistant turn. That entry is still first (no
  // reordering to do), and the write must happen anyway to add the wire facts.
  const patch = planRouteUpdate(
    {
      models: [
        { id: V4_1_MODELS[0].id, name: 'DeepSeek V4.1 Flash', contextWindow: 1000000, maxTokens: 384000 },
        { id: 'kimi-k3' },
      ],
    },
    { baseURL: 'https://opencode.ai/zen/go/v1' },
    CATALOG,
  )
  assert.ok(patch, 'a patch is produced even though the order was already right')
  assert.equal(patch.baseURL, undefined, 'the endpoint is already there')
  assert.deepEqual(patch.models[0].reasoningEfforts, V4_1_MODELS[0].reasoningEfforts)
  assert.deepEqual(patch.models[0].compat, V4_1_MODELS[0].compat)
  assert.equal(patch.models[1].id, 'kimi-k3', 'the user list is otherwise untouched')
})

check('planRouteUpdate supplies no baseURL once the catalog describes our models', () => {
  // When upstream catches up, the catalog supplies the endpoint itself and the
  // route must stay untouched (writing one would repoint the route's models).
  const catalog = [{ ...V4_1_MODELS[0] }, ...CATALOG]
  const patch = planRouteUpdate({ models: [{ id: 'kimi-k3' }] }, {}, catalog)
  assert.deepEqual(patch.models.map((m) => m.id), [V4_1_MODELS[0].id, 'kimi-k3'])
  assert.equal(patch.baseURL, undefined)
})

check('planRouteUpdate is idempotent in both directions', () => {
  const userList = { models: [{ ...V4_1_MODELS[0] }, { id: 'kimi-k3' }] }
  // the seeded write lands as a user list; the next pass must be a no-op
  const first = planRouteUpdate(undefined, {}, CATALOG)
  const stored = { models: first.models }
  const second = planRouteUpdate(stored, { baseURL: first.baseURL }, CATALOG)
  assert.equal(second, null, 'no write loop through settings/document-updated')
  // a user list that is already in shape is left alone
  assert.equal(planRouteUpdate(userList, { baseURL: 'x' }, CATALOG), null)
  // A route the user configured nothing for is seeded once even when the detected
  // catalog already lists our model: a detected entry is reduced to id+name, so it
  // cannot carry the wire facts we maintain. The seeded result is stable after.
  const covered = [{ id: V4_1_MODELS[0].id, name: 'DeepSeek V4.1 Flash' }, ...CATALOG.map((m) => ({ id: m.id, name: m.name }))]
  const seeded = planRouteUpdate(undefined, {}, covered)
  assert.ok(seeded, 'the catalog entry is completed with our fields')
  assert.deepEqual(seeded.models[0], { ...V4_1_MODELS[0] })
  assert.equal(planRouteUpdate({ models: seeded.models }, { baseURL: 'x' }, covered), null)
})

check('planRouteUpdate refuses to guess when detection failed', () => {
  // No catalog means a route the user configured nothing for cannot be
  // described; writing our models alone would shrink the picker to one entry.
  assert.equal(planRouteUpdate(undefined, {}, undefined), null)
  assert.equal(planRouteUpdate(undefined, {}, null), null)
  assert.equal(planRouteUpdate(undefined, {}, 'nope'), null)
})

check('planRouteUpdate tolerates junk in the catalog and the user layer', () => {
  const patch = planRouteUpdate({ models: 'nope' }, {}, [null, { id: '' }, { id: 'kimi-k3' }])
  assert.deepEqual(patch.models.map((m) => m.id), [V4_1_MODELS[0].id, 'kimi-k3'])
  assert.equal(patch.baseURL, 'https://opencode.ai/zen/go/v1')
})

check('planRouteUpdate treats an explicit empty list as unconfigured', () => {
  // `models: []` resolves to the served catalog in the engine, so seeding it is
  // the same decision as having no list at all.
  const patch = planRouteUpdate({ models: [] }, {}, CATALOG)
  assert.equal(patch.models.length, CATALOG.length + V4_1_MODELS.length)
  assert.equal(patch.models[0].id, V4_1_MODELS[0].id)
})

check('planRouteUpdate keeps a tuned user entry for our id', () => {
  const tuned = { id: V4_1_MODELS[0].id, name: '我的 Flash', contextWindow: 1234 }
  const patch = planRouteUpdate({ models: [{ id: 'kimi-k3' }, tuned] }, { baseURL: 'x' }, CATALOG)
  assert.equal(patch.models[0].name, '我的 Flash', 'the user name wins')
  assert.equal(patch.models[0].contextWindow, 1234, 'the user limits win')
  assert.deepEqual(patch.models[0].compat, V4_1_MODELS[0].compat, 'the wire facts are still filled in')
})

// --- Command Code catalog provisioning ---

// Shape captured from the live public endpoint (no credential required):
//   GET https://api.commandcode.ai/provider/v1/models
const CC_CATALOG = [
  { id: 'claude-sonnet-5', object: 'model', owned_by: 'command-code', name: 'Claude Sonnet 5', context_length: 1000000, supported_endpoints: ['/messages'] },
  { id: 'gpt-6-astra', object: 'model', owned_by: 'command-code', name: 'GPT-6 Astra', context_length: 1050000, supported_endpoints: ['/chat/completions', '/responses'] },
]

check('commandCodeEntry maps the catalog fields a settings entry needs', () => {
  assert.deepEqual(commandCodeEntry(CC_CATALOG[0]), {
    id: 'claude-sonnet-5',
    name: 'Claude Sonnet 5',
    contextWindow: 1000000,
  })
  // contextWindow matters here: this route has NO catalog fallback, so omitting
  // it would give every model the route default (262144) instead of the real 1M.
  assert.equal(commandCodeEntry({ id: 'x', context_length: 4096 }).contextWindow, 4096)
  // id is the only mandatory field
  assert.deepEqual(commandCodeEntry({ id: 'bare' }), { id: 'bare' })
  // unusable shapes
  assert.equal(commandCodeEntry({ name: 'no id' }), null)
  assert.equal(commandCodeEntry({ id: '   ' }), null)
  assert.equal(commandCodeEntry(null), null)
  assert.equal(commandCodeEntry([]), null)
  // a bogus context_length is dropped rather than stored as NaN
  assert.deepEqual(commandCodeEntry({ id: 'y', context_length: 'nope' }), { id: 'y' })
})

// A route the shipped patch covers: api + endpoint already resolve, so only the
// model list is ever planned.
const CC_RESOLVED = { api: 'openai-completions', baseURL: 'https://api.commandcode.ai/provider/v1' }

check('planCommandCodeUpdate seeds the whole catalog when the user has no list', () => {
  const catalog = CC_CATALOG.map(commandCodeEntry)
  const patch = planCommandCodeUpdate({ apiKeyEnv: 'COMMANDCODE_GOAT_API_KEY' }, CC_RESOLVED, catalog)
  assert.deepEqual(patch.models, catalog)
  // ... and the seeded list is then complete -> no further write
  assert.equal(planCommandCodeUpdate({ models: patch.models }, CC_RESOLVED, catalog), null)
})

check('planCommandCodeUpdate appends only what is missing, keeping user order', () => {
  const catalog = CC_CATALOG.map(commandCodeEntry)
  const tuned = { id: 'gpt-6-astra', name: '我改过的名字', contextWindow: 1234 }
  const patch = planCommandCodeUpdate({ models: [tuned] }, CC_RESOLVED, catalog)
  assert.equal(patch.models.length, 2)
  assert.equal(patch.models[0], tuned, 'the user entry is kept verbatim and in place')
  assert.equal(patch.models[0].contextWindow, 1234)
  assert.deepEqual(patch.models[1], commandCodeEntry(CC_CATALOG[0]), 'the missing one is appended')
  // idempotent: running again over its own output is a no-op
  assert.equal(planCommandCodeUpdate({ models: patch.models }, CC_RESOLVED, catalog), null)
})

check('planCommandCodeUpdate never reorders or duplicates an existing list', () => {
  const catalog = CC_CATALOG.map(commandCodeEntry)
  const full = [commandCodeEntry(CC_CATALOG[1]), commandCodeEntry(CC_CATALOG[0])]
  // both present, in the user's own (reversed) order -> nothing to do
  assert.equal(planCommandCodeUpdate({ models: full }, CC_RESOLVED, catalog), null)
  // a duplicate id in the catalog must not append a second copy
  const dupes = planCommandCodeUpdate({ models: [] }, CC_RESOLVED, [catalog[0], catalog[0]])
  assert.equal(dupes.models.length, 2, 'an empty stored list seeds catalog entries as given')
  assert.equal(planCommandCodeUpdate({ models: [catalog[0]] }, CC_RESOLVED, [catalog[0], catalog[0]]), null)
})

check('planCommandCodeUpdate declares api + baseURL for a route the patch misses', () => {
  const catalog = CC_CATALOG.map(commandCodeEntry)
  // A Pro/MAX subscriber whose route is NOT the patched name: nothing resolves
  // `api`, and the engine refuses to store models without one.
  const bare = planCommandCodeUpdate({ apiKeyEnv: 'K', baseURL: 'https://api.commandcode.ai/provider/v1' }, {}, catalog)
  assert.equal(bare.api, 'openai-completions')
  assert.equal(bare.models.length, 2)
  // baseURL is only restated when the resolved route actually lacks it
  assert.equal(bare.baseURL, undefined, 'the user already stated the endpoint')
  const noEndpoint = planCommandCodeUpdate({ apiKeyEnv: 'K' }, {}, catalog)
  assert.equal(noEndpoint.baseURL, 'https://api.commandcode.ai/provider/v1')
  assert.equal(noEndpoint.api, 'openai-completions')
  // once written, the resolved route carries both -> only models remain
  const settled = planCommandCodeUpdate({ models: catalog }, CC_RESOLVED, catalog)
  assert.equal(settled, null)
  // a route that needs ONLY the declarations (models already complete) still gets them
  const onlyDecls = planCommandCodeUpdate({ models: catalog }, {}, catalog)
  assert.deepEqual(onlyDecls, { api: 'openai-completions', baseURL: 'https://api.commandcode.ai/provider/v1' })
})

check('planCommandCodeUpdate refuses to guess without a catalog', () => {
  assert.equal(planCommandCodeUpdate({}, CC_RESOLVED, undefined), null)
  assert.equal(planCommandCodeUpdate({}, CC_RESOLVED, null), null)
  assert.equal(planCommandCodeUpdate({}, CC_RESOLVED, []), null)
  assert.equal(planCommandCodeUpdate({}, CC_RESOLVED, 'nope'), null)
  assert.equal(planCommandCodeUpdate(undefined, CC_RESOLVED, [commandCodeEntry(CC_CATALOG[0])]).models.length, 1)
})

await checkAsync('fetchCommandCodeCatalog reads the public catalog without a key', async () => {
  let seen = null
  const res = await fetchCommandCodeCatalog({
    fetchImpl: async (url, init) => {
      seen = { url, init }
      return { ok: true, json: async () => ({ object: 'list', data: CC_CATALOG }) }
    },
  })
  assert.equal(seen.url, 'https://api.commandcode.ai/provider/v1/models')
  assert.equal(seen.init.headers.authorization, undefined, 'the public catalog must not receive a credential')
  assert.equal(res.ok, true)
  assert.equal(res.models.length, 2)
  assert.equal(res.models[0].contextWindow, 1000000)

  // a bare array is accepted too
  const bare = await fetchCommandCodeCatalog({ fetchImpl: async () => ({ ok: true, json: async () => CC_CATALOG }) })
  assert.equal(bare.models.length, 2)

  // failures classify instead of throwing
  const denied = await fetchCommandCodeCatalog({ fetchImpl: async () => ({ ok: false, status: 403 }) })
  assert.equal(denied.reason, 'unauthorized')
  const boom = await fetchCommandCodeCatalog({ fetchImpl: async () => { throw new Error('offline') } })
  assert.equal(boom.reason, 'network')
  const junk = await fetchCommandCodeCatalog({ fetchImpl: async () => ({ ok: true, json: async () => ({ nope: 1 }) }) })
  assert.equal(junk.reason, 'bad-payload')
  // every entry unusable -> bad-payload, never an empty list written to settings
  const empty = await fetchCommandCodeCatalog({
    fetchImpl: async () => ({ ok: true, json: async () => ({ data: [{ name: 'no id' }] }) }),
  })
  assert.equal(empty.reason, 'bad-payload')
})

check('isCommandCodeRoute matches the ENDPOINT, not the route name', () => {
  // The route id is a label; every Command Code plan (Go / GOAT / Pro / MAX)
  // answers on the same host, so provisioning must not key off a fixed name.
  assert.equal(isCommandCodeRoute({ baseURL: 'https://api.commandcode.ai/provider/v1' }), true)
  assert.equal(isCommandCodeRoute({ baseURL: 'https://api.commandcode.ai' }), true)
  assert.equal(isCommandCodeRoute({ baseURL: 'https://API.CommandCode.AI/provider/v1' }), true)
  // the endpoint may be stated only by the resolved (base) layer
  assert.equal(isCommandCodeRoute(undefined, { baseURL: 'https://api.commandcode.ai/provider/v1' }), true)
  assert.equal(isCommandCodeRoute({}, { baseURL: 'https://api.commandcode.ai/provider/v1' }), true)
  // anything else is not ours
  assert.equal(isCommandCodeRoute({ baseURL: 'https://opencode.ai/zen/go/v1' }), false)
  assert.equal(isCommandCodeRoute({ baseURL: 'https://api.deepseek.com' }), false)
  assert.equal(isCommandCodeRoute({}), false)
  assert.equal(isCommandCodeRoute(undefined, undefined), false)
  assert.equal(isCommandCodeRoute({ baseURL: 'not a url' }), false)
  assert.equal(isCommandCodeRoute(null, null), false)
})

check('commandCodeRouteIds finds every configured Command Code route', () => {
  const resolved = {
    // the name the shipped patch declares, plus a legacy one and two plan-named ones
    commandcode: { baseURL: 'https://api.commandcode.ai/provider/v1' },
    'commandcode-goat': { baseURL: 'https://api.commandcode.ai/provider/v1' },
    'commandcode-pro': { baseURL: 'https://api.commandcode.ai/provider/v1' },
    'commandcode-max': { baseURL: 'https://api.commandcode.ai/provider/v1' },
    'opencode-go': { baseURL: 'https://opencode.ai/zen/go/v1' },
  }
  // Plan-named routes (and the legacy goat one) are still found — the name never
  // decides anything, the endpoint does.
  assert.deepEqual(
    commandCodeRouteIds({ 'commandcode-pro': { apiKeyEnv: 'K' }, 'opencode-go': {} }, resolved),
    ['commandcode-pro'],
  )
  assert.deepEqual(
    commandCodeRouteIds(
      { commandcode: {}, 'commandcode-goat': {}, 'commandcode-max': {}, 'opencode-go': {} },
      resolved,
    ),
    ['commandcode', 'commandcode-goat', 'commandcode-max'],
  )
  // The patch-declared route: its endpoint lives in the RESOLVED layer only.
  assert.deepEqual(commandCodeRouteIds({ commandcode: { apiKeyEnv: 'K' } }, resolved), ['commandcode'])
  // Routes only in the base layer are NOT provisioned (the user does not use them).
  assert.deepEqual(commandCodeRouteIds({}, resolved), [])
  // An explicit list covers a route whose endpoint is stated nowhere yet.
  assert.deepEqual(commandCodeRouteIds({ 'my-cc': {} }, {}, ['my-cc']), ['my-cc'])
  assert.deepEqual(commandCodeRouteIds({ 'my-cc': {} }, {}, 'nope'), [])
  assert.deepEqual(commandCodeRouteIds(undefined, undefined), [])
})

check('the shipped patch declares exactly the route the code names', () => {
  // The runtime matches by endpoint, so nothing would notice this drifting: a
  // rename in one file and not the other silently costs users the built-in
  // endpoint (they would have to type the API address again).
  const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  assert.ok(
    new RegExp(`^\\s{6}${CC_PROVIDER}:\\s*$`, 'm').test(patch),
    `cordis.patch.yml must declare the "${CC_PROVIDER}" route`,
  )
  assert.ok(patch.includes('baseURL: https://api.commandcode.ai/provider/v1'), 'the patched route needs its endpoint')
  assert.ok(patch.includes('api: openai-completions'), 'the patched route needs its protocol')
  // The plan-specific name must no longer be the declared default.
  assert.ok(!/^\s{6}commandcode-goat:\s*$/m.test(patch), 'the default route must not be plan-specific')
})

check('catalogMemoValue: a failure expires fast, a success is reused', () => {
  const OK = 600_000
  const FAIL = 60_000
  // Nothing memoized yet.
  assert.equal(catalogMemoValue(null, 1000), null)
  assert.equal(catalogMemoValue({}, 1000), null)
  assert.equal(catalogMemoValue({ at: 0, ok: true, value: 'x' }, Number.NaN), null)
  // A success lives for the long TTL.
  assert.equal(catalogMemoValue({ at: 1000, ok: true, value: 'ok' }, 1000 + OK - 1, OK, FAIL), 'ok')
  assert.equal(catalogMemoValue({ at: 1000, ok: true, value: 'ok' }, 1000 + OK, OK, FAIL), null)
  // A failure must NOT be reused for the long TTL — the provider may be back.
  assert.equal(catalogMemoValue({ at: 1000, ok: false, value: 'bad' }, 1000 + FAIL - 1, OK, FAIL), 'bad')
  assert.equal(catalogMemoValue({ at: 1000, ok: false, value: 'bad' }, 1000 + FAIL, OK, FAIL), null)
  assert.equal(
    catalogMemoValue({ at: 1000, ok: false, value: 'bad' }, 1000 + OK - 1, OK, FAIL),
    null,
    'a failure is still stale well before the success TTL',
  )
  // A backwards clock jump counts as stale, never as "fresh forever".
  assert.equal(catalogMemoValue({ at: 5000, ok: true, value: 'ok' }, 1000, OK, FAIL), null)
})

await Promise.resolve()
console.log(`\nall ${passed} checks passed`)