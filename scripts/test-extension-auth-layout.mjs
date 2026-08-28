import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
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
const screenshotDir = String(process.env.CLASSPILOT_AUTH_SCREENSHOT_DIR || '').trim();

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

async function startFixtureServer() {
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><html><body><button id="page-control">Blocked page control</button></body></html>');
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', resolveListen);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture server did not expose a port');
  return { server, url: `http://127.0.0.1:${address.port}/` };
}

async function waitForWorker(context) {
  return context.serviceWorkers()[0] || context.waitForEvent('serviceworker', { timeout: 10_000 });
}

async function waitForTabId(worker, url) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const tabId = await worker.evaluate(async (expectedUrl) => {
      const tabs = await chrome.tabs.query({});
      return tabs.find((tab) => tab.url === expectedUrl)?.id || null;
    }, url);
    if (tabId) return tabId;
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 100));
  }
  throw new Error(`Could not find extension tab for ${url}`);
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

let nextTestRevision = 9_000_000_000_000;

async function deliverGateState(worker, tabId, state) {
  return worker.evaluate(async ({ targetTabId, nextState }) => {
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
  }, { targetTabId: tabId, nextState: state });
}

async function showGate(worker, tabId, page, state) {
  const phase = state.phase || (state.setupRequired ? 'setup_required' : 'ready');
  const revision = Number.isFinite(state.revision) ? state.revision : nextTestRevision++;
  const authoritativeState = { ...state, phase, revision };
  const deadline = Date.now() + 10_000;
  let delivered = false;
  let lastError = '';
  while (Date.now() < deadline) {
    const response = await deliverGateState(worker, tabId, authoritativeState);
    if (response?.success) {
      delivered = true;
      break;
    }
    lastError = response?.error || 'unknown delivery error';
    await new Promise((resolvePoll) => setTimeout(resolvePoll, 100));
  }
  if (!delivered) throw new Error(`Could not show the student auth gate: ${lastError}`);
  await page.waitForSelector('#classpilot-auth-gate', { state: 'attached' });
  const frame = await waitForAuthFrame(page);
  await frame.waitForSelector('.classpilot-auth-panel', { state: 'visible' });

  // The first delivery can create the secure frame before that frame has
  // installed its runtime listener. Re-deliver only after initialization so
  // its direct get-auth-state response cannot replace the requested fixture
  // phase and leave the host/frame assertions waiting on a state never sent.
  const synchronized = await deliverGateState(worker, tabId, authoritativeState);
  if (!synchronized?.success) {
    throw new Error(`Could not synchronize the student auth frame: ${synchronized?.error || 'unknown delivery error'}`);
  }
  await Promise.all([
    page.waitForFunction((expectedPhase) => (
      document.getElementById('classpilot-auth-gate')?.dataset.classpilotAuthPhase === expectedPhase
    ), phase, { timeout: 10_000 }),
    frame.waitForFunction((expectedPhase) => (
      document.getElementById('classpilot-auth-gate')?.dataset.classpilotAuthPhase === expectedPhase
    ), phase, { timeout: 10_000 }),
  ]);
  return frame;
}

