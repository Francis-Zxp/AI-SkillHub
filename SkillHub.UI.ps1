$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$Base = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfigPath = Join-Path $Base 'skillhub.config.json'
$SkillHubPath = Join-Path $Base 'SkillHub.ps1'
$InstallTaskPath = Join-Path $Base '安装每日自动更新任务.ps1'
$UninstallTaskPath = Join-Path $Base '卸载每日自动更新任务.ps1'
$ReportPath = Join-Path $Base 'reports\last-sync.md'
$StatePath = Join-Path $Base '.skillhub\managed-links.json'

function New-Font($size, $style = [System.Drawing.FontStyle]::Regular) {
  return New-Object System.Drawing.Font('Segoe UI', $size, $style)
}

function Get-RepoNameFromUrl([string]$url) {
  $clean = $url.Trim().TrimEnd('/')
  $name = Split-Path -Leaf $clean
  if ($name.EndsWith('.git')) { $name = $name.Substring(0, $name.Length - 4) }
  return $name
}

function Read-Config {
  if (-not (Test-Path -LiteralPath $ConfigPath)) { throw "Missing config: $ConfigPath" }
  return Get-Content -LiteralPath $ConfigPath -Raw | ConvertFrom-Json
}

function Save-Config($config) {
  $config | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $ConfigPath -Encoding UTF8
}

function Run-PowerShellScript([string]$scriptPath) {
  $psi = New-Object System.Diagnostics.ProcessStartInfo
  $psi.FileName = 'powershell.exe'
  $psi.Arguments = "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`""
  $psi.UseShellExecute = $false
  $psi.RedirectStandardOutput = $true
  $psi.RedirectStandardError = $true
  $psi.CreateNoWindow = $true

  $process = New-Object System.Diagnostics.Process
  $process.StartInfo = $psi
  [void]$process.Start()
  $stdout = $process.StandardOutput.ReadToEnd()
  $stderr = $process.StandardError.ReadToEnd()
  $process.WaitForExit()

  return [PSCustomObject]@{
    ExitCode = $process.ExitCode
    Output = $stdout
    Error = $stderr
  }
}

$colorBg = [System.Drawing.Color]::FromArgb(248, 247, 242)
$colorPanel = [System.Drawing.Color]::FromArgb(239, 242, 236)
$colorInk = [System.Drawing.Color]::FromArgb(36, 42, 44)
$colorMuted = [System.Drawing.Color]::FromArgb(96, 105, 107)
$colorAccent = [System.Drawing.Color]::FromArgb(43, 111, 126)
$colorSuccess = [System.Drawing.Color]::FromArgb(39, 128, 93)
$colorWarn = [System.Drawing.Color]::FromArgb(171, 114, 37)
$colorError = [System.Drawing.Color]::FromArgb(173, 60, 60)
$colorBorder = [System.Drawing.Color]::FromArgb(210, 216, 209)

$form = New-Object System.Windows.Forms.Form
$form.Text = 'SkillHub Manager'
$form.StartPosition = 'CenterScreen'
$form.MinimumSize = New-Object System.Drawing.Size(1040, 720)
$form.Size = New-Object System.Drawing.Size(1160, 760)
$form.BackColor = $colorBg
$form.Font = New-Font 9

$root = New-Object System.Windows.Forms.TableLayoutPanel
$root.Dock = 'Fill'
$root.RowCount = 3
$root.ColumnCount = 1
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 86))) | Out-Null
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 100))) | Out-Null
$root.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 34))) | Out-Null
$form.Controls.Add($root)

$header = New-Object System.Windows.Forms.Panel
$header.Dock = 'Fill'
$header.BackColor = $colorBg
$header.Padding = New-Object System.Windows.Forms.Padding(22, 16, 22, 10)
$root.Controls.Add($header, 0, 0)

$title = New-Object System.Windows.Forms.Label
$title.Text = 'SkillHub Manager'
$title.Font = New-Font 20 ([System.Drawing.FontStyle]::Bold)
$title.ForeColor = $colorInk
$title.AutoSize = $true
$title.Location = New-Object System.Drawing.Point(22, 16)
$header.Controls.Add($title)

$subtitle = New-Object System.Windows.Forms.Label
$subtitle.Text = 'Update GitHub Skills, rebuild links, and keep the active folder clean.'
$subtitle.Font = New-Font 9
$subtitle.ForeColor = $colorMuted
$subtitle.AutoSize = $true
$subtitle.Location = New-Object System.Drawing.Point(24, 52)
$header.Controls.Add($subtitle)

