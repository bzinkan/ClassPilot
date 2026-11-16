// Exercise the production manual-login and stale-session paths in an actual
// MV3 worker. School responses are synthetic; Chrome storage remains native.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { waitForExtensionWorkerDeclarations } from './extension-worker-test-readiness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extension = resolve(process.env.CLASSPILOT_EXTENSION_PATH || join(root, 'extension'));
const temporaryRoot = resolve(tmpdir());
const profile = mkdtempSync(join(temporaryRoot, 'classpilot-shared-login-'));
const executablePath = [process.env.CLASSPILOT_CHROME_PATH, chromium.executablePath(),
  'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(value => value && existsSync(value));
assert.ok(executablePath, 'Actual Chrome/Chromium is required');
let context;
try {
  context = await chromium.launchPersistentContext(profile, { executablePath, headless: true,
    args: ['--headless=new', '--no-proxy-server',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
      `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const browserVersion = context.browser().version();
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15_000 });
  await waitForExtensionWorkerDeclarations(worker);
  const result = await worker.evaluate(async () => {
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
    const bounded = async (promise, label) => {
      let timer;
      try { return await Promise.race([promise, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`[regression:shared-login] ${label} did not complete`)), 5_000);
      })]); } finally { clearTimeout(timer); }
    };
    await bounded(authStateRestorePromise, 'auth restore');
    await bounded(classroomStateRestorePromise, 'classroom restore');
    await bounded(studentAuthMutationTail, 'auth startup queue');
    await bounded((async () => { while (!workerWakeSettled) await wait(5); })(), 'worker startup');
    CONFIG.autoRegistrationPaused = true;
    if (chromeProfileRegistrationInFlight) await chromeProfileRegistrationInFlight.catch(() => {});
    scheduleHeartbeat(null); await chrome.alarms.clearAll();
    Object.assign(CONFIG, { serverUrl: 'http://127.0.0.1:1', schoolId: 'shared-school', schoolSlug: null,
      deviceId: 'shared-device', activeStudentId: 'prior-student', activeStudentSessionId: 'prior-session',
      studentToken: 'prior-token', identitySource: 'manual_pin', manualLoginLastSeenAt: 1 });
    studentAuthInvalidating = false; studentAuthCommitPending = false;
    advanceStudentAuthMutationGeneration(); activateAuthenticatedContext('prior-auth');
    const requestEntered = deferred(), responseRelease = deferred();
    const originalFetch = fetchWithBackoff;
    const originalTracking = initializeAdaptiveTracking;
    const originalLicense = checkLicenseStatus;
    let loginRequests = 0;
    fetchWithBackoff = async url => {
      if (String(url).endsWith('/api/extension/student-login')) {
        loginRequests += 1; requestEntered.resolve(); await responseRelease.promise;
        return new Response(JSON.stringify({ schoolId: 'shared-school', studentToken: 'replacement-token',
          studentSessionId: 'replacement-session', sessionRecovery: { token: 'R'.repeat(43) },
          student: { id: 'replacement-student', firstName: 'Replacement' } }),
        { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    };
    initializeAdaptiveTracking = async () => {};
    checkLicenseStatus = async () => {};
    try {
      const login = manualStudentLogin({ mode: 'pin', studentId: 'replacement-student', pin: '1234' })
        .then(value => ({ success: value.success }), error => ({ code: error.code }));
      await bounded(requestEntered.promise, 'manual login request');
      const loginGeneration = studentAuthMutationGeneration;
      const duringLogin = { authenticated: hasStudentAuth(), authRequired: getAuthGateState().authRequired };
      // get-auth-state calls this production check before reading gate state.
      // The old shared session's timestamp is still present while its new
      // credentialed replacement request awaits the server response.
      const pollExpired = expireManualAuthIfStaleFailClosed('get-auth-state');
      const heartbeatExpiry = expireManualAuthIfStale('heartbeat-during-login');
      const pollGeneration = studentAuthMutationGeneration;
      responseRelease.resolve();
      const [loginOutcome, heartbeatExpired] = await bounded(Promise.all([login, heartbeatExpiry]), 'manual login adoption');
      await bounded(studentAuthMutationTail, 'post-login auth queue');
      const afterLogin = { authenticated: hasStudentAuth(), activeStudentId: CONFIG.activeStudentId };
      const loginResult = { loginRequests, loginGeneration, pollGeneration, pollExpired, heartbeatExpired,
        loginOutcome, duringLogin, afterLogin };
      if (loginOutcome.success !== true) return loginResult;

      // An ordinary expired manual session must still clear. While its native
      // invalidation write is pending, duplicate page/heartbeat checks must not
      // reserve more clears or supersede a later credentialed replacement.
      CONFIG.manualLoginLastSeenAt = 1;
      const invalidationEntered = deferred(), invalidationRelease = deferred();
      const originalLocalSet = durableLocalKv.set;
      let invalidationHeld = false;
      durableLocalKv.set = async values => {
        if (!invalidationHeld && values?.[STUDENT_AUTH_INVALIDATING_KEY] === true) {
          invalidationHeld = true; invalidationEntered.resolve(); await invalidationRelease.promise;
        }
        return originalLocalSet(values);
      };
      let ordinaryExpiry;
      try {
        const firstExpiry = expireManualAuthIfStaleFailClosed('ordinary-expired-poll');
        await bounded(invalidationEntered.promise, 'stale-session invalidation');
        const expiryGeneration = studentAuthMutationGeneration;
        const duplicatePoll = expireManualAuthIfStaleFailClosed('duplicate-expired-poll');
        const duplicateHeartbeat = await expireManualAuthIfStale('duplicate-expired-heartbeat');
        ordinaryExpiry = { firstExpiry, duplicatePoll, duplicateHeartbeat,
          expiryGeneration, duplicateGeneration: studentAuthMutationGeneration };
      } finally {
        invalidationRelease.resolve(); durableLocalKv.set = originalLocalSet;
      }
      await bounded(studentAuthMutationTail, 'ordinary stale-session cleanup');
      ordinaryExpiry.authenticated = hasStudentAuth();
      ordinaryExpiry.activeStudentId = CONFIG.activeStudentId;
      return { ...loginResult, ordinaryExpiry };
    } finally {
      responseRelease.resolve(); fetchWithBackoff = originalFetch;
      initializeAdaptiveTracking = originalTracking; checkLicenseStatus = originalLicense;
      clearPendingEventHeartbeat(); scheduleHeartbeat(null); await chrome.alarms.clearAll();
    }
  });
  assert.deepEqual(result.loginOutcome, { success: true },
    'an old manual-session expiry poll must not reject a successful replacement login');
  assert.equal(result.pollExpired, false);
  assert.equal(result.heartbeatExpired, false);
  assert.equal(result.pollGeneration, result.loginGeneration);
  assert.equal(result.loginRequests, 1);
  assert.equal(result.duringLogin.authenticated, false);
  assert.equal(result.duringLogin.authRequired, true);
  assert.equal(result.afterLogin.authenticated, true);
  assert.equal(result.afterLogin.activeStudentId, 'replacement-student');
  assert.equal(result.ordinaryExpiry.firstExpiry, true);
  assert.equal(result.ordinaryExpiry.duplicatePoll, false);
  assert.equal(result.ordinaryExpiry.duplicateHeartbeat, false);
  assert.equal(result.ordinaryExpiry.duplicateGeneration, result.ordinaryExpiry.expiryGeneration);
  assert.equal(result.ordinaryExpiry.authenticated, false);
  assert.equal(result.ordinaryExpiry.activeStudentId, null);
  console.log(`PASS shared Chromebook login survives a stale prior-session status poll (Chromium ${browserVersion})`);
} finally {
  if (context) await context.close();
  assert.ok(resolve(profile).startsWith(temporaryRoot + sep), 'Temporary profile must stay inside the intended temp directory');
  rmSync(profile, { recursive: true, force: true });
}
