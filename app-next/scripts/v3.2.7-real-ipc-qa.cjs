// Real compiled Tauri/WebView2 verification, not a mocked browser preview.
// Launch only through the companion isolated PowerShell harness.
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
assert.ok(inside(process.env.TEMP, qaRoot) && comparable(qaRoot) !== comparable(process.env.TEMP));
assert.ok(inside(qaRoot, dataRoot) && inside(qaRoot, profile));
const report = { executable: required("AI_SKILLHUB_EXPECTED_EXE_PATH"), sha256: required("AI_SKILLHUB_EXPECTED_EXE_SHA256"), pid: Number(required("AI_SKILLHUB_EXPECTED_PID")), isolatedRoot: qaRoot, dataRoot, profile, mode: "real-compiled-tauri-ipc", checks: [], note: "Explicitly approved isolated desktop run. Fixture folder writes are isolated; GitHub MCP import only reads public configuration and never applies it. No Origin installation or server launch. This is not a blank Windows machine." };
assert.equal(crypto.createHash("sha256").update(fs.readFileSync(report.executable)).digest("hex"), report.sha256);
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
    page.setDefaultTimeout(30000);
    // Also prevent telemetry fetches on reload; the launcher blocks its DNS
    // before the initial page exists, with browser proxy resolution disabled.
    const blockedTelemetryRequests = [];
    await page.context().route("https://vibecafe.ai/**", route => {
      blockedTelemetryRequests.push(route.request().url());
      return route.abort("blockedbyclient");
    });
    const errors = [], cspErrors = [], scriptUrls = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => {
      if (/content security policy|violates.*directive|refused to (load|execute)/i.test(message.text())) cspErrors.push(message.text());
    });
    page.on("response", response => { if (response.request().resourceType() === "script") scriptUrls.push(response.url()); });
    await page.waitForFunction(() => typeof window.__TAURI_INTERNALS__?.invoke === "function");
    const allowed = ["load_indexed_snapshot", "scan_legacy_snapshot", "create_skill_folder", "move_source_skills_to_folder", "import_mcp_github_config"];
    const invoke = async (command, args = {}) => {
      assert.ok(allowed.includes(command), "only reviewed QA commands permitted");
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
    assert.ok(inside(dataRoot, snapshot.sourcesDir) && inside(dataRoot, snapshot.skillsDir));
    record("runtime-root-isolation", { root: snapshot.root, sourcesDir: snapshot.sourcesDir, skillsDir: snapshot.skillsDir });
    snapshot = await invoke("scan_legacy_snapshot");
    const categories = [{ source: "qa-research", name: "QA Research", color: "blue" }, { source: "qa-writing", name: "QA Writing", color: "emerald" }];
    for (const category of categories) {
      const source = snapshot.sources.find(source => path.basename(source.localPath) === category.source);
      assert.ok(source, `fixture source ${category.source} must be indexed`);
      const folders = await invoke("create_skill_folder", { name: category.name, note: "Isolated sky island QA", color: category.color });
      category.id = folders.find(folder => folder.name === category.name).id;
      await invoke("move_source_skills_to_folder", { sourceId: source.id, folderId: category.id });
    }
    record("two-categories-created-via-native-ipc", categories);
    await page.evaluate(() => {
      localStorage.setItem("ai-skillhub-lang", "en");
      localStorage.setItem("skillhub-home-visual", "islands");
      localStorage.setItem("ai-skillhub-theme", "atlas-light");
    });
    await page.setViewportSize({ width: 3840, height: 2160 });
    await page.reload();
    const ready = async () => {
      await page.locator('.sky-islands[data-status="ready"]').waitFor();
      await page.waitForFunction(() => Number(document.querySelector(".sky-scene-host")?.dataset.frames) > 0);
      assert.equal(await page.locator("canvas.sky-world-canvas").count(), 1);
    };
    await ready();
    for (const category of categories) assert.equal(await page.locator(".sky-island-label").filter({ hasText: category.name }).count(), 1);
    const metrics = await page.evaluate(() => ({ width: innerWidth, height: innerHeight, scrollWidth: document.documentElement.scrollWidth, canvas: { width: document.querySelector("canvas.sky-world-canvas").width, height: document.querySelector("canvas.sky-world-canvas").height }, scene: { ...document.querySelector(".sky-scene-host").dataset }, labels: [...document.querySelectorAll(".sky-island-label")].map(label => ({ text: label.textContent, box: label.getBoundingClientRect().toJSON() })) }));
    assert.equal(metrics.width, 3840); assert.equal(metrics.height, 2160);
    assert.ok(metrics.canvas.width > 0 && metrics.canvas.height > 0);
    assert.ok(metrics.scrollWidth <= metrics.width + 1);
    const screenshot = reportPath.replace(/\.json$/, "-4k.png");
    await page.screenshot({ path: screenshot });
    assert.ok(scriptUrls.some(url => /world.*\.js/.test(url)), "sky world chunk must load from packaged assets");
    const externalScripts = scriptUrls.filter(url => !/^https?:\/\/(?:tauri|ipc)\.localhost\//.test(url) && !/^(?:tauri|ipc):/.test(url));
    assert.deepEqual(externalScripts, [], "no external script may load during the isolated run");
    assert.ok(blockedTelemetryRequests.length > 0, "existing telemetry script request must be explicitly blocked");
    assert.deepEqual(cspErrors, []); assert.deepEqual(errors, []);
    record("packaged-three-scene-ready-4k-no-csp-errors", { metrics, screenshot, scriptUrls, externalScripts, blockedTelemetryRequests, telemetryBlocked: "Launcher DNS rule from startup; Playwright network abort before reload" });
    for (const [index, category] of categories.entries()) {
      const label = page.locator(".sky-island-label").filter({ hasText: category.name });
      await label.focus(); await page.keyboard.press(index === 0 ? "Enter" : "Space");
      await page.locator(".library-tree").waitFor();
      assert.ok((await page.locator(".skill-folder-target.active").innerText()).includes(category.name));
      const titles = await page.locator(".source-group-title strong").allTextContents();
      assert.ok(titles.some(title => title.includes(category.source)), `folder ${category.name} must show its own source`);
      assert.ok(!titles.some(title => title.includes(categories[1 - index].source)), "other category must not leak into selection");
      await page.locator(".nav-item").filter({ hasText: "Dashboard" }).click(); await ready();
    }
    record("keyboard-island-navigation-opens-corresponding-category");
    const preview = await invoke("import_mcp_github_config", { request: { source: "https://github.com/Ge-Shun/origin-mcp.git" } });
    assert.ok(preview.sourceDisplay.endsWith("/README.md"));
    const origin = preview.candidates.find(candidate => candidate.serverName === "origin");
    assert.ok(origin); assert.equal(origin.command, "python");
    assert.deepEqual(origin.args, ["-m", "origin_mcp"]);
    assert.ok(preview.noticeCodes.includes("origin-prerequisites"));
    assert.ok(preview.noticeCodes.includes("configuration-only"));
    assert.ok(preview.noticeCodes.includes("readme-example"));
    record("readonly-origin-mcp-native-preview", preview);
    assert.deepEqual(cspErrors, []); assert.deepEqual(errors, []);
    report.passed = true;
    report.approvalAudit = "A prior retry was rejected by automatic approval because the existing telemetry endpoint might receive QA data. The approved safer alternative blocks vibecafe.ai from WebView startup with a DNS failure rule and proxy disabled, then aborts its requests through Playwright. Product settings are unchanged.";
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    console.log(`Real v3.2.7 desktop QA passed: ${reportPath}`);
  } catch (error) {
    report.passed = false; report.error = String(error);
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
    throw error;
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
