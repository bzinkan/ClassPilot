import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';
import { webcrypto } from 'node:crypto';

const source = readFileSync(process.env.CLASSPILOT_EXTENSION_PATH
  ? join(process.env.CLASSPILOT_EXTENSION_PATH, 'service-worker.js')
  : new URL('../extension/service-worker.js', import.meta.url), 'utf8').replace(/\r\n/g,'\n');
function functionSource(name) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
  assert.ok(match, `Missing production function ${name}`);
  const rest = source.slice(match.index + match[0].length);
  const next = /^}/m.exec(rest);
  assert.ok(next, `Missing end boundary for ${name}`);
  return source.slice(match.index, match.index + match[0].length + next.index + 1);
}
const functions = [
  'recordAuthGateRecoveryDiagnostic', 'authGateRecoveryError', 'authGateRecoveryFailurePayload',
  'createAuthGateResponseDeadline', 'armManagedPolicyRecovery', 'noteManagedPolicyRecoveryFailure',
  'clearManagedPolicyRecoveryFailure', 'ensureManagedAuthGatePolicyAvailable',
  'sharedManagedAuthGatePolicyRevalidation', 'trackedManagedAuthGatePolicyRevalidation', 'awaitManagedAuthGatePolicyStable',
  'readManagedConfigOnce', 'readManagedConfig', 'enqueueStudentAuthMutation', 'authMutationSuperseded',
  'assertManagedPolicyRevalidationCurrent',
  'writeAuthGateStartupPublication', 'readAuthGateStartupPublication',
  'armAuthGateStartupPublicationRecovery', 'runAuthGateStartupPublication',
  'beginAuthGateStartupPublication', 'retryAuthGateStartupPublications',
  'trackStartupNativeOperation', 'startupNativeIntentSatisfied', 'canonicalStorageJson',
  // 2.9.4 worker wake failure/abandonment recovery.
  'failedWakeRecoveryIsCurrent', 'retireFailedWakeRecovery', 'recoverFailedWakePolicy', 'beginFailedWorkerWakeRecovery',
  'retryFailedWakePolicyTransition',
  'getAuthGateSupportDetails', 'failWorkerWake', 'recordWorkerWakeFailure', 'settleWorkerWake',
  'armWorkerWakeWatchdog', 'hasSessionStorage', 'isManualIdentitySource', 'isManualLoginTimestampFresh',
];
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
function harness() {
  let now = 0, serial = 0, lastErrorReads = 0;
  const timers = new Map(), managedCallbacks = [], alarms = [], diagnostics = [];
  const runtime = { onMessage: { addListener(handler) { context.handler = handler; } } };
  Object.defineProperty(runtime, 'lastError', { get() { lastErrorReads++; return runtime.testError; } });
  const context = vm.createContext({
    console: { warn() {}, log() {} }, AbortController, queueMicrotask,
    Date: class extends Date { static now() { return now; } },
    setTimeout(fn, delay) { const id=++serial; timers.set(id,{fn,at:now+delay}); return id; },
    clearTimeout(id) { timers.delete(id); },
    chrome: { runtime, storage: { managed: { get(keys, callback) { managedCallbacks.push(callback); } } },
      alarms: { create(name, options) { alarms.push({name,...options}); }, clear() {} } },
    ClassPilotAuthRecoveryDiagnostics: { record(value) { diagnostics.push(value); } },
    AUTH_GATE_POLICY_READ_TIMEOUT_MS: 3000, AUTH_GATE_RPC_RESPONSE_TIMEOUT_MS: 9000, AUTH_GATE_REQUEST_TIMEOUT_MS: 5000,
    AUTH_GATE_POLICY_RECOVERY_ALARM: 'auth-gate-policy-recovery',
    AUTH_GATE_STARTUP_PUBLICATION_RECOVERY_ALARM: 'auth-gate-startup-publication-recovery',
    authGateStartupPublicationOwners: new Map(), authGateStartupPublicationStorageFailures: new WeakSet(),
    authGateStartupAuthSnapshotSupersededFailures: new WeakSet(),
    managedAuthGateStartupAuthorityTransition: null,
    AUTH_GATE_STARTUP_RECOVERABLE_OWNER_KINDS: new Set(['signed_out_clear', 'startup_readiness', 'failed_wake_clear', 'failed_wake_policy']),
    AUTH_GATE_STARTUP_LOOP_ATTEMPT_LIMIT: 8, STUDENT_AUTH_CLEAR_INTENT_KEY: 'clear-intent',
    startupWakeRecoveryFlags: null, studentSessionRecoveryState: { armed: null, pending: [] },
    rawLocalKv: null, durableSessionKv: null, CONFIG: {},
    manualStudentLoginPendingGeneration: 0, studentAuthCommitPending: false,
    SHARED_SIGN_IN_CONFIG_RETRY_DELAYS_MS: [2000,5000,15000,30000], MANAGED_CONFIG_KEYS: ['schoolId'],
    managedAuthGatePolicyGeneration: 1, managedAuthGatePolicyFailure: null,
    managedAuthGatePolicyRecoveryAttempt: 0, managedAuthGatePolicyUserRetryAt: null,
    managedAuthGateDirectRevalidationInFlight: null, authStateRestorePromise: Promise.resolve(),
    managedConfigReadGeneration:-1,managedConfigReadPromise:null,
    managedAuthGatePolicyRestorePromise: Promise.resolve(), authGateStartupComplete: true,
    studentAuthMutationGeneration: 0, studentAuthCommitPendingGeneration: 0,
    studentAuthMutationPendingCount: 0, studentAuthMutationTail: Promise.resolve(),
    safeDiagnosticError: () => ({name:'Error'}),
    // 2.9.4 worker wake bookkeeping (production defaults).
    workerWakeStep: 'start', workerWakeStartedAt: 0, workerWakeSettled: false, workerWakeRetired: false,
    workerWakeManagedPolicyApplied: false, workerWakeAuthRestoreOutcome: 'pending', workerWakeAuthGeneration: 0,
    workerWakePolicyGeneration: 1, workerWakePolicyBarrier: null,
    startupFailedWakeRecovery: null, workerWakeFirstFailure: null,
    retireWorkerWakePolicyRestore: null, AUTH_GATE_WAKE_WATCHDOG_MS: 30000,
    AUTH_GATE_WAKE_FAILURE_STORAGE_KEY: 'wake-failure', authGateRosterContextReady: false,
    MANUAL_LOGIN_STALE_MS: 5 * 60 * 1000, MANUAL_LOGIN_FUTURE_SKEW_MS: 1000,
  });
  for (const name of functions) vm.runInContext(functionSource(name),context,{filename:`production:${name}`});
  return { context, timers, managedCallbacks, alarms, diagnostics,
    get lastErrorReads() { return lastErrorReads; },
    async advance(ms) {
      const until=now+ms;
      while (true) {
        const due=[...timers].filter(([,v])=>v.at<=until).sort((a,b)=>a[1].at-b[1].at)[0];
        if (!due) break;
        now=due[1].at; timers.delete(due[0]); due[1].fn(); await flush();
      }
      now=until; await flush();
    },
  };
}

test('an absent managed API is unavailable and never a successful empty policy', async () => {
  for (const managed of [undefined, {}]) {
    const h = harness(); h.context.chrome.storage.managed = managed;
    await assert.rejects(h.context.readManagedConfig(), error => error.code === 'AUTH_GATE_POLICY_UNAVAILABLE');
    await assert.rejects(h.context.readManagedConfig(), error => error.code === 'AUTH_GATE_POLICY_UNAVAILABLE');
    assert.equal(h.managedCallbacks.length, 0);
  }
});

test('server deadline includes a stalled body and is classified separately from a missing worker reply', async () => {
  const h = harness();
  vm.runInContext(functionSource('fetchAuthGateRequest'), h.context);
  h.context.fetch = async (_url, { signal }) => ({ ok: true, json: () => new Promise((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new Error('fixture-private-body')), { once: true });
  }) });
  let failure;
  const pending = h.context.fetchAuthGateRequest('https://private.invalid/secret').catch(error => { failure = error; });
  await h.advance(4999); assert.equal(failure, undefined);
  await h.advance(1); await pending;
  assert.equal(failure.code, 'AUTH_GATE_TIMEOUT');
  assert.equal(h.context.authGateRecoveryFailurePayload(failure).errorCode, 'AUTH_GATE_SERVER_TIMEOUT');
  assert.equal(h.diagnostics[0].stage, 'server_request'); assert.equal(h.diagnostics[0].cause, 'timeout');
  assert.equal(h.diagnostics[0].elapsedMs, 5000);
  assert.equal(JSON.stringify(h.diagnostics).includes('private'), false);
});

test('server network, HTTP and malformed-body diagnostics contain fixed causes only', async () => {
  for (const [kind, cause] of [['network', 'network_failure'], ['http', 'http_failure'], ['json', 'invalid_payload']]) {
    const h = harness(); vm.runInContext(functionSource('fetchAuthGateRequest'), h.context);
    h.context.fetch = async () => {
      if (kind === 'network') throw new Error('private-server-detail');
      return { ok: kind !== 'http', json: async () => kind === 'json' ? [] : {} };
    };
    await h.context.fetchAuthGateRequest('https://private.invalid').catch(() => {});
    assert.equal(h.diagnostics[0].stage, 'server_request'); assert.equal(h.diagnostics[0].cause, cause);
    assert.equal(JSON.stringify(h.diagnostics).includes('private'), false);
  }
});

test('managed read times out at3s, rejects even optional fallback, and ignores a late callback',async()=>{
  const h=harness(); let error;
  const pending=h.context.readManagedConfig().catch(e=>{error=e;});
  await h.advance(2999); assert.equal(error,undefined);
  await h.advance(1); await pending;
  assert.equal(error.code,'AUTH_GATE_POLICY_TIMEOUT'); assert.equal(h.timers.size,0);
  h.managedCallbacks[0]({schoolId:'obsolete'}); await flush();
  assert.equal(h.lastErrorReads,1); assert.equal(error.code,'AUTH_GATE_POLICY_TIMEOUT');
  assert.equal(h.diagnostics[0].stage,'policy_read');
});

test('managed success/error/throw each settle once without leaving timeout work',async()=>{
  const success=harness(); const value=success.context.readManagedConfig({failClosed:true});
  success.managedCallbacks[0]({schoolId:'current'}); assert.equal((await value).schoolId,'current');
  assert.equal(success.timers.size,0);
  const failed=harness(); failed.context.chrome.runtime.testError={message:'must not escape'};
  const rejected=failed.context.readManagedConfig();
  failed.managedCallbacks[0]({schoolId:'untrusted'});
  await assert.rejects(rejected,e=>e.code==='AUTH_GATE_POLICY_UNAVAILABLE'&&!e.message.includes('must not escape'));
  const throwing=harness(); throwing.context.chrome.storage.managed.get=()=>{throw new Error('private details');};
  await assert.rejects(throwing.context.readManagedConfig({failClosed:true}),e=>e.code==='AUTH_GATE_POLICY_UNAVAILABLE');
  assert.equal(throwing.timers.size,0);
});

test('an unexpired managed callback from a superseded generation rejects instead of optional empty policy',async()=>{
  const h=harness();
  const stale=h.context.readManagedConfig();
  await h.advance(100);
  h.context.managedAuthGatePolicyGeneration=2;
  h.context.managedAuthGatePolicyRestorePromise=Promise.resolve();
  const fresh=h.context.readManagedConfig({failClosed:true});
  h.managedCallbacks[1]({schoolId:'current-school'});
  assert.equal((await fresh).schoolId,'current-school');
  h.managedCallbacks[0]({schoolId:'obsolete-foreign-school'});
  await assert.rejects(stale,error=>error.code==='AUTH_MUTATION_SUPERSEDED');
  assert.equal(h.timers.size,0);
  assert.equal(h.lastErrorReads,2);
});

