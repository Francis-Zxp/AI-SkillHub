param()

# v3.3 targets mode of Manage-AgentSkillLinks.ps1 (skills contract §3.3, §8.1).
# Runs only against a fixture HOME under TEMP; the real profile is never read
# for presence (-HomePath isolates detection) and never written.
$ErrorActionPreference = 'Stop'
$testRoot = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ('skillhub-targets-' + [guid]::NewGuid().ToString('N'))))
$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
if (-not $testRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) { throw 'Fixture must stay in TEMP.' }
$envKeys = @('PATH', 'AI_SKILLHUB_CONFIG_PATH', 'AI_SKILLHUB_AGENT_SKILL_ALLOWLIST', 'AI_SKILLHUB_AGENT_SKILL_TARGETS',
  'AI_SKILLHUB_DELIVERY_REPORT', 'AI_SKILLHUB_REAL_SHARED_SKILLS', 'WORKBUDDY_CONFIG_DIR', 'CODEBUDDY_CONFIG_DIR',
  'CLAUDE_CONFIG_DIR', 'AI_SKILLHUB_ACTIVE_SKILLS', 'AI_SKILLHUB_SOURCES', 'AI_SKILLHUB_REPORTS', 'AI_SKILLHUB_STATE')
$previous = @{}
foreach ($key in $envKeys) { $previous[$key] = [Environment]::GetEnvironmentVariable($key, 'Process') }

function Assert-True([bool]$Condition, [string]$Message) { if (-not $Condition) { throw "FAIL: $Message" } }

function Get-TreeHash([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path)) { return 'absent' }
  $lines = foreach ($item in @(Get-ChildItem -LiteralPath $Path -Recurse -Force -ErrorAction SilentlyContinue | Sort-Object FullName)) {
    $kind = if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { 'link:' + [string]$item.Target } elseif ($item.PSIsContainer) { 'dir' } else { 'file:' + (Get-FileHash -LiteralPath $item.FullName -Algorithm SHA256).Hash }
    $item.FullName.Substring($Path.Length) + '|' + $kind
  }
  return ($lines -join "`n")
}

