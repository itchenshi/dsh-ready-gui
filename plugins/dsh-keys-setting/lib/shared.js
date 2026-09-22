// dsh-keys-setting — shared constants and pure helpers.
//
// Deliberately free of `schemastery` (and of every other dependency): the settings
// schema lives in ./index.js, while this module is what the unit tests import, so
// the pure logic stays testable with no install step at all.

/** The two actions any gesture can be assigned. */
export const ACTIONS = ['send', 'newline']

/**
 * Per-gesture defaults. These mirror the engine's own keymap exactly, so a user
 * who never opens the settings row gets byte-identical behaviour:
 *   - Enter          -> send
 *   - Shift+Enter    -> newline
 *   - Ctrl/Cmd+Enter -> send
 *
 * `Ctrl+Shift+Enter` is folded into the Shift gesture, which is what the engine
 * keymap does (its Shift rule is matched before the plain one).
 */
export const DEFAULTS = {
  enter: 'send',
  shiftEnter: 'newline',
  ctrlEnter: 'send',
}

/**
 * Coerce one raw patch into the stored shape: unknown keys are dropped and
 * unknown values are dropped (never persisted), so a stale or hostile client
 * cannot poison the document.
 * @returns a partial patch containing only valid fields.
 */
export function sanitizePatch(raw) {
  const out = {}
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const key of Object.keys(DEFAULTS)) {
    const value = raw[key]
    if (ACTIONS.includes(value)) out[key] = value
  }
  return out
}

/** Normalize a full stored value against the defaults (missing/invalid -> default). */
export function normalizePrefs(raw) {
  const out = { ...DEFAULTS }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return out
  for (const key of Object.keys(DEFAULTS)) {
    if (ACTIONS.includes(raw[key])) out[key] = raw[key]
  }
  return out
}

/**
 * The engine's own trust fence for a browser-facing route.
 *
 * `ctx.webServer` serves every registered route to ANY caller: the engine's
 * Host-allowlist + session-cookie gate lives in the RPC channel registrar
 * (`connection` → `requestRejection`), NOT in `webServer` — the engine's own route
 * owners therefore consult it first (see @deepseek-ai/dsh-host-open-in-app). Without
 * this call the route answers a plain local process AND a page that has rebound a
 * hostname to 127.0.0.1; this route both reads and writes the stored preference.
 *
 * Fails CLOSED: a web route that cannot verify its caller must not answer.
 *
 * Lives here (not in ./index.js) so the repo's unit tests can cover it: ./index.js
 * pulls in schemastery, which the GUI checkout does not install.
 *
 * @param ctx - the plugin context (reads the `connection` service).
 * @param req - the Node request.
 * @param res - the Node response.
 * @returns true when the request was rejected (the response is already ended).
 */
export function rejectUntrusted(ctx, req, res) {
  const connection = ctx?.get?.('connection')
  if (typeof connection?.requestRejection !== 'function') {
    res.statusCode = 403
    res.end('forbidden')
    return true
  }
  const rejection = connection.requestRejection(req)
  if (rejection === undefined) return false
  res.statusCode = rejection
  res.end(rejection === 401 ? 'unauthorized' : 'forbidden')
  return true
}
