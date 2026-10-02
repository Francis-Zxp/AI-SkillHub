// No Browser plugin is available. Playwright checks real React/CSS with synthetic data.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const out = path.resolve(__dirname, '../reports/visual/v3.2.11-ui');
const url = process.env.AI_SKILLHUB_PREVIEW_URL || 'http://127.0.0.1:1421/';
fs.mkdirSync(out, { recursive: true });
const results = [];
const fixture = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">
import React from 'react';import{createRoot}from'react-dom/client';import{SourceUpdatePanel}from'/src/SourceUpdatePanel.tsx';import{setLang}from'/src/i18n.ts';import'/src/styles.css';import'/src/sky-theme.css';
setLang('zh');const sources=Array.from({length:58},(_,i)=>({folder:'source-'+i,identity:'author/project-'+i,outcome:i===0?'failed':'unchanged',detail:i===0?'网络暂时不可用，可重试':'',tracking:'origin/main',checkedAt:'2026-10-02T08:00:00Z',addedSkills:[],removedPaths:[],discoveredSkills:[],keptLocalPaths:[],addedDependencies:[]}));
createRoot(document.getElementById('root')).render(React.createElement('main',{className:'theme-sky-night',style:{padding:24,minHeight:'100vh',background:'var(--bg)',color:'var(--text)'}},React.createElement(SourceUpdatePanel,{busy:false,run:{sources,rounds:1,updatedAt:'2026-10-02T08:00:00Z'}})));
</script></body></html>`;
fs.writeFileSync(path.join(out, 'panel.html'), fixture);
async function check(name, fn) {
  try { results.push({name,passed:true,detail:await fn()}); console.log('PASS',name); }
  catch(e) { results.push({name,passed:false,error:e.stack}); console.error('FAIL',name,e.message); }
}
(async()=>{
const browser=await chromium.launch({channel:'chrome',args:['--use-angle=d3d11','--ignore-gpu-blocklist']});
try {
 for(const [width,height,dpr,theme] of [[1260,840,1,'sky-night'],[1920,1080,2,'sky-night'],[1440,900,1.25,'sky-noon']]) {
  const context=await browser.newContext({viewport:{width,height},deviceScaleFactor:dpr});
  await context.addInitScript(theme=>{localStorage.setItem('ai-skillhub-theme',theme);localStorage.setItem('ai-skillhub-lang','zh');localStorage.setItem('skillhub-sky-enabled','1');},theme);
  const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.goto(url);await page.getByRole('button',{name:'星图',exact:true}).click();await page.waitForTimeout(1400);
  await page.screenshot({path:path.join(out,`stars-${theme}-${width}-dpr${dpr}.png`)});
  await check(`stars cover the canvas ${width}/${theme}`,()=>page.locator('.skill-universe-canvas').evaluate(c=>{
    const ctx=c.getContext('2d'),data=ctx.getImageData(0,0,c.width,c.height).data;
    let bright=0;for(let i=0;i<data.length;i+=4)if(data[i+3]>100&&data[i]>150)bright++;
    if(!bright)throw Error('No visible stars or nodes');return{bright,width:c.width,height:c.height};
  }));
  for(const view of ['星图','群岛']) {
    await page.getByRole('button',{name:view,exact:true}).click();await page.waitForTimeout(1000);
    await page.evaluate(()=>{document.querySelector('.preview-panel')?.remove();document.querySelector('.operation-banner')?.remove();const banner=document.createElement('section');banner.className='operation-banner';banner.innerHTML='<div><strong>更新全部来源</strong><span>正在检查来源并下载新增的 Skills · 第 2 轮</span></div><em>42% · 24/58</em><button class="ghost-action small">本轮结束后停止</button><i style="--operation-progress:42%"></i>';document.querySelector('.workspace-body').prepend(banner);});
    await page.waitForTimeout(500);
    await check(`progress leaves controls accessible ${view}/${width}`,()=>page.evaluate(()=>{
      const progress=document.querySelector('.operation-banner').getBoundingClientRect();
      const selectors=['.home-visual-switch button','.atlas-immersive-toggle','.atlas-intro-toggle','.skill-universe-modes button','.sky-controls button'];
      const controls=selectors.flatMap(s=>[...document.querySelectorAll(s)]).filter(e=>e.getClientRects().length);
      for(const e of controls){const r=e.getBoundingClientRect();if(r.top<progress.bottom)throw Error('Progress overlaps '+e.textContent);if(!e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)))throw Error('Control covered '+e.textContent);}
      return{progressBottom:progress.bottom,controls:controls.length};
    }));
    await page.screenshot({path:path.join(out,`progress-${view}-${width}.png`)});
    await page.evaluate(()=>document.querySelector('.operation-banner')?.remove());
  }
  await page.locator('.nav-item').nth(1).click();await page.waitForTimeout(500);
  await check(`library starts collapsed ${width}`,async()=>assert.equal(await page.locator('.source-group-toggle[aria-expanded="true"]').count(),0));
  const first=page.locator('.source-group-toggle').first();await first.click();
  await check(`library explicit expansion works ${width}`,async()=>assert.equal(await first.getAttribute('aria-expanded'),'true'));
  await first.click();
  await check(`library collapse works ${width}`,async()=>assert.equal(await first.getAttribute('aria-expanded'),'false'));
  await check(`no runtime errors ${width}`,async()=>assert.deepEqual(errors,[]));
  await context.close();
 }
 const page=await browser.newPage({viewport:{width:1080,height:800}});
 await page.goto(url+'reports/visual/v3.2.11-ui/panel.html');await page.getByRole('button',{name:'展开记录'}).waitFor();
 await check('update records start collapsed',async()=>assert.equal(await page.locator('.source-run-list').isVisible(),false));
 await page.getByRole('button',{name:'展开记录'}).click();
 await check('records scroll in bounded panel',()=>page.locator('.source-run-list').evaluate(e=>{if(e.clientHeight>380||e.scrollHeight<=e.clientHeight)throw Error('Not a bounded list');return{height:e.clientHeight,total:e.scrollHeight};}));
 await page.getByRole('tab',{name:/失败/}).click();
 await check('failure filter shows the failed source',async()=>assert.equal(await page.locator('.source-run-row').count(),1));
 await page.screenshot({path:path.join(out,'update-records.png')});
 await page.getByRole('button',{name:'收起记录'}).click();
 await check('records close again',async()=>assert.equal(await page.locator('.source-run-list').isVisible(),false));
} finally {await browser.close();fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));}
if(results.some(r=>!r.passed))process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
