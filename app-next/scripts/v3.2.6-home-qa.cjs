const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");

const baseUrl = process.env.AI_SKILLHUB_PREVIEW_URL || "http://127.0.0.1:4173";
const reportDir = path.resolve(__dirname, "../reports/visual/v3.2.6-home");
fs.mkdirSync(reportDir, { recursive: true });
const fixture = path.join(reportDir, "fixture.html");
fs.writeFileSync(fixture, `<!doctype html><meta charset="utf-8"><div id="root"></div><script type="module">
import React from 'react';
import {createRoot} from 'react-dom/client';
import {SkillArchipelago} from '/src/SkillArchipelago.tsx';
import {SkillUniverse} from '/src/SkillUniverse.tsx';
import {createPreviewSnapshot} from '/src/preview.ts';
import {setLang} from '/src/i18n.ts';
import '/src/styles.css';
setLang('en');
const original=createPreviewSnapshot();
const sources=Array.from({length:11},(_,i)=>({...original.sources[0],id:'source-'+i,name:'owner--island-'+i,url:'https://github.com/owner/island-'+i,userFolderId:i===0?'research':'',enabled:i!==1}));
const skills=sources.map((source,i)=>({...original.skills[0],id:'child-'+i,name:'child-'+i,sourceId:source.id,source:source.name,isRouterHub:false,userFolderId:source.userFolderId}));
skills.push({...skills[0],id:'child-extra',name:'second-child'});
skills.push({...skills[0],id:'router',name:'router',isRouterHub:true});
const snapshot={...original,sources,skills,skillFolders:[{id:'research',name:'Research',skillCount:999,color:'teal',sortOrder:0,note:'',createdAt:'',updatedAt:''}]};
const root=createRoot(document.getElementById('root'));
window.__homeClicks={};
window.__renderHome=(mode='islands',light=false)=>root.render(React.createElement('div',{className:'shell theme-family-atlas page-dashboard '+(light?'theme-atlas-light':'theme-atlas-dark'),style:{height:'100vh'}},React.createElement('div',{className:'dashboard-hero',style:{position:'relative',width:'100vw',height:'100vh'}},React.createElement(mode==='stars'?SkillUniverse:SkillArchipelago,{centered:true,lightTheme:light,tone:'prism',snapshot:mode==='loading'?null:mode==='empty'?{...snapshot,sources:[],skills:[],skillFolders:[]}:snapshot,onOpenSource:source=>window.__homeClicks.source=source.id,onOpenSkill:skill=>window.__homeClicks.skill=skill.id,onOpenFolder:id=>window.__homeClicks.folder=id}))));
window.__renderHome();
</script>`);

(async () => {
  const browser = await chromium.launch({ headless: true, channel: "msedge" });
  const results = [];
  try {
    for (const viewport of [{ width: 1260, height: 820, dpr: 1 }, { width: 3840, height: 2160, dpr: 1 }, { width: 1920, height: 1080, dpr: 2 }]) {
      const page = await browser.newPage({ viewport, deviceScaleFactor: viewport.dpr, reducedMotion: "reduce" });
      const errors = [];
      page.on("pageerror", error => { errors.push(error.message); console.error(error.message); });
      try {
        await page.goto(`${baseUrl}/reports/visual/v3.2.6-home/fixture.html`, { waitUntil: "networkidle" });
        await page.locator(".archipelago-island").first().waitFor();
        assert.equal(await page.locator(".archipelago-island").count(), 8);
        const first = page.getByRole("button", { name: "Open island-0 · 2 Skills", exact: true });
        await first.focus(); await page.keyboard.press("Enter");
        assert.equal(await page.evaluate(() => window.__homeClicks.source), "source-0");
        assert.equal(await first.locator("small").innerText(), "owner");
        assert.equal(await page.locator(".archipelago-float").first().evaluate(el => getComputedStyle(el).animationName), "none");
        await page.getByRole("button", { name: "Next", exact: true }).click();
        assert.equal(await page.locator(".archipelago-island").count(), 3);
        await page.getByRole("button", { name: "My folders", exact: true }).click();
        const folder = page.getByRole("button", { name: "Open Research · 2 Skills", exact: true });
        await folder.focus(); await page.keyboard.press("Space");
        assert.equal(await page.evaluate(() => window.__homeClicks.folder), "research");
        await page.evaluate(() => window.__renderHome("islands", true));
        await page.getByRole("button", { name: "Source islands", exact: true }).click();
        await page.screenshot({ path: path.join(reportDir, `islands-light-${viewport.width}-${viewport.dpr}.png`) });
        await page.evaluate(() => window.__renderHome("islands", false));
        await page.screenshot({ path: path.join(reportDir, `islands-dark-${viewport.width}-${viewport.dpr}.png`) });
        await page.evaluate(() => window.__renderHome("loading"));
        await page.getByRole("status").waitFor();
        await page.evaluate(() => window.__renderHome("empty"));
        await page.getByText("No islands yet", { exact: true }).waitFor();
        await page.evaluate(() => window.__renderHome("stars"));
        await page.locator(".skill-universe-canvas").waitFor();
        const backing = await page.locator(".skill-universe-canvas").evaluate(el => ({ width: el.width, height: el.height, cssWidth: el.getBoundingClientRect().width, cssHeight: el.getBoundingClientRect().height, scale: Number(el.dataset.renderScale) }));
        assert.equal(backing.scale, viewport.dpr);
        assert.ok(Math.abs(backing.width - backing.cssWidth * viewport.dpr) <= 1);
        assert.ok(Math.abs(backing.height - backing.cssHeight * viewport.dpr) <= 1);
        assert.deepEqual(errors, []);
        results.push({ viewport, backing, browser: browser.version(), counts: "router excluded; stale folder count ignored", keyboard: "source Enter and folder Space passed", states: "loading, empty, disabled, reduced motion" });
      } finally { await page.close(); }
    }
  } finally { await browser.close(); }
  fs.writeFileSync(path.join(reportDir, "report.json"), JSON.stringify(results, null, 2));
  console.log(`Homepage checks passed at ${results.length} viewports, including both native 4K configurations. ${reportDir}`);
})().catch(error => { console.error(error); process.exitCode = 1; });
