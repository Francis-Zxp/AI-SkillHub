param(
  [switch]$NoPull,
  [switch]$ReportOnly,
  [int]$GitCommandTimeoutSeconds = 18,
  [int]$GitUpdateBudgetSeconds = 95
)

$ErrorActionPreference = 'Stop'
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $Utf8NoBom
$OutputEncoding = $Utf8NoBom

$AppRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $AppRoot
$ConfigPath = if (-not [string]::IsNullOrWhiteSpace($env:AI_SKILLHUB_CONFIG_PATH)) {
  [Environment]::ExpandEnvironmentVariables($env:AI_SKILLHUB_CONFIG_PATH)
} else {
  Join-Path $AppRoot 'skillhub.config.json'
}
$PowerShellExe = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $PowerShellExe)) {
  throw "Missing Windows PowerShell: $PowerShellExe"
}
function Resolve-AppPath([string]$Path) {
  if ([System.IO.Path]::IsPathRooted($Path)) {
    return [System.IO.Path]::GetFullPath($Path)
  }
  return [System.IO.Path]::GetFullPath((Join-Path $AppRoot $Path))
}

function Write-Utf8Bom([string]$Path, [string]$Text) {
  $parent = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  $temp = $Path + '.skillhub-tmp'
  $backup = $Path + '.skillhub-previous'
  if (-not (Test-Path -LiteralPath $Path) -and (Test-Path -LiteralPath $backup -PathType Leaf)) {
    Move-Item -LiteralPath $backup -Destination $Path -Force
  }
  [System.IO.File]::WriteAllText($temp, $Text, [System.Text.UTF8Encoding]::new($true))
  try {
    if (Test-Path -LiteralPath $Path -PathType Leaf) {
      if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force }
      [System.IO.File]::Replace($temp, $Path, $backup, $true)
      Remove-Item -LiteralPath $backup -Force -ErrorAction SilentlyContinue
    } else {
      Move-Item -LiteralPath $temp -Destination $Path
    }
  } catch {
    if (-not (Test-Path -LiteralPath $Path) -and (Test-Path -LiteralPath $backup -PathType Leaf)) {
      Move-Item -LiteralPath $backup -Destination $Path -Force
    }
    if (Test-Path -LiteralPath $temp -PathType Leaf) { Remove-Item -LiteralPath $temp -Force }
    throw
  }
}

function Write-Utf8NoBom([string]$Path, [string]$Text) {
  $parent = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  $temp = $Path + '.skillhub-tmp'
  $backup = $Path + '.skillhub-previous'
  [System.IO.File]::WriteAllText($temp, $Text, [System.Text.UTF8Encoding]::new($false))
  if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force }
  if (Test-Path -LiteralPath $Path) { Move-Item -LiteralPath $Path -Destination $backup }
  try {
    Move-Item -LiteralPath $temp -Destination $Path
    if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force }
  } catch {
    if (Test-Path -LiteralPath $backup) { Move-Item -LiteralPath $backup -Destination $Path -Force }
    if (Test-Path -LiteralPath $temp) { Remove-Item -LiteralPath $temp -Force }
    throw
  }
}

function Read-Utf8Text([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return '' }
  return [System.IO.File]::ReadAllText($Path, [System.Text.UTF8Encoding]::new($false))
}