async function preparePinForm(frame) {
  await frame.waitForSelector('#classpilot-auth-pin-form');
  assert.equal(
    await frame.$eval('#classpilot-auth-pin-submit', (button) => button.disabled),
    true,
    'PIN submit should start disabled'
  );
  await frame.waitForFunction(() => {
    const status = document.getElementById('classpilot-auth-roster-status');
    return status && !status.textContent.includes('Loading');
  });
  await frame.evaluate(() => {
    const grade = document.getElementById('classpilot-auth-grade');
    const student = document.getElementById('classpilot-auth-student');
    const pin = document.getElementById('classpilot-auth-pin');
    const status = document.getElementById('classpilot-auth-roster-status');
    grade.innerHTML = '<option value="5">Grade 5</option>';
    grade.disabled = false;
    grade.value = '5';
    student.innerHTML = '<option value="student-1">Jordan Student</option>';
    student.disabled = false;
    student.value = 'student-1';
    status.textContent = '';
    student.dispatchEvent(new Event('change', { bubbles: true }));
    pin.value = '123';
    pin.dispatchEvent(new Event('input', { bubbles: true }));
  });
  assert.equal(
    await frame.$eval('#classpilot-auth-pin-submit', (button) => button.disabled),
    true,
    'PIN submit should remain disabled until all four digits are entered'
  );
  await frame.evaluate(() => {
    const pin = document.getElementById('classpilot-auth-pin');
    pin.value = '1234';
    pin.dispatchEvent(new Event('input', { bubbles: true }));
  });
  assert.equal(
    await frame.$eval('#classpilot-auth-pin-submit', (button) => button.disabled),
    true,
    'synthetic roster markup must not bypass the live-roster readiness invariant'
  );
}

async function installRosterUiHarness(frame) {
  const installed = await frame.evaluate(() => {
    const originalSendMessage = chrome.runtime.sendMessage;
    const originalSetTimeout = window.setTimeout.bind(window);
    const originalClearTimeout = window.clearTimeout.bind(window);
    const harness = {
      originalSendMessage,
      originalSetTimeout,
      originalClearTimeout,
      queuedResponses: [],
      requests: [],
      refreshTimers: new Map(),
      nextRefreshTimerId: -1,
      enqueue(response) {
        this.queuedResponses.push(response);
      },
      runLatestRefreshTimer() {
        const entries = Array.from(this.refreshTimers.entries());
        const latest = entries.at(-1);
        if (!latest) return null;
        const [timerId, timer] = latest;
        this.refreshTimers.delete(timerId);
        timer.callback(...timer.args);
        return timer.delay;
      },
      restore() {
        chrome.runtime.sendMessage = this.originalSendMessage;
        window.setTimeout = this.originalSetTimeout;
        window.clearTimeout = this.originalClearTimeout;
        this.refreshTimers.clear();
        delete globalThis.__classpilotRosterUiHarness;
      },
    };
    window.setTimeout = function(callback, delay, ...args) {
      if (Number(delay) >= 25_000 && Number(delay) <= 5 * 60_000) {
        const timerId = harness.nextRefreshTimerId--;
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
        const response = harness.queuedResponses.shift() || {
          success: false,
          error: 'No roster UI fixture response was queued.',
        };
        queueMicrotask(() => callback(response));
        return undefined;
      }
      return originalSendMessage.call(chrome.runtime, message, ...args);
    };
    globalThis.__classpilotRosterUiHarness = harness;
    return chrome.runtime.sendMessage !== originalSendMessage;
  });
  assert.equal(installed, true, 'could not install secure-frame roster UI harness');
}

async function enqueueRosterUiResponse(frame, response) {
  await frame.evaluate((nextResponse) => {
    globalThis.__classpilotRosterUiHarness.enqueue(nextResponse);
  }, response);
}

