#!/usr/bin/env pwsh
<#
.SYNOPSIS
  为四个插件仓库的 release 生成并上传 tarball 资产。

.DESCRIPTION
  为什么需要这个：
    注册表（awesome-dsh-plugin）给出的安装命令是
      dsh plugin --profile web add github:<owner>/<repo>
    它依赖 pnpm 走 HTTPS 到 github.com 做 git ls-remote —— 本机 github.com 被阻断
    （实测 21 秒超时），所以国内用户照抄这行命令会失败。

    注册表的安装源优先级是：npm 包 → 作者提供的 Release tarball → 整仓源码。
    npm 通道不通、整仓源码通道被阻断，于是「作者提供的 Release tarball」是唯一
    一条不依赖 github.com 的路径 —— 但它一直是空的（0 assets）。

    本脚本把每个插件仓库打包成 tarball 并挂到对应的 release 上，补上这一档。

  用法：
    # 预览要做什么（不写任何东西）
    ./scripts/release-plugin-tarballs.ps1 -WhatIfOnly

    # 打包 + 上传
    ./scripts/release-plugin-tarballs.ps1

    # 只处理某一个
    ./scripts/release-plugin-tarballs.ps1 -Only dsh-model-surplus

.NOTES
  走 api.github.com / uploads.github.com（实测均可达），不用 git push（github.com 被阻断）。
