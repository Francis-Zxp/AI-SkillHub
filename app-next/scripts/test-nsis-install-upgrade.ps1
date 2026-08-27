[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,
  [string]$PreviousInstallerPath = '',
  [string]$ExpectedVersion = '3.2.2',
  [string]$PreviousExpectedVersion = '3.2.1',
  [ValidateRange(10, 1800)]
  [int]$InstallerTimeoutSeconds = 300,
  [ValidateRange(5, 300)]
  [int]$AppStartupTimeoutSeconds = 45,
  [ValidateRange(5, 120)]
  [int]$ProcessStopTimeoutSeconds = 15,
  [switch]$KeepSandbox
)

$ErrorActionPreference = 'Stop'
$InstallerPath = (Resolve-Path -LiteralPath $InstallerPath).Path
if (-not [string]::IsNullOrWhiteSpace($PreviousInstallerPath)) {
  $PreviousInstallerPath = (Resolve-Path -LiteralPath $PreviousInstallerPath).Path
  $previousProductVersion = (
    [string](Get-Item -LiteralPath $PreviousInstallerPath).VersionInfo.ProductVersion -split '[+-]'
  )[0]
  if ($previousProductVersion -ne $PreviousExpectedVersion) {
    throw "Previous installer version mismatch: expected $PreviousExpectedVersion, found $previousProductVersion."
  }
}

$QaId = [Guid]::NewGuid().ToString('N')
$TempBase = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
$QaRoot = Join-Path $env:TEMP "AI-SkillHub-Installer-QA-$QaId"
$InstallRoot = Join-Path $QaRoot 'program'
$DataRoot = Join-Path $QaRoot 'user-data'
$RegistryBackupRoot = Join-Path $QaRoot 'registry-backup'
$ProductKey = 'HKCU:\Software\franciszhu\AI SkillHub'
$UninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\AI SkillHub'
$SentinelContent = 'ai-skillhub-user-data-preservation-sentinel'

function Assert-PathInsideTemp([string]$Path) {
  $full = [IO.Path]::GetFullPath($Path)
  if (-not $full.StartsWith($script:TempBase, [StringComparison]::OrdinalIgnoreCase)) {
    throw "QA path escaped TEMP: $full"
  }
}

function Assert-ExactQaRoot([string]$Path) {
  Assert-PathInsideTemp $Path
  $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  $expected = [IO.Path]::GetFullPath($script:QaRoot).TrimEnd('\')
  $expectedLeaf = "AI-SkillHub-Installer-QA-$script:QaId"
  if (-not $full.Equals($expected, [StringComparison]::OrdinalIgnoreCase) -or
      (Split-Path -Leaf $full) -cne $expectedLeaf) {
    throw "QA cleanup target is not this run's exact GUID sandbox: $full"
  }
  if (Test-Path -LiteralPath $full) {
    $item = Get-Item -LiteralPath $full -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw "QA cleanup refuses a reparse-point root: $full"
    }
  }
  return $full
}

function ConvertTo-NativeRegistryPath([string]$Path) {
  if ($Path.StartsWith('HKCU:\', [StringComparison]::OrdinalIgnoreCase)) {
    return 'HKCU\' + $Path.Substring(6)
  }
  throw "Unsupported registry hive for installer QA snapshot: $Path"
}

function New-RegistrySnapshot {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [Parameter(Mandatory = $true)]
    [string]$BackupFile
  )

  $existed = Test-Path -LiteralPath $Path
  $snapshot = [pscustomobject]@{
    Path = $Path
    Existed = $existed
    BackupFile = $BackupFile
  }
  if (-not $existed) {
    return $snapshot
  }

  $reg = Get-Command reg.exe -ErrorAction Stop
  $nativePath = ConvertTo-NativeRegistryPath $Path
  $exitCode = Invoke-BoundedProcess `
    -FilePath $reg.Source `
    -ArgumentList @('export', $nativePath, $BackupFile, '/y') `
    -Label "Registry export $nativePath" `
    -TimeoutSeconds 30
  if ($exitCode -ne 0 -or -not (Test-Path -LiteralPath $BackupFile -PathType Leaf)) {
    throw "Could not back up registry key: $nativePath"
  }
  return $snapshot
}

