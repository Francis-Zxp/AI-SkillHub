// v3.3 sky track: source-level guards for the visual bugs (bugs.json area
// "visual", #36-#49), the memory work and the climate & weather controls.
// The browser checks live in v3.3-sky-bugs-qa.cjs, v3.3-sky-climate-qa.cjs and
// v3.3-sky-memory-qa.cjs.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Line endings normalised: a Windows checkout may carry CRLF.
const read = file => readFile(new URL(`../src/${file}`, import.meta.url), "utf8").then(text => text.replace(/\r\n/g, "\n"));
const [archipelago, world, weather, materials, universe, labelLayer, theme, refinements, archipelagoCss, assets, fauna, memory, effects, scene] = await Promise.all([
  read("SkillArchipelago.tsx"), read("sky/world.ts"), read("sky/weather.ts"), read("sky/materials.ts"), read("SkillUniverse.tsx"),
  read("universeLabelLayer.ts"), read("sky-theme.css"), read("refinements.css"), read("SkillArchipelago.css"), read("sky/assets.ts"),
  read("sky/fauna.ts"), read("sky/memory.ts"), read("sky/effects.ts"), read("skyScene.ts")
]);

/** The body of a function or method named `name` (brace matched). */
function body(source, marker) {
  const start = source.indexOf(marker);
  assert.ok(start >= 0, `missing ${marker}`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let index = open; index < source.length; index++) {
    if (source[index] === "{") depth++;
    else if (source[index] === "}" && --depth === 0) return source.slice(open, index + 1);
  }
  throw new Error(`unbalanced ${marker}`);
}

test("#36 a mouse press on a label does not fly the camera away from the pointer", () => {
  assert.match(archipelago, /onFocus=\{event => \{ if \(event\.currentTarget\.matches\(":focus-visible"\)\) world\.current\?\.focus\(island\.id\); \}\}/);
});

test("#37 many categories: fog follows the framing, waterfalls are fogged, crowds skip villagers", () => {
  assert.match(body(world, "const fitHome = () =>"), /weather\.setFogRange\(near, Math\.max\(palette\.fogFar, near \+ size\.z \* 1\.5 \+ 200\)\)/);
  assert.match(body(materials, "export function waterfallMaterial"), /fog: true,[\s\S]*UniformsLib\.fog[\s\S]*fog_fragment/);
  assert.match(world, /const lively = !crowded \|\| position\.radius >= 5;/);
});

test("#38 the OS motion setting is never stored as a pause", () => {
  assert.match(archipelago, /useState\(\(\) => readSetting\("skillhub-sky-paused"\) === "1"\)/);
  assert.doesNotMatch(archipelago, /useEffect\(\(\) => \{[^}]*writeSetting\("skillhub-sky-paused"/);
  assert.match(archipelago, /disabled=\{reducedMotion\}/);
});

test("#39 an urgent star-map redraw still paints while the window is unfocused", () => {
  const schedule = body(universe, "const scheduleDraw = (urgent = false) =>");
  assert.match(schedule, /if \(!canRender\(\) \|\| frame\) return;/);
  assert.match(schedule, /if \(!focused && !urgent\) return;/);
});

test("#41 low power changes the resolution at runtime", () => {
  assert.match(body(world, "const pixelRatio = () =>"), /lowPower \? 1 : 2/);
  assert.doesNotMatch(body(world, "const pixelRatio = () =>"), /options\.lowPower/);
});

test("#42 a new time of day relights the world in place", () => {
  assert.match(archipelago, /useEffect\(\(\) => \{ world\.current\?\.setDirection\(timeOfDay\); \}, \[timeOfDay\]\);/);
  assert.match(archipelago, /\}, \[stableIslands, retry, sceneOn, seed, hasSnapshot, asleep\]\);/);
});

test("#43 identical star-map content keeps the runtime, its view and selection", () => {
  assert.match(universe, /const liveModel = useMemo\(\(\) => builtModel, \[builtModelKey\]\);/);
  assert.match(universe, /rotationX: viewRef\.current\?\.rotationX \?\? -0\.12/);
  assert.match(universe, /setSelected\(model\.nodes\.find\(node => node\.id === runtime\.selectedId\) \?\? null\)/);
});

