import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import { resolve } from 'node:path';

const extensionFile = name => process.env.CLASSPILOT_EXTENSION_PATH
  ? resolve(process.env.CLASSPILOT_EXTENSION_PATH, name) : new URL('../extension/' + name, import.meta.url);
const source = readFileSync(extensionFile('service-worker.js'), 'utf8').replace(/\r\n/g, '\n');
const clientSource = readFileSync(extensionFile('device-telemetry.js'), 'utf8');
const operationId = '11111111-1111-4111-8111-111111111111';
function declaration(name, input = source) {
  const start = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(input);
  assert.ok(start, `production ${name} must exist`);
  const rest = input.slice(start.index + start[0].length);
  const end = /^}/m.exec(rest);
  assert.ok(end);
  return input.slice(start.index, start.index + start[0].length + end.index + 1);
}
function fixture() {
  const controller = new AbortController();
  const auth = { authContextId: 'auth', serverOrigin: 'https://school.invalid', studentId: 'student', studentSessionId: 'session', studentToken: 'token', signal: controller.signal };
  const http = [], sent = [], timers = new Map(); let timerId = 0, enabled = true;
  const sandbox = vm.createContext({
    URL, TextEncoder, Response, Headers, AbortController, setTimeout, clearTimeout,
    crypto: { randomUUID: () => operationId },
    console: { warn() {}, log() {}, info() {} },
    wsConnected: true, wsConnectionGeneration: 1, wsAuthenticatedGeneration: 1,
    wsTransportIdentity: { connectionGeneration: 1, authContextId: 'auth', serverOrigin: auth.serverOrigin },
    deviceTelemetryClient: null,
    hasNegotiatedCapability: () => enabled,
    assertAuthenticatedContextCurrent(context) { if (controller.signal.aborted || context !== auth) { const error = new Error(); error.code = 'AUTH_CONTEXT_SUPERSEDED'; throw error; } return context; },
    authContextSuperseded() { const error = new Error(); error.code = 'AUTH_CONTEXT_SUPERSEDED'; return error; },
    captureAuthenticatedContext: () => auth,
    normalizedServerOrigin: value => new URL(value).origin,
    wsIdentityMatchesContext: (value, context) => value.connectionGeneration === sandbox.wsConnectionGeneration && value.authContextId === context.authContextId && value.serverOrigin === context.serverOrigin,
    wsSend: async serialized => { sent.push(JSON.parse(serialized)); return true; },
    fetch: async (url, init) => { http.push({ url, init, body: JSON.parse(init.body) }); return new Response('{"ok":true}', { status: 200 }); },
  });
  vm.runInContext(clientSource, sandbox);
  for (const name of ['getDeviceTelemetryClient', 'prepareDeviceTelemetryRequest', 'acceptDeviceTelemetryEvent']) vm.runInContext(declaration(name), sandbox);
  // Use deterministic deadlines for the actual production client, not a fake transport.
  const createClient = sandbox.ClassPilotDeviceTelemetry.createClient;
  sandbox.ClassPilotDeviceTelemetry = { createClient: options => createClient({ ...options,
    setTimeout(fn) { const id = ++timerId; timers.set(id, fn); return id; },
    clearTimeout(id) { timers.delete(id); },
  }) };
  return { sandbox, auth, controller, sent, http, timers,
    disable() { enabled = false; },
    prepare(kind = 'heartbeat', payload = { activeTabTitle: 'Lesson' }, local = {}) {
      return sandbox.prepareDeviceTelemetryRequest(`${auth.serverOrigin}/api/device/${kind}`, { method: 'POST', body: JSON.stringify(payload), signal: controller.signal }, { deviceTelemetry: { kind, authContext: auth, ...local } });
    },
    reply(status = 200, body = { ok: true }, overrides = {}) {
      return sandbox.acceptDeviceTelemetryEvent('message', JSON.stringify({ type: 'device-telemetry-result', operationId, kind: 'heartbeat', status, body, exactBinding: { studentId: 'student', studentSessionId: 'session' }, ...overrides }), 1, 'auth', auth.serverOrigin);
    },
  };
}
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };

