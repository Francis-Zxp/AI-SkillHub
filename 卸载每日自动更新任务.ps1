$ErrorActionPreference = 'Continue'

$tasks = @(
  'ZxpGlobalSkillsDailyUpdate',
  'ZxpGlobalSkillsLogonUpdate'
)

foreach ($task in $tasks) {
  Write-Host "Removing scheduled task: $task"
  & schtasks.exe /Delete /TN $task /F
}

$startupFile = Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs\Startup\ZxpSkillHubUpdate.cmd'
if (Test-Path -LiteralPath $startupFile) {
  Remove-Item -LiteralPath $startupFile -Force
  Write-Host "Removed startup file: $startupFile"
}
