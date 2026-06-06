param(
  [switch]$NoPull,
  [switch]$ReportOnly
)

$ErrorActionPreference = 'Stop'
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $Utf8NoBom
$OutputEncoding = $Utf8NoBom

$AppRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $AppRoot
$ConfigPath = Join-Path $AppRoot 'skillhub.config.json'
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
  [System.IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($true))
}

function Write-Utf8NoBom([string]$Path, [string]$Text) {
  $parent = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  [System.IO.File]::WriteAllText($Path, $Text, [System.Text.UTF8Encoding]::new($false))
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
  Write-Utf8Bom $Path ($Object | ConvertTo-Json -Depth $Depth)
}

function New-DefaultSkillHubConfig {
  [PSCustomObject]@{
    version = 2
    githubSourcesFolder = '..\data\github_sources'
    activeSkillsFolder = '..\..\skills'
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
    $RepoCandidates | Where-Object {
      (Normalize-SkillLookupName ([string]$_.Skill)) -ne $repoKey
    } | Sort-Object Skill -Unique
  )
  if ($childSkills.Count -lt 2) { return }

  $safeRouterName = Get-SafeSkillName $RepoName $RepoName
  $routerRoot = Join-Path $SourceRoot 'AI-SkillHub-local-routers'
  $routerFolder = Join-Path $routerRoot $safeRouterName
  if (-not (Test-UnderRoot $routerFolder $SourceRoot)) {
    throw "Router target escaped source root: $routerFolder"
  }

  $childLines = @($childSkills | Sort-Object Skill | Select-Object -ExpandProperty Skill | ForEach-Object { "- [CHILD-SKILL] /$_" })
  $originalParentSection = @()
  if ($parentCandidate.Count -gt 0) {
    $parentSkillMd = Join-Path ([string]$parentCandidate[0].Source) 'SKILL.md'
    $parentBody = Read-Utf8Text $parentSkillMd
    if (-not [string]::IsNullOrWhiteSpace($parentBody)) {
      $parentBody = [regex]::Replace($parentBody, '(?s)\A---\s*.*?---\s*', '').Trim()
      if ($parentBody.Length -gt 16000) {
        $parentBody = $parentBody.Substring(0, 16000) + [Environment]::NewLine + '[TRUNCATED: original parent Skill content is longer than 16000 characters.]'
      }
      $relativeParent = Convert-ToRelativePath -Root $SourceRoot -Path $parentSkillMd
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
    "description: `"[ROUTER-HUB] AI SkillHub generated parent router for the local $RepoName skill collection. Use this when the user names the collection but does not know which focused child skill to choose.`""
    '---'
    ''
    "# [ROUTER-HUB] $RepoName"
    ''
    "> [ROUTER-HUB] This is an AI SkillHub generated parent Skill. It is a collection entry, not a focused child Skill."
    ''
    "This parent router is generated outside the author's repository, so git pull updates will not overwrite the router marker or routing rules."
    ''
    'Use this parent Skill when the user names the whole collection, asks which child Skill to use, or gives a broad task that may belong to this collection.'
    ''
    'Marker standard:'
    '- [ROUTER-HUB] = parent collection entry generated by AI SkillHub.'
    '- [CHILD-SKILL] = focused child Skill from the source repository.'
    ''
    'Rules:'
    '- If the user clearly names a specific child Skill, use that child directly.'
    '- If the user names only this collection, choose the smallest child Skill that fits the task.'
    '- If the right child is unclear, explain the top 2-3 choices briefly and ask only when the task cannot be safely routed.'
    ''
    'Available child Skills:'
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

  $zipFiles = Get-ChildItem -LiteralPath $RepoPath -Recurse -Force -Filter '*.zip' -ErrorAction SilentlyContinue |
    Where-Object {
      $_.FullName -notmatch '\\\.git\\' -and
      $_.FullName -notmatch '\\\.skillhub-extracted\\'
    }

  $expanded = New-Object System.Collections.Generic.List[object]
  if (@($zipFiles).Count -eq 0) { return $expanded }

  Add-Type -AssemblyName System.IO.Compression.FileSystem

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
      }) | Out-Null
    } catch {
      Write-Warning "Skill zip extraction failed for $($zipFile.FullName): $($_.Exception.Message)"
    } finally {
      if ($archive) { $archive.Dispose() }
    }
  }

  return $expanded
}

$Config = Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
$SourceRoot = Resolve-AppPath $Config.githubSourcesFolder
$SkillsRoot = Resolve-AppPath $Config.activeSkillsFolder
$StateRoot = Join-Path (Split-Path -Parent $AppRoot) '.skillhub-next\sync-state'
$ReportsRoot = Join-Path (Split-Path -Parent $AppRoot) 'reports'
$ArchivesRoot = Join-Path (Split-Path -Parent $AppRoot) '.skillhub-next\archives'
$Stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$ArchiveRoot = Join-Path $ArchivesRoot "replaced_active_skill_copies_$Stamp"
$StatePath = Join-Path $StateRoot 'managed-links.json'
$ReportPath = Join-Path $ReportsRoot 'last-sync.md'
$AgentLinkScript = Join-Path $AppRoot 'Manage-AgentSkillLinks.ps1'

New-Item -ItemType Directory -Force -Path $SourceRoot, $SkillsRoot, $StateRoot, $ReportsRoot, $ArchivesRoot | Out-Null

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

  if (Test-Path -LiteralPath (Join-Path $target '.git')) {
    if (-not $NoPull) {
      Write-Host "Pulling $($repo.name)..."
      & git -C $target pull --ff-only
      if ($LASTEXITCODE -ne 0) { throw "git pull failed for $($repo.name)" }
    } else {
      Write-Host "Skipping pull for $($repo.name)."
    }
  } elseif (Test-Path -LiteralPath $target) {
    Write-Warning "$target exists but is not a Git repository. Skipping clone."
  } else {
    Write-Host "Cloning $($repo.name)..."
    & git clone -- ([string]$repo.url) $target
    if ($LASTEXITCODE -ne 0) { throw "git clone failed for $($repo.name)" }
  }
}

if ($ConfigChanged -and -not $ReportOnly) {
  Write-JsonUtf8 $ConfigPath $Config 12
}

if ($Config.autoDiscoverManualRepos -and -not $ReportOnly -and -not $NoPull) {
  Get-ChildItem -LiteralPath $SourceRoot -Force -Directory -ErrorAction SilentlyContinue |
    Where-Object { -not (Get-ConfiguredRepo $_.Name) -and (Test-Path -LiteralPath (Join-Path $_.FullName '.git')) } |
    ForEach-Object {
      Write-Host "Pulling manual repository $($_.Name)..."
      & git -C $_.FullName pull --ff-only
      if ($LASTEXITCODE -ne 0) { Write-Warning "git pull failed for manual repository $($_.Name)" }
    }
}

Write-Host ''
Write-Host 'Discovering skills...'

$log = New-Object System.Collections.Generic.List[object]
$candidates = New-Object System.Collections.Generic.List[object]
$sourceRepos = Get-ChildItem -LiteralPath $SourceRoot -Force -Directory -ErrorAction SilentlyContinue

foreach ($repoDir in $sourceRepos) {
  $repoConfig = Get-ConfiguredRepo $repoDir.Name
  if ($repoConfig -and $repoConfig.type -eq 'prompt') {
    $log.Add([PSCustomObject]@{ Kind = 'prompt'; Name = $repoDir.Name; Message = 'Prompt repository kept in github_sources only.' }) | Out-Null
    continue
  }

  if ($repoConfig -and $repoConfig.mode -eq 'explicit') {
    foreach ($skillPath in $repoConfig.skillPaths) {
      Add-Candidate $candidates (Join-Path $repoDir.FullName $skillPath) $repoDir.Name $true
    }
    continue
  }

  if ($repoConfig -or $Config.autoDiscoverManualRepos) {
    if (-not $ReportOnly) {
      $expandedPackages = Expand-SkillZipPackages $repoDir.FullName
      foreach ($package in $expandedPackages) {
        $log.Add([PSCustomObject]@{
          Kind = 'skill-zip'
          Name = $repoDir.Name
          Message = "Expanded packaged skill zip: $($package.Zip)"
        }) | Out-Null
      }
    }

    $skillFiles = Get-ChildItem -LiteralPath $repoDir.FullName -Recurse -Force -Filter 'SKILL.md' -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -notmatch '\\\.git\\' }
    foreach ($skillFile in $skillFiles) {
      Add-Candidate $candidates (Split-Path -Parent $skillFile.FullName) $repoDir.Name $false
    }
  }
}

foreach ($repoGroup in ($candidates | Group-Object Repo)) {
  Ensure-CollectionRouterSkill $candidates $repoGroup.Name @($repoGroup.Group)
}

$selected = New-Object System.Collections.Generic.List[object]
$conflicts = New-Object System.Collections.Generic.List[object]

foreach ($group in ($candidates | Group-Object Skill)) {
  $ordered = @($group.Group | Sort-Object Priority, TieBreaker, Source)
  $bestPriority = $ordered[0].Priority
  $bestTieBreaker = $ordered[0].TieBreaker
  $best = @($ordered | Where-Object { $_.Priority -eq $bestPriority -and $_.TieBreaker -eq $bestTieBreaker })
  if ($best.Count -eq 1) {
    $selected.Add($best[0]) | Out-Null
  } else {
    $conflicts.Add([PSCustomObject]@{
      Skill = $group.Name
      Message = 'Multiple equally preferred sources found. Add an explicit skillPaths rule.'
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
if (Test-Path -LiteralPath $StatePath) {
  $previousRaw = Get-Content -LiteralPath $StatePath -Raw
  if ($previousRaw.Trim()) { $previousManaged = @($previousRaw | ConvertFrom-Json) }
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
      $target = [string]$_.Target
      $isUnderSources = $target -and ((Convert-ToFullPath $target).StartsWith((Convert-ToFullPath $SourceRoot), [System.StringComparison]::OrdinalIgnoreCase))
      if ($isUnderSources -and -not $selectedByName.ContainsKey($_.Name)) {
        Remove-ManagedReparsePoint $_.FullName $SkillsRoot $_.Name 'Removed unselected GitHub-source link' $target | Out-Null
      }
    }

  Write-Host ''
  Write-Host 'Refreshing active links...'

  foreach ($skill in ($selected | Sort-Object Skill)) {
    $dest = Join-Path $SkillsRoot $skill.Skill
    $src = $skill.Source
    $action = 'OK'

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
    Write-Host "$action`: $($skill.Skill)"
  }

  $managedState = $selected | Sort-Object Skill | ForEach-Object {
    [PSCustomObject]@{
      Skill = $_.Skill
      Repo = $_.Repo
      CategoryId = $_.CategoryId
      Note = $_.Note
      Description = $_.Description
      Target = $_.Source
    }
  }
  Write-JsonUtf8 $StatePath $managedState 5

  if ($Config.manageAgentLinks -and (Test-Path -LiteralPath $AgentLinkScript)) {
    Write-Host ''
    Write-Host 'Refreshing Claude Code / Codex / Antigravity skill links...'
    & $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File $AgentLinkScript -Quiet | Out-Null
  }
}

$repoRows = foreach ($repoDir in $sourceRepos) {
  $commit = ''
  if (Test-Path -LiteralPath (Join-Path $repoDir.FullName '.git')) {
    try {
      $commit = (& git -C $repoDir.FullName rev-parse --short HEAD 2>$null)
      if ($LASTEXITCODE -ne 0) { $commit = '' }
    } catch {
      $commit = ''
    }
  }
  [PSCustomObject]@{ Name = $repoDir.Name; Commit = $commit; Path = $repoDir.FullName }
}

$report = New-Object System.Collections.Generic.List[string]
$report.Add('# SkillHub 同步报告') | Out-Null
$report.Add('') | Out-Null
$report.Add("生成时间: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')") | Out-Null
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
if ($conflicts.Count -gt 0) {
  $report.Add('') | Out-Null
  $report.Add('## 需要人工处理的冲突') | Out-Null
  $report.Add('') | Out-Null
  $report.Add('| Skill | Message | Sources |') | Out-Null
  $report.Add('|---|---|---|') | Out-Null
  foreach ($conflict in $conflicts) {
    $report.Add("| $($conflict.Skill) | $($conflict.Message) | $($conflict.Sources) |") | Out-Null
  }
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

Write-Host ''
Write-Host "Report: $ReportPath"
Write-Host "Managed state: $StatePath"
Write-Host ''
Write-Host 'Active managed skills:'
$selected | Sort-Object Skill | Select-Object -ExpandProperty Skill


