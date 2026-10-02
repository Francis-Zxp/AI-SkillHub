// v3.2.8 sky island QA on the browser preview (vite dev server):
// frame rate, pause, reduced motion, low power, WebGL loss fallback, island
// click into its category, resource release across page switches, and the
// 4K / HiDPI pixel budget. Writes a JSON report and screenshots.
//   node scripts/v3.2.8-sky-qa.cjs [outDir] [--url=http://127.0.0.1:1420/]
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const args = process.argv.slice(2);
const outDir = path.resolve(args.find(arg => !arg.startsWith("--")) ?? "reports/visual/v3.2.8-sky");
const url = (args.find(arg => arg.startsWith("--url=")) ?? "--url=http://127.0.0.1:1420/").slice(6);
const report = { url, startedAt: new Date().toISOString(), checks: [] };
const record = (name, ok, detail) => {
  report.checks.push({ name, ok, ...detail });
  console.log(`${ok ? "PASS" : "FAIL"} ${name} ${JSON.stringify(detail)}`);
};

async function openSky(browser, { width = 1920, height = 1080, dpr = 1, theme = "sky-dusk", reducedMotion = "no-preference" } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr, reducedMotion });
  await context.addInitScript(([themeName]) => {
    try {
      localStorage.setItem("ai-skillhub-lang", "zh");
      localStorage.setItem("ai-skillhub-theme", themeName);
      localStorage.setItem("skillhub-sky-paused", "0");
      localStorage.removeItem("skillhub-sky-low-power");
    } catch {}
  }, [theme]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(url, { waitUntil: "networkidle" });
  const islands = page.getByRole("button", { name: /^群岛$/ });
  if (await islands.count()) await islands.first().click();
  await page.waitForFunction(() => document.querySelector(".sky-islands")?.getAttribute("data-status") === "ready", null, { timeout: 30000 });
  await page.waitForTimeout(1500);
  return { context, page, errors };
}

const frames = page => page.evaluate(() => Number(document.querySelector(".sky-scene-host")?.dataset.frames ?? 0));
const hostData = page => page.evaluate(() => ({ ...document.querySelector(".sky-scene-host")?.dataset }));

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ channel: "chrome", args: ["--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-precise-memory-info"] });
  try {
    // 1. Frame rate while idle-animating, and the draw budget.
    {
      const { context, page, errors } = await openSky(browser);
      const before = await frames(page);
      await page.waitForTimeout(5000);
      const after = await frames(page);
      const fps = (after - before) / 5;
      const data = await hostData(page);
      record("ambient frame rate is capped and steady", fps >= 20 && fps <= 40, { fps, ...data });
      await page.screenshot({ path: path.join(outDir, "sky-dusk-1920x1080.png") });

      // 2. Pause stops rendering.
      await page.getByRole("button", { name: /暂停动画/ }).click();
      await page.waitForTimeout(600);
      const pausedA = await frames(page);
      await page.waitForTimeout(2000);
      const pausedB = await frames(page);
      record("pause stops the render loop", pausedB - pausedA <= 1, { framesWhilePaused: pausedB - pausedA });
      await page.getByRole("button", { name: /播放动画/ }).click();

      // 3. Low power lowers the pixel ratio and keeps working.
      await page.getByRole("button", { name: /省电模式/ }).click();
      await page.waitForTimeout(1500);
      const low = await hostData(page);
      record("low power mode caps the pixel ratio", Number(low.pixelRatio) <= 1, low);
      await page.getByRole("button", { name: /省电模式/ }).click();

      // 4. Clicking an island label opens its category in the library.
      await page.locator(".sky-island-label").first().click();
      await page.waitForTimeout(1200);
      const libraryActive = await page.evaluate(() => document.querySelector(".shell")?.className.includes("page-library"));
      record("an island opens its category", Boolean(libraryActive), {});

      // 5. Leaving the page releases the scene; coming back rebuilds one.
      const memory = [];
      for (let round = 0; round < 4; round++) {
        await page.locator(".sidebar .nav-item").first().click();
        await page.waitForFunction(() => document.querySelector(".sky-islands")?.getAttribute("data-status") === "ready", null, { timeout: 30000 });
        await page.waitForTimeout(800);
        const canvases = await page.evaluate(() => document.querySelectorAll("canvas.sky-world-canvas").length);
        await page.locator(".sidebar .nav-item").nth(1).click();
        await page.waitForTimeout(800);
        const leftBehind = await page.evaluate(() => document.querySelectorAll("canvas.sky-world-canvas").length);
        const heap = await page.evaluate(() => (performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null));
        memory.push({ round, canvases, leftBehind, heapMb: heap });
      }
      const released = memory.every(item => item.canvases === 1 && item.leftBehind === 0);
      const growth = memory.at(-1).heapMb !== null ? memory.at(-1).heapMb - memory[0].heapMb : null;
      record("page switches release the scene", released && (growth === null || growth < 60), { memory, heapGrowthMb: growth });
      record("no page errors", errors.length === 0, { errors: errors.slice(0, 5) });
      await context.close();
    }

    // 6. Reduced motion: the scene draws, then stays still.
    {
      const { context, page } = await openSky(browser, { reducedMotion: "reduce" });
      await page.waitForTimeout(800);
      const a = await frames(page);
      await page.waitForTimeout(2500);
      const b = await frames(page);
      record("reduced motion leaves a still scene", b - a <= 2, { framesInStillPeriod: b - a });
      await context.close();
    }

    // 7. WebGL context loss falls back to the category list.
    {
      const { context, page } = await openSky(browser, { theme: "sky-day" });
      await page.evaluate(() => {
        const canvas = document.querySelector("canvas.sky-world-canvas");
        const gl = canvas.getContext("webgl2") || canvas.getContext("webgl");
        gl.getExtension("WEBGL_lose_context").loseContext();
      });
      await page.waitForTimeout(1200);
      const state = await page.evaluate(() => ({
        status: document.querySelector(".sky-islands")?.getAttribute("data-status"),
        rows: document.querySelectorAll(".sky-navigation-row").length,
        canvas: document.querySelectorAll("canvas.sky-world-canvas").length
      }));
      record("WebGL loss shows the category list", state.status === "fallback" && state.rows > 0 && state.canvas === 0, state);
      await page.screenshot({ path: path.join(outDir, "sky-webgl-lost.png") });
      await context.close();
    }

    // 8. 4K and HiDPI stay within the pixel budget and render sharp text.
    for (const viewport of [{ width: 3840, height: 2160, dpr: 1 }, { width: 1920, height: 1080, dpr: 2 }, { width: 1536, height: 864, dpr: 1.25 }]) {
      const { context, page } = await openSky(browser, { ...viewport, theme: "sky-day" });
      const data = await hostData(page);
      const backing = await page.evaluate(() => {
        const canvas = document.querySelector("canvas.sky-world-canvas");
        return { width: canvas.width, height: canvas.height };
      });
      const pixels = backing.width * backing.height;
      record(`pixel budget at ${viewport.width}x${viewport.height}@${viewport.dpr}`, pixels <= 8_400_000, { backing, pixelRatio: data.pixelRatio });
      await page.screenshot({ path: path.join(outDir, `sky-day-${viewport.width}x${viewport.height}@${viewport.dpr}.png`) });
      await context.close();
    }
  } finally {
    await browser.close();
  }
  report.finishedAt = new Date().toISOString();
  report.passed = report.checks.every(check => check.ok);
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(`${report.passed ? "ALL PASS" : "FAILURES"} -> ${path.join(outDir, "report.json")}`);
  assert.ok(report.passed);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
