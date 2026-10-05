// Cross-process lock for the shared install paths.
//
// The GUI used to refuse to start twice (`requestSingleInstanceLock`), which hid a real
// problem: several things live OUTSIDE a single instance's private state and are mutated
// destructively — the engine tree (`<userData>/dsh-engine`, installed via a stage dir),
// the bundled-plugin staging root (`~/.dsh-gui/bundled-plugins`, wiped and re-copied on
// every install), and the profile itself (pnpm add/remove). Two instances doing that at
// once produce exactly the failures already seen in the wild: pnpm aborting with
// ERR_PNPM_DIRECTORY_FETCHER_IO because the staged directory vanished mid-read, or a
// profile half-updated.
//
// So the restriction is replaced by a lock: work on those paths one process at a time,
// and let anything else (windows, engines, settings) run in parallel.
//
// Deliberately dependency-free and synchronous-free (async fs only) so it is testable
// with temp dirs and adds no new runtime dependency to an Electron app.
import { mkdir, open, rm, stat, readFile, utimes } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";

/** How long to keep waiting for another instance before giving up. */
export const LOCK_TIMEOUT_MS = 120_000;
/** A lock file whose owner is gone and that is older than this is taken over. */
export const LOCK_STALE_MS = 180_000;
/** How often the held lock's mtime is refreshed (see withInstallLock). */
export const LOCK_HEARTBEAT_MS = 30_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Is a process with this pid still alive? `EPERM` means it exists but belongs to someone
 * else — still alive, and definitely not ours to take the lock from.
 */
function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

/**
 * Parse a lock record. Two shapes exist around here:
 *   - ours: `<token>\n<pid>\n<iso>` — the token lets us verify ownership on release;
 *   - the engine's `dsh-atomic-write`: exactly `<pid>\n`. It requires `/^\d+\n$/` and
 *     otherwise treats the lock as unreadable and waits for it, so a lock file shared with
 *     the engine (the profile's own `package.json.lock`) must be understood in both shapes —
 *     and, when we take it, written in the shape its other users can read.
 */
function parseLock(raw) {
  const text = String(raw ?? "");
  if (/^\d+\n$/.test(text)) {
    return { token: null, pid: Number.parseInt(text.trim(), 10), engineFormat: true };
  }
  const [token = "", pidText = ""] = text.split("\n");
  const pid = Number.parseInt(pidText, 10);
  return { token: token.trim() || null, pid: Number.isInteger(pid) ? pid : null, engineFormat: false };
}

/**
 * Acquire an exclusive lock file, run `fn`, release it.
 *
 * Ownership is the whole point, so it is tracked explicitly:
 *  - the file starts with a unique token, and only the owner whose token is still there
 *    removes it (an unconditional `rm` in `finally` would delete a lock someone else had
 *    legitimately taken over after declaring ours stale — silently breaking mutual
 *    exclusion for everyone after that);
 *  - a lock is only treated as abandoned when its owner is *gone*. The previous version
 *    used age alone, but the work under this lock routinely outlives any fixed threshold
 *    (`dsh plugin` gets a 600 s timeout), so a live installer was regularly declared dead
 *    and had its staging directory wiped underneath it.
 *  - the mtime is refreshed while held, so other tooling that only looks at timestamps
 *    (and humans reading the file) still see a live lock.
 *
 * @param lockFile - absolute path of the lock file (its directory is created).
 * @param fn - work to run while holding the lock.
 * @param options.timeoutMs - give up after this long (the work still runs, unlocked —
 *   refusing to work at all would be worse than proceeding carefully).
 * @param options.staleMs - how long an owner-less lock file may linger before takeover.
 * @param options.heartbeatMs - mtime refresh interval while held.
 * @param options.log - diagnostics sink.
 * @returns whatever `fn` returns; `fn` also receives `{ locked, waitedMs }`.
 */
