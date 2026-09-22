// Fetch the boot index following the token auth, then verify our plugin's
// client bundle is served WITH the exported `inject: ['sessions']`.
const { spawn } = require('child_process');

const [bin, home, pnpm, port] = process.argv.slice(2);
const env = { ...process.env, DSH_HOME: home, PATH: `${pnpm};${process.env.PATH}` };

async function authedFetch(base, pathWithQuery) {
  // Step 1: hit the token URL; the 303 Set-Cookie holds the auth cookie.
  const r0 = await fetch(base + pathWithQuery, { redirect: 'manual' });
  const setCookie = r0.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';')[0];
  // Step 2: request with the cookie (node fetch does not persist cookies).
  const r = await fetch(base + pathWithQuery, { headers: cookie ? { cookie } : {} });
  return r;
}

(async () => {
  const child = spawn('node', [bin, 'web', '--port', port, '--no-open'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  await new Promise((r) => setTimeout(r, 25_000));
  const tokMatch = out.match(/token=(\S+)/);
  if (!tokMatch) { console.log('NO TOKEN'); child.kill(); process.exit(1); }
  const token = tokMatch[1];
  const base = `http://127.0.0.1:${port}`;

  const idxRes = await authedFetch(base, `/?token=${token}`);
  const idx = await idxRes.text();
  console.log('index status:', idxRes.status, 'bytes:', idx.length);

  const urls = [...idx.matchAll(/\/plugins\/\?\?[^"'\s<]+/g)].map((mm) => mm[0].replace(/&amp;/g, '&'));
  const withOurs = urls.filter((u) => u.includes('dsh-gui-last-session'));
  console.log('combo URLs:', urls.length, '| containing ours:', withOurs.length);
  if (withOurs.length === 0) { child.kill(); process.exit(1); }

  const bundleRes = await authedFetch(base, withOurs[0]);
  const bundle = await bundleRes.text();
  console.log('combo status:', bundleRes.status, 'bytes:', bundle.length);

  const checks = {
    'registrationId': /load\(\{\s*id:\s*'dsh-gui-last-session'/.test(bundle),
    'injectConst': bundle.includes("const inject = ['sessions']"),
    'applyFn': /\bfunction apply\(ctx\)/.test(bundle),
    'openWhenReady': bundle.includes('openWhenReady'),
    'POINTER_PATH': bundle.includes("'/gui-last-session'"),
  };
  let allOk = true;
  for (const [k, v] of Object.entries(checks)) {
    console.log(`  ${k.padEnd(14)}: ${v ? 'PASS' : 'FAIL'}`);
    if (!v) allOk = false;
  }
  child.kill();
  console.log(allOk ? '\nSERVED BUNDLE OK (inject [sessions] present)' : '\nSERVED BUNDLE CHECK FAILED');
  process.exit(allOk ? 0 : 1);
})();