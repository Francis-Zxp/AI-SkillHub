const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const endpoint = process.env.AI_SKILLHUB_CDP_URL || "http://127.0.0.1:9339";
const action = process.argv[2] || "move";
const reportDir = path.resolve(__dirname, "../reports/desktop/v3.2.1-tauri-drag");

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  assert.ok(value, `${name} is required for formal desktop QA`);
  return value;
}

function isolatedQaPath(name) {
  const candidate = path.resolve(requiredEnvironment(name));
  const tempRoot = path.resolve(process.env.TEMP || process.env.TMP || "");
  const relative = path.relative(tempRoot, candidate);
  assert.ok(
    tempRoot && relative && !relative.startsWith("..") && !path.isAbsolute(relative),
    `${name} must be a dedicated child of the Windows temporary directory`
  );
  return candidate;
}

function buildIdentity() {
  const exePath = path.resolve(requiredEnvironment("AI_SKILLHUB_EXPECTED_EXE_PATH"));
  const expectedSha256 = requiredEnvironment("AI_SKILLHUB_EXPECTED_EXE_SHA256").toLowerCase();
  const pid = Number(requiredEnvironment("AI_SKILLHUB_EXPECTED_PID"));
  const productVersion = requiredEnvironment("AI_SKILLHUB_EXPECTED_PRODUCT_VERSION");
  assert.ok(Number.isInteger(pid) && pid > 0, "AI_SKILLHUB_EXPECTED_PID must be a positive integer");
  assert.ok(fs.statSync(exePath).isFile(), "expected AI SkillHub executable is not a file");
  const actualSha256 = crypto.createHash("sha256").update(fs.readFileSync(exePath)).digest("hex");
  assert.equal(actualSha256, expectedSha256, "the tested executable hash changed before QA");
  return { pid, exePath, sha256: actualSha256, productVersion };
}

assert.ok(["move", "verify-restore"].includes(action), `Unsupported drag QA action: ${action}`);
const qaRunId = requiredEnvironment("AI_SKILLHUB_QA_RUN_ID");
assert.match(qaRunId, /^[a-f0-9]{32}$/, "AI_SKILLHUB_QA_RUN_ID must be a lowercase GUID without separators");
const stateFile = path.join(reportDir, `state-${qaRunId}.json`);
fs.mkdirSync(reportDir, { recursive: true });
const qaDataRoot = isolatedQaPath("AI_SKILLHUB_QA_DATA_ROOT");
const identity = buildIdentity();
const qaSourceName = requiredEnvironment("AI_SKILLHUB_QA_SOURCE_NAME");

async function appPage(browser) {
  const deadline = Date.now() + 30_000;
  let page;
  let observed = [];
  while (Date.now() < deadline) {
    const pages = browser.contexts().flatMap(context => context.pages());
    observed = pages.map(candidate => candidate.url());
    for (const candidate of pages) {
      if (/^https?:\/\/tauri\.localhost(?:\/|$)/.test(candidate.url()) ||
          /AI SkillHub/i.test(await candidate.title().catch(() => ""))) {
        page = candidate;
        break;
      }
    }
    if (page) break;
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert.ok(page, `No AI SkillHub Tauri page was exposed by ${endpoint}; observed URLs: ${JSON.stringify(observed)}`);
  assert.match(await page.title(), /AI SkillHub/i, "CDP page is not an AI SkillHub window");
  await page.locator(".shell").waitFor({ timeout: 30_000 });
  await page.locator(".topbar .primary-pill").waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const button = document.querySelector(".topbar .primary-pill");
    return button && !button.disabled;
  }, undefined, { timeout: 180_000 });
  return page;
}

async function openLibrary(page) {
  const libraryNav = page.locator(".nav .nav-item").nth(1);
  await libraryNav.click();
  await page.locator(".library-view").waitFor();
  await page.locator(".command-search input").fill("");
}

async function verifyIsolatedFixture(page) {
  await openLibrary(page);
  const allSources = page.locator(".source-group");
  const qaSources = allSources.filter({ hasText: qaSourceName });
  const sourceCount = await allSources.count();
  assert.ok(sourceCount >= 1 && sourceCount <= 3, `formal drag QA found ${sourceCount} sources instead of its bounded isolated fixture`);
  assert.equal(await qaSources.count(), 1, "isolated QA source sentinel is missing or ambiguous");
}

async function ensureQaFolders(page) {
  await verifyIsolatedFixture(page);
  let folderCount = await page.locator(".skill-folder-item").count();
  for (let index = folderCount; index < 2; index += 1) {
    await page.evaluate(
      args => window.__TAURI_INTERNALS__.invoke("create_skill_folder", args),
      { name: `QA Folder ${index + 1}`, note: "isolated formal desktop QA", color: index ? "violet" : "cyan" }
    );
  }
  if (folderCount < 2) {
    await page.reload({ waitUntil: "domcontentloaded" });
    await page.locator(".shell").waitFor({ timeout: 30_000 });
    await page.waitForFunction(() => {
      const button = document.querySelector(".topbar .primary-pill");
      return button && !button.disabled;
    }, undefined, { timeout: 180_000 });
    await openLibrary(page);
    folderCount = await page.locator(".skill-folder-item").count();
  }
  assert.ok(folderCount >= 2, "isolated drag QA could not prepare two local folders");
}

