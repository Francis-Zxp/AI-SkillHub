[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$ExecutablePath,

  [Parameter(Mandatory = $true)]
  [string]$NodeExecutable,

  [Parameter(Mandatory = $true)]
  [string]$NodeModulesPath
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$appNextRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $appNextRoot))
$resolvedExecutable = [IO.Path]::GetFullPath($ExecutablePath)
$resolvedNode = [IO.Path]::GetFullPath($NodeExecutable)
$resolvedNodeModules = [IO.Path]::GetFullPath($NodeModulesPath)
foreach ($requiredFile in @($resolvedExecutable, $resolvedNode)) {
  if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
    throw "Required QA executable does not exist: $requiredFile"
  }
}
if (-not (Test-Path -LiteralPath $resolvedNodeModules -PathType Container)) {
  throw "Node module root does not exist: $resolvedNodeModules"
}

$expectedVersion = (Get-Content -LiteralPath (Join-Path $appNextRoot 'package.json') -Raw | ConvertFrom-Json).version
$productVersion = (Get-Item -LiteralPath $resolvedExecutable).VersionInfo.ProductVersion
if ($productVersion -ne $expectedVersion) {
  throw "Executable ProductVersion $productVersion does not match package version $expectedVersion."
}
$executableSha256 = (Get-FileHash -LiteralPath $resolvedExecutable -Algorithm SHA256).Hash.ToLowerInvariant()

$temporaryRoot = [IO.Path]::GetFullPath($env:TEMP).TrimEnd('\') + '\'
$qaRunId = [Guid]::NewGuid().ToString('N')
$qaSourceName = "qa-source-alpha-$($qaRunId.Substring(0, 12))"
$qaRoot = [IO.Path]::GetFullPath((Join-Path $env:TEMP "AI-SkillHub-v3.2.0-formal-desktop-qa-$qaRunId"))
if (-not $qaRoot.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase)) {
  throw "Refusing to create formal QA state outside TEMP: $qaRoot"
}
$qaDataRoot = Join-Path $qaRoot 'data'
$qaProfileRoot = Join-Path $qaRoot 'profile'
$qaLocalAppData = Join-Path $qaProfileRoot 'AppData\Local'
$qaRoamingAppData = Join-Path $qaProfileRoot 'AppData\Roaming'
$qaSourceRoot = Join-Path $qaDataRoot "sources\$qaSourceName"
$qaChildRoot = Join-Path $qaSourceRoot 'skills\qa-child-one'

$environmentNames = @(
  'AI_SKILLHUB_DATA_ROOT',
  'AI_SKILLHUB_ROOT',
  'AI_SKILLHUB_CDP_URL',
  'AI_SKILLHUB_EXPECTED_EXE_PATH',
  'AI_SKILLHUB_EXPECTED_EXE_SHA256',
  'AI_SKILLHUB_EXPECTED_PID',
  'AI_SKILLHUB_EXPECTED_PRODUCT_VERSION',
  'AI_SKILLHUB_EXPECT_CACHED',
  'AI_SKILLHUB_PROCESS_STARTED_AT_MS',
  'AI_SKILLHUB_QA_DATA_ROOT',
  'AI_SKILLHUB_QA_RUN_ID',
  'AI_SKILLHUB_QA_SOURCE_NAME',
  'AI_SKILLHUB_STARTUP_RUN',
  'APPDATA',
  'LOCALAPPDATA',
  'NODE_PATH',
  'USERPROFILE',
  'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS',
  'WEBVIEW2_USER_DATA_FOLDER'
)
$originalEnvironment = @{}
foreach ($name in $environmentNames) {
  $originalEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
}

function Set-ProcessEnvironment([string]$Name, [AllowNull()][string]$Value) {
  [Environment]::SetEnvironmentVariable($Name, $Value, 'Process')
}

function Get-FreeTcpPort {
  $listener = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
  try {
    $listener.Start()
    return ([Net.IPEndPoint]$listener.LocalEndpoint).Port
  } finally {
    $listener.Stop()
  }
}

function Test-ProcessDescendsFrom([int]$ProcessId, [int]$ExpectedAncestorId) {
  $rows = Get-CimInstance Win32_Process
  $parents = @{}
  foreach ($row in $rows) {
    $parents[[int]$row.ProcessId] = [int]$row.ParentProcessId
  }
  $current = $ProcessId
  for ($depth = 0; $depth -lt 16 -and $current -gt 0; $depth += 1) {
    if ($current -eq $ExpectedAncestorId) { return $true }
    if (-not $parents.ContainsKey($current)) { return $false }
    $current = $parents[$current]
  }
  return $false
}

