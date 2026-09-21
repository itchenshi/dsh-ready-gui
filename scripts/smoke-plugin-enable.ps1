# smoke-plugin-enable.ps1 - E2E test: install state + enable state, both synced,
# with the enable toggle ACTUALLY taking effect in the engine.
#
# A plugin has TWO orthogonal states and the settings window must show both:
#   1. installed / uninstalled - profile package.json `dsh.profile.bundles`
#      (the install checkbox);
#   2. enabled / disabled      - profile cordis.patch.yml `- id: X` +
#      `disabled: true` rows, plus the market's .dsh-market/state.json
#      `disabled` list (the enable toggle).
#
# What this test guards, in the order the bugs actually happened:
#   a) The market disabled a plugin (wrote its own state.json) but the engine
#      kept loading it and the settings window showed nothing. Root cause: the
#      profile patch file carries a UTF-8 BOM, and Node's readFileSync('utf8')
#      does NOT strip it, so the append guard refused to write the disable row.
#   b) The toggle "had no effect": writing the patch layer alone changes the
#      files, so a file-only assertion passes - but the plugin has a CLIENT half
#      already loaded in the page, and the market's own switch returns
#      `refresh: true` for exactly that reason. Asserting the ENGINE's live
#      activation state (via the market's own /dsh-market/installed) is what
#      actually proves the feature works.
#
# So ground truth here is the MARKET API's activation state for the plugin
# (`live` vs `disabled`), queried over HTTP against the running engine - not the
# files on disk, and not our own helper functions.
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads a no-BOM UTF-8
# .ps1 as ANSI, and non-ASCII bytes can break parsing (see smoke-modal.ps1).
#
# Usage: powershell -File scripts/smoke-plugin-enable.ps1

$ErrorActionPreference = "Stop"

$root = "D:\AI\WorkBook\DeepSeekHarnessGUI"
$liveUd = "C:\Users\31352\AppData\Roaming\DSH GUI"

$PLUGIN = "dsh-model-surplus"
$ROWID = "model-usage"
# The pre-rename package the migration must replace (see LEGACY_PLUGIN_PKGS).
$LEGACY_PLUGIN = "dsh-opencode-go-usage"

$ud = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-plgen-ud-" + [guid]::NewGuid().ToString("N"))
$homeDir = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-plgen-home-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $ud | Out-Null
New-Item -ItemType Directory -Path $homeDir | Out-Null
$log = Join-Path $env:TEMP ("dsh-plgen-" + [guid]::NewGuid().ToString("N") + ".log")
$errLog = $log + ".err"
$p = $null

function Copy-Tree($src, $dst, [string[]]$Exclude = @()) {
  # The live app may hold locks; robocopy exit 8+ is tolerated. $Exclude carries
  # the engine-managed module-fallback roots - their entries are symlinks/proxies
  # and robocopy copies them as REAL directories, which makes the isolated dsh
  # refuse to boot. The engine re-creates those roots itself.
  $roboLog = Join-Path $env:TEMP ("dsh-plgen-robo-" + [guid]::NewGuid().ToString("N") + ".log")
  $rcArgs = @($src, $dst, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP", "/R:1", "/W:1", "/LOG:$roboLog")
  if ($Exclude.Count -gt 0) { $rcArgs += "/XD"; $rcArgs += $Exclude }
  robocopy @rcArgs | Out-Null
  if ($LASTEXITCODE -ge 8) { Write-Host "WARN: robocopy exit $LASTEXITCODE (live app may hold locks); continuing" }
  Remove-Item $roboLog -Force -ErrorAction SilentlyContinue
}

function Assert-Paths($paths) {
  foreach ($pth in $paths) {
    if (-not (Test-Path $pth)) { throw "isolated copy is missing a required path: $pth" }
  }
}

function Stop-App {
  if ($p -and (Get-Process -Id $p.Id -ErrorAction SilentlyContinue)) {
    $null = cmd /c "taskkill /PID $($p.Id) /T /F >nul 2>&1"
  }
}

function Dump-Log {
  Write-Host "----- app log (tail) -----"
  Get-Content $log -Tail 40 -ErrorAction SilentlyContinue
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
    if (-not (Get-Process -Id $p.Id -ErrorAction SilentlyContinue)) {
      Dump-Log
      throw "app exited early while waiting for: $errMsg"
    }
  }
  Dump-Log
  throw "timeout waiting for: $errMsg (pattern=$pattern)"
}

