// dsh-model-usage — host half.
//
// Fetches per-account model usage / balance and serves it to the client half
// over a same-origin JSON route. The browser must never see an API key, so
// every upstream call happens here.
//
// Two independent sections, each gated on the session's active provider route:
//
//   1. opencode-go — plan usage percentages.
//      GET https://opencode.ai/zen/go/v1/usage
//      Authorization: Bearer <OPENCODE_GO_API_KEY>
//      200 {"usage":{"rolling":{"status":"ok","percent":13,"resetsAt":"..."},
//                    "weekly":{...},"monthly":{...}}}
//      401 without a valid key.
//
//   2. deepseek — account balance (DeepSeek's documented Get User Balance).
//      GET https://api.deepseek.com/user/balance
//      Authorization: Bearer <DEEPSEEK_API_KEY>
//      200 {"is_available":true,
//           "balance_infos":[{"currency":"CNY","total_balance":"110.00",
//                             "granted_balance":"10.00","topped_up_balance":"100.00"}]}
//
// PLUS a per-model monthly limit table for opencode-go (the docs' "使用限制"
// section). There is NO API for it, so the plugin:
//   - ships a built-in table (last synced from the docs),
//   - auto-refreshes by fetching the public docs page (no key needed) and
//     parsing the limits + model-id tables,
//   - caches the parsed result under $DSH_HOME/logs/model-usage-limits.json,
//   - falls back cache -> built-in on any failure.
// OpenCode Go's usage endpoint is account-wide (it ignores per-model params);
// the per-model limits are informational — they label the SELECTED model's
// monthly cap, while the percent bars stay the account's real consumption.
//
// Keys are resolved through the engine's credential service by REFERENCE
// (`OPENCODE_GO_API_KEY` / `DEEPSEEK_API_KEY`), never read from a file: that is
// the same seam every provider uses, so a key the user rotates reaches the next
// request with no plugin restart.
//
// NOTE: the reference is passed as a plain string rather than importing
// `credentialRef` from `@deepseek-ai/dsh-credentials`. That helper only brands
// the value for TypeScript (`brandString` is a runtime no-op), while importing
// the package would make this plugin fail to load wherever the engine's
// dependency tree is not on the resolution path.

import { join } from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'

export const name = 'model-usage'

// `credentials` for the API keys, `webServer` for the JSON route the page calls.
export const inject = ['credentials', 'webServer']

/**
 * Section key -> defaults. The section key is the wire/`sections` key; the
 * camelCase `configKey` is what the plugin row's `config` object uses (YAML
 * keys read better in camelCase). Also the display order.
 */
const SECTION_DEFAULTS = {
  'opencode-go': {
    configKey: 'opencodeGo',
    baseUrl: 'https://opencode.ai/zen/go/v1',
    apiKeyRef: 'OPENCODE_GO_API_KEY',
    providers: ['opencode-go', 'opencode'],
  },
  deepseek: {
    configKey: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    apiKeyRef: 'DEEPSEEK_API_KEY',
    // The engine's dsh-llm-deepseek adapter registers exactly this route
    // (`const PROVIDER = "deepseek-official"`).
    providers: ['deepseek-official'],
  },
}

/** Host route the client half polls. */
const ROUTE_PATH = '/model-usage'

/** Buckets the OpenCode Go upstream reports, in display order. */
const BUCKETS = ['rolling', 'weekly', 'monthly']

// ---------------------------------------------------------------------------
// Per-model monthly limits (OpenCode Go docs "使用限制" table).
//
// There is no API for these; the plugin auto-refreshes them from the public
// docs page and falls back to this built-in snapshot (last synced 2026-09-20
// from https://opencode.ai/docs/zh-cn/go/). Keyed by the model id the engine's
// pi-ai catalog / user settings use ("deepseek-v4.1-flash", "glm-5.1", ...).
// ---------------------------------------------------------------------------

/** Docs page (public, server-rendered — no JS, no API key needed). */
const DOCS_URL = 'https://opencode.ai/docs/zh-cn/go/'
/** Re-fetch the docs at most this often. */
const LIMITS_REFRESH_MS = 24 * 60 * 60 * 1000
/** Docs fetch timeout. */
const LIMITS_FETCH_TIMEOUT_MS = 15000
/** Cache file name under $DSH_HOME/logs. */
const LIMITS_CACHE_FILE = 'model-usage-limits.json'

