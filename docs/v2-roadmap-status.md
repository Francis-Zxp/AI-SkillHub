# AI SkillHub V2 Roadmap Status

Updated: 2026-06-01

## Current Estimate

V2 is now treated as the **daily-use replacement for the V1 UI**.

The important boundary is architectural: V2 does not discard the proven V1 sync engine. Instead, V2 owns the product UI, metadata, staging, search, QA, and SQLite state, then calls `app/SkillHub.ps1` as the canonical sync/relink executor when real-write authorization is enabled. This means the user no longer needs to operate the V1 UI for normal daily use, while the reliable GitHub update, Skill route rebuild, and Claude/Codex/Antigravity link sync logic remains reused underneath.

## Why V2 Is Replacement-ready

| Area | Status | Estimate |
|---|---:|---:|
| Reference project analysis | skills-manager, asm, OpenSkills, SkillKit analyzed and still active as references | 70% |
| Product model | central library, sources, agents, adapter registry, diagnostics, workspaces, workspace detail navigation, presets, tags, Preset/workspace distribution, safety checks, project scans, snapshot/rollback gates, backup target inventory, backup dry-run plan, restore dry-run report, release gate, Release Readiness summary, release/build explanation, persisted desktop QA, source metadata editing, usage insights, activity timeline, report-only operation runners, latest report exports, report-folder open/copy UX, and v1 report inputs are defined through v1 behavior and v2 seed data | 95% |
| V1 behavior specs for V2 | sharing, diagnostics, import preview, release preflight, troubleshooting, Skill health, problem locator, and zip preview are repeatable specs; zip preview feeds the v2 Release Gate and Sources import preview as read-only report inputs | 73% |
| V2 technical environment | Node LTS, pnpm, Rust/Cargo, rustup, WebView2, and Visual Studio Build Tools are ready | 85% |
| Tauri/React/Rust/SQLite code | `app-next` scaffold created; frontend build, Rust tests, read-only v1 scanner, SQLite indexing, SQLite-first loading, adapter registry, SQLite-only state toggles, selectable workspace detail UI, project scan detail, snapshot UI, backup target inventory UI, backup dry-run UI, restore dry-run UI, release gate UI, Release Readiness card, v1 report input cards, browser preview fallback, system-level UI pass, release/build guide UI, persisted desktop QA UI, source metadata editor, skill/source multi-tag editing, Preset/workspace distribution matrix, operation runner reports with latest JSON/Markdown/manifest exports, restricted report-folder open/copy actions, usage insights, activity timeline, Sources import preview panel, Sources dry-run import wizard, rollback-aware source import plans, bulk source metadata editing, GitHub popularity refresh, and first real Tauri desktop-window QA pass | 95% |
| SQLite data model | real v1 sources, skills, agents, agent adapters, adapter capabilities, safety checks, workspaces, project scans with instruction-file metadata, presets, tags, skill/source tag overrides, preset/workspace policies, snapshots, backup targets, backup dry-run items, restore dry-run items, rollback plan steps, desktop QA checks, operation runs, audit events, Skill metadata overrides, Source metadata overrides, bulk Source metadata audit events, Usage Events, Source Popularity Cache, and rollback-aware dry-run import-plan data contracts are persisted or generated from SQLite inputs | 94% |
| Workspaces and presets | first global/agent/project workspaces and category presets are seeded; workspace cards can open a read-only detail panel; project workspaces show AGENTS/CLAUDE/README status and read-only instructions preview; Preset/workspace distribution policies are persisted in SQLite and visible in the UI, but still do not write to real AI tool directories | 78% |
| Release readiness | release gate summarizes diagnostics, backup dry-run, restore dry-run, rollback lock, persisted desktop QA, release preflight, share validation, and zip preview into one plain-language publish / do-not-publish recommendation; diagnostics/share/release runners now generate report-only records plus latest JSON/Markdown/manifest exports; the UI can open/copy generated report paths through a restricted report-folder opener; release packaging still does not execute real packaging | 90% |
| Multi-agent adapter registry | first registry implemented with 12 supported tools, detected/managed status overlay, capability metadata, enable state, and safety checks | 52% |
| CLI and automation | planned, not implemented | 0% |
| Marketplace/recommended index | planned, not implemented | 0% |

Weighted together, the honest status is: **V2 can replace V1 for daily operation, while the proven V1 script remains the backend sync engine**.

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

Continue v2 hardening:

