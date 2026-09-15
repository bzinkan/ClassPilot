import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { chromium } from 'playwright';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = resolve(process.env.CLASSPILOT_EXTENSION_PATH || join(repoRoot, 'extension'));
const candidateVersion = JSON.parse(readFileSync(join(sourceRoot, 'manifest.json'), 'utf8')).version;
const selectedCase = process.env.CLASSPILOT_AUTH_RECOVERY_CASE || '';
assert.ok(['','existing','policy-change','cold-bootstrap','asymmetric-ack','upgrade-2.8.7','auth-read-retry','auth-read-pending'].includes(selectedCase),'unknown recovery case selector');
const sourceFiles=readdirSync(sourceRoot).filter(name=>(name.endsWith('.js')&&name!=='config.js')||name==='manifest.json'||name==='auth-gate-frame.html').sort();
const sha256=value=>createHash('sha256').update(value).digest('hex');
const sourceHashes=Object.fromEntries(sourceFiles.map(name=>[name,sha256(readFileSync(join(sourceRoot,name)))]));
const legacyReceipt = JSON.parse(readFileSync(join(repoRoot, 'scripts/fixtures/auth-recovery-2.8.6.json'), 'utf8'));
const legacyBytes = readFileSync(join(repoRoot, 'scripts/fixtures/auth-recovery-2.8.6.json.gz'));
assert.equal(createHash('sha256').update(legacyBytes).digest('hex'), legacyReceipt.archiveSha256);
const legacy = JSON.parse(gunzipSync(legacyBytes));
for (const [name, contents] of Object.entries(legacy.files)) {
  assert.equal(createHash('sha256').update(contents).digest('hex'), legacyReceipt.files[name]);
}
assert.equal(JSON.parse(legacy.files['manifest.json']).version, '2.8.6');
const previousReceipt=JSON.parse(readFileSync(join(repoRoot,'scripts/fixtures/auth-recovery-2.8.7.json'),'utf8'));
const previousBytes=readFileSync(join(repoRoot,'scripts/fixtures/auth-recovery-2.8.7.json.gz'));
assert.equal(createHash('sha256').update(previousBytes).digest('hex'),previousReceipt.archiveSha256);
const previous=JSON.parse(gunzipSync(previousBytes));
for(const [name,contents] of Object.entries(previous.files))assert.equal(createHash('sha256').update(contents).digest('hex'),previousReceipt.files[name]);
assert.equal(JSON.parse(previous.files['manifest.json']).version,'2.8.7');

async function fixtureServer() {
  const state = { configRequests: 0, rosterRequests: 0, studentLoginRequests: 0, pageLoads: 0 };
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture.invalid');
    if (url.pathname.startsWith('/api/')) {
      response.setHeader('access-control-allow-origin', '*');
      response.setHeader('content-type', 'application/json');
      if (url.pathname.endsWith('/login-config')) {
        state.configRequests += 1;
        response.end(JSON.stringify({ sharedSignInEnabled: true, loginMethod: 'name_pin', schoolId: 'recovery-school', passpilotKioskAvailable: false }));
      } else if (url.pathname.endsWith('/login-roster')) {
        state.rosterRequests += 1;
        response.end(JSON.stringify({ loginMethod: 'name_pin', grades: [], students: [], refreshAfterMs: 30_000 }));
      } else {
        if (url.pathname.endsWith('/student-login')) state.studentLoginRequests += 1;
        response.statusCode = 404;
        response.end(JSON.stringify({ error: 'fixture_route_unavailable' }));
      }
      return;
    }
    if (url.pathname === '/classroom') state.pageLoads += 1;
    response.setHeader('content-type', 'text/html');
    response.end('<!doctype html><html><head><title>Recovery fixture</title></head><body><input id="underlying-work"><button id="underlying-action">Fixture action</button><script>window.underlyingClicks=0;document.querySelector("#underlying-action").onclick=()=>window.underlyingClicks++;</script></body></html>');
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { state, server, origin: `http://127.0.0.1:${server.address().port}` };
}

