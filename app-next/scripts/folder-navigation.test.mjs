import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

const text = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const ast = ts.createSourceFile("App.tsx", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
function find(predicate) {
  let found;
  function visit(node) {
    if (found) return;
    if (predicate(node)) found = node;
    else ts.forEachChild(node, visit);
  }
  visit(ast);
  assert.ok(found, "Expected production declaration exists");
  return found;
}
function run(code, bindings = {}) {
  const javascript = ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return Function(...Object.keys(bindings), javascript)(...Object.values(bindings));
}
function declaration(name) {
  return find(node => ts.isFunctionDeclaration(node) && node.name?.text === name).getText(ast);
}
function initializer(name, bindings) {
  const node = find(node => ts.isVariableDeclaration(node) && node.name.getText(ast) === name);
  return run(`return ${node.initializer.getText(ast)};`, bindings);
}
const modelText = await readFile(new URL("../src/skyIslandModel.ts", import.meta.url), "utf8");
const model = await import(`data:text/javascript,${encodeURIComponent(ts.transpileModule(modelText, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 } }).outputText)}`);
const helpers = ["normalizeLookup", "skillBelongsToSource", "resolveSkillSource", "isRouterHubSkill", "skillMatchesUserFolder", "sourceMatchesUserFolder"];
const functions = run(`${helpers.map(declaration).join("\n")}\nreturn {${helpers.join(",")}};`, {
  modelSkillBelongsToSource: model.skillBelongsToSource, modelIsRouterHubSkill: model.isRouterHubSkill
});
const source = { id: "repo", name: "owner-repo", url: "", userFolderId: "research" };
const skills = [
  { id: "inherited", sourceId: "repo", userFolderId: "", isRouterHub: false },
  { id: "override", sourceId: "repo", userFolderId: "writing", isRouterHub: false },
  { id: "router", sourceId: "repo", userFolderId: "writing", isRouterHub: true },
  { id: "legacy", source: "owner_repo", userFolderId: "writing", isRouterHub: false },
  { id: "local", source: "standalone", userFolderId: "", isRouterHub: false }
];
const bindings = {
  ...functions, sources: [source], skills, skillFolders: [{ id: "research" }, { id: "writing" }],
  skillsBySourceId: new Map([[source.id, skills.slice(0, 4)]]),
  useMemo: callback => callback(), applySourceDraft: value => value,
  applySkillDraft: value => value, sortSources: values => values, sortSkills: values => values,
  sourceDrafts: {}, skillDrafts: {}, searchQuery: "", sortKey: "recent", popularityById: new Map()
};

test("folder filtering honors a child override before source inheritance", () => {
  assert.equal(functions.skillMatchesUserFolder(skills[0], "research", source), true);
  assert.equal(functions.skillMatchesUserFolder(skills[1], "research", source), false);
  assert.equal(functions.skillMatchesUserFolder(skills[1], "writing", source), true);
  assert.equal(functions.skillMatchesUserFolder(skills[4], "unfiled"), true);
  assert.equal(functions.skillMatchesUserFolder(skills[1], "all", source), true);
  const snapshot = { sources: [source], skills, skillFolders: bindings.skillFolders.map((folder, i) => ({ ...folder, name: folder.id, sortOrder: i, skillCount: 999 })) };
  const counts = initializer("folderCounts", { snapshot, useMemo: callback => callback(), buildSkyIslands: model.buildSkyIslands });
  assert.deepEqual([...counts], [["research", 1], ["writing", 2], ["unfiled", 1]], "Library shelf ignores stale stored counts and excludes parent routers");
});

test("Library shows the source of a legacy child override and only matching children", () => {
  const context = { ...bindings, selectedFolderId: "writing" };
  assert.deepEqual(initializer("visibleSources", context).map(item => item.id), ["repo"]);
  assert.deepEqual(initializer("sourceSkills", { ...context, source }).filter(item => !functions.isRouterHubSkill(item)).map(item => item.id), ["override", "legacy"]);
  assert.deepEqual(initializer("sourceSkills", { ...context, source, selectedFolderId: "research" }).map(item => item.id), ["inherited"]);
});

test("legacy named source children do not appear a second time as local Skills", () => {
  assert.deepEqual(initializer("localSkills", { ...bindings, selectedFolderId: "writing" }), []);
  assert.deepEqual(initializer("localSkills", { ...bindings, selectedFolderId: "unfiled" }).map(item => item.id), ["local"]);
});

test("library entry defaults to all and translates legacy empty folder id", () => {
  const states = [];
  const openLibrary = run(`${declaration("openLibrary")}\nreturn openLibrary;`, {
    setLibraryFolderId: id => states.push(["folder", id]), setActive: id => states.push(["view", id])
  });
  openLibrary("writing");
  openLibrary();
  openLibrary("");
  assert.deepEqual(states, [["folder", "writing"], ["view", "library"], ["folder", "all"], ["view", "library"], ["folder", "unfiled"], ["view", "library"]]);
});

test("ambiguous legacy names and orphan source IDs stay visible in unfiled", () => {
  const sources = [{ ...source, id: "a" }, { ...source, id: "b" }];
  const skills = [
    { ...bindings.skills[3], id: "ambiguous", userFolderId: "" },
    { ...bindings.skills[0], id: "orphan", sourceId: "missing", userFolderId: "deleted-folder" }
  ];
  const context = { ...bindings, sources, skills, selectedFolderId: "unfiled" };
  assert.equal(initializer("skillsBySourceId", context).size, 0);
  assert.deepEqual(initializer("localSkills", context).map(item => item.id), ["ambiguous", "orphan"]);
  assert.equal(model.buildSkyIslands({ sources, skills, skillFolders: bindings.skillFolders.map((folder, i) => ({ ...folder, name: folder.id, sortOrder: i })) }, "Unfiled").find(island => island.id === "unfiled").skillCount, 2);
});
