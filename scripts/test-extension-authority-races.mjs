import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const extensionPath = String(process.env.CLASSPILOT_EXTENSION_PATH || '').trim()
  ? resolve(process.env.CLASSPILOT_EXTENSION_PATH)
  : resolve(repoRoot, 'extension');
const profilePath = mkdtempSync(join(tmpdir(), 'classpilot-authority-races-'));

function extractCallArguments(source, callee) {
  const calls = [];
  let cursor = 0;
  while (cursor < source.length) {
    const callAt = source.indexOf(callee, cursor);
    if (callAt < 0) break;
    let openAt = callAt + callee.length;
    while (/\s/.test(source[openAt] || '')) openAt += 1;
    if (source[openAt] !== '(') {
      cursor = openAt + 1;
      continue;
    }
    let depth = 0;
    let quote = null;
    let escaped = false;
    for (let index = openAt; index < source.length; index += 1) {
      const char = source[index];
      const next = source[index + 1];
      if (quote) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === quote) quote = null;
        continue;
      }
      if (char === '\'' || char === '"' || char === '`') {
        quote = char;
        continue;
      }
      if (char === '/' && next === '/') {
        const newline = source.indexOf('\n', index + 2);
        index = newline < 0 ? source.length : newline;
        continue;
      }
      if (char === '/' && next === '*') {
        const close = source.indexOf('*/', index + 2);
        index = close < 0 ? source.length : close + 1;
        continue;
      }
      if (char === '(') depth += 1;
      if (char === ')') {
        depth -= 1;
        if (depth === 0) {
          calls.push(source.slice(openAt + 1, index));
          cursor = index + 1;
          break;
        }
      }
    }
    if (cursor <= callAt) cursor = openAt + 1;
  }
  return calls;
}

function chromeExecutable() {
  const configured = String(process.env.CLASSPILOT_CHROME_PATH || '').trim();
  const candidates = [
    configured,
    chromium.executablePath(),
    process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '',
    process.platform === 'win32' ? 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe' : '',
    process.platform === 'darwin' ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' : '',
    process.platform === 'linux' ? '/usr/bin/google-chrome' : '',
    process.platform === 'linux' ? '/usr/bin/chromium' : '',
  ];
  return candidates.find((candidate) => candidate && existsSync(candidate)) || null;
}

