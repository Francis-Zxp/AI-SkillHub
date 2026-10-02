// Converts the CC0 Quaternius farm animals (FBX) to GLB through the lab page
// lab/fbx-convert.html (three's FBXLoader + GLTFExporter, run in Chrome).
//   node scripts/sky-assets/convert-animals.cjs <outDir> [--url=http://127.0.0.1:1420]
// The FBX files are expected in lab/.out/fbx/ (extracted from the pack zip).
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const outDir = path.resolve(process.argv[2] ?? "lab/.out/animals");
const base = (process.argv.find(arg => arg.startsWith("--url=")) ?? "--url=http://127.0.0.1:1420").slice(6);
const names = ["Cow", "Sheep", "Pig", "Llama", "Pug", "Horse"];

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage();
  await page.goto(`${base}/lab/fbx-convert.html`);
  await page.waitForFunction(() => document.body.dataset.ready === "1");
  for (const name of names) {
    const result = await page.evaluate(animal => window.convert(animal), name);
    fs.writeFileSync(path.join(outDir, `${name}.glb`), Buffer.from(result.base64, "base64"));
    console.log(JSON.stringify({ name, bytes: Math.round(result.base64.length * 0.75), animations: result.animations, meshes: result.meshes }));
  }
  await browser.close();
})().catch(error => {
  console.error(error);
  process.exit(1);
});
