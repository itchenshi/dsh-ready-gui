/* install-lock.test.cjs — the cross-process install lock (no Electron needed).
 *
 * The GUI now allows several instances, so the paths that are shared AND written
 * destructively (engine tree, bundled-plugin staging root, profile) must be serialized.
 * Getting this wrong is not theoretical: concurrent staging made pnpm abort with
 * ERR_PNPM_DIRECTORY_FETCHER_IO because the staged directory vanished mid-read.
 */
"use strict";

const assert = require("node:assert");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { withInstallLock, readInstallLock } = require("../install-lock.js");

const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-lock-"));
const lockFile = path.join(root, ".locks", "install.lock");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
async function check(name, fn) {
  try {
    clearLock(); // every case starts clean; one of them deliberately leaves a lock behind
    await fn();
    console.log("  ok - " + name);
  } catch (error) {
    failures += 1;
    console.error("  FAIL - " + name + ": " + error.message);
  }
}

/** Every case must start from a clean slate — one case deliberately leaves a lock behind. */
function clearLock() {
  try {
    fs.rmSync(lockFile, { force: true });
  } catch {
    /* nothing to clear */
  }
}

(async () => {
  await check("runs the work and releases the lock afterwards", async () => {
    let ran = false;
    const out = await withInstallLock(lockFile, ({ locked }) => {
      ran = true;
      assert.strictEqual(locked, true, "the work must know it holds the lock");
      return "result";
    });
    assert.strictEqual(out, "result");
    assert.ok(ran);
    assert.strictEqual(fs.existsSync(lockFile), false, "the lock file must be gone");
  });

  await check("serializes two callers: the second waits for the first", async () => {
    const order = [];
    const first = withInstallLock(lockFile, async () => {
      order.push("first:start");
      await sleep(300);
      order.push("first:end");
    });
    await sleep(50); // let the first one take the lock
    const second = withInstallLock(lockFile, () => {
      order.push("second");
    });
    await Promise.all([first, second]);
    assert.deepStrictEqual(order, ["first:start", "first:end", "second"], "no interleaving");
  });

  await check("takes over a lock whose owner is gone (owner pid not alive, file old)", async () => {
    // Simulate a crash: the lock file is old AND its owner no longer exists, so nobody will
    // ever release it. Format is `<token>\n<pid>\n<iso>` (see withInstallLock).
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, "dead-owner\n999999\n2000-01-01T00:00:00.000Z\n");
    const old = new Date(Date.now() - 10 * 60 * 1000);
    fs.utimesSync(lockFile, old, old);
    const out = await withInstallLock(lockFile, ({ locked }) => locked, { staleMs: 60_000 });
    assert.strictEqual(out, true, "an abandoned lock must not block the app forever");
    assert.strictEqual(fs.existsSync(lockFile), false, "and it must be cleaned up");
  });

  await check("NEVER takes over a lock whose owner is still alive, however old it looks", async () => {
    // The regression this pins: ownership used to be decided by file age alone, but the work
    // under this lock routinely outlives any fixed threshold (`dsh plugin` gets a 600 s
    // timeout) — so a live installer got declared dead, had its staging directory wiped from
    // underneath it (ERR_PNPM_DIRECTORY_FETCHER_IO), and then had its lock deleted by the
    // very process that took it over.
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, `alive-owner\n${process.pid}\n2000-01-01T00:00:00.000Z\n`);
    const old = new Date(Date.now() - 60 * 60 * 1000);
    fs.utimesSync(lockFile, old, old); // an hour old, far past staleMs
    const out = await withInstallLock(lockFile, ({ locked }) => locked, { timeoutMs: 300, staleMs: 1000 });
    assert.strictEqual(out, false, "a live owner must not be evicted");
    assert.ok(fs.existsSync(lockFile), "their lock must survive");
  });

  await check("does not delete a lock that was taken over while we held it", async () => {
    await withInstallLock(lockFile, async () => {
      // Someone took it over (their token is different) while we were working.
      fs.writeFileSync(lockFile, "someone-else\n12345\n2020-01-01T00:00:00.000Z\n");
    });
    assert.ok(fs.existsSync(lockFile), "releasing must not hand the critical section to a third process");
    assert.ok(fs.readFileSync(lockFile, "utf8").startsWith("someone-else"), "and must not touch their lock");
  });

  await check("proceeds (unlocked) instead of hanging when the lock never frees", async () => {
    fs.mkdirSync(path.dirname(lockFile), { recursive: true });
    fs.writeFileSync(lockFile, `another-instance\n${process.pid}\n2020-01-01T00:00:00.000Z\n`);
    const started = Date.now();
    const out = await withInstallLock(lockFile, ({ locked, waitedMs }) => ({ locked, waitedMs }), {
      timeoutMs: 400,
      staleMs: 600_000, // never stale, so only the timeout can end the wait
    });
    assert.strictEqual(out.locked, false, "we must be told we are unlocked");
    assert.ok(Date.now() - started < 3000, "and not wait forever");
    assert.ok(fs.existsSync(lockFile), "someone else's lock must be left alone");
  });

  await check("the lock file records the holder (diagnosable)", async () => {
    let inside = null;
    await withInstallLock(lockFile, async () => {
      inside = await readInstallLock(lockFile);
    });
    assert.ok(inside && inside.includes(String(process.pid)), `holder recorded, got: ${inside}`);
    assert.strictEqual(await readInstallLock(lockFile), null, "cleared after release");
  });

  await check("a throwing body still releases the lock", async () => {
    await assert.rejects(
      withInstallLock(lockFile, () => {
        throw new Error("boom");
      }),
      /boom/,
    );
    assert.strictEqual(fs.existsSync(lockFile), false, "a crash in the body must not leak the lock");
  });

  fs.rmSync(root, { recursive: true, force: true });
  console.log(failures === 0 ? "\ninstall-lock: all checks passed" : `\n${failures} FAILED`);
  if (failures > 0) process.exitCode = 1;
})();
