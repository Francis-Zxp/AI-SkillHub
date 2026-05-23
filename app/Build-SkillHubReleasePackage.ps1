[CmdletBinding()]
param(
  [string]$Version,
  [switch]$Quiet,
  [switch]$NoZip
)

$ErrorActionPreference = 'Stop'
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$Utf8Bom = [System.Text.UTF8Encoding]::new($true)
[Console]::OutputEncoding = $Utf8NoBom
$OutputEncoding = $Utf8NoBom

$AppRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $AppRoot
$ReleaseRoot = Join-Path $ProjectRoot 'release'
$ReportsRoot = Join-Path $AppRoot 'reports'
$PreflightRoot = Join-Path $ReportsRoot 'release-preflight'
$Checks = New-Object System.Collections.Generic.List[object]

function Write-Utf8Bom([string]$Path, [string]$Text) {
  $parent = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  [System.IO.File]::WriteAllText($Path, $Text, $script:Utf8Bom)
}

function Add-Check([string]$Id, [string]$Status, [string]$Summary, [string]$Detail, [string]$Fix) {
  $script:Checks.Add([PSCustomObject]@{
    id = $Id
    status = $Status
    summary = $Summary
    detail = $Detail
    fix = $Fix
  }) | Out-Null
}

function Get-NormalizedFullPath([string]$Path) {
  return [System.IO.Path]::GetFullPath($Path).TrimEnd('\', '/')
}

function Assert-InDirectory([string]$Path, [string]$Root) {
  $full = Get-NormalizedFullPath $Path
  $rootFull = Get-NormalizedFullPath $Root
  if ($full -ne $rootFull -and -not $full.StartsWith($rootFull + [System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "拒绝操作非预期路径：$full"
  }
}

function Remove-SafeDirectory([string]$Path, [string]$Root) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  Assert-InDirectory $Path $Root
  Remove-Item -LiteralPath $Path -Recurse -Force
}

function Remove-SafeFile([string]$Path, [string]$Root) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  Assert-InDirectory $Path $Root
  Remove-Item -LiteralPath $Path -Force
}

function Copy-RequiredFile([string]$Source, [string]$Destination) {
  if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
    throw "缺少发布必需文件：$Source"
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
  Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function Copy-RequiredDirectory([string]$Source, [string]$Destination) {
  if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
    throw "缺少发布必需目录：$Source"
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
  Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
}

function Get-AppVersion {
  if (-not [string]::IsNullOrWhiteSpace($Version)) { return $Version.Trim() }
  $appJs = Join-Path $AppRoot 'ui\app.js'
  if (Test-Path -LiteralPath $appJs -PathType Leaf) {
    $text = Get-Content -LiteralPath $appJs -Raw -Encoding UTF8
    $match = [regex]::Match($text, 'APP_VERSION\s*=\s*"(?<version>v[^"]+)"')
    if ($match.Success) { return $match.Groups['version'].Value }
  }
  return 'v0.0.0'
}

function Test-ForbiddenEntries([string]$Root) {
  $forbidden = @(
    'app\skillhub.config.json',
    'app\github_sources',
    'app\reports',
    'app\webview2-data',
    'app\.skillhub',
    'app\archives',
    'app\packages',
    'release',
    '其它人的优秀项目案例'
  )
  $found = New-Object System.Collections.Generic.List[string]
  foreach ($relative in $forbidden) {
    if (Test-Path -LiteralPath (Join-Path $Root $relative)) {
      $found.Add($relative) | Out-Null
    }
  }
  $skillFiles = @()
  $skillsDir = Join-Path $Root 'skills'
  if (Test-Path -LiteralPath $skillsDir -PathType Container) {
    $skillFiles = @(Get-ChildItem -LiteralPath $skillsDir -Force -Recurse -File -ErrorAction SilentlyContinue)
  }
  foreach ($file in $skillFiles) {
    $found.Add(('skills\' + $file.Name)) | Out-Null
  }
  return @($found)
}

function Test-ZipForbiddenEntries([string]$ZipPath) {
  Add-Type -AssemblyName System.IO.Compression.FileSystem
  $found = New-Object System.Collections.Generic.List[string]
  $zip = [System.IO.Compression.ZipFile]::OpenRead($ZipPath)
  try {
    foreach ($entry in $zip.Entries) {
      $name = $entry.FullName -replace '\\', '/'
      if ($name -match '/app/skillhub\.config\.json$') { $found.Add($name) | Out-Null }
      if ($name -match '/app/github_sources(/|$)') { $found.Add($name) | Out-Null }
      if ($name -match '/app/reports(/|$)') { $found.Add($name) | Out-Null }
      if ($name -match '/app/webview2-data(/|$)') { $found.Add($name) | Out-Null }
      if ($name -match '/app/\.skillhub(/|$)') { $found.Add($name) | Out-Null }
      if ($name -match '/app/archives(/|$)') { $found.Add($name) | Out-Null }
      if ($name -match '/app/packages(/|$)') { $found.Add($name) | Out-Null }
      if ($name -match '/release(/|$)') { $found.Add($name) | Out-Null }
      if ($name -match '/其它人的优秀项目案例(/|$)') { $found.Add($name) | Out-Null }
      if ($name -match '/skills/[^/]+') { $found.Add($name) | Out-Null }
    }
  } finally {
    $zip.Dispose()
  }
  return @($found)
}

function Get-Sha256Hex([string]$Path) {
  $sha256 = [System.Security.Cryptography.SHA256]::Create()
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    $hash = $sha256.ComputeHash($stream)
    return (($hash | ForEach-Object { $_.ToString('x2') }) -join '').ToUpperInvariant()
  } finally {
    $stream.Dispose()
    $sha256.Dispose()
  }
}

function Build-MarkdownReport($Payload) {
  $md = New-Object System.Collections.Generic.List[string]
  $md.Add('# 发布包预检') | Out-Null
  $md.Add('') | Out-Null
  $md.Add("- 状态：$($Payload.overallStatus)") | Out-Null
  $md.Add("- 版本：$($Payload.version)") | Out-Null
  $md.Add("- 发布包：$($Payload.zipPath)") | Out-Null
  $md.Add("- SHA256：$($Payload.sha256)") | Out-Null
  $md.Add("- 生成时间：$($Payload.generatedAt)") | Out-Null
  $md.Add('') | Out-Null
  $md.Add('| 检查项 | 状态 | 说明 |') | Out-Null
  $md.Add('|---|---|---|') | Out-Null
  foreach ($check in $Payload.checks) {
    $summary = ([string]$check.summary).Replace('|', '/')
    $md.Add("| $($check.id) | $($check.status) | $summary |") | Out-Null
  }
  $md.Add('') | Out-Null
  $md.Add('说明：该预检使用白名单复制发布文件，并检查发布目录和 zip 内是否混入个人 skills、GitHub 克隆源、个人配置、报告、缓存或本机参考资料。') | Out-Null
  return ($md -join [Environment]::NewLine)
}

$versionText = Get-AppVersion
if ($versionText -notmatch '^v\d+\.\d+\.\d+([-.][A-Za-z0-9.]+)?$') {
  throw "版本号不合法：$versionText。请使用 v1.2.3 这样的格式。"
}

$packageName = "AI-SkillHub-$versionText"
$stagingRoot = Join-Path $ReleaseRoot $packageName
$zipPath = Join-Path $ReleaseRoot ($packageName + '.zip')
$shaPath = Join-Path $ReleaseRoot ($packageName + '.sha256.txt')
$stamp = Get-Date -Format 'yyyyMMdd_HHmmss_fff'
$jsonReport = Join-Path $PreflightRoot "release-preflight_$stamp.json"
$mdReport = Join-Path $PreflightRoot "release-preflight_$stamp.md"
$latestJson = Join-Path $PreflightRoot 'latest-release-preflight.json'
$latestMd = Join-Path $PreflightRoot 'latest-release-preflight.md'

New-Item -ItemType Directory -Force -Path $ReleaseRoot, $PreflightRoot | Out-Null
Remove-SafeDirectory $stagingRoot $ReleaseRoot
Remove-SafeFile $zipPath $ReleaseRoot
Remove-SafeFile $shaPath $ReleaseRoot
New-Item -ItemType Directory -Force -Path $stagingRoot | Out-Null

try {
  Copy-RequiredFile (Join-Path $ProjectRoot 'AI SkillHub.exe') (Join-Path $stagingRoot 'AI SkillHub.exe')
  Copy-RequiredFile (Join-Path $ProjectRoot 'README.md') (Join-Path $stagingRoot 'README.md')
  Copy-RequiredFile (Join-Path $ProjectRoot 'CHANGELOG.md') (Join-Path $stagingRoot 'CHANGELOG.md')
  Copy-RequiredFile (Join-Path $ProjectRoot '使用说明.md') (Join-Path $stagingRoot '使用说明.md')
  if (Test-Path -LiteralPath (Join-Path $ProjectRoot 'docs') -PathType Container) {
    Copy-RequiredDirectory (Join-Path $ProjectRoot 'docs') (Join-Path $stagingRoot 'docs')
  }

  New-Item -ItemType Directory -Force -Path (Join-Path $stagingRoot 'skills') | Out-Null
  Copy-RequiredDirectory (Join-Path $AppRoot 'assets') (Join-Path $stagingRoot 'app\assets')
  Copy-RequiredDirectory (Join-Path $AppRoot 'runtime') (Join-Path $stagingRoot 'app\runtime')
  Copy-RequiredDirectory (Join-Path $AppRoot 'ui') (Join-Path $stagingRoot 'app\ui')

  foreach ($file in @(
    'SkillHub.ps1',
    'Manage-AgentSkillLinks.ps1',
    'Export-SkillHubDiagnostics.ps1',
    'Test-ShareRecipientExperience.ps1',
    'Build-SkillHubReleasePackage.ps1',
    'skillhub.config.example.json',
    '安装每日自动更新任务.ps1',
    '更新GitHub来源并同步Skills.ps1',
    '卸载每日自动更新任务.ps1'
  )) {
    Copy-RequiredFile (Join-Path $AppRoot $file) (Join-Path $stagingRoot "app\$file")
  }

  Add-Check 'allowlist.copy' 'ok' '发布文件已按白名单复制。' $stagingRoot '若缺文件，请更新发布白名单。'
} catch {
  Add-Check 'allowlist.copy' 'error' $_.Exception.Message '' '请补齐缺失文件后重试。'
}

$forbidden = Test-ForbiddenEntries $stagingRoot
if ($forbidden.Count -eq 0) {
  Add-Check 'staging.privacy' 'ok' '发布目录未发现个人 skills、配置、来源仓库、报告或缓存。' $stagingRoot '无需处理。'
} else {
  Add-Check 'staging.privacy' 'error' ('发布目录发现禁带内容：' + ($forbidden -join ', ')) ($forbidden -join [Environment]::NewLine) '请从白名单移除这些内容。'
}

$requiredInPackage = @(
  'AI SkillHub.exe',
  'README.md',
  'CHANGELOG.md',
  '使用说明.md',
  'app\ui\app.js',
  'app\runtime\Microsoft.Web.WebView2.Core.dll',
  'app\SkillHub.ps1',
  'app\Export-SkillHubDiagnostics.ps1',
  'app\Test-ShareRecipientExperience.ps1',
  'app\Build-SkillHubReleasePackage.ps1',
  'app\skillhub.config.example.json'
)
$missing = @($requiredInPackage | Where-Object { -not (Test-Path -LiteralPath (Join-Path $stagingRoot $_) -PathType Leaf) })
if ($missing.Count -eq 0) {
  Add-Check 'package.requiredFiles' 'ok' '发布包必需文件齐全。' '' '无需处理。'
} else {
  Add-Check 'package.requiredFiles' 'error' ('缺少必需文件：' + ($missing -join ', ')) '' '请补齐文件或更新打包脚本。'
}

$releaseNotePath = Join-Path $stagingRoot ("docs\release-notes\$versionText.md")
if (Test-Path -LiteralPath $releaseNotePath -PathType Leaf) {
  Add-Check 'docs.releaseNotes' 'ok' "已找到 $versionText 的发布说明。" $releaseNotePath '无需处理。'
} else {
  Add-Check 'docs.releaseNotes' 'warn' "未找到 $versionText 的发布说明。" $releaseNotePath '正式发布前建议补齐 docs\release-notes\版本号.md。'
}

$sha = ''
if (-not $NoZip) {
  try {
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory($stagingRoot, $zipPath, [System.IO.Compression.CompressionLevel]::Optimal, $true)
    $sha = Get-Sha256Hex $zipPath
    Set-Content -LiteralPath $shaPath -Value "$sha  $($packageName).zip" -Encoding ASCII
    Add-Check 'zip.create' 'ok' 'zip 发布包和 SHA256 校验文件已生成。' $zipPath '上传 Release 时同时上传 zip 和 sha256。'

    $zipForbidden = Test-ZipForbiddenEntries $zipPath
    if ($zipForbidden.Count -eq 0) {
      Add-Check 'zip.privacy' 'ok' 'zip 内未发现个人 skills、配置、来源仓库、报告或缓存。' '' '无需处理。'
    } else {
      Add-Check 'zip.privacy' 'error' ('zip 内发现禁带内容：' + ($zipForbidden -join ', ')) ($zipForbidden -join [Environment]::NewLine) '请修正打包白名单后重新生成。'
    }
  } catch {
    Add-Check 'zip.create' 'error' $_.Exception.Message '' '请确认 release 目录可写。'
  }
} else {
  Add-Check 'zip.create' 'info' '已跳过 zip 创建，仅生成发布目录。' $stagingRoot '正式发布前请不要使用 -NoZip。'
}

$errorCount = @($Checks | Where-Object { $_.status -eq 'error' }).Count
$warnCount = @($Checks | Where-Object { $_.status -eq 'warn' }).Count
$overall = if ($errorCount -gt 0) { 'error' } elseif ($warnCount -gt 0) { 'warn' } else { 'ok' }

$payload = [PSCustomObject]@{
  ok = ($overall -eq 'ok')
  overallStatus = $overall
  generatedAt = (Get-Date).ToString('o')
  version = $versionText
  packageName = $packageName
  stagingRoot = $stagingRoot
  zipPath = if (Test-Path -LiteralPath $zipPath) { $zipPath } else { '' }
  sha256Path = if (Test-Path -LiteralPath $shaPath) { $shaPath } else { '' }
  sha256 = $sha
  checks = $Checks
}

$jsonText = $payload | ConvertTo-Json -Depth 8
Write-Utf8Bom $jsonReport $jsonText
Write-Utf8Bom $latestJson $jsonText
Write-Utf8Bom $mdReport (Build-MarkdownReport $payload)
Copy-Item -LiteralPath $mdReport -Destination $latestMd -Force

if (-not $Quiet) {
  Write-Host "发布包预检报告：$mdReport"
  if ($payload.zipPath) { Write-Host "发布包：$($payload.zipPath)" }
  if ($payload.sha256Path) { Write-Host "SHA256：$($payload.sha256Path)" }
}

if ($overall -eq 'error') {
  exit 1
}
