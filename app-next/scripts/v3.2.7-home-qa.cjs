// Browser plugin not available. Uses installed Playwright + Edge, synthetic data only.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const baseUrl = process.env.AI_SKILLHUB_PREVIEW_URL || 'http://127.0.0.1:4173';
const reportDir = path.resolve(__dirname, '../reports/visual/v3.2.7-home');
const screenshotOnly = process.env.SKY_QA_SCREENSHOTS === '1';
fs.mkdirSync(reportDir, { recursive: true });
fs.writeFileSync(path.join(reportDir, 'fixture.html'), `<!doctype html><html><head><meta charset="utf-8"><title>Sky island QA</title></head><body style="margin:0"><div id="root"></div><script type="module">
import React from 'react'; import {createRoot} from 'react-dom/client';
import {SkillArchipelago} from '/src/SkillArchipelago.tsx';
import {createPreviewSnapshot} from '/src/preview.ts'; import {setLang} from '/src/i18n.ts';
import '/src/styles.css';
setLang('en');
const original=createPreviewSnapshot(), names=['Research','Writing','Engineering','Design','Product','Empty category'], counts=[20,80,200,450,10,0];
const skillFolders=names.map((name,i)=>({id:'folder-'+i,name,note:'',color:'mint',sortOrder:i,skillCount:9999,createdAt:'',updatedAt:''}));
const sources=names.map((name,i)=>({...original.sources[0],id:'source-'+i,name:'owner--'+name,url:'https://github.com/owner/'+name,sourceType:'skill',userFolderId:'folder-'+i}));
const skills=counts.flatMap((count,i)=>Array.from({length:count},(_,j)=>({...original.skills[0],id:'child-'+i+'-'+j,name:names[i]+' skill '+j,folderName:'child-'+i+'-'+j,relativePath:'skills/child-'+i+'-'+j,sourceId:'source-'+i,source:sources[i].name,userFolderId:'',isRouterHub:false})));
skills.push({...skills[0],id:'router',isRouterHub:true},{...skills[0],id:'unfiled',sourceId:undefined,source:'standalone',userFolderId:''});
sources.push({...sources[0],id:'prompt',name:'Prompt collection',sourceType:'prompt',userFolderId:'folder-1'});
const snapshot={...original,skills,sources,skillFolders};
window.__snapshot=snapshot; window.__clicks=[];
const root=createRoot(document.getElementById('root'));
window.__renderSky=(mode='full',light=false)=>root.render(React.createElement('div',{style:{position:'relative',height:'100vh'}},React.createElement(SkillArchipelago,{key:mode+light,centered:true,lightTheme:light,snapshot:mode==='loading'?null:mode==='empty'?{...snapshot,skills:[],sources:[],skillFolders:[]}:snapshot,onOpenFolder:id=>window.__clicks.push(id),onOpenSource:()=>{},onOpenSkill:()=>{}})));
window.__renderSky();
</script></body></html>`);

const results = [], failures = [];
async function step(name, action) {
  try { const detail = await action(); results.push({ name, passed: true, detail }); }
  catch (error) { failures.push({ name, error: error.stack }); console.error(name, error.message); }
}
async function screenshot(page, name) {
  const file = path.join(reportDir, `${name}.png`); await page.screenshot({ path: file }); return file;
}
async function stableFrames(page) {
  let previous = -1;
  for (let i = 0; i < 50; i++) {
    const frames = Number(await page.locator('.sky-scene-host').getAttribute('data-frames'));
    if (frames === previous && frames > 0) return frames;
    previous = frames; await page.waitForTimeout(160);
  }
  throw Error('Frames did not settle');
}
async function positions(page) { return page.locator('.sky-island-label').evaluateAll(labels => labels.map(label => label.style.transform)); }
async function ready(page) { await page.locator('.sky-islands[data-status="ready"]').waitFor(); await page.waitForFunction(() => Number(document.querySelector('.sky-scene-host')?.dataset.frames) > 1); }

