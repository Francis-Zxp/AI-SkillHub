# Changelog

All notable changes to AI SkillHub are documented here.

## 3.1.0 - Reliable imports and read-only connection diagnostics

### Fixed

- Reworked GitHub imports around real backend stages instead of a simulated
  percentage. System Git, codeload ZIP inspection, security scanning, staging
  writes and promotion now report their actual state and remain off the UI
  thread.
- Codeload archives now skip repository symlink aliases without following or
  materializing them. Real Skill directories continue through bounded path,
  file-count, size and per-file security checks.
- Disabled anonymous per-file GitHub API fallback before it can exhaust the
  60-request public-IP quota. Network and rate-limit failures now explain the
  useful recovery path without exposing raw stacks.
- Cancellation now terminates the owned Windows process tree, removes partial
  staging and leaves formal sources untouched. A deterministic gate verifies
  prompt return rather than only checking the cancellation flag.
- Embedded the production Common Controls v6 resource in the Rust library test
  harness, so clean Windows runners can execute the complete backend suite.
- Kept atlas topbar actions inside the glass surface at 125–150% Windows DPI;
  the search field now yields width instead of pushing theme/sync controls out
  of a default-sized desktop window.

### Added

- Added an MCP Connection Center that inventories existing Codex and Claude
  Code configuration without starting servers or reading secret values.
  Logical servers and host bindings are shown separately; live Tools,
  Resources and Prompts remain explicitly “not probed”.
- Added a zero-write Codex Plugin Doctor that classifies local evidence and
  configuration faults without executing PowerShell, JavaScript, setup scripts
  or the separate desktop repair utility.
- Added a clean-Windows CI release gate with frontend behavior contracts, 115+
  Rust tests, MCP/doctor read-only integration tests, deterministic cancellation
  and a real `Imbad0202/academic-research-skills` codeload import.

### Safety boundary

- v3.1.0 does not edit MCP configuration, manage OAuth/tokens, start unknown MCP
  servers or repair plugins. Those mutations require a later signed, reversible
  design; the existing standalone Codex health tool remains untouched.

## 3.0.7 - Theme-safe editors, centered atlas, and immersive focus

### Fixed

- Mounted source and Skill editors inside the active themed application host
  instead of escaping CSS variables through a document-body portal. Every
  shipped light and dark theme now has an explicit, high-contrast drawer,
  input, placeholder and focus treatment.
- Rebuilt the atlas atmosphere from one concentric radial gradient. The
  volumetric core now shares the exact geometric center of the 384 px render
  texture instead of being biased toward its former highlight coordinate.
- Stopped describing the fast startup SQLite/cache load as a synchronization.
  Startup now says that the local index is loading; only the explicit
  synchronization path reports background sync progress.

### Added

- Added 5–20 session-stable meteors with bounded size, opacity, speed, slope
  and direction variation. Decorative dust also twinkles subtly, while drag,
  adaptive LOD and reduced-motion modes continue to suppress expensive effects.
- Added a signed, allowlisted GitHub project shortcut. Desktop builds can open
  only the official AI SkillHub project/docs paths through the opener
  capability.
- Added an immersive atlas control that animates the navigation rail and
  topbar away, expands the graph to the full workspace and remains reversible
  through the visible exit control or `Escape`.

### Validation status

- Ten-theme visual QA measured minimum drawer text contrast at 11.50:1 and
  input contrast at 11.21:1. The production build, 14 frontend governance/UI
  contracts, strict Rust formatting/Clippy, 93 Rust tests, npm production audit
  and a real Tauri desktop pass with 650 Skills all pass.

## 3.0.6 - Resilient updates, cache-first atlas, and editor polish

### Fixed

- Added bounded retries for official update checks and delayed background retry
  after a just-published GitHub release has not reached every `latest` endpoint.
  Users no longer need to restart the app to make a transient miss recover.
- Rendered Skill/source editing through a document-level portal so its fixed
  glass drawer remains on the right edge of the desktop viewport and cannot be
  trapped below the animated page or left navigation rail.
- Optically centered the visible logo artwork rather than only centering the
  transparent PNG canvas; removed the hidden second grid column that caused
  the remaining horizontal offset.
- Kept all theme names on one line at desktop and narrow-window breakpoints.

### Changed

