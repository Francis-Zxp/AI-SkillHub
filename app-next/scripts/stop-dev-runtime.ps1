$ErrorActionPreference = 'Stop'

$processes = Get-Process -ErrorAction SilentlyContinue |
  Where-Object { $_.ProcessName -eq 'ai-skillhub-next' }

if (-not $processes) {
  Write-Host 'AI SkillHub dev runtime is not running.'
  exit 0
}

foreach ($process in $processes) {
  $path = ''
  try {
    $path = $process.Path
  } catch {
    $path = ''
  }

  if ($path -and ($path -notlike '*\app-next\src-tauri\target\debug\ai-skillhub-next.exe')) {
    Write-Host "Skipping unrelated process $($process.Id): $path"
    continue
  }

  Stop-Process -Id $process.Id -Force
  Write-Host "Stopped AI SkillHub dev runtime process $($process.Id)."
}
