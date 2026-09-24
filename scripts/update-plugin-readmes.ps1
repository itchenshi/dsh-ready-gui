#!/usr/bin/env pwsh
<#
.SYNOPSIS
  重写四个插件 README 的「装上就能用」安装段，并加上回链 GUI 的导流行。

.DESCRIPTION
  做两件事：
    1. 安装段：去掉只给 `git clone` 的写法，改成「两条命令都给」
       —— github: 直装（推荐） + release tarball（网络受限时兜底）。
       注：2026-09-24 复核发现本机 github.com 已可达，所以**不再断言被封**，
       只按事实说明「两条路都可用，受限时用 tarball」。
    2. 导流：在 README 顶部加一行回链 DSH Ready GUI（四个插件仓库目前互不相通）。

  用法：
    ./scripts/update-plugin-readmes.ps1 -WhatIfOnly
    ./scripts/update-plugin-readmes.ps1
#>
[CmdletBinding()]
param(
  [string] $ReposRoot = (Join-Path (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent) 'plugin-repos'),
  [switch] $WhatIfOnly
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

# 每个插件的 tarball 版本（与本仓库 release 上的资产名对应）
$Plugins = @(
  @{ Name = 'dsh-model-surplus';    Version = '0.3.2'; Display = '模型余量'; DisplayEn = 'Model surplus' },
  @{ Name = 'dsh-gui-last-session'; Version = '0.1.2'; Display = '会话续接'; DisplayEn = 'Session resume' },
  @{ Name = 'dsh-opencode-go-path'; Version = '0.1.4'; Display = 'OpenCode Go 路由'; DisplayEn = 'OpenCode Go route' },
  @{ Name = 'dsh-keys-setting';     Version = '0.2.0'; Display = '按键设置'; DisplayEn = 'Key bindings' }
)

$ReposRoot = (Resolve-Path $ReposRoot).Path

function New-InstallBlockZh($name, $version) {
  $gh  = "dsh plugin --profile web add github:itchenshi/$name"
  $tar = "https://github.com/itchenshi/$name/releases/download/v$version/$name-$version.tar.gz"
  $tmpl = @'
- **其它 DSH 宿主**（`dsh web` / CLI）—— 两条路都行，任选一条：

  ```sh
  # 推荐：直接从 GitHub 装（记进 profile，之后可跟着更新）
  @@GH@@

  # 备选：从本仓库 Release 的 tarball 装（网络受限连不上 github.com 时用这条）
  dsh plugin --profile web add @@TAR@@
  ```

  两条命令装到的都是这个仓库的完整内容（含 `cordis.patch.yml`），装完不需要额外配置。
'@
  $tmpl.Replace('@@GH@@', $gh).Replace('@@TAR@@', $tar)
}

function New-InstallBlockEn($name, $version) {
  $gh  = "dsh plugin --profile web add github:itchenshi/$name"
  $tar = "https://github.com/itchenshi/$name/releases/download/v$version/$name-$version.tar.gz"
  $tmpl = @'
- **Any other DSH host** (`dsh web`, the CLI) — either route works:

  ```sh
  # Recommended: install straight from GitHub (recorded in your profile, updatable)
  @@GH@@

  # Fallback: install the release tarball (use this if github.com is unreachable for you)
  dsh plugin --profile web add @@TAR@@
  ```

  Both land the full repository contents (including `cordis.patch.yml`); no extra configuration
  is needed afterwards.
'@
  $tmpl.Replace('@@GH@@', $gh).Replace('@@TAR@@', $tar)
}

foreach ($p in $Plugins) {
  $name = $p.Name
  $dir = Join-Path $ReposRoot $name
  Write-Host "`n>>> $name" -ForegroundColor Cyan
  if (-not (Test-Path $dir)) { Write-Host "    目录不存在，跳过" -ForegroundColor Yellow; continue }

  foreach ($pair in @(@{ File='README.md'; En=$false }, @{ File='README.en.md'; En=$true })) {
    $path = Join-Path $dir $pair.File
    if (-not (Test-Path $path)) { Write-Host "    $($pair.File) 不存在，跳过" -ForegroundColor Yellow; continue }

    $text = [System.IO.File]::ReadAllText($path, [System.Text.Encoding]::UTF8)

    # ---- 1. 替换安装段 -----------------------------------------------------
    # 匹配从「- **其它 DSH 宿主」/「- **Any other DSH host」开始，
    # 到「空行 + > npm 上暂时没有」之前的整块（文件是 CRLF）。
    if ($pair.En) {
      $pattern = '(?ms)^- \*\*Any other DSH host\*\*.*?(?=\r?\n\r?\n> Not on npm yet)'
      $replacement = (New-InstallBlockEn $name $p.Version)
    } else {
      $pattern = '(?ms)^- \*\*其它 DSH 宿主\*\*.*?(?=\r?\n\r?\n> npm 上暂时没有)'
      $replacement = (New-InstallBlockZh $name $p.Version)
    }
    # 保持 CRLF 行尾
    if ($text.Contains("`r`n")) { $replacement = $replacement -replace "`r?`n", "`r`n" }

    if ($text -match $pattern) {
      $new = [regex]::Replace($text, $pattern, $replacement, 1)
      Write-Host "    $($pair.File): 安装段已替换" -ForegroundColor Green
    } else {
      $new = $text
      Write-Host "    $($pair.File): 未匹配到安装段（可能已改过），跳过替换" -ForegroundColor Yellow
    }

    # ---- 2. npm 说明：措辞已与事实一致，无需改动（保留占位）------------------

    # ---- 3. 顶部加回链 GUI 的导流行 ----------------------------------------
    # 锚点是文件开头那两行 badge（文件为 CRLF，故锚点也要用 CRLF）
    $eol = if ($text.Contains("`r`n")) { "`r`n" } else { "`n" }
    $nl = $eol
    $badgePair = "[![English](https://img.shields.io/badge/README-English-green)](README.en.md)$nl[![中文](https://img.shields.io/badge/README-中文-blue)](README.md)"
    $noteZh = ("> 这是 **DSH Ready GUI** 的组成部分之一 —— GUI 开箱内置四个插件，勾选即用。$nl" +
               "> 也可单独装到任何 DSH 宿主里（见下方「装上就能用」）。$nl" +
               "> GUI：https://github.com/itchenshi/dsh-ready-gui")
    $noteEn = ("> One of the plugins bundled with **DSH Ready GUI** — the GUI ships all four, ready to tick.$nl" +
               "> Each one also installs standalone into any DSH host (see `"Install and go`" below).$nl" +
               "> GUI: https://github.com/itchenshi/dsh-ready-gui")

    # 只在还没有该链接时插入（幂等）
    if ($new -notmatch 'dsh-ready-gui') {
      $note = if ($pair.En) { $noteEn } else { $noteZh }
      $replacement = $badgePair + $nl + $nl + $note
      if ($new.Contains($badgePair)) {
        $new = $new.Replace($badgePair, $replacement)
        Write-Host "    $($pair.File): 已加 GUI 回链" -ForegroundColor Green
      } else {
        Write-Host "    $($pair.File): 回链锚点未匹配" -ForegroundColor Yellow
      }
    } else {
      Write-Host "    $($pair.File): 已有 GUI 链接，跳过" -ForegroundColor DarkGray
    }

    if ($WhatIfOnly) {
      Write-Host "    [WhatIf] 不写入 $path" -ForegroundColor DarkGray
    } else {
      if ($new -ne $text) {
        $enc = New-Object System.Text.UTF8Encoding($false)
        [System.IO.File]::WriteAllText($path, $new, $enc)
        Write-Host "    已写入 $($pair.File)" -ForegroundColor Green
      } else {
        Write-Host "    无变化" -ForegroundColor DarkGray
      }
    }
  }
}

Write-Host "`n完成。别忘了校验：安装段里的 tarball URL 要能 200。" -ForegroundColor Cyan
