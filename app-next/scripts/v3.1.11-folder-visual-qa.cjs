const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const baseUrl = process.env.AI_SKILLHUB_PREVIEW_URL || "http://127.0.0.1:4173";
const reportDir = path.resolve(__dirname, "../reports/visual/v3.1.11-folder-prompt");
fs.mkdirSync(reportDir, { recursive: true });

function overlaps(left, right) {
  return !(
    left.right <= right.left ||
    right.right <= left.left ||
    left.bottom <= right.top ||
    right.bottom <= left.top
  );
}

async function auditLibrary(page, viewport, name) {
  await page.setViewportSize(viewport);
  await page.goto(`${baseUrl}/?theme=parchment&view=library`, { waitUntil: "networkidle" });
  await page.locator(".skill-folder-shelf").waitFor({ timeout: 15_000 });

  const geometry = await page.evaluate(() => {
    const rect = element => {
      const value = element.getBoundingClientRect();
      return { left: value.left, right: value.right, top: value.top, bottom: value.bottom, width: value.width, height: value.height };
    };
    return {
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      stripOverflow: document.querySelector(".skill-folder-strip").scrollWidth - document.querySelector(".skill-folder-strip").clientWidth,
      cards: [...document.querySelectorAll(".skill-folder-item")].map(item => ({
        item: rect(item),
        manage: rect(item.querySelector(".skill-folder-manage")),
        title: rect(item.querySelector(".skill-folder-target strong")),
        count: rect(item.querySelector(".skill-folder-target b")),
        titleText: item.querySelector(".skill-folder-target strong").textContent.trim()
      }))
    };
  });

  assert.ok(geometry.documentOverflow <= 1, `${name}: document overflow ${geometry.documentOverflow}`);
  assert.ok(geometry.stripOverflow <= 1, `${name}: folder strip overflow ${geometry.stripOverflow}`);
  assert.ok(geometry.cards.length >= 4, `${name}: expected preview folder cards`);
  for (const card of geometry.cards) {
    assert.ok(card.manage.width >= 44 && card.manage.height >= 44, `${name}: edit target smaller than 44px`);
    assert.ok(card.manage.left >= card.item.left && card.manage.right <= card.item.right + 1, `${name}: edit target escaped its card`);
    assert.ok(!overlaps(card.manage, card.title), `${name}: edit overlaps title ${card.titleText}`);
    assert.ok(!overlaps(card.manage, card.count), `${name}: edit overlaps count ${card.titleText}`);
    assert.ok(card.title.width > 20, `${name}: hidden folder title ${card.titleText}`);
  }

  await page.locator(".skill-folder-manage").first().click();
  await page.locator(".skill-folder-editor").waitFor();
  const editor = await page.evaluate(() => ({
    colors: [...document.querySelectorAll(".skill-folder-editor .folder-color-dot")].map(element => ({
      width: element.getBoundingClientRect().width,
      height: element.getBoundingClientRect().height,
      color: getComputedStyle(element).backgroundColor
    })),
    actionHeights: [...document.querySelectorAll(".skill-folder-editor-actions button")].map(element => element.getBoundingClientRect().height),
    inputHeights: [...document.querySelectorAll(".skill-folder-editor input")].map(element => element.getBoundingClientRect().height)
  }));
  assert.equal(editor.colors.length, 8, `${name}: folder palette is incomplete`);
  assert.equal(new Set(editor.colors.map(item => item.color)).size, 8, `${name}: theme covered folder colors`);
  assert.ok(editor.colors.every(item => item.width >= 44 && item.height >= 44), `${name}: color target smaller than 44px`);
  assert.ok(editor.actionHeights.every(value => value >= 44), `${name}: folder action smaller than 44px`);
  assert.ok(editor.inputHeights.every(value => value >= 44), `${name}: folder input smaller than 44px`);

  await page.getByRole("button", { name: "取消" }).click();
  const promptSource = page.locator(".source-group").filter({ hasText: "awesome-ai-research-writing" });
  await promptSource.locator(".source-group-toggle").click();
  await promptSource.locator(".prompt-source-callout").waitFor();
  const promptAction = promptSource.getByRole("button", { name: "准备调用" });
  assert.equal(await promptAction.isVisible(), true, `${name}: Prompt call action is not visible`);
  const promptNameWidth = await promptSource.locator(".source-group-title strong").evaluate(element => element.getBoundingClientRect().width);
  assert.ok(promptNameWidth > 80, `${name}: Prompt source name is hidden`);

  await page.screenshot({ path: path.join(reportDir, `${name}.png`), fullPage: true });
  return { name, ...geometry, editor };
}

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: process.env.AI_SKILLHUB_BROWSER_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
  });
  const page = await browser.newPage({ viewport: { width: 1280, height: 820 }, deviceScaleFactor: 1 });
  const errors = [];
  const failedResources = [];
  page.on("console", message => { if (message.type() === "error") errors.push(message.text()); });
  page.on("response", response => {
    if (response.status() >= 400 && !/favicon\.ico(?:\?|$)/.test(response.url())) {
      failedResources.push(`${response.status()} ${response.url()}`);
    }
  });
  await page.addInitScript(() => localStorage.setItem("ai-skillhub-lang", "zh"));

  const audits = [];
  audits.push(await auditLibrary(page, { width: 1280, height: 820 }, "library-default-1280"));
  audits.push(await auditLibrary(page, { width: 1040, height: 680 }, "library-minimum-1040"));
  assert.deepEqual(failedResources, [], `failed resources: ${failedResources.join(" | ")}`);
  const actionableErrors = errors.filter(message => !message.includes("Failed to load resource"));
  assert.deepEqual(actionableErrors, [], `console errors: ${errors.join(" | ")}`);
  fs.writeFileSync(path.join(reportDir, "qa.json"), JSON.stringify({ audits, errors, failedResources }, null, 2));
  await browser.close();
  console.log("v3.1.11 folder visual QA passed", audits.map(audit => audit.name));
})().catch(error => {
  console.error(error);
  process.exit(1);
});
