// Island climates and weather: deterministic per world seed, varied, safe on
// every terrain profile, and stable for 0, 1, 2 or 30 islands. Pure modules
// only (three.js math, no WebGL).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const ts = require("typescript");
const THREE = require("three");

function load(file, modules = {}) {
  const exportsObject = {};
  const compiled = ts.transpileModule(fs.readFileSync(path.join(__dirname, "../src", file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 }
  }).outputText;
  const context = {
    exports: exportsObject,
    require: name => modules[name] ?? (() => { throw new Error(`unexpected import ${name} in ${file}`); })(),
    Math, Date, Number, String, Array, Object, Intl, Map, Set, JSON, Uint32Array, Float32Array
  };
  vm.runInNewContext(compiled, context);
  return exportsObject;
}

const noise = load("sky/noise.ts");
const climates = load("sky/climates.ts", { "./noise": noise });
const terrain = load("sky/terrain.ts", { three: THREE, "./noise": noise });
const biomes = load("sky/biomes.ts", { "./terrain": terrain, "./noise": noise });
const layout = load("sky/layout.ts", { "./noise": noise });
const weatherPlan = load("sky/weatherPlan.ts", { "./noise": noise });
const scene = load("skyScene.ts");
// Island counts use the shared counting rule (skillCounts.ts, from the v3.3
// Skills track) once both lines are merged; without it the model stands alone.
const hasSharedCounts = fs.existsSync(path.join(__dirname, "../src/skillCounts.ts"));
const model = load("skyIslandModel.ts", hasSharedCounts ? { "./skillCounts": load("skillCounts.ts") } : {});
const i18n = load("sky/skyI18n.ts");

const { CLIMATES, CLIMATE_IDS, assignClimates, layoutNeighbours, climateCounts } = climates;
const view = { pitch: 22, heightSpread: 4.5, aspect: 2.6 };
const real = [
  { id: "f01", name: "01文献调研、idea类", weight: 186 },
  { id: "f02", name: "02实操跑代码类", weight: 64 },
  { id: "f03", name: "03paper写作类", weight: 262 },
  { id: "f04", name: "04科研绘图类", weight: 121 },
  { id: "f05", name: "05学术报告/前端UI", weight: 214 },
  { id: "f06", name: "其它工具", weight: 37 },
  { id: "unfiled", name: "未归档", weight: 33 }
];
const many = count => Array.from({ length: count }, (_, index) => ({ id: `cat-${index}`, name: `分类 ${index}`, weight: (index * 37) % 41 }));
const plain = map => JSON.stringify([...map]);
const world = (items, seed) => assignClimates(items, seed, layoutNeighbours(layout.layoutIslands(items, view)));

test("climate assignment is deterministic for a world seed", () => {
  for (const seed of [0, 1, 42, 4294967295]) {
    assert.equal(plain(world(real, seed)), plain(world(real.map(item => ({ ...item })), seed)));
    assert.equal(plain(assignClimates(real, seed)), plain(assignClimates(real, seed)));
  }
  for (const value of world(real, 7).values()) assert.ok(CLIMATE_IDS.includes(value));
});

test("three or more islands always show at least three climates", () => {
  for (let count = 3; count <= 12; count++) {
    for (let seed = 0; seed < 120; seed++) {
      const assigned = world(many(count), seed * 2654435761 >>> 0);
      assert.ok(new Set(assigned.values()).size >= 3, `${count} islands, seed ${seed}`);
    }
  }
  for (let seed = 0; seed < 60; seed++) assert.ok(new Set(world(real, seed).values()).size >= 3);
});

test("re-rolling the world changes the climates", () => {
  let changed = 0, total = 0;
  for (let seed = 1; seed <= 40; seed++) {
    for (const items of [real, many(5), many(12)]) {
      total++;
      if (plain(world(items, seed)) !== plain(world(items, seed + 1))) changed++;
    }
  }
  assert.ok(changed / total > 0.95, `${changed}/${total} re-rolls changed the world`);
  // Twelve islands over a handful of seeds visit every climate.
  const seen = new Set();
  for (let seed = 0; seed < 6; seed++) for (const value of world(many(12), seed).values()) seen.add(value);
  assert.equal(seen.size, CLIMATE_IDS.length);
});

