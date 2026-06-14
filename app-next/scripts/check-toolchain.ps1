$ErrorActionPreference = "Stop"

function Add-PathEntries {
  param([string]$Value)

  if ([string]::IsNullOrWhiteSpace($Value)) {
    return
  }

  $current = $env:Path -split ';' | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  foreach ($entry in ($Value -split ';')) {
    if ([string]::IsNullOrWhiteSpace($entry)) {
      continue
    }
    if ($current -notcontains $entry) {
      $env:Path = "$env:Path;$entry"
      $current += $entry
    }
  }
}

Add-PathEntries ([Environment]::GetEnvironmentVariable('Path', 'User'))
Add-PathEntries ([Environment]::GetEnvironmentVariable('Path', 'Machine'))

function Get-CommandVersion {
  param(
    [Parameter(Mandatory = $true)][string]$Name,
    [Parameter(Mandatory = $true)][string[]]$CommandArgs
  )

  $command = Get-Command $Name -ErrorAction SilentlyContinue
  $source = ""
  $invokePath = $Name

  if (-not $command) {
    $fallbacks = @()
    if ($Name -in @("rustc", "cargo")) {
      $fallbacks += Join-Path $env:USERPROFILE ".cargo\bin\$Name.exe"
    }
    if ($Name -eq "pnpm") {
      $fallbacks += Join-Path $env:APPDATA "npm\pnpm.ps1"
      $fallbacks += Join-Path $env:APPDATA "npm\pnpm.cmd"
    }

    $fallback = $fallbacks | Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
    if (-not $fallback) {
      return [pscustomobject]@{
        Tool = $Name
        Found = $false
        Version = ""
        Path = ""
      }
    }

    $source = $fallback
    $invokePath = $fallback
  } else {
    $source = $command.Source
    $invokePath = $command.Source
  }

  $version = ""
  try {
    $version = (& $invokePath @CommandArgs 2>$null | Select-Object -First 1)
  } catch {
    $version = "found, version command failed"
  }

  [pscustomobject]@{
    Tool = $Name
    Found = $true
    Version = [string]$version
    Path = $source
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
  Write-Host "AI SkillHub toolchain is ready."
  exit 0
}

Write-Host "Missing: $($missing -join ', ')"
Write-Host "Read docs/toolchain-setup.md for install links."
exit 1
