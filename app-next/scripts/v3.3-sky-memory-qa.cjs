// Memory QA for the home scenes (v3.3). Measures, in real Chrome on the Vite
// preview: JavaScript allocation rate while the islands animate (per-frame
// garbage), the live heap after a forced GC, renderer and GPU process memory,
// what happens when home is left or the app reports it is hidden (the 3D
// world must sleep: still image, no WebGL context), how long it takes to wake,
// and the star map's allocation rate.
//
//   node scripts/v3.3-sky-memory-qa.cjs [baseUrl] [outFile]
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { chromium } = require("playwright");

const base = process.argv[2] ?? "http://127.0.0.1:1431/";
const outFile = process.argv[3] ?? path.join(__dirname, "..", "reports", "sky-memory.json");
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "sky-memory-"));
const MB = 1024 * 1024;

/** Private bytes of this Chrome's processes, grouped by process type. */
function processMemory() {
  const marker = path.basename(profile);
  const script = `$ErrorActionPreference='SilentlyContinue'; Get-CimInstance Win32_Process -Filter "Name='chrome.exe'" | Where-Object { $_.CommandLine -like '*${marker}*' } | ForEach-Object { $p = Get-Process -Id $_.ProcessId; $t = if ($_.CommandLine -match '--type=([a-z-]+)') { $Matches[1] } else { 'browser' }; if ($_.CommandLine -match '--utility-sub-type=([A-Za-z.]+)') { $t = $t + ':' + $Matches[1] }; '{0}|{1}|{2}' -f $t, $p.PrivateMemorySize64, $p.WorkingSet64 }`;
  const output = execFileSync("powershell.exe", ["-NoProfile", "-Command", script], { encoding: "utf8" });
  const groups = {};
  for (const line of output.split(/\r?\n/).filter(Boolean)) {
    const [type, privateBytes, workingSet] = line.split("|");
    const key = type.startsWith("renderer") ? "renderer" : type.startsWith("gpu") ? "gpu" : type === "browser" ? "browser" : "other";
    groups[key] ??= { private: 0, workingSet: 0, count: 0 };
    groups[key].private += Number(privateBytes) / MB;
    groups[key].workingSet += Number(workingSet) / MB;
    groups[key].count++;
  }
  const round = value => Math.round(value * 10) / 10;
  const total = Object.values(groups).reduce((sum, group) => sum + group.private, 0);
  return { totalPrivateMB: round(total), ...Object.fromEntries(Object.entries(groups).map(([key, group]) => [key, { privateMB: round(group.private), workingSetMB: round(group.workingSet), count: group.count }])) };
}

/** Bytes allocated by JavaScript per second (sampled, collected objects included). */
async function allocationRate(cdp, seconds) {
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("HeapProfiler.startSampling", { samplingInterval: 2048, includeObjectsCollectedByMajorGC: true, includeObjectsCollectedByMinorGC: true });
  await new Promise(resolve => setTimeout(resolve, seconds * 1000));
  const { profile: sample } = await cdp.send("HeapProfiler.stopSampling");
  let total = 0;
  const walk = node => { total += node.selfSize; for (const child of node.children) walk(child); };
  walk(sample.head);
  // Top allocation sites, for finding what still allocates per frame.
  const sites = [];
  const collect = (node, stack) => {
    const frame = `${node.callFrame.functionName || "(anon)"}@${(node.callFrame.url.split("/").pop() || "").split("?")[0]}:${node.callFrame.lineNumber + 1}`;
    if (node.selfSize > 0) sites.push({ site: [...stack.slice(-2), frame].join(" < "), bytes: node.selfSize });
    for (const child of node.children) collect(child, [...stack, frame]);
  };
  collect(sample.head, []);
  sites.sort((a, b) => b.bytes - a.bytes);
  return { kbPerSecond: Math.round(total / 1024 / seconds), top: sites.slice(0, 8).map(item => `${Math.round(item.bytes / 1024 / seconds)} KB/s ${item.site}`) };
}

async function heapAfterGc(cdp) {
  await cdp.send("HeapProfiler.collectGarbage");
  await cdp.send("HeapProfiler.collectGarbage");
  const usage = await cdp.send("Runtime.getHeapUsage");
  return Math.round(usage.usedSize / MB * 10) / 10;
}

