[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$PackagePath,
  [string]$SqliteExe = '',
  [string]$RepositoryUrl = 'https://github.com/Imbad0202/academic-research-skills.git',
  [switch]$KeepSandbox
)

$ErrorActionPreference = 'Stop'
$V2Root = Split-Path -Parent $PSScriptRoot
$ReportsRoot = Join-Path $V2Root 'reports\final-recipient-test'
$SandboxRoot = Join-Path $ReportsRoot 'AI SkillHub fresh recipient path'
$DataRoot = Join-Path $ReportsRoot 'AI SkillHub recipient user data'
$UpgradeRoot = Join-Path $ReportsRoot 'AI SkillHub upgraded program path'
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
$RepositoryName = [regex]::Match(
  $RepositoryUrl,
  '/([A-Za-z0-9_.-]+?)(?:\.git)?$'
).Groups[1].Value
if ([string]::IsNullOrWhiteSpace($RepositoryName)) {
  throw "Could not derive a bounded repository name: $RepositoryUrl"
}

$PackagePath = (Resolve-Path -LiteralPath $PackagePath).Path
if ([IO.Path]::GetExtension($PackagePath) -ne '.zip') {
  throw "Release package must be a zip file: $PackagePath"
}

New-Item -ItemType Directory -Force -Path $ReportsRoot | Out-Null
Assert-PathInsideRoot $SandboxRoot $ReportsRoot 'recipient sandbox'
Assert-PathInsideRoot $DataRoot $ReportsRoot 'recipient user data'
Assert-PathInsideRoot $UpgradeRoot $ReportsRoot 'recipient upgrade sandbox'
Remove-Sandbox $SandboxRoot
Remove-Sandbox $DataRoot
Remove-Sandbox $UpgradeRoot
New-Item -ItemType Directory -Force -Path $SandboxRoot | Out-Null