1. Use the V2 root exe as the normal daily launcher.
2. Keep `app/SkillHub.ps1` because V2 now uses it as the backend sync/relink engine.
3. Improve beginner guidance and error wording around source add -> sync -> AI tool availability.
4. Add optional real AI-tool invocation ingestion from logs/hooks after a privacy review. Local Usage Events and GitHub popularity cache are already persisted, but Claude/Codex real invocation counts are not yet claimed.
5. Keep Release Gate for packaging/share/export safety, not as a blocker for normal source sync after explicit real-write authorization.

## Product Re-centering Note

V2 must not turn safety architecture into the default user experience. The default Sources flow should remain V1-simple:

1. Paste a GitHub URL, local folder, zip, or `.skill` package.
2. Let AI SkillHub auto-detect whether it contains installable Skills, Prompt material, or other source material.
3. Let the user optionally set category, note, tags, and enabled state.
4. Use one primary action to add the source to the managed local source library.
5. Keep AI-tool sync/takeover as a separate explicit action with visible backup and rollback gates.

Advanced concepts such as dry-run, staging, promotion, write-gate status, operator consent, report manifests, and rollback plans should be visible as explainable detail, not as the beginner path. This keeps the product aligned with the original goal: a shared AI Skills hub that a non-technical user can operate quickly, while still preserving the stronger V2 safety model.

GitHub popularity and usage intelligence should also stay honest:

- GitHub stars, forks, open issues, and last update can be refreshed manually and cached.
- Historical trend lines are only authoritative from the first AI SkillHub refresh onward unless an external history source is added.
- Local frequency means AI SkillHub-recorded actions, not automatic Claude/Codex invocation counts, until the user explicitly enables a log/hook ingestion path.

## V2 Replacement Decision

V2 is now the replacement for the V1 UI in daily use.

The replacement rule is:

1. Use `AI SkillHub V2 Alpha.exe` as the normal launcher.
2. Add or edit sources in V2.
3. Turn on real-write authorization when you want V2 to update AI tool links.
4. Click `同步 / 刷新` or `同步并刷新`; V2 runs `app/SkillHub.ps1`, updates GitHub sources, rebuilds Skill routes, syncs Claude/Codex/Antigravity links, and refreshes the v2 SQLite index.
5. Keep the V1 script file as an internal backend dependency; do not delete it unless V2 later gets a fully native Rust sync executor.

This keeps the original product goal intact: the beginner path is back to paste URL -> classify -> add source -> sync, while advanced staging/report details remain available for debugging.

## 2026-06-01 Product Simplification Pass

V2 was re-centered around the daily workflow again after user feedback showed the interface had become too safety-model-first.

- Main navigation now keeps only daily-use areas: Dashboard, Sources, Skill Library, Workspaces, Presets, and Agents.
- Snapshots and Release Gate are retained as advanced safety tools, but removed from the primary navigation.
- Global search now searches Sources and Skill Library together, with slash-style Skill lookup such as `/nature` and `/research-writing-skill` prioritized above source matches.
- Skill Library search temporarily ignores category and health filters so quick lookup cannot be hidden by stale filters.
- Sources Quick Add layout was compressed into a normal form flow: source type, address, one-click add, metadata, authorization, and collapsible advanced details.
- Generated parent router Skills are now written as UTF-8 without BOM so strict `SKILL.md` frontmatter parsers see `---` as the first bytes.

Validation after the pass: `pnpm build`, Rust `cargo test`, `pnpm tauri build --no-bundle`, and root exe hash verification passed. `SkillHub.ps1 -NoPull -ReportOnly` confirmed both `nature-skills` and `research-writing-skill` are active managed skills.

## 2026-06-02 nature-skills Child Skill Repair

`nature-skills` contains duplicate child Skill folders under both `skills/...` and `plugins/nature-skills/skills/...`. The generic scanner correctly treated child Skills such as `nature-figure` as conflicts and skipped them, leaving stale Codex junctions that pointed to missing shared targets.

The fix is to keep `nature-skills` in explicit mode and select the canonical repo-root paths:

- `skills/nature-academic-search`
- `skills/nature-citation`
- `skills/nature-data`
- `skills/nature-figure`
- `skills/nature-paper2ppt`
- `skills/nature-polishing`
- `skills/nature-reader`
- `skills/nature-response`
- `skills/nature-reviewer`
- `skills/nature-writing`

