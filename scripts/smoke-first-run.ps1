# smoke-first-run.ps1 - E2E test: first-run detection + one-click enable of the
# bundled plugins.
#
# Why this exists: the bundled plugins ship DISABLED by default (plugin-manager.js:
# "unchecked means never installed"). So "download, unzip, open" used to leave all
# four fixes inert, and the checkboxes that would enable them live in a settings
# window a first-time user has no reason to open. This feature closes that gap:
# on first run the app detects the gap itself and offers one click that installs
# everything and restarts the engine once.
#
# What this test asserts, end to end:
#   1. a fresh profile with none of the bundled plugins installed, and no recorded
#      decision -> on engine ready the app (a) logs the offer and (b) opens the
#      settings window itself with the first-run card visible;
#   2. clicking "Enable all" IN THE REAL SETTINGS WINDOW (CDP) installs every
#      missing bundled plugin through the same path the checkboxes use;
#   3. the app restarts the engine once (installing changes the bundle list, which
#      the engine composes only at boot) and records firstRunOfferDone=true;
#   4. the NEXT launch does NOT offer again (the card and the auto-open are gone);
#   5. and the OTHER answer works too: with the decision cleared, the card comes
#      back, "pick manually" records the decision WITHOUT installing or uninstalling
#      anything (three plugins stay installed, the fourth stays out).
#
# Ground truth: the profile manifest on disk (dsh.profile.bundles + dependencies),
# settings.json, and the app's own log lines - not our own helper functions.
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads a no-BOM UTF-8
# .ps1 as ANSI, and non-ASCII bytes can break parsing (see smoke-modal.ps1).
#
# Usage: powershell -File scripts/smoke-first-run.ps1

$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
# The live install is a READ-ONLY source here: the engine and pnpm tools are copied into a
# temp userData, and settings.json is only ever written to that copy. $env:APPDATA instead
# of a hard-coded user name, so this runs on any machine / any account.
$liveUd = Join-Path $env:APPDATA "DSH Ready GUI"

$PLUGINS = @("dsh-gui-last-session", "dsh-model-surplus", "dsh-gateway-models", "dsh-keys-setting")

