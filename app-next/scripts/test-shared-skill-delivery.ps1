param()

$ErrorActionPreference = 'Stop'
$testRoot = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ('skillhub-shared-delivery-' + [guid]::NewGuid().ToString('N'))))
$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
if (-not $testRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture must stay in TEMP.' }
$previous = @{}
foreach ($key in @('PATH', 'AI_SKILLHUB_CONFIG_PATH', 'AI_SKILLHUB_AGENT_SKILL_ALLOWLIST', 'AI_SKILLHUB_REAL_SHARED_SKILLS', 'AI_SKILLHUB_ACTIVE_SKILLS', 'AI_SKILLHUB_SOURCES', 'AI_SKILLHUB_REPORTS', 'AI_SKILLHUB_STATE')) {
  $previous[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
}

function Write-Wrapper([string]$Directory, [string]$Source) {
  New-Item -ItemType Directory -Force -Path $Directory | Out-Null
  $body = "---`nname: demo-skill`ndescription: Shared compatibility fixture.`n---`nRead the original skill instructions before performing this skill: [demo-skill](<$($Source.Replace('\', '/'))>).`n"
  $sha = [Security.Cryptography.SHA256]::Create()
  try { $hash = ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($body)))).Replace('-', '').ToLowerInvariant() } finally { $sha.Dispose() }
  [IO.File]::WriteAllText((Join-Path $Directory 'SKILL.md'), ($body + "`n<!-- AI SkillHub shared-skill v1 sha256:" + $hash + " -->`n"), [Text.UTF8Encoding]::new($false))
}

