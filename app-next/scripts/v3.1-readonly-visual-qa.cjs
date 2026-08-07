const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const baseUrl = process.env.AI_SKILLHUB_PREVIEW_URL || "http://127.0.0.1:4173";
const reportDir = path.resolve(__dirname, "../reports/visual/v3.1-readonly-foundation");
fs.mkdirSync(reportDir, { recursive: true });

async function auditSurface(page, { theme, view, selector, viewport, name }) {
  await page.setViewportSize(viewport);
  await page.goto(`${baseUrl}/?theme=${theme}&view=${view}`, { waitUntil: "networkidle" });
  await page.locator(selector).waitFor({ timeout: 15_000 });
  await page.waitForTimeout(180);

  const audit = await page.evaluate((surfaceSelector) => {
    const surface = document.querySelector(surfaceSelector);
    const buttons = [...surface.querySelectorAll("button")];
    const textNodes = [...surface.querySelectorAll("h2, h3, p, strong, span")]
      .filter((node) => node.textContent.trim().length > 0);
    const transparentText = textNodes.filter((node) => {
      const style = getComputedStyle(node);
      return style.visibility === "hidden" || Number(style.opacity) < 0.35;
    });
    const topbar = document.querySelector(".topbar");
    const topbarActions = document.querySelector(".topbar-actions");
    const topbarRect = topbar?.getBoundingClientRect();
    const actionRect = topbarActions?.getBoundingClientRect();
    return {
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      surfaceOverflow: surface.scrollWidth - surface.clientWidth,
      buttonCount: buttons.length,
      unnamedButtons: buttons.filter((button) => !(button.textContent || button.getAttribute("aria-label") || button.title).trim()).length,
      transparentText: transparentText.length,
      topbarRightOverflow: actionRect ? Math.max(0, actionRect.right - innerWidth) : 0,
      topbarBottomOverflow: actionRect && topbarRect ? Math.max(0, actionRect.bottom - topbarRect.bottom) : 0,
      themeApplied: document.querySelector(".shell")?.classList.contains(`theme-${new URLSearchParams(location.search).get("theme")}`) ?? false,
    };
  }, selector);

  assert.equal(audit.themeApplied, true, `${name}: theme was not applied`);
  assert.ok(audit.documentOverflow <= 1, `${name}: document overflow ${audit.documentOverflow}`);
  assert.ok(audit.surfaceOverflow <= 1, `${name}: surface overflow ${audit.surfaceOverflow}`);
  assert.equal(audit.unnamedButtons, 0, `${name}: unnamed buttons`);
  assert.equal(audit.transparentText, 0, `${name}: unexpectedly transparent text`);
  assert.ok(audit.topbarRightOverflow <= 1, `${name}: topbar right overflow ${audit.topbarRightOverflow}`);
  assert.ok(audit.topbarBottomOverflow <= 1, `${name}: topbar bottom overflow ${audit.topbarBottomOverflow}`);
  await page.screenshot({ path: path.join(reportDir, `${name}.png`), fullPage: true });
  return { name, ...audit };
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.AI_SKILLHUB_BROWSER_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 960 }, deviceScaleFactor: 1 });
  const consoleErrors = [];
  const failedResources = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("response", (response) => {
    if (response.status() >= 400 && !/favicon\.ico(?:\?|$)/.test(response.url())) {
      failedResources.push(`${response.status()} ${response.url()}`);
    }
  });
  await page.addInitScript(() => localStorage.setItem("ai-skillhub-lang", "zh"));

  const audits = [];
  audits.push(await auditSurface(page, {
    theme: "nocturne", view: "connections", selector: ".mcp-view",
    viewport: { width: 1440, height: 960 }, name: "mcp-nocturne-wide",
  }));
  audits.push(await auditSurface(page, {
    theme: "parchment", view: "connections", selector: ".mcp-view",
    viewport: { width: 1100, height: 760 }, name: "mcp-parchment-compact",
  }));
  audits.push(await auditSurface(page, {
    theme: "nocturne", view: "agents", selector: ".plugin-doctor-panel",
    viewport: { width: 1280, height: 860 }, name: "doctor-nocturne",
  }));
  audits.push(await auditSurface(page, {
    theme: "nocturne", view: "dashboard", selector: ".dashboard-view",
    viewport: { width: 860, height: 720 }, name: "dashboard-nocturne-high-dpi-window",
  }));

  const actionableConsoleErrors = consoleErrors.filter((message) => !message.includes("Failed to load resource"));
  assert.deepEqual(failedResources, [], `failed resources: ${failedResources.join(" | ")}`);
  assert.deepEqual(actionableConsoleErrors, [], `console errors: ${actionableConsoleErrors.join(" | ")}`);
  fs.writeFileSync(path.join(reportDir, "qa.json"), JSON.stringify({ audits, consoleErrors, failedResources }, null, 2));
  await browser.close();
  console.log("v3.1 read-only visual QA passed", audits);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
