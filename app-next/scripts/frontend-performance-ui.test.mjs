import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const backend = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const effects = await readFile(new URL("../src/effects.tsx", import.meta.url), "utf8");
const i18n = await readFile(new URL("../src/i18n.ts", import.meta.url), "utf8");
const preview = await readFile(new URL("../src/preview.ts", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const universe = await readFile(new URL("../src/SkillUniverse.tsx", import.meta.url), "utf8");

test("collapsed parent and expanded child Skills expose exact-name copy actions", () => {
  const sourceHeaderStart = app.indexOf('<header className="source-group-head">');
  const sourceHeaderEnd = app.indexOf("</header>", sourceHeaderStart);
  const sourceHeader = app.slice(sourceHeaderStart, sourceHeaderEnd);
  assert.match(app, /const primaryInvocationSkill = sourceParentSkill\(source, sourceSkills\)/);
  assert.match(app, /const primaryInvocationName = primaryInvocationSkill \? skillInvocationName\(primaryInvocationSkill\) : ""/);
  assert.match(sourceHeader, /className="icon-action source-parent-copy"/);
  assert.match(sourceHeader, /aria-label=\{t\("lib\.copyName", \{ name: primaryInvocationName \}\)\}/);
  assert.match(sourceHeader, /copyTextToClipboard\(primaryInvocationName, t\("toast\.skillNameCopied"\)\)/);
  assert.match(app, /return skill\.invocationName\?\.trim\(\) \|\| skill\.folderName\.trim\(\) \|\| skill\.name\.trim\(\)/);
  assert.match(backend, /invocation_name: row\.get\(2\)\?/);
  assert.match(preview, /name: "Nature-Paper-Skills",\s*invocationName: "nature-paper-skills"/);
  assert.match(app, /className="skill-name-copy"/);
  assert.match(app, /copyTextToClipboard\(skillInvocationName\(skill\), t\("toast\.skillNameCopied"\)\)/);
  assert.match(app, /!isParent && \(/);
  const copyNameAction = sourceHeader;
  assert.doesNotMatch(copyNameAction, /copySkillPrompt|onRecordUsage|recordUsage/);
  assert.equal([...i18n.matchAll(/"lib\.copyName":/g)].length, 3);
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
  assert.match(universe, /const ambientInterval = runtime\.drawMs > 18 \? 1000 \/ 20 : runtime\.drawMs > 12 \? 1000 \/ 28 : 1000 \/ 36/);
  assert.match(universe, /const interval = interactiveMotion \? 1000 \/ 60 : ambientInterval/);
  assert.match(universe, /if \(reducedMotion && !urgent\) return/);
  assert.doesNotMatch(universe, /ambientUntil/);
  assert.match(universe, /Math\.min\(window\.devicePixelRatio \|\| 1, 1\.35, pixelBudgetScale\)/);
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

test("folder drops and draggable rows honor the shared mutation busy state", () => {
  assert.match(app, /const acceptsDrop = !disabled && id !== "all"/);
  assert.match(app, /draggable=\{!loading\}/);
  assert.match(app, /draggable=\{Boolean\(!loading && skill\.id && !skill\.sourceId\)\}/);
  assert.match(app, /disabled=\{loading\}[\s\S]*?draft=\{sourceDrafts/);
  assert.match(app, /if \(mutationBlockedBySync\(\)\) return null/);
});

test("source metadata and tags save through one compact background mutation", () => {
  const start = app.indexOf("async function updateSourceMetadata");
  const end = app.indexOf("async function deleteSource", start);
  const mutation = app.slice(start, end);
  assert.match(mutation, /invoke<SourceMutationResult>\("save_source_metadata"/);
  assert.match(mutation, /tags: parseTagInput\(draft\.tags\)/);
  assert.match(mutation, /if \(result\.snapshot\) return result\.snapshot/);
  assert.match(mutation, /sources: current\.sources\.map/);
  assert.doesNotMatch(mutation, /"set_source_metadata"|"set_source_tags"/);
  assert.equal((mutation.match(/await invoke</g) ?? []).length, 1);
  const editorStart = app.indexOf("function SourceEditPanel");
  const editorEnd = app.indexOf("function Drawer", editorStart);
  const editor = app.slice(editorStart, editorEnd);
  assert.match(editor, /const \[saving, setSaving\] = useState\(false\)/);
  assert.match(editor, /if \(formDisabled\) return/);
  assert.match(editor, /await onSave\(/);
  assert.equal((editor.match(/disabled=\{formDisabled\}/g) ?? []).length >= 9, true);
});

test("startup delivery locks mutations only while running and can retry in place", () => {
  const skillStart = app.indexOf("function SkillEditPanel");
  const skillEnd = app.indexOf("function SourceEditPanel", skillStart);
  const editor = app.slice(skillStart, skillEnd);
  assert.equal((editor.match(/disabled=\{disabled\}/g) ?? []).length, 7);
  assert.match(app, /const \[initialDeliveryBusy, setInitialDeliveryBusy\] = useState\(true\)/);
  assert.match(app, /const \[indexRefreshing, setIndexRefreshing\] = useState\(false\)/);
  assert.match(app, /const mutationBusy = loading \|\| initialDeliveryBusy \|\| indexRefreshing \|\| popularityRefreshing \|\| Boolean\(operation\)/);
  assert.doesNotMatch(app, /const mutationBusy =[^\n]*!startupVerified/);
  assert.match(app, /indexRefreshInFlightRef\.current/);
  assert.match(app, /const pending = loadSnapshot\("scan", \{ background: true, quiet: true \}\)/);
  assert.match(app, /initialDeliveryInFlightRef\.current = false/);
  assert.match(app, /setInitialDeliveryBusy\(false\)/);
  assert.match(app, /setStartupVerified\(verified\)/);
  assert.match(app, /setStartupVerificationFailed\(runtimeAvailable && !verified\)/);
  assert.match(app, /const \[startupVerificationError, setStartupVerificationError\] = useState\(""\)/);
  assert.match(app, /setStartupVerificationError\(messageFromError\(error\)\)/);
  assert.match(app, /verifyStartupSnapshot\(!snapshot\)/);
  assert.match(app, /if \(!initialRun && \(initialDeliveryInFlightRef\.current \|\| mutationBusy \|\| mutationBlockedBySync\(false, false\)\)\) return/);
  assert.match(app, /startupVerificationFailed && \([\s\S]*?disabled=\{mutationBusy\}[\s\S]*?verifyStartupSnapshot\(!snapshot\)/);
  assert.match(app, /verifyStartupSnapshot\(true, \(\) => cancelled, true\)/);
  assert.match(app, /const startTimer = window\.setTimeout/);
  assert.match(app, /window\.clearTimeout\(startTimer\)/);
  assert.match(app, /initialDeliveryCheckStartedRef\.current = false/);
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
