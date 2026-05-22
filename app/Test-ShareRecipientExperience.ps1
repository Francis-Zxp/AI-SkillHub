[CmdletBinding()]
param(
  [switch]$Quiet,
  [switch]$KeepSandbox
)

$ErrorActionPreference = 'Stop'
$Utf8NoBom = [System.Text.UTF8Encoding]::new($false)
$Utf8Bom = [System.Text.UTF8Encoding]::new($true)
[Console]::OutputEncoding = $Utf8NoBom
$OutputEncoding = $Utf8NoBom

$AppRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $AppRoot
$ReportsRoot = Join-Path $AppRoot 'reports'
$TestRoot = Join-Path $ReportsRoot 'share-recipient-test'
$Stamp = Get-Date -Format 'yyyyMMdd_HHmmss_fff'
$RunRoot = Join-Path $TestRoot $Stamp
$SandboxRoot = Join-Path $RunRoot 'AI SkillHub 分享验收 用户 路径'
$SandboxApp = Join-Path $SandboxRoot 'app'
$Cases = New-Object System.Collections.Generic.List[object]

New-Item -ItemType Directory -Force -Path $RunRoot, $SandboxRoot, $SandboxApp | Out-Null

function Write-Utf8Bom([string]$Path, [string]$Text) {
  $parent = Split-Path -Parent $Path
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  [System.IO.File]::WriteAllText($Path, $Text, $script:Utf8Bom)
}

function Copy-RequiredFile([string]$Source, [string]$Destination) {
  if (-not (Test-Path -LiteralPath $Source -PathType Leaf)) {
    throw "缺少发布必需文件：$Source"
  }
  $parent = Split-Path -Parent $Destination
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  Copy-Item -LiteralPath $Source -Destination $Destination -Force
}

function Copy-RequiredDirectory([string]$Source, [string]$Destination) {
  if (-not (Test-Path -LiteralPath $Source -PathType Container)) {
    throw "缺少发布必需目录：$Source"
  }
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $Destination) | Out-Null
  Copy-Item -LiteralPath $Source -Destination $Destination -Recurse -Force
}

function Add-Case([string]$Name, [bool]$Ok, [string]$Status, [string]$Detail, [string]$Fix) {
  $script:Cases.Add([PSCustomObject]@{
    name = $Name
    ok = $Ok
    status = $Status
    detail = $Detail
    fix = $Fix
  }) | Out-Null
}

function Get-CaseStatus([bool]$Ok) {
  if ($Ok) { return 'ok' }
  return 'error'
}

function Invoke-CapturedProcess([string]$Name, [string]$FileName, [string]$Arguments, [string]$WorkingDirectory) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = $FileName
  $psi.Arguments = $Arguments
  $psi.WorkingDirectory = $WorkingDirectory
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true
  $psi.StandardOutputEncoding = [System.Text.Encoding]::UTF8
  $psi.StandardErrorEncoding = [System.Text.Encoding]::UTF8
  try {
    $p = [System.Diagnostics.Process]::Start($psi)
    $stdout = $p.StandardOutput.ReadToEnd()
    $stderr = $p.StandardError.ReadToEnd()
    $p.WaitForExit()
    return [PSCustomObject]@{
      name = $Name
      ok = ($p.ExitCode -eq 0)
      exitCode = $p.ExitCode
      stdout = $stdout
      stderr = $stderr
    }
  } catch {
    return [PSCustomObject]@{
      name = $Name
      ok = $false
      exitCode = -1
      stdout = ''
      stderr = $_.Exception.Message
    }
  }
}

function Get-CheckStatus($Payload, [string]$Id) {
  $match = @($Payload.checks | Where-Object { $_.id -eq $Id } | Select-Object -First 1)
  if ($match.Count -eq 0) { return '' }
  return [string]$match[0].status
}