test('same-generation readers join one native attempt and reuse its current fulfilled snapshot',async()=>{
  const h=harness(), c=h.context;
  const first=c.readManagedConfig({failClosed:true}), second=c.readManagedConfig();
  assert.equal(h.managedCallbacks.length,1);
  h.managedCallbacks[0]({schoolId:'current-school'});
  assert.deepEqual((await Promise.all([first,second])).map(value=>value.schoolId),['current-school','current-school']);
  assert.equal((await c.readManagedConfig()).schoolId,'current-school');
  assert.equal(h.managedCallbacks.length,1,'a later background read must not compete with the proven generation');
  c.managedAuthGatePolicyGeneration=2;
  c.managedAuthGatePolicyRestorePromise=Promise.resolve();
  const replacement=c.readManagedConfig();
  assert.equal(h.managedCallbacks.length,2);
  h.managedCallbacks[1]({schoolId:'replacement-school'});
  assert.equal((await replacement).schoolId,'replacement-school');
});

test('a failed generation cannot fall back to empty or start another native read until recovery advances it',async()=>{
  const h=harness(), c=h.context;
  const failed=c.readManagedConfig();
  const checked=assert.rejects(failed,error=>error.code==='AUTH_GATE_POLICY_TIMEOUT');
  await h.advance(3000); await checked;
  await assert.rejects(c.readManagedConfig(),error=>error.code==='AUTH_GATE_POLICY_TIMEOUT');
  assert.equal(h.managedCallbacks.length,1);
  c.managedAuthGatePolicyGeneration=2;
  c.managedAuthGatePolicyRestorePromise=Promise.resolve();
  const recovered=c.readManagedConfig();
  h.managedCallbacks[0]({schoolId:'expired-school'});
  h.managedCallbacks[1]({schoolId:'recovered-school'});
  assert.equal((await recovered).schoolId,'recovered-school');
});

function managedApplicationHarness(name) {
  const h=harness(), c=h.context, applications=[];
  Object.assign(c,{
    CONFIG:{serverUrl:'https://current.example',schoolId:'current-school',schoolSlug:'current',enrollmentKey:'current-key'},
    DEFAULT_SERVER_URL:'https://default.example',INJECTED_SERVER_URL:'https://default.example',
    fastAuthGateEnabled:true,studentAuthMutationGeneration:1,
    STUDENT_AUTH_INVALIDATING_KEY:'invalidating',MANAGED_AUTH_GATE_BINDING_KEY:'binding',
    isExplicitUnmanagedDevelopmentServer:()=>false,
    isHttpUrl:value=>typeof value==='string'&&/^https?:\/\//.test(value),
    assertChromeProfileRegistrationAllowed(){},assertAuthMutationCurrent(){},
    expireManualAuthIfStale:async()=>{},hasStudentAuth:()=>true,
    getStoredAuthState:async()=>({studentToken:'existing',activeStudentId:'existing',activeStudentSessionId:'existing'}),
    authGateConfigBindingKey:()=>JSON.stringify(c.CONFIG),resetSharedSignInLoginConfigCache(){},
  });
  for (const helper of ['extractManagedValue','normalizeManagedString','applyManagedSchoolConfig','applyManagedAuthGatePolicySnapshot',name]) {
    vm.runInContext(functionSource(helper),c,{filename:`production:${helper}`});
  }
  const apply=c.applyManagedSchoolConfig;
  c.applyManagedSchoolConfig=config=>{applications.push(config);return apply(config);};
  return {...h,applications};
}

for (const name of ['resolveServerUrl','refreshSharedSignInLoginConfigFast',
  'refreshSharedSignInLoginConfigLegacy','ensureRegisteredNow','autoDetectAndRegister']) {
  test(`${name} fences a managed result superseded between callback resolution and application`,async()=>{
    const h=managedApplicationHarness(name), c=h.context;
    const operation=c[name]();
    const checked=name==='ensureRegisteredNow' ? operation : assert.rejects(operation,error=>error.code==='AUTH_MUTATION_SUPERSEDED');
    await flush();
    assert.equal(h.managedCallbacks.length,1,'the production caller must reach its managed read');
    // The callback is timely/current when delivered. Supersede before the
    // await continuation; guarding only inside the native callback is not enough.
    h.managedCallbacks[0]({serverUrl:'https://obsolete.example',schoolId:'obsolete-foreign-school',enrollmentKey:'obsolete-key'});
    c.managedAuthGatePolicyGeneration=2;
    c.managedAuthGatePolicyRestorePromise=Promise.resolve();
    const before=JSON.stringify(c.CONFIG);
    await checked;
    assert.equal(h.applications.length,0);
    assert.equal(JSON.stringify(c.CONFIG),before);
  });
}

test('server URL fallback cannot return an old persisted endpoint after policy supersession',async()=>{
  const h=managedApplicationHarness('resolveServerUrl'), local=deferred(), c=h.context;
  c.chrome.storage.local={get:()=>local.promise};
  const operation=c.resolveServerUrl();
  const checked=assert.rejects(operation,error=>error.code==='AUTH_MUTATION_SUPERSEDED');
  h.managedCallbacks[0]({});
  await flush();
  assert.equal(h.applications.length,1,'the current empty snapshot was applied before fallback');
  c.managedAuthGatePolicyGeneration=2;
  c.managedAuthGatePolicyRestorePromise=Promise.resolve();
  local.resolve({config:{serverUrl:'https://obsolete.example'}});
  await checked;
  assert.equal(c.CONFIG.serverUrl,'https://current.example');
});

test('worker watchdog returns only a bounded failure and cannot publish late state or proof',async()=>{
  const h=harness(), replies=[];
  const reply=h.context.createAuthGateResponseDeadline(value=>replies.push(value));
  await h.advance(9000);
  assert.equal(replies[0].errorCode,'AUTH_GATE_RPC_TIMEOUT');
  assert.deepEqual(Object.keys(replies[0]).sort(),['errorCode','retryAt','success']);
  assert.equal(reply({success:true,state:{phase:'authenticated'},managedPolicyFence:7}),false);
  assert.equal(replies.length,1);
  h.context.authGateStartupComplete=false;
  h.context.createAuthGateResponseDeadline(value=>replies.push(value));
  await h.advance(9000); assert.equal(replies[1].errorCode,'AUTH_GATE_STARTUP_TIMEOUT');
  assert.equal(h.context.authGateStartupComplete,false);
});

test('normal response clears watchdog and closing document cannot reject worker work',async()=>{
  const h=harness(), replies=[];
  const reply=h.context.createAuthGateResponseDeadline(value=>replies.push(value));
  assert.equal(reply({success:true}),true); await h.advance(10000); assert.equal(replies.length,1);
  const closed=h.context.createAuthGateResponseDeadline(()=>{throw new Error('closed');});
  assert.doesNotThrow(()=>closed({success:true})); assert.equal(h.timers.size,0);
});

test('policy failure backs off2/5/15/30s and a fresh due read replaces the rejected promise',async()=>{
  const h=harness(); let calls=0;
  h.context.runManagedAuthGatePolicyRevalidation=async()=>{
    calls++; const generation=++h.context.managedAuthGatePolicyGeneration;
    const error=h.context.authGateRecoveryError('AUTH_GATE_POLICY_TIMEOUT');
    h.context.noteManagedPolicyRecoveryFailure(generation,error); throw error;
  };
  for (const delay of [2000,5000,15000,30000,30000]) {
    const before=calls; await assert.rejects(h.context.sharedManagedAuthGatePolicyRevalidation());
    assert.equal(calls,before+1); assert.equal(h.context.managedAuthGateDirectRevalidationInFlight,null);
    const retryAt=h.context.managedAuthGatePolicyFailure.retryAt;
    await assert.rejects(h.context.sharedManagedAuthGatePolicyRevalidation()); assert.equal(calls,before+1);
    await h.advance(delay); assert.equal(h.context.Date.now(),retryAt);
  }
});

test('explicit Retry bypasses backoff once and simultaneous callers share pending strict work',async()=>{
  const h=harness(); h.context.noteManagedPolicyRecoveryFailure(1,h.context.authGateRecoveryError('AUTH_GATE_POLICY_TIMEOUT'));
  const work=deferred(); let calls=0;
  h.context.runManagedAuthGatePolicyRevalidation=()=>{calls++; return work.promise;};
  const first=h.context.sharedManagedAuthGatePolicyRevalidation({userInitiated:true});
  const second=h.context.sharedManagedAuthGatePolicyRevalidation({userInitiated:true}); await flush();
  assert.equal(calls,1); const tracked=h.context.managedAuthGateDirectRevalidationInFlight;
  const replies=[];h.context.createAuthGateResponseDeadline(value=>replies.push(value)); await h.advance(9000);
  assert.equal(h.context.managedAuthGateDirectRevalidationInFlight,tracked);
  const third=h.context.sharedManagedAuthGatePolicyRevalidation({userInitiated:true}); await flush(); assert.equal(calls,1);
  work.resolve({state:{phase:'ready'}}); await Promise.all([first,second,third]);
  assert.equal(h.context.managedAuthGateDirectRevalidationInFlight,null);
});

test('obsolete policy failure cannot schedule recovery for a replacement generation',()=>{
  const h=harness(); h.context.managedAuthGatePolicyGeneration=2;
  h.context.noteManagedPolicyRecoveryFailure(1,h.context.authGateRecoveryError('AUTH_GATE_POLICY_TIMEOUT'));
  assert.equal(h.context.managedAuthGatePolicyFailure,null);assert.equal(h.alarms.length,0);
});

test('auth mutation pending count includes queued work and preserves ordering on rejection',async()=>{
  const h=harness(), first=deferred(), order=[];
  const one=h.context.enqueueStudentAuthMutation(async()=>{order.push('one');await first.promise;throw new Error('expected');});
  const settled=one.catch(()=>{});
  const two=h.context.enqueueStudentAuthMutation(async()=>{order.push('two');});
  assert.equal(h.context.studentAuthMutationPendingCount,2); await flush(); assert.deepEqual(order,['one']);
  first.resolve(); await Promise.all([settled,two]); assert.deepEqual(order,['one','two']);
  assert.equal(h.context.studentAuthMutationPendingCount,0);
});

function gateHandler(h) {
  const c=h.context;
  Object.assign(c,{
    ordinaryAuthStateColdCohortOpen:true,authGateStateColdWorker:false, fastAuthGateEnabled:true,
    manualStudentLoginRequestsPending:0, manualStudentLoginPendingGeneration:0,studentAuthCommitPending:false,
    sharedSignInConfigUserRetryAt:null,sharedSignInLoginConfig:{phase:'unavailable',retryAt:60000},
    expireManualAuthIfStaleFailClosed() {},hasStudentAuth:()=>false,
    ensureManagedAuthGatePolicyAvailable:async()=>{}, refreshSharedSignInLoginConfig:async()=>{},
    getPublishableAuthGateState:async()=>({phase:'ready',authRequired:true,revision:3,fastAuthGateEnabled:true}),
  });
  const start=source.lastIndexOf('chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {');
  const end=source.indexOf('\n});',start)+4;
  vm.runInContext(source.slice(start,end),c,{filename:'production:gate-handler'});
  return c.handler;
}

