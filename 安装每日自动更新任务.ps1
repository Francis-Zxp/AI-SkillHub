$ErrorActionPreference = 'Stop'

$base = Split-Path -Parent $MyInvocation.MyCommand.Path
$skillHub = Join-Path $base 'SkillHub.ps1'

if (-not (Test-Path -LiteralPath $skillHub)) {
  throw "Missing SkillHub script: $skillHub"
}

$dailyTask = 'ZxpGlobalSkillsDailyUpdate'
$launcherDir = 'D:\ZxpSkillHubLauncher'
$launcher = Join-Path $launcherDir 'run-skillhub.cmd'

New-Item -ItemType Directory -Force -Path $launcherDir | Out-Null
@"
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "$skillHub"
"@ | Set-Content -LiteralPath $launcher -Encoding ASCII

& schtasks.exe /Query /TN $dailyTask *> $null
if ($LASTEXITCODE -eq 0) {
  Write-Host "Scheduled task already exists: $dailyTask"
  $dailyExit = 0
} else {
  Write-Host "Installing scheduled task: $dailyTask"
  & schtasks.exe /Create /TN $dailyTask /SC DAILY /ST 09:00 /TR $launcher /F
  $dailyExit = $LASTEXITCODE
}

Write-Host ''
Write-Host 'Installed SkillHub auto update:'
if ($dailyExit -eq 0) {
  Write-Host "- ${dailyTask}: every day at 09:00"
} else {
  Write-Host "- ${dailyTask}: failed to install"
}
Write-Host "Launcher: $launcher"
