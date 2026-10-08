param(
  [switch]$Quiet,
  [string]$HomePath = '',
  [switch]$SimulateCodexPresent,
  [switch]$SimulateClaudePresent,
  [switch]$SimulateOpenAIDesktopPresent,
  [switch]$SimulateCursorPresent,
  [switch]$SimulateGeminiPresent,
  [switch]$SimulateWorkBuddyPresent,
  [switch]$SimulateAntigravityPresent
)

$ErrorActionPreference = 'Stop'
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $Utf8NoBom
$OutputEncoding = $Utf8NoBom

$AppRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
. (Join-Path $AppRoot 'AgentInstallDiscovery.ps1')
$IsolatedHome = -not [string]::IsNullOrWhiteSpace($HomePath)
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
$RealSharedSkillsRoot = ''
if (-not [string]::IsNullOrWhiteSpace($env:AI_SKILLHUB_REAL_SHARED_SKILLS)) {
  $requestedRoot = $env:AI_SKILLHUB_REAL_SHARED_SKILLS
  $expectedRoot = Convert-ToFullPath (Join-Path $EffectiveHome '.agents\skills')
  if (-not [IO.Path]::IsPathRooted($requestedRoot) -or
      (Convert-ToFullPath $requestedRoot).TrimEnd('\', '/') -ne $expectedRoot.TrimEnd('\', '/')) {
    throw 'Real shared Skills must use the current user .agents\skills directory.'
  }
  $rootItem = Get-Item -LiteralPath $expectedRoot -Force -ErrorAction Stop
  if (-not $rootItem.PSIsContainer -or ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw 'Real shared Skills must already be a normal directory.'
  }
  $RealSharedSkillsRoot = $expectedRoot
}

if (-not (Test-Path -LiteralPath $Shared)) {
  throw "Active skills folder not found: $Shared"
}

function Write-Step([string]$Message) {
  if (-not $Quiet) { Write-Host $Message }
}

function Get-PathItemNoFollow([string]$Path) {
  try {
    # Test-Path follows junction targets, so it reports false for the exact
    # broken-link object that reconciliation needs to remove.
    return Get-Item -LiteralPath $Path -Force -ErrorAction Stop
  } catch {
    return $null
  }
}

function Remove-ReparsePointPath([string]$Path) {
  $item = Get-PathItemNoFollow $Path
  if ($null -eq $item) { return }
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
  if (Get-AgentCliExecutable 'codex' -Isolated:$IsolatedHome) { return $true }

  $localAppData = if ($IsolatedHome) { Join-Path $EffectiveHome 'AppData\Local' } else { [Environment]::GetFolderPath('LocalApplicationData') }
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
  $localAppData = if ($IsolatedHome) { Join-Path $EffectiveHome 'AppData\Local' } else { [Environment]::GetFolderPath('LocalApplicationData') }
  if (Get-AgentDesktopExecutable $localAppData @('Codex', 'OpenAI Codex', 'ChatGPT', 'OpenAI ChatGPT') @('Codex.exe', 'ChatGPT.exe') @('Codex', 'ChatGPT', 'OpenAI\Codex', 'OpenAI\ChatGPT') -Isolated:$IsolatedHome) { return $true }
  if ($IsolatedHome) { return $false }

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

  return $false
}

function Test-CanonicalParentSkillName([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value) -or $Value.Length -gt 64) { return $false }
  return $Value -cmatch '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$'
}

