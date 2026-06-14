# Changelog

All notable changes to AI SkillHub are documented here.

## 2.0.2 - Stability and release readiness

### Fixed

- Fixed local usage charts so copy-only actions no longer appear as real Skill
  calls, and dashboard charts show all indexed rows inside adaptive scrolling
  panels.
- Fixed the Windows release executable so it opens as a normal desktop app
  without an extra console window.
- Kept AI tool re-detection isolated from Skill Library metadata, so checking
  Claude Code, Codex, or Antigravity no longer clears user notes or categories.
- Updated release and diagnostics scripts to use the real app version instead
  of stale alpha or old-version labels.
- Fixed diagnostics so an installed system WebView2 Runtime is accepted for the
  Tauri desktop app instead of requiring an obsolete packaged WebView2 DLL.

### Validation

- `pnpm build`: passed.
- `cargo test`: passed.
- `cargo clippy --all-targets -- -D warnings`: passed.
- `pnpm tauri build --no-bundle`: passed.
- Diagnostics export: passed with 0 errors and 0 warnings.
- Release package preflight: passed for `AI-SkillHub-2.0.2.zip`.
- Share-recipient test: passed.
- `pnpm audit --prod`: no known vulnerabilities.

## 2.0.1 - UI refresh and Skill Library redesign

### Added

- Added the redesigned AI SkillHub interface with a cleaner app shell, icon
  controls, glass surfaces, motion, particle dashboard background, four themes,
  and Chinese / English / Korean language switching.
- Merged source management and child Skill management into one `Skill Library`
  view. Expanding a source now shows its parent router Skill and child Skills
  directly beneath that source, with edit and enable controls kept in place.

### Changed

- Kept the existing same-name child Skill conflict selector, parent router
  rebuild flow, Agent sync flow, SQLite persistence, and GitHub heat palette
  while adopting the improved visual layout.
- Kept advanced safety and release checks, but moved them out of the daily Skill
  Library path so the normal install/manage workflow stays simpler.
- The browser title and visible product name now show `AI SkillHub`; version
  labels live in release metadata instead of the product name.

## 2.0.0 - Official release

### Fixed

- GitHub Actions frontend CI now uses Node.js 24, matching pnpm 11's runtime
  requirement and avoiding the `node:sqlite` install failure seen on Node 20.
- CI display name is now `AI SkillHub CI` instead of `V2 CI`.

### Release

- Promoted AI SkillHub from alpha builds to the official `2.0.0` release line.

## 2026-06-09 - Refresh and install stability

### Fixed

- Rebuilding parent router Skills now separates updated routers from routers
  that were already current, so repeated rebuilds show "already up to date"
  instead of a misleading skipped count.
- Router Hub rebuild results now include clear collapse controls.
- GitHub heat refresh no longer reports rate limits or temporary network
  failures as repository sync failures. These states are shown as deferred and
  keep the previous cache when available.
- Opening a source edit panel no longer compresses the Skill Library page into a
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
- Added the Skill Library conflict selector for duplicate child Skill names.
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
