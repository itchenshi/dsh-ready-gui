// End-to-end: with dsh-model-usage installed, verify the engine boots, the
// usage/balance route returns real data, the client bundle loads, and the
// widget renders in the header next to the title.
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const [bin, home, pnpm, port, cdpPort] = process.argv.slice(2);
const env = { ...process.env, DSH_HOME: home, PATH: `${pnpm};${process.env.PATH}` };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdp(ws, method, params = {}) {
  const id = Math.floor(Math.random() * 1e9);
  return new Promise((resolve, reject) => {
    const onMsg = (ev) => {
      let msg;
      try { msg = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }
      if (msg.id !== id) return;
      ws.removeEventListener('message', onMsg);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { ws.removeEventListener('message', onMsg); reject(new Error(`timeout ${method}`)); }, 30_000);
  });
}

(async () => {
  const eng = spawn('node', [bin, 'web', '--port', port, '--no-open'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let eout = '';
  eng.stdout.on('data', (d) => { eout += d; });
  eng.stderr.on('data', (d) => { eout += d; });
  await sleep(25_000);
  const tok = (eout.match(/token=(\S+)/) ?? [])[1];
  if (!tok) { console.log('NO TOKEN', eout.slice(-800)); eng.kill(); process.exit(1); }
  const base = `http://127.0.0.1:${port}`;
  const url = `${base}/?token=${tok}`;

  // 1) Host route: both sections report their own outcome.
  const r0 = await fetch(`${base}/?token=${tok}`, { redirect: 'manual' });
  const cookie = (r0.headers.get('set-cookie') ?? '').split(';')[0];
  const usageRes = await fetch(`${base}/model-usage`, { headers: { cookie } });
  const payload = await usageRes.json();
  console.log('=== GET /model-usage ===');
  console.log('  status:', usageRes.status, 'ok:', payload.ok);
  console.log('  sections:', JSON.stringify(payload.sections));
  console.log('  opencodeGo:', payload.opencodeGo?.ok, payload.opencodeGo?.reason ?? '-', JSON.stringify(payload.opencodeGo?.usage));
  console.log('  deepseek  :', payload.deepseek?.ok, payload.deepseek?.reason ?? '-', JSON.stringify(payload.deepseek?.balance));

  // 2) Browser: exceptions + widget presence + header innerHTML.
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mu-e2e-'));
  const browser = spawn('C:/Program Files/Google/Chrome/Application/chrome.exe', [
    '--headless=new', `--remote-debugging-port=${cdpPort}`, `--user-data-dir=${profile}`,
    '--no-first-run', '--no-default-browser-check', '--disable-gpu', 'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  await sleep(4000);
  const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json/list`)).json();
  const page = targets.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  const exceptions = [];
  ws.addEventListener('message', (ev) => {
    let m;
    try { m = JSON.parse(typeof ev.data === 'string' ? ev.data : ev.data.toString()); } catch { return; }
    if (m.method === 'Runtime.exceptionThrown') {
      exceptions.push(String(m.params.exceptionDetails.exception?.description ?? m.params.exceptionDetails.text));
    }
  });
  await cdp(ws, 'Runtime.enable');
  await cdp(ws, 'Page.enable');
  await cdp(ws, 'Page.navigate', { url });
  await sleep(30_000);

  const dom = await cdp(ws, 'Runtime.evaluate', {
    expression: `(() => {
      const el = document.querySelector('.model-usage');
      const header = document.querySelector('header');
      return JSON.stringify({
        widgetFound: !!el,
        widgetText: el ? el.innerText : null,
        widgetTitle: el ? (el.getAttribute('title') || '').slice(0, 160) : null,
        headerHasOpenCodeGo: header ? header.innerText.includes('OpenCode Go') : false,
        headerHasDeepSeek: header ? header.innerText.includes('DeepSeek') : false,
        // Where is it relative to the title? Everything before it is the title cluster.
        headerInner: header ? header.innerText.slice(0, 200) : null,
      });
    })()`,
    returnByValue: true,
  });
  console.log('\n=== PAGE ===');
  console.log(dom.result.value);
  console.log('\nexceptions:', exceptions.length);
  for (const e of exceptions.slice(0, 3)) console.log('  ' + e.split('\n')[0].slice(0, 200));

  try { ws.close(); } catch {}
  browser.kill(); eng.kill();

  // The pass criterion must be able to FAIL. `payload.ok` alone is useless: the route
  // hardcodes it, so this e2e used to exit 0 even when both halves reported
  // no-key/unauthorized/network — exactly the state a broken (or unauthenticated)
  // route leaves behind. The cookie above is no longer decorative either: the route
  // is behind the engine's trust fence, so an unauthenticated request is a 401.
  const problems = [];
  if (usageRes.status !== 200) problems.push(`route answered ${usageRes.status}`);
  if (payload.ok !== true) problems.push('payload.ok is not true');
  const sections = payload.sections ?? {};
  if (!sections['opencode-go'] || !sections.deepseek) problems.push('payload is missing a section');
  // The built-in limit table must always be served, even when the network half fails.
  if (Object.keys(payload.limits ?? {}).length === 0) problems.push('empty limits map (built-in table missing)');
  if (typeof payload.limitsMeta?.source !== 'string') problems.push('missing limitsMeta.source');
  for (const [key, value] of Object.entries(sections)) {
    if (value?.ok === true) continue; // real upstream data
    if (value?.reason === 'no-key') continue; // expected when no credential is configured
    problems.push(`section ${key} failed: ${value?.reason ?? 'no reason given'}`);
  }

  console.log('\nproblems:', problems.length);
  for (const p of problems) console.log('  ✗ ' + p);
  if (exceptions.length > 0) console.log('  ✗ ' + exceptions.length + ' browser exception(s)');
  const failures = problems.length + exceptions.length;
  console.log(failures === 0 ? '\nE2E PASS' : '\nE2E FAILED');
  process.exit(failures === 0 ? 0 : 1);
})();
