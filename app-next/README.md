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
app-next/
  runtime/                    # helper scripts and config template
  data/github_sources/        # local source repositories, private
  reports/                    # generated reports, private
  .skillhub-next/             # generated state, private
```

The shared active Skill view remains at the repository root:

```text
../skills/
```

That directory is private and ignored by Git.

## Development Commands

```powershell
cd "D:\My Files\AI_global_skills\app-next"
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
D:\My Files\AI_global_skills\AI SkillHub.exe
```

The shareable release package should be produced through the release package
workflow instead of copying the development folder directly.

## Router Hubs

Parent router Skills are generated under:

```text
app-next/data/github_sources/AI-SkillHub-local-routers/
```

Generated routers use `[ROUTER-HUB]`; child entries use `[CHILD-SKILL]`.
Author-owned source repositories are not modified.

## Same-Name Child Skill Conflicts

AI SkillHub detects duplicate non-router child Skill names across sources and
shows them in the Sources page conflict selector. Users can set a default source, reset the
choice, or ignore the reminder. The local SQLite table
`skill_conflict_choices` stores the decision, so GitHub updates do not modify
or erase it.

See `SKILL_CONFLICT_SELECTOR.md` for the detailed rule.
