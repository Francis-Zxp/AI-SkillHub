# AI SkillHub V2 Roadmap Status

Updated: 2026-05-27

## Current Estimate

V2 overall completion is conservatively estimated at **about 70%**.

This does **not** mean a usable V2 application is 70% coded. It means v1 is now stable enough to become the maintenance line, the first v2 `app-next` scaffold exists, the toolchain is ready, checks pass, the read-only scanner reads real v1 data, the scan persists into v2 SQLite, the UI can open from SQLite before scanning v1, the first Agent Adapter Registry exists, v2 has SQLite-only enable/disable state plus adapter safety checks, the first project workspace scan exists, direct browser preview no longer crashes when Tauri APIs are unavailable, the first visual-density pass has landed, project workspace detail now tracks instruction-file status with a read-only generated instructions preview, the Workspaces page now has selectable workspace detail navigation, the first Release Gate page now combines diagnostics, backup dry-run, restore dry-run, rollback lock, desktop QA, release preflight, share validation, and zip preview status, the first snapshot/rollback gate, backup target inventory, backup dry-run plan, and restore dry-run report are visible in the app, and the Settings page now explains the difference between the development exe and a future packaged release build plus the first desktop-window QA checklist.

## Why 70%

| Area | Status | Estimate |
|---|---:|---:|
| Reference project analysis | skills-manager, asm, OpenSkills, SkillKit analyzed and still active as references | 70% |
| Product model | central library, sources, agents, adapter registry, diagnostics, workspaces, workspace detail navigation, presets, safety checks, project scans, snapshot/rollback gates, backup target inventory, backup dry-run plan, restore dry-run report, release gate, release/build explanation, desktop-window QA checklist, and v1 report inputs are defined through v1 behavior and v2 seed data | 78% |
| V1 behavior specs for V2 | sharing, diagnostics, import preview, release preflight, troubleshooting, Skill health, problem locator, and zip preview are repeatable specs and now feed the v2 Release Gate as read-only report inputs | 68% |
| V2 technical environment | Node LTS, pnpm, Rust/Cargo, rustup, WebView2, and Visual Studio Build Tools are ready | 85% |
| Tauri/React/Rust/SQLite code | `app-next` scaffold created; frontend build, Rust tests, read-only v1 scanner, SQLite indexing, SQLite-first loading, adapter registry, SQLite-only state toggles, selectable workspace detail UI, project scan detail, snapshot UI, backup target inventory UI, backup dry-run UI, restore dry-run UI, release gate UI, v1 report input cards, browser preview fallback, first UI density pass, release/build guide UI, desktop-window QA checklist UI, and first real Tauri desktop-window QA pass | 75% |
| SQLite data model | real v1 sources, skills, agents, agent adapters, adapter capabilities, safety checks, workspaces, project scans with instruction-file metadata, presets, snapshots, backup targets, backup dry-run items, restore dry-run items, rollback plan steps, and audit events are persisted | 73% |
| Workspaces and presets | first global/agent/project workspaces and category presets are seeded; workspace cards can open a read-only detail panel; project workspaces show AGENTS/CLAUDE/README status and read-only instructions preview | 54% |
| Release readiness | first release gate page exists; it summarizes diagnostics, backup dry-run, restore dry-run, rollback lock, desktop QA, release preflight, share validation, and zip preview, but does not execute packaging | 56% |
| Multi-agent adapter registry | first registry implemented with 12 supported tools, detected/managed status overlay, capability metadata, enable state, and safety checks | 52% |
| CLI and automation | planned, not implemented | 0% |
| Marketplace/recommended index | planned, not implemented | 0% |

Weighted together, the honest number is about **70%**.

## Reference Projects Still In Use

| Reference | What AI SkillHub keeps learning |
|---|---|
| `skills-manager` / `xingkongliang-skills-manager` | Central library, global/agent/project workspace model, presets, tags, Git backup, activity log, settings |
| `luongnv89-asm` | Provider/scope model, doctor checks, duplicate detection, security audit, CLI discipline |
| `numman-aliopenskills` | AGENTS.md bridge, project/global install idea, read-on-demand workflow, GitHub source parsing |
| `rohitg00-skillkit` | Multi-agent adapter registry, format translation, API/MCP direction, safety and test matrix |
| `PromptHive` style tools | Prompt should stay separate from Skill, with its own search and reusable variables later |
| MCP manager projects | Future MCP profiles, registries, and client integrations |

## What V1 Is Doing For V2

V1 is no longer just a throwaway prototype. It is becoming the behavior laboratory for V2:

- If v1 share validation passes, V2 must preserve that expectation.
- If v1 diagnostics explain missing Codex as info, V2 must preserve that beginner-friendly behavior.
- If v1 release preflight prevents personal skills from entering a zip, V2 must make that a first-class release gate.
- If v1 import preview only installs folders with `SKILL.md`, V2 must keep the same safety rule.

## V2 Start Criteria

The v2 source line has started and the toolchain is ready:

1. pnpm is installed and stable.
2. Rust/Cargo and rustup are installed.
3. Visual Studio Build Tools / MSVC requirements stay detected by `npm run check:toolchain`.
4. `pnpm install`, `pnpm build`, `pnpm tauri info`, Rust `cargo check`, and Rust tests pass.
5. The first read-only scanner can read existing AI SkillHub data, show it in the React/Tauri shell, and persist it into v2 SQLite.
6. The v2 UI can load from SQLite first and manually refresh the v1 scan when needed.
7. The first Agent Adapter Registry can distinguish supported tools from detected local tools.
8. Enable/disable state for adapters, workspaces, and presets is stored in v2 SQLite only and does not touch v1 links.
9. Adapter capability metadata and the first read-only project workspace scan are persisted in v2 SQLite.

## Next Practical Step

Continue v2 milestone 1:

1. Convert the desktop QA checklist from static guidance into persisted pass/fail records.
2. Continue visual QA inside the real Tauri window, especially Release Gate, Workspaces, Snapshot, and Settings.
3. Start system-level UI design after the Release Gate, workspace model, and desktop QA records are stable enough to avoid redesigning around moving requirements.
4. Later, move workspace detail navigation from in-page selection to route-level detail pages if the product model needs deep links.
5. Keep v1 as the maintenance app until v2 can cover its core workflows.
