# AI SkillHub

AI SkillHub is a Windows desktop hub for managing AI agent Skills, Prompt
materials, GitHub sources, and local AI-tool links from one place.

V3.X
<img width="2560" height="1526" alt="image" src="https://github.com/user-attachments/assets/408eab67-1912-47ca-af5d-3dad1c383e01" />

V2.X
<img width="2560" height="1528" alt="image" src="https://github.com/user-attachments/assets/2d3f5a78-ca53-44f7-80be-1c62e4ef2eed" />

V1.X
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
2. Go to `Skill Library`.
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
- Automatic same-name child Skill routing, source-qualified aliases, and
  optional manual overrides.
- Claude Code, OpenAI Codex, and Antigravity shared-skill links, with separate
  desktop-app and code-capability detection.
- Source categories, tags, notes, search, sorting, usage counters, and GitHub
  popularity metadata.
- Private 1–5 star Skill ratings, stored in local SQLite, with rating-first
  sorting at both source and Skill level.
- Diagnostics, share checks, backup/restore dry runs, and release package
  preflight checks.

## Persistent User Data and Upgrades

Starting with v3.0.2, sources, active Skills, ratings, configuration, reports,
and the SQLite index live outside the replaceable program folder:

```text
%LOCALAPPDATA%\AI SkillHub\UserData\
  sources\
  skills\
  state\skillhub-next.sqlite3
  reports\
  skillhub.config.json
```

You can extract a newer release into another folder or replace the old program
files. The new executable reuses the same user-data directory. On first launch,
v3.0.2 performs a copy-only migration from the old portable
`app-next/data/github_sources`, `skills`, and `.skillhub-next` locations; it
does not delete the old copy.

The internal `AI-SkillHub-local-routers` storage folder is not shown as a user
source. Generated aliases and same-name conflict dispatchers are routing
infrastructure, so they are not counted as standalone local Skills. A source
still shows zero Skills when it genuinely contains no
`SKILL.md`; it remains Prompt/reference material instead of being installed as
a Skill.

## Personal Skill Ratings

Each Skill can be rated from 1 to 5 stars in `Skill Library`. Clicking the
current score again clears it. Choose `My rating (high to low)` to surface the
best-rated sources and Skills first. Parent Skills can be rated directly on the
source-card header; the source order uses the parent score first and child
  ratings second. Ratings are private metadata in the persistent SQLite
  database: they are not GitHub stars, do not edit author repositories, are not
  published with the project, and survive application updates.

Physical folders found directly under `skills/` without a managed source are
shown separately as `Unassigned standalone Skills`. AI SkillHub never deletes
them automatically because they may contain user data.

## Folder Layout

```text
AI_global_skills/
  AI SkillHub.exe                   # program
  app-next/runtime/                 # packaged helper scripts
  docs/                             # product docs
```

Personal runtime data is stored in `%LOCALAPPDATA%\AI SkillHub\UserData`.
Developer checkouts may still contain ignored legacy folders for migration
tests, but public release packages do not contain personal sources or ratings.

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
%LOCALAPPDATA%\AI SkillHub\UserData\sources\AI-SkillHub-local-routers\
```

Generated parent routers use `[ROUTER-HUB]`. Child entries use
`[CHILD-SKILL]`. Author-owned `SKILL.md` files are not modified, so GitHub
updates do not overwrite AI SkillHub's routing standard.

See `docs/skill-router-standard.md` for the rule.

## Same-Name Skill Routing

Different sources can contain child Skills with the same callable name, such as
`Nature-Paper-Skills / figure-planner` and `PaperSpine / figure-planner`.

This means the exact slash-call name is duplicated; it does not mean the two
Skills were merely judged to have similar functions. AI SkillHub automatically
chooses the canonical route using enabled state, health, personal rating, and
path specificity. It never deletes or overwrites a candidate, and it generates
a source-qualified alias for every choice.

A user can still set a manual override in Routing Observatory. The override is
stored in the local SQLite table `skill_conflict_choices`, so GitHub updates do
not erase it. For broad tasks, invoke the parent Skill; its generated routing
instructions select the smallest child Skill that fits the request.

## Author

Developed by FrancisZhu.
