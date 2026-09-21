# smoke-profile-watch.ps1 - E2E test: settings window <-> plugin market live sync.
#
# The settings window and the in-engine plugin market (dshmarket) both mutate
# the SAME file <DSH_HOME>/profiles/web/package.json (`dsh.profile.bundles`).
# The GUI watches that file and rebroadcasts the plugin state: each settings
# checkbox MIRRORS the real install state (installed -> checked, not installed
# -> unchecked), so disabling/uninstalling a plugin in the market must uncheck
# it live, and re-enabling/installing must check it again (no persisted
# checkbox state anymore).
#
# This script starts the shell against an ISOLATED userData + home (copied from
# the live install so the engine and all four catalog plugins are in place),
# opens the settings window, then rewrites the profile manifest exactly like the
# market does on disable (removes a package from dsh.profile.bundles) and
# re-enables it again. Ground truth is the main-process log line
# "plugin state changed outside the GUI (<source>): <fingerprint-json>" - the
# fingerprint is exactly what the checkboxes are rendered from. (The source is
# the watched file that changed: package.json / cordis.patch.yml / market state.)
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads a no-BOM UTF-8
# .ps1 as ANSI, and non-ASCII bytes can break parsing (see smoke-modal.ps1).
#
# Usage: powershell -File scripts/smoke-profile-watch.ps1

$ErrorActionPreference = "Stop"

$root = "D:\AI\WorkBook\DeepSeekHarnessGUI"
$liveUd = "C:\Users\31352\AppData\Roaming\DSH GUI"

$ud = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-profw-ud-" + [guid]::NewGuid().ToString("N"))
$homeDir = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-profw-home-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $ud | Out-Null
New-Item -ItemType Directory -Path $homeDir | Out-Null
$log = Join-Path $env:TEMP ("dsh-profw-" + [guid]::NewGuid().ToString("N") + ".log")
$errLog = $log + ".err"
$flipFile = Join-Path $env:TEMP ("dsh-profw-flip-" + [guid]::NewGuid().ToString("N") + ".cjs")
$p = $null

function Copy-Tree($src, $dst, [string[]]$Exclude = @()) {
  # The LIVE app may be running while this smoke test copies its home, which
  # locks some transient dirs -> robocopy reports exit 8+. Those entries are not
  # needed here; hard-fail only if a path we do care about is missing afterwards
  # (checked by the caller).
  #
  # $Exclude carries the engine-managed module-fallback roots. Their entries are
  # symlinks/proxies, and robocopy copies them as REAL directories, which makes
  # the isolated dsh refuse to boot ("exists and is not a symlink or
  # dsh-managed module proxy"). The engine re-creates these roots itself. The
  # plugin directory that matters, <home>/profiles/web/node_modules, is
  # deliberately NOT excluded.
  #   <home>/profiles/node_modules               (profiles-wide fallback)
  #   <home>/profiles/web/.dsh-module-fallback   (web-profile fallback)
  $roboLog = Join-Path $env:TEMP ("dsh-profw-robo-" + [guid]::NewGuid().ToString("N") + ".log")
  $rcArgs = @($src, $dst, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/R:1", "/W:1", "/LOG:$roboLog")
  if ($Exclude.Count -gt 0) {
    $rcArgs += "/XD"
    $rcArgs += $Exclude
  }
  robocopy @rcArgs | Out-Null
  $code = $LASTEXITCODE
  if ($code -ge 8) {
    Write-Host "WARN: robocopy exit $code (live app may hold locks); continuing"
    Get-Content $roboLog -ErrorAction SilentlyContinue |
      Select-String "ERROR" | Select-Object -First 5 | ForEach-Object { Write-Host ("  " + $_.Line) }
  }
  Remove-Item $roboLog -Force -ErrorAction SilentlyContinue
}

function Assert-Paths($paths) {
  foreach ($pth in $paths) {
    if (-not (Test-Path $pth)) { throw "isolated copy is missing a required path: $pth" }
  }
}

function Stop-App {
  if ($p -and (Get-Process -Id $p.Id -ErrorAction SilentlyContinue)) {
    # cmd /c swallows taskkill's stderr so PS 5.1's $ErrorActionPreference=Stop
    # does not turn a "process already gone" message into a termination.
    $null = cmd /c "taskkill /PID $($p.Id) /T /F >nul 2>&1"
  }
}

function Wait-Log($pattern, $timeoutSec, $errMsg) {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
    if (Test-Path $log) {
      $c = Get-Content $log -Raw -ErrorAction SilentlyContinue
      if ($c -match $pattern) { return $true }
    }
    if (-not (Get-Process -Id $p.Id -ErrorAction SilentlyContinue)) {
      Dump-Log
      throw "app exited early while waiting for: $errMsg"
    }
  }
  Dump-Log
  throw "timeout waiting for: $errMsg (pattern=$pattern)"
}

