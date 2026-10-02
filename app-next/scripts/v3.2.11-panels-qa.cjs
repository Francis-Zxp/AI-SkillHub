// Render the real panels with a mocked Tauri boundary; never touches user configuration.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const out = path.resolve(__dirname, '../reports/visual/v3.2.11-panels');
const url = process.env.AI_SKILLHUB_PREVIEW_URL || 'http://127.0.0.1:1421/';
fs.mkdirSync(out, { recursive: true });
const fixture = `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="root"></div><script type="module">
import React from 'react';import{createRoot}from'react-dom/client';import{SourceIdentityPanel}from'/src/SourceIdentityPanel.tsx';import{McpRecipeCard}from'/src/McpRecipeCard.tsx';import{setLang}from'/src/i18n.ts';import'/src/styles.css';import'/src/sky-theme.css';
const query=new URLSearchParams(location.search),mode=query.get('mode')||'aligned';setLang(query.get('lang')||'zh');
const entries=Array.from({length:18},(_,i)=>({sourceId:'source-'+i,repo:'research-project-'+i,owner:'example-author',folder:'project-'+i,identity:'author/project-'+i,currentParent:'old-project-'+i,targetParent:'project-'+i+'--example-author',action:'rename',reasons:[]}));
const commands=['mkOPX app:=\\"Origin MCP Bridge Start\\" opx:=\\"C:/Users/Example User/AppData/Local/OriginLab/Apps/Origin MCP Bridge Start.opx\\";', 'mkOPX app:=\\"Origin MCP Bridge Stop\\" opx:=\\"C:/Users/Example User/AppData/Local/OriginLab/Apps/Origin MCP Bridge Stop.opx\\";'];
const status={recipeId:'origin-mcp',packageVersion:'0.1.4',state:mode==='install-error'?'not-installed':'needs-origin',nextStep:mode==='install-error'?'install':mode==='open-origin'?'open-origin':'register-app',steps:[{id:'origin',status:'user',detail:'Origin has not started'},{id:'runtime',status:'ok',detail:'Python isolated runtime installed'}],basePython:'python',runtimePython:'C:/SkillHub/python.exe',installedVersion:'0.1.4',appStaged:true,mkopxCommands:commands,clients:[],verificationStale:true,failure:mode==='failure'?'Origin Bridge is not responding':''};
window.calls=[];let detectCount=0;
window.__TAURI_INTERNALS__={invoke:async(command,args)=>{window.calls.push(command);if(command==='plan_source_identity_migration')return mode==='renames'?{entries:[...entries,{...entries[0],sourceId:'blocked',action:'blocked',reasons:['存在本地修改，请先检查']}],renameCount:18,alignedCount:39,attentionCount:1,interrupted:false}:{entries:[],renameCount:0,alignedCount:57,attentionCount:0,interrupted:false};if(command==='detect_mcp_recipe'){if(mode==='detect-error'&&detectCount++===0)throw Error('检测暂时失败');return status;}if(command==='list_mcp_mutation_targets')return[{hostId:'host-codex',scope:'user',pathDisplay:'~/.codex/config.toml'}];if(command==='install_mcp_recipe')throw Error('下载失败：请重试');if(command==='verify_mcp_recipe')return{...status,state:'ready',nextStep:'none',failure:'',verificationStale:false,verification:{verifiedAt:'2026-10-02',toolCount:25,originPingOk:true}};throw Error('Unexpected mock command '+command);}};
window.panelErrors=[];
createRoot(document.getElementById('root')).render(React.createElement('main',{className:'theme-'+(query.get('theme')||'sky-night'),style:{padding:24,minHeight:'100vh',background:'var(--bg)',color:'var(--text)',display:'grid',alignContent:'start',gap:24}},React.createElement(SourceIdentityPanel,{runtimeAvailable:true,disabled:false,onApplied:()=>{},onError:e=>window.panelErrors.push(e)}),React.createElement(McpRecipeCard,{runtimeAvailable:true,onConfigChanged:()=>{}})));
</script></body></html>`;
fs.writeFileSync(path.join(out, 'panels.html'), fixture);
const results=[];
async function check(name, fn) {try{results.push({name,passed:true,detail:await fn()});console.log('PASS',name);}catch(e){results.push({name,passed:false,error:e.stack});console.error('FAIL',name,e.message);}}
(async()=>{
const browser=await chromium.launch({channel:'chrome'});
try{
 const context=await browser.newContext({permissions:['clipboard-read','clipboard-write']});
 const page=await context.newPage();const errors=[];page.on('pageerror',e=>errors.push(e.message));
 async function go(mode='aligned',theme='sky-night',width=1260,lang='zh') {await page.setViewportSize({width,height:900});await page.goto(url+'reports/visual/v3.2.11-panels/panels.html?'+new URLSearchParams({mode,theme,lang}));await page.locator('.identity-stats dd').first().waitFor();await page.waitForTimeout(100);}
 for (const [width,theme,lang] of [[1260,'sky-night','zh'],[760,'sky-noon','zh'],[1440,'sky-dusk','en']]) {
  await go('aligned',theme,width,lang);
  await check('aligned values share baseline '+width,()=>page.locator('.identity-stats dd').evaluateAll(items=>{const y=items.map(e=>e.getBoundingClientRect().y);if(Math.max(...y)-Math.min(...y)>1)throw Error('Numbers not aligned');return y;}));
  await check('instructions default closed '+width,async()=>{assert.equal(await page.locator('.identity-explainer').getAttribute('open'),null);assert.equal(await page.locator('.recipe-guide-disclosure').getAttribute('open'),null);});
  await page.locator('.recipe-guide-disclosure summary').click();
  await check('commands wrap without page overflow '+width,()=>page.evaluate(()=>{if(document.documentElement.scrollWidth>innerWidth)throw Error('Page overflow');const codes=[...document.querySelectorAll('.recipe-command code')];for(const e of codes)if(e.scrollWidth>e.clientWidth+1)throw Error('Code overflow');return codes.map(e=>({width:e.clientWidth,height:e.clientHeight}));}));
  await page.locator('.recipe-command button').first().click();
  await check('copy retains full command '+width,async()=>assert.equal(await page.evaluate(()=>navigator.clipboard.readText()),await page.locator('.recipe-command code').first().textContent()));
  await page.screenshot({path:path.join(out,'panels-'+width+'-'+theme+'.png'),fullPage:true});
 }
 await go('renames');
 await check('rename list starts collapsed',async()=>assert.equal(await page.locator('.identity-list').isVisible(),false));
 await check('attention remains visible while collapsed',async()=>assert.equal(await page.getByText('存在本地修改，请先检查').isVisible(),true));
 await page.getByRole('button',{name:'展开全部',exact:true}).click();
 await check('all renames are scrollable',()=>page.locator('.identity-list').evaluate(e=>{if(e.childElementCount!==18||e.clientHeight>340||e.scrollHeight<=e.clientHeight)throw Error('List not bounded');return{rows:e.childElementCount,height:e.clientHeight,total:e.scrollHeight};}));
 await page.getByRole('button',{name:'收起',exact:true}).click();
 await check('rename list closes again',async()=>assert.equal(await page.locator('.identity-list').isVisible(),false));
 await go('detect-error');
 await check('failed initial detection provides retry',async()=>{assert.equal(await page.locator('.recipe-error').isVisible(),true);assert.equal(await page.locator('.recipe-actions').getByRole('button',{name:'重新检测'}).isEnabled(),true);});
 await page.locator('.recipe-actions').getByRole('button',{name:'重新检测'}).click();
 await check('retry recovers initial detection',async()=>{await page.getByText('待注册 App',{exact:true}).waitFor();assert.equal(await page.locator('.recipe-error').count(),0);});
 await go('install-error');await page.getByRole('button',{name:'安装并连接',exact:true}).click();
 await check('installation error survives status recheck',async()=>{await page.getByText('Error: 下载失败：请重试',{exact:true}).waitFor();assert.equal(await page.locator('.recipe-error').isVisible(),true);});
 await go('failure');
 await check('backend failure visible with details closed',async()=>assert.equal(await page.getByText('Origin Bridge is not responding',{exact:true}).isVisible(),true));
 await go('open-origin');
 await check('not running explains opening Origin',async()=>assert.match(await page.locator('.recipe-next').textContent(),/打开 Origin/));
 await page.getByRole('button',{name:'验证连接',exact:true}).click();
 await check('registration and open-Origin states can verify directly',async()=>{await page.getByText('可用',{exact:true}).waitFor();assert.equal(await page.evaluate(()=>window.calls.filter(c=>c==='verify_mcp_recipe').length),1);});
 await check('no unhandled browser errors',async()=>assert.deepEqual(errors,[]));
 await context.close();
}finally{await browser.close();fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));}
if(results.some(r=>!r.passed))process.exitCode=1;
})().catch(e=>{console.error(e);process.exitCode=1;});
