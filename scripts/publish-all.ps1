# publish-all.ps1 -- three-platform release: push code, build this platform's
# artifacts, then publish the release + assets to GitHub / Gitee / GitCode.
#
# Flow:
#   1. (optional) push current branch + tags to GitHub / Gitee / GitCode
#      (re-uses push-all.ps1; skip with -NoPush)
#   2. (optional) build artifacts for the current platform
#      (npm run dist:win|mac|linux; skip with -NoBuild; force with -Platform)
#   3. (optional) create a release tagged v<package.json version> on GitHub,
#      Gitee and GitCode, and upload every artifact in dist/
#      (skip with -NoRelease)
#
# Usage:
#   powershell -File scripts/publish-all.ps1
#   powershell -File scripts/publish-all.ps1 -NoPush
#   powershell -File scripts/publish-all.ps1 -NoBuild
#   powershell -File scripts/publish-all.ps1 -NoRelease
#   powershell -File scripts/publish-all.ps1 -Platform win|mac|linux
#   powershell -File scripts/publish-all.ps1 -SecretsFile C:\path\push-credentials.txt
#   powershell -File scripts/publish-all.ps1 -NotesFile CHANGELOG.md
#
# Credentials (push-credentials.txt, same file as push-all.ps1):
#   GITHUB_TOKEN=xxx / GITEE_TOKEN=xxx / GITCODE_TOKEN=xxx
# Platforms without a token are skipped for publish (push phase falls back to
# the credential manager). NEVER commit the secrets file.

param(
  [string]$SecretsFile = '',
  [ValidateSet('', 'win', 'mac', 'linux')][string]$Platform = '',
  [switch]$NoPush,
  [switch]$NoBuild,
  [switch]$NoRelease,
  [string]$NotesFile = '',
  # Platform NAMES to skip in the publish phase, e.g. -Skip GitHub when
  # github.com is unreachable. Importantly this also prevents `gh release
  # create` from fabricating the tag on the remote: gh creates a missing tag
  # from the default branch, which would publish a vX.Y.Z tag pointing at the
  # OLD commit. Skipping is the safe behaviour when the code push did not land.
  [string[]]$Skip = @()
)

$ErrorActionPreference = 'Stop'
# scripts/ lives directly under the repo root.
$RepoRoot = Split-Path $PSScriptRoot -Parent
$DistDir = Join-Path $RepoRoot 'dist'
# Secrets file defaults next to the repo (same convention as push-all.ps1:
# <parent of repo>/push-credentials.txt, outside the repository).
$DefaultSecrets = Join-Path (Split-Path $RepoRoot -Parent) 'push-credentials.txt'
if (-not $SecretsFile) { $SecretsFile = $DefaultSecrets }

function Write-Step([string]$msg) { Write-Host "[publish] $msg" -ForegroundColor Cyan }
function Write-Ok([string]$msg)   { Write-Host "[ok]     $msg" -ForegroundColor Green }
function Write-Warn([string]$msg) { Write-Host "[warn]   $msg" -ForegroundColor Yellow }

# ---------------------------------------------------------------- platform --
function Get-CurrentPlatform {
  if ($IsWindows -or $env:OS -like 'Windows*') { return 'win' }
  if ($IsMacOS) { return 'mac' }
  if ($IsLinux) { return 'linux' }
  $u = uname -s 2>$null
  if ($u -like 'Darwin*') { return 'mac' }
  if ($u -like 'Linux*') { return 'linux' }
  return 'win'
}

$platform = $Platform
if (-not $platform) { $platform = Get-CurrentPlatform }
Write-Step "target platform: $platform"

# -------------------------------------------------------------- secrets ----
$secrets = @{}
if (Test-Path $SecretsFile) {
  # Read as UTF-8 explicitly: Windows PowerShell 5.1 defaults to ANSI, and a UTF-8 BOM
  # makes the first line's key invisible to the `^\s*KEY=` match below (silently dropping
  # a platform's token, which then looked like "skipped" instead of "failed").
  Get-Content $SecretsFile -Encoding UTF8 |
    Where-Object { $_ -match '^\s*[A-Za-z_][A-Za-z0-9_]*=' } |
    ForEach-Object {
      $kv = $_ -split '=', 2
      $secrets[$kv[0].Trim()] = $kv[1].Trim()
    }
  Write-Ok "secrets loaded: $SecretsFile"
}
else {
  Write-Warn "no secrets file: $SecretsFile (publish phase will skip token-less platforms)"
}