function installManagedFixture(extensionPath, origin, mode, { pagePolicyMode = 'ready', bootstrapOnly = false, authReadMode='ready',authReadArea='local' } = {}) {
  // Exercise the packaged managed path under Chromium. Only the enterprise API
  // is simulated: do not accidentally pass via the loopback/unpacked bypass.
  writeFileSync(join(extensionPath, 'config.js'), `
globalThis.CLASSPILOT_SERVER_URL = ${JSON.stringify(origin)};
isExplicitUnmanagedDevelopmentServer = () => false;
isExplicitUnmanagedDevelopmentRuntime = () => false;
globalThis.__managedRecoveryFixture = {
  mode: ${JSON.stringify(mode)}, reads: 0, callbacks: [], pageOutcomes: [], storageListeners: [], messages: [],
  authReadMode:${JSON.stringify(authReadMode)},authReadArea:${JSON.stringify(authReadArea)},authReads:0,authReadFailures:0,authCallbacks:[],
  policy: {fastAuthGateEnabled:true,serverUrl:${JSON.stringify(origin)},schoolId:'recovery-school',schoolSlug:'recovery-school',enrollmentKey:'fixture-enrollment'}
};
const fixtureAuthArea=chrome.storage[${JSON.stringify(authReadArea)}];
const fixtureNativeAuthGet=fixtureAuthArea.get.bind(fixtureAuthArea);
fixtureAuthArea.get=(keys,callback)=>{
  const fixture=globalThis.__managedRecoveryFixture;
  const wakeSnapshot=Array.isArray(keys)&&keys.includes('authContextId')&&keys.includes('studentToken')&&keys.includes('autoRegistrationPaused')&&keys.includes('manualLoginLastSeenAt');
  if(!wakeSnapshot)return fixtureNativeAuthGet(keys,callback);
  fixture.authReads++;
  if(fixture.authReadMode==='reject-once'&&fixture.authReadFailures===0){fixture.authReadFailures++;throw new Error('FIXTURE_NATIVE_AUTH_READ_FAILED');}
  if(fixture.authReadMode==='never'){fixture.authCallbacks.push(()=>fixtureNativeAuthGet(keys,callback));return;}
  return fixtureNativeAuthGet(keys,callback);
};
const fixtureNativeStorageListener = chrome.storage.onChanged.addListener.bind(chrome.storage.onChanged);
chrome.storage.onChanged.addListener = listener => {
  globalThis.__managedRecoveryFixture.storageListeners.push(listener);
  fixtureNativeStorageListener(listener);
};
chrome.runtime.onMessage.addListener(message => {
  if (['get-auth-state','refresh-auth-state','get-login-roster','student-login'].includes(message?.type)) {
    const fixture = globalThis.__managedRecoveryFixture;
    fixture.messages.push({type:message.type,revalidate:message.revalidateManagedPolicy===true,at:Date.now()});
    if (fixture.messages.length>4000) fixture.messages.shift();
  }
  return false;
});
chrome.storage.managed.get = (_keys, callback) => {
  const fixture = globalThis.__managedRecoveryFixture;
  fixture.reads += 1;
  const callers = ['resolveServerUrl', 'ensureRegisteredNow', 'autoDetectAndRegister',
    'refreshSharedSignInLoginConfigFast', 'refreshSharedSignInLoginConfigLegacy',
    'runManagedAuthGatePolicyRevalidation'];
  const stack = new Error().stack || '';
  const callsite = callers.find(name => stack.includes(name)) || 'worker_policy_restore';
  let generation = null;
  try { generation = managedAuthGatePolicyGeneration; } catch {}
  if (fixture.mode === 'never') {
    if (fixture.callbacks.length >= 256) throw new Error('FIXTURE_CALLBACK_LIMIT');
    fixture.callbacks.push({callback, readId:fixture.reads, generation, callsite, startedAt:Date.now()});
  }
  else queueMicrotask(() => callback({...fixture.policy}));
};
// Observe the actual recovery decision without granting reload authority or
// manufacturing an outcome when Chromium only supplies an obsolete realm.
let fixtureInjectionFactory;
Object.defineProperty(globalThis, 'ClassPilotContentInjection', {
  configurable:true,
  get:() => fixtureInjectionFactory,
  set:factory => {
    fixtureInjectionFactory = Object.freeze({...factory, create(options) {
      const instance = factory.create(options);
      return Object.freeze({...instance, ensure(...args) {
        return instance.ensure(...args).then(result => {
          const fixture = globalThis.__managedRecoveryFixture;
          fixture.pageOutcomes.push({tabId:args[0],status:result?.status,reason:result?.reason || null});
          fixture.pageOutcomes = fixture.pageOutcomes.slice(-40);
          return result;
        });
      }});
    }});
  }
});
`);
  // A test-only first content script supplies the enterprise API and observes
  // real controller RPCs. All production script bytes and permissions remain
  // unchanged; no controller or transport implementation is substituted.
  writeFileSync(join(extensionPath, 'managed-recovery-fixture.js'), `
(() => {
  const fixture = globalThis.__managedPageFixture = {
    mode:${JSON.stringify(pagePolicyMode)}, reads:0, callbacks:[], listeners:[], messages:[],
    holdAcknowledgements:false, acknowledgements:[],
    policy:{fastAuthGateEnabled:true,serverUrl:${JSON.stringify(origin)}}
  };
  const addListener = chrome.storage.onChanged.addListener.bind(chrome.storage.onChanged);
  chrome.storage.onChanged.addListener = listener => { fixture.listeners.push(listener); addListener(listener); };
  chrome.storage.managed.get = (_keys, callback) => {
    fixture.reads++;
    if(fixture.mode==='never') fixture.callbacks.push({callback,at:Date.now()});
    else queueMicrotask(() => callback({...fixture.policy}));
  };
  const sendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
  chrome.runtime.sendMessage = (message, ...rest) => {
    const caller=(new Error().stack||'').includes('auth-gate-bootstrap.js')?'bootstrap':'content';
    if (message && typeof message==='object') {
      fixture.messages.push({type:message.type,revalidate:message.revalidateManagedPolicy===true,
        fence:message.managedPolicyFence ?? null,caller,at:Date.now()});
      if(fixture.messages.length>4000) fixture.messages.shift();
    }
    const callback = rest.at(-1);
    if (message?.revalidateManagedPolicy === true && typeof callback==='function') {
      rest[rest.length-1] = response => {
        if((fixture.holdAcknowledgements===true||fixture.holdAcknowledgements===caller) && response?.success===true) {
          fixture.acknowledgements.push(() => callback(response));
        } else callback(response);
      };
    }
    return sendMessage(message,...rest);
  };
})();
`);
  const manifestPath = join(extensionPath, 'manifest.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  manifest.content_scripts[0].js.unshift('managed-recovery-fixture.js');
  if (bootstrapOnly) manifest.content_scripts = manifest.content_scripts.filter(entry => !entry.js.includes('content.js'));
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  writeFileSync(join(extensionPath, 'recovery-probe.html'), '<!doctype html><title>Private extension test probe</title>');
}

function executable() {
  const candidates = [process.env.CLASSPILOT_CHROME_PATH, chromium.executablePath(), 'C:/Program Files/Google/Chrome/Application/chrome.exe'];
  return candidates.find((candidate) => candidate && existsSync(candidate));
}

async function withBrowser({ legacyVersion = false, previousVersion=false, mode = 'ready', caseName = 'existing', pagePolicyMode = 'ready', bootstrapOnly = false, authReadMode='ready',authReadArea='local' }, run) {
  if (selectedCase && selectedCase !== caseName) return;
  const root = mkdtempSync(join(tmpdir(), 'classpilot-recovery-browser-'));
  const extensionPath = join(root, 'extension');
  const profile = join(root, 'profile');
  const fixture = await fixtureServer();
  let context;
  try {
    cpSync(sourceRoot, extensionPath, { recursive: true });
    for(const name of sourceFiles)assert.equal(sha256(readFileSync(join(extensionPath,name))),sourceHashes[name],`candidate changed during test: ${name}`);
    if (legacyVersion) for (const [name, source] of Object.entries(legacy.files)) writeFileSync(join(extensionPath, name), source);
    if (previousVersion) for(const [name,source] of Object.entries(previous.files))writeFileSync(join(extensionPath,name),source);
    installManagedFixture(extensionPath, fixture.origin, mode, { pagePolicyMode, bootstrapOnly,authReadMode,authReadArea });
    const executablePath = executable();
    assert.ok(executablePath, 'Install Playwright Chromium before running the recovery browser gate');
    context = await chromium.launchPersistentContext(profile, {
      executablePath, headless: true, viewport: { width: 1366, height: 768 },
      args: ['--enable-unsafe-extension-debugging', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const extensionId = new URL(worker.url()).host;
    const probe = await context.newPage();
    await probe.goto(`chrome-extension://${extensionId}/recovery-probe.html`);
    assert.equal(await worker.evaluate(() => isExplicitUnmanagedDevelopmentRuntime()), false);
    assert.equal(await worker.evaluate(() => isExplicitUnmanagedDevelopmentServer(CONFIG.serverUrl)), false);
    await run({ context, worker, probe, extensionId, extensionPath, fixture });
  } finally {
    await context?.close();
    await new Promise((done) => fixture.server.close(done));
    const target = resolve(root);
    assert.ok(target.startsWith(resolve(tmpdir()) + sep) && basename(target).startsWith('classpilot-recovery-browser-'));
    rmSync(target, { recursive: true, force: true });
  }
}

async function rpc(page, message) {
  return page.evaluate((request) => new Promise((done) => {
    const timer = setTimeout(() => done({ success: false, code: 'FIXTURE_RPC_DEADLINE' }), 12_000);
    chrome.runtime.sendMessage(request, (response) => {
      clearTimeout(timer);
      const failed = chrome.runtime.lastError;
      done(failed ? { success: false, code: 'FIXTURE_CHANNEL_CLOSED' } : response);
    });
  }), message);
}

async function waitForPhase(page, phase, timeout = 12_000, version = candidateVersion) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    for (const frame of page.frames()) {
      if (!frame.url().includes('auth-gate-frame.html')) continue;
      const found = await frame.evaluate(() => ({
        phase: document.getElementById('classpilot-auth-gate')?.dataset.classpilotAuthPhase,
        version: chrome.runtime.getManifest().version,
        transportLoaded: Boolean(globalThis.ClassPilotAuthGateTransport),
      })).catch(() => null);
      if (found?.phase === phase && found.version === version && (version === '2.8.6' || found.transportLoaded)) return frame;
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error(`Protected auth frame did not reach ${phase}`);
}

async function waitForWorkerVersion(context, extensionId, version, timeout = 15_000) {
  const until = Date.now() + timeout;
  const observed = new Set();
  while (Date.now() < until) {
    for (const worker of context.serviceWorkers()) {
      if (new URL(worker.url()).host !== extensionId) continue;
      const currentVersion = await worker.evaluate(() => chrome.runtime.getManifest().version).catch(() => null);
      if (currentVersion) observed.add(currentVersion);
      if (currentVersion === version) return worker;
    }
    await new Promise(done => setTimeout(done, 100));
  }
  throw new Error(`Same-ID extension worker did not reach ${version}; observed ${[...observed].join(',')}`);
}

async function pageFixture(worker, page, operation, payload = null) {
  return worker.evaluate(async ({ url, operation, payload }) => {
    const tab = (await chrome.tabs.query({})).find(item => item.url === url);
    if (!tab?.id) throw new Error('FIXTURE_PAGE_MISSING');
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (operation, payload) => {
        const fixture = globalThis.__managedPageFixture;
        if (!fixture) throw new Error('FIXTURE_MANAGED_REALM_MISSING');
        if (operation === 'change') fixture.listeners.forEach(listener => listener(payload, 'managed'));
        if (operation === 'hold') fixture.holdAcknowledgements = payload;
        if (operation === 'release') {
          const callbacks = fixture.acknowledgements.splice(0);
          callbacks.forEach(callback => callback());
          return callbacks.length;
        }
        if (operation === 'late-policy') {
          const callbacks = fixture.callbacks.splice(0);
          callbacks.forEach(({callback}) => callback({fastAuthGateEnabled:false,serverUrl:'https://obsolete.invalid'}));
          return callbacks.length;
        }
        return {
          reads: fixture.reads,
          heldCallbacks: fixture.callbacks.length,
          heldAcknowledgements: fixture.acknowledgements.length,
          policyRequests: fixture.messages.filter(message => message.revalidate).map(({at,fence}) => ({at,fence})),
          stateRequests: fixture.messages.filter(message => message.type === 'get-auth-state').length,
          bootstrapPending: globalThis.__classpilotAuthGateBootstrap?.managedPolicyFencePending === true,
        };
      },
      args: [operation, payload],
    });
    return result;
  }, { url: page.url(), operation, payload });
}

async function managedChange(worker, pages, changes) {
  await worker.evaluate(changes => {
    const fixture = globalThis.__managedRecoveryFixture;
    for (const [key, change] of Object.entries(changes)) fixture.policy[key] = change.newValue;
    fixture.storageListeners.forEach(listener => listener(changes, 'managed'));
  }, changes);
  await Promise.all(pages.map(page => pageFixture(worker, page, 'change', changes)));
}

async function assertProtected(page) {
  await page.bringToFront();
  assert.equal(await page.locator('#classpilot-auth-gate').count(), 1);
  assert.equal(await page.locator('#classpilot-auth-gate').isVisible(), true);
  const protectedPage = await page.evaluate(() => {
    const input = document.getElementById('underlying-work');
    const button = document.getElementById('underlying-action');
    const inaccessible = element => Boolean(element.closest('[inert]'))
      || getComputedStyle(element).display === 'none' || getComputedStyle(element).visibility === 'hidden';
    input.focus();
    return inaccessible(input) && inaccessible(button) && document.activeElement !== input;
  });
  assert.equal(protectedPage, true);
  await assert.rejects(page.locator('#underlying-action').click({trial:true,timeout:250}));
  await page.mouse.click(225, 15);
  assert.equal(await page.evaluate(() => window.underlyingClicks), 0);
  assert.equal(await page.locator('#underlying-work').inputValue(), '');
}

async function clickRetry(frame) {
  // A visible background extension frame can stop producing animation frames.
  // Playwright's stability check then waits without ever attempting a click.
  // Select the tab as a user would; retain all normal actionability checks.
  await frame.page().bringToFront();
  await frame.locator('#classpilot-auth-retry').click({timeout:2_000});
}

await withBrowser({ caseName: 'policy-change' }, async ({ context, worker, fixture }) => {
  const pages = await Promise.all([1,2].map(async tab => {
    const page = await context.newPage();
    await page.goto(`${fixture.origin}/classroom?tab=${tab}`);
    await waitForPhase(page, 'ready');
    return page;
  }));
  const initial = await worker.evaluate(() => ({reads:__managedRecoveryFixture.reads,generation:managedAuthGatePolicyGeneration}));
  const before = await Promise.all(pages.map(page => pageFixture(worker, page, 'summary')));
  const requestsBefore = fixture.state.configRequests;
  await worker.evaluate(() => { __managedRecoveryFixture.mode = 'never'; });
  const started = Date.now();
  await managedChange(worker, pages, {enrollmentKey:{oldValue:'fixture-enrollment',newValue:'fixture-enrollment-updated'}});
  const frames = await Promise.all(pages.map(page => waitForPhase(page, 'unavailable', 5_500)));
  const unavailableMs = Date.now() - started;
  assert.ok(unavailableMs >= 2_800 && unavailableMs < 5_500, 'managed change must reach actionable failure after the3sread ceiling');
  const failedRead = await worker.evaluate(() => ({reads:__managedRecoveryFixture.reads,generation:managedAuthGatePolicyGeneration}));
  for (let index=0; index<pages.length; index++) {
    assert.equal(await frames[index].locator('#classpilot-auth-retry').isVisible(), true,
      'Retry must be visible in the trusted gate, not merely rendered inside a hidden frame');
    assert.equal(await frames[index].locator('#classpilot-auth-retry').isEnabled(), true);
    if(candidateVersion!=='2.8.7')assert.equal(await frames[index].locator('#classpilot-auth-support-code').textContent(),'Support code: AUTH_GATE_POLICY_TIMEOUT');
    assert.equal(await pages[index].locator('#classpilot-auth-gate').isVisible(), true);
  }
  assert.ok(failedRead.reads - initial.reads <= 2,
    'tabs must coalesce: only storage-change read plus its one direct superseding generation are allowed');
  assert.equal(fixture.state.configRequests, requestsBefore, 'unvalidated changed policy must not fetch login configuration');
  assert.equal(fixture.state.studentLoginRequests, 0, 'recovery must not replay a sign-in mutation');

  // Concurrent real Retry clicks join one replacement read. The owning
  // controller may also have one backoff attempt active; clicks must join it.
  const beforeRetry = await worker.evaluate(() => __managedRecoveryFixture.reads);
  try {
    // Drive one visible tab at a time; both requests still overlap the same
    // three-second native read. Parallel pointer actions fight browser focus.
    for(const frame of frames)await clickRetry(frame);
  } catch (error) {
    const diagnostics = await Promise.all(pages.map(async page => ({
      controller: await pageFixture(worker,page,'summary'),
      presentation: await page.evaluate(() => [...document.querySelectorAll('#classpilot-auth-gate, .classpilot-auth-frame-fallback, iframe')].map(element => ({tag:element.tagName,role:element.id||element.className,display:getComputedStyle(element).display,visibility:getComputedStyle(element).visibility,opacity:getComputedStyle(element).opacity,pointerEvents:getComputedStyle(element).pointerEvents}))),
      frames: await Promise.all(page.frames().filter(frame => frame.url().includes('auth-gate-frame.html')).map(frame => frame.evaluate(() => ({phase:document.getElementById('classpilot-auth-gate')?.dataset.classpilotAuthPhase,retryDisabled:document.getElementById('classpilot-auth-retry')?.disabled,visibility:document.visibilityState,focused:document.hasFocus()})).catch(() => ({detached:true})))),
    })));
    console.log('Retry actionability diagnostics',JSON.stringify(diagnostics));
    throw error;
  }
  await new Promise(done => setTimeout(done, 450));
  if(candidateVersion!=='2.8.7')for(const frame of frames)assert.equal(await frame.locator('#classpilot-auth-support-code').textContent(),'Support code: AUTH_GATE_POLICY_TIMEOUT');
  const duringRetry = await worker.evaluate(() => ({reads:__managedRecoveryFixture.reads,generation:managedAuthGatePolicyGeneration}));
  assert.ok(duringRetry.reads - beforeRetry <= 1, 'concurrent Retry created duplicate managed reads');
  assert.ok(duringRetry.generation > initial.generation, 'recovery must use fresh worker policy authority');
  for(const page of pages)await assertProtected(page);

  // Return an expired first-generation callback with foreign authority, then
  // complete only the latest real read with the current enterprise policy.
  const released = await worker.evaluate(() => {
    const fixture = __managedRecoveryFixture;
    const latest = Math.max(...fixture.callbacks.map(item => item.generation));
    const expired = fixture.callbacks.filter(item => item.generation < latest);
    const active = fixture.callbacks.filter(item => item.generation === latest);
    fixture.callbacks = [];
    expired.forEach(item => item.callback({...fixture.policy,schoolId:'obsolete-foreign-school',enrollmentKey:'obsolete-key'}));
    fixture.mode='ready';
    active.forEach(item => item.callback({...fixture.policy}));
    return {expired:expired.length,active:active.length,latest};
  });
  assert.ok(released.expired >= 1);
  assert.equal(released.active, 1);
  await Promise.all(pages.map(page => waitForPhase(page, 'ready')));
  assert.equal(await worker.evaluate(() => CONFIG.schoolId), 'recovery-school');
  const after = await Promise.all(pages.map(page => pageFixture(worker, page, 'summary')));
  const policyRequests = after.reduce((sum,item,index)=>sum+item.policyRequests.length-before[index].policyRequests.length,0);
  assert.ok(policyRequests <= 16, `policy controller retry traffic was unbounded: ${policyRequests}`);
  assert.equal(fixture.state.studentLoginRequests, 0);

  // Hold genuine success replies, establish a newer fence, then deliver the
  // older callbacks. Only the newer acknowledged authority may remain ready.
  await Promise.all(pages.map(page => pageFixture(worker, page, 'hold', true)));
  await managedChange(worker, pages, {enrollmentKey:{oldValue:'fixture-enrollment-updated',newValue:'fixture-enrollment-next'}});
  const until = Date.now()+3_000;
  let held;
  do { held=await Promise.all(pages.map(page=>pageFixture(worker,page,'summary'))); if(held.every(item=>item.heldAcknowledgements>0)) break; await new Promise(done=>setTimeout(done,50)); } while(Date.now()<until);
  assert.ok(held.every(item=>item.heldAcknowledgements>0), 'fixture must hold genuine worker fence acknowledgements');
  await Promise.all(pages.map(page => pageFixture(worker, page, 'hold', false)));
  await managedChange(worker, pages, {enrollmentKey:{oldValue:'fixture-enrollment-next',newValue:'fixture-enrollment-final'}});
  await Promise.all(pages.map(page => waitForPhase(page, 'ready')));
  const current = await worker.evaluate(() => ({generation:managedAuthGatePolicyGeneration,schoolId:CONFIG.schoolId}));
  const oldAcks = await Promise.all(pages.map(page => pageFixture(worker, page, 'release')));
  assert.ok(oldAcks.every(count=>count>0));
  for(const page of pages)await assertProtected(page);
  await Promise.all(pages.map(page => waitForPhase(page, 'ready')));
  assert.deepEqual(await worker.evaluate(() => ({generation:managedAuthGatePolicyGeneration,schoolId:CONFIG.schoolId})), current);
  console.log('PASS managed policy-change timeout, concurrent protected Retry, bounded traffic and stale acknowledgements', JSON.stringify({unavailableMs,policyRequests,expiredCallbacks:released.expired,activeRetryReads:released.active,tabs:pages.length}));
});

await withBrowser({ caseName: 'cold-bootstrap', pagePolicyMode:'never', bootstrapOnly:true }, async ({ context, worker, fixture }) => {
  const page = await context.newPage();
  const started=Date.now();
  await page.goto(`${fixture.origin}/classroom?bootstrap=only`);
  await page.locator('#classpilot-auth-gate').waitFor({timeout:2_000});
  let summary;
  while(Date.now()-started<4_500) {
    summary=await pageFixture(worker,page,'summary');
    if(summary.stateRequests>0) break;
    await new Promise(done=>setTimeout(done,50));
  }
  assert.equal(summary.stateRequests,1,'document-start must ask the worker after its native managed read deadline');
  assert.ok(Date.now()-started>=2_800&&Date.now()-started<4_500);
  await assertProtected(page);
  assert.equal(await pageFixture(worker,page,'late-policy'),1, 'fixture must actually stall the bootstrap native read');
  await assertProtected(page);
  // Release the deliberately withheld document-idle production controller.
  // Bootstrap owns protection and bounded worker reconciliation, while the
  // ordinary content controller owns the actual sign-in form.
  const files=JSON.parse(readFileSync(join(sourceRoot,'manifest.json'),'utf8')).content_scripts.find(entry=>entry.js.includes('content.js')).js;
  await worker.evaluate(async ({url,files})=>{
    const tab=(await chrome.tabs.query({})).find(item=>item.url===url);
    await chrome.scripting.executeScript({target:{tabId:tab.id},files});
  },{url:page.url(),files});
  await waitForPhase(page,'ready');
  assert.equal(fixture.state.studentLoginRequests,0);
  console.log('PASS document-start managed-read ceiling and ignored late callback (document-idle controller withheld)');
});

await withBrowser({caseName:'asymmetric-ack'},async({context,worker,fixture})=>{
  const page=await context.newPage();await page.goto(`${fixture.origin}/classroom?ack=bootstrap`);
  await waitForPhase(page,'ready');
  await pageFixture(worker,page,'hold','bootstrap');
  const started=Date.now();
  await managedChange(worker,[page],{enrollmentKey:{oldValue:'fixture-enrollment',newValue:'asymmetric-fixture-enrollment'}});
  const frame=await waitForPhase(page,'unavailable',11_000);
  assert.ok(Date.now()-started>=8_800&&Date.now()-started<11_000);
  const summary=await pageFixture(worker,page,'summary');
  assert.ok(summary.heldAcknowledgements>0,'bootstrap ACK must actually be withheld');
  assert.equal(summary.bootstrapPending,true,'content success cannot silently clear bootstrap authority');
  assert.equal(await frame.locator('#classpilot-auth-support-code').textContent(),'Support code: AUTH_GATE_RPC_TIMEOUT');
  await assertProtected(page);
  await pageFixture(worker,page,'hold',false);
  await clickRetry(frame);
  await waitForPhase(page,'ready');
  const before=await worker.evaluate(()=>({generation:managedAuthGatePolicyGeneration,schoolId:CONFIG.schoolId}));
  assert.ok(await pageFixture(worker,page,'release')>0);
  await waitForPhase(page,'ready');await assertProtected(page);
  assert.deepEqual(await worker.evaluate(()=>({generation:managedAuthGatePolicyGeneration,schoolId:CONFIG.schoolId})),before);
  assert.equal(fixture.state.studentLoginRequests,0);
  console.log('PASS asymmetric bootstrap ACK loss has bounded, correctly classified Retry and ignores obsolete ACK');
});

await withBrowser({caseName:'upgrade-2.8.7',previousVersion:true},async({context,worker,extensionId,extensionPath,fixture})=>{
  assert.notEqual(candidateVersion,'2.8.7','upgrade candidate must differ from immutable2.8.7');
  assert.equal(await worker.evaluate(()=>chrome.runtime.getManifest().version),'2.8.7');
  const page=await context.newPage();await page.goto(`${fixture.origin}/classroom?upgrade=287`);
  await waitForPhase(page,'ready',12_000,'2.8.7');await assertProtected(page);
  const loads=fixture.state.pageLoads;
  cpSync(sourceRoot,extensionPath,{recursive:true});installManagedFixture(extensionPath,fixture.origin,'ready');
  const session=await context.browser().newBrowserCDPSession();
  const installed=await session.send('Extensions.loadUnpacked',{path:extensionPath});await session.detach();
  assert.equal(installed.id,extensionId);
  const updated=await waitForWorkerVersion(context,extensionId,candidateVersion);
  const probe=await context.newPage();await probe.goto(`chrome-extension://${extensionId}/recovery-probe.html`);
  assert.equal((await rpc(probe,{type:'refresh-auth-state',reason:'user'}))?.success,true);
  let recovery='cooperative';
  try { await waitForPhase(page,'ready',15_000); }
  catch(error) {
    const outcomes=await updated.evaluate(async url=>{
      const tab=(await chrome.tabs.query({})).find(item=>item.url===url);
      return __managedRecoveryFixture.pageOutcomes.filter(item=>item.tabId===tab?.id).map(({status,reason})=>({status,reason}));
    },page.url());
    assert.equal(outcomes.at(-1)?.status,'manual_reload_required',`upgrade has no explicit safe fallback: ${error.message}`);
    assert.equal(outcomes.at(-1)?.reason,'ownership_unproven');
    await assertProtected(page);assert.equal(fixture.state.pageLoads,loads,'ambiguous old realm must not authorize automatic reload');
    recovery='manual_ownership_unproven';
    await page.reload();await waitForPhase(page,'ready');
  }
  await assertProtected(page);
  const expectedLoads=loads+(recovery==='cooperative'?0:1);
  assert.equal(fixture.state.pageLoads,expectedLoads);
  const files=[...new Set(JSON.parse(readFileSync(join(sourceRoot,'manifest.json'),'utf8')).content_scripts.flatMap(entry=>entry.js))];
  const ownership=await updated.evaluate(async({url,files})=>{
    const tab=(await chrome.tabs.query({})).find(item=>item.url===url);
    const inspect=async()=>{
      const [{result}]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>globalThis.ClassPilotPageLifecycle.inspect()});
      return result.map(({kind,version,instanceId,active})=>({kind,version,instanceId,active}));
    };
    const before=await inspect();
    for(let i=0;i<3;i++)await chrome.scripting.executeScript({target:{tabId:tab.id},files});
    return {before,after:await inspect()};
  },{url:page.url(),files});
  assert.deepEqual(ownership.after,ownership.before,'same-version injection must reuse owned controllers');
  assert.deepEqual(ownership.after.map(item=>item.kind).sort(),['bootstrap','content']);
  assert.ok(ownership.after.every(item=>item.version===candidateVersion&&item.active));
  await waitForPhase(page,'ready');await assertProtected(page);
  assert.equal(fixture.state.pageLoads,expectedLoads);assert.equal(fixture.state.studentLoginRequests,0);
  console.log(`PASS same-ID2.8.7→${candidateVersion} upgrade (${recovery}), one gate and repeated-injection controller reuse`);
});

