import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';

const root = process.env.CLASSPILOT_EXTENSION_PATH || fileURLToPath(new URL('../extension/', import.meta.url));
const source = readFileSync(resolve(root, 'service-worker.js'), 'utf8');
const names = ['reloadAuthIsSettled', 'legacyUpdateIsCurrent', 'authorizePageRecoveryReload', 'pageRecoveryAuthorizationIsCurrent'];
function fixture() {
  let revalidations = 0;
  const context = vm.createContext({
    URL, Date, CONFIG: {}, authGateStartupComplete: true, hasStudentAuth: () => false,
    studentAuthInvalidating: false, studentAuthCommitPending: false,
    studentAuthMutationPendingCount: 0, manualStudentLoginRequestsPending: 0,
    manualStudentLoginPendingGeneration: 0, chromeProfileRegistrationInFlight: null,
    resolveAuthCommitRecovery: null, rejectAuthCommitRecovery: null,
    managedAuthGateDirectRevalidationInFlight: null, managedAuthGatePolicyFailure: null,
    authGateRevisionReady: true, authGateRosterContextReady: true,
    authStateRestorePromise: Promise.resolve(), studentAuthMutationGeneration: 2,
    managedAuthGatePolicyGeneration: 3, authGateConfigBindingKey: () => 'current-binding',
    PAGE_RECOVERY_VERSION: '2.8.7', pendingLegacyGateUpdate: { version: '2.8.7', previousVersion: '2.8.6', expiresAt: Date.now() + 60000 },
    sharedManagedAuthGatePolicyRevalidation: async () => { revalidations++; },
    awaitManagedAuthGatePolicyStable: async () => {}, isKioskGateUrl: () => false,
    chrome: { tabs: { get: async () => ({ url: 'https://fixture.invalid/lesson' }) } },
    getPublishableAuthGateState: async () => ({ authRequired: true }),
  });
  for (const name of names) {
    const match = new RegExp(`^(?:async )?function ${name}\\([^]*?\\n\\}`, 'm').exec(source);
    assert.ok(match, name);
    vm.runInContext(match[0], context);
  }
  return { context, get revalidations() { return revalidations; },
    authorize: () => context.authorizePageRecoveryReload({ tabId: 1, documentId: 'captured-document', reason: 'legacy_update' }) };
}

test('reload authorization never begins policy invalidation while authentication work is unresolved', async () => {
  const blocked = {
    authGateStartupComplete: false, studentAuthInvalidating: true, studentAuthCommitPending: true,
    studentAuthMutationPendingCount: 1, manualStudentLoginRequestsPending: 1,
    manualStudentLoginPendingGeneration: 1, chromeProfileRegistrationInFlight: Promise.resolve(),
    resolveAuthCommitRecovery: () => {}, rejectAuthCommitRecovery: () => {},
    managedAuthGateDirectRevalidationInFlight: Promise.resolve(), managedAuthGatePolicyFailure: {},
    authGateRevisionReady: false, authGateRosterContextReady: false,
  };
  for (const [key, value] of Object.entries(blocked)) {
    const f = fixture(); f.context[key] = value;
    assert.equal(await f.authorize(), null, key);
    assert.equal(f.revalidations, 0, `${key} must not trigger policy cleanup`);
  }
});

const flush = () => new Promise(resolve => setImmediate(resolve));
function recoveryFixture({ restored = null, result = { status: 'manual_reload_required', reason: 'page_unavailable' } } = {}) {
  let now = 1000000, timerId = 0, ensureCalls = 0, writes = 0, removals = 0;
  let outcome = result;
  const timers = new Map(), scheduled = [];
  const context = fixture().context;
  context.Date = class extends Date { static now() { return now; } };
  context.setTimeout = (callback, delay) => { const id = ++timerId; timers.set(id, { callback, delay }); scheduled.push(delay); return id; };
  context.clearTimeout = id => timers.delete(id);
  context.ClassPilotAuthRecoveryDiagnostics = { record() {} };
  context.ClassPilotContentInjection = { create: () => ({ ensure: async () => { ensureCalls++; return typeof outcome === 'function' ? outcome() : outcome; } }) };
  context.chrome = { runtime: { getManifest: () => ({ version: '2.8.7' }) },
    tabs: { query: async () => [{ id: 1, url: 'https://fixture.invalid/lesson' }] },
    storage: { session: { get: async () => ({ classpilotLegacyGateUpdateV1: restored }),
      set: async () => { writes++; }, remove: async () => { removals++; } } } };
  // Use the complete production section, including restoration and timer/sweep state.
  const section = source.slice(source.indexOf('const PAGE_RECOVERY_FILES ='), source.indexOf('async function ensureContentScriptInjected'));
  vm.runInContext(section + '\n;globalThis.recoverySnapshot = () => ({ pending: !!pendingLegacyGateUpdate, sweep: !!legacyGateRecoverySweep, timer: legacyGateRecoveryRetryTimer !== null, attempts: legacyGateRecoveryRetryAttempt });', context);
  return { context, timers, scheduled,
    get ensureCalls() { return ensureCalls; }, get writes() { return writes; }, get removals() { return removals; },
    setOutcome: value => { outcome = value; },
    remember: details => context.rememberLegacyGateUpdate(details),
    async nextTimer() {
      assert.equal(timers.size, 1, 'there must be exactly one scheduled retry');
      const [id, timer] = [...timers.entries()][0]; timers.delete(id); now += timer.delay;
      timer.callback(); await flush();
    },
  };
}

