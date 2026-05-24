# AI SkillHub V2 Roadmap Status

Updated: 2026-05-25

## Current Estimate

V2 overall completion is conservatively estimated at **about 24%**.

This does **not** mean a usable V2 application is 24% coded. It means v1 is now stable enough to become the maintenance line, the first v2 `app-next` scaffold exists, the toolchain is ready, dependencies are installed, and both the frontend build and Rust `cargo check` pass.

## Why 24%

| Area | Status | Estimate |
|---|---:|---:|
| Reference project analysis | skills-manager, asm, OpenSkills, SkillKit analyzed and still active as references | 70% |
| Product model | central library, sources, agents, diagnostics, release center are defined through v1 behavior | 35% |
| V1 behavior specs for V2 | sharing, diagnostics, import preview, release preflight, troubleshooting, Skill health, and problem locator are repeatable specs | 60% |
| V2 technical environment | Node LTS, pnpm, Rust/Cargo, rustup, WebView2, and Visual Studio Build Tools are ready | 85% |
| Tauri/React/Rust/SQLite code | `app-next` scaffold created; frontend build, Tauri info, and Rust `cargo check` pass | 18% |
| SQLite data model | initial migration created for sources, skills, agents, workspaces, tags, audit events, and snapshots | 15% |
| Workspaces and presets | planned, v1 only has partial categories/tags/presets | 10% |
| Multi-agent adapter registry | planned, v1 has partial Claude/Codex/Antigravity detection | 15% |
| CLI and automation | planned, not implemented | 0% |
| Marketplace/recommended index | planned, not implemented | 0% |

Weighted together, the honest number is about **24%**.

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
4. `pnpm install`, `pnpm build`, `pnpm tauri info`, and Rust `cargo check` pass.
5. The first V2 goal remains read-only: scan existing AI SkillHub data into SQLite and show it in a React/Tauri shell.

## Next Practical Step

Continue v2 milestone 1:

1. Replace sample data with a read-only scanner for `../skills`, `../app/github_sources`, and `../app/reports/latest-diagnostics.json`.
2. Persist the scanned result into SQLite without changing any v1 data.
3. Run the first Tauri dev window only after the scanner returns believable data.
4. Keep v1 as the maintenance app until v2 can cover its core workflows.
