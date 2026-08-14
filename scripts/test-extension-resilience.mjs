import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const extensionPath = resolve(repoRoot, 'extension');
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

  let context;
  const serviceWorkerErrors = [];
  try {
    context = await launchTestContext(executablePath);

    let worker = await waitForInitialWorker(context);
    attachWorkerErrorCapture(worker, serviceWorkerErrors);
    const initialNow = Date.now();
    const initial = await worker.evaluate(async ({ now }) => {
      await updateGlobalBlacklistRules(['school-policy.example']);
      await chrome.storage.local.set({ globalBlockedDomains: ['school-policy.example'] });
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
      });
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

    const diagnosticsBeforeRestart = await worker.evaluate(async () => {
      CONFIG.deviceId = 'diagnostic-device';
      CONFIG.activeStudentId = 'diagnostic-student';
      CONFIG.studentToken = 'diagnostic-token';
      licenseActive = true;
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

    // Closing and reopening the isolated browser profile guarantees that the
    // MV3 worker is destroyed and recreated while preserving local storage and
    // dynamic DNR rules exactly as a real device/browser restart would.
    await context.close();
    context = await launchTestContext(executablePath);
    worker = await waitForInitialWorker(context);
    attachWorkerErrorCapture(worker, serviceWorkerErrors);
    await waitForRestoredRevision(worker, 42);

    const restored = await worker.evaluate(async () => ({
      revision: currentClassroomState?.revision,
      ruleIds: (await chrome.declarativeNetRequest.getDynamicRules())
        .map((rule) => rule.id)
        .sort((a, b) => a - b),
      runtime: await getClassroomCommandStateSnapshot(),
    }));
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
      try {
        result = await handleRemoteControl({
          type: 'open-tab',
          data: { url: expiredUrl },
        }, {
          commandId: 'expired-integration-command',
          deliveryPolicy: 'transient_action',
          expiresAt: new Date(Date.now() - 1).toISOString(),
        });
      } finally {
        wsSend = originalWsSend;
      }
      const after = (await chrome.tabs.query({})).filter((tab) => tab.url === expiredUrl).length;
      return { before, after, result, acknowledgements };
    });
    assert.equal(expiredTransient.before, 0);
    assert.equal(expiredTransient.after, 0);
    assert.equal(expiredTransient.result.expired, true);
    assert.deepEqual(expiredTransient.acknowledgements.map((ack) => ack.ackState), ['expired']);

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
        await handleRemoteControl({ type: 'open-tab', data: { url: 'https://accepted.example' } }, {
          commandId: 'accepted-integration-command',
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

    const reconciliationNow = Date.now();
    const reconciled = await worker.evaluate(async ({ now }) => {
      const cleared = await applyClassroomState({
        schemaVersion: 1,
        revision: 43,
        teachingSessionId: 'integration-session',
        receivedAt: now,
        hardExpiresAt: now + 60 * 60 * 1000,
        restrictions: {},
      });
      const stale = await applyClassroomState({
        schemaVersion: 1,
        revision: 42,
        teachingSessionId: 'integration-session',
        receivedAt: now,
        hardExpiresAt: now + 60 * 60 * 1000,
        restrictions: {
          blockList: { active: true, blockedDomains: ['stale.example'] },
        },
      });
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

    const existingTabReconciliation = await worker.evaluate(async ({ now }) => {
      await chrome.tabs.create({ url: 'chrome://version/', active: false });
      await chrome.tabs.create({ url: 'https://outside.example/one', active: true });
      await chrome.tabs.create({ url: 'https://other.example/two', active: false });
      await applyClassroomState({
        schemaVersion: 1,
        revision: 46,
        teachingSessionId: 'integration-session',
        receivedAt: now,
        hardExpiresAt: now + 60 * 60 * 1000,
        restrictions: {
          screenLock: {
            active: true,
            url: 'https://lock.example/assignment',
            domain: 'lock.example',
          },
        },
      });
      const afterLock = await chrome.tabs.query({});

      await applyClassroomState({
        schemaVersion: 1,
        revision: 47,
        teachingSessionId: 'integration-session',
        receivedAt: now,
        hardExpiresAt: now + 60 * 60 * 1000,
        restrictions: {},
      });
      await chrome.tabs.create({ url: 'https://flight.example/already-allowed', active: false });
      await chrome.tabs.create({ url: 'https://outside.example/active', active: true });
      await chrome.tabs.create({ url: 'https://other.example/remove', active: false });
      await applyClassroomState({
        schemaVersion: 1,
        revision: 48,
        teachingSessionId: 'integration-session',
        receivedAt: now,
        hardExpiresAt: now + 60 * 60 * 1000,
        restrictions: {
          flightPath: { active: true, allowedDomains: ['flight.example'] },
        },
      });
      const afterFlightPath = await chrome.tabs.query({});
      const effectiveUrl = (tab) => tab.pendingUrl || tab.url || '';
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
    }, { now: Date.now() });
    assert.ok(existingTabReconciliation.afterLock.internal.length >= 1);
    assert.deepEqual(existingTabReconciliation.afterLock.web, ['https://lock.example/assignment']);
    assert.ok(existingTabReconciliation.afterFlightPath.internal.length >= 1);
    assert.equal(existingTabReconciliation.afterFlightPath.web.length, 2);
    assert.ok(existingTabReconciliation.afterFlightPath.web.every((url) =>
      new URL(url).hostname === 'flight.example'
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
      CONFIG.activeStudentId = 'previous-student';
      await chrome.storage.local.set({
        [CLASSROOM_STATE_STUDENT_BINDING_KEY]: CONFIG.activeStudentId,
      });
      CONFIG.activeStudentId = 'next-student';
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
      const stored = await chrome.storage.local.get([
        CLASSROOM_STATE_STORAGE_KEY,
        CLASSROOM_STATE_STUDENT_BINDING_KEY,
      ]);
      return {
        revision: currentClassroomState?.revision,
        teachingSessionId: currentClassroomState?.teachingSessionId,
        storedRevision: stored[CLASSROOM_STATE_STORAGE_KEY]?.revision,
        studentBinding: stored[CLASSROOM_STATE_STUDENT_BINDING_KEY],
      };
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
      const stored = await chrome.storage.local.get([
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
      CONFIG.deviceId = 'integration-device';
      CONFIG.activeStudentId = 'integration-student';
      CONFIG.studentToken = 'old-session-token';
      const scope = {
        teachingSessionId: 'integration-event-session',
        supervisionContextId: null,
      };
      await enqueueMonitoringEvent('navigation_changed', {
        url: 'https://example.com/old?secret=1',
        title: 'Old student event',
      }, scope);
      CONFIG.studentToken = 'new-session-token';
      await enqueueMonitoringEvent('navigation_changed', {
        url: 'https://example.com/new?secret=2',
        title: 'New student event',
      }, scope);
      if (monitoringEventFlushTimer) {
        clearTimeout(monitoringEventFlushTimer);
        monitoringEventFlushTimer = null;
      }
      await chrome.alarms.clear(MONITORING_EVENT_FLUSH_ALARM);
      const stored = await chrome.storage.local.get([
        MONITORING_EVENT_OUTBOX_KEY,
        MONITORING_EVENT_DROPPED_KEY,
        MONITORING_EVENT_AUTH_BINDING_KEY,
      ]);
      await chrome.storage.local.remove([
        MONITORING_EVENT_OUTBOX_KEY,
        MONITORING_EVENT_DROPPED_KEY,
        MONITORING_EVENT_AUTH_BINDING_KEY,
      ]);
      return stored;
    });
    assert.equal(authBoundOutbox.monitoringEventOutboxV1.length, 1);
    assert.equal(authBoundOutbox.monitoringEventOutboxV1[0].title, 'New student event');
    assert.equal(authBoundOutbox.monitoringEventOutboxDropped, 1);
    assert.equal(authBoundOutbox.monitoringEventOutboxAuthBindingV1.includes('new-session-token'), false);

    const corruptSchoolPolicySetup = await worker.evaluate(async ({ now }) => {
      const application = await applyClassroomState({
        schemaVersion: 1,
        revision: 2,
        teachingSessionId: 'next-student-session',
        receivedAt: now,
        hardExpiresAt: now + 60 * 60 * 1000,
        restrictions: {
          blockList: { active: true, blockedDomains: ['teacher-survives.example'] },
        },
      });
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
    await waitForRestoredRevision(worker, 2);
    const corruptSchoolPolicyRestore = await worker.evaluate(async () => ({
      revision: currentClassroomState?.revision,
      teacherBlockedDomains: [...teacherBlockedDomains],
      ruleIds: (await chrome.declarativeNetRequest.getDynamicRules())
        .map((rule) => rule.id)
        .sort((a, b) => a - b),
    }));
    assert.equal(corruptSchoolPolicyRestore.revision, 2);
    assert.deepEqual(corruptSchoolPolicyRestore.teacherBlockedDomains, ['teacher-survives.example']);
    assert.deepEqual(corruptSchoolPolicyRestore.ruleIds, [1000, 2000]);

    await worker.evaluate(async () => {
      await chrome.storage.local.remove('globalBlockedDomains');
    });
    await context.close();
    context = await launchTestContext(executablePath);
    worker = await waitForInitialWorker(context);
    attachWorkerErrorCapture(worker, serviceWorkerErrors);
    await waitForRestoredRevision(worker, 2);
    const missingSchoolPolicyRestore = await worker.evaluate(async () => ({
      revision: currentClassroomState?.revision,
      ruleIds: (await chrome.declarativeNetRequest.getDynamicRules())
        .map((rule) => rule.id)
        .sort((a, b) => a - b),
    }));
    assert.equal(missingSchoolPolicyRestore.revision, 2);
    assert.deepEqual(missingSchoolPolicyRestore.ruleIds, [1000, 2000]);

    const initialInbox = await worker.evaluate(async () => {
      CONFIG.deviceId = 'message-inbox-device';
      CONFIG.activeStudentId = 'message-inbox-student-a';
      CONFIG.studentEmail = 'student-a@example.edu';
      CONFIG.studentName = 'Student A';
      CONFIG.studentToken = 'message-inbox-session-a';
      CONFIG.identitySource = 'integration_test';
      CONFIG.autoRegistrationPaused = true;
      await chrome.storage.local.set({
        deviceId: CONFIG.deviceId,
        activeStudentId: CONFIG.activeStudentId,
        studentEmail: CONFIG.studentEmail,
        studentName: CONFIG.studentName,
        studentToken: CONFIG.studentToken,
        registered: true,
        lastRegisteredEmail: CONFIG.studentEmail,
        identitySource: CONFIG.identitySource,
        autoRegistrationPaused: true,
      });
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
      const stored = await chrome.storage.local.get([
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
    await worker.evaluate(async () => classroomStateRestorePromise);
    const restartedInbox = await worker.evaluate(async () => {
      const before = await getCurrentMessageInbox();
      const merged = await persistHeartbeatPendingMessages([
        { id: 'pending-1', message: 'First pending message' },
        { id: 'pending-3', message: 'New after worker restart' },
      ]);
      return { before, merged };
    });
    assert.deepEqual(restartedInbox.before.map((message) => message.id), ['pending-1', 'pending-2']);
    assert.deepEqual(restartedInbox.merged.addedMessageIds, ['pending-3']);
    assert.deepEqual(restartedInbox.merged.messages.map((message) => message.id), [
      'pending-1',
      'pending-2',
      'pending-3',
    ]);

    const switchedInbox = await worker.evaluate(async () => {
      const previousBinding = messageInboxAuthBinding();
      const originalFetch = globalThis.fetch;
      const waitFor = (promise, label) => Promise.race([
        promise,
        new Promise((_, reject) => setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), 5_000)),
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

      licenseActive = true;
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
      const heartbeatDeadline = Date.now() + 5_000;
      while (heartbeatInFlight && Date.now() < heartbeatDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (heartbeatInFlight) throw new Error('Student B reconciliation heartbeat did not finish');
      globalThis.fetch = originalFetch;

      // A direct pending-message retry carrying A's captured binding is also
      // rejected after the switch.
      const staleHeartbeat = await persistHeartbeatPendingMessages([
        { id: 'late-student-a', message: 'Must not cross the identity switch' },
      ], previousBinding);
      const newStudentMessage = await persistHeartbeatPendingMessages([
        { id: 'pending-1', message: 'Same id, new authenticated student' },
      ]);
      const afterSwitch = await chrome.storage.local.get([
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
      const afterSignOut = await chrome.storage.local.get([
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
        heartbeatFetchCount,
      };
    });
    assert.deepEqual(switchedInbox.queuedStaleWrite.addedMessageIds, []);
    assert.deepEqual(switchedInbox.staleHeartbeat.addedMessageIds, []);
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
    assert.deepEqual(serviceWorkerErrors, []);

    console.log('ClassPilot extension resilience integration test passed.');
    console.log('Verified restart/tab restore, connectivity and screenshot diagnostics, transient-command expiry, pre-expiry completion, best-effort tab failure safety, explicit-null reconciliation, expiry retry, missing/corrupt school-policy preservation, DNR/revision safety, oversized-list failure, auth-bound event outbox isolation, and restart-safe identity-bound teacher-message dedup.');
  } finally {
    await context?.close();
    rmSync(profilePath, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
