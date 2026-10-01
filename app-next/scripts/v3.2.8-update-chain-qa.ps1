[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][string]$ExecutablePath,
  [string]$NodeExecutable = (Get-Command node.exe).Source,
  [string]$NodeModulesPath = 'C:\Users\Francis\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'
)
# Full-chain update check against the real compiled app, in a TEMP sandbox:
# upstream adds a Skill -> "Update all sources" -> file on disk -> SQLite ->
# parent router -> the path a (simulated) Claude Code install would open.
# Nothing outside the sandbox is read or written; the upstream is a local
# file:// repository, so no network is used.
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$appNext = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$exeSource = [IO.Path]::GetFullPath($ExecutablePath)
$runId = [Guid]::NewGuid().ToString('N').Substring(0, 12)
$qaRoot = [IO.Path]::GetFullPath((Join-Path $env:TEMP "SkillHub-update-chain-$runId"))
$tempPrefix = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
if (-not $qaRoot.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'QA path escaped TEMP.' }
$data = Join-Path $qaRoot 'data'
$profile = Join-Path $qaRoot 'profile'
$project = Join-Path $qaRoot 'project'
$runtime = Join-Path $project 'app-next\runtime'
$upstream = Join-Path $qaRoot 'upstream'
$sources = Join-Path $data 'sources'
$consumerName = 'qa-owner--chain-repo'
$consumer = Join-Path $sources $consumerName
$report = Join-Path $appNext "reports\desktop\v3.2.8-update-chain\$runId.json"
foreach ($directory in @($data, $profile, $runtime, $upstream, $sources, (Join-Path $profile 'AppData\Local'), (Join-Path $profile 'AppData\Roaming'), (Join-Path $profile '.claude'), (Split-Path -Parent $report))) {
  New-Item -ItemType Directory -Path $directory -Force | Out-Null
}
$exe = Join-Path $qaRoot 'AI SkillHub.exe'
Copy-Item -LiteralPath $exeSource -Destination $exe
foreach ($file in @('SkillHub.ps1', 'Manage-AgentSkillLinks.ps1', 'Export-SkillHubDiagnostics.ps1', 'skillhub.config.example.json')) {
  Copy-Item -LiteralPath (Join-Path $appNext "runtime\$file") -Destination (Join-Path $runtime $file)
}
$utf8 = [Text.UTF8Encoding]::new($false)
function Write-Fixture([string]$Path, [string]$Text) {
  New-Item -ItemType Directory -Path (Split-Path -Parent $Path) -Force | Out-Null
  [IO.File]::WriteAllText($Path, $Text, $utf8)
}
function Invoke-FixtureGit([string]$Directory, [string[]]$Arguments) {
  $all = @('-C', $Directory, '-c', 'user.name=SkillHub QA', '-c', 'user.email=qa@example.invalid', '-c', 'core.autocrlf=false') + $Arguments
  $output = & git @all 2>&1
  if ($LASTEXITCODE -ne 0) { throw "git $($Arguments -join ' ') failed: $output" }
}
function Skill-Text([string]$Name, [string]$Extra = '') {
  return "---`nname: $Name`ndescription: Isolated update-chain fixture $Name.`n---`n# $Name`nUse only supplied text. $Extra`n"
}

# Upstream repository with one Skill and one shared helper folder.
Invoke-FixtureGit $upstream @('init', '-q', '-b', 'main')
Invoke-FixtureGit $upstream @('config', 'uploadpack.allowFilter', 'true')
Invoke-FixtureGit $upstream @('config', 'uploadpack.allowAnySHA1InWant', 'true')
Write-Fixture (Join-Path $upstream 'README.md') 'Update-chain fixture.'
Write-Fixture (Join-Path $upstream 'skills\chain-alpha\SKILL.md') (Skill-Text 'chain-alpha')
Write-Fixture (Join-Path $upstream 'skills\shared\contract.md') 'Shared contract used by later Skills.'
Write-Fixture (Join-Path $upstream 'docs\big.md') 'Outside every Skill; must stay out of the sparse checkout.'
Invoke-FixtureGit $upstream @('add', '-A')
Invoke-FixtureGit $upstream @('commit', '-q', '-m', 'initial')

# Consumer exactly as the importer leaves it: partial clone + Skill-only cone.
$upstreamUrl = 'file:///' + ($upstream -replace '\\', '/')
Invoke-FixtureGit $sources @('clone', '-q', '--filter=blob:none', '--no-checkout', '--no-tags', $upstreamUrl, $consumerName)
Invoke-FixtureGit $consumer @('sparse-checkout', 'set', '--cone', 'skills/chain-alpha')
Invoke-FixtureGit $consumer @('checkout', '-q', 'main')
if (-not (Test-Path -LiteralPath (Join-Path $consumer 'skills\chain-alpha\SKILL.md'))) { throw 'Consumer fixture did not materialize chain-alpha.' }
if (Test-Path -LiteralPath (Join-Path $consumer 'docs\big.md')) { throw 'Consumer fixture is not sparse.' }