- The capability atlas now restores a privacy-bounded cache of the previous
  real graph immediately, then crossfades to the current SQLite index. It does
  not pretend that the slower manual Git/source synchronization has completed.
- Replaced the multiple bloom islands with one directional volumetric core and
  reduced decorative shell/dust opacity. Meteor count, size, direction and
  speed vary per app session but remain stable within that session.
- Restored the right-side glass editing workflow and tightened its final
  viewport geometry to 12 px top/right/bottom with a 520 px wide maximum.

### Validation status

- Production build and five v3.0.6 UI contracts pass. Headless Chromium QA at
  1280×820 confirms a 0.21 px optical-logo offset, `cached → live` graph state,
  no absolute paths/notes in graph cache, single-line theme labels, no
  horizontal overflow, and a body-level glass drawer at z-index 101.

## 3.0.5 - Responsive imports, source-scoped routing, and visual finish

### Fixed

- Moved source preview, clone/download, security scan, promotion and Agent-link
  refresh work off the WebView event thread. The import wizard now exposes an
  accessible five-stage progress bar instead of appearing frozen.
- Raised the bounded selected-file ceiling from 1500 to 6000 while preserving
  the 80 MB archive/content ceiling, 16 MB per-file ceiling, safe path checks,
  symlink rejection and per-file security scan. A real isolated
  `pbakaus/impeccable` fallback download now passes.
- Scoped every generated parent router to explicit child `SKILL.md` paths from
  its own source. Automatic exact-name handling no longer writes a cross-source
  global dispatcher; only an explicit advanced choice can do so.
- Centered the collapsed sidebar logo and unified topbar, page-header, content
  panel and bottom event-tape widths at the default and narrow desktop windows.
- Restored natural text flow so short operational descriptions remain on one
  line and wrap only when the available width requires it.

### Changed

- Removed the non-deploying Preset/workspace distribution matrix from the
  product UI while retaining its SQLite data for backward compatibility.
- Made maintenance tools closed by default.
- Added two v3.0.2-compatible Classic Living Atlas themes without replacing the
  current Deep Space and Mist themes; standardized all theme names and sun/moon
  icons.
- Refined Spectral Gravity with fuller layered atmosphere, circular glossy
  source/parent nodes, subtle meteors, smoother inertia and unrestricted
  two-axis rotation.

### Validation status

- Production frontend build, 9 UI contract checks, strict Rust formatting and
  Clippy passed. Rust library suite completed with 93 passed, 0 failed and 2
  network gates ignored by default; the real Impeccable network gate was run
  separately and passed.
- Browser QA at 1280×820 confirmed no horizontal overflow, exact logo centering,
  aligned page axes, maintenance closed by default, distribution matrix absent,
  natural update copy, two-axis graph response and graph-only wheel handling.

## 3.0.4 - Spectral Gravity, explainable imports, and recoverable migration

### Added

- Added offline metadata recognition for GitHub sources, local folders, and
  standalone Skills. AI SkillHub reads bounded `README` / `SKILL.md` evidence
  to propose a summary, purpose, usage guide, category, and custom tags without
  executing imported code.
- Added one-click re-recognition for the existing library. User-edited notes,
  categories, tags, and ratings remain authoritative over generated metadata.
- Added a bounded per-file security scan to source staging and promotion
  reports. High-risk findings stop promotion; medium-risk findings remain in
  staging with redacted file-level evidence until the user explicitly confirms
  the review. The backend repeats the gate before any library or Agent write.
- Added an Adapter Doctor that separates desktop-app presence, local Code
  capability, PATH freshness, Skills-directory readiness, and stale directory
  residue instead of collapsing them into a single detected/not-detected flag.
- Added the recoverable v4 migration. It resumes interrupted source copies,
  validates ownership and content before atomic promotion, backs up SQLite
  before selective metadata merge, and never overwrites a newer destination.
- Added source version governance for Git-backed sources: pin the current
  commit, preview upstream file/addition/deletion differences, and restore the
  latest verified source backup with a pre-rollback snapshot and audit trail.
- Added an explainable local quality score based on up to four independent
  evidence types: personal/child rating, indexed health, recorded local use,
  and the per-file security scan. Missing evidence is excluded instead of
  becoming a zero; GitHub stars remain a separate popularity signal.
