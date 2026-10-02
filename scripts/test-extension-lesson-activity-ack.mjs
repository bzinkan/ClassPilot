// Lesson-activity acknowledgement regression proof for 2.10.0 (real Chrome).
//
// SchoolPilot frames lesson-activity start/update as transient commands whose
// data always owns `resources` (default []; links otherwise) and never carries
// a classroom snapshot; the student's authoritative Class tools snapshot
// arrives separately as a fab-state-sync frame, in either order. The 2.10.0
// candidate refused every snapshot-less command whose data owned `resource` or
// `resources`, so each start/update was acknowledged failed with
// PRECISE_RESTRICTION_INVALID after its received ACK. The teacher sees each one
// failed, and a failed start also hides the activity from the student:
// readStudentToolsSnapshot shows an activity only while its start command's
// target is requested/sent/received/completed. 2.9.6 completed both.
// SchoolPilot's precise rule is narrower: only a lock-screen `resource` and an
// apply-flight-path `resources` require an authoritative snapshot.
//
// All frames go through handleWsMessage in the unpacked extension; ACKs are
// read from the real outbound transport. Only school transports are synthetic.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { waitForExtensionWorkerDeclarations } from './extension-worker-test-readiness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extension = resolve(process.env.CLASSPILOT_EXTENSION_PATH || join(root, 'extension'));
const profile = mkdtempSync(join(tmpdir(), 'classpilot-lesson-activity-ack-'));
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
    body: '<!doctype html><title>Lesson fixture</title><h1>Lesson fixture</h1>' }).catch(() => {}));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15_000 });
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
    Object.assign(CONFIG, { serverUrl: 'http://127.0.0.1:1', schoolId: 'lesson-school', deviceId: 'lesson-device',
      activeStudentId: 'lesson-student', activeStudentSessionId: 'lesson-login', studentToken: 'synthetic-token',
      identitySource: 'integration_test' });
    studentAuthInvalidating = false; studentAuthCommitPending = false;
    activateAuthenticatedContext('lesson-activity-auth');
    const auth = captureAuthenticatedContext('Lesson activity fixture');
    adoptLicenseState(true, 'active', auth);
    schoolSettings = { enableTrackingHours: false, afterHoursMode: 'off' };
    schoolSettingsScope = schoolPolicyScopeForAuthContext(auth); schoolSettingsFetchedAt = Date.now();
    trackingState = TRACKING_STATES.ACTIVE;
    await kv.set({ [SCHOOL_SETTINGS_CACHE_KEY]: schoolSettings, [SCHOOL_SETTINGS_SCOPE_KEY]: schoolSettingsScope,
      [SCHOOL_SETTINGS_FETCHED_AT_KEY]: schoolSettingsFetchedAt });
    const toolCapabilities = ['helpRequestsV1', 'questionParkingV1', 'timerControlsV1', 'lessonActivitiesV1', 'exitTicketsV1'];
    adoptNegotiatedProtocolState({ serverProtocolVersion: 3, acceptedCapabilities: ['scopedAuthorityChecksV1',
      'classroomStateV1', 'preciseRestrictionResourcesV1', ...toolCapabilities] }, auth);
    const sent = [];
    wsConnected = true;
    wsSend = value => { sent.push(value); return true; };

    const classId = 'lesson-activity-class';
    let controlRevision = 30;
    let messageSequence = 0;
    const binding = { studentId: auth.studentId, studentSessionId: auth.studentSessionId };
    const exactBinding = value => ({ bindingVersion: 2, schoolId: auth.schoolId, deviceId: auth.deviceId,
      studentId: auth.studentId, studentSessionId: auth.studentSessionId, controlRevision: value });
    const authority = { authority: { teachingSessionId: classId, supervisionContextId: null },
      teachingSessionId: classId, supervisionContextId: null };
    const deliver = frame => handleWsMessage(JSON.stringify(frame), wsConnectionGeneration, auth);
    const acks = commandId => sent.filter(message => message.commandId === commandId)
      .map(ack => `${ack.ackState}:${ack.outcome}${ack.errorCode ? `:${ack.errorCode}` : ''}`);

    // Fixture SchoolPilot: the persisted activity plus each start command's
    // target status, which the real ACK stream drives.
    const server = { toolsRevision: 1, activity: null, startCommandId: null };
    const targetStatus = commandId => sent.filter(message => message.commandId === commandId).at(-1)?.ackState || 'sent';
    const studentToolsSnapshot = () => ({ phase: 3, revision: server.toolsRevision, capabilities: toolCapabilities,
      help: null, questions: [], timer: null,
      activity: server.activity && ['requested', 'sent', 'received', 'completed'].includes(targetStatus(server.startCommandId))
        ? { ...server.activity, progress: { status: 'not_reported', completedItemIds: [], revision: 0 } } : null });
    const pushSnapshot = async () => {
      const ownership = controlRevision;
      await deliver({ type: 'fab-state-sync', _msgId: `lesson-fab-${++messageSequence}`, exactBinding: exactBinding(ownership), data: {
        schemaVersion: 1, ...binding, ownershipRevision: ownership, teachingSessionId: classId, lifecycleRevision: 1, revision: 1,
        activeSessionIds: [classId], activeContexts: [{ teachingSessionId: classId }], messagingEnabled: true,
        handRaisingEnabled: true, messagesPaused: false, pauseReason: null, handRaised: false, activeHands: [],
        classTools: studentToolsSnapshot(),
        sessions: [{ sessionId: classId, messagingEnabled: true, handRaisingEnabled: true, messagesPaused: false,
          pauseReason: null, handRaised: false, lifecycleRevision: 1 }] } });
    };
    const transientCommand = (type, data) => {
      const commandId = `lesson-command-${++messageSequence}`;
      const delivery = { deliveryPolicy: 'transient_action', expiresAt: new Date(Date.now() + 15_000).toISOString() };
      return { commandId, frame: { type: 'remote-control', _msgId: `lesson-frame-${commandId}`, commandId, ...binding, ...delivery,
        command: { type, commandId, ...binding, ...delivery, ...authority, data: { ...data, commandId } } } };
    };
    await pushSnapshot();
    if (!activeTeachingSessionIds().includes(classId)) throw new Error('FAB frame did not establish the teaching session');

    const reference = [{ title: 'Fraction strips', url: 'https://example.test/fraction-strips' }];
    const expiresAt = new Date(Date.now() + 3_600_000).toISOString();
    const lessonCases = [
      { action: 'start', order: 'command-first', resources: [] },
      { action: 'update', order: 'command-first', resources: reference },
      { action: 'start', order: 'snapshot-first', resources: reference },
      { action: 'update', order: 'snapshot-first', resources: [] },
      { action: 'start', order: 'snapshot-first', resources: [] },
      { action: 'update', order: 'snapshot-first', resources: reference },
      { action: 'start', order: 'command-first', resources: reference },
      { action: 'update', order: 'command-first', resources: [] },
    ];
    const lessonOutcomes = [];
    let activitySequence = 0;
    for (const lesson of lessonCases) {
      const content = { title: `Fractions ${lesson.action} ${lesson.order} ${lesson.resources.length}`,
        instructions: 'Compare the two fractions.', resources: lesson.resources,
        checklist: [{ id: 'compare', text: 'Compare the fractions' }] };
      let payload;
      if (lesson.action === 'start') {
        const activityId = `activity-${++activitySequence}`;
        payload = { ...content, action: 'start', activityId, revision: 1, activityExpiresAt: expiresAt };
      } else {
        const { activityId, revision } = server.activity;
        payload = { action: 'update', activityId, expectedRevision: revision, ...content,
          revision: revision + 1, activityExpiresAt: expiresAt };
      }
      const { commandId, frame } = transientCommand('lesson-activity', payload);
      // prepare/persistToolsCommand commit the activity before dispatch.
      server.activity = { activityId: payload.activityId, revision: payload.revision, ...content, expiresAt };
      if (lesson.action === 'start') server.startCommandId = commandId;
      server.toolsRevision++;
      if (lesson.order === 'command-first') { await deliver(frame); await pushSnapshot(); }
      else { await pushSnapshot(); await deliver(frame); }
      await studentAuthMutationTail.catch(() => {});
      const adopted = currentFabState?.classTools?.activity || null;
      // A later snapshot (reconnect, heartbeat sync, another tools change) is
      // built from the start command's acknowledged target status.
      server.toolsRevision++;
      await pushSnapshot();
      const resynced = currentFabState?.classTools?.activity || null;
      const summary = activity => activity && { activityId: activity.activityId, revision: activity.revision,
        title: activity.title, resources: activity.resources };
      lessonOutcomes.push({ ...lesson, resources: lesson.resources.length, acks: acks(commandId),
        adopted: summary(adopted), resynced: summary(resynced),
        expected: summary({ ...server.activity }) });
    }

    // Precise Waypoint and Flight Path commands keep their snapshot fence.
    const section = { type: 'section', hostname: 'example.edu', includeSubdomains: false, pathPrefix: '/class' };
    const persistentCommand = async (type, data, restrictions) => {
      let value = controlRevision;
      if (restrictions) {
        // A precise snapshot is installed only at the worker's current exact
        // control revision (unchanged here); a real FAB frame advances it.
        value = ++controlRevision;
        await pushSnapshot();
      }
      const commandId = `precise-command-${++messageSequence}`;
      const delivery = { deliveryPolicy: 'persistent_control', expiresAt: new Date(Date.now() + 60_000).toISOString() };
      const exact = { ...binding, exactBinding: exactBinding(value) };
      await deliver({ type: 'remote-control', _msgId: `precise-frame-${commandId}`, commandId, ...exact, ...delivery,
        command: { type, commandId, ...exact, ...delivery, ...authority, data: { ...data, commandId } },
        ...(restrictions ? { classroomState: { schemaVersion: 1, revision: value, teachingSessionId: classId,
          hardExpiresAt: Date.now() + 600_000, restrictions } } : {}) });
      await studentAuthMutationTail.catch(() => {});
      return { acks: acks(commandId), screenLock: currentClassroomState?.restrictions?.screenLock?.resource || null,
        flightPath: currentClassroomState?.restrictions?.flightPath?.resources || null,
        revision: currentClassroomState?.revision ?? null };
    };
    const waypoint = { url: 'https://example.edu/class', resource: section };
    const path = { flightPathId: 'lesson-sources', flightPathName: 'Lesson sources', allowedDomains: [], resources: [section] };
    const precise = {
      waypointWithoutSnapshot: await persistentCommand('lock-screen', waypoint),
      flightPathWithoutSnapshot: await persistentCommand('apply-flight-path', path),
      // SchoolPilot's rule is key presence: an empty `resources` is precise too.
      emptyFlightPathResourcesWithoutSnapshot: await persistentCommand('apply-flight-path', { ...path, resources: [] }),
      waypointWithSnapshot: await persistentCommand('lock-screen', waypoint,
        { screenLock: { active: true, url: 'https://example.edu/class', domain: 'example.edu', resource: section } }),
      flightPathWithSnapshot: await persistentCommand('apply-flight-path', path,
        { flightPath: { active: true, allowedDomains: [], resources: [section], name: 'Lesson sources' } }),
    };
    return { lessonOutcomes, precise };
  });

  const report = JSON.stringify(result, null, 2);
  assert.equal(result.lessonOutcomes.length, 8);
  for (const outcome of result.lessonOutcomes) {
    const label = `${outcome.action} ${outcome.order} with ${outcome.resources} resource(s)`;
    assert.deepEqual(outcome.acks, ['received:pending', 'completed:applied'],
      `lesson-activity ${label} must be acknowledged completed, never failed: ${report}`);
    assert.deepEqual(outcome.adopted, outcome.expected, `${label}: the Class tools snapshot was not adopted: ${report}`);
    assert.deepEqual(outcome.resynced, outcome.expected, `${label}: the student lost the activity on the next snapshot: ${report}`);
  }
  for (const order of ['command-first', 'snapshot-first']) {
    for (const action of ['start', 'update']) {
      for (const resources of [0, 1]) {
        assert.ok(result.lessonOutcomes.some(outcome => outcome.order === order && outcome.action === action
          && outcome.resources === resources), `missing lesson case ${action} ${order} ${resources}`);
      }
    }
  }
  const { precise } = result;
  const section = { type: 'section', hostname: 'example.edu', includeSubdomains: false, pathPrefix: '/class' };
  for (const name of ['waypointWithoutSnapshot', 'flightPathWithoutSnapshot', 'emptyFlightPathResourcesWithoutSnapshot']) {
    assert.deepEqual(precise[name].acks, ['received:pending', 'failed:failed:PRECISE_RESTRICTION_INVALID'],
      `${name} must still require its authoritative snapshot: ${report}`);
    assert.equal(precise[name].screenLock, null, `${name} installed a Waypoint: ${report}`);
    assert.equal(precise[name].flightPath, null, `${name} installed a Flight Path: ${report}`);
  }
  assert.deepEqual(precise.waypointWithSnapshot.acks, ['received:pending', 'completed:applied'], report);
  assert.deepEqual(precise.waypointWithSnapshot.screenLock, section, report);
  assert.deepEqual(precise.flightPathWithSnapshot.acks, ['received:pending', 'completed:applied'], report);
  assert.deepEqual(precise.flightPathWithSnapshot.flightPath, [section], report);
  console.log(JSON.stringify({ lessonActivityAcknowledgements: result }, null, 2));
  console.log('PASS lesson-activity start/update complete in both orders with and without links; precise commands keep their snapshot fence');
} finally {
  if (context) await context.close().catch(() => {});
  rmSync(profile, { recursive: true, force: true });
}
