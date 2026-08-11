import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const types = await readFile(new URL("../src/types.ts", import.meta.url), "utf8");
const preview = await readFile(new URL("../src/preview.ts", import.meta.url), "utf8");
const messages = await readFile(new URL("../src/i18n.ts", import.meta.url), "utf8");
const syncScript = await readFile(new URL("../runtime/SkillHub.ps1", import.meta.url), "utf8");
const backend = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");

test("desktop bridge exposes all source governance actions", () => {
  for (const command of [
    "set_source_version_pin",
    "refresh_source_version_status",
    "rollback_source_to_latest_backup"
  ]) {
    assert.match(app, new RegExp(`invoke<LegacySnapshot>\\("${command}"`));
  }
});

test("snapshot contract and browser preview carry governance and local evidence", () => {
  for (const field of ["sourceGovernance", "sourceQualitySignals"]) {
    assert.match(types, new RegExp(`${field}:`));
    assert.match(preview, new RegExp(`${field}:`));
  }
  assert.match(preview, /evidenceTotal:\s*4/);
  assert.doesNotMatch(preview, /key:\s*"metadata"/);
});

test("quality evidence stays diagnostic-only and does not clutter the Skill Library", () => {
  assert.doesNotMatch(app, /<PopularityChip popularity=/);
  assert.doesNotMatch(app, /<SourceQualityChip quality=/);
  assert.doesNotMatch(app, /source-quality-panel/);
  assert.match(messages, /GitHub stars and missing evidence never inflate this score/);
  assert.match(messages, /GitHub 星标与缺失证据都不会抬高分数/);
});

test("sync script consumes the exact pin manifest and skips network updates", () => {
  assert.match(syncScript, /source-governance\.json/);
  assert.match(syncScript, /\^\[0-9a-fA-F\]\{40\}\$/);
  assert.match(syncScript, /Get-PinnedSourceRevision/);
  assert.match(syncScript, /network update skipped/);
  assert.match(syncScript, /governance-blocked/);
});

test("large source imports stay bounded, visible, and off the UI thread", () => {
  assert.match(backend, /const SOURCE_IMPORT_MAX_FILES: usize = 20_000/);
  assert.match(backend, /--filter=blob:none/);
  assert.match(backend, /fn complete_sparse_skill_checkout/);
  assert.match(backend, /fn stage_github_source_import_via_release_asset_with_control/);
  assert.match(backend, /github-release-skill/);
  for (const command of [
    "preview_source_import_candidate",
    "stage_source_import_candidate",
    "promote_staged_source_import"
  ]) {
    assert.match(
      backend,
      new RegExp(`async fn ${command}\\([\\s\\S]*?tauri::async_runtime::spawn_blocking`)
    );
  }
  assert.match(app, /role="progressbar"/);
  assert.match(app, /className={`import-progress/);
  assert.match(backend, /SOURCE_IMPORT_PROGRESS_EVENT/);
  assert.match(backend, /fn cancel_source_import/);
  assert.match(app, /listen<SourceImportProgressEvent>\("source-import-progress"/);
  assert.match(app, /is-indeterminate/);
  assert.match(app, /onCancel\(activeOperationId\)/);
  assert.doesNotMatch(app, /setInterval\(\(\) => \{\s*setProgress/);
  assert.doesNotMatch(app, /current\.percent >= 64/);
});

test("preset UI omits the non-deploying distribution matrix", () => {
  assert.doesNotMatch(app, /onToggleDistribution/);
  assert.doesNotMatch(app, /className="distribution-grid"/);
});
