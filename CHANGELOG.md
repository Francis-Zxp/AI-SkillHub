# Changelog

All notable changes to AI SkillHub are documented here.

## Unreleased - v1.1.1

### Added

- First-run guide panel with three setup steps: add source, sync, and link detected AI coding tools.
- Quick Start help dialog in Chinese, English, and Korean.
- Troubleshooting bundle export for sharing sanitized operation, import, sync, diagnostics, and zip-preview reports.
- Reports folder shortcut and `--troubleshooting-test` smoke test.
- Share-recipient validation script plus `--share-recipient-test`, covering a clean downloaded copy, first-run empty config, paths with spaces/Chinese, missing Codex, no detected AI tools, missing Git, and missing WebView2.
- Release package builder plus `--release-preflight`, generating an allowlisted zip, SHA256 file, and privacy audit report before publishing.
- In-app Release Center for system checks, share-recipient validation, troubleshooting export, release preflight, and report/release folder shortcuts.
- Latest-result cards inside the Release Center, showing recent diagnostics, share validation, release preflight, and troubleshooting bundle status.

### Changed

- App version label is prepared as `v1.1.1`.
- Clean first-run diagnostics now treat an empty `skills` directory as `info` instead of `warn`, so new users are not scared by an expected empty library.
- Codex detection wording now distinguishes "detected but not managed" from "managed per Skill", avoiding the confusing "detected / not linked / writable" state.
- Added an AI Tool Details dialog that separates detection, managed state, folder permission, path, and next-step guidance.

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
