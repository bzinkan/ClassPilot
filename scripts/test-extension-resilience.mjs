import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const extensionPath = String(process.env.CLASSPILOT_EXTENSION_PATH || '').trim()
  ? resolve(process.env.CLASSPILOT_EXTENSION_PATH)
  : resolve(repoRoot, 'extension');
const profilePath = mkdtempSync(join(tmpdir(), 'classpilot-extension-resilience-'));

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

async function waitForInitialWorker(context) {
  return context.serviceWorkers()[0] || context.waitForEvent('serviceworker', { timeout: 10_000 });
}

function attachWorkerErrorCapture(worker, errors) {
  worker.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });
}

function launchTestContext(executablePath) {
  return chromium.launchPersistentContext(profilePath, {
    executablePath,
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
}

async function startNavigationFixtureServer() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>ClassPilot tab fixture</title>');
  });
  await new Promise((resolveListen, rejectListen) => {
    const onError = (error) => rejectListen(error);
    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      resolveListen();
    });
  });
  const address = server.address();
  if (!address || typeof address === 'string') {
    server.close();
    throw new Error('Navigation fixture server did not expose a TCP port');
  }
  return { server, port: address.port };
}

async function waitForRestoredRevision(worker, expectedRevision) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const revision = await worker.evaluate(() => (
      typeof currentClassroomState === 'undefined' ? null : currentClassroomState?.revision ?? null
    ));
    if (revision === expectedRevision) return;
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 100));
  }
  throw new Error(`classroom revision ${expectedRevision} was not restored before timeout`);
}

