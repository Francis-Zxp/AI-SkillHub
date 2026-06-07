# AI SkillHub V2-only migration

Date: 2026-06-06

## Current decision

AI SkillHub has been migrated to the V2 layout. The old V1 PowerShell/WebView app directory is removed.

Use this launcher:

```text
D:\My Files\AI_global_skills\AI SkillHub.exe
```

## V2 runtime layout

```text
D:\My Files\AI_global_skills\
  AI SkillHub.exe                   # current desktop launcher
  app-next\                         # V2 Tauri / React app
    runtime\                        # V2 PowerShell helper scripts
    data\github_sources\            # local cloned source repositories, private
    reports\                        # generated diagnostics and preflight reports, private
    .skillhub-next\                 # V2 sync state, private
  skills\                           # active shared skills linked to AI tools, private
  docs\                             # product, migration, and handoff documents
```

Removed legacy V1 items:

```text
app\
AI SkillHub.exe
release\
```

## Public repository boundary

These local data folders must stay out of GitHub:

```text
skills\
app-next\data\
app-next\reports\
app-next\.skillhub-next\
app-next\runtime\skillhub.config.json
app-next\node_modules\
app-next\src-tauri\target\
release\
其它人的优秀项目案例\
```

Only source code, runtime templates, docs, and app assets should be committed.

## V2 validation after migration

Validation performed after deleting V1:

```text
V2 runtime sync/report-only: passed
V2 diagnostics export: passed
V2 share-recipient test: passed
pnpm build: passed
cargo test: 41 passed
pnpm tauri build --no-bundle: passed
```

Additional V2 behavior added after the migration cleanup:

- Same-name child Skill conflicts are surfaced in the Sources page.
- User choices are stored in local SQLite table `skill_conflict_choices`.
- Author repositories are not modified to solve conflicts.

Current active data:

```text
app-next\data\github_sources: 26 source repositories
skills: 363 active skill folders
```

## Important operating rule

Do not restore code paths that depend on `app\SkillHub.ps1` or `app\github_sources`.

V2 helper scripts live in:

```text
app-next\runtime\
```

V2 managed sources live in:

```text
app-next\data\github_sources\
```

The active AI-tool shared skills view remains:

```text
skills\
```

This `skills` directory is not V1. It is the shared active skill view and must not be deleted.
