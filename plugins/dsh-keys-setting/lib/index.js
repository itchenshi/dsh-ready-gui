// dsh-keys-setting — host half.
//
// Owns the "which key sends / which key breaks the line" preference and serves
// it to the page half over a same-origin JSON route.
//
// WHY A HOST HALF AT ALL
// The preference has to survive restarts, and the page is served from a
// per-launch random port (the shell spawns `dsh web --port 0`), so browser
// storage is a different origin on every launch and cannot hold it. The engine's
// settings document is the durable place: this half registers a namespace with
// the settings service, so the value lands in `$DSH_HOME/settings.yaml`,
// is schema-validated, and travels with the data directory.
//
// WHY A ROUTE
// The settings RPC domain serves configuration clients a fixed set of
// namespaces, so a plugin-owned namespace is only readable in-process. The page
// half therefore talks to the small route below — the same pattern the
// third-party side-card plugin uses for its own preferences.

import Schema from 'schemastery'
import { ACTIONS, DEFAULTS, sanitizePatch, rejectUntrusted } from './shared.js'

export const name = 'composer-keys'

// `settings` owns the durable value; `webServer` carries the page-facing route.
export const inject = ['settings', 'webServer']

/** Settings namespace (lowercase-hyphenated) holding this plugin's preference. */
const NS = 'composer-keys'

/** Host route the page half reads and writes. */
const ROUTE_PATH = '/composer-keys'

/** Reserved body cap: the request is a three-field JSON object. */
const MAX_BODY_BYTES = 8 * 1024

/** The settings schema: three enums, each defaulting to the engine's behaviour. */
export const Config = Schema.object({
  enter: Schema.union(ACTIONS).default(DEFAULTS.enter),
  shiftEnter: Schema.union(ACTIONS).default(DEFAULTS.shiftEnter),
  ctrlEnter: Schema.union(ACTIONS).default(DEFAULTS.ctrlEnter),
})

/** Read one request body (bounded, JSON object only) or null when unusable. */
function readJsonBody(req) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) {
        // 先让 handler 能回一个 413/400 再断开：直接 destroy() 会让客户端只看到
        // `fetch failed`（ECONNRESET），我们文档里承诺的状态码根本没送到。
        resolve(null)
        req.pause()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolve({})
      try {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        resolve(parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null)
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

function sendJson(res, status, body) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  // A live preference; never let a shared cache hold it.
  res.setHeader('cache-control', 'no-store')
  res.end(JSON.stringify(body))
}

/**
 * The engine's own trust fence for a browser-facing route.
 *
 * `ctx.webServer` serves every registered route to ANY caller: the engine's
 * Host-allowlist + session-cookie gate lives in the RPC channel registrar
 * (`connection` → `requestRejection`), NOT in `webServer` — the engine's own route
 * owners therefore consult it first (see @deepseek-ai/dsh-host-open-in-app). Without
 * this call the route answers a plain local process AND a page that has rebound a
 * hostname to 127.0.0.1, and this route writes the stored preference.
 *
 * Fails CLOSED: a web route that cannot verify its caller must not answer.
 * @param ctx - the plugin context (reads the `connection` service).
 * @param req - the Node request.
 * @param res - the Node response.
 * @returns true when the request was rejected (the response is already ended).
 */
// The fence itself lives in ./shared.js (dependency-free) so the repo's unit tests can
// cover it without importing schemastery; re-exported here so the plugin's public
// surface stays unchanged.
export { rejectUntrusted }

export function apply(ctx, config = {}) {
  if (config.enabled === false) {
    ctx.logger?.info?.('[composer-keys] disabled by configuration')
    return
  }

  // Registered through an injection: the settings service may mount after this
  // plugin, and the namespace must exist before the route can answer.
  ctx.inject(['settings'], (settingsCtx) => {
    const scope = settingsCtx.settings.register(NS, Config)
    // effect 必须挂在 inject 回调自己的 fiber 上：`ctx.inject(deps, cb)` 起的是**新 fiber**，
    // 挂在外部 ctx 上时，settings 服务被销毁/重建（GUI 热切换插件就会）后这条路由不会随之
    // 销毁 —— handler 里握着一个已死的 scope（500），而回调再次执行又会重复注册同一个
    // exact 路由（webServer 会报 duplicate exact route）。
    settingsCtx.effect(() => {
      const dispose = settingsCtx.webServer.register({
        kind: 'exact',
        path: ROUTE_PATH,
        handler: async (req, res) => {
          try {
            // Trust fence FIRST — see rejectUntrusted's doc comment: `webServer`
            // routes are NOT covered by the engine's Host/cookie gate, and this one
            // both reads and WRITES the preference.
            if (rejectUntrusted(ctx, req, res)) return
            if (req.method === 'GET') {
              return sendJson(res, 200, { ok: true, value: scope.get(), defaults: DEFAULTS })
            }
            if (req.method !== 'POST') {
              res.setHeader('allow', 'GET, POST')
              return sendJson(res, 405, { ok: false, error: 'method not allowed' })
            }
            const body = await readJsonBody(req)
            if (body === null) return sendJson(res, 400, { ok: false, error: 'invalid body' })
            const patch = sanitizePatch(body)
            if (Object.keys(patch).length > 0) await scope.update(patch)
            return sendJson(res, 200, { ok: true, value: scope.get(), defaults: DEFAULTS })
          } catch (error) {
            ctx.logger?.warn?.('[composer-keys] request failed: %s', error?.message ?? String(error))
            return sendJson(res, 500, { ok: false, error: 'internal error' })
          }
        },
      })
      ctx.logger?.info?.('[composer-keys] route ready at %s (namespace %s)', ROUTE_PATH, NS)
      return () => {
        if (typeof dispose === 'function') dispose()
      }
    }, 'composer-keys.route')
  })
}

export { ACTIONS, DEFAULTS, sanitizePatch }

export default { name, inject, apply, Config }