function Convert-ToRelativePath([string]$Root, [string]$Path) {
  $rootFull = (Convert-ToFullPath $Root).TrimEnd('\') + '\'
  $pathFull = Convert-ToFullPath $Path
  if ($pathFull.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    return $pathFull.Substring($rootFull.Length)
  }
  return $pathFull
}

function Write-JsonUtf8([string]$Path, $Object, [int]$Depth = 8) {
  # `@() | ConvertTo-Json` emits no output in Windows PowerShell 5.1. That
  # previously created a zero-byte managed-links.json on an empty library; the
  # next sync then called `.Trim()` on `$null` and failed with
  # FullyQualifiedErrorId=InvokeMethodOnNull. -InputObject preserves [] as JSON.
  $json = if ($null -eq $Object) {
    'null'
  } else {
    ConvertTo-Json -InputObject $Object -Depth $Depth
  }
  Write-Utf8Bom $Path ([string]$json)
}

$ScanSkipDirectoryNames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($scanSkipName in @(
  '.git',
  'node_modules',
  '.venv',
  'venv',
  'env',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  '.cache',
  '.next',
  '__pycache__',
  'target',
  '.idea',
  '.vscode'
)) {
  $ScanSkipDirectoryNames.Add($scanSkipName) | Out-Null
}

function Test-SkipScanDirectory([string]$DirectoryName, [bool]$SkipExtracted) {
  if ($SkipExtracted -and $DirectoryName -ieq '.skillhub-extracted') { return $true }
  return $ScanSkipDirectoryNames.Contains($DirectoryName)
}

function Get-FilesByPatternFast([string]$Root, [string]$Pattern, [switch]$SkipExtracted) {
  $results = New-Object System.Collections.Generic.List[object]
  if (-not (Test-Path -LiteralPath $Root -PathType Container)) { return $results }

  $stack = [System.Collections.Generic.Stack[string]]::new()
  $stack.Push((Convert-ToFullPath $Root))

  while ($stack.Count -gt 0) {
    $current = $stack.Pop()
    try {
      foreach ($file in [System.IO.Directory]::EnumerateFiles($current, $Pattern, [System.IO.SearchOption]::TopDirectoryOnly)) {
        $results.Add([System.IO.FileInfo]::new($file)) | Out-Null
      }
    } catch {
      continue
    }

    try {
      foreach ($directory in [System.IO.Directory]::EnumerateDirectories($current)) {
        $name = [System.IO.Path]::GetFileName($directory)
        if (Test-SkipScanDirectory $name ([bool]$SkipExtracted)) { continue }
        $stack.Push($directory)
      }
    } catch {
      continue
    }
  }

  return $results
}

function Join-ProcessArguments([string[]]$Arguments) {
  (($Arguments | ForEach-Object {
    $value = [string]$_
    if ($value -match '[\s"]') {
      '"' + ($value -replace '"', '\"') + '"'
    } else {
      $value
    }
  }) -join ' ')
}

function Stop-ProcessTreeQuietly([System.Diagnostics.Process]$Process) {
  if (-not $Process -or $Process.HasExited) { return }
  try {
    & taskkill.exe /PID $Process.Id /T /F 2>$null | Out-Null
  } catch {
    try { $Process.Kill() } catch {}
  }
  try { $Process.WaitForExit(5000) | Out-Null } catch {}
}

function Invoke-GitCommandWithTimeout([string[]]$Arguments, [string]$Label, [int]$TimeoutSeconds) {
  $process = $null
  $stdoutTask = $null
  $stderrTask = $null
  try {
    $startInfo = [System.Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = 'git'
    $startInfo.Arguments = Join-ProcessArguments $Arguments
    $startInfo.UseShellExecute = $false
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true
    $startInfo.CreateNoWindow = $true
    $startInfo.StandardOutputEncoding = $Utf8NoBom
    $startInfo.StandardErrorEncoding = $Utf8NoBom
    $process = [System.Diagnostics.Process]::Start($startInfo)
    if ($null -eq $process) {
      return [PSCustomObject]@{
        Label = $Label
        ExitCode = 1
        TimedOut = $false
        Stdout = ''
        Stderr = 'Git process could not be started.'
      }
    }
    $stdoutTask = $process.StandardOutput.ReadToEndAsync()
    $stderrTask = $process.StandardError.ReadToEndAsync()

    if (-not $process.WaitForExit([Math]::Max(1, $TimeoutSeconds) * 1000)) {
      Stop-ProcessTreeQuietly $process
      $timeoutStdout = ''
      $timeoutStderr = "Timed out after $TimeoutSeconds seconds."
      if ($null -ne $stdoutTask) {
        try { $timeoutStdout = [string]$stdoutTask.Result } catch {}
      }
      if ($null -ne $stderrTask) {
        try {
          $capturedTimeoutError = [string]$stderrTask.Result
          if (-not [string]::IsNullOrWhiteSpace($capturedTimeoutError)) {
            $timeoutStderr = $capturedTimeoutError
          }
        } catch {}
      }
      return [PSCustomObject]@{
        Label = $Label
        ExitCode = 124
        TimedOut = $true
        Stdout = $timeoutStdout
        Stderr = $timeoutStderr
      }
    }

    $stdoutText = ''
    $stderrText = ''
    if ($null -ne $stdoutTask) {
      try { $stdoutText = [string]$stdoutTask.Result } catch {}
    }
    if ($null -ne $stderrTask) {
      try { $stderrText = [string]$stderrTask.Result } catch {}
    }
    [PSCustomObject]@{
      Label = $Label
      ExitCode = $process.ExitCode
      TimedOut = $false
      Stdout = $stdoutText
      Stderr = $stderrText
    }
  } catch {
    [PSCustomObject]@{
      Label = $Label
      ExitCode = 1
      TimedOut = $false
      Stdout = ''
      Stderr = $_.Exception.Message
    }
  } finally {
    if ($process) { $process.Dispose() }
  }
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
    preferredPathFragments = @('\.claude\skills\', '\skills\', '\dist\codex\skills\', '\dist\claude\skills\', '\dist\openclaw\skills\', '\.agents\skills\')
    repositories = @()
  }
}

if (-not (Test-Path -LiteralPath $ConfigPath -PathType Leaf)) {
  Write-JsonUtf8 $ConfigPath (New-DefaultSkillHubConfig) 8
}

function Normalize-GitHubRepoUrl([string]$Url) {
  if ([string]::IsNullOrWhiteSpace($Url)) { return '' }
  $clean = $Url.Trim()
  $clean = $clean -replace '^\s*https\s*:\s*/\s*/\s*', 'https://'
  $clean = $clean -replace '\s+', ''
  return $clean.TrimEnd('/')
}

function Test-GitHubRepoUrl([string]$Url) {
  $clean = Normalize-GitHubRepoUrl $Url
  return ($clean -match '^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:\.git)?$')
}

function Get-RepoNameFromUrl([string]$Url) {
  $clean = Normalize-GitHubRepoUrl $Url
  $name = Split-Path -Leaf $clean
  if ($name.EndsWith('.git')) { $name = $name.Substring(0, $name.Length - 4) }
  return $name
}

function Assert-SafeRepoName([string]$Name) {
  if ($Name -notmatch '^[A-Za-z0-9_.-]+$') {
    throw "Unsafe repository name in config: $Name"
  }
}

function Convert-ToFullPath([string]$Path) {
  return [System.IO.Path]::GetFullPath($Path)
}

function Get-SafeSkillName([string]$DeclaredName, [string]$FolderName) {
  $candidate = if ([string]::IsNullOrWhiteSpace($DeclaredName)) { $FolderName } else { $DeclaredName.Trim() }
  if ($candidate -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$') {
    Write-Warning "Unsafe skill name '$candidate'. Falling back to folder name '$FolderName'."
    $candidate = $FolderName
  }
  if ($candidate -notmatch '^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$') {
    throw "Unsafe skill folder name: $candidate"
  }
  return $candidate
}

function Test-UnderRoot([string]$Child, [string]$Root) {
  $childFull = Convert-ToFullPath $Child
  $rootFull = (Convert-ToFullPath $Root).TrimEnd('\') + '\'
  return $childFull.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)
}

function Normalize-CategoryId([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
  switch -Regex ($Value) {
    'academic-writing|论文|論文|nature|manuscript' { return 'academic-writing' }
    'scientific-figures|图表|圖表|figure|plot|chart' { return 'scientific-figures' }
    'ui-design|界面|介面|ui|design|frontend' { return 'ui-design' }
    'literature-research|文献|文獻|research|literature' { return 'literature-research' }
    'presentation|汇报|匯報|ppt|slide' { return 'presentation' }
    'agent-tools|agent|browser|automation|workflow|best-practice|claude-code' { return 'agent-tools' }
    'prompt-polishing|提示词|提示詞|prompt|polish|润色|潤色' { return 'prompt-polishing' }
    'security|安全|vibesec|vulnerability' { return 'security' }
    'image-generation|图像|圖片|image|gpt-image' { return 'image-generation' }
    'knowledge-retrieval|知识|知識|retriever|knowledge|kb' { return 'knowledge-retrieval' }
    default { return $Value }
  }
}

function Get-SkillName([string]$SkillMdPath) {
  $lines = Get-Content -LiteralPath $SkillMdPath -TotalCount 40 -Encoding UTF8
  $nameLine = $lines | Where-Object { $_ -match '^name:' } | Select-Object -First 1
  if ($nameLine) {
    $name = ($nameLine -replace '^name:\s*', '').Trim().Trim('"').Trim("'")
    if ($name) { return $name }
  }
  return Split-Path -Leaf (Split-Path -Parent $SkillMdPath)
}

function Get-SkillDescription([string]$SkillMdPath) {
  $lines = Get-Content -LiteralPath $SkillMdPath -TotalCount 100 -Encoding UTF8
  $descLine = $lines | Where-Object { $_ -match '^description:' } | Select-Object -First 1
  if ($descLine) {
    return (($descLine -replace '^description:\s*', '').Trim().Trim('"').Trim("'"))
  }
  return ''
}

function Get-InferredCategoryId([string]$SkillName, [string]$Description, [string]$RepoName) {
  $text = (($SkillName + ' ' + $Description + ' ' + $RepoName).ToLowerInvariant())
  if ($text -match 'vibesec|security|secure|vulnerability|xss|csrf|audit') { return 'security' }
  if ($text -match 'gpt-image|image generation|image edit|raster|poster|avatar') { return 'image-generation' }
  if ($text -match 'kb-retriever|knowledge|retrieval|local knowledge|检索') { return 'knowledge-retrieval' }
  if ($text -match 'presentation|ppt|slide|deck|paper2ppt|video-presentation') { return 'presentation' }
  if ($text -match 'agent-browser|browser automation|agent|workflow|best-practice|claude-code') { return 'agent-tools' }
  if ($text -match 'frontend|ui|interface|design|layout|component|web-design|impeccable') { return 'ui-design' }
  if ($text -match 'figure|plot|chart|panel|legend|matplotlib|ggplot|visualization') { return 'scientific-figures' }
  if ($text -match 'literature|academic-researcher|paper-analyzer|results-analysis|methodolog|research gap') { return 'literature-research' }
  if ($text -match 'nature|manuscript|scientific-writing|paper|rebuttal|submission|citation|reference|conference|reviewer|academic') { return 'academic-writing' }
  if ($text -match 'prompt|polish|editing|proofread|writing') { return 'prompt-polishing' }
  return 'general'
}

function Get-PathPriority([string]$Path) {
  $normalized = $Path.Replace('/', '\')
  $priority = 50
  for ($i = 0; $i -lt $Config.preferredPathFragments.Count; $i++) {
    $fragment = [string]$Config.preferredPathFragments[$i]
    if ($normalized.Contains($fragment)) {
      $priority = $i + 1
      break
    }
  }
  return $priority
}

function Get-PathTieBreaker([string]$Path, [string]$RepoName) {
  $fullPath = (Convert-ToFullPath $Path).Replace('/', '\').TrimEnd('\')
  if ([string]::IsNullOrWhiteSpace($RepoName) -or -not $SourceRoot) {
    return 100
  }

  $repoRoot = (Join-Path $SourceRoot $RepoName).Replace('/', '\').TrimEnd('\')
  $extractedRoot = "$repoRoot\.skillhub-extracted\"
  if ($fullPath.StartsWith($extractedRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    $versionScore = Get-VersionScoreFromPath $fullPath
    if ($versionScore -gt 0) {
      return 20 - $versionScore
    }
    return 20
  }

  $directSkillsRoot = "$repoRoot\skills\"
  if ($fullPath.StartsWith($directSkillsRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    return 0
  }

  $directClaudeRoot = "$repoRoot\.claude\skills\"
  if ($fullPath.StartsWith($directClaudeRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    return 1
  }

  $directAgentsRoot = "$repoRoot\.agents\skills\"
  if ($fullPath.StartsWith($directAgentsRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    return 2
  }

  $distCodexRoot = "$repoRoot\dist\codex\skills\"
  if ($fullPath.StartsWith($distCodexRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    return 3
  }

  $distClaudeRoot = "$repoRoot\dist\claude\skills\"
  if ($fullPath.StartsWith($distClaudeRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    return 4
  }

  $distOpenClawRoot = "$repoRoot\dist\openclaw\skills\"
  if ($fullPath.StartsWith($distOpenClawRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    return 5
  }

  if ($fullPath.StartsWith("$repoRoot\", [System.StringComparison]::OrdinalIgnoreCase)) {
    $relative = $fullPath.Substring($repoRoot.Length + 1)
    $segmentCount = @($relative -split '\\' | Where-Object { $_ }).Count
    return 10 + $segmentCount
  }

  return 100
}

function Get-VersionScoreFromPath([string]$Path) {
  $matches = [regex]::Matches($Path, '(?i)(?:^|[\\/_-])v?(\d+)\.(\d+)(?:\.(\d+))?([a-z])?(?=[\\/_-]|$)')
  if ($matches.Count -eq 0) { return 0 }

  $best = 0
  foreach ($match in $matches) {
    $major = [int]$match.Groups[1].Value
    $minor = [int]$match.Groups[2].Value
    $patch = if ($match.Groups[3].Success) { [int]$match.Groups[3].Value } else { 0 }
    $letter = if ($match.Groups[4].Success) {
      [int][char]$match.Groups[4].Value.ToLowerInvariant()[0] - [int][char]'a' + 1
    } else {
      0
    }
    $score = ($major * 1000000) + ($minor * 10000) + ($patch * 100) + $letter
    if ($score -gt $best) { $best = $score }
  }
  return $best
}

function Get-ZipPackageFamilyName([string]$ZipFileName) {
  $name = [System.IO.Path]::GetFileNameWithoutExtension($ZipFileName)
  $name = $name -replace '(?i)[-_]v?\d+\.\d+(?:\.\d+)?[a-z]?(?:[-_].*)?$', ''
  $name = $name -replace '(?i)[-_]skill$', ''
  if ([string]::IsNullOrWhiteSpace($name)) {
    return [System.IO.Path]::GetFileNameWithoutExtension($ZipFileName)
  }
  return $name
}

function Get-GitCommitShortFast([string]$RepoPath) {
  $gitPath = Join-Path $RepoPath '.git'
  if (-not (Test-Path -LiteralPath $gitPath)) { return '' }

  $gitDir = $gitPath
  if (-not (Test-Path -LiteralPath $gitPath -PathType Container)) {
    try {
      $gitFile = Read-Utf8Text $gitPath
      if ($gitFile -match '^gitdir:\s*(.+)$') {
        $candidate = $matches[1].Trim()
        if (-not [System.IO.Path]::IsPathRooted($candidate)) {
          $candidate = Join-Path $RepoPath $candidate
        }
        $gitDir = Convert-ToFullPath $candidate
      }
    } catch {
      return ''
    }
  }

  $headPath = Join-Path $gitDir 'HEAD'
  if (-not (Test-Path -LiteralPath $headPath)) { return '' }
  $head = (Read-Utf8Text $headPath).Trim()
  if ([string]::IsNullOrWhiteSpace($head)) { return '' }
  if ($head -notmatch '^ref:\s*(.+)$') {
    if ($head.Length -ge 7) { return $head.Substring(0, 7) }
    return $head
  }

  $refName = $matches[1].Trim()
  $refPath = Join-Path $gitDir ($refName -replace '/', [System.IO.Path]::DirectorySeparatorChar)
  if (Test-Path -LiteralPath $refPath) {
    $commit = (Read-Utf8Text $refPath).Trim()
    if ($commit.Length -ge 7) { return $commit.Substring(0, 7) }
    return $commit
  }

  $packedRefsPath = Join-Path $gitDir 'packed-refs'
  if (Test-Path -LiteralPath $packedRefsPath) {
    foreach ($line in [System.IO.File]::ReadLines($packedRefsPath)) {
      if ($line.StartsWith('#') -or $line.StartsWith('^')) { continue }
      $parts = $line -split '\s+'
      if ($parts.Count -ge 2 -and $parts[1] -eq $refName) {
        if ($parts[0].Length -ge 7) { return $parts[0].Substring(0, 7) }
        return $parts[0]
      }
    }
  }

  return ''
}

function Get-IsReparsePoint($Item) {
  return (($Item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)
}

function Remove-ManagedReparsePoint([string]$Path, [string]$Root, [string]$Skill, [string]$Action, [string]$Target) {
  if (-not (Test-Path -LiteralPath $Path)) { return $false }
  if (-not (Test-UnderRoot $Path $Root)) { throw "Refusing to remove path outside skills root: $Path" }

  $item = Get-Item -LiteralPath $Path -Force
  if (-not (Get-IsReparsePoint $item)) {
    $actions.Add([PSCustomObject]@{ Skill = $Skill; Action = 'Skipped real folder'; Target = $Path }) | Out-Null
    return $false
  }

  try {
    if ($item.PSIsContainer) {
      [System.IO.Directory]::Delete($item.FullName, $false)
    } else {
      [System.IO.File]::Delete($item.FullName)
    }
    $actions.Add([PSCustomObject]@{ Skill = $Skill; Action = $Action; Target = $Target }) | Out-Null
    return $true
  } catch {
    $actions.Add([PSCustomObject]@{ Skill = $Skill; Action = 'Skipped link cleanup: ' + $_.Exception.Message; Target = $Target }) | Out-Null
    return $false
  }
}

function Get-ConfiguredRepo([string]$Name) {
  return $Config.repositories | Where-Object { $_.name -eq $Name } | Select-Object -First 1
}

function Add-Candidate($List, [string]$Folder, [string]$RepoName, [bool]$Explicit) {
  $skillMd = Join-Path $Folder 'SKILL.md'
  if (-not (Test-Path -LiteralPath $skillMd)) { return }

  $folderName = Split-Path -Leaf $Folder
  $declaredSkillName = Get-SkillName $skillMd
  $skillName = Get-SafeSkillName $declaredSkillName $folderName
  $description = Get-SkillDescription $skillMd
  $repoConfig = Get-ConfiguredRepo $RepoName
  $categoryId = ''
  if ($repoConfig) {
    if ($repoConfig.categoryId) { $categoryId = Normalize-CategoryId ([string]$repoConfig.categoryId) }
    elseif ($repoConfig.category) { $categoryId = Normalize-CategoryId ([string]$repoConfig.category) }
  }
  if (-not $categoryId) {
    $categoryId = Get-InferredCategoryId $skillName $description $RepoName
  }
  $note = if ($repoConfig -and $repoConfig.note) { [string]$repoConfig.note } else { '' }
  $priority = if ($Explicit) { 0 } else { Get-PathPriority $Folder }
  $tieBreaker = if ($Explicit) { 0 } else { Get-PathTieBreaker $Folder $RepoName }

  $List.Add([PSCustomObject]@{
    Skill = $skillName
    FolderName = $folderName
    DeclaredName = $declaredSkillName
    Repo = $RepoName
    Source = (Convert-ToFullPath $Folder)
    CategoryId = $categoryId
    Note = $note
    Description = $description
    Priority = $priority
    TieBreaker = $tieBreaker
    Explicit = $Explicit
  }) | Out-Null
}

function Normalize-SkillLookupName([string]$Value) {
  if ([string]::IsNullOrWhiteSpace($Value)) { return '' }
  return ($Value.Trim().ToLowerInvariant() -replace '[_\s]+', '-')
}

function Get-LocalizedRouterChildSummary([string]$SkillName, [string]$Description) {
  $descriptionText = if ($null -eq $Description) { '' } else { $Description.Trim() }
  if ($descriptionText -match '[\u3400-\u9fff]') {
    return $descriptionText.TrimEnd('。', '；', ';', '.')
  }
  $searchText = (($SkillName + ' ' + $descriptionText).ToLowerInvariant())
  if ($searchText -match 'figure|plot|chart|diagram|visual') { return '用于科研图表的规划、生成、编辑与质量优化' }
  if ($searchText -match 'citation|reference|verify|evidence|doi') { return '用于引用、参考文献与证据的核验和整理' }
  if ($searchText -match 'review|reviewer|rebuttal|peer-review') { return '用于论文评审、修改建议与审稿回复' }
  if ($searchText -match 'paper|manuscript|writing|draft|academic') { return '用于科研论文的写作、润色与结构优化' }
  if ($searchText -match 'literature|research|search|survey|arxiv') { return '用于文献检索、研究分析与综述整理' }
  if ($searchText -match 'security|secure|audit|vulnerability|threat') { return '用于安全检查、风险分析与修复建议' }
  if ($searchText -match 'browser|web|scrape|crawl|playwright') { return '用于网页浏览、信息提取与浏览器自动化' }
  if ($searchText -match 'slide|presentation|ppt|deck') { return '用于演示文稿的规划、制作与视觉优化' }
  if ($searchText -match 'database|dataset|analysis|statistics|omics') { return '用于数据检索、处理、分析与结果解释' }
  if ($searchText -match 'image|photo|illustration|render') { return '用于图像生成、编辑与视觉内容制作' }
  if ($searchText -match 'design|ui|ux|frontend|layout') { return '用于界面设计、前端实现与体验优化' }
  if ($searchText -match 'code|debug|test|developer|android|ios') { return '用于代码实现、调试、测试与工程质量改进' }
  return ('用于处理“{0}”相关任务' -f $SkillName)
}

function Get-RouterCapabilityLabel([string]$SkillName, [string]$Description) {
  $text = (($SkillName + ' ' + $Description).ToLowerInvariant())
  if ($text -match 'figure|plot|chart|diagram|visualization|科研图|绘图|图表|可视化') { return '科研绘图' }
  if ($text -match 'citation|reference|bibliography|doi|参考文献|引用') { return '参考文献' }
  if ($text -match 'review|reviewer|rebuttal|peer-review|审稿|评审|审查') { return '论文审查' }
  if ($text -match 'paper|manuscript|writing|draft|academic|润色|论文写作|科研论文') { return '论文撰写与润色' }
  if ($text -match 'literature|research|search|survey|arxiv|文献检索|综述') { return '文献检索与综述' }
  if ($text -match 'security|secure|audit|vulnerability|threat|安全检查|风险分析') { return '安全审计' }
  if ($text -match 'browser|web|scrape|crawl|playwright|网页浏览|浏览器自动化') { return '网页与浏览器自动化' }
  if ($text -match 'slide|presentation|ppt|deck|演示文稿') { return '演示文稿' }
  if ($text -match 'database|dataset|analysis|statistics|omics|数据分析|统计') { return '数据分析' }
  if ($text -match 'image|photo|illustration|render|图像生成|视觉内容') { return '图像设计' }
  if ($text -match 'design|ui|ux|frontend|layout|界面设计|前端实现') { return '界面设计' }
  if ($text -match 'code|debug|test|developer|android|ios|代码实现|调试') { return '代码工程' }
  $fallback = ($SkillName -replace '[-_]+', ' ').Trim()
  if ($fallback.Length -gt 16) { return $fallback.Substring(0, 16) + '…' }
  return $fallback
}

function Ensure-CollectionRouterSkill($List, [string]$RepoName, $RepoCandidates) {
  if ([string]::IsNullOrWhiteSpace($RepoName)) { return }
  if ($RepoName -eq 'AI-SkillHub-local-routers') { return }

  $repoKey = Normalize-SkillLookupName $RepoName
  $parentCandidate = @(
    $RepoCandidates | Where-Object {
      (Normalize-SkillLookupName ([string]$_.Skill)) -eq $repoKey
    } | Sort-Object Priority, TieBreaker, Source | Select-Object -First 1
  )
  $childSkills = @(
    $RepoCandidates | Sort-Object Skill, Source -Unique
  )
  if ($childSkills.Count -lt 1) { return }

  $safeRouterName = Get-SafeSkillName $RepoName $RepoName
  $routerRoot = Join-Path $SourceRoot 'AI-SkillHub-local-routers'
  $routerFolder = Join-Path $routerRoot $safeRouterName
  if (-not (Test-UnderRoot $routerFolder $SourceRoot)) {
    throw "Router target escaped source root: $routerFolder"
  }

  # Same-name children inside one source are kept, never dropped: a repository
  # may ship `src/` plus per-host build outputs, or two genuinely different
  # Skills may collide. Count them here so the repeated ones can be qualified
  # with their in-source location instead of rendering as identical options.
  $childNameCounts = @{}
  foreach ($child in $childSkills) {
    $nameKey = Normalize-SkillLookupName ([string]$child.Skill)
    if ($childNameCounts.ContainsKey($nameKey)) {
      $childNameCounts[$nameKey] = $childNameCounts[$nameKey] + 1
    } else {
      $childNameCounts[$nameKey] = 1
    }
  }

  $childLines = @($childSkills | Sort-Object Skill, Source | ForEach-Object {
    $childSkillMd = Join-Path ([string]$_.Source) 'SKILL.md'
    # Absolute, forward-slash path. Routers are machine-local generated files
    # regenerated on every sync, so they never need portable relative paths --
    # and a relative path is actively wrong, because the recipient opens this
    # router through a junction chain (~/.claude/skills/X -> UserData/skills/X
    # -> router folder). Any '../..' is resolved lexically against the delivered
    # path by the Agent, landing outside the published Skill directory.
    $absoluteChild = (Convert-ToFullPath $childSkillMd) -replace '\\', '/'
    $childDescription = Get-LocalizedRouterChildSummary ([string]$_.Skill) ([string]$_.Description)
    $nameKey = Normalize-SkillLookupName ([string]$_.Skill)
    $label = '`${0}`' -f ([string]$_.Skill)
    if ($childNameCounts[$nameKey] -gt 1) {
      # Location is relative to the collection root, so the qualifier reads
      # `src/skill` rather than repeating the source name on every line.
      $collectionRoot = Join-Path $SourceRoot $RepoName
      $relativeChild = Convert-ToRelativePath -Root $collectionRoot -Path $childSkillMd
      $location = Split-Path -Parent $relativeChild
      if ([string]::IsNullOrWhiteSpace($location)) { $location = '.' }
      $label = '`${0}` （{1}）' -f ([string]$_.Skill), ($location -replace '\\', '/')
    }
    '- [CHILD-SKILL] {0} — {1}；来源文件：`{2}`' -f $label, $childDescription, $absoluteChild
  })
  $capabilityLabels = [System.Collections.Generic.List[string]]::new()
  foreach ($child in ($childSkills | Sort-Object Skill)) {
    $label = Get-RouterCapabilityLabel ([string]$child.Skill) ([string]$child.Description)
    if (-not [string]::IsNullOrWhiteSpace($label) -and -not $capabilityLabels.Contains($label)) {
      $capabilityLabels.Add($label) | Out-Null
    }
    if ($capabilityLabels.Count -ge 5) { break }
  }
  $capabilitySummary = if ($capabilityLabels.Count -gt 0) { $capabilityLabels -join '、' } else { '自动选择能力' }
  $originalParentSection = @()
  if ($parentCandidate.Count -gt 0) {
    $parentSkillMd = Join-Path ([string]$parentCandidate[0].Source) 'SKILL.md'
    $parentBody = Read-Utf8Text $parentSkillMd
    if (-not [string]::IsNullOrWhiteSpace($parentBody)) {
      $parentBody = [regex]::Replace($parentBody, '(?s)\A---\s*.*?---\s*', '').Trim()
      if ($parentBody.Length -gt 16000) {
        $parentBody = $parentBody.Substring(0, 16000) + [Environment]::NewLine + '[TRUNCATED: original parent Skill content is longer than 16000 characters.]'
      }
      $relativeParent = (Convert-ToFullPath $parentSkillMd) -replace '\\', '/'
      $originalParentSection = @(
        ''
        'Original parent Skill content preserved from source:'
        $relativeParent
        ''
        $parentBody
      )
    }
  }
  $routerText = @(
    '---'
    "name: $safeRouterName"
    "description: `"◈ 父 · $($childSkills.Count) 个子项 · $capabilitySummary`""
    '---'
    ''
    '<!-- [ROUTER-HUB] -->'
    ''
    "# ◈ 父 Skill · $RepoName"
    ''
    '> 这是 AI SkillHub 生成的稳定父入口。Agent 只需识别这个入口，子 Skill 由父 Skill 在自己的来源目录内选择和加载。'
    ''
    "- 管理来源：``$RepoName``"
    ''
    '父路由生成在作者仓库之外，因此 GitHub 更新不会覆盖标记、子 Skill 清单或隔离规则。'
    ''
    '类型：AI SkillHub 管理的父 Skill；下方 [CHILD-SKILL] 表示来源内的功能型子 Skill。'
    ''
    '路由规则：'
    '- 下方每个子 Skill 都给出完整绝对路径。执行前必须先用文件读取工具打开该路径的全文，不要凭名称或摘要推测其内容。'
    '- 路径请原样使用，不要拼接、不要相对化、不要基于本文件所在目录再做解析。'
    "- 只能打开下方明确列出的、属于来源 ``$RepoName`` 的文件。"
    '- 即使其它父 Skill 有同名子 Skill，也绝不跨来源替换。'
    '- 同名子项后面括号内是它在来源中的位置，用于区分；按用户意图选择其一。'
    '- 用户明确指定子 Skill 时，直接打开并完整遵循对应来源文件。'
    '- 用户只指定父 Skill 或描述宽泛任务时，自动选择能完成任务的最小子 Skill。'
    '- 只有在任务存在实质性歧义或安全风险时才向用户提问。'
    '- 使用与用户相同的语言回答；子 Skill 原文为英文时也要给出自然中文说明。'
    ''
    '此父 Skill 包含的子 Skill：'
    ($childLines -join [Environment]::NewLine)
    ($originalParentSection -join [Environment]::NewLine)
  ) -join [Environment]::NewLine

  $routerSkillMd = Join-Path $routerFolder 'SKILL.md'
  if (-not $ReportOnly) {
    Write-Utf8NoBom $routerSkillMd $routerText
  }

  if (Test-Path -LiteralPath $routerSkillMd) {
    Add-Candidate $List $routerFolder $RepoName $true
  }
}

function Expand-SkillZipPackages([string]$RepoPath) {
  if (-not (Test-Path -LiteralPath $RepoPath -PathType Container)) { return @() }

  $extractRoot = Join-Path $RepoPath '.skillhub-extracted'
  if (-not (Test-UnderRoot $extractRoot $RepoPath)) {
    throw "Extract target escaped repository root: $extractRoot"
  }

  $zipFileCandidates = @(Get-FilesByPatternFast $RepoPath '*.zip' -SkipExtracted | ForEach-Object {
      [PSCustomObject]@{
        File = $_
        Family = Get-ZipPackageFamilyName $_.Name
        VersionScore = Get-VersionScoreFromPath $_.FullName
      }
    })
  $zipFiles = New-Object System.Collections.Generic.List[object]
  foreach ($zipGroup in ($zipFileCandidates | Group-Object Family)) {
    $versioned = @($zipGroup.Group | Where-Object { $_.VersionScore -gt 0 } | Sort-Object VersionScore -Descending)
    if ($versioned.Count -gt 0) {
      $zipFiles.Add($versioned[0].File) | Out-Null
    } else {
      foreach ($item in $zipGroup.Group) {
        $zipFiles.Add($item.File) | Out-Null
      }
    }
  }

  $expanded = New-Object System.Collections.Generic.List[object]
  if ($zipFiles.Count -eq 0) { return $expanded }

  Add-Type -AssemblyName System.IO.Compression.FileSystem

  $expectedPackageNames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
  foreach ($zipFile in $zipFiles) {
    $expectedPackageNames.Add((Get-SafeSkillName ([System.IO.Path]::GetFileNameWithoutExtension($zipFile.Name)) ([System.IO.Path]::GetFileNameWithoutExtension($zipFile.Name)))) | Out-Null
  }
  if (Test-Path -LiteralPath $extractRoot) {
    Get-ChildItem -LiteralPath $extractRoot -Force -Directory -ErrorAction SilentlyContinue |
      Where-Object { -not $expectedPackageNames.Contains($_.Name) } |
      ForEach-Object {
        if (Test-UnderRoot $_.FullName $extractRoot) {
          Remove-Item -LiteralPath $_.FullName -Recurse -Force
        }
      }
  }

  $manifestPath = Join-Path $extractRoot '.skillhub-zip-manifest.json'
  $manifestByZip = @{}
  $manifestChanged = $false
  if (Test-Path -LiteralPath $manifestPath) {
    try {
      foreach ($entry in @((Get-Content -LiteralPath $manifestPath -Raw) | ConvertFrom-Json)) {
        if ($entry.Zip) {
          $manifestByZip[[string]$entry.Zip] = $entry
        } else {
          $manifestChanged = $true
        }
      }
    } catch {
      $manifestByZip = @{}
      $manifestChanged = $true
    }
  }

  foreach ($zipFile in $zipFiles) {
    $archive = $null
    try {
      $archive = [System.IO.Compression.ZipFile]::OpenRead($zipFile.FullName)
      $skillEntries = @($archive.Entries | Where-Object {
          $entryName = $_.FullName.Replace('\', '/').Trim('/')
          $entryName -eq 'SKILL.md' -or $entryName.EndsWith('/SKILL.md')
        })
      if ($skillEntries.Count -eq 0) { continue }

      $safePackageName = Get-SafeSkillName ([System.IO.Path]::GetFileNameWithoutExtension($zipFile.Name)) ([System.IO.Path]::GetFileNameWithoutExtension($zipFile.Name))
      $target = Join-Path $extractRoot $safePackageName
      $markerPath = Join-Path $target '.skillhub-zip-cache.json'
      $skillPaths = @($skillEntries | ForEach-Object {
          $relative = $_.FullName.Replace('\', '/').TrimStart('/')
          $parts = @($relative -split '/' | Where-Object { $_ })
          if ($parts.Count -gt 0) {
            [System.IO.Path]::Combine($target, ($parts -join [System.IO.Path]::DirectorySeparatorChar))
          }
        })
      $zipKey = Convert-ToRelativePath $RepoPath $zipFile.FullName
      $cached = $manifestByZip[$zipKey]
      $marker = $null
      if (Test-Path -LiteralPath $markerPath) {
        try { $marker = (Get-Content -LiteralPath $markerPath -Raw) | ConvertFrom-Json } catch { $marker = $null }
      }
      $markerMatches = $marker -and
        ([int64]$marker.Length -eq [int64]$zipFile.Length) -and
        ([int64]$marker.LastWriteTimeUtcTicks -eq [int64]$zipFile.LastWriteTimeUtc.Ticks)
      $manifestMatches = $cached -and
        ([int64]$cached.Length -eq [int64]$zipFile.Length) -and
        ([int64]$cached.LastWriteTimeUtcTicks -eq [int64]$zipFile.LastWriteTimeUtc.Ticks)
      $cacheMatches = (Test-Path -LiteralPath $target -PathType Container) -and ($markerMatches -or $manifestMatches)
      if ($cacheMatches) {
        if (-not $markerMatches) {
          Write-JsonUtf8 $markerPath ([PSCustomObject]@{
              Zip = $zipKey
              Length = [int64]$zipFile.Length
              LastWriteTimeUtcTicks = [int64]$zipFile.LastWriteTimeUtc.Ticks
            }) 4
        }
        $expanded.Add([PSCustomObject]@{
          Zip = $zipFile.FullName
          Target = $target
          SkillCount = $skillEntries.Count
          SkillPaths = $skillPaths
        }) | Out-Null
        continue
      }

      if (-not (Test-UnderRoot $target $extractRoot)) {
        throw "Extract package target escaped generated root: $target"
      }

      if (Test-Path -LiteralPath $target) {
        Remove-Item -LiteralPath $target -Recurse -Force
      }
      New-Item -ItemType Directory -Force -Path $target | Out-Null

      $targetFull = (Convert-ToFullPath $target).TrimEnd('\')
      foreach ($entry in $archive.Entries) {
        if ([string]::IsNullOrWhiteSpace($entry.Name)) { continue }
        $relative = $entry.FullName.Replace('\', '/').TrimStart('/')
        $parts = @($relative -split '/' | Where-Object { $_ })
        $unsafeParts = @($parts | Where-Object { $_ -eq '..' -or $_ -match '^[A-Za-z]:$' })
        if ($parts.Count -eq 0 -or $unsafeParts.Count -gt 0) {
          throw "Unsafe zip entry path: $($entry.FullName)"
        }

        $destination = [System.IO.Path]::Combine($target, ($parts -join [System.IO.Path]::DirectorySeparatorChar))
        $destinationFull = Convert-ToFullPath $destination
        if (-not $destinationFull.StartsWith($targetFull + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
          throw "Zip entry escaped extraction root: $($entry.FullName)"
        }

        $destinationDir = Split-Path -Parent $destination
        New-Item -ItemType Directory -Force -Path $destinationDir | Out-Null
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $destination, $true)
      }

      $expanded.Add([PSCustomObject]@{
        Zip = $zipFile.FullName
        Target = $target
        SkillCount = $skillEntries.Count
        SkillPaths = $skillPaths
      }) | Out-Null
      $manifestByZip[$zipKey] = [PSCustomObject]@{
        Zip = $zipKey
        Length = [int64]$zipFile.Length
        LastWriteTimeUtcTicks = [int64]$zipFile.LastWriteTimeUtc.Ticks
        Target = $safePackageName
      }
      Write-JsonUtf8 $markerPath ([PSCustomObject]@{
          Zip = $zipKey
          Length = [int64]$zipFile.Length
          LastWriteTimeUtcTicks = [int64]$zipFile.LastWriteTimeUtc.Ticks
        }) 4
      $manifestChanged = $true
    } catch {
      Write-Warning "Skill zip extraction failed for $($zipFile.FullName): $($_.Exception.Message)"
    } finally {
      if ($archive) { $archive.Dispose() }
    }
  }

  if ($manifestChanged) {
    $manifestRows = @($manifestByZip.GetEnumerator() | ForEach-Object { $_.Value } | Sort-Object Zip)
    Write-Utf8Bom $manifestPath ($manifestRows | ConvertTo-Json -Depth 5)
  }

  return $expanded
}

$Config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$SourceRoot = Resolve-AppPath $Config.githubSourcesFolder
$SkillsRoot = Resolve-AppPath $Config.activeSkillsFolder
$StateBase = if (-not [string]::IsNullOrWhiteSpace($env:AI_SKILLHUB_STATE)) {
  [Environment]::ExpandEnvironmentVariables($env:AI_SKILLHUB_STATE)
} else {
  Join-Path (Split-Path -Parent $AppRoot) '.skillhub-next'
}
$StateRoot = Join-Path $StateBase 'sync-state'
$ReportsRoot = if (-not [string]::IsNullOrWhiteSpace($env:AI_SKILLHUB_REPORTS)) {
  [Environment]::ExpandEnvironmentVariables($env:AI_SKILLHUB_REPORTS)
} else {
  Join-Path (Split-Path -Parent $AppRoot) 'reports'
}
$ArchivesRoot = Join-Path $StateBase 'archives'
$Stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$ArchiveRoot = Join-Path $ArchivesRoot "replaced_active_skill_copies_$Stamp"
$StatePath = Join-Path $StateRoot 'managed-links.json'
$ReportPath = Join-Path $ReportsRoot 'last-sync.md'
$ReportJsonPath = Join-Path $ReportsRoot 'last-sync.json'
$AgentLinkScript = Join-Path $AppRoot 'Manage-AgentSkillLinks.ps1'
$GovernancePath = Join-Path $StateBase 'source-governance.json'
$PinnedSourceRevisions = @{}
$GovernanceManifestReadable = $true
if (Test-Path -LiteralPath $GovernancePath -PathType Leaf) {
  try {
    $governanceManifest = Get-Content -LiteralPath $GovernancePath -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($pin in @($governanceManifest.pins)) {
      $folder = ([string]$pin.sourceFolder).Trim()
      $revision = ([string]$pin.pinnedRevision).Trim()
      if (-not [string]::IsNullOrWhiteSpace($folder) -and
          $revision -match '^[0-9a-fA-F]{40}$') {
        $PinnedSourceRevisions[$folder] = $revision.ToLowerInvariant()
      }
    }
  } catch {
    $GovernanceManifestReadable = $false
    Write-Warning "Source pin manifest could not be read. Repository updates are blocked so a pinned source cannot drift: $($_.Exception.Message)"
  }
}

function Get-PinnedSourceRevision([string]$RepositoryName) {
  if ($PinnedSourceRevisions.ContainsKey($RepositoryName)) {
    return [string]$PinnedSourceRevisions[$RepositoryName]
  }
  return ''
}

New-Item -ItemType Directory -Force -Path $SourceRoot, $SkillsRoot, $StateRoot, $ReportsRoot, $ArchivesRoot | Out-Null
$RepoUpdateLog = New-Object System.Collections.Generic.List[object]
$GitUpdateStarted = Get-Date
$SyncTimings = New-Object System.Collections.Generic.List[object]
$SyncStopwatch = [System.Diagnostics.Stopwatch]::StartNew()

function Add-SyncTiming([string]$Stage) {
  $SyncTimings.Add([PSCustomObject]@{
    Stage = $Stage
    Seconds = [Math]::Round($SyncStopwatch.Elapsed.TotalSeconds, 2)
  }) | Out-Null
}

function Test-GitUpdateBudget {
  if ($GitUpdateBudgetSeconds -le 0) { return $true }
  return (((Get-Date) - $GitUpdateStarted).TotalSeconds -lt $GitUpdateBudgetSeconds)
}

function Add-RepoUpdateLog([string]$Repository, [string]$Action, [string]$Status, [string]$Message) {
  $RepoUpdateLog.Add([PSCustomObject]@{
    Repository = $Repository
    Action = $Action
    Status = $Status
    Message = $Message
  }) | Out-Null
}

# AI SkillHub writes its own bookkeeping inside each source repository:
# .skillhub-source.json holds managed metadata, .skillhub-extracted holds the
# payload of any zip the source ships. Git reports both as untracked, so treating
# them as "local changes" permanently blocks auto-update on every source the app
# has ever touched -- the source silently stops tracking GitHub forever.
# Ignore only these self-authored artifacts. Every real edit still blocks the
# pull, so uncommitted user work is never overwritten.
$SelfAuthoredRepoArtifacts = @('.skillhub-source.json', '.skillhub-extracted')

function Test-PorcelainEntryIsSelfAuthored([string]$Line) {
  if ($Line.Length -lt 4) { return $false }
  # Only untracked entries qualify. A tracked file with the same name belongs to
  # the upstream repository, so a change to it must keep blocking the pull.
  if ($Line.Substring(0, 2) -ne '??') { return $false }
  $path = $Line.Substring(3).Trim()
  if ($path.Length -ge 2 -and $path.StartsWith('"') -and $path.EndsWith('"')) {
    $path = $path.Substring(1, $path.Length - 2)
  }
  $path = ($path -replace '\\', '/').TrimStart('/')
  foreach ($artifact in $SelfAuthoredRepoArtifacts) {
    if ($path -ieq $artifact -or $path -ieq "$artifact/") { return $true }
    if ($path.StartsWith("$artifact/", [StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $false
}

function Get-BlockingWorkingTreeChanges([string]$Porcelain) {
  if ([string]::IsNullOrWhiteSpace($Porcelain)) { return @() }
  return @(
    $Porcelain -split "`r?`n" |
      Where-Object { -not [string]::IsNullOrWhiteSpace($_) } |
      Where-Object { -not (Test-PorcelainEntryIsSelfAuthored $_) }
  )
}

Write-Host "SkillHub project: $ProjectRoot"
Write-Host "App package: $AppRoot"
Write-Host ''
Write-Host 'Updating configured repositories...'

$ConfigChanged = $false
foreach ($repo in $Config.repositories) {
  Assert-SafeRepoName ([string]$repo.name)
  $originalUrl = [string]$repo.url
  $normalizedUrl = Normalize-GitHubRepoUrl $originalUrl
  if ($normalizedUrl -ne $originalUrl) {
    $repo.url = $normalizedUrl
    $ConfigChanged = $true
  }
  if (-not (Test-GitHubRepoUrl ([string]$repo.url))) {
    throw "GitHub 地址格式不正确，请使用这种格式：https://github.com/作者/仓库.git。当前地址：$($repo.url)"
  }

  $target = Join-Path $SourceRoot ([string]$repo.name)
  if (-not (Test-UnderRoot $target $SourceRoot)) {
    throw "Repository target escaped source root: $target"
  }

  if ($ReportOnly) { continue }

  if (-not $GovernanceManifestReadable) {
    Add-RepoUpdateLog ([string]$repo.name) 'pull' 'governance-blocked' 'Source pin manifest is unreadable; network update skipped.'
    continue
  }

  $pinnedRevision = Get-PinnedSourceRevision ([string]$repo.name)
  if (-not [string]::IsNullOrWhiteSpace($pinnedRevision)) {
    $shortPin = $pinnedRevision.Substring(0, 8)
    if (Test-Path -LiteralPath (Join-Path $target '.git')) {
      Write-Host "Keeping pinned source $($repo.name) at $shortPin."
      Add-RepoUpdateLog ([string]$repo.name) 'pull' 'pinned' "Pinned revision $pinnedRevision; network update skipped."
    } else {
      Write-Warning "Pinned source $($repo.name) is missing locally; automatic clone is skipped so another revision is not substituted."
      Add-RepoUpdateLog ([string]$repo.name) 'clone' 'pinned-missing' "Pinned revision $pinnedRevision is not available locally."
    }
    continue
  }

  if (Test-Path -LiteralPath (Join-Path $target '.git')) {
    if (-not $NoPull) {
      $dirtyResult = Invoke-GitCommandWithTimeout @('-C', $target, 'status', '--porcelain', '--untracked-files=normal') ([string]$repo.name) 12
      if ($dirtyResult.ExitCode -ne 0) {
        Write-Warning "Cannot verify working tree safety for $($repo.name); update skipped."
        Add-RepoUpdateLog ([string]$repo.name) 'pull' 'safety-check-failed' $dirtyResult.Stderr
        continue
      }
      if (-not [string]::IsNullOrWhiteSpace($dirtyResult.Stdout)) {
        $blockingChanges = Get-BlockingWorkingTreeChanges $dirtyResult.Stdout
        if ($blockingChanges.Count -gt 0) {
          Write-Warning "$($repo.name) has local changes; update skipped so uncommitted files are preserved."
          Add-RepoUpdateLog ([string]$repo.name) 'pull' 'dirty-blocked' 'Local modified or untracked files detected; update skipped.'
          continue
        }
      }
      if (-not (Test-GitUpdateBudget)) {
        Write-Warning "Git update budget exhausted. Skipping $($repo.name)."
        Add-RepoUpdateLog ([string]$repo.name) 'pull' 'skipped' 'Git update budget exhausted.'
        continue
      }
      Write-Host "Pulling $($repo.name)..."
      $gitResult = Invoke-GitCommandWithTimeout @('-C', $target, 'pull', '--ff-only') ([string]$repo.name) $GitCommandTimeoutSeconds
      if ($gitResult.ExitCode -eq 0) {
        Add-RepoUpdateLog ([string]$repo.name) 'pull' 'ok' (($gitResult.Stdout + ' ' + $gitResult.Stderr).Trim())
      } elseif ($gitResult.TimedOut) {
        Write-Warning "git pull timed out for $($repo.name); continuing with local copy."
        Add-RepoUpdateLog ([string]$repo.name) 'pull' 'timeout' $gitResult.Stderr
      } else {
        Write-Warning "git pull failed for $($repo.name); continuing with local copy."
        Add-RepoUpdateLog ([string]$repo.name) 'pull' 'failed' (($gitResult.Stdout + ' ' + $gitResult.Stderr).Trim())
      }
    } else {
      Write-Host "Skipping pull for $($repo.name)."
      Add-RepoUpdateLog ([string]$repo.name) 'pull' 'skipped' 'NoPull enabled.'
    }
  } elseif (Test-Path -LiteralPath $target) {
    Write-Warning "$target exists but is not a Git repository. Skipping clone."
    Add-RepoUpdateLog ([string]$repo.name) 'clone' 'skipped' 'Target exists but is not a Git repository.'
  } else {
    if (-not (Test-GitUpdateBudget)) {
      Write-Warning "Git update budget exhausted. Skipping clone for $($repo.name)."
      Add-RepoUpdateLog ([string]$repo.name) 'clone' 'skipped' 'Git update budget exhausted.'
      continue
    }
    Write-Host "Cloning $($repo.name)..."
    $gitResult = Invoke-GitCommandWithTimeout @('clone', '--', ([string]$repo.url), $target) ([string]$repo.name) $GitCommandTimeoutSeconds
    if ($gitResult.ExitCode -eq 0) {
      Add-RepoUpdateLog ([string]$repo.name) 'clone' 'ok' (($gitResult.Stdout + ' ' + $gitResult.Stderr).Trim())
    } elseif ($gitResult.TimedOut) {
      Write-Warning "git clone timed out for $($repo.name); continuing."
      Add-RepoUpdateLog ([string]$repo.name) 'clone' 'timeout' $gitResult.Stderr
    } else {
      Write-Warning "git clone failed for $($repo.name); continuing."
      Add-RepoUpdateLog ([string]$repo.name) 'clone' 'failed' (($gitResult.Stdout + ' ' + $gitResult.Stderr).Trim())
    }
  }
}

if ($ConfigChanged -and -not $ReportOnly) {
  Write-JsonUtf8 $ConfigPath $Config 12
}

if ($Config.autoDiscoverManualRepos -and -not $ReportOnly -and -not $NoPull) {
  $manualRepos = Get-ChildItem -LiteralPath $SourceRoot -Force -Directory -ErrorAction SilentlyContinue |
    Where-Object { -not (Get-ConfiguredRepo $_.Name) -and (Test-Path -LiteralPath (Join-Path $_.FullName '.git')) }
  foreach ($manualRepo in $manualRepos) {
    if (-not $GovernanceManifestReadable) {
      Add-RepoUpdateLog $manualRepo.Name 'pull' 'governance-blocked' 'Source pin manifest is unreadable; network update skipped.'
      continue
    }
    $pinnedRevision = Get-PinnedSourceRevision $manualRepo.Name
    if (-not [string]::IsNullOrWhiteSpace($pinnedRevision)) {
      Write-Host "Keeping pinned manual source $($manualRepo.Name) at $($pinnedRevision.Substring(0, 8))."
      Add-RepoUpdateLog $manualRepo.Name 'pull' 'pinned' "Pinned revision $pinnedRevision; network update skipped."
      continue
    }
    if (-not (Test-GitUpdateBudget)) {
      Write-Warning "Git update budget exhausted. Skipping manual repository $($manualRepo.Name)."
      Add-RepoUpdateLog $manualRepo.Name 'pull' 'skipped' 'Git update budget exhausted.'
      continue
    }
    Write-Host "Pulling manual repository $($manualRepo.Name)..."
    $dirtyResult = Invoke-GitCommandWithTimeout @('-C', $manualRepo.FullName, 'status', '--porcelain', '--untracked-files=normal') $manualRepo.Name 12
    if ($dirtyResult.ExitCode -ne 0) {
      Write-Warning "Cannot verify working tree safety for manual repository $($manualRepo.Name); update skipped."
      Add-RepoUpdateLog $manualRepo.Name 'pull' 'safety-check-failed' $dirtyResult.Stderr
      continue
    }
    if (-not [string]::IsNullOrWhiteSpace($dirtyResult.Stdout)) {
      $blockingChanges = Get-BlockingWorkingTreeChanges $dirtyResult.Stdout
      if ($blockingChanges.Count -gt 0) {
        Write-Warning "$($manualRepo.Name) has local changes; update skipped so uncommitted files are preserved."
        Add-RepoUpdateLog $manualRepo.Name 'pull' 'dirty-blocked' 'Local modified or untracked files detected; update skipped.'
        continue
      }
    }
    $gitResult = Invoke-GitCommandWithTimeout @('-C', $manualRepo.FullName, 'pull', '--ff-only') $manualRepo.Name $GitCommandTimeoutSeconds
    if ($gitResult.ExitCode -eq 0) {
      Add-RepoUpdateLog $manualRepo.Name 'pull' 'ok' (($gitResult.Stdout + ' ' + $gitResult.Stderr).Trim())
    } elseif ($gitResult.TimedOut) {
      Write-Warning "git pull timed out for manual repository $($manualRepo.Name); continuing with local copy."
      Add-RepoUpdateLog $manualRepo.Name 'pull' 'timeout' $gitResult.Stderr
    } else {
      Write-Warning "git pull failed for manual repository $($manualRepo.Name); continuing with local copy."
      Add-RepoUpdateLog $manualRepo.Name 'pull' 'failed' (($gitResult.Stdout + ' ' + $gitResult.Stderr).Trim())
    }
  }
}

Add-SyncTiming 'repository updates'

Write-Host ''
Write-Host 'Discovering skills...'

$log = New-Object System.Collections.Generic.List[object]
$candidates = New-Object System.Collections.Generic.List[object]
$sourceRepos = @(Get-ChildItem -LiteralPath $SourceRoot -Force -Directory -ErrorAction SilentlyContinue)

foreach ($repoDir in $sourceRepos) {
  $repoScanStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  $repoPhaseStopwatch = [System.Diagnostics.Stopwatch]::StartNew()
  $repoConfig = Get-ConfiguredRepo $repoDir.Name
  if ($repoConfig -and $repoConfig.type -eq 'prompt') {
    $log.Add([PSCustomObject]@{ Kind = 'prompt'; Name = $repoDir.Name; Message = 'Prompt repository kept in github_sources only.' }) | Out-Null
    $repoScanStopwatch.Stop()
    if ($repoScanStopwatch.Elapsed.TotalSeconds -ge 2) {
      Add-SyncTiming "scan $($repoDir.Name)"
    }
    continue
  }

  if ($repoConfig -and $repoConfig.mode -eq 'explicit') {
    foreach ($skillPath in $repoConfig.skillPaths) {
      Add-Candidate $candidates (Join-Path $repoDir.FullName $skillPath) $repoDir.Name $true
    }
    $repoScanStopwatch.Stop()
    if ($repoScanStopwatch.Elapsed.TotalSeconds -ge 2) {
      Add-SyncTiming "scan $($repoDir.Name)"
    }
    continue
  }

  if ($repoConfig -or $Config.autoDiscoverManualRepos) {
    $nativeSkillFiles = Get-FilesByPatternFast $repoDir.FullName 'SKILL.md' -SkipExtracted
    if ($repoPhaseStopwatch.Elapsed.TotalSeconds -ge 2) {
      Add-SyncTiming "scan $($repoDir.Name) native"
      $repoPhaseStopwatch.Restart()
    }
    $expandedSkillFiles = New-Object System.Collections.Generic.List[object]
    if (@($nativeSkillFiles).Count -eq 0 -and -not $ReportOnly) {
      $expandedPackages = Expand-SkillZipPackages $repoDir.FullName
      if ($repoPhaseStopwatch.Elapsed.TotalSeconds -ge 2) {
        Add-SyncTiming "scan $($repoDir.Name) zip"
        $repoPhaseStopwatch.Restart()
      }
      foreach ($package in $expandedPackages) {
        $log.Add([PSCustomObject]@{
          Kind = 'skill-zip'
          Name = $repoDir.Name
          Message = "Expanded packaged skill zip: $($package.Zip)"
        }) | Out-Null
        foreach ($skillPath in @($package.SkillPaths)) {
          if (Test-Path -LiteralPath $skillPath) {
            $expandedSkillFiles.Add([System.IO.FileInfo]::new($skillPath)) | Out-Null
          }
        }
      }
    }

    $skillFiles = if (@($nativeSkillFiles).Count -gt 0) {
      $nativeSkillFiles
    } elseif ($expandedSkillFiles.Count -gt 0) {
      $expandedSkillFiles
    } else {
      $extractedRoot = Join-Path $repoDir.FullName '.skillhub-extracted'
      if (Test-Path -LiteralPath $extractedRoot -PathType Container) {
        Get-FilesByPatternFast $extractedRoot 'SKILL.md'
      } else {
        @()
      }
    }
    if ($repoPhaseStopwatch.Elapsed.TotalSeconds -ge 2) {
      Add-SyncTiming "scan $($repoDir.Name) collect"
      $repoPhaseStopwatch.Restart()
    }
    foreach ($skillFile in $skillFiles) {
      Add-Candidate $candidates (Split-Path -Parent $skillFile.FullName) $repoDir.Name $false
    }
    if ($repoPhaseStopwatch.Elapsed.TotalSeconds -ge 2) {
      Add-SyncTiming "scan $($repoDir.Name) candidates"
      $repoPhaseStopwatch.Restart()
    }
  }

  $repoScanStopwatch.Stop()
  if ($repoScanStopwatch.Elapsed.TotalSeconds -ge 2) {
    Add-SyncTiming "scan $($repoDir.Name)"
  }
}

foreach ($repoGroup in ($candidates | Group-Object Repo)) {
  Ensure-CollectionRouterSkill $candidates $repoGroup.Name @($repoGroup.Group)
}

$selected = New-Object System.Collections.Generic.List[object]
$routerSourcePrefix = (Convert-ToFullPath (Join-Path $SourceRoot 'AI-SkillHub-local-routers')).TrimEnd('\') + '\'

foreach ($group in ($candidates | Group-Object Skill)) {
  $ordered = @(
    $group.Group |
      Where-Object {
        ([string]$_.Repo) -ne 'AI-SkillHub-local-routers' -and
        (Convert-ToFullPath ([string]$_.Source)).StartsWith($routerSourcePrefix, [StringComparison]::OrdinalIgnoreCase)
      } |
      Sort-Object Priority, TieBreaker, Source
  )
  if ($ordered.Count -eq 0) { continue }
  # The managed shared catalog publishes one canonical parent per source.
  # Children remain in author repositories and are loaded by their parent via
  # exact source-scoped paths. Real user-owned folders in SkillsRoot are not
  # part of managed state and remain untouched.
  $selected.Add($ordered[0]) | Out-Null
}

Write-Host "Discovered $($candidates.Count) candidate skill folders."
Write-Host "Selected $($selected.Count) active GitHub/manual skills."
Add-SyncTiming 'skill discovery'

$previousManaged = @()
if (Test-Path -LiteralPath $StatePath) {
  # v3.1.10 and earlier could leave this file empty when no source was selected.
  # Treat an empty legacy state as an empty array, never as a fatal sync error.
  $previousRaw = [string](Get-Content -LiteralPath $StatePath -Raw -ErrorAction SilentlyContinue)
  if (-not [string]::IsNullOrWhiteSpace($previousRaw)) {
    try {
      $previousManaged = @($previousRaw | ConvertFrom-Json)
    } catch {
      # A truncated state file must not make repository updates or local content
      # disappear. Rebuild from current discovery and avoid stale-link deletion
      # based on unreadable historical data.
      Write-Warning "Managed link state is unreadable; current sources will be re-indexed without historical cleanup: $($_.Exception.Message)"
      $previousManaged = @()
    }
  }
}

$selectedByName = @{}
foreach ($item in $selected) { $selectedByName[$item.Skill] = $item }

$actions = New-Object System.Collections.Generic.List[object]

if (-not $ReportOnly) {
  Write-Host ''
  Write-Host 'Removing stale managed links...'

  foreach ($prev in $previousManaged) {
    $prevSkill = if ($prev.Skill -is [array]) { [string]$prev.Skill[0] } else { [string]$prev.Skill }
    $prevTarget = if ($prev.Target -is [array]) { [string]$prev.Target[0] } else { [string]$prev.Target }
    if ([string]::IsNullOrWhiteSpace($prevSkill)) { continue }
    if ($selectedByName.ContainsKey($prevSkill)) { continue }
    $dest = Join-Path $SkillsRoot $prevSkill
    if (Test-Path -LiteralPath $dest) {
      $item = Get-Item -LiteralPath $dest -Force
      if (Get-IsReparsePoint $item) {
        Remove-ManagedReparsePoint $dest $SkillsRoot $prevSkill 'Removed stale managed link' $prevTarget | Out-Null
      }
    }
  }

  Get-ChildItem -LiteralPath $SkillsRoot -Force -Directory -ErrorAction SilentlyContinue |
    Where-Object { Get-IsReparsePoint $_ } |
    ForEach-Object {
      $target = if ($_.Target -is [array]) { [string]$_.Target[0] } else { [string]$_.Target }
      $isUnderSources = $target -and ((Convert-ToFullPath $target).StartsWith((Convert-ToFullPath $SourceRoot), [System.StringComparison]::OrdinalIgnoreCase))
      $targetSkillMd = if ($target) { Join-Path $target 'SKILL.md' } else { '' }
      $isBrokenManagedLink = $isUnderSources -and (-not (Test-Path -LiteralPath $targetSkillMd -PathType Leaf))
      if ($isUnderSources -and (-not $selectedByName.ContainsKey($_.Name) -or $isBrokenManagedLink)) {
        $cleanupReason = if ($isBrokenManagedLink) { 'Removed broken managed source link' } else { 'Removed unselected GitHub-source link' }
        Remove-ManagedReparsePoint $_.FullName $SkillsRoot $_.Name $cleanupReason $target | Out-Null
      }
    }

  Write-Host ''
  Write-Host 'Refreshing active links...'

  foreach ($skill in ($selected | Sort-Object Skill)) {
    $dest = Join-Path $SkillsRoot $skill.Skill
    $src = $skill.Source
    $action = 'OK'

    if (-not (Test-Path -LiteralPath $src -PathType Container) -or
        -not (Test-Path -LiteralPath (Join-Path $src 'SKILL.md') -PathType Leaf)) {
      Write-Warning "Skipping invalid managed Skill target for $($skill.Skill): $src"
      $actions.Add([PSCustomObject]@{ Skill = $skill.Skill; Action = 'Skipped invalid target'; Target = $src }) | Out-Null
      continue
    }

    if (Test-Path -LiteralPath $dest) {
      $item = Get-Item -LiteralPath $dest -Force
      if (Get-IsReparsePoint $item) {
        $currentTarget = [string]$item.Target
        if ($currentTarget -ne $src) {
          if (Remove-ManagedReparsePoint $dest $SkillsRoot $skill.Skill 'Removed outdated link before relink' $currentTarget) {
            New-Item -ItemType Junction -Path $dest -Target $src | Out-Null
            $action = 'Relinked'
          } else {
            $action = 'Skipped relink'
          }
        }
      } else {
        New-Item -ItemType Directory -Force -Path $ArchiveRoot | Out-Null
        Move-Item -LiteralPath $dest -Destination (Join-Path $ArchiveRoot $skill.Skill)
        New-Item -ItemType Junction -Path $dest -Target $src | Out-Null
        $action = 'Archived old copy and linked'
      }
    } else {
      New-Item -ItemType Junction -Path $dest -Target $src | Out-Null
      $action = 'Linked'
    }

    $actions.Add([PSCustomObject]@{ Skill = $skill.Skill; Action = $action; Target = $src }) | Out-Null
  }

  $actionSummary = $actions | Group-Object Action | Sort-Object Name
  foreach ($group in $actionSummary) {
    Write-Host ("{0}: {1}" -f $group.Name, $group.Count)
  }

  $managedState = @($selected | Sort-Object Skill | ForEach-Object {
    [PSCustomObject]@{
      Skill = $_.Skill
      Repo = $_.Repo
      CategoryId = $_.CategoryId
      Note = $_.Note
      Description = $_.Description
      Target = $_.Source
    }
  })
  Write-JsonUtf8 $StatePath $managedState 5
  Add-SyncTiming 'active links'

  if ($Config.manageAgentLinks -and (Test-Path -LiteralPath $AgentLinkScript)) {
    Write-Host ''
    Write-Host 'Refreshing Claude Code / Codex / Antigravity skill links...'
    & $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File $AgentLinkScript -Quiet | Out-Null
  }
}

$repoRows = foreach ($repoDir in $sourceRepos) {
  $commit = Get-GitCommitShortFast $repoDir.FullName
  [PSCustomObject]@{ Name = $repoDir.Name; Commit = $commit; Path = $repoDir.FullName }
}
Add-SyncTiming 'repository commit scan'

$report = New-Object System.Collections.Generic.List[string]
$report.Add('# SkillHub 同步报告') | Out-Null
$report.Add('') | Out-Null
$report.Add("生成时间: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')") | Out-Null
$report.Add('') | Out-Null
$report.Add('## 同步阶段耗时') | Out-Null
$report.Add('') | Out-Null
$report.Add('| Stage | Seconds |') | Out-Null
$report.Add('|---|---:|') | Out-Null
foreach ($timing in $SyncTimings) {
  $report.Add("| $($timing.Stage) | $($timing.Seconds) |") | Out-Null
}
$report.Add('') | Out-Null
$report.Add('## 仓库更新状态') | Out-Null
$report.Add('') | Out-Null
$report.Add('| Repository | Action | Status | Message |') | Out-Null
$report.Add('|---|---|---|---|') | Out-Null
if ($RepoUpdateLog.Count -eq 0) {
  $report.Add('| - | - | skipped | NoPull / ReportOnly，未执行 Git 更新。 |') | Out-Null
} else {
  foreach ($item in ($RepoUpdateLog | Sort-Object Repository, Action)) {
    $message = ([string]$item.Message) -replace '\r?\n', ' '
    if ($message.Length -gt 180) { $message = $message.Substring(0, 180) + '…' }
    $report.Add("| $($item.Repository) | $($item.Action) | $($item.Status) | $message |") | Out-Null
  }
}
$report.Add('') | Out-Null
$report.Add('## 仓库来源') | Out-Null
$report.Add('') | Out-Null
$report.Add('| Repository | Commit | Path |') | Out-Null
$report.Add('|---|---:|---|') | Out-Null
foreach ($repo in ($repoRows | Sort-Object Name)) {
  $report.Add("| $($repo.Name) | $($repo.Commit) | $($repo.Path) |") | Out-Null
}
$report.Add('') | Out-Null
$report.Add('## 已启用 Skills') | Out-Null
$report.Add('') | Out-Null
$report.Add('| Skill | CategoryId | Repo | Note | Source |') | Out-Null
$report.Add('|---|---|---|---|---|') | Out-Null
foreach ($skill in ($selected | Sort-Object Skill)) {
  $report.Add("| $($skill.Skill) | $($skill.CategoryId) | $($skill.Repo) | $($skill.Note) | $($skill.Source) |") | Out-Null
}
$report.Add('') | Out-Null
$report.Add('## 仅作为 Prompt 来源保存') | Out-Null
$report.Add('') | Out-Null
$report.Add('| Repository | Note |') | Out-Null
$report.Add('|---|---|') | Out-Null
foreach ($repo in ($Config.repositories | Where-Object { $_.type -eq 'prompt' })) {
  $report.Add("| $($repo.name) | $($repo.note) |") | Out-Null
}

Write-Utf8Bom $ReportPath ($report -join [Environment]::NewLine)
$failedUpdates = @($RepoUpdateLog | Where-Object { $_.Status -in @('failed', 'timeout', 'governance-blocked', 'pinned-missing', 'safety-check-failed') })
$successfulUpdates = @($RepoUpdateLog | Where-Object { $_.Status -eq 'ok' })
$skippedUpdates = @($RepoUpdateLog | Where-Object { $_.Status -in @('skipped', 'pinned', 'dirty-blocked') })
$syncStatus = if ($RepoUpdateLog.Count -eq 0 -or $successfulUpdates.Count -eq 0) {
  if ($failedUpdates.Count -gt 0) { 'failed' } else { 'no-network-update' }
} elseif ($failedUpdates.Count -gt 0 -or $skippedUpdates.Count -gt 0) {
  'partial'
} else {
  'ok'
}
Write-JsonUtf8 $ReportJsonPath ([PSCustomObject]@{
  schemaVersion = 1
  generatedAt = (Get-Date).ToUniversalTime().ToString('o')
  status = $syncStatus
  total = $RepoUpdateLog.Count
  succeeded = $successfulUpdates.Count
  failed = $failedUpdates.Count
  skipped = $skippedUpdates.Count
  activeSkills = $selected.Count
  # Windows PowerShell 5.1 can throw "Argument types do not match" when a
  # generic List[object] is wrapped directly with @(...). Materialize a plain
  # object array before ConvertTo-Json so partial syncs still finish normally.
  repositories = @($RepoUpdateLog.ToArray())
}) 8
Add-SyncTiming 'report written'

Write-Host ''
Write-Host "Report: $ReportPath"
Write-Host "Managed state: $StatePath"
Write-Host ''
Write-Host "Active managed skills: $($selected.Count)"
Write-Host 'See the sync report for the full skill list.'
exit 0
