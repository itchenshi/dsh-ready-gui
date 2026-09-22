// dsh-model-surplus local behaviour tests (no network, no engine).
// Run: node tests/test.mjs

import assert from 'node:assert/strict'

import {
  normalizeBucket,
  normalizeUsage,
  normalizeAmount,
  normalizeBalance,
  isTrackedProvider,
  resolveSections,
  fetchUsage,
  fetchBalance,
  fetchDocsLimits,
  BUILTIN_MODEL_LIMITS,
  normalizeLimitName,
  parseLimitsTable,
  parseModelIdTable,
  parseDocsLimits,
  deriveLimitTiers,
  deriveLimits,
  limitsCachePath,
  readLimitsCache,
  writeLimitsCache,
  rejectUntrusted,
} from '../lib/index.js'

// --- load the client bundle exactly the way the engine does -----------------
// The engine requires a lazy CJS factory registration (NOT plain ESM):
//   window.__ModuleLoader__.load({ id, factory })
// We mimic that contract so the test exercises the real artifact.
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
assert.equal(registration.id, 'dsh-model-surplus', 'factory id must be the package name')
assert.equal(typeof registration.factory, 'function', 'factory must be a function')

// The browser-side cordis runner builds the fiber inject from the bundle's
// exported `inject` (SERVICE names). Without `slots`/`modelDirectories` the
// occupant cannot register or read the model.
const clientExports = registration.factory((specifier) => {
  if (specifier === 'react' || specifier === 'react/jsx-runtime') {
    // Minimal stubs: the pure helpers under test do not touch React.
    return { useSyncExternalStore: () => null, useCallback: (f) => f, createContext: () => ({}) }
  }
  throw new Error(`unexpected external require: ${specifier}`)
})
assert.ok(Array.isArray(clientExports.inject), 'factory must export an inject array')
for (const svc of ['slots', 'locale', 'modelDirectories']) {
  assert.ok(
    clientExports.inject.includes(svc),
    `factory inject must include the ${svc} service (got: ${JSON.stringify(clientExports.inject)})`,
  )
}
assert.equal(typeof clientExports.apply, 'function', 'factory must export apply')

const {
  pickSection,
  isTracked,
  percentColor,
  currencySymbol,
  formatAmount,
  formatReset,
  createUsageStore,
  findLimit,
  limitSourceLabel,
  limitTooltip,
} = clientExports

let passed = 0
async function check(label, fn) {
  try {
    await fn()
    passed += 1
    console.log('  ✓', label)
  } catch (error) {
    console.error('  ✗', label)
    console.error('   ', error?.message ?? error)
    process.exitCode = 1
  }
}

console.log('dsh-model-surplus tests\n--- host half: opencode-go usage ---')

await check('normalizeBucket accepts a real payload and clamps', () => {
  assert.deepEqual(normalizeBucket({ status: 'ok', percent: 13, resetsAt: '2026-09-10T16:02:32.008Z' }), {
    status: 'ok',
    percent: 13,
    resetsAt: '2026-09-10T16:02:32.008Z',
  })
  // Clamping: a buggy/hostile upstream must not produce a nonsense bar.
  assert.equal(normalizeBucket({ percent: 250 }).percent, 100)
  assert.equal(normalizeBucket({ percent: -5 }).percent, 0)
  // Non-numeric percent is unusable.
  assert.equal(normalizeBucket({ percent: 'lots' }), null)
  assert.equal(normalizeBucket(null), null)
  // Missing resetsAt degrades to null rather than throwing.
  assert.equal(normalizeBucket({ percent: 5 }).resetsAt, null)
})

