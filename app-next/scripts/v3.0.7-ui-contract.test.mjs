import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { readAppSourceSync } from "./app-source.mjs";

const app = readAppSourceSync();
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const universe = readFileSync(new URL("../src/SkillUniverse.tsx", import.meta.url), "utf8");
const translations = readFileSync(new URL("../src/i18n.ts", import.meta.url), "utf8");
const icons = readFileSync(new URL("../src/icons.tsx", import.meta.url), "utf8");
const capability = readFileSync(new URL("../src-tauri/capabilities/default.json", import.meta.url), "utf8");

test("editor portal inherits the active theme and keeps explicit readable surfaces", () => {
  assert.match(app, /id="app-overlay-root"/);
  assert.match(app, /document\.getElementById\("app-overlay-root"\) \?\? document\.body/);
  assert.match(app, /aria-modal="true"/);
  assert.match(styles, /#app-overlay-root\s*\{\s*display:\s*contents/);
  assert.match(styles, /\.drawer\s*\{[\s\S]*?color:\s*var\(--text\)/);
  assert.match(styles, /\.drawer\s*\{[\s\S]*?background:\s*color-mix\(in srgb, var\(--bg\) 88%, var\(--surface-strong\)\)/);
  assert.match(styles, /\.drawer input::placeholder,[\s\S]*?opacity:\s*1/);
  assert.doesNotMatch(app, /,\s*document\.body\s*\);/);
});

test("star map nodes are flat shapes with explicit focus states and placed labels", () => {
  assert.match(universe, /type UniverseNodeFocus = "active" \| "selected" \| "neighbor" \| "muted" \| "normal";/);
  assert.match(universe, /function drawUniverseLabels\(/);
  // Labels skip any side that would overlap a placed label or an HTML control.
  assert.match(universe, /runtime\.obstacles\.some\(/);
  assert.match(universe, /!placed\.some\(/);
  // Project name first, owner de-emphasised.
  assert.match(universe, /label: sourcePresentation\(source\)\.title/);
  assert.match(universe, /onClick=\{selectNode\}/);
});

test("startup loading is not mislabeled as a remote synchronization", () => {
  // v3.3: "正在更新…" only while the 更新 run is really running; loading the index is its own
  // state, and delivery progress lives in the sync indicator.
  assert.ok(app.includes('{operation ? t("v33.updating") : t("v33.update")}'));
  assert.ok(app.includes('<DeferredSurface label={t("dash.loadingIndex")} />'));
  assert.ok(app.includes('loading ? t("v33.loadingLibrary") : t("v33.noMatch")'));
  assert.ok(app.includes('data-testid="sync-indicator"'));
  assert.equal((translations.match(/"dash\.loadingIndex"/g) ?? []).length, 3);
});

test("GitHub shortcut is fixed to the official project and opener scope is narrow", () => {
  assert.match(app, /const PROJECT_HOME_URL = "https:\/\/github\.com\/Francis-Zxp\/AI-SkillHub"/);
  assert.match(app, /invoke\("plugin:opener\|open_url", \{ url: PROJECT_HOME_URL, with: null \}\)/);
  assert.match(app, /<Icon name="github"/);
  assert.match(icons, /case "github":/);
  assert.match(capability, /https:\/\/github\.com\/Francis-Zxp\/AI-SkillHub/);
  assert.doesNotMatch(capability, /"https:\/\/github\.com\/\*"/);
});

test("immersive fullscreen hides app chrome but preserves an accessible exit", () => {
  assert.match(app, /dashboardImmersive/);
  assert.match(app, /dashboard-immersive/);
  assert.match(app, /event\.key === "Escape"/);
  assert.match(app, /atlas-immersive-toggle/);
  assert.match(icons, /case "fullscreen":/);
  assert.match(icons, /case "exitFullscreen":/);
  assert.match(styles, /\.dashboard-immersive\.theme-family-atlas\s*\{[\s\S]*?grid-template-columns:\s*0 minmax\(0, 1fr\)/);
  assert.match(styles, /\.dashboard-immersive \.sidebar\s*\{[\s\S]*?pointer-events:\s*none/);
  assert.match(styles, /\.dashboard-immersive \.topbar\s*\{[\s\S]*?pointer-events:\s*none/);
  assert.equal((translations.match(/"atlas\.enterImmersive"/g) ?? []).length, 3);
  assert.equal((translations.match(/"atlas\.exitImmersive"/g) ?? []).length, 3);
});
