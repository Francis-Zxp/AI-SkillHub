# Changelog

All notable changes to AI SkillHub are documented here.

## 2026-06-09 - Refresh and install stability

### Fixed

- GitHub heat refresh no longer reports rate limits or temporary network
  failures as repository sync failures. These states are shown as deferred and
  keep the previous cache when available.
- Opening a source edit panel no longer compresses the Sources page into a
  narrow column.

### Changed

- One-click source install now refreshes shared Skills, parent router Skills,
  and Agent links as part of the install flow.
- The daily `同步 / 刷新` action now performs the expected update-and-sync flow
  directly. Higher-risk release and backup gates remain separate.
- Removed old internal migration/roadmap docs from the public docs folder.

### Validation

- `pnpm build`: passed.
- `cargo test`: 49 passed.

## 2026-06-06 - Desktop consolidation

### Added

- Added same-name child Skill conflict detection in the desktop app.
- Added the Sources page conflict selector for duplicate child Skill names.
- Added persistent local conflict choices in SQLite table
  `skill_conflict_choices`.
- Added `app-next/SKILL_CONFLICT_SELECTOR.md` as the product rule for this
  behavior.

### Changed

- AI SkillHub is now maintained as one desktop project.
- Older prototype app implementations have been removed from the working tree.
- The root launcher is now `AI SkillHub.exe`.
- Runtime helper scripts now live under `app-next/runtime/`.
- Managed GitHub/local sources now live under `app-next/data/github_sources/`.
- Generated reports now live under `app-next/reports/`.
- Generated sync state now lives under `app-next/.skillhub-next/`.
- Public documentation was rewritten for the current desktop app.

### Removed

- Removed the old prototype executable and refreshed the current root launcher as
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

The first prototype proved the runtime approach. Current development should stay
on the maintained desktop app and runtime scripts.
