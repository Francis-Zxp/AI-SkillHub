[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$InstallerPath,
  [string]$ExpectedVersion = '3.0.3',
  [switch]$KeepSandbox
)

$ErrorActionPreference = 'Stop'
$InstallerPath = (Resolve-Path -LiteralPath $InstallerPath).Path
$QaId = [Guid]::NewGuid().ToString('N')
$TempBase = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
$QaRoot = Join-Path $env:TEMP "AI-SkillHub-Installer-QA-$QaId"
$InstallRoot = Join-Path $QaRoot 'program'
$DataRoot = Join-Path $QaRoot 'user-data'
$ProductKey = 'HKCU:\Software\franciszhu\AI SkillHub'
$ProductKeyExisted = Test-Path -LiteralPath $ProductKey
$PreviousInstallLocation = if ($ProductKeyExisted) {
  [string](Get-Item -LiteralPath $ProductKey).GetValue('')
} else {
  ''
}
$UninstallKey = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\AI SkillHub'
$QaPathPrefix = [IO.Path]::GetFullPath(
  (Join-Path $env:TEMP 'AI-SkillHub-Installer-QA-')
)
if (
  $ProductKeyExisted -and
  -not (Test-Path -LiteralPath $UninstallKey) -and
  -not [string]::IsNullOrWhiteSpace($PreviousInstallLocation)
) {
  $previousFull = [IO.Path]::GetFullPath($PreviousInstallLocation)
  if ($previousFull.StartsWith($QaPathPrefix, [StringComparison]::OrdinalIgnoreCase)) {
    $previousQaRoot = Split-Path -Parent $previousFull
    if (Test-Path -LiteralPath $previousQaRoot) {
      Remove-Item -LiteralPath $previousQaRoot -Recurse -Force
    }
    Remove-Item -LiteralPath $ProductKey -Force
    $ProductKeyExisted = $false
    $PreviousInstallLocation = ''
  }
}

function Assert-PathInsideTemp([string]$Path) {
  $full = [IO.Path]::GetFullPath($Path)
  if (-not $full.StartsWith($script:TempBase, [StringComparison]::OrdinalIgnoreCase)) {
    throw "QA path escaped TEMP: $full"
  }
}

foreach ($path in @($QaRoot, $InstallRoot, $DataRoot)) {
  Assert-PathInsideTemp $path
}
New-Item -ItemType Directory -Force -Path $QaRoot, $DataRoot | Out-Null
New-Item -Path $ProductKey -Force | Out-Null
Set-Item -LiteralPath $ProductKey -Value $InstallRoot

try {
  $first = Start-Process -FilePath $InstallerPath -ArgumentList @('/S', "/D=$InstallRoot") -Wait -PassThru -WindowStyle Hidden
  if ($first.ExitCode -ne 0) { throw "First NSIS install failed: $($first.ExitCode)" }

  $app = Join-Path $InstallRoot 'ai-skillhub-next.exe'
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

  $sentinel = Join-Path $DataRoot 'update-preserves-user-data.txt'
  [IO.File]::WriteAllText(
    $sentinel,
    'preserve-v3.0.3',
    [Text.UTF8Encoding]::new($false)
  )
  $second = Start-Process -FilePath $InstallerPath -ArgumentList @('/S', "/D=$InstallRoot") -Wait -PassThru -WindowStyle Hidden
  if ($second.ExitCode -ne 0) { throw "In-place NSIS reinstall failed: $($second.ExitCode)" }

  $sentinelPreserved =
    (Test-Path -LiteralPath $sentinel -PathType Leaf) -and
    ((Get-Content -LiteralPath $sentinel -Raw) -eq 'preserve-v3.0.3')
  $installedVersion = (
    [string](Get-Item -LiteralPath $app).VersionInfo.ProductVersion -split '[+-]'
  )[0]

  $psi = [Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = $app
  $psi.WorkingDirectory = $InstallRoot
  $psi.UseShellExecute = $false
  $psi.CreateNoWindow = $true
  $psi.EnvironmentVariables['AI_SKILLHUB_DATA_ROOT'] = $DataRoot
  $process = [Diagnostics.Process]::Start($psi)
  Start-Sleep -Seconds 8
  $appStarted = -not $process.HasExited
  if (-not $process.HasExited) {
    $process.Kill()
    $process.WaitForExit()
  }
  $databaseCreated = Test-Path -LiteralPath (
    Join-Path $DataRoot 'state\skillhub-next.sqlite3'
  ) -PathType Leaf

  $result = [pscustomobject]@{
    installerExit = $first.ExitCode
    inPlaceReinstallExit = $second.ExitCode
    installedVersion = $installedVersion
    runtimeResources = $runtimeFiles.Count
    missingRuntimeResources = $missingRuntime.Count
    userDataSentinelPreserved = $sentinelPreserved
    installedAppStarted = $appStarted
    databaseCreated = $databaseCreated
  }
  $result | ConvertTo-Json -Depth 3

  if (
    $installedVersion -ne $ExpectedVersion -or
    -not $sentinelPreserved -or
    -not $appStarted -or
    -not $databaseCreated
  ) {
    throw 'Installer QA did not satisfy the release gate.'
  }
} finally {
  $uninstall = Join-Path $InstallRoot 'uninstall.exe'
  if (Test-Path -LiteralPath $uninstall -PathType Leaf) {
    Start-Process -FilePath $uninstall -ArgumentList '/S' -Wait -WindowStyle Hidden | Out-Null
  }
  if (-not $KeepSandbox -and (Test-Path -LiteralPath $QaRoot)) {
    Assert-PathInsideTemp $QaRoot
    Remove-Item -LiteralPath $QaRoot -Recurse -Force
    Write-Host "Installer QA sandbox removed: $QaRoot"
  }
  if ($ProductKeyExisted) {
    Set-Item -LiteralPath $ProductKey -Value $PreviousInstallLocation
  } elseif (Test-Path -LiteralPath $ProductKey) {
    Remove-Item -LiteralPath $ProductKey -Force
  }
}