function startupPublicationHarness({authenticated=false,interruptedFlag=null}={}) {
  const h=harness(), c=h.context, handler=gateHandler(h), cleanup=deferred(), refreshes=[];
  Object.assign(c,{
    authGateStartupComplete:false,authGateRevisionReady:true,
    workerWakeAuthRestoreOutcome:'verified',
    interruptedAuthClear:false,interruptedAuthCommit:false,
    manualAuthTimestampInvalid:false,manualAuthSessionStorageUnavailable:false,
    hasStudentAuth:()=>authenticated,fixtureDurableCleanup:cleanup.promise,
    refreshSharedSignInLoginConfig:async options=>{refreshes.push(options);},
    getPublishableAuthGateState:async()=>({phase:authenticated?'authenticated':'ready',
      authRequired:!authenticated,revision:3,fastAuthGateEnabled:true}),
  });
  if (interruptedFlag) c[interruptedFlag]=true;
  const barrierStart=source.indexOf('let markAuthStateRestored;');
  const barrierEnd=source.indexOf('\n\n// Run immediately on service worker load/wake-up',barrierStart);
  assert.ok(barrierStart>=0&&barrierEnd>barrierStart,'production startup barrier must be found');
  vm.runInContext(source.slice(barrierStart,barrierEnd),c,{filename:'production:startup-barrier'});
  const earlyEnd=source.indexOf('\n  const assertWorkerWakeCurrent =');
  const earlyStart=source.lastIndexOf('\n  if (',earlyEnd);
  const earlyPublication=source.slice(earlyStart,earlyEnd);
  assert.ok(earlyPublication.includes('markAuthStateRestored();'),'production early-publication block must be found');
  const finalPublication=source.match(/markClassroomStateRestored\(\);\n  if \(!authGateStartupComplete\) ensureStartupReadinessPublication\(\);/g);
  assert.equal(finalPublication?.length,1,'production final publication must be unique');
  for (const name of ['ensureStartupReadinessPublication','nudgeStartupReadinessPublication',
    'publishStartupReadinessWhenVerified','startupPolicyFailureTolerated','assertStartupReadinessSignedOut',
    'computeStartupSignedOutClearPlan','beginStartupSignedOutClear']) vm.runInContext(functionSource(name),c,{filename:`production:${name}`});
  Object.assign(c,{
    markClassroomStateRestored(){},
    startupWakeRecoveryFlags:Object.freeze({
      interruptedAuthClear:interruptedFlag==='interruptedAuthClear',
      interruptedAuthCommit:interruptedFlag==='interruptedAuthCommit',
      manualAuthTimestampInvalid:interruptedFlag==='manualAuthTimestampInvalid',
      manualAuthSessionStorageUnavailable:interruptedFlag==='manualAuthSessionStorageUnavailable',
      clearIntent:null,
    }),
    // The controlled durable-cleanup seam stands in for the tracked signed-out clear.
    clearStudentAuth:()=>cleanup.promise,
    initializeAuthGateRevisionPublication:async()=>{},
    initializeAuthGateRosterContextPublication:async()=>{},
    awaitAuthGateRosterContextStable:async()=>{},
  });
  // Execute the actual production publication blocks around a controlled
  // durable-cleanup seam. The real gate handler must honor the resulting
  // barrier; the full browser gate separately exercises all wake operations.
  vm.runInContext(`globalThis.fixtureStartup = (async () => {
    ${earlyPublication}
    await fixtureDurableCleanup;
  })().finally(() => { ${finalPublication[0]} });`,c,{filename:'production:wake-publication'});
  return {...h,handler,cleanup,refreshes};
}

test('unsigned startup with blocked durable cleanup cannot publish readiness or start login config',async()=>{
  const h=startupPublicationHarness(), replies=[];
  h.handler({type:'get-auth-state'},{},value=>replies.push(value));
  await h.advance(8999);
  assert.equal(h.context.authGateStartupComplete,false);
  assert.equal(replies.length,0);assert.equal(h.refreshes.length,0);
  await h.advance(1);
  assert.equal(replies[0].errorCode,'AUTH_GATE_STARTUP_TIMEOUT');
  assert.equal('state' in replies[0],false);
  assert.equal(h.context.authGateStartupComplete,false);
  assert.equal(h.refreshes.length,0,'a response deadline must not bypass durable cleanup');
  h.cleanup.resolve();await h.context.fixtureStartup;await h.context.authStateRestorePromise;await flush();
  assert.equal(h.context.authGateStartupComplete,true);
  assert.equal(h.refreshes.length,1);
  assert.equal(replies.length,1,'the expired request must not receive a late ready reply');
  h.handler({type:'get-auth-state'},{},value=>replies.push(value));await flush();
  assert.equal(replies[1].state.phase,'ready');
});

test('only verified authenticated startup publishes early; interrupted snapshots keep the gate barrier closed',async()=>{
  const healthy=startupPublicationHarness({authenticated:true}), replies=[];
  healthy.handler({type:'get-auth-state'},{},value=>replies.push(value));await flush();
  assert.equal(healthy.context.authGateStartupComplete,true);
  assert.equal(replies[0].state.phase,'authenticated');
  assert.equal(healthy.refreshes.length,0);
  healthy.cleanup.resolve();await healthy.context.fixtureStartup;
  for (const interruptedFlag of ['interruptedAuthClear','interruptedAuthCommit',
    'manualAuthTimestampInvalid','manualAuthSessionStorageUnavailable']) {
    const blocked=startupPublicationHarness({authenticated:true,interruptedFlag}), blockedReplies=[];
    blocked.handler({type:'get-auth-state'},{},value=>blockedReplies.push(value));
    await blocked.advance(1000);
    assert.equal(blocked.context.authGateStartupComplete,false,interruptedFlag);
    assert.equal(blockedReplies.length,0,interruptedFlag);
    assert.equal(blocked.refreshes.length,0,interruptedFlag);
    blocked.cleanup.resolve();await blocked.context.fixtureStartup;await flush();
  }
});

test('fresh gate replies hold unresolved manual login but permit committed authentication',async()=>{
  const h=harness(), handler=gateHandler(h), replies=[];
  h.context.manualStudentLoginRequestsPending=1;
  handler({type:'get-auth-state'},{},value=>replies.push(value)); await flush();
  assert.equal(replies[0].errorCode,'AUTH_GATE_LOGIN_PENDING'); assert.equal('state' in replies[0],false);
  h.context.getPublishableAuthGateState=async()=>({phase:'authenticated',authRequired:false,revision:4});
  handler({type:'get-auth-state'},{},value=>replies.push(value)); await flush();
  assert.equal(replies[1].state.phase,'authenticated');
  h.context.manualStudentLoginRequestsPending=0;
  h.context.getPublishableAuthGateState=async()=>({phase:'ready',authRequired:true,revision:5});
  handler({type:'get-auth-state'},{},value=>replies.push(value)); await flush();
  assert.equal(replies[2].state.phase,'ready'); assert.equal('manualLoginPending' in replies[2],false);
});

test('page retries respect config backoff and explicit Retry consumes one bypass',async()=>{
  const h=harness(), handler=gateHandler(h), requests=[];
  h.context.refreshSharedSignInLoginConfig=async options=>{requests.push(options);};
  for (const reason of ['page_timer','user','user']) {handler({type:'refresh-auth-state',reason},{},()=>{});await flush();}
  assert.deepEqual(requests.map(value=>value.force),[false,true,false]);
  assert.ok(requests.every(value=>value.managedConfigAlreadyApplied));
});

test('ordinary state polling reuses proven policy rather than rereading managed storage',async()=>{
  const h=harness(), handler=gateHandler(h), requests=[];
  h.context.refreshSharedSignInLoginConfig=async options=>{requests.push(options);};
  handler({type:'get-auth-state'},{},()=>{});await flush();
  assert.equal(requests[0].managedConfigAlreadyApplied,true);assert.equal(requests[0].force,undefined);
  assert.equal(h.managedCallbacks.length,0);
});

// Exercise the real publication initializers, durable reservation and stable
// readiness barriers. Only the native storage adapter is controlled here.
function durablePublicationHarness({kind,operation='set',failure='reject',failCount=1,autoStart=true}={}) {
  const h=harness(), c=h.context, handler=gateHandler(h), pending=deferred();
  const state={}, reads=[], writes=[];
  const revisionReady=deferred(), rosterReady=deferred();
  let failures=0, reconciling=false;
  const selectedKey=kind==='revision'?'revision-ceiling':'roster-context';
  const applyFailure=async(op,key)=>{
    // The injected read fault models the owner's own narrow fresh read; the
    // 2.9.0 reconcile reads (read-before-fail, deadline) bypass it.
    if(op!==operation||key!==selectedKey||failures>=failCount||(op==='get'&&reconciling)) return;
    failures++;
    if(failure==='pending') await pending.promise;
    else throw new Error('private-native-storage-detail');
  };
  Object.assign(c,{
    crypto:webcrypto,TextEncoder,Uint8Array,
    AUTH_GATE_REVISION_STORAGE_KEY:'revision-ceiling',AUTH_GATE_REVISION_BLOCK_SIZE:1024,
    AUTH_GATE_ROSTER_CONTEXT_STORAGE_KEY:'roster-context',AUTH_GATE_ROSTER_CONTEXT_SCHEMA_VERSION:1,
    authGateStateRevision:0,authGateStateRevisionCeiling:0,authGateStatePendingRevisionBumps:0,
    authGateRevisionReady:false,authGateRevisionReadyPromise:revisionReady.promise,
    resolveAuthGateRevisionReady:revisionReady.resolve,
    authGateRosterContextGeneration:0,authGateRosterContextFingerprint:null,authGateRosterContextReady:false,
    authGateRosterContextReadyPromise:rosterReady.promise,resolveAuthGateRosterContextReady:rosterReady.resolve,
    authGateRosterContextMutationTail:Promise.resolve(),sharedSignInConfigGeneration:1,
    CONFIG:{enrollmentKey:'fixture-enrollment'},hasManagedSchoolSetup:()=>true,
    authGateConfigBinding:()=>({serverOrigin:'https://fixture.invalid',schoolId:'fixture-school',schoolSlug:'fixture'}),
    sharedSignInLoginConfig:{phase:'ready',sharedSignInEnabled:true,loginMethod:'name_pin',pinLoginEnabled:true,schoolId:'fixture-school'},
    rawLocalKv:{async get(keys){reads.push(keys[0]);await applyFailure('get',keys[0]);return {...state};}},
    durableLocalKv:{async set(values){const key=Object.keys(values)[0];writes.push(key);await applyFailure('set',key);Object.assign(state,values);}},
    authGateStartupComplete:false,
  });
  for(const name of ['initializeAuthGateRevisionPublication','initializeAuthGateRosterContextPublication',
    'reserveAuthGateRevisionBlock','normalizedAuthGateRosterContextState','authGateRosterContextMaterial',
    'authGateRosterContextFingerprintForCurrentMaterial','reconcileAuthGateRosterContext',
    'awaitAuthGateRevisionPublicationReady','awaitAuthGateRosterContextStable']) {
    vm.runInContext(functionSource(name),c,{filename:`production:${name}`});
  }
  const satisfied=c.startupNativeIntentSatisfied;
  c.startupNativeIntentSatisfied=async(intended)=>{reconciling=true;try{return await satisfied(intended);}finally{reconciling=false;}};
  // Roster startup receives the wake snapshot. A retry after a rejected write
  // performs its own narrow fresh read; seed that rejection when testing GET.
  if(kind==='roster_context'&&operation==='get') {
    const set=c.durableLocalKv.set;let first=true;
    c.durableLocalKv.set=async values=>{if(first&&values['roster-context']){first=false;writes.push('roster-context');throw new Error('fixture-first-write-rejected');}return set(values);};
  }
  if(autoStart) {
    const revision=c.initializeAuthGateRevisionPublication();
    const roster=c.initializeAuthGateRosterContextPublication(null);
    c.authStateRestorePromise=Promise.all([revision,roster]).then(()=>{c.authGateStartupComplete=true;});
  }
  c.getPublishableAuthGateState=async()=>{
    await c.awaitAuthGateRevisionPublicationReady();await c.awaitAuthGateRosterContextStable();
    return {phase:'ready',authRequired:true,revision:c.authGateStateRevision,fastAuthGateEnabled:true};
  };
  return {...h,handler,state,reads,writes,pending,selectedKey,
    async settle(){for(let i=0;i<5;i++){await new Promise(done=>setImmediate(done));await flush();}},
    get failures(){return failures;},
  };
}