test('native telemetry fixture waits for a delayed worker open before authenticating its screenshot transport', async () => {
  const f = fixture(); const context = f.sandbox;
  let releasePolicy;
  const policyGate = new Promise(resolve => { releasePolicy = resolve; });
  Object.assign(context, { wsConnected: false, wsTransportConnected: false,
    wsConnectionGeneration: 101, wsAuthenticatedGeneration: 0,
    wsTransportIdentity: { ...context.wsTransportIdentity, connectionGeneration: 101 },
    authStateRestorePromise: Promise.resolve(), awaitManagedAuthGatePolicyStable: () => policyGate,
    wsPendingIngressCount: 0, WS_MAX_PENDING_INGRESS: 32, wsIngressTails: new Map(),
    wsMessageProcessingTail: Promise.resolve(), wsMessageProcessingGeneration: 0,
    wsAuthenticatedResponseGuard: null, schoolSettingsRefreshState: null,
  });
  for (const name of ['handleWsEvent', 'processWsEvent']) vm.runInContext(declaration(name), context);
  const nativeHarness = readFileSync(new URL('./test-extension-device-telemetry-chrome.mjs', import.meta.url), 'utf8');
  vm.runInContext(declaration('authenticateTelemetryFixture', nativeHarness), context);
  const opening = context.handleWsEvent('open', null, 101, f.auth.authContextId, f.auth.serverOrigin);
  const authenticating = context.authenticateTelemetryFixture({ evaluate: callback => callback() });
  await flush();
  releasePolicy();
  await Promise.all([opening, authenticating]);
  const pending = f.prepare('screenshot', { screenshot: 'data:image/jpeg;base64,ZmFrZQ==' })();
  await flush();
  assert.equal(f.sent.length, 1, 'delayed open must not silently move the native screenshot proof to HTTP');
  assert.equal(f.sent[0].kind, 'screenshot'); assert.equal(f.http.length, 0);
  assert.equal(context.acceptDeviceTelemetryEvent('message', JSON.stringify({
    type: 'device-telemetry-result', operationId, kind: 'screenshot', status: 200,
    body: { ok: true }, exactBinding: { studentId: f.auth.studentId, studentSessionId: f.auth.studentSessionId },
  }), 101, f.auth.authContextId, f.auth.serverOrigin), true);
  assert.equal((await pending).status, 200);
});

test('unnegotiated operations retain the original HTTP path', () => {
  const f = fixture(); f.disable();
  assert.equal(f.prepare(), null); assert.equal(f.sent.length, 0);
});

test('healthy negotiated operation returns canonical JSON without any HTTP request', async () => {
  const f = fixture(); const run = f.prepare(); const pending = run(); await flush();
  assert.equal(f.sent.length, 1); assert.equal(f.http.length, 0);
  assert.equal(f.reply(200, { ok: true, classroomState: { revision: 3 } }), true);
  const response = await pending;
  assert.equal(response.ok, true); assert.equal((await response.json()).classroomState.revision, 3);
  assert.equal(f.http.length, 0);
});

test('lost receipt recovers over HTTP with the same original payload and operation ID', async () => {
  const f = fixture(); const pending = f.prepare()(); await flush();
  for (const callback of [...f.timers.values()]) callback();
  const response = await pending;
  assert.equal(response.status, 200); assert.equal(f.http.length, 1);
  assert.equal(f.sent[0].operationId, operationId);
  assert.equal(f.http[0].body.telemetryOperationId, operationId);
  assert.equal(f.http[0].body.activeTabTitle, 'Lesson');
  assert.equal(f.reply(), false);
});

