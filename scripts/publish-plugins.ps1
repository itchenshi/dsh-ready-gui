# publish-plugins.ps1 -- first/next release of the four split-out plugins to npm.
#
# The four plugins live in their own repositories, siblings of this one:
#   ../dsh-model-usage  ../dsh-gui-last-session
#   ../dsh-opencode-go-path  ../dsh-composer-keys-setting
#
# WHY --registry IS FORCED EVERYWHERE:
#   A China-mirror npmrc (registry=https://registry.npmmirror.com) is common and
#   harmless for installs, but it breaks publishing twice over:
#     1. `npm login` would authenticate against the mirror, and the token it
#        stores is not valid on the official registry;
#     2. mirrors do not accept publishes at all.
#   So every npm call below passes --registry explicitly, and the availability /
#   verification checks go straight to the official host instead of the mirror
#   (which also lags behind, so it cannot be used to confirm a publish).
#
# Usage:
#   powershell -File scripts/publish-plugins.ps1                 # publish all four
#   powershell -File scripts/publish-plugins.ps1 -DryRun         # check only
#   powershell -File scripts/publish-plugins.ps1 -Only dsh-model-usage
#
# Prerequisites:
#   npm login --registry=https://registry.npmjs.org
#   (run that exact form -- without --registry the login goes to the mirror)
#
# After a successful first publish, consider switching each package to npm
# "trusted publishing" (OIDC) in its settings on npmjs.com so the GitHub Actions
# workflow in .github/workflows/publish.yml can release without a stored token.

param(
  # Print every action without publishing anything.
  [switch]$DryRun,
  # Restrict to these package names (default: all four).
  [string[]]$Only = @(),
  # Do not check the working tree / remote sync state before publishing.
  [switch]$SkipGitChecks
)

$ErrorActionPreference = 'Stop'

$OfficialRegistry = 'https://registry.npmjs.org'
$RepoRoot = Split-Path $PSScriptRoot -Parent
$Parent = Split-Path $RepoRoot -Parent

# Display order = the order the DSH GUI lists them in (see src/plugin-manager.js).
$Packages = @(
  'dsh-model-usage',
  'dsh-gui-last-session',
  'dsh-opencode-go-path',
  'dsh-composer-keys-setting'
)
if ($Only.Count -gt 0) {
  foreach ($name in $Only) {
    if ($Packages -notcontains $name) {
      throw "unknown package '$name'; known: $($Packages -join ', ')"
    }
  }
  $Packages = $Packages | Where-Object { $Only -contains $_ }
}

function Get-Packument([string]$Name) {
  try {
    return Invoke-RestMethod -Uri "$OfficialRegistry/$Name" -TimeoutSec 30 -ErrorAction Stop
  } catch {
    $code = $_.Exception.Response.StatusCode.value__
    if ($code -eq 404) { return $null }
    throw "cannot read the official registry for ${Name}: $($_.Exception.Message)"
  }
}

# Windows PowerShell 5.1 turns a native command's stderr into a *terminating*
# error while $ErrorActionPreference is 'Stop' -- and `npm` writes its whole
# notice/progress stream to stderr, so a bare invocation aborts the script on
# success. Run every npm call through here with the preference relaxed locally.
function Invoke-Npm {
  param([string[]]$Arguments, [string]$WorkingDirectory)
  $previous = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  Push-Location $WorkingDirectory
  try {
    $text = & npm @Arguments 2>&1 | Out-String
    $code = $LASTEXITCODE
  } finally {
    Pop-Location
    $ErrorActionPreference = $previous
  }
  return [pscustomobject]@{ Output = $text; ExitCode = $code }
}

function Invoke-Step([string]$Label, [scriptblock]$Body) {
  Write-Host "  - $Label"
  if ($DryRun) { return }
  & $Body
}

Write-Host "registry (official, forced): $OfficialRegistry"
Write-Host "plugin repos: $Parent"
if ($DryRun) { Write-Host "DRY RUN -- nothing will be published`n" } else { Write-Host '' }

# --- auth ------------------------------------------------------------------
# `npm whoami` against the OFFICIAL registry: a token minted against the mirror
# would pass a plain `npm whoami` and still fail on publish.
Write-Host 'checking npm auth against the official registry'
$whoami = Invoke-Npm -Arguments @('whoami', "--registry=$OfficialRegistry") -WorkingDirectory $RepoRoot
$who = ($whoami.Output).Trim()
if ($whoami.ExitCode -ne 0 -or $who -eq '' -or $who -match 'ENEEDAUTH|need auth') {
  $message = @"
not logged in to the official npm registry.
run this exact command (the --registry is required -- your .npmrc points at a mirror):

    npm login --registry=$OfficialRegistry

then re-run this script.
"@
  # -DryRun is a pre-flight check: report the gap and still exercise the rest.
  if ($DryRun) {
    Write-Host '  !! not logged in (dry run continues without publishing)' -ForegroundColor Yellow
    Write-Host "  $message`n"
  } else {
    throw $message
  }
} else {
  Write-Host "  logged in as: $who`n"
}

