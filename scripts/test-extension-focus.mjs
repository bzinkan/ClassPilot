import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { waitForExtensionWorkerDeclarations } from './extension-worker-test-readiness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extension = resolve(process.env.CLASSPILOT_EXTENSION_PATH || join(root, 'extension'));
const profile = mkdtempSync(join(tmpdir(), 'classpilot-focus-'));
const executablePath = [process.env.CLASSPILOT_CHROME_PATH, chromium.executablePath(),
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find(path => path && existsSync(path));
assert.ok(executablePath, 'Chrome/Chromium is required');
let browser;
try {
  browser = await chromium.launchPersistentContext(profile, { executablePath, headless: true,
    args: ['--headless=new', '--enable-automation', '--no-proxy-server',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
      `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  await browser.route(/^https:\/\//, route => route.fulfill({ status: 200, contentType: 'text/html',
    body: '<!doctype html><title>Focus fixture</title><h1>Synthetic exact tab</h1>' }));
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker', { timeout: 15_000 });
  await waitForExtensionWorkerDeclarations(worker);
  assert.equal(await worker.evaluate(() => chrome.runtime.getManifest().version),
    JSON.parse(readFileSync(join(extension, 'manifest.json'), 'utf8')).version);
  const result = await worker.evaluate(async () => {
    await authStateRestorePromise.catch(() => {}); await classroomStateRestorePromise.catch(() => {});
    await studentAuthMutationTail.catch(() => {});
    const wakeDeadline = Date.now() + 15_000;
    while (!workerWakeSettled && Date.now() < wakeDeadline) await new Promise(done => setTimeout(done, 25));
    if (!workerWakeSettled) throw new Error('Synthetic transport setup requires completed production worker wake');
    CONFIG.autoRegistrationPaused = true;
    if (chromeProfileRegistrationInFlight) await chromeProfileRegistrationInFlight.catch(() => {});
    advanceStudentAuthMutationGeneration();
    fetchWithBackoff = async () => new Response('{}', { status: 503 });
    sendHeartbeat = async () => {}; connectWebSocket = async () => {}; scheduleEventHeartbeat = () => {};
    recoverOffscreenWebSocketStatus = async () => true;
    if (wsConnectInFlight) await wsConnectInFlight.catch(() => {});
    enqueueMonitoringEvent = async () => {};
    // Exercise native Focus independently of legacy tab reconciliation. The
    // shared policy/DNR tests separately verify navigation reconciliation.
    scheduleClassroomStateSideEffects = () => {};
    Object.assign(CONFIG, { serverUrl: 'http://127.0.0.1:1', schoolId: 'focus-school', deviceId: 'focus-device',
      activeStudentId: 'focus-student', activeStudentSessionId: 'focus-login', studentToken: 'synthetic-token', identitySource: 'integration_test' });
    studentAuthInvalidating = false; studentAuthCommitPending = false;
    activateAuthenticatedContext('focus-auth');
    const auth = captureAuthenticatedContext('Focus browser fixture');
    adoptLicenseState(true, 'active', auth);
    schoolSettings = { enableTrackingHours: false, afterHoursMode: 'off' };
    schoolSettingsScope = schoolPolicyScopeForAuthContext(auth); schoolSettingsFetchedAt = Date.now(); trackingState = TRACKING_STATES.ACTIVE;
    await kv.set({ [SCHOOL_SETTINGS_CACHE_KEY]: schoolSettings, [SCHOOL_SETTINGS_SCOPE_KEY]: schoolSettingsScope,
      [SCHOOL_SETTINGS_FETCHED_AT_KEY]: schoolSettingsFetchedAt });
    const caps = ['scopedAuthorityChecksV1', 'classroomStateV1', 'focusTabV1', 'preciseRestrictionResourcesV1', 'restrictionAuthPassThroughV1'];
    const negotiate = (accepted = caps) => adoptNegotiatedProtocolState({ serverProtocolVersion: 3, acceptedCapabilities: accepted }, auth);
    negotiate();
    currentFabState = { teachingSessionId: 'focus-class', activeSessionIds: ['focus-class'] };
    const acks = []; wsConnected = true; wsSend = value => { acks.push(value); return true; };
    const require = (condition, message) => { if (!condition) throw new Error(message); };
    const wait = async (predicate, message, timeout = 12_000) => {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) { if (await predicate()) return; await new Promise(done => setTimeout(done, 25)); }
      throw new Error(`${message}: ${JSON.stringify(publicFocusStatus())}`);
    };
    const pauseTimer = () => { if (focusMaintenanceTimer) clearTimeout(focusMaintenanceTimer); focusMaintenanceTimer = null; };
    let revision = 1;
    const envelope = value => ({ studentId: auth.studentId, studentSessionId: auth.studentSessionId,
      exactBinding: { bindingVersion: 2, schoolId: auth.schoolId, studentId: auth.studentId,
        studentSessionId: auth.studentSessionId, deviceId: auth.deviceId, controlRevision: value } });
    const expiry = Date.now() + 300_000;
    const state = (focus = { active: false }, extra = {}) => ({ schemaVersion: 1, revision: revision++, teachingSessionId: 'focus-class',
      receivedAt: Date.now(), hardExpiresAt: expiry,
      restrictions: { flightPath: { active: true, allowedDomains: ['example.test'] }, focus, ...extra } });
    const install = async snapshot => {
      const authorityEnvelope = envelope(snapshot.revision);
      observeExactStudentControlRevision(authorityEnvelope, auth, 'Focus fixture authenticated delivery');
      return applyClassroomState(snapshot, { authContext: auth, authorityEnvelope });
    };
    const target = (entry, observedRevision, assignmentId, targetKind = 'snapshot') => ({ active: true, assignmentId,
      tabRef: entry.tabRef, observedRevision, targetKind, source: 'teacher', setAt: new Date().toISOString() });
    const exact = async () => buildOpaqueTabSnapshot(await chrome.tabs.query({}), auth);
    const first = await chrome.tabs.create({ url: 'https://example.test/same', active: true });
    const second = await chrome.tabs.create({ url: 'https://example.test/same', active: true });
    await wait(async () => (await chrome.tabs.get(first.id)).url === 'https://example.test/same'
      && (await chrome.tabs.get(second.id)).url === 'https://example.test/same', 'duplicate native tabs did not finish navigation');
    await install(state());
    let snapshot = await exact();
    const firstRef = snapshot.localEntries.find(entry => entry.tabId === first.id);
    const secondRef = snapshot.localEntries.find(entry => entry.tabId === second.id);
    require(firstRef?.tabRef && secondRef?.tabRef && firstRef.tabRef !== secondRef.tabRef, 'duplicate URLs must have distinct refs');
    const a = target(firstRef, snapshot.revision, 'focus-A');
    const firstFocusState = state(a);
    const firstFocusEnvelope = { ...envelope(firstFocusState.revision), type: 'remote-control',
      commandId: 'focus-command-A', classroomState: firstFocusState, deliveryPolicy: 'persistent_control',
      expiresAt: new Date(expiry).toISOString() };
    const focusCommandResult = await handleRemoteControl({ type: 'focus-tab', commandId: 'focus-command-A',
      teachingSessionId: 'focus-class', data: { tabRef: a.tabRef, observedRevision: a.observedRevision },
      exactBinding: firstFocusEnvelope.exactBinding }, firstFocusEnvelope);
    require(focusCommandResult?.outcome === 'applied'
      && acks.some(ack => ack.commandId === 'focus-command-A' && ack.ackState === 'completed'
        && ack.outcome === 'applied' && ack.appliedRevision === firstFocusState.revision),
      `canonical Focus command ACK missing: ${JSON.stringify({ focusCommandResult, acks: acks.slice(-4) })}`);
    await wait(() => focusStatus.state === 'active', 'Focus never verified native activation');
    require((await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id === first.id, 'wrong duplicate tab activated');
    const aRecord = focusAssignment;
    // An unrelated public snapshot revision does not re-resolve adopted A.
    await chrome.tabs.create({ url: 'https://example.test/unrelated', active: true });
    snapshot = await exact();
    await install(state(a, { tabLimit: 30 }));
    await wait(() => focusStatus.state === 'active', 'retained exact assignment did not resume');
    require(focusAssignment.tabId === first.id && focusAssignment.observedRevision === a.observedRevision, 'retained Focus changed identity/revision');
    // Focus status reports only Focus, preserving a pending non-Focus outcome.
    pauseTimer(); lastClassroomStateOutcome = 'pending'; wsConnected = true;
    focusStatus = { state: 'inactive' };
    publishFocusStatus({ assignmentId: a.assignmentId, state: 'suspended', reason: 'browser_operation_pending' }, auth);
    require(acks.at(-1)?.outcome === 'pending', `Focus manufactured applied policy outcome: ${JSON.stringify(acks.slice(-3))}`);
    publishFocusStatus({ assignmentId: a.assignmentId, state: 'active' }, auth);
    require(acks.at(-1)?.outcome === 'pending', 'active Focus manufactured applied policy outcome');
    lastClassroomStateOutcome = 'applied';
    // Attention preserves assignment and cannot pull the foreground away.
    await install(state(a, { attentionMode: { active: true } }));
    await chrome.tabs.update(second.id, { active: true });
    await wait(() => focusStatus.reason === 'attention', 'Attention did not suspend Focus');
    await new Promise(done => setTimeout(done, 2100));
    require((await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id === second.id, 'Focus stole Attention foreground');
    await install(state(a)); await wait(() => focusStatus.state === 'active', 'Attention resume failed');
    // Whole-state rejection preserves the previously owned policy and lease.
    const before = currentClassroomState;
    negotiate(caps.filter(cap => cap !== 'focusTabV1'));
    let rejected = false;
    const unsupported = state({ ...a, assignmentId: 'unsupported-B' });
    try { await install(unsupported); } catch (error) { rejected = error.code === 'FOCUS_CAPABILITY_REQUIRED'; }
    require(rejected && currentClassroomState === before, 'capability withdrawal partially adopted snapshot');
    require(acks.some(ack => ack.type === 'classroom-state-ack' && ack.appliedRevision === unsupported.revision && ack.outcome === 'unsupported')
      && !acks.some(ack => ack.type === 'classroom-state-ack' && ack.appliedRevision === unsupported.revision && ack.outcome === 'applied'), 'unsupported Focus ACK was dishonest');
    // Exact bare stop survives gate withdrawal and null-state resync; all
    // previously installed non-Focus policy and its deadline remain intact.
    const stopRevision = revision++;
    const cleanup = { ...envelope(stopRevision), type: 'remote-control', commandId: 'stop-fixture', deliveryPolicy: 'persistent_control', expiresAt: new Date(expiry).toISOString(),
      command: { type: 'stop-focus', commandId: 'stop-fixture', teachingSessionId: 'focus-class', data: {}, deliveryPolicy: 'persistent_control', expiresAt: new Date(expiry).toISOString() } };
    cleanup.command.exactBinding = cleanup.exactBinding;
    await applyClassroomStateFromAuthResponse({ ...envelope(stopRevision), classroomState: null, focusCleanup: cleanup }, 'Focus cleanup fixture', { authContext: auth });
    require(!focusAssignment && focusStatus.state === 'inactive', 'bare stop failed to clear current Focus');
    require(currentClassroomState.revision === before.revision && currentClassroomState.hardExpiresAt === before.hardExpiresAt
      && currentClassroomState.restrictions.flightPath.active, 'bare stop changed non-Focus policy lifetime/revision');
    await applyClassroomStateFromAuthResponse({ ...envelope(stopRevision), classroomState: null, focusCleanup: cleanup }, 'duplicate cleanup', { authContext: auth });
    negotiate();
    snapshot = await exact();
    const b = target(snapshot.localEntries.find(entry => entry.tabId === second.id), snapshot.revision, 'focus-B');
    await install(state(b)); await wait(() => focusStatus.state === 'active', 'replacement B failed');
    const bRecord = focusAssignment;
    let lateRejected = false;
    try { await applyBareFocusCleanup(cleanup.command, cleanup, auth); } catch { lateRejected = true; }
    require(lateRejected && focusAssignment === bRecord, 'late cleanup A cleared B');
    await retireFocusTabReference(first.id, aRecord, auth);
    require(focusAssignment === bRecord, 'late removal A cleared B');
    // Replacement retires the original ref even without onRemoved, and
    // never copies it to the added Chrome ID.
    focusBrowserEvent(second.id, true);
    await wait(() => focusStatus.state === 'invalidated', 'replacement did not invalidate original Focus');
    require(focusStatus.reason === 'focus_tab_closed' && retiredFocusTabRefs.has(b.tabRef), 'replacement did not retire exact reference');
    snapshot = await exact();
    require(snapshot.localEntries.find(entry => entry.tabId === second.id)?.tabRef !== b.tabRef, 'retired replacement reference was reused');
    // Bring Forward is verified once; switching away does not start Focus.
    const activationTarget = snapshot.localEntries.find(entry => entry.tabId === first.id);
    const activate = { type: 'activate-tab', teachingSessionId: 'focus-class', data: { tabRef: activationTarget.tabRef, observedRevision: snapshot.revision } };
    const activation = await executeRemoteControlCommand(activate, { authContext: auth, envelope: envelope(currentStudentControlRevision()), binding: exactStudentBinding(envelope(currentStudentControlRevision())), exactFocusTarget: activate.data });
    require(activation.status === 'activated' && !focusAssignment, 'Bring Forward started persistent Focus');
    await chrome.tabs.update(second.id, { active: true }); await new Promise(done => setTimeout(done, 2100));
    require((await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id === second.id, 'Bring Forward repeated activation');
    // A delivered authentication popup suspends Focus without stealing its
    // window; closing it resumes only the original still-allowed tab.
    snapshot = await exact();
    const authFocus = target(snapshot.localEntries.find(entry => entry.tabId === first.id), snapshot.revision, 'focus-authentication');
    const authState = state(authFocus);
    authState.authPassThroughPolicyRevision = 1;
    authState.authPassThrough = { schemaVersion: 1, policyRevision: 1, defaultProfileId: 'google', attemptTtlSeconds: 300,
      profiles: [{ id: 'google', name: 'Google', startUrl: 'https://accounts.google.com/signin',
        hostRules: [{ hostname: 'accounts.google.com', includeSubdomains: false }] }] };
    await install(authState); await wait(() => focusStatus.state === 'active', 'auth Focus failed to adopt');
    const popup = await chrome.windows.create({ url: 'https://accounts.google.com/signin', type: 'popup', focused: true });
    await wait(() => focusStatus.reason === 'authentication', 'approved auth popup did not suspend Focus');
    await new Promise(done => setTimeout(done, 2100));
    require((await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.windowId === popup.id, 'Focus stole authentication popup');
    // Isolate the native onRemoved hook: window/activation events can precede
    // completed popup removal and must not be the only resume opportunity.
    const browserEvent = focusBrowserEvent;
    focusBrowserEvent = (tabId, retired, updated) => { if (retired) browserEvent(tabId, retired, updated); };
    try {
      await chrome.windows.remove(popup.id);
      await chrome.windows.update(first.windowId, { focused: true });
      await wait(() => focusStatus.state === 'active', 'auth completion did not resume original Focus');
      require(focusAssignment.assignmentId === authFocus.assignmentId, 'auth completion replaced original Focus');
    } finally { focusBrowserEvent = browserEvent; }
    // A timed-out native operation stays suspended. Its delayed callback
    // cannot publish A against replacement B or retire B's record.
    const nativeUpdate = chrome.tabs.update.bind(chrome.tabs);
    let releaseOldActivation;
    let held = false;
    let heldCalls = 0;
    let oldSettled = 0;
    let activationGate;
    chrome.tabs.update = async (id, options) => {
      let heldThisCall = false;
      if (id === first.id && options.active === true) {
        held = true; heldThisCall = true; heldCalls++;
        if (!activationGate) activationGate = new Promise(done => { releaseOldActivation = done; });
        await activationGate;
      }
      const updated = await nativeUpdate(id, options);
      if (heldThisCall) oldSettled++;
      return updated;
    };
    await chrome.tabs.update(second.id, { active: true });
    await wait(() => held, 'Focus native operation was not held');
    await wait(() => focusStatus.reason === 'browser_operation_pending', 'timed-out operation claimed active');
    snapshot = await exact();
    const replacement = target(snapshot.localEntries.find(entry => entry.tabId === second.id), snapshot.revision, 'focus-after-timeout');
    await install(state(replacement)); await wait(() => focusStatus.state === 'active', 'replacement after timeout failed');
    const replacementRecord = focusAssignment;
    const ackStart = acks.length;
    releaseOldActivation(); chrome.tabs.update = nativeUpdate;
    await wait(() => oldSettled === heldCalls, 'late A native callbacks did not settle');
    await wait(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id === second.id, 'late A native callback displaced B permanently');
    require(focusAssignment === replacementRecord && !acks.slice(ackStart).some(ack => ack.focusStatus?.assignmentId === authFocus.assignmentId), 'late callback relabeled/retired replacement B');
    // A real activation event during the final exact-tab lookup must survive
    // its coalescing timer firing while the same assignment is still running.
    const nativeGet = chrome.tabs.get.bind(chrome.tabs);
    let releaseFinalLookup;
    let lookupCount = 0;
    let finalLookupHeld = false;
    chrome.tabs.get = async id => {
      const found = await nativeGet(id);
      if (id === second.id && ++lookupCount === 2) {
        finalLookupHeld = true;
        await new Promise(done => { releaseFinalLookup = done; });
      }
      return found;
    };
    queueFocusMaintenance();
    await wait(() => finalLookupHeld, 'same-assignment final native lookup was not held');
    const eventsBeforeSwitch = focusMaintenanceEvents;
    await chrome.tabs.update(first.id, { active: true });
    await wait(() => focusMaintenanceEvents > eventsBeforeSwitch && focusMaintenanceRunning && focusMaintenanceTimer === null,
      'native activation event timer did not fire during held lookup', 2500);
    releaseFinalLookup(); chrome.tabs.get = nativeGet;
    await wait(async () => (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0]?.id === second.id,
      'same-assignment event was lost after in-flight maintenance');
    require(focusAssignment === replacementRecord, 'same-assignment upkeep changed identity');
    // Native precise same-tab history changes preserve exact identity while
    // allowed, then a forbidden SPA navigation retires only Focus.
    await install(state({ active: false }, { flightPath: { active: false, allowedDomains: [] } }));
    const documentUrl = 'https://docs.google.com/document/d/SyntheticFocusDocument0123456789/edit';
    const doc = await chrome.tabs.create({ url: documentUrl, active: true });
    await wait(async () => Boolean((await chrome.tabs.get(doc.id)).url?.startsWith('https://docs.google.com/')), 'native document did not settle');
    snapshot = await exact();
    const docFocus = target(snapshot.localEntries.find(entry => entry.tabId === doc.id), snapshot.revision, 'focus-precise-document');
    const resource = { type: 'resource', hostname: 'docs.google.com', includeSubdomains: false,
      ...RuntimeCore.extractRestrictionResourceIdentity(documentUrl), canonicalUrl: documentUrl };
    require(resource?.provider === 'google_docs', 'precise document fixture invalid');
    const precise = state(docFocus, { flightPath: { active: true, allowedDomains: [], resources: [resource] } });
    await install(precise); await wait(() => focusStatus.state === 'active', 'precise Focus did not activate');
    // Native tab creation can beat Playwright's page attachment on its first
    // navigation. Navigate the already attached tab to routed fixture HTML.
    await chrome.tabs.update(doc.id, { url: `${documentUrl}?native-fixture=1` });
    await wait(async () => (await chrome.tabs.get(doc.id)).status === 'complete', 'precise fixture page did not complete');
    await new Promise(done => setTimeout(done, 250));
    await chrome.scripting.executeScript({ target: { tabId: doc.id }, world: 'MAIN', func: url => history.pushState({}, '', url), args: [`${documentUrl}?allowed=1`] });
    await new Promise(done => setTimeout(done, 2100));
    require(focusAssignment?.assignmentId === docFocus.assignmentId && focusAssignment.tabId === doc.id, 'allowed SPA navigation changed Focus identity');
    await chrome.scripting.executeScript({ target: { tabId: doc.id }, world: 'MAIN', func: () => history.back() });
    await new Promise(done => setTimeout(done, 2100));
    require(focusAssignment?.assignmentId === docFocus.assignmentId, 'native back navigation retired allowed Focus');
    await chrome.scripting.executeScript({ target: { tabId: doc.id }, world: 'MAIN', func: url => history.replaceState({}, '', url),
      args: ['https://docs.google.com/document/d/ForbiddenFocusDocument0123456789/edit'] });
    await wait(() => focusStatus.state === 'invalidated' && focusStatus.reason === 'focus_tab_off_policy', 'forbidden SPA did not retire exact Focus');
    require(currentClassroomState.restrictions.flightPath.resources[0].resourceId === resource.resourceId, 'Focus invalidation cleared precise policy');
    await install(state());
    // The exact 21st+ successful open receipt is private, independently of
    // the bounded public dashboard snapshot.
    const currentHttp = (await chrome.tabs.query({})).filter(tab => isHttpUrl(tab.url));
    for (let index = currentHttp.length; index < 21; index++) await chrome.tabs.create({ url: `https://example.test/filler-${index}`, active: false });
    const receipt = await executeRemoteControlCommand({ type: 'open-tab', teachingSessionId: 'focus-class', data: { url: 'https://example.test/private-open' } },
      { authContext: auth, envelope: envelope(currentStudentControlRevision()), binding: exactStudentBinding(envelope(currentStudentControlRevision())) });
    require(JSON.stringify(Object.keys(receipt).sort()) === JSON.stringify(['tabReceiptVersion', 'tabRef', 'tabSnapshotRevision'].sort()), 'open receipt is not strict/honest');
    snapshot = await exact();
    require(!snapshot.tabs.some(tab => tab.tabRef === receipt.tabRef), 'private 21st receipt leaked into capped public snapshot');
    const privateFocus = target(receipt, receipt.tabSnapshotRevision, 'private-open-focus', 'open_receipt');
    await install(state(privateFocus)); await wait(() => focusStatus.state === 'active', 'private receipt Focus failed');
    const privateId = focusAssignment.tabId;
    require((await chrome.tabs.get(privateId)).url === 'https://example.test/private-open', 'receipt selected a URL substitute');
    // A cold in-memory restore uses the protected session record, never URL.
    pauseTimer();
    const persisted = persistedClassroomStateSnapshot(currentClassroomState);
    require(persisted.schemaVersion === 3 && persisted.focusPersistenceVersion === 1, 'Focus downgrade fence missing');
    focusAssignment = null; focusStatus = { state: 'inactive' };
    await commitFocusAssignment(await prepareFocusAssignment(RuntimeCore.normalizePersistedClassroomState(persisted), auth, null, true), currentClassroomState, auth);
    await wait(() => focusStatus.state === 'active', 'protected session mapping did not restore');
    require(focusAssignment.tabId === privateId, 'cold restore changed exact target');
    pauseTimer();
    await durableSessionKv.remove(FOCUS_ASSIGNMENT_KEY); focusAssignment = null; focusStatus = { state: 'inactive' };
    let sessionLost = false;
    try { await prepareFocusAssignment(RuntimeCore.normalizePersistedClassroomState(persisted), auth, null, true); } catch (error) { sessionLost = error.code === 'STALE_TAB_REF'; }
    require(sessionLost, 'browser-session loss repaired Focus by URL');
    // Canonical authority loss retires the immutable assignment. Returning
    // to the same class must not resurrect that retired assignment.
    snapshot = await exact();
    const authorityFocus = target(snapshot.localEntries.find(entry => entry.tabId === first.id), snapshot.revision, 'focus-authority');
    await install(state(authorityFocus)); await wait(() => focusStatus.state === 'active', 'authority Focus adoption failed');
    const authorityRecord = focusAssignment;
    currentFabState = { teachingSessionId: 'replacement-class', activeSessionIds: ['replacement-class'] };
    currentClassroomState = { ...currentClassroomState, teachingSessionId: 'replacement-class' };
    await enqueueStudentAuthMutation(() => enqueueClassroomStateOperation(() => maintainFocus(authorityRecord, auth)));
    require(!focusAssignment && focusStatus.state === 'inactive', 'authority loss retained active Focus');
    currentFabState = { teachingSessionId: 'focus-class', activeSessionIds: ['focus-class'] };
    let retiredAuthority = false;
    try { await install(state(authorityFocus)); } catch (error) { retiredAuthority = error.code === 'STALE_TAB_REF'; }
    require(retiredAuthority, 'returning authority resurrected retired Focus');
    snapshot = await exact();
    const expiringFocus = target(snapshot.localEntries.find(entry => entry.tabId === first.id), snapshot.revision, 'focus-expiry');
    const expiringState = state(expiringFocus); expiringState.hardExpiresAt = Date.now() + 5000;
    await install(expiringState); await wait(() => focusStatus.state === 'active', 'expiring Focus adoption failed');
    pauseTimer();
    await new Promise(done => setTimeout(done, Math.max(0, expiringState.hardExpiresAt - Date.now()) + 25));
    await enqueueStudentAuthMutation(() => enqueueClassroomStateOperation(() => expireClassroomState('hard_expiry', {
      authContext: auth, authorityEnvelope: envelope(currentStudentControlRevision()) })));
    require(!focusAssignment && focusStatus.state === 'inactive' && !currentClassroomState.restrictions.focus?.active,
      'original policy expiry retained/restored Focus');
    // Entitlement denial cannot leave an active heartbeat projection.
    snapshot = await exact();
    const c = target(snapshot.localEntries.find(entry => entry.tabId === first.id), snapshot.revision, 'focus-C');
    await install(state(c)); await wait(() => focusStatus.state === 'active', 'C adoption failed');
    adoptLicenseState(false, 'denied', auth);
    require(focusStatus.state === 'inactive', 'entitlement loss left active status');
    await wait(() => !focusAssignment, 'entitlement loss retained assignment');
    adoptLicenseState(true, 'active', auth);
    await clearTeacherSessionStateForSignOut({ emitEvent: false, reason: 'Focus fixture sign-out' });
    require(!(await durableSessionKv.get([FOCUS_REFS_KEY, FOCUS_ASSIGNMENT_KEY]))[FOCUS_REFS_KEY], 'sign-out retained receipt mappings');
    require(!focusAssignment && focusStatus.state === 'inactive', 'sign-out retained Focus');
    return { exactDuplicates: true, persistentAcrossSnapshots: true, honestPendingAck: true, attention: true,
      capabilityWithdrawalAndBareStop: true, lateCleanupAndReplacement: true, transientBringForward: true,
      approvedAuthPopup: true, timedOutAndLateNativeActivation: true, inFlightSameAssignmentEvent: true, nativePreciseSpaAndBack: true,
      private21stReceipt: true, protectedRestoreAndSessionLoss: true, canonicalCommandAck: true,
      authorityLossAndExpiry: true, entitlementAndSignOut: true, acknowledgements: acks.length };
  });
  console.log('Native Focus/Bring Forward Chrome checks passed:', JSON.stringify(result));
} finally {
  if (browser) await browser.close();
  rmSync(profile, { recursive: true, force: true });
}