try {
  $profile = Join-Path $testRoot 'profile'
  $shared = Join-Path $testRoot 'active-skills'
  $source = Join-Path $shared 'demo-skill'
  $sources = Join-Path $testRoot 'sources'
  $realRoot = Join-Path $profile '.agents\skills'
  $realEntry = Join-Path $realRoot 'demo-skill'
  $personal = Join-Path $realRoot 'personal\SKILL.md'
  New-Item -ItemType Directory -Force -Path $source, $sources, (Split-Path -Parent $personal) | Out-Null
  [IO.File]::WriteAllText((Join-Path $source 'SKILL.md'), "---`nname: demo-skill`ndescription: Valid source.`n---`nOriginal instructions.")
  [IO.File]::WriteAllText($personal, 'Personal Skill stays unchanged.')
  Write-Wrapper $realEntry (Join-Path $source 'SKILL.md')
  $originalWrapper = [IO.File]::ReadAllText((Join-Path $realEntry 'SKILL.md'))
  $config = Join-Path $testRoot 'config.json'
  @{ version = 3; activeSkillsFolder = $shared; githubSourcesFolder = $sources; repositories = @() } | ConvertTo-Json | Set-Content -LiteralPath $config -Encoding UTF8
  $env:AI_SKILLHUB_CONFIG_PATH = $config
  $env:AI_SKILLHUB_AGENT_SKILL_ALLOWLIST = ''
  $env:AI_SKILLHUB_REAL_SHARED_SKILLS = $realRoot
  $env:AI_SKILLHUB_ACTIVE_SKILLS = $shared
  $env:AI_SKILLHUB_SOURCES = $sources
  $env:AI_SKILLHUB_REPORTS = Join-Path $testRoot 'reports'
  $env:AI_SKILLHUB_STATE = Join-Path $testRoot 'state'
  $env:PATH = "$env:SystemRoot\System32;$PSHOME"
  $hostBinary = (Get-Process -Id $PID).Path
  $delivery = Join-Path $PSScriptRoot '..\runtime\Manage-AgentSkillLinks.ps1'
  $cozeExe = Join-Path $profile 'AppData\Local\Programs\Coze\Coze.exe'
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $cozeExe) | Out-Null
  [IO.File]::WriteAllText($cozeExe, 'Detection fixture only; never executed.')
  & $hostBinary -NoProfile -ExecutionPolicy Bypass -File $delivery -Quiet -HomePath $profile
  if ($LASTEXITCODE -ne 0) { throw 'Coze-only real-entry validation failed.' }
  if (Test-Path -LiteralPath (Join-Path $profile '.codex')) { throw 'Coze-only delivery created a fake Codex profile.' }
  $catalog = $shared + '-catalog'
  if (Test-Path -LiteralPath $catalog) { throw 'An absent legacy compatibility catalog was created.' }
  Write-Wrapper (Join-Path $catalog 'demo-skill') (Join-Path $source 'SKILL.md')
  Write-Wrapper (Join-Path $catalog 'disabled-skill') (Join-Path $shared 'disabled-skill\SKILL.md')

  # Legacy links still exist, but both client paths now resolve to one manifest.
  $legacy = Join-Path $profile '.codex\skills'
  New-Item -ItemType Directory -Force -Path $legacy | Out-Null
  New-Item -ItemType Junction -Path (Join-Path $legacy 'demo-skill') -Target $source | Out-Null
  foreach ($case in @(@('old-disabled', $shared), @('shared-disabled', $realRoot))) {
    $target = Join-Path $case[1] $case[0]
    New-Item -ItemType Directory -Force -Path $target | Out-Null
    New-Item -ItemType Junction -Path (Join-Path $legacy $case[0]) -Target $target | Out-Null
  }
  $legacyPersonal = Join-Path $legacy 'personal\SKILL.md'
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $legacyPersonal) | Out-Null
  [IO.File]::WriteAllText($legacyPersonal, 'Legacy personal Skill stays unchanged.')
  for ($run = 0; $run -lt 2; $run++) {
    & $hostBinary -NoProfile -ExecutionPolicy Bypass -File $delivery -Quiet -HomePath $profile -SimulateCodexPresent
    if ($LASTEXITCODE -ne 0) { throw 'Repeat Codex/shared synchronization failed.' }
    if ((Get-Item -LiteralPath $realEntry).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Real entry was converted back into a junction.' }
    if ([string](Get-Item -LiteralPath (Join-Path $legacy 'demo-skill')).Target -ne $realEntry) { throw 'Codex compatibility target does not share canonical identity.' }
    if ([IO.File]::ReadAllText((Join-Path $realEntry 'SKILL.md')) -ne $originalWrapper) { throw 'Shared wrapper changed during link sync.' }
    if ([string](Get-Item -LiteralPath (Join-Path $catalog 'demo-skill')).Target -ne $realEntry -or
        [IO.File]::ReadAllText((Join-Path $catalog 'demo-skill\SKILL.md')) -ne $originalWrapper) { throw 'Legacy catalog must remain readable through a shared alias.' }
  }
  if (@(Get-ChildItem -LiteralPath $catalog -Directory | Where-Object { -not ($_.Attributes -band [IO.FileAttributes]::ReparsePoint) }).Count) { throw 'Legacy catalog would still expose duplicate ordinary-directory entries.' }
  if (Test-Path -LiteralPath (Join-Path $catalog 'disabled-skill')) { throw 'A disabled catalog entry remains visible.' }
  $backups = @(Get-ChildItem -LiteralPath $testRoot -Directory -Filter 'active-skills-catalog-backup-*')
  if ($backups.Count -ne 1 -or -not (Test-Path -LiteralPath (Join-Path $backups[0].FullName 'demo-skill\SKILL.md')) -or
      -not (Test-Path -LiteralPath (Join-Path $backups[0].FullName 'disabled-skill\SKILL.md'))) { throw 'Catalog migration backup is missing or was placed in the scanned directory.' }
  if ((Test-Path -LiteralPath (Join-Path $legacy 'old-disabled')) -or (Test-Path -LiteralPath (Join-Path $legacy 'shared-disabled'))) { throw 'Disabled owned links were not removed.' }
  if ([IO.File]::ReadAllText($personal) -ne 'Personal Skill stays unchanged.' -or [IO.File]::ReadAllText($legacyPersonal) -ne 'Legacy personal Skill stays unchanged.') { throw 'Personal files changed.' }

  $diagnostics = Join-Path $PSScriptRoot '..\runtime\Export-SkillHubDiagnostics.ps1'
  & $hostBinary -NoProfile -ExecutionPolicy Bypass -File $diagnostics -Quiet -HomePath $profile -SimulateMissingGit
  if ($LASTEXITCODE -ne 0) { throw 'Shared directory diagnostics failed.' }
  $report = Get-Content -LiteralPath (Join-Path $env:AI_SKILLHUB_REPORTS 'latest-diagnostics.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $coze = @($report.agents | Where-Object id -eq 'coze')[0]
  if (-not $coze.detected -or -not $coze.skillsDirs[0].containsManagedSkillMd -or $coze.codeDetected) { throw 'Shared entry must show disk management, not Coze CLI readiness.' }
  $codex = @($report.agents | Where-Object id -eq 'codex')[0]
  if (@($codex.skillsDirs | Where-Object containsManagedSkillMd).Count -ne 2) { throw 'Shared and legacy Codex entries must report consistent ownership.' }
  # Detection verifies the entire checksum and the source identity, not a marker.
  $tokens = $null; $errors = $null
  $ast = [Management.Automation.Language.Parser]::ParseFile($diagnostics, [ref]$tokens, [ref]$errors)
  $definition = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-AgentManagedRealSkill' }, $true)
  . ([scriptblock]::Create($definition.Extent.Text))
  [IO.File]::AppendAllText((Join-Path $realEntry 'SKILL.md'), 'Personal edit')
  if (Test-AgentManagedRealSkill (Get-Item -LiteralPath $realEntry) $shared) { throw 'Modified checksum entry was marked managed.' }
  [IO.File]::WriteAllText((Join-Path $realEntry 'SKILL.md'), $originalWrapper)
  if (Test-AgentManagedRealSkill (Get-Item -LiteralPath $realEntry) ($shared + '-unrelated')) { throw 'A foreign catalog wrapper was marked managed.' }

  # Same-name ordinary files and external links are preserved, never backed up
  # and replaced to report a misleading successful delivery.
  $legacyEntry = Join-Path $legacy 'demo-skill'
  [IO.Directory]::Delete($legacyEntry)
  New-Item -ItemType Directory -Path $legacyEntry | Out-Null
  [IO.File]::WriteAllText((Join-Path $legacyEntry 'SKILL.md'), 'Personal collision')
  $ErrorActionPreference = 'Continue'
  & $hostBinary -NoProfile -ExecutionPolicy Bypass -File $delivery -Quiet -HomePath $profile -SimulateCodexPresent *> (Join-Path $testRoot 'expected-personal-error.log')
  $ErrorActionPreference = 'Stop'
  if ($LASTEXITCODE -eq 0 -or [IO.File]::ReadAllText((Join-Path $legacyEntry 'SKILL.md')) -ne 'Personal collision') { throw 'Personal collision was overwritten or falsely accepted.' }
  Remove-Item -LiteralPath (Join-Path $legacyEntry 'SKILL.md')
  [IO.Directory]::Delete($legacyEntry)
  $outside = Join-Path $testRoot 'external-skill'
  New-Item -ItemType Directory -Path $outside | Out-Null
  [IO.File]::WriteAllText((Join-Path $outside 'SKILL.md'), 'External collision')
  New-Item -ItemType Junction -Path $legacyEntry -Target $outside | Out-Null
  $ErrorActionPreference = 'Continue'
  & $hostBinary -NoProfile -ExecutionPolicy Bypass -File $delivery -Quiet -HomePath $profile -SimulateCodexPresent *> (Join-Path $testRoot 'expected-link-error.log')
  $ErrorActionPreference = 'Stop'
  if ($LASTEXITCODE -eq 0 -or [string](Get-Item -LiteralPath $legacyEntry).Target -ne $outside) { throw 'External collision was replaced or falsely accepted.' }
  $env:AI_SKILLHUB_REAL_SHARED_SKILLS = Join-Path $testRoot 'outside-root'
  $ErrorActionPreference = 'Continue'
  & $hostBinary -NoProfile -ExecutionPolicy Bypass -File $delivery -Quiet -HomePath $profile *> (Join-Path $testRoot 'expected-root-error.log')
  $ErrorActionPreference = 'Stop'
  if ($LASTEXITCODE -eq 0 -or (Test-Path -LiteralPath $env:AI_SKILLHUB_REAL_SHARED_SKILLS)) { throw 'An invalid shared root was accepted or created.' }
  $env:AI_SKILLHUB_REAL_SHARED_SKILLS = $realRoot
  $catalogEntry = Join-Path $catalog 'demo-skill'
  [IO.Directory]::Delete($catalogEntry)
  Write-Wrapper $catalogEntry (Join-Path $source 'SKILL.md')
  $personalCatalogFile = Join-Path $catalogEntry 'personal.txt'
  [IO.File]::WriteAllText($personalCatalogFile, 'Keep my catalog files.')
  $ErrorActionPreference = 'Continue'
  & $hostBinary -NoProfile -ExecutionPolicy Bypass -File $delivery -Quiet -HomePath $profile *> (Join-Path $testRoot 'expected-catalog-error.log')
  $ErrorActionPreference = 'Stop'
  if ($LASTEXITCODE -eq 0 -or [IO.File]::ReadAllText($personalCatalogFile) -ne 'Keep my catalog files.' -or
      ((Get-Item -LiteralPath $catalogEntry).Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'Catalog migration changed a personal directory.' }
  Write-Output 'PASS: Coze-only shared entries, repeated sync, legacy canonical identity, disabled-link cleanup, full checksum ownership, personal/external preservation, strict recipient root, and reversible legacy catalog deduplication.'
} finally {
  foreach ($key in $previous.Keys) { [Environment]::SetEnvironmentVariable($key, $previous[$key], 'Process') }
  if (Test-Path -LiteralPath $testRoot) {
    foreach ($link in @(Get-ChildItem -LiteralPath $testRoot -Recurse -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })) { [IO.Directory]::Delete($link.FullName) }
    Remove-Item -LiteralPath $testRoot -Recurse -Force
  }
}
