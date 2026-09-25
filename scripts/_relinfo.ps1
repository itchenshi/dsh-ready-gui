$ErrorActionPreference = 'Continue'
$repo = 'itchenshi/dsh-gateway-models'

Write-Output "=== workflow 运行历史 ==="
$runsJson = gh api "repos/$repo/actions/runs?per_page=8" 2>&1 | Out-String
try {
  $runs = ($runsJson | ConvertFrom-Json).workflow_runs
  if ($runs.Count -eq 0) { Write-Output '  (没有任何运行记录)' }
  else {
    foreach ($r in $runs) {
      $state = $r.conclusion
      if (-not $state) { $state = $r.status }
      Write-Output ("  {0}  {1}  {2}  {3}" -f $r.name, $r.head_branch, $state, $r.created_at)
    }
  }
} catch { Write-Output "  解析失败: $($runsJson.Substring(0, [Math]::Min(200, $runsJson.Length)))" }

Write-Output ''
Write-Output '=== 现有 release 及资产 ==='
$relJson = gh api "repos/$repo/releases" 2>&1 | Out-String
try {
  $rels = $relJson | ConvertFrom-Json
  foreach ($x in $rels) {
    Write-Output ("  tag={0}  draft={1}" -f $x.tag_name, $x.draft)
    if ($x.assets.Count -eq 0) { Write-Output '    (无资产)' }
    else { foreach ($a in $x.assets) { Write-Output ("    {0}  {1} KB" -f $a.name, [math]::Round($a.size / 1KB)) } }
  }
} catch { Write-Output "  解析失败: $($relJson.Substring(0, [Math]::Min(200, $relJson.Length)))" }
