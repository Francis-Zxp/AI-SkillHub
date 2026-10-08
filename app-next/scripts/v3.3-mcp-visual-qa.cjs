// v3.3 MCP page browser QA (docs/v3.3/mcp-contract.md §7.3), run against the stateful preview mock.
// Usage: start Vite (node node_modules/vite/bin/vite.js --host 127.0.0.1 --port 1434 --strictPort),
// then `node scripts/v3.3-mcp-visual-qa.cjs`. Env: MCP_QA_URL (default http://127.0.0.1:1434/),
// MCP_QA_SHOTS (screenshot folder). Nothing here touches a real AI tool config: the browser
// preview has no desktop runtime, and every write is simulated by src/mcpPreview.ts.
const { chromium } = require("playwright");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const BASE = process.env.MCP_QA_URL || "http://127.0.0.1:1434/";
const SHOTS = process.env.MCP_QA_SHOTS || path.resolve(__dirname, "../../reports/v3.3-work/mcp-ui-shots");
fs.mkdirSync(SHOTS, { recursive: true });

const results = [];
let currentPage = null;
async function check(name, run) {
  try {
    await run();
    results.push({ name, passed: true });
    console.log("PASS", name);
  } catch (error) {
    results.push({ name, passed: false, error: String(error && error.stack || error) });
    if (currentPage) await currentPage.screenshot({ path: path.join(SHOTS, `fail-${name.split(" ")[0]}.png`) }).catch(() => undefined);
    console.log("FAIL", name, "\n   ", String(error && error.message || error).split("\n")[0]);
  }
}

const BANNED = ["宿主", "能力未探测", "mcp-snap", "逻辑服务器", "绑定", "静态验证", "binding", "upsert", "redacted"];

async function open(page, query, { lang = "zh", hidePreviewPanel = true } = {}) {
  await page.addInitScript(value => {
    try { window.localStorage.setItem("ai-skillhub-lang", value); } catch { /* ignore */ }
  }, lang);
  await page.goto(BASE + query);
  await page.waitForSelector(".mcp-page");
  await page.waitForSelector(".mcp-matrix, .mcp-cards, .mcp-empty, .mcp-discover", { timeout: 15000 });
  if (hidePreviewPanel) {
    // The "browser preview" banner is shell chrome that the desktop app does not have.
    await page.addStyleTag({ content: ".preview-panel{display:none!important}" });
  }
  await page.waitForTimeout(300);
}

function cell(page, server, client) {
  return page.locator(`table.mcp-matrix button.mcp-cell[aria-label^="${server} · ${client}："]`);
}

async function waitIdle(page) {
  await page.waitForFunction(() => document.querySelectorAll(".mcp-cell.is-pending").length === 0, null, { timeout: 8000 });
  await page.waitForTimeout(250);
}

async function shot(page, name) {
  await page.waitForTimeout(260); // let the 200 ms slide-in finish
  await page.screenshot({ path: path.join(SHOTS, `${name}.png`) });
}

