[CmdletBinding()]
param(
  [string]$ExpectedVersion = '',
  [switch]$RequireEveryChannel
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$AppRoot = Split-Path -Parent $PSScriptRoot
$ConfigPath = Join-Path $AppRoot 'src-tauri\tauri.conf.json'
$Config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($ExpectedVersion)) { $ExpectedVersion = [string]$Config.version }
if ($ExpectedVersion -notmatch '^\d+\.\d+\.\d+$') { throw "ExpectedVersion must use x.y.z: $ExpectedVersion" }

$Channels = @(
  [PSCustomObject]@{ Name = 'GitHub Release'; Uri = 'https://github.com/Francis-Zxp/AI-SkillHub/releases/latest/download/latest.json' },
  [PSCustomObject]@{ Name = 'Raw GitHub mirror'; Uri = 'https://raw.githubusercontent.com/Francis-Zxp/AI-SkillHub/main/updates/latest.json' },
  [PSCustomObject]@{ Name = 'jsDelivr mirror'; Uri = 'https://cdn.jsdelivr.net/gh/Francis-Zxp/AI-SkillHub@main/updates/latest.json' }
)

$Results = foreach ($Channel in $Channels) {
  try {
    $nonce = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
    $separator = if ($Channel.Uri.Contains('?')) { '&' } else { '?' }
    $request = @{
      Uri = "$($Channel.Uri)$separator`installed=$ExpectedVersion&channel=stable&probe=$nonce"
      Headers = @{ 'Cache-Control' = 'no-cache'; 'Pragma' = 'no-cache' }
      MaximumRedirection = 8
      TimeoutSec = 35
      UseBasicParsing = $true
    }
    $response = Invoke-WebRequest @request
    if ([int]$response.StatusCode -lt 200 -or [int]$response.StatusCode -ge 300) {
      throw "HTTP $($response.StatusCode)"
    }
    $manifest = $response.Content | ConvertFrom-Json
    if ([string]$manifest.version -ne $ExpectedVersion) {
      throw "manifest version $($manifest.version), expected $ExpectedVersion"
    }
    $windows = $manifest.platforms.'windows-x86_64'
    if (-not $windows -or [string]::IsNullOrWhiteSpace([string]$windows.signature)) {
      throw 'windows-x86_64 signature is missing'
    }
    $expectedAsset = "https://github.com/Francis-Zxp/AI-SkillHub/releases/download/v$ExpectedVersion/AI-SkillHub-$ExpectedVersion-setup.exe"
    if ([string]$windows.url -ne $expectedAsset) {
      throw "unexpected installer URL: $($windows.url)"
    }
    [PSCustomObject]@{ Channel = $Channel.Name; Healthy = $true; Detail = "v$ExpectedVersion" }
  } catch {
    [PSCustomObject]@{ Channel = $Channel.Name; Healthy = $false; Detail = $_.Exception.Message }
  }
}

$Results | Format-Table -AutoSize | Out-String | Write-Output
$healthyCount = @($Results | Where-Object Healthy).Count
if ($RequireEveryChannel -and $healthyCount -ne $Channels.Count) {
  throw "Only $healthyCount/$($Channels.Count) update channels are healthy."
}
if ($healthyCount -lt 2) {
  throw "Only $healthyCount/$($Channels.Count) update channels are healthy; at least two are required."
}
Write-Output "Update channel health passed: $healthyCount/$($Channels.Count) signed manifests serve v$ExpectedVersion."