for(const authReadArea of ['local','session'])await withBrowser({caseName:'auth-read-retry',authReadMode:'reject-once',authReadArea},async({context,worker,probe,fixture})=>{
  const page=await context.newPage();await page.goto(`${fixture.origin}/classroom?read=${authReadArea}`);
  const start=await worker.evaluate(()=>({failures:__managedRecoveryFixture.authReadFailures,reads:__managedRecoveryFixture.authReads}));
  assert.equal(start.failures,1,'actual initial native auth snapshot read must reject');
  const reply=await rpc(probe,{type:'refresh-auth-state',reason:'user'});
  assert.equal(reply?.success,true,`completed ${authReadArea} read failure poisoned startup: ${reply?.errorCode||reply?.code}`);
  await waitForPhase(page,'ready');await assertProtected(page);
  const current=await worker.evaluate(()=>({startup:authGateStartupComplete,roster:authGateRosterContextReady,revision:authGateRevisionReady,
    retainedSnapshot:authGateStartupPublicationOwners.has('auth_snapshot'),reads:__managedRecoveryFixture.authReads,schoolId:CONFIG.schoolId}));
  assert.equal(current.startup,true);assert.equal(current.roster,true);assert.equal(current.revision,true);
  assert.equal(current.retainedSnapshot,false,'coordinator must retire credential-bearing fulfilled snapshot');
  assert.ok(current.reads>=2);assert.equal(current.schoolId,'recovery-school');
  assert.equal(fixture.state.studentLoginRequests,0);
  console.log(`PASS first ${authReadArea} auth snapshot read rejects; explicit Retry resumes committed startup and form`);
});

