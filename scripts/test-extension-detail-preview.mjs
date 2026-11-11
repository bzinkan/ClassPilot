import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { resolve } from 'node:path';

const worker = readFileSync(process.env.CLASSPILOT_EXTENSION_PATH
  ? resolve(process.env.CLASSPILOT_EXTENSION_PATH, 'service-worker.js')
  : new URL('../extension/service-worker.js', import.meta.url), 'utf8').replace(/\r\n/g, '\n');
function declaration(name) {
  const start = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(worker);
  assert.ok(start, `production ${name} must exist`);
  const remainder = worker.slice(start.index + start[0].length);
  const end = /^}/m.exec(remainder);
  return worker.slice(start.index, start.index + start[0].length + end.index + 1);
}
const now = Date.parse('2026-11-10T14:00:00Z');
const authority = { kind: 'teaching_session', teachingSessionId: 'class', controlRevision: 3 };
const raw = { serverTime: new Date(now).toISOString(), detailPreview: {
  mode: 'selected_student', leaseId: 'abcdefghijklmnopqrstuvwx12345678', expiresInSeconds: 20,
  intervalSeconds: 5, maxWidth: 1920, jpegQuality: 90,
} };
function fixture() {
  let time = now, negotiated = true, active = true, uploads = [], captureOptions = [];
  const rejectedCapabilities = new Set();
  const auth = { signal: new AbortController().signal, serverOrigin: 'https://school.invalid' };
  const tab = { id: 4, windowId: 2, active: true, url: 'https://lesson.invalid/', title: 'Lesson' };
  const context = vm.createContext({ Date: class extends Date { static now() { return time; } },
    AbortController, setTimeout, clearTimeout, Uint8Array, btoa, fetch, console,
    SCREENSHOT_BROWSER_OPERATION_TIMEOUT_MS: 3000, SCREENSHOT_DETAIL_MAX_DATA_URL_LENGTH: 800_000,
    screenshotDetailCaptureInFlight: false, screenshotCaptureInFlight: false,
    screenshotPixelsCaptureOwner: null,
    screenshotDetailGeneration: 1, screenshotDetailAbortController: new AbortController(),
    screenshotDetailExpiryTimer: null,
    lastDetailPreviewPixelsAt: 0, lastScreenshotPixelsAt: 0, screenshotPolicyGeneration: 8,
    screenshotPolicyState: { mode: 'tracking_window_lease', valid: true, captureAllowed: true,
      authority, authorityScope: 'class:3', expiresAt: now + 60_000,
      captureCadence: { mode: 'active_view', expiresAt: now + 40_000 } },
    hasNegotiatedCapability: name => negotiated && !rejectedCapabilities.has(name),
    currentLicenseIsActive: () => true,
    activeObservationScreenshotCadenceAllowed: () => active,
    assertAuthenticatedContextCurrent(value) { assert.equal(value, auth); assert.equal(auth.signal.aborted, false); },
    captureAuthenticatedContext: () => auth,
    assertAmbientScreenshotPolicyCurrent() { if (!active) throw new Error('authority retired'); },
    boundedClassroomOperation: promise => promise,
    buildDeviceAuthHeaders: () => ({ Authorization: 'Bearer synthetic' }),
    extensionProtocolDescriptor: () => ({ clientProtocolVersion: 3, extensionVersion: '3.0.5' }),
    restrictionSafeMonitoringMetadata: () => ({ title: 'Lesson', url: tab.url, favicon: '' }),
    subscribeTabActivationFence: () => () => {}, subscribeTabNavigationFence: () => () => {},
    subscribeWindowFocusFence: () => () => {},
    encodeDetailPreview: async () => 'data:image/jpeg;base64,ZGV0YWls',
    chrome: { tabs: { query: async () => [tab], captureVisibleTab: async (_window, options) => {
      captureOptions.push(options); return 'data:image/jpeg;base64,bmF0aXZl';
    } } },
    fetchWithBackoff: async (_url, init, options) => { await options.beforeAttempt();
      uploads.push({ body: JSON.parse(init.body), options });
      return new Response('{"ok":true}', { status: 200 }); },
  });
  for (const name of ['normalizeScreenshotDetailPreview', 'detailPreviewAllowed',
    'assertDetailPreviewCurrent', 'isSameActiveCaptureTab', 'captureAndSendDetailPreview']) {
    vm.runInContext(declaration(name), context);
  }
  const policy = () => context.normalizeScreenshotDetailPreview(raw, auth,
    { requestStartedAt: now, responseReceivedAt: now }, context.screenshotPolicyState);
  context.screenshotPolicyState.detailPreview = policy();
  return { context, auth, uploads, captureOptions, policy,
    time(value) { time = value; }, disable(name) { if (name) rejectedCapabilities.add(name); else negotiated = false; },
    retire() { active = false; context.screenshotDetailGeneration++; context.screenshotDetailAbortController.abort(); },
  };
}

