// Browser QA for the v3.3 sky bugs (bugs.json, area "visual") and the sleep
// behaviour. Drives the Vite preview in real Chrome and prints one line per
// check; exits non-zero when any check fails.
//
//   node scripts/v3.3-sky-bugs-qa.cjs [baseUrl] [shotDir]
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const base = process.argv[2] ?? "http://127.0.0.1:1431/";
const shots = process.argv[3] ?? path.join(__dirname, "..", "reports", "sky-bugs-qa");
fs.mkdirSync(shots, { recursive: true });
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
};

async function open(browser, { theme = "sky-noon", width = 1600, height = 900, scale = 1, reduced = false, storage = {}, waitReady = true } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: scale, reducedMotion: reduced ? "reduce" : "no-preference" });
  await context.addInitScript(([theme, storage]) => {
    try {
      localStorage.setItem("ai-skillhub-lang", "zh");
      localStorage.setItem("ai-skillhub-theme", theme);
      localStorage.setItem("ai-skillhub-theme-sky-default-v2", "1");
      localStorage.setItem("skillhub-sky-world-seed", "7");
      localStorage.setItem("skillhub-sky-weather", "clear");
      if (!sessionStorage.getItem("qa-storage-applied")) {
        for (const [key, value] of Object.entries(storage)) {
          if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
        }
        sessionStorage.setItem("qa-storage-applied", "1");
      }
    } catch { /* storage unavailable */ }
  }, [theme, storage]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error" && !/vibecafe|ERR_FAILED|404|favicon/i.test(message.text())) errors.push(message.text().slice(0, 200)); });
  await page.goto(base, { waitUntil: "networkidle" });
  if (waitReady) {
    await page.waitForFunction(() => {
      const status = document.querySelector(".sky-islands")?.getAttribute("data-status");
      return status === "ready" || status === "off";
    }, null, { timeout: 45000 });
    await page.waitForTimeout(1200);
  }
  return { context, page, errors };
}

const activePage = page => page.evaluate(() => (document.querySelector(".shell")?.className.match(/page-([a-z-]+)/) ?? [])[1] ?? "");

/** Press on a label for `hold` ms with a real mouse, then release. */
async function pressLabel(page, index, hold) {
  const box = await page.locator(".sky-island-label").nth(index).boundingBox();
  if (!box) return false;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(hold);
  await page.mouse.up();
  await page.waitForTimeout(400);
  return true;
}

