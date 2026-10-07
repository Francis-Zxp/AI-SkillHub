// Folder navigation and library rows (v3.3). The library list, the folder chips and the
// islands all derive from src/skillCounts.ts (invariant I-11), so these checks run the real
// module instead of slices of a page component.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";
import { readAppSource } from "./app-source.mjs";

const transpile = text => ts.transpileModule(text, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 }
}).outputText;
const asModuleUrl = javascript => `data:text/javascript,${encodeURIComponent(javascript)}`;

const countsUrl = asModuleUrl(transpile(await readFile(new URL("../src/skillCounts.ts", import.meta.url), "utf8")));
const counts = await import(countsUrl);
const modelText = transpile(await readFile(new URL("../src/skyIslandModel.ts", import.meta.url), "utf8"))
  .replace(/from\s+["']\.\/skillCounts["']/g, `from ${JSON.stringify(countsUrl)}`);
const model = await import(asModuleUrl(modelText));
const app = (await readAppSource()).replace(/\r\n/g, "\n");

const source = { id: "repo", name: "owner-repo", url: "", userFolderId: "research", sourceType: "skill", enabled: true };
const skill = (id, extra) => ({ id, name: id, folderName: id, description: "", relativePath: `skills/${id}`, enabled: true, tags: [], ...extra });
const skills = [
  skill("inherited", { sourceId: "repo", userFolderId: "", isRouterHub: false }),
  skill("override", { sourceId: "repo", userFolderId: "writing", isRouterHub: false }),
  skill("router", { sourceId: "repo", userFolderId: "writing", isRouterHub: true }),
  skill("legacy", { source: "owner_repo", userFolderId: "writing", isRouterHub: false }),
  skill("local", { source: "standalone", userFolderId: "", isRouterHub: false })
];
const skillFolders = [{ id: "research", name: "research", sortOrder: 0, skillCount: 999 }, { id: "writing", name: "writing", sortOrder: 1, skillCount: 999 }];
const snapshot = { sources: [source], skills, skillFolders };

test("folder filtering honors a child override before source inheritance", () => {
  const rows = counts.buildLibraryRows(snapshot);
  const repo = rows.find(row => row.key === "repo");
  assert.deepEqual(counts.rowSkillsInFolder(repo, "research").map(item => item.id), ["inherited"]);
  assert.deepEqual(counts.rowSkillsInFolder(repo, "writing").map(item => item.id), ["override", "legacy"]);
  assert.deepEqual(counts.rowSkillsInFolder(repo, "all").map(item => item.id), ["inherited", "override", "legacy"]);
  // Stored folder counts are ignored and parent routers never count.
  const perFolder = ["research", "writing", "unfiled"].map(folderId => [folderId, counts.countSkills(snapshot, { folderId }).skills]);
  assert.deepEqual(perFolder, [["research", 1], ["writing", 2], ["unfiled", 1]]);
});

test("a folder shows the pack of a child override and only the matching children", () => {
  const rows = counts.buildLibraryRows(snapshot).filter(row => counts.rowInFolder(row, "writing"));
  assert.deepEqual(rows.map(row => row.key), ["repo"]);
  assert.ok(counts.rowInFolder(counts.buildLibraryRows(snapshot).find(row => row.key === "repo"), "research"));
});

test("legacy named pack children do not appear a second time as standalone skills", () => {
  const rows = counts.buildLibraryRows(snapshot);
  const standalone = folderId => rows.filter(row => row.kind === "standalone" && counts.rowInFolder(row, folderId)).map(row => row.skill.id);
  assert.deepEqual(standalone("writing"), []);
  assert.deepEqual(standalone("unfiled"), ["local"]);
});

test("library entry defaults to all and translates a legacy empty folder id", () => {
  const start = app.indexOf("  function openLibrary(folderId = \"all\") {");
  const end = app.indexOf("\n  }\n", start) + 4;
  const declaration = app.slice(start, end);
  assert.ok(declaration.includes('setLibraryFolderId(folderId || "unfiled");'));
  const states = [];
  const openLibrary = Function("setLibraryFolderId", "navigate", `${ts.transpileModule(declaration, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText}\nreturn openLibrary;`)(
    id => states.push(["folder", id]),
    id => states.push(["view", id])
  );
  openLibrary("writing");
  openLibrary();
  openLibrary("");
  assert.deepEqual(states, [["folder", "writing"], ["view", "library"], ["folder", "all"], ["view", "library"], ["folder", "unfiled"], ["view", "library"]]);
});

test("ambiguous legacy names and orphan source IDs stay visible in unfiled", () => {
  const sources = [{ ...source, id: "a" }, { ...source, id: "b" }];
  const orphanSkills = [
    { ...skills[3], id: "ambiguous", userFolderId: "" },
    { ...skills[0], id: "orphan", sourceId: "missing", userFolderId: "deleted-folder" }
  ];
  const rows = counts.buildLibraryRows({ sources, skills: orphanSkills, skillFolders });
  const unfiled = rows.filter(row => row.kind === "standalone" && counts.rowInFolder(row, "unfiled"));
  assert.deepEqual(unfiled.map(row => row.skill.id), ["ambiguous", "orphan"]);
  assert.equal(model.buildSkyIslands({ sources, skills: orphanSkills, skillFolders }, "Unfiled").find(island => island.id === "unfiled").skillCount, 2);
});

test("the filter bar replaces the hidden source-type filter (bug #5)", () => {
  assert.doesNotMatch(app, /sourceTypeFilter/);
  const base = { unit: { unitId: "u", libraryOnlyReason: "" }, source: { health: "ok" }, governance: null };
  assert.deepEqual(counts.rowFilterState({ ...base, targets: [{ status: "synced" }] }), { synced: true, unsynced: false, update: false, problem: false });
  assert.deepEqual(counts.rowFilterState({ ...base, targets: [{ status: "off" }] }), { synced: false, unsynced: true, update: false, problem: false });
  assert.equal(counts.rowFilterState({ ...base, targets: [{ status: "conflict" }] }).problem, true);
  assert.equal(counts.rowFilterState({ ...base, targets: [], governance: { relation: "update-available", status: "ready" } }).update, true);
  assert.equal(counts.rowFilterState({ ...base, unit: { unitId: "u", libraryOnlyReason: "prompt-only" }, targets: [] }).unsynced, false);
});