test("neighbours avoid sharing a climate and the unfiled island stays calm", () => {
  for (let seed = 0; seed < 80; seed++) {
    const items = many(8).concat([{ id: "unfiled", name: "未归档", weight: 12 }]);
    const placed = layout.layoutIslands(items, view);
    const neighbours = layoutNeighbours(placed);
    const assigned = assignClimates(items, seed, neighbours);
    assert.ok(["temperate", "autumn"].includes(assigned.get("unfiled")), `seed ${seed}: ${assigned.get("unfiled")}`);
    let clashes = 0;
    for (const [id, near] of neighbours) for (const other of near) if (assigned.get(id) === assigned.get(other)) clashes++;
    assert.equal(clashes, 0, `seed ${seed}: neighbouring islands share a climate`);
  }
});

test("keyword hints bias the climate but the seed still decides", () => {
  const security = [{ id: "sec", name: "安全审计", weight: 10 }, { id: "a", name: "A", weight: 3 }, { id: "b", name: "B", weight: 3 }];
  const picks = new Map();
  for (let seed = 0; seed < 200; seed++) {
    const value = assignClimates(security, seed).get("sec");
    picks.set(value, (picks.get(value) ?? 0) + 1);
  }
  const volcanic = picks.get("volcanic") ?? 0;
  assert.ok(volcanic > 200 / CLIMATE_IDS.length * 1.5, `hinted climate wins more often (${volcanic}/200)`);
  assert.ok(picks.size >= 3, "other climates still appear");
});

test("every climate profile keeps heightAt finite and objects on the ground", () => {
  for (const id of CLIMATE_IDS) {
    const spec = CLIMATES[id];
    for (const radius of [3.4, 4.6, 7.5, 10.5]) {
      for (const seed of [1, 977, 123456789]) {
        const plan = biomes.planIsland(radius, seed, "scholar", spec);
        assert.equal(plan.climate, id);
        const shape = plan.shape;
        for (let x = -radius * 1.2; x <= radius * 1.2; x += radius / 9) {
          for (let z = -radius * 1.2; z <= radius * 1.2; z += radius / 9) {
            const height = shape.heightAt(x, z);
            assert.ok(Number.isFinite(height), `${id} r${radius} s${seed} heightAt(${x}, ${z})`);
            assert.ok(Math.abs(height) < radius * 2.5, `${id} height stays sane: ${height}`);
          }
        }
        const geometry = shape.buildGeometry(0.7);
        const positions = geometry.getAttribute("position").array;
        assert.ok(positions.every(Number.isFinite), `${id} mesh positions are finite`);
        assert.ok(geometry.getAttribute("aRim").array.every(value => value >= 0 && value <= 1));
        const top = new THREE.Box3().setFromBufferAttribute(geometry.getAttribute("position"));
        for (const placement of plan.placements) {
          const ground = shape.heightAt(placement.x, placement.z);
          assert.ok(Number.isFinite(ground) && Number.isFinite(placement.yaw) && Number.isFinite(placement.height ?? placement.scale));
          assert.ok(shape.normalizedDistance(placement.x, placement.z) < 1, `${id}: ${placement.model} stays on the island`);
          // The mesh samples the same function; between its vertices a
          // sharp summit may rise a little above the nearest one.
          assert.ok(ground <= top.max.y + radius * 0.06 && ground >= top.min.y, `${id}: ${placement.model} at ${ground} within ${top.min.y}..${top.max.y}`);
        }
        for (const building of plan.buildings) {
          assert.ok(Number.isFinite(shape.heightAt(building.x, building.z)));
          assert.ok(shape.featureWeight(building.x, building.z) < 0.35, `${id}: building kept off the peak`);
        }
        if (plan.crater) assert.ok([plan.crater.x, plan.crater.y, plan.crater.z, plan.crater.radius].every(Number.isFinite));
        for (const vent of plan.vents) assert.ok(vent.every(Number.isFinite));
        geometry.dispose();
      }
    }
  }
});