/**
 * Built-in model id -> monthly limit (USD). Values are the docs' "每月限制"
 * column. The derived 5-hour / weekly caps are 20% / 50% of monthly (docs rule).
 */
export const BUILTIN_MODEL_LIMITS = {
  'deepseek-v4-flash': 30,
  'deepseek-v4-flash-vision-exp': 15,
  'deepseek-v4-pro': 15,
  'deepseek-v4.1-flash': 60,
  'glm-5.1': 60,
  'glm-5.2': 60,
  'glm-5.3': 15,
  'glm-5.3-flash': 60,
  'gpt-5.6-luna': 15,
  'grok-4.6': 15,
  'hy3': 60,
  'hy4-preview': 30,
  'kimi-k2.6': 60,
  'kimi-k2.7-code': 60,
  'kimi-k3': 15,
  'longcat-2.0': 60,
  'mimo-v2.5': 60,
  'mimo-v2.5-pro': 15,
  'minimax-m2.5': 60,
  'minimax-m2.7': 60,
  'minimax-m3': 60,
  'muse-spark-1.2-contributor': 60,
  'muse-spark-1.3-contributor': 60,
  'qwen3.6-plus': 60,
  'qwen3.7-max': 30,
  'qwen3.7-plus': 60,
  'qwen3.8-flash': 30,
  'qwen3.8-max': 15,
}

/**
 * Join key shared by the docs' limits table and model-id table: lower-case,
 * punctuation/space stripped, trailing context ("(Off-Peak)", "(≤ 256K
 * tokens)") removed. Both tables spell the same model differently ("MiMo V2.5"
 * vs "MiMo-V2.5"), so the join normalizes before matching.
 */
export function normalizeLimitName(name) {
  return String(name)
    .toLowerCase()
    .replace(/\s*\(.*\)\s*$/u, '') // trailing context suffix
    .replace(/[\s\-(),.+]/gu, '') // punctuation/space
}

/**
 * Parse the docs' per-model LIMITS table (`模型 | 输入 | 输出 | 缓存读取 |
 * 缓存写入 | 每月限制`) into `normalized-name -> effective monthly $`.
 *
 * The limit cell may carry promo text ("~~$15~~ $60 4x · 9 月 20 日结束");
 * the LAST `$number` is the current effective limit. Rows with context
 * suffixes ("(Off-Peak)", "(≤ 256K tokens)") collapse onto their base model.
 * @returns {Map<string, number>} keyed by {@link normalizeLimitName}.
 */
export function parseLimitsTable(html) {
  const out = new Map()
  const head = html.indexOf('每月限制</th></tr>')
  if (head < 0) return out
  const body = html.slice(head, html.indexOf('</tbody></table>', head))
  const rowRe = /<tr><td>(.*?)<\/td><td>(.*?)<\/td><td>(.*?)<\/td><td>(.*?)<\/td><td>(.*?)<\/td><td>(.*?)<\/td><\/tr>/g
  for (const m of body.matchAll(rowRe)) {
    const rawName = m[1].replace(/<[^>]+>/g, '').trim()
    const base = rawName.replace(/\s*\(.*\)\s*$/u, '').trim()
    if (base === '') continue
    const cell = m[6].replace(/<[^>]+>/g, ' ').trim()
    const dollars = [...cell.matchAll(/\$(\d+(?:\.\d+)?)/g)].map((x) => Number(x[1]))
    const effective = dollars.length > 0 ? dollars[dollars.length - 1] : null
    if (effective === null || !Number.isFinite(effective) || effective <= 0) continue
    const key = normalizeLimitName(base)
    if (!out.has(key)) out.set(key, effective)
  }
  return out
}

/**
 * Parse the docs' MODEL-ID table (`模型 | 模型 ID | 端点 | AI SDK 包`) into
 * `normalized-name -> model id`.
 * @returns {Map<string, string>} keyed by {@link normalizeLimitName}.
 */
