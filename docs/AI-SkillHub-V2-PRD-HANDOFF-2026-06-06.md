# AI SkillHub V2 PRD and Handoff

Date: 2026-06-06

## 1. Product Positioning

AI SkillHub V2 is a Windows desktop management hub for AI agent capabilities.
It manages GitHub Skill repositories, local Skill folders, Prompt materials,
parent/child Skill routing, and AI-tool linking for Claude Code, Codex, and
Antigravity.

The product has migrated to V2-only. Do not restore the old V1 `app` directory.

## 2. Core Goal

The core experience must remain simple:

```text
paste source -> choose type/category/tags -> one-click add and refresh -> sync to AI tools if authorized
```

Advanced safety features must not block this main path unless there is a real
write or data-loss risk.

## 3. Architecture

```text
AI_global_skills/
  app-next/                         # Tauri / React / Rust / SQLite app
    runtime/                        # V2 PowerShell helper scripts
    data/github_sources/            # private local source repositories
    reports/                        # private reports
    .skillhub-next/                 # private generated state
  skills/                           # private active shared Skills view
```

Removed V1 paths:

```text
app/
AI SkillHub.exe
release/
```

## 4. Public Repository Boundary

Commit only source code, runtime templates, docs, and assets.

Never commit:

```text
skills/
app-next/data/
app-next/reports/
app-next/.skillhub-next/
app-next/runtime/skillhub.config.json
app-next/node_modules/
app-next/src-tauri/target/
AI SkillHub V2 Alpha.exe
```

## 5. Current Functional Scope

V2 currently covers:

- GitHub source indexing and refresh.
- Local source and zip/.skill preview.
- Real Skill detection through `SKILL.md`.
- Special install layout handling, including repos where installable Skills live
  under nested payload folders such as `dist/.../skills`.
- Parent router generation for multi-Skill repositories.
- `[ROUTER-HUB]` and `[CHILD-SKILL]` routing markers.
- Claude Code, Codex, and Antigravity link synchronization through authorized
  helper flow.
- Diagnostics and preflight report generation.
- Source list sorting, categories, tags, notes, GitHub heat, and usage metadata.

## 6. Router Rules

Parent router Skills are generated under:

```text
app-next/data/github_sources/AI-SkillHub-local-routers/
```

Rules:

1. Do not edit author-owned `SKILL.md` files.
2. Parent routers use `[ROUTER-HUB]`.
3. Child entries use `[CHILD-SKILL]`.
4. Manual sync, daily update, and new source add must regenerate routers.
5. GitHub updates must not erase router metadata because router files are local
   AI SkillHub artifacts outside the author repository.

## 7. UI Direction

The current UI direction is dark-first with a light theme option.

Important product decisions:

- Sources is the primary workflow page.
- Skill Library is for browsing, searching, editing metadata, and resolving
  duplicate Skill names.
- Right-side detail/editor should behave like a third panel when a source or
  Skill is selected.
- Buttons must be grid-aligned and use consistent heights.
- Progress must be visible during add/refresh/sync operations.
- The app must remain usable while background work runs.

## 8. Remaining Product Work

Important remaining work:

1. Same-name Skill conflict selector.
2. More complete third-panel editing pattern.
3. Page-by-page UI polish using the established grid and component tokens.
4. Fresh install packaging so a new user can download V2, start it, create the
   folder layout, add a GitHub source, and sync to their installed AI tools.
5. Formal GitHub release package and release notes for V2.

## 9. Validation Baseline

After the V2-only migration:

```text
pnpm build: passed
cargo test: 39 passed
pnpm tauri build --no-bundle: passed
runtime SkillHub.ps1 -NoPull -ReportOnly: passed
```

Current local validation data:

```text
app-next/data/github_sources: 26 source repositories
skills: 363 active Skill folders
```

## 10. Non-Negotiable Rules For Future Work

- Do not recreate the old `app` directory.
- Do not depend on `app/SkillHub.ps1`.
- Do not delete `skills/`; it is the active shared Skill view, not V1.
- Do not commit personal cloned sources or private Skills.
- Do not silently choose between duplicate same-name Skills; surface a conflict
  selector.
- Keep the Sources workflow simple enough for non-technical users.
