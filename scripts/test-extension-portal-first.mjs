import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// Real extension worker, Chrome navigation and DNR; identity-provider pages
// and the API are controlled fixtures. No real student/provider credentials.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(process.env.CLASSPILOT_EXTENSION_PATH || join(root, 'extension'));
const caps = ['scopedAuthorityChecksV1', 'restrictionAuthPassThroughV1', 'restrictionPortalFirstV1'];
const schoolId = 'portal-fixture-school';
const portalUrl = 'https://clever.com/in/portal-fixture';
const authUrl = 'https://accounts.google.com/portal-fixture';
const lessonUrl = 'https://www.ixl.com/math/grade-5?lesson=one';
const blockedUrl = 'https://unapproved.portal-fixture.test/game';
const otherLessonUrl = 'https://math.portal-fixture.test/practice';

function removeOwnedTemporaryDirectory(directory) {
  const tempRoot = resolve(tmpdir());
  const target = resolve(directory);
  const child = relative(tempRoot, target);
  assert.ok(child && !child.startsWith('..') && !child.includes(':'));
  assert.ok(target.startsWith(join(tempRoot, 'classpilot-portal-')));
  rmSync(target, { recursive: true, force: true });
}

async function until(check, label, timeout = 10_000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await new Promise((done) => setTimeout(done, 50));
  }
  throw new Error(`Timed out: ${label}`);
}

async function navigationProxy(directory, documents) {
  // Chrome-created tabs can issue their first request before Playwright attaches
  // routing. A local TLS proxy keeps those requests offline without changing
  // the real provider URLs seen by Chrome DNR and extension host validation.
  const keyPath = join(directory, 'fixture-key.pem'), certPath = join(directory, 'fixture-cert.pem');
  const openssl = process.env.CLASSPILOT_OPENSSL_PATH || (
    process.platform === 'win32' && existsSync('C:/Program Files/Git/usr/bin/openssl.exe')
      ? 'C:/Program Files/Git/usr/bin/openssl.exe' : 'openssl'
  );
  execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=classpilot-navigation-fixture', '-keyout', keyPath, '-out', certPath], {
    windowsHide: true, stdio: 'ignore',
  });
  const https = createHttpsServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (request, response) => {
    const url = new URL(request.url, `https://${request.headers.host}`);
    if (request.headers['sec-fetch-dest'] === 'document') documents.push(url.toString());
    let html;
    if (url.hostname === 'clever.com') {
      html = `<h1>Student portal</h1><a href="${authUrl}">Sign in with Google</a>
        <a href="${lessonUrl}">IXL</a><a href="${lessonUrl}" target="_blank">IXL in new tab</a>
        <a href="${otherLessonUrl}" target="_blank">More math</a>
        <a href="${blockedUrl}" target="_blank">Unapproved app</a>`;
    } else if (url.hostname === 'accounts.google.com') {
      html = `<h1>Fixture identity provider</h1><a href="${portalUrl}?callback=complete">Continue to portal</a>`;
    } else if (url.hostname === 'www.ixl.com' || url.hostname === 'math.portal-fixture.test') {
      html = '<h1>Allowed lesson</h1><a href="https://www.ixl.com/math/grade-6?lesson=two#practice">Next lesson</a>';
    } else html = '<h1>Outside classroom boundary</h1>';
    response.writeHead(200, { 'content-type': 'text/html' });
    response.end(`<!doctype html><html><body>${html}</body></html>`);
  });
  const proxy = createServer((_request, response) => { response.writeHead(502); response.end('HTTPS fixture only'); });
  const sockets = new Set();
  proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  proxy.on('connect', (_request, socket, head) => {
    socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head.length) socket.unshift(head);
    https.emit('connection', socket);
  });
  await new Promise(done => proxy.listen(0, '127.0.0.1', done));
  return {
    address: `http://127.0.0.1:${proxy.address().port}`,
    close: async () => { for (const socket of sockets) socket.destroy(); await new Promise(done => proxy.close(done)); },
  };
}

