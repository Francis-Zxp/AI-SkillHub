// QA for a really minimised window (v3.3 sky review). Playwright keeps its
// pages "visible", so this starts the installed Chrome itself and talks raw
// CDP: the page must go hidden, the 3D world sleep behind a decoded still and
// release every GPU resource, then wake when the window is restored.
//
//   node scripts/v3.3-sky-minimised-qa.cjs [baseUrl]
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn } = require("node:child_process");

const base = process.argv[2] ?? "http://127.0.0.1:1431/";
const chrome = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
  path.join(os.homedir(), "AppData/Local/Google/Chrome/Application/chrome.exe")
].find(file => fs.existsSync(file));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "sky-minimised-"));
const port = 9500 + Math.floor(Math.random() * 400);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const results = [];
const check = (name, ok, detail = "") => {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
};

function connect(url) {
  const socket = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  socket.onmessage = event => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error))); else resolve(message.result);
  };
  return {
    ready: new Promise(resolve => { socket.onopen = resolve; }),
    send: (method, params = {}) => new Promise((resolve, reject) => {
      const key = ++id;
      pending.set(key, { resolve, reject });
      socket.send(JSON.stringify({ id: key, method, params }));
    }),
    close: () => socket.close()
  };
}

(async () => {
  if (!chrome) throw new Error("Google Chrome is not installed");
  // Occlusion by other windows must not hide the page before we minimise it.
  const child = spawn(chrome, [`--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check",
    "--disable-backgrounding-occluded-windows", "--use-angle=d3d11", "--ignore-gpu-blocklist", "--window-size=1400,900", base], { stdio: "ignore" });
  try {
    let version = null;
    for (let attempt = 0; attempt < 60 && !version; attempt++) {
      await sleep(500);
      version = await fetch(`http://127.0.0.1:${port}/json/version`).then(response => response.json()).catch(() => null);
    }
    if (!version) throw new Error("Chrome did not open its debugging port");
    await sleep(1500);
    const target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(item => item.type === "page");
    const browser = connect(version.webSocketDebuggerUrl), page = connect(target.webSocketDebuggerUrl);
    await Promise.all([browser.ready, page.ready]);
    const evaluate = async expression => (await page.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true })).result.value;
    await evaluate(`(() => { localStorage.setItem("ai-skillhub-lang", "zh"); localStorage.setItem("ai-skillhub-theme", "sky-noon"); localStorage.setItem("ai-skillhub-theme-sky-default-v2", "1"); localStorage.setItem("skillhub-sky-world-seed", "7"); localStorage.setItem("skillhub-sky-sleep-ms", "3000"); location.reload(); return 1; })()`);
    await sleep(1000);
    for (let step = 0; step < 90; step++) {
      if (await evaluate(`document.querySelector(".sky-islands")?.getAttribute("data-status") === "ready" && Number(document.querySelector(".sky-scene-host")?.skyWorldStats?.().frames ?? 0) > 5`)) break;
      await sleep(500);
    }
    const state = () => evaluate(`({ hidden: document.hidden, sleeping: document.querySelector(".sky-scene-host")?.dataset.sleeping ?? "", canvases: document.querySelectorAll(".sky-world-canvas").length, still: Boolean(document.querySelector(".sky-world-still")), left: document.querySelector(".sky-scene-host")?.dataset.leftGeometries + "/" + document.querySelector(".sky-scene-host")?.dataset.leftTextures })`);
    const awake = await state();
    check("before: the page is visible and the world draws", !awake.hidden && awake.canvases === 1, awake);
    const { windowId } = await browser.send("Browser.getWindowForTarget", { targetId: target.id });
    await browser.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } });
    let asleep = null;
    for (let step = 0; step < 20; step++) {
      await sleep(1000);
      asleep = await state();
      if (asleep.sleeping === "1") break;
    }
    await sleep(1000);
    asleep = await state();
    check("minimised: the page is hidden and the world sleeps behind its still", asleep.hidden && asleep.sleeping === "1" && asleep.canvases === 0 && asleep.still, asleep);
    check("minimised: every geometry and texture is released", asleep.left === "0/0", asleep.left);
    await browser.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "normal" } });
    let woken = null;
    for (let step = 0; step < 20; step++) {
      await sleep(500);
      woken = await state();
      if (woken.canvases === 1 && !woken.still) break;
    }
    check("restored: the world is back and the still is gone", !woken.hidden && woken.canvases === 1 && !woken.still && woken.sleeping === "", woken);
    page.close();
    browser.close();
  } finally {
    child.kill();
    await sleep(1500);
    fs.rmSync(profile, { recursive: true, force: true });
  }
  const failed = results.filter(result => !result.ok).length;
  console.log(`${results.length - failed}/${results.length} checks pass`);
  process.exit(failed ? 1 : 0);
})().catch(error => {
  console.error(error);
  process.exit(1);
});
