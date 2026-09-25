import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const extensionPath = resolve(process.env.CLASSPILOT_EXTENSION_PATH || join(root, 'extension'));
const profilePath = mkdtempSync(join(tmpdir(), 'classpilot-read-only-observation-'));
const executablePath = [process.env.CLASSPILOT_CHROME_PATH, chromium.executablePath(),
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe', '/usr/bin/google-chrome', '/usr/bin/chromium']
  .find(path => path && existsSync(path));
if (!executablePath) throw new Error('Chrome/Chromium is required');
let browser;
try {
  browser = await chromium.launchPersistentContext(profilePath, { executablePath, headless: true,
    args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
  const results = await worker.evaluate(async () => {
    await Promise.all([authStateRestorePromise.catch(() => {}), classroomStateRestorePromise.catch(() => {})]);
    await studentAuthMutationTail.catch(() => {});
    scheduleHeartbeat(null);
    const check = (value, message) => { if (!value) throw new Error(message); };
    const passed = [];
    fetchWithBackoff = async () => new Response('{}', { status: 503 });
    advanceStudentAuthMutationGeneration();
    Object.assign(CONFIG, { serverUrl: 'https://example.invalid', schoolId: 'observation-school', deviceId: 'observation-device',
      activeStudentId: 'observation-student', activeStudentSessionId: 'observation-login', studentToken: 'fixture-token',
      studentEmail: 'student@example.invalid', identitySource: 'integration_test' });
    studentAuthInvalidating = false;
    studentAuthCommitPending = false;
    activateAuthenticatedContext(generateAuthContextId());
    const auth = captureAuthenticatedContext('read-only observation fixture');
    adoptLicenseState(true, 'active', auth);
    trackingState = TRACKING_STATES.ACTIVE;
    schoolSettings = { enableTrackingHours: false, afterHoursMode: 'off' };
    schoolSettingsScope = schoolPolicyScopeForAuthContext(auth);
    schoolSettingsFetchedAt = Date.now();
    currentClassroomState = null;
    currentFabState = { activeSessionIds: [], messagingEnabled: false };
    observeStudentControlRevision(7, auth, 'read-only fixture');
    const oldCaps = ['scopedAuthorityChecksV1', 'screenshotTrackingWindowLeaseV1', 'screenshotActiveObservationCadenceV1'];
    const caps = [...oldCaps, 'screenshotReadOnlyObservationV1'];
    const policy = () => ({ mode: 'tracking_window_lease', captureAllowed: true, expiresInSeconds: 90,
      serverTime: new Date().toISOString(), authority: { kind: 'student_session', controlRevision: 7 },
      captureCadence: { mode: 'active_view', intervalSeconds: 5, expiresInSeconds: 60 } });
    const options = () => ({ requestStartedAt: Date.now(), responseReceivedAt: Date.now(), policySource: 'heartbeat' });
    const captures = [];
    const offscreen = [];
    captureAndSendScreenshot = async data => { captures.push(data.reason); return { captured: true }; };
    sendToOffscreen = async (data, opts = {}) => { opts.assertCurrent?.(); offscreen.push(data); return { success: true }; };
    adoptNegotiatedProtocolState({ serverProtocolVersion: 3, acceptedCapabilities: oldCaps }, auth);
    adoptScreenshotPolicy(policy(), auth, options());
    check(screenshotPolicyState.captureCadence.mode === 'background', 'old clients must keep background cadence');
    passed.push('unnegotiated read-only cadence rejected');
    for (const dependency of oldCaps) {
      const result = adoptNegotiatedProtocolState({ serverProtocolVersion: 3,
        acceptedCapabilities: caps.filter(capability => capability !== dependency) }, auth);
      check(!result.acceptedCapabilities.includes('screenshotReadOnlyObservationV1'), `missing ${dependency} must reject new capability`);
    }
    passed.push('all capability dependencies enforced');
    adoptNegotiatedProtocolState({ serverProtocolVersion: 3, acceptedCapabilities: caps }, auth);
    captures.length = 0;
    adoptScreenshotPolicy(policy(), auth, options());
    check(activeObservationScreenshotCadenceAllowed(auth), 'authorized report must get rapid cadence');
    check(activeScreenshotCadence && offscreen.some(row => row.type === 'SCREENSHOT_CADENCE_START'), 'real offscreen cadence entrypoint must start');
    check(captures.includes('lease-start'), 'opening Observe triggers immediate capture');
    check(currentClassroomState === null && currentFabState.activeSessionIds.length === 0, 'Observe must not establish classroom/FAB authority');
    check(!screenshotTrackingAuthorityMatchesCurrentState() && !classroomStateContextIsCurrent({ teachingSessionId: 'report' }), 'command and Live View authority remain false');
    passed.push('rapid cadence starts without classroom ownership');
    const cadence = activeScreenshotCadence;
    captures.length = 0;
    await handleOffscreenMessage({ type: 'SCREENSHOT_CADENCE_TICK', cadenceId: cadence.cadenceId, generation: cadence.generation });
    check(captures.length === 1 && captures[0] === 'active-view-tick', 'offscreen tick must capture');
    adoptScreenshotPolicy(policy(), auth, options());
    check(activeScreenshotCadence.cadenceId === cadence.cadenceId, 'renewal must preserve interval identity');
    check(captures.length === 1, 'renewal must not duplicate immediate capture');
    passed.push('offscreen tick and renewal');
    captures.length = 0;
    currentClassroomState = { schemaVersion: 1, revision: 7, teachingSessionId: 'read-only-report',
      hardExpiresAt: Date.now() + 60_000, restrictions: RuntimeCore.emptyRestrictions() };
    // A real heartbeat can already carry reporting attribution when the first
    // observation lease arrives. Exercise offscreen scheduling's current-state
    // assertion, not only ticks on a cadence started with no classroom state.
    stopActiveScreenshotCadence('restart-with-report-attribution');
    offscreen.length = 0;
    adoptScreenshotPolicy(policy(), auth, options());
    check(offscreen.some(row => row.type === 'SCREENSHOT_CADENCE_START'), 'report-attributed first cadence must reach offscreen');
    const reportingCadence = activeScreenshotCadence;
    await handleOffscreenMessage({ type: 'SCREENSHOT_CADENCE_TICK', cadenceId: reportingCadence.cadenceId, generation: reportingCadence.generation });
    check(captures.length === 1 && activeObservationScreenshotCadenceAllowed(auth), 'report attribution is compatible with read-only cadence');
    check(!screenshotTrackingAuthorityMatchesCurrentState(), 'student-session screenshots never become classroom capture authority');
    captures.length = 0;
    currentClassroomState = { ...currentClassroomState, teachingSessionId: 'real-class', revision: 8 };
    observeStudentControlRevision(8, auth, 'revision moved');
    await handleOffscreenMessage({ type: 'SCREENSHOT_CADENCE_TICK', cadenceId: reportingCadence.cadenceId, generation: reportingCadence.generation });
    check(captures.length === 0, 'old control revision cannot capture');
    passed.push('report attribution supported and stale revision fenced');
    const nextPolicy = policy(); nextPolicy.authority.controlRevision = 8;
    adoptScreenshotPolicy(nextPolicy, auth, options());
    captures.length = 0;
    const expiredCadence = activeScreenshotCadence;
    activeScreenshotCadence = Object.freeze({ ...expiredCadence, expiresAt: Date.now() - 1 });
    screenshotPolicyState = Object.freeze({ ...screenshotPolicyState,
      captureCadence: Object.freeze({ ...screenshotPolicyState.captureCadence, expiresAt: Date.now() - 1 }) });
    await handleOffscreenMessage({ type: 'SCREENSHOT_CADENCE_TICK', cadenceId: expiredCadence.cadenceId, generation: expiredCadence.generation });
    check(captures.length === 0 && activeScreenshotCadence === null, 'lease expiry must stop offscreen ticks');
    passed.push('cadence expiry');
    const hints = [];
    scheduleEventHeartbeat = reason => hints.push(reason);
    const hint = { type: 'screenshot-policy-refresh', reason: 'observation_changed', studentId: auth.studentId,
      studentSessionId: auth.studentSessionId, teachingSessionId: 'read-only-report' };
    await handleWsMessage(JSON.stringify({ ...hint, _msgId: 'report-current' }), wsConnectionGeneration, auth);
    check(hints.length === 1, 'exact-bound report hint requests a heartbeat');
    await handleWsMessage(JSON.stringify({ ...hint, _msgId: 'report-old-login', studentSessionId: 'old-login' }), wsConnectionGeneration, auth);
    check(hints.length === 1, 'old student login hint rejected');
    check(activeScreenshotCadence === null && currentClassroomState.teachingSessionId === 'real-class', 'refresh hint grants no capture or class authority');
    passed.push('exact-bound refresh hints resync without granting authority');
    adoptScreenshotPolicy(nextPolicy, auth, options());
    const reportCadence = activeScreenshotCadence;
    const promotedPolicy = { ...policy(), authority: { kind: 'teaching_session', teachingSessionId: 'real-class', controlRevision: 8 } };
    adoptScreenshotPolicy(promotedPolicy, auth, options());
    check(activeScreenshotCadence.cadenceId !== reportCadence.cadenceId, 'promotion retires read-only cadence identity');
    captures.length = 0;
    await handleOffscreenMessage({ type: 'SCREENSHOT_CADENCE_TICK', cadenceId: reportCadence.cadenceId, generation: reportCadence.generation });
    check(captures.length === 0, 'delayed read-only tick cannot capture after promotion');
    passed.push('teacher start replaces report cadence and rejects delayed ticks');
    stopActiveScreenshotCadence('test-complete');
    return passed;
  });
  assert.equal(results.length, 8);
  console.log(JSON.stringify({ status: 'passed', scenarios: results }, null, 2));
} finally {
  await browser?.close();
  if (!resolve(profilePath).startsWith(resolve(tmpdir()) + '\\classpilot-read-only-observation-')
    && !resolve(profilePath).startsWith(resolve(tmpdir()) + '/classpilot-read-only-observation-')) {
    throw new Error('Unexpected temporary browser profile path');
  }
  rmSync(profilePath, { recursive: true, force: true });
}
