// dsh-opencode-go
//
// One plugin for the OpenCode / OpenCode Go routes, three jobs:
//
//   1. DECLARE THE ROUTE PROTOCOL (cordis.patch.yml): the engine's `llm-pi-ai`
//      row is patched with providers.opencode-go.api = openai-completions. The
//      adapter resolves each route's models with
//        api = route.api ?? catalogModel.api ?? sharedCatalogApi(route)
//      opencode-go's catalog spans anthropic-messages / openai-completions /
//      openai-responses, so the shared fallback is undefined; catalog-unknown
//      models therefore need the route-level `api`.
//
//   2. AUTO-ADD THE DEEPSEEK V4.1 MODELS (this file, settings half): once the
//      `llm-pi-ai` settings namespace is registered, checks whether the user's
//      model list carries an opencode-go route; if it does and no
//      `deepseek-v4.1-*` model is listed yet, appends the known DeepSeek V4.1
//      models via settings.update (the same write path the Models page uses, so
//      the change lands in settings.yaml and re-runs the engine's strict
//      validation — which passes because `api` is present on the base layer).
//
//   3. ATTACH `x-opencode-session` (this file, header half): OpenCode's relay
//      pins every request sharing the same `x-opencode-session` value to the
//      same upstream backend, keeping its prompt cache warm across the turns of
//      one conversation. Fixes 400 MissingSessionID. The value only has to be
//      opaque and stable per conversation, so the DEFAULT derives a random UUID
//      per DSH session and never sends the internal DSH session id to third
//      parties (`mode: 'session-id'` is strictly opt-in).
//
// The two runtime halves are independent: the header half activates as soon as
// the `llm` service exists, the settings half only once `settings` does — a
// profile without settings still gets the header fix.

import { AsyncLocalStorage } from 'node:async_hooks'
import { createHash, randomUUID } from 'node:crypto'
import { appendFile } from 'node:fs/promises'
import { isAbsolute, resolve, sep } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

export const name = 'opencode-go'

// Activate only after the abstract `llm` service exists, so the waterfall
// event the header half listens on is already registered by its provider.
// `settings` is injected lazily below (see apply), because the header half must
// not depend on a profile that mounts a settings provider.
export const inject = ['llm']

// ---------------------------------------------------------------------------
// x-opencode-session header half
// ---------------------------------------------------------------------------

const SESSION_HEADER = 'x-opencode-session'
const HEADER_VALUE_RE = /^[\x21-\x7e\x80-\u10ffff]+$/u
const UUID_TABLE_MAX = 4096

// Provider routes OpenCode(Go) requests are served under.
const DEFAULT_PROVIDERS = ['opencode', 'opencode-go']

function resolveConfig(config = {}) {
  const providers = Array.isArray(config.providers) && config.providers.length > 0
    ? config.providers.map((value) => String(value))
    : [...DEFAULT_PROVIDERS]
  // Security: default is 'uuid' so the internal DSH session id is never sent
  // to third parties. 'session-id' is opt-in only.
  const mode = config.mode === 'session-id' ? 'session-id' : 'uuid'
  const debug = config.debug === true
  const debugFile = resolveSafeDebugFile(config.debugFile)
  return { providers: new Set(providers), mode, debug, debugFile }
}

/**
 * Resolve an optional debugFile under a constrained allow-list of directories.
 * Only a path inside `$DSH_HOME/logs` (preferred) or inside the OS temp dir is
 * accepted; anything else fails closed to `undefined` rather than writing to an
 * arbitrary location. A relative path is anchored to `$DSH_HOME/logs`.
 */
function resolveSafeDebugFile(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined
  const home = (typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0)
    ? process.env.DSH_HOME
    : process.cwd()
  const homeLogs = resolve(home, 'logs')
  const tempRoot = resolve(tempDir())
  let absolute
  try {
    if (isAbsolute(value)) {
      absolute = resolve(value)
    } else {
      // Relative spec is anchored to the approved home logs dir.
      absolute = resolve(homeLogs, value)
    }
  } catch {
    return undefined
  }
  for (const root of [homeLogs, tempRoot]) {
    try {
      if (absolute === root || absolute.startsWith(root + sep)) {
        return { file: absolute, root }
      }
    } catch {
      // path comparison failed; fall through
    }
  }
  return undefined
}

function tempDir() {
  return process.env.TMPDIR ?? process.env.TMP ?? process.env.TEMP ?? '/tmp'
}

/** One-way hash of a session id used ONLY for debug logging (never sent). */
export function redactSessionId(sessionId) {
  return createHash('sha256').update(String(sessionId)).digest('hex').slice(0, 16)
}

/** True when a value is a safe HTTP header value candidate. */
function safeHeaderValue(value) {
  const raw = String(value)
  return raw.length > 0 && HEADER_VALUE_RE.test(raw)
}

