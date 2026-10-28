// Run the shipped MV3 worker in Chrome. Policy values are synthetic, while
// tab enumeration/removal, auth fences, settings adoption and WS ingress run.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { waitForExtensionWorkerDeclarations } from './extension-worker-test-readiness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extension = resolve(process.env.CLASSPILOT_EXTENSION_PATH || join(root, 'extension'));
const profile = mkdtempSync(join(tmpdir(), 'classpilot-school-limit-'));
const executablePath = [process.env.CLASSPILOT_CHROME_PATH, chromium.executablePath(),
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find(value => value && existsSync(value));
assert.ok(executablePath, 'Chrome/Chromium is required');
let context;
try {
  context = await chromium.launchPersistentContext(profile, { executablePath, headless: true,
    args: ['--headless=new', '--no-proxy-server',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
      `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  await context.route(/^https:\/\//, route => route.fulfill({ status: 200, contentType: 'text/html',
    body: '<!doctype html><title>Synthetic limit fixture</title>' }));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15_000 });
  await waitForExtensionWorkerDeclarations(worker);
  const passed = await worker.evaluate(async () => {
    await authStateRestorePromise.catch(() => {});
    await classroomStateRestorePromise.catch(() => {});
    await studentAuthMutationTail.catch(() => {});
    const wait = async (predicate, label) => {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) { if (await predicate()) return; await new Promise(done => setTimeout(done, 10)); }
      throw new Error(`Timed out: ${label}`);
    };
    await wait(() => workerWakeSettled, 'worker wake');
    CONFIG.autoRegistrationPaused = true;
    if (chromeProfileRegistrationInFlight) await chromeProfileRegistrationInFlight.catch(() => {});
    const runHeartbeat = sendHeartbeat;
    sendHeartbeat = async () => {};
    connectWebSocket = async () => {};
    scheduleEventHeartbeat = () => {};
    recoverOffscreenWebSocketStatus = async () => true;
    enqueueMonitoringEvent = async () => {};
    recordHeartbeatSuccess = async () => {};
    flushSchoolWebsitePolicyAck = async () => {};
    const check = (condition, label) => { if (!condition) throw new Error(label); };
    const passed = [];
    const install = suffix => {
      advanceStudentAuthMutationGeneration();
      Object.assign(CONFIG, { serverUrl: 'https://school-pilot.net', schoolId: `limit-school-${suffix}`,
        deviceId: `limit-device-${suffix}`, activeStudentId: `limit-student-${suffix}`,
        activeStudentSessionId: `limit-login-${suffix}`, studentToken: `synthetic-token-${suffix}`,
        identitySource: 'integration_test', registered: true });
      studentAuthInvalidating = false; studentAuthCommitPending = false;
      activateAuthenticatedContext(`school-limit-${suffix}`);
      const auth = captureAuthenticatedContext('school limit fixture');
      adoptLicenseState(true, 'active', auth);
      schoolSettings = { enableTrackingHours: false, afterHoursMode: 'off' };
      schoolSettingsScope = schoolPolicyScopeForAuthContext(auth); schoolSettingsFetchedAt = 0;
      trackingState = TRACKING_STATES.ACTIVE;
      teacherMaxTabs = null; schoolMaxTabs = null; currentMaxTabs = null;
      adoptNegotiatedProtocolState({ serverProtocolVersion: 3,
        acceptedCapabilities: ['scopedAuthorityChecksV1', 'classroomStateV1'] }, auth);
      return auth;
    };
    let auth = install('a'), serverLimit = 8, settingsRequests = 0;
    const envelope = value => ({ schoolId: value.schoolId, studentId: value.studentId,
      studentSessionId: value.studentSessionId });
    const snapshot = (limit, value = auth) => ({ ...envelope(value), enableTrackingHours: false,
      afterHoursMode: 'off', maxTabsPerStudent: limit });
    let getSettings = async () => snapshot(serverLimit);
    fetchWithBackoff = async url => {
      if (String(url).includes('/api/extension/settings')) {
        settingsRequests += 1;
        const body = await getSettings();
        return new Response(JSON.stringify(body), { status: 200 });
      }
      if (String(url).includes('/api/device/heartbeat')) return new Response(JSON.stringify(envelope(auth)), { status: 200 });
      return new Response('{}', { status: 200 });
    };
    const removed = [], nativeRemove = chrome.tabs.remove.bind(chrome.tabs);
    chrome.tabs.remove = async ids => { removed.push(...(Array.isArray(ids) ? ids : [ids])); return nativeRemove(ids); };
    for (let index = 0; index < 8; index += 1) await chrome.tabs.create({ url: `https://limit.example.test/${index}`, active: false });
    await applyWebSocketTabLimitSetting({ ...envelope(auth), settings: { maxTabsPerStudent: 8 } }, auth);
    const firstCount = (await chrome.tabs.query({})).length;
    check(schoolMaxTabs === 8 && currentMaxTabs === 8 && firstCount === 8, 'canonical school limit was not applied');
    const beforeStale = removed.length;
    const oldFrame = { ...envelope(auth), settings: { maxTabsPerStudent: 3 } };
    await applyWebSocketTabLimitSetting(oldFrame, auth);
    const command = { type: 'limit-tabs', authority: { kind: 'school_policy', schoolId: auth.schoolId,
      source: 'school_settings' }, data: { maxTabs: 3 } };
    await handleRemoteControl(command, envelope(auth));
    check(schoolMaxTabs === 8 && currentMaxTabs === 8 && removed.length === beforeStale,
      'delayed school limit 3 overrode current 8 or closed current tabs');
    passed.push('delayed WS bootstrap and school command cannot reinstate an old limit');

    // Multiple invalidations coalesce into one replacement request. An old
    // stricter HTTP response must never enumerate or close current tabs.
    let releaseOld, requestStarted;
    const started = new Promise(done => { requestStarted = done; });
    const oldGate = new Promise(done => { releaseOld = done; });
    const requestsBefore = settingsRequests;
    getSettings = async () => {
      if (settingsRequests === requestsBefore + 1) { requestStarted(); await oldGate; return snapshot(3); }
      return snapshot(8);
    };
    const first = refreshSchoolSettings({ force: true, authContext: auth });
    await started;
    const second = applyWebSocketTabLimitSetting(oldFrame, auth);
    const third = applyWebSocketTabLimitSetting(oldFrame, auth);
    releaseOld(); await Promise.all([first, second, third]);
    check(settingsRequests - requestsBefore === 2 && removed.length === beforeStale && currentMaxTabs === 8,
      'invalidated HTTP response applied or repeated hints did not coalesce');
    passed.push('invalidations during fetch discard old HTTP before destructive application');

    // Exercise reservation before the ordered WS tail, not only direct calls.
    let releaseIngress, releaseIngressHttp, ingressRequestStarted;
    const ingressGate = new Promise(done => { releaseIngress = done; });
    const ingressHttpGate = new Promise(done => { releaseIngressHttp = done; });
    const ingressStarted = new Promise(done => { ingressRequestStarted = done; });
    const ingressBefore = settingsRequests;
    getSettings = async () => {
      if (settingsRequests === ingressBefore + 1) { ingressRequestStarted(); await ingressHttpGate; return snapshot(3); }
      return snapshot(8);
    };
    const inFlight = refreshSchoolSettings({ force: true, authContext: auth }); await ingressStarted;
    wsConnectionGeneration = 81;
    const key = JSON.stringify([81, auth.authContextId, auth.serverOrigin]);
    wsIngressTails.set(key, ingressGate);
    const ingress = handleWsEvent('message', JSON.stringify({ type: 'remote-control', ...envelope(auth), command }),
      81, auth.authContextId, auth.serverOrigin);
    releaseIngressHttp(); await inFlight;
    check(currentMaxTabs === 8 && removed.length === beforeStale, 'queued WS invalidation could not retire old HTTP');
    releaseIngress(); await ingress;
    passed.push('WS ingress invalidates before a blocked frame tail');

    getSettings = async () => snapshot(serverLimit);
    serverLimit = 6; schoolSettingsFetchedAt = 0;
    await runHeartbeat('school-limit-recovery', { applyClassroomState: async () => false });
    await wait(() => currentMaxTabs === 6, 'ordinary heartbeat school limit recovery');
    if (schoolSettingsRefreshState?.promise) await schoolSettingsRefreshState.promise;
    check(schoolMaxTabs === 6 && (await chrome.tabs.query({})).length === 6, 'missed fanout did not recover from heartbeat/settings');
    passed.push('ordinary heartbeat recovers a missed school limit without a new WS command');

    teacherMaxTabs = 4; serverLimit = null;
    await refreshSchoolSettings({ force: true, authContext: auth });
    check(schoolMaxTabs === null && teacherMaxTabs === 4 && currentMaxTabs === 4, 'unlimited school policy cleared teacher limit');
    teacherMaxTabs = null;
    await applyWebSocketTabLimitSetting(oldFrame, auth);
    check(schoolMaxTabs === null && currentMaxTabs === null, 'old WS limit re-enabled a disabled school limit');
    passed.push('unlimited school policy preserves independent teacher policy');

    serverLimit = 8; await refreshSchoolSettings({ force: true, authContext: auth });
    const beforeFailure = removed.length;
    getSettings = async () => { throw new Error('synthetic settings outage'); };
    const failed = await applyWebSocketTabLimitSetting(oldFrame, auth).then(() => false, () => true);
    check(failed && schoolMaxTabs === 8 && removed.length === beforeFailure, 'settings outage applied raw hint or cleared last valid limit');
    getSettings = async () => snapshot('invalid');
    await applyWebSocketTabLimitSetting(oldFrame, auth).catch(() => {});
    check(schoolMaxTabs === 8 && removed.length === beforeFailure, 'malformed limit disabled the last valid policy');
    passed.push('failed and malformed fetch preserve the last valid school limit');

    // A command joining an ordinary background refresh still requires fresh
    // settings when that flight is invalidated and its replacement fails.
    let releaseBackground, backgroundStarted;
    const backgroundGate = new Promise(done => { releaseBackground = done; });
    const backgroundReady = new Promise(done => { backgroundStarted = done; });
    const backgroundBefore = settingsRequests;
    getSettings = async () => {
      if (settingsRequests === backgroundBefore + 1) { backgroundStarted(); await backgroundGate; return snapshot(3); }
      throw new Error('synthetic replacement outage');
    };
    schoolSettingsFetchedAt = 0;
    const background = refreshSchoolSettings({ force: false, authContext: auth }).catch(() => null);
    await backgroundReady;
    const strictHint = applyWebSocketTabLimitSetting(oldFrame, auth).then(() => false, () => true);
    releaseBackground(); await background;
    check(await strictHint, 'a hint joining ordinary refresh falsely claimed current settings after a failed replacement');
    check(schoolMaxTabs === 8 && removed.length === beforeFailure, 'failed replacement applied a stale limit');
    passed.push('freshness requirements escalate for hints joining background refresh');

    // A late invalidation can arrive after cache/tab application, while a
    // sibling policy reducer is still awaiting Chrome. Re-check before return.
    let releasePolicy, policyStarted;
    const policyGate = new Promise(done => { releasePolicy = done; });
    const policyReady = new Promise(done => { policyStarted = done; });
    const nativeReconcilePolicy = reconcileSchoolWebsitePolicy;
    const policyBefore = settingsRequests;
    reconcileSchoolWebsitePolicy = async () => {
      if (settingsRequests === policyBefore + 1) { policyStarted(); await policyGate; }
    };
    getSettings = async () => ({ ...snapshot(settingsRequests === policyBefore + 1 ? 8 : null), policyRevision: 1 });
    const lateBackground = refreshSchoolSettings({ force: true, authContext: auth });
    await policyReady;
    const lateHint = applyWebSocketTabLimitSetting(oldFrame, auth);
    releasePolicy(); await Promise.all([lateBackground, lateHint]);
    reconcileSchoolWebsitePolicy = nativeReconcilePolicy;
    check(schoolMaxTabs === null && currentMaxTabs === null && settingsRequests === policyBefore + 2,
      'late invalidation was dropped after the last inner settings check');
    passed.push('late invalidation during sibling policy adoption triggers another snapshot');

    let releaseA, startedA;
    const gateA = new Promise(done => { releaseA = done; });
    const requestA = new Promise(done => { startedA = done; });
    const authA = auth;
    getSettings = async () => { startedA(); await gateA; return snapshot(3, authA); };
    const oldAuth = refreshSchoolSettings({ force: true, authContext: authA }).then(() => 'applied', error => error.code);
    await requestA;
    auth = install('b'); getSettings = async () => snapshot(8);
    await refreshSchoolSettings({ force: true, authContext: auth });
    releaseA(); const oldAuthOutcome = await oldAuth;
    check(oldAuthOutcome === 'AUTH_CONTEXT_SUPERSEDED' && schoolMaxTabs === 8
      && schoolSettingsScope === schoolPolicyScopeForAuthContext(auth), 'retired student HTTP response changed current school policy');
    passed.push('late HTTP from a retired student cannot change the new binding');
    return passed;
  });
  assert.equal(passed.length, 9);
  console.log(`ClassPilot school tab-limit Chrome checks passed (${passed.length}):\n${passed.join('\n')}`);
} finally {
  await context?.close().catch(() => {});
  rmSync(profile, { recursive: true, force: true });
}
