// Exercise the real component with synthetic IPC and an isolated React mount.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const baseUrl = process.env.AI_SKILLHUB_PREVIEW_URL || "http://127.0.0.1:4173";
const reportDir = path.resolve(__dirname, "../reports/visual/v3.2.6-prompt-launcher");
const result = { name: "prompt-0123456789abcdef", path: "C:\\Fixture Library\\sources\\prompt-0123456789abcdef", warning: null };

async function main() {
  fs.mkdirSync(reportDir, { recursive: true });
  const source = await (await fetch(`${baseUrl}/src/PromptLauncherAction.tsx`)).text();
  const mainSource = await (await fetch(`${baseUrl}/src/main.tsx`)).text();
  const reactUrl = source.match(/from "([^"]*\/react\.js[^\"]*)"/)[1];
  const domUrl = mainSource.match(/from "([^"]*react-dom_client\.js[^\"]*)"/)[1];
  const browser = await chromium.launch({ headless: true, ...(process.platform === "win32" ? { channel: "chrome" } : {}) });
  const reports = [];
  try {
    for (const [language, action, copyName] of [["zh", "创建 Skill 调用入口", "复制名称"], ["en", "Create Skill launcher", "Copy name"], ["ko", "Skill 호출 항목 만들기", "이름 복사"]]) {
      const page = await browser.newPage({ viewport: { width: 760, height: 860 }, permissions: ["clipboard-read", "clipboard-write"] });
      const errors = [];
      page.on("pageerror", error => errors.push(error.message));
      await page.addInitScript(({ language, result }) => {
        localStorage.setItem("ai-skillhub-lang", language);
        window.__launcherCalls = [];
        window.__refreshFails = false;
        window.__createFails = false;
        window.__delayCreate = false;
        window.__launcherInvoke = async (command, args) => {
          window.__launcherCalls.push({ command, args });
          if (command !== "create_prompt_launcher") throw new Error("Unexpected command");
          if (window.__createFails) { window.__createFails = false; throw new Error("Fixture collision; existing content preserved"); }
          if (window.__delayCreate) await new Promise(resolve => { window.__resolveCreate = resolve; });
          return structuredClone(result);
        };
      }, { language, result });
      await page.route("**/src/PromptLauncherAction.tsx*", async route => {
        const response = await route.fetch();
        await route.fulfill({ response, body: (await response.text()).replaceAll("await invoke(", "await window.__launcherInvoke("), contentType: "application/javascript" });
      });
      await page.goto(baseUrl, { waitUntil: "networkidle" });
      await page.evaluate(async ({ reactUrl, domUrl }) => {
        const reactModule = await import(reactUrl);
        const React = reactModule.default ?? reactModule;
        const domModule = await import(domUrl);
        const { createRoot } = domModule.default ?? domModule;
        const { PromptLauncherAction } = await import("/src/PromptLauncherAction.tsx");
        const mount = document.createElement("div");
        mount.id = "qa-prompt-launcher";
        mount.style.cssText = "position:fixed;inset:0;z-index:99999;overflow:auto;background:var(--bg,#10131b);padding:24px;color:var(--text,#fff)";
        document.body.append(mount);
        const root = createRoot(mount);
        window.__renderLauncher = sourceId => root.render(React.createElement(PromptLauncherAction, { sourceId, onCreated: async () => { if (window.__refreshFails) throw new Error("Fixture refresh failure"); } }));
        window.__renderLauncher("fixture-source");
      }, { reactUrl, domUrl });
      const mount = page.locator("#qa-prompt-launcher");
      const button = mount.getByRole("button", { name: action, exact: true });
      await button.waitFor();
      assert.equal(await page.evaluate(() => "__TAURI_INTERNALS__" in window), false);
      await page.evaluate(() => { window.__createFails = true; });
      await button.click();
      await mount.getByRole("alert").waitFor();
      assert.equal(await mount.locator(".prompt-launcher-result").count(), 0);
      await page.evaluate(() => { window.__refreshFails = true; window.__delayCreate = true; });
      await button.evaluate(element => { element.click(); element.click(); });
      await page.waitForFunction(() => typeof window.__resolveCreate === "function");
      assert.equal(await page.evaluate(() => window.__launcherCalls.length), 2, "busy duplicate click must not launch another request");
      await page.evaluate(() => { window.__resolveCreate(); });
      await mount.locator(".prompt-launcher-result").waitFor();
      assert.equal(await mount.getByRole("alert").count(), 0, "refresh failure must not report creation failure");
      assert.match(await mount.innerText(), /prompt-0123456789abcdef/);
      assert.match(await mount.innerText(), /Fixture Library/);
      const warning = await mount.locator(".prompt-launcher-action > p[role=status]").innerText();
      assert.ok(warning.length > 10);
      await mount.getByRole("button", { name: copyName, exact: true }).click();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), result.name);
      await page.screenshot({ path: path.join(reportDir, `${language}-success-with-refresh-warning.png`) });
      await page.evaluate(() => { window.__renderLauncher("different-source"); });
      await mount.locator(".prompt-launcher-result").waitFor({ state: "detached" });
      await button.click();
      await page.waitForFunction(() => window.__launcherCalls.length === 3);
      await page.evaluate(() => { window.__renderLauncher("third-source"); window.__resolveCreate(); });
      await page.waitForTimeout(100);
      assert.equal(await mount.locator(".prompt-launcher-result").count(), 0, "stale response must not appear on another source");
      assert.deepEqual(errors, []);
      reports.push({ language, checks: ["create-failure-retry", "single-flight", "creation-survives-refresh-failure", "name-and-path", "copy-name", "stale-response-guard"] });
      await page.close();
    }
    fs.writeFileSync(path.join(reportDir, "qa.json"), JSON.stringify({ mode: "synthetic-ipc", nativeWrites: false, reports }, null, 2));
    console.log(`Prompt launcher UI QA passed: ${reports.length} languages`);
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
