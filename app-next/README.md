# AI SkillHub Desktop App

`app-next` is the maintained desktop workspace for AI SkillHub.

It uses:

- Tauri 2 desktop shell
- React + TypeScript + Vite frontend
- Rust backend
- SQLite local state
- PowerShell helper scripts under `runtime/`

Older prototype app directories are no longer part of the product.

## Runtime Boundary

```text
%LOCALAPPDATA%\AI SkillHub\UserData\
  sources\                    # cloned and local sources
  skills\                     # active shared Skill view
  state\                      # SQLite and private runtime state
  reports\                    # generated reports
  skillhub.config.json        # local configuration
```

The release package is replaceable program code. v3.0.3 established the signed
official updater. v3.0.4 keeps that stable data boundary and adds a resumable,
copy-first migration that validates each recovered source, backs up SQLite
before selective metadata merge, and leaves the legacy copy untouched.

v3.0.4 also adds:

- offline metadata inference from bounded `README` / `SKILL.md` evidence;
- per-file staging security reports;
- Git source commit pinning, upstream diff summaries, and rollback from a
  verified backup after preserving the current source tree;
- an explainable four-evidence local quality score that keeps GitHub stars
  separate;
- a v4/SQLite-gated, allowlist-only legacy cleanup assistant that moves
  confirmed data to recoverable backup and excludes `release`;
- explainable Adapter Doctor cards;
- the Spectral Gravity canvas visualization with adaptive LOD and static
  fallbacks.

Generated suggestions never replace manual metadata overrides, and imported
source scripts are not executed during recognition.

## Development Commands

```powershell
cd app-next
pnpm install
pnpm build
cargo test --manifest-path src-tauri/Cargo.toml
pnpm tauri build --no-bundle
```

Development desktop window:

```powershell
pnpm tauri dev
```

If a stale development process locks the debug executable:

```powershell
pnpm dev:desktop
```

## Current Launcher

The local root launcher is:

```text
AI SkillHub.exe
```

The shareable release package should be produced through the release package
workflow instead of copying the development folder directly.

## Router Hubs

Parent router Skills are generated under:

```text
%LOCALAPPDATA%\AI SkillHub\UserData\sources\AI-SkillHub-local-routers\
```

Generated routers use `[ROUTER-HUB]`; child entries use `[CHILD-SKILL]`.
Author-owned source repositories are not modified.

## Same-Name Child Skill Conflicts

AI SkillHub detects exact duplicate non-router child Skill names across sources.
It assigns a safe default automatically, preserves a source-qualified alias for
every candidate, and exposes an optional manual override in Routing
Observatory. The local SQLite table `skill_conflict_choices` stores manual
decisions, so GitHub updates do not modify or erase them.

See `SKILL_CONFLICT_SELECTOR.md` for the detailed rule.