test('a lost screenshot delta receipt recovers its exact descriptor and operation ID over HTTP', async () => {
  const f = fixture();
  const baseImageId = '22222222-2222-4222-8222-222222222222';
  const target = Buffer.alloc(1024, 74); target.set([255, 216, 255, 224]); target.set([255, 217], 1022);
  const patch = Buffer.from([67, 80, 68, 49, 0, 0, 4, 0, 0, 0, 4, 0, 1, 0, 0, 0, 0, 0, 0, 4, 0]);
  const payload = { screenshotImageProtocolVersion: 1, capturedAt: '2026-11-10T14:00:00.000Z',
    timestamp: Date.parse('2026-11-10T14:00:00.000Z'),
    screenshotAuthority: { kind: 'teaching_session', teachingSessionId: 'class', controlRevision: 3 },
    screenshotDelta: { codec: 'cp-bit-copy-v1', baseImageId, data: patch.toString('base64'), targetBytes: target.length,
      uploadIntegrity: createHash('sha256').update('classpilot:screenshot-delta-upload:v1\0' + baseImageId + '\0').update(target).digest('hex') } };
  const pending = f.prepare('screenshot', payload, {
    logicalScreenshot: 'data:image/jpeg;base64,' + target.toString('base64'),
  })();
  await flush();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].kind, 'screenshot'); assert.equal(f.http.length, 0);
  for (const callback of [...f.timers.values()]) callback();
  const response = await pending;
  assert.equal(response.status, 200); assert.equal(f.http.length, 1);
  assert.equal(f.sent[0].operationId, operationId);
  assert.deepEqual(f.sent[0].payload, { ...payload, telemetryOperationId: operationId });
  assert.deepEqual(f.http[0].body, f.sent[0].payload);
  assert.equal(f.http[0].body.screenshot, undefined);
  assert.equal(f.http[0].body.logicalScreenshot, undefined);
  assert.equal(f.reply(200, { ok: true }, { kind: 'screenshot' }), false, 'a late WS receipt cannot replace HTTP recovery');
});

test('disabled transport and oversize frames use HTTP, but canonical denial does not bypass to HTTP', async () => {
  for (const status of [401, 402, 403, 429, 503]) {
    const f = fixture(); const pending = f.prepare()(); await flush();
    f.reply(status, { error: 'denied' }, { headers: { 'retry-after': '17' } });
    const response = await pending;
    assert.equal(response.status, status); assert.equal(response.headers.get('retry-after'), '17');
    assert.equal(f.http.length, 0);
  }
  const unavailable = fixture(); const pending = unavailable.prepare()(); await flush();
  unavailable.reply(426, { code: 'DEVICE_TELEMETRY_UNAVAILABLE' }); await pending;
  assert.equal(unavailable.http.length, 1);
  const large = fixture(); await large.prepare('screenshot', { screenshot: 'x'.repeat(270_000) })();
  assert.equal(large.sent.length, 0); assert.equal(large.http.length, 1);
});

test('retired auth and wrong transport cannot deliver a successful result or start HTTP recovery', async () => {
  const f = fixture(); const pending = f.prepare()(); await flush();
  assert.equal(f.sandbox.acceptDeviceTelemetryEvent('message', JSON.stringify({ type: 'device-telemetry-result', operationId }), 2, 'auth', f.auth.serverOrigin), false);
  f.controller.abort();
  await assert.rejects(pending, error => error.name === 'AbortError');
  assert.equal(f.http.length, 0); assert.equal(f.reply(), false);
});

test('only hardcoded telemetry endpoints and routine captures can use the adapter', () => {
  const f = fixture();
  const options = { deviceTelemetry: { kind: 'heartbeat', authContext: f.auth } };
  assert.equal(f.sandbox.prepareDeviceTelemetryRequest('https://other.invalid/api/device/heartbeat', { body: '{}' }, options), null);
  assert.equal(f.sandbox.prepareDeviceTelemetryRequest(`${f.auth.serverOrigin}/api/admin/delete`, { body: '{}' }, options), null);
  assert.equal(f.prepare('screenshot', { captureKind: 'safety_evidence', screenshot: 'pixels' }), null);
});