export async function withInstallLock(lockFile, fn, options = {}) {
  const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? LOCK_STALE_MS;
  const heartbeatMs = options.heartbeatMs ?? LOCK_HEARTBEAT_MS;
  const log = options.log ?? (() => {});
  // `engineFormat` writes exactly `<pid>\n`, which is what the engine's own `withFileLock`
  // (dsh-atomic-write) requires to recognise a holder; anything else it treats as an
  // unreadable lock and waits for. Use it whenever the lock file is shared with the engine
  // (e.g. `<profile>/package.json.lock`). Ownership is then proved by liveness alone —
  // which is also why the engine's own unconditional release is safe there: a takeover only
  // happens once the holder's process is gone, so the dead holder cannot release anything.
  const engineFormat = options.recordFormat === "pid";
  const started = Date.now();
  const token = `${process.pid}-${randomUUID()}`;
  let handle = null;
  let waitedMs = 0;
  let heartbeat = null;

  await mkdir(path.dirname(lockFile), { recursive: true });
  for (;;) {
    try {
      // 'wx' = create exclusively: the whole point of the lock.
      handle = await open(lockFile, "wx");
      await handle.writeFile(
        engineFormat ? `${process.pid}\n` : `${token}\n${process.pid}\n${new Date().toISOString()}\n`,
        "utf8",
      );
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        // Not a contention problem (permissions, a directory in the way, …): do the work
        // anyway rather than leaving the GUI unusable.
        log("install lock unavailable, proceeding unlocked:", error?.message ?? String(error));
        return fn({ locked: false, waitedMs: 0 });
      }
      // Someone holds it. Only take it over if that someone is gone (or the file is
      // unreadable AND old) — never merely because it has been held for a while.
      let ageMs = 0;
      let raw = null;
      try {
        const info = await stat(lockFile);
        ageMs = Date.now() - info.mtimeMs;
        raw = await readFile(lockFile, "utf8").catch(() => null);
      } catch {
        // The lock file vanished (or became unreadable) between the failed `open` and this
        // stat. Retry — but still respect the deadline and still yield: a persistent
        // EPERM/EBUSY here would otherwise spin this loop forever with no sleep, hanging
        // the caller (and, for plugin ops, leaving the in-process gate closed).
        if (Date.now() - started > timeoutMs) {
          log(`install lock unreadable after ${Math.round(timeoutMs / 1000)}s; proceeding unlocked`);
          return fn({ locked: false, waitedMs: Date.now() - started });
        }
        await sleep(50);
        continue;
      }
      const { pid } = parseLock(raw);
      const ownerGone = pid === null || !pidAlive(pid);
      if (ownerGone && ageMs > staleMs) {
        log(`install lock owner is gone (pid ${pid ?? "?"}, ${Math.round(ageMs / 1000)}s old); taking it over`);
        await rm(lockFile, { force: true }).catch(() => {});
        continue;
      }
      if (Date.now() - started > timeoutMs) {
        log(`install lock still held after ${Math.round(timeoutMs / 1000)}s; proceeding unlocked`);
        return fn({ locked: false, waitedMs: Date.now() - started });
      }
      waitedMs = Date.now() - started;
      if (waitedMs < 1000) log("install lock is held by another instance; waiting…");
      await sleep(150 + Math.floor(Math.random() * 150));
    }
  }

  // Keep the mtime fresh while we work, so no other tool (or person) reads a long install
  // as an abandoned lock.
  heartbeat = setInterval(() => {
    const now = new Date();
    utimes(lockFile, now, now).catch(() => {});
  }, heartbeatMs);
  if (typeof heartbeat.unref === "function") heartbeat.unref();

  try {
    return await fn({ locked: true, waitedMs });
  } finally {
    if (heartbeat !== null) clearInterval(heartbeat);
    try {
      await handle.close();
    } catch {
      /* already closed */
    }
    // Only remove the lock if it is still OURS. If someone took it over while we worked,
    // deleting it would hand the critical section to a third process. In `engineFormat` there
    // is no token to compare, but a takeover requires our process to be gone — so if we are
    // still here, the record is necessarily still ours.
    const current = await readFile(lockFile, "utf8").catch(() => null);
    if (engineFormat) {
      await rm(lockFile, { force: true }).catch(() => {});
    } else if (current !== null && parseLock(current).token === token) {
      await rm(lockFile, { force: true }).catch(() => {});
    } else if (current !== null) {
      log("install lock was taken over while held; leaving the new owner's lock alone");
    }
  }
}

/** Read a lock file's contents (pid + timestamp); null when absent/unreadable. */
export async function readInstallLock(lockFile) {
  try {
    return await readFile(lockFile, "utf8");
  } catch {
    return null;
  }
}


