// Real Tauri IPC against the verified executable, launched only by the isolated
// PowerShell harness. No mock routes, no global profile or host-config writes.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { chromium } = require("playwright");
const required = name => { assert.ok(process.env[name], `${name} required`); return process.env[name]; };
const qaRoot = path.resolve(required("AI_SKILLHUB_QA_ROOT"));
const dataRoot = path.resolve(required("AI_SKILLHUB_QA_DATA_ROOT"));
const profile = path.resolve(required("USERPROFILE"));
const reportPath = required("AI_SKILLHUB_QA_REPORT");
const comparable = value => path.toNamespacedPath(path.resolve(value)).toLowerCase();
const inside = (base, value) => { const relative = path.relative(comparable(base), comparable(value)); return !relative.startsWith("..") && !path.isAbsolute(relative); };
assert.ok(inside(process.env.TEMP, qaRoot) && qaRoot !== path.resolve(process.env.TEMP));
assert.ok(inside(qaRoot, dataRoot) && inside(qaRoot, profile));
const sha = bytes => crypto.createHash("sha256").update(bytes).digest("hex");
const report = { executable: required("AI_SKILLHUB_EXPECTED_EXE_PATH"), sha256: required("AI_SKILLHUB_EXPECTED_EXE_SHA256"), pid: Number(required("AI_SKILLHUB_EXPECTED_PID")), isolatedRoot: qaRoot, dataRoot, profile, mode: "real-compiled-tauri-ipc", checks: [], note: "User-approved run limited to Prompt creation and duplicate consolidation. Connect and diagnostics are not invoked. All test data, skill links and configured host paths are isolated. This is not a blank Windows machine." };
assert.equal(sha(fs.readFileSync(report.executable)), report.sha256);
const record = (name, details = true) => { report.checks.push({ name, details }); console.log(`PASS ${name}`); fs.writeFileSync(reportPath, JSON.stringify(report, null, 2)); };