function Log-Contains($pattern) {
  if (-not (Test-Path $log)) { return $false }
  $c = Get-Content $log -Raw -ErrorAction SilentlyContinue
  return [bool]($c -and $c -match $pattern)
}

# Poll a script block until it returns true (installing a plugin runs pnpm, which
# takes real time, so a bare assertion right after the migration log would race).
function Wait-Until([scriptblock]$Probe, $timeoutSec, $errMsg) {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  $last = $null
  while ((Get-Date) -lt $deadline) {
    $last = & $Probe
    if ($last) { return $true }
    if (-not (Get-Process -Id $p.Id -ErrorAction SilentlyContinue)) {
      Dump-Log
      throw "app exited early while waiting for: $errMsg"
    }
    Start-Sleep -Milliseconds 500
  }
  Dump-Log
  throw "timeout waiting for: $errMsg"
}

# Profile bundle names, or an empty array while the file is mid-write.
function Get-Bundles($manifestPath) {
  try {
    $m = Get-Content $manifestPath -Raw -ErrorAction Stop | ConvertFrom-Json
    return @($m.dsh.profile.bundles)
  } catch {
    return @()
  }
}

# Dependency names, or an empty array while the file is mid-write.
function Get-Dependencies($manifestPath) {
  try {
    $m = Get-Content $manifestPath -Raw -ErrorAction Stop | ConvertFrom-Json
    if ($null -eq $m.dependencies) { return @() }
    return @($m.dependencies.PSObject.Properties.Name)
  } catch {
    return @()
  }
}

# The engine prints "dsh web: http://127.0.0.1:PORT/?token=..." on stdout, which the
# shell echoes into our log. The shell's own log line deliberately records only the
# ORIGIN ("web UI origin: ...") so the per-launch token never lands in a log file, so
# the token is read from the engine's own announce line here.
function Get-EngineAnnounce {
  $c = Get-Content $log -Raw -ErrorAction SilentlyContinue
  if (-not $c) { return $null }
  $m = [regex]::Match($c, "dsh web: (\S+)")
  if (-not $m.Success) { return $null }
  return $m.Groups[1].Value
}

function Get-EngineOrigin {
  $url = Get-EngineAnnounce
  if ($url) {
    $u = [System.Uri]$url
    return "$($u.Scheme)://$($u.Authority)"
  }
  # Fallback for logs written before the announce line is captured.
  $c = Get-Content $log -Raw -ErrorAction SilentlyContinue
  $m = [regex]::Match($c, "web UI (?:URL|origin): (\S+)")
  if (-not $m.Success) { return $null }
  $u = [System.Uri]$m.Groups[1].Value
  return "$($u.Scheme)://$($u.Authority)"
}

# Plugin routes are behind the engine's trust fence (Host allowlist + browser session
# cookie), so a bare curl is answered with 401. Exchange the launch token for the
# session cookie exactly like the browser does, and hand it back as a header value.
function Get-EngineCookie($origin) {
  $url = Get-EngineAnnounce
  if (-not $url) { throw "no 'dsh web:' announce line in $log; cannot mint a session cookie" }
  $token = ([System.Uri]$url).Query -replace '^\?token=', ''
  if (-not $token) { throw "the announce line carries no token: $url" }
  $headers = & curl.exe -sS -i -o NUL -D - "$origin/?token=$token" 2>&1 | Out-String
  $m = [regex]::Match($headers, "(?im)^set-cookie:\s*([^;\r\n]+)")
  if (-not $m.Success) { throw "token exchange returned no Set-Cookie (headers: $headers)" }
  return $m.Groups[1].Value.Trim()
}

# Ground truth: the market's own view of the plugin's activation state.
# 'live' = loaded by the engine, 'disabled' = switched off, 'restart' = pending.
function Get-Activation($origin, $name) {
  $raw = & curl.exe -sS "$origin/dsh-market/installed" 2>&1 | Out-String
  if (-not $raw) { return $null }
  try { $obj = $raw | ConvertFrom-Json } catch { return $null }
  if (-not $obj.activation) { return $null }
  return $obj.activation.$name.state
}