for(const kind of ['revision','roster_context']) {
  for(const operation of ['set','get']) {
    test(`completed ${kind} ${operation} rejection permits fresh explicit Retry without poisoning startup`,async()=>{
      const h=durablePublicationHarness({kind,operation}),c=h.context,replies=[];
      await h.settle();
      if(kind==='roster_context'&&operation==='get') {
        c.retryAuthGateStartupPublications({userInitiated:true});await h.settle();
      }
      assert.equal(h.failures,1,'the selected native storage operation must actually fail');
      assert.equal(c.authGateStartupComplete,false);
      assert.equal(kind==='revision'?c.authGateRevisionReady:c.authGateRosterContextReady,false);
      const operationsBefore=h.reads.length+h.writes.length;
      // Status polling must not repeatedly bypass a completed failure's delay.
      for(let i=0;i<20;i++)c.retryAuthGateStartupPublications();
      await h.settle();assert.equal(h.reads.length+h.writes.length,operationsBefore);
      h.handler({type:'refresh-auth-state',reason:'user'},{},value=>replies.push(value));
      h.handler({type:'refresh-auth-state',reason:'user'},{},value=>replies.push(value));
      await h.settle();await c.authStateRestorePromise;await flush();
      assert.equal(c.authGateStartupComplete,true);
      assert.equal(c.authGateRevisionReady,true);assert.equal(c.authGateRosterContextReady,true);
      assert.ok(h.state['revision-ceiling']>c.authGateStateRevision);
      assert.equal(h.state['roster-context'].generation,c.authGateRosterContextGeneration);
      assert.equal(replies.length,2);assert.ok(replies.every(reply=>reply.success&&reply.state.authRequired));
      assert.equal(c.authGateStartupPublicationOwners.get(kind).settled,true);
      assert.equal(JSON.stringify(h.diagnostics).includes('private'),false);
    });

    test(`never-settling ${kind} ${operation} is reconciled at the response deadline and recovers only on Retry`,async()=>{
      const h=durablePublicationHarness({kind,operation,failure:'pending'}),c=h.context,replies=[];
      await h.settle();
      if(kind==='roster_context'&&operation==='get') {c.retryAuthGateStartupPublications({userInitiated:true});await h.settle();}
      assert.equal(h.failures,1);
      const owner=c.authGateStartupPublicationOwners.get(kind),active=owner.inFlight;
      assert.ok(active);
      const writesBefore=h.writes.length;
      for(let i=0;i<5;i++)h.handler({type:'refresh-auth-state',reason:'user'},{},value=>replies.push(value));
      await h.advance(8999);await h.settle();
      assert.equal(c.authGateStartupComplete,false);
      assert.equal(owner.inFlight,active,'an unresolved operation stays owned until the response deadline');
      assert.equal(h.writes.length,writesBefore,'timed-out replies cannot replay unresolved storage');
      await h.advance(1);await h.settle();
      // The deadline reconciles from a fresh read. Nothing landed, so the owner is
      // now a completed, retryable failure; the native write is never re-issued.
      assert.equal(c.authGateStartupComplete,false);assert.equal(owner.inFlight,null);
      assert.equal(owner.failed,true);assert.ok(owner.retryAt>=c.Date.now()+2000);
      assert.equal(h.writes.length,writesBefore,'a stalled write is never replayed by the deadline');
      assert.ok(h.diagnostics.some(entry=>entry.stage==='startup'&&entry.cause==='stalled'));
      assert.equal(replies.length,5);assert.ok(replies.every(reply=>reply.success===false&&!('state' in reply)));
      h.pending.resolve();await h.settle();
      assert.equal(c.authGateStartupComplete,false,'a late native result cannot become authority');
      c.retryAuthGateStartupPublications({userInitiated:true});await h.settle();await c.authStateRestorePromise;
      assert.equal(c.authGateStartupComplete,true);
      // Retry re-runs the owner read-before-write: a late-landed write is reused,
      // a lost one is issued once. Never a blind replay of the stalled call.
      assert.ok(h.writes.length<=writesBefore+1,'explicit Retry re-issues at most one write');
      assert.equal(replies.length,5,'expired RPC callbacks never receive late authority');
    });
  }
}

test('completed stale roster publication never releases ready before current policy is durably reconciled',async()=>{
  const h=durablePublicationHarness({kind:'roster_context',failure:'pending'}),c=h.context;
  await h.settle();assert.equal(c.authGateRosterContextReady,false);
  c.managedAuthGatePolicyGeneration++;
  c.CONFIG.enrollmentKey='replacement-fixture-enrollment';
  h.pending.resolve();await h.settle();await c.authStateRestorePromise;
  assert.equal(h.writes.filter(key=>key==='roster-context').length,2);
  assert.equal(h.state['roster-context'].fingerprint,await c.authGateRosterContextFingerprintForCurrentMaterial());
  assert.equal(c.authGateRosterContextFingerprint,h.state['roster-context'].fingerprint);
  assert.equal(c.authGateStartupComplete,true);
});

test('validation failures and nonscoped startup reads are not retried as native storage errors',async()=>{
  const h=harness(),c=h.context;let calls=0;
  const failure=new Error('fixture-validation');
  await assert.rejects(c.beginAuthGateStartupPublication('revision',()=>{calls++;throw failure;}),error=>error===failure);
  c.retryAuthGateStartupPublications({userInitiated:true});await flush();assert.equal(calls,1);
  c.AUTH_GATE_REVISION_STORAGE_KEY='revision';c.AUTH_GATE_ROSTER_CONTEXT_STORAGE_KEY='roster';
  c.rawLocalKv={get:()=>{throw new Error('should-not-be-read');}};
  await assert.rejects(c.readAuthGateStartupPublication('student-token'),error=>!c.authGateStartupPublicationStorageFailures.has(error));
});

function authSnapshotHarness() {
  const h = harness(), c = h.context, reads = [], removes = [], cleanups = [];
  Object.assign(c, {
    STUDENT_AUTH_INVALIDATING_KEY: 'invalidating', STUDENT_AUTH_COMMIT_PENDING_KEY: 'commit-pending',
    AUTH_GATE_REVISION_STORAGE_KEY: 'revision-ceiling',
    SESSION_SCOPED_STUDENT_STORAGE_KEYS: new Set(['studentToken']),
    legacyStudentAuthCleanupAuthority: null, legacyStudentAuthCleanupPromise: null,
    localState: { config: {}, deviceId: 'fixture-only' }, sessionState: {},
    rawLocalKv: {
      async get(keys) { reads.push('local'); return { ...c.localState }; },
      async remove(keys) { removes.push([...keys]); },
    },
    durableSessionKv: {
      async get(keys) { reads.push('session'); return { ...c.sessionState }; },
      async remove() {},
    },
    captureLegacyStudentAuthCleanupAuthority() { return true; },
    async dispatchLegacyStudentAuthCleanup() { cleanups.push('legacy-cleanup'); },
  });
  c.chrome.storage.session = {};
  for (const name of ['hasSessionStorage', 'readAuthGateStartupAuthSnapshot', 'getStoredAuthState']) {
    vm.runInContext(functionSource(name), c);
  }
  return { ...h, reads, removes, cleanups };
}

for (const area of ['local', 'session']) {
  test(`initial auth ${area} read rejection retries only native reads, then runs migration once`, async () => {
    const h = authSnapshotHarness(), c = h.context;
    c.localState.studentToken = 'private-legacy-credential';
    c.sessionState.studentToken = 'private-current-credential';
    const adapter = area === 'local' ? c.rawLocalKv : c.durableSessionKv;
    const original = adapter.get; let calls = 0, settled = false;
    adapter.get = async keys => { if (++calls === 1) throw new Error('private-native-error'); return original(keys); };
    const pending = c.getStoredAuthState(['studentToken', 'config', 'deviceId'], { startupReadRecovery: true })
      .then(value => { settled = true; return value; });
    await flush();
    assert.equal(settled, false); assert.equal(h.removes.length, 0); assert.equal(h.cleanups.length, 0);
    for (let i = 0; i < 20; i++) c.retryAuthGateStartupPublications();
    await flush(); assert.equal(calls, 1);
    c.retryAuthGateStartupPublications({ userInitiated: true });
    c.retryAuthGateStartupPublications({ userInitiated: true });
    const result = await pending;
    assert.equal(result.studentToken, 'private-current-credential');
    assert.equal(calls, 2); assert.equal(h.removes.length, 1); assert.equal(h.cleanups.length, 1);
    assert.equal(c.authGateStartupPublicationOwners.has('auth_snapshot'), false);
    assert.equal(JSON.stringify(h.diagnostics).includes('private'), false);
  });

  test(`unresolved initial auth ${area} read fails closed at the response deadline and recovers only on Retry`, async () => {
    const h = authSnapshotHarness(), c = h.context, held = deferred();
    const adapter = area === 'local' ? c.rawLocalKv : c.durableSessionKv;
    const original = adapter.get; let calls = 0, settled = false;
    adapter.get = async keys => { calls++; await held.promise; return original(keys); };
    const pending = c.getStoredAuthState(['studentToken'], { startupReadRecovery: true }).then(() => { settled = true; });
    await flush(); const owner = c.authGateStartupPublicationOwners.get('auth_snapshot'), active = owner.inFlight;
    c.authGateStartupComplete = false;
    const responses = [];
    for (let i = 0; i < 5; i++) {
      c.createAuthGateResponseDeadline(value => responses.push(value));
      c.retryAuthGateStartupPublications({ userInitiated: true });
    }
    await h.advance(8999);
    assert.equal(calls, 1); assert.equal(owner.inFlight, active); assert.equal(settled, false);
    await h.advance(1); await flush();
    // A read has no intended state to reconcile, so the deadline turns it into a
    // completed, retryable failure. The late native result is discarded.
    assert.equal(calls, 1); assert.equal(owner.inFlight, null); assert.equal(owner.failed, true); assert.equal(settled, false);
    assert.ok(responses.every(value => value.errorCode === 'AUTH_GATE_STARTUP_TIMEOUT' && !('state' in value)));
    held.resolve(); await flush(); assert.equal(settled, false, 'a late native read never becomes authority');
    c.retryAuthGateStartupPublications({ userInitiated: true }); await pending;
    assert.equal(calls, 2);
    assert.equal(responses.length, 5); assert.equal(c.authGateStartupPublicationOwners.has('auth_snapshot'), false);
  });
}

