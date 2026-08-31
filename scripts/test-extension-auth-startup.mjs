import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..');
const sourceExtensionPath = String(process.env.CLASSPILOT_EXTENSION_PATH || '').trim()
  ? resolve(process.env.CLASSPILOT_EXTENSION_PATH)
  : resolve(repoRoot, 'extension');
const GATE_SELECTOR = '#classpilot-auth-gate';
const LOADING_LIMIT_MS = 2_000;
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

function json(response, status, body) {
  response.writeHead(status, {
    'access-control-allow-origin': '*',
    'content-type': 'application/json; charset=utf-8',
  });
  response.end(JSON.stringify(body));
}

async function startFixtureServer() {
  const state = {
    loginConfigRequests: 0,
    rosterRequests: 0,
    rosterDelayMs: 0,
    rosterStatus: 200,
    rosterDisconnect: false,
    rosterStallBody: false,
    rosterRawBody: null,
    rosterAuthorizations: [],
    studentLoginRequests: [],
    studentLoginAuthorizations: [],
    sessionReleaseRequests: 0,
    sessionReleaseStatus: 204,
    schoolStatusRequests: 0,
    schoolStatusStatus: 200,
    schoolStatusDelayMs: 0,
    schoolStatusStallBody: false,
    schoolStatusRawBody: null,
    schoolStatusBody: { success: true, schoolActive: true, planStatus: 'active' },
    heartbeatRequests: 0,
    extensionSettingsRequests: 0,
    configDelayMs: 5_500,
    configStatus: 200,
    configDisconnect: false,
    configStallBody: false,
    configRawBody: null,
    phishingFrameRequests: 0,
    phishingInputEvents: 0,
    configBody: {
      sharedSignInEnabled: true,
      loginMethod: 'name_pin',
      schoolId: 'cold-start-school',
      passpilotKioskAvailable: true,
    },
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url || '/', 'http://fixture.invalid');
    if (url.pathname === '/api/extension/login-config') {
      state.loginConfigRequests += 1;
      setTimeout(() => {
        if (state.configDisconnect) {
          request.socket.destroy();
          return;
        }
        if (state.configStallBody) {
          response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          response.flushHeaders();
          setTimeout(() => response.destroy(), 10_000).unref?.();
          return;
        }
        if (state.configRawBody !== null) {
          response.writeHead(state.configStatus, {
            'access-control-allow-origin': '*',
            'content-type': 'application/json; charset=utf-8',
          });
          response.end(state.configRawBody);
          return;
        }
        json(response, state.configStatus, state.configBody);
      }, state.configDelayMs);
      return;
    }
    if (url.pathname === '/api/extension/login-roster') {
      state.rosterRequests += 1;
      state.rosterAuthorizations.push(request.headers.authorization || null);
      setTimeout(() => {
        if (state.rosterDisconnect) {
          request.socket.destroy();
          return;
        }
        if (state.rosterStallBody) {
          response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          response.flushHeaders();
          setTimeout(() => response.destroy(), 10_000).unref?.();
          return;
        }
        if (state.rosterRawBody !== null) {
          response.writeHead(state.rosterStatus, {
            'access-control-allow-origin': '*',
            'content-type': 'application/json; charset=utf-8',
          });
          response.end(state.rosterRawBody);
          return;
        }
        json(response, state.rosterStatus, state.rosterStatus === 200 ? {
          loginMethod: 'name_pin',
          grades: [{ value: '5', label: 'Grade 5' }],
          students: [{
            id: 'student-1',
            name: 'Jordan Student',
            gradeLevel: '5',
            hasPin: true,
            reclaimable: String(request.headers.authorization || '').startsWith('ClassPilot-Recovery '),
          }],
        } : { error: `roster_${state.rosterStatus}` });
      }, state.rosterDelayMs);
      return;
    }
    if (url.pathname === '/api/extension/student-login') {
      const chunks = [];
      request.on('data', (chunk) => chunks.push(chunk));
      request.on('end', () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        state.studentLoginRequests.push(JSON.parse(rawBody || '{}'));
        state.studentLoginAuthorizations.push(request.headers.authorization || null);
        json(response, 200, {
          studentToken: 'fixture-token',
          studentSessionId: 'fixture-session',
          sessionRecovery: { token: 'R'.repeat(43) },
          schoolId: 'cold-start-school',
          student: { id: 'student-1', firstName: 'Jordan', lastName: 'Student', email: 'jordan@example.edu' },
          classroomState: null,
        });
      });
      return;
    }
    if (url.pathname === '/api/extension/session-release') {
      state.sessionReleaseRequests += 1;
      response.writeHead(state.sessionReleaseStatus, {
        'access-control-allow-origin': '*',
      });
      response.end();
      return;
    }
    if (url.pathname === '/api/school/status') {
      state.schoolStatusRequests += 1;
      setTimeout(() => {
        if (state.schoolStatusStallBody) {
          response.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
          response.flushHeaders();
          setTimeout(() => response.destroy(), 10_000).unref?.();
          return;
        }
        if (state.schoolStatusRawBody !== null) {
          response.writeHead(state.schoolStatusStatus, {
            'access-control-allow-origin': '*',
            'content-type': 'application/json; charset=utf-8',
          });
          response.end(state.schoolStatusRawBody);
          return;
        }
        json(response, state.schoolStatusStatus, state.schoolStatusBody);
      }, state.schoolStatusDelayMs);
      return;
    }
    if (url.pathname === '/api/device/heartbeat') {
      state.heartbeatRequests += 1;
      json(response, 200, {
        success: true,
        studentId: 'student-1',
        studentSessionId: 'fixture-session',
        schoolId: 'cold-start-school',
        serverProtocolVersion: 3,
        acceptedCapabilities: [
          'scopedAuthorityChecksV1',
          'screenshotTrackingWindowLeaseV1',
          'screenshotObservationLeaseV1',
        ],
        screenshotPolicy: {
          mode: 'tracking_window_lease',
          captureAllowed: true,
          expiresInSeconds: 90,
          serverTime: new Date().toISOString(),
          authority: { kind: 'student_session', controlRevision: 0 },
        },
      });
      return;
    }
    if (url.pathname === '/api/extension/settings') {
      state.extensionSettingsRequests += 1;
      json(response, 200, {
        studentId: 'student-1',
        studentSessionId: 'fixture-session',
        schoolId: 'cold-start-school',
        enableTrackingHours: false,
        afterHoursMode: 'full',
        trackingStartTime: '00:00',
        trackingEndTime: '23:59',
        trackingDays: ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
        schoolTimezone: 'America/New_York',
      });
      return;
    }
    if (url.pathname === '/phishing-observed') {
      state.phishingInputEvents += 1;
      response.writeHead(204, { 'access-control-allow-origin': '*' });
      response.end();
      return;
    }
    if (url.pathname === '/phishing-frame') {
      state.phishingFrameRequests += 1;
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.end(`<!doctype html><html><body style="margin:0">
        <input id="hostile-phishing-input" autofocus style="position:fixed;inset:0;width:100%;height:100%">
        <script>
          const report = () => fetch('/phishing-observed', { method: 'POST', keepalive: true }).catch(() => {});
          for (const type of ['click', 'keydown', 'beforeinput', 'input']) {
            window.addEventListener(type, report, { capture: true });
          }
          window.parent.postMessage({
            type: 'CLASSPILOT_AUTH_FRAME_READY',
            nonce: '${'0'.repeat(64)}',
          }, '*');
        </script></body></html>`);
      return;
    }
    if (url.pathname === '/parser-held-auth-attack') {
      response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      response.write(`<!doctype html><html><head><meta name="viewport" content="width=device-width"></head>
        <body style="margin:0"><button id="page-control">Underlying page</button>
        <script>
          window.__underlyingInput = { clicks: 0, keys: 0, wheels: 0, touches: 0 };
          window.__underlyingControlInput = { clicks: 0, keys: 0, wheels: 0, touches: 0 };
          window.__underlyingEventLog = [];
          window.__parserHeldDialogEvents = { clicks: 0, keys: 0, inputs: 0 };
          for (const type of ['click', 'keydown', 'wheel', 'touchstart']) {
            window.addEventListener(type, (event) => {
              if (type === 'click') window.__underlyingInput.clicks += 1;
              if (type === 'keydown') window.__underlyingInput.keys += 1;
              if (type === 'wheel') window.__underlyingInput.wheels += 1;
              if (type === 'touchstart') window.__underlyingInput.touches += 1;
              window.__underlyingEventLog.push({ type, target: event.target?.id || event.target?.tagName || null });
            }, { capture: true });
          }
          const control = document.getElementById('page-control');
          control.addEventListener('click', () => window.__underlyingControlInput.clicks += 1);
          control.addEventListener('keydown', () => window.__underlyingControlInput.keys += 1);
          control.addEventListener('wheel', () => window.__underlyingControlInput.wheels += 1);
          control.addEventListener('touchstart', () => window.__underlyingControlInput.touches += 1);
          window.__parserHeldAttack = { attempted: false, dialogSupported: false, dialogOpened: false };
          const attackAfterBootstrap = () => {
            const gate = document.getElementById('classpilot-auth-gate');
            if (!gate) {
              requestAnimationFrame(attackAfterBootstrap);
              return;
            }
            gate.remove();
            const hostileFrame = document.createElement('iframe');
            hostileFrame.id = 'parser-held-hostile-frame';
            hostileFrame.src = '/phishing-frame?parser-held=1';
            hostileFrame.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;border:0;z-index:2147483647';
            window.__parserHeldHostileFrameRef = hostileFrame;
            const dialog = document.createElement('dialog');
            dialog.id = 'parser-held-hostile-dialog';
            dialog.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;padding:0;border:0;z-index:2147483647';
            const hostileInput = document.createElement('input');
            hostileInput.id = 'parser-held-hostile-input';
            hostileInput.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
            hostileInput.addEventListener('click', () => window.__parserHeldDialogEvents.clicks += 1);
            hostileInput.addEventListener('keydown', () => window.__parserHeldDialogEvents.keys += 1);
            hostileInput.addEventListener('input', () => window.__parserHeldDialogEvents.inputs += 1);
            dialog.appendChild(hostileInput);
            const hostileSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
            hostileSvg.id = 'parser-held-hostile-svg';
            hostileSvg.setAttribute('width', '100%');
            hostileSvg.setAttribute('height', '100%');
            hostileSvg.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:2147483647';
            const foreignObject = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
            foreignObject.setAttribute('width', '100%');
            foreignObject.setAttribute('height', '100%');
            const svgFrame = document.createElement('iframe');
            svgFrame.id = 'parser-held-svg-frame';
            svgFrame.src = '/phishing-frame?parser-held-svg=1';
            svgFrame.style.cssText = 'width:100%;height:100%;border:0';
            window.__parserHeldSvgFrameRef = svgFrame;
            foreignObject.appendChild(svgFrame);
            hostileSvg.appendChild(foreignObject);
            document.body.append(hostileFrame, dialog, hostileSvg);
            try {
              dialog.showModal();
              window.__parserHeldAttack.dialogSupported = true;
              window.__parserHeldAttack.dialogOpened = dialog.open === true;
            } catch (_error) {}
            window.__parserHeldAttack.attempted = true;
          };
          attackAfterBootstrap();
        </script>`);
      const finishHeldResponse = setTimeout(() => {
        if (!response.destroyed) response.end('</body></html>');
      }, 15_000);
      finishHeldResponse.unref?.();
      return;
    }
    if (url.pathname.startsWith('/api/')) {
      json(response, 200, { success: true, schoolActive: true });
      return;
    }
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(`<!doctype html>
      <html><head><meta name="viewport" content="width=device-width"></head>
      <body style="margin:0"><button id="page-control" style="width:240px;height:80px">Underlying page</button>
      <script>
        window.__underlyingInput = { clicks: 0, keys: 0, wheels: 0, touches: 0 };
        window.addEventListener('click', () => window.__underlyingInput.clicks += 1, { capture: true });
        window.addEventListener('keydown', () => window.__underlyingInput.keys += 1, { capture: true });
        window.addEventListener('wheel', () => window.__underlyingInput.wheels += 1, { capture: true });
        window.addEventListener('touchstart', () => window.__underlyingInput.touches += 1, { capture: true });
        window.__underlyingEventLog = [];
        for (const type of ['click', 'keydown', 'wheel', 'touchstart']) {
          window.addEventListener(type, (event) => {
            window.__underlyingEventLog.push({
              type,
              target: event.target?.id || event.target?.tagName || null,
              path: event.composedPath().slice(0, 5).map((node) => node?.id || node?.tagName || node?.constructor?.name || null),
            });
          }, { capture: true });
        }
        window.__underlyingControlInput = { clicks: 0, keys: 0, wheels: 0, touches: 0 };
        const underlyingControl = document.getElementById('page-control');
        underlyingControl.addEventListener('click', () => window.__underlyingControlInput.clicks += 1);
        underlyingControl.addEventListener('keydown', () => window.__underlyingControlInput.keys += 1);
        underlyingControl.addEventListener('wheel', () => window.__underlyingControlInput.wheels += 1);
        underlyingControl.addEventListener('touchstart', () => window.__underlyingControlInput.touches += 1);
        window.__credentialLeakEvents = {
          windowKeydown: 0,
          windowInput: 0,
          windowBeforeInput: 0,
          documentKeydown: 0,
          documentInput: 0,
          documentBeforeInput: 0,
        };
        window.addEventListener('keydown', () => window.__credentialLeakEvents.windowKeydown += 1, { capture: true });
        window.addEventListener('input', () => window.__credentialLeakEvents.windowInput += 1, { capture: true });
        window.addEventListener('beforeinput', () => window.__credentialLeakEvents.windowBeforeInput += 1, { capture: true });
        document.addEventListener('keydown', () => window.__credentialLeakEvents.documentKeydown += 1, { capture: true });
        document.addEventListener('input', () => window.__credentialLeakEvents.documentInput += 1, { capture: true });
        document.addEventListener('beforeinput', () => window.__credentialLeakEvents.documentBeforeInput += 1, { capture: true });
        window.__authGateTimeline = [];
        let priorGatePresent = null;
        const recordGate = () => {
          const present = Boolean(document.getElementById('classpilot-auth-gate'));
          if (present === priorGatePresent) return;
          priorGatePresent = present;
          window.__authGateTimeline.push({ present, at: performance.now() });
        };
        recordGate();
        new MutationObserver(recordGate).observe(document.documentElement, { childList: true, subtree: true });
      </script></body></html>`);
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not expose a TCP port');
  return { server, state, origin: `http://127.0.0.1:${address.port}` };
}

function launchContext(executablePath, profilePath, extensionPath) {
  return chromium.launchPersistentContext(profilePath, {
    executablePath,
    headless: true,
    hasTouch: true,
    viewport: { width: 1366, height: 768 },
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
}

async function waitForWorker(context) {
  return context.serviceWorkers()[0] || context.waitForEvent('serviceworker', { timeout: 10_000 });
}

async function waitForLiveWorker(context) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    for (const candidate of [...context.serviceWorkers()].reverse()) {
      try {
        if (await candidate.evaluate(() => chrome.runtime.id)) return candidate;
      } catch {
        // A stopped Playwright Worker can remain in the snapshot briefly.
      }
    }
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 50));
  }
  throw new Error('A live ClassPilot service worker did not wake after navigation');
}

async function hasLiveExtensionWorkerTarget(cdp, extensionId) {
  const expectedPrefix = `chrome-extension://${extensionId}/`;
  try {
    const { targetInfos = [] } = await cdp.send('Target.getTargets');
    return targetInfos.some((target) => (
      target.type === 'service_worker' && target.url.startsWith(expectedPrefix)
    ));
  } catch {
    // If target discovery itself fails, retain the fail-closed CDP version
    // requirement below instead of treating an unknown state as stopped.
    return true;
  }
}

async function stopExtensionWorker(context, page, extensionId) {
  // A freshly launched unpacked release can register its MV3 worker slightly
  // later than the source checkout because Chrome is also unpacking extension
  // resources. Prove that a live target exists before subscribing to CDP
  // version events; otherwise an empty initial snapshot looks like a failed
  // stop even though the worker simply had not registered yet.
  await waitForLiveWorker(context);
  const cdp = await context.newCDPSession(page);
  try {
    const versions = new Map();
    cdp.on('ServiceWorker.workerVersionUpdated', (event) => {
      for (const version of event.versions || []) versions.set(version.versionId, version);
    });
    await cdp.send('ServiceWorker.enable');
    const relevant = () => [...versions.values()].filter((version) => (
      String(version.scriptURL || '').startsWith(`chrome-extension://${extensionId}/`)
    ));
    const discoveryDeadline = Date.now() + 5_000;
    while (relevant().length === 0 && Date.now() < discoveryDeadline) {
      await new Promise((resolvePoll) => setTimeout(resolvePoll, 25));
    }
    const discoveredCount = relevant().length;
    let consecutiveStoppedChecks = 0;
    const stopDeadline = Date.now() + 5_000;
    while (Date.now() < stopDeadline) {
      for (const version of relevant()) {
        if (version.runningStatus !== 'stopped') {
          await cdp.send('ServiceWorker.stopWorker', { versionId: version.versionId }).catch(() => {});
        }
      }
      await cdp.send('ServiceWorker.stopAllWorkers');
      await new Promise((resolvePoll) => setTimeout(resolvePoll, 50));
      // Chrome can retire the worker target between waitForLiveWorker() and
      // ServiceWorker.enable(), or before emitting the final version update.
      // A missing/non-evaluable extension Worker is direct evidence that the
      // cold-start precondition is already satisfied; do not require a stale
      // CDP version record to transition after its target has disappeared.
      const relevantVersions = relevant();
      const stoppedByProtocol = relevantVersions.length > 0
        && relevantVersions.every((version) => version.runningStatus === 'stopped');
      const stoppedByTarget = !(await hasLiveExtensionWorkerTarget(cdp, extensionId));
      const stopped = stoppedByProtocol || stoppedByTarget;
      consecutiveStoppedChecks = stopped ? consecutiveStoppedChecks + 1 : 0;
      if (consecutiveStoppedChecks >= 2) {
        return { closedCount: discoveredCount, stopped: true };
      }
    }
    return {
      closedCount: discoveredCount,
      stopped: false,
      versions: relevant().map((version) => ({
        status: version.status,
        runningStatus: version.runningStatus,
      })),
    };
  } finally {
    await cdp.send('ServiceWorker.disable').catch(() => {});
    await cdp.detach();
  }
}

async function seedManagedEquivalentConfig(worker, origin) {
  await worker.evaluate(async (serverUrl) => {
    const config = {
      serverUrl,
      schoolId: 'cold-start-school',
      schoolSlug: 'cold-start-school',
      enrollmentKey: 'fixture-enrollment-key',
    };
    await chrome.storage.local.set({ config });
    await chrome.storage.local.remove([
      'studentToken', 'activeStudentId', 'activeStudentSessionId', 'studentEmail',
      'studentName', 'identitySource', 'manualLoginLastSeenAt', 'sharedSignInConfigCacheV1',
    ]);
    await chrome.storage.session?.clear();
  }, origin);
}

async function tabIdFor(worker, page) {
  const expectedUrl = page.url();
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const tabId = await worker.evaluate(async (url) => {
      const tabs = await chrome.tabs.query({});
      return tabs.find((tab) => tab.url === url)?.id || null;
    }, expectedUrl);
    if (tabId) return tabId;
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 50));
  }
  throw new Error(`No extension tab found for ${expectedUrl}`);
}

async function openAuthGateIsolatedWorld(context, page, extensionId) {
  const cdp = await context.newCDPSession(page);
  const executionContexts = new Map();
  cdp.on('Runtime.executionContextCreated', ({ context: executionContext }) => {
    executionContexts.set(executionContext.id, executionContext);
  });
  cdp.on('Runtime.executionContextDestroyed', ({ executionContextId }) => {
    executionContexts.delete(executionContextId);
  });
  await cdp.send('Runtime.enable');

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    for (const executionContext of executionContexts.values()) {
      if (executionContext.auxData?.isDefault === true) continue;
      try {
        const probe = await cdp.send('Runtime.evaluate', {
          contextId: executionContext.id,
          expression: `({
            runtimeId: globalThis.chrome?.runtime?.id || null,
            hasBootstrapFence: typeof globalThis.__classpilotAuthGateBootstrap?.beginManagedPolicyFence === 'function',
            hasContentFence: typeof beginAuthGateManagedPolicyFence === 'function'
          })`,
          returnByValue: true,
        });
        const value = probe.result?.value;
        if (
          value?.runtimeId === extensionId
          && value.hasBootstrapFence === true
          && value.hasContentFence === true
        ) {
          return { cdp, contextId: executionContext.id };
        }
      } catch (_error) {
        // The page may retire an execution context while we inspect it.
      }
    }
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 25));
  }

  await cdp.detach();
  throw new Error('Could not locate the ClassPilot content-script isolated world');
}

async function evaluateInAuthGateWorld(world, expression) {
  const result = await world.cdp.send('Runtime.evaluate', {
    contextId: world.contextId,
    expression,
    awaitPromise: true,
    returnByValue: true,
    userGesture: true,
  });
  if (result.exceptionDetails) {
    throw new Error(
      `Auth-gate isolated-world evaluation failed: ${result.exceptionDetails.exception?.description || result.exceptionDetails.text}`,
    );
  }
  return result.result?.value;
}