After running `app/SkillHub.ps1 -NoPull`, `nature-figure` and the other child Skills were recreated in `D:\My Files\AI_global_skills\skills` and relinked into `C:\Users\Francis\.codex\skills`. This rule must be preserved during future config edits so daily auto-update and manual sync do not reintroduce duplicate-source conflicts.

The sync script also now has a generic tie-breaker: when two same-named Skills have the same preferred-path priority, it prefers the repository-root `skills/...` path over deeper nested copies such as `plugins/<repo>/skills/...`. This protects future daily updates and manual syncs from similar duplicate-folder layouts.

## Plan Alignment Check

The Release Readiness card is not a direction change. It directly follows the previous plan: diagnostics, release preflight, sharing validation, zip preview, desktop QA, backup dry-run, restore dry-run, and rollback lock must be visible before any future packaging work. The card is deliberately read-only and only turns those existing gates into a clear user-facing conclusion.

## 2026-05-27 Dark Linear Dashboard Pass

The system-level UI pass has started with the main Dashboard and app shell. The new direction follows the Stitch `stitch_liquid_glass_design_system` Dark Linear tokens: fixed left sidebar, command-search topbar, deep purple/black surfaces, 1px hairline borders, glass blur, glow accents, dashboard metric cards, Release Readiness panel, and Active Alerts panel.

Important implementation note: the first visual QA exposed a real token bug. The final CSS used `--sidebar-width`, `--topbar-height`, and related design variables before they were defined, causing browser preview to collapse the grid into a single column. The tokens are now explicitly defined in the final cascade, so the main page keeps the intended two-column desktop layout.

Validation after the pass: `pnpm build`, Rust `cargo test`, `git diff --check`, and `pnpm tauri build --no-bundle` passed. The latest root double-click executable was refreshed at `D:\My Files\AI_global_skills\AI SkillHub V2 Alpha.exe`.

## 2026-05-28 Source Metadata And Usage Events

V2 now has a first persistent management layer beyond read-only indexing:

- `source_overrides` stores editable source display name, type, category, note, and enabled state.
- `usage_events` stores local usage records for Skill prompt copying and source detail opening.
- Dashboard Usage Insights reads real local usage events for all-time, 7-day, and 30-day views, with index-derived fallback only when no events exist.
- Dashboard Activity Timeline reads SQLite audit events instead of being only a static placeholder.
- The root double-click executable was refreshed after `pnpm build`, `cargo test`, `git diff --check`, and `pnpm tauri build --no-bundle` passed.

This does not yet include GitHub stars/forks/last update cache or real Claude/Codex invocation log ingestion.

## 2026-05-29 Sources Import Preview Gate

V2 now has a read-only Import Preview panel on the Sources page:

- GitHub repositories, local folders, and zip/.skill packages are displayed as separate intake lanes.
- GitHub/local lanes summarize indexed source counts, Skill counts, Prompt counts, and explain that clone/pull/install is not executed yet.
- The zip/.skill lane reads the existing v1 zip preview report and blocks real import unless the safety report passes.
- The backend exposes this as `LegacySnapshot.importPreviews`; the browser preview shell also has matching sample data.
- A Rust test verifies the safety rule: Prompt sources are counted separately and zip import remains read-only gated.

This is not the final installer. It is the safe preview layer that must exist before real GitHub clone/pull, local import, zip extraction, duplicate handling, and rollback-aware install can be unlocked.

## 2026-05-29 Popularity Signals And Usage Intelligence

V2 now has the first "high-signal" usage intelligence layer:

- `source_popularity_cache` stores GitHub stars, forks, open issues, last update time, cache status, and fetch errors in SQLite.
- GitHub popularity is refreshed manually from the Dashboard. It is deliberately not queried on every launch, avoiding slow startup, rate limits, and noisy offline failures.
- `Usage Insights` supports all-time, 7-day, and 30-day views, and can switch between heatmap and bar-chart display.
- Local usage frequency is backed by v2 `usage_events`; source detail opens and skill actions can feed common-skill/common-source ranking.
- Sources now show compact GitHub star cache and local source-open counts directly in the source list.
- A Rust test verifies that GitHub cache and local usage are combined correctly.
- The root double-click executable was refreshed again: `D:\My Files\AI_global_skills\AI SkillHub V2 Alpha.exe`.

Verification after the pass: `pnpm build`, Rust `cargo test` with 18 tests, `git diff --check`, and `pnpm tauri build --no-bundle` passed.