# --- per package -----------------------------------------------------------
$results = @()
foreach ($name in $Packages) {
  Write-Host "=== $name"
  $dir = Join-Path $Parent $name
  $row = [ordered]@{ package = $name; version = ''; action = ''; detail = '' }

  if (-not (Test-Path (Join-Path $dir 'package.json'))) {
    Write-Host "  !! repo not found: $dir"
    $row.action = 'FAILED'
    $row.detail = "repo not found: $dir"
    $results += [pscustomobject]$row
    continue
  }

  $manifest = Get-Content (Join-Path $dir 'package.json') -Raw | ConvertFrom-Json
  $version = $manifest.version
  $row.version = $version
  if ($manifest.name -ne $name) {
    Write-Host "  !! package.json name is '$($manifest.name)', expected '$name'"
    $row.action = 'FAILED'
    $row.detail = "name mismatch: $($manifest.name)"
    $results += [pscustomobject]$row
    continue
  }

  # git hygiene: an uncommitted or unpushed tree would publish code that is not
  # in the repository the registry entry points at.
  if (-not $SkipGitChecks) {
    Push-Location $dir
    try {
      $dirty = git status --porcelain
      $ahead = git rev-list --count 'origin/main..HEAD' 2>$null
      if ($dirty) {
        Write-Host '  !! working tree is dirty'
        $row.action = 'FAILED'
        $row.detail = 'dirty working tree'
        $results += [pscustomobject]$row
        continue
      }
      if ($ahead -and [int]$ahead -gt 0) {
        Write-Host "  !! $ahead commit(s) not pushed to origin/main"
        $row.action = 'FAILED'
        $row.detail = "unpushed commits: $ahead"
        $results += [pscustomobject]$row
        continue
      }
    } finally {
      Pop-Location
    }
  }

  # what would actually be uploaded
  $packResult = Invoke-Npm -Arguments @('pack', '--dry-run') -WorkingDirectory $dir
  $pack = $packResult.Output
  $fileCount = ([regex]::Match($pack, 'total files:\s*(\d+)')).Groups[1].Value
  $unpacked = ([regex]::Match($pack, 'unpacked size:\s*([\d.]+\s*\S+)')).Groups[1].Value
  if (-not $fileCount) {
    Write-Host '  !! npm pack --dry-run produced no file list'
    $row.action = 'FAILED'
    $row.detail = 'npm pack --dry-run failed'
    $results += [pscustomobject]$row
    continue
  }
  Write-Host "  tarball: $fileCount files, unpacked $unpacked"
  foreach ($required in @('package.json', 'cordis.patch.yml', 'README.md', 'LICENSE')) {
    if ($pack -notmatch [regex]::Escape($required)) {
      Write-Host "  !! tarball is missing $required"
      $row.action = 'FAILED'
      $row.detail = "tarball missing $required"
      $results += [pscustomobject]$row
    }
  }
  if ($row.action -eq 'FAILED') { $results += [pscustomobject]$row; continue }

  # registry state: 404 -> first publish; version present -> already released.
  $packument = Get-Packument $name
  if ($packument -and $packument.versions.PSObject.Properties.Name -contains $version) {
    Write-Host "  already published: $name@$version -- nothing to do"
    $row.action = 'SKIPPED'
    $row.detail = 'version already on npm'
    $results += [pscustomobject]$row
    continue
  }
  if ($null -eq $packument) {
    Write-Host '  first publish for this name'
  } else {
    $owners = ($packument.maintainers | ForEach-Object { $_.name }) -join ', '
    Write-Host "  existing package, maintainers: $owners (next: $version)"
  }

  if ($DryRun) {
    $row.action = 'WOULD PUBLISH'
    $row.detail = if ($null -eq $packument) { 'first publish' } else { "new version $version" }
    $results += [pscustomobject]$row
    continue
  }

  Write-Host "  publishing $name@$version ..."
  # --registry is mandatory: the .npmrc mirror does not accept publishes.
  $published = Invoke-Npm -Arguments @('publish', '--access', 'public', "--registry=$OfficialRegistry") -WorkingDirectory $dir
  if ($published.ExitCode -ne 0) {
    Write-Host "  !! npm publish failed (exit $($published.ExitCode))"
    Write-Host ($published.Output.Trim() -split "`n" | Select-Object -Last 12 | ForEach-Object { "     $_" } | Out-String).TrimEnd()
    $row.action = 'FAILED'
    $row.detail = "npm publish exit $($published.ExitCode)"
    $results += [pscustomobject]$row
    continue
  }

  # verify on the official registry (the mirror lags, so it cannot be trusted here)
  $after = Get-Packument $name
  if ($after -and $after.versions.PSObject.Properties.Name -contains $version) {
    Write-Host "  verified: https://www.npmjs.com/package/$name/v/$version"
    $row.action = 'PUBLISHED'
    $row.detail = "https://www.npmjs.com/package/$name/v/$version"
  } else {
    Write-Host '  !! publish reported success but the version is not on the official registry yet'
    $row.action = 'UNVERIFIED'
    $row.detail = 'not visible on the official registry yet'
  }
  $results += [pscustomobject]$row
}

# --- summary ---------------------------------------------------------------
Write-Host "`n=== summary ==="
$results | Format-Table -AutoSize package, version, action, detail | Out-String | Write-Host

$failed = @($results | Where-Object { $_.action -eq 'FAILED' -or $_.action -eq 'UNVERIFIED' })
if ($failed.Count -gt 0) {
  Write-Host "$($failed.Count) package(s) need attention." -ForegroundColor Yellow
  exit 1
}
if ($DryRun) { Write-Host 'dry run complete; re-run without -DryRun to publish.' }
else {
  Write-Host 'all requested packages are published and verified.'
  Write-Host ''
  Write-Host 'next steps:'
  Write-Host '  1. git tag v<version> && git push origin v<version> in each plugin repo, if you'
  Write-Host '     want the GitHub Actions workflow (OIDC + provenance) to own later releases.'
  Write-Host '  2. then push the DSH GUI v0.5.0 commit -- it installs these four from npm, so'
  Write-Host '     pushing it earlier would make existing users install packages that do not exist.'
}
