param(
  [switch]$Quiet,
  [string]$HomePath = '',
  [switch]$SimulateCodexPresent,
  [switch]$SimulateClaudePresent,
  [switch]$SimulateOpenAIDesktopPresent
)

$ErrorActionPreference = 'Stop'
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $Utf8NoBom
$OutputEncoding = $Utf8NoBom

$AppRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$EffectiveHome = if (-not [string]::IsNullOrWhiteSpace($HomePath)) {
  [System.IO.Path]::GetFullPath($HomePath)
} else {
  $HOME
}
$ConfigPath = if (-not [string]::IsNullOrWhiteSpace($env:AI_SKILLHUB_CONFIG_PATH)) {
  [Environment]::ExpandEnvironmentVariables($env:AI_SKILLHUB_CONFIG_PATH)
} else {
  Join-Path $AppRoot 'skillhub.config.json'
}

function Write-Utf8Bom([string]$Path, [string]$Text) {
  $parent = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  [System.IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($true))
}

function Write-JsonUtf8([string]$Path, $Object, [int]$Depth = 8) {
  Write-Utf8Bom $Path ($Object | ConvertTo-Json -Depth $Depth)
}

function New-DefaultSkillHubConfig {
  $defaultSources = if (-not [string]::IsNullOrWhiteSpace($env:AI_SKILLHUB_SOURCES)) {
    $env:AI_SKILLHUB_SOURCES
  } else {
    '..\data\github_sources'
  }
  $defaultSkills = if (-not [string]::IsNullOrWhiteSpace($env:AI_SKILLHUB_ACTIVE_SKILLS)) {
    $env:AI_SKILLHUB_ACTIVE_SKILLS
  } else {
    '..\..\skills'
  }
  [PSCustomObject]@{
    version = 3
    githubSourcesFolder = $defaultSources
    activeSkillsFolder = $defaultSkills
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

function Convert-ToFullPath([string]$Path) {
  return [System.IO.Path]::GetFullPath($Path)
}

function Test-UnderRoot([string]$Child, [string]$Root) {
  if ([string]::IsNullOrWhiteSpace($Child) -or [string]::IsNullOrWhiteSpace($Root)) { return $false }
  $childFull = Convert-ToFullPath $Child
  $rootFull = (Convert-ToFullPath $Root).TrimEnd('\') + '\'
  return $childFull.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)
}

$Shared = Resolve-AppPath $Config.activeSkillsFolder
$SourceRoot = Resolve-AppPath $Config.githubSourcesFolder
$Stamp = Get-Date -Format 'yyyyMMdd_HHmmss'

if (-not (Test-Path -LiteralPath $Shared)) {
  throw "Active skills folder not found: $Shared"
}

function Write-Step([string]$Message) {
  if (-not $Quiet) { Write-Host $Message }
}

function Remove-ReparsePointPath([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return }
  $item = Get-Item -LiteralPath $Path -Force
  if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) {
    throw "Refusing to remove a real folder while cleaning links: $Path"
  }
  if ($item.PSIsContainer) {
    [System.IO.Directory]::Delete($item.FullName, $false)
  } else {
    [System.IO.File]::Delete($item.FullName)
  }
}

function Test-CodexCodePresent {
  if ($SimulateCodexPresent) { return $true }
  $codexCommand = Get-Command codex -ErrorAction SilentlyContinue
  if ($null -ne $codexCommand) { return $true }

  $localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
  $bundledBinary = Join-Path $localAppData 'OpenAI\Codex\bin\codex.exe'
  if (Test-Path -LiteralPath $bundledBinary -PathType Leaf) { return $true }

  $codexHome = Join-Path $EffectiveHome '.codex'
  foreach ($marker in @('auth.json', 'config.toml', 'installation_id', 'sessions', 'state_5.sqlite')) {
    if (Test-Path -LiteralPath (Join-Path $codexHome $marker)) { return $true }
  }
  return $false
}

function Test-OpenAIDesktopPresent {
  if ($SimulateOpenAIDesktopPresent) { return $true }
  if ([Environment]::OSVersion.Platform -ne [PlatformID]::Win32NT) { return $false }

  try {
    if (Get-Command Get-AppxPackage -ErrorAction SilentlyContinue) {
      $package = Get-AppxPackage -Name 'OpenAI.Codex' -ErrorAction SilentlyContinue |
        Select-Object -First 1
      if ($null -ne $package) { return $true }
    }
  } catch {
  }

  try {
    if (Get-Command Get-StartApps -ErrorAction SilentlyContinue) {
      $startApp = Get-StartApps -ErrorAction SilentlyContinue |
        Where-Object {
          $_.Name -match '(?i)\b(ChatGPT|OpenAI Codex|Codex)\b' -or
          $_.AppID -match '(?i)^OpenAI\.(Codex|ChatGPT)_.*!App$'
        } |
        Select-Object -First 1
      if ($null -ne $startApp) { return $true }
    }
  } catch {
  }

  try {
    $runningApp = Get-Process -Name 'ChatGPT', 'Codex' -ErrorAction SilentlyContinue |
      Select-Object -First 1
    if ($null -ne $runningApp) { return $true }
  } catch {
  }

  $localAppData = [Environment]::GetFolderPath([Environment+SpecialFolder]::LocalApplicationData)
  foreach ($candidate in @(
    (Join-Path $localAppData 'Programs\ChatGPT\ChatGPT.exe'),
    (Join-Path $localAppData 'OpenAI\ChatGPT\ChatGPT.exe'),
    (Join-Path $localAppData 'Programs\Codex\Codex.exe'),
    (Join-Path $localAppData 'OpenAI\Codex\Codex.exe'),
    (Join-Path $env:ProgramFiles 'ChatGPT\ChatGPT.exe'),
    (Join-Path $env:ProgramFiles 'Codex\Codex.exe')
  )) {
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $true }
  }
  return $false
}