await withBrowser({caseName:'auth-read-pending',authReadMode:'never'},async({context,worker,fixture})=>{
  const pages=await Promise.all([context.newPage(),context.newPage()]);
  const started=Date.now();
  await Promise.all(pages.map((page,index)=>page.goto(`${fixture.origin}/classroom?pending=${index}`)));
  let frames;
  try {frames=await Promise.all(pages.map(page=>waitForPhase(page,'unavailable',11_500)));}
  catch(error){
    console.log('Held initial auth-read presentation',JSON.stringify({
      worker:await worker.evaluate(()=>({startup:authGateStartupComplete,reads:__managedRecoveryFixture.authReads,pending:__managedRecoveryFixture.authCallbacks.length,messages:__managedRecoveryFixture.messages.map(({type,revalidate})=>({type,revalidate}))})),
      pages:await Promise.all(pages.map(async page=>({controller:await pageFixture(worker,page,'summary'),top:await page.evaluate(()=>({gates:document.querySelectorAll('#classpilot-auth-gate').length,supportCode:document.querySelector('#classpilot-auth-support-code')?.textContent,iframes:document.querySelectorAll('iframe').length})),frames:await Promise.all(page.frames().filter(frame=>frame.url().includes('auth-gate-frame.html')).map(frame=>frame.evaluate(()=>({phase:document.querySelector('#classpilot-auth-gate')?.dataset.classpilotAuthPhase,supportCode:document.querySelector('#classpilot-auth-support-code')?.textContent}))))}))),
    }));throw error;
  }
  let before=await worker.evaluate(()=>({reads:__managedRecoveryFixture.authReads,pending:__managedRecoveryFixture.authCallbacks.length,startup:authGateStartupComplete,configs:sharedSignInLoginConfig.phase}));
  const unavailableMs=Date.now()-started;
  assert.ok(unavailableMs<11_500,'pending startup must have one complete bounded failure deadline');
  assert.equal(before.startup,false);assert.equal(before.pending,1);assert.equal(before.reads,1);
  assert.equal(fixture.state.configRequests,0);
  for(const frame of frames)assert.equal(await frame.locator('#classpilot-auth-support-code').textContent(),'Support code: AUTH_GATE_STARTUP_TIMEOUT');
  for(const frame of frames)await clickRetry(frame);
  for(const page of pages)await assertProtected(page);
  assert.equal(await worker.evaluate(()=>__managedRecoveryFixture.authReads),1,'concurrent Retry cannot abandon pending native read');
  // An actual managed event while the initial native snapshot is unresolved
  // used to create a startup↔policy notification wait cycle.
  await managedChange(worker,pages,{fastAuthGateEnabled:{oldValue:true,newValue:false}});
  await managedChange(worker,pages,{fastAuthGateEnabled:{oldValue:false,newValue:true}});
  await worker.evaluate(()=>{
    const fixture=__managedRecoveryFixture;fixture.authReadMode='ready';
    fixture.authCallbacks.splice(0).forEach(callback=>callback());
  });
  await Promise.all(pages.map(page=>waitForPhase(page,'ready',12_000)));
  for(const page of pages)await assertProtected(page);
  const current=await worker.evaluate(()=>({startup:authGateStartupComplete,roster:authGateRosterContextReady,
    schoolId:CONFIG.schoolId,fast:fastAuthGateEnabled,reads:__managedRecoveryFixture.authReads,retainedSnapshot:authGateStartupPublicationOwners.has('auth_snapshot')}));
  assert.equal(current.startup,true);assert.equal(current.roster,true);assert.equal(current.fast,true);
  assert.equal(current.schoolId,'recovery-school');assert.equal(current.retainedSnapshot,false);
  assert.ok(current.reads>=2,'managed generation change must reread both native snapshots before adoption');
  assert.equal(fixture.state.studentLoginRequests,0);
  console.log('PASS unresolved initial auth snapshot keeps2tabs protected; current policy after native recovery has no startup cycle',JSON.stringify({unavailableMs,nativeReads:current.reads}));
});

