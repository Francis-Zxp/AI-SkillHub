// Exercise the real card with an isolated IPC boundary; no user config writes.
const { chromium } = require('playwright');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const out = path.resolve(__dirname, '../reports/visual/v3.2.12-origin');
fs.mkdirSync(out, { recursive: true });
const fixture = `<!doctype html><html><body><div id="root"></div><script type="module">
import React from 'react';import{createRoot}from'react-dom/client';import{McpRecipeCard}from'/src/McpRecipeCard.tsx';import{setLang}from'/src/i18n.ts';import'/src/styles.css';import'/src/sky-theme.css';
setLang('zh');const mode=new URLSearchParams(location.search).get('mode');
const status={recipeId:'origin-mcp',packageVersion:'0.1.4',state:'needs-origin',nextStep:mode==='start'?'start-bridge':'register-app',steps:[],runtimePython:'C:/test/python.exe',installedVersion:'0.1.4',appStaged:true,appRegistered:mode==='start',mkopxCommands:['mkOPX app:="Origin MCP Bridge Start";'],clients:[],verificationStale:true,failure:''};
window.calls=[];window.__TAURI_INTERNALS__={invoke:async(command,args)=>{window.calls.push({command,args});if(command==='detect_mcp_recipe')return status;if(command==='list_mcp_mutation_targets')return[];if(command==='prepare_origin_bridge')return new Promise((resolve,reject)=>{window.finishBridge=()=>mode==='error'?reject(Error('等待 Origin 注册确认超时')):resolve({...status,state:'ready',nextStep:'none',appRegistered:true,verificationStale:false,verification:{verifiedAt:'2026-10-03',toolCount:25,originPingOk:true,bridgeState:'running'}})});throw Error('Unexpected IPC '+command)}};
createRoot(document.getElementById('root')).render(React.createElement('main',{className:'theme-sky-night',style:{padding:24,minHeight:'100vh',background:'var(--bg)',color:'var(--text)'}},React.createElement(McpRecipeCard,{runtimeAvailable:true,onConfigChanged:()=>{throw Error('Bridge operation must not change client config')}})));
</script></body></html>`;
fs.writeFileSync(path.join(out, 'fixture.html'), fixture);
const results = [];
async function check(name, action) { await action(); results.push({name, passed:true}); console.log('PASS', name); }
(async () => {
  const browser = await chromium.launch({ channel:'chrome' });
  try {
    const page = await browser.newPage({ viewport:{width:1120,height:850} });
    const errors=[];page.on('pageerror', e=>errors.push(e.message));
    for (const mode of ['register','start','error']) {
      await page.goto((process.env.AI_SKILLHUB_PREVIEW_URL||'http://127.0.0.1:1421/')+'reports/visual/v3.2.12-origin/fixture.html?mode='+mode);
      const label=mode==='start'?'启动并验证':'注册并启动';
      const action=page.getByRole('button',{name:label,exact:true});await action.waitFor();
      await check(mode+' has explicit action',async()=>assert.equal(await action.isEnabled(),true));
      await action.click();
      await check(mode+' invokes only fixed bridge action',async()=>{
        const calls=await page.evaluate(()=>window.calls.filter(c=>c.command==='prepare_origin_bridge'));
        assert.equal(calls.length,1);assert.equal(calls[0].args===undefined||Object.keys(calls[0].args).length===0,true);
        assert.equal(await page.evaluate(()=>window.calls.some(c=>['apply_mcp_plan','install_mcp_recipe'].includes(c.command))),false);
      });
      await check(mode+' busy disables repeat and explains native prompt',async()=>{
        assert.equal(await page.getByRole('button',{name:'正在连接 Origin…',exact:true}).isDisabled(),true);
        assert.match(await page.getByRole('status').textContent(),/Origin.*全部跳过/);
      });
      await page.screenshot({path:path.join(out,mode+'-pending.png')});
      await page.evaluate(()=>window.finishBridge());
      if(mode==='error'){
        await page.getByRole('alert').waitFor();
        await check('timeout survives automatic recheck and supports retry',async()=>{
          assert.match(await page.getByRole('alert').textContent(),/注册确认超时/);
          assert.equal(await page.getByRole('button',{name:label,exact:true}).isEnabled(),true);
          assert.equal(await page.evaluate(()=>window.calls.filter(c=>c.command==='detect_mcp_recipe').length),2);
        });
      }else{
        await page.getByText('可用',{exact:true}).waitFor();
        await check(mode+' successful ping response reaches ready',async()=>assert.equal(await page.getByRole('button',{name:'再次验证',exact:true}).isVisible(),true));
      }
    }
    await check('no browser errors',async()=>assert.deepEqual(errors,[]));
  } finally {
    await browser.close();fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));
  }
})().catch(e=>{console.error(e);process.exitCode=1});
