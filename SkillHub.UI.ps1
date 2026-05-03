param(
  [switch]$SelfTest,
  [ValidateSet('auto','zh','en','ko')]
  [string]$Language = 'auto'
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName PresentationCore
Add-Type -AssemblyName PresentationFramework
Add-Type -AssemblyName WindowsBase
Add-Type -AssemblyName System.Data

$Base = Split-Path -Parent $MyInvocation.MyCommand.Path
$ConfigPath = Join-Path $Base 'skillhub.config.json'
$SkillHubPath = Join-Path $Base 'SkillHub.ps1'
$AgentLinksPath = Join-Path $Base 'Manage-AgentSkillLinks.ps1'
$InstallTaskPath = Join-Path $Base '安装每日自动更新任务.ps1'
$UninstallTaskPath = Join-Path $Base '卸载每日自动更新任务.ps1'
$ReportPath = Join-Path $Base 'reports\last-sync.md'
$StatePath = Join-Path $Base '.skillhub\managed-links.json'
$SourcesPath = Join-Path $Base 'github_sources'
$SkillsPath = Join-Path $Base 'skills'

if ($Language -eq 'auto') {
  $uiLang = [System.Globalization.CultureInfo]::CurrentUICulture.TwoLetterISOLanguageName
  $cultureLang = [System.Globalization.CultureInfo]::CurrentCulture.TwoLetterISOLanguageName
  $script:Lang = if ($uiLang -eq 'zh' -or $cultureLang -eq 'zh') { 'zh' } elseif ($uiLang -eq 'ko' -or $cultureLang -eq 'ko') { 'ko' } else { 'en' }
} else {
  $script:Lang = $Language
}

$Text = @{
  zh = @{
    Title = 'SkillHub 管理器'
    Subtitle = '同步 GitHub 技能、重建链接、保持激活目录干净。'
    Ready = '就绪'
    Running = '正在运行'
    Success = '同步成功'
    Failed = '同步失败'
    AutoReady = '自动更新已就绪'
    AutoRemoved = '自动更新已移除'
    SyncNow = '立即同步'
    AddRepo = '添加并同步'
    InstallAuto = '安装每日自动更新'
    RemoveAuto = '移除自动更新'
    AdoptLinks = '接管 AI 软件链接'
    OpenReport = '打开报告'
    OpenSkills = '打开技能目录'
    OpenSources = '打开源码目录'
    RepoUrl = 'GitHub 项目地址'
    RepoUrlHint = '粘贴 GitHub 地址，例如 https://github.com/owner/repo.git'
    RepoType = '类型'
    TypeSkills = '技能'
    TypePrompt = '提示词'
    Category = '分类'
    Note = '备注'
    AutoCategory = '自动分类'
    SkillsTab = '已启用技能'
    ReposTab = '仓库来源'
    Activity = '运行反馈'
    Summary = '当前状态'
    ActiveSkills = '已启用技能'
    Repositories = '仓库'
    LastSync = '最近同步'
    AutoUpdate = '自动更新'
    DailyReady = '每日 09:00'
    NotChecked = '未确认'
    Skill = '技能'
    Repo = '仓库'
    Target = '来源位置'
    Name = '名称'
    Url = '地址'
    Mode = '模式'
    Type = '类型'
    Base = '根目录'
    NeedUrl = '请先粘贴 GitHub 项目地址。'
    BadUrl = '无法从这个地址识别仓库名称。'
    RepoExists = '这个仓库已经在配置里。'
    AddedRepo = '已添加仓库'
    SyncStarted = '开始同步。'
    SyncDone = '同步完成。'
    InstallStarted = '正在安装每日自动更新。'
    RemoveStarted = '正在移除每日自动更新。'
    OpenReportMissing = '还没有同步报告，请先点击“立即同步”。'
    DoneBox = 'SkillHub 同步已完成。'
    FailBox = '操作失败，请查看下方运行反馈。'
    LangToggle = 'English'
    DetailHint = '失败时会显示必要的技术原因；成功时只显示摘要。'
  }
  en = @{
    Title = 'SkillHub Manager'
    Subtitle = 'Sync GitHub Skills, rebuild links, and keep the active folder clean.'
    Ready = 'Ready'
    Running = 'Running'
    Success = 'Sync succeeded'
    Failed = 'Sync failed'
    AutoReady = 'Auto update ready'
    AutoRemoved = 'Auto update removed'
    SyncNow = 'Sync Now'
    AddRepo = 'Add and Sync'
    InstallAuto = 'Install Daily Auto Update'
    RemoveAuto = 'Remove Auto Update'
    AdoptLinks = 'Adopt AI App Links'
    OpenReport = 'Open Report'
    OpenSkills = 'Open Skills Folder'
    OpenSources = 'Open Sources Folder'
    RepoUrl = 'GitHub repository URL'
    RepoUrlHint = 'Paste a GitHub URL, for example https://github.com/owner/repo.git'
    RepoType = 'Type'
    TypeSkills = 'skills'
    TypePrompt = 'prompt'
    Category = 'Category'
    Note = 'Note'
    AutoCategory = 'Auto category'
    SkillsTab = 'Active Skills'
    ReposTab = 'Repositories'
    Activity = 'Activity'
    Summary = 'Status'
    ActiveSkills = 'Active Skills'
    Repositories = 'Repositories'
    LastSync = 'Last Sync'
    AutoUpdate = 'Auto Update'
    DailyReady = 'Daily 09:00'
    NotChecked = 'Not checked'
    Skill = 'Skill'
    Repo = 'Repository'
    Target = 'Source Target'
    Name = 'Name'
    Url = 'URL'
    Mode = 'Mode'
    Type = 'Type'
    Base = 'Base'
    NeedUrl = 'Paste a GitHub repository URL first.'
    BadUrl = 'Could not infer a repository name from this URL.'
    RepoExists = 'This repository is already in the config.'
    AddedRepo = 'Added repository'
    SyncStarted = 'Sync started.'
    SyncDone = 'Sync completed.'
    InstallStarted = 'Installing daily auto update.'
    RemoveStarted = 'Removing daily auto update.'
    OpenReportMissing = 'No report exists yet. Click Sync Now first.'
    DoneBox = 'SkillHub sync completed successfully.'
    FailBox = 'Operation failed. Check the activity panel below.'
    LangToggle = '中文'
    DetailHint = 'Failures show the necessary technical reason. Successful runs show a concise summary.'
  }
  ko = @{
    Title = 'SkillHub 관리자'
    Subtitle = 'GitHub Skill을 동기화하고 링크를 다시 만들며 활성 폴더를 정리합니다.'
    Ready = '준비됨'
    Running = '실행 중'
    Success = '동기화 성공'
    Failed = '동기화 실패'
    AutoReady = '자동 업데이트 준비됨'
    AutoRemoved = '자동 업데이트 제거됨'
    SyncNow = '지금 동기화'
    AddRepo = '추가 후 동기화'
    InstallAuto = '매일 자동 업데이트 설치'
    RemoveAuto = '자동 업데이트 제거'
    AdoptLinks = 'AI 앱 링크 연결'
    OpenReport = '보고서 열기'
    OpenSkills = 'Skill 폴더 열기'
    OpenSources = '소스 폴더 열기'
    RepoUrl = 'GitHub 프로젝트 주소'
    RepoUrlHint = 'GitHub 주소를 붙여넣으세요. 예: https://github.com/owner/repo.git'
    RepoType = '유형'
    TypeSkills = 'Skill'
    TypePrompt = '프롬프트'
    Category = '분류'
    Note = '메모'
    AutoCategory = '자동 분류'
    SkillsTab = '활성 Skill'
    ReposTab = '저장소'
    Activity = '실행 피드백'
    Summary = '상태'
    ActiveSkills = '활성 Skill'
    Repositories = '저장소'
    LastSync = '최근 동기화'
    AutoUpdate = '자동 업데이트'
    DailyReady = '매일 09:00'
    NotChecked = '확인 안 됨'
    Skill = 'Skill'
    Repo = '저장소'
    Target = '소스 위치'
    Name = '이름'
    Url = '주소'
    Mode = '모드'
    Type = '유형'
    Base = '루트'
    NeedUrl = '먼저 GitHub 프로젝트 주소를 붙여넣으세요.'
    BadUrl = '이 주소에서 저장소 이름을 찾을 수 없습니다.'
    RepoExists = '이 저장소는 이미 설정에 있습니다.'
    AddedRepo = '저장소 추가됨'
    SyncStarted = '동기화를 시작합니다.'
    SyncDone = '동기화가 완료되었습니다.'
    InstallStarted = '매일 자동 업데이트를 설치합니다.'
    RemoveStarted = '매일 자동 업데이트를 제거합니다.'
    OpenReportMissing = '아직 보고서가 없습니다. 먼저 동기화하세요.'
    DoneBox = 'SkillHub 동기화가 완료되었습니다.'
    FailBox = '작업에 실패했습니다. 아래 실행 피드백을 확인하세요.'
    LangToggle = '中文'
    DetailHint = '실패 시 필요한 기술적 이유를 표시합니다. 성공 시에는 요약만 표시합니다.'
  }
}

function T([string]$key) {
  return $Text[$script:Lang][$key]
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
  $config | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $ConfigPath -Encoding UTF8
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

function New-Table($columns) {
  $table = New-Object System.Data.DataTable
  foreach ($column in $columns) { [void]$table.Columns.Add($column) }
  return ,$table
}

$xaml = @'
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="SkillHub" Width="1180" Height="780" MinWidth="1040" MinHeight="700" Opacity="0"
        WindowStartupLocation="CenterScreen" Background="#101617" FontFamily="Segoe UI">
  <Window.Triggers>
    <EventTrigger RoutedEvent="Window.Loaded">
      <BeginStoryboard>
        <Storyboard>
          <DoubleAnimation Storyboard.TargetProperty="Opacity" From="0" To="1" Duration="0:0:0.22"/>
        </Storyboard>
      </BeginStoryboard>
    </EventTrigger>
  </Window.Triggers>
  <Window.Resources>
    <SolidColorBrush x:Key="Ink" Color="#EAF2EF"/>
    <SolidColorBrush x:Key="Muted" Color="#9AA9A6"/>
    <SolidColorBrush x:Key="Surface" Color="#172123"/>
    <SolidColorBrush x:Key="Panel" Color="#131B1D"/>
    <SolidColorBrush x:Key="Border" Color="#2A393B"/>
    <SolidColorBrush x:Key="Accent" Color="#48B8C7"/>
    <SolidColorBrush x:Key="AccentHover" Color="#64D2DE"/>
    <SolidColorBrush x:Key="Success" Color="#39A77B"/>
    <SolidColorBrush x:Key="Warning" Color="#D29A45"/>
    <SolidColorBrush x:Key="Error" Color="#D45B67"/>

    <Style TargetType="Button">
      <Setter Property="Height" Value="38"/>
      <Setter Property="Padding" Value="14,0"/>
      <Setter Property="Cursor" Value="Hand"/>
      <Setter Property="Foreground" Value="{StaticResource Ink}"/>
      <Setter Property="Background" Value="{StaticResource Surface}"/>
      <Setter Property="BorderBrush" Value="{StaticResource Border}"/>
      <Setter Property="BorderThickness" Value="1"/>
      <Setter Property="FontWeight" Value="SemiBold"/>
      <Setter Property="Template">
        <Setter.Value>
          <ControlTemplate TargetType="Button">
            <Border x:Name="Chrome" Background="{TemplateBinding Background}" BorderBrush="{TemplateBinding BorderBrush}"
                    BorderThickness="{TemplateBinding BorderThickness}" CornerRadius="7">
              <ContentPresenter HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>
            <ControlTemplate.Triggers>
              <Trigger Property="IsMouseOver" Value="True">
                <Setter TargetName="Chrome" Property="Background" Value="#1D2A2D"/>
                <Setter TargetName="Chrome" Property="BorderBrush" Value="#3D575D"/>
              </Trigger>
              <Trigger Property="IsPressed" Value="True">
                <Setter TargetName="Chrome" Property="Background" Value="#213236"/>
              </Trigger>
              <Trigger Property="IsEnabled" Value="False">
                <Setter Property="Opacity" Value="0.55"/>
              </Trigger>
            </ControlTemplate.Triggers>
          </ControlTemplate>
        </Setter.Value>
      </Setter>
    </Style>

    <Style x:Key="PrimaryButton" TargetType="Button" BasedOn="{StaticResource {x:Type Button}}">
      <Setter Property="Foreground" Value="White"/>
      <Setter Property="Background" Value="{StaticResource Accent}"/>
      <Setter Property="BorderBrush" Value="{StaticResource Accent}"/>
      <Style.Triggers>
        <Trigger Property="IsMouseOver" Value="True">
          <Setter Property="Background" Value="{StaticResource AccentHover}"/>
          <Setter Property="BorderBrush" Value="{StaticResource AccentHover}"/>
        </Trigger>
      </Style.Triggers>
    </Style>

    <Style TargetType="TextBox">
      <Setter Property="Height" Value="36"/>
      <Setter Property="Padding" Value="10,7"/>
      <Setter Property="BorderBrush" Value="{StaticResource Border}"/>
      <Setter Property="Background" Value="{StaticResource Surface}"/>
      <Setter Property="Foreground" Value="{StaticResource Ink}"/>
      <Setter Property="VerticalContentAlignment" Value="Center"/>
    </Style>

    <Style TargetType="ComboBox">
      <Setter Property="Height" Value="36"/>
      <Setter Property="Padding" Value="8,5"/>
      <Setter Property="BorderBrush" Value="{StaticResource Border}"/>
      <Setter Property="Background" Value="{StaticResource Surface}"/>
    </Style>

    <Style TargetType="DataGrid">
      <Setter Property="Background" Value="{StaticResource Surface}"/>
      <Setter Property="BorderBrush" Value="{StaticResource Border}"/>
      <Setter Property="BorderThickness" Value="1"/>
      <Setter Property="GridLinesVisibility" Value="Horizontal"/>
      <Setter Property="HorizontalGridLinesBrush" Value="#263437"/>
      <Setter Property="Foreground" Value="{StaticResource Ink}"/>
      <Setter Property="RowHeaderWidth" Value="0"/>
      <Setter Property="HeadersVisibility" Value="Column"/>
      <Setter Property="CanUserAddRows" Value="False"/>
      <Setter Property="CanUserDeleteRows" Value="False"/>
      <Setter Property="IsReadOnly" Value="True"/>
      <Setter Property="AutoGenerateColumns" Value="False"/>
    </Style>
  </Window.Resources>

  <Grid Margin="22">
    <Grid.RowDefinitions>
      <RowDefinition Height="82"/>
      <RowDefinition Height="*"/>
      <RowDefinition Height="30"/>
    </Grid.RowDefinitions>

    <Grid Grid.Row="0">
      <Grid.ColumnDefinitions>
        <ColumnDefinition Width="*"/>
        <ColumnDefinition Width="Auto"/>
      </Grid.ColumnDefinitions>
      <StackPanel VerticalAlignment="Center">
        <TextBlock x:Name="TitleText" FontSize="25" FontWeight="Bold" Foreground="{StaticResource Ink}"/>
        <TextBlock x:Name="SubtitleText" Margin="1,7,0,0" FontSize="13" Foreground="{StaticResource Muted}"/>
      </StackPanel>
      <Border Grid.Column="1" CornerRadius="18" Background="#152022" BorderBrush="{StaticResource Border}" BorderThickness="1" Padding="3" VerticalAlignment="Center">
        <StackPanel Orientation="Horizontal">
          <Button x:Name="LangZhButton" Width="72" Height="30" Content="中文"/>
          <Button x:Name="LangEnButton" Width="82" Height="30" Content="English" Margin="4,0,0,0"/>
          <Button x:Name="LangKoButton" Width="76" Height="30" Content="한국어" Margin="4,0,0,0"/>
        </StackPanel>
      </Border>
    </Grid>

    <Grid Grid.Row="1">
      <Grid.ColumnDefinitions>
        <ColumnDefinition Width="284"/>
        <ColumnDefinition Width="18"/>
        <ColumnDefinition Width="*"/>
      </Grid.ColumnDefinitions>

      <Border Grid.Column="0" CornerRadius="10" Background="{StaticResource Panel}" BorderBrush="{StaticResource Border}" BorderThickness="1" Padding="16">
        <DockPanel LastChildFill="True">
          <StackPanel DockPanel.Dock="Top">
            <TextBlock x:Name="SummaryTitle" FontSize="15" FontWeight="Bold" Foreground="{StaticResource Ink}" Margin="0,0,0,12"/>
            <Border x:Name="StatusPill" Height="34" CornerRadius="17" Background="{StaticResource Accent}" Margin="0,0,0,14">
              <TextBlock x:Name="StatusText" Foreground="White" FontWeight="SemiBold" HorizontalAlignment="Center" VerticalAlignment="Center" Margin="16,0"/>
            </Border>
            <Grid Margin="0,0,0,14">
              <Grid.ColumnDefinitions>
                <ColumnDefinition Width="*"/>
                <ColumnDefinition Width="Auto"/>
              </Grid.ColumnDefinitions>
              <StackPanel>
                <TextBlock x:Name="ActiveSkillsLabel" Foreground="{StaticResource Muted}"/>
                <TextBlock x:Name="ActiveSkillsValue" FontSize="24" FontWeight="Bold" Foreground="{StaticResource Ink}" Margin="0,2,0,0"/>
              </StackPanel>
              <StackPanel Grid.Column="1" HorizontalAlignment="Right">
                <TextBlock x:Name="ReposLabel" Foreground="{StaticResource Muted}"/>
                <TextBlock x:Name="ReposValue" FontSize="24" FontWeight="Bold" Foreground="{StaticResource Ink}" HorizontalAlignment="Right" Margin="0,2,0,0"/>
              </StackPanel>
            </Grid>
            <Border CornerRadius="8" Background="#172123" BorderBrush="{StaticResource Border}" BorderThickness="1" Padding="10" Margin="0,0,0,14">
              <StackPanel>
                <TextBlock x:Name="AutoUpdateLabel" Foreground="{StaticResource Muted}"/>
                <TextBlock x:Name="AutoUpdateValue" FontWeight="SemiBold" Foreground="{StaticResource Ink}" Margin="0,3,0,0"/>
                <TextBlock x:Name="LastSyncValue" Foreground="{StaticResource Muted}" Margin="0,8,0,0" TextWrapping="Wrap"/>
              </StackPanel>
            </Border>
            <Button x:Name="SyncButton" Style="{StaticResource PrimaryButton}" Margin="0,0,0,10"/>
            <Button x:Name="AdoptLinksButton" Margin="0,0,0,10"/>
            <Button x:Name="InstallButton" Margin="0,0,0,10"/>
            <Button x:Name="RemoveButton" Margin="0,0,0,10"/>
            <Button x:Name="ReportButton" Margin="0,0,0,10"/>
            <Button x:Name="SkillsButton" Margin="0,0,0,10"/>
            <Button x:Name="SourcesButton" Margin="0,0,0,10"/>
          </StackPanel>
          <TextBlock x:Name="DetailHint" DockPanel.Dock="Bottom" Foreground="{StaticResource Muted}" FontSize="12" TextWrapping="Wrap"/>
        </DockPanel>
      </Border>

      <Grid Grid.Column="2">
        <Grid.RowDefinitions>
          <RowDefinition Height="154"/>
          <RowDefinition Height="*"/>
          <RowDefinition Height="142"/>
        </Grid.RowDefinitions>

        <Border Grid.Row="0" CornerRadius="10" Background="{StaticResource Surface}" BorderBrush="{StaticResource Border}" BorderThickness="1" Padding="14">
          <Grid>
            <Grid.RowDefinitions>
              <RowDefinition Height="Auto"/>
              <RowDefinition Height="Auto"/>
              <RowDefinition Height="Auto"/>
            </Grid.RowDefinitions>
            <TextBlock x:Name="RepoUrlLabel" FontWeight="SemiBold" Foreground="{StaticResource Ink}" Margin="0,0,0,8"/>
            <Grid Grid.Row="1">
              <Grid.ColumnDefinitions>
                <ColumnDefinition Width="*"/>
                <ColumnDefinition Width="130"/>
                <ColumnDefinition Width="132"/>
              </Grid.ColumnDefinitions>
              <TextBox x:Name="RepoUrlBox" Grid.Column="0" Margin="0,0,10,0"/>
              <ComboBox x:Name="RepoTypeBox" Grid.Column="1" Margin="0,0,10,0"/>
              <Button x:Name="AddRepoButton" Grid.Column="2" Style="{StaticResource PrimaryButton}"/>
            </Grid>
            <Grid Grid.Row="2" Margin="0,12,0,0">
              <Grid.ColumnDefinitions>
                <ColumnDefinition Width="180"/>
                <ColumnDefinition Width="*"/>
              </Grid.ColumnDefinitions>
              <ComboBox x:Name="RepoCategoryBox" Grid.Column="0" Margin="0,0,10,0"/>
              <TextBox x:Name="RepoNoteBox" Grid.Column="1"/>
            </Grid>
          </Grid>
        </Border>

        <TabControl Grid.Row="1" Margin="0,14,0,14">
          <TabItem x:Name="SkillsTab">
            <DataGrid x:Name="SkillsGrid">
              <DataGrid.Columns>
                <DataGridTextColumn x:Name="SkillColumn" Binding="{Binding Skill}" Width="180"/>
                <DataGridTextColumn x:Name="SkillCategoryColumn" Binding="{Binding Category}" Width="130"/>
                <DataGridTextColumn x:Name="SkillRepoColumn" Binding="{Binding Repo}" Width="190"/>
                <DataGridTextColumn x:Name="SkillNoteColumn" Binding="{Binding Note}" Width="180"/>
                <DataGridTextColumn x:Name="TargetColumn" Binding="{Binding Target}" Width="*"/>
              </DataGrid.Columns>
            </DataGrid>
          </TabItem>
          <TabItem x:Name="ReposTab">
            <DataGrid x:Name="ReposGrid">
              <DataGrid.Columns>
                <DataGridTextColumn x:Name="RepoNameColumn" Binding="{Binding Name}" Width="180"/>
                <DataGridTextColumn x:Name="RepoTypeColumn" Binding="{Binding Type}" Width="120"/>
                <DataGridTextColumn x:Name="RepoCategoryColumn" Binding="{Binding Category}" Width="130"/>
                <DataGridTextColumn x:Name="RepoModeColumn" Binding="{Binding Mode}" Width="140"/>
                <DataGridTextColumn x:Name="RepoNoteColumn" Binding="{Binding Note}" Width="180"/>
                <DataGridTextColumn x:Name="RepoUrlColumn" Binding="{Binding Url}" Width="*"/>
              </DataGrid.Columns>
            </DataGrid>
          </TabItem>
        </TabControl>

        <Border Grid.Row="2" CornerRadius="10" Background="#0E1415" BorderBrush="#253438" BorderThickness="1" Padding="14">
          <Grid>
            <Grid.RowDefinitions>
              <RowDefinition Height="Auto"/>
              <RowDefinition Height="*"/>
            </Grid.RowDefinitions>
            <TextBlock x:Name="ActivityTitle" Foreground="#EAF0E9" FontWeight="SemiBold" Margin="0,0,0,8"/>
            <TextBox x:Name="ActivityBox" Grid.Row="1" Background="#0E1415" Foreground="#EAF0E9" BorderThickness="0"
                     FontFamily="Consolas" FontSize="12" TextWrapping="Wrap" AcceptsReturn="True"
                     IsReadOnly="True" VerticalScrollBarVisibility="Auto"/>
          </Grid>
        </Border>
      </Grid>
    </Grid>

    <TextBlock x:Name="FooterText" Grid.Row="2" Foreground="{StaticResource Muted}" VerticalAlignment="Center"/>
  </Grid>
</Window>
'@

$reader = New-Object System.Xml.XmlNodeReader ([xml]$xaml)
$Window = [Windows.Markup.XamlReader]::Load($reader)

$Names = @(
  'TitleText','SubtitleText','StatusPill','StatusText','LangZhButton','LangEnButton','LangKoButton','SummaryTitle','ActiveSkillsLabel',
  'ActiveSkillsValue','ReposLabel','ReposValue','AutoUpdateLabel','AutoUpdateValue','LastSyncValue',
  'SyncButton','AdoptLinksButton','InstallButton','RemoveButton','ReportButton','SkillsButton','SourcesButton','DetailHint',
  'RepoUrlLabel','RepoUrlBox','RepoTypeBox','RepoCategoryBox','RepoNoteBox','AddRepoButton','SkillsTab','ReposTab','SkillsGrid','ReposGrid',
  'SkillColumn','SkillCategoryColumn','SkillRepoColumn','SkillNoteColumn','TargetColumn','RepoNameColumn','RepoTypeColumn','RepoCategoryColumn','RepoModeColumn','RepoNoteColumn','RepoUrlColumn',
  'ActivityTitle','ActivityBox','FooterText'
)
foreach ($name in $Names) {
  Set-Variable -Name $name -Value $Window.FindName($name) -Scope Script
}

function Set-Status([string]$key, [string]$kind) {
  $StatusText.Text = T $key
  $brushKey = switch ($kind) {
    'success' { 'Success' }
    'warn' { 'Warning' }
    'error' { 'Error' }
    default { 'Accent' }
  }
  $StatusPill.Background = $Window.Resources[$brushKey]
  [System.Windows.Threading.Dispatcher]::CurrentDispatcher.Invoke([Action]{}, [System.Windows.Threading.DispatcherPriority]::Background)
}

function Set-LanguageVisuals {
  $activeBrush = $Window.Resources['Accent']
  $normalBrush = $Window.Resources['Surface']
  $inkBrush = $Window.Resources['Ink']
  foreach ($button in @($LangZhButton,$LangEnButton,$LangKoButton)) {
    $button.Background = $normalBrush
    $button.Foreground = $inkBrush
  }
  switch ($script:Lang) {
    'zh' { $LangZhButton.Background = $activeBrush; $LangZhButton.Foreground = [System.Windows.Media.Brushes]::White }
    'en' { $LangEnButton.Background = $activeBrush; $LangEnButton.Foreground = [System.Windows.Media.Brushes]::White }
    'ko' { $LangKoButton.Background = $activeBrush; $LangKoButton.Foreground = [System.Windows.Media.Brushes]::White }
  }
}

function Add-Activity([string]$message) {
  $time = Get-Date -Format 'HH:mm:ss'
  $ActivityBox.AppendText("[$time] $message`r`n")
  $ActivityBox.ScrollToEnd()
}

function Set-Busy([bool]$busy) {
  $Window.Cursor = if ($busy) { [System.Windows.Input.Cursors]::Wait } else { [System.Windows.Input.Cursors]::Arrow }
  foreach ($button in @($SyncButton,$AdoptLinksButton,$InstallButton,$RemoveButton,$AddRepoButton)) {
    $button.IsEnabled = -not $busy
  }
  [System.Windows.Threading.Dispatcher]::CurrentDispatcher.Invoke([Action]{}, [System.Windows.Threading.DispatcherPriority]::Background)
}

function Test-DailyTask {
  $result = & schtasks.exe /Query /TN AISkillHubDailyUpdate /FO LIST 2>$null
  return ($LASTEXITCODE -eq 0)
}

function Get-LastReportTime {
  if (Test-Path -LiteralPath $ReportPath) {
    return (Get-Item -LiteralPath $ReportPath).LastWriteTime.ToString('yyyy-MM-dd HH:mm:ss')
  }
  return T 'NotChecked'
}

function Format-RepoType([string]$type) {
  if ($script:Lang -ne 'zh') { return $type }
  switch ($type) {
    'skills' { return '技能' }
    'prompt' { return '提示词' }
    default { return $type }
  }
}

function Format-RepoMode([string]$mode) {
  if ($script:Lang -ne 'zh') { return $mode }
  switch ($mode) {
    'scan' { return '自动扫描' }
    'explicit' { return '指定路径' }
    'do-not-install' { return '不安装' }
    default { return $mode }
  }
}

function Refresh-Repos {
  $table = New-Table @('Name','Type','Category','Mode','Note','Url')
  try {
    $config = Read-Config
    foreach ($repo in ($config.repositories | Sort-Object name)) {
      $row = $table.NewRow()
      $row.Name = [string]$repo.name
      $row.Type = Format-RepoType ([string]$repo.type)
      $row.Category = if ($repo.category) { [string]$repo.category } else { T 'AutoCategory' }
      $row.Mode = Format-RepoMode ([string]$repo.mode)
      $row.Note = if ($repo.note) { [string]$repo.note } else { '' }
      $row.Url = [string]$repo.url
      $table.Rows.Add($row)
    }
  } catch {
    Add-Activity $_.Exception.Message
  }
  $ReposGrid.ItemsSource = $table.DefaultView
  $ReposValue.Text = [string]$table.Rows.Count
}

function Refresh-Skills {
  $table = New-Table @('Skill','Category','Repo','Note','Target')
  if (Test-Path -LiteralPath $StatePath) {
    $raw = Get-Content -LiteralPath $StatePath -Raw
    if ($raw.Trim()) {
      foreach ($item in (@($raw | ConvertFrom-Json) | Sort-Object Skill)) {
        $row = $table.NewRow()
        $row.Skill = [string]$item.Skill
        $row.Category = if ($item.Category) { [string]$item.Category } else { T 'AutoCategory' }
        $row.Repo = [string]$item.Repo
        $row.Note = if ($item.Note) { [string]$item.Note } else { '' }
        $row.Target = [string]$item.Target
        $table.Rows.Add($row)
      }
    }
  }
  $SkillsGrid.ItemsSource = $table.DefaultView
  $ActiveSkillsValue.Text = [string]$table.Rows.Count
  $LastSyncValue.Text = "$(T 'LastSync'): $(Get-LastReportTime)"
  $AutoUpdateValue.Text = if (Test-DailyTask) { T 'DailyReady' } else { T 'NotChecked' }
}

function Apply-Language {
  $Window.Title = T 'Title'
  $TitleText.Text = T 'Title'
  $SubtitleText.Text = T 'Subtitle'
  Set-LanguageVisuals
  $SummaryTitle.Text = T 'Summary'
  $ActiveSkillsLabel.Text = T 'ActiveSkills'
  $ReposLabel.Text = T 'Repositories'
  $AutoUpdateLabel.Text = T 'AutoUpdate'
  $SyncButton.Content = T 'SyncNow'
  $AdoptLinksButton.Content = T 'AdoptLinks'
  $InstallButton.Content = T 'InstallAuto'
  $RemoveButton.Content = T 'RemoveAuto'
  $ReportButton.Content = T 'OpenReport'
  $SkillsButton.Content = T 'OpenSkills'
  $SourcesButton.Content = T 'OpenSources'
  $DetailHint.Text = T 'DetailHint'
  $RepoUrlLabel.Text = T 'RepoUrl'
  $RepoUrlBox.ToolTip = T 'RepoUrlHint'
  $AddRepoButton.Content = T 'AddRepo'
  $SkillsTab.Header = T 'SkillsTab'
  $ReposTab.Header = T 'ReposTab'
  $SkillColumn.Header = T 'Skill'
  $SkillCategoryColumn.Header = T 'Category'
  $SkillRepoColumn.Header = T 'Repo'
  $SkillNoteColumn.Header = T 'Note'
  $TargetColumn.Header = T 'Target'
  $RepoNameColumn.Header = T 'Name'
  $RepoTypeColumn.Header = T 'Type'
  $RepoCategoryColumn.Header = T 'Category'
  $RepoModeColumn.Header = T 'Mode'
  $RepoNoteColumn.Header = T 'Note'
  $RepoUrlColumn.Header = T 'Url'
  $ActivityTitle.Text = T 'Activity'
  $FooterText.Text = "$(T 'Base'): $Base"

  $RepoTypeBox.Items.Clear()
  [void]$RepoTypeBox.Items.Add((T 'TypeSkills'))
  [void]$RepoTypeBox.Items.Add((T 'TypePrompt'))
  $RepoTypeBox.SelectedIndex = 0
  $RepoCategoryBox.Items.Clear()
  foreach ($category in @((T 'AutoCategory'),'论文科研','科研图表','界面设计','文献研究','学术汇报','提示词/润色','通用工具')) {
    [void]$RepoCategoryBox.Items.Add($category)
  }
  $RepoCategoryBox.SelectedIndex = 0
  $RepoNoteBox.ToolTip = T 'Note'
  Refresh-Repos
  Refresh-Skills
  Set-Status 'Ready' 'ready'
}

function Invoke-Sync {
  Set-Busy $true
  Set-Status 'Running' 'running'
  Add-Activity (T 'SyncStarted')
  try {
    $result = Run-PowerShellScript $SkillHubPath
    if ($result.ExitCode -eq 0) {
      Refresh-Repos
      Refresh-Skills
      Set-Status 'Success' 'success'
      Add-Activity "$(T 'SyncDone') $(T 'ActiveSkills'): $($ActiveSkillsValue.Text)"
      [System.Windows.MessageBox]::Show((T 'DoneBox'), (T 'Title'), 'OK', 'Information') | Out-Null
    } else {
      Set-Status 'Failed' 'error'
      $detail = if ($result.Error) { $result.Error.Trim() } else { $result.Output.Trim() }
      Add-Activity $detail
      [System.Windows.MessageBox]::Show((T 'FailBox'), (T 'Title'), 'OK', 'Error') | Out-Null
    }
  } catch {
    Set-Status 'Failed' 'error'
    Add-Activity $_.Exception.Message
    [System.Windows.MessageBox]::Show((T 'FailBox'), (T 'Title'), 'OK', 'Error') | Out-Null
  } finally {
    Set-Busy $false
  }
}

function Add-Repository {
  $url = $RepoUrlBox.Text.Trim()
  if (-not $url) {
    [System.Windows.MessageBox]::Show((T 'NeedUrl'), (T 'Title'), 'OK', 'Warning') | Out-Null
    return
  }

  $name = Get-RepoNameFromUrl $url
  if (-not $name) {
    [System.Windows.MessageBox]::Show((T 'BadUrl'), (T 'Title'), 'OK', 'Warning') | Out-Null
    return
  }

  try {
    $config = Read-Config
    $exists = $config.repositories | Where-Object { $_.name -eq $name -or $_.url -eq $url } | Select-Object -First 1
    if ($exists) {
      [System.Windows.MessageBox]::Show((T 'RepoExists'), (T 'Title'), 'OK', 'Information') | Out-Null
    } else {
      $isPrompt = ($RepoTypeBox.SelectedIndex -eq 1)
      $category = [string]$RepoCategoryBox.SelectedItem
      $note = $RepoNoteBox.Text.Trim()
      $repo = [ordered]@{
        name = $name
        url = $url
        type = if ($isPrompt) { 'prompt' } else { 'skills' }
        mode = if ($isPrompt) { 'do-not-install' } else { 'scan' }
      }
      if ($category -and $category -ne (T 'AutoCategory')) { $repo.category = $category }
      if ($note) { $repo.note = $note }
      $config.repositories = @(@($config.repositories) + ([PSCustomObject]$repo))
      Save-Config $config
      Add-Activity "$(T 'AddedRepo'): $name"
      $RepoUrlBox.Clear()
      $RepoNoteBox.Clear()
    }
    Invoke-Sync
  } catch {
    Set-Status 'Failed' 'error'
    Add-Activity $_.Exception.Message
    [System.Windows.MessageBox]::Show((T 'FailBox'), (T 'Title'), 'OK', 'Error') | Out-Null
  }
}

$SyncButton.Add_Click({ Invoke-Sync })
$AddRepoButton.Add_Click({ Add-Repository })
$AdoptLinksButton.Add_Click({
  Set-Busy $true
  Set-Status 'Running' 'running'
  Add-Activity (T 'AdoptLinks')
  try {
    $result = Run-PowerShellScript $AgentLinksPath
    if ($result.ExitCode -eq 0) {
      Set-Status 'Success' 'success'
      Add-Activity (($result.Output).Trim())
    } else {
      Set-Status 'Failed' 'error'
      Add-Activity (($result.Error + $result.Output).Trim())
    }
  } finally { Set-Busy $false }
})
$InstallButton.Add_Click({
  Set-Busy $true
  Set-Status 'Running' 'running'
  Add-Activity (T 'InstallStarted')
  try {
    $result = Run-PowerShellScript $InstallTaskPath
    if ($result.ExitCode -eq 0) {
      Set-Status 'AutoReady' 'success'
      Add-Activity (T 'AutoReady')
    } else {
      Set-Status 'Failed' 'error'
      Add-Activity (($result.Error + $result.Output).Trim())
    }
    Refresh-Skills
  } finally { Set-Busy $false }
})
$RemoveButton.Add_Click({
  Set-Busy $true
  Set-Status 'Running' 'running'
  Add-Activity (T 'RemoveStarted')
  try {
    $result = Run-PowerShellScript $UninstallTaskPath
    if ($result.ExitCode -eq 0) {
      Set-Status 'AutoRemoved' 'warn'
      Add-Activity (T 'AutoRemoved')
    } else {
      Set-Status 'Failed' 'error'
      Add-Activity (($result.Error + $result.Output).Trim())
    }
    Refresh-Skills
  } finally { Set-Busy $false }
})
$ReportButton.Add_Click({
  if (Test-Path -LiteralPath $ReportPath) { Start-Process -FilePath $ReportPath }
  else { [System.Windows.MessageBox]::Show((T 'OpenReportMissing'), (T 'Title'), 'OK', 'Information') | Out-Null }
})
$SkillsButton.Add_Click({ if (Test-Path -LiteralPath $SkillsPath) { Start-Process -FilePath $SkillsPath } })
$SourcesButton.Add_Click({ if (Test-Path -LiteralPath $SourcesPath) { Start-Process -FilePath $SourcesPath } })
$LangZhButton.Add_Click({ $script:Lang = 'zh'; Apply-Language })
$LangEnButton.Add_Click({ $script:Lang = 'en'; Apply-Language })
$LangKoButton.Add_Click({ $script:Lang = 'ko'; Apply-Language })

Apply-Language
Add-Activity (T 'Ready')
if ($SelfTest) {
  "UI self-test OK. Language=$script:Lang; Skills=$($ActiveSkillsValue.Text); Repositories=$($ReposValue.Text)"
  return
}
[void]$Window.ShowDialog()

