param()

$ErrorActionPreference = 'Stop'
$testRoot = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ('skillhub-workbuddy-' + [guid]::NewGuid().ToString('N'))))
$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
if (-not $testRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture must stay in TEMP.' }
$previous = @{}
foreach ($key in @('PATH', 'AI_SKILLHUB_CONFIG_PATH', 'AI_SKILLHUB_AGENT_SKILL_ALLOWLIST', 'WORKBUDDY_CONFIG_DIR', 'CODEBUDDY_CONFIG_DIR', 'AI_SKILLHUB_ACTIVE_SKILLS', 'AI_SKILLHUB_SOURCES', 'AI_SKILLHUB_REPORTS', 'AI_SKILLHUB_STATE')) { $previous[$key] = [Environment]::GetEnvironmentVariable($key, 'Process') }
try {
  $recipient = Join-Path $testRoot 'recipient'
  $shared = Join-Path $testRoot 'skills'
  $sources = Join-Path $testRoot 'sources'
  New-Item -ItemType Directory -Force -Path (Join-Path $shared 'demo-skill'), $sources, $recipient | Out-Null
  $body = "---`nname: demo-skill`ndescription: WorkBuddy delivery fixture.`n---`n# Demo"
  [IO.File]::WriteAllText((Join-Path $shared 'demo-skill\SKILL.md'), $body)
  $config = Join-Path $testRoot 'config.json'
  @{ version = 3; activeSkillsFolder = $shared; githubSourcesFolder = $sources; manageAgentLinks = $true; repositories = @() } | ConvertTo-Json | Set-Content -LiteralPath $config -Encoding UTF8
  $env:AI_SKILLHUB_CONFIG_PATH = $config
  $env:AI_SKILLHUB_AGENT_SKILL_ALLOWLIST = ''
  $env:WORKBUDDY_CONFIG_DIR = ''; $env:CODEBUDDY_CONFIG_DIR = ''
  $env:AI_SKILLHUB_ACTIVE_SKILLS = $shared
  $env:AI_SKILLHUB_SOURCES = $sources
  $env:AI_SKILLHUB_REPORTS = Join-Path $testRoot 'reports'
  $env:AI_SKILLHUB_STATE = Join-Path $testRoot 'state'
  $env:PATH = "$env:SystemRoot\System32;$PSHOME"
  $hostBinary = (Get-Process -Id $PID).Path
  $delivery = Join-Path $PSScriptRoot '..\runtime\Manage-AgentSkillLinks.ps1'
  . (Join-Path $PSScriptRoot '..\runtime\AgentInstallDiscovery.ps1')
  $localData = Join-Path $recipient 'AppData\Local'
  New-Item -ItemType Directory -Force -Path (Join-Path $recipient '.workbuddy\skills'), (Join-Path $recipient '.codebuddy\skills') | Out-Null
  [IO.File]::WriteAllText((Join-Path $recipient '.codebuddy\skills\personal.txt'), 'CodeBuddy user data')
  if (Get-WorkBuddyExecutable $localData -Isolated) { throw 'An empty settings directory was incorrectly treated as an installation.' }
  & $hostBinary -NoProfile -ExecutionPolicy Bypass -File $delivery -Quiet -HomePath $recipient
  if ($LASTEXITCODE -ne 0) { throw 'Absent-host delivery failed.' }
  if (Test-Path -LiteralPath (Join-Path $recipient '.workbuddy\skills\demo-skill')) { throw 'Missing WorkBuddy received an unwanted Skill.' }

  $installed = Join-Path $recipient 'AppData\Local\Programs\WorkBuddy'
  New-Item -ItemType Directory -Force -Path $installed | Out-Null
  [IO.File]::WriteAllText((Join-Path $installed 'WorkBuddy.exe'), 'Static fixture only; never executed.')
  & $hostBinary -NoProfile -ExecutionPolicy Bypass -File $delivery -Quiet -HomePath $recipient
  if ($LASTEXITCODE -ne 0) { throw 'Fresh WorkBuddy-only profile failed delivery.' }
  $manifest = Join-Path $recipient '.workbuddy\skills\demo-skill\SKILL.md'
  if (-not (Test-Path -LiteralPath $manifest) -or [IO.File]::ReadAllText($manifest) -ne $body) { throw 'Delivered WorkBuddy manifest is missing or differs.' }

  # WorkBuddy-owned unrelated Skills survive repeat synchronization.
  $native = Join-Path $recipient '.workbuddy\skills\personal-skill'
  New-Item -ItemType Directory -Force -Path $native | Out-Null
  [IO.File]::WriteAllText((Join-Path $native 'SKILL.md'), 'User-owned fixture')
  & $hostBinary -NoProfile -ExecutionPolicy Bypass -File $delivery -Quiet -HomePath $recipient
  if ($LASTEXITCODE -ne 0 -or [IO.File]::ReadAllText((Join-Path $native 'SKILL.md')) -ne 'User-owned fixture') { throw 'Repeat delivery changed a user-owned Skill.' }
  # Current WorkBuddy AI publishes its native profile name beside the app.
  $newInstalled = Join-Path $localData 'Programs\WorkBuddyAI'
  $product = Join-Path $newInstalled 'resources\app.asar.unpacked\cli\product.json'
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $product) | Out-Null
  $newExecutable = Join-Path $newInstalled 'WorkBuddyAI.exe'
  [IO.File]::WriteAllText($newExecutable, 'Static fixture only; never executed.')
  Remove-Item -LiteralPath (Join-Path $installed 'WorkBuddy.exe')
  # The real 5.6.2 product metadata is about 377 KiB, not a small settings file.
  [IO.File]::WriteAllText($product, ('{"dataFolderName":".workbuddy-ai","metadata":"' + ('x' * 386000) + '"}'))
  if ((Get-WorkBuddyExecutable $localData -Isolated) -ne $newExecutable) { throw 'WorkBuddyAI executable naming was missed.' }
  & $hostBinary -NoProfile -ExecutionPolicy Bypass -File $delivery -Quiet -HomePath $recipient
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $recipient '.workbuddy-ai\skills\demo-skill\SKILL.md'))) { throw 'Current WorkBuddy AI received a Skill in the wrong profile.' }
  if ([IO.File]::ReadAllText((Join-Path $recipient '.codebuddy\skills\personal.txt')) -ne 'CodeBuddy user data') { throw 'Existing CodeBuddy data was changed.' }

  # Custom install locations are read from values, never run as commands.
  $customExecutable = Join-Path $testRoot 'custom installation\WorkBuddyAI.exe'
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $customExecutable) | Out-Null
  [IO.File]::WriteAllText($customExecutable, 'Static fixture only; never executed.')
  $products = @('WorkBuddy AI'); $names = @('WorkBuddyAI.exe')
  foreach ($displayIcon in @(($customExecutable + ',0'), ('"' + $customExecutable + '",0'))) {
    $record = [PSCustomObject]@{ DisplayName = 'WorkBuddy AI 5.6.2'; DisplayIcon = $displayIcon; InstallLocation = '' }
    if ((Get-AgentRegistryExecutable $record $products $names) -ne $customExecutable) { throw 'Custom DisplayIcon install evidence was missed.' }
  }
  $record.DisplayIcon = ''; $record.InstallLocation = Split-Path -Parent $customExecutable
  if ((Get-AgentRegistryExecutable $record $products $names) -ne $customExecutable) { throw 'InstallLocation evidence was missed.' }
  $record.DisplayName = 'Unrelated tool'
  if (Get-AgentRegistryExecutable $record $products $names) { throw 'Unrelated product was detected as WorkBuddy.' }
  $record.DisplayName = 'WorkBuddy AI'; $record.InstallLocation = ''; $record.DisplayIcon = $customExecutable + ' --install'
  if (Get-AgentRegistryExecutable $record $products $names) { throw 'A command string was accepted as a DisplayIcon.' }
  $record.DisplayIcon = $customExecutable
  Remove-Item -LiteralPath $customExecutable
  if (Get-AgentRegistryExecutable $record $products $names) { throw 'Stale uninstall evidence was accepted.' }
  [IO.File]::WriteAllText($product, '{"dataFolderName":"../outside"}')
  if ((Get-WorkBuddyConfigRoot $recipient $newExecutable -Isolated) -ne (Join-Path $recipient '.workbuddy')) { throw 'Invalid product profile escaped the recipient home.' }
  [IO.File]::WriteAllText($product, '{"dataFolderName":".workbuddy-ai"}')

  $env:CODEBUDDY_CONFIG_DIR = Join-Path $recipient 'alternate-profile'
  $env:WORKBUDDY_CONFIG_DIR = Join-Path $recipient 'preferred-profile'
  & $hostBinary -NoProfile -ExecutionPolicy Bypass -File $delivery -Quiet -HomePath $recipient
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $env:WORKBUDDY_CONFIG_DIR 'skills\demo-skill\SKILL.md'))) { throw 'WorkBuddy profile override was ignored.' }
  if (Test-Path -LiteralPath $env:CODEBUDDY_CONFIG_DIR) { throw 'Lower priority CodeBuddy override was used.' }

  # Every catalog adapter gets a real diagnostic row; WorkBuddy delivery and
  # diagnosis resolve the identical profile. The explicit HomePath is isolated.
  $cozePath = Join-Path $localData 'Programs\Coze\Coze.exe'
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $cozePath) | Out-Null
  [IO.File]::WriteAllText($cozePath, 'Coze detection fixture only; never execute.')
  $diagnostics = Join-Path $PSScriptRoot '..\runtime\Export-SkillHubDiagnostics.ps1'
  & $hostBinary -NoProfile -ExecutionPolicy Bypass -File $diagnostics -Quiet -HomePath $recipient -SimulateMissingGit
  if ($LASTEXITCODE -ne 0) { throw 'Diagnostic fixture failed.' }
  $report = Get-Content -LiteralPath (Join-Path $env:AI_SKILLHUB_REPORTS 'latest-diagnostics.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  $workbuddy = @($report.agents | Where-Object id -eq 'workbuddy')[0]
  if (-not $workbuddy.detected -or -not $workbuddy.skillsDirs[0].containsSkillMd -or -not $workbuddy.skillsDirs[0].containsManagedSkillMd -or $workbuddy.baseDir -ne '~\preferred-profile') { throw 'WorkBuddy diagnostics disagrees with delivery.' }
  foreach ($id in @('claude','codex','workbuddy','antigravity','cursor','windsurf','gemini-cli','github-copilot','opencode','kiro','hermes','openclaw','amp','coze')) {
    if (@($report.agents | Where-Object id -eq $id).Count -ne 1) { throw "Missing or duplicate adapter diagnostic: $id" }
  }
  $coze = @($report.agents | Where-Object id -eq 'coze')[0]
  if (-not $coze.detected -or -not $coze.desktopDetected -or $coze.codeDetected -or $coze.baseDir -or @($coze.skillsDirs).Count -ne 1 -or $coze.skillsDirs[0].exists) { throw 'Coze must discover shared Skills without implying a CLI or creating a profile.' }
  if (Test-Path -LiteralPath (Join-Path $recipient '.coze')) { throw 'A fake Coze profile was created.' }
  if (@($report.agents | Where-Object { $_.id -in @('cursor','windsurf','gemini-cli','github-copilot','opencode','kiro','hermes','openclaw','amp') -and $_.detected }).Count) { throw 'Isolated fixture inspected a real installed tool.' }
  Write-Output 'PASS: old/current WorkBuddy, custom install records, stale/unrelated records, profile metadata/override, delivery/diagnosis agreement, 14 adapters, Coze without fake profile, and user-data preservation.'
} finally {
  foreach ($key in $previous.Keys) { [Environment]::SetEnvironmentVariable($key, $previous[$key], 'Process') }
  if (Test-Path -LiteralPath $testRoot) {
    foreach ($link in @(Get-ChildItem -LiteralPath $testRoot -Recurse -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })) { [IO.Directory]::Delete($link.FullName) }
    Remove-Item -LiteralPath $testRoot -Recurse -Force
  }
}
