[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimeScript = Join-Path $workspaceRoot 'runtime\SkillHub.ps1'
$powerShellHost = (Get-Process -Id $PID).Path
$powerShellVersion = $PSVersionTable.PSVersion.ToString()
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

  # A source that ships the same `name:` at several paths. The neutral and
  # Claude files are exact packaging copies; Codex is a distinct variant.
  foreach ($location in @('src\skill', 'dist\claude\skills\paper-spine', 'dist\codex\skills\paper-spine')) {
    $sameName = Join-Path $sources (Join-Path 'PaperSpine' $location)
    New-Item -ItemType Directory -Force -Path $sameName | Out-Null
    $body = if ($location -like 'dist\codex*') { '# PaperSpine Codex variant' } else { '# PaperSpine' }
    [IO.File]::WriteAllText(
      (Join-Path $sameName 'SKILL.md'),
      "---`nname: paper-spine`ndescription: Review a paper end to end.`n---`n`n$body`n",
      [Text.UTF8Encoding]::new($false)
    )
  }

  $unicodeOnlyCollection = -join ([char]0x6280, [char]0x80FD)
  $unicodeMixedCollection = 'Lab.' + $unicodeOnlyCollection + '_Tool'
  $longCollection = (('A' * 70) -join '') + '.Tail'
  $canonicalNameFixtures = @(
    [PSCustomObject]@{ Collection = 'Mixed.Case_Name'; Expected = 'mixed-case-name-138ec712f901'; Child = 'mixed-case-child' },
    [PSCustomObject]@{ Collection = 'Space Name'; Expected = 'space-name-acd5492ddc47'; Child = 'space-name-child' },
    [PSCustomObject]@{ Collection = $unicodeMixedCollection; Expected = 'lab-tool-e211d5936626'; Child = 'unicode-mixed-child' },
    [PSCustomObject]@{ Collection = $unicodeOnlyCollection; Expected = 'skill-99aea2f9131a'; Child = 'unicode-only-child' },
    [PSCustomObject]@{ Collection = '___'; Expected = 'skill-bda251550bf0'; Child = 'empty-normalized-child' },
    [PSCustomObject]@{ Collection = $longCollection; Expected = ((('a' * 51) -join '') + '-6e12ecedb817'); Child = 'long-name-child' },
    [PSCustomObject]@{ Collection = 'a.b'; Expected = 'a-b-2e7336dc8eba'; Child = 'dot-collision-child' },
    [PSCustomObject]@{ Collection = 'a_b'; Expected = 'a-b-648fa9b31bc7'; Child = 'underscore-collision-child' }
  )
  foreach ($nameFixture in $canonicalNameFixtures) {
    $fixtureSkill = Join-Path (Join-Path $sources $nameFixture.Collection) $nameFixture.Child
    New-Item -ItemType Directory -Force -Path $fixtureSkill | Out-Null
    [IO.File]::WriteAllText(
      (Join-Path $fixtureSkill 'SKILL.md'),
      "---`nname: $($nameFixture.Child)`ndescription: Canonical parent name fixture.`n---`n`n# Fixture`n",
      [Text.UTF8Encoding]::new($false)
    )
  }

  $staleRouterTarget = Join-Path $fixture 'removed-router-target'
  $staleActiveEntry = Join-Path $active 'paperspine'
  New-Item -ItemType Directory -Force -Path $staleRouterTarget | Out-Null
  New-Item -ItemType Junction -Path $staleActiveEntry -Target $staleRouterTarget | Out-Null
  Remove-Item -LiteralPath $staleRouterTarget -Recurse -Force
  if (Test-Path -LiteralPath (Join-Path $staleActiveEntry 'SKILL.md') -PathType Leaf) {
    throw 'Broken active-link fixture unexpectedly exposes a SKILL.md.'
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
    & $powerShellHost -NoProfile -ExecutionPolicy Bypass -File $runtimeScript -NoPull
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


  foreach ($nameFixture in $canonicalNameFixtures) {
    $canonicalRouter = Join-Path $sources (Join-Path 'AI-SkillHub-local-routers' (Join-Path $nameFixture.Expected 'SKILL.md'))
    if (-not (Test-Path -LiteralPath $canonicalRouter -PathType Leaf)) {
      throw "Canonical parent router was not generated: $($nameFixture.Collection) -> $($nameFixture.Expected)"
    }
    if ($nameFixture.Expected.Length -gt 64 -or
        $nameFixture.Expected -cnotmatch '^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$') {
      throw "Test fixture itself violates the recipient-compatible name contract: $($nameFixture.Expected)"
    }
    $canonicalBody = [IO.File]::ReadAllText($canonicalRouter, [Text.UTF8Encoding]::new($false))
    $canonicalNameLine = @($canonicalBody -split "`r?`n" | Where-Object { $_ -like 'name:*' } | Select-Object -First 1)
    if ($canonicalNameLine.Count -ne 1 -or $canonicalNameLine[0].Trim() -cne ('name: ' + $nameFixture.Expected)) {
      throw "Canonical parent manifest name does not match its directory: $($nameFixture.Expected)"
    }
    if (-not (Test-Path -LiteralPath (Join-Path $active (Join-Path $nameFixture.Expected 'SKILL.md')) -PathType Leaf)) {
      throw "Canonical parent was not published to the active catalog: $($nameFixture.Expected)"
    }
  }
  if ($canonicalNameFixtures[-2].Expected -ceq $canonicalNameFixtures[-1].Expected) {
    throw 'Lossy parent normalization did not isolate dot/underscore collisions.'
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

  $spinePath = Join-Path $sources 'AI-SkillHub-local-routers\paperspine\SKILL.md'
  if (-not (Test-Path -LiteralPath $spinePath -PathType Leaf)) {
    throw 'Mixed-case source did not receive the canonical lower-case paperspine parent router.'
  }
  $routerFolderNames = @(Get-ChildItem -LiteralPath (Join-Path $sources 'AI-SkillHub-local-routers') -Directory -Force | ForEach-Object Name)
  if ($routerFolderNames -ccontains 'PaperSpine') {
    throw 'PowerShell emitted a mixed-case router name that disagrees with the Rust generator.'
  }
  $spine = [IO.File]::ReadAllText($spinePath, [Text.UTF8Encoding]::new($false))
  $spineChildren = Assert-DeclaredChildrenOpen $spine 'PaperSpine router' $sourceFileLabel
  if ($spineChildren -ne 2) {
    throw "Exact packaging copies must collapse while distinct variants remain; expected 2 declarations, got $spineChildren."
  }
  if (-not $spine.Contains('src/skill/SKILL.md')) { throw 'Neutral canonical copy is missing.' }
  if (-not $spine.Contains('dist/codex/skills/paper-spine/SKILL.md')) { throw 'Distinct Codex variant is missing.' }
  if ($spine.Contains('dist/claude/skills/paper-spine/SKILL.md')) { throw 'Byte-identical Claude packaging copy was not collapsed.' }
  $spineDescription = @($spine -split "`r?`n" | Where-Object { $_ -like 'description:*' } | Select-Object -First 1)
  if ($spineDescription.Count -ne 1 -or $spineDescription[0] -notmatch '1') {
    throw 'Parent child count must describe one capability, not two packaging variants.'
  }

  # The defect this scheme exists to prevent: a recipient opens the router
  # through a junction chain, never at its physical location. Reproduce that
  # chain and confirm each declared child is still reachable from it.
  $deliveryRoot = Join-Path $fixture 'agent-home\skills'
  New-Item -ItemType Directory -Force -Path $deliveryRoot | Out-Null
  $deliveredEntry = Join-Path $deliveryRoot 'paperspine'
  $activeEntry = Join-Path $active 'paperspine'
  if (-not (Test-Path -LiteralPath (Join-Path $activeEntry 'SKILL.md') -PathType Leaf)) {
    throw 'PowerShell did not replace the dangling active parent link.'
  }
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

  Write-Host "PASS: PowerShell $powerShellVersion generates and activates recipient-compatible parent names."
} finally {
  if (Test-Path -LiteralPath $fixture) {
    $resolved = [IO.Path]::GetFullPath($fixture)
    if (-not $resolved.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing cleanup outside TEMP: $resolved"
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}
