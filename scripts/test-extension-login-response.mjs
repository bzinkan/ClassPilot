// Native fetch/body readers must release the manual-login auth queue after an
// interrupted response. The credentialed POST is never automatically replayed.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { waitForExtensionWorkerDeclarations } from './extension-worker-test-readiness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extension = resolve(process.env.CLASSPILOT_EXTENSION_PATH || join(root, 'extension'));
const temporaryRoot = resolve(tmpdir());
const profile = mkdtempSync(join(temporaryRoot, 'classpilot-login-response-'));
const executablePath = [process.env.CLASSPILOT_CHROME_PATH, chromium.executablePath(),
  'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(value => value && existsSync(value));
assert.ok(executablePath, 'Actual Chrome/Chromium is required');

const sockets = new Set();
const requests = [];
let mode = 'stalled-body';
const server = createServer((request, response) => {
  request.resume();
  if (request.url !== '/api/extension/student-login') {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end('{}');
    return;
  }
  const entry = { mode, closed: false };
  requests.push(entry);
  response.on('close', () => { entry.closed = true; });
  if (mode === 'stalled-headers') return;
  if (mode === 'rate-limit') {
    response.writeHead(429, { 'content-type': 'application/json', 'retry-after': '5' });
    response.end(JSON.stringify({ error: 'Fixture rate limit' }));
    return;
  }
  response.writeHead(200, { 'content-type': 'application/json' });
  if (mode === 'stalled-body') {
    response.flushHeaders();
    response.write('{"studentToken":"private-partial-response",');
    return;
  }
  response.end(JSON.stringify({ schoolId: 'response-school', studentToken: 'fresh-response-token',
    studentSessionId: 'fresh-response-session', sessionRecovery: { token: 'R'.repeat(43) },
    student: { id: 'fresh-response-student', firstName: 'Fresh' } }));
});
server.on('connection', socket => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
});
await new Promise(done => server.listen(0, '127.0.0.1', done));
const origin = `http://127.0.0.1:${server.address().port}`;
let context;
try {
  context = await chromium.launchPersistentContext(profile, { executablePath, headless: true,
    args: ['--headless=new', '--no-proxy-server',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
      `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15_000 });
  await waitForExtensionWorkerDeclarations(worker);
  await worker.evaluate(async ({ origin }) => {
    const wait = ms => new Promise(done => setTimeout(done, ms));
    await authStateRestorePromise;
    await classroomStateRestorePromise;
    await studentAuthMutationTail;
    while (!workerWakeSettled) await wait(5);
    CONFIG.autoRegistrationPaused = true;
    if (chromeProfileRegistrationInFlight) await chromeProfileRegistrationInFlight.catch(() => {});
    scheduleHeartbeat(null);
    await chrome.alarms.clearAll();
    Object.assign(CONFIG, { serverUrl: origin, schoolId: 'response-school', schoolSlug: null,
      deviceId: 'response-device', activeStudentId: null, activeStudentSessionId: null,
      studentToken: null, authContextId: null, identitySource: null, manualLoginLastSeenAt: null });
    studentAuthInvalidating = false;
    studentAuthCommitPending = false;
    // Keep post-login external refreshes out of this response/adoption test;
    // native fetch, session storage, recovery storage and auth queues stay real.
    initializeAdaptiveTracking = async () => {};
    checkLicenseStatus = async () => {};
  }, { origin });

  for (const stalledMode of ['stalled-body', 'stalled-headers']) {
    mode = stalledMode;
    const before = requests.length;
    const result = await worker.evaluate(async () => {
      let queueReleased = false;
      const started = Date.now();
      const login = manualStudentLogin({ mode: 'pin', studentId: 'timeout-student-private', pin: '9237' })
        .then(value => ({ success: value.success }), error => ({ code: error.code, message: error.message }));
      // The login reserves its auth mutation asynchronously after startup and
      // policy barriers; join only once that production reservation exists.
      while (!manualStudentLoginPendingGeneration) await new Promise(done => setTimeout(done, 5));
      const queued = enqueueStudentAuthMutation(() => { queueReleased = true; });
      let timer;
      const outcome = await Promise.race([login, new Promise(done => {
        timer = setTimeout(() => done({ deadlineExceeded: true }), 7_000);
      })]);
      clearTimeout(timer);
      if (!outcome.deadlineExceeded) await queued;
      const stored = await chrome.storage.session.get(['studentToken', 'activeStudentId']);
      const diagnostics = ClassPilotAuthRecoveryDiagnostics.snapshot();
      return { outcome, elapsedMs: Date.now() - started, queueReleased,
        authenticated: hasStudentAuth(), pending: manualStudentLoginPendingGeneration > 0,
        commitPending: studentAuthCommitPending, storedToken: Boolean(stored.studentToken),
        storedStudent: Boolean(stored.activeStudentId), diagnostics };
    });
    assert.equal(result.outcome.deadlineExceeded, undefined,
      `${stalledMode}: native login response must settle before the page's 10-second transport deadline`);
    assert.equal(result.outcome.code, 'AUTH_GATE_TIMEOUT');
    assert.equal(result.queueReleased, true, `${stalledMode}: timed-out login must release the auth queue`);
    assert.equal(result.pending, false);
    assert.equal(result.commitPending, false);
    assert.equal(result.authenticated, false);
    assert.equal(result.storedToken, false);
    assert.equal(result.storedStudent, false);
    assert.equal(requests.length - before, 1, `${stalledMode}: timeout must not replay credentials`);
    const until = Date.now() + 1_000;
    while (!requests[before].closed && Date.now() < until) await new Promise(done => setTimeout(done, 10));
    assert.equal(requests[before].closed, true, `${stalledMode}: timeout must abort the native request/reader`);
    assert.ok(result.diagnostics.some(entry => entry.stage === 'server_request' && entry.cause === 'timeout'));
    const diagnosticKeys = new Set(['timestamp', 'extensionVersion', 'stage', 'cause', 'elapsedMs', 'attemptCount', 'detail']);
    for (const entry of result.diagnostics) {
      assert.ok(Object.keys(entry).every(key => diagnosticKeys.has(key)), 'diagnostics must contain only operational metadata');
    }
    // PIN digits can coincidentally occur in a timestamp or elapsed counter.
    // Inspect the allowed text fields after rejecting arbitrary payload keys.
    const diagnostics = JSON.stringify(result.diagnostics.map(({ timestamp, elapsedMs, attemptCount, ...text }) => text));
    for (const privateValue of ['private-partial-response', 'timeout-student-private', '9237', origin]) {
      assert.equal(diagnostics.includes(privateValue), false, 'diagnostics must not retain request/response contents');
    }
    console.log(`PASS ${stalledMode}: bounded native response, cancelled request and released auth queue`);
  }

  mode = 'rate-limit';
  const beforeRateLimit = requests.length;
  const rateLimited = await worker.evaluate(async () => {
    const outcome = await manualStudentLogin({ mode: 'pin', studentId: 'fresh-response-student', pin: '1234' })
      .then(value => ({ success: value.success }), error => ({ status: error.status }));
    return { outcome, backoffRecorded: apiBackoffUntilMs > Date.now() };
  });
  assert.equal(rateLimited.outcome.status, 429);
  assert.equal(rateLimited.backoffRecorded, true);
  assert.equal(requests.length - beforeRateLimit, 1);

  mode = 'success';
  const beforeRetry = requests.length;
  const retried = await worker.evaluate(async () => {
    const value = await manualStudentLogin({ mode: 'pin', studentId: 'fresh-response-student', pin: '1234' });
    return { success: value.success, authenticated: hasStudentAuth(), activeStudentId: CONFIG.activeStudentId };
  });
  assert.deepEqual(retried, { success: true, authenticated: true, activeStudentId: 'fresh-response-student' });
  assert.equal(requests.length - beforeRetry, 1, 'a fresh explicit login issues one new credentialed POST');
  console.log('PASS explicit login succeeds after interrupted responses; 429 backoff remains recorded');
} finally {
  for (const socket of sockets) socket.destroy();
  await new Promise(done => server.close(done));
  if (context) await context.close();
  assert.ok(resolve(profile).startsWith(temporaryRoot + sep), 'Temporary profile must stay inside the intended temp directory');
  rmSync(profile, { recursive: true, force: true });
}
