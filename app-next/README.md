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

v3.0.5 keeps the same stable data boundary and adds non-blocking source imports
with visible progress, bounded Impeccable-compatible fallback downloads,
source-scoped parent routing, two-axis atlas rotation, classic v3.0.2 theme
options, and default-window alignment fixes.

v3.0.6 adds bounded official-update retries, restores editing as a right-side
glass drawer, optically centers the collapsed logo, and starts the live atlas
from a privacy-bounded cache before transitioning to the current SQLite index.
The atlas returns to one volumetric center; decorative points are quieter and
meteors vary per app session without changing unpredictably during a session.

v3.0.7 keeps the drawer inside the active theme host and gives every theme an
explicit readable surface. The atlas core is mathematically concentric, space
motion uses 5–20 bounded session-stable meteors, and startup distinguishes a
local-index read from a real Git/tool synchronization. An allowlisted official
GitHub shortcut and reversible immersive atlas mode complete the homepage
workflow.

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

Every non-empty source receives one canonical `[ROUTER-HUB]` parent, including
single-Skill repositories. Child entries use `[CHILD-SKILL]` and include exact
source-scoped paths. Author-owned source repositories are not modified.

## Parent-Scoped Child Isolation

Same-name children in different sources are isolated by their parent. AI
SkillHub does not ask the user to choose a global default and does not publish a
global child dispatcher. Codex, Claude and Antigravity receive the same curated
parent-first catalog; each parent automatically selects only children declared
inside its own source.

See `SKILL_CONFLICT_SELECTOR.md` for the detailed rule.
