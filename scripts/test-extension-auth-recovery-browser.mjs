import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { chromium } from 'playwright';
import { extensionWorkerDeclarationsReady, waitForExtensionWorkerDeclarations } from './extension-worker-test-readiness.mjs';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// Case table. `expectedRedOnBase` records whether the case must FAIL against
// unmodified released sources: `true` means v2.8.9 (the 2.9.0 correction), a
// version string names the immutable scripts/fixtures snapshot it must trip on
// (2.9.4's cases trip on v2.9.3). scripts/test-extension-recovery-red-on-old.mjs
// proves every red case trips on that old worker before trusting a green run.
export const RECOVERY_CASES = Object.freeze({
  'existing': { expectedRedOnBase: false },
  'policy-change': { expectedRedOnBase: false },
  'cold-bootstrap': { expectedRedOnBase: false },
  'asymmetric-ack': { expectedRedOnBase: false },
  'upgrade-2.8.6': { expectedRedOnBase: false, historicalUpgrade: true },
  'upgrade-2.8.7': { expectedRedOnBase: false, historicalUpgrade: true },
  'upgrade-2.8.8': { expectedRedOnBase: false, historicalUpgrade: true },
  'upgrade-2.8.9': { expectedRedOnBase: false, historicalUpgrade: true },
  'upgrade-2.9.4-native-reload': { expectedRedOnBase: false },
  'auth-read-retry': { expectedRedOnBase: false },
  // 2.8.9 retains an unresolved read forever; 2.9.0 reconciles it at the deadline.
  'auth-read-pending': { expectedRedOnBase: true },
  'startup-policy-write-failure': { expectedRedOnBase: true },
  'startup-auth-cleanup-failure': { expectedRedOnBase: true },
  'commit-then-fail': { expectedRedOnBase: true },
  'stalled-write-committed': { expectedRedOnBase: true },
  'stalled-write-lost': { expectedRedOnBase: true },
  'abandoned-then-newer-policy': { expectedRedOnBase: true },
  'post-snapshot-supersession': { expectedRedOnBase: true },
  'competing-login': { expectedRedOnBase: true },
  'held-ops-concurrency': { expectedRedOnBase: true },
  // 2.9.3 left a wake that failed or parked before its policy barrier settled
  // unrecoverable (readiness waited on that barrier forever); 2.9.4 recovers.
  'wake-failure-before-policy': { expectedRedOnBase: '2.9.3' },
  'wake-parked-before-policy': { expectedRedOnBase: '2.9.3' },
  'wake-partial-auth-clear': { expectedRedOnBase: 'pr116-16320c6', expectedFailure: '[regression:partial-auth]' },
  'wake-no-migration-replay': { expectedRedOnBase: 'pr116-16320c6', expectedFailure: '[regression:migration-replay]' },
  'wake-held-composite-no-takeover': { expectedRedOnBase: 'pr116-16320c6', expectedFailure: '[regression:composite-takeover]' },
  'server-signout-fresh-login-binding': { expectedRedOnBase: false },
  'server-signout-during-startup-recovery': { expectedRedOnBase: false },
  'blocked-screen-diagnostics': { expectedRedOnBase: 'pr116-16320c6', expectedFailure: '[regression:on-screen-details]' },
  'blocked-fallback-diagnostics': { expectedRedOnBase: false },
  'recovered-startup-obsolete-school': { expectedRedOnBase: false },
  'worker-suspension-preserves-classroom': { expectedRedOnBase: false },
  'protected-storage-retry': { expectedRedOnBase: '2.9.4', expectedFailure: '[regression:protected-storage-retry]' },
  'protected-storage-persistent': { expectedRedOnBase: false },
  'private-vault-browser-restart': { expectedRedOnBase: '2.9.4', expectedFailure: '[regression:private-vault]' },
  'private-vault-migration-crash': { expectedRedOnBase: false },
  'private-vault-write-failure': { expectedRedOnBase: false },
});
if (process.argv.includes('--list-cases')) {
  console.log(JSON.stringify(RECOVERY_CASES));
  process.exit(0);
}
const sourceRoot = resolve(process.env.CLASSPILOT_EXTENSION_PATH || join(repoRoot, 'extension'));
const candidateVersion = JSON.parse(readFileSync(join(sourceRoot, 'manifest.json'), 'utf8')).version;
const selectedCase = process.env.CLASSPILOT_AUTH_RECOVERY_CASE || '';
assert.ok(['', ...Object.keys(RECOVERY_CASES)].includes(selectedCase), 'unknown recovery case selector');
const compatibilityRun = process.env.CLASSPILOT_COMPATIBILITY_RUN === '1';
const completedBrowserCases = [];
const skippedHistoricalUpgrades = [];
const sourceFiles=readdirSync(sourceRoot).filter(name=>(name.endsWith('.js')&&name!=='config.js')||name==='manifest.json'||name==='auth-gate-frame.html').sort();
const sha256=value=>createHash('sha256').update(value).digest('hex');
const sourceHashes=Object.fromEntries(sourceFiles.map(name=>[name,sha256(readFileSync(join(sourceRoot,name)))]));
// Immutable released-source snapshots (scripts/fixtures/generate-auth-recovery-fixture.mjs).
function loadSnapshot(version) {
  const receipt = JSON.parse(readFileSync(join(repoRoot, `scripts/fixtures/auth-recovery-${version}.json`), 'utf8'));
  const bytes = readFileSync(join(repoRoot, `scripts/fixtures/auth-recovery-${version}.json.gz`));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), receipt.archiveSha256);
  const snapshot = JSON.parse(gunzipSync(bytes));
  for (const [name, contents] of Object.entries(snapshot.files)) {
    assert.equal(createHash('sha256').update(contents).digest('hex'), receipt.files[name]);
  }
  assert.equal(JSON.parse(snapshot.files['manifest.json']).version, version);
  return snapshot;
}
const legacy = loadSnapshot('2.8.6');
const previous = loadSnapshot('2.8.7');
const snapshots = { '2.8.6': legacy, '2.8.7': previous, '2.8.8': loadSnapshot('2.8.8'), '2.8.9': loadSnapshot('2.8.9'), '2.9.4': loadSnapshot('2.9.4') };

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
        if (state.revokedRecoveryToken && request.headers.authorization === `ClassPilot-Recovery ${state.revokedRecoveryToken}`) {
          state.revokedRosterRequests = (state.revokedRosterRequests || 0) + 1;
        }
        const students = state.allowFreshLogin
          ? [{ id: 'student-fresh-fixture', name: 'Fresh Fixture', hasPin: true }]
          : [];
        const revocable = state.revocableSession;
        if (revocable && (!revocable.active || request.headers.authorization === `ClassPilot-Recovery ${revocable.recoveryToken}`)) {
          students.unshift({ id: revocable.studentId, name: 'Revoked Fixture', hasPin: true,
            ...(revocable.active ? { reclaimable: true } : {}) });
        }
        response.end(JSON.stringify({ loginMethod: 'name_pin', grades: [], students, refreshAfterMs: 30_000 }));
      } else if (url.pathname.endsWith('/student-login') && state.allowFreshLogin) {
        let body = '';
        request.on('data', (chunk) => { body += chunk; });
        request.on('end', () => {
          state.studentLoginRequests += 1;
          (state.loginAuthorizationHeaders ||= []).push(request.headers.authorization || null);
          const payload = JSON.parse(body);
          if (payload.studentId !== 'student-fresh-fixture' || payload.pin !== '1234') {
            response.statusCode = 401;
            response.end(JSON.stringify({ error: 'Invalid PIN', code: 'PIN_MISMATCH' }));
            return;
          }
          const ordinal = state.studentLoginRequests;
          response.end(JSON.stringify({
            studentToken: `fresh-fixture-token-${ordinal}`, studentSessionId: `login-fresh-fixture-${ordinal}`,
            student: { id: 'student-fresh-fixture', firstName: 'Fresh', lastName: 'Fixture', email: 'fresh@example.test', schoolId: 'recovery-school' },
            schoolId: 'recovery-school', sessionRecovery: { token: String(ordinal).repeat(43) },
            planStatus: 'active', manualExpiresInSeconds: 300,
          }));
        });
      } else if (url.pathname.endsWith('/sign-out')) {
        // The synthetic API confirms only the pre-2.7.3 upgrade sign-out that
        // the legacy local-credential purge issues (the production API does);
        // every other sign-out keeps its 404 so existing cases are unchanged.
        let body = '';
        request.on('data', (chunk) => { body += chunk; });
        request.on('end', () => {
          let reason = null;
          try { reason = JSON.parse(body).reason; } catch { /* malformed */ }
          state.signOutRequests = (state.signOutRequests || 0) + 1;
          if (reason === 'legacy_local_auth_upgrade') {
            state.legacySignOutRequests = (state.legacySignOutRequests || 0) + 1;
            response.end(JSON.stringify({ ok: true }));
            return;
          }
          (state.unknownApiPaths ||= []).push(url.pathname);
          response.statusCode = 404;
          response.end(JSON.stringify({ error: 'fixture_route_unavailable' }));
        });
      } else {
        if (url.pathname.endsWith('/student-login')) state.studentLoginRequests += 1;
        (state.unknownApiPaths ||= []).push(url.pathname);
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

function installManagedFixture(extensionPath, origin, mode, { pagePolicyMode = 'ready', bootstrapOnly = false, authReadMode='ready',authReadArea='local', seed=null, quietNetwork=false, protectedStorageFault=null } = {}) {
  // Exercise the packaged managed path under Chromium. Only the enterprise API
  // is simulated: do not accidentally pass via the loopback/unpacked bypass.
  writeFileSync(join(extensionPath, 'config.js'), `
globalThis.CLASSPILOT_SERVER_URL = ${JSON.stringify(origin)};
isExplicitUnmanagedDevelopmentServer = () => false;
isExplicitUnmanagedDevelopmentRuntime = () => false;
globalThis.__managedRecoveryFixture = {
  mode: ${JSON.stringify(mode)}, reads: 0, callbacks: [], pageOutcomes: [], storageListeners: [], messages: [],
  authReadMode:${JSON.stringify(authReadMode)},authReadArea:${JSON.stringify(authReadArea)},authReads:0,authReadFailures:0,authCallbacks:[],
  policy: {fastAuthGateEnabled:true,serverUrl:${JSON.stringify(origin)},schoolId:'recovery-school',schoolSlug:'recovery-school',enrollmentKey:'fixture-enrollment'},
  seed:${JSON.stringify(seed)}, seeded:false,
  writeFaults:[], writeAttempts:{}, writeLog:[], heldWrites:[], lastErrorDelivery:null, faultDeliveryFailed:false,
  monitoringEvents:[], authClears:[], diagnostics:[], readinessCapture:null,
  nativeErrors:[],
};
for (const eventType of ['error', 'unhandledrejection']) addEventListener(eventType, event => {
  __managedRecoveryFixture.nativeErrors.push({ type:eventType, message:event.message || event.reason?.message || null,
    stack:event.error?.stack || event.reason?.stack || null });
  if (__managedRecoveryFixture.nativeErrors.length > 50) __managedRecoveryFixture.nativeErrors.shift();
});
// Optional pre-wake persisted state. Every native read is held until the seed
// has landed so the worker's first wake observes exactly this stored state.
if (globalThis.__managedRecoveryFixture.seed) {
  const fixtureSeed = globalThis.__managedRecoveryFixture.seed;
  const waitingReads = [];
  const nativeSeedGet = chrome.storage.local.get.bind(chrome.storage.local);
  for (const areaName of ['local','session']) {
    const area = chrome.storage[areaName];
    if (!area) continue;
    const nativeGet = area.get.bind(area);
    area.get = (keys, ...rest) => {
      if (globalThis.__managedRecoveryFixture.seeded) return nativeGet(keys, ...rest);
      if (typeof rest[0] !== 'function') return new Promise((resolve, reject) => waitingReads.push(() => nativeGet(keys).then(resolve, reject)));
      waitingReads.push(() => nativeGet(keys, ...rest));
    };
  }
  const nativeLocalSet = chrome.storage.local.set.bind(chrome.storage.local);
  const nativeSessionSet = chrome.storage.session?.set?.bind(chrome.storage.session);
  const finishSeed = () => { globalThis.__managedRecoveryFixture.seeded = true; waitingReads.splice(0).forEach((run) => run()); };
  nativeSeedGet('__classpilotFixtureSeeded', stored => {
    void chrome.runtime.lastError;
    if (stored.__classpilotFixtureSeeded) { finishSeed(); return; }
    nativeLocalSet({ ...(fixtureSeed.local || {}), __classpilotFixtureSeeded:true }, () => {
    void chrome.runtime.lastError;
    if (nativeSessionSet && fixtureSeed.session && Object.keys(fixtureSeed.session).length > 0) nativeSessionSet(fixtureSeed.session, () => { void chrome.runtime.lastError; finishSeed(); });
    else finishSeed();
    });
  });
}
// Per-key native write fault injection for chrome.storage.{local,session}.{set,remove}.
// A target names one area/method/key (plus optional co-key requirements) so
// exactly one kind of production operation is faulted. Modes:
//   reject-before-commit  nothing is written; the call fails synchronously
//                         exactly like the harness's native read patch
//                         (persistent:true keeps failing until 'heal')
//   commit-then-fail      the native write completes, then the callback runs
//                         with chrome.runtime.lastError set
//   never                 the callback is held (commitFirst:true performs the
//                         native write first) until releaseHeldWrites(key)
// writeAttempts[key] counts every worker write touching the key; each target
// counts matchedAttempts (all ops of its shape) and faultedAttempts.
const deliverNativeWriteFailure = (callback, message) => {
  const fixture = globalThis.__managedRecoveryFixture;
  const descriptor = Object.getOwnPropertyDescriptor(chrome.runtime, 'lastError');
  let injected = false;
  try {
    Object.defineProperty(chrome.runtime, 'lastError', { configurable: true, enumerable: true, get: () => ({ message }) });
    injected = chrome.runtime.lastError?.message === message;
  } catch { injected = false; }
  if (injected) {
    fixture.lastErrorDelivery = 'defineProperty';
    try { callback(); } finally {
      try { if (descriptor) Object.defineProperty(chrome.runtime, 'lastError', descriptor); else delete chrome.runtime.lastError; } catch {}
    }
    return;
  }
  try { if (descriptor) Object.defineProperty(chrome.runtime, 'lastError', descriptor); else delete chrome.runtime.lastError; } catch {}
  // Fallback: piggyback on a genuine failing native call (session quota) so
  // chrome.runtime.lastError is really set by Chrome during the callback.
  fixture.lastErrorDelivery = 'quota';
  chrome.storage.session.set({ __classpilotFixtureQuotaProbe: 'x'.repeat(11 * 1024 * 1024) }, () => {
    if (!chrome.runtime.lastError) fixture.faultDeliveryFailed = true;
    callback();
  });
};
globalThis.__managedRecoveryFixture.releaseHeldWrites = (key, options = {}) => {
  const fixture = globalThis.__managedRecoveryFixture;
  const released = fixture.heldWrites.filter((held) => !key || held.key === key);
  fixture.heldWrites = fixture.heldWrites.filter((held) => !released.includes(held));
  for (const held of released) {
    const finish = () => {
      held.releasedAt = Date.now();
      if (options.outcome === 'error') deliverNativeWriteFailure(held.callback, 'FIXTURE_HELD_WRITE_FAILED:' + held.key);
      else held.callback();
    };
    if (options.commit === true && !held.committed) held.native(held.value, () => { void chrome.runtime.lastError; held.committed = true; finish(); });
    else finish();
  }
  return released.map(({ key, method, area, committed }) => ({ key, method, area, committed }));
};
for (const areaName of ['local','session']) {
  const area = chrome.storage[areaName];
  if (!area) continue;
  for (const method of ['set','remove']) {
    const native = area[method].bind(area);
    area[method] = (value, ...rest) => {
      const callback = typeof rest[0] === 'function' ? rest[0] : null;
      if (!callback) {
        return new Promise((resolve, reject) => {
          try {
            area[method](value, (result) => { const failed = chrome.runtime.lastError; if (failed) reject(new Error(failed.message)); else resolve(result); });
          } catch (error) { reject(error); }
        });
      }
      const fixture = globalThis.__managedRecoveryFixture;
      const keys = method === 'set' ? Object.keys(value || {})
        : typeof value === 'string' ? [value] : Array.isArray(value) ? [...value] : Object.keys(value || {});
      for (const key of keys) fixture.writeAttempts[key] = (fixture.writeAttempts[key] || 0) + 1;
      const entry = { area: areaName, method, keys, at: Date.now(), fault: null,
        // The legacy fixture seeds only studentToken among the old auth keys.
        // Its migration removes exactly that key; strict clear removes the
        // complete auth-key set. Match the native call shape, not JS stacks
        // whose async depth differs between Chrome releases.
        legacyMigration: areaName === 'local' && method === 'remove' && keys.length === 1 && keys[0] === 'studentToken' };
      fixture.writeLog.push(entry);
      if (fixture.writeLog.length > 2000) fixture.writeLog.shift();
      const matching = fixture.writeFaults.filter((target) => target.area === areaName && target.method === method
        && keys.includes(target.key)
        && (target.keyCount === undefined || keys.length === target.keyCount)
        && (target.requireKeys || []).every((required) => keys.includes(required))
        && !(target.excludeKeys || []).some((excluded) => keys.includes(excluded)));
      for (const target of matching) target.matchedAttempts += 1;
      const target = matching.find((candidate) => !candidate.consumed && !candidate.healed);
      if (!target) return native(value, callback);
      if (target.mode !== 'reject-before-commit' || target.persistent !== true) target.consumed = true;
      target.faultedAttempts += 1;
      target.faultedAt = Date.now();
      entry.fault = target.mode;
      if (target.mode === 'reject-before-commit') throw new Error('FIXTURE_NATIVE_WRITE_REJECTED:' + target.key);
      if (target.mode === 'commit-then-fail') {
        native(value, () => { void chrome.runtime.lastError; target.committed = true; deliverNativeWriteFailure(callback, 'FIXTURE_NATIVE_WRITE_FAILED_AFTER_COMMIT:' + target.key); });
        return;
      }
      if (target.mode === 'never') {
        const held = { id: target.id, key: target.key, area: areaName, method, keys, committed: false, callback, value, native, heldAt: Date.now(), releasedAt: null };
        fixture.heldWrites.push(held);
        if (target.commitFirst === true) native(value, () => { void chrome.runtime.lastError; held.committed = true; target.committed = true; });
        return;
      }
      throw new Error('FIXTURE_UNKNOWN_WRITE_FAULT_MODE:' + target.mode);
    };
  }
}
// Observe (never replace) hoisted production entry points. Function
// declarations are instantiated before importScripts('config.js') runs, so the
// wrapper is the binding every later production call resolves through.
for (const [name, list, describe] of [
  ['enqueueMonitoringEvent', 'monitoringEvents', (args) => ({ type: args[0] })],
  ['clearStudentAuth', 'authClears', (args) => ({ reason: args[0] })],
  ['recordAuthGateRecoveryDiagnostic', 'diagnostics', (args) => ({ stage: args[0], cause: args[1], elapsedMs: args[2], attemptCount: args[3] })],
]) {
  const native = globalThis[name];
  if (typeof native !== 'function') continue;
  globalThis[name] = function fixtureObserved(...args) {
    const fixture = globalThis.__managedRecoveryFixture;
    const entry = { at: Date.now(), ...describe(args) };
    fixture[list].push(entry);
    if (fixture[list].length > 500) fixture[list].shift();
    const result = native.apply(this, args);
    // enqueueMonitoringEvent resolves true only when an event was actually
    // emitted (it returns false without an authenticated student).
    if (name === 'enqueueMonitoringEvent' && result && typeof result.then === 'function') result.then((emitted) => { entry.emitted = emitted === true; }, () => { entry.emitted = false; });
    if (name === 'clearStudentAuth' && result && typeof result.then === 'function') result.then(
      () => { entry.completed = true; },
      error => { entry.completed = false; entry.error = error?.message; entry.code = error?.code; entry.stack = error?.stack; },
    );
    return result;
  };
}
if (${JSON.stringify(quietNetwork === true)}) {
  // Classroom-preservation case only: silence the network side effects of an
  // authenticated wake (license, heartbeat, registration, WebSocket, tracking)
  // so the fixture server's 404s cannot alter the classroom state under test.
  for (const name of ['checkLicenseStatus', 'sendHeartbeat', 'connectWebSocket', 'ensureRegistered', 'initializeAdaptiveTracking']) {
    if (typeof globalThis[name] === 'function') globalThis[name] = async () => {};
  }
  if (typeof globalThis.wsSend === 'function') globalThis.wsSend = async () => true;
}
const fixtureAuthArea=chrome.storage[${JSON.stringify(authReadArea)}];
const fixtureNativeAuthGet=fixtureAuthArea.get.bind(fixtureAuthArea);
fixtureAuthArea.get=(...args)=>{
  const [keys]=args;
  const fixture=globalThis.__managedRecoveryFixture;
  const wakeSnapshot=Array.isArray(keys)&&keys.includes('authContextId')&&keys.includes('studentToken')&&keys.includes('autoRegistrationPaused')&&keys.includes('manualLoginLastSeenAt');
  // Preserve Chrome's callback and Promise overloads exactly. Older native
  // bindings reject get(keys, undefined) instead of treating it as get(keys).
  if(!wakeSnapshot)return fixtureNativeAuthGet(...args);
  fixture.authReads++;
  if(fixture.authReadMode==='reject-once'&&fixture.authReadFailures===0){fixture.authReadFailures++;throw new Error('FIXTURE_NATIVE_AUTH_READ_FAILED');}
  if(fixture.authReadMode==='never'){fixture.authCallbacks.push(()=>fixtureNativeAuthGet(...args));return;}
  return fixtureNativeAuthGet(...args);
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
    holdAcknowledgements:false, acknowledgements:[], responses:[],
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
    if (typeof callback==='function') {
      rest[rest.length-1] = response => {
        if (['get-auth-state','refresh-auth-state'].includes(message?.type)) fixture.responses.push({type:message?.type,caller,at:Date.now(),success:response?.success,
          phase:response?.state?.phase,revision:response?.state?.revision,errorCode:response?.errorCode,
          fence:response?.managedPolicyFence});
        if(fixture.responses.length>100)fixture.responses.shift();
        if(message?.revalidateManagedPolicy === true && (fixture.holdAcknowledgements===true||fixture.holdAcknowledgements===caller) && response?.success===true) {
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
  if (protectedStorageFault) {
    // This entry point changes only Chrome API delivery. The production worker
    // is imported byte-for-byte, including its early storage restriction call.
    writeFileSync(join(extensionPath, 'protected-storage-fixture.js'), `
globalThis.__protectedStorageFixture = {
  mode:${JSON.stringify(protectedStorageFault.mode)}, holdPurge:${protectedStorageFault.holdPurge === true},
  calls:[], failures:0, purges:0, completedPurges:0, heldPurges:[], secured:false,
  capabilityWritesBeforeSecure:0,
  failVaultWrites:${protectedStorageFault.vaultFailure === true}, vaultWriteFailures:0,
};
(() => {
  const fixture=globalThis.__protectedStorageFixture;
  const area=chrome.storage.local;
  const nativeAccess=area.setAccessLevel?.bind(area);
  const nativeRemove=area.remove.bind(area);
  const nativeSet=area.set.bind(area);
  const nativeGet=area.get.bind(area);
  const nativePut=IDBObjectStore.prototype.put;
  IDBObjectStore.prototype.put=function(value,...args){
    if(this.name==='recovery'&&fixture.failVaultWrites){fixture.vaultWriteFailures++;throw new DOMException('FIXTURE_PRIVATE_WRITE_FAILED','UnknownError');}
    return nativePut.call(this,value,...args);
  };
  const failCallback=callback=>{
    const descriptor=Object.getOwnPropertyDescriptor(chrome.runtime,'lastError');
    Object.defineProperty(chrome.runtime,'lastError',{configurable:true,get:()=>({message:${JSON.stringify(protectedStorageFault.message || 'FIXTURE_PROTECTED_STORAGE_ACCESS_REJECTED')}})});
    try { callback(); } finally {
      if(descriptor)Object.defineProperty(chrome.runtime,'lastError',descriptor);else delete chrome.runtime.lastError;
    }
  };
  area.setAccessLevel=(options,callback)=>{
    fixture.calls.push({accessLevel:options.accessLevel,configImported:Boolean(globalThis.__managedRecoveryFixture),
      completedPurges:fixture.completedPurges,at:Date.now()});
    const fail=fixture.mode==='persistent'||(fixture.mode==='once'&&fixture.failures===0);
    if(fail){fixture.failures++;queueMicrotask(()=>failCallback(callback));return;}
    if(!nativeAccess){queueMicrotask(()=>failCallback(callback));return;}
    return nativeAccess(options,()=>{fixture.secured=!chrome.runtime.lastError;callback();});
  };
  area.remove=(keys,...rest)=>{
    if(keys==='studentSessionRecoveryV1'||(Array.isArray(keys)&&keys.length===1&&keys[0]==='studentSessionRecoveryV1')){
      fixture.purges++;
      const run=()=>nativeRemove(keys,()=>{fixture.completedPurges++;rest[0]?.();});
      if(fixture.holdPurge){nativeGet('__classpilotFixtureSkipPurgeHold',stored=>{
        void chrome.runtime.lastError;
        if(stored.__classpilotFixtureSkipPurgeHold)run();else fixture.heldPurges.push(run);
      });return;}
      return run();
    }
    return nativeRemove(keys,...rest);
  };
  area.set=(values,...rest)=>{
    if(Object.hasOwn(values||{},'studentSessionRecoveryV1')&&!fixture.secured)fixture.capabilityWritesBeforeSecure++;
    return nativeSet(values,...rest);
  };
  fixture.releasePurges=()=>{fixture.holdPurge=false;const queued=fixture.heldPurges.splice(0);queued.forEach(run=>run());return queued.length;};
})();
importScripts('service-worker.js');
`);
    manifest.background.service_worker = 'protected-storage-fixture.js';
  }
  manifest.content_scripts[0].js.unshift('managed-recovery-fixture.js');
  if (bootstrapOnly) manifest.content_scripts = manifest.content_scripts.filter(entry => !entry.js.includes('content.js'));
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
  writeFileSync(join(extensionPath, 'recovery-probe.html'), '<!doctype html><title>Private extension test probe</title>');
}

function executable() {
  const candidates = [process.env.CLASSPILOT_CHROME_PATH, chromium.executablePath(), 'C:/Program Files/Google/Chrome/Application/chrome.exe'];
  return candidates.find((candidate) => candidate && existsSync(candidate));
}

async function withBrowser({ legacyVersion = false, previousVersion=false, snapshotVersion=null, seed=null, quietNetwork=false, mode = 'ready', caseName = 'existing', pagePolicyMode = 'ready', bootstrapOnly = false, authReadMode='ready',authReadArea='local', protectedStorageFault=null }, run) {
  if (selectedCase && selectedCase !== caseName) return;
  if (compatibilityRun && RECOVERY_CASES[caseName]?.historicalUpgrade) {
    skippedHistoricalUpgrades.push(caseName);
    console.log(`NOT RUN ${caseName}: historical upgrade requires the modern-engine legacy gate; candidate compatibility cases still run.`);
    return;
  }
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
    if (snapshotVersion) for (const [name, source] of Object.entries(snapshots[snapshotVersion].files)) writeFileSync(join(extensionPath, name), source);
    const resolvedSeed = typeof seed === 'function' ? seed(fixture.origin) : seed;
    installManagedFixture(extensionPath, fixture.origin, mode, { pagePolicyMode, bootstrapOnly,authReadMode,authReadArea, seed: resolvedSeed, quietNetwork, protectedStorageFault });
    const executablePath = executable();
    assert.ok(executablePath, 'Install Playwright Chromium before running the recovery browser gate');
    const launchOptions = {
      executablePath, headless: true, viewport: { width: 1366, height: 768 },
      args: ['--headless=new', '--enable-unsafe-extension-debugging', `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    };
    context = await chromium.launchPersistentContext(profile, launchOptions);
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await waitForExtensionWorkerDeclarations(worker);
    const extensionId = new URL(worker.url()).host;
    const probe = await context.newPage();
    await probe.goto(`chrome-extension://${extensionId}/recovery-probe.html`);
    assert.equal(await worker.evaluate(() => isExplicitUnmanagedDevelopmentRuntime()), false);
    assert.equal(await worker.evaluate(() => isExplicitUnmanagedDevelopmentServer(CONFIG.serverUrl)), false);
    const restart = async (beforeLaunch = null) => {
      await context.close();
      await beforeLaunch?.(extensionPath);
      context=await chromium.launchPersistentContext(profile,launchOptions);
      const nextWorker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
      await waitForExtensionWorkerDeclarations(nextWorker);
      const nextProbe=await context.newPage();
      await nextProbe.goto(`chrome-extension://${extensionId}/recovery-probe.html`);
      return {context,worker:nextWorker,probe:nextProbe,extensionId,extensionPath,fixture,restart};
    };
    await run({ context, worker, probe, extensionId, extensionPath, fixture, restart });
    completedBrowserCases.push(caseName);
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
      if (currentVersion === version && await extensionWorkerDeclarationsReady(worker)) return worker;
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
        if (operation === 'deny-clipboard') {
          Object.defineProperty(navigator, 'clipboard', {
            configurable: true, value: { writeText: async () => { throw new DOMException('Denied by fixture', 'NotAllowedError'); } },
          });
          return true;
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

// --- startup-recovery helpers (2.9.0) ---------------------------------------
const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
const STARTUP_GATE_CODES = ['AUTH_GATE_STARTUP_TIMEOUT', 'AUTH_GATE_UNAVAILABLE'];

async function writeFault(worker, operation, payload = null) {
  return worker.evaluate(({ operation, payload }) => {
    const fixture = globalThis.__managedRecoveryFixture;
    if (operation === 'arm') {
      const target = { id: fixture.writeFaults.length + 1, area: 'local', method: 'set', requireKeys: [], excludeKeys: [], commitFirst: false, persistent: false,
        ...payload, matchedAttempts: 0, faultedAttempts: 0, consumed: false, healed: false, committed: false, faultedAt: null };
      fixture.writeFaults.push(target);
      return target.id;
    }
    if (operation === 'heal') {
      let healed = 0;
      for (const target of fixture.writeFaults) if (!target.healed && (!payload?.key || target.key === payload.key)) { target.healed = true; healed += 1; }
      return healed;
    }
    if (operation === 'release') return fixture.releaseHeldWrites(payload?.key, payload || {});
    const describeTarget = ({ id, key, area, method, mode, requireKeys, matchedAttempts, faultedAttempts, consumed, healed, committed, faultedAt, persistent, commitFirst }) => (
      { id, key, area, method, mode, requireKeys, matchedAttempts, faultedAttempts, consumed, healed, committed, faultedAt, persistent, commitFirst });
    return {
      targets: fixture.writeFaults.map(describeTarget),
      held: fixture.heldWrites.map(({ key, method, area, committed, heldAt }) => ({ key, method, area, committed, heldAt })),
      writeAttempts: { ...fixture.writeAttempts },
      writeLog: fixture.writeLog.slice(-80),
      monitoringEvents: fixture.monitoringEvents.map(({ type, emitted }) => ({ type, emitted: emitted === true })),
      authClears: fixture.authClears.map((event) => event.reason),
      diagnostics: fixture.diagnostics.slice(-40),
      lastErrorDelivery: fixture.lastErrorDelivery,
      faultDeliveryFailed: fixture.faultDeliveryFailed,
      readinessCapture: fixture.readinessCapture,
    };
  }, { operation, payload });
}
async function faultTarget(worker, id) {
  const summary = await writeFault(worker, 'summary');
  const target = summary.targets.find((item) => item.id === id);
  assert.ok(target, `fault target ${id} missing`);
  return target;
}
async function waitForHeldWakeAuthRead(worker, timeout = 6_000) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await worker.evaluate(() => __managedRecoveryFixture.authCallbacks.length) >= 1) return;
    await sleep(25);
  }
  throw new Error('fixture never held the wake auth snapshot read');
}
async function releaseWakeAuthRead(worker) {
  return worker.evaluate(() => {
    const fixture = __managedRecoveryFixture;
    fixture.authReadMode = 'ready';
    const callbacks = fixture.authCallbacks.splice(0);
    callbacks.forEach((callback) => callback());
    return callbacks.length;
  });
}
async function waitForHeldWrite(worker, key, { committed = false, timeout = 8_000 } = {}) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const held = (await writeFault(worker, 'summary')).held.find((item) => item.key === key);
    if (held && (!committed || held.committed)) return held;
    await sleep(50);
  }
  throw new Error(`fixture never held the targeted ${key} write (was the faulted operation attempted?)`);
}
async function gateProbe(probe) {
  const sentAt = Date.now();
  const response = await rpc(probe, { type: 'get-auth-state' });
  return { sentAt, repliedAt: Date.now(), response };
}
async function waitForGateCode(probe, code, timeout) {
  // One probe can take the complete 9s startup-response ceiling. Poll until the
  // gate reports `code` or the deadline passes; return the last observation.
  const until = Date.now() + timeout;
  let last = null;
  for (;;) {
    last = await gateProbe(probe);
    if (last.response?.errorCode === code || Date.now() >= until) return last;
    await sleep(200);
  }
}
function assertStartupGateFailure({ sentAt, response }, label) {
  assert.equal(response?.success, false, `${label}: gate must fail closed while startup is incomplete (${JSON.stringify(response)})`);
  assert.ok(STARTUP_GATE_CODES.includes(response?.errorCode), `${label}: unexpected gate code ${response?.errorCode}`);
  assert.ok(Number(response?.retryAt) >= sentAt + 2_000, `${label}: retryAt must be >= 2s after the request (${response?.retryAt} vs ${sentAt})`);
}
async function failedStartupOwners(worker) {
  return worker.evaluate(() => [...authGateStartupPublicationOwners.entries()]
    .filter(([, owner]) => owner.failed && !owner.settled && !owner.inFlight)
    .map(([kind, owner]) => ({ kind, attempts: owner.attempts, retryAt: owner.retryAt })));
}
// 2.9.0 keeps 2.8.9's presentation: an incomplete startup answers a poll with
// the startup watchdog code. What makes it actionable is the owner state behind
// that reply: a completed, retryable failure (never an owner left in flight
// forever) that an explicit Retry or the recovery alarm re-runs.
async function waitForStartupFailure(worker, probe, timeout) {
  const until = Date.now() + timeout;
  let last = null;
  for (;;) {
    last = await gateProbe(probe);
    let failedOwners = [];
    if (last.response?.success === false) {
      for (let i = 0; i < 20 && failedOwners.length === 0; i += 1) {
        failedOwners = await failedStartupOwners(worker);
        if (failedOwners.length === 0) await sleep(100);
      }
    }
    if (failedOwners.length > 0 || Date.now() >= until) return { ...last, failedOwners };
    await sleep(200);
  }
}
function assertActionableStartupFailure(settled, label) {
  assertStartupGateFailure(settled, label);
  assert.ok(settled.failedOwners.length >= 1, `${label}: startup must settle as a completed, retryable owner failure, not an owner left in flight (${JSON.stringify(settled.response)})`);
  for (const owner of settled.failedOwners) assert.ok(Number(owner.retryAt) > 0, `${label}: failed owner ${owner.kind} must carry a retry time`);
}
async function frameSupportCode(frame) {
  const text = (await frame.locator('#classpilot-auth-support-code').textContent().catch(() => '')) || '';
  return text.replace('Support code: ', '').trim() || null;
}
async function readDiagnostics(worker) {
  return worker.evaluate(() => new Promise((done) => chrome.storage.session.get('authGateDiagnosticsV1', (stored) => done(stored.authGateDiagnosticsV1 || []))));
}
async function startupOwners(worker) {
  return worker.evaluate(() => [...authGateStartupPublicationOwners.values()].map((owner) => (
    { kind: owner.kind, inFlight: Boolean(owner.inFlight), settled: owner.settled, failed: owner.failed, attempts: owner.attempts, retryAt: owner.retryAt })));
}
async function storedValue(worker, area, key) {
  return worker.evaluate(({ area, key }) => new Promise((done) => chrome.storage[area].get(key, (stored) => done(stored[key]))), { area, key });
}
async function workerAuthSummary(worker) {
  return worker.evaluate(() => ({
    startup: authGateStartupComplete, studentToken: CONFIG.studentToken, schoolId: CONFIG.schoolId, enrollmentKey: CONFIG.enrollmentKey,
    generation: managedAuthGatePolicyGeneration, invalidating: studentAuthInvalidating,
    pendingMutations: studentAuthMutationPendingCount, loginsPending: manualStudentLoginRequestsPending,
    serverUrl: CONFIG.serverUrl, loginPhase: sharedSignInLoginConfig?.phase ?? null,
    loginError: sharedSignInLoginConfig?.errorCode ?? sharedSignInLoginConfig?.error ?? null,
    legacyCleanupPending: Boolean(legacyStudentAuthCleanupAuthority),
  }));
}
async function driveStartupSupersession(worker, pages, newValue = 'fixture-enrollment-rotated') {
  // Hold the wake's native auth snapshot, rotate an authority key (strict
  // durable clear + startup authority transition), then let the held read
  // finish so the wake is superseded before it can adopt anything.
  await waitForHeldWakeAuthRead(worker);
  const oldValue = await worker.evaluate(() => __managedRecoveryFixture.policy.enrollmentKey);
  await managedChange(worker, pages, { enrollmentKey: { oldValue, newValue } });
  assert.equal(await releaseWakeAuthRead(worker), 1, 'fixture must actually hold the wake auth snapshot read');
}
async function dumpStartupState(worker, label) {
  const summary = await writeFault(worker, 'summary').catch((error) => ({ error: error.message }));
  const auth = await workerAuthSummary(worker).catch((error) => ({ error: error.message }));
  const owners = await startupOwners(worker).catch((error) => ({ error: error.message }));
  console.log(`[${label} diagnostics]`, JSON.stringify({ auth, owners, targets: summary.targets, held: summary.held, diagnostics: summary.diagnostics?.slice(-8), authClears: summary.authClears, delivery: summary.lastErrorDelivery, readiness: summary.readinessCapture }));
}
async function expectReady(page, timeout, worker, label, reason) {
  try { return await waitForPhase(page, 'ready', timeout); }
  catch (error) { await dumpStartupState(worker, label); throw new Error(`${reason}: ${error.message}`); }
}
async function openGatedPage(context, fixture, query) {
  const page = await context.newPage();
  await page.goto(`${fixture.origin}/classroom?${query}`);
  await page.locator('#classpilot-auth-gate').waitFor({ timeout: 3_000 });
  return page;
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
  await Promise.all(frames.map(frame => frame.evaluate(() => {
    window.__fixturePolicyRecoveryDocument = { hash: location.hash, timeOrigin: performance.timeOrigin };
  })));
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
  try { await Promise.all(pages.map(page => waitForPhase(page, 'ready'))); }
  catch (error) {
    await dumpStartupState(worker, 'policy-change recovered-read');
    console.log('Policy clear diagnostics', JSON.stringify(await worker.evaluate(() => ({
      clears: __managedRecoveryFixture.authClears, errors: __managedRecoveryFixture.nativeErrors,
      messages: __managedRecoveryFixture.messages.slice(-20), support: getAuthGateSupportDetails(),
      gate: getAuthGateState(), policyFailure: managedAuthGatePolicyFailure,
    }))));
    console.log('Policy recovered-read page diagnostics', JSON.stringify(await Promise.all(pages.map(async page => ({
      controller: await pageFixture(worker, page, 'summary'),
      responses: await worker.evaluate(async url => {
        const tab=(await chrome.tabs.query({})).find(item=>item.url===url);
        const [{result}]=await chrome.scripting.executeScript({target:{tabId:tab.id},func:()=>({responses:__managedPageFixture.responses.slice(-15),
          bootstrapState:globalThis.__classpilotAuthGateBootstrap?.lastState})});
        return result;
      },page.url()),
      frames: await Promise.all(page.frames().filter(frame => frame.url().includes('auth-gate-frame.html'))
        .map(frame => frame.evaluate(() => ({ phase: document.querySelector('#classpilot-auth-gate')?.dataset.classpilotAuthPhase,
          support: document.querySelector('#classpilot-auth-support-code')?.textContent, visibility: document.visibilityState,
          originalDocument:window.__fixturePolicyRecoveryDocument,hash:location.hash,timeOrigin:performance.timeOrigin })).catch(() => ({ detached: true })))),
    })))));
    const sameDocuments = await Promise.all(frames.map(frame => frame.evaluate(() => Boolean(
      window.__fixturePolicyRecoveryDocument && window.__fixturePolicyRecoveryDocument.hash !== location.hash,
    )).catch(() => false)));
    assert.equal(sameDocuments.some(Boolean), false,
      '[regression:auth-frame-document] a rotated fragment retained the failure-only extension document');
    throw error;
  }
  for (const page of pages) {
    const recoveredFrame = await waitForPhase(page, 'ready');
    assert.equal(await recoveredFrame.evaluate(() => window.__fixturePolicyRecoveryDocument), undefined,
      '[regression:auth-frame-document] retiring a failure-only policy frame must create a new extension document, not only change its fragment');
  }
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
  if (!reply?.success) {
    await dumpStartupState(worker, `auth-read-retry ${authReadArea}`);
    console.log('Auth-read retry messages', JSON.stringify(await worker.evaluate(() => ({
      messages: __managedRecoveryFixture.messages.slice(-15), reads: __managedRecoveryFixture.authReads,
      callbacks: __managedRecoveryFixture.authCallbacks.length, diagnostics: __managedRecoveryFixture.diagnostics.slice(-15),
      nativeErrors: __managedRecoveryFixture.nativeErrors, listeners: chrome.runtime.onMessage.hasListeners(),
      activeState: self.registration.active?.state, workerState: self.serviceWorker?.state,
    }))));
  }
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
  // 2.9.0: the response deadline reconciled the unresolved native read as a
  // completed failure (a read has no intended state to verify by re-reading),
  // so the explicit Retry re-runs it exactly once for both frames. The original
  // callback stays held and, when released later, can never become authority.
  const afterRetry=await worker.evaluate(()=>({reads:__managedRecoveryFixture.authReads,pending:__managedRecoveryFixture.authCallbacks.length,startup:authGateStartupComplete}));
  assert.equal(afterRetry.reads,2,'concurrent Retry re-issues the reconciled native read exactly once');
  assert.equal(afterRetry.pending,2,'the abandoned original read is never replayed by the deadline');
  assert.equal(afterRetry.startup,false);
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

await withBrowser({ caseName: 'upgrade-2.8.6', legacyVersion: true }, async ({ context, worker, probe, extensionId, extensionPath, fixture }) => {
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

// ---------------------------------------------------------------------------
// Same-ID upgrades from the immutable 2.8.8 and 2.8.9 snapshots. These mirror
// upgrade-2.8.7 exactly and record the honest outcome (cooperative controller
// replacement or the explicit protected manual-reload fallback).
for (const snapshotVersion of ['2.8.8', '2.8.9']) await withBrowser({ caseName: `upgrade-${snapshotVersion}`, snapshotVersion }, async ({ context, worker, extensionId, extensionPath, fixture }) => {
  assert.notEqual(candidateVersion, snapshotVersion, `upgrade candidate must differ from immutable ${snapshotVersion}`);
  assert.equal(await worker.evaluate(() => chrome.runtime.getManifest().version), snapshotVersion);
  const page = await context.newPage(); await page.goto(`${fixture.origin}/classroom?upgrade=${snapshotVersion.replace(/\./g, '')}`);
  await waitForPhase(page, 'ready', 12_000, snapshotVersion); await assertProtected(page);
  const loads = fixture.state.pageLoads;
  cpSync(sourceRoot, extensionPath, { recursive: true }); installManagedFixture(extensionPath, fixture.origin, 'ready');
  const session = await context.browser().newBrowserCDPSession();
  const installed = await session.send('Extensions.loadUnpacked', { path: extensionPath }); await session.detach();
  assert.equal(installed.id, extensionId);
  const updated = await waitForWorkerVersion(context, extensionId, candidateVersion);
  const probe = await context.newPage(); await probe.goto(`chrome-extension://${extensionId}/recovery-probe.html`);
  assert.equal((await rpc(probe, { type: 'refresh-auth-state', reason: 'user' }))?.success, true);
  let recovery = 'cooperative';
  try { await waitForPhase(page, 'ready', 15_000); }
  catch (error) {
    const outcomes = await updated.evaluate(async (url) => {
      const tab = (await chrome.tabs.query({})).find((item) => item.url === url);
      return __managedRecoveryFixture.pageOutcomes.filter((item) => item.tabId === tab?.id).map(({ status, reason }) => ({ status, reason }));
    }, page.url());
    assert.equal(outcomes.at(-1)?.status, 'manual_reload_required', `upgrade has no explicit safe fallback: ${error.message}`);
    assert.equal(outcomes.at(-1)?.reason, 'ownership_unproven');
    await assertProtected(page); assert.equal(fixture.state.pageLoads, loads, 'ambiguous old realm must not authorize automatic reload');
    recovery = 'manual_ownership_unproven';
    await page.reload(); await waitForPhase(page, 'ready');
  }
  await assertProtected(page);
  const expectedLoads = loads + (recovery === 'cooperative' ? 0 : 1);
  assert.equal(fixture.state.pageLoads, expectedLoads);
  const files = [...new Set(JSON.parse(readFileSync(join(sourceRoot, 'manifest.json'), 'utf8')).content_scripts.flatMap((entry) => entry.js))];
  const ownership = await updated.evaluate(async ({ url, files }) => {
    const tab = (await chrome.tabs.query({})).find((item) => item.url === url);
    const inspect = async () => {
      const [{ result }] = await chrome.scripting.executeScript({ target: { tabId: tab.id }, func: () => globalThis.ClassPilotPageLifecycle.inspect() });
      return result.map(({ kind, version, instanceId, active }) => ({ kind, version, instanceId, active }));
    };
    const before = await inspect();
    for (let i = 0; i < 3; i++) await chrome.scripting.executeScript({ target: { tabId: tab.id }, files });
    return { before, after: await inspect() };
  }, { url: page.url(), files });
  assert.deepEqual(ownership.after, ownership.before, 'same-version injection must reuse owned controllers');
  assert.deepEqual(ownership.after.map((item) => item.kind).sort(), ['bootstrap', 'content']);
  assert.ok(ownership.after.every((item) => item.version === candidateVersion && item.active));
  await waitForPhase(page, 'ready'); await assertProtected(page);
  assert.equal(fixture.state.pageLoads, expectedLoads); assert.equal(fixture.state.studentLoginRequests, 0);
  console.log(`PASS same-ID ${snapshotVersion}→${candidateVersion} upgrade (${recovery}), one gate and repeated-injection controller reuse`);
});

// ---------------------------------------------------------------------------
// Startup-recovery cases (2.9.0). Every `expectedRedOnBase` case below is proven
// red on unmodified 2.8.9 by scripts/test-extension-recovery-red-on-old.mjs.

await withBrowser({ caseName: 'startup-policy-write-failure', authReadMode: 'never' }, async ({ context, worker, probe, fixture }) => {
  const page = await openGatedPage(context, fixture, 'case=policy-write-failure');
  // Fault only the transition's own policy persistence ({binding, config}); the
  // wake's fire-and-forget descriptor write has a different shape.
  const target = await writeFault(worker, 'arm', { key: 'managedAuthGateBindingV1', requireKeys: ['config'], mode: 'reject-before-commit', persistent: true });
  const configRequests = fixture.state.configRequests;
  const started = Date.now();
  await driveStartupSupersession(worker, [page]);
  const frame = await waitForPhase(page, 'unavailable', 12_000);
  const firstCode = await frameSupportCode(frame);
  assert.ok(STARTUP_GATE_CODES.includes(firstCode), `generic unavailable card must carry a startup support code (${firstCode})`);
  await assertProtected(page);
  assert.ok((await faultTarget(worker, target)).faultedAttempts >= 1, 'fixture must actually reject the transition policy write');
  // Either code is acceptable while the 9s response window elapses; a completed
  // policy-write failure must then settle as an actionable failure.
  const settled = await waitForStartupFailure(worker, probe, 20_000);
  assertActionableStartupFailure(settled, 'startup policy-write failure');
  assert.equal((await workerAuthSummary(worker)).startup, false, 'readiness must not publish over a failed policy write');
  assert.equal(fixture.state.configRequests, configRequests, 'an unpersisted policy must not fetch login configuration');
  const beforeHeal = await faultTarget(worker, target);
  assert.equal(await writeFault(worker, 'heal', { key: 'managedAuthGateBindingV1' }), 1);
  await clickRetry(frame);
  await expectReady(page, 15_000, worker, 'startup-policy-write-failure', 'after the healed policy write and an explicit Retry the sign-in form must appear');
  await assertProtected(page);
  const afterHeal = await faultTarget(worker, target);
  assert.equal(afterHeal.faultedAttempts, beforeHeal.faultedAttempts, 'no policy write may fail after healing');
  assert.equal(afterHeal.matchedAttempts - afterHeal.faultedAttempts, 1, `policy binding must be written exactly once after healing (${JSON.stringify(afterHeal)})`);
  const auth = await workerAuthSummary(worker);
  assert.equal(auth.startup, true); assert.equal(auth.enrollmentKey, 'fixture-enrollment-rotated'); assert.equal(auth.studentToken, null);
  assert.equal((await storedValue(worker, 'local', 'config'))?.enrollmentKey, 'fixture-enrollment-rotated');
  assert.equal(fixture.state.studentLoginRequests, 0);
  console.log('PASS startup policy-write failure is actionable; healed write + Retry recovers with one binding write', JSON.stringify({ firstCode, settledMs: settled.repliedAt - started, target: afterHeal }));
});

await withBrowser({ caseName: 'startup-auth-cleanup-failure', authReadMode: 'never' }, async ({ context, worker, probe, fixture }) => {
  const page = await openGatedPage(context, fixture, 'case=auth-cleanup-failure');
  // clearStoredAuthState's {config, autoRegistrationPaused} write; the policy
  // persistence ({binding, config}) and login commits have other shapes.
  const target = await writeFault(worker, 'arm', { key: 'config', requireKeys: ['autoRegistrationPaused'], mode: 'reject-before-commit', persistent: true });
  await driveStartupSupersession(worker, [page]);
  const frame = await waitForPhase(page, 'unavailable', 12_000);
  await assertProtected(page);
  assert.ok((await faultTarget(worker, target)).faultedAttempts >= 1, 'fixture must actually reject the cleanup config write');
  assert.equal(await storedValue(worker, 'local', 'studentAuthInvalidatingV1'), true, 'crash marker must persist while the durable clear is failed');
  const settled = await waitForStartupFailure(worker, probe, 20_000);
  assertActionableStartupFailure(settled, 'startup cleanup failure');
  assert.equal(await storedValue(worker, 'local', 'studentAuthInvalidatingV1'), true, 'crash marker must still be set after the failure is reported');
  assert.equal((await workerAuthSummary(worker)).startup, false);
  const beforeHeal = await faultTarget(worker, target);
  assert.equal(await writeFault(worker, 'heal', { key: 'config' }), 1);
  await clickRetry(frame);
  await expectReady(page, 15_000, worker, 'startup-auth-cleanup-failure', 'after healing the cleanup write an explicit Retry must replay the clear and show the sign-in form');
  await assertProtected(page);
  assert.equal(await storedValue(worker, 'local', 'studentAuthInvalidatingV1'), undefined, 'the resumed clear must remove the crash marker last');
  const afterHeal = await faultTarget(worker, target);
  const summary = await writeFault(worker, 'summary');
  assert.equal(afterHeal.faultedAttempts, beforeHeal.faultedAttempts);
  // Every clear before healing was one faulted replay of the authority clear;
  // after healing it is replayed exactly once, never duplicated. A clear with
  // pauseAutoRegistration deliberately keeps the invalidating fence raised, so
  // the fresh-policy revalidation that a user Retry runs after readiness (2.8.8
  // behavior) may perform at most one further idempotent clear.
  const authorityClears = summary.authClears.filter((reason) => reason === 'managed_auth_authority_changed').length;
  assert.equal(authorityClears, beforeHeal.faultedAttempts + 1, `the authority clear must be replayed exactly once after healing (${JSON.stringify(summary.authClears)})`);
  const extraClears = summary.authClears.filter((reason) => reason !== 'managed_auth_authority_changed');
  assert.ok(extraClears.length <= 1 && extraClears.every((reason) => reason === 'managed_policy_direct_revalidation'), `only the fresh-policy Retry revalidation may clear once more (${JSON.stringify(summary.authClears)})`);
  const healedWrites = afterHeal.matchedAttempts - afterHeal.faultedAttempts;
  assert.ok(healedWrites >= 1 && healedWrites <= 1 + extraClears.length, `cleanup config is written once per clear after healing (${JSON.stringify({ target: afterHeal, authClears: summary.authClears })})`);
  const cleared = summary.monitoringEvents.filter((event) => event.type === 'restriction_state_cleared');
  assert.ok(cleared.filter((event) => event.emitted).length <= 1, `restriction_state_cleared must be emitted at most once (${JSON.stringify(cleared)})`);
  const auth = await workerAuthSummary(worker);
  assert.equal(auth.startup, true); assert.equal(auth.studentToken, null); assert.equal(auth.enrollmentKey, 'fixture-enrollment-rotated');
  assert.equal(fixture.state.studentLoginRequests, 0);
  console.log('PASS startup cleanup-write failure keeps the crash marker, healed write + Retry replays the clear once', JSON.stringify({ target: afterHeal, restrictionCleared: cleared, authClears: summary.authClears }));
});

await withBrowser({ caseName: 'commit-then-fail', authReadMode: 'never' }, async ({ context, worker, fixture }) => {
  const page = await openGatedPage(context, fixture, 'case=commit-then-fail');
  const target = await writeFault(worker, 'arm', { key: 'config', requireKeys: ['autoRegistrationPaused'], mode: 'commit-then-fail' });
  await driveStartupSupersession(worker, [page]);
  await expectReady(page, 15_000, worker, 'commit-then-fail', 'a committed-then-failed cleanup write must be reconciled by a fresh read and readiness must complete');
  await assertProtected(page);
  const summary = await writeFault(worker, 'summary');
  assert.equal(summary.faultDeliveryFailed, false, 'harness could not deliver a native callback failure');
  const after = summary.targets.find((item) => item.id === target);
  assert.equal(after.faultedAttempts, 1, 'fixture must fail exactly the committed write');
  assert.equal(after.committed, true, 'fixture must have committed the write before reporting failure');
  // The reconciled clear continues without re-issuing its committed write and
  // is never replayed. The page controller's fence acknowledgement after a
  // managed change runs 2.8.8's fresh-policy revalidation, which clears once
  // more while the paused clear keeps the invalidating fence raised.
  const authorityClears = summary.authClears.filter((reason) => reason === 'managed_auth_authority_changed').length;
  assert.equal(authorityClears, 1, `the reconciled clear must never be replayed (${JSON.stringify(summary.authClears)})`);
  const extraClears = summary.authClears.filter((reason) => reason !== 'managed_auth_authority_changed');
  assert.ok(extraClears.length <= 1 && extraClears.every((reason) => reason === 'managed_policy_direct_revalidation'), `only the fence-acknowledging policy revalidation may clear once more (${JSON.stringify(summary.authClears)})`);
  assert.equal(after.matchedAttempts, 1 + extraClears.length, `a committed write must not be repeated after its callback failure (${JSON.stringify({ target: after, authClears: summary.authClears })})`);
  const diagnostics = await readDiagnostics(worker);
  assert.ok(diagnostics.some((entry) => entry.stage === 'startup' && entry.cause === 'reconciled'), `expected a startup/reconciled diagnostic (${JSON.stringify(diagnostics)})`);
  const recoveryWrites = summary.writeLog.filter((entry) => entry.at >= after.faultedAt && entry.keys.includes('studentSessionRecoveryV1'));
  assert.deepEqual(recoveryWrites, [], 'studentSessionRecoveryV1 must not be rewritten by the reconciled clear');
  assert.equal(await storedValue(worker, 'local', 'studentAuthInvalidatingV1'), undefined, 'the completed clear must remove the crash marker last');
  const auth = await workerAuthSummary(worker);
  assert.equal(auth.startup, true); assert.equal(auth.studentToken, null); assert.equal(auth.enrollmentKey, 'fixture-enrollment-rotated');
  assert.equal(fixture.state.studentLoginRequests, 0);
  console.log('PASS commit-then-fail cleanup write reconciled without a duplicate write', JSON.stringify({ delivery: summary.lastErrorDelivery, target: after }));
});

for (const committed of [true, false]) await withBrowser({ caseName: committed ? 'stalled-write-committed' : 'stalled-write-lost', authReadMode: 'never' }, async ({ context, worker, probe, fixture }) => {
  const label = committed ? 'stalled-write-committed' : 'stalled-write-lost';
  const page = await openGatedPage(context, fixture, `case=${label}`);
  // The clear's final crash-marker removal ({invalidating, commitPending}) is
  // the op whose intended state (key absent) a fresh read can verify.
  const target = await writeFault(worker, 'arm', { key: 'studentAuthInvalidatingV1', method: 'remove', requireKeys: ['studentAuthCommitPendingV1'], mode: 'never', commitFirst: committed });
  await driveStartupSupersession(worker, [page]);
  await waitForHeldWrite(worker, 'studentAuthInvalidatingV1', { committed });
  const heldAt = Date.now();
  assert.equal(await storedValue(worker, 'local', 'studentAuthInvalidatingV1'), committed ? undefined : true, 'fixture commit/loss precondition');
  // The authority clear's marker removal is the faulted op. After readiness the
  // page controller's fence acknowledgement runs 2.8.8's fresh-policy
  // revalidation, which clears again while the paused clear keeps the
  // invalidating fence raised; those clears are the only other removals allowed.
  const clearCounts = async () => {
    const summary = await writeFault(worker, 'summary');
    const extra = summary.authClears.filter((reason) => reason !== 'managed_auth_authority_changed');
    assert.ok(extra.every((reason) => reason === 'managed_policy_direct_revalidation'), `only fence-acknowledging policy revalidations may clear again (${JSON.stringify(summary.authClears)})`);
    return { authority: summary.authClears.length - extra.length, extra: extra.length, authClears: summary.authClears };
  };
  if (committed) {
    await expectReady(page, 14_000, worker, label, 'a stalled-but-committed marker removal must be reconciled by a fresh read within ~9-12s and readiness must complete');
    const readyMs = Date.now() - heldAt;
    await assertProtected(page);
    {
      const counts = await clearCounts();
      assert.equal(counts.authority, 1, `a reconciled stalled clear must never be replayed (${JSON.stringify(counts.authClears)})`);
      assert.equal((await faultTarget(worker, target)).matchedAttempts, 1 + counts.extra, `a reconciled stalled removal must not be re-issued (${JSON.stringify(counts.authClears)})`);
    }
    const diagnostics = await readDiagnostics(worker);
    assert.ok(diagnostics.some((entry) => entry.stage === 'startup' && entry.cause === 'reconciled'), `expected a startup/reconciled diagnostic (${JSON.stringify(diagnostics)})`);
    assert.equal((await writeFault(worker, 'release', { key: 'studentAuthInvalidatingV1' })).length, 1);
    await sleep(600);
    {
      const counts = await clearCounts();
      assert.equal(counts.authority, 1, 'the late native completion must be inert');
      assert.equal((await faultTarget(worker, target)).matchedAttempts, 1 + counts.extra, `the late native completion must be inert (${JSON.stringify(counts.authClears)})`);
    }
    await waitForPhase(page, 'ready'); await assertProtected(page);
    console.log('PASS stalled committed startup write reconciled by read', JSON.stringify({ readyMs }));
  } else {
    const settled = await waitForStartupFailure(worker, probe, 16_000);
    assertActionableStartupFailure(settled, label);
    const unavailableMs = settled.repliedAt - heldAt;
    assert.ok(unavailableMs >= 8_500 && unavailableMs <= 16_500, `stall must be given ~9s before being declared lost (${unavailableMs}ms)`);
    const diagnostics = await readDiagnostics(worker);
    assert.ok(diagnostics.some((entry) => entry.stage === 'startup' && entry.cause === 'stalled'), `expected a startup/stalled diagnostic (${JSON.stringify(diagnostics)})`);
    assert.equal(await storedValue(worker, 'local', 'studentAuthInvalidatingV1'), true, 'a lost removal leaves the crash marker in place');
    // The deadline reconciles by read and never re-issues the lost write.
    assert.equal((await faultTarget(worker, target)).matchedAttempts, 1, 'the deadline itself never re-issues the lost write');
    // Unattended recovery: the page-driven backoff re-runs the failed clear
    // owner once, replaying the whole idempotent clear (the fixture no longer
    // holds it). Explicit Retry after a lost hold is covered by held-ops.
    await expectReady(page, 15_000, worker, label, 'bounded backoff must replay the lost clear and recover without user action');
    await assertProtected(page);
    assert.equal(await storedValue(worker, 'local', 'studentAuthInvalidatingV1'), undefined);
    {
      const counts = await clearCounts();
      assert.equal(counts.authority, 2, `backoff replays the lost clear exactly once (${JSON.stringify(counts.authClears)})`);
      assert.equal((await faultTarget(worker, target)).matchedAttempts, 2 + counts.extra, `recovery replays the marker removal exactly once (${JSON.stringify(counts.authClears)})`);
    }
    // The stale native callback, released after recovery, is inert.
    assert.equal((await writeFault(worker, 'release', { key: 'studentAuthInvalidatingV1' })).length, 1);
    await sleep(600);
    {
      const counts = await clearCounts();
      assert.equal(counts.authority, 2, 'releasing the stale callback must not replay the clear');
      assert.equal((await faultTarget(worker, target)).matchedAttempts, 2 + counts.extra, `releasing the stale callback must not trigger a duplicate write (${JSON.stringify(counts.authClears)})`);
      assert.equal(await storedValue(worker, 'local', 'studentAuthInvalidatingV1'), undefined, 'a late stale callback cannot resurrect the crash marker');
    }
    console.log('PASS stalled lost startup write becomes actionable and recovers through bounded backoff; late callback inert', JSON.stringify({ unavailableMs }));
  }
  assert.equal(fixture.state.studentLoginRequests, 0);
});

await withBrowser({ caseName: 'abandoned-then-newer-policy', authReadMode: 'never' }, async ({ context, worker, fixture }) => {
  const page = await openGatedPage(context, fixture, 'case=abandoned-then-newer-policy');
  const target = await writeFault(worker, 'arm', { key: 'managedAuthGateBindingV1', requireKeys: ['config'], mode: 'never' });
  await driveStartupSupersession(worker, [page], 'fixture-enrollment-rotated-1');
  await waitForHeldWrite(worker, 'managedAuthGateBindingV1');
  const firstGeneration = (await workerAuthSummary(worker)).generation;
  await managedChange(worker, [page], { enrollmentKey: { oldValue: 'fixture-enrollment-rotated-1', newValue: 'fixture-enrollment-rotated-2' } });
  await expectReady(page, 14_000, worker, 'abandoned-then-newer-policy', 'a newer managed policy must let readiness join the current transition while the abandoned first policy write is unresolved');
  await assertProtected(page);
  const current = await workerAuthSummary(worker);
  assert.equal(current.startup, true);
  assert.ok(current.generation > firstGeneration, 'newer policy must own a newer generation');
  assert.equal(current.enrollmentKey, 'fixture-enrollment-rotated-2');
  assert.equal((await storedValue(worker, 'local', 'config'))?.enrollmentKey, 'fixture-enrollment-rotated-2');
  // Binding writes: the abandoned (held) first policy, the newer transition's
  // own persist, plus one per fence-acknowledging policy revalidation (2.8.8
  // behavior after any managed change; it clears again while the paused
  // authority clear keeps the invalidating fence raised).
  const revalidations = async () => {
    const summary = await writeFault(worker, 'summary');
    const extra = summary.authClears.filter((reason) => reason !== 'managed_auth_authority_changed');
    assert.ok(extra.every((reason) => reason === 'managed_policy_direct_revalidation'), `only fence-acknowledging policy revalidations may clear (${JSON.stringify(summary.authClears)})`);
    return { count: extra.length, authClears: summary.authClears };
  };
  const afterRecovery = await revalidations();
  assert.equal((await faultTarget(worker, target)).matchedAttempts, 2 + afterRecovery.count, `the newer transition writes its own policy exactly once (${JSON.stringify(afterRecovery.authClears)})`);
  assert.equal((await writeFault(worker, 'release', { key: 'managedAuthGateBindingV1' })).length, 1);
  await sleep(800);
  assert.deepEqual(await workerAuthSummary(worker), current, 'late completion of the abandoned policy write must be rejected without state change');
  assert.equal((await storedValue(worker, 'local', 'config'))?.enrollmentKey, 'fixture-enrollment-rotated-2');
  const afterRelease = await revalidations();
  assert.equal((await faultTarget(worker, target)).matchedAttempts, 2 + afterRelease.count, `the abandoned write must not be re-issued (${JSON.stringify(afterRelease.authClears)})`);
  await waitForPhase(page, 'ready'); await assertProtected(page);
  assert.equal(fixture.state.studentLoginRequests, 0);
  console.log('PASS abandoned startup policy write is superseded by a newer policy; its late completion is rejected', JSON.stringify({ firstGeneration, current }));
});

await withBrowser({ caseName: 'post-snapshot-supersession', authReadMode: 'never' }, async ({ context, worker, fixture }) => {
  const page = await openGatedPage(context, fixture, 'case=post-snapshot-supersession');
  await waitForHeldWakeAuthRead(worker);
  await worker.evaluate(() => {
    const fixture = __managedRecoveryFixture;
    // Capture worker state at the exact moment readiness is published.
    const nativeMark = markAuthStateRestored;
    markAuthStateRestored = () => {
      if (!fixture.readinessCapture) {
        fixture.readinessCapture = { at: Date.now(), pendingMutations: studentAuthMutationPendingCount, invalidating: studentAuthInvalidating, studentToken: CONFIG.studentToken, markerRead: null };
        chrome.storage.local.get('studentAuthInvalidatingV1', (stored) => { fixture.readinessCapture.markerRead = stored.studentAuthInvalidatingV1 === true; });
      }
      return nativeMark();
    };
    globalThis.__heldMutation = enqueueStudentAuthMutation(() => new Promise((release) => { globalThis.__releaseHeld = release; }));
    globalThis.__heldMutation.catch(() => {});
  });
  assert.equal(await releaseWakeAuthRead(worker), 1);
  await sleep(500);
  const queued = await worker.evaluate(() => ({ pending: studentAuthMutationPendingCount, startup: authGateStartupComplete }));
  assert.ok(queued.pending >= 2, `the wake's restore must be queued behind the held mutation (${JSON.stringify(queued)})`);
  assert.equal(queued.startup, false);
  await managedChange(worker, [page], { enrollmentKey: { oldValue: 'fixture-enrollment', newValue: 'fixture-enrollment-rotated' } });
  await sleep(250);
  await worker.evaluate(() => { globalThis.__releaseHeld(); });
  await expectReady(page, 14_000, worker, 'post-snapshot-supersession', 'a wake superseded after its snapshot must join the current signed-out policy and publish readiness');
  await assertProtected(page);
  const capture = await worker.evaluate(() => __managedRecoveryFixture.readinessCapture);
  assert.ok(capture, 'readiness publication was not observed');
  assert.equal(capture.pendingMutations, 0, `readiness must not publish while the durable clear is still queued (${JSON.stringify(capture)})`);
  assert.equal(capture.markerRead, false, 'readiness must not publish before the crash marker is removed');
  assert.equal(capture.studentToken, null, 'the superseded snapshot must never be adopted');
  const auth = await workerAuthSummary(worker);
  assert.equal(auth.studentToken, null); assert.equal(auth.enrollmentKey, 'fixture-enrollment-rotated'); assert.equal(auth.pendingMutations, 0);
  const diagnostics = await readDiagnostics(worker);
  assert.ok(diagnostics.some((entry) => entry.stage === 'startup' && entry.cause === 'superseded_joined'), `expected a startup/superseded_joined diagnostic (${JSON.stringify(diagnostics)})`);
  assert.equal(fixture.state.studentLoginRequests, 0);
  console.log('PASS post-snapshot supersession joins current policy without adopting the stale snapshot', JSON.stringify({ capture }));
});

await withBrowser({ caseName: 'competing-login', authReadMode: 'never' }, async ({ context, worker, probe, fixture }) => {
  const page = await openGatedPage(context, fixture, 'case=competing-login');
  await waitForHeldWakeAuthRead(worker);
  await probe.evaluate(() => {
    window.__login = new Promise((done) => chrome.runtime.sendMessage(
      { type: 'manual-student-login', payload: { studentName: 'Fixture Student', pin: '1234', gradeLevel: '9' } },
      (response) => done({ response: response || null, error: chrome.runtime.lastError?.message || null }),
    ));
  });
  const until = Date.now() + 3_000;
  let pending = 0;
  while (Date.now() < until && pending === 0) { pending = await worker.evaluate(() => manualStudentLoginRequestsPending); if (pending === 0) await sleep(25); }
  assert.equal(pending, 1, 'a manual login must be in flight before the startup transition');
  await managedChange(worker, [page], { enrollmentKey: { oldValue: 'fixture-enrollment', newValue: 'fixture-enrollment-rotated' } });
  assert.equal(await releaseWakeAuthRead(worker), 1);
  await expectReady(page, 14_000, worker, 'competing-login', 'startup readiness must recover with a manual login in flight instead of deadlocking on it');
  await assertProtected(page);
  const login = await probe.evaluate(() => Promise.race([window.__login, new Promise((done) => setTimeout(() => done({ response: null, error: 'FIXTURE_LOGIN_UNSETTLED' }), 15_000))]));
  assert.notEqual(login.error, 'FIXTURE_LOGIN_UNSETTLED', 'the in-flight login must settle once readiness is published');
  assert.notEqual(login.response?.success, true, 'the fixture login must not succeed');
  const auth = await workerAuthSummary(worker);
  assert.equal(auth.loginsPending, 0); assert.equal(auth.studentToken, null); assert.equal(auth.enrollmentKey, 'fixture-enrollment-rotated');
  const summary = await writeFault(worker, 'summary');
  assert.ok(summary.authClears.includes('managed_auth_authority_changed'), `authority clear missing (${summary.authClears})`);
  assert.ok(!summary.authClears.some((reason) => String(reason).startsWith('student_login_')), `a rejected competing login must not trigger its own auth clear (${summary.authClears})`);
  console.log('PASS competing manual login does not deadlock startup readiness', JSON.stringify({ login, authClears: summary.authClears }));
});

await withBrowser({ caseName: 'held-ops-concurrency', authReadMode: 'never' }, async ({ context, worker, probe, fixture }) => {
  const pages = [];
  for (const tab of [1, 2, 3]) pages.push(await openGatedPage(context, fixture, `case=held-ops&tab=${tab}`));
  const target = await writeFault(worker, 'arm', { key: 'studentAuthInvalidatingV1', method: 'remove', requireKeys: ['studentAuthCommitPendingV1'], mode: 'never' });
  await driveStartupSupersession(worker, pages);
  await waitForHeldWrite(worker, 'studentAuthInvalidatingV1');
  const heldAt = Date.now();
  const configRequests = fixture.state.configRequests;
  // Phase 1: while the native write is unresolved (inside its 9s reconcile
  // window) user retries, page polls and the recovery alarm all coalesce on
  // the in-flight owner. Nothing may re-issue the write.
  const earlyRetries = probe.evaluate(() => Promise.all([1, 2].map(() => new Promise((done) => chrome.runtime.sendMessage(
    { type: 'refresh-auth-state', reason: 'user' }, (response) => { void chrome.runtime.lastError; done(response || null); })))));
  await worker.evaluate(() => {
    chrome.alarms.create('auth-gate-startup-publication-recovery', { when: Date.now() });
    retryAuthGateStartupPublications({ userInitiated: true });
  });
  await sleep(1_500);
  assert.equal((await faultTarget(worker, target)).matchedAttempts, 1, 'user retries, page polls and the recovery alarm must never re-issue an unresolved native write');
  assert.equal((await workerAuthSummary(worker)).startup, false);
  // Phase 2: the deadline reconciles the uncommitted hold as lost. Startup is
  // then a completed, retryable owner failure behind the watchdog card. Observe
  // the owner directly: the page-driven backoff re-runs it about 2s later.
  const frames = await Promise.all(pages.map((page) => waitForPhase(page, 'unavailable', 12_000)));
  const failedAt = Date.now();
  let failedOwners = [];
  while (failedOwners.length === 0 && Date.now() - failedAt < 3_000) { failedOwners = await failedStartupOwners(worker); if (failedOwners.length === 0) await sleep(50); }
  const unavailableMs = Date.now() - heldAt;
  assert.ok(failedOwners.some((owner) => owner.kind === 'signed_out_clear' && Number(owner.retryAt) > 0), `the lost hold must settle as a completed, retryable clear-owner failure (${JSON.stringify(failedOwners)})`);
  assert.ok(unavailableMs >= 8_500 && unavailableMs <= 16_500, `the hold must be given ~9s before being declared lost (${unavailableMs}ms)`);
  for (const frame of frames) assert.ok(STARTUP_GATE_CODES.includes(await frameSupportCode(frame)), 'every tab shows the startup gate card');
  for (const reply of await earlyRetries) assert.notEqual(reply?.success, true, 'user retries must not report success while the write is unresolved');
  assert.equal((await faultTarget(worker, target)).matchedAttempts, 1, 'the deadline itself never re-issues the write');
  assert.equal(await storedValue(worker, 'local', 'studentAuthInvalidatingV1'), true, 'a lost removal leaves the crash marker in place');
  for (const page of pages) await assertProtected(page);
  assert.equal(fixture.state.configRequests, configRequests, 'no login-config traffic while startup is unresolved');
  // Phase 3: three tabs, two more user retries, a Retry click, the page-timer
  // backoff and the recovery alarm all coalesce on one re-run of the failed
  // owner. The replayed clear re-issues the removal exactly once and recovers.
  const lateRetries = probe.evaluate(() => Promise.all([1, 2].map(() => new Promise((done) => chrome.runtime.sendMessage(
    { type: 'refresh-auth-state', reason: 'user' }, (response) => { void chrome.runtime.lastError; done(response || null); })))));
  await clickRetry(frames[0]).catch(() => {});
  await worker.evaluate(() => { chrome.alarms.create('auth-gate-startup-publication-recovery', { when: Date.now() }); });
  await Promise.all(pages.map((page) => expectReady(page, 15_000, worker, 'held-ops-concurrency', 'recovery must follow exactly one re-run of the lost clear')));
  for (const page of pages) await assertProtected(page);
  const summary = await writeFault(worker, 'summary');
  const authorityClears = summary.authClears.filter((reason) => reason === 'managed_auth_authority_changed').length;
  const extraClears = summary.authClears.filter((reason) => reason !== 'managed_auth_authority_changed');
  assert.equal(authorityClears, 2, `the lost clear is replayed exactly once across all retries (${JSON.stringify(summary.authClears)})`);
  assert.ok(extraClears.every((reason) => reason === 'managed_policy_direct_revalidation'), `only fence-acknowledging policy revalidations may clear again (${JSON.stringify(summary.authClears)})`);
  assert.equal((await faultTarget(worker, target)).matchedAttempts, 2 + extraClears.length, `all retries re-issue the lost write exactly once (${JSON.stringify(summary.authClears)})`);
  assert.equal(await storedValue(worker, 'local', 'studentAuthInvalidatingV1'), undefined);
  for (const reply of await lateRetries) assert.equal(reply?.success, true, `concurrent user retries share the single recovery (${JSON.stringify(reply)})`);
  // The stale native callback, released after recovery, is inert.
  assert.equal((await writeFault(worker, 'release', { key: 'studentAuthInvalidatingV1' })).length, 1);
  await sleep(600);
  {
    const after = await writeFault(worker, 'summary');
    const extraAfter = after.authClears.filter((reason) => reason !== 'managed_auth_authority_changed').length;
    assert.equal(after.authClears.filter((reason) => reason === 'managed_auth_authority_changed').length, 2, 'releasing the stale callback must not replay the clear');
    assert.equal((await faultTarget(worker, target)).matchedAttempts, 2 + extraAfter, 'releasing the stale callback must not trigger a duplicate write');
  }
  assert.equal(await storedValue(worker, 'local', 'studentAuthInvalidatingV1'), undefined, 'a late stale callback cannot resurrect the crash marker');
  assert.equal(fixture.state.studentLoginRequests, 0);
  console.log('PASS held startup write: 3 tabs, user retries, polls and the alarm coalesce until the deadline; one re-run recovers', JSON.stringify({ unavailableMs }));
});

// --- 2.9.4: wake failure / abandonment before the policy barrier -------------
// A pre-2.7.3 local credential makes the wake's snapshot continuation purge it
// through native storage. Faulting that purge fails (or parks) the wake before
// its policy barrier settles. 2.9.3 then left readiness waiting on that barrier
// forever, in flight, so neither Retry nor the recovery alarm could re-run it.
const legacyCredentialSeed = (origin) => ({ local: {
  studentToken: 'legacy-local-credential', deviceId: 'device-legacy-fixture',
  config: { serverUrl: origin, schoolId: 'recovery-school', schoolSlug: 'recovery-school', enrollmentKey: 'fixture-enrollment' },
} });
async function readyAfterWakeRecovery(page, worker, label, timeout, fixture = null) {
  // Unattended when the frame's own backoff re-polls in time; otherwise the
  // card's Retry (what a student does) must open the sign-in form.
  try { return { frame: await waitForPhase(page, 'ready', timeout), retried: false }; }
  catch { /* the startup card is showing */ }
  const card = await waitForPhase(page, 'unavailable', 5_000);
  console.log(`[${label} card]`, JSON.stringify({ supportCode: await frameSupportCode(card), fixture: fixture?.state, auth: await workerAuthSummary(worker) }));
  await clickRetry(card);
  return { frame: await expectReady(page, 15_000, worker, label, 'Retry after readiness recovery must show the sign-in form'), retried: true };
}
async function assertWakeRecovered({ page, worker, probe, fixture, target, label, timeout }) {
  const { frame, retried } = await readyAfterWakeRecovery(page, worker, label, timeout, fixture);
  await assertProtected(page);
  assert.equal((await faultTarget(worker, target)).faultedAttempts, 1, 'fixture must fault the legacy credential purge exactly once');
  const diagnostics = await readDiagnostics(worker);
  const failure = diagnostics.find((entry) => entry.stage === 'startup' && entry.cause === 'wake_failed');
  assert.ok(failure, `expected a startup/wake_failed diagnostic (${JSON.stringify(diagnostics)})`);
  assert.equal(failure.detail, 'legacy_auth_cleanup', 'the diagnostic names the startup step');
  const record = await storedValue(worker, 'session', 'authGateWakeFailureV1');
  assert.equal(record?.cause, 'wake_failed'); assert.equal(record?.step, 'legacy_auth_cleanup');
  assert.equal(typeof record?.error, 'string');
  assert.equal(await storedValue(worker, 'local', 'studentToken'), undefined, 'the legacy local credential is purged by the recovery clear');
  const auth = await workerAuthSummary(worker);
  assert.equal(auth.startup, true); assert.equal(auth.studentToken, null);
  assert.equal(auth.schoolId, 'recovery-school', 'readiness applies the managed policy the failed wake never applied');
  const summary = await writeFault(worker, 'summary');
  assert.ok(summary.authClears.length >= 1, `readiness must run the signed-out clear (${JSON.stringify(summary.authClears)})`);
  assert.equal(fixture.state.studentLoginRequests, 0);
  const owners = await startupOwners(worker);
  assert.ok(owners.find((owner) => owner.kind === 'startup_readiness')?.settled, `the readiness owner must settle (${JSON.stringify(owners)})`);
  const { response } = await gateProbe(probe);
  assert.equal(response?.success, true, `the gate must answer after recovery (${JSON.stringify(response)})`);
  return { frame, retried, failure, record, diagnostics, summary };
}

await withBrowser({ caseName: 'wake-failure-before-policy', authReadMode: 'never', seed: legacyCredentialSeed }, async ({ context, worker, probe, fixture }) => {
  const page = await openGatedPage(context, fixture, 'case=wake-failure-before-policy');
  await waitForHeldWakeAuthRead(worker);
  const target = await writeFault(worker, 'arm', { key: 'studentToken', method: 'remove', mode: 'reject-before-commit' });
  assert.equal(await releaseWakeAuthRead(worker), 1, 'fixture must actually hold the wake auth snapshot read');
  const { retried, failure, record, summary } = await assertWakeRecovered({ page, worker, probe, fixture, target, label: 'wake-failure-before-policy', timeout: 20_000 });
  console.log('PASS wake failure before policy: readiness recovered from durable markers and applied policy', JSON.stringify({ retried, failure, record, authClears: summary.authClears }));
});

await withBrowser({ caseName: 'wake-parked-before-policy', authReadMode: 'never', seed: legacyCredentialSeed }, async ({ context, worker, probe, fixture }) => {
  const page = await openGatedPage(context, fixture, 'case=wake-parked-before-policy');
  await waitForHeldWakeAuthRead(worker);
  // The purge's native callback never runs. 2.9.4 bounds it: the fresh verify
  // read still sees the credential, so the wake fails instead of parking.
  const target = await writeFault(worker, 'arm', { key: 'studentToken', method: 'remove', mode: 'never' });
  assert.equal(await releaseWakeAuthRead(worker), 1, 'fixture must actually hold the wake auth snapshot read');
  await waitForHeldWrite(worker, 'studentToken');
  const { retried, failure, record, diagnostics, summary } = await assertWakeRecovered({ page, worker, probe, fixture, target, label: 'wake-parked-before-policy', timeout: 30_000 });
  assert.ok(diagnostics.some((entry) => entry.stage === 'startup' && entry.cause === 'stalled'), `expected a startup/stalled diagnostic (${JSON.stringify(diagnostics)})`);
  assert.ok(summary.held.some((held) => held.key === 'studentToken' && !held.committed), 'the parked native purge stays held; it is never replayed');
  console.log('PASS wake parked before policy: the bounded purge failed the wake and readiness recovered', JSON.stringify({ retried, failure, record, held: summary.held }));
});

// A complete browser-session credential tuple can still fail while restoring
// its local auth-context ID. Remaining CONFIG fields are not proof that the
// restoration completed. These cases use the real wake, restoration, policy
// and readiness pipeline; only native storage and an existing mutation tail
// are faulted. No policy-revalidation implementation is substituted.
const browserSessionCredentialSeed = (origin, { withContext = false } = {}) => ({
  local: {
    deviceId: 'device-wake-fixture', autoRegistrationPaused: true,
    config: { serverUrl: origin, deviceId: 'device-wake-fixture', schoolId: 'recovery-school', schoolSlug: 'recovery-school', enrollmentKey: 'fixture-enrollment' },
  },
  session: {
    ...(withContext ? { authContextId: 'auth_wake_fixture' } : {}),
    studentToken: 'wake-session-token', activeStudentId: 'student-wake-fixture', activeStudentSessionId: 'login-wake-fixture',
    studentEmail: 'wake@example.test', studentName: 'Wake Fixture', identitySource: 'chrome_profile', registered: true,
  },
});

async function waitUntilWorker(worker, predicate, timeout, failureMessage) {
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await worker.evaluate(predicate)) return;
    await sleep(50);
  }
  assert.fail(failureMessage);
}

async function protectedStorageSummary(worker) {
  return worker.evaluate(() => {
    const fixture=__protectedStorageFixture;
    return { calls:fixture.calls,failures:fixture.failures,purges:fixture.purges,
      completedPurges:fixture.completedPurges,heldPurges:fixture.heldPurges.length,
      secured:fixture.secured,capabilityWritesBeforeSecure:fixture.capabilityWritesBeforeSecure };
  });
}

async function readPrivateRecoveryRecord() {
  const db=await new Promise((resolve,reject)=>{
    const request=indexedDB.open('classpilot-private-recovery-v1');
    request.onupgradeneeded=()=>request.transaction.abort();
    request.onerror=()=>request.error?.name==='AbortError'?resolve(null):reject(request.error);
    request.onsuccess=()=>resolve(request.result);
  });
  if(!db)return null;
  try{return await new Promise((resolve,reject)=>{
    const request=db.transaction('recovery').objectStore('recovery').get('student-session-recovery');
    request.onsuccess=()=>resolve(request.result??null);request.onerror=()=>reject(request.error);
  });}finally{db.close();}
}

async function assertRecoveryCapabilityPrivate(worker,page) {
  const visibility=await worker.evaluate(async url=>{
    const tab=(await chrome.tabs.query({})).find(item=>item.url===url);
    const [{result}]=await chrome.scripting.executeScript({target:{tabId:tab.id},world:'ISOLATED',func:async()=>{
      const names=(await indexedDB.databases()).map(item=>item.name);
      let local=null;try{local=(await chrome.storage.local.get('studentSessionRecoveryV1')).studentSessionRecoveryV1??null;}catch{}
      return {pageOrigin:location.origin,privateDatabaseVisible:names.includes('classpilot-private-recovery-v1'),legacy:local};
    }});
    return result;
  },page.url());
  assert.equal(visibility.pageOrigin,new URL(page.url()).origin);
  assert.equal(visibility.privateDatabaseVisible,false,'isolated content must use the page origin, never the private extension vault');
  assert.equal(visibility.legacy,null,'recovery capabilities must never remain in content-readable local storage');
  assert.equal((await page.evaluate(()=>indexedDB.databases())).some(item=>item.name==='classpilot-private-recovery-v1'),false);
}

async function freshLoginAfterStorageRecovery({worker,probe,page,fixture}) {
  assert.equal((await workerAuthSummary(worker)).studentToken,null,'storage recovery cannot invent authentication');
  await assertProtected(page);
  await assertRecoveryCapabilityPrivate(worker,page);
  fixture.state.allowFreshLogin=true;
  const ordinal=fixture.state.studentLoginRequests+1;
  const login=await rpc(probe,{type:'manual-student-login',payload:{mode:'pin',studentId:'student-fresh-fixture',pin:'1234'}});
  assert.equal(login?.success,true,`fresh PIN sign-in after private-storage recovery (${JSON.stringify(login)})`);
  await page.locator('#classpilot-auth-gate').waitFor({state:'detached',timeout:8000});
  assert.equal(fixture.state.studentLoginRequests,ordinal);
  assert.equal(await worker.evaluate(()=>studentSessionRecoveryState.armed?.token),String(ordinal).repeat(43));
  const persisted=await worker.evaluate(readPrivateRecoveryRecord);
  assert.equal(persisted?.state?.armed?.token,String(ordinal).repeat(43),'new recovery capability is committed to extension-origin IndexedDB');
  assert.equal(await storedValue(worker,'local','studentSessionRecoveryV1'),undefined);
  await assertRecoveryCapabilityPrivate(worker,page);
}

for(const persistent of [false,true])await withBrowser({caseName:persistent?'protected-storage-persistent':'protected-storage-retry',quietNetwork:true,
  protectedStorageFault:{mode:persistent?'persistent':'once',message:'This StorageArea is not available for setting access level'}},async({context,worker,probe,fixture})=>{
  const page=await openGatedPage(context,fixture,'case=optional-local-restriction');
  await waitUntilWorker(worker,()=>authGateStartupComplete,16_000,
    '[regression:protected-storage-retry] optional local restriction failure must not block private-vault startup');
  await expectReady(page,12_000,worker,'optional-local-restriction','private-vault compatibility must show fresh sign-in');
  const observed=await protectedStorageSummary(worker);
  assert.equal(observed.calls[0].configImported,false,'modern local restriction remains early defense in depth');
  assert.equal(observed.calls[0].accessLevel,'TRUSTED_CONTEXTS');
  assert.ok(observed.failures>=1,'fixture must deliver the native unsupported-area callback');
  assert.equal(fixture.state.studentLoginRequests,0);
  await freshLoginAfterStorageRecovery({worker,probe,page,fixture});
  console.log(`PASS ${persistent?'persistent':'initial'} optional local-access failure uses private IndexedDB and fresh credentials`);
});

await withBrowser({caseName:'private-vault-browser-restart',quietNetwork:true},async(initial)=>{
  let {context,worker,probe,fixture}=initial;
  let page=await openGatedPage(context,fixture,'case=private-vault-browser-restart');
  await waitUntilWorker(worker,()=>authGateStartupComplete,16_000,
    '[regression:private-vault] the native browser must reach sign-in without local access-level support');
  assert.ok((await worker.evaluate(readPrivateRecoveryRecord))?.migrated,
    '[regression:private-vault] startup must commit a private recovery record');
  await expectReady(page,12_000,worker,'private-vault-browser-restart','fresh sign-in before restart');
  await freshLoginAfterStorageRecovery({worker,probe,page,fixture});
  const durableBefore=await worker.evaluate(readPrivateRecoveryRecord);
  ({context,worker,probe}=await initial.restart());
  page=await openGatedPage(context,fixture,'case=private-vault-after-browser-restart');
  await expectReady(page,16_000,worker,'private-vault-browser-restart','browser restart must require fresh sign-in');
  const durableAfter=await worker.evaluate(readPrivateRecoveryRecord);
  const capabilities=[durableAfter.state.armed,...durableAfter.state.pending].filter(Boolean);
  assert.ok(capabilities.some(record=>record.token===durableBefore.state.armed.token),'exact recovery capability survives full browser restart');
  assert.equal((await workerAuthSummary(worker)).studentToken,null,'manual session bearer must not survive full browser restart');
  assert.equal(fixture.state.studentLoginRequests,1,'browser restart cannot replay credentials');
  await freshLoginAfterStorageRecovery({worker,probe,page,fixture});
  console.log('PASS native browser private-vault origin isolation, durable full-browser restart, and fresh PIN requirement');
});

await withBrowser({caseName:'private-vault-write-failure',quietNetwork:true,
  protectedStorageFault:{mode:'ready',vaultFailure:true}},async({context,worker,probe,fixture})=>{
  const page=await openGatedPage(context,fixture,'case=private-vault-write-failure');
  const frame=await waitForPhase(page,'unavailable',12_000);
  await assertProtected(page);
  assert.ok(await worker.evaluate(()=>__protectedStorageFixture.vaultWriteFailures>0));
  assert.equal(await worker.evaluate(readPrivateRecoveryRecord),null,'failed transaction must not publish a migration marker');
  const details=await frame.locator('#classpilot-auth-it-text').inputValue();
  assert.match(details,/RECOVERY_STORE_MIGRATION_FAILED/);
  assert.equal(details.includes('FIXTURE_PRIVATE_WRITE_FAILED'),false);
  const retry=await rpc(probe,{type:'refresh-auth-state',reason:'user'});
  assert.equal(retry?.success,false);
  assert.equal((await workerAuthSummary(worker)).studentToken,null);
  assert.equal(fixture.state.studentLoginRequests,0);
  await worker.evaluate(()=>{__protectedStorageFixture.failVaultWrites=false;});
  await rpc(probe,{type:'refresh-auth-state',reason:'user'});
  await expectReady(page,15_000,worker,'private-vault-write-failure','healed native IndexedDB writes must recover');
  await freshLoginAfterStorageRecovery({worker,probe,page,fixture});
  console.log('PASS native IDB write failure remains blocked and diagnostic; transaction recovery requires fresh credentials');
});

const migrationSeed=origin=>({local:{deviceId:'migration-device',autoRegistrationPaused:true,
  config:{serverUrl:origin,deviceId:'migration-device',schoolId:'recovery-school',schoolSlug:'recovery-school',enrollmentKey:'fixture-enrollment'},
  studentSessionRecoveryV1:{schemaVersion:1,pending:[],armed:{state:'armed',generation:'recovery_migration_fixture',serverOrigin:origin,
    schoolId:'recovery-school',token:'M'.repeat(43),authContextId:'auth_migration_fixture',createdAt:Date.now()}}}});
await withBrowser({caseName:'private-vault-migration-crash',quietNetwork:true,seed:migrationSeed,
  protectedStorageFault:{mode:'ready',holdPurge:true}},async(initial)=>{
  let {context,worker,probe,fixture}=initial;
  await waitUntilWorker(worker,()=>__protectedStorageFixture.heldPurges.length>=1,8000,'legacy cleanup must be reached');
  const committed=await worker.evaluate(readPrivateRecoveryRecord);
  assert.equal(committed?.migrated,true);
  assert.equal(committed?.state?.armed?.token,'M'.repeat(43),'IDB transaction commits legacy capability before local removal');
  assert.equal((await storedValue(worker,'local','studentSessionRecoveryV1')).armed.token,'M'.repeat(43));
  assert.equal((await workerAuthSummary(worker)).startup,false,'pending legacy cleanup cannot release loaded recovery authority');
  fixture.state.revocableSession={studentId:'student-migration-fixture',recoveryToken:'M'.repeat(43),active:false};
  fixture.state.revokedRecoveryToken='M'.repeat(43);
  const command=await worker.evaluate(()=>handleRemoteControl({type:'student-sign-out',data:{reason:'teacher-sign-out'},
    authority:{teachingSessionId:'migration-class',supervisionContextId:null}},
    {commandId:'migration-signout',studentId:'student-migration-fixture',studentSessionId:'login-migration-fixture',
      authority:{teachingSessionId:'migration-class',supervisionContextId:null}}));
  assert.equal(command?.rejected,true,'server sign-out while migration owns startup cannot acquire local authentication authority');
  await worker.evaluate(()=>chrome.storage.local.set({__classpilotFixtureSkipPurgeHold:true}));
  ({context,worker,probe}=await initial.restart());
  let page=await openGatedPage(context,fixture,'case=migration-after-crash');
  await expectReady(page,16_000,worker,'private-vault-migration-crash','committed migration must retry only legacy cleanup after restart');
  assert.equal(await storedValue(worker,'local','studentSessionRecoveryV1'),undefined);
  const migrated=await worker.evaluate(readPrivateRecoveryRecord);
  assert.ok([migrated.state.armed,...migrated.state.pending].filter(Boolean).some(record=>record.token==='M'.repeat(43)));
  const roster=await rpc(probe,{type:'get-login-roster',gradeLevel:''});
  assert.equal(roster?.success,true);
  assert.ok(fixture.state.revokedRosterRequests>0,'the migrated capability must still be verified by the server');
  assert.ok(!roster.recoveryGrantId);
  assert.ok(roster.students.every(student=>student.reclaimable!==true),'a server-ended session cannot become resumable through migration');
  await worker.evaluate(async legacy=>{
    await persistStudentSessionRecoveryState(emptyStudentSessionRecoveryState());
    await chrome.storage.local.set({studentSessionRecoveryV1:legacy});
  },migrationSeed(fixture.origin).local.studentSessionRecoveryV1);
  ({context,worker,probe}=await initial.restart());
  page=await openGatedPage(context,fixture,'case=migration-tombstone');
  await expectReady(page,16_000,worker,'private-vault-migration-crash','empty private record must suppress stale legacy reimport');
  const empty=await worker.evaluate(readPrivateRecoveryRecord);
  assert.equal(empty.migrated,true);assert.equal(empty.state.armed,null);assert.deepEqual(empty.state.pending,[]);
  assert.equal(await storedValue(worker,'local','studentSessionRecoveryV1'),undefined);
  await freshLoginAfterStorageRecovery({worker,probe,page,fixture});
  const staleApplied=await worker.evaluate(record=>applyStudentSessionRecoveryReleaseOutcome(record,{outcome:'released',retryAfterMs:0}),committed.state.armed);
  assert.equal(staleApplied,false,'late release of migrated authority must not clear a newer login');
  assert.equal(await worker.evaluate(()=>CONFIG.studentToken),'fresh-fixture-token-1');
  assert.deepEqual(fixture.state.loginAuthorizationHeaders,[null],'fresh PIN does not reuse the revoked legacy capability');
  console.log('PASS commit-before-delete migration, crash cleanup retry, and durable empty tombstone prevent legacy resurrection');
});

await withBrowser({ caseName: 'upgrade-2.9.4-native-reload', snapshotVersion: '2.9.4', quietNetwork: true },
  async ({ context, worker, extensionId, extensionPath, fixture }) => {
    assert.notEqual(candidateVersion, '2.9.4', 'the native upgrade needs a newer candidate');
    assert.equal(await worker.evaluate(() => chrome.runtime.getManifest().version), '2.9.4');
    const browserMajor = await worker.evaluate(() => Number(navigator.userAgent.match(/Chrome\/(\d+)/)?.[1]));
    assert.ok(Number.isInteger(browserMajor));
    // A native reload converts a command-line installation to an unpacked
    // development installation on newer Chrome. Enable the normal developer
    // setting in this disposable profile, as a person testing unpacked code
    // would, so Chrome does not disable the extension during that transition.
    const extensionsPage = await context.newPage();
    await extensionsPage.goto('chrome://extensions/');
    const developerMode = extensionsPage.locator('#devMode');
    if (!await developerMode.evaluate(toggle => toggle.checked)) await developerMode.click();
    assert.equal(await developerMode.evaluate(toggle => toggle.checked), true);
    await extensionsPage.close();
    const page = await openGatedPage(context, fixture, 'case=native-294-upgrade');
    // The released worker itself fails before140 because local storage access
    // levels are unavailable. Do not patch its auth functions or wait for
    // successful restoration before exercising the real installed upgrade.
    if (browserMajor < 140) {
      await waitForPhase(page, 'unavailable', 15_000, '2.9.4');
      assert.equal(await worker.evaluate(() => authGateStartupComplete), false);
      const storageFailure = await worker.evaluate(() => trustedLocalStorageAccessPromise.then(
        () => null, error => error?.message,
      ));
      assert.ok(['Trusted-only extension storage is unavailable',
        'Trusted-only extension storage could not be enabled'].includes(storageFailure),
        'released startup must be blocked by the actual unavailable local access-level API');
    } else {
      await waitForPhase(page, 'ready', 15_000, '2.9.4');
    }
    await assertProtected(page);
    assert.equal(fixture.state.studentLoginRequests, 0);
    const loadsBefore = fixture.state.pageLoads;
    cpSync(sourceRoot, extensionPath, { recursive: true });
    installManagedFixture(extensionPath, fixture.origin, 'ready', { quietNetwork: true });
    // runtime.reload exists at the supported floor; unlike the CDP Extensions
    // domain, it does not require a recent testing engine. Same path preserves
    // the extension identity and native profile stores across this upgrade.
    await worker.evaluate(() => chrome.runtime.reload()).catch(error => {
      assert.match(error.message, /(?:closed|destroyed|invalidated)/i,
        'native extension reload must execute rather than fail silently');
    });
    const updated = await waitForWorkerVersion(context, extensionId, candidateVersion);
    assert.equal(new URL(updated.url()).host, extensionId);
    await assertProtected(page);
    const probe = await context.newPage();
    await probe.goto(`chrome-extension://${extensionId}/recovery-probe.html`);
    const refreshed = await rpc(probe, { type: 'refresh-auth-state', reason: 'user' });
    assert.equal(refreshed?.success, true, `candidate startup after native reload: ${JSON.stringify(refreshed)}`);
    let pageRecovery = 'cooperative';
    try { await waitForPhase(page, 'ready', 15_000); }
    catch (error) {
      const outcomes = await updated.evaluate(async url => {
        const tab = (await chrome.tabs.query({})).find(item => item.url === url);
        return __managedRecoveryFixture.pageOutcomes.filter(item => item.tabId === tab?.id)
          .map(({ status, reason }) => ({ status, reason }));
      }, page.url());
      assert.equal(outcomes.at(-1)?.status, 'manual_reload_required',
        `native upgrade requires an explicit safe ownership fallback: ${JSON.stringify(outcomes)}; ${error.message}`);
      assert.ok(['ownership_unproven', 'legacy_requires_update_authorization'].includes(outcomes.at(-1)?.reason));
      await assertProtected(page);
      assert.equal(fixture.state.pageLoads, loadsBefore, 'unknown old owner must not authorize automatic navigation');
      pageRecovery = 'manual_ownership_fallback';
      await page.reload();
      await waitForPhase(page, 'ready');
    }
    await assertProtected(page);
    assert.ok(fixture.state.pageLoads <= loadsBefore + 1, 'upgrade must not enter a reload loop');
    assert.equal(fixture.state.studentLoginRequests, 0, 'upgrade cannot replay credentials');
    await freshLoginAfterStorageRecovery({ worker: updated, probe, page, fixture });
    console.log(`PASS native same-ID2.9.4→${candidateVersion} upgrade onChrome${browserMajor} (${browserMajor < 140 ? 'released startup blocked' : 'released startup ready'}, ${pageRecovery}), private vault and fresh PIN`);
  });

await withBrowser({ caseName: 'wake-partial-auth-clear', authReadMode: 'never', seed: browserSessionCredentialSeed, quietNetwork: true }, async ({ context, worker, probe, fixture }) => {
  const page = await openGatedPage(context, fixture, 'case=wake-partial-auth-clear');
  await waitForHeldWakeAuthRead(worker);
  const target = await writeFault(worker, 'arm', { area: 'session', key: 'authContextId', mode: 'reject-before-commit' });
  assert.equal(await releaseWakeAuthRead(worker), 1);
  try {
    await waitUntilWorker(worker, () => authGateStartupComplete, 20_000,
      '[regression:partial-auth] failed restoration must recover to verified signed-out readiness');
  } catch (error) { await dumpStartupState(worker, 'wake-partial-auth-clear'); throw error; }
  assert.equal((await faultTarget(worker, target)).faultedAttempts, 1, 'the context-ID persistence must actually fail');
  const recovered = await worker.evaluate(() => ({
    authenticated: hasStudentAuth(), token: CONFIG.studentToken, contextId: CONFIG.authContextId,
    paused: CONFIG.autoRegistrationPaused, clears: __managedRecoveryFixture.authClears,
  }));
  assert.equal(recovered.authenticated, false,
    `[regression:partial-auth] failed context-ID restoration must not publish authenticated readiness (${JSON.stringify(recovered)})`);
  assert.equal(recovered.token, null, '[regression:partial-auth] failed restoration must clear the partial bearer');
  assert.equal(recovered.contextId, null);
  assert.equal(recovered.paused, true, 'recovery must require a deliberate fresh sign-in');
  assert.ok(recovered.clears.length >= 1, 'failed restoration must run verified local authentication cleanup');
  assert.equal(await storedValue(worker, 'session', 'studentToken'), undefined);
  assert.equal(await storedValue(worker, 'local', 'studentAuthInvalidatingV1'), undefined);
  await expectReady(page, 15_000, worker, 'wake-partial-auth-clear', '[regression:partial-auth] verified cleanup must display fresh sign-in');
  await assertProtected(page);
  const { response } = await gateProbe(probe);
  assert.equal(response?.success, true);
  assert.equal(fixture.state.studentLoginRequests, 0, 'recovery must never replay a login');
  fixture.state.allowFreshLogin = true;
  const login = await rpc(probe, { type: 'manual-student-login', payload: { mode: 'pin', studentId: 'student-fresh-fixture', pin: '1234' } });
  assert.equal(login?.success, true, `fresh credentialed sign-in must succeed after recovery (${JSON.stringify(login)})`);
  await page.locator('#classpilot-auth-gate').waitFor({ state: 'detached', timeout: 8_000 });
  assert.equal(fixture.state.studentLoginRequests, 1);
  const newAuth = await worker.evaluate(() => ({
    authenticated: hasStudentAuth(), token: CONFIG.studentToken, contextId: CONFIG.authContextId,
    sessionId: CONFIG.activeStudentSessionId, recovery: studentSessionRecoveryState.armed?.token,
  }));
  assert.equal(newAuth.authenticated, true);
  assert.equal(newAuth.token, 'fresh-fixture-token-1');
  assert.equal(newAuth.sessionId, 'login-fresh-fixture-1');
  assert.equal(newAuth.recovery, '1'.repeat(43));
  assert.equal(await storedValue(worker, 'local', 'studentToken'), undefined, 'the new bearer remains browser-session scoped');
  console.log('PASS failed auth-context restoration clears partial credentials, then a fresh PIN login commits a new session');
});

await withBrowser({ caseName: 'wake-no-migration-replay', authReadMode: 'never', seed: legacyCredentialSeed }, async ({ context, worker, fixture }) => {
  const page = await openGatedPage(context, fixture, 'case=wake-no-migration-replay');
  await waitForHeldWakeAuthRead(worker);
  const target = await writeFault(worker, 'arm', {
    key: 'studentToken', method: 'remove', keyCount: 1, mode: 'reject-before-commit',
  });
  // If recovery incorrectly calls getStoredAuthState again, this second native
  // migration purge never invokes its callback. The verified auth-clear path
  // is allowed to remove the same credential through its own idempotent write.
  await writeFault(worker, 'arm', {
    key: 'studentToken', method: 'remove', keyCount: 1, mode: 'never',
  });
  assert.equal(await releaseWakeAuthRead(worker), 1);
  await waitUntilWorker(worker, () => authGateStartupComplete
    || __managedRecoveryFixture.writeLog.filter((entry) => entry.legacyMigration).length > 1,
  20_000, '[regression:migration-replay] failed wake must recover without repeating credential migration');
  const summary = await writeFault(worker, 'summary');
  assert.equal(summary.writeLog.filter((entry) => entry.legacyMigration).length, 1,
    '[regression:migration-replay] recovery must not invoke a second legacy credential migration');
  assert.equal((await faultTarget(worker, target)).faultedAttempts, 1);
  await expectReady(page, 15_000, worker, 'wake-no-migration-replay', '[regression:migration-replay] dedicated policy recovery must show fresh sign-in');
  assert.equal(await storedValue(worker, 'local', 'studentToken'), undefined);
  assert.equal((await workerAuthSummary(worker)).studentToken, null);
  await assertProtected(page);
  console.log('PASS recovery clears old credentials without replaying legacy migration or parking on its second callback');
});

await withBrowser({ caseName: 'wake-held-composite-no-takeover', authReadMode: 'never', seed: (origin) => browserSessionCredentialSeed(origin, { withContext: true }), quietNetwork: true }, async ({ context, worker, probe, fixture }) => {
  const page = await openGatedPage(context, fixture, 'case=wake-held-composite-no-takeover');
  await waitForHeldWakeAuthRead(worker);
  const before = await worker.evaluate(() => {
    // cleanupRetiredExactBoundStorage must await this legitimate prior cleanup
    // owner. Holding the tail exercises the actual composite and auth queue.
    retiredExactBoundStorageCleanupMutation = new Promise((resolve) => { globalThis.__releasePriorExactCleanup = resolve; });
    return { generation: studentAuthMutationGeneration, policyGeneration: managedAuthGatePolicyGeneration };
  });
  assert.equal(await releaseWakeAuthRead(worker), 1);
  await waitUntilWorker(worker, () => CONFIG.authContextId === 'auth_wake_fixture', 6_000,
    'the held composite must belong to the real credential-restoration attempt');
  // Crossing both the former composite 9s deadline and the global 30s watchdog
  // must leave the owner pending. Retry may report a timeout, never take over.
  const started = Date.now();
  const reply = gateProbe(probe);
  while (Date.now() - started < 32_000) {
    const current = await worker.evaluate(() => ({
      startup: authGateStartupComplete, pending: studentAuthMutationPendingCount,
      generation: studentAuthMutationGeneration, clears: __managedRecoveryFixture.authClears.length,
    }));
    assert.equal(current.startup, false,
      '[regression:composite-takeover] a deadline must not publish readiness over an unsettled authentication composite');
    assert.equal(current.generation, before.generation,
      '[regression:composite-takeover] a deadline must not retire an unsettled authentication mutation');
    assert.equal(current.clears, 0,
      '[regression:composite-takeover] Retry/watchdog must not enqueue cleanup behind abandoned composite work');
    assert.ok(current.pending >= 1, '[regression:composite-takeover] the original authentication mutation must remain owned');
    await sleep(250);
  }
  assertStartupGateFailure(await reply, 'held authentication composite');
  await assertProtected(page);
  const retry = await rpc(probe, { type: 'refresh-auth-state', reason: 'user' });
  assert.equal(retry?.success, false, 'explicit Retry must report the still-pending startup');
  await worker.evaluate(() => globalThis.__releasePriorExactCleanup());
  await waitUntilWorker(worker, () => authGateStartupComplete, 15_000,
    'the original wake must finish when its composite actually completes');
  const finished = await worker.evaluate(() => ({
    authenticated: hasStudentAuth(), contextId: CONFIG.authContextId,
    generation: studentAuthMutationGeneration, clears: __managedRecoveryFixture.authClears.length,
  }));
  assert.equal(finished.authenticated, true, 'successful original restoration preserves the saved session');
  assert.equal(finished.contextId, 'auth_wake_fixture');
  assert.equal(finished.generation, before.generation);
  assert.equal(finished.clears, 0);
  assert.equal(fixture.state.studentLoginRequests, 0);
  console.log('PASS a held authentication composite retains ownership through the 30s watchdog and explicit Retry');
});

await withBrowser({ caseName: 'server-signout-fresh-login-binding', quietNetwork: true }, async ({ context, worker, probe, fixture }) => {
  const page = await openGatedPage(context, fixture, 'case=server-signout-fresh-login-binding');
  await waitForPhase(page, 'ready');
  fixture.state.allowFreshLogin = true;
  const loginRequest = { type: 'manual-student-login', payload: { mode: 'pin', studentId: 'student-fresh-fixture', pin: '1234' } };
  const first = await rpc(probe, loginRequest);
  assert.equal(first?.success, true, JSON.stringify(first));
  const ended = await worker.evaluate(async () => {
    const auth = captureAuthenticatedContext('teacher sign-out compatibility fixture');
    const recovery = studentSessionRecoveryState.armed;
    globalThis.__endedFixtureAuth = auth;
    globalThis.__endedFixtureRecovery = recovery;
    // Same production entry point/options used by an exact-bound teacher
    // student-sign-out command. The separate SchoolPilot database regression
    // proves the server transaction; this case proves local clear/adoption.
    await clearStudentAuth('teacher-sign-out', {
      notifyBackend: false, serverSessionEnded: true, pauseAutoRegistration: true,
      expectedAuthContext: auth,
    });
    return {
      authenticated: hasStudentAuth(), paused: CONFIG.autoRegistrationPaused,
      armed: studentSessionRecoveryState.armed,
      pendingForEnded: studentSessionRecoveryState.pending.some((record) => record.authContextId === auth.authContextId),
    };
  });
  assert.equal(ended.authenticated, false);
  assert.equal(ended.paused, true, 'teacher sign-out must not silently re-register the Chrome profile');
  assert.equal(ended.armed, null, 'a correlated ended session must not retain a Resume capability');
  assert.equal(ended.pendingForEnded, false);
  await waitForPhase(page, 'ready');
  await assertProtected(page);
  assert.equal(fixture.state.studentLoginRequests, 1, 'sign-out must wait for fresh student credentials');
  const second = await rpc(probe, loginRequest);
  assert.equal(second?.success, true, JSON.stringify(second));
  const latest = await worker.evaluate(async () => {
    const before = captureAuthenticatedContext('newer login compatibility fixture');
    let staleClearCode = null;
    try {
      await clearStudentAuth('late-teacher-sign-out', {
        notifyBackend: false, serverSessionEnded: true, pauseAutoRegistration: true,
        expectedAuthContext: globalThis.__endedFixtureAuth,
      });
    } catch (error) { staleClearCode = error?.code; }
    const staleRecoveryApplied = await applyStudentSessionRecoveryReleaseOutcome(
      globalThis.__endedFixtureRecovery, { outcome: 'released', retryAfterMs: 0 },
    );
    const acceptsEndedBinding = acceptsCurrentStudentBinding({
      studentId: globalThis.__endedFixtureAuth.studentId,
      studentSessionId: globalThis.__endedFixtureAuth.studentSessionId,
    }, 'late server sign-out compatibility fixture');
    let stillCurrent = true;
    try { assertAuthenticatedContextCurrent(before, 'after late sign-out callbacks'); }
    catch { stillCurrent = false; }
    return {
      staleClearCode, staleRecoveryApplied, acceptsEndedBinding,
      stillCurrent, authenticated: hasStudentAuth(),
      sessionId: CONFIG.activeStudentSessionId, token: CONFIG.studentToken,
      recoveryToken: studentSessionRecoveryState.armed?.token,
    };
  });
  assert.equal(latest.staleClearCode, 'AUTH_CONTEXT_SUPERSEDED');
  assert.equal(latest.staleRecoveryApplied, false, 'late cleanup of the ended capability must be inert');
  assert.equal(latest.acceptsEndedBinding, false, 'an old exact-bound sign-out message cannot target the new session');
  assert.equal(latest.stillCurrent, true);
  assert.equal(latest.authenticated, true);
  assert.equal(latest.sessionId, 'login-fresh-fixture-2');
  assert.equal(latest.token, 'fresh-fixture-token-2');
  assert.equal(latest.recoveryToken, '2'.repeat(43));
  await page.locator('#classpilot-auth-gate').waitFor({ state: 'detached', timeout: 8_000 });
  console.log('PASS exact teacher sign-out requires fresh login; retired binding and recovery callbacks cannot clear the new session');
});

await withBrowser({ caseName: 'server-signout-during-startup-recovery', authReadMode: 'never', quietNetwork: true, seed: (origin) => {
  const seed = browserSessionCredentialSeed(origin, { withContext: true });
  seed.session.identitySource = 'manual_pin';
  seed.session.manualLoginLastSeenAt = Date.now();
  seed.local.studentSessionRecoveryV1 = {
    schemaVersion: 1, pending: [], armed: {
      state: 'armed', generation: 'recovery_wake_fixture', serverOrigin: origin,
      schoolId: 'recovery-school', token: 'R'.repeat(43), authContextId: 'auth_wake_fixture', createdAt: Date.now(),
    },
  };
  return seed;
} }, async ({ context, worker, probe, fixture }) => {
  fixture.state.revocableSession = { studentId: 'student-wake-fixture', recoveryToken: 'R'.repeat(43), active: true };
  const beforeRevocation = await fetch(`${fixture.origin}/api/extension/login-roster`, {
    headers: { Authorization: `ClassPilot-Recovery ${'R'.repeat(43)}` },
  }).then((response) => response.json());
  assert.equal(beforeRevocation.students[0]?.reclaimable, true, 'the server fixture must start with a valid exact recovery capability');
  const page = await openGatedPage(context, fixture, 'case=server-signout-during-startup-recovery');
  await waitForHeldWakeAuthRead(worker);
  // Restoration activates the saved exact context, then its real retired-data
  // cleanup fails. Hold the later strict clear at its native durable config
  // write so the server sign-out arrives during recovery, before publication.
  const restoreFault = await writeFault(worker, 'arm', { key: 'schoolSettings', method: 'remove', mode: 'reject-before-commit' });
  const recoveryHold = await writeFault(worker, 'arm', { key: 'config', requireKeys: ['autoRegistrationPaused'], mode: 'never' });
  assert.equal(await releaseWakeAuthRead(worker), 1);
  await waitForHeldWrite(worker, 'config');
  assert.equal((await faultTarget(worker, restoreFault)).faultedAttempts, 1, 'the real saved-auth cleanup must fail');
  const pending = await worker.evaluate(() => ({
    startup: authGateStartupComplete, phase: startupFailedWakeRecovery?.phase,
    invalidating: studentAuthInvalidating, pending: studentAuthMutationPendingCount,
    generation: studentAuthMutationGeneration, clears: __managedRecoveryFixture.authClears.length,
  }));
  assert.equal(pending.startup, false); assert.equal(pending.phase, 'recovery_clear');
  assert.equal(pending.invalidating, true); assert.ok(pending.pending > 0);

  // Model the already-committed PR502 server result: the old capability no
  // longer grants a reclaimable roster entry. Deliver its real device command
  // too; the production handler must respect the in-progress local auth fence.
  // SchoolPilot's separate local-DB tests prove the authoritative transaction.
  fixture.state.revokedRecoveryToken = 'R'.repeat(43);
  fixture.state.revocableSession.active = false;
  fixture.state.allowFreshLogin = true;
  const delivery = await worker.evaluate(async () => {
    const result = await handleRemoteControl({
      type: 'student-sign-out', data: { reason: 'teacher-sign-out' },
      authority: { teachingSessionId: 'class-signout-fixture', supervisionContextId: null },
    }, {
      commandId: 'teacher-signout-during-recovery', studentId: 'student-wake-fixture',
      studentSessionId: 'login-wake-fixture',
      authority: { teachingSessionId: 'class-signout-fixture', supervisionContextId: null },
    });
    return {
      result, startup: authGateStartupComplete, generation: studentAuthMutationGeneration,
      clears: __managedRecoveryFixture.authClears.length, authenticated: hasStudentAuth(),
    };
  });
  assert.equal(delivery.result?.rejected, true, 'a late teacher command must respect the existing recovery fence');
  assert.equal(delivery.startup, false); assert.equal(delivery.authenticated, false);
  assert.equal(delivery.generation, pending.generation, 'the old command must not replace the recovery owner');
  assert.equal(delivery.clears, pending.clears, 'the old command must not enqueue a competing auth clear');
  assert.equal((await faultTarget(worker, recoveryHold)).matchedAttempts, 1);
  await assertProtected(page);
  assert.equal(fixture.state.studentLoginRequests, 0, 'server sign-out must never trigger a login replay');

  assert.equal((await writeFault(worker, 'release', { key: 'config', commit: true })).length, 1);
  await expectReady(page, 15_000, worker, 'server-signout-during-startup-recovery', 'server sign-out during recovery must converge to fresh sign-in');
  await assertProtected(page);
  const recovered = await worker.evaluate(() => ({
    authenticated: hasStudentAuth(), token: CONFIG.studentToken, paused: CONFIG.autoRegistrationPaused,
  }));
  assert.equal(recovered.authenticated, false); assert.equal(recovered.token, null); assert.equal(recovered.paused, true);
  const roster = await rpc(probe, { type: 'get-login-roster', gradeLevel: '' });
  assert.equal(roster?.success, true, JSON.stringify(roster));
  assert.ok(fixture.state.revokedRosterRequests > 0, 'the worker must present the old capability to the server for verification');
  assert.ok(!roster.recoveryGrantId, 'a revoked old capability must not mint a Resume grant');
  assert.ok(roster.students.some((student) => student.id === 'student-wake-fixture'), 'teacher sign-out makes the old student available for a fresh login');
  assert.ok(roster.students.every((student) => student.reclaimable !== true), 'the ended server session must not be offered as resumable');
  const login = await rpc(probe, { type: 'manual-student-login', payload: { mode: 'pin', studentId: 'student-fresh-fixture', pin: '1234' } });
  assert.equal(login?.success, true, JSON.stringify(login));
  assert.equal(fixture.state.studentLoginRequests, 1);
  assert.deepEqual(fixture.state.loginAuthorizationHeaders, [null], 'fresh PIN must not reuse revoked recovery authorization');
  const current = await worker.evaluate(() => ({
    session: CONFIG.activeStudentSessionId, token: CONFIG.studentToken,
    armed: studentSessionRecoveryState.armed?.token,
  }));
  assert.equal(current.session, 'login-fresh-fixture-1'); assert.equal(current.token, 'fresh-fixture-token-1');
  assert.equal(current.armed, '1'.repeat(43));
  await page.locator('#classpilot-auth-gate').waitFor({ state: 'detached', timeout: 8_000 });
  console.log('PASS teacher sign-out during failed startup cleanup retains protection and permits only a fresh credentialed session');
});

for (const bootstrapOnly of [false, true]) {
  const caseName = bootstrapOnly ? 'blocked-fallback-diagnostics' : 'blocked-screen-diagnostics';
  await withBrowser({ caseName, bootstrapOnly, authReadMode: 'never' }, async ({ context, worker, fixture }) => {
    const page = await openGatedPage(context, fixture, `case=${caseName}`);
    await waitForHeldWakeAuthRead(worker);
    let surface;
    if (bootstrapOnly) {
      await page.locator('#classpilot-auth-support-code').waitFor({ timeout: 14_000 });
      surface = page;
    } else surface = await waitForPhase(page, 'unavailable', 14_000);
    assert.equal(await surface.locator('#classpilot-auth-it-summary').count(), 1,
      '[regression:on-screen-details] a blocked startup must offer Details for IT without worker DevTools');
    await surface.locator('#classpilot-auth-it-summary').focus();
    await surface.locator('#classpilot-auth-it-summary').press('Enter');
    assert.equal(await surface.locator('#classpilot-auth-it-details').getAttribute('open'), '');
    const diagnosticText = await surface.locator('#classpilot-auth-it-text').inputValue();
    assert.match(diagnosticText, new RegExp(`ClassPilot ${candidateVersion.replaceAll('.', '\\.')}`));
    assert.match(diagnosticText, /Support code: AUTH_GATE_(STARTUP_TIMEOUT|UNAVAILABLE)/);
    assert.match(diagnosticText, /Startup step: auth_snapshot/);
    assert.match(diagnosticText, /Operation pending: yes/);
    for (const forbidden of ['fixture-enrollment', 'recovery-school', fixture.origin, 'studentToken', 'authContextId']) {
      assert.ok(!diagnosticText.includes(forbidden), `diagnostics must omit ${forbidden}`);
    }
    assert.equal(await surface.locator('#classpilot-auth-it-text').getAttribute('readonly'), '');
    // A managed restriction/iframe policy can deny clipboard access. Exercise
    // the real user-gesture button and require a selectable local fallback.
    if (bootstrapOnly) await pageFixture(worker, page, 'deny-clipboard');
    else await surface.evaluate(() => {
      Object.defineProperty(navigator, 'clipboard', {
        configurable: true, value: { writeText: async () => { throw new DOMException('Denied by fixture', 'NotAllowedError'); } },
      });
    });
    await surface.locator('#classpilot-auth-copy-diagnostics').click({ timeout: 2_000 });
    assert.equal(await surface.locator('#classpilot-auth-copy-status').textContent(), 'Select and copy the details above.');
    const selection = await surface.evaluate(() => {
      const text = document.getElementById('classpilot-auth-it-text');
      return { focused: document.activeElement === text, start: text.selectionStart, end: text.selectionEnd, length: text.value.length };
    });
    assert.equal(selection.focused, true, 'the protected screen must allow focus on its diagnostic text');
    assert.equal(selection.start, 0); assert.equal(selection.end, selection.length);
    await assertProtected(page);
    assert.equal(fixture.state.studentLoginRequests, 0);
    console.log(`PASS ${caseName}: blocked startup exposes sanitized details and clipboard-denial selection without unlocking browsing`);
  });
}

await withBrowser({ caseName: 'recovered-startup-obsolete-school', seed: (origin) => {
  const now = Date.now();
  return {
    local: {
      studentAuthInvalidatingV1: true,
      deviceId: 'device-obsolete',
      config: { serverUrl: origin, deviceId: 'device-obsolete', schoolId: 'obsolete-school', schoolSlug: 'obsolete-school', enrollmentKey: 'obsolete-enrollment' },
      classroomControlStateV1: { schemaVersion: 1, revision: 7, supervisionContextId: 'ctx-obsolete', hardExpiresAt: now + 3_600_000, scheduledEndAt: now + 3_600_000, restrictions: {} },
      classroomStateFailSafeExpiryAt: now + 3_600_000,
    },
    // Session-scoped exactly as the production writer routes them.
    session: {
      authContextId: 'auth_obsolete', studentToken: 'obsolete-token', activeStudentId: 'student-obsolete', activeStudentSessionId: 'login-obsolete',
      studentEmail: 'obsolete@example.test', identitySource: 'chrome_profile', registered: true, classroomStateStudentBindingV1: 'student-obsolete',
      fabContextV1: { binding: 'v3:auth_obsolete' },
      fabStateV1: { schemaVersion: 1, revision: 1, ownershipRevision: 7, contextAuthorityRevision: 7, supervisionContextId: 'ctx-obsolete', activeSessionIds: [], activeContexts: [{ supervisionContextId: 'ctx-obsolete' }] },
      classroomOverlayStateV1: { schemaVersion: 1, binding: 'v3:auth_obsolete', timer: { commandId: 'cmd-obsolete', supervisionContextId: 'ctx-obsolete', contextAuthorityRevision: 7, endsAt: now + 600_000, message: '', receivedAt: now }, poll: null, updatedAt: now },
    },
  };
} }, async ({ context, worker, fixture }) => {
  const page = await openGatedPage(context, fixture, 'case=recovered-startup-obsolete-school');
  await expectReady(page, 15_000, worker, 'recovered-startup-obsolete-school', 'an interrupted clear at wake must be replayed and the sign-in form must appear');
  await assertProtected(page);
  const stored = await worker.evaluate(() => new Promise((done) => chrome.storage.local.get(
    ['classroomControlStateV1', 'studentAuthInvalidatingV1', 'classroomStateFailSafeExpiryAt'],
    (local) => chrome.storage.session.get(['studentToken', 'classroomStateStudentBindingV1', 'authContextId', 'classroomOverlayStateV1', 'fabContextV1', 'fabStateV1'], (session) => done({ local, session })))));
  assert.equal(stored.local.studentAuthInvalidatingV1, undefined, 'the recovered clear must remove the crash marker last');
  assert.equal(stored.local.classroomControlStateV1, undefined, 'obsolete supervision classroom state must be cleared');
  assert.ok(stored.session.classroomOverlayStateV1 == null, `obsolete supervision overlay must be cleared (${JSON.stringify(stored.session.classroomOverlayStateV1)})`);
  assert.ok(stored.session.fabContextV1 == null); assert.ok(stored.session.fabStateV1 == null);
  assert.equal(stored.session.studentToken, undefined); assert.equal(stored.session.classroomStateStudentBindingV1, undefined); assert.equal(stored.session.authContextId, undefined);
  const gates = await worker.evaluate(async () => {
    await authStateRestorePromise; await classroomStateRestorePromise; await studentAuthMutationTail;
    const observed = { negotiated: negotiatedProtocolState, classroom: currentClassroomState, fab: currentFabState, studentToken: CONFIG.studentToken };
    // PR #108 gates need an authenticated caller for the overlay read. Use the
    // scheduled-classroom harness's in-memory context recipe (no storage
    // credentials, no network) after the recovered clear has completed.
    scheduleHeartbeat(null); sendHeartbeat = async () => {}; connectWebSocket = async () => {};
    advanceStudentAuthMutationGeneration();
    Object.assign(CONFIG, { schoolId: 'recovery-school', deviceId: 'device-fixture', activeStudentId: 'student-fixture', activeStudentSessionId: 'login-fixture', studentToken: 'fixture-only', studentEmail: 'fixture@example.test', identitySource: 'integration_test' });
    studentAuthInvalidating = false; studentAuthCommitPending = false;
    activateAuthenticatedContext(generateAuthContextId());
    const auth = captureAuthenticatedContext('recovered startup fixture');
    const restorable = await getRestorableClassroomOverlayState({ authContext: auth, expectedBinding: fabIdentityBinding() });
    let timerCommand = 'ACCEPTED';
    try { assertCurrentCommandAuthority({ type: 'timer', authority: { supervisionContextId: 'ctx-obsolete' }, data: { action: 'start', seconds: 60 } }, {}); }
    catch (error) { timerCommand = error?.code || String(error); }
    return { ...observed, restorable, timerCommand };
  });
  assert.equal(gates.negotiated, null, 'negotiatedProtocolState must be null after a recovered clear');
  assert.equal(gates.classroom, null); assert.equal(gates.fab, null); assert.equal(gates.studentToken, null);
  assert.deepEqual(gates.restorable, { timer: null, poll: null }, 'obsolete supervision overlay must not be restorable');
  assert.equal(gates.timerCommand, 'COMMAND_AUTHORITY_MISMATCH', 'a timer command for the obsolete supervision context must be rejected');
  assert.equal(fixture.state.studentLoginRequests, 0);
  console.log('PASS recovered startup clears obsolete supervision authority (protocol, overlay, command authority)');
});

await withBrowser({ caseName: 'worker-suspension-preserves-classroom', quietNetwork: true }, async ({ context, worker, extensionId, fixture }) => {
  // Phase A: a durable signed-in student with a live supervision-context
  // classroom state, FAB context and timer overlay, written through the
  // production persistence paths (not hand-seeded storage).
  const live = await worker.evaluate(async (origin) => {
    await authStateRestorePromise; await classroomStateRestorePromise; await studentAuthMutationTail;
    scheduleHeartbeat(null);
    await new Promise((done) => chrome.storage.local.set({ deviceId: 'device-live', autoRegistrationPaused: true,
      config: { serverUrl: origin, deviceId: 'device-live', schoolId: 'recovery-school', schoolSlug: 'recovery-school', enrollmentKey: 'fixture-enrollment' } }, done));
    advanceStudentAuthMutationGeneration();
    Object.assign(CONFIG, { serverUrl: origin, schoolId: 'recovery-school', schoolSlug: 'recovery-school', enrollmentKey: 'fixture-enrollment', deviceId: 'device-live',
      activeStudentId: 'student-live', activeStudentSessionId: 'login-live', studentToken: 'live-token', studentEmail: 'live@example.test', identitySource: 'chrome_profile', autoRegistrationPaused: true });
    studentAuthInvalidating = false; studentAuthCommitPending = false;
    const authContextId = generateAuthContextId();
    CONFIG.authContextId = authContextId;
    await setManualAuthState({ authContextId, activeStudentId: 'student-live', activeStudentSessionId: 'login-live', studentToken: 'live-token', studentEmail: 'live@example.test',
      identitySource: 'chrome_profile', registered: true, classroomStateStudentBindingV1: 'student-live' });
    activateAuthenticatedContext(authContextId);
    const auth = captureAuthenticatedContext('suspension fixture');
    const end = Date.now() + 60 * 60 * 1000;
    const application = await applyClassroomState(
      { schemaVersion: 1, revision: 41, supervisionContextId: 'ctx-live', receivedAt: Date.now(), hardExpiresAt: end, scheduledEndAt: end, restrictions: {} },
      { force: true, reason: 'fixture', authContext: auth, authorityEnvelope: { studentId: auth.studentId, studentSessionId: auth.studentSessionId } });
    observeStudentControlRevision(41, auth, 'fixture');
    await applyFabSettings({ schemaVersion: 1, revision: 1, ownershipRevision: 41, teachingSessionId: null, contextAuthorityRevision: '0', supervisionContextId: 'ctx-live',
      activeSessionIds: [], activeContexts: [{ supervisionContextId: 'ctx-live' }], contextSource: 'scheduled_testing', contextName: 'Live', messagingEnabled: true, handRaisingEnabled: true }, { authContext: auth });
    const overlay = await persistTimerOverlay({ authority: { supervisionContextId: 'ctx-live' }, data: { action: 'start', seconds: 1800 } }, { authContext: auth });
    // Classroom control state is durable (local); FAB context and overlays are
    // browser-session scoped, so the production writer routes them to session.
    const stored = await new Promise((done) => chrome.storage.local.get(['classroomControlStateV1', 'studentAuthInvalidatingV1'],
      (local) => chrome.storage.session.get(['classroomOverlayStateV1', 'fabContextV1'], (session) => done({ ...local, ...session }))));
    return { authContextId, outcome: application?.outcome ?? null, classroom: currentClassroomState?.supervisionContextId ?? null, revision: currentClassroomState?.revision ?? null,
      storedClassroom: stored.classroomControlStateV1?.supervisionContextId ?? null, storedTimer: stored.classroomOverlayStateV1?.timer?.supervisionContextId ?? null,
      storedBinding: stored.fabContextV1?.binding ?? null, marker: stored.studentAuthInvalidatingV1 ?? null, overlayTimer: overlay?.timer?.supervisionContextId ?? null };
  }, fixture.origin);
  assert.equal(live.classroom, 'ctx-live', `fixture classroom state did not apply (${JSON.stringify(live)})`);
  assert.equal(live.storedClassroom, 'ctx-live', `fixture classroom state was not persisted (${JSON.stringify(live)})`);
  assert.equal(live.storedTimer, 'ctx-live', `fixture timer overlay was not persisted (${JSON.stringify(live)})`);
  assert.equal(live.storedBinding, `v3:${live.authContextId}`, JSON.stringify(live)); assert.equal(live.marker, null);
  // Phase B: suspend only the MV3 worker (storage.session survives), then wake it by navigation.
  const stopPage = await context.newPage();
  await stopPage.goto('chrome://version').catch(() => {});
  const cdp = await context.newCDPSession(stopPage);
  let stopped = false;
  try {
    const versions = new Map();
    cdp.on('ServiceWorker.workerVersionUpdated', (event) => { for (const version of event.versions || []) versions.set(version.versionId, version); });
    await cdp.send('ServiceWorker.enable');
    const relevant = () => [...versions.values()].filter((version) => String(version.scriptURL || '').startsWith(`chrome-extension://${extensionId}/`));
    const deadline = Date.now() + 10_000;
    let consecutive = 0;
    while (Date.now() < deadline && !stopped) {
      for (const version of relevant()) if (version.runningStatus !== 'stopped') await cdp.send('ServiceWorker.stopWorker', { versionId: version.versionId }).catch(() => {});
      await cdp.send('ServiceWorker.stopAllWorkers').catch(() => {});
      await sleep(50);
      const current = relevant();
      const byProtocol = current.length > 0 && current.every((version) => version.runningStatus === 'stopped');
      const { targetInfos = [] } = await cdp.send('Target.getTargets').catch(() => ({ targetInfos: [] }));
      const byTarget = !targetInfos.some((target) => target.type === 'service_worker' && target.url.startsWith(`chrome-extension://${extensionId}/`));
      consecutive = (byProtocol || byTarget) ? consecutive + 1 : 0;
      stopped = consecutive >= 2;
    }
  } finally { await cdp.send('ServiceWorker.disable').catch(() => {}); await cdp.detach().catch(() => {}); }
  assert.equal(stopped, true, 'could not suspend the MV3 worker');
  await stopPage.goto(`${fixture.origin}/classroom?case=worker-suspension`);
  let woken = null;
  const wakeDeadline = Date.now() + 10_000;
  while (!woken && Date.now() < wakeDeadline) {
    for (const candidate of [...context.serviceWorkers()].reverse()) {
      if (await extensionWorkerDeclarationsReady(candidate)) { woken = candidate; break; }
    }
    if (!woken) await sleep(50);
  }
  assert.ok(woken, 'the worker did not wake after navigation');
  // Phase C: the woken worker restores the same authenticated classroom authority without any clear.
  const restored = await woken.evaluate(async () => {
    await authStateRestorePromise; await classroomStateRestorePromise; await studentAuthMutationTail;
    const auth = captureAuthenticatedContext('suspension restore');
    const restorable = await getRestorableClassroomOverlayState({ authContext: auth, expectedBinding: fabIdentityBinding() });
    const stored = await new Promise((done) => chrome.storage.local.get(['classroomControlStateV1', 'studentAuthInvalidatingV1'],
      (local) => chrome.storage.session.get(['classroomOverlayStateV1'], (session) => done({ ...local, ...session }))));
    return { authenticated: hasStudentAuth(), authContextId: CONFIG.authContextId, classroom: currentClassroomState?.supervisionContextId ?? null, revision: currentClassroomState?.revision ?? null,
      timer: restorable?.timer?.supervisionContextId ?? null, storedClassroom: stored.classroomControlStateV1?.supervisionContextId ?? null, marker: stored.studentAuthInvalidatingV1 ?? null,
      authClears: __managedRecoveryFixture.authClears.map((event) => event.reason), startup: authGateStartupComplete,
      overlay: stored.classroomOverlayStateV1 ? { binding: stored.classroomOverlayStateV1.binding, timer: stored.classroomOverlayStateV1.timer?.supervisionContextId ?? null, revision: stored.classroomOverlayStateV1.timer?.contextAuthorityRevision ?? null } : null,
      fab: currentFabState ? { context: currentFabState.supervisionContextId ?? null, ownership: currentFabState.ownershipRevision ?? null, authority: currentFabState.contextAuthorityRevision ?? null } : null,
      binding: fabIdentityBinding(), activeContexts: typeof activeClassroomContexts === 'function' ? activeClassroomContexts() : null };
  });
  assert.equal(restored.authenticated, true, `suspension must not sign the student out (${JSON.stringify(restored)})`);
  assert.equal(restored.authContextId, live.authContextId, 'the exact auth context must survive suspension');
  assert.deepEqual(restored.authClears, [], 'an ordinary suspension must not run any auth clear');
  assert.equal(restored.classroom, 'ctx-live', 'supervision-context classroom state must be restored after suspension');
  assert.equal(restored.revision, 41);
  assert.equal(restored.storedClassroom, 'ctx-live'); assert.equal(restored.marker, null); assert.equal(restored.startup, true);
  assert.equal(await stopPage.locator('#classpilot-auth-gate').count(), 0, 'an authenticated page must not be gated after suspension');
  // Recorded, not asserted: the timer/poll overlay is a separate session
  // record. In 2.8.9 the worker-wake classroom restore treats the in-memory
  // scope change (null -> supervision context) as an authority change and
  // clears overlays; the contract under test only covers classroom state.
  console.log('PASS ordinary worker suspension preserves supervision-context classroom state without any clear', JSON.stringify({ authContextId: live.authContextId, outcome: live.outcome, overlayTimerAfterWake: restored.timer, overlayRecordAfterWake: restored.overlay }));
});

for(const name of sourceFiles)assert.equal(sha256(readFileSync(join(sourceRoot,name))),sourceHashes[name],`source changed during test: ${name}`);
console.log('Verified immutable production source inventory',JSON.stringify({version:candidateVersion,files:sourceHashes}));
if (compatibilityRun) {
  console.log(`ClassPilot recovery compatibility gate: ${completedBrowserCases.length} browser scenarios passed; historical upgrades not run: ${skippedHistoricalUpgrades.join(', ') || 'none selected'}.`);
} else {
  console.log('ClassPilot managed-mode recovery and legacy upgrade browser gate passed.');
}