async function exerciseRosterRefreshUi(frame) {
  await enqueueRosterUiResponse(frame, {
    success: true,
    students: [{
      id: 'student-1',
      name: 'Jordan Student',
      hasPin: true,
      reclaimable: true,
    }],
  });
  await frame.evaluate(() => {
    const grade = document.getElementById('classpilot-auth-grade');
    grade.replaceChildren(new Option('Grade 5', '5'));
    grade.disabled = false;
    grade.value = '5';
    grade.dispatchEvent(new Event('change', { bubbles: true }));
  });
  await frame.waitForFunction(() => (
    document.getElementById('classpilot-auth-student')?.options[1]?.textContent ===
      'Jordan Student — Resume on this Chromebook'
  ));
  assert.equal(
    await frame.locator('#classpilot-auth-roster-refresh').isEnabled(),
    true,
    'Refresh names should enable after the first selected-grade snapshot',
  );

  await frame.evaluate(() => {
    const student = document.getElementById('classpilot-auth-student');
    const pin = document.getElementById('classpilot-auth-pin');
    student.value = 'student-1';
    student.dispatchEvent(new Event('change', { bubbles: true }));
    pin.value = '1234';
    pin.dispatchEvent(new Event('input', { bubbles: true }));
    pin.focus();
  });
  await enqueueRosterUiResponse(frame, {
    success: false,
    error: 'temporary fixture failure',
    refreshAfterMs: 30_000,
  });
  await frame.evaluate(() => window.dispatchEvent(new Event('online')));
  await frame.waitForFunction(() => (
    document.getElementById('classpilot-auth-roster-status')?.classList.contains(
      'classpilot-auth-roster-note--warning',
    )
  ));
  assert.deepEqual(await frame.evaluate(() => ({
    selectedStudent: document.getElementById('classpilot-auth-student')?.value,
    pin: document.getElementById('classpilot-auth-pin')?.value,
    focus: document.activeElement?.id,
    submitDisabled: document.getElementById('classpilot-auth-pin-submit')?.disabled,
    request: globalThis.__classpilotRosterUiHarness.requests.at(-1),
  })), {
    selectedStudent: 'student-1',
    pin: '1234',
    focus: 'classpilot-auth-pin',
    submitDisabled: false,
    request: {
      type: 'get-login-roster',
      gradeLevel: '5',
      forceRefresh: true,
    },
  }, 'transient refresh failure should retain the same-context roster and credentials');

  await enqueueRosterUiResponse(frame, {
    success: true,
    cached: true,
    warning: 'fixture cache warning',
    students: [{
      id: 'student-1',
      name: 'Jordan Student',
      hasPin: true,
      reclaimable: true,
    }],
  });
  await frame.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow')));
  await frame.waitForFunction(() => (
    globalThis.__classpilotRosterUiHarness.requests.length >= 3 &&
    document.getElementById('classpilot-auth-roster-status')?.classList.contains(
      'classpilot-auth-roster-note--warning',
    )
  ));
  assert.deepEqual(await frame.evaluate(() => ({
    selectedStudent: document.getElementById('classpilot-auth-student')?.value,
    pin: document.getElementById('classpilot-auth-pin')?.value,
    focus: document.activeElement?.id,
  })), {
    selectedStudent: 'student-1',
    pin: '1234',
    focus: 'classpilot-auth-pin',
  }, 'a cached success should retain selection, PIN, and focus with an amber warning');

  await enqueueRosterUiResponse(frame, { success: true, students: [] });
  await frame.locator('#classpilot-auth-roster-refresh').click();
  await frame.waitForFunction(() => (
    document.getElementById('classpilot-auth-roster-status')?.textContent ===
      'No students are currently available.'
  ));
  assert.equal(
    await frame.locator('#classpilot-auth-student').isDisabled(),
    true,
    'a successful empty roster should disable student selection',
  );
  assert.equal(
    await frame.locator('#classpilot-auth-roster-refresh').isEnabled(),
    true,
    'a successful empty roster must remain refreshable',
  );

  await frame.evaluate(() => {
    const grade = document.getElementById('classpilot-auth-grade');
    const pin = document.getElementById('classpilot-auth-pin');
    grade.value = '';
    grade.dispatchEvent(new Event('change', { bubbles: true }));
    pin.value = '2468';
    pin.dispatchEvent(new Event('input', { bubbles: true }));
    pin.focus();
  });
  await enqueueRosterUiResponse(frame, { success: true, grades: [] });
  await frame.evaluate(() => document.getElementById('classpilot-auth-roster-refresh')?.click());
  await frame.waitForFunction(() => (
    document.getElementById('classpilot-auth-roster-status')?.textContent ===
      'No roster grades are currently available.'
  ));
  const emptyGradeSnapshot = await frame.evaluate(() => ({
    gradeDisabled: document.getElementById('classpilot-auth-grade')?.disabled,
    studentDisabled: document.getElementById('classpilot-auth-student')?.disabled,
    refreshDisabled: document.getElementById('classpilot-auth-roster-refresh')?.disabled,
    pin: document.getElementById('classpilot-auth-pin')?.value,
    focus: document.activeElement?.id,
    request: globalThis.__classpilotRosterUiHarness.requests.at(-1),
    refreshDelays: Array.from(
      globalThis.__classpilotRosterUiHarness.refreshTimers.values(),
      (timer) => timer.delay,
    ),
  }));
  assert.deepEqual(emptyGradeSnapshot.request, {
    type: 'get-login-roster',
    forceRefresh: true,
  }, 'Refresh names should reload grades when no grade is selected');
  assert.equal(emptyGradeSnapshot.gradeDisabled, true);
  assert.equal(emptyGradeSnapshot.studentDisabled, true);
  assert.equal(emptyGradeSnapshot.refreshDisabled, false, 'an empty grade list must remain refreshable');
  assert.equal(emptyGradeSnapshot.pin, '2468', 'an empty grade refresh cleared PIN input');
  assert.equal(emptyGradeSnapshot.focus, 'classpilot-auth-pin', 'an empty grade refresh moved focus');
  assert.equal(emptyGradeSnapshot.refreshDelays.length, 1, 'an empty grade list did not schedule recovery');
  assert.ok(
    emptyGradeSnapshot.refreshDelays[0] >= 25_000 && emptyGradeSnapshot.refreshDelays[0] <= 35_000,
    `empty grade recovery delay was outside 25–35 seconds: ${emptyGradeSnapshot.refreshDelays[0]}`,
  );

  const availableGrades = {
    success: true,
    grades: [
      { value: '4', label: 'Grade 4' },
      { value: '5', label: 'Grade 5' },
    ],
  };
  await enqueueRosterUiResponse(frame, availableGrades);
  const automaticDelay = await frame.evaluate(() => (
    globalThis.__classpilotRosterUiHarness.runLatestRefreshTimer()
  ));
  assert.ok(automaticDelay >= 25_000 && automaticDelay <= 35_000);
  await frame.waitForFunction(() => (
    document.getElementById('classpilot-auth-grade')?.options.length === 3 &&
    document.getElementById('classpilot-auth-grade')?.disabled === false
  ));
  assert.deepEqual(
    await frame.evaluate(() => globalThis.__classpilotRosterUiHarness.requests.at(-1)),
    { type: 'get-login-roster' },
    'the empty-grade timer should refresh the grade list without inventing a grade target',
  );

  for (const eventName of ['online', 'pageshow', 'focus', 'visibilitychange']) {
    const requestCount = await frame.evaluate(() => globalThis.__classpilotRosterUiHarness.requests.length);
    await enqueueRosterUiResponse(frame, availableGrades);
    await frame.evaluate((name) => {
      if (name === 'visibilitychange') document.dispatchEvent(new Event(name));
      else if (name === 'pageshow') window.dispatchEvent(new PageTransitionEvent(name));
      else window.dispatchEvent(new Event(name));
    }, eventName);
    await frame.waitForFunction((minimum) => (
      globalThis.__classpilotRosterUiHarness.requests.length > minimum
    ), requestCount);
    assert.deepEqual(
      await frame.evaluate(() => ({
        request: globalThis.__classpilotRosterUiHarness.requests.at(-1),
        grade: document.getElementById('classpilot-auth-grade')?.value,
        pin: document.getElementById('classpilot-auth-pin')?.value,
        focus: document.activeElement?.id,
      })),
      {
        request: { type: 'get-login-roster', forceRefresh: true },
        grade: '',
        pin: '2468',
        focus: 'classpilot-auth-pin',
      },
      `${eventName} should refresh grades without clearing context, PIN, or focus`,
    );
  }

  await frame.evaluate(() => globalThis.__classpilotRosterUiHarness.restore());
}