Remaining V1-to-V2 gaps are still explicit: real GitHub clone/pull import, real local/zip/.skill import, real AI-tool sync/write, diagnostics bundle export, share-validation runner, packaging runner, real Claude/Codex invocation ingestion, full multi-tag model, and workspace/Preset distribution matrix.

## 2026-05-29 Sources Dry-run Import Wizard

Sources now has the first interactive import wizard on top of the earlier read-only import preview:

- Backend command `preview_source_import_candidate` generates a dry-run plan for GitHub, local folder, and zip/.skill candidates.
- GitHub plans normalize ordinary GitHub repository URLs, detect duplicate indexed repositories, and explain the future clone/pull sequence without executing it.
- Local folder plans scan for `SKILL.md`, count Prompt-like Markdown material, skip heavy build/cache folders, and block duplicate path/name candidates.
- zip/.skill plans remain locked until a future extractor adds zip-slip and temporary-directory safety checks.
- The UI shows risk level, duplicate reason, planned steps, Skill/Prompt counts, and rollback requirements before any future write path can be enabled.
- The root double-click executable was refreshed at `D:\My Files\AI_global_skills\AI SkillHub V2 Alpha.exe`.

Verification after the pass: `pnpm build`, Rust `cargo test` with 21 tests, `git diff --check`, and `pnpm tauri build --no-bundle` passed.

Remaining V1-to-V2 gaps are still explicit: real GitHub clone/pull import, real local/zip/.skill import, real AI-tool sync/write, diagnostics bundle export, share-validation runner, packaging runner, real Claude/Codex invocation ingestion, full multi-tag model, and workspace/Preset distribution matrix.

## 2026-05-29 Rollback-aware Import Plans And Bulk Source Editing

Sources dry-run import now produces an explicit rollback-aware install plan:

- GitHub, local folder, and zip/.skill candidates show target root, planned target path, backup path, write-gate status, blocking checks, and future rollback-aware install steps.
- GitHub and local plans can reach `dry-run-ready`; zip/.skill remains `locked` until zip-slip, temporary extraction, and duplicate-skill safety checks are implemented.
- The UI now shows the write gate and blocking conditions before any future installer can be enabled.
- Sources now has multi-select bulk editing for category and enabled state.
- Bulk source edits write only to v2 SQLite metadata overrides and record `source_bulk_metadata_updated` audit events.
- Real clone/pull/copy/extract/link/sync writes remain locked.

Verification after the pass: `pnpm build` and Rust `cargo test` with 22 tests passed. Final packaging verification should still run before a release candidate.

## 2026-05-29 Multi-tags, Preset Distribution, And Report-only Runners

V2 now has the next management layer that was explicitly planned before any real sync/write unlock:

- SQLite now persists `source_tags`, `skill_tag_overrides`, `source_tag_overrides`, `preset_workspaces`, and `operation_runs`.
- Skill Library can save real multi-tags for individual Skills; Sources can save real multi-tags for individual sources.
- Presets now show workspace distribution state. Toggling a Preset/workspace policy writes only to v2 SQLite and does not copy, link, delete, or modify any real Claude/Codex/Antigravity directory.
- Release Gate now has report-only runners for diagnostics export, share validation, and release-package planning.
- Diagnostics and share runners can write v2 reports under `.skillhub-next/reports`; the release package runner deliberately remains locked and only writes a plan.
- New Rust tests verify multi-tag persistence, Preset/workspace distribution persistence, and that release runners produce reports without unlocking real package generation.
- The root double-click executable was refreshed at `D:\My Files\AI_global_skills\AI SkillHub V2 Alpha.exe`.

Verification after the pass: `pnpm build`, Rust `cargo test` with 24 tests, and `pnpm tauri build --no-bundle` passed. Real GitHub clone/pull, real local/zip import, real AI tool sync/write, and real release packaging remain locked until all safety gates pass.

## 2026-05-29 Runner Export UX

Release Gate runners now produce a more complete local export set instead of a single isolated report:

- Each runner writes a timestamped JSON report and Markdown report.
- Each runner also refreshes `latest-<runner>.json`, `latest-<runner>.md`, and `latest-<runner>-manifest.json`.
- The manifest records generated files, status, runner type, and the read-only gate boundary.
- Markdown reports use relative file names and do not embed the user's local AI SkillHub root path.
- The Release Gate UI now shows export directory, latest report path, manifest path, file count, and allows the locked release-package runner to generate a locked plan without making a package.