$ud = Join-Path $env:TEMP ("dsh-fr-ud-" + [guid]::NewGuid().ToString("N"))
$homeDir = Join-Path $env:TEMP ("dsh-fr-home-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $ud | Out-Null
New-Item -ItemType Directory -Path $homeDir | Out-Null
$log = Join-Path $env:TEMP ("dsh-fr-" + [guid]::NewGuid().ToString("N") + ".log")
$errLog = $log + ".err"
$p = $null

function Copy-Tree($src, $dst, [string[]]$Exclude = @()) {
  # The live app may hold locks; robocopy exit 8+ is tolerated. $Exclude carries the
  # engine-managed module-fallback roots - their entries are symlinks/proxies and
  # robocopy copies them as REAL directories, which makes the isolated dsh refuse to
  # boot. The engine re-creates those roots itself.
  $roboLog = Join-Path $env:TEMP ("dsh-fr-robo-" + [guid]::NewGuid().ToString("N") + ".log")
  $rcArgs = @($src, $dst, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/R:1", "/W:1", "/LOG:$roboLog")
  if ($Exclude.Count -gt 0) { $rcArgs += "/XD"; $rcArgs += $Exclude }
  robocopy @rcArgs | Out-Null
  if ($LASTEXITCODE -ge 8) { Write-Host "WARN: robocopy exit $LASTEXITCODE (live app may hold locks); continuing" }
  Remove-Item $roboLog -Force -ErrorAction SilentlyContinue
}

function Stop-App {
  if ($p -and (Get-Process -Id $p.Id -ErrorAction SilentlyContinue)) {
    $null = cmd /c "taskkill /PID $($p.Id) /T /F >nul 2>&1"
  }
}

function Dump-Log {
  Write-Host "----- app log (tail) -----"
  Get-Content $log -Tail 50 -ErrorAction SilentlyContinue
  Write-Host "----- app stderr (tail) -----"
  Get-Content $errLog -Tail 20 -ErrorAction SilentlyContinue
}

function Wait-Log($pattern, $timeoutSec, $errMsg) {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
    if (Test-Path $log) {
      $c = Get-Content $log -Raw -ErrorAction SilentlyContinue
      if ($c -and $c -match $pattern) { return $true }
    }
    if ($p -and -not (Get-Process -Id $p.Id -ErrorAction SilentlyContinue)) {
      Dump-Log
      throw "app exited early while waiting for: $errMsg"
    }
  }
  Dump-Log
  throw "timeout waiting for: $errMsg (pattern=$pattern)"
}

# Profile bundle names / dependency names, or an empty array while the file is mid-write.
function Get-ManifestField($manifestPath, $field) {
  try {
    $m = Get-Content $manifestPath -Raw -ErrorAction Stop | ConvertFrom-Json
    if ($field -eq "bundles") { return @($m.dsh.profile.bundles) }
    if ($null -eq $m.dependencies) { return @() }
    return @($m.dependencies.PSObject.Properties.Name)
  } catch {
    return @()
  }
}

function Wait-Until([scriptblock]$Probe, $timeoutSec, $errMsg) {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  $last = $null
  while ((Get-Date) -lt $deadline) {
    $last = & $Probe
    if ($last) { return $true }
    if ($p -and -not (Get-Process -Id $p.Id -ErrorAction SilentlyContinue)) {
      Dump-Log
      throw "app exited early while waiting for: $errMsg"
    }
    Start-Sleep -Milliseconds 500
  }
  Dump-Log
  throw "timeout waiting for: $errMsg"
}

# CDP driver: drives the REAL settings window - asserts the first-run card is
# visible, clicks "Enable all", and reports the settled state.
$driverFile = Join-Path $env:TEMP ("dsh-fr-driver-" + [guid]::NewGuid().ToString("N") + ".cjs")
$driver = @'
const { connectToPage, runDriver } = require(process.env.DSH_SMOKE_CDP_LIB);
runDriver(async () => {
const mode = process.argv[2] === "dismiss" ? "dismiss" : "enable";
const port = Number(process.argv[3]);
const ids = process.argv.slice(4);

const page = await connectToPage({ port, urlIncludes: "settings.html" });
const evaluate = (expr) => page.evaluate(expr);

const stateExpr = `(() => {
  const card = document.getElementById('firstRun');
  const btn = document.getElementById('btnFirstRunEnable');
  const later = document.getElementById('btnFirstRunLater');
  const body = document.getElementById('firstRunBody');
  const checks = {};
  for (const id of ${JSON.stringify(ids)}) {
    const box = document.querySelector('.plg-check[data-id="' + id + '"]');
    checks[id] = box ? box.checked : null;
  }
  return {
    cardHidden: card ? card.hidden : null,
    body: body ? body.textContent.replace(/\s+/g, ' ').trim() : '',
    enableText: btn ? btn.innerText.replace(/\s+/g, ' ').trim() : '',
    laterPresent: Boolean(later),
    checks,
    msg: ((document.getElementById('pluginMsg') || {}).textContent || '').trim(),
  };
})()`;

const clickExpr = `(() => {
  const btn = document.getElementById('btnFirstRunEnable');
  if (!btn || btn.disabled) return false;
  btn.click();
  return true;
})()`;

const laterExpr = `(() => {
  const btn = document.getElementById('btnFirstRunLater');
  if (!btn || btn.disabled) return false;
  btn.click();
  return true;
})()`;

// A click flips the button into busy immediately, and the handler always writes
// #pluginMsg when the operation settles (the card itself disappears on success -
// its visibility is derived from the payload - so the message is the only stable
// "settled" signal that survives both outcomes).
const settledExpr = `(() => {
  const msg = (document.getElementById('pluginMsg') || {}).textContent || '';
  return msg.trim().length > 0;
})()`;

async function waitForCard(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await evaluate(stateExpr);
    if (last.cardHidden === false && last.body.length > 0) return last;
    await page.wait(300);
  }
  throw new Error("the first-run card never rendered visible (last=" + JSON.stringify(last) + ")");
}

async function waitForHiddenCard(timeoutMs, desc) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await evaluate(stateExpr);
    if (last.cardHidden === true) return last;
    await page.wait(300);
  }
  throw new Error("timeout: " + desc + " (last=" + JSON.stringify(last) + ")");
}

