# smoke-two-instances.ps1 - E2E: two GUI instances run at the same time.
#
# Why: the GUI used to refuse to start twice (requestSingleInstanceLock + a second-instance
# handler that just focused the first window). That hid real problems - several paths are
# shared AND written destructively - so the restriction was replaced with a cross-process
# lock around those paths. This test proves both halves of that claim: two instances DO
# come up (and each runs its own dsh engine), using one disposable userData.
#
# Usage: powershell -File scripts/smoke-two-instances.ps1
#
# NOTE: keep this file ASCII-only (PowerShell 5.1 reads a no-BOM UTF-8 .ps1 as ANSI).

$ErrorActionPreference = "Stop"

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$liveUd = Join-Path $env:APPDATA "DSH Ready GUI"
if (-not (Test-Path $liveUd)) { throw "no live install found at $liveUd" }

$ud = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-two-ud-" + [guid]::NewGuid().ToString("N"))
$logA = Join-Path $env:TEMP ("dsh-two-a-" + [guid]::NewGuid().ToString("N") + ".log")
$logB = Join-Path $env:TEMP ("dsh-two-b-" + [guid]::NewGuid().ToString("N") + ".log")
$errA = $logA + ".err"
$errB = $logB + ".err"
$pA = $null
$pB = $null

function Log-Text($file) {
  if (-not (Test-Path $file)) { return "" }
  return [string](Get-Content $file -Raw -ErrorAction SilentlyContinue)
}
function Dump-Logs {
  foreach ($f in @($logA, $logB)) {
    Write-Host "----- $([System.IO.Path]::GetFileName($f)) (tail) -----"
    Get-Content $f -Tail 12 -ErrorAction SilentlyContinue
  }
}
function Wait-Log($file, $pattern, $timeoutSec, $why) {
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while ((Get-Date) -lt $deadline) {
    if ((Log-Text $file) -match $pattern) { return $true }
    Start-Sleep -Milliseconds 500
  }
  Dump-Logs
  throw "timeout waiting for: $why"
}

try {
  Write-Host "STEP1: disposable userData (the live install is only read)"
  New-Item -ItemType Directory -Path $ud | Out-Null
  $roboLog = Join-Path $env:TEMP ("dsh-two-robo-" + [guid]::NewGuid().ToString("N") + ".log")
  & robocopy $liveUd $ud /E /XJ /NFL /NDL /NJH /NJS /NP /R:1 /W:1 /LOG:$roboLog | Out-Null
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

  # Both instances get the same userData and home ON PURPOSE: that is exactly the shared
  # state the lock exists for.
  $env:DSH_SHELL_USERDATA = $ud
  $env:DSH_SHELL_HOME = $homeDir
  $env:DSH_SHELL_TEST_OPEN_SETTINGS = "1"
  Remove-Item Env:DSH_SHELL_AUTOQUIT_MS -ErrorAction SilentlyContinue
  Remove-Item Env:DSH_SHELL_TEST_CRASH_RENDERER_MS -ErrorAction SilentlyContinue
  Remove-Item Env:DSH_SHELL_TEST_PLUGIN_UPDATE_MS -ErrorAction SilentlyContinue

  Write-Host "STEP2: launch instance A"
  $portA = 9400 + (Get-Random -Maximum 300)
  $pA = Start-Process -FilePath "npm.cmd" -ArgumentList @("start", "--", "--remote-debugging-port=$portA") `
    -WorkingDirectory $root -RedirectStandardOutput $logA -RedirectStandardError $errA -PassThru -WindowStyle Hidden
  Wait-Log $logA "settings modal open" 240 "instance A never came up"
  Write-Host "STEP3 PASS: instance A is running"

  Write-Host "STEP4: launch instance B while A is still running (this used to quit immediately)"
  $portB = 9800 + (Get-Random -Maximum 300)
  $pB = Start-Process -FilePath "npm.cmd" -ArgumentList @("start", "--", "--remote-debugging-port=$portB") `
    -WorkingDirectory $root -RedirectStandardOutput $logB -RedirectStandardError $errB -PassThru -WindowStyle Hidden

  Wait-Log $logB "settings modal open" 240 "instance B never came up - the single-instance restriction is still in effect"
  Write-Host "STEP5 PASS: instance B is running too"

  # Both must be alive AND each must have brought up its own engine.
  Start-Sleep -Seconds 5
  foreach ($pair in @(@{ P = $pA; L = $logA; N = "A" }, @{ P = $pB; L = $logB; N = "B" })) {
    if (-not (Get-Process -Id $pair.P.Id -ErrorAction SilentlyContinue)) {
      Dump-Logs
      throw "instance $($pair.N) exited"
    }
  }
  Write-Host "STEP6 PASS: both instances are still running"

  Wait-Log $logA "dsh web:" 180 "instance A never started an engine"
  Wait-Log $logB "dsh web:" 180 "instance B never started an engine"
  Write-Host "STEP7 PASS: each instance runs its own engine"

  # And they must be DIFFERENT engines (two ports), not one shared by both.
  $urlA = [regex]::Match((Log-Text $logA), "dsh web:\s*(\S+)").Groups[1].Value
  $urlB = [regex]::Match((Log-Text $logB), "dsh web:\s*(\S+)").Groups[1].Value
  if (-not $urlA -or -not $urlB) { Dump-Logs; throw "could not read both engine URLs" }
  if ($urlA -eq $urlB) { Dump-Logs; throw "both instances reported the same engine URL: $urlA" }
  Write-Host "STEP8 PASS: two separate engines ($urlA / $urlB)"

  # The shared engine tree must still be intact after two concurrent startups.
  if (-not (Test-Path (Join-Path $ud "dsh-engine\node_modules\@deepseek-ai\dsh\package.json"))) {
    Dump-Logs
    throw "the shared engine tree was damaged by the concurrent startups"
  }
  Write-Host "STEP9 PASS: the shared engine tree survived"

  Write-Host "`nALL Two-instance smoke checks passed"
}
finally {
  foreach ($proc in @($pA, $pB)) {
    if ($null -ne $proc) {
      try { & taskkill /PID $proc.Id /T /F 2>&1 | Out-Null } catch { }
    }
  }
  Start-Sleep -Milliseconds 800
  Remove-Item $ud -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $logA, $errA, $logB, $errB -Force -ErrorAction SilentlyContinue
}