await check('normalizeUsage maps the real upstream body', () => {
  const real = {
    usage: {
      rolling: { status: 'ok', percent: 13, resetsAt: '2026-09-10T16:02:32.008Z' },
      weekly: { status: 'ok', percent: 80, resetsAt: '2026-09-14T00:00:00.008Z' },
      monthly: { status: 'ok', percent: 41, resetsAt: '2026-10-06T11:11:50.008Z' },
    },
  }
  const out = normalizeUsage(real)
  assert.equal(out.rolling.percent, 13)
  assert.equal(out.weekly.percent, 80)
  assert.equal(out.monthly.percent, 41)
  // Partial payloads keep only the usable buckets.
  assert.deepEqual(Object.keys(normalizeUsage({ usage: { weekly: { percent: 5 } } })), ['weekly'])
  // Nothing usable -> null (the widget then shows "unavailable").
  assert.equal(normalizeUsage({ usage: {} }), null)
  assert.equal(normalizeUsage({}), null)
  assert.equal(normalizeUsage(null), null)
})

await check('isTrackedProvider matches configured routes only', () => {
  const tracked = new Set(['opencode-go', 'opencode'])
  assert.equal(isTrackedProvider('opencode-go', tracked), true)
  assert.equal(isTrackedProvider('opencode', tracked), true)
  assert.equal(isTrackedProvider('deepseek-official', tracked), false)
  assert.equal(isTrackedProvider('', tracked), false)
  assert.equal(isTrackedProvider(undefined, tracked), false)
})

await check('fetchUsage: 200 parses, 401 -> unauthorized, bad body -> bad-payload', async () => {
  const okFetch = async () => ({
    ok: true,
    json: async () => ({ usage: { rolling: { percent: 10 } } }),
  })
  const ok = await fetchUsage({ baseUrl: 'https://x/v1', apiKey: 'k', fetchImpl: okFetch })
  assert.equal(ok.ok, true)
  assert.equal(ok.usage.rolling.percent, 10)

  const un = await fetchUsage({ baseUrl: 'https://x/v1', apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 401 }) })
  assert.equal(un.ok, false)
  assert.equal(un.reason, 'unauthorized')

  const up = await fetchUsage({ baseUrl: 'https://x/v1', apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 500 }) })
  assert.equal(up.reason, 'upstream')

  const bad = await fetchUsage({ baseUrl: 'https://x/v1', apiKey: 'k', fetchImpl: async () => ({ ok: true, json: async () => ({ nope: 1 }) }) })
  assert.equal(bad.reason, 'bad-payload')

  const net = await fetchUsage({
    baseUrl: 'https://x/v1',
    apiKey: 'k',
    fetchImpl: async () => {
      throw new Error('boom')
    },
  })
  assert.equal(net.reason, 'network')
})

await check('fetchUsage sends the key as a Bearer header, never in the URL', async () => {
  let seen = null
  await fetchUsage({
    baseUrl: 'https://api.example/zen/go/v1',
    apiKey: 'SECRET-KEY',
    fetchImpl: async (url, init) => {
      seen = { url, init }
      return { ok: true, json: async () => ({ usage: { rolling: { percent: 1 } } }) }
    },
  })
  assert.equal(seen.url, 'https://api.example/zen/go/v1/usage')
  assert.equal(seen.init.headers.authorization, 'Bearer SECRET-KEY')
  assert.ok(!seen.url.includes('SECRET-KEY'), 'key must never appear in the URL')
})

console.log('\n--- host half: deepseek balance ---')

await check('normalizeAmount accepts decimal strings and finite numbers', () => {
  assert.equal(normalizeAmount('110.00'), '110.00')
  assert.equal(normalizeAmount(' 12.5 '), '12.5')
  assert.equal(normalizeAmount(12.5), '12.5')
  assert.equal(normalizeAmount(0), '0')
  assert.equal(normalizeAmount(''), null)
  assert.equal(normalizeAmount('   '), null)
  assert.equal(normalizeAmount(Number.NaN), null)
  assert.equal(normalizeAmount(Number.POSITIVE_INFINITY), null)
  assert.equal(normalizeAmount(null), null)
  assert.equal(normalizeAmount(undefined), null)
  assert.equal(normalizeAmount({}), null)
})

