# Changelog

All notable changes to AI SkillHub are documented here.

## Unreleased - v1.1.1

### Added

- First-run guide panel with three setup steps: add source, sync, and link detected AI coding tools.
- Quick Start help dialog in Chinese, English, and Korean.

### Changed

- App version label is prepared as `v1.1.1`.

## v1.1.0 - Public Sharing Release

This is the first public GitHub-ready release of AI SkillHub.

### Added

- Public README with setup, download, privacy, and first-run guidance.
- Screenshot preview in `docs/images/v1.1.png`.
- Release package layout for sharing with other Windows users.
- Empty example config at `app/skillhub.config.example.json`.
- First-run behavior that creates a local config automatically when none exists.
- Clear no-agent guidance when Claude Code, Codex, or Antigravity are not detected.
- Share preflight diagnostics for Claude-only computers.

### Changed

- Product name is frozen as `AI SkillHub`.
- Public repository name is `AI-SkillHub`.
- Personal skills, GitHub source clones, reports, caches, archives, packages, and local config are excluded from the public repository.
- Missing Codex is treated as an informational state instead of a failure.

### Fixed

- Link takeover no longer creates fake AI tool folders when a supported tool is not installed.
- Diagnostics handle missing Git more clearly.
- Public repository simulation now works without a personal `app/skillhub.config.json`.

### Download

Use the GitHub Releases page and download `AI-SkillHub-v1.1.0.zip`.