function Wait-Activation($origin, $name, $expected, $timeoutSec, $desc) {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  $last = $null
  while ((Get-Date) -lt $deadline) {
    $last = Get-Activation $origin $name
    if ($last -eq $expected) { return $last }
    Start-Sleep -Milliseconds 500
  }
  Dump-Log
  throw "timeout: $desc (expected activation '$expected', last='$last')"
}

# CDP driver: drives the REAL settings-window enable toggle and reports the
# rendered state so we can assert the row explains WHY it is disabled.
$driverFile = Join-Path $env:TEMP ("dsh-plgen-driver-" + [guid]::NewGuid().ToString("N") + ".cjs")
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

const stateExpr = `(() => {
  const ins = document.querySelector('.plg-check[data-id="${id}"]');
  const en = document.querySelector('.plg-enable[data-id="${id}"]');
  const row = ins ? ins.closest('.plg-row') : null;
  const reload = document.getElementById('btnReloadPage');
  return {
    installChecked: ins ? ins.checked : null,
    enablePresent: Boolean(en),
    enableChecked: en ? en.checked : null,
    enableDisabled: en ? en.disabled : null,
    reloadVisible: reload ? !reload.hidden : false,
    text: row ? row.innerText.replace(/\s+/g, ' ').trim() : '',
  };
})()`;

const clickExpr = `(() => {
  const en = document.querySelector('.plg-enable[data-id="${id}"]');
  if (!en || en.disabled) return false;
  en.click();
  return true;
})()`;

// A click flips `checked` SYNCHRONOUSLY, well before the IPC round-trip finishes,
// so waiting on the checkbox alone would read the row mid-operation. The handler
// clears #pluginMsg before awaiting and always writes it when done, so a
// non-empty message means "this operation has settled".
const settledExpr = (expected) => `(() => {
  const en = document.querySelector('.plg-enable[data-id="${id}"]');
  const msg = (document.getElementById('pluginMsg') || {}).textContent || '';
  return Boolean(en) && en.checked === ${expected} && msg.trim().length > 0;
})()`;

async function waitFor(pred, timeoutMs, desc) {
  const deadline = Date.now() + timeoutMs;
  let last = null;
  while (Date.now() < deadline) {
    last = await evaluate(stateExpr);
    if (pred(last)) return last;
    await wait(300);
  }
  throw new Error("timeout: " + desc + " (last=" + JSON.stringify(last) + ")");
}

async function waitSettled(expected, timeoutMs, desc) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(settledExpr(expected))) return await evaluate(stateExpr);
    await wait(250);
  }
  throw new Error("timeout: " + desc + " (last=" + JSON.stringify(await evaluate(stateExpr)) + ")");
}

const initial = await waitFor((s) => s.enablePresent && s.enableChecked !== null, 60000, "enable toggle never rendered");
console.log("driver: initial =", JSON.stringify(initial));
if (initial.installChecked !== true) throw new Error("plugin should be INSTALLED (install checkbox checked)");
if (initial.enableChecked !== false) throw new Error("plugin should be DISABLED -> enable toggle unchecked");
if (!/disabled|Disabled|\u5df2\u7981\u7528/.test(initial.text)) {
  throw new Error("row text should say WHY it is disabled: " + initial.text);
}
console.log("driver: disabled state rendered, reason shown");

console.log("driver: toggling ENABLE...");
if (!(await evaluate(clickExpr))) throw new Error("enable toggle not clickable");
const afterEnable = await waitSettled(true, 90000, "enable never settled");
if (afterEnable.installChecked !== true) throw new Error("enabling must NOT uninstall the plugin");
if (afterEnable.enableChecked !== true) throw new Error("enable did not stick");
console.log("driver: ENABLE ok; reloadVisible=" + afterEnable.reloadVisible + "; msg=" + afterEnable.msg);
// The plugin has a client half, so the engine reports refresh:true and the UI
// must offer the page reload (the same signal the market's own switch uses).
if (!afterEnable.reloadVisible) throw new Error("enabling a client-part plugin must surface the reload action");
await wait(1500);