/** Derive the opaque header value for one DSH session id. */
export function headerValueFor(sessionId, mode, table) {
  if (typeof sessionId !== 'string' && typeof sessionId !== 'number') return undefined
  const raw = String(sessionId)
  if (raw.length === 0) return undefined
  if (!safeHeaderValue(raw)) return undefined
  if (mode !== 'session-id') {
    // uuid mode: never expose the internal id; emit a random opaque uuid.
    let value = table.get(raw)
    if (value === undefined) {
      value = randomUUID()
      if (table.size >= UUID_TABLE_MAX) {
        // Drop the oldest entry to keep the map bounded.
        const oldest = table.keys().next().value
        if (oldest !== undefined) table.delete(oldest)
      }
      table.set(raw, value)
    }
    return value
  }
  // Explicit session-id mode: still require a safe header value.
  return raw
}

/**
 * Wrap a downstream async iterable so every pull executes inside an
 * AsyncLocalStorage store. Async generators and the promises they create
 * inherit the store as long as the generator body is driven from a pull made
 * inside `als.run`, which is exactly what this wrapper does per `next()`.
 */
export function withStore(iterable, store, als) {
  const iterator = typeof iterable[Symbol.asyncIterator] === 'function'
    ? iterable[Symbol.asyncIterator]()
    : iterable
  return {
    [Symbol.asyncIterator]() {
      return this
    },
    async next() {
      return als.run(store, () => iterator.next())
    },
    async return(value) {
      if (typeof iterator.return === 'function') {
        try {
          return await iterator.return(value)
        } catch {
          // The downstream stream may already be torn down; treat as done.
        }
      }
      return { done: true, value }
    },
    async throw(error) {
      if (typeof iterator.throw === 'function') {
        return als.run(store, () => iterator.throw(error))
      }
      throw error
    },
  }
}

/** True when the outgoing request already carries the session header. */
function hasSessionHeader(input, init) {
  const source = init?.headers
    ?? (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined)
  if (source === undefined) return false
  try {
    return new Headers(source).has(SESSION_HEADER)
  } catch {
    return false
  }
}

/**
 * Build a patched fetch that injects the header while a store is active —
 * and only then. Header precedence mirrors native fetch: when `init.headers`
 * is present it wins; otherwise a Request's own headers are the base.
 */
export function patchFetch(original, als) {
  return function patchedFetch(input, init) {
    const state = als.getStore()
    if (state && !hasSessionHeader(input, init)) {
      const headers = new Headers(
        init?.headers
          ?? (typeof Request !== 'undefined' && input instanceof Request ? input.headers : undefined),
      )
      headers.set(SESSION_HEADER, state.value)
      return original.call(this, input, { ...init, headers })
    }
    return original.apply(this, arguments)
  }
}

/** Fire-and-forget append of one debug record; failures only log a warning. */
function recordDebug(ctx, file, entry) {
  appendFile(file, `${JSON.stringify(entry)}\n`, 'utf8').catch((error) => {
    ctx.logger.warn('[opencode-go] debugFile write failed: %s', error?.message ?? String(error))
  })
}

function installSessionHeader(ctx, config) {
  const { providers, mode, debug, debugFile } = resolveConfig(config)
  const als = new AsyncLocalStorage()
  const uuidBySession = new Map()

  const originalFetch = globalThis.fetch
  if (typeof originalFetch !== 'function') {
    ctx.logger.warn('[opencode-go] globalThis.fetch is unavailable; cannot inject x-opencode-session')
    return
  }

  const patched = patchFetch(originalFetch, als)

  ctx.effect(() => {
    globalThis.fetch = patched
    ctx.logger.info(
      '[opencode-go] active for providers [%s] with mode %s (debug=%s)',
      [...providers].join(', '),
      mode,
      debug ? 'on' : 'off',
    )
    return () => {
      // Restore only if we are still the active patch — never clobber a patch
      // installed later by a concurrently-loaded plugin.
      if (globalThis.fetch === patched) globalThis.fetch = originalFetch
    }
  }, 'opencode-go.fetch-patch')

  ctx.on('llm/stream', (options, next) => {
    if (options === undefined || options === null || typeof options !== 'object') return next()
    if (!providers.has(String(options.provider))) return next()
    const sessionId = options.sessionId
    if (sessionId === undefined || sessionId === null) return next()
    const value = headerValueFor(sessionId, mode, uuidBySession)
    if (value === undefined) return next()

    // Reaching the adapter is the only way the actual HTTP request happens;
    // `next()` returns the downstream (lazy) stream. Call it exactly once,
    // then drive its iterator from inside the store.
    let downstream
    try {
      downstream = next()
    } catch (error) {
      // Let the caller handle an adapter dispatch failure as it normally would.
      throw error
    }
    if (downstream === undefined || downstream === null) return downstream
    if (typeof downstream[Symbol.asyncIterator] !== 'function') return downstream

    if (debug || debugFile !== undefined) {
      const entry = {
        ts: new Date().toISOString(),
        provider: options.provider,
        model: options.model,
        mode,
        session: redactSessionId(sessionId),
        header: SESSION_HEADER,
        value,
      }
      if (debugFile !== undefined) {
        recordDebug(ctx, debugFile.file, entry)
      }
      if (debug) {
        ctx.logger.info(
          '[opencode-go] streaming provider "%s" mode=%s with %s=%s',
          options.provider,
          mode,
          SESSION_HEADER,
          value,
        )
      }
    }
    return withStore(downstream, { value }, als)
  }, { prepend: true })
}

