// Screenshots of every sidebar page in one theme, for visual review.
// Usage: node scripts/pages-capture.cjs <outDir> [--theme=sky-dusk] [--size=1920x1080] [--dpr=1] [--lang=zh]
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const args = process.argv.slice(2);
const outDir = path.resolve(args[0] ?? "reports/visual/pages");
const option = (name, fallback) => (args.find(arg => arg.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).split("=")[1];
const theme = option("theme", "sky-dusk");
const lang = option("lang", "zh");
const [width, height] = option("size", "1920x1080").split("x").map(Number);
const dpr = Number(option("dpr", "1"));
const url = option("url", "http://127.0.0.1:1420/");

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ channel: "chrome", args: ["--use-angle=d3d11", "--ignore-gpu-blocklist"] });
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: dpr });
  await context.addInitScript(([themeName, language]) => {
    try {
      localStorage.setItem("ai-skillhub-lang", language);
      localStorage.setItem("ai-skillhub-theme", themeName);
    } catch {}
  }, [theme, lang]);
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(url, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);
  const items = page.locator(".sidebar .nav-item");
  const count = await items.count();
  const files = [];
  for (let index = 0; index < count; index++) {
    const item = items.nth(index);
    const label = ((await item.getAttribute("aria-label")) || (await item.innerText()) || `page-${index}`).trim().split("\n")[0];
    await item.click().catch(() => {});
    await page.waitForTimeout(1600);
    const file = path.join(outDir, `${String(index).padStart(2, "0")}-${label.replace(/[^\p{L}\p{N}-]+/gu, "_")}-${theme}.png`);
    await page.screenshot({ path: file });
    files.push(file);
  }
  console.log(JSON.stringify({ files, errors: errors.slice(0, 8) }, null, 1));
  await browser.close();
})().catch(error => {
  console.error(error);
  process.exit(1);
});
