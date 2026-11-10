import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import sharp from 'sharp';
import { waitForExtensionWorkerDeclarations } from './extension-worker-test-readiness.mjs';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extensionPath = resolve(process.env.CLASSPILOT_EXTENSION_PATH || join(repo, 'extension'));
const executablePath = [process.env.CLASSPILOT_CHROME_PATH, chromium.executablePath(),
  'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(value => value && existsSync(value));
assert.ok(executablePath, 'A local Chromium executable is required');
const profile = mkdtempSync(join(tmpdir(), 'classpilot-detail-preview-'));
const uploads = [];
const heldDetailResponses = [];
const server = createServer((request, response) => {
  if (request.url === '/worksheet') {
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end('<!doctype html><title>Detail preview worksheet</title><style>body{background:white;color:#111;font:16px sans-serif;padding:24px}p{margin:10px}</style><h1>Selected student reading worksheet</h1>'
      + Array.from({ length: 40 }, (_, i) => `<p>Question ${i + 1}: Identify the evidence that supports your answer. Precise text remains readable.</p>`).join(''));
    return;
  }
  let body = '';
  request.on('data', chunk => { body += chunk; });
  request.on('end', () => {
    if (request.url === '/api/classpilot/device/screenshot') {
      const payload = JSON.parse(body);
      uploads.push(payload);
      if (payload.captureKind === 'detail_preview') {
        heldDetailResponses.push(response);
        return;
      }
    }
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{"ok":true}');
  });
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
try {
  browser = await chromium.launchPersistentContext(profile, { executablePath, headless: true,
    viewport: { width: 2200, height: 1200 }, args: ['--headless=new', '--no-proxy-server',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
      `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker', { timeout: 10_000 });
  await waitForExtensionWorkerDeclarations(worker);
  await worker.evaluate(async origin => {
    await authStateRestorePromise; await classroomStateRestorePromise; await studentAuthMutationTail;
    const controller = new AbortController();
    const auth = { authContextId: 'synthetic-auth', mutationGeneration: 2, serverOrigin: origin,
      schoolId: 'synthetic-school', deviceId: 'synthetic-device', studentId: 'synthetic-student',
      studentSessionId: 'synthetic-session', studentToken: 'synthetic-token', signal: controller.signal };
    globalThis.__detailFixture = { controller, auth };
    captureAuthenticatedContext = () => auth;
    assertAuthenticatedContextCurrent = value => { if (value !== auth || auth.signal.aborted) throw authContextSuperseded('synthetic detail auth'); return value; };
    hasStudentAuth = () => true; hasManagedSchoolSetup = () => true;
    restrictionPortalPresentationPending = () => false;
    currentLicenseIsActive = () => true;
    determineTrackingState = () => TRACKING_STATES.ACTIVE;
    hasNegotiatedCapability = name => ['scopedAuthorityChecksV1', 'screenshotTrackingWindowLeaseV1',
      'screenshotActiveObservationCadenceV1'].includes(name);
    currentStudentControlRevision = () => 3;
    CONFIG.serverUrl = origin; CONFIG.studentToken = auth.studentToken; CONFIG.schoolId = auth.schoolId;
    CONFIG.studentName = 'Synthetic Student';
    trackingState = TRACKING_STATES.ACTIVE;
    currentClassroomState = { teachingSessionId: 'synthetic-class', studentControlRevision: 3, scheduledEndAt: Date.now() + 60_000 };
    // Keep automatic routine scheduling quiet so the fixture can explicitly
    // measure each production native capture without racing its own clocks.
    requestImmediateScreenshotCapture = () => {};
    scheduleScreenshotCapture = () => {};
    reconcileActiveScreenshotCadence = () => {};
  }, origin);
  const page = await browser.newPage(); await page.goto(origin + '/worksheet'); await page.bringToFront();
  await page.waitForTimeout(650);
  const started = Date.now();
  await worker.evaluate(() => {
    const now = Date.now();
    adoptScreenshotPolicy({ mode: 'tracking_window_lease', captureAllowed: true, expiresInSeconds: 60,
      serverTime: new Date(now).toISOString(), authority: { kind: 'teaching_session', teachingSessionId: 'synthetic-class', controlRevision: 3 },
      captureCadence: { mode: 'active_view', intervalSeconds: 5, expiresInSeconds: 40 },
      detailPreview: { mode: 'selected_student', leaseId: 'abcdefghijklmnopqrstuvwx12345678',
        expiresInSeconds: 20, intervalSeconds: 5, maxWidth: 1920, jpegQuality: 90 },
    }, globalThis.__detailFixture.auth, { requestStartedAt: now, responseReceivedAt: now });
  });
  for (let i = 0; !uploads.length && i < 100; i++) await page.waitForTimeout(50);
  assert.equal(uploads.length, 1, 'a valid selected-student policy must acquire and upload a native detail frame');
  const firstLatencyMs = Date.now() - started;
  const detail = uploads[0];
  assert.equal(detail.captureKind, 'detail_preview');
  assert.equal(detail.detailPreviewLeaseId, 'abcdefghijklmnopqrstuvwx12345678');
  assert.equal(detail.screenshotAuthority.teachingSessionId, 'synthetic-class');
  assert.equal(detail.screenshotReferenceId, undefined); assert.equal(detail.screenshotDelta, undefined);
  assert.ok(detail.screenshot.length <= 800_000);
  const metadata = await sharp(Buffer.from(detail.screenshot.split(',')[1], 'base64')).metadata();
  assert.equal(metadata.width, 1920); assert.ok(metadata.height > 640); assert.equal(metadata.format, 'jpeg');
  await page.waitForTimeout(650);
  const pending = await worker.evaluate(async () => {
    const detailUploadStillPending = screenshotDetailCaptureInFlight;
    await captureAndSendScreenshot({ reason: 'scheduled' });
    return { detailUploadStillPending, detailUploadPendingAfterRoutine: screenshotDetailCaptureInFlight };
  });
  assert.equal(pending.detailUploadStillPending, true, 'the detail HTTP response is intentionally held');
  assert.equal(pending.detailUploadPendingAfterRoutine, true, 'routine progress must not depend on finishing detail HTTP');
  const routine = uploads.find(upload => upload.captureKind !== 'detail_preview');
  assert.ok(routine?.screenshot, 'routine native capture/upload must progress while detail HTTP is pending');
  const thumbnail = routine.screenshot;
  assert.equal((await sharp(Buffer.from(thumbnail.split(',')[1], 'base64')).metadata()).width, 640);
  for (const response of heldDetailResponses.splice(0)) {
    response.writeHead(200, { 'content-type': 'application/json' }); response.end('{"ok":true}');
  }
  await worker.evaluate(async () => { await captureAndSendDetailPreview(); });
  assert.equal(uploads.filter(upload => upload.captureKind === 'detail_preview').length, 1, 'native detail obeys its five-second minimum');
  await worker.evaluate(async () => {
    screenshotPolicyState = Object.freeze({ ...screenshotPolicyState, detailPreview: null });
    retireDetailPreviewCapture();
    await captureAndSendDetailPreview();
  });
  assert.equal(uploads.filter(upload => upload.captureKind === 'detail_preview').length, 1, 'release stops detail capture and leaves routine thumbnails available');
  const evidence = { browser: browser.browser().version(),
    firstLatencyMs, detailWidth: metadata.width, detailHeight: metadata.height,
    jpegBytes: Buffer.from(detail.screenshot.split(',')[1], 'base64').length, thumbnailWidth: 640,
    routineProgressedDuringDetailHttp: true,
    extensionVersion: await worker.evaluate(() => chrome.runtime.getManifest().version) };
  const evidenceDir = join(repo, 'artifacts', 'detail-preview');
  mkdirSync(evidenceDir, { recursive: true });
  const prefix = process.env.CLASSPILOT_EXTENSION_PATH ? 'packaged' : 'source';
  writeFileSync(join(evidenceDir, prefix + '-detail.jpg'), Buffer.from(detail.screenshot.split(',')[1], 'base64'));
  writeFileSync(join(evidenceDir, prefix + '-thumbnail.jpg'), Buffer.from(thumbnail.split(',')[1], 'base64'));
  writeFileSync(join(evidenceDir, prefix + '-native-evidence.json'), JSON.stringify(evidence, null, 2) + '\n');
  console.log('PASS real Chrome selected detail: ' + JSON.stringify(evidence));
} finally {
  for (const response of heldDetailResponses.splice(0)) response.end('{"ok":true}');
  await browser?.close(); await new Promise(done => server.close(done));
  assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + sep) && profile.includes('classpilot-detail-preview-'));
  rmSync(profile, { recursive: true, force: true });
}
