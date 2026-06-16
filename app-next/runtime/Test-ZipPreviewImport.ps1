[CmdletBinding()]
param(
  [string]$Root = ''
)

$ErrorActionPreference = 'Stop'
$Utf8Bom = [System.Text.UTF8Encoding]::new($true)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$RuntimeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
if ([string]::IsNullOrWhiteSpace($Root)) {
  $V2Root = Split-Path -Parent $RuntimeRoot
  $ProjectRoot = Split-Path -Parent $V2Root
} else {
  $ProjectRoot = [System.IO.Path]::GetFullPath($Root)
  $V2Root = Join-Path $ProjectRoot 'app-next'
}

$ReportsRoot = Join-Path $V2Root 'reports'
$ReportDir = Join-Path $ReportsRoot 'zip-preview-test'
$PrivateRoot = Join-Path $V2Root '.skillhub-next'
$WorkRoot = Join-Path $PrivateRoot 'zip-preview-test'

function Write-Utf8Bom([string]$Path, [string]$Text) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
  [System.IO.File]::WriteAllText($Path, $Text, $script:Utf8Bom)
}

function Assert-PathInsideRoot([string]$Path, [string]$RootPath, [string]$Label) {
  $rootFull = [System.IO.Path]::GetFullPath($RootPath).TrimEnd('\') + '\'
  $targetFull = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
  if ($targetFull -eq $rootFull.TrimEnd('\') -or -not $targetFull.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label path is outside the expected root: $targetFull"
  }
}

function New-ZipWithEntries([string]$Path, [hashtable]$Entries) {
  if (Test-Path -LiteralPath $Path -PathType Leaf) {
    Remove-Item -LiteralPath $Path -Force
  }

  $file = [System.IO.File]::Open($Path, [System.IO.FileMode]::CreateNew)
  try {
    $zip = [System.IO.Compression.ZipArchive]::new($file, [System.IO.Compression.ZipArchiveMode]::Create)
    try {
      foreach ($name in $Entries.Keys) {
        $entry = $zip.CreateEntry([string]$name)
        $stream = $entry.Open()
        try {
          $writer = [System.IO.StreamWriter]::new($stream, [System.Text.UTF8Encoding]::new($false))
          try {
            $writer.Write([string]$Entries[$name])
          } finally {
            $writer.Dispose()
          }
        } finally {
          $stream.Dispose()
        }
      }
    } finally {
      $zip.Dispose()
    }
  } finally {
    $file.Dispose()
  }
}

function Get-SafeArchivePath([string]$Name) {
  $normalized = $Name.Replace('\', '/').Trim()
  if ([string]::IsNullOrWhiteSpace($normalized)) { return $null }
  if ($normalized.StartsWith('/') -or $normalized -match '^[A-Za-z]:') { return $null }
  $parts = $normalized.Split('/') | Where-Object { $_ -ne '' }
  if ($parts.Count -eq 0) { return $null }
  foreach ($part in $parts) {
    if ($part -eq '..') { return $null }
  }
  return ($parts -join '/')
}

function Test-ZipPreview([string]$Path) {
  $zip = [System.IO.Compression.ZipFile]::OpenRead($Path)
  try {
    $skillDirs = New-Object System.Collections.Generic.HashSet[string]
    $blocking = New-Object System.Collections.Generic.List[string]
    foreach ($entry in $zip.Entries) {
      $safePath = Get-SafeArchivePath $entry.FullName
      if ($null -eq $safePath) {
        $blocking.Add("Unsafe path refused: $($entry.FullName)") | Out-Null
        continue
      }
      if ($safePath.EndsWith('/')) { continue }
      if ([System.IO.Path]::GetFileName($safePath).Equals('SKILL.md', [System.StringComparison]::OrdinalIgnoreCase)) {
        $dir = [System.IO.Path]::GetDirectoryName($safePath).Replace('\', '/')
        if (-not [string]::IsNullOrWhiteSpace($dir)) {
          $skillDirs.Add($dir) | Out-Null
        }
      }
    }

    return [PSCustomObject]@{
      safe = $blocking.Count -eq 0
      skillCount = $skillDirs.Count
      blockingChecks = @($blocking)
    }
  } finally {
    $zip.Dispose()
  }
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

New-Item -ItemType Directory -Force -Path $ReportsRoot, $ReportDir, $PrivateRoot | Out-Null
Assert-PathInsideRoot $WorkRoot $PrivateRoot 'Zip preview work folder'
if (Test-Path -LiteralPath $WorkRoot) {
  Remove-Item -LiteralPath $WorkRoot -Recurse -Force
}
New-Item -ItemType Directory -Force -Path $WorkRoot | Out-Null

$safeZip = Join-Path $WorkRoot 'safe-skills.zip'
$unsafeZip = Join-Path $WorkRoot 'unsafe-traversal.zip'

New-ZipWithEntries $safeZip @{
  'demo-one/SKILL.md' = "---`nname: demo-one`ndescription: Safe preview fixture.`n---`n"
  'demo-two/SKILL.md' = "---`nname: demo-two`ndescription: Safe preview fixture.`n---`n"
  'README.md' = '# Safe preview fixture'
}
New-ZipWithEntries $unsafeZip @{
  '../escape/SKILL.md' = "---`nname: escape`ndescription: This entry must be blocked.`n---`n"
  'safe/SKILL.md' = "---`nname: safe`ndescription: Safe entry in unsafe archive.`n---`n"
}

$safePreview = Test-ZipPreview $safeZip
$unsafePreview = Test-ZipPreview $unsafeZip
$previewOk = $safePreview.skillCount -eq 2
$safeExtracted = $safePreview.safe
$traversalBlocked = -not $unsafePreview.safe -and @($unsafePreview.blockingChecks).Count -gt 0
$ok = $previewOk -and $safeExtracted -and $traversalBlocked
$stamp = Get-Date -Format 'yyyyMMdd_HHmmss_fff'
$generatedAt = (Get-Date).ToString('o')

$payload = [PSCustomObject]@{
  ok = $ok
  generatedAt = $generatedAt
  result = [PSCustomObject]@{
    previewOk = $previewOk
    safeExtracted = $safeExtracted
    traversalBlocked = $traversalBlocked
    previewSkillCount = $safePreview.skillCount
    unsafeBlockingChecks = @($unsafePreview.blockingChecks)
  }
}

$jsonPath = Join-Path $ReportDir "zip-preview-test_$stamp.json"
$mdPath = Join-Path $ReportDir "zip-preview-test_$stamp.md"
Write-Utf8Bom $jsonPath ($payload | ConvertTo-Json -Depth 8)
Copy-Item -LiteralPath $jsonPath -Destination (Join-Path $ReportDir 'latest-zip-preview-test.json') -Force

$statusText = if ($ok) { 'ok' } else { 'error' }
$lines = @(
  '# AI SkillHub zip preview test',
  '',
  "- Status: $statusText",
  "- Safe Skill count: $($safePreview.skillCount)",
  "- Path traversal blocked: $traversalBlocked",
  '',
  '| Check | Result |',
  '|---|---|',
  "| Safe package preview | $previewOk |",
  "| Safe package extraction boundary | $safeExtracted |",
  "| Traversal package refused | $traversalBlocked |"
)
Write-Utf8Bom $mdPath ($lines -join [Environment]::NewLine)
Copy-Item -LiteralPath $mdPath -Destination (Join-Path $ReportDir 'latest-zip-preview-test.md') -Force

if (-not $ok) { exit 1 }
Write-Host "AI SkillHub zip preview test: $mdPath"