function Test-ValidSkillManifest([string]$SkillDirectory) {
  $manifest = Join-Path $SkillDirectory 'SKILL.md'
  if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { return $false }
  try {
    $lines = @(Get-Content -LiteralPath $manifest -Encoding UTF8 -TotalCount 160)
    if ($lines.Count -lt 4 -or $lines[0].Trim() -ne '---') { return $false }
    $frontmatterEnd = -1
    for ($index = 1; $index -lt $lines.Count; $index += 1) {
      if ($lines[$index].Trim() -eq '---') {
        $frontmatterEnd = $index
        break
      }
    }
    if ($frontmatterEnd -lt 2) { return $false }
    $frontmatter = @($lines[1..($frontmatterEnd - 1)])
    $nameLine = $frontmatter | Where-Object { $_ -match '^\s*name\s*:' } | Select-Object -First 1
    $descriptionLine = $frontmatter | Where-Object { $_ -match '^\s*description\s*:' } | Select-Object -First 1
    $quoteChars = [char[]]@('"', "'")
    $nameValue = if ($null -ne $nameLine) { (($nameLine -split ':', 2)[1]).Trim().Trim($quoteChars) } else { '' }
    $descriptionValue = if ($null -ne $descriptionLine) { (($descriptionLine -split ':', 2)[1]).Trim().Trim($quoteChars) } else { '' }
    return -not [string]::IsNullOrWhiteSpace($nameValue) -and
      -not [string]::IsNullOrWhiteSpace($descriptionValue)
  } catch {
    return $false
  }
}

function Get-ClaudeConfigRoot {
  $configuredRoot = [Environment]::GetEnvironmentVariable('CLAUDE_CONFIG_DIR')
  if (-not [string]::IsNullOrWhiteSpace($configuredRoot)) {
    return [Environment]::ExpandEnvironmentVariables($configuredRoot.Trim())
  }
  return Join-Path $EffectiveHome '.claude'
}

function Test-ClaudeCodePresent {
  if ($SimulateClaudePresent) { return $true }
  $claudeCommand = Get-Command claude -ErrorAction SilentlyContinue
  if ($null -ne $claudeCommand) { return $true }

  $nativeBinary = Join-Path $EffectiveHome '.local\bin\claude.exe'
  if (Test-Path -LiteralPath $nativeBinary -PathType Leaf) { return $true }

  $claudeHome = Get-ClaudeConfigRoot
  foreach ($marker in @('settings.json', 'history.jsonl', 'projects', 'sessions', 'plugins', 'local')) {
    if (Test-Path -LiteralPath (Join-Path $claudeHome $marker)) { return $true }
  }

  return $false
}

