[CmdletBinding()]
param(
  [string]$Version = '',
  [string]$PreviousVersion = '3.2.1',
  [string]$ReleaseNotes = '',
  [switch]$SkipBuild,
  [string]$ExistingInstallerPath = '',
  [string]$ExpectedInstallerSha256 = '',
  [switch]$PublishFallbackManifest
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$AppRoot = Split-Path -Parent $PSScriptRoot
$ProjectRoot = Split-Path -Parent $AppRoot
$TauriRoot = Join-Path $AppRoot 'src-tauri'
$ReleaseRoot = Join-Path $ProjectRoot 'release'
$UpdatesRoot = Join-Path $ProjectRoot 'updates'
$ConfigPath = Join-Path $TauriRoot 'tauri.conf.json'
$PackagePath = Join-Path $AppRoot 'package.json'
$CargoPath = Join-Path $TauriRoot 'Cargo.toml'
$CargoLockPath = Join-Path $TauriRoot 'Cargo.lock'
$ChangelogPath = Join-Path $ProjectRoot 'CHANGELOG.md'
$PreviewPath = Join-Path $AppRoot 'src\preview.ts'
$I18nPath = Join-Path $AppRoot 'src\i18n.ts'
$NsisUpgradeTestPath = Join-Path $AppRoot 'scripts\test-nsis-install-upgrade.ps1'
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

function Assert-FileContains([string]$Path, [string]$Pattern, [string]$Label) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "$Label is missing: $Path"
  }
  $content = Get-Content -LiteralPath $Path -Raw -Encoding UTF8
  if ($content -notmatch $Pattern) {
    throw "$Label is not aligned with release v${Version}: $Path"
  }
}

function Get-NormalizedProductVersion([string]$Path) {
  $productVersion = [string](Get-Item -LiteralPath $Path).VersionInfo.ProductVersion
  return ($productVersion -split '[+-]')[0]
}

function Assert-SignedInstaller([string]$Path, [string]$ExpectedVersion) {
  if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
    throw "The NSIS installer is missing: $Path"
  }
  if ((Split-Path -Leaf $Path) -notlike '*-setup.exe') {
    throw "The selected NSIS installer does not use the expected *-setup.exe name: $Path"
  }
  $productVersion = Get-NormalizedProductVersion $Path
  if ($productVersion -ne $ExpectedVersion) {
    throw "The selected NSIS installer is v$productVersion; expected v$ExpectedVersion`: $Path"
  }
  $signaturePath = $Path + '.sig'
  if (-not (Test-Path -LiteralPath $signaturePath -PathType Leaf) -or
      (Get-Item -LiteralPath $signaturePath).Length -le 0) {
    throw "The installer signature is missing or empty: $signaturePath"
  }
  if ([string]::IsNullOrWhiteSpace((Get-Content -LiteralPath $signaturePath -Raw -Encoding UTF8))) {
    throw "The installer signature contains no signature text: $signaturePath"
  }
  return $signaturePath
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
if ($PreviousVersion -notmatch '^\d+\.\d+\.\d+$') { throw "Previous release version must use x.y.z: $PreviousVersion" }
if ([string]::IsNullOrWhiteSpace($ReleaseNotes)) {
  $ReleaseNotes = "AI SkillHub v${Version}: signed stable update with preserved local user data."
}

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