test("a profile reshapes the top: peaks rise, mesas stay flat, terraces step", () => {
  const radius = 9, seed = 4242;
  const span = profile => {
    const shape = new terrain.IslandShape(radius, seed, profile);
    const heights = [];
    for (let x = -radius * 0.6; x <= radius * 0.6; x += 0.3) for (let z = -radius * 0.6; z <= radius * 0.6; z += 0.3) heights.push(shape.heightAt(x, z));
    return { shape, range: Math.max(...heights) - Math.min(...heights), heights };
  };
  const rolling = span("rolling"), peak = span("peak"), mesa = span("mesa"), crater = span("crater"), terraces = span("terraces");
  assert.ok(peak.range > rolling.range * 2, "a snowy peak towers over rolling hills");
  assert.ok(crater.range > rolling.range * 1.5, "a volcano rises too");
  assert.ok(mesa.range < rolling.range, "a mesa top is flatter");
  assert.ok(mesa.shape.cliff > rolling.shape.cliff, "a mesa has a taller cliff");
  // Terraces: most samples sit on a few flat levels.
  const levels = new Map();
  for (const height of terraces.heights) {
    const key = Math.round(height * 20);
    levels.set(key, (levels.get(key) ?? 0) + 1);
  }
  const top = [...levels.values()].sort((a, b) => b - a).slice(0, 6).reduce((sum, value) => sum + value, 0);
  assert.ok(top / terraces.heights.length > 0.5, "terraces are flat rings");
  const lava = crater.shape.craterLava();
  assert.ok(lava && lava.radius > 0 && lava.y < crater.shape.summit(), "the lava lake sits inside the crater");
  // A rolling island has no feature and keeps its old shape function.
  assert.equal(rolling.shape.feature, null);
  assert.equal(new terrain.IslandShape(radius, seed).heightAt(1.3, -2.1), rolling.shape.heightAt(1.3, -2.1));
});

test("a temperate plan is the theme's plan, unchanged", () => {
  for (const theme of ["scholar", "observatory", "workshop", "orchard", "garden", "meadow"]) {
    const before = biomes.planIsland(8, 31337, theme);
    const after = biomes.planIsland(8, 31337, theme, CLIMATES.temperate);
    assert.equal(JSON.stringify(after.placements), JSON.stringify(before.placements));
    assert.equal(JSON.stringify(after.buildings), JSON.stringify(before.buildings));
    assert.equal(after.water, "water");
  }
});

test("climates bring their own plants and water", () => {
  const plan = id => biomes.planIsland(9, 2024, "garden", CLIMATES[id]);
  const models = id => new Set(plan(id).placements.map(item => item.model.replace(/-\d+$/, "")));
  assert.ok(models("alpine").has("snowpine"));
  assert.ok(models("desert").has("cactus"));
  assert.ok(models("tropical").has("palm"));
  assert.ok(models("crystal").has("crystal"));
  assert.ok(models("volcanic").has("deadtree"));
  assert.ok(models("terraced").has("rice"));
  assert.equal(plan("alpine").water, "ice");
  assert.equal(plan("alpine").waterfall, null);
  assert.equal(plan("volcanic").water, "lava");
  assert.ok(plan("volcanic").vents.length >= 1);
  assert.ok(plan("crystal").placements.some(item => item.lift > 0), "crystal islands have floating shards");
});

test("layouts and climates stay finite for 0, 1, 2 and 30 islands", () => {
  for (const count of [0, 1, 2, 30]) {
    const items = many(count);
    const placed = layout.layoutIslands(items, view);
    assert.equal(placed.length, count);
    for (const island of placed) assert.ok([island.x, island.y, island.z, island.radius].every(Number.isFinite), `${count} islands`);
    const assigned = assignClimates(items, 99, layoutNeighbours(placed));
    assert.equal(assigned.size, count);
    if (count >= 3) assert.ok(new Set(assigned.values()).size >= 3);
    assert.equal(climateCounts(assigned).reduce((sum, [, n]) => sum + n, 0), count);
  }
  // All weights zero still lay out.
  const flat = layout.layoutIslands([{ id: "a", weight: 0 }, { id: "b", weight: 0 }], view);
  assert.ok(flat.every(island => Number.isFinite(island.x) && island.radius > 0));
});

