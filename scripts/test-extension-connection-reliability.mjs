// Fault regressions in the actual MV3 worker. School transports are synthetic;
// all HTTP(S) resolution is blocked before the extension starts.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { WebSocketServer } from 'ws';
import { waitForExtensionWorkerDeclarations } from './extension-worker-test-readiness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extension = resolve(process.env.CLASSPILOT_EXTENSION_PATH || join(root, 'extension'));
const profile = mkdtempSync(join(tmpdir(), 'classpilot-connection-reliability-'));
const executablePath = [process.env.CLASSPILOT_CHROME_PATH, chromium.executablePath(),
  'C:/Program Files/Google/Chrome/Application/chrome.exe'].find(value => value && existsSync(value));
assert.ok(executablePath, 'Actual Chrome/Chromium is required');
let context;
let probeServer;
let negativeAckServer;
const closedErrorStreams = new Set();
try {
  negativeAckServer = createServer((request, response) => {
    if (request.method === 'GET') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<!doctype html><title>Fresh heartbeat fixture</title><p>Local fixture</p>');
      return;
    }
    const status = request.url === '/429' ? 429 : 503;
    request.resume();
    response.on('close', () => closedErrorStreams.add(status));
    response.writeHead(status, { 'Content-Type': 'application/json', 'Retry-After': '1' });
    response.write('{"unfinished":'); // Deliberately never finish the error body.
  });
  await new Promise(resolve => negativeAckServer.listen(0, '127.0.0.1', resolve));
  const negativeAckOrigin = `http://127.0.0.1:${negativeAckServer.address().port}`;
  context = await chromium.launchPersistentContext(profile, { executablePath, headless: true,
    args: ['--headless=new', '--no-proxy-server',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
      `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15_000 });
  await waitForExtensionWorkerDeclarations(worker);
  const result = await worker.evaluate(async negativeAckOrigin => {
    await authStateRestorePromise; await classroomStateRestorePromise; await studentAuthMutationTail;
    const wakeUntil = Date.now() + 15_000;
    while (!workerWakeSettled && Date.now() < wakeUntil) await new Promise(resolve => setTimeout(resolve, 25));
    if (!workerWakeSettled) throw new Error('Worker did not finish its real startup');
    CONFIG.autoRegistrationPaused = true;
    if (chromeProfileRegistrationInFlight) await chromeProfileRegistrationInFlight.catch(() => {});
    advanceStudentAuthMutationGeneration();
    await chrome.alarms.clearAll();
    scheduleHeartbeat(null);
    Object.assign(CONFIG, { serverUrl: 'http://127.0.0.1:1', schoolId: 'reliability-school',
      deviceId: 'reliability-device', activeStudentId: 'reliability-student',
      activeStudentSessionId: 'reliability-session', studentToken: 'synthetic-token', identitySource: 'integration_test' });
    studentAuthInvalidating = false; studentAuthCommitPending = false;
    activateAuthenticatedContext('reliability-auth');
    const auth = captureAuthenticatedContext('connection fixture');
    adoptLicenseState(true, 'active', auth);
    schoolSettings = { enableTrackingHours: false, afterHoursMode: 'off' };
    schoolSettingsScope = schoolPolicyScopeForAuthContext(auth);
    schoolSettingsFetchedAt = Date.now();
    trackingState = TRACKING_STATES.ACTIVE;
    heartbeatBackoffUntilMs = 0; apiBackoffUntilMs = 0;
    const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
    const waitUntil = async predicate => {
      const until = Date.now() + 2000;
      while (!predicate() && Date.now() < until) await wait(10);
      if (!predicate()) throw new Error('Fault fixture condition did not settle');
    };
    const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

    // Let the native coalescing callback fire while the first real heartbeat's
    // HTTP request is held. Its one trailing payload must query a newly opened
    // native tab rather than reuse the inventory captured by that first send.
    let requests = 0;
    const first = deferred();
    const heartbeatTransport = fetchWithBackoff;
    const heartbeatPayloads = [];
    fetchWithBackoff = async (url, init) => {
      if (url.endsWith('/api/device/heartbeat')) {
        heartbeatPayloads.push(JSON.parse(init.body));
        requests++;
        if (requests === 1) await first.promise;
      }
      return new Response(null, { status: 204 });
    };
    scheduleEventHeartbeat('navigation-one');
    if (eventHeartbeatTimer === null) throw new Error('Native coalescing timer was not scheduled');
    const initial = safeSendHeartbeat('interval');
    await waitUntil(() => requests === 1);
    const freshTabUrl = `${negativeAckOrigin}/fresh-tab`;
    const freshTab = await chrome.tabs.create({ url: freshTabUrl, active: false });
    scheduleEventHeartbeat('navigation-latest');
    await wait(EVENT_HEARTBEAT_COALESCE_MS + 100);
    const nativeCoalescedWhileBusy = heartbeatInFlight && eventHeartbeatTimer === null
      && eventHeartbeatReason !== null && eventHeartbeatDueAt <= Date.now();
    if (requests !== 1 || !nativeCoalescedWhileBusy) throw new Error('Busy native coalescing callback lost the event');
    first.resolve(); await initial; await waitUntil(() => requests === 2 && !heartbeatInFlight);
    await wait(EVENT_HEARTBEAT_COALESCE_MS + 100);
    const trailingRequests = requests;
    const freshTrailingPayload = !heartbeatPayloads[0].allOpenTabs.some(tab => tab.url === freshTabUrl)
      && heartbeatPayloads[1].allOpenTabs.some(tab => tab.url === freshTabUrl);
    await chrome.tabs.remove(freshTab.id);
    clearPendingEventHeartbeat();
    fetchWithBackoff = heartbeatTransport;
    sendHeartbeat = async () => { requests++; };
    scheduleEventHeartbeat('periodic-collision'); eventHeartbeatDueAt = Date.now() - 1;
    await safeSendHeartbeat('interval'); await wait(30);
    const afterPeriodic = requests;
    scheduleEventHeartbeat('cooldown'); eventHeartbeatDueAt = Date.now() - 1;
    heartbeatBackoffUntilMs = Date.now() + 50; drainPendingEventHeartbeat();
    await wait(10); const duringCooldown = requests;
    await waitUntil(() => requests === 4); const afterCooldown = requests;
    scheduleEventHeartbeat('retired-identity'); advanceStudentAuthMutationGeneration();
    const retiredPending = eventHeartbeatReason;
    activateAuthenticatedContext('reliability-auth');
    const currentAuth = captureAuthenticatedContext('restored fixture');
    adoptLicenseState(true, 'active', currentAuth);

    // Headers and body are both deadline bounded, including a transport mock
    // that never settles on abort. Identity cancellation wins immediately.
    const originalFetch = fetchWithBackoff;
    fetchWithBackoff = async () => new Promise(() => {});
    const headerStarted = Date.now();
    const headerFailure = await fetchAckReceipt('/synthetic', {}, currentAuth, 'fixture ACK').catch(error => error.code);
    const headerMs = Date.now() - headerStarted;
    const ackId = 'lost-receipt:completed';
    await enqueueCommandAck({ commandId: 'lost-receipt', ackId, ackState: 'completed',
      studentId: currentAuth.studentId, studentSessionId: currentAuth.studentSessionId,
      authContextId: currentAuth.authContextId }, currentAuth);
    wsConnected = false;
    const sentAckIds = [];
    fetchWithBackoff = async (_url, init) => {
      sentAckIds.push(JSON.parse(init.body).acks[0].ackId);
      return { ok: true, json: () => new Promise(() => {}) };
    };
    const originalReceipt = fetchAckReceipt;
    let bodyFailure;
    fetchAckReceipt = async (...args) => {
      try { return await originalReceipt(...args); }
      catch (error) { bodyFailure = error.code; throw error; }
    };
    const bodyStarted = Date.now();
    await flushCommandAckOutbox({ forceHttp: true });
    const bodyMs = Date.now() - bodyStarted;
    const retainedAfterTimeout = (await durableLocalKv.get(COMMAND_ACK_OUTBOX_KEY))[COMMAND_ACK_OUTBOX_KEY];
    const releasedAckFlight = commandAckFlushInFlight === null;
    fetchWithBackoff = async (_url, init) => {
      sentAckIds.push(JSON.parse(init.body).acks[0].ackId);
      return { ok: true, json: async () => ({ receipts: [{ accepted: true, disposition: 'idempotent',
        commandId: 'lost-receipt', ackId }] }) };
    };
    await flushCommandAckOutbox({ forceHttp: true });
    const remainingAfterReceipt = (await durableLocalKv.get(COMMAND_ACK_OUTBOX_KEY))[COMMAND_ACK_OUTBOX_KEY].length;
    fetchAckReceipt = originalReceipt;
    const negativeResponses = [];
    for (const status of [503, 429]) {
      const failedAckId = `stalled-${status}:completed`;
      await enqueueCommandAck({ commandId: `stalled-${status}`, ackId: failedAckId, ackState: 'completed',
        studentId: currentAuth.studentId, studentSessionId: currentAuth.studentSessionId,
        authContextId: currentAuth.authContextId }, currentAuth);
      apiBackoffUntilMs = 0;
      let requestSignal;
      let receivedStatus;
      fetchWithBackoff = async (_url, init, options) => {
        requestSignal = init.signal;
        const response = await originalFetch(`${negativeAckOrigin}/${status}`, init, options);
        receivedStatus = response.status;
        return response;
      };
      const startedAt = Date.now();
      await flushCommandAckOutbox({ forceHttp: true });
      const retained = (await durableLocalKv.get(COMMAND_ACK_OUTBOX_KEY))[COMMAND_ACK_OUTBOX_KEY];
      negativeResponses.push({ status: receivedStatus, aborted: requestSignal.aborted,
        elapsedMs: Date.now() - startedAt, retained: retained.some(ack => ack.ackId === failedAckId),
        released: commandAckFlushInFlight === null, cooldown: apiBackoffUntilMs > Date.now() });
      await removeCommandAcks([failedAckId], currentAuth);
      if (commandAckFlushTimer) clearTimeout(commandAckFlushTimer);
      commandAckFlushTimer = null; commandAckFlushTimerAt = 0;
    }
    apiBackoffUntilMs = 0;
    fetchWithBackoff = async () => new Promise(() => {});
    const cancelled = fetchAckReceipt('/synthetic', {}, currentAuth, 'fixture cancelled ACK').catch(error => error.code);
    await wait(20); advanceStudentAuthMutationGeneration();
    const cancellationFailure = await cancelled;
    activateAuthenticatedContext('reliability-auth');
    const readyAuth = captureAuthenticatedContext('ready fixture');
    adoptLicenseState(true, 'active', readyAuth);
    trackingState = TRACKING_STATES.ACTIVE;
    fetchWithBackoff = originalFetch;

    // Reserve frame order before readiness. Recovery uses offscreen status,
    // rather than trusting the queued frame to establish its generation.
    const policyReady = deferred();
    const originalPolicy = awaitManagedAuthGatePolicyStable;
    const originalProcess = processWsEvent;
    const originalRecover = recoverOffscreenWebSocketStatus;
    awaitManagedAuthGatePolicyStable = () => policyReady.promise;
    const delivered = [];
    processWsEvent = async (_event, data) => { delivered.push(data); return { handled: true }; };
    recoverOffscreenWebSocketStatus = async supplied => {
      assertAuthenticatedContextCurrent(supplied);
      wsConnectionGeneration = 77;
      wsTransportIdentity = { connectionGeneration: 77, authContextId: supplied.authContextId, serverOrigin: supplied.serverOrigin };
      return true;
    };
    wsConnectionGeneration = 0; wsAuthenticatedResponseGuard = null;
    const frameA = handleWsEvent('message', 'state', 77, readyAuth.authContextId, readyAuth.serverOrigin);
    const frameB = handleWsEvent('message', 'screenshot-hint', 77, readyAuth.authContextId, readyAuth.serverOrigin);
    await wait(10); const beforeReady = delivered.length;
    policyReady.resolve(); await Promise.all([frameA, frameB]);
    const stale = await handleWsEvent('message', 'stale', 76, readyAuth.authContextId, readyAuth.serverOrigin);
    const oldHandler = deferred();
    const oldStarted = deferred();
    processWsEvent = async (_event, data) => {
      delivered.push(data);
      if (data === 'old-generation') { oldStarted.resolve(); await oldHandler.promise; }
      return { handled: true };
    };
    const oldFrame = handleWsEvent('message', 'old-generation', 77, readyAuth.authContextId, readyAuth.serverOrigin);
    await oldStarted.promise;
    wsConnectionGeneration = 78;
    wsTransportIdentity = { connectionGeneration: 78, authContextId: readyAuth.authContextId, serverOrigin: readyAuth.serverOrigin };
    const replacement = handleWsEvent('message', 'replacement-generation', 78, readyAuth.authContextId, readyAuth.serverOrigin);
    const replacementProgress = await Promise.race([replacement.then(() => true), wait(500).then(() => false)]);
    oldHandler.resolve(); await oldFrame;
    const retainedIngressTails = wsIngressTails.size;
    wsConnectionGeneration = 77;
    wsTransportIdentity = { connectionGeneration: 77, authContextId: readyAuth.authContextId, serverOrigin: readyAuth.serverOrigin };
    awaitManagedAuthGatePolicyStable = originalPolicy;
    processWsEvent = originalProcess; recoverOffscreenWebSocketStatus = originalRecover;

    // A surviving authenticated proxy does not restore negotiated capability
    // authority. HTTP restores it before the queued command is admitted once.
    const originalHeartbeat = sendHeartbeat;
    const originalRemoteControl = handleRemoteControl;
    const coldReady = deferred();
    let coldCommands = 0;
    negotiatedProtocolState = null; wsWakeReconciliation = null;
    sendHeartbeat = async () => {
      await coldReady.promise;
      adoptNegotiatedProtocolState({ serverProtocolVersion: 3,
        acceptedCapabilities: ['scopedAuthorityChecksV1', 'focusTabV1'] }, readyAuth);
    };
    handleRemoteControl = async () => {
      if (!hasNegotiatedCapability('focusTabV1', readyAuth)) throw new Error('Cold command lacked HTTP capability authority');
      coldCommands++;
    };
    const coldCommand = handleWsEvent('message', JSON.stringify({ type: 'remote-control', _msgId: 'cold-command',
      studentId: readyAuth.studentId, studentSessionId: readyAuth.studentSessionId,
      command: { type: 'activate-tab', data: { tabRef: 'synthetic-ref', observedRevision: 1 } },
      deliveryPolicy: 'transient_action', expiresAt: new Date(Date.now() + 5000).toISOString() }),
    77, readyAuth.authContextId, readyAuth.serverOrigin);
    await wait(20); const beforeColdHttp = coldCommands;
    coldReady.resolve(); await coldCommand;
    sendHeartbeat = originalHeartbeat; handleRemoteControl = originalRemoteControl;

    // Slow receipt transports cannot retain the auth-success frame's serial
    // tail or prevent its authoritative initial snapshot from being adopted.
    const originalAdopt = adoptAuthenticatedStudentBinding;
    const originalProtocol = adoptProtocolAndScreenshotPolicy;
    const originalState = applyClassroomStateFromAuthResponse;
    const originalCommandFlush = flushCommandAckOutbox;
    const originalChatFlush = flushChatAckOutbox;
    const originalSync = requestClassroomStateSync;
    adoptAuthenticatedStudentBinding = async () => {};
    adoptProtocolAndScreenshotPolicy = () => {};
    let snapshots = 0;
    applyClassroomStateFromAuthResponse = async () => { snapshots++; };
    flushCommandAckOutbox = async () => new Promise(() => {});
    flushChatAckOutbox = async () => new Promise(() => {});
    requestClassroomStateSync = () => {};
    wsAuthenticatedResponseGuard = { authContext: readyAuth, connectionGeneration: 77, responseGuard: {}, requestStartedAt: Date.now() };
    const authFrame = handleWsMessage(JSON.stringify({ type: 'auth-success', classroomState: null }), 77, readyAuth);
    const authProgress = await Promise.race([authFrame.then(() => true), wait(500).then(() => false)]);
    adoptAuthenticatedStudentBinding = originalAdopt; adoptProtocolAndScreenshotPolicy = originalProtocol;
    applyClassroomStateFromAuthResponse = originalState;
    flushCommandAckOutbox = originalCommandFlush; flushChatAckOutbox = originalChatFlush;
    requestClassroomStateSync = originalSync;

    // A transient command whose received-ACK persistence crosses its delivery
    // deadline must expire before the first browser side effect.
    const originalAck = sendCommandAck;
    const originalExecute = executeRemoteControlCommand;
    const originalSessions = activeTeachingSessionIds;
    const originalSnapshot = getClassroomCommandStateSnapshot;
    const acknowledgements = []; let effects = 0;
    activeTeachingSessionIds = () => ['reliability-class'];
    currentClassroomState = null;
    sendCommandAck = async (_id, state) => { acknowledgements.push(state); if (state === 'received') await wait(30); };
    executeRemoteControlCommand = async () => { effects++; return {}; };
    getClassroomCommandStateSnapshot = async () => ({});
    negotiatedProtocolState = null; wsWakeReconciliation = null;
    sendHeartbeat = async () => {
      await wait(30);
      adoptNegotiatedProtocolState({ serverProtocolVersion: 3,
        acceptedCapabilities: ['scopedAuthorityChecksV1', 'focusTabV1'] }, readyAuth);
    };
    await handleWsEvent('message', JSON.stringify({ type: 'remote-control', _msgId: 'cold-expired-command',
      commandId: 'cold-expiry', studentId: readyAuth.studentId, studentSessionId: readyAuth.studentSessionId,
      command: { type: 'open-tab', commandId: 'cold-expiry', data: { url: 'https://example.invalid' },
        authority: { teachingSessionId: 'reliability-class' } },
      authority: { teachingSessionId: 'reliability-class' }, deliveryPolicy: 'transient_action',
      expiresAt: new Date(Date.now() + 10).toISOString() }), 77, readyAuth.authContextId, readyAuth.serverOrigin);
    const coldExpiredAcks = [...acknowledgements];
    acknowledgements.length = 0;
    sendHeartbeat = originalHeartbeat;
    await handleRemoteControl({ type: 'open-tab', commandId: 'expiry-fixture', data: { url: 'https://example.invalid' },
      authority: { teachingSessionId: 'reliability-class' } }, {
      commandId: 'expiry-fixture', studentId: readyAuth.studentId, studentSessionId: readyAuth.studentSessionId,
      authority: { teachingSessionId: 'reliability-class' }, deliveryPolicy: 'transient_action',
      expiresAt: new Date(Date.now() + 10).toISOString() });
    sendCommandAck = originalAck; executeRemoteControlCommand = originalExecute;
    activeTeachingSessionIds = originalSessions; getClassroomCommandStateSnapshot = originalSnapshot;
    const originalConnect = connectWebSocket;
    const originalRandom = Math.random;
    let reconnects = 0;
    connectWebSocket = async () => { reconnects++; };
    Math.random = () => 0.01;
    trackingState = TRACKING_STATES.ACTIVE;
    wsAuthRecoveryRequired = false; wsReconnectBackoffMs = 1000;
    scheduleWsReconnect(); scheduleWsReconnect();
    await waitUntil(() => reconnects === 1);
    const duplicateReconnects = reconnects;
    const originalSetTimeout = globalThis.setTimeout;
    let retiredTimer;
    globalThis.setTimeout = callback => { retiredTimer = callback; return 987654; };
    scheduleWsReconnect();
    globalThis.setTimeout = originalSetTimeout;
    advanceStudentAuthMutationGeneration();
    retiredTimer();
    const retiredReconnects = reconnects;
    connectWebSocket = originalConnect; Math.random = originalRandom;
    clearWsReconnectTimer(); clearPendingEventHeartbeat(); await chrome.alarms.clearAll();
    return { trailingRequests, nativeCoalescedWhileBusy, freshTrailingPayload,
      afterPeriodic, duringCooldown, afterCooldown, retiredPending,
      headerFailure, headerMs, bodyFailure, bodyMs, cancellationFailure, negativeResponses,
      retainedAfterTimeout: retainedAfterTimeout.map(value => value.ackId), releasedAckFlight, sentAckIds, remainingAfterReceipt,
      beforeReady, delivered, stale: stale.ignored, authProgress, snapshots, acknowledgements, effects,
      duplicateReconnects, retiredReconnects, beforeColdHttp, coldCommands, coldExpiredAcks,
      replacementProgress, retainedIngressTails };
  }, negativeAckOrigin);
  assert.equal(result.trailingRequests, 2);
  assert.equal(result.nativeCoalescedWhileBusy, true);
  assert.equal(result.freshTrailingPayload, true);
  assert.equal(result.afterPeriodic, 3);
  assert.equal(result.duringCooldown, 3);
  assert.equal(result.afterCooldown, 4);
  assert.equal(result.retiredPending, null);
  assert.equal(result.headerFailure, 'ACK_HTTP_TIMEOUT');
  assert.equal(result.bodyFailure, 'ACK_HTTP_TIMEOUT');
  assert.ok(result.headerMs >= 7900 && result.headerMs < 11000);
  assert.ok(result.bodyMs >= 7900 && result.bodyMs < 11000);
  assert.notEqual(result.cancellationFailure, 'ACK_HTTP_TIMEOUT');
  assert.deepEqual(result.retainedAfterTimeout, ['lost-receipt:completed']);
  assert.equal(result.releasedAckFlight, true);
  assert.deepEqual(result.sentAckIds, ['lost-receipt:completed', 'lost-receipt:completed']);
  assert.equal(result.remainingAfterReceipt, 0);
  for (const response of result.negativeResponses) {
    assert.ok([503, 429].includes(response.status));
    assert.equal(response.aborted, true);
    assert.equal(response.retained, true);
    assert.equal(response.released, true);
    assert.ok(response.elapsedMs < 2000, 'non-success headers must abort their unread body promptly');
    assert.equal(response.cooldown, response.status === 429);
  }
  const errorCloseDeadline = Date.now() + 2000;
  while (closedErrorStreams.size < 2 && Date.now() < errorCloseDeadline) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.deepEqual([...closedErrorStreams].sort(), [429, 503], 'native fetch must close both stalled error streams');
  assert.equal(result.beforeReady, 0);
  assert.deepEqual(result.delivered, ['state', 'screenshot-hint', 'old-generation', 'replacement-generation']);
  assert.equal(result.replacementProgress, true);
  assert.equal(result.retainedIngressTails, 0);
  assert.equal(result.stale, true);
  assert.equal(result.authProgress, true);
  assert.equal(result.snapshots, 1);
  assert.equal(result.beforeColdHttp, 0);
  assert.equal(result.coldCommands, 1);
  assert.deepEqual(result.coldExpiredAcks, ['expired']);
  assert.deepEqual(result.acknowledgements, ['received', 'expired']);
  assert.equal(result.effects, 0);
  assert.equal(result.duplicateReconnects, 1);
  assert.equal(result.retiredReconnects, 1);

  // Real Chrome timers and a real local socket: reply once, then blackhole
  // application traffic without closing TCP. Protocol pong alone cannot hide it.
  probeServer = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => probeServer.once('listening', resolve));
  let replies = 0;
  let blackhole = false;
  probeServer.on('connection', socket => socket.on('message', raw => {
    const frame = JSON.parse(raw.toString());
    if (frame.type === 'auth') socket.send(JSON.stringify({ type: 'auth-success', transportProbeV1: true }));
    if (frame.type === 'transport-probe' && !blackhole) {
      replies++;
      socket.send(JSON.stringify({ type: 'transport-probe-reply', nonce: frame.nonce }));
    }
  }));
  const probePage = await context.newPage();
  const extensionOrigin = `chrome-extension://${new URL(worker.url()).hostname}`;
  await probePage.goto(`${extensionOrigin}/offscreen.html`);
  const port = probeServer.address().port;
  await probePage.evaluate(port => {
    handleWsConnect(`ws://127.0.0.1:${port}/ws`, { type: 'auth' }, 991,
      'native-probe-context', `http://127.0.0.1:${port}`);
  }, port);
  await probePage.waitForFunction(() => proxyAuthenticated && proxyTransportProbeSupported);
  const healthyUntil = Date.now() + 12_000;
  while (replies === 0 && Date.now() < healthyUntil) await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(replies, 1);
  assert.equal(await probePage.evaluate(() => wsStatus().transportOpen), true);
  blackhole = true;
  const blackholeAt = Date.now();
  await probePage.waitForFunction(() => !wsStatus().transportOpen, null, { timeout: 20_000 });
  assert.ok(Date.now() - blackholeAt < 20_000, 'awake blackhole must retire within twenty seconds');
  console.log('ClassPilot actual Chrome connection fault regressions passed.');
} finally {
  await context?.close();
  if (probeServer) {
    for (const socket of probeServer.clients) socket.terminate();
    await new Promise(resolve => probeServer.close(resolve));
  }
  if (negativeAckServer) {
    negativeAckServer.closeAllConnections();
    await new Promise(resolve => negativeAckServer.close(resolve));
  }
  assert.equal(dirname(realpathSync(profile)), realpathSync(tmpdir()));
  assert.ok(basename(profile).startsWith('classpilot-connection-reliability-'));
  rmSync(profile, { recursive: true, force: true });
}