async function verifyCopyActions(page) {
  await openLibrary(page);
  await page.evaluate(() => {
    const writes = [];
    const clipboard = navigator.clipboard;
    if (!clipboard) throw new Error("navigator.clipboard is unavailable in the formal WebView");
    Object.defineProperty(clipboard, "writeText", {
      configurable: true,
      value: async value => { writes.push(String(value)); }
    });
    window.__skillhubQaClipboardWrites = writes;
  });
  const source = page.locator(".source-group").filter({ hasText: qaSourceName }).first();
  const toggle = source.locator(".source-group-toggle");
  const parentCopy = source.locator(".source-parent-copy");
  await parentCopy.waitFor();
  if (await toggle.getAttribute("aria-expanded") === "true") await toggle.click();
  await page.waitForFunction(element => element.getAttribute("aria-expanded") === "false", await toggle.elementHandle());
  const parentTitle = await parentCopy.getAttribute("title");
  const parentInvocation = parentTitle.split(/[：:]/).at(-1).trim();
  assert.ok(parentInvocation, "parent copy control has no exact invocation name");
  await parentCopy.click();
  await page.waitForFunction(expected => window.__skillhubQaClipboardWrites?.at(-1) === expected, parentInvocation);
  const copiedParent = await page.evaluate(() => window.__skillhubQaClipboardWrites.at(-1));
  assert.equal(copiedParent, parentInvocation, "formal WebView copied the wrong parent Skill name");
  assert.equal(await toggle.getAttribute("aria-expanded"), "false", "parent copy expanded the source tree");

  await toggle.click();
  await page.waitForFunction(element => element.getAttribute("aria-expanded") === "true", await toggle.elementHandle());
  const childCopy = source.locator(".skill-row:not(.is-parent) .skill-name-copy").first();
  await childCopy.waitFor();
  const childTitle = await childCopy.getAttribute("title");
  const childInvocation = childTitle.split(/[：:]/).at(-1).trim();
  assert.ok(childInvocation, "child copy control has no exact invocation name");
  await childCopy.click();
  await page.waitForFunction(expected => window.__skillhubQaClipboardWrites?.at(-1) === expected, childInvocation);
  const copiedChild = await page.evaluate(() => window.__skillhubQaClipboardWrites.at(-1));
  assert.equal(copiedChild, childInvocation, "formal WebView copied the wrong child Skill name");
  return { parentInvocation, copiedParent, childInvocation, copiedChild };
}

