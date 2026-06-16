[CmdletBinding()]
param(
  [string]$Version = '',
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
$Checks = New-Object System.Collections.Generic.List[object]

function Get-ProjectVersion {
  $tauriConfig = Join-Path $V2Root 'src-tauri\tauri.conf.json'
  if (Test-Path -LiteralPath $tauriConfig -PathType Leaf) {
    try {
      $config = Get-Content -LiteralPath $tauriConfig -Raw -Encoding UTF8 | ConvertFrom-Json
      if (-not [string]::IsNullOrWhiteSpace([string]$config.version)) {
        return [string]$config.version
      }
    } catch {
    }
  }

  $packageJson = Join-Path $V2Root 'package.json'
  if (Test-Path -LiteralPath $packageJson -PathType Leaf) {
    try {
      $package = Get-Content -LiteralPath $packageJson -Raw -Encoding UTF8 | ConvertFrom-Json
      if (-not [string]::IsNullOrWhiteSpace([string]$package.version)) {
        return [string]$package.version
      }
    } catch {
    }
  }

  throw '无法从 tauri.conf.json 或 package.json 读取 AI SkillHub 版本。'
}

if ([string]::IsNullOrWhiteSpace($Version)) {
  $Version = Get-ProjectVersion
}
if ($Version -notmatch '^[0-9A-Za-z][0-9A-Za-z._-]*$') {
  throw "版本号只能包含字母、数字、点、下划线和短横线：$Version"
}

$PackageName = "AI-SkillHub-$Version"
$StagingRoot = Join-Path $ReleaseRoot $PackageName
$ZipPath = Join-Path $ReleaseRoot ($PackageName + '.zip')
$ShaPath = Join-Path $ReleaseRoot ($PackageName + '.sha256.txt')

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

function Assert-PathInsideRoot([string]$Path, [string]$Root, [string]$Label) {
  $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  $targetFull = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
  if ($targetFull -eq $rootFull.TrimEnd('\') -or -not $targetFull.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label 路径不在预期目录内：$targetFull"
  }
}

New-Item -ItemType Directory -Force -Path $ReleaseRoot, $ReportsRoot | Out-Null
Assert-PathInsideRoot $StagingRoot $ReleaseRoot '发布暂存目录'
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
  Add-Check 'privacy.boundary' 'ok' '发布包未包含旧原型 app、个人来源库、个人配置、报告、node_modules 或构建缓存。'
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
