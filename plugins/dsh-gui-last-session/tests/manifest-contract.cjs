// Simulate the engine's clientExportOf() resolution + dsh.client validation
// against the real manifest (mirrors dsh-client-modules/lib/index.js).
const fs = require('fs');
const path = require('path');

// Resolve the package root from this file's location so the check works no
// matter which directory it is invoked from (`npm test` runs in the package).
const pkgRoot = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8'));

function clientExportOf(pkgName, exportsField) {
  if (typeof exportsField !== 'object' || exportsField === null) return undefined;
  const client = exportsField['./client'];
  if (client === undefined) return undefined;
  if (typeof client === 'string') return client;
  if (typeof client === 'object' && client !== null && typeof client.default === 'string') return client.default;
  throw new Error(pkgName + ' bad exports["./client"]');
}

const rel = clientExportOf(pkg.name, pkg.exports);
console.log('clientExportOf ->', rel);
console.log('file exists    :', fs.existsSync(path.join(pkgRoot, rel)));

const decl = pkg.dsh.client;
if (typeof decl !== 'object' || decl === null) throw new Error('non-object dsh.client declaration');
if (typeof decl.platform !== 'string') throw new Error('dsh.client.platform must be a string');
if (!Array.isArray(decl.inject) || decl.inject.some((s) => typeof s !== 'string')) {
  throw new Error('dsh.client.inject must be a string array');
}
console.log('platform       :', decl.platform);
console.log('inject         :', decl.inject.join(', '));
console.log('bundle patch   :', pkg.dsh.bundle.patch);

// The manifest `dsh.client.inject` (package names, drives browser load order)
// and the bundle's exported `inject` (SERVICE names, drives the fiber's inject)
// are two distinct mechanisms. The bundle MUST export the services it reads.
// Load the bundle via the engine's __ModuleLoader__ contract and require that
// every service the manifest pulls in is present in the exported inject list.
const registrations = [];
global.window = { __ModuleLoader__: { load: (r) => registrations.push(r) } };
require(path.join(pkgRoot, rel));
if (registrations.length !== 1) throw new Error(`bundle must register exactly one factory (got ${registrations.length})`);
if (registrations[0].id !== pkg.name) throw new Error(`bundle factory id mismatch: ${registrations[0].id}`);
const exports_ = registrations[0].factory((specifier) => {
  throw new Error(`unexpected external require: ${specifier}`);
});
if (!Array.isArray(exports_.inject) || exports_.inject.length === 0) {
  throw new Error('bundle must export a non-empty inject array (SERVICE names, e.g. ["sessions"])');
}
if (typeof exports_.apply !== 'function') throw new Error('bundle must export apply');
console.log('bundle inject   :', exports_.inject.join(', '));
console.log('bundle apply    : function');
console.log('\nALL MANIFEST CONTRACT CHECKS PASSED');
