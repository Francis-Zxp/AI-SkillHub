param()

$ErrorActionPreference = 'Stop'
$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
$testRoot = Join-Path ([IO.Path]::GetTempPath()) ('ai-skillhub-codex-delivery-' + [Guid]::NewGuid().ToString('N'))
$resolvedTestRoot = [IO.Path]::GetFullPath($testRoot)
if (-not $resolvedTestRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to create delivery test outside TEMP: $resolvedTestRoot"
}
$powerShellHost = (Get-Process -Id $PID).Path
$powerShellVersion = $PSVersionTable.PSVersion.ToString()

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
  $blockDescriptionSkill = Join-Path $activeSkills 'block-description-skill'
  New-Item -ItemType Directory -Force -Path $blockDescriptionSkill | Out-Null
  Set-Content -LiteralPath (Join-Path $blockDescriptionSkill 'SKILL.md') -Encoding utf8 -Value @'
---
name: block-description-skill
description: >-
  A valid folded YAML description that must remain discoverable
  by Codex and Claude Code delivery.
---

# Block description
'@

  $unicodeOnlyParent = -join ([char]0x6280, [char]0x80FD)
  $longUnsafeParent = (('A' * 65) -join '')
  $unsafeParentNames = @('Upper.Parent_Name', $unicodeOnlyParent, '___', $longUnsafeParent)
  foreach ($unsafeParentName in $unsafeParentNames) {
    $unsafeParent = Join-Path $activeSkills $unsafeParentName
    New-Item -ItemType Directory -Force -Path $unsafeParent | Out-Null
    Set-Content -LiteralPath (Join-Path $unsafeParent 'SKILL.md') -Encoding utf8 -Value @(
      '---',
      "name: $unsafeParentName",
      'description: "[ROUTER-HUB] Incompatible parent name fixture."',
      '---',
      '',
      '<!-- [ROUTER-HUB] -->'
    )
  }

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

  & $powerShellHost -NoProfile -ExecutionPolicy Bypass -File $scriptPath `
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
  foreach ($unsafeParentName in $unsafeParentNames) {
    $unsafeDelivery = Join-Path (Join-Path $homePath '.agents\skills') $unsafeParentName
    if (Test-Path -LiteralPath $unsafeDelivery) {
      throw "Recipient received a parent with a Claude-incompatible name: $unsafeParentName"
    }
  }

  $allowlistPath = Join-Path $resolvedTestRoot 'agent-skill-allowlist.json'
  Set-Content -LiteralPath $allowlistPath -Encoding utf8 -Value @'
[
  "demo-skill",
  "second-skill",
  "block-description-skill"
]
'@
  $env:AI_SKILLHUB_AGENT_SKILL_ALLOWLIST = $allowlistPath
  $allowlistedHome = Join-Path $resolvedTestRoot 'allowlisted-home'
  $oldClaudeRoot = Join-Path $allowlistedHome '.claude\skills'
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $oldClaudeRoot) | Out-Null
  New-Item -ItemType Junction -Path $oldClaudeRoot -Target $activeSkills | Out-Null
  & $powerShellHost -NoProfile -ExecutionPolicy Bypass -File $scriptPath `
    -Quiet -HomePath $allowlistedHome -SimulateOpenAIDesktopPresent -SimulateClaudePresent
  if ($LASTEXITCODE -ne 0) { throw "Allowlisted delivery failed with exit code $LASTEXITCODE" }
  if (-not (Test-Path -LiteralPath (Join-Path $allowlistedHome '.agents\skills\demo-skill\SKILL.md') -PathType Leaf)) {
    throw 'Enabled Skill was not delivered from the allowlist.'
  }
  if (-not (Test-Path -LiteralPath (Join-Path $allowlistedHome '.agents\skills\second-skill\SKILL.md') -PathType Leaf)) {
    throw 'Windows PowerShell 5.1 treated the multi-item allowlist as one Object[] instead of delivering its second Skill.'
  }
  if (-not (Test-Path -LiteralPath (Join-Path $allowlistedHome '.agents\skills\block-description-skill\SKILL.md') -PathType Leaf)) {
    throw 'A valid block-scalar YAML description was incorrectly excluded from Agent delivery.'
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

  # A junction whose target disappeared is invisible to Test-Path, but the link
  # object still occupies the destination. Reproduce that exact field failure
  # and verify the next reconciliation replaces it with a healthy managed link.
  $danglingEntry = Join-Path $allowlistedHome '.agents\skills\demo-skill'
  $danglingTarget = Join-Path $resolvedTestRoot 'removed-router-target'
  [IO.Directory]::Delete($danglingEntry, $false)
  New-Item -ItemType Directory -Force -Path $danglingTarget | Out-Null
  New-Item -ItemType Junction -Path $danglingEntry -Target $danglingTarget | Out-Null
  Remove-Item -LiteralPath $danglingTarget -Recurse -Force
  if (Test-Path -LiteralPath (Join-Path $danglingEntry 'SKILL.md') -PathType Leaf) {
    throw 'Dangling-junction fixture unexpectedly exposes a SKILL.md after its target was removed.'
  }
  & $powerShellHost -NoProfile -ExecutionPolicy Bypass -File $scriptPath `
    -Quiet -HomePath $allowlistedHome -SimulateOpenAIDesktopPresent -SimulateClaudePresent
  if ($LASTEXITCODE -ne 0) { throw "Dangling-link repair failed with exit code $LASTEXITCODE" }
  if (-not (Test-Path -LiteralPath (Join-Path $danglingEntry 'SKILL.md') -PathType Leaf)) {
    throw 'Agent delivery did not replace a dangling managed junction.'
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
    $failClosedOutput = & $powerShellHost -NoProfile -ExecutionPolicy Bypass -File $scriptPath `
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
  & $powerShellHost -NoProfile -ExecutionPolicy Bypass -File $scriptPath `
    -Quiet -HomePath $homePath -SimulateCodexPresent
  if ($LASTEXITCODE -ne 0) { throw "Legacy compatibility delivery failed with exit code $LASTEXITCODE" }
  $legacySkill = Join-Path $legacyRoot 'demo-skill\SKILL.md'
  if (-not (Test-Path -LiteralPath $legacySkill -PathType Leaf)) {
    throw "Existing legacy Codex directory was not kept compatible: $legacySkill"
  }

  Write-Host 'PASS: desktop-only recipient receives verified Skills in ~/.agents/skills.'
  Write-Host 'PASS: clean recipient does not get a fake ~/.codex directory.'
  Write-Host 'PASS: existing ~/.codex/skills remains backward compatible.'
  Write-Host "PASS: PowerShell $powerShellVersion enumerates every item in a multi-Skill allowlist."
  Write-Host 'PASS: disabled Skills are excluded by the persisted delivery allowlist.'
  Write-Host 'PASS: Claude full-catalog junction is migrated to a curated per-entry directory.'
  Write-Host 'PASS: a non-empty zero-match allowlist fails closed and preserves existing links.'
  Write-Host 'PASS: invalid SKILL.md manifests are excluded from delivery.'
  Write-Host 'PASS: folded YAML descriptions remain valid for Codex and Claude Code.'
  Write-Host 'PASS: parent entries outside the Claude-compatible name subset are rejected before delivery.'
  Write-Host 'PASS: dangling managed junctions are repaired on the next reconciliation.'
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