$status = New-Object System.Windows.Forms.Label
$status.Text = 'Ready'
$status.Font = New-Font 9 ([System.Drawing.FontStyle]::Bold)
$status.ForeColor = [System.Drawing.Color]::White
$status.BackColor = $colorAccent
$status.TextAlign = 'MiddleCenter'
$status.AutoSize = $false
$status.Size = New-Object System.Drawing.Size(176, 30)
$status.Anchor = 'Top,Right'
$status.Location = New-Object System.Drawing.Point(($form.ClientSize.Width - 214), 24)
$header.Controls.Add($status)

$content = New-Object System.Windows.Forms.TableLayoutPanel
$content.Dock = 'Fill'
$content.ColumnCount = 2
$content.RowCount = 1
$content.Padding = New-Object System.Windows.Forms.Padding(18, 0, 18, 0)
$content.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Absolute, 300))) | Out-Null
$content.ColumnStyles.Add((New-Object System.Windows.Forms.ColumnStyle([System.Windows.Forms.SizeType]::Percent, 100))) | Out-Null
$root.Controls.Add($content, 0, 1)

$sidebar = New-Object System.Windows.Forms.Panel
$sidebar.Dock = 'Fill'
$sidebar.BackColor = $colorPanel
$sidebar.Padding = New-Object System.Windows.Forms.Padding(16)
$content.Controls.Add($sidebar, 0, 0)

$main = New-Object System.Windows.Forms.TableLayoutPanel
$main.Dock = 'Fill'
$main.RowCount = 3
$main.ColumnCount = 1
$main.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Absolute, 92))) | Out-Null
$main.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 60))) | Out-Null
$main.RowStyles.Add((New-Object System.Windows.Forms.RowStyle([System.Windows.Forms.SizeType]::Percent, 40))) | Out-Null
$main.Padding = New-Object System.Windows.Forms.Padding(16, 0, 0, 0)
$content.Controls.Add($main, 1, 0)

function New-Button([string]$text) {
  $button = New-Object System.Windows.Forms.Button
  $button.Text = $text
  $button.Height = 38
  $button.Dock = 'Top'
  $button.FlatStyle = 'Flat'
  $button.FlatAppearance.BorderColor = $colorBorder
  $button.BackColor = [System.Drawing.Color]::FromArgb(250, 251, 248)
  $button.ForeColor = $colorInk
  $button.Font = New-Font 9 ([System.Drawing.FontStyle]::Bold)
  $button.Margin = New-Object System.Windows.Forms.Padding(0, 0, 0, 10)
  return $button
}

$btnSync = New-Button 'Sync Now'
$btnInstall = New-Button 'Install Daily Auto Update'
$btnUninstall = New-Button 'Remove Auto Update'
$btnOpenReport = New-Button 'Open Last Report'
$btnOpenSkills = New-Button 'Open Active Skills Folder'
$btnOpenSources = New-Button 'Open GitHub Sources'

$sidebar.Controls.Add($btnOpenSources)
$sidebar.Controls.Add($btnOpenSkills)
$sidebar.Controls.Add($btnOpenReport)
$sidebar.Controls.Add($btnUninstall)
$sidebar.Controls.Add($btnInstall)
$sidebar.Controls.Add($btnSync)

$hint = New-Object System.Windows.Forms.Label
$hint.Text = "Daily auto update runs through Windows Task Scheduler. Manual sync is still useful before a focused writing session."
$hint.ForeColor = $colorMuted
$hint.Font = New-Font 8
$hint.AutoSize = $false
$hint.Dock = 'Bottom'
$hint.Height = 78
$sidebar.Controls.Add($hint)

$repoPanel = New-Object System.Windows.Forms.Panel
$repoPanel.Dock = 'Fill'
$repoPanel.BackColor = $colorBg
$main.Controls.Add($repoPanel, 0, 0)

$urlLabel = New-Object System.Windows.Forms.Label
$urlLabel.Text = 'Add GitHub repository'
$urlLabel.Font = New-Font 10 ([System.Drawing.FontStyle]::Bold)
$urlLabel.ForeColor = $colorInk
$urlLabel.AutoSize = $true
$urlLabel.Location = New-Object System.Drawing.Point(0, 4)
$repoPanel.Controls.Add($urlLabel)

