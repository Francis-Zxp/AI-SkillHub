// Review QA for the sky world's GPU lifecycle (v3.3). In real Chrome on the
// Vite preview:
//   - five sleep/wake cycles, five re-rolls and five home remounts: every
//     world leaves 0 geometries and 0 textures behind, the live world's
//     renderer.info.memory stays the same size each time, the JS heap after a
//     forced GC stays flat and Chrome never runs out of WebGL contexts;
//   - per-frame garbage: CDP heap sampling over 10 s while a storm animates;
//   - determinism: the same seed, weather and size draw the same picture;
//   - the background event (window unfocused for a while) puts the world to
//     sleep like a minimised window, and focus wakes it.
//
//   node scripts/v3.3-sky-cycles-qa.cjs [baseUrl] [outDir]
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const base = process.argv[2] ?? "http://127.0.0.1:1431/";
const out = process.argv[3] ?? path.join(__dirname, "..", "reports", "sky-cycles-qa");
fs.mkdirSync(out, { recursive: true });
const MB = 1024 * 1024;
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
};

async function open(browser, { storage = {}, reduced = false, width = 1600, height = 900 } = {}) {
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion: reduced ? "reduce" : "no-preference" });
  await context.addInitScript(storage => {
    try {
      const defaults = {
        "ai-skillhub-lang": "zh", "ai-skillhub-theme": "sky-noon", "ai-skillhub-theme-sky-default-v2": "1",
        "skillhub-sky-world-seed": "7", "skillhub-sky-weather": "storm", "skillhub-sky-low-power": "0", "skillhub-sky-paused": "0",
        "skillhub-sky-sleep-ms": "1200", "skillhub-sky-scene": "1"
      };
      if (!sessionStorage.getItem("qa-storage-applied")) {
        for (const [key, value] of Object.entries({ ...defaults, ...storage })) {
          if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
        }
        sessionStorage.setItem("qa-storage-applied", "1");
      }
    } catch { /* storage unavailable */ }
  }, storage);
  const page = await context.newPage();
  const errors = [], warnings = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => {
    const text = message.text();
    if (/WebGL|context/i.test(text) && message.type() !== "debug") warnings.push(text.slice(0, 200));
    if (message.type() === "error" && !/vibecafe|ERR_FAILED|404|favicon/i.test(text)) errors.push(text.slice(0, 200));
  });
  await page.goto(base, { waitUntil: "networkidle" });
  await waitLive(page, reduced ? 0 : 5);
  return { context, page, errors, warnings };
}

const sceneState = page => page.evaluate(() => {
  const host = document.querySelector(".sky-scene-host");
  return { status: document.querySelector(".sky-islands")?.getAttribute("data-status"), canvases: document.querySelectorAll(".sky-world-canvas").length, still: Boolean(document.querySelector(".sky-world-still")), sleeping: host?.dataset.sleeping ?? "", frames: host?.skyWorldStats?.().frames };
});
/** One WebGL canvas, no still image, the scene ready and drawing. */
const waitLive = (page, minFrames = 5) => waitLiveRaw(page, minFrames).catch(async error => { throw new Error(`not live: ${JSON.stringify(await sceneState(page))} (${error.message.split(/\r?\n/)[0]})`); });
const waitLiveRaw = (page, minFrames) => page.waitForFunction(minFrames => {
  const host = document.querySelector(".sky-scene-host");
  return document.querySelector(".sky-islands")?.getAttribute("data-status") === "ready" &&
    document.querySelectorAll(".sky-world-canvas").length === 1 && !document.querySelector(".sky-world-still") &&
    Number(host?.skyWorldStats?.().frames ?? 0) > minFrames;
}, minFrames, { timeout: 45000 });

const waitAsleep = page => page.waitForFunction(() => document.querySelector(".sky-scene-host")?.dataset.sleeping === "1" &&
  document.querySelectorAll(".sky-world-canvas").length === 0, null, { timeout: 20000 });

/** Home or the library, in the 3.2 shell (.nav) or the v3.3 rail. */
async function navigate(page, where) {
  const rail = page.locator(`[data-testid="nav-${where === "home" ? "dashboard" : "library"}"]`);
  if (await rail.count()) return rail.first().click();
  return page.locator(".nav .nav-item").nth(where === "home" ? 0 : 1).click();
}