- Added an allowlist-only legacy cleanup assistant. It appears only after a
  successful v4 manifest and healthy SQLite check, moves selected old portable
  data to a recoverable backup, and never selects `release`.

### Changed

- Rebuilt the homepage visualization as Spectral Gravity. Source, parent
  router, and child Skill nodes are true screen-space circles with role-specific
  rings, rating segments, popularity emphasis, focused relationship pulses,
  and category/source color separation.
- Added adaptive LOD for large libraries, lower-cost interaction rendering,
  hidden-window pausing, reduced-motion behavior, and a static fallback after
  canvas context loss.
- Refined the operational themes around quieter neutral surfaces, consistent
  radii, clearer typography, and aligned controls. High-motion visual effects
  remain limited to the homepage.
- Shortened the localized homepage introduction. Chinese and English now use
  concise product copy while the data visualization remains the primary focus.

### Migration and privacy

- Program updates continue to replace only managed application files.
  Sources, ratings, user metadata, settings, and SQLite remain under
  `%LOCALAPPDATA%\AI SkillHub\UserData`.
- The v4 migration is copy-first and non-destructive. Legacy source bodies and
  database backups remain available until the recovered library is verified.
- The real legacy recovery restored 38 managed sources and 650 indexed Skills
  from a 38-source / 649-Skill legacy database. The extra Skill is a real
  same-source duplicate path found by the more complete current scanner, not a
  fabricated local Skill. Ratings, tags, manual metadata, and usage records
  were retained; “0 local” remains correct because the active `skills` entries
  are managed links rather than independent local sources.
- Migration scanning is process-serialized. Concurrent startup requests can no
  longer finalize a partial manifest; the verified manifest completed with
  zero failed and zero repair-needed sources.
- Generated metadata, scan reports, and adapter evidence are local data. Public
  packages continue to exclude personal sources, ratings, absolute paths,
  diagnostics, databases, and build caches.
- The desktop shell now enforces a production CSP and least-privilege
  capabilities. Release binaries are stripped and path-remapped, then scanned
  for developer paths; portable documentation is copied from a two-file
  allowlist instead of the full project docs tree.

### Validation status

- Final local release gates passed: frontend production build; 91 Rust tests
  (plus one network-only ignored unit); strict Clippy and formatting; explicit
  security-review UI/backend contracts; clean Chinese-path DataRoot startup;
  signed NSIS fresh/reinstall and public v3.0.3 → v3.0.4 upgrade; rating,
  metadata, config, and sentinel preservation; zero uninstall residue; updater
  signature verification; package privacy and path-remap checks.
- Source governance and legacy cleanup remain deliberately local and guarded:
  only Git-backed sources can be pinned/diffed/rolled back, rollback requires a
  verified backup, and cleanup requires explicit user confirmation.

## 3.0.3 - Signed automatic updates and visual-system refinement

### Added

- Added an official signed update channel backed by GitHub Releases. The
  desktop app checks automatically and offers one-click download, signature
  verification, passive replacement, and restart.
- Added a per-user NSIS installer. Program files are replaceable, while
  sources, ratings, settings, reports, and SQLite remain in
  `%LOCALAPPDATA%\AI SkillHub\UserData`.
- Added a formal release builder that signs the installer, emits `latest.json`,
  generates checksums, packages the portable fallback, and refreshes the
  developer root `AI SkillHub.exe` from the same verified build.

### Changed

- Rebuilt the default dark theme as Midnight Prism with neutral black surfaces,
  cobalt/ice hierarchy, a restrained warm signal color, dimmer navigation, and
  higher-contrast operational pages.
- Renamed Parchment to remove the product-name reference.
- Reworked the Skill universe visual grammar: sources are orbital beacons,
  parent Skills are polygonal route cores, and child Skills are lightweight
  particles. Category colors are more distinct and source-level variation is
  restrained.
- Shortened and localized the homepage introduction.
- Restricted Vite dependency discovery to the actual app entry so third-party
  demo HTML inside managed source repositories cannot affect development.

### Fixed

- Formal installers now include all required runtime PowerShell resources.
- The repository-root developer executable can no longer silently remain on an
  older version after a formal build.
- The update UI never displays raw network or installer errors to end users.

### Upgrade note

- v3.0.2 and older builds do not contain an updater, so install v3.0.3 once
  using the official setup executable. Updates after v3.0.3 are detected inside
  the app.