# ---------------------------------------------------------------- version ----
$package = Get-Content (Join-Path $RepoRoot 'package.json') -Raw | ConvertFrom-Json
$version = [string]$package.version
$tag = "v$version"
$releaseName = "DSH Ready GUI $version"
Write-Step "version: $version (release tag: $tag)"

# ---------------------------------------------------------------- push -----
if (-not $NoPush) {
  Write-Step 'pushing branch + tags to GitHub / Gitee / GitCode'
  & powershell.exe -NoProfile -File (Join-Path $PSScriptRoot 'push-all.ps1') -SecretsFile $SecretsFile -Skip $Skip
  if ($LASTEXITCODE -ne 0) { throw 'push-all.ps1 failed' }
  Write-Ok 'pushed to all three remotes'
}
else {
  Write-Warn 'skipping push (-NoPush)'
}

# ensure the tag exists for the release phase (create locally if absent)
if (git -C $RepoRoot rev-parse -q --verify "refs/tags/$tag") {
  Write-Ok "tag $tag already exists"
}
else {
  Write-Step "creating tag $tag locally"
  git -C $RepoRoot tag "$tag"
  if (-not $NoPush) { git -C $RepoRoot push origin "$tag" }
}

# ---------------------------------------------------------------- build ----
if (-not $NoBuild) {
  $script = switch ($platform) {
    'win'   { 'dist:win' }
    'mac'   { 'dist:mac' }
    'linux' { 'dist:linux' }
  }
  Write-Step "building artifacts (npm run $script)"
  Push-Location $RepoRoot
  try {
    & npm.cmd run $script
    if ($LASTEXITCODE -ne 0) { throw "npm run $script failed (exit $LASTEXITCODE)" }
  }
  finally { Pop-Location }
  Write-Ok "build finished for $platform"
}
else {
  Write-Warn 'skipping build (-NoBuild)'
}

# --------------------------------------------------------- collect assets ----
function Get-ReleaseAssets([string]$platform) {
  $patterns = switch ($platform) {
    'win'   { @('*.exe', '*.zip', 'DSH-READY-GUI-WIN*') }
    'mac'   { @('*.dmg', '*.zip', 'DSH-READY-GUI-MAC*') }
    'linux' { @('*.AppImage', '*.zip', 'DSH-READY-GUI-LINUX*') }
  }
  $found = @()
  foreach ($p in $patterns) {
    $found += Get-ChildItem -Path $DistDir -Filter $p -File -ErrorAction SilentlyContinue
  }
  # De-dupe by full name (the per-platform folder zips created by
  # fix-unpacked.mjs are DSH-READY-GUI-WIN.zip / DSH-READY-GUI-MAC.zip / DSH-READY-GUI-LINUX.zip
  # and match the platform patterns too).
  $seen = @{}
  $assets = @()
  foreach ($f in $found) {
    if ($seen.ContainsKey($f.FullName)) { continue }
    $seen[$f.FullName] = $true
    $assets += $f
  }
  return $assets
}

$assets = Get-ReleaseAssets $platform
if (-not $NoRelease -and $assets.Count -eq 0) {
  throw "no release assets found under dist/ for platform '$platform' (build first, or run with -NoBuild when dist/ already has artifacts)"
}

# --------------------------------------------------------------- publish ----
if ($NoRelease) {
  Write-Warn 'skipping release phase (-NoRelease)'
  Write-Ok "done (push+build only). tag: $tag"
  exit 0
}

$notes = ''
if ($NotesFile -and (Test-Path $NotesFile)) {
  # Read as UTF-8 explicitly; PowerShell 5.1 defaults to ANSI/GBK and would
  # garble a UTF-8 changelog (observable as mojibake on Gitee/GitCode).
  $notes = Get-Content $NotesFile -Raw -Encoding UTF8
}
if (-not $notes) {
  $notes = "DSH Ready GUI $version`n`nRelease artifacts: $($assets.Name -join ', ')"
}

# The body must reach curl as raw UTF-8 bytes. Passing it through a PS 5.1
# string argument re-encodes it with the system ANSI codepage (mojibake), so we
# stage an UTF-8 (no BOM) temp file and feed it to curl via --data-urlencode
# "body@<file>", which curl reads byte-for-byte.
$bodyFile = Join-Path $env:TEMP "publish-body-$Tag.txt"
[System.IO.File]::WriteAllText($bodyFile, $notes, (New-Object System.Text.UTF8Encoding($false)))

