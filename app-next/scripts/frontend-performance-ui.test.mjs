import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { readAppSource } from "./app-source.mjs";

const app = await readAppSource();
const backend = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const effects = await readFile(new URL("../src/effects.tsx", import.meta.url), "utf8");
const i18n = await readFile(new URL("../src/i18n.ts", import.meta.url), "utf8");
const preview = await readFile(new URL("../src/preview.ts", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const universe = await readFile(new URL("../src/SkillUniverse.tsx", import.meta.url), "utf8");

test("pack rows and child Skills expose exact-name copy actions", () => {
  // v3.3: the row is the parent entry; "复制调用名" sits on every row (not only in ⋯) and copies
  // what an AI tool accepts: the parent entry, or "parent child" for a skill inside a pack.
  // The internal `pack__child` index key is never copied.
  assert.ok(app.includes("export function rowEntrySkill(row: LibraryRow): SkillCard | null"));
  assert.ok(app.includes('return row.ownedSkills.find(skill => isRouterHubSkill(skill)) ?? row.skills[0] ?? null;'));
  assert.ok(app.includes('copyTextToClipboard(callName, t("v33.copiedName", { name: callName }))'));
  assert.ok(app.includes('copyTextToClipboard(skillInvocationName(skill), t("v33.copiedName", { name: skillInvocationName(skill) }))'));
  assert.ok(app.includes("return skill.invocationName?.trim() || skill.folderName.trim() || skill.name.trim()"));
  assert.ok(backend.includes("skill_call_name(&skill.folder_name, &pack_entry, skill.is_router_hub)"));
  assert.ok(backend.includes('format!("{pack_entry} {child}")'));
  assert.match(preview, /name: "Nature-Paper-Skills",\s*invocationName: "nature-paper-skills"/);
  const rowMenu = app.slice(app.indexOf("function LibraryRowView"), app.indexOf("function ChildRow"));
  assert.doesNotMatch(rowMenu, /copySkillPrompt|onRecordUsage|recordUsage/);
  assert.equal([...i18n.matchAll(/"toast\.skillNameCopied":/g)].length, 3);
});

test("native folder selectors inherit the active light or dark theme", () => {
  assert.match(styles, /\.theme-dark,[\s\S]*?\.theme-nocturne \{ color-scheme: dark; \}/);
  assert.match(styles, /\.theme-light,[\s\S]*?\.theme-parchment \{ color-scheme: light; \}/);
  assert.match(styles, /\.shell select option \{ color: var\(--text\); background-color: var\(--surface-elevated\); \}/);
  const drawer = styles.match(/\.drawer \{([\s\S]*?)\n\}/)?.[1] ?? "";
  assert.doesNotMatch(drawer, /color-scheme/);
});

test("pointer glow work is coalesced to one layout read per animation frame", () => {
  const hook = effects.slice(effects.indexOf("export function useCardGlow"));
  assert.match(hook, /if \(!frame\) frame = window\.requestAnimationFrame\(updateGlow\)/);
  assert.equal((hook.match(/getBoundingClientRect\(\)/g) ?? []).length, 1);
  assert.match(hook, /window\.cancelAnimationFrame\(frame\)/);
});

test("decorative canvases stop when hidden, unfocused, or outside the viewport", () => {
  const field = effects.slice(effects.indexOf("export function ParticleField"), effects.indexOf("function rotate3"));
  assert.match(field, /return pageVisible && focused && intersecting && !reduceMotion/);
  assert.match(field, /window\.addEventListener\("focus", onFocus\)/);
  assert.match(field, /window\.addEventListener\("blur", onBlur\)/);
  assert.match(field, /new IntersectionObserver/);
  assert.match(field, /mode === "backdrop"\) return 1000 \/ 6/);
  assert.match(field, /return 1000 \/ 8/);
  assert.match(field, /if \(performance\.now\(\) < interactionUntil\) return 1000 \/ 60/);
  assert.match(field, /!urgent && !hasActiveMotion\(\)/);
  assert.match(field, /return now < ambientUntil \|\| now < interactionUntil/);
  assert.match(field, /if \(!reduceMotion\) \{[\s\S]*?window\.addEventListener\("pointermove", onPointerMove/);
  assert.match(field, /Math\.sqrt\(1_700_000 \/ Math\.max\(1, width \* height\)\)/);

  const showcase = app.slice(app.indexOf("function SkillShowcase"), app.indexOf("function UsageInsightPanel"));
  assert.match(showcase, /const canRender = \(\) => !disposed && pageVisible && intersecting/);
  assert.match(showcase, /reducedMotion \|\| !focused \? 0 : time/);
  assert.match(showcase, /runtime\.requestDraw\(\)/);
  assert.match(showcase, /new IntersectionObserver/);
  assert.match(showcase, /Math\.min\(window\.devicePixelRatio \|\| 1, 2, pixelBudgetScale\)/);
  assert.match(app, /mode="backdrop"/);
});

test("the Skill universe rotates slowly only while the homepage is active", () => {
  assert.match(universe, /hasInteractiveMotion/);
  assert.match(universe, /const ambientInterval = runtime\.drawMs > 18 \? 1000 \/ 30 : 0/);
  assert.match(universe, /!hasInteractiveMotion\(\) && time - lastDrawAt < ambientInterval - 1/);
  assert.match(universe, /frame = window\.requestAnimationFrame\(draw\)/);
  assert.match(universe, /if \(reducedMotion && !urgent\) return/);
  assert.doesNotMatch(universe, /ambientUntil/);
  assert.match(universe, /Math\.sqrt\(16_777_216 \/ Math\.max\(1, width \* height\)\)/);
  assert.match(universe, /Math\.max\(1, Math\.min\(window\.devicePixelRatio \|\| 1, pixelBudgetScale\)\)/);
  assert.match(universe, /resolutionQuery\.addEventListener\("change", onResolutionChange\)/);
  assert.match(universe, /runtime\.requestDraw = \(\) => scheduleDraw\(true\)/);
  assert.match(universe, /window\.addEventListener\("focus", onFocus\)/);
  assert.match(universe, /window\.addEventListener\("blur", onBlur\)/);
  assert.match(universe, /new IntersectionObserver/);
  assert.match(universe, /runtime\.drawMs > 18 \? 0\.58 : runtime\.drawMs > 12 \? 0\.78 : 1/);
  assert.doesNotMatch(universe, /targetQuality = runtime\.frameMs/);
  assert.doesNotMatch(styles, /animation: atlas-breathe 2\.8s ease-in-out infinite/);
});

test("desktop startup does not load the browser-only preview fixture", () => {
  assert.doesNotMatch(app, /from "\.\/preview"/);
  assert.match(app, /let previewModulePromise: Promise<typeof import\("\.\/preview"\)> \| null = null/);
  assert.match(app, /previewModulePromise \?\?= import\("\.\/preview"\)/);
});

test("desktop startup paints the SQLite index before expensive live Agent status checks", () => {
  const commandStart = backend.indexOf("async fn load_indexed_snapshot");
  const commandEnd = backend.indexOf("async fn run_skillhub_sync", commandStart);
  const command = backend.slice(commandStart, commandEnd);
  assert.match(command, /run_blocking_task\(load_startup_indexed_snapshot_blocking\)/);
  const startupStart = backend.indexOf("fn load_startup_indexed_snapshot_blocking");
  const startupEnd = backend.indexOf("fn load_indexed_snapshot_with_fallback", startupStart);
  const startup = backend.slice(startupStart, startupEnd);
  assert.match(startup, /read_startup_snapshot_from_database/);
  assert.match(backend, /read_snapshot_from_database_with_runtime\(root, connection, false\)/);
  assert.match(backend, /if hydrate_runtime_statuses \{[\s\S]*derive_agent_skill_statuses/);
  assert.match(backend, /if hydrate_runtime_statuses \{\s*hydrate_source_urls_from_git/);
  assert.match(backend, /let source_governance = if hydrate_runtime_statuses/);
  assert.match(backend, /let release_reports = if hydrate_runtime_statuses/);
  assert.match(backend, /let operation_runners = if hydrate_runtime_statuses/);
});

test("startup restores deferred runtime cards without rescanning or replacing the library", () => {
  const frontendStart = app.indexOf("async function hydrateDeferredRuntime");
  const frontendEnd = app.indexOf("async function verifyStartupSnapshot", frontendStart);
  const frontendHydration = app.slice(frontendStart, frontendEnd);
  assert.ok(frontendStart >= 0 && frontendEnd > frontendStart);
  assert.match(frontendHydration, /invoke<RuntimeSnapshotHydration>\("hydrate_runtime_snapshot"\)/);
  assert.match(frontendHydration, /setSnapshot\(current => current \? \{ \.\.\.current, \.\.\.hydration \} : current\)/);
  assert.match(frontendHydration, /runtimeHydrationInFlightRef\.current/);
  assert.match(frontendHydration, /generation !== runtimeMutationGenerationRef\.current/);
  assert.match(frontendHydration, /mutationBusyRef\.current/);
  assert.match(frontendHydration, /scheduleDeferredRuntimeRetry/);
  assert.doesNotMatch(frontendHydration, /setLoading|setInitialDeliveryBusy|setIndexRefreshing|setOperation/);
  assert.match(app, /if \(verified && runtimeAvailable\) void hydrateDeferredRuntime\(isCancelled\)/);
  assert.match(app, /data-runtime-hydrated=\{runtimeHydrated \? "true" : "false"\}/);

  const backendStart = backend.indexOf("fn hydrate_runtime_snapshot_blocking");
  const backendEnd = backend.indexOf("fn load_indexed_snapshot_with_fallback", backendStart);
  const backendHydration = backend.slice(backendStart, backendEnd);
  assert.ok(backendStart >= 0 && backendEnd > backendStart);
  assert.match(backendHydration, /read_cached_governance_cards/);
  assert.match(backendHydration, /RuntimeSnapshotHydration \{/);
  assert.doesNotMatch(backendHydration, /scan_legacy_snapshot|run_skillhub_script|run_diagnostics_export_script|hydrate_source_urls_from_git/);
});

test("folder drops use pointer drags and honor the shared mutation busy state", () => {
  // v3.3 §3.9: dragDropEnabled disables HTML5 drag inside the webview, so rows use pointer drags.
  assert.doesNotMatch(app, /draggable=/);
  assert.ok(app.includes("data-folder-drop={dropId}"));
  assert.ok(app.includes('if (over === undefined || over === "all") return;'));
  const folderCommand = app.slice(app.indexOf("async function runSkillFolderCommand"), app.indexOf("function onImportInstalled"));
  assert.ok(folderCommand.includes("if (mutationBlockedBySync()) return null"));
});

test("source metadata and tags save through one compact background mutation", () => {
  const start = app.indexOf("async function updateSourceMetadata");
  const end = app.indexOf("async function deleteSource", start);
  const mutation = app.slice(start, end);
  assert.ok(mutation.includes('invoke<SourceMutationResult>("save_source_metadata"'));
  assert.ok(mutation.includes("tags: parseTagInput(draft.tags)"));
  assert.ok(mutation.includes("if (result.snapshot) applySnapshot(result.snapshot, true)"));
  assert.ok(mutation.includes("sources: current.sources.map"));
  // The drawer never flips the library switch here; that goes through the security review gate.
  assert.ok(mutation.includes("enabled: source.enabled"));
  assert.doesNotMatch(mutation, /"set_source_metadata"|"set_source_tags"|setLoading\(true\)/);
  assert.equal((mutation.match(/await invoke</g) ?? []).length, 1);
  const editorStart = app.indexOf("function SettingsTab");
  const editorEnd = app.indexOf("export function ReviewSecurityDialog", editorStart);
  assert.ok(editorStart >= 0 && editorEnd > editorStart);
  const editor = app.slice(editorStart, editorEnd);
  assert.ok(editor.includes("const [saving, setSaving] = useState(false)"));
  assert.ok(editor.includes("if (!dirty || disabled) return"));
  assert.ok(editor.includes("await save(draft)"));
  assert.equal((editor.match(/disabled=\{disabled\}/g) ?? []).length >= 7, true);
});

test("startup never locks the window and reports a failed verify with an action", () => {
  // v3.3 (I-4): startup enqueues a verify job; only the initial SQLite load counts as busy.
  assert.ok(app.includes("const mutationBusy = loading || indexRefreshing || popularityRefreshing || Boolean(operation) || importInFlight;"));
  assert.doesNotMatch(app, /initialDeliveryBusy/);
  assert.doesNotMatch(app, /const mutationBusy =[^\n]*!startupVerified/);
  assert.ok(app.includes("indexRefreshInFlightRef.current"));
  assert.ok(app.includes('const pending = loadSnapshot("scan", { background: true, quiet: true })'));
  assert.ok(app.includes("initialDeliveryInFlightRef.current = false"));
  assert.ok(app.includes("setStartupVerified(verified)"));
  assert.ok(app.includes('if (!isCancelled()) showError(error, "delivery")'));
  assert.ok(app.includes("verifyStartupSnapshot(true, () => cancelled, true)"));
  assert.ok(app.includes("const startTimer = window.setTimeout"));
  assert.ok(app.includes("window.clearTimeout(startTimer)"));
  assert.ok(app.includes("initialDeliveryCheckStartedRef.current = false"));
  assert.doesNotMatch(app, /window\.location\.reload\(\)/);
});

test("usage audit recording never reloads the complete snapshot", () => {
  const start = app.indexOf("async function recordUsage");
  const end = app.indexOf("async function refreshSourcePopularity", start);
  const recording = app.slice(start, end);
  assert.match(recording, /await invoke<void>\("record_usage_event"/);
  assert.doesNotMatch(recording, /LegacySnapshot|setSnapshot/);
});

test("popularity refresh merges only compact cards and stays single-flight", () => {
  const start = app.indexOf("async function refreshSourcePopularity");
  const end = app.indexOf("async function reanalyzeLibraryMetadata", start);
  const refresh = app.slice(start, end);
  assert.match(refresh, /popularityRefreshInFlightRef\.current/);
  assert.match(refresh, /invoke<SourcePopularityRefreshResult>\("refresh_source_popularity"\)/);
  assert.match(refresh, /sourcePopularity: result\.sourcePopularity/);
  assert.doesNotMatch(refresh, /invoke<LegacySnapshot>|applySnapshot|loadSnapshot/);
});
