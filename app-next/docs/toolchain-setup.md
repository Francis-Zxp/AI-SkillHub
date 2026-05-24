# v2 toolchain setup

Checked on: 2026-05-24

This file records the tools needed to run the AI SkillHub v2 `app-next` Tauri project.

## What to install

| Tool | Version to use | Status on this computer | Download / official page |
|---|---:|---|---|
| Node.js | Already installed: `v24.16.0` | OK | https://nodejs.org/en/download |
| pnpm | `11.2.2` | Missing | https://pnpm.io/installation |
| Rust stable | `1.95.0` via rustup | Missing | https://www.rust-lang.org/tools/install |
| Visual Studio Build Tools 2026 | Installed: `18.4.1`; current stable channel: `18.6.1` | OK | https://visualstudio.microsoft.com/downloads/ |
| Microsoft Edge WebView2 Runtime | Evergreen runtime | Already installed for v1 | https://developer.microsoft.com/microsoft-edge/webview2/ |

This computer only needs pnpm and Rust/Cargo before the first real Tauri run.

## Recommended install order

1. Keep the current Node.js `v24.16.0`.
2. Skip Visual Studio Build Tools if `npm run check:toolchain` says it is detected.
3. Install Rust with rustup and accept the MSVC default toolchain.
4. Install pnpm.
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
pnpm tauri dev
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
