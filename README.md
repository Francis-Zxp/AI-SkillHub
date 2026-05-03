# AI SkillHub

AI SkillHub is a Windows manager for AI Skills collected from GitHub.

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
AI SkillHub.exe
```

The interface opens in the system language when possible and supports:

```text
中文 / English / 한국어
```

Use `Sync Now` / `立即同步` to update repositories and rebuild links.

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

You can also open `AI SkillHub.exe` and click the AI app link adoption button to connect Claude Code, Codex, and Antigravity to the active Skills folder.