function Publish-GiteeLikeRelease {
  param(
    [string]$ApiBase,
    [string]$Owner,
    [string]$Repo,
    [string]$Token,
    [string]$Tag,
    [string]$Name,
    [string]$BodyFile,
    [array]$AssetFiles,
    [string]$Label,
    [bool]$SupportsAttachments = $true,
    # Largest single attachment the platform accepts. Gitee rejects anything over
    # 100 MB with `{"message":"验证失败：文件大小已超出限制：100 MB"}`, and our
    # installers are 139–202 MB, so they can never be attached there. Skipping
    # them up front turns a confusing bare 400 into an explicit, expected message.
    [long]$MaxAssetBytes = 0
  )
  if (-not $Token) { throw "${Label}: no token in the secrets file - cannot publish" }
  $releaseUrl = "$ApiBase/repos/$Owner/$Repo/releases"

  # Gitee/GitCode v5 accept releases via form-urlencoded (application/json is
  # rejected with a bare 400 on both platforms), so create with curl --data-urlencode.
  # The body is read from an UTF-8 temp file (BodyFile) so non-ASCII text is
  # preserved exactly.
  $createOut = & curl.exe -sS -f -X POST $releaseUrl `
    --data-urlencode "access_token=$Token" `
    --data-urlencode "tag_name=$Tag" `
    --data-urlencode "target_commitish=master" `
    --data-urlencode "name=$Name" `
    --data-urlencode "body@$BodyFile" `
    --data-urlencode "prerelease=false" 2>&1
  $createCode = $LASTEXITCODE

  $releaseId = $null
  # GitCode returns the created release WITHOUT an `id` field (only tag_name,
  # name, body, author, assets, …). Requiring an id there made a perfectly
  # successful creation look like a failure and then fail again on the lookup.
  # So: a create call that exits 0 is a success; the id is only needed to attach
  # files, and GitCode does not support attachments at all.
  $created = $false
  if ($createCode -eq 0) {
    $created = $true
    try {
      $release = $createOut | ConvertFrom-Json
      $releaseId = $release.id
      if ($releaseId) {
        Write-Ok "${Label}: release created (id ${releaseId})"
      }
      else {
        Write-Ok "${Label}: release created (tag $Tag; platform returned no id)"
      }
    }
    catch {
      Write-Ok "${Label}: release created (unparsable response body)"
    }
  }
  else {
    Write-Warn "${Label}: create failed (exit ${createCode}): $createOut"
  }

  if (-not $created) {
    # The tag release may already exist; reuse it instead of failing the run.
    Write-Warn "${Label}: trying to reuse existing release"
    try {
      # NOTE: the `?` must be backtick-escaped inside the interpolated string,
      # otherwise PowerShell 5.1 parses `$releaseUrl?` as a drive-qualified
      # variable and mangles the resulting URI.
      $existing = Invoke-RestMethod -Method Get -Uri "${releaseUrl}`?access_token=$Token" -Headers @{ 'Content-Type' = 'application/json;charset=UTF-8' }
      # Gitee returns a flat array; other v5 clones wrap the list.
      $list = if ($existing -is [array]) { $existing }
        elseif ($existing.releases) { @($existing.releases) }
        elseif ($existing.data) { @($existing.data) }
        else { @($existing) }
      $match = $list | Where-Object { $_.tag_name -eq $Tag } | Select-Object -First 1
      if (-not $match) { throw "release $Tag not found on ${Label}" }
      $releaseId = $match.id
      Write-Ok "${Label}: reusing existing release$(if ($releaseId) { " (id $releaseId)" } else { '' })"

      # Refresh the published title/notes on a reused release. Without this a
      # re-run against an already-published tag silently keeps the OLD body,
      # which is how a corrected release note can stay stale forever.
      # `tag_name` is REQUIRED by Gitee's update endpoint - omitting it returns
      # HTTP 200 with the untouched release (a silent no-op).
      if ($releaseId) {
        $patchUrl = "$releaseUrl/$releaseId"
      }
      else {
        # Some clones (GitCode) expose no id but accept the tag as the handle.
        $patchUrl = "$releaseUrl/$Tag"
      }
      $patchOut = & curl.exe -sS -f -X PATCH $patchUrl `
        --data-urlencode "access_token=$Token" `
        --data-urlencode "tag_name=$Tag" `
        --data-urlencode "name=$Name" `
        --data-urlencode "body@$BodyFile" 2>&1
      if ($LASTEXITCODE -eq 0) {
        Write-Ok "${Label}: release notes refreshed"
      }
      else {
        Write-Warn "${Label}: could not refresh release notes: $patchOut"
      }
    }
    catch {
      throw "${Label}: cannot create or find release $Tag : $($_.Exception.Message)"
    }
  }

  if (-not $SupportsAttachments) {
    Write-Warn "${Label}: platform does not support release attachments - skipping asset uploads (installers are downloadable from GitHub Releases)"
    return
  }
  if (-not $releaseId) {
    Write-Warn "${Label}: release has no id, cannot attach files - skipping asset uploads"
    return
  }

  foreach ($asset in $AssetFiles) {
    if ($MaxAssetBytes -gt 0 -and $asset.Length -gt $MaxAssetBytes) {
      Write-Warn ("{0}: skipping {1} ({2:N0} bytes > platform limit {3:N0} bytes) - installers stay on GitHub Releases" -f $Label, $asset.Name, $asset.Length, $MaxAssetBytes)
      continue
    }
    Write-Step "${Label}: uploading $($asset.Name)"
    $uploadUrl = "$ApiBase/repos/$Owner/$Repo/releases/$releaseId/attach_files"
    $err = & curl.exe -sS -f -X POST $uploadUrl -F "access_token=$Token" -F "file=@$($asset.FullName)" 2>&1
    if ($LASTEXITCODE -ne 0) {
      Write-Warn "${Label}: upload failed for $($asset.Name): $err"
    }
    else {
      Write-Ok "${Label}: uploaded $($asset.Name)"
    }
  }
}

