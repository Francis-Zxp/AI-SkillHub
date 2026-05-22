$ErrorActionPreference = 'Stop'

$AppRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$SkillHub = Join-Path $AppRoot 'SkillHub.ps1'

if (-not (Test-Path -LiteralPath $SkillHub)) {
  throw "Missing SkillHub script: $SkillHub"
}

$DailyTask = 'AISkillHubDailyUpdate'
$LauncherDir = 'D:\AISkillHubLauncher'
$Launcher = Join-Path $LauncherDir 'run-skillhub.cmd'
$PowerShellExe = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
$SchtasksExe = Join-Path $env:WINDIR 'System32\schtasks.exe'

if (-not (Test-Path -LiteralPath $PowerShellExe)) {
  throw "Missing Windows PowerShell: $PowerShellExe"
}
if (-not (Test-Path -LiteralPath $SchtasksExe)) {
  throw "Missing schtasks: $SchtasksExe"
}

New-Item -ItemType Directory -Force -Path $LauncherDir | Out-Null
$cmd = "@echo off`r`n`"$PowerShellExe`" -NoProfile -ExecutionPolicy Bypass -File `"$SkillHub`"`r`n"
[System.IO.File]::WriteAllText($Launcher, $cmd, [System.Text.Encoding]::ASCII)

Write-Host "Installing scheduled task: $DailyTask"
& $SchtasksExe /Create /TN $DailyTask /SC DAILY /ST 09:00 /TR $Launcher /F
$dailyExit = $LASTEXITCODE

Write-Host ''
Write-Host 'Installed SkillHub auto update:'
if ($dailyExit -eq 0) {
  Write-Host "- ${DailyTask}: every day at 09:00"
} else {
  Write-Host "- ${DailyTask}: failed to install"
}
Write-Host "Launcher: $Launcher"
exit $dailyExit
