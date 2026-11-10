import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';
import { waitForExtensionWorkerDeclarations } from './extension-worker-test-readiness.mjs';

// This is a functional offscreen/worker transport check with one localhost
// client, not a capacity campaign. The browser cannot resolve external hosts.
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extensionPath = resolve(process.env.CLASSPILOT_EXTENSION_PATH || join(repo, 'extension'));
const executablePath = [process.env.CLASSPILOT_CHROME_PATH, chromium.executablePath(),
  'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(value => value && existsSync(value));
assert.ok(executablePath, 'A local Chromium executable is required');
const profile = mkdtempSync(join(tmpdir(), 'classpilot-device-telemetry-'));
const frames = [], requests = [];
const codecContext = vm.createContext({ Uint8Array, DataView });
vm.runInContext(readFileSync(join(extensionPath, 'screenshot-delta-codec.js'), 'utf8'), codecContext);
const imagesById = new Map(), receipts = new Map();
let imageSerial = 0;
let replyEnabled = true, imageMissing = false, browser;
function canonicalResult(frame) {
  if (receipts.has(frame.operationId)) return receipts.get(frame.operationId);
  let body = { ok: true, transport: 'websocket' }, status = 200;
  if (frame.kind === 'screenshot') {
    const payload = frame.payload;
    if ((payload.screenshotReferenceId || payload.screenshotDelta) && imageMissing) {
      imageMissing = false;
      return { status: 409, body: { code: 'SCREENSHOT_IMAGE_REQUIRED' } };
    }
    let bytes;
    if (payload.screenshotDelta) {
      const delta = payload.screenshotDelta, base = imagesById.get(delta.baseImageId);
      assert.ok(base, 'delta must name an acknowledged base');
      bytes = codecContext.ClassPilotScreenshotDeltaCodec.applyScreenshotDelta(base, Buffer.from(delta.data, 'base64'));
      assert.equal(bytes.length, delta.targetBytes);
      assert.equal(delta.uploadIntegrity, createHash('sha256')
        .update('classpilot:screenshot-delta-upload:v1\0' + delta.baseImageId + '\0').update(bytes).digest('hex'));
    } else if (payload.screenshot) {
      bytes = Buffer.from(payload.screenshot.split(',')[1], 'base64');
    } else {
      bytes = imagesById.get(payload.screenshotReferenceId);
      assert.ok(bytes, 'reference must name an acknowledged base');
    }
    const imageId = payload.screenshotReferenceId || 'opaque_image_' + String(++imageSerial).padStart(28, '0');
    imagesById.set(imageId, bytes);
    body = { ...body, retained: true, imageId };
  }
  const result = { status, body };
  receipts.set(frame.operationId, result);
  return result;
}
const http = createServer((request, response) => {
  if (request.url === '/capture') {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end('<!doctype html><title>Telemetry capture fixture</title><style>body{font:18px sans-serif;padding:24px;background:#fff;color:#17223a}p{margin:9px}#answer{display:inline-block;width:200px;border:1px solid #888}</style><h1>Classroom worksheet</h1><p>Answer: <span id="answer">A</span></p>'
      + Array.from({ length: 24 }, (_, index) => '<p>Question ' + (index + 1) + ': Explain how evidence supports your answer.</p>').join(''));
    return;
  }
  let body = '';
  request.on('data', chunk => { body += chunk; });
  request.on('end', () => {
    requests.push({ path: request.url, method: request.method, body: body ? JSON.parse(body) : null });
    const payload = body ? JSON.parse(body) : null;
    const result = request.method === 'POST' && /^\/api\/(?:classpilot\/)?device\/screenshot$/.test(request.url || '')
      ? canonicalResult({ operationId: payload.telemetryOperationId, kind: 'screenshot', payload })
      : { status: 200, body: { ok: true } };
    response.writeHead(result.status, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ...result.body, transport: 'http' }));
  });
});
const sockets = new WebSocketServer({ server: http, path: '/ws' });
sockets.on('connection', socket => socket.on('message', raw => {
  const frame = JSON.parse(raw.toString());
  if (frame.type !== 'device-telemetry') return;
  frames.push(frame);
  const result = canonicalResult(frame);
  if (replyEnabled) socket.send(JSON.stringify({
    type: 'device-telemetry-result', operationId: frame.operationId, kind: frame.kind,
    ...result,
    exactBinding: { studentId: 'synthetic-student', studentSessionId: 'synthetic-session' },
  }));
}));
await new Promise(resolveListen => http.listen(0, '127.0.0.1', resolveListen));
const origin = `http://127.0.0.1:${http.address().port}`;