const sceneState = page => page.evaluate(() => ({
  status: document.querySelector(".sky-islands")?.getAttribute("data-status"),
  canvases: document.querySelectorAll(".sky-world-canvas").length,
  still: Boolean(document.querySelector(".sky-world-still")),
  sleeping: document.querySelector(".sky-scene-host")?.dataset.sleeping ?? "",
  frames: Number(document.querySelector(".sky-scene-host")?.dataset.frames ?? 0)
}));

(async () => {
  const context = await chromium.launchPersistentContext(profile, {
    channel: "chrome",
    args: ["--use-angle=d3d11", "--ignore-gpu-blocklist", "--enable-precise-memory-info"],
    viewport: { width: 1920, height: 1080 },
    deviceScaleFactor: 1
  });
  const report = { base, when: new Date().toISOString() };
  try {
    await context.addInitScript(() => {
      try {
        localStorage.setItem("ai-skillhub-lang", "zh");
        localStorage.setItem("ai-skillhub-theme", "sky-noon");
        localStorage.setItem("ai-skillhub-theme-sky-default-v2", "1");
        localStorage.setItem("skillhub-sky-weather", "clear");
        localStorage.setItem("skillhub-sky-world-seed", "7");
        localStorage.setItem("skillhub-sky-low-power", "0");
        localStorage.setItem("skillhub-sky-paused", "0");
        localStorage.removeItem("skillhub-sky-demo-islands");
      } catch { /* storage unavailable */ }
    });
    const page = context.pages()[0] ?? await context.newPage();
    const errors = [];
    page.on("pageerror", error => errors.push(error.message));
    page.on("console", message => { if (message.type() === "error" && !/vibecafe|ERR_FAILED|404|favicon/i.test(message.text())) errors.push(message.text().slice(0, 200)); });
    const cdp = await context.newCDPSession(page);
    await page.goto(base, { waitUntil: "networkidle" });
    await page.waitForFunction(() => document.querySelector(".sky-islands")?.getAttribute("data-status") === "ready", null, { timeout: 45000 });
    await page.waitForTimeout(8000);

    report.islandsAnimating = {
      allocation: await allocationRate(cdp, 10),
      heapAfterGcMB: await heapAfterGc(cdp),
      process: processMemory(),
      scene: await sceneState(page)
    };

    // Leave home: the world should sleep after 15 s and release WebGL.
    await page.locator(".nav .nav-item").nth(1).click();
    await page.waitForTimeout(19000);
    report.offHome20s = { heapAfterGcMB: await heapAfterGc(cdp), process: processMemory(), scene: await sceneState(page) };
    const back = Date.now();
    await page.locator(".nav .nav-item").nth(0).click();
    await page.waitForFunction(() => document.querySelectorAll(".sky-world-canvas").length > 0 && !document.querySelector(".sky-world-still") && document.querySelector(".sky-islands")?.getAttribute("data-status") === "ready", null, { timeout: 15000 }).catch(() => undefined);
    report.wakeMs = Date.now() - back;
    await page.waitForTimeout(3000);
    report.afterWake = { scene: await sceneState(page) };

    // The shell reports a minimised window.
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("skillhub-app-hidden", { detail: true })));
    await page.waitForTimeout(17000);
    report.appHidden17s = { heapAfterGcMB: await heapAfterGc(cdp), process: processMemory(), scene: await sceneState(page) };
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("skillhub-app-hidden", { detail: false })));
    await page.waitForTimeout(3000);
    report.appShown = { scene: await sceneState(page) };

    // Star map.
    await page.locator(".home-visual-switch button").nth(1).click();
    await page.waitForTimeout(8000);
    report.starMap = { allocation: await allocationRate(cdp, 10), heapAfterGcMB: await heapAfterGc(cdp), process: processMemory() };
    await page.screenshot({ path: path.join(path.dirname(outFile), "memory-star-map.png") });
    report.errors = errors;
  } finally {
    await context.close();
    fs.rmSync(profile, { recursive: true, force: true });
  }
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
})().catch(error => {
  console.error(error);
  process.exit(1);
});