test('automatic intent requires an actual update from 2.8.6; manual gate authorization is unchanged', async () => {
  const f = recoveryFixture(); await flush();
  for (const details of [{ reason: 'install' }, { reason: 'update' }, { reason: 'update', previousVersion: '2.8.5' }, { reason: 'update', previousVersion: '2.8.7' }]) f.remember(details);
  await flush(); assert.equal(f.writes, 0); assert.equal(f.ensureCalls, 0);
  const noPreviousVersion = recoveryFixture({ restored: { version: '2.8.7', expiresAt: 1060000 } });
  await flush(); assert.equal(noPreviousVersion.ensureCalls, 0);
  const explicit = fixture(); explicit.context.pendingLegacyGateUpdate = null;
  const proof = await explicit.context.authorizePageRecoveryReload({ tabId: 1, documentId: 'captured-document', reason: 'explicit_gate_action' });
  assert.ok(proof); assert.equal(explicit.revalidations, 1);
  assert.match(source, /details\.reason === 'update' && details\.previousVersion === '2\.8\.6'\) rememberLegacyGateUpdate\(details\)/);
});

test('transient last-tab failures retain intent with 2/5/15/30s backoff, no polling acceleration, and 10min expiry', async () => {
  const f = recoveryFixture(); await flush();
  f.remember({ reason: 'update', previousVersion: '2.8.6' }); await flush();
  assert.equal(f.ensureCalls, 1); assert.equal(f.context.recoverySnapshot().pending, true);
  for (let index = 0; index < 100; index++) f.context.requestLegacyGateRecovery();
  await flush(); assert.equal(f.ensureCalls, 1); assert.equal(f.timers.size, 1);
  for (let index = 0; index < 3; index++) await f.nextTimer();
  assert.deepEqual(f.scheduled.slice(0, 4), [2000, 5000, 15000, 30000]);
  let ticks = 3;
  while (f.timers.size) { assert.ok(++ticks < 30, 'expiry bounds total retry count'); await f.nextTimer(); }
  assert.equal(f.context.recoverySnapshot().pending, false); assert.equal(f.context.recoverySnapshot().sweep, false);
  assert.equal(f.removals, 1); assert.ok(f.ensureCalls <= 24);
});

test('startup unsettled state schedules one retry; successful recovery and terminal manual outcomes stop it', async () => {
  const f = recoveryFixture(); await flush(); f.context.authGateStartupComplete = false;
  f.remember({ reason: 'update', previousVersion: '2.8.6' }); await flush();
  assert.equal(f.ensureCalls, 0); assert.equal(f.timers.size, 1);
  f.context.authGateStartupComplete = true; f.setOutcome({ status: 'reloaded' });
  await f.nextTimer(); assert.equal(f.ensureCalls, 1); assert.equal(f.timers.size, 0); assert.equal(f.context.recoverySnapshot().pending, false);
  for (const reason of ['ownership_unproven', 'already_attempted', 'document_or_ownership_changed', 'marker_persistence_unavailable']) {
    const terminal = recoveryFixture({ result: { status: 'manual_reload_required', reason } }); await flush();
    terminal.remember({ reason: 'update', previousVersion: '2.8.6' }); await flush();
    assert.equal(terminal.ensureCalls, 1, reason); assert.equal(terminal.timers.size, 0, reason);
    assert.equal(terminal.context.recoverySnapshot().pending, false, reason);
  }
});

test('an in-flight sweep is never duplicated and a recovery signal is handled after its transient result', async () => {
  let release; const pending = new Promise(resolve => { release = resolve; });
  const f = recoveryFixture({ result: () => pending }); await flush();
  f.remember({ reason: 'update', previousVersion: '2.8.6' }); await flush();
  for (let index = 0; index < 100; index++) f.context.requestLegacyGateRecovery();
  assert.equal(f.ensureCalls, 1); assert.equal(f.timers.size, 0);
  release({ status: 'manual_reload_required', reason: 'policy_not_authorized' }); await flush();
  assert.equal(f.context.recoverySnapshot().pending, true); assert.equal(f.timers.size, 1);
  f.setOutcome({ status: 'ready' }); await f.nextTimer();
  assert.equal(f.ensureCalls, 2); assert.equal(f.timers.size, 0);
});

test('a settled signed-out gate receives fresh exact authority; later changes invalidate it', async () => {
  const f = fixture(); const proof = await f.authorize();
  assert.equal(f.revalidations, 1); assert.equal(proof.documentId, 'captured-document');
  assert.equal(f.context.pageRecoveryAuthorizationIsCurrent(proof), true);
  f.context.studentAuthMutationGeneration++;
  assert.equal(f.context.pageRecoveryAuthorizationIsCurrent(proof), false);
  f.context.studentAuthMutationGeneration--;
  f.context.managedAuthGatePolicyGeneration++;
  assert.equal(f.context.pageRecoveryAuthorizationIsCurrent(proof), false);
});

test('new mutation, authenticated state, stale update intent and kiosk URLs deny reload', async () => {
  const race = fixture();
  race.context.sharedManagedAuthGatePolicyRevalidation = async () => { race.context.studentAuthMutationPendingCount = 1; };
  assert.equal(await race.authorize(), null);
  const authenticated = fixture(); authenticated.context.hasStudentAuth = () => true;
  assert.equal(await authenticated.authorize(), null); assert.equal(authenticated.revalidations, 0);
  const stale = fixture(); stale.context.pendingLegacyGateUpdate = null;
  assert.equal(await stale.authorize(), null); assert.equal(stale.revalidations, 0);
  for (const url of ['chrome://newtab/', 'https://fixture.invalid/passpilot/kiosk', 'https://fixture.invalid/passpilot/kiosk/one']) {
    const f = fixture(); f.context.chrome.tabs.get = async () => ({ url });
    assert.equal(await f.authorize(), null);
  }
});
