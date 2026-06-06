# AI SkillHub V2 Roadmap Status

Updated: 2026-06-06

## Current Product Line

AI SkillHub is now V2-only.

The old V1 desktop implementation has been removed:

```text
app/
AI SkillHub.exe
release/
```

V2 is the only maintained app line.

## Current Architecture

```text
AI_global_skills/
  app-next/
    runtime/                        # V2 helper scripts
    data/github_sources/            # local source repositories, private
    reports/                        # local reports, private
    .skillhub-next/                 # local generated state, private
  skills/                           # active shared Skills view, private
```

The V2 app is built with:

- Tauri 2
- React
- TypeScript
- Rust
- SQLite
- PowerShell helper scripts in `app-next/runtime`

## Completed Migration

- V1 helper scripts were migrated into `app-next/runtime`.
- V1 source repositories were migrated into `app-next/data/github_sources`.
- V2 no longer reads from `app/SkillHub.ps1` or `app/github_sources`.
- Old V1 app files were deleted.
- Git ignore rules were updated so private Skills, local sources, reports,
  configs, and build outputs stay out of GitHub.
- Root launcher was refreshed as `AI SkillHub V2 Alpha.exe`.

## Current User Flow

1. Open V2.
2. Use `Sources` to paste a GitHub URL or select a local/zip source.
3. Select type, category, tags, note, and enable state.
4. Click `一键添加并刷新`.
5. Turn on AI-tool sync authorization if the source should be linked into
   Claude Code, Codex, or Antigravity.

## Router Standard

Generated parent Skill routers live under:

```text
app-next/data/github_sources/AI-SkillHub-local-routers/
```

Markers:

```text
[ROUTER-HUB]   parent router Skill
[CHILD-SKILL] child Skill entry
```

Author-owned `SKILL.md` files are not edited.

## Current Known Work

These are product improvements, not V1 blockers:

- Conflict selector for same-name child Skills from different repositories.
- Continued page-by-page UI polish.
- Cleaner formal release package workflow.
- More complete first-run onboarding for users with no existing local sources.

## Validation

Last validated after V2-only migration:

```text
pnpm build: passed
cargo test: 39 passed
pnpm tauri build --no-bundle: passed
runtime SkillHub.ps1 -NoPull -ReportOnly: passed
```

The active local data at validation time:

```text
app-next/data/github_sources: 26 source repositories
skills: 363 active Skill folders
```
