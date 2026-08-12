[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$workspaceRoot = Split-Path -Parent $PSScriptRoot
$diagnosticsScript = Join-Path $workspaceRoot 'runtime\Export-SkillHubDiagnostics.ps1'
$sandboxRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("ai-skillhub-diagnostics-test-" + [guid]::NewGuid().ToString('N'))
$savedEnvironment = @{}
$environmentNames = @(
  'AI_SKILLHUB_ACTIVE_SKILLS',
  'AI_SKILLHUB_SOURCES',
  'AI_SKILLHUB_CONFIG_PATH',
  'AI_SKILLHUB_REPORTS',
  'AI_SKILLHUB_STATE'
)

function Assert-Equal([object]$Actual, [object]$Expected, [string]$Message) {
  if ($Actual -ne $Expected) {
    throw "$Message Expected '$Expected', got '$Actual'."
  }
}

try {
  $activeSkills = Join-Path $sandboxRoot 'skills'
  $sources = Join-Path $sandboxRoot 'sources'
  $reports = Join-Path $sandboxRoot 'reports'
  $state = Join-Path $sandboxRoot 'state'
  $configPath = Join-Path $sandboxRoot 'skillhub.config.json'
  $validSkill = Join-Path $activeSkills 'valid-parent'
  $brokenEntry = Join-Path $activeSkills 'broken-parent'

  @($validSkill, $brokenEntry, $reports, $state) |
    ForEach-Object { New-Item -ItemType Directory -Force -Path $_ | Out-Null }
  @('source-one', 'source-two', 'source-three', 'AI-SkillHub-local-routers') |
    ForEach-Object { New-Item -ItemType Directory -Force -Path (Join-Path $sources $_) | Out-Null }

  [System.IO.File]::WriteAllText(
    (Join-Path $sources 'source-three\.skillhub-source.json'),
    '{"sourceType":"prompt","url":"https://github.com/example/prompt.git"}',
    [System.Text.UTF8Encoding]::new($false)
  )

  [System.IO.File]::WriteAllText(
    (Join-Path $validSkill 'SKILL.md'),
    "---`nname: valid-parent`ndescription: valid parent`n---`n",
    [System.Text.UTF8Encoding]::new($false)
  )
  [System.IO.File]::WriteAllText(
    $configPath,
    '{"version":3,"repositories":[]}',
    [System.Text.UTF8Encoding]::new($false)
  )

  foreach ($name in $environmentNames) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
  }
  $env:AI_SKILLHUB_ACTIVE_SKILLS = $activeSkills
  $env:AI_SKILLHUB_SOURCES = $sources
  $env:AI_SKILLHUB_CONFIG_PATH = $configPath
  $env:AI_SKILLHUB_REPORTS = $reports
  $env:AI_SKILLHUB_STATE = $state

  & $diagnosticsScript -Quiet
  $payload = Get-Content -LiteralPath (Join-Path $reports 'latest-diagnostics.json') -Raw -Encoding UTF8 | ConvertFrom-Json

  Assert-Equal ([int]$payload.summary.repositories) 3 'Internal router storage must not inflate source totals.'
  Assert-Equal ([int]$payload.summary.prompts) 1 'Prompt sources indexed outside the legacy config must remain visible.'
  Assert-Equal ([int]$payload.summary.skills) 1 'Entries without SKILL.md must not be reported as callable Skills.'
  Assert-Equal (@($payload.invalidSkillEntries).Count) 1 'Broken parent entries must remain visible as diagnostics.'
  Assert-Equal ([string]$payload.invalidSkillEntries[0].folder) 'broken-parent' 'The invalid entry should be named without being promoted.'

  Write-Output 'Diagnostics index integrity test passed.'
} finally {
  foreach ($name in $environmentNames) {
    [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
  }

  $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  $resolvedSandbox = [System.IO.Path]::GetFullPath($sandboxRoot)
  if ($resolvedSandbox.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase) -and
      $resolvedSandbox -ne $tempRoot.TrimEnd('\') -and
      (Test-Path -LiteralPath $resolvedSandbox)) {
    Remove-Item -LiteralPath $resolvedSandbox -Recurse -Force
  }
}