$repoUrl = New-Object System.Windows.Forms.TextBox
$repoUrl.Font = New-Font 9
$repoUrl.Width = 520
$repoUrl.Height = 28
$repoUrl.Location = New-Object System.Drawing.Point(0, 32)
try { $repoUrl.PlaceholderText = 'https://github.com/owner/repo.git' } catch { }
$repoPanel.Controls.Add($repoUrl)

$repoType = New-Object System.Windows.Forms.ComboBox
$repoType.DropDownStyle = 'DropDownList'
$repoType.Items.AddRange([string[]]@('skills', 'prompt'))
$repoType.SelectedIndex = 0
$repoType.Width = 112
$repoType.Location = New-Object System.Drawing.Point(536, 32)
$repoPanel.Controls.Add($repoType)

$btnAddRepo = New-Object System.Windows.Forms.Button
$btnAddRepo.Text = 'Add and Sync'
$btnAddRepo.Width = 130
$btnAddRepo.Height = 30
$btnAddRepo.Location = New-Object System.Drawing.Point(662, 31)
$btnAddRepo.FlatStyle = 'Flat'
$btnAddRepo.FlatAppearance.BorderColor = $colorAccent
$btnAddRepo.BackColor = $colorAccent
$btnAddRepo.ForeColor = [System.Drawing.Color]::White
$btnAddRepo.Font = New-Font 9 ([System.Drawing.FontStyle]::Bold)
$repoPanel.Controls.Add($btnAddRepo)

$grid = New-Object System.Windows.Forms.DataGridView
$grid.Dock = 'Fill'
$grid.AllowUserToAddRows = $false
$grid.AllowUserToDeleteRows = $false
$grid.ReadOnly = $true
$grid.RowHeadersVisible = $false
$grid.SelectionMode = 'FullRowSelect'
$grid.BackgroundColor = [System.Drawing.Color]::FromArgb(252, 252, 249)
$grid.BorderStyle = 'FixedSingle'
$grid.GridColor = $colorBorder
$grid.AutoSizeColumnsMode = 'Fill'
$grid.ColumnHeadersDefaultCellStyle.Font = New-Font 9 ([System.Drawing.FontStyle]::Bold)
$grid.DefaultCellStyle.Font = New-Font 9
$grid.Columns.Add('Skill', 'Skill') | Out-Null
$grid.Columns.Add('Repo', 'Repository') | Out-Null
$grid.Columns.Add('Target', 'Source Target') | Out-Null
$main.Controls.Add($grid, 0, 1)

$logBox = New-Object System.Windows.Forms.TextBox
$logBox.Dock = 'Fill'
$logBox.Multiline = $true
$logBox.ReadOnly = $true
$logBox.ScrollBars = 'Vertical'
$logBox.Font = New-Object System.Drawing.Font('Consolas', 9)
$logBox.BackColor = [System.Drawing.Color]::FromArgb(34, 39, 41)
$logBox.ForeColor = [System.Drawing.Color]::FromArgb(224, 232, 225)
$logBox.BorderStyle = 'FixedSingle'
$main.Controls.Add($logBox, 0, 2)

$footer = New-Object System.Windows.Forms.Label
$footer.Dock = 'Fill'
$footer.TextAlign = 'MiddleLeft'
$footer.Padding = New-Object System.Windows.Forms.Padding(22, 0, 0, 0)
$footer.ForeColor = $colorMuted
$footer.Text = "Base: $Base"
$root.Controls.Add($footer, 0, 2)

function Set-Status([string]$text, [string]$kind) {
  $status.Text = $text
  switch ($kind) {
    'success' { $status.BackColor = $colorSuccess }
    'warn' { $status.BackColor = $colorWarn }
    'error' { $status.BackColor = $colorError }
    'running' { $status.BackColor = $colorAccent }
    default { $status.BackColor = $colorAccent }
  }
  [System.Windows.Forms.Application]::DoEvents()
}

function Add-Log([string]$text) {
  $logBox.AppendText($text + [Environment]::NewLine)
}

function Refresh-Skills {
  $grid.Rows.Clear()
  if (Test-Path -LiteralPath $StatePath) {
    $raw = Get-Content -LiteralPath $StatePath -Raw
    if ($raw.Trim()) {
      $items = @($raw | ConvertFrom-Json)
      foreach ($item in ($items | Sort-Object Skill)) {
        [void]$grid.Rows.Add($item.Skill, $item.Repo, $item.Target)
      }
    }
  }
}