function snapshot(kind, login = false, revisions = {}) {
  const { controlRevision = 1, policyRevision = 2 } = revisions;
  return {
    schemaVersion: 1, revision: controlRevision, teachingSessionId: 'portal-fixture-class',
    receivedAt: new Date().toISOString(), hardExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    ...(login ? { deliveryContext: { portalFirstOnLogin: true } } : {}),
    authPassThroughPolicyRevision: policyRevision,
    authPassThrough: {
      schemaVersion: 1, policyRevision, defaultProfileId: 'clever', attemptTtlSeconds: 300,
      profiles: [
        { id: 'clever', name: 'Clever', startUrl: portalUrl, hostRules: [
          { hostname: 'clever.com', includeSubdomains: true },
          { hostname: 'accounts.google.com', includeSubdomains: false },
        ] },
        { id: 'google', name: 'Google', startUrl: authUrl, hostRules: [
          { hostname: 'accounts.google.com', includeSubdomains: false },
        ] },
      ].filter(profile => !revisions.cleverOnly || profile.id === 'clever'),
    },
    restrictions: {
      screenLock: kind === 'waypoint'
        ? { active: true, url: lessonUrl.split('?')[0], domain: 'ixl.com' } : { active: false },
      flightPath: kind === 'flightpath'
        ? { active: true, name: 'Math', allowedDomains: ['ixl.com', 'math.portal-fixture.test'] }
        : { active: false, allowedDomains: [] },
      blockList: { active: false, blockedDomains: [] },
      attentionMode: { active: false }, tabLimit: 4, temporaryAllows: [],
    },
  };
}

async function fixtureServer(kind) {
  const state = { loginNumber: 0, deviceId: null, loginPayloads: [], releaseCount: 0,
    controlRevision: 1, policyRevision: 2, cleverOnly: true, holdHeartbeats: false };
  const heartbeatWaiters = [];
  const releaseHeartbeats = () => {
    state.holdHeartbeats = false;
    for (const done of heartbeatWaiters.splice(0)) done();
  };
  function binding() {
    return {
      bindingVersion: 2, schoolId, studentId: 'portal-student',
      studentSessionId: `portal-session-${state.loginNumber}`,
      deviceId: state.deviceId, controlRevision: state.controlRevision,
    };
  }
  function authority() {
    return { schoolId, studentId: 'portal-student', studentSessionId: binding().studentSessionId,
      exactBinding: binding(), serverProtocolVersion: 3, acceptedCapabilities: caps };
  }
  const server = createServer(async (request, response) => {
    const url = new URL(request.url, 'http://fixture.test');
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
    let payload;
    if (url.pathname === '/api/extension/student-login') {
      state.loginNumber += 1;
      state.deviceId = body.deviceId;
      state.loginPayloads.push(body);
      payload = { ...authority(), success: true, studentToken: `fixture-token-${state.loginNumber}`,
        sessionRecovery: { token: 'R'.repeat(43) }, planStatus: 'active', manualExpiresInSeconds: 300,
        student: { id: 'portal-student', firstName: 'Portal', lastName: 'Student', email: 'portal@example.edu' },
        classroomState: snapshot(kind, true, state), monitoringPolicy: { mode: 'full' } };
    } else if (url.pathname === '/api/extension/login-config') {
      payload = { sharedSignInEnabled: true, loginMethod: 'name_pin', schoolId };
    } else if (url.pathname === '/api/extension/login-roster') {
      payload = { loginMethod: 'name_pin', grades: [{ value: '5', label: 'Grade 5' }],
        students: [{ id: 'portal-student', name: 'Portal Student', gradeLevel: '5', hasPin: true }] };
    } else if (url.pathname === '/api/extension/settings') {
      payload = { ...authority(), enableTrackingHours: false, afterHoursMode: 'full',
        schoolTimezone: 'America/New_York', blockedDomains: [], maxTabs: 4 };
    } else if (url.pathname === '/api/device/heartbeat') {
      if (state.holdHeartbeats) await new Promise(done => heartbeatWaiters.push(done));
      payload = { ...authority(), success: true, classroomState: snapshot(kind, false, state), monitoringPolicy: { mode: 'full' },
        screenshotPolicy: { mode: 'paused', captureAllowed: false } };
    } else if (url.pathname === '/api/school/status') {
      payload = { success: true, schoolActive: true, planStatus: 'active', licensed: true };
    } else if (url.pathname === '/api/extension/session-release') {
      state.releaseCount += 1;
      payload = { success: true };
    } else {
      payload = { success: true, ...authority() };
    }
    response.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    response.end(JSON.stringify(payload));
  });
  await new Promise((done) => server.listen(0, '127.0.0.1', done));
  return { server, state, authority, releaseHeartbeats, origin: `http://127.0.0.1:${server.address().port}` };
}

