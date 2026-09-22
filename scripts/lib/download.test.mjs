// download.test.mjs — offline tests for the shared download helper.
//
// Covers the three failure paths a build script actually hits: an HTTP error, a
// server that accepts the connection and never answers (the case that used to
// hang the whole packaging run), and a successful transfer. Run: node scripts/lib/download.test.mjs

import assert from "node:assert/strict";
import {createServer} from "node:http";
import {existsSync, mkdtempSync, readFileSync, rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {download, sha256Of} from "./download.mjs";

let passed = 0;
async function check(label, fn) {
  await fn();
  passed += 1;
  console.log("  ✓", label);
}

const dir = mkdtempSync(join(tmpdir(), "dsh-download-test-"));

/** Start a server, run `fn(baseUrl)`, always close the server again. */
async function withServer(handler, fn) {
  const server = createServer(handler);
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const {port} = server.address();
  try {
    return await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

console.log("download.mjs tests");

await check("a successful transfer lands the exact bytes", async () => {
  const body = "hello dsh\n";
  await withServer((req, res) => {
    res.writeHead(200, {"content-length": String(Buffer.byteLength(body))});
    res.end(body);
  }, async (base) => {
    const dest = join(dir, "ok.bin");
    await download(`${base}/ok`, dest, {log: () => {}});
    assert.equal(readFileSync(dest, "utf8"), body);
    assert.equal(await sha256Of(dest), (await import("node:crypto")).createHash("sha256").update(body).digest("hex"));
  });
});

await check("an HTTP error throws and leaves no partial file", async () => {
  await withServer((req, res) => {
    res.writeHead(404);
    res.end("nope");
  }, async (base) => {
    const dest = join(dir, "missing.bin");
    await assert.rejects(() => download(`${base}/missing`, dest, {log: () => {}}), /HTTP 404/u);
    assert.equal(existsSync(dest), false, "partial file must be removed");
  });
});

await check("a stalled server times out instead of hanging forever", async () => {
  // Accept the connection, never respond: without a timeout this never settles.
  await withServer((req, res) => {
    void res;
  }, async (base) => {
    const dest = join(dir, "stall.bin");
    const started = Date.now();
    await assert.rejects(() => download(`${base}/stall`, dest, {timeoutMs: 200, log: () => {}}));
    assert.ok(Date.now() - started < 5000, "must abort promptly");
    assert.equal(existsSync(dest), false, "partial file must be removed");
  });
});

rmSync(dir, {recursive: true, force: true});
console.log(`\nall ${passed} checks passed`);