test('policy changes discard both native snapshots; auth changes never reach migration or adoption', async () => {
  const h = authSnapshotHarness(), c = h.context, held = deferred();
  const original = c.durableSessionKv.get; let first = true;
  c.durableSessionKv.get = async keys => { if (first) { first = false; await held.promise; } return original(keys); };
  c.localState.config = { generation: 'old' };
  const read = c.getStoredAuthState(['config'], { startupReadRecovery: true });
  await flush(); c.managedAuthGatePolicyGeneration++; c.localState.config = { generation: 'current' };
  held.resolve(); assert.equal((await read).config.generation, 'current');
  assert.deepEqual(h.reads, ['local', 'session', 'local', 'session']);

  const stale = authSnapshotHarness(), blocked = deferred();
  stale.context.rawLocalKv.get = () => blocked.promise;
  const rejected = stale.context.getStoredAuthState(['studentToken'], { startupReadRecovery: true });
  await flush(); stale.context.studentAuthMutationGeneration++;
  blocked.resolve({ studentToken: 'private-obsolete-credential' });
  await assert.rejects(rejected, error => stale.context.authGateStartupAuthSnapshotSupersededFailures.has(error)
    && !stale.context.authGateStartupPublicationStorageFailures.has(error));
  assert.equal(stale.removes.length, 0); assert.equal(stale.cleanups.length, 0);
  assert.equal(stale.context.authGateStartupPublicationOwners.has('auth_snapshot'), false);
});

test('errors after the native prefix do not replay migration or masquerade as read failures', async () => {
  const h = authSnapshotHarness(), c = h.context;
  c.localState.studentToken = 'private-legacy-credential';
  const failure = new Error('fixture-migration-failed'); let removes = 0;
  c.rawLocalKv.remove = async () => { removes++; throw failure; };
  await assert.rejects(c.getStoredAuthState(['studentToken'], { startupReadRecovery: true }), error => error === failure);
  c.retryAuthGateStartupPublications({ userInitiated: true }); await h.advance(30000);
  // 2.9.4 bounds the purge: its completed failure is verified by one fresh
  // read (read-before-fail) before the wake fails; nothing is replayed.
  assert.equal(removes, 1); assert.equal(h.reads.length, 3); assert.equal(h.cleanups.length, 0);
  assert.equal(c.authGateStartupPublicationStorageFailures.has(failure), false);
});

// Execute the real native snapshot, wake supersession hook, managed-change
// producer, strict prerequisites and numeric publication owners together.
// Only Chrome storage and already-covered auth/ledger cleanup bodies are seams.
function managedWakeTransitionHarness({ startWake = true } = {}) {
  const h = durablePublicationHarness({ autoStart: false, failCount: 0 }), c = h.context;
  const initialRead = deferred(), clears = [], deliveries = [], policyWrites = [], notificationRuns = [];
  const baseRead = c.rawLocalKv.get, baseWrite = c.durableLocalKv.set;
  Object.assign(c, {
    initialReadCalls: 0, oldWakeContinued: 0, wakeFailures: [], retiredWakePolicies: 0,
    wakePolicyGeneration: 1, studentAuthInvalidating: false,
    MANAGED_CONFIG_KEYS: ['schoolId', 'schoolSlug', 'enrollmentKey', 'serverUrl', 'fastAuthGateEnabled'],
    MANAGED_AUTH_GATE_BINDING_KEY: 'managed-binding', SHARED_SIGN_IN_CONFIG_CACHE_KEY: 'config-cache',
    STUDENT_AUTH_INVALIDATING_KEY: 'invalidating', STUDENT_AUTH_COMMIT_PENDING_KEY: 'commit-pending',
    STUDENT_SESSION_RECOVERY_STORAGE_KEY: 'session-recovery', RESTRICTION_AUTH_ATTEMPT_STORAGE_KEY: 'auth-attempt',
    SESSION_SCOPED_STUDENT_STORAGE_KEYS: new Set(['studentToken']),
    legacyStudentAuthCleanupAuthority: null, legacyStudentAuthCleanupPromise: null,
    DEFAULT_SERVER_URL: 'https://fixture.invalid', managedAuthGateSetupUnavailable: false,
    authoritativeManagedSchoolPolicyScope: null,
    policyWriteGate: null, storedPolicyReadGate: null,
    ssoClearGate: null, attemptClearGate: null, fenceClearGate: null,
    normalizeManagedString: value => typeof value === 'string' ? value.trim() : '',
    extractManagedValue: value => value,
    persistedNonAuthConfig: value => ({ ...value }),
    applyManagedSchoolConfig(value) { if ('fastAuthGateEnabled' in value) c.fastAuthGateEnabled = value.fastAuthGateEnabled; },
    applyAuthoritativeManagedAuthGateSnapshot(value) {
      Object.assign(c.CONFIG, value); c.managedAuthGateSetupUnavailable = false;
      return { persistedDescriptor: { schoolId: value.schoolId } };
    },
    resetSharedSignInLoginConfigCache() { c.sharedSignInConfigGeneration++; },
    updateSharedSignInLoginConfig(value) { c.sharedSignInLoginConfig = value; },
    authGateConfigBindingKey: () => 'fixture-binding',
    async refreshSharedSignInLoginConfigLegacy() {},
    async clearRestrictionSsoVisitState() { if (c.ssoClearGate) await c.ssoClearGate.promise; },
    async clearRestrictionAuthAttemptState() { if (c.attemptClearGate) await c.attemptClearGate.promise; },
    async clearRestrictionAuthPolicyFenceState() { if (c.fenceClearGate) await c.fenceClearGate.promise; },
    clearStudentAuth() {
      c.studentAuthMutationGeneration++; c.studentAuthMutationPendingCount++; c.studentAuthInvalidating = true;
      const clear = deferred(); clears.push(clear);
      return clear.promise.then(() => {
        for (const key of ['studentToken', 'authContextId', 'activeStudentId', 'activeStudentSessionId', 'studentEmail', 'studentName']) c.CONFIG[key] = null;
      }).finally(() => { c.studentAuthMutationPendingCount--; });
    },
    rejectWakePolicyRestore() { c.retiredWakePolicies++; },
    markClassroomStateRestored() {},
  });
  c.rawLocalKv.get = async keys => {
    if (keys[0] === 'authContextId') { c.initialReadCalls++; return initialRead.promise; }
    return baseRead(keys);
  };
  c.durableSessionKv = { async get() { return {}; }, async remove() {} };
  c.chrome.storage.session = {};
  c.durableLocalKv.get = async () => {
    if (c.storedPolicyReadGate) await c.storedPolicyReadGate.promise;
    return { config: {}, 'managed-binding': {} };
  };
  c.durableLocalKv.set = async values => {
    if ('managed-binding' in values) {
      policyWrites.push(values);
      if (c.policyWriteGate) await c.policyWriteGate.promise;
      return;
    }
    return baseWrite(values);
  };
  for (const name of ['hasSessionStorage', 'readAuthGateStartupAuthSnapshot', 'getStoredAuthState',
    'advanceManagedAuthGatePolicyGeneration', 'startupManagedAuthorityTransitionIsCurrent',
    'assertStartupAuthorityIsSignedOut', 'startupPolicyFailureTolerated', 'assertStartupReadinessSignedOut',
    'computeStartupSignedOutClearPlan', 'beginStartupSignedOutClear', 'ensureStartupReadinessPublication',
    'nudgeStartupReadinessPublication', 'publishStartupReadinessWhenVerified',
    'notifyAuthGateAfterManagedPolicyRestore', 'handleManagedAuthGateStorageChange']) {
    vm.runInContext(functionSource(name), c);
  }
  const barrierStart = source.indexOf('let markAuthStateRestored;');
  const barrierEnd = source.indexOf('\n\n// Run immediately on service worker load/wake-up', barrierStart);
  vm.runInContext(`${source.slice(barrierStart, barrierEnd)}
    globalThis.fixtureAuthRestore = authStateRestorePromise;
    globalThis.notifyAuthGateStateToTabs = () => {
      const run = (async () => {
        await authStateRestorePromise;
        await awaitAuthGateRosterContextStable();
        deliveries.push('current-state');
      })();
      notificationRuns.push(run);
      return run;
    };`, Object.assign(c, { deliveries, notificationRuns }));
  const wakeStart = source.indexOf('  let authStored;', source.indexOf('// Run immediately on service worker load/wake-up'));
  const wakeEnd = source.indexOf('  const storedServerUrl =', wakeStart);
  assert.ok(wakeStart > 0 && wakeEnd > wakeStart);
  const finalPublication = source.match(/markClassroomStateRestored\(\);\n  if \(!authGateStartupComplete\) ensureStartupReadinessPublication\(\);/)[0];
  // The production wake failure path (2.9.4): a failed wake records its step
  // and retires its policy barrier before the coordinator owns readiness.
  if (startWake) vm.runInContext(`globalThis.fixtureWake = (async () => {
    ${source.slice(wakeStart, wakeEnd)}
    oldWakeContinued++;
  })().catch(error => { wakeFailures.push(error); failWorkerWake(error); }).finally(() => { settleWorkerWake(); ${finalPublication} });`, c);
  return {
    ...h, initialRead, clears, deliveries, policyWrites,
    change(changes = { schoolId: { newValue: 'fixture-current-school' } }) {
      return c.handleManagedAuthGateStorageChange(changes, 'managed');
    },
    acceptPolicy(index = h.managedCallbacks.length - 1) {
      h.managedCallbacks[index]({ schoolId: `fixture-policy-${index}`, enrollmentKey: 'fixture-current-key' });
    },
    resolveOldRead() { initialRead.resolve({ studentToken: 'private-obsolete-token' }); },
    async waitForNotifications() {
      assert.ok(notificationRuns.length > 0, 'the policy producer must request tab delivery');
      await Promise.all(notificationRuns);
    },
  };
}

// Exercise failed-wake recovery with the real policy phase and publication owners.
function failedWakeHarness(options = {}) {
  const h = managedWakeTransitionHarness(options), c = h.context;
  const barrier = deferred(); barrier.promise.catch(() => {});
  c.managedAuthGatePolicyRestorePromise = barrier.promise;
  c.workerWakePolicyBarrier = barrier.promise;
  c.workerWakePolicyGeneration = c.managedAuthGatePolicyGeneration;
  c.workerWakeAuthGeneration = c.studentAuthMutationGeneration;
  c.retireWorkerWakePolicyRestore = error => { barrier.reject(error); return true; };
  c.captureLegacyStudentAuthCleanupAuthority = () => false;
  c.dispatchLegacyStudentAuthCleanup = async () => true;
  c.safeDiagnosticError = error => error?.code === 'STORAGE_IO_ERROR' ? error.code : 'Error';
  return h;
}

async function completeFailedWakeRecovery(h) {
  h.clears.at(-1).resolve(); await h.settle();
  assert.ok(h.managedCallbacks.length > 0, 'recovery owns a fresh native managed read');
  h.acceptPolicy(); await h.settle();
  await h.context.fixtureAuthRestore;
}

