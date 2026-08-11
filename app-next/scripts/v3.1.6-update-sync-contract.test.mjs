import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const app = await readFile(new URL("../src/App.tsx", import.meta.url), "utf8");
const backend = await readFile(new URL("../src-tauri/src/lib.rs", import.meta.url), "utf8");
const governance = await readFile(new URL("../src-tauri/src/source_governance.rs", import.meta.url), "utf8");
const runtime = await readFile(new URL("../runtime/SkillHub.ps1", import.meta.url), "utf8");
const styles = await readFile(new URL("../src/styles.css", import.meta.url), "utf8");
const releaseScript = await readFile(new URL("./build-formal-release.ps1", import.meta.url), "utf8");
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const tauriConfig = JSON.parse(await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
const cargoToml = await readFile(new URL("../src-tauri/Cargo.toml", import.meta.url), "utf8");

test("software updater sees one consistent v3.1.9 installed version", () => {
  assert.equal(packageJson.version, "3.1.9");
  assert.equal(tauriConfig.version, packageJson.version);
  assert.match(cargoToml, /^version = "3\.1\.9"$/m);
  assert.equal(tauriConfig.bundle.createUpdaterArtifacts, true);
  assert.equal(tauriConfig.plugins.updater.endpoints.length, 3);
  assert.ok(tauriConfig.plugins.updater.endpoints.every(endpoint => endpoint.includes("{{current_version}}")));
  assert.match(app, /window\.setTimeout\(\(\) => void checkForAppUpdate\(true\), 2600\)/);
  assert.match(app, /window\.addEventListener\("online", checkAfterReconnect\)/);
  assert.match(releaseScript, /AI-SkillHub-\$Version-setup\.exe/);
  assert.match(releaseScript, /LatestPayload = \[ordered\]@\{/);
  assert.match(releaseScript, /FallbackLatestJsonPath/);
});

test("Skill source sync reports partial failures instead of claiming universal success", () => {
  assert.match(runtime, /last-sync\.json/);
  assert.match(runtime, /'partial'/);
  assert.match(runtime, /failedUpdates/);
  assert.match(backend, /last_sync_summary: SyncSummaryCard/);
  assert.match(app, /syncSummary\?\.status === "partial"/);
  assert.match(app, /toast\.syncPartial/);
  assert.match(runtime, /repositories = @\(\$RepoUpdateLog\.ToArray\(\)\)/);
  assert.match(runtime, /'dirty-blocked'\) \}\)/);
  assert.match(runtime, /exit 0\s*$/);
  assert.doesNotMatch(backend, /SkillHub 同步脚本执行失败：\{detail\}/);
});

test("source updates preserve dirty work and clear stale version comparisons", () => {
  assert.match(runtime, /status', '--porcelain', '--untracked-files=normal/);
  assert.match(runtime, /'dirty-blocked'/);
  assert.match(runtime, /local changes; update skipped so uncommitted files are preserved/);
  assert.match(governance, /remote_revision = excluded\.current_revision/);
  assert.match(governance, /ELSE 'unknown'/);
  assert.match(governance, /changed_files = 0/);
});

test("default desktop width reserves readable source titles before wrapping metadata", () => {
  assert.match(styles, /grid-template-columns: minmax\(220px, \.72fr\) minmax\(0, 2fr\)/);
  assert.match(styles, /\.source-group-meta \{[^}]*min-width: 0;[^}]*flex-wrap: wrap;/);
  assert.match(styles, /container-name: source-group/);
  assert.match(styles, /@container source-group \(max-width: 920px\)/);
});
