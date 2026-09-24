[CmdletBinding()]
param(
  [string]$ExecutablePath = '',
  [string]$NodeExecutable = (Get-Command node.exe).Source,
  [string]$NodeModulesPath = 'C:\Users\Francis\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\node_modules'
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$appNext = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
if ([string]::IsNullOrWhiteSpace($ExecutablePath)) { $ExecutablePath = Join-Path (Split-Path -Parent $appNext) 'AI SkillHub.exe' }
$exe = [IO.Path]::GetFullPath($ExecutablePath)
if ((Get-Item -LiteralPath $exe).VersionInfo.ProductVersion -ne '3.2.6') { throw 'Expected a built v3.2.6 executable.' }
$runId = [Guid]::NewGuid().ToString('N')
$qaRoot = [IO.Path]::GetFullPath((Join-Path $env:TEMP "SkillHub-v3.2.6-real-ipc-$runId"))
$tempPrefix = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
if (-not $qaRoot.StartsWith($tempPrefix, [StringComparison]::OrdinalIgnoreCase)) { throw 'QA path escaped TEMP.' }
$data = Join-Path $qaRoot 'data'
$profile = Join-Path $qaRoot 'profile'
$project = Join-Path $qaRoot 'project'
$runtime = Join-Path $project 'app-next\runtime'
$report = Join-Path $appNext "reports\desktop\v3.2.6-real-ipc\$runId.json"
$directories = @($data, $profile, $runtime, (Join-Path $profile 'AppData\Local'), (Join-Path $profile 'AppData\Roaming'), (Split-Path -Parent $report))
foreach ($directory in $directories) { New-Item -ItemType Directory -Path $directory -Force | Out-Null }
$originalExe = $exe
$exe = Join-Path $qaRoot 'AI SkillHub.exe'
Copy-Item -LiteralPath $originalExe -Destination $exe
foreach ($file in @('SkillHub.ps1','Manage-AgentSkillLinks.ps1','Export-SkillHubDiagnostics.ps1','skillhub.config.example.json')) {
  Copy-Item -LiteralPath (Join-Path $appNext "runtime\$file") -Destination (Join-Path $runtime $file)
}
$utf8 = [Text.UTF8Encoding]::new($false)
$skillText = "---`nname: qa-review`ndescription: Isolated desktop IPC review fixture.`n---`n# Fixture`nOnly inspect the supplied text.`n"
foreach ($name in @('qa-duplicate', 'qa--duplicate')) {
  $source = Join-Path $data "sources\$name"
  New-Item -ItemType Directory -Path (Join-Path $source '.git') -Force | Out-Null
  [IO.File]::WriteAllText((Join-Path $source 'SKILL.md'), $skillText, $utf8)
  [IO.File]::WriteAllText((Join-Path $source '.git\config'), "[remote `"origin`"]`n url = https://github.com/skillhub-qa/identical-fixture.git`n", $utf8)
}
$prompt = Join-Path $data 'sources\qa-prompt'
New-Item -ItemType Directory -Path $prompt -Force | Out-Null
[IO.File]::WriteAllText((Join-Path $prompt 'README.md'), "# QA Prompt`n`nPRIVATE_FIXTURE_PROMPT_ORIGINAL. Read the user's text and summarize it.`n", $utf8)
[IO.File]::WriteAllText((Join-Path $prompt 'program.md'), "# Instructions`nUse the supplied text only. No scripts or networking are needed.`n", $utf8)
[IO.File]::WriteAllText((Join-Path $data 'skillhub.config.json'), ([ordered]@{version=3;activeSkillsFolder=(Join-Path $data 'skills');githubSourcesFolder=(Join-Path $data 'sources');autoDiscoverManualRepos=$true;manageAgentLinks=$false;repositories=@()} | ConvertTo-Json -Depth 5), $utf8)

$listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$listener.Start(); $port = ([Net.IPEndPoint]$listener.LocalEndpoint).Port; $listener.Stop()
$environment = @{
  AI_SKILLHUB_ROOT=$project; AI_SKILLHUB_DATA_ROOT=$data; AI_SKILLHUB_QA_ROOT=$qaRoot; AI_SKILLHUB_QA_DATA_ROOT=$data;
  AI_SKILLHUB_ACTIVE_SKILLS=(Join-Path $data 'skills'); AI_SKILLHUB_SOURCES=(Join-Path $data 'sources');
  AI_SKILLHUB_CONFIG_PATH=(Join-Path $data 'skillhub.config.json'); AI_SKILLHUB_STATE=(Join-Path $data 'state'); AI_SKILLHUB_REPORTS=(Join-Path $data 'reports');
  AI_SKILLHUB_CDP_URL="http://127.0.0.1:$port"; AI_SKILLHUB_QA_REPORT=$report;
  AI_SKILLHUB_EXPECTED_EXE_PATH=$exe; AI_SKILLHUB_EXPECTED_EXE_SHA256=(Get-FileHash -LiteralPath $exe -Algorithm SHA256).Hash.ToLowerInvariant();
  USERPROFILE=$profile; HOME=$profile; APPDATA=(Join-Path $profile 'AppData\Roaming'); LOCALAPPDATA=(Join-Path $profile 'AppData\Local');
  CLAUDE_CONFIG_DIR=(Join-Path $profile '.claude'); CODEX_HOME=(Join-Path $profile '.codex'); XDG_CONFIG_HOME=(Join-Path $profile '.config');
  WEBVIEW2_USER_DATA_FOLDER=(Join-Path $qaRoot 'webview2'); WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--remote-debugging-port=$port";
  NODE_PATH=$NodeModulesPath
}
$previous = @{}
$app = $null
try {
  foreach ($key in $environment.Keys) { $previous[$key]=[Environment]::GetEnvironmentVariable($key,'Process'); [Environment]::SetEnvironmentVariable($key,$environment[$key],'Process') }
  $probe = & powershell.exe -NoProfile -Command '[Console]::WriteLine($HOME)'
  if ($probe.Trim() -ne $profile) { throw 'PowerShell HOME did not follow the isolated profile; refusing to launch.' }
  $app = Start-Process -FilePath $exe -WindowStyle Hidden -PassThru
  $processPath = (Get-Process -Id $app.Id).Path
  if (-not [string]::Equals([IO.Path]::GetFullPath($processPath),$exe,[StringComparison]::OrdinalIgnoreCase)) { throw 'Executable identity mismatch.' }
  $previous['AI_SKILLHUB_EXPECTED_PID']=[Environment]::GetEnvironmentVariable('AI_SKILLHUB_EXPECTED_PID','Process')
  [Environment]::SetEnvironmentVariable('AI_SKILLHUB_EXPECTED_PID',$app.Id.ToString(),'Process')
  $connection = $null
  for ($attempt=0; $attempt -lt 120; $attempt++) {
    $connection = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($connection) { break }
    if ($app.HasExited) { throw 'QA app exited before CDP was ready.' }
    Start-Sleep -Milliseconds 250
  }
  if (-not $connection) { throw 'Isolated app did not start its CDP endpoint.' }
  $parents=@{}; Get-CimInstance Win32_Process | ForEach-Object { $parents[[int]$_.ProcessId]=[int]$_.ParentProcessId }
  $ancestor=[int]$connection.OwningProcess; $owned=$false
  for ($depth=0; $depth -lt 20 -and $ancestor -gt 0; $depth++) {
    if ($ancestor -eq $app.Id) { $owned=$true; break }
    if (-not $parents.ContainsKey($ancestor)) { break }; $ancestor=$parents[$ancestor]
  }
  if (-not $owned) { throw 'CDP endpoint is not owned by the launched executable.' }
  & $NodeExecutable (Join-Path $PSScriptRoot 'v3.2.6-real-ipc-qa.cjs')
  if ($LASTEXITCODE -ne 0) { throw "Real IPC QA failed; isolated fixtures retained at $qaRoot" }
} finally {
  if ($app -and -not $app.HasExited) {
    $actual = Get-Process -Id $app.Id -ErrorAction SilentlyContinue
    if ($actual -and [string]::Equals([IO.Path]::GetFullPath($actual.Path),$exe,[StringComparison]::OrdinalIgnoreCase)) { Stop-Process -Id $app.Id -Force }
  }
  foreach ($key in $previous.Keys) { [Environment]::SetEnvironmentVariable($key,$previous[$key],'Process') }
}
[pscustomobject]@{Report=$report;IsolatedRoot=$qaRoot;Executable=$exe} | ConvertTo-Json
