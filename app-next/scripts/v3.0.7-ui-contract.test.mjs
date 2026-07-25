import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
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

test("the volumetric core has one geometric center and richer bounded space motion", () => {
  assert.equal((universe.match(/createRadialGradient\(192, 192, 2, 192, 192, 190\)/g) ?? []).length, 1);
  assert.doesNotMatch(universe, /createRadialGradient\(165, 154, 3, 192, 192, 190\)/);
  assert.match(universe, /length:\s*5 \+ \(METEOR_SESSION_SEED % 16\)/);
  assert.match(universe, /direction:/);
  assert.match(universe, /head:/);
  assert.match(universe, /opacity:/);
  assert.match(universe, /width:/);
  assert.match(universe, /twinkle:/);
  assert.match(universe, /if \(time === 0 \|\| interactive \|\| lod === 2\) return/);
});

test("startup loading is not mislabeled as a remote synchronization", () => {
  assert.match(app, /snapshot\s*\?\s*t\("topbar\.processing"\)\s*:\s*t\("topbar\.loadingIndex"\)/);
  assert.match(app, /syncing=\{Boolean\(operation\)\}/);
  assert.match(app, /syncing\s*\?\s*t\("dash\.syncing"\)/);
  assert.match(app, /t\("dash\.loadingIndex"\)/);
  assert.equal((translations.match(/"topbar\.loadingIndex"/g) ?? []).length, 3);
  assert.equal((translations.match(/"topbar\.processing"/g) ?? []).length, 3);
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
