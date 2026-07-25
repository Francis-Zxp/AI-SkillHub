const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const baseUrl = process.env.AI_SKILLHUB_PREVIEW_URL || "http://127.0.0.1:4173";
const reportDir = path.resolve(__dirname, "../reports/visual/v3.0.7");
const themes = [
  "nocturne",
  "parchment",
  "atlas-dark",
  "atlas-light",
  "atlas-legacy-dark",
  "atlas-legacy-light",
  "dark",
  "light",
  "classic-dark",
  "classic-light",
];
fs.mkdirSync(reportDir, { recursive: true });

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 1 });
  const consoleErrors = [];
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  await page.addInitScript(() => {
    if (!localStorage.getItem("ai-skillhub-theme")) localStorage.setItem("ai-skillhub-theme", "nocturne");
    if (!localStorage.getItem("ai-skillhub-lang")) localStorage.setItem("ai-skillhub-lang", "zh");
  });

  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.locator(".skill-universe[data-universe-state='live']").waitFor({ timeout: 15_000 });

  const projectUrl = await page.evaluate(async () => {
    window.__aiSkillHubOpenedUrls = [];
    window.open = (url) => {
      window.__aiSkillHubOpenedUrls.push(String(url));
      return null;
    };
    document.querySelector(".project-home-link").click();
    await new Promise((resolve) => setTimeout(resolve, 30));
    return window.__aiSkillHubOpenedUrls[0] || "";
  });
  assert.equal(projectUrl, "https://github.com/Francis-Zxp/AI-SkillHub");

  const immersiveButton = page.locator(".atlas-immersive-toggle");
  await immersiveButton.click();
  await page.locator(".shell.dashboard-immersive").waitFor();
  await page.waitForTimeout(520);
  const immersiveAudit = await page.locator(".shell").evaluate((shell) => {
    const sidebar = shell.querySelector(".sidebar");
    const topbar = shell.querySelector(".topbar");
    const workspace = shell.querySelector(".workspace");
    const sidebarStyle = getComputedStyle(sidebar);
    const topbarStyle = getComputedStyle(topbar);
    const workspaceRect = workspace.getBoundingClientRect();
    return {
      sidebarOpacity: Number(sidebarStyle.opacity),
      sidebarPointerEvents: sidebarStyle.pointerEvents,
      topbarHeight: topbar.getBoundingClientRect().height,
      topbarOpacity: Number(topbarStyle.opacity),
      topbarPointerEvents: topbarStyle.pointerEvents,
      workspaceLeft: workspaceRect.left,
      workspaceWidth: workspaceRect.width,
    };
  });
  assert.ok(immersiveAudit.sidebarOpacity < 0.05, `sidebar opacity ${immersiveAudit.sidebarOpacity}`);
  assert.equal(immersiveAudit.sidebarPointerEvents, "none");
  assert.ok(immersiveAudit.topbarHeight < 1, `topbar height ${immersiveAudit.topbarHeight}`);
  assert.ok(immersiveAudit.topbarOpacity < 0.05, `topbar opacity ${immersiveAudit.topbarOpacity}`);
  assert.equal(immersiveAudit.topbarPointerEvents, "none");
  assert.ok(immersiveAudit.workspaceLeft < 1, `workspace left ${immersiveAudit.workspaceLeft}`);
  assert.ok(immersiveAudit.workspaceWidth > 1279, `workspace width ${immersiveAudit.workspaceWidth}`);
  await page.screenshot({ path: path.join(reportDir, "dashboard-immersive.png"), fullPage: true });

  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector(".shell")?.classList.contains("dashboard-immersive"));

  const cacheAudit = await page.evaluate(() => {
    const raw = localStorage.getItem("ai-skillhub-universe-cache-v1") || "";
    return {
      bytes: new Blob([raw]).size,
      leaksAbsolutePath: /(?:[A-Za-z]:\\|\/Users\/|\/home\/)/.test(raw),
      leaksNotes: /"note"\s*:|"localPath"\s*:/.test(raw),
    };
  });
  assert.ok(cacheAudit.bytes > 1000 && cacheAudit.bytes < 2_000_000, `cache bytes ${cacheAudit.bytes}`);
  assert.equal(cacheAudit.leaksAbsolutePath, false);
  assert.equal(cacheAudit.leaksNotes, false);

  const drawerAudits = [];
  for (const theme of themes) {
    await page.evaluate((nextTheme) => localStorage.setItem("ai-skillhub-theme", nextTheme), theme);
    await page.reload({ waitUntil: "networkidle" });
    await page.locator(".nav .nav-item").nth(1).click();
    const editButton = page.locator('[title="编辑来源"], [title="Edit source"], [title="소스 편집"]').first();
    await editButton.waitFor({ timeout: 10_000 });
    await editButton.click();
    const drawer = page.locator("#app-overlay-root > .drawer");
    await drawer.waitFor();
    await page.waitForTimeout(280);

    assert.equal(await page.locator("body > .drawer").count(), 0, `${theme}: drawer escaped the theme host`);
    const audit = await drawer.evaluate((element, expectedTheme) => {
      const parseColor = (value) => {
        const rgb = value.match(/rgba?\(([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ /,]+([\d.]+))?\)/i);
        if (rgb) return [Number(rgb[1]) / 255, Number(rgb[2]) / 255, Number(rgb[3]) / 255, rgb[4] === undefined ? 1 : Number(rgb[4])];
        const srgb = value.match(/color\(srgb\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)(?:\s*\/\s*([\d.]+))?\)/i);
        if (srgb) return [Number(srgb[1]), Number(srgb[2]), Number(srgb[3]), srgb[4] === undefined ? 1 : Number(srgb[4])];
        const hex = value.trim().match(/^#([\da-f]{6})$/i);
        if (hex) {
          const number = Number.parseInt(hex[1], 16);
          return [(number >> 16) / 255, ((number >> 8) & 255) / 255, (number & 255) / 255, 1];
        }
        throw new Error(`Unsupported color: ${value}`);
      };
      const composite = (foreground, background) => [
        foreground[0] * foreground[3] + background[0] * (1 - foreground[3]),
        foreground[1] * foreground[3] + background[1] * (1 - foreground[3]),
        foreground[2] * foreground[3] + background[2] * (1 - foreground[3]),
        1,
      ];
      const luminance = (color) => {
        const channel = color.slice(0, 3).map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
        return channel[0] * 0.2126 + channel[1] * 0.7152 + channel[2] * 0.0722;
      };
      const contrast = (left, right) => {
        const a = luminance(left);
        const b = luminance(right);
        return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      };
      const shell = element.closest(".shell");
      const shellStyle = getComputedStyle(shell);
      const drawerStyle = getComputedStyle(element);
      const input = element.querySelector("input, textarea, select");
      const inputStyle = input ? getComputedStyle(input) : null;
      const shellBackground = parseColor(shellStyle.getPropertyValue("--bg").trim());
      const drawerBackground = composite(parseColor(drawerStyle.backgroundColor), shellBackground);
      const drawerText = parseColor(drawerStyle.color);
      const inputBackground = inputStyle ? composite(parseColor(inputStyle.backgroundColor), drawerBackground) : drawerBackground;
      const inputText = inputStyle ? parseColor(inputStyle.color) : drawerText;
      const rect = element.getBoundingClientRect();
      return {
        expectedTheme,
        themeApplied: shell.classList.contains(`theme-${expectedTheme}`),
        drawerContrast: contrast(drawerText, drawerBackground),
        inputContrast: contrast(inputText, inputBackground),
        colorScheme: drawerStyle.colorScheme,
        backgroundColor: drawerStyle.backgroundColor,
        color: drawerStyle.color,
        left: rect.left,
        right: rect.right,
        top: rect.top,
        width: rect.width,
        zIndex: Number(drawerStyle.zIndex),
        backdrop: drawerStyle.backdropFilter || drawerStyle.webkitBackdropFilter,
      };
    }, theme);
    assert.equal(audit.themeApplied, true, `${theme}: theme class not applied`);
    assert.ok(audit.drawerContrast >= 4.5, `${theme}: drawer contrast ${audit.drawerContrast.toFixed(2)}`);
    assert.ok(audit.inputContrast >= 4.5, `${theme}: input contrast ${audit.inputContrast.toFixed(2)}`);
    assert.ok(audit.zIndex >= 101, `${theme}: drawer z-index ${audit.zIndex}`);
    assert.ok(audit.left > 700 && audit.right <= 1269, `${theme}: drawer geometry`);
    assert.ok(audit.backdrop && audit.backdrop !== "none", `${theme}: missing backdrop`);
    drawerAudits.push(audit);
    await page.screenshot({ path: path.join(reportDir, `drawer-${theme}.png`), fullPage: true });
  }

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  assert.ok(overflow <= 1, `horizontal overflow ${overflow}`);
  assert.deepEqual(consoleErrors, [], `console errors: ${consoleErrors.join(" | ")}`);
  fs.writeFileSync(
    path.join(reportDir, "qa.json"),
    JSON.stringify({ cacheAudit, projectUrl, immersiveAudit, drawerAudits, overflow, consoleErrors }, null, 2),
  );
  await browser.close();
  console.log("v3.0.7 visual QA passed", {
    drawerThemes: drawerAudits.length,
    minimumDrawerContrast: Math.min(...drawerAudits.map((item) => item.drawerContrast)).toFixed(2),
    minimumInputContrast: Math.min(...drawerAudits.map((item) => item.inputContrast)).toFixed(2),
    immersiveAudit,
  });
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
