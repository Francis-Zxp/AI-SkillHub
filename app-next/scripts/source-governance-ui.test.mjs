import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const types = await readFile(new URL("../src/types.ts", import.meta.url), "utf8");
const preview = await readFile(new URL("../src/preview.ts", import.meta.url), "utf8");
const messages = await readFile(new URL("../src/i18n.ts", import.meta.url), "utf8");
const syncScript = await readFile(new URL("../runtime/SkillHub.ps1", import.meta.url), "utf8");

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

test("quality UI stays distinct from GitHub popularity and explains missing evidence", () => {
  assert.match(app, /<PopularityChip popularity=/);
  assert.match(app, /<SourceQualityChip quality=/);
  assert.match(app, /quality\.excluded/);
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
