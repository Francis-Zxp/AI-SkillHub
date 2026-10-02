// Full-resolution screenshots of the browser preview for visual review.
// Usage: node scripts/visual-capture.cjs <outDir> [url] [--views=sky,star,...] [--size=1920x1080] [--dpr=1] [--theme=dark|light]
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const args = process.argv.slice(2);
const outDir = path.resolve(args[0] ?? "reports/visual");
const url = args.find(arg => /^https?:/.test(arg)) ?? "http://127.0.0.1:1420/";
const option = (name, fallback) => (args.find(arg => arg.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).split("=")[1];
const [width, height] = option("size", "1920x1080").split("x").map(Number);
const dpr = Number(option("dpr", "1"));
const theme = option("theme", "");
const views = option("views", "sky").split(",");
const waitMs = Number(option("wait", "2500"));

async function main() {
  fs.mkdirSync(outDir, { recursive: true });
  // The machine's own Chrome (no extra browser download); GPU path enabled so
  // WebGL renders like the WebView2 app does.
  const browser = await chromium.launch({
    channel: "chrome",
    args: ["--use-angle=d3d11", "--enable-gpu-rasterization", "--ignore-gpu-blocklist"]
  });
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  await page.addInitScript(([themeName]) => {
    try {
      localStorage.setItem("ai-skillhub-lang", "zh");
      if (themeName) localStorage.setItem("ai-skillhub-theme", themeName);
    } catch {}
  }, [theme]);
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(waitMs);
  for (const view of views) {
    if (view === "page") {
      // Lab pages flag readiness themselves.
      await page.waitForFunction(() => document.body.dataset.ready === "1", null, { timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(waitMs);
    } else if (view === "star") {
      const tab = page.getByRole("button", { name: /星图|Star/ }).first();
      if (await tab.count()) await tab.click();
      await page.waitForTimeout(waitMs);
    } else if (view === "sky") {
      const tab = page.getByRole("button", { name: /群岛|天空岛|Islands/ }).first();
      if (await tab.count()) await tab.click().catch(() => {});
      await page.waitForTimeout(waitMs);
    } else if (view.startsWith("nav:")) {
      const label = view.slice(4);
      await page.getByRole("button", { name: new RegExp(label) }).first().click();
      await page.waitForTimeout(waitMs);
    }
    const file = path.join(outDir, `${view.replace(/[^a-z0-9-]/gi, "_")}-${width}x${height}@${dpr}${theme ? "-" + theme : ""}.png`);
    await page.screenshot({ path: file });
    const metrics = await page.evaluate(() => {
      const host = document.querySelector(".sky-scene-host, [data-frames]");
      return host ? { ...host.dataset } : null;
    });
    console.log(JSON.stringify({ file, metrics }));
  }
  if (errors.length) console.log(JSON.stringify({ errors: errors.slice(0, 10) }));
  await browser.close();
}

main().catch(error => { console.error(error); process.exit(1); });
