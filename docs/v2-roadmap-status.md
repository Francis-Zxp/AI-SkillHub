# AI SkillHub V2 Roadmap Status

Updated: 2026-05-24

## Current Estimate

V2 overall completion is conservatively estimated at **about 12%**.

This does **not** mean a usable V2 application is 12% coded. It means the product direction, reference analysis, and v1 behavior specs have reached roughly 12% of the total journey toward a stable V2.

## Why 12%

| Area | Status | Estimate |
|---|---:|---:|
| Reference project analysis | skills-manager, asm, OpenSkills, SkillKit analyzed and still active as references | 70% |
| Product model | central library, sources, agents, diagnostics, release center are defined through v1 behavior | 35% |
| V1 behavior specs for V2 | sharing, diagnostics, import preview, release preflight, troubleshooting are becoming repeatable specs | 45% |
| V2 technical environment | Node LTS is ready; pnpm, Rust/Cargo, MSVC Build Tools still need setup before real Tauri work | 20% |
| Tauri/React/Rust/SQLite code | app-next has not started | 0% |
| SQLite data model | planned, not implemented | 0% |
| Workspaces and presets | planned, v1 only has partial categories/tags/presets | 10% |
| Multi-agent adapter registry | planned, v1 has partial Claude/Codex/Antigravity detection | 15% |
| CLI and automation | planned, not implemented | 0% |
| Marketplace/recommended index | planned, not implemented | 0% |

Weighted together, the honest number is about **12%**.

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

Start real `app-next` development only when these are true:

1. pnpm is installed and stable.
2. Rust/Cargo is installed.
3. Visual Studio Build Tools / MSVC requirements are satisfied.
4. v1 has stable behavior for source import, sync, agent linking, diagnostics, troubleshooting, and release packaging.
5. The first V2 goal is read-only: scan existing AI SkillHub data into SQLite and show it in a React/Tauri shell.

## Next Practical Step

Continue v1.2 user-flow productization before the big rewrite:

- Add-source guidance.
- Import result confirmation.
- Agent takeover repair suggestions.
- Report problem locator.
- Skill health check cards.

These will become V2 requirements instead of being lost during the rewrite.
