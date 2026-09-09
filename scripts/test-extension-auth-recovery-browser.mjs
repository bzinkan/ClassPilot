import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { chromium } from 'playwright';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = resolve(process.env.CLASSPILOT_EXTENSION_PATH || join(repoRoot, 'extension'));
const legacyReceipt = JSON.parse(readFileSync(join(repoRoot, 'scripts/fixtures/auth-recovery-2.8.6.json'), 'utf8'));
const legacyBytes = readFileSync(join(repoRoot, 'scripts/fixtures/auth-recovery-2.8.6.json.gz'));
assert.equal(createHash('sha256').update(legacyBytes).digest('hex'), legacyReceipt.archiveSha256);
const legacy = JSON.parse(gunzipSync(legacyBytes));
for (const [name, contents] of Object.entries(legacy.files)) {
  assert.equal(createHash('sha256').update(contents).digest('hex'), legacyReceipt.files[name]);
}
assert.equal(JSON.parse(legacy.files['manifest.json']).version, '2.8.6');

async function fixtureServer() {
  const state = { configRequests: 0, pageLoads: 0 };
  const server = createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture.invalid');
    if (url.pathname.startsWith('/api/')) {
      response.setHeader('access-control-allow-origin', '*');
      response.setHeader('content-type', 'application/json');
      if (url.pathname.endsWith('/login-config')) {
        state.configRequests += 1;
        response.end(JSON.stringify({ sharedSignInEnabled: true, loginMethod: 'name_pin', schoolId: 'recovery-school', passpilotKioskAvailable: false }));
      } else if (url.pathname.endsWith('/login-roster')) {
        response.end(JSON.stringify({ loginMethod: 'name_pin', grades: [], students: [], refreshAfterMs: 30_000 }));
      } else {
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

function installManagedFixture(extensionPath, origin, mode) {
  // Exercise the packaged managed path under Chromium. Only the enterprise API
  // is simulated: do not accidentally pass via the loopback/unpacked bypass.
  writeFileSync(join(extensionPath, 'config.js'), `
globalThis.CLASSPILOT_SERVER_URL = ${JSON.stringify(origin)};
isExplicitUnmanagedDevelopmentServer = () => false;
isExplicitUnmanagedDevelopmentRuntime = () => false;
globalThis.__managedRecoveryFixture = {
  mode: ${JSON.stringify(mode)}, reads: 0, callbacks: [], pageOutcomes: [],
  policy: {fastAuthGateEnabled:true,serverUrl:${JSON.stringify(origin)},schoolId:'recovery-school',schoolSlug:'recovery-school',enrollmentKey:'fixture-enrollment'}
};
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
  writeFileSync(join(extensionPath, 'recovery-probe.html'), '<!doctype html><title>Private extension test probe</title>');
}

function executable() {
  const candidates = [process.env.CLASSPILOT_CHROME_PATH, chromium.executablePath(), 'C:/Program Files/Google/Chrome/Application/chrome.exe'];
  return candidates.find((candidate) => candidate && existsSync(candidate));
}

async function withBrowser({ legacyVersion = false, mode = 'ready' }, run) {
  const root = mkdtempSync(join(tmpdir(), 'classpilot-recovery-browser-'));
  const extensionPath = join(root, 'extension');
  const profile = join(root, 'profile');
  const fixture = await fixtureServer();
  let context;
  try {
    cpSync(sourceRoot, extensionPath, { recursive: true });
    if (legacyVersion) for (const [name, source] of Object.entries(legacy.files)) writeFileSync(join(extensionPath, name), source);
    installManagedFixture(extensionPath, fixture.origin, mode);
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

async function waitForPhase(page, phase, timeout = 12_000, version = '2.8.7') {
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
  assert.equal(JSON.parse(readFileSync(join(extensionPath, 'manifest.json'), 'utf8')).version, '2.8.7');
  const extensionSession = await context.browser().newBrowserCDPSession();
  const installed = await extensionSession.send('Extensions.loadUnpacked', {path:extensionPath});
  assert.equal(installed.id, idBefore, 'same-path upgrade must preserve the installed extension identity');
  await extensionSession.detach();
  const updated = await waitForWorkerVersion(context, idBefore, '2.8.7');
  assert.equal(new URL(updated.url()).host, idBefore, 'upgrade must preserve extension identity');
  assert.equal(await updated.evaluate(() => chrome.runtime.getManifest().version), '2.8.7');
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
  console.log(`PASS same-ID 2.8.6 to 2.8.7 upgrade (${recovery} legacy recovery), one gate and no reload loop`);
});

console.log('ClassPilot managed-mode recovery and legacy upgrade browser gate passed.');
