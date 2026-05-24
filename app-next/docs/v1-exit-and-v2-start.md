# v1 exit and v2 start

Date: 2026-05-24

## v1 decision

v1 is complete enough to become the maintenance line.

The reason is practical: v1 now has the core share-safe workflow that was blocking the project.

- GitHub source management
- Local folder and zip import preview
- Prompt-vs-Skill separation
- Claude Code, Codex, and Antigravity link takeover
- No fake AI tool directories for missing tools
- Daily hidden auto-update task
- Diagnostics, troubleshooting bundle, share-recipient validation, and release preflight
- Skill health indicators
- System Check problem locator with next-step buttons

Remaining v1 work should be limited to bug fixes and small usability patches. New product-model work should move to v2.

## v2 first milestone

Create `app-next` as a parallel Tauri + React + TypeScript + Rust + SQLite workspace.

Milestone 1 is read-only:

1. Show dashboard, library, sources, agents, and settings.
2. Read v1 folders without writing to them.
3. Define SQLite schema.
4. Build a Rust scanner for `../skills`, `../app/github_sources`, and `../app/reports/latest-diagnostics.json`.
5. Keep v1 executable usable while v2 grows.

## Toolchain status

Detected:

- Node.js v24.16.0 LTS
- npm

Not detected yet:

- pnpm
- Rust/Cargo

Until Rust/Cargo are installed, v2 can be scaffolded and reviewed, but Tauri cannot be compiled.
