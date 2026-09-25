import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'node:http';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requestedExtension = String(process.env.CLASSPILOT_EXTENSION_PATH || '').trim()
  ? resolve(process.env.CLASSPILOT_EXTENSION_PATH) : resolve(root, 'extension');
const extension = requestedExtension;
const profile = await mkdtemp(join(tmpdir(), 'classpilot-scheduled-context-'));
let browser;
let server;
try {
  browser = await chromium.launchPersistentContext(profile, { executablePath: process.env.CLASSPILOT_CHROME_PATH || chromium.executablePath(), headless: true,
    args: ['--headless=new', '--enable-automation', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const launchSession = await browser.newCDPSession(browser.pages()[0] || await browser.newPage());
  try {
    const { arguments: launchArguments } = await launchSession.send('Browser.getBrowserCommandLine');
    for (const flag of ['--load-extension', '--disable-extensions-except']) {
      assert.ok(launchArguments.includes(`${flag}=${requestedExtension}`), `Chrome must launch ${flag} from the requested extension directory`);
    }
  } finally {
    await launchSession.detach();
  }
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
  const requestedManifest = JSON.parse(await readFile(resolve(requestedExtension, 'manifest.json'), 'utf8'));
  const loadedVersion = await worker.evaluate(() => chrome.runtime.getManifest().version);
  assert.equal(loadedVersion, requestedManifest.version, 'Chrome must load the requested extension manifest');
  console.log(`Scheduled classroom Chrome loaded ${requestedExtension} (version ${loadedVersion}).`);
  const result = await worker.evaluate(async () => {
    await Promise.all([authStateRestorePromise, classroomStateRestorePromise]);
    await studentAuthMutationTail;
    scheduleHeartbeat(null);
    sendHeartbeat = async () => {};
    connectWebSocket = async () => {};
    wsSend = async () => true;
    advanceStudentAuthMutationGeneration();
    Object.assign(CONFIG, { serverUrl: 'http://127.0.0.1:49177', schoolId: 'school-fixture', deviceId: 'device-fixture',
      activeStudentId: 'student-fixture', activeStudentSessionId: 'login-fixture', studentToken: 'fixture-only',
      studentEmail: 'fixture@example.test', identitySource: 'integration_test' });
    studentAuthInvalidating = false;
    studentAuthCommitPending = false;
    activateAuthenticatedContext(generateAuthContextId());
    const auth = captureAuthenticatedContext('scheduled fixture');
    licenseActive = true;
    trackingState = TRACKING_STATES.ACTIVE;
    adoptLicenseState(true, 'active', auth);
    schoolSettings = { enableTrackingHours: false, afterHoursMode: 'off' };
    schoolSettingsScope = schoolPolicyScopeForAuthContext(auth);
    schoolSettingsFetchedAt = Date.now();
    const capabilities = ['scopedAuthorityChecksV1', 'scheduledClassroomV1', 'studentChatIdempotencyV1', 'screenshotTrackingWindowLeaseV1', 'screenshotActiveObservationCadenceV1'];
    adoptNegotiatedProtocolState({ serverProtocolVersion: 3, acceptedCapabilities: capabilities }, auth);
    const sent = [];
    globalThis.__scheduledContextSent = sent;
    fetchWithBackoff = async (url, init = {}) => {
      sent.push({ url: String(url), body: JSON.parse(init.body || '{}') });
      return new Response(JSON.stringify({ success: true, status: 'delivered' }), { status: 200 });
    };
    const end = Date.now() + 60_000;
    const state = (id, revision) => RuntimeCore.normalizeClassroomState({ schemaVersion: 1, revision,
      supervisionContextId: id, hardExpiresAt: end, scheduledEndAt: end, restrictions: {} });
    const fab = (id, revision) => ({ schemaVersion: 1, revision: 1, ownershipRevision: revision, teachingSessionId: null,
      contextAuthorityRevision: '0',
      supervisionContextId: id, activeSessionIds: [], activeContexts: [{ supervisionContextId: id }],
      contextSource: 'scheduled_testing', contextName: 'Scheduled MAP', messagingEnabled: true, handRaisingEnabled: true });
    currentClassroomState = state('testing-a', 41);
    observeStudentControlRevision(41, auth, 'fixture');
    await applyFabSettings({ ownershipRevision: 41, teachingSessionId: null, activeSessionIds: [], activeContexts: [],
      messagingEnabled: false, handRaisingEnabled: false, supervisionContext: { id: 'testing-a' } }, { authContext: auth });
    await applyFabSettings(fab('testing-a', 41), { authContext: auth });
    const action = captureStudentActionRequest({ studentMessageContext: studentMessageContextFor(auth), fabBinding: fabIdentityBinding(),
      supervisionContextId: 'testing-a', studentControlRevision: 41 });
    const contextBefore = activeClassroomContexts();
    const chat = await queueAndSendStudentChatMessage({ clientMessageId: crypto.randomUUID(), message: 'Testing question',
      supervisionContextId: 'testing-a', studentControlRevision: 41 }, auth);
    const timer = await persistTimerOverlay({ authority: { supervisionContextId: 'testing-a' }, data: { action: 'start', seconds: 600 } }, { authContext: auth });
    const poll = await persistPollOverlay({ authority: { supervisionContextId: 'testing-a' }, data: { action: 'start', pollId: 'poll-a', question: 'Ready?', options: ['Yes', 'No'], expiresAt: end + 100_000 } }, { authContext: auth });
    const restored = await getRestorableClassroomOverlayState({ authContext: auth, expectedBinding: fabIdentityBinding() });
    const screenshot = normalizeScreenshotAuthority({ kind: 'supervision_context', supervisionContextId: 'testing-a', controlRevision: 41 });
    const screenshotCurrent = screenshotTrackingAuthorityMatchesCurrentState(screenshot);
    const liveCurrent = liveViewClassroomAuthorityCurrent({ supervisionContextId: 'testing-a', controlRevision: 41 });
    const refreshHintCurrent = classroomStateContextIsCurrent({ supervisionContextId: 'testing-a' });
    const refreshHintWrongContext = classroomStateContextIsCurrent({ supervisionContextId: 'another-context' });
    const liveMissingRevisionRejected = !liveViewClassroomAuthorityCurrent({ supervisionContextId: 'testing-a' });
    const mixedRejected = !normalizeScreenshotAuthority({ kind: 'supervision_context', supervisionContextId: 'testing-a', teachingSessionId: 'testing-a', controlRevision: 41 });
    currentClassroomState = state('testing-b', 42);
    observeStudentControlRevision(42, auth, 'fixture handoff');
    await applyFabSettings(fab('testing-b', 42), { authContext: auth });
    await applyFabSettings(fab('testing-a', 41), { authContext: auth });
    let oldActionRejected = false;
    try { assertStudentActionRequestCurrent(action); } catch { oldActionRejected = true; }
    const after = await getRestorableClassroomOverlayState({ authContext: auth, expectedBinding: fabIdentityBinding() });
    const oldScreenshotRejected = !screenshotTrackingAuthorityMatchesCurrentState(screenshot);
    const oldLiveRejected = !liveViewClassroomAuthorityCurrent({ supervisionContextId: 'testing-a', controlRevision: 41 });
    const retained = activeClassroomContexts();
    await enqueueChatAck({ ackId: 'original-supervision-revision', messageId: 'teacher-message-a',
      supervisionContextId: 'testing-a', studentControlRevision: 41, deliveryStatus: 'delivered' }, auth);
    const storedAck = (await durableLocalKv.get(CHAT_ACK_OUTBOX_KEY))[CHAT_ACK_OUTBOX_KEY]
      .find(ack => ack.ackId === 'original-supervision-revision');
    const staleRevisionLiveRejected = !liveViewClassroomAuthorityCurrent({ supervisionContextId: 'testing-b', controlRevision: 41 });
    const staleTeacherMessageRejected = !messageMatchesActiveFabSession({ supervisionContextId: 'testing-b', studentControlRevision: 41 });
    const missingTeacherRevisionRejected = !messageMatchesActiveFabSession({ supervisionContextId: 'testing-b' });
    const currentTeacherMessageAccepted = messageMatchesActiveFabSession({ supervisionContextId: 'testing-b', studentControlRevision: 42 });
    currentClassroomState.scheduledEndAt = Date.now() - 1;
    const expired = activeClassroomContexts().length === 0 && !liveViewClassroomAuthorityCurrent({ supervisionContextId: 'testing-b', controlRevision: 42 });
    currentClassroomState = state('testing-b', 42);
    adoptNegotiatedProtocolState({ serverProtocolVersion: 3, acceptedCapabilities: ['scopedAuthorityChecksV1'] }, auth);
    const legacy = normalizeFabState(fab('testing-b', 42));
    const legacyScreenshotRejected = !normalizeScreenshotAuthority({ kind: 'supervision_context', supervisionContextId: 'testing-b', controlRevision: 42 });
    return { contextBefore, chat, sent, timer: timer.timer, poll: poll.poll, restored,
      screenshotCurrent, liveCurrent, refreshHintCurrent, refreshHintWrongContext, liveMissingRevisionRejected,
      mixedRejected, oldActionRejected, oldScreenshotRejected, oldLiveRejected,
      retained, after, expired, legacy, legacyScreenshotRejected, storedAck, staleRevisionLiveRejected,
      staleTeacherMessageRejected, missingTeacherRevisionRejected, currentTeacherMessageAccepted };
  });
  assert.deepEqual(result.contextBefore, [{ supervisionContextId: 'testing-a' }]);
  assert.equal(result.sent.length, 1);
  assert.equal(result.sent[0].body.supervisionContextId, 'testing-a');
  assert.equal(result.sent[0].body.studentControlRevision, 41);
  assert.equal(result.sent[0].body.teachingSessionId, undefined);
  assert.equal(result.timer.supervisionContextId, 'testing-a');
  assert.equal(result.refreshHintCurrent, true);
  assert.equal(result.refreshHintWrongContext, false);
  assert.equal(result.liveMissingRevisionRejected, true);
  assert.equal(result.poll.supervisionContextId, 'testing-a');
  assert.equal(result.timer.endsAt, result.poll.expiresAt, 'Both overlays stop at the scheduled boundary');
  assert.equal(result.restored.poll.pollId, 'poll-a');
  for (const key of ['screenshotCurrent', 'liveCurrent', 'mixedRejected', 'oldActionRejected', 'oldScreenshotRejected', 'oldLiveRejected', 'expired', 'legacyScreenshotRejected']) assert.equal(result[key], true, key);
  assert.equal(result.storedAck.supervisionContextId, 'testing-a');
  assert.equal(result.storedAck.studentControlRevision, 41);
  assert.equal(result.staleRevisionLiveRejected, true);
  assert.equal(result.staleTeacherMessageRejected, true);
  assert.equal(result.missingTeacherRevisionRejected, true);
  assert.equal(result.currentTeacherMessageAccepted, true);
  assert.deepEqual(result.retained, [{ supervisionContextId: 'testing-b' }]);
  assert.deepEqual(result.after, { timer: null, poll: null });
  assert.equal(result.legacy.messagingEnabled, false);
  assert.equal(result.legacy.handRaisingEnabled, false);
  assert.deepEqual(result.legacy.activeContexts, []);
  const binding = await worker.evaluate(async () => {
    const auth = captureAuthenticatedContext('popup scheduled fixture');
    adoptNegotiatedProtocolState({ serverProtocolVersion: 3, acceptedCapabilities: ['scopedAuthorityChecksV1', 'scheduledClassroomV1', 'studentChatIdempotencyV1'] }, auth);
    currentClassroomState = RuntimeCore.normalizeClassroomState({ schemaVersion: 1, revision: 43, supervisionContextId: 'testing-c', hardExpiresAt: Date.now() + 60_000, restrictions: {} });
    observeStudentControlRevision(43, auth, 'popup fixture');
    await applyFabSettings({ revision: 1, ownershipRevision: 43, teachingSessionId: null, supervisionContextId: 'testing-c', activeSessionIds: [],
      contextAuthorityRevision: '0',
      activeContexts: [{ supervisionContextId: 'testing-c' }], contextSource: 'scheduled_testing', messagingEnabled: true, handRaisingEnabled: true }, { authContext: auth });
    await persistPollOverlay({ authority: { supervisionContextId: 'testing-c' }, data: { action: 'start', pollId: 'poll-c', question: 'Ready?', options: ['Yes', 'No'] } }, { authContext: auth });
    return { studentMessageContext: studentMessageContextFor(auth), fabBinding: fabIdentityBinding() };
  });
  const popup = await browser.newPage();
  const extensionId = new URL(worker.url()).host;
  await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  const popupResult = await popup.evaluate(async () => {
    const context = await capturePopupStudentActionContext();
    const payload = popupStudentActionPayload(context);
    return { payload, current: await popupStudentActionContextIsCurrent(context),
      hand: await requestServiceWorker({ type: 'raise-hand', ...payload }),
      lower: await requestServiceWorker({ type: 'lower-hand', ...payload }),
      poll: await requestServiceWorker({ type: 'poll-response', pollId: 'poll-c', selectedOption: 0, ...payload }) };
  });
  assert.equal(popupResult.current, true);
  assert.equal(popupResult.payload.supervisionContextId, 'testing-c');
  assert.equal(popupResult.payload.studentControlRevision, 43);
  for (const key of ['hand', 'lower', 'poll']) assert.equal(popupResult[key].success, true, key);
  const actionBodies = await worker.evaluate(() => globalThis.__scheduledContextSent.filter(request => /raise-hand|lower-hand|respond/.test(request.url)).map(request => request.body));
  assert.equal(actionBodies.length, 3);
  for (const body of actionBodies) { assert.equal(body.supervisionContextId, 'testing-c'); assert.equal(body.studentControlRevision, 43); assert.equal(body.teachingSessionId, undefined); }
  server = createServer((_request, response) => { response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><html><body>Scheduled classroom fixture</body></html>'); });
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  await worker.evaluate(async () => {
    const auth = captureAuthenticatedContext('content poll fixture');
    await persistPollOverlay({ authority: { supervisionContextId: 'testing-c' }, data: { action: 'start', pollId: 'rendered-supervision-poll', question: 'Ready for testing?', options: ['Yes', 'No'] } }, { authContext: auth });
  });
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.locator('#classpilot-poll-overlay').waitFor({ state: 'visible' });
  await page.locator('#classpilot-poll-overlay .classpilot-poll-option').first().click();
  await page.locator('.classpilot-poll-thanks').waitFor({ state: 'visible' });
  const contentPoll = await worker.evaluate(() => globalThis.__scheduledContextSent.find(request => request.url.includes('/polls/rendered-supervision-poll/respond')));
  assert.equal(contentPoll.body.supervisionContextId, 'testing-c');
  assert.equal(contentPoll.body.studentControlRevision, 43);
  assert.equal(contentPoll.body.teachingSessionId, undefined);
  const contentAuthority = await worker.evaluate(async () => {
    const auth = captureAuthenticatedContext('content revision fixture');
    const tab = (await chrome.tabs.query({})).find(value => value.url?.startsWith('http://127.0.0.1:'));
    const message = { type: 'chat-reply', studentMessageContext: studentMessageContextFor(auth),
      data: { supervisionContextId: 'testing-c', studentControlRevision: 42, message: 'Old owner message' } };
    const stale = await chrome.tabs.sendMessage(tab.id, message);
    const current = await chrome.tabs.sendMessage(tab.id, { ...message,
      data: { ...message.data, studentControlRevision: 43, message: 'Current owner message' } });
    return { stale, current };
  });
  assert.equal(contentAuthority.stale.ignored, true, 'Content rejects a same-context stale delivery after worker validation');
  assert.equal(contentAuthority.current.success, true);
  const commands = await worker.evaluate(async () => {
    const auth = captureAuthenticatedContext('scheduled command revision fixture');
    const acks = [];
    scheduleCommandAckFlush = () => {};
    wsSend = async message => { if (message.type === 'command-ack') acks.push(message); return true; };
    const invoke = (type, revision, suffix, data = {}) => {
      const command = { type, authority: { supervisionContextId: 'testing-c' }, data };
      return handleRemoteControl(command, { type: 'remote-control', commandId: `scheduled-${type}-${suffix}`,
        studentId: auth.studentId, studentSessionId: auth.studentSessionId,
        ...(revision === undefined ? {} : { studentControlRevision: revision }), command,
        deliveryPolicy: 'transient_action', expiresAt: new Date(Date.now() + 30_000).toISOString() });
    };
    const before = await getRestorableClassroomOverlayState({ authContext: auth, expectedBinding: fabIdentityBinding() });
    const rejected = [];
    for (const type of ['timer', 'poll', 'student-sign-out', 'hand-dismissed']) {
      for (const revision of [undefined, 42]) {
        rejected.push(await invoke(type, revision, revision ?? 'missing', { action: 'start', seconds: 25,
          pollId: 'must-not-start', question: 'Stale?', options: ['Yes', 'No'] }));
      }
    }
    const after = await getRestorableClassroomOverlayState({ authContext: auth, expectedBinding: fabIdentityBinding() });
    const valid = await invoke('timer', 43, 'valid', { action: 'start', seconds: 25 });
    const appliedTimer = await getRestorableClassroomOverlayState({ authContext: auth, expectedBinding: fabIdentityBinding() });
    wsSend = async message => {
      if (message.type === 'command-ack') {
        acks.push(message);
        if (message.commandId === 'scheduled-poll-race' && message.ackState === 'received') {
          currentClassroomState = { ...currentClassroomState, revision: 44 };
          observeStudentControlRevision(44, auth, 'same-context ownership change during receipt');
        }
      }
      return true;
    };
    const raced = await invoke('poll', 43, 'race', { action: 'start', pollId: 'must-not-race',
      question: 'Old owner?', options: ['Yes', 'No'] });
    const afterRace = await getRestorableClassroomOverlayState({ authContext: auth, expectedBinding: fabIdentityBinding() });
    const persistedAcks = (await durableLocalKv.get(COMMAND_ACK_OUTBOX_KEY))[COMMAND_ACK_OUTBOX_KEY];
    await applyFabSettings({ ...currentFabState, ownershipRevision: 44, contextAuthorityRevision: '0' }, { authContext: auth });
    const afterRestriction = await getRestorableClassroomOverlayState({ authContext: auth, expectedBinding: fabIdentityBinding() });
    const originalSet = kv.set;
    let writeRaced;
    kv.set = async values => {
      await originalSet.call(kv, values);
      if (values[CLASSROOM_OVERLAY_STORAGE_KEY]?.timer?.commandId === 'scheduled-timer-write-race') {
        currentClassroomState = { ...currentClassroomState, revision: 45 };
        observeStudentControlRevision(45, auth, 'ownership changes during overlay persistence');
      }
    };
    try { writeRaced = await invoke('timer', 44, 'write-race', { action: 'start', seconds: 59 }); }
    finally { kv.set = originalSet; }
    currentClassroomState = { ...currentClassroomState, revision: 45, hardExpiresAt: Date.now() + 120_000 };
    observeStudentControlRevision(45, auth, 'scheduled end extension');
    await applyFabSettings({ ...currentFabState, ownershipRevision: 45, contextAuthorityRevision: '0' }, { authContext: auth });
    const afterExtension = await getRestorableClassroomOverlayState({ authContext: auth, expectedBinding: fabIdentityBinding() });
    currentClassroomState = { ...currentClassroomState, revision: 46 };
    observeStudentControlRevision(46, auth, 'scheduled staff reassignment');
    await applyFabSettings({ ...currentFabState, ownershipRevision: 46, contextAuthorityRevision: '1' }, { authContext: auth });
    const afterReassignment = await getRestorableClassroomOverlayState({ authContext: auth, expectedBinding: fabIdentityBinding() });
    return { before, after, rejected, valid, appliedTimer, raced, afterRace, acks, persistedAcks,
      afterRestriction, afterExtension, afterReassignment, writeRaced,
      stillSignedIn: CONFIG.activeStudentId === auth.studentId };
  });
  assert.equal(commands.rejected.length, 8);
  for (const command of commands.rejected) assert.equal(command.rejected, true);
  assert.equal(commands.stillSignedIn, true, 'Stale sign-out cannot clear the current login');
  assert.deepEqual(commands.after, commands.before, 'Stale or unbound commands cannot replace overlays');
  assert.notEqual(commands.valid.rejected, true);
  assert.equal(commands.appliedTimer.timer.supervisionContextId, 'testing-c');
  assert.equal(commands.raced.rejected, true, 'A receipt-time ownership change prevents execution');
  assert.notEqual(commands.afterRace.poll?.pollId, 'must-not-race');
  assert.deepEqual(commands.afterRestriction, commands.appliedTimer, 'Ordinary restriction revision and temporary FAB lag preserve applied overlays');
  assert.equal(commands.writeRaced.rejected, true, 'A revision change during storage rejects and rolls back an unbroadcast overlay');
  assert.deepEqual(commands.afterExtension, commands.appliedTimer, 'Extending the context preserves applied overlays and original deadlines');
  assert.deepEqual(commands.afterReassignment, { timer: null, poll: null }, 'New assigned staff retires old applied overlays');
  assert.equal(commands.acks.some(ack => ack.commandId.endsWith('-missing')), false);
  for (const type of ['timer', 'poll', 'student-sign-out', 'hand-dismissed']) {
    const ack = commands.acks.find(item => item.commandId === `scheduled-${type}-42`);
    assert.equal(ack.ackState, 'failed');
    assert.equal(ack.studentControlRevision, 42);
  }
  for (const [collection, expectedStates] of [[commands.acks, ['failed', 'received']], [commands.persistedAcks, ['failed']]]) {
    const racedAcks = collection.filter(ack => ack.commandId === 'scheduled-poll-race');
    assert.deepEqual(racedAcks.map(ack => ack.ackState).sort(), expectedStates);
    for (const ack of racedAcks) assert.equal(ack.studentControlRevision, 43, 'ACK retains the original owner revision');
  }
  console.log('Scheduled classroom Chrome parity and handoff checks passed.');
} finally {
  if (browser) await browser.close();
  if (server) await new Promise(resolveClose => server.close(resolveClose));
  // The temporary profile was created directly beneath the OS temp directory.
  if (!resolve(profile).startsWith(resolve(tmpdir()) + '\\') && !resolve(profile).startsWith(resolve(tmpdir()) + '/')) throw new Error('Unexpected profile path');
  await rm(profile, { recursive: true, force: true });
}