async function exerciseLegacyEmptyGradeRecovery(context, page, extensionId) {
  const world = await openAuthGateIsolatedWorld(context, page, extensionId);
  try {
    const result = await evaluateInAuthGateWorld(world, `(async () => {
      const state = {
        authRequired: true,
        phase: 'ready',
        loginMethod: 'name_pin',
        sharedSignInEnabled: true,
        rosterContextGeneration: 1,
      };
      showAuthGate(state);
      stopAuthGateConnectionWatchdog();
      removeAuthGateBlockers();
      globalThis.__classpilotAuthGateBootstrap?.release?.({ fromContent: true });
      document.getElementById('classpilot-auth-gate')?.remove();
      const root = document.createElement('div');
      root.id = 'classpilot-legacy-auth-gate-test';
      root.innerHTML = buildAuthGateMarkup(state);
      document.documentElement.appendChild(root);

      const originalSendMessage = chrome.runtime.sendMessage;
      const originalSetTimeout = window.setTimeout.bind(window);
      const originalClearTimeout = window.clearTimeout.bind(window);
      const harness = {
        responses: [{ success: true, grades: [] }],
        defaultResponse: { success: true, grades: [] },
        requests: [],
        refreshTimers: new Map(),
        nextTimerId: -1,
        enqueue(response) {
          this.responses.push(response);
        },
        runLatestTimer() {
          const latest = Array.from(this.refreshTimers.entries()).at(-1);
          if (!latest) return null;
          const [timerId, timer] = latest;
          this.refreshTimers.delete(timerId);
          timer.callback(...timer.args);
          return timer.delay;
        },
      };

      window.setTimeout = function(callback, delay, ...args) {
        if (Number(delay) >= 25_000 && Number(delay) <= 5 * 60_000) {
          const timerId = harness.nextTimerId--;
          harness.refreshTimers.set(timerId, { callback, delay: Number(delay), args });
          return timerId;
        }
        return originalSetTimeout(callback, delay, ...args);
      };
      window.clearTimeout = function(timerId) {
        if (harness.refreshTimers.delete(timerId)) return;
        originalClearTimeout(timerId);
      };
      chrome.runtime.sendMessage = function(message, ...args) {
        const callback = args.find((value) => typeof value === 'function');
        if (message?.type === 'get-login-roster' && callback) {
          harness.requests.push({ ...message });
          const response = harness.responses.shift() || harness.defaultResponse;
          queueMicrotask(() => callback(response));
          return undefined;
        }
        return originalSendMessage.call(chrome.runtime, message, ...args);
      };

      const flush = async () => {
        await Promise.resolve();
        await Promise.resolve();
      };
      const availableGrades = {
        success: true,
        grades: [
          { value: '4', label: 'Grade 4' },
          { value: '5', label: 'Grade 5' },
        ],
      };

      try {
        attachAuthGateHandlers(state);
        await flush();
        const initial = {
          status: document.getElementById('classpilot-auth-roster-status')?.textContent,
          refreshDisabled: document.getElementById('classpilot-auth-roster-refresh')?.disabled,
          request: harness.requests.at(-1),
          refreshDelays: Array.from(harness.refreshTimers.values(), (timer) => timer.delay),
        };

        const pin = document.getElementById('classpilot-auth-pin');
        pin.value = '2468';
        pin.dispatchEvent(new Event('input', { bubbles: true }));
        pin.focus();
        harness.enqueue({ success: true, grades: [] });
        document.getElementById('classpilot-auth-roster-refresh')?.click();
        await flush();
        const manual = {
          status: document.getElementById('classpilot-auth-roster-status')?.textContent,
          refreshDisabled: document.getElementById('classpilot-auth-roster-refresh')?.disabled,
          pin: pin.value,
          focus: document.activeElement?.id,
          request: harness.requests.at(-1),
          refreshDelays: Array.from(harness.refreshTimers.values(), (timer) => timer.delay),
        };

        harness.responses.length = 0;
        harness.defaultResponse = availableGrades;
        const automaticDelay = harness.runLatestTimer();
        await flush();
        const automatic = {
          delay: automaticDelay,
          request: harness.requests.at(-1),
          gradeValues: Array.from(
            document.getElementById('classpilot-auth-grade')?.options || [],
            (option) => option.value,
          ),
          gradeDisabled: document.getElementById('classpilot-auth-grade')?.disabled,
          pin: pin.value,
          focus: document.activeElement?.id,
        };

        const events = [];
        for (const name of ['online', 'pageshow', 'focus', 'visibilitychange']) {
          if (name === 'visibilitychange') document.dispatchEvent(new Event(name));
          else if (name === 'pageshow') window.dispatchEvent(new PageTransitionEvent(name));
          else window.dispatchEvent(new Event(name));
          await flush();
          events.push({
            name,
            request: harness.requests.at(-1),
            grade: document.getElementById('classpilot-auth-grade')?.value,
            pin: pin.value,
            focus: document.activeElement?.id,
          });
        }
        return { initial, manual, automatic, events };
      } finally {
        clearAuthGateRosterRefreshTimer();
        chrome.runtime.sendMessage = originalSendMessage;
        window.setTimeout = originalSetTimeout;
        window.clearTimeout = originalClearTimeout;
        root.remove();
        removeAuthGate();
      }
    })()`);

    assert.equal(result.initial.status, 'No roster grades are currently available.');
    assert.equal(result.initial.refreshDisabled, false, 'legacy empty grades disabled Refresh names');
    assert.equal(result.initial.request?.type, 'get-login-roster');
    assert.equal(
      Object.prototype.hasOwnProperty.call(result.initial.request || {}, 'gradeLevel'),
      false,
      'legacy empty-grade refresh invented a grade target',
    );
    assert.equal(result.initial.refreshDelays.length, 1, 'legacy empty grades did not schedule recovery');
    assert.ok(result.initial.refreshDelays[0] >= 25_000 && result.initial.refreshDelays[0] <= 35_000);
    assert.deepEqual(result.manual.request, {
      type: 'get-login-roster',
      forceRefresh: true,
    });
    assert.equal(result.manual.refreshDisabled, false);
    assert.equal(result.manual.pin, '2468');
    assert.equal(result.manual.focus, 'classpilot-auth-pin');
    assert.equal(result.manual.refreshDelays.length, 1);
    assert.ok(result.manual.refreshDelays[0] >= 25_000 && result.manual.refreshDelays[0] <= 35_000);
    assert.ok(result.automatic.delay >= 25_000 && result.automatic.delay <= 35_000);
    assert.deepEqual(result.automatic.request, { type: 'get-login-roster' });
    assert.deepEqual(result.automatic.gradeValues, ['', '4', '5']);
    assert.equal(result.automatic.gradeDisabled, false);
    assert.equal(result.automatic.pin, '2468');
    assert.equal(result.automatic.focus, 'classpilot-auth-pin');
    assert.deepEqual(
      result.events,
      ['online', 'pageshow', 'focus', 'visibilitychange'].map((name) => ({
        name,
        request: { type: 'get-login-roster', forceRefresh: true },
        grade: '',
        pin: '2468',
        focus: 'classpilot-auth-pin',
      })),
      'legacy browser lifecycle events did not refresh grades without clearing context',
    );
  } finally {
    await world.cdp.detach();
  }
}

async function waitForManagedFenceRequests(world, minimum, options = {}) {
  const timeout = options.timeout ?? 5_000;
  const revalidate = options.revalidate ?? null;
  const deadline = Date.now() + timeout;
  let snapshot = [];
  let firstDiagnostic = null;
  let lastDiagnostic = null;
  while (Date.now() < deadline) {
    lastDiagnostic = await evaluateInAuthGateWorld(
      world,
      `(() => {
        const bootstrap = globalThis.__classpilotAuthGateBootstrap;
        return {
          queued: globalThis.__classpilotManagedFenceTestHarness?.queued.map((entry) => ({
            revalidate: entry.revalidate,
            fence: entry.message.managedPolicyFence ?? null,
            source: entry.source || null
          })) || [],
          bootstrap: {
            active: bootstrap?.active ?? null,
            enabled: bootstrap?.enabled ?? null,
            fence: bootstrap?.managedPolicyFence ?? null,
            pending: bootstrap?.managedPolicyFencePending ?? null,
            gateRootConnected: bootstrap?.gateRoot?.isConnected === true
          }
        };
      })()`,
    );
    if (!firstDiagnostic) firstDiagnostic = lastDiagnostic;
    snapshot = lastDiagnostic.queued;
    const matching = revalidate === null
      ? snapshot
      : snapshot.filter((entry) => entry.revalidate === revalidate);
    if (matching.length >= minimum) return matching;
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 25));
  }
  throw new Error(
    `Managed-policy fence did not queue ${minimum} matching request(s): ${JSON.stringify({
      revalidate,
      firstDiagnostic,
      lastDiagnostic,
    })}`,
  );
}

async function installManagedFenceMessageHarness(world) {
  const installed = await evaluateInAuthGateWorld(world, `(() => {
    const originalSendMessage = chrome.runtime.sendMessage;
    const harness = {
      originalSendMessage,
      queued: [],
      take(revalidate) {
        const selected = this.queued.filter((entry) => entry.revalidate === revalidate);
        this.queued = this.queued.filter((entry) => entry.revalidate !== revalidate);
        return selected;
      },
      replyInvalid(kind, revision) {
        const selected = this.take(true);
        for (const entry of selected) {
          const fence = entry.message.managedPolicyFence;
          const response = {
            success: true,
            managedPolicyFence: kind === 'wrong-fence' ? fence + 1 : fence,
            managedPolicyGeneration: kind === 'unsafe-generation'
              ? Number.MAX_SAFE_INTEGER + 1
              : 1,
            state: {
              phase: 'authenticated',
              authRequired: false,
              revision: kind === 'stale-revision' ? -1 : revision + 1,
            },
          };
          entry.callback(response);
        }
        return {
          count: selected.length,
          sources: selected.map((entry) => entry.source || null),
          fences: selected.map((entry) => entry.message.managedPolicyFence ?? null),
        };
      },
      beginWorkerReplies() {
        const selected = this.take(true);
        if (selected.length === 0) throw new Error('No managed-policy fence request is queued');
        if (this.workerReplyPromise) throw new Error('Managed-policy worker replies are already pending');
        this.workerReplyPromise = Promise.all(selected.map((entry) => new Promise((resolve, reject) => {
          this.originalSendMessage.call(chrome.runtime, entry.message, (response) => {
            const error = chrome.runtime.lastError;
            if (error) reject(new Error(error.message));
            else resolve({ entry, response });
          });
        }))).then((results) => {
          for (const { entry, response } of results) entry.callback(response);
          return results.map(({ entry, response }) => ({
            requestedFence: entry.message.managedPolicyFence ?? null,
            success: response?.success === true,
            managedPolicyFence: response?.managedPolicyFence ?? null,
            managedPolicyGeneration: response?.managedPolicyGeneration ?? null,
            phase: response?.state?.phase ?? null,
            authRequired: response?.state?.authRequired ?? null,
            revision: response?.state?.revision ?? null,
          }));
        });
        return {
          requestCount: selected.length,
          requestedFences: selected.map((entry) => entry.message.managedPolicyFence ?? null),
        };
      },
      async finishWorkerReplies() {
        if (!this.workerReplyPromise) throw new Error('No managed-policy worker replies are pending');
        try {
          return await this.workerReplyPromise;
        } finally {
          this.workerReplyPromise = null;
        }
      },
      replyNormal(state) {
        const selected = this.take(false);
        for (const entry of selected) entry.callback({ success: true, state });
        return selected.length;
      },
      restore() {
        chrome.runtime.sendMessage = this.originalSendMessage;
        this.queued = [];
      },
    };
    chrome.runtime.sendMessage = function(message, ...args) {
      const callback = args.find((value) => typeof value === 'function');
      if (message?.type === 'get-auth-state' && callback) {
        const stack = new Error().stack || '';
        harness.queued.push({
          message: { ...message },
          callback,
          revalidate: message.revalidateManagedPolicy === true,
          source: stack.includes('requestAuthGateManagedPolicyRevalidation')
            ? 'content'
            : stack.includes('requestManagedPolicyRevalidation')
              ? 'bootstrap'
              : 'normal',
        });
        return undefined;
      }
      return originalSendMessage.call(chrome.runtime, message, ...args);
    };
    globalThis.__classpilotManagedFenceTestHarness = harness;
    return chrome.runtime.sendMessage !== originalSendMessage;
  })()`);
  assert.equal(installed, true, 'could not intercept isolated-world auth-state callbacks');
}

async function beginManagedPolicyFenceRace(world) {
  const result = await evaluateInAuthGateWorld(world, `(() => {
    requestAuthGateState();
    globalThis.__classpilotAuthGateBootstrap.beginManagedPolicyFence();
    beginAuthGateManagedPolicyFence();
    return {
      bootstrapFence: globalThis.__classpilotAuthGateBootstrap.managedPolicyFence,
      contentFencePending: isAuthGateManagedPolicyFencePending(),
      queued: globalThis.__classpilotManagedFenceTestHarness.queued.length,
    };
  })()`);
  assert.ok(result.bootstrapFence > 0, 'bootstrap did not enter its managed-policy fence');
  assert.equal(result.contentFencePending, true, 'content script did not enter its managed-policy fence');
  await waitForManagedFenceRequests(world, 3);
  return result;
}

async function beginChromeProfileRegistrationFence(worker, options) {
  return worker.evaluate(async ({ path, serverUrl, label }) => {
    if (globalThis.__classpilotProfileRegistrationHarness) {
      throw new Error('Chrome-profile registration harness is already installed');
    }
    await clearStudentAuth(`test_${label}_prepare`, {
      notifyBackend: false,
      localOnly: true,
      notifyAuthGateTabs: false,
      pauseAutoRegistration: true,
      disconnectWebSocket: true,
    });
    const deviceId = `${label}-device`;
    const studentEmail = `${label}@example.edu`;
    const config = persistedNonAuthConfig({
      ...CONFIG,
      serverUrl,
      schoolId: 'cold-start-school',
      schoolSlug: 'cold-start-school',
      enrollmentKey: 'fixture-enrollment-key',
      autoRegistrationPaused: false,
    });
    await durableLocalKv.set({
      config,
      deviceId,
      studentEmail,
      studentName: `${label} Student`,
      registered: false,
      lastRegisteredEmail: null,
      identitySource: null,
      autoRegistrationPaused: false,
    });
    if (hasSessionStorage()) {
      await durableSessionKv.remove([
        'studentToken',
        'activeStudentId',
        'activeStudentSessionId',
        'identitySource',
      ]);
    }
    Object.assign(CONFIG, config, {
      deviceId,
      studentEmail,
      studentName: `${label} Student`,
      studentToken: null,
      activeStudentId: null,
      activeStudentSessionId: null,
      identitySource: null,
      manualLoginLastSeenAt: null,
      autoRegistrationPaused: false,
    });
    studentAuthInvalidating = false;

    const originals = {
      fetchWithBackoff,
      fetchClientConfig,
      readManagedConfig,
      detectChromeProfileEmail,
      applyClassroomStateFromAuthResponse,
      reconcileMessageInboxIdentity,
      checkLicenseStatus,
      notifyAuthGateStateToTabs,
    };
    let rejectApply;
    const applyBarrier = new Promise((_resolveApply, reject) => {
      rejectApply = reject;
    });
    const harness = {
      path,
      label,
      entered: false,
      settled: false,
      outcome: null,
      applyReason: null,
      applyOptions: null,
      registerRequestCount: 0,
      rejectApply,
      restore() {
        fetchWithBackoff = originals.fetchWithBackoff;
        fetchClientConfig = originals.fetchClientConfig;
        readManagedConfig = originals.readManagedConfig;
        detectChromeProfileEmail = originals.detectChromeProfileEmail;
        applyClassroomStateFromAuthResponse = originals.applyClassroomStateFromAuthResponse;
        reconcileMessageInboxIdentity = originals.reconcileMessageInboxIdentity;
        checkLicenseStatus = originals.checkLicenseStatus;
        notifyAuthGateStateToTabs = originals.notifyAuthGateStateToTabs;
      },
    };
    globalThis.__classpilotProfileRegistrationHarness = harness;

    const responseData = {
      studentToken: `${label}-token`,
      studentSessionId: `${label}-session`,
      schoolId: 'cold-start-school',
      student: {
        id: `${label}-student`,
        schoolId: 'cold-start-school',
      },
      classroomState: {
        revision: 1,
        active: true,
        blockedCategories: [],
      },
    };
    fetchClientConfig = async () => ({});
    readManagedConfig = async () => ({
      fastAuthGateEnabled: true,
      serverUrl,
      schoolId: 'cold-start-school',
      schoolSlug: 'cold-start-school',
      enrollmentKey: 'fixture-enrollment-key',
    });
    detectChromeProfileEmail = async () => studentEmail;
    fetchWithBackoff = async (url) => {
      if (!String(url).endsWith('/api/extension/register')) {
        throw new Error(`Unexpected registration harness request: ${url}`);
      }
      harness.registerRequestCount += 1;
      return new Response(JSON.stringify(responseData), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    reconcileMessageInboxIdentity = async () => {};
    checkLicenseStatus = async () => {};
    notifyAuthGateStateToTabs = async () => {};
    applyClassroomStateFromAuthResponse = async (_data, reason, applyOptions) => {
      harness.entered = true;
      harness.applyReason = reason;
      harness.applyOptions = applyOptions || null;
      await applyBarrier;
    };

    if (path === 'ensure') registrationRetryCount = MAX_REGISTRATION_RETRIES;
    const registration = path === 'ensure'
      ? ensureRegisteredNow()
      : registerDeviceWithStudentNow(
        deviceId,
        `${label} Chromebook`,
        'auto',
        studentEmail,
        `${label} Student`,
      );
    Promise.resolve(registration).then(
      () => { harness.outcome = 'fulfilled'; },
      (error) => {
        harness.outcome = 'rejected';
        harness.error = error?.message || String(error);
      },
    ).finally(() => {
      harness.restore();
      harness.settled = true;
    });
    return { started: true, path, label };
  }, options);
}

async function chromeProfileRegistrationSnapshot(worker) {
  return worker.evaluate(async () => {
    const harness = globalThis.__classpilotProfileRegistrationHarness;
    const persisted = await getStoredAuthState([
      'studentToken',
      'activeStudentId',
      'activeStudentSessionId',
      'studentAuthCommitPendingV1',
    ]);
    const state = getAuthGateState();
    return {
      entered: harness?.entered === true,
      settled: harness?.settled === true,
      outcome: harness?.outcome || null,
      error: harness?.error || null,
      applyReason: harness?.applyReason || null,
      applyOptions: harness?.applyOptions || null,
      registerRequestCount: harness?.registerRequestCount ?? 0,
      persistedCommitPending: persisted.studentAuthCommitPendingV1 === true,
      inMemoryCommitPending: studentAuthCommitPending === true,
      exactBinding: Boolean(
        persisted.studentToken
        && persisted.activeStudentId
        && persisted.activeStudentSessionId
      ),
      publicAuthenticated: hasStudentAuth(),
      phase: state.phase,
      authRequired: state.authRequired,
      persisted,
    };
  });
}

async function waitForChromeProfileRegistration(worker, predicate, timeout = 7_000) {
  const deadline = Date.now() + timeout;
  let snapshot = null;
  while (Date.now() < deadline) {
    snapshot = await chromeProfileRegistrationSnapshot(worker);
    if (predicate(snapshot)) return snapshot;
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 25));
  }
  throw new Error(`Chrome-profile registration fence timed out: ${JSON.stringify(snapshot)}`);
}

async function rejectChromeProfileRegistrationApply(worker, message) {
  return worker.evaluate((errorMessage) => {
    const harness = globalThis.__classpilotProfileRegistrationHarness;
    if (!harness?.rejectApply) return false;
    harness.rejectApply(new Error(errorMessage));
    return true;
  }, message);
}

async function clearChromeProfileRegistrationHarness(worker) {
  await worker.evaluate(() => {
    globalThis.__classpilotProfileRegistrationHarness?.restore?.();
    delete globalThis.__classpilotProfileRegistrationHarness;
  });
}

async function managedFenceSnapshot(page, frameReferenceName) {
  return page.evaluate((referenceName) => {
    const gate = document.getElementById('classpilot-auth-gate');
    const pageFrame = window[referenceName];
    const bodyStyle = document.body ? getComputedStyle(document.body) : null;
    return {
      gatePresent: Boolean(gate),
      phase: gate?.dataset.classpilotAuthPhase || null,
      bodyInert: document.body?.hasAttribute('inert') === true,
      bodyDisplay: document.body?.style.getPropertyValue('display') || '',
      bodyDisplayPriority: document.body?.style.getPropertyPriority('display') || '',
      computedBodyDisplay: bodyStyle?.display || null,
      frameConnected: pageFrame?.isConnected ?? null,
      frameBeforeAnchor: Boolean(
        pageFrame?.isConnected
        && pageFrame.nextSibling === window[`${referenceName}Anchor`]
      ),
      hitTarget: (() => {
        const target = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
        return target?.id || target?.tagName || null;
      })(),
    };
  }, frameReferenceName);
}

function assertManagedFenceLocked(snapshot, label, options = {}) {
  const allowedPhases = options.allowedPhases || ['loading'];
  assert.equal(snapshot.gatePresent, true, `${label}: auth gate is missing`);
  assert.ok(
    allowedPhases.includes(snapshot.phase),
    `${label}: unexpected locked phase ${snapshot.phase}`,
  );
  assert.equal(snapshot.bodyInert, true, `${label}: page body is not inert`);
  assert.equal(snapshot.bodyDisplay, 'none', `${label}: page body is not hidden`);
  assert.equal(snapshot.bodyDisplayPriority, 'important', `${label}: page body hide is not important`);
  assert.equal(snapshot.frameConnected, false, `${label}: page-owned browsing context was not detached`);
  assert.equal(snapshot.hitTarget, 'classpilot-auth-gate', `${label}: gate is not the hit-test surface`);
}

async function pushAuthState(worker, page, state) {
  const tabId = await tabIdFor(worker, page);
  // These direct pushes exercise only presentation transitions. Omitting a
  // synthetic revision keeps later real worker states authoritative instead
  // of poisoning the page with a number outside the worker's durable range.
  const authoritativeState = { ...state };
  delete authoritativeState.revision;
  const result = await worker.evaluate(async ({ tabId: targetTabId, state: nextState }) => {
    try {
      const tabResult = await chrome.tabs.sendMessage(targetTabId, {
        type: 'CLASSPILOT_AUTH_REQUIRED',
        state: nextState,
      });
      await chrome.runtime.sendMessage({
        type: 'CLASSPILOT_AUTH_REQUIRED',
        state: nextState,
      }).catch(() => null);
      return tabResult;
    } catch (error) {
      return { success: false, error: error?.message || String(error) };
    }
  }, { tabId, state: authoritativeState });
  assert.equal(result?.success, true, `auth state delivery failed: ${result?.error || 'unknown error'}`);
}

async function broadcastAuthMessage(worker, page, type, state) {
  const tabId = await tabIdFor(worker, page);
  return worker.evaluate(async ({ targetTabId, messageType, nextState }) => {
    let tabResult = null;
    let tabError = null;
    try {
      tabResult = await chrome.tabs.sendMessage(targetTabId, {
        type: messageType,
        state: nextState,
      });
    } catch (error) {
      tabError = error?.message || String(error);
    }
    await chrome.runtime.sendMessage({ type: messageType, state: nextState }).catch(() => null);
    return { tabResult, tabError };
  }, { tabId, messageType: type, nextState: state });
}

async function gatePhase(page) {
  return page.evaluate(() => {
    const gate = document.getElementById('classpilot-auth-gate');
    if (!gate) return null;
    if (gate.dataset.classpilotAuthPhase) return gate.dataset.classpilotAuthPhase;
    if (document.getElementById('classpilot-auth-retry')) return 'unavailable';
    if (document.getElementById('classpilot-auth-pin-form') || document.getElementById('classpilot-auth-email-form')) return 'ready';
    const title = document.getElementById('classpilot-auth-title')?.textContent || '';
    if (/set up this Chromebook/i.test(title)) return 'setup_required';
    return /Connecting to ClassPilot/i.test(gate.textContent || '') ? 'loading' : 'unknown';
  });
}

async function waitForGatePhase(page, phase, timeout = 10_000) {
  await page.waitForFunction((expected) => {
    const gate = document.getElementById('classpilot-auth-gate');
    if (!gate) return false;
    if (gate.dataset.classpilotAuthPhase === expected) return true;
    if (expected === 'unavailable' && document.getElementById('classpilot-auth-retry')) return true;
    if (expected === 'ready' && (document.getElementById('classpilot-auth-pin-form') || document.getElementById('classpilot-auth-email-form'))) return true;
    const title = document.getElementById('classpilot-auth-title')?.textContent || '';
    if (expected === 'setup_required' && /set up this Chromebook/i.test(title)) return true;
    return expected === 'loading' && /Connecting to ClassPilot/i.test(gate.textContent || '');
  }, phase, { timeout });
}

async function waitForAuthFrame(page, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const frame = page.frames().find((candidate) => (
      candidate.url().includes('/auth-gate-frame.html')
    ));
    if (frame) return frame;
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 25));
  }
  throw new Error('Secure ClassPilot auth frame did not mount before timeout');
}

async function waitForAuthFramePhase(page, phase, timeout = 10_000) {
  const frame = await waitForAuthFrame(page, timeout);
  await frame.waitForFunction((expected) => (
    document.getElementById('classpilot-auth-gate')?.dataset.classpilotAuthPhase === expected
  ), phase, { timeout });
  return frame;
}

