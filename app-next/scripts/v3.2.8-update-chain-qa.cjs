// Full update chain on the real compiled app. Launch only through
// v3.2.8-update-chain-qa.ps1, which builds the TEMP sandbox and fixtures.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { chromium } = require("playwright");

const required = name => { assert.ok(process.env[name], `${name} required`); return process.env[name]; };
const qaRoot = path.resolve(required("AI_SKILLHUB_QA_ROOT"));
const dataRoot = path.resolve(required("AI_SKILLHUB_QA_DATA_ROOT"));
const profile = path.resolve(required("USERPROFILE"));
const upstream = path.resolve(required("AI_SKILLHUB_QA_UPSTREAM"));
const consumer = path.resolve(required("AI_SKILLHUB_QA_CONSUMER"));
const reportPath = required("AI_SKILLHUB_QA_REPORT");
const comparable = value => path.toNamespacedPath(path.resolve(value)).toLowerCase();
const inside = (base, value) => { const relative = path.relative(comparable(base), comparable(value)); return !relative.startsWith("..") && !path.isAbsolute(relative); };
for (const location of [dataRoot, profile, upstream, consumer]) assert.ok(inside(qaRoot, location), `${location} must stay inside the sandbox`);
assert.ok(inside(process.env.TEMP, qaRoot));

const report = {
  executable: required("AI_SKILLHUB_EXPECTED_EXE_PATH"),
  sha256: required("AI_SKILLHUB_EXPECTED_EXE_SHA256"),
  isolatedRoot: qaRoot,
  mode: "real-compiled-tauri-ipc",
  note: "Isolated TEMP sandbox; local file:// upstream (no network); simulated Claude Code presence inside the sandbox profile only.",
  checks: []
};
assert.equal(crypto.createHash("sha256").update(fs.readFileSync(report.executable)).digest("hex"), report.sha256);
const record = (name, details = true) => { report.checks.push({ name, details }); console.log(`PASS ${name}`); fs.writeFileSync(reportPath, JSON.stringify(report, null, 2)); };

const git = (cwd, ...args) => execFileSync("git", ["-C", cwd, "-c", "user.name=SkillHub QA", "-c", "user.email=qa@example.invalid", "-c", "core.autocrlf=false", ...args], { encoding: "utf8" });
const writeFile = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, "utf8"); };
const skillText = (name, extra = "") => `---\nname: ${name}\ndescription: Isolated update-chain fixture ${name}.\n---\n# ${name}\nUse only supplied text. ${extra}\n`;
const forward = value => path.resolve(value).replace(/\\/g, "/");

function routerFiles(sourcesDir) {
  const root = path.join(sourcesDir, "AI-SkillHub-local-routers");
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root)
    .map(entry => path.join(root, entry, "SKILL.md"))
    .filter(file => fs.existsSync(file));
}

