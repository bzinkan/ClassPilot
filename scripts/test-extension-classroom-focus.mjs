// Actual MV3 worker, native Chrome storage and DNR; only authenticated school
// responses and deliberately rejected browser operations are synthetic.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { waitForExtensionWorkerDeclarations } from './extension-worker-test-readiness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extensionPath = resolve(process.env.CLASSPILOT_EXTENSION_PATH || join(root, 'extension'));
const fixture = JSON.parse(readFileSync(join(root, 'server/__tests__/fixtures/classroom-focus-scope-cases.json')));
const profile = mkdtempSync(join(tmpdir(), 'classpilot-classroom-focus-'));
const executablePath = [process.env.CLASSPILOT_CHROME_PATH, chromium.executablePath(),
  'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(value => value && existsSync(value));
assert.ok(executablePath, 'Actual Chrome/Chromium is required');
let context;
try {
  context = await chromium.launchPersistentContext(profile, { executablePath, headless: true,
    args: ['--headless=new', '--enable-automation', '--no-proxy-server',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
      `--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15_000 });
  await waitForExtensionWorkerDeclarations(worker);
  const result = await worker.evaluate(async fixture => {
    const require = (condition, message) => { if (!condition) throw new Error(`[regression:classroom-focus] ${message}`); };
    const until = async (predicate, message) => {
      const deadline = Date.now() + 20_000;
      while (!await predicate()) {
        require(Date.now() < deadline, message);
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    };
    await authStateRestorePromise; await classroomStateRestorePromise; await studentAuthMutationTail;
    await until(() => workerWakeSettled, 'native worker startup did not settle');
    CONFIG.autoRegistrationPaused = true;
    if (chromeProfileRegistrationInFlight) await chromeProfileRegistrationInFlight.catch(() => {});
    advanceStudentAuthMutationGeneration();
    Object.assign(CONFIG, { serverUrl: 'http://127.0.0.1:1', schoolId: 'classroom-focus-school',
      deviceId: 'classroom-focus-device', activeStudentId: 'classroom-focus-student',
      activeStudentSessionId: 'classroom-focus-login', studentToken: 'synthetic-token', identitySource: 'integration_test' });
    studentAuthInvalidating = false; studentAuthCommitPending = false;
    activateAuthenticatedContext('classroom-focus-auth');
    const auth = captureAuthenticatedContext('Classroom Focus fixture');
    adoptLicenseState(true, 'active', auth);
    const settings = { enableTrackingHours: false, afterHoursMode: 'off' };
    await kv.set({ [SCHOOL_SETTINGS_CACHE_KEY]: settings, [SCHOOL_SETTINGS_SCOPE_KEY]: schoolPolicyScopeForAuthContext(auth),
      [SCHOOL_SETTINGS_FETCHED_AT_KEY]: Date.now() });
    await loadCachedSchoolSettings({ authContext: auth });
    trackingState = TRACKING_STATES.ACTIVE;
    // Match other native authority fixtures: no school transport can escape
    // the isolated browser, and post-ACK tab plans are inspected separately.
    fetchWithBackoff = async () => new Response('{}', { status: 503 });
    sendHeartbeat = async () => {};
    connectWebSocket = async () => {};
    recoverOffscreenWebSocketStatus = async () => true;
    if (wsConnectInFlight) await wsConnectInFlight.catch(() => {});
    scheduleEventHeartbeat = () => {};
    enqueueMonitoringEvent = async () => {};
    scheduleClassroomStateSideEffects = () => {};
    scheduleHeartbeat(null); await chrome.alarms.clearAll();
    currentFabState = { teachingSessionId: 'classroom-focus-class', activeSessionIds: ['classroom-focus-class'] };
    const capabilities = ['classroomStateV1', 'scopedAuthorityChecksV1', 'preciseRestrictionResourcesV1',
      'classroomFocusScopeV1', 'screenOnlyUnlockV1'];
    const negotiate = values => adoptNegotiatedProtocolState({ serverProtocolVersion: 3, acceptedCapabilities: values }, auth);
    negotiate(capabilities);
    const acks = [];
    wsConnected = true; wsSend = value => { acks.push(value); return true; };
    const workHosts = ['classroom.google.com', 'docs.google.com', 'drive.google.com', 'sheets.google.com',
      'slides.google.com', 'forms.google.com', 'forms.gle'];
    const scope = structuredClone(fixture.scope);
    const video = scope.resources[0];
    const base = () => ({ screenLock: { active: true, url: 'https://classroom.google.com', domain: 'classroom.google.com',
      classroomScope: structuredClone(scope) }, flightPath: { active: true, allowedDomains: ['underlying.example'], name: 'Prior path' },
    blockList: { active: true, blockedDomains: ['teacher-blocked.assigned.example'] }, tabLimit: 2 });
    globalBlockedDomains = ['school-blocked.assigned.example'];
    await composeDynamicRules(['school']);
    const expiry = Date.now() + 300_000;
    let revision = 0;
    const snapshot = restrictions => ({ schemaVersion: 1, revision: ++revision, teachingSessionId: 'classroom-focus-class',
      receivedAt: Date.now(), hardExpiresAt: expiry, restrictions });
    const envelope = value => ({ studentId: auth.studentId, studentSessionId: auth.studentSessionId,
      exactBinding: { bindingVersion: 2, schoolId: auth.schoolId, studentId: auth.studentId,
        studentSessionId: auth.studentSessionId, deviceId: auth.deviceId, controlRevision: value } });
    const install = state => {
      const delivery = envelope(state.revision);
      observeExactStudentControlRevision(delivery, auth, 'synthetic Classroom Focus state');
      return applyClassroomState(state, { authContext: auth, authorityEnvelope: delivery });
    };
    const matcher = url => RuntimeCore.decideNavigation(url, { classroomState: runtimeClassroomStateForRules(),
      globalBlockedDomains: [...globalBlockedDomains] }).allowed;
    const nativeAction = async url => {
      const rules = await chrome.declarativeNetRequest.getDynamicRules();
      const outcome = await chrome.declarativeNetRequest.testMatchOutcome({ url, type: 'main_frame' });
      const matching = outcome.matchedRules.map(match => rules.find(rule => rule.id === match.ruleId)).filter(Boolean);
      matching.sort((left, right) => right.priority - left.priority || (left.action.type === 'allow' ? -1 : 1));
      return matching[0]?.action.type || 'none';
    };
    // Ordinary website Focus requires no Classroom source review or precise
    // capability. Exercise the installed worker and Chrome's real DNR engine.
    negotiate(['classroomStateV1', 'screenOnlyUnlockV1']);
    const ordinary = () => ({ screenLock: { active: true, url: 'https://classroom.google.com/c/course', domain: 'classroom.google.com' },
      flightPath: { active: true, allowedDomains: ['underlying.example'] }, attentionMode: { active: true }, tabLimit: 2 });
    require((await install(snapshot(ordinary()))).outcome === 'applied', 'ordinary Classroom website Focus required a capability gate');
    const ordinaryAllowed = [...workHosts.map(host => `https://${host}/student-work`),
      'https://docs.google.com/document/d/SyntheticStudentCopy012345678901/edit'];
    const ordinaryDenied = ['https://google.com/search?q=answers', 'https://www.google.com/search?q=answers',
      'https://images.google.com/', 'https://mail.google.com/', 'https://sites.google.com/', 'https://youtube.com/',
      'https://unrelated.example/', 'https://classroom.google.com.evil.example/', 'https://docs.google.com.evil.example/'];
    for (const url of ordinaryAllowed) {
      require(await nativeAction(url) !== 'block', `ordinary native Focus denied Google work: ${url}`);
      require(matcher(url), `ordinary Focus matcher denied Google work: ${url}`);
    }
    for (const url of ordinaryDenied) {
      require(await nativeAction(url) === 'block' && !matcher(url), `ordinary Focus admitted unrelated work: ${url}`);
    }
    require(!createdTabRemovalDecisionStillApplies({ policySource: 'screen_lock' },
      { id: 123, url: 'https://docs.google.com/document/d/student-copy/edit' }),
    'ordinary Focus removed a new Google work tab');
    const ordinaryTabs = [{ id: 1, active: true, url: 'https://classroom.google.com/c/course' },
      { id: 2, url: 'https://docs.google.com/document/d/student-copy/edit' },
      { id: 3, url: 'https://drive.google.com/student-work' }, { id: 4, url: 'https://google.com/search?q=answers' }];
    const ordinaryPlan = RuntimeCore.planClassroomTabReconciliation(currentClassroomState, ordinaryTabs,
      { foregroundTabId: 1, maxTabs: 1, existingTabLimitMode: 'preserve-existing' });
    require(JSON.stringify(ordinaryPlan.removeTabIds) === '[4]' && ordinaryPlan.updates.length === 0,
      'ordinary Focus closed or replaced existing Google work');
    const ordinaryRestored = RuntimeCore.normalizePersistedClassroomState(persistedClassroomStateSnapshot(currentClassroomState));
    require((await applyClassroomState(ordinaryRestored, { authContext: auth, trustedPersistedRestrictionSso: true, force: true })).outcome === 'applied',
      'ordinary Focus did not restore');
    require(matcher(ordinaryAllowed[1]) && await nativeAction(ordinaryAllowed[1]) !== 'block', 'ordinary restore lost Google work');
    const currentTab = await chrome.tabs.create({ active: true, url: 'https://classroom.google.com/c/current' });
    await until(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))
      .some(tab => tab.id === currentTab.id && isHttpUrl(tab.url)), 'current Classroom tab did not settle');
    const marker = ordinary(); marker.screenLock = { active: true, url: 'CURRENT_URL' };
    require((await install(await resolveCurrentUrlMarker(snapshot(marker)))).outcome === 'applied', 'current-page Classroom Focus did not apply');
    require(matcher(ordinaryAllowed[1]) && await nativeAction(ordinaryAllowed[1]) !== 'block', 'current-page Classroom Focus lost Google work');
    await chrome.tabs.remove(currentTab.id);
    globalBlockedDomains = ['sheets.google.com']; await composeDynamicRules(['school']);
    require((await install(snapshot({ ...ordinary(), blockList: { active: true, blockedDomains: ['forms.google.com'] } }))).outcome === 'applied',
      'ordinary blocked work fixture did not apply');
    for (const url of ['https://sheets.google.com/student-work', 'https://forms.google.com/student-work'])
      require(!matcher(url) && await nativeAction(url) === 'block', 'ordinary companions overrode school or teacher blocking');
    require((await install(snapshot({ ...ordinary(), screenLock: { active: false } }))).outcome === 'applied', 'ordinary Stop Focus did not apply');
    require(flightPathIsActive() && matcher('https://underlying.example/work') && !matcher(ordinaryAllowed[1])
      && await nativeAction(ordinaryAllowed[1]) === 'block' && attentionModeActive && currentMaxTabs === 2,
    'ordinary Stop Focus lost independent controls or retained companion exceptions');
    globalBlockedDomains = ['school-blocked.assigned.example']; await composeDynamicRules(['school']);
    negotiate(capabilities);
    const active = snapshot(base());
    require((await install(active)).outcome === 'applied', 'valid reviewed scope was not applied');
    require(currentClassroomState.restrictions.screenLock.classroomScope?.sourceRevision === scope.sourceRevision,
      'normalization dropped the reviewed Classroom scope');
    const allowed = [...workHosts.map(host => `https://${host}/student-work`),
      'https://assigned.example/launch?assignment=one&student=synthetic',
      'https://assigned.example/different-page?reviewed=whole-website', video.canonicalUrl];
    const denied = ['https://unassigned.example/lesson', 'https://classroom.google.com.evil.example/',
      'https://mail.google.com/', 'https://sites.google.com/', 'https://www.youtube.com/watch?v=9bZkp7q19f0',
      'https://www.youtube.com/', 'https://teacher-blocked.assigned.example/work',
      'https://school-blocked.assigned.example/work'];
    for (const url of allowed) {
      require(matcher(url), `matcher denied assigned work: ${url}`);
      require(await nativeAction(url) !== 'block', `native DNR denied assigned work: ${url}`);
    }
    for (const url of denied) {
      require(!matcher(url), `matcher admitted unassigned or blocked work: ${url}`);
      require(await nativeAction(url) === 'block', `native DNR admitted unassigned or blocked work: ${url}`);
    }
    for (const entry of fixture.match) {
      require(matcher(entry.url) === entry.allowed, `shared matcher case failed: ${entry.name}`);
      require((await nativeAction(entry.url) !== 'block') === entry.allowed, `shared native case failed: ${entry.name}`);
    }
    require(!createdTabRemovalDecisionStillApplies({ policySource: 'screen_lock' },
      { id: 123, url: 'https://docs.google.com/document/d/student-copy/edit' }),
    'late approved work navigation was still selected for tab removal');
    const tabs = [{ id: 1, windowId: 1, active: true, url: 'https://classroom.google.com/c/course' },
      { id: 2, windowId: 1, url: 'https://docs.google.com/document/d/SyntheticStudentCopy012345678901/edit' },
      { id: 3, windowId: 2, url: 'https://assigned.example/launch?assignment=one' },
      { id: 4, windowId: 2, url: 'https://unassigned.example/' }];
    const tabPlan = RuntimeCore.planClassroomTabReconciliation(currentClassroomState, tabs,
      { foregroundTabId: 1, maxTabs: 1, existingTabLimitMode: 'preserve-existing' });
    require(JSON.stringify(tabPlan.removeTabIds) === '[4]' && tabPlan.updates.length === 0,
      'Classroom Focus replaced or closed approved student work');

    const accepted = { state: JSON.stringify(currentClassroomState),
      storage: JSON.stringify(await kv.get([CLASSROOM_STATE_STORAGE_KEY])),
      rules: JSON.stringify(await chrome.declarativeNetRequest.getDynamicRules()) };
    const assertPreserved = async label => {
      require(JSON.stringify(currentClassroomState) === accepted.state, `${label} changed accepted state`);
      require(JSON.stringify(await kv.get([CLASSROOM_STATE_STORAGE_KEY])) === accepted.storage, `${label} changed accepted storage`);
      require(JSON.stringify(await chrome.declarativeNetRequest.getDynamicRules()) === accepted.rules, `${label} changed native rules`);
    };
    const reject = async (state, label) => {
      const start = acks.length;
      let error;
      try { await install(state); } catch (failure) { error = failure; }
      require(Boolean(error), `${label} was accepted`);
      await assertPreserved(label);
      const outcomes = acks.slice(start).filter(ack => ack.type === 'classroom-state-ack' && ack.appliedRevision === state.revision);
      require(outcomes.length > 0 && outcomes.every(ack => ['failed', 'unsupported'].includes(ack.outcome)), `${label} emitted an applied ACK`);
    };
    negotiate(capabilities.filter(value => value !== 'classroomFocusScopeV1'));
    await reject(active, 'same-revision capability withdrawal');
    negotiate(capabilities);
    const malformed = base(); malformed.screenLock.classroomScope.sourceRevision = 'invalid';
    await reject(snapshot(malformed), 'malformed source revision');
    const wrongFocus = base(); wrongFocus.screenLock.url = 'https://other.example'; wrongFocus.screenLock.domain = 'other.example';
    await reject(snapshot(wrongFocus), 'non-Classroom Focus scope');
    const currentPage = base(); currentPage.screenLock.url = 'CURRENT_URL';
    await reject(snapshot(currentPage), 'CURRENT_URL with a reviewed scope');
    for (const missing of ['classroomFocusScopeV1', 'preciseRestrictionResourcesV1', 'scopedAuthorityChecksV1']) {
      negotiate(capabilities.filter(value => value !== missing));
      await reject(snapshot(base()), `missing ${missing}`);
    }
    negotiate(capabilities);
    const bareScopeId = 'classroom-scope-without-state';
    const bareDelivery = { ...envelope(++revision), commandId: bareScopeId, deliveryPolicy: 'persistent_control',
      expiresAt: new Date(expiry).toISOString(), teachingSessionId: 'classroom-focus-class' };
    observeExactStudentControlRevision(bareDelivery, auth, 'synthetic scope command without state');
    await handleRemoteControl({ type: 'lock-screen', commandId: bareScopeId,
      teachingSessionId: 'classroom-focus-class', data: { url: 'https://classroom.google.com', classroomScope: scope } }, bareDelivery);
    await assertPreserved('scope command without authoritative state');
    require(acks.some(ack => ack.commandId === bareScopeId && ack.ackState === 'failed'),
      'a legacy scope command did not fail honestly');
    const nativeUpdate = chrome.declarativeNetRequest.updateDynamicRules;
    chrome.declarativeNetRequest.updateDynamicRules = async () => { throw new Error('synthetic atomic installation failure'); };
    try { await reject(snapshot(base()), 'native installation rejection'); }
    finally { chrome.declarativeNetRequest.updateDynamicRules = nativeUpdate; }
    const nativeSupport = chrome.declarativeNetRequest.isRegexSupported;
    supportedRestrictionRegexes.clear();
    chrome.declarativeNetRequest.isRegexSupported = async () => ({ isSupported: false, reason: 'synthetic rejection' });
    try { await reject(snapshot(base()), 'unsupported native resource regex'); }
    finally { chrome.declarativeNetRequest.isRegexSupported = nativeSupport; supportedRestrictionRegexes.clear(); }

    const persisted = persistedClassroomStateSnapshot(currentClassroomState);
    require(persisted.schemaVersion === 4 && persisted.classroomScopePersistenceVersion === 1,
      'reviewed scope persistence lacks its downgrade fence');
    const restored = RuntimeCore.normalizePersistedClassroomState(persisted);
    require(restored.restrictions.screenLock.classroomScope.sourceRevision === scope.sourceRevision,
      'persisted scope restore lost source identity');
    const restoredResult = await applyClassroomState(restored,
      { authContext: auth, trustedPersistedRestrictionSso: true, force: true });
    require(restoredResult.outcome === 'applied' && matcher('https://assigned.example/launch?restored=1'),
      'previously owned scope could not restore');
    const stop = snapshot({ ...base(), screenLock: { active: false } });
    const stopId = 'classroom-focus-stop';
    const stopDelivery = { ...envelope(stop.revision), type: 'remote-control', commandId: stopId,
      deliveryPolicy: 'persistent_control', expiresAt: new Date(expiry).toISOString(), classroomState: stop,
      command: { type: 'unlock-screen', commandId: stopId, teachingSessionId: 'classroom-focus-class', data: { screenOnly: true } } };
    observeExactStudentControlRevision(stopDelivery, auth, 'synthetic Stop Focus');
    await handleWsMessage(JSON.stringify(stopDelivery), wsConnectionGeneration, auth);
    require(acks.some(ack => ack.commandId === stopId && ack.ackState === 'completed' && ack.outcome === 'applied'),
      'Stop Focus did not complete');
    require(!currentClassroomState.restrictions.screenLock.classroomScope && !screenLocked && flightPathIsActive(),
      'Stop Focus retained the scope or cleared the prior Flight Path');
    require(matcher('https://underlying.example/retained') && !matcher('https://assigned.example/launch'),
      'Stop Focus did not restore the underlying restriction');
    require(await nativeAction('https://underlying.example/retained') !== 'block'
      && await nativeAction('https://assigned.example/launch') === 'block', 'Stop Focus left stale native scope allows');
    await install(snapshot(base()));
    await clearTeacherSessionStateForSignOut({ emitEvent: false, reason: 'synthetic student handoff' });
    require(!(await kv.get([CLASSROOM_STATE_STORAGE_KEY]))[CLASSROOM_STATE_STORAGE_KEY],
      'student handoff retained the prior reviewed scope');
    require((await chrome.declarativeNetRequest.getDynamicRules()).filter(rule => RuntimeCore.isRuleInRange(rule.id, 'classroom')).length === 0,
      'student handoff retained the prior scope native rules');
    return { ordinaryAllowedChecks: ordinaryAllowed.length, ordinaryDeniedChecks: ordinaryDenied.length,
      ordinaryRestoreAndCurrentPage: true, ordinaryIndependentControls: true, allowedChecks: allowed.length, deniedChecks: denied.length, priorWorkPreserved: true,
      wholeWebsiteReviewHonored: true, malformedAndCapabilityRejections: true, nativeFailureAtomic: true,
      storageSchema: persisted.schemaVersion, ownedRestore: true, stopPreservesFlightPath: true, studentHandoffClearsScope: true };
  }, fixture);
  console.log(JSON.stringify({ browser: context.browser().version(), classroomFocusAcceptance: result }, null, 2));
} finally {
  if (context) await context.close();
  rmSync(profile, { recursive: true, force: true });
}