function Dump-Log {
  Write-Host "----- app log (tail) -----"
  Get-Content $log -Tail 40 -ErrorAction SilentlyContinue
  Write-Host "----- app stderr (tail) -----"
  Get-Content $errLog -Tail 20 -ErrorAction SilentlyContinue
}

$flip = @'
const fs = require("fs");
const p = process.argv[2];   // manifest path
const mode = process.argv[3]; // "rm" | "add"
const m = JSON.parse(fs.readFileSync(p, "utf8"));
const b = m.dsh && m.dsh.profile && m.dsh.profile.bundles;
if (!Array.isArray(b)) { console.error("no dsh.profile.bundles"); process.exit(2); }
const i = b.indexOf("dsh-model-surplus");
if (mode === "rm" && i >= 0) b.splice(i, 1);
if (mode === "add" && i < 0) b.push("dsh-model-surplus");
fs.writeFileSync(p, JSON.stringify(m, null, 2));
console.log("flip " + mode + " -> bundles: " + JSON.stringify(b));
'@
[System.IO.File]::WriteAllText($flipFile, $flip, [System.Text.UTF8Encoding]::new($false))

# CDP driver: drives the REAL settings-window checkbox (click -> IPC ->
# immediate install/uninstall) through Chrome DevTools Protocol.
$driverFile = Join-Path $env:TEMP ("dsh-profw-driver-" + [guid]::NewGuid().ToString("N") + ".cjs")
$driver = @'
(async () => {
const port = Number(process.argv[2]);
const id = process.argv[3];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function findTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch("http://127.0.0.1:" + port + "/json");
      if (res.ok) {
        const targets = await res.json();
        const t = targets.find((x) => x.type === "page" && String(x.url).includes("settings.html"));
        if (t) return t;
      }
    } catch (_) { /* app not up yet */ }
    await wait(500);
  }
  throw new Error("settings window target not found");
}

const target = await findTarget();
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener("open", resolve, { once: true });
  ws.addEventListener("error", () => reject(new Error("ws error")), { once: true });
});
let nextId = 1;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const msg = JSON.parse(String(ev.data));
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
});
function rpc(method, params) {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("rpc timeout: " + method)); }, 30000);
    pending.set(id, (msg) => { clearTimeout(timer); if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result); });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const r = await rpc("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error("evaluate failed: " + JSON.stringify(r.exceptionDetails));
  return r.result.value;
}
const sel = '.plg-check[data-id="' + id + '"]';
const stateExpr = `(() => { const b = document.querySelector('${sel}'); return b ? { checked: b.checked, disabled: b.disabled } : null; })()`;
const clickExpr = `(() => { const b = document.querySelector('${sel}'); if (!b || b.disabled) return false; b.click(); return true; })()`;

async function waitState(expected, timeoutMs, desc) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const s = await evaluate(stateExpr);
    if (s && !s.disabled && s.checked === expected) return;
    await wait(400);
  }
  throw new Error("timeout: " + desc + " (last=" + JSON.stringify(await evaluate(stateExpr)) + ")");
}

// The install/uninstall progress banner must appear while the op runs and
// hide when it finishes (the whole point of this feature: visible progress).
const progressVisibleExpr =
  "(() => { const el = document.getElementById('pluginProgress'); return el ? !el.hidden : false; })()";
async function waitProgressVisible(timeoutMs, desc) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(progressVisibleExpr)) return;
    await wait(100);
  }
  throw new Error("timeout: " + desc + " (progress banner never appeared)");
}
async function progressHidden() {
  return await evaluate(
    "(() => { const el = document.getElementById('pluginProgress'); return el ? el.hidden : true; })()",
  );
}

