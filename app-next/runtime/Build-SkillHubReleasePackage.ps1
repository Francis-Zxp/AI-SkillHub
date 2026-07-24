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
$BuiltAppPath = Join-Path $V2Root 'src-tauri\target\release\ai-skillhub-next.exe'
$DeveloperRootExe = Join-Path $ProjectRoot 'AI SkillHub.exe'
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

  throw 'Cannot read the AI SkillHub version from tauri.conf.json or package.json.'
}

if ([string]::IsNullOrWhiteSpace($Version)) {
  $Version = Get-ProjectVersion
}
if ($Version -notmatch '^[0-9A-Za-z][0-9A-Za-z._-]*$') {
  throw "Version contains unsupported characters: $Version"
}

$PackageName = "AI-SkillHub-$Version"
$StagingRoot = Join-Path $ReleaseRoot $PackageName
$ZipPath = Join-Path $ReleaseRoot ($PackageName + '.zip')
$ShaPath = Join-Path $ReleaseRoot ($PackageName + '.sha256.txt')
$AllowedDocs = @(
  "release-notes\v$Version.md",
  'skill-router-standard.md'
)

function Write-Utf8Bom([string]$Path, [string]$Text) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
  [System.IO.File]::WriteAllText($Path, $Text, $script:Utf8Bom)
}

function Add-Check([string]$Id, [string]$Status, [string]$Summary) {
  $script:Checks.Add([PSCustomObject]@{ id = $Id; status = $Status; summary = $Summary }) | Out-Null
}

function Copy-FileRequired([string]$Source, [string]$Destination) {
  if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { throw "Missing file: $Source" }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
  Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function Get-HashText([string]$Path) {
  return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Assert-PathInsideRoot([string]$Path, [string]$Root, [string]$Label) {
  $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  $targetFull = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
  if ($targetFull -eq $rootFull.TrimEnd('\') -or -not $targetFull.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label is outside the expected directory: $targetFull"
  }
}

New-Item -ItemType Directory -Force -Path $ReleaseRoot, $ReportsRoot | Out-Null
Assert-PathInsideRoot $StagingRoot $ReleaseRoot 'Release staging directory'
if (Test-Path -LiteralPath $StagingRoot) { Remove-Item -LiteralPath $StagingRoot -Recurse -Force }
if (Test-Path -LiteralPath $ZipPath) { Remove-Item -LiteralPath $ZipPath -Force }
if (Test-Path -LiteralPath $ShaPath) { Remove-Item -LiteralPath $ShaPath -Force }
New-Item -ItemType Directory -Force -Path $StagingRoot | Out-Null

try {
  $builtVersion = [string](Get-Item -LiteralPath $BuiltAppPath).VersionInfo.ProductVersion
  $builtVersion = ($builtVersion -split '[+-]')[0]
  if ($builtVersion -ne $Version) {
    throw "Release executable is $builtVersion; expected $Version. Run a formal build first."
  }
  Copy-FileRequired $BuiltAppPath (Join-Path $StagingRoot 'AI SkillHub.exe')
  Copy-FileRequired $BuiltAppPath $DeveloperRootExe
  $developerVersion = ([string](Get-Item -LiteralPath $DeveloperRootExe).VersionInfo.ProductVersion -split '[+-]')[0]
  if ($developerVersion -ne $Version) {
    throw "Developer-root executable is $developerVersion; expected $Version."
  }
  Add-Check 'developer.root-exe' 'ok' "Developer-root AI SkillHub.exe is synced to v$Version."
  $UserGuideName = (-join @([char]0x4f7f, [char]0x7528, [char]0x8bf4, [char]0x660e)) + '.md'
  foreach ($file in @('README.md', 'README_EN.md', 'CHANGELOG.md', $UserGuideName)) {
    $source = Join-Path $ProjectRoot $file
    if (Test-Path -LiteralPath $source -PathType Leaf) { Copy-FileRequired $source (Join-Path $StagingRoot $file) }
  }
  foreach ($relativeDoc in $AllowedDocs) {
    Copy-FileRequired (Join-Path $ProjectRoot "docs\$relativeDoc") (Join-Path $StagingRoot "docs\$relativeDoc")
  }
  $packagedDocs = @(
    Get-ChildItem -LiteralPath (Join-Path $StagingRoot 'docs') -File -Recurse |
      ForEach-Object {
        $_.FullName.Substring((Join-Path $StagingRoot 'docs').Length).TrimStart('\').Replace('/', '\')
      }
  )
  $unexpectedDocs = @($packagedDocs | Where-Object { $AllowedDocs -notcontains $_ })
  if ($unexpectedDocs.Count -gt 0) {
    throw "Unexpected docs entered the portable package: $($unexpectedDocs -join ', ')"
  }
  foreach ($runtimeFile in @(
    'SkillHub.ps1',
    'Manage-AgentSkillLinks.ps1',
    'Export-SkillHubDiagnostics.ps1',
    'skillhub.config.example.json'
  )) {
    Copy-FileRequired (Join-Path $RuntimeRoot $runtimeFile) (Join-Path $StagingRoot "app-next\runtime\$runtimeFile")
  }
  New-Item -ItemType Directory -Force -Path (Join-Path $StagingRoot 'skills') | Out-Null
  New-Item -ItemType Directory -Force -Path (Join-Path $StagingRoot 'app-next\data') | Out-Null
  Add-Check 'copy.allowlist' 'ok' "The package uses explicit file and docs allowlists ($($AllowedDocs.Count) docs); developer tests, design audits, and packaging scripts are excluded."
} catch {
  Add-Check 'copy.allowlist' 'error' $_.Exception.Message
}

$forbidden = @()
foreach ($relative in @('app', 'skills\SKILL.md', 'app-next\data\github_sources', 'app-next\reports', 'app-next\runtime\skillhub.config.json', 'app-next\node_modules', 'app-next\src-tauri\target')) {
  if (Test-Path -LiteralPath (Join-Path $StagingRoot $relative)) { $forbidden += $relative }
}
if ($forbidden.Count -eq 0) {
  Add-Check 'privacy.boundary' 'ok' 'The package excludes the old prototype, personal sources and settings, reports, node_modules, and build caches.'
} else {
  Add-Check 'privacy.boundary' 'error' ('Forbidden release content found: ' + ($forbidden -join ', '))
}

if (-not $NoZip) {
  Compress-Archive -Path (Join-Path $StagingRoot '*') -DestinationPath $ZipPath -Force
  $hash = Get-HashText $ZipPath
  Write-Utf8Bom $ShaPath ($hash + '  ' + (Split-Path -Leaf $ZipPath))
  Add-Check 'zip.package' 'ok' "Generated zip: $ZipPath"
} else {
  $hash = ''
  Add-Check 'zip.package' 'info' 'Zip generation was skipped.'
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
$lines = @('# AI SkillHub Release Preflight', '', "- Status: $overall", "- Release directory: $StagingRoot", "- Zip: $($payload.zipPath)", '', '| Check | Status | Detail |', '|---|---|---|')
foreach ($check in $Checks) { $lines += "| $($check.id) | $($check.status) | $($check.summary.Replace('|','/')) |" }
Write-Utf8Bom $md ($lines -join [Environment]::NewLine)
Copy-Item -LiteralPath $md -Destination (Join-Path $ReportsRoot 'latest-release-preflight.md') -Force
if (-not $Quiet) { Write-Host "AI SkillHub release preflight: $md" }
if ($overall -ne 'ok') { exit 1 }