async function setAuthViewport(page, frame, viewport, expectedSideVisible = null) {
  await page.setViewportSize(viewport);
  await frame.waitForFunction(({ width, height, sideVisible }) => {
    const side = document.querySelector('.classpilot-auth-side');
    return window.innerWidth === width
      && window.innerHeight === height
      && (sideVisible === null || (getComputedStyle(side).display !== 'none') === sideVisible);
  }, {
    width: viewport.width,
    height: viewport.height,
    sideVisible: expectedSideVisible,
  });
}

async function layoutSnapshot(frame) {
  return frame.evaluate(() => {
    const rect = (selector) => {
      const element = document.querySelector(selector);
      if (!element || element.getClientRects().length === 0) return null;
      const bounds = element.getBoundingClientRect();
      return {
        top: bounds.top,
        right: bounds.right,
        bottom: bounds.bottom,
        left: bounds.left,
        width: bounds.width,
        height: bounds.height,
      };
    };
    const gate = document.getElementById('classpilot-auth-gate');
    const panel = document.querySelector('.classpilot-auth-panel');
    const main = document.querySelector('.classpilot-auth-main');
    const submit = document.getElementById('classpilot-auth-pin-submit') ||
      document.getElementById('classpilot-auth-email-submit') ||
      document.getElementById('classpilot-auth-retry');
    const submitRect = submit?.getBoundingClientRect();
    const hit = submitRect
      ? document.elementFromPoint(submitRect.left + submitRect.width / 2, submitRect.top + submitRect.height / 2)
      : null;
    return {
      viewport: { width: window.innerWidth, height: window.innerHeight },
      gate: rect('#classpilot-auth-gate'),
      panel: rect('.classpilot-auth-panel'),
      sideDisplay: getComputedStyle(document.querySelector('.classpilot-auth-side')).display,
      main: rect('.classpilot-auth-main'),
      mainClientHeight: main?.clientHeight || 0,
      mainScrollHeight: main?.scrollHeight || 0,
      mainScrollTop: main?.scrollTop || 0,
      gateClientWidth: gate?.clientWidth || 0,
      gateScrollWidth: gate?.scrollWidth || 0,
      grade: rect('#classpilot-auth-grade'),
      student: rect('#classpilot-auth-student'),
      pin: rect('#classpilot-auth-pin'),
      submit: submitRect ? rect(`#${submit.id}`) : null,
      title: rect('#classpilot-auth-title'),
      subtitle: rect('#classpilot-auth-subtitle'),
      status: rect('#classpilot-auth-roster-status'),
      error: rect('#classpilot-auth-error'),
      kiosk: rect('#classpilot-auth-kiosk-launch'),
      footnote: rect('.classpilot-auth-footnote'),
      setupNote: rect('.classpilot-auth-roster-note:not(#classpilot-auth-roster-status)'),
      submitHit: hit === submit || Boolean(submit?.contains(hit)),
    };
  });
}