(async () => {
  const browser = await chromium.launch({ channel: "chrome", args: ["--use-angle=d3d11", "--ignore-gpu-blocklist"] });
  const pageErrors = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    page.on("pageerror", error => pageErrors.push(error.message));
    currentPage = page;

    // 0. First run: the library is empty → one automatic import, reported as a non-blocking toast.
    await open(page, "?view=connections");
    await check("0 first-run import is reported without blocking the page", async () => {
      const toast = page.locator(".mcp-toast", { hasText: "已从 AI 工具导入" });
      await toast.waitFor({ timeout: 6000 });
      assert.match(await toast.innerText(), /没有改动任何工具配置/);
      await toast.getByRole("button", { name: "查看" }).click();
      const dialog = page.getByRole("dialog", { name: "从 AI 工具导入" });
      await dialog.waitFor();
      assert.match(await dialog.innerText(), /新增 1 个 MCP：sqlite/);
      assert.match(await dialog.innerText(), /读取了哪些文件/);
      await shot(page, "00-import-report");
      await dialog.getByRole("button", { name: "好的" }).click();
    });

    await check("1 matrix header top < 180 px at 1440×900 and no internal words", async () => {
      const top = await page.evaluate(() => document.querySelector(".mcp-matrix thead").getBoundingClientRect().top);
      assert.ok(top < 180, `thead top ${top}`);
      const text = await page.locator(".mcp-page").innerText();
      for (const word of BANNED) assert.ok(!text.includes(word), `found ${word}`);
      await shot(page, "01-matrix-sky");
    });

    await check("2 add sheet opens in view with the paste box focused", async () => {
      await page.locator(".mcp-head").getByRole("button", { name: "添加 MCP", exact: true }).click();
      const sheet = page.locator(".mcp-sheet");
      await sheet.waitFor();
      const box = await sheet.boundingBox();
      assert.ok(box && box.y >= 0 && box.y + box.height <= 900 + 1, JSON.stringify(box));
      assert.equal(await page.evaluate(() => document.activeElement && document.activeElement.id), "mcp-paste-box");
      await shot(page, "02-add-sheet");
    });

    await check("3 a pasted 2-server sample lists new and same-name rows with skip/replace", async () => {
      const sample = JSON.stringify({
        mcpServers: {
          "brave-search": { command: "npx", args: ["-y", "@modelcontextprotocol/server-brave-search"], env: { BRAVE_API_KEY: "YOUR_BRAVE_KEY" } },
          memory: { command: "npx", args: ["-y", "@modelcontextprotocol/server-memory@latest"] }
        }
      }, null, 2);
      await page.fill("#mcp-paste-box", sample);
      await page.locator(".mcp-candidate").nth(1).waitFor({ timeout: 5000 });
      const rows = page.locator(".mcp-candidate");
      assert.equal(await rows.count(), 2);
      const text = await page.locator(".mcp-candidates").innerText();
      assert.match(text, /新的/);
      assert.match(text, /已存在同名/);
      assert.ok(await page.getByRole("radio", { name: "跳过" }).isVisible());
      assert.ok(await page.getByRole("radio", { name: "覆盖" }).isVisible());
      assert.match(await page.locator(".mcp-paste-result").innerText(), /识别为 mcpServers：2 个/);
      await shot(page, "03-paste-two");
    });

    await check("4 template chip → add is two clicks to a toast with Undo in view", async () => {
      await page.locator(".mcp-sheet").getByRole("button", { name: "关闭" }).first().click();
      await page.getByRole("button", { name: "放弃", exact: true }).click();
      await page.locator(".mcp-sheet").waitFor({ state: "detached" });
      await page.locator(".mcp-head").getByRole("button", { name: "添加 MCP", exact: true }).click();
      await page.locator(".mcp-template-chip", { hasText: "playwright" }).waitFor();
      await page.locator(".mcp-template-chip", { hasText: "playwright" }).click(); // click 1
      const submit = page.locator(".mcp-sheet-foot").getByRole("button", { name: "添加到 4 个 AI 工具" });
      await submit.waitFor();
      await shot(page, "04-template-ready");
      await submit.click(); // click 2
      const toast = page.locator(".mcp-toast", { hasText: "已添加 playwright" });
      await toast.waitFor({ timeout: 6000 });
      const box = await toast.boundingBox();
      assert.ok(box && box.y + box.height <= 900 && box.x + box.width <= 1440, JSON.stringify(box));
      assert.ok(await toast.getByRole("button", { name: "撤销" }).isVisible());
      assert.match(await toast.innerText(), /预览：没有写入任何文件/);
      assert.equal(await page.locator(".mcp-sheet").count(), 0);
      await shot(page, "04-added-toast");
    });

    await check("5 Undo removes the row and says 已撤销", async () => {
      await page.locator(".mcp-toast", { hasText: "已添加 playwright" }).getByRole("button", { name: "撤销" }).click();
      await page.locator(".mcp-toast", { hasText: "已撤销" }).waitFor({ timeout: 6000 });
      await page.waitForFunction(() => ![...document.querySelectorAll(".mcp-name")].some(node => node.textContent === "playwright"));
    });

    await check("6 Cursor column menu enables the rest", async () => {
      await page.getByRole("button", { name: "Cursor 的批量操作" }).click();
      const menu = page.getByRole("menu", { name: "Cursor 的批量操作" });
      await menu.waitFor();
      const menuText = await menu.innerText();
      assert.match(menuText, /已在 \d+\/\d+ 个 MCP 上启用/);
      const rest = Number((menuText.match(/启用其余 (\d+) 个/) || [])[1]);
      assert.ok(rest > 0, menuText);
      await shot(page, "06-column-menu");
      const before = await page.locator('table.mcp-matrix button.mcp-cell[aria-label*=" · Cursor："][aria-pressed="true"]').count();
      await menu.getByRole("menuitem", { name: `启用其余 ${rest} 个` }).click();
      await waitIdle(page);
      await page.waitForFunction(
        ([expected]) => document.querySelectorAll('table.mcp-matrix button.mcp-cell[aria-label*=" · Cursor："][aria-pressed="true"]').length === expected,
        [before + rest],
        { timeout: 6000 }
      );
    });

    await check("7 failed cell says 写入失败，点按重试 and the second click turns it on", async () => {
      const target = cell(page, "filesystem", "Codex");
      assert.match(await target.getAttribute("aria-label"), /写入失败，点按重试/);
      await target.click();
      await waitIdle(page);
      assert.match(await cell(page, "filesystem", "Codex").getAttribute("aria-label"), /写入失败，点按重试/);
      await cell(page, "filesystem", "Codex").click();
      await waitIdle(page);
      await page.waitForFunction(() => {
        const node = document.querySelector('table.mcp-matrix button.mcp-cell[aria-label^="filesystem · Codex："]');
        return node && node.getAttribute("aria-pressed") === "true";
      }, null, { timeout: 6000 });
    });

    await check("8 history shows human labels and asks before undoing", async () => {
      await page.locator(".mcp-head").getByRole("button", { name: "更多操作" }).click();
      await page.getByRole("menuitem", { name: "历史版本" }).click();
      const drawer = page.locator(".mcp-drawer");
      await drawer.waitFor();
      const item = drawer.locator(".mcp-history-item", { hasText: "给 Codex、Claude Code 添加 context7" });
      await item.waitFor();
      const text = await drawer.innerText();
      assert.ok(!/mcp-op-|mcp-snap|DPAPI|MiB/.test(text), text);
      assert.match(text, /3\.2 版本的更改 · 2 个配置文件/);
      assert.match(text, /（Codex 未成功）/);
      await shot(page, "08-history");
      await item.getByRole("button", { name: "撤销此次更改" }).click();
      const dialog = page.getByRole("dialog", { name: "撤销这次更改？" });
      await dialog.waitFor();
      const body = await dialog.innerText();
      assert.match(body, /Codex/);
      assert.match(body, /Claude Code/);
      await shot(page, "08-rollback-confirm");
      await dialog.getByRole("button", { name: "取消" }).click();
      await page.keyboard.press("Escape");
      await drawer.waitFor({ state: "detached" });
    });

    await check("9 test shows the command first; a missing runner shows the install guide", async () => {
      await page.locator("tr", { has: page.locator(".mcp-name", { hasText: /^github$/ }) }).locator(".mcp-test-link").click();
      let dialog = page.getByRole("dialog", { name: "测试 github" });
      await dialog.waitFor();
      let text = await dialog.innerText();
      assert.match(text, /将连接/);
      assert.match(text, /api\.githubcopilot\.com/);
      assert.match(text, /需要先填写 API Key/);
      assert.ok(await dialog.getByRole("button", { name: "运行测试" }).isDisabled());
      await dialog.getByRole("button", { name: "取消" }).click();
      await page.locator("tr", { has: page.locator(".mcp-name", { hasText: /^fetch$/ }) }).locator(".mcp-test-link").click();
      dialog = page.getByRole("dialog", { name: "测试 fetch" });
      await dialog.waitFor();
      text = await dialog.innerText();
      assert.match(text, /将运行/);
      assert.match(text, /uvx mcp-server-fetch/);
      assert.match(text, /没有找到 uvx/);
      assert.ok(await dialog.getByRole("button", { name: /安装指引/ }).isVisible());
      await shot(page, "09-test-runner-missing");
      await dialog.getByRole("button", { name: "取消" }).click();
      // A runnable server: confirm once, then the row shows the result.
      await page.locator("tr", { has: page.locator(".mcp-name", { hasText: /^memory$/ }) }).locator(".mcp-test-link").click();
      dialog = page.getByRole("dialog", { name: "测试 memory" });
      await dialog.waitFor();
      assert.match(await dialog.innerText(), /npx -y @modelcontextprotocol\/server-memory/);
      await dialog.getByRole("button", { name: "运行测试" }).click();
      await page.locator(".mcp-toast", { hasText: /memory：可用 · \d+ 个工具/ }).waitFor({ timeout: 8000 });
    });

    await check("10 editing github keeps 远程地址 after saving", async () => {
      await page.locator(".mcp-name", { hasText: /^github$/ }).click();
      let drawer = page.locator(".mcp-drawer");
      await drawer.waitFor();
      const select = drawer.locator("select").first();
      await page.waitForFunction(() => document.querySelector(".mcp-drawer select")?.value === "http");
      assert.equal(await select.evaluate(node => node.options[node.selectedIndex].text), "远程地址");
      await drawer.locator('input[placeholder="https://"]').fill("https://api.githubcopilot.com/mcp");
      await shot(page, "10-edit-github");
      await drawer.getByRole("button", { name: /保存并同步到/ }).click();
      await page.locator(".mcp-toast", { hasText: "已保存 github" }).waitFor({ timeout: 6000 });
      await drawer.waitFor({ state: "detached" });
      await page.locator(".mcp-name", { hasText: /^github$/ }).click();
      drawer = page.locator(".mcp-drawer");
      await drawer.waitFor();
      await page.waitForFunction(() => document.querySelector(".mcp-drawer select")?.value === "http");
      await page.keyboard.press("Escape");
    });

    await check("11a light and dark themes render the matrix", async () => {
      for (const theme of ["light", "dark"]) {
        const themed = await context.newPage();
        themed.on("pageerror", error => pageErrors.push(error.message));
        await open(themed, `?view=connections&theme=${theme}&mcpInitialized=1`);
        const colors = await themed.evaluate(() => {
          const on = document.querySelector(".mcp-dot.on");
          const name = document.querySelector(".mcp-name");
          return { on: on && getComputedStyle(on).backgroundColor, name: name && getComputedStyle(name).color };
        });
        assert.ok(colors.on && colors.on !== "rgba(0, 0, 0, 0)", JSON.stringify(colors));
        await shot(themed, `11-matrix-${theme}`);
        await themed.close();
      }
    });

    await check("11b no horizontal page scroll at 1024 and 390 px", async () => {
      for (const [width, height] of [[1024, 768], [390, 844]]) {
        const narrow = await context.newPage();
        narrow.on("pageerror", error => pageErrors.push(error.message));
        await narrow.setViewportSize({ width, height });
        await open(narrow, "?view=connections&mcpInitialized=1");
        const overflow = await narrow.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        assert.ok(overflow <= 0, `overflow ${overflow} at ${width}`);
        await shot(narrow, `11-width-${width}`);
        if (width === 390) {
          assert.ok(await narrow.locator(".mcp-cards").isVisible());
          await narrow.locator(".mcp-head").getByRole("button", { name: "添加 MCP", exact: true }).click();
          await narrow.locator(".mcp-sheet").waitFor();
          const sheetOverflow = await narrow.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
          assert.ok(sheetOverflow <= 0, `sheet overflow ${sheetOverflow}`);
          await shot(narrow, "11-width-390-add");
        }
        await narrow.close();
      }
    });

    await check("12 discover keeps the recipe collapsed and only checks on click", async () => {
      const discover = await context.newPage();
      discover.on("pageerror", error => pageErrors.push(error.message));
      await open(discover, "?view=connections&mcpTab=discover&mcpInitialized=1");
      await discover.locator(".recipe-card.collapsed").waitFor();
      assert.ok(await discover.getByRole("button", { name: "检查这台电脑" }).isVisible());
      await discover.locator(".mcp-template-card").first().waitFor();
      assert.equal(await discover.locator(".mcp-template-card").count(), 7);
      await shot(discover, "12-discover");
      await discover.getByRole("button", { name: "检查这台电脑" }).click();
      await discover.locator(".recipe-hosts").waitFor({ timeout: 6000 });
      assert.match(await discover.locator(".recipe-card").innerText(), /接入到/);
      await shot(discover, "12-discover-recipe");
      await discover.close();
    });

    await check("13 en and ko render without raw keys", async () => {
      for (const lang of ["en", "ko"]) {
        const localized = await context.newPage();
        localized.on("pageerror", error => pageErrors.push(error.message));
        await open(localized, "?view=connections&mcpInitialized=1", { lang });
        const text = await localized.locator(".mcp-page").innerText();
        assert.ok(!/\bmcp\.[a-z]/.test(text), text.slice(0, 400));
        await shot(localized, `13-matrix-${lang}`);
        await localized.locator(".mcp-head").getByRole("button", { name: lang === "en" ? "Add MCP" : "MCP 추가", exact: true }).click();
        await localized.locator(".mcp-sheet").waitFor();
        await localized.locator(".mcp-template-chip", { hasText: "github" }).click();
        await localized.waitForTimeout(300);
        const sheetText = await localized.locator(".mcp-sheet").innerText();
        assert.ok(!/\bmcp\.[a-z]/.test(sheetText), sheetText.slice(0, 400));
        await shot(localized, `13-add-${lang}`);
        await localized.close();
      }
    });

    await check("14 more than 200 rows are windowed", async () => {
      const large = await context.newPage();
      large.on("pageerror", error => pageErrors.push(error.message));
      await open(large, "?view=connections&mcpInitialized=1&mcpLarge=400");
      const rendered = await large.locator("table.mcp-matrix tbody tr:not(.mcp-spacer)").count();
      assert.ok(rendered < 120, `rendered ${rendered} rows`);
      await large.mouse.wheel(0, 9000);
      await large.waitForTimeout(400);
      assert.ok(await large.locator("table.mcp-matrix thead").isVisible());
      await shot(large, "14-large-scrolled");
      await large.close();
    });

    await check("15 the shell's paste hand-off opens the add sheet with that text", async () => {
      const handoff = await context.newPage();
      handoff.on("pageerror", error => pageErrors.push(error.message));
      await open(handoff, "?view=connections&mcpInitialized=1");
      const sample = JSON.stringify({ mcpServers: { "brave-search": { command: "npx", args: ["-y", "@modelcontextprotocol/server-brave-search"] } } });
      // Same event the Skills shell dispatches from "+ 添加" / Ctrl+V (mcpBridge.requestOpenMcpAdd).
      await handoff.evaluate(text => window.dispatchEvent(new CustomEvent("ai-skillhub-open-mcp-add", { detail: { text } })), sample);
      await handoff.locator(".mcp-sheet .mcp-candidate").first().waitFor({ timeout: 6000 });
      assert.match(await handoff.locator(".mcp-candidates").innerText(), /brave-search[\s\S]*新的/);
      // Nothing of the pasted text reaches browser storage.
      const stored = await handoff.evaluate(() => JSON.stringify({ ...window.localStorage }) + JSON.stringify({ ...window.sessionStorage }));
      assert.ok(!stored.includes("server-brave-search"), "pasted text persisted");
      await shot(handoff, "15-handoff");
      await handoff.close();
    });

    // ---------- review regressions (v33/mcp-frontend-reviewed) ----------

    await check("17 editing an imported server keeps its key reference (NAME → ${OTHER})", async () => {
      await page.locator(".mcp-name", { hasText: /^notion$/ }).click();
      let drawer = page.locator(".mcp-drawer");
      await drawer.waitFor();
      await drawer.getByText("NOTION_API_KEY", { exact: false }).first().waitFor();
      await drawer.getByRole("button", { name: "添加参数" }).click();
      await drawer.getByRole("textbox", { name: "参数 3" }).fill("--verbose");
      await drawer.getByRole("button", { name: /保存并同步到/ }).click();
      await page.locator(".mcp-toast", { hasText: "已保存 notion" }).waitFor({ timeout: 6000 });
      await drawer.waitFor({ state: "detached" });
      await page.locator(".mcp-name", { hasText: /^notion$/ }).click();
      drawer = page.locator(".mcp-drawer");
      await drawer.waitFor();
      await drawer.locator(".mcp-secret-status").first().waitFor();
      const text = await drawer.locator(".mcp-secret-status").first().innerText();
      assert.match(text, /NOTION_API_KEY/, text);
      await shot(page, "17-edit-keeps-reference");
      await page.keyboard.press("Escape");
      await drawer.waitFor({ state: "detached" });
    });

    await check("18 deleting with its env var ticked finishes after one confirmation", async () => {
      await page.getByRole("button", { name: "context7 的更多操作" }).click();
      await page.getByRole("menuitem", { name: "删除" }).click();
      const dialog = page.getByRole("dialog", { name: "删除 context7？" });
      await dialog.waitFor();
      await dialog.getByRole("checkbox", { name: /同时删除不再使用的环境变量 CONTEXT7_API_KEY/ }).check();
      await shot(page, "18-delete-env");
      await dialog.getByRole("button", { name: "删除", exact: true }).click();
      await page.locator(".mcp-toast", { hasText: "已删除 context7" }).waitFor({ timeout: 6000 });
      assert.equal(await page.getByRole("dialog", { name: "删除 context7？" }).count(), 0, "asked twice");
      await page.waitForFunction(() => ![...document.querySelectorAll(".mcp-name")].some(node => node.textContent === "context7"));
    });

    await check("19 a template's optional key left empty is not added as a missing key", async () => {
      await page.locator(".mcp-head").getByRole("button", { name: "添加 MCP", exact: true }).click();
      await page.locator(".mcp-template-chip", { hasText: "context7" }).click();
      const submit = page.locator(".mcp-sheet-foot").getByRole("button", { name: /添加到 \d 个 AI 工具/ });
      await submit.waitFor();
      await submit.click();
      await page.locator(".mcp-toast", { hasText: "已添加 context7" }).waitFor({ timeout: 6000 });
      const row = page.locator("tr", { has: page.locator(".mcp-name", { hasText: /^context7$/ }) });
      await row.waitFor();
      assert.equal(await row.locator(".mcp-key-chip").count(), 0, "optional key shown as missing");
    });

    await check("20 Origin card switches the listed origin on in more tools (bug #24)", async () => {
      const discover = await context.newPage();
      discover.on("pageerror", error => pageErrors.push(error.message));
      await open(discover, "?view=connections&mcpTab=discover&mcpInitialized=1");
      await discover.getByRole("button", { name: "检查这台电脑" }).click();
      await discover.locator(".recipe-hosts").waitFor({ timeout: 6000 });
      await discover.locator(".recipe-actions .primary-action", { hasText: /接入 \d 个 AI 工具/ }).click();
      // The listed origin was edited by hand in Codex: overwriting it is a plain-language question.
      const dialog = discover.getByRole("dialog", { name: "origin 在 Codex 里被手动改过" });
      await dialog.waitFor({ timeout: 6000 });
      await dialog.getByRole("button", { name: "覆盖" }).click();
      await discover.locator(".mcp-toast", { hasText: /启用 origin/ }).waitFor({ timeout: 6000 });
      await discover.waitForFunction(() => document.querySelectorAll(".recipe-hosts label.connected").length >= 2, null, { timeout: 6000 });
      await shot(discover, "20-origin-second-tool");
      await discover.close();
    });

    await check("21 a manual add asks before replacing a same-name entry found in a tool's file", async () => {
      const manual = await context.newPage();
      manual.on("pageerror", error => pageErrors.push(error.message));
      await open(manual, "?view=connections&mcpInitialized=1");
      await manual.locator(".mcp-head").getByRole("button", { name: "添加 MCP", exact: true }).click();
      const sheet = manual.locator(".mcp-sheet");
      await sheet.waitFor();
      await sheet.getByRole("textbox", { name: "名称" }).fill("sqlite");
      await sheet.getByRole("textbox", { name: "命令或地址" }).fill("uvx mcp-server-sqlite");
      await sheet.locator(".mcp-sheet-foot").getByRole("button", { name: /添加到 \d 个 AI 工具/ }).click();
      const dialog = manual.getByRole("dialog", { name: "覆盖 Cursor 里同名的 sqlite？" });
      await dialog.waitFor({ timeout: 6000 });
      await shot(manual, "21-manual-overwrite-ask");
      await dialog.getByRole("button", { name: "覆盖" }).click();
      await manual.locator(".mcp-toast", { hasText: "已添加 sqlite" }).waitFor({ timeout: 6000 });
      await manual.close();
    });

    await check("16 no page errors", async () => {
      assert.deepEqual(pageErrors, []);
    });
  } finally {
    await browser.close();
  }
  const failed = results.filter(item => !item.passed);
  fs.writeFileSync(path.join(SHOTS, "results.json"), JSON.stringify(results, null, 2));
  console.log(`\n${results.length - failed.length}/${results.length} passed · screenshots in ${SHOTS}`);
  if (failed.length > 0) process.exitCode = 1;
})().catch(error => {
  console.error(error);
  process.exit(1);
});
