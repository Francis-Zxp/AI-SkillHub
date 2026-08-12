[CmdletBinding()]
param(
  [string]$ExpectedVersion = '',
  [string]$InstalledVersion = '',
  [switch]$RequireEveryChannel
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$AppRoot = Split-Path -Parent $PSScriptRoot
$ConfigPath = Join-Path $AppRoot 'src-tauri\tauri.conf.json'
$Config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
if ([string]::IsNullOrWhiteSpace($ExpectedVersion)) { $ExpectedVersion = [string]$Config.version }
if ($ExpectedVersion -notmatch '^\d+\.\d+\.\d+$') { throw "ExpectedVersion must use x.y.z: $ExpectedVersion" }
if ([string]::IsNullOrWhiteSpace($InstalledVersion)) { $InstalledVersion = $ExpectedVersion }
if ($InstalledVersion -notmatch '^\d+\.\d+\.\d+$') { throw "InstalledVersion must use x.y.z: $InstalledVersion" }

$ChannelNames = @('GitHub Release', 'Raw GitHub mirror', 'jsDelivr mirror')
$Channels = for ($index = 0; $index -lt @($Config.plugins.updater.endpoints).Count; $index++) {
  $endpoint = [string]$Config.plugins.updater.endpoints[$index]
  $uri = $endpoint.Replace('{{current_version}}', $InstalledVersion).Replace('{{target}}', 'windows-x86_64')
  [PSCustomObject]@{ Name = if ($index -lt $ChannelNames.Count) { $ChannelNames[$index] } else { "Updater channel $($index + 1)" }; Uri = $uri }
}
if ($Channels.Count -eq 0) { throw 'No updater endpoints are configured.' }

$Results = foreach ($Channel in $Channels) {
  try {
    $request = @{
      # This is the exact old-client URL from tauri.conf.json. Do not add a nonce:
      # cache-busting could hide a stale CDN response that real users still receive.
      Uri = $Channel.Uri
      Headers = @{ 'Cache-Control' = 'no-cache'; 'Pragma' = 'no-cache' }
      MaximumRedirection = 8
      TimeoutSec = 35
      UseBasicParsing = $true
    }
    $response = Invoke-WebRequest @request
    if ([int]$response.StatusCode -lt 200 -or [int]$response.StatusCode -ge 300) {
      throw "HTTP $($response.StatusCode)"
    }
    $content = if ($response.Content -is [byte[]]) {
      [System.Text.Encoding]::UTF8.GetString([byte[]]$response.Content)
    } else {
      [string]$response.Content
    }
    if ([string]::IsNullOrWhiteSpace($content) -or $content.Length -gt 256KB) {
      throw "manifest payload size is invalid: $($content.Length) bytes"
    }
    $manifest = $content | ConvertFrom-Json
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
Write-Output "Update channel health passed: $healthyCount/$($Channels.Count) signed manifests serve v$ExpectedVersion to installed v$InstalledVersion clients."
