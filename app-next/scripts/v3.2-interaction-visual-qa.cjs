const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const baseUrl = (process.env.AI_SKILLHUB_PREVIEW_URL || "http://127.0.0.1:4173").replace(/\/$/, "");
const reportDir = path.resolve(__dirname, "../reports/visual/v3.2-interaction");
fs.mkdirSync(reportDir, { recursive: true });

const report = {
  version: "3.2.1",
  baseUrl,
  startedAt: new Date().toISOString(),
  passed: false,
  audits: {},
  screenshots: [],
  isolatedRequests: { favicon: 0, thirdPartyTelemetry: 0 },
  consoleErrors: [],
  pageErrors: [],
  failedResources: []
};

function parseCssColor(value) {
  const match = String(value).match(/^rgba?\(([^)]+)\)$/i);
  assert.ok(match, `unsupported computed color: ${value}`);
  const parts = match[1].split(/[\s,\/]+/).filter(Boolean).map(Number);
  assert.ok(parts.length >= 3 && parts.slice(0, 3).every(Number.isFinite), `invalid computed color: ${value}`);
  return { r: parts[0], g: parts[1], b: parts[2], a: Number.isFinite(parts[3]) ? parts[3] : 1 };
}

function composite(foreground, background) {
  const alpha = foreground.a + background.a * (1 - foreground.a);
  if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 };
  return {
    r: (foreground.r * foreground.a + background.r * background.a * (1 - foreground.a)) / alpha,
    g: (foreground.g * foreground.a + background.g * background.a * (1 - foreground.a)) / alpha,
    b: (foreground.b * foreground.a + background.b * background.a * (1 - foreground.a)) / alpha,
    a: alpha
  };
}

function effectiveBackground(colors, colorScheme) {
  const fallback = String(colorScheme).includes("dark")
    ? { r: 0, g: 0, b: 0, a: 1 }
    : { r: 255, g: 255, b: 255, a: 1 };
  return colors.map(parseCssColor).reduce((background, foreground) => composite(foreground, background), fallback);
}

