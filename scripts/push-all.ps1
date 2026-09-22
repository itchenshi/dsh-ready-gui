# push-all.ps1 -- push current branch + tags to GitHub / Gitee / GitCode
#
# Usage:
#   pwsh -File scripts/push-all.ps1
#   powershell.exe -File scripts\push-all.ps1
#   powershell -File scripts/push-all.ps1 -SecretsFile C:\path\push-credentials.txt
#   powershell -File scripts/push-all.ps1 -NoTags
#
# Credentials:
#   - Secrets file is KEY=VALUE lines: GITEE_TOKEN=xxx / GITCODE_TOKEN=xxx / GITHUB_TOKEN=xxx
#   - When a token exists, it is injected as https://<user>:<token>@<host> for that push only
#     (never written into git config and never stored in a remote URL).
#   - Remotes without a token fall back to the git credential manager / interactive prompt.
#   - NEVER commit the secrets file into any repository; revoke tokens after use.

param(
  [string]$SecretsFile = (Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'push-credentials.txt'),
  [switch]$NoTags,
  [string[]]$Skip = @()
)

$ErrorActionPreference = 'Stop'

$remotes = @(
  @{ Name = 'origin';  Url = 'https://github.com/itchenshi/dsh-ready-gui.git' },
  @{ Name = 'gitee';   Url = 'https://gitee.com/itchenshi/dsh-ready-gui.git' },
  @{ Name = 'gitcode'; Url = 'https://gitcode.com/itchenshi/dsh-ready-gui.git' }
)

# Load secrets (KEY=VALUE lines)
$secrets = @{}
if (Test-Path $SecretsFile) {
  Get-Content $SecretsFile |
    Where-Object { $_ -match '^\s*[A-Za-z_][A-Za-z0-9_]*=' } |
    ForEach-Object {
      $kv = $_ -split '=', 2
      $secrets[$kv[0].Trim()] = $kv[1].Trim()
    }
  Write-Host "[info] secrets loaded: $SecretsFile" -ForegroundColor Green
}
else {
  Write-Host "[warn] no secrets file: $SecretsFile (remotes without tokens use credential manager / prompt)" -ForegroundColor Yellow
}

$branch = git rev-parse --abbrev-ref HEAD
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($branch)) { throw 'cannot resolve current branch' }

$tagNote = 'all tags'
if ($NoTags) { $tagNote = 'no tags' }
Write-Host "[plan] push branch: $branch ($tagNote)" -ForegroundColor Cyan
if ($Skip.Count -gt 0) { Write-Host "[plan] skipping: $($Skip -join ', ')" -ForegroundColor Yellow }

# Network hardening for unreliable links (measured on a restricted network where
# github.com accepts connections but transfers stall):
#   - HTTP/1.1: HTTP/2 to github.com was reset mid-upload; 1.1 completed.
#   - large postBuffer: big pushes (binary assets, several MB) need it.
#   - a LOW-SPEED limit that only trips on a genuinely stalled transfer. A short
#     one (20s) aborts a slow-but-working push and reports a failure that is not
#     one - that is exactly how the v0.3.0 GitHub push first appeared to fail.
$gitNetArgs = @(
  '-c', 'http.version=HTTP/1.1',
  '-c', 'http.postBuffer=524288000',
  '-c', 'http.lowSpeedLimit=1000',
  '-c', 'http.lowSpeedTime=180'
)

# Each mirror is attempted independently: one unreachable platform must not stop
# the others (same isolation rationale as publish-all.ps1). Failures are
# collected and reported at the end with a non-zero exit code.
$failures = @()

foreach ($r in $remotes) {
  if ($Skip -contains $r.Name) {
    Write-Host "[skip] $($r.Name) (excluded by -Skip)" -ForegroundColor Yellow
    continue
  }
  $tokenKey = "$($r.Name)_TOKEN"
  $userKey  = "$($r.Name)_USER"
  $url = $r.Url

  if ($secrets.ContainsKey($tokenKey) -and $secrets[$tokenKey]) {
    $user = $r.Name
    if ($secrets.ContainsKey($userKey) -and $secrets[$userKey]) { $user = $secrets[$userKey] }
    $url = $url -replace '^https://', "https://$user`:$($secrets[$tokenKey])@"
    Write-Host "[push] -> $($r.Name) (https + token)" -ForegroundColor Cyan
  }
  else {
    Write-Host "[push] -> $($r.Name) (https; credential manager / interactive)" -ForegroundColor Cyan
  }

  try {
    git @gitNetArgs push $url $branch
    if ($LASTEXITCODE -ne 0) { throw "branch push failed (exit $LASTEXITCODE)" }

    if (-not $NoTags) {
      git @gitNetArgs push $url --tags
      if ($LASTEXITCODE -ne 0) { throw "tag push failed (exit $LASTEXITCODE)" }
    }
    Write-Host "[ok]   $($r.Name)" -ForegroundColor Green
  }
  catch {
    # Never echo the tokenised URL.
    Write-Host "[fail] $($r.Name): $($_.Exception.Message)" -ForegroundColor Red
    $failures += $r.Name
  }
}

if ($failures.Count -gt 0) {
  Write-Host "[done] pushed with failures on: $($failures -join ', ')" -ForegroundColor Yellow
  Write-Host "       re-run later, or exclude an unreachable mirror with -Skip <name>" -ForegroundColor Yellow
  exit 1
}
Write-Host "[done] pushed to all mirrors" -ForegroundColor Green