function assertRectInside(rect, container, label) {
  assert.ok(rect, `${label}: element is missing`);
  assert.ok(rect.width > 0 && rect.height > 0, `${label}: element has no size`);
  assert.ok(rect.top >= container.top - 0.5, `${label}: element starts above its container`);
  assert.ok(rect.left >= container.left - 0.5, `${label}: element starts left of its container`);
  assert.ok(rect.right <= container.right + 0.5, `${label}: element exceeds its container width`);
  assert.ok(rect.bottom <= container.bottom + 0.5, `${label}: element exceeds its container height`);
}

function assertNoOverlap(first, second, label) {
  const overlapWidth = Math.max(0, Math.min(first.right, second.right) - Math.max(first.left, second.left));
  const overlapHeight = Math.max(0, Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top));
  assert.equal(overlapWidth * overlapHeight, 0, `${label}: controls overlap`);
}

function assertInsideViewport(snapshot, label, options = {}) {
  const { panel, submit, viewport } = snapshot;
  assert.ok(panel, `${label}: panel is missing`);
  assert.ok(panel.top >= -0.5, `${label}: panel starts above the viewport (${panel.top})`);
  assert.ok(panel.left >= -0.5, `${label}: panel starts left of the viewport (${panel.left})`);
  assert.ok(panel.right <= viewport.width + 0.5, `${label}: panel exceeds viewport width (${panel.right})`);
  assert.ok(panel.bottom <= viewport.height + 0.5, `${label}: panel exceeds viewport height (${panel.bottom})`);
  assert.equal(snapshot.gateScrollWidth, snapshot.gateClientWidth, `${label}: gate has horizontal overflow`);
  if (options.requireContent !== false) {
    assertRectInside(snapshot.title, panel, `${label} title`);
    assertRectInside(snapshot.subtitle, panel, `${label} subtitle`);
  }
  if (options.requireFootnote !== false) {
    assertRectInside(snapshot.footnote, panel, `${label} footnote`);
  }
  if (options.requireSubmit !== false) {
    assert.ok(submit, `${label}: submit button is missing`);
    assert.ok(submit.top >= 0 && submit.bottom <= viewport.height, `${label}: submit button is clipped`);
    assert.equal(snapshot.submitHit, true, `${label}: submit button is not hit-testable`);
  }
}

