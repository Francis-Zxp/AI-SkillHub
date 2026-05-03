$ErrorActionPreference = 'Continue'

$tasks = @(
  'AISkillHubDailyUpdate',
  'AISkillHubLogonUpdate',
  'ZxpGlobalSkillsDailyUpdate',
  'ZxpGlobalSkillsLogonUpdate'
)

foreach ($task in $tasks) {
  Write-Host "Removing scheduled task: $task"
  & schtasks.exe /Delete /TN $task /F
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
