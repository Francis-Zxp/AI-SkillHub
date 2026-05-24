[CmdletBinding()]
param(
  [switch]$Quiet,
  [switch]$SimulateMissingCodex,
  [switch]$SimulateMissingGit,
  [switch]$SimulateMissingWebView2,
  [switch]$SimulateNoAgents
)

$ErrorActionPreference = 'Continue'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)

$AppRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$ProjectRoot = Split-Path -Parent $AppRoot
$SkillsRoot = Join-Path $ProjectRoot 'skills'
$SourcesRoot = Join-Path $AppRoot 'github_sources'
$ConfigPath = Join-Path $AppRoot 'skillhub.config.json'
$ReportsRoot = Join-Path $AppRoot 'reports'
$DiagnosticsRoot = Join-Path $ReportsRoot 'diagnostics'
$StatePath = Join-Path $AppRoot '.skillhub\managed-links.json'
$LastSyncPath = Join-Path $ReportsRoot 'last-sync.md'
$HomePath = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
$Stamp = Get-Date -Format 'yyyyMMdd_HHmmss_fff'
$Checks = New-Object System.Collections.Generic.List[object]
$Agents = New-Object System.Collections.Generic.List[object]
$RiskFindings = New-Object System.Collections.Generic.List[object]
$SkillRows = New-Object System.Collections.Generic.List[object]
$HealthWarnings = New-Object System.Collections.Generic.List[object]
$UnicodeWarnings = New-Object System.Collections.Generic.List[object]

New-Item -ItemType Directory -Force -Path $DiagnosticsRoot | Out-Null

function Protect-Text([AllowNull()][object]$Value) {
  if ($null -eq $Value) { return '' }
  $text = [string]$Value
  if (-not [string]::IsNullOrWhiteSpace($script:HomePath)) {
    $text = $text -replace [regex]::Escape($script:HomePath), '~'
  }
  $text = $text -replace '(?i)(https://)([^/\s:@]+):([^@\s]+)@', '$1***:***@'
  $text = $text -replace '(?i)(token|api[_-]?key|secret|password)\s*[:=]\s*["'']?([A-Za-z0-9_\-\.]{12,})', '$1=***'
  $text = $text -replace '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}', '[email]'
  return $text
}

