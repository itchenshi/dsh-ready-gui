# smoke-plugin-update.ps1 - E2E test: the GUI notices a bundled plugin whose installed
# copy is behind the shipped one, on an INTERVAL (not only at launch), and says so.
#
# Why this test exists: the startup reconciliation is the primary path, and it only
# runs once per launch, only for what it can see then, and it reports failures with a
# log line nobody reads. The periodic check is what turns "a plugin is behind" into
# something the user can see and act on, so it needs its own proof.
#
# The situation is arranged so the STARTUP pass cannot have fixed it: the app is
# launched normally, and only afterwards is one installed copy made older. That is
# exactly the shape of the real cases (a launch whose install failed, or an app
# updated in place), and it isolates the interval from the launch-time pass.
#
# Usage: powershell -File scripts/smoke-plugin-update.ps1
#
# NOTE: keep this file ASCII-only. Windows PowerShell 5.1 reads a no-BOM UTF-8 .ps1 as
# ANSI, and non-ASCII bytes can break parsing (see smoke-modal.ps1).

$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$liveUd = Join-Path $env:APPDATA "DSH Ready GUI"
$PLUGIN = "dsh-keys-setting"

if (-not (Test-Path $liveUd)) { throw "no live install found at $liveUd" }

$ud = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-plgupd-ud-" + [guid]::NewGuid().ToString("N"))
$log = Join-Path $env:TEMP ("dsh-plgupd-" + [guid]::NewGuid().ToString("N") + ".log")
$errLog = $log + ".err"
$p = $null

function Dump-Log {
  Write-Host "----- app log (tail) -----"
  Get-Content $log -Tail 30 -ErrorAction SilentlyContinue
  Write-Host "----- app stderr (tail) -----"
  Get-Content $errLog -Tail 15 -ErrorAction SilentlyContinue
}

function Log-Contains($pattern) {
  if (-not (Test-Path $log)) { return $false }
  $c = Get-Content $log -Raw -ErrorAction SilentlyContinue
  return [bool]($c -and $c -match $pattern)
}

function Wait-Log($pattern, $timeoutSec, $why) {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline) {
    if (Log-Contains $pattern) { return $true }
    if ($null -ne $p -and -not (Get-Process -Id $p.Id -ErrorAction SilentlyContinue)) {
      Dump-Log
      throw "app exited early while waiting for: $why"
    }
    Start-Sleep -Milliseconds 400
  }
  Dump-Log
  throw "timeout waiting for: $why"
}

