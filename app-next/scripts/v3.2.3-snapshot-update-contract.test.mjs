import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// git may check these sources out with CRLF, which would break every regex
// that matches across a line break. Normalise once, at read time.
const readText = async (relativePath) =>
  (await readFile(new URL(relativePath, import.meta.url), "utf8")).replace(/\r\n/g, "\n");

const app = await readText("../src/App.tsx");
const backend = await readText("../src-tauri/src/lib.rs");
const runtime = await readText("../runtime/SkillHub.ps1");
const styles = await readText("../src/styles.css");
const universe = await readText("../src/SkillUniverse.tsx");
const i18n = await readText("../src/i18n.ts");
const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
const tauriConfig = JSON.parse(await readFile(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
const cargoToml = await readText("../src-tauri/Cargo.toml");

test("sources installed without Git are refreshed from GitHub during a full sync", () => {
  // The ZIP fallback is what every machine without a usable Git ends up with,
  // so it must have an update path of its own instead of freezing forever.
  assert.match(backend, /fn refresh_snapshot_github_sources\(/);
  assert.match(backend, /fn refresh_single_snapshot_source\(/);
  assert.match(
    backend,
    /let snapshot_refresh = refresh_snapshot_github_sources\(&root, &connection\);\s*\n\s*write_snapshot_refresh_report\(&root, &snapshot_refresh\)\?;\s*\n\s*run_skillhub_script\(&root\)\?;/
  );
  assert.match(backend, /stage_github_source_import_via_codeload_with_control\(&plan, &staged_path, &control\)/);
});

test("a snapshot refresh never silently replaces a verified local copy", () => {
  // Only app-managed folders, never pinned sources, and always a restorable backup.
  assert.match(backend, /if !canonical_path\.starts_with\(&canonical_sources_dir\) \{\s*\n\s*continue;/);
  assert.match(backend, /if canonical_path\.join\("\.git"\)\.exists\(\)/);
  assert.match(backend, /MANAGED_SOURCE_METADATA_FILE\)\.is_file\(\)/);
  assert.match(backend, /"pinned"\.to_string\(\)/);
  assert.match(backend, /security_scan::scan_source_tree\(&staged_path\)/);
  assert.match(backend, /move_directory\(target_path, &backup_path\)/);
  assert.match(backend, /let restored = move_directory\(&backup_path, target_path\);/);
  assert.match(backend, /fn snapshot_tree_fingerprint\(/);
  assert.match(backend, /"unchanged"\.to_string\(\)/);
  assert.match(backend, /const SNAPSHOT_REFRESH_BACKUP_KEEP: usize = 3;/);
});

test("snapshot refreshes stay bounded and rotate across syncs", () => {
  // A whole-archive download is far heavier than a fast-forward, so one sync
  // must not stall behind a long list of snapshot sources.
  assert.match(backend, /const SNAPSHOT_REFRESH_BUDGET: Duration = Duration::from_secs\(150\);/);
  assert.match(backend, /if started_at\.elapsed\(\) >= SNAPSHOT_REFRESH_BUDGET/);
  assert.match(backend, /status: "deferred"\.to_string\(\)/);
  assert.match(backend, /fn snapshot_downloaded_at\(/);
  assert.match(backend, /sources\.sort_by_key\(/);
  assert.match(runtime, /'deferred' \{ Add-RepoUpdateLog \$Name 'snapshot-refresh' 'skipped' \$detail \}/);
});

test("the sync report names the snapshot result instead of calling the source un-updatable", () => {
  assert.match(runtime, /snapshot-refresh\.json/);
  assert.match(runtime, /function Add-SnapshotSourceUpdateLog/);
  assert.match(runtime, /'snapshot-refresh' 'ok' \$detail/);
  assert.match(runtime, /Add-SnapshotSourceUpdateLog \$source\.Name/);
  assert.match(runtime, /Add-SnapshotSourceUpdateLog \(\[string\]\$repo\.name\)/);
  assert.match(app, /sourceUpdateProblemMessage\(item\.status, item\.action\)/);
  assert.match(app, /"snapshot-refresh"\) return t\("set\.sourceUpdatesSnapshot"\)/);
  for (const locale of ["set.sourceUpdatesSnapshot"]) {
    assert.equal((i18n.match(new RegExp(`"${locale}":`, "g")) ?? []).length, 3);
  }
});

test("light themes never paint the galaxy atmosphere as a grey shadow", () => {
  // A translucent DARK tint spread over a light page reads as a dirty smudge,
  // which is exactly what the wide aura used to produce on every light theme.
  const paletteBody = universe.slice(
    universe.indexOf("function atmospherePalette("),
    universe.indexOf("function getAuraSprite(")
  );
  assert.ok(paletteBody.length > 0);
  const lightAlphas = [...paletteBody.matchAll(/"rgba\(\d+, \d+, \d+, (\.\d+)\)"(?!\s*:)/g)].map(
    match => Number(match[1])
  );
  assert.ok(lightAlphas.length >= 12);
  // The widest layers (center/mid/edge) are the ones that read as a smudge.
  assert.ok(Math.min(...lightAlphas) <= 0.01);
  assert.ok(paletteBody.match(/lightTheme \? "rgba\(\d+, \d+, \d+, \.\d+\)"/g).every(value =>
    Number(value.match(/(\.\d+)\)"$/)[1]) <= 0.2
  ));
  assert.match(universe, /center: lightTheme \? "rgba\(23, 121, 111, \.06\)"/);
  assert.match(universe, /center: "rgba\(154, 78, 48, \.05\)"/);
  assert.match(styles, /--hero-grad: radial-gradient\(circle at 66% 48%, rgba\(22, 121, 111, \.05\), transparent 52%\);/);
});