await check('normalizeBalance maps the documented body', () => {
  // Exactly the shape DeepSeek documents for GET /user/balance.
  const real = {
    is_available: true,
    balance_infos: [
      { currency: 'CNY', total_balance: '110.00', granted_balance: '10.00', topped_up_balance: '100.00' },
    ],
  }
  const out = normalizeBalance(real)
  assert.equal(out.isAvailable, true)
  assert.equal(out.infos.length, 1)
  assert.deepEqual(out.infos[0], { currency: 'CNY', total: '110.00', granted: '10.00', toppedUp: '100.00' })
  // Currency is upper-cased for stable display keys.
  assert.equal(normalizeBalance({ balance_infos: [{ currency: 'usd', total_balance: '5' }] }).infos[0].currency, 'USD')
  // Missing granted/topped-up degrade to null instead of throwing.
  assert.equal(normalizeBalance({ balance_infos: [{ currency: 'CNY', total_balance: '1' }] }).infos[0].granted, null)
})

await check('normalizeBalance: unavailable with no entry is a real answer, not bad-payload', () => {
  // "No balance left" is exactly is_available:false with an empty list.
  const out = normalizeBalance({ is_available: false, balance_infos: [] })
  assert.equal(out.isAvailable, false)
  assert.deepEqual(out.infos, [])
  // A bare flag is still usable.
  assert.equal(normalizeBalance({ is_available: true }).isAvailable, true)
  // A foreign payload is not.
  assert.equal(normalizeBalance({ nope: 1 }), null)
  assert.equal(normalizeBalance(null), null)
  assert.equal(normalizeBalance([]), null)
  assert.equal(normalizeBalance('x'), null)
  // Entries that carry no currency/amount are dropped, not fatal.
  assert.deepEqual(normalizeBalance({ is_available: true, balance_infos: [{ currency: 'CNY' }, null, 'x'] }).infos, [])
})

await check('fetchBalance hits /user/balance with the Bearer key', async () => {
  let seen = null
  const res = await fetchBalance({
    baseUrl: 'https://api.deepseek.com',
    apiKey: 'DS-SECRET',
    fetchImpl: async (url, init) => {
      seen = { url, init }
      return { ok: true, json: async () => ({ is_available: true, balance_infos: [{ currency: 'CNY', total_balance: '42.00' }] }) }
    },
  })
  assert.equal(seen.url, 'https://api.deepseek.com/user/balance')
  assert.equal(seen.init.headers.authorization, 'Bearer DS-SECRET')
  assert.ok(!seen.url.includes('DS-SECRET'), 'key must never appear in the URL')
  assert.equal(res.ok, true)
  assert.equal(res.balance.infos[0].total, '42.00')
  assert.ok(Number.isFinite(res.fetchedAt))

  const un = await fetchBalance({ baseUrl: 'https://api.deepseek.com', apiKey: 'k', fetchImpl: async () => ({ ok: false, status: 403 }) })
  assert.equal(un.reason, 'unauthorized')
  const bad = await fetchBalance({ baseUrl: 'https://api.deepseek.com', apiKey: 'k', fetchImpl: async () => ({ ok: true, json: async () => ({ nope: 1 }) }) })
  assert.equal(bad.reason, 'bad-payload')
})