Verification after the pass: `pnpm build` and Rust `cargo test` with 24 tests passed. Real GitHub clone/pull, real local/zip/.skill import, real Claude/Codex/Antigravity sync, and real release package generation are still locked.

## 2026-05-30 Runner Open / Copy UX

Release Gate report exports are now easier to use after a dry-run:

- Each runner card has actions to open the export directory, open the latest report, and copy the latest report path.
- The desktop opener is restricted to `.skillhub-next/reports`; it refuses arbitrary paths outside AI SkillHub v2 report exports.
- Browser preview keeps the action non-destructive by copying the path instead of attempting to open local files.
- Rust tests now verify that generated report paths are allowed and paths outside the report folder are rejected.

Verification after the pass should remain: `pnpm build`, Rust `cargo test`, `pnpm tauri build --no-bundle`, and root exe refresh. Real GitHub clone/pull, real local/zip/.skill import, real Claude/Codex/Antigravity sync, and real release package generation are still locked.

## 2026-05-30 SQLite Refresh Stability

The report-opening pass exposed a real SQLite refresh bug in tests, and it has been fixed before moving on:

- Refreshing the v2 index now preserves Skill tag overrides, Source tag overrides, and Preset/workspace distribution policies.
- The refresh transaction clears dependent tables before deleting parent Sources, Skills, Workspaces, or Presets, avoiding foreign-key failures.
- Saved overrides are restored only when the corresponding parent Skill, Source, Preset, Workspace, and Tag still exists after the new scan.
- This keeps manual labels/distribution choices durable across v1 rescan/import refreshes without unlocking any real clone/pull/copy/extract/link/package writes.

Verification after the fix: Rust `cargo test` with 24 tests passed and `pnpm build` passed.

## 2026-05-30 Final Report Bundle Index

Release Gate now has one more report-only executor:

- `report-bundle` summarizes the latest diagnostics, share-validation, and release-package-plan exports.
- It writes a timestamped JSON report, timestamped Markdown report, latest JSON, latest Markdown, timestamped manifest, and latest manifest under `.skillhub-next/reports/report-bundle`.
- The bundle includes only relative report file names and runner status; it does not embed the user's local AI SkillHub root path.
- It is not a release package and does not copy, zip, publish, sync, link, clone, pull, or extract anything.
- Browser preview shows the same card as a simulated runner; desktop mode writes the real v2 SQLite audit event and report files.

Verification after the pass: `pnpm build` passed and Rust `cargo test` with 24 tests passed.

## 2026-05-30 Real Write Unlock Matrix

V2 now exposes the missing bridge between read-only dry-run work and future real write execution:

- Release Gate has a real-write unlock matrix for GitHub clone/pull import, local/zip import, AI tool sync/link takeover, and release package generation.
- Each matrix card lists passed checks, blocking checks, risk level, operation type, execution preview steps, rollback preview steps, and the next required action.
- The backend derives the matrix from diagnostics, v1 report inputs, import previews, backup dry-run, restore dry-run, rollback plan, persisted desktop QA, agent adapter state, and report-bundle runner outputs.
- Every real-write gate still returns `unlocked=false`; no clone, pull, copy, extract, link, sync, or package action has been enabled.
- A Rust test verifies that real-write gates are generated and remain locked without an explicit future executor.

Verification target after this pass remains: `pnpm build`, Rust `cargo test`, `git diff --check`, `pnpm tauri build --no-bundle`, then refresh `D:\My Files\AI_global_skills\AI SkillHub V2 Alpha.exe`.

## 2026-05-30 Write Execution Plan And V2 Completion Audit

Release Gate now has two additional report-only runners:

- `write-execution-plan` exports a real-write execution plan from the current unlock matrix.
- The plan includes each gate's operation type, risk level, passed checks, blocking checks, execution preview, rollback preview, and next action.
- `v2-completion-audit` exports a V2 completion audit across SQLite index, metadata management, diagnostics, desktop QA, report bundle, and real write gates.
- Both runners write timestamped JSON, timestamped Markdown, latest JSON, latest Markdown, and manifest files under `.skillhub-next/reports`.
- Both runners record SQLite audit events and remain report-only: no clone, pull, copy, extract, link, sync, package, publish, or tag action is executed.

Verification after this pass: `pnpm build` passed, Rust `cargo test` passed with 25 tests, and the root double-click executable was refreshed at `D:\My Files\AI_global_skills\AI SkillHub V2 Alpha.exe`.

