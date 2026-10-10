import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'node:http';
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
import { waitForExtensionWorkerDeclarations } from './extension-worker-test-readiness.mjs';

const extension = resolve(process.env.CLASSPILOT_EXTENSION_PATH || fileURLToPath(new URL('../extension', import.meta.url)));
// Captured from SchoolPilot's real canonical replay query + production frame
// builder. The optional path allows the server lane to regenerate this contract.
const contractPath = process.env.CLASSPILOT_REPLAY_FRAME_FIXTURE
  || fileURLToPath(new URL('./fixtures/schoolpilot-poll-replay-contract.json', import.meta.url));
const contractFrames = JSON.parse(await readFile(contractPath, 'utf8'));
const profile = await mkdtemp(join(tmpdir(), 'classpilot-poll-replay-'));
let browser, server;
try {
  browser = await chromium.launchPersistentContext(profile, {
    executablePath: process.env.CLASSPILOT_CHROME_PATH || chromium.executablePath(), headless: true,
    args: ['--headless=new', '--enable-automation', '--no-proxy-server',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost',
      `--disable-extensions-except=${extension}`, `--load-extension=${extension}`],
  });
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker');
  await waitForExtensionWorkerDeclarations(worker);
  await worker.evaluate(async () => {
    await Promise.all([authStateRestorePromise, classroomStateRestorePromise]);
    await studentAuthMutationTail;
    CONFIG.autoRegistrationPaused = true;
    const deadline = Date.now() + 20_000;
    while (!workerWakeSettled && Date.now() < deadline) await new Promise(done => setTimeout(done, 20));
    if (!workerWakeSettled) throw new Error('Worker wake did not settle');
    if (chromeProfileRegistrationInFlight) await chromeProfileRegistrationInFlight.catch(() => {});
    scheduleHeartbeat(null); sendHeartbeat = async () => {}; connectWebSocket = async () => {};
    recoverOffscreenWebSocketStatus = async () => true;
    if (wsConnectInFlight) await wsConnectInFlight.catch(() => {});
    wsSend = async () => true;
    advanceStudentAuthMutationGeneration();
    Object.assign(CONFIG, { serverUrl: 'http://127.0.0.1:49177', schoolId: 'school-fixture', deviceId: 'device-fixture',
      activeStudentId: 'student-fixture', activeStudentSessionId: 'login-fixture', studentToken: 'fixture-only',
      studentEmail: 'fixture@example.test', identitySource: 'integration_test' });
    studentAuthInvalidating = false; studentAuthCommitPending = false;
    activateAuthenticatedContext(generateAuthContextId());
    const auth = captureAuthenticatedContext('poll fixture');
    licenseActive = true; trackingState = TRACKING_STATES.ACTIVE; adoptLicenseState(true, 'active', auth);
    schoolSettings = { enableTrackingHours: false, afterHoursMode: 'off' };
    schoolSettingsScope = schoolPolicyScopeForAuthContext(auth); schoolSettingsFetchedAt = Date.now();
    await kv.set({ [SCHOOL_SETTINGS_CACHE_KEY]: schoolSettings, [SCHOOL_SETTINGS_SCOPE_KEY]: schoolSettingsScope,
      [SCHOOL_SETTINGS_FETCHED_AT_KEY]: schoolSettingsFetchedAt });
    globalThis.__pollCaps = ['scopedAuthorityChecksV1', 'classroomStateV1', 'pollReplaySafeV1', 'exitTicketsV1'];
    adoptNegotiatedProtocolState({ serverProtocolVersion: 3, acceptedCapabilities: __pollCaps }, auth);
    const end = Date.now() + 300000;
    currentClassroomState = RuntimeCore.normalizeClassroomState({ schemaVersion: 1, revision: 41,
      teachingSessionId: 'class-fixture', hardExpiresAt: end, scheduledEndAt: end, restrictions: {} });
    observeStudentControlRevision(41, auth, 'poll fixture');
    await applyFabSettings({ schemaVersion: 1, revision: 1, ownershipRevision: 41,
      teachingSessionId: 'class-fixture', activeSessionIds: ['class-fixture'],
      messagingEnabled: true, handRaisingEnabled: true }, { authContext: auth });
    globalThis.__pollRequests = []; globalThis.__pollReceipts = []; globalThis.__pollNotifications = 0;
    globalThis.__pollMode = 'offline'; globalThis.__failReceipt = false;
    sendCommandAck = async (_id, state) => {
      const stored = (await kv.get(CLASSROOM_OVERLAY_STORAGE_KEY))[CLASSROOM_OVERLAY_STORAGE_KEY];
      __pollReceipts.push({ state, pollId: stored?.poll?.pollId, order: stored?.poll?.transientOrder });
      if (__failReceipt && state === 'received') { __failReceipt = false; throw new Error('fixture crash before receipt'); }
    };
    notifyTeacherMessageForAuth = async () => { __pollNotifications++; };
    fetchWithBackoff = async (url, init) => {
      if (!String(url).includes('/api/polls/')) return new Response('{}', { status: 200 });
      const body = JSON.parse(init.body);
      const stored = (await kv.get(CLASSROOM_OVERLAY_STORAGE_KEY))[CLASSROOM_OVERLAY_STORAGE_KEY];
      __pollRequests.push({ body, persisted: structuredClone(stored.poll.response) });
      if (__pollMode === 'offline') throw new Error('fixture network unavailable');
      const pollId = decodeURIComponent(new URL(url).pathname.split('/')[3]);
      return new Response(JSON.stringify({ code: 'POLL_ALREADY_ANSWERED', response: {
        pollId, studentId: CONFIG.activeStudentId, selectedOption: body.selectedOption ?? null,
        textResponse: body.textResponse ?? null } }), { status: 409 });
    };
    globalThis.__sendPoll = (order, pollId, action = 'start') => handleRemoteControl({ type: 'poll',
      authority: { teachingSessionId: 'class-fixture' },
      data: { action, pollId, transientOrder: order, question: 'What did you learn?', options: [],
        purpose: 'exit_ticket', responseType: 'short_text', pollExpiresAt: end } }, {
      commandId: `command-${order}`, studentId: CONFIG.activeStudentId, studentSessionId: CONFIG.activeStudentSessionId,
      authority: { teachingSessionId: 'class-fixture' }, deliveryPolicy: 'best_effort',
      expiresAt: new Date(Date.now() + 60000).toISOString() });
    __failReceipt = true;
    await __sendPoll(1, 'poll-a');
  });
  const receipt = await worker.evaluate(() => __pollReceipts[0]);
  assert.equal(receipt.state, 'received');
  assert.equal(receipt.pollId, 'poll-a', 'Safe poll must be durable before its received ACK');
  assert.equal(receipt.order, 1);
  server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<!doctype html><title>Poll fixture</title><body><input id="page-work" value="Keep this work"></body>'); });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.locator('#classpilot-exit-answer').fill('My first saved answer');
  await page.locator('#classpilot-exit-answer').evaluate(node => { node.dataset.preserved = 'yes'; });
  await worker.evaluate(async () => { seenPollIds.clear(); await __sendPoll(1, 'poll-a'); });
  assert.equal(await page.locator('#classpilot-exit-answer').inputValue(), 'My first saved answer');
  assert.equal(await page.locator('#classpilot-exit-answer').getAttribute('data-preserved'), 'yes');
  assert.equal(await worker.evaluate(() => __pollNotifications), 0, 'Crash recovery/duplicates do not notify again');
  await page.locator('#classpilot-exit-submit').click();
  await page.locator('#classpilot-poll-retry').waitFor();
  const first = await worker.evaluate(() => __pollRequests[0]);
  assert.equal(first.persisted.status, 'pending');
  assert.equal(first.persisted.textResponse, 'My first saved answer');
  assert.equal(first.body.textResponse, 'My first saved answer');
  await page.reload();
  await page.locator('#classpilot-poll-retry').waitFor();
  assert.equal(await page.locator('#classpilot-exit-answer').inputValue(), 'My first saved answer');
  assert.equal(await page.locator('#classpilot-exit-answer').getAttribute('readonly'), '');
  const retryAlarm = await worker.evaluate(async () => {
    const auth = captureAuthenticatedContext('delayed retry negotiation fixture');
    adoptNegotiatedProtocolState({ serverProtocolVersion: 3, acceptedCapabilities: __pollCaps.filter(cap => cap !== 'pollReplaySafeV1') }, auth);
    await chrome.alarms.clear(POLL_RESPONSE_RETRY_ALARM);
    await retryPendingPollResponse(auth);
    const alarm = await chrome.alarms.get(POLL_RESPONSE_RETRY_ALARM);
    __pollMode = 'canonical';
    adoptNegotiatedProtocolState({ serverProtocolVersion: 3, acceptedCapabilities: __pollCaps }, auth);
    // Exercise the real alarm callback after negotiation resumes.
    await chrome.alarms.create(POLL_RESPONSE_RETRY_ALARM, { when: Date.now() + 200 });
    return alarm;
  });
  assert.ok(retryAlarm?.scheduledTime > Date.now(), 'Consumed retry alarm re-arms while negotiation is unavailable');
  await page.locator('.classpilot-poll-thanks').waitFor();
  assert.equal(await worker.evaluate(() => __pollRequests.at(-1).body.textResponse), 'My first saved answer');
  const response = await worker.evaluate(async () => (await kv.get(CLASSROOM_OVERLAY_STORAGE_KEY))[CLASSROOM_OVERLAY_STORAGE_KEY].poll.response);
  assert.equal(response.status, 'completed');
  await worker.evaluate(async () => __sendPoll(1, 'poll-a'));
  await page.reload();
  assert.equal(await page.locator('#classpilot-exit-answer').count(), 0, 'Answered replay never reopens after reload');
  await worker.evaluate(async () => __sendPoll(3, 'poll-b'));
  await page.locator('#classpilot-exit-answer').waitFor();
  await page.locator('#classpilot-exit-answer').fill('Keep the newer draft');
  await worker.evaluate(async () => { await __sendPoll(undefined, 'historical-a'); await __sendPoll(undefined, 'historical-a', 'close'); });
  assert.equal(await page.locator('#classpilot-exit-answer').inputValue(), 'Keep the newer draft', 'Historical no-order start/close cannot replace ordered UI');
  await worker.evaluate(async () => __sendPoll(2, 'poll-a', 'close'));
  assert.equal(await page.locator('#classpilot-exit-answer').count(), 1, 'Old close cannot dismiss a newer poll');
  await worker.evaluate(async () => { await __sendPoll(4, 'poll-b', 'close'); await __sendPoll(3, 'poll-b'); });
  await page.locator('#classpilot-poll-overlay').waitFor({ state: 'hidden' });
  const closed = await worker.evaluate(async () => (await kv.get(CLASSROOM_OVERLAY_STORAGE_KEY))[CLASSROOM_OVERLAY_STORAGE_KEY]);
  assert.equal(closed.poll, null); assert.equal(Object.values(closed.pollCursors)[0].status, 'closed');
  await worker.evaluate(async () => {
    await clearClassroomOverlayState('fixture-legacy-reset'); await __sendPoll(undefined, 'legacy-a');
  });
  await page.locator('#classpilot-exit-answer').waitFor();
  await worker.evaluate(async () => __sendPoll(10, 'missed-start-b', 'close'));
  await page.locator('#classpilot-poll-overlay').waitFor({ state: 'hidden' });
  const retiredLegacy = await worker.evaluate(async () => (await kv.get(CLASSROOM_OVERLAY_STORAGE_KEY))[CLASSROOM_OVERLAY_STORAGE_KEY]);
  assert.equal(retiredLegacy.poll, null, 'First ordered close retires older legacy overlay in exact context');
  await worker.evaluate(async () => __sendPoll(11, 'older-display-a'));
  await page.locator('#classpilot-exit-answer').waitFor();
  await worker.evaluate(async () => {
    const auth = captureAuthenticatedContext('completed different poll fixture');
    const state = await persistPollOverlay({ authority: { teachingSessionId: 'class-fixture' }, data: {
      action: 'start', transientOrder: 12, pollId: 'answered-elsewhere-b', question: 'New poll', options: ['A', 'B'] } }, { authContext: auth });
    const answered = await mutateClassroomOverlayState(current => ({ ...current,
      poll: { ...current.poll, response: { status: 'completed', selectedOption: 1 } } }), { authContext: auth });
    await broadcastToAllTabsForAuth('poll-state-sync', canonicalPollState(answered), auth,
      { studentId: auth.studentId, studentSessionId: auth.studentSessionId });
  });
  await page.locator('#classpilot-poll-overlay').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#page-work').inputValue(), 'Keep this work');
  assert.equal(await worker.evaluate(() => __pollNotifications), 3, 'Only genuinely new starts notify');
  await worker.evaluate(frames => {
    globalThis.__serverPollFrames = structuredClone(frames);
    for (const frame of Object.values(__serverPollFrames)) {
      // Map only the fixture transport binding/classroom and wall-clock expiry.
      // Keep the production command/data/order/delivery structure and poll ID.
      for (const binding of [frame, frame.command]) {
        binding.studentId = CONFIG.activeStudentId;
        binding.studentSessionId = CONFIG.activeStudentSessionId;
        binding.expiresAt = new Date(Date.now() + 60_000).toISOString();
      }
      frame.command.authority.teachingSessionId = 'class-fixture';
      frame.command.teachingSessionId = 'class-fixture';
      if (frame.command.data.action === 'start') {
        frame.command.data.expiresAt = new Date(Date.now() + 240_000).toISOString();
        frame.command.data.pollExpiresAt = frame.command.data.expiresAt;
      }
    }
    return handleWsMessage(JSON.stringify(__serverPollFrames.start));
  }, contractFrames);
  await page.getByText(contractFrames.start.command.data.question, { exact: true }).waitFor();
  const serverStart = await worker.evaluate(async () => ({
    stored: (await kv.get(CLASSROOM_OVERLAY_STORAGE_KEY))[CLASSROOM_OVERLAY_STORAGE_KEY],
    receipt: __pollReceipts.filter(receipt => receipt.state === 'received').at(-1),
  }));
  assert.equal(serverStart.stored.poll.pollId, contractFrames.start.command.data.pollId);
  assert.equal(serverStart.stored.poll.transientOrder, contractFrames.start.command.data.transientOrder);
  assert.equal(serverStart.receipt.order, contractFrames.start.command.data.transientOrder);
  await worker.evaluate(() => handleWsMessage(JSON.stringify(__serverPollFrames.close)));
  await page.locator('#classpilot-poll-overlay').waitFor({ state: 'hidden' });
  const serverClose = await worker.evaluate(async () => (await kv.get(CLASSROOM_OVERLAY_STORAGE_KEY))[CLASSROOM_OVERLAY_STORAGE_KEY]);
  assert.equal(serverClose.poll, null);
  assert.equal(Object.values(serverClose.pollCursors)[0].transientOrder, contractFrames.close.command.data.transientOrder);
  assert.equal(Object.values(serverClose.pollCursors)[0].status, 'closed');

  const scheduledRetry = await worker.evaluate(async () => {
    const auth = captureAuthenticatedContext('scheduled delayed negotiation fixture');
    const caps = [...__pollCaps, 'scheduledClassroomV1'];
    adoptNegotiatedProtocolState({ serverProtocolVersion: 3, acceptedCapabilities: caps }, auth);
    await clearClassroomOverlayState('scheduled retry fixture');
    const end = Date.now() + 240_000;
    currentClassroomState = RuntimeCore.normalizeClassroomState({ schemaVersion: 1, revision: 42,
      supervisionContextId: 'scheduled-fixture', hardExpiresAt: end, scheduledEndAt: end, restrictions: {} });
    observeStudentControlRevision(42, auth, 'scheduled retry fixture');
    await applyFabSettings({ schemaVersion: 1, revision: 1, ownershipRevision: 42, contextAuthorityRevision: '7',
      supervisionContextId: 'scheduled-fixture', activeContexts: [{ supervisionContextId: 'scheduled-fixture' }],
      teachingSessionId: null, activeSessionIds: [], messagingEnabled: true, handRaisingEnabled: true }, { authContext: auth });
    const state = await persistPollOverlay({ authority: { supervisionContextId: 'scheduled-fixture', contextAuthorityRevision: '7' },
      data: { action: 'start', pollId: 'scheduled-pending', transientOrder: 21, question: 'Scheduled', options: ['A', 'B'], pollExpiresAt: end } }, { authContext: auth });
    await mutateClassroomOverlayState(current => ClassPilotPollReplayCore.reserveAnswer(current,
      'scheduled-pending', RuntimeCore.classroomContextKey(state.poll), { selectedOption: 1 }, Date.now()), { authContext: auth });
    adoptNegotiatedProtocolState({ serverProtocolVersion: 3, acceptedCapabilities: __pollCaps }, auth);
    await chrome.alarms.clear(POLL_RESPONSE_RETRY_ALARM);
    const requestCount = __pollRequests.length;
    await retryPendingPollResponse(auth);
    return { alarm: await chrome.alarms.get(POLL_RESPONSE_RETRY_ALARM), requestCount,
      requestCountAfter: __pollRequests.length,
      stored: (await kv.get(CLASSROOM_OVERLAY_STORAGE_KEY))[CLASSROOM_OVERLAY_STORAGE_KEY] };
  });
  assert.ok(scheduledRetry.alarm?.scheduledTime > Date.now(), 'Missing scheduled authority re-arms the pending answer retry');
  assert.equal(scheduledRetry.requestCountAfter, scheduledRetry.requestCount, 'No HTTP without current scheduled authority');
  assert.equal(scheduledRetry.stored.poll.response.status, 'pending');
  const invalidAnswer = await worker.evaluate(async () => {
    const auth = captureAuthenticatedContext('invalid answer fixture');
    adoptNegotiatedProtocolState({ serverProtocolVersion: 3, acceptedCapabilities: [...__pollCaps, 'scheduledClassroomV1'] }, auth);
    const state = await persistPollOverlay({ authority: { supervisionContextId: 'scheduled-fixture', contextAuthorityRevision: '7' },
      data: { action: 'start', pollId: 'invalid-answer', transientOrder: 22, question: 'Validate', options: ['A', 'B'] } }, { authContext: auth });
    try {
      await submitDurablePollResponse({ pollId: state.poll.pollId, selectedOption: 99,
        ...classroomAuthorityPayload(state.poll), studentControlRevision: currentStudentControlRevision(),
        studentMessageContext: studentMessageContextFor(auth), fabBinding: fabIdentityBinding() });
      throw new Error('Invalid answer unexpectedly accepted');
    } catch (error) {
      return { error: error.message, pending: error.pollResponsePending,
        response: (await kv.get(CLASSROOM_OVERLAY_STORAGE_KEY))[CLASSROOM_OVERLAY_STORAGE_KEY].poll.response };
    }
  });
  assert.equal(invalidAnswer.error, 'Invalid poll option');
  assert.equal(invalidAnswer.pending, false, 'A rejected, unsaved answer must not be presented as durable');
  assert.equal(invalidAnswer.response, null);
  console.log(`Poll replay Chromium checks passed: durable ACK/crash recovery, sticky answer/retry, canonical 409, ordering fences, scheduled negotiation retry and production server frame contract (${contractPath}).`);
} finally {
  await browser?.close();
  if (server) await new Promise(done => server.close(done));
  assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/')));
  await rm(profile, { recursive: true, force: true });
}