(async () => {
  const browser = await chromium.launch({ headless: true, channel: 'msedge' });
  try {
    const viewports = screenshotOnly
      ? [{width:1260,height:840,dpr:1},{width:1920,height:1080,dpr:1},{width:3840,height:2160,dpr:1}]
      : [{width:1920,height:1080,dpr:1},{width:2560,height:1440,dpr:1},{width:3840,height:2160,dpr:1},{width:1920,height:1080,dpr:2}];
    for (const viewport of viewports) {
      for (const light of [false,true]) {
        const page = await browser.newPage({viewport,deviceScaleFactor:viewport.dpr,reducedMotion:'no-preference'});
        page.setDefaultTimeout(20000);
        const errors=[], warnings=[];
        page.on('pageerror', error=>errors.push(error.message));
        page.on('console', msg=>{if(msg.type()==='error'||msg.type()==='warning') warnings.push(msg.text());});
        const id=`${light?'light':'dark'}-${viewport.width}-${viewport.height}-${viewport.dpr}`;
        await step(`render ${id}`, async()=>{
          await page.goto(baseUrl+'/reports/visual/v3.2.7-home/fixture.html');
          if(light) await page.evaluate(()=>window.__renderSky('full',true));
          await ready(page);
          await page.getByRole('button',{name:'Pause motion',exact:true}).click();
          await stableFrames(page);
          assert.equal(await page.title(),'Sky island QA');
          assert.equal(await page.locator('vite-error-overlay').count(),0);
          assert.equal(await page.locator('.sky-island-label').count(),7);
          const metrics=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,labels:[...document.querySelectorAll('.sky-island-label')].map(el=>({text:el.textContent,rect:el.getBoundingClientRect().toJSON()})),canvas:{width:document.querySelector('canvas').width,height:document.querySelector('canvas').height},scene:{...document.querySelector('.sky-scene-host').dataset}}));
          assert.ok(metrics.scroll<=metrics.width+1);
          assert.equal(Number(metrics.scene.pixelRatio),viewport.dpr);
          for(const label of metrics.labels) assert.ok(label.rect.x>=0&&label.rect.right<=viewport.width&&label.rect.y>=0&&label.rect.bottom<=viewport.height,`offscreen ${label.text}`);
          assert.ok(metrics.labels.some(label=>label.text.includes('Writing80 Skills · 1 Prompt')));
          assert.ok(metrics.labels.some(label=>label.text.includes('Empty category0 Skills')));
          assert.deepEqual(errors,[]);
          return {viewport,metrics,errors,warnings,screenshot:await screenshot(page,id)};
        });
        if(!screenshotOnly&&viewport.width===1920&&viewport.dpr===1&&!light) {
          await step('ray hit and canvas callback',async()=>{
            const host=await page.locator('.sky-world-canvas').boundingBox(); let target;
            const candidates=await page.locator('.sky-island-label').evaluateAll(labels=>labels.flatMap(el=>{const b=el.getBoundingClientRect();return [30,60,100,150].flatMap(dy=>[-30,0,30].map(dx=>({x:b.x+b.width/2+dx,y:b.y-dy})));}));
            for(let y=host.y+30;y<host.y+host.height-20;y+=80) for(let x=host.x+30;x<host.x+host.width-20;x+=80)candidates.push({x,y});
            // Real mouse movement over the actual canvas; userData/raycast remains production code.
            for(const {x,y} of candidates){
              if(!await page.evaluate(({x,y})=>document.elementFromPoint(x,y)?.classList.contains('sky-world-canvas'),{x,y}))continue;
              await page.mouse.move(x,y);
              const hovered=await page.locator('.sky-island-label.is-hovered').evaluateAll(items=>items[0]?.textContent);
              if(hovered) { target={x,y,hovered}; break; }
            }
            assert.ok(target,'a visible island must be hittable');
            await page.mouse.click(target.x,target.y);
            assert.equal(await page.evaluate(()=>window.__clicks.length),1);
            return {...target,callback:await page.evaluate(()=>window.__clicks[0])};
          });
          await step('drag suppresses click, zoom and reset',async()=>{
            await page.mouse.move(5,5); await stableFrames(page);
            const before=await positions(page), clicks=await page.evaluate(()=>window.__clicks.length);
            const box=await page.locator('.sky-world-canvas').boundingBox(); const x=box.x+box.width*.45,y=box.y+box.height*.45;
            await page.mouse.move(x,y); await page.mouse.down(); await page.mouse.move(x+110,y+65,{steps:12}); await page.mouse.up(); await stableFrames(page);
            assert.equal(await page.evaluate(()=>window.__clicks.length),clicks);
            assert.notDeepEqual(await positions(page),before);
            await page.mouse.wheel(0,-350); await stableFrames(page);
            const zoomed=await positions(page); assert.notDeepEqual(zoomed,before);
            await page.getByRole('button',{name:'Show all',exact:true}).click(); await stableFrames(page);
            const reset=await positions(page);
            const xy=value=>value.match(/translate\(([-.\d]+)px,\s*([-.\d]+)px\)/).slice(1).map(Number);
            reset.forEach((value,i)=>xy(value).forEach((n,j)=>assert.ok(Math.abs(n-xy(before[i])[j])<1,'reset restores camera')));
            return {before,zoomed,reset};
          });
          await step('navigation search, keyboard open, empty category',async()=>{
            await page.getByRole('button',{name:'Categories',exact:true}).click();
            await page.getByRole('textbox',{name:'Find a category'}).fill('Writing');
            assert.equal(await page.locator('.sky-navigation-row').count(),1);
            const target=page.locator('.sky-navigation-row > button').first(); await target.focus(); await page.keyboard.press('Enter');
            assert.equal(await page.evaluate(()=>window.__clicks.at(-1)),'folder-1');
            await page.getByRole('textbox',{name:'Find a category'}).fill('Empty category');
            await page.locator('.sky-navigation-row > button').first().focus(); await page.keyboard.press('Space');
            assert.equal(await page.evaluate(()=>window.__clicks.at(-1)),'folder-5');
            await page.getByRole('textbox',{name:'Find a category'}).fill('missing category');
            assert.equal(await page.getByText('No matching categories',{exact:true}).count(),1);
            await page.getByRole('button',{name:'Show all',exact:true}).click();
            assert.equal(await page.getByRole('textbox',{name:'Find a category'}).inputValue(),'');
            await screenshot(page,'navigation');
            await page.getByRole('button',{name:'Close navigation',exact:true}).click();
            return 'Enter/Space emitted correct folder IDs, search/reset passed';
          });
          await step('pause and reduced motion stop frames',async()=>{
            await page.mouse.move(5,5); const paused=await stableFrames(page); await page.waitForTimeout(500);
            assert.equal(Number(await page.locator('.sky-scene-host').getAttribute('data-frames')),paused);
            await page.getByRole('button',{name:'Play motion',exact:true}).click(); await page.waitForTimeout(600);
            assert.ok(Number(await page.locator('.sky-scene-host').getAttribute('data-frames'))>paused);
            await page.emulateMedia({reducedMotion:'reduce'}); const reduced=await stableFrames(page); await page.waitForTimeout(500);
            assert.equal(Number(await page.locator('.sky-scene-host').getAttribute('data-frames')),reduced);
            return {paused,reduced};
          });
          await step('context loss fallback retains folder navigation',async()=>{
            await page.locator('canvas.sky-world-canvas').evaluate(canvas=>canvas.getContext('webgl2').getExtension('WEBGL_lose_context').loseContext());
            await page.locator('.sky-islands[data-status="fallback"]').waitFor();
            assert.equal(await page.locator('.sky-navigation-row').count(),7);
            await page.locator('.sky-navigation-row > button').filter({hasText:'Research'}).click();
            assert.equal(await page.evaluate(()=>window.__clicks.at(-1)),'folder-0');
            return {screenshot:await screenshot(page,'webgl-fallback')};
          });
          await step('loading and empty states remain meaningful',async()=>{
            await page.evaluate(()=>window.__renderSky('loading')); await page.getByRole('status').waitFor();
            await screenshot(page,'loading');
            await page.evaluate(()=>window.__renderSky('empty')); await page.getByRole('heading',{name:'Start with a category'}).waitFor();
            await page.getByRole('button',{name:'Categories →',exact:true}).click();
            assert.equal(await page.evaluate(()=>window.__clicks.at(-1)),'all');
            return {screenshot:await screenshot(page,'empty')};
          });
        }
        await page.close();
      }
    }
    await step('WebGL unavailable on startup still permits navigation',async()=>{
      const page=await browser.newPage({viewport:{width:1260,height:840},reducedMotion:'reduce'});
      const errors=[];page.on('pageerror',error=>errors.push(error.message));
      await page.addInitScript(()=>{
        const original=HTMLCanvasElement.prototype.getContext;
        HTMLCanvasElement.prototype.getContext=function(type,...args){return type==='webgl'||type==='webgl2'||type==='experimental-webgl'?null:original.call(this,type,...args);};
      });
      try {
        await page.goto(baseUrl+'/reports/visual/v3.2.7-home/fixture.html');
        await page.locator('.sky-islands[data-status="fallback"]').waitFor();
        await page.locator('.sky-navigation-row > button').filter({hasText:'Engineering'}).focus();await page.keyboard.press('Enter');
        assert.equal(await page.evaluate(()=>window.__clicks.at(-1)),'folder-2');assert.deepEqual(errors,[]);
        return {errors,screenshot:await screenshot(page,'webgl-unavailable')};
      } finally { await page.close(); }
    });
    await step('real App category to Library and filter reset',async()=>{
      const page=await browser.newPage({viewport:{width:1260,height:840},reducedMotion:'reduce'});
      const errors=[];page.on('pageerror',error=>errors.push(error.message));
      await page.addInitScript(()=>{localStorage.setItem('ai-skillhub-lang','en');localStorage.setItem('skillhub-home-visual','islands');});
      try {
        await page.goto(baseUrl+'/?theme=atlas-light'); await ready(page);
        await screenshot(page,'real-app-1260-home');
        const search=page.locator('.topbar input').first();
        await search.fill('unrelated-no-results');
        const paper=page.locator('.sky-island-label').filter({hasText:'Paper 写作'});
        await paper.focus();await page.keyboard.press('Enter');
        await page.locator('.library-tree').waitFor();
        assert.equal(await search.inputValue(),'');
        assert.ok((await page.locator('.skill-folder-target.active').innerText()).includes('Paper 写作'));
        assert.equal(await page.locator('.skill-folder-target.active b').innerText(),'3');
        assert.ok(await page.locator('.source-group.expanded').count()>0);
        const grouped=await page.locator('.source-group-title strong').allTextContents();
        await screenshot(page,'real-app-paper-library');
        await page.locator('.nav-item').filter({hasText:'Dashboard'}).click();await ready(page);
        await page.locator('.nav-item').filter({hasText:'Skill Library'}).click();
        assert.ok((await page.locator('.skill-folder-target.active').innerText()).includes('All Skills'));
        await page.locator('.nav-item').filter({hasText:'Dashboard'}).click();await ready(page);
        const empty=page.locator('.sky-island-label').filter({hasText:'文献调研 / Idea'});
        await empty.focus();await page.keyboard.press('Space');await page.locator('.library-tree').waitFor();
        assert.ok((await page.locator('.skill-folder-target.active').innerText()).includes('文献调研 / Idea'));
        assert.equal(await page.locator('.source-group').count(),0);
        await search.fill('nature');await search.press('Enter');
        assert.ok((await page.locator('.skill-folder-target.active').innerText()).includes('All Skills'));
        assert.deepEqual(errors,[]);
        return {grouped,errors,keyboard:'Enter populated folder; Space empty folder; sidebar and global-search reset all'};
      } finally { await page.close(); }
    });
  } finally {
    await browser.close();
    fs.writeFileSync(path.join(reportDir,screenshotOnly?'final-screenshots-report.json':'report.json'),JSON.stringify({browser:'Edge via Playwright; Browser plugin not available',results,failures},null,2));
  }
  console.log(`${results.length} passed; ${failures.length} failed. ${reportDir}`);
  if(failures.length) process.exitCode=1;
})().catch(error=>{console.error(error);process.exitCode=1;});
