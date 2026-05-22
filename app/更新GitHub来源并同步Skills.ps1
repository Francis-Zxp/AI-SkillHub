$ErrorActionPreference = 'Stop'
$AppRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$PowerShellExe = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
if (-not (Test-Path -LiteralPath $PowerShellExe)) {
  throw "Missing Windows PowerShell: $PowerShellExe"
}
& $PowerShellExe -NoProfile -ExecutionPolicy Bypass -File (Join-Path $AppRoot 'SkillHub.ps1')