console.log("driver: toggling DISABLE...");
if (!(await evaluate(clickExpr))) throw new Error("enable toggle not clickable (disable)");
const afterDisable = await waitSettled(false, 90000, "disable never settled");
if (afterDisable.installChecked !== true) throw new Error("disabling must NOT uninstall the plugin");
if (afterDisable.enableChecked !== false) throw new Error("disable did not stick");
console.log("driver: DISABLE ok; reloadVisible=" + afterDisable.reloadVisible);
if (!afterDisable.reloadVisible) throw new Error("disabling a client-part plugin must surface the reload action");

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

  Assert-Paths @(
    (Join-Path $ud "dsh-engine\node_modules\@deepseek-ai\dsh\package.json"),
    (Join-Path $homeDir "profiles\web\package.json")
  )
  # NOTE: the catalog plugins are installed from the npm registry since v0.5.0
  # (they used to be staged from <repo>/plugins). There is no repo-local source
  # to assert any more; the install itself is exercised by the steps below.
  Write-Host "isolated copy verified"

  $patchFile = Join-Path $homeDir "profiles\web\cordis.patch.yml"
  $stateFile = Join-Path $homeDir "profiles\web\.dsh-market\state.json"

  # ------------------------------------------------------------------ seed --
  # Reproduce the two production conditions at once, deterministically:
  #   1. a pre-rename install (old package registered + materialised), which the
  #      boot migration must replace with dsh-model-surplus while carrying the
  #      disabled intent across;
  #   2. an EMPTY, BOM'd patch layer + a market state.json that already lists the
  #      OLD package as disabled. Without the BOM fix the disable row can never
  #      be written, so the engine keeps loading the plugin.
  $seedFile = Join-Path $env:TEMP ("dsh-plgen-seed-" + [guid]::NewGuid().ToString("N") + ".cjs")
  $seed = @'
const fs = require("fs");
const path = require("path");
const home = process.argv[2];
const oldPkg = process.argv[3];
const profile = path.join(home, "profiles", "web");

// 1) Materialise the pre-rename package (registration is what the migration
//    looks at; the code itself is never loaded because it is removed first).
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

