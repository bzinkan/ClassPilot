import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import vm from 'node:vm';

const source = readFileSync(process.env.CLASSPILOT_EXTENSION_PATH
  ? join(process.env.CLASSPILOT_EXTENSION_PATH, 'service-worker.js')
  : new URL('../extension/service-worker.js', import.meta.url), 'utf8');
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
  'sharedManagedAuthGatePolicyRevalidation', 'awaitManagedAuthGatePolicyStable',
  'readManagedConfigOnce', 'readManagedConfig', 'enqueueStudentAuthMutation', 'authMutationSuperseded',
  'assertManagedPolicyRevalidationCurrent',
];
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const deferred = () => { let resolve, reject; const promise = new Promise((a,b) => { resolve=a; reject=b; }); return {promise,resolve,reject}; };
function harness() {
  let now = 0, serial = 0, lastErrorReads = 0;
  const timers = new Map(), managedCallbacks = [], alarms = [], diagnostics = [];
  const runtime = { onMessage: { addListener(handler) { context.handler = handler; } } };
  Object.defineProperty(runtime, 'lastError', { get() { lastErrorReads++; return runtime.testError; } });
  const context = vm.createContext({
    console: { warn() {}, log() {} }, AbortController,
    Date: class extends Date { static now() { return now; } },
    setTimeout(fn, delay) { const id=++serial; timers.set(id,{fn,at:now+delay}); return id; },
    clearTimeout(id) { timers.delete(id); },
    chrome: { runtime, storage: { managed: { get(keys, callback) { managedCallbacks.push(callback); } } },
      alarms: { create(name, options) { alarms.push({name,...options}); }, clear() {} } },
    ClassPilotAuthRecoveryDiagnostics: { record(value) { diagnostics.push(value); } },
    AUTH_GATE_POLICY_READ_TIMEOUT_MS: 3000, AUTH_GATE_RPC_RESPONSE_TIMEOUT_MS: 9000, AUTH_GATE_REQUEST_TIMEOUT_MS: 5000,
    AUTH_GATE_POLICY_RECOVERY_ALARM: 'auth-gate-policy-recovery',
    SHARED_SIGN_IN_CONFIG_RETRY_DELAYS_MS: [2000,5000,15000,30000], MANAGED_CONFIG_KEYS: ['schoolId'],
    managedAuthGatePolicyGeneration: 1, managedAuthGatePolicyFailure: null,
    managedAuthGatePolicyRecoveryAttempt: 0, managedAuthGatePolicyUserRetryAt: null,
    managedAuthGateDirectRevalidationInFlight: null, authStateRestorePromise: Promise.resolve(),
    managedConfigReadGeneration:-1,managedConfigReadPromise:null,
    managedAuthGatePolicyRestorePromise: Promise.resolve(), authGateStartupComplete: true,
    studentAuthMutationPendingCount: 0, studentAuthMutationTail: Promise.resolve(),
    safeDiagnosticError: () => ({name:'Error'}),
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
  const finalPublication=source.match(/if \(authGateRevisionReady\) markAuthStateRestored\(\);/g);
  assert.equal(finalPublication?.length,1,'production final publication must be unique');
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
  h.cleanup.resolve();await h.context.fixtureStartup;await flush();
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
