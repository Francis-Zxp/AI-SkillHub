// Browser behavior contract using synthetic IPC only. Never reads a user Skill
// directory, starts a native host, or invokes a real import/write operation.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const baseUrl = process.env.AI_SKILLHUB_PREVIEW_URL || "http://127.0.0.1:4173";
const reportDir = path.resolve(__dirname, "../reports/visual/v3.2.6-external-skills");
const draftKey = "ai-skillhub-source-import-draft-v1";
const syntheticDocument = '# Original fixture\n<img src=x onerror="window.__unsafeExecuted=true">\n<script>window.__unsafeExecuted=true</script>\n[Untrusted link](javascript:alert(1))';
const selectedPath = "C:\\Fixture Skills\\physical-review";
const fixture = {
  generatedAt: "2026-09-20T00:00:00Z", truncated: false, warnings: [],
  roots: [{ agentId: "claude", agentName: "Claude Code", scope: "global", path: "C:\\Fixture\\.claude\\skills", status: "scanned", skillCount: 2 }, { agentId: "codex", agentName: "Codex", scope: "project", path: "D:\\Fixture Project\\.agents\\skills", status: "scanned", skillCount: 1 }],
  skills: [
    { id: "external-review", name: "paper-review", description: "科研 review original", path: "C:\\Fixture\\.claude\\skills\\paper-review", canonicalPath: selectedPath, agentId: "claude", agentName: "Claude Code", scope: "global", storageKind: "link", managed: false, canImport: true },
    { id: "managed-router", name: "managed-router", description: "Already in the library", path: "C:\\Fixture\\.claude\\skills\\managed-router", canonicalPath: "C:\\Fixture App\\sources\\managed-router", agentId: "claude", agentName: "Claude Code", scope: "global", storageKind: "link", managed: true, canImport: false },
    { id: "external-code", name: "code-review", description: "Project-local source analysis", path: "D:\\Fixture Project\\.agents\\skills\\code-review", canonicalPath: "D:\\Fixture Project\\.agents\\skills\\code-review", agentId: "codex", agentName: "Codex", scope: "project", storageKind: "directory", managed: false, canImport: true }
  ]
};
const labels = {
  zh: { title: "本机 Skills", scan: "重新扫描", search: "搜索名称、说明或路径", all: "全部工具", status: "全部状态", read: "查看原文", add: "复制到技能库", close: "关闭原文", use: "使用此路径", keep: "保留原草稿", next: "下一页", previous: "上一页" },
  en: { title: "Skills on this computer", scan: "Rescan", search: "Search name, description or path", all: "All tools", status: "All states", read: "Read original", add: "Copy to library", close: "Close original", use: "Use this path", keep: "Keep existing draft", next: "Next", previous: "Previous" },
  ko: { title: "이 컴퓨터의 Skills", scan: "다시 검색", search: "이름, 설명 또는 경로 검색", all: "모든 도구", status: "모든 상태", read: "원문 보기", add: "라이브러리로 복사", close: "원문 닫기", use: "이 경로 사용", keep: "기존 초안 유지", next: "다음", previous: "이전" }
};

