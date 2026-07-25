import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const universe = readFileSync(new URL("../src/SkillUniverse.tsx", import.meta.url), "utf8");
const translations = readFileSync(new URL("../src/i18n.ts", import.meta.url), "utf8");

test("updater retries transient release propagation failures without restarting", () => {
  assert.match(app, /"retrying"/);
  assert.match(app, /const retryDelays = silent \? \[0, 1_600\] : \[0, 1_100, 3_200\]/);
  assert.match(app, /retryNumber === 0 \? 45_000 : 120_000/);
  assert.match(translations, /"update\.retryToast"/);
  assert.match(translations, /"update\.status\.retrying"/);
});

test("skill metadata editor is a viewport-level right glass drawer", () => {
  assert.match(app, /createPortal\(/);
  assert.match(app, /document\.body/);
  assert.match(styles, /\.drawer-backdrop\s*\{[\s\S]*?z-index:\s*100/);
  assert.match(styles, /\.drawer\s*\{[\s\S]*?right:\s*12px;[\s\S]*?z-index:\s*101/);
  assert.match(styles, /backdrop-filter:\s*blur\(28px\) saturate\(128%\)/);
});

test("logo and theme labels keep optical alignment and one-line names", () => {
  assert.match(styles, /\.theme-family-atlas \.brand\s*\{[^}]*grid-template-columns:\s*1fr/);
  assert.match(styles, /\.theme-family-atlas \.brand-logo\s*\{[\s\S]*?transform:\s*translate\(-4\.1%, -1\.8%\)/);
  assert.match(styles, /\.theme-menu strong\s*\{[\s\S]*?white-space:\s*nowrap/);
  assert.match(styles, /\.settings-theme-row \.segmented button\s*\{[\s\S]*?white-space:\s*nowrap/);
});

test("universe starts from a bounded real cache and promotes to the SQLite model", () => {
  assert.match(universe, /UNIVERSE_CACHE_KEY = "ai-skillhub-universe-cache-v1"/);
  assert.match(universe, /raw\.length > 2_000_000/);
  assert.match(universe, /data-universe-state=/);
  assert.match(universe, /writeUniverseModelCache\(liveModel\)/);
  assert.match(styles, /@keyframes universe-cache-promote/);
});

test("universe uses one volumetric core and session-random subtle meteors", () => {
  assert.match(universe, /METEOR_SESSION_SEED = randomSessionSeed\(\)/);
  assert.match(universe, /length: 3 \+ \(METEOR_SESSION_SEED % 4\)/);
  assert.doesNotMatch(universe, /upperBloom|lowerBloom/);
  assert.equal((universe.match(/createRadialGradient\(165, 154, 3, 192, 192, 190\)/g) ?? []).length, 1);
});
