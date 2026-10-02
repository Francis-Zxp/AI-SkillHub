// Real canvas motion under a dense fixture; no desktop/user-data access.
const {chromium}=require('playwright');
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const out=path.resolve('reports/visual/v3.2.12-universe');fs.mkdirSync(out,{recursive:true});
const base='http://127.0.0.1:1421/';
const fixture=fs.readFileSync('scripts/v3.2.11-labels-qa.cjs','utf8').match(/const fixture=`([\s\S]*?)`;fs/)[1];
fs.writeFileSync(path.join(out,'dense.html'),fixture);
const baseline=path.resolve('../reports/backups/v3.2.12/universe');
if(fs.existsSync(baseline)) {
 for(const name of ['SkillUniverse.tsx','universeLabels.ts','universeAtmosphere.ts']) {
  let src=fs.readFileSync(path.join(baseline,name),'utf8').replaceAll('"./','"/src/');
  for(const helper of ['universeLabels','universeAtmosphere'])src=src.replace(`"/src/${helper}"`,`"./${helper}.ts"`);
  fs.writeFileSync(path.join(out,name),src);
 }
 fs.writeFileSync(path.join(out,'baseline.html'),fixture.replace("from'/src/SkillUniverse.tsx'","from'./SkillUniverse.tsx'"));
}
(async()=>{
 const browser=await chromium.launch({channel:'chrome',args:['--use-angle=d3d11']});const results=[];
 try {
  for(const width of [1920,3840]) for(const variant of fs.existsSync(baseline)?['baseline','dense']:['dense']) {
   const page=await browser.newPage({viewport:{width,height:width*9/16},deviceScaleFactor:1});const errors=[];
   page.on('pageerror',e=>errors.push(e.message));
   await page.addInitScript(()=>{
    window.framesSeen=[];window.measures=0;window.backgroundPaints=0;
    const proto=CanvasRenderingContext2D.prototype,clear=proto.clearRect,fill=proto.fillText,measure=proto.measureText;
    proto.clearRect=function(...a){
     if(this.canvas.classList.contains('skill-universe-canvas')){
      if(window.drawFrame)window.framesSeen.push(window.drawFrame);window.drawFrame={time:performance.now(),labels:{}};
      const labelFrame=window.drawFrame;
      queueMicrotask(()=>{for(const e of document.querySelectorAll('.skill-universe-label')){
       const matrix=new DOMMatrix(e.style.transform);
       labelFrame.labels[e.dataset.nodeId]={x:matrix.m41,y:matrix.m42,alpha:Number(e.style.opacity)};
      }});
     }
     if(this.canvas.classList.contains('skill-universe-atmosphere'))window.backgroundPaints++;
     return clear.apply(this,a);
    };
    proto.fillText=function(text,x,y,...a){if(this.canvas.classList.contains('skill-universe-canvas'))window.drawFrame.labels[text]={x,y,alpha:this.globalAlpha};return fill.call(this,text,x,y,...a)};
    proto.measureText=function(...a){if(this.canvas.classList.contains('skill-universe-canvas'))window.measures++;return measure.apply(this,a)};
   });
   await page.goto(base+'reports/visual/v3.2.12-universe/'+variant+'.html');await page.bringToFront();await page.waitForTimeout(2200);
   await page.evaluate(()=>{window.framesSeen=[];window.measures=0;window.backgroundPaints=0});await page.waitForTimeout(2000);
   const ambient=await page.evaluate(()=>({frames:window.framesSeen.length,measures:window.measures,backdrop:window.backgroundPaints}));
   await page.evaluate(()=>{window.framesSeen=[];window.measures=0});
   await page.mouse.move(width*.5,width*9/16*.5);await page.mouse.down();
   await page.evaluate(()=>new Promise(resolve=>{const c=document.querySelector('.skill-universe-canvas'),r=c.getBoundingClientRect(),start=performance.now();let lastX=Math.round(r.width*.5),lastY=Math.round(r.height*.5);function move(now){const elapsed=now-start,x=r.width*.5+elapsed*.11,y=r.height*.5+elapsed*.04;c.dispatchEvent(new PointerEvent('pointermove',{bubbles:true,pointerId:1,buttons:1,clientX:r.x+x,clientY:r.y+y,movementX:x-lastX,movementY:y-lastY}));lastX=x;lastY=y;if(elapsed<2400)requestAnimationFrame(move);else resolve()}requestAnimationFrame(move)}));
   const motion=await page.evaluate(()=>{
    const f=window.framesSeen,dt=f.slice(1).map((x,i)=>x.time-f[i].time).sort((a,b)=>a-b);let jumps=0,samples=0,fractional=0;
    for(let i=2;i<f.length;i++)for(const [name,item]of Object.entries(f[i].labels)){
     const a=f[i-2].labels[name],b=f[i-1].labels[name];if(!a||!b||item.alpha<.4||b.alpha<.4||a.alpha<.4)continue;
     if(Math.hypot(item.x-2*b.x+a.x,item.y-2*b.y+a.y)>4)jumps++;samples++;
     if(Math.abs(item.x-Math.round(item.x))>.001)fractional++;
    }
    const travel=Object.entries(f[0]?.labels??{}).reduce((max,[name,a])=>{const b=f.at(-1)?.labels[name];return b?Math.max(max,Math.hypot(b.x-a.x,b.y-a.y)):max},0);return{travel,frames:f.length,p95:dt[Math.floor(dt.length*.95)],measures:window.measures,jumps,samples,fractional,diagnostics:{...document.querySelector('.skill-universe-canvas').dataset}};
   });
   await page.mouse.up();
   await page.evaluate(()=>{window.framesSeen=[]});await page.waitForTimeout(650);
   const coast=await page.evaluate(()=>({frames:window.framesSeen.length}));
   await page.mouse.move(1,1);await page.waitForTimeout(350);
   const selectedAfterDrag=await page.locator('.skill-universe-inspector').count();
   if(variant==='dense')assert.equal(selectedAfterDrag,0,'Dragging selected a node on pointerup');
   await page.mouse.click(1,1);
   await page.screenshot({path:path.join(out,`${variant}-${width}-night.png`)});
   console.log('METRICS',variant,width,JSON.stringify({ambient,motion,coast}));
   if(variant==='dense'){
    assert.ok(motion.travel>100,'The drag did not rotate the scene');
    assert.ok(motion.frames>=75,`Only ${motion.frames} interactive frames`);
    assert.ok(motion.fractional>motion.samples*.9,'Label movement was snapped to pixels');
    assert.ok(motion.jumps<=motion.samples*.01,'Label position acceleration has visible jumps');
    assert.equal(ambient.backdrop,0,'Static background repainted while rotating');
    assert.ok(ambient.measures<20,'Text was repeatedly remeasured');
   }
   assert.deepEqual(errors,[]);results.push({variant,width,ambient,motion,coast,errors});console.log(JSON.stringify(results.at(-1)));
   await page.close();
  }
 }finally{fs.writeFileSync(path.join(out,'results.json'),JSON.stringify(results,null,2));await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
