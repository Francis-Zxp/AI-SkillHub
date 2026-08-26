const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const endpoint = process.env.AI_SKILLHUB_CDP_URL || "http://127.0.0.1:9341";
const processStartedAt = Number(process.env.AI_SKILLHUB_PROCESS_STARTED_AT_MS);
const runLabel = process.env.AI_SKILLHUB_STARTUP_RUN || "startup";

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  assert.ok(value, `${name} is required for formal desktop QA`);
  return value;
}

function isolatedQaPath(name) {
  const candidate = path.resolve(requiredEnvironment(name));
  const tempRoot = path.resolve(process.env.TEMP || process.env.TMP || "");
  const relative = path.relative(tempRoot, candidate);
  assert.ok(
    tempRoot && relative && !relative.startsWith("..") && !path.isAbsolute(relative),
    `${name} must be a dedicated child of the Windows temporary directory`
  );
  return candidate;
}

function buildIdentity() {
  const exePath = path.resolve(requiredEnvironment("AI_SKILLHUB_EXPECTED_EXE_PATH"));
  const expectedSha256 = requiredEnvironment("AI_SKILLHUB_EXPECTED_EXE_SHA256").toLowerCase();
  const pid = Number(requiredEnvironment("AI_SKILLHUB_EXPECTED_PID"));
  const productVersion = requiredEnvironment("AI_SKILLHUB_EXPECTED_PRODUCT_VERSION");
  assert.ok(Number.isInteger(pid) && pid > 0, "AI_SKILLHUB_EXPECTED_PID must be a positive integer");
  assert.ok(fs.statSync(exePath).isFile(), "expected AI SkillHub executable is not a file");
  const actualSha256 = crypto.createHash("sha256").update(fs.readFileSync(exePath)).digest("hex");
  assert.equal(actualSha256, expectedSha256, "the tested executable hash changed before QA");
  return { pid, exePath, sha256: actualSha256, productVersion };
}

