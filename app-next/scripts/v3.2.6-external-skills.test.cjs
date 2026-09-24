const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const ts = require("typescript");
const exportsObject = {};
let language = "en";
const compiled = ts.transpileModule(fs.readFileSync(path.join(__dirname, "../src/externalSkills.ts"), "utf8"), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 } }).outputText;
vm.runInNewContext(compiled, { exports: exportsObject, require: () => ({ getLang: () => language }) });
const { groupExternalSkills, filterExternalSkillGroups, externalSkillsText, EXTERNAL_SKILLS_PAGE_SIZE } = exportsObject;
const entry = (id, canonicalPath, extra = {}) => ({ id, canonicalPath, name: `skill-${id}`, description: "Example", path: `C:\\tools\\${id}`, agentId: "claude", agentName: "Claude", scope: "global", storageKind: "link", managed: false, canImport: true, ...extra });

test("shared Windows targets merge without losing client paths or mutating the inventory", () => {
  const original = [entry("one", "C:\\Skills\\review"), entry("two", "c:/skills/REVIEW/", { agentId: "codex", agentName: "Codex", scope: "project" })];
  const before = JSON.stringify(original);
  const groups = groupExternalSkills(original);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].entries.length, 2);
  assert.equal(groups[0].entries[1].scope, "project");
  assert.equal(filterExternalSkillGroups(groups, "two", "codex", "external").length, 1);
  assert.equal(filterExternalSkillGroups(groups, "c:/skills", "codex", "external").length, 1);
  assert.equal(filterExternalSkillGroups(groups, "two", "claude", "all").length, 0);
  assert.equal(JSON.stringify(original), before);
});

test("Windows extended and UNC forms merge; Unix case and distinct same-name skills stay separate", () => {
  assert.equal(groupExternalSkills([entry("a", "\\\\?\\C:\\Skills\\One"), entry("b", "C:\\Skills\\One")]).length, 1);
  assert.equal(groupExternalSkills([entry("a", "\\\\?\\UNC\\server\\share\\One"), entry("b", "\\\\server\\share\\one")]).length, 1);
  assert.equal(groupExternalSkills([entry("a", "/skills/One"), entry("b", "/skills/one")]).length, 2);
  assert.equal(groupExternalSkills([entry("a", "C:\\a", { name: "same" }), entry("b", "C:\\b", { name: "same" })]).length, 2);
  assert.equal(groupExternalSkills([entry("a", ""), entry("b", "")]).length, 2);
});

test("managed evidence prevents copying for every client sharing the target", () => {
  const groups = groupExternalSkills([entry("a", "C:\\same"), entry("b", "C:\\same", { managed: true, canImport: false })]);
  assert.equal(groups[0].managed, true);
  assert.equal(groups[0].canImport, false);
  assert.equal(filterExternalSkillGroups(groups, "", "all", "external").length, 0);
  assert.equal(filterExternalSkillGroups(groups, "", "all", "managed").length, 1);
});

test("pagination size and all three languages explain copying and range", () => {
  assert.equal(EXTERNAL_SKILLS_PAGE_SIZE, 20);
  for (const [lang, label] of [["zh", "复制到技能库"], ["en", "Copy to library"], ["ko", "라이브러리로 복사"]]) {
    language = lang;
    assert.equal(externalSkillsText("import"), label);
    assert.ok(externalSkillsText("externalHelp").length > 15);
    assert.ok(!externalSkillsText("range", { from: 21, to: 40, total: 204 }).includes("{"));
    assert.ok(!externalSkillsText("page", { page: 2, pages: 11 }).includes("{"));
  }
});