function Convert-ToRelativePath([string]$Path) {
  if ([string]::IsNullOrWhiteSpace($Path)) { return '' }
  $full = [System.IO.Path]::GetFullPath($Path)
  $rootFull = [System.IO.Path]::GetFullPath($ProjectRoot).TrimEnd('\') + '\'
  if ($full.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
    return $full.Substring($rootFull.Length)
  }
  return Protect-Text $full
}

function Add-Check([string]$Id, [string]$Name, [string]$Status, [string]$Summary, [string]$Detail, [string]$Fix) {
  $script:Checks.Add([PSCustomObject]@{
    id = $Id
    name = $Name
    status = $Status
    summary = $Summary
    detail = Protect-Text $Detail
    fix = $Fix
  }) | Out-Null
}

function Invoke-Tool([string]$FileName, [string]$Arguments, [string]$WorkingDirectory) {
  try {
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
    $p = [System.Diagnostics.Process]::Start($psi)
    $stdout = $p.StandardOutput.ReadToEnd()
    $stderr = $p.StandardError.ReadToEnd()
    $p.WaitForExit()
    return [PSCustomObject]@{ ok = ($p.ExitCode -eq 0); exitCode = $p.ExitCode; stdout = $stdout; stderr = $stderr }
  } catch {
    return [PSCustomObject]@{ ok = $false; exitCode = -1; stdout = ''; stderr = $_.Exception.Message }
  }
}

function Test-DirWritable([string]$Path) {
  if (-not (Test-Path -LiteralPath $Path -PathType Container)) { return $false }
  $probe = Join-Path $Path ('.skillhub-write-test-' + [Guid]::NewGuid().ToString('N') + '.tmp')
  try {
    [System.IO.File]::WriteAllText($probe, 'ok', [System.Text.UTF8Encoding]::new($false))
    Remove-Item -LiteralPath $probe -Force -ErrorAction SilentlyContinue
    return $true
  } catch {
    return $false
  }
}

function Read-SkillMeta([string]$SkillMd) {
  $meta = [PSCustomObject]@{ name = ''; description = ''; hasFrontMatter = $false; lineCount = 0; hasHiddenUnicode = $false; hasControlChars = $false }
  try {
    $text = [System.IO.File]::ReadAllText($SkillMd, [System.Text.Encoding]::UTF8)
    $meta.lineCount = ($text -split "`r?`n").Count
    $meta.hasHiddenUnicode = ($text -match '[\u200B-\u200D\u2060\uFEFF\u202A-\u202E\u2066-\u2069]')
    $meta.hasControlChars = ($text -match '[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]')
    $lines = $text -split "`r?`n"
    if ($lines.Count -gt 0 -and $lines[0].Trim() -eq '---') { $meta.hasFrontMatter = $true }
    foreach ($raw in ($lines | Select-Object -First 160)) {
      $line = $raw.Trim()
      if ($line -match '^name\s*:\s*(.+)$' -and -not $meta.name) { $meta.name = $Matches[1].Trim().Trim('"').Trim("'") }
      if ($line -match '^description\s*:\s*(.+)$' -and -not $meta.description) { $meta.description = $Matches[1].Trim().Trim('"').Trim("'") }
    }
  } catch {
  }
  return $meta
}

function Normalize-GitHubRepoUrl([string]$Url) {
  if ([string]::IsNullOrWhiteSpace($Url)) { return '' }
  $clean = $Url.Trim()
  $clean = $clean -replace '^\s*https\s*:\s*/\s*/\s*', 'https://'
  $clean = $clean -replace '\s+', ''
  return $clean.TrimEnd('/')
}

function Test-GitHubRepoUrl([string]$Url) {
  $clean = Normalize-GitHubRepoUrl $Url
  return ($clean -match '^https://github\.com/[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(?:\.git)?$')
}

function Get-LinkTargetText($Item) {
  try {
    $target = $Item.Target
    if ($target -is [array]) { return ($target -join '; ') }
    return [string]$target
  } catch {
    return ''
  }
}

function Add-AgentStatus([string]$Id, [string]$Name, [string]$BaseDir, [string[]]$SkillsDirs, [string]$CommandName) {
  $simulateMissing = $script:SimulateNoAgents -or ($Id -eq 'codex' -and $script:SimulateMissingCodex)
  $command = if ($CommandName -and -not $simulateMissing) { Get-Command $CommandName -ErrorAction SilentlyContinue } else { $null }
  $baseExists = if ($simulateMissing) { $false } else { (Test-Path -LiteralPath $BaseDir -PathType Container) }
  $skillsInfo = @()
  foreach ($dir in $SkillsDirs) {
    $exists = if ($simulateMissing) { $false } else { Test-Path -LiteralPath $dir -PathType Container }
    $skillsInfo += [PSCustomObject]@{
      path = Protect-Text $dir
      exists = $exists
      writable = if ($exists) { Test-DirWritable $dir } else { $false }
      isLink = if ($exists) { ((Get-Item -LiteralPath $dir -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 } else { $false }
    }
  }
  $detected = $baseExists -or ($null -ne $command)
  $status = if ($detected) { 'ok' } else { 'info' }
  $summary = if ($detected) { "$Name 已检测到。" } else { "$Name 未检测到；如果这台电脑不用它，可以忽略。" }
  $fix = if ($detected) { '如需接管，请确认对应 skills 目录存在且可写。' } else { '安装对应 AI 软件后，再点击“接管 AI 软件链接”。不要手动创建假目录。' }
  $commandSource = if ($command) { $command.Source } else { '' }
  $detail = "base=$BaseDir; command=" + $commandSource
  Add-Check "agent.$Id" $Name $status $summary $detail $fix
  $script:Agents.Add([PSCustomObject]@{
    id = $Id
    name = $Name
    detected = $detected
    baseDir = Protect-Text $BaseDir
    command = if ($command) { Protect-Text $command.Source } else { '' }
    skillsDirs = $skillsInfo
  }) | Out-Null
}

$projectRootStatus = if (Test-Path -LiteralPath $ProjectRoot) { 'ok' } else { 'error' }
Add-Check 'project.root' 'AI SkillHub 根目录' $projectRootStatus '已定位 AI SkillHub 根目录。' $ProjectRoot '请确保 exe、app、skills 放在同一项目根目录。'
$projectSkillsStatus = if (Test-Path -LiteralPath $SkillsRoot -PathType Container) { 'ok' } else { 'error' }
Add-Check 'project.skills' 'skills 目录' $projectSkillsStatus '已检查启用技能目录。' $SkillsRoot '缺失时请重新部署 AI SkillHub 文件夹。'
$projectSourcesStatus = if (Test-Path -LiteralPath $SourcesRoot -PathType Container) { 'ok' } else { 'warn' }
Add-Check 'project.sources' 'github_sources 目录' $projectSourcesStatus '已检查 GitHub 来源目录。' $SourcesRoot '首次同步会自动创建来源目录。'
$projectConfigStatus = if (Test-Path -LiteralPath $ConfigPath -PathType Leaf) { 'ok' } else { 'info' }
$projectConfigSummary = if ($projectConfigStatus -eq 'ok') { '已检查配置文件。' } else { '尚未创建个人配置文件；首次运行会自动生成空配置。' }
Add-Check 'project.config' '配置文件' $projectConfigStatus $projectConfigSummary $ConfigPath '首次运行 AI SkillHub.exe 后会自动创建；公开仓库不会包含个人配置。'
$reportsWritableStatus = if (Test-DirWritable $DiagnosticsRoot) { 'ok' } else { 'error' }
Add-Check 'project.reportsWritable' '报告目录可写' $reportsWritableStatus '已检查诊断报告目录可写。' $DiagnosticsRoot '请确认当前用户对 AI SkillHub 文件夹有写入权限。'

$gitCommand = if ($SimulateMissingGit) { $null } else { Get-Command git -ErrorAction SilentlyContinue }
if ($gitCommand) {
  $gitVersion = Invoke-Tool 'git' '--version' $AppRoot
  $gitStatus = if ($gitVersion.ok) { 'ok' } else { 'warn' }
  Add-Check 'tool.git' 'Git' $gitStatus 'Git 已检测。' (($gitCommand.Source) + ' ' + $gitVersion.stdout.Trim() + ' ' + $gitVersion.stderr.Trim()) 'GitHub 同步需要 Git。若同步失败，请重新安装 Git for Windows。'
} else {
  $gitSummary = if ($SimulateMissingGit) { '分享验收：已模拟未安装 Git；GitHub 同步会受影响。' } else { '未检测到 Git；GitHub 同步会受影响。' }
  Add-Check 'tool.git' 'Git' 'warn' $gitSummary '' '请安装 Git for Windows，然后重新打开 AI SkillHub。'
}

$nodeCommand = Get-Command node -ErrorAction SilentlyContinue
if ($nodeCommand) {
  $nodeVersion = (Invoke-Tool 'node' '--version' $AppRoot).stdout.Trim()
  $major = 0
  if ($nodeVersion -match 'v(\d+)') { $major = [int]$Matches[1] }
  $nodeStatus = if ($major -eq 22 -or $major -eq 24) { 'ok' } elseif ($major -gt 0) { 'warn' } else { 'info' }
  $nodeFix = if ($nodeStatus -eq 'warn') { '后续做 Tauri/前端/CLI 开发建议使用 Node LTS 22 或 24。当前版本不影响普通同步。' } else { '当前 Node 版本适合后续前端/Tauri 准备工作；普通同步不强制需要 Node。' }
  Add-Check 'tool.node' 'Node.js' $nodeStatus "Node.js $nodeVersion" $nodeCommand.Source $nodeFix
} else {
  Add-Check 'tool.node' 'Node.js' 'info' '没有检测到 Node.js；普通同步不强制需要。' '' '后续做 v2/Tauri 开发时安装 Node LTS 22 或 24。'
}

$runtimeDll = Join-Path $AppRoot 'runtime\Microsoft.Web.WebView2.Core.dll'
$runtimeDirs = @()
$pf86 = [Environment]::GetEnvironmentVariable('ProgramFiles(x86)')
$pf = [Environment]::GetEnvironmentVariable('ProgramFiles')
foreach ($base in @($pf86, $pf)) {
  if ($base) {
    $candidate = Join-Path $base 'Microsoft\EdgeWebView\Application'
    if (Test-Path -LiteralPath $candidate) { $runtimeDirs += $candidate }
  }
}
$webviewDllExists = (Test-Path -LiteralPath $runtimeDll)
if ($SimulateMissingWebView2) {
  $webviewDllExists = $false
  $runtimeDirs = @()
}
$webviewStatus = if ($webviewDllExists -and $runtimeDirs.Count -gt 0) { 'ok' } elseif ($webviewDllExists) { 'warn' } else { 'error' }
$webviewSummary = if ($SimulateMissingWebView2) { '分享验收：已模拟缺少 WebView2；界面可能无法打开。' } elseif ($webviewStatus -eq 'ok') { 'WebView2 运行组件已检测到。' } elseif ($webviewStatus -eq 'warn') { 'AI SkillHub 自带 WebView2 DLL，但未确认系统 Runtime。' } else { '缺少 WebView2 组件。' }
Add-Check 'tool.webview2' 'Microsoft Edge WebView2' $webviewStatus $webviewSummary (($runtimeDirs -join '; ') + '; packaged=' + $runtimeDll) '若界面无法打开，请安装 Microsoft Edge WebView2 Runtime。'

Add-AgentStatus 'claude' 'Claude / Claude Code' (Join-Path $HomePath '.claude') @((Join-Path $HomePath '.claude\skills')) 'claude'
Add-AgentStatus 'codex' 'OpenAI Codex' (Join-Path $HomePath '.codex') @((Join-Path $HomePath '.codex\skills'), (Join-Path $HomePath '.agents\skills')) 'codex'
Add-AgentStatus 'antigravity' 'Antigravity' (Join-Path $HomePath '.gemini\antigravity') @((Join-Path $HomePath '.gemini\antigravity\skills')) ''

if ((@($Agents | Where-Object { $_.detected }).Count) -eq 0) {
  Add-Check 'agent.noneDetected' 'AI Coding 工具' 'info' '未识别到可接管的 AI Coding 工具。' '' '安装 Claude Code、Codex 或 Antigravity 后，再点击“接管 AI 软件链接”。AI SkillHub 不会创建假的工具目录。'
}

$config = $null
try {
  if (Test-Path -LiteralPath $ConfigPath) {
    $config = Get-Content -LiteralPath $ConfigPath -Raw -Encoding UTF8 | ConvertFrom-Json
    Add-Check 'config.parse' '配置解析' 'ok' '配置 JSON 可以正常读取。' $ConfigPath '无。'
  } else {
    Add-Check 'config.parse' '配置解析' 'info' '配置文件尚未创建；首次运行会自动创建空配置。' $ConfigPath '公开版不会携带任何人的个人来源配置。'
  }
} catch {
  Add-Check 'config.parse' '配置解析' 'error' '配置 JSON 读取失败。' $_.Exception.Message '请恢复配置备份，或把诊断包发给开发者排查。'
}

$invalidUrls = @()
$repoCount = 0
$promptCount = 0
if ($config -and $config.repositories) {
  foreach ($repo in $config.repositories) {
    $repoCount++
    if ($repo.type -eq 'prompt') { $promptCount++ }
    if (-not (Test-GitHubRepoUrl ([string]$repo.url))) {
      $invalidUrls += [PSCustomObject]@{ name = $repo.name; url = Protect-Text $repo.url }
    }
  }
}
$githubUrlStatus = if ($invalidUrls.Count -eq 0) { 'ok' } else { 'warn' }
Add-Check 'config.githubUrls' 'GitHub 来源地址' $githubUrlStatus "已检查 $repoCount 个来源，其中 Prompt 来源 $promptCount 个。" (($invalidUrls | ConvertTo-Json -Depth 4)) '请使用 https://github.com/作者/仓库.git 这种普通 GitHub 仓库地址。'

$skillDirs = @()
if (Test-Path -LiteralPath $SkillsRoot -PathType Container) {
  $skillDirs = Get-ChildItem -LiteralPath $SkillsRoot -Force -Directory -ErrorAction SilentlyContinue
}

foreach ($dir in $skillDirs) {
  if ($dir.Name.StartsWith('.')) { continue }
  $skillMd = Join-Path $dir.FullName 'SKILL.md'
  $hasSkill = Test-Path -LiteralPath $skillMd -PathType Leaf
  $meta = if ($hasSkill) { Read-SkillMeta $skillMd } else { [PSCustomObject]@{ name=''; description=''; hasFrontMatter=$false; lineCount=0; hasHiddenUnicode=$false; hasControlChars=$false } }
  $target = Get-LinkTargetText $dir
  $isLink = (($dir.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)
  $displayName = if ($meta.name) { $meta.name } else { $dir.Name }
  $row = [PSCustomObject]@{
    folder = $dir.Name
    name = $displayName
    description = $meta.description
    hasSkillMd = $hasSkill
    hasFrontMatter = $meta.hasFrontMatter
    isLink = $isLink
    target = Protect-Text $target
    path = Convert-ToRelativePath $dir.FullName
  }
  $SkillRows.Add($row) | Out-Null
  if (-not $hasSkill) { $HealthWarnings.Add([PSCustomObject]@{ skill=$dir.Name; issue='missing SKILL.md' }) | Out-Null }
  elseif (-not $meta.description) { $HealthWarnings.Add([PSCustomObject]@{ skill=$dir.Name; issue='missing description' }) | Out-Null }
  if ($meta.hasHiddenUnicode -or $meta.hasControlChars) {
    $UnicodeWarnings.Add([PSCustomObject]@{ skill=$dir.Name; hiddenUnicode=$meta.hasHiddenUnicode; controlChars=$meta.hasControlChars }) | Out-Null
  }
}

$duplicatesByMetaName = @()
$SkillRows | Group-Object name | Where-Object { $_.Count -gt 1 -and $_.Name } | ForEach-Object {
  $duplicatesByMetaName += [PSCustomObject]@{ name = $_.Name; folders = @($_.Group | Select-Object -ExpandProperty folder) }
}
$duplicatesByTarget = @()
$SkillRows | Where-Object { $_.target } | Group-Object target | Where-Object { $_.Count -gt 1 -and $_.Name } | ForEach-Object {
  $duplicatesByTarget += [PSCustomObject]@{ target = $_.Name; folders = @($_.Group | Select-Object -ExpandProperty folder) }
}

$skillsScanStatus = if ($SkillRows.Count -gt 0) { 'ok' } elseif ($repoCount -eq 0) { 'info' } else { 'warn' }
$skillsScanFix = if ($repoCount -eq 0) { '首次使用时先添加 GitHub、本地文件夹或 zip 来源，再点击“立即同步”。' } else { '如果为 0，请点击“立即同步”；若仍为 0，请检查来源中是否包含 SKILL.md。' }
Add-Check 'skills.scan' 'Skill 扫描' $skillsScanStatus "扫描到 $($SkillRows.Count) 个启用 Skill。" $SkillsRoot $skillsScanFix
$skillsHealthStatus = if ($HealthWarnings.Count -eq 0) { 'ok' } else { 'warn' }
Add-Check 'skills.health' 'Skill 健康检查' $skillsHealthStatus "发现 $($HealthWarnings.Count) 个健康提示。" (($HealthWarnings | Select-Object -First 30 | ConvertTo-Json -Depth 5)) '缺少 description 通常不致命，但建议补齐，便于 AI 正确选择技能。'
$skillsDuplicateStatus = if ($duplicatesByMetaName.Count -eq 0 -and $duplicatesByTarget.Count -eq 0) { 'ok' } else { 'warn' }
Add-Check 'skills.duplicates' '重复技能检查' $skillsDuplicateStatus "同名 $($duplicatesByMetaName.Count) 组，同目标 $($duplicatesByTarget.Count) 组。" '' '暂不自动删除；确认来源后再清理。'
$skillsUnicodeStatus = if ($UnicodeWarnings.Count -eq 0) { 'ok' } else { 'warn' }
Add-Check 'skills.unicode' '乱码/隐藏字符检查' $skillsUnicodeStatus "发现 $($UnicodeWarnings.Count) 个可能含隐藏字符的 SKILL.md。" (($UnicodeWarnings | Select-Object -First 30 | ConvertTo-Json -Depth 5)) '如果 UI 或技能说明乱码，优先检查这些文件的编码。'

$riskPatterns = @(
  [PSCustomObject]@{ type='prompt_injection'; severity='high'; regex='(?i)(ignore\s+(all\s+)?(previous|above|prior)\s+(instructions?|rules?|guidelines?)|system\s+prompt\s*:|from\s+now\s+on|you\s+are\s+now)' },
  [PSCustomObject]@{ type='dangerous_shell'; severity='high'; regex='(?i)(Invoke-Expression|\biex\b|Remove-Item\s+.*-Recurse|rm\s+-rf|curl\s+.+\|\s*(sh|bash|powershell|pwsh)|wget\s+.+\|\s*(sh|bash|powershell|pwsh))' },
  [PSCustomObject]@{ type='code_execution'; severity='medium'; regex='(?i)(child_process|execSync|exec\(|spawn\(|eval\(|new\s+Function)' },
  [PSCustomObject]@{ type='secret_like'; severity='medium'; regex='(?i)(api[_-]?key|secret|token|password)\s*[:=]\s*["'']?[A-Za-z0-9_\-\.]{16,}' },
  [PSCustomObject]@{ type='hidden_unicode'; severity='medium'; regex='[\u200B-\u200D\u2060\uFEFF\u202A-\u202E\u2066-\u2069]' }
)

function Get-RiskScope([string]$RelativePath) {
  if ($RelativePath -like 'app\*') { return 'app_code' }
  if ($RelativePath -like 'skills\*') { return 'third_party_skill' }
  return 'project_file'
}

function Test-RiskScanFile($File) {
  $relative = Convert-ToRelativePath $File.FullName
  if ($relative -match '(?i)(^|\\)(vendor|node_modules|dist|build|\.git|__pycache__)(\\|$)') { return $false }
  if ($File.Name -match '(?i)\.min\.(js|css)$') { return $false }
  return $true
}

function Test-RiskLineIgnored([string]$RelativePath, [string]$LineText) {
  if ($RelativePath -eq 'app\Export-SkillHubDiagnostics.ps1' -and $LineText -match "regex='") { return $true }
  if ($RelativePath -eq 'app\Export-SkillHubDiagnostics.ps1' -and $LineText -match '\$LineText -match') { return $true }
  if ($RelativePath -eq 'app\src\AI.SkillHub.WebView.cs' -and $LineText -match 'string pattern = "\(\?i\)\(Invoke-Expression') { return $true }
  return $false
}

function Scan-RiskRoots($Roots, [int]$MaxFindings) {
  foreach ($rootItem in ($Roots | Select-Object -Unique)) {
    $files = @()
    if (Test-Path -LiteralPath $rootItem -PathType Leaf) {
      $item = Get-Item -LiteralPath $rootItem -ErrorAction SilentlyContinue
      if ($item -and (Test-RiskScanFile $item)) { $files = @($item) }
    } elseif (Test-Path -LiteralPath $rootItem -PathType Container) {
      $files = @(Get-ChildItem -LiteralPath $rootItem -Recurse -File -ErrorAction SilentlyContinue | Where-Object {
        $_.Length -le 524288 -and $_.Name -match '^(SKILL\.md|.*\.(ps1|sh|js|ts|py|md|cs))$' -and (Test-RiskScanFile $_)
      } | Select-Object -First 24)
    }
    foreach ($file in $files) {
      if ($script:RiskFindings.Count -ge $MaxFindings) { break }
      $script:scannedFiles++
      try {
        $lines = [System.IO.File]::ReadAllLines($file.FullName, [System.Text.Encoding]::UTF8)
        for ($i = 0; $i -lt $lines.Count; $i++) {
          foreach ($pattern in $riskPatterns) {
            if ($lines[$i] -match $pattern.regex) {
              $relative = Convert-ToRelativePath $file.FullName
              if (Test-RiskLineIgnored $relative $lines[$i]) { continue }
              $script:RiskFindings.Add([PSCustomObject]@{
                type = $pattern.type
                severity = $pattern.severity
                scope = Get-RiskScope $relative
                file = $relative
                line = $i + 1
                sample = Protect-Text ($lines[$i].Trim())
              }) | Out-Null
              break
            }
          }
          if ($script:RiskFindings.Count -ge $MaxFindings) { break }
        }
      } catch {
      }
    }
    if ($script:RiskFindings.Count -ge $MaxFindings) { break }
  }
}

$appScanRoots = New-Object System.Collections.Generic.List[string]
foreach ($extra in @(
  (Join-Path $AppRoot 'SkillHub.ps1'),
  (Join-Path $AppRoot 'Manage-AgentSkillLinks.ps1'),
  (Join-Path $AppRoot 'Export-SkillHubDiagnostics.ps1'),
  (Join-Path $AppRoot 'ui\app.js'),
  (Join-Path $AppRoot 'src\AI.SkillHub.WebView.cs')
)) {
  if (Test-Path -LiteralPath $extra) { $appScanRoots.Add($extra) | Out-Null }
}

$skillScanRoots = New-Object System.Collections.Generic.List[string]
foreach ($row in $SkillRows) {
  $candidate = Join-Path $SkillsRoot $row.folder
  if (Test-Path -LiteralPath $candidate) { $skillScanRoots.Add($candidate) | Out-Null }
}

$scannedFiles = 0
Scan-RiskRoots $appScanRoots 120
Scan-RiskRoots $skillScanRoots 120

$appRiskFindings = @($RiskFindings | Where-Object { $_.scope -eq 'app_code' })
$thirdPartyRiskFindings = @($RiskFindings | Where-Object { $_.scope -eq 'third_party_skill' })
$securityPatternStatus = if ($appRiskFindings.Count -gt 0) { 'warn' } elseif ($thirdPartyRiskFindings.Count -gt 0) { 'info' } else { 'ok' }
$securitySummary = if ($appRiskFindings.Count -gt 0) {
  "程序自身发现 $($appRiskFindings.Count) 条风险提示，第三方 Skill 内容 $($thirdPartyRiskFindings.Count) 条。"
} elseif ($thirdPartyRiskFindings.Count -gt 0) {
  "程序自身未发现风险提示；第三方 Skill 内容有 $($thirdPartyRiskFindings.Count) 条需人工阅读的提示。"
} else {
  '程序自身和已启用 Skill 未发现明显高风险模式。'
}
Add-Check 'security.patterns' '高风险模式扫描' $securityPatternStatus "扫描 $scannedFiles 个文件，$securitySummary" '' '第三方 Skill 的提示不等于 AI SkillHub 程序漏洞；安装陌生 Skill 前请阅读报告。'

$zipPreviewJsonPath = Join-Path $ReportsRoot 'zip-preview-test\latest-zip-preview-test.json'
$zipPreviewMdPath = Join-Path $ReportsRoot 'zip-preview-test\latest-zip-preview-test.md'
$zipPreviewStatus = 'info'
$zipPreviewSummary = '尚未运行 zip 导入预览自动测试。'
$zipPreviewDetail = ''
$zipPreviewFix = '开发或排错时可运行 AI SkillHub.exe --zip-preview-test；普通日常使用不强制。'
if (Test-Path -LiteralPath $zipPreviewJsonPath -PathType Leaf) {
  try {
    $zipPreview = Get-Content -LiteralPath $zipPreviewJsonPath -Raw -Encoding UTF8 | ConvertFrom-Json
    $zipPreviewStatus = if ($zipPreview.ok) { 'ok' } else { 'warn' }
    $zipPreviewSummary = if ($zipPreview.ok) { 'zip 导入预览自动测试已通过。' } else { 'zip 导入预览自动测试未通过。' }
    $zipPreviewDetail = Protect-Text ("runId=$($zipPreview.runId); workDir=$($zipPreview.workDir)")
    $zipPreviewFix = if ($zipPreview.ok) { '无。' } else { '请查看 app\reports\zip-preview-test\latest-zip-preview-test.md。' }
  } catch {
    $zipPreviewStatus = 'warn'
    $zipPreviewSummary = 'zip 导入预览自动测试报告无法读取。'
    $zipPreviewDetail = $_.Exception.Message
    $zipPreviewFix = '请重新运行 AI SkillHub.exe --zip-preview-test。'
  }
}
Add-Check 'import.zipPreviewTest' 'zip 导入预览自动测试' $zipPreviewStatus $zipPreviewSummary $zipPreviewDetail $zipPreviewFix

$statusCounts = @{}
foreach ($check in $Checks) {
  if (-not $statusCounts.ContainsKey($check.status)) { $statusCounts[$check.status] = 0 }
  $statusCounts[$check.status]++
}
$errorCount = @($Checks | Where-Object { $_.status -eq 'error' }).Count
$warnCount = @($Checks | Where-Object { $_.status -eq 'warn' }).Count
$overall = if ($errorCount -gt 0) { 'error' } elseif ($warnCount -gt 0) { 'warn' } else { 'ok' }
$scenarioName = 'normal'
$scenarioNotes = New-Object System.Collections.Generic.List[string]
if ($SimulateMissingCodex) {
  $scenarioName = 'share-preflight'
  $scenarioNotes.Add('已模拟对方电脑没有 Codex。Codex 未检测到属于可忽略信息，不应阻止 Claude 使用。') | Out-Null
}
if ($SimulateNoAgents) {
  $scenarioName = 'share-no-agents'
  $scenarioNotes.Add('已模拟没有任何可接管的 AI Coding 工具。此时应提示安装 Claude Code、Codex 或 Antigravity，而不是创建假目录。') | Out-Null
}
if ($SimulateMissingGit) {
  $scenarioName = 'share-missing-git'
  $scenarioNotes.Add('已模拟未安装 Git。此时 GitHub 同步应给出安装 Git 的提示。') | Out-Null
}
if ($SimulateMissingWebView2) {
  $scenarioName = 'share-missing-webview2'
  $scenarioNotes.Add('已模拟缺少 WebView2。此时应提示安装 Microsoft Edge WebView2 Runtime。') | Out-Null
}
if ($scenarioNotes.Count -eq 0) { $scenarioNotes.Add('正常系统体检。') | Out-Null }
$scenarioNote = ($scenarioNotes -join ' ')

$jsonPath = Join-Path $DiagnosticsRoot "skillhub-diagnostics_$Stamp.json"
$mdPath = Join-Path $DiagnosticsRoot "skillhub-diagnostics_$Stamp.md"
$zipPath = Join-Path $DiagnosticsRoot "skillhub-diagnostics_$Stamp.zip"
$latestPath = Join-Path $ReportsRoot 'latest-diagnostics.json'
$safeConfigPath = Join-Path $DiagnosticsRoot "sanitized-config_$Stamp.json"
$safeLastSyncPath = Join-Path $DiagnosticsRoot "sanitized-last-sync_$Stamp.md"

if (Test-Path -LiteralPath $ConfigPath) {
  [System.IO.File]::WriteAllText($safeConfigPath, (Protect-Text ([System.IO.File]::ReadAllText($ConfigPath, [System.Text.Encoding]::UTF8))), [System.Text.UTF8Encoding]::new($true))
}
if (Test-Path -LiteralPath $LastSyncPath) {
  [System.IO.File]::WriteAllText($safeLastSyncPath, (Protect-Text ([System.IO.File]::ReadAllText($LastSyncPath, [System.Text.Encoding]::UTF8))), [System.Text.UTF8Encoding]::new($true))
}

$payload = [PSCustomObject]@{
  schemaVersion = 1
  appVersion = 'v1.1.1'
  generatedAt = (Get-Date).ToString('o')
  scenario = [PSCustomObject]@{
    name = $scenarioName
    simulateMissingCodex = [bool]$SimulateMissingCodex
    simulateMissingGit = [bool]$SimulateMissingGit
    simulateMissingWebView2 = [bool]$SimulateMissingWebView2
    simulateNoAgents = [bool]$SimulateNoAgents
    note = $scenarioNote
  }
  overallStatus = $overall
  projectRoot = Protect-Text $ProjectRoot
  appRoot = Protect-Text $AppRoot
  skillsRoot = Protect-Text $SkillsRoot
  sourcesRoot = Protect-Text $SourcesRoot
  summary = [PSCustomObject]@{
    checks = $Checks.Count
    ok = [int]$statusCounts['ok']
    warn = [int]$statusCounts['warn']
    error = [int]$statusCounts['error']
    info = [int]$statusCounts['info']
    skills = $SkillRows.Count
    repositories = $repoCount
    prompts = $promptCount
    riskFindings = $RiskFindings.Count
    appRiskFindings = $appRiskFindings.Count
    thirdPartySkillRiskFindings = $thirdPartyRiskFindings.Count
  }
  checks = $Checks
  agents = $Agents
  skills = $SkillRows
  duplicates = [PSCustomObject]@{
    byMetaName = $duplicatesByMetaName
    byTarget = $duplicatesByTarget
  }
  healthWarnings = $HealthWarnings
  unicodeWarnings = $UnicodeWarnings
  riskSummary = [PSCustomObject]@{
    appCode = $appRiskFindings.Count
    thirdPartySkills = $thirdPartyRiskFindings.Count
    byType = @($RiskFindings | Group-Object type | Sort-Object Count -Descending | ForEach-Object { [PSCustomObject]@{ type = $_.Name; count = $_.Count } })
    byScope = @($RiskFindings | Group-Object scope | Sort-Object Count -Descending | ForEach-Object { [PSCustomObject]@{ scope = $_.Name; count = $_.Count } })
  }
  riskFindings = $RiskFindings
  files = [PSCustomObject]@{
    json = Protect-Text $jsonPath
    markdown = Protect-Text $mdPath
    zip = Protect-Text $zipPath
  }
}

$jsonText = $payload | ConvertTo-Json -Depth 12
[System.IO.File]::WriteAllText($jsonPath, $jsonText, [System.Text.UTF8Encoding]::new($true))
[System.IO.File]::WriteAllText($latestPath, $jsonText, [System.Text.UTF8Encoding]::new($true))

$md = New-Object System.Collections.Generic.List[string]
$md.Add('# AI SkillHub 诊断报告') | Out-Null
$md.Add('') | Out-Null
$md.Add("> $scenarioNote") | Out-Null
$md.Add('') | Out-Null
$md.Add("- 生成时间：$((Get-Date).ToString('yyyy-MM-dd HH:mm:ss'))") | Out-Null
$md.Add("- 总体状态：$overall") | Out-Null
$md.Add("- Skill 数量：$($SkillRows.Count)") | Out-Null
$md.Add("- 仓库来源：$repoCount") | Out-Null
$md.Add("- 风险提示：$($RiskFindings.Count)") | Out-Null
$md.Add("- 程序自身风险提示：$($appRiskFindings.Count)") | Out-Null
$md.Add("- 第三方 Skill 内容提示：$($thirdPartyRiskFindings.Count)") | Out-Null
$md.Add('') | Out-Null
$md.Add('## 检查结果') | Out-Null
$md.Add('') | Out-Null
$md.Add('| 状态 | 项目 | 摘要 | 建议 |') | Out-Null
$md.Add('|---|---|---|---|') | Out-Null
foreach ($check in $Checks) {
  $md.Add("| $($check.status) | $($check.name) | $($check.summary -replace '\|','/') | $($check.fix -replace '\|','/') |") | Out-Null
}
$md.Add('') | Out-Null
$md.Add('## AI 软件检测') | Out-Null
$md.Add('') | Out-Null
foreach ($agent in $Agents) {
  $label = if ($agent.detected) { '已检测到' } else { '未检测到' }
  $md.Add("- $($agent.name)：$label") | Out-Null
}
$md.Add('') | Out-Null
$md.Add('## 安全扫描提示') | Out-Null
$md.Add('') | Out-Null
if ($RiskFindings.Count -eq 0) {
  $md.Add('未发现明显高风险模式。') | Out-Null
} else {
  if ($appRiskFindings.Count -eq 0) {
    $md.Add('AI SkillHub 程序自身未发现风险提示；下面主要是第三方 Skill 文档、示例或脚本中的静态提示。') | Out-Null
    $md.Add('') | Out-Null
  }
  foreach ($finding in ($RiskFindings | Select-Object -First 30)) {
    $md.Add("- [$($finding.severity)] $($finding.scope) / $($finding.type)：$($finding.file):$($finding.line)") | Out-Null
  }
}
$md.Add('') | Out-Null
$md.Add('## 文件') | Out-Null
$md.Add('') | Out-Null
$md.Add("- JSON：$(Protect-Text $jsonPath)") | Out-Null
$md.Add("- Zip：$(Protect-Text $zipPath)") | Out-Null
[System.IO.File]::WriteAllText($mdPath, ($md -join [Environment]::NewLine), [System.Text.UTF8Encoding]::new($true))

$zipItems = @($jsonPath, $mdPath)
if (Test-Path -LiteralPath $safeConfigPath) { $zipItems += $safeConfigPath }
if (Test-Path -LiteralPath $safeLastSyncPath) { $zipItems += $safeLastSyncPath }
if (Test-Path -LiteralPath $zipPreviewJsonPath) { $zipItems += $zipPreviewJsonPath }
if (Test-Path -LiteralPath $zipPreviewMdPath) { $zipItems += $zipPreviewMdPath }
if (Get-Command Compress-Archive -ErrorAction SilentlyContinue) {
  if (Test-Path -LiteralPath $zipPath) { Remove-Item -LiteralPath $zipPath -Force -ErrorAction SilentlyContinue }
  Compress-Archive -LiteralPath $zipItems -DestinationPath $zipPath -Force
}

if (-not $Quiet) {
  Write-Host "诊断报告已生成：$mdPath"
  if (Test-Path -LiteralPath $zipPath) { Write-Host "诊断包已生成：$zipPath" }
  Write-Host "机器可读状态：$latestPath"
}