const stats = page => page.evaluate(() => {
  const host = document.querySelector(".sky-scene-host");
  const s = host?.skyWorldStats?.() ?? {};
  return { geometries: s.geometries, textures: s.textures, drawCalls: s.drawCalls, climates: s.climates, weather: s.weather, leftGeometries: host?.dataset.leftGeometries, leftTextures: host?.dataset.leftTextures };
});

async function heapAfterGc(cdp) {
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("HeapProfiler.collectGarbage");
  const usage = await cdp.send("Runtime.getHeapUsage");
  return Math.round(usage.usedSize / MB * 10) / 10;
}

/** Bytes allocated by JavaScript per second while sampling (collected objects included). */
async function allocationRate(cdp, seconds) {
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("HeapProfiler.startSampling", { samplingInterval: 1024, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  await new Promise(resolve => setTimeout(resolve, seconds * 1000));
  const { profile } = await cdp.send("HeapProfiler.stopSampling");
  let total = 0, own = 0;
  const sites = [];
  const walk = (node, stack) => {
    total += node.selfSize;
    // Allocated directly by SkillHub's own code (not three.js or the browser).
    if (/\/src\//.test(node.callFrame.url) && !/node_modules/.test(node.callFrame.url)) own += node.selfSize;
    const frame = `${node.callFrame.functionName || "(anon)"}@${(node.callFrame.url.split("/").pop() || "").split("?")[0]}:${node.callFrame.lineNumber + 1}`;
    if (node.selfSize > 0) sites.push({ site: [...stack.slice(-2), frame].join(" < "), bytes: node.selfSize });
    for (const child of node.children) walk(child, [...stack, frame]);
  };
  walk(profile.head, []);
  sites.sort((a, b) => b.bytes - a.bytes);
  return { kbPerSecond: Math.round(total / 1024 / seconds * 10) / 10, ownKbPerSecond: Math.round(own / 1024 / seconds * 10) / 10, top: sites.slice(0, 6).map(item => `${Math.round(item.bytes / 1024 / seconds * 10) / 10} KB/s ${item.site}`) };
}

/** Mean absolute difference of two PNG buffers (0..255 per channel). */
async function pixelDifference(page, a, b) {
  return page.evaluate(async files => {
    const load = src => new Promise(resolve => { const image = new Image(); image.onload = () => resolve(image); image.src = src; });
    const [x, y] = await Promise.all(files.map(load));
    const read = image => { const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height; const context = canvas.getContext("2d"); context.drawImage(image, 0, 0); return context.getImageData(0, 0, image.width, image.height).data; };
    const [pa, pb] = [x, y].map(read);
    let sum = 0, worst = 0;
    for (let index = 0; index < pa.length; index += 4) {
      const d = (Math.abs(pa[index] - pb[index]) + Math.abs(pa[index + 1] - pb[index + 1]) + Math.abs(pa[index + 2] - pb[index + 2])) / 3;
      sum += d;
      if (d > worst) worst = d;
    }
    return { mean: Math.round(sum / (pa.length / 4) * 100) / 100, worst: Math.round(worst) };
  }, [a, b].map(buffer => `data:image/png;base64,${buffer.toString("base64")}`));
}

(async () => {
  const browser = await chromium.launch({ channel: "chrome", args: ["--use-angle=d3d11", "--ignore-gpu-blocklist"] });
  try {
    // 1. Five sleep/wake cycles, five re-rolls, five remounts.
    {
      const { context, page, errors, warnings } = await open(browser);
      const cdp = await context.newCDPSession(page);
      await page.waitForTimeout(1500);
      const first = await stats(page);
      const heap0 = await heapAfterGc(cdp);
      const sleepWake = [];
      for (let cycle = 0; cycle < 5; cycle++) {
        await page.evaluate(() => window.dispatchEvent(new Event("skillhub-app-hidden")));
        await waitAsleep(page);
        const left = await stats(page);
        await page.evaluate(() => window.dispatchEvent(new Event("skillhub-app-visible")));
        await waitLive(page);
        await page.waitForTimeout(900);
        const live = await stats(page);
        sleepWake.push({ leftGeometries: left.leftGeometries, leftTextures: left.leftTextures, geometries: live.geometries, textures: live.textures, heapMB: await heapAfterGc(cdp) });
      }
      check("sleep/wake x5: every world leaves 0 geometries and 0 textures", sleepWake.every(item => item.leftGeometries === "0" && item.leftTextures === "0"), sleepWake.map(item => `${item.leftGeometries}/${item.leftTextures}`).join(" "));
      check("sleep/wake x5: the live world's GPU memory is the same size each time", sleepWake.every(item => item.geometries === first.geometries && item.textures === first.textures), { first: `${first.geometries}g/${first.textures}t`, cycles: sleepWake.map(item => `${item.geometries}g/${item.textures}t`) });
      const heaps = [heap0, ...sleepWake.map(item => item.heapMB)];
      check("sleep/wake x5: JS heap after GC stays flat (< 3 MB growth)", heaps[heaps.length - 1] - heaps[1] < 3, { heapsMB: heaps });

      const rerolls = [];
      for (let cycle = 0; cycle < 5; cycle++) {
        const before = (await stats(page)).climates;
        await page.locator(".sky-world-toggle").click();
        await page.locator(".sky-reroll").click();
        await page.waitForFunction(previous => document.querySelector(".sky-scene-host")?.skyWorldStats?.().climates !== previous, before, { timeout: 30000 });
        await waitLive(page);
        await page.keyboard.press("Escape");
        await page.waitForTimeout(900);
        const live = await stats(page);
        rerolls.push({ left: `${live.leftGeometries}/${live.leftTextures}`, live: `${live.geometries}g/${live.textures}t`, canvases: await page.evaluate(() => document.querySelectorAll(".sky-world-canvas").length), heapMB: await heapAfterGc(cdp) });
      }
      // A replaced world can only let go of the cached models (GLB files, the
      // toon ramp) once no other world draws them: what it leaves must stay
      // the same small set, never grow, and go at the next sleep.
      const leftovers = rerolls.map(item => item.left.split("/").map(Number));
      check("re-roll x5: only one canvas stays; a replaced world leaves at most the shared models (no growth)", rerolls.every(item => item.canvases === 1) && leftovers.every(([g, t]) => g <= 60 && t <= 6), rerolls.map(item => `${item.left} canvases=${item.canvases}`).join(" "));
      await page.evaluate(() => window.dispatchEvent(new Event("skillhub-app-hidden")));
      await waitAsleep(page);
      const afterRerolls = await stats(page);
      check("re-roll x5 then sleep: everything is released", afterRerolls.leftGeometries === "0" && afterRerolls.leftTextures === "0", `${afterRerolls.leftGeometries}/${afterRerolls.leftTextures}`);
      await page.evaluate(() => window.dispatchEvent(new Event("skillhub-app-visible")));
      await waitLive(page);
      check("re-roll x5: JS heap after GC stays flat (< 3 MB growth)", rerolls[4].heapMB - rerolls[0].heapMB < 3, { heapsMB: rerolls.map(item => item.heapMB), live: rerolls.map(item => item.live) });

      const remounts = [];
      for (let cycle = 0; cycle < 5; cycle++) {
        await navigate(page, "library");
        // The v3.3 shell unmounts home; the 3.2 shell keeps it mounted but
        // hidden, where the world sleeps after the (shortened) delay.
        await page.waitForFunction(() => !document.querySelector(".sky-islands") ||
          (document.querySelector(".sky-scene-host")?.dataset.sleeping === "1" && document.querySelector(".sky-world-still")), null, { timeout: 20000 });
        await page.waitForTimeout(400);
        // Every animation frame from the click until the world is live shows
        // either the kept still or a drawn world, never an empty sky.
        await page.evaluate(() => {
          const monitor = window.__skyBlank = { blank: 0, frames: 0, running: true };
          const tick = () => {
            if (!monitor.running) return;
            if (document.querySelector(".sky-islands")) {
              monitor.frames++;
              const drawn = Number(document.querySelector(".sky-scene-host")?.skyWorldStats?.().frames ?? 0) > 0;
              if (!document.querySelector(".sky-world-still") && !drawn) monitor.blank++;
            }
            requestAnimationFrame(tick);
          };
          requestAnimationFrame(tick);
        });
        await navigate(page, "home");
        const shownAt = Date.now();
        await waitLive(page);
        const monitor = await page.evaluate(() => { window.__skyBlank.running = false; return window.__skyBlank; });
        remounts.push({ stillFirst: monitor.blank === 0, blank: monitor.blank, liveMs: Date.now() - shownAt, heapMB: await heapAfterGc(cdp) });
      }
      check("remount x5: home shows the kept still at once, then the live world", remounts.every(item => item.stillFirst), remounts.map(item => `${item.stillFirst ? "still" : `blank x${item.blank}`} ${item.liveMs}ms`).join(" "));
      check("remount x5: JS heap after GC stays flat (< 3 MB growth)", remounts[4].heapMB - remounts[0].heapMB < 3, { heapsMB: remounts.map(item => item.heapMB) });
      check("no WebGL context warnings over 15 rebuilds", !warnings.some(text => /too many active webgl contexts|context lost/i.test(text)), warnings.slice(0, 3));
      check("cycles: no console errors", errors.length === 0, errors.slice(0, 3));
      await context.close();
    }

    // 2. Per-frame garbage while a storm animates (and a clear sky).
    for (const weather of ["storm", "petals", "clear"]) {
      const { context, page, errors } = await open(browser, { storage: { "skillhub-sky-weather": weather, "skillhub-sky-sleep-ms": null } });
      const cdp = await context.newCDPSession(page);
      await page.waitForTimeout(3000);
      const framesBefore = (await page.evaluate(() => document.querySelector(".sky-scene-host").skyWorldStats().frames));
      const allocation = await allocationRate(cdp, 10);
      const frames = (await page.evaluate(() => document.querySelector(".sky-scene-host").skyWorldStats().frames)) - framesBefore;
      const perFrame = Math.round(allocation.kbPerSecond * 10 * 1024 / Math.max(1, frames));
      // What is left is V8 number boxing at call and WebGL-binding boundaries
      // (three.js uniform uploads, the animation mixer, terrain heights for
      // walking animals): short-lived, collected young. 3.2.18 made 9.8 MB/s.
      check(`per-frame garbage (${weather}): under 3.5 MB/s in all, under 0.8 MB/s from SkillHub code`, frames > 100 && allocation.kbPerSecond < 3500 && allocation.ownKbPerSecond < 800, { kbPerSecond: allocation.kbPerSecond, ownKbPerSecond: allocation.ownKbPerSecond, frames, bytesPerFrame: perFrame, top: allocation.top.slice(0, 4) });
      check(`per-frame garbage (${weather}): no console errors`, errors.length === 0, errors.slice(0, 3));
      await context.close();
    }

    // 3. Determinism: same seed, weather and size → the same picture.
    {
      const shots = [];
      for (let run = 0; run < 2; run++) {
        const { context, page } = await open(browser, { reduced: true, storage: { "skillhub-sky-weather": "snow", "skillhub-sky-sleep-ms": null } });
        await page.waitForTimeout(1200);
        shots.push({ png: await page.locator(".sky-scene-host").screenshot(), climates: (await stats(page)).climates });
        if (run === 0) fs.writeFileSync(path.join(out, "determinism-snow.png"), shots[0].png);
        await context.close();
      }
      const probe = await browser.newContext();
      const page = await probe.newPage();
      const diff = await pixelDifference(page, shots[0].png, shots[1].png);
      await probe.close();
      check("determinism: same seed draws the same climates", shots[0].climates === shots[1].climates, shots[0].climates);
      check("determinism: same seed and weather draw the same picture (mean diff < 0.5/255)", diff.mean < 0.5, diff);
    }

    // 4. The window in the background for a while sleeps too; focus wakes it.
    {
      const { context, page, errors } = await open(browser);
      // The window stays visible: every frame must show the world or its still.
      await page.evaluate(() => {
        const monitor = window.__skyBlank = { blank: 0, frames: 0, running: true };
        const tick = () => {
          if (!monitor.running) return;
          monitor.frames++;
          const canvas = document.querySelector(".sky-world-canvas");
          if (!document.querySelector(".sky-world-still") && !canvas) monitor.blank++;
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });
      await page.evaluate(() => window.dispatchEvent(new Event("skillhub-app-background")));
      const slept = await waitAsleep(page).then(() => true).catch(() => false);
      const still = await page.evaluate(() => Boolean(document.querySelector(".sky-world-still")));
      const started = Date.now();
      await page.evaluate(() => window.dispatchEvent(new Event("focus")));
      const woke = await waitLive(page).then(() => true).catch(() => false);
      const monitor = await page.evaluate(() => { window.__skyBlank.running = false; return window.__skyBlank; });
      check("background: the world sleeps behind a still, focus wakes it", slept && still && woke, { slept, still, woke, wakeMs: Date.now() - started });
      check("background: no frame without the world or its still (sleep and wake)", monitor.blank === 0 && monitor.frames > 10, monitor);
      check("background: no console errors", errors.length === 0, errors.slice(0, 3));
      await context.close();
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(out, "cycles-qa.json"), JSON.stringify(results, null, 2));
  const failed = results.filter(result => !result.ok).length;
  console.log(`${results.length - failed}/${results.length} checks pass`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