## 3.0.2 - Persistent data, automatic routing, and premium themes

### Added

- Added a source-level 1–5 star rating for every parent Skill. It persists even
  when the generated parent-router file has not been indexed on another
  computer.
- Added independent ChatGPT Desktop and Codex code-capability detection through
  Windows packages, Start apps, running processes, common install paths, CLI
  commands, bundled binaries, and real Codex state.
- Added the stable user-data directory
  `%LOCALAPPDATA%\AI SkillHub\UserData` and a copy-only v3.0.1 migration.
- Added automatic exact-name route ownership with source-qualified aliases and
  optional manual override.
- Added the Nocturne Graphite default theme and a Claude-inspired Parchment
  reading theme.

### Changed

- Routing Observatory copy now explains that collisions mean an exact callable
  name is shared by multiple sources, not merely that two Skills have similar
  functions.
- Parent collection routes are the recommended entry point for broad tasks;
  generated parent Skills select the smallest matching child Skill.
- Routing typography follows the global text scale, and the theme selector is a
  compact visual grid.
- AI-tool registry copy is shorter, and the sync icon uses a smaller optical
  size.
- Classic star maps use a clean grouped field instead of a center-out radial
  wash.

### Fixed

- Generated parent routers no longer appear as unassigned standalone Skills.
- Zero-only bar-chart entries are omitted; an empty state is shown when no
  real comparison exists.
- Updating or extracting AI SkillHub into a different folder no longer replaces
  imported sources, ratings, settings, or the SQLite index.
- ChatGPT Desktop-only installations are visible without creating a fake
  `.codex` directory or claiming that local Skill links are writable.

### Validation

- Verified real and simulated desktop-only OpenAI detection.
- Verified old portable data migration and parent-rating persistence after
  launching the same release from a second program folder.
- The final release must pass frontend build, Rust tests, Clippy, PowerShell
  parsing, packaged desktop QA, recipient import, public download, and checksum
  verification.

## 3.0.1 - Recipient compatibility and Claude detection

### Fixed

- GitHub source import no longer requires Git to be installed. AI SkillHub now
  prefers system Git, falls back to a bounded GitHub codeload archive, and uses
  a selective GitHub API download only as a final fallback.
- Repositories without `SKILL.md` are saved as Prompt/reference sources instead
  of failing or pretending to be installable Skills.
- Reordered AI-tool workspace refresh writes so existing preset/workspace
  policies no longer trigger a SQLite foreign-key constraint failure.
- Detects Claude Desktop installed as a Windows MSIX/Start app, Claude Code
  native binaries outside PATH, legacy Code state, and `CLAUDE_CONFIG_DIR`.
- Distinguishes Claude Desktop detection from Claude Code local-Skills
  readiness. The UI now explains that the local folder is for Claude Code and
  the Desktop Code tab, while Chat/Cowork Skills are imported in Claude.
- Release and recipient-test scripts now package the executable produced by the
  current Tauri release build instead of a potentially stale root executable.

### Changed

- Removed developer-only build guidance, desktop QA controls, dry-run/release
  executors, and snapshot/rollback history from ordinary Settings.
- Replaced those internal panels with a compact Safety & Support report that
  omits tokens, proxy values, Skill contents, database files, and absolute
  local paths.
- Non-Git GitHub imports preserve repository identity in local metadata so
  source URLs and popularity information remain available without `.git`.

### Validation

- Tested both an installable Skill repository and a Prompt-only repository in a
  fresh packaged UI with Git removed from PATH and a Chinese path containing
  spaces.
- Verified Claude Desktop-only diagnostics independently from Claude Code
  command/config detection.
- Rust tests, strict Clippy, frontend production build, MSI/NSIS build, portable
  package validation, and isolated fresh-recipient import are release gates.

## 3.0.0 - Living Atlas

### Added

- Added the Living Atlas homepage: a real-data Skill relationship globe with
  source, parent Skill, and child Skill nodes; drag, wheel zoom, hover details,
  double-click navigation, and relation/parent/type clustering.
- Mapped node size and density to real child-Skill counts, local ratings,
  GitHub popularity, source relationships, and semantic Skill categories.
- Added two Atlas themes, while preserving the original Classic dark and light
  interfaces as switchable fallbacks.
