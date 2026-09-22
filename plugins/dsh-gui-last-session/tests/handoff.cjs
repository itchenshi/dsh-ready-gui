// Verify the GUI -> plugin pointer hand-off semantics, extracted verbatim from
// src/main.js handOffLastSessionToPlugin() so the real logic is exercised.
const fs = require('fs');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');

async function handOff({ homePath, userDataPath, log = () => {} }) {
  const pluginFile = path.join(homePath, 'last-session.json');
  const guiFile = path.join(userDataPath, 'last-session.json');
  let pluginPointer = null;
  try {
    const parsed = JSON.parse(await fsp.readFile(pluginFile, 'utf8'));
    if (typeof parsed?.sessionId === 'string' && parsed.sessionId.startsWith('session-')) pluginPointer = parsed;
  } catch {}
  if (pluginPointer) return 'plugin-already-has-pointer';
  let guiPointer = null;
  try {
    const parsed = JSON.parse(await fsp.readFile(guiFile, 'utf8'));
    if (typeof parsed?.sessionId === 'string' && parsed.sessionId.startsWith('session-')) guiPointer = parsed;
  } catch {}
  if (!guiPointer) return 'nothing-to-hand-over';
  await fsp.mkdir(path.dirname(pluginFile), { recursive: true });
  await fsp.writeFile(
    pluginFile,
    JSON.stringify({ sessionId: guiPointer.sessionId, updatedAt: guiPointer.updatedAt ?? Date.now() }),
    'utf8',
  );
  log('handed over:', guiPointer.sessionId);
  return 'handed-over';
}

async function scenario(name, setup) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'home-'));
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'ud-'));
  try {
    setup(home, ud);
    const result = await handOff({ homePath: home, userDataPath: ud });
    const pluginFile = path.join(home, 'last-session.json');
    const content = fs.existsSync(pluginFile) ? JSON.parse(fs.readFileSync(pluginFile, 'utf8')) : null;
    console.log(`  ${name}: ${result} -> ${JSON.stringify(content)}`);
    return { result, content };
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(ud, { recursive: true, force: true });
  }
}

(async () => {
  console.log('hand-off scenarios:');

  const a = await scenario('GUI has pointer, plugin empty', (home, ud) => {
    fs.writeFileSync(path.join(ud, 'last-session.json'), JSON.stringify({ sessionId: 'session-gui1234', updatedAt: 111 }));
  });
  console.assert(a.result === 'handed-over' && a.content.sessionId === 'session-gui1234', 'A failed');

  // The important one: a FRESH plugin pointer must NOT be overwritten by a
  // stale GUI pointer.
  const b = await scenario('plugin has NEWER pointer', (home, ud) => {
    fs.writeFileSync(path.join(home, 'last-session.json'), JSON.stringify({ sessionId: 'session-plugin99', updatedAt: 999 }));
    fs.writeFileSync(path.join(ud, 'last-session.json'), JSON.stringify({ sessionId: 'session-gui1234', updatedAt: 111 }));
  });
  console.assert(b.result === 'plugin-already-has-pointer' && b.content.sessionId === 'session-plugin99', 'B failed');

  const c = await scenario('both empty', () => {});
  console.assert(c.result === 'nothing-to-hand-over' && c.content === null, 'C failed');

  const d = await scenario('GUI pointer corrupt', (home, ud) => {
    fs.writeFileSync(path.join(ud, 'last-session.json'), '{broken');
  });
  console.assert(d.result === 'nothing-to-hand-over', 'D failed');

  const e = await scenario('GUI pointer invalid id', (home, ud) => {
    fs.writeFileSync(path.join(ud, 'last-session.json'), JSON.stringify({ sessionId: 'not-a-session' }));
  });
  console.assert(e.result === 'nothing-to-hand-over', 'E failed');

  const f = await scenario('plugin pointer corrupt, GUI valid', (home, ud) => {
    fs.writeFileSync(path.join(home, 'last-session.json'), '{broken');
    fs.writeFileSync(path.join(ud, 'last-session.json'), JSON.stringify({ sessionId: 'session-recover1' }));
  });
  console.assert(f.result === 'handed-over' && f.content.sessionId === 'session-recover1', 'F failed');

  const ok = a.content.sessionId === 'session-gui1234' &&
    b.content.sessionId === 'session-plugin99' &&
    c.content === null && d.result === 'nothing-to-hand-over' &&
    e.result === 'nothing-to-hand-over' && f.content.sessionId === 'session-recover1';
  console.log(ok ? '\nHAND-OFF SEMANTICS OK' : '\nHAND-OFF SEMANTICS FAILED');
  process.exitCode = ok ? 0 : 1;
})();
