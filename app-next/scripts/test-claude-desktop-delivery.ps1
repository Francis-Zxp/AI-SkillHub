param()

$ErrorActionPreference = 'Stop'
$testRoot = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ('skillhub-claude-desktop-' + [guid]::NewGuid().ToString('N'))))
$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
if (-not $testRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture must stay in TEMP.' }
$previous = @{}
foreach ($key in @('PATH', 'CLAUDE_CONFIG_DIR', 'AI_SKILLHUB_CONFIG_PATH', 'AI_SKILLHUB_AGENT_SKILL_ALLOWLIST')) {
  $previous[$key] = [Environment]::GetEnvironmentVariable($key, 'Process')
}

try {
  $recipientHome = Join-Path $testRoot 'recipient'
  $shared = Join-Path $testRoot 'skills'
  $sources = Join-Path $testRoot 'sources'
  $child = Join-Path $sources 'research\drawing\SKILL.md'
  $parent = Join-Path $shared 'research--author'
  New-Item -ItemType Directory -Force -Path $parent, (Split-Path -Parent $child), (Join-Path $recipientHome 'AppData\Roaming\Claude') | Out-Null
  [IO.File]::WriteAllText($child, "---`nname: drawing`ndescription: Draw a research figure.`n---`n# Drawing", [Text.UTF8Encoding]::new($false))
  $router = @'
---
name: research--author
description: Research drawing tools.
---
<!-- [ROUTER-HUB] -->
- [CHILD-SKILL] `drawing` — Draw a figure; 来源文件：`CHILD_PATH`
'@
  [IO.File]::WriteAllText((Join-Path $parent 'SKILL.md'), $router.Replace('CHILD_PATH', $child.Replace('\', '/')), [Text.UTF8Encoding]::new($false))
  $config = Join-Path $testRoot 'skillhub.config.json'
  @{ version = 3; activeSkillsFolder = $shared; githubSourcesFolder = $sources; manageAgentLinks = $true; repositories = @() } | ConvertTo-Json | Set-Content -LiteralPath $config -Encoding UTF8
  $env:AI_SKILLHUB_CONFIG_PATH = $config
  $env:AI_SKILLHUB_AGENT_SKILL_ALLOWLIST = ''
  $env:CLAUDE_CONFIG_DIR = ''
  $env:PATH = "$env:SystemRoot\System32;$PSHOME"
  $hostBinary = (Get-Process -Id $PID).Path
  $delivery = Join-Path $PSScriptRoot '..\runtime\Manage-AgentSkillLinks.ps1'

  & $hostBinary -NoProfile -ExecutionPolicy Bypass -File $delivery -Quiet -HomePath $recipientHome
  if ($LASTEXITCODE -ne 0) { throw 'Desktop-only fixture failed.' }
  if (Test-Path -LiteralPath (Join-Path $recipientHome '.claude')) { throw 'Desktop Chat-only evidence created a fake Claude Code directory.' }

  $runtime = Join-Path $recipientHome 'AppData\Roaming\Claude\claude-code\2.1.286\635c1867224a'
  New-Item -ItemType Directory -Force -Path $runtime | Out-Null
  [IO.File]::WriteAllText((Join-Path $runtime 'claude.exe'), 'Detection fixture only; never execute.')
  & $hostBinary -NoProfile -ExecutionPolicy Bypass -File $delivery -Quiet -HomePath $recipientHome
  if ($LASTEXITCODE -ne 0) { throw 'Embedded Code fresh-install delivery failed.' }
  $delivered = Join-Path $recipientHome '.claude\skills\research--author\SKILL.md'
  if (-not (Test-Path -LiteralPath $delivered -PathType Leaf)) { throw 'Bundled engine without CLI did not receive the parent Skill.' }
  if ([IO.File]::ReadAllText($delivered) -ne [IO.File]::ReadAllText((Join-Path $parent 'SKILL.md'))) { throw 'Parent manifest changed in delivery.' }
  if (-not (Test-Path -LiteralPath $child)) { throw 'Parent target is not readable.' }

  # Store Desktop's engine is visible outside MSIX only under LocalCache.
  $storeRuntime = Join-Path $recipientHome 'AppData\Local\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\claude-code\2.1.286\635c1867224a'
  New-Item -ItemType Directory -Force -Path $storeRuntime | Out-Null
  Move-Item -LiteralPath (Join-Path $runtime 'claude.exe') -Destination (Join-Path $storeRuntime 'claude.exe')
  $env:CLAUDE_CONFIG_DIR = Join-Path $recipientHome 'store-code-profile'
  & $hostBinary -NoProfile -ExecutionPolicy Bypass -File $delivery -Quiet -HomePath $recipientHome
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $env:CLAUDE_CONFIG_DIR 'skills\research--author\SKILL.md'))) { throw 'Store Code without visible Roaming runtime failed delivery.' }

  # Probe the production diagnostics functions directly without running a report
  # or scanning the real user's profile. No fake engine is ever launched.
  foreach ($filename in @('Manage-AgentSkillLinks.ps1', 'Export-SkillHubDiagnostics.ps1')) {
    $tokens = $null; $parseErrors = $null
    $ast = [Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot "..\runtime\$filename"), [ref]$tokens, [ref]$parseErrors)
    if ($parseErrors.Count) { throw "Invalid PowerShell syntax in $filename" }
    $function = $ast.Find({ param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Get-ClaudeDesktopCodeExecutable' }, $true)
    . ([scriptblock]::Create($function.Extent.Text))
    if (Get-ClaudeDesktopCodeExecutable (Join-Path $recipientHome 'AppData\Roaming')) { throw 'Virtual Roaming path incorrectly contains runtime.' }
    if (-not (Get-ClaudeDesktopCodeExecutable (Join-Path $recipientHome 'AppData\Roaming') (Join-Path $recipientHome 'AppData\Local'))) { throw "Store embedded runtime missing from $filename" }
    if (Get-ClaudeDesktopCodeExecutable (Join-Path $testRoot 'empty-roaming')) { throw 'Missing runtime was detected.' }
  }

  # A custom profile must receive the Skill rather than default ~/.claude.
  $env:CLAUDE_CONFIG_DIR = Join-Path $recipientHome 'custom-code-profile'
  & $hostBinary -NoProfile -ExecutionPolicy Bypass -File $delivery -Quiet -HomePath $recipientHome
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath (Join-Path $env:CLAUDE_CONFIG_DIR 'skills\research--author\SKILL.md'))) { throw 'Custom Claude profile delivery failed.' }
  Write-Output 'PASS: Chat-only does not create skills; Desktop Code without PATH/config delivers a valid readable parent; both probes agree; custom profile receives delivery.'
} finally {
  foreach ($key in $previous.Keys) { [Environment]::SetEnvironmentVariable($key, $previous[$key], 'Process') }
  if (Test-Path -LiteralPath $testRoot) {
    # Remove managed junctions themselves before recursive TEMP cleanup.
    foreach ($link in @(Get-ChildItem -LiteralPath $testRoot -Recurse -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })) {
      [IO.Directory]::Delete($link.FullName)
    }
    Remove-Item -LiteralPath $testRoot -Recurse -Force
  }
}