export function parseModelIdTable(html) {
  const out = new Map()
  const idRe = /<tr><td>(.*?)<\/td><td>([a-z0-9][a-z0-9.-]*)<\/td><td><code[^>]*>https:\/\/opencode\.ai\/zen\/go\/v1\/(?:chat|messages|responses)[^<]*<\/code>/g
  for (const m of html.matchAll(idRe)) {
    const name = m[1].replace(/<[^>]+>/g, '').trim()
    if (name === '') continue
    const key = normalizeLimitName(name)
    if (!out.has(key)) out.set(key, m[2])
  }
  return out
}

/**
 * Parse the docs page into a model-id -> monthly-limit map.
 * @returns `{ limits, fetchedAt }` or null when either table is unusable.
 */
export function parseDocsLimits(html) {
  const limitsByName = parseLimitsTable(html)
  const idByName = parseModelIdTable(html)
  if (limitsByName.size === 0 || idByName.size === 0) return null
  const limits = {}
  for (const [key, monthly] of limitsByName) {
    const id = idByName.get(key)
    if (id !== undefined) limits[id] = monthly
  }
  if (Object.keys(limits).length === 0) return null
  return { limits, fetchedAt: new Date().toISOString() }
}

/** The 5-hour / weekly / monthly caps derived from one monthly limit. */
export function deriveLimitTiers(monthly) {
  const round1 = (x) => Math.round(x * 10) / 10
  return {
    hours5: round1(monthly * 0.2),
    weekly: round1(monthly * 0.5),
    monthly,
  }
}

/** Map model id -> derived tiers ({ hours5, weekly, monthly }). */
export function deriveLimits(limits) {
  const out = {}
  for (const [id, monthly] of Object.entries(limits ?? {})) {
    if (Number.isFinite(monthly) && monthly > 0) out[id] = deriveLimitTiers(monthly)
  }
  return out
}

/** Absolute path of the limits cache file for one DSH home. */
export function limitsCachePath(dshHome) {
  return join(dshHome, 'logs', LIMITS_CACHE_FILE)
}

/** Read the cached `{ limits, fetchedAt }`, or null when absent/unreadable. */
export async function readLimitsCache(dshHome) {
  try {
    const text = await readFile(limitsCachePath(dshHome), 'utf8')
    const parsed = JSON.parse(text)
    if (parsed === null || typeof parsed !== 'object') return null
    const limits = parsed.limits
    const fetchedAt = parsed.fetchedAt
    if (limits === null || typeof limits !== 'object' || typeof fetchedAt !== 'string') return null
    return { limits, fetchedAt }
  } catch {
    return null
  }
}

/** Write `{ limits, fetchedAt }` to the cache file (best effort). */
export async function writeLimitsCache(dshHome, { limits, fetchedAt }) {
  try {
    await mkdir(join(dshHome, 'logs'), { recursive: true })
    await writeFile(limitsCachePath(dshHome), JSON.stringify({ limits, fetchedAt }), 'utf8')
    return true
  } catch {
    return false
  }
}

/** Cache lifetime: an upstream is polled only this often, even on many page loads. */
const CACHE_TTL_MS = 60_000
/** Minimum gap between upstream calls after a failure (avoid hammering a 401). */
const FAILURE_TTL_MS = 30_000
/** Upstream request timeout. */
const REQUEST_TIMEOUT_MS = 10_000

/**
 * Normalize one OpenCode Go bucket payload.
 * @returns `{ status, percent, resetsAt }` or null when unusable.
 */
export function normalizeBucket(raw) {
  if (raw === null || typeof raw !== 'object') return null
  const percent = Number(raw.percent)
  if (!Number.isFinite(percent)) return null
  const status = typeof raw.status === 'string' && raw.status.length > 0 ? raw.status : 'ok'
  const resetsAt = typeof raw.resetsAt === 'string' && raw.resetsAt.length > 0 ? raw.resetsAt : null
  // Clamp: a hostile or buggy upstream must not produce a nonsense bar width.
  return { status, percent: Math.min(100, Math.max(0, percent)), resetsAt }
}

/** Normalize a whole OpenCode Go body into our wire shape, or null when unusable. */
export function normalizeUsage(body) {
  const usage = body?.usage
  if (usage === null || typeof usage !== 'object') return null
  const out = {}
  let any = false
  for (const key of BUCKETS) {
    const bucket = normalizeBucket(usage[key])
    if (bucket !== null) {
      out[key] = bucket
      any = true
    }
  }
  return any ? out : null
}

