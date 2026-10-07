// countSkills() is the single counting rule (skills contract §4.6, invariant I-11).
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const ts = require("typescript");

const exportsObject = {};
const compiled = ts.transpileModule(fs.readFileSync(path.join(__dirname, "../src/skillCounts.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 }
}).outputText;
vm.runInNewContext(compiled, { exports: exportsObject, require: request => { throw new Error(`skillCounts.ts must stay import-free (${request})`); } });
const { countSkills, buildLibraryRows, isCallableSkill, rowFilterState } = exportsObject;

const source = (id, extra = {}) => ({ id, name: id, url: "", sourceType: "skill", enabled: true, ...extra });
const skill = (id, extra = {}) => ({ id, name: id, folderName: id, description: "", relativePath: `skills/${id}`, enabled: true, source: "", tags: [], ...extra });

const library = () => ({
  sources: [
    source("single", { name: "VibeSec-Skill" }),
    source("pack", { name: "Nature", userFolderId: "paper" }),
    source("notes", { name: "Prompts", sourceType: "prompt" })
  ],
  skills: [
    // A one-skill repo whose SKILL.md sits at the root looks like a router by name; it still counts (bug #40).
    skill("VibeSec-Skill", { sourceId: "single", source: "VibeSec-Skill" }),
    skill("Nature", { sourceId: "pack", source: "Nature", isRouterHub: true }),
    skill("child-a", { sourceId: "pack", source: "Nature" }),
    skill("child-b", { sourceId: "pack", source: "Nature", enabled: false }),
    skill("standalone-1"),
    skill("standalone-router", { isRouterHub: true })
  ],
  skillFolders: [{ id: "paper", name: "Paper", sortOrder: 0 }]
});

test("a single-skill pack counts 1 and a multi-skill pack excludes its router", () => {
  assert.equal(isCallableSkill(skill("x", { isRouterHub: true }), 1), true);
  assert.equal(isCallableSkill(skill("x", { isRouterHub: true }), 3), false);
  assert.equal(isCallableSkill(skill("x"), 0), true);
  assert.equal(isCallableSkill(skill("x", { isRouterHub: true }), 0), false);
  const counts = countSkills(library());
  assert.equal(counts.skills, 4, "VibeSec + child-a + child-b + standalone-1");
  assert.equal(counts.enabledSkills, 3);
  assert.equal(counts.packs, 2);
  assert.equal(counts.promptPacks, 1);
  assert.equal(counts.standaloneSkills, 1);
});

test("rows = packs + promptPacks + standaloneSkills", () => {
  const counts = countSkills(library());
  assert.equal(counts.rows, counts.packs + counts.promptPacks + counts.standaloneSkills + counts.emptyPacks);
  assert.equal(counts.rows, buildLibraryRows(library()).length);
});

test("a folder scope counts only what is filed there (child override first, then the pack)", () => {
  const data = library();
  assert.equal(countSkills(data, { folderId: "paper" }).skills, 2);
  assert.equal(countSkills(data, { folderId: "unfiled" }).skills, 2);
  assert.equal(countSkills(data, { folderId: "all" }).skills, countSkills(data).skills);
  data.skills[2].userFolderId = "elsewhere-deleted";
  assert.equal(countSkills(data, { folderId: "paper" }).skills, 2, "an unknown folder id falls back to the pack folder");
});

test("rows are derived once per snapshot object", () => {
  const data = library();
  assert.equal(buildLibraryRows(data), buildLibraryRows(data));
  assert.notEqual(buildLibraryRows(data), buildLibraryRows(library()));
});

test("rowFilterState follows the §4.6 truth table", () => {
  const unit = (reason = "") => ({ unitId: "u", libraryOnlyReason: reason });
  const row = (targets, extra = {}) => ({ unit: unit(), targets, source: { health: "ok" }, governance: null, ...extra });
  assert.deepEqual({ ...rowFilterState(row([{ status: "synced" }, { status: "off" }])) }, { synced: true, unsynced: false, update: false, problem: false });
  assert.deepEqual({ ...rowFilterState(row([{ status: "off" }])) }, { synced: false, unsynced: true, update: false, problem: false });
  for (const status of ["error", "conflict", "orphan"]) assert.equal(rowFilterState(row([{ status }])).problem, true, status);
  assert.equal(rowFilterState(row([], { source: { health: "error" } })).problem, true);
  assert.equal(rowFilterState(row([], { unit: unit("security-review") })).problem, true);
  assert.equal(rowFilterState(row([], { unit: unit("invalid-manifest") })).problem, true);
  assert.equal(rowFilterState(row([], { governance: { relation: "up-to-date", status: "fetch-failed" } })).problem, true);
  assert.equal(rowFilterState(row([], { governance: { relation: "update-available", status: "ready" } })).update, true);
  assert.equal(rowFilterState(row([], { unit: unit("prompt-only") })).unsynced, false);
  assert.equal(rowFilterState(row([], { unit: null })).unsynced, false);
});

test("delivery targets feed synced / unsynced / problem counts", () => {
  const data = library();
  data.skillDelivery = {
    units: [
      { unitId: "single", libraryOnlyReason: "" },
      { unitId: "pack", libraryOnlyReason: "" },
      { unitId: "standalone:standalone-1", libraryOnlyReason: "" },
      { unitId: "notes", libraryOnlyReason: "prompt-only" }
    ],
    targets: [
      { unitId: "single", agentId: "claude", status: "synced" },
      { unitId: "pack", agentId: "claude", status: "conflict" }
    ]
  };
  const counts = countSkills(data);
  assert.equal(counts.syncedRows, 1);
  assert.equal(counts.unsyncedRows, 2);
  assert.equal(counts.problemRows, 1);
});
