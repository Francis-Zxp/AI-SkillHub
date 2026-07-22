[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$PackagePath,
  [string]$SqliteExe = '',
  [string]$RepositoryUrl = 'https://github.com/BehiSecc/VibeSec-Skill.git',
  [switch]$KeepSandbox
)

$ErrorActionPreference = 'Stop'
$V2Root = Split-Path -Parent $PSScriptRoot
$ReportsRoot = Join-Path $V2Root 'reports\final-recipient-test'
$SandboxRoot = Join-Path $ReportsRoot 'AI SkillHub fresh recipient path'
$Result = $null
$Passed = $false

function Assert-PathInsideRoot([string]$Path, [string]$Root, [string]$Label) {
  $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  $targetFull = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  if ($targetFull -eq $rootFull.TrimEnd('\') -or -not $targetFull.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label is outside the expected root: $targetFull"
  }
}

function Stop-SandboxProcesses([string]$Root) {
  Get-CimInstance Win32_Process | Where-Object {
    $_.ExecutablePath -and $_.ExecutablePath.StartsWith($Root, [StringComparison]::OrdinalIgnoreCase)
  } | ForEach-Object {
    Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
  }
}

function Remove-Sandbox([string]$Path) {
  Assert-PathInsideRoot $Path $ReportsRoot 'recipient sandbox'
  if (Test-Path -LiteralPath $Path) {
    Remove-Item -LiteralPath $Path -Recurse -Force
  }
}

if ($RepositoryUrl -notmatch '^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:\.git)?$') {
  throw "Only a canonical HTTPS GitHub repository URL is allowed: $RepositoryUrl"
}

$PackagePath = (Resolve-Path -LiteralPath $PackagePath).Path
if ([IO.Path]::GetExtension($PackagePath) -ne '.zip') {
  throw "Release package must be a zip file: $PackagePath"
}

New-Item -ItemType Directory -Force -Path $ReportsRoot | Out-Null
Assert-PathInsideRoot $SandboxRoot $ReportsRoot 'recipient sandbox'
Remove-Sandbox $SandboxRoot
New-Item -ItemType Directory -Force -Path $SandboxRoot | Out-Null

try {
  Expand-Archive -LiteralPath $PackagePath -DestinationPath $SandboxRoot -Force
  $RuntimeRoot = Join-Path $SandboxRoot 'app-next\runtime'
  $SourcesRoot = Join-Path $SandboxRoot 'app-next\data\github_sources'
  $RuntimeScript = Join-Path $RuntimeRoot 'SkillHub.ps1'
  $WindowsPowerShell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'

  & $WindowsPowerShell -NoProfile -ExecutionPolicy Bypass -File $RuntimeScript -NoPull -ReportOnly | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'First-run report-only initialization failed.' }

  git clone --depth 1 $RepositoryUrl (Join-Path $SourcesRoot 'VibeSec-Skill') | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Public Skill repository clone failed.' }

  & $WindowsPowerShell -NoProfile -ExecutionPolicy Bypass -File $RuntimeScript -NoPull | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Fresh-recipient Skill sync failed.' }

  $AppPath = Join-Path $SandboxRoot 'AI SkillHub.exe'
  $App = Start-Process -FilePath $AppPath -WorkingDirectory $SandboxRoot -WindowStyle Hidden -PassThru
  Start-Sleep -Seconds 12
  $AppStarted = -not $App.HasExited
  Stop-SandboxProcesses $SandboxRoot
  Start-Sleep -Milliseconds 700

  $DatabasePath = Join-Path $SandboxRoot 'app-next\.skillhub-next\skillhub-next.sqlite3'
  if (-not (Test-Path -LiteralPath $DatabasePath -PathType Leaf)) {
    throw 'The release executable did not create a fresh-recipient SQLite database.'
  }

  if ([string]::IsNullOrWhiteSpace($SqliteExe)) {
    $SqliteCommand = Get-Command sqlite3 -ErrorAction SilentlyContinue
    if ($SqliteCommand) { $SqliteExe = $SqliteCommand.Source }
  }
  if ([string]::IsNullOrWhiteSpace($SqliteExe) -or -not (Test-Path -LiteralPath $SqliteExe -PathType Leaf)) {
    throw 'sqlite3 is required to verify the fresh-recipient index.'
  }

  $SourceCount = [int](& $SqliteExe $DatabasePath "SELECT COUNT(*) FROM sources WHERE lower(name)='vibesec-skill';")
  $SkillCount = [int](& $SqliteExe $DatabasePath "SELECT COUNT(*) FROM skills WHERE lower(name)='vibesec-skill' OR lower(folder_name)='vibesec-skill';")
  $OrphanRouterCount = [int](& $SqliteExe $DatabasePath 'SELECT COUNT(*) FROM skills WHERE source_id IS NULL AND COALESCE(is_router_hub, 0)=1;')
  $ConfigCreated = Test-Path -LiteralPath (Join-Path $RuntimeRoot 'skillhub.config.json') -PathType Leaf
  $SyncReportCreated = Test-Path -LiteralPath (Join-Path $SandboxRoot 'app-next\reports\last-sync.md') -PathType Leaf
  $Passed = $AppStarted -and $SourceCount -ge 1 -and $SkillCount -ge 1 -and $OrphanRouterCount -eq 0 -and $ConfigCreated -and $SyncReportCreated

  $Result = [pscustomobject]@{
    package = Split-Path -Leaf $PackagePath
    appStarted = $AppStarted
    sourceCount = $SourceCount
    skillCount = $SkillCount
    orphanRouterCount = $OrphanRouterCount
    configCreated = $ConfigCreated
    syncReportCreated = $SyncReportCreated
    passed = $Passed
  }
  if (-not $Passed) {
    throw ('Fresh-recipient verification failed: ' + ($Result | ConvertTo-Json -Compress))
  }
} finally {
  Stop-SandboxProcesses $SandboxRoot
  if (-not $KeepSandbox) {
    Remove-Sandbox $SandboxRoot
  }
}

$Result | ConvertTo-Json -Depth 4
[pscustomobject]@{
  sandbox = $SandboxRoot
  sandboxDeleted = -not (Test-Path -LiteralPath $SandboxRoot)
} | ConvertTo-Json -Depth 2

if (-not $Passed) { exit 1 }