await check('resolveSections applies defaults and validates providers', () => {
  const defaults = resolveSections({})
  assert.deepEqual(defaults['opencode-go'].providers, ['opencode-go', 'opencode'])
  assert.deepEqual(defaults.deepseek.providers, ['deepseek-official'])
  assert.equal(defaults['opencode-go'].baseUrl, 'https://opencode.ai/zen/go/v1')
  assert.equal(defaults.deepseek.baseUrl, 'https://api.deepseek.com')
  assert.equal(defaults['opencode-go'].apiKeyRef, 'OPENCODE_GO_API_KEY')
  assert.equal(defaults.deepseek.apiKeyRef, 'DEEPSEEK_API_KEY')

  // Nested config wins; trailing slashes are trimmed.
  const custom = resolveSections({
    opencodeGo: { baseUrl: 'https://a/v1/', providers: ['oc'] },
    deepseek: { providers: ['ds', 'deepseek'] },
  })
  assert.equal(custom['opencode-go'].baseUrl, 'https://a/v1')
  assert.deepEqual(custom['opencode-go'].providers, ['oc'])
  assert.deepEqual(custom.deepseek.providers, ['ds', 'deepseek'])

  // Legacy flat shorthand is read as the opencode-go section only.
  const legacy = resolveSections({ baseUrl: 'https://old/v1', apiKeyRef: 'OLD_KEY', providers: ['legacy'] })
  assert.equal(legacy['opencode-go'].baseUrl, 'https://old/v1')
  assert.equal(legacy['opencode-go'].apiKeyRef, 'OLD_KEY')
  assert.deepEqual(legacy['opencode-go'].providers, ['legacy'])
  // ...and never leaks into deepseek.
  assert.equal(legacy.deepseek.baseUrl, 'https://api.deepseek.com')
  assert.deepEqual(legacy.deepseek.providers, ['deepseek-official'])

  // An empty providers array falls back to defaults rather than tracking nothing.
  assert.deepEqual(resolveSections({ deepseek: { providers: [] } }).deepseek.providers, ['deepseek-official'])
  // tracked is a Set for O(1) lookups in the route handler.
  assert.equal(defaults.deepseek.tracked.has('deepseek-official'), true)
})

console.log('\n--- host half: per-model monthly limits (docs) ---')

await check('BUILTIN_MODEL_LIMITS is a sane, non-empty table', () => {
  const entries = Object.entries(BUILTIN_MODEL_LIMITS)
  assert.ok(entries.length >= 20, `expected a substantial table, got ${entries.length}`)
  const ids = new Set()
  for (const [id, monthly] of entries) {
    assert.match(id, /^[a-z0-9][a-z0-9.-]*$/, `bad model id ${id}`)
    assert.ok(!ids.has(id), `duplicate id ${id}`)
    ids.add(id)
    assert.ok(Number.isFinite(monthly) && monthly > 0, `bad limit for ${id}: ${monthly}`)
  }
  // Spot checks from the docs table (2026-09-20).
  assert.equal(BUILTIN_MODEL_LIMITS['deepseek-v4.1-flash'], 60)
  assert.equal(BUILTIN_MODEL_LIMITS['deepseek-v4-pro'], 15)
  assert.equal(BUILTIN_MODEL_LIMITS['deepseek-v4-flash'], 30)
  assert.equal(BUILTIN_MODEL_LIMITS['deepseek-v4-flash-vision-exp'], 15)
})

await check('normalizeLimitName makes the two docs tables joinable', () => {
  assert.equal(normalizeLimitName('MiMo V2.5'), normalizeLimitName('MiMo-V2.5'))
  assert.equal(normalizeLimitName('DeepSeek V4.1 Flash (Off-Peak)'), normalizeLimitName('DeepSeek V4.1 Flash'))
  assert.equal(normalizeLimitName('GPT 5.6 Luna (≤ 272K tokens)'), normalizeLimitName('GPT 5.6 Luna'))
  assert.equal(normalizeLimitName('Kimi K2.7 Code'), 'kimik27code')
})

await check('parseLimitsTable reads the docs table incl. promo strikethrough', () => {
  const html = `<table><thead><tr><th>模型</th><th>输入</th><th>输出</th><th>缓存读取</th><th>缓存写入</th><th>每月限制</th></tr></thead><tbody>
    <tr><td>GLM-5.3-Flash</td><td>$0.15</td><td>$0.50</td><td>$0.03</td><td>-</td><td><strong>$60</strong></td></tr>
    <tr><td>DeepSeek V4.1 Flash (Off-Peak)</td><td>$0.15</td><td>$0.60</td><td>$0.003</td><td>-</td><td><del>$15</del> <strong>$60</strong> 4x · 9 月 20 日结束</td></tr>
    <tr><td>DeepSeek V4.1 Flash (Peak)</td><td>$0.30</td><td>$1.20</td><td>$0.006</td><td>-</td><td><del>$15</del> <strong>$60</strong></td></tr>
  </tbody></table>`
  const out = parseLimitsTable(html)
  assert.equal(out.get(normalizeLimitName('GLM-5.3-Flash')), 60)
  // Promo cell: the LAST $ is the effective limit; peak/off-peak collapse to one.
  assert.equal(out.get(normalizeLimitName('DeepSeek V4.1 Flash')), 60)
  assert.equal(out.size, 2)
})

