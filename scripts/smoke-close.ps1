# smoke-close.ps1 — E2E test for the "close window" behavior.
# Uses WM_CLOSE (the same message the X button sends) against the main
# window, then asserts the app either exits (quit mode) or hides to the
# tray and keeps running (tray mode).
#
# Usage: powershell -File scripts/smoke-close.ps1 -Mode quit|tray

param([ValidateSet("quit", "tray")][string]$Mode = "quit")

$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Runtime.InteropServices;
public static class Win32Close {
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);
}
"@

$root = "D:\AI\WorkBook\dsh-ready-gui"
$ud = "C:\Users\31352\AppData\Roaming\DSH Ready GUI"
$homeDir = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-e2e-home-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $homeDir | Out-Null
$log = Join-Path $env:TEMP ("dsh-e2e-" + $Mode + "-" + [guid]::NewGuid().ToString("N") + ".log")
$errLog = $log + ".err"

# Preseed closeAction (keep everything else minimal).
$json = @{ updatePolicy = "ask"; dshHomeMode = "system"; updateCheckEnabled = $true; closeAction = $Mode } | ConvertTo-Json
[System.IO.File]::WriteAllText((Join-Path $ud "settings.json"), $json, [System.Text.UTF8Encoding]::new($false))

$env:DSH_SHELL_USERDATA = $ud
$env:DSH_SHELL_HOME = $homeDir
$env:DSH_SHELL_REGISTRY_URL = "https://registry.npmmirror.com/@deepseek-ai/dsh/latest"
Remove-Item Env:DSH_SHELL_TEST_NOTICE -ErrorAction SilentlyContinue
Remove-Item Env:DSH_SHELL_TEST_LATEST -ErrorAction SilentlyContinue
Remove-Item Env:DSH_SHELL_AUTOQUIT_MS -ErrorAction SilentlyContinue

$p = Start-Process -FilePath "npm.cmd" -ArgumentList "start" -WorkingDirectory $root `
  -RedirectStandardOutput $log -RedirectStandardError $errLog -PassThru -WindowStyle Hidden

function Stop-App { taskkill /PID $p.Id /T /F 2>$null | Out-Null }

try {
  # Wait for the embedded UI to be ready.
  $ready = $false
  for ($i = 0; $i -lt 90; $i++) {
    Start-Sleep -Seconds 1
    if (Test-Path $log) {
      $c = Get-Content $log -Raw -ErrorAction SilentlyContinue
      if ($c -match "embedded web contents loaded") { $ready = $true; break }
    }
  }
  if (-not $ready) {
    Write-Host "FAIL: UI never became ready"
    Get-Content $log -ErrorAction SilentlyContinue
    Get-Content $errLog -ErrorAction SilentlyContinue
    Stop-App
    exit 1
  }
  Write-Host "UI ready -> sending WM_CLOSE to main window"

  $target = Get-Process "electron" -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*DeepSeek*" } |
    Select-Object -First 1
  if (-not $target) {
    Write-Host "FAIL: no main window handle found"
    Stop-App
    exit 1
  }
  Write-Host ("main window hwnd: {0} (title: {1})" -f $target.MainWindowHandle, $target.MainWindowTitle)
  [Win32Close]::PostMessage($target.MainWindowHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null

  Start-Sleep -Seconds 6
  $alive = Get-Process -Id $p.Id -ErrorAction SilentlyContinue
  $logAll = Get-Content $log -Raw -ErrorAction SilentlyContinue

  if ($Mode -eq "quit") {
    if ($alive) {
      Write-Host "FAIL: app still alive after close (tray kept it alive)"
      Stop-App
      exit 1
    }
    if ($logAll -match "tray destroyed") { Write-Host "  + tray destroyed on quit" }
    Write-Host "PASS: quit mode - app exited after window close"
  } else {
    if (-not $alive) {
      Write-Host "FAIL: tray mode - app exited unexpectedly"
      exit 1
    }
    if ($logAll -match "window hidden to tray") {
      Write-Host "PASS: tray mode - window hidden to tray, app alive"
    } else {
      Write-Host "WARN: tray mode - app alive but hide log not found"
    }
    Stop-App
  }
} finally {
  Remove-Item $homeDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $log, $errLog -Force -ErrorAction SilentlyContinue
}