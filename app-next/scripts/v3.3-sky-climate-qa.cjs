// Browser QA for island climates and weather (v3.3). Drives the browser
// preview with demo islands, every weather and several times of day, saves
// screenshots and reports console errors, frame rate and draw calls.
//
//   node scripts/v3.3-sky-climate-qa.cjs [baseUrl] [outDir] [mode]
//   mode: all (default) | climates | weather | perf | ui
const path = require("node:path");
const fs = require("node:fs");
const { chromium } = require("playwright");

const base = process.argv[2] ?? "http://127.0.0.1:1431/";
const out = process.argv[3] ?? path.join(__dirname, "..", "reports", "sky-climate-qa");
const mode = process.argv[4] ?? "all";
fs.mkdirSync(out, { recursive: true });

const WEATHERS = ["clear", "cloudy", "rain", "storm", "snow", "fog", "rainbow", "petals", "aurora"];

async function open(browser, { theme = "sky-noon", weather = "auto", seed = "", demo = 0, width = 1600, height = 900, reduced = false, lang = "zh", lowPower = "0" } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: reduced ? "reduce" : "no-preference" });
  await context.addInitScript(([theme, weather, seed, demo, lang, lowPower]) => {
    try {
      localStorage.setItem("ai-skillhub-lang", lang);
      localStorage.setItem("ai-skillhub-theme", theme);
      localStorage.setItem("ai-skillhub-theme-sky-default-v2", "1");
      localStorage.setItem("skillhub-sky-weather", weather);
      localStorage.setItem("skillhub-sky-low-power", lowPower);
      localStorage.setItem("skillhub-sky-paused", "0");
      if (seed) localStorage.setItem("skillhub-sky-world-seed", seed);
      if (demo) localStorage.setItem("skillhub-sky-demo-islands", String(demo));
      else localStorage.removeItem("skillhub-sky-demo-islands");
    } catch { /* storage unavailable */ }
  }, [theme, weather, seed, demo, lang, lowPower]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(`pageerror: ${error.message}`));
  page.on("console", message => {
    if (message.type() === "error" && !/vibecafe|ERR_FAILED|404|favicon/i.test(message.text())) errors.push(`console: ${message.text().slice(0, 300)}`);
  });
  await page.goto(base, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.querySelector(".sky-islands")?.getAttribute("data-status") === "ready", null, { timeout: 45000 });
  await page.waitForFunction(() => Number(document.querySelector(".sky-scene-host")?.skyWorldStats?.().frames ?? 0) > 20, null, { timeout: 30000 }).catch(() => undefined);
  return { context, page, errors };
}

/** Exact frames per second from the world's own counter (the host's
 * dataset is only refreshed once a second). */
async function frameRate(page, seconds = 4) {
  const read = () => page.evaluate(() => ({ frames: Number(document.querySelector(".sky-scene-host")?.skyWorldStats?.().frames ?? 0), at: performance.now() }));
  const before = await read();
  await page.waitForTimeout(seconds * 1000);
  const after = await read();
  return Math.round((after.frames - before.frames) / ((after.at - before.at) / 1000) * 10) / 10;
}

const hostData = page => page.evaluate(() => {
  const host = document.querySelector(".sky-scene-host");
  const stats = host?.skyWorldStats?.() ?? {};
  return { ...host?.dataset, drawCalls: stats.drawCalls, weatherCalls: stats.weatherDrawCalls, triangles: stats.triangles, frames: stats.frames, status: document.querySelector(".sky-islands")?.getAttribute("data-status") };
});

