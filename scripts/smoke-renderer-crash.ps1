# smoke-renderer-crash.ps1 - E2E: when the main window's renderer dies, the GUI notices,
# tries to bring the page back, and stops instead of reload-looping forever.
#
# Why: the window renders the harness page, which runs every installed plugin's page
# half. A renderer that dies (a plugin throwing hard, an OOM, a GPU reset) used to leave
# a blank window: nothing logged, nothing shown, the process still alive, and the app simply
# looked frozen. Recovery has to be bounded, because an unconditional reload loop on a
# deterministically crashing page spins forever, which is worse than saying so.
#
# The crash is injected with the unpackaged-only hook DSH_SHELL_TEST_CRASH_RENDERER_MS;
# it repeats, so one run exercises detection, reload AND the retry ceiling.
#
# Usage: powershell -File scripts/smoke-renderer-crash.ps1
#
# NOTE: keep this file ASCII-only (PowerShell 5.1 reads a no-BOM UTF-8 .ps1 as ANSI).

$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$liveUd = Join-Path $env:APPDATA "DSH Ready GUI"
if (-not (Test-Path $liveUd)) { throw "no live install found at $liveUd" }

$ud = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-crash-ud-" + [guid]::NewGuid().ToString("N"))
$log = Join-Path $env:TEMP ("dsh-crash-" + [guid]::NewGuid().ToString("N") + ".log")
$errLog = $log + ".err"
$p = $null

function Log-Text {
  if (-not (Test-Path $log)) { return "" }
  return [string](Get-Content $log -Raw -ErrorAction SilentlyContinue)
}
function Dump-Log {
  Write-Host "----- app log (tail) -----"
  Get-Content $log -Tail 30 -ErrorAction SilentlyContinue
}
function Wait-Log($pattern, $timeoutSec, $why) {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline) {
    if ((Log-Text) -match $pattern) { return $true }
    if ($null -ne $p -and -not (Get-Process -Id $p.Id -ErrorAction SilentlyContinue)) {
      Dump-Log
      throw "app exited while waiting for: $why"
    }
    Start-Sleep -Milliseconds 400
  }
  Dump-Log
  throw "timeout waiting for: $why"
}

try {
  Write-Host "STEP1: disposable userData (the live install is only read)"
  New-Item -ItemType Directory -Path $ud | Out-Null
  $roboLog = Join-Path $env:TEMP ("dsh-crash-robo-" + [guid]::NewGuid().ToString("N") + ".log")
  & robocopy $liveUd $ud /E /NFL /NDL /NJH /NJS /NP /R:1 /W:1 /LOG:$roboLog | Out-Null
  Remove-Item $roboLog -Force -ErrorAction SilentlyContinue
  $homeDir = Join-Path $ud "dsh-home"
  if (-not (Test-Path $homeDir)) { throw "no home in the copied userData" }

  $json = @{
    dshHomeMode        = "app"
    updateCheckEnabled = $false
    closeAction        = "quit"
    firstRunOfferDone  = $true
    uiLang             = "zh"
  } | ConvertTo-Json -Depth 4
  [System.IO.File]::WriteAllText((Join-Path $ud "settings.json"), $json, [System.Text.UTF8Encoding]::new($false))

  $env:DSH_SHELL_USERDATA = $ud
  $env:DSH_SHELL_HOME = $homeDir
  # Crash the renderer 4s after it is up, and again every 4s after that.
  $env:DSH_SHELL_TEST_CRASH_RENDERER_MS = "4000"
  Remove-Item Env:DSH_SHELL_AUTOQUIT_MS -ErrorAction SilentlyContinue
  Remove-Item Env:DSH_SHELL_TEST_OPEN_SETTINGS -ErrorAction SilentlyContinue
  Remove-Item Env:DSH_SHELL_TEST_PLUGIN_UPDATE_MS -ErrorAction SilentlyContinue

  $dbgPort = 9400 + (Get-Random -Maximum 600)
  Write-Host "STEP2: launch the GUI with the crash hook armed"
  $p = Start-Process -FilePath "npm.cmd" `
    -ArgumentList @("start", "--", "--remote-debugging-port=$dbgPort") `
    -WorkingDirectory $root `
    -RedirectStandardOutput $log -RedirectStandardError $errLog -PassThru -WindowStyle Hidden

  Wait-Log "test hook: crashing the renderer on every page load" 180 "the app never reached engine-ready"
  Write-Host "STEP3 PASS: engine is up and the crash hook is armed"

  Wait-Log "renderer gone" 60 "the renderer crash was never noticed"
  Write-Host "STEP4 PASS: the crash was detected and logged"

  Wait-Log "reloading the engine page after renderer gone" 60 "the page was never reloaded"
  Write-Host "STEP5 PASS: the page was reloaded instead of leaving a blank window"

  # The give-up branch is deliberately NOT asserted here: injecting a renderer crash twice
  # is enough for Chromium to stop reproducing it, so a third failure cannot be produced
  # in this run. That branch - the bound which stops an infinite reload loop - is covered
  # by src/test/renderer-recovery.test.cjs instead (pure policy, no Electron needed).
  Wait-Log "attempt 2/2" 120 "the retry counter never advanced past the first attempt"
  Write-Host "STEP6 PASS: consecutive attempts are counted (the bound itself is unit-tested)"

  # The process must survive all of that: a crash handler that takes the app down with it
  # would be worse than the blank window it replaces.
  Start-Sleep -Seconds 2
  if (-not (Get-Process -Id $p.Id -ErrorAction SilentlyContinue)) {
    Dump-Log
    throw "the app exited during the crash/reload sequence"
  }
  Write-Host "STEP7 PASS: the app is still running after the crash/reload sequence"

  Write-Host "`nALL Renderer-crash smoke checks passed"
}
finally {
  if ($null -ne $p) {
    try { & taskkill /PID $p.Id /T /F 2>&1 | Out-Null } catch { }
  }
  Start-Sleep -Milliseconds 500
  Remove-Item $ud -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $log, $errLog -Force -ErrorAction SilentlyContinue
}