await withBrowser({ mode: 'never' }, async ({ context, worker, probe, fixture }) => {
  const page = await context.newPage();
  const started = Date.now();
  await page.goto(`${fixture.origin}/classroom`);
  await page.locator('#classpilot-auth-gate').waitFor({ timeout: 2_000 });
  const response = await rpc(probe, { type: 'get-auth-state' });
  assert.notEqual(response?.code, 'FIXTURE_RPC_DEADLINE');
  assert.equal(response?.success, false);
  assert.equal(response?.state?.authRequired === false, false);
  assert.equal(response?.managedPolicyFence, undefined);
  assert.ok(Date.now() - started < 11_000, 'worker gate reply exceeded its complete-response ceiling');
  await waitForPhase(page, 'unavailable');
  assert.equal(fixture.state.configRequests, 0, 'unavailable managed authority must not start a server request');
  assert.equal(await page.locator('#classpilot-auth-gate').count(), 1);

  await worker.evaluate(() => { globalThis.__managedRecoveryFixture.mode = 'ready'; });
  const refreshed = await rpc(probe, { type: 'refresh-auth-state', reason: 'user' });
  assert.equal(refreshed?.success, true, `fresh policy retry failed: ${refreshed?.code || 'unknown'}`);
  await waitForPhase(page, 'ready');
  assert.ok(fixture.state.configRequests > 0);
  // A newer background read may have started after the first read timed out.
  // Age the complete held cohort explicitly; timeout and supersession are
  // different guarantees and are exercised separately below.
  const remainingMs = await worker.evaluate(() => Math.max(0,
    ...globalThis.__managedRecoveryFixture.callbacks.map(item => item.startedAt + 3_100 - Date.now())));
  if (remainingMs) await new Promise(done => setTimeout(done, remainingMs));
  const before = await worker.evaluate(() => ({ schoolId: CONFIG.schoolId, generation: managedAuthGatePolicyGeneration }));
  const expiredReads = await worker.evaluate(() => {
    const fixture = globalThis.__managedRecoveryFixture;
    return fixture.callbacks.splice(0).map(item => {
      const {callback,...metadata} = item;
      callback({ ...fixture.policy, schoolId: 'obsolete-foreign-school', enrollmentKey: 'obsolete-fixture-key' });
      return {...metadata,ageMs:Date.now()-item.startedAt};
    });
  });
  assert.equal(expiredReads.length, 1, 'startup callers must coalesce into one native read for the failed generation');
  assert.ok(expiredReads.every(item => item.ageMs >= 3_000), 'expired callback cohort contains an unexpired read');
  const after = await worker.evaluate(() => ({ schoolId: CONFIG.schoolId, generation: managedAuthGatePolicyGeneration }));
  assert.deepEqual(after, before, 'expired managed callbacks must not restore obsolete authority');
  assert.equal(after.schoolId, 'recovery-school');
  console.log('PASS managed-mode startup timeout, fresh Retry and expired-policy fencing', JSON.stringify(expiredReads));
});