const initial = await waitForCard(60000);
console.log("driver: card visible; body=" + initial.body);
console.log("driver: button=" + initial.enableText);
if (!initial.laterPresent) throw new Error("the 'pick manually' button is missing");

if (mode === "dismiss") {
  console.log("driver: clicking pick-manually...");
  if (!(await evaluate(laterExpr))) throw new Error("the pick-manually button was not clickable");
  const after = await waitForHiddenCard(60000, "the card never went away after picking manually");
  console.log("driver: settled; checks=" + JSON.stringify(after.checks));
  // The invariant of this path: it records a decision and NOTHING else. Comparing the
  // checkbox states before/after catches both directions (installing what was missing,
  // and uninstalling what was there).
  if (JSON.stringify(after.checks) !== JSON.stringify(initial.checks)) {
    throw new Error("picking manually changed install state: " + JSON.stringify(initial.checks) + " -> " + JSON.stringify(after.checks));
  }
  console.log("CDP-STEP PASS (dismiss)");
  page.close();
  return;
}

console.log("driver: clicking Enable all...");
if (initial.enableText.indexOf(String(ids.length)) < 0) {
  throw new Error("the button must state how many plugins it installs (got: " + initial.enableText + ")");
}
if (!(await evaluate(clickExpr))) throw new Error("the enable button was not clickable");
const deadline = Date.now() + 300000;
while (Date.now() < deadline) {
  if (await evaluate(settledExpr)) break;
  await page.wait(500);
}
await page.wait(1500);
const after = await evaluate(stateExpr);
console.log("driver: settled; msg=" + after.msg);
console.log("driver: checks=" + JSON.stringify(after.checks));
for (const id of ids) {
  if (after.checks[id] !== true) throw new Error("plugin was not installed by the one click: " + id);
}
if (after.cardHidden !== true) throw new Error("the card must disappear once everything is installed");
page.close();
console.log("CDP-STEP PASS");
});
'@
[System.IO.File]::WriteAllText($driverFile, $driver, [System.Text.UTF8Encoding]::new($false))
# The driver requires the shared CDP helper by absolute path (the temp .cjs lives outside
# the repo, so a relative require would not resolve).
$env:DSH_SMOKE_CDP_LIB = Join-Path $PSScriptRoot "lib\cdp.cjs"

