[CmdletBinding()]
param(
  [string]$Version = 'alpha',
  [switch]$Quiet,
  [switch]$NoZip
)

$ErrorActionPreference = 'Stop'
$Utf8Bom = [System.Text.UTF8Encoding]::new($true)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$RuntimeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$V2Root = Split-Path -Parent $RuntimeRoot
$ProjectRoot = Split-Path -Parent $V2Root
$ReleaseRoot = Join-Path $ProjectRoot 'release'
$ReportsRoot = Join-Path $V2Root 'reports\release-preflight'
$PackageName = "AI-SkillHub-$Version"
$StagingRoot = Join-Path $ReleaseRoot $PackageName
$ZipPath = Join-Path $ReleaseRoot ($PackageName + '.zip')
$ShaPath = Join-Path $ReleaseRoot ($PackageName + '.sha256.txt')
$Checks = New-Object System.Collections.Generic.List[object]

function Write-Utf8Bom([string]$Path, [string]$Text) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
  [System.IO.File]::WriteAllText($Path, $Text, $script:Utf8Bom)
}

function Add-Check([string]$Id, [string]$Status, [string]$Summary) {
  $script:Checks.Add([PSCustomObject]@{ id = $Id; status = $Status; summary = $Summary }) | Out-Null
}

function Copy-FileRequired([string]$Source, [string]$Destination) {
  if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { throw "缺少文件：$Source" }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
  Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function Copy-DirRequired([string]$Source, [string]$Destination) {
  if (-not (Test-Path -LiteralPath $Source -PathType Container)) { throw "缺少目录：$Source" }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
  Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
}

function Copy-DirContentsRequired([string]$Source, [string]$Destination, [string[]]$ExcludeNames = @()) {
  if (-not (Test-Path -LiteralPath $Source -PathType Container)) { throw "缺少目录：$Source" }
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  Get-ChildItem -LiteralPath $Source -Force | Where-Object {
    $ExcludeNames -notcontains $_.Name
  } | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $Destination $_.Name) -Recurse -Force
  }
}

function Get-HashText([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

New-Item -ItemType Directory -Force -Path $ReleaseRoot, $ReportsRoot | Out-Null
if (Test-Path -LiteralPath $StagingRoot) { Remove-Item -LiteralPath $StagingRoot -Recurse -Force }
if (Test-Path -LiteralPath $ZipPath) { Remove-Item -LiteralPath $ZipPath -Force }
if (Test-Path -LiteralPath $ShaPath) { Remove-Item -LiteralPath $ShaPath -Force }
New-Item -ItemType Directory -Force -Path $StagingRoot | Out-Null

try {
  Copy-FileRequired (Join-Path $ProjectRoot 'AI SkillHub.exe') (Join-Path $StagingRoot 'AI SkillHub.exe')
  foreach ($file in @('README.md', 'CHANGELOG.md', '使用说明.md')) {
    $source = Join-Path $ProjectRoot $file
    if (Test-Path -LiteralPath $source -PathType Leaf) { Copy-FileRequired $source (Join-Path $StagingRoot $file) }
  }
  if (Test-Path -LiteralPath (Join-Path $ProjectRoot 'docs') -PathType Container) {
    Copy-DirContentsRequired (Join-Path $ProjectRoot 'docs') (Join-Path $StagingRoot 'docs')
  }
  Copy-DirContentsRequired $RuntimeRoot (Join-Path $StagingRoot 'app-next\runtime') @('skillhub.config.json')
  New-Item -ItemType Directory -Force -Path (Join-Path $StagingRoot 'skills') | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $StagingRoot 'app-next\data') | Out-Null
  Add-Check 'copy.allowlist' 'ok' 'AI SkillHub 发布包已按白名单复制。'
} catch {
  Add-Check 'copy.allowlist' 'error' $_.Exception.Message
}

$forbidden = @()
foreach ($relative in @('app', 'skills\SKILL.md', 'app-next\data\github_sources', 'app-next\reports', 'app-next\runtime\skillhub.config.json', 'app-next\node_modules', 'app-next\src-tauri\target')) {
  if (Test-Path -LiteralPath (Join-Path $StagingRoot $relative)) { $forbidden += $relative }
}
if ($forbidden.Count -eq 0) {
  Add-Check 'privacy.boundary' 'ok' '发布包未包含 V1 app、个人来源库、个人配置、报告、node_modules 或构建缓存。'
} else {
  Add-Check 'privacy.boundary' 'error' ('发现不应发布的内容：' + ($forbidden -join ', '))
}

if (-not $NoZip) {
  Compress-Archive -Path (Join-Path $StagingRoot '*') -DestinationPath $ZipPath -Force
  $hash = Get-HashText $ZipPath
  Write-Utf8Bom $ShaPath ($hash + '  ' + (Split-Path -Leaf $ZipPath))
  Add-Check 'zip.package' 'ok' "已生成 zip：$ZipPath"
} else {
  $hash = ''
  Add-Check 'zip.package' 'info' '已跳过 zip 生成。'
}

$overall = if (@($Checks | Where-Object { $_.status -eq 'error' }).Count -eq 0) { 'ok' } else { 'error' }
$payload = [PSCustomObject]@{
  overallStatus = $overall
  version = $Version
  stagingRoot = $StagingRoot
  zipPath = if ($NoZip) { '' } else { $ZipPath }
  sha256 = $hash
  generatedAt = (Get-Date).ToString('o')
  checks = $Checks
}
$stamp = Get-Date -Format 'yyyyMMdd_HHmmss_fff'
$json = Join-Path $ReportsRoot "release-preflight_$stamp.json"
$md = Join-Path $ReportsRoot "release-preflight_$stamp.md"
Write-Utf8Bom $json ($payload | ConvertTo-Json -Depth 8)
Copy-Item -LiteralPath $json -Destination (Join-Path $ReportsRoot 'latest-release-preflight.json') -Force
$lines = @('# AI SkillHub 发布包预检', '', "- 状态：$overall", "- 发布目录：$StagingRoot", "- zip：$($payload.zipPath)", '', '| 检查项 | 状态 | 说明 |', '|---|---|---|')
foreach ($check in $Checks) { $lines += "| $($check.id) | $($check.status) | $($check.summary.Replace('|','/')) |" }
Write-Utf8Bom $md ($lines -join [Environment]::NewLine)
Copy-Item -LiteralPath $md -Destination (Join-Path $ReportsRoot 'latest-release-preflight.md') -Force
if (-not $Quiet) { Write-Host "AI SkillHub 发布包预检：$md" }
if ($overall -ne 'ok') { exit 1 }