# A different author ships a child with the same name: both must coexist.
Write-Fixture (Join-Path $sources 'qa-other--twin-pack\skills\chain-alpha\SKILL.md') (Skill-Text 'chain-alpha' 'Twin from another author.')
Write-Fixture (Join-Path $sources 'qa-other--twin-pack\skills\twin-extra\SKILL.md') (Skill-Text 'twin-extra')

# Simulated Claude Code presence inside the isolated profile only.
Write-Fixture (Join-Path $profile '.claude\settings.json') '{}'
[IO.File]::WriteAllText((Join-Path $data 'skillhub.config.json'), ([ordered]@{version=3;activeSkillsFolder=(Join-Path $data 'skills');githubSourcesFolder=$sources;autoDiscoverManualRepos=$true;manageAgentLinks=$false;repositories=@()} | ConvertTo-Json -Depth 5), $utf8)

$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start(); $port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port; $listener.Stop()
$environment = @{
  AI_SKILLHUB_ROOT=$project; AI_SKILLHUB_DATA_ROOT=$data; AI_SKILLHUB_QA_ROOT=$qaRoot; AI_SKILLHUB_QA_DATA_ROOT=$data;
  AI_SKILLHUB_ACTIVE_SKILLS=(Join-Path $data 'skills'); AI_SKILLHUB_SOURCES=$sources;
  AI_SKILLHUB_CONFIG_PATH=(Join-Path $data 'skillhub.config.json'); AI_SKILLHUB_STATE=(Join-Path $data 'state'); AI_SKILLHUB_REPORTS=(Join-Path $data 'reports');
  AI_SKILLHUB_CDP_URL="http://127.0.0.1:$port"; AI_SKILLHUB_QA_REPORT=$report;
  AI_SKILLHUB_QA_UPSTREAM=$upstream; AI_SKILLHUB_QA_CONSUMER=$consumer;
  AI_SKILLHUB_EXPECTED_EXE_PATH=$exe; AI_SKILLHUB_EXPECTED_EXE_SHA256=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant();
  USERPROFILE=$profile; HOME=$profile; APPDATA=(Join-Path $profile 'AppData\Roaming'); LOCALAPPDATA=(Join-Path $profile 'AppData\Local');
  CLAUDE_CONFIG_DIR=(Join-Path $profile '.claude'); CODEX_HOME=(Join-Path $profile '.codex'); XDG_CONFIG_HOME=(Join-Path $profile '.config');
  WEBVIEW2_USER_DATA_FOLDER=(Join-Path $qaRoot 'webview2'); WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=$port --no-proxy-server --host-resolver-rules=`"MAP vibecafe.ai ~NOTFOUND`"";
  NODE_PATH=$NodeModulesPath
}
$previous = @{}
$app = $null
try {
  foreach ($key in $environment.Keys) { $previous[$key]=[Environment]::GetEnvironmentVariable($key,'Process'); [Environment]::SetEnvironmentVariable($key,$environment[$key],'Process') }
  $probe = & powershell.exe -NoProfile -Command '[Console]::WriteLine($HOME)'
  if ($probe.Trim() -ne $profile) { throw 'PowerShell HOME did not follow the isolated profile; refusing to launch.' }
  $app = Start-Process -FilePath $exe -WindowStyle Hidden -PassThru
  [Environment]::SetEnvironmentVariable('AI_SKILLHUB_EXPECTED_PID', $app.Id.ToString(), 'Process')
  $connection = $null
  for ($attempt = 0; $attempt -lt 120; $attempt++) {
    $connection = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($connection) { break }
    if ($app.HasExited) { throw 'QA app exited before CDP was ready.' }
    Start-Sleep -Milliseconds 250
  }
  if (-not $connection) { throw 'Isolated app did not start its CDP endpoint.' }
  & $NodeExecutable (Join-Path $PSScriptRoot 'v3.2.8-update-chain-qa.cjs')
  if ($LASTEXITCODE -ne 0) { throw "Update-chain QA failed; isolated fixtures retained at $qaRoot" }
  $passed = $true
} finally {
  if ($app -and -not $app.HasExited) {
    $actual = Get-Process -Id $app.Id -ErrorAction SilentlyContinue
    if ($actual -and [string]::Equals([IO.Path]::GetFullPath($actual.Path), $exe, [StringComparison]::OrdinalIgnoreCase)) { Stop-Process -Id $app.Id -Force }
  }
  foreach ($key in $previous.Keys) { [Environment]::SetEnvironmentVariable($key, $previous[$key], 'Process') }
  [Environment]::SetEnvironmentVariable('AI_SKILLHUB_EXPECTED_PID', $null, 'Process')
}
if ((Get-Variable -Name passed -ErrorAction SilentlyContinue) -and $passed) {
  # Evidence lives in $report; the sandbox itself is disposable after a pass.
  for ($attempt = 0; $attempt -lt 10 -and (Test-Path -LiteralPath $qaRoot); $attempt++) {
    try { Remove-Item -LiteralPath $qaRoot -Recurse -Force -ErrorAction Stop } catch { Start-Sleep -Milliseconds 500 }
  }
}
[pscustomobject]@{ Report = $report; IsolatedRoot = $qaRoot; Executable = $exe } | ConvertTo-Json