async function capture(page, name) {
  if (!screenshotDir) return;
  mkdirSync(screenshotDir, { recursive: true });
  await page.screenshot({ path: join(screenshotDir, `${name}.png`) });
}

async function main() {
  let context;
  let fixture;
  let profilePath;
  try {
    const executablePath = chromeExecutable();
    if (!executablePath) {
      throw new Error('Chrome for Testing was not found. Run `npx playwright install chromium`.');
    }
    profilePath = mkdtempSync(join(tmpdir(), 'classpilot-auth-layout-'));
    fixture = await startFixtureServer();
    context = await chromium.launchPersistentContext(profilePath, {
      executablePath,
      headless: true,
      viewport: { width: 1366, height: 600 },
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
      ],
    });
    const worker = await waitForWorker(context);
    const page = context.pages()[0] || await context.newPage();
    await page.goto(fixture.url, { waitUntil: 'networkidle' });
    await page.waitForSelector('#classpilot-auth-gate', { state: 'attached' });
    const tabId = await waitForTabId(worker, page.url());

    let authFrame = await showGate(worker, tabId, page, {
      phase: 'loading',
      setupRequired: false,
      loginMethod: 'name_pin',
      configFetchedAt: null,
      retryAt: Date.now() + 2_000,
    });
    await page.waitForFunction(() => document.getElementById('classpilot-auth-gate')?.dataset.classpilotAuthPhase === 'loading');
    assert.match(await authFrame.locator('#classpilot-auth-gate').innerText(), /Connecting to ClassPilot/i);
    assert.equal(
      await authFrame.locator('#classpilot-auth-gate input:not([disabled]), #classpilot-auth-gate select:not([disabled]), #classpilot-auth-gate button:not([disabled])').count(),
      0,
      'loading presentation must not enable authentication controls'
    );
    for (const viewport of [
      { width: 1366, height: 600 },
      { width: 1024, height: 600 },
      { width: 800, height: 600 },
      { width: 600, height: 640 },
    ]) {
      await setAuthViewport(page, authFrame, viewport);
      const label = `loading-${viewport.width}x${viewport.height}`;
      assertInsideViewport(await layoutSnapshot(authFrame), label, { requireSubmit: false, requireFootnote: false });
      await capture(page, label);
    }

    authFrame = await showGate(worker, tabId, page, {
      phase: 'unavailable',
      setupRequired: false,
      loginMethod: 'name_pin',
      configFetchedAt: null,
      retryAt: Date.now() + 2_000,
    });
    await authFrame.waitForSelector('#classpilot-auth-retry', { state: 'visible' });
    for (const viewport of [
      { width: 1366, height: 600 },
      { width: 1024, height: 600 },
      { width: 800, height: 600 },
      { width: 600, height: 640 },
    ]) {
      await setAuthViewport(page, authFrame, viewport);
      const label = `unavailable-${viewport.width}x${viewport.height}`;
      const snapshot = await layoutSnapshot(authFrame);
      assertInsideViewport(snapshot, label);
      assert.equal(snapshot.submitHit, true, `${label}: Retry now is not hit-testable`);
      await capture(page, label);
    }

    await installRosterUiHarness(authFrame);
    await enqueueRosterUiResponse(authFrame, {
      success: true,
      grades: [
        { value: '4', label: 'Grade 4' },
        { value: '5', label: 'Grade 5' },
      ],
    });
    authFrame = await showGate(worker, tabId, page, {
      setupRequired: false,
      loginMethod: 'name_pin',
      rosterContextGeneration: 1,
    });
    await preparePinForm(authFrame);

    for (const viewport of [
      { width: 1366, height: 768, sideVisible: true },
      { width: 1366, height: 600, sideVisible: true },
      { width: 1024, height: 600, sideVisible: true },
      { width: 800, height: 600, sideVisible: false },
      { width: 600, height: 640, sideVisible: false },
    ]) {
      await setAuthViewport(
        page,
        authFrame,
        { width: viewport.width, height: viewport.height },
        viewport.sideVisible,
      );
      const snapshot = await layoutSnapshot(authFrame);
      const label = `${viewport.width}x${viewport.height}`;
      assertInsideViewport(snapshot, label);
      assert.equal(snapshot.sideDisplay !== 'none', viewport.sideVisible, `${label}: unexpected safety-rail mode`);
      assertRectInside(snapshot.grade, snapshot.panel, `${label} grade`);
      assertRectInside(snapshot.student, snapshot.panel, `${label} student`);
      assertRectInside(snapshot.pin, snapshot.panel, `${label} PIN`);
      assertNoOverlap(snapshot.grade, snapshot.student, `${label} grade/student`);
      assertNoOverlap(snapshot.pin, snapshot.submit, `${label} PIN/submit`);
      await capture(page, `pin-${label}`);
    }

    await setAuthViewport(page, authFrame, { width: 1024, height: 600 }, true);
    await authFrame.evaluate(() => {
      const error = document.getElementById('classpilot-auth-error');
      error.textContent = 'The roster could not refresh. Check the Chromebook connection, then choose the grade again.';
      error.style.display = 'block';
      document.getElementById('classpilot-auth-pin')?.focus();
    });
    assert.equal(await authFrame.evaluate(() => document.activeElement?.id), 'classpilot-auth-pin');
    assert.deepEqual(await authFrame.evaluate(() => ({
      grade: document.getElementById('classpilot-auth-grade')?.value,
      student: document.getElementById('classpilot-auth-student')?.value,
      pin: document.getElementById('classpilot-auth-pin')?.value,
      submitDisabled: document.getElementById('classpilot-auth-pin-submit')?.disabled,
    })), { grade: '5', student: 'student-1', pin: '1234', submitDisabled: true });
    await authFrame.evaluate(() => {
      document.getElementById('classpilot-auth-roster-status').textContent =
        'The roster could not refresh. Check the Chromebook connection, then choose the grade again.';
    });
    const errorSnapshot = await layoutSnapshot(authFrame);
    assertInsideViewport(errorSnapshot, 'pin-error-1024x600');
    assertRectInside(errorSnapshot.error, errorSnapshot.panel, 'pin error message');
    assertRectInside(errorSnapshot.status, errorSnapshot.panel, 'roster status message');

    await setAuthViewport(page, authFrame, { width: 1366, height: 600 }, true);
    await authFrame.locator('#classpilot-auth-pin-submit').focus();
    await authFrame.locator('#classpilot-auth-pin-submit').press('Tab');
    assert.equal(await authFrame.evaluate(() => document.activeElement?.id), 'classpilot-auth-grade');
    await page.locator('#page-control').focus();
    await page.waitForTimeout(50);
    assert.equal(await authFrame.evaluate(() => document.activeElement?.id), 'classpilot-auth-grade');

    await exerciseRosterRefreshUi(authFrame);

    authFrame = await showGate(worker, tabId, page, {
      setupRequired: false,
      loginMethod: 'name_pin',
      rosterContextGeneration: 2,
    });
    assert.equal(
      await authFrame.locator('#classpilot-auth-pin').inputValue(),
      '',
      'an authority-context change must purge the previous PIN',
    );
    assert.equal(
      await authFrame.locator('#classpilot-auth-student option', { hasText: 'Jordan Student' }).count(),
      0,
      'an authority-context change must purge cached roster names',
    );

    await setAuthViewport(page, authFrame, { width: 800, height: 320 }, false);
    const shortBeforeScroll = await layoutSnapshot(authFrame);
    assertInsideViewport(shortBeforeScroll, '800x320-scroll-fallback', {
      requireSubmit: false,
      requireContent: false,
    });
    await authFrame.evaluate(() => {
      const mainPanel = document.querySelector('.classpilot-auth-main');
      mainPanel.scrollTop = mainPanel.scrollHeight;
    });
    const shortAfterScroll = await layoutSnapshot(authFrame);
    assert.ok(
      shortAfterScroll.mainScrollHeight > shortAfterScroll.mainClientHeight,
      `short viewport did not exercise scroll fallback: ${JSON.stringify(shortAfterScroll)}`
    );
    assert.ok(shortAfterScroll.mainScrollTop > 0, 'short viewport main panel did not scroll');
    assertInsideViewport(shortAfterScroll, '800x320-after-scroll', { requireContent: false });

    await setAuthViewport(page, authFrame, { width: 1024, height: 600 }, true);
    authFrame = await showGate(worker, tabId, page, { setupRequired: false, loginMethod: 'email_id' });
    await authFrame.waitForSelector('#classpilot-auth-email-submit');
    const emailSnapshot = await layoutSnapshot(authFrame);
    assertInsideViewport(emailSnapshot, 'email-1024x600');
    assertRectInside(await authFrame.locator('#classpilot-auth-email').evaluate((element) => {
      const bounds = element.getBoundingClientRect();
      return { top: bounds.top, right: bounds.right, bottom: bounds.bottom, left: bounds.left, width: bounds.width, height: bounds.height };
    }), emailSnapshot.panel, 'email-1024x600 email');

    authFrame = await showGate(worker, tabId, page, {
      setupRequired: false,
      loginMethod: 'name_pin',
      kioskUrl: 'https://school-pilot.net/passpilot/kiosk',
    });
    await preparePinForm(authFrame);
    assertInsideViewport(await layoutSnapshot(authFrame), 'kiosk-1024x600');
    const kioskRect = await authFrame.locator('#classpilot-auth-kiosk-launch').boundingBox();
    await capture(page, 'kiosk-1024x600');
    assert.ok(kioskRect && kioskRect.y + kioskRect.height <= 600, `kiosk action is clipped at Chromebook height: ${JSON.stringify(kioskRect)}`);

    authFrame = await showGate(worker, tabId, page, { setupRequired: true, loginMethod: 'name_pin' });
    await authFrame.waitForSelector('.classpilot-auth-roster-note');
    const setupSnapshot = await layoutSnapshot(authFrame);
    assertInsideViewport(setupSnapshot, 'setup-required-1024x600', { requireSubmit: false });
    assertRectInside(setupSnapshot.setupNote, setupSnapshot.panel, 'setup-required note');

    console.log('ClassPilot student auth gate layout checks passed');
  } finally {
    try {
      await context?.close();
    } finally {
      if (fixture?.server) {
        await new Promise((resolveClose) => fixture.server.close(resolveClose));
      }
      if (profilePath) rmSync(profilePath, { recursive: true, force: true });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
