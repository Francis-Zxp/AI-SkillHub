const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const test = require("node:test");
const ts = require("typescript");

function load(lang = "zh") {
  const exportsObject = {};
  const compiled = ts.transpileModule(fs.readFileSync(path.join(__dirname, "../src/sourceUpdateRun.ts"), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2021 }
  }).outputText;
  vm.runInNewContext(compiled, {
    exports: exportsObject,
    require: id => (id === "./i18n" ? { getLang: () => lang } : {}),
    Intl
  });
  return exportsObject;
}

const entry = (folder, outcome, extra = {}) => ({
  folder,
  outcome,
  detail: "",
  tracking: "origin/main",
  checkedAt: "2026-10-01T08:00:00Z",
  addedSkills: [],
  removedPaths: [],
  addedDependencies: [],
  discoveredSkills: [],
  keptLocalPaths: [],
  ...extra
});
const run = sources => ({ schemaVersion: 1, runId: "r", startedAt: "", updatedAt: "2026-10-01T08:00:00Z", rounds: 1, sources });

test("summary counts every outcome and never reports waiting sources as finished", () => {
  const { summarizeSourceUpdateRun } = load();
  const summary = summarizeSourceUpdateRun(run([
    entry("a", "updated", { addedSkills: ["skills/x", "skills/y"] }),
    entry("b", "unchanged"),
    entry("c", "deferred"),
    entry("d", "local-changes", { keptLocalPaths: ["skills/z/SKILL.md"] }),
    entry("e", "mystery-status")
  ]));
  assert.equal(summary.total, 5);
  assert.equal(summary.pending, 1);
  assert.equal(summary.checked, 4);
  assert.equal(summary.finished, false);
  assert.equal(summary.addedSkills, 2);
  assert.equal(summary.keptLocal, 1);
  assert.equal(summary.counts.failed, 1, "unknown statuses are surfaced as failures, never hidden");
  assert.equal(summarizeSourceUpdateRun(null).finished, false);
  assert.equal(summarizeSourceUpdateRun(run([entry("a", "unchanged")])).finished, true);
});

test("auto-continue stops when done, when stopped, and at the round ceiling", () => {
  const { shouldAutoContinue, MAX_AUTO_CONTINUE_ROUNDS } = load();
  const waiting = run([entry("a", "deferred"), entry("b", "updated")]);
  assert.equal(shouldAutoContinue(waiting, 1, false), true);
  assert.equal(shouldAutoContinue(waiting, 1, true), false);
  assert.equal(shouldAutoContinue(waiting, MAX_AUTO_CONTINUE_ROUNDS, false), false);
  assert.equal(shouldAutoContinue(run([entry("a", "failed")]), 1, false), false);
  assert.equal(shouldAutoContinue(null, 1, false), false);
});

test("attention-first ordering and owner--repo labels", () => {
  const { sortSourceUpdateEntries, sourceFolderLabel, skillPathLeaf } = load();
  const ordered = sortSourceUpdateEntries([
    entry("z-ok", "unchanged"),
    entry("broken", "failed"),
    entry("fresh", "updated", { addedSkills: ["a"] }),
    entry("later", "deferred")
  ]).map(item => item.folder);
  assert.deepEqual([...ordered], ["broken", "later", "fresh", "z-ok"]);
  // Identity decides; the folder's `--` order differs between versions.
  assert.deepEqual({ ...sourceFolderLabel("nature-skills--yuan1z0825", "yuan1z0825/nature-skills") }, { title: "nature-skills", owner: "yuan1z0825" });
  assert.deepEqual({ ...sourceFolderLabel("Yuan1z0825--nature-skills", "yuan1z0825/nature-skills") }, { title: "nature-skills", owner: "yuan1z0825" });
  assert.deepEqual({ ...sourceFolderLabel("my-local-pack") }, { title: "my-local-pack", owner: "" });
  assert.equal(skillPathLeaf("skills/中文 技能/"), "中文 技能");
});

test("toast states pending and failures honestly in every language", () => {
  for (const lang of ["zh", "en", "ko"]) {
    const { sourceUpdateToast } = load(lang);
    const partial = sourceUpdateToast(run([entry("a", "updated", { addedSkills: ["x"] }), entry("b", "deferred"), entry("c", "failed")]));
    assert.equal(partial.tone, "warn");
    assert.match(partial.message, /2\/3/);
    const clean = sourceUpdateToast(run([entry("a", "unchanged")]));
    assert.equal(clean.tone, "ok");
    assert.equal(sourceUpdateToast(run([])), null);
  }
});

test("latest means every source was checked, with no pinned or preserved local content", () => {
  const { sourceUpdateFeedback } = load();
  const clean = run([entry("a", "unchanged")]);
  assert.equal(sourceUpdateFeedback(clean).label, "已是最新");
  assert.match(sourceUpdateFeedback(clean).message, /检查于/);
  assert.equal(sourceUpdateFeedback(run([entry("a", "updated")])).label, "已更新 1");
  for (const outcome of ["pinned", "not-git", "local-changes", "failed", "deferred", "unknown"]) {
    const feedback = sourceUpdateFeedback(run([entry("a", "unchanged"), entry("b", outcome)]));
    assert.notEqual(feedback.label, "已是最新", outcome);
    assert.notEqual(feedback.tone, "ok", outcome);
  }
  assert.equal(sourceUpdateFeedback(run([entry("a", "unchanged", { keptLocalPaths: ["a.md"] })])).label, "部分未更新");
  assert.equal(sourceUpdateFeedback(null), null);
  assert.equal(sourceUpdateFeedback(run([])), null);
  assert.equal(sourceUpdateFeedback({ ...clean, updatedAt: "" }), null);
});

test("source-set changes invalidate a previous whole-library result, generated routers do not", () => {
  const { sourceUpdateFeedback } = load();
  const clean = run([entry("a", "unchanged")]);
  const a = { name: "Custom title", localPath: "C:\\data\\sources\\A\\" };
  assert.equal(sourceUpdateFeedback(clean, [a]).label, "已是最新");
  assert.equal(sourceUpdateFeedback(clean, [a, { name: "router", localPath: "/sources/AI-SkillHub-local-routers" }]).label, "已是最新");
  assert.equal(sourceUpdateFeedback(clean, [a, { name: "b", localPath: "/sources/b" }]), null);
  assert.equal(sourceUpdateFeedback(clean, []), null);
  assert.equal(sourceUpdateFeedback(clean, [{ name: "new", localPath: "/sources/renamed" }]), null);
});

test("all languages distinguish clean, changed, partial, pending and failed checks", () => {
  for (const lang of ["zh", "en", "ko"]) {
    const { sourceUpdateFeedback } = load(lang);
    const labels = [
      [entry("a", "unchanged")], [entry("a", "updated")], [entry("a", "failed")],
      [entry("a", "unchanged"), entry("b", "failed")], [entry("a", "deferred")], [entry("a", "pinned")]
    ].map(entries => sourceUpdateFeedback(run(entries)).label);
    assert.equal(new Set(labels).size, 6);
    assert.ok(labels.every(label => !label.includes("run.") && !label.includes("{")));
  }
});

test("skipped results identify the actual source and reason instead of a generic list", () => {
  const { sourceUpdateToast } = load();
  const result = sourceUpdateToast(run([entry("repo", "unchanged"), entry("mineru-document-extractor", "not-git")]));
  assert.match(result.message, /mineru-document-extractor: 无上游/);
  assert.doesNotMatch(result.message, /固定版本、本地修改或无上游|\[object Object\]/);
});
