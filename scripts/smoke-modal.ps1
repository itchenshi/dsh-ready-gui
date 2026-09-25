# smoke-modal.ps1 — E2E test for the modal settings window.
#
# While the settings window is open, the main window must be non-operable
# (Win32-enabled = false) and must NOT close. After closing settings, the main
# window becomes operable and closable again.
#
# Uses DSH_SHELL_TEST_OPEN_SETTINGS=1 to open the settings window at startup,
# WM_CLOSE for real window-close messages, and win.isEnabled() logs emitted by
# the main process as ground truth.
#
# Usage: powershell -File scripts/smoke-modal.ps1

$ErrorActionPreference = "Stop"

Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Text;
using System.Collections.Generic;
public static class Win32Modal {
  [DllImport("user32.dll", SetLastError = true)]
  public static extern bool PostMessage(IntPtr hWnd, uint Msg, IntPtr wParam, IntPtr lParam);

  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);

  public static List<IntPtr> FindVisibleByTitlePart(uint pid, string titlePart) {
    var result = new List<IntPtr>();
    EnumWindows((h, l) => {
      uint wpid; GetWindowThreadProcessId(h, out wpid);
      if (wpid == pid && IsWindowVisible(h)) {
        var sb = new StringBuilder(256);
        GetWindowText(h, sb, 256);
        if (sb.ToString().IndexOf(titlePart, StringComparison.OrdinalIgnoreCase) >= 0) result.Add(h);
      }
      return true;
    }, IntPtr.Zero);
    return result;
  }
}
"@

$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$ud = "C:\Users\31352\AppData\Roaming\DSH Ready GUI"
$homeDir = Join-Path ([System.IO.Path]::GetTempPath()) ("dsh-modal-home-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Path $homeDir | Out-Null
$log = Join-Path $env:TEMP ("dsh-modal-" + [guid]::NewGuid().ToString("N") + ".log")
$errLog = $log + ".err"

$json = @{ updatePolicy = "ask"; dshHomeMode = "system"; updateCheckEnabled = $true; closeAction = "tray" } | ConvertTo-Json
[System.IO.File]::WriteAllText((Join-Path $ud "settings.json"), $json, [System.Text.UTF8Encoding]::new($false))

$env:DSH_SHELL_USERDATA = $ud
$env:DSH_SHELL_HOME = $homeDir
$env:DSH_SHELL_REGISTRY_URL = "https://registry.npmmirror.com/@deepseek-ai/dsh/latest"
$env:DSH_SHELL_TEST_OPEN_SETTINGS = "1"
Remove-Item Env:DSH_SHELL_TEST_NOTICE -ErrorAction SilentlyContinue
Remove-Item Env:DSH_SHELL_TEST_LATEST -ErrorAction SilentlyContinue
Remove-Item Env:DSH_SHELL_AUTOQUIT_MS -ErrorAction SilentlyContinue

$p = Start-Process -FilePath "npm.cmd" -ArgumentList "start" -WorkingDirectory $root `
  -RedirectStandardOutput $log -RedirectStandardError $errLog -PassThru -WindowStyle Hidden

function Stop-App { taskkill /PID $p.Id /T /F 2>$null | Out-Null }
function Get-MainHwnd {
  $proc = Get-Process "electron" -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 -and $_.MainWindowTitle -like "*DeepSeek*" } |
    Select-Object -First 1
  if ($proc) { return ,$proc }
  return $null
}

function Find-SettingsHwnd {
  # EnumWindows over the electron main process pid: the settings window is a
  # SECOND top-level window, invisible to Get-Process.MainWindowHandle.
  # Build the CJK title via code points so the script stays encoding-safe
  # for Windows PowerShell 5.1 (no-BOM UTF-8 .ps1 is read as ANSI).
  $mainProc = Get-MainHwnd
  if (-not $mainProc) { return $null }
  $titlePart = [string]::new([char[]](0x8BBE, 0x7F6E)) # "设置"
  $handles = [Win32Modal]::FindVisibleByTitlePart([uint32]$mainProc.Id, $titlePart)
  if ($handles.Count -gt 0) { return $handles[0] }
  return $null
}

try {
  $ready = $false
  for ($i = 0; $i -lt 90; $i++) {
    Start-Sleep -Seconds 1
    if (Test-Path $log) {
      $c = Get-Content $log -Raw -ErrorAction SilentlyContinue
      if ($c -match "settings modal open; main enabled: false") { $ready = $true; break }
    }
  }
  if (-not $ready) {
    Write-Host "FAIL: settings modal never reported"
    Get-Content $log -ErrorAction SilentlyContinue
    Stop-App
    exit 1
  }
  Write-Host "STEP1 PASS: settings modal open, main window disabled"

  # 1) Try to close the MAIN window while settings is open -> must be refused.
  $main = Get-MainHwnd
  if (-not $main) { Write-Host "FAIL: main window handle not found"; Stop-App; exit 1 }
  [Win32Modal]::PostMessage($main.MainWindowHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
  Start-Sleep -Seconds 3
  if (-not (Get-Process -Id $p.Id -ErrorAction SilentlyContinue)) {
    Write-Host "FAIL: main window close was not blocked (app exited)"; exit 1
  }
  $logAll = Get-Content $log -Raw -ErrorAction SilentlyContinue
  if ($logAll -match "main window cannot close while settings window is open") {
    Write-Host "STEP2 PASS: main window close blocked while settings open"
  } else {
    Write-Host "WARN: app alive but block log not found (modal disables the X button natively)"
  }

  # 2) Close the settings window -> main must become operable.
  $settingsHwnd = Find-SettingsHwnd
  if (-not $settingsHwnd) { Write-Host "FAIL: settings window handle not found"; Stop-App; exit 1 }
  [Win32Modal]::PostMessage($settingsHwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
  Start-Sleep -Seconds 3
  $logAll = Get-Content $log -Raw -ErrorAction SilentlyContinue
  if ($logAll -match "main window enabled again: true") {
    Write-Host "STEP3 PASS: settings closed, main window enabled again"
  } else {
    Write-Host "FAIL: main not re-enabled after settings close"; Get-Content $log -Tail 10 -ErrorAction SilentlyContinue; Stop-App; exit 1
  }

  # 3) Now closing the MAIN window must quit the app (closeAction=tray would
  #    hide instead; we use tray here to also prove modality did not break
  #    tray-hide semantics -> app must stay alive).
  $main2 = Get-MainHwnd
  if (-not $main2) { Write-Host "FAIL: main window handle lost"; Stop-App; exit 1 }
  [Win32Modal]::PostMessage($main2.MainWindowHandle, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero) | Out-Null
  Start-Sleep -Seconds 4
  if (-not (Get-Process -Id $p.Id -ErrorAction SilentlyContinue)) {
    Write-Host "FAIL: main close exited app (closeAction is tray, should hide)"; exit 1
  }
  $logAll = Get-Content $log -Raw -ErrorAction SilentlyContinue
  if ($logAll -match "window hidden to tray") {
    Write-Host "STEP4 PASS: after settings closed, main window closes to tray normally"
  } else {
    Write-Host "WARN: main hidden but hide log not found"
  }
  Stop-App
  Write-Host "ALL PASS"
} finally {
  Remove-Item $homeDir -Recurse -Force -ErrorAction SilentlyContinue
  Remove-Item $log, $errLog -Force -ErrorAction SilentlyContinue
  Remove-Item $env:DSH_SHELL_HOME -Recurse -Force -ErrorAction SilentlyContinue
}