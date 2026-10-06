# Read-only installation evidence shared by delivery and diagnostics. Never run
# an installer, an uninstall command, or a discovered application during a probe.
$script:AgentInstallRegistryRecords = $null

function Get-AgentRegistryExecutable($Record, [string[]]$ProductNames, [string[]]$ExecutableNames) {
  $displayName = ([string]$Record.DisplayName).Trim()
  $matchesProduct = $false
  foreach ($name in $ProductNames) {
    if ($displayName -match ('^' + [regex]::Escape($name) + '(?:\s+\d+(?:\.\d+){1,3}(?:[-+][a-zA-Z0-9.-]+)?)?$')) { $matchesProduct = $true; break }
  }
  if (-not $matchesProduct) { return '' }
  $icon = ([string]$Record.DisplayIcon).Trim()
  if ($icon -match '^"([^"]+\.exe)"(?:\s*,\s*-?\d+)?$' -or $icon -match '^([^"\r\n]+\.exe)(?:\s*,\s*-?\d+)?$') {
    $path = [Environment]::ExpandEnvironmentVariables($Matches[1].Trim())
    if ([IO.Path]::IsPathRooted($path) -and $ExecutableNames -contains [IO.Path]::GetFileName($path) -and
        (Test-Path -LiteralPath $path -PathType Leaf)) { return $path }
  }
  $location = [Environment]::ExpandEnvironmentVariables(([string]$Record.InstallLocation).Trim().Trim('"'))
  if ($location -and [IO.Path]::IsPathRooted($location)) {
    foreach ($name in $ExecutableNames) {
      $path = Join-Path $location $name
      if (Test-Path -LiteralPath $path -PathType Leaf) { return $path }
    }
  }
  return ''
}

function Get-AgentInstallRegistryRecords {
  if ($null -ne $script:AgentInstallRegistryRecords) { return $script:AgentInstallRegistryRecords }
  $records = [Collections.Generic.List[object]]::new()
  foreach ($root in @('HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\Microsoft\Windows\CurrentVersion\Uninstall', 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall')) {
    foreach ($key in @(Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue | Select-Object -First 4096)) {
      try {
        $records.Add([PSCustomObject]@{ DisplayName = $key.GetValue('DisplayName'); DisplayIcon = $key.GetValue('DisplayIcon'); InstallLocation = $key.GetValue('InstallLocation') })
      } catch { }
    }
  }
  $script:AgentInstallRegistryRecords = $records.ToArray()
  return $script:AgentInstallRegistryRecords
}

function Get-AgentDesktopExecutable([string]$LocalData, [string[]]$ProductNames, [string[]]$ExecutableNames, [string[]]$InstallFolders, [switch]$Isolated) {
  if (-not $Isolated) {
    foreach ($record in @(Get-AgentInstallRegistryRecords)) {
      $path = Get-AgentRegistryExecutable $record $ProductNames $ExecutableNames
      if ($path) { return $path }
    }
  }
  $roots = @((Join-Path $LocalData 'Programs'), $LocalData)
  if (-not $Isolated) {
    $roots += @($env:ProgramFiles, ${env:ProgramFiles(x86)}) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
  }
  foreach ($root in $roots) {
    foreach ($folder in $InstallFolders) {
      foreach ($name in $ExecutableNames) {
        $path = Join-Path (Join-Path $root $folder) $name
        if (Test-Path -LiteralPath $path -PathType Leaf) { return $path }
      }
    }
  }
  # An explicit HomePath is a fixture/recipient scope, not permission to inspect
  # the interactive user's registry, PATH, or running apps.
  if ($Isolated) { return '' }
  foreach ($name in $ExecutableNames) {
    foreach ($process in @(Get-Process -Name ([IO.Path]::GetFileNameWithoutExtension($name)) -ErrorAction SilentlyContinue)) {
      try {
        if ($process.Path -and $ExecutableNames -contains [IO.Path]::GetFileName($process.Path) -and
            (Test-Path -LiteralPath $process.Path -PathType Leaf)) { return $process.Path }
      } catch { }
    }
  }
  return ''
}

function Get-AgentCliExecutable([string]$Name, [switch]$Isolated) {
  if ($Isolated) { return '' }
  $command = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command -and (Test-Path -LiteralPath $command.Source -PathType Leaf)) { return $command.Source }
  return ''
}

function Get-WorkBuddyExecutable([string]$LocalData, [switch]$Isolated) {
  $path = Get-AgentDesktopExecutable $LocalData @('WorkBuddy', 'WorkBuddy AI', 'WorkBuddyAI') @('WorkBuddy.exe', 'WorkBuddyAI.exe') @('WorkBuddy', 'WorkBuddyAI', 'WorkBuddy AI') -Isolated:$Isolated
  if ($path) { return $path }
  return Get-AgentCliExecutable 'workbuddy' -Isolated:$Isolated
}

function Get-WorkBuddyConfigRoot([string]$HomeDirectory, [string]$Executable, [switch]$Isolated) {
  foreach ($name in @('WORKBUDDY_CONFIG_DIR', 'CODEBUDDY_CONFIG_DIR')) {
    $value = [Environment]::GetEnvironmentVariable($name, 'Process')
    if (-not [string]::IsNullOrWhiteSpace($value) -and [IO.Path]::IsPathRooted($value)) {
      $path = [IO.Path]::GetFullPath($value)
      $homePrefix = [IO.Path]::GetFullPath($HomeDirectory).TrimEnd('\', '/') + [IO.Path]::DirectorySeparatorChar
      if (-not $Isolated -or $path.StartsWith($homePrefix, [StringComparison]::OrdinalIgnoreCase)) { return $path }
    }
  }
  if ($Executable) {
    $productPath = Join-Path (Split-Path -Parent $Executable) 'resources\app.asar.unpacked\cli\product.json'
    try {
      $item = Get-Item -LiteralPath $productPath -ErrorAction Stop
      if ($item.Length -le 2MB) {
        $product = [IO.File]::ReadAllText($productPath) | ConvertFrom-Json
        $folder = [string]$product.dataFolderName
        if ($folder -match '^\.[a-zA-Z0-9_-]{1,63}$') {
          return Join-Path $HomeDirectory $folder
        }
      }
    } catch { }
  }
  return Join-Path $HomeDirectory '.workbuddy'
}
