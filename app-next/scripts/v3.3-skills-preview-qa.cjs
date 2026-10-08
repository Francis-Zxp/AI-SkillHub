// v3.3 Skills browser-preview QA (docs/v3.3/skills-contract.md §8.3). Runs against a Vite dev
// server (`pnpm dev`) with the preview mock; nothing touches the real machine.
//   QA_BASE_URL=http://127.0.0.1:1433 QA_SHOTS=<dir> node scripts/v3.3-skills-preview-qa.cjs
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const BASE = process.env.QA_BASE_URL || "http://127.0.0.1:1420";
const SHOTS = process.env.QA_SHOTS || path.join(__dirname, "..", "reports", "v3.3-skills-ui-shots");
const BANNED = /宿主|投递|交付|闸门|隔离区|路由|staging|dry-run|适配器|待接管|真实写入/;
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
let browser;

async function open(query = "", { width = 1440, height = 900, lang = "zh" } = {}) {
  const context = await browser.newContext({ viewport: { width, height } });
  await context.addInitScript(language => {
    try {
      localStorage.setItem("ai-skillhub-lang", language);
      localStorage.setItem("ai-skillhub-telemetry", "0");
      localStorage.setItem("skillhub-sky-scene", "0");
    } catch {
      // storage can be unavailable; the defaults still work
    }
  }, lang);
  const page = await context.newPage();
  page.errors = [];
  page.on("pageerror", error => page.errors.push(error.message));
  page.on("console", message => {
    if (message.type() === "error" && !/Failed to load resource/.test(message.text())) page.errors.push(message.text());
  });
  await page.goto(`${BASE}/${query}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(900);
  return page;
}

async function shot(page, name) {
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

async function check(name, run) {
  const started = Date.now();
  try {
    await run();
    results.push({ name, ok: true, ms: Date.now() - started });
  } catch (error) {
    results.push({ name, ok: false, ms: Date.now() - started, error: String(error && error.message || error).slice(0, 600) });
  }
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

const preview = page => page.evaluate(() => window.__skillhubPreview ?? { jobs: [], clientWrites: [] });
// Idle = no running job and the sync indicator is not busy (a queued batch is not in `jobs` yet).
const waitForJobsIdle = async page => {
  for (let round = 0; round < 2; round += 1) {
    await page.waitForFunction(() => {
      const jobs = window.__skillhubPreview?.jobs ?? [];
      const indicator = document.querySelector('[data-testid="sync-indicator"]');
      return jobs.every(job => job.phase !== "running") && indicator?.getAttribute("data-tone") !== "busy";
    }, null, { timeout: 10000 });
    await page.waitForTimeout(900);
  }
};

async function openLibrary(page) {
  await page.click('[data-testid="nav-library"]');
  await page.waitForSelector('[data-testid="library-page"]');
  await page.waitForTimeout(300);
}

async function openSheet(page) {
  await page.click('[data-testid="add-button"]');
  await page.waitForSelector('[data-testid="import-sheet"]');
}

async function probe(page, text) {
  await page.fill('[data-testid="import-input"]', text);
  await page.press('[data-testid="import-input"]', "Enter");
}

(async () => {
  browser = await chromium.launch({ channel: "chrome" });

  await check("S0-1 one click on 添加 opens the sheet with the input focused", async () => {
    const page = await open();
    await shot(page, "01-home");
    await page.click('[data-testid="add-button"]');
    await page.waitForSelector('[data-testid="import-sheet"]');
    expect(await page.locator(".import-sheet").count() === 1, "exactly one sheet");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid")) === "import-input", "input focused");
    await page.keyboard.press("Escape");
    await page.waitForSelector('[data-testid="import-sheet"]', { state: "detached" });
    await page.click('[data-testid="home-add-button"]');
    await page.waitForSelector('[data-testid="import-sheet"]');
    expect(await page.locator(".import-sheet").count() === 1, "home 添加 opens one sheet");
    expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid")) === "import-input", "input focused from home 添加");
    await shot(page, "02-import-empty");
    await page.context().close();
  });

  await check("S0-2 one box, preview, preselected tools, flagged stays library-only, MCP hand-off", async () => {
    const page = await open();
    await openSheet(page);
    const controls = await page.$$eval('[data-testid="import-sheet"] button, [data-testid="import-sheet"] input', nodes =>
      nodes.filter(node => !node.disabled && node.offsetParent !== null && node.getAttribute("data-testid") !== "import-close").length);
    expect(controls <= 3, `at most 3 controls before typing, saw ${controls}`);

    await probe(page, "anthropics/skills");
    await page.waitForSelector('[data-testid="import-preview"]', { timeout: 8000 });
    expect(await page.locator('[data-testid="import-skill-group"]').count() >= 2, "groups listed");
    const pressed = await page.$$eval('[data-testid^="import-agent-chip-"]', chips => chips.filter(chip => chip.getAttribute("aria-pressed") === "true").map(chip => chip.getAttribute("data-testid").replace("import-agent-chip-", "")).sort());
    expect(JSON.stringify(pressed) === JSON.stringify(["claude", "codex", "coze", "workbuddy"]), `preselected chips ${pressed}`);
    const submit = (await page.textContent('[data-testid="import-submit"]')).trim();
    expect(/^安装到 \d+ 个 AI 工具$/.test(submit), `submit label "${submit}"`);
    await shot(page, "03-import-preview");

    await probe(page, "https://github.com/anthropics/skills/tree/main/skills/pdf");
    await page.waitForFunction(() => document.querySelector('[data-testid="import-preview"] .import-preview-head small')?.textContent?.includes("1 个技能"), null, { timeout: 8000 });

    await probe(page, "example/flagged-skills");
    await page.waitForFunction(() => document.querySelector('[data-testid="import-security-card"]')?.getAttribute("data-status") === "review", null, { timeout: 8000 });
    expect((await page.textContent('[data-testid="import-submit"]')).trim() === "仅加入技能库（保持停用）", "flagged label");
    const enabledChips = await page.$$eval('[data-testid^="import-agent-chip-"]', chips => chips.filter(chip => !chip.disabled).length);
    expect(enabledChips === 0, "all chips disabled for a flagged source");
    await shot(page, "04-import-flagged");
    await page.click('[data-testid="import-submit"]');
    await page.waitForSelector('[data-testid="import-done"]', { timeout: 8000 });
    await page.click('[data-testid="import-close"]');
    await openLibrary(page);
    const statuses = await page.$$eval('[data-testid^="library-row-source-preview-"] [data-testid^="target-icon-"]', icons => icons.map(icon => icon.getAttribute("data-status")));
    expect(statuses.length > 0 && statuses.every(status => status === "blocked"), `flagged row icons ${statuses}`);

    await openSheet(page);
    await page.fill('[data-testid="import-input"]', '{"mcpServers":{}}');
    await page.waitForSelector('[data-testid="import-mcp-handoff"]', { timeout: 4000 });
    await page.context().close();
  });

  await check("S0-4 / I-3 one icon goes pending → synced and nothing else changes", async () => {
    const page = await open("?view=library");
    await waitForJobsIdle(page);
    const before = await page.$$eval('[data-testid^="target-icon-"]', icons => Object.fromEntries(icons.map(icon => [icon.getAttribute("data-testid"), icon.getAttribute("data-status")])));
    const id = "target-icon-source-gstack-claude";
    expect(before[id] === "off", `start state ${before[id]}`);
    await page.click(`[data-testid="${id}"]`);
    await page.waitForFunction(selector => ["pending"].includes(document.querySelector(selector)?.getAttribute("data-status")), `[data-testid="${id}"]`, { timeout: 2000 });
    await page.waitForFunction(selector => document.querySelector(selector)?.getAttribute("data-status") === "synced", `[data-testid="${id}"]`, { timeout: 3000 });
    const after = await page.$$eval('[data-testid^="target-icon-"]', icons => Object.fromEntries(icons.map(icon => [icon.getAttribute("data-testid"), icon.getAttribute("data-status")])));
    const changed = Object.keys(after).filter(key => key !== id && after[key] !== before[key]);
    expect(changed.length === 0, `other icons changed: ${changed}`);
    await shot(page, "05-library");
    await page.context().close();
  });

  await check("S0-5 five child switches in 2 s make exactly one job and never lock navigation", async () => {
    const page = await open("?view=library");
    await waitForJobsIdle(page);
    await page.click('[data-testid="library-row-source-nature-paper-skills"] .lib-chevron');
    await page.click('[data-testid="library-row-source-writing-kit"] .lib-chevron');
    await page.waitForSelector('[data-testid="child-switch-tone-checker"]');
    await shot(page, "06-library-expanded");
    const jobsBefore = (await preview(page)).jobs.length;
    // Five different child switches inside 2 s, clicked from the page so a slow automation host
    // cannot space them out.
    await page.evaluate(async () => {
      const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
      for (const name of ["paper-workflow", "figure-planner", "nature-writing", "outline-builder", "tone-checker"]) {
        document.querySelector(`[data-testid="child-switch-${name}"]`)?.click();
        await wait(80);
      }
    });
    await page.waitForFunction(count => (window.__skillhubPreview?.jobs ?? []).length > count, jobsBefore, { timeout: 5000 });
    await page.click('[data-testid="nav-agents"]');
    await page.waitForSelector('[data-testid="agents-page"]', { timeout: 2000 });
    await page.click('[data-testid="agents-detect"]');
    await waitForJobsIdle(page);
    const jobsAfter = (await preview(page)).jobs.length;
    expect(jobsAfter - jobsBefore === 1, `jobs grew by ${jobsAfter - jobsBefore}`);
    await page.context().close();
  });

  await check("S0-3 / S0-10 cards first, linked Codex/扣子 switches, honest off confirmation", async () => {
    for (const width of [1440, 1280]) {
      const page = await open("?view=agents", { width, height: 900 });
      const top = await page.$eval('[data-testid^="agent-card-"]', card => card.getBoundingClientRect().top);
      expect(top < 200, `first card top ${top} at ${width}`);
      if (width === 1440) await shot(page, "07-agents");
      await page.context().close();
    }
    const page = await open("?view=agents");
    expect((await page.textContent('[data-testid="agent-card-codex"]')).includes("与 扣子 共用目录"), "codex shared-folder note");
    await page.click('[data-testid="agent-takeover-coze"]');
    await page.waitForSelector('[data-testid="takeover-off-dialog"]');
    await page.click('[data-testid="confirm-accept"]');
    await page.waitForFunction(() => document.querySelector('[data-testid="agent-takeover-codex"]')?.getAttribute("aria-checked") === "false"
      && document.querySelector('[data-testid="agent-takeover-coze"]')?.getAttribute("aria-checked") === "false", null, { timeout: 4000 });
    await page.click('[data-testid="agent-takeover-workbuddy"]');
    await page.waitForSelector('[data-testid="takeover-off-dialog"]');
    expect((await page.textContent('[data-testid="takeover-off-dialog"]')).includes("只会删除它自己建的入口"), "off dialog wording");
    await shot(page, "08-agents-takeover-off");
    await page.context().close();
  });

  await check("Pause blocks client writes and shows paused icons", async () => {
    const page = await open("?view=settings");
    await waitForJobsIdle(page);
    await page.click('[data-testid="pause-switch"]');
    await page.waitForSelector('[data-testid="sync-indicator"][data-tone="paused"]', { timeout: 4000 });
    await shot(page, "09-settings-paused");
    const writes = (await preview(page)).clientWrites.length;
    await openLibrary(page);
    await page.click('[data-testid="target-icon-source-gstack-claude"]');
    await page.waitForFunction(() => document.querySelector('[data-testid="target-icon-source-gstack-claude"]')?.getAttribute("data-status") === "paused", null, { timeout: 4000 });
    await page.waitForTimeout(2000);
    expect((await preview(page)).clientWrites.length === writes, "no client write while paused");
    await page.context().close();
  });

  await check("S1-8 onboarding writes nothing until 接管", async () => {
    const page = await open("?onboarding=1");
    await page.waitForSelector('[data-testid="onboarding-screen"]');
    await page.waitForTimeout(1500);
    expect((await preview(page)).clientWrites.length === 0, "no writes before consent");
    const checked = await page.$$eval('[data-testid^="onboarding-agent-"]', boxes => boxes.filter(box => box.checked).length);
    const label = (await page.textContent('[data-testid="onboarding-submit"]')).trim();
    expect(label === `接管 ${checked} 个工具`, `label "${label}" vs ${checked}`);
    await shot(page, "10-onboarding");
    await page.click('[data-testid="onboarding-submit"]');
    await page.waitForFunction(() => (window.__skillhubPreview?.clientWrites ?? []).length > 0, null, { timeout: 8000 });
    await page.context().close();
  });

  await check("S0-11 全部纳入管理 adopts 20 with one job", async () => {
    const page = await open("?view=agents&agent=claude");
    await waitForJobsIdle(page);
    await page.waitForSelector('[data-testid="adopt-all"]');
    expect((await page.textContent('[data-testid="adopt-all"]')).includes("(20)"), "button count 20");
    await shot(page, "11-agent-detail");
    const jobsBefore = (await preview(page)).jobs.length;
    await page.click('[data-testid="adopt-all"]');
    await page.waitForSelector('[data-testid="adopt-sheet"]');
    await page.click('[data-testid="adopt-confirm"]');
    await page.waitForSelector('[data-testid="adopt-report"]', { timeout: 8000 });
    expect(await page.getAttribute('[data-testid="adopt-report"]', "data-adopted") === "20", "20 adopted");
    await shot(page, "12-adopt-report");
    await waitForJobsIdle(page);
    expect((await preview(page)).jobs.length - jobsBefore === 1, "exactly one job");
    await page.context().close();
  });

  await check("S0-9 Ctrl+K everywhere, results above the scene, a result opens the drawer only", async () => {
    const page = await open();
    for (const nav of ["nav-dashboard", "nav-library", "nav-agents", "nav-settings", "nav-connections"]) {
      await page.click(`[data-testid="${nav}"]`);
      await page.waitForTimeout(250);
      await page.keyboard.press("Control+KeyK");
      expect(await page.evaluate(() => document.activeElement?.getAttribute("data-testid")) === "global-search-input", `Ctrl+K on ${nav}`);
      await page.keyboard.press("Escape");
    }
    await page.click('[data-testid="nav-dashboard"]');
    await page.keyboard.press("Control+KeyK");
    await page.keyboard.type("paper");
    await page.waitForSelector('[data-testid="search-result"]');
    const insidePanel = await page.$eval('[data-testid="search-result"]', element => {
      const box = element.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return Boolean(hit && hit.closest('[data-testid="global-search-results"]'));
    });
    expect(insidePanel, "first result is on top of the scene");
    await shot(page, "13-search-home");
    await openLibrary(page);
    await page.click('[data-testid="library-row-source-nature-paper-skills"] .lib-chevron');
    const expandedBefore = await page.$$eval(".lib-chevron[aria-expanded]", nodes => nodes.map(node => node.getAttribute("aria-expanded")).join(","));
    await page.keyboard.press("Control+KeyK");
    await page.keyboard.type("impeccable");
    await page.click('[data-testid="search-result"]');
    await page.waitForSelector('[data-testid="skill-drawer"]');
    const expandedAfter = await page.$$eval(".lib-chevron[aria-expanded]", nodes => nodes.map(node => node.getAttribute("aria-expanded")).join(","));
    expect(expandedBefore === expandedAfter, "tree expansion unchanged");
    await shot(page, "14-drawer");
    await page.keyboard.press("Escape");
    await page.waitForSelector('[data-testid="skill-drawer"]', { state: "detached" });
    await page.context().close();
  });

  await check("S0-7 one skill count on home, library header, 全部 chip and islands", async () => {
    const page = await open();
    const home = await page.getAttribute('[data-testid="home-metric-skills"]', "data-count");
    await openLibrary(page);
    const header = await page.getAttribute('[data-testid="library-count"]', "data-count");
    const chip = await page.getAttribute('[data-testid="folder-chip-all"]', "data-count");
    const tape = (await page.textContent('[data-testid="tape-skill-count"]')).replace(/\D/g, "");
    expect(home === header && header === chip && chip === tape, `counts home=${home} header=${header} chip=${chip} tape=${tape}`);
    await page.click('[data-testid="nav-dashboard"]');
    await page.waitForTimeout(800);
    const islands = await page.evaluate(() => {
      const text = document.querySelector(".sky-heading p, .sky-board, .skill-archipelago")?.textContent ?? "";
      const match = text.match(/([\d,]+)\s*(?:个)?\s*Skills/);
      return match ? match[1].replace(/,/g, "") : "";
    });
    if (islands) expect(islands === home, `island total ${islands} vs ${home}`);
    await page.context().close();
  });

  await check("S1-9 errors show one dismissible banner with an action", async () => {
    const page = await open("?view=library&previewError=TARGET_CONFLICT");
    await waitForJobsIdle(page);
    await page.click('[data-testid="target-icon-source-gstack-claude"]');
    await page.waitForSelector('[data-testid="error-banner"]', { timeout: 4000 });
    expect(await page.locator('[data-testid="error-banner-action"]').count() === 1, "banner action");
    await shot(page, "15-error-banner");
    await page.click('[data-testid="error-banner-dismiss"]');
    await page.waitForSelector('[data-testid="error-banner"]', { state: "detached" });
    await page.context().close();
  });

  await check("S1-10 no banned words on any page (developer mode off)", async () => {
    const page = await open();
    const offenders = [];
    for (const nav of ["nav-dashboard", "nav-library", "nav-agents", "nav-settings"]) {
      await page.click(`[data-testid="${nav}"]`);
      await page.waitForTimeout(700);
      const text = await page.evaluate(() => document.body.innerText);
      const match = text.match(BANNED);
      if (match) offenders.push(`${nav}: ${match[0]}`);
    }
    await page.goto(`${BASE}/?view=agents&agent=codex`, { waitUntil: "networkidle" });
    await page.waitForTimeout(800);
    for (const tab of ["agent-tab-skills", "agent-tab-diagnostics"]) {
      await page.click(`[data-testid="${tab}"]`);
      await page.waitForTimeout(500);
      const match = (await page.evaluate(() => document.body.innerText)).match(BANNED);
      if (match) offenders.push(`${tab}: ${match[0]}`);
    }
    expect(offenders.length === 0, offenders.join("; "));
    await page.context().close();
  });

  await check("S0-8 no consent pill, no Workspaces or 高级 nav; problems list has an action", async () => {
    const page = await open();
    expect(await page.locator(".status-pill").count() === 0, "no consent pill");
    expect(await page.locator('[data-testid="nav-workspaces"]').count() === 0, "no workspaces nav");
    const navText = await page.textContent(".side-rail");
    expect(!navText.includes("高级") && !navText.includes("工作区") && !navText.includes("连接中心"), `rail text ${navText}`);
    await page.click('[data-testid="sync-indicator"]');
    await page.waitForSelector('[data-testid="problems-popover"]');
    const popover = await page.textContent('[data-testid="problems-popover"]');
    expect(popover.includes("WorkBuddy"), "workbuddy problem listed");
    expect(await page.locator('[data-testid="problems-popover"] [data-testid="problem-action"]').count() > 0, "problem has an action");
    await shot(page, "16-problems");
    await page.context().close();
  });

  await check("Slim icon rail at every width, hover-only tooltips", async () => {
    // Users preferred the 3.2.x slim rail; details live on each page.
    const wide = await open("?view=library", { width: 1920, height: 1080 });
    const railWidth = await wide.locator(".side-rail").evaluate(element => element.getBoundingClientRect().width);
    expect(railWidth <= 90, `rail is ${railWidth}px wide at 1920`);
    await wide.hover('[data-testid="nav-agents"]');
    await wide.waitForTimeout(250);
    const hoverTips = await wide.$$eval(".rail-tip", tips => tips.filter(tip => getComputedStyle(tip).visibility === "visible").length);
    expect(hoverTips === 1, `${hoverTips} tooltip(s) on hover`);
    await shot(wide, "17-wide-1920");
    await wide.context().close();
    const narrow = await open("?view=library", { width: 1100, height: 800 });
    await narrow.focus('[data-testid="nav-agents"]');
    await narrow.keyboard.press("Tab");
    await narrow.waitForTimeout(250);
    const visibleTips = await narrow.$$eval(".rail-tip", tips => tips.filter(tip => getComputedStyle(tip).visibility === "visible" && Number(getComputedStyle(tip).opacity) > 0.1).length);
    expect(visibleTips === 0, `${visibleTips} tooltip(s) stuck after focus moved`);
    await shot(narrow, "18-narrow-1100");
    await narrow.context().close();
  });

  await check("en and ko render the shell without missing keys", async () => {
    for (const lang of ["en", "ko"]) {
      const page = await open("?view=library", { lang });
      const text = await page.evaluate(() => document.body.innerText);
      expect(!/\bv33\.[a-zA-Z]|\berr\.[A-Z_]+\b|\btarget\.[a-z]+\b/.test(text), `${lang}: raw key visible`);
      await shot(page, `19-library-${lang}`);
      await page.context().close();
    }
  });

  await browser.close();
  const failed = results.filter(result => !result.ok);
  console.log(JSON.stringify({ base: BASE, shots: SHOTS, passed: results.length - failed.length, failed: failed.length, results }, null, 2));
  process.exitCode = failed.length ? 1 : 0;
})().catch(async error => {
  console.error(error);
  if (browser) await browser.close();
  process.exitCode = 1;
});
