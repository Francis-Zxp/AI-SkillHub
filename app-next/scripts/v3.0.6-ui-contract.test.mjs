import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
const styles = readFileSync(new URL("../src/styles.css", import.meta.url), "utf8");
const universe = readFileSync(new URL("../src/SkillUniverse.tsx", import.meta.url), "utf8");
const translations = readFileSync(new URL("../src/i18n.ts", import.meta.url), "utf8");
const tauriConfig = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));

test("updater uses redundant signed channels, bounded retries, and sanitized diagnostics", () => {
  const endpoints = tauriConfig.plugins.updater.endpoints;
  assert.equal(endpoints.length, 3);
  assert.equal(new Set(endpoints.map(endpoint => new URL(endpoint.replace("{{current_version}}", "3.1.4")).hostname)).size, 3);
  assert.ok(endpoints.every(endpoint => endpoint.includes("installed={{current_version}}")));
  assert.match(endpoints[0], /github\.com\/Francis-Zxp\/AI-SkillHub\/releases\/latest\/download\/latest\.json/);
  assert.match(endpoints[1], /raw\.githubusercontent\.com\/Francis-Zxp\/AI-SkillHub\/main\/updates\/latest\.json/);
  assert.match(endpoints[2], /cdn\.jsdelivr\.net\/gh\/Francis-Zxp\/AI-SkillHub@main\/updates\/latest\.json/);
  assert.match(app, /"retrying"/);
  assert.match(app, /const retryDelays = \[0\]/);
  assert.match(app, /timeout: 8_000/);
  assert.match(app, /\[30_000, 120_000, 480_000\]\[retryNumber\]/);
  assert.match(app, /updateCheckInFlightRef/);
  assert.match(app, /updateInstallInFlightRef/);
  assert.match(app, /addEventListener\("online", checkAfterReconnect\)/);
  assert.match(app, /addEventListener\("visibilitychange", checkAfterResume\)/);
  assert.match(app, /15 \* 60_000/);
  assert.match(app, /timeout: 600_000/);
  assert.match(app, /classifyUpdateFailure/);
  assert.match(app, /UPDATE_DIAGNOSTIC_STORAGE_KEY/);
  assert.match(app, /Raw transport[\s\S]*never reach UI\/storage/);
  assert.match(app, /const PROJECT_RELEASES_URL = "https:\/\/github\.com\/Francis-Zxp\/AI-SkillHub\/releases\/latest"/);
  assert.match(translations, /"update\.retryToast"/);
  assert.match(translations, /"update\.status\.retrying"/);
  assert.match(translations, /"update\.failure\.tls"/);
  assert.match(translations, /"update\.openReleases"/);
});

test("skill metadata editor remains a viewport-level readable glass drawer", () => {
  assert.match(app, /createPortal\(/);
  assert.match(app, /document\.body/);
  assert.match(styles, /\.drawer-backdrop\s*\{[\s\S]*?z-index:\s*100/);
  assert.match(styles, /\.drawer\s*\{[\s\S]*?right:\s*12px;[\s\S]*?z-index:\s*101/);
  assert.match(styles, /backdrop-filter:\s*blur\(22px\) saturate\(118%\)/);
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
  assert.match(universe, /length: 5 \+ \(METEOR_SESSION_SEED % 16\)/);
  assert.doesNotMatch(universe, /upperBloom|lowerBloom/);
  assert.equal((universe.match(/createRadialGradient\(192, 192, 2, 192, 192, 190\)/g) ?? []).length, 1);
});