function Restore-RegistrySnapshot {
  param(
    [Parameter(Mandatory = $true)]
    [psobject]$Snapshot
  )

  $reg = Get-Command reg.exe -ErrorAction Stop
  $nativePath = ConvertTo-NativeRegistryPath $Snapshot.Path
  if (Test-Path -LiteralPath $Snapshot.Path) {
    $deleteExit = Invoke-BoundedProcess `
      -FilePath $reg.Source `
      -ArgumentList @('delete', $nativePath, '/f') `
      -Label "Registry reset $nativePath" `
      -TimeoutSeconds 30
    if ($deleteExit -ne 0) {
      throw "Could not reset registry key before restore: $nativePath"
    }
  }
  if (-not $Snapshot.Existed) {
    return
  }
  if (-not (Test-Path -LiteralPath $Snapshot.BackupFile -PathType Leaf)) {
    throw "Registry snapshot is missing: $($Snapshot.BackupFile)"
  }

  $importExit = Invoke-BoundedProcess `
    -FilePath $reg.Source `
    -ArgumentList @('import', $Snapshot.BackupFile) `
    -Label "Registry restore $nativePath" `
    -TimeoutSeconds 30
  if ($importExit -ne 0 -or -not (Test-Path -LiteralPath $Snapshot.Path)) {
    throw "Could not restore registry key: $($Snapshot.Path)"
  }
}

function ConvertTo-ProcessArgument([string]$Value) {
  if ($Value -notmatch '[\s"]') {
    return $Value
  }
  return '"' + $Value.Replace('"', '\"') + '"'
}

function Stop-TestProcess {
  param(
    [Parameter(Mandatory = $true)]
    [Diagnostics.Process]$Process,
    [Parameter(Mandatory = $true)]
    [string]$Label
  )

  $Process.Refresh()
  if ($Process.HasExited) {
    return
  }
  $Process.Kill()
  if (-not $Process.WaitForExit($script:ProcessStopTimeoutSeconds * 1000)) {
    throw "$Label did not stop within $script:ProcessStopTimeoutSeconds seconds."
  }
}