(async () => {
  const browser = await chromium.launch({ channel: "chrome", args: ["--use-angle=d3d11", "--ignore-gpu-blocklist"] });
  const allErrors = [];
  try {
    // #36 Clicking an island label opens the category, with and without motion.
    for (const reduced of [false, true]) {
      for (const hold of [30, 250]) {
        const { context, page, errors } = await open(browser, { reduced });
        // Labels hidden by overlap are not clickable; pick the first visible one.
        const index = await page.evaluate(() => [...document.querySelectorAll(".sky-island-label")].findIndex(label => getComputedStyle(label).visibility === "visible"));
        await pressLabel(page, index, hold);
        check(`#36 label press ${hold} ms opens the category${reduced ? " (reduced motion)" : ""}`, (await activePage(page)) === "library", await activePage(page));
        allErrors.push(...errors);
        await context.close();
      }
    }

    // #38 Reduced motion is not saved as a pause; Play is disabled with a reason.
    {
      const { context, page, errors } = await open(browser, { reduced: true, storage: { "skillhub-sky-paused": null } });
      const state = await page.evaluate(() => {
        const button = document.querySelectorAll(".sky-controls .sky-control-compact")[1];
        return { stored: localStorage.getItem("skillhub-sky-paused"), disabled: button?.disabled, title: button?.title };
      });
      check("#38 reduced motion does not store a pause", state.stored === null, state);
      check("#38 play/pause is disabled under reduced motion, with a reason", state.disabled === true && /减少动态效果/.test(state.title ?? ""), state.title);
      allErrors.push(...errors);
      await context.close();
    }

    // #41 Low power lowers the resolution at once (DPR 2).
    {
      const { context, page, errors } = await open(browser, { scale: 2, storage: { "skillhub-sky-low-power": "0" } });
      const before = await page.evaluate(() => document.querySelector(".sky-scene-host").skyWorldStats().pixelRatio);
      await page.locator(".sky-controls .sky-control-compact").nth(2).click();
      await page.waitForTimeout(600);
      const after = await page.evaluate(() => document.querySelector(".sky-scene-host").skyWorldStats().pixelRatio);
      check("#41 low power drops the pixel ratio at runtime", before > 1.2 && after <= 1, { before, after });
      check("memory: pixel budget at DPR 2 is at most 3.7 Mpx", before * before * 1600 * 900 <= 3_750_000, { pixels: Math.round(before * before * 1600 * 900) });
      allErrors.push(...errors);
      await context.close();
    }

    // Weather: a storm stays within 4 extra draw calls; low power draws fewer
    // particles; reduced motion keeps one still frame (no lightning loop).
    {
      const { context, page, errors } = await open(browser, { storage: { "skillhub-sky-weather": "storm", "skillhub-sky-low-power": "0" } });
      await page.evaluate(() => { localStorage.setItem("skillhub-sky-weather", "storm"); });
      await page.locator(".sky-world-toggle").click();
      await page.locator(".sky-weather-options button").nth(4).click();
      await page.keyboard.press("Escape");
      await page.waitForTimeout(1500);
      const normal = await page.evaluate(() => document.querySelector(".sky-scene-host").skyWorldStats());
      await page.locator(".sky-controls .sky-control-compact").nth(2).click();
      await page.waitForTimeout(800);
      const low = await page.evaluate(() => document.querySelector(".sky-scene-host").skyWorldStats());
      check("storm adds at most 4 draw calls", normal.weather === "storm" && normal.weatherDrawCalls <= 4, { weather: normal.weather, calls: normal.weatherDrawCalls });
      check("low power draws fewer weather particles", low.weatherParticles > 0 && low.weatherParticles < normal.weatherParticles, { normal: normal.weatherParticles, low: low.weatherParticles });
      allErrors.push(...errors);
      await context.close();
    }

    // #45 Simple view under 1000 px still names its only control.
    {
      const { context, page, errors } = await open(browser, { width: 860, height: 700, storage: { "skillhub-sky-scene": "0" } });
      const control = await page.evaluate(() => {
        const buttons = [...document.querySelectorAll(".sky-controls button")];
        const text = buttons[0]?.querySelector("span:last-child");
        return { count: buttons.length, text: text?.textContent, display: text ? getComputedStyle(text).display : "" };
      });
      check("#45 the simple-view toggle shows its words below 1000 px", control.count === 1 && control.display !== "none" && Boolean(control.text), control);
      // #48 Simple-view cards keep the button role inside a list item.
      const roles = await page.evaluate(() => [...document.querySelectorAll(".sky-board-card")].map(card => ({ role: card.getAttribute("role"), parent: card.parentElement?.getAttribute("role") })));
      check("#48 category cards are buttons inside list items", roles.length > 0 && roles.every(item => item.role === null && item.parent === "listitem"), roles.slice(0, 2));
      allErrors.push(...errors);
      await context.close();
    }

    // #47 Navigation, credits and the world panel never cover each other.
    {
      const { context, page, errors } = await open(browser, { width: 860, height: 700, theme: "sky-night" });
      await page.getByRole("button", { name: /分类导航/ }).click();
      await page.locator(".sky-credits-toggle").click();
      const open1 = await page.evaluate(() => ({ navigation: Boolean(document.querySelector(".sky-navigation")), credits: Boolean(document.querySelector(".sky-credits")) }));
      await page.locator(".sky-world-toggle").click();
      const open2 = await page.evaluate(() => ({ credits: Boolean(document.querySelector(".sky-credits")), world: Boolean(document.querySelector(".sky-world-panel")) }));
      check("#47 opening credits closes navigation; the world panel closes credits", !open1.navigation && open1.credits && !open2.credits && open2.world, { open1, open2 });
      // An empty search does not claim "no match".
      await page.locator(".sky-world-toggle").click();
      await page.getByRole("button", { name: /分类导航/ }).click();
      const noMatch = await page.evaluate(() => /没有匹配/.test(document.querySelector(".sky-navigation")?.textContent ?? ""));
      check("#46 navigation with an empty query does not say nothing matches", !noMatch);
      allErrors.push(...errors);
      await context.close();
    }

    // Plain Chinese on the islands (Skills review): no "Skills"/"Prompt" words.
    {
      const { context, page, errors } = await open(browser);
      const texts = await page.evaluate(() => [
        document.querySelector(".sky-heading p")?.textContent ?? "",
        ...[...document.querySelectorAll(".sky-island-label span")].map(span => span.textContent ?? ""),
        document.querySelector(".sky-caption span")?.textContent ?? ""
      ]);
      check("zh island text has no English words", texts.every(text => !/Skills?|Prompt/.test(text)), texts.slice(0, 3));
      // Hover tooltip carries the climate.
      const title = await page.locator(".sky-island-label").first().getAttribute("title");
      check("label tooltip names the climate", /·\s*(草原|雪山|沙漠|热带|秋林|火山|水晶|梯田)/.test(title ?? ""), title);
      allErrors.push(...errors);
      await context.close();
    }

    // Overlay blocks above the scene: the islands move down into the free band.
    {
      const { context, page, errors } = await open(browser, { height: 900 });
      const labelTops = () => page.evaluate(() => [...document.querySelectorAll(".sky-island-label")].filter(label => getComputedStyle(label).visibility === "visible").map(label => label.getBoundingClientRect().top));
      const before = await labelTops();
      await page.evaluate(() => {
        const block = document.createElement("div");
        block.dataset.skyOverlay = "";
        block.id = "qa-overlay";
        Object.assign(block.style, { position: "absolute", left: "120px", right: "40px", top: "90px", height: "330px", background: "rgba(255,255,255,.55)", zIndex: "40" });
        document.querySelector(".dashboard-hero").append(block);
        window.dispatchEvent(new Event("resize"));
      });
      // The world re-measures on its next resize; nudge the viewport.
      await page.setViewportSize({ width: 1600, height: 901 });
      await page.waitForTimeout(1500);
      const after = await labelTops();
      await page.screenshot({ path: path.join(shots, "overlay-block.png") });
      const overlayBottom = 420;
      check("[data-sky-overlay] pushes the islands below the block", after.length >= Math.min(3, before.length) && after.every(top => top > overlayBottom - 4), { before: before.map(Math.round), after: after.map(Math.round) });
      const spread = Math.max(...after) - Math.min(...after);
      check("islands keep a usable size under a tall overlay (not a dot)", spread > 120, { spread: Math.round(spread) });
      allErrors.push(...errors);
      await context.close();
    }

    // Sleep: out of sight for the sleep delay, the GPU world goes and a still stays.
    {
      const { context, page, errors } = await open(browser, { storage: { "skillhub-sky-sleep-ms": "1500" } });
      await page.waitForTimeout(800);
      await page.screenshot({ path: path.join(shots, "sleep-0-awake.png") });
      await page.evaluate(() => window.dispatchEvent(new CustomEvent("skillhub-app-hidden", { detail: true })));
      await page.waitForFunction(() => document.querySelector(".sky-scene-host")?.dataset.sleeping === "1", null, { timeout: 8000 }).catch(() => undefined);
      await page.waitForTimeout(600);
      const asleep = await page.evaluate(() => ({ canvases: document.querySelectorAll(".sky-world-canvas").length, still: Boolean(document.querySelector(".sky-world-still")), labels: [...document.querySelectorAll(".sky-island-label")].filter(label => getComputedStyle(label).visibility === "visible").length }));
      await page.screenshot({ path: path.join(shots, "sleep-1-still.png") });
      check("sleep: no WebGL canvas, a still image and the labels stay", asleep.canvases === 0 && asleep.still && asleep.labels > 0, asleep);
      const started = Date.now();
      await page.mouse.move(800, 600);
      await page.mouse.move(820, 610);
      await page.waitForFunction(() => document.querySelectorAll(".sky-world-canvas").length === 1 && !document.querySelector(".sky-world-still"), null, { timeout: 8000 }).catch(() => undefined);
      const wakeMs = Date.now() - started;
      await page.waitForTimeout(500);
      await page.screenshot({ path: path.join(shots, "sleep-2-woken.png") });
      const woken = await page.evaluate(() => ({ canvases: document.querySelectorAll(".sky-world-canvas").length, still: Boolean(document.querySelector(".sky-world-still")), status: document.querySelector(".sky-islands")?.getAttribute("data-status") }));
      check("wake on pointer: the world is back within about a second", woken.canvases === 1 && !woken.still && woken.status === "ready" && wakeMs < 1500, { ...woken, wakeMs });
      // Compare the still with the live frames (mean absolute pixel difference).
      const diff = await page.evaluate(async files => {
        const load = src => new Promise(resolve => { const image = new Image(); image.onload = () => resolve(image); image.src = src; });
        const [a, b, c] = await Promise.all(files.map(load));
        const read = image => { const canvas = document.createElement("canvas"); canvas.width = 400; canvas.height = 225; const context = canvas.getContext("2d"); context.drawImage(image, 0, 0, 400, 225); return context.getImageData(0, 0, 400, 225).data; };
        const [pa, pb, pc] = [a, b, c].map(read);
        const mean = (x, y) => { let sum = 0; for (let index = 0; index < x.length; index += 4) sum += Math.abs(x[index] - y[index]) + Math.abs(x[index + 1] - y[index + 1]) + Math.abs(x[index + 2] - y[index + 2]); return sum / (x.length / 4) / 3; };
        return { awakeVsStill: mean(pa, pb), stillVsWoken: mean(pb, pc) };
      }, ["sleep-0-awake.png", "sleep-1-still.png", "sleep-2-woken.png"].map(name => `data:image/png;base64,${fs.readFileSync(path.join(shots, name)).toString("base64")}`));
      check("the still looks like the live scene (mean pixel difference < 4/255)", diff.awakeVsStill < 4 && diff.stillVsWoken < 4, { awakeVsStill: Number(diff.awakeVsStill.toFixed(2)), stillVsWoken: Number(diff.stillVsWoken.toFixed(2)) });
      allErrors.push(...errors);
      await context.close();
    }

    // Many categories (#37): islands stay visible, rendering stays bounded.
    {
      const { context, page, errors } = await open(browser, { width: 1920, height: 1080, storage: { "skillhub-sky-demo-islands": "45" } });
      await page.waitForTimeout(2000);
      const stats = await page.evaluate(() => document.querySelector(".sky-scene-host").skyWorldStats());
      await page.screenshot({ path: path.join(shots, "many-50-islands.png") });
      check("#37 50 categories: under 1,000 draw calls", stats.drawCalls < 1000, { islands: stats.islands, drawCalls: stats.drawCalls, triangles: stats.triangles });
      allErrors.push(...errors);
      await context.close();
    }

    // Star map (#39, #43): an urgent redraw while unfocused paints; identical
    // snapshot content keeps the view.
    {
      const { context, page, errors } = await open(browser, { theme: "sky-night", reduced: true, storage: { "ai-skillhub-home-visual": "universe" } });
      await page.locator(".home-visual-switch button").nth(1).click();
      await page.waitForTimeout(1500);
      const painted = () => page.evaluate(() => {
        const canvas = document.querySelector(".skill-universe-canvas");
        const data = canvas.getContext("2d").getImageData(0, 0, canvas.width, canvas.height).data;
        let count = 0;
        for (let index = 3; index < data.length; index += 16) if (data[index] > 0) count++;
        return count;
      });
      const before = await painted();
      await page.evaluate(() => window.dispatchEvent(new Event("blur")));
      await page.setViewportSize({ width: 1180, height: 760 });
      await page.waitForTimeout(800);
      const after = await painted();
      check("#39 the star map repaints after a resize while unfocused", before > 0 && after > 0, { before, after });
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      const canvas = await page.locator(".skill-universe-canvas").boundingBox();
      await page.mouse.move(canvas.x + canvas.width * 0.6, canvas.y + canvas.height * 0.5);
      await page.mouse.down();
      await page.mouse.move(canvas.x + canvas.width * 0.6 + 140, canvas.y + canvas.height * 0.5 + 40, { steps: 8 });
      await page.mouse.up();
      await page.mouse.wheel(0, -300);
      await page.waitForTimeout(900);
      const transforms = () => page.evaluate(() => [...document.querySelectorAll(".skill-universe-label")].slice(0, 6).map(label => label.style.transform).join("|"));
      const moved = await transforms();
      // The top bar's primary pill reloads the preview snapshot (same content).
      const reload = page.locator(".topbar .primary-pill");
      if (await reload.count()) {
        await reload.first().click();
        await page.waitForTimeout(2000);
        const kept = await transforms();
        check("#43 the star map keeps its view when the same content reloads", moved.length > 0 && kept === moved, { same: kept === moved });
      } else {
        check("#43 the star map keeps its view when the same content reloads", false, "no reload button");
      }
      allErrors.push(...errors);
      await context.close();
    }
  } finally {
    await browser.close();
  }
  check("console errors: 0", allErrors.length === 0, allErrors.slice(0, 5));
  fs.writeFileSync(path.join(shots, "bugs-qa.json"), JSON.stringify(results, null, 2));
  const failed = results.filter(result => !result.ok).length;
  console.log(`${results.length - failed}/${results.length} checks pass`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