function Invoke-Sync {
  Set-Status 'Running sync' 'running'
  $form.Cursor = [System.Windows.Forms.Cursors]::WaitCursor
  $btnSync.Enabled = $false
  Add-Log '--- Sync started ---'
  try {
    $result = Run-PowerShellScript $SkillHubPath
    Add-Log $result.Output
    if ($result.Error) { Add-Log $result.Error }
    if ($result.ExitCode -eq 0) {
      Set-Status 'Sync succeeded' 'success'
      Refresh-Skills
      [System.Windows.Forms.MessageBox]::Show('SkillHub sync completed successfully.', 'SkillHub', 'OK', 'Information') | Out-Null
    } else {
      Set-Status 'Sync failed' 'error'
      [System.Windows.Forms.MessageBox]::Show("SkillHub sync failed. Exit code: $($result.ExitCode)`n`n$result.Error", 'SkillHub', 'OK', 'Error') | Out-Null
    }
  } catch {
    Set-Status 'Sync failed' 'error'
    Add-Log $_.Exception.Message
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'SkillHub error', 'OK', 'Error') | Out-Null
  } finally {
    $btnSync.Enabled = $true
    $form.Cursor = [System.Windows.Forms.Cursors]::Default
  }
}

function Add-Repository {
  $url = $repoUrl.Text.Trim()
  if (-not $url) {
    [System.Windows.Forms.MessageBox]::Show('Paste a GitHub repository URL first.', 'SkillHub', 'OK', 'Warning') | Out-Null
    return
  }
  $name = Get-RepoNameFromUrl $url
  if (-not $name) {
    [System.Windows.Forms.MessageBox]::Show('Could not infer repository name from the URL.', 'SkillHub', 'OK', 'Warning') | Out-Null
    return
  }

  try {
    $config = Read-Config
    $exists = $config.repositories | Where-Object { $_.name -eq $name -or $_.url -eq $url } | Select-Object -First 1
    if ($exists) {
      [System.Windows.Forms.MessageBox]::Show("Repository is already in config: $($exists.name)", 'SkillHub', 'OK', 'Information') | Out-Null
    } else {
      $type = [string]$repoType.SelectedItem
      $repo = [ordered]@{
        name = $name
        url = $url
        type = $type
        mode = if ($type -eq 'prompt') { 'do-not-install' } else { 'scan' }
      }
      $list = @($config.repositories)
      $config.repositories = @($list + ([PSCustomObject]$repo))
      Save-Config $config
      Add-Log "Added repository: $name"
    }
    Invoke-Sync
  } catch {
    Set-Status 'Add failed' 'error'
    Add-Log $_.Exception.Message
    [System.Windows.Forms.MessageBox]::Show($_.Exception.Message, 'Add repository failed', 'OK', 'Error') | Out-Null
  }
}

$btnSync.Add_Click({ Invoke-Sync })
$btnAddRepo.Add_Click({ Add-Repository })
$btnInstall.Add_Click({
  Set-Status 'Installing auto update' 'running'
  $result = Run-PowerShellScript $InstallTaskPath
  Add-Log $result.Output
  if ($result.Error) { Add-Log $result.Error }
  if ($result.ExitCode -eq 0) { Set-Status 'Auto update ready' 'success' } else { Set-Status 'Install failed' 'error' }
})
$btnUninstall.Add_Click({
  Set-Status 'Removing auto update' 'running'
  $result = Run-PowerShellScript $UninstallTaskPath
  Add-Log $result.Output
  if ($result.Error) { Add-Log $result.Error }
  if ($result.ExitCode -eq 0) { Set-Status 'Auto update removed' 'warn' } else { Set-Status 'Remove failed' 'error' }
})
$btnOpenReport.Add_Click({
  if (Test-Path -LiteralPath $ReportPath) { Start-Process -FilePath $ReportPath } else { [System.Windows.Forms.MessageBox]::Show('No report exists yet. Run Sync Now first.', 'SkillHub', 'OK', 'Information') | Out-Null }
})
$btnOpenSkills.Add_Click({ Start-Process -FilePath (Join-Path $Base 'skills') })
$btnOpenSources.Add_Click({ Start-Process -FilePath (Join-Path $Base 'github_sources') })

$form.Add_SizeChanged({
  $status.Location = New-Object System.Drawing.Point(($header.ClientSize.Width - 198), 24)
})

Refresh-Skills
Set-Status 'Ready' 'ready'
[System.Windows.Forms.Application]::EnableVisualStyles()
[System.Windows.Forms.Application]::Run($form)