try {
  Write-Host "STEP1: copy the live userData into a temp dir (the source stays read-only)"
  New-Item -ItemType Directory -Path $ud | Out-Null
  $roboLog = Join-Path $env:TEMP ("dsh-plgupd-robo-" + [guid]::NewGuid().ToString("N") + ".log")
  & robocopy $liveUd $ud /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 /LOG:$roboLog | Out-Null
  Remove-Item $roboLog -Force -ErrorAction SilentlyContinue
  # The engine tree is COPIED (not dropped): without it the app installs @deepseek-ai/dsh
  # from npm on first launch, which takes minutes of network time and would mean this
  # test measured "the engine is still installing", not the plugin check.

  $homeDir = Join-Path $ud "dsh-home"
  $profile = Join-Path $homeDir "profiles\web"
  $manifest = Join-Path $profile "node_modules\$PLUGIN\package.json"
  if (-not (Test-Path $manifest)) { throw "precondition: $PLUGIN is not installed in the copied home" }

  # Bring EVERY bundled plugin's installed copy up to the version shipped in plugins/,
  # BEFORE the app starts. Otherwise the launch-time pass spends its time replacing the
  # copies this test needs to keep still (and a pnpm run inside a copied userData can
  # take minutes), which would leave the interval nothing to notice. With the copies at
  # par the launch pass leaves them alone and the test isolates the interval.
  $shippedPlugins = Join-Path $root "plugins"
  foreach ($dir in Get-ChildItem $shippedPlugins -Directory) {
    $shippedManifest = Join-Path $dir.FullName "package.json"
    $installedManifest = Join-Path $profile ("node_modules\" + $dir.Name + "\package.json")
    if (-not (Test-Path $installedManifest)) { continue }
    $shippedVersion = (Get-Content $shippedManifest -Raw | ConvertFrom-Json).version
    $installed = Get-Content $installedManifest -Raw | ConvertFrom-Json
    if ($installed.version -ne $shippedVersion) {
      $installed.version = $shippedVersion
      [System.IO.File]::WriteAllText($installedManifest, ($installed | ConvertTo-Json -Depth 6), [System.Text.UTF8Encoding]::new($false))
      Write-Host ("  levelled {0}: -> v{1}" -f $dir.Name, $shippedVersion)
    }
  }

  # settings.json: no app-update check (it would need the network and could put its own
  # notice on screen, which is exactly the corner this code shares), and no first-run card.
  $json = @{
    dshHomeMode       = "app"
    updateCheckEnabled = $false
    closeAction       = "quit"
    firstRunOfferDone = $true
    uiLang            = "zh"
  } | ConvertTo-Json -Depth 4
  [System.IO.File]::WriteAllText((Join-Path $ud "settings.json"), $json, [System.Text.UTF8Encoding]::new($false))

  $env:DSH_SHELL_USERDATA = $ud
  $env:DSH_SHELL_HOME = $homeDir
  $env:DSH_SHELL_TEST_OPEN_SETTINGS = "1"
  # Scale the periodic check from 6h down to 2s (only honoured in unpackaged builds).
  $env:DSH_SHELL_TEST_PLUGIN_UPDATE_MS = "2000"
  Remove-Item Env:DSH_SHELL_AUTOQUIT_MS -ErrorAction SilentlyContinue

  $dbgPort = 9400 + (Get-Random -Maximum 600)
  Write-Host "STEP2: launch the GUI (packaged=false, so the test hooks apply)"
  $p = Start-Process -FilePath "npm.cmd" `
    -ArgumentList @("start", "--", "--remote-debugging-port=$dbgPort") `
    -WorkingDirectory $root `
    -RedirectStandardOutput $log -RedirectStandardError $errLog -PassThru -WindowStyle Hidden

  # The settings-window marker proves the app is up AND that the settings payload for
  # this home was produced (the version/update fields travel in that same payload).
  Wait-Log "settings modal open" 180 "the app never came up"
  Write-Host "STEP3 PASS: app is up and the settings window opened"

  # The interval only starts once the engine is ready (see startPluginUpdateChecks in
  # onUrl), and it logs even when nothing is pending, so this line is the proof that
  # the periodic check is actually running before the situation is arranged.
  Wait-Log "bundled plugin update check: nothing pending" 180 "the periodic plugin check never ran"
  Write-Host "STEP4 PASS: the interval is running and found nothing pending right after launch"

  Write-Host "STEP5: make the installed copy older, as a failed launch / in-place app update would"
  # The launch-time pass replaces an outdated copy with remove+add, so the directory can
  # briefly be absent; wait for it to settle before editing it.
  $deadline = (Get-Date).AddSeconds(60)
  while (-not (Test-Path $manifest)) {
    if ((Get-Date) -gt $deadline) { Dump-Log; throw "the installed copy of $PLUGIN never appeared" }
    Start-Sleep -Milliseconds 300
  }
  $meta = Get-Content $manifest -Raw | ConvertFrom-Json
  $installedBefore = $meta.version
  $meta.version = "0.0.1"
  [System.IO.File]::WriteAllText($manifest, ($meta | ConvertTo-Json -Depth 6), [System.Text.UTF8Encoding]::new($false))

  # The announced signature names the version it would move TO (the shipped one), not the
  # stale one this test planted, so match on the package name only.
  Wait-Log "bundled plugin updates available:.*$PLUGIN@" 60 "the periodic check never noticed $PLUGIN"
  Write-Host "STEP6 PASS: the interval noticed the outdated copy (was v$installedBefore, planted v0.0.1)"

  Wait-Log "update notice shown:" 30 "the user was never told"
  Write-Host "STEP7 PASS: the corner notice was shown"

  # The notice must not repeat forever for one unchanged situation.
  Start-Sleep -Seconds 5
  $count = ([regex]::Matches((Get-Content $log -Raw), "update notice shown:")).Count
  if ($count -ne 1) { throw "the notice was shown $count times; it must be announced once per distinct set" }
  Write-Host "STEP8 PASS: the same situation is announced exactly once"

  Write-Host "`nALL Plugin-update smoke checks passed"
}
finally {
  if ($null -ne $p) {
    # Kill the whole tree: npm.cmd -> node -> electron.
    try { & taskkill /PID $p.Id /T /F 2>&1 | Out-Null } catch { }
  }
  Start-Sleep -Milliseconds 500
  Remove-Item $ud -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $log, $errLog -Force -ErrorAction SilentlyContinue
}
