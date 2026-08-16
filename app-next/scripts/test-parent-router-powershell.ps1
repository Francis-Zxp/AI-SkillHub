[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimeScript = Join-Path $workspaceRoot 'runtime\SkillHub.ps1'
$windowsPowerShell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$tempBase = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
$fixture = Join-Path $env:TEMP ('skillhub-parent-router-test-' + [guid]::NewGuid().ToString('N'))
$fixture = [IO.Path]::GetFullPath($fixture)
if (-not $fixture.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing fixture outside TEMP: $fixture"
}

try {
  $sources = Join-Path $fixture 'sources'
  $active = Join-Path $fixture 'active'
  $state = Join-Path $fixture 'state'
  $reports = Join-Path $fixture 'reports'
  $singleSkill = Join-Path $sources 'figures4papers\scientific-figure-making'
  New-Item -ItemType Directory -Force -Path $singleSkill, $active, $state, $reports | Out-Null
  [IO.File]::WriteAllText(
    (Join-Path $singleSkill 'SKILL.md'),
    "---`nname: scientific-figure-making`ndescription: Scientific figure generation and editing.`n---`n`n# Figure workflow`n",
    [Text.UTF8Encoding]::new($false)
  )

  # A source that ships the same `name:` at several paths. None of them may be
  # dropped, because each is a real installed Skill a user can ask for.
  foreach ($location in @('src\skill', 'dist\claude\skills\paper-spine', 'dist\codex\skills\paper-spine')) {
    $sameName = Join-Path $sources (Join-Path 'PaperSpine' $location)
    New-Item -ItemType Directory -Force -Path $sameName | Out-Null
    [IO.File]::WriteAllText(
      (Join-Path $sameName 'SKILL.md'),
      "---`nname: paper-spine`ndescription: Review a paper end to end.`n---`n`n# PaperSpine`n",
      [Text.UTF8Encoding]::new($false)
    )
  }

  $configPath = Join-Path $fixture 'skillhub.config.json'
  $config = [ordered]@{
    version = 3
    githubSourcesFolder = $sources
    activeSkillsFolder = $active
    manageAgentLinks = $false
    autoDiscoverManualRepos = $true
    preferredPathFragments = @('\skills\', '\.agents\skills\')
    repositories = @()
  }
  [IO.File]::WriteAllText($configPath, ($config | ConvertTo-Json -Depth 8), [Text.UTF8Encoding]::new($true))

  $previousConfig = $env:AI_SKILLHUB_CONFIG_PATH
  $previousState = $env:AI_SKILLHUB_STATE
  $previousReports = $env:AI_SKILLHUB_REPORTS
  $env:AI_SKILLHUB_CONFIG_PATH = $configPath
  $env:AI_SKILLHUB_STATE = $state
  $env:AI_SKILLHUB_REPORTS = $reports
  try {
    & $windowsPowerShell -NoProfile -ExecutionPolicy Bypass -File $runtimeScript -NoPull
    if ($LASTEXITCODE -ne 0) { throw "SkillHub.ps1 exited with $LASTEXITCODE" }
  } finally {
    $env:AI_SKILLHUB_CONFIG_PATH = $previousConfig
    $env:AI_SKILLHUB_STATE = $previousState
    $env:AI_SKILLHUB_REPORTS = $previousReports
  }

  $parentPath = Join-Path $sources 'AI-SkillHub-local-routers\figures4papers\SKILL.md'
  if (-not (Test-Path -LiteralPath $parentPath -PathType Leaf)) {
    throw 'Single-child source did not receive a figures4papers parent router.'
  }
  $parent = [IO.File]::ReadAllText($parentPath, [Text.UTF8Encoding]::new($false))
  $visibleParentMarker = [string][char]0x25C8
  $descriptionLine = @($parent -split "`r?`n" | Where-Object { $_ -like 'description:*' } | Select-Object -First 1)
  if ($parent -notmatch 'name: figures4papers') { throw 'Parent invocation name is missing.' }
  if ($parent -notmatch '\[ROUTER-HUB\]') { throw 'Parent marker is missing.' }
  if ($descriptionLine.Count -ne 1 -or -not $descriptionLine[0].StartsWith('description: "' + $visibleParentMarker)) { throw 'Compact parent summary is missing.' }
  if ($descriptionLine[0] -notmatch '1') { throw 'Compact parent child count is missing.' }
  if ($parent -notmatch ('# ' + [regex]::Escape($visibleParentMarker))) { throw 'Visible parent marker is missing.' }
  if ($parent -notmatch '\[CHILD-SKILL\].*scientific-figure-making') { throw 'Child capability is not grouped under parent.' }
  if ($parent -match 'description: "\[ROUTER-HUB\]') { throw 'Machine marker leaked into the visible description.' }
  if ($parent -notmatch '<!-- \[ROUTER-HUB\] -->') { throw 'Hidden machine marker is missing.' }
  if ($parent -notmatch 'figures4papers/scientific-figure-making/SKILL\.md') { throw 'Source-scoped child path is missing.' }
  if (-not (Test-Path -LiteralPath (Join-Path $active 'figures4papers\SKILL.md'))) {
    throw 'Canonical parent was not linked into the active catalog.'
  }
  if (Test-Path -LiteralPath (Join-Path $active 'scientific-figure-making')) {
    throw 'Child Skill leaked into the parent-first active catalog.'
  }

  # This file has no UTF-8 BOM, so Windows PowerShell 5.1 reads it as ANSI.
  # Build every non-ASCII literal from code points, the same way the visible
  # parent marker below is built, so the parser never sees mojibake.
  $sourceFileLabel = -join ([char]0x6765, [char]0x6E90, [char]0x6587, [char]0x4EF6, [char]0xFF1A)
  $openParen = [string][char]0xFF08
  $closeParen = [string][char]0xFF09

  # Read every declared child path the way a recipient Agent does: take the
  # string between the backticks and use it verbatim, with no relative-path
  # arithmetic and no knowledge of where the router file lives.
  function Get-DeclaredChildPath([string]$RouterBody, [string]$Label) {
    return @(
      [regex]::Matches($RouterBody, ('\[CHILD-SKILL\][^\r\n]*?' + [regex]::Escape($Label) + '`([^`]+)`')) |
        ForEach-Object { $_.Groups[1].Value }
    )
  }

  function Assert-DeclaredChildrenOpen([string]$RouterBody, [string]$Context, [string]$Label) {
    $declared = Get-DeclaredChildPath $RouterBody $Label
    if ($declared.Count -eq 0) { throw "$Context declared no children." }
    foreach ($path in $declared) {
      if (-not [IO.Path]::IsPathRooted($path)) {
        throw "$Context child path is not absolute and cannot survive the delivery junction chain: $path"
      }
      if ($path -match '\.\.') { throw "$Context child path contains a relative segment: $path" }
      if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
        throw "$Context declared child path did not open: $path"
      }
    }
    return $declared.Count
  }

  Assert-DeclaredChildrenOpen $parent 'figures4papers router' $sourceFileLabel | Out-Null

  $spinePath = Join-Path $sources 'AI-SkillHub-local-routers\PaperSpine\SKILL.md'
  if (-not (Test-Path -LiteralPath $spinePath -PathType Leaf)) {
    throw 'Same-name source did not receive a PaperSpine parent router.'
  }
  $spine = [IO.File]::ReadAllText($spinePath, [Text.UTF8Encoding]::new($false))
  $spineChildren = Assert-DeclaredChildrenOpen $spine 'PaperSpine router' $sourceFileLabel
  if ($spineChildren -ne 3) {
    throw "Same-name children must never be dropped; expected 3 declared children, got $spineChildren."
  }
  foreach ($location in @('src/skill', 'dist/claude/skills/paper-spine', 'dist/codex/skills/paper-spine')) {
    $marker = $openParen + $location + $closeParen
    if (-not $spine.Contains($marker)) {
      throw "Same-name child is not disambiguated by its in-source location: $location"
    }
  }

  # The defect this scheme exists to prevent: a recipient opens the router
  # through a junction chain, never at its physical location. Reproduce that
  # chain and confirm each declared child is still reachable from it.
  $deliveryRoot = Join-Path $fixture 'agent-home\skills'
  New-Item -ItemType Directory -Force -Path $deliveryRoot | Out-Null
  $deliveredEntry = Join-Path $deliveryRoot 'PaperSpine'
  $activeEntry = Join-Path $active 'PaperSpine'
  if (Test-Path -LiteralPath $activeEntry) {
    cmd /C mklink /J "$deliveredEntry" "$activeEntry" | Out-Null
    if ($LASTEXITCODE -eq 0) {
      $delivered = [IO.File]::ReadAllText((Join-Path $deliveredEntry 'SKILL.md'), [Text.UTF8Encoding]::new($false))
      Assert-DeclaredChildrenOpen $delivered 'delivered PaperSpine router' $sourceFileLabel | Out-Null
      foreach ($path in (Get-DeclaredChildPath $delivered $sourceFileLabel)) {
        # Resolve the way a host actually does it: join the declared path onto
        # the delivered entry. Path.Combine matches Rust's Path::join and Node's
        # path.resolve -- an absolute path wins and is returned unchanged, while
        # a '../..' path would be walked out of the published Skill directory.
        $resolved = [IO.Path]::GetFullPath([IO.Path]::Combine($deliveredEntry, $path))
        if (-not (Test-Path -LiteralPath $resolved)) {
          throw "Child unreachable from the delivered agent entry: $path"
        }
      }
      Write-Host 'PASS: declared children open through the agent delivery junction chain.'
    } else {
      Write-Warning 'Junction creation unavailable; delivery-chain assertion skipped.'
    }
  }

  Write-Host 'PASS: Windows PowerShell generates and activates a single-child figures4papers parent.'
} finally {
  if (Test-Path -LiteralPath $fixture) {
    $resolved = [IO.Path]::GetFullPath($fixture)
    if (-not $resolved.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing cleanup outside TEMP: $resolved"
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}