// Keep the production request/retry path intact. Only the HTTP boundary and
// timer completion are controlled, so a wrong lane changes observable sends.
function backoffFixture() {
  const f = fixture();
  const requests = [], waits = [], responses = [];
  Object.assign(f.context, {
    apiBackoffUntilMs: 0, heartbeatBackoffUntilMs: 0, screenshotBackoffUntilMs: 0,
    screenshotDetailBackoffUntilMs: 0, chatBackoffUntilMs: 0,
    API_RETRY_MAX_ATTEMPTS: 3, API_RETRY_MAX_DELAY_MS: 30_000,
    API_RETRY_BASE_DELAY_MS: 1000, API_RETRY_RATE_LIMIT_DELAY_MS: 10_000,
    API_RETRY_STATUS_CODES: new Set([408, 429, 500, 502, 503, 504]),
    Math: Object.assign(Object.create(Math), { random: () => 0 }),
    setConnectivityBadge: async () => {}, connectivityStatus: () => 'connected',
    scheduleEventHeartbeat: () => {},
    sleepMs: ms => new Promise(resolve => { waits.push({ ms, resolve }); }),
    fetch: async (_url, init) => {
      requests.push(JSON.parse(init.body || '{}'));
      return responses.shift() || new Response('{"ok":true}', { status: 200 });
    },
  });
  for (const name of ['randomIntBetween', 'parseRetryAfterMs', 'calculateRetryDelayMs',
    'requestBackoffUntil', 'setRequestBackoffUntil', 'noteApiBackoff', 'waitForApiBackoff', 'fetchWithBackoff']) {
    vm.runInContext(declaration(name), f.context);
  }
  return { ...f, requests, waits, responses };
}

test('selected detail lease is bounded to server, request, tracking and active-view deadlines', () => {
  const f = fixture();
  assert.equal(f.policy().expiresAt, now + 20_000);
  const skewed = f.context.normalizeScreenshotDetailPreview({ ...raw, serverTime: new Date(now + 5000).toISOString() },
    f.auth, { requestStartedAt: now, responseReceivedAt: now }, f.context.screenshotPolicyState);
  assert.equal(skewed.serverTimeOffsetMs, 5000);
  f.context.screenshotPolicyState.captureCadence.expiresAt = now + 5000;
  assert.equal(f.policy().expiresAt, now + 5000);
  const delayed = f.context.normalizeScreenshotDetailPreview(raw, f.auth,
    { requestStartedAt: now, responseReceivedAt: now + 3000 }, f.context.screenshotPolicyState);
  assert.equal(delayed.expiresAt, now + 5000);
  f.disable(); assert.equal(f.policy(), null);
});

test('malformed, unscoped, excessive and legacy detail policies never permit native detail capture', async () => {
  const f = fixture();
  for (const change of [{ leaseId: '' }, { expiresInSeconds: 21 }, { intervalSeconds: 1 },
    { maxWidth: 4000 }, { jpegQuality: 50 }, { mode: 'live_view' }]) {
    assert.equal(f.context.normalizeScreenshotDetailPreview({ ...raw, detailPreview: { ...raw.detailPreview, ...change } },
      f.auth, { requestStartedAt: now, responseReceivedAt: now }, f.context.screenshotPolicyState), null);
  }
  f.context.screenshotPolicyState.mode = 'legacy'; assert.equal(f.policy(), null);
  f.context.screenshotPolicyState.detailPreview = null;
  await f.context.captureAndSendDetailPreview(); assert.equal(f.captureOptions.length, 0);
});

