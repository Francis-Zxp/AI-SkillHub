[CmdletBinding()]
param(
  [string]$Version = '',
  [switch]$SkipBuild
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$AppRoot = Split-Path -Parent $PSScriptRoot
$ProjectRoot = Split-Path -Parent $AppRoot
$TauriRoot = Join-Path $AppRoot 'src-tauri'
$ReleaseRoot = Join-Path $ProjectRoot 'release'
$ConfigPath = Join-Path $TauriRoot 'tauri.conf.json'
$PackagePath = Join-Path $AppRoot 'package.json'
$CargoPath = Join-Path $TauriRoot 'Cargo.toml'
$KeyRoot = Join-Path $env:USERPROFILE '.tauri'
$KeyPath = Join-Path $KeyRoot 'ai-skillhub.key'
$PasswordPath = Join-Path $KeyRoot 'ai-skillhub.password.dpapi'

function Get-ConfiguredVersion {
  $config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
  return [string]$config.version
}

function Assert-PathInside([string]$Path, [string]$Root, [string]$Label) {
  $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  $pathFull = [System.IO.Path]::GetFullPath($Path)
  if (-not $pathFull.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label is outside the allowed directory: $pathFull"
  }
}

function Get-ReleaseRustFlags {
  $flags = New-Object System.Collections.Generic.List[string]
  $existing = [Environment]::GetEnvironmentVariable('CARGO_ENCODED_RUSTFLAGS', 'Process')
  if (-not [string]::IsNullOrWhiteSpace($existing)) {
    foreach ($flag in ($existing -split [char]0x1f)) {
      if (-not [string]::IsNullOrWhiteSpace($flag)) { $flags.Add($flag) }
    }
  }

  $remaps = [ordered]@{}
  foreach ($entry in @(
    [PSCustomObject]@{ Path = $ProjectRoot; Target = '/workspace' },
    [PSCustomObject]@{ Path = $env:USERPROFILE; Target = '/user' },
    [PSCustomObject]@{ Path = $env:CARGO_HOME; Target = '/cargo-home' },
    [PSCustomObject]@{ Path = $env:RUSTUP_HOME; Target = '/rustup-home' }
  )) {
    if ([string]::IsNullOrWhiteSpace([string]$entry.Path)) { continue }
    $full = [System.IO.Path]::GetFullPath([string]$entry.Path).TrimEnd('\', '/')
    foreach ($source in @($full, $full.Replace('\', '/'))) {
      if (-not $remaps.Contains($source)) { $remaps[$source] = [string]$entry.Target }
    }
  }
  foreach ($source in $remaps.Keys) {
    $flags.Add("--remap-path-prefix=$source=$($remaps[$source])")
  }
  return $flags.ToArray()
}

function Assert-BinaryOmitsLocalPaths([string]$BinaryPath, [string[]]$Paths) {
  $bytes = [System.IO.File]::ReadAllBytes($BinaryPath)
  $latin1 = [System.Text.Encoding]::GetEncoding(28591).GetString($bytes)
  $utf16 = [System.Text.Encoding]::Unicode.GetString($bytes)
  foreach ($path in $Paths) {
    if ([string]::IsNullOrWhiteSpace($path)) { continue }
    $full = [System.IO.Path]::GetFullPath($path).TrimEnd('\', '/')
    foreach ($candidate in @($full, $full.Replace('\', '/'))) {
      if ($latin1.IndexOf($candidate, [System.StringComparison]::OrdinalIgnoreCase) -ge 0 -or
          $utf16.IndexOf($candidate, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
        throw "The release executable contains a local build path that must be remapped: $candidate"
      }
    }
  }
}

if ([string]::IsNullOrWhiteSpace($Version)) { $Version = Get-ConfiguredVersion }
if ($Version -notmatch '^\d+\.\d+\.\d+$') { throw "Release version must use x.y.z: $Version" }

$packageVersion = [string](Get-Content -LiteralPath $PackagePath -Raw -Encoding UTF8 | ConvertFrom-Json).version
$configuredVersion = Get-ConfiguredVersion
$cargoVersion = [regex]::Match(
  (Get-Content -LiteralPath $CargoPath -Raw -Encoding UTF8),
  '(?ms)^\[package\].*?^version\s*=\s*"([^"]+)"'
).Groups[1].Value
foreach ($pair in @(
  [PSCustomObject]@{ Name = 'tauri.conf.json'; Value = $configuredVersion },
  [PSCustomObject]@{ Name = 'package.json'; Value = $packageVersion },
  [PSCustomObject]@{ Name = 'Cargo.toml'; Value = $cargoVersion }
)) {
  if ($pair.Value -ne $Version) { throw "$($pair.Name) is $($pair.Value); expected $Version." }
}

if (-not (Test-Path -LiteralPath $KeyPath -PathType Leaf) -or
    -not (Test-Path -LiteralPath $PasswordPath -PathType Leaf)) {
  throw 'The local updater signing key is missing from the current Windows user .tauri directory.'
}

New-Item -ItemType Directory -Force -Path $ReleaseRoot | Out-Null
$securePassword = ConvertTo-SecureString (Get-Content -LiteralPath $PasswordPath -Raw -Encoding UTF8)
$passwordPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($securePassword)
try {
  $plainPassword = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($passwordPointer)
  $privateKey = Get-Content -LiteralPath $KeyPath -Raw -Encoding UTF8
  $env:TAURI_SIGNING_PRIVATE_KEY = $privateKey
  $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = $plainPassword

  if (-not $SkipBuild) {
    $previousEncodedRustFlags = [Environment]::GetEnvironmentVariable('CARGO_ENCODED_RUSTFLAGS', 'Process')
    $previousRustFlags = [Environment]::GetEnvironmentVariable('RUSTFLAGS', 'Process')
    if (-not [string]::IsNullOrWhiteSpace($previousRustFlags)) {
      throw 'Formal release builds require RUSTFLAGS to be unset; use CARGO_ENCODED_RUSTFLAGS for deterministic flags.'
    }
    try {
      $env:CARGO_ENCODED_RUSTFLAGS = (Get-ReleaseRustFlags) -join [char]0x1f
      Push-Location $AppRoot
      try {
        & pnpm tauri build --bundles nsis
        if ($LASTEXITCODE -ne 0) { throw 'The Tauri NSIS release build failed.' }
      } finally {
        Pop-Location
      }
    } finally {
      if ([string]::IsNullOrEmpty($previousEncodedRustFlags)) {
        Remove-Item Env:\CARGO_ENCODED_RUSTFLAGS -ErrorAction SilentlyContinue
      } else {
        $env:CARGO_ENCODED_RUSTFLAGS = $previousEncodedRustFlags
      }
    }
  }
} finally {
  Remove-Item Env:\TAURI_SIGNING_PRIVATE_KEY -ErrorAction SilentlyContinue
  Remove-Item Env:\TAURI_SIGNING_PRIVATE_KEY_PASSWORD -ErrorAction SilentlyContinue
  if ($passwordPointer -ne [IntPtr]::Zero) {
    [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($passwordPointer)
  }
  $privateKey = $null
  $plainPassword = $null
  $securePassword = $null
}

$BuiltExe = Join-Path $TauriRoot 'target\release\ai-skillhub-next.exe'
$builtVersion = ([string](Get-Item -LiteralPath $BuiltExe).VersionInfo.ProductVersion -split '[+-]')[0]
if ($builtVersion -ne $Version) { throw "The built executable is $builtVersion; expected $Version." }
Assert-BinaryOmitsLocalPaths $BuiltExe @($ProjectRoot, $env:USERPROFILE)

$NsisRoot = Join-Path $TauriRoot 'target\release\bundle\nsis'
$Installer = Get-ChildItem -LiteralPath $NsisRoot -Filter '*-setup.exe' -File |
  Sort-Object LastWriteTime -Descending |
  Select-Object -First 1
if (-not $Installer) { throw "No NSIS installer was found in $NsisRoot" }
$InstallerSignature = $Installer.FullName + '.sig'
if (-not (Test-Path -LiteralPath $InstallerSignature -PathType Leaf)) {
  throw "The installer signature is missing: $InstallerSignature"
}

$ReleaseInstaller = Join-Path $ReleaseRoot "AI-SkillHub-$Version-setup.exe"
$ReleaseSignature = $ReleaseInstaller + '.sig'
Assert-PathInside $ReleaseInstaller $ReleaseRoot 'Release installer'
Copy-Item -LiteralPath $Installer.FullName -Destination $ReleaseInstaller -Force
Copy-Item -LiteralPath $InstallerSignature -Destination $ReleaseSignature -Force

$global:LASTEXITCODE = 0
& (Join-Path $AppRoot 'runtime\Build-SkillHubReleasePackage.ps1') -Version $Version
if (-not $? -or $global:LASTEXITCODE -ne 0) {
  throw 'Portable packaging or developer-root refresh failed.'
}

$SignatureText = (Get-Content -LiteralPath $ReleaseSignature -Raw -Encoding UTF8).Trim()
$LatestJsonPath = Join-Path $ReleaseRoot 'latest.json'
$LatestPayload = [ordered]@{
  version = $Version
  notes = "AI SkillHub v${Version}: readable theme-aware editors, a geometrically centered volumetric atlas core, richer restrained space motion, honest local-index startup status, a GitHub project shortcut, immersive fullscreen, and preserved user data."
  pub_date = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ssZ')
  platforms = [ordered]@{
    'windows-x86_64' = [ordered]@{
      signature = $SignatureText
      url = "https://github.com/Francis-Zxp/AI-SkillHub/releases/download/v$Version/AI-SkillHub-$Version-setup.exe"
    }
  }
}
[System.IO.File]::WriteAllText(
  $LatestJsonPath,
  ($LatestPayload | ConvertTo-Json -Depth 8),
  [System.Text.UTF8Encoding]::new($false)
)

foreach ($artifact in @(
  $ReleaseInstaller,
  $ReleaseSignature,
  $LatestJsonPath,
  (Join-Path $ReleaseRoot "AI-SkillHub-$Version.zip")
)) {
  if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) { throw "Missing release artifact: $artifact" }
}

$installerHash = (Get-FileHash -LiteralPath $ReleaseInstaller -Algorithm SHA256).Hash
[System.IO.File]::WriteAllText(
  (Join-Path $ReleaseRoot "AI-SkillHub-$Version-setup.sha256.txt"),
  "$installerHash  $(Split-Path -Leaf $ReleaseInstaller)",
  [System.Text.UTF8Encoding]::new($false)
)

Write-Host "AI SkillHub v$Version release artifacts are ready."
Write-Host "Installer: $ReleaseInstaller"
Write-Host "Updater manifest: $LatestJsonPath"
Write-Host "Developer entry: $(Join-Path $ProjectRoot 'AI SkillHub.exe')"
