$ErrorActionPreference = 'Continue'

$tasks = @(
  'AISkillHubDailyUpdate',
  'AISkillHubLogonUpdate',
  'ZxpGlobalSkillsDailyUpdate',
  'ZxpGlobalSkillsLogonUpdate'
)

$SchtasksExe = Join-Path $env:WINDIR 'System32\schtasks.exe'
if (-not (Test-Path -LiteralPath $SchtasksExe)) {
  throw "Missing schtasks: $SchtasksExe"
}

foreach ($task in $tasks) {
  Write-Host "Removing scheduled task: $task"
  & $SchtasksExe /Delete /TN $task /F
}

$startupFiles = @(
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\AISkillHubUpdate.cmd'),
  (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\ZxpSkillHubUpdate.cmd')
)
foreach ($startupFile in $startupFiles) {
  if (Test-Path -LiteralPath $startupFile) {
    Remove-Item -LiteralPath $startupFile -Force
    Write-Host "Removed startup file: $startupFile"
  }
}
