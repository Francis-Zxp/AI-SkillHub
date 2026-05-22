param(
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $Utf8NoBom
$OutputEncoding = $Utf8NoBom

$AppRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfigPath = Join-Path $AppRoot 'skillhub.config.json'

function Write-Utf8Bom([string]$Path, [string]$Text) {
  $parent = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  [System.IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($true))
}

function Write-JsonUtf8([string]$Path, $Object, [int]$Depth = 8) {
  Write-Utf8Bom $Path ($Object | ConvertTo-Json -Depth $Depth)
}

function New-DefaultSkillHubConfig {
  [PSCustomObject]@{
    version = 2
    githubSourcesFolder = 'github_sources'
    activeSkillsFolder = '..\skills'
    manageAgentLinks = $false
    autoDiscoverManualRepos = $true
    preferredPathFragments = @('\.claude\skills\', '\skills\', '\.agents\skills\')
    repositories = @()
  }
}

if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
  Write-JsonUtf8 $ConfigPath (New-DefaultSkillHubConfig) 8
}

$Config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json

function Resolve-AppPath([string]$Path) {
  if ([System.IO.Path]::IsPathRooted($Path)) {
    return [System.IO.Path]::GetFullPath($Path)
  }
  return [System.IO.Path]::GetFullPath((Join-Path $AppRoot $Path))
}

$Shared = Resolve-AppPath $Config.activeSkillsFolder
$Stamp = Get-Date -Format 'yyyyMMdd_HHmmss'

if (-not (Test-Path -LiteralPath $Shared)) {
  throw "Active skills folder not found: $Shared"
}

function Write-Step([string]$Message) {
  if (-not $Quiet) { Write-Host $Message }
}

function Set-JunctionPath([string]$Path, [string]$Target) {
  $parent = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $parent | Out-Null

  if (Test-Path -LiteralPath $Path) {
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      $currentTarget = [string]$item.Target
      if ($currentTarget -eq $Target) { return 'OK' }
      Remove-Item -LiteralPath $Path -Force
    } else {
      $backup = Join-Path $parent ((Split-Path -Leaf $Path) + '_AI_global接管前备份_' + $Stamp)
      Move-Item -LiteralPath $Path -Destination $backup
    }
  }

  New-Item -ItemType Junction -Path $Path -Target $Target | Out-Null
  return 'Linked'
}

function Test-CodexPresent {
  $codexCommand = Get-Command codex -ErrorAction SilentlyContinue
  if ($null -ne $codexCommand) { return $true }

  $codexHome = Join-Path $HOME '.codex'
  foreach ($marker in @('auth.json', 'config.toml', 'installation_id', 'sessions', 'state_5.sqlite')) {
    if (Test-Path -LiteralPath (Join-Path $codexHome $marker)) { return $true }
  }
  return $false
}

$activeSkillDirs = Get-ChildItem -LiteralPath $Shared -Force -Directory |
  Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'SKILL.md') } |
  Sort-Object Name

$rows = New-Object System.Collections.Generic.List[object]

$claudePath = Join-Path $HOME '.claude\skills'
$claudeStatus = Set-JunctionPath $claudePath $Shared
$rows.Add([PSCustomObject]@{ App = 'Claude Code'; Entry = $claudePath; Status = $claudeStatus; Target = $Shared }) | Out-Null

$antigravityPath = Join-Path $HOME '.gemini\antigravity\skills'
$antigravityStatus = Set-JunctionPath $antigravityPath $Shared
$rows.Add([PSCustomObject]@{ App = 'Antigravity'; Entry = $antigravityPath; Status = $antigravityStatus; Target = $Shared }) | Out-Null

$codexRoot = Join-Path $HOME '.codex\skills'
if (Test-CodexPresent) {
  New-Item -ItemType Directory -Force -Path $codexRoot | Out-Null

  foreach ($oldName in @('AI_global_skills')) {
    $oldPath = Join-Path $codexRoot $oldName
    if (Test-Path -LiteralPath $oldPath) {
      $oldItem = Get-Item -LiteralPath $oldPath -Force
      if (($oldItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        Remove-Item -LiteralPath $oldPath -Force
      }
    }
  }

  foreach ($skill in $activeSkillDirs) {
    $dest = Join-Path $codexRoot $skill.Name
    if (Test-Path -LiteralPath $dest) {
      $item = Get-Item -LiteralPath $dest -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        $currentTarget = [string]$item.Target
        if ($currentTarget -eq $skill.FullName) { continue }
        Remove-Item -LiteralPath $dest -Force
      } elseif ($item.Name -ne '.system') {
        $backupRoot = Join-Path $codexRoot ('AI_global接管前备份_' + $Stamp)
        New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
        Move-Item -LiteralPath $dest -Destination (Join-Path $backupRoot $skill.Name)
      }
    }
    New-Item -ItemType Junction -Path $dest -Target $skill.FullName | Out-Null
  }

  $rows.Add([PSCustomObject]@{ App = 'Codex'; Entry = $codexRoot; Status = ("$($activeSkillDirs.Count) individual links"); Target = $Shared }) | Out-Null
} else {
  $rows.Add([PSCustomObject]@{ App = 'Codex'; Entry = $codexRoot; Status = 'Skipped (Codex not installed)'; Target = $Shared }) | Out-Null
}

if (-not $Quiet) {
  $rows | Format-Table -AutoSize
} else {
  $rows | ConvertTo-Json -Depth 4 | Out-Null
}