function Start-App($dbgPort) {
  $env:DSH_SHELL_USERDATA = $ud
  $env:DSH_SHELL_HOME = $homeDir
  $env:DSH_SHELL_TEST_OPEN_SETTINGS = ""
  Remove-Item Env:DSH_SHELL_TEST_OPEN_SETTINGS -ErrorAction SilentlyContinue
  Remove-Item Env:DSH_SHELL_AUTOQUIT_MS -ErrorAction SilentlyContinue
  Remove-Item Env:DSH_SHELL_TEST_NOTICE -ErrorAction SilentlyContinue
  Remove-Item Env:DSH_SHELL_TEST_LATEST -ErrorAction SilentlyContinue
  Remove-Item Env:DSH_SHELL_REGISTRY_URL -ErrorAction SilentlyContinue
  $script:p = Start-Process -FilePath "npm.cmd" `
    -ArgumentList @("start", "--", "--remote-debugging-port=$dbgPort") `
    -WorkingDirectory $root `
    -RedirectStandardOutput $log -RedirectStandardError $errLog -PassThru -WindowStyle Hidden
}

try {
  Write-Host "copying engine + pnpm tools into isolated userData..."
  Copy-Tree (Join-Path $liveUd "dsh-engine") (Join-Path $ud "dsh-engine")
  Copy-Tree (Join-Path $liveUd "pnpm-tools") (Join-Path $ud "pnpm-tools")
  Write-Host "copying live home (profile + plugins) into isolated home..."
  Copy-Tree (Join-Path $liveUd "dsh-home") $homeDir -Exclude @(
    (Join-Path $liveUd "dsh-home\profiles\node_modules"),
    (Join-Path $homeDir "profiles\node_modules"),
    (Join-Path $liveUd "dsh-home\profiles\web\.dsh-module-fallback"),
    (Join-Path $homeDir "profiles\web\.dsh-module-fallback")
  )

  $profileManifest = Join-Path $homeDir "profiles\web\package.json"
  if (-not (Test-Path $profileManifest)) { throw "isolated copy has no profile manifest: $profileManifest" }
  if (-not (Test-Path (Join-Path $ud "dsh-engine\node_modules\@deepseek-ai\dsh\package.json"))) {
    throw "isolated copy has no engine"
  }

  # The scenario: the four bundled plugins are NOT installed. Careful - remove the
  # registration (bundles + dependencies, which is what makes them load) but leave
  # the rest of the profile alone, so the engine still boots exactly like the live one.
  $pruneScript = Join-Path $env:TEMP ("dsh-fr-prune-" + [guid]::NewGuid().ToString("N") + ".cjs")
  $prune = @'
const fs = require("fs");
const file = process.argv[2];
const ids = process.argv.slice(3);
const manifest = JSON.parse(fs.readFileSync(file, "utf8"));
const before = Array.isArray(manifest.dsh?.profile?.bundles) ? manifest.dsh.profile.bundles : [];
manifest.dsh = manifest.dsh || {};
manifest.dsh.profile = manifest.dsh.profile || {};
manifest.dsh.profile.bundles = before.filter((name) => !ids.includes(name));
if (manifest.dependencies) for (const id of ids) delete manifest.dependencies[id];
fs.writeFileSync(file, JSON.stringify(manifest, null, 2) + "\n");
console.log("pruned: " + before.filter((n) => ids.includes(n)).join(", ") + " | kept: " + manifest.dsh.profile.bundles.length);
'@
  [System.IO.File]::WriteAllText($pruneScript, $prune, [System.Text.UTF8Encoding]::new($false))
  & node $pruneScript $profileManifest @PLUGINS
  if ($LASTEXITCODE -ne 0) { throw "prune failed (exit $LASTEXITCODE)" }
  $bundlesNow = Get-ManifestField $profileManifest "bundles"
  foreach ($id in $PLUGINS) {
    if (@($bundlesNow) -contains $id) { throw "scenario broken: $id is still registered in the profile" }
  }
  if (@($bundlesNow) -notcontains "@deepseek-ai/dsh-web-app") {
    throw "scenario broken: the engine's own bundles were pruned too: $($bundlesNow -join ',')"
  }

  # No firstRunOfferDone: the app has never asked. updateCheckEnabled=false keeps the
  # run offline (the copied engine + pnpm tools are all this scenario needs).
  $json = @{
    updatePolicy       = "notify"
    dshHomeMode        = "app"
    updateCheckEnabled = $false
    closeAction        = "quit"
  } | ConvertTo-Json -Depth 4
  [System.IO.File]::WriteAllText((Join-Path $ud "settings.json"), $json, [System.Text.UTF8Encoding]::new($false))

  $dbgPort = 9600 + (Get-Random -Maximum 300)
  Start-App $dbgPort

  Wait-Log "first-run: offering bundled plugins" 240 "the app never offered the bundled plugins"
  Write-Host "STEP1 PASS: first-run offer detected"
  Wait-Log "settings modal open" 120 "the settings window was never opened for the offer"
  Write-Host "STEP1 PASS: the app opened the settings window itself"

  Write-Host "driving the real settings window over CDP (port $dbgPort)..."
  & node $driverFile "enable" $dbgPort @PLUGINS
  if ($LASTEXITCODE -ne 0) { Dump-Log; throw "CDP step failed (exit $LASTEXITCODE)" }
  Write-Host "STEP2 PASS: one click installed every bundled plugin"

  Wait-Log "restarting engine\.\.\. first-run bundled plugins installed" 120 "the engine was not restarted after the install"
  Write-Host "STEP3 PASS: engine restarted once by the one click"

  [void](Wait-Until {
      $b = Get-ManifestField $profileManifest "bundles"
      $d = Get-ManifestField $profileManifest "dependencies"
      (@($PLUGINS | Where-Object { @($b) -notcontains $_ }).Count -eq 0) -and
      (@($PLUGINS | Where-Object { @($d) -notcontains $_ }).Count -eq 0)
    } 120 "the profile never registered all four bundled plugins")

  $settings = Get-Content (Join-Path $ud "settings.json") -Raw | ConvertFrom-Json
  if ($settings.firstRunOfferDone -ne $true) { throw "firstRunOfferDone was not recorded (settings.json)" }
  Write-Host "STEP3 PASS: profile registers all four; firstRunOfferDone=true"

  # STEP4: the next launch must not offer again - not the log line, not the window.
  Stop-App
  Start-Sleep -Seconds 3
  Copy-Item $log ($log + ".first")
  $dbgPort2 = $dbgPort + 1
  Start-App $dbgPort2
  Wait-Log "web UI origin" 240 "second launch: the engine never became ready"
  Write-Host "second launch: engine ready; asserting there is no offer..."
  Start-Sleep -Seconds 6
  $all = Get-Content $log -Raw -ErrorAction SilentlyContinue
  if ($all -match "first-run: offering bundled plugins") {
    Dump-Log
    throw "the second launch offered the plugins again despite firstRunOfferDone=true"
  }
  if ($all -match "settings modal open") {
    Dump-Log
    throw "the second launch opened the settings window by itself"
  }
  Write-Host "STEP4 PASS: no second offer"

  # STEP5: the OTHER answer. Clear the recorded decision and take one plugin back out,
  # so there is something to offer again. "Pick manually" must record the decision and
  # touch nothing: the plugin that is out stays out, the three that are in stay in.
  Stop-App
  Start-Sleep -Seconds 3
  $clearScript = Join-Path $env:TEMP ("dsh-fr-clear-" + [guid]::NewGuid().ToString("N") + ".cjs")
  $clear = @'
const fs = require("fs");
const file = process.argv[2];
const settings = JSON.parse(fs.readFileSync(file, "utf8"));
delete settings.firstRunOfferDone;
fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
console.log("cleared firstRunOfferDone");
'@
  [System.IO.File]::WriteAllText($clearScript, $clear, [System.Text.UTF8Encoding]::new($false))
  & node $clearScript (Join-Path $ud "settings.json")
  if ($LASTEXITCODE -ne 0) { throw "clearing the decision failed (exit $LASTEXITCODE)" }
  & node $pruneScript $profileManifest "dsh-keys-setting"
  if ($LASTEXITCODE -ne 0) { throw "prune failed (exit $LASTEXITCODE)" }

  $dbgPort3 = $dbgPort + 2
  Start-App $dbgPort3
  Wait-Log "first-run: offering bundled plugins" 240 "STEP5: the offer did not come back after clearing the decision"
  & node $driverFile "dismiss" $dbgPort3 @PLUGINS
  if ($LASTEXITCODE -ne 0) { Dump-Log; throw "the pick-manually path failed (exit $LASTEXITCODE)" }
  Wait-Log "first-run: user chose to pick plugins manually" 60 "the dismiss answer was never recorded"
  $settings5 = Get-Content (Join-Path $ud "settings.json") -Raw | ConvertFrom-Json
  if ($settings5.firstRunOfferDone -ne $true) { throw "STEP5: the decision was not recorded in settings.json" }
  $b5 = Get-ManifestField $profileManifest "bundles"
  if (@($b5) -contains "dsh-keys-setting") { throw "STEP5: picking manually INSTALLED the plugin it was told not to" }
  foreach ($id in @("dsh-gui-last-session", "dsh-model-surplus", "dsh-gateway-models")) {
    if (@($b5) -notcontains $id) { throw "STEP5: picking manually uninstalled $id" }
  }
  Write-Host "STEP5 PASS: the other answer records the decision and touches no plugin"

  Write-Host "PASS: first-run detection + one-click enable verified end to end"
} finally {
  Stop-App
  Start-Sleep -Seconds 2
  Remove-Item $ud -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $homeDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $log, $errLog, "$log.first", $driverFile, $pruneScript -Force -ErrorAction SilentlyContinue
  if ($clearScript) { Remove-Item $clearScript -Force -ErrorAction SilentlyContinue }
}