param()

$ErrorActionPreference = 'Stop'
$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('ai-skillhub-codex-delivery-' + [Guid]::NewGuid().ToString('N'))
$resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
if (-not $resolvedTestRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to create delivery test outside TEMP: $resolvedTestRoot"
}
$windowsPowerShellVersion = (& powershell.exe -NoProfile -Command '$PSVersionTable.PSVersion.ToString()').Trim()
if (-not $windowsPowerShellVersion.StartsWith('5.1', [StringComparison]::Ordinal)) {
  throw "This regression test requires Windows PowerShell 5.1; found $windowsPowerShellVersion."
}

try {
  $homePath = Join-Path $resolvedTestRoot 'recipient-home'
  $activeSkills = Join-Path $resolvedTestRoot 'active-skills'
  $demoSkill = Join-Path $activeSkills 'demo-skill'
  New-Item -ItemType Directory -Force -Path $demoSkill | Out-Null
  Set-Content -LiteralPath (Join-Path $demoSkill 'SKILL.md') -Encoding utf8 -Value @'
---
name: demo-skill
description: Delivery verification fixture.
---

# Demo
'@
  $secondSkill = Join-Path $activeSkills 'second-skill'
  New-Item -ItemType Directory -Force -Path $secondSkill | Out-Null
  Set-Content -LiteralPath (Join-Path $secondSkill 'SKILL.md') -Encoding utf8 -Value @'
---
name: second-skill
description: Second allowlist fixture for Windows PowerShell 5.1 array parsing.
---

# Second
'@
  $disabledSkill = Join-Path $activeSkills 'disabled-skill'
  New-Item -ItemType Directory -Force -Path $disabledSkill | Out-Null
  Set-Content -LiteralPath (Join-Path $disabledSkill 'SKILL.md') -Encoding utf8 -Value @'
---
name: disabled-skill
description: Must not be delivered when absent from the allowlist.
---
'@
  $invalidSkill = Join-Path $activeSkills 'invalid-skill'
  New-Item -ItemType Directory -Force -Path $invalidSkill | Out-Null
  Set-Content -LiteralPath (Join-Path $invalidSkill 'SKILL.md') -Encoding utf8 -Value @'
# Missing required YAML name and description.
'@

  $configPath = Join-Path $resolvedTestRoot 'skillhub.config.json'
  [PSCustomObject]@{
    version = 3
    githubSourcesFolder = (Join-Path $resolvedTestRoot 'sources')
    activeSkillsFolder = $activeSkills
    manageAgentLinks = $true
    autoDiscoverManualRepos = $false
    repositories = @()
  } | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $configPath -Encoding utf8

  $previousConfig = $env:AI_SKILLHUB_CONFIG_PATH
  $previousAllowlist = $env:AI_SKILLHUB_AGENT_SKILL_ALLOWLIST
  $env:AI_SKILLHUB_CONFIG_PATH = $configPath
  $scriptPath = Join-Path $PSScriptRoot '..\runtime\Manage-AgentSkillLinks.ps1'

  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scriptPath `
    -Quiet -HomePath $homePath -SimulateOpenAIDesktopPresent
  if ($LASTEXITCODE -ne 0) { throw "Desktop-only delivery process failed with exit code $LASTEXITCODE" }

  $officialSkill = Join-Path $homePath '.agents\skills\demo-skill\SKILL.md'
  if (-not (Test-Path -LiteralPath $officialSkill -PathType Leaf)) {
    throw "Official user-scope Skill was not delivered: $officialSkill"
  }
  if (Test-Path -LiteralPath (Join-Path $homePath '.codex')) {
    throw 'Clean recipient test unexpectedly created a legacy .codex directory.'
  }
  if (Test-Path -LiteralPath (Join-Path $homePath '.agents\skills\invalid-skill')) {
    throw 'Invalid SKILL.md was published to the recipient.'
  }

  $allowlistPath = Join-Path $resolvedTestRoot 'agent-skill-allowlist.json'
  Set-Content -LiteralPath $allowlistPath -Encoding utf8 -Value @'
[
  "demo-skill",
  "second-skill"
]
'@
  $env:AI_SKILLHUB_AGENT_SKILL_ALLOWLIST = $allowlistPath
  $allowlistedHome = Join-Path $resolvedTestRoot 'allowlisted-home'
  $oldClaudeRoot = Join-Path $allowlistedHome '.claude\skills'
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $oldClaudeRoot) | Out-Null
  New-Item -ItemType Junction -Path $oldClaudeRoot -Target $activeSkills | Out-Null
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scriptPath `
    -Quiet -HomePath $allowlistedHome -SimulateOpenAIDesktopPresent -SimulateClaudePresent
  if ($LASTEXITCODE -ne 0) { throw "Allowlisted delivery failed with exit code $LASTEXITCODE" }
  if (-not (Test-Path -LiteralPath (Join-Path $allowlistedHome '.agents\skills\demo-skill\SKILL.md') -PathType Leaf)) {
    throw 'Enabled Skill was not delivered from the allowlist.'
  }
  if (-not (Test-Path -LiteralPath (Join-Path $allowlistedHome '.agents\skills\second-skill\SKILL.md') -PathType Leaf)) {
    throw 'Windows PowerShell 5.1 treated the multi-item allowlist as one Object[] instead of delivering its second Skill.'
  }
  if (Test-Path -LiteralPath (Join-Path $allowlistedHome '.agents\skills\disabled-skill')) {
    throw 'Disabled Skill was delivered despite being absent from the allowlist.'
  }
  $convertedClaudeRoot = Get-Item -LiteralPath $oldClaudeRoot -Force
  if (($convertedClaudeRoot.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
    throw 'Claude still points at the full flat active catalog instead of a curated recipient directory.'
  }
  foreach ($entryName in @('demo-skill', 'second-skill')) {
    if (-not (Test-Path -LiteralPath (Join-Path $oldClaudeRoot "$entryName\SKILL.md") -PathType Leaf)) {
      throw "Claude did not receive allowlisted parent-first entry: $entryName"
    }
  }
  if (Test-Path -LiteralPath (Join-Path $oldClaudeRoot 'disabled-skill')) {
    throw 'Claude received a Skill that was absent from the curated allowlist.'
  }

  $preservedDemo = Join-Path $allowlistedHome '.agents\skills\demo-skill\SKILL.md'
  $preservedSecond = Join-Path $allowlistedHome '.agents\skills\second-skill\SKILL.md'
  Set-Content -LiteralPath $allowlistPath -Encoding utf8 -Value @'
[
  "does-not-exist"
]
'@
  # Windows PowerShell 5.1 turns a native process' expected stderr into a
  # terminating NativeCommandError when the outer test uses Stop. Temporarily
  # relax only this deliberately failing probe so we can assert its exit code
  # and preservation postcondition.
  $savedErrorActionPreference = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    $failClosedOutput = & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scriptPath `
      -Quiet -HomePath $allowlistedHome -SimulateOpenAIDesktopPresent 2>&1
    $failClosedExitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $savedErrorActionPreference
  }
  if ($failClosedExitCode -eq 0) {
    throw 'A non-empty allowlist with zero active-view matches did not fail closed.'
  }
  if (($failClosedOutput -join "`n") -notmatch 'none match a valid active Skill') {
    throw "Fail-closed delivery returned an unexpected diagnostic: $($failClosedOutput -join ' ')"
  }
  if (-not (Test-Path -LiteralPath $preservedDemo -PathType Leaf) -or
      -not (Test-Path -LiteralPath $preservedSecond -PathType Leaf)) {
    throw 'Fail-closed allowlist validation removed an existing verified Codex Skill link.'
  }
  Remove-Item Env:AI_SKILLHUB_AGENT_SKILL_ALLOWLIST -ErrorAction SilentlyContinue

  $legacyRoot = Join-Path $homePath '.codex\skills'
  New-Item -ItemType Directory -Force -Path $legacyRoot | Out-Null
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $scriptPath `
    -Quiet -HomePath $homePath -SimulateCodexPresent
  if ($LASTEXITCODE -ne 0) { throw "Legacy compatibility delivery failed with exit code $LASTEXITCODE" }
  $legacySkill = Join-Path $legacyRoot 'demo-skill\SKILL.md'
  if (-not (Test-Path -LiteralPath $legacySkill -PathType Leaf)) {
    throw "Existing legacy Codex directory was not kept compatible: $legacySkill"
  }

  Write-Host 'PASS: desktop-only recipient receives verified Skills in ~/.agents/skills.'
  Write-Host 'PASS: clean recipient does not get a fake ~/.codex directory.'
  Write-Host 'PASS: existing ~/.codex/skills remains backward compatible.'
  Write-Host "PASS: Windows PowerShell $windowsPowerShellVersion enumerates every item in a multi-Skill allowlist."
  Write-Host 'PASS: disabled Skills are excluded by the persisted delivery allowlist.'
  Write-Host 'PASS: Claude full-catalog junction is migrated to a curated per-entry directory.'
  Write-Host 'PASS: a non-empty zero-match allowlist fails closed and preserves existing links.'
  Write-Host 'PASS: invalid SKILL.md manifests are excluded from delivery.'
} finally {
  if ($null -eq $previousConfig) {
    Remove-Item Env:AI_SKILLHUB_CONFIG_PATH -ErrorAction SilentlyContinue
  } else {
    $env:AI_SKILLHUB_CONFIG_PATH = $previousConfig
  }
  if ($null -eq $previousAllowlist) {
    Remove-Item Env:AI_SKILLHUB_AGENT_SKILL_ALLOWLIST -ErrorAction SilentlyContinue
  } else {
    $env:AI_SKILLHUB_AGENT_SKILL_ALLOWLIST = $previousAllowlist
  }
  if (Test-Path -LiteralPath $resolvedTestRoot) {
    $resolvedCleanup = [IO.Path]::GetFullPath($resolvedTestRoot)
    if (-not $resolvedCleanup.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing cleanup outside TEMP: $resolvedCleanup"
    }
    Remove-Item -LiteralPath $resolvedCleanup -Recurse -Force
  }
}