Remaining V2 gap: real write executors are still intentionally locked. The next step is to implement guarded executors behind these gates, starting with GitHub clone/pull and local/zip import in isolated staging folders, then AI-tool sync, then release packaging.

## 2026-05-31 Source Import Staging Executors

V2 now has the first guarded source-import execution layer behind the dry-run plan:

- GitHub repository candidates can be cloned into `app-next/.skillhub-next/staging/source-imports`.
- Local folder candidates can be copied into the same isolated staging area with heavy/cache folders skipped.
- zip/.skill package candidates now run zip-slip, path traversal, symlink, file-count, and uncompressed-size checks before extraction.
- Safe zip/.skill packages can be extracted into isolated staging and scanned for `SKILL.md`.
- Every staging run writes JSON, Markdown, and manifest reports under `.skillhub-next/reports/source-import-staging`.
- Staging remains non-destructive: it does not install into `app/github_sources`, does not modify `skills`, and does not write to Claude/Codex/Antigravity folders.
- Rust tests now cover local staging, safe zip staging, and missing zip blocking.

Verification after the pass: `pnpm build` passed and Rust `cargo test` passed with 27 tests.

Remaining V2 gap: promotion from staging into managed sources is still locked, and AI-tool sync/link plus release packaging remain locked behind Release Gate.

## 2026-05-31 Source Import Promotion Gate

V2 now has the second guarded source-import execution layer:

- A staged GitHub/local/zip source can be promoted into `app/github_sources` as a managed source.
- Promotion validates that the input path is inside AI SkillHub's own staging root before copying.
- Existing target source folders are blocked; the first implementation will not overwrite or merge user/source data.
- Promotion writes JSON, Markdown, and manifest reports under `.skillhub-next/reports/source-import-promotion`.
- GitHub promotions preserve `.git` metadata so future pull/update support remains possible.
- The UI now shows a separate promotion result card after staging, including target path, copied files, Skill count, report path, manifest path, and rollback instructions.
- This still does not write to `skills`, Claude, Codex, Antigravity, or release packages.

Verification after the pass: `pnpm build` passed and Rust `cargo test` passed with 29 tests.

Remaining V2 gap: AI-tool sync/link and release packaging remain locked behind backup, restore, desktop QA, share validation, and Release Gate.

## 2026-05-31 Real Write Readiness Checkers

V2 now has explicit readiness checkers for the two remaining high-risk write paths:

- `agent-sync-readiness` checks whether Claude/Codex/Antigravity sync/link takeover is eligible for real execution.
- `release-package-readiness` checks whether the formal release package path is eligible for real packaging.
- Both runners write JSON, Markdown, and manifest reports under `.skillhub-next/reports/real-write-readiness`.
- Both runners are report-only: they do not modify Claude, Codex, Antigravity, global `skills`, Git tags, GitHub Releases, or release packages.
- The real-write unlock matrix no longer has a permanent "executor not implemented" blocker. It now blocks on auditable readiness reports plus diagnostics, backup dry-run, restore dry-run, rollback, desktop QA, share validation, and report bundle state.
- The UI now labels blocked runners as blocked instead of showing them as runnable.

Verification after the pass: `pnpm build` passed and Rust `cargo test` passed with 29 tests.

Remaining V2 gap: actual AI-tool sync/link and formal release package execution still require final operator-triggered execution code and live desktop QA. They must remain gated and cannot run automatically.

## 2026-05-31 Final Executor Guard Rails

V2 now has auditable final-execution entries for the last two high-risk paths:

- `agent-sync-executor` is the final AI-tool sync/link execution entry.
- `release-package-executor` is the final release-package execution entry.
- Both entries write JSON, Markdown, and manifest reports under `.skillhub-next/reports/real-write-execution`.
- If any write gate still has a blocker, the executor returns `blocked` and writes the exact blocking checks.
- If all blockers are cleared later, the executor can enter an `armed` state, but still requires explicit operator confirmation before any future real write implementation is allowed.
- The current build keeps `realWrites=false`; it never modifies Claude/Codex/Antigravity directories and never creates release packages, tags, or GitHub Releases while blockers exist.
- `v2-completion-audit` now checks that the readiness reports and final execution guard reports exist, so V2 completion is tied to an auditable safety path rather than a hidden assumption.

Verification after the pass: `pnpm build` passed and Rust `cargo test` passed with 29 tests.