function Run-DiagnosticsCase([string]$Name, [string]$ExtraArgs, [string[]]$ExpectedOverall, [hashtable]$ExpectedChecks) {
  $diag = Join-Path $script:SandboxApp 'Export-SkillHubDiagnostics.ps1'
  $ps = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $args = '-NoProfile -ExecutionPolicy Bypass -File "' + $diag + '" -Quiet'
  if (-not [string]::IsNullOrWhiteSpace($ExtraArgs)) { $args += ' ' + $ExtraArgs }
  $run = Invoke-CapturedProcess $Name $ps $args $script:SandboxApp
  $latest = Join-Path $script:SandboxApp 'reports\latest-diagnostics.json'
  if (-not (Test-Path -LiteralPath $latest -PathType Leaf)) {
    Add-Case $Name $false 'error' '没有生成 latest-diagnostics.json。' '检查诊断脚本是否可以在干净发布目录中运行。'
    return
  }

  $payload = Get-Content -LiteralPath $latest -Raw -Encoding UTF8 | ConvertFrom-Json
  $ok = $run.ok -and ($ExpectedOverall -contains [string]$payload.overallStatus)
  $details = New-Object System.Collections.Generic.List[string]
  $details.Add("overall=$($payload.overallStatus)") | Out-Null
  $details.Add("scenario=$($payload.scenario.name)") | Out-Null

  foreach ($key in $ExpectedChecks.Keys) {
    $actual = Get-CheckStatus $payload ([string]$key)
    $expected = [string]$ExpectedChecks[$key]
    $details.Add("$key=$actual") | Out-Null
    if ($actual -ne $expected) { $ok = $false }
  }

  if (-not $run.ok) {
    $details.Add("exit=$($run.exitCode)") | Out-Null
    if ($run.stderr) { $details.Add($run.stderr.Trim()) | Out-Null }
  }

  Add-Case $Name $ok ([string]$payload.overallStatus) ($details -join '; ') '查看 app\reports\diagnostics 中对应场景报告。'
}

try {
  Copy-RequiredFile (Join-Path $ProjectRoot 'AI SkillHub.exe') (Join-Path $SandboxRoot 'AI SkillHub.exe')
  Copy-RequiredFile (Join-Path $ProjectRoot 'README.md') (Join-Path $SandboxRoot 'README.md')
  Copy-RequiredFile (Join-Path $ProjectRoot 'CHANGELOG.md') (Join-Path $SandboxRoot 'CHANGELOG.md')
  Copy-RequiredFile (Join-Path $ProjectRoot '使用说明.md') (Join-Path $SandboxRoot '使用说明.md')

  if (Test-Path -LiteralPath (Join-Path $ProjectRoot 'docs') -PathType Container) {
    Copy-RequiredDirectory (Join-Path $ProjectRoot 'docs') (Join-Path $SandboxRoot 'docs')
  }

  New-Item -ItemType Directory -Force -Path (Join-Path $SandboxRoot 'skills') | Out-Null
  Copy-RequiredDirectory (Join-Path $AppRoot 'assets') (Join-Path $SandboxApp 'assets')
  Copy-RequiredDirectory (Join-Path $AppRoot 'runtime') (Join-Path $SandboxApp 'runtime')
  Copy-RequiredDirectory (Join-Path $AppRoot 'ui') (Join-Path $SandboxApp 'ui')

  foreach ($file in @(
    'SkillHub.ps1',
    'Manage-AgentSkillLinks.ps1',
    'Export-SkillHubDiagnostics.ps1',
    'Test-ShareRecipientExperience.ps1',
    'skillhub.config.example.json',
    '安装每日自动更新任务.ps1',
    '更新GitHub来源并同步Skills.ps1',
    '卸载每日自动更新任务.ps1'
  )) {
    Copy-RequiredFile (Join-Path $AppRoot $file) (Join-Path $SandboxApp $file)
  }

  $forbiddenBeforeRun = @(
    'app\skillhub.config.json',
    'app\github_sources',
    'app\reports',
    'app\webview2-data',
    'app\.skillhub'
  )
  $forbiddenFound = @()
  foreach ($relative in $forbiddenBeforeRun) {
    if (Test-Path -LiteralPath (Join-Path $SandboxRoot $relative)) { $forbiddenFound += $relative }
  }
  $pathHasSpace = ($SandboxRoot -match '\s')
  $pathHasChinese = ($SandboxRoot -match '[^\x00-\x7F]')
  Add-Case 'clean-package-shape' (($forbiddenFound.Count -eq 0) -and $pathHasSpace -and $pathHasChinese) 'ok' ("sandbox=$SandboxRoot; forbidden=" + ($forbiddenFound -join ', ')) '发布包不应包含个人配置、来源仓库、报告或缓存。'

  $exe = Join-Path $SandboxRoot 'AI SkillHub.exe'
  $self = Invoke-CapturedProcess 'self-test' $exe '--self-test' $SandboxRoot
  $selfReport = Join-Path $SandboxApp 'reports\webview-self-test.txt'
  $selfOk = $self.ok -and (Test-Path -LiteralPath $selfReport -PathType Leaf) -and ((Get-Content -LiteralPath $selfReport -Raw -Encoding UTF8) -match '^OK')
  Add-Case 'self-test' $selfOk (Get-CaseStatus $selfOk) ("exit=$($self.exitCode)") '确认 exe、WebView2 DLL、UI 文件和脚本齐全。'

  $ps = Join-Path $env:WINDIR 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $syncScript = Join-Path $SandboxApp 'SkillHub.ps1'
  $sync = Invoke-CapturedProcess 'first-run-report-only' $ps ('-NoProfile -ExecutionPolicy Bypass -File "' + $syncScript + '" -NoPull -ReportOnly') $SandboxApp
  $configPath = Join-Path $SandboxApp 'skillhub.config.json'
  $lastSync = Join-Path $SandboxApp 'reports\last-sync.md'
  $syncOk = $sync.ok -and (Test-Path -LiteralPath $configPath -PathType Leaf) -and (Test-Path -LiteralPath $lastSync -PathType Leaf)
  Add-Case 'first-run-report-only' $syncOk (Get-CaseStatus $syncOk) ("exit=$($sync.exitCode); configExists=$((Test-Path -LiteralPath $configPath)); reportExists=$((Test-Path -LiteralPath $lastSync))") '干净下载版首次运行应能自动创建空配置和报告。'

  Run-DiagnosticsCase 'diagnostics-normal-clean' '' @('ok') @{ 'project.config'='ok'; 'skills.scan'='info' }
  Run-DiagnosticsCase 'diagnostics-missing-codex' '-SimulateMissingCodex' @('ok') @{ 'agent.codex'='info' }
  Run-DiagnosticsCase 'diagnostics-no-agents' '-SimulateNoAgents' @('ok') @{ 'agent.noneDetected'='info' }
  Run-DiagnosticsCase 'diagnostics-missing-git' '-SimulateMissingGit' @('warn') @{ 'tool.git'='warn' }
  Run-DiagnosticsCase 'diagnostics-missing-webview2' '-SimulateMissingWebView2' @('error') @{ 'tool.webview2'='error' }

} catch {
  Add-Case 'share-test-runner' $false 'error' $_.Exception.Message '查看脚本复制或运行阶段是否缺少发布必需文件。'
}