await withBrowser({ mode: 'never' }, async ({ worker, probe }) => {
  const initial = await rpc(probe, { type: 'get-auth-state' });
  assert.equal(initial?.success, false);
  assert.equal(initial?.errorCode, 'AUTH_GATE_POLICY_TIMEOUT');
  const held = await worker.evaluate(async () => {
    const fixture = globalThis.__managedRecoveryFixture;
    const previousGeneration = managedAuthGatePolicyGeneration;
    const settled = promise => promise.then(
      () => ({settled:true,returned:true}),
      error => ({settled:true,code:error?.code || null}),
    );
    fixture.supersededRevalidation = settled(sharedManagedAuthGatePolicyRevalidation({userInitiated:true}));
    const until = Date.now()+1_000;
    while (!(managedAuthGatePolicyGeneration > previousGeneration
      && fixture.callbacks.some(item => item.generation === managedAuthGatePolicyGeneration)) && Date.now()<until) {
      await new Promise(done => setTimeout(done, 5));
    }
    if (managedAuthGatePolicyGeneration <= previousGeneration) throw new Error('FIXTURE_REVALIDATION_DID_NOT_START');
    const readCount = fixture.reads;
    fixture.supersededResolution = resolveServerUrl().then(
      value => ({settled:true,returnedObsolete:value.includes('obsolete')}),
      error => ({settled:true,code:error?.code || null}),
    );
    if (fixture.reads !== readCount) throw new Error('FIXTURE_GENERATION_READ_NOT_COALESCED');
    const item = fixture.callbacks.find(item => item.generation === managedAuthGatePolicyGeneration);
    return item ? {readId:item.readId,generation:item.generation,callsite:item.callsite,startedAt:item.startedAt} : null;
  });
  assert.equal(held?.callsite, 'runManagedAuthGatePolicyRevalidation', 'fixture must hold the real revalidation read joined by the resolver');
  await worker.evaluate(async () => {
    globalThis.__managedRecoveryFixture.mode = 'ready';
    // Exercise the real managed onChanged path, including its new authority
    // generation and stable barrier, without directly modifying either fence.
    handleManagedAuthGateStorageChange({fastAuthGateEnabled:{oldValue:false,newValue:true}}, 'managed');
    await awaitManagedAuthGatePolicyStable();
  });
  const before = await worker.evaluate(() => ({ schoolId: CONFIG.schoolId, serverUrl: CONFIG.serverUrl, generation: managedAuthGatePolicyGeneration }));
  assert.ok(before.generation > held.generation, 'managed onChanged must establish newer policy authority');
  const supersededRead = await worker.evaluate(readId => {
    const fixture = globalThis.__managedRecoveryFixture;
    const index = fixture.callbacks.findIndex(item => item.readId === readId);
    if (index < 0) return null;
    const {callback,...metadata} = fixture.callbacks.splice(index, 1)[0];
    const ageMs = Date.now()-metadata.startedAt;
    callback({...fixture.policy, schoolId:'obsolete-foreign-school',
      serverUrl:fixture.policy.serverUrl + '/obsolete', enrollmentKey:'obsolete-fixture-key'});
    return {...metadata,ageMs};
  }, held.readId);
  assert.ok(supersededRead?.ageMs < 3_000, 'supersession fixture must release before the read timeout, independently of timeout fencing');
  const resolution = await worker.evaluate(() => globalThis.__managedRecoveryFixture.supersededResolution);
  const revalidation = await worker.evaluate(() => globalThis.__managedRecoveryFixture.supersededRevalidation);
  assert.equal(resolution?.settled, true);
  assert.equal(resolution?.code, 'AUTH_MUTATION_SUPERSEDED', 'an older managed resolver must reject instead of returning stale authority');
  assert.equal(revalidation?.code, 'AUTH_MUTATION_SUPERSEDED', 'the joined old revalidation must also reject');
  const after = await worker.evaluate(() => ({ schoolId: CONFIG.schoolId, serverUrl: CONFIG.serverUrl, generation: managedAuthGatePolicyGeneration }));
  assert.deepEqual(after, before, 'a live but superseded managed read must not overwrite the fresh binding');
  console.log('PASS live coalesced Retry/read superseded by managed onChanged', JSON.stringify(supersededRead));
});