Remaining V2 gap: live desktop QA and any future real-write implementation must still be manually triggered after the Release Gate is clean. The product path is now complete enough to show where the final writes would occur and why they are currently blocked.

## 2026-05-31 Operator Authorization And Popularity Trends

V2 now separates "the app is technically able to plan a write" from "the user has explicitly authorized real writes":

- Release Gate has a persisted operator authorization switch for real writes.
- The switch is permission only. It does not bypass diagnostics, backup dry-run, restore dry-run, rollback, desktop QA, share validation, report bundle, readiness reports, or final executor guard reports.
- `agent-sync` and `release-package` gates now require this authorization before they can ever move beyond blocked/armed status.
- The authorization state is stored in SQLite and included in readiness/execution reports for auditability.
- `source_popularity_cache` now stores GitHub repository creation time in addition to stars, forks, issues, last update, and cache status.
- `source_popularity_history` stores timestamped popularity snapshots on successful manual refreshes.
- Usage Insights can switch between heatmap, bar chart, and trend views. The trend view shows every indexed source with current stars, forks, local usage, and a compact trend sparkline when history exists.
- Full GitHub history before AI SkillHub started collecting snapshots is not claimed as exact data. The app records exact trend points from AI SkillHub refreshes onward; deeper historical reconstruction would require extra GitHub API/event ingestion and rate-limit handling.

Verification after the pass: `pnpm build`, Rust `cargo test` with 29 tests, `git diff --check`, and `pnpm tauri build --no-bundle` passed. The root double-click executable was refreshed at `D:\My Files\AI_global_skills\AI SkillHub V2 Alpha.exe`.

## 2026-06-01 Scientific Usage Heatmap Pass

Usage Insights now follows a scientific heatmap model instead of showing decorative per-project cards:

- The heatmap is a source-by-metric matrix. Each source project is a row; metrics are local usage, 7-day usage, 30-day usage, GitHub stars, forks, and Skill count.
- Each metric column is normalized against that column's max value and mapped into a shared 7-level green-to-cream-to-purple scale.
- The heatmap includes explicit row labels, column labels, and a low-to-high legend, so the colors can be interpreted like a data figure rather than UI decoration.
- The bar chart now uses the same level system for its fills, keeping low/medium/high semantics consistent between heatmap and bars.
- The Sources navigation item now sits before Skill Library to match the intended beginner flow: add/manage sources first, then inspect enabled Skills.
- The locally cloned `nature-skills` source was verified separately from `Nature-Paper-Skills`; its ten direct `nature-*` Skill folders are linked into the shared active skills root and Codex skill path.

Verification after the pass: `pnpm build`, Rust `cargo test` with 29 tests, `git diff --check`, and `pnpm tauri build --no-bundle` passed. The root double-click executable was refreshed at `D:\My Files\AI_global_skills\AI SkillHub V2 Alpha.exe`.

## 2026-06-01 nature-skills Discovery Repair

Codex could not find `/nature-skills` because `nature-skills` was a repository collection name, not a direct installable Skill folder with its own `SKILL.md`. The individual `nature-*` Codex junctions were also pointing at missing active-root folders, so their names existed but their `SKILL.md` files were not reachable.

Repair applied:

- Recreated the shared active-root junctions for the ten direct `nature-skills` Skills: `nature-academic-search`, `nature-citation`, `nature-data`, `nature-figure`, `nature-paper2ppt`, `nature-polishing`, `nature-reader`, `nature-response`, `nature-reviewer`, and `nature-writing`.
- Added a local router Skill named `nature-skills` under `app/github_sources/AI-SkillHub-local-routers/nature-skills`.
- Linked `D:\My Files\AI_global_skills\skills\nature-skills` and `C:\Users\Francis\.codex\skills\nature-skills` so Codex can discover the collection name directly.

Operational note: existing Codex sessions may cache the skill list. After this repair, open a new Codex session or restart Codex if `/nature-skills` still does not appear immediately.

## 2026-06-01 Sources V1-Style Quick Add Flow

V2 Sources now moves back toward the original V1 mental model for beginners:

- The primary Sources flow is now: paste GitHub/local/zip input -> preview -> isolated staging -> promote into `app/github_sources` -> refresh index -> save metadata.
- The Quick Add form includes source type, category, tags, note, and enabled state before the source is added.
- Successful Quick Add now refreshes the index and attempts to bind the saved metadata to the newly promoted source automatically.
- The UI explicitly states that adding a source does not sync to Claude/Codex/Antigravity. AI-tool sync remains a separate Release Gate action.
- Manual promotion from staging also refreshes the index and reports that AI-tool sync still needs separate confirmation.