try {
  browser = await chromium.launchPersistentContext(profile, {
    executablePath, headless: true,
    args: ['--headless=new', '--no-proxy-server',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
      `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
  });
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker', { timeout: 10_000 });
  await waitForExtensionWorkerDeclarations(worker);
  const diagnostics = [];
  worker.on('console', message => {
    if (message.text().includes('Offscreen') || message.text().includes('WebSocket')) diagnostics.push(message.text());
  });
  await worker.evaluate(async origin => {
    await authStateRestorePromise;
    await classroomStateRestorePromise;
    await studentAuthMutationTail;
    const controller = new AbortController();
    globalThis.__telemetryFixture = { controller, auth: {
      authContextId: 'synthetic-auth', serverOrigin: origin, studentId: 'synthetic-student',
      studentSessionId: 'synthetic-session', studentToken: 'synthetic-token', signal: controller.signal,
    } };
    // Replace authority resolution only in this isolated functional browser.
    // The production telemetry adapter, offscreen owner, frame send/receive,
    // correlation, byte limits and HTTP recovery are all exercised unchanged.
    captureAuthenticatedContext = () => globalThis.__telemetryFixture.auth;
    assertAuthenticatedContextCurrent = context => {
      if (context !== globalThis.__telemetryFixture.auth || context.signal.aborted) {
        throw authContextSuperseded('synthetic telemetry');
      }
      return context;
    };
    hasNegotiatedCapability = name => ['scopedAuthorityChecksV1', 'deviceTelemetryTransportV1'].includes(name);
    // This harness owns synthetic authority, including the page's signed-in
    // presentation. Otherwise setup/login UI could replace the worksheet and
    // falsely make every supposedly changing capture look identical.
    hasStudentAuth = () => true;
    hasManagedSchoolSetup = () => true;
    restrictionPortalPresentationPending = () => false;
    CONFIG.schoolId = 'synthetic-school';
    CONFIG.studentToken = 'synthetic-token';
    CONFIG.studentName = 'Synthetic Student';
    CONFIG.serverUrl = origin;
    wsConnectionGeneration = 101;
    wsTransportIdentity = { connectionGeneration: 101, authContextId: 'synthetic-auth', serverOrigin: origin };
    await sendToOffscreen({ type: 'WS_CONNECT', url: origin.replace('http:', 'ws:') + '/ws',
      connectionGeneration: 101, authContextId: 'synthetic-auth', serverOrigin: origin });
  }, origin);
  for (let attempt = 0; attempt < 100; attempt++) {
    const status = await worker.evaluate(async () => queryOffscreenWebSocketStatus());
    if (status?.transportOpen === true) break;
    if (attempt === 99) throw new Error('Local offscreen WebSocket did not open: ' + JSON.stringify({ status, diagnostics }));
    await new Promise(resolveDelay => setTimeout(resolveDelay, 50));
  }
  await worker.evaluate(() => { wsConnected = true; wsAuthenticatedGeneration = 101; });
  const runHeartbeat = () => worker.evaluate(async origin => {
    const response = await fetchWithBackoff(origin + '/api/device/heartbeat', {
      method: 'POST', body: JSON.stringify({ activeTabTitle: 'Synthetic lesson' }),
      signal: globalThis.__telemetryFixture.controller.signal,
    }, { maxAttempts: 1, respectGlobalBackoff: false,
      deviceTelemetry: { kind: 'heartbeat', authContext: globalThis.__telemetryFixture.auth } });
    return { status: response.status, body: await response.json() };
  }, origin);
  const healthy = await runHeartbeat();
  assert.equal(healthy.body.transport, 'websocket', JSON.stringify({ frames: frames.length, diagnostics,
    state: await worker.evaluate(() => ({ wsConnected, wsConnectionGeneration, wsAuthenticatedGeneration, wsTransportIdentity })) }));
  assert.equal(requests.filter(request => request.path === '/api/device/heartbeat').length, 0);
  assert.equal(frames.length, 1);

  replyEnabled = false;
  const recovered = await runHeartbeat();
  assert.equal(recovered.body.transport, 'http');
  const recovery = requests.find(request => request.path === '/api/device/heartbeat');
  assert.equal(recovery.body.telemetryOperationId, frames.at(-1).operationId);
  assert.equal(recovery.body.activeTabTitle, 'Synthetic lesson');
  console.log('PASS real Chrome: offscreen WebSocket canonical result and same-ID HTTP recovery');

  replyEnabled = true;
  const page = await browser.newPage(); await page.goto(origin + '/capture'); await page.bringToFront();
  await page.evaluate(() => new Promise(resolvePaint => requestAnimationFrame(() => requestAnimationFrame(resolvePaint))));
  await page.waitForTimeout(550); // Settle the browser compositor before captureVisibleTab reads the new tab.
  await worker.evaluate(() => {
    hasNegotiatedCapability = name => ['scopedAuthorityChecksV1', 'deviceTelemetryTransportV1',
      'scopedScreenshotReferencesV1', 'screenshotTrackingWindowLeaseV1'].includes(name);
  });
  const capture = () => worker.evaluate(async origin => {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (tab?.url !== origin + '/capture' || tab?.title !== 'Telemetry capture fixture') {
      throw new Error('Capture fixture lost its active worksheet: ' + JSON.stringify({ url: tab?.url, title: tab?.title }));
    }
    const raw = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'jpeg', quality: 50 });
    const capturedAt = new Date().toISOString();
    const source = await encodeScreenshotVariant(raw, 'thumbnail');
    const auth = globalThis.__telemetryFixture.auth;
    const ticket = prepareScreenshotImageCapture(source, auth, 7, 'synthetic-class:1/revision:3');
    const result = await uploadRoutineScreenshot(origin + '/api/classpilot/device/screenshot',
      { method: 'POST', signal: auth.signal },
      { maxAttempts: 1, respectGlobalBackoff: false, deviceTelemetry: { kind: 'screenshot', authContext: auth } },
      { capturedAt, timestamp: Date.parse(capturedAt), tabTitle: 'Static worksheet',
        screenshotAuthority: { kind: 'teaching_session', teachingSessionId: 'synthetic-class', controlRevision: 3 } }, source, ticket);
    return { status: result.response.status, capturedAt, bytes: source.length, source };
  }, origin);
  const first = await capture();
  await page.waitForTimeout(550); // Chrome permits at most two captureVisibleTab calls per second.
  const second = await capture();
  assert.equal(first.status, 200); assert.equal(second.status, 200);
  const images = frames.filter(frame => frame.kind === 'screenshot');
  assert.equal(typeof images[0].payload.screenshot, 'string');
  assert.equal(Boolean(images[1].payload.screenshotReferenceId), true,
    JSON.stringify({ imageBytes: images.map(frame => frame.payload.screenshot?.length), firstCaptureBytes: first.bytes, secondCaptureBytes: second.bytes }));
  assert.equal(images[1].payload.screenshotReferenceId, receipts.get(images[0].operationId).body.imageId);
  assert.notEqual(first.capturedAt, second.capturedAt);
  imageMissing = true;
  await page.waitForTimeout(550);
  assert.equal((await capture()).status, 200);
  const recoveredImages = frames.filter(frame => frame.kind === 'screenshot');
  assert.equal(recoveredImages.length, 4);
  assert.equal(recoveredImages[2].payload.screenshotReferenceId, images[1].payload.screenshotReferenceId);
  assert.equal(recoveredImages[3].payload.screenshot, recoveredImages[0].payload.screenshot);
  assert.equal(recoveredImages[2].payload.capturedAt, recoveredImages[3].payload.capturedAt);
  assert.equal(recoveredImages[2].payload.timestamp, recoveredImages[3].payload.timestamp);
  assert.equal(requests.filter(request => request.method === 'POST'
    && /^\/api\/(?:classpilot\/)?device\/screenshot$/.test(request.path || '')).length, 0);
  console.log('PASS real Chrome: real captures, scoped unchanged-image references and same-capture full-image recovery');

  await worker.evaluate(() => {
    const parents = ['scopedAuthorityChecksV1', 'deviceTelemetryTransportV1', 'scopedScreenshotReferencesV1',
      'screenshotTrackingWindowLeaseV1', 'scopedScreenshotDeltasV1'];
    hasNegotiatedCapability = name => parents.includes(name);
    const canonical = globalThis.ClassPilotScreenshotDeltaCodec;
    globalThis.__telemetryFixture.codecDecisions = [];
    globalThis.ClassPilotScreenshotDeltaCodec = Object.freeze({ ...canonical,
      encodeScreenshotDelta(base, target, options) {
        const started = performance.now();
        const result = canonical.encodeScreenshotDelta(base, target, options);
        globalThis.__telemetryFixture.codecDecisions.push({ kind: result.kind, reason: result.reason,
          baseBytes: base.length, targetBytes: target.length, patchBytes: result.bytes?.length,
          elapsedMs: performance.now() - started });
        return result;
      },
    });
  });
  const changeAnswer = async value => {
    assert.equal(page.url(), origin + '/capture');
    await page.locator('#answer').evaluate((element, text) => { element.textContent = text; }, value);
    await page.waitForTimeout(650);
  };
  let changed, changedFrame;
  for (const answer of ['AB', 'ABC', 'ABCD']) {
    await changeAnswer(answer); changed = await capture(); changedFrame = frames.at(-1);
    assert.notEqual(changed.source, first.source, 'typing must change the actual JPEG');
    if (changedFrame.payload.screenshotDelta) break; // Cold CPU budget may choose full.
  }
  assert.ok(changedFrame.payload.screenshotDelta, 'bounded codec should encode a warmed small worksheet edit: '
    + JSON.stringify(await worker.evaluate(() => globalThis.__telemetryFixture.codecDecisions)));
  const materialized = imagesById.get(receipts.get(changedFrame.operationId).body.imageId);
  assert.equal(Buffer.from(materialized).toString('base64'), changed.source.split(',')[1]);
  assert.equal(changedFrame.payload.screenshot, undefined);
  assert.ok(changedFrame.payload.screenshotDelta.data.length < changed.source.length * 0.75);

  imageMissing = true;
  await changeAnswer('ABCDE'); const missOffset = frames.length; const deltaRecovery = await capture();
  const missFrames = frames.slice(missOffset);
  assert.equal(missFrames.length, 2); assert.ok(missFrames[0].payload.screenshotDelta);
  assert.equal(missFrames[1].payload.screenshot, deltaRecovery.source);
  assert.equal(missFrames[0].payload.capturedAt, missFrames[1].payload.capturedAt);
  assert.equal(missFrames[0].payload.timestamp, missFrames[1].payload.timestamp);

  replyEnabled = false;
  await changeAnswer('ABCDEF'); const lostOffset = frames.length; const lost = await capture();
  assert.equal(lost.status, 200);
  const lostFrame = frames[lostOffset], httpRecovery = requests.at(-1);
  assert.ok(lostFrame.payload.screenshotDelta);
  assert.equal(httpRecovery.body.telemetryOperationId, lostFrame.operationId);
  assert.deepEqual(httpRecovery.body.screenshotDelta, lostFrame.payload.screenshotDelta);
  assert.equal(httpRecovery.body.screenshot, undefined);
  console.log('PASS real Chrome: genuine changed JPEGs, exact lossless deltas, same-capture base-miss recovery and same-ID HTTP recovery');
  console.log('Native bounded codec decisions: ' + JSON.stringify(
    await worker.evaluate(() => globalThis.__telemetryFixture.codecDecisions)));
} finally {
  await browser?.close();
  for (const socket of sockets.clients) socket.terminate();
  await new Promise(resolveClose => sockets.close(resolveClose));
  await new Promise(resolveClose => http.close(resolveClose));
  const resolvedProfile = resolve(profile);
  const tempRoot = resolve(tmpdir()) + sep;
  assert.ok(resolvedProfile.startsWith(tempRoot) && resolvedProfile.includes('classpilot-device-telemetry-'));
  rmSync(resolvedProfile, { recursive: true, force: true });
}