/**
 * A money amount the upstream reports as a decimal STRING (per DeepSeek's
 * contract). Accepts a finite number too, so a gateway that sends JSON numbers
 * still works; anything else is unusable.
 */
export function normalizeAmount(value) {
  if (typeof value === 'string' && value.trim() !== '') return value.trim()
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  return null
}

/**
 * Normalize DeepSeek's Get User Balance body.
 *
 * Wire shape:
 *   { is_available: boolean,
 *     balance_infos: [{ currency, total_balance, granted_balance, topped_up_balance }] }
 *
 * `is_available: false` with no usable entry is still a REAL answer ("no balance
 * left"), so it is reported rather than degraded to bad-payload; only a body
 * that carries neither field is treated as unusable.
 *
 * @returns `{ isAvailable, infos: [{ currency, total, granted, toppedUp }] }` or null.
 */
export function normalizeBalance(body) {
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return null
  const hasFlag = typeof body.is_available === 'boolean'
  const rawInfos = Array.isArray(body.balance_infos) ? body.balance_infos : null
  if (!hasFlag && rawInfos === null) return null
  const infos = []
  for (const raw of rawInfos ?? []) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) continue
    const currency = typeof raw.currency === 'string' ? raw.currency.trim().toUpperCase() : ''
    const total = normalizeAmount(raw.total_balance)
    if (currency === '' || total === null) continue
    infos.push({
      currency,
      total,
      granted: normalizeAmount(raw.granted_balance),
      toppedUp: normalizeAmount(raw.topped_up_balance),
    })
  }
  return { isAvailable: body.is_available !== false, infos }
}

/** True when a provider route should show the widget. */
export function isTrackedProvider(provider, tracked) {
  if (typeof provider !== 'string' || provider.length === 0) return false
  return tracked.has(provider)
}

/** Shared upstream GET returning `{ ok, status, body }` or a classified failure. */
async function upstreamJson({ url, apiKey, fetchImpl, timeoutMs, log, label }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, {
      headers: { authorization: `Bearer ${apiKey}`, accept: 'application/json' },
      signal: controller.signal,
    })
    if (!res.ok) {
      log(`${label}: upstream responded`, res.status)
      return {
        ok: false,
        reason: res.status === 401 || res.status === 403 ? 'unauthorized' : 'upstream',
        status: res.status,
      }
    }
    const body = await res.json().catch(() => null)
    return { ok: true, body }
  } catch (error) {
    const aborted = error?.name === 'AbortError'
    log(`${label}: upstream request failed:`, error?.message ?? String(error))
    return { ok: false, reason: aborted ? 'timeout' : 'network' }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Fetch OpenCode Go usage.
 * @returns `{ ok: true, usage, fetchedAt }` or `{ ok: false, reason, status? }`.
 */
export async function fetchUsage({ baseUrl, apiKey, fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS, log = () => {} }) {
  const res = await upstreamJson({
    url: `${baseUrl}/usage`,
    apiKey,
    fetchImpl,
    timeoutMs,
    log,
    label: 'model-usage/opencode-go',
  })
  if (!res.ok) return res
  const usage = normalizeUsage(res.body)
  if (usage === null) return { ok: false, reason: 'bad-payload' }
  return { ok: true, usage, fetchedAt: Date.now() }
}

/**
 * Fetch the DeepSeek account balance.
 * @returns `{ ok: true, balance, fetchedAt }` or `{ ok: false, reason, status? }`.
 */
export async function fetchBalance({ baseUrl, apiKey, fetchImpl = fetch, timeoutMs = REQUEST_TIMEOUT_MS, log = () => {} }) {
  const res = await upstreamJson({
    url: `${baseUrl}/user/balance`,
    apiKey,
    fetchImpl,
    timeoutMs,
    log,
    label: 'model-usage/deepseek',
  })
  if (!res.ok) return res
  const balance = normalizeBalance(res.body)
  if (balance === null) return { ok: false, reason: 'bad-payload' }
  return { ok: true, balance, fetchedAt: Date.now() }
}

/**
 * Fetch the OpenCode Go docs page and parse the per-model limits.
 * Public page — no API key, no credentials. Pure plumbing for apply().
 * @returns `{ ok: true, limits, fetchedAt }` or `{ ok: false, reason }`.
 */
export async function fetchDocsLimits({ url = DOCS_URL, fetchImpl = fetch, timeoutMs = LIMITS_FETCH_TIMEOUT_MS, log = () => {} } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, {
      headers: { accept: 'text/html', 'user-agent': 'dsh-model-usage/0.2.0' },
      signal: controller.signal,
    })
    if (!res.ok) {
      log('model-usage/limits: docs responded', res.status)
      return { ok: false, reason: res.status === 401 || res.status === 403 ? 'unauthorized' : 'upstream', status: res.status }
    }
    const html = await res.text()
    const parsed = parseDocsLimits(html)
    if (parsed === null) return { ok: false, reason: 'bad-payload' }
    return { ok: true, ...parsed }
  } catch (error) {
    const aborted = error?.name === 'AbortError'
    log('model-usage/limits: docs fetch failed:', error?.message ?? String(error))
    return { ok: false, reason: aborted ? 'timeout' : 'network' }
  } finally {
    clearTimeout(timer)
  }
}

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  // Usage / balance is per-user data; never let a shared cache hold it.
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

