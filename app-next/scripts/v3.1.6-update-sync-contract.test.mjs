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

test("software updater sees one consistent v3.2.0 installed version", () => {
  assert.equal(packageJson.version, "3.2.0");
  assert.equal(tauriConfig.version, packageJson.version);
  assert.match(cargoToml, /^version = "3\.2\.0"$/m);
  assert.equal(tauriConfig.bundle.createUpdaterArtifacts, true);
  assert.equal(tauriConfig.plugins.updater.endpoints.length, 3);
  assert.ok(tauriConfig.plugins.updater.endpoints.every(endpoint => endpoint.includes("{{current_version}}")));
  assert.match(app, /initialUpdateTimerRef\.current = window\.setTimeout\([\s\S]*?10_000\)/);
  assert.match(app, /requestIdleCallback\(run, \{ timeout: 2_000 \}\)/);
  assert.match(app, /const retryDelays = \[0\]/);
  assert.match(app, /check\(\{ headers: UPDATE_CHECK_HEADERS, timeout: 8_000 \}\)/);
  assert.match(app, /else if \(!silent\) \{\s*setAppUpdate/);
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
  assert.match(runtime, /ConvertTo-Json -InputObject \$Object/);
  assert.match(runtime, /IsNullOrWhiteSpace\(\$previousRaw\)/);
  assert.match(runtime, /Removed broken managed source link/);
  assert.match(runtime, /Skipping invalid managed Skill target/);
  assert.match(runtime, /'dirty-blocked'\) \}\)/);
  assert.match(runtime, /'not-git'/);
  assert.match(runtime, /remove it and add its GitHub URL again/);
  assert.match(runtime, /if \(-not \$NoPull -or -not \(Test-Path -LiteralPath \$ReportJsonPath/);
  assert.match(app, /set\.sourceUpdatesTitle/);
  assert.match(app, /sourceUpdateProblems/);
  assert.match(runtime, /exit 0\s*$/);
  assert.doesNotMatch(backend, /SkillHub 同步脚本执行失败：\{detail\}/);
});

test("core sync is single-flight and follows with a lightweight popularity refresh", () => {
  assert.match(app, /const syncInFlightRef = useRef<Promise<LegacySnapshot \| null> \| null>\(null\)/);
  assert.match(app, /if \(syncInFlightRef\.current\)[\s\S]*?return syncInFlightRef\.current/);
  assert.match(app, /const task = runCoreSync\(\);\s*syncInFlightRef\.current = task/);
  const coreSync = app.slice(app.indexOf("async function runCoreSync"), app.indexOf("async function refreshLocalAgents"));
  assert.match(coreSync, /loadSnapshot\("refresh", \{ background: true, quiet: true \}\)/);
  assert.doesNotMatch(coreSync, /refreshSourcePopularity|sourcePopularityRefreshMessage/);
  const syncEntry = app.slice(app.indexOf("async function syncAndRefreshAll"), app.indexOf("async function runCoreSync"));
  assert.match(syncEntry, /options: \{ refreshPopularity\?: boolean \} = \{\}/);
  assert.match(syncEntry, /options\.refreshPopularity !== false/);
  assert.match(syncEntry, /void refreshSourcePopularity\(\{ background: true \}\)/);
  assert.match(app, /syncAndRefreshAll\(\{ refreshPopularity: false \}\)/);
  const popularityStart = backend.indexOf("fn refresh_source_popularity_blocking");
  const popularityEnd = backend.indexOf("fn resolve_legacy_root", popularityStart);
  const popularityRefresh = backend.slice(popularityStart, popularityEnd);
  assert.match(popularityRefresh, /build_source_popularity_refresh_result/);
  assert.doesNotMatch(popularityRefresh, /scan_legacy_snapshot_blocking/);
  assert.match(app, /loading=\{mutationBusy\}/);
  assert.match(app, /disabled=\{loading \|\| syncing\}/);
});

test("router generation finishes before the final active-catalog publish", () => {
  const fullStart = backend.indexOf("fn run_skillhub_sync_blocking()");
  const fullEnd = backend.indexOf("fn ensure_agent_skill_delivery_blocking", fullStart);
  const localStart = backend.indexOf("fn sync_local_sources_to_agents(");
  const localEnd = backend.indexOf("fn run_skillhub_script(", localStart);
  const fullSync = backend.slice(fullStart, fullEnd);
  const localSync = backend.slice(localStart, localEnd);
  assert.ok(fullStart >= 0 && fullEnd > fullStart);
  assert.ok(localStart >= 0 && localEnd > localStart);
  assert.ok(fullSync.indexOf("plan_or_write_router_hubs") < fullSync.lastIndexOf("run_skillhub_script_no_pull"));
  assert.ok(localSync.indexOf("plan_or_write_router_hubs") < localSync.indexOf("run_skillhub_script_no_pull"));
  assert.match(fullSync, /let report = plan_or_write_router_hubs\(&root, true, true\)\?;/);
  assert.match(localSync, /let report = plan_or_write_router_hubs\(root, true, true\)\?;/);
  assert.doesNotMatch(fullSync, /if let Ok\(report\) = plan_or_write_router_hubs/);
  assert.doesNotMatch(localSync, /if let Ok\(report\) = plan_or_write_router_hubs/);
});

test("source updates preserve dirty work and clear stale version comparisons", () => {
  assert.match(runtime, /status', '--porcelain', '--untracked-files=normal/);
  assert.match(runtime, /'dirty-blocked'/);
  assert.match(runtime, /local changes; update skipped so uncommitted files are preserved/);
  assert.match(governance, /remote_revision = excluded\.current_revision/);
  assert.match(governance, /ELSE 'unknown'/);
  assert.match(governance, /changed_files = 0/);
});

test("the app's own bookkeeping never blocks a source from tracking GitHub", () => {
  // .skillhub-source.json and .skillhub-extracted are written by AI SkillHub
  // itself. Counting them as local work made every touched source stop updating.
  assert.match(runtime, /\$SelfAuthoredRepoArtifacts = @\('\.skillhub-source\.json', '\.skillhub-extracted'\)/);
  assert.match(runtime, /function Test-PorcelainEntryIsSelfAuthored/);
  assert.match(runtime, /function Get-BlockingWorkingTreeChanges/);
  // Only untracked entries may be ignored; a tracked change still blocks.
  assert.match(runtime, /if \(\$Line\.Substring\(0, 2\) -ne '\?\?'\) \{ return \$false \}/);
  // Both the configured-repo and the auto-discovered-repo paths must filter.
  assert.equal(runtime.match(/Get-BlockingWorkingTreeChanges \$dirtyResult\.Stdout/g)?.length, 2);
  assert.doesNotMatch(runtime, /if \(-not \[string\]::IsNullOrWhiteSpace\(\$dirtyResult\.Stdout\)\) \{\s*Write-Warning/);
});

test("default desktop width reserves readable source titles before wrapping metadata", () => {
  assert.match(styles, /grid-template-columns: minmax\(220px, \.72fr\) minmax\(0, 2fr\)/);
  assert.match(styles, /\.source-group-meta \{[^}]*min-width: 0;[^}]*flex-wrap: wrap;/);
  assert.match(styles, /container-name: source-group/);
  assert.match(styles, /@container source-group \(max-width: 920px\)/);
});
