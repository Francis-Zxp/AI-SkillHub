param()
$ErrorActionPreference = 'Stop'
$testRoot = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ('skillhub-agent-probes-' + [guid]::NewGuid().ToString('N'))))
$tempPrefix = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
if (-not $testRoot.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture must stay in TEMP.' }
$previousPath = $env:PATH
try {
  . (Join-Path $PSScriptRoot '..\runtime\AgentInstallDiscovery.ps1')
  $runtime = Join-Path $PSScriptRoot '..\runtime'
  $tokens = $null; $parseErrors = $null
  $diagnosticsAst = [Management.Automation.Language.Parser]::ParseFile((Join-Path $runtime 'Export-SkillHubDiagnostics.ps1'), [ref]$tokens, [ref]$parseErrors)
  if ($parseErrors.Count) { throw 'Diagnostics syntax failed.' }
  $mapping = $diagnosticsAst.Find({ param($node) $node -is [Management.Automation.Language.AssignmentStatementAst] -and $node.Left.Extent.Text -eq '$otherTools' }, $true)
  . ([scriptblock]::Create($mapping.Extent.Text))
  $expected = @{
    'claude' = 'claude'; 'codex' = 'codex'; 'workbuddy' = 'workbuddy';
    'antigravity' = 'antigravity'; 'cursor' = 'cursor'; 'windsurf' = 'windsurf';
    'gemini-cli' = 'gemini'; 'github-copilot' = 'copilot'; 'opencode' = 'opencode';
    'kiro' = 'kiro-cli'; 'hermes' = 'hermes'; 'openclaw' = 'openclaw'; 'amp' = 'amp'
  }
  foreach ($tool in $otherTools) {
    if ($tool.Id -eq 'coze') {
      if ($tool.Command -or $tool.Folder) { throw 'Coze must not invent a CLI or user Skills directory.' }
      continue
    }
    if ($expected[$tool.Id] -ne $tool.Command) { throw "Incorrect CLI mapping for $($tool.Id)." }
  }
  if ($otherTools.Count -ne 11 -or @($otherTools | Where-Object Id -eq 'coze').Count -ne 1) { throw 'The 14-client catalog table is incomplete.' }
  $cliDir = Join-Path $testRoot 'commands'
  New-Item -ItemType Directory -Force -Path $cliDir | Out-Null
  $env:PATH = $cliDir
  foreach ($id in $expected.Keys) {
    $name = $expected[$id]
    $path = Join-Path $cliDir ($name + '.cmd')
    [IO.File]::WriteAllText($path, '@rem Detection fixture only; never execute.')
    if ((Get-AgentCliExecutable $name) -ne $path) { throw "CLI path not detected for $id." }
    if (Get-AgentCliExecutable $name -Isolated) { throw "Isolated probe read a real PATH command for $id." }
    Remove-Item -LiteralPath $path
    if (Get-AgentCliExecutable $name) { throw "Removed CLI incorrectly detected for $id." }
  }
  Write-Output 'PASS: all 13 catalog CLI names resolve an existing command without execution; missing commands and isolated PATH do not count.'

  $script:HomePath = Join-Path $testRoot 'profile'
  $EffectiveHome = $script:HomePath
  $script:LocalAppDataPath = Join-Path $script:HomePath 'AppData\Local'
  $script:RoamingAppData = Join-Path $script:HomePath 'AppData\Roaming'
  $IsolatedHome = $true
  $script:SimulateNoAgents = $false
  $script:SimulateClaudeDesktopOnly = $false
  $script:SimulateOpenAIDesktopOnly = $false
  $SimulateOpenAIDesktopPresent = $false
  foreach ($name in @('Test-ClaudeDesktopPresent', 'Test-OpenAIDesktopPresent', 'Test-ClaudeCodePresent', 'Test-CodexCodePresent', 'Get-ClaudeDesktopCodeExecutable')) {
    $definition = $diagnosticsAst.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    . ([scriptblock]::Create($definition.Extent.Text))
  }
  if ((Test-ClaudeDesktopPresent) -or (Test-OpenAIDesktopPresent)) { throw 'Isolated empty profile observed a real desktop installation.' }
  foreach ($tool in @(
    @{ Id = 'claude'; Name = 'Claude'; Exe = 'Claude.exe'; Folder = 'Claude' },
    @{ Id = 'codex'; Name = 'Codex'; Exe = 'Codex.exe'; Folder = 'Codex' },
    @{ Id = 'chatgpt'; Name = 'ChatGPT'; Exe = 'ChatGPT.exe'; Folder = 'ChatGPT' },
    @{ Id = 'cursor'; Name = 'Cursor'; Exe = 'Cursor.exe'; Folder = 'Cursor' },
    @{ Id = 'windsurf'; Name = 'Windsurf'; Exe = 'Windsurf.exe'; Folder = 'Windsurf' },
    @{ Id = 'coze'; Name = 'Coze'; Exe = 'Coze.exe'; Folder = 'Coze' }
  )) {
    $path = Join-Path $script:LocalAppDataPath ('Programs\' + $tool.Folder + '\' + $tool.Exe)
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $path) | Out-Null
    [IO.File]::WriteAllText($path, 'Detection fixture only; never execute.')
    if ($tool.Id -eq 'claude') {
      if (-not (Test-ClaudeDesktopPresent)) { throw 'Claude Desktop without CLI was missed.' }
      if (Test-ClaudeCodePresent (Join-Path $script:HomePath '.claude')) { throw 'Claude Chat-only fixture incorrectly supports local Code Skills.' }
    } elseif ($tool.Id -in @('codex', 'chatgpt')) {
      if (-not (Test-OpenAIDesktopPresent)) { throw "$($tool.Name) Desktop without CLI was missed." }
    } else {
      $probe = $otherTools | Where-Object Id -eq $tool.Id
      if ((Get-AgentDesktopExecutable $script:LocalAppDataPath $probe.Products $probe.Exes $probe.Installs -Isolated) -ne $path) { throw "$($tool.Name) desktop-only detection was missed." }
    }
    Remove-Item -LiteralPath $path
    $custom = Join-Path $testRoot ('custom installs\' + $tool.Name + '\' + $tool.Exe)
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $custom) | Out-Null
    [IO.File]::WriteAllText($custom, 'Detection fixture only; never execute.')
    $record = [pscustomobject]@{ DisplayName = ($tool.Name + ' 1.2.3'); DisplayIcon = ($custom + ',0'); InstallLocation = '' }
    if ((Get-AgentRegistryExecutable $record @($tool.Name) @($tool.Exe)) -ne $custom) { throw "Custom registry install was missed for $($tool.Name)." }
    if ($tool.Id -eq 'coze') {
      Remove-Item -LiteralPath $custom
      if (Get-AgentRegistryExecutable $record $probe.Products $probe.Exes) { throw 'A stale Coze registry record was treated as installed.' }
      if (Get-AgentDesktopExecutable $script:LocalAppDataPath $probe.Products $probe.Exes $probe.Installs -Isolated) { throw 'Removed Coze installation is still detected.' }
    }
  }
  Write-Output 'PASS: Claude, Codex, ChatGPT, Cursor, Windsurf and Coze desktop-only/custom installs are recognized; stale Coze is rejected; Chat-only stays separate from Code.'

  # The real delivery script must agree with diagnostics for desktop-only Codex.
  $deliveryAst = [Management.Automation.Language.Parser]::ParseFile((Join-Path $runtime 'Manage-AgentSkillLinks.ps1'), [ref]$tokens, [ref]$parseErrors)
  if ($parseErrors.Count) { throw 'Delivery syntax failed.' }
  $definition = $deliveryAst.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Test-OpenAIDesktopPresent' }, $true)
  . ([scriptblock]::Create($definition.Extent.Text))
  if (Test-OpenAIDesktopPresent) { throw 'Delivery inspected a real desktop from the isolated profile.' }
  $desktopPath = Join-Path $script:LocalAppDataPath 'Programs\Codex\Codex.exe'
  [IO.File]::WriteAllText($desktopPath, 'Detection fixture only; never execute.')
  if (-not (Test-OpenAIDesktopPresent)) { throw 'Delivery missed desktop-only Codex fixture.' }
  Write-Output 'PASS: desktop-only Codex diagnosis and delivery use the same evidence.'

  foreach ($name in @('Test-AgentManagedSkillLink', 'Test-AgentManagedRealSkill', 'Test-AgentManagedSkillDirectory')) {
    $definition = $diagnosticsAst.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq $name }, $true)
    . ([scriptblock]::Create($definition.Extent.Text))
  }
  $managedRoot = Join-Path $testRoot 'managed-skills'
  $personalRoot = Join-Path $testRoot 'personal-skills'
  $externalRoot = Join-Path $testRoot 'managed-skills-unrelated'
  foreach ($root in @($managedRoot, $personalRoot, $externalRoot)) {
    New-Item -ItemType Directory -Force -Path (Join-Path $root 'example') | Out-Null
    [IO.File]::WriteAllText((Join-Path $root 'example\SKILL.md'), 'Readable fixture')
  }
  if (Test-AgentManagedSkillDirectory $personalRoot $managedRoot) { throw 'A personal Skill was marked as managed.' }
  New-Item -ItemType Junction -Path (Join-Path $personalRoot 'external-link') -Target (Join-Path $externalRoot 'example') | Out-Null
  if (Test-AgentManagedSkillDirectory $personalRoot $managedRoot) { throw 'An unrelated link/prefix collision was marked as managed.' }
  $rootLink = Join-Path $testRoot 'legacy-root-link'
  New-Item -ItemType Junction -Path $rootLink -Target $managedRoot | Out-Null
  if (-not (Test-AgentManagedSkillDirectory $rootLink $managedRoot)) { throw 'A whole-root SkillHub junction was not recognized.' }
  New-Item -ItemType Junction -Path (Join-Path $personalRoot 'managed-link') -Target (Join-Path $managedRoot 'example') | Out-Null
  if (-not (Test-AgentManagedSkillDirectory $personalRoot $managedRoot)) { throw 'A per-Skill SkillHub junction was not recognized.' }
  Write-Output 'PASS: only readable SkillHub root/child junctions prove management; personal Skills and external/prefix-collision links do not.'
} finally {
  $env:PATH = $previousPath
  if (Test-Path -LiteralPath $testRoot) {
    foreach ($link in @(Get-ChildItem -LiteralPath $testRoot -Recurse -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })) { [IO.Directory]::Delete($link.FullName) }
    Remove-Item -LiteralPath $testRoot -Recurse -Force
  }
}
