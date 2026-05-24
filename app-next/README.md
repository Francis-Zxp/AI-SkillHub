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

This is the initial scaffold. It is intentionally safe:

- It does not write to `../skills`
- It does not modify `../app/github_sources`
- It does not take over Claude, Codex, or Antigravity links
- It only defines the future app shape and a read-only backend command stub

## Before running

Install or verify these tools first:

- Node.js LTS is already available on this computer.
- pnpm is not detected yet.
- Rust/Cargo is not detected yet.
- Visual Studio Build Tools / MSVC is required for Tauri on Windows.

See [docs/toolchain-setup.md](docs/toolchain-setup.md) for download links and exact versions checked on 2026-05-24.

After installing tools, run:

```powershell
cd app-next
npm run check:toolchain
```

Install Rust from:

```text
https://rustup.rs/
```

After tools are ready:

```powershell
cd app-next
pnpm install
pnpm tauri dev
```

## v2 principle

v1 stays usable while v2 grows. The first v2 milestone is a read-only dashboard that can scan the current AI SkillHub library and show Skills, sources, agents, diagnostics, and settings without changing anything.