test('each negotiated parent and a classroom active-view lease are required for selected detail', () => {
  for (const capability of ['scopedAuthorityChecksV1', 'screenshotTrackingWindowLeaseV1', 'screenshotActiveObservationCadenceV1']) {
    const f = fixture(); f.disable(capability); assert.equal(f.policy(), null, capability);
    assert.equal(f.context.detailPreviewAllowed(f.auth), false, capability);
  }
  const f = fixture();
  f.context.screenshotPolicyState.authority = { kind: 'student_session', controlRevision: 3 };
  assert.equal(f.policy(), null, 'report-only student authority is not implemented by this extension');
  f.context.screenshotPolicyState.authority = authority;
  f.context.screenshotPolicyState.captureCadence.mode = 'background'; assert.equal(f.policy(), null);
  f.context.screenshotPolicyState.captureCadence.mode = 'active_view';
  f.context.screenshotPolicyState.captureCadence.expiresAt = now; assert.equal(f.policy(), null);
  f.context.screenshotPolicyState.captureCadence.expiresAt = now + 20_000;
  f.context.CLASSPILOT_WINDOWS_BUILD = true; assert.equal(f.policy(), null);
});

test('detail uses native JPEG90, isolated full-image HTTP payload and a strict five-second pixel gap', async () => {
  const f = fixture(); await f.context.captureAndSendDetailPreview();
  assert.equal(f.captureOptions.length, 1); assert.equal(f.captureOptions[0].quality, 90);
  const { body, options } = f.uploads[0];
  assert.equal(body.captureKind, 'detail_preview'); assert.equal(body.detailPreviewLeaseId, raw.detailPreview.leaseId);
  assert.equal(body.screenshot, 'data:image/jpeg;base64,ZGV0YWls');
  assert.equal(body.screenshotAuthority.teachingSessionId, 'class');
  assert.equal(body.capturedAt, '2026-11-10T14:00:00.000Z');
  assert.equal(body.screenshotReferenceId, undefined); assert.equal(body.screenshotDelta, undefined);
  assert.equal(options.deviceTelemetry, undefined); assert.equal(options.maxAttempts, 1);
  f.time(now + 4999); await f.context.captureAndSendDetailPreview(); assert.equal(f.captureOptions.length, 1);
  f.time(now + 5000); await f.context.captureAndSendDetailPreview(); assert.equal(f.captureOptions.length, 2);
});

test('release or expiry during capture/encode discards pixels before upload', async () => {
  for (const phase of ['capture', 'encode', 'expiry']) {
    const f = fixture();
    if (phase === 'capture') f.context.chrome.tabs.captureVisibleTab = async () => { f.retire(); return 'data:image/jpeg;base64,bmF0aXZl'; };
    else f.context.encodeDetailPreview = async () => { if (phase === 'expiry') f.time(now + 20_001); else f.retire(); return 'data:image/jpeg;base64,ZGV0YWls'; };
    await f.context.captureAndSendDetailPreview(); assert.equal(f.uploads.length, 0, phase);
    assert.equal(f.context.screenshotDetailCaptureInFlight, false);
  }
});

test('changed tabs and current classroom authority are fenced on every native query boundary', async () => {
  for (const boundary of [1, 2, 3]) {
    const f = fixture(); let reads = 0;
    const query = f.context.chrome.tabs.query;
    f.context.chrome.tabs.query = async () => { const tabs = await query(); if (++reads === boundary) f.retire(); return tabs; };
    await f.context.captureAndSendDetailPreview();
    assert.equal(f.uploads.length, 0, String(boundary));
  }
  const f = fixture(); let reads = 0;
  const query = f.context.chrome.tabs.query;
  f.context.chrome.tabs.query = async () => { const tabs = await query(); return ++reads === 3 ? [{ ...tabs[0], id: 99 }] : tabs; };
  await f.context.captureAndSendDetailPreview(); assert.equal(f.uploads.length, 0);
});

