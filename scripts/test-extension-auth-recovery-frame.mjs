import assert from 'node:assert/strict';
import { existsSync, readFileSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const nonce = 'a'.repeat(64);
const extensionRoot = process.env.CLASSPILOT_EXTENSION_PATH || fileURLToPath(new URL('../extension/', import.meta.url));
const extensionVersion=JSON.parse(readFileSync(resolve(extensionRoot,'manifest.json'),'utf8')).version;
const supportFixture = { extensionVersion, timestamp: 1790343901622, elapsedMs: 9000, startupPhase: 'recovery_clear', restoreOutcome: 'failed',
  failureClass: 'AUTH_GATE_UNAVAILABLE', attemptCount: 2, retryInMs: 2000, pending: true,
  firstFailure: { startupPhase: 'auth_snapshot', failureClass: 'STORAGE_IO_ERROR', timestamp: 1000 } };
const files = new Map(['auth-recovery-diagnostics.js','auth-gate-transport.js','auth-gate-frame.js','auth-gate-frame.css','page-lifecycle.js','auth-gate-bootstrap.js','content.js']
  .map(name => [name, readFileSync(resolve(extensionRoot, name), 'utf8')]));
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://fixture.invalid');
  const name = url.pathname.slice(1);
  if (files.has(name)) { response.writeHead(200, { 'content-type': name.endsWith('.css') ? 'text/css' : 'text/javascript' }); response.end(files.get(name)); return; }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  if (url.pathname === '/bootstrap-support') {
    response.end(`<!doctype html><html><body><input id="page-draft"><button id="page-action">Underlying page</button><script>
      window.bootstrapFixture = { calls:0, clicks:0, mode:'failure', support:${JSON.stringify(supportFixture)} };
      document.querySelector('#page-action').onclick=()=>bootstrapFixture.clicks++;
      const eventSource=()=>({addListener(){},removeListener(){}});
      window.chrome={runtime:{id:'fixture-extension',getManifest:()=>({version:${JSON.stringify(extensionVersion)}}),
        onMessage:eventSource(),sendMessage(message,callback){bootstrapFixture.calls++;
          if(bootstrapFixture.mode==='hold')return;
          if(bootstrapFixture.mode==='ready'){callback?.({success:true,state:{phase:'authenticated',authRequired:false,revision:30}});return;}
          callback?.({success:false,errorCode:'AUTH_GATE_STARTUP_TIMEOUT',retryAt:Date.now()+2000,supportDetails:bootstrapFixture.support});}},
        storage:{onChanged:eventSource(),managed:{get:(_keys,callback)=>callback({fastAuthGateEnabled:true})}}};
      </script><script src="/auth-recovery-diagnostics.js"></script><script src="/auth-gate-transport.js"></script>
      <script src="/page-lifecycle.js"></script><script src="/auth-gate-bootstrap.js"></script></body></html>`);
    return;
  }
  if (url.pathname === '/real-parent') {
    response.end(`<!doctype html><html><body><input id="page-draft" value="protected draft"><script>
      window.parentFixture = { reloadCalls:0, messages:[] };
      const eventSource = () => ({ addListener(){}, removeListener(){} });
      window.chrome = { runtime: { id:'fixture-extension', getManifest:()=>({version:${JSON.stringify(extensionVersion)}}),
        getURL:path => path === 'auth-gate-frame.html' ? location.origin+'/frame?scenario=invalid' : location.origin+'/'+path,
        onMessage:eventSource(), sendMessage(message,callback) {
          parentFixture.messages.push(message.type);
          if(message.type==='classpilot-request-page-reload') {
            parentFixture.reloadCalls++; callback({success:false,errorCode:'AUTH_GATE_UNAVAILABLE'}); return;
          }
          if(message.type==='get-auth-state') { callback({success:true,state:{phase:'ready',authRequired:true,loginMethod:'email_id',revision:5,rosterContextGeneration:1}}); return; }
          callback?.({success:false});
        } }, storage: { onChanged:eventSource(), managed:{get:(_keys,callback)=>callback({})},
          local:{get:(_keys,callback)=>callback({})}, session:{get:(_keys,callback)=>callback({})} } };
      </script><script src="/auth-recovery-diagnostics.js"></script><script src="/auth-gate-transport.js"></script><script src="/page-lifecycle.js"></script>
      <script src="/auth-gate-bootstrap.js"></script><script src="/content.js"></script></body></html>`);
    return;
  }
  if (url.pathname === '/frame') {
    response.end(`<!doctype html><html><head><link rel="stylesheet" href="/auth-gate-frame.css"></head><body><div id="classpilot-auth-gate"></div><script>
      const scenario = new URL(location.href).searchParams.get('scenario');
      window.fixture = {
        calls: [], stateCallbacks: [], rosterCallbacks: [], diagnostics: [],
        stateMode: scenario === 'missing'||scenario.startsWith('initial-failure') ? 'hold' : scenario === 'invalid' ? 'throw' : 'normal',
        rosterMode: scenario === 'roster' ? 'hold' : 'normal',
        state: { phase:'ready', authRequired:true, loginMethod:scenario === 'roster' ? 'name_pin' : 'email_id', revision:5, rosterContextGeneration:1 },
      };
      window.ClassPilotAuthRecoveryDiagnostics = { record: event => fixture.diagnostics.push(event) };
      window.chrome = {runtime:{ id:'fixture-extension', getManifest:()=>({version:${JSON.stringify(extensionVersion)}}), lastError:null, onMessage:{addListener(fn){fixture.broadcast=fn;}}, sendMessage(message, callback){
        fixture.calls.push({type:message.type,reason:message.reason});
        if(message.type==='manual-student-login'){fixture.manualCallback=callback;fixture.stateMode='pending';return;}
        if(message.type==='get-login-roster'){
          if(fixture.rosterMode==='hold'){fixture.rosterCallbacks.push(callback);return;}
          callback({success:true,grades:[],students:[]});return;
        }
        if(message.type==='get-auth-state'||message.type==='refresh-auth-state'){
          if(fixture.stateMode==='throw')throw new Error('Extension context invalidated: secret');
          if(fixture.stateMode==='hold'){fixture.stateCallbacks.push(callback);return;}
          if(fixture.stateMode==='pending'){callback({success:false,errorCode:'AUTH_GATE_LOGIN_PENDING',retryAt:Date.now()+2000});return;}
          callback({success:true,state:fixture.state});return;
        }
        callback({success:false});
      }}};
      </script><script src="/auth-recovery-diagnostics.js"></script><script src="/auth-gate-transport.js"></script><script src="/auth-gate-frame.js"></script></body></html>`);
    return;
  }
  response.end(`<!doctype html><html><body style="margin:0"><iframe id="gate" style="width:100vw;height:100vh;border:0;display:block" src="/frame?scenario=${encodeURIComponent(url.searchParams.get('scenario') || 'normal')}#${nonce}"></iframe><script>
    window.messages=[];addEventListener('message',event=>messages.push(event.data));
    document.getElementById('gate').addEventListener('load',()=>document.getElementById('gate').contentWindow.postMessage({type:'CLASSPILOT_AUTH_FRAME_INIT',nonce:'${nonce}',${url.searchParams.get('scenario')?.startsWith('initial-failure')?`initialFailure:{code:${JSON.stringify(url.searchParams.get('scenario')==='initial-failure-invalid'?'private-token@example.invalid <img src=x>':'AUTH_GATE_STARTUP_TIMEOUT')},retryAt:Date.now()+2000,supportDetails:${JSON.stringify(supportFixture)}},`:''}},location.origin));
  </script></body></html>`);
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const origin = `http://127.0.0.1:${server.address().port}`;
const configured = process.env.CLASSPILOT_CHROME_PATH;
const executablePath = [configured, chromium.executablePath(), 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find(path => path && existsSync(path));
if (!executablePath) throw new Error('A Chromium executable is required for auth recovery frame tests');
const browser = await chromium.launch({ executablePath, headless: true, args: ['--disable-background-networking'] });
let passed = 0;
async function scenario(name, mode, run) {
  const page = await browser.newPage();
  try {
    await page.clock.install({ time: new Date('2030-01-01T00:00:00Z') });
    await page.clock.pauseAt(new Date('2030-01-01T00:00:01Z'));
    await page.goto(`${origin}/?scenario=${mode}`);
    const frame = page.frames().find(item => item.url().startsWith(`${origin}/frame`));
    assert.ok(frame, 'frame exists');
    await frame.waitForSelector('.classpilot-auth-panel');
    await run(page, frame);
    passed += 1; console.log(`PASS ${name}`);
  } finally { await page.close(); }
}
const phase = frame => frame.locator('#classpilot-auth-gate').getAttribute('data-classpilot-auth-phase');
const click = (frame, selector) => frame.locator(selector).evaluate(element => element.click());
async function supportScreenshot(page, name) {
  const directory = process.env.CLASSPILOT_AUTH_RECOVERY_SCREENSHOT_DIR;
  if (!directory) return;
  mkdirSync(directory, { recursive:true });
  const path=resolve(directory, name+'.png');
  await page.screenshot({path});
  console.log(`Support screenshot: ${path}`);
}
async function submit(frame) {
  await frame.evaluate(() => {
    document.getElementById('classpilot-auth-email').value = 'student@example.invalid';
    document.getElementById('classpilot-auth-student-id').value = 'fixture-id';
    document.getElementById('classpilot-auth-email-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}
try {
  await scenario('IT details survive parent handover and retry repaint; copy is bounded and can fall back to selection', 'initial-failure', async (page, frame) => {
    await page.setViewportSize({width:800,height:600});
    assert.equal(await frame.locator('#classpilot-auth-title').textContent(), 'ClassPilot is still starting');
    await click(frame, '#classpilot-auth-it-summary');
    await frame.locator('#classpilot-auth-copy-diagnostics').scrollIntoViewIfNeeded();
    const supportLayout=await frame.locator('#classpilot-auth-it-details').evaluate(node=>({
      overflow:node.scrollWidth>node.clientWidth,
      footerPosition:getComputedStyle(document.querySelector('.classpilot-auth-footnote')).position,
    }));
    assert.deepEqual(supportLayout,{overflow:false,footerPosition:'static'});
    await supportScreenshot(page, 'classpilot-support-secure-frame-800x600');
    const text = await frame.locator('#classpilot-auth-it-text').inputValue();
    assert.match(text, /First failure: auth_snapshot \/ STORAGE_IO_ERROR/);
    await frame.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable:true,
      value:{writeText:async text=>{fixture.copied=text;}} }));
    await click(frame, '#classpilot-auth-copy-diagnostics');
    assert.equal(await frame.evaluate(() => fixture.copied), text);
    assert.equal(await frame.locator('#classpilot-auth-copy-status').textContent(), 'Diagnostics copied.');
    await frame.locator('#classpilot-auth-it-text').focus();
    await frame.evaluate(() => {
      document.querySelector('#classpilot-auth-it-text').setSelectionRange(0, 12);
      fixture.broadcast({type:'CLASSPILOT_AUTH_REQUIRED',state:{phase:'unavailable',authRequired:true,revision:20,
        errorCode:'AUTH_GATE_STARTUP_TIMEOUT',supportDetails:{extensionVersion:'2.9.4',startupPhase:'recovery_clear',
          restoreOutcome:'failed',failureClass:'AUTH_GATE_UNAVAILABLE',attemptCount:3,pending:true,
          firstFailure:{startupPhase:'auth_snapshot',failureClass:'STORAGE_IO_ERROR',timestamp:1000,message:'private-token'},
          studentToken:'private-token'}}},{id:'fixture-extension'});
    });
    assert.equal(await frame.locator('#classpilot-auth-it-details').evaluate(node=>node.open), true);
    assert.equal(await frame.evaluate(()=>document.activeElement.id), 'classpilot-auth-it-text');
    assert.equal(await frame.locator('#classpilot-auth-it-text').evaluate(node=>node.selectionEnd), 12);
    assert.equal((await frame.locator('#classpilot-auth-it-text').inputValue()).includes('private'), false);
    await frame.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable:true,
      value:{writeText:async()=>{throw new Error('denied');}} }));
    await click(frame, '#classpilot-auth-copy-diagnostics');
    assert.equal(await frame.locator('#classpilot-auth-copy-status').textContent(), 'Select and copy the details above.');
    assert.equal(await frame.evaluate(()=>document.activeElement.id), 'classpilot-auth-it-text');
    await frame.evaluate(()=>{fixture.stateMode='normal';fixture.state.revision=30;});
    await click(frame,'#classpilot-auth-retry');
    assert.equal(await phase(frame),'ready');
    assert.equal(await frame.locator('#classpilot-auth-it-details').count(),0);
  });
  await scenario('a silent worker exposes only local connection evidence in IT details', 'missing', async (page, frame) => {
    await page.clock.runFor(10_010);
    const text=await frame.locator('#classpilot-auth-it-text').inputValue();
    assert.match(text,/Startup step: worker_unavailable/);
    assert.match(text,/AUTH_GATE_RPC_TIMEOUT/);
    assert.match(text,/Page request elapsed: 10000 ms/);
    assert.doesNotMatch(text,/Restore:|Recovery attempt:|Operation pending:|Retry in:/);
    assert.equal(text.includes('First failure:'),false);
  });
  {
    const page=await browser.newPage({viewport:{width:800,height:600}});
    try {
      await page.clock.install({ time: new Date('2030-01-01T00:00:00Z') });
      await page.clock.pauseAt(new Date('2030-01-01T00:00:01Z'));
      await page.goto(`${origin}/bootstrap-support`);
      await page.locator('#classpilot-auth-it-summary').waitFor();
      await page.locator('#classpilot-auth-it-summary').click({force:true});
      await page.locator('#classpilot-auth-copy-diagnostics').scrollIntoViewIfNeeded();
      const fallbackLayout=await page.locator('.classpilot-auth-panel').evaluate(node=>({
        top:node.getBoundingClientRect().top,bottom:node.getBoundingClientRect().bottom,
        viewport:innerHeight,overflow:node.scrollWidth>node.clientWidth,
      }));
      assert.ok(fallbackLayout.top>=0&&fallbackLayout.bottom<=fallbackLayout.viewport);
      assert.equal(fallbackLayout.overflow,false);
      await supportScreenshot(page, 'classpilot-support-bootstrap-800x600');
      assert.equal(await page.locator('#classpilot-auth-it-details').evaluate(node=>node.open),true);
      assert.match(await page.locator('#classpilot-auth-it-text').inputValue(),/STORAGE_IO_ERROR/);
      await page.evaluate(()=>Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{bootstrapFixture.copied=value;}}}));
      await page.locator('#classpilot-auth-copy-diagnostics').click({force:true});
      assert.match(await page.evaluate(()=>bootstrapFixture.copied),/First failure: auth_snapshot \/ STORAGE_IO_ERROR/);
      assert.equal(await page.locator('#classpilot-auth-copy-status').textContent(),'Diagnostics copied.');
      const original=await page.evaluate(()=>bootstrapFixture.copied);
      await page.evaluate(()=>{document.querySelector('#classpilot-auth-it-text').value='private-host-page-injection';});
      await page.locator('#classpilot-auth-copy-diagnostics').click({force:true});
      assert.equal(await page.evaluate(()=>bootstrapFixture.copied),original,'the host page cannot replace the copied diagnostic snapshot');
      assert.equal(await page.evaluate(()=>bootstrapFixture.clicks),0);
      await assert.rejects(page.locator('#page-action').click({timeout:250}));
      await page.evaluate(()=>{bootstrapFixture.mode='hold';});
      await page.locator('.classpilot-auth-bootstrap-retry').click({force:true});
      await page.clock.runFor(10_010);
      const timedOut=await page.locator('#classpilot-auth-it-text').inputValue();
      assert.match(timedOut,/Startup step: worker_unavailable/);
      assert.match(timedOut,/First failure: auth_snapshot \/ STORAGE_IO_ERROR/);
      assert.doesNotMatch(timedOut,/Restore:|Recovery attempt:|Operation pending:|Retry in:/);
      await page.evaluate(()=>{bootstrapFixture.mode='ready';});
      await page.locator('.classpilot-auth-bootstrap-retry').click({force:true});
      assert.equal(await page.locator('#classpilot-auth-it-details').count(),0);
      passed++;console.log('PASS bootstrap fallback exposes copyable support while the underlying page stays protected');
    } finally {await page.close();}
  }
  await scenario('a bounded parent startup failure is visible immediately without a second worker deadline','initial-failure',async(page,frame)=>{
    assert.equal(await phase(frame),'unavailable');
    assert.equal(await frame.locator('#classpilot-auth-support-code').textContent(),'Support code: AUTH_GATE_STARTUP_TIMEOUT');
    assert.equal(await frame.evaluate(()=>fixture.calls.length),0,'frame must not discard the parent failure then wait for another RPC');
    await click(frame,'#classpilot-auth-retry');
    assert.equal(await frame.evaluate(()=>fixture.calls.length),1);
    assert.equal(await frame.locator('#classpilot-auth-support-code').textContent(),'Support code: AUTH_GATE_STARTUP_TIMEOUT');
    await page.clock.runFor(10_010);assert.equal(await phase(frame),'unavailable');
    const timedOut=await frame.locator('#classpilot-auth-it-text').inputValue();
    assert.match(timedOut,/Startup step: worker_unavailable/);
    assert.match(timedOut,/First failure: auth_snapshot \/ STORAGE_IO_ERROR/);
    assert.doesNotMatch(timedOut,/Restore:|Recovery attempt:|Operation pending:|Retry in:/);
    await frame.evaluate(()=>{fixture.stateMode='normal';});
    await click(frame,'#classpilot-auth-retry');assert.equal(await phase(frame),'ready');
    assert.equal(await frame.locator('#classpilot-auth-support-code').count(),0);
    await frame.evaluate(()=>fixture.broadcast({type:'CLASSPILOT_AUTH_REQUIRED',state:{phase:'unavailable',authRequired:true,
      revision:30,errorCode:'AUTH_GATE_RPC_TIMEOUT'}},{id:'fixture-extension'}));
    assert.equal((await frame.locator('#classpilot-auth-it-text').inputValue()).includes('First failure:'),false,
      'successful recovery clears the previous first failure');
  });
  await scenario('unknown initial failure is redacted and ordinary retry respects the supplied bounded backoff','initial-failure-invalid',async(page,frame)=>{
    assert.equal(await phase(frame),'unavailable');
    assert.equal(await frame.locator('#classpilot-auth-support-code').textContent(),'Support code: AUTH_GATE_UNAVAILABLE');
    assert.equal(await frame.evaluate(()=>document.body.textContent.includes('private')),false);
    await page.clock.runFor(1_999);assert.equal(await frame.evaluate(()=>fixture.calls.length),0);
    await page.clock.runFor(1);assert.equal(await frame.evaluate(()=>fixture.calls.length),1);
    assert.equal(await frame.locator('#classpilot-auth-support-code').textContent(),'Support code: AUTH_GATE_UNAVAILABLE');
    await page.clock.runFor(5_000);assert.equal(await frame.evaluate(()=>fixture.calls.length),1,'backoff and polling must not duplicate the active RPC');
  });
  await scenario('missing state callback restores Retry and ignores late auth proof', 'missing', async (page, frame) => {
    await page.clock.runFor(10_010);
    assert.equal(await phase(frame), 'unavailable');
    assert.equal(await frame.locator('#classpilot-auth-retry').isEnabled(), true);
    assert.equal(await frame.locator('#classpilot-auth-support-code').textContent(),'Support code: AUTH_GATE_RPC_TIMEOUT');
    await click(frame,'#classpilot-auth-retry');
    assert.match(await frame.locator('#classpilot-auth-retry').textContent(),/Connecting/);
    assert.equal(await frame.locator('#classpilot-auth-support-code').textContent(),'Support code: AUTH_GATE_RPC_TIMEOUT');
    await page.clock.runFor(10_010);
    await frame.evaluate(() => fixture.stateCallbacks[0]({success:true,state:{phase:'authenticated',authRequired:false,revision:8}}));
    assert.equal(await phase(frame), 'unavailable');
    await frame.evaluate(() => { fixture.stateMode = 'normal'; });
    await click(frame, '#classpilot-auth-retry');
    assert.equal(await phase(frame), 'ready');
    assert.equal(await frame.locator('#classpilot-auth-support-code').count(),0);
    assert.equal(await frame.evaluate(() => fixture.calls.at(-1).reason), 'user');
  });

  await scenario('roster deadline leaves a usable recovery action and fences old names', 'roster', async (page, frame) => {
    await frame.waitForFunction(() => fixture.rosterCallbacks.length > 0);
    await page.clock.runFor(10_010);
    assert.equal(await phase(frame), 'unavailable', JSON.stringify(await frame.evaluate(() => ({calls:fixture.calls,diagnostics:fixture.diagnostics,status:document.getElementById('classpilot-auth-roster-status')?.textContent}))));
    await frame.evaluate(() => fixture.rosterCallbacks[0]({success:true,grades:[{value:'5',label:'old grade'}]}));
    assert.equal(await phase(frame), 'unavailable');
    assert.equal(await frame.locator('#classpilot-auth-retry').isEnabled(), true);
  });

  await scenario('invalidated context uses a nonce-bound explicit reload action', 'invalid', async (page, frame) => {
    assert.equal(await phase(frame), 'unavailable');
    assert.equal(await frame.locator('#classpilot-auth-reload').isEnabled(), true);
    assert.equal(await frame.locator('#classpilot-auth-support-code').textContent(),'Support code: AUTH_GATE_CONTEXT_INVALIDATED');
    await click(frame, '#classpilot-auth-reload');
    const request = await page.evaluate(() => messages.find(message => message.type === 'CLASSPILOT_AUTH_FRAME_RELOAD_REQUEST'));
    assert.deepEqual(Object.keys(request).sort(), ['nonce','requestId','type']);
    await page.evaluate(({request}) => document.getElementById('gate').contentWindow.postMessage({...request,type:'CLASSPILOT_AUTH_FRAME_RELOAD_RESULT',nonce:'wrong',success:true},location.origin), {request});
    assert.equal(await frame.locator('#classpilot-auth-reload').isEnabled(), false);
    await page.evaluate(({request}) => document.getElementById('gate').contentWindow.postMessage({...request,type:'CLASSPILOT_AUTH_FRAME_RELOAD_RESULT',success:false},location.origin), {request});
    await frame.waitForFunction(() => !document.getElementById('classpilot-auth-reload').disabled);
    assert.match(await frame.locator('#classpilot-auth-retry-status').textContent(), /browser’s Reload/);
    assert.equal(await frame.evaluate(() => JSON.stringify(fixture.diagnostics).includes('secret')), false);
  });

  {
    const page = await browser.newPage();
    try {
      await page.clock.install({ time: new Date('2030-01-01T00:00:00Z') });
      await page.clock.pauseAt(new Date('2030-01-01T00:00:01Z'));
      await page.goto(`${origin}/real-parent`);
      const frame = page.frames().find(item => item.url().startsWith(`${origin}/frame`));
      assert.ok(frame, 'actual content controller creates its frame');
      await frame.waitForSelector('#classpilot-auth-reload');
      const frameNonce = decodeURIComponent(new URL(frame.url()).hash.slice(1));
      // A page-origin sender and malformed IDs cannot trigger the worker action,
      // even when this test deliberately supplies the private fixture nonce.
      await page.evaluate(({nonce}) => postMessage({type:'CLASSPILOT_AUTH_FRAME_RELOAD_REQUEST',nonce,requestId:1},location.origin), {nonce:frameNonce});
      await frame.evaluate(({nonce}) => {
        for (const requestId of ['1', 0, -1, Number.MAX_SAFE_INTEGER + 1]) {
          parent.postMessage({type:'CLASSPILOT_AUTH_FRAME_RELOAD_REQUEST',nonce,requestId},location.origin);
        }
        parent.postMessage({type:'CLASSPILOT_AUTH_FRAME_RELOAD_REQUEST',nonce:'wrong',requestId:1},location.origin);
      }, {nonce:frameNonce});
      await page.clock.runFor(20);
      assert.equal(await page.evaluate(() => parentFixture.reloadCalls), 0);
      await click(frame, '#classpilot-auth-reload');
      await frame.waitForFunction(() => !document.getElementById('classpilot-auth-reload').disabled, null, {timeout:2000});
      assert.equal(await page.evaluate(() => parentFixture.reloadCalls), 1);
      assert.match(await frame.locator('#classpilot-auth-retry-status').textContent(), /could not request a reload/);
      assert.equal(await page.evaluate(() => document.body.inert), true);
      assert.equal(await page.locator('#page-draft').inputValue(), 'protected draft');
      passed += 1; console.log('PASS real content parent forwards numeric frame reload ID once and delivers the validated result');
    } finally { await page.close(); }
  }

  await scenario('uncertain manual login is never replayed and can reconcile a committed session', 'normal', async (page, frame) => {
    await submit(frame); await page.clock.runFor(10_010);
    assert.equal(await phase(frame), 'unavailable');
    assert.match(await frame.locator('.classpilot-auth-state-card').textContent(), /previous sign-in/);
    await click(frame, '#classpilot-auth-retry');
    assert.equal(await frame.evaluate(() => fixture.calls.filter(call => call.type === 'manual-student-login').length), 1);
    await frame.evaluate(() => { fixture.stateMode='normal'; fixture.state={phase:'authenticated',authRequired:false,revision:6}; });
    await click(frame, '#classpilot-auth-retry');
    assert.equal(await phase(frame), 'authenticated');
    await frame.evaluate(() => fixture.manualCallback({success:false,error:'late rejection'}));
    assert.equal(await phase(frame), 'authenticated');
    assert.equal(await frame.evaluate(() => fixture.calls.filter(call => call.type === 'manual-student-login').length), 1);
  });

  await scenario('uncertain login requires fresh settled ready state before explicit resubmission', 'normal', async (page, frame) => {
    await submit(frame); await page.clock.runFor(10_010);
    await frame.evaluate(() => { fixture.stateMode='normal'; fixture.state={phase:'ready',authRequired:true,loginMethod:'email_id',revision:4}; });
    await click(frame, '#classpilot-auth-retry');
    assert.equal(await phase(frame), 'unavailable');
    await frame.evaluate(() => { fixture.state.revision=6; });
    await click(frame, '#classpilot-auth-retry');
    assert.equal(await phase(frame), 'ready');
    assert.equal(await frame.locator('#classpilot-auth-email').inputValue(), '');
    assert.equal(await frame.evaluate(() => fixture.calls.filter(call => call.type === 'manual-student-login').length), 1);
    await submit(frame);
    assert.equal(await frame.evaluate(() => fixture.calls.filter(call => call.type === 'manual-student-login').length), 2);
  });

  await scenario('new authoritative revision cancels an older state request and its timeout', 'missing', async (page, frame) => {
    await frame.evaluate(() => fixture.broadcast({type:'CLASSPILOT_AUTH_REQUIRED',state:{phase:'ready',authRequired:true,loginMethod:'email_id',revision:9}},{id:'fixture-extension'}));
    await page.clock.runFor(10_010);
    await frame.evaluate(() => fixture.stateCallbacks[0]({state:{phase:'authenticated',authRequired:false,revision:8}}));
    assert.equal(await phase(frame), 'ready');
    assert.equal(await frame.evaluate(() => fixture.diagnostics.length), 0);
  });

  await scenario('page disposal cancels pending transport and drops late response', 'missing', async (page, frame) => {
    await frame.evaluate(() => dispatchEvent(new PageTransitionEvent('pagehide')));
    await page.clock.runFor(10_010);
    await frame.evaluate(() => fixture.stateCallbacks[0]({state:{phase:'authenticated',authRequired:false,revision:8}}));
    assert.equal(await phase(frame), 'loading');
    assert.equal(await frame.evaluate(() => fixture.diagnostics.length), 0);
  });
  await scenario('support codes are allowlisted, selectable, bounded and never include diagnostic input', 'normal', async (_page,frame)=>{
    const codes=['AUTH_GATE_POLICY_TIMEOUT','AUTH_GATE_POLICY_UNAVAILABLE','AUTH_GATE_STARTUP_TIMEOUT',
      'AUTH_GATE_RPC_TIMEOUT','AUTH_GATE_RPC_UNAVAILABLE','AUTH_GATE_CONTEXT_INVALIDATED',
      'AUTH_GATE_SERVER_TIMEOUT','AUTH_GATE_LOGIN_PENDING','AUTH_GATE_UNAVAILABLE'];
    let revision=10;
    for(const code of [...codes,'private@example.invalid <img src=x onerror=alert(1)>','AUTH_GATE_POLICY_TIMEOUT\nprivate-token']) {
      await frame.evaluate(({code,revision})=>fixture.broadcast({type:'CLASSPILOT_AUTH_REQUIRED',state:{phase:'unavailable',authRequired:true,revision,errorCode:code,error:'secret-private-error',message:'secret-private-message'}},{id:'fixture-extension'}),{code,revision:revision++});
      const expected=codes.includes(code)?code:'AUTH_GATE_UNAVAILABLE';
      assert.equal(await frame.locator('#classpilot-auth-support-code').textContent(),`Support code: ${expected}`);
      assert.equal(await frame.evaluate(()=>document.body.textContent.includes('private')),false);
      const layout=await frame.locator('#classpilot-auth-support-code').evaluate(element=>({
        selectable:getComputedStyle(element).userSelect!=='none',
        withinCard:element.getBoundingClientRect().right<=element.closest('.classpilot-auth-main-inner').getBoundingClientRect().right,
        noOverflow:element.scrollWidth<=element.clientWidth,
      }));
      assert.deepEqual(layout,{selectable:true,withinCard:true,noOverflow:true});
    }
    await frame.evaluate(revision=>fixture.broadcast({type:'CLASSPILOT_AUTH_REQUIRED',state:{phase:'loading',authRequired:true,revision}},{id:'fixture-extension'}),revision++);
    assert.equal(await frame.locator('#classpilot-auth-support-code').textContent(),'Support code: AUTH_GATE_UNAVAILABLE');
    await frame.evaluate(revision=>fixture.broadcast({type:'CLASSPILOT_AUTH_REQUIRED',state:{phase:'ready',authRequired:true,loginMethod:'email_id',revision}},{id:'fixture-extension'}),revision++);
    assert.equal(await frame.locator('#classpilot-auth-support-code').count(),0);
  });
  await scenario('failure-only parent recovery validates nonce, redacts input and cannot publish ready authority','normal',async(page,frame)=>{
    const recovery={type:'CLASSPILOT_AUTH_FRAME_POLICY_RECOVERY',nonce:'wrong',policyRecovery:{errorCode:'private-token@example.invalid',retryAt:0}};
    await page.evaluate(message=>document.getElementById('gate').contentWindow.postMessage(message,location.origin),recovery);
    await page.clock.runFor(1);assert.equal(await phase(frame),'ready');
    await page.evaluate(message=>document.getElementById('gate').contentWindow.postMessage(message,location.origin),{...recovery,nonce});
    await frame.waitForFunction(()=>document.getElementById('classpilot-auth-gate').dataset.classpilotAuthPhase==='unavailable');
    assert.equal(await frame.locator('#classpilot-auth-support-code').textContent(),'Support code: AUTH_GATE_UNAVAILABLE');
    assert.equal(await frame.evaluate(()=>document.body.textContent.includes('private')),false);
    const before=await frame.evaluate(()=>fixture.calls.length);
    await frame.evaluate(()=>fixture.broadcast({type:'CLASSPILOT_AUTH_COMPLETE',state:{phase:'authenticated',authRequired:false,revision:99}},{id:'fixture-extension'}));
    assert.equal(await phase(frame),'unavailable');
    await click(frame,'#classpilot-auth-retry');
    assert.equal(await frame.evaluate(()=>fixture.calls.length),before,'failure-only frame must delegate to parent fence, not fetch or submit credentials');
    const request=await page.evaluate(()=>messages.find(message=>message.type==='CLASSPILOT_AUTH_FRAME_POLICY_RETRY'));
    assert.equal(request.nonce,nonce);assert.equal(request.userInitiated,true);
    await page.clock.runFor(10_010);assert.equal(await phase(frame),'unavailable');
    assert.equal(await frame.locator('#classpilot-auth-retry').isEnabled(),true);
  });
  console.log(`Auth recovery frame: ${passed} scenarios passed.`);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
