// download.mjs — shared download + hashing helpers for the build scripts that
// fetch large archives (bundle-node.mjs, ensure-electron.mjs).
//
// Why this exists: both scripts carried a byte-identical copy of these two
// functions, so every fix had to be applied twice — and neither copy had a
// timeout. Worse, ensure-electron accepts a download whenever the official
// SHASUMS256.txt is unavailable, and the hash it then compares against was
// computed from the file it just wrote: a **truncated** archive passed. The
// length check below is what catches that.
//
// Contract: `dest` is a scratch path (callers hash it and rename it into their
// cache). On failure the partial file is removed so a broken cache dir is not
// left behind.

import {createHash} from "node:crypto";
import {createReadStream, createWriteStream, rmSync, statSync} from "node:fs";
import {Readable} from "node:stream";
import {pipeline} from "node:stream/promises";

/** How long one archive download may take before it is aborted. */
export const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1000;

/** SHA-256 of a file, streamed (these archives are 50–200 MiB). */
export async function sha256Of(file) {
  return new Promise((resolvePromise, reject) => {
    const h = createHash("sha256");
    createReadStream(file)
      .on("error", reject)
      .on("data", (chunk) => h.update(chunk))
      .on("end", () => resolvePromise(h.digest("hex")));
  });
}

/**
 * Download `url` into `dest`.
 *
 * @param {string} url
 * @param {string} dest scratch file path (removed if the download fails)
 * @param {{timeoutMs?: number, log?: (message: string) => void}} [options]
 */
export async function download(url, dest, {timeoutMs = DOWNLOAD_TIMEOUT_MS, log = console.log} = {}) {
  log(`downloading ${url}`);
  try {
    const res = await fetch(url, {signal: AbortSignal.timeout(timeoutMs)});
    if (!res.ok) throw new Error(`download failed: HTTP ${res.status} (${url})`);
    if (res.body === null) throw new Error(`download failed: empty body (${url})`);
    const expected = Number(res.headers.get("content-length") ?? "0");
    await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
    // A short body is the failure the callers cannot see: their integrity check
    // hashes the bytes they just received, so it agrees with any truncation.
    if (Number.isFinite(expected) && expected > 0 && statSync(dest).size !== expected) {
      throw new Error(`download truncated: got ${statSync(dest).size} of ${expected} bytes (${url})`);
    }
  } catch (error) {
    try {
      rmSync(dest, {force: true});
    } catch {
      /* best-effort cleanup */
    }
    throw error;
  }
}