$escapedVersion = [regex]::Escape($Version)
Assert-FileContains $CargoLockPath "(?ms)^\[\[package\]\]\s*name\s*=\s*`"ai-skillhub-next`"\s*version\s*=\s*`"$escapedVersion`"" 'Cargo.lock root package version'
Assert-FileContains $ChangelogPath "(?m)^##\s+$escapedVersion(?:\s|$)" 'CHANGELOG release heading'
Assert-FileContains (Join-Path $ProjectRoot "docs\release-notes\v$Version.md") "(?m)^#\s+AI SkillHub v$escapedVersion\s*$" 'release notes'
Assert-FileContains $PreviewPath "appVersion:\s*`"$escapedVersion preview`"" 'preview app version'
Assert-FileContains $I18nPath "`"atlas\.releaseTag`":\s*`"$escapedVersion\s+\u00B7" 'visible atlas release tag'
Assert-FileContains $NsisUpgradeTestPath "\[string\]\`$ExpectedVersion\s*=\s*'$escapedVersion'" 'NSIS upgrade expected version'
$escapedPreviousVersion = [regex]::Escape($PreviousVersion)
Assert-FileContains $NsisUpgradeTestPath "\[string\]\`$PreviousExpectedVersion\s*=\s*'$escapedPreviousVersion'" 'NSIS previous upgrade version'

if ($SkipBuild) {
  if ([string]::IsNullOrWhiteSpace($ExistingInstallerPath)) {
    throw 'SkipBuild requires -ExistingInstallerPath; implicit newest-installer selection is forbidden.'
  }
  if ($ExpectedInstallerSha256 -notmatch '^[0-9A-Fa-f]{64}$') {
    throw 'SkipBuild requires a 64-character -ExpectedInstallerSha256 for the explicitly selected installer.'
  }
} elseif (-not [string]::IsNullOrWhiteSpace($ExistingInstallerPath) -or
          -not [string]::IsNullOrWhiteSpace($ExpectedInstallerSha256)) {
  throw '-ExistingInstallerPath and -ExpectedInstallerSha256 are only valid together with -SkipBuild.'
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
    $buildStartedAtUtc = [DateTime]::UtcNow.AddSeconds(-2)
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
$builtVersion = Get-NormalizedProductVersion $BuiltExe
if ($builtVersion -ne $Version) { throw "The built executable is $builtVersion; expected $Version." }
Assert-BinaryOmitsLocalPaths $BuiltExe @($ProjectRoot, $env:USERPROFILE)

$NsisRoot = Join-Path $TauriRoot 'target\release\bundle\nsis'
if (-not (Test-Path -LiteralPath $NsisRoot -PathType Container)) {
  throw "The NSIS bundle directory is missing: $NsisRoot"
}
$signedVersionCandidates = @(
  Get-ChildItem -LiteralPath $NsisRoot -Filter '*-setup.exe' -File | Where-Object {
    (Get-NormalizedProductVersion $_.FullName) -eq $Version -and
    (Test-Path -LiteralPath ($_.FullName + '.sig') -PathType Leaf) -and
    (Get-Item -LiteralPath ($_.FullName + '.sig')).Length -gt 0
  }
)
if ($signedVersionCandidates.Count -ne 1) {
  $candidateNames = @($signedVersionCandidates | ForEach-Object { $_.Name }) -join ', '
  throw "Expected exactly one signed NSIS installer with ProductVersion $Version in $NsisRoot; found $($signedVersionCandidates.Count): $candidateNames"
}
$Installer = $signedVersionCandidates[0]
if ($SkipBuild) {
  $explicitInstaller = [System.IO.Path]::GetFullPath($ExistingInstallerPath)
  Assert-PathInside $explicitInstaller $NsisRoot 'Existing installer'
  if (-not $explicitInstaller.Equals($Installer.FullName, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "The explicit installer is not the unique signed v$Version candidate: $explicitInstaller"
  }
  $actualInstallerHash = (Get-FileHash -LiteralPath $Installer.FullName -Algorithm SHA256).Hash
  if ($actualInstallerHash -ne $ExpectedInstallerSha256.ToUpperInvariant()) {
    throw "The explicit installer SHA-256 is $actualInstallerHash; expected $($ExpectedInstallerSha256.ToUpperInvariant())."
  }
} elseif ($Installer.LastWriteTimeUtc -lt $buildStartedAtUtc -or
          (Get-Item -LiteralPath ($Installer.FullName + '.sig')).LastWriteTimeUtc -lt $buildStartedAtUtc) {
  throw "The signed v$Version installer was not freshly produced by this build: $($Installer.FullName)"
}
$InstallerSignature = Assert-SignedInstaller $Installer.FullName $Version

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
$FallbackLatestJsonPath = Join-Path $UpdatesRoot 'latest.json'
$LatestPayload = [ordered]@{
  version = $Version
  notes = $ReleaseNotes
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
if ($PublishFallbackManifest) {
  New-Item -ItemType Directory -Force -Path $UpdatesRoot | Out-Null
  [System.IO.File]::WriteAllText(
    $FallbackLatestJsonPath,
    ($LatestPayload | ConvertTo-Json -Depth 8),
    [System.Text.UTF8Encoding]::new($false)
  )
}

foreach ($artifact in @(
  $ReleaseInstaller,
  $ReleaseSignature,
  $LatestJsonPath,
  (Join-Path $ReleaseRoot "AI-SkillHub-$Version.zip")
)) {
  if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) { throw "Missing release artifact: $artifact" }
}
if ($PublishFallbackManifest -and -not (Test-Path -LiteralPath $FallbackLatestJsonPath -PathType Leaf)) {
  throw "Missing fallback updater manifest: $FallbackLatestJsonPath"
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
if ($PublishFallbackManifest) {
  Write-Host "Fallback updater manifest published: $FallbackLatestJsonPath"
} else {
  Write-Host 'Fallback updater manifest unchanged; publish it only after the public release assets pass verification.'
}
Write-Host "Developer entry: $(Join-Path $ProjectRoot 'AI SkillHub.exe')"