async function main() {
  const executablePath = chromeExecutable();
  if (!executablePath) throw new Error('Chrome/Chromium is required for extension authority race tests');
  const workerSource = readFileSync(resolve(extensionPath, 'service-worker.js'), 'utf8');
  assert.match(workerSource, /Unowned legacy classroom state was not adopted/);
  assert.doesNotMatch(workerSource, /legacy_migration|Migrated legacy classroom restrictions/);
  assert.match(workerSource, /'studentAuthGatePresenceV1'/);
  assert.match(workerSource, /'lateSignInRestrictionSsoV1'/);
  assert.match(workerSource, /deliveryContext\?\.lateSignInRestrictionSso === true/);
  assert.match(workerSource, /RESTRICTION_SSO_VISIT_STORAGE_KEY/);
  assert.match(workerSource, /\/api\/extension\/session-gate-presence/);
  assert.match(workerSource, /STUDENT_AUTH_GATE_PRESENCE_CAPABILITIES/);
  const scopedStorageBlock = workerSource.match(
    /const SESSION_SCOPED_STUDENT_STORAGE_KEYS = new Set\(\[([\s\S]*?)\]\);/,
  )?.[1] || '';
  const scopedStorageKeys = new Set(
    [...scopedStorageBlock.matchAll(/'([^']+)'/g)].map((match) => match[1]),
  );
  const requiredSessionScopedKeys = [
    'authContextId',
    'studentToken',
    'activeStudentId',
    'activeStudentSessionId',
    'studentEmail',
    'studentName',
    'sharedAuthLockOwnerV1',
    'classroomStateStudentBindingV1',
    'licenseStateScopeV1',
    'monitoringStateScopeV1',
    'messages',
    'messageInboxAuthBindingV1',
    'messageInboxSeenIdsV1',
    'pendingCheckIn',
    'fabStateV1',
    'fabContextV1',
    'fabChatContextV1',
    'classroomOverlayStateV1',
    'tabSnapshotV1',
    'monitoringEventOutboxV1',
    'monitoringEventOutboxAuthBindingV1',
    'commandAckOutboxV1',
    'commandAckOutboxAuthBindingV1',
    'chatAckOutboxV1',
    'chatAckOutboxAuthBindingV1',
    'studentChatOutboxV1',
    'studentChatOutboxAuthBindingV1',
  ];
  for (const key of requiredSessionScopedKeys) {
    assert.equal(scopedStorageKeys.has(key), true, `${key} must remain browser-session scoped`);
  }
  const directLocalSetCalls = extractCallArguments(workerSource, 'chrome.storage.local.set');
  const sensitiveSetTokens = [
    ...requiredSessionScopedKeys,
    'MONITORING_EVENT_OUTBOX_KEY',
    'MONITORING_EVENT_AUTH_BINDING_KEY',
    'COMMAND_ACK_OUTBOX_KEY',
    'COMMAND_ACK_BINDING_KEY',
    'CHAT_ACK_OUTBOX_KEY',
    'CHAT_ACK_BINDING_KEY',
    'STUDENT_CHAT_OUTBOX_KEY',
    'STUDENT_CHAT_OUTBOX_BINDING_KEY',
    'MESSAGE_INBOX_STORAGE_KEY',
    'MESSAGE_INBOX_BINDING_KEY',
    'PENDING_CHECK_IN_KEY',
    'TAB_SNAPSHOT_STORAGE_KEY',
  ];
  for (const call of directLocalSetCalls) {
    for (const token of sensitiveSetTokens) {
      assert.equal(
        call.includes(token),
        false,
        `direct chrome.storage.local.set bypasses session router for ${token}`,
      );
    }
    if (/\bconfig\s*:/.test(call)) {
      assert.match(call, /config\s*:\s*persistedNonAuthConfig\(CONFIG\)/);
    }
  }
  const authClearCalls = extractCallArguments(workerSource, 'clearStudentAuth');
  const explicitSignOutCall = authClearCalls.find((call) => (
    call.includes("'explicit_sign_out'")
  ));
  assert.ok(explicitSignOutCall, 'student sign-out must clear the exact authenticated context');
  assert.match(
    explicitSignOutCall,
    /awaitBackendSignOut\s*:\s*true/,
    'student sign-out must wait for the bounded exact bearer cleanup',
  );
  assert.match(
    explicitSignOutCall,
    /preserveRecoveryForGate\s*:\s*true/,
    'student sign-out must preserve Resume authority until server cleanup is confirmed',
  );
  const extensionUpdateCall = authClearCalls.find((call) => (
    call.includes("'extension_update'")
  ));
  assert.ok(extensionUpdateCall, 'extension updates must clear the exact authenticated context');
  assert.match(
    extensionUpdateCall,
    /awaitBackendSignOut\s*:\s*true/,
    'extension updates must not strand the pre-update student session',
  );
  assert.match(
    extensionUpdateCall,
    /preserveRecoveryForGate\s*:\s*true/,
    'extension updates must retain recovery authority until cleanup is confirmed',
  );
  let context;
  try {
    context = await chromium.launchPersistentContext(profilePath, {
      executablePath,
      headless: true,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });
    const worker = context.serviceWorkers()[0]
      || await context.waitForEvent('serviceworker', { timeout: 10_000 });
    const result = await worker.evaluate(async () => {
      await authStateRestorePromise.catch(() => {});
      await classroomStateRestorePromise.catch(() => {});
      const boundedWait = (promise, label, timeoutMs = 5_000) => Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}`)),
          timeoutMs,
        )),
      ]);

      // Recovery capabilities survive a browser-level auth reset without
      // persisting reusable student credentials. Retry metadata must not
      // revoke a roster-bound reclaim grant, and a delayed clear from A must
      // never promote or release B's newer armed record.
      const originalRecoveryFetch = globalThis.fetch;
      const legacyUpgradeSignOutRequests = [];
      let releaseLegacyUpgradeSignOut;
      const legacyUpgradeSignOutGate = new Promise((resolve) => {
        releaseLegacyUpgradeSignOut = resolve;
      });
      globalThis.fetch = async (url, init = {}) => {
        if (String(url).endsWith('/api/extension/session-release')) {
          return new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } });
        }
        if (String(url).endsWith('/api/extension/sign-out')) {
          legacyUpgradeSignOutRequests.push({ url: String(url), init });
          await legacyUpgradeSignOutGate;
          return new Response(null, { status: 204 });
        }
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      };
      CONFIG.serverUrl = 'https://school-pilot.net';
      CONFIG.schoolId = 'school-recovery';
      await enqueueStudentSessionRecoveryMutation(() => persistStudentSessionRecoveryState(
        emptyStudentSessionRecoveryState(),
      ));
      const oldRecovery = await armStudentSessionRecovery({
        serverOrigin: CONFIG.serverUrl,
        schoolId: CONFIG.schoolId,
        token: 'A'.repeat(43),
        authContextId: 'auth_recovery_old',
      });
      await transitionStudentSessionRecoveryForAuthClear('auth_recovery_old');
      if (studentSessionRecoveryFlushPromise) {
        await boundedWait(studentSessionRecoveryFlushPromise, 'initial recovery retry');
      }
      const pendingBeforeMetadataRetry = studentSessionRecoveryState.pending.find(
        (record) => record.generation === oldRecovery.generation,
      );
      const oldRosterGrantId = bindLoginRosterRecoveryGrant(pendingBeforeMetadataRetry, [{
        id: 'student-recovery-old',
        hasPin: true,
        reclaimable: true,
      }], 'recovery-cache-key');
      const grantBeforeMetadataRetry = Boolean(
        recoveryGrantForStudentLogin('student-recovery-old', oldRosterGrantId),
      );
      const materialRevisionBeforeRetry = studentSessionRecoveryRevision;
      await applyStudentSessionRecoveryReleaseOutcome(pendingBeforeMetadataRetry, {
        outcome: 'retry',
        retryAfterMs: 30_000,
      });
      const grantAfterMetadataRetry = Boolean(
        recoveryGrantForStudentLogin('student-recovery-old', oldRosterGrantId),
      );
      const materialRevisionAfterRetry = studentSessionRecoveryRevision;
      const newRecovery = await armStudentSessionRecovery({
        serverOrigin: CONFIG.serverUrl,
        schoolId: CONFIG.schoolId,
        token: 'B'.repeat(43),
        authContextId: 'auth_recovery_new',
      });
      const delayedOldClear = await transitionStudentSessionRecoveryForAuthClear(
        'auth_recovery_old',
      );
      const armedAfterDelayedOldClear = studentSessionRecoveryState.armed;
      const persistedRecovery = (await chrome.storage.local.get(
        STUDENT_SESSION_RECOVERY_STORAGE_KEY,
      ))[STUDENT_SESSION_RECOVERY_STORAGE_KEY];
      const persistedArmedKeys = Object.keys(persistedRecovery?.armed || {}).sort();
      await enqueueStudentSessionRecoveryMutation(() => persistStudentSessionRecoveryState(
        emptyStudentSessionRecoveryState(),
      ));

      // A real 2.7.2 upgrade may still contain reusable auth in local storage.
      // It is consumed once for exact compatible sign-out, never restored or
      // copied to storage.session, and is removed durably before the request.
      await chrome.storage.local.set({
        config: { serverUrl: 'https://school-pilot.net', deviceId: 'legacy-device' },
        deviceId: 'legacy-device',
        authContextId: 'auth_legacy_upgrade',
        studentToken: 'legacy-bearer-token',
        activeStudentId: 'legacy-student',
        activeStudentSessionId: 'legacy-session',
        studentName: 'Legacy Student',
        studentEmail: 'legacy@example.edu',
        identitySource: 'manual_pin',
        registered: true,
      });
      let legacyUpgradeRestoreSettled = false;
      const legacyUpgradeRestorePromise = getStoredAuthState([
        'config',
        'deviceId',
        'authContextId',
        'studentToken',
        'activeStudentId',
        'activeStudentSessionId',
        'studentName',
        'studentEmail',
        'identitySource',
        'registered',
      ]).then((value) => {
        legacyUpgradeRestoreSettled = true;
        return value;
      });
      await boundedWait((async () => {
        while (legacyUpgradeSignOutRequests.length === 0) {
          await new Promise((resolve) => setTimeout(resolve, 0));
        }
      })(), 'legacy upgrade sign-out');
      const legacyUpgradeLocalStorageDuringSignOut = await chrome.storage.local.get([
        'authContextId',
        'studentToken',
        'activeStudentId',
        'activeStudentSessionId',
        'studentName',
        'studentEmail',
        'identitySource',
        'registered',
      ]);
      const legacyUpgradeRestoreSettledBeforeSignOut = legacyUpgradeRestoreSettled;
      releaseLegacyUpgradeSignOut();
      const legacyUpgradeRestore = await boundedWait(
        legacyUpgradeRestorePromise,
        'legacy upgrade restore barrier',
      );
      const legacyUpgradeLocalStorage = await chrome.storage.local.get([
        'authContextId',
        'studentToken',
        'activeStudentId',
        'activeStudentSessionId',
        'studentName',
        'studentEmail',
        'identitySource',
        'registered',
      ]);
      const legacyUpgradeSessionStorage = await chrome.storage.session.get([
        'authContextId',
        'studentToken',
        'activeStudentId',
        'activeStudentSessionId',
        'studentName',
        'studentEmail',
      ]);
      globalThis.fetch = originalRecoveryFetch;

      await setManualAuthState({
        studentToken: 'session-only-token',
        activeStudentId: 'session-only-student',
        activeStudentSessionId: 'session-only-session',
        studentName: 'Session Only',
        studentEmail: 'session-only@example.edu',
      });
      const manualLocalStorage = await chrome.storage.local.get([
        'studentToken',
        'activeStudentId',
        'activeStudentSessionId',
        'studentName',
        'studentEmail',
      ]);
      const manualSessionStorage = await chrome.storage.session.get([
        'studentToken',
        'activeStudentId',
        'activeStudentSessionId',
      ]);
      await chrome.storage.session.remove([
        'studentToken',
        'activeStudentId',
        'activeStudentSessionId',
        'studentName',
        'studentEmail',
      ]);
      const recoveryRace = {
        grantBeforeMetadataRetry,
        grantAfterMetadataRetry,
        materialRevisionBeforeRetry,
        materialRevisionAfterRetry,
        delayedOldClear,
        newRecoveryGeneration: newRecovery.generation,
        armedAfterDelayedOldClearGeneration: armedAfterDelayedOldClear?.generation || null,
        persistedArmedKeys,
        legacyUpgradeRestore,
        legacyUpgradeRestoreSettledBeforeSignOut,
        legacyUpgradeLocalStorageDuringSignOut,
        legacyUpgradeLocalStorage,
        legacyUpgradeSessionStorage,
        legacyUpgradeSignOutRequest: legacyUpgradeSignOutRequests[0] ? {
          url: legacyUpgradeSignOutRequests[0].url,
          authorization: legacyUpgradeSignOutRequests[0].init?.headers?.Authorization || null,
          body: legacyUpgradeSignOutRequests[0].init?.body || null,
        } : null,
        manualLocalStorage,
        manualSessionStorage,
      };

      const commitIdentity = (suffix) => {
        CONFIG.serverUrl = 'https://school-pilot.net';
        CONFIG.schoolId = `school-${suffix}`;
        CONFIG.deviceId = `device-${suffix}`;
        CONFIG.activeStudentId = `student-${suffix}`;
        CONFIG.activeStudentSessionId = `student-session-${suffix}`;
        CONFIG.studentToken = `token-${suffix}`;
        CONFIG.studentEmail = `${suffix}@example.edu`;
        CONFIG.identitySource = 'integration_test';
        CONFIG.manualLoginLastSeenAt = null;
        studentAuthInvalidating = false;
        studentAuthCommitPending = false;
        activateAuthenticatedContext(`auth-context-${suffix}-${Date.now()}`);
        const authContext = captureAuthenticatedContext(`authority race ${suffix}`);
        adoptLicenseState(true, 'active', authContext);
        trackingState = TRACKING_STATES.ACTIVE;
        apiBackoffUntilMs = 0;
        return authContext;
      };
      const installIdentity = (suffix) => {
        advanceStudentAuthMutationGeneration();
        return commitIdentity(suffix);
      };
      const commandEnvelope = (authContext, teachingSessionId = 'teaching-session-race') => ({
        studentId: authContext.studentId,
        studentSessionId: authContext.studentSessionId,
        authority: { kind: 'teaching_session', teachingSessionId },
      });
      const installCommandAuthority = (authContext, teachingSessionId = 'teaching-session-race') => {
        currentClassroomState = {
          schemaVersion: 1,
          revision: 1,
          teachingSessionId,
          receivedAt: Date.now(),
          hardExpiresAt: Date.now() + 60_000,
          restrictions: {},
        };
        adoptNegotiatedProtocolState({ serverProtocolVersion: 3, acceptedCapabilities: [] }, authContext);
      };

      // A never-settling legacy backend revoke is fire-and-forget after local
      // invalidation and cannot hold the auth mutation queue.
      installIdentity('hung-signout');
      const originalFetchWithBackoff = fetchWithBackoff;
      const originalFlushMonitoringEventOutbox = flushMonitoringEventOutbox;
      const originalFlushCommandAckOutbox = flushCommandAckOutbox;
      const originalFlushChatAckOutbox = flushChatAckOutbox;
      let retiringOutboxNetworkCalls = 0;
      const neverSettlingOutboxFlush = async () => {
        retiringOutboxNetworkCalls += 1;
        return new Promise(() => {});
      };
      flushMonitoringEventOutbox = neverSettlingOutboxFlush;
      flushCommandAckOutbox = neverSettlingOutboxFlush;
      flushChatAckOutbox = neverSettlingOutboxFlush;
      fetchWithBackoff = async (url, init, options) => {
        if (String(url).endsWith('/api/extension/sign-out')) return new Promise(() => {});
        return originalFetchWithBackoff(url, init, options);
      };
      const signOutStartedAt = Date.now();
      await clearStudentAuth('authority-race-hung-signout', {
        notifyBackend: true,
        pauseAutoRegistration: true,
      });
      const signOutElapsedMs = Date.now() - signOutStartedAt;
      const signOutStorage = await chrome.storage.local.get([
        'studentToken',
        'activeStudentId',
        'activeStudentSessionId',
      ]);
      fetchWithBackoff = originalFetchWithBackoff;
      flushMonitoringEventOutbox = originalFlushMonitoringEventOutbox;
      flushCommandAckOutbox = originalFlushCommandAckOutbox;
      flushChatAckOutbox = originalFlushChatAckOutbox;

      // A first deliberate sign-out must not open the roster ahead of the
      // exact bearer-bound server commit. This is the cold-device fallback
      // before managed-device continuity has ever been established. Recovery
      // cleanup may fail independently; the confirmed bearer sign-out still
      // makes the student immediately roster-visible.
      let firstSignOutAuth = installIdentity('first-explicit-signout');
      CONFIG.identitySource = 'manual_pin';
      CONFIG.manualLoginLastSeenAt = Date.now();
      activateAuthenticatedContext(generateAuthContextId());
      firstSignOutAuth = captureAuthenticatedContext('first explicit sign-out');
      await armStudentSessionRecovery({
        serverOrigin: firstSignOutAuth.serverOrigin,
        schoolId: firstSignOutAuth.schoolId,
        token: 'F'.repeat(43),
        authContextId: firstSignOutAuth.authContextId,
      });
      const firstSignOutOriginalFetch = globalThis.fetch;
      let firstSignOutReleaseRequests = 0;
      let firstSignOutBearerRequests = 0;
      let releaseFirstSignOutRequest;
      let markFirstSignOutRequestStarted;
      const firstSignOutRequestStarted = new Promise((resolve) => {
        markFirstSignOutRequestStarted = resolve;
      });
      const firstSignOutRequestGate = new Promise((resolve) => {
        releaseFirstSignOutRequest = resolve;
      });
      globalThis.fetch = async (url) => {
        if (String(url).endsWith('/api/extension/session-release')) {
          firstSignOutReleaseRequests += 1;
          return new Response(JSON.stringify({ code: 'SESSION_RELEASE_UNAVAILABLE' }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };
      fetchWithBackoff = async (url, init, options) => {
        if (String(url).endsWith('/api/extension/sign-out')) {
          firstSignOutBearerRequests += 1;
          markFirstSignOutRequestStarted();
          await firstSignOutRequestGate;
          return new Response('{}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return originalFetchWithBackoff(url, init, options);
      };
      let firstSignOutSettled = false;
      const firstSignOutPromise = clearStudentAuth('explicit_sign_out', {
        notifyBackend: true,
        awaitBackendSignOut: true,
        preserveRecoveryForGate: true,
        pauseAutoRegistration: true,
        expectedAuthContext: firstSignOutAuth,
      }).then(() => {
        firstSignOutSettled = true;
      });
      await boundedWait(firstSignOutRequestStarted, 'first explicit sign-out request');
      await Promise.resolve();
      const firstSignOutSettledBeforeCommit = firstSignOutSettled;
      releaseFirstSignOutRequest();
      await boundedWait(firstSignOutPromise, 'first explicit sign-out completion');
      if (studentSessionRecoveryFlushPromise) {
        await boundedWait(studentSessionRecoveryFlushPromise, 'first explicit recovery cleanup');
      }
      const firstSignOutRecoveryAfterCommit = studentSessionRecoveryStateHasRecords();
      globalThis.fetch = firstSignOutOriginalFetch;
      fetchWithBackoff = originalFetchWithBackoff;

      // If the bounded exact sign-out cannot be confirmed, the local logout
      // still completes but its one-time recovery authority must remain
      // reserved for the gate. That gives the same Chromebook an immediate
      // PIN-protected Resume path instead of waiting for the server lease.
      let failedFirstSignOutAuth = installIdentity('failed-first-explicit-signout');
      CONFIG.identitySource = 'manual_pin';
      CONFIG.manualLoginLastSeenAt = Date.now();
      activateAuthenticatedContext(generateAuthContextId());
      failedFirstSignOutAuth = captureAuthenticatedContext('failed first explicit sign-out');
      const failedFirstSignOutToken = 'Q'.repeat(43);
      await armStudentSessionRecovery({
        serverOrigin: failedFirstSignOutAuth.serverOrigin,
        schoolId: failedFirstSignOutAuth.schoolId,
        token: failedFirstSignOutToken,
        authContextId: failedFirstSignOutAuth.authContextId,
      });
      let failedFirstSignOutBearerRequests = 0;
      fetchWithBackoff = async (url, init, options) => {
        if (String(url).endsWith('/api/extension/sign-out')) {
          failedFirstSignOutBearerRequests += 1;
          return new Response(JSON.stringify({ error: 'temporarily unavailable' }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          });
        }
        return originalFetchWithBackoff(url, init, options);
      };
      await clearStudentAuth('explicit_sign_out', {
        notifyBackend: true,
        awaitBackendSignOut: true,
        preserveRecoveryForGate: true,
        pauseAutoRegistration: true,
        expectedAuthContext: failedFirstSignOutAuth,
      });
      const failedFirstSignOutRecovery = matchingStudentSessionRecoveryRecord();
      const failedFirstSignOutGrantId = bindLoginRosterRecoveryGrant(
        failedFirstSignOutRecovery,
        [{ id: 'student-failed-first-signout', hasPin: true, reclaimable: true }],
        'failed-first-signout-cache-key',
      );
      const failedFirstSignOutGrant = recoveryGrantForStudentLogin(
        'student-failed-first-signout',
        failedFirstSignOutGrantId,
      );
      const failedFirstSignOutResumeAvailable = Boolean(
        failedFirstSignOutRecovery?.token === failedFirstSignOutToken
        && failedFirstSignOutRecovery?.intent === STUDENT_SESSION_RECOVERY_INTENT_RESUME
        && failedFirstSignOutGrant?.token === failedFirstSignOutToken
      );
      fetchWithBackoff = originalFetchWithBackoff;
      await persistStudentSessionRecoveryState(emptyStudentSessionRecoveryState());
      resetLoginRosterRuntimeCache();

      // A shared-device lock timeout is owned by the exact manual-auth
      // context that scheduled it. A delayed idle callback from A cannot sign
      // B out, and a delayed A timer clear cannot erase B's replacement lock.
      let lockTimeoutAuthA = installIdentity('lock-timeout-a');
      CONFIG.identitySource = 'manual_pin';
      CONFIG.manualLoginLastSeenAt = Date.now();
      activateAuthenticatedContext(`auth-context-lock-timeout-a-manual-${Date.now()}`);
      lockTimeoutAuthA = captureAuthenticatedContext('lock timeout A manual identity');
      const lockTimeoutAtA = Date.now() - SHARED_AUTH_LOCK_TIMEOUT_MS - 1_000;
      await persistSharedAuthLockState({
        studentToken: lockTimeoutAuthA.studentToken,
        sharedAuthLockedSinceAt: lockTimeoutAtA,
        [SHARED_AUTH_LOCK_OWNER_KEY]: sharedAuthLockOwnerFor(lockTimeoutAuthA, lockTimeoutAtA),
      }, true);
      sharedAuthLockedSinceAt = lockTimeoutAtA;
      idleState = 'locked';
      const originalIdleQueryState = chrome.idle.queryState;
      let releaseLockIdleQuery;
      let lockIdleQueryStarted;
      const lockIdleQueryReady = new Promise((resolve) => { lockIdleQueryStarted = resolve; });
      const lockIdleQueryGate = new Promise((resolve) => { releaseLockIdleQuery = resolve; });
      chrome.idle.queryState = (_seconds, callback) => {
        lockIdleQueryStarted();
        lockIdleQueryGate.then(() => callback('locked'));
      };
      const lockTimeoutPromise = handleSharedAuthLockTimeout().then(
        () => 'completed',
        (error) => error?.code || error?.message || 'error',
      );
      await boundedWait(lockIdleQueryReady, 'shared-auth idle query');
      let lockTimeoutAuthB = installIdentity('lock-timeout-b');
      CONFIG.identitySource = 'manual_pin';
      CONFIG.manualLoginLastSeenAt = Date.now();
      activateAuthenticatedContext(`auth-context-lock-timeout-b-manual-${Date.now()}`);
      lockTimeoutAuthB = captureAuthenticatedContext('lock timeout B manual identity');
      const lockTimeoutAtB = Date.now();
      await persistSharedAuthLockState({
        studentToken: lockTimeoutAuthB.studentToken,
        sharedAuthLockedSinceAt: lockTimeoutAtB,
        [SHARED_AUTH_LOCK_OWNER_KEY]: sharedAuthLockOwnerFor(lockTimeoutAuthB, lockTimeoutAtB),
      }, true);
      sharedAuthLockedSinceAt = lockTimeoutAtB;
      releaseLockIdleQuery();
      const lockTimeoutOutcome = await lockTimeoutPromise;
      chrome.idle.queryState = originalIdleQueryState;
      const lockTimeoutStorageAfter = await getStoredAuthState([
        'studentToken',
        'sharedAuthLockedSinceAt',
        SHARED_AUTH_LOCK_OWNER_KEY,
      ]);

      let lockClearAuthA = installIdentity('lock-clear-a');
      CONFIG.identitySource = 'manual_pin';
      CONFIG.manualLoginLastSeenAt = Date.now();
      activateAuthenticatedContext(`auth-context-lock-clear-a-manual-${Date.now()}`);
      lockClearAuthA = captureAuthenticatedContext('lock clear A manual identity');
      const lockClearAtA = Date.now();
      await persistSharedAuthLockState({
        studentToken: lockClearAuthA.studentToken,
        sharedAuthLockedSinceAt: lockClearAtA,
        [SHARED_AUTH_LOCK_OWNER_KEY]: sharedAuthLockOwnerFor(lockClearAuthA, lockClearAtA),
      }, true);
      sharedAuthLockedSinceAt = lockClearAtA;
      const originalGetStoredAuthState = getStoredAuthState;
      let releaseLockClearRead;
      let lockClearReadStarted;
      const lockClearReadReady = new Promise((resolve) => { lockClearReadStarted = resolve; });
      const lockClearReadGate = new Promise((resolve) => { releaseLockClearRead = resolve; });
      let pauseLockClearRead = true;
      getStoredAuthState = async (keys) => {
        const stored = await originalGetStoredAuthState(keys);
        if (pauseLockClearRead && Array.isArray(keys) && keys.includes(SHARED_AUTH_LOCK_OWNER_KEY)) {
          pauseLockClearRead = false;
          lockClearReadStarted();
          await lockClearReadGate;
        }
        return stored;
      };
      const lockClearPromise = clearSharedAuthLockTimer({ authContext: lockClearAuthA }).then(
        () => 'completed',
        (error) => error?.code || error?.message || 'error',
      );
      await boundedWait(lockClearReadReady, 'shared-auth lock clear read');
      let lockClearAuthB = installIdentity('lock-clear-b');
      CONFIG.identitySource = 'manual_pin';
      CONFIG.manualLoginLastSeenAt = Date.now();
      activateAuthenticatedContext(`auth-context-lock-clear-b-manual-${Date.now()}`);
      lockClearAuthB = captureAuthenticatedContext('lock clear B manual identity');
      const lockClearAtB = Date.now();
      await persistSharedAuthLockState({
        studentToken: lockClearAuthB.studentToken,
        sharedAuthLockedSinceAt: lockClearAtB,
        [SHARED_AUTH_LOCK_OWNER_KEY]: sharedAuthLockOwnerFor(lockClearAuthB, lockClearAtB),
      }, true);
      sharedAuthLockedSinceAt = lockClearAtB;
      releaseLockClearRead();
      const lockClearOutcome = await lockClearPromise;
      getStoredAuthState = originalGetStoredAuthState;
      const lockClearStorageAfter = await getStoredAuthState([
        'studentToken',
        'sharedAuthLockedSinceAt',
        SHARED_AUTH_LOCK_OWNER_KEY,
      ]);

      // Focusing another Chrome window during capture invalidates the pixels
      // even if the original window still reports its prior tab as active.
      const screenshotAuth = installIdentity('screenshot-focus');
      adoptNegotiatedProtocolState({ serverProtocolVersion: 3, acceptedCapabilities: [] }, screenshotAuth);
      adoptScreenshotPolicy(undefined, screenshotAuth);
      lastScreenshotAttemptAt = 0;
      screenshotCaptureInFlight = false;
      let focusChanged;
      let screenshotUploads = 0;
      fetchWithBackoff = async (url) => {
        if (String(url).includes('/screenshot')) screenshotUploads += 1;
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      };
      const screenshotResult = await captureAndSendScreenshot({
        reason: 'authority-focus-race',
        queryActiveTab: async () => [{
          id: 4101,
          windowId: 41,
          active: true,
          url: 'https://focus-race.example/',
          title: 'Focus race',
        }],
        captureVisibleTab: async () => {
          focusChanged?.(42);
          return 'data:image/jpeg;base64,focus-race';
        },
        subscribeTabActivation: () => () => {},
        subscribeTabUpdate: () => () => {},
        subscribeWindowFocus: (listener) => {
          focusChanged = listener;
          return () => { focusChanged = null; };
        },
      });
      fetchWithBackoff = originalFetchWithBackoff;

      // An auth-context cancellation can happen before screenshot authority
      // locals are snapshotted. That early exit must not reference the later
      // policy `const`s (which would turn the expected cancellation into a
      // temporal-dead-zone ReferenceError).
      const originalCaptureAuthenticatedContext = captureAuthenticatedContext;
      let earlyScreenshotAuthCancellationHandled = false;
      try {
        captureAuthenticatedContext = (reason) => {
          if (String(reason) === 'screenshot:auth-context-unavailable') {
            throw authContextSuperseded('screenshot auth-context fixture');
          }
          return originalCaptureAuthenticatedContext(reason);
        };
        const earlyCancellationResult = await captureAndSendScreenshot({
          reason: 'auth-context-unavailable',
        });
        earlyScreenshotAuthCancellationHandled = earlyCancellationResult === undefined;
      } finally {
        captureAuthenticatedContext = originalCaptureAuthenticatedContext;
      }

      // Tracking-window authority changes are capture boundaries even within
      // one immutable auth context. Every gap/class transition requests an
      // immediate image; a same-authority renewal does not. A late A denial
      // cannot revoke B, and adopting B actively aborts A's upload signal.
      const trackingWindowAuth = installIdentity('tracking-window');
      adoptLicenseState(true, 'active', trackingWindowAuth);
      trackingState = TRACKING_STATES.ACTIVE;
      adoptNegotiatedProtocolState({
        serverProtocolVersion: 3,
        acceptedCapabilities: [
          'scopedAuthorityChecksV1',
          'screenshotTrackingWindowLeaseV1',
          'screenshotObservationLeaseV1',
        ],
      }, trackingWindowAuth);
      const trackingPolicy = (authority, captureAllowed = true) => ({
        mode: 'tracking_window_lease',
        captureAllowed,
        expiresInSeconds: captureAllowed ? 90 : 0,
        serverTime: new Date().toISOString(),
        authority,
      });
      const captureBeforeTrackingTransitions = captureAndSendScreenshot;
      const trackingImmediateReasons = [];
      captureAndSendScreenshot = async ({ reason } = {}) => {
        trackingImmediateReasons.push(reason);
        return { status: 'tracking-transition-test-double' };
      };
      const gapAuthority = { kind: 'student_session', controlRevision: 70 };
      const classAAuthority = {
        kind: 'teaching_session',
        teachingSessionId: 'tracking-class-a',
        controlRevision: 71,
      };
      const classBAuthority = {
        kind: 'teaching_session',
        teachingSessionId: 'tracking-class-b',
        controlRevision: 72,
      };
      adoptScreenshotPolicy(trackingPolicy(gapAuthority), trackingWindowAuth);
      const generationAfterGapAuthority = screenshotPolicyGeneration;
      adoptScreenshotPolicy(trackingPolicy(classAAuthority), trackingWindowAuth);
      const generationAfterClassAAuthority = screenshotPolicyGeneration;
      const classAAuthorityScope = screenshotPolicyState.authorityScope;
      adoptScreenshotPolicy(trackingPolicy(classBAuthority), trackingWindowAuth);
      const generationAfterClassBAuthority = screenshotPolicyGeneration;
      const classBAuthorityScope = screenshotPolicyState.authorityScope;
      adoptScreenshotPolicy(trackingPolicy(classBAuthority), trackingWindowAuth);
      const generationAfterClassBRenewal = screenshotPolicyGeneration;
      const trackingImmediateCountAfterRenewal = trackingImmediateReasons.length;
      captureAndSendScreenshot = captureBeforeTrackingTransitions;

      applyServerScreenshotPolicyDenial(
        trackingPolicy(classAAuthority, false),
        trackingWindowAuth,
        {
          capturedAuthorityScope: classAAuthorityScope,
          requestStartedAt: Date.now(),
          responseReceivedAt: Date.now(),
        },
      );
      const lateClassADenialPreservedClassB = ambientScreenshotAllowed(trackingWindowAuth)
        && screenshotPolicyState.authorityScope === classBAuthorityScope;

      const uploadClassAAuthority = {
        kind: 'teaching_session',
        teachingSessionId: 'tracking-upload-a',
        controlRevision: 73,
      };
      const uploadClassBAuthority = {
        kind: 'teaching_session',
        teachingSessionId: 'tracking-upload-b',
        controlRevision: 74,
      };
      screenshotCaptureInFlight = true;
      adoptScreenshotPolicy(trackingPolicy(uploadClassAAuthority), trackingWindowAuth);
      screenshotCaptureInFlight = false;
      screenshotImmediateCapturePending = false;
      const originalFetch = globalThis.fetch;
      let resolveTrackingUploadStarted;
      const trackingUploadStarted = new Promise((resolve) => {
        resolveTrackingUploadStarted = resolve;
      });
      let classAUploadSignal = null;
      globalThis.fetch = async (url, init = {}) => {
        if (!String(url).includes('/screenshot')) return originalFetch(url, init);
        classAUploadSignal = init.signal;
        resolveTrackingUploadStarted();
        return new Promise((resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const error = new Error('tracking authority superseded');
            error.name = 'AbortError';
            reject(error);
          }, { once: true });
        });
      };
      lastScreenshotAttemptAt = 0;
      const screenshotErrorBeforeClassAUpload = lastScreenshotError;
      const classAUploadPromise = captureAndSendScreenshot({
        reason: 'tracking-authority-upload-abort',
        queryActiveTab: async () => [{
          id: 4190,
          windowId: 41,
          active: true,
          url: 'https://tracking-a.example/',
          title: 'Tracking A',
        }],
        captureVisibleTab: async () => 'data:image/jpeg;base64,dHJhY2tpbmctYQ==',
        subscribeTabActivation: () => () => {},
        subscribeTabUpdate: () => () => {},
        subscribeWindowFocus: () => () => {},
      });
      await trackingUploadStarted;
      adoptScreenshotPolicy(trackingPolicy(uploadClassBAuthority), trackingWindowAuth);
      screenshotImmediateCapturePending = false;
      const classAUploadResult = await classAUploadPromise;
      const classAUploadSignalAborted = classAUploadSignal?.aborted === true;
      const classAUploadDidNotRecordError = lastScreenshotError === screenshotErrorBeforeClassAUpload;
      globalThis.fetch = originalFetch;

      let trackingWindowUpload = null;
      fetchWithBackoff = async (url, init = {}) => {
        trackingWindowUpload = {
          url: String(url),
          body: JSON.parse(String(init.body || '{}')),
        };
        return new Response('{}', { status: 200 });
      };
      lastScreenshotAttemptAt = 0;
      await captureAndSendScreenshot({
        reason: 'tracking-window-upload-envelope',
        queryActiveTab: async () => [{
          id: 4191,
          windowId: 41,
          active: true,
          url: 'https://tracking-b.example/',
          title: 'Tracking B',
        }],
        captureVisibleTab: async () => 'data:image/jpeg;base64,dHJhY2tpbmctYg==',
        subscribeTabActivation: () => () => {},
        subscribeTabUpdate: () => () => {},
        subscribeWindowFocus: () => () => {},
      });
      fetchWithBackoff = originalFetchWithBackoff;
      observedByTeacher = false;
      scheduleScreenshotCapture(true);
      const noDashboardScreenshotAlarm = await chrome.alarms.get(SCREENSHOT_ALARM_NAME);
      const noDashboardFiveMinuteCaptureSlots = noDashboardScreenshotAlarm
        ? Math.floor(5 / Number(noDashboardScreenshotAlarm.periodInMinutes || 0))
        : 0;

      // A queued expiry event for A (or an earlier renewal) cannot pause B's
      // newer, still-valid exact lease.
      const leaseAuthA = installIdentity('lease-alarm-a');
      adoptNegotiatedProtocolState({
        serverProtocolVersion: 3,
        acceptedCapabilities: ['scopedAuthorityChecksV1', 'screenshotObservationLeaseV1'],
      }, leaseAuthA);
      screenshotCaptureInFlight = true;
      const leaseAlarmStartedAt = Date.now();
      adoptScreenshotPolicy({
        mode: 'lease',
        observed: true,
        expiresInSeconds: 30,
        serverTime: new Date(leaseAlarmStartedAt).toISOString(),
      }, leaseAuthA, {
        requestStartedAt: leaseAlarmStartedAt,
        responseReceivedAt: leaseAlarmStartedAt,
      });
      const retiredLeaseExpiry = screenshotPolicyState.expiresAt;
      const leaseAuthB = installIdentity('lease-alarm-b');
      adoptNegotiatedProtocolState({
        serverProtocolVersion: 3,
        acceptedCapabilities: ['scopedAuthorityChecksV1', 'screenshotObservationLeaseV1'],
      }, leaseAuthB);
      const renewedAt = Date.now();
      adoptScreenshotPolicy({
        mode: 'lease',
        observed: true,
        expiresInSeconds: 60,
        serverTime: new Date(renewedAt).toISOString(),
      }, leaseAuthB, {
        requestStartedAt: renewedAt,
        responseReceivedAt: renewedAt,
      });
      const currentLeaseBeforeStaleAlarm = { ...screenshotPolicyState };
      const staleLeaseAlarmExpiredCurrent = handleScreenshotLeaseExpiryAlarm({
        scheduledTime: retiredLeaseExpiry,
      }, renewedAt + 1);
      const currentLeaseAfterStaleAlarm = { ...screenshotPolicyState };
      screenshotCaptureInFlight = false;

      // WebSocket max-tab enforcement is linearized with identity adoption.
      // The first captured A resource may finish once Chrome accepted its
      // removal, but B cannot commit until that operation settles and no
      // later/reused target ID may be touched.
      const tabLimitAuthA = installIdentity('tab-limit-a');
      const tabLimitMessage = {
        type: 'auth-success',
        studentId: tabLimitAuthA.studentId,
        studentSessionId: tabLimitAuthA.studentSessionId,
        settings: { maxTabsPerStudent: 1 },
      };
      const tabLimitTabs = [
        { id: 4701, windowId: 47, url: 'https://tab-limit-a.example/one', pendingUrl: '' },
        { id: 4702, windowId: 47, url: 'https://tab-limit-a.example/two', pendingUrl: '' },
        { id: 4703, windowId: 47, url: 'https://tab-limit-a.example/three', pendingUrl: '' },
      ];
      const tabLimitRemoved = [];
      const tabLimitNotifications = [];
      let tabLimitBCommitStarted = false;
      let tabLimitBCommitPromise = null;
      let releaseTabLimitRemoval;
      let tabLimitRemovalStarted;
      const tabLimitRemovalReady = new Promise((resolve) => { tabLimitRemovalStarted = resolve; });
      const tabLimitRemovalGate = new Promise((resolve) => { releaseTabLimitRemoval = resolve; });
      const tabLimitPromise = applyWebSocketTabLimitSetting(tabLimitMessage, tabLimitAuthA, {
        queryTabs: async () => tabLimitTabs,
        getTab: async (tabId) => tabLimitTabs.find((tab) => tab.id === tabId),
        removeTab: async (tabId) => {
          tabLimitRemoved.push(tabId);
          tabLimitRemovalStarted();
          advanceStudentAuthMutationGeneration();
          tabLimitBCommitPromise = enqueueStudentAuthMutation(async () => {
            tabLimitBCommitStarted = true;
            return commitIdentity('tab-limit-b');
          });
          await tabLimitRemovalGate;
        },
        notify: async (notification) => { tabLimitNotifications.push(notification); },
      }).then(
        () => 'completed',
        (error) => error?.code || error?.message || 'error',
      );
      await tabLimitRemovalReady;
      const tabLimitBCommittedBeforeRemovalSettled = tabLimitBCommitStarted;
      releaseTabLimitRemoval();
      const tabLimitOutcome = await tabLimitPromise;
      const tabLimitAuthB = await tabLimitBCommitPromise;

      // Every Live View error notification uses the same exact auth-bound
      // inventory as teacher messages. A late notification create is removed
      // when A retires, and the raw offscreen error body is never displayed.
      const liveErrorAuthA = installIdentity('live-error-a');
      activeLiveViewNegotiationId = 'live-error-negotiation-a';
      activeLiveViewTeachingSessionId = 'live-error-session-a';
      activeLiveViewContext = liveViewContextFor(
        liveErrorAuthA,
        activeLiveViewNegotiationId,
        activeLiveViewTeachingSessionId,
      );
      const liveErrorMessage = {
        type: 'CAPTURE_ERROR',
        error: 'https://private.example/student-a?token=secret response body',
        ...liveViewOffscreenIdentity(activeLiveViewContext),
      };
      const originalSafeNotify = safeNotify;
      const originalClearAuthBoundNotification = clearAuthBoundNotification;
      const liveErrorVisibleNotifications = new Set();
      const liveErrorNotificationPayloads = [];
      let releaseLiveErrorNotification;
      let liveErrorNotificationStarted;
      const liveErrorNotificationReady = new Promise((resolve) => {
        liveErrorNotificationStarted = resolve;
      });
      const liveErrorNotificationGate = new Promise((resolve) => {
        releaseLiveErrorNotification = resolve;
      });
      authBoundNotificationInventoryReconciled = true;
      safeNotify = async (opts) => {
        liveErrorNotificationPayloads.push({ title: opts.title, message: opts.message });
        liveErrorNotificationStarted();
        await liveErrorNotificationGate;
        liveErrorVisibleNotifications.add(opts.notificationId);
      };
      clearAuthBoundNotification = async (notificationId) => {
        liveErrorVisibleNotifications.delete(notificationId);
        return true;
      };
      const liveErrorPromise = handleOffscreenMessage(liveErrorMessage);
      await liveErrorNotificationReady;
      advanceStudentAuthMutationGeneration();
      releaseLiveErrorNotification();
      const liveErrorResult = await liveErrorPromise;
      safeNotify = originalSafeNotify;
      clearAuthBoundNotification = originalClearAuthBoundNotification;

      // A delayed socket close owns only the exact transport/Live View tuple
      // it captured. Its completion cannot erase the stop authority for a
      // newer B stream that started while the offscreen close was pending.
      const disconnectAuthA = installIdentity('disconnect-live-a');
      wsConnectionGeneration = Math.max(wsConnectionGeneration + 1, 51);
      wsTransportIdentity = {
        connectionGeneration: wsConnectionGeneration,
        authContextId: disconnectAuthA.authContextId,
        serverOrigin: disconnectAuthA.serverOrigin,
      };
      activeLiveViewNegotiationId = 'disconnect-live-negotiation-a';
      activeLiveViewTeachingSessionId = 'disconnect-live-session-a';
      activeLiveViewContext = liveViewContextFor(
        disconnectAuthA,
        activeLiveViewNegotiationId,
        activeLiveViewTeachingSessionId,
      );
      const originalSendToOffscreen = sendToOffscreen;
      let disconnectCloseCount = 0;
      let releaseDisconnectClose;
      let disconnectCloseStarted;
      const disconnectCloseReady = new Promise((resolve) => { disconnectCloseStarted = resolve; });
      const disconnectCloseGate = new Promise((resolve) => { releaseDisconnectClose = resolve; });
      sendToOffscreen = async (message) => {
        if (message?.type === 'WS_CLOSE' && disconnectCloseCount++ === 0) {
          disconnectCloseStarted();
          await disconnectCloseGate;
        }
        return { success: true };
      };
      const disconnectPromise = disconnectWebSocket();
      await boundedWait(disconnectCloseReady, 'retired websocket close');
      const disconnectAuthB = installIdentity('disconnect-live-b');
      wsConnectionGeneration += 1;
      const disconnectTransportB = {
        connectionGeneration: wsConnectionGeneration,
        authContextId: disconnectAuthB.authContextId,
        serverOrigin: disconnectAuthB.serverOrigin,
      };
      wsTransportIdentity = disconnectTransportB;
      activeLiveViewNegotiationId = 'disconnect-live-negotiation-b';
      activeLiveViewTeachingSessionId = 'disconnect-live-session-b';
      const disconnectLiveContextB = liveViewContextFor(
        disconnectAuthB,
        activeLiveViewNegotiationId,
        activeLiveViewTeachingSessionId,
      );
      activeLiveViewContext = disconnectLiveContextB;
      releaseDisconnectClose();
      await disconnectPromise;
      sendToOffscreen = originalSendToOffscreen;
      const disconnectLiveAfterClose = {
        negotiationId: activeLiveViewNegotiationId,
        teachingSessionId: activeLiveViewTeachingSessionId,
        contextIsCurrentB: activeLiveViewContext === disconnectLiveContextB,
        transportIsCurrentB: wsTransportIdentity === disconnectTransportB,
      };

      // A rejected WS_CLOSE is fail-private for its exact owner. The worker
      // cannot discard stop authority while an offscreen stream may survive.
      const disconnectFailureAuth = installIdentity('disconnect-failure');
      wsConnectionGeneration += 1;
      wsTransportIdentity = {
        connectionGeneration: wsConnectionGeneration,
        authContextId: disconnectFailureAuth.authContextId,
        serverOrigin: disconnectFailureAuth.serverOrigin,
      };
      activeLiveViewNegotiationId = 'disconnect-failure-negotiation';
      activeLiveViewTeachingSessionId = 'disconnect-failure-session';
      activeLiveViewContext = liveViewContextFor(
        disconnectFailureAuth,
        activeLiveViewNegotiationId,
        activeLiveViewTeachingSessionId,
      );
      const originalCloseOffscreenDocumentFailPrivate = closeOffscreenDocumentFailPrivate;
      let disconnectFailPrivateCloseCount = 0;
      closeOffscreenDocumentFailPrivate = async () => {
        disconnectFailPrivateCloseCount += 1;
      };
      sendToOffscreen = async (message) => {
        if (message?.type === 'WS_CLOSE') throw new Error('forced close rejection');
        return { success: true };
      };
      await disconnectWebSocket({ authContext: disconnectFailureAuth });
      const disconnectFailureState = {
        liveContext: activeLiveViewContext,
        transportIdentity: wsTransportIdentity,
      };
      sendToOffscreen = originalSendToOffscreen;
      closeOffscreenDocumentFailPrivate = originalCloseOffscreenDocumentFailPrivate;

      // Every offscreen close participates in one tracked flight. A replacement
      // ensure cannot create/authenticate its proxy until the retired document
      // has actually finished closing.
      const originalChromeOffscreenClose = chrome.offscreen.closeDocument;
      const originalChromeOffscreenCreate = chrome.offscreen.createDocument;
      const originalHasOffscreenDocument = hasOffscreenDocument;
      let releaseTrackedOffscreenClose;
      let trackedOffscreenCloseStarted;
      const trackedOffscreenCloseReady = new Promise((resolve) => {
        trackedOffscreenCloseStarted = resolve;
      });
      const trackedOffscreenCloseGate = new Promise((resolve) => {
        releaseTrackedOffscreenClose = resolve;
      });
      let trackedOffscreenCreateCount = 0;
      chrome.offscreen.closeDocument = () => {
        trackedOffscreenCloseStarted();
        return trackedOffscreenCloseGate;
      };
      chrome.offscreen.createDocument = async () => { trackedOffscreenCreateCount += 1; };
      hasOffscreenDocument = async () => false;
      offscreenCloseInFlight = null;
      const trackedOffscreenClosePromise = closeOffscreenDocument();
      await boundedWait(trackedOffscreenCloseReady, 'tracked offscreen close');
      const trackedOffscreenEnsurePromise = ensureOffscreenDocument();
      await new Promise((resolve) => setTimeout(resolve, 25));
      const trackedOffscreenCreateBeforeClose = trackedOffscreenCreateCount;
      releaseTrackedOffscreenClose();
      await trackedOffscreenClosePromise;
      await trackedOffscreenEnsurePromise;
      chrome.offscreen.closeDocument = originalChromeOffscreenClose;
      chrome.offscreen.createDocument = originalChromeOffscreenCreate;
      hasOffscreenDocument = originalHasOffscreenDocument;

      // Tracking-OFF cleanup carries the initiating A authority through the
      // delayed disconnect. B can commit after the state transition, but the
      // stale A continuation cannot close B's transport or Live View.
      const trackingOffAuthA = installIdentity('tracking-off-a');
      adoptLicenseState(false, 'inactive', trackingOffAuthA);
      trackingState = TRACKING_STATES.ACTIVE;
      wsConnectionGeneration += 1;
      wsTransportIdentity = {
        connectionGeneration: wsConnectionGeneration,
        authContextId: trackingOffAuthA.authContextId,
        serverOrigin: trackingOffAuthA.serverOrigin,
      };
      activeLiveViewNegotiationId = 'tracking-off-negotiation-a';
      activeLiveViewTeachingSessionId = 'tracking-off-session-a';
      activeLiveViewContext = liveViewContextFor(
        trackingOffAuthA,
        activeLiveViewNegotiationId,
        activeLiveViewTeachingSessionId,
      );
      const originalDisconnectWebSocket = disconnectWebSocket;
      let releaseTrackingOffDisconnect;
      let trackingOffDisconnectStarted;
      const trackingOffDisconnectReady = new Promise((resolve) => {
        trackingOffDisconnectStarted = resolve;
      });
      const trackingOffDisconnectGate = new Promise((resolve) => {
        releaseTrackingOffDisconnect = resolve;
      });
      disconnectWebSocket = async (options) => {
        trackingOffDisconnectStarted();
        await trackingOffDisconnectGate;
        return originalDisconnectWebSocket(options);
      };
      const trackingOffPromise = updateTrackingState('authority-tracking-off').then(
        () => 'completed',
        (error) => error?.code || error?.message || 'error',
      );
      await boundedWait(trackingOffDisconnectReady, 'tracking-OFF disconnect');
      const trackingOffAuthB = installIdentity('tracking-off-b');
      wsConnectionGeneration += 1;
      const trackingOffTransportB = {
        connectionGeneration: wsConnectionGeneration,
        authContextId: trackingOffAuthB.authContextId,
        serverOrigin: trackingOffAuthB.serverOrigin,
      };
      wsTransportIdentity = trackingOffTransportB;
      activeLiveViewNegotiationId = 'tracking-off-negotiation-b';
      activeLiveViewTeachingSessionId = 'tracking-off-session-b';
      const trackingOffContextB = liveViewContextFor(
        trackingOffAuthB,
        activeLiveViewNegotiationId,
        activeLiveViewTeachingSessionId,
      );
      activeLiveViewContext = trackingOffContextB;
      releaseTrackingOffDisconnect();
      const trackingOffOutcome = await trackingOffPromise;
      disconnectWebSocket = originalDisconnectWebSocket;
      const trackingOffState = {
        contextIsCurrentB: activeLiveViewContext === trackingOffContextB,
        transportIsCurrentB: wsTransportIdentity === trackingOffTransportB,
        negotiationId: activeLiveViewNegotiationId,
      };

      // A rejected STOP_SHARE closes the captured document while it is still
      // current. If B replaces the tuple before rejection settles, B remains
      // untouched and the stale A cleanup cannot close B's proxy.
      const stopFailureAuth = installIdentity('stop-failure');
      activeLiveViewNegotiationId = 'stop-failure-negotiation';
      activeLiveViewTeachingSessionId = 'stop-failure-session';
      activeLiveViewContext = liveViewContextFor(
        stopFailureAuth,
        activeLiveViewNegotiationId,
        activeLiveViewTeachingSessionId,
      );
      let stopFailPrivateCloseCount = 0;
      closeOffscreenDocumentFailPrivate = async () => {
        stopFailPrivateCloseCount += 1;
      };
      sendToOffscreen = async (message) => {
        if (message?.type === 'STOP_SHARE') throw new Error('forced stop rejection');
        return { success: true };
      };
      await stopScreenShare({
        notifyServer: false,
        reason: 'authority-test-stop-failure',
        expectedContext: activeLiveViewContext,
      });
      const stopFailureContextAfter = activeLiveViewContext;

      const stopReplacementAuthA = installIdentity('stop-replacement-a');
      activeLiveViewNegotiationId = 'stop-replacement-negotiation-a';
      activeLiveViewTeachingSessionId = 'stop-replacement-session-a';
      const stopReplacementContextA = liveViewContextFor(
        stopReplacementAuthA,
        activeLiveViewNegotiationId,
        activeLiveViewTeachingSessionId,
      );
      activeLiveViewContext = stopReplacementContextA;
      let releaseStopRejection;
      let stopRejectionStarted;
      const stopRejectionReady = new Promise((resolve) => { stopRejectionStarted = resolve; });
      const stopRejectionGate = new Promise((resolve) => { releaseStopRejection = resolve; });
      sendToOffscreen = async (message) => {
        if (message?.type === 'STOP_SHARE') {
          stopRejectionStarted();
          await stopRejectionGate;
          throw new Error('delayed stop rejection');
        }
        return { success: true };
      };
      const stopReplacementPromise = handleStopScreenShare(
        'stop-replacement-negotiation-a',
      );
      await boundedWait(stopRejectionReady, 'delayed stop rejection');
      const stopReplacementAuthB = installIdentity('stop-replacement-b');
      activeLiveViewNegotiationId = 'stop-replacement-negotiation-b';
      activeLiveViewTeachingSessionId = 'stop-replacement-session-b';
      const stopReplacementContextB = liveViewContextFor(
        stopReplacementAuthB,
        activeLiveViewNegotiationId,
        activeLiveViewTeachingSessionId,
      );
      activeLiveViewContext = stopReplacementContextB;
      releaseStopRejection();
      await stopReplacementPromise;
      const stopReplacementState = {
        contextIsCurrentB: activeLiveViewContext === stopReplacementContextB,
        negotiationId: activeLiveViewNegotiationId,
        teachingSessionId: activeLiveViewTeachingSessionId,
      };
      sendToOffscreen = originalSendToOffscreen;
      closeOffscreenDocumentFailPrivate = originalCloseOffscreenDocumentFailPrivate;

      // A replacement request revalidates A after stopping its prior tuple.
      // If B adopts while that stop is pending, A cannot overwrite B's live
      // owner or invoke capture for its retired negotiation.
      const liveReplacementAuthA = installIdentity('live-replacement-a');
      installCommandAuthority(liveReplacementAuthA, 'live-replacement-session-a');
      wsConnectionGeneration += 1;
      const liveReplacementGenerationA = wsConnectionGeneration;
      wsTransportIdentity = {
        connectionGeneration: liveReplacementGenerationA,
        authContextId: liveReplacementAuthA.authContextId,
        serverOrigin: liveReplacementAuthA.serverOrigin,
      };
      activeLiveViewNegotiationId = 'live-replacement-old-a';
      activeLiveViewTeachingSessionId = 'live-replacement-session-a';
      activeLiveViewContext = liveViewContextFor(
        liveReplacementAuthA,
        activeLiveViewNegotiationId,
        activeLiveViewTeachingSessionId,
      );
      const originalStopScreenShare = stopScreenShare;
      const originalHandleScreenShareRequest = handleScreenShareRequest;
      let releaseLiveReplacementStop;
      let liveReplacementStopStarted;
      const liveReplacementStopReady = new Promise((resolve) => {
        liveReplacementStopStarted = resolve;
      });
      const liveReplacementStopGate = new Promise((resolve) => {
        releaseLiveReplacementStop = resolve;
      });
      let retiredLiveReplacementStarts = 0;
      stopScreenShare = async () => {
        liveReplacementStopStarted();
        await liveReplacementStopGate;
      };
      handleScreenShareRequest = async () => { retiredLiveReplacementStarts += 1; };
      const liveReplacementFrame = {
        type: 'request-stream',
        studentId: liveReplacementAuthA.studentId,
        studentSessionId: liveReplacementAuthA.studentSessionId,
        negotiationId: 'live-replacement-new-a',
        teachingSessionId: 'live-replacement-session-a',
        mode: 'auto',
        setupExpiresAt: Date.now() + 60_000,
        expiresAt: Date.now() + 10 * 60_000,
      };
      const liveReplacementPromise = handleWsMessage(
        JSON.stringify(liveReplacementFrame),
        liveReplacementGenerationA,
        liveReplacementAuthA,
      ).then(
        () => 'completed',
        (error) => error?.code || error?.message || 'error',
      );
      await boundedWait(liveReplacementStopReady, 'Live View replacement stop');
      const liveReplacementAuthB = installIdentity('live-replacement-b');
      installCommandAuthority(liveReplacementAuthB, 'live-replacement-session-b');
      wsConnectionGeneration = liveReplacementGenerationA + 1;
      wsTransportIdentity = {
        connectionGeneration: wsConnectionGeneration,
        authContextId: liveReplacementAuthB.authContextId,
        serverOrigin: liveReplacementAuthB.serverOrigin,
      };
      activeLiveViewNegotiationId = 'live-replacement-negotiation-b';
      activeLiveViewTeachingSessionId = 'live-replacement-session-b';
      const liveReplacementContextB = liveViewContextFor(
        liveReplacementAuthB,
        activeLiveViewNegotiationId,
        activeLiveViewTeachingSessionId,
      );
      activeLiveViewContext = liveReplacementContextB;
      releaseLiveReplacementStop();
      const liveReplacementOutcome = await liveReplacementPromise;
      stopScreenShare = originalStopScreenShare;
      handleScreenShareRequest = originalHandleScreenShareRequest;
      const liveReplacementState = {
        contextIsCurrentB: activeLiveViewContext === liveReplacementContextB,
        negotiationId: activeLiveViewNegotiationId,
        retiredStarts: retiredLiveReplacementStarts,
      };

      // START_SHARE can complete after its request context retires. The
      // cancellation path issues an exact STOP for A and leaves B's worker
      // owner untouched.
      const startCancelAuthA = installIdentity('start-cancel-a');
      activeLiveViewNegotiationId = 'start-cancel-negotiation-a';
      activeLiveViewTeachingSessionId = 'start-cancel-session-a';
      const startCancelContextA = liveViewContextFor(
        startCancelAuthA,
        activeLiveViewNegotiationId,
        activeLiveViewTeachingSessionId,
      );
      activeLiveViewContext = startCancelContextA;
      const originalFetchLiveViewIceConfiguration = fetchLiveViewIceConfiguration;
      const originalEnsureOffscreenDocument = ensureOffscreenDocument;
      const originalTabCaptureGetMediaStreamId = chrome.tabCapture.getMediaStreamId;
      const originalStartCancelTabsQuery = chrome.tabs.query;
      fetchLiveViewIceConfiguration = async () => ({
        iceServers: null,
        expiresAt: null,
        legacy: true,
      });
      ensureOffscreenDocument = async () => {};
      chrome.tabs.query = async () => [{ id: 4811, windowId: 48, active: true }];
      chrome.tabCapture.getMediaStreamId = async () => 'stream-id-a';
      let releaseStartCancel;
      let startCancelStarted;
      const startCancelReady = new Promise((resolve) => { startCancelStarted = resolve; });
      const startCancelGate = new Promise((resolve) => { releaseStartCancel = resolve; });
      const startCancelStops = [];
      sendToOffscreen = async (message) => {
        if (message?.type === 'START_SHARE') {
          startCancelStarted();
          await startCancelGate;
          return { success: true };
        }
        if (message?.type === 'STOP_SHARE') startCancelStops.push({ ...message });
        return { success: true };
      };
      const startCancelPromise = handleScreenShareRequest(
        'auto',
        'start-cancel-negotiation-a',
        'start-cancel-session-a',
        Date.now() + 60_000,
        Date.now() + 10 * 60_000,
      );
      await boundedWait(startCancelReady, 'Live View START response');
      const startCancelAuthB = installIdentity('start-cancel-b');
      activeLiveViewNegotiationId = 'start-cancel-negotiation-b';
      activeLiveViewTeachingSessionId = 'start-cancel-session-b';
      const startCancelContextB = liveViewContextFor(
        startCancelAuthB,
        activeLiveViewNegotiationId,
        activeLiveViewTeachingSessionId,
      );
      activeLiveViewContext = startCancelContextB;
      releaseStartCancel();
      await startCancelPromise;
      const startCancelState = {
        contextIsCurrentB: activeLiveViewContext === startCancelContextB,
        negotiationId: activeLiveViewNegotiationId,
      };
      sendToOffscreen = originalSendToOffscreen;
      fetchLiveViewIceConfiguration = originalFetchLiveViewIceConfiguration;
      ensureOffscreenDocument = originalEnsureOffscreenDocument;
      chrome.tabs.query = originalStartCancelTabsQuery;
      chrome.tabCapture.getMediaStreamId = originalTabCaptureGetMediaStreamId;

      // A socket-close continuation cannot clean up B's teacher broadcast or
      // Live View after identity and transport ownership move to B.
      const processCloseAuthA = installIdentity('process-close-a');
      wsConnectionGeneration += 1;
      const processCloseGeneration = wsConnectionGeneration;
      wsTransportIdentity = {
        connectionGeneration: processCloseGeneration,
        authContextId: processCloseAuthA.authContextId,
        serverOrigin: processCloseAuthA.serverOrigin,
      };
      teacherBroadcastActive = true;
      teacherBroadcastSessionId = 'process-close-broadcast-a';
      activeLiveViewNegotiationId = 'process-close-negotiation-a';
      activeLiveViewTeachingSessionId = 'process-close-session-a';
      activeLiveViewContext = liveViewContextFor(
        processCloseAuthA,
        activeLiveViewNegotiationId,
        activeLiveViewTeachingSessionId,
      );
      const originalCleanupTeacherBroadcast = cleanupTeacherBroadcast;
      let releaseProcessCloseCleanup;
      let processCloseCleanupStarted;
      const processCloseCleanupReady = new Promise((resolve) => {
        processCloseCleanupStarted = resolve;
      });
      const processCloseCleanupGate = new Promise((resolve) => {
        releaseProcessCloseCleanup = resolve;
      });
      cleanupTeacherBroadcast = async (...args) => {
        processCloseCleanupStarted();
        await processCloseCleanupGate;
        return originalCleanupTeacherBroadcast(...args);
      };
      const processClosePromise = processWsEvent(
        'close',
        null,
        processCloseGeneration,
        processCloseAuthA,
      ).then(
        () => 'completed',
        (error) => error?.code || error?.message || 'error',
      );
      await boundedWait(processCloseCleanupReady, 'WebSocket close broadcast cleanup');
      const processCloseAuthB = installIdentity('process-close-b');
      wsConnectionGeneration = processCloseGeneration + 1;
      wsConnected = true;
      wsTransportConnected = true;
      teacherBroadcastActive = true;
      teacherBroadcastSessionId = 'process-close-broadcast-b';
      activeLiveViewNegotiationId = 'process-close-negotiation-b';
      activeLiveViewTeachingSessionId = 'process-close-session-b';
      const processCloseContextB = liveViewContextFor(
        processCloseAuthB,
        activeLiveViewNegotiationId,
        activeLiveViewTeachingSessionId,
      );
      activeLiveViewContext = processCloseContextB;
      releaseProcessCloseCleanup();
      const processCloseOutcome = await processClosePromise;
      cleanupTeacherBroadcast = originalCleanupTeacherBroadcast;
      const processCloseState = {
        broadcastActive: teacherBroadcastActive,
        broadcastSessionId: teacherBroadcastSessionId,
        contextIsCurrentB: activeLiveViewContext === processCloseContextB,
        negotiationId: activeLiveViewNegotiationId,
      };

      // FAB lifecycle cleanup remains bound to A through overlay storage and
      // every content broadcast. A cannot resume a paused clear and relabel
      // its session/timer/poll state with B's content epoch.
      const fabLifecycleAuthA = installIdentity('fab-lifecycle-a');
      const originalFabClearClassroomOverlayState = clearClassroomOverlayState;
      const originalFabBroadcastToAllTabsForAuth = broadcastToAllTabsForAuth;
      const originalFabBroadcastToAllTabs = broadcastToAllTabs;
      let releaseFabOverlayClear;
      let fabOverlayClearStarted;
      const fabOverlayClearReady = new Promise((resolve) => { fabOverlayClearStarted = resolve; });
      const fabOverlayClearGate = new Promise((resolve) => { releaseFabOverlayClear = resolve; });
      const fabLifecycleBroadcasts = [];
      clearClassroomOverlayState = async (...args) => {
        fabOverlayClearStarted();
        await fabOverlayClearGate;
        return originalFabClearClassroomOverlayState(...args);
      };
      broadcastToAllTabsForAuth = async (type, data, ...args) => {
        fabLifecycleBroadcasts.push({ transport: 'auth', type, data });
        return undefined;
      };
      broadcastToAllTabs = async (type, data) => {
        fabLifecycleBroadcasts.push({ transport: 'legacy', type, data });
      };
      currentFabState = null;
      const fabLifecycleFrame = {
        ...commandEnvelope(fabLifecycleAuthA, 'fab-lifecycle-session-a'),
        schemaVersion: 1,
        revision: 7,
        lifecycleRevision: 7,
        activeSessionIds: ['fab-lifecycle-session-a'],
        teachingSessionId: 'fab-lifecycle-session-a',
        messagingEnabled: true,
        handRaisingEnabled: true,
        reason: 'session-started',
      };
      const fabLifecyclePromise = applyFabSettings(fabLifecycleFrame, {
        authContext: fabLifecycleAuthA,
        authorityEnvelope: fabLifecycleFrame,
      }).then(
        () => 'completed',
        (error) => error?.code || error?.message || 'error',
      );
      await boundedWait(fabOverlayClearReady, 'FAB lifecycle overlay clear');
      installIdentity('fab-lifecycle-b');
      releaseFabOverlayClear();
      const fabLifecycleOutcome = await fabLifecyclePromise;
      clearClassroomOverlayState = originalFabClearClassroomOverlayState;
      broadcastToAllTabsForAuth = originalFabBroadcastToAllTabsForAuth;
      broadcastToAllTabs = originalFabBroadcastToAllTabs;

      // A forced cleanup pass (including a durable retry alarm) removes an
      // unknown/retired A notification while preserving the current exact B
      // prefix. Signed-out cold-start cleanup still has no prefix to preserve.
      const notificationPreserveAuthB = installIdentity('notification-preserve-b');
      await authBoundNotificationCleanupPromise.catch(() => false);
      const notificationPreservePrefixB = authBoundNotificationPrefixForContext(
        notificationPreserveAuthB,
      );
      const retiredNotificationId = 'classpilot-message-auth-context-retired-a-private';
      const currentNotificationId = `${notificationPreservePrefixB}current-private`;
      const notificationInventory = new Set([
        retiredNotificationId,
        currentNotificationId,
      ]);
      const notificationClears = [];
      authBoundNotificationInventoryReconciled = true;
      authBoundNotificationCleanupInFlight = null;
      authBoundNotificationCleanupRetryAt = 0;
      const notificationForcedCleanupOutcome = await clearAllAuthBoundTeacherMessageNotifications({
        readInventory: async () => ({
          ok: true,
          notifications: Object.fromEntries(
            [...notificationInventory].map((notificationId) => [notificationId, {}]),
          ),
        }),
        clearNotification: async (notificationId) => {
          notificationClears.push(notificationId);
          notificationInventory.delete(notificationId);
          return { ok: true, cleared: true };
        },
      });
      const notificationAfterForcedCleanup = [...notificationInventory];

      // If a B-owned reconciliation pauses after capturing B's prefix and C
      // becomes current, the old pass must neither clear C nor declare success.
      // The transition chains a fresh pass that removes B and preserves C.
      const notificationOwnerRaceAuthB = installIdentity('notification-owner-race-b');
      await authBoundNotificationCleanupPromise.catch(() => false);
      const notificationOwnerRacePrefixB = authBoundNotificationPrefixForContext(
        notificationOwnerRaceAuthB,
      );
      const notificationOwnerRaceIdB = `${notificationOwnerRacePrefixB}private-b`;
      const notificationOwnerRaceInventory = new Set([notificationOwnerRaceIdB]);
      const originalReadAllNotificationsBounded = readAllNotificationsBounded;
      const originalClearAuthBoundNotificationOutcome = clearAuthBoundNotificationOutcome;
      let releaseNotificationOwnerRead;
      let notificationOwnerReadStarted;
      const notificationOwnerReadReady = new Promise((resolve) => {
        notificationOwnerReadStarted = resolve;
      });
      const notificationOwnerReadGate = new Promise((resolve) => {
        releaseNotificationOwnerRead = resolve;
      });
      let notificationOwnerReadCount = 0;
      readAllNotificationsBounded = async () => {
        notificationOwnerReadCount += 1;
        if (notificationOwnerReadCount === 1) {
          notificationOwnerReadStarted();
          await notificationOwnerReadGate;
        }
        return {
          ok: true,
          notifications: Object.fromEntries(
            [...notificationOwnerRaceInventory].map((notificationId) => [notificationId, {}]),
          ),
        };
      };
      clearAuthBoundNotificationOutcome = async (notificationId) => {
        notificationOwnerRaceInventory.delete(notificationId);
        return { ok: true, cleared: true };
      };
      authBoundNotificationInventoryReconciled = false;
      authBoundNotificationCleanupInFlight = null;
      authBoundNotificationCleanupRetryAt = 0;
      const notificationOwnerFirstPass = ensureAuthBoundNotificationInventory({ force: true });
      await boundedWait(notificationOwnerReadReady, 'notification owner inventory read');
      const notificationOwnerRaceAuthC = installIdentity('notification-owner-race-c');
      const notificationOwnerRaceIdC = `${authBoundNotificationPrefixForContext(
        notificationOwnerRaceAuthC,
      )}private-c`;
      notificationOwnerRaceInventory.add(notificationOwnerRaceIdC);
      releaseNotificationOwnerRead();
      const notificationOwnerFirstOutcome = await notificationOwnerFirstPass;
      const notificationOwnerFollowupOutcome = await authBoundNotificationCleanupPromise;
      readAllNotificationsBounded = originalReadAllNotificationsBounded;
      clearAuthBoundNotificationOutcome = originalClearAuthBoundNotificationOutcome;
      const notificationOwnerRaceAfterCleanup = [...notificationOwnerRaceInventory];

      // A delayed content camera update cannot become B's heartbeat state.
      const cameraAuthA = installIdentity('camera-a');
      const staleCameraContext = studentMessageContextFor(cameraAuthA);
      installIdentity('camera-b');
      const staleCameraResult = handleCameraStatusChanged({
        type: 'camera-status-changed',
        cameraActive: true,
        studentMessageContext: staleCameraContext,
      }, { tab: { id: 4201 } });

      // Tab-cache refresh captures the exact authority before querying. A's
      // delayed URL/title inventory cannot be rebound to B after the query.
      const tabCacheAuthA = installIdentity('tab-cache-a');
      const originalTabsQuery = chrome.tabs.query;
      let releaseTabCacheQuery;
      let tabCacheQueryStarted;
      const tabCacheQueryReady = new Promise((resolve) => { tabCacheQueryStarted = resolve; });
      const tabCacheQueryGate = new Promise((resolve) => { releaseTabCacheQuery = resolve; });
      chrome.tabs.query = async () => {
        tabCacheQueryStarted();
        await tabCacheQueryGate;
        return [{
          id: 4251,
          windowId: 42,
          url: 'https://student-a.private.example/path',
          title: 'Student A private tab',
        }];
      };
      const tabCacheRefreshPromise = refreshTabCache(tabCacheAuthA);
      await boundedWait(tabCacheQueryReady, 'tab-cache query');
      const tabCacheAuthB = installIdentity('tab-cache-b');
      releaseTabCacheQuery();
      const staleTabCacheRefreshResult = await tabCacheRefreshPromise;
      chrome.tabs.query = originalTabsQuery;
      const tabCacheAfterTransition = {
        tabs: [...lastKnownTabs],
        binding: lastKnownTabsAuthBinding,
        bBinding: monitoringEventAuthBindingForContext(tabCacheAuthB),
      };

      // Classroom ACK state is exact-auth-bound. Equal numeric revisions for
      // two students cannot make B report A as applied.
      const ackAuthA = installIdentity('ack-a');
      sendClassroomStateAck({ revision: 7, teachingSessionId: 'ack-session-a' }, 'applied', undefined, ackAuthA);
      const ackAuthB = installIdentity('ack-b');
      let heartbeatBody = null;
      fetchWithBackoff = async (url, init = {}) => {
        if (String(url).includes('/api/device/heartbeat')) {
          heartbeatBody = JSON.parse(String(init.body || '{}'));
          return new Response(JSON.stringify({
            studentId: ackAuthB.studentId,
            studentSessionId: ackAuthB.studentSessionId,
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      };
      heartbeatInFlight = false;
      await sendHeartbeat('authority-ack-binding');
      fetchWithBackoff = originalFetchWithBackoff;

      // A created tab is removed if authority changes during the later query
      // or opaque-snapshot awaits. No A URL is rehydrated for B.
      const openAuth = installIdentity('open-query-a');
      installCommandAuthority(openAuth);
      const openedTabRemovals = [];
      const openResult = await handleRemoteControl({
        type: 'open-tab',
        data: { url: 'https://open-race.example/private' },
      }, commandEnvelope(openAuth), {
        createTab: async () => ({ id: 4301 }),
        queryTabs: async () => {
          advanceStudentAuthMutationGeneration();
          return [{ id: 4301, url: 'https://open-race.example/private' }];
        },
        removeTab: async (tabId) => { openedTabRemovals.push(tabId); },
      });

      // Close-all never broadens after retirement: the first A target may
      // finish before B commits, but no later captured target is touched.
      const closeAllAuth = installIdentity('close-all-a');
      installCommandAuthority(closeAllAuth);
      const closeAllRemoved = [];
      const closeAllResult = await handleRemoteControl({
        type: 'close-tabs',
        data: { closeAll: true },
      }, commandEnvelope(closeAllAuth), {
        queryTabs: async () => [
          { id: 4401, url: 'https://close-a.example/' },
          { id: 4402, url: 'https://close-b.example/' },
        ],
        removeTab: async (tabId) => {
          closeAllRemoved.push(tabId);
          if (tabId === 4401) advanceStudentAuthMutationGeneration();
        },
        refreshTabCache: async () => {},
      });

      // Exact selected-tab close carries the frozen V2 tuple and cannot finish
      // its completion path after that exact authority is retired.
      const exactCloseAuth = installIdentity('exact-close-a');
      installCommandAuthority(exactCloseAuth);
      observeStudentControlRevision(5, exactCloseAuth, 'exact close race fixture');
      adoptNegotiatedProtocolState({
        serverProtocolVersion: 3,
        acceptedCapabilities: ['scopedAuthorityChecksV1', 'exactTabCloseV2'],
      }, exactCloseAuth);
      const exactBinding = {
        bindingVersion: 2,
        schoolId: exactCloseAuth.schoolId,
        deviceId: exactCloseAuth.deviceId,
        studentId: exactCloseAuth.studentId,
        studentSessionId: exactCloseAuth.studentSessionId,
        controlRevision: 5,
      };
      const originalResolveExactTabRefs = resolveExactTabRefs;
      const originalCloseExactTabTargets = closeExactTabTargets;
      let exactCloseCount = 0;
      resolveExactTabRefs = async (refs, revision) => ({
        revision,
        targets: [{
          tabRef: refs[0],
          tabId: 4451,
          expectedUrl: 'https://exact-close-a.example/',
          expectedTitle: 'Exact A',
        }],
      });
      closeExactTabTargets = async () => {
        exactCloseCount += 1;
        advanceStudentAuthMutationGeneration();
      };
      const exactCloseResult = await handleRemoteControl({
        type: 'close-tab',
        exactBinding,
        data: { tabRef: 'exact-tab-a', tabSnapshotRevision: 5 },
      }, {
        ...commandEnvelope(exactCloseAuth),
        exactBinding,
      }, { refreshTabCache: async () => {} });
      resolveExactTabRefs = originalResolveExactTabRefs;
      closeExactTabTargets = originalCloseExactTabTargets;

      // Stateful legacy work is fenced at the awaited content broadcast and
      // cancellation leaves no retired attention state for the next identity.
      const statefulAuth = installIdentity('stateful-a');
      installCommandAuthority(statefulAuth);
      const originalBroadcastToAllTabsForAuth = broadcastToAllTabsForAuth;
      let releaseAttention;
      let attentionStarted;
      const attentionReady = new Promise((resolve) => { attentionStarted = resolve; });
      const attentionGate = new Promise((resolve) => { releaseAttention = resolve; });
      broadcastToAllTabsForAuth = async (type) => {
        if (type === 'attention-mode') {
          attentionStarted();
          await attentionGate;
        }
      };
      const statefulPromise = handleRemoteControl({
        type: 'attention-mode',
        data: { active: true, message: 'Private A attention' },
      }, commandEnvelope(statefulAuth));
      await attentionReady;
      advanceStudentAuthMutationGeneration();
      releaseAttention();
      const statefulResult = await statefulPromise;
      broadcastToAllTabsForAuth = originalBroadcastToAllTabsForAuth;

      // Snapshot application is canceled after DNR completion but before the
      // next authority can commit; retired runtime/storage is removed.
      const snapshotAuth = installIdentity('snapshot-dnr-a');
      installCommandAuthority(snapshotAuth);
      const originalComposeAllManagedDynamicRules = composeAllManagedDynamicRules;
      let releaseSnapshotDnr;
      let snapshotDnrStarted;
      const snapshotDnrReady = new Promise((resolve) => { snapshotDnrStarted = resolve; });
      const snapshotDnrGate = new Promise((resolve) => { releaseSnapshotDnr = resolve; });
      composeAllManagedDynamicRules = async () => {
        await originalComposeAllManagedDynamicRules();
        snapshotDnrStarted();
        await snapshotDnrGate;
      };
      const snapshotState = {
        schemaVersion: 1,
        revision: 2,
        teachingSessionId: 'teaching-session-race',
        receivedAt: Date.now(),
        hardExpiresAt: Date.now() + 60_000,
        restrictions: {
          attentionMode: { active: true, message: 'Snapshot A only' },
        },
      };
      const snapshotPromise = handleRemoteControl({
        type: 'attention-mode',
        data: { active: true },
      }, {
        ...commandEnvelope(snapshotAuth),
        classroomState: snapshotState,
      });
      await snapshotDnrReady;
      advanceStudentAuthMutationGeneration();
      releaseSnapshotDnr();
      const snapshotResult = await snapshotPromise;
      composeAllManagedDynamicRules = originalComposeAllManagedDynamicRules;
      const snapshotStorage = await chrome.storage.local.get(CLASSROOM_STATE_STORAGE_KEY);

      // Legacy persistence that commits just before retirement is physically
      // removed by the same owner-bound cleanup.
      const legacyStorageAuth = installIdentity('legacy-storage-a');
      installCommandAuthority(legacyStorageAuth);
      const originalKvSet = kv.set;
      let releaseLegacyStorage;
      let legacyStorageStarted;
      const legacyStorageReady = new Promise((resolve) => { legacyStorageStarted = resolve; });
      const legacyStorageGate = new Promise((resolve) => { releaseLegacyStorage = resolve; });
      kv.set = async (value) => {
        await originalKvSet(value);
        if (Object.prototype.hasOwnProperty.call(value || {}, CLASSROOM_STATE_STORAGE_KEY)) {
          legacyStorageStarted();
          await legacyStorageGate;
        }
      };
      broadcastToAllTabsForAuth = async () => {};
      const legacyStoragePromise = handleRemoteControl({
        type: 'attention-mode',
        data: { active: true, message: 'Legacy A only' },
      }, commandEnvelope(legacyStorageAuth));
      await legacyStorageReady;
      advanceStudentAuthMutationGeneration();
      releaseLegacyStorage();
      const legacyStorageResult = await legacyStoragePromise;
      kv.set = originalKvSet;
      broadcastToAllTabsForAuth = originalBroadcastToAllTabsForAuth;
      const legacyStorage = await chrome.storage.local.get(CLASSROOM_STATE_STORAGE_KEY);

      // A reconciliation retry alarm captures one exact state/owner and runs
      // behind the auth queue. B adoption cannot commit while A is paused at
      // its tab query, and retired cleanup cannot erase B's later state.
      const reconcileAlarmAuthA = installIdentity('reconcile-alarm-a');
      currentClassroomState = {
        schemaVersion: 1,
        revision: 9,
        teachingSessionId: 'reconcile-alarm-session-a',
        receivedAt: Date.now(),
        hardExpiresAt: Date.now() + 60_000,
        restrictions: RuntimeCore.emptyRestrictions(),
      };
      classroomRuntimeOwner = createClassroomRuntimeOwner(reconcileAlarmAuthA, 9);
      const reconcileAlarmCapturedState = currentClassroomState;
      let releaseReconcileAlarmQuery;
      let reconcileAlarmQueryStarted;
      const reconcileAlarmQueryReady = new Promise((resolve) => { reconcileAlarmQueryStarted = resolve; });
      const reconcileAlarmQueryGate = new Promise((resolve) => { releaseReconcileAlarmQuery = resolve; });
      let reconcileAlarmBCommitStarted = false;
      let reconcileAlarmBCommitPromise = null;
      const reconcileAlarmPromise = handleClassroomStateReconcileAlarm({
        authContext: reconcileAlarmAuthA,
        restorePromise: Promise.resolve(),
        reconcile: async (state, options) => {
          if (state !== reconcileAlarmCapturedState) {
            throw new Error('Classroom reconcile alarm changed state ownership');
          }
          reconcileAlarmQueryStarted();
          await reconcileAlarmQueryGate;
          options.assertCurrent('classroom reconciliation test query');
          return true;
        },
      }).then(
        () => 'completed',
        (error) => error?.code || error?.message || 'error',
      );
      await boundedWait(Promise.race([
        reconcileAlarmQueryReady,
        reconcileAlarmPromise.then((outcome) => {
          throw new Error(`Classroom reconcile alarm exited before query: ${outcome}`);
        }),
      ]), 'classroom reconcile alarm query');
      advanceStudentAuthMutationGeneration();
      reconcileAlarmBCommitPromise = enqueueStudentAuthMutation(async () => {
        reconcileAlarmBCommitStarted = true;
        const authContext = commitIdentity('reconcile-alarm-b');
        currentClassroomState = {
          schemaVersion: 1,
          revision: 9,
          teachingSessionId: 'reconcile-alarm-session-b',
          receivedAt: Date.now(),
          hardExpiresAt: Date.now() + 60_000,
          restrictions: RuntimeCore.emptyRestrictions(),
        };
        classroomRuntimeOwner = createClassroomRuntimeOwner(authContext, 9);
        return authContext;
      });
      const reconcileAlarmBCommittedBeforeQuerySettled = reconcileAlarmBCommitStarted;
      releaseReconcileAlarmQuery();
      const reconcileAlarmOutcome = await reconcileAlarmPromise;
      await reconcileAlarmBCommitPromise;
      const reconcileAlarmFinalSessionId = currentClassroomState?.teachingSessionId || null;

      // A wake-time corrupt/expired recovery never falls through after its
      // captured authority retires. B's exact snapshot writer waits on the
      // auth queue and its durable state survives the stale A continuation.
      const wakeRecoveryAuthA = installIdentity('wake-recovery-a');
      const wakeRecoveryStateA = {
        schemaVersion: 1,
        revision: 12,
        teachingSessionId: 'wake-recovery-session-a',
        receivedAt: Date.now() - 120_000,
        hardExpiresAt: Date.now() - 60_000,
        restrictions: RuntimeCore.emptyRestrictions(),
      };
      await kv.set({
        [CLASSROOM_STATE_STORAGE_KEY]: wakeRecoveryStateA,
        [CLASSROOM_STATE_FAILSAFE_EXPIRY_KEY]: Date.now() - 1,
      });
      await setManualAuthState({
        [CLASSROOM_STATE_STUDENT_BINDING_KEY]: wakeRecoveryAuthA.studentId,
      });
      const originalWakeRecoveryLocalGet = rawLocalKv.get;
      let releaseWakeRecoveryRead;
      let wakeRecoveryReadStarted;
      const wakeRecoveryReadReady = new Promise((resolve) => { wakeRecoveryReadStarted = resolve; });
      const wakeRecoveryReadGate = new Promise((resolve) => { releaseWakeRecoveryRead = resolve; });
      let wakeRecoveryReadPaused = false;
      rawLocalKv.get = async (keys) => {
        const value = await originalWakeRecoveryLocalGet(keys);
        if (
          !wakeRecoveryReadPaused
          && Array.isArray(keys)
          && keys.includes(CLASSROOM_STATE_STORAGE_KEY)
        ) {
          wakeRecoveryReadPaused = true;
          wakeRecoveryReadStarted();
          await wakeRecoveryReadGate;
        }
        return value;
      };
      const wakeRecoveryPromise = recoverInvalidStoredClassroomState(
        wakeRecoveryStateA,
        wakeRecoveryAuthA.studentId,
        Date.now() - 1,
        wakeRecoveryAuthA,
      ).then(
        () => 'completed',
        (error) => error?.code || error?.message || 'error',
      );
      await boundedWait(wakeRecoveryReadReady, 'wake classroom recovery read');
      advanceStudentAuthMutationGeneration();
      let wakeRecoveryBCommitStarted = false;
      const wakeRecoveryStateB = {
        schemaVersion: 1,
        revision: 12,
        teachingSessionId: 'wake-recovery-session-b',
        receivedAt: Date.now(),
        hardExpiresAt: Date.now() + 60_000,
        restrictions: RuntimeCore.emptyRestrictions(),
      };
      const wakeRecoveryBCommitPromise = enqueueStudentAuthMutation(async () => {
        wakeRecoveryBCommitStarted = true;
        const authContext = commitIdentity('wake-recovery-b');
        currentClassroomState = wakeRecoveryStateB;
        await kv.set({
          [CLASSROOM_STATE_STORAGE_KEY]: wakeRecoveryStateB,
          [CLASSROOM_STATE_FAILSAFE_EXPIRY_KEY]: wakeRecoveryStateB.hardExpiresAt,
        });
        await setManualAuthState({
          [CLASSROOM_STATE_STUDENT_BINDING_KEY]: authContext.studentId,
        });
        return authContext;
      });
      const wakeRecoveryBCommittedBeforeASettled = wakeRecoveryBCommitStarted;
      releaseWakeRecoveryRead();
      const wakeRecoveryOutcome = await wakeRecoveryPromise;
      const wakeRecoveryAuthB = await wakeRecoveryBCommitPromise;
      rawLocalKv.get = originalWakeRecoveryLocalGet;
      const wakeRecoveryStorage = await getStoredAuthState([
        CLASSROOM_STATE_STORAGE_KEY,
        CLASSROOM_STATE_STUDENT_BINDING_KEY,
      ]);

      // An A overlay read cannot conditionally delete a B overlay written
      // after authority changes. Both the read/cleanup and B writer serialize
      // behind the exact auth mutation queue.
      const overlayAuthA = installIdentity('overlay-a');
      currentFabState = {
        schemaVersion: 1,
        revision: 1,
        ownershipRevision: 1,
        teachingSessionId: 'overlay-session-a',
        activeSessionIds: ['overlay-session-a'],
      };
      const overlayBindingA = fabIdentityBinding();
      await kv.set({
        [CLASSROOM_OVERLAY_STORAGE_KEY]: {
          schemaVersion: 1,
          binding: overlayBindingA,
          timer: null,
          poll: null,
          updatedAt: 1,
        },
      });
      const originalKvGet = kv.get;
      let releaseOverlayRead;
      let overlayReadStarted;
      const overlayReadReady = new Promise((resolve) => { overlayReadStarted = resolve; });
      const overlayReadGate = new Promise((resolve) => { releaseOverlayRead = resolve; });
      let overlayReadPaused = false;
      kv.get = async (keys) => {
        const stored = await originalKvGet(keys);
        if (!overlayReadPaused && keys === CLASSROOM_OVERLAY_STORAGE_KEY) {
          overlayReadPaused = true;
          overlayReadStarted();
          await overlayReadGate;
        }
        return stored;
      };
      const overlayReadPromise = getRestorableClassroomOverlayState({
        authContext: overlayAuthA,
        expectedBinding: overlayBindingA,
      }).then(
        () => 'completed',
        (error) => error?.code || 'error',
      );
      await boundedWait(overlayReadReady, 'classroom overlay read');
      advanceStudentAuthMutationGeneration();
      const overlayBCommitPromise = enqueueStudentAuthMutation(async () => {
        const authContext = commitIdentity('overlay-b');
        currentFabState = {
          schemaVersion: 1,
          revision: 2,
          ownershipRevision: 2,
          teachingSessionId: 'overlay-session-b',
          activeSessionIds: ['overlay-session-b'],
        };
        const binding = fabIdentityBinding();
        await originalKvSet({
          [CLASSROOM_OVERLAY_STORAGE_KEY]: {
            schemaVersion: 1,
            binding,
            timer: null,
            poll: {
              pollId: 'poll-b',
              teachingSessionId: 'overlay-session-b',
              expiresAt: Date.now() + 60_000,
            },
            updatedAt: 2,
          },
        });
        return { authContext, binding };
      });
      releaseOverlayRead();
      const overlayReadOutcome = await overlayReadPromise;
      const overlayBCommit = await overlayBCommitPromise;
      kv.get = originalKvGet;
      const overlayAfterTransition = (await kv.get(CLASSROOM_OVERLAY_STORAGE_KEY))[
        CLASSROOM_OVERLAY_STORAGE_KEY
      ];

      // An expired A check-in alarm cannot remove the B prompt or clear B's
      // newly armed expiry. The stale read and both writers share auth order.
      const checkInAuthA = installIdentity('check-in-a');
      const checkInBindingA = monitoringEventAuthBindingForContext(checkInAuthA);
      const checkInNow = Date.now();
      await durableLocalKv.set({
        [PENDING_CHECK_IN_KEY]: {
          question: 'A only',
          options: [],
          timestamp: checkInNow - 10_000,
          expiresAt: checkInNow - 1_000,
          binding: checkInBindingA,
        },
      });
      const originalDurableGet = durableLocalKv.get;
      let releaseCheckInRead;
      let checkInReadStarted;
      const checkInReadReady = new Promise((resolve) => { checkInReadStarted = resolve; });
      const checkInReadGate = new Promise((resolve) => { releaseCheckInRead = resolve; });
      let checkInReadPaused = false;
      durableLocalKv.get = async (keys) => {
        const stored = await originalDurableGet(keys);
        if (!checkInReadPaused && keys === PENDING_CHECK_IN_KEY) {
          checkInReadPaused = true;
          checkInReadStarted();
          await checkInReadGate;
        }
        return stored;
      };
      const checkInExpiryPromise = expirePendingCheckIn({
        scheduledTime: checkInNow - 999,
      }, { now: checkInNow });
      await boundedWait(checkInReadReady, 'pending check-in expiry read');
      advanceStudentAuthMutationGeneration();
      const checkInBExpiresAt = checkInNow + 120_000;
      const checkInBCommitPromise = enqueueStudentAuthMutation(async () => {
        const authContext = commitIdentity('check-in-b');
        const binding = monitoringEventAuthBindingForContext(authContext);
        await originalKvSet({
          [PENDING_CHECK_IN_KEY]: {
            question: 'B current',
            options: ['yes'],
            timestamp: checkInNow + 1,
            expiresAt: checkInBExpiresAt,
            binding,
          },
        });
        chrome.alarms.create(PENDING_CHECK_IN_EXPIRY_ALARM, { when: checkInBExpiresAt + 1 });
        return { authContext, binding };
      });
      releaseCheckInRead();
      await checkInExpiryPromise;
      const checkInBCommit = await checkInBCommitPromise;
      durableLocalKv.get = originalDurableGet;
      const checkInAfterTransition = (await durableLocalKv.get(PENDING_CHECK_IN_KEY))[
        PENDING_CHECK_IN_KEY
      ];
      const checkInAlarmAfterTransition = await chrome.alarms.get(PENDING_CHECK_IN_EXPIRY_ALARM);

      // A managed/profile heartbeat invalidation owns the full auth clear. A
      // B commit queued while durable invalidation storage is paused cannot be
      // wiped by the retired A cleanup.
      const heartbeatInvalidAuthA = installIdentity('heartbeat-invalid-a');
      const originalDurableSet = durableLocalKv.set;
      let releaseHeartbeatInvalidation;
      let heartbeatInvalidationStarted;
      const heartbeatInvalidationReady = new Promise((resolve) => {
        heartbeatInvalidationStarted = resolve;
      });
      const heartbeatInvalidationGate = new Promise((resolve) => {
        releaseHeartbeatInvalidation = resolve;
      });
      let heartbeatInvalidationPaused = false;
      durableLocalKv.set = async (value) => {
        const result = await originalDurableSet(value);
        if (!heartbeatInvalidationPaused && value?.[STUDENT_AUTH_INVALIDATING_KEY] === true) {
          heartbeatInvalidationPaused = true;
          heartbeatInvalidationStarted();
          await heartbeatInvalidationGate;
        }
        return result;
      };
      const heartbeatInvalidationPromise = invalidateStudentTokenFromHeartbeat(
        heartbeatInvalidAuthA,
        'authority-race',
        { scheduleRegistration: false },
      );
      await boundedWait(heartbeatInvalidationReady, 'heartbeat invalidation storage');
      advanceStudentAuthMutationGeneration();
      let heartbeatInvalidBCommitStarted = false;
      const heartbeatInvalidBCommitPromise = enqueueStudentAuthMutation(async () => {
        heartbeatInvalidBCommitStarted = true;
        const authContext = commitIdentity('heartbeat-invalid-b');
        await originalDurableSet({
          studentToken: authContext.studentToken,
          registered: true,
          [MESSAGE_INBOX_STORAGE_KEY]: [{ id: 'message-b', message: 'B current' }],
        });
        return authContext;
      });
      const heartbeatInvalidBCommittedBeforeClearSettled = heartbeatInvalidBCommitStarted;
      releaseHeartbeatInvalidation();
      await heartbeatInvalidationPromise;
      const heartbeatInvalidAuthB = await heartbeatInvalidBCommitPromise;
      durableLocalKv.set = originalDurableSet;
      const heartbeatInvalidStorage = await durableLocalKv.get([
        'studentToken',
        'registered',
        MESSAGE_INBOX_STORAGE_KEY,
      ]);

      // Monitoring state persistence is auth-serialized. A write that settles
      // after retirement is removed before B commits; B's later exact-scoped
      // state survives both the stale continuation and worker storage reads.
      const monitoringAuthA = installIdentity('monitoring-a');
      trackingState = TRACKING_STATES.ACTIVE;
      persistedMonitoringState = { state: TRACKING_STATES.ACTIVE, changedAt: 1, reason: 'fixture' };
      persistedMonitoringStateScope = monitoringEventAuthBindingForContext(monitoringAuthA);
      const originalMonitoringKvSet = kv.set;
      let releaseMonitoringWrite;
      let monitoringWriteStarted;
      const monitoringWriteReady = new Promise((resolve) => { monitoringWriteStarted = resolve; });
      const monitoringWriteGate = new Promise((resolve) => { releaseMonitoringWrite = resolve; });
      let monitoringWritePaused = false;
      kv.set = async (value) => {
        const result = await originalMonitoringKvSet(value);
        if (!monitoringWritePaused && value?.[MONITORING_STATE_STORAGE_KEY]) {
          monitoringWritePaused = true;
          monitoringWriteStarted();
          await monitoringWriteGate;
        }
        return result;
      };
      const monitoringTransitionPromise = transitionTrackingState(
        TRACKING_STATES.IDLE,
        'authority-race-a',
        { authContext: monitoringAuthA },
      ).then(
        () => 'completed',
        (error) => error?.code || 'error',
      );
      await boundedWait(monitoringWriteReady, 'monitoring state write');
      advanceStudentAuthMutationGeneration();
      let monitoringBCommitStarted = false;
      const monitoringBCommitPromise = enqueueStudentAuthMutation(async () => {
        monitoringBCommitStarted = true;
        const authContext = commitIdentity('monitoring-b');
        await transitionTrackingState(TRACKING_STATES.ACTIVE, 'authority-race-b', {
          authContext,
          authMutationHeld: true,
        });
        return authContext;
      });
      const monitoringBCommittedBeforeWriteSettled = monitoringBCommitStarted;
      releaseMonitoringWrite();
      const monitoringTransitionOutcome = await monitoringTransitionPromise;
      const monitoringAuthB = await monitoringBCommitPromise;
      kv.set = originalMonitoringKvSet;
      const monitoringStorage = await kv.get([
        MONITORING_STATE_STORAGE_KEY,
        MONITORING_STATE_SCOPE_KEY,
      ]);

      // Wrong-scope school settings are conditionally removed under the auth
      // queue. If B commits while A's cache read is paused, A cannot delete B's
      // newly written exact cache. With no exact cache and a failed fetch, the
      // tracking decision remains fail-private OFF.
      const settingsAuthA = installIdentity('settings-a');
      await originalKvSet({
        [SCHOOL_SETTINGS_CACHE_KEY]: { enableTrackingHours: false },
        [SCHOOL_SETTINGS_FETCHED_AT_KEY]: 11,
        [SCHOOL_SETTINGS_SCOPE_KEY]: 'https://retired.example|school-retired',
      });
      const originalSettingsKvGet = kv.get;
      let releaseSettingsRead;
      let settingsReadStarted;
      const settingsReadReady = new Promise((resolve) => { settingsReadStarted = resolve; });
      const settingsReadGate = new Promise((resolve) => { releaseSettingsRead = resolve; });
      let settingsReadPaused = false;
      kv.get = async (keys) => {
        const stored = await originalSettingsKvGet(keys);
        if (
          !settingsReadPaused
          && Array.isArray(keys)
          && keys.includes(SCHOOL_SETTINGS_CACHE_KEY)
        ) {
          settingsReadPaused = true;
          settingsReadStarted();
          await settingsReadGate;
        }
        return stored;
      };
      const settingsReadPromise = loadCachedSchoolSettings({ authContext: settingsAuthA }).then(
        () => 'completed',
        (error) => error?.code || 'error',
      );
      await boundedWait(settingsReadReady, 'school settings cache read');
      advanceStudentAuthMutationGeneration();
      let settingsBCommitStarted = false;
      const settingsBCommitPromise = enqueueStudentAuthMutation(async () => {
        settingsBCommitStarted = true;
        const authContext = commitIdentity('settings-b');
        const scope = schoolPolicyScopeForAuthContext(authContext);
        const settings = { enableTrackingHours: false, afterHoursMode: 'off' };
        await originalKvSet({
          [SCHOOL_SETTINGS_CACHE_KEY]: settings,
          [SCHOOL_SETTINGS_FETCHED_AT_KEY]: 22,
          [SCHOOL_SETTINGS_SCOPE_KEY]: scope,
        });
        schoolSettings = settings;
        schoolSettingsFetchedAt = 22;
        schoolSettingsScope = scope;
        return { authContext, scope };
      });
      const settingsBCommittedBeforeReadSettled = settingsBCommitStarted;
      releaseSettingsRead();
      const settingsReadOutcome = await settingsReadPromise;
      const settingsBCommit = await settingsBCommitPromise;
      kv.get = originalSettingsKvGet;
      const settingsStorage = await kv.get([
        SCHOOL_SETTINGS_CACHE_KEY,
        SCHOOL_SETTINGS_FETCHED_AT_KEY,
        SCHOOL_SETTINGS_SCOPE_KEY,
      ]);

      const settingsColdAuth = installIdentity('settings-cold');
      await kv.remove([
        SCHOOL_SETTINGS_CACHE_KEY,
        SCHOOL_SETTINGS_FETCHED_AT_KEY,
        SCHOOL_SETTINGS_SCOPE_KEY,
      ]);
      schoolSettings = null;
      schoolSettingsFetchedAt = 0;
      schoolSettingsScope = null;
      const originalSettingsFetchWithBackoff = fetchWithBackoff;
      fetchWithBackoff = async () => { throw new Error('settings unavailable'); };
      const settingsColdRefresh = await refreshSchoolSettings({
        force: true,
        authContext: settingsColdAuth,
      });
      const settingsColdTrackingState = determineTrackingState();
      fetchWithBackoff = originalSettingsFetchWithBackoff;

      // A global retry flight cannot consume B's one-shot alarm. When A's
      // abort-insensitive transmission settles after retirement, the exact B
      // pass is chained immediately and drains B well before retention expiry.
      const chatFlushAuthA = installIdentity('chat-flush-a');
      adoptNegotiatedProtocolState({
        serverProtocolVersion: 3,
        acceptedCapabilities: ['studentChatIdempotencyV1'],
      }, chatFlushAuthA);
      currentFabState = null;
      currentClassroomState = {
        schemaVersion: 1,
        revision: 1,
        teachingSessionId: 'chat-flush-session-a',
        receivedAt: Date.now(),
        hardExpiresAt: Date.now() + 60_000,
        restrictions: RuntimeCore.emptyRestrictions(),
      };
      await persistStudentChatEntry({
        clientMessageId: 'chat-flush-message-a',
        message: 'retired A body',
        sessionId: 'chat-flush-session-a',
        queuedAt: Date.now(),
        status: 'retrying',
      }, chatFlushAuthA);
      const originalChatFlushFetch = fetchWithBackoff;
      let releaseChatFlushA;
      let chatFlushAStarted;
      const chatFlushAReady = new Promise((resolve) => { chatFlushAStarted = resolve; });
      const chatFlushAGate = new Promise((resolve) => { releaseChatFlushA = resolve; });
      const chatFlushRequestIds = [];
      fetchWithBackoff = async (url, init = {}, options = {}) => {
        if (String(url).includes('/api/student/send-message')) {
          const body = JSON.parse(String(init.body || '{}'));
          chatFlushRequestIds.push(body.clientMessageId || 'legacy');
          if (body.clientMessageId === 'chat-flush-message-a') {
            chatFlushAStarted();
            await chatFlushAGate;
          }
          return new Response(JSON.stringify({
            delivered: true,
            clientMessageId: body.clientMessageId,
            messageId: `server-${body.clientMessageId}`,
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return originalChatFlushFetch(url, init, options);
      };
      const chatFlushAPromise = flushStudentChatOutbox();
      await boundedWait(chatFlushAReady, 'retired student chat retry');
      const chatFlushAuthB = installIdentity('chat-flush-b');
      adoptNegotiatedProtocolState({
        serverProtocolVersion: 3,
        acceptedCapabilities: ['studentChatIdempotencyV1'],
      }, chatFlushAuthB);
      currentFabState = null;
      currentClassroomState = {
        schemaVersion: 1,
        revision: 1,
        teachingSessionId: 'chat-flush-session-b',
        receivedAt: Date.now(),
        hardExpiresAt: Date.now() + 60_000,
        restrictions: RuntimeCore.emptyRestrictions(),
      };
      await persistStudentChatEntry({
        clientMessageId: 'chat-flush-message-b',
        message: 'current B body',
        sessionId: 'chat-flush-session-b',
        queuedAt: Date.now(),
        status: 'retrying',
      }, chatFlushAuthB);
      const chatFlushBAlarmPromise = compactStudentChatStorageOnly()
        .then(() => flushStudentChatOutbox());
      const chatFlushBRequestsBeforeASettled = chatFlushRequestIds
        .filter((messageId) => messageId === 'chat-flush-message-b').length;
      let chatFlushDurableHandoffDelay = Number.POSITIVE_INFINITY;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const alarm = await chrome.alarms.get(STUDENT_CHAT_FLUSH_ALARM);
        chatFlushDurableHandoffDelay = Number(alarm?.scheduledTime || 0) - Date.now();
        if (chatFlushDurableHandoffDelay > 0 && chatFlushDurableHandoffDelay <= 5_000) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      releaseChatFlushA();
      await Promise.all([chatFlushAPromise, chatFlushBAlarmPromise]);
      fetchWithBackoff = originalChatFlushFetch;
      const chatFlushStorage = await durableLocalKv.get([
        STUDENT_CHAT_OUTBOX_KEY,
        STUDENT_CHAT_OUTBOX_BINDING_KEY,
      ]);

      // Navigation and new-tab policy notifications are generated only from
      // the event-time exact context. A transition during notification setup
      // prevents the retired warning from becoming visible under B.
      const navigationAuth = installIdentity('navigation-a');
      screenLocked = true;
      lockedDomain = 'allowed-navigation.example';
      lockedUrl = 'https://allowed-navigation.example/';
      const originalUpdateTabForAuth = updateTabForAuth;
      const originalRemoveTabForAuth = removeTabForAuth;
      const originalNotifyNavigationBlockedForAuth = notifyNavigationBlockedForAuth;
      const navigationNotificationContexts = [];
      updateTabForAuth = async (_tabId, _update, authContext) => {
        assertAuthenticatedContextCurrent(authContext, 'navigation test redirect');
      };
      removeTabForAuth = async (_tabId, authContext) => {
        assertAuthenticatedContextCurrent(authContext, 'new-tab test removal');
      };
      let releaseNavigationNotification;
      let navigationNotificationStarted;
      const navigationNotificationReady = new Promise((resolve) => {
        navigationNotificationStarted = resolve;
      });
      const navigationNotificationGate = new Promise((resolve) => {
        releaseNavigationNotification = resolve;
      });
      notifyNavigationBlockedForAuth = async (authContext, notification, source) => {
        navigationNotificationContexts.push({
          authContextId: authContext.authContextId,
          title: notification.title,
          source,
        });
        navigationNotificationStarted();
        await navigationNotificationGate;
        return originalNotifyNavigationBlockedForAuth(authContext, notification, source);
      };
      const navigationPromise = handleBeforeNavigateForPolicy({
        frameId: 0,
        tabId: 4501,
        url: 'https://blocked-navigation.example/private',
      });
      await navigationNotificationReady;
      advanceStudentAuthMutationGeneration();
      releaseNavigationNotification();
      await navigationPromise;

      const createdTabAuth = installIdentity('created-tab-a');
      screenLocked = true;
      lockedDomain = 'allowed-created.example';
      lockedUrl = 'https://allowed-created.example/';
      let releaseCreatedNotification;
      let createdNotificationStarted;
      const createdNotificationReady = new Promise((resolve) => {
        createdNotificationStarted = resolve;
      });
      const createdNotificationGate = new Promise((resolve) => {
        releaseCreatedNotification = resolve;
      });
      notifyNavigationBlockedForAuth = async (authContext, notification, source) => {
        navigationNotificationContexts.push({
          authContextId: authContext.authContextId,
          title: notification.title,
          source,
        });
        createdNotificationStarted();
        await createdNotificationGate;
        return originalNotifyNavigationBlockedForAuth(authContext, notification, source);
      };
      const createdPolicyTab = {
        id: 4502,
        windowId: 45,
        active: true,
        url: 'https://created-tab-a.example/private',
        title: 'Created A',
      };
      const createdPromise = handleCreatedTabForPolicy(createdPolicyTab, {
        getTab: async () => ({ ...createdPolicyTab }),
      });
      await createdNotificationReady;
      advanceStudentAuthMutationGeneration();
      releaseCreatedNotification();
      await createdPromise;
      updateTabForAuth = originalUpdateTabForAuth;
      removeTabForAuth = originalRemoveTabForAuth;
      notifyNavigationBlockedForAuth = originalNotifyNavigationBlockedForAuth;

      // A replacement broadcast that loses authority while leaving cannot
      // install or join the newer A session after B begins its transition.
      const broadcastAuth = installIdentity('broadcast-a');
      const broadcastEnvelopeOne = {
        ...commandEnvelope(broadcastAuth),
        sessionId: 'broadcast-session-one',
      };
      const originalWsSend = wsSend;
      const broadcastFrames = [];
      wsConnected = true;
      wsSend = async (frame) => { broadcastFrames.push({ ...frame }); return true; };
      await handleBroadcastStart(broadcastEnvelopeOne, broadcastAuth);
      let releaseBroadcastLeave;
      let broadcastLeaveStarted;
      const broadcastLeaveReady = new Promise((resolve) => { broadcastLeaveStarted = resolve; });
      const broadcastLeaveGate = new Promise((resolve) => { releaseBroadcastLeave = resolve; });
      wsSend = async (frame) => {
        broadcastFrames.push({ ...frame });
        if (frame.type === 'broadcast-leave') {
          broadcastLeaveStarted();
          await broadcastLeaveGate;
        }
        return true;
      };
      const replacementPromise = handleBroadcastStart({
        ...commandEnvelope(broadcastAuth),
        sessionId: 'broadcast-session-two',
      }, broadcastAuth).then(
        () => 'completed',
        (error) => error?.code || 'error',
      );
      await broadcastLeaveReady;
      advanceStudentAuthMutationGeneration();
      releaseBroadcastLeave();
      const replacementOutcome = await replacementPromise;
      const offerAuth = installIdentity('broadcast-offer-a');
      wsConnected = true;
      wsSend = async (frame) => { broadcastFrames.push({ ...frame }); return true; };
      const offerEnvelope = {
        ...commandEnvelope(offerAuth),
        sessionId: 'broadcast-offer-session',
      };
      await handleBroadcastStart(offerEnvelope, offerAuth);
      await handleBroadcastOffer({
        ...offerEnvelope,
        sdp: { type: 'offer', sdp: 'v=0' },
      }, offerAuth);
      const broadcastOfferCleaned = !teacherBroadcastActive && teacherBroadcastSessionId === null;
      wsSend = originalWsSend;

      // Exercise the complete same-Chromebook privacy boundary, rather than
      // testing screenshot fencing and roster-bound recovery in isolation.
      // Alex's pixels have already been acquired when the shared-device clear
      // begins. The real manual PIN-login path must commit Bob with the exact
      // roster grant, abort Alex's request, and send only a newly captured Bob
      // image under Bob's immutable bearer/session and class authority.
      let manualHandoffScreenshot;
      const handoffOriginalFetch = globalThis.fetch;
      const handoffOriginalFetchWithBackoff = fetchWithBackoff;
      const handoffOriginalFastAuthGateEnabled = fastAuthGateEnabled;
      const handoffOriginalCheckLicenseStatus = checkLicenseStatus;
      const handoffOriginalInitializeAdaptiveTracking = initializeAdaptiveTracking;
      const handoffOriginalSharedSignInConfig = { ...sharedSignInLoginConfig };
      const handoffOriginalConfig = { ...CONFIG };
      const handoffOriginalTrackingState = trackingState;
      let resolveAlexUploadStarted;
      const alexUploadStarted = new Promise((resolve) => {
        resolveAlexUploadStarted = resolve;
      });
      let alexUploadRequest = null;
      let alexUploadAborted = false;
      let loginRecoveryHeader = null;
      let loginBody = null;
      const acceptedPostHandoffUploads = [];
      const requestHeader = (headers, name) => {
        if (headers instanceof Headers) return headers.get(name);
        const entry = Object.entries(headers || {}).find(
          ([key]) => key.toLowerCase() === name.toLowerCase(),
        );
        return entry?.[1] || null;
      };
      try {
        if (hasStudentAuth()) {
          const current = captureAuthenticatedContext('manual handoff screenshot fixture reset');
          await clearStudentAuth('manual_handoff_screenshot_fixture_reset', {
            notifyBackend: false,
            serverSessionEnded: true,
            pauseAutoRegistration: true,
            disconnectWebSocket: false,
            notifyAuthGateTabs: false,
            expectedAuthContext: current,
          });
        }
        await persistStudentSessionRecoveryState(emptyStudentSessionRecoveryState());
        resetLoginRosterRuntimeCache();

        const alexAuthContextId = generateAuthContextId();
        Object.assign(CONFIG, {
          serverUrl: 'https://school-pilot.net',
          schoolId: 'handoff-screenshot-school',
          schoolSlug: 'handoff-screenshot-school',
          enrollmentKey: 'handoff-screenshot-enrollment-key',
          deviceId: 'handoff-screenshot-device',
          studentToken: 'alex-handoff-bearer',
          activeStudentId: 'student-alex',
          activeStudentSessionId: 'alex-handoff-session',
          authContextId: alexAuthContextId,
          studentEmail: 'alex@example.edu',
          studentName: 'Alex Student',
          identitySource: 'manual_pin',
          manualLoginLastSeenAt: Date.now(),
          autoRegistrationPaused: false,
        });
        studentAuthInvalidating = false;
        studentAuthCommitPending = false;
        studentAuthCommitPendingGeneration = 0;
        fastAuthGateEnabled = false;
        sharedSignInLoginConfig = {
          ...sharedSignInLoginConfig,
          phase: 'ready',
          sharedSignInEnabled: true,
          loginMethod: 'name_pin',
          pinLoginEnabled: true,
          schoolId: CONFIG.schoolId,
        };
        checkLicenseStatus = async () => {};
        initializeAdaptiveTracking = async () => {};
        await setManualAuthState({
          authContextId: alexAuthContextId,
          studentToken: CONFIG.studentToken,
          activeStudentId: CONFIG.activeStudentId,
          activeStudentSessionId: CONFIG.activeStudentSessionId,
          studentEmail: CONFIG.studentEmail,
          studentName: CONFIG.studentName,
          registered: true,
          identitySource: CONFIG.identitySource,
          manualLoginLastSeenAt: CONFIG.manualLoginLastSeenAt,
          autoRegistrationPaused: false,
        });
        activateAuthenticatedContext(alexAuthContextId);
        const alexAuth = captureAuthenticatedContext('Alex screenshot handoff');
        await armStudentSessionRecovery({
          serverOrigin: alexAuth.serverOrigin,
          schoolId: alexAuth.schoolId,
          token: 'M'.repeat(43),
          authContextId: alexAuth.authContextId,
        });
        adoptLicenseState(true, 'active', alexAuth);
        trackingState = TRACKING_STATES.ACTIVE;
        adoptNegotiatedProtocolState({
          serverProtocolVersion: 3,
          acceptedCapabilities: [
            'scopedAuthorityChecksV1',
            'screenshotTrackingWindowLeaseV1',
            'screenshotObservationLeaseV1',
          ],
        }, alexAuth);
        const alexClassAuthority = {
          kind: 'teaching_session',
          teachingSessionId: 'handoff-class-alex',
          controlRevision: 901,
        };
        screenshotCaptureInFlight = true;
        adoptScreenshotPolicy({
          mode: 'tracking_window_lease',
          captureAllowed: true,
          expiresInSeconds: 90,
          serverTime: new Date().toISOString(),
          authority: alexClassAuthority,
        }, alexAuth);
        screenshotCaptureInFlight = false;
        screenshotImmediateCapturePending = false;

        globalThis.fetch = async (url) => {
          if (String(url).endsWith('/api/extension/session-release')) {
            // Preserve Alex's exact recovery record so the roster can issue a
            // one-shot grant for the same-device Bob handoff.
            return new Response('{}', {
              status: 503,
              headers: { 'content-type': 'application/json' },
            });
          }
          return new Response('{}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        };
        fetchWithBackoff = async (url, init = {}) => {
          const requestUrl = String(url);
          if (requestUrl.includes('/api/classpilot/device/screenshot')) {
            const request = {
              authorization: requestHeader(init.headers, 'Authorization'),
              body: JSON.parse(String(init.body || '{}')),
              binding: {
                studentId: CONFIG.activeStudentId,
                studentSessionId: CONFIG.activeStudentSessionId,
              },
            };
            if (request.authorization === 'Bearer alex-handoff-bearer') {
              alexUploadRequest = request;
              resolveAlexUploadStarted();
              return new Promise((resolve, reject) => {
                const rejectAborted = () => {
                  alexUploadAborted = true;
                  const error = new Error('Alex screenshot authority retired');
                  error.name = 'AbortError';
                  reject(error);
                };
                if (init.signal?.aborted) {
                  rejectAborted();
                  return;
                }
                init.signal?.addEventListener('abort', rejectAborted, { once: true });
              });
            }
            acceptedPostHandoffUploads.push(request);
            return new Response('{}', {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          if (requestUrl.includes('/api/extension/login-roster?')) {
            return new Response(JSON.stringify({
              loginMethod: 'name_pin',
              students: [{
                id: 'student-alex',
                name: 'Alex Student',
                hasPin: true,
                reclaimable: true,
              }, {
                id: 'student-bob',
                name: 'Bob Student',
                hasPin: true,
                reclaimable: false,
              }],
              grades: [{ value: '5', label: 'Grade 5' }],
            }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          if (requestUrl.endsWith('/api/extension/student-login')) {
            loginRecoveryHeader = requestHeader(init.headers, 'Authorization');
            loginBody = JSON.parse(String(init.body || '{}'));
            return new Response(JSON.stringify({
              schoolId: 'handoff-screenshot-school',
              studentToken: 'bob-handoff-bearer',
              studentSessionId: 'bob-handoff-session',
              sessionRecovery: { token: 'N'.repeat(43) },
              student: {
                id: 'student-bob',
                email: 'bob@example.edu',
                firstName: 'Bob',
                lastName: 'Student',
              },
            }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          return new Response('{}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        };

        lastScreenshotAttemptAt = 0;
        const alexCapturePromise = captureAndSendScreenshot({
          reason: 'manual-handoff-alex-in-flight',
          queryActiveTab: async () => [{
            id: 4901,
            windowId: 49,
            active: true,
            url: 'https://alex-handoff.example/private',
            title: 'Alex private pixels',
          }],
          captureVisibleTab: async () => 'data:image/jpeg;base64,YWxleC1wcml2YXRl',
          subscribeTabActivation: () => () => {},
          subscribeTabUpdate: () => () => {},
          subscribeWindowFocus: () => () => {},
        });
        await boundedWait(alexUploadStarted, 'Alex screenshot upload');
        const clearAlexPromise = clearStudentAuth('shared_device_student_handoff', {
          notifyBackend: false,
          pauseAutoRegistration: true,
          disconnectWebSocket: false,
          notifyAuthGateTabs: false,
          expectedAuthContext: alexAuth,
        });
        await boundedWait(clearAlexPromise, 'Alex local handoff clear');
        const alexCaptureResult = await boundedWait(
          alexCapturePromise,
          'retired Alex screenshot cancellation',
        );

        const roster = await fetchLoginRosterForGate({
          gradeLevel: '5',
          forceRefresh: true,
        });
        const login = await manualStudentLogin({
          mode: 'pin',
          studentId: 'student-bob',
          pin: '2468',
          recoveryGrantId: roster.recoveryGrantId,
        });
        await studentAuthMutationTail;
        await new Promise((resolve) => setTimeout(resolve, 0));
        const bobAuth = captureAuthenticatedContext('Bob screenshot handoff');
        adoptLicenseState(true, 'active', bobAuth);
        trackingState = TRACKING_STATES.ACTIVE;
        adoptNegotiatedProtocolState({
          serverProtocolVersion: 3,
          acceptedCapabilities: [
            'scopedAuthorityChecksV1',
            'screenshotTrackingWindowLeaseV1',
            'screenshotObservationLeaseV1',
          ],
        }, bobAuth);
        const bobClassAuthority = {
          kind: 'teaching_session',
          teachingSessionId: 'handoff-class-bob',
          controlRevision: 902,
        };
        screenshotCaptureInFlight = true;
        adoptScreenshotPolicy({
          mode: 'tracking_window_lease',
          captureAllowed: true,
          expiresInSeconds: 90,
          serverTime: new Date().toISOString(),
          authority: bobClassAuthority,
        }, bobAuth);
        screenshotCaptureInFlight = false;
        screenshotImmediateCapturePending = false;
        const alexCapturedAtMs = Date.parse(alexUploadRequest?.body?.capturedAt || '');
        while (Date.now() <= alexCapturedAtMs) {
          await new Promise((resolve) => setTimeout(resolve, 1));
        }
        lastScreenshotAttemptAt = 0;
        const bobCaptureResult = await captureAndSendScreenshot({
          reason: 'manual-handoff-bob-first-capture',
          queryActiveTab: async () => [{
            id: 4902,
            windowId: 49,
            active: true,
            url: 'https://bob-handoff.example/current',
            title: 'Bob current pixels',
          }],
          captureVisibleTab: async () => 'data:image/jpeg;base64,Ym9iLWN1cnJlbnQ=',
          subscribeTabActivation: () => () => {},
          subscribeTabUpdate: () => () => {},
          subscribeWindowFocus: () => () => {},
        });

        manualHandoffScreenshot = {
          alex: {
            authAborted: alexAuth.signal.aborted,
            uploadAborted: alexUploadAborted,
            captureResult: alexCaptureResult,
            request: alexUploadRequest,
          },
          rosterGrantId: roster.recoveryGrantId || null,
          loginSuccess: login.success === true,
          loginRecoveryHeader,
          loginBodyStudentId: loginBody?.studentId || null,
          bob: {
            auth: {
              studentId: bobAuth.studentId,
              studentSessionId: bobAuth.studentSessionId,
            },
            classAuthority: bobClassAuthority,
            captureResult: bobCaptureResult,
          },
          acceptedPostHandoffUploads,
        };
      } finally {
        if (hasStudentAuth()) {
          const current = captureAuthenticatedContext('manual handoff screenshot fixture cleanup');
          await clearStudentAuth('manual_handoff_screenshot_fixture_cleanup', {
            notifyBackend: false,
            serverSessionEnded: true,
            pauseAutoRegistration: true,
            disconnectWebSocket: false,
            notifyAuthGateTabs: false,
            expectedAuthContext: current,
          });
        }
        await persistStudentSessionRecoveryState(emptyStudentSessionRecoveryState());
        resetLoginRosterRuntimeCache();
        globalThis.fetch = handoffOriginalFetch;
        fetchWithBackoff = handoffOriginalFetchWithBackoff;
        fastAuthGateEnabled = handoffOriginalFastAuthGateEnabled;
        checkLicenseStatus = handoffOriginalCheckLicenseStatus;
        initializeAdaptiveTracking = handoffOriginalInitializeAdaptiveTracking;
        sharedSignInLoginConfig = handoffOriginalSharedSignInConfig;
        CONFIG = handoffOriginalConfig;
        trackingState = handoffOriginalTrackingState;
      }

      return {
        recoveryRace,
        signOutElapsedMs,
        signOutStorage,
        retiringOutboxNetworkCalls,
        firstSignOutSettledBeforeCommit,
        firstSignOutReleaseRequests,
        firstSignOutBearerRequests,
        firstSignOutRecoveryAfterCommit,
        failedFirstSignOutBearerRequests,
        failedFirstSignOutResumeAvailable,
        lockTimeoutOutcome,
        lockTimeoutAuthB,
        lockTimeoutAtB,
        lockTimeoutStorageAfter,
        lockClearOutcome,
        lockClearAuthB,
        lockClearAtB,
        lockClearStorageAfter,
        screenshotResult,
        screenshotUploads,
        earlyScreenshotAuthCancellationHandled,
        trackingImmediateReasons,
        generationAfterGapAuthority,
        generationAfterClassAAuthority,
        generationAfterClassBAuthority,
        generationAfterClassBRenewal,
        trackingImmediateCountAfterRenewal,
        lateClassADenialPreservedClassB,
        classAUploadResult,
        classAUploadSignalAborted,
        classAUploadDidNotRecordError,
        trackingWindowUpload,
        uploadClassBAuthority,
        noDashboardScreenshotAlarm: noDashboardScreenshotAlarm && {
          periodInMinutes: noDashboardScreenshotAlarm.periodInMinutes,
        },
        noDashboardFiveMinuteCaptureSlots,
        staleLeaseAlarmExpiredCurrent,
        currentLeaseBeforeStaleAlarm,
        currentLeaseAfterStaleAlarm,
        tabLimitOutcome,
        tabLimitRemoved,
        tabLimitNotifications,
        tabLimitBCommittedBeforeRemovalSettled,
        tabLimitAuthB,
        liveErrorResult,
        liveErrorVisibleNotificationCount: liveErrorVisibleNotifications.size,
        liveErrorNotificationPayloads,
        disconnectLiveAfterClose,
        disconnectFailPrivateCloseCount,
        disconnectFailureState,
        trackedOffscreenCreateBeforeClose,
        trackedOffscreenCreateCount,
        trackingOffOutcome,
        trackingOffState,
        stopFailPrivateCloseCount,
        stopFailureContextAfter,
        stopReplacementState,
        liveReplacementOutcome,
        liveReplacementState,
        startCancelStops,
        startCancelContextA,
        startCancelState,
        processCloseOutcome,
        processCloseState,
        fabLifecycleOutcome,
        fabLifecycleBroadcasts,
        notificationForcedCleanupOutcome,
        notificationClears,
        notificationAfterForcedCleanup,
        retiredNotificationId,
        currentNotificationId,
        notificationOwnerFirstOutcome,
        notificationOwnerFollowupOutcome,
        notificationOwnerRaceAfterCleanup,
        notificationOwnerRaceIdB,
        notificationOwnerRaceIdC,
        staleCameraResult,
        cameraActive,
        staleTabCacheRefreshResult,
        tabCacheAfterTransition,
        heartbeatBody,
        openResult,
        openedTabRemovals,
        closeAllResult,
        closeAllRemoved,
        exactCloseResult,
        exactCloseCount,
        statefulResult,
        attentionModeActive,
        snapshotResult,
        snapshotStorage,
        legacyStorageResult,
        legacyStorage,
        reconcileAlarmOutcome,
        reconcileAlarmBCommittedBeforeQuerySettled,
        reconcileAlarmFinalSessionId,
        wakeRecoveryOutcome,
        wakeRecoveryBCommittedBeforeASettled,
        wakeRecoveryAuthB,
        wakeRecoveryStorage,
        overlayReadOutcome,
        overlayBCommit,
        overlayAfterTransition,
        checkInBCommit,
        checkInAfterTransition,
        checkInAlarmAfterTransition,
        heartbeatInvalidBCommittedBeforeClearSettled,
        heartbeatInvalidAuthB,
        heartbeatInvalidStorage,
        monitoringTransitionOutcome,
        monitoringBCommittedBeforeWriteSettled,
        monitoringAuthB,
        monitoringStorage,
        settingsReadOutcome,
        settingsBCommittedBeforeReadSettled,
        settingsBCommit,
        settingsStorage,
        settingsColdRefresh,
        settingsColdTrackingState,
        chatFlushBRequestsBeforeASettled,
        chatFlushDurableHandoffDelay,
        chatFlushRequestIds,
        chatFlushStorage,
        navigationAuthContextId: navigationAuth.authContextId,
        createdTabAuthContextId: createdTabAuth.authContextId,
        navigationNotificationContexts,
        replacementOutcome,
        broadcastFrames,
        broadcastOfferCleaned,
        teacherBroadcastActive,
        teacherBroadcastSessionId,
        manualHandoffScreenshot,
      };
    });

    const bridgeFixture = await worker.evaluate(async () => {
      advanceStudentAuthMutationGeneration();
      CONFIG.serverUrl = 'https://school-pilot.net';
      CONFIG.schoolId = 'school-session-ui-bridge';
      CONFIG.deviceId = 'device-session-ui-bridge';
      CONFIG.activeStudentId = 'student-session-ui-bridge';
      CONFIG.activeStudentSessionId = 'student-session-ui-bridge-session';
      CONFIG.studentToken = 'student-session-ui-bridge-token';
      CONFIG.studentName = 'Private Student Name';
      CONFIG.studentEmail = 'private-student@example.edu';
      CONFIG.identitySource = 'manual_pin';
      CONFIG.manualLoginLastSeenAt = Date.now();
      CONFIG.authContextId = generateAuthContextId();
      studentAuthInvalidating = false;
      studentAuthCommitPending = false;
      await setManualAuthState({
        authContextId: CONFIG.authContextId,
        activeStudentId: CONFIG.activeStudentId,
        activeStudentSessionId: CONFIG.activeStudentSessionId,
        studentToken: CONFIG.studentToken,
        studentName: CONFIG.studentName,
        studentEmail: CONFIG.studentEmail,
        identitySource: CONFIG.identitySource,
        manualLoginLastSeenAt: CONFIG.manualLoginLastSeenAt,
      });
      activateAuthenticatedContext(CONFIG.authContextId);
      currentFabState = {
        teachingSessionId: 'teaching-session-ui-bridge',
        activeSessionIds: ['teaching-session-ui-bridge'],
        messagingEnabled: true,
        handRaisingEnabled: true,
      };
      const authContext = captureAuthenticatedContext('session UI bridge fixture');
      const binding = fabIdentityBinding();
      await durableSessionKv.set({
        handRaised: true,
        messagingEnabled: true,
        handRaisingEnabled: true,
        fabChatMessages: [{ id: 'safe-fab-message', message: 'Visible message' }],
        fabChatClosed: false,
        [FAB_STATE_STORAGE_KEY]: {
          teachingSessionId: 'teaching-session-ui-bridge',
          messagingEnabled: true,
        },
        [FAB_CONTEXT_STORAGE_KEY]: { binding },
        [FAB_CHAT_CONTEXT_STORAGE_KEY]: { binding },
      });
      return {
        context: studentMessageContextFor(authContext),
        binding,
        privateValues: [
          CONFIG.schoolId,
          CONFIG.deviceId,
          CONFIG.activeStudentId,
          CONFIG.activeStudentSessionId,
          CONFIG.studentToken,
          CONFIG.studentName,
          CONFIG.studentEmail,
        ],
      };
    });
    const bridgeResponses = await worker.evaluate(async ({ context: messageContext }) => {
      const invalidContext = {
        ...messageContext,
        studentId: `${messageContext.studentId}-wrong`,
      };
      return {
        invalid: await getStudentSessionUiState({
          type: 'get-student-session-ui-state',
          studentMessageContext: invalidContext,
        }),
        valid: await getStudentSessionUiState({
          type: 'get-student-session-ui-state',
          studentMessageContext: messageContext,
        }),
      };
    }, { context: bridgeFixture.context });

    assert.deepEqual(bridgeResponses.invalid, { success: false });
    assert.equal(bridgeResponses.valid.success, true);
    assert.equal(bridgeResponses.valid.fabBinding, bridgeFixture.binding);
    assert.deepEqual(Object.keys(bridgeResponses.valid).sort(), [
      'fabBinding',
      'stored',
      'success',
    ]);
    assert.deepEqual(Object.keys(bridgeResponses.valid.stored).sort(), [
      'fabChatClosed',
      'fabChatContextV1',
      'fabChatMessages',
      'fabContextV1',
      'fabStateV1',
      'handRaised',
      'handRaisingEnabled',
      'messagingEnabled',
    ]);
    const serializedBridgeResponse = JSON.stringify(bridgeResponses.valid);
    for (const privateValue of bridgeFixture.privateValues) {
      assert.equal(
        serializedBridgeResponse.includes(privateValue),
        false,
        'student session UI bridge leaked private authentication context',
      );
    }

    const gatePresenceFixture = await worker.evaluate(async () => {
      const originalFetch = globalThis.fetch;
      const requests = [];
      try {
        advanceStudentAuthMutationGeneration();
        CONFIG.serverUrl = 'https://school-pilot.net';
        CONFIG.schoolId = 'school-gate-presence';
        CONFIG.schoolSlug = null;
        CONFIG.enrollmentKey = 'enrollment-gate-presence';
        CONFIG.deviceId = 'device-gate-presence';
        CONFIG.studentToken = null;
        CONFIG.activeStudentId = null;
        CONFIG.activeStudentSessionId = null;
        CONFIG.identitySource = null;
        CONFIG.manualLoginLastSeenAt = 0;
        studentAuthInvalidating = false;
        studentAuthCommitPending = false;
        managedAuthGateSetupUnavailable = false;
        authGateRosterContextGeneration += 1;
        sharedSignInLoginConfig = {
          phase: 'ready',
          fetchedAt: Date.now(),
          retryAt: null,
          setupRequired: false,
          sharedSignInEnabled: true,
          loginMethod: 'name_pin',
          pinLoginEnabled: true,
          schoolId: CONFIG.schoolId,
          passpilotKioskAvailable: false,
          bindingKey: authGateConfigBindingKey(),
        };
        await enqueueStudentSessionRecoveryMutation(() => persistStudentSessionRecoveryState(
          emptyStudentSessionRecoveryState(),
        ));
        await clearManagedDeviceContinuityState();
        await armStudentSessionRecovery({
          serverOrigin: CONFIG.serverUrl,
          schoolId: CONFIG.schoolId,
          token: 'P'.repeat(43),
          authContextId: 'auth_gate_presence',
        });
        globalThis.fetch = async (url, init = {}) => {
          if (String(url).endsWith('/api/classpilot/extension/device-continuity/preflight')) {
            return new Response(JSON.stringify({
              code: 'CLASSPILOT_PROTOCOL_UPGRADE_REQUIRED',
            }), { status: 426, headers: { 'content-type': 'application/json' } });
          }
          if (String(url).endsWith('/api/extension/session-gate-presence')) {
            requests.push({
              url: String(url),
              authorization: init.headers?.Authorization,
              enrollmentKey: init.headers?.['X-ClassPilot-Enrollment-Key'],
              body: JSON.parse(String(init.body || '{}')),
            });
            return new Response(null, { status: 204 });
          }
          return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
        };
        studentAuthGatePresenceSources.clear();
        studentAuthGatePresenceLastDispatchAt = 0;
        studentAuthGatePresenceRetryAt = 0;
        const sender = {
          id: chrome.runtime.id,
          tab: { id: 8701, url: 'https://example.edu/student-work' },
          frameId: 0,
          url: 'https://example.edu/student-work',
        };
        const firstAccepted = noteStudentAuthGatePresence({
          present: true,
          instanceId: 'a'.repeat(32),
          rosterContextGeneration: authGateRosterContextGeneration,
        }, sender);
        const secondAccepted = noteStudentAuthGatePresence({
          present: true,
          instanceId: 'b'.repeat(32),
          rosterContextGeneration: authGateRosterContextGeneration,
        }, { ...sender, tab: { ...sender.tab, id: 8702 } });
        await studentAuthGatePresencePublishInFlight;
        const coalescedRequestCount = requests.length;

        authGateRosterContextGeneration += 1;
        studentAuthGatePresenceLastDispatchAt = 0;
        studentAuthGatePresenceRetryAt = 0;
        await publishStudentAuthGatePresence();
        const staleGenerationRequestCount = requests.length;

        const nextGenerationAccepted = noteStudentAuthGatePresence({
          present: true,
          instanceId: 'c'.repeat(32),
          rosterContextGeneration: authGateRosterContextGeneration,
        }, { ...sender, tab: { ...sender.tab, id: 8703 } });
        studentAuthGatePresenceLastDispatchAt = 0;
        await publishStudentAuthGatePresence();
        if (studentAuthGatePresencePublishInFlight) {
          await studentAuthGatePresencePublishInFlight;
        }
        const currentGenerationRequestCount = requests.length;
        noteStudentAuthGatePresence({
          present: false,
          instanceId: 'c'.repeat(32),
          rosterContextGeneration: authGateRosterContextGeneration,
        }, { ...sender, tab: { ...sender.tab, id: 8703 } });
        return {
          firstAccepted,
          secondAccepted,
          nextGenerationAccepted,
          coalescedRequestCount,
          staleGenerationRequestCount,
          currentGenerationRequestCount,
          firstRequest: requests[0],
          remainingCurrentSources: hasCurrentStudentAuthGatePresenceSource(),
        };
      } finally {
        studentAuthGatePresenceAbortController?.abort();
        studentAuthGatePresenceSources.clear();
        globalThis.fetch = originalFetch;
      }
    });
    assert.equal(gatePresenceFixture.firstAccepted, true);
    assert.equal(gatePresenceFixture.secondAccepted, true);
    assert.equal(gatePresenceFixture.nextGenerationAccepted, true);
    assert.equal(gatePresenceFixture.coalescedRequestCount, 1);
    assert.equal(gatePresenceFixture.staleGenerationRequestCount, 1);
    assert.equal(gatePresenceFixture.currentGenerationRequestCount, 2);
    assert.deepEqual(gatePresenceFixture.firstRequest, {
      url: 'https://school-pilot.net/api/extension/session-gate-presence',
      authorization: `ClassPilot-Recovery ${'P'.repeat(43)}`,
      enrollmentKey: 'enrollment-gate-presence',
      body: {
        schoolId: 'school-gate-presence',
        clientProtocolVersion: 3,
        capabilities: [
          'scopedAuthorityChecksV1',
          'studentAuthGatePresenceV1',
          'lateSignInRestrictionSsoV1',
        ],
      },
    });
    assert.equal(gatePresenceFixture.remainingCurrentSources, false);

    const restrictionSsoFixture = await worker.evaluate(async () => {
      await clearRestrictionSsoVisitState();
      const originalRestrictionRuntime = {
        screenLocked,
        lockedDomain,
        lockedUrl,
        allowedDomains: [...allowedDomains],
        attentionModeActive,
        teacherBlockedDomains: [...teacherBlockedDomains],
        schoolMaxTabs,
        teacherMaxTabs,
        currentMaxTabs,
      };
      advanceStudentAuthMutationGeneration();
      CONFIG.serverUrl = 'https://school-pilot.net';
      CONFIG.schoolId = 'school-restriction-sso';
      CONFIG.deviceId = 'device-restriction-sso';
      CONFIG.activeStudentId = 'student-restriction-sso';
      CONFIG.activeStudentSessionId = 'session-restriction-sso-a';
      CONFIG.studentToken = 'token-restriction-sso-a';
      CONFIG.identitySource = 'chrome_profile';
      CONFIG.manualLoginLastSeenAt = null;
      CONFIG.authContextId = generateAuthContextId();
      studentAuthInvalidating = false;
      studentAuthCommitPending = false;
      activateAuthenticatedContext(CONFIG.authContextId);
      const firstContext = captureAuthenticatedContext('restriction SSO fixture A');
      observeStudentControlRevision(41, firstContext, 'restriction SSO fixture revision');
      const markedState = {
        deliveryContext: { lateSignInRestrictionSso: true },
      };
      const exactBinding = {
        bindingVersion: 2,
        schoolId: firstContext.schoolId,
        deviceId: firstContext.deviceId,
        studentId: firstContext.studentId,
        studentSessionId: firstContext.studentSessionId,
        controlRevision: 41,
      };
      const ordinaryMarkerAbsentResult = await validateRestrictionSsoDeliveryContext(
        { restrictions: {} },
        {},
        firstContext,
      );
      adoptNegotiatedProtocolState({
        serverProtocolVersion: 3,
        acceptedCapabilities: ['scopedAuthorityChecksV1'],
      }, firstContext);
      const unnegotiatedOutcome = await validateRestrictionSsoDeliveryContext(
        markedState,
        { binding: exactBinding },
        firstContext,
      ).then(() => 'accepted', (error) => error?.code || error?.name);
      adoptNegotiatedProtocolState({
        serverProtocolVersion: 3,
        acceptedCapabilities: [
          'scopedAuthorityChecksV1',
          'lateSignInRestrictionSsoV1',
        ],
      }, firstContext);
      const mismatchedOutcome = await validateRestrictionSsoDeliveryContext(
        markedState,
        { binding: { ...exactBinding, deviceId: 'retired-device' } },
        firstContext,
      ).then(() => 'accepted', (error) => error?.code || error?.name);
      const acceptedBindingDigest = await validateRestrictionSsoDeliveryContext(
        markedState,
        { binding: exactBinding },
        firstContext,
      );
      const sameBindingPersistedDigest = await validateRestrictionSsoDeliveryContext(
        {
          deliveryContext: {
            lateSignInRestrictionSso: true,
            bindingDigest: acceptedBindingDigest,
          },
        },
        {},
        firstContext,
        { trustedPersistedRestrictionSso: true },
      );
      await rawLocalKv.set({
        [RESTRICTION_SSO_VISIT_STORAGE_KEY]: {
          schemaVersion: RESTRICTION_SSO_VISIT_SCHEMA_VERSION,
          scopeDigest: acceptedBindingDigest,
          visitedHosts: ['clever.com'],
        },
        [CLASSROOM_STATE_STORAGE_KEY]: {
          ...markedState,
          deliveryContext: {
            ...markedState.deliveryContext,
            bindingDigest: acceptedBindingDigest,
          },
        },
        [CLASSROOM_STATE_FAILSAFE_EXPIRY_KEY]: Date.now() + 60_000,
      });
      await kv.set({ [CLASSROOM_STATE_STUDENT_BINDING_KEY]: firstContext.studentId });
      const stalePersistedOutcome = await validateRestrictionSsoDeliveryContext(
        {
          deliveryContext: {
            lateSignInRestrictionSso: true,
            bindingDigest: '0'.repeat(64),
          },
        },
        {},
        firstContext,
        { trustedPersistedRestrictionSso: true },
      ).then(() => 'accepted', (error) => error?.code || error?.name);
      const staleStorageAfter = await getStoredAuthState([
        RESTRICTION_SSO_VISIT_STORAGE_KEY,
        CLASSROOM_STATE_STORAGE_KEY,
        CLASSROOM_STATE_STUDENT_BINDING_KEY,
        CLASSROOM_STATE_FAILSAFE_EXPIRY_KEY,
      ]);
      const staleExpiryAlarm = await chrome.alarms.get(CLASSROOM_STATE_EXPIRY_ALARM);
      currentClassroomState = {
        deliveryContext: { lateSignInRestrictionSso: true },
        restrictions: {
          screenLock: { active: true, url: 'https://ixl.com/math', domain: 'ixl.com' },
          flightPath: { active: false, allowedDomains: [] },
        },
      };
      restrictionSsoPassThroughActive = true;
      screenLocked = true;
      lockedDomain = 'ixl.com';
      lockedUrl = 'https://ixl.com/math';
      allowedDomains = [];
      attentionModeActive = false;
      teacherBlockedDomains = [];
      schoolMaxTabs = null;
      teacherMaxTabs = null;
      currentMaxTabs = null;
      const exactCreatedDecision = await createdTabPolicyDecision({
        id: 7701,
        active: true,
        url: 'https://district.clever.com/login',
      }, async () => []);
      const lookalikeCreatedDecision = await createdTabPolicyDecision({
        id: 7702,
        active: true,
        url: 'https://clever.com.evil.example/login',
      }, async () => []);
      const ssoRaceRemovalStillApplies = createdTabRemovalDecisionStillApplies(
        { policySource: 'screen_lock' },
        {
          id: 7703,
          active: true,
          url: 'https://accounts.google.com/o/oauth2/auth',
        },
      );
      currentMaxTabs = 2;
      const foregroundSsoPopup = {
        id: 7803,
        windowId: 78,
        active: true,
        url: 'https://accounts.google.com/o/oauth2/v2/auth',
      };
      const multiWindowInventory = [
        {
          id: 7801,
          windowId: 76,
          active: true,
          url: 'https://ixl.com/math',
        },
        {
          id: 7802,
          windowId: 77,
          active: true,
          url: 'https://district.clever.com/login',
        },
        foregroundSsoPopup,
      ];
      const multiWindowInventoryWithExcess = [
        ...multiWindowInventory,
        {
          id: 7804,
          windowId: 76,
          active: false,
          url: 'https://outside.example/unrelated',
        },
      ];
      const multiWindowQueries = [];
      const foregroundSsoTabLimitDecision = await createdTabPolicyDecision(
        foregroundSsoPopup,
        async (query) => {
          multiWindowQueries.push({ ...(query || {}) });
          return query?.lastFocusedWindow ? [foregroundSsoPopup] : multiWindowInventory;
        },
      );
      const staleMultiWindowQueries = [];
      const staleForegroundSsoTabLimitDecision = await createdTabPolicyDecision(
        foregroundSsoPopup,
        async (query) => {
          staleMultiWindowQueries.push({ ...(query || {}) });
          // Chrome may briefly report the formerly focused destination window
          // even though onCreated already marked the Google popup active.
          return query?.lastFocusedWindow ? [multiWindowInventory[0]] : multiWindowInventory;
        },
      );
      const popupAfterActiveChanged = { ...foregroundSsoPopup, active: false };
      const inventoryAfterActiveChanged = [
        multiWindowInventory[0],
        multiWindowInventory[1],
        popupAfterActiveChanged,
      ];
      const eventHintAfterActiveChangedDecision = await createdTabPolicyDecision(
        popupAfterActiveChanged,
        async (query) => (
          query?.lastFocusedWindow ? [multiWindowInventory[0]] : inventoryAfterActiveChanged
        ),
        { createdRestrictionSsoTabId: foregroundSsoPopup.id },
      );

      // Ordinary WebSocket tab-limit enforcement has no event-time foreground
      // hint. A stale last-focused query must therefore preserve every active
      // exact-SSO candidate instead of guessing which authentication window
      // is safe to close, even when that temporarily exceeds the limit.
      const staleWebSocketRemoved = [];
      const staleWebSocketResults = [];
      for (const scenario of [
        { maxTabsPerStudent: 1, staleForegroundTab: multiWindowInventory[0] },
        { maxTabsPerStudent: 2, staleForegroundTab: multiWindowInventory[0] },
        { maxTabsPerStudent: 2, staleForegroundTab: multiWindowInventory[1] },
      ]) {
        const result = await applyWebSocketTabLimitSetting({
          type: 'auth-success',
          studentId: firstContext.studentId,
          studentSessionId: firstContext.studentSessionId,
          settings: { maxTabsPerStudent: scenario.maxTabsPerStudent },
        }, firstContext, {
          queryTabs: async (query) => (
            query?.lastFocusedWindow ? [scenario.staleForegroundTab] : multiWindowInventory
          ),
          getTab: async (tabId) => multiWindowInventory.find((tab) => tab.id === tabId),
          removeTab: async (tabId) => { staleWebSocketRemoved.push(tabId); },
          notify: async () => {},
        });
        staleWebSocketResults.push({
          staleForegroundTabId: scenario.staleForegroundTab.id,
          ...result,
        });
      }

      // Exercise the complete onCreated -> generic reconciliation handoff.
      // The onCreated hint additively preserves the exact Google popup while
      // the generic last-focused query intentionally remains stale. Clever's
      // active opener must survive too; only an unrelated fourth tab may go.
      const staleReconcileRemoved = [];
      const staleReconcileHints = [];
      const staleReconcileMarkedStates = [];
      const staleReconcileRemovedByLimit = [];
      const staleReconcileUpdates = [];
      const staleReconcileFocusedWindows = [];
      for (const limit of [1, 2]) {
        currentMaxTabs = limit;
        const removedForLimit = [];
        await handleCreatedTabForPolicy(foregroundSsoPopup, {
          getTab: async () => ({ ...foregroundSsoPopup }),
          queryTabs: async (query) => (
            query?.lastFocusedWindow
              ? [multiWindowInventoryWithExcess[0]]
              : multiWindowInventoryWithExcess
          ),
          reconcileTabs: async (state, options) => {
            staleReconcileHints.push(options.foregroundRestrictionSsoTabId);
            staleReconcileMarkedStates.push(
              state?.deliveryContext?.lateSignInRestrictionSso === true,
            );
            return reconcileExistingTabsForClassroomState(
              state,
              options.assertCurrent,
              options.authContext,
              null,
              {
                foregroundRestrictionSsoTabId: options.foregroundRestrictionSsoTabId,
                queryTabs: async (query) => (
                  query?.lastFocusedWindow
                    ? [multiWindowInventoryWithExcess[0]]
                    : multiWindowInventoryWithExcess
                ),
                updateTab: async (tabId, properties) => {
                  staleReconcileUpdates.push({ tabId, properties });
                  return {
                    ...multiWindowInventoryWithExcess.find((tab) => tab.id === tabId),
                    ...properties,
                  };
                },
                getTab: async (tabId) => (
                  multiWindowInventoryWithExcess.find((tab) => tab.id === tabId)
                ),
                removeTab: async (tabId) => {
                  staleReconcileRemoved.push(tabId);
                  removedForLimit.push(tabId);
                },
                createTab: async () => { throw new Error('unexpected SSO reconciliation tab creation'); },
                focusWindow: async (windowId) => { staleReconcileFocusedWindows.push(windowId); },
                refreshTabs: async () => {},
              },
            );
          },
        });
        staleReconcileRemovedByLimit.push({ limit, removed: removedForLimit });
      }

      // Generic worker-restart reconciliation has no onCreated hint. Even if
      // Chrome stale-reports an unrelated window as foreground, the active
      // Clever opener and Google popup must suppress all activation/focus.
      const genericRestartRemovedByLimit = [];
      const genericRestartUpdates = [];
      const genericRestartFocusedWindows = [];
      for (const limit of [1, 2]) {
        currentMaxTabs = limit;
        const removedForLimit = [];
        await reconcileExistingTabsForClassroomState(
          currentClassroomState,
          () => {},
          firstContext,
          null,
          {
            queryTabs: async (query) => (
              query?.lastFocusedWindow
                ? [multiWindowInventoryWithExcess[3]]
                : multiWindowInventoryWithExcess
            ),
            updateTab: async (tabId, properties) => {
              genericRestartUpdates.push({ tabId, properties });
              return {
                ...multiWindowInventoryWithExcess.find((tab) => tab.id === tabId),
                ...properties,
              };
            },
            getTab: async (tabId) => (
              multiWindowInventoryWithExcess.find((tab) => tab.id === tabId)
            ),
            removeTab: async (tabId) => { removedForLimit.push(tabId); },
            createTab: async () => { throw new Error('unexpected restart SSO tab creation'); },
            focusWindow: async (windowId) => { genericRestartFocusedWindows.push(windowId); },
            refreshTabs: async () => {},
          },
        );
        genericRestartRemovedByLimit.push({ limit, removed: removedForLimit });
      }
      currentMaxTabs = null;
      await ensureRestrictionSsoVisitStateForContext(firstContext);
      const accepted = await observeRestrictionSsoHostForAuth(
        'https://district.clever.com/oauth/start',
        firstContext,
      );
      const rejectedLookalike = await observeRestrictionSsoHostForAuth(
        'https://clever.com.evil.example/login',
        firstContext,
      );
      const firstStored = (await chrome.storage.local.get(
        RESTRICTION_SSO_VISIT_STORAGE_KEY,
      ))[RESTRICTION_SSO_VISIT_STORAGE_KEY];
      const serializedFirstStored = JSON.stringify(firstStored);

      // Hold an old binding's local write across the authority-retirement
      // boundary. The serialized clear must run afterward, so a completed
      // stale write cannot resurrect the retired visit ledger.
      const originalVisitSet = rawLocalKv.set;
      let releaseDelayedVisit;
      let noteDelayedVisitStarted;
      const delayedVisitStarted = new Promise((resolve) => {
        noteDelayedVisitStarted = resolve;
      });
      const delayedVisitRelease = new Promise((resolve) => {
        releaseDelayedVisit = resolve;
      });
      rawLocalKv.set = async (values) => {
        if (Object.prototype.hasOwnProperty.call(values || {}, RESTRICTION_SSO_VISIT_STORAGE_KEY)) {
          noteDelayedVisitStarted();
          await delayedVisitRelease;
        }
        return originalVisitSet(values);
      };
      const delayedOldBindingVisit = observeRestrictionSsoHostForAuth(
        'https://accounts.google.com/o/oauth2/auth',
        firstContext,
      );
      await delayedVisitStarted;
      advanceStudentAuthMutationGeneration();
      const retirementClear = clearRestrictionSsoVisitState();
      releaseDelayedVisit();
      const delayedOldBindingOutcome = await delayedOldBindingVisit.then(
        () => 'accepted',
        (error) => error?.code || error?.name,
      );
      await retirementClear;
      rawLocalKv.set = originalVisitSet;
      const retiredWriteStorage = await rawLocalKv.get([RESTRICTION_SSO_VISIT_STORAGE_KEY]);

      advanceStudentAuthMutationGeneration();
      CONFIG.activeStudentSessionId = 'session-restriction-sso-b';
      CONFIG.studentToken = 'token-restriction-sso-b';
      CONFIG.authContextId = generateAuthContextId();
      activateAuthenticatedContext(CONFIG.authContextId);
      const secondContext = captureAuthenticatedContext('restriction SSO fixture B');
      await ensureRestrictionSsoVisitStateForContext(secondContext);
      const secondStored = (await chrome.storage.local.get(
        RESTRICTION_SSO_VISIT_STORAGE_KEY,
      ))[RESTRICTION_SSO_VISIT_STORAGE_KEY];
      const secondVisitedHosts = [...visitedRestrictionSsoHosts];
      await clearRestrictionSsoVisitState();
      currentClassroomState = null;
      restrictionSsoPassThroughActive = false;
      screenLocked = originalRestrictionRuntime.screenLocked;
      lockedDomain = originalRestrictionRuntime.lockedDomain;
      lockedUrl = originalRestrictionRuntime.lockedUrl;
      allowedDomains = originalRestrictionRuntime.allowedDomains;
      attentionModeActive = originalRestrictionRuntime.attentionModeActive;
      teacherBlockedDomains = originalRestrictionRuntime.teacherBlockedDomains;
      schoolMaxTabs = originalRestrictionRuntime.schoolMaxTabs;
      teacherMaxTabs = originalRestrictionRuntime.teacherMaxTabs;
      currentMaxTabs = originalRestrictionRuntime.currentMaxTabs;
      negotiatedProtocolState = null;
      resetStudentControlRevisionAuthority();
      const secondAuthContext = captureAuthenticatedContext('restriction SSO origin cleanup');
      await clearStudentAuth('restriction_sso_origin_cleanup_fixture', {
        notifyBackend: false,
        serverSessionEnded: true,
        pauseAutoRegistration: true,
        disconnectWebSocket: false,
        notifyAuthGateTabs: false,
        expectedAuthContext: secondAuthContext,
      });
      await rawLocalKv.set({
        [RESTRICTION_SSO_VISIT_STORAGE_KEY]: {
          schemaVersion: RESTRICTION_SSO_VISIT_SCHEMA_VERSION,
          scopeDigest: 'a'.repeat(64),
          visitedHosts: ['accounts.google.com'],
        },
      });
      const originTransitionResponse = await updateServerOriginForSignedOutProfile(
        'https://alternate.school-pilot.net',
      );
      const originTransitionStorage = await rawLocalKv.get([
        RESTRICTION_SSO_VISIT_STORAGE_KEY,
        'config',
      ]);
      const originalManagedRead = readManagedConfig;
      const originalManagedNotify = notifyAuthGateStateToTabs;
      const originalLegacyRefresh = refreshSharedSignInLoginConfigLegacy;
      const originalFastAuthGateEnabled = fastAuthGateEnabled;
      const priorManagedPolicyStorage = await rawLocalKv.get([
        MANAGED_AUTH_GATE_BINDING_KEY,
      ]);
      await rawLocalKv.set({
        [RESTRICTION_SSO_VISIT_STORAGE_KEY]: {
          schemaVersion: RESTRICTION_SSO_VISIT_SCHEMA_VERSION,
          scopeDigest: 'c'.repeat(64),
          visitedHosts: ['accounts.google.com'],
        },
      });
      let fastPolicyTransition;
      try {
        readManagedConfig = async () => ({
          fastAuthGateEnabled: false,
          serverUrl: CONFIG.serverUrl,
          schoolId: CONFIG.schoolId,
          schoolSlug: CONFIG.schoolSlug,
          enrollmentKey: CONFIG.enrollmentKey,
        });
        notifyAuthGateStateToTabs = async () => {};
        refreshSharedSignInLoginConfigLegacy = async () => ({ success: true });
        const transition = handleManagedAuthGateStorageChange({
          fastAuthGateEnabled: {
            oldValue: true,
            newValue: false,
          },
        }, 'managed');
        await transition.policyRestorePromise;
        const afterTransition = await rawLocalKv.get([
          RESTRICTION_SSO_VISIT_STORAGE_KEY,
        ]);
        fastPolicyTransition = {
          visitStorageCleared:
            afterTransition[RESTRICTION_SSO_VISIT_STORAGE_KEY] === undefined,
          authRemainedSignedOut: !hasStudentAuth(),
          fastAuthGateEnabled,
        };
      } finally {
        readManagedConfig = originalManagedRead;
        notifyAuthGateStateToTabs = originalManagedNotify;
        refreshSharedSignInLoginConfigLegacy = originalLegacyRefresh;
        fastAuthGateEnabled = originalFastAuthGateEnabled;
        if (priorManagedPolicyStorage[MANAGED_AUTH_GATE_BINDING_KEY]) {
          await rawLocalKv.set({
            [MANAGED_AUTH_GATE_BINDING_KEY]:
              priorManagedPolicyStorage[MANAGED_AUTH_GATE_BINDING_KEY],
          });
        } else {
          await rawLocalKv.remove(MANAGED_AUTH_GATE_BINDING_KEY);
        }
      }
      return {
        ordinaryMarkerAbsentResult,
        unnegotiatedOutcome,
        mismatchedOutcome,
        acceptedBindingDigestLength: String(acceptedBindingDigest || '').length,
        sameBindingPersistedDigestMatches: sameBindingPersistedDigest === acceptedBindingDigest,
        stalePersistedOutcome,
        staleVisitStorageCleared:
          staleStorageAfter[RESTRICTION_SSO_VISIT_STORAGE_KEY] === undefined,
        staleClassroomStorageCleared:
          staleStorageAfter[CLASSROOM_STATE_STORAGE_KEY] === undefined
          && staleStorageAfter[CLASSROOM_STATE_STUDENT_BINDING_KEY] === undefined,
        staleFailSafeRetained: Number(staleStorageAfter[CLASSROOM_STATE_FAILSAFE_EXPIRY_KEY])
          > Date.now(),
        staleFailSafeAlarmRetained: Number(staleExpiryAlarm?.scheduledTime) > Date.now(),
        exactCreatedPolicySource: exactCreatedDecision.policySource,
        lookalikeCreatedPolicySource: lookalikeCreatedDecision.policySource,
        ssoRaceRemovalStillApplies,
        foregroundSsoPolicySource: foregroundSsoTabLimitDecision.policySource,
        foregroundSsoReconcilesBackgroundExcess:
          foregroundSsoTabLimitDecision.reconcileExcessTabs,
        multiWindowQueries,
        staleForegroundSsoPolicySource:
          staleForegroundSsoTabLimitDecision.policySource,
        staleForegroundSsoReconcilesBackgroundExcess:
          staleForegroundSsoTabLimitDecision.reconcileExcessTabs,
        staleMultiWindowQueries,
        eventHintAfterActiveChangedPolicySource:
          eventHintAfterActiveChangedDecision.policySource,
        eventHintAfterActiveChangedReconciles:
          eventHintAfterActiveChangedDecision.reconcileExcessTabs,
        staleWebSocketRemoved,
        staleWebSocketResults,
        staleReconcileRemoved,
        staleReconcileRemovedByLimit,
        staleReconcileHints,
        staleReconcileMarkedStates,
        staleReconcileUpdates,
        staleReconcileFocusedWindows,
        genericRestartRemovedByLimit,
        genericRestartUpdates,
        genericRestartFocusedWindows,
        accepted,
        rejectedLookalike,
        firstVisitedHosts: firstStored?.visitedHosts || [],
        firstStoredKeys: Object.keys(firstStored || {}).sort(),
        firstScopeDigestLength: String(firstStored?.scopeDigest || '').length,
        storedFullUrl: serializedFirstStored.includes('https://'),
        leakedPrivateBinding: [
          'school-restriction-sso',
          'device-restriction-sso',
          'student-restriction-sso',
          'session-restriction-sso-a',
          'token-restriction-sso-a',
        ].some((value) => serializedFirstStored.includes(value)),
        delayedOldBindingOutcome,
        retiredWriteCleared:
          retiredWriteStorage[RESTRICTION_SSO_VISIT_STORAGE_KEY] === undefined,
        secondStored,
        secondVisitedHosts,
        originTransitionSuccess: originTransitionResponse?.success === true,
        originTransitionVisitStorageCleared:
          originTransitionStorage[RESTRICTION_SSO_VISIT_STORAGE_KEY] === undefined,
        originTransitionServerUrl: originTransitionStorage.config?.serverUrl,
        fastPolicyTransition,
      };
    });
    assert.equal(restrictionSsoFixture.ordinaryMarkerAbsentResult, null);
    assert.equal(restrictionSsoFixture.unnegotiatedOutcome, 'LATE_SIGNIN_SSO_NOT_NEGOTIATED');
    assert.equal(restrictionSsoFixture.mismatchedOutcome, 'STUDENT_BINDING_MISMATCH');
    assert.equal(restrictionSsoFixture.acceptedBindingDigestLength, 64);
    assert.equal(restrictionSsoFixture.sameBindingPersistedDigestMatches, true);
    assert.equal(restrictionSsoFixture.stalePersistedOutcome, 'RESTRICTION_SSO_STALE_STORAGE');
    assert.equal(restrictionSsoFixture.staleVisitStorageCleared, true);
    assert.equal(restrictionSsoFixture.staleClassroomStorageCleared, true);
    assert.equal(restrictionSsoFixture.staleFailSafeRetained, true);
    assert.equal(restrictionSsoFixture.staleFailSafeAlarmRetained, true);
    assert.equal(restrictionSsoFixture.exactCreatedPolicySource, null);
    assert.equal(restrictionSsoFixture.lookalikeCreatedPolicySource, 'screen_lock');
    assert.equal(restrictionSsoFixture.ssoRaceRemovalStillApplies, false);
    assert.equal(restrictionSsoFixture.foregroundSsoPolicySource, null);
    assert.equal(restrictionSsoFixture.foregroundSsoReconcilesBackgroundExcess, false);
    assert.deepEqual(restrictionSsoFixture.multiWindowQueries, [
      {},
      { active: true, lastFocusedWindow: true },
    ]);
    assert.equal(restrictionSsoFixture.staleForegroundSsoPolicySource, null);
    assert.equal(
      restrictionSsoFixture.staleForegroundSsoReconcilesBackgroundExcess,
      false,
    );
    assert.deepEqual(restrictionSsoFixture.staleMultiWindowQueries, [
      {},
      { active: true, lastFocusedWindow: true },
    ]);
    assert.equal(restrictionSsoFixture.eventHintAfterActiveChangedPolicySource, null);
    assert.equal(restrictionSsoFixture.eventHintAfterActiveChangedReconciles, false);
    assert.deepEqual(restrictionSsoFixture.staleWebSocketRemoved, []);
    assert.deepEqual(restrictionSsoFixture.staleWebSocketResults, [
      { staleForegroundTabId: 7801, applied: true, limit: 1, closed: 0 },
      { staleForegroundTabId: 7801, applied: true, limit: 2, closed: 0 },
      { staleForegroundTabId: 7802, applied: true, limit: 2, closed: 0 },
    ]);
    assert.deepEqual(restrictionSsoFixture.staleReconcileRemoved, [7804, 7804]);
    assert.deepEqual(restrictionSsoFixture.staleReconcileRemovedByLimit, [
      { limit: 1, removed: [7804] },
      { limit: 2, removed: [7804] },
    ]);
    assert.deepEqual(restrictionSsoFixture.staleReconcileHints, [7803, 7803]);
    assert.deepEqual(restrictionSsoFixture.staleReconcileMarkedStates, [true, true]);
    assert.deepEqual(restrictionSsoFixture.staleReconcileUpdates, []);
    assert.deepEqual(restrictionSsoFixture.staleReconcileFocusedWindows, []);
    assert.deepEqual(restrictionSsoFixture.genericRestartRemovedByLimit, [
      { limit: 1, removed: [7804] },
      { limit: 2, removed: [7804] },
    ]);
    assert.deepEqual(restrictionSsoFixture.genericRestartUpdates, []);
    assert.deepEqual(restrictionSsoFixture.genericRestartFocusedWindows, []);
    assert.equal(restrictionSsoFixture.accepted, true);
    assert.equal(restrictionSsoFixture.rejectedLookalike, false);
    assert.deepEqual(restrictionSsoFixture.firstVisitedHosts, ['district.clever.com']);
    assert.deepEqual(restrictionSsoFixture.firstStoredKeys, [
      'schemaVersion',
      'scopeDigest',
      'visitedHosts',
    ]);
    assert.equal(restrictionSsoFixture.firstScopeDigestLength, 64);
    assert.equal(restrictionSsoFixture.storedFullUrl, false);
    assert.equal(restrictionSsoFixture.leakedPrivateBinding, false);
    assert.equal(restrictionSsoFixture.delayedOldBindingOutcome, 'AUTH_CONTEXT_SUPERSEDED');
    assert.equal(restrictionSsoFixture.retiredWriteCleared, true);
    assert.equal(restrictionSsoFixture.secondStored, undefined);
    assert.deepEqual(restrictionSsoFixture.secondVisitedHosts, []);
    assert.equal(restrictionSsoFixture.originTransitionSuccess, true);
    assert.equal(restrictionSsoFixture.originTransitionVisitStorageCleared, true);
    assert.equal(
      restrictionSsoFixture.originTransitionServerUrl,
      'https://alternate.school-pilot.net',
    );
    assert.deepEqual(restrictionSsoFixture.fastPolicyTransition, {
      visitStorageCleared: true,
      authRemainedSignedOut: true,
      fastAuthGateEnabled: false,
    });

    assert.equal(result.recoveryRace.grantBeforeMetadataRetry, true);
    assert.equal(result.recoveryRace.grantAfterMetadataRetry, true);
    assert.equal(
      result.recoveryRace.materialRevisionAfterRetry,
      result.recoveryRace.materialRevisionBeforeRetry,
    );
    assert.equal(result.recoveryRace.delayedOldClear.handledExactRecovery, true);
    assert.equal(
      result.recoveryRace.armedAfterDelayedOldClearGeneration,
      result.recoveryRace.newRecoveryGeneration,
    );
    assert.deepEqual(result.recoveryRace.persistedArmedKeys, [
      'authContextId',
      'createdAt',
      'generation',
      'schoolId',
      'serverOrigin',
      'state',
      'token',
    ]);
    assert.equal(result.recoveryRace.legacyUpgradeRestore.studentToken, undefined);
    assert.equal(result.recoveryRace.legacyUpgradeRestore.activeStudentId, undefined);
    assert.equal(result.recoveryRace.legacyUpgradeRestore.activeStudentSessionId, undefined);
    assert.deepEqual(result.recoveryRace.legacyUpgradeLocalStorage, {});
    assert.equal(result.recoveryRace.legacyUpgradeRestoreSettledBeforeSignOut, false);
    assert.deepEqual(result.recoveryRace.legacyUpgradeLocalStorageDuringSignOut, {});
    assert.deepEqual(result.recoveryRace.legacyUpgradeSessionStorage, {});
    assert.equal(
      result.recoveryRace.legacyUpgradeSignOutRequest.url,
      'https://school-pilot.net/api/extension/sign-out',
    );
    assert.equal(
      result.recoveryRace.legacyUpgradeSignOutRequest.authorization,
      'Bearer legacy-bearer-token',
    );
    assert.equal(
      JSON.parse(result.recoveryRace.legacyUpgradeSignOutRequest.body).deviceId,
      'legacy-device',
    );
    assert.deepEqual(result.recoveryRace.manualLocalStorage, {});
    assert.equal(result.recoveryRace.manualSessionStorage.studentToken, 'session-only-token');
    assert.equal(result.recoveryRace.manualSessionStorage.activeStudentId, 'session-only-student');
    assert.equal(result.recoveryRace.manualSessionStorage.activeStudentSessionId, 'session-only-session');
    assert.ok(result.signOutElapsedMs < 1_000);
    assert.equal(result.retiringOutboxNetworkCalls, 0);
    assert.equal(result.signOutStorage.studentToken, undefined);
    assert.equal(result.signOutStorage.activeStudentId, undefined);
    assert.equal(result.signOutStorage.activeStudentSessionId, undefined);
    assert.equal(result.firstSignOutSettledBeforeCommit, false);
    assert.equal(result.firstSignOutReleaseRequests, 0);
    assert.equal(result.firstSignOutBearerRequests, 1);
    assert.equal(result.firstSignOutRecoveryAfterCommit, false);
    assert.equal(result.failedFirstSignOutBearerRequests, 1);
    assert.equal(result.failedFirstSignOutResumeAvailable, true);
    assert.equal(result.lockTimeoutOutcome, 'AUTH_CONTEXT_SUPERSEDED');
    assert.equal(result.lockTimeoutStorageAfter.studentToken, 'token-lock-timeout-b');
    assert.equal(result.lockTimeoutStorageAfter.sharedAuthLockedSinceAt, result.lockTimeoutAtB);
    assert.equal(
      result.lockTimeoutStorageAfter.sharedAuthLockOwnerV1.authContextId,
      result.lockTimeoutAuthB.authContextId,
    );
    assert.equal(result.lockClearOutcome, 'AUTH_CONTEXT_SUPERSEDED');
    assert.equal(result.lockClearStorageAfter.studentToken, 'token-lock-clear-b');
    assert.equal(result.lockClearStorageAfter.sharedAuthLockedSinceAt, result.lockClearAtB);
    assert.equal(
      result.lockClearStorageAfter.sharedAuthLockOwnerV1.authContextId,
      result.lockClearAuthB.authContextId,
    );
    assert.deepEqual(result.screenshotResult, { status: 'unavailable', reason: 'active_tab_changed' });
    assert.equal(result.screenshotUploads, 0);
    assert.equal(result.earlyScreenshotAuthCancellationHandled, true);
    assert.deepEqual(result.trackingImmediateReasons, [
      'authority-change',
      'authority-change',
      'authority-change',
    ]);
    assert.ok(result.generationAfterClassAAuthority > result.generationAfterGapAuthority);
    assert.ok(result.generationAfterClassBAuthority > result.generationAfterClassAAuthority);
    assert.equal(
      result.generationAfterClassBRenewal,
      result.generationAfterClassBAuthority,
    );
    assert.equal(result.trackingImmediateCountAfterRenewal, 3);
    assert.equal(result.lateClassADenialPreservedClassB, true);
    assert.deepEqual(result.classAUploadResult, { status: 'paused_unobserved' });
    assert.equal(result.classAUploadSignalAborted, true);
    assert.equal(result.classAUploadDidNotRecordError, true);
    assert.ok(result.trackingWindowUpload.url.endsWith('/api/classpilot/device/screenshot'));
    assert.deepEqual(
      result.trackingWindowUpload.body.screenshotAuthority,
      result.uploadClassBAuthority,
    );
    assert.equal(result.trackingWindowUpload.body.deviceId, undefined);
    assert.equal(typeof result.trackingWindowUpload.body.capturedAt, 'string');
    assert.equal(
      result.trackingWindowUpload.body.timestamp,
      Date.parse(result.trackingWindowUpload.body.capturedAt),
    );
    const handoffScreenshot = result.manualHandoffScreenshot;
    assert.match(handoffScreenshot.rosterGrantId, /^roster_[A-Za-z0-9_-]+$/);
    assert.equal(handoffScreenshot.loginSuccess, true);
    assert.equal(
      handoffScreenshot.loginRecoveryHeader,
      `ClassPilot-Recovery ${'M'.repeat(43)}`,
    );
    assert.equal(handoffScreenshot.loginBodyStudentId, 'student-bob');
    assert.equal(handoffScreenshot.alex.authAborted, true);
    assert.equal(handoffScreenshot.alex.uploadAborted, true);
    assert.deepEqual(handoffScreenshot.alex.captureResult, { status: 'paused_unobserved' });
    assert.equal(handoffScreenshot.alex.request.authorization, 'Bearer alex-handoff-bearer');
    assert.deepEqual(handoffScreenshot.alex.request.binding, {
      studentId: 'student-alex',
      studentSessionId: 'alex-handoff-session',
    });
    assert.deepEqual(handoffScreenshot.alex.request.body.screenshotAuthority, {
      kind: 'teaching_session',
      teachingSessionId: 'handoff-class-alex',
      controlRevision: 901,
    });
    assert.equal(handoffScreenshot.acceptedPostHandoffUploads.length, 1);
    const [firstAcceptedHandoffUpload] = handoffScreenshot.acceptedPostHandoffUploads;
    assert.equal(firstAcceptedHandoffUpload.authorization, 'Bearer bob-handoff-bearer');
    assert.deepEqual(firstAcceptedHandoffUpload.binding, {
      studentId: 'student-bob',
      studentSessionId: 'bob-handoff-session',
    });
    assert.deepEqual(handoffScreenshot.bob.auth, firstAcceptedHandoffUpload.binding);
    assert.deepEqual(
      firstAcceptedHandoffUpload.body.screenshotAuthority,
      handoffScreenshot.bob.classAuthority,
    );
    assert.equal(firstAcceptedHandoffUpload.body.deviceId, undefined);
    assert.equal(
      firstAcceptedHandoffUpload.body.timestamp,
      Date.parse(firstAcceptedHandoffUpload.body.capturedAt),
    );
    assert.ok(
      Date.parse(firstAcceptedHandoffUpload.body.capturedAt)
        > Date.parse(handoffScreenshot.alex.request.body.capturedAt),
      'Bob must upload pixels captured after Alex authority was retired',
    );
    assert.notEqual(
      firstAcceptedHandoffUpload.body.screenshot,
      handoffScreenshot.alex.request.body.screenshot,
    );
    assert.deepEqual(result.noDashboardScreenshotAlarm, { periodInMinutes: 0.5 });
    assert.equal(result.noDashboardFiveMinuteCaptureSlots, 10);
    assert.equal(result.staleLeaseAlarmExpiredCurrent, false);
    assert.equal(result.currentLeaseAfterStaleAlarm.scope, result.currentLeaseBeforeStaleAlarm.scope);
    assert.equal(result.currentLeaseAfterStaleAlarm.observed, true);
    assert.equal(
      result.currentLeaseAfterStaleAlarm.expiresAt,
      result.currentLeaseBeforeStaleAlarm.expiresAt,
    );
    assert.equal(result.tabLimitOutcome, 'AUTH_CONTEXT_SUPERSEDED');
    assert.deepEqual(result.tabLimitRemoved, [4701]);
    assert.deepEqual(result.tabLimitNotifications, []);
    assert.equal(result.tabLimitBCommittedBeforeRemovalSettled, false);
    assert.equal(result.tabLimitAuthB.studentId, 'student-tab-limit-b');
    assert.deepEqual(result.liveErrorResult, { success: true, ignored: true });
    assert.equal(result.liveErrorVisibleNotificationCount, 0);
    assert.deepEqual(result.liveErrorNotificationPayloads, [{
      title: 'Screen Sharing Error',
      message: 'Unable to start the requested screen share.',
    }]);
    assert.deepEqual(result.disconnectLiveAfterClose, {
      negotiationId: 'disconnect-live-negotiation-b',
      teachingSessionId: 'disconnect-live-session-b',
      contextIsCurrentB: true,
      transportIsCurrentB: true,
    });
    assert.equal(result.disconnectFailPrivateCloseCount, 1);
    assert.deepEqual(result.disconnectFailureState, {
      liveContext: null,
      transportIdentity: null,
    });
    assert.equal(result.trackedOffscreenCreateBeforeClose, 0);
    assert.equal(result.trackedOffscreenCreateCount, 1);
    assert.equal(result.trackingOffOutcome, 'AUTH_CONTEXT_SUPERSEDED');
    assert.deepEqual(result.trackingOffState, {
      contextIsCurrentB: true,
      transportIsCurrentB: true,
      negotiationId: 'tracking-off-negotiation-b',
    });
    assert.equal(result.stopFailPrivateCloseCount, 1);
    assert.equal(result.stopFailureContextAfter, null);
    assert.deepEqual(result.stopReplacementState, {
      contextIsCurrentB: true,
      negotiationId: 'stop-replacement-negotiation-b',
      teachingSessionId: 'stop-replacement-session-b',
    });
    assert.equal(result.liveReplacementOutcome, 'completed');
    assert.deepEqual(result.liveReplacementState, {
      contextIsCurrentB: true,
      negotiationId: 'live-replacement-negotiation-b',
      retiredStarts: 0,
    });
    assert.equal(result.startCancelStops.length, 1);
    assert.equal(
      result.startCancelStops[0].negotiationId,
      result.startCancelContextA.negotiationId,
    );
    assert.equal(
      result.startCancelStops[0].startGeneration,
      result.startCancelContextA.startGeneration,
    );
    assert.deepEqual(result.startCancelState, {
      contextIsCurrentB: true,
      negotiationId: 'start-cancel-negotiation-b',
    });
    assert.equal(result.processCloseOutcome, 'AUTH_CONTEXT_SUPERSEDED');
    assert.deepEqual(result.processCloseState, {
      broadcastActive: true,
      broadcastSessionId: 'process-close-broadcast-b',
      contextIsCurrentB: true,
      negotiationId: 'process-close-negotiation-b',
    });
    assert.equal(result.fabLifecycleOutcome, 'AUTH_CONTEXT_SUPERSEDED');
    assert.deepEqual(result.fabLifecycleBroadcasts, []);
    assert.equal(result.notificationForcedCleanupOutcome, true);
    assert.deepEqual(result.notificationClears, [result.retiredNotificationId]);
    assert.deepEqual(result.notificationAfterForcedCleanup, [result.currentNotificationId]);
    assert.equal(result.notificationOwnerFirstOutcome, false);
    assert.equal(result.notificationOwnerFollowupOutcome, true);
    assert.deepEqual(result.notificationOwnerRaceAfterCleanup, [result.notificationOwnerRaceIdC]);
    assert.notEqual(result.notificationOwnerRaceIdB, result.notificationOwnerRaceIdC);
    assert.deepEqual(result.staleCameraResult, { success: false, ignored: true });
    assert.equal(result.cameraActive, false);
    assert.equal(result.staleTabCacheRefreshResult, false);
    assert.deepEqual(result.tabCacheAfterTransition.tabs, []);
    assert.notEqual(result.tabCacheAfterTransition.binding, result.tabCacheAfterTransition.bBinding);
    assert.equal(result.heartbeatBody.appliedClassroomStateRevision, 0);
    assert.equal(result.heartbeatBody.classroomStateOutcome, 'pending');
    assert.equal(result.openResult.rejected, true);
    assert.deepEqual(result.openedTabRemovals, [4301]);
    assert.equal(result.closeAllResult.rejected, true);
    assert.deepEqual(result.closeAllRemoved, [4401]);
    assert.equal(result.exactCloseResult.rejected, true);
    assert.equal(result.exactCloseCount, 1);
    assert.equal(result.statefulResult.rejected, true);
    assert.equal(result.attentionModeActive, false);
    assert.equal(result.snapshotResult.rejected, true);
    assert.equal(result.snapshotStorage.classroomControlStateV1, undefined);
    assert.equal(result.legacyStorageResult.rejected, true);
    assert.equal(result.legacyStorage.classroomControlStateV1, undefined);
    assert.equal(result.reconcileAlarmOutcome, 'AUTH_CONTEXT_SUPERSEDED');
    assert.equal(result.reconcileAlarmBCommittedBeforeQuerySettled, false);
    assert.equal(result.reconcileAlarmFinalSessionId, 'reconcile-alarm-session-b');
    assert.equal(result.wakeRecoveryOutcome, 'AUTH_CONTEXT_SUPERSEDED');
    assert.equal(result.wakeRecoveryBCommittedBeforeASettled, false);
    assert.equal(
      result.wakeRecoveryStorage.classroomStateStudentBindingV1,
      result.wakeRecoveryAuthB.studentId,
    );
    assert.equal(
      result.wakeRecoveryStorage.classroomControlStateV1.teachingSessionId,
      'wake-recovery-session-b',
    );
    assert.equal(result.overlayReadOutcome, 'AUTH_CONTEXT_SUPERSEDED');
    assert.equal(result.overlayAfterTransition.binding, result.overlayBCommit.binding);
    assert.equal(result.overlayAfterTransition.poll.pollId, 'poll-b');
    assert.equal(result.checkInAfterTransition.binding, result.checkInBCommit.binding);
    assert.equal(result.checkInAfterTransition.question, 'B current');
    assert.equal(
      Math.round(result.checkInAlarmAfterTransition.scheduledTime),
      result.checkInAfterTransition.expiresAt + 1,
    );
    assert.equal(result.heartbeatInvalidBCommittedBeforeClearSettled, false);
    assert.equal(result.heartbeatInvalidStorage.studentToken, result.heartbeatInvalidAuthB.studentToken);
    assert.equal(result.heartbeatInvalidStorage.registered, true);
    assert.equal(result.heartbeatInvalidStorage.messages[0].id, 'message-b');
    assert.equal(result.monitoringTransitionOutcome, 'AUTH_CONTEXT_SUPERSEDED');
    assert.equal(result.monitoringBCommittedBeforeWriteSettled, false);
    assert.equal(
      result.monitoringStorage.monitoringStateScopeV1,
      `v3:${result.monitoringAuthB.authContextId}:${result.monitoringAuthB.schoolId}:${result.monitoringAuthB.studentId}:${result.monitoringAuthB.studentSessionId}:${result.monitoringAuthB.deviceId}`,
    );
    assert.equal(result.monitoringStorage.monitoringStateV1.state, 'ACTIVE');
    assert.equal(result.settingsReadOutcome, 'AUTH_CONTEXT_SUPERSEDED');
    assert.equal(result.settingsBCommittedBeforeReadSettled, false);
    assert.equal(result.settingsStorage.schoolSettingsScopeV1, result.settingsBCommit.scope);
    assert.equal(result.settingsStorage.schoolSettings.enableTrackingHours, false);
    assert.equal(result.settingsColdRefresh, null);
    assert.equal(result.settingsColdTrackingState, 'OFF');
    assert.equal(result.chatFlushBRequestsBeforeASettled, 0);
    assert.ok(
      result.chatFlushDurableHandoffDelay > 0
      && result.chatFlushDurableHandoffDelay <= 5_000,
      `unexpected student-chat handoff alarm delay: ${result.chatFlushDurableHandoffDelay}`,
    );
    assert.deepEqual(result.chatFlushRequestIds, [
      'chat-flush-message-a',
      'chat-flush-message-b',
    ]);
    assert.deepEqual(result.chatFlushStorage.studentChatOutboxV1 || [], []);
    assert.equal(result.chatFlushStorage.studentChatOutboxAuthBindingV1, undefined);
    assert.deepEqual(result.navigationNotificationContexts, [
      {
        authContextId: result.navigationAuthContextId,
        title: 'Navigation Blocked',
        source: 'screen_lock',
      },
      {
        authContextId: result.createdTabAuthContextId,
        title: 'Waypoint Set',
        source: 'screen_lock',
      },
    ]);
    assert.equal(result.replacementOutcome, 'AUTH_CONTEXT_SUPERSEDED');
    assert.equal(result.broadcastFrames.some((frame) => (
      frame.type === 'broadcast-join' && frame.sessionId === 'broadcast-session-two'
    )), false);
    assert.equal(result.teacherBroadcastActive, false);
    assert.equal(result.teacherBroadcastSessionId, null);
    assert.equal(result.broadcastOfferCleaned, true);
    console.log('ClassPilot exact-authority race checks passed.');
  } finally {
    await context?.close().catch(() => {});
    rmSync(profilePath, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