async function main() {
  const browser = await chromium.connectOverCDP(required("AI_SKILLHUB_CDP_URL"));
  try {
    let page;
    for (let attempt = 0; attempt < 100 && !page; attempt++) {
      page = browser.contexts().flatMap(context => context.pages()).find(candidate => /^https?:\/\/tauri\.localhost/.test(candidate.url()));
      if (!page) await new Promise(resolve => setTimeout(resolve, 150));
    }
    assert.ok(page, "native Tauri page must be present");
    await page.waitForFunction(() => typeof window.__TAURI_INTERNALS__?.invoke === "function");
    const invoke = async (command, args = {}) => {
      assert.ok(["load_indexed_snapshot", "scan_legacy_snapshot", "create_prompt_launcher", "create_skill_folder", "save_source_metadata", "move_source_skills_to_folder", "consolidate_duplicate_sources"].includes(command), "only reviewed isolated QA commands are permitted");
      for (let attempt = 0; ; attempt++) {
        try { return await page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args }); }
        catch (error) {
          if (attempt < 40 && /另一项|另一个|正在执行|后台任务正在|稍后重试|正在运行/.test(String(error))) { await page.waitForTimeout(500); continue; }
          throw error;
        }
      }
    };
    let snapshot = await invoke("load_indexed_snapshot");
    assert.ok(inside(qaRoot, snapshot.root));
    assert.ok(inside(dataRoot, snapshot.sourcesDir));
    assert.ok(inside(dataRoot, snapshot.skillsDir));
    record("runtime-root-isolation", { root: snapshot.root, sourcesDir: snapshot.sourcesDir, skillsDir: snapshot.skillsDir });
    // Wait for startup's own initial reconciliation, then request a real scan.
    snapshot = await invoke("scan_legacy_snapshot");
    const find = name => snapshot.sources.find(source => path.basename(source.localPath) === name);
    const first = find("qa-duplicate");
    const second = find("qa--duplicate");
    const prompt = find("qa-prompt");
    assert.ok(first && second && prompt, `three fixture sources expected: ${JSON.stringify(snapshot.sources.map(source => ({ name: source.name, path: source.localPath })))}`);
    assert.equal(prompt.sourceType, "prompt");
    record("three-native-indexed-fixtures", snapshot.sources.map(source => ({ id: source.id, name: source.name, sourceType: source.sourceType })));

    // Prioritize the new Prompt pathway before duplicate maintenance.
    const originalPath = path.join(prompt.localPath, "README.md");
    const originalHash = sha(fs.readFileSync(originalPath));
    const launcher = await invoke("create_prompt_launcher", { sourceId: prompt.id });
    assert.ok(inside(path.join(dataRoot, "sources"), launcher.path));
    assert.match(launcher.name, /^prompt-[a-f0-9]{16}$/);
    const launcherBody = fs.readFileSync(path.join(launcher.path, "SKILL.md"), "utf8");
    assert.match(launcherBody, /Do not automatically execute scripts/);
    assert.ok(!launcherBody.includes("PRIVATE_FIXTURE_PROMPT_ORIGINAL"));
    assert.equal(sha(fs.readFileSync(originalPath)), originalHash);
    assert.equal(fs.existsSync(path.join(prompt.localPath, "SKILL.md")), false);
    snapshot = await invoke("load_indexed_snapshot");
    assert.ok(snapshot.sources.some(source => comparable(source.localPath) === comparable(launcher.path)), "launcher must enter the real indexed library");
    assert.equal(snapshot.sources.find(source => source.id === prompt.id).sourceType, "prompt");
    record("prompt-launcher-created-indexed-original-unchanged", { ...launcher, originalHash });
    const again = await invoke("create_prompt_launcher", { sourceId: prompt.id });
    assert.equal(again.path, launcher.path);
    assert.equal(sha(fs.readFileSync(originalPath)), originalHash);
    record("prompt-launcher-idempotent");

    const folderA = (await invoke("create_skill_folder", { name: "QA folder A", note: "first membership", color: "blue" })).find(folder => folder.name === "QA folder A");
    const folderB = (await invoke("create_skill_folder", { name: "QA folder B", note: "second membership", color: "emerald" })).find(folder => folder.name === "QA folder B");
    for (const [source, note, folder] of [[first, "QA_NOTE_ALPHA_KEEP", folderA], [second, "QA_NOTE_BETA_KEEP", folderB]]) {
      await invoke("save_source_metadata", { sourceId: source.id, name: source.name, sourceType: source.sourceType, category: source.categoryId, note, enabled: source.enabled, tags: [note] });
      await invoke("move_source_skills_to_folder", { sourceId: source.id, folderId: folder.id });
    }
    snapshot = await invoke("load_indexed_snapshot");
    assert.equal(snapshot.sources.find(source => source.id === first.id).userFolderId, folderA.id);
    assert.equal(snapshot.sources.find(source => source.id === second.id).userFolderId, folderB.id);
    record("distinct-notes-and-folders-set-through-ipc");

    const merged = await invoke("consolidate_duplicate_sources");
    const copies = merged.sources.filter(source => /qa-duplicate|qa--duplicate/.test(path.basename(source.localPath)));
    assert.equal(copies.length, 1, "identical repository copies must consolidate to one source");
    assert.match(copies[0].note, /QA_NOTE_ALPHA_KEEP/);
    assert.match(copies[0].note, /QA_NOTE_BETA_KEEP/);
    assert.equal(copies[0].userFolderId, folderA.id);
    const backupRoot = path.join(dataRoot, "state", "backups");
    const backup = fs.readdirSync(backupRoot).filter(name => name.startsWith("source-merge-")).map(name => path.join(backupRoot, name)).at(-1);
    assert.ok(backup && fs.existsSync(path.join(backup, "before.sqlite3")));
    assert.ok(fs.existsSync(path.join(backup, "qa--duplicate", "SKILL.md")));
    const manifests = fs.readdirSync(backup).filter(name => name.endsWith(".json") && name !== "skillhub.config.json").map(name => JSON.parse(fs.readFileSync(path.join(backup, name), "utf8")));
    assert.ok(manifests.some(item => item.report.additionalFolderName === "QA folder B"), "second folder must remain recorded in recovery manifest");
    record("duplicate-merge-preserves-notes-folders-and-backup", { primaryId: copies[0].id, note: copies[0].note, userFolderId: copies[0].userFolderId, backup, manifests });

    record("connect-diagnostics-excluded-from-this-run", "Not invoked: this approved run is limited to Prompt creation and duplicate consolidation.");
    await page.screenshot({ path: reportPath.replace(/\.json$/, ".png"), fullPage: true });
    report.passed = true;
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`Real desktop IPC QA passed: ${reportPath}`);
  } catch (error) {
    report.passed = false;
    report.error = String(error);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    throw error;
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