function Test-AntigravityPresent {
  $antigravityCommand = Get-Command antigravity -ErrorAction SilentlyContinue
  if ($null -ne $antigravityCommand) { return $true }

  $antigravityHome = Join-Path $EffectiveHome '.gemini\antigravity'
  if (Test-Path -LiteralPath $antigravityHome -PathType Container) { return $true }
  $legacyAntigravityHome = Join-Path $EffectiveHome '.antigravity'
  if (Test-Path -LiteralPath $legacyAntigravityHome -PathType Container) { return $true }
  return $false
}

$allSkillDirsWithManifest = @(Get-ChildItem -LiteralPath $Shared -Force -Directory |
  Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName 'SKILL.md') } |
  Sort-Object Name)
$invalidSkillDirs = @($allSkillDirsWithManifest | Where-Object { -not (Test-ValidSkillManifest $_.FullName) })
$allActiveSkillDirs = @($allSkillDirsWithManifest |
  Where-Object { Test-ValidSkillManifest $_.FullName } |
  Sort-Object Name)
$allowlistPath = [Environment]::GetEnvironmentVariable('AI_SKILLHUB_AGENT_SKILL_ALLOWLIST')
if (-not [string]::IsNullOrWhiteSpace($allowlistPath)) {
  if (-not (Test-Path -LiteralPath $allowlistPath -PathType Leaf)) {
    throw "Agent Skill allowlist does not exist: $allowlistPath"
  }
  # Windows PowerShell 5.1 emits a top-level JSON array from ConvertFrom-Json as
  # one Object[] pipeline item. Wrapping the command expression in @() therefore
  # creates a nested array and turns the whole allowlist into a single hashtable
  # key. Assign first, then let foreach enumerate the decoded array itself.
  $decodedAllowedNames = Get-Content -LiteralPath $allowlistPath -Raw -Encoding UTF8 |
    ConvertFrom-Json
  $allowedNames = @{}
  foreach ($name in $decodedAllowedNames) {
    if (-not [string]::IsNullOrWhiteSpace([string]$name)) {
      $allowedNames[[string]$name] = $true
    }
  }
  $activeSkillDirs = @($allActiveSkillDirs | Where-Object { $allowedNames.ContainsKey($_.Name) })
  # A non-empty policy that matches no real active Skill is almost certainly a
  # malformed/stale allowlist or a parser regression. Fail before touching any
  # recipient directory so a bad policy can never erase known-good links.
  if ($allowedNames.Count -gt 0 -and $activeSkillDirs.Count -eq 0) {
    throw "Agent Skill allowlist contains $($allowedNames.Count) entries, but none match a valid active Skill. Existing AI tool links were preserved."
  }
} else {
  $activeSkillDirs = @($allActiveSkillDirs)
}
$activeSkillNames = @{}
foreach ($skill in $activeSkillDirs) {
  $activeSkillNames[$skill.Name] = $true
}

$rows = New-Object System.Collections.Generic.List[object]
foreach ($invalidSkill in $invalidSkillDirs) {
  $rows.Add([PSCustomObject]@{
    App = 'Skill validation'
    Entry = $invalidSkill.FullName
    Status = 'Skipped (SKILL.md needs non-empty name and description)'
    Target = ''
  }) | Out-Null
}

$claudePath = Join-Path (Get-ClaudeConfigRoot) 'skills'
$claudePresent = Test-ClaudeCodePresent

$antigravityPath = Join-Path $EffectiveHome '.gemini\antigravity\skills'
$antigravityPresent = Test-AntigravityPresent