$failed = @($Cases | Where-Object { -not $_.ok })
$payload = [PSCustomObject]@{
  ok = ($failed.Count -eq 0)
  generatedAt = (Get-Date).ToString('o')
  sandboxRoot = $SandboxRoot
  runRoot = $RunRoot
  appVersion = 'v1.1.1'
  cases = $Cases
}

$jsonPath = Join-Path $RunRoot 'share-recipient-test.json'
$mdPath = Join-Path $RunRoot 'share-recipient-test.md'
$latestJson = Join-Path $TestRoot 'latest-share-recipient-test.json'
$latestMd = Join-Path $TestRoot 'latest-share-recipient-test.md'

Write-Utf8Bom $jsonPath ($payload | ConvertTo-Json -Depth 8)
Copy-Item -LiteralPath $jsonPath -Destination $latestJson -Force

$md = New-Object System.Collections.Generic.List[string]
$md.Add('# 分享版真实验收') | Out-Null
$md.Add('') | Out-Null
$md.Add("- 状态：$(if ($payload.ok) { '通过' } else { '失败' })") | Out-Null
$md.Add("- 时间：$($payload.generatedAt)") | Out-Null
$md.Add("- 临时用户路径：$SandboxRoot") | Out-Null
$md.Add('') | Out-Null
$md.Add('| 场景 | 结果 | 状态 | 细节 |') | Out-Null
$md.Add('|---|---|---|---|') | Out-Null
foreach ($case in $Cases) {
  $result = if ($case.ok) { '通过' } else { '失败' }
  $detail = ([string]$case.detail).Replace('|', '/')
  $md.Add("| $($case.name) | $result | $($case.status) | $detail |") | Out-Null
}
$md.Add('') | Out-Null
$md.Add('说明：该验收会复制一份干净发布形态到带空格和中文的临时路径，不包含个人 skills、GitHub 来源、个人配置、报告或缓存。缺 Git、缺 WebView2、缺 Codex、没有任何 AI 工具属于模拟场景，用于确认提示是否清楚。') | Out-Null
Write-Utf8Bom $mdPath ($md -join [Environment]::NewLine)
Copy-Item -LiteralPath $mdPath -Destination $latestMd -Force

if (-not $Quiet) {
  Write-Host "分享版真实验收报告：$mdPath"
  Write-Host "机器可读结果：$jsonPath"
}

if ($failed.Count -gt 0) {
  exit 1
}
