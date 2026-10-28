// Exercise shipped command/policy paths in Chrome with synthetic school
// authority and controlled background work. Notification creation is observed
// through a native call-through; command execution and DNR remain real.
// This is copy coverage, not a new notification or restriction delivery path.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { waitForExtensionWorkerDeclarations } from './extension-worker-test-readiness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extension = resolve(process.env.CLASSPILOT_EXTENSION_PATH || join(root, 'extension'));
const profile = mkdtempSync(join(tmpdir(), 'classpilot-focus-notifications-'));
const executablePath = [process.env.CLASSPILOT_CHROME_PATH, chromium.executablePath(),
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find(path => path && existsSync(path));
assert.ok(executablePath, 'Chrome/Chromium is required');
let context;
try {
  context = await chromium.launchPersistentContext(profile, { executablePath, headless: true,
    args: ['--headless=new', '--enable-automation', '--no-proxy-server',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
      `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  await context.route(/^https:\/\//, route => route.fulfill({ status: 200, contentType: 'text/html',
    body: '<!doctype html><title>Focus notification fixture</title><h1>Synthetic lesson</h1>' }));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15_000 });
  await waitForExtensionWorkerDeclarations(worker);
  const loadedVersion = await worker.evaluate(() => chrome.runtime.getManifest().version);
  assert.equal(loadedVersion, JSON.parse(readFileSync(join(extension, 'manifest.json'), 'utf8')).version);
  const lesson = await context.newPage();
  await lesson.goto('https://example.test/lesson');

  const result = await worker.evaluate(async () => {
    await authStateRestorePromise.catch(() => {});
    await classroomStateRestorePromise.catch(() => {});
    await studentAuthMutationTail.catch(() => {});
    const wakeDeadline = Date.now() + 20_000;
    while (!workerWakeSettled && Date.now() < wakeDeadline) await new Promise(done => setTimeout(done, 25));
    if (!workerWakeSettled) throw new Error('Notification fixture requires completed worker wake');
    CONFIG.autoRegistrationPaused = true;
    if (chromeProfileRegistrationInFlight) await chromeProfileRegistrationInFlight.catch(() => {});
    advanceStudentAuthMutationGeneration();
    fetchWithBackoff = async () => new Response('{}', { status: 503 });
    sendHeartbeat = async () => {}; connectWebSocket = async () => {}; scheduleEventHeartbeat = () => {};
    recoverOffscreenWebSocketStatus = async () => true;
    if (wsConnectInFlight) await wsConnectInFlight.catch(() => {});
    enqueueMonitoringEvent = async () => {};
    // Snapshot notification behavior is intentionally unchanged. Suppress its
    // unrelated best-effort navigation work; native command/DNR paths stay real.
    scheduleClassroomStateSideEffects = () => {};
    Object.assign(CONFIG, { serverUrl: 'http://127.0.0.1:1', schoolId: 'notification-school', deviceId: 'notification-device',
      activeStudentId: 'notification-student', activeStudentSessionId: 'notification-login', studentToken: 'synthetic-token',
      identitySource: 'integration_test' });
    studentAuthInvalidating = false; studentAuthCommitPending = false;
    activateAuthenticatedContext('focus-notification-fixture');
    const auth = captureAuthenticatedContext('Focus notification fixture');
    adoptLicenseState(true, 'active', auth);
    schoolSettings = { enableTrackingHours: false, afterHoursMode: 'off' };
    schoolSettingsScope = schoolPolicyScopeForAuthContext(auth); schoolSettingsFetchedAt = Date.now();
    trackingState = TRACKING_STATES.ACTIVE;
    await kv.set({ [SCHOOL_SETTINGS_CACHE_KEY]: schoolSettings, [SCHOOL_SETTINGS_SCOPE_KEY]: schoolSettingsScope,
      [SCHOOL_SETTINGS_FETCHED_AT_KEY]: schoolSettingsFetchedAt });
    adoptNegotiatedProtocolState({ serverProtocolVersion: 3, acceptedCapabilities: ['scopedAuthorityChecksV1',
      'classroomStateV1', 'focusTabV1', 'preciseRestrictionResourcesV1', 'screenOnlyUnlockV1'] }, auth);
    currentFabState = { teachingSessionId: 'notification-class', activeSessionIds: ['notification-class'] };
    const acknowledgements = [], notifications = [];
    wsConnected = true; wsSend = value => { acknowledgements.push(value); return true; };
    const nativeNotify = chrome.notifications.create;
    chrome.notifications.create = function (id, options, ...rest) {
      notifications.push({ title: options?.title, message: options?.message, priority: options?.priority });
      return nativeNotify.call(this, id, options, ...rest);
    };
    const require = (condition, message) => { if (!condition) throw new Error(message); };
    const wait = async (predicate, message) => {
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) { if (await predicate()) return; await new Promise(done => setTimeout(done, 25)); }
      throw new Error(message);
    };
    const expiry = Date.now() + 300_000;
    const baseRestrictions = () => ({ screenLock: { active: false }, flightPath: { active: false, allowedDomains: [] },
      blockList: { active: true, blockedDomains: ['blocked-teacher.test'] }, tabLimit: 8, focus: { active: false } });
    globalBlockedDomains = ['blocked-school.test'];
    const envelope = revision => ({ studentId: auth.studentId, studentSessionId: auth.studentSessionId,
      exactBinding: { bindingVersion: 2, schoolId: auth.schoolId, studentId: auth.studentId,
        studentSessionId: auth.studentSessionId, deviceId: auth.deviceId, controlRevision: revision } });
    const snapshot = restrictions => ({ schemaVersion: 1, revision: (currentStudentControlRevision() || 0) + 1,
      teachingSessionId: 'notification-class', receivedAt: Date.now(), hardExpiresAt: expiry,
      restrictions: { ...baseRestrictions(), ...restrictions } });
    const install = async restrictions => {
      const state = snapshot(restrictions), delivery = envelope(state.revision);
      observeExactStudentControlRevision(delivery, auth, 'notification fixture state');
      const applied = await applyClassroomState(state, { authContext: auth, authorityEnvelope: delivery });
      require(applied.outcome === 'applied', 'fixture restriction did not apply');
      return state;
    };
    let commandSequence = 0;
    const send = async (type, data, options = {}) => {
      const commandId = `notification-${++commandSequence}`;
      const revision = options.state?.revision ?? options.revision ?? currentStudentControlRevision();
      const delivery = { ...envelope(revision), type: 'remote-control', commandId, _msgId: commandId,
        deliveryPolicy: options.transient ? 'transient_action' : 'persistent_control',
        expiresAt: new Date(options.transient ? Date.now() + 15_000 : expiry).toISOString(),
        ...(options.state ? { classroomState: options.state } : {}) };
      observeExactStudentControlRevision(delivery, auth, 'notification fixture command');
      const command = { type, commandId, teachingSessionId: 'notification-class', data,
        ...(options.transient ? { currentPage: true, restrictionExpiresAt: new Date(expiry).toISOString() } : {}) };
      const before = notifications.length;
      await handleWsMessage(JSON.stringify({ ...delivery, command }), wsConnectionGeneration, auth);
      const applied = acknowledgements.find(ack => ack.commandId === commandId && ack.ackState === 'completed');
      require(applied?.outcome === 'applied',
        `command did not complete: ${type} ${JSON.stringify(acknowledgements.filter(ack => ack.commandId === commandId))}`);
      return { notifications: notifications.slice(before), applied, command, delivery };
    };
    const preserved = () => teacherBlockedDomains.includes('blocked-teacher.test')
      && globalBlockedDomains.includes('blocked-school.test') && currentMaxTabs === 8;

    // Authoritative website/resource snapshots remain silent; relabeling does
    // not add a second toast or imply a new command on reconnect/state sync.
    const website = await send('lock-screen', { url: 'https://example.test/lesson' }, {
      state: snapshot({ screenLock: { active: true, url: 'https://example.test/lesson', domain: 'example.test' } }) });
    require(screenLocked && lockedDomain === 'example.test', 'website snapshot did not set Focus');
    const documentUrl = 'https://docs.google.com/document/d/SyntheticFocusNotification0123456789/edit';
    const resource = { type: 'resource', hostname: 'docs.google.com', includeSubdomains: false,
      ...RuntimeCore.extractRestrictionResourceIdentity(documentUrl), canonicalUrl: documentUrl };
    const precise = await send('lock-screen', { url: documentUrl, resource }, {
      state: snapshot({ screenLock: { active: true, url: documentUrl, domain: 'docs.google.com', resource } }) });
    require(lockedResource?.resourceId === resource.resourceId, 'resource Focus lost its exact identity');
    const wrongResource = await createdTabPolicyDecision({ id: 90001, url: 'https://docs.google.com/document/d/OtherNotificationDocument0123456789/edit' }, async () => []);
    const blank = await createdTabPolicyDecision({ id: 90002, url: 'chrome://newtab/' }, async () => []);
    const allowedResource = await createdTabPolicyDecision({ id: 90003, url: documentUrl }, async () => []);
    const snapshotStop = await send('unlock-screen', { screenOnly: true }, { state: snapshot({}) });
    require(!screenLocked && preserved(), 'snapshot Stop Focus changed independent restrictions');

    const legacySet = await send('lock-screen', { url: 'https://example.test/lesson' });
    require(screenLocked && lockedDomain === 'example.test', 'legacy website command did not apply');
    const duplicateBefore = notifications.length;
    await handleWsMessage(JSON.stringify({ ...legacySet.delivery, command: legacySet.command }), wsConnectionGeneration, auth);
    const duplicateNotifications = notifications.slice(duplicateBefore);
    const stopOnly = await send('unlock-screen', { screenOnly: true });
    require(!screenLocked && preserved(), 'screen-only stop changed another restriction');

    await install({ flightPath: { active: true, allowedDomains: ['example.test'], name: 'Fixture path' },
      screenLock: { active: true, url: 'https://example.test/lesson', domain: 'example.test' } });
    const stopWithPath = await send('unlock-screen', { screenOnly: true });
    require(!screenLocked && flightPathIsActive() && allowedDomains.includes('example.test') && preserved(),
      'screen-only stop cleared the Flight Path or independent controls');
    const pathOnly = await createdTabPolicyDecision({ id: 90004, url: 'https://other.test/lesson' }, async () => []);
    await send('lock-screen', { url: 'https://example.test/lesson' });
    const fullUnlock = await send('unlock-screen', {});
    require(!screenLocked && !flightPathIsActive() && preserved(), 'full unlock changed historical clearing semantics');

    const currentPage = await send('lock-screen', { url: 'https://example.test/lesson?synthetic=private#section' }, { transient: true });
    require(screenLocked && transientCurrentPageRestrictionActive, 'current-page Focus did not apply');
    const currentPageStop = await send('unlock-screen', { screenOnly: true });
    require(!screenLocked && preserved(), 'current-page stop changed independent controls');

    // Legacy exact-tab Focus remains its own compatibility layer and its bare
    // stop must not claim the website Focus/Flight Path has been removed.
    await install({});
    const tab = (await chrome.tabs.query({})).find(item => item.url?.startsWith('https://example.test/'));
    require(tab, 'lesson tab is required for exact-tab compatibility');
    await wait(async () => (await chrome.tabs.get(tab.id)).status === 'complete', 'lesson tab did not settle');
    const tabs = await buildOpaqueTabSnapshot(await chrome.tabs.query({}), auth);
    const entry = tabs.localEntries.find(item => item.tabId === tab.id);
    require(entry?.tabRef, 'exact-tab compatibility needs the protected tab reference');
    const oldTabFocus = await send('focus-tab', { tabRef: entry.tabRef, observedRevision: tabs.revision }, {
      state: snapshot({ focus: { active: true, assignmentId: 'notification-legacy-focus', tabRef: entry.tabRef,
        observedRevision: tabs.revision, targetKind: 'snapshot', source: 'teacher', setAt: new Date().toISOString() } }) });
    await wait(() => focusStatus.state === 'active', 'legacy exact-tab Focus did not activate');
    const oldTabStop = await send('stop-focus', {}, { revision: currentStudentControlRevision() + 1 });
    require(!focusAssignment && focusStatus.state === 'inactive' && preserved(), 'legacy stop changed independent controls');

    return { website: website.notifications, precise: precise.notifications, snapshotStop: snapshotStop.notifications,
      wrongResource: wrongResource.notification, wrongResourceSource: wrongResource.policySource,
      blank: blank.notification, allowedResource: allowedResource.notification,
      pathOnly: pathOnly.notification, pathOnlySource: pathOnly.policySource,
      legacySet: legacySet.notifications, duplicateNotifications, stopOnly: stopOnly.notifications,
      stopWithPath: stopWithPath.notifications, fullUnlock: fullUnlock.notifications,
      currentPage: currentPage.notifications, currentPageStop: currentPageStop.notifications,
      oldTabFocus: oldTabFocus.notifications, oldTabStop: oldTabStop.notifications,
      independentRestrictionsPreserved: preserved() };
  });

  for (const key of ['website', 'precise', 'snapshotStop', 'duplicateNotifications', 'oldTabFocus', 'oldTabStop']) {
    assert.deepEqual(result[key], [], `${key} must retain its existing silent behavior`);
  }
  const setNotice = { title: 'Focus Set', message: 'Your teacher set Focus on example.test. Stay on the website or resource your teacher selected.', priority: 2 };
  assert.deepEqual(result.legacySet, [setNotice]);
  assert.deepEqual(result.currentPage, [setNotice], 'current-page notification must not expose its URL query or fragment');
  const stopped = { title: 'Focus Stopped', message: 'Focus has stopped. Any other classroom or school browsing restrictions still apply.', priority: 1 };
  assert.deepEqual(result.stopOnly, [stopped]);
  assert.deepEqual(result.currentPageStop, [stopped]);
  assert.deepEqual(result.stopWithPath, [{ title: 'Focus Stopped', message: 'Focus has stopped. Your class Flight Path is still active.', priority: 1 }]);
  assert.deepEqual(result.fullUnlock, [{ title: 'Screen Unlocked', message: 'Your screen has been unlocked. Any other classroom or school browsing restrictions still apply.', priority: 1 }]);
  assert.equal(result.wrongResourceSource, 'resource');
  assert.deepEqual(result.wrongResource, { title: 'Navigation Blocked', message: 'This page is outside your current classroom or school browsing policy.', priority: 2 },
    'a precise policy denial keeps its existing generic notification');
  assert.deepEqual(result.blank, { title: 'Focus Active', message: 'Focus is active on docs.google.com. Stay on the website or resource your teacher selected.', priority: 2 });
  assert.equal(result.allowedResource, null, 'the exact allowed resource must not trigger a blocked-policy notification');
  assert.equal(result.pathOnlySource, 'flight_path');
  assert.equal(result.pathOnly.title, 'Navigation Blocked', 'a Flight Path must not be presented as website Focus');
  assert.equal(result.independentRestrictionsPreserved, true);
  assert.doesNotMatch(JSON.stringify(result), /Waypoint|browse freely/);
  console.log('Native Focus notification checks passed:', JSON.stringify({ extensionVersion: loadedVersion,
    legacyWebsiteAndCurrentPage: true, precisePolicyCopy: true, screenOnlyAndFullUnlock: true,
    independentRestrictionsPreserved: true, canonicalSnapshotAndLegacyTabSilence: true, duplicateCommandSilent: true }));
} finally {
  await context?.close();
  const withinTemp = relative(resolve(tmpdir()), resolve(profile));
  assert.ok(withinTemp.startsWith('classpilot-focus-notifications-') && !withinTemp.includes(sep), 'Cleanup must stay inside this test profile');
  rmSync(profile, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
}