test('completed legacy migration failure recovers without entering a second migration', async () => {
  const h = failedWakeHarness(), c = h.context;
  h.state.studentToken = 'private-legacy-credential';
  let purges = 0;
  c.rawLocalKv.remove = async () => {
    purges++;
    if (purges > 1) return new Promise(() => {});
    throw Object.assign(new Error('private-native-remove-rejected'), { code: 'STORAGE_IO_ERROR' });
  };
  h.resolveOldRead(); await h.settle();
  assert.equal(c.workerWakeAuthRestoreOutcome, 'failed');
  assert.equal(c.studentAuthInvalidating, true);
  assert.equal(h.clears.length, 1);
  assert.equal(h.managedCallbacks.length, 0, 'policy work waits for the strict clear');
  assert.equal(c.workerWakeFirstFailure.failureClass, 'STORAGE_IO_ERROR');
  assert.equal(c.workerWakeFirstFailure.startupPhase, 'legacy_auth_cleanup');
  await completeFailedWakeRecovery(h);
  assert.equal(c.authGateStartupComplete, true);
  assert.equal(purges, 1, 'policy recovery must never repeat getStoredAuthState migration');
  assert.equal(c.CONFIG.studentToken, null);
  assert.equal(c.oldWakeContinued, 0);
  assert.equal(h.policyWrites.length, 1);
});

function installActualAuthRestore(h, { missingContext = true, pending = false } = {}) {
  const c = h.context, held = deferred(), stored = {
    config: { serverUrl: 'https://fixture.invalid', schoolId: 'fixture-school' },
    deviceId: 'fixture-device', studentToken: 'private-token', activeStudentId: 'fixture-student',
    activeStudentSessionId: 'fixture-session', identitySource: 'manual_pin', manualLoginLastSeenAt: 1,
    ...(missingContext ? {} : { authContextId: 'auth_fixture' }),
  };
  Object.assign(c, {
    sharedAuthLockedSinceAt: 0, trackingState: 'off', TRACKING_STATES: { OFF: 'off' },
    generateAuthContextId: () => 'auth_uncommitted',
    setManualAuthState: () => pending ? held.promise : Promise.reject(new Error('fixture-write-rejected')),
    activateAuthenticatedContext() {}, captureAuthenticatedContext: () => ({ id: 'fixture' }),
    cleanupRetiredExactBoundStorage: () => pending ? held.promise : Promise.reject(new Error('fixture-cleanup-rejected')),
  });
  for (const name of ['restoreWorkerWakeAuthState', 'assertAuthMutationCurrent', 'hasStudentAuth']) {
    vm.runInContext(functionSource(name), c);
  }
  return { stored, held };
}

for (const missingContext of [true, false]) test(`failed partial auth adoption requires a strict clear (missing context: ${missingContext})`, async () => {
  const h = failedWakeHarness({ startWake: false }), c = h.context;
  const { stored } = installActualAuthRestore(h, { missingContext });
  c.workerWakeStep = 'auth_restore';
  await assert.rejects(c.restoreWorkerWakeAuthState(stored, 'https://fixture.invalid', 0, { persistConfig: false }), /fixture-/);
  assert.equal(c.hasStudentAuth(), true, 'the fixture must leave the actual partial-adoption condition');
  c.failWorkerWake(new Error('fixture-restoration-failed')); c.settleWorkerWake(); c.ensureStartupReadinessPublication();
  assert.equal(c.workerWakeFirstFailure.startupPhase, missingContext ? 'auth_context_persist' : 'retired_storage_cleanup');
  assert.equal(c.hasStudentAuth(), false, 'completed failure fences partial credentials synchronously');
  assert.equal(c.authGateStartupComplete, false);
  await completeFailedWakeRecovery(h);
  assert.equal(c.authGateStartupComplete, true);
  assert.equal(c.CONFIG.studentToken, null);
  assert.equal(c.CONFIG.authContextId, null);
  assert.equal(h.clears.length, 1);
});

test('a completed post-policy failure before readiness also requires fresh sign-in', async () => {
  const h = failedWakeHarness({ startWake: false }), c = h.context;
  c.workerWakeManagedPolicyApplied = true;
  c.workerWakeAuthRestoreOutcome = 'verified';
  c.workerWakeStep = 'monitoring_redaction';
  c.CONFIG.studentToken = 'private-restored-token';
  c.failWorkerWake(new Error('fixture-redaction-failed')); c.settleWorkerWake(); c.ensureStartupReadinessPublication();
  assert.equal(c.studentAuthInvalidating, true); assert.equal(h.clears.length, 1);
  await completeFailedWakeRecovery(h);
  assert.equal(c.CONFIG.studentToken, null); assert.equal(c.authGateStartupComplete, true);
});

for (const missingContext of [true, false]) test(`a composite auth operation remains owned beyond both deadlines (missing context: ${missingContext})`, async () => {
  const h = failedWakeHarness({ startWake: false }), c = h.context;
  const { stored, held } = installActualAuthRestore(h, { missingContext, pending: true });
  let settled = false;
  const restore = c.restoreWorkerWakeAuthState(stored, 'https://fixture.invalid', 0, { persistConfig: false });
  restore.then(() => { settled = true; }, () => { settled = true; });
  c.workerWakeStep = 'auth_restore'; c.armWorkerWakeWatchdog();
  await h.settle(); await h.advance(120000); await h.settle();
  assert.equal(settled, false); assert.equal(c.studentAuthMutationPendingCount, 1);
  assert.equal(c.workerWakeRetired, false); assert.equal(h.clears.length, 0);
  assert.equal(c.startupFailedWakeRecovery, null); assert.equal(c.authGateStartupComplete, false);
  assert.ok(h.diagnostics.some(item => item.cause === 'stalled'));
  held.resolve(); await restore;
  assert.equal(c.studentAuthMutationPendingCount, 0);
});

test('policy-only supersession prevents an old failed wake clearing the current authority', async () => {
  const h = failedWakeHarness({ startWake: false }), c = h.context;
  c.managedAuthGatePolicyGeneration++;
  c.managedAuthGatePolicyRestorePromise = Promise.resolve();
  c.failWorkerWake(new Error('fixture-obsolete-wake'));
  assert.equal(c.workerWakeAuthRestoreOutcome, 'superseded');
  assert.equal(c.startupFailedWakeRecovery, null); assert.equal(h.clears.length, 0);
});

test('failed recovery policy persistence retries its own phase without repeating cleanup', async () => {
  const h = failedWakeHarness({ startWake: false }), c = h.context;
  const write = c.durableLocalKv.set; let rejected = false;
  c.durableLocalKv.set = async values => {
    if ('managed-binding' in values && !rejected) { rejected = true; throw new Error('fixture-policy-write'); }
    return write(values);
  };
  c.failWorkerWake(new Error('fixture-wake')); c.settleWorkerWake(); c.ensureStartupReadinessPublication();
  h.clears[0].resolve(); await h.settle(); h.acceptPolicy(); await h.settle();
  assert.equal(c.authGateStartupComplete, false);
  const owner = c.authGateStartupPublicationOwners.get('failed_wake_policy');
  assert.equal(owner.failed, true);
  c.retryAuthGateStartupPublications({ userInitiated: true }); c.retryAuthGateStartupPublications({ userInitiated: true });
  await h.settle(); h.acceptPolicy(); await h.settle(); await c.fixtureAuthRestore;
  assert.equal(h.clears.length, 1); assert.equal(c.authGateStartupComplete, true);
  assert.equal(c.workerWakeFirstFailure.startupPhase, 'start');
});

test('failed-wake policy repair stays non-auth after onChanged supersession and repeated write failures', async () => {
  const h = failedWakeHarness({ startWake: false }), c = h.context;
  vm.runInContext(functionSource('runManagedAuthGatePolicyRevalidation'), c);
  let migrationEntries = 0, policyFailures = 2, ssoClears = 0;
  c.getStoredAuthState = () => { migrationEntries++; return new Promise(() => {}); };
  c.clearRestrictionSsoVisitState = async () => { ssoClears++; };
  const write = c.durableLocalKv.set;
  c.durableLocalKv.set = async values => {
    if ('managed-binding' in values && policyFailures-- > 0) throw new Error('fixture-policy-write');
    return write(values);
  };
  c.failWorkerWake(Object.assign(new Error('fixture-original-native-failure'), { code: 'STORAGE_IO_ERROR' }));
  c.settleWorkerWake(); c.ensureStartupReadinessPublication(); await h.settle();
  h.change({ fastAuthGateEnabled: { newValue: true } }); await h.settle();
  h.acceptPolicy(); h.clears[0].resolve(); await h.settle();
  assert.equal(c.managedAuthGateStartupAuthorityTransition.policyRecoveryRequired, true);
  for (let attempt = 0; attempt < 2; attempt++) {
    c.retryAuthGateStartupPublications({ userInitiated: true }); await h.settle();
    h.acceptPolicy(); await h.settle();
    assert.equal(migrationEntries, 0, 'startup repair must never invoke credential migration');
    assert.equal(h.clears.length, 1, 'verified strict auth clear must not be repeated');
    assert.equal(ssoClears, 1, 'policy persistence retry must retain completed cleanup proof');
  }
  await c.fixtureAuthRestore;
  assert.equal(c.authGateStartupComplete, true);
  assert.equal(c.managedAuthGateDirectRevalidationInFlight, null);
  assert.equal(c.workerWakeFirstFailure.failureClass, 'STORAGE_IO_ERROR');
});

test('a rejected managed prerequisite cannot bypass a sibling cleanup still running after failed wake', async () => {
  const h = failedWakeHarness({ startWake: false }), c = h.context, held = deferred();
  let attempts = 0;
  c.clearRestrictionSsoVisitState = async () => {
    if (++attempts === 1) throw new Error('fixture-first-ledger-clear');
  };
  c.clearRestrictionAuthAttemptState = () => held.promise;
  c.failWorkerWake(new Error('fixture-wake')); c.settleWorkerWake(); c.ensureStartupReadinessPublication();
  await h.settle(); h.change({ fastAuthGateEnabled: { newValue: true } }); await h.settle();
  h.acceptPolicy(); h.clears[0].resolve(); await h.settle();
  await h.advance(30000); c.retryAuthGateStartupPublications({ userInitiated: true }); await h.settle();
  assert.equal(c.authGateStartupComplete, false);
  assert.equal(h.policyWrites.length, 0);
  assert.equal(attempts, 1, 'no cleanup replay while a sibling still owns child work');
  held.resolve(); await h.settle();
  c.retryAuthGateStartupPublications({ userInitiated: true }); await h.settle();
  h.acceptPolicy(); await h.settle(); await c.fixtureAuthRestore;
  assert.equal(attempts, 2);
  assert.equal(c.authGateStartupComplete, true);
});

test('a retried authority clear retains its generation proof for failed-wake policy repair', async () => {
  const h = failedWakeHarness({ startWake: false }), c = h.context;
  const write = c.durableLocalKv.set; let rejectPolicy = true;
  c.durableLocalKv.set = async values => {
    if ('managed-binding' in values && rejectPolicy) {
      rejectPolicy = false; throw new Error('fixture-policy-write');
    }
    return write(values);
  };
  c.failWorkerWake(new Error('fixture-wake')); c.settleWorkerWake(); c.ensureStartupReadinessPublication();
  await h.settle(); h.change(); await h.settle(); h.acceptPolicy();
  h.clears[0].resolve(); h.clears[1].reject(new Error('fixture-authority-clear')); await h.settle();
  c.retryAuthGateStartupPublications({ userInitiated: true }); await h.settle();
  h.clears[2].resolve(); await h.settle();
  assert.equal(c.managedAuthGateStartupAuthorityTransition.authGeneration, c.studentAuthMutationGeneration);
  c.retryAuthGateStartupPublications({ userInitiated: true }); await h.settle();
  h.acceptPolicy(); await h.settle(); await c.fixtureAuthRestore;
  assert.equal(c.authGateStartupComplete, true);
  assert.equal(h.clears.length, 3);
});