const initial = await evaluate(stateExpr);
console.log("driver: initial =", JSON.stringify(initial));
if (!initial || initial.disabled) throw new Error("plugin checkbox missing/disabled initially");
// The market re-enable broadcast (STEP3) may still be in flight -> poll.
await waitState(true, 60000, "initial: plugin should be installed/checked");

console.log("driver: clicking to uninstall...");
if (!(await evaluate(clickExpr))) throw new Error("checkbox not clickable for uninstall");
await waitProgressVisible(5000, "uninstall: progress banner should appear");
await waitState(false, 150000, "uninstall: checkbox never turned off");
if (!(await progressHidden())) throw new Error("uninstall: progress banner should be hidden after done");
console.log("driver: uninstall OK, checkbox unchecked, banner hidden");

console.log("driver: clicking to reinstall...");
if (!(await evaluate(clickExpr))) throw new Error("checkbox not clickable for reinstall");
await waitProgressVisible(5000, "reinstall: progress banner should appear");
await waitState(true, 180000, "reinstall: checkbox never turned on");
if (!(await progressHidden())) throw new Error("reinstall: progress banner should be hidden after done");
console.log("driver: reinstall OK, checkbox checked, banner hidden");

ws.close();
console.log("CDP-STEP PASS");
})().catch((e) => { console.error("DRIVER FAIL: " + (e && e.stack || e)); process.exit(1); });
'@
[System.IO.File]::WriteAllText($driverFile, $driver, [System.Text.UTF8Encoding]::new($false))