async function main() {
  const browser = await chromium.connectOverCDP(required("AI_SKILLHUB_CDP_URL"));
  try {
    let page;
    for (let attempt = 0; attempt < 100 && !page; attempt++) {
      page = browser.contexts().flatMap(context => context.pages()).find(candidate => /^https?:\/\/tauri\.localhost/.test(candidate.url()));
      if (!page) await new Promise(resolve => setTimeout(resolve, 150));
    }
    assert.ok(page, "native Tauri page must be present");
    page.setDefaultTimeout(240000);
    await page.context().route("https://vibecafe.ai/**", route => route.abort("blockedbyclient"));
    await page.waitForFunction(() => typeof window.__TAURI_INTERNALS__?.invoke === "function");
    const allowed = ["load_indexed_snapshot", "scan_legacy_snapshot", "run_skillhub_sync"];
    const invoke = async (command, args = {}) => {
      assert.ok(allowed.includes(command), "only reviewed QA commands permitted");
      for (let attempt = 0; ; attempt++) {
        try { return await page.evaluate(({ command, args }) => window.__TAURI_INTERNALS__.invoke(command, args), { command, args }); }
        catch (error) {
          if (attempt < 120 && /另一项|另一个|正在执行|后台任务正在|稍后重试|正在运行/.test(String(error))) { await page.waitForTimeout(500); continue; }
          throw error;
        }
      }
    };

    let snapshot = await invoke("scan_legacy_snapshot");
    assert.ok(inside(qaRoot, snapshot.root) && inside(dataRoot, snapshot.sourcesDir));
    const alphaBefore = snapshot.skills.filter(skill => skill.name === "chain-alpha");
    assert.equal(alphaBefore.length, 2, "same-name children of two authors must both be indexed");
    assert.ok(!snapshot.skills.some(skill => skill.name === "chain-beta"));
    record("baseline-isolated-index", { sourcesDir: snapshot.sourcesDir, sameNameChildren: alphaBefore.map(skill => skill.sourceId) });

    // 1. The creator adds a sibling Skill that links to a shared helper folder.
    writeFile(path.join(upstream, "skills", "chain-beta", "SKILL.md"), skillText("chain-beta", "Read [contract](../shared/contract.md) first."));
    writeFile(path.join(upstream, "skills", "chain-beta", "scripts", "run.md"), "helper inside the Skill");
    git(upstream, "add", "-A");
    git(upstream, "commit", "-q", "-m", "add chain-beta");
    const upstreamHead = git(upstream, "rev-parse", "HEAD").trim();

    // 2. "Update all sources".
    const started = Date.now();
    snapshot = await invoke("run_skillhub_sync");
    const syncSeconds = Math.round((Date.now() - started) / 100) / 10;
    assert.equal(git(consumer, "rev-parse", "HEAD").trim(), upstreamHead, "pull must reach the new commit");

    // 3. Local files: the new Skill, its in-Skill helper and the linked folder.
    const betaFile = path.join(consumer, "skills", "chain-beta", "SKILL.md");
    assert.ok(fs.existsSync(betaFile), "new sibling Skill must be on disk, not only in the commit");
    assert.ok(fs.existsSync(path.join(consumer, "skills", "chain-beta", "scripts", "run.md")));
    assert.ok(fs.existsSync(path.join(consumer, "skills", "shared", "contract.md")), "linked helper folder must be materialized");
    assert.ok(!fs.existsSync(path.join(consumer, "docs", "big.md")), "unrelated folders stay out of the sparse checkout");
    record("local-files", { betaFile, syncSeconds });

    // 4. SQLite index (the snapshot returned by the command is read from it).
    const beta = snapshot.skills.find(skill => skill.name === "chain-beta");
    assert.ok(beta, "new Skill must be in the rebuilt index");
    assert.equal(snapshot.skills.filter(skill => skill.name === "chain-alpha").length, 2, "same-name children still coexist");
    const indexed = await invoke("load_indexed_snapshot");
    assert.ok(indexed.skills.some(skill => skill.name === "chain-beta"), "a cold read of SQLite must also list it");
    record("sqlite-index", { betaId: beta.id, sourceId: beta.sourceId });

    // 5. Update run status: honest per-source outcome with the added Skill.
    const run = snapshot.lastSyncSummary?.updateRun;
    assert.ok(run, "the update run must be recorded");
    const entry = run.sources.find(source => source.folder === path.basename(consumer));
    assert.ok(entry, "the consumer source must have a run entry");
    assert.equal(entry.outcome, "updated");
    assert.deepEqual(entry.addedSkills, ["skills/chain-beta"]);
    assert.deepEqual(entry.addedDependencies, ["skills/shared"]);
    assert.equal(entry.tracking, "origin/main");
    assert.ok(!run.sources.some(source => source.outcome === "deferred"), "nothing may stay waiting in a tiny sandbox");
    record("update-run-status", { outcome: entry.outcome, addedSkills: entry.addedSkills, tracking: entry.tracking });

    // 6. Parent router of this source declares the new child by absolute path.
    const betaForward = forward(betaFile).toLowerCase();
    const routers = routerFiles(snapshot.sourcesDir);
    const owningRouter = routers.find(file => fs.readFileSync(file, "utf8").toLowerCase().includes(betaForward));
    assert.ok(owningRouter, "a parent router must declare chain-beta");
    const routerBody = fs.readFileSync(owningRouter, "utf8");
    assert.ok(!routerBody.includes("qa-other--twin-pack"), "a parent never lists another author's children");
    record("parent-router", { router: owningRouter });

    // 7. Client-visible path: the parent entry Claude Code would open, then
    //    the child path it declares, resolved lexically like real clients.
    const parentName = path.basename(path.dirname(owningRouter));
    const clientEntry = path.join(profile, ".claude", "skills", parentName, "SKILL.md");
    assert.ok(fs.existsSync(clientEntry), `client entry ${clientEntry} must exist`);
    const clientBody = fs.readFileSync(clientEntry, "utf8");
    const declared = clientBody.split(/\r?\n/).filter(line => line.toLowerCase().includes(betaForward));
    assert.ok(declared.length > 0, "client-visible parent must declare chain-beta");
    const declaredPath = /`([^`]+chain-beta[^`]*SKILL\.md)`/i.exec(declared[0])?.[1];
    assert.ok(declaredPath && path.isAbsolute(declaredPath), "declared child path must be absolute");
    assert.ok(fs.readFileSync(path.resolve(declaredPath), "utf8").includes("name: chain-beta"));
    record("client-visible-path", { clientEntry, declaredPath });

    // 8. Offline creator update: this source fails alone, nothing is lost.
    writeFile(path.join(upstream, "skills", "chain-gamma", "SKILL.md"), skillText("chain-gamma"));
    git(upstream, "add", "-A");
    git(upstream, "commit", "-q", "-m", "add chain-gamma");
    git(consumer, "remote", "set-url", "origin", "file:///Z:/skillhub-unreachable-remote");
    snapshot = await invoke("run_skillhub_sync");
    const offline = snapshot.lastSyncSummary.updateRun.sources.find(source => source.folder === path.basename(consumer));
    assert.equal(offline.outcome, "failed", "an unreachable source must be reported as failed, not done");
    assert.ok(fs.existsSync(betaFile), "previous Skills stay on disk");
    assert.ok(snapshot.skills.some(skill => skill.name === "chain-beta"), "previous Skills stay indexed");
    assert.ok(!snapshot.skills.some(skill => skill.name === "chain-gamma"));
    record("offline-isolated-failure", { outcome: offline.outcome, detail: offline.detail });

    // 9. Network back: the next sync completes the missed Skill.
    git(consumer, "remote", "set-url", "origin", `file:///${forward(upstream)}`);
    snapshot = await invoke("run_skillhub_sync");
    assert.ok(fs.existsSync(path.join(consumer, "skills", "chain-gamma", "SKILL.md")));
    assert.ok(snapshot.skills.some(skill => skill.name === "chain-gamma"));
    record("recovery-after-offline", true);

    report.result = "passed";
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  } finally {
    await browser.close().catch(() => {});
  }
}

main().catch(error => {
  report.result = "failed";
  report.error = String(error && error.stack || error);
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.error(error);
  process.exit(1);
});