await check('parseModelIdTable maps display names to model ids', () => {
  const html = `<table><thead><tr><th>模型</th><th>模型 ID</th><th>端点</th><th>AI SDK 包</th></tr></thead><tbody>
    <tr><td>DeepSeek V4.1 Flash</td><td>deepseek-v4.1-flash</td><td><code dir="auto">https://opencode.ai/zen/go/v1/chat/completions</code></td><td><code dir="auto">@ai-sdk/openai-compatible</code></td></tr>
    <tr><td>MiMo-V2.5</td><td>mimo-v2.5</td><td><code dir="auto">https://opencode.ai/zen/go/v1/chat/completions</code></td><td><code dir="auto">@ai-sdk/openai-compatible</code></td></tr>
  </tbody></table>`
  const out = parseModelIdTable(html)
  assert.equal(out.get(normalizeLimitName('DeepSeek V4.1 Flash')), 'deepseek-v4.1-flash')
  assert.equal(out.get(normalizeLimitName('MiMo V2.5')), 'mimo-v2.5')
})

await check('parseDocsLimits joins both tables into modelId -> monthly', () => {
  const html = `<table><thead><tr><th>模型</th><th>输入</th><th>输出</th><th>缓存读取</th><th>缓存写入</th><th>每月限制</th></tr></thead><tbody>
    <tr><td>DeepSeek V4.1 Flash</td><td>$0.15</td><td>$0.60</td><td>$0.003</td><td>-</td><td><strong>$60</strong></td></tr>
    <tr><td>MiMo V2.5</td><td>$0.14</td><td>$0.28</td><td>$0.0028</td><td>-</td><td><strong>$60</strong></td></tr>
  </tbody></table>
  <table><thead><tr><th>模型</th><th>模型 ID</th><th>端点</th><th>AI SDK 包</th></tr></thead><tbody>
    <tr><td>DeepSeek V4.1 Flash</td><td>deepseek-v4.1-flash</td><td><code dir="auto">https://opencode.ai/zen/go/v1/chat/completions</code></td><td><code dir="auto">@ai-sdk/openai-compatible</code></td></tr>
    <tr><td>MiMo-V2.5</td><td>mimo-v2.5</td><td><code dir="auto">https://opencode.ai/zen/go/v1/chat/completions</code></td><td><code dir="auto">@ai-sdk/openai-compatible</code></td></tr>
  </tbody></table>`
  const parsed = parseDocsLimits(html)
  assert.equal(parsed.limits['deepseek-v4.1-flash'], 60)
  assert.equal(parsed.limits['mimo-v2.5'], 60)
  assert.ok(typeof parsed.fetchedAt === 'string' && parsed.fetchedAt.length > 0)
  // Unusable page -> null (the caller falls back to cache/built-in).
  assert.equal(parseDocsLimits('<html><body>no tables here</body></html>'), null)
})

await check('deriveLimitTiers applies the docs 20%/50%/100% rule', () => {
  assert.deepEqual(deriveLimitTiers(60), { hours5: 12, weekly: 30, monthly: 60 })
  assert.deepEqual(deriveLimitTiers(15), { hours5: 3, weekly: 7.5, monthly: 15 })
  assert.deepEqual(deriveLimitTiers(30), { hours5: 6, weekly: 15, monthly: 30 })
  assert.deepEqual(deriveLimits({ 'deepseek-v4.1-flash': 60 }), {
    'deepseek-v4.1-flash': { hours5: 12, weekly: 30, monthly: 60 },
  })
  // Non-finite/zero entries are dropped.
  assert.deepEqual(deriveLimits({ a: 60, b: 0, c: Number.NaN }), { a: { hours5: 12, weekly: 30, monthly: 60 } })
})

