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
import { mkdir, open, rm, stat, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

/** How long to keep waiting for another instance before giving up. */
export const LOCK_TIMEOUT_MS = 120_000;
/** A lock file older than this is treated as abandoned (a crashed instance). */
export const LOCK_STALE_MS = 180_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Acquire an exclusive lock file, run `fn`, release it.
 *
 * @param lockFile - absolute path of the lock file (its directory is created).
 * @param fn - work to run while holding the lock.
 * @param options.timeoutMs - give up after this long (the work still runs, unlocked —
 *   refusing to work at all would be worse than proceeding carefully).
 * @param options.staleMs - abandon a lock whose file is older than this.
 * @param options.log - diagnostics sink.
 * @returns whatever `fn` returns, plus `{ locked: boolean, waitedMs: number }` semantics
 *   through the second parameter of `fn`.
 */
export async function withInstallLock(lockFile, fn, options = {}) {
  const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? LOCK_STALE_MS;
  const log = options.log ?? (() => {});
  const started = Date.now();
  let handle = null;
  let waitedMs = 0;

  await mkdir(path.dirname(lockFile), { recursive: true });
  for (;;) {
    try {
      // 'wx' = create exclusively: the whole point of the lock.
      handle = await open(lockFile, "wx");
      await handle.writeFile(`${process.pid}\n${new Date().toISOString()}\n`, "utf8");
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") {
        // Not a contention problem (permissions, a directory in the way, …): do the work
        // anyway rather than leaving the GUI unusable.
        log("install lock unavailable, proceeding unlocked:", error?.message ?? String(error));
        return fn({ locked: false, waitedMs: 0 });
      }
      // Someone holds it. If it looks abandoned, clear it and retry immediately.
      let ageMs = 0;
      try {
        ageMs = Date.now() - (await stat(lockFile)).mtimeMs;
      } catch {
        continue; // it disappeared: retry at once
      }
      if (ageMs > staleMs) {
        log(`install lock looks abandoned (${Math.round(ageMs / 1000)}s old); taking it over`);
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

  try {
    return await fn({ locked: true, waitedMs });
  } finally {
    try {
      await handle.close();
    } catch {
      /* already closed */
    }
    await rm(lockFile, { force: true }).catch(() => {});
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

/** Write a marker file (used by tests to prove the lock is held). */
export async function writeMarker(file, text) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, text, "utf8");
}