test('a rejected authority clear cannot rebase its retry onto newer authentication', async () => {
  const h = managedWakeTransitionHarness({ startWake: false }), c = h.context;
  h.change(); await h.settle(); h.acceptPolicy();
  h.clears[0].reject(new Error('fixture-old-authority-clear')); await h.settle();
  c.studentAuthMutationGeneration++;
  c.CONFIG.studentToken = 'private-newer-credential';
  const newerGeneration = c.studentAuthMutationGeneration;
  c.retryAuthGateStartupPublications({ userInitiated: true }); await h.settle();
  assert.equal(h.clears.length, 1, 'the stale clear must not reserve a replacement auth mutation');
  assert.equal(c.studentAuthMutationGeneration, newerGeneration);
  assert.equal(c.CONFIG.studentToken, 'private-newer-credential');
  assert.equal(c.authGateStartupComplete, false, 'the obsolete clear is not readiness proof');
});

test('a policy-only transition must complete its inherited rejected failed-wake clear', async () => {
  const h = failedWakeHarness({ startWake: false }), c = h.context;
  c.failWorkerWake(new Error('fixture-wake')); c.settleWorkerWake(); c.ensureStartupReadinessPublication();
  await h.settle();
  h.change({ fastAuthGateEnabled: { newValue: true } }); await h.settle(); h.acceptPolicy();
  h.clears[0].reject(new Error('fixture-first-strict-clear')); await h.settle();
  c.retryAuthGateStartupPublications({ userInitiated: true }); await h.settle();
  assert.equal(h.clears.length, 2, 'the exact inherited strict clear must retry rather than retire as a no-op');
  assert.equal(c.authGateStartupComplete, false);
  assert.equal(c.managedAuthGateStartupAuthorityTransition.authGeneration, c.studentAuthMutationGeneration);
  h.clears[1].resolve(); await h.settle(); await c.fixtureAuthRestore;
  assert.equal(c.authGateStartupComplete, true);
  assert.equal(h.policyWrites.length, 1);
});

test('a late obsolete recovery policy callback cannot publish over a newer managed transition', async () => {
  const h = failedWakeHarness({ startWake: false }), c = h.context, callback = deferred();
  let firstWrite = true;
  c.durableLocalKv.set = async values => {
    if (!('managed-binding' in values)) { Object.assign(h.state, values); return; }
    h.policyWrites.push(values);
    // Model a landed native write with a delayed callback, then a newer write.
    Object.assign(h.state, values);
    if (firstWrite) { firstWrite = false; await callback.promise; }
  };
  c.failWorkerWake(new Error('fixture-wake')); c.settleWorkerWake(); c.ensureStartupReadinessPublication();
  h.clears[0].resolve(); await h.settle(); h.acceptPolicy(); await h.settle();
  const obsolete = c.startupFailedWakeRecovery;
  h.change({ fastAuthGateEnabled: { newValue: true } }); await h.settle(); h.acceptPolicy(); await h.settle();
  await h.advance(31000); await h.settle(); await c.fixtureAuthRestore;
  assert.equal(obsolete.phase, 'superseded');
  assert.equal(c.CONFIG.schoolId, 'fixture-policy-1');
  assert.equal(h.state['managed-binding'].schoolId, 'fixture-policy-1');
  callback.resolve(); await h.settle();
  assert.equal(c.CONFIG.schoolId, 'fixture-policy-1');
  assert.equal(h.state['managed-binding'].schoolId, 'fixture-policy-1');
  assert.equal(c.authGateStartupComplete, true);
  assert.equal(h.policyWrites.length, 2);
});

test('page-initiated managed revalidation joins failed-startup recovery before normal policy proof', async () => {
  const h = failedWakeHarness({ startWake: false }), c = h.context;
  vm.runInContext(functionSource('revalidateManagedAuthGatePolicy'), c);
  let directRuns = 0, replied = false;
  c.runManagedAuthGatePolicyRevalidation = async () => {
    directRuns++;
    return { state: { phase: 'ready', authRequired: true }, managedPolicyGeneration: 99 };
  };
  c.failWorkerWake(new Error('fixture-wake')); c.settleWorkerWake(); c.ensureStartupReadinessPublication();
  const request = c.revalidateManagedAuthGatePolicy(7, { userInitiated: true });
  request.then(() => { replied = true; });
  await h.advance(31000); await h.settle();
  assert.equal(directRuns, 0, 'the page RPC cannot enter generic credential-bearing revalidation during startup');
  assert.equal(replied, false);
  await completeFailedWakeRecovery(h);
  const response = await request;
  assert.equal(directRuns, 1, 'normal post-startup policy proof remains fresh');
  assert.equal(response.managedPolicyFence, 7);
});

test('a newer policy owns recovery while an older strict clear still retains its queue work', async () => {
  const h = failedWakeHarness({ startWake: false }), c = h.context;
  c.failWorkerWake(new Error('fixture-wake')); c.settleWorkerWake(); c.ensureStartupReadinessPublication();
  await h.settle();
  const obsolete = c.startupFailedWakeRecovery;
  const change = h.change(); await h.settle(); h.acceptPolicy();
  assert.equal(h.clears.length, 2);
  h.clears[1].resolve(); await h.settle();
  assert.equal(c.authGateStartupComplete, false, 'pending old child work is not cancelled by policy supersession');
  h.clears[0].resolve(); await h.settle();
  c.retryAuthGateStartupPublications({ userInitiated: true }); await h.settle();
  await change; await c.fixtureAuthRestore;
  assert.equal(obsolete.phase, 'superseded');
  assert.equal(c.CONFIG.schoolId, 'fixture-policy-0');
  assert.equal(h.policyWrites.length, 1, 'the obsolete recovery may not persist its own policy');
});

test('persistent recovery policy failure stays protected and retries never repeat the clear', async () => {
  const h = failedWakeHarness({ startWake: false }), c = h.context;
  c.failWorkerWake(new Error('fixture-wake')); c.settleWorkerWake(); c.ensureStartupReadinessPublication();
  h.clears[0].resolve(); await h.settle();
  for (let attempt = 0; attempt < 5; attempt++) {
    c.chrome.runtime.testError = { message: 'fixture-private-native-failure' };
    h.acceptPolicy(); delete c.chrome.runtime.testError; await h.settle();
    assert.equal(c.authGateStartupComplete, false);
    assert.equal(h.clears.length, 1);
    const count = h.managedCallbacks.length;
    for (let i = 0; i < 5; i++) c.retryAuthGateStartupPublications();
    await h.settle(); assert.equal(h.managedCallbacks.length, count);
    c.retryAuthGateStartupPublications({ userInitiated: true });
    c.retryAuthGateStartupPublications({ userInitiated: true }); await h.settle();
    assert.equal(h.managedCallbacks.length, count + 1);
  }
  h.acceptPolicy(); await h.settle(); await c.fixtureAuthRestore;
  assert.equal(c.authGateStartupComplete, true); assert.equal(h.clears.length, 1);
});

test('support details are synchronous and preserve the first failure while cleanup is pending', async () => {
  const h = failedWakeHarness({ startWake: false }), c = h.context;
  c.chrome.runtime.getManifest = () => ({ version: '2.9.4' });
  vm.runInContext(readFileSync(new URL('../extension/auth-recovery-diagnostics.js', import.meta.url), 'utf8'), c);
  c.workerWakeStep = 'auth_restore';
  c.failWorkerWake(Object.assign(new Error('private token student school'), { code: 'STORAGE_IO_ERROR' }));
  c.settleWorkerWake(); c.ensureStartupReadinessPublication(); await h.settle();
  await h.advance(9000);
  const reply = c.authGateRecoveryFailurePayload(c.authGateRecoveryError('AUTH_GATE_STARTUP_TIMEOUT'));
  assert.equal(reply.supportDetails.startupPhase, 'recovery_clear');
  assert.equal(reply.supportDetails.failureClass, 'STORAGE_IO_ERROR');
  assert.equal(reply.supportDetails.pending, true);
  assert.equal(reply.supportDetails.firstFailure.startupPhase, 'auth_restore');
  assert.equal(reply.supportDetails.firstFailure.failureClass, 'STORAGE_IO_ERROR');
  assert.equal(JSON.stringify(reply).includes('private'), false);
  assert.equal(c.authGateStartupComplete, false);
  await completeFailedWakeRecovery(h);
});

test('recovered startup details cannot reappear in later RPC or server failures', async () => {
  const h = failedWakeHarness({ startWake: false }), c = h.context;
  c.chrome.runtime.getManifest = () => ({ version: '2.9.4' });
  c.DIAGNOSTIC_CODE_ALLOWLIST = new Set(['STORAGE_IO_ERROR', 'AUTH_GATE_RPC_TIMEOUT', 'AUTH_GATE_SERVER_TIMEOUT']);
  c.SENTRY_EXCEPTION_TYPE_ALLOWLIST = new Set(['Error']);
  vm.runInContext(functionSource('safeDiagnosticError'), c);
  vm.runInContext(readFileSync(new URL('../extension/auth-recovery-diagnostics.js', import.meta.url), 'utf8'), c);
  c.workerWakeStep = 'auth_context_persist';
  c.failWorkerWake(Object.assign(new Error('fixture-original-storage-failure'), { code: 'STORAGE_IO_ERROR' }));
  c.settleWorkerWake(); c.ensureStartupReadinessPublication(); await h.settle();
  await completeFailedWakeRecovery(h);
  assert.equal(c.authGateStartupComplete, true);

  const replies = [];
  c.createAuthGateResponseDeadline(value => replies.push(value));
  await h.advance(9000);
  const serverReply = c.createAuthGateResponseDeadline(value => replies.push(value));
  serverReply.fail(c.authGateRecoveryError('AUTH_GATE_SERVER_TIMEOUT'));
  assert.equal(replies.length, 2);
  for (const [index, code] of ['AUTH_GATE_RPC_TIMEOUT', 'AUTH_GATE_SERVER_TIMEOUT'].entries()) {
    const response = replies[index], details = response.supportDetails;
    assert.equal(response.errorCode, code);
    assert.equal(details.failureClass, code, 'support must identify the current failure');
    assert.equal(details.extensionVersion, '2.9.4');
    assert.equal(details.timestamp, 9000);
    assert.equal(details.startupPhase, 'unknown');
    for (const key of ['firstFailure', 'elapsedMs', 'restoreOutcome', 'attemptCount', 'retryInMs', 'pending']) {
      assert.equal(Object.hasOwn(details, key), false, `completed startup must not leak stale ${key}`);
    }
  }
});

test('a startup legacy credential purge that never reports back is reconciled at the deadline instead of parking the wake', async () => {
  const h = authSnapshotHarness(), c = h.context;
  c.localState.studentToken = 'private-legacy-credential';
  c.authGateStartupComplete = false;
  c.rawLocalKv.remove = () => new Promise(() => {});
  let startup = null;
  const drain = async () => { for (let i = 0; i < 5; i++) { await new Promise((done) => setImmediate(done)); await flush(); } };
  c.getStoredAuthState(['studentToken'], { startupReadRecovery: true }).then(() => { startup = 'resolved'; }, (error) => { startup = error; });
  await drain(); await h.advance(8999); assert.equal(startup, null);
  await h.advance(1); await flush();
  assert.equal(startup?.code, 'AUTH_GATE_UNAVAILABLE', 'the bounded purge fails the wake instead of parking it');
  assert.ok(h.diagnostics.some((entry) => entry.stage === 'startup' && entry.cause === 'stalled'));
  assert.equal(h.cleanups.length, 0);
  // A routine (non-startup) read keeps the plain native call.
  let routine = null;
  c.getStoredAuthState(['studentToken']).then(() => { routine = 'resolved'; }, (error) => { routine = error; });
  await h.advance(20000); await flush();
  assert.equal(routine, null);
});