async function fixturePage(browser, lang, draft = null, width = 1280) {
  const page = await browser.newPage({ viewport: { width, height: 860 }, locale: lang, permissions: ["clipboard-read", "clipboard-write"] });
  page.setDefaultTimeout(12_000);
  const pageErrors = [];
  page.on("pageerror", error => pageErrors.push(error.message));
  await page.addInitScript(({ fixture, lang, draft, draftKey, syntheticDocument }) => {
    localStorage.setItem("ai-skillhub-lang", lang);
    if (draft) localStorage.setItem(draftKey, JSON.stringify(draft));
    window.__fixtureCalls = [];
    window.__fixtureInventory = structuredClone(fixture);
    window.__fixtureFailScan = false;
    window.__fixtureFailRead = false;
    window.__fixtureInvoke = async (command, args) => {
      window.__fixtureCalls.push({ command, args });
      if (command === "scan_external_agent_skills") {
        if (window.__fixtureFailScan) { window.__fixtureFailScan = false; throw new Error("Fixture scan denied; no real path read"); }
        return structuredClone(window.__fixtureInventory);
      }
      if (command === "read_external_agent_skill") {
        if (window.__fixtureFailRead) { window.__fixtureFailRead = false; throw new Error("Fixture read denied"); }
        return { path: `${args.path}\\SKILL.md`, content: syntheticDocument };
      }
      throw new Error(`Unexpected fixture command: ${command}`);
    };
  }, { fixture, lang, draft, draftKey, syntheticDocument });

  // Enable only this panel's desktop-only branch, leaving the whole application
  // in normal browser preview mode. Route its two IPC reads to the fixture.
  await page.route("**/src/ExternalSkillsPanel.tsx*", async route => {
    const response = await route.fetch();
    const source = await response.text();
    assert.match(source, /export function ExternalSkillsPanel\(/, "QA requires the Vite dev server, not dist preview");
    const body = source.replace(/(export function ExternalSkillsPanel\([^)]*\)\s*\{)/, "$1\n runtimeAvailable = true;")
      .replaceAll("await invoke(", "await window.__fixtureInvoke(");
    assert.notEqual(body, source, "fixture route must replace the panel runtime boundary");
    await route.fulfill({ response, body, contentType: "application/javascript" });
  });
  await page.goto(`${baseUrl}/?view=agents`, { waitUntil: "networkidle" });
  await page.locator(".external-skills-list > li").first().waitFor();
  assert.equal(await page.evaluate(() => "__TAURI_INTERNALS__" in window), false, "native host must stay unavailable");
  return { page, pageErrors };
}

async function expectRows(page, count) {
  await page.waitForFunction(count => document.querySelectorAll(".external-skills-list > li").length === count, count);
}

async function main() {
  fs.mkdirSync(reportDir, { recursive: true });
  const browser = await chromium.launch({ headless: true, ...(process.platform === "win32" ? { channel: process.env.AI_SKILLHUB_QA_BROWSER || "chrome" } : {}) });
  const results = [];
  try {
    for (const lang of ["zh", "en", "ko"]) {
      const { page, pageErrors } = await fixturePage(browser, lang);
      const label = labels[lang];
      const panel = page.locator(".external-skills");
      assert.equal(await panel.locator("h3").innerText(), label.title);
      await expectRows(page, 3);
      const managed = panel.locator("li").filter({ hasText: "managed-router" });
      assert.equal(await managed.getByRole("button", { name: label.add, exact: true }).count(), 0, "managed links do not offer a redundant copy action");
      await panel.getByRole("textbox", { name: label.search }).fill("科研");
      await expectRows(page, 1);
      assert.match(await panel.locator("li").innerText(), /paper-review/);
      await panel.getByRole("textbox", { name: label.search }).fill("does-not-exist");
      await expectRows(page, 0);
      assert.equal(await panel.locator(".external-skills-empty").isVisible(), true);
      await panel.getByRole("textbox", { name: label.search }).fill("");
      await panel.getByRole("combobox", { name: label.all, exact: true }).selectOption("codex");
      await expectRows(page, 1);
      assert.match(await panel.locator("li").innerText(), /code-review/);
      await panel.getByRole("combobox", { name: label.all, exact: true }).selectOption("all");
      // A tool may disappear after refreshing a project. Its old filter must
      // not survive behind a select that visually falls back to "All tools".
      await panel.getByRole("combobox", { name: label.all, exact: true }).selectOption("codex");
      await page.evaluate(() => { window.__fixtureInventory.skills = window.__fixtureInventory.skills.filter(skill => skill.agentId !== "codex"); });
      await panel.getByRole("button", { name: label.scan, exact: true }).click();
      await expectRows(page, 2);
      assert.equal(await panel.getByRole("combobox", { name: label.all, exact: true }).inputValue(), "all");
      await page.evaluate(fixture => { window.__fixtureInventory = structuredClone(fixture); }, fixture);
      await panel.getByRole("button", { name: label.scan, exact: true }).click();
      await expectRows(page, 3);
      await panel.getByRole("combobox", { name: label.status, exact: true }).selectOption("managed");
      await expectRows(page, 1);
      await panel.getByRole("combobox", { name: label.status, exact: true }).selectOption("external");
      await expectRows(page, 2);
      await panel.getByRole("combobox", { name: label.status, exact: true }).selectOption("all");

      const first = panel.locator("li").filter({ hasText: "paper-review" });
      await first.getByRole("button", { name: label.read, exact: true }).click();
      await page.waitForFunction(() => document.querySelector(".external-skills-detail pre")?.textContent.includes("<script>"));
      assert.equal(await panel.locator(".external-skills-detail pre").innerText(), syntheticDocument);
      assert.equal(await panel.locator(".external-skills-detail img, .external-skills-detail script, .external-skills-detail a").count(), 0);
      assert.equal(await page.evaluate(() => Boolean(window.__unsafeExecuted)), false);
      await panel.getByRole("button", { name: label.close, exact: true }).click();
      await page.evaluate(() => { window.__fixtureFailRead = true; });
      await first.getByRole("button", { name: label.read, exact: true }).click();
      await panel.getByRole("alert").waitFor();
      await first.getByRole("button", { name: label.read, exact: true }).click();
      await panel.locator(".external-skills-detail pre").waitFor();
      await panel.getByRole("button", { name: label.close, exact: true }).click();

      await page.evaluate(() => { window.__fixtureFailScan = true; });
      await panel.getByRole("button", { name: label.scan, exact: true }).click();
      await panel.getByRole("alert").waitFor();
      await expectRows(page, 3);
      await panel.getByRole("button", { name: label.scan, exact: true }).click();
      await panel.getByRole("alert").waitFor({ state: "detached" });
      await expectRows(page, 3);

      await panel.locator(".external-skills-project input").fill("  D:\\Fixture Project  ");
      await panel.locator(".external-skills-project button").click();
      await page.waitForFunction(() => window.__fixtureCalls.some(call => call.command === "scan_external_agent_skills" && call.args.projectPath === "D:\\Fixture Project"));
      await first.getByRole("button", { name: label.read, exact: true }).click();
      await page.waitForFunction(() => window.__fixtureCalls.some(call => call.command === "read_external_agent_skill" && call.args.projectPath === "D:\\Fixture Project"));
      await panel.getByRole("button", { name: label.close, exact: true }).click();

      const largeInventory = structuredClone(fixture);
      for (let index = 0; index < 201; index++) {
        largeInventory.skills.push({ ...fixture.skills[0], id: `bulk-${index}`, name: `bulk-${String(index).padStart(3, "0")}`, path: `C:\\Fixture\\bulk\\${index}`, canonicalPath: `C:\\Fixture\\physical\\${index}`, description: "Pagination fixture" });
      }
      for (let index = 0; index < 3; index++) {
        largeInventory.skills.push({ ...fixture.skills[0], id: `alias-${index}`, agentId: `alias-tool-${index}`, agentName: `Alias Tool ${index}`, scope: index === 1 ? "project" : "global", path: `C:\\Fixture\\alias-${index}\\paper-review` });
      }
      assert.equal(largeInventory.skills.length, 207);
      await page.evaluate(data => { window.__fixtureInventory = data; }, largeInventory);
      await panel.getByRole("button", { name: label.scan, exact: true }).click();
      await expectRows(page, 20);
      const counts = await panel.locator(".external-skills-summary").innerText();
      assert.match(counts, /204/);
      assert.match(counts, /207/);
      const merged = panel.locator(".external-skills-list > li").filter({ hasText: "paper-review" });
      assert.equal(await merged.count(), 1);
      assert.match(await merged.innerText(), /Alias Tool 2/);
      await merged.locator("summary").click();
      assert.match(await merged.innerText(), /alias-1/);
      assert.match(await merged.innerText(), /physical-review/);
      await merged.locator("summary").click();
      const listBounds = await panel.locator(".external-skills-list").evaluate(element => ({ clientHeight: element.clientHeight, scrollHeight: element.scrollHeight }));
      assert.ok(listBounds.clientHeight <= 640 && listBounds.scrollHeight > listBounds.clientHeight, "large inventory stays in a bounded scroll region");
      assert.equal(await panel.getByRole("button", { name: label.previous, exact: true }).isDisabled(), true);
      for (let pageNumber = 2; pageNumber <= 11; pageNumber++) {
        await panel.getByRole("button", { name: label.next, exact: true }).click();
        await expectRows(page, pageNumber === 11 ? 4 : 20);
      }
      assert.equal(await panel.getByRole("button", { name: label.next, exact: true }).isDisabled(), true);
      await panel.getByRole("button", { name: label.previous, exact: true }).click();
      await expectRows(page, 20);
      await panel.getByRole("textbox", { name: label.search }).fill("paper-review");
      await expectRows(page, 1);
      assert.equal(await panel.getByRole("button", { name: label.previous, exact: true }).isDisabled(), true);
      assert.equal(await panel.getByRole("button", { name: label.next, exact: true }).isDisabled(), true);
      await panel.getByRole("textbox", { name: label.search }).fill("");
      await expectRows(page, 20);
      await panel.getByRole("button", { name: label.next, exact: true }).click();
      await panel.getByRole("combobox", { name: label.all, exact: true }).selectOption("codex");
      await expectRows(page, 1);
      assert.equal(await panel.getByRole("button", { name: label.previous, exact: true }).isDisabled(), true);
      await panel.getByRole("combobox", { name: label.all, exact: true }).selectOption("all");
      await panel.getByRole("combobox", { name: label.status, exact: true }).selectOption("managed");
      await expectRows(page, 1);
      await panel.getByRole("combobox", { name: label.status, exact: true }).selectOption("all");
      await expectRows(page, 20);
      await page.setViewportSize({ width: 1280, height: 860 });
      await page.screenshot({ path: path.join(reportDir, `${lang}-large-inventory.png`), fullPage: true });
      await page.evaluate(fixture => { window.__fixtureInventory = structuredClone(fixture); }, fixture);
      await panel.getByRole("button", { name: label.scan, exact: true }).click();
      await expectRows(page, 3);
      const overflow = [];
      for (const width of [760, 640]) {
        await page.setViewportSize({ width, height: 900 });
        await panel.scrollIntoViewIfNeeded();
        const size = await panel.evaluate(element => ({ width: element.clientWidth, scrollWidth: element.scrollWidth }));
        assert.ok(size.scrollWidth <= size.width + 2, `panel overflow ${lang}: ${JSON.stringify(size)}`);
        overflow.push({ viewport: width, ...size });
        await page.screenshot({ path: path.join(reportDir, `${lang}-narrow-${width}.png`), fullPage: true });
      }

      await first.getByRole("button", { name: label.add, exact: true }).click();
      await page.locator(".external-import-suggestion").waitFor();
      assert.equal(await page.locator(".external-import-suggestion code").innerText(), selectedPath);
      await page.getByRole("button", { name: label.use, exact: true }).click();
      assert.equal(await page.locator(".import-field.grow input").inputValue(), selectedPath);
      const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), draftKey);
      assert.equal(saved.importKind, "local");
      assert.equal(saved.input, selectedPath);
      assert.equal(await page.locator(".external-import-suggestion").count(), 0);
      assert.deepEqual(pageErrors, []);
      const calls = await page.evaluate(() => window.__fixtureCalls);
      assert.ok(calls.every(call => ["scan_external_agent_skills", "read_external_agent_skill"].includes(call.command)));
      results.push({ language: lang, uniqueSkills: 204, toolEntries: 207, pageSize: 20, pages: 11, listBounds, checks: ["scan", "search", "agent-filter", "removed-agent-filter-reset", "managed-filter", "safe-text-preview", "read-retry", "scan-retry", "project-context", "narrow-layout", "import-prefill", "canonical-groups", "bounded-pagination", "search-resets-page", "filter-resets-page", "managed-link-copy-hidden"], overflow, ipcCalls: calls.length });
      await page.close();
    }

    const draft = { customCategory: "Preserve category", customFolderName: "", enabled: false, importKind: "github", input: "https://github.com/fixture/existing", folderId: "", note: "Keep this note", selectedCategoryIds: ["development"], sourceType: "skill", tags: "keep, draft" };
    const { page, pageErrors } = await fixturePage(browser, "en", draft);
    await page.locator(".external-skills-list li").filter({ hasText: "paper-review" }).getByRole("button", { name: labels.en.add, exact: true }).click();
    await page.locator(".external-import-suggestion").waitFor();
    assert.equal(await page.locator(".import-field.grow input").inputValue(), draft.input);
    assert.match(await page.locator(".external-import-suggestion").innerText(), /import draft exists/);
    await page.getByRole("button", { name: labels.en.keep, exact: true }).click();
    assert.equal(await page.locator(".external-import-suggestion").count(), 0);
    const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)), draftKey);
    assert.deepEqual(saved, draft, "dismissing external import must preserve all draft fields");
    assert.deepEqual(pageErrors, []);
    await page.screenshot({ path: path.join(reportDir, "preserved-import-draft.png"), fullPage: true });
    results.push({ checks: ["existing-draft-preserved", "explicit-replacement-required"] });
    await page.close();
    fs.writeFileSync(path.join(reportDir, "qa.json"), JSON.stringify({ mode: "synthetic-ipc-browser-behavior", realFilesRead: false, nativeWrites: false, results }, null, 2));
    console.log(`v3.2.6 external Skills QA passed: ${results.length} scenarios; ${reportDir}`);
  } finally { await browser.close(); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