async function waitForFreshAuthFrame(page, priorNonce, phase = 'ready', timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    for (const frame of page.frames()) {
      if (!frame.url().includes('/auth-gate-frame.html')) continue;
      let nonce = '';
      try {
        nonce = new URL(frame.url()).hash;
      } catch {
        continue;
      }
      if (!nonce || nonce === priorNonce) continue;
      const currentPhase = await frame.locator('#classpilot-auth-gate')
        .getAttribute('data-classpilot-auth-phase')
        .catch(() => null);
      if (currentPhase === phase) return frame;
    }
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 25));
  }
  const diagnostic = {
    gate: await page.evaluate(() => {
      const gate = document.getElementById('classpilot-auth-gate');
      return gate ? {
        phase: gate.dataset.classpilotAuthPhase || null,
        frameStatus: gate.dataset.classpilotAuthFrameStatus || null,
        recovery: gate.dataset.classpilotAuthRecovery || null,
        recoverySerial: gate.dataset.classpilotAuthRecoverySerial || null,
      } : null;
    }).catch(() => null),
    frames: page.frames().map((frame) => ({ name: frame.name(), url: frame.url() })),
    priorNonce,
    expectedPhase: phase,
  };
  throw new Error(
    `Fresh secure ClassPilot auth frame did not reach ${phase} before timeout: ${JSON.stringify(diagnostic)}`,
  );
}

async function requestRetryNow(page, worker) {
  const frame = await waitForAuthFrame(page);
  const retry = frame.locator('#classpilot-auth-retry');
  if (await retry.isVisible().catch(() => false)) {
    try {
      await retry.click({ timeout: 750 });
      return;
    } catch (_error) {
      // The automatic retry can replace the button between lookup and click.
    }
  }
  await requestLiveRefresh(worker);
}

async function assertUnderlyingPageLocked(page, options = {}) {
  const before = await page.evaluate(() => ({
    host: { ...window.__underlyingInput },
    control: { ...window.__underlyingControlInput },
  }));
  await page.mouse.click(30, 30);
  await page.keyboard.press('A');
  await page.mouse.wheel(0, 200);
  if (page.touchscreen) await page.touchscreen.tap(30, 30);
  const after = await page.evaluate(() => ({
    host: { ...window.__underlyingInput },
    control: { ...window.__underlyingControlInput },
    eventLog: window.__underlyingEventLog.slice(-12),
    hitTarget: (() => {
      const element = document.elementFromPoint(30, 30);
      return element?.id || element?.tagName || null;
    })(),
    activeElement: document.activeElement?.id || document.activeElement?.tagName || null,
    gate: (() => {
      const gate = document.getElementById('classpilot-auth-gate');
      if (!gate) return null;
      const rect = gate.getBoundingClientRect();
      const style = getComputedStyle(gate);
      return {
        phase: gate.dataset.classpilotAuthPhase,
        frameStatus: gate.dataset.classpilotAuthFrameStatus,
        rect: { top: rect.top, right: rect.right, bottom: rect.bottom, left: rect.left },
        display: style.display,
        pointerEvents: style.pointerEvents,
        zIndex: style.zIndex,
      };
    })(),
  }));
  assert.deepEqual(after.control, before.control, `gate leaked input to the underlying control: ${JSON.stringify(after)}`);
  if (options.requireNoHostCapture !== false) {
    assert.deepEqual(after.host, before.host, `loading gate leaked input to the host window: ${JSON.stringify(after)}`);
  }
}

async function requestLiveRefresh(worker) {
  return worker.evaluate(async () => {
    await refreshSharedSignInLoginConfig({ force: true, reason: 'chromium_test' });
    return getAuthGateState();
  });
}