/** WCAG relative luminance contrast of two #rrggbb colours. */
function contrast(a, b) {
  const lum = hex => {
    const [r, g, bl] = [1, 3, 5].map(index => Number.parseInt(hex.slice(index, index + 2), 16) / 255)
      .map(value => (value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}

test("#44 sky theme text reaches WCAG AA 4.5:1", () => {
  for (const phase of ["dawn", "noon", "golden", "night"]) {
    // The token block (not the shared selector list at the top of the file).
    const start = theme.search(new RegExp(`\\.theme-sky-${phase} \\{\\s*--bg:`));
    assert.ok(start >= 0, `${phase} token block`);
    const block = theme.slice(start, theme.indexOf("}", start));
    const token = name => (block.match(new RegExp(`--${name}: (#[0-9a-f]{6});`, "i")) ?? [])[1];
    const fill = token("brand-fill") ?? token("brand");
    for (const surface of ["bg", "surface"]) {
      assert.ok(contrast(token("text-muted"), token(surface)) >= 4.5, `${phase}: muted text on ${surface} ${contrast(token("text-muted"), token(surface)).toFixed(2)}`);
    }
    assert.ok(contrast(token("on-brand"), fill) >= 4.5, `${phase}: on-brand on brand fill ${contrast(token("on-brand"), fill).toFixed(2)}`);
  }
  assert.match(refinements, /\.home-visual-switch button\[aria-pressed="true"\] \{ background: var\(--brand-fill, var\(--brand\)\); color: var\(--on-brand, var\(--bg\)\); \}/);
});

test("#45 #46 #47 #48 island controls, empty state and panels", () => {
  assert.match(archipelagoCss, /\.sky-controls \.sky-control-compact span:last-child \{ display: none; \}/);
  assert.doesNotMatch(archipelagoCss, /\.sky-controls button:nth-child/);
  assert.match(archipelago, /const threeD = islands\.length > 0 && status !== "off";/);
  assert.match(archipelago, /!visibleIslands\.length && query\.trim\(\) !== "" && <p>\{words\.noMatch\}<\/p>/);
  assert.match(archipelago, /setStatus\(hasSnapshot \? "empty" : "loading"\)/);
  assert.match(archipelago, /setNavigation\(value => panel === "navigation" \? !value : false\);\s*setCredits\(value => panel === "credits" \? !value : false\);\s*setWorldPanel\(value => panel === "world" \? !value : false\);/);
  assert.doesNotMatch(archipelago, /<button role="listitem"/);
  assert.match(archipelago, /<div role="listitem" key=\{island\.id\}><button type="button" className="sky-board-card"/);
});

test("memory: the island frame loop does not allocate or touch the DOM per frame", () => {
  const draw = body(world, "function draw(now: number)");
  const labels = body(world, "function placeLabels()");
  for (const [name, source] of [["draw", draw], ["placeLabels", labels]]) {
    assert.doesNotMatch(source, /new THREE\.|\.map\(|\.filter\(|\.sort\(|\[\.\.\.|\.clone\(\)|\{ \.\.\./, `${name} allocates`);
  }
  // Diagnostics go through writeStats once a second; the build time once.
  assert.doesNotMatch(draw.replace(/options\.host\.dataset\.buildMs[^\n]*/, ""), /dataset\./, "diagnostics are written by writeStats once a second");
  assert.match(draw, /if \(frames === 1 \|\| now - statsAt >= 1000\) writeStats\(now\);/);
  assert.match(draw, /if \(labelsVersion !== cameraVersion\)/, "labels are placed only when the camera moved");
  assert.doesNotMatch(body(weather, "update(time, delta, target, animating)"), /Object\.keys|\.set\("#|new THREE\./);
  assert.doesNotMatch(body(fauna, "const update = (time: number) =>"), /new THREE\./);
  assert.doesNotMatch(labelLayer, /JSON\.stringify/);
});

test("memory: GPU budget, release after upload and sleep when out of sight", () => {
  assert.match(world, /const msaa = \(window\.devicePixelRatio \|\| 1\) < 1\.5;/);
  assert.match(world, /antialias: msaa/);
  assert.match(world, /device >= 1\.5 \? 3_700_000 : 8_300_000/);
  assert.match(world, /sun\.shadow\.mapSize\.set\(1024, 1024\)/);
  assert.match(memory, /attribute\.onUpload\(dropArray\)/);
  assert.match(world, /for \(const geometry of releasable\) releaseAfterUpload\(geometry\);/);
  assert.match(effects, /releaseAfterUpload\(geometry\)/);
  assert.match(weather, /releaseAfterUpload\(particleGeo\);/);
  // Picking keeps its geometry.
  assert.doesNotMatch(world, /releaseAfterUpload\(pickGeometry\)/);
  assert.match(archipelago, /return override > 0 \? override : 15_000;/);
  assert.match(scene, /export const APP_HIDDEN_EVENT = "skillhub-app-hidden";/);
  assert.match(scene, /export const APP_VISIBLE_EVENTS = \["skillhub-app-visible", "skillhub-app-shown"\] as const;/);
  for (const source of [archipelago, universe]) {
    assert.match(source, /addEventListener\(APP_HIDDEN_EVENT, /);
    assert.match(source, /for \(const name of APP_VISIBLE_EVENTS\) window\.addEventListener\(name, /);
  }
  // The shell's background event (unfocused for a while) sleeps the world too.
  assert.match(scene, /export const APP_BACKGROUND_EVENT = "skillhub-app-background";/);
  assert.match(archipelago, /window\.addEventListener\(APP_BACKGROUND_EVENT, onBackground\);/);
  assert.match(archipelago, /const awake = visible && !pageHidden && !appHidden && !appBackground;/);
  assert.match(archipelago, /onFirstFrame: clearStill/);
  // The world goes only once its still is decoded; a wake first cancels the
  // sleep, so a late still can never cover a live world.
  const sleep = body(archipelago, "  useEffect(() => {\n    if (awake || asleep) return;");
  assert.match(sleep, /if \(cancelled\) return;/);
  assert.match(sleep, /image\.decode\(\)\.then\(swap, swap\);/);
  assert.ok(sleep.indexOf("setStill(url);") < sleep.indexOf("setAsleep(true);\n        };"), "the still is up before the world is released");
  assert.match(body(world, "    dispose() {"), /renderer\.forceContextLoss\(\);/);
  assert.match(body(world, "    dispose() {"), /releaseShared\(\);/);
  assert.match(assets, /export function releaseSharedGpuListeners\(\)/);
  assert.match(universe, /backdropScale = Math\.max\(0\.5, dpr \/ 2\);/);
  assert.match(universe, /releaseTimer = window\.setTimeout\(releaseCanvases, 15_000\);/);
});

test("framing: overlay blocks opt in with data-sky-overlay and shift the view down", () => {
  assert.match(world, /querySelectorAll\("\[data-sky-overlay\], \.home-top"\)/);
  assert.match(universe, /\[data-sky-overlay\], \.home-top"\)/, "star-map labels keep clear of the same blocks");
  assert.match(body(world, "const fitHome = () =>"), /camera\.setViewOffset\(width, height, -safeLeft \/ 2, -band\.shift, width, height\);/);
  assert.match(body(world, "const frameBand = () =>"), /const minimum = height \* 0\.3;/);
});

test("climate and weather controls: one compact world panel", () => {
  assert.match(archipelago, /className="sky-world-panel" id=\{worldPanelId\} role="dialog"/);
  assert.match(archipelago, /const WEATHER_OPTIONS: Array<"auto" \| SkyWeatherKind> = \["auto", \.\.\.SKY_WEATHER_KINDS\];/);
  // v3.3.1: weathers combine, so the chips are toggle buttons in a group: one tab stop,
  // arrow keys move, Home/End jump, Space/Enter press; the hint says how they combine.
  assert.match(archipelago, /role="group" aria-labelledby=\{`\$\{worldPanelId\}-weather`\} aria-describedby=\{`\$\{worldPanelId\}-weather-hint`\} onKeyDown=\{onWeatherKey\}/);
  assert.match(archipelago, /aria-pressed=\{weatherPressed\(kind\)\} tabIndex=\{kind === weatherTabStop \? 0 : -1\}/);
  assert.match(body(archipelago, "const onWeatherKey = "), /ArrowRight[\s\S]*ArrowLeft[\s\S]*Home[\s\S]*End/);
  assert.match(archipelago, /const next = toggleWeather\(weatherSetting, chip\);/);
  assert.match(archipelago, /aria-controls=\{worldPanel \? worldPanelId : undefined\}/);
  // Hovering an island names its climate in a tag above its label.
  assert.match(archipelago, /className="sky-island-climate" aria-hidden="true"/);
  assert.match(archipelagoCss, /\.sky-island-label\.is-hovered \.sky-island-climate/);
  assert.match(archipelago, /className="sky-reroll" onClick=\{reroll\}/);
  assert.match(archipelago, /className="sky-climate-legend"/);
  assert.match(archipelago, /title=\{climate \? `\$\{island\.name\} · \$\{climate\}` : island\.name\}/);
  // Weather is shader-driven and small: at most two extra draw calls.
  assert.match(weather, /drawCalls: \(\) => \(particles\.visible \? 1 : 0\) \+ \(deck\.visible \? 1 : 0\)/);
  assert.match(weather, /if \(precipitation === "storm" && animating && !options\.reducedMotion\(\)\)/);
});

test("memory: each character draws once; star-map colours and labels allocate nothing per call", () => {
  // Villager (10 parts) and animals (2-3 parts) merge into one skinned mesh
  // each, colours baked into vertex colours: fewer draws, skeleton updates
  // and bone textures.
  assert.match(assets, /mergeSkinnedParts\(villager, \(\) => new THREE\.MeshToonMaterial\(\{[^}]*vertexColors: true/);
  assert.match(assets, /mergeSkinnedParts\(gltf, \(\) => new THREE\.MeshStandardMaterial\(\{[^}]*vertexColors: true/);
  assert.match(body(assets, "function sameSkin("), /boneInverses/);
  // Fixed-arity colour lookups: no rest arrays or closures per node per frame.
  assert.doesNotMatch(universe, /\(\.\.\.args: A\)/);
  assert.match(universe, /return nodes\.get\(id\) \?\? rememberColour\(nodes, id, /);
  assert.match(universe, /meteorSegment\(meteor, progress, width, height, METEOR_SCRATCH\)/);
  assert.match(body(labelLayer, "  end() {"), /for \(const view of this\.views\.values\(\)\)/);
  // The first flash of a storm is timed from the scene clock.
  assert.match(weather, /nextFlash = sceneTime \+ 2 \+ flashRandom\(\) \* 4;/);
});