function relativeLuminance(color) {
  const channel = value => {
    const normalized = value / 255;
    return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

function contrastRatio(textColor, backgroundColor) {
  const text = composite(parseCssColor(textColor), backgroundColor);
  const light = Math.max(relativeLuminance(text), relativeLuminance(backgroundColor));
  const dark = Math.min(relativeLuminance(text), relativeLuminance(backgroundColor));
  return (light + 0.05) / (dark + 0.05);
}

async function gotoView(page, theme, view, selector) {
  await page.goto(`${baseUrl}/?theme=${theme}&view=${view}`, { waitUntil: "networkidle" });
  await page.locator(selector).waitFor({ timeout: 15_000 });
  await page.waitForTimeout(120);
}

async function takeScreenshot(page, name) {
  const filename = `${name}.png`;
  await page.screenshot({ path: path.join(reportDir, filename), fullPage: true });
  report.screenshots.push(filename);
}

async function auditRefreshInteractionWindow(page) {
  await page.setViewportSize({ width: 1280, height: 820 });
  await gotoView(page, "nocturne", "dashboard", ".dashboard-view");

  const refresh = page.locator(".topbar .primary-pill");
  const search = page.locator(".command-search input");
  const dashboardNav = page.locator(".nav .nav-item").nth(0);
  const libraryNav = page.locator(".nav .nav-item").nth(1);
  assert.equal(await refresh.isEnabled(), true, "preview refresh button is disabled before the test");
  assert.equal(await search.isEnabled(), true, "search is disabled before refresh");

  const started = Date.now();
  await refresh.click();
  await page.waitForTimeout(50);
  await libraryNav.click();
  await page.locator(".library-view").waitFor();
  await search.fill("paper-workflow");
  await page.locator(".skill-row").filter({ hasText: "paper-workflow" }).first().waitFor();
  const firstInteractionMs = Date.now() - started;
  assert.ok(firstInteractionMs < 650, `first navigation/search took ${firstInteractionMs}ms after refresh`);

  await page.waitForTimeout(Math.max(0, 200 - (Date.now() - started)));
  const secondInteractionStartedMs = Date.now() - started;
  assert.ok(secondInteractionStartedMs < 650, `second page switch was not started inside the 650ms window (${secondInteractionStartedMs}ms)`);
  await dashboardNav.click();
  await page.locator(".dashboard-view").waitFor();
  await libraryNav.click();
  await page.locator(".library-view").waitFor();
  const secondInteractionMs = Date.now() - started;
  assert.ok(secondInteractionMs - secondInteractionStartedMs < 650, `second page switch stalled for ${secondInteractionMs - secondInteractionStartedMs}ms`);
  assert.equal(await search.inputValue(), "paper-workflow", "search state was lost while switching pages during refresh");
  assert.equal(await search.isEnabled(), true, "search became disabled during the refresh interaction window");

  await page.waitForTimeout(Math.max(0, 650 - (Date.now() - started)));
  assert.equal(await page.locator(".library-view").isVisible(), true, "library was not usable at the end of the 650ms window");
  assert.equal(await page.locator(".nav .nav-item.active").count(), 1, "navigation active state became inconsistent");
  await takeScreenshot(page, "refresh-navigation-search-nocturne");

  return {
    windowMs: 650,
    firstInteractionMs,
    secondInteractionStartedMs,
    secondInteractionMs,
    finalSearch: await search.inputValue(),
    finalView: "library"
  };
}

async function auditFolderControlsAndCopy(page) {
  const search = page.locator(".command-search input");
  await search.fill("");
  const source = page.locator(".source-group").filter({ hasText: "Nature-Paper-Skills" }).first();
  await source.waitFor();
  const toggle = source.locator(".source-group-toggle");
  const parentCopyButton = source.locator(".source-parent-copy");
  await parentCopyButton.waitFor();
  if (await toggle.getAttribute("aria-expanded") === "true") {
    await toggle.click();
    await page.waitForFunction(element => element.getAttribute("aria-expanded") === "false", await toggle.elementHandle());
  }
  const collapsedBeforeParentCopy = await toggle.getAttribute("aria-expanded");
  assert.equal(collapsedBeforeParentCopy, "false", "parent copy was not tested from the collapsed source state");
  const parentCopyTitle = await parentCopyButton.getAttribute("title");
  const exactParentName = "nature-paper-skills";
  assert.equal(parentCopyTitle.split(/[：:]/).pop().trim(), exactParentName, "parent copy title did not expose the host invocation name");
  await page.evaluate(() => { window.__v32QaClipboardText = ""; });
  await parentCopyButton.click();
  await page.waitForFunction(expected => window.__v32QaClipboardText === expected, exactParentName);
  const copiedParentName = await page.evaluate(() => window.__v32QaClipboardText);
  assert.equal(copiedParentName, exactParentName, "parent copy button changed the exact router Skill name");
  assert.equal(await toggle.getAttribute("aria-expanded"), "false", "copying the parent router expanded the source tree");

  await toggle.click();
  await page.waitForFunction(element => element.getAttribute("aria-expanded") === "true", await toggle.elementHandle());
  const child = source.locator(".skill-row:not(.is-parent)").first();
  const childName = (await child.locator(".skill-row-main > header > strong").textContent()).trim();
  const childCopyButton = child.locator(".skill-name-copy");
  await childCopyButton.waitFor();
  await page.evaluate(() => { window.__v32QaClipboardText = ""; });
  await childCopyButton.click();
  await page.waitForFunction(expected => window.__v32QaClipboardText === expected, childName);
  const copiedChildName = await page.evaluate(() => window.__v32QaClipboardText);
  assert.equal(copiedChildName, childName, "child copy button changed the exact child Skill name");

  await page.locator(".skill-folder-shelf").scrollIntoViewIfNeeded();
  const dragSource = page.locator(".source-group").first();
  const dragToggle = dragSource.locator(".source-group-toggle");
  const grip = dragSource.locator(".source-folder-drag-handle");
  const folderSelect = dragSource.locator(".source-folder-select select");
  await grip.waitFor();
  await folderSelect.waitFor();
  const structure = await dragSource.evaluate(sourceNode => {
    const handle = sourceNode.querySelector(".source-folder-drag-handle");
    const select = sourceNode.querySelector(".source-folder-select select");
    window.__v32QaFolderEvents = { dragStarts: 0, dragTypes: [], selectClicks: 0, selectChanges: 0 };
    document.addEventListener("dragstart", event => {
      if (!handle.contains(event.target)) return;
      window.__v32QaFolderEvents.dragStarts += 1;
      window.__v32QaFolderEvents.dragTypes = [...event.dataTransfer.types];
    }, { once: true });
    select.addEventListener("click", () => { window.__v32QaFolderEvents.selectClicks += 1; });
    select.addEventListener("change", () => { window.__v32QaFolderEvents.selectChanges += 1; });
    return {
      gripTag: handle.tagName,
      gripDraggable: handle.draggable,
      gripContainsSelect: handle.contains(select),
      selectTag: select.tagName,
      selectId: select.id
    };
  });
  assert.equal(structure.gripTag, "SPAN", "drag grip is not a dedicated non-button handle");
  assert.equal(structure.gripDraggable, true, "source drag grip is not draggable");
  assert.equal(structure.gripContainsSelect, false, "folder select is nested inside the drag grip");
  assert.equal(structure.selectTag, "SELECT", "folder selection is not a native independent select");

  const expandedBeforeGripClick = await dragToggle.getAttribute("aria-expanded");
  const selectedBeforeGripClick = await folderSelect.inputValue();
  await grip.click();
  const afterGripClick = await page.evaluate(() => ({
    ...window.__v32QaFolderEvents,
    activeElementId: document.activeElement?.id || ""
  }));
  assert.equal(await dragToggle.getAttribute("aria-expanded"), expandedBeforeGripClick, "clicking the drag grip toggled the source tree");
  assert.equal(await folderSelect.inputValue(), selectedBeforeGripClick, "clicking the drag grip changed the folder selection");
  assert.equal(afterGripClick.selectClicks, 0, "clicking the drag grip opened/clicked the folder select");
  assert.notEqual(afterGripClick.activeElementId, structure.selectId, "clicking the drag grip focused the folder select");

  const folderOptions = await folderSelect.locator("option").evaluateAll(options =>
    options.map(option => ({ label: option.textContent.trim(), value: option.value }))
  );
  const targetOption = folderOptions.find(option => option.value && option.value !== selectedBeforeGripClick);
  assert.ok(targetOption, "preview fixture has no alternate folder option");
  const dropTarget = page.locator(".skill-folder-target").filter({ hasText: targetOption.label }).first();
  await dropTarget.evaluate(target => {
    window.__v32QaFolderDropEvents = { dragEnter: 0, dragEnterTypes: [], dragOver: 0, dragOverTypes: [], drop: 0 };
    target.addEventListener("dragenter", event => {
      window.__v32QaFolderDropEvents.dragEnter += 1;
      window.__v32QaFolderDropEvents.dragEnterTypes = [...event.dataTransfer.types];
    });
    target.addEventListener("dragover", event => {
      window.__v32QaFolderDropEvents.dragOver += 1;
      window.__v32QaFolderDropEvents.dragOverTypes = [...event.dataTransfer.types];
    });
    target.addEventListener("drop", () => { window.__v32QaFolderDropEvents.drop += 1; });
  });
  await page.evaluate(() => window.scrollBy({ top: -160, behavior: "instant" }));
  await page.waitForTimeout(50);
  const gripBox = await grip.boundingBox();
  const targetBox = await dropTarget.boundingBox();
  assert.ok(gripBox && targetBox, "drag grip or folder target has no visible box");
  const targetHitTest = await dropTarget.evaluate(target => {
    const rect = target.getBoundingClientRect();
    const hit = document.elementFromPoint(rect.left + rect.width * 0.2, rect.top + rect.height / 2);
    return Boolean(hit && (hit === target || target.contains(hit)));
  });
  assert.equal(targetHitTest, true, "sticky page chrome covered the folder drag target");
  await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(gripBox.x + gripBox.width / 2 + 12, gripBox.y + gripBox.height / 2 + 4, { steps: 4 });
  await page.mouse.move(targetBox.x + Math.min(32, targetBox.width * 0.2), targetBox.y + targetBox.height / 2, { steps: 18 });
  await page.waitForTimeout(80);
  await page.mouse.up();
  const afterDrag = await page.evaluate(() => ({ ...window.__v32QaFolderEvents }));
  const realDrag = await page.evaluate(() => ({ ...window.__v32QaFolderDropEvents }));
  assert.equal(afterDrag.dragStarts, 1, "real dragstart did not originate from the dedicated grip");
  assert.equal(afterDrag.selectClicks, 0, "real dragstart opened/clicked the folder select");
  assert.ok(realDrag.dragEnter >= 1, `real pointer drag never entered a folder target: ${JSON.stringify({ afterDrag, realDrag, gripBox, targetBox, targetOption })}`);
  assert.ok(realDrag.dragOver >= 1, `real pointer drag was rejected by the folder target: ${JSON.stringify({ afterDrag, realDrag, gripBox, targetBox, targetOption })}`);
  assert.ok(realDrag.dragEnterTypes.includes("application/x-ai-skillhub-source-id"), "folder dragenter did not carry the internal source MIME type");
  assert.ok(realDrag.dragOverTypes.includes("application/x-ai-skillhub-source-id"), "folder dragover did not carry the internal source MIME type");
  assert.equal(realDrag.drop, 1, "real pointer drag did not produce one folder drop");

  const externalDrop = await dropTarget.evaluate(target => {
    const dispatch = transfer => {
      const enter = new DragEvent("dragenter", { bubbles: true, cancelable: true, dataTransfer: transfer });
      const over = new DragEvent("dragover", { bubbles: true, cancelable: true, dataTransfer: transfer });
      const drop = new DragEvent("drop", { bubbles: true, cancelable: true, dataTransfer: transfer });
      target.dispatchEvent(enter);
      target.dispatchEvent(over);
      target.dispatchEvent(drop);
      return {
        enterPrevented: enter.defaultPrevented,
        overPrevented: over.defaultPrevented,
        dropPrevented: drop.defaultPrevented
      };
    };
    const textTransfer = new DataTransfer();
    textTransfer.setData("text/plain", "external-text-must-not-be-treated-as-a-skill-id");
    const fileTransfer = new DataTransfer();
    fileTransfer.items.add(new File(["not an import"], "not-an-import.zip", { type: "application/zip" }));
    return { text: dispatch(textTransfer), file: dispatch(fileTransfer) };
  });
  await page.waitForTimeout(50);
  assert.equal(await dropTarget.evaluate(target => target.classList.contains("drop-ready")), false, "external text lit an internal folder drop target");
  for (const [kind, result] of Object.entries(externalDrop)) {
    assert.equal(result.enterPrevented, false, `folder target accepted external ${kind} as an internal drag`);
    assert.equal(result.overPrevented, true, `window did not block external ${kind} from browser navigation`);
    assert.equal(result.dropPrevented, true, `window did not block an external ${kind} drop`);
  }

  const optionValues = await folderSelect.locator("option").evaluateAll(options => options.map(option => option.value));
  const targetFolder = optionValues.find(value => value && value !== selectedBeforeGripClick);
  assert.ok(targetFolder, "preview fixture has no alternate folder option");
  await folderSelect.selectOption(targetFolder);
  const afterSelect = await page.evaluate(() => ({ ...window.__v32QaFolderEvents }));
  assert.ok(afterSelect.selectChanges >= 1, "independent folder select did not emit a change");
  assert.equal(afterSelect.dragStarts, 1, "selecting a folder started another drag operation");

  await takeScreenshot(page, "folder-controls-and-parent-copy-nocturne");
  return {
    structure,
    afterGripClick,
    afterDrag,
    realDrag,
    externalDrop,
    afterSelect,
    exactParentName,
    copiedParentName,
    childName,
    copiedChildName
  };
}

async function auditThemeSelect(page, theme, expectedScheme) {
  await gotoView(page, theme, "library", ".library-view");
  const select = page.locator(".source-folder-select select").first();
  await select.waitFor();
  const styles = await select.evaluate(element => {
    const option = element.selectedOptions[0] || element.options[0];
    const backgrounds = [];
    let current = element;
    while (current) {
      backgrounds.unshift(getComputedStyle(current).backgroundColor);
      current = current.parentElement;
    }
    const optionStyle = getComputedStyle(option);
    const elementStyle = getComputedStyle(element);
    return {
      selectedText: option.textContent.trim(),
      colorScheme: elementStyle.colorScheme,
      selectColor: elementStyle.color,
      selectBackgrounds: backgrounds,
      optionColor: optionStyle.color,
      optionBackgrounds: [...backgrounds, optionStyle.backgroundColor]
    };
  });
  const selectBackground = effectiveBackground(styles.selectBackgrounds, styles.colorScheme);
  const optionBackground = effectiveBackground(styles.optionBackgrounds, styles.colorScheme);
  const selectContrast = contrastRatio(styles.selectColor, selectBackground);
  const optionContrast = contrastRatio(styles.optionColor, optionBackground);
  assert.ok(styles.selectedText.length > 0, `${theme}: folder select has no readable selected text`);
  assert.ok(styles.colorScheme.includes(expectedScheme), `${theme}: expected ${expectedScheme} native control scheme, got ${styles.colorScheme}`);
  assert.ok(selectContrast >= 4.5, `${theme}: select contrast is ${selectContrast.toFixed(2)}:1`);
  assert.ok(optionContrast >= 4.5, `${theme}: option contrast is ${optionContrast.toFixed(2)}:1`);
  await takeScreenshot(page, `folder-select-${theme}`);
  return {
    theme,
    colorScheme: styles.colorScheme,
    selectedText: styles.selectedText,
    selectContrast: Number(selectContrast.toFixed(2)),
    optionContrast: Number(optionContrast.toFixed(2))
  };
}

async function auditMcpPreviewBoundary(page) {
  await page.setViewportSize({ width: 1100, height: 760 });
  await gotoView(page, "nocturne", "connections", ".mcp-view");
  const previewNote = page.locator(".mcp-preview-note");
  assert.equal(await previewNote.isVisible(), true, "MCP browser preview boundary is not visible");
  assert.ok((await previewNote.textContent()).trim().length > 20, "MCP browser preview boundary has no useful text");

  await page.locator(".mcp-page-header .primary-action").click();
  const form = page.locator(".mcp-management-form");
  await form.waitFor();
  const writeActions = page.locator([
    ".mcp-management-form button[type='submit']",
    ".mcp-binding-actions button",
    ".mcp-snapshot-panel button"
  ].join(", "));
  const writeActionCount = await writeActions.count();
  assert.ok(writeActionCount >= 1, "MCP preview exposed no auditable write action");
  const writeActionStates = await writeActions.evaluateAll(buttons => buttons.map(button => ({
    text: button.textContent.trim(),
    disabled: button.disabled
  })));
  assert.ok(writeActionStates.every(action => action.disabled), `MCP preview write action is enabled: ${JSON.stringify(writeActionStates)}`);

  const overflow = await page.evaluate(() => {
    const view = document.querySelector(".mcp-view");
    return {
      document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      view: view.scrollWidth - view.clientWidth
    };
  });
  assert.ok(overflow.document <= 1, `MCP preview document horizontal overflow: ${overflow.document}px`);
  assert.ok(overflow.view <= 1, `MCP preview surface horizontal overflow: ${overflow.view}px`);
  await takeScreenshot(page, "mcp-preview-write-disabled-nocturne");
  return {
    previewNotice: (await previewNote.textContent()).trim(),
    editorCanOpenWithoutWriting: true,
    writeActionStates,
    overflow
  };
}

async function auditMultiPageNavigation(page) {
  const targets = [
    { name: "agents", nav: page.locator(".nav .nav-item").nth(3), selector: ".agents-view" },
    { name: "settings", nav: page.locator(".sidebar-footer .nav-item").nth(0), selector: ".settings-view" },
    { name: "dashboard", nav: page.locator(".nav .nav-item").nth(0), selector: ".dashboard-view" },
    { name: "library", nav: page.locator(".nav .nav-item").nth(1), selector: ".library-view" },
    { name: "connections", nav: page.locator(".nav .nav-item").nth(4), selector: ".mcp-view" }
  ];
  const visited = [];
  for (const target of targets) {
    await target.nav.click();
    await page.locator(target.selector).waitFor({ timeout: 15_000 });
    await page.waitForTimeout(100);
    const activeCount = await page.locator(".nav-item.active").count();
    assert.equal(activeCount, 1, `${target.name}: navigation has ${activeCount} active entries`);
    visited.push(target.name);
  }
  await takeScreenshot(page, "multi-page-final-connections-nocturne");
  return { visited };
}

(async () => {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.AI_SKILLHUB_BROWSER_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 820 },
      deviceScaleFactor: 1,
      permissions: ["clipboard-read", "clipboard-write"]
    });
    await context.route("**/favicon.ico", async route => {
      report.isolatedRequests.favicon += 1;
      await route.fulfill({ status: 204, body: "" });
    });
    await context.route("https://vibecafe.ai/api/**", async route => {
      report.isolatedRequests.thirdPartyTelemetry += 1;
      await route.fulfill({
        status: 204,
        body: "",
        headers: {
          "access-control-allow-origin": "*",
          "access-control-allow-methods": "POST, OPTIONS",
          "access-control-allow-headers": "*"
        }
      });
    });
    await context.addInitScript(() => {
      localStorage.setItem("ai-skillhub-lang", "zh");
      window.__v32QaClipboardText = "";
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: {
          writeText: async value => { window.__v32QaClipboardText = String(value); },
          readText: async () => window.__v32QaClipboardText
        }
      });
    });
    const page = await context.newPage();

    page.on("console", message => {
      if (message.type() === "error" && !message.text().includes("favicon.ico")) {
        report.consoleErrors.push({ url: page.url(), text: message.text() });
      }
    });
    page.on("pageerror", error => {
      report.pageErrors.push({ url: page.url(), text: error.stack || error.message });
    });
    page.on("response", response => {
      if (response.status() >= 400 && !/favicon\.ico(?:\?|$)/.test(response.url())) {
        report.failedResources.push(`${response.status()} ${response.url()}`);
      }
    });
    page.on("requestfailed", request => {
      if (!/favicon\.ico(?:\?|$)/.test(request.url()) && !request.url().startsWith("https://vibecafe.ai/api/")) {
        report.failedResources.push(`REQUEST_FAILED ${request.url()} ${request.failure()?.errorText || "unknown"}`);
      }
    });

    report.audits.refreshInteraction = await auditRefreshInteractionWindow(page);
    report.audits.folderControlsAndCopy = await auditFolderControlsAndCopy(page);
    report.audits.themeSelects = [
      await auditThemeSelect(page, "nocturne", "dark"),
      await auditThemeSelect(page, "parchment", "light")
    ];
    report.audits.mcpPreview = await auditMcpPreviewBoundary(page);
    report.audits.multiPage = await auditMultiPageNavigation(page);
    await page.waitForTimeout(250);

    report.failedResources = [...new Set(report.failedResources)];
    assert.deepEqual(report.consoleErrors, [], `console errors: ${JSON.stringify(report.consoleErrors)}`);
    assert.deepEqual(report.pageErrors, [], `page errors: ${JSON.stringify(report.pageErrors)}`);
    assert.deepEqual(report.failedResources, [], `failed resources: ${report.failedResources.join(" | ")}`);
    report.passed = true;
    console.log("v3.2 interaction visual QA passed", report.audits);
  } catch (error) {
    report.failure = error.stack || error.message || String(error);
    console.error(error);
    process.exitCode = 1;
  } finally {
    report.finishedAt = new Date().toISOString();
    fs.writeFileSync(path.join(reportDir, "qa.json"), `${JSON.stringify(report, null, 2)}\n`);
    if (browser) await browser.close();
  }
})();
