// Real-worker coverage for safe command diagnostics across durable ACK retries.
// Only school transports and identity are synthetic; storage, normalization,
// retry compaction, HTTP serialization and receipt draining are production code.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { waitForExtensionWorkerDeclarations } from './extension-worker-test-readiness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extension = resolve(process.env.CLASSPILOT_EXTENSION_PATH || join(root, 'extension'));
const profile = mkdtempSync(join(tmpdir(), 'classpilot-ack-diagnostics-'));
const executablePath = [process.env.CLASSPILOT_CHROME_PATH, chromium.executablePath(),
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find(path => path && existsSync(path));
assert.ok(executablePath, 'Chrome/Chromium is required');

let browser;
try {
  browser = await chromium.launchPersistentContext(profile, { executablePath, headless: true,
    args: ['--headless=new', '--enable-automation', '--no-proxy-server',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
      `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const worker = browser.serviceWorkers()[0] || await browser.waitForEvent('serviceworker', { timeout: 15_000 });
  await waitForExtensionWorkerDeclarations(worker);
  assert.equal(await worker.evaluate(() => chrome.runtime.getManifest().version),
    JSON.parse(readFileSync(join(extension, 'manifest.json'), 'utf8')).version);

  const report = await worker.evaluate(async () => {
    await authStateRestorePromise.catch(() => {});
    await classroomStateRestorePromise.catch(() => {});
    await studentAuthMutationTail.catch(() => {});
    const wakeDeadline = Date.now() + 15_000;
    while (!workerWakeSettled && Date.now() < wakeDeadline) await new Promise(done => setTimeout(done, 25));
    if (!workerWakeSettled) throw new Error('Synthetic ACK fixture requires completed worker wake');
    CONFIG.autoRegistrationPaused = true;
    if (chromeProfileRegistrationInFlight) await chromeProfileRegistrationInFlight.catch(() => {});
    advanceStudentAuthMutationGeneration();
    fetchWithBackoff = async () => new Response('{}', { status: 503 });
    sendHeartbeat = async () => {}; connectWebSocket = async () => {}; scheduleEventHeartbeat = () => {};
    recoverOffscreenWebSocketStatus = async () => true;
    if (wsConnectInFlight) await wsConnectInFlight.catch(() => {});
    Object.assign(CONFIG, { serverUrl: 'http://127.0.0.1:1', schoolId: 'ack-school', deviceId: 'ack-device',
      activeStudentId: 'ack-student', activeStudentSessionId: 'ack-session', studentToken: 'synthetic-token',
      identitySource: 'integration_test' });
    studentAuthInvalidating = false; studentAuthCommitPending = false;
    activateAuthenticatedContext('command-ack-diagnostics');
    const auth = captureAuthenticatedContext('ACK diagnostic fixture');
    adoptLicenseState(true, 'active', auth);
    schoolSettings = { enableTrackingHours: false, afterHoursMode: 'off' };
    schoolSettingsScope = schoolPolicyScopeForAuthContext(auth); schoolSettingsFetchedAt = Date.now();
    trackingState = TRACKING_STATES.ACTIVE;
    adoptNegotiatedProtocolState({ serverProtocolVersion: 3, acceptedCapabilities: [
      'scopedAuthorityChecksV1', 'classroomStateV1', 'commandAckReceiptV1', 'exactBindingAckV2',
    ] }, auth);
    observeStudentControlRevision(11, auth, 'ACK diagnostic authority');
    currentFabState = null; currentClassroomState = null;
    await discardCommandAckOutbox();
    if (commandAckFlushTimer) clearTimeout(commandAckFlushTimer);
    commandAckFlushTimer = null; commandAckFlushTimerAt = 0;
    scheduleCommandAckFlush = () => {};
    const sent = [];
    // Retire any late startup transport events before installing the fixture.
    wsConnectionGeneration += 1;
    wsConnected = true; wsTransportConnected = true;
    wsSend = async value => { sent.push(JSON.parse(JSON.stringify(value))); return true; };
    const project = rows => rows.map(({ commandId, error, errorCode }) => ({ commandId, error, errorCode }));
    const binding = { studentId: auth.studentId, studentSessionId: auth.studentSessionId };

    // This uses the real authority rejection and real failure-ACK creation.
    await handleRemoteControl({ type: 'close-tabs', commandId: 'actual-inactive-class', ...binding,
      authority: { kind: 'teaching_session', teachingSessionId: 'retired-class' },
      data: { closeAll: true } }, { commandId: 'actual-inactive-class', ...binding,
      deliveryPolicy: 'transient_action', expiresAt: new Date(Date.now() + 60_000).toISOString() });

    const expected = [{ commandId: 'actual-inactive-class',
      error: 'Command belongs to an inactive teaching session', errorCode: 'COMMAND_AUTHORITY_MISMATCH' }];
    for (const [index, message] of [...COMMAND_DIAGNOSTIC_TEXT_ALLOWLIST].entries()) {
      const commandId = `allowlisted-${index}`;
      const error = commandErrorMessage({ message, code: 'COMMAND_AUTHORITY_MISMATCH' });
      await sendCommandAck(commandId, 'failed', { authContext: auth, binding, commandType: 'close-tabs',
        error, errorCode: 'COMMAND_AUTHORITY_MISMATCH' });
      expected.push({ commandId, error: message, errorCode: 'COMMAND_AUTHORITY_MISMATCH' });
    }
    const secret = 'Synthetic Student https://private.example/?token=synthetic-secret body';
    const rawBase = { ackState: 'failed', commandType: 'close-tabs', bindingVersion: 2,
      schoolId: auth.schoolId, deviceId: auth.deviceId, ...binding, studentControlRevision: 11 };
    await enqueueCommandAck({ ...rawBase, commandId: 'unknown-text', error: secret,
      errorCode: 'UNKNOWN_SYNTHETIC_CODE' }, auth);
    expected.push({ commandId: 'unknown-text', error: COMMAND_DIAGNOSTIC_MESSAGES.COMMAND_FAILED, errorCode: 'COMMAND_FAILED' });
    await enqueueCommandAck({ ...rawBase, commandId: 'allowlist-suffix',
      error: `Command belongs to an inactive teaching session ${secret}`, errorCode: 'COMMAND_AUTHORITY_MISMATCH' }, auth);
    expected.push({ commandId: 'allowlist-suffix', error: COMMAND_DIAGNOSTIC_MESSAGES.COMMAND_AUTHORITY_MISMATCH,
      errorCode: 'COMMAND_AUTHORITY_MISMATCH' });
    await enqueueCommandAck({ ...rawBase, commandId: 'code-only', errorCode: 'TAB_CLOSE_FAILED' }, auth);
    expected.push({ commandId: 'code-only', error: COMMAND_DIAGNOSTIC_MESSAGES.TAB_CLOSE_FAILED, errorCode: 'TAB_CLOSE_FAILED' });
    const stored = (await durableLocalKv.get(COMMAND_ACK_OUTBOX_KEY))[COMMAND_ACK_OUTBOX_KEY];
    // Exercise the on-disk JSON shape again before real retry compaction.
    await durableLocalKv.set({ [COMMAND_ACK_OUTBOX_KEY]: JSON.parse(JSON.stringify(stored)) });
    const immediate = project(sent.filter(ack => ack.ackState === 'failed'));
    sent.length = 0;

    const httpAttempts = [];
    let acceptReceipts = false;
    waitForApiBackoff = async () => {};
    fetchWithBackoff = async (_url, options) => {
      const body = JSON.parse(options.body);
      httpAttempts.push(body);
      return new Response(JSON.stringify(acceptReceipts ? { receipts: body.acks.map(ack => ({
        ackId: ack.ackId, commandId: ack.commandId, accepted: true, disposition: 'applied', retryable: false,
      })) } : {}), { status: acceptReceipts ? 200 : 503, headers: { 'content-type': 'application/json' } });
    };
    await flushCommandAckOutbox({ forceHttp: true });
    const afterRetry = (await durableLocalKv.get(COMMAND_ACK_OUTBOX_KEY))[COMMAND_ACK_OUTBOX_KEY];
    const wsRetry = project(sent.filter(ack => ack.ackState === 'failed'));
    acceptReceipts = true;
    await flushCommandAckOutbox({ forceHttp: true });
    const final = (await durableLocalKv.get(COMMAND_ACK_OUTBOX_KEY))[COMMAND_ACK_OUTBOX_KEY];
    return { expected, immediate, stored: project(stored), wsRetry, afterRetry: project(afterRetry),
      httpAttempts: httpAttempts.map(body => project(body.acks)), remaining: final?.length || 0,
      privateDiagnosticLeaked: JSON.stringify({ stored, sent, httpAttempts }).includes(secret),
      exactBindingRetained: afterRetry.every(ack => ack.bindingVersion === 2 && ack.schoolId === auth.schoolId
        && ack.studentId === auth.studentId && ack.studentSessionId === auth.studentSessionId
        && ack.deviceId === auth.deviceId && ack.studentControlRevision === 11) };
  });

  assert.equal(report.immediate.length, report.expected.length - 3, 'each directly sent failure must emit an immediate ACK');
  assert.deepEqual(report.immediate, report.expected.slice(0, report.immediate.length),
    'the actual command failure must emit its precise safe diagnostic immediately');
  for (const [stage, rows] of Object.entries({ stored: report.stored, wsRetry: report.wsRetry,
    afterRetry: report.afterRetry, httpFailure: report.httpAttempts[0], httpAccepted: report.httpAttempts[1] })) {
    assert.deepEqual(rows, report.expected, `${stage} must retain safe precise diagnostics without arbitrary error text`);
  }
  assert.equal(report.remaining, 0, 'the matching server receipt must drain the durable outbox');
  assert.equal(report.privateDiagnosticLeaked, false, 'unknown diagnostic content must not enter durable storage or retry transport');
  assert.equal(report.exactBindingRetained, true, 'diagnostic preservation must not weaken ACK binding');
  console.log('PASS command ACK diagnostics: precise safe reasons survive storage, WebSocket and HTTP retries; unknown text is redacted.');
} finally {
  if (browser) await browser.close();
  assert.ok(resolve(profile).startsWith(`${resolve(tmpdir())}${sep}classpilot-ack-diagnostics-`));
  rmSync(profile, { recursive: true, force: true });
}
