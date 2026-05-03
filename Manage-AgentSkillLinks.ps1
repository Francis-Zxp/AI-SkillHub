param(
  [switch]$Quiet
)

$ErrorActionPreference = 'Stop'

$base = Split-Path -Parent $MyInvocation.MyCommand.Path
$shared = Join-Path $base 'skills'
$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'

if (-not (Test-Path -LiteralPath $shared)) {
  throw "Active skills folder not found: $shared"
}

function Write-Step([string]$message) {
  if (-not $Quiet) { Write-Host $message }
}

function Set-JunctionPath([string]$path, [string]$target) {
  $parent = Split-Path -Parent $path
  New-Item -ItemType Directory -Force -Path $parent | Out-Null

  if (Test-Path -LiteralPath $path) {
    $item = Get-Item -LiteralPath $path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      $currentTarget = [string]$item.Target
      if ($currentTarget -eq $target) {
        return 'OK'
      }
      Remove-Item -LiteralPath $path -Force
    } else {
      $backup = Join-Path $parent ((Split-Path -Leaf $path) + '_AI_global接管前备份_' + $stamp)
      Move-Item -LiteralPath $path -Destination $backup
    }
  }

  New-Item -ItemType Junction -Path $path -Target $target | Out-Null
  return 'Linked'
}

$activeSkillDirs = Get-ChildItem -LiteralPath $shared -Force -Directory |
  Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'SKILL.md') } |
  Sort-Object Name

$rows = New-Object System.Collections.Generic.List[object]

$claudePath = Join-Path $HOME '.claude\skills'
$claudeStatus = Set-JunctionPath $claudePath $shared
$rows.Add([PSCustomObject]@{ App='Claude Code'; Entry=$claudePath; Status=$claudeStatus; Target=$shared }) | Out-Null

$antigravityPath = Join-Path $HOME '.gemini\antigravity\skills'
$antigravityStatus = Set-JunctionPath $antigravityPath $shared
$rows.Add([PSCustomObject]@{ App='Antigravity'; Entry=$antigravityPath; Status=$antigravityStatus; Target=$shared }) | Out-Null

$codexRoot = Join-Path $HOME '.codex\skills'
New-Item -ItemType Directory -Force -Path $codexRoot | Out-Null

foreach ($oldName in @('Zxp_global_skills', 'AI_global_skills')) {
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
      if ($currentTarget -eq $skill.FullName) {
        continue
      }
      Remove-Item -LiteralPath $dest -Force
    } elseif ($item.Name -ne '.system') {
      $backupRoot = Join-Path $codexRoot ('AI_global接管前备份_' + $stamp)
      New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
      Move-Item -LiteralPath $dest -Destination (Join-Path $backupRoot $skill.Name)
    }
  }
  New-Item -ItemType Junction -Path $dest -Target $skill.FullName | Out-Null
}

$rows.Add([PSCustomObject]@{ App='Codex'; Entry=$codexRoot; Status=("$($activeSkillDirs.Count) individual links"); Target=$shared }) | Out-Null

if (-not $Quiet) {
  $rows | Format-Table -AutoSize
}
elseif ($Quiet) {
  $rows | ConvertTo-Json -Depth 4 | Out-Null
}
