const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const ts = require("typescript");
const exportsObject = {};
const compiled = ts.transpileModule(fs.readFileSync(path.join(__dirname, "../src/skyIslandModel.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 }
}).outputText;
vm.runInNewContext(compiled, { exports: exportsObject });
const { buildSkyIslands } = exportsObject;
const folder = (id, sortOrder = 0, name = id) => ({ id, sortOrder, name, skillCount: 999 });
const source = (id, extra = {}) => ({ id, name: id, url: "", sourceType: "skill", ...extra });
const skill = (name, extra = {}) => ({ name, source: "", relativePath: `skills/${name}`, description: "", ...extra });
const snapshot = (skillFolders = [], sources = [], skills = []) => ({ skillFolders, sources, skills });
const byId = islands => Object.fromEntries(islands.map(island => [island.id, island]));

test("empty user folders remain sorted and input counts or category names do not create islands", () => {
  assert.equal(buildSkyIslands(null, "Unfiled").length, 0);
  assert.equal(buildSkyIslands(undefined, "Unfiled").length, 0);
  const input = snapshot([folder("b", 1), folder("z", 0), folder("a", 1)]);
  const before = JSON.stringify(input);
  const islands = buildSkyIslands(input, "Unfiled");
  assert.equal(islands.map(island => island.id).join(","), "z,a,b");
  assert.ok(islands.every(island => island.weight === 0));
  assert.equal(JSON.stringify(input), before);
});

test("skills inherit old source names, explicit folders override parents and deleted folders go unfiled", () => {
  const input = snapshot([folder("a"), folder("b")], [source("s", { name: "Legacy Name", userFolderId: "a", url: "https://github.com/owner/old-repo.git" })], [
    skill("legacy", { source: " Legacy_Name " }),
    skill("legacy-url", { source: "old-repo" }),
    skill("id", { sourceId: "s", source: "renamed" }),
    skill("override", { sourceId: "s", userFolderId: "b" }),
    skill("deleted", { sourceId: "s", userFolderId: "deleted" }),
    skill("orphan", { sourceId: "gone", source: "Legacy Name" }),
    skill("standalone", { category: "Should not create an island" })
  ]);
  const islands = byId(buildSkyIslands(input, "待分类"));
  assert.equal(islands.a.skillCount, 3);
  assert.equal(islands.b.skillCount, 1);
  assert.equal(islands.unfiled.skillCount, 3);
  assert.equal(islands.unfiled.name, "待分类");
  assert.equal(islands.a.sourceCount, 1);
  assert.equal(islands.b.sourceCount, 1);
});

test("parent router hubs are excluded while explicit backend false preserves actual skills", () => {
  const skills = [
    skill("flag", { isRouterHub: true }),
    skill("description", { description: "[ROUTER-HUB] parent" }),
    skill("path", { relativePath: "sources/AI-SkillHub-local-routers/parent/SKILL.md" }),
    skill("source", { source: "AI-SkillHub-local-routers" }),
    skill("legacy-parent", { source: "source name", folderName: "source_name" }),
    skill("real", { isRouterHub: false, description: "[ROUTER-HUB] quoted reference" })
  ];
  const islands = buildSkyIslands(snapshot([], [], skills), "Unfiled");
  assert.equal(islands.length, 1);
  assert.equal(islands[0].skillCount, 1);
  assert.equal(buildSkyIslands(snapshot([], [], skills.slice(0, 5)), "Unfiled").length, 0);
});

test("Prompt and mixed sources count once as Prompt sources, separately from actual skills", () => {
  const sources = [source("p", { sourceType: "prompt", userFolderId: "a", skillCount: 99 }), source("m", { sourceType: "mixed", userFolderId: "a", skillCount: 500 })];
  const islands = byId(buildSkyIslands(snapshot([folder("a")], sources, [skill("one", { sourceId: "m" }), skill("two", { sourceId: "m" })]), "Unfiled"));
  assert.equal(islands.a.skillCount, 2);
  assert.equal(islands.a.promptCount, 2);
  assert.equal(islands.a.sourceCount, 2);
  assert.equal(islands.a.weight, 4);
});

test("all actual content survives without truncation or ambiguous owner guesses", () => {
  const sources = [source("old", { name: "same", userFolderId: "a" }), source("new", { name: "same", userFolderId: "a" }), source("prompt", { sourceType: "prompt", userFolderId: "deleted" })];
  const skills = Array.from({ length: 207 }, (_, index) => skill(`s${index}`, { source: "same" }));
  const islands = byId(buildSkyIslands(snapshot([folder("a")], sources, skills), "Unfiled"));
  assert.equal(islands.a.skillCount, 0);
  assert.equal(islands.unfiled.skillCount, 207);
  assert.equal(islands.unfiled.promptCount, 1);
  assert.equal(islands.unfiled.weight, 208);
});

test("seed and biome depend on identity, not translated names, counts or input order", () => {
  const a = buildSkyIslands(snapshot([folder("stable", 0, "中文")]), "未归档")[0];
  const b = buildSkyIslands(snapshot([folder("other"), folder("stable", 8, "English")], [], [skill("one", { userFolderId: "stable" })]), "Unfiled").find(island => island.id === "stable");
  assert.equal(a.seed, b.seed);
  assert.equal(a.biome, b.biome);
  assert.equal(a.biome, a.seed % 6);
  assert.ok(a.seed >= 0 && Number.isInteger(a.seed));
});
