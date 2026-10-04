// dsh-keys-setting — host half.
//
// Owns the "which key sends / which key breaks the line" preference and serves
// it to the page half over a same-origin JSON route.
//
// WHERE THE PREFERENCE LIVES (engine 0.2.0)
// In the plugin's OWN row config, not in a settings document. Engine 0.2.0 replaced
// the old `settings` service (`register/get/section` — all gone) with `SettingsForms`,
// and retired `settings.yaml`: tunable values now belong in the plugin's `Config`
// ("put tunable values in the plugin's Config so users change them in
// cordis.patch.yml", cordis-plugin-development → references/practices.md), which the
// Loader validates at activation and the engine can rewrite in place.
//
// The three fields are declared `.volatile()` — the marker schemastery provides (the
// engine's own `dsh-agent-default-model` does the same). That is what makes them
// live-editable: a write through `settings.update()` reaches the running plugin's
// config reference WITHOUT a restart, which is exactly what this plugin needs, because
// the page half reads the value on every keystroke decision.
//
// Writing therefore goes through the settings service by ROW ID (+ the revision read
// from `describe()`), and reading goes through the config reference's `.get()`.
//
// WHY A ROUTE
// The page is served from a per-launch random port (the shell spawns
// `dsh web --port 0`), so browser storage is a different origin on every launch and
// cannot hold the preference. The page half therefore talks to the small route below.

// The schema builder comes from the ENGINE'S OWN VENDORED COPY
// (`@deepseek-ai/schemastery`, the one `dsh-settings` itself imports), not from the
// unscoped `schemastery` on npm.
//
// Both are the same library (3.18.x) and drop-in compatible, but the unscoped one
// is a THIRD-PARTY runtime dependency this plugin used to pull into every host's
// profile. That is both a supply-chain surface and exactly what marketplace policy
// review flags — and it made this the only one of the four bundled plugins with a
// non-empty `dependencies`. The scoped copy is already present wherever the engine
// is (it resolves through the profile's node_modules, where the engine's packages
// live), so importing it removes the dependency instead of swapping one for another.
import Schema from '@deepseek-ai/schemastery'
import { ACTIONS, DEFAULTS, readPrefs, sanitizePatch, rejectUntrusted } from './shared.js'

export const name = 'composer-keys'

// `settings` addresses our own row (and lends the live config write path);
// `webServer` carries the page-facing route.
export const inject = ['settings', 'webServer']

/**
 * Our row id — deliberately the same string as the plugin `name` and the id in
 * cordis.patch.yml, because that row IS the settings entry this plugin reads and
 * writes. Renaming the package must not orphan the user's stored choice.
 */
const NS = 'composer-keys'

/** Host route the page half reads and writes. */
const ROUTE_PATH = '/composer-keys'

/** Reserved body cap: the request is a three-field JSON object. */
const MAX_BODY_BYTES = 8 * 1024

/**
 * The plugin's config schema: three enums, each defaulting to the engine's behaviour.
 *
 * `.volatile()` on every field is REQUIRED, not cosmetic: `settings.update()` refuses
 * an entry with no volatile fields ("has no volatile fields"), and only a volatile
 * field reaches the running plugin without a restart. Omitting it would put the
 * preference back to "changes do nothing until you restart" — silent, and precisely
 * the failure this plugin just came back from.
 */
export const Config = Schema.object({
  enter: Schema.union(ACTIONS).default(DEFAULTS.enter).volatile(),
  shiftEnter: Schema.union(ACTIONS).default(DEFAULTS.shiftEnter).volatile(),
  ctrlEnter: Schema.union(ACTIONS).default(DEFAULTS.ctrlEnter).volatile(),
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
  // plugin, and it must be usable before the route can answer.
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx.settings

    /**
     * This plugin's own settings entry, or null while it is not describable yet.
     * `ns` is the profile entry id — our row id — and `revision` is what
     * `update()` requires as its conflict guard.
     */
    const ownEntry = () => {
      try {
        const list = settings.describe({ redactSecrets: true })
        return Array.isArray(list) ? (list.find((d) => d && d.ns === NS) ?? null) : null
      } catch (error) {
        ctx.logger?.warn?.('[composer-keys] describe() failed: %s', error?.message ?? String(error))
        return null
      }
    }

    // effect 必须挂在 inject 回调自己的 fiber 上：`ctx.inject(deps, cb)` 起的是**新 fiber**，
    // 挂在外部 ctx 上时，settings 服务被销毁/重建（GUI 热切换插件就会）后这条路由不会随之
    // 销毁 —— handler 里握着已死的东西（500），而回调再次执行又会重复注册同一个 exact
    // 路由（webServer 会报 duplicate exact route）。
    settingsCtx.effect(() => {
      // We ship our own Settings → General row (the page half), so the engine must not
      // also auto-generate a page for this namespace — the same call the engine's own
      // `dsh-agent-default-model` makes, for the same reason.
      let disposePolicy = null
      try {
        disposePolicy = settings.configure({ auto: false })
      } catch (error) {
        ctx.logger?.warn?.('[composer-keys] settings.configure() failed: %s', error?.message ?? String(error))
      }

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
              return sendJson(res, 200, { ok: true, value: readPrefs(config), defaults: DEFAULTS })
            }
            if (req.method !== 'POST') {
              res.setHeader('allow', 'GET, POST')
              return sendJson(res, 405, { ok: false, error: 'method not allowed' })
            }
            const body = await readJsonBody(req)
            if (body === null) return sendJson(res, 400, { ok: false, error: 'invalid body' })
            const patch = sanitizePatch(body)
            if (Object.keys(patch).length > 0) {
              // The revision is not optional in spirit: without it the engine cannot
              // tell "the user changed this from another window" from "we are the only
              // writer", and it refuses with SETTINGS_CONFLICT.
              const entry = ownEntry()
              if (entry === null) {
                ctx.logger?.warn?.('[composer-keys] own settings entry %s is not describable; cannot save', NS)
                return sendJson(res, 503, { ok: false, error: 'settings namespace unavailable' })
              }
              await settings.update(NS, patch, entry.revision)
            }
            return sendJson(res, 200, { ok: true, value: readPrefs(config), defaults: DEFAULTS })
          } catch (error) {
            ctx.logger?.warn?.('[composer-keys] request failed: %s', error?.message ?? String(error))
            return sendJson(res, 500, { ok: false, error: 'internal error' })
          }
        },
      })
      ctx.logger?.info?.('[composer-keys] route ready at %s (entry %s)', ROUTE_PATH, NS)
      return () => {
        if (typeof dispose === 'function') dispose()
        if (typeof disposePolicy === 'function') disposePolicy()
      }
    }, 'composer-keys.route')
  })
}

export { ACTIONS, DEFAULTS, sanitizePatch, readPrefs }

export default { name, inject, apply, Config }