function Publish-GitHubRelease {
  param(
    [string]$Owner,
    [string]$Repo,
    [string]$Token,
    [string]$Tag,
    [string]$Name,
    [string]$BodyFile,
    [array]$AssetFiles,
    [string]$Label
  )
  # GitHub-specific: when no token is present, fall back to the GitHub CLI
  # (gh) if it is installed and authenticated, so publish still works.
  $useGh = $false
  if (-not $Token) {
    $gh = Get-Command gh -ErrorAction SilentlyContinue
    if ($gh) {
      gh auth status 2>$null | Out-Null
      if ($LASTEXITCODE -eq 0) {
        $useGh = $true
        Write-Warn "${Label}: no API token, using authenticated 'gh' CLI"
      }
      else {
        Write-Warn "${Label}: no token and gh not authenticated - cannot publish"
        throw "${Label}: no credentials"
      }
    }
    else {
      Write-Warn "${Label}: no token and no gh CLI - cannot publish"
      throw "${Label}: no credentials"
    }
  }

  if ($useGh) {
    $assetArgs = @()
    foreach ($a in $AssetFiles) { $assetArgs += $a.FullName }
    try {
      # notes are read from the staged UTF-8 BodyFile (gh --notes-file), so
      # non-ASCII release notes stay intact.
      & gh release create $Tag -R "$Owner/$Repo" --title $Name --notes-file $BodyFile @assetArgs 2>&1 | ForEach-Object { Write-Step "${Label}: $_" }
      if ($LASTEXITCODE -ne 0) { throw "gh release create failed (exit $LASTEXITCODE)" }
      Write-Ok "${Label}: release $Tag published via gh"
    }
    catch {
      # existing release: try uploading assets to it
      Write-Warn "${Label}: gh create failed ($($_.Exception.Message)) - reusing existing release"
      $upArgs = @()
      foreach ($a in $AssetFiles) { $upArgs += $a.FullName }
      & gh release upload $Tag -R "$Owner/$Repo" --clobber @upArgs 2>&1 | ForEach-Object { Write-Step "${Label}: $_" }
      if ($LASTEXITCODE -ne 0) { throw "gh release upload failed (exit $LASTEXITCODE)" }
      Write-Ok "${Label}: assets uploaded to existing release $Tag"
    }
    return
  }

  # API path: read the notes as UTF-8 from the staged file (PowerShell 5.1
  # string interpolation would re-encode to ANSI when building the JSON).
  $bodyText = Get-Content -Raw -Encoding UTF8 $BodyFile
  $headers = @{
    Authorization  = "Bearer $Token"
    Accept         = 'application/vnd.github+json'
    'Content-Type' = 'application/json;charset=UTF-8'
  }
  $payload = @{
    tag_name   = $Tag
    name       = $Name
    body       = $bodyText
    draft      = $false
    prerelease = $false
  } | ConvertTo-Json

  $releaseUrl = "https://api.github.com/repos/$Owner/$Repo/releases"
  $releaseId = $null
  try {
    $release = Invoke-RestMethod -Method Post -Uri $releaseUrl -Headers $headers -Body $payload
    $releaseId = $release.id
    Write-Ok "${Label}: release created (id ${releaseId})"
  }
  catch {
    Write-Warn "${Label}: create failed ($($_.Exception.Message)) - looking for existing release"
    try {
      $list = Invoke-RestMethod -Method Get -Uri $releaseUrl -Headers $headers -ErrorAction Stop
      $existing = $list | Where-Object { $_.tag_name -eq $Tag } | Select-Object -First 1
      if (-not $existing) { throw 'not found' }
      $releaseId = $existing.id
      Write-Ok "${Label}: reusing existing release (id ${releaseId})"
    }
    catch {
      throw "${Label}: cannot create or find release ${Tag}: $($_.Exception.Message)"
    }
  }

  foreach ($asset in $AssetFiles) {
    Write-Step "${Label}: uploading $($asset.Name)"
    $safeName = [uri]::EscapeDataString($asset.Name)
    $uploadUrl = "https://uploads.github.com/repos/$Owner/$Repo/releases/$releaseId/assets?name=$safeName"
    $uplHeaders = @{
      Authorization  = "Bearer $Token"
      Accept         = 'application/vnd.github+json'
      'Content-Type' = 'application/octet-stream'
    }
    try {
      $null = Invoke-RestMethod -Method Post -Uri $uploadUrl -Headers $uplHeaders -InFile $asset.FullName
      Write-Ok "${Label}: uploaded $($asset.Name)"
    }
    catch {
      Write-Warn "${Label}: upload failed for $($asset.Name): $($_.Exception.Message)"
    }
  }
}