- Added a compact fixed liquid-glass Touch Bar and an animated introduction
  toggle. Hiding the introduction recenters the data globe.
- Added independent four-level text and functional-icon scaling in Settings.
- Added multi-resolution Windows icons so the title bar and taskbar remain
  sharp across common display scales.

### Changed

- Standardized product terminology on parent/child Skills.
- Reworked operational pages around a consistent content axis, radius grammar,
  higher-contrast dark/light tokens, larger navigation icons, and clearer
  hierarchy.
- Replaced the sync/refresh symbol with a continuous symmetric circular icon
  and a reduced-motion-aware loading rotation.
- Restricted high-motion particles and spatial effects to the showcase
  homepage; library, routing, settings, and safety pages favor readability.

### Fixed

- Kept the dashboard and Touch Bar fully visible at the default and minimum
  supported window sizes. Mouse-wheel input over either the globe or Touch Bar
  zooms the visualization instead of scrolling the page.
- Improved graph frame pacing, wheel smoothing, stable category/source colors,
  and visual depth in both Atlas dark and Atlas light modes.
- Restored rounded cards on Workspaces, Presets, and AI Tools after an earlier
  Atlas rule forced them to square corners.
- Reset document scroll position when changing pages so a newly opened page
  always starts at its header.

### Validation

- React/TypeScript production build passed.
- Rust formatting, 59 backend tests, and Clippy with warnings denied passed.
- Production Tauri executable passed real desktop QA in Atlas dark/light and
  Classic fallback themes, at default and minimum window sizes.
- The final release package is required to pass an isolated fresh-recipient
  import, sync, launch, SQLite ownership, and zero-orphan-router simulation.

## 2.0.4 - Portable source index and personal ratings

### Added

- Added private 1–5 star ratings for each Skill, stored in local SQLite with
  audit events and a click-again-to-clear interaction.
- Added `My rating (high to low)` sorting for source groups and their Skills,
  plus per-source average rating summaries.
- Added parent Skill rating controls directly to source-card headers. Rating
  sort now prioritizes the parent score, then rated child Skills.
- Added stable semantic source icon colors: violet for Skill, amber for Prompt,
  cyan for mixed/other material, and green for unassigned local folders.

### Fixed

- Fixed a migrated or previously empty SQLite index showing real source
  repositories as `0 Skill` on another computer. AI SkillHub now relocates
  stale source paths to the current project and rescans the source tree when
  `SKILL.md` exists.
- Stopped exposing the internal `AI-SkillHub-local-routers` storage folder as a
  normal source card.
- Stopped 269 generated router aliases and conflict dispatchers from being
  miscounted as local Skills. Existing SQLite indexes hide those legacy rows
  immediately; the next scan removes them from the persisted index.
- Updated remaining current-app fallback text from obsolete `app/` paths to
  `app-next/` paths.

### Changed

- Removed an unused Skill Library bulk metadata callback from the React surface.
- Documented the public/private boundary for ratings and portable first-run
  indexing.
- Renamed the remaining local group to `Unassigned standalone Skills` so real
  physical folders are not confused with GitHub-managed sources or internal
  router infrastructure. AI SkillHub preserves these folders until the user
  explicitly decides to remove them.

## 2.0.3 - Desktop polish and safety hardening

### Fixed

- Hid backend PowerShell/Git child processes during sync, refresh, diagnostics,
  AI tool link sync, and GitHub source staging so the desktop app no longer
  flashes a separate console window.
- Added the current app version to Settings.
- Fixed dashboard Health Issues and Advanced Release Gates so a deliberately
  locked real-rollback safety step is no longer treated as a release blocker.
- Added a repeatable zip import preview test report generator for release
  readiness checks.
- Hardened release/share helper scripts with root-boundary checks before
  recursive cleanup of temporary package folders.

## 2.0.2 - Stability and release readiness

### Fixed

- Fixed local usage charts so copy-only actions no longer appear as real Skill
  calls, and dashboard charts show all indexed rows inside adaptive scrolling
  panels.
- Fixed the Windows release executable so it opens as a normal desktop app
  without an extra console window.
- Kept AI tool re-detection isolated from Skill Library metadata, so checking
  Claude Code, Codex, or Antigravity no longer clears user notes or categories.
- Updated release and diagnostics scripts to use the real app version instead
  of stale alpha or old-version labels.
