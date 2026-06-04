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

This is the SQLite-first indexing milestone with one explicit write surface (router-hub regeneration, gated behind operator consent). Defaults stay safe:

- It does not write to `../skills`
- It does not take over Claude, Codex, or Antigravity links unless you flip the consent toggle
- It opens from the v2 SQLite index first
- It scans real v1 Skills, sources, agents, and diagnostics only when the index is missing or manually refreshed
- It writes only to the v2 SQLite index under `.skillhub-next/` for normal operations
- It seeds the first workspace and preset model from the indexed data
- It keeps a first Agent Adapter Registry covering Claude, Codex, Antigravity, Cursor, Gemini CLI, OpenCode, GitHub Copilot, Windsurf, Kiro, Hermes, OpenClaw and Amp
- It stores enable/disable state in v2 SQLite only, without changing v1 links
- It records adapter safety checks before any future write/sync behavior is allowed
- It records adapter capability metadata and a first read-only project workspace scan

### Router-hub regeneration (new in this milestone)

V2 can rebuild parent / router-hub `SKILL.md` files for every collection that has 2+ child Skills:

- Generated files live under `../app/github_sources/AI-SkillHub-local-routers/<collection>-hub/SKILL.md`, never inside the upstream author's repo, so `git pull` cannot overwrite them
- Parent name uses the `-hub` suffix to avoid colliding with same-named children
- Dry-run plan is always available (`regenerate_router_hubs` Tauri command with `commit: false`)
- Real writes require **both** the `commit: true` argument **and** the in-app real-write authorization
- Each run records a `router_hub_regenerate` event in `audit_events` so you can trace what changed
- The Sources page surfaces a "重建母 Skill 路由" panel with per-collection cards, duplicate-child warnings, and unquoted-marker health gaps

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

v1 stays usable while v2 grows. V2 now treats v1 as a read-only source and builds its own SQLite model for Skills, sources, agents, agent adapters, adapter capabilities, adapter safety checks, workspaces, project scans, presets, snapshots, and audit events.
