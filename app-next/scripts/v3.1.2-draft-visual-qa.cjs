const { chromium } = require("playwright");

const baseUrl = process.env.AI_SKILLHUB_QA_URL || "http://127.0.0.1:4173";
const executablePath = process.env.AI_SKILLHUB_QA_BROWSER ||
  "C:/Program Files/Google/Chrome/Application/chrome.exe";

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  try {
    await page.goto(baseUrl, { waitUntil: "networkidle" });
    await page.getByRole("button", { name: /技能库/ }).click();
    await page.getByRole("button", { name: "添加来源" }).click();

    const repository = "https://github.com/Imbad0202/academic-research-skills-codex.git";
    await page.locator('input[placeholder*="owner/repo"]').fill(repository);
    await page.locator(".import-field select").selectOption("mixed");
    await page.getByRole("button", { name: "论文科研", exact: true }).click();
    await page.locator("input.category-custom").fill("科研套件");
    await page.locator('input[placeholder*="常用"]').fill("科研, Codex");
    await page.locator("textarea").fill("跨页面草稿验证");

    const stored = await page.evaluate(() =>
      localStorage.getItem("ai-skillhub-source-import-draft-v1")
    );
    if (!stored || !stored.includes("academic-research-skills-codex")) {
      throw new Error("Add Source draft was not saved.");
    }

    await page.getByRole("button", { name: /仪表盘/ }).click();
    await page.getByRole("button", { name: /技能库/ }).click();
    if (await page.locator('input[placeholder*="owner/repo"]').inputValue() !== repository) {
      throw new Error("Add Source draft did not survive navigation.");
    }

    await page.reload({ waitUntil: "networkidle" });
    await page.getByRole("button", { name: /技能库/ }).click();
    if (await page.locator('input[placeholder*="owner/repo"]').inputValue() !== repository) {
      throw new Error("Add Source draft did not survive a reload.");
    }
    if (await page.locator("input.category-custom").inputValue() !== "科研套件") {
      throw new Error("Custom category was not restored.");
    }

    await page.getByRole("button", { name: "清空草稿" }).click();
    const cleared = await page.evaluate(() =>
      localStorage.getItem("ai-skillhub-source-import-draft-v1")
    );
    if (cleared !== null) throw new Error("Clear draft left persisted state behind.");

    console.log(JSON.stringify({ navigationRestore: true, reloadRestore: true, manualClear: true }));
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
