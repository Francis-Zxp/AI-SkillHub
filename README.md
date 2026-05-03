# SkillHub

SkillHub is a small Windows manager for AI Skills collected from GitHub.

It keeps a clean active `skills` folder by:

- cloning or updating GitHub repositories
- scanning for real Skill folders containing `SKILL.md`
- linking active Skills into one shared folder
- removing stale managed links
- keeping prompt-only repositories out of active Skills
- showing success or failure through a simple desktop UI

## Quick Start

Double-click:

```text
打开SkillHub界面.cmd
```

This opens the UI in the system language when possible. You can also use:

```text
打开SkillHub界面_中文.cmd
OpenSkillHubUI_English.cmd
```

Then use:

```text
Sync Now
```

to update repositories and rebuild links.

## Add A GitHub Skill

Paste a GitHub URL into the UI, choose:

```text
skills
```

then click:

```text
Add and Sync
```

For prompt repositories that should not be installed as Skills, choose:

```text
prompt
```

## Command Line

Run:

```powershell
powershell -ExecutionPolicy Bypass -File ".\SkillHub.ps1"
```

## Daily Auto Update

Install:

```powershell
powershell -ExecutionPolicy Bypass -File ".\安装每日自动更新任务.ps1"
```

Remove:

```powershell
powershell -ExecutionPolicy Bypass -File ".\卸载每日自动更新任务.ps1"
```

## Portability

After copying the whole folder to another computer or another path, run:

```powershell
powershell -ExecutionPolicy Bypass -File ".\SkillHub.ps1"
```

This rebuilds Windows links for the new location.