test('delta logical source remains local and oversized logical captures recover over HTTP with the same ID', async () => {
  const payload = { screenshotImageProtocolVersion: 1, timestamp: 42,
    screenshotDelta: { codec: 'cp-bit-copy-v1', data: 'tiny' } };
  for (const local of [{}, { logicalScreenshot: 'x'.repeat(270_000) }]) {
    const f = fixture();
    const pending = f.prepare('screenshot', payload, local)();
    await flush(); for (const callback of [...f.timers.values()]) callback();
    assert.equal((await pending).status, 200);
    assert.equal(f.sent.length, 0); assert.equal(f.http.length, 1);
    assert.deepEqual(f.http[0].body.screenshotDelta, payload.screenshotDelta);
    assert.equal(f.http[0].body.telemetryOperationId, operationId);
    assert.equal(f.http[0].body.screenshot, undefined);
  }
  const f = fixture();
  const pending = f.prepare('screenshot', payload, { logicalScreenshot: 'data:image/jpeg;base64,local-pixels' })();
  await flush();
  assert.equal(f.sent.length, 1); assert.equal(f.sent[0].payload.screenshot, undefined);
  assert.equal(JSON.stringify(f.sent).includes('local-pixels'), false);
  f.reply(200, { ok: true }, { kind: 'screenshot' });
  assert.equal((await pending).status, 200); assert.equal(f.http.length, 0);
});

test('server result settlement does not wait for the serial classroom frame queue', async () => {
  const f = fixture(); const pending = f.prepare()(); await flush();
  f.sandbox.wsMessageProcessingTail = new Promise(() => {});
  vm.runInContext(declaration('handleWsEvent'), f.sandbox);
  const handled = await f.sandbox.handleWsEvent('message', JSON.stringify({ type: 'device-telemetry-result', operationId, kind: 'heartbeat', status: 200, body: { ok: true }, exactBinding: { studentId: 'student', studentSessionId: 'session' } }), 1, 'auth', f.auth.serverOrigin);
  assert.equal(handled.handled, true); assert.equal((await pending).status, 200);
});

test('a normal message containing the telemetry result label still reaches ordinary processing', async () => {
  const f = fixture(); const processed = [];
  Object.assign(f.sandbox, { schoolSettingsRefreshState: null, wsPendingIngressCount: 0, WS_MAX_PENDING_INGRESS: 32,
    wsIngressTails: new Map(), wsAuthenticatedResponseGuard: {}, authStateRestorePromise: Promise.resolve(),
    awaitManagedAuthGatePolicyStable: async () => {}, reconcileColdSocketAuthority: async () => true,
    processWsEvent: async (...args) => { processed.push(args); return { handled: true }; },
  });
  vm.runInContext(declaration('handleWsEvent'), f.sandbox);
  const frame = JSON.stringify({ type: 'chat-message', text: 'device-telemetry-result' });
  const outcome = await f.sandbox.handleWsEvent('message', frame, 1, 'auth', f.auth.serverOrigin);
  assert.equal(outcome.handled, true); assert.equal(processed.length, 1);
});

test('existing backoff retries canonical overload while keeping one cross-transport operation ID', async () => {
  const f = fixture(); const sleeps = [];
  Object.assign(f.sandbox, { API_RETRY_MAX_ATTEMPTS: 2, API_RETRY_STATUS_CODES: new Set([429, 503]),
    waitForApiBackoff: async () => {}, noteApiBackoff() {}, calculateRetryDelayMs: () => 17,
    sleepMs: async delay => { sleeps.push(delay); }, safeDiagnosticError: () => ({}),
  });
  vm.runInContext(declaration('fetchWithBackoff'), f.sandbox);
  const pending = f.sandbox.fetchWithBackoff(`${f.auth.serverOrigin}/api/device/heartbeat`, { method: 'POST', body: '{"activeTabTitle":"Lesson"}' },
    { maxAttempts: 2, deviceTelemetry: { kind: 'heartbeat', authContext: f.auth } });
  await flush(); f.reply(503, { code: 'DEVICE_TELEMETRY_BUSY' }); await flush(); await flush();
  assert.equal(f.sent.length, 2); assert.equal(f.sent[0].operationId, f.sent[1].operationId);
  f.reply(200, { ok: true });
  assert.equal((await pending).status, 200); assert.deepEqual(sleeps, [17]); assert.equal(f.http.length, 0);
});