function Sync-ManagedSkillDirectory([string]$RecipientSkillsRoot) {
  # Older SkillHub releases linked the entire recipient Skills directory to the
  # flat active catalog. Convert only that known managed junction into a real
  # directory. Any external/user-owned link is preserved and rejected.
  if (Test-Path -LiteralPath $RecipientSkillsRoot) {
    $rootItem = Get-Item -LiteralPath $RecipientSkillsRoot -Force
    if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      $rootTarget = [string]$rootItem.Target
      if ([string]::IsNullOrWhiteSpace($rootTarget) -or
          (Convert-ToFullPath $rootTarget) -ne (Convert-ToFullPath $Shared)) {
        throw "Recipient Skills root is an external link and was preserved: $RecipientSkillsRoot"
      }
      Remove-ReparsePointPath $RecipientSkillsRoot
    } elseif (-not $rootItem.PSIsContainer) {
      throw "Recipient Skills path is not a directory and was preserved: $RecipientSkillsRoot"
    }
  }
  New-Item -ItemType Directory -Force -Path $RecipientSkillsRoot | Out-Null

  foreach ($oldName in @('AI_global_skills')) {
    $oldPath = Join-Path $RecipientSkillsRoot $oldName
    if (Test-Path -LiteralPath $oldPath) {
      $oldItem = Get-Item -LiteralPath $oldPath -Force
      if (($oldItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        Remove-ReparsePointPath $oldPath
      }
    }
  }

  Get-ChildItem -LiteralPath $RecipientSkillsRoot -Force -Directory -ErrorAction SilentlyContinue |
    Where-Object { $_.Name -ne '.system' } |
    ForEach-Object {
      $item = Get-Item -LiteralPath $_.FullName -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        $target = [string]$item.Target
        if ((Test-UnderRoot $target $Shared) -and -not $activeSkillNames.ContainsKey($item.Name)) {
          Remove-ReparsePointPath $item.FullName
        }
      }
    }

  foreach ($skill in $activeSkillDirs) {
    $dest = Join-Path $RecipientSkillsRoot $skill.Name
    if (Test-Path -LiteralPath $dest) {
      $item = Get-Item -LiteralPath $dest -Force
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        $currentTarget = [string]$item.Target
        if ($currentTarget -eq $skill.FullName) { continue }
        Remove-ReparsePointPath $dest
      } elseif ($item.Name -ne '.system') {
        $backupRoot = Join-Path $RecipientSkillsRoot ('AI_global接管前备份_' + $Stamp)
        New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
        Move-Item -LiteralPath $dest -Destination (Join-Path $backupRoot $skill.Name)
      }
    }
    New-Item -ItemType Junction -Path $dest -Target $skill.FullName | Out-Null
  }

  $missingSkillMd = @($activeSkillDirs | Where-Object {
    -not (Test-Path -LiteralPath (Join-Path (Join-Path $RecipientSkillsRoot $_.Name) 'SKILL.md') -PathType Leaf)
  })
  if ($missingSkillMd.Count -gt 0) {
    $missingNames = ($missingSkillMd | ForEach-Object Name) -join ', '
    throw "Agent Skill 交付验收失败；以下入口没有可读的 SKILL.md：$missingNames"
  }

  foreach ($skill in $activeSkillDirs) {
    $deliveredSkillMd = Join-Path (Join-Path $RecipientSkillsRoot $skill.Name) 'SKILL.md'
    $body = [System.IO.File]::ReadAllText($deliveredSkillMd, [System.Text.Encoding]::UTF8)
    if (-not $body.Contains('[ROUTER-HUB]')) { continue }
    $declaredCount = 0
    foreach ($line in ($body -split "`r?`n")) {
      if ($line -notmatch '^\s*-\s+\[CHILD-SKILL\]') { continue }
      $match = [regex]::Match($line, '来源文件：`([^`]+)`')
      if (-not $match.Success) {
        throw "父 Skill 子项声明格式无效：$($skill.Name)"
      }
      $declaredCount++
      $declaredPath = [string]$match.Groups[1].Value
      $slashPath = $declaredPath -replace '\\', '/'
      if (-not [IO.Path]::IsPathRooted($declaredPath) -or $slashPath -match '(^|/)\.\.?(?:/|$)') {
        throw "父 Skill 子项路径不是安全绝对路径：$($skill.Name) -> $declaredPath"
      }
      $resolvedChild = Convert-ToFullPath $declaredPath
      if (-not (Test-UnderRoot $resolvedChild $SourceRoot)) {
        throw "父 Skill 子项越过受管来源目录：$($skill.Name) -> $declaredPath"
      }
      if (-not (Test-Path -LiteralPath $resolvedChild -PathType Leaf)) {
        throw "父 Skill 子项文件不可读：$($skill.Name) -> $declaredPath"
      }
      [System.IO.File]::OpenRead($resolvedChild).Dispose()
    }
    if ($declaredCount -lt 1) {
      throw "父 Skill 没有声明任何可调用子项：$($skill.Name)"
    }
  }
  return $activeSkillDirs.Count
}