test("auto weather is deterministic for a seed, date and time of day", () => {
  const date = new Date(2026, 9, 7, 14, 30);
  for (const phase of ["dawn", "noon", "golden", "night"]) {
    for (const seed of [1, 2, 3, 99999]) {
      const first = weatherPlan.autoWeather(seed, date, phase, ["temperate", "alpine"]);
      assert.equal(weatherPlan.autoWeather(seed, new Date(date), phase, ["temperate", "alpine"]), first);
      assert.ok(scene.SKY_WEATHER_KINDS.includes(first));
      if (phase !== "night") assert.notEqual(first, "aurora");
    }
  }
  // Varied across days and seeds, and a re-roll can change it.
  const kinds = new Set();
  for (let day = 1; day <= 40; day++) kinds.add(weatherPlan.autoWeather(7, new Date(2026, 0, day, 12), "noon"));
  assert.ok(kinds.size >= 4, [...kinds].join(","));
  // Night after midnight keeps the evening's weather.
  assert.equal(weatherPlan.weatherDateKey(new Date(2026, 9, 8, 2), "night"), weatherPlan.weatherDateKey(new Date(2026, 9, 7, 21), "night"));
  assert.equal(weatherPlan.autoWeather(5, new Date(2026, 9, 8, 2), "night"), weatherPlan.autoWeather(5, new Date(2026, 9, 7, 21), "night"));
});

test("auto weather follows the climates and the hour", () => {
  let snowy = 0, plainSnow = 0, desertStorms = 0, nightAurora = 0;
  for (let seed = 0; seed < 400; seed++) {
    const date = new Date(2026, 2, 1 + (seed % 28), 22);
    if (weatherPlan.autoWeather(seed, date, "night", ["alpine", "alpine", "temperate"]) === "snow") snowy++;
    if (weatherPlan.autoWeather(seed, date, "night", ["temperate", "autumn", "temperate"]) === "snow") plainSnow++;
    const kind = weatherPlan.autoWeather(seed, date, "noon", ["desert", "desert", "tropical"]);
    if (kind === "storm") desertStorms++;
    if (weatherPlan.autoWeather(seed, date, "night") === "aurora") nightAurora++;
  }
  assert.ok(snowy > plainSnow, "alpine-heavy worlds favour snow");
  assert.equal(desertStorms, 0, "desert-heavy worlds never storm");
  assert.ok(nightAurora > 40, "aurora shows up at night");
  assert.equal(weatherPlan.resolveWeather("aurora", 1, new Date(), "noon"), "clear");
  assert.equal(weatherPlan.resolveWeather("rain", 1, new Date(), "noon"), "rain");
});

test("the world seed follows the ISO week until re-rolled", () => {
  assert.equal(scene.isoWeekKey(new Date(2026, 9, 7)), "2026-W41");
  assert.equal(scene.isoWeekKey(new Date(2021, 0, 3)), "2020-W53");
  assert.equal(scene.isoWeekKey(new Date(2024, 11, 30)), "2025-W01");
  assert.equal(scene.worldSeed(new Date(2026, 9, 5)), scene.worldSeed(new Date(2026, 9, 11)));
  assert.notEqual(scene.worldSeed(new Date(2026, 9, 5)), scene.worldSeed(new Date(2026, 9, 12)));
  assert.equal(scene.skyWeatherSetting(), "auto");
});