async function main() {
  const executablePath = chromeExecutable();
  if (!executablePath) {
    throw new Error('Chrome for Testing was not found. Run `npx playwright install chromium`.');
  }

  const extensionPath = mkdtempSync(join(tmpdir(), 'classpilot-fast-auth-extension-'));
  const profilePath = mkdtempSync(join(tmpdir(), 'classpilot-fast-auth-profile-'));
  let context;
  let fixture;
  try {
    fixture = await startFixtureServer();
    cpSync(sourceExtensionPath, extensionPath, { recursive: true });
    writeFileSync(join(extensionPath, 'config.js'), `globalThis.CLASSPILOT_SERVER_URL = ${JSON.stringify(fixture.origin)};\n`);
    writeFileSync(
      join(extensionPath, 'cold-auth-cohort.html'),
      '<!doctype html><meta charset="utf-8"><title>Cold auth cohort</title><script src="cold-auth-cohort.js"></script>',
    );
    writeFileSync(join(extensionPath, 'cold-auth-cohort.js'), `
      const requestAuthState = () => new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'get-auth-state' }, (response) => {
          const error = chrome.runtime.lastError;
          resolve(error ? { success: false, error: error.message } : response);
        });
      });
      Promise.all([requestAuthState(), requestAuthState(), requestAuthState()])
        .then(async (first) => {
          const later = await requestAuthState();
          globalThis.__classpilotColdAuthCohort = { first, later };
        });
    `);

    // Prime only the school policy in a persistent profile, then close Chrome.
    // The measured navigation therefore wakes a fresh extension worker.
    context = await launchContext(executablePath, profilePath, extensionPath);
    let worker = await waitForWorker(context);
    const extensionId = new URL(worker.url()).host;
    await seedManagedEquivalentConfig(worker, fixture.origin);
    await context.close();
    context = null;

    context = await launchContext(executablePath, profilePath, extensionPath);
    let firstPage = context.pages()[0] || await context.newPage();
    await firstPage.goto('chrome://version');
    const coldStop = await stopExtensionWorker(context, firstPage, extensionId);
    assert.equal(coldStop.stopped, true, 'could not stop the MV3 worker before measured navigation');

    const navigationStartedAt = Date.now();
    const firstNavigation = firstPage.goto(`${fixture.origin}/cold-start`, { waitUntil: 'domcontentloaded' });
    await firstPage.waitForSelector(GATE_SELECTOR, { state: 'attached', timeout: LOADING_LIMIT_MS });
    const loadingPaintMs = Date.now() - navigationStartedAt;
    assert.ok(loadingPaintMs < LOADING_LIMIT_MS, `loading gate painted in ${loadingPaintMs}ms (limit ${LOADING_LIMIT_MS}ms)`);
    await waitForGatePhase(firstPage, 'loading', LOADING_LIMIT_MS);
    await firstNavigation;
    await assertUnderlyingPageLocked(firstPage);
    worker = await waitForLiveWorker(context);

    // Hold the parser open so document_idle cannot run, then let hostile page
    // script remove the document_start bootstrap host and add full-screen
    // iframe/modal phishing UI. The bootstrap watchdog itself must recover and
    // quarantine the attack before any interaction is attempted.
    const parserHeldPage = await context.newPage();
    const parserHeldPhishingBaseline = fixture.state.phishingInputEvents;
    await parserHeldPage.goto(`${fixture.origin}/parser-held-auth-attack`, { waitUntil: 'commit' });
    await parserHeldPage.waitForFunction(() => window.__parserHeldAttack?.attempted === true, undefined, {
      timeout: LOADING_LIMIT_MS,
    });
    const parserHeldRecovery = await parserHeldPage.waitForFunction(() => {
      const gate = document.getElementById('classpilot-auth-gate');
      const hostileFrame = window.__parserHeldHostileFrameRef;
      const svgFrame = window.__parserHeldSvgFrameRef;
      const hostileDialog = document.getElementById('parser-held-hostile-dialog');
      const hostileSvg = document.getElementById('parser-held-hostile-svg');
      if (
        document.readyState !== 'loading'
        || gate?.dataset.classpilotAuthRecovery !== 'restored'
        || hostileFrame?.isConnected !== false
        || svgFrame?.isConnected !== false
        || hostileDialog?.inert !== true
        || hostileDialog.open !== false
        || !hostileSvg?.hasAttribute('inert')
        || hostileSvg.style.getPropertyValue('pointer-events') !== 'none'
        || hostileSvg.style.getPropertyPriority('pointer-events') !== 'important'
        || hostileSvg.style.getPropertyValue('display') !== 'none'
        || hostileSvg.style.getPropertyPriority('display') !== 'important'
        || document.documentElement.lastElementChild !== gate
      ) return null;
      const hitTarget = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
      if (hitTarget !== gate && !gate.contains(hitTarget)) return null;
      return {
        recoverySerial: gate.dataset.classpilotAuthRecoverySerial,
        dialogSupported: window.__parserHeldAttack.dialogSupported,
        dialogOpened: window.__parserHeldAttack.dialogOpened,
      };
    }, undefined, { timeout: LOADING_LIMIT_MS });
    const parserHeldRecoveryState = await parserHeldRecovery.jsonValue();
    // A document_start beforetoggle guard may cancel showModal synchronously;
    // the final closed/inert/non-interactive state above is the invariant.
    const parserHeldFocusAttack = await parserHeldPage.evaluate(() => {
      const frame = window.__parserHeldHostileFrameRef;
      const childInput = frame?.contentDocument?.getElementById('hostile-phishing-input');
      childInput?.focus();
      frame?.contentWindow?.focus();
      return {
        childInputFound: Boolean(childInput),
        frameConnected: frame?.isConnected ?? null,
        parentActiveElement: document.activeElement?.id || document.activeElement?.tagName || null,
        childActiveElement: frame?.contentDocument?.activeElement?.id || frame?.contentDocument?.activeElement?.tagName || null,
        frameInlineDisplay: frame?.style.getPropertyValue('display') || '',
        frameComputedDisplay: frame ? getComputedStyle(frame).display : null,
        bodyComputedDisplay: document.body ? getComputedStyle(document.body).display : null,
      };
    });
    assert.equal(parserHeldFocusAttack.frameConnected, false);
    await parserHeldPage.keyboard.type('FORCED-PARSER-FOCUS');
    await parserHeldPage.waitForTimeout(100);
    await assertUnderlyingPageLocked(parserHeldPage);
    assert.deepEqual(
      await parserHeldPage.evaluate(() => window.__parserHeldDialogEvents),
      { clicks: 0, keys: 0, inputs: 0 },
      'parser-held hostile dialog received interaction before document_idle',
    );
    assert.equal(
      fixture.state.phishingInputEvents,
      parserHeldPhishingBaseline,
      `parser-held phishing iframe received interaction before document_idle: ${JSON.stringify(parserHeldFocusAttack)}`,
    );
    await parserHeldPage.waitForTimeout(300);
    assert.equal(
      await parserHeldPage.locator(GATE_SELECTOR).getAttribute('data-classpilot-auth-recovery-serial'),
      parserHeldRecoveryState.recoverySerial,
      'parser-held host recovery entered a replacement loop',
    );
    await parserHeldPage.close();

    // A second tab opened while the first live config request is held must
    // share that request instead of creating a thundering herd.
    const secondPage = await context.newPage();
    await secondPage.goto(`${fixture.origin}/concurrent-tab`, { waitUntil: 'domcontentloaded' });
    await waitForGatePhase(secondPage, 'loading', LOADING_LIMIT_MS);
    const configRequestDeadline = Date.now() + 4_000;
    while (fixture.state.loginConfigRequests === 0 && Date.now() < configRequestDeadline) {
      await new Promise((resolvePoll) => setTimeout(resolvePoll, 25));
    }
    assert.equal(fixture.state.loginConfigRequests, 1, 'concurrent tabs did not deduplicate login configuration');

    await waitForGatePhase(firstPage, 'unavailable', 7_500);
    await waitForGatePhase(secondPage, 'unavailable', 7_500);
    assert.ok(Date.now() - navigationStartedAt >= 5_000, 'fixture did not hold authoritative config for at least five seconds');
    fixture.state.configDelayMs = 0;
    await requestLiveRefresh(worker);
    await waitForGatePhase(firstPage, 'ready', 7_000);
    await waitForGatePhase(secondPage, 'ready', 7_000);
    await exerciseLegacyEmptyGradeRecovery(context, secondPage, extensionId);
    await secondPage.close();

    // Host-page code cannot forge an unlocked phase or swap in a fake gate to
    // bypass the isolated-world blocker. Remove the authentic host after
    // mutating it, insert a same-ID/data-ready decoy, then prove page input is
    // still intercepted.
    const tamperPage = await context.newPage();
    await tamperPage.addInitScript(() => {
      window.__hostileGateTampered = false;
      const tamper = () => {
        const authenticGate = document.getElementById('classpilot-auth-gate');
        if (!authenticGate || authenticGate.dataset.hostileFake === 'true') return;
        authenticGate.dataset.classpilotAuthPhase = 'ready';
        authenticGate.remove();
        const fakeGate = document.createElement('div');
        fakeGate.id = 'classpilot-auth-gate';
        fakeGate.dataset.classpilotAuthPhase = 'ready';
        fakeGate.dataset.hostileFake = 'true';
        fakeGate.hidden = true;
        document.documentElement.appendChild(fakeGate);
        window.__hostileGateTampered = true;
      };
      const observer = new MutationObserver(tamper);
      const start = () => {
        if (!document.documentElement) {
          requestAnimationFrame(start);
          return;
        }
        observer.observe(document.documentElement, { childList: true, subtree: true });
        tamper();
      };
      start();
    });
    await tamperPage.goto(`${fixture.origin}/hostile-gate-tamper`, { waitUntil: 'domcontentloaded' });
    await tamperPage.waitForFunction(() => window.__hostileGateTampered === true);
    await tamperPage.mouse.click(30, 30);
    await tamperPage.keyboard.press('A');
    assert.deepEqual(
      await tamperPage.evaluate(() => window.__underlyingInput),
      { clicks: 0, keys: 0, wheels: 0, touches: 0 },
      'host-page gate replacement bypassed the isolated interaction lock',
    );
    await tamperPage.close();

    // A hostile page can race the document_idle content script and attach an
    // open shadow tree to the bootstrap host. The extension must discard that
    // unverified host before mounting any trusted credential frame.
    const preattachedShadowPage = await context.newPage();
    await preattachedShadowPage.addInitScript(() => {
      window.__hostileShadowAttack = { attempted: false, attached: false };
      const attack = () => {
        if (window.__hostileShadowAttack.attempted) return;
        const gate = document.getElementById('classpilot-auth-gate');
        if (!gate) return;
        window.__hostileShadowAttack.attempted = true;
        window.__hostileBootstrapHost = gate;
        try {
          const shadow = gate.attachShadow({ mode: 'open' });
          shadow.innerHTML = '<input id="hostile-credential" value="phishing"><button id="hostile-sign-in">Sign in</button>';
          window.__hostileShadowAttack.attached = true;
        } catch (_error) {
          // Already-secured hosts are also a safe outcome.
        }
        gate.dataset.classpilotAuthPhase = 'ready';
      };
      const observer = new MutationObserver(attack);
      const start = () => {
        if (!document.documentElement) {
          requestAnimationFrame(start);
          return;
        }
        observer.observe(document.documentElement, { childList: true, subtree: true });
        attack();
      };
      start();
    });
    await preattachedShadowPage.goto(`${fixture.origin}/pre-attached-shadow`, { waitUntil: 'domcontentloaded' });
    await preattachedShadowPage.waitForFunction(() => window.__hostileShadowAttack?.attempted === true);
    await waitForAuthFramePhase(preattachedShadowPage, 'ready', 7_000);
    const shadowAttackResult = await preattachedShadowPage.evaluate(() => {
      const currentGate = document.getElementById('classpilot-auth-gate');
      const hostileHost = window.__hostileBootstrapHost;
      return {
        ...window.__hostileShadowAttack,
        hostileHostStillConnected: hostileHost?.isConnected === true,
        currentHostIsHostile: currentGate === hostileHost,
        currentOpenShadowExposed: Boolean(currentGate?.shadowRoot),
        hostileCredentialStillShown: Boolean(
          hostileHost?.isConnected && hostileHost.shadowRoot?.getElementById('hostile-credential'),
        ),
      };
    });
    assert.equal(shadowAttackResult.attempted, true);
    assert.equal(shadowAttackResult.currentOpenShadowExposed, false);
    assert.equal(shadowAttackResult.hostileCredentialStillShown, false);
    if (shadowAttackResult.attached) {
      assert.equal(shadowAttackResult.hostileHostStillConnected, false);
      assert.equal(shadowAttackResult.currentHostIsHostile, false);
    }
    await assertUnderlyingPageLocked(preattachedShadowPage);
    await preattachedShadowPage.close();

    // A parent page must not locate the auth frame by name. If it finds the
    // anonymous child WindowProxy by index and navigates it to same-origin
    // phishing content, that document cannot complete the nonce handshake or
    // receive input; the extension restores a freshly nonced trusted frame.
    const frameNavigationPage = await context.newPage();
    await frameNavigationPage.goto(`${fixture.origin}/iframe-navigation`, { waitUntil: 'domcontentloaded' });
    const originalNavigationFrame = await waitForAuthFramePhase(frameNavigationPage, 'ready', 7_000);
    const originalNavigationNonce = new URL(originalNavigationFrame.url()).hash;
    const phishingRequestBaseline = fixture.state.phishingFrameRequests;
    const navigationAttack = await frameNavigationPage.evaluate((phishingUrl) => {
      const named = window.frames['classpilot-auth-gate-frame'];
      const indexed = window.frames.length > 0 ? window.frames[0] : null;
      let navigationAttempted = false;
      let navigationError = null;
      if (indexed) {
        try {
          indexed.location.href = phishingUrl;
          navigationAttempted = true;
        } catch (error) {
          navigationError = error?.message || String(error);
        }
      }
      return {
        namedFrameExposed: Boolean(named),
        childFrameCount: window.frames.length,
        navigationAttempted,
        navigationError,
      };
    }, `${fixture.origin}/phishing-frame`);
    assert.equal(navigationAttack.namedFrameExposed, false, 'secure auth frame remained addressable by name');
    if (navigationAttack.navigationAttempted) {
      const phishingDeadline = Date.now() + 3_000;
      while (fixture.state.phishingFrameRequests === phishingRequestBaseline && Date.now() < phishingDeadline) {
        await new Promise((resolvePoll) => setTimeout(resolvePoll, 20));
      }
      assert.equal(
        fixture.state.phishingFrameRequests,
        phishingRequestBaseline + 1,
        'hostile parent navigation did not reach the phishing fixture',
      );
      await frameNavigationPage.mouse.click(200, 200);
      await frameNavigationPage.keyboard.press('P');
    }
    let recoveredFrame;
    let navigationCommitted = true;
    try {
      recoveredFrame = await waitForFreshAuthFrame(
        frameNavigationPage,
        originalNavigationNonce,
        'ready',
        1_500,
      );
    } catch (_error) {
      // Chromium can issue the hostile request but reject its commit into an
      // extension-origin child. In that stronger outcome the original trusted
      // frame must remain continuously mounted and ready.
      navigationCommitted = false;
      recoveredFrame = await waitForAuthFramePhase(frameNavigationPage, 'ready', 2_000);
      assert.equal(new URL(recoveredFrame.url()).hash, originalNavigationNonce);
      assert.equal(
        await frameNavigationPage.locator(GATE_SELECTOR).getAttribute('data-classpilot-auth-frame-status'),
        'trusted',
      );
    }
    const recoveredNavigationNonce = new URL(recoveredFrame.url()).hash;
    assert.match(recoveredNavigationNonce, /^#[a-f0-9]{64}$/);
    if (navigationCommitted) {
      assert.notEqual(
        recoveredNavigationNonce,
        originalNavigationNonce,
        'committed untrusted frame navigation did not rotate the secure-frame nonce',
      );
    }
    await frameNavigationPage.waitForTimeout(350);
    assert.equal(fixture.state.phishingInputEvents, 0, 'untrusted phishing frame received user input');
    await assertUnderlyingPageLocked(frameNavigationPage);

    // A later page-owned iframe at the maximum CSS z-index must be detached
    // even while the authentic host stays connected, so programmatic focus and
    // hit testing cannot reach its browsing context.
    const connectedFullscreenInputBaseline = fixture.state.phishingInputEvents;
    await frameNavigationPage.evaluate((phishingUrl) => {
      const hostileFrame = document.createElement('iframe');
      hostileFrame.id = 'hostile-connected-fullscreen-auth';
      hostileFrame.src = phishingUrl;
      hostileFrame.style.cssText = [
        'position:fixed',
        'inset:0',
        'width:100vw',
        'height:100vh',
        'border:0',
        'z-index:2147483647',
      ].join(';');
      window.__hostileConnectedFullscreenFrameRef = hostileFrame;
      document.body.appendChild(hostileFrame);
    }, `${fixture.origin}/phishing-frame?connected=1`);
    await frameNavigationPage.waitForFunction(() => {
      const authenticGate = document.getElementById('classpilot-auth-gate');
      const hostileFrame = window.__hostileConnectedFullscreenFrameRef;
      return hostileFrame?.isConnected === false
        && document.documentElement.lastElementChild === authenticGate
        && document.elementFromPoint(innerWidth / 2, innerHeight / 2) === authenticGate;
    }, undefined, { timeout: 7_000 });
    const connectedFocusAttack = await frameNavigationPage.evaluate(() => {
      const frame = window.__hostileConnectedFullscreenFrameRef;
      const childInput = frame?.contentDocument?.getElementById('hostile-phishing-input');
      childInput?.focus();
      frame?.contentWindow?.focus();
      return {
        frameConnected: frame?.isConnected ?? null,
        childInputFound: Boolean(childInput),
      };
    });
    assert.equal(connectedFocusAttack.frameConnected, false);
    await frameNavigationPage.keyboard.type('FORCED-CONNECTED-FRAME-FOCUS');
    await frameNavigationPage.mouse.click(683, 300);
    await frameNavigationPage.keyboard.press('P');
    await frameNavigationPage.waitForTimeout(100);
    assert.equal(
      fixture.state.phishingInputEvents,
      connectedFullscreenInputBaseline,
      `connected full-screen phishing iframe received click or keyboard input: ${JSON.stringify(connectedFocusAttack)}`,
    );

    // A hostile top-layer modal can outrank every z-index. The watchdog must
    // close it, quarantine its input, detach its iframe, and
    // restore the genuine gate as the visible hit-test target.
    const dialogInputBaseline = fixture.state.phishingInputEvents;
    const dialogResult = await frameNavigationPage.evaluate((phishingUrl) => {
      const dialog = document.createElement('dialog');
      dialog.id = 'hostile-auth-dialog';
      dialog.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;padding:0;border:0;z-index:2147483647';
      const hostileInput = document.createElement('input');
      hostileInput.id = 'hostile-dialog-input';
      hostileInput.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
      const hostileFrame = document.createElement('iframe');
      hostileFrame.id = 'hostile-dialog-frame';
      hostileFrame.src = phishingUrl;
      hostileFrame.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;border:0';
      window.__hostileDialogFrameRef = hostileFrame;
      window.__hostileDialogEvents = { clicks: 0, keys: 0, inputs: 0 };
      hostileInput.addEventListener('click', () => window.__hostileDialogEvents.clicks += 1);
      hostileInput.addEventListener('keydown', () => window.__hostileDialogEvents.keys += 1);
      hostileInput.addEventListener('input', () => window.__hostileDialogEvents.inputs += 1);
      dialog.append(hostileInput, hostileFrame);
      document.body.appendChild(dialog);
      try {
        dialog.showModal();
        return { supported: true, opened: dialog.open === true };
      } catch (error) {
        return { supported: false, opened: false, error: error?.message || String(error) };
      }
    }, `${fixture.origin}/phishing-frame?dialog=1`);
    if (dialogResult.supported) {
      await frameNavigationPage.waitForFunction(() => {
        const authenticGate = document.getElementById('classpilot-auth-gate');
        const dialog = document.getElementById('hostile-auth-dialog');
        const hostileFrame = window.__hostileDialogFrameRef;
        return dialog?.inert === true
          && dialog.open === false
          && hostileFrame?.isConnected === false
          && document.documentElement.lastElementChild === authenticGate
          && document.elementFromPoint(innerWidth / 2, innerHeight / 2) === authenticGate;
      }, undefined, { timeout: 7_000 });
      await frameNavigationPage.mouse.click(683, 300);
      await frameNavigationPage.keyboard.press('P');
      await frameNavigationPage.waitForTimeout(100);
      assert.deepEqual(
        await frameNavigationPage.evaluate(() => window.__hostileDialogEvents),
        { clicks: 0, keys: 0, inputs: 0 },
        'closed/inert top-layer phishing dialog received user interaction',
      );
      assert.equal(
        fixture.state.phishingInputEvents,
        dialogInputBaseline,
        'phishing iframe inside the hostile top-layer dialog received input',
      );
    }
    await frameNavigationPage.locator('#hostile-auth-dialog').evaluate((node) => node.remove());

    // HTML-level siblings sit outside body and must receive the same quarantine
    // as body children. Exercise both a max-z iframe and a modal dialog there.
    const htmlSiblingInputBaseline = fixture.state.phishingInputEvents;
    const htmlSiblingResult = await frameNavigationPage.evaluate((phishingUrl) => {
      const hostileFrame = document.createElement('iframe');
      hostileFrame.id = 'hostile-html-sibling-frame';
      hostileFrame.src = phishingUrl;
      hostileFrame.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;border:0;z-index:2147483647';
      window.__hostileHtmlSiblingFrameRef = hostileFrame;
      const dialog = document.createElement('dialog');
      dialog.id = 'hostile-html-sibling-dialog';
      dialog.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;padding:0;border:0;z-index:2147483647';
      const hostileInput = document.createElement('input');
      hostileInput.id = 'hostile-html-sibling-input';
      hostileInput.style.cssText = 'position:absolute;inset:0;width:100%;height:100%';
      window.__hostileHtmlSiblingEvents = { clicks: 0, keys: 0, inputs: 0 };
      hostileInput.addEventListener('click', () => window.__hostileHtmlSiblingEvents.clicks += 1);
      hostileInput.addEventListener('keydown', () => window.__hostileHtmlSiblingEvents.keys += 1);
      hostileInput.addEventListener('input', () => window.__hostileHtmlSiblingEvents.inputs += 1);
      dialog.appendChild(hostileInput);
      document.documentElement.append(hostileFrame, dialog);
      try {
        dialog.showModal();
        return { dialogSupported: true, dialogOpened: dialog.open === true };
      } catch (error) {
        return { dialogSupported: false, dialogOpened: false, error: error?.message || String(error) };
      }
    }, `${fixture.origin}/phishing-frame?html-sibling=1`);
    await frameNavigationPage.waitForFunction(() => {
      const authenticGate = document.getElementById('classpilot-auth-gate');
      const hostileFrame = window.__hostileHtmlSiblingFrameRef;
      const hostileDialog = document.getElementById('hostile-html-sibling-dialog');
      return hostileFrame?.isConnected === false
        && hostileDialog?.inert === true
        && hostileDialog.open === false
        && document.documentElement.lastElementChild === authenticGate
        && document.elementFromPoint(innerWidth / 2, innerHeight / 2) === authenticGate;
    }, undefined, { timeout: 7_000 });
    await frameNavigationPage.mouse.click(683, 300);
    await frameNavigationPage.keyboard.press('P');
    await frameNavigationPage.waitForTimeout(100);
    assert.deepEqual(
      await frameNavigationPage.evaluate(() => window.__hostileHtmlSiblingEvents),
      { clicks: 0, keys: 0, inputs: 0 },
      'HTML-sibling dialog input received interaction while the auth gate was active',
    );
    assert.equal(
      fixture.state.phishingInputEvents,
      htmlSiblingInputBaseline,
      'HTML-sibling phishing iframe received user interaction',
    );
    await frameNavigationPage.evaluate(() => {
      window.__hostileHtmlSiblingFrameRef?.remove();
      document.getElementById('hostile-html-sibling-dialog')?.remove();
    });

    // Removing the trusted host and replacing it with a full-screen phishing
    // iframe must not create an interactive gap. The isolated-world watchdog
    // detaches the hostile browsing context, rebuilds the authentic host, and rotates
    // the frame nonce before any credential UI is trusted again.
    const fullscreenInputBaseline = fixture.state.phishingInputEvents;
    await frameNavigationPage.evaluate((phishingUrl) => {
      document.getElementById('classpilot-auth-gate')?.remove();
      const hostileFrame = document.createElement('iframe');
      hostileFrame.id = 'hostile-fullscreen-auth';
      hostileFrame.src = phishingUrl;
      hostileFrame.style.cssText = [
        'position:fixed',
        'inset:0',
        'width:100vw',
        'height:100vh',
        'border:0',
        'z-index:2147483647',
      ].join(';');
      window.__hostileFullscreenFrameRef = hostileFrame;
      document.body.appendChild(hostileFrame);
    }, `${fixture.origin}/phishing-frame?fullscreen=1`);
    await frameNavigationPage.waitForFunction(() => {
      const authenticGate = document.getElementById('classpilot-auth-gate');
      const hostileFrame = window.__hostileFullscreenFrameRef;
      return authenticGate?.dataset.classpilotAuthRecovery === 'restored'
        && Number(authenticGate.dataset.classpilotAuthRecoverySerial || 0) > 0
        && hostileFrame?.isConnected === false
        && document.elementFromPoint(innerWidth / 2, innerHeight / 2) === authenticGate;
    }, undefined, { timeout: 7_000 });
    await frameNavigationPage.mouse.click(683, 300);
    await frameNavigationPage.keyboard.press('P');
    await frameNavigationPage.waitForTimeout(100);
    assert.equal(
      fixture.state.phishingInputEvents,
      fullscreenInputBaseline,
      'full-screen phishing iframe received click or keyboard input',
    );
    const recoveredFullscreenFrame = await waitForFreshAuthFrame(
      frameNavigationPage,
      recoveredNavigationNonce,
      'ready',
      7_000,
    );
    const recoveredFullscreenNonce = new URL(recoveredFullscreenFrame.url()).hash;
    assert.match(recoveredFullscreenNonce, /^#[a-f0-9]{64}$/);
    assert.notEqual(
      recoveredFullscreenNonce,
      recoveredNavigationNonce,
      'host-removal recovery reused the prior secure-frame nonce',
    );
    await assertUnderlyingPageLocked(frameNavigationPage);
    await frameNavigationPage.close();

    // Replacing the entire documentElement must not strand an observer on the
    // retired root. The Document-scoped watchdog rebuilds the trusted host on
    // the new root, quarantines its phishing subtree, and then stabilizes.
    const rootReplacementPage = await context.newPage();
    await rootReplacementPage.goto(`${fixture.origin}/document-root-replacement`, {
      waitUntil: 'domcontentloaded',
    });
    const rootReplacementOriginalFrame = await waitForAuthFramePhase(rootReplacementPage, 'ready', 7_000);
    const rootReplacementOriginalNonce = new URL(rootReplacementOriginalFrame.url()).hash;
    const rootReplacementPhishingBaseline = fixture.state.phishingInputEvents;
    const rootReplacementAttack = await rootReplacementPage.evaluate((phishingUrl) => {
      const replacementRoot = document.createElement('html');
      const replacementHead = document.createElement('head');
      const replacementBody = document.createElement('body');
      replacementBody.style.margin = '0';
      const hostileInput = document.createElement('input');
      hostileInput.id = 'root-replacement-control';
      hostileInput.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh';
      const hostileFrame = document.createElement('iframe');
      hostileFrame.id = 'root-replacement-frame';
      hostileFrame.src = phishingUrl;
      hostileFrame.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;border:0;z-index:2147483647';
      window.__rootReplacementFrameRef = hostileFrame;
      const hostileDialog = document.createElement('dialog');
      hostileDialog.id = 'root-replacement-dialog';
      hostileDialog.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;padding:0;border:0;z-index:2147483647';
      hostileDialog.appendChild(document.createElement('input'));
      replacementBody.append(hostileInput, hostileFrame, hostileDialog);
      replacementRoot.append(replacementHead, replacementBody);
      window.__underlyingInput = { clicks: 0, keys: 0, wheels: 0, touches: 0 };
      window.__underlyingControlInput = { clicks: 0, keys: 0, wheels: 0, touches: 0 };
      window.__underlyingEventLog = [];
      hostileInput.addEventListener('click', () => window.__underlyingControlInput.clicks += 1);
      hostileInput.addEventListener('keydown', () => window.__underlyingControlInput.keys += 1);
      hostileInput.addEventListener('wheel', () => window.__underlyingControlInput.wheels += 1);
      hostileInput.addEventListener('touchstart', () => window.__underlyingControlInput.touches += 1);
      document.replaceChild(replacementRoot, document.documentElement);
      try {
        hostileDialog.showModal();
        return { dialogSupported: true, dialogOpened: hostileDialog.open === true };
      } catch (error) {
        return { dialogSupported: false, dialogOpened: false, error: error?.message || String(error) };
      }
    }, `${fixture.origin}/phishing-frame?root-replacement=1`);
    const rootReplacementRecovery = await rootReplacementPage.waitForFunction(() => {
      const gate = document.getElementById('classpilot-auth-gate');
      const hostileFrame = window.__rootReplacementFrameRef;
      const hostileDialog = document.getElementById('root-replacement-dialog');
      if (
        gate?.dataset.classpilotAuthRecovery !== 'restored'
        || document.body?.inert !== true
        || hostileFrame?.isConnected !== false
        || hostileDialog?.inert !== true
        || hostileDialog.open !== false
        || document.documentElement.lastElementChild !== gate
        || document.elementFromPoint(innerWidth / 2, innerHeight / 2) !== gate
      ) return null;
      return gate.dataset.classpilotAuthRecoverySerial;
    }, undefined, { timeout: 7_000 });
    const rootReplacementRecoverySerial = await rootReplacementRecovery.jsonValue();
    const rootReplacementRecoveredFrame = await waitForFreshAuthFrame(
      rootReplacementPage,
      rootReplacementOriginalNonce,
      'ready',
      7_000,
    );
    const rootReplacementRecoveredNonce = new URL(rootReplacementRecoveredFrame.url()).hash;
    assert.notEqual(
      rootReplacementRecoveredNonce,
      rootReplacementOriginalNonce,
      'document-root replacement reused the retired secure-frame nonce',
    );
    await assertUnderlyingPageLocked(rootReplacementPage);
    assert.equal(
      fixture.state.phishingInputEvents,
      rootReplacementPhishingBaseline,
      'document-root replacement phishing frame received user interaction',
    );
    await rootReplacementPage.waitForTimeout(300);
    assert.equal(
      await rootReplacementPage.locator(GATE_SELECTOR).getAttribute('data-classpilot-auth-recovery-serial'),
      rootReplacementRecoverySerial,
      'document-root replacement recovery did not stabilize',
    );
    await rootReplacementPage.close();

    // SVG is not an HTMLElement and foreignObject can host an iframe. Remove
    // the secure host, add that surface directly under html, and prove the
    // all-Element quarantine disables the surface while its iframe is detached.
    const svgAttackPage = await context.newPage();
    await svgAttackPage.goto(`${fixture.origin}/svg-foreign-object-attack`, {
      waitUntil: 'domcontentloaded',
    });
    const svgOriginalFrame = await waitForAuthFramePhase(svgAttackPage, 'ready', 7_000);
    const svgOriginalNonce = new URL(svgOriginalFrame.url()).hash;
    const svgPhishingInputBaseline = fixture.state.phishingInputEvents;
    await svgAttackPage.evaluate((phishingUrl) => {
      document.getElementById('classpilot-auth-gate')?.remove();
      const hostileSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      hostileSvg.id = 'hostile-svg-auth-surface';
      hostileSvg.setAttribute('width', '100%');
      hostileSvg.setAttribute('height', '100%');
      hostileSvg.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;z-index:2147483647';
      const foreignObject = document.createElementNS('http://www.w3.org/2000/svg', 'foreignObject');
      foreignObject.setAttribute('width', '100%');
      foreignObject.setAttribute('height', '100%');
      const hostileFrame = document.createElement('iframe');
      hostileFrame.id = 'hostile-svg-auth-frame';
      hostileFrame.src = phishingUrl;
      hostileFrame.style.cssText = 'width:100%;height:100%;border:0';
      window.__hostileSvgFrameRef = hostileFrame;
      foreignObject.appendChild(hostileFrame);
      hostileSvg.appendChild(foreignObject);
      document.documentElement.appendChild(hostileSvg);
    }, `${fixture.origin}/phishing-frame?svg-foreign-object=1`);
    const svgRecovery = await svgAttackPage.waitForFunction(() => {
      const gate = document.getElementById('classpilot-auth-gate');
      const hostileSvg = document.getElementById('hostile-svg-auth-surface');
      const hostileFrame = window.__hostileSvgFrameRef;
      if (
        gate?.dataset.classpilotAuthRecovery !== 'restored'
        || hostileFrame?.isConnected !== false
        || !hostileSvg?.hasAttribute('inert')
        || hostileSvg.style.getPropertyValue('pointer-events') !== 'none'
        || hostileSvg.style.getPropertyPriority('pointer-events') !== 'important'
        || hostileSvg.style.getPropertyValue('display') !== 'none'
        || hostileSvg.style.getPropertyPriority('display') !== 'important'
        || document.documentElement.lastElementChild !== gate
        || document.elementFromPoint(innerWidth / 2, innerHeight / 2) !== gate
      ) return null;
      return gate.dataset.classpilotAuthRecoverySerial;
    }, undefined, { timeout: 7_000 });
    const svgRecoverySerial = await svgRecovery.jsonValue();
    const svgRecoveredFrame = await waitForFreshAuthFrame(svgAttackPage, svgOriginalNonce, 'ready', 7_000);
    assert.notEqual(new URL(svgRecoveredFrame.url()).hash, svgOriginalNonce);
    const svgFocusAttack = await svgAttackPage.evaluate(() => {
      const frame = window.__hostileSvgFrameRef;
      const childInput = frame?.contentDocument?.getElementById('hostile-phishing-input');
      childInput?.focus();
      frame?.contentWindow?.focus();
      const surface = document.getElementById('hostile-svg-auth-surface');
      return {
        childInputFound: Boolean(childInput),
        frameConnected: frame?.isConnected ?? null,
        parentActiveElement: document.activeElement?.id || document.activeElement?.tagName || null,
        childActiveElement: frame?.contentDocument?.activeElement?.id || frame?.contentDocument?.activeElement?.tagName || null,
        frameComputedDisplay: frame ? getComputedStyle(frame).display : null,
        surfaceInlineDisplay: surface?.style.getPropertyValue('display') || '',
        surfaceComputedDisplay: surface ? getComputedStyle(surface).display : null,
      };
    });
    assert.equal(svgFocusAttack.frameConnected, false);
    await svgAttackPage.keyboard.type('FORCED-SVG-FOCUS');
    await svgAttackPage.mouse.click(683, 300);
    await svgAttackPage.keyboard.press('P');
    await svgAttackPage.waitForTimeout(100);
    assert.equal(
      fixture.state.phishingInputEvents,
      svgPhishingInputBaseline,
      `SVG foreignObject phishing iframe received user interaction: ${JSON.stringify(svgFocusAttack)}`,
    );
    await assertUnderlyingPageLocked(svgAttackPage);
    await svgAttackPage.waitForTimeout(300);
    assert.equal(
      await svgAttackPage.locator(GATE_SELECTOR).getAttribute('data-classpilot-auth-recovery-serial'),
      svgRecoverySerial,
      'SVG foreignObject recovery entered a replacement loop',
    );
    await svgAttackPage.close();

    let firstAuthFrame = await waitForAuthFrame(firstPage);
    assert.equal(await firstAuthFrame.locator('#classpilot-auth-pin-submit').isDisabled(), true);
    await firstAuthFrame.locator('#classpilot-auth-student').selectOption('student-1');
    await firstAuthFrame.locator('#classpilot-auth-pin').fill('1234');
    await firstAuthFrame.waitForFunction(() => !document.getElementById('classpilot-auth-pin-submit')?.disabled);
    const persistedPresentationCache = await worker.evaluate(async () => {
      const stored = await chrome.storage.local.get('sharedSignInConfigCacheV1');
      return stored.sharedSignInConfigCacheV1 || null;
    });
    assert.equal(persistedPresentationCache?.loginMethod, 'name_pin');
    assert.equal(persistedPresentationCache?.sharedSignInEnabled, true);
    assert.deepEqual(
      Object.keys(persistedPresentationCache || {}).sort(),
      [
        'binding',
        'cachedAt',
        'configFetchedAt',
        'loginMethod',
        'passpilotKioskAvailable',
        'schemaVersion',
        'schoolId',
        'sharedSignInEnabled',
      ].sort(),
      'presentation cache contains fields outside the privacy-safe allowlist',
    );
    assert.deepEqual(persistedPresentationCache?.binding, {
      serverOrigin: fixture.origin,
      schoolId: 'cold-start-school',
      schoolSlug: 'cold-start-school',
    });
    assert.ok(
      Date.now() - Number(persistedPresentationCache?.cachedAt) < 24 * 60 * 60 * 1000,
      'presentation cache timestamp is outside its 24-hour lifetime',
    );
    assert.doesNotMatch(
      JSON.stringify(persistedPresentationCache),
      /enrollment|token|studentName|studentEmail|roster|credential/i,
      'presentation cache persisted authentication or roster material',
    );

    // A persisted presentation cache survives a full browser/worker restart,
    // but can only shape a disabled loading form until a new live response.
    const cachedRequestBaseline = fixture.state.loginConfigRequests;
    fixture.state.configDelayMs = 5_500;
    await context.close();
    context = await launchContext(executablePath, profilePath, extensionPath);
    firstPage = context.pages()[0] || await context.newPage();
    await firstPage.goto('chrome://version');
    const cachedStop = await stopExtensionWorker(context, firstPage, extensionId);
    assert.equal(cachedStop.stopped, true, 'could not stop the MV3 worker before cached restart');
    await firstPage.goto(`${fixture.origin}/cached-presentation`, { waitUntil: 'domcontentloaded' });
    await waitForGatePhase(firstPage, 'loading', LOADING_LIMIT_MS);
    worker = await waitForLiveWorker(context);
    firstAuthFrame = await waitForAuthFrame(firstPage);
    await firstAuthFrame.waitForSelector('form[aria-disabled="true"]');
    assert.match(await firstAuthFrame.locator('#classpilot-auth-gate').innerText(), /4-digit PIN/i);
    assert.equal(
      await firstAuthFrame.locator('#classpilot-auth-gate input:not([disabled]), #classpilot-auth-gate select:not([disabled]), #classpilot-auth-gate button:not([disabled])').count(),
      0,
      'persisted presentation cache enabled authentication controls before live configuration'
    );
    const cachedRequestDeadline = Date.now() + 4_000;
    while (fixture.state.loginConfigRequests === cachedRequestBaseline && Date.now() < cachedRequestDeadline) {
      await new Promise((resolvePoll) => setTimeout(resolvePoll, 25));
    }
    assert.equal(
      fixture.state.loginConfigRequests,
      cachedRequestBaseline + 1,
      'cached restart did not request fresh authoritative configuration'
    );
    await waitForGatePhase(firstPage, 'unavailable', 7_500);
    fixture.state.configDelayMs = 0;
    await requestRetryNow(firstPage, worker);
    await waitForGatePhase(firstPage, 'ready', 7_000);

    // Enterprise managed storage cannot be injected by Playwright. Exercise
    // the worker's actual pure conflict/kill-switch helpers deterministically
    // so removal, changed authority, and read failure all stay fail closed.
    const managedPolicyHarness = await worker.evaluate((serverUrl) => {
      const binding = {
        schemaVersion: 1,
        serverOrigin: new URL(serverUrl).origin,
        serverManaged: true,
        schoolId: 'cold-start-school',
        schoolIdManaged: true,
        schoolSlug: 'cold-start-school',
        schoolSlugManaged: true,
        enrollmentKeyManaged: true,
      };
      const stored = {
        deviceId: 'persisted-device',
        studentToken: 'persisted-token',
        activeStudentId: 'student-1',
        activeStudentSessionId: 'session-1',
        config: {
          serverUrl,
          schoolId: 'cold-start-school',
          schoolSlug: 'cold-start-school',
          enrollmentKey: 'fixture-enrollment-key',
        },
        [MANAGED_AUTH_GATE_BINDING_KEY]: binding,
      };
      const samePolicy = {
        serverUrl,
        schoolId: 'cold-start-school',
        schoolSlug: 'cold-start-school',
        enrollmentKey: 'fixture-enrollment-key',
      };
      const priorFastGate = fastAuthGateEnabled;
      applyManagedSchoolConfig({ fastAuthGateEnabled: false });
      const disabled = fastAuthGateEnabled === false;
      applyManagedSchoolConfig({ fastAuthGateEnabled: priorFastGate });
      return {
        same: managedPolicyConflictsWithStoredAuth(stored, samePolicy, serverUrl),
        bindingRemoved: managedPolicyConflictsWithStoredAuth(stored, {}, serverUrl),
        bindingChanged: managedPolicyConflictsWithStoredAuth(
          stored,
          { ...samePolicy, schoolId: 'different-school' },
          serverUrl,
        ),
        managedReadFailed: managedPolicyConflictsWithStoredAuth(
          { ...stored, [MANAGED_AUTH_GATE_BINDING_KEY]: undefined },
          {},
          serverUrl,
          { managedReadFailed: true, allowUnmanagedFallback: true },
        ),
        missingPriorMatchingPolicy: managedPolicyConflictsWithStoredAuth(
          { ...stored, [MANAGED_AUTH_GATE_BINDING_KEY]: undefined },
          samePolicy,
          serverUrl,
          { allowUnmanagedFallback: true },
        ),
        disabled,
      };
    }, fixture.origin);
    assert.deepEqual(managedPolicyHarness, {
      same: false,
      bindingRemoved: true,
      bindingChanged: true,
      managedReadFailed: true,
      missingPriorMatchingPolicy: false,
      disabled: true,
    });

    // On the first 2.6.6 upgrade there is no prior managed binding. A stale
    // custom server persisted by 2.6.5 must not survive when authoritative
    // managed school/enrollment policy omits serverUrl: reset to production,
    // invalidate the presentation cache, and fetch only from the default URL.
    const firstUpgradePolicyHarness = await worker.evaluate(async () => {
      const staleServerUrl = 'https://stale-first-upgrade.example';
      const managedConfig = {
        schoolId: 'first-upgrade-school',
        enrollmentKey: 'first-upgrade-enrollment',
      };
      const originalConfig = { ...CONFIG };
      const originalSharedConfig = { ...sharedSignInLoginConfig };
      const originalConfigGeneration = sharedSignInConfigGeneration;
      const originalRetryAttempt = sharedSignInConfigRetryAttempt;
      const originalConfigPromise = sharedSignInConfigPromise;
      const originalSetupUnavailable = managedAuthGateSetupUnavailable;
      const originalFetch = globalThis.fetch;
      const originalRemove = kv.remove;
      const originalStored = await chrome.storage.local.get([
        SHARED_SIGN_IN_CONFIG_CACHE_KEY,
        MANAGED_AUTH_GATE_BINDING_KEY,
      ]);
      const removedKeys = [];
      const requestedUrls = [];
      try {
        CONFIG.serverUrl = staleServerUrl;
        CONFIG.schoolId = 'stale-school';
        CONFIG.schoolSlug = null;
        CONFIG.enrollmentKey = 'stale-enrollment';
        managedAuthGateSetupUnavailable = false;
        sharedSignInLoginConfig = {
          ...sharedSignInLoginConfig,
          phase: 'ready',
          fetchedAt: Date.now(),
          sharedSignInEnabled: true,
          bindingKey: authGateConfigBindingKey(),
        };
        await chrome.storage.local.set({
          [SHARED_SIGN_IN_CONFIG_CACHE_KEY]: {
            schemaVersion: 1,
            cachedAt: Date.now(),
            configFetchedAt: Date.now(),
            binding: authGateConfigBinding(),
            sharedSignInEnabled: true,
            loginMethod: 'name_pin',
            schoolId: 'stale-school',
            passpilotKioskAvailable: true,
          },
        });
        kv.remove = async (keys) => {
          removedKeys.push(...(Array.isArray(keys) ? keys : [keys]));
          return originalRemove(keys);
        };
        globalThis.fetch = async (url) => {
          requestedUrls.push(String(url));
          return new Response(JSON.stringify({
            sharedSignInEnabled: true,
            loginMethod: 'name_pin',
            schoolId: 'first-upgrade-school',
            passpilotKioskAvailable: false,
          }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        };

        applyAuthoritativeManagedAuthGateSnapshot(managedConfig, undefined, false);
        const resetState = {
          serverUrl: CONFIG.serverUrl,
          binding: authGateConfigBinding(),
          phase: sharedSignInLoginConfig.phase,
        };
        const staleAuthConflicts = managedPolicyConflictsWithStoredAuth({
          deviceId: 'stale-device',
          studentToken: 'stale-token',
          activeStudentId: 'stale-student',
          activeStudentSessionId: 'stale-session',
          config: {
            serverUrl: staleServerUrl,
            schoolId: 'first-upgrade-school',
            enrollmentKey: 'first-upgrade-enrollment',
          },
        }, managedConfig, staleServerUrl, { allowUnmanagedFallback: false });
        await refreshSharedSignInLoginConfig({
          force: true,
          reason: 'first_upgrade_stale_server_test',
          managedConfigAlreadyApplied: true,
        });
        return {
          defaultServerUrl: DEFAULT_SERVER_URL,
          resetState,
          staleAuthConflicts,
          removedKeys,
          requestedUrls,
        };
      } finally {
        globalThis.fetch = originalFetch;
        kv.remove = originalRemove;
        CONFIG = originalConfig;
        sharedSignInLoginConfig = originalSharedConfig;
        sharedSignInConfigGeneration = originalConfigGeneration;
        sharedSignInConfigRetryAttempt = originalRetryAttempt;
        sharedSignInConfigPromise = originalConfigPromise;
        managedAuthGateSetupUnavailable = originalSetupUnavailable;
        chrome.alarms?.clear?.(SHARED_SIGN_IN_CONFIG_RETRY_ALARM);
        const restore = {};
        const remove = [];
        for (const key of [SHARED_SIGN_IN_CONFIG_CACHE_KEY, MANAGED_AUTH_GATE_BINDING_KEY]) {
          if (Object.prototype.hasOwnProperty.call(originalStored, key)) restore[key] = originalStored[key];
          else remove.push(key);
        }
        if (Object.keys(restore).length > 0) await chrome.storage.local.set(restore);
        if (remove.length > 0) await chrome.storage.local.remove(remove);
      }
    });
    assert.equal(
      firstUpgradePolicyHarness.resetState.serverUrl,
      firstUpgradePolicyHarness.defaultServerUrl,
    );
    assert.deepEqual(firstUpgradePolicyHarness.resetState.binding, {
      serverOrigin: new URL(firstUpgradePolicyHarness.defaultServerUrl).origin,
      schoolId: 'first-upgrade-school',
      schoolSlug: null,
    });
    assert.equal(firstUpgradePolicyHarness.resetState.phase, 'loading');
    assert.equal(firstUpgradePolicyHarness.staleAuthConflicts, true);
    assert.ok(
      firstUpgradePolicyHarness.removedKeys.includes('sharedSignInConfigCacheV1'),
      'first-upgrade policy did not request persisted presentation-cache removal',
    );
    assert.ok(firstUpgradePolicyHarness.requestedUrls.length >= 1);
    const firstUpgradeLoginConfigUrls = [];
    for (const requestedUrl of firstUpgradePolicyHarness.requestedUrls) {
      const firstUpgradeRequestUrl = new URL(requestedUrl);
      assert.equal(
        firstUpgradeRequestUrl.origin,
        new URL(firstUpgradePolicyHarness.defaultServerUrl).origin,
      );
      if (firstUpgradeRequestUrl.pathname === '/api/extension/login-config') {
        firstUpgradeLoginConfigUrls.push(firstUpgradeRequestUrl);
        assert.equal(firstUpgradeRequestUrl.searchParams.get('schoolId'), 'first-upgrade-school');
      }
    }
    assert.ok(firstUpgradeLoginConfigUrls.length >= 1, 'first-upgrade refresh did not request login config');
    assert.equal(
      firstUpgradePolicyHarness.requestedUrls.some((url) => url.startsWith('https://stale-first-upgrade.example')),
      false,
      'first-upgrade refresh contacted the stale pre-2.6.6 server',
    );

    const strictAuthHarness = await worker.evaluate(() => {
      const prior = {
        deviceId: CONFIG.deviceId,
        studentToken: CONFIG.studentToken,
        activeStudentId: CONFIG.activeStudentId,
        activeStudentSessionId: CONFIG.activeStudentSessionId,
      };
      const priorInvalidating = studentAuthInvalidating;
      const complete = {
        deviceId: 'device-1',
        studentToken: 'token-1',
        activeStudentId: 'student-1',
        activeStudentSessionId: 'session-1',
      };
      const sample = (missingField = null, invalidating = false) => {
        Object.assign(CONFIG, complete);
        if (missingField) CONFIG[missingField] = null;
        studentAuthInvalidating = invalidating;
        return hasStudentAuth();
      };
      try {
        return {
          complete: sample(),
          missingDeviceId: sample('deviceId'),
          missingToken: sample('studentToken'),
          missingStudentId: sample('activeStudentId'),
          missingSessionId: sample('activeStudentSessionId'),
          invalidating: sample(null, true),
        };
      } finally {
        Object.assign(CONFIG, prior);
        studentAuthInvalidating = priorInvalidating;
      }
    });
    assert.deepEqual(strictAuthHarness, {
      complete: true,
      missingDeviceId: false,
      missingToken: false,
      missingStudentId: false,
      missingSessionId: false,
      invalidating: false,
    });

    // Exhausting a reserved revision block must never publish a repeated or
    // unreserved state. Simulate a strict storage failure at the boundary and
    // prove both the direct publication barrier and tab enforcement fail
    // closed before chrome.tabs.sendMessage can run.
    const revisionFailureTabId = await tabIdFor(worker, firstPage);
    const revisionStorageFailure = await worker.evaluate(async (tabId) => {
      const originalSet = durableLocalKv.set;
      const originalSendMessage = chrome.tabs.sendMessage;
      const originalRevision = authGateStateRevision;
      const originalCeiling = authGateStateRevisionCeiling;
      const originalPendingBumps = authGateStatePendingRevisionBumps;
      const originalExtensionPromise = authGateRevisionExtensionPromise;
      let sendCount = 0;
      let directRejected = false;
      try {
        durableLocalKv.set = async (value) => {
          if (Object.prototype.hasOwnProperty.call(value || {}, AUTH_GATE_REVISION_STORAGE_KEY)) {
            throw new Error('injected revision storage failure');
          }
          return originalSet(value);
        };
        chrome.tabs.sendMessage = async (...args) => {
          sendCount += 1;
          return originalSendMessage.apply(chrome.tabs, args);
        };
        authGateStateRevision = authGateStateRevisionCeiling;
        authGateStatePendingRevisionBumps = 0;
        authGateRevisionExtensionPromise = null;
        bumpAuthGateStateRevision();
        try {
          await getPublishableAuthGateState();
        } catch (error) {
          directRejected = /revision storage failure/i.test(error?.message || '');
        }
        await enforceAuthGateForTab(tabId, { triggerRefresh: false });
        await authGateRevisionExtensionPromise?.catch(() => {});
        return {
          directRejected,
          sendCount,
          pendingBumps: authGateStatePendingRevisionBumps,
        };
      } finally {
        durableLocalKv.set = originalSet;
        chrome.tabs.sendMessage = originalSendMessage;
        authGateStateRevision = originalRevision;
        authGateStateRevisionCeiling = originalCeiling;
        authGateStatePendingRevisionBumps = originalPendingBumps;
        authGateRevisionExtensionPromise = originalExtensionPromise;
      }
    }, revisionFailureTabId);
    assert.equal(revisionStorageFailure.directRejected, true);
    assert.equal(revisionStorageFailure.sendCount, 0);
    assert.equal(revisionStorageFailure.pendingBumps, 1);

    // The same gate root transitions between supported live login methods.
    await firstPage.locator(GATE_SELECTOR).evaluate((node) => {
      node.dataset.startupTestRoot = 'preserve-me';
    });
    await pushAuthState(worker, firstPage, {
      authRequired: true, phase: 'ready', loginMethod: 'email_id',
      sharedSignInEnabled: true, configFetchedAt: Date.now(), retryAt: null,
    });
    firstAuthFrame = await waitForAuthFrame(firstPage);
    await firstAuthFrame.waitForSelector('#classpilot-auth-email-form');
    assert.equal(
      await firstPage.locator(GATE_SELECTOR).getAttribute('data-startup-test-root'),
      'preserve-me',
      'gate root was replaced during live upgrade'
    );

    await pushAuthState(worker, firstPage, {
      authRequired: true, phase: 'loading', loginMethod: 'name_pin',
      sharedSignInEnabled: true, configFetchedAt: null, retryAt: Date.now() + 2_000,
    });
    await waitForGatePhase(firstPage, 'loading');
    firstAuthFrame = await waitForAuthFrame(firstPage);
    const enabledLoadingControls = await firstAuthFrame.locator('#classpilot-auth-gate input:not([disabled]), #classpilot-auth-gate select:not([disabled]), #classpilot-auth-gate button:not([disabled])').count();
    assert.equal(enabledLoadingControls, 0, 'cached/loading presentation enabled authentication controls');

    // Connectivity failures remain distinct from school setup failures and
    // expose an explicit retry path.
    await pushAuthState(worker, firstPage, {
      authRequired: true, phase: 'unavailable', loginMethod: 'name_pin',
      sharedSignInEnabled: true, configFetchedAt: null, retryAt: Date.now() + 2_000,
    });
    await waitForGatePhase(firstPage, 'unavailable');
    firstAuthFrame = await waitForAuthFrame(firstPage);
    assert.equal(await firstAuthFrame.locator('#classpilot-auth-retry').isVisible(), true);
    await pushAuthState(worker, firstPage, {
      authRequired: true, phase: 'setup_required', loginMethod: 'name_pin',
      setupRequired: true, sharedSignInEnabled: false, configFetchedAt: Date.now(), retryAt: null,
    });
    await waitForGatePhase(firstPage, 'setup_required');
    firstAuthFrame = await waitForAuthFrame(firstPage);
    assert.equal(await firstAuthFrame.locator('#classpilot-auth-retry').count(), 0, 'setup failure was rendered as a connectivity retry');
    await pushAuthState(worker, firstPage, {
      authRequired: true, phase: 'loading', fastAuthGateEnabled: false,
      setupRequired: false, loginMethod: 'name_pin', configFetchedAt: null, retryAt: null,
    });
    await firstPage.waitForSelector(GATE_SELECTOR, { state: 'detached' });
    assert.equal(await firstPage.locator(GATE_SELECTOR).count(), 0, 'kill switch did not restore wait-before-paint behavior');

    // Exercise the authoritative worker failure classifier where supported.
    // The direct UI contract above keeps this test useful while older Chrome
    // versions drain an already-cached request during extension reload.
    const networkPage = await context.newPage();
    await networkPage.goto(`${fixture.origin}/network-classifier`, { waitUntil: 'domcontentloaded' });
    await waitForGatePhase(networkPage, 'ready', 7_000);
    for (const status of [429, 503]) {
      fixture.state.configDelayMs = 0;
      fixture.state.configStatus = status;
      fixture.state.configBody = { error: status === 429 ? 'rate_limited' : 'unavailable' };
      await requestLiveRefresh(worker);
      await waitForGatePhase(networkPage, 'unavailable', 7_000);
    }
    fixture.state.configStatus = 404;
    fixture.state.configBody = { error: 'unknown_school' };
    await requestLiveRefresh(worker);
    await waitForGatePhase(networkPage, 'setup_required', 7_000);

    fixture.state.configStatus = 200;
    fixture.state.configDelayMs = 6_000;
    fixture.state.configBody = {
      sharedSignInEnabled: true,
      loginMethod: 'name_pin',
      schoolId: 'cold-start-school',
    };
    await requestLiveRefresh(worker);
    await waitForGatePhase(networkPage, 'unavailable', 7_500);

    fixture.state.configDelayMs = 0;
    fixture.state.configDisconnect = true;
    await requestLiveRefresh(worker);
    await waitForGatePhase(networkPage, 'unavailable', 7_000);

    fixture.state.configDisconnect = false;
    fixture.state.configStallBody = true;
    const stalledConfigRefresh = requestLiveRefresh(worker);
    await waitForGatePhase(networkPage, 'unavailable', 7_500);
    await stalledConfigRefresh;
    fixture.state.configStallBody = false;
    fixture.state.configStatus = 200;
    fixture.state.configBody = {
      sharedSignInEnabled: true,
      loginMethod: 'name_pin',
      schoolId: 'cold-start-school',
      passpilotKioskAvailable: true,
    };
    await requestRetryNow(networkPage, worker);
    await waitForGatePhase(networkPage, 'ready', 7_000);

    await context.setOffline(true);
    await requestLiveRefresh(worker);
    await waitForGatePhase(networkPage, 'unavailable', 7_000);
    const offlineFrame = await waitForAuthFrame(networkPage);
    assert.equal(await offlineFrame.locator('#classpilot-auth-retry').isVisible(), true);
    await context.setOffline(false);
    await requestLiveRefresh(worker);
    await waitForGatePhase(networkPage, 'ready', 7_000);

    const validConfigBody = {
      sharedSignInEnabled: true,
      loginMethod: 'name_pin',
      schoolId: 'cold-start-school',
      passpilotKioskAvailable: true,
    };
    for (const scenario of [
      { name: 'malformed-json', rawBody: '{' },
      { name: 'non-object-json', rawBody: 'true' },
      { name: 'missing-enabled', body: { loginMethod: 'name_pin', schoolId: 'cold-start-school' } },
      {
        name: 'string-enabled',
        body: { sharedSignInEnabled: 'true', loginMethod: 'name_pin', schoolId: 'cold-start-school' },
      },
    ]) {
      fixture.state.configStatus = 200;
      fixture.state.configDelayMs = 0;
      fixture.state.configDisconnect = false;
      fixture.state.configStallBody = false;
      fixture.state.configRawBody = scenario.rawBody ?? null;
      fixture.state.configBody = scenario.body ?? validConfigBody;
      await requestLiveRefresh(worker);
      await waitForGatePhase(networkPage, 'unavailable', 7_000);
      const invalidFrame = await waitForAuthFrame(networkPage);
      assert.equal(
        await invalidFrame.locator('#classpilot-auth-retry').isVisible(),
        true,
        `${scenario.name} did not expose Retry now`,
      );
      fixture.state.configRawBody = null;
      fixture.state.configBody = validConfigBody;
      await requestLiveRefresh(worker);
      await waitForGatePhase(networkPage, 'ready', 7_000);
    }

    fixture.state.configBody = {
      sharedSignInEnabled: false,
      loginMethod: 'name_pin',
      schoolId: 'cold-start-school',
    };
    await requestLiveRefresh(worker);
    await waitForGatePhase(networkPage, 'setup_required', 7_000);
    const disabledSignInFrame = await waitForAuthFrame(networkPage);
    assert.equal(
      await disabledSignInFrame.locator('#classpilot-auth-retry').count(),
      0,
      'authoritative shared-sign-in disablement was treated as a connectivity failure',
    );
    fixture.state.configBody = validConfigBody;
    await requestLiveRefresh(worker);
    await waitForGatePhase(networkPage, 'ready', 7_000);

    // Roster fetches use the same UI-critical timeout and connectivity
    // classifier as login configuration. Each failure must retain the lock and
    // recover through the visible Retry now action.
    for (const scenario of [
      { name: '429', status: 429, delayMs: 0 },
      { name: '5xx', status: 503, delayMs: 0 },
      { name: 'timeout', status: 200, delayMs: 6_000 },
      { name: 'stalled-body', status: 200, delayMs: 0, stallBody: true },
    ]) {
      fixture.state.rosterStatus = scenario.status;
      fixture.state.rosterDelayMs = scenario.delayMs;
      fixture.state.rosterStallBody = scenario.stallBody === true;
      fixture.state.rosterRawBody = null;
      await worker.evaluate(() => resetLoginRosterRuntimeCache());
      const rosterPage = await context.newPage();
      await rosterPage.goto(`${fixture.origin}/roster-${scenario.name}`, { waitUntil: 'domcontentloaded' });
      let rosterFrame = await waitForAuthFramePhase(rosterPage, 'unavailable', 7_500);
      assert.equal(await rosterFrame.locator('#classpilot-auth-retry').isVisible(), true);
      fixture.state.rosterStatus = 200;
      fixture.state.rosterDelayMs = 0;
      fixture.state.rosterStallBody = false;
      // Production honors the server/automatic retry boundary even when the
      // user presses Retry now. Advance this test cohort past that boundary
      // without making the suite wait up to 35 seconds per scenario.
      await worker.evaluate(() => {
        for (const cacheKey of loginRosterBackoffUntil.keys()) {
          loginRosterBackoffUntil.set(cacheKey, Date.now() - 1);
        }
      });
      await requestRetryNow(rosterPage, worker);
      rosterFrame = await waitForAuthFramePhase(rosterPage, 'ready', 7_000);
      await rosterFrame.locator('#classpilot-auth-student option[value="student-1"]').waitFor({ state: 'attached', timeout: 7_000 });
      await rosterPage.close();
    }

    for (const scenario of [
      { name: 'malformed-json', rawBody: '{' },
      { name: 'non-object-json', rawBody: 'true' },
      { name: 'empty-body', rawBody: '' },
    ]) {
      fixture.state.rosterStatus = 200;
      fixture.state.rosterDelayMs = 0;
      fixture.state.rosterStallBody = false;
      fixture.state.rosterRawBody = scenario.rawBody;
      await worker.evaluate(() => resetLoginRosterRuntimeCache());
      const rosterPage = await context.newPage();
      await rosterPage.goto(`${fixture.origin}/roster-${scenario.name}`, { waitUntil: 'domcontentloaded' });
      let rosterFrame = await waitForAuthFramePhase(rosterPage, 'unavailable', 7_500);
      assert.equal(
        await rosterFrame.locator('#classpilot-auth-retry').isVisible(),
        true,
        `${scenario.name} roster response did not expose Retry now`,
      );
      fixture.state.rosterRawBody = null;
      await worker.evaluate(() => {
        for (const cacheKey of loginRosterBackoffUntil.keys()) {
          loginRosterBackoffUntil.set(cacheKey, Date.now() - 1);
        }
      });
      await requestRetryNow(rosterPage, worker);
      rosterFrame = await waitForAuthFramePhase(rosterPage, 'ready', 7_000);
      await rosterFrame.locator('#classpilot-auth-student option[value="student-1"]').waitFor({
        state: 'attached',
        timeout: 7_000,
      });
      await rosterPage.close();
    }

    // Exact-origin kiosk pages are exempt; a lookalike origin with the same
    // path remains locked.
    const exactKiosk = await context.newPage();
    await exactKiosk.goto(`${fixture.origin}/passpilot/kiosk/simple`, { waitUntil: 'domcontentloaded' });
    await exactKiosk.waitForTimeout(300);
    assert.equal(await exactKiosk.locator(GATE_SELECTOR).count(), 0, 'exact kiosk origin was gated');
    const lookalike = await context.newPage();
    const lookalikeOrigin = fixture.origin.replace('127.0.0.1', 'localhost');
    await lookalike.goto(`${lookalikeOrigin}/passpilot/kiosk/simple`, { waitUntil: 'domcontentloaded' });
    await lookalike.waitForSelector(GATE_SELECTOR, { timeout: LOADING_LIMIT_MS });

    // Complete the real email/ID flow while an older configuration request is
    // still pending. Authentication must remove the gate, and that older
    // response must not paint it again when it eventually completes.
    fixture.state.configDelayMs = 0;
    fixture.state.configStatus = 200;
    fixture.state.configBody = {
      sharedSignInEnabled: true,
      loginMethod: 'email_id',
      schoolId: 'cold-start-school',
      passpilotKioskAvailable: true,
    };
    await requestLiveRefresh(worker);
    let networkAuthFrame = await waitForAuthFrame(networkPage);
    await networkAuthFrame.waitForSelector('#classpilot-auth-email-form');
    fixture.state.configDelayMs = 4_000;
    const staleConfigRequestBaseline = fixture.state.loginConfigRequests;
    const staleConfigRequest = requestLiveRefresh(worker);
    const staleConfigRequestDeadline = Date.now() + 2_000;
    while (fixture.state.loginConfigRequests === staleConfigRequestBaseline && Date.now() < staleConfigRequestDeadline) {
      await new Promise((resolvePoll) => setTimeout(resolvePoll, 25));
    }
    assert.equal(
      fixture.state.loginConfigRequests,
      staleConfigRequestBaseline + 1,
      'stale configuration request was not in flight before authentication'
    );
    networkAuthFrame = await waitForAuthFrame(networkPage);
    assert.equal(
      await networkPage.locator('#classpilot-auth-email, #classpilot-auth-student-id, #classpilot-auth-pin').count(),
      0,
      'credential fields leaked into the hostile host-page DOM'
    );
    const hostCredentialEventsBefore = await networkPage.evaluate(() => ({
      underlying: { ...window.__underlyingInput },
      credentialLeakEvents: { ...window.__credentialLeakEvents },
    }));
    await networkAuthFrame.locator('#classpilot-auth-email').pressSequentially('jordan@example.edu');
    await networkAuthFrame.locator('#classpilot-auth-student-id').pressSequentially('S-1001');
    const hostCredentialEventsAfter = await networkPage.evaluate(() => ({
      underlying: { ...window.__underlyingInput },
      credentialLeakEvents: { ...window.__credentialLeakEvents },
    }));
    assert.deepEqual(
      hostCredentialEventsAfter,
      hostCredentialEventsBefore,
      'host page observed credential-frame keyboard or input events'
    );

    const criticalFenceInstalled = await worker.evaluate(() => {
      if (globalThis.__classpilotStartupCriticalFence) return false;
      const originalApply = applyClassroomStateFromAuthResponse;
      let releaseFence;
      const fence = new Promise((resolveFence) => {
        releaseFence = resolveFence;
      });
      globalThis.__classpilotStartupCriticalFence = {
        entered: false,
        release: releaseFence,
      };
      applyClassroomStateFromAuthResponse = async (...args) => {
        globalThis.__classpilotStartupCriticalFence.entered = true;
        await fence;
        applyClassroomStateFromAuthResponse = originalApply;
        return originalApply(...args);
      };
      return true;
    });
    assert.equal(criticalFenceInstalled, true, 'could not install the critical classroom-apply fence');
    await networkAuthFrame.locator('#classpilot-auth-email-submit').click();
    let criticalFenceState = null;
    const criticalFenceDeadline = Date.now() + 7_000;
    while (Date.now() < criticalFenceDeadline) {
      criticalFenceState = await worker.evaluate(async () => {
        const persisted = await getStoredAuthState([
          'deviceId',
          'studentToken',
          'activeStudentId',
          'activeStudentSessionId',
          'studentAuthCommitPendingV1',
        ]);
        const state = getAuthGateState();
        return {
          entered: globalThis.__classpilotStartupCriticalFence?.entered === true,
          persistedExactBinding: Boolean(
            persisted.deviceId && persisted.studentToken &&
            persisted.activeStudentId && persisted.activeStudentSessionId
          ),
          publicAuthenticated: hasStudentAuth(),
          workerPhase: state.phase,
          authRequired: state.authRequired,
          persistedCommitPending: persisted.studentAuthCommitPendingV1 === true,
          inMemoryCommitPending: studentAuthCommitPending === true,
        };
      });
      if (criticalFenceState.entered && criticalFenceState.persistedExactBinding) break;
      await new Promise((resolvePoll) => setTimeout(resolvePoll, 25));
    }
    assert.equal(criticalFenceState?.entered, true);
    assert.equal(criticalFenceState?.persistedExactBinding, true);
    assert.equal(criticalFenceState?.publicAuthenticated, false);
    assert.notEqual(criticalFenceState?.workerPhase, 'authenticated');
    assert.equal(criticalFenceState?.authRequired, true);
    assert.equal(criticalFenceState?.persistedCommitPending, true);
    assert.equal(criticalFenceState?.inMemoryCommitPending, true);
    assert.equal(
      await networkPage.locator(GATE_SELECTOR).count(),
      1,
      'gate closed before login-provided classroom restrictions were applied',
    );
    await assertUnderlyingPageLocked(networkPage);
    await worker.evaluate(() => globalThis.__classpilotStartupCriticalFence.release());
    try {
      await networkPage.waitForSelector(GATE_SELECTOR, { state: 'detached', timeout: 12_000 });
    } catch (error) {
      const diagnostic = {
        framePhase: await networkAuthFrame.locator('#classpilot-auth-gate').getAttribute('data-classpilot-auth-phase').catch(() => null),
        frameError: await networkAuthFrame.locator('#classpilot-auth-error').textContent().catch(() => null),
        workerState: await worker.evaluate(() => getAuthGateState()).catch(() => null),
        loginRequests: fixture.state.studentLoginRequests.length,
      };
      throw new Error(`email/ID sign-in did not release the gate: ${JSON.stringify(diagnostic)}`, { cause: error });
    }
    await staleConfigRequest;
    await networkPage.waitForTimeout(200);
    assert.equal(await networkPage.locator(GATE_SELECTOR).count(), 0, 'stale config response re-gated an authenticated student');
    assert.deepEqual(
      fixture.state.studentLoginRequests.at(-1) && {
        studentEmail: fixture.state.studentLoginRequests.at(-1).studentEmail,
        studentIdNumber: fixture.state.studentLoginRequests.at(-1).studentIdNumber,
      },
      { studentEmail: 'jordan@example.edu', studentIdNumber: 'S-1001' },
      'email/ID form did not submit the expected credentials'
    );

    const committedManualStorage = await worker.evaluate(async () => ({
      local: await chrome.storage.local.get([
        'studentToken',
        'activeStudentId',
        'activeStudentSessionId',
        'studentName',
        'studentEmail',
        'studentSessionRecoveryV1',
      ]),
      session: await chrome.storage.session.get([
        'studentToken',
        'activeStudentId',
        'activeStudentSessionId',
      ]),
    }));
    assert.equal(committedManualStorage.local.studentToken, undefined);
    assert.equal(committedManualStorage.local.activeStudentId, undefined);
    assert.equal(committedManualStorage.local.activeStudentSessionId, undefined);
    assert.equal(committedManualStorage.local.studentName, undefined);
    assert.equal(committedManualStorage.local.studentEmail, undefined);
    assert.equal(committedManualStorage.session.studentToken, 'fixture-token');
    assert.equal(committedManualStorage.session.activeStudentId, 'student-1');
    assert.equal(committedManualStorage.session.activeStudentSessionId, 'fixture-session');
    assert.equal(
      committedManualStorage.local.studentSessionRecoveryV1?.armed?.token,
      'R'.repeat(43),
    );

    const releasesBeforeOrdinaryTabClose = fixture.state.sessionReleaseRequests;
    const ordinaryTab = await context.newPage();
    await ordinaryTab.goto(`${fixture.origin}/ordinary-tab-close`, { waitUntil: 'domcontentloaded' });
    await ordinaryTab.close();
    await networkPage.waitForTimeout(150);
    const afterOrdinaryTabClose = await worker.evaluate(() => ({
      authenticated: hasStudentAuth(),
      armed: Boolean(studentSessionRecoveryState.armed),
    }));
    assert.deepEqual(afterOrdinaryTabClose, { authenticated: true, armed: true });
    assert.equal(fixture.state.sessionReleaseRequests, releasesBeforeOrdinaryTabClose);

    // Stopping only the MV3 worker preserves storage.session and the exact
    // armed recovery context; this must not be mistaken for a browser restart.
    const oldExactLicenseLkg = await worker.evaluate(async () => {
      const authContext = captureAuthenticatedContext('old exact license LKG fixture');
      const scope = licenseScopeForAuthContext(authContext);
      const verifiedAt = Date.now() - (365 * 24 * 60 * 60 * 1000);
      await chrome.storage.local.set({
        licenseActive: true,
        planStatus: 'old-exact-lkg',
      });
      await chrome.storage.session.set({
        licenseStateScopeV1: scope,
        licenseLastVerifiedAtV1: verifiedAt,
      });
      return { scope, verifiedAt };
    });
    assert.ok(oldExactLicenseLkg.scope);
    fixture.state.schoolStatusStallBody = true;
    const heartbeatRequestsBeforeLkgWake = fixture.state.heartbeatRequests;
    const schoolStatusRequestsBeforeLkgWake = fixture.state.schoolStatusRequests;
    const suspensionPage = await context.newPage();
    await suspensionPage.goto('chrome://version');
    const suspensionStop = await stopExtensionWorker(context, suspensionPage, extensionId);
    assert.equal(suspensionStop.stopped, true, 'could not suspend the MV3 worker');
    await suspensionPage.goto(`${fixture.origin}/mv3-worker-suspension`, {
      waitUntil: 'domcontentloaded',
    });
    worker = await waitForLiveWorker(context);
    const suspensionAuthState = await worker.evaluate(async () => {
      await authStateRestorePromise;
      return {
        phase: getAuthGateState().phase,
        recoveryState: studentSessionRecoveryState.armed?.state || null,
      };
    });
    assert.deepEqual(suspensionAuthState, {
      phase: 'authenticated',
      recoveryState: 'armed',
    });
    assert.equal(await suspensionPage.locator(GATE_SELECTOR).count(), 0);
    let lkgWakeState = null;
    const lkgWakeDeadline = Date.now() + 16_000;
    while (Date.now() < lkgWakeDeadline) {
      lkgWakeState = await worker.evaluate(async () => {
        await authStateRestorePromise;
        const heartbeatAlarm = await chrome.alarms.get('heartbeat');
        const screenshotAlarm = await chrome.alarms.get('screenshot-capture');
        return {
          licenseActive: currentLicenseIsActive(),
          licenseRefreshState,
          licensePlanStatus,
          trackingState,
          heartbeatAlarm: Boolean(heartbeatAlarm),
          screenshotAlarm: Boolean(screenshotAlarm),
          screenshotPolicyMode: screenshotPolicyState.mode,
          screenshotCaptureAllowed: ambientScreenshotAllowed(
            captureAuthenticatedContext('old exact license LKG assertion'),
          ),
          schoolSettingsScope,
          expectedSchoolSettingsScope: schoolPolicyScopeForAuthContext(
            captureAuthenticatedContext('old exact license LKG settings assertion'),
          ),
          schoolSettingsValid: validSchoolSettingsPayload(schoolSettings),
          offHoursNetworkPaused,
          apiBackoffRemainingMs: Math.max(0, apiBackoffUntilMs - Date.now()),
        };
      });
      lkgWakeState.extensionSettingsRequests = fixture.state.extensionSettingsRequests;
      lkgWakeState.heartbeatRequests = fixture.state.heartbeatRequests;
      if (
        lkgWakeState.licenseActive
        && lkgWakeState.trackingState !== 'OFF'
        && lkgWakeState.heartbeatAlarm
        && lkgWakeState.screenshotAlarm
        && lkgWakeState.screenshotCaptureAllowed
      ) break;
      await new Promise((resolvePoll) => setTimeout(resolvePoll, 100));
    }
    fixture.state.schoolStatusStallBody = false;
    assert.equal(lkgWakeState?.licenseActive, true, JSON.stringify(lkgWakeState));
    assert.equal(lkgWakeState?.licensePlanStatus, 'old-exact-lkg');
    assert.notEqual(lkgWakeState?.trackingState, 'OFF', JSON.stringify(lkgWakeState));
    assert.equal(lkgWakeState?.heartbeatAlarm, true, JSON.stringify(lkgWakeState));
    assert.equal(lkgWakeState?.screenshotAlarm, true, JSON.stringify(lkgWakeState));
    assert.equal(lkgWakeState?.screenshotPolicyMode, 'tracking_window_lease');
    assert.equal(lkgWakeState?.screenshotCaptureAllowed, true);
    assert.ok(fixture.state.heartbeatRequests > heartbeatRequestsBeforeLkgWake);
    assert.ok(fixture.state.schoolStatusRequests > schoolStatusRequestsBeforeLkgWake);

    // Repeat the real MV3 termination boundary for every non-authoritative
    // status outcome. None may erase the exact-session active LKG or delay
    // tracking startup; each worker must recreate its alarms and obtain a
    // fresh tracking-window authority from heartbeat independently.
    for (const statusScenario of [
      { name: 'malformed', status: 200, rawBody: '{not-json' },
      { name: '429', status: 429, rawBody: JSON.stringify({ error: 'rate_limited' }) },
      { name: '500', status: 500, rawBody: JSON.stringify({ error: 'server_error' }) },
    ]) {
      fixture.state.schoolStatusStatus = statusScenario.status;
      fixture.state.schoolStatusRawBody = statusScenario.rawBody;
      const heartbeatRequestsBeforeScenario = fixture.state.heartbeatRequests;
      const schoolStatusRequestsBeforeScenario = fixture.state.schoolStatusRequests;
      await suspensionPage.goto('chrome://version');
      const scenarioStop = await stopExtensionWorker(context, suspensionPage, extensionId);
      assert.equal(
        scenarioStop.stopped,
        true,
        `could not suspend the MV3 worker for ${statusScenario.name} license status`,
      );
      await suspensionPage.goto(`${fixture.origin}/mv3-license-${statusScenario.name}`, {
        waitUntil: 'domcontentloaded',
      });
      worker = await waitForLiveWorker(context);
      let scenarioWakeState = null;
      const scenarioDeadline = Date.now() + 12_000;
      while (Date.now() < scenarioDeadline) {
        scenarioWakeState = await worker.evaluate(async () => {
          await authStateRestorePromise;
          const heartbeatAlarm = await chrome.alarms.get('heartbeat');
          const screenshotAlarm = await chrome.alarms.get('screenshot-capture');
          return {
            licenseActive: currentLicenseIsActive(),
            licenseRefreshState,
            licensePlanStatus,
            trackingState,
            heartbeatAlarm: Boolean(heartbeatAlarm),
            screenshotAlarm: Boolean(screenshotAlarm),
            screenshotPolicyMode: screenshotPolicyState.mode,
            screenshotCaptureAllowed: ambientScreenshotAllowed(
              captureAuthenticatedContext('old exact license LKG scenario assertion'),
            ),
          };
        });
        if (
          scenarioWakeState.licenseActive
          && scenarioWakeState.trackingState !== 'OFF'
          && scenarioWakeState.heartbeatAlarm
          && scenarioWakeState.screenshotAlarm
          && scenarioWakeState.screenshotCaptureAllowed
        ) break;
        await new Promise((resolvePoll) => setTimeout(resolvePoll, 100));
      }
      assert.equal(scenarioWakeState?.licenseActive, true, JSON.stringify(scenarioWakeState));
      assert.equal(scenarioWakeState?.licensePlanStatus, 'old-exact-lkg');
      assert.notEqual(scenarioWakeState?.trackingState, 'OFF', JSON.stringify(scenarioWakeState));
      assert.equal(scenarioWakeState?.heartbeatAlarm, true, JSON.stringify(scenarioWakeState));
      assert.equal(scenarioWakeState?.screenshotAlarm, true, JSON.stringify(scenarioWakeState));
      assert.equal(scenarioWakeState?.screenshotPolicyMode, 'tracking_window_lease');
      assert.equal(scenarioWakeState?.screenshotCaptureAllowed, true);
      assert.ok(fixture.state.heartbeatRequests > heartbeatRequestsBeforeScenario);
      assert.ok(fixture.state.schoolStatusRequests > schoolStatusRequestsBeforeScenario);
    }
    fixture.state.schoolStatusStatus = 200;
    fixture.state.schoolStatusRawBody = null;
    fixture.state.schoolStatusBody = { success: true, schoolActive: true, planStatus: 'active' };

    // A full Chrome restart clears storage.session. Even when the exact release
    // endpoint would return its ordinary opaque 204, the newest current-school
    // capability is reserved for the gate rather than released before roster.
    const releasesBeforeBrowserRestart = fixture.state.sessionReleaseRequests;
    fixture.state.sessionReleaseStatus = 204;
    fixture.state.configDelayMs = 0;
    fixture.state.configStatus = 200;
    fixture.state.configBody = {
      sharedSignInEnabled: true,
      loginMethod: 'name_pin',
      schoolId: 'cold-start-school',
      passpilotKioskAvailable: true,
    };
    await context.close();
    context = await launchContext(executablePath, profilePath, extensionPath);
    const recoveryPage = context.pages()[0] || await context.newPage();
    await recoveryPage.goto(`${fixture.origin}/browser-restart-recovery`, {
      waitUntil: 'domcontentloaded',
    });
    worker = await waitForLiveWorker(context);
    await requestLiveRefresh(worker);
    const recoveryFrame = await waitForAuthFramePhase(recoveryPage, 'ready', 10_000);
    const reclaimOption = recoveryFrame.locator(
      '#classpilot-auth-student option[value="student-1"]',
    );
    await reclaimOption.waitFor({ state: 'attached', timeout: 10_000 });
    assert.match(await reclaimOption.textContent(), /Resume on this Chromebook/);
    assert.ok(
      fixture.state.rosterAuthorizations.some(
        (value) => value === `ClassPilot-Recovery ${'R'.repeat(43)}`,
      ),
      'restart roster did not present the exact recovery capability',
    );
    assert.equal(
      fixture.state.sessionReleaseRequests,
      releasesBeforeBrowserRestart,
      'browser restart released the newest recovery capability before roster',
    );
    await recoveryFrame.locator('#classpilot-auth-student').selectOption('student-1');
    await recoveryFrame.locator('#classpilot-auth-pin').fill('1234');
    await recoveryFrame.locator('#classpilot-auth-pin-submit').click();
    await recoveryPage.waitForSelector(GATE_SELECTOR, { state: 'detached', timeout: 12_000 });
    assert.equal(
      fixture.state.studentLoginAuthorizations.at(-1),
      `ClassPilot-Recovery ${'R'.repeat(43)}`,
      'same-Chromebook PIN reclaim did not bind the exact recovery capability',
    );
    fixture.state.sessionReleaseStatus = 204;
    // Remove the recovery gate before clearing auth so its asynchronous
    // refresh cannot race the synthetic authenticated-session baseline below.
    await recoveryPage.goto('chrome://version');
    await worker.evaluate(async () => {
      await sharedSignInConfigPromise?.catch(() => {});
      clearSharedSignInConfigRetry();
      const current = captureAuthenticatedContext('startup test recovery cleanup');
      await clearStudentAuth('startup-test-recovery-cleanup', {
        notifyBackend: false,
        serverSessionEnded: true,
        pauseAutoRegistration: true,
        notifyAuthGateTabs: false,
        expectedAuthContext: current,
      });
      await sharedSignInConfigPromise?.catch(() => {});
      clearSharedSignInConfigRetry();
    });

    // A locally restored, complete auth binding answers without a network wait
    // and releases a fail-closed gate promptly.
    const rollbackRevisionCeiling = await worker.evaluate(async () => {
      const auth = {
        studentToken: 'persisted-token', activeStudentId: 'student-1',
        activeStudentSessionId: 'session-1', studentName: 'Jordan Student',
        identitySource: 'integration_test', manualLoginLastSeenAt: null,
      };
      const storedRevision = await chrome.storage.local.get('authGateRevisionV1');
      const rollbackCeiling = Math.max(
        Number(storedRevision.authGateRevisionV1 || 0) + 5_000_000,
        Date.now() + 30 * 24 * 60 * 60 * 1000,
      );
      await chrome.storage.local.set({ deviceId: 'device-1', ...auth });
      await chrome.storage.local.set({ authGateRevisionV1: rollbackCeiling });
      await chrome.storage.session?.set(auth);
      return rollbackCeiling;
    });
    const authenticatedConfigRequestsBeforeNavigation = fixture.state.loginConfigRequests;
    const authenticatedPage = context.pages()[0] || await context.newPage();
    await authenticatedPage.goto('chrome://version');
    const cohortStop = await stopExtensionWorker(context, authenticatedPage, extensionId);
    assert.equal(cohortStop.stopped, true, 'could not stop the MV3 worker before cold cohort requests');
    await authenticatedPage.goto(`chrome-extension://${extensionId}/cold-auth-cohort.html`, {
      waitUntil: 'domcontentloaded',
    });
    await authenticatedPage.waitForFunction(() => Boolean(globalThis.__classpilotColdAuthCohort), null, {
      timeout: 7_000,
    });
    const coldAuthCohort = await authenticatedPage.evaluate(() => globalThis.__classpilotColdAuthCohort);
    assert.equal(coldAuthCohort.first.length, 3);
    for (const [index, response] of coldAuthCohort.first.entries()) {
      assert.equal(response?.success, true, `cold auth cohort request ${index + 1} failed`);
      assert.equal(response?.state?.phase, 'authenticated');
      assert.equal(
        response?.state?.coldWorker,
        true,
        `cold auth cohort request ${index + 1} lost the worker-wake marker`,
      );
    }
    assert.equal(coldAuthCohort.later?.success, true);
    assert.equal(coldAuthCohort.later?.state?.phase, 'authenticated');
    assert.equal(
      coldAuthCohort.later?.state?.coldWorker,
      false,
      'ordinary auth requests stayed cold after the first-response cohort completed',
    );
    assert.equal(
      fixture.state.loginConfigRequests,
      authenticatedConfigRequestsBeforeNavigation,
      'cold authenticated response cohort started login configuration network I/O',
    );

    await authenticatedPage.goto('chrome://version');
    const authenticatedStop = await stopExtensionWorker(context, authenticatedPage, extensionId);
    assert.equal(authenticatedStop.stopped, true, 'could not stop the MV3 worker before authenticated navigation');
    const authenticatedConfigRequestsImmediatelyBeforeNavigation =
      fixture.state.loginConfigRequests;
    const authenticatedNavigationStartedAt = Date.now();
    await authenticatedPage.goto(`${fixture.origin}/authenticated`, { waitUntil: 'domcontentloaded' });
    worker = await waitForLiveWorker(context);
    const authState = await worker.evaluate(async () => {
      await authStateRestorePromise;
      return { success: true, state: getAuthGateState() };
    });
    assert.equal(authState?.state?.phase, 'authenticated');
    assert.ok(
      Number(authState?.state?.revision) > rollbackRevisionCeiling,
      `worker revision ${authState?.state?.revision} did not advance past persisted rollback ceiling ${rollbackRevisionCeiling}`,
    );
    let authenticatedTiming = null;
    const timingDeadline = Date.now() + 2_000;
    while (Date.now() < timingDeadline) {
      authenticatedTiming = await worker.evaluate(async () => {
        const stored = await chrome.storage.local.get('authGateTimingV1');
        return stored.authGateTimingV1 || null;
      });
      if (
        authenticatedTiming?.outcome === 'authenticated' &&
        Number(authenticatedTiming.timestamp) >= authenticatedNavigationStartedAt
      ) break;
      await new Promise((resolvePoll) => setTimeout(resolvePoll, 20));
    }
    assert.equal(authenticatedTiming?.outcome, 'authenticated');
    assert.ok(
      Number(authenticatedTiming?.timestamp) >= authenticatedNavigationStartedAt,
      'authenticated timing was not produced by the measured navigation',
    );
    // A correlated get-auth-state reply and a tab-enforcement AUTH_COMPLETE
    // push can legitimately race to release the gate. The dedicated cohort
    // above verifies cold-worker attribution directly; this navigation check
    // verifies the winning local decision remains fast and network-free.
    assert.equal(typeof authenticatedTiming?.coldWorker, 'boolean');
    assert.ok(
      Number(authenticatedTiming?.configReadyMs) <= 250,
      `cold local auth decision took ${authenticatedTiming?.configReadyMs}ms (limit 250ms)`,
    );
    assert.equal(
      fixture.state.loginConfigRequests,
      authenticatedConfigRequestsImmediatelyBeforeNavigation,
      'cold local get-auth-state response waited on or started login configuration network I/O',
    );
    await authenticatedPage.waitForTimeout(350);
    const authenticatedGateTimeline = await authenticatedPage.evaluate(() => window.__authGateTimeline || []);
    assert.equal(
      authenticatedGateTimeline.some((entry) => entry.present === true),
      false,
      `valid local auth painted the 250ms fallback gate after cold navigation: ${JSON.stringify(authenticatedGateTimeline)}`
    );
    assert.equal(await authenticatedPage.locator(GATE_SELECTOR).count(), 0, 'valid restored auth left a visible gate');
    assert.deepEqual(
      await authenticatedPage.evaluate(() => ({
        bodyHasInert: document.body.hasAttribute('inert'),
        bodyDisplay: document.body.style.getPropertyValue('display'),
        bodyDisplayPriority: document.body.style.getPropertyPriority('display'),
        bodyPointerEvents: document.body.style.getPropertyValue('pointer-events'),
        bodyPointerPriority: document.body.style.getPropertyPriority('pointer-events'),
      })),
      {
        bodyHasInert: false,
        bodyDisplay: '',
        bodyDisplayPriority: '',
        bodyPointerEvents: '',
        bodyPointerPriority: '',
      },
      'authenticated release did not restore quarantined page-surface styles',
    );
    assert.ok(
      Date.now() - authenticatedNavigationStartedAt < LOADING_LIMIT_MS,
      'authenticated cold navigation did not complete within the startup SLA'
    );

    const authenticatedTabId = await tabIdFor(worker, authenticatedPage);
    const staleRollbackDelivery = await worker.evaluate(async ({ tabId, revision }) => {
      try {
        return await chrome.tabs.sendMessage(tabId, {
          type: 'CLASSPILOT_AUTH_REQUIRED',
          state: {
            authRequired: true,
            phase: 'loading',
            revision,
            sharedSignInEnabled: true,
            loginMethod: 'name_pin',
          },
        });
      } catch (error) {
        return { success: false, error: error?.message || String(error) };
      }
    }, { tabId: authenticatedTabId, revision: rollbackRevisionCeiling });
    assert.equal(staleRollbackDelivery?.success, true);
    await authenticatedPage.waitForTimeout(150);
    assert.equal(
      await authenticatedPage.locator(GATE_SELECTOR).count(),
      0,
      'pre-restart revision re-gated the authenticated page after a clock rollback',
    );

    // A worker crash after credential persistence but before critical
    // classroom enforcement leaves a durable commit marker. The next worker
    // must clear that incomplete binding and fail closed.
    const revisionBeforeInterruptedCommit = Number(authState.state.revision);
    await worker.evaluate(async () => {
      await chrome.storage.local.set({ studentAuthCommitPendingV1: true });
    });
    await context.close();
    context = await launchContext(executablePath, profilePath, extensionPath);
    const interruptedCommitPage = context.pages()[0] || await context.newPage();
    await interruptedCommitPage.goto('chrome://version');
    const interruptedCommitStop = await stopExtensionWorker(
      context,
      interruptedCommitPage,
      extensionId,
    );
    assert.equal(
      interruptedCommitStop.stopped,
      true,
      'could not stop the MV3 worker before interrupted-commit navigation',
    );
    await interruptedCommitPage.goto(`${fixture.origin}/interrupted-auth-commit`, {
      waitUntil: 'domcontentloaded',
    });
    await interruptedCommitPage.waitForSelector(GATE_SELECTOR, { timeout: LOADING_LIMIT_MS });
    worker = await waitForLiveWorker(context);
    const interruptedCommitState = await worker.evaluate(async () => {
      await authStateRestorePromise;
      const persisted = await getStoredAuthState([
        'studentToken',
        'activeStudentId',
        'activeStudentSessionId',
        'studentAuthCommitPendingV1',
      ]);
      return { state: getAuthGateState(), persisted };
    });
    assert.notEqual(interruptedCommitState.state.phase, 'authenticated');
    assert.equal(interruptedCommitState.state.authRequired, true);
    assert.ok(
      Number(interruptedCommitState.state.revision) > revisionBeforeInterruptedCommit,
      'auth-state revision did not advance across interrupted-commit restart',
    );
    assert.equal(Boolean(interruptedCommitState.persisted.studentToken), false);
    assert.equal(Boolean(interruptedCommitState.persisted.activeStudentId), false);
    assert.equal(Boolean(interruptedCommitState.persisted.activeStudentSessionId), false);
    assert.equal(Boolean(interruptedCommitState.persisted.studentAuthCommitPendingV1), false);

    // A complete but expired manual binding must fail closed just like a
    // corrupt/partial binding.
    await worker.evaluate(async () => {
      const expired = {
        deviceId: 'device-1',
        studentToken: 'expired-token', activeStudentId: 'student-1',
        activeStudentSessionId: 'expired-session', identitySource: 'manual_pin',
        manualLoginLastSeenAt: 1,
      };
      await chrome.storage.local.set(expired);
      await chrome.storage.session?.set(expired);
    });
    await context.close();
    context = await launchContext(executablePath, profilePath, extensionPath);
    const expiredPage = context.pages()[0] || await context.newPage();
    await expiredPage.goto('chrome://version');
    const expiredStop = await stopExtensionWorker(context, expiredPage, extensionId);
    assert.equal(expiredStop.stopped, true, 'could not stop the MV3 worker before expired-auth navigation');
    await expiredPage.goto(`${fixture.origin}/expired-auth`, { waitUntil: 'domcontentloaded' });
    await expiredPage.waitForSelector(GATE_SELECTOR, { timeout: LOADING_LIMIT_MS });
    worker = await waitForLiveWorker(context);
    const expiredState = await worker.evaluate(async () => {
      await authStateRestorePromise;
      return { publicAuthenticated: hasStudentAuth(), state: await getPublishableAuthGateState() };
    });
    assert.equal(expiredState.publicAuthenticated, false);
    assert.equal(expiredState.state.authRequired, true);
    assert.notEqual(expiredState.state.phase, 'authenticated');
    assert.equal(await expiredPage.locator(GATE_SELECTOR).count(), 1);
    await assertUnderlyingPageLocked(expiredPage);

    // A future manual-login timestamp represents clock rollback or corrupt
    // storage, not a valid fresh session. Cold restoration must fail closed.
    await worker.evaluate(async () => {
      const futureDated = {
        deviceId: 'device-1',
        studentToken: 'future-token',
        activeStudentId: 'student-1',
        activeStudentSessionId: 'future-session',
        identitySource: 'manual_pin',
        manualLoginLastSeenAt: Date.now() + 60 * 60 * 1000,
      };
      await chrome.storage.local.set(futureDated);
      await chrome.storage.session?.set(futureDated);
    });
    await context.close();
    context = await launchContext(executablePath, profilePath, extensionPath);
    const futureTimestampPage = context.pages()[0] || await context.newPage();
    await futureTimestampPage.goto('chrome://version');
    const futureTimestampStop = await stopExtensionWorker(context, futureTimestampPage, extensionId);
    assert.equal(
      futureTimestampStop.stopped,
      true,
      'could not stop the MV3 worker before future-timestamp auth navigation',
    );
    await futureTimestampPage.goto(`${fixture.origin}/future-timestamp-auth`, {
      waitUntil: 'domcontentloaded',
    });
    await futureTimestampPage.waitForSelector(GATE_SELECTOR, { timeout: LOADING_LIMIT_MS });
    worker = await waitForLiveWorker(context);
    const futureTimestampState = await worker.evaluate(async () => {
      await authStateRestorePromise;
      return { publicAuthenticated: hasStudentAuth(), state: await getPublishableAuthGateState() };
    });
    assert.equal(futureTimestampState.publicAuthenticated, false);
    assert.equal(futureTimestampState.state.authRequired, true);
    assert.notEqual(futureTimestampState.state.phase, 'authenticated');
    assert.equal(await futureTimestampPage.locator(GATE_SELECTOR).count(), 1);
    await assertUnderlyingPageLocked(futureTimestampPage);

    // Corrupt/partial auth never unlocks the page.
    await worker.evaluate(async () => {
      const corrupt = {
        deviceId: 'device-1',
        studentToken: 'partial-token',
        activeStudentId: null,
        activeStudentSessionId: null,
        identitySource: 'manual_pin',
        manualLoginLastSeenAt: Date.now(),
      };
      await chrome.storage.local.set(corrupt);
      await chrome.storage.session?.set(corrupt);
    });
    await context.close();
    context = await launchContext(executablePath, profilePath, extensionPath);
    const corruptPage = context.pages()[0] || await context.newPage();
    await corruptPage.goto('chrome://version');
    const corruptStop = await stopExtensionWorker(context, corruptPage, extensionId);
    assert.equal(corruptStop.stopped, true, 'could not stop the MV3 worker before corrupt-auth navigation');
    await corruptPage.goto(`${fixture.origin}/corrupt-auth`, { waitUntil: 'domcontentloaded' });
    await corruptPage.waitForSelector(GATE_SELECTOR, { timeout: LOADING_LIMIT_MS });
    worker = await waitForLiveWorker(context);
    const corruptState = await worker.evaluate(async () => {
      await authStateRestorePromise;
      return { publicAuthenticated: hasStudentAuth(), state: await getPublishableAuthGateState() };
    });
    assert.equal(corruptState.publicAuthenticated, false);
    assert.equal(corruptState.state.authRequired, true);
    assert.notEqual(corruptState.state.phase, 'authenticated');
    assert.equal(await corruptPage.locator(GATE_SELECTOR).count(), 1);
    await assertUnderlyingPageLocked(corruptPage);

    // Crash the real worker while a second login has durably persisted both
    // credentials and the commit marker but is still waiting on classroom
    // enforcement. The successor must clear that exact interrupted commit.
    fixture.state.configStatus = 200;
    fixture.state.configDelayMs = 0;
    fixture.state.configBody = {
      sharedSignInEnabled: true,
      loginMethod: 'email_id',
      schoolId: 'cold-start-school',
      passpilotKioskAvailable: true,
    };
    await requestLiveRefresh(worker);
    const genuineCrashFrame = await waitForAuthFramePhase(corruptPage, 'ready', 7_000);
    await genuineCrashFrame.waitForSelector('#classpilot-auth-email-form');
    const genuineCrashFenceInstalled = await worker.evaluate(() => {
      const originalApply = applyClassroomStateFromAuthResponse;
      let releaseFence;
      const fence = new Promise((resolveFence) => { releaseFence = resolveFence; });
      globalThis.__classpilotGenuineCrashFence = { entered: false, release: releaseFence };
      applyClassroomStateFromAuthResponse = async (...args) => {
        globalThis.__classpilotGenuineCrashFence.entered = true;
        await fence;
        applyClassroomStateFromAuthResponse = originalApply;
        return originalApply(...args);
      };
      return true;
    });
    assert.equal(genuineCrashFenceInstalled, true);
    await genuineCrashFrame.locator('#classpilot-auth-email').fill('jordan@example.edu');
    await genuineCrashFrame.locator('#classpilot-auth-student-id').fill('S-1001');
    await genuineCrashFrame.locator('#classpilot-auth-email-submit').click();
    let genuineCrashState = null;
    const genuineCrashDeadline = Date.now() + 7_000;
    while (Date.now() < genuineCrashDeadline) {
      genuineCrashState = await worker.evaluate(async () => {
        const persisted = await getStoredAuthState([
          'deviceId',
          'studentToken',
          'activeStudentId',
          'activeStudentSessionId',
          'studentAuthCommitPendingV1',
        ]);
        return {
          entered: globalThis.__classpilotGenuineCrashFence?.entered === true,
          marker: persisted.studentAuthCommitPendingV1 === true,
          exactBinding: Boolean(
            persisted.deviceId && persisted.studentToken
            && persisted.activeStudentId && persisted.activeStudentSessionId
          ),
          revision: getAuthGateState().revision,
        };
      });
      if (genuineCrashState.entered && genuineCrashState.marker && genuineCrashState.exactBinding) break;
      await new Promise((resolvePoll) => setTimeout(resolvePoll, 25));
    }
    assert.equal(genuineCrashState?.entered, true);
    assert.equal(genuineCrashState?.marker, true);
    assert.equal(genuineCrashState?.exactBinding, true);

    await corruptPage.goto('chrome://version');
    const genuineCrashStop = await stopExtensionWorker(context, corruptPage, extensionId);
    assert.equal(genuineCrashStop.stopped, true, 'could not terminate the genuinely fenced login worker');
    await corruptPage.goto(`${fixture.origin}/genuine-interrupted-auth-commit`, {
      waitUntil: 'domcontentloaded',
    });
    await corruptPage.waitForSelector(GATE_SELECTOR, { timeout: LOADING_LIMIT_MS });
    worker = await waitForLiveWorker(context);
    const genuineRecovery = await worker.evaluate(async () => {
      await authStateRestorePromise;
      await authCommitRecoveryPromise;
      const persisted = await getStoredAuthState([
        'studentToken',
        'activeStudentId',
        'activeStudentSessionId',
        'studentAuthCommitPendingV1',
      ]);
      return { publicAuthenticated: hasStudentAuth(), state: await getPublishableAuthGateState(), persisted };
    });
    assert.equal(genuineRecovery.publicAuthenticated, false);
    assert.equal(genuineRecovery.state.authRequired, true);
    assert.ok(
      Number(genuineRecovery.state.revision) > Number(genuineCrashState.revision),
      'genuine interrupted-commit recovery did not advance the public revision',
    );
    assert.equal(Boolean(genuineRecovery.persisted.studentToken), false);
    assert.equal(Boolean(genuineRecovery.persisted.activeStudentId), false);
    assert.equal(Boolean(genuineRecovery.persisted.activeStudentSessionId), false);
    assert.equal(Boolean(genuineRecovery.persisted.studentAuthCommitPendingV1), false);
    assert.equal(await corruptPage.locator(GATE_SELECTOR).count(), 1);
    await assertUnderlyingPageLocked(corruptPage);

    // A direct managed-policy revalidation must finish the durable auth
    // invalidation before it attempts to persist the replacement authority.
    // Stop the real worker while the combined replacement write is held and prove a
    // successor cannot restore the old token across that crash boundary.
    await worker.evaluate(async (serverUrl) => {
      const auth = {
        deviceId: 'managed-crash-device',
        studentToken: 'managed-crash-old-token',
        activeStudentId: 'managed-crash-student',
        activeStudentSessionId: 'managed-crash-session',
        identitySource: 'manual_pin',
        manualLoginLastSeenAt: Date.now(),
      };
      const config = {
        serverUrl,
        schoolId: 'cold-start-school',
        schoolSlug: 'cold-start-school',
        enrollmentKey: 'fixture-enrollment-key',
      };
      await chrome.storage.local.set({
        config,
        ...auth,
      });
      await chrome.storage.local.remove([
        'studentAuthInvalidatingV1',
        'studentAuthCommitPendingV1',
        'managedAuthGateBindingV1',
      ]);
      await chrome.storage.session?.set(auth);
    }, fixture.origin);
    await corruptPage.goto('chrome://version');
    const managedCrashSeedStop = await stopExtensionWorker(context, corruptPage, extensionId);
    assert.equal(managedCrashSeedStop.stopped, true, 'could not restart before managed crash-boundary setup');
    await corruptPage.goto(`${fixture.origin}/managed-crash-boundary`, { waitUntil: 'domcontentloaded' });
    worker = await waitForLiveWorker(context);
    await corruptPage.waitForTimeout(350);
    assert.equal(await corruptPage.locator(GATE_SELECTOR).count(), 0, 'managed crash fixture auth did not restore');

    const managedCrashHarnessInstalled = await worker.evaluate(async (serverUrl) => {
      await chrome.storage.local.set({
        [MANAGED_AUTH_GATE_BINDING_KEY]: {
          schemaVersion: 1,
          serverOrigin: serverUrl,
          serverManaged: true,
          serverValid: true,
          schoolId: 'cold-start-school',
          schoolIdManaged: true,
          schoolSlug: 'cold-start-school',
          schoolSlugManaged: true,
          enrollmentKeyManaged: true,
        },
      });
      const originalReadManagedConfig = readManagedConfig;
      const originalDurableSet = durableLocalKv.set;
      const never = new Promise(() => {});
      const harness = {
        entered: false,
        operations: [],
        boundary: null,
      };
      globalThis.__classpilotManagedCrashHarness = harness;
      readManagedConfig = async () => ({
        fastAuthGateEnabled: true,
        serverUrl,
        schoolId: 'managed-crash-new-school',
        schoolSlug: 'managed-crash-new-school',
        enrollmentKey: 'managed-crash-new-enrollment',
      });
      durableLocalKv.set = async (values) => {
        if (values?.[STUDENT_AUTH_INVALIDATING_KEY] === true) {
          const result = await originalDurableSet(values);
          harness.operations.push('invalidation-marker-durable');
          return result;
        }
        if (
          Object.prototype.hasOwnProperty.call(values || {}, 'config')
          && Object.prototype.hasOwnProperty.call(values || {}, MANAGED_AUTH_GATE_BINDING_KEY)
        ) {
          harness.operations.push('config-binding-persistence-attempt');
          harness.boundary = await getStoredAuthState([
            'config',
            'studentToken',
            'activeStudentId',
            'activeStudentSessionId',
            STUDENT_AUTH_INVALIDATING_KEY,
            MANAGED_AUTH_GATE_BINDING_KEY,
          ]);
          harness.entered = true;
          return never;
        }
        return originalDurableSet(values);
      };
      revalidateManagedAuthGatePolicy(91_001).catch((error) => {
        harness.error = error?.message || String(error);
      });
      return {
        originalReadCaptured: typeof originalReadManagedConfig === 'function',
        originalDurableSetCaptured: typeof originalDurableSet === 'function',
      };
    }, fixture.origin);
    assert.deepEqual(managedCrashHarnessInstalled, {
      originalReadCaptured: true,
      originalDurableSetCaptured: true,
    });
    let managedCrashBoundary = null;
    const managedCrashDeadline = Date.now() + 7_000;
    while (Date.now() < managedCrashDeadline) {
      managedCrashBoundary = await worker.evaluate(() => {
        const harness = globalThis.__classpilotManagedCrashHarness;
        return harness ? {
          entered: harness.entered,
          operations: [...harness.operations],
          boundary: harness.boundary,
          inMemoryInvalidating: studentAuthInvalidating,
        } : null;
      });
      if (managedCrashBoundary?.entered) break;
      await new Promise((resolvePoll) => setTimeout(resolvePoll, 25));
    }
    assert.equal(managedCrashBoundary?.entered, true, 'managed revalidation did not reach persistence boundary');
    const markerIndex = managedCrashBoundary.operations.indexOf('invalidation-marker-durable');
    const configIndex = managedCrashBoundary.operations.indexOf('config-binding-persistence-attempt');
    assert.ok(markerIndex >= 0, 'managed revalidation did not durably persist its invalidation marker');
    assert.ok(markerIndex < configIndex, 'config persistence started before durable auth invalidation');
    assert.equal(Boolean(managedCrashBoundary.boundary?.studentToken), false);
    assert.equal(Boolean(managedCrashBoundary.boundary?.activeStudentId), false);
    assert.equal(Boolean(managedCrashBoundary.boundary?.activeStudentSessionId), false);
    assert.equal(managedCrashBoundary.boundary?.config?.schoolId, 'cold-start-school');
    assert.equal(managedCrashBoundary.boundary?.config?.enrollmentKey, 'fixture-enrollment-key');
    assert.equal(managedCrashBoundary.boundary?.managedAuthGateBindingV1?.schoolId, 'cold-start-school');

    await corruptPage.goto('chrome://version');
    const managedBoundaryStop = await stopExtensionWorker(context, corruptPage, extensionId);
    assert.equal(managedBoundaryStop.stopped, true, 'could not crash worker at managed persistence boundary');
    await corruptPage.goto(`${fixture.origin}/managed-crash-recovery`, { waitUntil: 'domcontentloaded' });
    await corruptPage.waitForSelector(GATE_SELECTOR, { timeout: LOADING_LIMIT_MS });
    worker = await waitForLiveWorker(context);
    const managedBoundaryRecovery = await worker.evaluate(async () => {
      await authStateRestorePromise;
      await authCommitRecoveryPromise;
      const persisted = await getStoredAuthState([
        'studentToken',
        'activeStudentId',
        'activeStudentSessionId',
        'studentAuthInvalidatingV1',
      ]);
      return { publicAuthenticated: hasStudentAuth(), state: await getPublishableAuthGateState(), persisted };
    });
    assert.equal(managedBoundaryRecovery.publicAuthenticated, false);
    assert.equal(managedBoundaryRecovery.state.authRequired, true);
    assert.notEqual(managedBoundaryRecovery.state.phase, 'authenticated');
    assert.equal(Boolean(managedBoundaryRecovery.persisted.studentToken), false);
    assert.equal(Boolean(managedBoundaryRecovery.persisted.activeStudentId), false);
    assert.equal(Boolean(managedBoundaryRecovery.persisted.activeStudentSessionId), false);
    await assertUnderlyingPageLocked(corruptPage);

    // Exercise the separate chrome.storage.onChanged authority transition. It
    // must await the same durable local auth cleanup before applying or writing
    // the new binding. Crash the real worker while that combined persistence is
    // held, then prove a cold successor cannot revive the prior token.
    await worker.evaluate(async (serverUrl) => {
      const auth = {
        authContextId: 'managed-change-crash-auth-context',
        deviceId: 'managed-change-crash-device',
        studentToken: 'managed-change-crash-old-token',
        activeStudentId: 'managed-change-crash-student',
        activeStudentSessionId: 'managed-change-crash-session',
        identitySource: 'manual_pin',
        manualLoginLastSeenAt: Date.now(),
      };
      const config = {
        serverUrl,
        schoolId: 'cold-start-school',
        schoolSlug: 'cold-start-school',
        enrollmentKey: 'fixture-enrollment-key',
      };
      await chrome.storage.local.set({
        config,
        deviceId: auth.deviceId,
        restrictionSsoVisitStateV1: {
          schemaVersion: 1,
          scopeDigest: 'b'.repeat(64),
          visitedHosts: ['clever.com'],
        },
      });
      await chrome.storage.local.remove([
        'studentAuthInvalidatingV1',
        'studentAuthCommitPendingV1',
        'managedAuthGateBindingV1',
      ]);
      await chrome.storage.session?.set(auth);
    }, fixture.origin);
    await corruptPage.goto('chrome://version');
    const managedChangeSeedStop = await stopExtensionWorker(context, corruptPage, extensionId);
    assert.equal(managedChangeSeedStop.stopped, true, 'could not restart before managed onChanged crash setup');
    await corruptPage.goto(`${fixture.origin}/managed-onchanged-crash-boundary`, {
      waitUntil: 'domcontentloaded',
    });
    worker = await waitForLiveWorker(context);
    await corruptPage.waitForSelector(GATE_SELECTOR, {
      state: 'detached',
      timeout: LOADING_LIMIT_MS,
    });
    assert.equal(await corruptPage.locator(GATE_SELECTOR).count(), 0, 'managed onChanged crash auth did not restore');

    const managedChangeHarnessInstalled = await worker.evaluate(async (serverUrl) => {
      await chrome.storage.local.set({
        [MANAGED_AUTH_GATE_BINDING_KEY]: {
          schemaVersion: 1,
          serverOrigin: serverUrl,
          serverManaged: true,
          serverValid: true,
          schoolId: 'cold-start-school',
          schoolIdManaged: true,
          schoolSlug: 'cold-start-school',
          schoolSlugManaged: true,
          enrollmentKeyManaged: true,
        },
      });
      const originalReadManagedConfig = readManagedConfig;
      const originalDurableSet = durableLocalKv.set;
      const never = new Promise(() => {});
      const harness = {
        entered: false,
        operations: [],
        boundary: null,
      };
      globalThis.__classpilotManagedChangeCrashHarness = harness;
      readManagedConfig = async () => ({
        fastAuthGateEnabled: true,
        serverUrl,
        schoolId: 'managed-change-new-school',
        schoolSlug: 'managed-change-new-school',
        enrollmentKey: 'managed-change-new-enrollment',
      });
      durableLocalKv.set = async (values) => {
        if (values?.[STUDENT_AUTH_INVALIDATING_KEY] === true) {
          const result = await originalDurableSet(values);
          harness.operations.push('invalidation-marker-durable');
          return result;
        }
        if (
          Object.prototype.hasOwnProperty.call(values || {}, 'config')
          && Object.prototype.hasOwnProperty.call(values || {}, MANAGED_AUTH_GATE_BINDING_KEY)
        ) {
          harness.operations.push('onchanged-policy-persistence-attempt');
          harness.boundary = await getStoredAuthState([
            'config',
            'studentToken',
            'activeStudentId',
            'activeStudentSessionId',
            RESTRICTION_SSO_VISIT_STORAGE_KEY,
            STUDENT_AUTH_INVALIDATING_KEY,
            MANAGED_AUTH_GATE_BINDING_KEY,
          ]);
          harness.entered = true;
          return never;
        }
        return originalDurableSet(values);
      };
      const transition = handleManagedAuthGateStorageChange({
        schoolId: {
          oldValue: 'cold-start-school',
          newValue: 'managed-change-new-school',
        },
        enrollmentKey: {
          oldValue: 'fixture-enrollment-key',
          newValue: 'managed-change-new-enrollment',
        },
      }, 'managed');
      transition?.policyRestorePromise?.catch((error) => {
        harness.error = error?.message || String(error);
      });
      harness.policyGeneration = transition?.policyGeneration ?? null;
      return {
        handlerReturned: Boolean(transition?.policyRestorePromise),
        originalReadCaptured: typeof originalReadManagedConfig === 'function',
        originalDurableSetCaptured: typeof originalDurableSet === 'function',
      };
    }, fixture.origin);
    assert.deepEqual(managedChangeHarnessInstalled, {
      handlerReturned: true,
      originalReadCaptured: true,
      originalDurableSetCaptured: true,
    });
    let managedChangeBoundary = null;
    const managedChangeDeadline = Date.now() + 7_000;
    while (Date.now() < managedChangeDeadline) {
      managedChangeBoundary = await worker.evaluate(() => {
        const harness = globalThis.__classpilotManagedChangeCrashHarness;
        return harness ? {
          entered: harness.entered,
          operations: [...harness.operations],
          boundary: harness.boundary,
          policyGeneration: harness.policyGeneration,
          inMemoryInvalidating: studentAuthInvalidating,
        } : null;
      });
      if (managedChangeBoundary?.entered) break;
      await new Promise((resolvePoll) => setTimeout(resolvePoll, 25));
    }
    assert.equal(managedChangeBoundary?.entered, true, 'managed onChanged did not reach persistence boundary');
    assert.ok(Number.isSafeInteger(managedChangeBoundary.policyGeneration));
    const managedChangeMarkerIndex = managedChangeBoundary.operations.indexOf('invalidation-marker-durable');
    const managedChangePersistenceIndex = managedChangeBoundary.operations.indexOf(
      'onchanged-policy-persistence-attempt',
    );
    assert.ok(managedChangeMarkerIndex >= 0, 'managed onChanged did not durably invalidate auth');
    assert.ok(
      managedChangeMarkerIndex < managedChangePersistenceIndex,
      'managed onChanged attempted new authority persistence before durable invalidation',
    );
    assert.equal(Boolean(managedChangeBoundary.boundary?.studentToken), false);
    assert.equal(Boolean(managedChangeBoundary.boundary?.activeStudentId), false);
    assert.equal(Boolean(managedChangeBoundary.boundary?.activeStudentSessionId), false);
    assert.equal(
      managedChangeBoundary.boundary?.restrictionSsoVisitStateV1,
      undefined,
      'managed authority transition retained the old SSO visit ledger',
    );
    assert.equal(managedChangeBoundary.boundary?.config?.schoolId, 'cold-start-school');
    assert.equal(managedChangeBoundary.boundary?.config?.enrollmentKey, 'fixture-enrollment-key');
    assert.equal(managedChangeBoundary.boundary?.managedAuthGateBindingV1?.schoolId, 'cold-start-school');

    await corruptPage.goto('chrome://version');
    const managedChangeBoundaryStop = await stopExtensionWorker(context, corruptPage, extensionId);
    assert.equal(managedChangeBoundaryStop.stopped, true, 'could not crash managed onChanged persistence');
    await corruptPage.goto(`${fixture.origin}/managed-onchanged-crash-recovery`, {
      waitUntil: 'domcontentloaded',
    });
    await corruptPage.waitForSelector(GATE_SELECTOR, { timeout: LOADING_LIMIT_MS });
    worker = await waitForLiveWorker(context);
    const managedChangeRecovery = await worker.evaluate(async () => {
      await authStateRestorePromise;
      await authCommitRecoveryPromise;
      const persisted = await getStoredAuthState([
        'studentToken',
        'activeStudentId',
        'activeStudentSessionId',
        'studentAuthInvalidatingV1',
      ]);
      return { publicAuthenticated: hasStudentAuth(), state: await getPublishableAuthGateState(), persisted };
    });
    assert.equal(managedChangeRecovery.publicAuthenticated, false);
    assert.equal(managedChangeRecovery.state.authRequired, true);
    assert.notEqual(managedChangeRecovery.state.phase, 'authenticated');
    assert.equal(Boolean(managedChangeRecovery.persisted.studentToken), false);
    assert.equal(Boolean(managedChangeRecovery.persisted.activeStudentId), false);
    assert.equal(Boolean(managedChangeRecovery.persisted.activeStudentSessionId), false);
    await assertUnderlyingPageLocked(corruptPage);

    // Both Chrome-profile registration entrypoints persist credentials before
    // applying server-provided classroom restrictions. Their durable commit
    // marker must keep the public auth state and the page locked throughout
    // that critical apply, and a required-apply failure must remove every
    // partially adopted credential.
    for (const registrationPath of [
      { path: 'ensure', label: 'profile-ensure', expectedOutcome: 'fulfilled' },
      { path: 'direct', label: 'profile-direct', expectedOutcome: 'rejected' },
    ]) {
      const started = await beginChromeProfileRegistrationFence(worker, {
        ...registrationPath,
        serverUrl: fixture.origin,
      });
      assert.equal(started.started, true);
      const fencedRegistration = await waitForChromeProfileRegistration(
        worker,
        (snapshot) => snapshot.entered
          && snapshot.persistedCommitPending
          && snapshot.exactBinding,
      );
      assert.equal(fencedRegistration.registerRequestCount, 1);
      assert.equal(fencedRegistration.applyReason, 'student_registration');
      assert.equal(fencedRegistration.applyOptions?.requireApplied, true);
      assert.equal(fencedRegistration.inMemoryCommitPending, true);
      assert.equal(fencedRegistration.publicAuthenticated, false);
      assert.equal(fencedRegistration.authRequired, true);
      assert.notEqual(fencedRegistration.phase, 'authenticated');
      assert.equal(
        await corruptPage.locator(GATE_SELECTOR).count(),
        1,
        `${registrationPath.label}: gate closed during classroom enforcement`,
      );
      await assertUnderlyingPageLocked(corruptPage);

      assert.equal(
        await rejectChromeProfileRegistrationApply(
          worker,
          `${registrationPath.label} required classroom apply failed`,
        ),
        true,
      );
      const failedRegistration = await waitForChromeProfileRegistration(
        worker,
        (snapshot) => snapshot.settled && !snapshot.persistedCommitPending,
      );
      assert.equal(failedRegistration.outcome, registrationPath.expectedOutcome);
      assert.equal(Boolean(failedRegistration.persisted.studentToken), false);
      assert.equal(Boolean(failedRegistration.persisted.activeStudentId), false);
      assert.equal(Boolean(failedRegistration.persisted.activeStudentSessionId), false);
      assert.equal(failedRegistration.inMemoryCommitPending, false);
      assert.equal(failedRegistration.publicAuthenticated, false);
      assert.equal(failedRegistration.authRequired, true);
      assert.notEqual(failedRegistration.phase, 'authenticated');
      assert.equal(await corruptPage.locator(GATE_SELECTOR).count(), 1);
      await assertUnderlyingPageLocked(corruptPage);
      await clearChromeProfileRegistrationHarness(worker);
    }

    // Terminate the real MV3 worker while the direct registration path has
    // both credentials and its pending marker on disk. A cold successor must
    // recover the interrupted commit before publishing any auth state.
    await beginChromeProfileRegistrationFence(worker, {
      path: 'direct',
      label: 'profile-crash',
      serverUrl: fixture.origin,
    });
    const profileCrashBoundary = await waitForChromeProfileRegistration(
      worker,
      (snapshot) => snapshot.entered
        && snapshot.persistedCommitPending
        && snapshot.exactBinding,
    );
    assert.equal(profileCrashBoundary.applyOptions?.requireApplied, true);
    assert.equal(profileCrashBoundary.publicAuthenticated, false);
    assert.equal(await corruptPage.locator(GATE_SELECTOR).count(), 1);
    await assertUnderlyingPageLocked(corruptPage);

    await corruptPage.goto('chrome://version');
    const profileCrashStop = await stopExtensionWorker(context, corruptPage, extensionId);
    assert.equal(profileCrashStop.stopped, true, 'could not terminate the fenced profile registration worker');
    await corruptPage.goto(`${fixture.origin}/profile-registration-interrupted-commit`, {
      waitUntil: 'domcontentloaded',
    });
    await corruptPage.waitForSelector(GATE_SELECTOR, { timeout: LOADING_LIMIT_MS });
    worker = await waitForLiveWorker(context);
    const profileCrashRecovery = await worker.evaluate(async () => {
      await authStateRestorePromise;
      await authCommitRecoveryPromise;
      const persisted = await getStoredAuthState([
        'studentToken',
        'activeStudentId',
        'activeStudentSessionId',
        'studentAuthCommitPendingV1',
      ]);
      return {
        persisted,
        publicAuthenticated: hasStudentAuth(),
        state: await getPublishableAuthGateState(),
      };
    });
    assert.equal(Boolean(profileCrashRecovery.persisted.studentToken), false);
    assert.equal(Boolean(profileCrashRecovery.persisted.activeStudentId), false);
    assert.equal(Boolean(profileCrashRecovery.persisted.activeStudentSessionId), false);
    assert.equal(Boolean(profileCrashRecovery.persisted.studentAuthCommitPendingV1), false);
    assert.equal(profileCrashRecovery.publicAuthenticated, false);
    assert.equal(profileCrashRecovery.state.authRequired, true);
    assert.notEqual(profileCrashRecovery.state.phase, 'authenticated');
    assert.equal(await corruptPage.locator(GATE_SELECTOR).count(), 1);
    await assertUnderlyingPageLocked(corruptPage);

    // A shared managed-policy failure must reject both concurrent callers,
    // clear the tracked cycle, and allow a later retry to start a fresh
    // generation instead of inheriting the rejected promise.
    const sharedFailureRecovery = await worker.evaluate(async (serverUrl) => {
      const originalReadManagedConfig = readManagedConfig;
      let readCount = 0;
      try {
        readManagedConfig = async () => {
          readCount += 1;
          await new Promise((resolveRead) => setTimeout(resolveRead, 40));
          throw new Error('synthetic shared managed read failure');
        };
        const generationBefore = managedAuthGatePolicyGeneration;
        const failed = await Promise.allSettled([
          revalidateManagedAuthGatePolicy(81_001),
          revalidateManagedAuthGatePolicy(81_002),
        ]);
        const afterFailure = {
          readCount,
          generation: managedAuthGatePolicyGeneration,
          inFlight: managedAuthGateDirectRevalidationInFlight !== null,
          rejected: failed.map((result) => result.status === 'rejected'),
          publicAuthenticated: hasStudentAuth(),
        };
        readManagedConfig = async () => {
          readCount += 1;
          return {
            fastAuthGateEnabled: true,
            serverUrl,
            schoolId: 'cold-start-school',
            schoolSlug: 'cold-start-school',
            enrollmentKey: 'fixture-enrollment-key',
          };
        };
        const recovered = await revalidateManagedAuthGatePolicy(81_003);
        return {
          generationBefore,
          afterFailure,
          finalReadCount: readCount,
          recovered: {
            fence: recovered.managedPolicyFence,
            generation: recovered.managedPolicyGeneration,
            revision: recovered.state?.revision ?? null,
          },
          inFlightAfterRecovery: managedAuthGateDirectRevalidationInFlight !== null,
        };
      } finally {
        readManagedConfig = originalReadManagedConfig;
      }
    }, fixture.origin);
    assert.deepEqual(sharedFailureRecovery.afterFailure.rejected, [true, true]);
    assert.equal(sharedFailureRecovery.afterFailure.readCount, 1);
    assert.equal(sharedFailureRecovery.afterFailure.inFlight, false);
    assert.equal(sharedFailureRecovery.afterFailure.publicAuthenticated, false);
    assert.equal(
      sharedFailureRecovery.afterFailure.generation,
      sharedFailureRecovery.generationBefore + 1,
    );
    assert.equal(sharedFailureRecovery.recovered.fence, 81_003);
    assert.equal(
      sharedFailureRecovery.recovered.generation,
      sharedFailureRecovery.afterFailure.generation + 1,
    );
    assert.equal(
      sharedFailureRecovery.finalReadCount,
      2,
      `fresh managed retry did not reread policy: ${JSON.stringify(sharedFailureRecovery)}`,
    );
    assert.ok(Number.isSafeInteger(sharedFailureRecovery.recovered.revision));
    assert.equal(sharedFailureRecovery.inFlightAfterRecovery, false);

    // Seed one final valid binding so the page begins unlocked. The alias case
    // proves an exact direct proof can release, while the canonical case changes
    // authority and proves an exact proof can apply a locked state. Broadcasts
    // and delayed normal callbacks from the prior generation must do neither.
    await worker.evaluate(async (serverUrl) => {
      const auth = {
        deviceId: 'managed-fence-device',
        studentToken: 'managed-fence-token',
        activeStudentId: 'managed-fence-student',
        activeStudentSessionId: 'managed-fence-session',
        identitySource: 'manual_pin',
        manualLoginLastSeenAt: Date.now(),
      };
      const config = {
        serverUrl,
        schoolId: 'cold-start-school',
        schoolSlug: 'cold-start-school',
        enrollmentKey: 'fixture-enrollment-key',
      };
      await chrome.storage.local.set({ config, ...auth });
      await chrome.storage.local.remove([
        'studentAuthInvalidatingV1',
        'studentAuthCommitPendingV1',
        'managedAuthGateBindingV1',
      ]);
      await chrome.storage.session?.set(auth);
    }, fixture.origin);
    await corruptPage.goto('chrome://version');
    const managedFenceSeedStop = await stopExtensionWorker(context, corruptPage, extensionId);
    assert.equal(managedFenceSeedStop.stopped, true, 'could not restart before managed-policy UI fence');
    await corruptPage.goto(`${fixture.origin}/managed-policy-fence`, { waitUntil: 'domcontentloaded' });
    worker = await waitForLiveWorker(context);
    await corruptPage.waitForTimeout(350);
    assert.equal(await corruptPage.locator(GATE_SELECTOR).count(), 0, 'managed fence fixture did not begin unlocked');
    const managedFenceWorld = await openAuthGateIsolatedWorld(context, corruptPage, extensionId);
    try {
      for (const scenario of [
        {
          label: 'alias-key',
          referenceName: '__managedAliasPageFrame',
          policy: {
            fastAuthGateEnabled: true,
            classpilotServerUrl: fixture.origin,
            classpilotSchoolId: 'cold-start-school',
            classpilotSchoolSlug: 'cold-start-school',
            classpilotEnrollmentKey: 'fixture-enrollment-key',
          },
          expectRelease: true,
        },
        {
          label: 'canonical-key',
          referenceName: '__managedCanonicalPageFrame',
          policy: {
            fastAuthGateEnabled: true,
            serverUrl: fixture.origin,
            schoolId: 'managed-fence-new-school',
            schoolSlug: 'managed-fence-new-school',
            enrollmentKey: 'managed-fence-new-enrollment',
          },
          expectRelease: false,
        },
      ]) {
        const prechangeState = await worker.evaluate(() => getAuthGateState());
        assert.equal(prechangeState.phase, 'authenticated', `${scenario.label}: prechange worker state is not authenticated`);
        await corruptPage.evaluate(({ referenceName }) => {
          const frame = document.createElement('iframe');
          const anchor = document.createElement('span');
          frame.src = 'about:blank';
          frame.id = `${referenceName}-frame`;
          anchor.id = `${referenceName}-anchor`;
          window[referenceName] = frame;
          window[`${referenceName}Anchor`] = anchor;
          document.body.append(frame, anchor);
        }, scenario);
        await installManagedFenceMessageHarness(managedFenceWorld);
        await beginManagedPolicyFenceRace(managedFenceWorld);
        await corruptPage.waitForFunction(() => (
          document.getElementById('classpilot-auth-gate')?.dataset.classpilotAuthPhase === 'loading'
        ));
        assertManagedFenceLocked(
          await managedFenceSnapshot(corruptPage, scenario.referenceName),
          `${scenario.label} initial relock`,
        );

        for (const revision of [prechangeState.revision, prechangeState.revision + 1]) {
          await broadcastAuthMessage(worker, corruptPage, 'CLASSPILOT_AUTH_COMPLETE', {
            ...prechangeState,
            phase: 'authenticated',
            authRequired: false,
            revision,
          });
          await corruptPage.waitForTimeout(75);
          assertManagedFenceLocked(
            await managedFenceSnapshot(corruptPage, scenario.referenceName),
            `${scenario.label} stale COMPLETE revision ${revision}`,
          );
        }

        for (const invalidKind of ['wrong-fence', 'unsafe-generation', 'stale-revision']) {
          const rejectedRequests = await evaluateInAuthGateWorld(
            managedFenceWorld,
            `globalThis.__classpilotManagedFenceTestHarness.replyInvalid(${JSON.stringify(invalidKind)}, ${Number(prechangeState.revision)})`,
          );
          assert.equal(
            rejectedRequests.count,
            2,
            `${scenario.label}: ${invalidKind} did not exercise both UI controllers`,
          );
          assert.deepEqual(
            [...rejectedRequests.sources].sort(),
            ['bootstrap', 'content'],
            `${scenario.label}: ${invalidKind} did not acknowledge bootstrap and content`,
          );
          await waitForManagedFenceRequests(managedFenceWorld, 2, {
            revalidate: true,
            timeout: 7_000,
          });
          assertManagedFenceLocked(
            await managedFenceSnapshot(corruptPage, scenario.referenceName),
            `${scenario.label} ${invalidKind} acknowledgement`,
          );
        }

        await worker.evaluate((managedPolicy) => {
          if (!globalThis.__classpilotManagedFenceOriginalRead) {
            globalThis.__classpilotManagedFenceOriginalRead = readManagedConfig;
          }
          if (!globalThis.__classpilotManagedFenceOriginalRun) {
            globalThis.__classpilotManagedFenceOriginalRun = runManagedAuthGatePolicyRevalidation;
          }
          let releaseRead;
          const readBarrier = new Promise((resolveRead) => {
            releaseRead = resolveRead;
          });
          globalThis.__classpilotManagedFenceCoalesceHarness = {
            entered: false,
            runCount: 0,
            directReadCount: 0,
            backgroundReadCount: 0,
            inDirectRun: false,
            releaseRead,
          };
          runManagedAuthGatePolicyRevalidation = (...args) => {
            const harness = globalThis.__classpilotManagedFenceCoalesceHarness;
            harness.runCount += 1;
            harness.inDirectRun = true;
            try {
              return globalThis.__classpilotManagedFenceOriginalRun(...args);
            } finally {
              harness.inDirectRun = false;
            }
          };
          readManagedConfig = async () => {
            const harness = globalThis.__classpilotManagedFenceCoalesceHarness;
            if (harness.inDirectRun) {
              harness.entered = true;
              harness.directReadCount += 1;
              await readBarrier;
            } else {
              harness.backgroundReadCount += 1;
            }
            return { ...managedPolicy };
          };
        }, scenario.policy);
        let directProof;
        try {
          const forwarded = await evaluateInAuthGateWorld(
            managedFenceWorld,
            'globalThis.__classpilotManagedFenceTestHarness.beginWorkerReplies()',
          );
          assert.equal(forwarded.requestCount, 2, `${scenario.label}: expected one retry from each UI controller`);
          const coalesceDeadline = Date.now() + 7_000;
          let coalesceState = null;
          while (Date.now() < coalesceDeadline) {
            coalesceState = await worker.evaluate(() => ({
              entered: globalThis.__classpilotManagedFenceCoalesceHarness?.entered === true,
              runCount: globalThis.__classpilotManagedFenceCoalesceHarness?.runCount ?? 0,
              directReadCount: globalThis.__classpilotManagedFenceCoalesceHarness?.directReadCount ?? 0,
              inFlight: managedAuthGateDirectRevalidationInFlight !== null,
            }));
            if (coalesceState.entered) break;
            await new Promise((resolvePoll) => setTimeout(resolvePoll, 25));
          }
          assert.equal(coalesceState?.entered, true, `${scenario.label}: worker revalidation did not begin`);
          assert.equal(coalesceState?.runCount, 1, `${scenario.label}: concurrent retries started duplicate transactions`);
          assert.equal(coalesceState?.directReadCount, 1, `${scenario.label}: concurrent retries performed duplicate managed reads`);
          assert.equal(coalesceState?.inFlight, true, `${scenario.label}: shared revalidation was not tracked`);
          await worker.evaluate(() => {
            globalThis.__classpilotManagedFenceCoalesceHarness.releaseRead();
          });
          const directProofs = await evaluateInAuthGateWorld(
            managedFenceWorld,
            'globalThis.__classpilotManagedFenceTestHarness.finishWorkerReplies()',
          );
          assert.equal(directProofs.length, 2, `${scenario.label}: both UI controllers did not receive a proof`);
          for (const proof of directProofs) {
            assert.equal(proof.success, true, `${scenario.label}: worker did not return a direct fence proof`);
            assert.equal(
              proof.managedPolicyFence,
              proof.requestedFence,
              `${scenario.label}: worker echoed another controller's fence`,
            );
          }
          assert.equal(
            new Set(directProofs.map((proof) => proof.managedPolicyGeneration)).size,
            1,
            `${scenario.label}: concurrent retries did not share one managed generation`,
          );
          assert.equal(
            new Set(directProofs.map((proof) => proof.revision)).size,
            1,
            `${scenario.label}: concurrent retries did not share one authoritative state`,
          );
          directProof = directProofs[0];
          const completedCoalesce = await worker.evaluate(() => ({
            runCount: globalThis.__classpilotManagedFenceCoalesceHarness?.runCount ?? 0,
            directReadCount: globalThis.__classpilotManagedFenceCoalesceHarness?.directReadCount ?? 0,
            inFlight: managedAuthGateDirectRevalidationInFlight !== null,
          }));
          assert.deepEqual(completedCoalesce, {
            runCount: 1,
            directReadCount: 1,
            inFlight: false,
          });
        } finally {
          await worker.evaluate(() => {
            if (globalThis.__classpilotManagedFenceOriginalRead) {
              readManagedConfig = globalThis.__classpilotManagedFenceOriginalRead;
              delete globalThis.__classpilotManagedFenceOriginalRead;
            }
            if (globalThis.__classpilotManagedFenceOriginalRun) {
              runManagedAuthGatePolicyRevalidation = globalThis.__classpilotManagedFenceOriginalRun;
              delete globalThis.__classpilotManagedFenceOriginalRun;
            }
            delete globalThis.__classpilotManagedFenceCoalesceHarness;
          });
        }
        assert.equal(directProof.success, true, `${scenario.label}: worker did not return a direct fence proof`);
        assert.ok(Number.isSafeInteger(directProof.managedPolicyGeneration));
        assert.ok(Number.isSafeInteger(directProof.revision));
        assert.ok(directProof.revision >= prechangeState.revision);

        if (scenario.expectRelease) {
          assert.equal(directProof.phase, 'authenticated');
          await corruptPage.waitForSelector(GATE_SELECTOR, { state: 'detached', timeout: 7_000 });
          const delayedCount = await evaluateInAuthGateWorld(
            managedFenceWorld,
            `globalThis.__classpilotManagedFenceTestHarness.replyNormal({
              phase: 'loading', authRequired: true, revision: ${Number(directProof.revision) + 1}
            })`,
          );
          assert.ok(delayedCount >= 1, `${scenario.label}: no prechange normal response was delayed`);
          await corruptPage.waitForTimeout(150);
          await corruptPage.waitForFunction((referenceName) => {
            const frame = window[referenceName];
            const anchor = window[`${referenceName}Anchor`];
            return document.body?.hasAttribute('inert') === false
              && document.body.style.getPropertyValue('display') === ''
              && frame?.isConnected === true
              && frame.nextSibling === anchor;
          }, scenario.referenceName, { timeout: 3_000 });
          const released = await managedFenceSnapshot(corruptPage, scenario.referenceName);
          assert.equal(released.gatePresent, false, `${scenario.label}: delayed normal response re-gated the page`);
          assert.equal(released.bodyInert, false, `${scenario.label}: page quarantine did not release`);
          assert.equal(released.bodyDisplay, '', `${scenario.label}: page display was not restored`);
          assert.equal(released.frameConnected, true, `${scenario.label}: detached page frame was not restored`);
          assert.equal(released.frameBeforeAnchor, true, `${scenario.label}: page frame placement was not restored`);
        } else {
          assert.notEqual(directProof.phase, 'authenticated');
          assert.equal(directProof.authRequired, true);
          assertManagedFenceLocked(
            await managedFenceSnapshot(corruptPage, scenario.referenceName),
            `${scenario.label} exact locked acknowledgement`,
          );
          const delayedCount = await evaluateInAuthGateWorld(
            managedFenceWorld,
            `globalThis.__classpilotManagedFenceTestHarness.replyNormal({
              phase: 'authenticated', authRequired: false, revision: ${Number(directProof.revision) + 1}
            })`,
          );
          assert.ok(delayedCount >= 1, `${scenario.label}: no prechange normal response was delayed`);
          await corruptPage.waitForTimeout(150);
          assertManagedFenceLocked(
            await managedFenceSnapshot(corruptPage, scenario.referenceName),
            `${scenario.label} delayed prechange normal response`,
            { allowedPhases: ['loading', 'ready', 'setup_required', 'unavailable'] },
          );
          await assertUnderlyingPageLocked(corruptPage);
        }
        await evaluateInAuthGateWorld(
          managedFenceWorld,
          'globalThis.__classpilotManagedFenceTestHarness.restore()',
        );
      }
    } finally {
      await managedFenceWorld.cdp.detach();
    }

    console.log(`ClassPilot fast auth startup checks passed (loading paint ${loadingPaintMs}ms)`);
  } finally {
    try {
      await context?.close();
    } finally {
      if (fixture?.server) await new Promise((resolveClose) => fixture.server.close(resolveClose));
      rmSync(extensionPath, { recursive: true, force: true });
      rmSync(profilePath, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