test('actual wake retires an obsolete native auth read and opens only current signed-out durable state', { timeout: 10000 }, async () => {
  const h = managedWakeTransitionHarness(), c = h.context;
  const digestStarted = deferred(), digestReleased = deferred(), originalCrypto = c.crypto;
  c.crypto = { subtle: { digest: async (...args) => {
    digestStarted.resolve();
    await digestReleased.promise;
    return originalCrypto.subtle.digest(...args);
  } } };
  await h.settle(); h.change(); h.acceptPolicy(); h.resolveOldRead(); await h.settle();
  assert.equal(c.authGateStartupComplete, false); assert.equal(c.authGateRosterContextReady, false);
  assert.equal(c.retiredWakePolicies, 1); assert.equal(h.clears.length, 1);
  h.clears[0].resolve(); await digestStarted.promise;
  assert.equal(c.authGateStartupComplete, false); assert.equal(c.authGateRosterContextReady, false);
  assert.equal(h.deliveries.length, 0, 'tab delivery must stay behind the durable roster publication');
  digestReleased.resolve(); await c.fixtureWake; await c.fixtureAuthRestore;
  assert.equal(c.authGateStartupComplete, true); assert.equal(c.authGateRosterContextReady, true);
  assert.equal(c.authGateRevisionReady, true); assert.equal(c.studentAuthInvalidating, true);
  assert.equal(c.oldWakeContinued, 0); assert.equal(c.CONFIG.studentToken, null);
  assert.equal(c.initialReadCalls, 1); assert.equal(c.wakeFailures.length, 0);
  assert.equal(c.authGateStartupPublicationOwners.has('auth_snapshot'), false);
  assert.equal(c.managedAuthGateStartupAuthorityTransition, null);
  // Startup intentionally does not await tab delivery: doing so would cycle
  // back through its own auth barrier. Await the actual requested deliveries,
  // not an assumed number of event-loop turns after native crypto completes.
  await h.waitForNotifications();
  assert.ok(h.deliveries.length > 0, 'notifications must resume after startup without cycling');
});

for (const outcome of ['held', 'rejected']) {
  test(`exact authority clear ${outcome} cannot be hidden by policy success or generic wake finally`, async () => {
    const h = managedWakeTransitionHarness(), c = h.context;
    await h.settle(); h.change(); h.acceptPolicy(); h.resolveOldRead();
    await c.initializeAuthGateRevisionPublication();
    if (outcome === 'rejected') h.clears[0].reject(new Error('fixture-clear-failure'));
    for (let i = 0; i < 5; i++) c.retryAuthGateStartupPublications({ userInitiated: true });
    await h.advance(45000); await h.settle();
    assert.equal(c.authGateStartupComplete, false); assert.equal(c.authGateRosterContextReady, false);
    assert.equal(c.studentAuthInvalidating, true); assert.equal(c.oldWakeContinued, 0);
    assert.equal(h.clears.length, 1);
    // The wake itself never fails on the clear; readiness is what stays closed.
    // The strict clear is its own tracked owner: rejected, it is the completed,
    // retryable failure that Retry replays, while readiness keeps waiting on it.
    assert.equal(c.wakeFailures.length, 0);
    const readiness = c.authGateStartupPublicationOwners.get('startup_readiness');
    const clearOwner = c.authGateStartupPublicationOwners.get('signed_out_clear');
    assert.ok(readiness, 'readiness must be owned by the coordinator');
    assert.ok(clearOwner, 'the transition clear must be a tracked startup owner');
    assert.ok(readiness.inFlight, 'readiness waits on the strict clear rather than failing on it');
    if (outcome === 'rejected') { assert.equal(clearOwner.failed, true); assert.equal(clearOwner.inFlight, null); assert.ok(clearOwner.retryAt > 0); }
    else { assert.ok(clearOwner.inFlight); h.clears[0].resolve(); await h.settle(); await c.fixtureWake; }
  });
}

test('a second managed authority transition invalidates the first clear and publication proof', async () => {
  const h = managedWakeTransitionHarness(), c = h.context;
  await h.settle(); h.change(); h.acceptPolicy(); h.resolveOldRead(); await h.settle();
  h.change({ schoolId: { newValue: 'fixture-second-school' } }); h.acceptPolicy();
  h.clears[0].resolve(); await h.settle();
  assert.equal(c.authGateStartupComplete, false); assert.equal(c.authGateRosterContextReady, false);
  h.clears[1].resolve(); await h.settle(); await c.fixtureWake; await c.fixtureAuthRestore;
  assert.equal(c.authGateStartupComplete, true); assert.equal(c.CONFIG.schoolId, 'fixture-policy-1');
  assert.equal(c.oldWakeContinued, 0); assert.equal(c.wakeFailures.length, 0);
  assert.equal(h.policyWrites.length, 1, 'superseded transition must not persist its old binding');
});

test('a settled native managed-read timeout permits only unavailable startup after strict cleanup succeeds', async () => {
  const h = managedWakeTransitionHarness(), c = h.context;
  await h.settle(); const transition = h.change(); h.resolveOldRead();
  h.clears[0].resolve(); await h.advance(3000); await h.settle(); await c.fixtureWake; await c.fixtureAuthRestore;
  assert.equal(c.authGateStartupComplete, true); assert.equal(c.studentAuthInvalidating, true);
  assert.equal(c.managedAuthGatePolicyFailure.code, 'AUTH_GATE_POLICY_TIMEOUT');
  assert.equal(c.managedAuthGatePolicyFailure.generation, transition.policyGeneration);
  assert.equal(h.policyWrites.length, 0); assert.equal(c.oldWakeContinued, 0);
  assert.equal(c.CONFIG.schoolId, null); assert.equal(c.wakeFailures.length, 0);
  // Actual shared recovery can now run beyond its auth-startup barrier. The
  // direct policy worker is a seam here; its durable paths have their own tests.
  let retries = 0;
  c.runManagedAuthGatePolicyRevalidation = async () => { retries++; return { state: { phase: 'ready', authRequired: true } }; };
  const recovered = await c.sharedManagedAuthGatePolicyRevalidation({ userInitiated: true });
  assert.equal(retries, 1); assert.equal(recovered.state.authRequired, true);
});

for (const dependency of ['storedPolicyReadGate', 'ssoClearGate', 'attemptClearGate', 'fenceClearGate']) {
  test(`managed-read timeout cannot hide a pending or rejected ${dependency}`, async () => {
    for (const outcome of ['held', 'rejected']) {
      const h = managedWakeTransitionHarness(), c = h.context, gate = deferred();
      await h.settle(); c[dependency] = gate; h.change(); h.resolveOldRead(); h.clears[0].resolve();
      await h.advance(3000); await h.settle();
      assert.equal(c.authGateStartupComplete, false); assert.equal(c.authGateRosterContextReady, false);
      if (outcome === 'rejected') gate.reject(new Error('fixture-prerequisite-failed'));
      else gate.resolve();
      await h.settle(); await c.fixtureWake;
      if (outcome === 'held') await c.fixtureAuthRestore;
      assert.equal(c.authGateStartupComplete, outcome === 'held');
      assert.equal(c.wakeFailures.length, 0);
      if (outcome === 'rejected') assert.equal(c.authGateStartupPublicationOwners.get('startup_readiness').failed, true);
      assert.equal(c.oldWakeContinued, 0);
    }
  });
}

test('pending or same-code rejected policy writes never qualify as native read timeouts', async () => {
  const h = managedWakeTransitionHarness(), c = h.context, write = deferred();
  await h.settle(); c.policyWriteGate = write; h.change(); h.acceptPolicy(); h.resolveOldRead(); h.clears[0].resolve();
  await h.settle(); await h.advance(30000);
  assert.equal(h.policyWrites.length, 1); assert.equal(c.authGateStartupComplete, false);
  assert.equal(c.authGateRosterContextReady, false);
  write.reject(c.authGateRecoveryError('AUTH_GATE_POLICY_TIMEOUT'));
  await h.settle(); await c.fixtureWake;
  assert.equal(c.authGateStartupComplete, false); assert.equal(c.wakeFailures.length, 0);
  assert.equal(c.authGateStartupPublicationOwners.get('startup_readiness').failed, true);
});

test('policy-only change completes its strict barrier without waiting for startup or clearing auth', { timeout: 10000 }, async () => {
  const h = managedWakeTransitionHarness(), c = h.context;
  await h.settle();
  const change = h.change({ fastAuthGateEnabled: { newValue: true } });
  h.acceptPolicy(); await h.settle(); await change.policyRestorePromise;
  assert.equal(c.authGateStartupComplete, false); assert.equal(h.clears.length, 0);
  assert.equal(h.policyWrites.length, 1); assert.equal(h.deliveries.length, 0);
  h.initialRead.resolve({ config: {} }); await h.settle(); await c.fixtureWake;
  assert.equal(c.oldWakeContinued, 1, 'only the original wake continuation proceeds');
  assert.equal(c.retiredWakePolicies, 0); assert.equal(c.initialReadCalls, 2, 'policy change discards the first native snapshot');
  assert.equal(h.diagnostics.some(entry => entry.cause === 'superseded_joined'), false, 'a policy-only change does not retire the wake');
  await c.initializeAuthGateRevisionPublication();
  await c.initializeAuthGateRosterContextPublication(undefined, { readFresh: true });
  vm.runInContext('markAuthStateRestored();', c); await h.waitForNotifications();
  assert.ok(h.deliveries.length > 0);
  const delivery = deferred(); c.notifyAuthGateStateToTabs = () => delivery.promise;
  let finished = false;
  const notification = c.notifyAuthGateAfterManagedPolicyRestore().then(() => { finished = true; });
  await flush(); assert.equal(finished, false, 'post-startup delivery awaiting is preserved');
  delivery.resolve(); await notification;
});

test('signed-out startup continuation rejects credential material and every pending mutation fence', async () => {
  const h = managedWakeTransitionHarness(), c = h.context;
  await h.settle(); h.change();
  const transition = c.managedAuthGateStartupAuthorityTransition;
  c.studentAuthMutationPendingCount = 0;
  for (const field of ['studentToken', 'authContextId', 'activeStudentId', 'activeStudentSessionId', 'studentEmail', 'studentName']) {
    c.CONFIG[field] = 'private-fixture';
    assert.throws(() => c.assertStartupAuthorityIsSignedOut(transition), error => error.code === 'AUTH_MUTATION_SUPERSEDED');
    c.CONFIG[field] = null;
  }
  for (const field of ['studentAuthCommitPending', 'studentAuthCommitPendingGeneration', 'studentAuthMutationPendingCount',
    'manualStudentLoginRequestsPending', 'manualStudentLoginPendingGeneration']) {
    c[field] = 1;
    assert.throws(() => c.assertStartupAuthorityIsSignedOut(transition), error => error.code === 'AUTH_MUTATION_SUPERSEDED');
    c[field] = 0;
  }
  assert.equal(c.studentAuthInvalidating, true);
  assert.doesNotThrow(() => c.assertStartupAuthorityIsSignedOut(transition));
  // Complete the controlled pending work without releasing a fabricated auth
  // snapshot; this test only exercises the actual signed-out publication guard.
  c.studentAuthMutationPendingCount = 1; h.acceptPolicy(); h.resolveOldRead(); h.clears[0].resolve();
  await h.settle(); await c.fixtureWake;
});