// ---------------------------------------------------------------------------
// DeepSeek V4.1 auto-add half
// ---------------------------------------------------------------------------

const NS = 'llm-pi-ai'
const PROVIDER = 'opencode-go'

// DeepSeek V4.1* models OpenCode Go serves (probed upstream: 37 models, one
// v4.1 today). Extend this list when upstream adds more.
export const V4_1_MODELS = [
  {
    id: 'deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash',
    contextWindow: 1000000,
    maxTokens: 384000,
  },
]

// The `llm-pi-ai` namespace is registered by the engine adapter itself; wait
// for it (it appears moments after boot) before touching settings.
const NS_WAIT_TIMEOUT_MS = 10000
const NS_WAIT_STEP_MS = 100

/** True when the given model id looks like a DeepSeek V4.1 model. */
export function isV41(id) {
  return typeof id === 'string' && id.startsWith('deepseek-v4.1')
}

/**
 * The next models array with the DeepSeek V4.1 models appended.
 * @returns {Array|null} null when a v4.1 model is already listed (nothing to do).
 */
export function appendV41Models(existing) {
  const models = Array.isArray(existing) ? existing : []
  if (models.some((m) => isV41(m?.id))) return null
  return [...models, ...V4_1_MODELS.map((m) => ({ ...m }))]
}

async function waitForNamespace(settings) {
  const deadline = Date.now() + NS_WAIT_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      const desc = settings.describe?.()
      if (Array.isArray(desc) && desc.some((d) => d.ns === NS)) return true
    } catch {
      // not yet readable; keep polling
    }
    await sleep(NS_WAIT_STEP_MS)
  }
  return false
}

/**
 * Ensure the opencode-go route lists the DeepSeek V4.1 models. No-ops when the
 * route is absent (only touch it when opencode-go exists) or when a v4.1 model
 * is already listed.
 */
async function ensureV41Models(ctx, settings) {
  let resolved
  try {
    resolved = settings.get(NS)
  } catch {
    return
  }
  const profile = resolved?.providers?.[PROVIDER]
  if (!profile) return // no opencode-go route configured

  let userSection
  try {
    userSection = settings.section(NS)
  } catch {
    userSection = undefined
  }
  const next = appendV41Models(userSection?.providers?.[PROVIDER]?.models)
  if (next === null) return // already has a DeepSeek V4.1

  ctx.logger.info('[opencode-go] route exists; adding DeepSeek V4.1 models: %s', V4_1_MODELS.map((m) => m.id).join(', '))
  await settings.update(NS, { providers: { [PROVIDER]: { models: next } } })
}

function installAutoModels(ctx) {
  const settings = ctx.settings
  let ensureChain = Promise.resolve()

  const ensure = () => {
    ensureChain = ensureChain
      .then(() => ensureV41Models(ctx, settings))
      .catch((error) => {
        ctx.logger?.warn('[opencode-go] auto-add failed: %s', error?.message ?? String(error))
      })
  }

  ctx.effect(() => {
    const started = (async () => {
      const ready = await waitForNamespace(settings)
      if (!ready) {
        ctx.logger?.warn('[opencode-go] llm-pi-ai settings namespace not seen within %dms; skipping auto-add', NS_WAIT_TIMEOUT_MS)
        return
      }
      ensure()
    })()

    // Re-run whenever the user edits the llm-pi-ai settings (Models page or
    // file). Idempotent: once a v4.1 model is present, later calls no-op.
    const off = ctx.on('settings/document-updated', (ns) => {
      if (ns === NS) ensure()
    })

    return async () => {
      off()
      await started
      await ensureChain
    }
  }, 'opencode-go.ensure-models')
}

export function apply(ctx, config) {
  installSessionHeader(ctx, config)
  // Lazy: keeps the header half working in profiles that mount no settings
  // provider (and whose `ctx.settings` would never resolve).
  ctx.inject(['settings'], (settingsCtx) => installAutoModels(settingsCtx))
}

export default { name, inject, apply }