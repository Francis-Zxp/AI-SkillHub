import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const backend = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");

function section(start, end) {
  const startIndex = backend.indexOf(start);
  const endIndex = backend.indexOf(end, startIndex + start.length);
  assert.ok(startIndex >= 0, `${start} should exist`);
  assert.ok(endIndex > startIndex, `${end} should follow ${start}`);
  return backend.slice(startIndex, endIndex);
}

test("public snapshot scans share the fail-fast background write guard", () => {
  const wrapper = section(
    "fn scan_legacy_snapshot_blocking()",
    "fn scan_legacy_snapshot_under_write_guard()"
  );
  assert.match(wrapper, /acquire_background_write_guard\("本地索引刷新"\)/);
  assert.match(wrapper, /scan_legacy_snapshot_under_write_guard\(\)/);
});

test("standalone tag saves cannot interleave with snapshot replacement", () => {
  const skillTags = section("fn set_skill_tags(", "fn set_source_tags(");
  const sourceTags = section("fn set_source_tags(", "fn delete_managed_source(");
  assert.match(skillTags, /acquire_background_write_guard\("Skill 标签保存"\)/);
  assert.match(skillTags, /load_indexed_snapshot_under_write_guard\(\)/);
  assert.match(sourceTags, /acquire_background_write_guard\("来源标签保存"\)/);
  assert.match(sourceTags, /load_indexed_snapshot_under_write_guard\(\)/);
});

test("rebuilt SQLite state is captured only after an immediate writer transaction", () => {
  const persistence = section("fn persist_snapshot(", "fn persist_agent_detection_refresh(");
  const transaction = persistence.indexOf("transaction_with_behavior(TransactionBehavior::Immediate)");
  assert.ok(transaction >= 0);
  for (const capture of ["load_enabled_state(&transaction)", "read_tag_overrides(&transaction", "read_preset_workspace_policies(&transaction)"]) {
    assert.ok(persistence.indexOf(capture) > transaction, `${capture} must happen after BEGIN IMMEDIATE`);
  }
});