function Invoke-BoundedProcess {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,
    [string[]]$ArgumentList = @(),
    [Parameter(Mandatory = $true)]
    [string]$Label,
    [Parameter(Mandatory = $true)]
    [int]$TimeoutSeconds
  )

  $safeArguments = @($ArgumentList | ForEach-Object { ConvertTo-ProcessArgument ([string]$_) })
  $process = Start-Process -FilePath $FilePath -ArgumentList $safeArguments `
    -PassThru -WindowStyle Hidden
  if ($null -eq $process) {
    throw "$Label could not be started."
  }
  try {
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      Stop-TestProcess -Process $process -Label $Label
      throw "$Label timed out after $TimeoutSeconds seconds."
    }
    return [int]$process.ExitCode
  } finally {
    $process.Dispose()
  }
}

function Invoke-BoundedSqlite {
  param(
    [Parameter(Mandatory = $true)]
    [string]$FilePath,
    [Parameter(Mandatory = $true)]
    [string]$DatabasePath,
    [Parameter(Mandatory = $true)]
    [string]$Sql,
    [Parameter(Mandatory = $true)]
    [string]$Label,
    [ValidateRange(1, 120)]
    [int]$TimeoutSeconds = 30
  )

  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $FilePath
  $psi.Arguments = ConvertTo-ProcessArgument $DatabasePath
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.RedirectStandardInput = $true
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $process = [Diagnostics.Process]::Start($psi)
  if ($null -eq $process) {
    throw "$Label could not be started."
  }
  try {
    $process.StandardInput.WriteLine($Sql)
    $process.StandardInput.Close()
    if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
      Stop-TestProcess -Process $process -Label $Label
      throw "$Label timed out after $TimeoutSeconds seconds."
    }
    $stdout = $process.StandardOutput.ReadToEnd()
    $stderr = $process.StandardError.ReadToEnd()
    return [pscustomobject]@{
      ExitCode = [int]$process.ExitCode
      StdOut = [string]$stdout
      StdErr = [string]$stderr
    }
  } finally {
    $process.Dispose()
  }
}

function Remove-QaSandboxWithRetry {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path,
    [ValidateRange(1, 60)]
    [int]$TimeoutSeconds = 20
  )

  $exactPath = Assert-ExactQaRoot $Path
  $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
  $lastError = $null
  do {
    try {
      $exactPath = Assert-ExactQaRoot $exactPath
      if (-not (Test-Path -LiteralPath $exactPath)) {
        return
      }
      $escapedPath = $exactPath.Replace("'", "''")
      $cleanupCommand = @"
`$ErrorActionPreference = 'Stop'
try {
  `$target = '$escapedPath'
  `$item = Get-Item -LiteralPath `$target -Force
  if ((`$item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { exit 3 }
  Remove-Item -LiteralPath `$target -Recurse -Force -ErrorAction Stop
  exit 0
} catch { exit 2 }
"@
      $encodedCommand = [Convert]::ToBase64String(
        [Text.Encoding]::Unicode.GetBytes($cleanupCommand)
      )
      $powershell = Get-Command powershell.exe -ErrorAction Stop
      $remainingSeconds = [Math]::Max(
        1,
        [Math]::Min(3, [Math]::Ceiling(($deadline - [DateTime]::UtcNow).TotalSeconds))
      )
      $exitCode = Invoke-BoundedProcess `
        -FilePath $powershell.Source `
        -ArgumentList @('-NoProfile', '-NonInteractive', '-EncodedCommand', $encodedCommand) `
        -Label 'Bounded QA sandbox cleanup' `
        -TimeoutSeconds ([int]$remainingSeconds)
      if ($exitCode -eq 0 -and -not (Test-Path -LiteralPath $exactPath)) {
        return
      }
      $lastError = "cleanup process exited $exitCode"
    } catch {
      $lastError = $_.Exception.Message
    }
    Start-Sleep -Milliseconds 400
  } while ([DateTime]::UtcNow -lt $deadline)

  throw "QA sandbox remained busy for $TimeoutSeconds seconds: $lastError"
}

function Test-AppStartup {
  param(
    [Parameter(Mandatory = $true)]
    [string]$AppPath,
    [Parameter(Mandatory = $true)]
    [string]$WorkingDirectory,
    [Parameter(Mandatory = $true)]
    [string]$DataDirectory,
    [Parameter(Mandatory = $true)]
    [string]$ReadyFile,
    [Parameter(Mandatory = $true)]
    [string]$Label
  )

  $psi = New-Object Diagnostics.ProcessStartInfo
  $psi.FileName = $AppPath
  $psi.WorkingDirectory = $WorkingDirectory
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.EnvironmentVariables['AI_SKILLHUB_DATA_ROOT'] = $DataDirectory
  $process = [Diagnostics.Process]::Start($psi)
  if ($null -eq $process) {
    throw "$Label could not be started."
  }

  $deadline = [DateTime]::UtcNow.AddSeconds($script:AppStartupTimeoutSeconds)
  $readySince = $null
  try {
    while ([DateTime]::UtcNow -lt $deadline) {
      $process.Refresh()
      if ($process.HasExited) {
        throw "$Label exited before the startup probe completed (exit $($process.ExitCode))."
      }
      if (Test-Path -LiteralPath $ReadyFile -PathType Leaf) {
        if ($null -eq $readySince) {
          $readySince = [DateTime]::UtcNow
        } elseif (([DateTime]::UtcNow - $readySince).TotalMilliseconds -ge 1500) {
          return $true
        }
      } else {
        $readySince = $null
      }
      Start-Sleep -Milliseconds 250
    }
    throw "$Label did not become ready within $script:AppStartupTimeoutSeconds seconds."
  } finally {
    try {
      Stop-TestProcess -Process $process -Label $Label
    } finally {
      $process.Dispose()
    }
  }
}

foreach ($path in @($QaRoot, $InstallRoot, $DataRoot, $RegistryBackupRoot)) {
  Assert-PathInsideTemp $path
}

$ProductKeySnapshot = $null
$UninstallKeySnapshot = $null
$testFailure = $null
$registryRestoreFailed = $false
$cleanupFailures = New-Object 'System.Collections.Generic.List[string]'

try {
  New-Item -ItemType Directory -Force -Path $QaRoot, $DataRoot, $RegistryBackupRoot | Out-Null
  $ProductKeySnapshot = New-RegistrySnapshot `
    -Path $ProductKey `
    -BackupFile (Join-Path $RegistryBackupRoot 'product-key.reg')
  $UninstallKeySnapshot = New-RegistrySnapshot `
    -Path $UninstallKey `
    -BackupFile (Join-Path $RegistryBackupRoot 'uninstall-key.reg')

  New-Item -Path $ProductKey -Force | Out-Null
  Set-Item -LiteralPath $ProductKey -Value $InstallRoot

  $firstInstaller = if ([string]::IsNullOrWhiteSpace($PreviousInstallerPath)) {
    $InstallerPath
  } else {
    $PreviousInstallerPath
  }
  $firstExit = Invoke-BoundedProcess `
    -FilePath $firstInstaller `
    -ArgumentList @('/S', "/D=$InstallRoot") `
    -Label 'First NSIS install' `
    -TimeoutSeconds $InstallerTimeoutSeconds
  if ($firstExit -ne 0) { throw "First NSIS install failed: $firstExit" }

  $app = Join-Path $InstallRoot 'ai-skillhub-next.exe'
  $database = Join-Path $DataRoot 'state\skillhub-next.sqlite3'
  $runtimeFiles = @(
    'app-next\runtime\SkillHub.ps1',
    'app-next\runtime\Manage-AgentSkillLinks.ps1',
    'app-next\runtime\Export-SkillHubDiagnostics.ps1',
    'app-next\runtime\skillhub.config.example.json'
  )
  if (-not (Test-Path -LiteralPath $app -PathType Leaf)) {
    throw "Installed app missing: $app"
  }
  $missingRuntime = @(
    $runtimeFiles | Where-Object {
      -not (Test-Path -LiteralPath (Join-Path $InstallRoot $_) -PathType Leaf)
    }
  )
  if ($missingRuntime.Count -gt 0) {
    throw "Installed runtime resources missing: $($missingRuntime -join ', ')"
  }

  $preservedParentRating = -1
  if (-not [string]::IsNullOrWhiteSpace($PreviousInstallerPath)) {
    $null = Test-AppStartup `
      -AppPath $app `
      -WorkingDirectory $InstallRoot `
      -DataDirectory $DataRoot `
      -ReadyFile $database `
      -Label 'Previous-version app'

    $sqlite = Get-Command sqlite3 -ErrorAction SilentlyContinue
    if (-not $sqlite) { throw 'sqlite3 is required for the cross-version data gate.' }
    $stamp = [DateTimeOffset]::UtcNow.ToUnixTimeSeconds().ToString()
    $seedSql = @"
INSERT OR REPLACE INTO sources (
  id, name, source_type, url, local_path, install_mode,
  category_id, note, enabled, created_at, updated_at
) VALUES (
  'qa-upgrade-source', 'QA Upgrade Source', 'skill',
  'https://github.com/example/qa-upgrade-source.git', '',
  'scan', 'general', 'upgrade sentinel', 1, '$stamp', '$stamp'
);
INSERT OR REPLACE INTO source_overrides (
  source_id, display_name, source_type, category_id, note, enabled, rating, updated_at
) VALUES (
  'qa-upgrade-source', '', '', '', 'upgrade sentinel', NULL, 5, '$stamp'
);
"@
    $seedResult = Invoke-BoundedSqlite `
      -FilePath $sqlite.Source `
      -DatabasePath $database `
      -Sql $seedSql `
      -Label 'Seed previous-version SQLite data'
    if ($seedResult.ExitCode -ne 0) {
      throw "Could not seed previous-version user data: $($seedResult.StdErr.Trim())"
    }
  }

  $sentinel = Join-Path $DataRoot 'update-preserves-user-data.txt'
  [IO.File]::WriteAllText(
    $sentinel,
    $SentinelContent,
    (New-Object Text.UTF8Encoding($false))
  )
  $secondExit = Invoke-BoundedProcess `
    -FilePath $InstallerPath `
    -ArgumentList @('/S', "/D=$InstallRoot") `
    -Label 'In-place NSIS reinstall' `
    -TimeoutSeconds $InstallerTimeoutSeconds
  if ($secondExit -ne 0) { throw "In-place NSIS reinstall failed: $secondExit" }

  $sentinelPreserved =
    (Test-Path -LiteralPath $sentinel -PathType Leaf) -and
    ((Get-Content -LiteralPath $sentinel -Raw) -eq $SentinelContent)
  $installedVersion = (
    [string](Get-Item -LiteralPath $app).VersionInfo.ProductVersion -split '[+-]'
  )[0]

  $appStarted = Test-AppStartup `
    -AppPath $app `
    -WorkingDirectory $InstallRoot `
    -DataDirectory $DataRoot `
    -ReadyFile $database `
    -Label 'Installed app'
  $databaseCreated = Test-Path -LiteralPath $database -PathType Leaf
  if (-not [string]::IsNullOrWhiteSpace($PreviousInstallerPath) -and $databaseCreated) {
    $sqlite = Get-Command sqlite3 -ErrorAction SilentlyContinue
    if (-not $sqlite) { throw 'sqlite3 is required for the cross-version data gate.' }
    $ratingResult = Invoke-BoundedSqlite `
      -FilePath $sqlite.Source `
      -DatabasePath $database `
      -Sql "SELECT rating FROM source_overrides WHERE source_id='qa-upgrade-source';" `
      -Label 'Read preserved parent rating'
    if ($ratingResult.ExitCode -ne 0) {
      throw "Could not read preserved parent rating: $($ratingResult.StdErr.Trim())"
    }
    $preservedParentRating = [int]$ratingResult.StdOut.Trim()
  }

  $result = [pscustomobject]@{
    upgradedFrom = if ([string]::IsNullOrWhiteSpace($PreviousInstallerPath)) {
      'same-version'
    } else {
      $previousProductVersion
    }
    installerExit = $firstExit
    inPlaceReinstallExit = $secondExit
    installedVersion = $installedVersion
    runtimeResources = $runtimeFiles.Count
    missingRuntimeResources = $missingRuntime.Count
    userDataSentinelPreserved = $sentinelPreserved
    parentRatingPreserved = $preservedParentRating
    installedAppStarted = $appStarted
    databaseCreated = $databaseCreated
  }
  $result | ConvertTo-Json -Depth 3

  if (
    $installedVersion -ne $ExpectedVersion -or
    -not $sentinelPreserved -or
    -not $appStarted -or
    -not $databaseCreated -or
    (
      -not [string]::IsNullOrWhiteSpace($PreviousInstallerPath) -and
      $preservedParentRating -ne 5
    )
  ) {
    throw 'Installer QA did not satisfy the release gate.'
  }
} catch {
  $testFailure = $_
} finally {
  try {
    $uninstall = Join-Path $InstallRoot 'uninstall.exe'
    if (Test-Path -LiteralPath $uninstall -PathType Leaf) {
      $uninstallExit = Invoke-BoundedProcess `
        -FilePath $uninstall `
        -ArgumentList @('/S') `
        -Label 'NSIS uninstall cleanup' `
        -TimeoutSeconds $InstallerTimeoutSeconds
      if ($uninstallExit -ne 0) {
        throw "NSIS uninstall cleanup failed: $uninstallExit"
      }
    }
  } catch {
    $cleanupFailures.Add($_.Exception.Message)
  }

  foreach ($snapshot in @($ProductKeySnapshot, $UninstallKeySnapshot)) {
    if ($null -eq $snapshot) {
      continue
    }
    try {
      Restore-RegistrySnapshot -Snapshot $snapshot
    } catch {
      $registryRestoreFailed = $true
      $cleanupFailures.Add(
        "Registry restore failed for $($snapshot.Path); recovery files preserved at $QaRoot`: $($_.Exception.Message)"
      )
    }
  }

  try {
    if ($registryRestoreFailed) {
      Write-Warning "Registry recovery evidence preserved: $QaRoot"
    } elseif (-not $KeepSandbox -and (Test-Path -LiteralPath $QaRoot)) {
      Remove-QaSandboxWithRetry -Path $QaRoot
      Write-Host "Installer QA sandbox removed: $QaRoot"
    }
  } catch {
    $cleanupFailures.Add($_.Exception.Message)
  }
}

if ($cleanupFailures.Count -gt 0) {
  $cleanupSummary = $cleanupFailures -join ' | '
  if ($null -ne $testFailure) {
    throw "$($testFailure.Exception.Message) Cleanup/restore errors: $cleanupSummary"
  }
  throw "Installer QA cleanup/restore errors: $cleanupSummary"
}
if ($null -ne $testFailure) {
  throw $testFailure
}
