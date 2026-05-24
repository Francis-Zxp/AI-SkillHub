# AI SkillHub v2 app-next

`app-next` is the clean v2 workspace for AI SkillHub. It does not replace the current v1 WebView2 app yet.

## Goal

Build the next AI SkillHub with:

- Tauri 2 desktop shell
- React + TypeScript + Vite frontend
- Rust backend
- SQLite-backed state
- Read-only migration from the current v1 folders first

## Current status

This is the SQLite-first indexing milestone. It is intentionally safe:

- It does not write to `../skills`
- It does not modify `../app/github_sources`
- It does not take over Claude, Codex, or Antigravity links
- It opens from the v2 SQLite index first
- It scans real v1 Skills, sources, agents, and diagnostics only when the index is missing or manually refreshed
- It writes only to the v2 SQLite index under `.skillhub-next/`
- It seeds the first workspace and preset model from the indexed data

## Before running

Install or verify these tools first:

- Node.js LTS is already available on this computer.
- pnpm 11.2.2 is available on this computer.
- Rust/Cargo 1.95.0 is available on this computer.
- Visual Studio Build Tools / MSVC is required for Tauri on Windows.

See [docs/toolchain-setup.md](docs/toolchain-setup.md) for download links and exact versions checked on 2026-05-25.

After installing tools, run:

```powershell
cd app-next
npm run check:toolchain
pnpm install
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
```

After tools are ready:

```powershell
cd app-next
pnpm install
pnpm tauri dev
```

## v2 principle

v1 stays usable while v2 grows. V2 now treats v1 as a read-only source and builds its own SQLite model for Skills, sources, agents, workspaces, presets, snapshots, and audit events.