$codexCodePresent = Test-CodexCodePresent
$openAIDesktopPresent = Test-OpenAIDesktopPresent
$codexPresent = $codexCodePresent -or $openAIDesktopPresent
$recipientFailures = [System.Collections.Generic.List[string]]::new()

if ($claudePresent) {
  try {
    $claudeCount = Sync-ManagedSkillDirectory $claudePath
    $claudeStatus = "$claudeCount verified parent-first links"
  } catch {
    $claudeStatus = 'Preserved existing directory: ' + $_.Exception.Message
    $recipientFailures.Add('Claude Code: ' + $_.Exception.Message) | Out-Null
    Write-Warning $claudeStatus
  }
} else {
  $claudeStatus = 'Skipped (Claude Code not installed)'
}
$rows.Add([PSCustomObject]@{ App = 'Claude Code'; Entry = $claudePath; Status = $claudeStatus; Target = $Shared }) | Out-Null

if ($antigravityPresent) {
  try {
    $antigravityCount = Sync-ManagedSkillDirectory $antigravityPath
    $antigravityStatus = "$antigravityCount verified parent-first links"
  } catch {
    $antigravityStatus = 'Preserved existing directory: ' + $_.Exception.Message
    $recipientFailures.Add('Antigravity: ' + $_.Exception.Message) | Out-Null
    Write-Warning $antigravityStatus
  }
} else {
  $antigravityStatus = 'Skipped (Antigravity not installed)'
}
$rows.Add([PSCustomObject]@{ App = 'Antigravity'; Entry = $antigravityPath; Status = $antigravityStatus; Target = $Shared }) | Out-Null

$codexRoot = Join-Path $EffectiveHome '.agents\skills'
if ($codexPresent) {
  try {
    $verifiedCount = Sync-ManagedSkillDirectory $codexRoot
    $codexStatus = "$verifiedCount verified parent-first user-scope links"
  } catch {
    $codexStatus = 'Preserved existing directory: ' + $_.Exception.Message
    $recipientFailures.Add('ChatGPT / Codex: ' + $_.Exception.Message) | Out-Null
    Write-Warning $codexStatus
  }
  $rows.Add([PSCustomObject]@{ App = 'ChatGPT / Codex'; Entry = $codexRoot; Status = $codexStatus; Target = $Shared }) | Out-Null

  # Older Codex builds used ~/.codex/skills. Keep an already-existing legacy
  # directory in sync, but never create it on a clean installation.
  $legacyCodexRoot = Join-Path $EffectiveHome '.codex\skills'
  if (Test-Path -LiteralPath $legacyCodexRoot -PathType Container) {
    try {
      $legacyVerifiedCount = Sync-ManagedSkillDirectory $legacyCodexRoot
      $legacyStatus = "$legacyVerifiedCount parent-first compatibility links"
    } catch {
      $legacyStatus = 'Preserved existing directory: ' + $_.Exception.Message
      $recipientFailures.Add('Codex legacy: ' + $_.Exception.Message) | Out-Null
      Write-Warning $legacyStatus
    }
    $rows.Add([PSCustomObject]@{ App = 'Codex (legacy compatibility)'; Entry = $legacyCodexRoot; Status = $legacyStatus; Target = $Shared }) | Out-Null
  }
} else {
  $rows.Add([PSCustomObject]@{ App = 'ChatGPT / Codex'; Entry = $codexRoot; Status = 'Skipped (ChatGPT/Codex not installed)'; Target = $Shared }) | Out-Null
}

if (-not $claudePresent -and -not $codexPresent -and -not $antigravityPresent) {
  Write-Step '未识别到可接管的 AI 工具。安装 ChatGPT Desktop、Codex、Claude Code 或 Antigravity 后，再重新同步。'
}

if ($recipientFailures.Count -gt 0) {
  throw ('AI 工具 Skill 交付未完成；已保留原目录。' + [Environment]::NewLine + ($recipientFailures -join [Environment]::NewLine))
}

if (-not $Quiet) {
  $rows | Format-Table -AutoSize
} else {
  $rows | ConvertTo-Json -Depth 4 | Out-Null
}

