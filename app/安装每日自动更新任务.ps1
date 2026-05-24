$ErrorActionPreference = 'Stop'

$AppRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$SkillHub = Join-Path $AppRoot 'SkillHub.ps1'

if (-not (Test-Path -LiteralPath $SkillHub)) {
  throw "Missing SkillHub script: $SkillHub"
}

$DailyTask = 'AISkillHubDailyUpdate'
$PowerShellExe = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$SchtasksExe = Join-Path $env:WINDIR 'System32\schtasks.exe'

if (-not (Test-Path -LiteralPath $PowerShellExe)) {
  throw "Missing Windows PowerShell: $PowerShellExe"
}
if (-not (Test-Path -LiteralPath $SchtasksExe)) {
  throw "Missing schtasks: $SchtasksExe"
}

$taskCommand = "`"$PowerShellExe`" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$SkillHub`""
$taskArguments = "-NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File `"$SkillHub`""

Write-Host "Installing scheduled task: $DailyTask"
if (Get-Command New-ScheduledTaskAction -ErrorAction SilentlyContinue) {
  $action = New-ScheduledTaskAction -Execute $PowerShellExe -Argument $taskArguments
  $trigger = New-ScheduledTaskTrigger -Daily -At 09:00
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $DailyTask -Action $action -Trigger $trigger -Settings $settings -Description 'AI SkillHub daily source sync' -Force | Out-Null
  $dailyExit = 0
} else {
  $escapedTaskCommand = ('\"{0}\" -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \"{1}\"' -f $PowerShellExe, $SkillHub)
  & $SchtasksExe /Create /TN $DailyTask /SC DAILY /ST 09:00 /TR $escapedTaskCommand /F
  $dailyExit = $LASTEXITCODE
}

Write-Host ''
Write-Host 'Installed SkillHub auto update:'
if ($dailyExit -eq 0) {
  Write-Host "- ${DailyTask}: every day at 09:00"
} else {
  Write-Host "- ${DailyTask}: failed to install"
}
Write-Host "Task command: $taskCommand"
exit $dailyExit