function Test-ValidSkillManifest([string]$SkillDirectory) {
  $manifest = Join-Path $SkillDirectory 'SKILL.md'
  if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { return $false }
  try {
    $lines = @(Get-Content -LiteralPath $manifest -Encoding UTF8 -TotalCount 256)
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
    $descriptionIndex = -1
    for ($index = 0; $index -lt $frontmatter.Count; $index += 1) {
      if ($frontmatter[$index] -match '^\s*description\s*:') {
        $descriptionIndex = $index
        break
      }
    }
    $descriptionLine = if ($descriptionIndex -ge 0) { $frontmatter[$descriptionIndex] } else { $null }
    $quoteChars = [char[]]@('"', "'")
    $nameValue = if ($null -ne $nameLine) { (($nameLine -split ':', 2)[1]).Trim().Trim($quoteChars) } else { '' }
    $descriptionValue = if ($null -ne $descriptionLine) { (($descriptionLine -split ':', 2)[1]).Trim().Trim($quoteChars) } else { '' }
    if ($descriptionValue -match '^[>|][+-]?$') {
      $descriptionParts = New-Object System.Collections.Generic.List[string]
      for ($index = $descriptionIndex + 1; $index -lt $frontmatter.Count; $index += 1) {
        $line = [string]$frontmatter[$index]
        if ([string]::IsNullOrWhiteSpace($line)) { continue }
        if ($line -notmatch '^\s+') { break }
        $descriptionParts.Add($line.Trim()) | Out-Null
      }
      $descriptionValue = ($descriptionParts -join ' ').Trim()
    }
    if ([string]::IsNullOrWhiteSpace($nameValue) -or
        [string]::IsNullOrWhiteSpace($descriptionValue)) {
      return $false
    }

    $isParentRouter = ($lines -join "`n").Contains('[ROUTER-HUB]')
    if ($isParentRouter) {
      $folderName = Split-Path -Leaf $SkillDirectory
      if (-not (Test-CanonicalParentSkillName $folderName) -or
          -not (Test-CanonicalParentSkillName $nameValue) -or
          $folderName -cne $nameValue) {
        return $false
      }
    }
    return $true
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
  if (Get-AgentCliExecutable 'claude' -Isolated:$IsolatedHome) { return $true }

  $nativeBinary = Join-Path $EffectiveHome '.local\bin\claude.exe'
  if (Test-Path -LiteralPath $nativeBinary -PathType Leaf) { return $true }

  $roamingRoot = if ($HomePath) { Join-Path $EffectiveHome 'AppData\Roaming' } else { [Environment]::GetFolderPath('ApplicationData') }
  $localRoot = if ($HomePath) { Join-Path $EffectiveHome 'AppData\Local' } else { [Environment]::GetFolderPath('LocalApplicationData') }
  if (Get-ClaudeDesktopCodeExecutable $roamingRoot $localRoot) { return $true }

  $claudeHome = Get-ClaudeConfigRoot
  foreach ($marker in @('settings.json', 'history.jsonl', 'projects', 'sessions', 'plugins', 'local')) {
    if (Test-Path -LiteralPath (Join-Path $claudeHome $marker)) { return $true }
  }

  return $false
}

function Get-ClaudeDesktopCodeExecutable([string]$RoamingRoot, [string]$LocalRoot = '') {
  if ([string]::IsNullOrWhiteSpace($RoamingRoot)) { return '' }
  $runtimeRoot = Join-Path $RoamingRoot 'Claude\claude-code'
  # Desktop downloads its own engine; it need not install a global CLI. Inspect
  # only the two version/hash levels, never recursively walk the user profile.
  foreach ($version in @(Get-ChildItem -LiteralPath $runtimeRoot -Directory -ErrorAction SilentlyContinue | Select-Object -First 128)) {
    if ($version.Name -notmatch '^\d+\.\d+\.\d+' -or ($version.Attributes -band [IO.FileAttributes]::ReparsePoint)) { continue }
    $direct = Join-Path $version.FullName 'claude.exe'
    if (Test-Path -LiteralPath $direct -PathType Leaf) { return $direct }
    foreach ($build in @(Get-ChildItem -LiteralPath $version.FullName -Directory -ErrorAction SilentlyContinue | Select-Object -First 128)) {
      if ($build.Attributes -band [IO.FileAttributes]::ReparsePoint) { continue }
      $binary = Join-Path $build.FullName 'claude.exe'
      if (Test-Path -LiteralPath $binary -PathType Leaf) { return $binary }
    }
  }
  if (-not [string]::IsNullOrWhiteSpace($LocalRoot)) {
    # Store MSIX redirects Desktop's Roaming data into its package cache.
    return Get-ClaudeDesktopCodeExecutable (Join-Path $LocalRoot 'Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming')
  }
  return ''
}

function Test-AntigravityPresent {
  if ($SimulateAntigravityPresent) { return $true }
  if (Get-AgentCliExecutable 'antigravity' -Isolated:$IsolatedHome) { return $true }
  $localData = if ($IsolatedHome) { Join-Path $EffectiveHome 'AppData\Local' } else { [Environment]::GetFolderPath('LocalApplicationData') }
  return [bool](Get-AgentDesktopExecutable $localData @('Antigravity', 'Antigravity (User)') @('Antigravity.exe') @('Antigravity') -Isolated:$IsolatedHome)
}

function Test-WorkBuddyPresent {
  $localData = if ($IsolatedHome) { Join-Path $EffectiveHome 'AppData\Local' } else { [Environment]::GetFolderPath('LocalApplicationData') }
  $script:WorkBuddyExecutable = Get-WorkBuddyExecutable $localData -Isolated:$IsolatedHome
  if ($SimulateWorkBuddyPresent) { return $true }
  return -not [string]::IsNullOrWhiteSpace($script:WorkBuddyExecutable)
}

# v3.3 experimental plain-folder recipients. A pre-existing ~/.cursor or
# ~/.gemini folder alone is never install evidence (I-12).
function Test-CursorPresent {
  if ($SimulateCursorPresent) { return $true }
  if (Get-AgentCliExecutable 'cursor' -Isolated:$IsolatedHome) { return $true }
  $localData = if ($IsolatedHome) { Join-Path $EffectiveHome 'AppData\Local' } else { [Environment]::GetFolderPath('LocalApplicationData') }
  return [bool](Get-AgentDesktopExecutable $localData @('Cursor') @('Cursor.exe') @('cursor', 'Cursor') -Isolated:$IsolatedHome)
}

function Test-GeminiCliPresent {
  if ($SimulateGeminiPresent) { return $true }
  if (Get-AgentCliExecutable 'gemini' -Isolated:$IsolatedHome) { return $true }
  $roaming = if ($IsolatedHome) { Join-Path $EffectiveHome 'AppData\Roaming' } else { [Environment]::GetFolderPath('ApplicationData') }
  return (Test-Path -LiteralPath (Join-Path $roaming 'npm\gemini.cmd') -PathType Leaf)
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
$TargetsPath = [Environment]::GetEnvironmentVariable('AI_SKILLHUB_AGENT_SKILL_TARGETS')
$DeliveryReportPath = [Environment]::GetEnvironmentVariable('AI_SKILLHUB_DELIVERY_REPORT')
$TargetsMode = -not [string]::IsNullOrWhiteSpace($TargetsPath)
$KnownTargetRecipients = @('claude', 'workbuddy', 'antigravity', 'codex', 'codex-legacy', 'cursor', 'gemini-cli')
$TargetRecipients = @()
$TargetSharedNames = @()
if ($TargetsMode) {
  if (-not (Test-Path -LiteralPath $TargetsPath -PathType Leaf)) {
    throw "Agent Skill targets file does not exist: $TargetsPath"
  }
  $targetsDocument = [IO.File]::ReadAllText($TargetsPath, [Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
  if ([int]$targetsDocument.version -ne 1) {
    throw 'Agent Skill targets file has an unsupported version. Existing AI tool links were preserved.'
  }
  $unionNames = @{}
  foreach ($name in @($targetsDocument.union)) {
    if (-not [string]::IsNullOrWhiteSpace([string]$name)) { $unionNames[[string]$name] = $true }
  }
  $activeSkillDirs = @($allActiveSkillDirs | Where-Object { $unionNames.ContainsKey($_.Name) })
  if ($unionNames.Count -gt 0 -and $activeSkillDirs.Count -eq 0) {
    throw "Agent Skill allowlist contains $($unionNames.Count) entries, but none match a valid active Skill. Existing AI tool links were preserved."
  }
  foreach ($recipient in @($targetsDocument.recipients)) {
    $recipientId = [string]$recipient.id
    $recipientAction = [string]$recipient.action
    if ($KnownTargetRecipients -notcontains $recipientId) {
      throw "Agent Skill targets name an unknown AI tool: $recipientId. Existing AI tool links were preserved."
    }
    if (@('deliver', 'release', 'skip') -notcontains $recipientAction) {
      throw "Agent Skill targets use an unknown action: $recipientAction. Existing AI tool links were preserved."
    }
    foreach ($name in @($recipient.names)) {
      if (-not [string]::IsNullOrWhiteSpace([string]$name) -and -not $unionNames.ContainsKey([string]$name)) {
        throw "Agent Skill allowlist contains no entry $name requested for $recipientId. Existing AI tool links were preserved."
      }
    }
    $TargetRecipients += $recipient
  }
  if ($null -ne $targetsDocument.shared) {
    $TargetSharedNames = @(@($targetsDocument.shared.names) | Where-Object { -not [string]::IsNullOrWhiteSpace([string]$_) } | ForEach-Object { [string]$_ })
  }
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
$workbuddyPresent = Test-WorkBuddyPresent

function Test-SharedSkillManifest([string]$Directory, [string]$OriginalDirectory) {
  try {
    $item = Get-Item -LiteralPath $Directory -Force -ErrorAction Stop
    $manifest = Get-Item -LiteralPath (Join-Path $Directory 'SKILL.md') -Force -ErrorAction Stop
    if (-not $item.PSIsContainer -or ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        $manifest.PSIsContainer -or ($manifest.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $manifest.Length -gt 2097152) { return $false }
    $content = [IO.File]::ReadAllText($manifest.FullName, [Text.UTF8Encoding]::new($false, $true))
    $marker = "`n<!-- AI SkillHub shared-skill v1 sha256:"
    $offset = $content.LastIndexOf($marker, [StringComparison]::Ordinal)
    if ($offset -lt 0) { return $false }
    $body = $content.Substring(0, $offset)
    $sha = [Security.Cryptography.SHA256]::Create()
    try { $hash = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($body)))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
    $original = (Join-Path $OriginalDirectory 'SKILL.md').Replace('\', '/')
    return $content -ceq ($body + $marker + $hash + " -->`n") -and $body.Contains('](<' + $original + '>).')
  } catch { return $false }
}

function Sync-LegacySharedCatalog {
  $catalog = $Shared.TrimEnd('\', '/') + '-catalog'
  $rootItem = Get-PathItemNoFollow $catalog
  if ($null -eq $rootItem) { return }
  if (-not $rootItem.PSIsContainer -or ($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "Legacy shared catalog is not a normal directory and was preserved: $catalog"
  }
  $changes = [System.Collections.Generic.List[object]]::new()
  # Validate the whole migration before moving anything. The old catalog may
  # already be registered in Coze; leave readable aliases that its scanner skips.
  foreach ($entry in @(Get-ChildItem -LiteralPath $catalog -Force -Directory)) {
    $target = Join-Path $RealSharedSkillsRoot $entry.Name
    if ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) {
      if ([string]$entry.Target -ne $target) { throw "External catalog link preserved: $($entry.FullName)" }
      if (-not $activeSkillNames.ContainsKey($entry.Name)) {
        $changes.Add([PSCustomObject]@{ Entry = $entry.FullName; Name = $entry.Name; Target = $target; RemoveLink = $true }) | Out-Null
      }
      continue
    }
    $files = @(Get-ChildItem -LiteralPath $entry.FullName -Force)
    if ($files.Count -ne 1 -or $files[0].Name -ne 'SKILL.md' -or
        -not (Test-SharedSkillManifest $entry.FullName (Join-Path $Shared $entry.Name))) {
      throw "Modified or personal catalog directory preserved: $($entry.FullName)"
    }
    $changes.Add([PSCustomObject]@{ Entry = $entry.FullName; Name = $entry.Name; Target = $target; RemoveLink = $false }) | Out-Null
  }
  $backupRoot = $catalog + '-backup-' + [guid]::NewGuid().ToString('N')
  foreach ($change in $changes) {
    if ($change.RemoveLink) {
      $current = Get-PathItemNoFollow $change.Entry
      if ($null -ne $current -and [string]$current.Target -eq $change.Target) { Remove-ReparsePointPath $change.Entry }
      continue
    }
    # Recheck ownership immediately before each reversible directory move.
    if (@(Get-ChildItem -LiteralPath $change.Entry -Force).Count -ne 1 -or
        -not (Test-SharedSkillManifest $change.Entry (Join-Path $Shared $change.Name))) {
      throw "Catalog entry changed during migration and was preserved: $($change.Entry)"
    }
    New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
    $backup = Join-Path $backupRoot $change.Name
    Move-Item -LiteralPath $change.Entry -Destination $backup
    if (-not $activeSkillNames.ContainsKey($change.Name)) { continue }
    try {
      New-Item -ItemType Junction -Path $change.Entry -Target $change.Target | Out-Null
    } catch {
      $failed = Get-PathItemNoFollow $change.Entry
      if ($null -ne $failed -and [string]$failed.Target -eq $change.Target) { Remove-ReparsePointPath $change.Entry }
      if ($null -eq (Get-PathItemNoFollow $change.Entry)) { Move-Item -LiteralPath $backup -Destination $change.Entry }
      throw
    }
  }
  if (Test-Path -LiteralPath $backupRoot) { Write-Step "Shared catalog migration backup: $backupRoot" }
}

# v3.3 (I-2): is this reparse point one SkillHub created? Every link into the
# active catalog is ours. A link into the shared Coze/Codex folder (codex-legacy
# compatibility) is ours only when it is the alias SkillHub makes, <name> ->
# <shared>\<name>, and that target is gone or is SkillHub's generated entry. A
# user's own link to their personal skill there is never removed or replaced.
function Test-SkillHubLinkTarget([string]$Name, [string]$Target, [string]$LinkSourceRoot) {
  if ([string]::IsNullOrWhiteSpace($Target)) { return $false }
  if (Test-UnderRoot $Target $Shared) { return $true }
  if ([string]::IsNullOrWhiteSpace($LinkSourceRoot) -or
      (Convert-ToFullPath $LinkSourceRoot).TrimEnd('\', '/') -ieq (Convert-ToFullPath $Shared).TrimEnd('\', '/') -or
      -not (Test-UnderRoot $Target $LinkSourceRoot)) {
    return $false
  }
  $expected = (Convert-ToFullPath (Join-Path $LinkSourceRoot $Name)).TrimEnd('\', '/')
  if ((Convert-ToFullPath $Target).TrimEnd('\', '/') -ine $expected) { return $false }
  if ($null -eq (Get-PathItemNoFollow $Target)) { return $true }
  $manifest = Join-Path $Target 'SKILL.md'
  if (-not (Test-Path -LiteralPath $manifest -PathType Leaf)) { return $false }
  try {
    return ([IO.File]::ReadAllText($manifest, [Text.Encoding]::UTF8)).Contains('<!-- AI SkillHub shared-skill v1 sha256:')
  } catch {
    return $false
  }
}

# v3.3 targets mode. Links exactly $Names (plus personal entries already
# there). A same-name entry that is not our reparse point is recorded as a
# conflict and left untouched: never moved, never deleted (I-2).
function Sync-TargetSkillDirectory(
  [string]$RecipientSkillsRoot,
  [string]$LinkSourceRoot,
  [string[]]$Names,
  $Entries,
  # Only 'Skip' exists: a same-name entry that is not ours is never replaced.
  [ValidateSet('Skip')][string]$ConflictPolicy = 'Skip'
) {
  $rootItem = Get-PathItemNoFollow $RecipientSkillsRoot
  if ($null -ne $rootItem) {
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
  $wantedNames = @{}
  foreach ($name in @($Names)) { if (-not [string]::IsNullOrWhiteSpace($name)) { $wantedNames[$name] = $true } }
  $wanted = @($activeSkillDirs | Where-Object { $wantedNames.ContainsKey($_.Name) })

  foreach ($oldName in @('AI_global_skills')) {
    $oldItem = Get-PathItemNoFollow (Join-Path $RecipientSkillsRoot $oldName)
    if ($null -ne $oldItem -and ($oldItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -and
        (([string]$oldItem.Target -eq $Shared) -or (Test-UnderRoot ([string]$oldItem.Target) $Shared))) {
      Remove-ReparsePointPath $oldItem.FullName
    }
  }

  foreach ($existing in @(Get-ChildItem -LiteralPath $RecipientSkillsRoot -Force -Directory -ErrorAction SilentlyContinue)) {
    if ($existing.Name -eq '.system') { continue }
    $item = Get-Item -LiteralPath $existing.FullName -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) { continue }
    $target = [string]$item.Target
    if ((Test-SkillHubLinkTarget $item.Name $target $LinkSourceRoot) -and -not $wantedNames.ContainsKey($item.Name)) {
      Remove-ReparsePointPath $item.FullName
      $Entries.Add([PSCustomObject]@{ name = $item.Name; state = 'removed'; detail = '' }) | Out-Null
    }
  }

  $linked = New-Object System.Collections.Generic.List[object]
  foreach ($skill in $wanted) {
    $target = Join-Path $LinkSourceRoot $skill.Name
    $dest = Join-Path $RecipientSkillsRoot $skill.Name
    $item = Get-PathItemNoFollow $dest
    if ($null -ne $item) {
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        $currentTarget = [string]$item.Target
        if ($currentTarget -eq $target) {
          $linked.Add([PSCustomObject]@{ Name = $skill.Name; State = 'unchanged' }) | Out-Null
          continue
        }
        if (-not (Test-SkillHubLinkTarget $skill.Name $currentTarget $LinkSourceRoot)) {
          $Entries.Add([PSCustomObject]@{ name = $skill.Name; state = 'conflict'; detail = 'external-link' }) | Out-Null
          continue
        }
        Remove-ReparsePointPath $dest
      } else {
        $kind = if ($item.PSIsContainer) { 'personal-folder' } else { 'not-a-folder' }
        $Entries.Add([PSCustomObject]@{ name = $skill.Name; state = 'conflict'; detail = $kind }) | Out-Null
        continue
      }
    }
    New-Item -ItemType Junction -Path $dest -Target $target | Out-Null
    $linked.Add([PSCustomObject]@{ Name = $skill.Name; State = 'linked' }) | Out-Null
  }

  # Post-write verification runs only for the names actually linked.
  foreach ($result in $linked) {
    $deliveredDirectory = Join-Path $RecipientSkillsRoot $result.Name
    $problem = ''
    $deliveredSkillMd = Join-Path $deliveredDirectory 'SKILL.md'
    if (-not (Test-Path -LiteralPath $deliveredSkillMd -PathType Leaf)) {
      $problem = '没有可读的 SKILL.md'
    } else {
      $body = [System.IO.File]::ReadAllText($deliveredSkillMd, [System.Text.Encoding]::UTF8)
      if ($body.Contains('[ROUTER-HUB]')) {
        $declaredCount = 0
        foreach ($line in ($body -split "`r?`n")) {
          if ($line -notmatch '^\s*-\s+\[CHILD-SKILL\]') { continue }
          $match = [regex]::Match($line, '来源文件：`([^`]+)`')
          if (-not $match.Success) { $problem = '父 Skill 子项声明格式无效'; break }
          $declaredCount++
          $declaredPath = [string]$match.Groups[1].Value
          $slashPath = $declaredPath -replace '\\', '/'
          if (-not [IO.Path]::IsPathRooted($declaredPath) -or $slashPath -match '(^|/)\.\.?(?:/|$)') { $problem = '父 Skill 子项路径不是安全绝对路径'; break }
          $resolvedChild = Convert-ToFullPath $declaredPath
          if (-not (Test-UnderRoot $resolvedChild $SourceRoot)) { $problem = '父 Skill 子项越过受管来源目录'; break }
          if (-not (Test-Path -LiteralPath $resolvedChild -PathType Leaf)) { $problem = '父 Skill 子项文件不可读'; break }
          try { [System.IO.File]::OpenRead($resolvedChild).Dispose() } catch { $problem = '父 Skill 子项文件不可读'; break }
        }
        if (-not $problem -and $declaredCount -lt 1) { $problem = '父 Skill 没有声明任何可调用子项' }
      }
    }
    if ($problem) {
      $Entries.Add([PSCustomObject]@{ name = $result.Name; state = 'invalid-manifest'; detail = $problem }) | Out-Null
    } else {
      $Entries.Add([PSCustomObject]@{ name = $result.Name; state = $result.State; detail = '' }) | Out-Null
    }
  }
}

# v3.3 release: remove only reparse points that point into SkillHub's own
# folders. Never creates the folder and never touches anything else.
function Remove-TargetSkillLinks([string]$RecipientSkillsRoot, [string]$LinkSourceRoot, $Entries) {
  $rootItem = Get-PathItemNoFollow $RecipientSkillsRoot
  if ($null -eq $rootItem) { return }
  if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    $rootTarget = [string]$rootItem.Target
    if (-not [string]::IsNullOrWhiteSpace($rootTarget) -and (Convert-ToFullPath $rootTarget) -eq (Convert-ToFullPath $Shared)) {
      Remove-ReparsePointPath $RecipientSkillsRoot
      $Entries.Add([PSCustomObject]@{ name = '(root)'; state = 'removed'; detail = '' }) | Out-Null
      return
    }
    # A root that links elsewhere was never written by SkillHub (deliver
    # refuses it), so there is nothing of ours to release. Leave it alone and
    # do not report a failure for a tool the user did not take over.
    return
  }
  if (-not $rootItem.PSIsContainer) { return }
  foreach ($existing in @(Get-ChildItem -LiteralPath $RecipientSkillsRoot -Force -Directory -ErrorAction SilentlyContinue)) {
    $item = Get-Item -LiteralPath $existing.FullName -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -eq 0) { continue }
    $target = [string]$item.Target
    if (Test-SkillHubLinkTarget $item.Name $target $LinkSourceRoot) {
      Remove-ReparsePointPath $item.FullName
      $Entries.Add([PSCustomObject]@{ name = $item.Name; state = 'removed'; detail = '' }) | Out-Null
    }
  }
}

function Sync-ManagedSkillDirectory([string]$RecipientSkillsRoot, [string]$LinkSourceRoot = $Shared, [switch]$PreserveConflicts) {
  # Older SkillHub releases linked the entire recipient Skills directory to the
  # flat active catalog. Convert only that known managed junction into a real
  # directory. Any external/user-owned link is preserved and rejected.
  $rootItem = Get-PathItemNoFollow $RecipientSkillsRoot
  if ($null -ne $rootItem) {
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

  if ($PreserveConflicts) {
    # Preflight before cleanup or replacement. A same-name personal entry is not
    # ours merely because it contains SKILL.md.
    foreach ($skill in $activeSkillDirs) {
      $entry = Get-PathItemNoFollow (Join-Path $RecipientSkillsRoot $skill.Name)
      if ($null -ne $entry -and (-not ($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
          -not ((Test-UnderRoot ([string]$entry.Target) $Shared) -or (Test-UnderRoot ([string]$entry.Target) $LinkSourceRoot)))) {
        throw "Personal or external Skill entry preserved: $($entry.FullName)"
      }
    }
  }

  foreach ($oldName in @('AI_global_skills')) {
    $oldPath = Join-Path $RecipientSkillsRoot $oldName
    $oldItem = Get-PathItemNoFollow $oldPath
    if ($null -ne $oldItem) {
      if (($oldItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -and
          (-not $PreserveConflicts -or ([string]$oldItem.Target -eq $Shared) -or (Test-UnderRoot ([string]$oldItem.Target) $Shared))) {
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
        if (((Test-UnderRoot $target $Shared) -or (Test-UnderRoot $target $LinkSourceRoot)) -and -not $activeSkillNames.ContainsKey($item.Name)) {
          Remove-ReparsePointPath $item.FullName
        }
      }
    }

  foreach ($skill in $activeSkillDirs) {
    $target = Join-Path $LinkSourceRoot $skill.Name
    $dest = Join-Path $RecipientSkillsRoot $skill.Name
    $item = Get-PathItemNoFollow $dest
    if ($null -ne $item) {
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
        $currentTarget = [string]$item.Target
        if ($currentTarget -eq $target) { continue }
        Remove-ReparsePointPath $dest
      } elseif ($item.Name -ne '.system') {
        # Beside the skills folder, never inside it: AI tools scan one level down and would
        # list every backed-up skill again.
        $backupRoot = Join-Path (Join-Path (Split-Path -Parent $RecipientSkillsRoot) 'AI_global接管前备份') ((Split-Path -Leaf $RecipientSkillsRoot) + '_' + $Stamp)
        New-Item -ItemType Directory -Force -Path $backupRoot | Out-Null
        Move-Item -LiteralPath $dest -Destination (Join-Path $backupRoot $skill.Name)
      }
    }
    New-Item -ItemType Junction -Path $dest -Target $target | Out-Null
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

function Get-TargetRecipientPresence([string]$Id) {
  switch ($Id) {
    'claude' { return $claudePresent }
    'workbuddy' { return $workbuddyPresent }
    'antigravity' { return $antigravityPresent }
    'codex' { return $codexPresent }
    'codex-legacy' { return $codexPresent }
    'cursor' { return (Test-CursorPresent) }
    'gemini-cli' { return (Test-GeminiCliPresent) }
  }
  return $false
}

function Get-TargetRecipientExpectedPath([string]$Id) {
  switch ($Id) {
    'claude' { return $claudePath }
    'workbuddy' { return (Join-Path (Get-WorkBuddyConfigRoot $EffectiveHome $WorkBuddyExecutable -Isolated:$IsolatedHome) 'skills') }
    'antigravity' { return $antigravityPath }
    'codex' { return (Join-Path $EffectiveHome '.agents\skills') }
    'codex-legacy' { return (Join-Path $EffectiveHome '.codex\skills') }
    'cursor' { return (Join-Path $EffectiveHome '.cursor\skills') }
    'gemini-cli' { return (Join-Path $EffectiveHome '.gemini\skills') }
  }
  return ''
}

if ($TargetsMode) {
  # Per-recipient results; one failing recipient never stops the others and
  # never makes the script exit non-zero (rule 4). Only the global checks
  # above fail closed.
  $reportRecipients = New-Object System.Collections.Generic.List[object]
  if ($RealSharedSkillsRoot) {
    $activeSkillNames = @{}
    foreach ($name in $TargetSharedNames) { $activeSkillNames[$name] = $true }
    try {
      Sync-LegacySharedCatalog
    } catch {
      Write-Warning ('Legacy shared catalog preserved: ' + $_.Exception.Message)
    }
  }
  foreach ($recipient in $TargetRecipients) {
    $id = [string]$recipient.id
    $action = [string]$recipient.action
    $path = [string]$recipient.path
    $entries = New-Object System.Collections.Generic.List[object]
    $outcome = 'skipped'
    $errorText = ''
    try {
      if ($action -eq 'skip') {
        $outcome = 'skipped'
      } else {
        $expected = Get-TargetRecipientExpectedPath $id
        if ([string]::IsNullOrWhiteSpace($path) -or -not [IO.Path]::IsPathRooted($path) -or
            [string]::IsNullOrWhiteSpace($expected) -or
            (Convert-ToFullPath $path).TrimEnd('\', '/') -ne (Convert-ToFullPath $expected).TrimEnd('\', '/')) {
          throw "Recipient path does not match the AI tool's skills folder and was not touched: $path"
        }
        $linkRoot = if (-not [string]::IsNullOrWhiteSpace([string]$recipient.linkRoot)) { [string]$recipient.linkRoot } else { $Shared }
        $linkRootIsShared = $RealSharedSkillsRoot -and
          ((Convert-ToFullPath $linkRoot).TrimEnd('\', '/') -eq $RealSharedSkillsRoot.TrimEnd('\', '/'))
        if ($linkRoot -ne $Shared -and -not $linkRootIsShared) {
          if ($action -eq 'deliver') {
            throw "Recipient link root is not a SkillHub folder and was not used: $linkRoot"
          }
          # Releasing only ever removes links into SkillHub's own folders.
          $linkRoot = $Shared
        }
        if ($action -eq 'release') {
          Remove-TargetSkillLinks $path $linkRoot $entries
          $outcome = 'released'
        } elseif (-not (Get-TargetRecipientPresence $id)) {
          # I-12: never create the folder of a tool without install evidence.
          $outcome = 'skipped-not-installed'
        } elseif ($recipient.shared -eq $true) {
          # Shared Coze/Codex folder: Rust wrote the real entries; verify only.
          foreach ($name in @($recipient.names)) {
            $entryPath = Join-Path $path $name
            if (Test-SharedSkillManifest $entryPath (Join-Path $Shared $name)) {
              $entries.Add([PSCustomObject]@{ name = [string]$name; state = 'unchanged'; detail = '' }) | Out-Null
            } elseif ($null -ne (Get-PathItemNoFollow $entryPath)) {
              $entries.Add([PSCustomObject]@{ name = [string]$name; state = 'conflict'; detail = 'personal-folder' }) | Out-Null
            } else {
              $entries.Add([PSCustomObject]@{ name = [string]$name; state = 'invalid-manifest'; detail = 'missing' }) | Out-Null
            }
          }
          $outcome = 'ok'
        } else {
          Sync-TargetSkillDirectory $path $linkRoot @($recipient.names) $entries -ConflictPolicy Skip
          $outcome = 'ok'
        }
        if ($outcome -eq 'ok' -and @($entries | Where-Object { $_.state -in @('conflict', 'invalid-manifest') }).Count -gt 0) {
          $outcome = 'partial'
        }
      }
    } catch {
      $outcome = 'failed'
      $errorText = $_.Exception.Message
    }
    $reportRecipients.Add([PSCustomObject]@{
      id = $id
      path = $path
      action = $action
      outcome = $outcome
      error = $errorText
      entries = [object[]]$entries.ToArray()
    }) | Out-Null
  }
  if (-not [string]::IsNullOrWhiteSpace($DeliveryReportPath)) {
    Write-JsonUtf8 $DeliveryReportPath ([PSCustomObject]@{
      version = 1
      generatedAt = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
      recipients = [object[]]$reportRecipients.ToArray()
    }) 6
  }
  if (-not $Quiet) {
    $reportRecipients | Select-Object id, action, outcome, error | Format-Table -AutoSize
  }
  exit 0
}

if ($RealSharedSkillsRoot) {
  foreach ($skill in $activeSkillDirs) {
    if (-not (Test-SharedSkillManifest (Join-Path $RealSharedSkillsRoot $skill.Name) $skill.FullName)) {
      throw "Shared Skill entry is missing, modified or not a normal directory: $($skill.Name)"
    }
  }
  Sync-LegacySharedCatalog
  $rows.Add([PSCustomObject]@{ App = 'Shared Skills'; Entry = $RealSharedSkillsRoot; Status = "$($activeSkillDirs.Count) verified real entries"; Target = $Shared }) | Out-Null
}

if ($workbuddyPresent) {
  $workbuddyPath = Join-Path (Get-WorkBuddyConfigRoot $EffectiveHome $WorkBuddyExecutable -Isolated:$IsolatedHome) 'skills'
  try {
    $workbuddyCount = Sync-ManagedSkillDirectory $workbuddyPath
    $workbuddyStatus = "$workbuddyCount verified parent-first links"
  } catch {
    $workbuddyStatus = 'Preserved existing directory: ' + $_.Exception.Message
    $recipientFailures.Add('WorkBuddy: ' + $_.Exception.Message) | Out-Null
  }
  $rows.Add([PSCustomObject]@{ App = 'WorkBuddy'; Entry = $workbuddyPath; Status = $workbuddyStatus; Target = $Shared }) | Out-Null
}

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
    if ($RealSharedSkillsRoot) {
      $codexStatus = "$($activeSkillDirs.Count) verified parent-first real user-scope entries"
    } else {
      $verifiedCount = Sync-ManagedSkillDirectory $codexRoot
      $codexStatus = "$verifiedCount verified parent-first user-scope links"
    }
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
      $legacyVerifiedCount = if ($RealSharedSkillsRoot) {
        Sync-ManagedSkillDirectory $legacyCodexRoot $RealSharedSkillsRoot -PreserveConflicts
      } else { Sync-ManagedSkillDirectory $legacyCodexRoot }
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

if (-not $claudePresent -and -not $codexPresent -and -not $antigravityPresent -and -not $workbuddyPresent -and -not $RealSharedSkillsRoot) {
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