async function main() {
  const executablePath = chromeExecutable();
  if (!executablePath) {
    throw new Error(
      'Chrome for Testing was not found. Run `npx playwright install chromium` ' +
      'or set CLASSPILOT_CHROME_PATH to a Chrome/Chromium executable.'
    );
  }

  const serviceWorkerSource = readFileSync(
    resolve(extensionPath, 'service-worker.js'),
    'utf8',
  );
  const authGateFrameSource = readFileSync(
    resolve(extensionPath, 'auth-gate-frame.js'),
    'utf8',
  );
  const legacyAuthGateSource = readFileSync(
    resolve(extensionPath, 'content.js'),
    'utf8',
  );
  const neutralActiveSessionCopy =
    'This Chromebook or student already has an active ClassPilot session. ClassPilot is refreshing available names.';
  for (const [label, authGateSource] of [
    ['secure auth frame', authGateFrameSource],
    ['legacy auth fallback', legacyAuthGateSource],
  ]) {
    assert.match(
      authGateSource,
      /recoveryGrantId:\s*(?:rosterSnapshot|authGateRosterSnapshot)\.recoveryGrantId/,
      `${label} does not bind login to its successful roster snapshot`,
    );
    assert.ok(
      authGateSource.includes(neutralActiveSessionCopy),
      `${label} does not use neutral active-session conflict copy`,
    );
    assert.match(
      authGateSource,
      /forceRefresh:\s*true,\s*forceRecovery:\s*true,\s*background:\s*true/,
      `${label} does not request one bounded recovery/roster refresh after a 409`,
    );
  }
  const trustedAccessDispatchIndex = serviceWorkerSource.indexOf(
    'const trustedLocalStorageAccessPromise = restrictLocalStorageToTrustedContexts(',
  );
  assert.ok(trustedAccessDispatchIndex >= 0);
  assert.ok(trustedAccessDispatchIndex < serviceWorkerSource.indexOf("importScripts('config.js')"));
  assert.ok(trustedAccessDispatchIndex < serviceWorkerSource.indexOf(
    'async function ensureStudentSessionRecoveryLoaded',
  ));
  const recoveryAlarmBranchStart = serviceWorkerSource.indexOf(
    "alarm.name === STUDENT_SESSION_RECOVERY_ALARM",
  );
  const recoveryAlarmBranchEnd = serviceWorkerSource.indexOf(
    "alarm.name === CLASSROOM_STATE_EXPIRY_ALARM",
    recoveryAlarmBranchStart,
  );
  assert.ok(recoveryAlarmBranchStart >= 0 && recoveryAlarmBranchEnd > recoveryAlarmBranchStart);
  assert.match(
    serviceWorkerSource.slice(recoveryAlarmBranchStart, recoveryAlarmBranchEnd),
    /flushStudentSessionRecovery\(\{ maxRecords: 1 \}\)/,
  );
  for (const [label, anchorMarker, startMarker, endMarker] of [
    [
      'heartbeat authorization denial',
      "console.warn('Heartbeat conflict:', response.status);",
      '} else if (response.status === 401 || response.status === 403) {',
      '} else if (response.status === 408 || response.status >= 500) {',
    ],
    [
      'screenshot authorization denial',
      'const responseBody = !response.ok && [401, 402, 403, 404, 409].includes(response.status)',
      'if (response.status === 401 || response.status === 403) {',
      'const structuredAuthorityDenial =',
    ],
  ]) {
    const anchorStart = serviceWorkerSource.indexOf(anchorMarker);
    const branchStart = serviceWorkerSource.indexOf(startMarker, anchorStart + anchorMarker.length);
    const branchEnd = serviceWorkerSource.indexOf(endMarker, branchStart + startMarker.length);
    assert.ok(
      anchorStart >= 0 && branchStart > anchorStart && branchEnd > branchStart,
      `${label} branch was not found`,
    );
    const branchSource = serviceWorkerSource.slice(branchStart, branchEnd);
    assert.match(
      branchSource,
      /serverSessionEnded:\s*false/,
      `${label} must preserve exact manual-session recovery`,
    );
    assert.doesNotMatch(
      branchSource,
      /serverSessionEnded:\s*true/,
      `${label} must not claim that an uncorrelated session already ended`,
    );
  }

  let context;
  let navigationFixtureServer;
  const serviceWorkerErrors = [];
  try {
    const fixture = await startNavigationFixtureServer();
    navigationFixtureServer = fixture.server;
    context = await launchTestContext(executablePath);

    let worker = await waitForInitialWorker(context);
    attachWorkerErrorCapture(worker, serviceWorkerErrors);
    const trustedAccessFailure = await worker.evaluate(async () => {
      const order = [];
      const fakeStorage = {
        setAccessLevel(options, callback) {
          order.push(`access:${options?.accessLevel || ''}`);
          callback();
        },
        remove(key, callback) {
          order.push(`remove:${key}`);
          callback();
        },
      };
      let rejected = false;
      try {
        await restrictLocalStorageToTrustedContexts(fakeStorage, {
          lastError: { message: 'simulated access-level failure' },
        });
      } catch {
        rejected = true;
      }
      return { order, rejected };
    });
    assert.deepEqual(trustedAccessFailure.order, [
      'access:TRUSTED_CONTEXTS',
      'remove:studentSessionRecoveryV1',
    ]);
    assert.equal(trustedAccessFailure.rejected, true);
    const trustedRecoveryStorage = await worker.evaluate(async ({ fixturePort }) => {
      await trustedLocalStorageAccessPromise;
      const marker = 'trusted-recovery-storage-marker';
      await chrome.storage.local.set({
        [STUDENT_SESSION_RECOVERY_STORAGE_KEY]: { marker },
      });
      const tab = await chrome.tabs.create({
        url: `http://storage-privacy.localhost:${fixturePort}/recovery-storage`,
        active: false,
      });
      try {
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const current = await chrome.tabs.get(tab.id);
          if (current.status === 'complete') break;
          await new Promise((resolvePoll) => setTimeout(resolvePoll, 25));
        }
        const workerValue = await chrome.storage.local.get(
          STUDENT_SESSION_RECOVERY_STORAGE_KEY,
        );
        const [contentResult] = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          world: 'ISOLATED',
          func: async () => {
            try {
              const stored = await chrome.storage.local.get('studentSessionRecoveryV1');
              return {
                readable: true,
                marker: stored.studentSessionRecoveryV1?.marker || null,
              };
            } catch {
              return { readable: false, marker: null };
            }
          },
        });
        return {
          workerMarker: workerValue[STUDENT_SESSION_RECOVERY_STORAGE_KEY]?.marker || null,
          contentReadable: contentResult?.result?.readable === true,
          contentMarker: contentResult?.result?.marker || null,
        };
      } finally {
        await chrome.storage.local.remove(STUDENT_SESSION_RECOVERY_STORAGE_KEY);
        await chrome.tabs.remove(tab.id).catch(() => {});
      }
    }, { fixturePort: fixture.port });
    assert.equal(trustedRecoveryStorage.workerMarker, 'trusted-recovery-storage-marker');
    assert.equal(trustedRecoveryStorage.contentMarker, null);
    // Chrome versions differ on whether an untrusted get rejects or returns
    // an empty object; neither result may expose the recovery capability.
    assert.equal(
      trustedRecoveryStorage.contentReadable && Boolean(trustedRecoveryStorage.contentMarker),
      false,
    );
    const initialNow = Date.now();
    const initial = await worker.evaluate(async ({ now }) => {
      await authStateRestorePromise.catch(() => {});
      await classroomStateRestorePromise.catch(() => {});
      await studentAuthMutationTail.catch(() => {});
      CONFIG.serverUrl = 'https://school-pilot.net';
      CONFIG.schoolId = 'integration-school';
      CONFIG.deviceId = 'diagnostic-device';
      CONFIG.activeStudentId = 'diagnostic-student';
      CONFIG.activeStudentSessionId = 'diagnostic-student-session';
      CONFIG.studentToken = 'diagnostic-token';
      CONFIG.authContextId = 'diagnostic-auth-context';
      CONFIG.identitySource = 'integration_test';
      CONFIG.autoRegistrationPaused = false;
      studentAuthInvalidating = false;
      studentAuthCommitPending = false;
      studentAuthCommitPendingGeneration = 0;
      await chrome.storage.local.set({
        deviceId: CONFIG.deviceId,
        config: persistedNonAuthConfig(CONFIG),
      });
      await scheduleAuthGateRosterContextReconcile();
      await setManualAuthState({
        activeStudentId: CONFIG.activeStudentId,
        activeStudentSessionId: CONFIG.activeStudentSessionId,
        studentToken: CONFIG.studentToken,
        authContextId: CONFIG.authContextId,
        identitySource: CONFIG.identitySource,
        registered: true,
      });
      activateAuthenticatedContext(CONFIG.authContextId);
      const authContext = captureAuthenticatedContext('resilience initial fixture');
      adoptLicenseState(true, 'active', authContext);
      trackingState = TRACKING_STATES.ACTIVE;
      await updateGlobalBlacklistRules(['school-policy.example'], {
        scope: schoolPolicyScope(),
      });
      const application = await applyClassroomState({
        schemaVersion: 1,
        revision: 42,
        teachingSessionId: 'integration-session',
        receivedAt: now,
        hardExpiresAt: now + 60 * 60 * 1000,
        restrictions: {
          flightPath: {
            active: true,
            allowedDomains: ['allowed.example'],
            name: 'Integration Flight Path',
          },
          blockList: {
            active: true,
            blockedDomains: ['teacher-block.example'],
            name: 'Integration Block List',
          },
          temporaryAllows: [{
            domain: 'teacher-block.example',
            expiresAt: now + 30 * 60 * 1000,
          }, {
            // A teacher allow may coexist with a school rule but must never
            // outrank it in Chrome's DNR conflict resolution.
            domain: 'school-policy.example',
            expiresAt: now + 30 * 60 * 1000,
          }],
          attentionMode: { active: true, message: 'Integration check' },
          tabLimit: 5,
        },
      }, { authContext });
      return {
        application,
        ruleIds: (await chrome.declarativeNetRequest.getDynamicRules())
          .map((rule) => rule.id)
          .sort((a, b) => a - b),
        policyRules: (await chrome.declarativeNetRequest.getDynamicRules())
          .filter((rule) => rule.condition?.requestDomains?.includes('school-policy.example'))
          .map((rule) => ({ id: rule.id, priority: rule.priority, action: rule.action.type })),
        storedRevision: (await chrome.storage.local.get('classroomControlStateV1'))
          .classroomControlStateV1?.revision,
        runtime: await getClassroomCommandStateSnapshot(),
      };
    }, { now: initialNow });

    assert.equal(initial.application.outcome, 'applied');
    assert.equal(initial.storedRevision, 42);
    assert.deepEqual(initial.ruleIds, [1, 1000, 2000, 3000, 3001]);
    const schoolPolicyBlock = initial.policyRules.find((rule) => rule.action === 'block');
    const schoolPolicyAllow = initial.policyRules.find((rule) => rule.action === 'allow');
    assert.equal(schoolPolicyBlock.action, 'block');
    assert.equal(schoolPolicyAllow.action, 'allow');
    assert.ok(schoolPolicyBlock.priority > schoolPolicyAllow.priority);
    assert.equal(initial.runtime.attentionModeActive, true);
    assert.equal(initial.runtime.currentMaxTabs, 5);

    const recoveryPrivacyAndBackoff = await worker.evaluate(async () => {
      const originalConfig = { ...CONFIG };
      const originalPolicyGeneration = managedAuthGatePolicyGeneration;
      try {
        CONFIG = {
          ...CONFIG,
          schoolId: 'privacy-school',
          studentName: 'Privacy Student',
          studentEmail: 'privacy@example.invalid',
          classId: 'privacy-class',
          studentToken: 'reusable-bearer-must-not-leave-worker',
          deviceId: 'device-id-must-not-leave-worker',
          activeStudentId: 'student-id-must-not-leave-worker',
          activeStudentSessionId: 'session-id-must-not-leave-worker',
          enrollmentKey: 'enrollment-key-must-not-leave-worker',
        };
        const popupConfig = getPublishablePopupConfig();
        const serializedPopupConfig = JSON.stringify(popupConfig);

        resetLoginRosterRuntimeCache();
        const cacheKey = loginRosterRequestCacheKey('7', null);
        loginRosterCache.set(cacheKey, {
          data: { success: true, students: [], grades: [], refreshAfterMs: 30_000 },
          fetchedAt: Date.now() - LOGIN_ROSTER_CACHE_MIN_AGE_MS - 1,
        });
        recordLoginRosterBackoff(cacheKey, 30_000);
        const cachedDuringBackoff = await fetchLoginRosterForGate({ gradeLevel: '7' });
        const uncachedKey = loginRosterRequestCacheKey('8', null);
        recordLoginRosterBackoff(uncachedKey, 30_000);
        const unavailableDuringBackoff = await fetchLoginRosterForGate({ gradeLevel: '8' });

        const rosterContextBefore = currentAuthGateRosterContextGeneration();
        await scheduleAuthGateRosterContextReconcile();
        const rosterContextAfter = currentAuthGateRosterContextGeneration();
        return {
          popupConfig,
          serializedPopupConfig,
          cachedDuringBackoff,
          unavailableDuringBackoff,
          rosterContextBefore,
          rosterContextAfter,
        };
      } finally {
        managedAuthGatePolicyGeneration = originalPolicyGeneration;
        CONFIG = originalConfig;
        await scheduleAuthGateRosterContextReconcile();
        resetLoginRosterRuntimeCache();
      }
    });
    assert.deepEqual(Object.keys(recoveryPrivacyAndBackoff.popupConfig).sort(), [
      'classId',
      'hasStudentToken',
      'schoolId',
      'studentEmail',
      'studentName',
    ]);
    assert.equal(recoveryPrivacyAndBackoff.popupConfig.hasStudentToken, true);
    assert.doesNotMatch(recoveryPrivacyAndBackoff.serializedPopupConfig, /reusable-bearer|device-id|student-id|session-id|enrollment-key/);
    assert.equal(recoveryPrivacyAndBackoff.cachedDuringBackoff.success, true);
    assert.equal(recoveryPrivacyAndBackoff.cachedDuringBackoff.cached, true);
    assert.equal(recoveryPrivacyAndBackoff.cachedDuringBackoff.warning, true);
    assert.ok(recoveryPrivacyAndBackoff.cachedDuringBackoff.refreshAfterMs > 20_000);
    assert.equal(recoveryPrivacyAndBackoff.unavailableDuringBackoff.success, false);
    assert.equal(recoveryPrivacyAndBackoff.unavailableDuringBackoff.unavailable, true);
    assert.ok(recoveryPrivacyAndBackoff.unavailableDuringBackoff.refreshAfterMs > 20_000);
    assert.ok(recoveryPrivacyAndBackoff.rosterContextAfter > recoveryPrivacyAndBackoff.rosterContextBefore);

    const diagnosticsBeforeRestart = await worker.evaluate(async () => {
      CONFIG.deviceId = 'diagnostic-device';
      CONFIG.activeStudentId = 'diagnostic-student';
      CONFIG.activeStudentSessionId = 'diagnostic-student-session';
      CONFIG.studentToken = 'diagnostic-token';
      CONFIG.authContextId = 'diagnostic-auth-context';
      activateAuthenticatedContext(CONFIG.authContextId);
      const diagnosticAuthContext = captureAuthenticatedContext('diagnostic fixture');
      await chrome.storage.local.set({ deviceId: CONFIG.deviceId });
      await setManualAuthState({
        activeStudentId: CONFIG.activeStudentId,
        activeStudentSessionId: CONFIG.activeStudentSessionId,
        studentToken: CONFIG.studentToken,
        authContextId: CONFIG.authContextId,
        identitySource: 'integration_test',
        registered: true,
        classroomStateStudentBindingV1: CONFIG.activeStudentId,
      });
      adoptLicenseState(true, 'active', diagnosticAuthContext);
      trackingState = TRACKING_STATES.ACTIVE;

      const now = Date.now();
      await recordHeartbeatSuccess(now);
      const connected = connectivityStatus(now);
      const connectedBadge = await chrome.action.getBadgeText({});

      await recordHeartbeatFailure('network_error', now + 1);
      const reconnecting = connectivityStatus(now + 1);
      const reconnectingBadge = await chrome.action.getBadgeText({});

      connectivityHealth = {
        ...connectivityHealth,
        lastSuccessAt: now - RuntimeCore.CONNECTIVITY_UNREACHABLE_AFTER_MS,
        failureStartedAt: now - RuntimeCore.CONNECTIVITY_UNREACHABLE_AFTER_MS,
      };
      await chrome.storage.local.set({
        [CONNECTIVITY_HEALTH_STORAGE_KEY]: connectivityHealth,
      });
      await setConnectivityBadge(connectivityStatus(now));
      const unreachable = connectivityStatus(now);
      const unreachableBadge = await chrome.action.getBadgeText({});

      await recordHeartbeatSuccess(now);
      const restored = connectivityStatus(now);
      const restoredBadge = await chrome.action.getBadgeText({});
      const connectivityAlarm = await chrome.alarms.get(CONNECTIVITY_HEALTH_ALARM_NAME);

      await recordScreenshotAttempt(now - 3);
      await recordScreenshotError('capture_failed', now - 2);
      await recordScreenshotSuccess(now - 1);
      const stored = await chrome.storage.local.get([
        CONNECTIVITY_HEALTH_STORAGE_KEY,
        SCREENSHOT_HEALTH_STORAGE_KEY,
      ]);
      return {
        connected: connected.state,
        connectedBadge,
        reconnecting: reconnecting.state,
        reconnectingBadge,
        unreachable: unreachable.state,
        unreachableBadge,
        restored: restored.state,
        restoredBadge,
        connectivityAlarmAt: connectivityAlarm?.scheduledTime || null,
        rosterContextGeneration: currentAuthGateRosterContextGeneration(),
        stored,
      };
    });
    assert.equal(diagnosticsBeforeRestart.connected, 'connected');
    assert.equal(diagnosticsBeforeRestart.connectedBadge, '●');
    assert.equal(diagnosticsBeforeRestart.reconnecting, 'reconnecting');
    assert.equal(diagnosticsBeforeRestart.reconnectingBadge, '…');
    assert.equal(diagnosticsBeforeRestart.unreachable, 'unreachable');
    assert.equal(diagnosticsBeforeRestart.unreachableBadge, '!');
    assert.equal(diagnosticsBeforeRestart.restored, 'connected');
    assert.equal(diagnosticsBeforeRestart.restoredBadge, '●');
    assert.ok(diagnosticsBeforeRestart.connectivityAlarmAt > Date.now());
    assert.deepEqual(Object.keys(diagnosticsBeforeRestart.stored.connectivityHealthV1).sort(), [
      'consecutiveFailures',
      'errorCategory',
      'failureStartedAt',
      'lastFailureAt',
      'lastSuccessAt',
      'schemaVersion',
    ].sort());
    assert.deepEqual(Object.keys(diagnosticsBeforeRestart.stored.screenshotHealthV1).sort(), [
      'lastErrorAt',
      'lastErrorCode',
      'lastAttemptAt',
      'lastSuccessAt',
      'schemaVersion',
    ].sort());
    assert.equal(JSON.stringify(diagnosticsBeforeRestart.stored).includes('data:image'), false);
    assert.equal(JSON.stringify(diagnosticsBeforeRestart.stored).includes('base64'), false);

    // Closing Chrome is an authentication boundary in 2.7.3. Exact student
    // authority and its owner bindings disappear with storage.session; the
    // next worker clears stale teacher controls before accepting a fresh exact
    // binding. Ordinary MV3 suspension is covered separately and keeps this
    // session storage intact.
    await context.close();
    context = await launchTestContext(executablePath);
    worker = await waitForInitialWorker(context);
    attachWorkerErrorCapture(worker, serviceWorkerErrors);
    const restored = await worker.evaluate(async ({ now }) => {
      await authStateRestorePromise.catch(() => {});
      await classroomStateRestorePromise.catch(() => {});
      await studentAuthMutationTail.catch(() => {});
      const before = {
        authenticated: hasStudentAuth(),
        rosterContextGeneration: currentAuthGateRosterContextGeneration(),
        revision: currentClassroomState?.revision ?? null,
        ruleIds: (await chrome.declarativeNetRequest.getDynamicRules())
          .map((rule) => rule.id)
          .sort((a, b) => a - b),
        local: await chrome.storage.local.get([
          'authContextId',
          'activeStudentId',
          'activeStudentSessionId',
          'studentToken',
          'classroomStateStudentBindingV1',
        ]),
        session: await chrome.storage.session.get([
          'authContextId',
          'activeStudentId',
          'activeStudentSessionId',
          'studentToken',
          'classroomStateStudentBindingV1',
        ]),
      };

      CONFIG.serverUrl = 'https://school-pilot.net';
      CONFIG.schoolId = 'integration-school';
      CONFIG.deviceId = 'diagnostic-device';
      CONFIG.activeStudentId = 'diagnostic-student';
      CONFIG.activeStudentSessionId = 'diagnostic-student-session-next';
      CONFIG.studentToken = 'diagnostic-token-next';
      CONFIG.authContextId = 'diagnostic-auth-context-next';
      CONFIG.identitySource = 'integration_test';
      CONFIG.autoRegistrationPaused = false;
      studentAuthInvalidating = false;
      studentAuthCommitPending = false;
      studentAuthCommitPendingGeneration = 0;
      await setManualAuthState({
        activeStudentId: CONFIG.activeStudentId,
        activeStudentSessionId: CONFIG.activeStudentSessionId,
        studentToken: CONFIG.studentToken,
        authContextId: CONFIG.authContextId,
        identitySource: CONFIG.identitySource,
        registered: true,
      });
      activateAuthenticatedContext(CONFIG.authContextId);
      const authContext = captureAuthenticatedContext('resilience restart replacement');
      adoptLicenseState(true, 'active', authContext);
      trackingState = TRACKING_STATES.ACTIVE;
      await applyClassroomState({
        schemaVersion: 1,
        revision: 42,
        teachingSessionId: 'integration-session',
        receivedAt: now,
        hardExpiresAt: now + 60 * 60 * 1000,
        restrictions: {
          flightPath: {
            active: true,
            allowedDomains: ['allowed.example'],
            name: 'Integration Flight Path',
          },
          blockList: {
            active: true,
            blockedDomains: ['teacher-block.example'],
            name: 'Integration Block List',
          },
          temporaryAllows: [{
            domain: 'teacher-block.example',
            expiresAt: now + 30 * 60 * 1000,
          }, {
            domain: 'school-policy.example',
            expiresAt: now + 30 * 60 * 1000,
          }],
          attentionMode: { active: true, message: 'Integration check' },
          tabLimit: 5,
        },
      }, { authContext });
      return {
        before,
        revision: currentClassroomState?.revision,
        ruleIds: (await chrome.declarativeNetRequest.getDynamicRules())
          .map((rule) => rule.id)
          .sort((a, b) => a - b),
        runtime: await getClassroomCommandStateSnapshot(),
      };
    }, { now: Date.now() });
    assert.equal(restored.before.authenticated, false);
    assert.equal(
      restored.before.rosterContextGeneration,
      diagnosticsBeforeRestart.rosterContextGeneration,
    );
    assert.equal(restored.before.revision, null);
    assert.deepEqual(restored.before.local, {});
    assert.deepEqual(restored.before.session, {});
    assert.equal(restored.revision, 42);
    assert.deepEqual(restored.ruleIds, [1, 1000, 2000, 3000, 3001]);
    assert.equal(restored.runtime.attentionModeActive, true);
    assert.equal(restored.runtime.currentMaxTabs, 5);
    assert.deepEqual(restored.runtime.teacherBlockedDomains, ['teacher-block.example']);

    const restoredDiagnostics = await worker.evaluate(async () => ({
      connectivityHealth,
      screenshotHealth,
      lastScreenshotAttemptAt,
      lastScreenshotSuccessAt,
      lastScreenshotErrorAt,
      lastScreenshotError,
      storage: await chrome.storage.local.get(null),
    }));
    assert.equal(restoredDiagnostics.connectivityHealth.schemaVersion, 1);
    assert.equal(restoredDiagnostics.connectivityHealth.consecutiveFailures, 0);
    assert.equal(restoredDiagnostics.screenshotHealth.schemaVersion, 1);
    assert.equal(restoredDiagnostics.lastScreenshotAttemptAt,
      restoredDiagnostics.screenshotHealth.lastAttemptAt);
    assert.equal(restoredDiagnostics.lastScreenshotSuccessAt,
      restoredDiagnostics.screenshotHealth.lastSuccessAt);
    assert.equal(restoredDiagnostics.lastScreenshotErrorAt,
      restoredDiagnostics.screenshotHealth.lastErrorAt);
    assert.equal(restoredDiagnostics.lastScreenshotError, 'capture_failed');
    assert.equal(JSON.stringify(restoredDiagnostics.storage).includes('data:image'), false);

    const expiredTransient = await worker.evaluate(async () => {
      const expiredUrl = 'https://expired-command.example/should-not-open';
      const before = (await chrome.tabs.query({})).filter((tab) => tab.url === expiredUrl).length;
      const acknowledgements = [];
      const originalWsSend = wsSend;
      wsSend = (data) => acknowledgements.push(data);
      let result;
      let mismatchedExpired;
      try {
        result = await handleRemoteControl({
          type: 'open-tab',
          data: { url: expiredUrl },
        }, {
          commandId: 'expired-integration-command',
          studentId: CONFIG.activeStudentId,
          studentSessionId: CONFIG.activeStudentSessionId,
          deliveryPolicy: 'transient_action',
          expiresAt: new Date(Date.now() - 1).toISOString(),
        });
        mismatchedExpired = await handleRemoteControl({
          type: 'open-tab',
          data: { url: 'https://mismatched-expired.example/never-open' },
        }, {
          commandId: 'mismatched-expired-command',
          studentId: CONFIG.activeStudentId,
          studentSessionId: `${CONFIG.activeStudentSessionId}-retired`,
          deliveryPolicy: 'transient_action',
          expiresAt: new Date(Date.now() - 1).toISOString(),
        });
      } finally {
        wsSend = originalWsSend;
      }
      const after = (await chrome.tabs.query({})).filter((tab) => tab.url === expiredUrl).length;
      return { before, after, result, mismatchedExpired, acknowledgements };
    });
    assert.equal(expiredTransient.before, 0);
    assert.equal(expiredTransient.after, 0);
    assert.equal(expiredTransient.result.expired, true);
    assert.equal(expiredTransient.mismatchedExpired.rejected, true);
    assert.deepEqual(expiredTransient.acknowledgements.map((ack) => ack.ackState), ['expired']);
    assert.equal(expiredTransient.acknowledgements[0].bindingVersion, 2);
    assert.ok(expiredTransient.acknowledgements[0].studentSessionId);
    assert.ok(expiredTransient.acknowledgements[0].authContextId);

    const receivedBeforeExpiry = await worker.evaluate(async () => {
      const expiresAt = Date.now() + 100;
      const acknowledgements = [];
      const originalWsSend = wsSend;
      const originalExecute = executeRemoteControlCommand;
      wsSend = (data) => acknowledgements.push(data);
      executeRemoteControlCommand = async () => {
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 150));
        return { delayedCompletion: true };
      };
      try {
        await handleRemoteControl({
          type: 'open-tab',
          authority: { teachingSessionId: 'integration-session', supervisionContextId: null },
          data: { url: 'https://accepted.example' },
        }, {
          commandId: 'accepted-integration-command',
          studentId: CONFIG.activeStudentId,
          studentSessionId: CONFIG.activeStudentSessionId,
          deliveryPolicy: 'transient_action',
          expiresAt: new Date(expiresAt).toISOString(),
        });
      } finally {
        wsSend = originalWsSend;
        executeRemoteControlCommand = originalExecute;
      }
      return { expiresAt, acknowledgements };
    });
    assert.deepEqual(receivedBeforeExpiry.acknowledgements.map((ack) => ack.ackState), [
      'received',
      'completed',
    ]);
    assert.ok(Date.parse(receivedBeforeExpiry.acknowledgements[0].timestamp)
      < receivedBeforeExpiry.expiresAt);
    assert.ok(Date.parse(receivedBeforeExpiry.acknowledgements[1].timestamp)
      >= receivedBeforeExpiry.expiresAt);

    const schoolPolicyCloseAuthority = await worker.evaluate(async () => {
      const originalConfig = { ...CONFIG };
      const originalStoredConfig = await chrome.storage.local.get('config');
      const originalSchoolPolicyDomains = [...globalBlockedDomains];
      const originalExecute = executeRemoteControlCommand;
      const originalEnqueueMonitoringEvent = enqueueMonitoringEvent;
      const executions = [];
      CONFIG.schoolId = 'authority-school';
      const responseGuard = captureAuthenticatedResponseGuard();
      await adoptAuthenticatedStudentBinding({
        schoolId: 'authority-school',
        studentId: CONFIG.activeStudentId,
        studentSessionId: CONFIG.activeStudentSessionId,
      }, 'school-policy-bootstrap-fixture', responseGuard);
      enqueueMonitoringEvent = async () => {};
      executeRemoteControlCommand = async (command) => {
        executions.push(command.type);
        return { commandType: command.type, executed: true };
      };

      const run = (command, authority) => handleRemoteControl(command, {
        authority,
        studentId: CONFIG.activeStudentId,
        studentSessionId: CONFIG.activeStudentSessionId,
      });
      try {
        await run({
          type: 'close-tab',
          data: { tabRefs: ['authorized-opaque-tab-ref'] },
        }, {
          kind: 'school_policy',
          source: 'ai_safety',
          schoolId: 'authority-school',
        });
        const afterAuthorized = executions.length;
        const wrongSchool = await run({
          type: 'close-tab',
          data: { tabRefs: ['wrong-school-ref'] },
        }, {
          kind: 'school_policy',
          source: 'ai_safety',
          schoolId: 'different-school',
        });
        const afterWrongSchool = executions.length;
        const wrongSource = await run({
          type: 'close-tab',
          data: { tabRefs: ['wrong-source-ref'] },
        }, {
          kind: 'school_policy',
          source: 'school_settings',
          schoolId: 'authority-school',
        });
        const afterWrongSource = executions.length;
        const wrongType = await run({
          type: 'open-tab',
          data: { url: 'https://wrong-command-type.example' },
        }, {
          kind: 'school_policy',
          source: 'ai_safety',
          schoolId: 'authority-school',
        });
        return {
          executions,
          adoptedSchoolId: CONFIG.schoolId,
          persistedSchoolId: (await chrome.storage.local.get('config')).config?.schoolId,
          afterAuthorized,
          afterWrongSchool,
          afterWrongSource,
          wrongSchool,
          wrongSource,
          wrongType,
        };
      } finally {
        executeRemoteControlCommand = originalExecute;
        enqueueMonitoringEvent = originalEnqueueMonitoringEvent;
        CONFIG = originalConfig;
        await chrome.storage.local.remove('config');
        if (originalStoredConfig.config) await chrome.storage.local.set(originalStoredConfig);
        await updateGlobalBlacklistRules(originalSchoolPolicyDomains, {
          scope: schoolPolicyScope(),
        });
      }
    });
    assert.deepEqual(schoolPolicyCloseAuthority.executions, ['close-tab']);
    assert.equal(schoolPolicyCloseAuthority.adoptedSchoolId, 'authority-school');
    assert.equal(schoolPolicyCloseAuthority.persistedSchoolId, 'authority-school');
    assert.equal(schoolPolicyCloseAuthority.afterAuthorized, 1);
    assert.equal(schoolPolicyCloseAuthority.afterWrongSchool, 1);
    assert.equal(schoolPolicyCloseAuthority.afterWrongSource, 1);
    assert.equal(schoolPolicyCloseAuthority.wrongSchool.rejected, true);
    assert.equal(schoolPolicyCloseAuthority.wrongSource.rejected, true);
    assert.equal(schoolPolicyCloseAuthority.wrongType.rejected, true);

    const tabLimitAuthority = await worker.evaluate(async () => {
      const stateKeys = [
        CLASSROOM_STATE_STORAGE_KEY,
        CLASSROOM_STATE_FAILSAFE_EXPIRY_KEY,
        CLASSROOM_STATE_STUDENT_BINDING_KEY,
      ];
      const originalConfig = { ...CONFIG };
      const originalEnqueueMonitoringEvent = enqueueMonitoringEvent;
      const originalTeacherMaxTabs = teacherMaxTabs;
      const originalSchoolMaxTabs = schoolMaxTabs;
      const originalCurrentMaxTabs = currentMaxTabs;
      const originalClassroomState = currentClassroomState
        ? JSON.parse(JSON.stringify(currentClassroomState))
        : null;
      const originalStoredState = await getStoredAuthState(stateKeys);
      let result;

      try {
        CONFIG.schoolId = 'authority-school';
        enqueueMonitoringEvent = async () => {};
        teacherMaxTabs = 50;
        schoolMaxTabs = null;
        currentMaxTabs = effectiveTabLimit();
        const classroomStateBefore = JSON.stringify(currentClassroomState);
        const persistedStateBefore = JSON.stringify(
          (await chrome.storage.local.get(CLASSROOM_STATE_STORAGE_KEY))[CLASSROOM_STATE_STORAGE_KEY]
          ?? null
        );

        await handleRemoteControl({
          type: 'limit-tabs',
          data: { maxTabs: 40 },
        }, {
          studentId: CONFIG.activeStudentId,
          studentSessionId: CONFIG.activeStudentSessionId,
          authority: {
            kind: 'school_policy',
            source: 'school_settings',
            schoolId: 'authority-school',
          },
        });

        const schoolPolicy = {
          schoolMaxTabs,
          teacherMaxTabs,
          currentMaxTabs,
          classroomStateUnchanged: JSON.stringify(currentClassroomState) === classroomStateBefore,
          persistedStateUnchanged: JSON.stringify(
            (await chrome.storage.local.get(CLASSROOM_STATE_STORAGE_KEY))[CLASSROOM_STATE_STORAGE_KEY]
            ?? null
          ) === persistedStateBefore,
        };

        const teachingSessionId = currentClassroomState?.teachingSessionId;
        await handleRemoteControl({
          type: 'limit-tabs',
          data: { maxTabs: 30 },
        }, {
          studentId: CONFIG.activeStudentId,
          studentSessionId: CONFIG.activeStudentSessionId,
          authority: {
            kind: 'teaching_session',
            teachingSessionId,
          },
        });

        result = {
          teachingSessionId,
          schoolPolicy,
          sessionPolicy: {
            schoolMaxTabs,
            teacherMaxTabs,
            currentMaxTabs,
            persistedTabLimit: currentClassroomState?.restrictions?.tabLimit ?? null,
          },
        };
      } finally {
        CONFIG = originalConfig;
        enqueueMonitoringEvent = originalEnqueueMonitoringEvent;
        teacherMaxTabs = originalTeacherMaxTabs;
        schoolMaxTabs = originalSchoolMaxTabs;
        currentMaxTabs = originalCurrentMaxTabs;
        currentClassroomState = originalClassroomState;
        await kv.remove(stateKeys);
        if (Object.keys(originalStoredState).length > 0) {
          await kv.set(originalStoredState);
        }
        scheduleClassroomStateExpiry(currentClassroomState);
      }
      return result;
    });
    assert.equal(tabLimitAuthority.teachingSessionId, 'integration-session');
    assert.equal(tabLimitAuthority.schoolPolicy.schoolMaxTabs, 40);
    assert.equal(tabLimitAuthority.schoolPolicy.teacherMaxTabs, 50);
    assert.equal(tabLimitAuthority.schoolPolicy.currentMaxTabs, 40);
    assert.equal(tabLimitAuthority.schoolPolicy.classroomStateUnchanged, true);
    assert.equal(tabLimitAuthority.schoolPolicy.persistedStateUnchanged, true);
    assert.equal(tabLimitAuthority.sessionPolicy.schoolMaxTabs, 40);
    assert.equal(tabLimitAuthority.sessionPolicy.teacherMaxTabs, 30);
    assert.equal(tabLimitAuthority.sessionPolicy.currentMaxTabs, 30);
    assert.equal(tabLimitAuthority.sessionPolicy.persistedTabLimit, 30);

    const protocolResilience = await worker.evaluate(async ({ fixturePort }) => {
      const originalConfig = { ...CONFIG };
      const originalTrackingState = trackingState;
      const originalStudentAuthInvalidating = studentAuthInvalidating;
      // Quiesce real startup/transport maintenance before installing the
      // synthetic protocol identity. Otherwise a delayed registration,
      // heartbeat, or socket callback can legitimately retire authority
      // halfway through this long multi-command fixture.
      studentAuthInvalidating = true;
      advanceStudentAuthMutationGeneration();
      scheduleHeartbeat(null);
      await chrome.alarms.clear('heartbeat');
      const pendingRegistration = chromeProfileRegistrationInFlight;
      if (pendingRegistration) await pendingRegistration.catch(() => {});
      const heartbeatDrainDeadline = Date.now() + 5_000;
      while (heartbeatInFlight && Date.now() < heartbeatDrainDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (heartbeatInFlight) {
        throw new Error('Background heartbeat did not drain before protocol resilience fixture');
      }
      await studentAuthMutationTail.catch(() => {});
      // Keep alarm/event callbacks out of the synthetic identity until the
      // fixture restores the real worker state below.
      heartbeatInFlight = true;
      CONFIG.deviceId = 'protocol-device';
      CONFIG.activeStudentId = 'protocol-student';
      CONFIG.activeStudentSessionId = 'protocol-student-session';
      CONFIG.studentToken = 'protocol-token';
      CONFIG.schoolId = 'protocol-school';
      CONFIG.identitySource = 'integration_test';
      CONFIG.autoRegistrationPaused = true;
      studentAuthInvalidating = false;
      studentAuthCommitPending = false;
      advanceStudentAuthMutationGeneration();
      activateAuthenticatedContext(generateAuthContextId());
      trackingState = TRACKING_STATES.OFF;
      adoptNegotiatedProtocolState({
        serverProtocolVersion: 3,
        acceptedCapabilities: ['exactTabCloseV1'],
      }, captureAuthenticatedContext('protocol resilience capability fixture'));

      await discardCommandAckOutbox();
      wsConnected = false;
      await sendCommandAck('durable-ack-command', 'received', {
        commandType: 'open-tab',
        deliveryPolicy: 'transient_action',
      });
      const queuedAcks = (await kv.get(COMMAND_ACK_OUTBOX_KEY))
        [COMMAND_ACK_OUTBOX_KEY] || [];
      await handleWsMessage(JSON.stringify({
        type: 'command-ack-receipt',
        ackId: 'durable-ack-command:received',
        commandId: 'durable-ack-command',
        accepted: true,
      }));
      const remainingAcks = (await kv.get(COMMAND_ACK_OUTBOX_KEY))
        [COMMAND_ACK_OUTBOX_KEY] || [];
      const originalFetch = globalThis.fetch;
      let ackHttpBatch = null;
      let chatAckHttpBatch = null;
      await sendCommandAck('http-fallback-command', 'completed', {
        commandType: 'lock-screen',
        deliveryPolicy: 'persistent_control',
      });
      globalThis.fetch = async (url, init) => {
        if (String(url).endsWith('/api/classpilot/device/command-acks')) {
          ackHttpBatch = JSON.parse(init.body);
          return new Response(JSON.stringify({
            receipts: ackHttpBatch.acks.map((ack) => ({
              ackId: ack.ackId,
              commandId: ack.commandId,
              accepted: true,
            })),
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (String(url).endsWith('/api/classpilot/device/chat-acks')) {
          chatAckHttpBatch = JSON.parse(init.body);
          return new Response(JSON.stringify({
            receipts: chatAckHttpBatch.acks.map((ack) => ({
              ackId: ack.ackId,
              messageId: ack.messageId,
              accepted: true,
            })),
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        return originalFetch(url, init);
      };
      await flushCommandAckOutbox({ forceHttp: true });
      const chatAckAuthContext = captureAuthenticatedContext('chat ACK resilience fixture');
      const chatAckBinding = {
        studentId: chatAckAuthContext.studentId,
        studentSessionId: chatAckAuthContext.studentSessionId,
      };
      await sendChatDeliveryAck({
        chatMessageId: 'chat-http-message',
        sessionId: 'fab-session-a',
        ...chatAckBinding,
      }, 'delivered', null, chatAckAuthContext);
      await flushChatAckOutbox({ forceHttp: true });
      globalThis.fetch = originalFetch;
      const afterHttpFallback = (await kv.get(COMMAND_ACK_OUTBOX_KEY))
        [COMMAND_ACK_OUTBOX_KEY] || [];
      await sendChatDeliveryAck({
        chatMessageId: 'chat-ws-message',
        ...chatAckBinding,
      }, 'delivered', null, chatAckAuthContext);
      const queuedChatAcks = (await kv.get(CHAT_ACK_OUTBOX_KEY))
        [CHAT_ACK_OUTBOX_KEY] || [];
      await handleWsMessage(JSON.stringify({
        type: 'chat-message-ack-receipt',
        ackId: 'chat:chat-ws-message:delivered',
        messageId: 'chat-ws-message',
        accepted: true,
      }));
      const remainingChatAcks = (await kv.get(CHAT_ACK_OUTBOX_KEY))
        [CHAT_ACK_OUTBOX_KEY] || [];

      const classroomRuntimeBeforeTabTest = classroomRuntimeBackup();
      screenLocked = false;
      lockedUrl = null;
      lockedDomain = null;
      allowedDomains = [];
      attentionModeActive = false;
      teacherMaxTabs = null;
      currentMaxTabs = null;
      await composeDynamicRules(['classroom']);
      const first = await chrome.tabs.create({
        url: `http://exact-one.localhost:${fixturePort}/one`,
        active: false,
      });
      const second = await chrome.tabs.create({
        url: `http://exact-two.localhost:${fixturePort}/two`,
        active: false,
      });
      const waitForLoaded = async (tabId) => {
        const deadline = Date.now() + 5_000;
        while (Date.now() < deadline) {
          const tab = await chrome.tabs.get(tabId);
          if (tab.status === 'complete') return;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
      };
      await Promise.all([waitForLoaded(first.id), waitForLoaded(second.id)]);
      const exactSnapshot = await buildOpaqueTabSnapshot(await chrome.tabs.query({}));
      const firstEntry = exactSnapshot.localEntries.find((entry) => entry.tabId === first.id);
      const secondEntry = exactSnapshot.localEntries.find((entry) => entry.tabId === second.id);
      // Background transport teardown is intentionally allowed to retire
      // negotiated protocol state. Re-establish the fixture's capability at
      // the command boundary so this assertion measures exact-tab authority,
      // not nondeterministic WebSocket maintenance from another test phase.
      adoptNegotiatedProtocolState({
        serverProtocolVersion: 3,
        acceptedCapabilities: ['exactTabCloseV1'],
      }, captureAuthenticatedContext('exact-tab resilience command fixture'));
      const exactResult = await executeRemoteControlCommand({
        type: 'close-tab',
        data: {
          tabRefs: [firstEntry.tabRef],
          snapshotRevision: exactSnapshot.revision,
        },
      });
      const firstStillOpen = await chrome.tabs.get(first.id).then(() => true).catch(() => false);
      const extra = await chrome.tabs.create({
        url: `http://exact-three.localhost:${fixturePort}/three`,
        active: false,
      });
      await waitForLoaded(extra.id);
      let staleCode = null;
      try {
        await resolveExactTabRefs([secondEntry.tabRef], exactSnapshot.revision);
      } catch (error) {
        staleCode = error.code;
      }
      let missingRevisionCode = null;
      try {
        await resolveExactTabRefs([secondEntry.tabRef], null);
      } catch (error) {
        missingRevisionCode = error.code;
      }
      const duplicateUrl = `http://duplicate-target.localhost:${fixturePort}/same`;
      const duplicateOne = await chrome.tabs.create({ url: duplicateUrl, active: false });
      const duplicateTwo = await chrome.tabs.create({ url: duplicateUrl, active: false });
      await Promise.all([waitForLoaded(duplicateOne.id), waitForLoaded(duplicateTwo.id)]);
      let ambiguousLegacyCode = null;
      try {
        await resolveUniqueLegacyTabUrls([duplicateUrl]);
      } catch (error) {
        ambiguousLegacyCode = error.code;
      }
      let fuzzyPatternCode = null;
      try {
        await executeRemoteControlCommand({
          type: 'close-tab',
          data: { pattern: 'duplicate-target' },
        });
      } catch (error) {
        fuzzyPatternCode = error.code;
      }
      const duplicatesStillOpen = await Promise.all([
        chrome.tabs.get(duplicateOne.id).then(() => true).catch(() => false),
        chrome.tabs.get(duplicateTwo.id).then(() => true).catch(() => false),
      ]);
      await chrome.tabs.remove([
        second.id,
        extra.id,
        duplicateOne.id,
        duplicateTwo.id,
      ]).catch(() => {});
      restoreClassroomRuntimeBackup(classroomRuntimeBeforeTabTest);
      await composeDynamicRules(['classroom']);

      const classroomStateBeforeFabTests = currentClassroomState;
      currentClassroomState = null;
      await applyFabSettings({
        schemaVersion: 1,
        revision: 10,
        ownershipRevision: 20,
        teachingSessionId: 'fab-session-a',
        activeSessionIds: ['fab-session-a'],
        messagingEnabled: true,
        handRaisingEnabled: true,
        handRaised: false,
        reason: 'session-started',
      }, { broadcast: false });
      await kv.set({
        fabChatMessages: [{ sender: 'teacher', text: 'same session survives' }],
        fabChatClosed: false,
      });
      await handleWsMessage(JSON.stringify({
        type: 'fab-state-sync',
        data: {
          studentId: CONFIG.activeStudentId,
          studentSessionId: CONFIG.activeStudentSessionId,
          schemaVersion: 1,
          revision: 11,
          ownershipRevision: 20,
          teachingSessionId: 'fab-session-a',
          activeSessionIds: ['fab-session-a'],
          messagingEnabled: true,
          handRaisingEnabled: true,
          handRaised: true,
          reason: 'settings-updated',
        },
      }));
      const directFabState = (await kv.get(FAB_STATE_STORAGE_KEY))
        [FAB_STATE_STORAGE_KEY];
      await applyFabSettings({
        schemaVersion: 1,
        revision: 12,
        ownershipRevision: 20,
        teachingSessionId: 'fab-session-a',
        activeSessionIds: ['fab-session-a'],
        messagingEnabled: true,
        handRaisingEnabled: true,
        handRaised: true,
        reason: 'heartbeat_reconcile',
      }, { broadcast: false });
      const sameSessionChat = (await kv.get('fabChatMessages')).fabChatMessages;

      await persistTimerOverlay({
        type: 'timer',
        data: { action: 'start', seconds: 60, message: 'One minute', sessionId: 'fab-session-a' },
      }, { commandId: 'timer-command' });
      await persistPollOverlay({
        type: 'poll',
        data: {
          action: 'start',
          pollId: 'poll-one',
          question: 'Ready?',
          options: ['Yes', 'No'],
          sessionId: 'fab-session-a',
        },
      }, { commandId: 'poll-command' });
      const restoredOverlays = await getRestorableClassroomOverlayState();

      await handleWsMessage(JSON.stringify({
        type: 'student-session-ended',
        studentId: CONFIG.activeStudentId,
        studentSessionId: CONFIG.activeStudentSessionId,
        fabState: {
          studentId: CONFIG.activeStudentId,
          studentSessionId: CONFIG.activeStudentSessionId,
          schemaVersion: 1,
          revision: 0,
          ownershipRevision: 21,
          teachingSessionId: null,
          activeSessionIds: [],
          messagingEnabled: false,
          handRaisingEnabled: false,
          handRaised: false,
          reason: 'session-ended',
        },
      }));
      const directEndedState = (await kv.get(FAB_STATE_STORAGE_KEY))
        [FAB_STATE_STORAGE_KEY];
      const directEndedOverlays = await getRestorableClassroomOverlayState();

      await applyFabSettings({
        schemaVersion: 1,
        revision: 1,
        ownershipRevision: 22,
        teachingSessionId: 'fab-session-b',
        activeSessionIds: ['fab-session-b'],
        messagingEnabled: true,
        handRaisingEnabled: true,
        handRaised: true,
        reason: 'session-replaced',
      }, { broadcast: false });
      const replaced = await kv.get(['fabChatMessages', 'fabChatClosed']);
      const clearedOverlays = await getRestorableClassroomOverlayState();

      await applyFabSettings({
        schemaVersion: 1,
        revision: 13,
        ownershipRevision: 20,
        teachingSessionId: 'fab-session-a',
        activeSessionIds: ['fab-session-a'],
        messagingEnabled: false,
        handRaisingEnabled: false,
        handRaised: false,
        reason: 'delayed-old-session',
      }, { broadcast: false });
      const afterDelayedFabState = (await kv.get(FAB_STATE_STORAGE_KEY))
        [FAB_STATE_STORAGE_KEY];
      const delayedToggle = await handleRemoteControl({
        type: 'messaging-toggle',
        authority: {
          teachingSessionId: 'fab-session-a',
          supervisionContextId: null,
        },
        data: { enabled: false },
      }, {
        studentId: CONFIG.activeStudentId,
        studentSessionId: CONFIG.activeStudentSessionId,
      });
      const delayedDismissal = await handleRemoteControl({
        type: 'hand-dismissed',
        authority: {
          teachingSessionId: 'fab-session-a',
          supervisionContextId: null,
        },
        data: {},
      }, {
        studentId: CONFIG.activeStudentId,
        studentSessionId: CONFIG.activeStudentSessionId,
      });
      const afterDelayedCommands = (await kv.get(FAB_STATE_STORAGE_KEY))
        [FAB_STATE_STORAGE_KEY];

      const directToggleAuthContext = captureAuthenticatedContext(
        'same-session delayed legacy toggle fixture',
      );
      const directToggleBinding = {
        studentId: directToggleAuthContext.studentId,
        studentSessionId: directToggleAuthContext.studentSessionId,
      };
      await executeRemoteControlCommand({
        type: 'messaging-toggle',
        data: { enabled: false, revision: 0 },
      }, {
        authContext: directToggleAuthContext,
        binding: directToggleBinding,
        envelope: directToggleBinding,
      });
      const afterSameSessionDelayedLegacyToggle = (
        await kv.get(FAB_STATE_STORAGE_KEY)
      )[FAB_STATE_STORAGE_KEY];

      await Promise.all([
        applyFabSettings({
          schemaVersion: 1,
          revision: 1,
          ownershipRevision: 23,
          teachingSessionId: 'fab-session-c',
          activeSessionIds: ['fab-session-c'],
          messagingEnabled: true,
          handRaisingEnabled: true,
          handRaised: false,
          reason: 'concurrent-replacement',
        }, { broadcast: false }),
        applyFabSettings({
          schemaVersion: 1,
          revision: 99,
          ownershipRevision: 20,
          teachingSessionId: 'fab-session-a',
          activeSessionIds: ['fab-session-a'],
          messagingEnabled: false,
          handRaisingEnabled: false,
          handRaised: false,
          reason: 'concurrent-delayed-old-session',
        }, { broadcast: false }),
      ]);
      const afterConcurrentFabState = (await kv.get(FAB_STATE_STORAGE_KEY))
        [FAB_STATE_STORAGE_KEY];

      await clearFabAndOverlayState('integration-protocol-cleanup', { closeChat: true });
      await kv.remove(TAB_SNAPSHOT_STORAGE_KEY);
      await new Promise((resolve) => setTimeout(resolve, 1_600));
      currentClassroomState = classroomStateBeforeFabTests;
      studentAuthInvalidating = true;
      advanceStudentAuthMutationGeneration();
      heartbeatInFlight = false;
      CONFIG = originalConfig;
      studentAuthInvalidating = originalStudentAuthInvalidating;
      if (
        CONFIG.deviceId
        && CONFIG.activeStudentId
        && CONFIG.activeStudentSessionId
        && CONFIG.studentToken
      ) {
        advanceStudentAuthMutationGeneration();
        activateAuthenticatedContext(generateAuthContextId());
      }
      trackingState = originalTrackingState;
      return {
        descriptor: extensionProtocolDescriptor(),
        queuedAckIds: queuedAcks.map((ack) => ack.ackId),
        remainingAckIds: remainingAcks.map((ack) => ack.ackId),
        ackHttpIds: ackHttpBatch?.acks?.map((ack) => ack.ackId) || [],
        afterHttpFallbackIds: afterHttpFallback.map((ack) => ack.ackId),
        chatAckHttpIds: chatAckHttpBatch?.acks?.map((ack) => ack.ackId) || [],
        queuedChatAckIds: queuedChatAcks.map((ack) => ack.ackId),
        remainingChatAckIds: remainingChatAcks.map((ack) => ack.ackId),
        exactResult,
        firstStillOpen,
        staleCode,
        missingRevisionCode,
        ambiguousLegacyCode,
        fuzzyPatternCode,
        duplicatesStillOpen,
        directFabState,
        directEndedState,
        directEndedOverlays,
        sameSessionChat,
        restoredTimerCommandId: restoredOverlays.timer?.commandId,
        restoredPollId: restoredOverlays.poll?.pollId,
        replaced,
        clearedOverlays,
        afterDelayedFabState,
        delayedToggle,
        delayedDismissal,
        afterDelayedCommands,
        afterSameSessionDelayedLegacyToggle,
        afterConcurrentFabState,
      };
    }, { fixturePort: fixture.port });
    assert.equal(protocolResilience.descriptor.clientProtocolVersion, 3);
    assert.ok(protocolResilience.descriptor.capabilities.includes('scopedAuthorityChecksV1'));
    assert.ok(protocolResilience.descriptor.capabilities.includes('authBoundTelemetryV1'));
    assert.ok(protocolResilience.descriptor.capabilities.includes('exactBindingAckV2'));
    assert.ok(protocolResilience.descriptor.capabilities.includes('exactTabCloseV2'));
    assert.ok(protocolResilience.descriptor.capabilities.includes('kioskLaunchTicketV2'));
    assert.ok(protocolResilience.descriptor.capabilities.includes('commandAckReceiptV1'));
    assert.ok(protocolResilience.descriptor.capabilities.includes('classroomOverlayRestoreV1'));
    assert.deepEqual(protocolResilience.queuedAckIds, ['durable-ack-command:received']);
    assert.deepEqual(protocolResilience.remainingAckIds, []);
    assert.deepEqual(protocolResilience.ackHttpIds, ['http-fallback-command:completed']);
    assert.deepEqual(protocolResilience.afterHttpFallbackIds, []);
    assert.deepEqual(protocolResilience.chatAckHttpIds, ['chat:chat-http-message:delivered']);
    assert.deepEqual(protocolResilience.queuedChatAckIds, ['chat:chat-ws-message:delivered']);
    assert.deepEqual(protocolResilience.remainingChatAckIds, []);
    assert.equal(protocolResilience.exactResult.closedCount, 1);
    assert.equal(protocolResilience.exactResult.closedTabRefs.length, 1);
    assert.equal(protocolResilience.firstStillOpen, false);
    assert.equal(protocolResilience.staleCode, 'STALE_TAB_SNAPSHOT');
    assert.equal(protocolResilience.missingRevisionCode, 'TAB_SNAPSHOT_REVISION_REQUIRED');
    assert.equal(protocolResilience.ambiguousLegacyCode, 'AMBIGUOUS_TAB_URL');
    assert.equal(protocolResilience.fuzzyPatternCode, 'TAB_TARGET_REQUIRED');
    assert.deepEqual(protocolResilience.duplicatesStillOpen, [true, true]);
    assert.equal(protocolResilience.directFabState.handRaised, true);
    assert.deepEqual(protocolResilience.directFabState.activeSessionIds, ['fab-session-a']);
    assert.deepEqual(protocolResilience.directEndedState.activeSessionIds, []);
    assert.equal(protocolResilience.directEndedOverlays.timer, null);
    assert.equal(protocolResilience.directEndedOverlays.poll, null);
    assert.equal(protocolResilience.sameSessionChat[0].text, 'same session survives');
    assert.equal(protocolResilience.restoredTimerCommandId, 'timer-command');
    assert.equal(protocolResilience.restoredPollId, 'poll-one');
    assert.deepEqual(protocolResilience.replaced.fabChatMessages, []);
    assert.equal(protocolResilience.replaced.fabChatClosed, false);
    assert.equal(protocolResilience.clearedOverlays.timer, null);
    assert.equal(protocolResilience.clearedOverlays.poll, null);
    assert.deepEqual(protocolResilience.afterDelayedFabState.activeSessionIds, ['fab-session-b']);
    assert.equal(protocolResilience.afterDelayedFabState.ownershipRevision, 22);
    assert.equal(protocolResilience.delayedToggle.rejected, true);
    assert.equal(protocolResilience.delayedDismissal.rejected, true);
    assert.equal(protocolResilience.afterDelayedCommands.handRaised, true);
    assert.equal(protocolResilience.afterSameSessionDelayedLegacyToggle.messagingEnabled, true);
    assert.equal(protocolResilience.afterSameSessionDelayedLegacyToggle.revision, 1);
    assert.deepEqual(protocolResilience.afterConcurrentFabState.activeSessionIds, ['fab-session-c']);
    assert.equal(protocolResilience.afterConcurrentFabState.ownershipRevision, 23);

    const reconciliationNow = Date.now();
    const reconciled = await worker.evaluate(async ({ now }) => {
      const authContext = captureAuthenticatedContext('resilience classroom reconciliation');
      const authorityEnvelope = {
        studentId: authContext.studentId,
        studentSessionId: authContext.studentSessionId,
      };
      const cleared = await applyClassroomState({
        schemaVersion: 1,
        revision: 43,
        teachingSessionId: 'integration-session',
        receivedAt: now,
        hardExpiresAt: now + 60 * 60 * 1000,
        restrictions: {},
      }, { authContext, authorityEnvelope });
      const stale = await applyClassroomState({
        schemaVersion: 1,
        revision: 42,
        teachingSessionId: 'integration-session',
        receivedAt: now,
        hardExpiresAt: now + 60 * 60 * 1000,
        restrictions: {
          blockList: { active: true, blockedDomains: ['stale.example'] },
        },
      }, { authContext, authorityEnvelope });
      return {
        cleared,
        stale,
        revision: currentClassroomState?.revision,
        ruleIds: (await chrome.declarativeNetRequest.getDynamicRules())
          .map((rule) => rule.id)
          .sort((a, b) => a - b),
      };
    }, { now: reconciliationNow });

    assert.equal(reconciled.cleared.outcome, 'applied');
    assert.equal(reconciled.stale.outcome, 'stale');
    assert.equal(reconciled.revision, 43);
    assert.deepEqual(reconciled.ruleIds, [1000]);

    const concurrentNow = Date.now();
    const concurrent = await worker.evaluate(async ({ now }) => {
      const snapshot = (revision, domain) => ({
        schemaVersion: 1,
        revision,
        teachingSessionId: 'integration-session',
        receivedAt: now,
        hardExpiresAt: now + 60 * 60 * 1000,
        restrictions: {
          blockList: { active: true, blockedDomains: [domain] },
        },
      });
      const [newer, outOfOrder] = await Promise.all([
        applyClassroomState(snapshot(45, 'newer.example')),
        applyClassroomState(snapshot(44, 'out-of-order.example')),
      ]);
      return {
        newer,
        outOfOrder,
        revision: currentClassroomState?.revision,
        teacherBlockedDomains: [...teacherBlockedDomains],
      };
    }, { now: concurrentNow });
    assert.equal(concurrent.newer.outcome, 'applied');
    assert.equal(concurrent.outOfOrder.outcome, 'stale');
    assert.equal(concurrent.revision, 45);
    assert.deepEqual(concurrent.teacherBlockedDomains, ['newer.example']);

    const tabUrl = (host, path) => `http://${host}.localhost:${fixture.port}${path}`;
    const reconciliationUrls = {
      lock: tabUrl('lock', '/assignment'),
      outsideOne: tabUrl('outside', '/one'),
      outsideActive: tabUrl('outside', '/active'),
      otherTwo: tabUrl('other', '/two'),
      otherRemove: tabUrl('other', '/remove'),
      flightAllowed: tabUrl('flight', '/already-allowed'),
    };
    const existingTabReconciliation = await worker.evaluate(async ({ now, urls }) => {
      const effectiveUrl = (tab) => tab.pendingUrl || tab.url || '';
      const waitForTabState = async (predicate, timeoutMs = 5_000) => {
        const deadline = Date.now() + timeoutMs;
        let tabs = [];
        do {
          tabs = await chrome.tabs.query({});
          if (predicate(tabs)) return tabs;
          await new Promise((resolve) => setTimeout(resolve, 50));
        } while (Date.now() < deadline);
        return tabs;
      };

      await chrome.tabs.create({ url: 'chrome://version/', active: false });
      await chrome.tabs.create({ url: urls.outsideOne, active: true });
      await chrome.tabs.create({ url: urls.otherTwo, active: false });
      await applyClassroomState({
        schemaVersion: 1,
        revision: 46,
        teachingSessionId: 'integration-session',
        receivedAt: now,
        hardExpiresAt: now + 60 * 60 * 1000,
        restrictions: {
          screenLock: {
            active: true,
            url: urls.lock,
            domain: 'lock.localhost',
          },
        },
      });
      const afterLock = await waitForTabState((tabs) => {
        const webUrls = tabs.map(effectiveUrl).filter((url) => /^https?:\/\//.test(url));
        return webUrls.length === 1 && webUrls[0] === urls.lock;
      });

      await applyClassroomState({
        schemaVersion: 1,
        revision: 47,
        teachingSessionId: 'integration-session',
        receivedAt: now,
        hardExpiresAt: now + 60 * 60 * 1000,
        restrictions: {},
      });
      await chrome.tabs.create({ url: urls.flightAllowed, active: false });
      await chrome.tabs.create({ url: urls.outsideActive, active: true });
      await chrome.tabs.create({ url: urls.otherRemove, active: false });
      await applyClassroomState({
        schemaVersion: 1,
        revision: 48,
        teachingSessionId: 'integration-session',
        receivedAt: now,
        hardExpiresAt: now + 60 * 60 * 1000,
        restrictions: {
          flightPath: { active: true, allowedDomains: ['flight.localhost'] },
        },
      });
      const afterFlightPath = await waitForTabState((tabs) => {
        const webUrls = tabs.map(effectiveUrl).filter((url) => /^https?:\/\//.test(url));
        // The retained disallowed tab is redirected to the allowed domain's
        // canonical HTTPS origin. This local fixture only serves HTTP, so
        // Chromium may replace that redirected tab with chrome-error:// before
        // the poll observes it. The deterministic invariant is that at least
        // the pre-existing allowed tab remains and no disallowed web URL does.
        return webUrls.length >= 1 && webUrls.every((url) =>
          new URL(url).hostname === 'flight.localhost'
        );
      });
      const summary = (tabs) => ({
        internal: tabs
          .map(effectiveUrl)
          .filter((url) => url.startsWith('chrome://')),
        web: tabs
          .map(effectiveUrl)
          .filter((url) => /^https?:\/\//.test(url)),
      });
      return {
        afterLock: summary(afterLock),
        afterFlightPath: summary(afterFlightPath),
      };
    }, { now: Date.now(), urls: reconciliationUrls });
    assert.ok(existingTabReconciliation.afterLock.internal.length >= 1);
    assert.deepEqual(existingTabReconciliation.afterLock.web, [reconciliationUrls.lock]);
    assert.ok(existingTabReconciliation.afterFlightPath.internal.length >= 1);
    assert.ok(existingTabReconciliation.afterFlightPath.web.length >= 1);
    assert.ok(existingTabReconciliation.afterFlightPath.web.every((url) =>
      new URL(url).hostname === 'flight.localhost'
    ));

    const bestEffortTabFailure = await worker.evaluate(async ({ now }) => {
      const originalReconcile = reconcileExistingTabsForClassroomState;
      reconcileExistingTabsForClassroomState = async () => {
        throw new Error('simulated tab reconciliation failure');
      };
      let application;
      try {
        application = await applyClassroomState({
          schemaVersion: 1,
          revision: 49,
          teachingSessionId: 'integration-session',
          receivedAt: now,
          hardExpiresAt: now + 60 * 60 * 1000,
          restrictions: {
            blockList: { active: true, blockedDomains: ['best-effort.example'] },
          },
        });
      } finally {
        reconcileExistingTabsForClassroomState = originalReconcile;
      }
      const retryAlarm = await chrome.alarms.get(CLASSROOM_STATE_RECONCILE_ALARM);
      const stored = await chrome.storage.local.get(CLASSROOM_STATE_STORAGE_KEY);
      const ruleIds = (await chrome.declarativeNetRequest.getDynamicRules())
        .map((rule) => rule.id)
        .sort((a, b) => a - b);
      await reconcileClassroomStateTabsBestEffort(currentClassroomState);
      return {
        application,
        currentRevision: currentClassroomState?.revision,
        storedRevision: stored[CLASSROOM_STATE_STORAGE_KEY]?.revision,
        ruleIds,
        retryScheduled: Boolean(retryAlarm),
      };
    }, { now: Date.now() });
    assert.equal(bestEffortTabFailure.application.outcome, 'applied');
    assert.equal(bestEffortTabFailure.currentRevision, 49);
    assert.equal(bestEffortTabFailure.storedRevision, 49);
    assert.deepEqual(bestEffortTabFailure.ruleIds, [1000, 2000]);
    assert.equal(bestEffortTabFailure.retryScheduled, true);

    const failed = await worker.evaluate(async ({ now }) => {
      let errorMessage = '';
      try {
        await applyClassroomState({
          schemaVersion: 1,
          revision: 50,
          teachingSessionId: 'integration-session',
          receivedAt: now,
          hardExpiresAt: now + 60 * 60 * 1000,
          restrictions: {
            blockList: {
              active: true,
              blockedDomains: Array.from({ length: 1001 }, (_, index) => `blocked-${index}.example`),
            },
          },
        });
      } catch (error) {
        errorMessage = error?.message || String(error);
      }
      return {
        errorMessage,
        revision: currentClassroomState?.revision,
        reportedRevision: lastClassroomStateAckRevision,
        outcome: lastClassroomStateOutcome,
        teacherBlockedDomains: [...teacherBlockedDomains],
      };
    }, { now: Date.now() });
    assert.match(failed.errorMessage, /exceeds the 1,000 entry limit/);
    assert.equal(failed.revision, 49);
    assert.equal(failed.reportedRevision, 50);
    assert.equal(failed.outcome, 'failed');
    assert.deepEqual(failed.teacherBlockedDomains, ['best-effort.example']);

    const sharedDeviceStudentChange = await worker.evaluate(async ({ now }) => {
      // Fence the synthetic shared-device transition from the worker's real
      // heartbeat/auth tasks. Those tasks intentionally run in the background
      // and may otherwise restore the diagnostic fixture midway through this
      // deterministic state-reconciliation assertion.
      const wasInvalidating = studentAuthInvalidating;
      studentAuthMutationGeneration += 1;
      studentAuthInvalidating = true;
      scheduleHeartbeat(null);
      await chrome.alarms.clear('heartbeat');
      heartbeatPendingReason = null;
      apiBackoffUntilMs = Date.now() + 60_000;
      await disconnectWebSocket();
      const pendingRegistration = chromeProfileRegistrationInFlight;
      if (pendingRegistration) {
        await pendingRegistration.catch(() => {});
      }
      const heartbeatDrainDeadline = Date.now() + 5_000;
      while (heartbeatInFlight && Date.now() < heartbeatDrainDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (heartbeatInFlight) {
        throw new Error('Background heartbeat did not drain before the shared-device fixture');
      }
      await studentAuthMutationTail.catch(() => {});
      try {
        CONFIG.activeStudentId = 'previous-student';
        CONFIG.activeStudentSessionId = 'previous-student-session';
        await setManualAuthState({
          [CLASSROOM_STATE_STUDENT_BINDING_KEY]: CONFIG.activeStudentId,
        });
        CONFIG.activeStudentId = 'next-student';
        CONFIG.activeStudentSessionId = 'next-student-session-binding';
        await applyClassroomStateFromAuthResponse({
          classroomState: {
            schemaVersion: 1,
            revision: 1,
            teachingSessionId: 'next-student-session',
            receivedAt: now,
            hardExpiresAt: now + 60 * 60 * 1000,
            restrictions: {},
          },
        }, 'integration_student_change');
        const stored = await getStoredAuthState([
          CLASSROOM_STATE_STORAGE_KEY,
          CLASSROOM_STATE_STUDENT_BINDING_KEY,
        ]);
        return {
          revision: currentClassroomState?.revision,
          teachingSessionId: currentClassroomState?.teachingSessionId,
          storedRevision: stored[CLASSROOM_STATE_STORAGE_KEY]?.revision,
          studentBinding: stored[CLASSROOM_STATE_STUDENT_BINDING_KEY],
        };
      } finally {
        studentAuthInvalidating = wasInvalidating;
      }
    }, { now: Date.now() });
    assert.deepEqual(sharedDeviceStudentChange, {
      revision: 1,
      teachingSessionId: 'next-student-session',
      storedRevision: 1,
      studentBinding: 'next-student',
    });

    const explicitNullReconciliation = await worker.evaluate(async ({ now }) => {
      await applyClassroomState({
        schemaVersion: 1,
        revision: 2,
        teachingSessionId: 'next-student-session',
        receivedAt: now,
        hardExpiresAt: now + 60 * 60 * 1000,
        restrictions: {
          blockList: { active: true, blockedDomains: ['former-student.example'] },
        },
      });
      await applyClassroomStateFromAuthResponse({ classroomState: null }, 'integration_no_state');
      const stored = await getStoredAuthState([
        CLASSROOM_STATE_STORAGE_KEY,
        CLASSROOM_STATE_STUDENT_BINDING_KEY,
      ]);
      return {
        currentState: currentClassroomState,
        storedState: stored[CLASSROOM_STATE_STORAGE_KEY] || null,
        studentBinding: stored[CLASSROOM_STATE_STUDENT_BINDING_KEY],
        teacherBlockedDomains: [...teacherBlockedDomains],
        ruleIds: (await chrome.declarativeNetRequest.getDynamicRules())
          .map((rule) => rule.id)
          .sort((a, b) => a - b),
      };
    }, { now: Date.now() });
    assert.equal(explicitNullReconciliation.currentState, null);
    assert.equal(explicitNullReconciliation.storedState, null);
    assert.equal(explicitNullReconciliation.studentBinding, 'next-student');
    assert.deepEqual(explicitNullReconciliation.teacherBlockedDomains, []);
    assert.deepEqual(explicitNullReconciliation.ruleIds, [1000]);

    const expiryRetry = await worker.evaluate(async ({ now }) => {
      await applyClassroomState({
        schemaVersion: 1,
        revision: 3,
        teachingSessionId: 'next-student-session',
        receivedAt: now,
        hardExpiresAt: now + 60 * 60 * 1000,
        restrictions: {
          blockList: { active: true, blockedDomains: ['expiry-retry.example'] },
        },
      });
      currentClassroomState = { ...currentClassroomState, hardExpiresAt: now - 1 };
      await chrome.storage.local.set({
        [CLASSROOM_STATE_STORAGE_KEY]: currentClassroomState,
        [CLASSROOM_STATE_FAILSAFE_EXPIRY_KEY]: now - 1,
      });

      const originalCompose = composeDynamicRules;
      let firstError = '';
      composeDynamicRules = async () => {
        throw new Error('simulated expiry DNR failure');
      };
      try {
        await checkClassroomStateExpiry();
      } catch (error) {
        firstError = error?.message || String(error);
      } finally {
        composeDynamicRules = originalCompose;
      }
      const retryAlarm = await chrome.alarms.get(CLASSROOM_STATE_EXPIRY_ALARM);
      const afterFailure = await chrome.storage.local.get([
        CLASSROOM_STATE_STORAGE_KEY,
        CLASSROOM_STATE_FAILSAFE_EXPIRY_KEY,
      ]);
      const rulesAfterFailure = (await chrome.declarativeNetRequest.getDynamicRules())
        .map((rule) => rule.id)
        .sort((a, b) => a - b);

      await checkClassroomStateExpiry();
      const afterRetry = await chrome.storage.local.get([
        CLASSROOM_STATE_STORAGE_KEY,
        CLASSROOM_STATE_FAILSAFE_EXPIRY_KEY,
      ]);
      return {
        firstError,
        retryScheduled: Boolean(retryAlarm && retryAlarm.scheduledTime > now),
        failedStateStillRestricted: afterFailure[CLASSROOM_STATE_STORAGE_KEY]
          ?.restrictions?.blockList?.active === true,
        failedDeadlineRetained: afterFailure[CLASSROOM_STATE_FAILSAFE_EXPIRY_KEY] === now - 1,
        rulesAfterFailure,
        retriedStateRestricted: afterRetry[CLASSROOM_STATE_STORAGE_KEY]
          ?.restrictions?.blockList?.active === true,
        retriedDeadline: afterRetry[CLASSROOM_STATE_FAILSAFE_EXPIRY_KEY] || null,
        rulesAfterRetry: (await chrome.declarativeNetRequest.getDynamicRules())
          .map((rule) => rule.id)
          .sort((a, b) => a - b),
      };
    }, { now: Date.now() });
    assert.match(expiryRetry.firstError, /simulated expiry DNR failure/);
    assert.equal(expiryRetry.retryScheduled, true);
    assert.equal(expiryRetry.failedStateStillRestricted, true);
    assert.equal(expiryRetry.failedDeadlineRetained, true);
    assert.deepEqual(expiryRetry.rulesAfterFailure, [1000, 2000]);
    assert.equal(expiryRetry.retriedStateRestricted, false);
    assert.equal(expiryRetry.retriedDeadline, null);
    assert.deepEqual(expiryRetry.rulesAfterRetry, [1000]);

    // Continue later resilience cases from a clean authority scope. Revisions
    // are monotonic only within the currently bound student/scope.
    await worker.evaluate(async () => {
      await clearTeacherSessionStateForSignOut({ emitEvent: false, reason: 'integration_expiry_complete' });
    });

    const authBoundOutbox = await worker.evaluate(async () => {
      if (monitoringEventFlushTimer) {
        clearTimeout(monitoringEventFlushTimer);
        monitoringEventFlushTimer = null;
      }
      await chrome.alarms.clear(MONITORING_EVENT_FLUSH_ALARM);
      await monitoringEventMutation.catch(() => {});
      const before = await kv.get([
        MONITORING_EVENT_OUTBOX_KEY,
        MONITORING_EVENT_DROPPED_KEY,
      ]);
      const droppedBefore = Number(before[MONITORING_EVENT_DROPPED_KEY] || 0);
      const queuedBefore = Array.isArray(before[MONITORING_EVENT_OUTBOX_KEY])
        ? before[MONITORING_EVENT_OUTBOX_KEY].length
        : 0;
      CONFIG.deviceId = 'integration-device';
      CONFIG.activeStudentId = 'integration-student';
      CONFIG.studentToken = 'old-session-token';
      advanceStudentAuthMutationGeneration();
      activateAuthenticatedContext(generateAuthContextId());
      const scope = {
        teachingSessionId: 'integration-event-session',
        supervisionContextId: null,
      };
      await enqueueMonitoringEvent('navigation_changed', {
        url: 'https://example.com/old?secret=1',
        title: 'Old student event',
      }, scope);
      CONFIG.studentToken = 'new-session-token';
      advanceStudentAuthMutationGeneration();
      activateAuthenticatedContext(generateAuthContextId());
      await enqueueMonitoringEvent('navigation_changed', {
        url: 'https://example.com/new?secret=2',
        title: 'New student event',
      }, scope);
      if (monitoringEventFlushTimer) {
        clearTimeout(monitoringEventFlushTimer);
        monitoringEventFlushTimer = null;
      }
      await chrome.alarms.clear(MONITORING_EVENT_FLUSH_ALARM);
      const stored = await kv.get([
        MONITORING_EVENT_OUTBOX_KEY,
        MONITORING_EVENT_DROPPED_KEY,
        MONITORING_EVENT_AUTH_BINDING_KEY,
      ]);
      await kv.remove([
        MONITORING_EVENT_OUTBOX_KEY,
        MONITORING_EVENT_DROPPED_KEY,
        MONITORING_EVENT_AUTH_BINDING_KEY,
      ]);
      return {
        ...stored,
        droppedDelta: Number(stored[MONITORING_EVENT_DROPPED_KEY] || 0) - droppedBefore,
        expectedDroppedDelta: queuedBefore + 1,
      };
    });
    assert.equal(authBoundOutbox.monitoringEventOutboxV1.length, 1);
    assert.equal(authBoundOutbox.monitoringEventOutboxV1[0].title, 'New student event');
    assert.equal(authBoundOutbox.droppedDelta, authBoundOutbox.expectedDroppedDelta);
    assert.equal(authBoundOutbox.monitoringEventOutboxAuthBindingV1.includes('new-session-token'), false);

    const corruptSchoolPolicySetup = await worker.evaluate(async ({ now }) => {
      // Restart tests must persist one coherent exact auth/classroom binding.
      // Earlier cases intentionally mutate only selected identity fields to
      // exercise isolation; carrying that synthetic mismatch across a real
      // worker restart correctly triggers fail-closed cleanup and made this
      // policy-restoration assertion timing-dependent.
      CONFIG.deviceId = 'diagnostic-device';
      CONFIG.activeStudentId = 'diagnostic-student';
      CONFIG.activeStudentSessionId = 'diagnostic-student-session';
      CONFIG.studentToken = 'diagnostic-token';
      CONFIG.authContextId = generateAuthContextId();
      CONFIG.identitySource = 'integration_test';
      CONFIG.autoRegistrationPaused = true;
      studentAuthInvalidating = false;
      studentAuthCommitPending = false;
      await chrome.storage.local.set({
        deviceId: CONFIG.deviceId,
        autoRegistrationPaused: true,
      });
      await setManualAuthState({
        authContextId: CONFIG.authContextId,
        activeStudentId: CONFIG.activeStudentId,
        activeStudentSessionId: CONFIG.activeStudentSessionId,
        studentToken: CONFIG.studentToken,
        identitySource: CONFIG.identitySource,
        registered: true,
        [CLASSROOM_STATE_STUDENT_BINDING_KEY]: CONFIG.activeStudentId,
      });
      await chrome.storage.local.remove(STUDENT_AUTH_INVALIDATING_KEY);
      activateAuthenticatedContext(CONFIG.authContextId);
      const authContext = captureAuthenticatedContext('corrupt policy fixture');
      const application = await applyClassroomState({
        schemaVersion: 1,
        revision: 2,
        teachingSessionId: 'diagnostic-classroom-session',
        receivedAt: now,
        hardExpiresAt: now + 60 * 60 * 1000,
        restrictions: {
          blockList: { active: true, blockedDomains: ['teacher-survives.example'] },
        },
      }, { authContext });
      await chrome.storage.local.set({
        globalBlockedDomains: Array.from({ length: 1001 }, (_, index) => `corrupt-${index}.example`),
      });
      return {
        application,
        ruleIds: (await chrome.declarativeNetRequest.getDynamicRules())
          .map((rule) => rule.id)
          .sort((a, b) => a - b),
      };
    }, { now: Date.now() });
    assert.equal(corruptSchoolPolicySetup.application.outcome, 'applied');
    assert.deepEqual(corruptSchoolPolicySetup.ruleIds, [1000, 2000]);

    await context.close();
    context = await launchTestContext(executablePath);
    worker = await waitForInitialWorker(context);
    attachWorkerErrorCapture(worker, serviceWorkerErrors);
    const corruptSchoolPolicyRestore = await worker.evaluate(async () => {
      await authStateRestorePromise.catch(() => {});
      await classroomStateRestorePromise.catch(() => {});
      await studentAuthMutationTail.catch(() => {});
      return {
        authenticated: hasStudentAuth(),
        revision: currentClassroomState?.revision ?? null,
        teacherBlockedDomains: [...teacherBlockedDomains],
        ruleIds: (await chrome.declarativeNetRequest.getDynamicRules())
          .map((rule) => rule.id)
          .sort((a, b) => a - b),
      };
    });
    assert.equal(corruptSchoolPolicyRestore.authenticated, false);
    assert.equal(corruptSchoolPolicyRestore.revision, null);
    assert.deepEqual(corruptSchoolPolicyRestore.teacherBlockedDomains, []);

    await worker.evaluate(async () => {
      await chrome.storage.local.remove('globalBlockedDomains');
    });
    await context.close();
    context = await launchTestContext(executablePath);
    worker = await waitForInitialWorker(context);
    attachWorkerErrorCapture(worker, serviceWorkerErrors);
    const missingSchoolPolicyRestore = await worker.evaluate(async () => {
      await authStateRestorePromise.catch(() => {});
      await classroomStateRestorePromise.catch(() => {});
      await studentAuthMutationTail.catch(() => {});
      return {
        authenticated: hasStudentAuth(),
        revision: currentClassroomState?.revision ?? null,
        ruleIds: (await chrome.declarativeNetRequest.getDynamicRules())
          .map((rule) => rule.id)
          .sort((a, b) => a - b),
      };
    });
    assert.equal(missingSchoolPolicyRestore.authenticated, false);
    assert.equal(missingSchoolPolicyRestore.revision, null);

    const initialInbox = await worker.evaluate(async () => {
      CONFIG.deviceId = 'message-inbox-device';
      CONFIG.activeStudentId = 'message-inbox-student-a';
      CONFIG.studentEmail = 'student-a@example.edu';
      CONFIG.studentName = 'Student A';
      CONFIG.studentToken = 'message-inbox-session-a';
      CONFIG.activeStudentSessionId = 'message-inbox-binding-a';
      CONFIG.authContextId = generateAuthContextId();
      CONFIG.identitySource = 'integration_test';
      CONFIG.autoRegistrationPaused = true;
      studentAuthInvalidating = false;
      studentAuthCommitPending = false;
      await chrome.storage.local.set({
        deviceId: CONFIG.deviceId,
        autoRegistrationPaused: true,
      });
      await setManualAuthState({
        authContextId: CONFIG.authContextId,
        activeStudentId: CONFIG.activeStudentId,
        activeStudentSessionId: CONFIG.activeStudentSessionId,
        studentEmail: CONFIG.studentEmail,
        studentName: CONFIG.studentName,
        studentToken: CONFIG.studentToken,
        registered: true,
        lastRegisteredEmail: CONFIG.studentEmail,
        identitySource: CONFIG.identitySource,
      });
      activateAuthenticatedContext(CONFIG.authContextId);
      await clearStudentMessageState('integration-inbox-setup');
      const first = await persistHeartbeatPendingMessages([
        { id: 'pending-1', message: 'First pending message' },
        { id: 'pending-1', message: 'Duplicate transport copy' },
        { id: 'pending-2', message: 'Second pending message' },
      ]);
      const repeated = await persistHeartbeatPendingMessages([
        { id: 'pending-1', message: 'First pending message' },
        { id: 'pending-2', message: 'Second pending message' },
      ]);
      const stored = await kv.get([
        MESSAGE_INBOX_STORAGE_KEY,
        MESSAGE_INBOX_DEDUP_KEY,
        MESSAGE_INBOX_BINDING_KEY,
      ]);
      return { first, repeated, stored };
    });
    assert.deepEqual(initialInbox.first.addedMessageIds, ['pending-1', 'pending-2']);
    assert.deepEqual(initialInbox.repeated.addedMessageIds, []);
    assert.deepEqual(initialInbox.stored.messages.map((message) => message.id), ['pending-1', 'pending-2']);
    assert.deepEqual(initialInbox.stored.messageInboxSeenIdsV1, ['pending-1', 'pending-2']);
    assert.equal(initialInbox.stored.messageInboxAuthBindingV1.includes('message-inbox-session-a'), false);

    await context.close();
    context = await launchTestContext(executablePath);
    worker = await waitForInitialWorker(context);
    attachWorkerErrorCapture(worker, serviceWorkerErrors);
    await worker.evaluate(async () => {
      await authStateRestorePromise.catch(() => {});
      await classroomStateRestorePromise.catch(() => {});
      await studentAuthMutationTail.catch(() => {});
    });
    const restartedInbox = await worker.evaluate(async () => {
      CONFIG.deviceId = 'message-inbox-device';
      CONFIG.activeStudentId = 'message-inbox-student-a';
      CONFIG.activeStudentSessionId = 'message-inbox-binding-b';
      CONFIG.studentEmail = 'student-a@example.edu';
      CONFIG.studentName = 'Student A';
      CONFIG.studentToken = 'message-inbox-session-b';
      CONFIG.authContextId = generateAuthContextId();
      CONFIG.identitySource = 'integration_test';
      CONFIG.autoRegistrationPaused = true;
      studentAuthInvalidating = false;
      studentAuthCommitPending = false;
      await chrome.storage.local.set({
        deviceId: CONFIG.deviceId,
        autoRegistrationPaused: true,
      });
      await setManualAuthState({
        authContextId: CONFIG.authContextId,
        activeStudentId: CONFIG.activeStudentId,
        activeStudentSessionId: CONFIG.activeStudentSessionId,
        studentEmail: CONFIG.studentEmail,
        studentName: CONFIG.studentName,
        studentToken: CONFIG.studentToken,
        registered: true,
        lastRegisteredEmail: CONFIG.studentEmail,
        identitySource: CONFIG.identitySource,
      });
      activateAuthenticatedContext(CONFIG.authContextId);
      const before = await getCurrentMessageInbox();
      const merged = await persistHeartbeatPendingMessages([
        { id: 'pending-1', message: 'First pending message' },
        { id: 'pending-3', message: 'New after worker restart' },
      ]);
      return { before, merged };
    });
    assert.deepEqual(restartedInbox.before.map((message) => message.id), []);
    assert.deepEqual(restartedInbox.merged.addedMessageIds, ['pending-1', 'pending-3']);
    assert.deepEqual(restartedInbox.merged.messages.map((message) => message.id), [
      'pending-1',
      'pending-3',
    ]);

    const switchedInbox = await worker.evaluate(async () => {
      const previousBinding = messageInboxAuthBinding();
      const originalFetch = globalThis.fetch;
      // Linux CI can pause a headless extension worker for several seconds
      // under load. Keep this comfortably above the two-second event-heartbeat
      // coalescing window while retaining a hard failure bound.
      const reconciliationTimeoutMs = 15_000;
      const waitFor = (promise, label) => Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}`)),
          reconciliationTimeoutMs,
        )),
      ]);
      let firstHeartbeatStarted;
      let secondHeartbeatStarted;
      let resolveFirstHeartbeatStarted;
      let resolveSecondHeartbeatStarted;
      let resolveStudentAResponse;
      let resolveStudentBResponse;
      let heartbeatFetchCount = 0;
      firstHeartbeatStarted = new Promise((resolve) => { resolveFirstHeartbeatStarted = resolve; });
      secondHeartbeatStarted = new Promise((resolve) => { resolveSecondHeartbeatStarted = resolve; });
      const studentAResponse = new Promise((resolve) => { resolveStudentAResponse = resolve; });
      const studentBResponse = new Promise((resolve) => { resolveStudentBResponse = resolve; });

      globalThis.fetch = (url, init) => {
        if (String(url).includes('/api/device/heartbeat')) {
          heartbeatFetchCount += 1;
          if (heartbeatFetchCount === 1) {
            resolveFirstHeartbeatStarted();
            return studentAResponse;
          }
          if (heartbeatFetchCount === 2) {
            resolveSecondHeartbeatStarted();
            return studentBResponse;
          }
          return Promise.resolve(new Response('{}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }));
        }
        return originalFetch(url, init);
      };

      adoptLicenseState(
        true,
        'active',
        captureAuthenticatedContext('heartbeat race Student A'),
      );
      trackingState = TRACKING_STATES.ACTIVE;
      screenshotScheduled = false;
      apiBackoffUntilMs = 0;
      heartbeatInFlight = true; // Keep unrelated alarm callbacks out of the mock request slot.
      CONFIG.identitySource = 'manual_pin';
      CONFIG.manualLoginLastSeenAt = Date.now();
      const delayedStudentAHeartbeat = sendHeartbeat('integration-delayed-student-a');
      await waitFor(firstHeartbeatStarted, 'Student A heartbeat request');

      await chrome.storage.local.set({
        fabChatMessages: [{ sender: 'teacher', text: 'Private message for Student A' }],
        fabChatClosed: true,
      });

      // Hold the serialized inbox writer so an A-bound WebSocket/message write
      // is already queued when the authenticated identity changes to Student B.
      // The write must re-check its captured binding inside the queued mutation.
      let releaseInboxMutation;
      const inboxMutationBlocker = new Promise((resolve) => {
        releaseInboxMutation = resolve;
      });
      const blockerTask = enqueueMessageInboxMutation(() => inboxMutationBlocker);
      const queuedStudentAWrite = persistTeacherMessages([
        { id: 'queued-student-a', message: 'Queued before the identity switch' },
      ], {
        reason: 'integration-queued-identity-switch',
        expectedBinding: previousBinding,
      });

      CONFIG.activeStudentId = 'message-inbox-student-b';
      CONFIG.studentEmail = 'student-b@example.edu';
      CONFIG.studentName = 'Student B';
      CONFIG.studentToken = 'message-inbox-session-b';
      CONFIG.manualLoginLastSeenAt = Date.now() - 1_000;
      const studentBManualLastSeenAt = CONFIG.manualLoginLastSeenAt;
      const studentBConnectivity = RuntimeCore.connectivityHealthAfterFailure(
        RuntimeCore.connectivityHealthAfterSuccess(RuntimeCore.emptyConnectivityHealth(), Date.now() - 2_000),
        'network_error',
        Date.now() - 500
      );
      connectivityHealth = studentBConnectivity;
      const classroomRevisionBeforeStaleResponse = currentClassroomState?.revision ?? null;
      await chrome.storage.local.set({
        activeStudentId: CONFIG.activeStudentId,
        studentEmail: CONFIG.studentEmail,
        studentName: CONFIG.studentName,
        studentToken: CONFIG.studentToken,
        lastRegisteredEmail: CONFIG.studentEmail,
        identitySource: CONFIG.identitySource,
        manualLoginLastSeenAt: CONFIG.manualLoginLastSeenAt,
        [CONNECTIVITY_HEALTH_STORAGE_KEY]: connectivityHealth,
      });
      adoptLicenseState(
        true,
        'active',
        captureAuthenticatedContext('heartbeat race Student B'),
      );

      releaseInboxMutation();
      await blockerTask;
      const queuedStaleWrite = await queuedStudentAWrite;

      // Resolve Student A's request only after Student B is current. The whole
      // response—not just its inbox rows—must be ignored, then a B request made.
      heartbeatInFlight = false;
      resolveStudentAResponse(new Response(JSON.stringify({
        classroomState: {
          schemaVersion: 1,
          revision: 999,
          teachingSessionId: 'retired-student-a-class',
          receivedAt: Date.now(),
          hardExpiresAt: Date.now() + 60 * 60 * 1000,
          restrictions: {
            attentionMode: { active: true, message: 'Must not apply to Student B' },
          },
        },
        pendingMessages: [
          { id: 'late-student-a', message: 'Must not cross the identity switch' },
        ],
      }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
      await delayedStudentAHeartbeat;

      // The retired response must enqueue a reconciliation for the current
      // identity. Assert that production scheduling decision directly, then
      // dispatch the queued work without depending on headless Chrome's
      // service-worker timer throttling. CI may suspend the worker long enough
      // for the two-second coalescing timer to exceed this fixture's bound even
      // though the correct reconciliation was queued.
      const queuedReconciliationReason = eventHeartbeatReason;
      if (!eventHeartbeatTimer || queuedReconciliationReason !== 'identity-changed-reconcile') {
        throw new Error('Retired heartbeat did not queue Student B reconciliation');
      }
      clearTimeout(eventHeartbeatTimer);
      eventHeartbeatTimer = null;
      eventHeartbeatReason = null;
      const studentBReconciliation = safeSendHeartbeat(
        'integration-identity-changed-reconcile',
      );
      await waitFor(secondHeartbeatStarted, 'Student B reconciliation heartbeat');

      const beforeStudentBResponse = {
        classroomRevision: currentClassroomState?.revision ?? null,
        connectivityHealth: { ...connectivityHealth },
        manualLoginLastSeenAt: CONFIG.manualLoginLastSeenAt,
        inbox: await getCurrentMessageInbox(),
      };

      resolveStudentBResponse(new Response('{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }));
      const studentBReconciliationCompleted = await waitFor(
        studentBReconciliation,
        'Student B reconciliation heartbeat completion',
      );
      if (studentBReconciliationCompleted !== true || heartbeatInFlight) {
        throw new Error('Student B reconciliation heartbeat did not finish');
      }
      globalThis.fetch = originalFetch;

      // A direct pending-message retry carrying A's captured binding is also
      // rejected after the switch.
      const staleHeartbeat = await persistHeartbeatPendingMessages([
        { id: 'late-student-a', message: 'Must not cross the identity switch' },
      ], previousBinding);
      const newStudentMessage = await persistHeartbeatPendingMessages([
        { id: 'pending-1', message: 'Same id, new authenticated student' },
      ]);
      const afterSwitch = await kv.get([
        MESSAGE_INBOX_STORAGE_KEY,
        MESSAGE_INBOX_DEDUP_KEY,
        MESSAGE_INBOX_BINDING_KEY,
        'fabChatMessages',
        'fabChatClosed',
      ]);
      await clearStudentAuth('integration-sign-out', {
        notifyBackend: false,
        pauseAutoRegistration: true,
      });
      const afterSignOut = await kv.get([
        MESSAGE_INBOX_STORAGE_KEY,
        MESSAGE_INBOX_DEDUP_KEY,
        MESSAGE_INBOX_BINDING_KEY,
        'fabChatMessages',
        'fabChatClosed',
      ]);
      return {
        queuedStaleWrite,
        staleHeartbeat,
        newStudentMessage,
        afterSwitch,
        afterSignOut,
        beforeStudentBResponse,
        studentBConnectivity,
        studentBManualLastSeenAt,
        classroomRevisionBeforeStaleResponse,
        queuedReconciliationReason,
        heartbeatFetchCount,
      };
    });
    assert.deepEqual(switchedInbox.queuedStaleWrite.addedMessageIds, []);
    assert.deepEqual(switchedInbox.staleHeartbeat.addedMessageIds, []);
    assert.equal(switchedInbox.queuedReconciliationReason, 'identity-changed-reconcile');
    assert.equal(switchedInbox.heartbeatFetchCount, 2);
    assert.equal(
      switchedInbox.beforeStudentBResponse.classroomRevision,
      switchedInbox.classroomRevisionBeforeStaleResponse
    );
    assert.deepEqual(
      switchedInbox.beforeStudentBResponse.connectivityHealth,
      switchedInbox.studentBConnectivity
    );
    assert.equal(
      switchedInbox.beforeStudentBResponse.manualLoginLastSeenAt,
      switchedInbox.studentBManualLastSeenAt
    );
    assert.deepEqual(switchedInbox.beforeStudentBResponse.inbox, []);
    assert.deepEqual(switchedInbox.newStudentMessage.addedMessageIds, ['pending-1']);
    assert.deepEqual(switchedInbox.afterSwitch.messages.map((message) => message.message), [
      'Same id, new authenticated student',
    ]);
    assert.deepEqual(switchedInbox.afterSwitch.messageInboxSeenIdsV1, ['pending-1']);
    assert.deepEqual(switchedInbox.afterSwitch.fabChatMessages, []);
    assert.equal(switchedInbox.afterSwitch.fabChatClosed, false);
    assert.equal(switchedInbox.afterSwitch.messageInboxAuthBindingV1.includes('message-inbox-session-b'), false);
    assert.deepEqual(switchedInbox.afterSignOut.messages, []);
    assert.deepEqual(switchedInbox.afterSignOut.messageInboxSeenIdsV1, []);
    assert.equal(switchedInbox.afterSignOut.messageInboxAuthBindingV1, undefined);
    assert.deepEqual(switchedInbox.afterSignOut.fabChatMessages, []);
    assert.equal(switchedInbox.afterSignOut.fabChatClosed, false);

    // The identity-switch case above ends with a real sign-out. Re-establish
    // the authenticated test binding before exercising classroom authority;
    // production login/registration clears the invalidation fence only after
    // installing this exact student-session pair.
    await worker.evaluate(async () => {
      CONFIG.deviceId = 'diagnostic-device';
      CONFIG.activeStudentId = 'diagnostic-student';
      CONFIG.activeStudentSessionId = 'diagnostic-student-session';
      CONFIG.studentToken = 'diagnostic-token';
      studentAuthInvalidating = false;
      const authContextId = generateAuthContextId();
      activateAuthenticatedContext(authContextId);
      await chrome.storage.local.set({
        authContextId,
        deviceId: CONFIG.deviceId,
        activeStudentId: CONFIG.activeStudentId,
        activeStudentSessionId: CONFIG.activeStudentSessionId,
        studentToken: CONFIG.studentToken,
      });
    });

    const authContextRaceFencing = await worker.evaluate(async ({ fixturePort }) => {
      // Disable the production interval for this deterministic pause-point
      // fixture; all heartbeats below are invoked explicitly.
      scheduleHeartbeat(null);
      const originalFetch = globalThis.fetch;
      const originalBuildOpaqueTabSnapshot = buildOpaqueTabSnapshot;
      const priorIdentity = {
        serverUrl: CONFIG.serverUrl,
        schoolId: CONFIG.schoolId,
        deviceId: CONFIG.deviceId,
        studentId: CONFIG.activeStudentId,
        studentSessionId: CONFIG.activeStudentSessionId,
        studentToken: CONFIG.studentToken,
        studentEmail: CONFIG.studentEmail,
      };
      const requests = [];
      const waitFor = (promise, label) => Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(
          () => reject(new Error(`Timed out waiting for ${label}`)),
          5_000,
        )),
      ]);
      const installIdentity = (suffix, identity = null) => {
        const next = identity || {
          ...priorIdentity,
          studentId: `race-student-${suffix}`,
          studentSessionId: `race-session-${suffix}`,
          studentToken: `race-token-${suffix}`,
          studentEmail: `race-${suffix}@example.edu`,
        };
        advanceStudentAuthMutationGeneration();
        CONFIG.serverUrl = next.serverUrl;
        CONFIG.schoolId = next.schoolId;
        CONFIG.deviceId = next.deviceId;
        CONFIG.activeStudentId = next.studentId;
        CONFIG.activeStudentSessionId = next.studentSessionId;
        CONFIG.studentToken = next.studentToken;
        CONFIG.studentEmail = next.studentEmail;
        CONFIG.identitySource = 'integration_test';
        CONFIG.manualLoginLastSeenAt = null;
        studentAuthInvalidating = false;
        studentAuthCommitPending = false;
        const authContextId = generateAuthContextId();
        activateAuthenticatedContext(authContextId);
        adoptLicenseState(
          true,
          'active',
          captureAuthenticatedContext(`race identity ${suffix}`),
        );
        trackingState = TRACKING_STATES.ACTIVE;
        return authContextId;
      };
      try {
        trackingState = TRACKING_STATES.ACTIVE;
        screenshotScheduled = true;
        apiBackoffUntilMs = 0;
        safeSendHeartbeat = async () => {};
        globalThis.fetch = async (url, init = {}) => {
          const requestUrl = String(url);
          if (requestUrl.includes('/api/device/heartbeat')) {
            requests.push({
              type: 'heartbeat',
              authorization: init.headers?.Authorization || null,
              body: JSON.parse(String(init.body || '{}')),
            });
            return new Response(JSON.stringify({
              studentId: CONFIG.activeStudentId,
              studentSessionId: CONFIG.activeStudentSessionId,
              serverProtocolVersion: 3,
              acceptedCapabilities: [
                'scopedAuthorityChecksV1',
                'authBoundTelemetryV1',
                'serverOnlyCapability',
              ],
            }), { status: 200, headers: { 'content-type': 'application/json' } });
          }
          if (requestUrl.includes('/api/device/screenshot')) {
            requests.push({
              type: 'screenshot',
              authorization: init.headers?.Authorization || null,
            });
            return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
          }
          return originalFetch(url, init);
        };

        installIdentity('heartbeat-a');
        let releaseHeartbeatSnapshot;
        let markHeartbeatSnapshotStarted;
        const heartbeatSnapshotStarted = new Promise((resolveStarted) => {
          markHeartbeatSnapshotStarted = resolveStarted;
        });
        const heartbeatSnapshotGate = new Promise((resolveGate) => {
          releaseHeartbeatSnapshot = resolveGate;
        });
        buildOpaqueTabSnapshot = async () => {
          markHeartbeatSnapshotStarted();
          await heartbeatSnapshotGate;
          return {
            schemaVersion: 1,
            revision: 1,
            tabs: [{ tabRef: 'retired-tab', url: 'https://student-a.example/private', title: 'Student A' }],
            localEntries: [],
          };
        };
        const delayedHeartbeat = sendHeartbeat('auth-context-race-a');
        await waitFor(heartbeatSnapshotStarted, 'heartbeat tab snapshot');
        const currentAuthContextId = installIdentity('heartbeat-b', priorIdentity);
        buildOpaqueTabSnapshot = originalBuildOpaqueTabSnapshot;
        releaseHeartbeatSnapshot();
        await delayedHeartbeat;
        const heartbeatRequestsBeforeCurrentSend = requests.filter((entry) => entry.type === 'heartbeat').length;
        await sendHeartbeat('auth-context-race-current');
        const negotiatedAtHeartbeat = negotiatedProtocolState
          ? {
            ...negotiatedProtocolState,
            acceptedCapabilities: [...negotiatedProtocolState.acceptedCapabilities],
          }
          : null;

        installIdentity('screenshot-a');
        lastScreenshotAttemptAt = Date.now();
        const screenshotAContext = captureAuthenticatedContext('screenshot race fixture');
        adoptNegotiatedProtocolState({
          serverProtocolVersion: 3,
          acceptedCapabilities: [],
        }, screenshotAContext);
        adoptScreenshotPolicy(undefined, screenshotAContext);
        trackingState = TRACKING_STATES.ACTIVE;
        apiBackoffUntilMs = 0;
        lastScreenshotAttemptAt = 0;
        screenshotCaptureInFlight = false;
        let releaseScreenshot;
        let markScreenshotStarted;
        const screenshotStarted = new Promise((resolveStarted) => {
          markScreenshotStarted = resolveStarted;
        });
        const screenshotGate = new Promise((resolveGate) => {
          releaseScreenshot = resolveGate;
        });
        const delayedScreenshot = captureAndSendScreenshot({
          reason: 'auth-context-race',
          queryActiveTab: async () => [{
            id: 999_001,
            active: true,
            windowId: 1,
            url: `http://auth-context-race.localhost:${fixturePort}/screenshot`,
            title: 'Student A private tab',
            favIconUrl: '',
          }],
          captureVisibleTab: async () => {
            markScreenshotStarted();
            await screenshotGate;
            return 'data:image/jpeg;base64,c3R1ZGVudC1h';
          },
          subscribeTabActivation: () => () => {},
          subscribeTabUpdate: () => () => {},
        });
        await waitFor(screenshotStarted, 'screenshot pixels');
        const finalAuthContextId = installIdentity('screenshot-b', priorIdentity);
        releaseScreenshot();
        await delayedScreenshot;

        await chrome.storage.local.set({
          authContextId: finalAuthContextId,
          deviceId: CONFIG.deviceId,
          activeStudentId: CONFIG.activeStudentId,
          activeStudentSessionId: CONFIG.activeStudentSessionId,
          studentToken: CONFIG.studentToken,
          studentEmail: CONFIG.studentEmail,
          identitySource: CONFIG.identitySource,
        });
        return {
          heartbeatRequestsBeforeCurrentSend,
          heartbeatRequests: requests.filter((entry) => entry.type === 'heartbeat'),
          screenshotRequests: requests.filter((entry) => entry.type === 'screenshot'),
          currentAuthContextId,
          finalAuthContextId,
          currentStudentId: CONFIG.activeStudentId,
          negotiatedAtHeartbeat,
          negotiatedAfterFinalTransition: negotiatedProtocolState,
        };
      } finally {
        globalThis.fetch = originalFetch;
        buildOpaqueTabSnapshot = originalBuildOpaqueTabSnapshot;
        // Keep event-triggered maintenance heartbeats disabled for the rest of
        // this deterministic command/socket section. The harness invokes every
        // heartbeat it needs directly, and delayed callbacks from earlier cases
        // must not mutate the fixture identity between assertions.
        safeSendHeartbeat = async () => {};
      }
    }, { fixturePort: fixture.port });
    assert.equal(authContextRaceFencing.heartbeatRequestsBeforeCurrentSend, 0);
    assert.equal(authContextRaceFencing.heartbeatRequests.length, 1);
    assert.equal(
      authContextRaceFencing.heartbeatRequests[0].authorization,
      'Bearer diagnostic-token',
    );
    assert.notEqual(
      authContextRaceFencing.heartbeatRequests[0].body.studentEmail,
      'race-heartbeat-a@example.edu',
    );
    assert.equal(authContextRaceFencing.screenshotRequests.length, 0);
    assert.deepEqual(
      authContextRaceFencing.negotiatedAtHeartbeat.acceptedCapabilities,
      ['scopedAuthorityChecksV1', 'authBoundTelemetryV1'],
    );
    assert.equal(authContextRaceFencing.negotiatedAtHeartbeat.serverProtocolVersion, 3);
    assert.equal(authContextRaceFencing.negotiatedAfterFinalTransition, null);
    assert.notEqual(authContextRaceFencing.currentAuthContextId, authContextRaceFencing.finalAuthContextId);
    assert.equal(authContextRaceFencing.currentStudentId, 'diagnostic-student');

    const screenLockOverlay = await worker.evaluate(async () => {
      const now = Date.now();
      const flightPath = {
        active: true,
        allowedDomains: ['khanacademy.org', 'ixl.com'],
        name: 'Retained Math Path',
      };
      await applyClassroomState({
        schemaVersion: 1,
        revision: 899,
        teachingSessionId: 'screen-lock-overlay-session',
        receivedAt: now,
        hardExpiresAt: now + 60 * 60 * 1000,
        restrictions: {
          screenLock: {
            active: true,
            url: 'https://attention.example/',
            domain: 'attention.example',
          },
          flightPath,
          temporaryAllows: [{
            domain: 'escape.example',
            expiresAt: now + 30 * 60 * 1000,
          }],
        },
      });
      const lockedRules = await chrome.declarativeNetRequest.getDynamicRules();
      const lockedRule = lockedRules.find((rule) => rule.id === RuntimeCore.DNR_RANGES.classroom[0]);
      const lockedTargetAllowRule = lockedRules.find((rule) => rule.id === RuntimeCore.DNR_RANGES.classroom[0] + 1);
      const retainedTemporaryAllowRule = lockedRules.find((rule) => (
        rule.condition?.requestDomains?.includes('escape.example')
      ));
      const lockedSnapshot = await getClassroomCommandStateSnapshot();

      await applyClassroomState({
        schemaVersion: 1,
        revision: 900,
        teachingSessionId: 'screen-lock-overlay-session',
        receivedAt: now,
        hardExpiresAt: now + 60 * 60 * 1000,
        restrictions: {
          screenLock: { active: false },
          flightPath,
          temporaryAllows: [{
            domain: 'escape.example',
            expiresAt: now + 30 * 60 * 1000,
          }],
        },
      });
      const unlockedRule = (await chrome.declarativeNetRequest.getDynamicRules())
        .find((rule) => rule.id === RuntimeCore.DNR_RANGES.classroom[0]);
      const unlockedSnapshot = await getClassroomCommandStateSnapshot();
      return {
        lockedRule,
        lockedTargetAllowRule,
        retainedTemporaryAllowRule,
        unlockedRule,
        lockedSnapshot,
        unlockedSnapshot,
      };
    });
    assert.deepEqual(screenLockOverlay.lockedRule.condition.excludedRequestDomains, ['attention.example']);
    assert.equal(screenLockOverlay.lockedSnapshot.screenLocked, true);
    assert.equal(screenLockOverlay.lockedSnapshot.flightPathActive, true);
    assert.equal(screenLockOverlay.lockedTargetAllowRule.action.type, 'allow');
    assert.deepEqual(screenLockOverlay.lockedTargetAllowRule.condition.requestDomains, ['attention.example']);
    assert.ok(screenLockOverlay.lockedRule.priority > screenLockOverlay.retainedTemporaryAllowRule.priority);
    assert.deepEqual(
      screenLockOverlay.unlockedRule.condition.excludedRequestDomains,
      ['khanacademy.org', 'ixl.com'],
    );
    assert.equal(screenLockOverlay.unlockedSnapshot.screenLocked, false);
    assert.equal(screenLockOverlay.unlockedSnapshot.flightPathActive, true);

    const reorderedCommand = await worker.evaluate(async () => {
      const now = Date.now();
      const authBefore = {
        mutation: studentAuthMutationGeneration,
        active: activeAuthContextGeneration,
        id: CONFIG.authContextId,
        aborted: authContextAbortController.signal.aborted,
        hasAuth: hasStudentAuth(),
      };
      await applyClassroomState({
        schemaVersion: 1,
        revision: 902,
        teachingSessionId: 'replacement-session-b',
        receivedAt: now,
        hardExpiresAt: now + 60 * 60 * 1000,
        restrictions: {},
      });
      await applyFabSettings({
        teachingSessionId: 'replacement-session-b',
        activeSessionIds: ['replacement-session-b'],
        revision: 1,
        lifecycleRevision: 1,
        messagingEnabled: true,
        handRaisingEnabled: true,
        reason: 'replacement-started',
      });
      await clearClassroomOverlayState('replacement-fixture');
      const result = await handleRemoteControl({
        type: 'timer',
        commandId: 'delayed-session-a-command',
        authority: {
          teachingSessionId: 'ended-session-a',
          supervisionContextId: null,
        },
        deliveryPolicy: 'transient_action',
        expiresAt: new Date(now + 60_000).toISOString(),
        data: { action: 'start', seconds: 45 },
      }, {
        commandId: 'delayed-session-a-command',
        studentId: CONFIG.activeStudentId,
        studentSessionId: CONFIG.activeStudentSessionId,
        deliveryPolicy: 'transient_action',
        expiresAt: new Date(now + 60_000).toISOString(),
      });
      return {
        result,
        authBefore,
        authAfter: {
          mutation: studentAuthMutationGeneration,
          active: activeAuthContextGeneration,
          id: CONFIG.authContextId,
          aborted: authContextAbortController.signal.aborted,
          hasAuth: hasStudentAuth(),
          deviceId: CONFIG.deviceId,
          studentId: CONFIG.activeStudentId,
          studentSessionId: CONFIG.activeStudentSessionId,
          hasToken: Boolean(CONFIG.studentToken),
          identitySource: CONFIG.identitySource,
          manualLoginLastSeenAt: CONFIG.manualLoginLastSeenAt,
          invalidating: studentAuthInvalidating,
          commitPending: studentAuthCommitPending,
        },
        overlays: await getRestorableClassroomOverlayState(),
        seenPollIds: [...seenPollIds],
      };
    });
    assert.equal(reorderedCommand.authBefore.id, reorderedCommand.authAfter.id);
    assert.equal(reorderedCommand.authAfter.active, reorderedCommand.authAfter.mutation);
    assert.equal(reorderedCommand.authAfter.aborted, false);
    assert.equal(
      reorderedCommand.authAfter.hasAuth,
      true,
      JSON.stringify(reorderedCommand.authAfter),
    );
    assert.equal(reorderedCommand.result.rejected, true);
    assert.match(reorderedCommand.result.error, /inactive teaching session/i);
    assert.equal(reorderedCommand.overlays.timer, null);
    assert.equal(reorderedCommand.overlays.poll, null);
    assert.deepEqual(reorderedCommand.seenPollIds, []);

    const exactBindingIsolation = await worker.evaluate(async () => {
      const studentId = CONFIG.activeStudentId;
      const activeSessionId = CONFIG.activeStudentSessionId;
      const retiredSessionId = `${activeSessionId}-retired`;
      const originalExecute = executeRemoteControlCommand;
      const originalSendCommandAck = sendCommandAck;
      let executions = 0;
      executeRemoteControlCommand = async () => {
        executions += 1;
        return { executed: true };
      };
      try {
        const delayed = await handleRemoteControl({
          type: 'open-tab',
          authority: {
            teachingSessionId: 'replacement-session-b',
            supervisionContextId: null,
          },
          data: { url: 'https://retired-binding.example' },
        }, {
          studentId,
          studentSessionId: retiredSessionId,
          authority: {
            teachingSessionId: 'replacement-session-b',
            supervisionContextId: null,
          },
        });

        await handleWsMessage(JSON.stringify({
          type: 'student-session-replaced',
          studentId,
          studentSessionId: retiredSessionId,
        }));

        let releaseReceivedAck;
        const receivedAckStarted = new Promise((resolveStarted) => {
          releaseReceivedAck = resolveStarted;
        });
        sendCommandAck = async (_commandId, state) => {
          if (state === 'received') {
            CONFIG.activeStudentSessionId = `${activeSessionId}-replacement`;
            releaseReceivedAck();
          }
        };
        const rebindDuringAck = handleRemoteControl({
          type: 'open-tab',
          authority: {
            teachingSessionId: 'replacement-session-b',
            supervisionContextId: null,
          },
          data: { url: 'https://rebind-during-ack.example' },
        }, {
          commandId: 'rebind-during-ack-command',
          studentId,
          studentSessionId: activeSessionId,
          authority: {
            teachingSessionId: 'replacement-session-b',
            supervisionContextId: null,
          },
        });
        await receivedAckStarted;
        const rebindResult = await rebindDuringAck;
        const sessionAfterDelayedReplacement = CONFIG.activeStudentSessionId;
        CONFIG.activeStudentSessionId = activeSessionId;
        studentAuthInvalidating = true;
        const invalidatingResult = await handleRemoteControl({
          type: 'open-tab',
          authority: {
            teachingSessionId: 'replacement-session-b',
            supervisionContextId: null,
          },
          data: { url: 'https://signout-in-progress.example' },
        }, {
          studentId,
          studentSessionId: activeSessionId,
          authority: {
            teachingSessionId: 'replacement-session-b',
            supervisionContextId: null,
          },
        });
        await handleWsMessage(JSON.stringify({
          type: 'request-stream',
          studentId,
          studentSessionId: activeSessionId,
          negotiationId: 'signout-in-progress-negotiation',
          teachingSessionId: 'replacement-session-b',
          setupExpiresAt: new Date(Date.now() + 90_000).toISOString(),
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
        }));
        const liveViewDuringInvalidation = activeLiveViewNegotiationId;
        studentAuthInvalidating = false;
        return {
          delayed,
          rebindResult,
          invalidatingResult,
          executions,
          studentIdAfter: CONFIG.activeStudentId,
          sessionAfterDelayedReplacement,
          liveViewDuringInvalidation,
          hasAuthAfter: hasStudentAuth(),
        };
      } finally {
        executeRemoteControlCommand = originalExecute;
        sendCommandAck = originalSendCommandAck;
        CONFIG.activeStudentSessionId = activeSessionId;
        studentAuthInvalidating = false;
      }
    });
    assert.equal(exactBindingIsolation.delayed.rejected, true);
    assert.equal(exactBindingIsolation.rebindResult.rejected, true);
    assert.equal(exactBindingIsolation.invalidatingResult.rejected, true);
    assert.equal(exactBindingIsolation.executions, 0);
    assert.equal(exactBindingIsolation.liveViewDuringInvalidation, null);
    assert.equal(exactBindingIsolation.hasAuthAfter, true);
    assert.equal(exactBindingIsolation.studentIdAfter, 'diagnostic-student');
    assert.equal(
      exactBindingIsolation.sessionAfterDelayedReplacement,
      'diagnostic-student-session-replacement',
    );

    const offscreenRecoveryIdentity = await worker.evaluate(async () => {
      const originalQueryStatus = queryOffscreenWebSocketStatus;
      const originalCloseReported = closeReportedOffscreenWebSocket;
      const originalFlushCommandAcks = flushCommandAckOutbox;
      const originalFlushChatAcks = flushChatAckOutbox;
      const originalState = {
        generation: wsConnectionGeneration,
        connected: wsConnected,
        transportConnected: wsTransportConnected,
        authenticatedGeneration: wsAuthenticatedGeneration,
        transportIdentity: wsTransportIdentity,
      };
      const authContext = captureAuthenticatedContext('offscreen recovery fixture');
      const closedStatuses = [];
      try {
        // Recovery dispatches these as detached maintenance jobs. Stub them so
        // this identity-only fixture cannot leak work into the next fixture.
        flushCommandAckOutbox = async () => {};
        flushChatAckOutbox = async () => {};
        queryOffscreenWebSocketStatus = async () => ({
          success: true,
          connectionGeneration: originalState.generation + 7,
          transportOpen: true,
          authenticated: true,
          authContextId: 'retired-offscreen-auth-context',
          serverOrigin: authContext.serverOrigin,
        });
        closeReportedOffscreenWebSocket = async (status) => {
          closedStatuses.push(status);
        };
        const recoveredMismatch = await recoverOffscreenWebSocketStatus(authContext);
        const generationAfterMismatch = wsConnectionGeneration;

        queryOffscreenWebSocketStatus = async () => ({
          success: true,
          connectionGeneration: generationAfterMismatch + 1,
          transportOpen: true,
          authenticated: true,
          authContextId: authContext.authContextId,
          serverOrigin: authContext.serverOrigin,
        });
        const recoveredCurrent = await recoverOffscreenWebSocketStatus(authContext);
        return {
          recoveredMismatch,
          recoveredCurrent,
          closedStatuses,
          adoptedIdentity: wsTransportIdentity,
          generationAfterMismatch,
          expectedAuthContextId: authContext.authContextId,
        };
      } finally {
        queryOffscreenWebSocketStatus = originalQueryStatus;
        closeReportedOffscreenWebSocket = originalCloseReported;
        flushCommandAckOutbox = originalFlushCommandAcks;
        flushChatAckOutbox = originalFlushChatAcks;
        wsConnectionGeneration = originalState.generation;
        wsConnected = originalState.connected;
        wsTransportConnected = originalState.transportConnected;
        wsAuthenticatedGeneration = originalState.authenticatedGeneration;
        wsTransportIdentity = originalState.transportIdentity;
      }
    });
    assert.equal(offscreenRecoveryIdentity.recoveredMismatch, false);
    assert.equal(offscreenRecoveryIdentity.closedStatuses.length, 1);
    assert.equal(
      offscreenRecoveryIdentity.closedStatuses[0].authContextId,
      'retired-offscreen-auth-context',
    );
    assert.equal(offscreenRecoveryIdentity.recoveredCurrent, true);
    assert.equal(
      offscreenRecoveryIdentity.adoptedIdentity.authContextId,
      offscreenRecoveryIdentity.expectedAuthContextId,
    );
    assert.equal(
      offscreenRecoveryIdentity.adoptedIdentity.connectionGeneration,
      offscreenRecoveryIdentity.generationAfterMismatch + 1,
    );

    const wsEventLifetime = await worker.evaluate(async () => {
      const originalHandleRemoteControl = handleRemoteControl;
      const generation = wsConnectionGeneration;
      const authContext = captureAuthenticatedContext('WebSocket lifetime fixture');
      const priorTransportIdentity = wsTransportIdentity;
      wsTransportIdentity = {
        connectionGeneration: generation,
        authContextId: authContext.authContextId,
        serverOrigin: authContext.serverOrigin,
      };
      const order = [];
      let releaseFirst;
      let markFirstStarted;
      const firstStarted = new Promise((resolveStarted) => {
        markFirstStarted = resolveStarted;
      });
      const firstGate = new Promise((resolveGate) => {
        releaseFirst = resolveGate;
      });
      handleRemoteControl = async (command) => {
        order.push(command.data.url);
        if (command.data.url.includes('first')) {
          markFirstStarted();
          await firstGate;
        }
        return { completed: true };
      };
      try {
        const envelope = (suffix) => JSON.stringify({
          type: 'remote-control',
          _msgId: `mv3-lifetime-${suffix}`,
          studentId: CONFIG.activeStudentId,
          studentSessionId: CONFIG.activeStudentSessionId,
          command: {
            type: 'open-tab',
            data: { url: `https://${suffix}.mv3-lifetime.example` },
          },
        });
        let firstSettled = false;
        const first = handleOffscreenMessage({
          type: 'WS_EVENT',
          event: 'message',
          data: envelope('first'),
          connectionGeneration: generation,
          authContextId: authContext.authContextId,
          serverOrigin: authContext.serverOrigin,
        }).then((value) => {
          firstSettled = true;
          return value;
        });
        await firstStarted;
        const second = handleOffscreenMessage({
          type: 'WS_EVENT',
          event: 'message',
          data: envelope('second'),
          connectionGeneration: generation,
          authContextId: authContext.authContextId,
          serverOrigin: authContext.serverOrigin,
        });
        await Promise.resolve();
        const beforeRelease = { firstSettled, order: [...order] };
        releaseFirst();
        await Promise.all([first, second]);
        return { beforeRelease, finalOrder: order };
      } finally {
        handleRemoteControl = originalHandleRemoteControl;
        wsTransportIdentity = priorTransportIdentity;
      }
    });
    assert.equal(wsEventLifetime.beforeRelease.firstSettled, false);
    assert.deepEqual(wsEventLifetime.beforeRelease.order, [
      'https://first.mv3-lifetime.example',
    ]);
    assert.deepEqual(wsEventLifetime.finalOrder, [
      'https://first.mv3-lifetime.example',
      'https://second.mv3-lifetime.example',
    ]);

    const authorityRevocationStop = await worker.evaluate(async () => {
      const originalWsSend = wsSend;
      const sent = [];
      wsSend = (payload) => {
        sent.push(payload);
        return true;
      };
      try {
        activeLiveViewNegotiationId = 'authority-revocation-negotiation';
        activeLiveViewTeachingSessionId = 'replacement-session-b';
        const now = Date.now();
        await applyClassroomState({
          schemaVersion: 1,
          revision: 903,
          teachingSessionId: 'replacement-session-c',
          receivedAt: now,
          hardExpiresAt: now + 60 * 60 * 1000,
          restrictions: {},
        });
        const stopMessage = sent.find((message) => (
          message.type === 'stop-share'
          && message.negotiationId === 'authority-revocation-negotiation'
        ));
        await applyClassroomState({
          schemaVersion: 1,
          revision: 904,
          teachingSessionId: 'replacement-session-b',
          receivedAt: now + 1,
          hardExpiresAt: now + 60 * 60 * 1000,
          restrictions: {},
        });
        return {
          stopMessage,
          activeNegotiationId: activeLiveViewNegotiationId,
          activeTeachingSessionId: activeLiveViewTeachingSessionId,
        };
      } finally {
        wsSend = originalWsSend;
      }
    });
    assert.equal(authorityRevocationStop.stopMessage.reason, 'classroom-authority-changed');
    assert.equal(authorityRevocationStop.activeNegotiationId, null);
    assert.equal(authorityRevocationStop.activeTeachingSessionId, null);

    const teacherMessageAfterReplacement = await worker.evaluate(async () => {
      const messageId = 'replacement-session-teacher-message';
      CONFIG.deviceId = 'replacement-message-device';
      CONFIG.activeStudentId = 'replacement-message-student';
      CONFIG.activeStudentSessionId = 'replacement-message-student-session';
      CONFIG.studentEmail = 'replacement-message@example.edu';
      CONFIG.studentToken = 'replacement-message-token';
      await chrome.storage.local.set({
        deviceId: CONFIG.deviceId,
        activeStudentId: CONFIG.activeStudentId,
        activeStudentSessionId: CONFIG.activeStudentSessionId,
        studentEmail: CONFIG.studentEmail,
        studentToken: CONFIG.studentToken,
        registered: true,
      });
      await clearStudentMessageState('replacement-message-fixture');
      await handleDurableTeacherMessage({
        type: 'teacher-message',
        _msgId: messageId,
        chatMessageId: messageId,
        messageId,
        sessionId: 'replacement-session-b',
        teachingSessionId: 'replacement-session-b',
        studentId: CONFIG.activeStudentId,
        studentSessionId: CONFIG.activeStudentSessionId,
        message: 'Message for the replacement class',
        fromName: 'Teacher',
      });
      const inbox = await getCurrentMessageInbox();
      return inbox.find((entry) => entry.id === messageId) || null;
    });
    assert.equal(teacherMessageAfterReplacement.message, 'Message for the replacement class');

    const heartbeatRecoveredTeacherMessage = await worker.evaluate(async () => {
      const commandId = 'heartbeat-recovered-message-command';
      const messageId = 'heartbeat-recovered-message';
      const originalSendCommandAck = sendCommandAck;
      const originalFabState = currentFabState;
      const ackStates = [];
      sendCommandAck = async (ackCommandId, state) => {
        ackStates.push({ commandId: ackCommandId, state });
      };
      try {
        // Simulate a missed FAB lifecycle frame. The already-reconciled
        // classroom snapshot is authoritative and must permit session B while
        // still rejecting delayed session-A commands.
        currentFabState = {
          ...(currentFabState || {}),
          teachingSessionId: 'ended-session-a',
          activeSessionIds: ['ended-session-a'],
          ownershipRevisionKnown: true,
          ownershipRevision: 903,
        };
        const result = await handleHeartbeatPendingMessages([{
          id: messageId,
          message: 'Recovered after the WebSocket was unavailable',
          commandId,
          studentId: CONFIG.activeStudentId,
          studentSessionId: CONFIG.activeStudentSessionId,
          teachingSessionId: 'replacement-session-b',
          supervisionContextId: null,
          authority: {
            teachingSessionId: 'replacement-session-b',
            supervisionContextId: null,
          },
          deliveryPolicy: 'durable_message',
        }], messageInboxAuthBinding());
        const inbox = await getCurrentMessageInbox();
        return {
          result,
          message: inbox.find((entry) => entry.id === messageId) || null,
          ackStates,
          activeSessionIds: activeTeachingSessionIds(),
          classroomSessionId: currentClassroomState?.teachingSessionId || null,
          fabSessionId: currentFabState?.teachingSessionId || null,
        };
      } finally {
        sendCommandAck = originalSendCommandAck;
        currentFabState = originalFabState;
      }
    });
    assert.ok(
      heartbeatRecoveredTeacherMessage.message,
      JSON.stringify(heartbeatRecoveredTeacherMessage),
    );
    assert.equal(
      heartbeatRecoveredTeacherMessage.message?.message,
      'Recovered after the WebSocket was unavailable',
    );
    assert.deepEqual(heartbeatRecoveredTeacherMessage.result.addedMessageIds, [
      'heartbeat-recovered-message',
    ]);
    assert.deepEqual(heartbeatRecoveredTeacherMessage.ackStates, [
      { commandId: 'heartbeat-recovered-message-command', state: 'received' },
      { commandId: 'heartbeat-recovered-message-command', state: 'completed' },
    ]);

    const entitlementCleanup = await worker.evaluate(async () => {
      const heartbeatIdleDeadline = Date.now() + 5_000;
      while (heartbeatInFlight && Date.now() < heartbeatIdleDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (heartbeatInFlight) {
        throw new Error('Could not isolate entitlement heartbeat fixture from an existing heartbeat');
      }
      const now = Date.now();
      const originalConfig = { ...CONFIG };
      const originalFetchWithBackoff = fetchWithBackoff;
      const originalFetch = globalThis.fetch;
      const originalDisableForInactiveLicense = disableForInactiveLicense;
      const originalHeartbeatInFlight = heartbeatInFlight;
      // Keep the normal ten-second periodic heartbeat from consuming this fixture's
      // temporary fetch stub. The direct sendHeartbeat call below does not use
      // the safe-send singleflight flag, so production behavior is unchanged.
      heartbeatInFlight = true;
      const statusDisablePlans = [];
      const statusResponses = [
        { status: 402, body: { planStatus: 'payment-required-status' } },
        { status: 403, body: { code: 'SOME_OTHER_FORBIDDEN', planStatus: 'forbidden-status' } },
        { status: 200, body: { schoolActive: false, planStatus: 'school-inactive-status' } },
      ];
      let heartbeatRequestCount = 0;

      CONFIG.serverUrl = 'https://entitlement-fixture.example';
      CONFIG.identitySource = 'managed';
      CONFIG.deviceId = 'entitlement-fixture-device';
      CONFIG.activeStudentId = 'entitlement-fixture-student';
      CONFIG.studentEmail = 'entitlement-fixture@example.edu';
      CONFIG.studentToken = 'entitlement-fixture-token';
      disableForInactiveLicense = async (planStatus) => {
        statusDisablePlans.push(planStatus);
      };
      globalThis.fetch = async () => {
        const next = statusResponses.shift();
        return new Response(JSON.stringify(next.body), {
          status: next.status,
          headers: { 'content-type': 'application/json' },
        });
      };
      await checkLicenseStatus('payment-required-entitlement-fixture');
      await checkLicenseStatus('forbidden-entitlement-fixture');
      await checkLicenseStatus('school-inactive-entitlement-fixture');
      disableForInactiveLicense = originalDisableForInactiveLicense;
      globalThis.fetch = originalFetch;

      const unknownStatusAuth = captureAuthenticatedContext('unknown license status fixture');
      adoptLicenseState(true, 'unknown-status-lkg', unknownStatusAuth, {
        verifiedAt: Date.now() - (365 * 24 * 60 * 60 * 1000),
      });
      const apiBackoffBeforeUnknownStatuses = apiBackoffUntilMs;
      const unknownStatusResponses = [
        new Response(JSON.stringify({ error: 'rate_limited' }), {
          status: 429,
          headers: { 'content-type': 'application/json' },
        }),
        new Response(JSON.stringify({ error: 'unavailable' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
        new Response('{', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      ];
      const unknownStatusStates = [];
      globalThis.fetch = async () => unknownStatusResponses.shift();
      for (const statusReason of ['429', '500', 'malformed']) {
        const outcome = await checkLicenseStatus(`unknown-${statusReason}-fixture`);
        unknownStatusStates.push({
          outcome,
          active: currentLicenseIsActive(),
          refreshState: licenseRefreshState,
          planStatus: licensePlanStatus,
          apiBackoffUntilMs,
        });
      }
      const dedicatedLicenseRetryAlarm = await chrome.alarms.get(LICENSE_STATUS_RETRY_ALARM);
      globalThis.fetch = originalFetch;

      await applyClassroomState({
        schemaVersion: 1,
        revision: 903,
        teachingSessionId: 'revoked-entitlement-session',
        receivedAt: now,
        hardExpiresAt: now + 60 * 60 * 1000,
        restrictions: {
          flightPath: {
            active: true,
            allowedDomains: ['flight.example'],
            name: 'Retained path',
          },
          blockList: {
            active: true,
            blockedDomains: ['blocked.example'],
            name: 'Retained block list',
          },
        },
      }, { force: true, reason: 'entitlement-cleanup-fixture' });
      const before = await getClassroomCommandStateSnapshot();
      const entitlementAuthContext = captureAuthenticatedContext('entitlement cleanup fixture');
      adoptLicenseState(true, 'active', entitlementAuthContext);
      trackingState = TRACKING_STATES.ACTIVE;
      persistedMonitoringState = {
        state: TRACKING_STATES.ACTIVE,
        changedAt: now,
        reason: 'entitlement-cleanup-fixture',
      };
      persistedMonitoringStateScope = monitoringEventAuthBindingForContext(entitlementAuthContext);
      fetchWithBackoff = async (url) => {
        if (String(url).endsWith('/api/device/heartbeat')) {
          heartbeatRequestCount += 1;
          return new Response(JSON.stringify({
            code: 'CLASSPILOT_NOT_ENTITLED',
            planStatus: 'inactive',
          }), {
            status: 403,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response(JSON.stringify({ error: 'fixture_non_retryable' }), {
          status: 400,
          headers: { 'content-type': 'application/json' },
        });
      };
      CONFIG.deviceId = 'entitlement-fixture-device';
      CONFIG.activeStudentId = 'entitlement-fixture-student';
      CONFIG.studentEmail = 'entitlement-fixture@example.edu';
      CONFIG.studentToken = 'entitlement-fixture-token';
      const heartbeatPreconditions = {
        licenseActive,
        trackingState,
        hasStudentAuth: hasStudentAuth(),
        identitySource: CONFIG.identitySource,
        deviceId: CONFIG.deviceId,
        activeStudentId: CONFIG.activeStudentId,
        hasStudentToken: Boolean(CONFIG.studentToken),
      };
      try {
        await sendHeartbeat('canonical-entitlement-fixture');
      } finally {
        fetchWithBackoff = originalFetchWithBackoff;
        globalThis.fetch = originalFetch;
        disableForInactiveLicense = originalDisableForInactiveLicense;
        heartbeatInFlight = originalHeartbeatInFlight;
        CONFIG = originalConfig;
      }
      const stored = await kv.get([
        CLASSROOM_STATE_STORAGE_KEY,
        'lockScreenState',
        'flightPathState',
        'teacherBlockListState',
        'licenseActive',
        'planStatus',
      ]);
      const rules = await chrome.declarativeNetRequest.getDynamicRules();
      const managedRanges = ['classroom', 'teacher', 'temporary']
        .map((name) => RuntimeCore.DNR_RANGES[name]);
      const retainedTeacherRuleIds = rules
        .filter((rule) => managedRanges.some(([start, end]) => rule.id >= start && rule.id < end))
        .map((rule) => rule.id);
      return {
        before,
        currentClassroomState,
        screenLocked,
        allowedDomains,
        teacherBlockedDomains,
        retainedTeacherRuleIds,
        stored,
        statusDisablePlans,
        unknownStatusStates,
        apiBackoffBeforeUnknownStatuses,
        dedicatedLicenseRetryAlarm: Boolean(dedicatedLicenseRetryAlarm),
        heartbeatRequestCount,
        heartbeatPreconditions,
      };
    });
    assert.deepEqual(entitlementCleanup.statusDisablePlans, [
      'payment-required-status',
      'forbidden-status',
      'school-inactive-status',
    ]);
    assert.deepEqual(
      entitlementCleanup.unknownStatusStates.map(({ outcome, active, refreshState, planStatus }) => ({
        outcome,
        active,
        refreshState,
        planStatus,
      })),
      [
        { outcome: 'unknown', active: true, refreshState: 'unknown', planStatus: 'unknown-status-lkg' },
        { outcome: 'unknown', active: true, refreshState: 'unknown', planStatus: 'unknown-status-lkg' },
        { outcome: 'unknown', active: true, refreshState: 'unknown', planStatus: 'unknown-status-lkg' },
      ],
    );
    assert.equal(entitlementCleanup.dedicatedLicenseRetryAlarm, true);
    assert.ok(entitlementCleanup.unknownStatusStates.every((state) => (
      state.apiBackoffUntilMs === entitlementCleanup.apiBackoffBeforeUnknownStatuses
    )));
    assert.equal(
      entitlementCleanup.heartbeatRequestCount,
      1,
      JSON.stringify(entitlementCleanup.heartbeatPreconditions),
    );
    assert.equal(entitlementCleanup.before.screenLocked, false);
    assert.equal(entitlementCleanup.before.flightPathActive, true);
    assert.equal(entitlementCleanup.currentClassroomState, null);
    assert.equal(entitlementCleanup.screenLocked, false);
    assert.deepEqual(entitlementCleanup.allowedDomains, []);
    assert.deepEqual(entitlementCleanup.teacherBlockedDomains, []);
    assert.deepEqual(entitlementCleanup.retainedTeacherRuleIds, []);
    assert.equal(entitlementCleanup.stored.classroomControlStateV1, undefined);
    assert.equal(entitlementCleanup.stored.flightPathState, undefined);
    assert.equal(entitlementCleanup.stored.teacherBlockListState, undefined);
    assert.equal(entitlementCleanup.stored.licenseActive, false);
    assert.equal(entitlementCleanup.stored.planStatus, 'inactive');

    const staleStartupRestore = await worker.evaluate(async () => {
      if (chromeProfileRegistrationInFlight) {
        await chromeProfileRegistrationInFlight.catch(() => {});
      }
      await studentAuthMutationTail.catch(() => {});
      studentAuthInvalidating = false;
      const capturedGeneration = studentAuthMutationGeneration;
      const capturedStudentA = {
        config: {
          serverUrl: CONFIG.serverUrl,
          deviceId: 'startup-device-a',
          schoolId: 'startup-school-a',
        },
        deviceId: 'startup-device-a',
        activeStudentId: 'startup-student-a',
        activeStudentSessionId: 'startup-session-a',
        studentEmail: 'startup-a@example.edu',
        studentToken: 'startup-token-a',
        identitySource: 'integration_test',
        autoRegistrationPaused: true,
      };

      studentAuthMutationGeneration += 1;
      const currentGeneration = studentAuthMutationGeneration;
      await enqueueStudentAuthMutation(async () => {
        CONFIG.deviceId = 'startup-device-b';
        CONFIG.schoolId = 'startup-school-b';
        CONFIG.activeStudentId = 'startup-student-b';
        CONFIG.activeStudentSessionId = 'startup-session-b';
        CONFIG.studentEmail = 'startup-b@example.edu';
        CONFIG.studentToken = 'startup-token-b';
        CONFIG.identitySource = 'integration_test';
        CONFIG.autoRegistrationPaused = true;
        studentAuthInvalidating = false;
        await kv.set({
          config: persistedNonAuthConfig(CONFIG),
          deviceId: CONFIG.deviceId,
          activeStudentId: CONFIG.activeStudentId,
          activeStudentSessionId: CONFIG.activeStudentSessionId,
          studentEmail: CONFIG.studentEmail,
          studentToken: CONFIG.studentToken,
          identitySource: CONFIG.identitySource,
          autoRegistrationPaused: true,
        });
      });

      let rejectionCode = null;
      try {
        await restoreWorkerWakeAuthState(
          capturedStudentA,
          CONFIG.serverUrl,
          capturedGeneration,
        );
      } catch (error) {
        rejectionCode = error?.code || null;
      }
      const stored = await kv.get([
        'config',
        'deviceId',
        'activeStudentId',
        'activeStudentSessionId',
        'studentToken',
      ]);
      return {
        rejectionCode,
        generation: studentAuthMutationGeneration,
        currentGeneration,
        deviceId: CONFIG.deviceId,
        schoolId: CONFIG.schoolId,
        activeStudentId: CONFIG.activeStudentId,
        activeStudentSessionId: CONFIG.activeStudentSessionId,
        studentToken: CONFIG.studentToken,
        stored,
      };
    });
    assert.equal(staleStartupRestore.rejectionCode, 'AUTH_MUTATION_SUPERSEDED');
    assert.equal(staleStartupRestore.generation, staleStartupRestore.currentGeneration);
    assert.equal(staleStartupRestore.deviceId, 'startup-device-b');
    assert.equal(staleStartupRestore.schoolId, 'startup-school-b');
    assert.equal(staleStartupRestore.activeStudentId, 'startup-student-b');
    assert.equal(staleStartupRestore.activeStudentSessionId, 'startup-session-b');
    assert.equal(staleStartupRestore.studentToken, 'startup-token-b');
    assert.equal(staleStartupRestore.stored.config.schoolId, 'startup-school-b');
    assert.equal(staleStartupRestore.stored.deviceId, 'startup-device-b');
    assert.equal(staleStartupRestore.stored.activeStudentId, 'startup-student-b');
    assert.equal(staleStartupRestore.stored.activeStudentSessionId, 'startup-session-b');
    assert.equal(staleStartupRestore.stored.studentToken, 'startup-token-b');

    const registrationSingleflight = await worker.evaluate(async () => {
      if (chromeProfileRegistrationInFlight) {
        await chromeProfileRegistrationInFlight.catch(() => {});
      }
      const originalEnsureRegisteredNow = ensureRegisteredNow;
      let calls = 0;
      const order = [];
      let release;
      const gate = new Promise((resolveGate) => { release = resolveGate; });
      const first = runChromeProfileRegistration(async () => {
        calls += 1;
        order.push('initial-registration');
        await gate;
        return 'first-registration';
      });
      const second = runChromeProfileRegistration(async () => {
        calls += 1;
        order.push('duplicate-registration');
        return 'second-registration';
      });
      ensureRegisteredNow = async () => {
        calls += 1;
        order.push('identity-change-follow-up');
        return 'fresh-identity-registration';
      };
      try {
        const identityRefresh = refreshRegistrationAfterIdentityChange();
        const samePromise = first === second;
        await Promise.resolve();
        const callsBeforeRelease = calls;
        release();
        const results = await Promise.all([first, second, identityRefresh]);
        return { calls, callsBeforeRelease, samePromise, order, results };
      } finally {
        ensureRegisteredNow = originalEnsureRegisteredNow;
      }
    });
    assert.equal(registrationSingleflight.callsBeforeRelease, 1);
    assert.equal(registrationSingleflight.calls, 2);
    assert.equal(registrationSingleflight.samePromise, true);
    assert.deepEqual(registrationSingleflight.order, [
      'initial-registration',
      'identity-change-follow-up',
    ]);
    assert.deepEqual(registrationSingleflight.results, [
      'first-registration',
      'first-registration',
      'fresh-identity-registration',
    ]);

    const manualLoginPriority = await worker.evaluate(async () => {
      if (chromeProfileRegistrationInFlight) {
        await chromeProfileRegistrationInFlight.catch(() => {});
      }
      const originalFetchWithBackoff = fetchWithBackoff;
      const originalCheckLicenseStatus = checkLicenseStatus;
      const originalInitializeAdaptiveTracking = initializeAdaptiveTracking;
      const order = [];
      let markAutoStarted;
      let releaseAuto;
      const autoStarted = new Promise((resolveStarted) => { markAutoStarted = resolveStarted; });
      const autoGate = new Promise((resolveGate) => { releaseAuto = resolveGate; });
      fetchWithBackoff = async (url) => {
        if (String(url).endsWith('/api/extension/register')) {
          order.push('auto-request');
          markAutoStarted();
          await autoGate;
          order.push('auto-response');
          return new Response(JSON.stringify({
            schoolId: 'auto-school',
            studentToken: 'auto-token',
            studentSessionId: 'auto-session',
            student: { id: 'auto-student' },
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        if (String(url).endsWith('/api/extension/student-login')) {
          order.push('manual-request');
          return new Response(JSON.stringify({
            schoolId: 'manual-school',
            studentToken: 'manual-token',
            studentSessionId: 'manual-session',
            sessionRecovery: { token: 'R'.repeat(43) },
            student: {
              id: 'manual-student',
              email: 'manual-priority@example.edu',
              firstName: 'Manual',
              lastName: 'Priority',
            },
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      };
      checkLicenseStatus = async () => {};
      initializeAdaptiveTracking = async () => {};
      CONFIG.deviceId = 'manual-priority-device';
      CONFIG.activeStudentId = null;
      CONFIG.activeStudentSessionId = null;
      CONFIG.studentToken = null;
      CONFIG.identitySource = null;
      CONFIG.autoRegistrationPaused = false;
      CONFIG.schoolId = null;
      CONFIG.schoolSlug = 'manual-school';
      studentAuthInvalidating = false;
      try {
        const auto = registerDeviceWithStudent(
          CONFIG.deviceId,
          null,
          'auto',
          'auto-priority@example.edu',
          'Auto Priority',
        ).then(
          () => ({ resolved: true }),
          (error) => ({ resolved: false, code: error?.code }),
        );
        await autoStarted;
        const manual = manualStudentLogin({
          mode: 'email_id',
          studentEmail: 'manual-priority@example.edu',
          studentIdNumber: '1001',
        });
        await Promise.resolve();
        const beforeAutoRelease = [...order];
        releaseAuto();
        const [autoResult, manualResult] = await Promise.all([auto, manual]);
        const stored = await getStoredAuthState([
          'activeStudentId',
          'activeStudentSessionId',
          'studentToken',
          STUDENT_AUTH_INVALIDATING_KEY,
        ]);
        return {
          order,
          beforeAutoRelease,
          autoResult,
          manualResult,
          stored,
          activeStudentId: CONFIG.activeStudentId,
          activeStudentSessionId: CONFIG.activeStudentSessionId,
          schoolId: CONFIG.schoolId,
        };
      } finally {
        fetchWithBackoff = originalFetchWithBackoff;
        checkLicenseStatus = originalCheckLicenseStatus;
        initializeAdaptiveTracking = originalInitializeAdaptiveTracking;
      }
    });
    assert.deepEqual(manualLoginPriority.beforeAutoRelease, ['auto-request']);
    assert.deepEqual(manualLoginPriority.order, [
      'auto-request',
      'auto-response',
      'manual-request',
    ]);
    assert.equal(manualLoginPriority.autoResult.resolved, false);
    assert.equal(manualLoginPriority.autoResult.code, 'AUTH_MUTATION_SUPERSEDED');
    assert.equal(manualLoginPriority.manualResult.success, true);
    assert.equal(manualLoginPriority.activeStudentId, 'manual-student');
    assert.equal(manualLoginPriority.activeStudentSessionId, 'manual-session');
    assert.equal(manualLoginPriority.schoolId, 'manual-school');
    assert.equal(manualLoginPriority.stored.activeStudentId, 'manual-student');
    assert.equal(manualLoginPriority.stored.activeStudentSessionId, 'manual-session');
    assert.equal(manualLoginPriority.stored.studentToken, 'manual-token');
    assert.equal(manualLoginPriority.stored.studentAuthInvalidatingV1, undefined);

    const recoveryPersistenceFailure = await worker.evaluate(async () => {
      if (hasStudentAuth()) {
        const current = captureAuthenticatedContext('recovery persistence failure reset');
        await clearStudentAuth('recovery-persistence-test-reset', {
          notifyBackend: false,
          serverSessionEnded: true,
          pauseAutoRegistration: true,
          expectedAuthContext: current,
        });
      }
      const originalFetchWithBackoff = fetchWithBackoff;
      const originalFetch = globalThis.fetch;
      const originalDurableSet = durableLocalKv.set;
      let exactReleaseRequests = 0;
      fetchWithBackoff = async (url) => {
        if (String(url).endsWith('/api/extension/student-login')) {
          return new Response(JSON.stringify({
            schoolId: 'manual-school',
            studentToken: 'storage-failure-token',
            studentSessionId: 'storage-failure-session',
            sessionRecovery: { token: 'S'.repeat(43) },
            student: {
              id: 'storage-failure-student',
              email: 'storage-failure@example.edu',
            },
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      };
      globalThis.fetch = async (url) => {
        if (String(url).endsWith('/api/extension/session-release')) {
          exactReleaseRequests += 1;
          return new Response(null, { status: 204 });
        }
        return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
      };
      durableLocalKv.set = async (value) => {
        if (Object.prototype.hasOwnProperty.call(value || {}, STUDENT_SESSION_RECOVERY_STORAGE_KEY)) {
          throw new Error('simulated recovery persistence failure');
        }
        return originalDurableSet(value);
      };
      CONFIG.serverUrl = 'https://school-pilot.net';
      CONFIG.schoolId = 'manual-school';
      CONFIG.schoolSlug = 'manual-school';
      CONFIG.deviceId = 'storage-failure-device';
      CONFIG.activeStudentId = null;
      CONFIG.activeStudentSessionId = null;
      CONFIG.studentToken = null;
      CONFIG.identitySource = null;
      CONFIG.autoRegistrationPaused = true;
      studentAuthInvalidating = false;
      studentAuthCommitPending = false;
      let loginError = null;
      try {
        await manualStudentLogin({
          mode: 'email_id',
          studentEmail: 'storage-failure@example.edu',
          studentIdNumber: '1002',
        });
      } catch (error) {
        loginError = error?.message || String(error);
      } finally {
        durableLocalKv.set = originalDurableSet;
        globalThis.fetch = originalFetch;
        fetchWithBackoff = originalFetchWithBackoff;
      }
      await studentAuthMutationTail;
      const [local, session] = await Promise.all([
        chrome.storage.local.get([
          STUDENT_SESSION_RECOVERY_STORAGE_KEY,
          'studentToken',
          'activeStudentId',
          'activeStudentSessionId',
        ]),
        chrome.storage.session.get([
          'studentToken',
          'activeStudentId',
          'activeStudentSessionId',
        ]),
      ]);
      return {
        exactReleaseRequests,
        loginError,
        hasAuth: hasStudentAuth(),
        local,
        session,
      };
    });
    assert.equal(recoveryPersistenceFailure.exactReleaseRequests, 1);
    assert.match(recoveryPersistenceFailure.loginError || '', /simulated recovery persistence failure/);
    assert.equal(recoveryPersistenceFailure.hasAuth, false);
    assert.equal(recoveryPersistenceFailure.local.studentSessionRecoveryV1, undefined);
    assert.equal(recoveryPersistenceFailure.local.studentToken, undefined);
    assert.equal(recoveryPersistenceFailure.local.activeStudentId, undefined);
    assert.equal(recoveryPersistenceFailure.local.activeStudentSessionId, undefined);
    assert.equal(recoveryPersistenceFailure.session.studentToken, undefined);
    assert.equal(recoveryPersistenceFailure.session.activeStudentId, undefined);
    assert.equal(recoveryPersistenceFailure.session.activeStudentSessionId, undefined);

    const malformedManualLoginCleanup = await worker.evaluate(async () => {
      const originalFetchWithBackoff = fetchWithBackoff;
      const originalFetch = globalThis.fetch;
      const originalApplyClassroomState = applyClassroomStateFromAuthResponse;
      let activeCase = null;
      let responseBody = null;
      let failAdoption = false;
      const exactReleases = {};
      const legacySignOuts = {};
      const exactStatuses = {};
      const legacyStatuses = {};
      fetchWithBackoff = async (url) => {
        if (String(url).endsWith('/api/extension/student-login')) {
          return new Response(JSON.stringify(responseBody), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (String(url).endsWith('/api/extension/sign-out')) {
          legacySignOuts[activeCase] = (legacySignOuts[activeCase] || 0) + 1;
          return new Response(null, { status: legacyStatuses[activeCase] || 204 });
        }
        return new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };
      globalThis.fetch = async (url) => {
        if (String(url).endsWith('/api/extension/session-release')) {
          exactReleases[activeCase] = (exactReleases[activeCase] || 0) + 1;
          const status = exactStatuses[activeCase] || 204;
          return new Response(null, {
            status,
            headers: status === 429 ? { 'Retry-After': '120' } : undefined,
          });
        }
        return new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };
      applyClassroomStateFromAuthResponse = async (...args) => {
        if (failAdoption) throw new Error('simulated post-success adoption failure');
        return originalApplyClassroomState(...args);
      };

      const runCase = async (name, body, options = {}) => {
        activeCase = name;
        responseBody = body;
        failAdoption = options.failAdoption === true;
        exactStatuses[name] = Number(options.exactStatus) || 204;
        legacyStatuses[name] = Number(options.legacyStatus) || 204;
        CONFIG.serverUrl = 'https://school-pilot.net';
        CONFIG.schoolId = options.slugOnly ? null : 'manual-school';
        CONFIG.schoolSlug = 'manual-school';
        CONFIG.deviceId = `malformed-${name}-device`;
        CONFIG.activeStudentId = null;
        CONFIG.activeStudentSessionId = null;
        CONFIG.studentToken = null;
        CONFIG.authContextId = null;
        CONFIG.identitySource = null;
        CONFIG.autoRegistrationPaused = true;
        studentAuthInvalidating = false;
        studentAuthCommitPending = false;
        studentAuthCommitPendingGeneration = 0;
        let error = null;
        try {
          await manualStudentLogin({
            mode: 'email_id',
            studentEmail: `${name}@example.edu`,
            studentIdNumber: '1003',
          });
        } catch (caught) {
          error = caught?.message || String(caught);
        }
        await studentAuthMutationTail;
        const [local, session] = await Promise.all([
          chrome.storage.local.get([
            STUDENT_SESSION_RECOVERY_STORAGE_KEY,
            'studentToken',
            'activeStudentId',
            'activeStudentSessionId',
          ]),
          chrome.storage.session.get([
            'studentToken',
            'activeStudentId',
            'activeStudentSessionId',
          ]),
        ]);
        return {
          error,
          exactReleases: exactReleases[name] || 0,
          legacySignOuts: legacySignOuts[name] || 0,
          hasAuth: hasStudentAuth(),
          hasPersistedBearer: Boolean(local.studentToken || session.studentToken),
          hasPersistedBinding: Boolean(
            local.activeStudentId
            || local.activeStudentSessionId
            || session.activeStudentId
            || session.activeStudentSessionId
          ),
          hasRecoveryState: Boolean(local[STUDENT_SESSION_RECOVERY_STORAGE_KEY]),
          pendingAttemptCount:
            local[STUDENT_SESSION_RECOVERY_STORAGE_KEY]?.pending?.[0]?.attemptCount ?? null,
          pendingRetryDelayMs: Math.max(0, Number(
            local[STUDENT_SESSION_RECOVERY_STORAGE_KEY]?.pending?.[0]?.nextAttemptAt || 0,
          ) - Date.now()),
        };
      };

      try {
        const base = {
          schoolId: 'manual-school',
          studentToken: 'malformed-response-bearer',
          studentSessionId: 'malformed-response-session',
          sessionRecovery: { token: 'M'.repeat(43) },
          student: { id: 'malformed-response-student', email: 'student@example.edu' },
        };
        const results = {
          missingStudent: await runCase('missing-student', {
            ...base,
            student: { email: 'student@example.edu' },
          }),
          missingSession: await runCase('missing-session', {
            ...base,
            studentSessionId: undefined,
          }),
          missingRecovery: await runCase('missing-recovery', {
            ...base,
            sessionRecovery: undefined,
          }),
          missingSchool: await runCase('missing-school', {
            ...base,
            schoolId: undefined,
            student: { ...base.student, schoolId: undefined },
          }, { slugOnly: true }),
          postSuccessAdoption: await runCase('post-success-adoption', base, {
            failAdoption: true,
          }),
          retryableCleanup: await runCase('retryable-cleanup', {
            ...base,
            student: { email: 'student@example.edu' },
          }, { exactStatus: 429, legacyStatus: 503 }),
        };
        await persistStudentSessionRecoveryState(emptyStudentSessionRecoveryState());
        return results;
      } finally {
        applyClassroomStateFromAuthResponse = originalApplyClassroomState;
        globalThis.fetch = originalFetch;
        fetchWithBackoff = originalFetchWithBackoff;
      }
    });
    for (const name of ['missingStudent', 'missingSession', 'postSuccessAdoption']) {
      const result = malformedManualLoginCleanup[name];
      assert.equal(result.exactReleases, 1, `${name} should use exact recovery release`);
      assert.equal(result.legacySignOuts, 0, `${name} should not need bearer fallback`);
      assert.equal(result.hasAuth, false, `${name} must leave no active local auth`);
      assert.equal(result.hasPersistedBearer, false, `${name} must not persist the bearer`);
      assert.equal(result.hasPersistedBinding, false, `${name} must not persist a binding`);
      assert.equal(result.hasRecoveryState, false, `${name} must clear released recovery state`);
    }
    for (const name of ['missingRecovery', 'missingSchool']) {
      const result = malformedManualLoginCleanup[name];
      assert.equal(result.exactReleases, 0, `${name} has no complete exact recovery authority`);
      assert.equal(result.legacySignOuts, 1, `${name} should use signed-token fallback`);
      assert.equal(result.hasAuth, false, `${name} must leave no active local auth`);
      assert.equal(result.hasPersistedBearer, false, `${name} must not persist the bearer`);
      assert.equal(result.hasPersistedBinding, false, `${name} must not persist a binding`);
      assert.equal(result.hasRecoveryState, false, `${name} must not retain unusable recovery state`);
    }
    assert.match(
      malformedManualLoginCleanup.missingStudent.error || '',
      /omitted the exact student binding/,
    );
    assert.match(
      malformedManualLoginCleanup.missingSession.error || '',
      /omitted the exact student binding/,
    );
    assert.match(
      malformedManualLoginCleanup.missingRecovery.error || '',
      /secure session recovery/,
    );
    assert.match(
      malformedManualLoginCleanup.missingSchool.error || '',
      /secure session recovery/,
    );
    assert.match(
      malformedManualLoginCleanup.postSuccessAdoption.error || '',
      /simulated post-success adoption failure/,
    );
    assert.equal(malformedManualLoginCleanup.retryableCleanup.exactReleases, 1);
    assert.equal(malformedManualLoginCleanup.retryableCleanup.legacySignOuts, 1);
    assert.equal(malformedManualLoginCleanup.retryableCleanup.hasAuth, false);
    assert.equal(malformedManualLoginCleanup.retryableCleanup.hasPersistedBearer, false);
    assert.equal(malformedManualLoginCleanup.retryableCleanup.hasRecoveryState, true);
    assert.equal(malformedManualLoginCleanup.retryableCleanup.pendingAttemptCount, 1);
    assert.ok(malformedManualLoginCleanup.retryableCleanup.pendingRetryDelayMs > 115_000);
    assert.ok(malformedManualLoginCleanup.retryableCleanup.pendingRetryDelayMs <= 120_000);

    const boundedRecoveryAlarmGateCoalescing = await worker.evaluate(async () => {
      await studentSessionRecoveryFlushPromise?.catch(() => {});
      const originalFetch = globalThis.fetch;
      const originalConfig = { ...CONFIG };
      const now = Date.now();
      let releaseRequests = 0;
      let unblockFirstRelease;
      const firstReleaseBlocked = new Promise((resolve) => {
        unblockFirstRelease = resolve;
      });
      const records = Array.from({ length: 8 }, (_, index) => (
        normalizeStudentSessionRecoveryRecord({
          state: 'pending',
          generation: generateStudentSessionRecoveryGeneration(),
          serverOrigin: 'https://school-pilot.net',
          schoolId: 'bounded-recovery-school',
          token: String.fromCharCode(65 + index).repeat(43),
          authContextId: generateAuthContextId(),
          createdAt: now - 1000,
          pendingSinceAt: now - 1000,
          attemptCount: 0,
          nextAttemptAt: now - 1,
          discardAt: now - 1000 + STUDENT_SESSION_RECOVERY_PENDING_TTL_MS,
        }, 'pending', now - 2000)
      ));
      try {
        Object.assign(CONFIG, {
          serverUrl: 'https://school-pilot.net',
          schoolId: 'bounded-recovery-school',
          schoolSlug: 'bounded-recovery-school',
          studentToken: null,
          activeStudentId: null,
          activeStudentSessionId: null,
          identitySource: null,
        });
        studentAuthInvalidating = false;
        studentAuthCommitPending = false;
        await persistStudentSessionRecoveryState({
          schemaVersion: STUDENT_SESSION_RECOVERY_SCHEMA_VERSION,
          armed: null,
          pending: records,
        });
        globalThis.fetch = async (url) => {
          if (String(url).endsWith('/api/extension/session-release')) {
            releaseRequests += 1;
            if (releaseRequests === 1) await firstReleaseBlocked;
            return new Response(null, { status: 204 });
          }
          return new Response('{}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        };

        // Model an alarm firing immediately before the gate prepares its first
        // roster. Both callers must join one single-record cleanup operation.
        const alarmFlush = flushStudentSessionRecovery({ maxRecords: 1 });
        const releaseStartDeadline = Date.now() + 2000;
        while (releaseRequests === 0 && Date.now() < releaseStartDeadline) {
          await new Promise((resolvePoll) => setTimeout(resolvePoll, 0));
        }
        if (releaseRequests === 0) throw new Error('bounded recovery release did not start');
        const gatePreparation = prepareStudentSessionRecoveryForGate();
        await Promise.resolve();
        unblockFirstRelease();
        const [, recoveryGrant] = await Promise.all([alarmFlush, gatePreparation]);
        return {
          releaseRequests,
          pendingRecords: studentSessionRecoveryState.pending.length,
          grantAvailable: Boolean(recoveryGrant),
        };
      } finally {
        unblockFirstRelease?.();
        globalThis.fetch = originalFetch;
        CONFIG = originalConfig;
        await persistStudentSessionRecoveryState(emptyStudentSessionRecoveryState());
      }
    });
    assert.equal(boundedRecoveryAlarmGateCoalescing.releaseRequests, 1);
    assert.equal(boundedRecoveryAlarmGateCoalescing.pendingRecords, 7);
    assert.equal(boundedRecoveryAlarmGateCoalescing.grantAvailable, true);

    const interleavedRosterRecoveryGrants = await worker.evaluate(async () => {
      const originalFetchWithBackoff = fetchWithBackoff;
      const now = Date.now();
      const recoveryToken = 'G'.repeat(43);
      const pendingRecord = normalizeStudentSessionRecoveryRecord({
        state: 'pending',
        generation: generateStudentSessionRecoveryGeneration(),
        serverOrigin: 'https://school-pilot.net',
        schoolId: 'manual-school',
        token: recoveryToken,
        authContextId: generateAuthContextId(),
        createdAt: now,
        pendingSinceAt: now,
        attemptCount: 0,
        nextAttemptAt: now + 60_000,
        discardAt: now + STUDENT_SESSION_RECOVERY_PENDING_TTL_MS,
      }, 'pending', now - 1);
      await persistStudentSessionRecoveryState({
        schemaVersion: STUDENT_SESSION_RECOVERY_SCHEMA_VERSION,
        armed: null,
        pending: [pendingRecord],
      });
      CONFIG.serverUrl = 'https://school-pilot.net';
      CONFIG.schoolId = 'manual-school';
      CONFIG.schoolSlug = 'manual-school';
      CONFIG.enrollmentKey = 'managed-enrollment-key';
      CONFIG.deviceId = 'interleaved-roster-device';
      CONFIG.activeStudentId = null;
      CONFIG.activeStudentSessionId = null;
      CONFIG.studentToken = null;
      CONFIG.authContextId = null;
      CONFIG.identitySource = null;
      CONFIG.autoRegistrationPaused = true;
      studentAuthInvalidating = false;
      studentAuthCommitPending = false;
      studentAuthCommitPendingGeneration = 0;
      resetLoginRosterRuntimeCache();
      const gradeAKey = loginRosterRequestCacheKey('Grade A', pendingRecord);
      const gradeBKey = loginRosterRequestCacheKey('Grade B', pendingRecord);
      const gradeAGrantId = bindLoginRosterRecoveryGrant(pendingRecord, [{
        id: 'grade-a-alex',
        hasPin: true,
        reclaimable: true,
      }, {
        id: 'grade-a-bob',
        hasPin: true,
        reclaimable: false,
      }, {
        id: 'grade-a-no-pin',
        hasPin: false,
        reclaimable: false,
      }], gradeAKey);
      bindLoginRosterRecoveryGrant(pendingRecord, [{
        id: 'grade-b-student',
        hasPin: true,
        reclaimable: false,
      }], gradeBKey);
      const afterNonReclaimable = recoveryGrantForStudentLogin(
        'grade-a-alex',
        gradeAGrantId,
      );
      const crossStudentGrant = recoveryGrantForStudentLogin(
        'grade-a-bob',
        gradeAGrantId,
      );
      const arbitraryStudentGrant = recoveryGrantForStudentLogin(
        'not-in-the-roster',
        gradeAGrantId,
      );
      const disabledStudentGrant = recoveryGrantForStudentLogin(
        'grade-a-no-pin',
        gradeAGrantId,
      );
      const missingSnapshotGrant = recoveryGrantForStudentLogin('grade-a-bob');
      const gradeBGrantId = bindLoginRosterRecoveryGrant(pendingRecord, [{
        id: 'grade-b-student',
        hasPin: true,
        reclaimable: true,
      }], gradeBKey);
      clearLoginRosterRecoveryGrant(gradeBKey);
      const afterGradeBFailure = recoveryGrantForStudentLogin(
        'grade-a-bob',
        gradeAGrantId,
      );
      bindLoginRosterRecoveryGrant(pendingRecord, [{
        id: 'grade-a-alex',
        hasPin: true,
        reclaimable: true,
      }], gradeAKey);
      const staleRosterSnapshotGrant = recoveryGrantForStudentLogin(
        'grade-a-bob',
        gradeAGrantId,
      );
      const schoolBoundGrantId = bindLoginRosterRecoveryGrant(pendingRecord, [{
        id: 'grade-a-alex',
        hasPin: true,
        reclaimable: true,
      }, {
        id: 'grade-a-bob',
        hasPin: true,
        reclaimable: false,
      }], gradeAKey);
      CONFIG.schoolId = 'different-school';
      const wrongSchoolGrant = recoveryGrantForStudentLogin(
        'grade-a-bob',
        schoolBoundGrantId,
      );
      CONFIG.schoolId = 'manual-school';
      const generationBoundGrantId = bindLoginRosterRecoveryGrant(pendingRecord, [{
        id: 'grade-a-alex',
        hasPin: true,
        reclaimable: true,
      }, {
        id: 'grade-a-bob',
        hasPin: true,
        reclaimable: false,
      }], gradeAKey);
      await armStudentSessionRecovery({
        serverOrigin: CONFIG.serverUrl,
        schoolId: CONFIG.schoolId,
        token: 'J'.repeat(43),
        authContextId: generateAuthContextId(),
      });
      const staleRecoveryGenerationGrant = recoveryGrantForStudentLogin(
        'grade-a-bob',
        generationBoundGrantId,
      );
      await persistStudentSessionRecoveryState({
        schemaVersion: STUDENT_SESSION_RECOVERY_SCHEMA_VERSION,
        armed: null,
        pending: [pendingRecord],
      });
      const refreshedGradeAGrantId = bindLoginRosterRecoveryGrant(pendingRecord, [{
        id: 'grade-a-alex',
        hasPin: true,
        reclaimable: true,
      }, {
        id: 'grade-a-bob',
        hasPin: true,
        reclaimable: false,
      }], gradeAKey);
      let sentExactRecovery = false;
      fetchWithBackoff = async (url, requestOptions = {}) => {
        if (String(url).endsWith('/api/extension/student-login')) {
          sentExactRecovery = requestOptions.headers?.Authorization
            === `ClassPilot-Recovery ${recoveryToken}`;
          return new Response(JSON.stringify({ error: 'test rejection' }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };
      let loginRejected = false;
      try {
        await manualStudentLogin({
          mode: 'pin',
          studentId: 'grade-a-bob',
          pin: '1234',
          recoveryGrantId: refreshedGradeAGrantId,
        });
      } catch {
        loginRejected = true;
      } finally {
        fetchWithBackoff = originalFetchWithBackoff;
        resetLoginRosterRuntimeCache();
        await persistStudentSessionRecoveryState(emptyStudentSessionRecoveryState());
      }
      return {
        afterNonReclaimable: afterNonReclaimable?.token === recoveryToken,
        crossStudentGrant: crossStudentGrant?.token === recoveryToken,
        arbitraryStudentGrant: Boolean(arbitraryStudentGrant),
        disabledStudentGrant: Boolean(disabledStudentGrant),
        missingSnapshotGrant: Boolean(missingSnapshotGrant),
        opaqueGrantId: /^roster_[A-Za-z0-9_-]+$/.test(gradeAGrantId || ''),
        separateGradeGrant: /^roster_[A-Za-z0-9_-]+$/.test(gradeBGrantId || ''),
        afterGradeBFailure: afterGradeBFailure?.token === recoveryToken,
        staleRosterSnapshotGrant: Boolean(staleRosterSnapshotGrant),
        wrongSchoolGrant: Boolean(wrongSchoolGrant),
        staleRecoveryGenerationGrant: Boolean(staleRecoveryGenerationGrant),
        sentExactRecovery,
        loginRejected,
      };
    });
    assert.equal(interleavedRosterRecoveryGrants.afterNonReclaimable, true);
    assert.equal(interleavedRosterRecoveryGrants.crossStudentGrant, true);
    assert.equal(interleavedRosterRecoveryGrants.arbitraryStudentGrant, false);
    assert.equal(interleavedRosterRecoveryGrants.disabledStudentGrant, false);
    assert.equal(interleavedRosterRecoveryGrants.missingSnapshotGrant, false);
    assert.equal(interleavedRosterRecoveryGrants.opaqueGrantId, true);
    assert.equal(interleavedRosterRecoveryGrants.separateGradeGrant, true);
    assert.equal(interleavedRosterRecoveryGrants.afterGradeBFailure, true);
    assert.equal(interleavedRosterRecoveryGrants.staleRosterSnapshotGrant, false);
    assert.equal(interleavedRosterRecoveryGrants.wrongSchoolGrant, false);
    assert.equal(interleavedRosterRecoveryGrants.staleRecoveryGenerationGrant, false);
    assert.equal(interleavedRosterRecoveryGrants.sentExactRecovery, true);
    assert.equal(interleavedRosterRecoveryGrants.loginRejected, true);

    const crossStudentHandoffAfterReleaseFailure = await worker.evaluate(async () => {
      if (hasStudentAuth()) {
        const current = captureAuthenticatedContext('cross-student handoff fixture reset');
        await clearStudentAuth('cross_student_handoff_fixture_reset', {
          notifyBackend: false,
          serverSessionEnded: true,
          pauseAutoRegistration: true,
          expectedAuthContext: current,
        });
      }
      const originalFetch = globalThis.fetch;
      const originalFetchWithBackoff = fetchWithBackoff;
      const originalFastAuthGateEnabled = fastAuthGateEnabled;
      const originalCheckLicenseStatus = checkLicenseStatus;
      const originalInitializeAdaptiveTracking = initializeAdaptiveTracking;
      const originalConfig = { ...CONFIG };
      const originalSharedSignInConfig = { ...sharedSignInLoginConfig };
      const now = Date.now();
      const oldRecoveryToken = 'K'.repeat(43);
      const newRecoveryToken = 'L'.repeat(43);
      const oldRecovery = normalizeStudentSessionRecoveryRecord({
        state: 'pending',
        generation: generateStudentSessionRecoveryGeneration(),
        serverOrigin: 'https://school-pilot.net',
        schoolId: 'handoff-school',
        token: oldRecoveryToken,
        authContextId: generateAuthContextId(),
        createdAt: now,
        pendingSinceAt: now,
        attemptCount: 0,
        nextAttemptAt: now - 1,
        discardAt: now + STUDENT_SESSION_RECOVERY_PENDING_TTL_MS,
      }, 'pending', now - 1);
      let releaseRequests = 0;
      let loginRecoveryHeader = null;
      let loginBody = null;
      try {
        Object.assign(CONFIG, {
          serverUrl: 'https://school-pilot.net',
          schoolId: 'handoff-school',
          schoolSlug: 'handoff-school',
          enrollmentKey: 'handoff-enrollment-key',
          deviceId: 'handoff-device',
          studentToken: null,
          activeStudentId: null,
          activeStudentSessionId: null,
          authContextId: null,
          identitySource: null,
          autoRegistrationPaused: true,
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
          schoolId: 'handoff-school',
        };
        checkLicenseStatus = async () => {};
        initializeAdaptiveTracking = async () => {};
        resetLoginRosterRuntimeCache();
        await persistStudentSessionRecoveryState({
          schemaVersion: STUDENT_SESSION_RECOVERY_SCHEMA_VERSION,
          armed: null,
          pending: [oldRecovery],
        });
        globalThis.fetch = async (url) => {
          if (String(url).endsWith('/api/extension/session-release')) {
            releaseRequests += 1;
            return new Response(null, { status: 503 });
          }
          return new Response('{}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        };
        fetchWithBackoff = async (url, requestOptions = {}) => {
          if (String(url).includes('/api/extension/login-roster?')) {
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
            }), { status: 200, headers: { 'content-type': 'application/json' } });
          }
          if (String(url).endsWith('/api/extension/student-login')) {
            loginRecoveryHeader = requestOptions.headers?.Authorization || null;
            loginBody = JSON.parse(requestOptions.body || '{}');
            return new Response(JSON.stringify({
              schoolId: 'handoff-school',
              studentToken: 'bob-student-bearer',
              studentSessionId: 'bob-student-session',
              sessionRecovery: { token: newRecoveryToken },
              student: {
                id: 'student-bob',
                email: 'bob@example.edu',
                firstName: 'Bob',
                lastName: 'Student',
              },
            }), { status: 200, headers: { 'content-type': 'application/json' } });
          }
          return new Response('{}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        };

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
        await new Promise((resolveTick) => setTimeout(resolveTick, 0));
        const recoveryBeforeDelayedCleanup = studentSessionRecoveryState;
        const delayedOldCleanupApplied = await applyStudentSessionRecoveryReleaseOutcome(
          oldRecovery,
          { outcome: 'released', retryAfterMs: 0 },
        );
        const recoveryAfterDelayedCleanup = studentSessionRecoveryState;
        const [local, session] = await Promise.all([
          chrome.storage.local.get(STUDENT_SESSION_RECOVERY_STORAGE_KEY),
          chrome.storage.session.get([
            'studentToken',
            'activeStudentId',
            'activeStudentSessionId',
          ]),
        ]);
        return {
          releaseRequests,
          rosterGrantIdIsOpaque: /^roster_[A-Za-z0-9_-]+$/.test(roster.recoveryGrantId || ''),
          rosterStudents: roster.students.map((student) => ({
            id: student.id,
            reclaimable: student.reclaimable,
          })),
          loginSuccess: login.success === true,
          loginRecoveryHeader,
          loginBodyStudentId: loginBody?.studentId || null,
          priorPendingRemoved: !recoveryBeforeDelayedCleanup.pending.some(
            (record) => record.generation === oldRecovery.generation,
          ),
          onlyNewRecoveryArmed: recoveryBeforeDelayedCleanup.pending.length === 0
            && recoveryBeforeDelayedCleanup.armed?.token === newRecoveryToken,
          delayedOldCleanupApplied,
          newRecoverySurvivedDelayedCleanup: recoveryAfterDelayedCleanup.armed?.token
            === newRecoveryToken,
          persistedRecoveryToken:
            local[STUDENT_SESSION_RECOVERY_STORAGE_KEY]?.armed?.token || null,
          session,
        };
      } finally {
        if (hasStudentAuth()) {
          const current = captureAuthenticatedContext('cross-student handoff fixture cleanup');
          await clearStudentAuth('cross_student_handoff_fixture_cleanup', {
            notifyBackend: false,
            serverSessionEnded: true,
            pauseAutoRegistration: true,
            expectedAuthContext: current,
          });
        }
        await persistStudentSessionRecoveryState(emptyStudentSessionRecoveryState());
        resetLoginRosterRuntimeCache();
        globalThis.fetch = originalFetch;
        fetchWithBackoff = originalFetchWithBackoff;
        fastAuthGateEnabled = originalFastAuthGateEnabled;
        checkLicenseStatus = originalCheckLicenseStatus;
        initializeAdaptiveTracking = originalInitializeAdaptiveTracking;
        sharedSignInLoginConfig = originalSharedSignInConfig;
        CONFIG = originalConfig;
      }
    });
    assert.equal(crossStudentHandoffAfterReleaseFailure.releaseRequests, 1);
    assert.equal(crossStudentHandoffAfterReleaseFailure.rosterGrantIdIsOpaque, true);
    assert.deepEqual(crossStudentHandoffAfterReleaseFailure.rosterStudents, [{
      id: 'student-alex',
      reclaimable: true,
    }, {
      id: 'student-bob',
      reclaimable: false,
    }]);
    assert.equal(crossStudentHandoffAfterReleaseFailure.loginSuccess, true);
    assert.equal(
      crossStudentHandoffAfterReleaseFailure.loginRecoveryHeader,
      `ClassPilot-Recovery ${'K'.repeat(43)}`,
    );
    assert.equal(crossStudentHandoffAfterReleaseFailure.loginBodyStudentId, 'student-bob');
    assert.equal(crossStudentHandoffAfterReleaseFailure.priorPendingRemoved, true);
    assert.equal(crossStudentHandoffAfterReleaseFailure.onlyNewRecoveryArmed, true);
    assert.equal(crossStudentHandoffAfterReleaseFailure.delayedOldCleanupApplied, false);
    assert.equal(crossStudentHandoffAfterReleaseFailure.newRecoverySurvivedDelayedCleanup, true);
    assert.equal(
      crossStudentHandoffAfterReleaseFailure.persistedRecoveryToken,
      'L'.repeat(43),
    );
    assert.equal(crossStudentHandoffAfterReleaseFailure.session.studentToken, 'bob-student-bearer');
    assert.equal(crossStudentHandoffAfterReleaseFailure.session.activeStudentId, 'student-bob');
    assert.equal(
      crossStudentHandoffAfterReleaseFailure.session.activeStudentSessionId,
      'bob-student-session',
    );

    const uncorrelatedAuthorizationDenialRecovery = await worker.evaluate(async () => {
      await studentAuthMutationTail.catch(() => {});
      if (studentSessionRecoveryFlushPromise) {
        await studentSessionRecoveryFlushPromise.catch(() => {});
      }
      if (hasStudentAuth()) {
        const current = captureAuthenticatedContext('authorization denial recovery fixture reset');
        await clearStudentAuth('authorization_denial_recovery_fixture_reset', {
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

      const originalFetch = globalThis.fetch;
      const originalFetchWithBackoff = fetchWithBackoff;
      const originalFastAuthGateEnabled = fastAuthGateEnabled;
      const originalSharedSignInConfig = { ...sharedSignInLoginConfig };
      const originalConfig = { ...CONFIG };
      const originalTrackingState = trackingState;
      const originalStudentAuthInvalidating = studentAuthInvalidating;
      const originalStudentAuthCommitPending = studentAuthCommitPending;
      const originalStudentAuthCommitPendingGeneration = studentAuthCommitPendingGeneration;
      const results = [];
      let activeCase = null;
      const releaseRequests = new Map();
      const rosterRecoveryHeaders = new Map();
      const requestHeader = (headers, name) => {
        if (headers instanceof Headers) return headers.get(name);
        const entry = Object.entries(headers || {}).find(
          ([key]) => key.toLowerCase() === name.toLowerCase(),
        );
        return entry?.[1] || null;
      };

      const resetCase = async () => {
        await studentAuthMutationTail.catch(() => {});
        if (studentSessionRecoveryFlushPromise) {
          await studentSessionRecoveryFlushPromise.catch(() => {});
        }
        if (hasStudentAuth()) {
          const current = captureAuthenticatedContext('authorization denial case reset');
          await clearStudentAuth('authorization_denial_case_reset', {
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
        studentAuthInvalidating = false;
        studentAuthCommitPending = false;
        studentAuthCommitPendingGeneration = 0;
        screenshotCaptureInFlight = false;
        screenshotImmediateCapturePending = false;
        lastScreenshotAttemptAt = 0;
        apiBackoffUntilMs = 0;
      };

      globalThis.fetch = async (url) => {
        if (String(url).endsWith('/api/extension/session-release')) {
          releaseRequests.set(activeCase, (releaseRequests.get(activeCase) || 0) + 1);
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

      const runCase = async (source, status) => {
        await resetCase();
        activeCase = `${source}-${status}`;
        const authContextId = generateAuthContextId();
        const recoveryToken = (source === 'heartbeat' ? 'Q' : 'W').repeat(43);
        const schoolId = `auth-denial-${source}-${status}`;
        Object.assign(CONFIG, {
          serverUrl: 'https://school-pilot.net',
          schoolId,
          schoolSlug: schoolId,
          enrollmentKey: 'auth-denial-enrollment-key',
          deviceId: `auth-denial-${source}-device`,
          studentToken: `auth-denial-${source}-bearer`,
          activeStudentId: `auth-denial-${source}-student`,
          activeStudentSessionId: `auth-denial-${source}-session`,
          authContextId,
          studentEmail: `${source}@example.edu`,
          studentName: `${source} fixture`,
          identitySource: 'manual_pin',
          manualLoginLastSeenAt: Date.now(),
          autoRegistrationPaused: false,
        });
        sharedSignInLoginConfig = {
          ...sharedSignInLoginConfig,
          phase: 'ready',
          sharedSignInEnabled: true,
          loginMethod: 'name_pin',
          pinLoginEnabled: true,
          schoolId,
        };
        fastAuthGateEnabled = false;
        await setManualAuthState({
          authContextId,
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
        activateAuthenticatedContext(authContextId);
        const authContext = captureAuthenticatedContext(`${activeCase} fixture`);
        await armStudentSessionRecovery({
          serverOrigin: authContext.serverOrigin,
          schoolId: authContext.schoolId,
          token: recoveryToken,
          authContextId,
        });
        adoptLicenseState(true, 'active', authContext);
        trackingState = TRACKING_STATES.ACTIVE;
        if (source === 'screenshot') {
          adoptNegotiatedProtocolState({
            serverProtocolVersion: 3,
            acceptedCapabilities: [
              'scopedAuthorityChecksV1',
              'screenshotTrackingWindowLeaseV1',
            ],
          }, authContext);
          screenshotCaptureInFlight = true;
          adoptScreenshotPolicy({
            mode: 'tracking_window_lease',
            captureAllowed: true,
            expiresInSeconds: 90,
            serverTime: new Date().toISOString(),
            authority: { kind: 'student_session', controlRevision: 1 },
          }, authContext);
          screenshotCaptureInFlight = false;
          screenshotImmediateCapturePending = false;
        }

        fetchWithBackoff = async (url, requestOptions = {}) => {
          const requestUrl = String(url);
          if (requestUrl.includes('/api/extension/login-roster?')) {
            rosterRecoveryHeaders.set(
              activeCase,
              requestHeader(requestOptions.headers, 'Authorization'),
            );
            return new Response(JSON.stringify({
              loginMethod: 'name_pin',
              students: [{
                id: `auth-denial-${source}-student`,
                name: `${source} fixture`,
                hasPin: true,
                reclaimable: true,
              }],
              grades: [{ value: '5', label: 'Grade 5' }],
            }), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          }
          if (
            (source === 'heartbeat' && requestUrl.endsWith('/api/device/heartbeat'))
            || (source === 'screenshot' && requestUrl.includes('/api/classpilot/device/screenshot'))
          ) {
            return new Response(JSON.stringify({ code: 'AUTHORIZATION_DENIED' }), {
              status,
              headers: { 'content-type': 'application/json' },
            });
          }
          return new Response('{}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        };

        let pathResult = null;
        if (source === 'heartbeat') {
          await sendHeartbeat(`authorization-denial-${status}`);
        } else {
          pathResult = await captureAndSendScreenshot({
            reason: `authorization-denial-${status}`,
            queryActiveTab: async () => [{
              id: 7400 + status,
              windowId: 74,
              active: true,
              url: 'https://fixture.example/authorization-denial',
              title: 'Authorization denial fixture',
            }],
            captureVisibleTab: async () => 'data:image/jpeg;base64,YXV0aC1kZW5pYWw=',
            subscribeTabActivation: () => () => {},
            subscribeTabUpdate: () => () => {},
            subscribeWindowFocus: () => () => {},
          });
        }

        await studentAuthMutationTail.catch(() => {});
        await Promise.resolve();
        if (studentSessionRecoveryFlushPromise) {
          await studentSessionRecoveryFlushPromise.catch(() => {});
        }
        const pendingRecovery = matchingStudentSessionRecoveryRecord();
        const persisted = await chrome.storage.local.get(STUDENT_SESSION_RECOVERY_STORAGE_KEY);
        const roster = pendingRecovery
          ? await fetchLoginRosterNetworkForGate({
            gradeLevel: '5',
            recoveryRecord: pendingRecovery,
          })
          : null;
        results.push({
          source,
          status,
          pathResult,
          hasStudentAuth: hasStudentAuth(),
          autoRegistrationPaused: CONFIG.autoRegistrationPaused === true,
          pendingRecovery: pendingRecovery?.state === 'pending',
          recoveryPersisted: persisted[STUDENT_SESSION_RECOVERY_STORAGE_KEY]?.pending?.some(
            (record) => record.token === recoveryToken,
          ) === true,
          releaseRequests: releaseRequests.get(activeCase) || 0,
          rosterSentRecovery: rosterRecoveryHeaders.get(activeCase)
            === `ClassPilot-Recovery ${recoveryToken}`,
          reclaimable: roster?.students?.[0]?.reclaimable === true,
        });
      };

      try {
        for (const source of ['heartbeat', 'screenshot']) {
          for (const status of [401, 403]) {
            await runCase(source, status);
          }
        }
        return results;
      } finally {
        await resetCase();
        globalThis.fetch = originalFetch;
        fetchWithBackoff = originalFetchWithBackoff;
        fastAuthGateEnabled = originalFastAuthGateEnabled;
        sharedSignInLoginConfig = originalSharedSignInConfig;
        CONFIG = originalConfig;
        trackingState = originalTrackingState;
        studentAuthInvalidating = originalStudentAuthInvalidating;
        studentAuthCommitPending = originalStudentAuthCommitPending;
        studentAuthCommitPendingGeneration = originalStudentAuthCommitPendingGeneration;
      }
    });
    assert.equal(uncorrelatedAuthorizationDenialRecovery.length, 4);
    for (const result of uncorrelatedAuthorizationDenialRecovery) {
      assert.equal(result.hasStudentAuth, false, JSON.stringify(result));
      assert.equal(result.autoRegistrationPaused, true, JSON.stringify(result));
      assert.equal(result.pendingRecovery, true, JSON.stringify(result));
      assert.equal(result.recoveryPersisted, true, JSON.stringify(result));
      assert.ok(result.releaseRequests >= 1, JSON.stringify(result));
      assert.equal(result.rosterSentRecovery, true, JSON.stringify(result));
      assert.equal(result.reclaimable, true, JSON.stringify(result));
      if (result.source === 'screenshot') {
        assert.deepEqual(result.pathResult, {
          status: 'paused_unobserved',
          reason: 'authorization_denied',
        });
      }
    }

    const malformedRosterValidationModes = await worker.evaluate(async () => {
      const originalFastAuthGateEnabled = fastAuthGateEnabled;
      const originalFetchAuthGateRequest = fetchAuthGateRequest;
      const originalFetchWithBackoff = fetchWithBackoff;
      const originalSharedSignInConfig = { ...sharedSignInLoginConfig };
      const originalConfig = { ...CONFIG };
      Object.assign(CONFIG, {
        serverUrl: 'https://school-pilot.net',
        schoolId: 'manual-school',
        schoolSlug: 'manual-school',
        enrollmentKey: 'managed-enrollment-key',
        studentToken: null,
        activeStudentId: null,
        activeStudentSessionId: null,
        identitySource: null,
      });
      studentAuthInvalidating = false;
      studentAuthCommitPending = false;
      sharedSignInLoginConfig = {
        ...sharedSignInLoginConfig,
        phase: 'ready',
      };
      const run = async (fast) => {
        fastAuthGateEnabled = fast;
        fetchAuthGateRequest = async () => ({
          response: new Response('true', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
          data: {},
          jsonValid: false,
        });
        fetchWithBackoff = async () => new Response('true', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
        return fetchLoginRosterNetworkForGate({ gradeLevel: '5' });
      };
      try {
        return {
          fast: await run(true),
          legacy: await run(false),
        };
      } finally {
        fastAuthGateEnabled = originalFastAuthGateEnabled;
        fetchAuthGateRequest = originalFetchAuthGateRequest;
        fetchWithBackoff = originalFetchWithBackoff;
        sharedSignInLoginConfig = originalSharedSignInConfig;
        CONFIG = originalConfig;
      }
    });
    for (const mode of ['fast', 'legacy']) {
      assert.equal(malformedRosterValidationModes[mode].success, false);
      assert.equal(malformedRosterValidationModes[mode].unavailable, true);
      assert.match(
        malformedRosterValidationModes[mode].error || '',
        /invalid roster response/,
      );
    }

    const slugOnlyRecoveryBinding = await worker.evaluate(async () => {
      const originalFetch = globalThis.fetch;
      const originalFetchWithBackoff = fetchWithBackoff;
      const originalFastAuthGateEnabled = fastAuthGateEnabled;
      const originalFetchClientConfig = fetchClientConfig;
      const originalReadManagedConfig = readManagedConfig;
      const originalDetectChromeProfileEmail = detectChromeProfileEmail;
      let releaseRequests = 0;
      let profileRegisterRequests = 0;
      let rosterRecoveryHeader = null;
      const managedPolicy = {
        serverUrl: 'https://school-pilot.net',
        schoolSlug: 'managed-school-slug',
        enrollmentKey: 'managed-school-enrollment',
      };
      const descriptor = managedAuthGatePolicyDescriptor(managedPolicy);
      const priorBinding = persistedManagedAuthGateDescriptor(descriptor);
      const authContextId = generateAuthContextId();
      const now = Date.now();
      const recoveryToken = 'H'.repeat(43);
      const armed = normalizeStudentSessionRecoveryRecord({
        state: 'armed',
        generation: generateStudentSessionRecoveryGeneration(),
        serverOrigin: 'https://school-pilot.net',
        schoolId: 'canonical-school-id',
        token: recoveryToken,
        authContextId,
        createdAt: now,
      }, 'armed', now);
      globalThis.fetch = async (url) => {
        if (String(url).endsWith('/api/extension/session-release')) {
          releaseRequests += 1;
          return new Response(null, { status: 503 });
        }
        return new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };
      fetchWithBackoff = async (url, requestOptions = {}) => {
        if (String(url).endsWith('/api/extension/register')) {
          profileRegisterRequests += 1;
          return new Response(JSON.stringify({ error: 'unexpected profile registration' }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (String(url).includes('/api/extension/login-roster?')) {
          rosterRecoveryHeader = requestOptions.headers?.Authorization || null;
          return new Response(JSON.stringify({
            loginMethod: 'name_pin',
            students: [{
              id: 'slug-recovery-student',
              name: 'Slug Recovery Student',
              hasPin: true,
              reclaimable: true,
            }],
            grades: [],
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        }
        return new Response('{}', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      };
      try {
        Object.assign(CONFIG, {
          serverUrl: managedPolicy.serverUrl,
          schoolId: 'canonical-school-id',
          schoolSlug: managedPolicy.schoolSlug,
          enrollmentKey: managedPolicy.enrollmentKey,
          deviceId: 'slug-recovery-device',
          studentToken: 'slug-recovery-bearer',
          activeStudentId: 'slug-recovery-student',
          activeStudentSessionId: 'slug-recovery-session',
          authContextId,
          identitySource: 'manual_pin',
          manualLoginLastSeenAt: now,
        });
        studentAuthInvalidating = false;
        studentAuthCommitPending = false;
        await persistStudentSessionRecoveryState({
          schemaVersion: STUDENT_SESSION_RECOVERY_SCHEMA_VERSION,
          armed,
          pending: [],
        });
        applyAuthoritativeManagedAuthGateSnapshot(
          managedPolicy,
          priorBinding,
          false,
          { persist: false },
        );
        await reconcileStudentSessionRecoveryAtWorkerWake({
          authContextId,
          studentToken: CONFIG.studentToken,
          activeStudentId: CONFIG.activeStudentId,
          activeStudentSessionId: CONFIG.activeStudentSessionId,
          identitySource: CONFIG.identitySource,
        });
        const workerWakeRetained = CONFIG.schoolId === 'canonical-school-id'
          && studentSessionRecoveryState.armed?.token === recoveryToken
          && releaseRequests === 0;

        CONFIG.studentToken = null;
        CONFIG.activeStudentId = null;
        CONFIG.activeStudentSessionId = null;
        CONFIG.authContextId = null;
        CONFIG.identitySource = null;
        CONFIG.manualLoginLastSeenAt = null;
        await reconcileStudentSessionRecoveryAtWorkerWake({}, {
          forceReauthentication: true,
        });
        await studentSessionRecoveryMutationTail;
        if (studentSessionRecoveryFlushPromise) {
          await studentSessionRecoveryFlushPromise.catch(() => {});
        }
        const pending = matchingStudentSessionRecoveryRecord();
        fetchClientConfig = async () => ({});
        readManagedConfig = async () => managedPolicy;
        detectChromeProfileEmail = async () => 'detectable-profile@example.edu';
        await ensureRegisteredNow();
        const persistedPause = await chrome.storage.local.get('autoRegistrationPaused');
        fastAuthGateEnabled = false;
        const roster = await fetchLoginRosterNetworkForGate({
          gradeLevel: '5',
          recoveryRecord: pending,
        });

        Object.assign(CONFIG, {
          serverUrl: managedPolicy.serverUrl,
          schoolId: 'canonical-school-id',
          schoolSlug: managedPolicy.schoolSlug,
          enrollmentKey: managedPolicy.enrollmentKey,
        });
        applyAuthoritativeManagedAuthGateSnapshot({
          ...managedPolicy,
          enrollmentKey: 'changed-enrollment-authority',
        }, priorBinding, false, { persist: false });
        return {
          workerWakeRetained,
          browserRestartPending: pending?.state === 'pending',
          reclaimOffered: roster.students?.[0]?.reclaimable === true,
          rosterSentExactRecovery: rosterRecoveryHeader
            === `ClassPilot-Recovery ${recoveryToken}`,
          changedAuthorityPurgedCanonicalSchool: CONFIG.schoolId === null,
          autoRegistrationPaused: persistedPause.autoRegistrationPaused === true,
          profileRegisterRequests,
          releaseRequests,
        };
      } finally {
        fastAuthGateEnabled = originalFastAuthGateEnabled;
        fetchClientConfig = originalFetchClientConfig;
        readManagedConfig = originalReadManagedConfig;
        detectChromeProfileEmail = originalDetectChromeProfileEmail;
        globalThis.fetch = originalFetch;
        fetchWithBackoff = originalFetchWithBackoff;
        resetLoginRosterRuntimeCache();
        await persistStudentSessionRecoveryState(emptyStudentSessionRecoveryState());
      }
    });
    assert.equal(slugOnlyRecoveryBinding.workerWakeRetained, true);
    assert.equal(slugOnlyRecoveryBinding.browserRestartPending, true);
    assert.equal(slugOnlyRecoveryBinding.reclaimOffered, true);
    assert.equal(slugOnlyRecoveryBinding.rosterSentExactRecovery, true);
    assert.equal(slugOnlyRecoveryBinding.changedAuthorityPurgedCanonicalSchool, true);
    assert.equal(slugOnlyRecoveryBinding.autoRegistrationPaused, true);
    assert.equal(slugOnlyRecoveryBinding.profileRegisterRequests, 0);
    assert.ok(slugOnlyRecoveryBinding.releaseRequests >= 1);

    const delayedRegistrationAfterClear = await worker.evaluate(async () => {
      if (chromeProfileRegistrationInFlight) {
        await chromeProfileRegistrationInFlight.catch(() => {});
      }
      const originalFetchWithBackoff = fetchWithBackoff;
      let markRegistrationStarted;
      let releaseRegistration;
      const registrationStarted = new Promise((resolveStarted) => {
        markRegistrationStarted = resolveStarted;
      });
      const registrationResponse = new Promise((resolveResponse) => {
        releaseRegistration = resolveResponse;
      });
      CONFIG.deviceId = 'delayed-registration-device';
      CONFIG.activeStudentId = 'prior-registration-student';
      CONFIG.activeStudentSessionId = 'prior-registration-session';
      CONFIG.studentToken = 'prior-registration-token';
      studentAuthInvalidating = false;
      fetchWithBackoff = async (url, ...args) => {
        if (String(url).endsWith('/api/extension/register')) {
          markRegistrationStarted();
          return registrationResponse;
        }
        return originalFetchWithBackoff(url, ...args);
      };
      try {
        const pendingRegistration = registerDeviceWithStudent(
          CONFIG.deviceId,
          null,
          'auto',
          'delayed-registration@example.edu',
          'Delayed Registration',
        ).then(
          () => ({ resolved: true }),
          (error) => ({ resolved: false, code: error?.code, error: error?.message }),
        );
        await registrationStarted;
        await clearStudentAuth('delayed-registration-clear', {
          notifyBackend: false,
          pauseAutoRegistration: true,
        });
        releaseRegistration(new Response(JSON.stringify({
          schoolId: 'retired-registration-school',
          studentToken: 'retired-registration-token',
          studentSessionId: 'retired-registration-session',
          student: { id: 'retired-registration-student' },
        }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }));
        const registration = await pendingRegistration;
        const stored = await chrome.storage.local.get([
          'activeStudentId',
          'activeStudentSessionId',
          'studentToken',
          STUDENT_AUTH_INVALIDATING_KEY,
        ]);
        return {
          registration,
          stored,
          activeStudentId: CONFIG.activeStudentId,
          activeStudentSessionId: CONFIG.activeStudentSessionId,
          studentToken: CONFIG.studentToken,
        };
      } finally {
        fetchWithBackoff = originalFetchWithBackoff;
      }
    });
    assert.equal(delayedRegistrationAfterClear.registration.resolved, false);
    assert.equal(delayedRegistrationAfterClear.registration.code, 'AUTH_MUTATION_SUPERSEDED');
    assert.equal(delayedRegistrationAfterClear.activeStudentId, null);
    assert.equal(delayedRegistrationAfterClear.activeStudentSessionId, null);
    assert.equal(delayedRegistrationAfterClear.studentToken, null);
    assert.equal(delayedRegistrationAfterClear.stored.activeStudentId, undefined);
    assert.equal(delayedRegistrationAfterClear.stored.activeStudentSessionId, undefined);
    assert.equal(delayedRegistrationAfterClear.stored.studentToken, undefined);
    assert.equal(delayedRegistrationAfterClear.stored.studentAuthInvalidatingV1, undefined);

    const completedAuthClear = await worker.evaluate(async () => {
      CONFIG.deviceId = 'completed-clear-device';
      CONFIG.activeStudentId = 'completed-clear-student';
      CONFIG.activeStudentSessionId = 'completed-clear-session';
      CONFIG.studentToken = 'completed-clear-token';
      CONFIG.studentEmail = 'completed-clear@example.edu';
      CONFIG.identitySource = 'manual_email_id';
      studentAuthInvalidating = false;
      await chrome.storage.local.set({
        config: {
          serverUrl: CONFIG.serverUrl,
          deviceId: CONFIG.deviceId,
          studentToken: CONFIG.studentToken,
          activeStudentId: CONFIG.activeStudentId,
          activeStudentSessionId: CONFIG.activeStudentSessionId,
          studentEmail: CONFIG.studentEmail,
          identitySource: CONFIG.identitySource,
        },
        activeStudentId: CONFIG.activeStudentId,
        activeStudentSessionId: CONFIG.activeStudentSessionId,
        studentToken: CONFIG.studentToken,
      });
      await clearStudentAuth('completed-clear-restart-fixture', {
        notifyBackend: false,
        pauseAutoRegistration: true,
      });
      return chrome.storage.local.get([
        'config',
        'activeStudentId',
        'activeStudentSessionId',
        'studentToken',
        STUDENT_AUTH_INVALIDATING_KEY,
      ]);
    });
    assert.equal(completedAuthClear.activeStudentId, undefined);
    assert.equal(completedAuthClear.activeStudentSessionId, undefined);
    assert.equal(completedAuthClear.studentToken, undefined);
    assert.equal(completedAuthClear.studentAuthInvalidatingV1, undefined);
    assert.equal(completedAuthClear.config.activeStudentId, undefined);
    assert.equal(completedAuthClear.config.activeStudentSessionId, undefined);
    assert.equal(completedAuthClear.config.studentToken, undefined);

    await context.close();
    context = await launchTestContext(executablePath);
    worker = await waitForInitialWorker(context);
    attachWorkerErrorCapture(worker, serviceWorkerErrors);
    await worker.evaluate(async () => classroomStateRestorePromise);
    const completedClearRestart = await worker.evaluate(() => ({
      hasStudentAuth: hasStudentAuth(),
      activeStudentId: CONFIG.activeStudentId,
      activeStudentSessionId: CONFIG.activeStudentSessionId,
      studentToken: CONFIG.studentToken,
    }));
    assert.equal(completedClearRestart.hasStudentAuth, false);
    assert.equal(completedClearRestart.activeStudentId, null);
    assert.equal(completedClearRestart.activeStudentSessionId, null);
    assert.equal(completedClearRestart.studentToken, null);

    await worker.evaluate(async ({ now }) => {
      CONFIG.deviceId = 'interrupted-clear-device';
      CONFIG.activeStudentId = 'interrupted-clear-student';
      CONFIG.activeStudentSessionId = 'interrupted-clear-session';
      CONFIG.studentToken = 'interrupted-clear-token';
      studentAuthInvalidating = false;
      await applyClassroomState({
        schemaVersion: 1,
        revision: 1001,
        teachingSessionId: 'interrupted-clear-class',
        receivedAt: now,
        hardExpiresAt: now + 60 * 60 * 1000,
        restrictions: {
          blockList: {
            active: true,
            blockedDomains: ['interrupted-clear.example'],
            name: 'Interrupted clear fixture',
          },
        },
      }, { force: true, reason: 'interrupted-clear-restart-fixture' });
      await chrome.storage.local.set({
        config: {
          serverUrl: CONFIG.serverUrl,
          deviceId: CONFIG.deviceId,
          studentToken: CONFIG.studentToken,
          activeStudentId: CONFIG.activeStudentId,
          activeStudentSessionId: CONFIG.activeStudentSessionId,
          studentEmail: 'interrupted-clear@example.edu',
          identitySource: 'manual_email_id',
        },
        activeStudentId: CONFIG.activeStudentId,
        activeStudentSessionId: CONFIG.activeStudentSessionId,
        studentToken: CONFIG.studentToken,
        [STUDENT_AUTH_INVALIDATING_KEY]: true,
      });
    }, { now: Date.now() });

    await context.close();
    context = await launchTestContext(executablePath);
    worker = await waitForInitialWorker(context);
    attachWorkerErrorCapture(worker, serviceWorkerErrors);
    const interruptedDeadline = Date.now() + 10_000;
    let interruptedClearRestart;
    while (Date.now() < interruptedDeadline) {
      interruptedClearRestart = await worker.evaluate(async () => {
        await classroomStateRestorePromise;
        const stored = await chrome.storage.local.get([
          'config',
          'activeStudentId',
          'activeStudentSessionId',
          'studentToken',
          STUDENT_AUTH_INVALIDATING_KEY,
          CLASSROOM_STATE_STORAGE_KEY,
        ]);
        const teacherRanges = ['classroom', 'teacher', 'temporary']
          .map((name) => RuntimeCore.DNR_RANGES[name]);
        const teacherRuleIds = (await chrome.declarativeNetRequest.getDynamicRules())
          .filter((rule) => teacherRanges.some(([start, end]) => rule.id >= start && rule.id < end))
          .map((rule) => rule.id);
        return {
          cleanupFinished: stored[STUDENT_AUTH_INVALIDATING_KEY] !== true,
          hasStudentAuth: hasStudentAuth(),
          activeStudentId: CONFIG.activeStudentId,
          activeStudentSessionId: CONFIG.activeStudentSessionId,
          studentToken: CONFIG.studentToken,
          classroomState: currentClassroomState,
          stored,
          teacherRuleIds,
        };
      });
      if (interruptedClearRestart.cleanupFinished && !interruptedClearRestart.classroomState) break;
      await new Promise((resolvePoll) => setTimeout(resolvePoll, 100));
    }
    assert.equal(interruptedClearRestart.cleanupFinished, true);
    assert.equal(interruptedClearRestart.hasStudentAuth, false);
    assert.equal(interruptedClearRestart.activeStudentId, null);
    assert.equal(interruptedClearRestart.activeStudentSessionId, null);
    assert.equal(interruptedClearRestart.studentToken, null);
    assert.equal(interruptedClearRestart.classroomState, null);
    assert.equal(interruptedClearRestart.stored.classroomControlStateV1, undefined);
    assert.equal(interruptedClearRestart.stored.config.activeStudentId, undefined);
    assert.equal(interruptedClearRestart.stored.config.activeStudentSessionId, undefined);
    assert.equal(interruptedClearRestart.stored.config.studentToken, undefined);
    assert.deepEqual(interruptedClearRestart.teacherRuleIds, []);
    assert.deepEqual(serviceWorkerErrors, []);

    console.log('ClassPilot extension resilience integration test passed.');
    console.log('Verified restart/tab restore, connectivity and screenshot diagnostics, canonical entitlement revocation cleanup, transient-command expiry, durable ACK receipts, school-policy close/tab-limit authority isolation, opaque exact-tab close/stale rejection, revisioned FAB lifecycle, binding-scoped timer/poll restoration, ordered MV3 WebSocket lifetime, completed/interrupted auth-clear restart safety, best-effort tab failure safety, explicit-null reconciliation, expiry retry, missing/corrupt school-policy preservation, DNR/revision safety, oversized-list failure, auth-bound event outbox isolation, and restart-safe identity-bound teacher-message dedup.');
  } finally {
    await context?.close();
    if (navigationFixtureServer) {
      await new Promise((resolveClose) => navigationFixtureServer.close(resolveClose));
    }
    rmSync(profilePath, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
