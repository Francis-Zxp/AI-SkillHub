# AI SkillHub

AI SkillHub is a Windows desktop hub for managing AI agent Skills, Prompt
materials, GitHub sources, and local AI-tool links from one place.

<img width="1910" height="1044" alt="PixPin_2026-06-07_21-06-11" src="https://github.com/user-attachments/assets/49af89bb-5715-4a36-bcf0-4990be0f31df" />

The project is now maintained as a single current desktop app. Older prototype
folders are not part of the product.

## Current Launcher

For local use, start:

```text
AI SkillHub.exe
```

The executable in the repository root is a local build artifact and is ignored
by Git. Public releases should be created with the release package workflow.

## Core Flow

1. Open AI SkillHub.
2. Go to `Sources`.
3. Paste a GitHub repository URL, select source type, category, tags, and notes.
4. Click `一键添加并刷新`.
5. AI SkillHub scans real `SKILL.md` folders, rebuilds parent router Skills,
   refreshes the local index, and can synchronize the active Skill view into
   Claude Code, Codex, and Antigravity.

AI SkillHub installs only real Skills. A folder must contain `SKILL.md` before
it is treated as a callable Skill. Prompt-only repositories remain source
material and are not installed as Skills.

## What AI SkillHub Manages

- GitHub Skill repositories.
- Local Skill folders.
- Zip or `.skill` package previews.
- Prompt/reference repositories.
- Parent router Skills and child Skills.
- Same-name child Skill conflict review and default-source choices.
- Claude Code, Codex, and Antigravity shared-skill links.
- Source categories, tags, notes, search, sorting, usage counters, and GitHub
  popularity metadata.
- Diagnostics, share checks, backup/restore dry runs, and release package
  preflight checks.

## Folder Layout

```text
AI_global_skills/
  app-next/                         # Tauri / React / Rust app
    runtime/                        # helper scripts
    data/github_sources/            # local cloned sources, private
    reports/                        # generated reports, private
    .skillhub-next/                 # generated sync state, private
  skills/                           # active shared Skills view, private
  docs/                             # product docs
```

Older prototype paths are no longer part of the product:

```text
app/
```

## Privacy Boundary

The public repository must not include personal Skills, cloned third-party
repositories, local reports, local config, build output, or diagnostics.

Important ignored paths:

```text
skills/
app-next/data/
app-next/reports/
app-next/.skillhub-next/
app-next/runtime/skillhub.config.json
app-next/node_modules/
app-next/src-tauri/target/
AI SkillHub.exe
```

## Developer Setup

Requirements for development:

- Windows 10 or Windows 11
- Node.js LTS
- pnpm
- Rust
- Visual Studio C++ Build Tools
- Git for Windows

Useful checks:

```text
cd app-next
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
pnpm tauri build --no-bundle
```

## Runtime Scripts

The helper scripts live in:

```text
app-next/runtime/
```

Do not restore or depend on the old `app/SkillHub.ps1` path.

## Skill Router Standard

AI SkillHub generates parent router Skills under:

```text
app-next/data/github_sources/AI-SkillHub-local-routers/
```

Generated parent routers use `[ROUTER-HUB]`. Child entries use
`[CHILD-SKILL]`. Author-owned `SKILL.md` files are not modified, so GitHub
updates do not overwrite AI SkillHub's routing standard.

See `docs/skill-router-standard.md` for the rule.

## Same-Name Skill Conflicts

Different sources can contain child Skills with the same callable name, such as
`Nature-Paper-Skills / figure-planner` and `PaperSpine / figure-planner`.

AI SkillHub does not delete, rename, overwrite, or silently choose between them. The
Sources page shows a conflict selector where the user can set a default source,
reset the conflict to unresolved, or ignore the reminder. The choice is stored
in the local SQLite table `skill_conflict_choices`, outside author repositories,
so GitHub updates do not overwrite it.

## Author

Developed by FrancisZhu.
