// Full application layout and workflow QA. Only the desktop-only read/create
// boundaries are replaced with synthetic IPC; no user files or host are used.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const baseUrl = process.env.AI_SKILLHUB_PREVIEW_URL || "http://127.0.0.1:4173";
const reportDir = path.resolve(__dirname, "../reports/visual/v3.2.6-integration");
fs.mkdirSync(reportDir, { recursive: true });

async function layout(page, name) {
  const metrics = await page.evaluate(() => {
    const doc = document.documentElement;
    return { width: doc.clientWidth, scroll: doc.scrollWidth,
      panels: [...document.querySelectorAll(".external-skills-list,.drawer,.source-group")].map(el => ({ selector: el.className, width: el.clientWidth, scroll: el.scrollWidth })).filter(item => item.width > 0) };
  });
  assert.ok(metrics.scroll <= metrics.width + 1, `${name}: document overflow ${JSON.stringify(metrics)}`);
  for (const panel of metrics.panels) assert.ok(panel.scroll <= panel.width + 2, `${name}: panel overflow ${JSON.stringify(panel)}`);
  return metrics;
}

async function receivesPointer(locator) {
  await locator.scrollIntoViewIfNeeded();
  return locator.evaluate(el => {
    const box = el.getBoundingClientRect();
    const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return el === hit || el.contains(hit);
  });
}

