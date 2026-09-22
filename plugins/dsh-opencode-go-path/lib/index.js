// dsh-opencode-go-path
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
    if (state && !hasSessionHeader(input, init) && targetsOpenCode(input, state.hosts)) {
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

/**
 * 只往 OpenCode 自己的主机上加头。
 *
 * 补丁按 AsyncLocalStorage 窗口生效，窗口里任何 fetch 都会命中 —— 包括提供商内部发出、
 * 或 MCP/SDK 等调用链上的**跨主机**请求。那既不必要（对方不认这个头，还会把简单请求变成
 * 需要预检的跨域请求）又有泄露风险（`session-id` 模式下的值就是内部会话 id）。
 * 拿不到主机信息时保持旧行为，避免把功能关掉。
 */
function openCodeHosts(options) {
  const hosts = new Set()
  const candidates = [options?.baseUrl, options?.provider?.baseUrl, options?.provider?.options?.baseURL]
  for (const value of candidates) {
    if (typeof value !== 'string' || value === '') continue
    try {
      hosts.add(new URL(value).host)
    } catch {
      /* 不是绝对 URL 就忽略 */
    }
  }
  return [...hosts]
}

function targetsOpenCode(input, hosts) {
  if (!Array.isArray(hosts) || hosts.length === 0) return true
  try {
    const raw = typeof input === 'string' ? input : input?.url
    if (typeof raw !== 'string') return true
    return hosts.includes(new URL(raw).host)
  } catch {
    return true
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
      // `value` 也要脱敏：在 session-id 模式下它就是**原始** DSH 会话 id，直接落盘/打日志
      // 会推翻 cordis.patch.yml 与 README 里「never the raw DSH session id」的承诺。
      const logged = mode === 'session-id' ? redactSessionId(sessionId) : value
      const entry = {
        ts: new Date().toISOString(),
        provider: options.provider,
        model: options.model,
        mode,
        session: redactSessionId(sessionId),
        header: SESSION_HEADER,
        value: logged,
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
          logged,
        )
      }
    }
    // hosts 让 fetch 补丁只作用于 OpenCode 自己的主机（见 targetsOpenCode）。
    return withStore(downstream, { value, hosts: openCodeHosts(options) }, als)
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

/**
 * Decide what to write for the route's `models`, from the **user's own** layer.
 *
 * The engine treats a non-empty configured `models` list as the complete set for
 * that provider (`entries = configured.length > 0 ? configured : defaults`), so a
 * list written where the user had none REPLACES the provider's built-in catalog
 * with exactly what we send — appending to an empty list would leave the model
 * picker showing a single model. Therefore: only extend a list the user already
 * configured; when they have not, the engine's catalog stays authoritative and we
 * write nothing.
 *
 * The merged (`resolved`) settings cannot drive this decision: this plugin's own
 * cordis patch injects `providers.opencode-go.api`, so the merged layer always has
 * the route and a "route exists" guard would never fire.
 *
 * @param userProfile - `settings.section(NS).providers['opencode-go']`, or undefined.
 * @returns {Array|null} the models array to write, or null when nothing should be written.
 */
export function nextV41Models(userProfile) {
  if (userProfile === null || typeof userProfile !== 'object') return null
  const models = userProfile.models
  if (!Array.isArray(models) || models.length === 0) return null
  return appendV41Models(models)
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
    if (typeof settings.section !== 'function') {
      // 引擎的 settings provider 没实现 section()（它在类型里是 private）时，自动补模型会
      // 变成静默失效 —— 正是本仓库别处批评过的那种「什么都没发生也没有日志」。
      ctx.logger?.warn('[opencode-go] settings.section() is unavailable; skipping the V4.1 auto-add')
      return
    }
    userSection = settings.section(NS)
  } catch (error) {
    ctx.logger?.warn('[opencode-go] reading the user settings section failed: %s', error?.message ?? String(error))
    userSection = undefined
  }
  // 只扩展用户自己配置过的 models 列表 —— 详见 nextV41Models 的说明（空列表写入会
  // 用我们这份列表整体替换引擎目录，导致模型选择器只剩一个模型）。
  const next = nextV41Models(userSection?.providers?.[PROVIDER])
  if (next === null) return // not user-configured, or a DeepSeek V4.1 is already listed

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