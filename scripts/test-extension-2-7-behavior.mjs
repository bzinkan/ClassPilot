import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const extensionPath = String(process.env.CLASSPILOT_EXTENSION_PATH || '').trim()
  ? resolve(process.env.CLASSPILOT_EXTENSION_PATH)
  : resolve(repoRoot, 'extension');
const profilePath = mkdtempSync(join(tmpdir(), 'classpilot-extension-2-7-'));
const AUTH_CONTEXT_RACE_ITERATIONS = 10_000;

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
  if (!executablePath) throw new Error('Chrome/Chromium is required for extension behavior tests');
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

    const result = await worker.evaluate(async ({ raceIterations }) => {
      await Promise.all([
        authStateRestorePromise.catch(() => {}),
        classroomStateRestorePromise.catch(() => {}),
      ]);
      scheduleHeartbeat(null);
      await chrome.alarms.clear(STUDENT_CHAT_FLUSH_ALARM);

      const installIdentity = (suffix) => {
        advanceStudentAuthMutationGeneration();
        CONFIG.serverUrl = 'https://school-pilot.net';
        CONFIG.schoolId = `school-${suffix}`;
        CONFIG.deviceId = `device-${suffix}`;
        CONFIG.activeStudentId = `student-${suffix}`;
        CONFIG.activeStudentSessionId = `student-session-${suffix}`;
        CONFIG.studentToken = `token-${suffix}`;
        CONFIG.studentEmail = `student-${suffix}@example.edu`;
        CONFIG.identitySource = 'integration_test';
        studentAuthInvalidating = false;
        studentAuthCommitPending = false;
        const authContextId = generateAuthContextId();
        activateAuthenticatedContext(authContextId);
        currentFabState = {
          teachingSessionId: `teaching-session-${suffix}`,
          activeSessionIds: [`teaching-session-${suffix}`],
          messagingEnabled: true,
        };
        licenseActive = true;
        trackingState = TRACKING_STATES.ACTIVE;
        return captureAuthenticatedContext(`fixture-${suffix}`);
      };

      const originalFetchWithBackoff = fetchWithBackoff;
      const originalSendHeartbeat = sendHeartbeat;
      const originalKvSet = kv.set;
      const originalCaptureSafetyEvidence = captureSafetyEvidence;
      const originalResolveExactTabRefs = resolveExactTabRefs;
      const originalCloseExactTabTargets = closeExactTabTargets;
      const originalRefreshTabCache = refreshTabCache;
      const transmissions = [];
      try {
        const authA = installIdentity('a');
        adoptNegotiatedProtocolState({
          serverProtocolVersion: 3,
          acceptedCapabilities: ['studentChatIdempotencyV1'],
        }, authA);
        fetchWithBackoff = async (url, init = {}) => {
          transmissions.push({
            url: String(url),
            authorization: init.headers?.Authorization || null,
            body: JSON.parse(String(init.body || '{}')),
          });
          throw new Error('simulated response loss');
        };
        const clientMessageId = '11111111-1111-4111-8111-111111111111';
        const firstSend = await queueAndSendStudentChatMessage({
          clientMessageId,
          message: 'Can you help?',
          messageType: 'question',
          sessionId: 'teaching-session-a',
        });
        const afterResponseLoss = await chrome.storage.local.get([
          STUDENT_CHAT_OUTBOX_KEY,
          STUDENT_CHAT_OUTBOX_BINDING_KEY,
        ]);

        fetchWithBackoff = async (url, init = {}) => {
          const body = JSON.parse(String(init.body || '{}'));
          transmissions.push({
            url: String(url),
            authorization: init.headers?.Authorization || null,
            body,
          });
          return new Response(JSON.stringify({
            clientMessageId: body.clientMessageId,
            messageId: 'server-message-1',
            delivered: true,
            duplicate: true,
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        };
        await flushStudentChatOutbox();
        const afterReceipt = await chrome.storage.local.get(STUDENT_CHAT_OUTBOX_KEY);

        adoptNegotiatedProtocolState({
          serverProtocolVersion: 2,
          acceptedCapabilities: [],
        }, authA);
        fetchWithBackoff = async () => new Response(JSON.stringify({
          messageId: 'legacy-server-message',
        }), { status: 200, headers: { 'content-type': 'application/json' } });
        const legacyChatResult = await queueAndSendStudentChatMessage({
          clientMessageId: '15151515-1515-4515-8515-151515151515',
          message: 'Legacy compatibility',
          sessionId: 'teaching-session-a',
        });
        const afterLegacyChat = await chrome.storage.local.get(STUDENT_CHAT_OUTBOX_KEY);
        adoptNegotiatedProtocolState({
          serverProtocolVersion: 3,
          acceptedCapabilities: ['studentChatIdempotencyV1'],
        }, authA);

        fetchWithBackoff = async () => { throw new Error('offline'); };
        await queueAndSendStudentChatMessage({
          clientMessageId: '22222222-2222-4222-8222-222222222222',
          message: 'Do not replay',
          sessionId: 'teaching-session-a',
        });
        const authB = installIdentity('b');
        let replayCalls = 0;
        fetchWithBackoff = async () => {
          replayCalls += 1;
          return new Response('{}', { status: 500 });
        };
        await flushStudentChatOutbox();
        const afterIdentityChange = await chrome.storage.local.get([
          STUDENT_CHAT_OUTBOX_KEY,
          STUDENT_CHAT_OUTBOX_BINDING_KEY,
        ]);

        adoptNegotiatedProtocolState({
          serverProtocolVersion: 3,
          acceptedCapabilities: [
            'exactBindingAckV2',
            'exactTabCloseV2',
            'screenshotObservationLeaseV1',
            'safetyEvidenceCaptureV1',
            'liveViewIceServersV1',
          ],
        }, authB);
        adoptScreenshotPolicy({ mode: 'lease', observed: true }, authB);
        const malformedLeaseAllowed = ambientScreenshotAllowed(authB);
        screenshotCaptureInFlight = true;
        adoptScreenshotPolicy({
          mode: 'lease',
          observed: true,
          expiresInSeconds: 90,
          serverTime: new Date().toISOString(),
        }, authB);
        const validLeaseAllowed = ambientScreenshotAllowed(authB);
        screenshotCaptureInFlight = false;

        let ambientUpload = null;
        fetchWithBackoff = async (url, init = {}) => {
          ambientUpload = {
            url: String(url),
            body: JSON.parse(String(init.body || '{}')),
          };
          return new Response('{}', { status: 200 });
        };
        lastScreenshotAttemptAt = 0;
        await captureAndSendScreenshot({
          reason: 'lease-fixture',
          queryActiveTab: async () => [{
            id: 7000,
            active: true,
            windowId: 1,
            url: 'https://observed.example/page',
            title: 'Observed fixture',
            favIconUrl: '',
          }],
          captureVisibleTab: async () => 'data:image/jpeg;base64,b2JzZXJ2ZWQ=',
        });

        let safetyUpload = null;
        fetchWithBackoff = async (url, init = {}) => {
          safetyUpload = {
            url: String(url),
            body: JSON.parse(String(init.body || '{}')),
          };
          return new Response('{}', { status: 200 });
        };
        const safetyResult = await captureSafetyEvidence({
          requestId: 'evidence-request-1',
          tabRef: 'tab_exact_1',
          snapshotRevision: 7,
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
        }, {
          revision: 7,
          targets: [{ tabRef: 'tab_exact_1', tabId: 7001 }],
        }, authB, {
          resolveExactTargets: async () => ({
            revision: 7,
            targets: [{
              tabRef: 'tab_exact_1',
              tabId: 7001,
              expectedUrl: 'https://unsafe.example/path?private=value',
              expectedTitle: 'Safety fixture',
            }],
          }),
          getTab: async () => ({
            id: 7001,
            active: true,
            windowId: 1,
            url: 'https://unsafe.example/path?private=value',
            title: 'Safety fixture',
            favIconUrl: '',
          }),
          captureVisibleTab: async () => 'data:image/jpeg;base64,c2FmZXR5',
        });

        let safetyRaceUploads = 0;
        let safetyRevalidations = 0;
        let releaseSafetyCapture;
        let safetyCaptureStarted;
        const safetyCaptureGate = new Promise((resolveGate) => {
          releaseSafetyCapture = resolveGate;
        });
        const safetyCaptureReady = new Promise((resolveReady) => {
          safetyCaptureStarted = resolveReady;
        });
        fetchWithBackoff = async () => {
          safetyRaceUploads += 1;
          return new Response('{}', { status: 200 });
        };
        const safetyRacePromise = captureSafetyEvidence({
          requestId: 'evidence-request-race',
          tabRef: 'tab_exact_race',
          snapshotRevision: 9,
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
        }, {
          revision: 9,
          targets: [{ tabRef: 'tab_exact_race', tabId: 7002 }],
        }, authB, {
          resolveExactTargets: async () => {
            safetyRevalidations += 1;
            if (safetyRevalidations > 1) {
              const error = new Error('tab navigated during capture');
              error.code = 'STALE_TAB_SNAPSHOT';
              throw error;
            }
            return {
              revision: 9,
              targets: [{
                tabRef: 'tab_exact_race',
                tabId: 7002,
                expectedUrl: 'https://unsafe.example/race',
                expectedTitle: 'Safety race',
              }],
            };
          },
          getTab: async () => ({
            id: 7002,
            active: true,
            windowId: 1,
            url: 'https://unsafe.example/race',
            title: 'Safety race',
          }),
          captureVisibleTab: async () => {
            safetyCaptureStarted();
            await safetyCaptureGate;
            return 'data:image/jpeg;base64,c3RhbGU=';
          },
        });
        await safetyCaptureReady;
        releaseSafetyCapture();
        const safetyRaceResult = await safetyRacePromise;

        trackingState = TRACKING_STATES.OFF;
        const offHoursSafetyResult = await captureSafetyEvidence({
          requestId: 'evidence-request-off-hours',
          tabRef: 'tab_exact_1',
          snapshotRevision: 7,
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
        }, {
          revision: 7,
          targets: [{ tabRef: 'tab_exact_1', tabId: 7001 }],
        }, authB);
        trackingState = TRACKING_STATES.ACTIVE;

        let closeRaceCode = null;
        try {
          await closeExactTabTargets({
            revision: 10,
            targets: [{ tabRef: 'tab_exact_close_race', tabId: 7010 }],
          }, authB, {
            resolveExactTargets: async () => ({
              revision: 10,
              targets: [{
                tabRef: 'tab_exact_close_race',
                tabId: 7011,
                expectedUrl: 'https://changed.example/',
                expectedTitle: 'Changed',
              }],
            }),
          });
        } catch (error) {
          closeRaceCode = error?.code || null;
        }
        const safetyCloseOrder = [];
        captureSafetyEvidence = async () => {
          safetyCloseOrder.push('capture-unavailable');
          return { status: 'unavailable', reason: 'timeout' };
        };
        resolveExactTabRefs = async () => ({
          revision: 8,
          targets: [{ tabRef: 'tab_exact_close', tabId: 8001 }],
        });
        closeExactTabTargets = async () => {
          safetyCloseOrder.push('close');
        };
        refreshTabCache = async () => {};
        const safetyCloseResult = await executeRemoteControlCommand({
          type: 'close-tab',
          data: {
            tabRef: 'tab_exact_close',
            snapshotRevision: 8,
            safetyEvidenceRequest: {
              requestId: 'evidence-request-close',
              tabRef: 'tab_exact_close',
              snapshotRevision: 8,
              expiresAt: new Date(Date.now() + 30_000).toISOString(),
            },
          },
        }, { authContext: authB });
        captureSafetyEvidence = originalCaptureSafetyEvidence;
        resolveExactTabRefs = originalResolveExactTabRefs;
        closeExactTabTargets = originalCloseExactTabTargets;
        refreshTabCache = originalRefreshTabCache;

        fetchWithBackoff = async (url, init = {}) => {
          if (!String(url).endsWith('/api/classpilot/device/live-view/ice-servers')) {
            throw new Error('unexpected ICE endpoint');
          }
          const requestBody = JSON.parse(String(init.body || '{}'));
          return new Response(JSON.stringify({
            negotiationId: requestBody.negotiationId,
            expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
            iceServers: [
              { urls: 'turns:turn-a.example:443', username: 'opaque', credential: 'secret' },
              { urls: 'turn:turn-b.example:3478?transport=tcp', username: 'opaque', credential: 'secret' },
            ],
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        };
        const iceConfiguration = await fetchLiveViewIceConfiguration('negotiation-1', authB);

        await chrome.storage.local.remove(TAB_SNAPSHOT_STORAGE_KEY);
        const rawTabs = [{
          id: 8101,
          url: 'https://snapshot.example/page',
          title: 'Snapshot',
        }];
        await buildOpaqueTabSnapshot(rawTabs, authB);
        let snapshotWrites = 0;
        kv.set = async (value) => {
          if (Object.prototype.hasOwnProperty.call(value, TAB_SNAPSHOT_STORAGE_KEY)) snapshotWrites += 1;
          return originalKvSet(value);
        };
        await buildOpaqueTabSnapshot(rawTabs, authB);
        kv.set = originalKvSet;

        let heartbeatCalls = 0;
        let releaseHeartbeat;
        let heartbeatStarted;
        const started = new Promise((resolve) => { heartbeatStarted = resolve; });
        const gate = new Promise((resolve) => { releaseHeartbeat = resolve; });
        sendHeartbeat = async () => {
          heartbeatCalls += 1;
          heartbeatStarted();
          await gate;
        };
        heartbeatInFlight = false;
        const firstHeartbeat = safeSendHeartbeat('fixture-first');
        await started;
        await safeSendHeartbeat('fixture-overlap');
        releaseHeartbeat();
        await firstHeartbeat;

        heartbeatCalls = 0;
        lastHeartbeatDispatchAt = 0;
        sendHeartbeat = async () => {
          heartbeatCalls += 1;
        };
        let healthyRecoveryRuns = 0;
        for (let minuteSlot = 0; minuteSlot < 6; minuteSlot += 1) {
          await safeSendHeartbeat(`interval-${minuteSlot}`);
          if (await handleHeartbeatRecoveryAlarm(lastHeartbeatDispatchAt + 1000)) {
            healthyRecoveryRuns += 1;
          }
        }
        const steadyCadenceCalls = heartbeatCalls;
        lastHeartbeatDispatchAt = Date.now() - HEARTBEAT_RECOVERY_STALE_MS - 1;
        const staleRecoveryRan = await handleHeartbeatRecoveryAlarm();
        const cadenceCallsWithRecovery = heartbeatCalls;
        sendHeartbeat = originalSendHeartbeat;

        let liveViewTelemetryRequest = null;
        fetchWithBackoff = async (url, init = {}) => {
          liveViewTelemetryRequest = {
            url: String(url),
            body: JSON.parse(String(init.body || '{}')),
            hasAuthorization: Boolean(init.headers?.Authorization),
          };
          return new Response(null, { status: 204 });
        };
        activeLiveViewNegotiationId = 'telemetry-negotiation';
        activeLiveViewTeachingSessionId = 'teaching-session-b';
        activeLiveViewContext = liveViewContextFor(
          authB,
          activeLiveViewNegotiationId,
          activeLiveViewTeachingSessionId,
        );
        liveViewTelemetryAttempts = new Set();
        const telemetryIdentity = liveViewOffscreenIdentity();
        await handleOffscreenMessage({
          type: 'LIVE_VIEW_ATTEMPT_TERMINAL',
          ...telemetryIdentity,
          attempt: 1,
          outcome: 'connected',
          connectionTimeMs: 1234,
          selectedCandidateType: 'relay',
          relayTransport: 'tls',
        });
        await handleOffscreenMessage({
          type: 'LIVE_VIEW_ATTEMPT_TERMINAL',
          ...telemetryIdentity,
          attempt: 1,
          outcome: 'failed',
          connectionTimeMs: 1500,
          selectedCandidateType: 'relay',
          relayTransport: 'tcp',
        });

        currentFabState = {
          ...(currentFabState || {}),
          ownershipRevision: 41,
          ownershipRevisionKnown: true,
        };
        const exactBinding = {
          bindingVersion: 2,
          schoolId: authB.schoolId,
          deviceId: authB.deviceId,
          studentId: authB.studentId,
          studentSessionId: authB.studentSessionId,
          studentControlRevision: 41,
        };
        await sendCommandAck('negative-receipt-command', 'completed', {
          authContext: authB,
          binding: exactStudentBinding(exactBinding),
          commandType: 'open-tab',
          outcome: 'applied',
        });
        const ackId = 'negative-receipt-command:completed';
        await handleWsMessage(JSON.stringify({
          type: 'command-ack-receipt',
          ackId,
          commandId: 'negative-receipt-command',
          accepted: false,
          exactBinding,
        }), wsConnectionGeneration, authB);
        const afterNegativeReceipt = await chrome.storage.local.get(COMMAND_ACK_OUTBOX_KEY);
        await handleWsMessage(JSON.stringify({
          type: 'command-ack-receipt',
          ackId,
          commandId: 'negative-receipt-command',
          accepted: true,
          exactBinding: { ...exactBinding, deviceId: 'wrong-device' },
        }), wsConnectionGeneration, authB);
        const afterWrongReceipt = await chrome.storage.local.get(COMMAND_ACK_OUTBOX_KEY);
        await handleWsMessage(JSON.stringify({
          type: 'command-ack-receipt',
          ackId,
          commandId: 'negative-receipt-command',
          accepted: true,
          exactBinding,
        }), wsConnectionGeneration, authB);
        const afterPositiveReceipt = await chrome.storage.local.get(COMMAND_ACK_OUTBOX_KEY);

        const sharedMessageId = 'binding-before-dedup-message';
        const expiredCommand = {
          commandId: 'binding-before-dedup-command',
          type: 'open-tab',
          deliveryPolicy: 'transient_action',
          expiresAt: new Date(Date.now() - 1000).toISOString(),
          data: { url: 'https://never-open.example/' },
        };
        await handleWsMessage(JSON.stringify({
          type: 'remote-control',
          _msgId: sharedMessageId,
          command: expiredCommand,
          exactBinding: { ...exactBinding, studentId: 'stale-student' },
        }), wsConnectionGeneration, authB);
        const staleFramePoisonedDedup = recentMsgIds.has(sharedMessageId);
        await handleWsMessage(JSON.stringify({
          type: 'remote-control',
          _msgId: sharedMessageId,
          command: expiredCommand,
          exactBinding,
        }), wsConnectionGeneration, authB);
        const validFrameReachedDedup = recentMsgIds.has(sharedMessageId);
        const afterValidBoundFrame = await chrome.storage.local.get(COMMAND_ACK_OUTBOX_KEY);

        let releaseOpenTab;
        let openTabStarted;
        const openTabGate = new Promise((resolveGate) => { releaseOpenTab = resolveGate; });
        const openTabReady = new Promise((resolveReady) => { openTabStarted = resolveReady; });
        let staleOpenedTabRemoved = false;
        let staleOpenQueriedTabs = false;
        const staleOpenPromise = executeRemoteControlCommand({
          type: 'open-tab',
          data: { url: 'https://stale-open.example/' },
        }, {
          authContext: authB,
          binding: exactStudentBinding(exactBinding),
          createTab: async () => {
            openTabStarted();
            await openTabGate;
            return { id: 9191 };
          },
          queryTabs: async () => {
            staleOpenQueriedTabs = true;
            return [];
          },
          removeTab: async (tabId) => {
            staleOpenedTabRemoved = tabId === 9191;
          },
        });
        await openTabReady;
        installIdentity('open-race-b');
        releaseOpenTab();
        const staleOpenOutcome = await staleOpenPromise.then(
          () => 'completed',
          (error) => error?.code || 'error',
        );

        const raceStorageKey = '__classpilotAuthContextRaceProbe';
        await chrome.storage.local.remove(raceStorageKey);
        const raceStartedAt = performance.now();
        let raceTransmissionCount = 0;
        let racePersistenceCount = 0;
        let raceSupersededOperations = 0;
        let raceUnexpectedCompletions = 0;
        const raceTransmissionSamples = [];
        const racePersistenceSamples = [];
        const fetchBeforeRace = fetchWithBackoff;
        const kvSetBeforeRace = kv.set;
        try {
          fetchWithBackoff = async (url, init = {}, retryOptions) => {
            if (String(url).endsWith('/__auth-context-race-probe')) {
              raceTransmissionCount += 1;
              if (raceTransmissionSamples.length < 3) {
                raceTransmissionSamples.push({
                  authorization: init.headers?.Authorization || null,
                  body: JSON.parse(String(init.body || '{}')),
                  currentStudentId: CONFIG.activeStudentId,
                  currentStudentSessionId: CONFIG.activeStudentSessionId,
                });
              }
              return new Response(null, { status: 204 });
            }
            return fetchBeforeRace(url, init, retryOptions);
          };
          kv.set = async (value) => {
            if (Object.prototype.hasOwnProperty.call(value, raceStorageKey)) {
              racePersistenceCount += 1;
              if (racePersistenceSamples.length < 3) {
                racePersistenceSamples.push({
                  value: value[raceStorageKey],
                  currentStudentId: CONFIG.activeStudentId,
                  currentStudentSessionId: CONFIG.activeStudentSessionId,
                });
              }
              return;
            }
            return kvSetBeforeRace(value);
          };

          for (let iteration = 0; iteration < raceIterations; iteration += 1) {
            const authA = installIdentity(`race-a-${iteration}`);
            const payloadA = Object.freeze({
              iteration,
              schoolId: authA.schoolId,
              deviceId: authA.deviceId,
              studentId: authA.studentId,
              studentSessionId: authA.studentSessionId,
              studentEmail: authA.studentEmail,
              marker: `payload-a-${iteration}`,
            });
            let releaseAwaitBoundary;
            const awaitBoundary = new Promise((resolveBoundary) => {
              releaseAwaitBoundary = resolveBoundary;
            });

            const pendingTransmission = (async () => {
              await awaitBoundary;
              assertAuthenticatedContextCurrent(
                authA,
                `release-race:${iteration}:transmission`,
              );
              // Deliberately acquire the credentials that are current after the
              // await. Without the A-context fence above this would reproduce
              // the dangerous A-payload/B-credential mix the release gate bans.
              const currentContext = captureAuthenticatedContext(
                `release-race:${iteration}:current-transmission`,
              );
              await fetchWithBackoff(`${currentContext.serverOrigin}/__auth-context-race-probe`, {
                method: 'POST',
                headers: buildDeviceAuthHeaders(currentContext),
                body: JSON.stringify(payloadA),
              });
            })();

            const pendingPersistence = (async () => {
              await awaitBoundary;
              assertAuthenticatedContextCurrent(
                authA,
                `release-race:${iteration}:persistence`,
              );
              await kv.set({
                [raceStorageKey]: {
                  payload: payloadA,
                  bindingAtWrite: {
                    studentId: CONFIG.activeStudentId,
                    studentSessionId: CONFIG.activeStudentSessionId,
                  },
                },
              });
            })();

            const authB = installIdentity(`race-b-${iteration}`);
            if (!authA.signal.aborted) {
              throw new Error(`Race iteration ${iteration} did not abort context A`);
            }
            releaseAwaitBoundary();

            const outcomes = await Promise.allSettled([
              pendingTransmission,
              pendingPersistence,
            ]);
            for (const outcome of outcomes) {
              if (outcome.status === 'fulfilled') {
                raceUnexpectedCompletions += 1;
              } else if (isAuthContextCancellation(outcome.reason)) {
                raceSupersededOperations += 1;
              } else {
                throw outcome.reason;
              }
            }
            assertAuthenticatedContextCurrent(authB, `release-race:${iteration}:context-b`);
          }
        } finally {
          fetchWithBackoff = fetchBeforeRace;
          kv.set = kvSetBeforeRace;
        }
        const persistedRaceProbe = await chrome.storage.local.get(raceStorageKey);
        const authContextRace = {
          iterations: raceIterations,
          supersededOperations: raceSupersededOperations,
          unexpectedCompletions: raceUnexpectedCompletions,
          transmissionCount: raceTransmissionCount,
          persistenceCount: racePersistenceCount,
          transmissionSamples: raceTransmissionSamples,
          persistenceSamples: racePersistenceSamples,
          persistedValue: persistedRaceProbe[raceStorageKey],
          elapsedMs: performance.now() - raceStartedAt,
        };

        advanceStudentAuthMutationGeneration();
        CONFIG.studentToken = null;
        CONFIG.activeStudentId = null;
        CONFIG.activeStudentSessionId = null;
        CONFIG.authContextId = null;
        CONFIG.serverUrl = 'https://school-pilot.net';
        CONFIG.enrollmentKey = 'fixture-enrollment-key';
        sharedSignInLoginConfig = {
          ...sharedSignInLoginConfig,
          phase: 'ready',
          schoolId: 'school-kiosk',
          passpilotKioskAvailable: true,
        };
        let kioskRequest = null;
        const kioskUrl = await requestKioskLaunchUrl({
          directoryDeviceId: 'raw-directory-device-id-must-not-leak',
          fetchImpl: async (url, init = {}) => {
            kioskRequest = {
              url: String(url),
              headers: { ...init.headers },
              body: JSON.parse(String(init.body || '{}')),
            };
            return new Response(JSON.stringify({
              ticket: 'one-use-ticket',
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
              acceptedCapabilities: ['kioskLaunchTicketV1'],
            }), { status: 201, headers: { 'content-type': 'application/json' } });
          },
        });

        return {
          firstSend,
          afterResponseLoss,
          afterReceipt,
          legacyChatResult,
          afterLegacyChat,
          transmissions,
          replayCalls,
          afterIdentityChange,
          malformedLeaseAllowed,
          validLeaseAllowed,
          ambientUpload,
          safetyResult,
          safetyUpload,
          safetyRaceResult,
          safetyRaceUploads,
          offHoursSafetyResult,
          closeRaceCode,
          safetyCloseOrder,
          safetyCloseResult,
          iceConfiguration,
          snapshotWrites,
          heartbeatCalls,
          healthyRecoveryRuns,
          steadyCadenceCalls,
          staleRecoveryRan,
          cadenceCallsWithRecovery,
          liveViewTelemetryRequest,
          afterNegativeReceipt,
          afterWrongReceipt,
          afterPositiveReceipt,
          staleFramePoisonedDedup,
          validFrameReachedDedup,
          afterValidBoundFrame,
          staleOpenOutcome,
          staleOpenedTabRemoved,
          staleOpenQueriedTabs,
          authContextRace,
          kioskUrl,
          kioskRequest,
        };
      } finally {
        fetchWithBackoff = originalFetchWithBackoff;
        sendHeartbeat = originalSendHeartbeat;
        kv.set = originalKvSet;
        captureSafetyEvidence = originalCaptureSafetyEvidence;
        resolveExactTabRefs = originalResolveExactTabRefs;
        closeExactTabTargets = originalCloseExactTabTargets;
        refreshTabCache = originalRefreshTabCache;
        heartbeatInFlight = false;
        scheduleHeartbeat(null);
      }
    }, { raceIterations: AUTH_CONTEXT_RACE_ITERATIONS });

    assert.equal(result.firstSend.success, true);
    assert.equal(result.firstSend.queued, true);
    assert.equal(result.afterResponseLoss.studentChatOutboxV1.length, 1);
    assert.equal(result.afterResponseLoss.studentChatOutboxV1[0].clientMessageId,
      '11111111-1111-4111-8111-111111111111');
    assert.equal(result.afterReceipt.studentChatOutboxV1.length, 0);
    assert.equal(result.legacyChatResult.success, true);
    assert.equal(result.legacyChatResult.legacy, true);
    assert.equal(result.legacyChatResult.queued, false);
    assert.equal(result.afterLegacyChat.studentChatOutboxV1.length, 0);
    assert.equal(result.transmissions[0].body.clientMessageId, result.transmissions[1].body.clientMessageId);
    assert.equal(result.replayCalls, 0);
    assert.deepEqual(result.afterIdentityChange.studentChatOutboxV1, []);
    assert.equal(result.afterIdentityChange.studentChatOutboxAuthBindingV1, undefined);
    assert.equal(result.malformedLeaseAllowed, false);
    assert.equal(result.validLeaseAllowed, true);
    assert.equal(result.ambientUpload.url.endsWith('/api/classpilot/device/screenshot'), true);
    assert.equal(result.ambientUpload.body.clientProtocolVersion, 3);
    assert.equal(result.safetyResult.status, 'available');
    assert.equal(result.safetyUpload.url.endsWith('/api/classpilot/device/screenshot'), true);
    assert.equal(result.safetyUpload.body.captureKind, 'safety_evidence');
    assert.equal(result.safetyUpload.body.clientProtocolVersion, 3);
    assert.equal(result.safetyUpload.body.tabRef, 'tab_exact_1');
    assert.equal(result.safetyRaceResult.status, 'unavailable');
    assert.equal(result.safetyRaceResult.reason, 'stale_tab_snapshot');
    assert.equal(result.safetyRaceUploads, 0);
    assert.equal(result.offHoursSafetyResult.status, 'unavailable');
    assert.equal(result.offHoursSafetyResult.reason, 'monitoring_inactive');
    assert.equal(result.closeRaceCode, 'STALE_TAB_SNAPSHOT');
    assert.deepEqual(result.safetyCloseOrder, ['capture-unavailable', 'close']);
    assert.equal(result.safetyCloseResult.safetyEvidence.status, 'unavailable');
    assert.equal(result.safetyCloseResult.closedCount, 1);
    assert.equal(result.iceConfiguration.iceServers.length, 2);
    assert.equal(result.snapshotWrites, 0);
    assert.equal(result.healthyRecoveryRuns, 0);
    assert.equal(result.steadyCadenceCalls, 6);
    assert.equal(result.staleRecoveryRan, true);
    assert.equal(result.cadenceCallsWithRecovery, 7);
    assert.equal(result.heartbeatCalls, 7);
    assert.equal(
      result.liveViewTelemetryRequest.url.endsWith('/api/classpilot/device/live-view/telemetry'),
      true,
    );
    assert.equal(result.liveViewTelemetryRequest.hasAuthorization, true);
    assert.deepEqual(result.liveViewTelemetryRequest.body, {
      negotiationId: 'telemetry-negotiation',
      attempt: 1,
      outcome: 'connected',
      connectionTimeMs: 1234,
      selectedCandidateType: 'relay',
      relayTransport: 'tls',
    });
    assert.ok(result.afterNegativeReceipt.commandAckOutboxV1.some((ack) =>
      ack.ackId === 'negative-receipt-command:completed'));
    assert.ok(result.afterWrongReceipt.commandAckOutboxV1.some((ack) =>
      ack.ackId === 'negative-receipt-command:completed'));
    assert.equal(result.afterPositiveReceipt.commandAckOutboxV1.some((ack) =>
      ack.ackId === 'negative-receipt-command:completed'), false);
    assert.equal(result.staleFramePoisonedDedup, false);
    assert.equal(result.validFrameReachedDedup, true);
    assert.ok(result.afterValidBoundFrame.commandAckOutboxV1.some((ack) =>
      ack.commandId === 'binding-before-dedup-command' && ack.ackState === 'expired'));
    assert.equal(result.staleOpenOutcome, 'AUTH_CONTEXT_SUPERSEDED');
    assert.equal(result.staleOpenedTabRemoved, true);
    assert.equal(result.staleOpenQueriedTabs, false);
    assert.equal(result.authContextRace.iterations, AUTH_CONTEXT_RACE_ITERATIONS);
    assert.equal(
      result.authContextRace.supersededOperations,
      AUTH_CONTEXT_RACE_ITERATIONS * 2,
    );
    assert.equal(result.authContextRace.unexpectedCompletions, 0);
    assert.equal(result.authContextRace.transmissionCount, 0);
    assert.equal(result.authContextRace.persistenceCount, 0);
    assert.deepEqual(result.authContextRace.transmissionSamples, []);
    assert.deepEqual(result.authContextRace.persistenceSamples, []);
    assert.equal(result.authContextRace.persistedValue, undefined);
    assert.ok(
      result.authContextRace.elapsedMs < 20_000,
      `10,000 auth-context race iterations took ${result.authContextRace.elapsedMs.toFixed(0)} ms`,
    );
    assert.equal(new URL(result.kioskUrl).searchParams.has('device'), false);
    assert.equal(new URL(result.kioskUrl).hash, '#launchTicket=one-use-ticket');
    assert.equal(result.kioskUrl.includes('raw-directory-device-id-must-not-leak'), false);
    assert.deepEqual(result.kioskRequest.body, {
      directoryDeviceId: 'raw-directory-device-id-must-not-leak',
      clientProtocolVersion: 3,
      capabilities: ['kioskLaunchTicketV1'],
    });
    assert.equal(result.kioskRequest.headers['X-School-Id'], 'school-kiosk');

    console.log(
      `ClassPilot 2.7 capability behavior test passed; ${AUTH_CONTEXT_RACE_ITERATIONS.toLocaleString()} `
      + `forced A→B races completed in ${result.authContextRace.elapsedMs.toFixed(0)} ms.`,
    );
  } finally {
    if (context) await context.close();
    rmSync(profilePath, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
