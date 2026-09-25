// dsh-gateway-models
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
//   2. DETECT THE ROUTE'S MODELS, ADD THE DEEPSEEK V4.1 MODELS, PUT THEM FIRST
//      (this file, settings half): once the `llm-pi-ai` settings namespace is
//      registered, the route's models are DETECTED from the engine itself
//      (`llm.discoverModels`, which answers the installed pi-ai catalog for a
//      catalog route without any network call), and the DeepSeek V4.1 models are
//      placed at the FRONT of the route's `models` list via settings.update (the
//      same write path the Models page uses, so the change lands in
//      settings.yaml and re-runs the engine's strict validation). When the user
//      configured no list, the detected catalog SEEDS one — a non-empty list
//      replaces the served catalog, so writing our models alone would leave the
//      picker showing a single model. The route's `baseURL` is declared too when
//      a listed model is not in the installed catalog, because that is the only
//      way such a model resolves an endpoint (the engine refuses it otherwise).
//      Position matters: the list order is the model picker's order and the
//      picker preselects the first entry, so "out of the box" means V4.1 Flash is
//      the default.
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
// HTTP 头值只能是 ByteString（≤ 0xFF）：`Headers.set` 遇到码点 > 0xFF 会抛 TypeError。
// 早先这里放行到 \u10ffff，于是「看起来安全」的中文/emoji 会话 id 会让一次本该正常发出
// 的模型请求直接以 TypeError 失败。收紧到可见 ASCII —— 而这个头本来就只要求不透明。
const HEADER_VALUE_RE = /^[\x21-\x7e]+$/u
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
    ctx.logger.warn('[gateway-models] debugFile write failed: %s', error?.message ?? String(error))
  })
}

