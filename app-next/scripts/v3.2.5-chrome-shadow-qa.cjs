// Render affected chrome with production CSS, independently of Canvas; optionally
// set AI_SKILLHUB_PREVIEW_URL to verify the full running app with the same checks.
// Run after `pnpm build`; Playwright is supplied by the existing QA environment.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const root = path.resolve(__dirname, "..");
const reportDir = path.join(root, "reports/visual/v3.2.5-chrome-shadow");
const assets = path.join(root, "dist/assets");
const stylesheet = fs.readdirSync(assets).find(name => /^index-.*\.css$/.test(name));
assert.ok(stylesheet, "build the production stylesheet before testing");
const css = fs.readFileSync(path.join(assets, stylesheet), "utf8");
const previewUrl = process.env.AI_SKILLHUB_PREVIEW_URL;
fs.mkdirSync(reportDir, { recursive: true });

const selectors = [".sidebar", ".topbar", ".atlas-intro-toggle", ".atlas-immersive-toggle", ".skill-universe-modes", ".atlas-touchbar"];
const report = [];

(async () => {
  for (const software of [false, true]) {
    const browser = await chromium.launch({
      headless: true,
      ...(process.env.AI_SKILLHUB_BROWSER_PATH
        ? { executablePath: process.env.AI_SKILLHUB_BROWSER_PATH }
        : { channel: "msedge" }),
      args: software ? ["--disable-gpu"] : []
    });
    try {
      for (const theme of ["atlas-dark", "atlas-light", "atlas-legacy-dark", "atlas-legacy-light", "nocturne", "parchment"]) {
        for (const scale of [1, 1.25, 1.5]) {
          const page = await browser.newPage({ viewport: { width: 1260, height: 820 }, deviceScaleFactor: scale });
          try {
            if (previewUrl) {
              await page.goto(`${previewUrl}/?theme=${theme}&view=dashboard`, { waitUntil: "networkidle" });
              await page.locator(".atlas-touchbar").waitFor();
            } else await page.setContent(`<style>${css}</style>
              <div class="shell theme-family-atlas theme-${theme} page-dashboard">
                <aside class="sidebar"><span>Skills</span></aside>
                <main class="workspace">
                  <header class="topbar">AI SkillHub · Skills / MCP</header>
                  <div class="workspace-body"><div class="dashboard-view">
                    <section class="dashboard-hero"><div class="dashboard-hero-inner"><h1>让能力，自成星系。</h1></div>
                      <button class="atlas-immersive-toggle">⛶</button>
                      <button class="atlas-intro-toggle">隐藏介绍</button>
                      <div class="skill-universe-modes"><button class="active">关系</button><button>父子</button><button>我的文件夹</button></div>
                    </section>
                    <div class="metric-grid atlas-touchbar"><article class="metric">已启用 Skills 7</article><article class="metric">已索引来源 2</article><article class="metric">AI 工具 0</article><article class="metric">健康问题 0</article><button>添加来源</button></div>
                  </div></div>
                </main>
              </div>`);
            const styles = await page.evaluate(selectors => selectors.map(selector => {
              const element = document.querySelector(selector);
              const style = getComputedStyle(element);
              return { selector, shadow: style.boxShadow, backdrop: style.backdropFilter, background: style.backgroundColor, afterShadow: getComputedStyle(element, "::after").boxShadow };
            }), selectors);
            for (const style of styles) {
              assert.equal(style.backdrop, "none", `${theme}: ${style.selector} still blurs the scene`);
              if (style.selector === ".sidebar") {
                assert.equal(style.shadow, "none");
                assert.equal(style.afterShadow, "none");
              } else {
                // Exact computed RGBA guards against currentColor inheritance,
                // lost alpha, and old broad shadows surviving the cascade.
                assert.match(style.shadow, /^rgba\(10, 16, 28, 0\.1(?:2)?\) 0px (?:2px 8px|4px 16px) 0px$/,
                  `${theme}: unexpected chrome shadow for ${style.selector}: ${style.shadow}`);
                assert.notEqual(style.background, "rgba(0, 0, 0, 0)", `${theme}: transparent chrome`);
              }
            }
            await page.locator(".atlas-intro-toggle").hover();
            const hoverShadow = await page.locator(".atlas-intro-toggle").evaluate(el => getComputedStyle(el).boxShadow);
            assert.match(hoverShadow, /^rgba\(10, 16, 28, 0\.1\) 0px 2px 8px 0px$/);
            const id = `${theme}-${scale}-${software ? "software" : "default"}`;
            if (scale === 1 && ["atlas-dark", "atlas-light"].includes(theme)) {
              await page.screenshot({ path: path.join(reportDir, `${id}.png`) });
            }
            report.push({ theme, scale, software, fullApp: Boolean(previewUrl), browser: browser.version(), styles });
          } finally {
            await page.close();
          }
        }
      }
    } finally {
      await browser.close();
    }
  }
  fs.writeFileSync(path.join(reportDir, "report.json"), JSON.stringify(report, null, 2));
  console.log(`${report.length} production-CSS theme / DPI / renderer cases passed. Reports: ${reportDir}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
