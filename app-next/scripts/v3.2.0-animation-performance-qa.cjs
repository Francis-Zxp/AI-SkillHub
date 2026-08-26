const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const baseUrl = process.env.AI_SKILLHUB_PREVIEW_URL || "http://127.0.0.1:4173";
const reportDir = path.resolve(__dirname, "../reports/visual/v3.2.1-animation-performance");
fs.mkdirSync(reportDir, { recursive: true });

async function sampleDraws(page, durationMs) {
  await page.evaluate(() => {
    window.__aiSkillHubDrawCounts = {};
  });
  await page.waitForTimeout(durationMs);
  return page.evaluate(() => ({ ...window.__aiSkillHubDrawCounts }));
}

async function openView(page, theme, view) {
  await page.goto(`${baseUrl}/?theme=${theme}&view=${view}`, { waitUntil: "networkidle" });
  await page.bringToFront();
  await page.waitForTimeout(500);
}

async function launchBrowser() {
  const executablePath = process.env.AI_SKILLHUB_BROWSER_PATH?.trim();
  if (executablePath) return chromium.launch({ headless: true, executablePath });
  try {
    return await chromium.launch({ headless: true, channel: "chrome" });
  } catch {
    return chromium.launch({ headless: true });
  }
}

(async () => {
  let browser;
  try {
  browser = await launchBrowser();
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await page.addInitScript(() => {
    window.__aiSkillHubDrawCounts = {};
    const originalClearRect = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      const className = typeof this.canvas?.className === "string" ? this.canvas.className : "unknown-canvas";
      window.__aiSkillHubDrawCounts[className] = (window.__aiSkillHubDrawCounts[className] || 0) + 1;
      return originalClearRect.apply(this, args);
    };
  });

  await openView(page, "nocturne", "dashboard");
  const universe = page.locator(".skill-universe-canvas");
  await universe.waitFor();
  await page.waitForTimeout(1_000);
  const idleUniverse = await sampleDraws(page, 2_000);
  const homeIdleUniverseFrames = idleUniverse["skill-universe-canvas"] || 0;
  assert.ok(homeIdleUniverseFrames >= 8, `homepage universe drew only ${homeIdleUniverseFrames} idle frames in 2s`);
  assert.ok(homeIdleUniverseFrames <= 24, `homepage universe drew ${homeIdleUniverseFrames} idle frames in 2s`);

  const box = await universe.boundingBox();
  assert.ok(box, "universe canvas has no layout box");
  await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.48);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * 0.68, box.y + box.height * 0.52, { steps: 4 });
  const interactiveUniverse = await sampleDraws(page, 500);
  await page.mouse.up();
  const interactiveFrames = interactiveUniverse["skill-universe-canvas"] || 0;
  assert.ok(interactiveFrames >= 22, `universe interaction drew only ${interactiveFrames} frames in 500ms`);

  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  const blurredUniverse = await sampleDraws(page, 700);
  assert.ok((blurredUniverse["skill-universe-canvas"] || 0) <= 1, "universe kept drawing after window blur");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.screenshot({ path: path.join(reportDir, "nocturne-dashboard.png"), fullPage: true });

  await openView(page, "dark", "dashboard");
  await page.locator(".particle-field-ambient").waitFor();
  await page.locator(".skill-graph-canvas").waitFor();
  await page.waitForTimeout(3_000);
  const classicIdle = await sampleDraws(page, 2_000);
  const ambientFrames = classicIdle["particle-field particle-field-ambient"] || 0;
  const graphFrames = classicIdle["skill-graph-canvas"] || 0;
  assert.ok(ambientFrames <= 1, `ambient field drew ${ambientFrames} frames after settling`);
  assert.ok(graphFrames <= 1, `classic graph drew ${graphFrames} frames after settling`);
  await page.evaluate(() => window.dispatchEvent(new Event("blur")));
  const blurredClassic = await sampleDraws(page, 700);
  assert.ok((blurredClassic["particle-field particle-field-ambient"] || 0) <= 1, "ambient field kept drawing after blur");
  assert.ok((blurredClassic["skill-graph-canvas"] || 0) <= 1, "classic graph kept drawing after blur");
  await page.evaluate(() => window.dispatchEvent(new Event("focus")));
  await page.screenshot({ path: path.join(reportDir, "classic-dashboard.png"), fullPage: true });

  await openView(page, "nocturne", "library");
  assert.equal(await page.locator(".skill-universe-canvas").count(), 0, "universe stayed mounted outside the homepage");
  const backdrop = page.locator(".particle-field-backdrop");
  await backdrop.waitFor({ state: "attached" });
  assert.equal(await backdrop.isVisible(), false, "operational-page backdrop unexpectedly changed the existing hidden UI");
  const hiddenBackdropBacking = await backdrop.evaluate(canvas => ({ height: canvas.height, width: canvas.width }));
  assert.deepEqual(hiddenBackdropBacking, { height: 1, width: 1 }, "hidden operational-page backdrop retained a large backing store");
  const backdropIdle = await sampleDraws(page, 2_000);
  const backdropFrames = backdropIdle["particle-field particle-field-backdrop"] || 0;
  assert.ok(backdropFrames <= 1, `operational-page backdrop drew ${backdropFrames} frames after settling`);
  await page.screenshot({ path: path.join(reportDir, "nocturne-library.png"), fullPage: true });

  const highDpiPage = await browser.newPage({ viewport: { width: 3840, height: 2160 }, deviceScaleFactor: 2 });
  await highDpiPage.goto(`${baseUrl}/?theme=nocturne&view=dashboard`, { waitUntil: "networkidle" });
  const highDpiCanvas = highDpiPage.locator(".skill-universe-canvas");
  await highDpiCanvas.waitFor();
  const highDpiBacking = await highDpiCanvas.evaluate(canvas => ({
    height: canvas.height,
    pixels: canvas.width * canvas.height,
    width: canvas.width
  }));
  assert.ok(highDpiBacking.pixels <= 1_710_000, `4K universe backing store used ${highDpiBacking.pixels} pixels`);
  await highDpiPage.goto(`${baseUrl}/?theme=dark&view=dashboard`, { waitUntil: "networkidle" });
  const highDpiGraph = highDpiPage.locator(".skill-graph-canvas");
  await highDpiGraph.waitFor();
  const highDpiGraphBacking = await highDpiGraph.evaluate(canvas => ({
    height: canvas.height,
    pixels: canvas.width * canvas.height,
    width: canvas.width
  }));
  assert.ok(highDpiGraphBacking.pixels <= 1_710_000, `4K classic graph backing store used ${highDpiGraphBacking.pixels} pixels`);
  await highDpiPage.close();

  const reducedMotionPage = await browser.newPage({ reducedMotion: "reduce", viewport: { width: 1440, height: 900 } });
  await reducedMotionPage.addInitScript(() => {
    window.__aiSkillHubDrawCounts = {};
    const originalClearRect = CanvasRenderingContext2D.prototype.clearRect;
    CanvasRenderingContext2D.prototype.clearRect = function (...args) {
      const className = typeof this.canvas?.className === "string" ? this.canvas.className : "unknown-canvas";
      window.__aiSkillHubDrawCounts[className] = (window.__aiSkillHubDrawCounts[className] || 0) + 1;
      return originalClearRect.apply(this, args);
    };
  });
  await openView(reducedMotionPage, "nocturne", "dashboard");
  await reducedMotionPage.locator(".skill-universe-canvas").waitFor();
  const reducedMotionDraws = await sampleDraws(reducedMotionPage, 1_000);
  const reducedMotionFrames = reducedMotionDraws["skill-universe-canvas"] || 0;
  assert.ok(reducedMotionFrames <= 1, `reduced-motion universe drew ${reducedMotionFrames} idle frames`);
  await reducedMotionPage.close();

  const result = { homeIdleUniverseFrames, interactiveFrames, reducedMotionFrames, ambientFrames, graphFrames, backdropFrames, hiddenBackdropBacking, highDpiBacking, highDpiGraphBacking };
  fs.writeFileSync(path.join(reportDir, "qa.json"), JSON.stringify(result, null, 2));
  console.log("v3.2.1 animation performance QA passed", result);
  } finally {
    await browser?.close().catch(() => undefined);
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
