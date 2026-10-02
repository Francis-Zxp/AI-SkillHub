// Sky world layout and theme rules: deterministic placement, area grows with
// content, no two islands touch, and neighbouring categories get distinct
// designed themes. Pure modules only (no WebGL).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const ts = require("typescript");

function load(file, modules = {}) {
  const exportsObject = {};
  const compiled = ts.transpileModule(fs.readFileSync(path.join(__dirname, "../src/sky", file), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 }
  }).outputText;
  vm.runInNewContext(compiled, { exports: exportsObject, require: name => modules[name] ?? (() => { throw new Error(`unexpected import ${name}`); })(), Math });
  return exportsObject;
}

const noise = load("noise.ts");
const { layoutIslands, islandRadius, MIN_ISLAND_RADIUS, MAX_ISLAND_RADIUS } = load("layout.ts", { "./noise": noise });
const { assignThemes } = load("biomes.ts", { "./noise": noise, "./terrain": { IslandShape: class {} } });
const view = { pitch: 20, heightSpread: 4.5, aspect: 2.6 };
const real = [
  { id: "f01", name: "01文献调研、idea类", weight: 186 },
  { id: "f02", name: "02实操跑代码类", weight: 64 },
  { id: "f03", name: "03paper写作类", weight: 262 },
  { id: "f04", name: "04科研绘图类", weight: 121 },
  { id: "f05", name: "05学术报告/前端UI", weight: 214 },
  { id: "f06", name: "其它工具", weight: 37 },
  { id: "unfiled", name: "未归档", weight: 33 }
];

test("island area grows with content and empty categories keep a clickable size", () => {
  assert.equal(islandRadius(0, 262), MIN_ISLAND_RADIUS);
  assert.equal(islandRadius(262, 262), MAX_ISLAND_RADIUS);
  const radii = [0, 1, 33, 64, 121, 186, 262].map(weight => islandRadius(weight, 262));
  for (let index = 1; index < radii.length; index++) assert.ok(radii[index] > radii[index - 1]);
  assert.equal(islandRadius(5, 0), MIN_ISLAND_RADIUS);
});

test("layout is deterministic and keeps input order in its result", () => {
  const first = layoutIslands(real, view);
  const second = layoutIslands(real.map(item => ({ ...item })), view);
  // Results come from another VM realm, so compare their JSON.
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.equal(JSON.stringify(first.map(island => island.id)), JSON.stringify(real.map(item => item.id)));
});

test("no two islands touch, for few, real and many categories", () => {
  const many = Array.from({ length: 40 }, (_, index) => ({ id: `m${index}`, weight: Math.round(Math.abs(Math.sin(index * 1.7)) * 200) }));
  const few = [{ id: "a", weight: 3 }, { id: "b", weight: 0 }, { id: "c", weight: 0 }];
  for (const items of [few, real, many]) {
    const started = performance.now();
    const placed = layoutIslands(items, view);
    assert.ok(performance.now() - started < 2000, "layout must stay fast");
    for (let a = 0; a < placed.length; a++) {
      for (let b = a + 1; b < placed.length; b++) {
        const distance = Math.hypot(placed[a].x - placed[b].x, placed[a].z - placed[b].z);
        assert.ok(distance >= (placed[a].radius + placed[b].radius) * 1.08, `${placed[a].id} touches ${placed[b].id}`);
      }
    }
  }
});

test("the archipelago is wider than deep on screen", () => {
  const placed = layoutIslands(real, view);
  const sin = Math.sin((view.pitch * Math.PI) / 180), cos = Math.cos((view.pitch * Math.PI) / 180);
  const xs = placed.flatMap(island => [island.x - island.radius, island.x + island.radius]);
  const vs = placed.flatMap(island => [island.z * sin - island.y * cos - island.radius, island.z * sin - island.y * cos + island.radius]);
  assert.ok(Math.max(...xs) - Math.min(...xs) > (Math.max(...vs) - Math.min(...vs)) * 1.4);
});

test("real categories get distinct designed themes", () => {
  const themes = assignThemes(real);
  const firstSix = real.slice(0, 6).map(item => themes.get(item.id));
  assert.equal(new Set(firstSix).size, 6);
  assert.equal(themes.get("f03"), "scholar");
  assert.equal(themes.get("f01"), "observatory");
  assert.equal(themes.get("f02"), "workshop");
  assert.equal(JSON.stringify([...assignThemes(real)]), JSON.stringify([...themes]));
});