$owner = 'itchenshi'
$repo  = 'dsh-ready-gui'

Write-Step "publishing release $tag to GitHub / Gitee / GitCode"
Write-Ok "assets: $($assets.Name -join ', ')"

# Each platform runs independently: a failure on one platform must not stop
# the others, so every publish is wrapped in its own try/catch below.
$failedPlatforms = @()

if ($Skip -contains 'GitHub') {
  Write-Warn 'skipping GitHub (-Skip GitHub)'
} else {
  try {
    Publish-GitHubRelease -Owner $owner -Repo $repo -Token $secrets['GITHUB_TOKEN'] `
      -Tag $tag -Name $releaseName -BodyFile $bodyFile -AssetFiles $assets -Label 'GitHub'
  }
  catch {
    Write-Warn "GitHub publish failed: $($_.Exception.Message)"
    $failedPlatforms += 'GitHub'
  }
}

if ($Skip -contains 'Gitee') {
  Write-Warn 'skipping Gitee (-Skip Gitee)'
} else {
  try {
    Publish-GiteeLikeRelease -ApiBase 'https://gitee.com/api/v5' -Owner $owner -Repo $repo `
      -Token $secrets['GITEE_TOKEN'] -Tag $tag -Name $releaseName -BodyFile $bodyFile `
      -AssetFiles $assets -Label 'Gitee' -MaxAssetBytes 104857600
  }
  catch {
    Write-Warn "Gitee publish failed: $($_.Exception.Message)"
    $failedPlatforms += 'Gitee'
  }
}

if ($Skip -contains 'GitCode') {
  Write-Warn 'skipping GitCode (-Skip GitCode)'
} else {
  try {
    # GitCode releases do NOT support attachment uploads, so the body carries
    # the changelog plus a pointer to GitHub Releases for the installers; stage
    # that variant as its own UTF-8 file so non-ASCII notes survive.
    $gitcodeBodyFile = Join-Path $env:TEMP "publish-gitcode-body-$Tag.txt"
    $gitcodeNotes = $notes + "`n`n---`nInstallers: download from GitHub Releases - https://github.com/$owner/$repo/releases/tag/$tag"
    [System.IO.File]::WriteAllText($gitcodeBodyFile, $gitcodeNotes, (New-Object System.Text.UTF8Encoding($false)))
    Publish-GiteeLikeRelease -ApiBase 'https://api.gitcode.com/api/v5' -Owner $owner -Repo $repo `
      -Token $secrets['GITCODE_TOKEN'] -Tag $tag -Name $releaseName -BodyFile $gitcodeBodyFile `
      -AssetFiles $assets -Label 'GitCode' -SupportsAttachments $false
  }
  catch {
    Write-Warn "GitCode publish failed: $($_.Exception.Message)"
    $failedPlatforms += 'GitCode'
  }
}

if ($failedPlatforms.Count -gt 0) {
  Write-Warn "release $tag published with failures on: $($failedPlatforms -join ', ')"
  exit 1
}
Write-Ok "release $tag published (see per-platform results above)"