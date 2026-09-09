import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const nonce = 'a'.repeat(64);
const extensionRoot = process.env.CLASSPILOT_EXTENSION_PATH || fileURLToPath(new URL('../extension/', import.meta.url));
const files = new Map(['auth-gate-transport.js','auth-gate-frame.js'].map(name => [name, readFileSync(resolve(extensionRoot, name), 'utf8')]));
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://fixture.invalid');
  const name = url.pathname.slice(1);
  if (files.has(name)) { response.writeHead(200, { 'content-type': 'text/javascript' }); response.end(files.get(name)); return; }
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  if (url.pathname === '/frame') {
    response.end(`<!doctype html><html><body><div id="classpilot-auth-gate"></div><script>
      const scenario = new URL(location.href).searchParams.get('scenario');
      window.fixture = {
        calls: [], stateCallbacks: [], rosterCallbacks: [], diagnostics: [],
        stateMode: scenario === 'missing' ? 'hold' : scenario === 'invalid' ? 'throw' : 'normal',
        rosterMode: scenario === 'roster' ? 'hold' : 'normal',
        state: { phase:'ready', authRequired:true, loginMethod:scenario === 'roster' ? 'name_pin' : 'email_id', revision:5, rosterContextGeneration:1 },
      };
      window.ClassPilotAuthRecoveryDiagnostics = { record: event => fixture.diagnostics.push(event) };
      window.chrome = {runtime:{ id:'fixture-extension', lastError:null, onMessage:{addListener(fn){fixture.broadcast=fn;}}, sendMessage(message, callback){
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
      </script><script src="/auth-gate-transport.js"></script><script src="/auth-gate-frame.js"></script></body></html>`);
    return;
  }
  response.end(`<!doctype html><html><body><iframe id="gate" src="/frame?scenario=${encodeURIComponent(url.searchParams.get('scenario') || 'normal')}#${nonce}"></iframe><script>
    window.messages=[];addEventListener('message',event=>messages.push(event.data));
    document.getElementById('gate').addEventListener('load',()=>document.getElementById('gate').contentWindow.postMessage({type:'CLASSPILOT_AUTH_FRAME_INIT',nonce:'${nonce}'},location.origin));
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
async function submit(frame) {
  await frame.evaluate(() => {
    document.getElementById('classpilot-auth-email').value = 'student@example.invalid';
    document.getElementById('classpilot-auth-student-id').value = 'fixture-id';
    document.getElementById('classpilot-auth-email-form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  });
}
try {
  await scenario('missing state callback restores Retry and ignores late auth proof', 'missing', async (page, frame) => {
    await page.clock.runFor(10_010);
    assert.equal(await phase(frame), 'unavailable');
    assert.equal(await frame.locator('#classpilot-auth-retry').isEnabled(), true);
    await frame.evaluate(() => fixture.stateCallbacks[0]({success:true,state:{phase:'authenticated',authRequired:false,revision:8}}));
    assert.equal(await phase(frame), 'unavailable');
    await frame.evaluate(() => { fixture.stateMode = 'normal'; });
    await click(frame, '#classpilot-auth-retry');
    assert.equal(await phase(frame), 'ready');
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
  console.log(`Auth recovery frame: ${passed} scenarios passed.`);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
