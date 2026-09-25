import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { waitForExtensionWorkerDeclarations } from './extension-worker-test-readiness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const requestedExtension = String(process.env.CLASSPILOT_EXTENSION_PATH || '').trim()
  ? resolve(process.env.CLASSPILOT_EXTENSION_PATH) : resolve(root, 'extension');
const extension = requestedExtension;
const profile = await mkdtemp(join(tmpdir(), 'classpilot-class-tools-'));
let browser;
let server;
try {
  browser = await chromium.launchPersistentContext(profile, { executablePath: process.env.CLASSPILOT_CHROME_PATH || chromium.executablePath(), headless: true,
    args: ['--headless=new', '--enable-automation', '--no-proxy-server', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1, EXCLUDE localhost', `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
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
  await waitForExtensionWorkerDeclarations(worker);
  const requestedManifest = JSON.parse(await readFile(resolve(requestedExtension, 'manifest.json'), 'utf8'));
  const loadedVersion = await worker.evaluate(() => chrome.runtime.getManifest().version);
  assert.equal(loadedVersion, requestedManifest.version, 'Chrome must load the requested extension manifest');
  console.log(`Scheduled classroom Chrome loaded ${requestedExtension} (version ${loadedVersion}).`);
  await worker.evaluate(async () => {
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

    const capabilities = ['scopedAuthorityChecksV1', 'scheduledClassroomV1', 'helpRequestsV1', 'questionParkingV1', 'timerControlsV1', 'lessonActivitiesV1', 'exitTicketsV1'];
    adoptNegotiatedProtocolState({ serverProtocolVersion: 3, acceptedCapabilities: capabilities }, auth);
    const end = Date.now() + 300000;
    currentClassroomState = RuntimeCore.normalizeClassroomState({ schemaVersion: 1, revision: 41, supervisionContextId: 'tools-a', hardExpiresAt: end, scheduledEndAt: end, restrictions: {} });
    observeStudentControlRevision(41, auth, 'tools fixture');
    globalThis.__toolsRequests = [];
    globalThis.__toolsSnapshot = { phase: 5, revision: 1, capabilities: capabilities.slice(2), help: null, questions: [],
      timer: { timerId: 'timer-a', revision: 1, deadline: new Date(Date.now()+120000).toISOString(), pausedRemainingMs: null, expiresAt: new Date(end).toISOString(), message: 'Practice' },
      activity: { activityId: 'activity-a', revision: 1, title: 'Practice fractions', instructions: 'Solve and explain.', resources: [{ title: 'Reference', url: 'https://example.test/reference' }],
        checklist: [{ id: 'one', text: 'Solve the first problem' }], expiresAt: new Date(end).toISOString(), progress: { status: 'not_reported', completedItemIds: [], revision: 0 } } };
    globalThis.__toolsOwner = '0';
    // Delivering an old snapshot must not replace the fixture server's current owner.
    globalThis.__deliverTools = async (snapshot, owner = globalThis.__toolsOwner) => applyFabSettings({ schemaVersion: 1, revision: 1, ownershipRevision: 41, teachingSessionId: null,
      supervisionContextId: 'tools-a', contextAuthorityRevision: owner, activeSessionIds: [], activeContexts: [{ supervisionContextId: 'tools-a' }],
      contextSource: 'scheduled_testing', messagingEnabled: true, handRaisingEnabled: true, classTools: snapshot }, { authContext: auth });
    globalThis.__pushTools = async () => globalThis.__deliverTools(globalThis.__toolsSnapshot);
    globalThis.__replaceToolsOwner = async (snapshot, owner) => {
      globalThis.__toolsSnapshot = snapshot;
      globalThis.__toolsOwner = owner;
      await globalThis.__pushTools();
    };
    fetchWithBackoff = async (url, init = {}, options = {}) => {
      const body = JSON.parse(init.body || '{}');
      const request = { url: String(url), method: init.method, body, context: options.context };
      globalThis.__toolsRequests.push(request);
      const endpoint = new URL(request.url);
      const response = (data, status = 200) => new Response(JSON.stringify(data), { status });
      if (endpoint.origin !== auth.serverOrigin) return response({ error: 'Unexpected fixture origin' }, 404);
      if (options.context === 'Class tools submission') {
        const snapshot = globalThis.__toolsSnapshot;
        const route = `${init.method} ${endpoint.pathname}`;
        if (route === 'POST /api/classpilot/student/class-tools/questions') {
          snapshot.questions.push({ id: 'question-a', question: body.data.question, answer: null, revision: 1 });
        } else if (route === 'POST /api/classpilot/student/class-tools/help') {
          snapshot.help = { id: 'help-a', status: 'waiting', category: body.data.category, explanation: body.data.explanation, revision: 1 };
        } else if (route === 'DELETE /api/classpilot/student/class-tools/help') {
          snapshot.help = null;
        } else if (route === 'PUT /api/classpilot/student/class-tools/progress') {
          Object.assign(snapshot.activity.progress, body.data, { revision: snapshot.activity.progress.revision + 1 });
        } else {
          return response({ error: 'Unexpected class tools fixture route' }, 404);
        }
        snapshot.revision++;
        await globalThis.__pushTools();
        return response({ ok: true });
      }
      if (options.context === 'poll response' && init.method === 'POST' && endpoint.pathname === '/api/polls/exit-a/respond') {
        return response({ ok: true });
      }
      if (options.context === 'chat acknowledgement' && init.method === 'POST' && endpoint.pathname === '/api/classpilot/device/chat-acks') {
        return response({ receipts: body.acks.map(ack => ({ ackId: ack.ackId, messageId: ack.messageId, accepted: true })) });
      }
      return response({ error: 'Unexpected background fixture route' }, 404);
    };
    await globalThis.__pushTools();
  });
  server = createServer((_req,res) => { res.writeHead(200, {'content-type':'text/html'}); res.end('<!doctype html><title>Tools fixture</title><body>Classroom</body>'); });
  await new Promise(done => server.listen(0,'127.0.0.1',done));
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${server.address().port}/`);
  await page.locator('#classpilot-fab-main').click();
  await page.locator('#classpilot-fab-tools').click();
  await page.getByText('Practice fractions', {exact:true}).waitFor();
  assert.equal(await page.locator('#classpilot-work-status option').count(), 5);
  await page.locator('#classpilot-help-text').fill('I need another example');
  await page.locator('#classpilot-help-send').click();
  await page.getByText('Waiting for your teacher. Editing keeps your place.', {exact:true}).waitFor();
  await worker.evaluate(async () => { globalThis.__toolsSnapshot.help.status = 'acknowledged'; globalThis.__toolsSnapshot.revision++; await globalThis.__pushTools(); });
  await page.getByText(/Your teacher has seen your request/).waitFor();
  await page.locator('#classpilot-work-status').selectOption('stuck');
  await page.locator('#classpilot-tools-status').getByText('Saved', {exact:true}).waitFor();
  await page.getByRole('checkbox', {name:'Solve the first problem'}).check();
  await page.locator('#classpilot-tools-status').getByText('Saved', {exact:true}).waitFor();
  assert.equal(await page.locator('#classpilot-work-status').inputValue(), 'stuck', 'Checklist completion must not change status');
  await page.locator('#classpilot-question-text').fill('Why do denominators match?');
  await page.locator('#classpilot-question-send').click();
  await page.getByText('Why do denominators match? — Waiting for an answer', {exact:true}).waitFor();
  await page.waitForFunction(() => document.querySelector('#classpilot-question-text')?.value === '');
  const requests = await worker.evaluate(() => globalThis.__toolsRequests.filter(request => request.context === 'Class tools submission'));
  assert.ok(requests.length >= 4);
  assert.deepEqual(requests.map(request => `${request.method} ${new URL(request.url).pathname}`), [
    'POST /api/classpilot/student/class-tools/help',
    'PUT /api/classpilot/student/class-tools/progress',
    'PUT /api/classpilot/student/class-tools/progress',
    'POST /api/classpilot/student/class-tools/questions',
  ]);
  for (const request of requests) { assert.equal(request.body.supervisionContextId, 'tools-a'); assert.equal(request.body.studentControlRevision,41); assert.equal(request.body.deviceId,undefined); }
  await worker.evaluate(async () => { globalThis.__toolsSnapshot.timer = { ...globalThis.__toolsSnapshot.timer, revision: 2, deadline: null, pausedRemainingMs: 90000 }; globalThis.__toolsSnapshot.revision++; await globalThis.__pushTools(); });
  await page.getByText('1:30 · Paused', {exact:true}).waitFor();
  await worker.evaluate(async () => globalThis.__deliverTools({ ...globalThis.__toolsSnapshot, revision: 1, timer: null, activity: null }));
  await page.getByText('1:30 · Paused', {exact:true}).waitFor();
  await page.reload();
  await page.getByText('1:30 · Paused', {exact:true}).waitFor();
  assert.equal(await page.evaluate(() => {
    const timer = document.querySelector('#classpilot-timer-overlay').getBoundingClientRect();
    const launcher = document.querySelector('#classpilot-fab-main').getBoundingClientRect();
    return timer.left < launcher.right && timer.right > launcher.left
      && timer.top < launcher.bottom && timer.bottom > launcher.top;
  }), false, 'A restored timer must leave the student launcher visible and reachable');
  await page.locator('#classpilot-fab-main').click(); await page.locator('#classpilot-fab-tools').click();
  await page.getByText('Practice fractions',{exact:true}).waitFor();
  await worker.evaluate(async () => {
    const auth = captureAuthenticatedContext('exit ticket fixture');
    await persistPollOverlay({ authority:{supervisionContextId:'tools-a'}, data:{action:'start',pollId:'exit-a',question:'What did you learn?',options:[],purpose:'exit_ticket',responseType:'short_text'} }, {authContext:auth});
  });
  await page.reload();
  await page.locator('#classpilot-exit-answer').fill('Equivalent fractions describe the same amount.');
  assert.equal(await page.locator('#classpilot-exit-answer').getAttribute('maxlength'),'500');
  await page.locator('#classpilot-exit-submit').click();
  await page.locator('.classpilot-poll-thanks').waitFor({state:'visible'});
  const exit = await worker.evaluate(async () => ({ request:globalThis.__toolsRequests.find(request=>request.url.includes('/polls/exit-a/respond')), stored:(await durableLocalKv.get(CLASSROOM_OVERLAY_STORAGE_KEY))[CLASSROOM_OVERLAY_STORAGE_KEY] }));
  assert.equal(exit.request.body.textResponse,'Equivalent fractions describe the same amount.');
  assert.equal(exit.request.method, 'POST');
  assert.equal(new URL(exit.request.url).pathname, '/api/polls/exit-a/respond');
  assert.equal(exit.request.body.selectedOption,undefined);
  assert.ok(!JSON.stringify(exit.stored).includes('Equivalent fractions describe the same amount.'));
  await page.reload();
  assert.equal(await page.locator('#classpilot-exit-answer').count(),0,'Submitted text prompts cannot reopen after reload');
  await page.locator('#classpilot-fab-main').click(); await page.locator('#classpilot-fab-tools').click();
  await worker.evaluate(async () => globalThis.__replaceToolsOwner({ phase:5, revision:1, capabilities:['helpRequestsV1'], help:null,questions:[],timer:null,activity:null }, '1'));
  await page.getByText('Practice fractions',{exact:true}).waitFor({state:'hidden'});
  await page.locator('#classpilot-timer-overlay').waitFor({state:'hidden'});
  const backgroundTools = await worker.evaluate(async () => {
    const before = structuredClone(currentFabState);
    const auth = captureAuthenticatedContext('tools background acknowledgement fixture');
    const queued = await enqueueChatAck({ ackId: 'tools-background-ack', messageId: 'tools-background-message',
      deliveryStatus: 'delivered', supervisionContextId: 'tools-a', studentControlRevision: 41 }, auth);
    await flushChatAckOutbox({ forceHttp: true });
    return { queued, before, after: currentFabState,
      remainingAcks: (await durableLocalKv.get(CHAT_ACK_OUTBOX_KEY))[CHAT_ACK_OUTBOX_KEY],
      request: globalThis.__toolsRequests.find(request => request.url.endsWith('/api/classpilot/device/chat-acks')) };
  });
  assert.equal(backgroundTools.queued, true, 'The regression must exercise a real queued acknowledgement');
  assert.equal(backgroundTools.request?.method, 'POST', 'The regression must reach the real background HTTP path');
  assert.equal(backgroundTools.request.body.acks[0].supervisionContextId, 'tools-a');
  assert.equal(backgroundTools.request.body.acks[0].studentControlRevision, 41);
  assert.equal(backgroundTools.remainingAcks.length, 0, 'The fixture must acknowledge and drain the real background outbox');
  assert.deepEqual(backgroundTools.after, backgroundTools.before,
    '[regression:tools-fixture-authority] Background acknowledgements must not republish an obsolete tools owner');
  await worker.evaluate(async () => globalThis.__pushTools());
  const finalTools = await worker.evaluate(() => ({ state: currentFabState, requests: globalThis.__toolsRequests.slice(-8) }));
  if (finalTools.state.classTools.capabilities.includes('lessonActivitiesV1')) {
    console.log('Class tools ownership diagnostics', JSON.stringify(finalTools));
  }
  assert.equal(finalTools.state.contextAuthorityRevision, '1', 'Subsequent tools responses must retain the fixture server\'s current owner');
  assert.equal(finalTools.state.classTools.capabilities.includes('lessonActivitiesV1'), false);
  console.log('Class tools Chrome checks passed: exact submissions, help acknowledgement, checklist/status independence, pushed-question races, short-text exit tickets, pause/reload, reordered snapshots, owner change, mixed capabilities, unrelated background acknowledgement.');
} finally {
  await browser?.close();
  if (server) await new Promise(done => server.close(done));
  assert.ok(resolve(profile).startsWith(resolve(tmpdir()) + (process.platform === 'win32' ? '\\' : '/')));
  await rm(profile, { recursive: true, force: true });
}