try {
  $fixtureHome = Join-Path $testRoot 'home'
  $shared = Join-Path $testRoot 'skills'
  $sources = Join-Path $testRoot 'sources'
  $state = Join-Path $testRoot 'state'
  New-Item -ItemType Directory -Force -Path $fixtureHome, $sources, $state | Out-Null
  foreach ($name in @('alpha', 'beta', 'gamma')) {
    New-Item -ItemType Directory -Force -Path (Join-Path $shared $name) | Out-Null
    [IO.File]::WriteAllText((Join-Path $shared "$name\SKILL.md"), "---`nname: $name`ndescription: Targets fixture $name.`n---`n# $name")
  }
  $config = Join-Path $testRoot 'config.json'
  @{ version = 3; activeSkillsFolder = $shared; githubSourcesFolder = $sources; manageAgentLinks = $false; repositories = @() } |
    ConvertTo-Json | Set-Content -LiteralPath $config -Encoding UTF8
  $env:AI_SKILLHUB_CONFIG_PATH = $config
  $env:AI_SKILLHUB_AGENT_SKILL_ALLOWLIST = ''
  $env:AI_SKILLHUB_REAL_SHARED_SKILLS = ''
  $env:WORKBUDDY_CONFIG_DIR = ''; $env:CODEBUDDY_CONFIG_DIR = ''; $env:CLAUDE_CONFIG_DIR = ''
  $env:AI_SKILLHUB_ACTIVE_SKILLS = $shared
  $env:AI_SKILLHUB_SOURCES = $sources
  $env:AI_SKILLHUB_REPORTS = Join-Path $testRoot 'reports'
  $env:AI_SKILLHUB_STATE = $state
  $env:PATH = "$env:SystemRoot\System32;$PSHOME"
  $hostBinary = (Get-Process -Id $PID).Path
  $delivery = Join-Path $PSScriptRoot '..\runtime\Manage-AgentSkillLinks.ps1'
  $targetsPath = Join-Path $state 'agent-skill-targets.json'
  $reportPath = Join-Path $state 'agent-skill-delivery-report.json'

  # Claude Code presence is a config marker inside the fixture HOME only.
  New-Item -ItemType Directory -Force -Path (Join-Path $fixtureHome '.claude') | Out-Null
  [IO.File]::WriteAllText((Join-Path $fixtureHome '.claude\settings.json'), '{}')
  $claude = Join-Path $fixtureHome '.claude\skills'
  $workbuddy = Join-Path $fixtureHome '.workbuddy\skills'
  $antigravity = Join-Path $fixtureHome '.gemini\antigravity\skills'
  $cursor = Join-Path $fixtureHome '.cursor\skills'
  $gemini = Join-Path $fixtureHome '.gemini\skills'

  function Invoke-Targets($Union, $Recipients, [string[]]$Switches = @()) {
    $document = [PSCustomObject]@{ version = 1; policyVersion = 'parent-first-v3.3-targets'; union = [object[]]$Union; recipients = [object[]]$Recipients }
    [IO.File]::WriteAllText($targetsPath, ($document | ConvertTo-Json -Depth 6), [Text.UTF8Encoding]::new($false))
    if (Test-Path -LiteralPath $reportPath) { Remove-Item -LiteralPath $reportPath -Force }
    $env:AI_SKILLHUB_AGENT_SKILL_TARGETS = $targetsPath
    $env:AI_SKILLHUB_DELIVERY_REPORT = $reportPath
    $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $delivery, '-Quiet', '-HomePath', $fixtureHome) + $Switches
    & $hostBinary @arguments | Out-Null
    $script:LastExit = $LASTEXITCODE
    $env:AI_SKILLHUB_AGENT_SKILL_TARGETS = ''
    if (Test-Path -LiteralPath $reportPath) {
      return (Get-Content -LiteralPath $reportPath -Raw -Encoding UTF8 | ConvertFrom-Json)
    }
    return $null
  }
  function Recipient($Report, [string]$Id) { return @($Report.recipients | Where-Object id -eq $Id)[0] }
  function Linked([string]$Folder) {
    return @(Get-ChildItem -LiteralPath $Folder -Force -Directory -ErrorAction SilentlyContinue |
      Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint } | ForEach-Object Name | Sort-Object)
  }
  $presence = @('-SimulateWorkBuddyPresent', '-SimulateAntigravityPresent')

  # (a) Per-recipient names only; skip touches nothing.
  $report = Invoke-Targets @('alpha', 'beta', 'gamma') @(
    [PSCustomObject]@{ id = 'claude'; action = 'deliver'; path = $claude; names = @('alpha') },
    [PSCustomObject]@{ id = 'workbuddy'; action = 'deliver'; path = $workbuddy; names = @('alpha', 'beta') },
    [PSCustomObject]@{ id = 'antigravity'; action = 'skip' }
  ) $presence
  Assert-True ($LastExit -eq 0) '(a) targets delivery exits 0'
  Assert-True ((Linked $claude) -join ',' -eq 'alpha') '(a) Claude holds exactly alpha'
  Assert-True ((Linked $workbuddy) -join ',' -eq 'alpha,beta') '(a) WorkBuddy holds alpha and beta'
  Assert-True (-not (Test-Path -LiteralPath $antigravity)) '(a) skip never creates the Antigravity folder'
  Assert-True ((Recipient $report 'claude').outcome -eq 'ok') '(a) Claude outcome ok'
  Assert-True ([IO.File]::ReadAllText((Join-Path $claude 'alpha\SKILL.md')).Contains('Targets fixture alpha')) '(a) delivered manifest reads back'

  # Turning a pack off for one tool removes only that link.
  $report = Invoke-Targets @('alpha', 'beta', 'gamma') @(
    [PSCustomObject]@{ id = 'workbuddy'; action = 'deliver'; path = $workbuddy; names = @('beta') }
  ) $presence
  Assert-True ((Linked $workbuddy) -join ',' -eq 'beta') '(a) WorkBuddy drops alpha when its target goes off'
  Assert-True (@((Recipient $report 'workbuddy').entries | Where-Object { $_.name -eq 'alpha' -and $_.state -eq 'removed' }).Count -eq 1) '(a) removal is reported'

  # (b) Release removes only SkillHub reparse points.
  $personal = Join-Path $workbuddy 'my-own'
  New-Item -ItemType Directory -Force -Path $personal | Out-Null
  [IO.File]::WriteAllText((Join-Path $personal 'SKILL.md'), 'User-owned fixture')
  $external = Join-Path $testRoot 'external-skill'
  New-Item -ItemType Directory -Force -Path $external | Out-Null
  [IO.File]::WriteAllText((Join-Path $external 'SKILL.md'), 'External fixture')
  New-Item -ItemType Junction -Path (Join-Path $workbuddy 'external-link') -Target $external | Out-Null
  $claudeBefore = Get-TreeHash $claude
  $report = Invoke-Targets @('alpha', 'beta', 'gamma') @(
    [PSCustomObject]@{ id = 'workbuddy'; action = 'release'; path = $workbuddy; names = @() }
  ) $presence
  Assert-True ((Recipient $report 'workbuddy').outcome -eq 'released') '(b) release outcome'
  Assert-True ((Linked $workbuddy) -join ',' -eq 'external-link') '(b) only SkillHub links are removed'
  Assert-True ([IO.File]::ReadAllText((Join-Path $personal 'SKILL.md')) -eq 'User-owned fixture') '(b) personal folder untouched'
  Assert-True ((Get-TreeHash $claude) -eq $claudeBefore) '(b) Claude is byte-identical'
  $missingRelease = Invoke-Targets @('alpha') @(
    [PSCustomObject]@{ id = 'cursor'; action = 'release'; path = $cursor; names = @() }
  )
  Assert-True (-not (Test-Path -LiteralPath $cursor)) '(b) releasing an absent folder never creates it'

  # (c) A same-name personal folder is a conflict: neither moved nor deleted.
  $clash = Join-Path $claude 'beta'
  New-Item -ItemType Directory -Force -Path $clash | Out-Null
  [IO.File]::WriteAllText((Join-Path $clash 'SKILL.md'), 'My own beta')
  $report = Invoke-Targets @('alpha', 'beta', 'gamma') @(
    [PSCustomObject]@{ id = 'claude'; action = 'deliver'; path = $claude; names = @('alpha', 'beta') }
  ) $presence
  $claudeResult = Recipient $report 'claude'
  Assert-True ($claudeResult.outcome -eq 'partial') '(c) conflict makes the recipient partial'
  Assert-True (@($claudeResult.entries | Where-Object { $_.name -eq 'beta' -and $_.state -eq 'conflict' -and $_.detail -eq 'personal-folder' }).Count -eq 1) '(c) conflict is reported'
  Assert-True ([IO.File]::ReadAllText((Join-Path $clash 'SKILL.md')) -eq 'My own beta') '(c) personal folder untouched'
  Assert-True (@(Get-ChildItem -LiteralPath $claude -Force -Directory | Where-Object Name -like 'AI_global*').Count -eq 0) '(c) no takeover backup folder'

  # (d) A union that matches nothing fails closed before any change.
  $before = (Get-TreeHash $claude) + (Get-TreeHash $workbuddy)
  $report = Invoke-Targets @('does-not-exist') @(
    [PSCustomObject]@{ id = 'claude'; action = 'deliver'; path = $claude; names = @('does-not-exist') }
  ) $presence
  Assert-True ($LastExit -ne 0) '(d) zero-intersection union exits non-zero'
  Assert-True (((Get-TreeHash $claude) + (Get-TreeHash $workbuddy)) -eq $before) '(d) nothing changed'
  $report = Invoke-Targets @('alpha') @(
    [PSCustomObject]@{ id = 'claude'; action = 'deliver'; path = $claude; names = @('beta') }
  ) $presence
  Assert-True ($LastExit -ne 0) '(d) a name outside the union exits non-zero'
  $report = Invoke-Targets @('alpha') @([PSCustomObject]@{ id = 'mystery-tool'; action = 'deliver'; path = $claude; names = @('alpha') })
  Assert-True ($LastExit -ne 0) '(d) an unknown recipient exits non-zero'
  Assert-True (((Get-TreeHash $claude) + (Get-TreeHash $workbuddy)) -eq $before) '(d) still nothing changed'

  # (e) Cursor and Gemini CLI need install evidence; with it they link and verify.
  $report = Invoke-Targets @('alpha', 'beta', 'gamma') @(
    [PSCustomObject]@{ id = 'cursor'; action = 'deliver'; path = $cursor; names = @('alpha') },
    [PSCustomObject]@{ id = 'gemini-cli'; action = 'deliver'; path = $gemini; names = @('alpha') }
  )
  Assert-True ((Recipient $report 'cursor').outcome -eq 'skipped-not-installed') '(e) Cursor without evidence is skipped'
  Assert-True ((Recipient $report 'gemini-cli').outcome -eq 'skipped-not-installed') '(e) Gemini CLI without evidence is skipped'
  Assert-True (-not (Test-Path -LiteralPath $cursor) -and -not (Test-Path -LiteralPath $gemini)) '(e) no folder was created'
  $report = Invoke-Targets @('alpha', 'beta', 'gamma') @(
    [PSCustomObject]@{ id = 'cursor'; action = 'deliver'; path = $cursor; names = @('alpha') },
    [PSCustomObject]@{ id = 'gemini-cli'; action = 'deliver'; path = $gemini; names = @('gamma') }
  ) @('-SimulateCursorPresent', '-SimulateGeminiPresent')
  Assert-True ((Recipient $report 'cursor').outcome -eq 'ok' -and (Linked $cursor) -join ',' -eq 'alpha') '(e) Cursor linked'
  Assert-True ((Recipient $report 'gemini-cli').outcome -eq 'ok' -and (Linked $gemini) -join ',' -eq 'gamma') '(e) Gemini CLI linked'
  Assert-True ([IO.File]::ReadAllText((Join-Path $cursor 'alpha\SKILL.md')).Contains('name: alpha')) '(e) Cursor manifest reads back'

  # (f) One failing recipient (external-link root) never blocks the others.
  $elsewhere = Join-Path $testRoot 'somebody-elses-skills'
  New-Item -ItemType Directory -Force -Path $elsewhere, (Split-Path -Parent $antigravity) | Out-Null
  New-Item -ItemType Junction -Path $antigravity -Target $elsewhere | Out-Null
  $report = Invoke-Targets @('alpha', 'beta', 'gamma') @(
    [PSCustomObject]@{ id = 'antigravity'; action = 'deliver'; path = $antigravity; names = @('alpha') },
    [PSCustomObject]@{ id = 'claude'; action = 'deliver'; path = $claude; names = @('alpha', 'gamma') }
  ) $presence
  Assert-True ($LastExit -eq 0) '(f) the script still exits 0'
  Assert-True ((Recipient $report 'antigravity').outcome -eq 'failed') '(f) external-link root is a recipient failure'
  Assert-True ((Recipient $report 'antigravity').error -like '*external link*') '(f) failure names the reason'
  Assert-True ((Linked $claude) -join ',' -eq 'alpha,gamma') '(f) Claude is still delivered'
  Assert-True (@(Get-ChildItem -LiteralPath $elsewhere -Force).Count -eq 0) '(f) the external folder was not written'

  # Releasing a tool whose root links elsewhere touches nothing and is not a
  # failure (a tool that is not taken over must never report a problem).
  [IO.File]::WriteAllText((Join-Path $elsewhere 'keep.txt'), 'external content')
  $report = Invoke-Targets @('alpha') @(
    [PSCustomObject]@{ id = 'antigravity'; action = 'release'; path = $antigravity; names = @() }
  ) $presence
  Assert-True ((Recipient $report 'antigravity').outcome -eq 'released') '(f) release of an external-link root is not a failure'
  Assert-True (((Get-Item -LiteralPath $antigravity -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) '(f) the external root link is kept'
  Assert-True ([IO.File]::ReadAllText((Join-Path $elsewhere 'keep.txt')) -eq 'external content') '(f) the external folder is untouched'

  # A path that is not the tool's real folder is refused per recipient.
  $report = Invoke-Targets @('alpha') @(
    [PSCustomObject]@{ id = 'claude'; action = 'deliver'; path = (Join-Path $testRoot 'not-claude'); names = @('alpha') }
  ) $presence
  Assert-True ((Recipient $report 'claude').outcome -eq 'failed' -and -not (Test-Path -LiteralPath (Join-Path $testRoot 'not-claude'))) 'mismatched recipient path is refused'

  # I-2 for the Codex legacy folder in shared mode: only the aliases SkillHub
  # makes (<name> -> .agents\skills\<name>, generated or gone) are SkillHub's.
  # A user's own link to a personal skill in .agents\skills is never removed.
  $agentsSkills = Join-Path $fixtureHome '.agents\skills'
  $legacyCodex = Join-Path $fixtureHome '.codex\skills'
  New-Item -ItemType Directory -Force -Path (Join-Path $agentsSkills 'mine'), (Join-Path $agentsSkills 'beta'), $legacyCodex | Out-Null
  [IO.File]::WriteAllText((Join-Path $agentsSkills 'mine\SKILL.md'), "---`nname: mine`ndescription: Personal.`n---")
  [IO.File]::WriteAllText((Join-Path $agentsSkills 'beta\SKILL.md'), "---`nname: beta`ndescription: Generated.`n---`n<!-- AI SkillHub shared-skill v1 sha256:00 -->`n")
  New-Item -ItemType Junction -Path (Join-Path $legacyCodex 'beta') -Target (Join-Path $agentsSkills 'beta') | Out-Null
  # An alias whose generated entry is already gone (Rust removed it first).
  New-Item -ItemType Directory -Force -Path (Join-Path $agentsSkills 'alpha') | Out-Null
  New-Item -ItemType Junction -Path (Join-Path $legacyCodex 'alpha') -Target (Join-Path $agentsSkills 'alpha') | Out-Null
  Remove-Item -LiteralPath (Join-Path $agentsSkills 'alpha') -Force
  New-Item -ItemType Junction -Path (Join-Path $legacyCodex 'mine') -Target (Join-Path $agentsSkills 'mine') | Out-Null
  New-Item -ItemType Junction -Path (Join-Path $legacyCodex 'my-alias') -Target (Join-Path $agentsSkills 'mine') | Out-Null
  $env:AI_SKILLHUB_REAL_SHARED_SKILLS = $agentsSkills
  $report = Invoke-Targets @('alpha', 'beta', 'gamma') @(
    [PSCustomObject]@{ id = 'codex-legacy'; action = 'deliver'; path = $legacyCodex; linkRoot = $agentsSkills; names = @('beta') }
  ) @('-SimulateCodexPresent')
  Assert-True ((Recipient $report 'codex-legacy').outcome -eq 'ok') 'legacy Codex deliver ok'
  Assert-True ((Linked $legacyCodex) -join ',' -eq 'beta,mine,my-alias') 'legacy Codex keeps personal links and drops only our stale alias'
  $report = Invoke-Targets @('alpha', 'beta', 'gamma') @(
    [PSCustomObject]@{ id = 'codex-legacy'; action = 'release'; path = $legacyCodex; linkRoot = $agentsSkills; names = @() }
  )
  Assert-True ((Recipient $report 'codex-legacy').outcome -eq 'released') 'legacy Codex release outcome'
  Assert-True ((Linked $legacyCodex) -join ',' -eq 'mine,my-alias') 'legacy Codex release keeps the user''s own links'
  Assert-True ([IO.File]::ReadAllText((Join-Path $agentsSkills 'mine\SKILL.md')).Contains('Personal.')) 'personal skill untouched'
  $env:AI_SKILLHUB_REAL_SHARED_SKILLS = ''

  # (g) Without the targets variable the 3.2.18 behaviour is unchanged.
  $env:AI_SKILLHUB_AGENT_SKILL_TARGETS = ''
  $legacyHome = Join-Path $testRoot 'legacy-home'
  New-Item -ItemType Directory -Force -Path (Join-Path $legacyHome '.claude') | Out-Null
  [IO.File]::WriteAllText((Join-Path $legacyHome '.claude\settings.json'), '{}')
  & $hostBinary -NoProfile -ExecutionPolicy Bypass -File $delivery -Quiet -HomePath $legacyHome | Out-Null
  Assert-True ($LASTEXITCODE -eq 0) '(g) legacy mode exits 0'
  Assert-True ((Linked (Join-Path $legacyHome '.claude\skills')) -join ',' -eq 'alpha,beta,gamma') '(g) legacy mode delivers every active Skill'

  Write-Output 'PASS: (a) per-recipient names, (b) release only managed links, (c) conflicts preserved without backup, (d) fail-closed policy, (e) Cursor/Gemini presence + read-back, (f) per-recipient failure with exit 0, (g) legacy mode unchanged.'
} finally {
  foreach ($key in $previous.Keys) { [Environment]::SetEnvironmentVariable($key, $previous[$key], 'Process') }
  if (Test-Path -LiteralPath $testRoot) {
    foreach ($link in @(Get-ChildItem -LiteralPath $testRoot -Recurse -Directory -Force -ErrorAction SilentlyContinue | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })) { [IO.Directory]::Delete($link.FullName) }
    Remove-Item -LiteralPath $testRoot -Recurse -Force
  }
}
