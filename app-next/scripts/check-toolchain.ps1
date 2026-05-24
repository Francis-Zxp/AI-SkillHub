$ErrorActionPreference = "Stop"

function Get-CommandVersion {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string[]]$CommandArgs
  )

  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $command) {
    return [pscustomobject]@{
      Tool = $Name
      Found = $false
      Version = ""
      Path = ""
    }
  }

  $version = ""
  try {
    $version = (& $Name @CommandArgs 2>$null | Select-Object -First 1)
  } catch {
    $version = "found, version command failed"
  }

  [pscustomobject]@{
    Tool = $Name
    Found = $true
    Version = [string]$version
    Path = $command.Source
  }
}

$tools = @(
  (Get-CommandVersion -Name "node" -CommandArgs @("--version")),
  (Get-CommandVersion -Name "npm" -CommandArgs @("--version")),
  (Get-CommandVersion -Name "pnpm" -CommandArgs @("--version")),
  (Get-CommandVersion -Name "rustc" -CommandArgs @("--version")),
  (Get-CommandVersion -Name "cargo" -CommandArgs @("--version"))
)

$vswherePaths = @(
  "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe",
  "${env:ProgramFiles}\Microsoft Visual Studio\Installer\vswhere.exe"
)
$vswhere = $vswherePaths | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
$buildTools = $null
$buildToolsInfo = $null
if ($vswhere) {
  $buildToolsJson = & $vswhere -products * -requires Microsoft.VisualStudio.Workload.VCTools -format json 2>$null
  if ($buildToolsJson) {
    $buildToolsInfo = $buildToolsJson | ConvertFrom-Json | Select-Object -First 1
    if ($buildToolsInfo) {
      $buildTools = $buildToolsInfo.installationPath
    }
  }
}

$tools | Format-Table -AutoSize

Write-Host ""
if ($buildTools) {
  $buildToolsVersion = $buildToolsInfo.catalog.productDisplayVersion
  Write-Host "Visual Studio C++ Build Tools: detected version $buildToolsVersion at $buildTools"
} else {
  Write-Host "Visual Studio C++ Build Tools: not detected"
}

$missing = @()
foreach ($tool in $tools) {
  if (-not $tool.Found) { $missing += $tool.Tool }
}
if (-not $buildTools) { $missing += "Visual Studio C++ Build Tools" }

Write-Host ""
if ($missing.Count -eq 0) {
  Write-Host "AI SkillHub v2 toolchain is ready."
  exit 0
}

Write-Host "Missing: $($missing -join ', ')"
Write-Host "Read docs/toolchain-setup.md for install links."
exit 1
