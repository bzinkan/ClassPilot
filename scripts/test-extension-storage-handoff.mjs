// Exercise actual MV3 queue, storage, FAB and heartbeat functions. Only network
// responses and explicitly held storage boundaries are synthetic.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { waitForExtensionWorkerDeclarations } from './extension-worker-test-readiness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extension = resolve(process.env.CLASSPILOT_EXTENSION_PATH || join(root, 'extension'));
const profile = mkdtempSync(join(tmpdir(), 'classpilot-storage-handoff-'));
const executablePath = [process.env.CLASSPILOT_CHROME_PATH, chromium.executablePath(),
  'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(value => value && existsSync(value));
assert.ok(executablePath, 'Actual Chrome/Chromium is required');
let context;
try {
  context = await chromium.launchPersistentContext(profile, { executablePath, headless: true,
    args: ['--headless=new', '--no-proxy-server',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
      `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15_000 });
  await waitForExtensionWorkerDeclarations(worker);
  const result = await worker.evaluate(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
    const bounded = async (promise, label) => {
      let timer;
      try { return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`[regression:storage-handoff] ${label} did not complete`)), 3_000);
      })]); } finally { clearTimeout(timer); }
    };
    const until = async (predicate, label) => bounded((async () => {
      while (!predicate()) await wait(5);
    })(), label);
    await authStateRestorePromise; await classroomStateRestorePromise; await studentAuthMutationTail;
    await until(() => workerWakeSettled, 'native worker startup');
    CONFIG.autoRegistrationPaused = true;
    if (chromeProfileRegistrationInFlight) await chromeProfileRegistrationInFlight.catch(() => {});
    scheduleHeartbeat(null); await chrome.alarms.clearAll();
    advanceStudentAuthMutationGeneration();
    Object.assign(CONFIG, { serverUrl: 'http://127.0.0.1:1', schoolId: 'handoff-school', deviceId: 'handoff-device',
      activeStudentId: 'handoff-student-a', activeStudentSessionId: 'handoff-session-a',
      studentToken: 'synthetic-handoff-a', identitySource: 'integration_test' });
    studentAuthInvalidating = false; studentAuthCommitPending = false;
    activateAuthenticatedContext('handoff-auth-a');
    let auth = captureAuthenticatedContext('storage handoff fixture');
    adoptLicenseState(true, 'active', auth);
    const settings = { enableTrackingHours: false, afterHoursMode: 'off' };
    await kv.set({ [SCHOOL_SETTINGS_CACHE_KEY]: settings, [SCHOOL_SETTINGS_SCOPE_KEY]: schoolPolicyScopeForAuthContext(auth),
      [SCHOOL_SETTINGS_FETCHED_AT_KEY]: Date.now() });
    await loadCachedSchoolSettings({ authContext: auth });
    idleState = await chrome.idle.queryState(IDLE_DETECTION_SECONDS);
    trackingState = determineTrackingState();
    if (![TRACKING_STATES.ACTIVE, TRACKING_STATES.IDLE].includes(trackingState)) throw new Error('Fixture monitoring must be authorized');
    const protocolPayload = context => ({ studentId: context.studentId, studentSessionId: context.studentSessionId,
      schoolId: context.schoolId, serverProtocolVersion: CLIENT_PROTOCOL_VERSION, acceptedCapabilities: ['scopedAuthorityChecksV1'] });
    let heartbeats = 0;
    const originalFetch = fetchWithBackoff;
    fetchWithBackoff = async url => {
      if (String(url).endsWith('/api/device/heartbeat')) heartbeats += 1;
      return new Response(JSON.stringify(protocolPayload(captureAuthenticatedContext('synthetic school response'))),
        { status: 200, headers: { 'content-type': 'application/json' } });
    };
    const fab = (session, revision, context = auth) => ({ studentId: context.studentId, studentSessionId: context.studentSessionId,
      teachingSessionId: session, activeSessionIds: session ? [session] : [], ownershipRevision: revision,
      revision: 1, messagingEnabled: Boolean(session), handRaisingEnabled: Boolean(session), reason: 'control_ownership_transition' });
    const holdFabRead = () => {
      const entered = deferred(), release = deferred();
      const get = kv.get; let held = false;
      kv.get = async keys => {
        if (!held && Array.isArray(keys) && keys.includes(FAB_STATE_STORAGE_KEY) && keys.length === 3) {
          held = true; entered.resolve(); await release.promise;
        }
        return get(keys);
      };
      return { entered: entered.promise, release: release.resolve, restore: () => { kv.get = get; } };
    };
    const heartbeat = label => { heartbeatBackoffUntilMs = 0; return safeSendHeartbeat(label, { queryTabs: async () => [] }); };
    const transitionResults = [];
    try {
      await applyFabSettings(fab('class-initial', 1), { authContext: auth });
      for (const [session, revision] of [[null, 2], ['class-next', 3], ['class-later', 4]]) {
        const held = holdFabRead();
        const transition = applyFabSettings(fab(session, revision), { authContext: auth });
        await bounded(held.entered, 'FAB storage boundary');
        const priorCleanup = retiredExactBoundStorageCleanupMutation;
        const send = heartbeat(`class-transition-${revision}`);
        await until(() => retiredExactBoundStorageCleanupMutation !== priorCleanup, 'heartbeat storage adoption');
        // A second request must follow the original cleanup, without joining
        // itself or replacing the original cleanup's own publication barrier.
        const concurrentCleanup = cleanupRetiredExactBoundStorage(auth, 'concurrent exact storage adoption');
        held.release(); held.restore();
        await bounded(Promise.all([transition, send, concurrentCleanup]), 'FAB transition, heartbeat and concurrent cleanup');
        await bounded(studentAuthMutationTail, 'post-transition auth queue');
        transitionResults.push({ session: currentFabState?.teachingSessionId ?? null,
          revision: currentFabState?.ownershipRevision, inFlight: heartbeatInFlight });
      }

      // An old FAB continuation held at the same boundary must not restore
      // private state after a new immutable authentication generation wins.
      const oldAuth = auth;
      await kv.set({ [MESSAGE_INBOX_STORAGE_KEY]: [{ id: 'retired-private-message' }],
        [MESSAGE_INBOX_BINDING_KEY]: monitoringEventAuthBindingForContext(oldAuth) });
      const heldOld = holdFabRead();
      const oldTransition = applyFabSettings(fab('retired-class', 5), { authContext: oldAuth })
        .then(() => 'unexpected-success', error => error.code);
      await bounded(heldOld.entered, 'retired FAB boundary');
      advanceStudentAuthMutationGeneration();
      Object.assign(CONFIG, { activeStudentId: 'handoff-student-b', activeStudentSessionId: 'handoff-session-b',
        studentToken: 'synthetic-handoff-b' });
      activateAuthenticatedContext('handoff-auth-b');
      auth = captureAuthenticatedContext('replacement identity');
      adoptLicenseState(true, 'active', auth);
      const replacementCleanup = cleanupRetiredExactBoundStorage(auth, 'replacement identity cleanup');
      heldOld.release(); heldOld.restore();
      const oldOutcome = await bounded(oldTransition, 'retired FAB rejection');
      await bounded(replacementCleanup, 'replacement cleanup');
      const afterReplacement = await kv.get([MESSAGE_INBOX_STORAGE_KEY, MESSAGE_INBOX_BINDING_KEY, FAB_STATE_STORAGE_KEY]);
      await applyFabSettings(fab('replacement-class', 1), { authContext: auth });

      // Once the frontier is drained, writers arriving during physical purge
      // must stay behind its barrier and run only after cleanup completes.
      const purgeEntered = deferred(), purgeRelease = deferred();
      const durableGet = durableLocalKv.get; let purgeHeld = false;
      durableLocalKv.get = async keys => {
        if (!purgeHeld && Array.isArray(keys) && keys.includes(MESSAGE_INBOX_STORAGE_KEY)) {
          purgeHeld = true; purgeEntered.resolve(); await purgeRelease.promise;
        }
        return durableGet(keys);
      };
      const purge = cleanupRetiredExactBoundStorage(auth, 'held physical purge');
      await bounded(purgeEntered.promise, 'physical purge boundary');
      let freshWriterEntered = false;
      const freshWriter = enqueueFabStateMutation(async () => {
        freshWriterEntered = true;
        assertAuthenticatedContextCurrent(auth, 'fresh writer behind cleanup');
        await kv.set({ fabChatMessages: [{ id: 'current-private-message' }] });
      });
      await wait(25);
      const blockedDuringPurge = !freshWriterEntered;
      purgeRelease.resolve(); durableLocalKv.get = durableGet;
      await bounded(Promise.all([purge, freshWriter]), 'purge followed by fresh writer');

      // A cleanup which loses its own identity while draining must reject;
      // it cannot purge the replacement identity's already published data.
      const oldCleanupGate = deferred();
      const priorMonitoring = monitoringEventMutation;
      monitoringEventMutation = priorMonitoring.then(() => oldCleanupGate.promise);
      const supersededCleanup = cleanupRetiredExactBoundStorage(auth, 'superseded cleanup')
        .then(() => 'unexpected-success', error => error.code);
      advanceStudentAuthMutationGeneration();
      activateAuthenticatedContext('handoff-auth-b-next-generation');
      auth = captureAuthenticatedContext('new generation');
      adoptLicenseState(true, 'active', auth);
      oldCleanupGate.resolve();
      const supersededOutcome = await bounded(supersededCleanup, 'superseded cleanup rejection');
      const preservedMessages = (await kv.get(['fabChatMessages'])).fabChatMessages;
      await bounded(cleanupRetiredExactBoundStorage(auth, 'current generation cleanup'), 'new generation cleanup');
      await bounded(adoptAuthenticatedStudentBinding(protocolPayload(auth), 'post-transition auth adoption'), 'auth progress');
      // The fixture replaced credentials directly rather than running the full
      // login UI; restore the authenticated policy/entitlement login applies.
      await loadCachedSchoolSettings({ authContext: auth });
      adoptLicenseState(true, 'active', auth);
      trackingState = determineTrackingState();
      await bounded(heartbeat('post-transition-progress'), 'heartbeat progress');
      return { transitionResults, heartbeats, oldOutcome, supersededOutcome, blockedDuringPurge,
        freshWriterEntered, afterReplacement, preservedMessages, authenticated: hasStudentAuth(), inFlight: heartbeatInFlight };
    } finally {
      fetchWithBackoff = originalFetch;
      clearPendingEventHeartbeat(); scheduleHeartbeat(null); await chrome.alarms.clearAll();
    }
  });
  assert.deepEqual(result.transitionResults, [
    { session: null, revision: 2, inFlight: false },
    { session: 'class-next', revision: 3, inFlight: false },
    { session: 'class-later', revision: 4, inFlight: false },
  ]);
  assert.ok(result.heartbeats >= 4, `native heartbeats must continue through repeated transitions: ${JSON.stringify(result)}`);
  assert.equal(result.oldOutcome, 'AUTH_CONTEXT_SUPERSEDED');
  assert.equal(result.supersededOutcome, 'AUTH_CONTEXT_SUPERSEDED');
  assert.deepEqual(result.afterReplacement.messages, []);
  assert.equal(result.afterReplacement.messageInboxAuthBindingV1?.includes('handoff-auth-b'), true);
  assert.equal(result.afterReplacement.fabStateV1, null);
  assert.equal(result.blockedDuringPurge, true);
  assert.equal(result.freshWriterEntered, true);
  assert.deepEqual(result.preservedMessages, [{ id: 'current-private-message' }]);
  assert.equal(result.authenticated, true);
  assert.equal(result.inFlight, false);
  console.log('PASS native FAB/heartbeat storage handoffs, nested writers, concurrent cleanup and retired-identity fencing');
} finally {
  if (context) await context.close();
  rmSync(profile, { recursive: true, force: true });
}
