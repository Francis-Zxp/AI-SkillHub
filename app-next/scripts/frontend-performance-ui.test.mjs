import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const effects = await readFile(new URL("../src/effects.tsx", import.meta.url), "utf8");
const i18n = await readFile(new URL("../src/i18n.ts", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");

test("every child Skill exposes an exact-name copy action without usage snapshot work", () => {
  const copyNameAction = app.match(/\{!isParent && \([\s\S]*?className="skill-name-copy"[\s\S]*?<\/button>\s*\)\}/)?.[0] ?? "";
  assert.match(copyNameAction, /aria-label=\{t\("lib\.copyName", \{ name: skill\.name \}\)\}/);
  assert.match(copyNameAction, /copyTextToClipboard\(skill\.name, t\("toast\.skillNameCopied"\)\)/);
  assert.doesNotMatch(copyNameAction, /copySkillPrompt|onRecordUsage|recordUsage/);
  assert.match(styles, /\.skill-name-copy \{[\s\S]*?width: 28px;[\s\S]*?height: 28px;/);
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

test("desktop startup does not load the browser-only preview fixture", () => {
  assert.doesNotMatch(app, /from "\.\/preview"/);
  assert.match(app, /let previewModulePromise: Promise<typeof import\("\.\/preview"\)> \| null = null/);
  assert.match(app, /previewModulePromise \?\?= import\("\.\/preview"\)/);
});

test("folder drops and draggable rows honor the shared mutation busy state", () => {
  assert.match(app, /const acceptsDrop = !disabled && id !== "all"/);
  assert.match(app, /draggable=\{!loading\}/);
  assert.match(app, /draggable=\{Boolean\(!loading && skill\.id && !skill\.sourceId\)\}/);
  assert.match(app, /disabled=\{loading\}[\s\S]*?draft=\{sourceDrafts/);
  assert.match(app, /if \(mutationBlockedBySync\(\)\) return snapshot/);
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

test("pending Skill saves and startup delivery lock only mutation controls", () => {
  const skillStart = app.indexOf("function SkillEditPanel");
  const skillEnd = app.indexOf("function SourceEditPanel", skillStart);
  const editor = app.slice(skillStart, skillEnd);
  assert.equal((editor.match(/disabled=\{disabled\}/g) ?? []).length, 7);
  assert.match(app, /const \[initialDeliveryBusy, setInitialDeliveryBusy\] = useState\(true\)/);
  assert.match(app, /const mutationBusy = loading \|\| initialDeliveryBusy \|\| popularityRefreshing \|\| Boolean\(operation\)/);
  assert.match(app, /initialDeliveryInFlightRef\.current = false/);
  assert.match(app, /setInitialDeliveryBusy\(false\)/);
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