try {
  Write-Host "copying engine into isolated userData..."
  Copy-Tree (Join-Path $liveUd "dsh-engine") (Join-Path $ud "dsh-engine")
  Write-Host "copying live home (profile + plugins) into isolated home..."
  Copy-Tree (Join-Path $liveUd "dsh-home") $homeDir -Exclude @(
    (Join-Path $liveUd "dsh-home\profiles\node_modules"),
    (Join-Path $homeDir "profiles\node_modules"),
    (Join-Path $liveUd "dsh-home\profiles\web\.dsh-module-fallback"),
    (Join-Path $homeDir "profiles\web\.dsh-module-fallback")
  )

  # The smoke run needs exactly these: the engine, the web profile manifest,
  # and the catalog packages resolved inside profiles/web/node_modules.
  Assert-Paths @(
    (Join-Path $ud "dsh-engine\node_modules\@deepseek-ai\dsh\package.json"),
    (Join-Path $homeDir "profiles\web\package.json"),
    (Join-Path $homeDir "profiles\web\node_modules\dshmarket\package.json"),
    (Join-Path $homeDir "profiles\web\node_modules\dsh-gui-last-session\package.json"),
    # Renamed chain: dsh-opencode-go-session + dsh-opencode-go-api merged into
    # dsh-opencode-go, which v0.5.0 split out to npm as dsh-opencode-go-path
    # (the npm name dsh-opencode-go was already taken by another author).
    (Join-Path $homeDir "profiles\web\node_modules\dsh-opencode-go-path\package.json")
  )
  Write-Host "isolated copy verified"

  # Seed a PRE-RENAME install deterministically instead of depending on whatever
  # the live home happens to hold (it may already have migrated). The GUI's boot
  # migration must replace it with dsh-model-surplus, which is the plugin this test
  # then flips in and out of the profile manifest.
  $seedFile = Join-Path $env:TEMP ("dsh-profw-seed-" + [guid]::NewGuid().ToString("N") + ".cjs")
  $seed = @'
const fs = require("fs");
const path = require("path");
const home = process.argv[2];
const oldPkg = process.argv[3];
const profile = path.join(home, "profiles", "web");
const oldDir = path.join(profile, "node_modules", oldPkg);
fs.mkdirSync(oldDir, { recursive: true });
fs.writeFileSync(path.join(oldDir, "package.json"), JSON.stringify({
  name: oldPkg,
  version: "0.1.0",
  dsh: { bundle: { patch: "./cordis.patch.yml" } },
}, null, 2));
fs.writeFileSync(path.join(oldDir, "cordis.patch.yml"), [
  "- insert:",
  "    - id: opencode-go-usage",
  `      name: ${oldPkg}`,
  "",
].join("\n"));
const manifestPath = path.join(profile, "package.json");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
manifest.dsh = manifest.dsh || {};
manifest.dsh.profile = manifest.dsh.profile || {};
const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : [];
if (!bundles.includes(oldPkg)) bundles.push(oldPkg);
manifest.dsh.profile.bundles = bundles;
manifest.dependencies = manifest.dependencies || {};
manifest.dependencies[oldPkg] = "file:" + oldDir.replace(/\\/g, "/");
fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
console.log("seeded pre-rename install:", oldPkg);
'@
  [System.IO.File]::WriteAllText($seedFile, $seed, [System.Text.UTF8Encoding]::new($false))
  & node $seedFile $homeDir "dsh-opencode-go-usage"
  if ($LASTEXITCODE -ne 0) { throw "seed failed (exit $LASTEXITCODE)" }

  $profileManifest = Join-Path $homeDir "profiles\web\package.json"
  function Get-Bundles {
    try {
      $m = Get-Content $profileManifest -Raw -ErrorAction Stop | ConvertFrom-Json
      return @($m.dsh.profile.bundles)
    } catch {
      return @()
    }
  }

  # robocopy copies the engine-managed module-fallback entry
  # (profiles/node_modules/@deepseek-ai/dsh) as a REAL directory instead of the
  # symlink/proxy dsh expects, so the isolated dsh refuses to boot ("exists and
  # is not a symlink or dsh-managed module proxy"). That crash used to be
  # tolerated, but the GUI's startup-failure recovery then removes the
  # freshly-installed plugin and this test's reinstall assertion loses its
  # ground truth. Drop the entry and let the engine re-create it itself.
  $staleFallback = Join-Path $homeDir "profiles\node_modules\@deepseek-ai\dsh"
  if (Test-Path $staleFallback) {
    Remove-Item $staleFallback -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "removed stale module-fallback entry so the engine can re-create it"
  }

  # Production-like settings: app-dir mode (overridden by DSH_SHELL_HOME), no
  # update checks. The plugin set is NOT persisted in settings anymore - the
  # checkboxes mirror the real install state, which comes from the profile.
  $json = @{
    updatePolicy       = "ask"
    dshHomeMode        = "app"
    updateCheckEnabled = $false
    closeAction        = "quit"
  } | ConvertTo-Json -Depth 4
  [System.IO.File]::WriteAllText((Join-Path $ud "settings.json"), $json, [System.Text.UTF8Encoding]::new($false))

  $env:DSH_SHELL_USERDATA = $ud
  $env:DSH_SHELL_HOME = $homeDir
  $env:DSH_SHELL_TEST_OPEN_SETTINGS = "1"
  Remove-Item Env:DSH_SHELL_AUTOQUIT_MS -ErrorAction SilentlyContinue
  Remove-Item Env:DSH_SHELL_TEST_NOTICE -ErrorAction SilentlyContinue
  Remove-Item Env:DSH_SHELL_TEST_LATEST -ErrorAction SilentlyContinue
  Remove-Item Env:DSH_SHELL_REGISTRY_URL -ErrorAction SilentlyContinue

  # Chrome DevTools Protocol port for driving the settings-window checkbox
  # (STEP4). Random high port to avoid clashing with a live app.
  $dbgPort = 9400 + (Get-Random -Maximum 600)
  $p = Start-Process -FilePath "npm.cmd" `
    -ArgumentList @("start", "--", "--remote-debugging-port=$dbgPort") `
    -WorkingDirectory $root `
    -RedirectStandardOutput $log -RedirectStandardError $errLog -PassThru -WindowStyle Hidden

  $manifest = Join-Path $homeDir "profiles\web\package.json"

  function Flip-Manifest($mode) {
    & node $flipFile $manifest $mode
    if ($LASTEXITCODE -ne 0) { throw "manifest flip failed (mode=$mode)" }
  }

  Wait-Log "settings modal open" 120 "settings window never opened"
  Write-Host "STEP1 PASS: settings window open"

  # The boot migration must have swapped the pre-rename package for the new one
  # before anything below can toggle it. Installing runs pnpm, so poll.
  $deadline0 = (Get-Date).AddSeconds(300)
  $migrated = $false
  while ((Get-Date) -lt $deadline0) {
    $b = Get-Bundles
    if (($b -contains "dsh-model-surplus") -and ($b -notcontains "dsh-opencode-go-usage")) { $migrated = $true; break }
    if (-not (Get-Process -Id $p.Id -ErrorAction SilentlyContinue)) { break }
    Start-Sleep -Milliseconds 500
  }
  if (-not $migrated) {
    Dump-Log
    throw "the rename migration never converged on dsh-model-surplus: $((Get-Bundles) -join ',')"
  }
  Write-Host "STEP1b PASS: rename migration installed dsh-model-surplus"

  # Let boot reconciliation settle, then simulate market disable. The watcher
  # logs the new fingerprint JSON; the checkbox mirror renders from it, so
  # "dsh-model-surplus" with installed:false proves the checkbox unchecks.
  Start-Sleep -Seconds 2
  Flip-Manifest "rm"
  Wait-Log "plugin state changed outside the GUI.*dsh-model-surplus.*installed.:false" 30 "market disable not detected"
  Write-Host "STEP2 PASS: market disable detected, checkbox state now unchecked"

  # Simulate market re-enable: state restored, checkbox back to checked. Wait
  # for a change line that appears AFTER the flip (the engine/other actors may
  # also rewrite the manifest during boot, so "any second line" is not enough).
  $baseCount = @(Get-Content $log -ErrorAction SilentlyContinue | Select-String "plugin state changed outside the GUI").Count
  Flip-Manifest "add"
  $deadline = (Get-Date).AddSeconds(30)
  $seen = $false
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
    $lines = @(Get-Content $log -ErrorAction SilentlyContinue | Select-String "plugin state changed outside the GUI")
    if ($lines.Count -gt $baseCount) { $seen = $true; break }
    if (-not (Get-Process -Id $p.Id -ErrorAction SilentlyContinue)) { throw "app exited early during re-enable step" }
  }
  if (-not $seen) { Dump-Log; throw "re-enable didn't produce a new plugin-state change" }
  $lastLine = ($lines[-1]).Line
  if ($lastLine -notmatch "dsh-model-surplus.*installed.:true") {
    Dump-Log
    throw "re-enable didn't restore installed state: $lastLine"
  }
  Write-Host "STEP3 PASS: market re-enable detected, checkbox state back to checked"

  # STEP4: drive the REAL GUI checkbox over CDP. Clicking unchecks -> the change
  # listener runs plugins:remove (immediate uninstall); clicking again runs
  # plugins:install (immediate reinstall). The driver also asserts the progress
  # banner appears while each operation runs and hides when it finishes.
  $beforeClicks = @(Get-Content $log -ErrorAction SilentlyContinue | Select-String "plugin state changed outside the GUI").Count
  Write-Host "STEP4: driving settings-window checkbox via CDP (uninstall -> reinstall, with progress)..."
  & node $driverFile $dbgPort "dsh-model-surplus"
  if ($LASTEXITCODE -ne 0) { Dump-Log; throw "CDP checkbox drive failed (exit $LASTEXITCODE)" }
  Write-Host "STEP4 PASS: checkbox click -> immediate uninstall/reinstall (+ progress banner)"

  # STEP4b: prove the checkbox clicks really changed the profile: two NEW
  # watcher lines (installed:false then installed:true), the last one true.
  $deadline4 = (Get-Date).AddSeconds(15)
  $afterClicks = $null
  while ((Get-Date) -lt $deadline4) {
    $afterClicks = @(Get-Content $log -ErrorAction SilentlyContinue | Select-String "plugin state changed outside the GUI")
    if ($afterClicks.Count -ge ($beforeClicks + 2)) { break }
    Start-Sleep -Milliseconds 250
  }
  if (-not $afterClicks -or $afterClicks.Count -lt ($beforeClicks + 2)) {
    Dump-Log
    throw "checkbox clicks didn't produce two profile changes (before=$beforeClicks after=$($afterClicks.Count))"
  }
  if ($afterClicks[-1].Line -notmatch "dsh-model-surplus.*installed.:true") {
    Dump-Log
    throw "after reinstall the profile should list the plugin as installed: $($afterClicks[-1].Line)"
  }
  Write-Host "STEP4b PASS: profile manifest reflects both checkbox toggles"

  Write-Host "ALL PASS"
} finally {
  Stop-App
  Start-Sleep -Milliseconds 500
  Remove-Item $ud -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $homeDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $log, $errLog, $flipFile, $driverFile, $seedFile -Force -ErrorAction SilentlyContinue
}