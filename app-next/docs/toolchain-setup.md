# v2 toolchain setup

Checked on: 2026-05-25

This file records the tools needed to run the AI SkillHub v2 `app-next` Tauri project.

## What to install

| Tool | Version to use | Status on this computer | Download / official page |
|---|---:|---|---|
| Node.js | Already installed: `v24.16.0` | OK | https://nodejs.org/en/download |
| pnpm | `11.2.2` | OK | https://pnpm.io/installation |
| Rust stable | `1.95.0` via rustup | OK | https://www.rust-lang.org/tools/install |
| Visual Studio Build Tools 2026 | Installed: `18.4.1`; current stable channel: `18.6.1` | OK | https://visualstudio.microsoft.com/downloads/ |
| Microsoft Edge WebView2 Runtime | Evergreen runtime | Already installed for v1 | https://developer.microsoft.com/microsoft-edge/webview2/ |

This computer is ready for the first real Tauri run.

## Recommended install order

1. Keep the current Node.js `v24.16.0`.
2. Keep pnpm pinned to `11.2.2` for this project.
3. Keep Rust stable `1.95.0` / Cargo `1.95.0`.
4. Skip Visual Studio Build Tools if `npm run check:toolchain` says it is detected.
5. Restart the terminal or restart the computer if commands are still not found.

## Visual Studio Build Tools workload

If installing Build Tools on another computer, choose:

- `Desktop development with C++`
- MSVC v143 C++ build tools
- Windows 10 SDK or Windows 11 SDK

Tauri requires Microsoft C++ Build Tools and WebView2 for Windows development.

## pnpm install command

Use one of these. The npm command is the simplest on Windows:

```powershell
npm install -g pnpm@11.2.2
```

If using Corepack instead:

```powershell
npm install --global corepack@latest
corepack enable pnpm
corepack prepare pnpm@11.2.2 --activate
```

Then check:

```powershell
pnpm --version
```

It should print `11.2.2`.

## Rust install command

The official Windows installer is `rustup-init.exe`. You can download it from the Rust page, or install Rustup with winget:

```powershell
winget install --id Rustlang.Rustup
```

After installation, restart the terminal and check:

```powershell
rustc --version
cargo --version
```

## Commands after installation

```powershell
cd "D:\My Files\AI_global_skills\app-next"
npm run check:toolchain
pnpm install
pnpm build
pnpm tauri info
```

## How to start v2 during development

V2 is not the same as the released v1 executable yet. It is still the Tauri development line.

Use this command while developing:

```powershell
cd "D:\My Files\AI_global_skills\app-next"
pnpm tauri dev
```

That command starts the Vite web UI and then opens the Tauri desktop window.

If the previous desktop window did not close cleanly, use the safer helper:

```powershell
cd "D:\My Files\AI_global_skills\app-next"
pnpm dev:desktop
```

`pnpm dev:desktop` first stops any stale `ai-skillhub-next.exe` development process, then starts Tauri dev mode.

After the first dev run, a debug executable may exist here:

```text
D:\My Files\AI_global_skills\app-next\src-tauri\target\debug\ai-skillhub-next.exe
```

That debug executable is not the final shareable installer. It may still expect the dev server/runtime context and should not be copied to other computers.

## Where the final v2 exe will be

When v2 is ready to package, use:

```powershell
cd "D:\My Files\AI_global_skills\app-next"
pnpm tauri build
```

The final Windows installer/executable will be generated under:

```text
D:\My Files\AI_global_skills\app-next\src-tauri\target\release\bundle\
```

Do not publish that v2 build yet unless the backup, restore dry-run, release preflight, and share validation steps have passed.

## Troubleshooting: failed to remove debug exe

If `pnpm tauri dev` fails with:

```text
failed to remove file ...\target\debug\ai-skillhub-next.exe
拒绝访问。 (os error 5)
```

Windows is still holding the previous debug executable. Usually this means the old AI SkillHub v2 desktop window is still open, or the process is closing slowly.

Fix:

```powershell
cd "D:\My Files\AI_global_skills\app-next"
pnpm stop:dev
pnpm tauri dev
```

Or use the combined command:

```powershell
pnpm dev:desktop
```

If `npm` reports cache permission errors, use a local cache temporarily:

```powershell
npm view pnpm version --cache ".\.npm-cache"
```

## Version notes

The npm registry reported these versions on 2026-05-24:

- `pnpm`: `11.2.2`
- `@tauri-apps/cli`: `2.11.2`
- `@tauri-apps/api`: `2.11.0`
- `vite`: `8.0.14`
- `@vitejs/plugin-react`: `6.0.2`
- `typescript`: `6.0.3`
- `react`: `19.2.6`

These are pinned in `package.json` so v2 development is reproducible.

## Verification on 2026-05-25

- `npm run check:toolchain`: passed.
- `pnpm install`: passed.
- `pnpm build`: passed.
- `pnpm tauri info`: passed after refreshing the current process PATH.
- `cargo check` in `src-tauri`: passed.

Note: a terminal, editor, or Codex session opened before Rust was installed may not see `rustc` and `cargo` until restarted. The self-check script also checks the standard Rust path under `%USERPROFILE%\.cargo\bin` to reduce false alarms.