try {
  Expand-Archive -LiteralPath $PackagePath -DestinationPath $SandboxRoot -Force
  $RuntimeRoot = Join-Path $SandboxRoot 'app-next\runtime'
  $SourcesRoot = Join-Path $DataRoot 'sources'
  $RuntimeScript = Join-Path $RuntimeRoot 'SkillHub.ps1'
  $WindowsPowerShell = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $env:AI_SKILLHUB_DATA_ROOT = $DataRoot
  $env:AI_SKILLHUB_CONFIG_PATH = Join-Path $DataRoot 'skillhub.config.json'
  $env:AI_SKILLHUB_ACTIVE_SKILLS = Join-Path $DataRoot 'skills'
  $env:AI_SKILLHUB_SOURCES = $SourcesRoot
  $env:AI_SKILLHUB_REPORTS = Join-Path $DataRoot 'reports'
  $env:AI_SKILLHUB_STATE = Join-Path $DataRoot 'state'

  $LegacySourceRoot = Join-Path $SandboxRoot 'app-next\data\github_sources\legacy-upgrade-skill'
  New-Item -ItemType Directory -Force -Path $LegacySourceRoot | Out-Null
  [IO.File]::WriteAllText(
    (Join-Path $LegacySourceRoot 'SKILL.md'),
    "---`nname: legacy-upgrade-skill`ndescription: Upgrade migration sentinel.`n---`n",
    [Text.UTF8Encoding]::new($false)
  )
  $AppPath = Join-Path $SandboxRoot 'AI SkillHub.exe'
  $MigrationApp = Start-Process -FilePath $AppPath -WorkingDirectory $SandboxRoot -WindowStyle Hidden -PassThru
  Start-Sleep -Seconds 10
  $MigrationAppStarted = -not $MigrationApp.HasExited
  Stop-SandboxProcesses $SandboxRoot
  Start-Sleep -Milliseconds 700
  $LegacyMigrated = Test-Path -LiteralPath (Join-Path $SourcesRoot 'legacy-upgrade-skill\SKILL.md') -PathType Leaf
  $MigrationManifestCreated = Test-Path -LiteralPath (Join-Path $DataRoot 'migration-v3.json') -PathType Leaf

  & $WindowsPowerShell -NoProfile -ExecutionPolicy Bypass -File $RuntimeScript -NoPull -ReportOnly | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'First-run report-only initialization failed.' }

  # This packaging/index test needs a complete checkout. Keep the long-path
  # override process-local: the real app can fall back to its selective codeload
  # importer, while this script must not mutate a recipient's global Git config.
  git -c core.longpaths=true clone --depth 1 $RepositoryUrl (Join-Path $SourcesRoot $RepositoryName) | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Public Skill repository clone failed.' }

  $ConfigPath = Join-Path $DataRoot 'skillhub.config.json'
  $Config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
  $Config.repositories = @(
    [pscustomobject]@{
      name = $RepositoryName
      url = $RepositoryUrl
      type = 'skill'
      category = 'general'
      enabled = $true
    }
  )
  [IO.File]::WriteAllText(
    $ConfigPath,
    (($Config | ConvertTo-Json -Depth 8) + [Environment]::NewLine),
    [Text.UTF8Encoding]::new($true)
  )

  & $WindowsPowerShell -NoProfile -ExecutionPolicy Bypass -File $RuntimeScript -NoPull | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Fresh-recipient Skill sync failed.' }

  $DatabasePath = Join-Path $DataRoot 'state\skillhub-next.sqlite3'
  if (Test-Path -LiteralPath $DatabasePath -PathType Leaf) {
    Remove-Item -LiteralPath $DatabasePath -Force
  }
  $App = Start-Process -FilePath $AppPath -WorkingDirectory $SandboxRoot -WindowStyle Hidden -PassThru
  Start-Sleep -Seconds 12
  $AppStarted = -not $App.HasExited
  Stop-SandboxProcesses $SandboxRoot
  Start-Sleep -Milliseconds 700

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

  $RepositoryNameSql = $RepositoryName.Replace("'", "''")
  $SourceCount = [int](& $SqliteExe $DatabasePath "SELECT COUNT(*) FROM sources WHERE lower(name)=lower('$RepositoryNameSql');")
  $OrphanRouterCount = [int](& $SqliteExe $DatabasePath 'SELECT COUNT(*) FROM skills WHERE source_id IS NULL AND COALESCE(is_router_hub, 0)=1;')
  $SourceId = [string](& $SqliteExe $DatabasePath "SELECT id FROM sources WHERE lower(name)=lower('$RepositoryNameSql') LIMIT 1;")
  if ([string]::IsNullOrWhiteSpace($SourceId)) { throw 'The indexed source id is missing.' }
  $SourceIdSql = $SourceId.Replace("'", "''")
  $SkillCount = [int](& $SqliteExe $DatabasePath "SELECT COUNT(*) FROM skills WHERE source_id='$SourceIdSql';")
  & $SqliteExe $DatabasePath "INSERT OR REPLACE INTO source_overrides (source_id, display_name, source_type, category_id, note, enabled, rating, updated_at) VALUES ('$SourceId','','','','',NULL,5,'recipient-upgrade-test');"
  if ($LASTEXITCODE -ne 0) { throw 'Could not seed a persistent parent rating.' }

  Expand-Archive -LiteralPath $PackagePath -DestinationPath $UpgradeRoot -Force
  $UpgradeAppPath = Join-Path $UpgradeRoot 'AI SkillHub.exe'
  $UpgradeApp = Start-Process -FilePath $UpgradeAppPath -WorkingDirectory $UpgradeRoot -WindowStyle Hidden -PassThru
  Start-Sleep -Seconds 10
  $UpgradeAppStarted = -not $UpgradeApp.HasExited
  Stop-SandboxProcesses $UpgradeRoot
  Start-Sleep -Milliseconds 700
  $PreservedRating = [int](& $SqliteExe $DatabasePath "SELECT rating FROM source_overrides WHERE source_id='$SourceId';")
  $PreservedSourceCount = [int](& $SqliteExe $DatabasePath "SELECT COUNT(*) FROM sources WHERE lower(name)=lower('$RepositoryNameSql');")

  $ConfigCreated = Test-Path -LiteralPath (Join-Path $DataRoot 'skillhub.config.json') -PathType Leaf
  $SyncReportCreated = Test-Path -LiteralPath (Join-Path $DataRoot 'reports\last-sync.md') -PathType Leaf
  $Passed = $MigrationAppStarted -and $LegacyMigrated -and $MigrationManifestCreated -and $AppStarted -and $UpgradeAppStarted -and $SourceCount -ge 1 -and $SkillCount -ge 1 -and $OrphanRouterCount -eq 0 -and $PreservedRating -eq 5 -and $PreservedSourceCount -ge 1 -and $ConfigCreated -and $SyncReportCreated

  $Result = [pscustomobject]@{
    package = Split-Path -Leaf $PackagePath
    repository = $RepositoryUrl
    migrationAppStarted = $MigrationAppStarted
    legacyDataMigrated = $LegacyMigrated
    migrationManifestCreated = $MigrationManifestCreated
    appStarted = $AppStarted
    upgradeAppStarted = $UpgradeAppStarted
    sourceCount = $SourceCount
    skillCount = $SkillCount
    orphanRouterCount = $OrphanRouterCount
    preservedParentRating = $PreservedRating
    preservedSourceCount = $PreservedSourceCount
    configCreated = $ConfigCreated
    syncReportCreated = $SyncReportCreated
    passed = $Passed
  }
  if (-not $Passed) {
    throw ('Fresh-recipient verification failed: ' + ($Result | ConvertTo-Json -Compress))
  }
} finally {
  Stop-SandboxProcesses $SandboxRoot
  Stop-SandboxProcesses $UpgradeRoot
  if (-not $KeepSandbox) {
    Remove-Sandbox $SandboxRoot
    Remove-Sandbox $DataRoot
    Remove-Sandbox $UpgradeRoot
  }
}

$Result | ConvertTo-Json -Depth 4
[pscustomobject]@{
  sandbox = $SandboxRoot
  sandboxDeleted = (-not (Test-Path -LiteralPath $SandboxRoot)) -and
    (-not (Test-Path -LiteralPath $DataRoot)) -and
    (-not (Test-Path -LiteralPath $UpgradeRoot))
} | ConvertTo-Json -Depth 2

if (-not $Passed) { exit 1 }