#>
[CmdletBinding()]
param(
  [string] $ReposRoot = (Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'plugin-repos'),
  [string[]] $Only = @(),
  [switch] $WhatIfOnly
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$Owner = 'itchenshi'
$Plugins = @('dsh-model-surplus', 'dsh-gui-last-session', 'dsh-opencode-go-path', 'dsh-keys-setting')

# tarball 里必须包含的东西（收录与加载的前提）
$RequiredEntries = @('package.json', 'cordis.patch.yml', 'README.md', 'LICENSE')

function Write-Step($msg) { Write-Host "`n>>> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    OK   $msg" -ForegroundColor Green }
function Write-Warn($msg) { Write-Host "    WARN $msg" -ForegroundColor Yellow }

$ReposRoot = (Resolve-Path $ReposRoot).Path

$results = @()

foreach ($name in $Plugins) {
  if ($Only.Count -gt 0 -and $Only -notcontains $name) { continue }

  $repoDir = Join-Path $ReposRoot $name
  Write-Step "$name"

  if (-not (Test-Path $repoDir)) { Write-Warn "目录不存在：$repoDir"; continue }

  # ---- 1. 读版本与仓库信息 -------------------------------------------------
  $pkgPath = Join-Path $repoDir 'package.json'
  if (-not (Test-Path $pkgPath)) { Write-Warn "没有 package.json"; continue }
  $pkg = Get-Content $pkgPath -Raw | ConvertFrom-Json
  $version = $pkg.version
  $tag = "v$version"
  Write-Host "     version = $version (tag $tag)"

  # ---- 2. 前置校验：必需文件都在 -------------------------------------------
  $missing = @()
  foreach ($f in $RequiredEntries) {
    if (-not (Test-Path (Join-Path $repoDir $f))) { $missing += $f }
  }
  if ($missing.Count -gt 0) { Write-Warn "缺少必需文件：$($missing -join ', ')"; continue }
  Write-Ok "必需文件齐全"

  # ---- 3. 工作区干净？ ------------------------------------------------------
  $dirty = & git -C $repoDir status --porcelain
  if ($dirty) { Write-Warn "工作区有未提交改动，tarball 会包含未提交内容 —— 建议先提交" }

  # ---- 4. 用 git archive 打包（只含被追踪的文件，天然排除 .git / node_modules）----
  $outDir = Join-Path $env:TEMP "dsh-plugin-tarballs"
  New-Item -ItemType Directory -Force -Path $outDir | Out-Null
  $tarball = Join-Path $outDir "$name-$version.tar.gz"

  if ($WhatIfOnly) {
    Write-Host "    [WhatIf] 会执行：git archive --format=tar.gz -o $tarball HEAD" -ForegroundColor DarkGray
  } else {
    & git -C $repoDir archive --format=tar.gz --prefix="$name-$version/" -o $tarball HEAD
    if ($LASTEXITCODE -ne 0) { Write-Warn "git archive 失败"; continue }
    $size = (Get-Item $tarball).Length
    Write-Ok "打包完成：$tarball ($([math]::Round($size/1KB,1)) KB)"
  }

  # ---- 5. 校验 tarball 内容 -------------------------------------------------
  if (-not $WhatIfOnly) {
    $listing = & tar -tzf $tarball
    $bad = @()
    foreach ($f in $RequiredEntries) {
      if (-not ($listing | Where-Object { $_ -eq "$name-$version/$f" })) { $bad += $f }
    }
    if ($bad.Count -gt 0) { Write-Warn "tarball 内缺少：$($bad -join ', ')"; continue }
    Write-Ok "tarball 内容校验通过（含 cordis.patch.yml —— 收录前提）"
  }

  # ---- 6. 确认 release 存在 -------------------------------------------------
  $releaseJson = & gh api "repos/$Owner/$name/releases/tags/$tag" 2>$null
  if (-not $releaseJson) {
    Write-Warn "找不到 release $tag —— 请先在 $name 里创建该 tag 的 release"
    $results += [pscustomobject]@{ Plugin=$name; Version=$version; Tag=$tag; Status='no-release'; Asset=$null }
    continue
  }
  $release = $releaseJson | ConvertFrom-Json
  Write-Ok "找到 release $tag (id=$($release.id))"

  # ---- 7. 已存在同名资产？ --------------------------------------------------
  $assetName = "$name-$version.tar.gz"
  $existing = $release.assets | Where-Object { $_.name -eq $assetName }
  if ($existing) {
    Write-Warn "资产 $assetName 已存在（id=$($existing.id)），先删除再重传"
    if (-not $WhatIfOnly) {
      & gh api -X DELETE "repos/$Owner/$name/releases/assets/$($existing.id)" | Out-Null
      Write-Ok "已删除旧资产"
    }
  }

  # ---- 8. 上传 --------------------------------------------------------------
  if ($WhatIfOnly) {
    Write-Host "    [WhatIf] 会执行：gh release upload $tag $tarball" -ForegroundColor DarkGray
    $results += [pscustomobject]@{ Plugin=$name; Version=$version; Tag=$tag; Status='would-upload'; Asset=$assetName }
  } else {
    & gh release upload $tag $tarball --repo "$Owner/$name" --clobber
    if ($LASTEXITCODE -ne 0) { Write-Warn "上传失败"; $results += [pscustomobject]@{ Plugin=$name; Version=$version; Tag=$tag; Status='upload-failed'; Asset=$assetName }; continue }
    Write-Ok "上传成功：$assetName"
    $url = "https://github.com/$Owner/$name/releases/download/$tag/$assetName"
    Write-Host "    $url" -ForegroundColor DarkGray
    $results += [pscustomobject]@{ Plugin=$name; Version=$version; Tag=$tag; Status='uploaded'; Asset=$url }
  }
}

Write-Step "汇总"
$results | Format-Table -AutoSize

if (-not $WhatIfOnly) {
  Write-Host "`n下一步：验证安装（务必清 pnpm 缓存，否则会被缓存命中骗过）" -ForegroundColor Yellow
  Write-Host "  `$env:DSH_HOME = '<一个全新的空目录>'" -ForegroundColor DarkGray
  Write-Host "  pnpm store path && pnpm store prune" -ForegroundColor DarkGray
  Write-Host "  dsh plugin --profile web add <上面输出的 tarball URL>" -ForegroundColor DarkGray
}
