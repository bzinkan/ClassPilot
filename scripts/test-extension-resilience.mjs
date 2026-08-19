import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
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

  let context;
  let navigationFixtureServer;
  const serviceWorkerErrors = [];
  try {
    const fixture = await startNavigationFixtureServer();
    navigationFixtureServer = fixture.server;
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
      CONFIG.activeStudentSessionId = 'diagnostic-student-session';
      CONFIG.studentToken = 'diagnostic-token';
      await chrome.storage.local.set({
        deviceId: CONFIG.deviceId,
        activeStudentId: CONFIG.activeStudentId,
        activeStudentSessionId: CONFIG.activeStudentSessionId,
        studentToken: CONFIG.studentToken,
      });
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
    await worker.evaluate(async () => {
      const stored = await chrome.storage.local.get([
        'deviceId',
        'activeStudentId',
        'activeStudentSessionId',
        'studentToken',
      ]);
      CONFIG.deviceId = stored.deviceId;
      CONFIG.activeStudentId = stored.activeStudentId;
      CONFIG.activeStudentSessionId = stored.activeStudentSessionId;
      CONFIG.studentToken = stored.studentToken;
    });

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
          studentId: CONFIG.activeStudentId,
          studentSessionId: CONFIG.activeStudentSessionId,
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
      const originalExecute = executeRemoteControlCommand;
      const originalEnqueueMonitoringEvent = enqueueMonitoringEvent;
      const executions = [];
      CONFIG.schoolId = null;
      await adoptAuthenticatedStudentBinding({
        schoolId: 'authority-school',
        studentId: CONFIG.activeStudentId,
        studentSessionId: CONFIG.activeStudentSessionId,
      }, 'school-policy-bootstrap-fixture');
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
      const originalStoredState = await chrome.storage.local.get(stateKeys);
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
        await chrome.storage.local.remove(stateKeys);
        if (Object.keys(originalStoredState).length > 0) {
          await chrome.storage.local.set(originalStoredState);
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
      CONFIG.deviceId = 'protocol-device';
      CONFIG.activeStudentId = 'protocol-student';
      CONFIG.activeStudentSessionId = 'protocol-student-session';
      CONFIG.studentToken = 'protocol-token';
      CONFIG.schoolId = 'protocol-school';
      trackingState = TRACKING_STATES.OFF;

      await discardCommandAckOutbox();
      wsConnected = false;
      await sendCommandAck('durable-ack-command', 'received', {
        commandType: 'open-tab',
        deliveryPolicy: 'transient_action',
      });
      const queuedAcks = (await chrome.storage.local.get(COMMAND_ACK_OUTBOX_KEY))
        [COMMAND_ACK_OUTBOX_KEY] || [];
      await handleWsMessage(JSON.stringify({
        type: 'command-ack-receipt',
        ackId: 'durable-ack-command:received',
        commandId: 'durable-ack-command',
        accepted: true,
      }));
      const remainingAcks = (await chrome.storage.local.get(COMMAND_ACK_OUTBOX_KEY))
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
      await sendChatDeliveryAck({
        chatMessageId: 'chat-http-message',
        sessionId: 'fab-session-a',
      }, 'delivered');
      await flushChatAckOutbox({ forceHttp: true });
      globalThis.fetch = originalFetch;
      const afterHttpFallback = (await chrome.storage.local.get(COMMAND_ACK_OUTBOX_KEY))
        [COMMAND_ACK_OUTBOX_KEY] || [];
      await sendChatDeliveryAck({ chatMessageId: 'chat-ws-message' }, 'delivered');
      const queuedChatAcks = (await chrome.storage.local.get(CHAT_ACK_OUTBOX_KEY))
        [CHAT_ACK_OUTBOX_KEY] || [];
      await handleWsMessage(JSON.stringify({
        type: 'chat-message-ack-receipt',
        ackId: 'chat:chat-ws-message:delivered',
        messageId: 'chat-ws-message',
        accepted: true,
      }));
      const remainingChatAcks = (await chrome.storage.local.get(CHAT_ACK_OUTBOX_KEY))
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
      await chrome.tabs.remove([second.id, extra.id]).catch(() => {});
      restoreClassroomRuntimeBackup(classroomRuntimeBeforeTabTest);
      await composeDynamicRules(['classroom']);

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
      await chrome.storage.local.set({
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
      const directFabState = (await chrome.storage.local.get(FAB_STATE_STORAGE_KEY))
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
      const sameSessionChat = (await chrome.storage.local.get('fabChatMessages')).fabChatMessages;

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
      const directEndedState = (await chrome.storage.local.get(FAB_STATE_STORAGE_KEY))
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
      const replaced = await chrome.storage.local.get(['fabChatMessages', 'fabChatClosed']);
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
      const afterDelayedFabState = (await chrome.storage.local.get(FAB_STATE_STORAGE_KEY))
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
      const afterDelayedCommands = (await chrome.storage.local.get(FAB_STATE_STORAGE_KEY))
        [FAB_STATE_STORAGE_KEY];

      await executeRemoteControlCommand({
        type: 'messaging-toggle',
        data: { enabled: false, revision: 0 },
      });
      const afterSameSessionDelayedLegacyToggle = (
        await chrome.storage.local.get(FAB_STATE_STORAGE_KEY)
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
      const afterConcurrentFabState = (await chrome.storage.local.get(FAB_STATE_STORAGE_KEY))
        [FAB_STATE_STORAGE_KEY];

      await clearFabAndOverlayState('integration-protocol-cleanup', { closeChat: true });
      await chrome.storage.local.remove(TAB_SNAPSHOT_STORAGE_KEY);
      await new Promise((resolve) => setTimeout(resolve, 1_600));
      CONFIG = originalConfig;
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
    assert.equal(protocolResilience.descriptor.clientProtocolVersion, 2);
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
        return webUrls.length === 2 && webUrls.every((url) =>
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
    assert.equal(existingTabReconciliation.afterFlightPath.web.length, 2);
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
        await chrome.storage.local.set({
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
      const before = await chrome.storage.local.get([
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
      CONFIG.identitySource = 'integration_test';
      CONFIG.autoRegistrationPaused = true;
      studentAuthInvalidating = false;
      await chrome.storage.local.set({
        deviceId: CONFIG.deviceId,
        activeStudentId: CONFIG.activeStudentId,
        activeStudentSessionId: CONFIG.activeStudentSessionId,
        studentToken: CONFIG.studentToken,
        identitySource: CONFIG.identitySource,
        autoRegistrationPaused: true,
        registered: true,
        [CLASSROOM_STATE_STUDENT_BINDING_KEY]: CONFIG.activeStudentId,
      });
      await chrome.storage.local.remove(STUDENT_AUTH_INVALIDATING_KEY);
      const application = await applyClassroomState({
        schemaVersion: 1,
        revision: 2,
        teachingSessionId: 'diagnostic-classroom-session',
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
      await chrome.storage.local.set({
        deviceId: CONFIG.deviceId,
        activeStudentId: CONFIG.activeStudentId,
        activeStudentSessionId: CONFIG.activeStudentSessionId,
        studentToken: CONFIG.studentToken,
      });
    });

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
        overlays: await getRestorableClassroomOverlayState(),
        seenPollIds: [...seenPollIds],
      };
    });
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
    assert.equal(exactBindingIsolation.studentIdAfter, 'diagnostic-student');
    assert.equal(
      exactBindingIsolation.sessionAfterDelayedReplacement,
      'diagnostic-student-session-replacement',
    );

    const wsEventLifetime = await worker.evaluate(async () => {
      const originalHandleRemoteControl = handleRemoteControl;
      const generation = wsConnectionGeneration;
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
        });
        await Promise.resolve();
        const beforeRelease = { firstSettled, order: [...order] };
        releaseFirst();
        await Promise.all([first, second]);
        return { beforeRelease, finalOrder: order };
      } finally {
        handleRemoteControl = originalHandleRemoteControl;
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
        };
      } finally {
        sendCommandAck = originalSendCommandAck;
        currentFabState = originalFabState;
      }
    });
    assert.equal(
      heartbeatRecoveredTeacherMessage.message.message,
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
      const now = Date.now();
      const originalConfig = { ...CONFIG };
      const originalFetchWithBackoff = fetchWithBackoff;
      const originalDisableForInactiveLicense = disableForInactiveLicense;
      const statusDisablePlans = [];
      const statusResponses = [
        { code: 'CLASSPILOT_NOT_ENTITLED', planStatus: 'canonical-status' },
        { error: 'school_not_entitled', planStatus: 'legacy-status' },
        { code: 'SOME_OTHER_FORBIDDEN', planStatus: 'unrelated-status' },
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
      fetchWithBackoff = async () => new Response(JSON.stringify(statusResponses.shift()), {
        status: 403,
        headers: { 'content-type': 'application/json' },
      });
      await checkLicenseStatus('canonical-entitlement-fixture');
      await checkLicenseStatus('legacy-entitlement-fixture');
      await checkLicenseStatus('unrelated-forbidden-fixture');
      disableForInactiveLicense = originalDisableForInactiveLicense;

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
      licenseActive = true;
      trackingState = TRACKING_STATES.ACTIVE;
      persistedMonitoringState = {
        state: TRACKING_STATES.ACTIVE,
        changedAt: now,
        reason: 'entitlement-cleanup-fixture',
      };
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
        disableForInactiveLicense = originalDisableForInactiveLicense;
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
        heartbeatRequestCount,
        heartbeatPreconditions,
      };
    });
    assert.deepEqual(entitlementCleanup.statusDisablePlans, [
      'canonical-status',
      'legacy-status',
    ]);
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
    assert.equal(delayedRegistrationAfterClear.stored.activeStudentId, null);
    assert.equal(delayedRegistrationAfterClear.stored.activeStudentSessionId, null);
    assert.equal(delayedRegistrationAfterClear.stored.studentToken, null);
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
    assert.equal(completedAuthClear.activeStudentId, null);
    assert.equal(completedAuthClear.activeStudentSessionId, null);
    assert.equal(completedAuthClear.studentToken, null);
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
