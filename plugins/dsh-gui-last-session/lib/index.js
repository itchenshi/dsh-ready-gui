// dsh-gui-last-session — host half.
//
// Persists "the conversation you were last in" so the client half can reopen it
// after a restart.
//
// Design notes
// ------------
// * The pointer lives in a single JSON file under $DSH_HOME. The DSH GUI already
//   keeps a pointer at <userData>/last-session.json for its own purposes; this
//   plugin deliberately owns its OWN file so the plugin is self-contained and
//   works for anyone who installs it (not just DSH GUI users). DSH GUI hands the
//   pointer over through the same public endpoints (see README), so an existing
//   user's last conversation is not lost when they move to the plugin.
//
// * The file is written atomically (tmp + rename) and validated on read: a
//   truncated or hostile file must never make the client half try to open
//   something that is not a session id.
//
// * This half exposes a tiny HTTP surface on the engine's own webserver so the
//   browser half can read/write it. The route is namespaced under the plugin id
//   and only accepts a well-formed session id.

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { homedir } from 'node:os'

export const name = 'gui-last-session'

// The webServer service provides the HTTP surface the browser half talks to.
export const inject = ['webServer']

/** Session ids in DSH are `session-<...>`; enforce a conservative shape. */
const SESSION_ID_RE = /^session-[A-Za-z0-9_-]{4,200}$/u

/** Resolve $DSH_HOME the same way the engine does. */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return resolve(fromEnv)
  return resolve(homedir(), '.dsh')
}

/** Absolute path of the pointer file. */
export function lastSessionFile(home = dshHome()) {
  return join(home, 'last-session.json')
}

/** True when a value is an acceptable session id. */
export function isSessionId(value) {
  return typeof value === 'string' && SESSION_ID_RE.test(value)
}

/**
 * Read the stored pointer. Returns `{ sessionId, updatedAt }` or null.
 * A missing, unreadable, malformed, or non-matching file all resolve to null —
 * "no memory" is always a safe answer, never a throw.
 */
export async function readLastSession(home = dshHome()) {
  let raw
  try {
    raw = await readFile(lastSessionFile(home), 'utf8')
  } catch {
    return null
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (parsed === null || typeof parsed !== 'object') return null
  if (!isSessionId(parsed.sessionId)) return null
  const updatedAt = Number.isFinite(parsed.updatedAt) ? parsed.updatedAt : null
  return { sessionId: parsed.sessionId, updatedAt }
}

/**
 * Persist the pointer atomically. Rejects anything that is not a valid session
 * id so a buggy or hostile caller cannot poison the file.
 * @returns {Promise<{ok: true, sessionId: string, updatedAt: number}>}
 */
export async function writeLastSession(sessionId, home = dshHome(), now = Date.now()) {
  if (!isSessionId(sessionId)) {
    throw new Error(`gui-last-session: refusing to store an invalid session id`)
  }
  const file = lastSessionFile(home)
  const payload = JSON.stringify({ sessionId, updatedAt: now })
  await mkdir(dirname(file), { recursive: true })
  // Write-then-rename: a crash mid-write leaves the previous pointer intact
  // rather than a half-written file the reader would reject.
  // Temp 名必须唯一：只用 pid 时两个并发 POST 会算同一个名字，先 rename 的那个把它移走，
  // 后一个要么 ENOENT、要么把别人的字节 rename 上去（静默丢一次更新）。
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  await writeFile(tmp, payload, 'utf8')
  await rename(tmp, file)
  return { ok: true, sessionId, updatedAt: now }
}

/** Read a JSON request body with a hard size cap. */
function readJsonBody(req, limitBytes = 8 * 1024) {
  return new Promise((resolvePromise) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limitBytes) {
        // Stop buffering; the caller gets `null` and answers 400. Do NOT destroy the
        // socket here: destroying it first means the client only ever sees
        // `fetch failed` (ECONNRESET) and never the documented 400.
        chunks.length = 0
        req.pause()
        resolvePromise(null)
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) return resolvePromise(null)
      try {
        resolvePromise(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolvePromise(null)
      }
    })
    req.on('error', () => resolvePromise(null))
  })
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(text)
}

/**
 * The engine's own trust fence for a browser-facing route.
 *
 * `ctx.webServer` serves every registered route to ANY caller: the engine's
 * Host-allowlist + session-cookie gate lives in the RPC channel registrar
 * (`connection` → `requestRejection`), NOT in `webServer` — the engine's own route
 * owners therefore consult it first (see @deepseek-ai/dsh-host-open-in-app). Without
 * this call this route hands the last-session pointer to any local process and to a
 * page that has rebound a hostname to 127.0.0.1, and it accepts their writes.
 *
 * Fails CLOSED: a web route that cannot verify its caller must not answer.
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

export function apply(ctx, config = {}) {
  const enabled = config.enabled !== false
  const home = dshHome()

  if (!enabled) {
    ctx.logger?.info?.('[gui-last-session] disabled by configuration')
    return
  }

  // The browser half is served by the engine; it reads/writes the pointer here.
  ctx.effect(() => {
    const dispose = ctx.webServer.register({
      kind: 'exact',
      path: '/gui-last-session',
      handler: async (req, res) => {
        try {
          // Trust fence FIRST — `webServer` routes are not covered by the engine's
          // Host/cookie gate (see rejectUntrusted).
          if (rejectUntrusted(ctx, req, res)) return
          if (req.method === 'GET') {
            const last = await readLastSession(home)
            return sendJson(res, 200, last ?? { sessionId: null })
          }
          if (req.method === 'POST' || req.method === 'PUT') {
            const body = await readJsonBody(req)
            if (body === null || !isSessionId(body.sessionId)) {
              return sendJson(res, 400, { ok: false, error: 'invalid session id' })
            }
            const result = await writeLastSession(body.sessionId, home)
            return sendJson(res, 200, result)
          }
          res.setHeader('allow', 'GET, POST, PUT')
          return sendJson(res, 405, { ok: false, error: 'method not allowed' })
        } catch (error) {
          ctx.logger?.warn?.('[gui-last-session] request failed: %s', error?.message ?? String(error))
          return sendJson(res, 500, { ok: false, error: 'internal error' })
        }
      },
    })
    if (!config.quiet) {
      ctx.logger?.info?.('[gui-last-session] active (pointer: %s)', lastSessionFile(home))
    }
    return () => {
      if (typeof dispose === 'function') dispose()
    }
  }, 'gui-last-session.route')
}

export default { name, inject, apply }