(async () => {
  const browser = await chromium.launch({ channel: "chrome", args: ["--use-angle=d3d11", "--ignore-gpu-blocklist"] });
  const report = [];
  const shot = async (page, name) => {
    const file = path.join(out, `${name}.png`);
    await page.screenshot({ path: file });
    return file;
  };
  try {
    if (mode === "all" || mode === "climates") {
      for (const theme of ["sky-noon", "sky-night", "sky-dawn", "sky-golden"]) {
        const { context, page, errors } = await open(browser, { theme, weather: "clear", seed: process.env.SKY_SEED ?? "7", demo: 9 });
        await page.waitForTimeout(1500);
        const data = await hostData(page);
        report.push({ name: `climates-${theme}`, climates: data.climates, drawCalls: data.drawCalls, errors });
        await shot(page, `climates-${theme}`);
        await context.close();
      }
    }
    if (mode === "all" || mode === "weather") {
      for (const theme of ["sky-noon", "sky-night"]) {
        for (const weather of WEATHERS) {
          if (weather === "aurora" && theme !== "sky-night") continue;
          const { context, page, errors } = await open(browser, { theme, weather, seed: process.env.SKY_SEED ?? "7", demo: 3 });
          await page.waitForTimeout(weather === "storm" ? 2600 : 2000);
          const data = await hostData(page);
          report.push({ name: `weather-${weather}-${theme}`, weather: data.weather, weatherCalls: data.weatherCalls, drawCalls: data.drawCalls, errors });
          await shot(page, `weather-${weather}-${theme}`);
          await context.close();
        }
      }
      // A few weathers in the morning and the golden hour too.
      for (const [theme, weather] of [["sky-dawn", "fog"], ["sky-dawn", "rainbow"], ["sky-golden", "petals"], ["sky-golden", "cloudy"], ["sky-dawn", "snow"]]) {
        const { context, page, errors } = await open(browser, { theme, weather, seed: process.env.SKY_SEED ?? "7", demo: 3 });
        await page.waitForTimeout(2000);
        const data = await hostData(page);
        report.push({ name: `weather-${weather}-${theme}`, weather: data.weather, weatherCalls: data.weatherCalls, drawCalls: data.drawCalls, errors });
        await shot(page, `weather-${weather}-${theme}`);
        await context.close();
      }
    }
    if (mode === "all" || mode === "perf") {
      for (const weather of ["clear", "storm"]) {
        const { context, page, errors } = await open(browser, { theme: "sky-noon", weather, seed: process.env.SKY_SEED ?? "7", demo: 8, width: 1920, height: 1080 });
        await page.waitForTimeout(1500);
        const fps = await frameRate(page, 5);
        const data = await hostData(page);
        report.push({ name: `perf-${weather}-1920x1080`, islands: await page.evaluate(() => document.querySelectorAll(".sky-island-label").length), fps, drawCalls: data.drawCalls, weatherCalls: data.weatherCalls, triangles: data.triangles, pixelRatio: data.pixelRatio, errors });
        await shot(page, `perf-${weather}-1920x1080`);
        await context.close();
      }
      // Reduced motion: a still frame, no lightning; low power: fewer pixels.
      const still = await open(browser, { theme: "sky-noon", weather: "storm", seed: "7", demo: 3, reduced: true });
      const a = await still.page.evaluate(() => Number(document.querySelector(".sky-scene-host")?.skyWorldStats?.().frames ?? 0));
      await still.page.waitForTimeout(2500);
      const b = await still.page.evaluate(() => Number(document.querySelector(".sky-scene-host")?.skyWorldStats?.().frames ?? 0));
      report.push({ name: "reduced-motion-storm", framesIn2500ms: b - a, pauseDisabled: await still.page.evaluate(() => document.querySelector(".sky-controls .sky-control-compact:nth-child(2)")?.disabled), storedPause: await still.page.evaluate(() => localStorage.getItem("skillhub-sky-paused")), errors: still.errors });
      await still.context.close();
    }
    if (mode === "all" || mode === "ui") {
      const { context, page, errors } = await open(browser, { theme: "sky-golden", weather: "auto", seed: "7", demo: 4 });
      await page.click(".sky-world-toggle");
      await page.waitForSelector(".sky-world-panel");
      await shot(page, "ui-world-panel-golden");
      const before = await hostData(page);
      await page.click(".sky-reroll");
      await page.waitForFunction(previous => document.querySelector(".sky-scene-host")?.dataset.climates !== previous, before.climates, { timeout: 30000 });
      await page.waitForTimeout(1500);
      const after = await hostData(page);
      await shot(page, "ui-after-reroll-golden");
      await page.click(".sky-weather-options button[aria-checked] >> nth=4");
      await page.waitForTimeout(1500);
      const pinned = await hostData(page);
      report.push({ name: "ui-reroll", climatesBefore: before.climates, climatesAfter: after.climates, seed: await page.evaluate(() => localStorage.getItem("skillhub-sky-world-seed")), pinnedWeather: pinned.weather, storedWeather: await page.evaluate(() => localStorage.getItem("skillhub-sky-weather")), errors });
      await context.close();
      const english = await open(browser, { theme: "sky-noon", weather: "clear", seed: "7", demo: 0, lang: "en" });
      await shot(english.page, "ui-english-noon");
      report.push({ name: "ui-english", labels: await english.page.evaluate(() => [...document.querySelectorAll(".sky-island-label")].map(label => `${label.title} | ${label.querySelector("span")?.textContent}`)), summary: await english.page.evaluate(() => document.querySelector(".sky-heading p")?.textContent), errors: english.errors });
      await english.context.close();
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(out, "report.json"), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch(error => {
  console.error(error);
  process.exit(1);
});
