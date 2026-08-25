# AI SkillHub

[简体中文](README.md) | **English**

AI SkillHub is a Windows desktop hub for managing AI agent Skills, Prompt
materials, GitHub sources, and local AI-tool links from one place. It can infer
purpose and usage from local source evidence while keeping user edits in
control.

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
5. A five-stage progress bar remains visible while preview, bounded download,
   security review, promotion, and refresh run off the WebView event thread.
6. AI SkillHub scans real `SKILL.md` folders, proposes editable metadata,
   rebuilds source-scoped parent router Skills, refreshes the local index, and
   can synchronize the active Skill view into Claude Code, Codex, and
   Antigravity.

AI SkillHub installs only real Skills. A folder must contain `SKILL.md` before
it is treated as a callable Skill. Prompt-only repositories remain source
material and are not installed as Skills.

## What AI SkillHub Manages

- GitHub Skill repositories.
- Local Skill folders.
- Zip or `.skill` package previews.
- Prompt/reference repositories.
- Parent router Skills and child Skills.
- One canonical parent route per non-empty source. Children stay source-scoped;
  exact same-name capabilities do not create global aliases, and their exact
  names can be copied from the library for selection through the parent.
- Claude Code, OpenAI Codex, and Antigravity shared-skill links, with separate
  desktop-app and code-capability detection.
- A secret-safe Codex and Claude Code MCP inventory plus confirmed add, update,
  remove, static verification, and snapshot rollback for supported bindings.
  Rollback data stays in private app state, is protected for the current Windows
  user, survives app restarts within its retention window, and refuses to
  overwrite externally changed host configuration. AI SkillHub never starts
  the configured server or reads credential values.
- Source categories, tags, notes, search, sorting, usage counters, and GitHub
  popularity metadata.
- Offline, bounded metadata recognition from `README`, `SKILL.md`, and source
  identity, including editable summaries, purposes, usage guides, categories,
  and custom tags.
- Per-file staging security reports. High-risk findings block promotion;
  medium-risk findings remain staged for explicit review.
- Private 1–5 star Skill ratings, stored in local SQLite, with rating-first
  sorting at both source and Skill level.
- Git source commit pins, upstream update-diff previews, and one-click rollback
  when a verified source backup exists.
- An explainable local quality score using personal/child rating, indexed
  health, recorded local use, and security scanning. Missing evidence is
  excluded; GitHub stars remain popularity only.
- An Adapter Doctor that explains desktop-app detection, local Code capability,
  PATH freshness, Skills-directory readiness, and stale directory residue.
- An allowlist-only legacy cleanup assistant that is enabled only after
  successful v4 migration and SQLite health checks. It moves confirmed old
  data to a recoverable backup and never selects the developer `release`
  directory.
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

Starting with v3.0.3, use the signed NSIS setup executable as the primary
installation method. AI SkillHub checks the official GitHub Release channel in
the background; when a newer signed release exists, Settings offers one-click
download, replacement, and restart. The updater accepts only packages signed by
the AI SkillHub release key.

v3.0.5 moves large source operations to background workers, accepts up to 6000
selected files under the unchanged 80 MB / 16 MB safety ceilings, and was
validated against the real `pbakaus/impeccable` repository. Signed program
updates keep the stable user-data directory in place.

v3.0.7 labels the fast startup cache/SQLite read as local-index loading rather
than synchronization. Theme-aware editors now retain explicit high contrast in
all ten themes, the atlas bloom is concentric with the graph geometry, and
bounded 5–20 session-stable meteors add restrained depth. The homepage also
offers a reversible immersive mode and an allowlisted shortcut to the official
GitHub project.

v3.0.2 and older builds do not contain this updater. Install the current formal
release once, then future upgrades are handled inside the app. The portable zip
remains a fallback for users who cannot install software.

The v3.0.4 migration recovers old portable sources one source at a time,
resumes interrupted copies, validates content before atomic promotion, and
backs up SQLite before selectively merging user metadata. It does not overwrite
a newer destination. Concurrent startup scans are serialized and a manifest
cannot finish while a source has failed or still needs repair. After recovery,
the user may explicitly move allowlisted legacy locations to a recoverable
backup with the cleanup assistant.

The internal `AI-SkillHub-local-routers` storage folder is not shown as a user
source. Generated parent routes are delivery infrastructure, so they are not
counted as standalone local Skills. A source
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

Metadata inference is local and does not execute source scripts. Generated
metadata, security findings, adapter evidence, ratings, and migration manifests
are private runtime data and are excluded from public release packages.

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
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/build-formal-release.ps1
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

This means the child name is duplicated; it does not mean the two Skills were
merely judged to have similar functions. AI SkillHub never deletes or overwrites
either candidate, but it also does not publish hundreds of child names as global
aliases. Invoke the relevant source parent and, when useful, paste the exact child
name copied from the library; the generated parent instructions keep routing
inside that source.

## Author

Developed by FrancisZhu.