// 2) Register it in the profile manifest, exactly like the old plugin install.
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
  & node $seedFile $homeDir $LEGACY_PLUGIN
  if ($LASTEXITCODE -ne 0) { throw "seed failed (exit $LASTEXITCODE)" }

  $template = "# Your patch layer for this dsh profile`n[]`n"
  [System.IO.File]::WriteAllText($patchFile, $template, [System.Text.UTF8Encoding]::new($true))
  New-Item -ItemType Directory -Path (Split-Path $stateFile -Parent) -Force | Out-Null
  # The OLD package name is disabled in the market: the migration must carry that
  # intent over to the replacement, not silently re-enable it.
  $state = @{ disabled = @($LEGACY_PLUGIN); groups = @{}; groupOrder = @(); region = "china"; regionAuto = $true } | ConvertTo-Json -Depth 4
  [System.IO.File]::WriteAllText($stateFile, $state, [System.Text.UTF8Encoding]::new($false))
  $bom = [System.IO.File]::ReadAllBytes($patchFile)
  if (-not ($bom[0] -eq 0xEF -and $bom[1] -eq 0xBB -and $bom[2] -eq 0xBF)) {
    throw "precondition failed: patch file should start with a UTF-8 BOM"
  }
  Write-Host "precondition set: pre-rename install + BOM'd empty patch layer + market disabled list"

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

  $dbgPort = 9400 + (Get-Random -Maximum 600)
  $p = Start-Process -FilePath "npm.cmd" `
    -ArgumentList @("start", "--", "--remote-debugging-port=$dbgPort") `
    -WorkingDirectory $root `
    -RedirectStandardOutput $log -RedirectStandardError $errLog -PassThru -WindowStyle Hidden

  Wait-Log "settings modal open" 120 "settings window never opened"
  Write-Host "STEP1 PASS: settings window open"

  # STEP2: the rename migration. The old package must be gone from the profile and
  # the replacement installed - leaving it registered would load TWO header
  # widgets. Both the bundle registration AND the dependency declaration must go:
  # the engine's own reconcile re-adopts any resolvable dependency that declares
  # `dsh.bundle`, so pruning bundles alone lets the old plugin come back. That is
  # exactly how the duplicate widget shipped once already.
  Wait-Log "legacy plugin removed \(renamed\)" 180 "boot never removed the pre-rename plugin"
  $profileManifest = Join-Path $homeDir "profiles\web\package.json"
  [void](Wait-Until {
      $b = Get-Bundles $profileManifest
      $d = Get-Dependencies $profileManifest
      ($b -contains $PLUGIN) -and ($b -notcontains $LEGACY_PLUGIN) -and ($d -notcontains $LEGACY_PLUGIN)
    } 300 "the replacement plugin was never installed / the old one never left")
  $bundlesNow = Get-Bundles $profileManifest
  $depsNow = Get-Dependencies $profileManifest
  if (@($bundlesNow) -contains $LEGACY_PLUGIN) {
    Dump-Log
    throw "the pre-rename package is still registered in profile bundles: $($bundlesNow -join ',')"
  }
  if (@($depsNow) -contains $LEGACY_PLUGIN) {
    Dump-Log
    throw "the pre-rename package is still declared in profile dependencies (the engine would re-adopt it): $($depsNow -join ',')"
  }
  if (@($bundlesNow) -notcontains $PLUGIN) {
    Dump-Log
    throw "the replacement plugin was not installed: $($bundlesNow -join ',')"
  }
  Assert-Paths @((Join-Path $homeDir "profiles\web\node_modules\$PLUGIN\package.json"))
  Write-Host "STEP2 PASS: pre-rename plugin replaced by $PLUGIN (bundles + dependencies, no double install)"

  # ...and the disabled intent must have travelled with it.
  $stateNow = [System.IO.File]::ReadAllText($stateFile) | ConvertFrom-Json
  if (@($stateNow.disabled) -contains $LEGACY_PLUGIN) {
    Dump-Log
    throw "the marketplace disabled list still names the pre-rename package: $($stateNow.disabled -join ',')"
  }
  if (@($stateNow.disabled) -notcontains $PLUGIN) {
    Dump-Log
    throw "the disabled intent was not carried over to $PLUGIN : $($stateNow.disabled -join ',')"
  }
  Write-Host "STEP3 PASS: disabled intent carried over to $PLUGIN"

  # STEP4: with the market saying "disabled" and an empty patch layer, the boot
  # reconcile must write the missing disable row (the BOM bug blocked this).
  Wait-Log "plugin enable-state synced" 90 "boot reconcile never synced the disabled state"
  $patchText = [System.IO.File]::ReadAllText($patchFile)
  if ($patchText -notmatch "(?m)^- id: $ROWID\r?\n  disabled: true") {
    Dump-Log
    throw "boot reconcile did not write the disable row; patch layer is: $patchText"
  }
  Write-Host "STEP4 PASS: boot reconcile wrote the disable row (BOM handled)"

  # Resolve the engine origin, then assert the ENGINE really reflects it. Files
  # changing is not the point: a disabled plugin must stop being loaded.
  $origin = $null
  $deadline = (Get-Date).AddSeconds(90)
  while ((Get-Date) -lt $deadline) {
    $origin = Get-EngineOrigin
    if ($origin) { break }
    Start-Sleep -Milliseconds 500
  }
  if (-not $origin) { Dump-Log; throw "could not resolve the engine origin from the log" }
  Write-Host "engine origin: $origin"

  $act = Wait-Activation $origin $PLUGIN "disabled" 120 "boot reconcile must actually disable the plugin in the engine"
  Write-Host "STEP5 PASS: engine reports activation '$act' (not merely a file change)"

  Write-Host "STEP6: driving the settings-window enable toggle over CDP..."
  & node $driverFile $dbgPort $PLUGIN
  if ($LASTEXITCODE -ne 0) { Dump-Log; throw "CDP enable-toggle drive failed (exit $LASTEXITCODE)" }
  Write-Host "STEP6 PASS: toggle rendered disabled -> enabled -> disabled (install state untouched)"

  # The driver leaves the plugin DISABLED. Assert BOTH the engine's live view and
  # the durable files agree - the engine is what decides whether the feature works.
  $actOff = Wait-Activation $origin $PLUGIN "disabled" 60 "after the final disable the engine must report disabled"
  $patchText = [System.IO.File]::ReadAllText($patchFile)
  if ($patchText -notmatch "(?m)^- id: $ROWID\r?\n  disabled: true") {
    Dump-Log
    throw "after the final disable the patch layer should hold the disable row: $patchText"
  }
  $stateNow = [System.IO.File]::ReadAllText($stateFile) | ConvertFrom-Json
  if (@($stateNow.disabled) -notcontains $PLUGIN) {
    Dump-Log
    throw "market state.json should list the plugin as disabled again: $($stateNow.disabled -join ',')"
  }
  Write-Host "STEP7 PASS: engine activation='$actOff' + patch layer + market state.json all agree"

  # The toggle must have gone through the market route - that is what makes the
  # behaviour identical to the market's own switch (live apply + refresh signal).
  if (Log-Contains "market toggle unavailable") {
    Dump-Log
    throw "the toggle fell back to the file writer; the market route should have been used"
  }
  Write-Host "STEP8 PASS: the toggle went through the market route (no fallback)"

  # STEP9: the NEW host route. The widget is only as good as the payload behind
  # it, so turn the plugin back on and read /model-usage from the live engine.
  # Both sections must be present and self-describing; what each one SAYS depends
  # on whether the machine holds that key, so assert the shape, not the values.
  $bodyFile = Join-Path $env:TEMP ("dsh-plgen-body-" + [guid]::NewGuid().ToString("N") + ".json")
  [System.IO.File]::WriteAllText($bodyFile, ('{"name":"' + $PLUGIN + '","enabled":true}'), [System.Text.UTF8Encoding]::new($false))
  $null = & curl.exe -sS -X POST "$origin/dsh-market/toggle" `
    -H "Content-Type: application/json" -H "Origin: $origin" --data-binary "@$bodyFile" 2>&1
  Remove-Item $bodyFile -Force -ErrorAction SilentlyContinue
  [void](Wait-Activation $origin $PLUGIN "live" 90 "the plugin must be live before reading its route")

  # The route is fenced: an unauthenticated caller must not receive the plugin's data.
  # Note the route may not be registered yet right after the market flips the state
  # (the market's view changes first, the engine's hot reload lands a moment later);
  # while it is unregistered the SPA fallback answers 200 with HTML. So the property
  # to assert is "no session cookie -> never the plugin's JSON", not a fixed status.
  $cookie = Get-EngineCookie $origin
  $violation = $null
  $saw401 = $false
  for ($i = 0; $i -lt 40; $i++) {
    $raw = & curl.exe -sS -w "`nHTTP:%{http_code}" "$origin/model-usage" 2>&1 | Out-String
    $code = ([regex]::Match($raw, 'HTTP:(\d+)')).Groups[1].Value
    if ($code -eq '401') { $saw401 = $true; break }
    if ($code -eq '200' -and $raw -match '"sections"') { $violation = $raw; break }
    Start-Sleep -Milliseconds 500
  }
  if ($violation) {
    Dump-Log
    throw "GET /model-usage returned the plugin payload WITHOUT a session cookie: $($violation.Substring(0, [Math]::Min(200, $violation.Length)))"
  }
  Write-Host ("  /model-usage without a cookie -> {0}" -f $(if ($saw401) { 'HTTP 401 (fenced)' } else { 'route not registered yet, no payload leaked' }))

  # Positive case (with the browser session cookie): wait for the route to be live.
  $routeRaw = ''
  for ($i = 0; $i -lt 60; $i++) {
    $routeRaw = & curl.exe -sS -H "cookie: $cookie" "$origin/model-usage" 2>&1 | Out-String
    if ($routeRaw -match '"sections"') { break }
    Start-Sleep -Milliseconds 500
  }
  $route = $routeRaw | ConvertFrom-Json
  Write-Host ("  /model-usage -> ok={0}" -f $route.ok)
  # The payload is keyed by SECTION KEY (the same keys the `sections` map uses,
  # which is what the page half indexes with) - not by the camelCase config key.
  $sectionKeys = @('opencode-go', 'deepseek')
  foreach ($key in $sectionKeys) {
    $sec = $route.$key
    $detail = if ($sec -and $sec.ok) { 'ok' } else { 'reason=' + $(if ($sec) { $sec.reason } else { '<section missing>' }) }
    $payload = if ($sec) { if ($key -eq 'deepseek') { $sec.balance } else { $sec.usage } } else { $null }
    Write-Host ("    {0}: {1} -> {2}" -f $key, $detail, ($payload | ConvertTo-Json -Compress -Depth 6))
  }

  if ($route.ok -ne $true) { Dump-Log; throw "GET /model-usage did not report ok" }
  foreach ($key in $sectionKeys) {
    $sec = $route.$key
    if ($null -eq $sec) { Dump-Log; throw "GET /model-usage is missing the $key section: $routeRaw" }
    if ($sec.ok -ne $true -and -not $sec.reason) {
      Dump-Log
      throw "the $key section must carry either data or a reason: $routeRaw"
    }
  }
  # The sections map is what the page half gates on: both routes must be listed.
  $sectionMap = $route.sections
  if ($null -eq $sectionMap) { Dump-Log; throw "GET /model-usage is missing the sections map" }
  if (@($sectionMap.deepseek.providers) -notcontains 'deepseek-official') {
    Dump-Log
    throw "the deepseek section must track the engine's deepseek-official route: $($sectionMap.deepseek.providers -join ',')"
  }
  if (@($sectionMap.'opencode-go'.providers) -notcontains 'opencode-go') {
    Dump-Log
    throw "the opencode-go section must track the opencode-go route: $($sectionMap.'opencode-go'.providers -join ',')"
  }
  # When a key IS configured the payload must be in our normalized shape (the
  # upstream sends decimal strings; the amounts must survive normalization).
  $ds = $route.deepseek
  if ($ds.ok -eq $true) {
    $bal = $ds.balance
    if ($null -eq $bal) { Dump-Log; throw "deepseek.ok without a balance object" }
    if ($null -eq $bal.isAvailable) { Dump-Log; throw "balance.isAvailable must be a boolean" }
    foreach ($info in @($bal.infos)) {
      if (-not $info.currency) { Dump-Log; throw "balance entry without a currency: $routeRaw" }
      if (-not $info.total) { Dump-Log; throw "balance entry without a total: $routeRaw" }
    }
    Write-Host ("    -> live DeepSeek balance: {0}" -f (($bal.infos | ForEach-Object { $_.currency + ' ' + $_.total }) -join ', '))
  } else {
    Write-Host ("    -> DeepSeek balance not readable here (reason={0}); shape checks still passed" -f $ds.reason)
  }
  $oc = $route.'opencode-go'
  if ($oc.ok -eq $true -and $null -eq $oc.usage) {
    Dump-Log
    throw "opencode-go.ok without a usage object"
  }
  Write-Host "STEP9 PASS: /model-usage serves both sections with the live provider map"

  # STEP10: re-assert the migration AFTER the engine has composed. The engine's own
  # bundle reconcile runs at ITS boot (later than the GUI's migration), and it
  # re-adopts any resolvable dependency declaring `dsh.bundle` - so the duplicate
  # this test guards against only shows up once the engine has had its say. The
  # engine is long up by now (STEP5/9 talked to it).
  $finalBundles = Get-Bundles $profileManifest
  $finalDeps = Get-Dependencies $profileManifest
  if (@($finalBundles) -contains $LEGACY_PLUGIN) {
    Dump-Log
    throw "after the engine composed, the pre-rename package is BACK in bundles: $($finalBundles -join ',')"
  }
  if (@($finalDeps) -contains $LEGACY_PLUGIN) {
    Dump-Log
    throw "after the engine composed, the pre-rename package is BACK in dependencies: $($finalDeps -join ',')"
  }
  Write-Host "STEP10 PASS: the pre-rename plugin did not come back after the engine composed"

  Write-Host "ALL PASS"
} finally {
  Stop-App
  Start-Sleep -Milliseconds 500
  Remove-Item $ud -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $homeDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $log, $errLog, $driverFile, $seedFile -Force -ErrorAction SilentlyContinue
}
