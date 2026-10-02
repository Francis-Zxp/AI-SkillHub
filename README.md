# AI SkillHub

**English** · [Chinese](README_ZH.md) · [Korean](README_KO.md)

### Your AI Skills, organized in one place.

A Windows desktop app for collecting Skills, keeping their sources up to date, and connecting them to your AI tools. Manage GitHub repositories, local Skills, Prompt collections, and MCP configurations from a searchable local library.

[**Download the latest release**](https://github.com/Francis-Zxp/AI-SkillHub/releases/latest) · [What's new](CHANGELOG.md) · [Report an issue](https://github.com/Francis-Zxp/AI-SkillHub/issues)

![AI SkillHub — English dashboard with the Sky noon theme](docs/images/sky-noon-festival-en.png)

*Sample library in the Sky noon theme. Each island represents a category; its size reflects the content it contains.*

## What you can do

| Task | How AI SkillHub helps |
| --- | --- |
| Build your library | Import GitHub repositories, local folders, ZIP files, or `.skill` packages. Discover Skills already present in supported local AI-tool directories. |
| Find the right capability | Search, categorize, tag, rate, and annotate sources and individual Skills. Explore categories as islands or relationships as a star map. |
| Keep sources current | Check upstream Git repositories and bring in newly added Skills. See which sources changed, stayed current, failed, or were skipped. |
| Use multiple AI tools | Detect supported tools such as Claude Code, Codex, and Antigravity, then deliver enabled Skills to the selected tools. |
| Keep similar Skills together | Source-specific parent entries preserve each collection and its child Skills. Similar capabilities from different authors can coexist. |
| Manage MCP connections | Inspect supported host configurations, preview changes, apply bindings, and restore snapshots. Origin MCP also has a dedicated setup and connection check. |

## Start in three steps

1. **Install** the `AI-SkillHub-<version>-setup.exe` from the latest release. A ZIP package is also available.
2. **Add a source** in the Skill Library, or discover existing Skills under AI Tools.
3. **Choose your AI tools** and synchronize the enabled Skills. Open a source to see its usage instructions.

The interface is available in English, Chinese, and Korean. Theme, text size, icon size, animation, and power-saving controls let you adjust the workspace.

## Skills, Prompts, and MCP

- **Skills** contain `SKILL.md` and describe capabilities an agent can load. Parent entries organize the child Skills belonging to the same source.
- **Prompts** are reusable instructions or reference materials. A Prompt repository is not installed as a Skill merely because it contains Markdown files.
- **MCP** connects an AI client to an external server or application. Importing a configuration does not install every server dependency or prove that it is running; use the connection checks provided for supported integrations.

## Updates and your data

**Source updates** pull changes from the original repositories. A pinned version, local edits, or a source without an upstream address may require attention; the update results explain the outcome for each source. Your own notes and ratings remain separate from upstream content.

**App updates** use signed official release packages. Settings provides update checks and installation; the latest release page remains available for manual downloads. Release history lives in the [changelog](CHANGELOG.md).

Your library, settings, ratings, and local index are stored outside the program directory:

```text
%LOCALAPPDATA%\AI SkillHub\UserData\
```

Imported source scripts are not executed during scanning. Source review, diagnostics, and recoverable snapshots help you inspect changes before applying them. Public release packages do not include the developer's personal library.

## Development

Built with **Tauri 2 · React · TypeScript · Rust · SQLite**.

The maintained desktop workspace is [`app-next`](app-next/README.md). See its documentation for development requirements and commands, and the [Skill Router Standard](docs/skill-router-standard.md) for parent and child routing.

---

Created by **FrancisZhu**.