- Fixed diagnostics so an installed system WebView2 Runtime is accepted for the
  Tauri desktop app instead of requiring an obsolete packaged WebView2 DLL.

### Validation

- `pnpm build`: passed.
- `cargo test`: passed.
- `cargo clippy --all-targets -- -D warnings`: passed.
- `pnpm tauri build --no-bundle`: passed.
- Diagnostics export: passed with 0 errors and 0 warnings.
- Release package preflight: passed for `AI-SkillHub-2.0.2.zip`.
- Share-recipient test: passed.
- `pnpm audit --prod`: no known vulnerabilities.

## 2.0.1 - UI refresh and Skill Library redesign

### Added

- Added the redesigned AI SkillHub interface with a cleaner app shell, icon
  controls, glass surfaces, motion, particle dashboard background, four themes,
  and Chinese / English / Korean language switching.
- Merged source management and child Skill management into one `Skill Library`
  view. Expanding a source now shows its parent router Skill and child Skills
  directly beneath that source, with edit and enable controls kept in place.

### Changed

- Kept the existing same-name child Skill conflict selector, parent router
  rebuild flow, Agent sync flow, SQLite persistence, and GitHub heat palette
  while adopting the improved visual layout.
- Kept advanced safety and release checks, but moved them out of the daily Skill
  Library path so the normal install/manage workflow stays simpler.
- The browser title and visible product name now show `AI SkillHub`; version
  labels live in release metadata instead of the product name.

## 2.0.0 - Official release

### Fixed

- GitHub Actions frontend CI now uses Node.js 24, matching pnpm 11's runtime
  requirement and avoiding the `node:sqlite` install failure seen on Node 20.
- CI display name is now `AI SkillHub CI` instead of `V2 CI`.

### Release

- Promoted AI SkillHub from alpha builds to the official `2.0.0` release line.

## 2026-06-09 - Refresh and install stability

### Fixed

- Rebuilding parent router Skills now separates updated routers from routers
  that were already current, so repeated rebuilds show "already up to date"
  instead of a misleading skipped count.
- Router Hub rebuild results now include clear collapse controls.
- GitHub heat refresh no longer reports rate limits or temporary network
  failures as repository sync failures. These states are shown as deferred and
  keep the previous cache when available.
- Opening a source edit panel no longer compresses the Skill Library page into a
  narrow column.

### Changed

- One-click source install now refreshes shared Skills, parent router Skills,
  and Agent links as part of the install flow.
- The daily `同步 / 刷新` action now performs the expected update-and-sync flow
  directly. Higher-risk release and backup gates remain separate.
- Removed old internal migration/roadmap docs from the public docs folder.

### Validation

- `pnpm build`: passed.
- `cargo test`: 49 passed.

## 2026-06-06 - Desktop consolidation

### Added

- Added same-name child Skill conflict detection in the desktop app.
- Added the Skill Library conflict selector for duplicate child Skill names.
- Added persistent local conflict choices in SQLite table
  `skill_conflict_choices`.
- Added `app-next/SKILL_CONFLICT_SELECTOR.md` as the product rule for this
  behavior.

### Changed

- AI SkillHub is now maintained as one desktop project.
- Older prototype app implementations have been removed from the working tree.
- The root launcher is now `AI SkillHub.exe`.
- Runtime helper scripts now live under `app-next/runtime/`.
- Managed GitHub/local sources now live under `app-next/data/github_sources/`.
- Generated reports now live under `app-next/reports/`.
- Generated sync state now lives under `app-next/.skillhub-next/`.
- Public documentation was rewritten for the current desktop app.

### Removed

- Removed the old prototype executable and refreshed the current root launcher as
  `AI SkillHub.exe`.
- Removed old `app/` WebView/PowerShell implementation.
- Removed old `release/` output folder.
- Removed old v1.1 screenshots and release notes from public docs.

### Kept

- Kept `skills/` because it is the active shared Skill view used by AI tools.
  It is private and ignored by Git.

### Validation

- `pnpm build`: passed.
- `cargo test`: 41 passed.
- `pnpm tauri build --no-bundle`: passed.
- `app-next/runtime/SkillHub.ps1 -NoPull -ReportOnly`: passed.

## Historical note

The first prototype proved the runtime approach. Current development should stay
on the maintained desktop app and runtime scripts.
