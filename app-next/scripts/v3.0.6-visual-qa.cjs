const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const baseUrl = process.env.AI_SKILLHUB_PREVIEW_URL || "http://127.0.0.1:4173";
const reportDir = path.resolve(__dirname, "../reports/visual/v3.0.6");
fs.mkdirSync(reportDir, { recursive: true });

async function visiblePixelCenter(locator) {
  return locator.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(rect.width));
    canvas.height = Math.max(1, Math.round(rect.height));
    const context = canvas.getContext("2d", { willReadFrequently: true });
    context.drawImage(element, 0, 0, canvas.width, canvas.height);
    const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
    let minX = canvas.width;
    let minY = canvas.height;
    let maxX = -1;
    let maxY = -1;
    for (let y = 0; y < canvas.height; y += 1) {
      for (let x = 0; x < canvas.width; x += 1) {
        if (pixels[(y * canvas.width + x) * 4 + 3] < 24) continue;
        minX = Math.min(minX, x);
        minY = Math.min(minY, y);
        maxX = Math.max(maxX, x);
        maxY = Math.max(maxY, y);
      }
    }
    return {
      x: rect.left + (minX + maxX + 1) / 2,
      y: rect.top + (minY + maxY + 1) / 2,
      bounds: { minX, minY, maxX, maxY },
    };
  });
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 1 });
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.locator(".skill-universe[data-universe-state='live']").waitFor({ timeout: 15_000 });

  const brand = page.locator(".brand").first();
  const logo = brand.locator("img.brand-logo");
  const brandBox = await brand.boundingBox();
  const logoCenter = await visiblePixelCenter(logo);
  const brandCenter = { x: brandBox.x + brandBox.width / 2, y: brandBox.y + brandBox.height / 2 };
  assert.ok(Math.abs(logoCenter.x - brandCenter.x) < 0.8, `logo x offset ${logoCenter.x - brandCenter.x}`);
  assert.ok(Math.abs(logoCenter.y - brandCenter.y) < 0.8, `logo y offset ${logoCenter.y - brandCenter.y}`);

  const cacheAudit = await page.evaluate(() => {
    const raw = localStorage.getItem("ai-skillhub-universe-cache-v1") || "";
    return {
      bytes: new Blob([raw]).size,
      leaksAbsolutePath: /(?:[A-Za-z]:\\|\/Users\/|\/home\/)/.test(raw),
      leaksNotes: /\"note\"\s*:|\"localPath\"\s*:/.test(raw),
    };
  });
  assert.ok(cacheAudit.bytes > 1000 && cacheAudit.bytes < 2_000_000, `cache bytes ${cacheAudit.bytes}`);
  assert.equal(cacheAudit.leaksAbsolutePath, false, "graph cache must not contain absolute user paths");
  assert.equal(cacheAudit.leaksNotes, false, "graph cache must not contain notes/localPath fields");

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `horizontal overflow ${overflow}`);
  await page.screenshot({ path: path.join(reportDir, "dashboard.png"), fullPage: true });

  await page.addInitScript(() => {
    window.__universeStates = [];
    const originalSetAttribute = Element.prototype.setAttribute;
    Element.prototype.setAttribute = function setAttribute(name, value) {
      if (name === "data-universe-state" && !window.__universeStates.includes(String(value))) {
        window.__universeStates.push(String(value));
      }
      return originalSetAttribute.call(this, name, value);
    };
  });
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.locator(".skill-universe[data-universe-state='live']").waitFor({ timeout: 15_000 });
  const states = await page.evaluate(() => window.__universeStates || []);
  assert.ok(states.includes("cached"), `expected cached state, got ${states.join(",")}`);
  assert.ok(states.includes("live"), `expected live state, got ${states.join(",")}`);

  const settingsButton = page.locator(".sidebar-footer .nav-item").first();
  await settingsButton.click();
  await page.locator(".settings-theme-row .segmented").waitFor();
  const themeRows = await page.locator(".settings-theme-row .segmented button").evaluateAll((buttons) =>
    buttons.map((button) => {
      const style = getComputedStyle(button);
      const range = document.createRange();
      range.selectNodeContents(button);
      return {
        text: button.textContent.trim(),
        nowrap: style.whiteSpace === "nowrap",
        clipped: button.scrollWidth > button.clientWidth + 1,
        height: button.getBoundingClientRect().height,
        lineRects: range.getClientRects().length,
      };
    }),
  );
  assert.ok(themeRows.length >= 8, `theme count ${themeRows.length}`);
  assert.ok(themeRows.every((item) => item.nowrap), "every theme name must be one line");
  assert.ok(themeRows.every((item) => item.lineRects <= 1), "theme text must not wrap vertically");
  await page.screenshot({ path: path.join(reportDir, "settings-themes.png"), fullPage: true });

  const libraryButton = page.locator(".nav .nav-item").nth(1);
  await libraryButton.click();
  const editButton = page.locator('[title="编辑来源"], [title="Edit source"], [title="소스 편집"]').first();
  await editButton.waitFor({ timeout: 10_000 });
  await editButton.click();
  const drawer = page.locator("body > .drawer");
  await drawer.waitFor();
  await page.waitForTimeout(320);
  const drawerAudit = await drawer.evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return {
      left: rect.left,
      right: rect.right,
      top: rect.top,
      width: rect.width,
      zIndex: Number(style.zIndex),
      position: style.position,
      backdrop: style.backdropFilter || style.webkitBackdropFilter,
    };
  });
  assert.equal(drawerAudit.position, "fixed");
  assert.ok(drawerAudit.zIndex >= 101, `drawer z-index ${drawerAudit.zIndex}`);
  assert.ok(drawerAudit.left > 700, `drawer must be on right, left=${drawerAudit.left}`);
  assert.ok(drawerAudit.right <= 1269, `drawer right=${drawerAudit.right}`);
  assert.ok(drawerAudit.top >= 11 && drawerAudit.top <= 13, `drawer top=${drawerAudit.top}`);
  assert.ok(drawerAudit.width <= 520, `drawer width=${drawerAudit.width}`);
  assert.ok(drawerAudit.backdrop && drawerAudit.backdrop !== "none", "drawer must retain glass blur");
  await page.screenshot({ path: path.join(reportDir, "source-editor-drawer.png"), fullPage: true });

  assert.deepEqual(consoleErrors, [], `console errors: ${consoleErrors.join(" | ")}`);
  fs.writeFileSync(
    path.join(reportDir, "qa.json"),
    JSON.stringify({ brandCenter, logoCenter, cacheAudit, states, themeRows, drawerAudit, consoleErrors }, null, 2),
  );
  await browser.close();
  console.log("v3.0.6 visual QA passed", { brandCenter, logoCenter, cacheAudit, states, drawerAudit });
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
