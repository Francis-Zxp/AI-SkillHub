# Changelog

All notable changes to AI SkillHub are documented here.

## 2026-06-06 - V2-only migration

### Added

- Added same-name child Skill conflict detection in V2.
- Added the Sources page conflict selector for duplicate child Skill names.
- Added persistent local conflict choices in SQLite table
  `skill_conflict_choices`.
- Added `app-next/SKILL_CONFLICT_SELECTOR.md` as the product rule for this
  behavior.

### Changed

- AI SkillHub is now maintained as a V2-only project.
- The old V1 `app/` implementation has been removed from the working tree.
- The root launcher is now `AI SkillHub.exe`.
- Runtime helper scripts now live under `app-next/runtime/`.
- Managed GitHub/local sources now live under `app-next/data/github_sources/`.
- Generated reports now live under `app-next/reports/`.
- Generated sync state now lives under `app-next/.skillhub-next/`.
- Public documentation was rewritten to describe V2 only.

### Removed

- Removed the old V1 executable and refreshed the current root launcher as
  `AI SkillHub.exe`.
- Removed old `app/` WebView/PowerShell implementation.
- Removed old `release/` output folder.
- Removed old v1.1 screenshots and release notes from public docs.

### Kept

- Kept `skills/` because it is the active shared Skill view used by AI tools.
  It is private and ignored by Git.

### Validation

- `pnpm build`: passed.
- `cargo test`: 41 passed.
- `pnpm tauri build --no-bundle`: passed.
- `app-next/runtime/SkillHub.ps1 -NoPull -ReportOnly`: passed.

## Historical note

V1 was the initial working implementation. Its useful runtime behavior has been
migrated into V2 runtime scripts. Future development should not restore the old
V1 app folder.
