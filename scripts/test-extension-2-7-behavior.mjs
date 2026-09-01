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
const profilePath = mkdtempSync(join(tmpdir(), 'classpilot-extension-2-7-'));
const configuredRaceIterations = Number(process.env.CLASSPILOT_RACE_ITERATIONS || 10_000);
const AUTH_CONTEXT_RACE_ITERATIONS = Number.isSafeInteger(configuredRaceIterations)
  && configuredRaceIterations > 0
  ? configuredRaceIterations
  : 10_000;
const DEBUG_BEHAVIOR_PROGRESS = process.env.CLASSPILOT_BEHAVIOR_DEBUG === '1';

const schoolPilotCommandFrames = JSON.parse(readFileSync(
  resolve(repoRoot, 'scripts/fixtures/schoolpilot-protocol-v3-command-frames.json'),
  'utf8',
));
const schoolPilotGeneratedExactTabFixture = JSON.parse(readFileSync(
  resolve(repoRoot, 'scripts/fixtures/schoolpilot-2.7.1-exact-tab-frame.json'),
  'utf8',
));
const authRevisionRaceFixture = JSON.parse(readFileSync(
  resolve(repoRoot, 'scripts/fixtures/classpilot-auth-revision-race.json'),
  'utf8',
));
const schoolPilotControlRevisionFrames = JSON.parse(readFileSync(
  resolve(repoRoot, 'scripts/fixtures/schoolpilot-2.7.1-control-revision-frames.json'),
  'utf8',
));
const schoolPilotCloseAllFixture = JSON.parse(readFileSync(
  resolve(repoRoot, 'scripts/fixtures/schoolpilot-2.7.1-close-all-frame.json'),
  'utf8',
));

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

