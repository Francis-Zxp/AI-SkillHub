# AI SkillHub V2

AI SkillHub V2 is a Windows desktop hub for managing AI agent Skills, Prompt
materials, GitHub sources, and local AI-tool links from one place.

The project has moved to the V2-only layout. The old V1 WebView/PowerShell app
folder has been removed.

## Current Launcher

For local use, start:

```text
AI SkillHub V2 Alpha.exe
```

The executable in the repository root is a local build artifact and is ignored
by Git. Public releases should be created with the V2 release package workflow.

## Core Flow

1. Open AI SkillHub V2.
2. Go to `Sources`.
3. Paste a GitHub repository URL, select source type, category, tags, and notes.
4. Click `一键添加并刷新`.
5. Confirm whether the source should be visible only inside AI SkillHub or also
   synchronized into Claude Code, Codex, or Antigravity.

AI SkillHub installs only real Skills. A folder must contain `SKILL.md` before
it is treated as a callable Skill. Prompt-only repositories remain source
material and are not installed as Skills.

## What V2 Manages

- GitHub Skill repositories.
- Local Skill folders.
- Zip or `.skill` package previews.
- Prompt/reference repositories.
- Parent router Skills and child Skills.
- Claude Code, Codex, and Antigravity shared-skill links.
- Source categories, tags, notes, search, sorting, usage counters, and GitHub
  popularity metadata.
- Diagnostics, share checks, backup/restore dry runs, and release package
  preflight checks.

## Folder Layout

```text
AI_global_skills/
  app-next/                         # V2 Tauri / React / Rust app
    runtime/                        # V2 helper scripts
    data/github_sources/            # local cloned sources, private
    reports/                        # generated reports, private
    .skillhub-next/                 # generated sync state, private
  skills/                           # active shared Skills view, private
  docs/                             # product docs and handoff notes
```

The old V1 paths are no longer part of the product:

```text
app/
AI SkillHub.exe
release/
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
AI SkillHub V2 Alpha.exe
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

The V2 helper scripts live in:

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

## Author

Developed by FrancisZhu.
