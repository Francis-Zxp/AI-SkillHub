// The Sky family follows the time of day (or one pinned phase), and home can
// switch the 3D islands off entirely.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = file => readFile(new URL(`../src/${file}`, import.meta.url), "utf8");
const app = await read("App.tsx");
const theme = await read("sky-theme.css");
const archipelago = await read("SkillArchipelago.tsx");
const scene = await read("skyScene.ts");
const kit = await read("sky/kit.ts");
const materials = await read("sky/materials.ts");

test("sky-auto is the default and resolves to four phases by local hour", () => {
  assert.match(app, /const DEFAULT_THEME: ThemeName = "sky-auto";/);
  assert.match(app, /if \(hour >= 5 && hour < 10\) return "dawn";/);
  assert.match(app, /if \(hour >= 10 && hour < 15\) return "noon";/);
  assert.match(app, /if \(hour >= 15 && hour < 19\) return "golden";/);
  assert.match(app, /const resolvedTheme: ThemeName = theme === "sky-auto" \? `sky-\$\{skyPhase\}` : theme;/);
  for (const phase of ["dawn", "noon", "golden", "night"]) {
    assert.match(app, new RegExp(`value: "sky-${phase}"`));
    assert.match(theme, new RegExp(`\\.theme-sky-${phase} \\{`));
  }
});

test("the night phase is a clean deep blue, not a hazy plum", () => {
  const start = theme.indexOf("/* Night:");
  const night = theme.slice(start, theme.indexOf("}", start));
  assert.match(night, /--bg: #0b111d;/);
  assert.doesNotMatch(night, /#16121d|#1c1727|#221a2b/i);
});

test("home can turn the 3D islands off; software renderers start with them off", () => {
  assert.match(scene, /return saved === null \? probeGraphics\(\)\.webgl && !probeGraphics\(\)\.weak : saved === "1";/);
  assert.match(archipelago, /if \(!sceneOn\) \{\s*setStatus\("off"\);/);
  assert.match(archipelago, /className="sky-board"/);
  assert.match(app, /<SkySceneSettingRow \/>/);
});

test("cartoon islands use no textures for ground or plants", () => {
  assert.doesNotMatch(kit, /TextureLoader|map:/);
  assert.doesNotMatch(materials.slice(materials.indexOf("export function terrainMaterial"), materials.indexOf("export function toonMaterial")), /texture2D/);
  assert.match(materials, /new THREE\.MeshToonMaterial\(/);
});