await check('limits cache round-trips and survives bad input', async () => {
  const os = await import('node:os')
  const fs = await import('node:fs')
  const path = await import('node:path')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mu-limits-'))
  try {
    const dshHome = path.join(dir, 'home')
    const payload = { limits: { 'deepseek-v4.1-flash': 60 }, fetchedAt: '2026-09-20T00:00:00.000Z' }
    assert.equal(await writeLimitsCache(dshHome, payload), true)
    assert.ok(fs.existsSync(limitsCachePath(dshHome)))
    const back = await readLimitsCache(dshHome)
    assert.deepEqual(back, payload)
    // A corrupt cache degrades to null, never throws.
    fs.rmSync(limitsCachePath(dshHome), { force: true })
    fs.mkdirSync(limitsCachePath(dshHome), { recursive: true }) // a directory is not a file
    assert.equal(await readLimitsCache(dshHome), null)
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

await check('fetchDocsLimits: 200 parses, non-200/bad body classify', async () => {
  const okHtml = `<table><thead><tr><th>模型</th><th>输入</th><th>输出</th><th>缓存读取</th><th>缓存写入</th><th>每月限制</th></tr></thead><tbody>
    <tr><td>GLM-5.3-Flash</td><td>$0.15</td><td>$0.50</td><td>$0.03</td><td>-</td><td><strong>$60</strong></td></tr>
  </tbody></table>
  <table><thead><tr><th>模型</th><th>模型 ID</th><th>端点</th><th>AI SDK 包</th></tr></thead><tbody>
    <tr><td>GLM-5.3-Flash</td><td>glm-5.3-flash</td><td><code dir="auto">https://opencode.ai/zen/go/v1/chat/completions</code></td><td><code dir="auto">@ai-sdk/openai-compatible</code></td></tr>
  </tbody></table>`
  const ok = await fetchDocsLimits({ fetchImpl: async () => ({ ok: true, text: async () => okHtml }) })
  assert.equal(ok.ok, true)
  assert.equal(ok.limits['glm-5.3-flash'], 60)

  const http = await fetchDocsLimits({ fetchImpl: async () => ({ ok: false, status: 500 }) })
  assert.equal(http.ok, false)
  assert.equal(http.reason, 'upstream')

  const bad = await fetchDocsLimits({ fetchImpl: async () => ({ ok: true, text: async () => '<html>nope</html>' }) })
  assert.equal(bad.ok, false)
  assert.equal(bad.reason, 'bad-payload')

  const net = await fetchDocsLimits({ fetchImpl: async () => { throw new Error('boom') } })
  assert.equal(net.ok, false)
  assert.equal(net.reason, 'network')
})

console.log('\n--- client half (pure helpers) ---')

await check('pickSection routes the active provider to its section', () => {
  const sections = {
    'opencode-go': { providers: ['opencode-go', 'opencode'] },
    deepseek: { providers: ['deepseek-official'] },
  }
  assert.equal(pickSection('opencode-go', sections), 'opencode-go')
  assert.equal(pickSection('opencode', sections), 'opencode-go')
  assert.equal(pickSection('deepseek-official', sections), 'deepseek')
  // Unknown providers show nothing.
  assert.equal(pickSection('anthropic', sections), null)
  assert.equal(pickSection(undefined, sections), null)
  assert.equal(pickSection('', sections), null)
  // Before the first host response the fallback mapping still gates correctly.
  assert.equal(pickSection('deepseek-official', null), 'deepseek')
  assert.equal(pickSection('opencode-go', undefined), 'opencode-go')
  // A section with a broken providers value is skipped, not fatal.
  assert.equal(pickSection('deepseek-official', { deepseek: { providers: 'nope' } }), null)
})

await check('isTracked mirrors pickSection', () => {
  const sections = { deepseek: { providers: ['deepseek-official'] } }
  assert.equal(isTracked('deepseek-official', sections), true)
  assert.equal(isTracked('opencode-go', sections), false)
})

await check('currencySymbol / formatAmount render money', () => {
  assert.equal(currencySymbol('CNY'), '¥')
  assert.equal(currencySymbol('usd'), '$')
  assert.equal(currencySymbol('EUR'), 'EUR ')
  assert.equal(currencySymbol(''), '')
  assert.equal(currencySymbol(undefined), '')
  assert.equal(formatAmount({ currency: 'CNY', total: '110.00' }), '¥110.00')
  assert.equal(formatAmount({ currency: 'USD', total: '15' }), '$15')
  assert.equal(formatAmount(null), '')
})

await check('percentColor escalates with consumption', () => {
  assert.equal(percentColor(10), '#4d9fff')
  assert.equal(percentColor(70), '#e8a33d')
  assert.equal(percentColor(95), '#e5534b')
})

await check('formatReset renders a relative string for near dates', () => {
  const soon = new Date(Date.now() + 3 * 3_600_000 + 30 * 60_000).toISOString()
  const zh = formatReset(soon, true)
  assert.ok(zh.includes('小时'), `expected hours text, got ${zh}`)
  assert.ok(zh.includes('重置'))
  const en = formatReset(soon, false)
  assert.ok(en.startsWith('resets in'), `expected "resets in…", got ${en}`)
  // Far dates fall back to a calendar date.
  const far = new Date(Date.now() + 40 * 24 * 3_600_000).toISOString()
  assert.ok(!formatReset(far, true).includes('小时'))
  // Invalid input degrades to empty, never throws.
  assert.equal(formatReset('not-a-date', true), '')
})

await check('findLimit looks up the selected model cap', () => {
  const limits = { 'deepseek-v4.1-flash': { hours5: 12, weekly: 30, monthly: 60 } }
  assert.deepEqual(findLimit(limits, 'deepseek-v4.1-flash'), { hours5: 12, weekly: 30, monthly: 60 })
  assert.equal(findLimit(limits, 'deepseek-v4-pro'), undefined)
  assert.equal(findLimit(limits, ''), undefined)
  assert.equal(findLimit(limits, undefined), undefined)
  assert.equal(findLimit(null, 'deepseek-v4.1-flash'), undefined)
})

await check('limitSourceLabel localizes the table source', () => {
  const t = (k) => ({ sourceDocs: 'OpenCode Go 文档', sourceCache: '本地缓存', sourceBuiltin: '内置表' })[k] ?? k
  const zh = true
  assert.equal(limitSourceLabel({ source: 'docs', updatedAt: '2026-09-20T00:00:00Z' }, t, zh), 'OpenCode Go 文档（9/20）')
  assert.equal(limitSourceLabel({ source: 'cache', updatedAt: '2026-09-19T00:00:00Z' }, t, zh), '本地缓存（9/19）')
  assert.equal(limitSourceLabel({ source: 'builtin' }, t, zh), '内置表')
  assert.equal(limitSourceLabel(null, t, zh), '内置表')
})

await check('limitTooltip assembles the cap + source + account-note lines', () => {
  const t = (k) => k
  const meta = { source: 'docs', updatedAt: '2026-09-20T00:00:00Z' }
  const tip = limitTooltip('deepseek-v4.1-flash', { hours5: 12, weekly: 30, monthly: 60 }, meta, t, true, 'base title')
  assert.ok(tip.startsWith('base title'))
  assert.ok(tip.includes('deepseek-v4.1-flash'))
  assert.ok(tip.includes('$60'))
  assert.ok(tip.includes('sourceDocs'))
  assert.ok(tip.includes('accountNote'))
  // No entry -> only the base title.
  assert.equal(limitTooltip('x', undefined, meta, t, true, 'only'), 'only')
})

await check('usage store notifies subscribers and replaces state', () => {
  const store = createUsageStore()
  assert.equal(store.get().status, 'idle')
  let calls = 0
  const unsub = store.subscribe(() => {
    calls += 1
  })
  store.set({ status: 'ready', payload: { ok: true, deepseek: { ok: true } } })
  assert.equal(calls, 1)
  assert.equal(store.get().status, 'ready')
  assert.equal(store.get().payload.deepseek.ok, true)
  unsub()
  store.set({ status: 'error' })
  assert.equal(calls, 1, 'unsubscribed listener must not fire again')
})

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
