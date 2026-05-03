param(
  [switch]$NoPull,
  [switch]$ReportOnly
)

$ErrorActionPreference = 'Stop'

$base = Split-Path -Parent $MyInvocation.MyCommand.Path
$configPath = Join-Path $base 'skillhub.config.json'
if (-not (Test-Path -LiteralPath $configPath)) {
  throw "Missing config file: $configPath"
}

$config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
$sourceRoot = Join-Path $base $config.githubSourcesFolder
$skillsRoot = Join-Path $base $config.activeSkillsFolder
$stateRoot = Join-Path $base '.skillhub'
$reportsRoot = Join-Path $base 'reports'
$archivesRoot = Join-Path $base 'archives'
$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$archiveRoot = Join-Path $archivesRoot ("replaced_active_skill_copies_$stamp")
$statePath = Join-Path $stateRoot 'managed-links.json'
$reportPath = Join-Path $reportsRoot 'last-sync.md'

New-Item -ItemType Directory -Force -Path $sourceRoot, $skillsRoot, $stateRoot, $reportsRoot, $archivesRoot | Out-Null

function Convert-ToFullPath([string]$path) {
  return [System.IO.Path]::GetFullPath($path)
}

function Get-RepoNameForPath([string]$path) {
  $relative = [System.IO.Path]::GetRelativePath($sourceRoot, $path)
  return ($relative -split '[\\/]' | Select-Object -First 1)
}

function Get-SkillName([string]$skillMdPath) {
  $lines = Get-Content -LiteralPath $skillMdPath -TotalCount 40
  $nameLine = $lines | Where-Object { $_ -match '^name:' } | Select-Object -First 1
  if ($nameLine) {
    $name = ($nameLine -replace '^name:\s*', '').Trim().Trim('"').Trim("'")
    if ($name) { return $name }
  }
  return Split-Path -Leaf (Split-Path -Parent $skillMdPath)
}

