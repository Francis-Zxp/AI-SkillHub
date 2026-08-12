[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
$workspaceRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$runtimeScript = Join-Path $workspaceRoot 'runtime\SkillHub.ps1'
$tempBase = [IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\') + '\'
$fixtureRoot = [IO.Path]::GetFullPath((Join-Path ([IO.Path]::GetTempPath()) ('skillhub-sync-resilience-' + [guid]::NewGuid().ToString('N'))))
if (-not $fixtureRoot.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing fixture outside TEMP: $fixtureRoot"
}

function Write-TestText([string]$Path, [string]$Text) {
  $parent = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  [IO.File]::WriteAllText($Path, $Text, [Text.UTF8Encoding]::new($false))
}

function Write-TestConfig([string]$Path, [string]$Sources, [string]$Active) {
  $config = [ordered]@{
    version = 3
    githubSourcesFolder = $Sources
    activeSkillsFolder = $Active
    manageAgentLinks = $false
    autoDiscoverManualRepos = $true
    preferredPathFragments = @('\skills\', '\.agents\skills\')
    repositories = @()
  }
  Write-TestText $Path ($config | ConvertTo-Json -Depth 8)
}

function Join-TestArguments([string[]]$Arguments) {
  (($Arguments | ForEach-Object {
    if ($_ -match '[\s"]') {
      '"' + ($_ -replace '"', '\"') + '"'
    } else {
      $_
    }
  }) -join ' ')
}

function Invoke-SyncFixture(
  [string]$Engine,
  [string]$ConfigPath,
  [string]$StatePath,
  [string]$ReportsPath,
  [string]$FakeGitBin,
  [switch]$NoPull
) {
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $runtimeScript)
  if ($NoPull) { $arguments += '-NoPull' }
  $arguments += @('-GitCommandTimeoutSeconds', '1', '-GitUpdateBudgetSeconds', '30')

  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $Engine
  $startInfo.Arguments = Join-TestArguments $arguments
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.CreateNoWindow = $true
  $startInfo.EnvironmentVariables['AI_SKILLHUB_CONFIG_PATH'] = $ConfigPath
  $startInfo.EnvironmentVariables['AI_SKILLHUB_STATE'] = $StatePath
  $startInfo.EnvironmentVariables['AI_SKILLHUB_REPORTS'] = $ReportsPath
  if (-not [string]::IsNullOrWhiteSpace($FakeGitBin)) {
    $startInfo.EnvironmentVariables['PATH'] = $FakeGitBin + ';' + $startInfo.EnvironmentVariables['PATH']
  }

  $process = [Diagnostics.Process]::Start($startInfo)
  if ($null -eq $process) { throw "Could not start test engine: $Engine" }
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit(45000)) {
    try { $process.Kill() } catch {}
    throw "Sync fixture timed out under $Engine"
  }
  $result = [PSCustomObject]@{
    ExitCode = $process.ExitCode
    Stdout = [string]$stdoutTask.Result
    Stderr = [string]$stderrTask.Result
  }
  $process.Dispose()
  return $result
}

function New-FakeGit([string]$Root) {
  $bin = Join-Path $Root 'fake-git'
  $sourcePath = Join-Path $bin 'FakeGit.cs'
  $exePath = Join-Path $bin 'git.exe'
  New-Item -ItemType Directory -Force -Path $bin | Out-Null
  Write-TestText $sourcePath @'
using System;
using System.Threading;

public static class FakeGit
{
    public static int Main(string[] args)
    {
        string command = string.Join(" ", args ?? new string[0]);
        if (command.IndexOf(" status ", StringComparison.OrdinalIgnoreCase) >= 0)
        {
            if (command.IndexOf("dirty-repo", StringComparison.OrdinalIgnoreCase) >= 0)
                Console.WriteLine(" M local-preserved.txt");
            return 0;
        }
        if (command.IndexOf(" pull ", StringComparison.OrdinalIgnoreCase) >= 0)
        {
            if (command.IndexOf("timeout-repo", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                Thread.Sleep(5000);
                Console.WriteLine("late success");
                return 0;
            }
            if (command.IndexOf("failed-repo", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                Console.Error.WriteLine("simulated pull failure");
                return 1;
            }
            Console.WriteLine("Already up to date.");
            return 0;
        }
        return 0;
    }
}
'@

  $cscCandidates = @(
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'),
    (Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe')
  )
  $csc = @($cscCandidates | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1)
  if ($csc.Count -ne 1) { throw 'The .NET Framework C# compiler is required for the isolated fake-git fixture.' }
  $compileOutput = & $csc[0] /nologo /target:exe "/out:$exePath" $sourcePath 2>&1
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $exePath -PathType Leaf)) {
    throw "Could not compile isolated fake git: $($compileOutput -join ' ')"
  }
  return $bin
}

function New-ManualRepo([string]$Sources, [string]$Name) {
  $repo = Join-Path $Sources $Name
  $skill = Join-Path $repo 'skills\child'
  New-Item -ItemType Directory -Force -Path (Join-Path $repo '.git'), $skill | Out-Null
  Write-TestText (Join-Path $repo '.git\HEAD') ('1' * 40)
  Write-TestText (Join-Path $skill 'SKILL.md') ("---`nname: $Name-child`ndescription: Isolated sync fixture.`n---`n`n# Fixture`n")
  return $repo
}

function Invoke-AtomicWriteFailureProbe([string]$Engine, [string]$Destination) {
  Write-TestText $Destination 'preserve-original-state'
  $destinationDirectory = Split-Path -Parent $Destination
  $lockedTemp = $Destination + '.skillhub-tmp'
  New-Item -ItemType Directory -Force -Path $lockedTemp | Out-Null
  $probe = @'
$ErrorActionPreference = 'Stop'
$functionText = [IO.File]::ReadAllText($env:SKILLHUB_RUNTIME_PROBE, [Text.Encoding]::UTF8)
$match = [regex]::Match($functionText, '(?s)function Write-Utf8Bom\(.*?\n\}')
if (-not $match.Success) { throw 'Write-Utf8Bom function was not found.' }
. ([scriptblock]::Create($match.Value))
try {
  Write-Utf8Bom $env:SKILLHUB_DESTINATION_PROBE 'replacement-state'
  throw 'Atomic write unexpectedly succeeded with a locked temp path.'
} catch {
  if (-not (Test-Path -LiteralPath $env:SKILLHUB_DESTINATION_PROBE -PathType Leaf)) {
    throw 'Atomic write failure removed the original destination.'
  }
  $preserved = [IO.File]::ReadAllText($env:SKILLHUB_DESTINATION_PROBE, [Text.Encoding]::UTF8)
  if ($preserved -ne 'preserve-original-state') {
    throw "Atomic write failure changed the original destination: $preserved"
  }
}
'@
  $probePath = Join-Path $destinationDirectory 'atomic-write-probe.ps1'
  Write-TestText $probePath $probe
  $startInfo = [Diagnostics.ProcessStartInfo]::new()
  $startInfo.FileName = $Engine
  $startInfo.Arguments = Join-TestArguments @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $probePath)
  $startInfo.UseShellExecute = $false
  $startInfo.RedirectStandardOutput = $true
  $startInfo.RedirectStandardError = $true
  $startInfo.CreateNoWindow = $true
  $startInfo.EnvironmentVariables['SKILLHUB_RUNTIME_PROBE'] = $runtimeScript
  $startInfo.EnvironmentVariables['SKILLHUB_DESTINATION_PROBE'] = $Destination
  $process = [Diagnostics.Process]::Start($startInfo)
  if ($null -eq $process) { throw "Could not start atomic write probe under $Engine" }
  $stdoutTask = $process.StandardOutput.ReadToEndAsync()
  $stderrTask = $process.StandardError.ReadToEndAsync()
  if (-not $process.WaitForExit(30000)) {
    try { $process.Kill() } catch {}
    throw "Atomic write probe timed out under $Engine"
  }
  $stderr = [string]$stderrTask.Result
  if ($process.ExitCode -ne 0) {
    throw "Atomic write failure recovery failed under $Engine`: $stderr"
  }
  $process.Dispose()
}

try {
  New-Item -ItemType Directory -Force -Path $fixtureRoot | Out-Null
  $fakeGitBin = New-FakeGit $fixtureRoot
  $windowsPowerShell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $engines = [Collections.Generic.List[string]]::new()
  if (Test-Path -LiteralPath $windowsPowerShell) { $engines.Add($windowsPowerShell) | Out-Null }
  $pwsh = Get-Command pwsh.exe -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($pwsh -and -not $engines.Contains($pwsh.Source)) { $engines.Add($pwsh.Source) | Out-Null }
  if ($engines.Count -eq 0) { throw 'No PowerShell engine is available for sync resilience testing.' }

  foreach ($engine in $engines) {
    $engineLabel = [IO.Path]::GetFileNameWithoutExtension($engine)

    Invoke-AtomicWriteFailureProbe $engine (Join-Path $fixtureRoot "atomic-$engineLabel\managed-links.json")

    # Regression 1: an old zero-byte managed state plus an empty source library
    # must repair to valid [] JSON and remain repeatable.
    $emptyRoot = Join-Path $fixtureRoot "empty-$engineLabel"
    $emptySources = Join-Path $emptyRoot 'sources'
    $emptyActive = Join-Path $emptyRoot 'active'
    $emptyState = Join-Path $emptyRoot 'state'
    $emptyReports = Join-Path $emptyRoot 'reports'
    New-Item -ItemType Directory -Force -Path $emptySources, $emptyActive, (Join-Path $emptyState 'sync-state'), $emptyReports | Out-Null
    $emptyConfig = Join-Path $emptyRoot 'skillhub.config.json'
    Write-TestConfig $emptyConfig $emptySources $emptyActive
    Write-TestText (Join-Path $emptyState 'sync-state\managed-links.json') ''

    1..2 | ForEach-Object {
      $result = Invoke-SyncFixture $engine $emptyConfig $emptyState $emptyReports $fakeGitBin -NoPull
      if ($result.ExitCode -ne 0) {
        throw "$engineLabel empty-library sync failed: $($result.Stderr)"
      }
      $managedJson = [IO.File]::ReadAllText((Join-Path $emptyState 'sync-state\managed-links.json'), [Text.Encoding]::UTF8).Trim()
      if ($managedJson -notmatch '^\[\s*\]$') {
        throw "$engineLabel did not persist an empty managed state as a valid JSON array: $managedJson"
      }
      $emptySummary = Get-Content -LiteralPath (Join-Path $emptyReports 'last-sync.json') -Raw | ConvertFrom-Json
      if ($emptySummary.status -ne 'no-network-update' -or $emptySummary.total -ne 0 -or $emptySummary.activeSkills -ne 0) {
        throw "$engineLabel reported an inaccurate empty-library summary."
      }
      if (@($emptySummary.repositories).Count -ne 0) { throw "$engineLabel did not persist repositories as []." }
    }

    # Regression 2: one success, one dirty tree, one failure and one timeout
    # must finish as a partial sync without changing or removing source trees.
    $updateRoot = Join-Path $fixtureRoot "updates-$engineLabel"
    $updateSources = Join-Path $updateRoot 'sources'
    $updateActive = Join-Path $updateRoot 'active'
    $updateState = Join-Path $updateRoot 'state'
    $updateReports = Join-Path $updateRoot 'reports'
    New-Item -ItemType Directory -Force -Path $updateSources, $updateActive, (Join-Path $updateState 'sync-state'), $updateReports | Out-Null
    foreach ($repoName in @('ok-repo', 'dirty-repo', 'failed-repo', 'timeout-repo')) {
      $null = New-ManualRepo $updateSources $repoName
    }
    $dirtyMarker = Join-Path $updateSources 'dirty-repo\local-preserved.txt'
    Write-TestText $dirtyMarker 'must survive sync'
    $brokenRouterTarget = Join-Path $updateSources 'AI-SkillHub-local-routers\removed-parent'
    $brokenActiveLink = Join-Path $updateActive 'removed-parent'
    New-Item -ItemType Directory -Force -Path $brokenRouterTarget | Out-Null
    New-Item -ItemType Junction -Path $brokenActiveLink -Target $brokenRouterTarget | Out-Null
    $updateConfig = Join-Path $updateRoot 'skillhub.config.json'
    Write-TestConfig $updateConfig $updateSources $updateActive
    Write-TestText (Join-Path $updateState 'sync-state\managed-links.json') ''

    $result = Invoke-SyncFixture $engine $updateConfig $updateState $updateReports $fakeGitBin
    if ($result.ExitCode -ne 0) {
      throw "$engineLabel partial update fixture failed as a batch: $($result.Stderr)"
    }
    $summary = Get-Content -LiteralPath (Join-Path $updateReports 'last-sync.json') -Raw | ConvertFrom-Json
    if ($summary.status -ne 'partial' -or $summary.total -ne 4 -or $summary.succeeded -ne 1 -or $summary.failed -ne 2 -or $summary.skipped -ne 1) {
      throw "$engineLabel partial summary is inaccurate: $($summary | ConvertTo-Json -Compress)"
    }
    $statuses = @{}
    foreach ($repo in @($summary.repositories)) { $statuses[[string]$repo.Repository] = [string]$repo.Status }
    if ($statuses['ok-repo'] -ne 'ok' -or
        $statuses['dirty-repo'] -ne 'dirty-blocked' -or
        $statuses['failed-repo'] -ne 'failed' -or
        $statuses['timeout-repo'] -ne 'timeout') {
      throw "$engineLabel repository outcomes were not preserved accurately."
    }
    if (([IO.File]::ReadAllText($dirtyMarker, [Text.Encoding]::UTF8)) -ne 'must survive sync') {
      throw "$engineLabel changed dirty local content."
    }
    if (Test-Path -LiteralPath $brokenActiveLink) {
      throw "$engineLabel left a broken managed source junction in the active catalog."
    }
    foreach ($repoName in @('ok-repo', 'dirty-repo', 'failed-repo', 'timeout-repo')) {
      if (-not (Test-Path -LiteralPath (Join-Path $updateSources $repoName) -PathType Container)) {
        throw "$engineLabel removed source repository $repoName."
      }
    }

    Write-Host "PASS: $engineLabel handles empty state, no sources, dirty work, pull failure and timeout without a batch exception."
  }
} finally {
  if (Test-Path -LiteralPath $fixtureRoot) {
    $resolved = [IO.Path]::GetFullPath($fixtureRoot)
    if (-not $resolved.StartsWith($tempBase, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing cleanup outside TEMP: $resolved"
    }
    Remove-Item -LiteralPath $resolved -Recurse -Force
  }
}