await withBrowser({ legacyVersion: true }, async ({ context, worker, probe, extensionId, extensionPath, fixture }) => {
  assert.equal(await worker.evaluate(() => chrome.runtime.getManifest().version), '2.8.6');
  const page = await context.newPage();
  await page.goto(`${fixture.origin}/classroom`);
  await waitForPhase(page, 'ready', 12_000, '2.8.6');
  const loadsBefore = fixture.state.pageLoads;
  const idBefore = extensionId;
  cpSync(sourceRoot, extensionPath, { recursive: true });
  installManagedFixture(extensionPath, fixture.origin, 'ready');
  assert.equal(JSON.parse(readFileSync(join(extensionPath, 'manifest.json'), 'utf8')).version, candidateVersion);
  const extensionSession = await context.browser().newBrowserCDPSession();
  const installed = await extensionSession.send('Extensions.loadUnpacked', {path:extensionPath});
  assert.equal(installed.id, idBefore, 'same-path upgrade must preserve the installed extension identity');
  await extensionSession.detach();
  const updated = await waitForWorkerVersion(context, idBefore, candidateVersion);
  assert.equal(new URL(updated.url()).host, idBefore, 'upgrade must preserve extension identity');
  assert.equal(await updated.evaluate(() => chrome.runtime.getManifest().version), candidateVersion);
  const freshProbe = await context.newPage();
  await freshProbe.goto(`chrome-extension://${extensionId}/recovery-probe.html`);
  const state = await rpc(freshProbe, { type: 'refresh-auth-state', reason: 'user' });
  assert.equal(state?.success, true);
  const fixtureTabId = await updated.evaluate(async origin => {
    const tabs = await chrome.tabs.query({});
    return tabs.find(tab => tab.url === origin + '/classroom')?.id;
  }, fixture.origin);
  assert.ok(Number.isInteger(fixtureTabId));
  let recovery = 'automatic';
  try { await waitForPhase(page, 'ready', 12_000); }
  catch (error) {
    // Chrome may isolate the old extension realm so ownership cannot be proved.
    // A timeout itself is not evidence of this permitted outcome: require the
    // production recovery path's explicit ownership decision for this exact tab.
    const outcomes = await updated.evaluate(tabId => globalThis.__managedRecoveryFixture.pageOutcomes
      .filter(item => item.tabId === tabId).map(({status,reason}) => ({status,reason})), fixtureTabId);
    const manual = outcomes.at(-1);
    assert.equal(manual?.status, 'manual_reload_required',
      `upgrade stalled without an explicit manual recovery outcome: ${JSON.stringify(outcomes)}; ${error.message}`);
    assert.ok(['ownership_unproven', 'legacy_requires_update_authorization'].includes(manual.reason),
      `upgrade fallback rejected an unexplained failure: ${manual.reason}`);
    recovery = 'manual';
    assert.equal(await page.locator('#classpilot-auth-gate').count(), 1);
    assert.equal(await page.locator('#classpilot-auth-gate').isVisible(), true);
    const locked = await page.evaluate(() => {
      const input = document.querySelector('#underlying-work');
      const action = document.querySelector('#underlying-action');
      const protectedElement = element => Boolean(element.closest('[inert]'))
        || getComputedStyle(element).display === 'none' || getComputedStyle(element).visibility === 'hidden';
      input.focus();
      return protectedElement(input) && protectedElement(action) && document.activeElement !== input;
    });
    assert.equal(locked, true, 'manual upgrade fallback must keep the underlying page quarantined');
    await page.keyboard.type('fixture-protected-input');
    assert.equal(await page.locator('#underlying-work').inputValue(), '');
    assert.equal(await page.evaluate(() => window.underlyingClicks), 0);
    assert.equal(fixture.state.pageLoads, loadsBefore, 'an unknown legacy owner must not auto-reload');
    console.log('Verified explicit protected legacy fallback', JSON.stringify(manual));
    await page.reload();
    await waitForPhase(page, 'ready');
  }
  assert.ok(fixture.state.pageLoads <= loadsBefore + 1, 'legacy upgrade reloaded the tab more than once');
  assert.equal(await page.locator('#classpilot-auth-gate').count(), 1);
  const loadsAfter = fixture.state.pageLoads;
  for (let index = 0; index < 3; index += 1) {
    await rpc(freshProbe, { type: 'refresh-auth-state', reason: 'page_timer' });
  }
  await new Promise((done) => setTimeout(done, 300));
  assert.equal(fixture.state.pageLoads, loadsAfter, 'ordinary recovery must not reload an upgraded page');
  await waitForPhase(page, 'ready');
  console.log(`PASS same-ID 2.8.6 to ${candidateVersion} upgrade (${recovery} legacy recovery), one gate and no reload loop`);
});

for(const name of sourceFiles)assert.equal(sha256(readFileSync(join(sourceRoot,name))),sourceHashes[name],`source changed during test: ${name}`);
console.log('Verified immutable production source inventory',JSON.stringify({version:candidateVersion,files:sourceHashes}));
console.log('ClassPilot managed-mode recovery and legacy upgrade browser gate passed.');