test('pending native capture, missing detail encoder output and oversized image never upload detail', async () => {
  const f = fixture(); f.context.screenshotPixelsCaptureOwner = {};
  await f.context.captureAndSendDetailPreview(); assert.equal(f.captureOptions.length, 0);
  f.context.screenshotPixelsCaptureOwner = null;
  f.context.encodeDetailPreview = async () => null;
  await f.context.captureAndSendDetailPreview(); assert.equal(f.uploads.length, 0);
  f.time(now + 5000); f.context.encodeDetailPreview = async () => 'data:image/jpeg;base64,' + 'A'.repeat(800_000);
  await f.context.captureAndSendDetailPreview(); assert.equal(f.uploads.length, 0);
});

test('an exact policy refresh revokes optional detail immediately without clearing thumbnail authority', async () => {
  const f = fixture();
  for (const name of ['retireDetailPreviewCapture', 'pauseDetailPreviewForPolicyRefresh']) vm.runInContext(declaration(name), f.context);
  const oldSignal = f.context.screenshotDetailAbortController.signal;
  f.context.pauseDetailPreviewForPolicyRefresh();
  assert.equal(oldSignal.aborted, true);
  assert.equal(f.context.screenshotPolicyState.detailPreview, null);
  assert.equal(f.context.screenshotPolicyGeneration, 8);
  assert.equal(f.context.screenshotPolicyState.authority.teachingSessionId, 'class');
  await f.context.captureAndSendDetailPreview(); assert.equal(f.captureOptions.length, 0);
});

test('a detail HTTP 429 leaves routine screenshot, heartbeat, chat and general API requests able to send', async () => {
  const f = backoffFixture();
  f.responses.push(new Response('{"code":"RATE_LIMITED"}', { status: 429, headers: { 'Retry-After': '10' } }));
  await f.context.captureAndSendDetailPreview();
  const pending = ['screenshot', 'heartbeat', 'chat', 'api'].map(lane => f.context.fetchWithBackoff(
    `${f.auth.serverOrigin}/request/${lane}`, { method: 'POST', body: JSON.stringify({ lane }) },
    { maxAttempts: 1, backoffLane: lane },
  ));
  await new Promise(setImmediate);
  try {
    assert.deepEqual(f.requests.slice(1).map(body => body.lane).sort(), ['api', 'chat', 'heartbeat', 'screenshot'],
      'an optional detail cooldown must not suppress any existing request lane');
    assert.equal(f.waits.length, 0, 'other lanes must not inherit the detail Retry-After');
  } finally {
    f.time(now + 10_000);
    for (const wait of f.waits) wait.resolve();
    await Promise.all(pending);
  }
});

test('detail retries honor their HTTP cooldown and discard a lease retired during the wait', async () => {
  const f = backoffFixture();
  f.responses.push(new Response('{"code":"RATE_LIMITED"}', { status: 429, headers: { 'Retry-After': '10' } }));
  await f.context.captureAndSendDetailPreview();
  f.time(now + 5000);
  const pending = f.context.captureAndSendDetailPreview();
  await new Promise(setImmediate);
  assert.equal(f.waits.length, 1);
  assert.equal(f.waits[0].ms, 5000, 'five seconds of the detail Retry-After remain after the pixel cadence permits capture');
  assert.equal(f.requests.length, 1, 'the second detail frame must not send before its cooldown');
  assert.equal(f.context.screenshotPixelsCaptureOwner, null);
  f.retire(); f.time(now + 10_000); f.waits[0].resolve();
  await pending;
  assert.equal(f.requests.length, 1, 'the retired lease must not send after its cooldown finishes');
  assert.equal(f.context.screenshotDetailCaptureInFlight, false);
});