async function waitForAppPage(browser) {
  const deadline = Date.now() + 30_000;
  let observed = [];
  while (Date.now() < deadline) {
    const pages = browser.contexts().flatMap(context => context.pages());
    observed = pages.map(page => page.url());
    for (const page of pages) {
      if (/^https?:\/\/tauri\.localhost(?:\/|$)/.test(page.url())) return page;
      if (/AI SkillHub/i.test(await page.title().catch(() => ""))) return page;
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.fail(`No AI SkillHub Tauri page was exposed by ${endpoint}; observed URLs: ${JSON.stringify(observed)}`);
}

assert.ok(Number.isFinite(processStartedAt) && processStartedAt > 0, "AI_SKILLHUB_PROCESS_STARTED_AT_MS is required");
assert.ok(Date.now() - processStartedAt < 45_000, "startup QA attached too late to prove the cold cache path");
const expectedCacheValue = requiredEnvironment("AI_SKILLHUB_EXPECT_CACHED");
assert.ok(["true", "false"].includes(expectedCacheValue), "AI_SKILLHUB_EXPECT_CACHED must be true or false");
const expectCached = expectedCacheValue === "true";
const qaRunId = requiredEnvironment("AI_SKILLHUB_QA_RUN_ID");
assert.match(qaRunId, /^[a-f0-9]{32}$/, "AI_SKILLHUB_QA_RUN_ID must be a lowercase GUID without separators");
assert.match(runLabel, /^[a-z0-9-]+$/, "AI_SKILLHUB_STARTUP_RUN contains unsafe report-name characters");
const qaDataRoot = isolatedQaPath("AI_SKILLHUB_QA_DATA_ROOT");
const identity = buildIdentity();

(async () => {
  let browser;
  try {
    browser = await chromium.connectOverCDP(endpoint);
    const page = await waitForAppPage(browser);

    await page.locator(".shell").waitFor({ timeout: 30_000 });
    const startupLoadPath = await page.waitForFunction(async () => {
      const value = await window.__TAURI_INTERNALS__.invoke("get_startup_load_path");
      return value === "unknown" ? false : value;
    }, undefined, { timeout: 30_000, polling: 100 }).then(handle => handle.jsonValue());
    assert.equal(
      startupLoadPath,
      expectCached ? "sqlite-cache" : "fallback-scan",
      `startup used ${startupLoadPath} instead of the expected ${expectCached ? "SQLite cache" : "fallback scan"}`
    );
    const indexed = await page.waitForFunction(() => {
      const tape = document.querySelector(".atlas-event-tape");
      const skills = Number(tape?.querySelector("span:nth-child(2) strong")?.textContent?.replace(/,/g, "") || 0);
      const sources = Number(tape?.querySelector("span:nth-child(3) strong")?.textContent?.replace(/,/g, "") || 0);
      if (skills < 1 || sources < 1) return false;
      return {
        observedAt: performance.timeOrigin + performance.now(),
        performanceNow: performance.now(),
        skills,
        sources
      };
    }, undefined, { timeout: 30_000 }).then(handle => handle.jsonValue());

    const button = page.locator(".topbar .primary-pill");
    await button.waitFor({ state: "visible" });
    const unlocked = await page.waitForFunction(() => {
      const candidate = document.querySelector(".topbar .primary-pill");
      if (!candidate || candidate.disabled) return false;
      return {
        observedAt: performance.timeOrigin + performance.now(),
        performanceNow: performance.now(),
        label: candidate.textContent?.replace(/\s+/g, " ").trim() || ""
      };
    }, undefined, { timeout: 180_000 }).then(handle => handle.jsonValue());

    const runtimeHydrated = await page.waitForFunction(() => {
      const shell = document.querySelector(".shell");
      if (shell?.getAttribute("data-runtime-hydrated") !== "true") return false;
      const candidate = document.querySelector(".topbar .primary-pill");
      return {
        observedAt: performance.timeOrigin + performance.now(),
        performanceNow: performance.now(),
        controlsStayedUnlocked: Boolean(candidate && !candidate.disabled)
      };
    }, undefined, { timeout: 90_000 }).then(handle => handle.jsonValue());

    const verificationErrors = await page.locator(".status-banner.error").allTextContents();
    const paint = await page.evaluate(() => Object.fromEntries(
      performance.getEntriesByType("paint").map(entry => [entry.name, entry.startTime])
    ));
    const milestones = await page.evaluate(() => Object.fromEntries(
      [
        "ai-skillhub-index-visible",
        "ai-skillhub-controls-unlocked",
        "ai-skillhub-runtime-hydrated"
      ].map(name => [name, performance.getEntriesByName(name).at(0)?.startTime ?? null])
    ));
    const milestoneAt = (name, fallback) => {
      const relative = milestones[name];
      return Number.isFinite(relative) ? indexed.observedAt - indexed.performanceNow + relative : fallback;
    };
    const indexedAt = milestoneAt("ai-skillhub-index-visible", indexed.observedAt);
    const unlockedAt = milestoneAt("ai-skillhub-controls-unlocked", unlocked.observedAt);
    const hydratedAt = milestoneAt("ai-skillhub-runtime-hydrated", runtimeHydrated.observedAt);
    const launchToIndexedMs = Math.round(indexedAt - processStartedAt);
    const launchToUnlockedMs = Math.round(unlockedAt - processStartedAt);
    const launchToRuntimeHydratedMs = Math.round(hydratedAt - processStartedAt);

    assert.deepEqual(verificationErrors, [], "startup verification failed");
    assert.equal(runtimeHydrated.controlsStayedUnlocked, true, "runtime hydration relocked the UI");
    if (expectCached) {
      for (const name of [
        "ai-skillhub-index-visible",
        "ai-skillhub-controls-unlocked",
        "ai-skillhub-runtime-hydrated"
      ]) {
        assert.ok(Number.isFinite(milestones[name]), `missing required performance mark: ${name}`);
      }
      assert.ok(milestones["ai-skillhub-index-visible"] < milestones["ai-skillhub-runtime-hydrated"], "runtime cards hydrated before the SQLite index became visible");
      assert.ok(milestones["ai-skillhub-controls-unlocked"] <= milestones["ai-skillhub-runtime-hydrated"], "controls stayed locked until after runtime hydration");
      assert.ok(launchToIndexedMs > 0 && launchToIndexedMs <= 5_000, `cached index took ${launchToIndexedMs}ms to appear`);
      assert.ok(launchToUnlockedMs > 0 && launchToUnlockedMs <= 8_000, `controls took ${launchToUnlockedMs}ms to unlock`);
      assert.ok(launchToRuntimeHydratedMs > 0 && launchToRuntimeHydratedMs <= 15_000, `runtime hydration took ${launchToRuntimeHydratedMs}ms`);
    }

    const report = {
      run: runLabel,
      endpoint,
      expectCached,
      startupLoadPath,
      qaRunId,
      qaDataRoot,
      buildIdentity: identity,
      processStartedAt,
      indexed,
      unlocked,
      runtimeHydrated,
      milestones,
      launchToIndexedMs,
      launchToUnlockedMs,
      launchToRuntimeHydratedMs,
      verificationErrors,
      paint,
      verifiedAt: new Date().toISOString()
    };
    const reportDir = path.resolve(__dirname, "../reports/desktop/v3.2.1-startup-cache");
    fs.mkdirSync(reportDir, { recursive: true });
    fs.writeFileSync(path.join(reportDir, `${runLabel}-${qaRunId}.json`), JSON.stringify(report, null, 2));
    console.log("Tauri startup cache QA passed", report);
  } finally {
    await browser?.close().catch(() => undefined);
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