function installSessionHeader(ctx, config) {
  const { providers, mode, debug, debugFile } = resolveConfig(config)
  const als = new AsyncLocalStorage()
  const uuidBySession = new Map()

  const originalFetch = globalThis.fetch
  if (typeof originalFetch !== 'function') {
    ctx.logger.warn('[gateway-models] globalThis.fetch is unavailable; cannot inject x-opencode-session')
    return
  }

  const patched = patchFetch(originalFetch, als)

  ctx.effect(() => {
    globalThis.fetch = patched
    ctx.logger.info(
      '[gateway-models] active for providers [%s] with mode %s (debug=%s)',
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
          '[gateway-models] streaming provider "%s" mode=%s with %s=%s',
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

// OpenCode Go's OpenAI-compatible endpoint — the one the route's declared `api`
// speaks.
//
// The installed pi-ai catalog gives every model IT describes its own `baseUrl`
// (…/zen/go for the anthropic-messages ones, …/zen/go/v1 for the OpenAI-shaped
// ones), so a catalog route normally needs no route-level endpoint. A model the
// catalog does NOT describe is different: the engine resolves its endpoint as
// `route.baseURL ?? catalogModel.baseUrl ?? providerBaseUrl`, and the opencode-go
// catalog provider carries no provider-level baseUrl — so `deepseek-v4.1-flash`
// has nowhere to point and the engine refuses both to serve it and to store it
// (`model "…" needs a baseURL`). Declaring this on the route is what admits such
// a model, and since the patch in cordis.patch.yml already points the whole
// route at `openai-completions`, this is the endpoint that protocol speaks.
const DEFAULT_BASE_URL = 'https://opencode.ai/zen/go/v1'

// DeepSeek V4.1* models OpenCode Go serves (probed upstream: 37 models, one
// v4.1 today). Extend this list when upstream adds more.
//
// Every field here exists because the installed catalog does NOT describe these
// models, so nothing else can supply it:
//
//   * contextWindow / maxTokens — the engine falls back to the catalog entry's
//     values, and there is none.
//   * compat — the DeepSeek wire quirks the endpoint needs. pi-ai auto-detects
//     them from the provider name or host (`isDeepSeek = provider === "deepseek"
//     || baseUrl includes "deepseek.com"`), and the OpenCode Go relay is neither:
//     it is `provider: "opencode-go"` at `opencode.ai`. Without the explicit
//     block, `requiresReasoningContentOnAssistantMessages` stays false and the
//     replayed assistant turns omit `reasoning_content` — DeepSeek then answers
//     400 "The `reasoning_content` in the thinking mode must be passed back to
//     the API", and every multi-turn conversation on the model fails. The values
//     below are exactly what the installed catalog declares for its own
//     opencode-go DeepSeek entries (deepseek-v4-flash / -vision-exp / -pro).
//   * reasoningEfforts — the model IS a thinking model, and the compat fallback
//     above is gated on `model.reasoning`. Without a catalog entry the engine
//     would resolve it as non-reasoning, so pi-ai would neither request thinking
//     nor pad `reasoning_content`. The levels mirror the same catalog entries:
//     `low` / `high` / `max`, plus `off` (declared with no wire value, which is
//     how "supported, send nothing" is spelled).
export const V4_1_MODELS = [
  {
    id: 'deepseek-v4.1-flash',
    name: 'DeepSeek V4.1 Flash',
    contextWindow: 1000000,
    maxTokens: 384000,
    reasoningEfforts: { off: null, low: 'low', high: 'high', max: 'max' },
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      maxTokensField: 'max_tokens',
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: 'deepseek',
    },
  },
]

// The `llm-pi-ai` namespace is registered by the engine adapter itself; wait
// for it (it appears moments after boot) before touching settings.
const NS_WAIT_TIMEOUT_MS = 10000
const NS_WAIT_STEP_MS = 100

/**
 * True when the given model id looks like a DeepSeek V4.1 model (family prefix).
 * The auto-add half keys off the EXACT ids in V4_1_MODELS instead: a future
 * upstream `deepseek-v4.1-*` must not stop us from listing the ones we know.
 */
export function isV41(id) {
  return typeof id === 'string' && id.startsWith('deepseek-v4.1')
}

/**
 * One of our model entries, with every field the USER already set kept as-is and
 * the fields only we can know filled in.
 *
 * These are not cosmetic defaults: `compat` and `reasoningEfforts` are the wire
 * facts the installed catalog would have supplied for a model it describes (see
 * V4_1_MODELS). An entry written by an earlier version of this plugin — or by the
 * GUI model page, or by hand — carries neither, and on this route that costs a
 * 400 on every multi-turn conversation. So the missing fields are ADDED, while
 * anything the user decided (name, limits, their own compat switches, an
 * explicit `reasoningEfforts: false`) is never overwritten.
 *
 * @param entry - the stored entry for one of our ids, or undefined.
 * @param def - our definition for that id.
 * @returns the entry to write.
 */
export function withV41Defaults(entry, def) {
  if (entry === null || typeof entry !== 'object') return { ...def }
  const merged = { ...def, ...entry }
  // Nested blocks merge field by field, ours underneath the user's.
  if (def.compat !== undefined || entry.compat !== undefined) {
    merged.compat = { ...def.compat, ...entry.compat }
  }
  // `reasoningEfforts` is a whole decision (a dict, or `false` for a
  // non-reasoning model), so an entry that states one keeps it untouched.
  if (entry.reasoningEfforts === undefined) merged.reasoningEfforts = def.reasoningEfforts
  return merged
}

/**
 * The next models array, with this plugin's DeepSeek V4.1 models FIRST and
 * everything the user configured kept in its own relative order.
 *
 * Why first — and why this is not only about adding: the list order is the model
 * picker's order, and the picker preselects the first entry. An earlier version
 * of this plugin *appended* the models, so anyone who already has a v4.1 entry
 * carries it at the END; leaving it there would make the plugin's own promise
 * ("works out of the box") depend on the user dragging it up by hand. Moving it
 * is part of the job, and it is idempotent: once the models sit at the front (and
 * carry the fields we maintain), this returns null.
 *
 * An entry the user already has for one of our ids is kept, and completed by
 * `withV41Defaults` — never replaced.
 *
 * @param {Array} existing
 * @returns {Array|null} the models array to write, or null when the list already
 *   has exactly the shape this plugin maintains — so callers can skip the write,
 *   which is also what stops the settings-updated event from looping.
 */
export function withV41ModelsFirst(existing) {
  const models = Array.isArray(existing) ? existing : []
  const ours = V4_1_MODELS.map((def) => withV41Defaults(models.find((m) => m?.id === def.id), def))
  const rest = models.filter((m) => !V4_1_MODELS.some((def) => def.id === m?.id))
  const next = [...ours, ...rest]
  return JSON.stringify(next) === JSON.stringify(models) ? null : next
}

/**
 * The patch to write for the `opencode-go` route, or null when the stored route
 * already has the shape this plugin maintains.
 *
 * Three decisions live here:
 *
 * 1. WHICH MODELS. The engine treats a non-empty configured `models` list as the
 *    provider's COMPLETE model set (`entries = configured.length > 0 ? configured
 *    : defaults`). So a user list is extended (`withV41ModelsFirst`), while a
 *    route the user configured NO list for is seeded from the DETECTED catalog
 *    (`catalog`) — writing our models into an empty list would otherwise replace
 *    the whole served catalog with a single entry. Detection is what makes the
 *    "no list configured" case work at all instead of silently doing nothing.
 *
 * 2. WHETHER THE ROUTE NEEDS `baseURL`. A model the installed catalog does not
 *    describe resolves its endpoint from the route (see DEFAULT_BASE_URL), so the
 *    route must carry one whenever such a model is listed — including when the
 *    list already has the right ORDER but the endpoint is still missing, which is
 *    the state a hand-edited settings.yaml can be in.
 *
 * 3. WHETHER ANYTHING CHANGED. Both fields are compared against what is actually
 *    stored, so the write is skipped once the route is in shape — which is also
 *    what stops the `settings/document-updated` event from looping.
 *
 * An entry the user already has for one of our ids is reused verbatim (they may
 * have tuned its name or limits) and is never overwritten with our default.
 *
 * @param userProfile - the route exactly as the USER configured it
 *   (`settings.section(NS).providers[PROVIDER]`), or undefined.
 * @param resolvedRoute - the route as the engine resolves it (base + user layers).
 * @param catalog - the models the installed catalog describes for the route, as
 *   `llm.discoverModels()` reports them.
 * @returns {{models?: Array, baseURL?: string}|null} the patch to write.
 */
export function planRouteUpdate(userProfile, resolvedRoute, catalog) {
  // Detection is the precondition for deciding anything: without it a route the
  // user configured no list for cannot be described, and the caller skips too.
  if (!Array.isArray(catalog)) return null
  const detected = catalog.filter((model) => typeof model?.id === 'string' && model.id.length > 0)
  const catalogIds = new Set(detected.map((model) => model.id))
  const stored = Array.isArray(userProfile?.models) ? userProfile.models : undefined
  const userConfigured = stored !== undefined && stored.length > 0

  // 1. the list the route should end up with: the user's own when they configured
  //    one, otherwise the detected catalog (so the served catalog survives the
  //    write), each with our models in front. `merged === null` means it already
  //    has that shape, so there is nothing to write for it.
  const listed = userConfigured ? stored : detected.map((model) => (
    // Only id + name: the remaining fields (limits, modalities, api) stay the
    // catalog's, so a later catalog update still reaches this entry.
    typeof model.name === 'string' && model.name.length > 0
      ? { id: model.id, name: model.name }
      : { id: model.id }
  ))
  const merged = withV41ModelsFirst(listed)
  const models = merged ?? listed

  const patch = {}
  // A list is written only when it needed changing — never merely to restate a
  // list the user layer (or the catalog) already has, which is what keeps a
  // catalog-authoritative route authoritative.
  if (merged !== null) patch.models = models
  // 2. an endpoint is required exactly when a listed model is not in the catalog.
  if ((resolvedRoute?.baseURL ?? '') === '' && models.some((model) => !catalogIds.has(model?.id))) {
    patch.baseURL = DEFAULT_BASE_URL
  }
  // 3. nothing to change -> no write, no event, no loop.
  return Object.keys(patch).length > 0 ? patch : null
}

/**
 * Detect the models the installed engine catalog describes for the route.
 *
 * `llm.discoverModels` is the engine's own provider-endpoint interrogation. For a
 * route pi-ai ships a catalog for it answers that catalog directly; passing no
 * `baseURL` and no credential is deliberate, because the fallback path (a route
 * with no catalog) then fails before reaching the network — a catalog-less route
 * is one this plugin cannot describe anyway, and the plugin makes no outbound
 * requests.
 *
 * @returns {Promise<Array|undefined>} the detected models, or undefined when
 *   detection is unavailable — in which case the caller must NOT guess a list.
 */
async function detectCatalogModels(ctx) {
  const llm = ctx.llm
  if (typeof llm?.discoverModels !== 'function') {
    ctx.logger?.warn('[gateway-models] llm.discoverModels() is unavailable; skipping the V4.1 auto-add')
    return undefined
  }
  try {
    const models = await llm.discoverModels(NS, { provider: PROVIDER })
    if (!Array.isArray(models)) return undefined
    return models.filter((model) => typeof model?.id === 'string' && model.id.length > 0)
  } catch (error) {
    ctx.logger?.warn(
      '[gateway-models] could not detect the "%s" model catalog: %s',
      PROVIDER,
      error?.message ?? String(error),
    )
    return undefined
  }
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
 * Ensure the opencode-go route carries the DeepSeek V4.1 models FIRST. No-ops
 * when the route is absent (only touch it when opencode-go exists), when its
 * catalog cannot be detected, or when the route already has the shape this
 * plugin maintains.
 */
async function ensureV41Models(ctx, settings) {
  const catalog = await detectCatalogModels(ctx)
  if (catalog === undefined) return

  let resolved
  try {
    resolved = settings.get(NS)
  } catch {
    return
  }
  const route = resolved?.providers?.[PROVIDER]
  if (!route) return // no opencode-go route configured

  let userSection
  try {
    if (typeof settings.section !== 'function') {
      // 引擎的 settings provider 没实现 section()（它在类型里是 private）时，自动补模型会
      // 变成静默失效 —— 正是本仓库别处批评过的那种「什么都没发生也没有日志」。
      ctx.logger?.warn('[gateway-models] settings.section() is unavailable; skipping the V4.1 auto-add')
      return
    }
    userSection = settings.section(NS)
  } catch (error) {
    ctx.logger?.warn('[gateway-models] reading the user settings section failed: %s', error?.message ?? String(error))
    userSection = undefined
  }

  const patch = planRouteUpdate(userSection?.providers?.[PROVIDER], route, catalog)
  if (patch === null) return // already in the shape we maintain

  ctx.logger.info(
    '[gateway-models] detected %d "%s" model(s); putting %s first%s',
    catalog.length,
    PROVIDER,
    V4_1_MODELS.map((m) => m.id).join(', '),
    patch.baseURL === undefined ? '' : ` and declaring baseURL ${patch.baseURL}`,
  )
  await settings.update(NS, { providers: { [PROVIDER]: patch } })
}

// ---------------------------------------------------------------------------
// Command Code route provisioning
//
// Command Code is not in the installed pi-ai catalog (40 providers ship, none
// is CommandCode), so NOTHING about its models can be inferred: every entry
// needs a route-level `api` and `baseURL`, and the model ids themselves have to
// come from somewhere. That is why adding one by hand meant typing the API
// address every time.
//
// Both halves are fixed here:
//
//   1. cordis.patch.yml declares `api` + `baseURL` for the route, so the address
//      is always present in the merged layer. The engine resolves an entry's
//      endpoint as `route.baseURL ?? catalogModel.baseUrl ?? providerBaseUrl`
//      and the model page probes with `draft.baseURL ?? fallback.baseURL`, so a
//      route-level endpoint means the user never types it.
//
//   2. this half fills the model list from the provider's OWN public catalog:
//      GET https://api.commandcode.ai/provider/v1/models
//      It answers 200 with no credential (`{data:[{id,name,context_length,…}]}`),
//      which is exactly what a settings entry needs. This is the plugin's ONLY
//      outbound request, and it carries no key.
//
// Ordering: the catalog order is kept as-is (Claude / GPT / DeepSeek / …), and
// entries the user already has are never rewritten. Missing ones are APPENDED,
// so a user's own ordering survives.
// ---------------------------------------------------------------------------

/**
 * The route key cordis.patch.yml declares: `commandcode`.
 *
 * Deliberately NOT plan-specific. Command Code serves EVERY plan (Go / GOAT /
 * Pro / MAX) from the same host and the same API, and the plan lives on the
 * ACCOUNT behind the API key — so a name like `commandcode-goat` would claim a
 * tier the route does not determine. One name covers them all; switching plans
 * is a key swap, never a config change.
 *
 * It is also only a DEFAULT. The route id is a label the user picks, so a route
 * named `commandcode-pro`, a legacy `commandcode-goat`, or the community
 * provider's id are all handled: `commandCodeRouteIds()` recognises routes by
 * their ENDPOINT (see CC_HOST), and this name exists solely to name the route
 * the shipped patch declares.
 *
 * Exported so a test can assert cordis.patch.yml actually declares it — the
 * runtime never depends on the name, so nothing else would notice them drifting
 * apart (a rename in one place and not the other would silently cost every user
 * the built-in endpoint).
 */
export const CC_PROVIDER = 'commandcode'
/** Chat endpoint — the same value cordis.patch.yml declares for the route. */
const CC_BASE_URL = 'https://api.commandcode.ai/provider/v1'
/** Public model catalog (no credential required). */
const CC_CATALOG_URL = `${CC_BASE_URL}/models`
/** Host that identifies a Command Code route, whatever it happens to be named. */
const CC_HOST = 'api.commandcode.ai'
/** Wire protocol the Command Code endpoint speaks (same value the patch declares). */
const CC_API = 'openai-completions'
/** Catalog fetch timeout. */
const CC_CATALOG_TIMEOUT_MS = 15000
/** Response cap; the real body is ~15 KB. */
const CC_MAX_BYTES = 2 * 1024 * 1024

/**
 * Read a response body, refusing anything over `maxBytes`.
 *
 * The catalog is the plugin's only inbound network payload, and an upstream (or
 * a proxy in front of it) can otherwise make the engine buffer an unbounded
 * response. Over the cap means "no data", which the caller already handles.
 *
 * @param {Response} res - upstream response.
 * @param {number} maxBytes - largest body this plugin will accept.
 * @returns {Promise<string|null>} the text, or null when unusable/over the cap.
 */
async function readBodyCapped(res, maxBytes) {
  const declared = Number(res.headers?.get?.('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) return null
  const stream = res.body
  if (stream === null || stream === undefined || typeof stream.getReader !== 'function') {
    // Simplified response object (test double / older runtime): fall back to
    // whatever reader it offers, still enforcing the cap.
    if (typeof res.text === 'function') {
      const text = await res.text()
      return text.length > maxBytes ? null : text
    }
    if (typeof res.json === 'function') {
      const value = await res.json().catch(() => null)
      return value === null ? null : JSON.stringify(value)
    }
    return null
  }
  const reader = stream.getReader()
  const chunks = []
  let size = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done === true) break
      size += value.byteLength
      if (size > maxBytes) {
        await reader.cancel().catch(() => {})
        return null
      }
      chunks.push(value)
    }
  } catch {
    return null
  }
  const merged = new Uint8Array(size)
  let at = 0
  for (const chunk of chunks) {
    merged.set(chunk, at)
    at += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

/**
 * Map one catalog entry onto a settings model entry.
 *
 * Only `id` is mandatory. `name` and `contextWindow` are taken from the catalog
 * when it states them: the engine has no catalog entry to fall back on for this
 * route, so omitting `contextWindow` would silently give every model the
 * route-level default (262144) instead of the real 1M.
 *
 * `maxTokens` is deliberately NOT invented — the catalog does not state an
 * output cap, and the route default is a honest "unknown" the user can tune.
 *
 * @param raw - one entry of the provider's catalog.
 * @returns a settings model entry, or null when the entry has no usable id.
 */
export function commandCodeEntry(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return null
  const id = typeof raw.id === 'string' ? raw.id.trim() : ''
  if (id === '') return null
  const entry = { id }
  if (typeof raw.name === 'string' && raw.name.trim() !== '') entry.name = raw.name.trim()
  const contextWindow = Number(raw.context_length ?? raw.contextWindow)
  if (Number.isInteger(contextWindow) && contextWindow > 0) entry.contextWindow = contextWindow
  return entry
}

/**
 * Fetch and normalize the Command Code model catalog.
 *
 * Public endpoint: no credential is sent, so this half works before the user has
 * configured a key (which is what lets the model list appear on its own).
 *
 * @returns `{ ok: true, models, fetchedAt }` or `{ ok: false, reason, status? }`.
 */
export async function fetchCommandCodeCatalog({
  url = CC_CATALOG_URL,
  fetchImpl = fetch,
  timeoutMs = CC_CATALOG_TIMEOUT_MS,
  log = () => {},
} = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, {
      headers: { accept: 'application/json' },
      signal: controller.signal,
    })
    if (!res.ok) {
      log('[gateway-models/commandcode] catalog responded', res.status)
      return { ok: false, reason: res.status === 401 || res.status === 403 ? 'unauthorized' : 'upstream', status: res.status }
    }
    const text = await readBodyCapped(res, CC_MAX_BYTES)
    if (text === null) return { ok: false, reason: 'bad-payload' }
    let body = null
    try {
      body = JSON.parse(text)
    } catch {
      return { ok: false, reason: 'bad-payload' }
    }
    const raw = Array.isArray(body?.data) ? body.data : Array.isArray(body) ? body : null
    if (raw === null) return { ok: false, reason: 'bad-payload' }
    const models = raw.map(commandCodeEntry).filter((entry) => entry !== null)
    if (models.length === 0) return { ok: false, reason: 'bad-payload' }
    return { ok: true, models, fetchedAt: Date.now() }
  } catch (error) {
    const aborted = error?.name === 'AbortError'
    log('[gateway-models/commandcode] catalog fetch failed:', error?.message ?? String(error))
    return { ok: false, reason: aborted ? 'timeout' : 'network' }
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------------------
// Catalog memo
// ---------------------------------------------------------------------------

/** A successful read is reused for this long. */
const CC_CATALOG_OK_TTL_MS = 10 * 60 * 1000
/** A FAILED read is retried no sooner than this — short, but not per settings write. */
const CC_CATALOG_FAIL_TTL_MS = 60 * 1000

/** Last catalog result (success or failure) plus when it was taken. */
let ccCatalogMemo = null

/**
 * Is the memoized catalog result still usable?
 *
 * Split out as a pure function because the two TTLs are the whole point and are
 * easy to get backwards: a failed read must expire QUICKLY (the provider may come
 * back) while a successful one may be reused for a long time (the catalog barely
 * changes, and every settings write would otherwise re-fetch it).
 *
 * @returns the memoized value, or null when it must be re-read.
 */
export function catalogMemoValue(memo, now, okTtlMs = CC_CATALOG_OK_TTL_MS, failTtlMs = CC_CATALOG_FAIL_TTL_MS) {
  if (memo === null || typeof memo !== 'object') return null
  if (!Number.isFinite(memo.at) || !Number.isFinite(now)) return null
  // Clock jumps backwards -> treat as stale rather than "fresh forever".
  const age = now - memo.at
  if (age < 0) return null
  return age < (memo.ok === true ? okTtlMs : failTtlMs) ? memo.value : null
}

/** Read the catalog through the memo above. */
async function readCatalogMemoized(log) {
  const cached = catalogMemoValue(ccCatalogMemo, Date.now())
  if (cached !== null) return cached
  const value = await fetchCommandCodeCatalog({ log })
  ccCatalogMemo = { at: Date.now(), ok: value.ok === true, value }
  return value
}

/**
 * The patch to write for a Command Code route, or null when it already has the
 * shape this plugin maintains.
 *
 * Unlike the opencode-go half — which HOISTS a model we ship ourselves — this one
 * only ever ADDS models: the route's catalog belongs to the provider, so the job
 * is completeness, and the user's existing entries (and their order) are
 * preserved by appending only what is missing.
 *
 * It also supplies the two fields such a route cannot resolve on its own, which
 * matter for any route the shipped patch does NOT cover (a Pro subscriber on
 * `commandcode-pro`, a MAX subscriber on `commandcode-max`, …):
 *
 *   * `api` — the ENGINE refuses to store models on a route whose protocol is
 *     unresolvable, and Command Code has no catalog entry to resolve it from.
 *     Without this the write is rejected and nothing appears, which is exactly
 *     what a differently-named route used to do.
 *   * `baseURL` — same fallback chain as `api`; a catalog-unknown model needs a
 *     route-level endpoint.
 *
 * Both are only written when the RESOLVED route lacks them, so a value the user
 * (or the shipped patch) already provides is never restated — which is also what
 * keeps the write idempotent.
 *
 * @param userProfile - the route as the USER configured it, or undefined.
 * @param resolvedRoute - the route as the engine resolves it (base + user), or undefined.
 * @param catalog - normalized catalog entries (see `commandCodeEntry`).
 * @returns {{models?: Array, api?: string, baseURL?: string}|null}
 */
export function planCommandCodeUpdate(userProfile, resolvedRoute, catalog) {
  if (!Array.isArray(catalog)) return null
  const detected = catalog.filter((entry) => typeof entry?.id === 'string' && entry.id !== '')
  if (detected.length === 0) return null
  const stored = Array.isArray(userProfile?.models) ? userProfile.models : undefined
  const have = new Set((stored ?? []).map((entry) => entry?.id))
  const missing = detected.filter((entry) => !have.has(entry.id))

  const patch = {}
  if (missing.length > 0) {
    // No user list at all: seed the whole catalog in catalog order.
    // A user list exists: keep it verbatim and append only the new arrivals.
    patch.models = stored === undefined
      ? detected.map((entry) => ({ ...entry }))
      : [...stored, ...missing.map((entry) => ({ ...entry }))]
  }
  const resolved = resolvedRoute !== null && typeof resolvedRoute === 'object' ? resolvedRoute : {}
  // Both layers count: in production the resolved route already merges the user's
  // values in, but reading them off the user entry too keeps a value the user just
  // wrote from being restated (and keeps this consistent with isCommandCodeRoute).
  const api = firstString(resolved.api, userProfile?.api)
  if (api === '') patch.api = CC_API
  if (routeBaseUrl(userProfile, resolved) === '') patch.baseURL = CC_BASE_URL
  // Nothing to change -> no write, no event, no loop.
  return Object.keys(patch).length > 0 ? patch : null
}

/**
 * The base URL a route actually resolves to, preferring the user's own value.
 * @returns the URL string, or '' when neither layer states one.
 */
function routeBaseUrl(userEntry, resolvedEntry) {
  for (const entry of [userEntry, resolvedEntry]) {
    const value = typeof entry?.baseURL === 'string' ? entry.baseURL.trim() : ''
    if (value !== '') return value
  }
  return ''
}

/** The first non-empty string among the candidates, or ''. */
function firstString(...values) {
  for (const value of values) {
    if (typeof value === 'string' && value.trim() !== '') return value.trim()
  }
  return ''
}

/** True when a route points at Command Code, whatever it is named. */
export function isCommandCodeRoute(userEntry, resolvedEntry) {
  const url = routeBaseUrl(userEntry, resolvedEntry)
  if (url === '') return false
  try {
    return new URL(url).host.toLowerCase() === CC_HOST
  } catch {
    return false
  }
}

/**
 * Which routes to provision, matched by ENDPOINT rather than by name.
 *
 * The route id is a label, and the same host serves every plan (Go / GOAT /
 * Pro / MAX), so keying off a hard-coded name would silently skip anyone who
 * called their route something else — a Pro subscriber on `commandcode-pro`, a
 * MAX subscriber on `commandcode-max`, or someone reusing the community
 * provider's `commandcode`. Two ways in, both explicit:
 *
 *   1. the route resolves to the Command Code host (the shipped patch supplies
 *      that endpoint for `commandcode`, and a hand-made route states it),
 *   2. its id is listed in the row's `commandcodeProviders` config — for a route
 *      whose endpoint is stated nowhere yet, or proxied through another host.
 *
 * Only routes present in the USER layer are returned, because that is the only
 * evidence the user actually uses Command Code (see `ensureCommandCodeModels`).
 *
 * @param userProviders - the `providers` map from the USER settings layer.
 * @param resolvedProviders - the same map as the engine resolves it (base + user).
 * @param extra - route ids named explicitly in the row config.
 * @returns route ids, in a stable order.
 */
export function commandCodeRouteIds(userProviders, resolvedProviders, extra = []) {
  const users = userProviders !== null && typeof userProviders === 'object' ? userProviders : {}
  const resolved = resolvedProviders !== null && typeof resolvedProviders === 'object' ? resolvedProviders : {}
  const ids = new Set()
  for (const id of Array.isArray(extra) ? extra : []) {
    if (typeof id === 'string' && id !== '') ids.add(id)
  }
  for (const id of Object.keys(users)) {
    if (isCommandCodeRoute(users[id], resolved[id])) ids.add(id)
  }
  return [...ids].sort()
}

/**
 * Provision the model list of every Command Code route the user configured.
 *
 * The guard is the USER layer: the patch layer declares `commandcode` for
 * everyone (that is what supplies the endpoint), so "the route exists" is always
 * true and says nothing about whether the user actually uses Command Code.
 * Writing 81 models into the settings of someone who never configured such a
 * route would be exactly the kind of uninvited write this plugin avoids
 * elsewhere — so nothing happens until the user has an entry of their own (which
 * is what adding the API key does).
 */
async function ensureCommandCodeModels(ctx, settings, config = {}) {
  let userSection
  try {
    if (typeof settings.section !== 'function') {
      ctx.logger?.warn('[gateway-models] settings.section() is unavailable; skipping the Command Code auto-add')
      return
    }
    userSection = settings.section(NS)
  } catch (error) {
    ctx.logger?.warn('[gateway-models] reading the user settings section failed: %s', error?.message ?? String(error))
    return
  }
  let resolvedSection
  try {
    resolvedSection = settings.get(NS)
  } catch {
    resolvedSection = undefined
  }

  const userProviders = userSection?.providers
  const ids = commandCodeRouteIds(userProviders, resolvedSection?.providers, config.commandcodeProviders)
  if (ids.length === 0) return // no Command Code route is in use

  // One catalog serves every route, so it is resolved once and shared. The memo
  // matters: this pass runs on EVERY `llm-pi-ai` settings change — and the theme
  // and UI language live in settings too, so a user fiddling with appearance would
  // otherwise hit the provider once per change. Failures are memoized too, on a
  // much shorter TTL, so a provider outage is not retried on every keystroke.
  const catalog = await readCatalogMemoized((...a) => ctx.logger?.warn?.(...a))
  if (catalog.ok !== true) {
    ctx.logger?.warn(
      '[gateway-models] could not read the Command Code model catalog (%s); leaving the list(s) alone',
      catalog.reason,
    )
    return
  }

  for (const id of ids) {
    const userRoute = userProviders?.[id]
    if (userRoute === null || typeof userRoute !== 'object') continue
    const patch = planCommandCodeUpdate(userRoute, resolvedSection?.providers?.[id], catalog.models)
    if (patch === null) continue // already complete
    const before = Array.isArray(userRoute.models) ? userRoute.models.length : 0
    const after = Array.isArray(patch.models) ? patch.models.length : before
    const declared = [patch.api === undefined ? '' : 'api', patch.baseURL === undefined ? '' : 'baseURL']
      .filter((s) => s !== '')
    ctx.logger.info(
      '[gateway-models] "%s": %d model(s) from the provider catalog (list %d -> %d)%s',
      id,
      Math.max(0, after - before),
      before,
      after,
      declared.length === 0 ? '' : ` and declaring ${declared.join(' + ')}`,
    )
    await settings.update(NS, { providers: { [id]: patch } })
  }
}

function installAutoModels(ctx, config = {}) {
  const settings = ctx.settings
  let ensureChain = Promise.resolve()

  // Two independent provisioning passes over the SAME settings namespace. They
  // are chained rather than run in parallel so the second never reads a section
  // the first is halfway through writing.
  const ensure = () => {
    ensureChain = ensureChain
      .then(() => ensureV41Models(ctx, settings))
      .then(() => ensureCommandCodeModels(ctx, settings, config))
      .catch((error) => {
        ctx.logger?.warn('[gateway-models] auto-add failed: %s', error?.message ?? String(error))
      })
  }

  ctx.effect(() => {
    const started = (async () => {
      const ready = await waitForNamespace(settings)
      if (!ready) {
        ctx.logger?.warn('[gateway-models] llm-pi-ai settings namespace not seen within %dms; skipping auto-add', NS_WAIT_TIMEOUT_MS)
        return
      }
      ensure()
    })()

    // Re-run whenever the user edits the llm-pi-ai settings (Models page or
    // file). Idempotent: once the models sit at the front and the route has its
    // endpoint, later calls no-op — including the call our own write triggers.
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
  ctx.inject(['settings'], (settingsCtx) => installAutoModels(settingsCtx, config))
}

export default { name, inject, apply }