async function moveWithRealPointer(page) {
  await ensureQaFolders(page);
  const copyEvidence = await verifyCopyActions(page);
  await openLibrary(page);
  await page.locator(".skill-folder-shelf").scrollIntoViewIfNeeded();
  const source = page.locator(".source-group").filter({ hasText: qaSourceName }).first();
  const grip = source.locator(".source-folder-drag-handle");
  const select = source.locator(".source-folder-select select");
  await grip.waitFor();
  assert.equal(await grip.getAttribute("draggable"), "true", "Tauri source grip is not draggable");
  const selectId = await select.getAttribute("id");
  const originalFolder = await select.inputValue();
  const options = await select.locator("option").evaluateAll(items =>
    items.map(item => ({ label: item.textContent.trim(), value: item.value }))
  );
  const target = options.find(option => option.value && option.value !== originalFolder);
  assert.ok(target, "No alternate folder exists for the Tauri drag test");
  const folderTarget = page.locator(".skill-folder-target").filter({ hasText: target.label }).first();
  await folderTarget.waitFor();
  await page.evaluate(() => window.scrollBy({ top: -160, behavior: "instant" }));
  await page.waitForTimeout(80);

  const gripBox = await grip.boundingBox();
  const targetBox = await folderTarget.boundingBox();
  assert.ok(gripBox && targetBox, "Tauri drag source or target has no screen box");
  const hit = await folderTarget.evaluate(element => {
    const rect = element.getBoundingClientRect();
    const candidate = document.elementFromPoint(rect.left + rect.width * 0.2, rect.top + rect.height / 2);
    return Boolean(candidate && (candidate === element || element.contains(candidate)));
  });
  assert.equal(hit, true, "Tauri folder target is covered by another element");

  const preparedState = {
    phase: "prepared",
    pendingRestore: true,
    qaRunId,
    qaDataRoot,
    movedBy: identity,
    selectId,
    originalFolder,
    targetFolder: target.value,
    targetLabel: target.label,
    copyEvidence,
    preparedAt: new Date().toISOString()
  };
  fs.writeFileSync(stateFile, JSON.stringify(preparedState, null, 2));

  try {
    await folderTarget.evaluate(element => {
      window.__skillhubTauriDrag = { enters: 0, overs: 0, drops: 0, types: [] };
      element.addEventListener("dragenter", event => {
        window.__skillhubTauriDrag.enters += 1;
        window.__skillhubTauriDrag.types = [...event.dataTransfer.types];
      });
      element.addEventListener("dragover", () => { window.__skillhubTauriDrag.overs += 1; });
      element.addEventListener("drop", () => { window.__skillhubTauriDrag.drops += 1; });
    });

    await page.mouse.move(gripBox.x + gripBox.width / 2, gripBox.y + gripBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(gripBox.x + gripBox.width / 2 + 12, gripBox.y + gripBox.height / 2 + 4, { steps: 4 });
    await page.mouse.move(targetBox.x + Math.min(32, targetBox.width * 0.2), targetBox.y + targetBox.height / 2, { steps: 18 });
    await page.waitForTimeout(100);
    await page.mouse.up();

    await page.waitForFunction(
      ({ id, value }) => document.getElementById(id)?.value === value,
      { id: selectId, value: target.value },
      { timeout: 30_000 }
    );
    const dragEvidence = await page.evaluate(() => window.__skillhubTauriDrag);
    assert.ok(dragEvidence.enters > 0 && dragEvidence.overs > 0 && dragEvidence.drops === 1, "Tauri pointer drag chain did not complete");
    assert.ok(dragEvidence.types.includes("application/x-ai-skillhub-source-id"), "Tauri drag lost the internal source MIME type");

    const state = {
      ...preparedState,
      phase: "moved",
      dragEvidence,
      movedAt: new Date().toISOString()
    };
    fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
    return state;
  } catch (error) {
    try {
      await select.selectOption(originalFolder);
      await page.waitForFunction(
        ({ id, value }) => document.getElementById(id)?.value === value,
        { id: selectId, value: originalFolder },
        { timeout: 30_000 }
      );
      fs.writeFileSync(stateFile, JSON.stringify({
        ...preparedState,
        phase: "restored-after-move-failure",
        pendingRestore: false,
        restoredAt: new Date().toISOString()
      }, null, 2));
    } catch (restoreError) {
      fs.writeFileSync(stateFile, JSON.stringify({
        ...preparedState,
        phase: "restore-required-after-move-failure",
        restorationError: String(restoreError)
      }, null, 2));
    }
    throw error;
  }
}

async function verifyAfterRestartAndRestore(page) {
  const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
  assert.equal(state.phase, "moved", "drag QA has no completed move to verify");
  assert.equal(state.pendingRestore, true, "drag QA state does not require restoration");
  assert.equal(state.qaRunId, qaRunId, "drag QA state belongs to a different formal run");
  assert.equal(path.resolve(state.qaDataRoot), qaDataRoot, "drag QA data root changed between phases");
  assert.notEqual(state.movedBy.pid, identity.pid, "drag persistence was not checked after a different app process started");
  assert.equal(state.movedBy.exePath, identity.exePath, "a different executable path was used after restart");
  assert.equal(state.movedBy.sha256, identity.sha256, "a different executable build was used after restart");
  assert.equal(state.movedBy.productVersion, identity.productVersion, "the executable version changed between drag phases");
  await openLibrary(page);
  const select = page.locator(`#${state.selectId}`);
  await select.waitFor();
  assert.equal(await select.inputValue(), state.targetFolder, "Dragged folder assignment did not survive a Tauri restart");
  await select.selectOption(state.originalFolder);
  await page.waitForFunction(
    ({ id, value }) => document.getElementById(id)?.value === value,
    { id: state.selectId, value: state.originalFolder },
    { timeout: 30_000 }
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await appPage({ contexts: () => page.context().browser().contexts() });
  await openLibrary(page);
  const restored = page.locator(`#${state.selectId}`);
  await restored.waitFor();
  assert.equal(await restored.inputValue(), state.originalFolder, "Original folder assignment was not restored after QA");
  const result = {
    ...state,
    phase: "verified-and-restored",
    pendingRestore: false,
    verifiedBy: identity,
    restoredAt: new Date().toISOString(),
    restored: true
  };
  fs.writeFileSync(stateFile, JSON.stringify(result, null, 2));
  return result;
}

(async () => {
  let browser;
  try {
    browser = await chromium.connectOverCDP(endpoint);
    const page = await appPage(browser);
    const result = action === "verify-restore"
      ? await verifyAfterRestartAndRestore(page)
      : await moveWithRealPointer(page);
    console.log(`Tauri drag QA ${action} passed`, result);
  } finally {
    await browser?.close().catch(() => undefined);
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