test("island counts include single-skill repositories but not parent routers", { skip: hasSharedCounts ? false : "bug #40 is fixed by the shared skillCounts.ts rule (v33/skills-frontend); runs once merged" }, () => {
  const snapshot = {
    skillFolders: [{ id: "ui", name: "软件与 UI", sortOrder: 0 }],
    sources: [
      { id: "single", name: "impeccable", url: "https://github.com/x/impeccable", sourceType: "skill", userFolderId: "ui" },
      { id: "multi", name: "bundle", url: "https://github.com/x/bundle", sourceType: "skill", userFolderId: "ui" }
    ],
    skills: [
      { name: "impeccable", source: "impeccable", folderName: "impeccable", sourceId: "single", relativePath: "x", description: "", isRouterHub: true },
      { name: "bundle", source: "bundle", folderName: "bundle", sourceId: "multi", relativePath: "y", description: "", isRouterHub: true },
      { name: "one", source: "bundle", sourceId: "multi", relativePath: "y/one", description: "" },
      { name: "two", source: "bundle", sourceId: "multi", relativePath: "y/two", description: "" },
      { name: "loose", source: "gstack", folderName: "gstack", relativePath: "z", description: "", isRouterHub: true }
    ]
  };
  const islands = Object.fromEntries(model.buildSkyIslands(snapshot, "Unfiled").map(island => [island.id, island]));
  assert.equal(islands.ui.skillCount, 3, "single-skill repo counted, multi-skill router excluded");
});

test("demo islands are a development preview only", () => {
  const demo = model.demoSkyIslands(12);
  assert.equal(demo.length, 12);
  assert.ok(demo.every(island => island.weight > 0 && island.id.startsWith("demo-island-")));
  assert.equal(model.demoSkyIslands(0).length, 0);
  const archipelago = fs.readFileSync(path.join(__dirname, "../src/SkillArchipelago.tsx"), "utf8");
  assert.match(archipelago, /if \(!import\.meta\.env\.DEV\) return 0;/, "demo islands never show in a release build");
});

test("English labels use singular and plural forms", () => {
  const en = i18n.skyWords("en");
  assert.equal(en.skills(1), "1 skill");
  assert.equal(en.skills(2), "2 skills");
  assert.equal(en.prompts(1), "1 prompt source");
  assert.equal(en.summary(1, 1), "1 category · 1 skill");
  assert.equal(en.summary(5, 4), "5 categories · 4 skills");
  for (const lang of ["zh", "en", "ko"]) {
    const words = i18n.skyWords(lang);
    for (const id of CLIMATE_IDS) assert.ok(words.climateNames[id], `${lang} names ${id}`);
    for (const kind of scene.SKY_WEATHER_KINDS) assert.ok(words.weathers[kind], `${lang} names ${kind}`);
  }
});

test("Chinese and Korean island text does not mix in English words", () => {
  const latin = /[A-Za-z]{2,}/;
  for (const lang of ["zh", "ko"]) {
    const words = i18n.skyWords(lang);
    const samples = [
      words.skills(13), words.prompts(2), words.categories(5), words.summary(5, 13), words.basis, words.empty, words.emptyHint,
      words.addSource, words.openLibrary, words.world, words.worldTitle, words.weather, words.auto, words.reroll, words.climates,
      ...Object.values(words.weathers), ...Object.values(words.climateNames)
    ];
    for (const text of samples) assert.doesNotMatch(text, latin, `${lang}: "${text}"`);
  }
  assert.equal(i18n.skyWords("zh").skills(13), "13 个技能");
  assert.equal(i18n.skyWords("zh").prompts(1), "1 个提示词来源");
  assert.equal(i18n.skyWords("ko").skills(13), "스킬 13개");
  // Every language has the same keys.
  const keys = lang => Object.keys(i18n.skyWords(lang)).sort().join(",");
  assert.equal(keys("en"), keys("zh"));
  assert.equal(keys("ko"), keys("zh"));
});

test("the empty state offers adding a source, and falls back to the library", () => {
  const archipelago = fs.readFileSync(path.join(__dirname, "../src/SkillArchipelago.tsx"), "utf8");
  assert.match(archipelago, /onAdd\?: \(\) => void;/);
  assert.match(archipelago, /onClick=\{\(\) => \(onAdd \? onAdd\(\) : open\("all"\)\)\}>\{onAdd \? sky\.addSource : sky\.openLibrary\}/);
  assert.equal(i18n.skyWords("zh").addSource, "+ 添加");
  assert.doesNotMatch(archipelago, /创建分类/);
});