async function openContentMessageRaceFixture(context, worker) {
  const contentProgress = (label) => {
    if (DEBUG_BEHAVIOR_PROGRESS) process.stderr.write(`[Content progress] ${label}\n`);
  };
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html><body><main>ClassPilot message race fixture</main></body></html>');
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  const fixtureUrl = `http://127.0.0.1:${address.port}/student`;
  const page = await context.newPage();
  try {
    await page.goto(fixtureUrl, { waitUntil: 'domcontentloaded' });
    contentProgress('page loaded');
    const tabId = await worker.evaluate(async (url) => {
      const tabs = await chrome.tabs.query({});
      return tabs.find((tab) => String(tab.url || '').startsWith(url))?.id || null;
    }, fixtureUrl);
    assert.ok(Number.isInteger(tabId), 'content message race fixture tab was not found');
    contentProgress('tab found');

    const executionResult = async (action) => worker.evaluate(async ({ targetTabId, requestedAction }) => {
      const [outcome] = await chrome.scripting.executeScript({
        target: { tabId: targetTabId },
        world: 'ISOLATED',
        func: (contentAction) => {
          if (contentAction === 'loaded') {
            return Boolean(window.__CLASSPILOT_CONTENT_LOADED__);
          }
          if (contentAction === 'install-interceptor') {
            if (!globalThis.__classPilotOriginalSendMessage) {
              globalThis.__classPilotOriginalSendMessage = chrome.runtime.sendMessage.bind(chrome.runtime);
            }
            globalThis.__classPilotHeldMessageValidations = [];
            const original = globalThis.__classPilotOriginalSendMessage;
            const intercepted = function interceptedRuntimeSendMessage(message, ...args) {
              if (message?.type === 'validate-student-message-context') {
                const callback = args.findLast((value) => typeof value === 'function');
                if (callback) globalThis.__classPilotHeldMessageValidations.push(callback);
                return undefined;
              }
              return original(message, ...args);
            };
            try {
              chrome.runtime.sendMessage = intercepted;
            } catch {
              Object.defineProperty(chrome.runtime, 'sendMessage', {
                configurable: true,
                value: intercepted,
              });
            }
            return chrome.runtime.sendMessage === intercepted;
          }
          if (contentAction === 'held-count') {
            return globalThis.__classPilotHeldMessageValidations?.length || 0;
          }
          if (contentAction === 'release') {
            const callback = globalThis.__classPilotHeldMessageValidations?.shift();
            callback?.({ success: true, current: true });
            return Boolean(callback);
          }
          if (contentAction === 'restore') {
            if (globalThis.__classPilotOriginalSendMessage) {
              chrome.runtime.sendMessage = globalThis.__classPilotOriginalSendMessage;
            }
            delete globalThis.__classPilotHeldMessageValidations;
            delete globalThis.__classPilotOriginalSendMessage;
            return true;
          }
          return null;
        },
        args: [requestedAction],
      });
      return outcome?.result;
    }, { targetTabId: tabId, requestedAction: action });

    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline) {
      const loaded = await executionResult('loaded');
      if (loaded) break;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
    assert.equal(
      await executionResult('loaded'),
      true,
      'content script did not load for message epoch race fixture',
    );
    contentProgress('content loaded');

    const interceptorInstalled = await executionResult('install-interceptor');
    assert.equal(interceptorInstalled, true, 'could not intercept content validation callback');
    contentProgress('interceptor installed');

    const messageContext = {
      authContextId: 'auth-content-race-a',
      schoolId: 'school-content-race-a',
      studentId: 'student-content-race-a',
      studentSessionId: 'session-content-race-a',
    };
    const showMessage = {
      type: 'show-message',
      studentMessageContext: messageContext,
      data: {
        id: 'content-message-race',
        message: 'Private message A',
        fromName: 'Teacher A',
      },
    };
    const waitForHeldValidation = async () => {
      const heldDeadline = Date.now() + 2_000;
      while (Date.now() < heldDeadline) {
        const heldCount = await executionResult('held-count');
        if (heldCount > 0) return;
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
      }
      throw new Error('content validation callback pause was not reached');
    };
    const releaseHeldValidation = () => executionResult('release');

    await worker.evaluate(({ targetTabId, payload }) => {
      globalThis.__classPilotPendingContentDelivery = chrome.tabs.sendMessage(targetTabId, payload);
    }, { targetTabId: tabId, payload: showMessage });
    await waitForHeldValidation();
    contentProgress('first validation held');
    await worker.evaluate((targetTabId) => chrome.tabs.sendMessage(targetTabId, {
      type: 'student-message-state-cleared',
      data: { reason: 'identity-transition' },
    }), tabId);
    assert.equal(await releaseHeldValidation(), true);
    contentProgress('first validation released');
    const clearBeforeCallbackResponse = await worker.evaluate(
      () => globalThis.__classPilotPendingContentDelivery,
    );
    const clearBeforeCallbackModalCount = await page.locator('#classpilot-message-modal').count();
    contentProgress('first ordering complete');

    await worker.evaluate(({ targetTabId, payload }) => {
      globalThis.__classPilotPendingContentDelivery = chrome.tabs.sendMessage(targetTabId, payload);
    }, { targetTabId: tabId, payload: showMessage });
    await waitForHeldValidation();
    contentProgress('second validation held');
    assert.equal(await releaseHeldValidation(), true);
    const callbackBeforeClearResponse = await worker.evaluate(
      () => globalThis.__classPilotPendingContentDelivery,
    );
    const callbackBeforeClearModalCount = await page.locator('#classpilot-message-modal').count();
    await worker.evaluate((targetTabId) => chrome.tabs.sendMessage(targetTabId, {
      type: 'student-message-state-cleared',
      data: { reason: 'identity-transition' },
    }), tabId);
    const callbackBeforeClearFinalModalCount = await page.locator('#classpilot-message-modal').count();
    contentProgress('second ordering complete');

    return {
      clearBeforeCallbackResponse,
      clearBeforeCallbackModalCount,
      callbackBeforeClearResponse,
      callbackBeforeClearModalCount,
      callbackBeforeClearFinalModalCount,
    };
  } finally {
    await page.close();
    server.closeAllConnections?.();
    await new Promise((resolveClose) => server.close(resolveClose));
  }
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
    if (DEBUG_BEHAVIOR_PROGRESS) {
      worker.on('console', (message) => {
        if (message.text().startsWith('[Behavior progress]')) {
          process.stderr.write(`${message.text()}\n`);
        }
      });
    }

    const result = await worker.evaluate(async ({
      raceIterations,
      debugProgress,
      schoolPilotFrames,
      generatedSchoolPilotFixture,
      authRevisionRace,
      controlRevisionFrames,
      generatedCloseAllFixture,
    }) => {
      const progress = (label) => {
        if (debugProgress) console.log(`[Behavior progress] ${label}`);
      };
      const waitForDeterministicPause = async (readyPromise, operationPromise, label) => {
        const outcome = await Promise.race([
          readyPromise.then(() => ({ kind: 'paused' })),
          operationPromise.then(
            (operationResult) => ({ kind: 'completed', result: operationResult }),
            (error) => ({ kind: 'rejected', error }),
          ),
          new Promise((resolveTimeout) => setTimeout(
            () => resolveTimeout({ kind: 'timeout' }),
            5_000,
          )),
        ]);
        if (outcome.kind === 'rejected') throw outcome.error;
        if (outcome.kind !== 'paused') {
          throw new Error(
            `${label} did not reach its deterministic pause (outcome: ${JSON.stringify(outcome)})`,
          );
        }
      };
      await Promise.all([
        authStateRestorePromise.catch(() => {}),
        classroomStateRestorePromise.catch(() => {}),
      ]);
      await studentAuthMutationTail.catch(() => {});
      scheduleHeartbeat(null);
      await chrome.alarms.clear(STUDENT_CHAT_FLUSH_ALARM);

      const runForegroundReconciliationFixture = async ({ failTargetWindow }) => {
        const previousMaxTabs = currentMaxTabs;
        currentMaxTabs = null;
        const tabs = [
          { id: 9101, windowId: 91, active: true, url: 'chrome://dino/' },
          { id: 9201, windowId: 92, active: true, url: 'https://lock.example/in-progress' },
        ];
        let foregroundTabId = 9101;
        let fallbackCreates = 0;
        let targetFocusFailures = 0;
        const focusedWindowIds = [];
        try {
          await reconcileExistingTabsForClassroomState({
            restrictions: {
              screenLock: {
                active: true,
                url: 'https://lock.example/landing',
                domain: 'lock.example',
              },
            },
          }, () => {}, null, null, {
            queryTabs: async (query) => query?.lastFocusedWindow
              ? tabs.filter((tab) => tab.id === foregroundTabId)
              : tabs.map((tab) => ({ ...tab })),
            updateTab: async (tabId, properties) => {
              const target = tabs.find((tab) => tab.id === tabId);
              if (!target) throw new Error('target tab disappeared');
              Object.assign(target, properties);
              return { ...target };
            },
            getTab: async (tabId) => {
              const target = tabs.find((tab) => tab.id === tabId);
              if (!target) throw new Error('target tab disappeared');
              return { ...target };
            },
            removeTab: async (tabId) => {
              const index = tabs.findIndex((tab) => tab.id === tabId);
              if (index >= 0) tabs.splice(index, 1);
            },
            createTab: async ({ url, active }) => {
              fallbackCreates += 1;
              const created = { id: 9300 + fallbackCreates, windowId: 93, active, url };
              tabs.push(created);
              return { ...created };
            },
            focusWindow: async (windowId) => {
              focusedWindowIds.push(windowId);
              if (failTargetWindow && windowId === 92 && targetFocusFailures === 0) {
                targetFocusFailures += 1;
                tabs.splice(tabs.findIndex((tab) => tab.id === 9201), 1);
                throw new Error('target window disappeared');
              }
              const target = tabs.find((tab) => tab.windowId === windowId && tab.active);
              if (!target) throw new Error('focused window has no active tab');
              foregroundTabId = target.id;
            },
            refreshTabs: async () => {},
          });
          return {
            fallbackCreates,
            foregroundTabId,
            focusedWindowIds,
            targetFocusFailures,
          };
        } finally {
          currentMaxTabs = previousMaxTabs;
        }
      };
      const foregroundReconciliation = {
        focused: await runForegroundReconciliationFixture({ failTargetWindow: false }),
        disappeared: await runForegroundReconciliationFixture({ failTargetWindow: true }),
      };

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
        const authContext = captureAuthenticatedContext(`fixture-${suffix}`);
        adoptLicenseState(true, 'active', authContext);
        return authContext;
      };

      const originalFetchWithBackoff = fetchWithBackoff;
      const originalSendHeartbeat = sendHeartbeat;
      const originalKvSet = kv.set;
      const originalCaptureSafetyEvidence = captureSafetyEvidence;
      const originalResolveExactTabRefs = resolveExactTabRefs;
      const originalCloseExactTabTargets = closeExactTabTargets;
      const originalRefreshTabCache = refreshTabCache;
      const originalReadManagedDirectoryDeviceIdWithRetry = readManagedDirectoryDeviceIdWithRetry;
      const originalEnqueueCommandAck = enqueueCommandAck;
      const originalDateNow = Date.now;
      const transmissions = [];
      try {
        const authA = installIdentity('a');
        adoptNegotiatedProtocolState({
          serverProtocolVersion: 3,
          acceptedCapabilities: ['studentChatIdempotencyV1'],
        }, authA);
        const createdTabPolicyBackup = classroomRuntimeBackup();
        const createdTabPolicySchoolMaxTabs = schoolMaxTabs;
        const createdTabReconciliationCalls = [];
        let createdTabPolicyRace = null;
        try {
          screenLocked = true;
          lockedUrl = 'https://ixl.com/landing';
          lockedDomain = 'ixl.com';
          allowedDomains = [];
          teacherMaxTabs = 1;
          schoolMaxTabs = null;
          currentMaxTabs = effectiveTabLimit();
          const createdTabFixture = {
            id: 9503,
            windowId: 95,
            active: true,
            url: 'https://app.ixl.com/new',
          };
          const createdTabFixtureTabs = [
            { id: 9501, windowId: 95, active: false, url: 'chrome://settings/' },
            { id: 9502, windowId: 95, active: false, url: 'https://outside.example/transient' },
            createdTabFixture,
          ];
          await handleCreatedTabForPolicy(createdTabFixture, {
            getTab: async () => ({ ...createdTabFixture }),
            queryTabs: async () => createdTabFixtureTabs.map((tab) => ({ ...tab })),
            reconcileTabs: async (reconciliationState, reconciliationOptions) => {
              reconciliationOptions.assertCurrent('created-tab fixture reconciliation');
              createdTabReconciliationCalls.push({
                authContextId: reconciliationOptions.authContext?.authContextId || null,
                lockedDomain: reconciliationState.restrictions?.screenLock?.domain || null,
                tabLimit: reconciliationState.restrictions?.tabLimit ?? null,
              });
              return true;
            },
          });

          // A delayed onCreated event must serialize behind the classroom
          // reconciliation that can repurpose its tab as the sole Waypoint
          // target. Browser navigation can still occur outside both queues, so
          // exercise the final live-tab revalidation repeatedly as well.
          teacherMaxTabs = null;
          currentMaxTabs = effectiveTabLimit();
          const originalRecordNavigationBlockedForAuth = recordNavigationBlockedForAuth;
          const originalRemoveTabForAuth = removeTabForAuth;
          const originalNotifyNavigationBlockedForAuth = notifyNavigationBlockedForAuth;
          const originalEnforceAuthGateForTab = enforceAuthGateForTab;
          const originalRaceRefreshTabCache = refreshTabCache;
          const raceRemovals = [];
          const raceRecordSources = [];
          let raceRecordCalls = 0;
          try {
            recordNavigationBlockedForAuth = async (_authContext, _url, source) => {
              raceRecordCalls += 1;
              raceRecordSources.push(source);
            };
            removeTabForAuth = async (tabId, authContext) => {
              assertAuthenticatedContextCurrent(authContext, 'created-tab race removal');
              raceRemovals.push(tabId);
            };
            notifyNavigationBlockedForAuth = async () => {};
            refreshTabCache = async (authContext) => {
              assertAuthenticatedContextCurrent(authContext, 'created-tab race cache refresh');
              return true;
            };

            await studentAuthMutationTail;
            let releaseClassroomBlock;
            let classroomBlockStarted;
            const classroomBlockReady = new Promise((resolve) => {
              classroomBlockStarted = resolve;
            });
            const classroomBlockGate = new Promise((resolve) => {
              releaseClassroomBlock = resolve;
            });
            let serializedLiveTab = {
              id: 9510,
              windowId: 95,
              active: true,
              url: 'https://outside.example/before-reconciliation',
            };
            let serializedGetCalls = 0;
            const classroomBlock = enqueueClassroomStateOperation(async () => {
              classroomBlockStarted();
              await classroomBlockGate;
              serializedLiveTab = {
                ...serializedLiveTab,
                url: 'https://ixl.com/landing',
              };
            });
            await classroomBlockReady;
            let handlerReachedAuthQueue;
            const handlerAuthQueueReady = new Promise((resolve) => {
              handlerReachedAuthQueue = resolve;
            });
            enforceAuthGateForTab = async () => {
              handlerReachedAuthQueue();
            };
            const serializedHandler = handleCreatedTabForPolicy({
              id: serializedLiveTab.id,
              windowId: serializedLiveTab.windowId,
              active: true,
              url: 'https://outside.example/stale-created-event',
            }, {
              getTab: async () => {
                serializedGetCalls += 1;
                return { ...serializedLiveTab };
              },
              queryTabs: async () => [{ ...serializedLiveTab }],
            });
            await handlerAuthQueueReady;
            const readsWhileClassroomBlocked = serializedGetCalls;
            releaseClassroomBlock();
            await Promise.all([classroomBlock, serializedHandler]);

            enforceAuthGateForTab = async () => {};
            const revalidationIterations = 100;
            const revalidationReadCounts = [];
            for (let iteration = 0; iteration < revalidationIterations; iteration += 1) {
              const createdId = 9600 + iteration;
              let liveReadCount = 0;
              await handleCreatedTabForPolicy({
                id: createdId,
                windowId: 96,
                active: true,
                url: `https://outside.example/race-${iteration}`,
              }, {
                getTab: async () => {
                  liveReadCount += 1;
                  if (liveReadCount <= 2) {
                    return {
                      id: createdId,
                      windowId: 96,
                      active: true,
                      url: `https://outside.example/race-${iteration}`,
                    };
                  }
                  return iteration % 2 === 0
                    ? {
                        id: createdId,
                        windowId: 96,
                        active: true,
                        url: 'https://ixl.com/landing',
                      }
                    : {
                        id: createdId,
                        windowId: 96,
                        active: true,
                        url: `https://outside.example/race-${iteration}`,
                        pendingUrl: 'https://app.ixl.com/assignment',
                      };
                },
                queryTabs: async () => [],
              });
              revalidationReadCounts.push(liveReadCount);
            }
            const raceRecordCallsBeforeControl = raceRecordCalls;
            const stableControlId = 9799;
            let stableControlReadCount = 0;
            await handleCreatedTabForPolicy({
              id: stableControlId,
              windowId: 97,
              active: true,
              url: 'https://outside.example/stable-control',
            }, {
              getTab: async () => {
                stableControlReadCount += 1;
                return {
                  id: stableControlId,
                  windowId: 97,
                  active: true,
                  url: 'https://outside.example/stable-control',
                };
              },
              queryTabs: async () => [],
            });
            teacherMaxTabs = 1;
            currentMaxTabs = effectiveTabLimit();
            const sourceTransitionId = 9801;
            const sourceTransitionAllowedTab = {
              id: 9800,
              windowId: 98,
              active: false,
              url: 'https://ixl.com/existing',
            };
            const sourceTransitionCompliantTab = {
              id: sourceTransitionId,
              windowId: 98,
              active: true,
              url: 'https://app.ixl.com/new',
            };
            let sourceTransitionReadCount = 0;
            await handleCreatedTabForPolicy({
              ...sourceTransitionCompliantTab,
              url: 'https://outside.example/source-transition',
            }, {
              getTab: async () => {
                sourceTransitionReadCount += 1;
                return sourceTransitionReadCount <= 2
                  ? {
                      ...sourceTransitionCompliantTab,
                      url: 'https://outside.example/source-transition',
                    }
                  : { ...sourceTransitionCompliantTab };
              },
              queryTabs: async () => [
                { ...sourceTransitionAllowedTab },
                { ...sourceTransitionCompliantTab },
              ],
            });
            const runFinalInventoryCase = async ({ id, mode }) => {
              teacherMaxTabs = 1;
              currentMaxTabs = effectiveTabLimit();
              const existing = {
                id: id - 1,
                windowId: 99,
                active: false,
                url: 'https://ixl.com/existing-final-inventory',
              };
              const created = {
                id,
                windowId: 99,
                active: true,
                url: 'https://app.ixl.com/final-inventory',
              };
              let readCount = 0;
              let inventoryCount = 0;
              const removalStart = raceRemovals.length;
              const recordStart = raceRecordSources.length;
              await handleCreatedTabForPolicy(created, {
                getTab: async () => {
                  readCount += 1;
                  return { ...created };
                },
                queryTabs: async () => {
                  inventoryCount += 1;
                  if (inventoryCount === 3 && mode === 'limit-raised') {
                    teacherMaxTabs = 2;
                    currentMaxTabs = effectiveTabLimit();
                  }
                  if (inventoryCount === 3 && mode === 'preserved-disappeared') {
                    return [
                      { id: id - 2, windowId: 99, active: false, url: 'chrome://version/' },
                      { ...created },
                    ];
                  }
                  return [{ ...existing }, { ...created }];
                },
              });
              return {
                readCount,
                inventoryCount,
                removals: raceRemovals.slice(removalStart),
                recordSources: raceRecordSources.slice(recordStart),
              };
            };
            const finalInventoryCases = {
              preservedDisappeared: await runFinalInventoryCase({
                id: 9811,
                mode: 'preserved-disappeared',
              }),
              limitRaised: await runFinalInventoryCase({
                id: 9821,
                mode: 'limit-raised',
              }),
              stableOverLimit: await runFinalInventoryCase({
                id: 9831,
                mode: 'stable',
              }),
            };
            const raceExecuteRemoteControlCommand = executeRemoteControlCommand;
            const raceRemoveTabForAuth = removeTabForAuth;
            const raceRecordNavigationBlockedForAuth = recordNavigationBlockedForAuth;
            let schoolPolicyLimitSerialization;
            try {
              teacherMaxTabs = 1;
              schoolMaxTabs = null;
              currentMaxTabs = effectiveTabLimit();
              let liveTabs = [
                { id: 9840, windowId: 98, active: false, url: 'https://ixl.com/preserved' },
                { id: 9841, windowId: 98, active: true, url: 'https://app.ixl.com/new' },
              ];
              const createdRemovalIds = [];
              const schoolCrossRemovalIds = [];
              let releaseCreatedRemoval;
              let createdRemovalStarted;
              const createdRemovalReady = new Promise((resolve) => {
                createdRemovalStarted = resolve;
              });
              const createdRemovalGate = new Promise((resolve) => {
                releaseCreatedRemoval = resolve;
              });
              removeTabForAuth = async (tabId, authContext) => {
                assertAuthenticatedContextCurrent(authContext, 'school limit serialization removal');
                createdRemovalStarted();
                await createdRemovalGate;
                createdRemovalIds.push(tabId);
                liveTabs = liveTabs.filter((candidate) => candidate.id !== tabId);
              };
              recordNavigationBlockedForAuth = async () => {};
              let schoolCommandEntered;
              const schoolCommandEntry = new Promise((resolve) => {
                schoolCommandEntered = resolve;
              });
              executeRemoteControlCommand = async () => {
                schoolCommandEntered();
                if (liveTabs.length > 1) {
                  schoolCrossRemovalIds.push(9840);
                  liveTabs = liveTabs.filter((candidate) => candidate.id !== 9840);
                }
                return { currentMaxTabs: 1 };
              };

              const createdPolicyPromise = handleCreatedTabForPolicy({ ...liveTabs[1] }, {
                getTab: async (tabId) => {
                  const current = liveTabs.find((candidate) => candidate.id === tabId);
                  if (!current) throw new Error('fixture tab disappeared');
                  return { ...current };
                },
                queryTabs: async () => liveTabs.map((candidate) => ({ ...candidate })),
              });
              await createdRemovalReady;
              const schoolPolicyPromise = handleRemoteControl({
                type: 'limit-tabs',
                data: { maxTabs: 1 },
              }, {
                studentId: authA.studentId,
                studentSessionId: authA.studentSessionId,
                authority: {
                  kind: 'school_policy',
                  source: 'school_settings',
                  schoolId: CONFIG.schoolId,
                },
              });
              const schoolEnteredWhileCreatedHeld = await Promise.race([
                schoolCommandEntry.then(() => true),
                new Promise((resolve) => setTimeout(() => resolve(false), 25)),
              ]);
              releaseCreatedRemoval();
              await Promise.all([createdPolicyPromise, schoolPolicyPromise]);
              schoolPolicyLimitSerialization = {
                schoolEnteredWhileCreatedHeld,
                createdRemovalIds,
                schoolCrossRemovalIds,
                finalTabIds: liveTabs.map((candidate) => candidate.id),
              };
            } finally {
              executeRemoteControlCommand = raceExecuteRemoteControlCommand;
              removeTabForAuth = raceRemoveTabForAuth;
              recordNavigationBlockedForAuth = raceRecordNavigationBlockedForAuth;
            }
            createdTabPolicyRace = {
              readsWhileClassroomBlocked,
              serializedGetCalls,
              raceRecordCallsBeforeControl,
              raceRecordCalls,
              raceRecordSources,
              raceRemovals,
              revalidationIterations,
              revalidationReadCounts,
              stableControlId,
              stableControlReadCount,
              sourceTransitionId,
              sourceTransitionReadCount,
              finalInventoryCases,
              schoolPolicyLimitSerialization,
            };
          } finally {
            recordNavigationBlockedForAuth = originalRecordNavigationBlockedForAuth;
            removeTabForAuth = originalRemoveTabForAuth;
            notifyNavigationBlockedForAuth = originalNotifyNavigationBlockedForAuth;
            enforceAuthGateForTab = originalEnforceAuthGateForTab;
            refreshTabCache = originalRaceRefreshTabCache;
          }
        } finally {
          restoreClassroomRuntimeBackup(createdTabPolicyBackup);
          schoolMaxTabs = createdTabPolicySchoolMaxTabs;
          currentMaxTabs = effectiveTabLimit();
        }
        const createdTabLimitReconciliation = {
          expectedAuthContextId: authA.authContextId,
          calls: createdTabReconciliationCalls,
        };
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
        const afterResponseLoss = await kv.get([
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
        const afterReceipt = await kv.get(STUDENT_CHAT_OUTBOX_KEY);

        fetchWithBackoff = async () => { throw new Error('simulated response loss'); };
        const retiredSessionClientMessageId = '16161616-1616-4616-8616-161616161616';
        const retiredSessionInitialSend = await queueAndSendStudentChatMessage({
          clientMessageId: retiredSessionClientMessageId,
          message: 'This must stay in the original class',
          sessionId: 'teaching-session-a',
        });
        currentFabState = {
          ...(currentFabState || {}),
          teachingSessionId: 'teaching-session-a-replacement',
          activeSessionIds: ['teaching-session-a-replacement'],
        };
        let retiredSessionReplayTransmissions = 0;
        fetchWithBackoff = async () => {
          retiredSessionReplayTransmissions += 1;
          return new Response(JSON.stringify({
            delivered: true,
            clientMessageId: retiredSessionClientMessageId,
            messageId: 'wrong-session-message',
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        };
        await flushStudentChatOutbox();
        const afterRetiredSessionFlush = await kv.get(STUDENT_CHAT_OUTBOX_KEY);
        currentFabState = {
          ...(currentFabState || {}),
          teachingSessionId: 'teaching-session-a',
          activeSessionIds: ['teaching-session-a'],
        };

        const chatRetentionBase = Date.now();
        const chatRetentionBinding = monitoringEventAuthBindingForContext(authA);
        await durableLocalKv.set({
          [STUDENT_CHAT_OUTBOX_BINDING_KEY]: chatRetentionBinding,
          [STUDENT_CHAT_OUTBOX_KEY]: [normalizeStudentChatEntry({
            clientMessageId: '17171717-1717-4717-8717-171717171717',
            message: 'Private chat text must be physically removed',
            messageType: 'message',
            sessionId: 'teaching-session-a',
            binding: chatRetentionBinding,
            queuedAt: chatRetentionBase,
            updatedAt: chatRetentionBase,
            status: 'failed',
          })],
        });
        Date.now = () => chatRetentionBase + STUDENT_CHAT_MAX_AGE_MS + 1;
        try {
          await flushStudentChatOutbox();
        } finally {
          Date.now = originalDateNow;
        }
        const afterChatRetentionExpiry = await kv.get([
          STUDENT_CHAT_OUTBOX_KEY,
          STUDENT_CHAT_OUTBOX_BINDING_KEY,
        ]);

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
        const afterLegacyChat = await kv.get(STUDENT_CHAT_OUTBOX_KEY);
        progress('chat complete');
        adoptNegotiatedProtocolState({
          serverProtocolVersion: 3,
          acceptedCapabilities: [
            'scopedAuthorityChecksV1',
            'exactBindingAckV2',
            'exactTabCloseV2',
            'studentChatIdempotencyV1',
          ],
        }, authA);

        currentFabState = {
          ...(currentFabState || {}),
          ownershipRevision: 12,
          ownershipRevisionKnown: true,
        };
        observeStudentControlRevision(12, authA, 'generated SchoolPilot fixture revision');
        let generatedSchoolPilotFrameResolve = null;
        let generatedSchoolPilotFrameCloseCount = 0;
        const generatedSchoolPilotFrameAckAttempts = [];
        resolveExactTabRefs = async (refs, revision) => {
          generatedSchoolPilotFrameResolve = { refs: [...refs], revision };
          return {
            revision,
            targets: [{ tabRef: refs[0], tabId: 9401 }],
          };
        };
        closeExactTabTargets = async () => {
          generatedSchoolPilotFrameCloseCount += 1;
        };
        refreshTabCache = async () => {};
        enqueueCommandAck = async (ack, context) => {
          if (ack?.commandId === generatedSchoolPilotFixture.frame.commandId) {
            generatedSchoolPilotFrameAckAttempts.push({
              ackId: ack.ackId,
              ackState: ack.ackState,
              bindingVersion: ack.bindingVersion,
              schoolId: ack.schoolId,
              deviceId: ack.deviceId,
              studentId: ack.studentId,
              studentSessionId: ack.studentSessionId,
              studentControlRevision: ack.studentControlRevision,
            });
          }
          return originalEnqueueCommandAck(ack, context);
        };
        Date.now = () => Date.parse('2026-08-23T15:00:00.000Z');
        try {
          await handleWsMessage(
            JSON.stringify(generatedSchoolPilotFixture.frame),
            wsConnectionGeneration,
            authA,
          );
        } finally {
          Date.now = originalDateNow;
          resolveExactTabRefs = originalResolveExactTabRefs;
          closeExactTabTargets = originalCloseExactTabTargets;
          refreshTabCache = originalRefreshTabCache;
          enqueueCommandAck = originalEnqueueCommandAck;
        }
        const generatedSchoolPilotFrameAcks = await kv.get(
          COMMAND_ACK_OUTBOX_KEY,
        );
        currentFabState = {
          ...(currentFabState || {}),
          ownershipRevision: 13,
          ownershipRevisionKnown: true,
        };
        observeStudentControlRevision(13, authA, 'post-command revision fixture');
        const exactTabAckAfterRevisionChange = await sendCommandAck(
          'exact-tab-applied-before-revision-change',
          'completed',
          {
            authContext: authA,
            binding: generatedSchoolPilotFixture.frame.exactBinding,
            commandType: 'close-tab',
            outcome: 'applied',
          },
        );
        const exactTabAckAfterRevisionChangeOutbox = await kv.get(
          COMMAND_ACK_OUTBOX_KEY,
        );

        await handleWsMessage(
          JSON.stringify(controlRevisionFrames.frames.classroom),
          wsConnectionGeneration,
          authA,
        );
        await handleWsMessage(
          JSON.stringify(controlRevisionFrames.frames.fab),
          wsConnectionGeneration,
          authA,
        );
        const generatedControlRevisionWatermark = currentStudentControlRevision();
        let generatedControlRevisionCloseCount = 0;
        resolveExactTabRefs = async (refs, revision) => ({
          revision,
          targets: [{ tabRef: refs[0], tabId: 9443 }],
        });
        closeExactTabTargets = async () => { generatedControlRevisionCloseCount += 1; };
        refreshTabCache = async () => {};
        const generatedControlBinding = controlRevisionFrames.frames.classroom.exactBinding;
        await handleWsMessage(JSON.stringify({
          type: 'remote-control',
          _msgId: 'generated-control-revision-close-frame',
          commandId: 'generated-control-revision-close',
          studentId: authA.studentId,
          studentSessionId: authA.studentSessionId,
          exactBinding: generatedControlBinding,
          authority: {
            kind: 'teaching_session',
            teachingSessionId: 'teaching-session-a',
          },
          command: {
            commandId: 'generated-control-revision-close',
            type: 'close-tab',
            exactBinding: generatedControlBinding,
            data: { tabRefs: ['generated-control-revision-tab'], tabSnapshotRevision: 42 },
          },
        }), wsConnectionGeneration, authA);
        const generatedControlRevisionAcks = await kv.get(
          COMMAND_ACK_OUTBOX_KEY,
        );
        resolveExactTabRefs = originalResolveExactTabRefs;
        closeExactTabTargets = originalCloseExactTabTargets;
        refreshTabCache = originalRefreshTabCache;
        const closeAllRemovedTabIds = [];
        Date.now = () => Date.parse('2026-08-23T15:00:00.000Z');
        let generatedCloseAllResult;
        try {
          generatedCloseAllResult = await handleRemoteControl(
            generatedCloseAllFixture.frame.command,
            generatedCloseAllFixture.frame,
            {
              queryTabs: async () => [
                { id: 9501, url: 'https://close-one.example/' },
                { id: 9502, url: 'https://close-two.example/' },
                { id: 9503, url: 'chrome://settings/' },
              ],
              removeTab: async (tabId) => { closeAllRemovedTabIds.push(tabId); },
              refreshTabCache: async () => {},
            },
          );
        } finally {
          Date.now = originalDateNow;
        }
        const generatedCloseAllAcks = await kv.get(COMMAND_ACK_OUTBOX_KEY);
        progress('generated command fixtures complete');

        fetchWithBackoff = async () => { throw new Error('offline'); };
        await queueAndSendStudentChatMessage({
          clientMessageId: '22222222-2222-4222-8222-222222222222',
          message: 'Do not replay',
          sessionId: 'teaching-session-a',
        });
        let authB = installIdentity('b');
        const adoptedAuthRevisionRaceBinding = await adoptAuthenticatedStudentBinding(
          authRevisionRace,
          'auth revision race fixture',
          captureAuthenticatedResponseGuard(),
        );
        assertAuthenticatedContextCurrent(authB, 'auth revision race fixture');
        // Model a clean worker/auth handoff. The fixture helper intentionally
        // bypasses the production teardown queue, so retire its prior in-memory
        // classroom snapshot before applying B's authoritative auth response.
        currentClassroomState = null;
        await applyClassroomStateFromAuthResponse(
          authRevisionRace,
          'clean auth ordinary command fixture',
          { requireApplied: true, authContext: authB },
        );
        adoptNegotiatedProtocolState({
          serverProtocolVersion: 3,
          acceptedCapabilities: ['scopedAuthorityChecksV1', 'exactBindingAckV2'],
        }, authB);
        let cleanAuthOrdinaryCommandExecutions = 0;
        const cleanAuthOrdinaryCommandAckAttempts = [];
        enqueueCommandAck = async (ack, context) => {
          if (ack?.commandId === 'clean-auth-ordinary-command') {
            cleanAuthOrdinaryCommandAckAttempts.push({
              ackState: ack.ackState,
              studentControlRevision: ack.studentControlRevision,
            });
          }
          return originalEnqueueCommandAck(ack, context);
        };
        const cleanAuthOrdinaryCommandResult = await handleRemoteControl({
          commandId: 'clean-auth-ordinary-command',
          type: 'open-tab',
          authority: {
            kind: 'teaching_session',
            teachingSessionId: 'teaching-session-b',
          },
          data: { url: 'https://ordinary-command.example/' },
        }, {
          commandId: 'clean-auth-ordinary-command',
          studentId: authB.studentId,
          studentSessionId: authB.studentSessionId,
        }, {
          createTab: async () => {
            cleanAuthOrdinaryCommandExecutions += 1;
            return { id: 9430 };
          },
          queryTabs: async () => [{ id: 9430, url: 'https://ordinary-command.example/' }],
          removeTab: async () => {},
        });
        enqueueCommandAck = originalEnqueueCommandAck;
        const cleanAuthOrdinaryCommandAcks = await kv.get(
          COMMAND_ACK_OUTBOX_KEY,
        );
        await applyClassroomStateFromAuthResponse(
          authRevisionRace,
          'auth revision race fixture',
          { requireApplied: true, authContext: authB },
        );
        const authRevisionRaceWatermark = currentStudentControlRevision();
        adoptNegotiatedProtocolState({
          serverProtocolVersion: 3,
          acceptedCapabilities: [
            'scopedAuthorityChecksV1',
            'exactBindingAckV2',
            'exactTabCloseV2',
          ],
        }, authB);
        let authRevisionRaceCloseCount = 0;
        resolveExactTabRefs = async (refs, revision) => ({
          revision,
          targets: [{ tabRef: refs[0], tabId: 9420 }],
        });
        closeExactTabTargets = async () => {
          authRevisionRaceCloseCount += 1;
        };
        refreshTabCache = async () => {};
        await handleWsMessage(JSON.stringify({
          type: 'remote-control',
          _msgId: 'auth-revision-race-exact-close-frame',
          commandId: 'auth-revision-race-exact-close',
          studentId: authB.studentId,
          studentSessionId: authB.studentSessionId,
          exactBinding: authRevisionRace.exactBinding,
          authority: {
            kind: 'teaching_session',
            teachingSessionId: 'teaching-session-b',
          },
          delivery: {
            policy: 'one_shot',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          },
          command: {
            commandId: 'auth-revision-race-exact-close',
            type: 'close-tab',
            exactBinding: authRevisionRace.exactBinding,
            data: {
              tabRefs: ['auth-revision-race-tab'],
              tabSnapshotRevision: 42,
            },
          },
        }), wsConnectionGeneration, authB);
        const authRevisionRaceAcks = await kv.get(COMMAND_ACK_OUTBOX_KEY);
        resolveExactTabRefs = originalResolveExactTabRefs;
        closeExactTabTargets = originalCloseExactTabTargets;
        refreshTabCache = originalRefreshTabCache;

        const nPlusOneExactBinding = {
          ...authRevisionRace.exactBinding,
          controlRevision: 43,
        };
        await applyClassroomStateFromAuthResponse({
          schoolId: authB.schoolId,
          studentId: authB.studentId,
          studentSessionId: authB.studentSessionId,
          exactBinding: nPlusOneExactBinding,
          classroomState: {
            ...(currentClassroomState || authRevisionRace.classroomState),
            revision: 43,
            hardExpiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          },
        }, 'same-session N+1 sync fixture', { requireApplied: true, authContext: authB });
        const nPlusOneWatermark = currentStudentControlRevision();
        let nPlusOneCloseCount = 0;
        resolveExactTabRefs = async (refs, revision) => ({
          revision,
          targets: [{ tabRef: refs[0], tabId: 9442 }],
        });
        closeExactTabTargets = async () => { nPlusOneCloseCount += 1; };
        refreshTabCache = async () => {};
        await handleWsMessage(JSON.stringify({
          type: 'remote-control',
          _msgId: 'same-session-n-plus-one-close-frame',
          commandId: 'same-session-n-plus-one-close',
          studentId: authB.studentId,
          studentSessionId: authB.studentSessionId,
          exactBinding: nPlusOneExactBinding,
          authority: {
            kind: 'teaching_session',
            teachingSessionId: 'teaching-session-b',
          },
          command: {
            commandId: 'same-session-n-plus-one-close',
            type: 'close-tab',
            exactBinding: nPlusOneExactBinding,
            data: { tabRefs: ['same-session-n-plus-one-tab'], tabSnapshotRevision: 43 },
          },
        }), wsConnectionGeneration, authB);
        const nPlusOneAcks = await kv.get(COMMAND_ACK_OUTBOX_KEY);
        progress('revision fixtures complete');
        resolveExactTabRefs = originalResolveExactTabRefs;
        closeExactTabTargets = originalCloseExactTabTargets;
        refreshTabCache = originalRefreshTabCache;
        // A new immutable auth context for the same server tuple is still an
        // authority transition. The remainder of the suite deliberately
        // starts without inheriting the prior context's revision watermark.
        authB = installIdentity('b');
        let replayCalls = 0;
        fetchWithBackoff = async () => {
          replayCalls += 1;
          return new Response('{}', { status: 500 });
        };
        await flushStudentChatOutbox();
        const afterIdentityChange = await kv.get([
          STUDENT_CHAT_OUTBOX_KEY,
          STUDENT_CHAT_OUTBOX_BINDING_KEY,
        ]);

        const allSupportedCapabilities = [
          'scopedAuthorityChecksV1',
          'authBoundTelemetryV1',
          'exactBindingAckV2',
          'exactTabCloseV2',
          'studentChatIdempotencyV1',
          'screenshotObservationLeaseV1',
          'screenshotActiveObservationCadenceV1',
          'safetyEvidenceCaptureV1',
          'liveViewIceServersV1',
          'kioskLaunchTicketV2',
        ];
        const individuallyAcceptedCapabilities = allSupportedCapabilities.map((capability) => {
          const advertisedCapabilities = SCOPED_AUTHORITY_DEPENDENT_CAPABILITIES.has(capability)
            ? ['scopedAuthorityChecksV1', capability]
            : [capability];
          const protocolState = adoptNegotiatedProtocolState({
            serverProtocolVersion: 3,
            acceptedCapabilities: advertisedCapabilities,
          }, authB);
          const ordinaryBinding = assertCurrentStudentBinding({
            studentId: authB.studentId,
            studentSessionId: authB.studentSessionId,
          }, `individual capability isolation:${capability}`);
          assertBindingMatchesAuthContext(
            ordinaryBinding,
            authB,
            `individual capability isolation:${capability}`,
          );
          return {
            capability,
            accepted: protocolState.acceptedCapabilities.includes(capability)
              && hasNegotiatedCapability(capability, authB),
          };
        });
        const allSupportedProtocolState = adoptNegotiatedProtocolState({
          serverProtocolVersion: 3,
          acceptedCapabilities: allSupportedCapabilities,
        }, authB);
        const allSupportedCapabilitiesAccepted = allSupportedCapabilities.every((capability) => (
          allSupportedProtocolState.acceptedCapabilities.includes(capability)
          && hasNegotiatedCapability(capability, authB)
        ));
        const scopedOrdinaryBinding = assertCurrentStudentBinding({
          studentId: authB.studentId,
          studentSessionId: authB.studentSessionId,
        }, 'ordinary command capability isolation');
        assertBindingMatchesAuthContext(
          scopedOrdinaryBinding,
          authB,
          'ordinary command capability isolation',
        );
        const unrelatedCommandBindingAccepted = true;
        adoptNegotiatedProtocolState({
          serverProtocolVersion: 3,
          acceptedCapabilities: ['authBoundTelemetryV1', 'exactBindingAckV2', 'exactTabCloseV2'],
        }, authB);
        const unmarkedScopedCapabilitiesRejected = !hasNegotiatedCapability(
          'exactBindingAckV2',
          authB,
        ) && !hasNegotiatedCapability('authBoundTelemetryV1', authB);
        adoptNegotiatedProtocolState({
          serverProtocolVersion: 3,
          acceptedCapabilities: allSupportedCapabilities,
        }, authB);
        const ackAuthorityPriorFabState = currentFabState;
        const ackAuthorityPriorClassroomState = currentClassroomState;
        const ackAuthorityOriginalExecute = executeRemoteControlCommand;
        let nullRevisionCommandExecutions = 0;
        let nullRevisionCommandResult;
        let nullRevisionCommandOutbox;
        try {
          currentFabState = {
            teachingSessionId: 'teaching-session-b',
            activeSessionIds: ['teaching-session-b'],
            messagingEnabled: true,
            ownershipRevisionKnown: false,
          };
          currentClassroomState = null;
          executeRemoteControlCommand = async () => {
            nullRevisionCommandExecutions += 1;
            return { executed: true };
          };
          nullRevisionCommandResult = await handleRemoteControl({
            commandId: 'null-revision-exact-ack-command',
            type: 'lock-screen',
            authority: {
              teachingSessionId: 'teaching-session-b',
              supervisionContextId: null,
            },
            data: { message: 'Applies while exact ACK authority hydrates' },
          }, {
            commandId: 'null-revision-exact-ack-command',
            studentId: authB.studentId,
            studentSessionId: authB.studentSessionId,
          });
          nullRevisionCommandOutbox = await kv.get(COMMAND_ACK_OUTBOX_KEY);
        } finally {
          executeRemoteControlCommand = ackAuthorityOriginalExecute;
          currentFabState = ackAuthorityPriorFabState;
          currentClassroomState = ackAuthorityPriorClassroomState;
        }
        adoptScreenshotPolicy({ mode: 'lease', observed: true }, authB);
        const malformedLeaseAllowed = ambientScreenshotAllowed(authB);
        const captureBeforeLeaseAdoption = captureAndSendScreenshot;
        let leaseImmediateCaptureRequests = 0;
        captureAndSendScreenshot = async () => {
          leaseImmediateCaptureRequests += 1;
          return { status: 'captured-by-test-double' };
        };
        adoptScreenshotPolicy({
          mode: 'lease',
          observed: true,
          expiresInSeconds: 90,
          serverTime: new Date().toISOString(),
        }, authB);
        const validLeaseAllowed = ambientScreenshotAllowed(authB);
        const stalePolicyReceivedAt = Date.now();
        adoptScreenshotPolicy({
          mode: 'lease',
          observed: true,
          expiresInSeconds: 90,
          serverTime: new Date(stalePolicyReceivedAt - 120_000).toISOString(),
        }, authB, {
          requestStartedAt: stalePolicyReceivedAt - 500,
          responseReceivedAt: stalePolicyReceivedAt,
        });
        const staleLeaseAllowed = ambientScreenshotAllowed(authB);

        adoptNegotiatedProtocolState({
          serverProtocolVersion: 2,
          acceptedCapabilities: [],
        }, authB);
        adoptScreenshotPolicy(undefined, authB);
        const legacyPolicyAllowedBeforeLeaseUpgrade = ambientScreenshotAllowed(authB);
        const delayedHeartbeatProtocolGeneration = reserveProtocolPolicyRequestGeneration();
        const delayedHeartbeatScreenshotGeneration = reserveScreenshotPolicyRequestGeneration();
        const capablePolicyGeneration = reserveProtocolPolicyRequestGeneration();
        const capableMissingPolicyApplied = adoptProtocolAndScreenshotPolicy({
          serverProtocolVersion: 3,
          acceptedCapabilities: allSupportedCapabilities,
        }, authB, {
          requestGeneration: capablePolicyGeneration,
          requestStartedAt: Date.now(),
          responseReceivedAt: Date.now(),
        });
        const capableMissingPolicyAllowed = ambientScreenshotAllowed(authB);
        const delayedHeartbeatPolicyApplied = adoptProtocolAndScreenshotPolicy({
          serverProtocolVersion: 3,
          acceptedCapabilities: allSupportedCapabilities,
          screenshotPolicy: {
            mode: 'lease',
            observed: true,
            expiresInSeconds: 90,
            serverTime: new Date().toISOString(),
          },
        }, authB, {
          requestGeneration: delayedHeartbeatProtocolGeneration,
          screenshotRequestGeneration: delayedHeartbeatScreenshotGeneration,
          requestStartedAt: Date.now(),
          responseReceivedAt: Date.now(),
        });
        const delayedHeartbeatPolicyAllowed = ambientScreenshotAllowed(authB);

        const delayedRenewalProtocolGeneration = reserveProtocolPolicyRequestGeneration();
        const delayedRenewalScreenshotGeneration = reserveScreenshotPolicyRequestGeneration();
        const missingPolicyPreserved = adoptProtocolAndScreenshotPolicy({
          serverProtocolVersion: 3,
          acceptedCapabilities: allSupportedCapabilities,
        }, authB, {
          requestGeneration: reserveProtocolPolicyRequestGeneration(),
          requestStartedAt: Date.now(),
          responseReceivedAt: Date.now(),
        });
        const missingPolicyPreservedAllowed = ambientScreenshotAllowed(authB);
        const malformedPolicyApplied = adoptProtocolAndScreenshotPolicy({
          serverProtocolVersion: 3,
          acceptedCapabilities: allSupportedCapabilities,
          screenshotPolicy: { mode: 'lease', observed: true },
        }, authB, {
          requestGeneration: reserveProtocolPolicyRequestGeneration(),
          requestStartedAt: Date.now(),
          responseReceivedAt: Date.now(),
        });
        const malformedPolicyAllowed = ambientScreenshotAllowed(authB);
        const supersededHeartbeatPolicyApplied = adoptProtocolAndScreenshotPolicy({
          serverProtocolVersion: 3,
          acceptedCapabilities: allSupportedCapabilities,
          screenshotPolicy: {
            mode: 'lease',
            observed: true,
            expiresInSeconds: 90,
            serverTime: new Date().toISOString(),
          },
        }, authB, {
          requestGeneration: delayedRenewalProtocolGeneration,
          screenshotRequestGeneration: delayedRenewalScreenshotGeneration,
          requestStartedAt: Date.now(),
          responseReceivedAt: Date.now(),
        });
        const supersededHeartbeatPolicyAllowed = ambientScreenshotAllowed(authB);

        const delayedWsProtocolGeneration = reserveProtocolPolicyRequestGeneration();
        const delayedWsScreenshotGeneration = reserveScreenshotPolicyRequestGeneration();
        const delayedWsRequestStartedAt = Date.now();
        const newerHeartbeatProtocolGeneration = reserveProtocolPolicyRequestGeneration();
        const newerHeartbeatScreenshotGeneration = reserveScreenshotPolicyRequestGeneration();
        const newerHeartbeatDeniedPolicyApplied = adoptProtocolAndScreenshotPolicy({
          serverProtocolVersion: 3,
          acceptedCapabilities: allSupportedCapabilities,
          screenshotPolicy: {
            mode: 'lease',
            observed: false,
            expiresInSeconds: 0,
            serverTime: new Date().toISOString(),
          },
        }, authB, {
          requestGeneration: newerHeartbeatProtocolGeneration,
          screenshotRequestGeneration: newerHeartbeatScreenshotGeneration,
          requestStartedAt: Date.now(),
          responseReceivedAt: Date.now(),
        });
        const delayedWsAllowedPolicyApplied = adoptProtocolAndScreenshotPolicy({
          serverProtocolVersion: 3,
          acceptedCapabilities: allSupportedCapabilities,
          screenshotPolicy: {
            mode: 'lease',
            observed: true,
            expiresInSeconds: 90,
            serverTime: new Date().toISOString(),
          },
        }, authB, {
          requestGeneration: delayedWsProtocolGeneration,
          screenshotRequestGeneration: delayedWsScreenshotGeneration,
          requestStartedAt: delayedWsRequestStartedAt,
          responseReceivedAt: Date.now(),
        });
        const delayedWsAllowedPolicyAllowed = ambientScreenshotAllowed(authB);

        const delayedDeniedProtocolGeneration = reserveProtocolPolicyRequestGeneration();
        const delayedDeniedScreenshotGeneration = reserveScreenshotPolicyRequestGeneration();
        const delayedMalformedProtocolGeneration = reserveProtocolPolicyRequestGeneration();
        const delayedMalformedScreenshotGeneration = reserveScreenshotPolicyRequestGeneration();
        adoptProtocolAndScreenshotPolicy({
          serverProtocolVersion: 3,
          acceptedCapabilities: allSupportedCapabilities,
          screenshotPolicy: {
            mode: 'lease',
            observed: true,
            expiresInSeconds: 90,
            serverTime: new Date().toISOString(),
          },
        }, authB, {
          requestGeneration: reserveProtocolPolicyRequestGeneration(),
          screenshotRequestGeneration: reserveScreenshotPolicyRequestGeneration(),
          requestStartedAt: Date.now(),
          responseReceivedAt: Date.now(),
        });
        const delayedDeniedPolicyApplied = adoptProtocolAndScreenshotPolicy({
          serverProtocolVersion: 3,
          acceptedCapabilities: allSupportedCapabilities,
          screenshotPolicy: {
            mode: 'lease',
            observed: false,
            expiresInSeconds: 0,
            serverTime: new Date().toISOString(),
          },
        }, authB, {
          requestGeneration: delayedDeniedProtocolGeneration,
          screenshotRequestGeneration: delayedDeniedScreenshotGeneration,
          requestStartedAt: Date.now(),
          responseReceivedAt: Date.now(),
        });
        const delayedDeniedPolicyAllowed = ambientScreenshotAllowed(authB);
        adoptProtocolAndScreenshotPolicy({
          serverProtocolVersion: 3,
          acceptedCapabilities: allSupportedCapabilities,
          screenshotPolicy: {
            mode: 'lease',
            observed: true,
            expiresInSeconds: 90,
            serverTime: new Date().toISOString(),
          },
        }, authB, {
          requestGeneration: reserveProtocolPolicyRequestGeneration(),
          screenshotRequestGeneration: reserveScreenshotPolicyRequestGeneration(),
          requestStartedAt: Date.now(),
          responseReceivedAt: Date.now(),
        });
        const delayedMalformedPolicyApplied = adoptProtocolAndScreenshotPolicy({
          serverProtocolVersion: 3,
          acceptedCapabilities: allSupportedCapabilities,
          screenshotPolicy: { mode: 'lease', observed: true },
        }, authB, {
          requestGeneration: delayedMalformedProtocolGeneration,
          screenshotRequestGeneration: delayedMalformedScreenshotGeneration,
          requestStartedAt: Date.now(),
          responseReceivedAt: Date.now(),
        });
        const delayedMalformedPolicyAllowed = ambientScreenshotAllowed(authB);
        const explicitDeniedPolicyApplied = adoptProtocolAndScreenshotPolicy({
          serverProtocolVersion: 3,
          acceptedCapabilities: allSupportedCapabilities,
          screenshotPolicy: {
            mode: 'lease',
            observed: false,
            expiresInSeconds: 0,
            serverTime: new Date().toISOString(),
          },
        }, authB, {
          requestGeneration: reserveProtocolPolicyRequestGeneration(),
          requestStartedAt: Date.now(),
          responseReceivedAt: Date.now(),
        });
        const explicitDeniedPolicyAllowed = ambientScreenshotAllowed(authB);
        adoptProtocolAndScreenshotPolicy({
          serverProtocolVersion: 3,
          acceptedCapabilities: allSupportedCapabilities,
          screenshotPolicy: {
            mode: 'lease',
            observed: true,
            expiresInSeconds: 90,
            serverTime: new Date().toISOString(),
          },
        }, authB, {
          requestGeneration: reserveProtocolPolicyRequestGeneration(),
          requestStartedAt: Date.now(),
          responseReceivedAt: Date.now(),
        });
        const omittedPolicyExpiredRetention = canRetainOmittedScreenshotPolicy(
          authB,
          Date.now() + 120_000,
        );
        const omittedPolicyNewScopeRetention = canRetainOmittedScreenshotPolicy({
          ...authB,
          studentSessionId: 'student-session-new-scope',
        }, Date.now());
        const cadenceNow = Date.now();
        const cadencePolicyBase = {
          mode: 'tracking_window_lease',
          valid: true,
          captureAllowed: true,
          expiresAt: cadenceNow + 90_000,
          authority: {
            kind: 'teaching_session',
            teachingSessionId: 'teaching-session-b',
            controlRevision: 42,
          },
        };
        const activeViewCadence = normalizeScreenshotCaptureCadence({
          serverTime: new Date(cadenceNow).toISOString(),
          captureCadence: {
            mode: 'active_view',
            intervalSeconds: 5,
            expiresInSeconds: 90,
          },
        }, authB, {
          requestStartedAt: cadenceNow - 50,
          responseReceivedAt: cadenceNow,
        }, cadencePolicyBase);
        const invalidIntervalCadence = normalizeScreenshotCaptureCadence({
          serverTime: new Date(cadenceNow).toISOString(),
          captureCadence: {
            mode: 'active_view',
            intervalSeconds: 4,
            expiresInSeconds: 90,
          },
        }, authB, {
          requestStartedAt: cadenceNow - 50,
          responseReceivedAt: cadenceNow,
        }, cadencePolicyBase);
        const stringIntervalCadence = normalizeScreenshotCaptureCadence({
          serverTime: new Date(cadenceNow).toISOString(),
          captureCadence: {
            mode: 'active_view',
            intervalSeconds: '5',
            expiresInSeconds: 90,
          },
        }, authB, {
          requestStartedAt: cadenceNow - 50,
          responseReceivedAt: cadenceNow,
        }, cadencePolicyBase);
        const stringExpiryCadence = normalizeScreenshotCaptureCadence({
          serverTime: new Date(cadenceNow).toISOString(),
          captureCadence: {
            mode: 'active_view',
            intervalSeconds: 5,
            expiresInSeconds: '90',
          },
        }, authB, {
          requestStartedAt: cadenceNow - 50,
          responseReceivedAt: cadenceNow,
        }, cadencePolicyBase);
        const wrongAuthorityCadence = normalizeScreenshotCaptureCadence({
          serverTime: new Date(cadenceNow).toISOString(),
          captureCadence: {
            mode: 'active_view',
            intervalSeconds: 5,
            expiresInSeconds: 90,
          },
        }, authB, {
          requestStartedAt: cadenceNow - 50,
          responseReceivedAt: cadenceNow,
        }, {
          ...cadencePolicyBase,
          authority: { kind: 'student_session', controlRevision: 42 },
        });
        adoptNegotiatedProtocolState({
          serverProtocolVersion: 3,
          acceptedCapabilities: allSupportedCapabilities.filter(
            (capability) => capability !== 'screenshotActiveObservationCadenceV1',
          ),
        }, authB);
        const unnegotiatedCadence = normalizeScreenshotCaptureCadence({
          serverTime: new Date(cadenceNow).toISOString(),
          captureCadence: {
            mode: 'active_view',
            intervalSeconds: 5,
            expiresInSeconds: 90,
          },
        }, authB, {
          requestStartedAt: cadenceNow - 50,
          responseReceivedAt: cadenceNow,
        }, cadencePolicyBase);
        adoptNegotiatedProtocolState({
          serverProtocolVersion: 3,
          acceptedCapabilities: allSupportedCapabilities,
        }, authB);

        const hardeningPriorPolicyState = screenshotPolicyState;
        const hardeningPriorProtocolState = negotiatedProtocolState;
        const hardeningPriorClassroomState = currentClassroomState;
        const hardeningPriorRevisionAuthority = studentControlRevisionAuthority;
        const hardeningPriorSendToOffscreen = sendToOffscreen;
        const hardeningPriorFetchWithBackoff = fetchWithBackoff;
        const cadenceSchedulerMessages = [];
        let cadenceIdentityPreserved = false;
        let cadenceRenewalPreservedInterval = false;
        let authorityChangeTickCaptures = 0;
        let staleAuthorityTickIgnored = false;
        let authorityChangeStoppedCadence = false;
        let heartbeatOmissionRetainedPermission = false;
        let heartbeatOmissionDowngradedCadence = false;
        let uploadOmissionRetainedPermission = false;
        let uploadOmissionDowngradedCadence = false;
        let malformedCadenceRetainedPermission = false;
        let malformedCadenceDowngraded = false;
        let authorityChangeRapidUploadAttempts = null;
        let leaseStartCaptureOnActivation = false;
        let leaseStartSuppressedOnRenewal = false;
        let leaseStartBypassedAuthorityChange = false;
        try {
          sendToOffscreen = async (message, sendOptions = {}) => {
            sendOptions.assertCurrent?.();
            cadenceSchedulerMessages.push({ ...message });
            return { success: true };
          };
          currentClassroomState = {
            schemaVersion: 1,
            revision: 42,
            teachingSessionId: 'teaching-session-b',
            supervisionContextId: null,
            hardExpiresAt: '2099-01-01T00:00:00.000Z',
            restrictions: RuntimeCore.emptyRestrictions(),
          };
          observeStudentControlRevision(42, authB, 'rapid cadence hardening fixture');
          const cadenceCapabilities = [
            'scopedAuthorityChecksV1',
            'screenshotTrackingWindowLeaseV1',
            'screenshotActiveObservationCadenceV1',
          ];
          adoptNegotiatedProtocolState({
            serverProtocolVersion: 3,
            acceptedCapabilities: cadenceCapabilities,
          }, authB);
          const trackingPolicy = (serverTime = Date.now()) => ({
            mode: 'tracking_window_lease',
            captureAllowed: true,
            expiresInSeconds: 84,
            serverTime: new Date(serverTime).toISOString(),
            authority: {
              kind: 'teaching_session',
              teachingSessionId: 'teaching-session-b',
              controlRevision: 42,
            },
            captureCadence: {
              mode: 'active_view',
              intervalSeconds: 5,
              expiresInSeconds: 84,
            },
          });
          const cadenceClockBase = originalDateNow();
          let cadenceClockNow = cadenceClockBase;
          Date.now = () => cadenceClockNow;
          try {
            adoptScreenshotPolicy(trackingPolicy(cadenceClockNow), authB, {
              requestStartedAt: cadenceClockNow,
              responseReceivedAt: cadenceClockNow,
              policySource: 'heartbeat',
            });
            const firstCadence = activeScreenshotCadence;
            const firstStartCount = cadenceSchedulerMessages.filter(
              (message) => message.type === 'SCREENSHOT_CADENCE_START',
            ).length;
            cadenceClockNow += 10_000;
            adoptScreenshotPolicy(trackingPolicy(cadenceClockNow), authB, {
              requestStartedAt: cadenceClockNow,
              responseReceivedAt: cadenceClockNow,
              policySource: 'heartbeat',
            });
            const renewedCadence = activeScreenshotCadence;
            const renewalStarts = cadenceSchedulerMessages.filter(
              (message) => message.type === 'SCREENSHOT_CADENCE_START',
            );
            cadenceIdentityPreserved = Boolean(
              firstCadence
              && renewedCadence
              && firstCadence.cadenceId === renewedCadence.cadenceId
              && firstCadence.generation === renewedCadence.generation
              && firstCadence.issuedAt === renewedCadence.issuedAt
              && renewedCadence.expiresAt > firstCadence.expiresAt
            );
            cadenceRenewalPreservedInterval = firstStartCount === 1
              && renewalStarts.length === 2
              && renewalStarts[0].cadenceId === renewalStarts[1].cadenceId
              && renewalStarts[0].generation === renewalStarts[1].generation
              && renewalStarts[0].issuedAt === renewalStarts[1].issuedAt
              && !cadenceSchedulerMessages.some((message) => (
                message.type === 'SCREENSHOT_CADENCE_STOP'
                && message.cadenceId === firstCadence?.cadenceId
              ));
          } finally {
            Date.now = originalDateNow;
          }

          // 'lease-start' immediate capture: cadence activation without an
          // authority change must fire exactly one gap-0 capture; downgrades
          // and renewals must not. The double stays installed through the
          // omission/malformed adoptions below so their re-activations count
          // here instead of running real captures.
          const leaseStartReasons = [];
          captureAndSendScreenshot = async ({ reason } = {}) => {
            leaseStartReasons.push(reason);
            return { status: 'captured-by-lease-start-double' };
          };
          const countLeaseStarts = () => leaseStartReasons.filter(
            (reason) => reason === 'lease-start',
          ).length;
          const backgroundOnlyPolicy = trackingPolicy();
          delete backgroundOnlyPolicy.captureCadence;
          adoptScreenshotPolicy(backgroundOnlyPolicy, authB, {
            requestStartedAt: Date.now(),
            responseReceivedAt: Date.now(),
            policySource: 'heartbeat',
          });
          const leaseStartAfterDowngrade = countLeaseStarts();
          adoptScreenshotPolicy(trackingPolicy(), authB, {
            requestStartedAt: Date.now(),
            responseReceivedAt: Date.now(),
            policySource: 'heartbeat',
          });
          const leaseStartAfterActivation = countLeaseStarts();
          adoptScreenshotPolicy(trackingPolicy(), authB, {
            requestStartedAt: Date.now(),
            responseReceivedAt: Date.now(),
            policySource: 'heartbeat',
          });
          const leaseStartAfterRenewal = countLeaseStarts();
          leaseStartCaptureOnActivation = leaseStartAfterDowngrade === 0
            && leaseStartAfterActivation === 1;
          leaseStartSuppressedOnRenewal = leaseStartAfterRenewal === leaseStartAfterActivation;
          leaseStartBypassedAuthorityChange = !leaseStartReasons.includes('authority-change');

          const authorityChangeRetryOptions = [];
          fetchWithBackoff = async (_url, _init, retryOptions = {}) => {
            authorityChangeRetryOptions.push(retryOptions.maxAttempts);
            return new Response('{}', {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          };
          lastScreenshotAttemptAt = 0;
          await captureBeforeLeaseAdoption({
            reason: 'authority-change',
            queryActiveTab: async () => [{
              id: 7099,
              active: true,
              windowId: 99,
              url: 'https://observed.example/authority-change',
              title: 'Authority change',
              favIconUrl: '',
            }],
            captureVisibleTab: async () => 'data:image/jpeg;base64,YXV0aG9yaXR5LWNoYW5nZQ==',
            subscribeTabActivation: () => () => {},
            subscribeTabUpdate: () => () => {},
          });
          authorityChangeRapidUploadAttempts = authorityChangeRetryOptions.at(-1) ?? null;
          uploadOmissionRetainedPermission = ambientScreenshotAllowed(authB);
          uploadOmissionDowngradedCadence = screenshotPolicyState.captureCadence.mode === 'background'
            && activeScreenshotCadence === null;

          adoptScreenshotPolicy(trackingPolicy(), authB, {
            requestStartedAt: Date.now(),
            responseReceivedAt: Date.now(),
            policySource: 'heartbeat',
          });
          adoptProtocolAndScreenshotPolicy({
            serverProtocolVersion: 3,
            acceptedCapabilities: cadenceCapabilities,
          }, authB, {
            requestGeneration: reserveProtocolPolicyRequestGeneration(),
            screenshotRequestGeneration: reserveScreenshotPolicyRequestGeneration(),
            requestStartedAt: Date.now(),
            responseReceivedAt: Date.now(),
            policySource: 'heartbeat',
          });
          heartbeatOmissionRetainedPermission = ambientScreenshotAllowed(authB);
          heartbeatOmissionDowngradedCadence = screenshotPolicyState.captureCadence.mode === 'background'
            && activeScreenshotCadence === null;

          const malformedTrackingPolicy = trackingPolicy();
          malformedTrackingPolicy.captureCadence.intervalSeconds = '5';
          adoptScreenshotPolicy(malformedTrackingPolicy, authB, {
            requestStartedAt: Date.now(),
            responseReceivedAt: Date.now(),
            policySource: 'heartbeat',
          });
          malformedCadenceRetainedPermission = ambientScreenshotAllowed(authB);
          malformedCadenceDowngraded = screenshotPolicyState.captureCadence.mode === 'background'
            && activeScreenshotCadence === null;

          adoptScreenshotPolicy(trackingPolicy(), authB, {
            requestStartedAt: Date.now(),
            responseReceivedAt: Date.now(),
            policySource: 'heartbeat',
          });
          captureAndSendScreenshot = async ({ reason } = {}) => {
            if (reason === 'active-view-tick') authorityChangeTickCaptures += 1;
            return { status: 'captured-by-cadence-hardening-double' };
          };
          const tickCadence = activeScreenshotCadence;
          await handleOffscreenMessage({
            type: 'SCREENSHOT_CADENCE_TICK',
            cadenceId: tickCadence.cadenceId,
            generation: tickCadence.generation,
          });
          const capturesBeforeAuthorityChange = authorityChangeTickCaptures;
          currentClassroomState = {
            ...currentClassroomState,
            teachingSessionId: 'teaching-session-c',
          };
          const staleTickResult = await handleOffscreenMessage({
            type: 'SCREENSHOT_CADENCE_TICK',
            cadenceId: tickCadence.cadenceId,
            generation: tickCadence.generation,
          });
          staleAuthorityTickIgnored = staleTickResult?.ignored === true
            && authorityChangeTickCaptures === capturesBeforeAuthorityChange;
          retireScreenshotAuthorityForClassroomChange();
          authorityChangeStoppedCadence = activeScreenshotCadence === null;
        } finally {
          Date.now = originalDateNow;
          stopActiveScreenshotCadence('hardening-fixture-cleanup');
          sendToOffscreen = hardeningPriorSendToOffscreen;
          fetchWithBackoff = hardeningPriorFetchWithBackoff;
          currentClassroomState = hardeningPriorClassroomState;
          studentControlRevisionAuthority = hardeningPriorRevisionAuthority;
          negotiatedProtocolState = hardeningPriorProtocolState;
          screenshotPolicyState = hardeningPriorPolicyState;
          activeScreenshotCadence = null;
        }
        captureAndSendScreenshot = captureBeforeLeaseAdoption;
        progress('capability adoption complete');

        let releaseLeaseRenewalCapture;
        let leaseRenewalCaptureStarted;
        const leaseRenewalCaptureGate = new Promise((resolveGate) => {
          releaseLeaseRenewalCapture = resolveGate;
        });
        const leaseRenewalCaptureReady = new Promise((resolveReady) => {
          leaseRenewalCaptureStarted = resolveReady;
        });
        let leaseRenewalCaptureCalls = 0;
        let leaseRenewalUploads = 0;
        fetchWithBackoff = async () => {
          leaseRenewalUploads += 1;
          return new Response('{}', { status: 200 });
        };
        lastScreenshotAttemptAt = 0;
        const leaseRenewalCapturePromise = captureAndSendScreenshot({
          reason: 'lease-renewal-race',
          queryActiveTab: async () => [{
            id: 6998,
            active: true,
            windowId: 98,
            url: 'https://observed.example/lease-renewal',
            title: 'Lease renewal',
            favIconUrl: '',
          }],
          subscribeTabActivation: () => () => {},
          subscribeTabUpdate: () => () => {},
          captureVisibleTab: async () => {
            leaseRenewalCaptureCalls += 1;
            leaseRenewalCaptureStarted();
            await leaseRenewalCaptureGate;
            return 'data:image/jpeg;base64,bGVhc2UtcmVuZXdhbA==';
          },
        });
        await waitForDeterministicPause(
          leaseRenewalCaptureReady,
          leaseRenewalCapturePromise,
          'lease-renewal screenshot capture',
        );
        const generationBeforeContinuousRenewal = screenshotPolicyGeneration;
        adoptScreenshotPolicy({
          mode: 'lease',
          observed: true,
          expiresInSeconds: 90,
          serverTime: new Date().toISOString(),
        }, authB);
        const generationAfterContinuousRenewal = screenshotPolicyGeneration;
        releaseLeaseRenewalCapture();
        const leaseRenewalCaptureResult = await leaseRenewalCapturePromise;

        let releasePolicyGenerationCapture;
        let policyGenerationCaptureStarted;
        const policyGenerationCaptureGate = new Promise((resolveGate) => {
          releasePolicyGenerationCapture = resolveGate;
        });
        const policyGenerationCaptureReady = new Promise((resolveReady) => {
          policyGenerationCaptureStarted = resolveReady;
        });
        let policyGenerationCaptureCalls = 0;
        const policyGenerationUploads = [];
        fetchWithBackoff = async (_url, init = {}) => {
          policyGenerationUploads.push(JSON.parse(String(init.body || '{}')));
          return new Response('{}', { status: 200 });
        };
        lastScreenshotAttemptAt = 0;
        const supersededPolicyCapturePromise = captureAndSendScreenshot({
          reason: 'lease-generation-race',
          queryActiveTab: async () => [{
            id: 6999,
            active: true,
            windowId: 99,
            url: 'https://observed.example/policy-generation',
            title: 'Policy generation',
            favIconUrl: '',
          }],
          subscribeTabActivation: () => () => {},
          subscribeTabUpdate: () => () => {},
          captureVisibleTab: async () => {
            policyGenerationCaptureCalls += 1;
            if (policyGenerationCaptureCalls === 1) {
              policyGenerationCaptureStarted();
              await policyGenerationCaptureGate;
              return 'data:image/jpeg;base64,bGVhc2Utb25l';
            }
            return 'data:image/jpeg;base64,bGVhc2UtdHdv';
          },
        });
        await policyGenerationCaptureReady;
        adoptScreenshotPolicy({
          mode: 'lease',
          observed: false,
          expiresInSeconds: 0,
          serverTime: new Date().toISOString(),
        }, authB);
        adoptScreenshotPolicy({
          mode: 'lease',
          observed: true,
          expiresInSeconds: 90,
          serverTime: new Date().toISOString(),
        }, authB);
        releasePolicyGenerationCapture();
        const supersededPolicyCaptureResult = await supersededPolicyCapturePromise;
        const trailingCaptureDeadline = Date.now() + 2_000;
        while (policyGenerationUploads.length < 1 && Date.now() < trailingCaptureDeadline) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
        }

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
          subscribeTabActivation: () => () => {},
          subscribeTabUpdate: () => () => {},
        });

        let releaseStaleUploadDenial;
        let staleUploadStarted;
        const staleUploadDenialGate = new Promise((resolveGate) => {
          releaseStaleUploadDenial = resolveGate;
        });
        const staleUploadReady = new Promise((resolveReady) => {
          staleUploadStarted = resolveReady;
        });
        fetchWithBackoff = async () => {
          staleUploadStarted();
          await staleUploadDenialGate;
          return new Response(JSON.stringify({
            ok: false,
            code: 'SCREENSHOT_PAUSED_UNOBSERVED',
            screenshotPolicy: {
              mode: 'lease',
              observed: false,
              expiresInSeconds: 0,
              serverTime: new Date().toISOString(),
            },
          }), {
            status: 409,
            headers: { 'content-type': 'application/json' },
          });
        };
        lastScreenshotAttemptAt = 0;
        const staleUploadDenialPromise = captureAndSendScreenshot({
          reason: 'stale-upload-denial-after-newer-allow',
          queryActiveTab: async () => [{
            id: 7017,
            active: true,
            windowId: 17,
            url: 'https://observed.example/stale-upload-denial',
            title: 'Stale upload denial',
            favIconUrl: '',
          }],
          captureVisibleTab: async () => 'data:image/jpeg;base64,c3RhbGUtdXBsb2FkLWRlbmlhbA==',
          subscribeTabActivation: () => () => {},
          subscribeTabUpdate: () => () => {},
        });
        await staleUploadReady;
        const captureBeforeStaleUploadPolicyChange = captureAndSendScreenshot;
        captureAndSendScreenshot = async () => ({ status: 'policy-race-test-double' });
        adoptScreenshotPolicy({
          mode: 'lease',
          observed: false,
          expiresInSeconds: 0,
          serverTime: new Date().toISOString(),
        }, authB);
        adoptScreenshotPolicy({
          mode: 'lease',
          observed: true,
          expiresInSeconds: 90,
          serverTime: new Date().toISOString(),
        }, authB);
        captureAndSendScreenshot = captureBeforeStaleUploadPolicyChange;
        const staleUploadNewerAllowWasActive = ambientScreenshotAllowed(authB);
        releaseStaleUploadDenial();
        const staleUploadDenialResult = await staleUploadDenialPromise;
        const staleUploadDenialRevokedNewerAllow = !ambientScreenshotAllowed(authB);
        const captureBeforeStaleUploadRestore = captureAndSendScreenshot;
        captureAndSendScreenshot = async () => ({ status: 'restore-test-double' });
        adoptScreenshotPolicy({
          mode: 'lease',
          observed: true,
          expiresInSeconds: 90,
          serverTime: new Date().toISOString(),
        }, authB);
        captureAndSendScreenshot = captureBeforeStaleUploadRestore;

        const originalScheduleEventHeartbeat = scheduleEventHeartbeat;
        const screenshotAuthorityHeartbeatReasons = [];
        scheduleEventHeartbeat = (heartbeatReason) => {
          screenshotAuthorityHeartbeatReasons.push(heartbeatReason);
        };
        fetchWithBackoff = async () => new Response(JSON.stringify({
          ok: false,
          code: 'SCREENSHOT_CAPABILITY_HEARTBEAT_REQUIRED',
        }), {
          status: 409,
          headers: { 'content-type': 'application/json' },
        });
        lastScreenshotAttemptAt = 0;
        const heartbeatRequiredCaptureResult = await captureAndSendScreenshot({
          reason: 'heartbeat-required-fixture',
          queryActiveTab: async () => [{
            id: 7014,
            active: true,
            windowId: 14,
            url: 'https://observed.example/heartbeat-required',
            title: 'Heartbeat required',
            favIconUrl: '',
          }],
          captureVisibleTab: async () => 'data:image/jpeg;base64,aGVhcnRiZWF0LXJlcXVpcmVk',
          subscribeTabActivation: () => () => {},
          subscribeTabUpdate: () => () => {},
        });
        const heartbeatRequiredLeaseRetained = ambientScreenshotAllowed(authB);

        let pausedUnobservedUploadAttempts = 0;
        fetchWithBackoff = async () => {
          pausedUnobservedUploadAttempts += 1;
          return new Response(JSON.stringify({
            ok: false,
            code: 'SCREENSHOT_PAUSED_UNOBSERVED',
            screenshotPolicy: {
              mode: 'lease',
              observed: false,
              expiresInSeconds: 0,
              serverTime: new Date().toISOString(),
            },
          }), {
            status: 409,
            headers: { 'content-type': 'application/json' },
          });
        };
        const pausedUnobservedFixture = {
          queryActiveTab: async () => [{
            id: 7016,
            active: true,
            windowId: 16,
            url: 'https://observed.example/paused-unobserved',
            title: 'Paused unobserved',
            favIconUrl: '',
          }],
          captureVisibleTab: async () => 'data:image/jpeg;base64,cGF1c2VkLXVub2JzZXJ2ZWQ=',
          subscribeTabActivation: () => () => {},
          subscribeTabUpdate: () => () => {},
        };
        lastScreenshotAttemptAt = 0;
        const pausedUnobservedCaptureResult = await captureAndSendScreenshot({
          reason: 'paused-unobserved-fixture',
          ...pausedUnobservedFixture,
        });
        const pausedUnobservedLeaseRevoked = !ambientScreenshotAllowed(authB);
        lastScreenshotAttemptAt = 0;
        const captureAfterPausedUnobservedResult = await captureAndSendScreenshot({
          reason: 'paused-unobserved-second-attempt',
          ...pausedUnobservedFixture,
        });
        const captureBeforeDeniedLeaseRestore = captureAndSendScreenshot;
        captureAndSendScreenshot = async () => ({ status: 'restore-test-double' });
        adoptScreenshotPolicy({
          mode: 'lease',
          observed: true,
          expiresInSeconds: 90,
          serverTime: new Date().toISOString(),
        }, authB);
        captureAndSendScreenshot = captureBeforeDeniedLeaseRestore;

        const delayedAuthorizationAllowProtocolGeneration = reserveProtocolPolicyRequestGeneration();
        const delayedAuthorizationAllowScreenshotGeneration = reserveScreenshotPolicyRequestGeneration();
        const delayedAuthorizationAllowStartedAt = Date.now();
        let authorizationDeniedUploadAttempts = 0;
        fetchWithBackoff = async () => {
          authorizationDeniedUploadAttempts += 1;
          return new Response(JSON.stringify({
            ok: false,
            code: 'SCREENSHOT_AUTHORITY_NOT_FOUND',
          }), {
            status: 404,
            headers: { 'content-type': 'application/json' },
          });
        };
        lastScreenshotAttemptAt = 0;
        const authorizationDeniedCaptureResult = await captureAndSendScreenshot({
          reason: 'authorization-denied-fixture',
          ...pausedUnobservedFixture,
        });
        adoptProtocolAndScreenshotPolicy({
          serverProtocolVersion: 3,
          acceptedCapabilities: allSupportedCapabilities,
          screenshotPolicy: {
            mode: 'lease',
            observed: true,
            expiresInSeconds: 90,
            serverTime: new Date().toISOString(),
          },
        }, authB, {
          requestGeneration: delayedAuthorizationAllowProtocolGeneration,
          screenshotRequestGeneration: delayedAuthorizationAllowScreenshotGeneration,
          requestStartedAt: delayedAuthorizationAllowStartedAt,
          responseReceivedAt: Date.now(),
        });
        const authorizationDeniedLeaseRevoked = !ambientScreenshotAllowed(authB);
        lastScreenshotAttemptAt = 0;
        const captureAfterAuthorizationDeniedResult = await captureAndSendScreenshot({
          reason: 'authorization-denied-second-attempt',
          ...pausedUnobservedFixture,
        });
        const captureBeforeAuthorizationRestore = captureAndSendScreenshot;
        captureAndSendScreenshot = async () => ({ status: 'restore-test-double' });
        adoptProtocolAndScreenshotPolicy({
          serverProtocolVersion: 3,
          acceptedCapabilities: allSupportedCapabilities,
          screenshotPolicy: {
            mode: 'lease',
            observed: true,
            expiresInSeconds: 90,
            serverTime: new Date().toISOString(),
          },
        }, authB, {
          requestGeneration: reserveProtocolPolicyRequestGeneration(),
          screenshotRequestGeneration: reserveScreenshotPolicyRequestGeneration(),
          requestStartedAt: Date.now(),
          responseReceivedAt: Date.now(),
        });
        captureAndSendScreenshot = captureBeforeAuthorizationRestore;

        fetchWithBackoff = async () => new Response(JSON.stringify({
          ok: false,
          code: 'SCREENSHOT_STORE_UNAVAILABLE',
        }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
        lastScreenshotAttemptAt = 0;
        const screenshotServiceUnavailableResult = await captureAndSendScreenshot({
          reason: 'service-unavailable-fixture',
          queryActiveTab: async () => [{
            id: 7015,
            active: true,
            windowId: 15,
            url: 'https://observed.example/service-unavailable',
            title: 'Service unavailable',
            favIconUrl: '',
          }],
          captureVisibleTab: async () => 'data:image/jpeg;base64,c2VydmljZS11bmF2YWlsYWJsZQ==',
          subscribeTabActivation: () => () => {},
          subscribeTabUpdate: () => () => {},
        });
        const serviceUnavailableLeaseRetained = ambientScreenshotAllowed(authB);

        const rapidCaptureFixture = {
          queryActiveTab: async () => [{
            id: 7017,
            active: true,
            windowId: 17,
            url: 'https://observed.example/rapid-cadence',
            title: 'Rapid cadence',
            favIconUrl: '',
          }],
          captureVisibleTab: async () => 'data:image/jpeg;base64,cmFwaWQtY2FkZW5jZQ==',
          subscribeTabActivation: () => () => {},
          subscribeTabUpdate: () => () => {},
        };
        const rapidCadenceUploadOptions = [];
        fetchWithBackoff = async (_url, _init, retryOptions = {}) => {
          rapidCadenceUploadOptions.push({ maxAttempts: retryOptions.maxAttempts });
          return new Response('{}', {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        };
        const rapidClockBase = originalDateNow();
        let rapidClockNow = rapidClockBase;
        Date.now = () => rapidClockNow;
        lastScreenshotAttemptAt = 0;
        try {
          await captureAndSendScreenshot({
            reason: 'active-view-navigation',
            ...rapidCaptureFixture,
          });
          rapidClockNow = rapidClockBase + 1_000;
          await captureAndSendScreenshot({
            reason: 'active-view-tick',
            ...rapidCaptureFixture,
          });
          rapidClockNow = rapidClockBase + 4_500;
          await captureAndSendScreenshot({
            reason: 'active-view-tick',
            ...rapidCaptureFixture,
          });
        } finally {
          Date.now = originalDateNow;
        }
        const rapidCadenceCombinedUploadCount = rapidCadenceUploadOptions.length;
        const rapidCadenceMinGaps = {
          navigation: screenshotCaptureMinimumGap('active-view-navigation'),
          tick: screenshotCaptureMinimumGap('active-view-tick'),
        };

        const fetchBeforeRapidFailureCases = globalThis.fetch;
        const fetchWithBackoffBeforeRapidFailureCases = fetchWithBackoff;
        let rapid503FetchAttempts = 0;
        let rapid429FetchAttempts = 0;
        try {
          fetchWithBackoff = originalFetchWithBackoff;
          globalThis.fetch = async () => {
            rapid503FetchAttempts += 1;
            return new Response(JSON.stringify({
              ok: false,
              code: 'SCREENSHOT_STORE_UNAVAILABLE',
            }), {
              status: 503,
              headers: { 'content-type': 'application/json' },
            });
          };
          lastScreenshotAttemptAt = 0;
          await captureAndSendScreenshot({
            reason: 'active-view-tick',
            ...rapidCaptureFixture,
          });

          globalThis.fetch = async () => {
            rapid429FetchAttempts += 1;
            return new Response('{}', {
              status: 429,
              headers: {
                'content-type': 'application/json',
                'retry-after': '60',
              },
            });
          };
          lastScreenshotAttemptAt = 0;
          apiBackoffUntilMs = 0;
          await captureAndSendScreenshot({
            reason: 'active-view-navigation',
            ...rapidCaptureFixture,
          });
        } finally {
          apiBackoffUntilMs = 0;
          globalThis.fetch = fetchBeforeRapidFailureCases;
          fetchWithBackoff = fetchWithBackoffBeforeRapidFailureCases;
        }

        const originalDisableForScreenshotLicense = disableForInactiveLicense;
        const screenshotLicenseDenials = [];
        disableForInactiveLicense = async (planStatus, authContext) => {
          assertAuthenticatedContextCurrent(authContext, 'screenshot 402 fixture');
          screenshotLicenseDenials.push({
            planStatus,
            scope: licenseScopeForAuthContext(authContext),
          });
        };
        fetchWithBackoff = async () => new Response(JSON.stringify({
          ok: false,
          planStatus: 'screenshot-payment-required',
        }), {
          status: 402,
          headers: { 'content-type': 'application/json' },
        });
        lastScreenshotAttemptAt = 0;
        // Screenshot 429s now use an independent lane. Clear that lane between
        // fixtures just as production waits for its retry window to elapse.
        screenshotBackoffUntilMs = 0;
        const screenshotLicenseExpectedScope = licenseScopeForAuthContext(
          captureAuthenticatedContext('screenshot 402 expected scope'),
        );
        const screenshotLicenseDeniedResult = await captureAndSendScreenshot({
          reason: 'screenshot-license-denied-fixture',
          queryActiveTab: async () => [{
            id: 7018,
            active: true,
            windowId: 18,
            url: 'https://observed.example/license-denied',
            title: 'License denied',
            favIconUrl: '',
          }],
          captureVisibleTab: async () => 'data:image/jpeg;base64,bGljZW5zZS1kZW5pZWQ=',
          subscribeTabActivation: () => () => {},
          subscribeTabUpdate: () => () => {},
        });
        const priorScreenshotRefreshClassroomState = currentClassroomState;
        currentClassroomState = {
          ...(currentClassroomState || {}),
          teachingSessionId: 'teaching-session-b',
          supervisionContextId: null,
        };
        await handleWsMessage(JSON.stringify({
          type: 'screenshot-policy-refresh',
          _msgId: 'screenshot-policy-refresh-current',
          reason: 'observation_changed',
          studentId: authB.studentId,
          studentSessionId: authB.studentSessionId,
          teachingSessionId: 'teaching-session-b',
        }), wsConnectionGeneration, authB);
        await handleWsMessage(JSON.stringify({
          type: 'screenshot-policy-refresh',
          _msgId: 'screenshot-policy-refresh-stale-session',
          reason: 'observation_changed',
          studentId: authB.studentId,
          studentSessionId: authB.studentSessionId,
          teachingSessionId: 'teaching-session-a',
        }), wsConnectionGeneration, authB);
        currentClassroomState = priorScreenshotRefreshClassroomState;
        disableForInactiveLicense = originalDisableForScreenshotLicense;
        scheduleEventHeartbeat = originalScheduleEventHeartbeat;

        let ambientActivationRaceUploads = 0;
        let ambientActivationListener = null;
        fetchWithBackoff = async () => {
          ambientActivationRaceUploads += 1;
          return new Response('{}', { status: 200 });
        };
        lastScreenshotAttemptAt = 0;
        const ambientActivationRaceResult = await captureAndSendScreenshot({
          reason: 'lease-activation-race',
          queryActiveTab: async () => [{
            id: 7004,
            active: true,
            windowId: 4,
            url: 'https://observed.example/private-a',
            title: 'Private A',
            favIconUrl: '',
          }],
          subscribeTabActivation: (listener) => {
            ambientActivationListener = listener;
            return () => {};
          },
          subscribeTabUpdate: () => () => {},
          captureVisibleTab: async () => {
            ambientActivationListener({ tabId: 7005, windowId: 4 });
            return 'data:image/jpeg;base64,cHJpdmF0ZS1i';
          },
        });

        let ambientNavigationRaceUploads = 0;
        let ambientNavigationQueryCount = 0;
        fetchWithBackoff = async () => {
          ambientNavigationRaceUploads += 1;
          return new Response('{}', { status: 200 });
        };
        lastScreenshotAttemptAt = 0;
        const ambientNavigationRaceResult = await captureAndSendScreenshot({
          reason: 'lease-navigation-race',
          queryActiveTab: async () => {
            ambientNavigationQueryCount += 1;
            return [{
              id: 7008,
              active: true,
              windowId: 8,
              url: ambientNavigationQueryCount >= 3
                ? 'https://observed.example/private-b'
                : 'https://observed.example/private-a',
              title: 'Private navigation',
              favIconUrl: '',
            }];
          },
          captureVisibleTab: async () => 'data:image/jpeg;base64,cHJpdmF0ZS1i',
          subscribeTabActivation: () => () => {},
          subscribeTabUpdate: () => () => {},
        });

        let ambientNavigationBounceUploads = 0;
        let ambientNavigationListener = null;
        fetchWithBackoff = async () => {
          ambientNavigationBounceUploads += 1;
          return new Response('{}', { status: 200 });
        };
        lastScreenshotAttemptAt = 0;
        const ambientNavigationBounceResult = await captureAndSendScreenshot({
          reason: 'lease-navigation-bounce-race',
          queryActiveTab: async () => [{
            id: 7009,
            active: true,
            windowId: 9,
            url: 'https://observed.example/private-a',
            title: 'Private navigation bounce',
            favIconUrl: '',
          }],
          subscribeTabActivation: () => () => {},
          subscribeTabUpdate: (listener) => {
            ambientNavigationListener = listener;
            return () => {};
          },
          captureVisibleTab: async () => {
            ambientNavigationListener(7009, {
              status: 'loading',
              url: 'https://observed.example/private-b',
            }, { pendingUrl: 'https://observed.example/private-b' });
            ambientNavigationListener(7009, {
              status: 'loading',
              url: 'https://observed.example/private-a',
            }, { pendingUrl: 'https://observed.example/private-a' });
            return 'data:image/jpeg;base64,cHJpdmF0ZS1i';
          },
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
          subscribeTabActivation: () => () => {},
          subscribeTabUpdate: () => () => {},
        });

        let safetyActivationRaceUploads = 0;
        let safetyActivationListener = null;
        fetchWithBackoff = async () => {
          safetyActivationRaceUploads += 1;
          return new Response('{}', { status: 200 });
        };
        const safetyActivationRaceResult = await captureSafetyEvidence({
          requestId: 'evidence-request-activation-race',
          tabRef: 'tab_exact_activation_race',
          snapshotRevision: 8,
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
        }, {
          revision: 8,
          targets: [{ tabRef: 'tab_exact_activation_race', tabId: 7006 }],
        }, authB, {
          resolveExactTargets: async () => ({
            revision: 8,
            targets: [{
              tabRef: 'tab_exact_activation_race',
              tabId: 7006,
              expectedUrl: 'https://unsafe.example/private-a',
              expectedTitle: 'Private A',
            }],
          }),
          getTab: async () => ({
            id: 7006,
            active: true,
            windowId: 6,
            url: 'https://unsafe.example/private-a',
            title: 'Private A',
          }),
          subscribeTabActivation: (listener) => {
            safetyActivationListener = listener;
            return () => {};
          },
          subscribeTabUpdate: () => () => {},
          captureVisibleTab: async () => {
            safetyActivationListener({ tabId: 7007, windowId: 6 });
            return 'data:image/jpeg;base64,cHJpdmF0ZS1i';
          },
        });

        let safetyNavigationRaceUploads = 0;
        let safetyNavigationGetCount = 0;
        fetchWithBackoff = async () => {
          safetyNavigationRaceUploads += 1;
          return new Response('{}', { status: 200 });
        };
        const safetyNavigationRaceResult = await captureSafetyEvidence({
          requestId: 'evidence-request-navigation-race',
          tabRef: 'tab_exact_navigation_race',
          snapshotRevision: 10,
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
        }, {
          revision: 10,
          targets: [{ tabRef: 'tab_exact_navigation_race', tabId: 7012 }],
        }, authB, {
          resolveExactTargets: async () => ({
            revision: 10,
            targets: [{
              tabRef: 'tab_exact_navigation_race',
              tabId: 7012,
              expectedUrl: 'https://unsafe.example/private-a',
              expectedTitle: 'Private A',
            }],
          }),
          getTab: async () => {
            safetyNavigationGetCount += 1;
            return {
              id: 7012,
              active: true,
              windowId: 12,
              url: safetyNavigationGetCount >= 3
                ? 'https://unsafe.example/private-b'
                : 'https://unsafe.example/private-a',
              title: 'Private navigation',
            };
          },
          captureVisibleTab: async () => 'data:image/jpeg;base64,cHJpdmF0ZS1i',
          subscribeTabActivation: () => () => {},
          subscribeTabUpdate: () => () => {},
        });

        let safetyNavigationBounceUploads = 0;
        let safetyNavigationListener = null;
        fetchWithBackoff = async () => {
          safetyNavigationBounceUploads += 1;
          return new Response('{}', { status: 200 });
        };
        const safetyNavigationBounceResult = await captureSafetyEvidence({
          requestId: 'evidence-request-navigation-bounce',
          tabRef: 'tab_exact_navigation_bounce',
          snapshotRevision: 11,
          expiresAt: new Date(Date.now() + 30_000).toISOString(),
        }, {
          revision: 11,
          targets: [{ tabRef: 'tab_exact_navigation_bounce', tabId: 7013 }],
        }, authB, {
          resolveExactTargets: async () => ({
            revision: 11,
            targets: [{
              tabRef: 'tab_exact_navigation_bounce',
              tabId: 7013,
              expectedUrl: 'https://unsafe.example/private-a',
              expectedTitle: 'Private A',
            }],
          }),
          getTab: async () => ({
            id: 7013,
            active: true,
            windowId: 13,
            url: 'https://unsafe.example/private-a',
            title: 'Private navigation bounce',
          }),
          subscribeTabActivation: () => () => {},
          subscribeTabUpdate: (listener) => {
            safetyNavigationListener = listener;
            return () => {};
          },
          captureVisibleTab: async () => {
            safetyNavigationListener(7013, {
              status: 'loading',
              url: 'https://unsafe.example/private-b',
            }, { pendingUrl: 'https://unsafe.example/private-b' });
            safetyNavigationListener(7013, {
              status: 'loading',
              url: 'https://unsafe.example/private-a',
            }, { pendingUrl: 'https://unsafe.example/private-a' });
            return 'data:image/jpeg;base64,cHJpdmF0ZS1i';
          },
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
          subscribeTabActivation: () => () => {},
          subscribeTabUpdate: () => () => {},
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

        const originalFetchLiveViewIceConfiguration = fetchLiveViewIceConfiguration;
        const originalEnsureOffscreenDocument = ensureOffscreenDocument;
        const originalSendToOffscreen = sendToOffscreen;
        let releaseStaleLiveViewSetup;
        let staleLiveViewSetupStarted;
        const staleLiveViewSetupGate = new Promise((resolveGate) => {
          releaseStaleLiveViewSetup = resolveGate;
        });
        const staleLiveViewSetupReady = new Promise((resolveReady) => {
          staleLiveViewSetupStarted = resolveReady;
        });
        let staleLiveViewStartMessages = 0;
        fetchLiveViewIceConfiguration = async () => ({
          iceServers: null,
          expiresAt: null,
          legacy: true,
        });
        ensureOffscreenDocument = async () => {
          staleLiveViewSetupStarted();
          await staleLiveViewSetupGate;
        };
        sendToOffscreen = async (message) => {
          if (message?.type === 'START_SHARE') staleLiveViewStartMessages += 1;
          return { success: true };
        };
        activeLiveViewNegotiationId = 'stale-live-view-n1';
        activeLiveViewTeachingSessionId = 'teaching-session-b';
        activeLiveViewContext = liveViewContextFor(
          authB,
          activeLiveViewNegotiationId,
          activeLiveViewTeachingSessionId,
        );
        const staleLiveViewStartPromise = handleScreenShareRequest(
          'screen',
          activeLiveViewNegotiationId,
          activeLiveViewTeachingSessionId,
          new Date(Date.now() + 90_000).toISOString(),
          new Date(Date.now() + 15 * 60_000).toISOString(),
        );
        await staleLiveViewSetupReady;
        activeLiveViewNegotiationId = 'current-live-view-n2';
        activeLiveViewTeachingSessionId = 'teaching-session-b';
        activeLiveViewContext = liveViewContextFor(
          authB,
          activeLiveViewNegotiationId,
          activeLiveViewTeachingSessionId,
        );
        const currentLiveViewStartGeneration = activeLiveViewContext.startGeneration;
        releaseStaleLiveViewSetup();
        await staleLiveViewStartPromise;
        const staleLiveViewPreservedCurrent = activeLiveViewNegotiationId === 'current-live-view-n2'
          && activeLiveViewContext?.startGeneration === currentLiveViewStartGeneration;
        fetchLiveViewIceConfiguration = originalFetchLiveViewIceConfiguration;
        ensureOffscreenDocument = originalEnsureOffscreenDocument;
        sendToOffscreen = originalSendToOffscreen;

        const originalHandleScreenShareRequest = handleScreenShareRequest;
        const priorLiveViewClassroomState = currentClassroomState;
        let duplicateLiveViewStartCount = 0;
        handleScreenShareRequest = async () => {
          duplicateLiveViewStartCount += 1;
        };
        currentClassroomState = {
          ...(currentClassroomState || {}),
          teachingSessionId: 'teaching-session-b',
          supervisionContextId: null,
        };
        liveViewSeenNegotiationScope = null;
        liveViewSeenNegotiationIds = new Set();
        activeLiveViewContext = null;
        activeLiveViewNegotiationId = null;
        activeLiveViewTeachingSessionId = null;
        wsTransportIdentity = {
          connectionGeneration: wsConnectionGeneration,
          authContextId: authB.authContextId,
          serverOrigin: authB.serverOrigin,
        };
        const duplicateNegotiationFrame = {
          type: 'request-stream',
          studentId: authB.studentId,
          studentSessionId: authB.studentSessionId,
          teachingSessionId: 'teaching-session-b',
          negotiationId: 'stopped-live-view-negotiation',
          setupExpiresAt: new Date(Date.now() + 90_000).toISOString(),
          expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
          mode: 'screen',
        };
        await handleWsMessage(JSON.stringify({
          ...duplicateNegotiationFrame,
          _msgId: 'stopped-live-view-first-request',
        }), wsConnectionGeneration, authB);
        activeLiveViewContext = null;
        activeLiveViewNegotiationId = null;
        activeLiveViewTeachingSessionId = null;
        await handleWsMessage(JSON.stringify({
          ...duplicateNegotiationFrame,
          _msgId: 'stopped-live-view-delayed-duplicate',
        }), wsConnectionGeneration, authB);
        handleScreenShareRequest = originalHandleScreenShareRequest;
        currentClassroomState = priorLiveViewClassroomState;

        const originalRevokeRetiredOffscreenAuthority = revokeRetiredOffscreenAuthority;
        const reservedLoginRevocations = [];
        revokeRetiredOffscreenAuthority = (liveContext, transportIdentity) => {
          reservedLoginRevocations.push({
            liveContext: liveContext ? { ...liveContext } : null,
            transportIdentity: transportIdentity ? { ...transportIdentity } : null,
          });
        };
        activeLiveViewNegotiationId = 'retired-login-live-view';
        activeLiveViewTeachingSessionId = 'teaching-session-b';
        activeLiveViewContext = liveViewContextFor(
          authB,
          activeLiveViewNegotiationId,
          activeLiveViewTeachingSessionId,
        );
        wsTransportIdentity = {
          connectionGeneration: wsConnectionGeneration,
          authContextId: authB.authContextId,
          serverOrigin: authB.serverOrigin,
        };
        advanceStudentAuthMutationGeneration();
        const loginReservationRevokedSynchronously = reservedLoginRevocations.some((entry) => (
          entry.liveContext?.negotiationId === 'retired-login-live-view'
          && entry.liveContext?.authContextId === authB.authContextId
          && entry.transportIdentity?.authContextId === authB.authContextId
        ));
        revokeRetiredOffscreenAuthority = originalRevokeRetiredOffscreenAuthority;
        authB = installIdentity('b');
        adoptNegotiatedProtocolState({
          serverProtocolVersion: 3,
          acceptedCapabilities: allSupportedCapabilities,
        }, authB);

        await kv.remove(TAB_SNAPSHOT_STORAGE_KEY);
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
        progress('screenshot/live-view complete');
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
        observeStudentControlRevision(41, authB, 'behavior fixture control revision');
        const exactBinding = {
          bindingVersion: 2,
          schoolId: authB.schoolId,
          deviceId: authB.deviceId,
          studentId: authB.studentId,
          studentSessionId: authB.studentSessionId,
          controlRevision: 41,
        };
        const ordinaryTeacherMessageResult = await handleDurableTeacherMessage({
          type: 'teacher-message',
          commandId: 'ordinary-teacher-message-command',
          messageId: 'ordinary-teacher-message-delivery',
          studentId: authB.studentId,
          studentSessionId: authB.studentSessionId,
          teachingSessionId: 'teaching-session-b',
          sessionId: 'teaching-session-b',
          authority: {
            kind: 'teaching_session',
            teachingSessionId: 'teaching-session-b',
          },
          message: 'Capability scoping fixture',
          fromName: 'Teacher',
        });
        const ordinaryTeacherMessageInbox = await getCurrentMessageInbox();
        const ordinaryTeacherMessageAcks = await kv.get(COMMAND_ACK_OUTBOX_KEY);
        const sensitiveCommandFailure = await handleRemoteControl({
          commandId: 'sensitive-command-error-fixture',
          type: 'https://private.example/student?token=raw-secret',
          data: {},
        }, {
          studentId: authB.studentId,
          studentSessionId: authB.studentSessionId,
        });
        const sensitiveCommandFailureAcks = await kv.get(
          COMMAND_ACK_OUTBOX_KEY,
        );
        const sensitiveDiagnosticRedaction = {
          commandMessage: commandErrorMessage(new Error(
            'Student Name https://private.example/?token=raw-secret response body',
          )),
          commandCode: commandDiagnosticCode(new Error(
            'Student Name https://private.example/?token=raw-secret response body',
          )),
          sentryMessage: scrubSentryMessage(
            'Student Name https://private.example/?token=raw-secret response body',
            'Extension diagnostic',
          ),
          sentryExceptionType: safeSentryExceptionType('Student_0123456789_SensitiveError'),
          sentryBreadcrumbCategory: safeSentryBreadcrumbCategory(
            'student-0123456789-command-payload',
          ),
          sentryLevel: safeSentryLevel('student-0123456789'),
          logLabel: safeDiagnosticLabel('https://private.example/?student=raw'),
          codeShapedMessage: scrubSentryMessage('STUDENT_JOHNDOE', 'Extension diagnostic'),
          codeShapedError: safeDiagnosticError({
            code: 'DEVICE_OPAQUE_ABC123',
            name: 'StudentJohnError',
          }),
          codeShapedLabel: safeDiagnosticLabel('student_john_doe'),
        };
        const sensitiveCleanupConsole = [];
        const originalConsoleWarn = console.warn;
        try {
          console.warn = (...args) => { sensitiveCleanupConsole.push(args.join(' ')); };
          warnAuthCleanupFailure(
            '[Auth] Failed cleanup:',
            new Error('Student Name device-raw token-raw https://private.example/ command response body'),
          );
        } finally {
          console.warn = originalConsoleWarn;
        }
        let schoolPilotFrameResolve = null;
        let schoolPilotFrameCloseCount = 0;
        resolveExactTabRefs = async (refs, revision) => {
          schoolPilotFrameResolve = { refs: [...refs], revision };
          return {
            revision,
            targets: [{ tabRef: refs[0], tabId: 9411 }],
          };
        };
        closeExactTabTargets = async () => {
          schoolPilotFrameCloseCount += 1;
        };
        refreshTabCache = async () => {};
        await handleWsMessage(
          JSON.stringify(schoolPilotFrames.validExactClose),
          wsConnectionGeneration,
          authB,
        );
        const afterSchoolPilotFrame = await kv.get(COMMAND_ACK_OUTBOX_KEY);
        await handleWsMessage(
          JSON.stringify(schoolPilotFrames.staleRevisionExactClose),
          wsConnectionGeneration,
          authB,
        );
        const afterStaleSchoolPilotFrame = await kv.get(COMMAND_ACK_OUTBOX_KEY);
        const staleSchoolPilotFramePoisonedDedup = recentMsgIds.has(
          schoolPilotFrames.staleRevisionExactClose._msgId,
        );
        const closeCountBeforeConflictingFrame = schoolPilotFrameCloseCount;
        await handleWsMessage(
          JSON.stringify(schoolPilotFrames.conflictingNestedExactBinding),
          wsConnectionGeneration,
          authB,
        );
        const afterConflictingSchoolPilotFrame = await kv.get(
          COMMAND_ACK_OUTBOX_KEY,
        );
        const conflictingSchoolPilotFramePoisonedDedup = recentMsgIds.has(
          schoolPilotFrames.conflictingNestedExactBinding._msgId,
        );
        const conflictingSchoolPilotFrameCloseCount = (
          schoolPilotFrameCloseCount - closeCountBeforeConflictingFrame
        );
        const closeCountBeforePartialFrame = schoolPilotFrameCloseCount;
        await handleWsMessage(
          JSON.stringify(schoolPilotFrames.partialNestedExactBinding),
          wsConnectionGeneration,
          authB,
        );
        const afterPartialSchoolPilotFrame = await kv.get(
          COMMAND_ACK_OUTBOX_KEY,
        );
        const partialSchoolPilotFramePoisonedDedup = recentMsgIds.has(
          schoolPilotFrames.partialNestedExactBinding._msgId,
        );
        const partialSchoolPilotFrameCloseCount = (
          schoolPilotFrameCloseCount - closeCountBeforePartialFrame
        );
        const closeCountBeforeConflictingRevisionFrame = schoolPilotFrameCloseCount;
        await handleWsMessage(
          JSON.stringify(schoolPilotFrames.conflictingNestedRevisionBinding),
          wsConnectionGeneration,
          authB,
        );
        const afterConflictingRevisionSchoolPilotFrame = await kv.get(
          COMMAND_ACK_OUTBOX_KEY,
        );
        const conflictingRevisionFramePoisonedDedup = recentMsgIds.has(
          schoolPilotFrames.conflictingNestedRevisionBinding._msgId,
        );
        const conflictingRevisionFrameCloseCount = (
          schoolPilotFrameCloseCount - closeCountBeforeConflictingRevisionFrame
        );
        resolveExactTabRefs = originalResolveExactTabRefs;
        closeExactTabTargets = originalCloseExactTabTargets;
        refreshTabCache = originalRefreshTabCache;

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
        }), wsConnectionGeneration, authB);
        const afterNegativeReceipt = await kv.get(COMMAND_ACK_OUTBOX_KEY);
        await handleWsMessage(JSON.stringify({
          type: 'command-ack-receipt',
          ackId,
          commandId: 'negative-receipt-command',
          accepted: true,
        }), wsConnectionGeneration, authB);
        const afterV3AcceptedOnlyReceipt = await kv.get(
          COMMAND_ACK_OUTBOX_KEY,
        );
        await handleWsMessage(JSON.stringify({
          type: 'command-ack-receipt',
          ackId,
          commandId: 'wrong-command',
          accepted: true,
          disposition: 'applied',
          retryable: false,
        }), wsConnectionGeneration, authB);
        const afterWrongReceipt = await kv.get(COMMAND_ACK_OUTBOX_KEY);
        await handleWsMessage(JSON.stringify({
          type: 'command-ack-receipt',
          ackId,
          commandId: 'negative-receipt-command',
          accepted: true,
          disposition: 'applied',
          retryable: false,
        }), wsConnectionGeneration, authB);
        const afterPositiveReceipt = await kv.get(COMMAND_ACK_OUTBOX_KEY);

        await sendCommandAck('terminal-receipt-command', 'completed', {
          authContext: authB,
          binding: exactStudentBinding(exactBinding),
          commandType: 'open-tab',
          outcome: 'applied',
        });
        const terminalAckId = 'terminal-receipt-command:completed';
        await handleWsMessage(JSON.stringify({
          type: 'command-ack-receipt',
          ackId: terminalAckId,
          commandId: 'terminal-receipt-command',
          accepted: false,
          disposition: 'terminal_rejected',
          retryable: true,
          code: 'COMMAND_ACK_TARGET_GONE',
        }), wsConnectionGeneration, authB);
        const afterRetryableTerminalReceipt = await kv.get(COMMAND_ACK_OUTBOX_KEY);
        await handleWsMessage(JSON.stringify({
          type: 'command-ack-receipt',
          ackId: terminalAckId,
          commandId: 'terminal-receipt-command',
          accepted: false,
          disposition: 'terminal_rejected',
          retryable: false,
          code: 'COMMAND_ACK_TARGET_GONE',
        }), wsConnectionGeneration, authB);
        const afterTerminalReceipt = await kv.get(COMMAND_ACK_OUTBOX_KEY);

        adoptNegotiatedProtocolState({
          serverProtocolVersion: 2,
          acceptedCapabilities: [],
        }, authB);
        await sendCommandAck('legacy-receipt-command', 'completed', {
          authContext: authB,
          binding: {
            studentId: authB.studentId,
            studentSessionId: authB.studentSessionId,
          },
          commandType: 'teacher-message',
          outcome: 'applied',
        });
        const legacyReceiptAckId = 'legacy-receipt-command:completed';
        await handleWsMessage(JSON.stringify({
          type: 'command-ack-receipt',
          ackId: legacyReceiptAckId,
          accepted: true,
        }), wsConnectionGeneration, authB);
        const afterLegacyReceiptMissingCommandId = await kv.get(
          COMMAND_ACK_OUTBOX_KEY,
        );
        await handleWsMessage(JSON.stringify({
          type: 'command-ack-receipt',
          ackId: legacyReceiptAckId,
          commandId: 'legacy-receipt-command',
          accepted: true,
        }), wsConnectionGeneration, authB);
        const afterLegacyReceiptMatched = await kv.get(COMMAND_ACK_OUTBOX_KEY);
        adoptNegotiatedProtocolState({
          serverProtocolVersion: 3,
          acceptedCapabilities: allSupportedCapabilities,
        }, authB);

        await discardCommandAckOutbox();
        await sendCommandAck('http-idempotent-command', 'completed', {
          authContext: authB,
          binding: {
            studentId: authB.studentId,
            studentSessionId: authB.studentSessionId,
          },
          commandType: 'teacher-message',
          outcome: 'applied',
        });
        let httpAckRequest = null;
        fetchWithBackoff = async (url, init = {}) => {
          httpAckRequest = {
            url: String(url),
            body: JSON.parse(String(init.body || '{}')),
          };
          // A later classroom revision is not an authentication transition.
          // The server-applied ACK captured at revision 41 must still drain
          // even if a later display/FAB snapshot changes during the await.
          currentFabState = {
            ...(currentFabState || {}),
            ownershipRevision: 42,
            ownershipRevisionKnown: true,
          };
          return new Response(JSON.stringify({
            receipts: [{
              ackId: 'http-idempotent-command:completed',
              commandId: 'http-idempotent-command',
              accepted: true,
              disposition: 'idempotent',
              retryable: false,
              code: 'COMMAND_ACK_ALREADY_APPLIED',
            }],
          }), { status: 200, headers: { 'content-type': 'application/json' } });
        };
        await flushCommandAckOutbox({ forceHttp: true });
        const afterHttpAckReceipt = await kv.get(COMMAND_ACK_OUTBOX_KEY);
        const commandAckRetentionBase = Date.now();
        const commandAckRetentionBinding = monitoringEventAuthBindingForContext(authB);
        await durableLocalKv.set({
          [COMMAND_ACK_BINDING_KEY]: commandAckRetentionBinding,
          [COMMAND_ACK_OUTBOX_KEY]: [normalizeCommandAckForStorage({
            ackId: 'retention-command:completed',
            commandId: 'retention-command',
            ackState: 'completed',
            commandType: 'open-tab',
            bindingVersion: 2,
            authContextId: authB.authContextId,
            schoolId: authB.schoolId,
            deviceId: authB.deviceId,
            studentId: authB.studentId,
            studentSessionId: authB.studentSessionId,
            studentControlRevision: 41,
            result: { url: 'https://private.example/?token=must-expire' },
            state: { responseBody: 'must-expire' },
          }, commandAckRetentionBase)],
        });
        Date.now = () => commandAckRetentionBase + COMMAND_ACK_MAX_AGE_MS + 1;
        try {
          await flushCommandAckOutbox({ forceHttp: true });
        } finally {
          Date.now = originalDateNow;
        }
        const afterCommandAckRetentionExpiry = await kv.get([
          COMMAND_ACK_OUTBOX_KEY,
          COMMAND_ACK_BINDING_KEY,
        ]);
        progress('commands and ack receipts complete');

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
        const afterValidBoundFrame = await kv.get(COMMAND_ACK_OUTBOX_KEY);

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

        const safeNotifyBeforeMessageRace = safeNotify;
        const broadcastBeforeMessageRace = broadcastToAllTabsForAuth;
        let teacherMessageRaceNotifications = 0;
        let teacherMessageRaceBroadcasts = 0;
        const runTeacherMessageStorageRace = async ({ durable }) => {
          const kind = durable ? 'durable' : 'legacy';
          await kv.set({
            [MESSAGE_INBOX_STORAGE_KEY]: [],
            [MESSAGE_INBOX_DEDUP_KEY]: [],
          });
          await kv.remove(MESSAGE_INBOX_BINDING_KEY);
          if (durable) await discardCommandAckOutbox();
          const authAForMessage = installIdentity(`teacher-message-${kind}-a`);
          // The fixture installs an exact matching FAB teaching session. Do
          // not let an unrelated classroom snapshot from an earlier scenario
          // override that session and silently bypass the intended write
          // pause below.
          currentClassroomState = null;
          if (durable) {
            adoptNegotiatedProtocolState({
              serverProtocolVersion: 3,
              acceptedCapabilities: ['scopedAuthorityChecksV1', 'exactBindingAckV2'],
            }, authAForMessage);
            observeStudentControlRevision(55, authAForMessage, `${kind} message revision`);
          }
          const messageId = `teacher-message-${kind}-race-delivery`;
          const commandId = durable ? 'teacher-message-durable-race-command' : null;
          const sourceMessage = {
            type: durable ? 'teacher-message' : 'chat',
            _msgId: messageId,
            messageId,
            ...(commandId ? { commandId } : {}),
            studentId: authAForMessage.studentId,
            studentSessionId: authAForMessage.studentSessionId,
            teachingSessionId: `teaching-session-teacher-message-${kind}-a`,
            sessionId: `teaching-session-teacher-message-${kind}-a`,
            authority: {
              kind: 'teaching_session',
              teachingSessionId: `teaching-session-teacher-message-${kind}-a`,
            },
            message: `Private ${kind} message that must not cross identity`,
            fromName: 'Private Teacher',
          };
          let releaseStorageWrite;
          let storageWriteStarted;
          const storageWriteGate = new Promise((resolveGate) => {
            releaseStorageWrite = resolveGate;
          });
          const storageWriteReady = new Promise((resolveReady) => {
            storageWriteStarted = resolveReady;
          });
          let paused = false;
          kv.set = async (value) => {
            const writesTargetMessage = Array.isArray(value?.[MESSAGE_INBOX_STORAGE_KEY])
              && value[MESSAGE_INBOX_STORAGE_KEY].some((entry) => entry?.id === messageId);
            if (writesTargetMessage && !paused) {
              paused = true;
              await originalKvSet(value);
              storageWriteStarted();
              await storageWriteGate;
              return;
            }
            return originalKvSet(value);
          };
          const pending = (durable
            ? handleDurableTeacherMessage(sourceMessage, { authContext: authAForMessage })
            : handleChatMessage(sourceMessage, { authContext: authAForMessage })
          ).then(
            () => 'completed',
            (error) => error?.code || 'error',
          );
          await Promise.race([
            storageWriteReady,
            new Promise((_, rejectReady) => setTimeout(() => {
              rejectReady(new Error(`${kind} teacher-message storage pause was not reached`));
            }, 2_000)),
          ]);
          installIdentity(`teacher-message-${kind}-b`);
          releaseStorageWrite();
          const outcome = await pending;
          kv.set = originalKvSet;
          const stored = await kv.get([
            MESSAGE_INBOX_STORAGE_KEY,
            MESSAGE_INBOX_BINDING_KEY,
            COMMAND_ACK_OUTBOX_KEY,
          ]);
          return {
            outcome,
            messageId,
            commandId,
            messages: stored[MESSAGE_INBOX_STORAGE_KEY] || [],
            commandAcks: stored[COMMAND_ACK_OUTBOX_KEY] || [],
          };
        };
        safeNotify = async () => { teacherMessageRaceNotifications += 1; };
        broadcastToAllTabsForAuth = async () => { teacherMessageRaceBroadcasts += 1; };
        const legacyTeacherMessageStorageRace = await runTeacherMessageStorageRace({ durable: false });
        const durableTeacherMessageStorageRace = await runTeacherMessageStorageRace({ durable: true });
        progress('teacher storage races complete');
        safeNotify = safeNotifyBeforeMessageRace;
        broadcastToAllTabsForAuth = broadcastBeforeMessageRace;
        kv.set = originalKvSet;

        const persistedWorkerRestartNotificationId = 'classpilot-message-auth-retired-worker-restart';
        await safeNotify({
          notificationId: persistedWorkerRestartNotificationId,
          title: 'ClassPilot',
          message: 'Retired-context notification fixture',
        });
        // Simulate MV3 suspension losing all in-memory notification tracking.
        activeAuthBoundNotificationIds.clear();
        const notificationsBeforeWorkerRestartCleanup = await readAllNotificationsBounded();
        await clearAllAuthBoundTeacherMessageNotifications();
        const notificationsAfterWorkerRestartCleanup = await readAllNotificationsBounded();
        progress('worker restart notification cleanup complete');

        const clearNotificationBeforeRace = clearAuthBoundNotification;
        const visibleAuthNotifications = new Set();
        let releaseNotificationCreate;
        let notificationCreateStarted;
        const notificationCreateGate = new Promise((resolveGate) => {
          releaseNotificationCreate = resolveGate;
        });
        const notificationCreateReady = new Promise((resolveReady) => {
          notificationCreateStarted = resolveReady;
        });
        const notificationAuthA = installIdentity('teacher-notification-race-a');
        const notificationSource = {
          type: 'chat',
          studentId: notificationAuthA.studentId,
          studentSessionId: notificationAuthA.studentSessionId,
          sessionId: 'teaching-session-teacher-notification-race-a',
        };
        safeNotify = async (options) => {
          visibleAuthNotifications.add(options.notificationId);
          notificationCreateStarted();
          await notificationCreateGate;
        };
        clearAuthBoundNotification = async (notificationId) => (
          visibleAuthNotifications.delete(notificationId)
        );
        const notificationRacePromise = notifyTeacherMessageForAuth({
          title: 'Private Teacher',
          message: 'Private message',
        }, notificationAuthA, notificationSource, 'notification-race-message').then(
          () => 'completed',
          (error) => error?.code || 'error',
        );
        await notificationCreateReady;
        installIdentity('teacher-notification-race-b');
        releaseNotificationCreate();
        const notificationRaceOutcome = await notificationRacePromise;
        safeNotify = safeNotifyBeforeMessageRace;
        clearAuthBoundNotification = clearNotificationBeforeRace;

        let releaseTabDispatch;
        let tabDispatchStarted;
        const tabDispatchGate = new Promise((resolveGate) => { releaseTabDispatch = resolveGate; });
        const tabDispatchReady = new Promise((resolveReady) => { tabDispatchStarted = resolveReady; });
        const tabDispatchAuthA = installIdentity('teacher-tab-race-a');
        const tabDispatchSource = {
          type: 'chat',
          studentId: tabDispatchAuthA.studentId,
          studentSessionId: tabDispatchAuthA.studentSessionId,
          sessionId: 'teaching-session-teacher-tab-race-a',
        };
        let acceptedStaleTabMessages = 0;
        const tabDispatchPromise = broadcastToAllTabsForAuth(
          'show-message',
          { id: 'tab-race-message', message: 'Private message' },
          tabDispatchAuthA,
          tabDispatchSource,
          {
            queryTabs: async () => [{ id: 9601, url: 'https://student.example/' }],
            sendMessage: async (_tabId, payload) => {
              tabDispatchStarted();
              await tabDispatchGate;
              if (studentMessageContextIsCurrent(payload.studentMessageContext)) {
                acceptedStaleTabMessages += 1;
              }
            },
            executeScript: async () => {},
          },
        ).then(
          () => 'completed',
          (error) => error?.code || 'error',
        );
        await tabDispatchReady;
        installIdentity('teacher-tab-race-b');
        releaseTabDispatch();
        const tabDispatchRaceOutcome = await tabDispatchPromise;
        progress('teacher notification/tab races complete');

        const notificationInventoryTimeoutRejected = await reconcileAuthBoundTeacherMessageNotifications({
          readInventory: async () => ({ ok: false, notifications: {} }),
        });
        let failedClearReadCount = 0;
        const notificationClearFailureRejected = await reconcileAuthBoundTeacherMessageNotifications({
          readInventory: async () => {
            failedClearReadCount += 1;
            return {
              ok: true,
              notifications: { 'classpilot-message-retired-a': {} },
            };
          },
          clearNotification: async () => ({ ok: false, cleared: false }),
        });
        let verifiedClearReadCount = 0;
        const notificationClearFailureVerifiedAbsent = await reconcileAuthBoundTeacherMessageNotifications({
          readInventory: async () => {
            verifiedClearReadCount += 1;
            return {
              ok: true,
              notifications: verifiedClearReadCount === 1
                ? { 'classpilot-message-retired-a': {} }
                : {},
            };
          },
          clearNotification: async () => ({ ok: false, cleared: false }),
        });

        const originalNotificationReconciler = reconcileAuthBoundTeacherMessageNotifications;
        const notificationFailPrivateAuth = installIdentity('teacher-notification-inventory-failure');
        const notificationFailPrivateSource = {
          type: 'ping',
          studentId: notificationFailPrivateAuth.studentId,
          studentSessionId: notificationFailPrivateAuth.studentSessionId,
        };
        let failPrivateNotificationCreates = 0;
        authBoundNotificationInventoryReconciled = false;
        authBoundNotificationCleanupInFlight = null;
        authBoundNotificationCleanupRetryAt = 0;
        authBoundNotificationCleanupPromise = Promise.resolve(false);
        reconcileAuthBoundTeacherMessageNotifications = async () => false;
        safeNotify = async () => { failPrivateNotificationCreates += 1; };
        const notificationInventoryFailureOutcome = await notifyTeacherMessageForAuth({
          title: 'Private Teacher',
          message: 'Must remain private',
        }, notificationFailPrivateAuth, notificationFailPrivateSource, 'inventory-failure').then(
          () => 'completed',
          (error) => error?.code || 'error',
        );
        reconcileAuthBoundTeacherMessageNotifications = originalNotificationReconciler;
        safeNotify = safeNotifyBeforeMessageRace;
        authBoundNotificationInventoryReconciled = true;
        authBoundNotificationCleanupInFlight = null;
        authBoundNotificationCleanupRetryAt = 0;
        authBoundNotificationCleanupPromise = Promise.resolve(true);

        const forcedCleanupAuth = installIdentity('teacher-notification-late-create-a');
        const forcedCleanupSource = {
          type: 'ping',
          studentId: forcedCleanupAuth.studentId,
          studentSessionId: forcedCleanupAuth.studentSessionId,
        };
        const forcedCleanupVisibleIds = new Set();
        let releaseLateNotificationCreate;
        let lateNotificationCreateStarted;
        const lateNotificationCreateGate = new Promise((resolveGate) => {
          releaseLateNotificationCreate = resolveGate;
        });
        const lateNotificationCreateReady = new Promise((resolveReady) => {
          lateNotificationCreateStarted = resolveReady;
        });
        let releaseInitialInventoryPass;
        let initialInventoryPassStarted;
        const initialInventoryPassGate = new Promise((resolveGate) => {
          releaseInitialInventoryPass = resolveGate;
        });
        const initialInventoryPassReady = new Promise((resolveReady) => {
          initialInventoryPassStarted = resolveReady;
        });
        let exactClearFailureObserved;
        const exactClearFailureReady = new Promise((resolveReady) => {
          exactClearFailureObserved = resolveReady;
        });
        let forcedCleanupReconcileCalls = 0;
        reconcileAuthBoundTeacherMessageNotifications = async () => {
          forcedCleanupReconcileCalls += 1;
          if (forcedCleanupReconcileCalls === 1) {
            initialInventoryPassStarted();
            await initialInventoryPassGate;
            return true;
          }
          forcedCleanupVisibleIds.clear();
          return true;
        };
        safeNotify = async (options) => {
          lateNotificationCreateStarted();
          await lateNotificationCreateGate;
          forcedCleanupVisibleIds.add(options.notificationId);
        };
        clearAuthBoundNotification = async () => {
          exactClearFailureObserved();
          return false;
        };
        authBoundNotificationInventoryReconciled = true;
        authBoundNotificationCleanupInFlight = null;
        authBoundNotificationCleanupRetryAt = 0;
        authBoundNotificationCleanupPromise = Promise.resolve(true);
        const forcedCleanupRacePromise = notifyTeacherMessageForAuth({
          title: 'Private Teacher',
          message: 'Late retired notification',
        }, forcedCleanupAuth, forcedCleanupSource, 'late-create').then(
          () => 'completed',
          (error) => error?.code || 'error',
        );
        await lateNotificationCreateReady;
        installIdentity('teacher-notification-late-create-b');
        await initialInventoryPassReady;
        releaseLateNotificationCreate();
        await exactClearFailureReady;
        releaseInitialInventoryPass();
        const forcedCleanupRaceOutcome = await forcedCleanupRacePromise;
        reconcileAuthBoundTeacherMessageNotifications = originalNotificationReconciler;
        safeNotify = safeNotifyBeforeMessageRace;
        clearAuthBoundNotification = clearNotificationBeforeRace;
        authBoundNotificationInventoryReconciled = true;
        authBoundNotificationCleanupInFlight = null;
        authBoundNotificationCleanupRetryAt = 0;
        authBoundNotificationCleanupPromise = Promise.resolve(true);

        const pingNotificationIds = new Set();
        let releasePingNotification;
        let pingNotificationStarted;
        const pingNotificationGate = new Promise((resolveGate) => {
          releasePingNotification = resolveGate;
        });
        const pingNotificationReady = new Promise((resolveReady) => {
          pingNotificationStarted = resolveReady;
        });
        const pingAuthA = installIdentity('teacher-ping-race-a');
        currentClassroomState = null;
        safeNotify = async (options) => {
          pingNotificationIds.add(options.notificationId);
          pingNotificationStarted();
          await pingNotificationGate;
        };
        clearAuthBoundNotification = async (notificationId) => (
          pingNotificationIds.delete(notificationId)
        );
        const pingRacePromise = handleWsMessage(JSON.stringify({
          type: 'ping',
          _msgId: 'teacher-ping-race-message',
          studentId: pingAuthA.studentId,
          studentSessionId: pingAuthA.studentSessionId,
          data: { message: 'Private attention request' },
        }), wsConnectionGeneration, pingAuthA).then(
          () => 'completed',
          (error) => error?.code || 'error',
        );
        await pingNotificationReady;
        installIdentity('teacher-ping-race-b');
        releasePingNotification();
        const pingNotificationRaceOutcome = await pingRacePromise;
        safeNotify = safeNotifyBeforeMessageRace;
        clearAuthBoundNotification = clearNotificationBeforeRace;

        let releaseChatCloseDispatch;
        let chatCloseDispatchStarted;
        const chatCloseDispatchGate = new Promise((resolveGate) => {
          releaseChatCloseDispatch = resolveGate;
        });
        const chatCloseDispatchReady = new Promise((resolveReady) => {
          chatCloseDispatchStarted = resolveReady;
        });
        const chatCloseAuthA = installIdentity('teacher-chat-close-race-a');
        currentClassroomState = null;
        let acceptedStaleChatCloseMessages = 0;
        broadcastToAllTabsForAuth = async (messageType, messageData, context, sourceMessage) => (
          broadcastBeforeMessageRace(messageType, messageData, context, sourceMessage, {
            queryTabs: async () => [{ id: 9701, url: 'https://student.example/' }],
            sendMessage: async (_tabId, payload) => {
              chatCloseDispatchStarted();
              await chatCloseDispatchGate;
              if (studentMessageContextIsCurrent(payload.studentMessageContext)) {
                acceptedStaleChatCloseMessages += 1;
              }
            },
            executeScript: async () => {},
          })
        );
        const chatCloseMessageId = 'teacher-chat-close-race-message';
        const chatCloseRacePromise = handleWsMessage(JSON.stringify({
          type: 'chat-closed',
          _msgId: chatCloseMessageId,
          studentId: chatCloseAuthA.studentId,
          studentSessionId: chatCloseAuthA.studentSessionId,
          sessionId: 'teaching-session-teacher-chat-close-race-a',
        }), wsConnectionGeneration, chatCloseAuthA).then(
          () => 'completed',
          (error) => error?.code || 'error',
        );
        await chatCloseDispatchReady;
        installIdentity('teacher-chat-close-race-b');
        releaseChatCloseDispatch();
        const chatCloseRaceOutcome = await chatCloseRacePromise;
        broadcastToAllTabsForAuth = broadcastBeforeMessageRace;
        const chatCloseRacePoisonedDedup = recentMsgIds.has(chatCloseMessageId);

        const raceStorageKey = '__classpilotAuthContextRaceProbe';
        await kv.remove(raceStorageKey);
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
        const persistedRaceProbe = await kv.get(raceStorageKey);
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
        let directoryProbeCalls = 0;
        readManagedDirectoryDeviceIdWithRetry = async () => {
          directoryProbeCalls += 1;
          return 'raw-directory-device-id-must-not-leak';
        };
        progress('forced auth races complete');
        const kioskCapabilityOffRequests = [];
        const kioskCapabilityOffUrl = await requestKioskLaunchUrl({
          fetchImpl: async (url, init = {}) => {
            kioskCapabilityOffRequests.push({
              url: String(url),
              body: JSON.parse(String(init.body || '{}')),
            });
            return new Response(JSON.stringify({
              serverProtocolVersion: 3,
              acceptedCapabilities: [],
            }), { status: 200, headers: { 'content-type': 'application/json' } });
          },
        });
        const kioskProtocol2SpoofRequests = [];
        const kioskProtocol2SpoofUrl = await requestKioskLaunchUrl({
          fetchImpl: async (url, init = {}) => {
            kioskProtocol2SpoofRequests.push({
              url: String(url),
              body: JSON.parse(String(init.body || '{}')),
            });
            return new Response(JSON.stringify({
              serverProtocolVersion: 2,
              acceptedCapabilities: [
                'scopedAuthorityChecksV1',
                'kioskLaunchTicketV2',
              ],
            }), { status: 200, headers: { 'content-type': 'application/json' } });
          },
        });
        const requestKioskTicketWithExpiry = async (ticket, expiryOffsetMs) => {
          const requests = [];
          const url = await requestKioskLaunchUrl({
            fetchImpl: async (requestUrl, init = {}) => {
              requests.push({
                url: String(requestUrl),
                headers: { ...init.headers },
                body: JSON.parse(String(init.body || '{}')),
              });
              if (String(requestUrl).endsWith('/preflight')) {
                return new Response(JSON.stringify({
                  serverProtocolVersion: 3,
                  acceptedCapabilities: [
                    'scopedAuthorityChecksV1',
                    'kioskLaunchTicketV2',
                  ],
                }), { status: 200, headers: { 'content-type': 'application/json' } });
              }
              return new Response(JSON.stringify({
                ticket,
                expiresAt: new Date(Date.now() + expiryOffsetMs).toISOString(),
                serverProtocolVersion: 3,
                acceptedCapabilities: [
                  'scopedAuthorityChecksV1',
                  'kioskLaunchTicketV2',
                ],
              }), { status: 201, headers: { 'content-type': 'application/json' } });
            },
          });
          return { url, requests };
        };
        const kioskNearTenMinuteAttempt = await requestKioskTicketWithExpiry(
          'one-use-ticket',
          600_000,
        );
        const kioskAfterMinuteAttempt = await requestKioskTicketWithExpiry(
          'after-minute-ticket',
          61_000,
        );
        const kioskOverBoundAttempt = await requestKioskTicketWithExpiry(
          'over-bound-ticket',
          661_000,
        );
        const kioskExpiredAttempt = await requestKioskTicketWithExpiry(
          'expired-ticket',
          -1_000,
        );
        const kioskUrl = kioskNearTenMinuteAttempt.url;
        const kioskRequests = kioskNearTenMinuteAttempt.requests;
        progress('kiosk ticket cases complete');

        return {
          firstSend,
          afterResponseLoss,
          afterReceipt,
          retiredSessionInitialSend,
          retiredSessionReplayTransmissions,
          afterRetiredSessionFlush,
          afterChatRetentionExpiry,
          legacyChatResult,
          afterLegacyChat,
          transmissions,
          replayCalls,
          afterIdentityChange,
          adoptedAuthRevisionRaceBinding,
          cleanAuthOrdinaryCommandExecutions,
          cleanAuthOrdinaryCommandResult,
          cleanAuthOrdinaryCommandAcks,
          cleanAuthOrdinaryCommandAckAttempts,
          authRevisionRaceWatermark,
          authRevisionRaceCloseCount,
          authRevisionRaceAcks,
          generatedSchoolPilotFrameResolve,
          generatedSchoolPilotFrameCloseCount,
          generatedSchoolPilotFrameAckAttempts,
          generatedSchoolPilotFrameAcks,
          exactTabAckAfterRevisionChange,
          exactTabAckAfterRevisionChangeOutbox,
          generatedControlRevisionWatermark,
          generatedControlRevisionCloseCount,
          generatedControlRevisionAcks,
          generatedCloseAllResult,
          closeAllRemovedTabIds,
          generatedCloseAllAcks,
          malformedLeaseAllowed,
          validLeaseAllowed,
          staleLeaseAllowed,
          legacyPolicyAllowedBeforeLeaseUpgrade,
          capableMissingPolicyApplied,
          capableMissingPolicyAllowed,
          delayedHeartbeatPolicyApplied,
          delayedHeartbeatPolicyAllowed,
          missingPolicyPreserved,
          missingPolicyPreservedAllowed,
          malformedPolicyApplied,
          malformedPolicyAllowed,
          supersededHeartbeatPolicyApplied,
          supersededHeartbeatPolicyAllowed,
          newerHeartbeatDeniedPolicyApplied,
          delayedWsAllowedPolicyApplied,
          delayedWsAllowedPolicyAllowed,
          delayedDeniedPolicyApplied,
          delayedDeniedPolicyAllowed,
          delayedMalformedPolicyApplied,
          delayedMalformedPolicyAllowed,
          explicitDeniedPolicyApplied,
          explicitDeniedPolicyAllowed,
          omittedPolicyExpiredRetention,
          omittedPolicyNewScopeRetention,
          activeViewCadence,
          invalidIntervalCadence,
          wrongAuthorityCadence,
          unnegotiatedCadence,
          leaseImmediateCaptureRequests,
          generationBeforeContinuousRenewal,
          generationAfterContinuousRenewal,
          leaseRenewalCaptureCalls,
          leaseRenewalUploads,
          leaseRenewalCaptureResult,
          supersededPolicyCaptureResult,
          policyGenerationCaptureCalls,
          policyGenerationUploads,
          unrelatedCommandBindingAccepted,
          allSupportedCapabilitiesAccepted,
          individuallyAcceptedCapabilities,
          unmarkedScopedCapabilitiesRejected,
          nullRevisionCommandExecutions,
          nullRevisionCommandResult,
          nullRevisionCommandOutbox,
          ambientUpload,
          staleUploadNewerAllowWasActive,
          staleUploadDenialResult,
          staleUploadDenialRevokedNewerAllow,
          heartbeatRequiredCaptureResult,
          heartbeatRequiredLeaseRetained,
          pausedUnobservedCaptureResult,
          pausedUnobservedLeaseRevoked,
          captureAfterPausedUnobservedResult,
          pausedUnobservedUploadAttempts,
          authorizationDeniedCaptureResult,
          authorizationDeniedLeaseRevoked,
          captureAfterAuthorizationDeniedResult,
          authorizationDeniedUploadAttempts,
          screenshotAuthorityHeartbeatReasons,
          screenshotServiceUnavailableResult,
          serviceUnavailableLeaseRetained,
          rapidCadenceCombinedUploadCount,
          rapidCadenceUploadOptions,
          rapidCadenceMinGaps,
          rapid503FetchAttempts,
          rapid429FetchAttempts,
          stringIntervalCadence,
          stringExpiryCadence,
          cadenceIdentityPreserved,
          cadenceRenewalPreservedInterval,
          authorityChangeTickCaptures,
          staleAuthorityTickIgnored,
          authorityChangeStoppedCadence,
          heartbeatOmissionRetainedPermission,
          heartbeatOmissionDowngradedCadence,
          uploadOmissionRetainedPermission,
          uploadOmissionDowngradedCadence,
          malformedCadenceRetainedPermission,
          malformedCadenceDowngraded,
          authorityChangeRapidUploadAttempts,
          leaseStartCaptureOnActivation,
          leaseStartSuppressedOnRenewal,
          leaseStartBypassedAuthorityChange,
          screenshotLicenseDeniedResult,
          screenshotLicenseDenials,
          screenshotLicenseExpectedScope,
          ambientActivationRaceResult,
          ambientActivationRaceUploads,
          ambientNavigationRaceResult,
          ambientNavigationRaceUploads,
          ambientNavigationBounceResult,
          ambientNavigationBounceUploads,
          safetyResult,
          safetyUpload,
          safetyActivationRaceResult,
          safetyActivationRaceUploads,
          safetyNavigationRaceResult,
          safetyNavigationRaceUploads,
          safetyNavigationBounceResult,
          safetyNavigationBounceUploads,
          safetyRaceResult,
          safetyRaceUploads,
          offHoursSafetyResult,
          closeRaceCode,
          safetyCloseOrder,
          safetyCloseResult,
          iceConfiguration,
          staleLiveViewStartMessages,
          staleLiveViewPreservedCurrent,
          duplicateLiveViewStartCount,
          loginReservationRevokedSynchronously,
          snapshotWrites,
          heartbeatCalls,
          healthyRecoveryRuns,
          steadyCadenceCalls,
          staleRecoveryRan,
          cadenceCallsWithRecovery,
          liveViewTelemetryRequest,
          afterNegativeReceipt,
          afterV3AcceptedOnlyReceipt,
          afterWrongReceipt,
          afterPositiveReceipt,
          afterRetryableTerminalReceipt,
          afterTerminalReceipt,
          afterLegacyReceiptMissingCommandId,
          afterLegacyReceiptMatched,
          httpAckRequest,
          afterHttpAckReceipt,
          afterCommandAckRetentionExpiry,
          ordinaryTeacherMessageResult,
          ordinaryTeacherMessageInbox,
          ordinaryTeacherMessageAcks,
          sensitiveCommandFailure,
          sensitiveCommandFailureAcks,
          sensitiveDiagnosticRedaction,
          sensitiveCleanupConsole,
          schoolPilotFrameResolve,
          schoolPilotFrameCloseCount,
          afterSchoolPilotFrame,
          afterStaleSchoolPilotFrame,
          staleSchoolPilotFramePoisonedDedup,
          afterConflictingSchoolPilotFrame,
          conflictingSchoolPilotFramePoisonedDedup,
          conflictingSchoolPilotFrameCloseCount,
          afterPartialSchoolPilotFrame,
          partialSchoolPilotFramePoisonedDedup,
          partialSchoolPilotFrameCloseCount,
          afterConflictingRevisionSchoolPilotFrame,
          conflictingRevisionFramePoisonedDedup,
          conflictingRevisionFrameCloseCount,
          nPlusOneWatermark,
          nPlusOneCloseCount,
          nPlusOneAcks,
          staleFramePoisonedDedup,
          validFrameReachedDedup,
          afterValidBoundFrame,
          staleOpenOutcome,
          staleOpenedTabRemoved,
          staleOpenQueriedTabs,
          legacyTeacherMessageStorageRace,
          durableTeacherMessageStorageRace,
          teacherMessageRaceNotifications,
          teacherMessageRaceBroadcasts,
          workerRestartNotificationWasPresent: Object.prototype.hasOwnProperty.call(
            notificationsBeforeWorkerRestartCleanup.notifications,
            persistedWorkerRestartNotificationId,
          ),
          workerRestartNotificationRemains: Object.prototype.hasOwnProperty.call(
            notificationsAfterWorkerRestartCleanup.notifications,
            persistedWorkerRestartNotificationId,
          ),
          notificationRaceOutcome,
          visibleAuthNotificationCount: visibleAuthNotifications.size,
          tabDispatchRaceOutcome,
          acceptedStaleTabMessages,
          notificationInventoryTimeoutRejected,
          notificationClearFailureRejected,
          notificationClearFailureVerifiedAbsent,
          failedClearReadCount,
          verifiedClearReadCount,
          notificationInventoryFailureOutcome,
          failPrivateNotificationCreates,
          forcedCleanupRaceOutcome,
          forcedCleanupReconcileCalls,
          forcedCleanupVisibleNotificationCount: forcedCleanupVisibleIds.size,
          pingNotificationRaceOutcome,
          visiblePingNotificationCount: pingNotificationIds.size,
          chatCloseRaceOutcome,
          acceptedStaleChatCloseMessages,
          chatCloseRacePoisonedDedup,
          authContextRace,
          kioskUrl,
          kioskCapabilityOffUrl,
          kioskCapabilityOffRequests,
          kioskProtocol2SpoofUrl,
          kioskProtocol2SpoofRequests,
          kioskRequests,
          kioskAfterMinuteAttempt,
          kioskOverBoundAttempt,
          kioskExpiredAttempt,
          directoryProbeCalls,
          foregroundReconciliation,
          createdTabLimitReconciliation,
          createdTabPolicyRace,
        };
      } finally {
        fetchWithBackoff = originalFetchWithBackoff;
        sendHeartbeat = originalSendHeartbeat;
        kv.set = originalKvSet;
        captureSafetyEvidence = originalCaptureSafetyEvidence;
        resolveExactTabRefs = originalResolveExactTabRefs;
        closeExactTabTargets = originalCloseExactTabTargets;
        refreshTabCache = originalRefreshTabCache;
        readManagedDirectoryDeviceIdWithRetry = originalReadManagedDirectoryDeviceIdWithRetry;
        enqueueCommandAck = originalEnqueueCommandAck;
        heartbeatInFlight = false;
        scheduleHeartbeat(null);
      }
    }, {
      raceIterations: AUTH_CONTEXT_RACE_ITERATIONS,
      debugProgress: DEBUG_BEHAVIOR_PROGRESS,
      schoolPilotFrames: schoolPilotCommandFrames,
      generatedSchoolPilotFixture: schoolPilotGeneratedExactTabFixture,
      authRevisionRace: authRevisionRaceFixture,
      controlRevisionFrames: schoolPilotControlRevisionFrames,
      generatedCloseAllFixture: schoolPilotCloseAllFixture,
    });

    assert.equal(result.firstSend.success, true);
    assert.deepEqual(result.foregroundReconciliation.focused, {
      fallbackCreates: 0,
      foregroundTabId: 9201,
      focusedWindowIds: [92],
      targetFocusFailures: 0,
    });
    assert.deepEqual(result.foregroundReconciliation.disappeared, {
      fallbackCreates: 1,
      foregroundTabId: 9301,
      focusedWindowIds: [92, 93],
      targetFocusFailures: 1,
    });
    assert.deepEqual(result.createdTabLimitReconciliation.calls, [{
      authContextId: result.createdTabLimitReconciliation.expectedAuthContextId,
      lockedDomain: 'ixl.com',
      tabLimit: 1,
    }]);
    assert.equal(result.createdTabPolicyRace.readsWhileClassroomBlocked, 0);
    assert.equal(result.createdTabPolicyRace.serializedGetCalls, 1);
    assert.equal(result.createdTabPolicyRace.raceRecordCallsBeforeControl, 0);
    assert.equal(result.createdTabPolicyRace.revalidationIterations, 100);
    assert.ok(result.createdTabPolicyRace.revalidationReadCounts.every((count) => count === 3));
    assert.equal(result.createdTabPolicyRace.stableControlReadCount, 3);
    assert.equal(result.createdTabPolicyRace.sourceTransitionReadCount, 3);
    assert.deepEqual(result.createdTabPolicyRace.finalInventoryCases, {
      preservedDisappeared: {
        readCount: 3,
        inventoryCount: 3,
        removals: [],
        recordSources: [],
      },
      limitRaised: {
        readCount: 3,
        inventoryCount: 3,
        removals: [],
        recordSources: [],
      },
      stableOverLimit: {
        readCount: 3,
        inventoryCount: 3,
        removals: [9831],
        recordSources: ['tab_limit'],
      },
    });
    assert.equal(result.createdTabPolicyRace.raceRecordCalls, 3);
    assert.deepEqual(result.createdTabPolicyRace.raceRecordSources, [
      'screen_lock',
      'tab_limit',
      'tab_limit',
    ]);
    assert.deepEqual(result.createdTabPolicyRace.raceRemovals, [
      result.createdTabPolicyRace.stableControlId,
      result.createdTabPolicyRace.sourceTransitionId,
      9831,
    ]);
    assert.deepEqual(result.createdTabPolicyRace.schoolPolicyLimitSerialization, {
      schoolEnteredWhileCreatedHeld: false,
      createdRemovalIds: [9841],
      schoolCrossRemovalIds: [],
      finalTabIds: [9840],
    });
    assert.equal(result.firstSend.queued, true);
    assert.equal(result.afterResponseLoss.studentChatOutboxV1.length, 1);
    assert.equal(result.afterResponseLoss.studentChatOutboxV1[0].clientMessageId,
      '11111111-1111-4111-8111-111111111111');
    assert.equal(result.afterReceipt.studentChatOutboxV1.length, 0);
    assert.equal(result.retiredSessionInitialSend.queued, true);
    assert.equal(result.retiredSessionReplayTransmissions, 0);
    assert.equal(result.afterRetiredSessionFlush.studentChatOutboxV1.length, 0);
    assert.deepEqual(result.afterChatRetentionExpiry.studentChatOutboxV1, []);
    assert.equal(result.afterChatRetentionExpiry.studentChatOutboxAuthBindingV1, undefined);
    assert.equal(result.legacyChatResult.success, true);
    assert.equal(result.legacyChatResult.legacy, true);
    assert.equal(result.legacyChatResult.queued, false);
    assert.equal(result.afterLegacyChat.studentChatOutboxV1.length, 0);
    assert.deepEqual(result.generatedSchoolPilotFrameResolve, {
      refs: ['tab-ref-a'],
      revision: 44,
    });
    assert.equal(result.generatedSchoolPilotFrameCloseCount, 1);
    assert.deepEqual(result.generatedSchoolPilotFrameAckAttempts.map((ack) => ({
      ackState: ack.ackState,
      bindingVersion: ack.bindingVersion,
      schoolId: ack.schoolId,
      deviceId: ack.deviceId,
      studentId: ack.studentId,
      studentSessionId: ack.studentSessionId,
      studentControlRevision: ack.studentControlRevision,
    })), [
      {
        ackState: 'received',
        bindingVersion: 2,
        schoolId: 'school-a',
        deviceId: 'device-a',
        studentId: 'student-a',
        studentSessionId: 'student-session-a',
        studentControlRevision: 12,
      },
      {
        ackState: 'completed',
        bindingVersion: 2,
        schoolId: 'school-a',
        deviceId: 'device-a',
        studentId: 'student-a',
        studentSessionId: 'student-session-a',
        studentControlRevision: 12,
      },
    ]);
    assert.ok(result.generatedSchoolPilotFrameAcks.commandAckOutboxV1.some((ack) =>
      ack.commandId === 'command-a'
      && ack.ackState === 'completed'
      && ack.schoolId === 'school-a'
      && ack.deviceId === 'device-a'
      && ack.studentId === 'student-a'
      && ack.studentSessionId === 'student-session-a'
      && ack.studentControlRevision === 12));
    assert.equal(result.exactTabAckAfterRevisionChange, true);
    assert.ok(result.exactTabAckAfterRevisionChangeOutbox.commandAckOutboxV1.some((ack) =>
      ack.commandId === 'exact-tab-applied-before-revision-change'
      && ack.ackState === 'completed'
      && ack.studentControlRevision === 12));
    assert.equal(result.generatedControlRevisionWatermark, 42);
    assert.equal(result.generatedControlRevisionCloseCount, 1);
    assert.ok(result.generatedControlRevisionAcks.commandAckOutboxV1.some((ack) => (
      ack.commandId === 'generated-control-revision-close'
      && ack.ackState === 'completed'
      && ack.studentControlRevision === 42
    )));
    assert.equal(result.generatedCloseAllResult.closeAll, true);
    assert.deepEqual(result.closeAllRemovedTabIds, [9501, 9502]);
    assert.ok(result.generatedCloseAllAcks.commandAckOutboxV1.some((ack) => (
      ack.commandId === 'command-close-all'
      && ack.ackState === 'completed'
      && ack.bindingVersion === 2
      && ack.studentControlRevision === 42
    )));
    assert.equal(result.transmissions[0].body.clientMessageId, result.transmissions[1].body.clientMessageId);
    assert.equal(result.replayCalls, 0);
    assert.deepEqual(result.afterIdentityChange.studentChatOutboxV1, []);
    assert.equal(result.afterIdentityChange.studentChatOutboxAuthBindingV1, undefined);
    assert.deepEqual(result.adoptedAuthRevisionRaceBinding, {
      bindingVersion: 2,
      schoolId: 'school-b',
      deviceId: 'device-b',
      studentId: 'student-b',
      studentSessionId: 'student-session-b',
      controlRevision: 42,
    });
    assert.equal(result.cleanAuthOrdinaryCommandExecutions, 1);
    assert.equal(
      result.cleanAuthOrdinaryCommandResult.openedUrl,
      'https://ordinary-command.example/',
    );
    assert.deepEqual(result.cleanAuthOrdinaryCommandAckAttempts, [
      { ackState: 'received', studentControlRevision: 42 },
      { ackState: 'completed', studentControlRevision: 42 },
    ]);
    assert.ok(result.cleanAuthOrdinaryCommandAcks.commandAckOutboxV1.some((ack) => (
      ack.commandId === 'clean-auth-ordinary-command'
      && ack.ackState === 'completed'
      && ack.studentControlRevision === 42
    )));
    assert.equal(result.authRevisionRaceWatermark, 42);
    assert.equal(result.authRevisionRaceCloseCount, 1);
    assert.ok(result.authRevisionRaceAcks.commandAckOutboxV1.some((ack) => (
      ack.commandId === 'auth-revision-race-exact-close'
      && ack.ackState === 'completed'
      && ack.studentControlRevision === 42
    )));
    assert.equal(result.malformedLeaseAllowed, false);
    assert.equal(result.validLeaseAllowed, true);
    assert.equal(result.staleLeaseAllowed, false);
    assert.equal(result.legacyPolicyAllowedBeforeLeaseUpgrade, true);
    assert.equal(result.capableMissingPolicyApplied, true);
    assert.equal(result.capableMissingPolicyAllowed, false);
    assert.equal(result.delayedHeartbeatPolicyApplied, true);
    assert.equal(result.delayedHeartbeatPolicyAllowed, true);
    assert.equal(result.missingPolicyPreserved, true);
    assert.equal(result.missingPolicyPreservedAllowed, true);
    assert.equal(result.malformedPolicyApplied, true);
    assert.equal(result.malformedPolicyAllowed, false);
    assert.equal(result.supersededHeartbeatPolicyApplied, false);
    assert.equal(result.supersededHeartbeatPolicyAllowed, false);
    assert.equal(result.newerHeartbeatDeniedPolicyApplied, true);
    assert.equal(result.delayedWsAllowedPolicyApplied, false);
    assert.equal(result.delayedWsAllowedPolicyAllowed, false);
    assert.equal(result.delayedDeniedPolicyApplied, false);
    assert.equal(result.delayedDeniedPolicyAllowed, true);
    assert.equal(result.delayedMalformedPolicyApplied, false);
    assert.equal(result.delayedMalformedPolicyAllowed, true);
    assert.equal(result.explicitDeniedPolicyApplied, true);
    assert.equal(result.explicitDeniedPolicyAllowed, false);
    assert.equal(result.omittedPolicyExpiredRetention, false);
    assert.equal(result.omittedPolicyNewScopeRetention, false);
    assert.equal(result.activeViewCadence.mode, 'active_view');
    assert.equal(result.activeViewCadence.intervalSeconds, 5);
    assert.equal(result.activeViewCadence.expiresAt > 0, true);
    assert.deepEqual(result.invalidIntervalCadence, {
      mode: 'background',
      intervalSeconds: 30,
      expiresAt: 0,
    });
    assert.deepEqual(result.stringIntervalCadence, {
      mode: 'background',
      intervalSeconds: 30,
      expiresAt: 0,
    });
    assert.deepEqual(result.stringExpiryCadence, {
      mode: 'background',
      intervalSeconds: 30,
      expiresAt: 0,
    });
    assert.deepEqual(result.wrongAuthorityCadence, {
      mode: 'background',
      intervalSeconds: 30,
      expiresAt: 0,
    });
    assert.deepEqual(result.unnegotiatedCadence, {
      mode: 'background',
      intervalSeconds: 30,
      expiresAt: 0,
    });
    assert.equal(result.cadenceIdentityPreserved, true);
    assert.equal(result.cadenceRenewalPreservedInterval, true);
    assert.equal(result.authorityChangeTickCaptures, 1);
    assert.equal(result.staleAuthorityTickIgnored, true);
    assert.equal(result.authorityChangeStoppedCadence, true);
    assert.equal(result.heartbeatOmissionRetainedPermission, true);
    assert.equal(result.heartbeatOmissionDowngradedCadence, true);
    assert.equal(result.uploadOmissionRetainedPermission, true);
    assert.equal(result.uploadOmissionDowngradedCadence, true);
    assert.equal(result.malformedCadenceRetainedPermission, true);
    assert.equal(result.malformedCadenceDowngraded, true);
    assert.equal(result.authorityChangeRapidUploadAttempts, 1);
    assert.equal(result.leaseStartCaptureOnActivation, true);
    assert.equal(result.leaseStartSuppressedOnRenewal, true);
    assert.equal(result.leaseStartBypassedAuthorityChange, true);
    assert.equal(result.leaseImmediateCaptureRequests >= 3, true);
    assert.equal(
      result.generationAfterContinuousRenewal,
      result.generationBeforeContinuousRenewal,
    );
    assert.equal(result.leaseRenewalCaptureCalls, 1);
    assert.equal(result.leaseRenewalUploads, 1);
    assert.equal(result.leaseRenewalCaptureResult, undefined);
    assert.deepEqual(result.supersededPolicyCaptureResult, {
      status: 'paused_unobserved',
    });
    assert.equal(result.policyGenerationCaptureCalls, 2);
    assert.equal(result.policyGenerationUploads.length, 1);
    assert.equal(
      result.policyGenerationUploads[0].screenshot,
      'data:image/jpeg;base64,bGVhc2UtdHdv',
    );
    assert.equal(result.unrelatedCommandBindingAccepted, true);
    assert.equal(result.allSupportedCapabilitiesAccepted, true);
    assert.equal(result.individuallyAcceptedCapabilities.length, 10);
    assert.equal(result.individuallyAcceptedCapabilities.every((entry) => entry.accepted), true);
    assert.equal(result.unmarkedScopedCapabilitiesRejected, true);
    assert.equal(result.nullRevisionCommandExecutions, 1);
    assert.deepEqual(result.nullRevisionCommandResult, { executed: true });
    assert.equal(result.nullRevisionCommandOutbox.commandAckOutboxV1.some((ack) =>
      ack.commandId === 'null-revision-exact-ack-command'), false);
    assert.equal(result.ordinaryTeacherMessageResult.deduplicated, false);
    assert.ok(result.ordinaryTeacherMessageInbox.some((message) =>
      message.id === 'ordinary-teacher-message-delivery'));
    assert.ok(result.ordinaryTeacherMessageAcks.commandAckOutboxV1.some((ack) =>
      ack.commandId === 'ordinary-teacher-message-command'
      && ack.ackState === 'completed'
      && ack.bindingVersion === 2
      && ack.schoolId === 'school-b'
      && ack.deviceId === 'device-b'
      && ack.studentId === 'student-b'
      && ack.studentSessionId === 'student-session-b'
      && ack.studentControlRevision === 41));
    assert.deepEqual(result.sensitiveCommandFailure, {
      rejected: true,
      error: 'Command could not be completed.',
    });
    const sanitizedFailureAck = result.sensitiveCommandFailureAcks.commandAckOutboxV1.find((ack) =>
      ack.commandId === 'sensitive-command-error-fixture' && ack.ackState === 'failed');
    assert.equal(sanitizedFailureAck.error, 'Command could not be completed.');
    assert.equal(sanitizedFailureAck.errorCode, 'COMMAND_FAILED');
    assert.equal(JSON.stringify(sanitizedFailureAck).includes('private.example'), false);
    assert.deepEqual(result.sensitiveDiagnosticRedaction, {
      commandMessage: 'Command could not be completed.',
      commandCode: 'COMMAND_FAILED',
      sentryMessage: 'Extension diagnostic',
      sentryExceptionType: 'Error',
      sentryBreadcrumbCategory: 'extension',
      sentryLevel: undefined,
      logLabel: 'unknown',
      codeShapedMessage: 'Extension diagnostic',
      codeShapedError: 'Error',
      codeShapedLabel: 'unknown',
    });
    assert.deepEqual(result.sensitiveCleanupConsole, ['[Auth] Failed cleanup: Error']);
    assert.equal(result.ambientUpload.url.endsWith('/api/classpilot/device/screenshot'), true);
    assert.equal(result.ambientUpload.body.clientProtocolVersion, 3);
    assert.equal(result.staleUploadNewerAllowWasActive, true);
    assert.deepEqual(result.staleUploadDenialResult, {
      status: 'paused_unobserved',
    });
    assert.equal(result.staleUploadDenialRevokedNewerAllow, true);
    assert.deepEqual(result.heartbeatRequiredCaptureResult, {
      status: 'retrying',
      reason: 'heartbeat_required',
    });
    assert.equal(result.heartbeatRequiredLeaseRetained, true);
    assert.deepEqual(result.pausedUnobservedCaptureResult, {
      status: 'paused_unobserved',
    });
    assert.equal(result.pausedUnobservedLeaseRevoked, true);
    assert.deepEqual(result.captureAfterPausedUnobservedResult, {
      status: 'paused_unobserved',
    });
    assert.equal(result.pausedUnobservedUploadAttempts, 1);
    assert.deepEqual(result.authorizationDeniedCaptureResult, {
      status: 'paused_unobserved',
      reason: 'authorization_denied',
    });
    assert.equal(result.authorizationDeniedLeaseRevoked, true);
    assert.deepEqual(result.captureAfterAuthorizationDeniedResult, {
      status: 'paused_unobserved',
    });
    assert.equal(result.authorizationDeniedUploadAttempts, 1);
    assert.deepEqual(result.screenshotAuthorityHeartbeatReasons, [
      'screenshot-capability-heartbeat-required',
      'screenshot-paused-unobserved',
      'screenshot-authorization-denied',
      'screenshot-policy-refresh',
    ]);
    assert.deepEqual(result.screenshotServiceUnavailableResult, {
      status: 'unavailable',
      reason: 'service_unavailable',
    });
    assert.equal(result.serviceUnavailableLeaseRetained, true);
    assert.equal(result.rapidCadenceCombinedUploadCount, 2);
    assert.deepEqual(result.rapidCadenceUploadOptions, [
      { maxAttempts: 1 },
      { maxAttempts: 1 },
    ]);
    assert.deepEqual(result.rapidCadenceMinGaps, {
      navigation: 4_500,
      tick: 4_500,
    });
    assert.equal(result.rapid503FetchAttempts, 1);
    assert.equal(result.rapid429FetchAttempts, 1);
    assert.deepEqual(result.screenshotLicenseDeniedResult, {
      status: 'paused_unobserved',
      reason: 'license_denied',
    });
    assert.deepEqual(result.screenshotLicenseDenials, [{
      planStatus: 'screenshot-payment-required',
      scope: result.screenshotLicenseExpectedScope,
    }]);
    assert.deepEqual(result.ambientActivationRaceResult, {
      status: 'unavailable',
      reason: 'active_tab_changed',
    });
    assert.equal(result.ambientActivationRaceUploads, 0);
    assert.deepEqual(result.ambientNavigationRaceResult, {
      status: 'unavailable',
      reason: 'active_tab_changed',
    });
    assert.equal(result.ambientNavigationRaceUploads, 0);
    assert.deepEqual(result.ambientNavigationBounceResult, {
      status: 'unavailable',
      reason: 'active_tab_changed',
    });
    assert.equal(result.ambientNavigationBounceUploads, 0);
    assert.equal(result.safetyResult.status, 'available');
    assert.equal(result.safetyUpload.url.endsWith('/api/classpilot/device/screenshot'), true);
    assert.equal(result.safetyUpload.body.captureKind, 'safety_evidence');
    assert.equal(result.safetyUpload.body.clientProtocolVersion, 3);
    assert.equal(result.safetyUpload.body.tabRef, 'tab_exact_1');
    assert.deepEqual(result.safetyActivationRaceResult, {
      status: 'unavailable',
      reason: 'active_tab_changed',
    });
    assert.equal(result.safetyActivationRaceUploads, 0);
    assert.deepEqual(result.safetyNavigationRaceResult, {
      status: 'unavailable',
      reason: 'active_tab_changed',
    });
    assert.equal(result.safetyNavigationRaceUploads, 0);
    assert.deepEqual(result.safetyNavigationBounceResult, {
      status: 'unavailable',
      reason: 'active_tab_changed',
    });
    assert.equal(result.safetyNavigationBounceUploads, 0);
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
    assert.equal(result.staleLiveViewStartMessages, 0);
    assert.equal(result.staleLiveViewPreservedCurrent, true);
    assert.equal(result.duplicateLiveViewStartCount, 1);
    assert.equal(result.loginReservationRevokedSynchronously, true);
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
    assert.ok(result.afterV3AcceptedOnlyReceipt.commandAckOutboxV1.some((ack) =>
      ack.ackId === 'negative-receipt-command:completed'));
    assert.ok(result.afterWrongReceipt.commandAckOutboxV1.some((ack) =>
      ack.ackId === 'negative-receipt-command:completed'));
    assert.equal(result.afterPositiveReceipt.commandAckOutboxV1.some((ack) =>
      ack.ackId === 'negative-receipt-command:completed'), false);
    assert.ok(result.afterRetryableTerminalReceipt.commandAckOutboxV1.some((ack) =>
      ack.ackId === 'terminal-receipt-command:completed'));
    assert.equal(result.afterTerminalReceipt.commandAckOutboxV1.some((ack) =>
      ack.ackId === 'terminal-receipt-command:completed'), false);
    assert.ok(result.afterLegacyReceiptMissingCommandId.commandAckOutboxV1.some((ack) =>
      ack.commandId === 'legacy-receipt-command'));
    assert.equal(result.afterLegacyReceiptMatched.commandAckOutboxV1.some((ack) =>
      ack.commandId === 'legacy-receipt-command'), false);
    assert.equal(
      result.httpAckRequest.url.endsWith('/api/classpilot/device/command-acks'),
      true,
    );
    assert.deepEqual(result.httpAckRequest.body.acks.map((ack) => ({
      ackId: ack.ackId,
      commandId: ack.commandId,
      bindingVersion: ack.bindingVersion,
      schoolId: ack.schoolId,
      deviceId: ack.deviceId,
      studentId: ack.studentId,
      studentSessionId: ack.studentSessionId,
      studentControlRevision: ack.studentControlRevision,
    })), [{
      ackId: 'http-idempotent-command:completed',
      commandId: 'http-idempotent-command',
      bindingVersion: 2,
      schoolId: 'school-b',
      deviceId: 'device-b',
      studentId: 'student-b',
      studentSessionId: 'student-session-b',
      studentControlRevision: 41,
    }]);
    assert.deepEqual(result.afterHttpAckReceipt.commandAckOutboxV1, []);
    assert.deepEqual(result.afterCommandAckRetentionExpiry.commandAckOutboxV1, []);
    assert.equal(result.afterCommandAckRetentionExpiry.commandAckOutboxAuthBindingV1, undefined);
    assert.deepEqual(result.schoolPilotFrameResolve, {
      refs: ['schoolpilot_tab_ref_1'],
      revision: 23,
    });
    assert.equal(result.schoolPilotFrameCloseCount, 1);
    assert.ok(result.afterSchoolPilotFrame.commandAckOutboxV1.some((ack) =>
      ack.commandId === 'schoolpilot-v3-exact-close-command'
      && ack.ackState === 'completed'));
    assert.equal(result.afterStaleSchoolPilotFrame.commandAckOutboxV1.some((ack) =>
      ack.commandId === 'schoolpilot-v3-exact-close-stale-command'), false);
    assert.equal(result.staleSchoolPilotFramePoisonedDedup, false);
    assert.equal(result.conflictingSchoolPilotFramePoisonedDedup, false);
    assert.equal(result.conflictingSchoolPilotFrameCloseCount, 0);
    assert.equal(result.afterConflictingSchoolPilotFrame.commandAckOutboxV1.some((ack) =>
      ack.commandId === 'schoolpilot-v3-exact-close-conflicting-binding-command'), false);
    assert.equal(result.partialSchoolPilotFramePoisonedDedup, false);
    assert.equal(result.partialSchoolPilotFrameCloseCount, 0);
    assert.equal(result.afterPartialSchoolPilotFrame.commandAckOutboxV1.some((ack) =>
      ack.commandId === 'schoolpilot-v3-exact-close-partial-binding-command'), false);
    assert.equal(result.conflictingRevisionFramePoisonedDedup, false);
    assert.equal(result.conflictingRevisionFrameCloseCount, 0);
    assert.equal(result.nPlusOneWatermark, 43);
    assert.equal(result.nPlusOneCloseCount, 1);
    assert.ok(result.nPlusOneAcks.commandAckOutboxV1.some((ack) => (
      ack.commandId === 'same-session-n-plus-one-close'
      && ack.ackState === 'completed'
      && ack.studentControlRevision === 43
    )));
    assert.equal(result.afterConflictingRevisionSchoolPilotFrame.commandAckOutboxV1.some((ack) =>
      ack.commandId === 'schoolpilot-v3-exact-close-conflicting-revision-command'), false);
    assert.equal(result.staleFramePoisonedDedup, false);
    assert.equal(result.validFrameReachedDedup, true);
    assert.ok(result.afterValidBoundFrame.commandAckOutboxV1.some((ack) =>
      ack.commandId === 'binding-before-dedup-command' && ack.ackState === 'expired'));
    assert.equal(result.staleOpenOutcome, 'AUTH_CONTEXT_SUPERSEDED');
    assert.equal(result.staleOpenedTabRemoved, true);
    assert.equal(result.staleOpenQueriedTabs, false);
    assert.equal(result.legacyTeacherMessageStorageRace.outcome, 'AUTH_CONTEXT_SUPERSEDED');
    assert.equal(result.durableTeacherMessageStorageRace.outcome, 'AUTH_CONTEXT_SUPERSEDED');
    assert.equal(result.legacyTeacherMessageStorageRace.messages.some((message) => (
      message.id === result.legacyTeacherMessageStorageRace.messageId
    )), false);
    assert.equal(result.durableTeacherMessageStorageRace.messages.some((message) => (
      message.id === result.durableTeacherMessageStorageRace.messageId
    )), false);
    assert.equal(result.durableTeacherMessageStorageRace.commandAcks.some((ack) => (
      ack.commandId === result.durableTeacherMessageStorageRace.commandId
    )), false);
    assert.equal(result.teacherMessageRaceNotifications, 0);
    assert.equal(result.teacherMessageRaceBroadcasts, 0);
    assert.equal(result.workerRestartNotificationWasPresent, true);
    assert.equal(result.workerRestartNotificationRemains, false);
    assert.equal(result.notificationRaceOutcome, 'AUTH_CONTEXT_SUPERSEDED');
    assert.equal(result.visibleAuthNotificationCount, 0);
    assert.equal(result.tabDispatchRaceOutcome, 'AUTH_CONTEXT_SUPERSEDED');
    assert.equal(result.acceptedStaleTabMessages, 0);
    assert.equal(result.notificationInventoryTimeoutRejected, false);
    assert.equal(result.notificationClearFailureRejected, false);
    assert.equal(result.notificationClearFailureVerifiedAbsent, true);
    assert.equal(result.failedClearReadCount, 2);
    assert.equal(result.verifiedClearReadCount, 2);
    assert.equal(
      result.notificationInventoryFailureOutcome,
      'AUTH_BOUND_NOTIFICATION_UNVERIFIED',
    );
    assert.equal(result.failPrivateNotificationCreates, 0);
    assert.equal(result.forcedCleanupRaceOutcome, 'AUTH_CONTEXT_SUPERSEDED');
    // The identity transition starts one cleanup pass, and the failed exact
    // clear must queue a fresh verification pass behind it.
    assert.equal(result.forcedCleanupReconcileCalls, 3);
    assert.equal(result.forcedCleanupVisibleNotificationCount, 0);
    assert.equal(result.pingNotificationRaceOutcome, 'completed');
    assert.equal(result.visiblePingNotificationCount, 0);
    assert.equal(result.chatCloseRaceOutcome, 'completed');
    assert.equal(result.acceptedStaleChatCloseMessages, 0);
    assert.equal(result.chatCloseRacePoisonedDedup, false);
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
    assert.equal(new URL(result.kioskCapabilityOffUrl).hash, '');
    assert.equal(result.kioskCapabilityOffRequests.length, 1);
    assert.equal(
      result.kioskCapabilityOffRequests[0].url.endsWith('/api/classpilot/kiosk/launch-ticket/preflight'),
      true,
    );
    assert.equal(
      JSON.stringify(result.kioskCapabilityOffRequests).includes('raw-directory-device-id-must-not-leak'),
      false,
    );
    assert.equal(new URL(result.kioskProtocol2SpoofUrl).hash, '');
    assert.equal(result.kioskProtocol2SpoofRequests.length, 1);
    assert.equal(
      JSON.stringify(result.kioskProtocol2SpoofRequests).includes('raw-directory-device-id-must-not-leak'),
      false,
    );
    assert.equal(result.directoryProbeCalls, 4);
    assert.equal(result.kioskRequests.length, 2);
    assert.equal(
      result.kioskRequests[0].url.endsWith('/api/classpilot/kiosk/launch-ticket/preflight'),
      true,
    );
    assert.deepEqual(result.kioskRequests[0].body, {
      clientProtocolVersion: 3,
      capabilities: ['scopedAuthorityChecksV1', 'kioskLaunchTicketV2'],
    });
    assert.equal(
      JSON.stringify(result.kioskRequests[0]).includes('raw-directory-device-id-must-not-leak'),
      false,
    );
    assert.deepEqual(result.kioskRequests[1].body, {
      directoryDeviceId: 'raw-directory-device-id-must-not-leak',
      clientProtocolVersion: 3,
      capabilities: ['scopedAuthorityChecksV1', 'kioskLaunchTicketV2'],
    });
    assert.equal(result.kioskRequests[1].headers['X-School-Id'], 'school-kiosk');
    assert.equal(new URL(result.kioskAfterMinuteAttempt.url).hash, '#launchTicket=after-minute-ticket');
    assert.equal(result.kioskAfterMinuteAttempt.requests.length, 2);
    assert.equal(new URL(result.kioskOverBoundAttempt.url).hash, '');
    assert.equal(result.kioskOverBoundAttempt.requests.length, 2);
    assert.equal(new URL(result.kioskExpiredAttempt.url).hash, '');
    assert.equal(result.kioskExpiredAttempt.requests.length, 2);

    const contentMessageEpochRace = await openContentMessageRaceFixture(context, worker);
    assert.deepEqual(contentMessageEpochRace.clearBeforeCallbackResponse, {
      success: false,
      ignored: true,
    });
    assert.equal(contentMessageEpochRace.clearBeforeCallbackModalCount, 0);
    assert.deepEqual(contentMessageEpochRace.callbackBeforeClearResponse, { success: true });
    assert.equal(contentMessageEpochRace.callbackBeforeClearModalCount, 1);
    assert.equal(contentMessageEpochRace.callbackBeforeClearFinalModalCount, 0);

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
