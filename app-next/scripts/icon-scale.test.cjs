const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const test = require("node:test");
const ts = require("typescript");
const scale = {};
vm.runInNewContext(ts.transpileModule(fs.readFileSync(require.resolve("../src/iconScale.ts"), "utf8"), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
}).outputText, { exports: scale });

test("icon preset migration retains the former standard, comfortable and large sizes", () => {
  for (const [old, next, size] of [["standard", "compact", 1], ["comfortable", "standard", 1.2], ["large", "comfortable", 1.36]]) {
    assert.equal(scale.restoredIconScale(null, old), next);
    assert.equal(scale.UI_ICON_SCALES[next], size);
  }
  assert.equal(scale.restoredIconScale(null, null), "standard");
  assert.equal(scale.restoredIconScale(null, "compact"), "compact");
  assert.equal(scale.restoredIconScale("garbage", "large"), "comfortable");
});

test("new selections survive reload without repeated migration, new large is larger", () => {
  for (const name of Object.keys(scale.UI_ICON_SCALES)) assert.equal(scale.restoredIconScale(name, "large"), name);
  assert.ok(scale.UI_ICON_SCALES.large > 1.36);
});
