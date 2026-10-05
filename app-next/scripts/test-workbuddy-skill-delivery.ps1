param()

$ErrorActionPreference = 'Stop'
$testRoot = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ('skillhub-workbuddy-' + [guid]::NewGuid().ToString('N'))))
$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
if (-not $testRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture must stay in TEMP.' }
$previous = @{}
foreach ($key in @('PATH', 'AI_SKILLHUB_CONFIG_PATH', 'AI_SKILLHUB_AGENT_SKILL_ALLOWLIST')) { $previous[$key] = [Environment]::GetEnvironmentVariable($key, 'Process') }
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
  $env:PATH = "$env:SystemRoot\System32;$PSHOME"
  $hostBinary = (Get-Process -Id $PID).Path
  $delivery = Join-Path $PSScriptRoot '..\runtime\Manage-AgentSkillLinks.ps1'
  & $hostBinary -NoProfile -ExecutionPolicy Bypass -File $delivery -Quiet -HomePath $recipient
  if ($LASTEXITCODE -ne 0) { throw 'Absent-host delivery failed.' }
  if (Test-Path -LiteralPath (Join-Path $recipient '.codebuddy')) { throw 'Missing WorkBuddy created an unwanted directory.' }

  $installed = Join-Path $recipient 'AppData\Local\Programs\WorkBuddy'
  New-Item -ItemType Directory -Force -Path $installed | Out-Null
  [IO.File]::WriteAllText((Join-Path $installed 'WorkBuddy.exe'), 'Static fixture only; never executed.')
  & $hostBinary -NoProfile -ExecutionPolicy Bypass -File $delivery -Quiet -HomePath $recipient
  if ($LASTEXITCODE -ne 0) { throw 'Fresh WorkBuddy-only profile failed delivery.' }
  $manifest = Join-Path $recipient '.codebuddy\skills\demo-skill\SKILL.md'
  if (-not (Test-Path -LiteralPath $manifest) -or [IO.File]::ReadAllText($manifest) -ne $body) { throw 'Delivered WorkBuddy manifest is missing or differs.' }

  # WorkBuddy-owned unrelated Skills survive repeat synchronization.
  $native = Join-Path $recipient '.codebuddy\skills\personal-skill'
  New-Item -ItemType Directory -Force -Path $native | Out-Null
  [IO.File]::WriteAllText((Join-Path $native 'SKILL.md'), 'User-owned fixture')
  & $hostBinary -NoProfile -ExecutionPolicy Bypass -File $delivery -Quiet -HomePath $recipient
  if ($LASTEXITCODE -ne 0 -or [IO.File]::ReadAllText((Join-Path $native 'SKILL.md')) -ne 'User-owned fixture') { throw 'Repeat delivery changed a user-owned Skill.' }
  Write-Output 'PASS: no WorkBuddy means no directory; fresh installed WorkBuddy without CLI receives a readable Skill; repeat delivery preserves user-owned Skills.'
} finally {
  foreach ($key in $previous.Keys) { [Environment]::SetEnvironmentVariable($key, $previous[$key], 'Process') }
  if (Test-Path -LiteralPath $testRoot) {
    foreach ($link in @(Get-ChildItem -LiteralPath $testRoot -Recurse -Directory -ErrorAction SilentlyContinue | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })) { [IO.Directory]::Delete($link.FullName) }
    Remove-Item -LiteralPath $testRoot -Recurse -Force
  }
}
