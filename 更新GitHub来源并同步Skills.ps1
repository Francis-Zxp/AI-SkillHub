$script = Join-Path (Split-Path -Parent $MyInvocation.MyCommand.Path) 'SkillHub.ps1'
powershell -ExecutionPolicy Bypass -File $script