function Start-VerifiedQaApp([bool]$ExpectCached, [string]$RunLabel) {
  $port = Get-FreeTcpPort
  Set-ProcessEnvironment 'WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS' "--remote-debugging-port=$port"
  Set-ProcessEnvironment 'AI_SKILLHUB_CDP_URL' "http://127.0.0.1:$port"
  Set-ProcessEnvironment 'AI_SKILLHUB_EXPECT_CACHED' ($(if ($ExpectCached) { 'true' } else { 'false' }))
  Set-ProcessEnvironment 'AI_SKILLHUB_STARTUP_RUN' $RunLabel
  $startedAt = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
  Set-ProcessEnvironment 'AI_SKILLHUB_PROCESS_STARTED_AT_MS' $startedAt.ToString()
  $process = $null
  try {
    $process = Start-Process -FilePath $resolvedExecutable -WindowStyle Hidden -PassThru
    Set-ProcessEnvironment 'AI_SKILLHUB_EXPECTED_PID' $process.Id.ToString()

    $actualPath = [IO.Path]::GetFullPath((Get-Process -Id $process.Id -ErrorAction Stop).Path)
    if (-not [string]::Equals($actualPath, $resolvedExecutable, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Started process path does not match the formal executable: $actualPath"
    }

    $connection = $null
    for ($attempt = 0; $attempt -lt 120; $attempt += 1) {
      $connection = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
      if ($connection) { break }
      if ($process.HasExited) { throw "Formal QA app exited before CDP became available: $($process.ExitCode)" }
      Start-Sleep -Milliseconds 250
    }
    if (-not $connection) {
      throw "Formal QA app did not expose CDP on port $port."
    }
    if (-not (Test-ProcessDescendsFrom -ProcessId ([int]$connection.OwningProcess) -ExpectedAncestorId $process.Id)) {
      throw "CDP port $port is not owned by the verified AI SkillHub process tree."
    }
    return [pscustomobject]@{ Process = $process; Port = $port; StartedAt = $startedAt }
  } catch {
    $startError = $_
    if ($process -and -not $process.HasExited) {
      try {
        $startedPath = [IO.Path]::GetFullPath((Get-Process -Id $process.Id -ErrorAction Stop).Path)
        if ([string]::Equals($startedPath, $resolvedExecutable, [StringComparison]::OrdinalIgnoreCase)) {
          Stop-Process -Id $process.Id -Force
        }
      } catch {
        # Keep the original launch-verification error. The outer cleanup still
        # restores environment and removes the isolated data root.
      }
    }
    throw $startError
  }
}

function Stop-VerifiedQaApp($App) {
  if (-not $App) { return }
  $process = Get-Process -Id $App.Process.Id -ErrorAction SilentlyContinue
  if ($process) {
    $actualPath = [IO.Path]::GetFullPath($process.Path)
    if (-not [string]::Equals($actualPath, $resolvedExecutable, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to stop an unexpected process: $actualPath"
    }
    Stop-Process -Id $process.Id -Force
    $process.WaitForExit(10000) | Out-Null
  }
  for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
    if (-not (Get-NetTCPConnection -LocalPort $App.Port -State Listen -ErrorAction SilentlyContinue)) { return }
    Start-Sleep -Milliseconds 250
  }
  throw "Verified QA CDP port $($App.Port) did not close."
}

function Invoke-NodeQa([string]$ScriptPath, [string[]]$Arguments = @()) {
  & $resolvedNode $ScriptPath @Arguments
  if ($LASTEXITCODE -ne 0) {
    throw "Node QA failed with exit code ${LASTEXITCODE}: $ScriptPath"
  }
}

$startupScript = Join-Path $PSScriptRoot 'v3.2.0-startup-cache-qa.cjs'
$dragScript = Join-Path $PSScriptRoot 'v3.2.0-tauri-drag-persistence-qa.cjs'
$currentApp = $null
$operationError = $null
$qaResult = $null
$cleanupErrors = [Collections.Generic.List[string]]::new()

try {
  foreach ($directory in @($qaDataRoot, $qaProfileRoot, $qaLocalAppData, $qaRoamingAppData, $qaSourceRoot, $qaChildRoot)) {
    New-Item -ItemType Directory -Path $directory -Force | Out-Null
  }
  $utf8 = [Text.UTF8Encoding]::new($false)
  $parentSkill = @"
---
name: $qaSourceName
description: "Isolated parent Skill used only for the formal AI SkillHub desktop QA."
---

# QA Source Alpha

Routes a task to the requested child capability.
"@
  $childSkill = @'
---
name: qa-child-one
description: "Isolated child Skill used only for the formal AI SkillHub desktop QA."
---

# QA Child One

Performs the isolated child capability check.
'@
  [IO.File]::WriteAllText((Join-Path $qaSourceRoot 'SKILL.md'), $parentSkill, $utf8)
  [IO.File]::WriteAllText((Join-Path $qaChildRoot 'SKILL.md'), $childSkill, $utf8)
  $config = [ordered]@{
    activeSkillsFolder = (Join-Path $qaDataRoot 'skills')
    autoDiscoverManualRepos = $true
    githubSourcesFolder = (Join-Path $qaDataRoot 'sources')
    manageAgentLinks = $false
    repositories = @()
    version = 3
  } | ConvertTo-Json -Depth 4
  [IO.File]::WriteAllText((Join-Path $qaDataRoot 'skillhub.config.json'), $config, $utf8)

  Set-ProcessEnvironment 'AI_SKILLHUB_DATA_ROOT' $qaDataRoot
  Set-ProcessEnvironment 'AI_SKILLHUB_ROOT' $projectRoot
  Set-ProcessEnvironment 'AI_SKILLHUB_EXPECTED_EXE_PATH' $resolvedExecutable
  Set-ProcessEnvironment 'AI_SKILLHUB_EXPECTED_EXE_SHA256' $executableSha256
  Set-ProcessEnvironment 'AI_SKILLHUB_EXPECTED_PRODUCT_VERSION' $productVersion
  Set-ProcessEnvironment 'AI_SKILLHUB_QA_DATA_ROOT' $qaDataRoot
  Set-ProcessEnvironment 'AI_SKILLHUB_QA_RUN_ID' $qaRunId
  Set-ProcessEnvironment 'AI_SKILLHUB_QA_SOURCE_NAME' $qaSourceName
  Set-ProcessEnvironment 'APPDATA' $qaRoamingAppData
  Set-ProcessEnvironment 'LOCALAPPDATA' $qaLocalAppData
  Set-ProcessEnvironment 'NODE_PATH' $resolvedNodeModules
  Set-ProcessEnvironment 'USERPROFILE' $qaProfileRoot
  Set-ProcessEnvironment 'WEBVIEW2_USER_DATA_FOLDER' (Join-Path $qaRoot 'webview2')

  $currentApp = Start-VerifiedQaApp -ExpectCached $false -RunLabel 'formal-isolated-warmup'
  Invoke-NodeQa -ScriptPath $startupScript
  $isolatedDatabase = Join-Path $qaDataRoot 'state\skillhub-next.sqlite3'
  if (-not (Test-Path -LiteralPath $isolatedDatabase -PathType Leaf)) {
    throw "The verified app did not create its SQLite index inside the isolated QA data root: $isolatedDatabase"
  }
  Stop-VerifiedQaApp $currentApp
  $currentApp = $null

  $currentApp = Start-VerifiedQaApp -ExpectCached $true -RunLabel 'formal-isolated-cache'
  Invoke-NodeQa -ScriptPath $startupScript

  Invoke-NodeQa -ScriptPath $dragScript -Arguments @('move')

  $firstDragPid = $currentApp.Process.Id
  Stop-VerifiedQaApp $currentApp
  $currentApp = $null
  $currentApp = Start-VerifiedQaApp -ExpectCached $true -RunLabel 'formal-isolated-drag-restart'
  if ($currentApp.Process.Id -eq $firstDragPid) {
    throw 'Windows reused the same PID; restart the isolated drag verification to retain unambiguous evidence.'
  }
  Invoke-NodeQa -ScriptPath $dragScript -Arguments @('verify-restore')
  Stop-VerifiedQaApp $currentApp
  $currentApp = $null

  $qaResult = [pscustomobject]@{
    Executable = $resolvedExecutable
    ProductVersion = $productVersion
    Sha256 = $executableSha256
    IsolatedData = $true
    ClipboardUntouched = $true
    StartupReport = (Join-Path $appNextRoot "reports\desktop\v3.2.0-startup-cache\formal-isolated-cache-$qaRunId.json")
    DragReport = (Join-Path $appNextRoot "reports\desktop\v3.2.0-tauri-drag\state-$qaRunId.json")
  }
} catch {
  $operationError = $_
} finally {
  if ($currentApp) {
    try {
      Stop-VerifiedQaApp $currentApp
    } catch {
      $cleanupErrors.Add("app stop: $($_.Exception.Message)")
    }
  }
  foreach ($name in $environmentNames) {
    try {
      Set-ProcessEnvironment $name $originalEnvironment[$name]
    } catch {
      $cleanupErrors.Add("environment restore $name`: $($_.Exception.Message)")
    }
  }
  try {
    $resolvedQaRoot = [IO.Path]::GetFullPath($qaRoot)
    if (-not $resolvedQaRoot.StartsWith($temporaryRoot, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to remove QA state outside TEMP: $resolvedQaRoot"
    }
    if (Test-Path -LiteralPath $resolvedQaRoot) {
      Remove-Item -LiteralPath $resolvedQaRoot -Recurse -Force
    }
  } catch {
    $cleanupErrors.Add("temporary data cleanup: $($_.Exception.Message)")
  }
}

if ($operationError) {
  if ($cleanupErrors.Count -gt 0) {
    Write-Warning ("Formal QA also encountered cleanup errors: " + ($cleanupErrors -join ' | '))
  }
  throw $operationError
}
if ($cleanupErrors.Count -gt 0) {
  throw ("Formal QA checks passed but cleanup did not complete: " + ($cleanupErrors -join ' | '))
}
$qaResult | ConvertTo-Json -Depth 4
