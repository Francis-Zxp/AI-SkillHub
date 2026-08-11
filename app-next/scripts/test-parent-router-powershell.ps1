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
  if ($parent -notmatch 'name: figures4papers') { throw 'Parent invocation name is missing.' }
  if ($parent -notmatch '\[ROUTER-HUB\]') { throw 'Parent marker is missing.' }
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
