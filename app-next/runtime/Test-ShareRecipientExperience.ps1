[CmdletBinding()]
param(
  [switch]$Quiet,
  [switch]$KeepSandbox
)

$ErrorActionPreference = 'Stop'
$Utf8Bom = [System.Text.UTF8Encoding]::new($true)
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$RuntimeRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$V2Root = Split-Path -Parent $RuntimeRoot
$ProjectRoot = Split-Path -Parent $V2Root
$ReportsRoot = Join-Path $V2Root 'reports\share-recipient-test'
$Stamp = Get-Date -Format 'yyyyMMdd_HHmmss_fff'
$RunRoot = Join-Path $ReportsRoot $Stamp
$SandboxRoot = Join-Path $RunRoot 'AI SkillHub 分享验收 用户 路径'
$SandboxV2 = Join-Path $SandboxRoot 'app-next'
$SandboxRuntime = Join-Path $SandboxV2 'runtime'
$Cases = New-Object System.Collections.Generic.List[object]

function Write-Utf8Bom([string]$Path, [string]$Text) {
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Path) | Out-Null
  [System.IO.File]::WriteAllText($Path, $Text, $script:Utf8Bom)
}
function Add-Case([string]$Name, [bool]$Ok, [string]$Detail) {
  $script:Cases.Add([PSCustomObject]@{ name = $Name; ok = $Ok; status = if ($Ok) { 'ok' } else { 'error' }; detail = $Detail }) | Out-Null
}
function Copy-FileRequired([string]$Source, [string]$Destination) {
  if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) { throw "缺少文件：$Source" }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
  Copy-Item -LiteralPath $Source -Destination $Destination -Force
}
function Copy-DirRequired([string]$Source, [string]$Destination) {
  if (-not (Test-Path -LiteralPath $Source -PathType Container)) { throw "缺少目录：$Source" }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
  Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
}
function Copy-DirContentsRequired([string]$Source, [string]$Destination, [string[]]$ExcludeNames = @()) {
  if (-not (Test-Path -LiteralPath $Source -PathType Container)) { throw "缺少目录：$Source" }
  New-Item -ItemType Directory -Force -Path $Destination | Out-Null
  Get-ChildItem -LiteralPath $Source -Force | Where-Object {
    $ExcludeNames -notcontains $_.Name
  } | ForEach-Object {
    Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $Destination $_.Name) -Recurse -Force
  }
}
function Invoke-Captured([string]$FileName, [string]$Arguments, [string]$WorkingDirectory) {
  $psi = [System.Diagnostics.ProcessStartInfo]::new()
  $psi.FileName = $FileName
  $psi.Arguments = $Arguments
  $psi.WorkingDirectory = $WorkingDirectory
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
  $p = [System.Diagnostics.Process]::Start($psi)
  $stdout = $p.StandardOutput.ReadToEnd()
  $stderr = $p.StandardError.ReadToEnd()
  $p.WaitForExit()
  return [PSCustomObject]@{ ok = ($p.ExitCode -eq 0); exitCode = $p.ExitCode; stdout = $stdout; stderr = $stderr }
}

function Assert-PathInsideRoot([string]$Path, [string]$Root, [string]$Label) {
  $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
  $targetFull = [System.IO.Path]::GetFullPath($Path).TrimEnd('\')
  if ($targetFull -eq $rootFull.TrimEnd('\') -or -not $targetFull.StartsWith($rootFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "$Label 路径不在预期目录内：$targetFull"
  }
}

Assert-PathInsideRoot $RunRoot $ReportsRoot '分享验收临时目录'
New-Item -ItemType Directory -Force -Path $SandboxRoot, $SandboxV2, $SandboxRuntime | Out-Null
try {
  Copy-FileRequired (Join-Path $ProjectRoot 'AI SkillHub.exe') (Join-Path $SandboxRoot 'AI SkillHub.exe')
  foreach ($file in @('README.md', 'CHANGELOG.md', '使用说明.md')) {
    $source = Join-Path $ProjectRoot $file
    if (Test-Path -LiteralPath $source -PathType Leaf) { Copy-FileRequired $source (Join-Path $SandboxRoot $file) }
  }
  Copy-DirContentsRequired $RuntimeRoot $SandboxRuntime @('skillhub.config.json')
  New-Item -ItemType Directory -Force -Path (Join-Path $SandboxRoot 'skills'), (Join-Path $SandboxV2 'data') | Out-Null
  Add-Case 'clean-copy' $true '已复制 AI SkillHub 最小运行结构。'
} catch {
  Add-Case 'clean-copy' $false $_.Exception.Message
}

$forbiddenFound = @()
foreach ($relative in @('app', 'app-next\data\github_sources', 'app-next\reports', 'app-next\runtime\skillhub.config.json')) {
  if (Test-Path -LiteralPath (Join-Path $SandboxRoot $relative)) { $forbiddenFound += $relative }
}
Add-Case 'privacy-shape' ($forbiddenFound.Count -eq 0) ('forbidden=' + ($forbiddenFound -join ', '))
Add-Case 'portable-path' (($SandboxRoot -match '\s') -and ($SandboxRoot -match '[^\x00-\x7F]')) $SandboxRoot

try {
  $ps = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $script = Join-Path $SandboxRuntime 'SkillHub.ps1'
  $run = Invoke-Captured $ps ('-NoProfile -ExecutionPolicy Bypass -File "' + $script + '" -NoPull -ReportOnly') $SandboxRuntime
  $configOk = Test-Path -LiteralPath (Join-Path $SandboxRuntime 'skillhub.config.json') -PathType Leaf
  $reportOk = Test-Path -LiteralPath (Join-Path $SandboxV2 'reports\last-sync.md') -PathType Leaf
  Add-Case 'first-run-report-only' ($run.ok -and $configOk -and $reportOk) ("exit=$($run.exitCode); config=$configOk; report=$reportOk")
} catch {
  Add-Case 'first-run-report-only' $false $_.Exception.Message
}

$failed = @($Cases | Where-Object { -not $_.ok })
$payload = [PSCustomObject]@{ ok = ($failed.Count -eq 0); generatedAt = (Get-Date).ToString('o'); sandboxRoot = $SandboxRoot; cases = $Cases }
$json = Join-Path $RunRoot 'share-recipient-test.json'
$md = Join-Path $RunRoot 'share-recipient-test.md'
Write-Utf8Bom $json ($payload | ConvertTo-Json -Depth 8)
Copy-Item -LiteralPath $json -Destination (Join-Path $ReportsRoot 'latest-share-recipient-test.json') -Force
$lines = @('# AI SkillHub 分享版真实验收', '', "- 状态：$(if ($payload.ok) { '通过' } else { '失败' })", "- 临时用户路径：$SandboxRoot", '', '| 场景 | 结果 | 细节 |', '|---|---|---|')
foreach ($case in $Cases) { $lines += "| $($case.name) | $(if ($case.ok) { '通过' } else { '失败' }) | $($case.detail.Replace('|','/')) |" }
Write-Utf8Bom $md ($lines -join [Environment]::NewLine)
Copy-Item -LiteralPath $md -Destination (Join-Path $ReportsRoot 'latest-share-recipient-test.md') -Force
if (-not $Quiet) { Write-Host "AI SkillHub 分享验收报告：$md" }
if (-not $KeepSandbox -and $payload.ok) { Remove-Item -LiteralPath $RunRoot -Recurse -Force -ErrorAction SilentlyContinue }
if ($failed.Count -gt 0) { exit 1 }