This keeps the beginner path simple while preserving the safety boundary: source-library writes are allowed through the guarded import flow, but AI-tool directory writes are still not implicit.

## 2026-06-01 Sources Beginner Flow Simplification

After real use, the previous Quick Add screen still exposed too much internal safety machinery. Users saw "dry-run", "staging", and "promote" as if they had to manually click three steps after pressing the primary button.

Product decision:

- The default Sources path is now one action: paste input -> choose metadata -> click "一键添加并刷新".
- Preview, isolated staging, promotion, and report paths still exist, but they are advanced safety details and are collapsed by default.
- The one-click path runs quietly through preview/staging/promotion/refresh and only shows a human-readable status: checking, adding, added, blocked, or failed.
- The message "已生成，未写入任何目录" is no longer shown during the one-click flow because it describes an internal preview step, not the user's actual outcome.
- Writing to Claude/Codex/Antigravity remains a separate Release Gate action. Adding a source library entry must never secretly sync AI-tool directories.

This restores the V1-style mental model while keeping the V2 audit trail.

## 2026-06-01 Sources Decomplexity Repair

Real user testing found two regressions from the V1 mental model:

- Re-adding a GitHub source whose folder already existed was shown as blocked.
- A leftover `~\.gemini\antigravity\skills` junction was interpreted as installed/managed Antigravity even when Antigravity itself was not installed.

Fixes applied:

- Existing GitHub sources now continue as a refresh/update path instead of a hard block.
- Promotion status now supports `already-managed`, so the UI can say "来源已存在，已刷新" instead of "被阻止".
- GitHub duplicate URL preflight is now a warning, not a stop sign, because the beginner action should be idempotent.
- Repositories that contain nested `.zip` / `.skill` packages are counted during source import preview, so packaged Skill repos are not mistaken for prompt-only repos.
- Agent detection no longer treats a skills directory or junction alone as proof that Antigravity is installed. Directory-only Antigravity evidence is shown as not detected/not enabled.

Product correction: V2 must keep the advanced dry-run and Release Gate machinery, but the default Sources path remains V1-style: paste input, choose metadata, one-click add or refresh.

Verification after the repair: `pnpm build`, Rust `cargo test` with 29 tests, `git diff --check`, and `pnpm tauri build --no-bundle` passed. The root double-click executable was refreshed at `D:\My Files\AI_global_skills\AI SkillHub V2 Alpha.exe`.

## 2026-06-01 Parent / Child Skill Routing

The product model now treats large Skill repositories as collections:

- A parent Skill is a router. It helps users choose the right focused child Skill.
- Child Skills are execution units. They should be used directly when the user already knows the exact task.
- V2 should surface both levels: show the parent collection entry first, then show its child Skills underneath or nearby.
- Missing parent router entries are a usability bug, even if the child Skills are installed correctly.

Repair applied for `research-writing-skill`:

- Added a local router Skill at `app/github_sources/AI-SkillHub-local-routers/research-writing-skill`.
- Linked `D:\My Files\AI_global_skills\skills\research-writing-skill`.
- Linked `C:\Users\Francis\.codex\skills\research-writing-skill`.
- The router defaults to `using-research-writing` and lists focused children such as `paper-orchestration`, `brainstorming-research`, `writing-chapters`, `literature-review`, `figures-python`, and `verification`.

V2 UI update:

- Skill Library now includes a Skill Collections panel.
- The panel explains the parent/child model and shows grouped collection cards based on source repositories.
- Collection cards can copy the parent router call when a parent exists, or the best child call when no parent router exists yet.

Product rule: every multi-skill GitHub source should either expose a direct parent Skill or get an AI SkillHub local router. This keeps `/repo-name` discoverable without hiding the focused child Skills.

Follow-up implementation:

- `app/SkillHub.ps1` now automatically creates AI SkillHub local router Skills for multi-skill repositories that do not expose a repo-name `name:` entry.
- The generated routers live under `app/github_sources/AI-SkillHub-local-routers/<repo-name>/SKILL.md`.
- The script compares the effective `SKILL.md` `name:` value, not just the folder name, because Codex slash discovery follows the Skill name.
- Running SkillHub sync refreshes both the shared `skills` root and managed Claude/Codex/Antigravity links, so future multi-skill repos should not need one-off router repairs.