async function proveCommittedLoginWorkerCrash(context, worker, fixture, kind, workingPage) {
  for (const page of context.pages()) if (page !== workingPage) await page.close();
  const wasSignedIn = await worker.evaluate(() => hasStudentAuth());
  if (wasSignedIn) {
    await workingPage.goto(lessonUrl);
    await workingPage.getByRole('heading', { name: 'Allowed lesson', exact: true }).waitFor();
  } else {
    const priorState = await worker.evaluate(async () => {
      const local = await chrome.storage.local.get([CLASSROOM_STATE_STORAGE_KEY, RESTRICTION_AUTH_POLICY_FENCE_STORAGE_KEY]);
      return { hasSnapshot: Boolean(local[CLASSROOM_STATE_STORAGE_KEY]), hasFence: Boolean(local[RESTRICTION_AUTH_POLICY_FENCE_STORAGE_KEY]) };
    });
    assert.deepEqual(priorState, { hasSnapshot: false, hasFence: false }, 'first-ever login must have no prior desired state or policy fence');
  }
  fixture.state.holdHeartbeats = true;
  await worker.evaluate(() => {
    const complete = completeStudentAuthCommit;
    completeStudentAuthCommit = async (...args) => {
      await complete(...args);
      globalThis.portalFixturePausedAfterCommit = true;
      await new Promise(() => {});
    };
    // Only the test pauses here: the actual login has persisted and committed
    // its new exact binding, but has not applied the login classroom snapshot.
    void manualStudentLogin({ mode: 'pin', studentId: 'portal-student', pin: '2468' })
      .catch(error => { globalThis.portalFixtureLoginError = error.message; });
  });
  const pending = await until(() => worker.evaluate(async () => {
    if (!globalThis.portalFixturePausedAfterCommit) return null;
    const local = await chrome.storage.local.get(['restrictionPortalEntryV1', 'classroomControlStateV1']);
    return { signedIn: hasStudentAuth(), commitPending: studentAuthCommitPending,
      studentSessionId: CONFIG.activeStudentSessionId,
      publishedAuth: await getPublishableAuthGateState(),
      entry: local.restrictionPortalEntryV1, storedSnapshot: local.classroomControlStateV1 };
  }), 'pause after actual login commit and before snapshot');
  assert.equal(pending.signedIn, true);
  assert.equal(pending.commitPending, false);
  assert.equal(pending.publishedAuth.phase, 'loading', 'internal auth commit must not publish success before restrictions install');
  assert.equal(pending.publishedAuth.authRequired, true);
  assert.equal(pending.publishedAuth.studentName, null);
  assert.equal(pending.publishedAuth.studentEmail, null);
  assert.equal(pending.entry?.phase, 'pending');
  assert.ok(pending.storedSnapshot, 'crash must restore a real persisted classroom snapshot');
  assert.equal(pending.storedSnapshot.authPassThrough, undefined, 'provider URLs must not be persisted');
  assert.equal(context.pages().some(page => page.url().startsWith(portalUrl)), false);

  const probe = await context.newPage();
  await probe.goto('chrome://version');
  const cdp = await context.newCDPSession(probe);
  const versions = new Map();
  const workerUrl = worker.url();
  cdp.on('ServiceWorker.workerVersionUpdated', event => {
    for (const version of event.versions || []) versions.set(version.versionId, version);
  });
  await cdp.send('ServiceWorker.enable');
  const version = await until(() => [...versions.values()].find(value => value.scriptURL === workerUrl && value.runningStatus !== 'stopped'), 'live extension worker version');
  const { targetInfos } = await cdp.send('Target.getTargets');
  const oldTarget = targetInfos.find(target => target.type === 'service_worker' && target.url === workerUrl);
  assert.ok(oldTarget);
  await cdp.send('ServiceWorker.stopWorker', { versionId: version.versionId });
  await until(async () => !(await cdp.send('Target.getTargets')).targetInfos.some(target => target.targetId === oldTarget.targetId), 'actual extension worker termination');
  await cdp.detach();
  await probe.goto(lessonUrl);
  const restoredWorker = await until(async () => {
    for (const candidate of [...context.serviceWorkers()].reverse()) {
      if (candidate.url() !== workerUrl) continue;
      if (await candidate.evaluate(() => globalThis.portalFixturePausedAfterCommit !== true).catch(() => false)) return candidate;
    }
    return null;
  }, 'new worker after committed login crash');
  await restoredWorker.evaluate(async () => { await authStateRestorePromise; await classroomStateRestorePromise; });
  const restored = await restoredWorker.evaluate(async () => ({
    signedIn: hasStudentAuth(), studentSessionId: CONFIG.activeStudentSessionId,
    entry: (await chrome.storage.local.get('restrictionPortalEntryV1')).restrictionPortalEntryV1,
    hasPolicy: Boolean(currentClassroomState?.authPassThrough),
    publishedAuth: await getPublishableAuthGateState(),
  }));
  assert.equal(restored.signedIn, true, 'a completed login must survive worker termination');
  assert.equal(restored.studentSessionId, pending.studentSessionId);
  assert.equal(restored.entry?.phase, 'pending', 'stripped local snapshot must not cancel pending portal entry');
  assert.equal(restored.hasPolicy, false, 'provider authority must await the fresh server snapshot');
  assert.equal(restored.publishedAuth.phase, 'loading', 'restored pending restrictions must keep the sign-in presentation loading');
  assert.equal(restored.publishedAuth.authRequired, true);
  assert.equal(restored.publishedAuth.studentName, null);
  assert.equal(restored.publishedAuth.studentEmail, null);
  fixture.releaseHeartbeats();
  const envelope = { ...fixture.authority(), classroomState: snapshot(kind, false, fixture.state) };
  assert.equal(envelope.classroomState.deliveryContext, undefined, 'worker recovery receives no replayed login marker');
  await restoredWorker.evaluate(async response => {
    const authContext = captureAuthenticatedContext('fresh post-crash policy fixture');
    adoptNegotiatedProtocolState(response, authContext);
    await applyClassroomStateFromAuthResponse(response, 'fresh post-crash policy fixture', { authContext, requireApplied: true });
  }, envelope);
  const restoredPortal = await until(() => context.pages().find(page => page.url().startsWith(portalUrl)), 'pending portal entry after fresh markerless authority');
  await restoredPortal.getByRole('heading', { name: 'Student portal', exact: true }).waitFor();
  await until(() => restoredWorker.evaluate(() => restrictionPortalEntryState?.phase === 'entered'), 'post-crash portal entry consumed');
  const publishedAuth = await restoredWorker.evaluate(() => getPublishableAuthGateState());
  assert.equal(publishedAuth.phase, 'authenticated', 'fresh policy installation must release authenticated presentation');
  assert.equal(publishedAuth.authRequired, false);
  assert.equal(publishedAuth.studentName, 'Portal Student');
  assert.equal(publishedAuth.studentEmail, 'portal@example.edu');
  console.log(`${kind} ${wasSignedIn ? 'repeat' : 'first-ever'} login: real worker termination after commit preserved pending intent until fresh exact markerless snapshot`);
  return restoredWorker;
}

