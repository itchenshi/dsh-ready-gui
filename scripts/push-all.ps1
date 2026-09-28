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
  # -Encoding UTF8: PS 5.1 defaults to ANSI, and a UTF-8 BOM would hide the first
  # line's key from the match below (a token silently going missing).
  Get-Content $SecretsFile -Encoding UTF8 |
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

# -Skip 必须同时接受**两种写法**：平台名（GitHub / Gitee / GitCode —— publish-all.ps1 与
# 它的文档用的就是这套）与 remote 名（origin / gitee / gitcode —— 本脚本内部的 $r.Name）。
# 早先直接拿传入值跟 remote 名比，于是 `publish-all -Skip GitHub` 转发过来后**静默不生效**，
# 而这恰恰是它最该生效的场景（github.com 连不上、想让推送跳过它）。
$skipSet = @{}
foreach ($s in $Skip) {
  if ([string]::IsNullOrWhiteSpace($s)) { continue }
  switch ($s.Trim().ToLowerInvariant()) {
    'github'  { $skipSet['origin'] = $true }
    'origin'  { $skipSet['origin'] = $true }
    'gitee'   { $skipSet['gitee'] = $true }
    'gitcode' { $skipSet['gitcode'] = $true }
    default   { $skipSet[$s.Trim().ToLowerInvariant()] = $true }
  }
}

# 输出里出现的任何已知 token 一律抹掉再打印。git 自己会把**带 token 的 URL** 写进错误
# 信息（`fatal: unable to access 'https://user:TOKEN@github.com/...'`），直接转发它的输出
# 等于把凭据打进终端回滚区与 CI 日志 —— 而下面的注释还在说「Never echo the tokenised URL」。
function Redact-Token([string]$text) {
  $out = $text
  foreach ($key in $secrets.Keys) {
    $val = [string]$secrets[$key]
    if ($val.Length -ge 8) { $out = $out -replace [regex]::Escape($val), '***' }
  }
  return $out
}

$tagNote = 'all tags'
if ($NoTags) { $tagNote = 'no tags' }
Write-Host "[plan] push branch: $branch ($tagNote)" -ForegroundColor Cyan
if ($skipSet.Count -gt 0) { Write-Host "[plan] skipping: $($skipSet.Keys -join ', ')" -ForegroundColor Yellow }

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
  if ($skipSet.ContainsKey($r.Name)) {
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
    # 逐行过滤后再打印：既保留实时进度（长推送几分钟没有任何输出会让人以为卡死），
    # 又不会把 git 错误信息里的 token 化 URL 漏到终端与日志里。
    git @gitNetArgs push $url $branch 2>&1 | ForEach-Object { Write-Host (Redact-Token ([string]$_)) }
    if ($LASTEXITCODE -ne 0) { throw "branch push failed (exit $LASTEXITCODE)" }

    if (-not $NoTags) {
      git @gitNetArgs push $url --tags 2>&1 | ForEach-Object { Write-Host (Redact-Token ([string]$_)) }
      if ($LASTEXITCODE -ne 0) { throw "tag push failed (exit $LASTEXITCODE)" }
    }
    Write-Host "[ok]   $($r.Name)" -ForegroundColor Green
  }
  catch {
    # Never echo the tokenised URL —— 异常消息本身也可能带上它，同样过一遍过滤。
    Write-Host "[fail] $($r.Name): $(Redact-Token $_.Exception.Message)" -ForegroundColor Red
    $failures += $r.Name
  }
}

if ($failures.Count -gt 0) {
  Write-Host "[done] pushed with failures on: $($failures -join ', ')" -ForegroundColor Yellow
  Write-Host "       re-run later, or exclude an unreachable mirror with -Skip <name>" -ForegroundColor Yellow
  exit 1
}
Write-Host "[done] pushed to all mirrors" -ForegroundColor Green