test('Windows native browser pairing does not advertise the Chromebook WebSocket transport', () => {
  const bridge = readFileSync(extensionFile('windows-worker-bridge.js'), 'utf8');
  const stop = Symbol('native adapter boundary'); let advertised;
  assert.throws(() => vm.runInNewContext(bridge, {
    CLASSPILOT_WINDOWS_BUILD: { browserFamily: 'chrome' }, fetch() {},
    chrome: { runtime: {}, storage: { local: {} } },
    EXTENSION_CAPABILITIES: ['scopedAuthorityChecksV1', 'deviceTelemetryTransportV1', 'scopedScreenshotReferencesV1', 'scopedScreenshotDeltasV1', 'focusTabV1'],
    ClassPilotWindowsChannel: { create(options) { advertised = options.capabilities(); throw stop; } },
  }), error => error === stop);
  assert.deepEqual(Array.from(advertised), ['scopedAuthorityChecksV1', 'focusTabV1']);
});

test('screenshot deltas negotiate only with every parent capability in the actual build declaration', () => {
  const parents = ['scopedAuthorityChecksV1', 'deviceTelemetryTransportV1',
    'scopedScreenshotReferencesV1', 'screenshotTrackingWindowLeaseV1'];
  const f = fixture();
  for (const name of ['EXTENSION_CAPABILITIES', 'SCOPED_AUTHORITY_DEPENDENT_CAPABILITIES']) {
    const declaration = new RegExp(`^const ${name} = [\\s\\S]*?^\\]\\);`, 'm').exec(source);
    assert.ok(declaration, `actual ${name} declaration is required`);
    vm.runInContext(declaration[0], f.sandbox);
  }
  Object.assign(f.sandbox, { authContextProtocolScope: () => 'scope', negotiatedProtocolState: null });
  vm.runInContext(declaration('adoptNegotiatedProtocolState'), f.sandbox);
  for (const absent of parents) {
    const accepted = [...parents.filter(value => value !== absent), 'scopedScreenshotDeltasV1'];
    const state = f.sandbox.adoptNegotiatedProtocolState({ acceptedCapabilities: accepted }, f.auth);
    assert.equal(state.acceptedCapabilities.includes('scopedScreenshotDeltasV1'), false, absent);
  }
  const state = f.sandbox.adoptNegotiatedProtocolState({
    acceptedCapabilities: [...parents, 'scopedScreenshotDeltasV1'],
  }, f.auth);
  assert.equal(state.acceptedCapabilities.includes('scopedScreenshotDeltasV1'), true);
});

test('Windows heartbeat descriptors and request adapters cannot negotiate unsupported telemetry', () => {
  const f = fixture();
  Object.assign(f.sandbox, { CLASSPILOT_WINDOWS_BUILD: { browserFamily: 'chrome' }, CLIENT_PROTOCOL_VERSION: 3,
    ClassPilotWindows: { capabilities: () => ['scopedAuthorityChecksV1'] },
    EXTENSION_CAPABILITIES: ['scopedAuthorityChecksV1', 'deviceTelemetryTransportV1', 'scopedScreenshotReferencesV1'],
    chrome: { runtime: { getManifest: () => ({ version: '3.0.4' }) } },
  });
  vm.runInContext(declaration('extensionProtocolDescriptor'), f.sandbox);
  assert.deepEqual(Array.from(f.sandbox.extensionProtocolDescriptor().capabilities), ['scopedAuthorityChecksV1']);
  assert.equal(f.prepare(), null);
});