function Get-PathPriority([string]$path) {
  $normalized = $path.Replace('/', '\')
  $priority = 50
  for ($i = 0; $i -lt $config.preferredPathFragments.Count; $i++) {
    $fragment = [string]$config.preferredPathFragments[$i]
    if ($normalized.Contains($fragment)) {
      $priority = $i + 1
      break
    }
  }
  return $priority
}

function Get-IsReparsePoint($item) {
  return (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Get-ConfiguredRepo($name) {
  return $config.repositories | Where-Object { $_.name -eq $name } | Select-Object -First 1
}

function Add-Candidate($list, [string]$folder, [string]$repoName, [bool]$explicit) {
  $skillMd = Join-Path $folder 'SKILL.md'
  if (-not (Test-Path -LiteralPath $skillMd)) { return }

  $skillName = Get-SkillName $skillMd
  $priority = if ($explicit) { 0 } else { Get-PathPriority $folder }
  $list.Add([PSCustomObject]@{
    Skill = $skillName
    FolderName = Split-Path -Leaf $folder
    Repo = $repoName
    Source = (Convert-ToFullPath $folder)
    Priority = $priority
    Explicit = $explicit
  }) | Out-Null
}

$log = New-Object System.Collections.Generic.List[object]
$candidates = New-Object System.Collections.Generic.List[object]

Write-Host "SkillHub base: $base"
Write-Host ''
Write-Host 'Updating configured repositories...'

foreach ($repo in $config.repositories) {
  $target = Join-Path $sourceRoot $repo.name
  if (-not $ReportOnly) {
    if (Test-Path -LiteralPath (Join-Path $target '.git')) {
      if (-not $NoPull) {
        Write-Host "Pulling $($repo.name)..."
        git -C $target pull --ff-only
      } else {
        Write-Host "Skipping pull for $($repo.name)."
      }
    } elseif (Test-Path -LiteralPath $target) {
      Write-Warning "$target exists but is not a Git repository. Skipping clone."
    } else {
      Write-Host "Cloning $($repo.name)..."
      git clone $repo.url $target
    }
  }
}

Write-Host ''
Write-Host 'Discovering skills...'

$sourceRepos = Get-ChildItem -LiteralPath $sourceRoot -Force -Directory -ErrorAction SilentlyContinue
foreach ($repoDir in $sourceRepos) {
  $repoConfig = Get-ConfiguredRepo $repoDir.Name
  if ($repoConfig -and $repoConfig.type -eq 'prompt') {
    $log.Add([PSCustomObject]@{ Kind='prompt'; Name=$repoDir.Name; Message='Prompt repository kept in github_sources only.' }) | Out-Null
    continue
  }

  if ($repoConfig -and $repoConfig.mode -eq 'explicit') {
    foreach ($skillPath in $repoConfig.skillPaths) {
      $folder = Join-Path $repoDir.FullName $skillPath
      Add-Candidate $candidates $folder $repoDir.Name $true
    }
    continue
  }

  if ($repoConfig -or $config.autoDiscoverManualRepos) {
    $skillFiles = Get-ChildItem -LiteralPath $repoDir.FullName -Recurse -Force -Filter 'SKILL.md' -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -notmatch '\\\.git\\' }
    foreach ($skillFile in $skillFiles) {
      Add-Candidate $candidates (Split-Path -Parent $skillFile.FullName) $repoDir.Name $false
    }
  }
}

$selected = New-Object System.Collections.Generic.List[object]
$conflicts = New-Object System.Collections.Generic.List[object]

foreach ($group in ($candidates | Group-Object Skill)) {
  $ordered = $group.Group | Sort-Object Priority, Source
  $bestPriority = $ordered[0].Priority
  $best = @($ordered | Where-Object { $_.Priority -eq $bestPriority })

  if ($best.Count -eq 1) {
    $selected.Add($best[0]) | Out-Null
  } else {
    $conflicts.Add([PSCustomObject]@{
      Skill = $group.Name
      Message = 'Multiple equally preferred sources found. Add an explicit skillPaths rule in skillhub.config.json.'
      Sources = (($best | Select-Object -ExpandProperty Source) -join '; ')
    }) | Out-Null
  }
}

Write-Host "Discovered $($candidates.Count) candidate skill folders."
Write-Host "Selected $($selected.Count) active GitHub/manual skills."
if ($conflicts.Count -gt 0) {
  Write-Warning "$($conflicts.Count) conflicts need manual config."
}

$previousManaged = @()
if (Test-Path -LiteralPath $statePath) {
  $previousRaw = Get-Content -LiteralPath $statePath -Raw
  if ($previousRaw.Trim()) {
    $previousManaged = @($previousRaw | ConvertFrom-Json)
  }
}

$selectedByName = @{}
foreach ($item in $selected) {
  $selectedByName[$item.Skill] = $item
}

$actions = New-Object System.Collections.Generic.List[object]

if (-not $ReportOnly) {
  Write-Host ''
  Write-Host 'Removing stale managed links...'

  foreach ($prev in $previousManaged) {
    $prevSkill = if ($prev.Skill -is [array]) { [string]$prev.Skill[0] } else { [string]$prev.Skill }
    $prevTarget = if ($prev.Target -is [array]) { [string]$prev.Target[0] } else { [string]$prev.Target }
    if ([string]::IsNullOrWhiteSpace($prevSkill)) { continue }
    if ($selectedByName.ContainsKey($prevSkill)) { continue }
    $dest = Join-Path $skillsRoot $prevSkill
    if (Test-Path -LiteralPath $dest) {
      $item = Get-Item -LiteralPath $dest -Force
      if (Get-IsReparsePoint $item) {
        Remove-Item -LiteralPath $dest -Force
        $actions.Add([PSCustomObject]@{ Skill=$prevSkill; Action='Removed stale managed link'; Target=$prevTarget }) | Out-Null
      }
    }
  }

  Get-ChildItem -LiteralPath $skillsRoot -Force -Directory -ErrorAction SilentlyContinue |
    Where-Object { Get-IsReparsePoint $_ } |
    ForEach-Object {
      $target = [string]$_.Target
      $isUnderSources = $target -and ((Convert-ToFullPath $target).StartsWith((Convert-ToFullPath $sourceRoot), [System.StringComparison]::OrdinalIgnoreCase))
      if ($isUnderSources -and -not $selectedByName.ContainsKey($_.Name)) {
        Remove-Item -LiteralPath $_.FullName -Force
        $actions.Add([PSCustomObject]@{ Skill=$_.Name; Action='Removed unmanaged GitHub-source link not selected anymore'; Target=$target }) | Out-Null
      }
    }

  Write-Host ''
  Write-Host 'Refreshing active links...'

  foreach ($skill in ($selected | Sort-Object Skill)) {
    $dest = Join-Path $skillsRoot $skill.Skill
    $src = $skill.Source
    $action = 'OK'

    if (Test-Path -LiteralPath $dest) {
      $item = Get-Item -LiteralPath $dest -Force
      if (Get-IsReparsePoint $item) {
        $currentTarget = [string]$item.Target
        if ($currentTarget -ne $src) {
          Remove-Item -LiteralPath $dest -Force
          New-Item -ItemType Junction -Path $dest -Target $src | Out-Null
          $action = 'Relinked'
        }
      } else {
        New-Item -ItemType Directory -Force -Path $archiveRoot | Out-Null
        Move-Item -LiteralPath $dest -Destination (Join-Path $archiveRoot $skill.Skill)
        New-Item -ItemType Junction -Path $dest -Target $src | Out-Null
        $action = 'Archived old copy and linked'
      }
    } else {
      New-Item -ItemType Junction -Path $dest -Target $src | Out-Null
      $action = 'Linked'
    }

    $actions.Add([PSCustomObject]@{ Skill=$skill.Skill; Action=$action; Target=$src }) | Out-Null
    Write-Host "$action`: $($skill.Skill)"
  }

  $managedState = $selected | Sort-Object Skill | ForEach-Object {
    [PSCustomObject]@{
      Skill = $_.Skill
      Repo = $_.Repo
      Target = $_.Source
    }
  }
  $managedState | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $statePath -Encoding UTF8
}

$repoRows = foreach ($repoDir in $sourceRepos) {
  $commit = ''
  if (Test-Path -LiteralPath (Join-Path $repoDir.FullName '.git')) {
    $commit = (git -C $repoDir.FullName rev-parse --short HEAD)
  }
  [PSCustomObject]@{ Name=$repoDir.Name; Commit=$commit; Path=$repoDir.FullName }
}

$report = New-Object System.Collections.Generic.List[string]
$report.Add('# SkillHub Last Sync Report') | Out-Null
$report.Add('') | Out-Null
$report.Add("Generated: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')") | Out-Null
$report.Add('') | Out-Null
$report.Add('## Repositories') | Out-Null
$report.Add('') | Out-Null
$report.Add('| Repository | Commit | Path |') | Out-Null
$report.Add('|---|---:|---|') | Out-Null
foreach ($repo in ($repoRows | Sort-Object Name)) {
  $report.Add("| $($repo.Name) | $($repo.Commit) | $($repo.Path) |") | Out-Null
}
$report.Add('') | Out-Null
$report.Add('## Active Managed Skills') | Out-Null
$report.Add('') | Out-Null
$report.Add('| Skill | Repo | Source |') | Out-Null
$report.Add('|---|---|---|') | Out-Null
foreach ($skill in ($selected | Sort-Object Skill)) {
  $report.Add("| $($skill.Skill) | $($skill.Repo) | $($skill.Source) |") | Out-Null
}
if ($conflicts.Count -gt 0) {
  $report.Add('') | Out-Null
  $report.Add('## Conflicts') | Out-Null
  $report.Add('') | Out-Null
  $report.Add('| Skill | Message | Sources |') | Out-Null
  $report.Add('|---|---|---|') | Out-Null
  foreach ($conflict in $conflicts) {
    $report.Add("| $($conflict.Skill) | $($conflict.Message) | $($conflict.Sources) |") | Out-Null
  }
}
$report.Add('') | Out-Null
$report.Add('## Prompt-Only Sources') | Out-Null
$report.Add('') | Out-Null
$report.Add('| Repository | Note |') | Out-Null
$report.Add('|---|---|') | Out-Null
foreach ($repo in ($config.repositories | Where-Object { $_.type -eq 'prompt' })) {
  $report.Add("| $($repo.name) | $($repo.note) |") | Out-Null
}

$report | Set-Content -LiteralPath $reportPath -Encoding UTF8

Write-Host ''
Write-Host "Report: $reportPath"
Write-Host "Managed state: $statePath"
Write-Host ''
Write-Host 'Active managed skills:'
$selected | Sort-Object Skill | Select-Object -ExpandProperty Skill