(async () => {
  const browser = await chromium.launch({ headless: true, channel: "msedge" });
  const results = [];
  try {
    for (const viewport of [{ width: 1260, height: 840, dpr: 1 }, { width: 1920, height: 1080, dpr: 2 }]) {
      for (const theme of ["atlas-light", "atlas-dark"]) {
        const page = await browser.newPage({ viewport, deviceScaleFactor: viewport.dpr, reducedMotion: "reduce", permissions: ["clipboard-read", "clipboard-write"] });
        page.setDefaultTimeout(12_000);
        const errors = [];
        page.on("pageerror", error => errors.push(error.message));
        const id = `${theme}-${viewport.width}-${viewport.dpr}`;
        const stages = {};
        try {
          await page.addInitScript(() => {
            localStorage.setItem("ai-skillhub-lang", "zh");
            window.__integrationCalls = [];
            const entries = Array.from({ length: 45 }, (_, index) => ({ id: `qa-${index}`, name: `skill-${String(index).padStart(2, "0")}-科研与开发`, description: "用于检查名称、作者、数量和按钮的换行与对齐。", path: `C:\\Fixture\\.agents\\skills\\qa-${index}`, canonicalPath: `C:\\Fixture Library\\sources\\qa-${index}`, agentId: "codex", agentName: "Codex", scope: "global", storageKind: "link", managed: index === 0, canImport: index !== 0 }));
            window.__integrationInvoke = async (command, args) => {
              window.__integrationCalls.push({ command, args });
              if (command === "scan_external_agent_skills") return { generatedAt: "2026-09-24T00:00:00Z", skills: entries, roots: [], warnings: [], truncated: false };
              if (command === "read_external_agent_skill") return { path: args.path, content: "# Fixture Skill\n\nOriginal skill content." };
              if (command === "load_prompt_invocation") return { sourceId: args.sourceId, sourceName: "awesome-ai-research-writing", sourceType: "prompt", sourceUrl: "https://github.com/Leey21/awesome-ai-research-writing", invocationKind: "copy-paste", invocationName: "", copyReady: true, autoDelivered: false, workspaceComplete: true, copyText: "Read the original Prompt at C:\\Fixture Library\\sources\\research-writing.\nDo not execute scripts automatically.", assets: [{ name: "README.md", relativePath: "README.md", role: "instructions", bytes: 2000, included: true }], hosts: [], warnings: [] };
              if (command === "create_prompt_launcher") return { name: "prompt-qa-fixture", path: "C:\\Fixture Library\\sources\\prompt-qa-fixture", warning: null };
              throw new Error(`Unexpected synthetic command: ${command}`);
            };
          });
          await page.route("**/src/ExternalSkillsPanel.tsx*", async route => {
            const response = await route.fetch();
            const body = (await response.text()).replace(/(export function ExternalSkillsPanel\([^)]*\)\s*\{)/, "$1\n runtimeAvailable = true;").replaceAll("await invoke(", "await window.__integrationInvoke(");
            await route.fulfill({ response, body, contentType: "application/javascript" });
          });
          await page.route("**/src/PromptLauncherAction.tsx*", async route => {
            const response = await route.fetch();
            await route.fulfill({ response, body: (await response.text()).replaceAll("await invoke(", "await window.__integrationInvoke("), contentType: "application/javascript" });
          });
          await page.route("**/src/App.tsx*", async route => {
            const response = await route.fetch();
            let body = await response.text();
            const start = body.indexOf("async function preparePromptInvocation(");
            const end = body.indexOf("const githubSources", start);
            assert.ok(start >= 0 && end > start);
            const handler = body.slice(start, end).replace("if (!hasTauriRuntime())", "if (false)").replaceAll("await invoke(", "await window.__integrationInvoke(");
            body = body.slice(0, start) + handler + body.slice(end);
            await route.fulfill({ response, body, contentType: "application/javascript" });
          });
          await page.goto(`${baseUrl}/?theme=${theme}&view=dashboard`, { waitUntil: "networkidle" });
          await page.locator(".archipelago-island").first().waitFor();
          for (const button of await page.locator(".home-visual-switch button,.atlas-immersive-toggle,.archipelago-switch button").all()) assert.ok(await receivesPointer(button), `${id}: home button blocked: ${await button.innerText()}`);
          stages.home = await layout(page, id);
          await page.screenshot({ path: path.join(reportDir, `${id}-home.png`) });
          await page.locator(".home-visual-switch button").nth(1).click();
          await page.locator(".skill-universe-canvas").waitFor();
          stages.stars = await layout(page, id);
          await page.screenshot({ path: path.join(reportDir, `${id}-stars.png`) });
          await page.locator(".nav-item").filter({ hasText: "技能库" }).click();
          await page.locator(".source-group").first().waitFor();
          assert.equal(await page.locator(".atlas-library-inspector").count(), 0, "inspector must be removed");
          const alignment = await page.locator(".atlas-library-filter-deck dl dd").evaluateAll(els => els.map(el => el.getBoundingClientRect().right));
          if (alignment.length) assert.ok(Math.max(...alignment) - Math.min(...alignment) <= 2, "library values do not share a right edge");
          stages.library = await layout(page, id);
          await page.screenshot({ path: path.join(reportDir, `${id}-library.png`) });
          const prompt = page.locator(".source-group").filter({ hasText: "awesome-ai-research-writing" });
          const toggle = prompt.locator(".source-group-toggle");
          if (await toggle.getAttribute("aria-expanded") !== "true") await toggle.click();
          await prompt.locator(".prompt-source-callout button").click();
          await page.locator("#prompt-task").fill("请检查方法与讨论，并保留统计结果。QA-task-20260924");
          await page.locator(".prompt-compose summary").click();
          const composed = await page.locator(".prompt-compose pre").innerText();
          assert.match(composed, /QA-task-20260924/); assert.match(composed, /original Prompt/);
          const create = page.getByRole("button", { name: "创建 Skill 调用入口", exact: true });
          assert.ok(await receivesPointer(create), "launcher button blocked");
          await create.click();
          await page.locator(".prompt-launcher-result").waitFor();
          assert.equal(await page.evaluate(() => window.__integrationCalls.filter(call => call.command === "create_prompt_launcher").length), 1);
          await page.locator(".drawer footer .primary-action").click();
          assert.match(await page.evaluate(() => navigator.clipboard.readText()), /QA-task-20260924/);
          stages.prompt = await layout(page, id);
          await page.screenshot({ path: path.join(reportDir, `${id}-prompt.png`) });
          await page.keyboard.press("Escape");
          if (await page.locator(".drawer").count()) await page.locator(".drawer-backdrop").click({ position: { x: 10, y: 10 } });
          await page.locator(".nav-item").filter({ hasText: "AI 工具" }).click();
          await page.locator(".external-skills-list > li").first().waitFor();
          assert.equal(await page.locator(".external-skills-list > li").count(), 20);
          await page.locator(".external-skills-pagination").getByRole("button", { name: "下一页" }).click();
          await page.waitForFunction(() => document.querySelector(".external-skills-list")?.textContent.includes("skill-20-"));
          assert.equal(await page.locator(".external-skills-list > li").count(), 20);
          await page.locator(".external-skills-pagination").getByRole("button", { name: "下一页" }).click();
          await page.waitForFunction(() => document.querySelectorAll(".external-skills-list > li").length === 5);
          const list = page.locator(".external-skills-list");
          await list.scrollIntoViewIfNeeded();
          stages.agents = await layout(page, id);
          await page.screenshot({ path: path.join(reportDir, `${id}-agents-page3.png`) });
          await page.locator(".theme-trigger").click();
          await page.locator(".theme-menu [role=option]").nth(theme === "atlas-light" ? 2 : 3).click();
          assert.equal(await page.locator(".theme-menu").count(), 0);
          assert.equal(await page.evaluate(() => "__TAURI_INTERNALS__" in window), false);
          assert.deepEqual(errors, []);
          results.push({ id, viewport, theme, syntheticDesktopBoundaries: true, stages, errors });
          console.log(`${id}: all integration checks passed`);
        } finally { await page.close(); }
      }
    }
  } finally { await browser.close(); }
  fs.writeFileSync(path.join(reportDir, "report.json"), JSON.stringify(results, null, 2));
})().catch(error => { console.error(error); process.exitCode = 1; });