/** Per-section config with defaults, accepting the legacy flat shorthand. */
export function resolveSections(config = {}) {
  const legacy = {
    baseUrl: config.baseUrl,
    apiKeyRef: config.apiKeyRef,
    providers: config.providers,
  }
  const out = {}
  for (const [key, defaults] of Object.entries(SECTION_DEFAULTS)) {
    const configured = config[defaults.configKey]
    // The plugin used to be OpenCode-Go-only, so a flat top-level config is read
    // as that section; the deepseek section never inherits it.
    const raw = key === 'opencode-go' ? { ...legacy, ...(configured ?? {}) } : (configured ?? {})
    const providers = Array.isArray(raw.providers) && raw.providers.length > 0
      ? raw.providers.map((p) => String(p))
      : [...defaults.providers]
    out[key] = {
      baseUrl: typeof raw.baseUrl === 'string' && raw.baseUrl.length > 0
        ? raw.baseUrl.replace(/\/+$/u, '')
        : defaults.baseUrl,
      apiKeyRef: typeof raw.apiKeyRef === 'string' && raw.apiKeyRef.length > 0 ? raw.apiKeyRef : defaults.apiKeyRef,
      providers,
      tracked: new Set(providers),
    }
  }
  return out
}

export function apply(ctx, config = {}) {
  const sections = resolveSections(config)
  const enabled = config.enabled !== false

  if (!enabled) {
    ctx.logger?.info?.('[model-usage] disabled by configuration')
    return
  }

  // One upstream poll per section serves every page load inside the TTL window.
  const caches = new Map()

  const readSection = async (key) => {
    const section = sections[key]
    const now = Date.now()
    const cached = caches.get(key)
    if (cached !== undefined && cached.inflight === null) {
      const ttl = cached.value.ok ? CACHE_TTL_MS : FAILURE_TTL_MS
      if (now - cached.at < ttl) return cached.value
    }
    if (cached !== undefined && cached.inflight !== null) return cached.inflight

    const run = (async () => {
      let value
      try {
        const resolved = await ctx.credentials.resolve(section.apiKeyRef)
        const apiKey = resolved?.value
        if (typeof apiKey !== 'string' || apiKey.length === 0) {
          value = { ok: false, reason: 'no-key', apiKeyRef: section.apiKeyRef }
        } else {
          const log = (...a) => ctx.logger?.info?.(...a)
          value = key === 'deepseek'
            ? await fetchBalance({ baseUrl: section.baseUrl, apiKey, log })
            : await fetchUsage({ baseUrl: section.baseUrl, apiKey, log })
        }
      } catch (error) {
        ctx.logger?.warn?.('[model-usage] resolve failed for %s: %s', key, error?.message ?? String(error))
        value = { ok: false, reason: 'credentials-error' }
      } finally {
        const entry = caches.get(key)
        if (entry !== undefined) entry.inflight = null
      }
      caches.set(key, { at: Date.now(), value, inflight: null })
      return value
    })()

    caches.set(key, { at: now, value: cached?.value ?? { ok: false, reason: 'pending' }, inflight: run })
    return run
  }

  // Per-model monthly limits for opencode-go. Independent of the usage poll:
  // it has its own source (the public docs page), its own cache and its own
  // refresh schedule. `currentLimits` is always a valid map once bootstrapped
  // (built-in -> cache -> docs), so the widget always has something to show.
  const dshHome = (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0)
    ? process.env.DSH_HOME
    : process.cwd()
  let currentLimits = deriveLimits(BUILTIN_MODEL_LIMITS)
  let currentLimitsMeta = { source: 'builtin', updatedAt: null }

  const applyLimits = (limits, source, updatedAt) => {
    currentLimits = deriveLimits(limits)
    currentLimitsMeta = { source, updatedAt }
  }

  const refreshLimits = async () => {
    const log = (...a) => ctx.logger?.info?.(...a)
    const res = await fetchDocsLimits({ log })
    if (res.ok) {
      applyLimits(res.limits, 'docs', res.fetchedAt)
      await writeLimitsCache(dshHome, { limits: res.limits, fetchedAt: res.fetchedAt })
      ctx.logger?.info?.('[model-usage] limits refreshed from docs (%d models, %s)', Object.keys(res.limits).length, res.fetchedAt)
    } else {
      ctx.logger?.warn?.(
        '[model-usage] limits refresh failed (%s); keeping %s table',
        res.reason,
        currentLimitsMeta?.source ?? 'built-in',
      )
    }
  }

  const bootstrapLimits = async () => {
    const cached = await readLimitsCache(dshHome)
    if (cached !== null && typeof cached.fetchedAt === 'string') {
      applyLimits(cached.limits, 'cache', cached.fetchedAt)
      const ageMs = Date.now() - new Date(cached.fetchedAt).getTime()
      if (Number.isFinite(ageMs) && ageMs < LIMITS_REFRESH_MS) return // fresh enough
    }
    // Stale/no cache: show what we have now, refresh in the background.
    await refreshLimits()
  }

  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: ROUTE_PATH,
      handler: async (req, res) => {
        try {
          if (req.method !== 'GET') {
            res.setHeader('allow', 'GET')
            return sendJson(res, 405, { ok: false, error: 'method not allowed' })
          }
          const keys = Object.keys(sections)
          const results = await Promise.all(keys.map((key) => readSection(key)))
          // Each section reports its own outcome, so a missing OpenCode Go key
          // never hides the DeepSeek balance (and vice versa).
          const payloadSections = {}
          for (const key of keys) {
            payloadSections[key] = {
              providers: sections[key].providers,
              keyRef: sections[key].apiKeyRef,
            }
          }
          const out = { ok: true, sections: payloadSections }
          keys.forEach((key, index) => {
            const value = results[index]
            out[key] = value.ok === true
              ? {
                  ok: true,
                  usage: value.usage,
                  balance: value.balance,
                  fetchedAt: value.fetchedAt,
                }
              : { ok: false, reason: value.reason }
          })
          // Per-model monthly caps for opencode-go (informational; the usage
          // percentages are account-wide). Only expose the SELECTED model's
          // entry to the page via the client's lookup; the map is small anyway.
          out.limits = currentLimits
          out.limitsMeta = currentLimitsMeta
          // Never leak a key or an upstream body verbatim — only our shape.
          return sendJson(res, 200, out)
        } catch (error) {
          ctx.logger?.warn?.('[model-usage] request failed: %s', error?.message ?? String(error))
          return sendJson(res, 500, { ok: false, error: 'internal error' })
        }
      },
    })
    // Background bootstrap + a periodic docs re-fetch.
    void bootstrapLimits()
    const interval = setInterval(() => void refreshLimits(), LIMITS_REFRESH_MS)
    ctx.logger?.info?.(
      '[model-usage] active (%s)',
      Object.entries(sections)
        .map(([key, s]) => `${key}: providers=${s.providers.join('|')} key=${s.apiKeyRef}`)
        .join('; '),
    )
    return () => {
      clearInterval(interval)
      if (typeof dispose === 'function') dispose()
    }
  }, 'model-usage.route')
}

export default { name, inject, apply }
