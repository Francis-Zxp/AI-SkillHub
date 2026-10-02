// Star map interaction screenshots on the dense lab fixture: idle, hover and
// click-selected, in a theme. Finds a node by probing the pointer cursor.
// Usage: node scripts/star-map-interaction-capture.cjs <outDir> [--theme=sky-dusk] [--size=1920x1080] [--dpr=1]
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const args = process.argv.slice(2);
const outDir = path.resolve(args[0] ?? "reports/visual/star-map");
const option = (name, fallback) => (args.find(arg => arg.startsWith(`--${name}=`)) ?? `--${name}=${fallback}`).split("=")[1];
const theme = option("theme", "sky-dusk");
const [width, height] = option("size", "1920x1080").split("x").map(Number);
const dpr = Number(option("dpr", "1"));
const base = option("url", "http://127.0.0.1:1420");

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ channel: "chrome", args: ["--use-angle=d3d11", "--ignore-gpu-blocklist"] });
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: dpr });
  const errors = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto(`${base}/lab/star-lab.html?theme=${theme}`, { waitUntil: "networkidle" });
  await page.waitForFunction(() => document.body.dataset.ready === "1");
  await page.waitForTimeout(1200);
  const shot = async name => {
    const file = path.join(outDir, `${name}-${theme}-${width}x${height}@${dpr}.png`);
    await page.screenshot({ path: file });
    return file;
  };
  const files = [await shot("idle")];
  // Probe a grid until the canvas reports a node under the pointer.
  let target = null;
  for (let y = Math.round(height * 0.3); y < height * 0.75 && !target; y += 9) {
    for (let x = Math.round(width * 0.3); x < width * 0.7; x += 9) {
      await page.mouse.move(x, y);
      const cursor = await page.evaluate(() => document.querySelector(".skill-universe-canvas")?.style.cursor);
      if (cursor === "pointer") {
        target = { x, y };
        break;
      }
    }
  }
  if (target) {
    await page.waitForTimeout(400);
    files.push(await shot("hover"));
    await page.mouse.click(target.x, target.y);
    await page.mouse.move(8, height - 8);
    await page.waitForTimeout(500);
    files.push(await shot("selected"));
  }
  const metrics = await page.evaluate(() => ({ ...document.querySelector(".skill-universe-canvas")?.dataset }));
  console.log(JSON.stringify({ files, target, metrics, errors }));
  await browser.close();
})().catch(error => {
  console.error(error);
  process.exit(1);
});
