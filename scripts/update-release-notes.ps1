# update-release-notes.ps1 -- push a release-notes file to the GitHub / Gitee /
# GitCode release body (and title) for one tag.
#
# Why this exists: the notes live in the repo (RELEASE-NOTES-v<version>.md), but
# each platform keeps its own copy in the release record. Fixing a claim in the
# file does NOT touch the published text, so a corrected note can sit stale on a
# mirror forever. This is the one command that makes all three agree.
#
# Usage:
#   powershell -File scripts/update-release-notes.ps1 -Tag v0.3.0 -NotesFile RELEASE-NOTES-v0.3.0.md
#   powershell -File scripts/update-release-notes.ps1 -Tag v0.3.0 -PublishDirs dist
#   powershell -File scripts/update-release-notes.ps1 -Tag v0.3.0 -Skip GitHub
#
# Platform notes (both learned the hard way):
#   - Gitee's update endpoint REQUIRES `tag_name`; without it the call returns
#     HTTP 200 and leaves the release untouched (a silent no-op).
#   - GitCode release objects carry NO `id` field, so the tag itself is used as
#     the handle for the update.

param(
  [Parameter(Mandatory = $true)][string]$Tag,
  [Parameter(Mandatory = $true)][string]$NotesFile,
  [string]$Title = '',
  [string]$SecretsFile = '',
  [string[]]$Skip = @(),
  [string]$Owner = 'itchenshi',
  [string]$Repo = 'dsh-ready-gui'
)

$ErrorActionPreference = 'Stop'
$RepoRoot = Split-Path $PSScriptRoot -Parent
$DefaultSecrets = Join-Path (Split-Path $RepoRoot -Parent) 'push-credentials.txt'
if (-not $SecretsFile) { $SecretsFile = $DefaultSecrets }

function Write-Step([string]$m) { Write-Host "[notes] $m" -ForegroundColor Cyan }
function Write-Ok([string]$m) { Write-Host "[ok]    $m" -ForegroundColor Green }
function Write-Warn2([string]$m) { Write-Host "[warn]  $m" -ForegroundColor Yellow }

if (-not (Test-Path $NotesFile)) { throw "notes file not found: $NotesFile" }
$notesPath = (Resolve-Path $NotesFile).Path
$notesText = [System.IO.File]::ReadAllText($notesPath)
if (-not $Title) { $Title = "DSH Ready GUI $($Tag.TrimStart('v'))" }
Write-Step "tag=$Tag title='$Title' notes=$notesPath ($($notesText.Length) chars)"

# Stage the body as UTF-8 (no BOM) so curl reads it byte-for-byte; a PowerShell
# string argument would be re-encoded to the system ANSI codepage (mojibake).
$bodyFile = Join-Path $env:TEMP "release-notes-$Tag.txt"
[System.IO.File]::WriteAllText($bodyFile, $notesText, (New-Object System.Text.UTF8Encoding($false)))
# GitCode carries no attachments, so its body points at GitHub Releases.
$gitcodeBodyFile = Join-Path $env:TEMP "release-notes-$Tag-gitcode.txt"
$gitcodeText = $notesText + "`n`n---`nInstallers: download from GitHub Releases - https://github.com/$Owner/$Repo/releases/tag/$Tag"
[System.IO.File]::WriteAllText($gitcodeBodyFile, $gitcodeText, (New-Object System.Text.UTF8Encoding($false)))

$secrets = @{}
if (Test-Path $SecretsFile) {
  Get-Content $SecretsFile |
    Where-Object { $_ -match '^\s*[A-Za-z_][A-Za-z0-9_]*=' } |
    ForEach-Object { $kv = $_ -split '=', 2; $secrets[$kv[0].Trim()] = $kv[1].Trim() }
}

$failed = @()

# ------------------------------------------------------------------ GitHub ---
if ($Skip -contains 'GitHub') {
  Write-Warn2 'skipping GitHub (-Skip GitHub)'
}
else {
  try {
    # gh talks to api.github.com, which stays reachable even when github.com's
    # git endpoint is being reset (a very common failure mode on some networks).
    & gh release edit $Tag -R "$Owner/$Repo" --title $Title --notes-file $bodyFile 2>&1 |
      ForEach-Object { Write-Step "GitHub: $_" }
    if ($LASTEXITCODE -ne 0) { throw "gh release edit failed (exit $LASTEXITCODE)" }
    Write-Ok 'GitHub: notes updated'
  }
  catch {
    Write-Warn2 "GitHub: $($_.Exception.Message)"
    $failed += 'GitHub'
  }
}

# ----------------------------------------------------- Gitee / GitCode (v5) ---
foreach ($p in @(
    @{ Name = 'Gitee'; Base = 'https://gitee.com/api/v5'; Token = $secrets['GITEE_TOKEN']; Body = $bodyFile },
    @{ Name = 'GitCode'; Base = 'https://api.gitcode.com/api/v5'; Token = $secrets['GITCODE_TOKEN']; Body = $gitcodeBodyFile }
  )) {
  if ($Skip -contains $p.Name) { Write-Warn2 "skipping $($p.Name) (-Skip $($p.Name))"; continue }
  if (-not $p.Token) { Write-Warn2 "$($p.Name): no token in secrets file, skipping"; continue }
  try {
    # Resolve the numeric id when the platform exposes one (Gitee does; GitCode
    # does not, and accepts the tag as the handle).
    $id = $null
    try {
      $rel = Invoke-RestMethod -Method Get -TimeoutSec 40 `
        -Uri ("{0}/repos/{1}/{2}/releases/tags/{3}?access_token={4}" -f $p.Base, $Owner, $Repo, $Tag, $p.Token)
      if ($rel -is [array]) { $rel = $rel | Select-Object -First 1 }
      if ($rel.id) { $id = $rel.id }
    }
    catch { Write-Warn2 "$($p.Name): could not read the release (will still try to update)" }

    $patchUrl = if ($id) { "{0}/repos/{1}/{2}/releases/{3}" -f $p.Base, $Owner, $Repo, $id }
      else { "{0}/repos/{1}/{2}/releases/{3}" -f $p.Base, $Owner, $Repo, $Tag }

    $out = & curl.exe -sS -w "`nHTTP:%{http_code}" -X PATCH $patchUrl `
      --data-urlencode "access_token=$($p.Token)" `
      --data-urlencode "tag_name=$Tag" `
      --data-urlencode "name=$Title" `
      --data-urlencode "body@$($p.Body)" 2>&1 | Out-String
    $code = ([regex]::Match($out, 'HTTP:(\d+)')).Groups[1].Value
    if ($code -notmatch '^2') { throw "HTTP $code" }
    Write-Ok "$($p.Name): notes updated ($(if ($id) { "id $id" } else { "by tag" }))"
  }
  catch {
    Write-Warn2 "$($p.Name): $($_.Exception.Message)"
    $failed += $p.Name
  }
}

if ($failed.Count -gt 0) {
  Write-Warn2 "notes updated with failures on: $($failed -join ', ')"
  exit 1
}
Write-Ok "release notes for $Tag updated on all platforms"