async function scenario(kind, { firstLoginCrash = false } = {}) {
  const fixture = await fixtureServer(kind);
  const extensionPath = mkdtempSync(join(tmpdir(), 'classpilot-portal-extension-'));
  const profilePath = mkdtempSync(join(tmpdir(), 'classpilot-portal-profile-'));
  const executablePath = [process.env.CLASSPILOT_CHROME_PATH, chromium.executablePath(),
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find((p) => p && existsSync(p));
  assert.ok(executablePath, 'Chrome for Testing must be installed');
  let context, worker, proxy;
  const workerMessages = [];
  try {
    cpSync(source, extensionPath, { recursive: true });
    writeFileSync(join(extensionPath, 'config.js'), `globalThis.CLASSPILOT_SERVER_URL = ${JSON.stringify(fixture.origin)};\n`);
    const documents = [];
    proxy = await navigationProxy(profilePath, documents);
    const launch = () => chromium.launchPersistentContext(profilePath, {
      executablePath, headless: true, viewport: { width: 1200, height: 800 },
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`,
        `--proxy-server=${proxy.address}`, '--ignore-certificate-errors'],
    });
    context = await launch();
    const versionSession = await context.newCDPSession(context.pages()[0] || await context.newPage());
    const browserVersion = await versionSession.send('Browser.getVersion');
    console.log(`${kind}: browser ${browserVersion.product}`);
    await versionSession.detach();
    worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await worker.evaluate(async ({ serverUrl, fixtureSchool }) => {
      await chrome.storage.local.set({ config: { serverUrl, schoolId: fixtureSchool,
        schoolSlug: fixtureSchool, enrollmentKey: 'fixture-enrollment-key' } });
      await chrome.storage.session.clear();
    }, { serverUrl: fixture.origin, fixtureSchool: schoolId });
    await context.close();
    context = await launch();
    worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    worker.on('console', message => {
      if (['warning', 'error'].includes(message.type())) workerMessages.push(message.text().slice(0, 500));
    });
    await until(() => worker.evaluate(() => Boolean(CONFIG.schoolId && CONFIG.enrollmentKey)), 'school configuration');
    const start = context.pages()[0] || await context.newPage();
    // A Google dependency in the Clever profile must not be mistaken for the
    // configured Clever landing, even when it is already in the foreground.
    await start.goto(authUrl);
    documents.length = 0;
    if (firstLoginCrash) {
      worker = await proveCommittedLoginWorkerCrash(context, worker, fixture, kind, start);
      assert.equal(fixture.state.loginNumber, 1);
      return;
    }
    const login = await worker.evaluate(() => manualStudentLogin({ mode: 'pin', studentId: 'portal-student', pin: '2468' }));
    assert.equal(login.success, true, `${kind}: actual manual sign-in failed`);
    assert.ok(fixture.state.loginPayloads[0].capabilities.includes('restrictionPortalFirstV1'));
    const portal = await until(() => context.pages().find((p) => p.url().startsWith(portalUrl)), 'portal-first navigation');
    await portal.waitForSelector('h1');
    assert.equal(await portal.locator('h1').innerText(), 'Student portal');
    assert.equal(documents.some((url) => url.includes('ixl.com')), false, 'learning page opened before portal selection');
    assert.equal(fixture.state.releaseCount, 0, 'successful restricted login was released');
    const initialEntry = await until(() => worker.evaluate(async () => {
      await restrictionPortalEntryMutation;
      return restrictionPortalEntryState?.phase === 'entered' ? restrictionPortalEntryState : null;
    }), 'committed portal-entry ledger');

    await portal.getByRole('link', { name: 'Sign in with Google' }).click();
    await portal.getByRole('heading', { name: 'Fixture identity provider' }).waitFor();
    await portal.getByRole('link', { name: 'Continue to portal' }).click();
    await portal.getByRole('heading', { name: 'Student portal' }).waitFor();
    await worker.evaluate(async () => {
      await restrictionAuthAttemptMutation;
      await reconcileClassroomStateTabsBestEffort(currentClassroomState, { authContext: captureAuthenticatedContext('portal callback fixture') });
    });
    assert.equal(await portal.locator('h1').innerText(), 'Student portal', 'provider callback stole the portal');
    assert.equal(documents.some((url) => url.includes('ixl.com')), false, 'provider callback auto-launched a lesson');

    await portal.getByRole('link', { name: 'IXL', exact: true }).click();
    await portal.getByRole('heading', { name: 'Allowed lesson' }).waitFor();
    await portal.getByRole('link', { name: 'Next lesson' }).click();
    await portal.waitForURL('**/math/grade-6?lesson=two#practice');
    await portal.evaluate(() => { window.portalFixtureUnchanged = 'student-work'; });
    await worker.evaluate(async () => {
      await reconcileClassroomStateTabsBestEffort(currentClassroomState, { authContext: captureAuthenticatedContext('lesson preservation fixture') });
    });
    assert.equal(await portal.evaluate(() => window.portalFixtureUnchanged), 'student-work', 'allowed page reloaded');

    // New revisions on the same exact student session must not replay login
    // navigation or reload a student who is already working in a lesson.
    fixture.state.controlRevision += 1;
    fixture.state.policyRevision += 1;
    const update = { ...fixture.authority(), classroomState: snapshot(kind, false, fixture.state) };
    const portalVisitsBeforeUpdate = documents.filter(url => url.startsWith(portalUrl)).length;
    await worker.evaluate(async (envelope) => {
      await applyClassroomStateFromAuthResponse(envelope, 'portal policy update fixture', {
        authContext: captureAuthenticatedContext('portal policy update fixture'),
      });
      await reconcileClassroomStateTabsBestEffort(currentClassroomState, {
        authContext: captureAuthenticatedContext('same-binding replay fixture'),
      });
      await restrictionPortalEntryMutation;
    }, update);
    assert.equal(await portal.evaluate(() => window.portalFixtureUnchanged), 'student-work', 'policy update reloaded an allowed lesson');
    assert.equal(documents.filter(url => url.startsWith(portalUrl)).length, portalVisitsBeforeUpdate, 'policy update reopened the portal');
    assert.equal((await worker.evaluate(() => restrictionPortalEntryState)).scopeDigest, initialEntry.scopeDigest);

    await portal.goto(portalUrl);
    await portal.getByRole('heading', { name: 'Student portal' }).waitFor();
    await worker.evaluate(async () => {
      await restrictionAuthAttemptMutation;
      if (restrictionAuthAttemptState && ['in_progress', 'returning'].includes(restrictionAuthAttemptState.phase)) {
        restrictionAuthAttemptState = { ...restrictionAuthAttemptState, expiresAt: Date.now() - 1 };
        await handleRestrictionAuthAttemptExpiry();
      }
      await reconcileClassroomStateTabsBestEffort(currentClassroomState, { authContext: captureAuthenticatedContext('portal timeout fixture') });
    });
    assert.equal(await portal.locator('h1').innerText(), 'Student portal', 'auth timer removed portal access');
    const newLessonPromise = context.waitForEvent('page');
    await portal.getByRole('link', { name: 'IXL in new tab', exact: true }).click();
    const newLesson = await newLessonPromise;
    await newLesson.getByRole('heading', { name: 'Allowed lesson', exact: true }).waitFor();
    assert.ok(newLesson.url().startsWith(lessonUrl), 'teacher-approved new-tab app did not launch');
    assert.equal(await portal.locator('h1').innerText(), 'Student portal', 'launching an app replaced the portal');
    await newLesson.close();
    await portal.bringToFront();
    if (kind === 'flightpath') {
      const secondDestinationPromise = context.waitForEvent('page');
      await portal.getByRole('link', { name: 'More math', exact: true }).click();
      const secondDestination = await secondDestinationPromise;
      await secondDestination.getByRole('heading', { name: 'Allowed lesson', exact: true }).waitFor();
      assert.equal(secondDestination.url(), otherLessonUrl, 'Flight Path must allow its second approved site');
      await secondDestination.close();
      await portal.bringToFront();
    }
    await portal.getByRole('link', { name: 'Unapproved app', exact: true }).click();
    await worker.evaluate(async () => {
      await reconcileClassroomStateTabsBestEffort(currentClassroomState, { authContext: captureAuthenticatedContext('unapproved app fixture') });
    });
    await until(async () => (await worker.evaluate(() => chrome.tabs.query({})))
      .every(tab => tab.url !== blockedUrl && tab.pendingUrl !== blockedUrl), 'unapproved portal application closed or redirected');
    assert.equal(documents.includes(blockedUrl), false, 'Clever granted access to an unapproved app');

    // A content/worker handler may stop the portal click before a request is
    // made. Prove the network boundary independently from an already attached
    // tab, and observe Chrome's native navigation error before starting it.
    // Playwright can miss an extension-created popup's initial request event.
    // Reuse the attached page and remove prior popup results so the fixture's
    // four-tab limit cannot close a new probe before its allowed baseline loads.
    for (const page of context.pages()) if (page !== portal) await page.close();
    const dnrProbe = portal;
    await dnrProbe.goto(lessonUrl);
    await dnrProbe.getByRole('heading', { name: 'Allowed lesson', exact: true }).waitFor();
    await worker.evaluate(url => {
      globalThis.portalFixtureDnrErrors = [];
      globalThis.portalFixtureDnrListener = details => {
        if (details.url === url && details.frameId === 0) globalThis.portalFixtureDnrErrors.push(details.error);
      };
      chrome.webNavigation.onErrorOccurred.addListener(globalThis.portalFixtureDnrListener);
    }, blockedUrl);
    try {
      await dnrProbe.goto(blockedUrl).catch(() => {});
      await until(() => worker.evaluate(() => globalThis.portalFixtureDnrErrors
        .some(error => error.includes('ERR_BLOCKED_BY_CLIENT'))), 'native Chrome DNR main-frame denial');
      assert.equal(documents.includes(blockedUrl), false, 'the direct denied request reached the fixture server');
    } finally {
      await worker.evaluate(() => {
        chrome.webNavigation.onErrorOccurred.removeListener(globalThis.portalFixtureDnrListener);
        delete globalThis.portalFixtureDnrListener;
        delete globalThis.portalFixtureDnrErrors;
      });
    }
    await worker.evaluate(async () => {
      await reconcileClassroomStateTabsBestEffort(currentClassroomState, { authContext: captureAuthenticatedContext('post-DNR fixture recovery') });
    });
    // Chrome reports the denied network request before the worker's compliant
    // fallback navigation completes. Let that navigation settle before the
    // independent check that an approved URL remains usable.
    await dnrProbe.waitForLoadState('networkidle');
    await dnrProbe.goto(lessonUrl);
    await dnrProbe.getByRole('heading', { name: 'Allowed lesson', exact: true }).waitFor();

    // Remove all prior portal pages so a leftover tab cannot make the new
    // binding test pass. Preserve work on an approved page across sign-in.
    for (const page of context.pages()) {
      if (page !== portal) await page.close();
    }
    await portal.goto(lessonUrl);
    await portal.getByRole('heading', { name: 'Allowed lesson', exact: true }).waitFor();
    await portal.evaluate(() => { window.portalFixtureNewBindingWork = 'keep-me'; });
    assert.equal(context.pages().some(page => page.url().startsWith(portalUrl)), false);
    const previousSession = await worker.evaluate(() => CONFIG.activeStudentSessionId);
    const second = await worker.evaluate(() => manualStudentLogin({ mode: 'pin', studentId: 'portal-student', pin: '2468' }));
    assert.equal(second.success, true);
    const secondPortal = await until(() => context.pages().find((p) => p.url().startsWith(portalUrl)), 'second-session portal');
    await secondPortal.getByRole('heading', { name: 'Student portal', exact: true }).waitFor();
    const secondEntry = await until(() => worker.evaluate(async () => {
      await restrictionPortalEntryMutation;
      return restrictionPortalEntryState?.phase === 'entered' ? restrictionPortalEntryState : null;
    }), 'new binding portal-entry ledger');
    assert.notEqual(secondEntry.scopeDigest, initialEntry.scopeDigest);
    assert.notEqual(await worker.evaluate(() => CONFIG.activeStudentSessionId), previousSession);
    assert.equal(await portal.evaluate(() => window.portalFixtureNewBindingWork), 'keep-me', 'new sign-in reloaded retained approved work');
    assert.equal(fixture.state.loginNumber, 2);
    worker = await proveCommittedLoginWorkerCrash(context, worker, fixture, kind, portal);
    assert.equal(fixture.state.loginNumber, 3);
    console.log(`${kind}: actual login, callback without auto-jump, in-site/new-tab approved apps, Chrome DNR denial, timeout, same-session revision preservation, and new-binding portal entry passed`);
  } catch (error) {
    console.error(`${kind} fixture diagnostics`, JSON.stringify({
      pages: await Promise.all((context?.pages() || []).map(async page => ({
        url: page.url(), title: await page.title().catch(() => ''),
        body: (await page.locator('body').innerText().catch(() => '')).slice(0, 500),
      }))),
      worker: await worker?.evaluate(async () => ({
        signedIn: hasStudentAuth(), commitPending: studentAuthCommitPending,
        studentSessionId: CONFIG.activeStudentSessionId,
        capabilities: negotiatedProtocolState.acceptedCapabilities,
        portalEntry: restrictionPortalEntryState,
        classroomRevision: currentClassroomState?.revision,
        authPolicy: currentClassroomState?.authPassThrough,
        restrictions: currentClassroomState?.restrictions,
        dnr: await chrome.declarativeNetRequest.getDynamicRules(),
      })).catch(() => null),
      messages: workerMessages.slice(-12),
    }));
    throw error;
  } finally {
    await context?.close();
    fixture.releaseHeartbeats();
    await proxy?.close();
    await new Promise((done) => fixture.server.close(done));
    removeOwnedTemporaryDirectory(extensionPath);
    removeOwnedTemporaryDirectory(profilePath);
  }
}

await scenario('waypoint');
await scenario('flightpath');
await scenario('waypoint', { firstLoginCrash: true });
