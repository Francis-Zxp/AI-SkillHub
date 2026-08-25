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

function Write-TestConfig(
  [string]$Path,
  [string]$Sources,
  [string]$Active,
  [object[]]$Repositories = @()
) {
  $config = [ordered]@{
    version = 3
    githubSourcesFolder = $Sources
    activeSkillsFolder = $Active
    manageAgentLinks = $false
    autoDiscoverManualRepos = $true
    preferredPathFragments = @('\skills\', '\.agents\skills\')
    repositories = @($Repositories)
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
  [switch]$NoPull,
  [int]$GitUpdateBudgetSeconds = 30
) {
  $arguments = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $runtimeScript)
  if ($NoPull) { $arguments += '-NoPull' }
  $arguments += @('-GitCommandTimeoutSeconds', '1', '-GitUpdateBudgetSeconds', [string]$GitUpdateBudgetSeconds)

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
  $runStopwatch = [Diagnostics.Stopwatch]::StartNew()
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
    ElapsedSeconds = $runStopwatch.Elapsed.TotalSeconds
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
            if (command.IndexOf("config-slow", StringComparison.OrdinalIgnoreCase) >= 0)
                Thread.Sleep(1500);
            if (command.IndexOf("dirty-repo", StringComparison.OrdinalIgnoreCase) >= 0)
                Console.WriteLine(" M local-preserved.txt");
            // AI SkillHub's own untracked bookkeeping must not look like user work,
            // or every source the app has touched stops tracking GitHub forever.
            if (command.IndexOf("metadata-only-repo", StringComparison.OrdinalIgnoreCase) >= 0)
            {
                Console.WriteLine("?? .skillhub-source.json");
                Console.WriteLine("?? .skillhub-extracted/");
            }
            // A tracked file of the same name belongs to the upstream repository,
            // so a real change to it must still block the pull.
            if (command.IndexOf("tracked-metadata-repo", StringComparison.OrdinalIgnoreCase) >= 0)
                Console.WriteLine(" M .skillhub-source.json");
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

    # Regression 2: a timeout at the start of one complete manual-attempt budget
    # must persist the first deferred source as the next start. The following run
    # therefore updates that source instead of starving the alphabetical tail.
    $rotationRoot = Join-Path $fixtureRoot "rotation-$engineLabel"
    $rotationSources = Join-Path $rotationRoot 'sources'
    $rotationActive = Join-Path $rotationRoot 'active'
    $rotationState = Join-Path $rotationRoot 'state'
    $rotationReports = Join-Path $rotationRoot 'reports'
    New-Item -ItemType Directory -Force -Path $rotationSources, $rotationActive, (Join-Path $rotationState 'sync-state'), $rotationReports | Out-Null
    foreach ($repoName in @('a-timeout-repo', 'b-ok-repo', 'c-ok-repo')) {
      $null = New-ManualRepo $rotationSources $repoName
    }
    $rotationConfig = Join-Path $rotationRoot 'skillhub.config.json'
    Write-TestConfig $rotationConfig $rotationSources $rotationActive
    Write-TestText (Join-Path $rotationState 'sync-state\git-update-cursor.json') '{broken cursor'

    $firstRotation = Invoke-SyncFixture $engine $rotationConfig $rotationState $rotationReports $fakeGitBin -GitUpdateBudgetSeconds 14
    if ($firstRotation.ExitCode -ne 0) {
      throw "$engineLabel first rotation fixture failed: $($firstRotation.Stderr)"
    }
    $firstRotationSummary = Get-Content -LiteralPath (Join-Path $rotationReports 'last-sync.json') -Raw | ConvertFrom-Json
    $cursorReadWarning = @($firstRotationSummary.repositories | Where-Object {
      $_.Repository -eq '__rotation__' -and
      $_.Action -eq 'cursor-read' -and
      $_.Status -eq 'failed' -and
      $_.Message -eq 'Saved update rotation could not be read; default order was used.'
    })
    if ($cursorReadWarning.Count -ne 1 -or
        $firstRotation.Stdout -match '\{broken cursor' -or
        $firstRotation.Stderr -match '\{broken cursor') {
      throw "$engineLabel did not surface a generic, non-sensitive cursor-read warning."
    }
    $firstRotationStatuses = @{}
    foreach ($repo in @($firstRotationSummary.repositories)) { $firstRotationStatuses[[string]$repo.Repository] = [string]$repo.Status }
    if ($firstRotationStatuses['a-timeout-repo'] -ne 'timeout' -or
        $firstRotationStatuses['b-ok-repo'] -ne 'skipped' -or
        $firstRotationStatuses['c-ok-repo'] -ne 'skipped') {
      throw "$engineLabel did not expose the partial first rotation: $($firstRotationSummary | ConvertTo-Json -Compress -Depth 6)"
    }
    $rotationCursor = Get-Content -LiteralPath (Join-Path $rotationState 'sync-state\git-update-cursor.json') -Raw | ConvertFrom-Json
    if ($rotationCursor.manualNextRepository -ne 'b-ok-repo') {
      throw "$engineLabel did not persist the first deferred source as the next rotation cursor."
    }

    $secondRotation = Invoke-SyncFixture $engine $rotationConfig $rotationState $rotationReports $fakeGitBin -GitUpdateBudgetSeconds 14
    if ($secondRotation.ExitCode -ne 0) {
      throw "$engineLabel second rotation fixture failed: $($secondRotation.Stderr)"
    }
    $secondRotationSummary = Get-Content -LiteralPath (Join-Path $rotationReports 'last-sync.json') -Raw | ConvertFrom-Json
    $secondRotationRows = @($secondRotationSummary.repositories)
    if ($secondRotationRows.Count -ne 3 -or
        $secondRotationRows[0].Repository -ne 'b-ok-repo' -or
        $secondRotationRows[0].Status -ne 'ok') {
      throw "$engineLabel did not resume from the deferred source: $($secondRotationSummary | ConvertTo-Json -Compress -Depth 6)"
    }

    # Regression 3: configured repositories can consume their share of a
    # bounded update window, but cannot starve manually discovered repositories.
    # Each group keeps its own persisted rotation cursor across runs.
    $fairRoot = Join-Path $fixtureRoot "fairness-$engineLabel"
    $fairSources = Join-Path $fairRoot 'sources'
    $fairActive = Join-Path $fairRoot 'active'
    $fairState = Join-Path $fairRoot 'state'
    $fairReports = Join-Path $fairRoot 'reports'
    New-Item -ItemType Directory -Force -Path $fairSources, $fairActive, (Join-Path $fairState 'sync-state'), $fairReports | Out-Null
    $configuredNames = @(
      'a-config-slow-timeout-repo',
      'b-config-slow-timeout-repo',
      'c-config-slow-timeout-repo',
      'd-config-slow-timeout-repo',
      'e-config-slow-timeout-repo'
    )
    $manualNames = @('a-manual-ok-repo', 'b-manual-ok-repo')
    foreach ($repoName in @($configuredNames + $manualNames)) {
      $null = New-ManualRepo $fairSources $repoName
    }
    $configuredRows = @($configuredNames | ForEach-Object {
      [PSCustomObject]@{
        name = $_
        url = "https://github.com/example/$_.git"
      }
    })
    $fairConfig = Join-Path $fairRoot 'skillhub.config.json'
    Write-TestConfig $fairConfig $fairSources $fairActive $configuredRows

    $fairBudgetSeconds = 27
    $firstFairRun = Invoke-SyncFixture $engine $fairConfig $fairState $fairReports $fakeGitBin -GitUpdateBudgetSeconds $fairBudgetSeconds
    if ($firstFairRun.ExitCode -ne 0) {
      throw "$engineLabel first configured/manual fairness run failed: $($firstFairRun.Stderr)"
    }
    $firstFairSummary = Get-Content -LiteralPath (Join-Path $fairReports 'last-sync.json') -Raw | ConvertFrom-Json
    $firstFairRows = @($firstFairSummary.repositories)
    $firstConfiguredTimedOut = @($firstFairRows | Where-Object { $configuredNames -contains $_.Repository -and $_.Status -eq 'timeout' })
    if ($firstConfiguredTimedOut.Count -lt 1) {
      throw "$engineLabel did not start a slow configured attempt despite a complete configured-plus-manual budget."
    }
    $firstManualOk = @($firstFairRows | Where-Object { $manualNames -contains $_.Repository -and $_.Status -eq 'ok' })
    if ($firstManualOk.Count -lt 1) {
      throw "$engineLabel let configured updates starve every manual source: $($firstFairSummary | ConvertTo-Json -Compress -Depth 6)"
    }
    $firstConfiguredDeferred = @($firstFairRows |
      Where-Object { $configuredNames -contains $_.Repository -and $_.Status -eq 'skipped' } |
      Select-Object -First 1)
    if ($firstConfiguredDeferred.Count -ne 1) {
      throw "$engineLabel fairness fixture did not exhaust the configured share as intended."
    }
    $firstFairCursor = Get-Content -LiteralPath (Join-Path $fairState 'sync-state\git-update-cursor.json') -Raw | ConvertFrom-Json
    if ($firstFairCursor.configuredNextRepository -ne $firstConfiguredDeferred[0].Repository -or
        $firstFairCursor.manualNextRepository -ne 'b-manual-ok-repo') {
      throw "$engineLabel did not persist independent configured/manual cursors after the first fairness run."
    }

    if ($firstFairRun.ElapsedSeconds -gt ($fairBudgetSeconds + 3)) {
      throw "$engineLabel exceeded the bounded configured/manual update window by a visible margin: $([Math]::Round($firstFairRun.ElapsedSeconds, 2)) seconds."
    }

    $secondFairRun = Invoke-SyncFixture $engine $fairConfig $fairState $fairReports $fakeGitBin -GitUpdateBudgetSeconds $fairBudgetSeconds
    if ($secondFairRun.ExitCode -ne 0) {
      throw "$engineLabel second configured/manual fairness run failed: $($secondFairRun.Stderr)"
    }
    $secondFairSummary = Get-Content -LiteralPath (Join-Path $fairReports 'last-sync.json') -Raw | ConvertFrom-Json
    $secondFairRows = @($secondFairSummary.repositories)
    $secondConfiguredFirst = @($secondFairRows | Where-Object { $configuredNames -contains $_.Repository } | Select-Object -First 1)
    $secondManualFirst = @($secondFairRows | Where-Object { $manualNames -contains $_.Repository } | Select-Object -First 1)
    if ($secondConfiguredFirst.Count -ne 1 -or
        $secondConfiguredFirst[0].Repository -ne $firstFairCursor.configuredNextRepository -or
        $secondManualFirst.Count -ne 1 -or
        $secondManualFirst[0].Repository -ne $firstFairCursor.manualNextRepository -or
        $secondManualFirst[0].Status -ne 'ok') {
      throw "$engineLabel did not resume both update groups from their independent cursors: $($secondFairSummary | ConvertTo-Json -Compress -Depth 6)"
    }
    $secondFairCursor = Get-Content -LiteralPath (Join-Path $fairState 'sync-state\git-update-cursor.json') -Raw | ConvertFrom-Json
    if ($secondFairCursor.configuredNextRepository -eq $firstFairCursor.configuredNextRepository -or
        $secondFairCursor.manualNextRepository -eq $firstFairCursor.manualNextRepository) {
      throw "$engineLabel did not advance both update-group cursors on the second fairness run."
    }
    Write-Host "PASS: $engineLabel reserves bounded update time for manual sources and rotates both groups independently."

    # Regression 4: a cursor persistence failure remains non-fatal, is visible
    # in last-sync, and never exposes a filesystem path or exception detail.
    $cursorWriteRoot = Join-Path $fixtureRoot "cursor-write-$engineLabel"
    $cursorWriteSources = Join-Path $cursorWriteRoot 'sources'
    $cursorWriteActive = Join-Path $cursorWriteRoot 'active'
    $cursorWriteState = Join-Path $cursorWriteRoot 'state'
    $cursorWriteReports = Join-Path $cursorWriteRoot 'reports'
    New-Item -ItemType Directory -Force -Path $cursorWriteSources, $cursorWriteActive, (Join-Path $cursorWriteState 'sync-state'), $cursorWriteReports | Out-Null
    $null = New-ManualRepo $cursorWriteSources 'cursor-ok-repo'
    $cursorWriteConfig = Join-Path $cursorWriteRoot 'skillhub.config.json'
    Write-TestConfig $cursorWriteConfig $cursorWriteSources $cursorWriteActive
    New-Item -ItemType Directory -Force -Path (Join-Path $cursorWriteState 'sync-state\git-update-cursor.json.skillhub-tmp') | Out-Null

    $cursorWriteRun = Invoke-SyncFixture $engine $cursorWriteConfig $cursorWriteState $cursorWriteReports $fakeGitBin -GitUpdateBudgetSeconds 14
    if ($cursorWriteRun.ExitCode -ne 0) {
      throw "$engineLabel treated a cursor-write failure as a batch failure: $($cursorWriteRun.Stderr)"
    }
    $cursorWriteSummary = Get-Content -LiteralPath (Join-Path $cursorWriteReports 'last-sync.json') -Raw | ConvertFrom-Json
    $cursorWriteWarning = @($cursorWriteSummary.repositories | Where-Object {
      $_.Repository -eq '__rotation__' -and
      $_.Action -eq 'cursor-write' -and
      $_.Status -eq 'failed' -and
      $_.Message -eq 'Update rotation could not be saved; repository results remain valid.'
    })
    if ($cursorWriteSummary.status -ne 'partial' -or
        $cursorWriteWarning.Count -ne 1 -or
        $cursorWriteRun.Stdout -match 'git-update-cursor\.json' -or
        $cursorWriteRun.Stderr -match 'git-update-cursor\.json') {
      throw "$engineLabel did not expose a generic, non-sensitive cursor-write warning: $($cursorWriteSummary | ConvertTo-Json -Compress -Depth 6)"
    }
    Write-Host "PASS: $engineLabel reports cursor persistence failures without leaking paths or exceptions."

    # Regression 5: one success, one dirty tree, one failure and one timeout
    # must finish as a partial sync without changing or removing source trees.
    $updateRoot = Join-Path $fixtureRoot "updates-$engineLabel"
    $updateSources = Join-Path $updateRoot 'sources'
    $updateActive = Join-Path $updateRoot 'active'
    $updateState = Join-Path $updateRoot 'state'
    $updateReports = Join-Path $updateRoot 'reports'
    New-Item -ItemType Directory -Force -Path $updateSources, $updateActive, (Join-Path $updateState 'sync-state'), $updateReports | Out-Null
    $updateRepoNames = @('ok-repo', 'dirty-repo', 'failed-repo', 'timeout-repo', 'metadata-only-repo', 'tracked-metadata-repo')
    foreach ($repoName in $updateRepoNames) {
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
    if ($summary.status -ne 'partial' -or $summary.total -ne 6 -or $summary.succeeded -ne 2 -or $summary.failed -ne 2 -or $summary.skipped -ne 2) {
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
    # A source is only carrying AI SkillHub's own untracked bookkeeping, so it
    # must keep tracking GitHub instead of being blocked by the app's own files.
    if ($statuses['metadata-only-repo'] -ne 'ok') {
      throw "$engineLabel let AI SkillHub's own metadata block the update: $($statuses['metadata-only-repo'])"
    }
    if ($statuses['tracked-metadata-repo'] -ne 'dirty-blocked') {
      throw "$engineLabel pulled over a tracked modification: $($statuses['tracked-metadata-repo'])"
    }
    if (([IO.File]::ReadAllText($dirtyMarker, [Text.Encoding]::UTF8)) -ne 'must survive sync') {
      throw "$engineLabel changed dirty local content."
    }
    if (Test-Path -LiteralPath $brokenActiveLink) {
      throw "$engineLabel left a broken managed source junction in the active catalog."
    }
    foreach ($repoName in $updateRepoNames) {
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
