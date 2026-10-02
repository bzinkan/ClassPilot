// Attention navigation regression proof for 2.10.0 (real Chrome, real events).
//
// 2.9.6 left URL changes inside the current document alone during Attention
// and blocked a new navigation silently; Attention's main-frame DNR rule blocks
// real loads. The 2.10.0 candidate also ran the navigation policy on
// onHistoryStateUpdated, onReferenceFragmentUpdated and onCommitted, so every
// pushState, replaceState, #fragment change and every navigation already in
// flight when Attention began was stepped back with a "Navigation Blocked"
// notification per step until the tab was about:blank. An Attention-suspended
// Focus tab was then retired as off policy instead of resuming. A navigation
// that starts while the Attention frame is being applied, and so reaches the
// serialized policy only after Attention took effect, is also left alone
// (2.9.6 and the candidate both stepped it back).
// The one silent step-back for a new navigation also must not retrigger itself:
// in a tab with several earlier documents, 2.9.6 and the candidate both blocked
// that step-back's own history traversal and kept stepping back. That kept
// step-back still costs the student the page: Attention's DNR rule blocks its
// load of the earlier page too, so the tab shows Chrome's "blocked" error page
// (or about:blank with no earlier entry) until the student reloads, as asserted
// below. A precise Waypoint stays enforced: an in-page move off its resource
// during Attention is reconciled when Attention is released and is redirected
// at once without it.
//
// The unpacked extension runs in Chromium. Classroom and FAB state arrive as
// SchoolPilot-shaped WebSocket frames through handleWsMessage. Navigation
// events, the navigation policy, Attention side effects (overlay broadcast and
// tab reconciliation), tab navigation, notifications, telemetry queueing and
// Focus maintenance are all native; only school transports are synthetic.
// Native calls are observed through call-through wrappers, never replaced.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { waitForExtensionWorkerDeclarations } from './extension-worker-test-readiness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extension = resolve(process.env.CLASSPILOT_EXTENSION_PATH || join(root, 'extension'));
const profile = mkdtempSync(join(tmpdir(), 'classpilot-attention-navigation-'));
const executablePath = [process.env.CLASSPILOT_CHROME_PATH, chromium.executablePath(),
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find(path => path && existsSync(path));
assert.ok(executablePath, 'Chrome/Chromium is required');
const origin = 'https://example.test';
const classId = 'attention-navigation-class';
const fixturePage = path => `<!doctype html><html><head><title>Attention fixture</title>
<script>window.__fixtureDocument = ${JSON.stringify(path)} + ':' + Math.random().toString(36).slice(2);</script>
</head><body><h1 id="fixture-path">${path}</h1><a id="next" href="/link-destination">Next lesson</a></body></html>`;

let context;
let releaseInflight = () => {};
let raceHoldRelease = () => {};
try {
  context = await chromium.launchPersistentContext(profile, { executablePath, headless: true,
    args: ['--headless=new', '--enable-automation', '--no-proxy-server',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
      `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
  const served = [];
  // Responses held until released, so a navigation stays in flight.
  const held = new Map();
  const holdResponse = pathname => {
    const entry = {};
    entry.requested = new Promise(done => { entry.markRequested = done; });
    entry.released = new Promise(done => { entry.release = done; });
    held.set(pathname, entry);
    return entry;
  };
  const inflightHold = holdResponse('/inflight-destination');
  releaseInflight = inflightHold.release;
  const raceHold = holdResponse('/race-destination');
  raceHoldRelease = raceHold.release;
  const bounded = (promise, message) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(message)), 15_000);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
  await context.route(/^https:\/\//, async route => {
    const { pathname } = new URL(route.request().url());
    served.push(pathname);
    const entry = held.get(pathname);
    if (entry) {
      entry.markRequested();
      await entry.released;
    }
    await route.fulfill({ status: 200, contentType: 'text/html', body: fixturePage(pathname) }).catch(() => {});
  });
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15_000 });
  await waitForExtensionWorkerDeclarations(worker);
  const loadedVersion = await worker.evaluate(() => chrome.runtime.getManifest().version);
  assert.equal(loadedVersion, JSON.parse(readFileSync(join(extension, 'manifest.json'), 'utf8')).version);

  await worker.evaluate(async ({ classId }) => {
    await authStateRestorePromise.catch(() => {}); await classroomStateRestorePromise.catch(() => {});
    await studentAuthMutationTail.catch(() => {});
    const wakeDeadline = Date.now() + 15_000;
    while (!workerWakeSettled && Date.now() < wakeDeadline) await new Promise(done => setTimeout(done, 25));
    if (!workerWakeSettled) throw new Error('Synthetic transport setup requires completed production worker wake');
    CONFIG.autoRegistrationPaused = true;
    if (chromeProfileRegistrationInFlight) await chromeProfileRegistrationInFlight.catch(() => {});
    advanceStudentAuthMutationGeneration();
    // School transports only. The navigation policy, Attention side effects,
    // tab navigation, notifications and telemetry queueing stay native.
    fetchWithBackoff = async () => new Response('{}', { status: 503 });
    sendHeartbeat = async () => {}; connectWebSocket = async () => {}; scheduleEventHeartbeat = () => {};
    recoverOffscreenWebSocketStatus = async () => true;
    if (wsConnectInFlight) await wsConnectInFlight.catch(() => {});
    Object.assign(CONFIG, { serverUrl: 'http://127.0.0.1:1', schoolId: 'attention-school', deviceId: 'attention-device',
      activeStudentId: 'attention-student', activeStudentSessionId: 'attention-login', studentToken: 'synthetic-token',
      identitySource: 'integration_test' });
    studentAuthInvalidating = false; studentAuthCommitPending = false;
    activateAuthenticatedContext('attention-navigation-auth');
    const auth = captureAuthenticatedContext('Attention navigation fixture');
    adoptLicenseState(true, 'active', auth);
    schoolSettings = { enableTrackingHours: false, afterHoursMode: 'off' };
    schoolSettingsScope = schoolPolicyScopeForAuthContext(auth); schoolSettingsFetchedAt = Date.now();
    trackingState = TRACKING_STATES.ACTIVE;
    await kv.set({ [SCHOOL_SETTINGS_CACHE_KEY]: schoolSettings, [SCHOOL_SETTINGS_SCOPE_KEY]: schoolSettingsScope,
      [SCHOOL_SETTINGS_FETCHED_AT_KEY]: schoolSettingsFetchedAt });
    adoptNegotiatedProtocolState({ serverProtocolVersion: 3, acceptedCapabilities: ['scopedAuthorityChecksV1',
      'classroomStateV1', 'focusTabV1', 'preciseRestrictionResourcesV1'] }, auth);
    const sent = [];
    wsConnected = true;
    wsSend = value => { sent.push(value); return true; };

    const record = { navigation: [], goBack: [], tabUrlUpdates: [], notifications: [], telemetry: [] };
    for (const name of ['onBeforeNavigate', 'onCommitted', 'onHistoryStateUpdated', 'onReferenceFragmentUpdated', 'onErrorOccurred']) {
      chrome.webNavigation[name].addListener(details => {
        if (details.frameId !== 0) return;
        record.navigation.push({ name, tabId: details.tabId, url: details.url,
          transitionType: details.transitionType ?? null, error: details.error ?? null });
      });
    }
    const nativeGoBack = chrome.tabs.goBack;
    chrome.tabs.goBack = function (tabId, ...rest) {
      record.goBack.push(tabId);
      return nativeGoBack.call(this, tabId, ...rest);
    };
    const nativeUpdate = chrome.tabs.update;
    chrome.tabs.update = function (tabId, properties, ...rest) {
      if (properties?.url) record.tabUrlUpdates.push({ tabId, url: properties.url });
      return nativeUpdate.call(this, tabId, properties, ...rest);
    };
    const nativeNotify = chrome.notifications.create;
    chrome.notifications.create = function (id, options, ...rest) {
      record.notifications.push({ id: String(id), title: options?.title ?? null });
      return nativeNotify.call(this, id, options, ...rest);
    };
    const queueMonitoringEvent = enqueueMonitoringEvent;
    enqueueMonitoringEvent = (type, metadata = {}, options = {}) => {
      if (type === 'navigation_blocked') record.telemetry.push({ url: metadata.url, policySource: metadata.policySource });
      return queueMonitoringEvent(type, metadata, options);
    };

    let revision = 20;
    let sequence = 0;
    const exactBinding = value => ({ bindingVersion: 2, schoolId: auth.schoolId, deviceId: auth.deviceId,
      studentId: auth.studentId, studentSessionId: auth.studentSessionId, controlRevision: value });
    const deliver = frame => handleWsMessage(JSON.stringify(frame), wsConnectionGeneration, auth);
    const counts = () => Object.fromEntries(Object.entries(record).map(([key, value]) => [key, value.length]));
    globalThis.__attentionFixture = {
      record, counts,
      since: mark => Object.fromEntries(Object.entries(record).map(([key, value]) => [key, value.slice(mark[key])])),
      async fab() {
        const value = revision++;
        await deliver({ type: 'fab-state-sync', _msgId: `attention-fab-${value}`, exactBinding: exactBinding(value), data: {
          schemaVersion: 1, studentId: auth.studentId, studentSessionId: auth.studentSessionId, ownershipRevision: value,
          teachingSessionId: classId, lifecycleRevision: 1, revision: 1, activeSessionIds: [classId],
          activeContexts: [{ teachingSessionId: classId }], messagingEnabled: false, handRaisingEnabled: false,
          messagesPaused: false, pauseReason: null, handRaised: false, activeHands: [], classTools: null,
          sessions: [{ sessionId: classId, messagingEnabled: false, handRaisingEnabled: false, messagesPaused: false,
            pauseReason: null, handRaised: false, lifecycleRevision: 1 }] } });
        return currentFabState?.activeSessionIds || [];
      },
      // A persistent classroom control exactly as SchoolPilot frames it: the
      // command, its exact binding and the full authoritative snapshot. Focus
      // data is the exact tab target only.
      async command(type, data, restrictions) {
        const value = revision++;
        const commandId = `attention-command-${++sequence}`;
        const delivery = { deliveryPolicy: 'persistent_control', expiresAt: new Date(Date.now() + 60_000).toISOString() };
        const binding = { studentId: auth.studentId, studentSessionId: auth.studentSessionId, exactBinding: exactBinding(value) };
        const authority = { authority: { teachingSessionId: classId, supervisionContextId: null },
          teachingSessionId: classId, supervisionContextId: null };
        await deliver({ type: 'remote-control', _msgId: `attention-frame-${commandId}`, commandId, ...binding, ...delivery,
          command: { type, commandId, ...binding, ...delivery, ...authority,
            data: type === 'focus-tab' ? { ...data } : { ...data, commandId } },
          classroomState: { schemaVersion: 1, revision: value, teachingSessionId: classId,
            hardExpiresAt: Date.now() + 600_000, restrictions } });
        return sent.filter(message => message.commandId === commandId)
          .map(ack => `${ack.ackState}:${ack.outcome}${ack.errorCode ? `:${ack.errorCode}` : ''}`);
      },
      // The same frame, started now and awaited later with finishCommand().
      startCommand(type, data, restrictions) {
        this.pendingCommand = this.command(type, data, restrictions);
        return true;
      },
      finishCommand() { return this.pendingCommand; },
      // Holds the next classroom runtime adoption, inside the policy queue and
      // before Attention takes effect, until released. The native adoption then
      // runs unchanged. A navigation started meanwhile waits its turn behind it.
      holdNextRuntimeAdoption() {
        let reached; let release;
        const reachedPromise = new Promise(done => { reached = done; });
        const released = new Promise(done => { release = done; });
        const nativeAdoption = setRuntimeFromClassroomState;
        setRuntimeFromClassroomState = async (...args) => {
          setRuntimeFromClassroomState = nativeAdoption;
          reached();
          await released;
          return nativeAdoption(...args);
        };
        this.releaseRuntimeAdoption = () => { release(); return true; };
        this.runtimeAdoptionHeld = () => new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('Attention never reached its runtime adoption')), 15_000);
          reachedPromise.then(() => { clearTimeout(timer); resolve(attentionModeActive); });
        });
        return true;
      },
      // SchoolPilot's classroom-state push frame (classpilotClassroomStatePushFrame).
      async state(restrictions) {
        const value = revision++;
        await deliver({ type: 'classroom-state', _msgId: `attention-state-${value}`, studentId: auth.studentId,
          studentSessionId: auth.studentSessionId, exactBinding: exactBinding(value),
          classroomState: { schemaVersion: 1, revision: value, teachingSessionId: classId,
            hardExpiresAt: Date.now() + 600_000, restrictions } });
        return { revision: currentClassroomState?.revision ?? null, attention: attentionModeActive,
          resource: currentClassroomState?.restrictions?.screenLock?.resource ?? null };
      },
      async waitForTabUrl(tabId, url, timeout = 10_000) {
        const deadline = Date.now() + timeout;
        let current = null;
        while (Date.now() < deadline) {
          current = await chrome.tabs.get(tabId).then(tab => tab.url, () => '<tab removed>');
          if (current === url) break;
          await new Promise(done => setTimeout(done, 25));
        }
        return current;
      },
      // The teacher selects a tab from the device's published opaque snapshot.
      // Use a revision that is stable across two reads, as a heartbeat would.
      async tabRef(tabId) {
        const deadline = Date.now() + 10_000;
        let previous = null;
        while (Date.now() < deadline) {
          const snapshot = await buildOpaqueTabSnapshot(await chrome.tabs.query({}), auth);
          const entry = snapshot.localEntries.find(value => value.tabId === tabId);
          if (entry?.tabRef && previous?.observedRevision === snapshot.revision && previous.tabRef === entry.tabRef) return previous;
          previous = entry?.tabRef ? { tabRef: entry.tabRef, observedRevision: snapshot.revision } : null;
          await new Promise(done => setTimeout(done, 250));
        }
        throw new Error('Focus fixture tab has no stable opaque reference');
      },
      async waitForNavigation(name, tabId, url, timeout = 10_000) {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          if (record.navigation.some(event => event.name === name && event.tabId === tabId && event.url === url)) return true;
          await new Promise(done => setTimeout(done, 20));
        }
        throw new Error(`Chrome did not report ${name} for ${url}: ${JSON.stringify(record.navigation.filter(event => event.tabId === tabId))}`);
      },
      // Let the serialized policy queue and any navigation it starts finish:
      // return after one quiet window with no new native activity.
      async settle(quietMs = 600, limitMs = 20_000) {
        const deadline = Date.now() + limitMs;
        let previous = null;
        while (Date.now() < deadline) {
          await studentAuthMutationTail.catch(() => {});
          const current = JSON.stringify(counts());
          if (current === previous) return true;
          previous = current;
          await new Promise(done => setTimeout(done, quietMs));
        }
        return false;
      },
      async waitForFocus(states, timeout = 15_000) {
        const deadline = Date.now() + timeout;
        while (Date.now() < deadline) {
          if (states.includes(focusStatus.state)) return publicFocusStatus();
          await new Promise(done => setTimeout(done, 25));
        }
        return publicFocusStatus();
      },
      async tab(tabId) {
        try { const tab = await chrome.tabs.get(tabId); return { url: tab.url, active: tab.active }; }
        catch { return { url: '<tab removed>', active: false }; }
      },
      attentionRuleInstalled: async () => (await chrome.declarativeNetRequest.getDynamicRules()).some(rule => (
        RuntimeCore.isRuleInRange(rule.id, 'classroom') && rule.action.type === 'block'
        && rule.priority === 2000 && !rule.condition.requestDomains && !rule.condition.excludedRequestDomains)),
      runtime: () => ({ attentionModeActive, focusStatus: publicFocusStatus(), focusTabId: focusAssignment?.tabId ?? null }),
    };
  }, { classId });

  const fixture = (body, arg) => worker.evaluate(body, arg);
  const openTab = async (path, sameDocumentEntry) => {
    const page = await context.newPage();
    await page.goto(`${origin}${path}`, { waitUntil: 'load' });
    if (sameDocumentEntry) await page.evaluate(entry => history.pushState({ entry }, '', entry), sameDocumentEntry);
    const tabId = await fixture(async url => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        const id = (await chrome.tabs.query({})).find(tab => tab.url === url)?.id;
        if (Number.isInteger(id)) return id;
        await new Promise(done => setTimeout(done, 25));
      }
      return null;
    }, page.url());
    assert.ok(Number.isInteger(tabId), `fixture tab for ${path} was not found`);
    return { page, tabId, documentToken: await page.evaluate(() => window.__fixtureDocument), url: page.url() };
  };
  const overlay = page => page.evaluate(() => Boolean(document.getElementById('classpilot-attention-overlay'))).catch(() => null);
  const documentToken = page => page.evaluate(() => window.__fixtureDocument ?? null).catch(() => null);
  // What the student sees: the committed document. When Chrome shows an
  // error page, tabs.get().url is still the URL that failed to load.
  const committedView = async page => {
    const token = await documentToken(page);
    return { committed: page.url().startsWith('chrome-error://') ? 'chrome-error' : page.url().replace(origin, ''),
      document: token ? token.split(':')[0] : null, overlay: await overlay(page) };
  };
  const runCase = async (target, action, expected) => {
    const mark = await fixture(() => __attentionFixture.counts());
    await target.page.evaluate(action).catch(() => {});
    await fixture(({ name, tabId, url }) => __attentionFixture.waitForNavigation(name, tabId, url), { ...expected, tabId: target.tabId });
    await fixture(() => __attentionFixture.settle());
    const activity = await fixture(value => __attentionFixture.since(value), mark);
    return {
      url: (await fixture(tabId => __attentionFixture.tab(tabId), target.tabId)).url,
      sameDocument: await documentToken(target.page) === target.documentToken,
      overlay: await overlay(target.page),
      stepBacks: activity.goBack.filter(tabId => tabId === target.tabId).length
        + activity.tabUrlUpdates.filter(update => update.tabId === target.tabId).length,
      notifications: activity.notifications.map(value => value.title),
      blockedTelemetry: activity.telemetry,
    };
  };

  // Phase A: Attention alone, with tabs carrying earlier same-document entries.
  assert.deepEqual(await fixture(() => __attentionFixture.fab()), [classId]);
  await context.pages()[0]?.goto(`${origin}/idle`).catch(() => {});
  const push = await openTab('/spa-push', '/spa-push/entry');
  const replace = await openTab('/spa-replace', '/spa-replace/entry');
  const fragment = await openTab('/spa-fragment', '/spa-fragment/entry');
  const link = await openTab('/link-source');
  // Three separate documents: a step-back here is itself a cross-document
  // traversal that Chrome reports through onBeforeNavigate.
  const documents = await openTab('/history-a');
  await documents.page.goto(`${origin}/history-b`, { waitUntil: 'load' });
  await documents.page.goto(`${origin}/history-c`, { waitUntil: 'load' });
  const inflight = await openTab('/inflight-start');
  // This navigation starts, and is admitted by policy, before Attention.
  await inflight.page.evaluate(() => { location.href = '/inflight-destination'; }).catch(() => {});
  // Bounded, so a regression fails here instead of hanging the CI job.
  await bounded(inflightHold.requested, 'the in-flight navigation never requested /inflight-destination');
  await fixture(({ tabId, url }) => __attentionFixture.waitForNavigation('onBeforeNavigate', tabId, url),
    { tabId: inflight.tabId, url: `${origin}/inflight-destination` });
  await fixture(() => __attentionFixture.settle());
  const attentionOn = await fixture(() => __attentionFixture.command('attention-mode',
    { active: true, message: 'Eyes up front' }, { attentionMode: { active: true, message: 'Eyes up front' } }));
  assert.ok(attentionOn.includes('completed:applied'), `Attention frame was not applied: ${JSON.stringify(attentionOn)}`);
  assert.equal((await fixture(() => __attentionFixture.runtime())).attentionModeActive, true);
  assert.equal(await fixture(() => __attentionFixture.attentionRuleInstalled()), true,
    'Attention must install its main-frame DNR block');
  for (const target of [push, replace, fragment, link, documents]) {
    await target.page.waitForSelector('#classpilot-attention-overlay', { state: 'attached', timeout: 10_000 });
  }
  await fixture(() => __attentionFixture.settle());

  const outcomes = {};
  outcomes.pushState = await runCase(push, () => history.pushState({}, '', '/spa-push/during-attention'),
    { name: 'onHistoryStateUpdated', url: `${origin}/spa-push/during-attention` });
  outcomes.replaceState = await runCase(replace, () => history.replaceState({}, '', '/spa-replace/entry?autosave=1'),
    { name: 'onHistoryStateUpdated', url: `${origin}/spa-replace/entry?autosave=1` });
  outcomes.fragment = await runCase(fragment, () => { location.hash = '#slide-2'; },
    { name: 'onReferenceFragmentUpdated', url: `${origin}/spa-fragment/entry#slide-2` });
  {
    const mark = await fixture(() => __attentionFixture.counts());
    releaseInflight();
    await fixture(({ tabId, url }) => __attentionFixture.waitForNavigation('onCommitted', tabId, url),
      { tabId: inflight.tabId, url: `${origin}/inflight-destination` });
    await fixture(() => __attentionFixture.settle());
    const activity = await fixture(value => __attentionFixture.since(value), mark);
    outcomes.inflightCommit = {
      url: (await fixture(tabId => __attentionFixture.tab(tabId), inflight.tabId)).url,
      destinationDocument: String(await documentToken(inflight.page)).startsWith('/inflight-destination:'),
      stepBacks: activity.goBack.filter(tabId => tabId === inflight.tabId).length
        + activity.tabUrlUpdates.filter(update => update.tabId === inflight.tabId).length,
      notifications: activity.notifications.map(value => value.title),
      blockedTelemetry: activity.telemetry,
    };
  }
  {
    const mark = await fixture(() => __attentionFixture.counts());
    await link.page.evaluate(() => document.getElementById('next').click()).catch(() => {});
    await fixture(({ tabId, url }) => __attentionFixture.waitForNavigation('onBeforeNavigate', tabId, url),
      { tabId: link.tabId, url: `${origin}/link-destination` });
    await fixture(() => __attentionFixture.settle());
    const activity = await fixture(value => __attentionFixture.since(value), mark);
    outcomes.linkNavigation = {
      destinationServed: served.includes('/link-destination'),
      destinationCommitted: activity.navigation.some(event => event.name === 'onCommitted'
        && event.tabId === link.tabId && event.url === `${origin}/link-destination`),
      destinationDocument: String(await documentToken(link.page)).startsWith('/link-destination:'),
      stepBacks: activity.goBack.filter(tabId => tabId === link.tabId).length
        + activity.tabUrlUpdates.filter(update => update.tabId === link.tabId).length,
      notifications: activity.notifications.map(value => value.title),
      blockedTelemetry: activity.telemetry,
      url: (await fixture(tabId => __attentionFixture.tab(tabId), link.tabId)).url,
      shown: await committedView(link.page),
      reloadedSource: served.filter(path => path === '/link-source').length > 1,
    };
  }
  {
    const mark = await fixture(() => __attentionFixture.counts());
    await documents.page.evaluate(() => {
      const next = document.getElementById('next');
      next.href = '/history-destination';
      next.click();
    }).catch(() => {});
    await fixture(({ tabId, url }) => __attentionFixture.waitForNavigation('onBeforeNavigate', tabId, url),
      { tabId: documents.tabId, url: `${origin}/history-destination` });
    await fixture(() => __attentionFixture.settle());
    const activity = await fixture(value => __attentionFixture.since(value), mark);
    outcomes.multiDocumentLink = {
      destinationServed: served.includes('/history-destination'),
      stepBacks: activity.goBack.filter(tabId => tabId === documents.tabId).length
        + activity.tabUrlUpdates.filter(update => update.tabId === documents.tabId).length,
      notifications: activity.notifications.map(value => value.title),
      blockedTelemetry: activity.telemetry,
      url: (await fixture(tabId => __attentionFixture.tab(tabId), documents.tabId)).url,
      shown: await committedView(documents.page),
      reloadedHistory: served.filter(path => path === '/history-b' || path === '/history-c').length > 2,
    };
  }
  const attentionOff = await fixture(() => __attentionFixture.command('attention-mode',
    { active: false }, { attentionMode: { active: false } }));
  assert.ok(attentionOff.includes('completed:applied'), `Attention release was not applied: ${JSON.stringify(attentionOff)}`);
  for (const target of [push, replace, fragment, inflight]) {
    await target.page.waitForSelector('#classpilot-attention-overlay', { state: 'detached', timeout: 10_000 }).catch(() => {});
  }
  await fixture(() => __attentionFixture.settle());
  outcomes.afterAttention = {};
  for (const [name, target] of Object.entries({ push, replace, fragment, inflight })) {
    outcomes.afterAttention[name] = { url: (await fixture(tabId => __attentionFixture.tab(tabId), target.tabId)).url,
      overlay: await overlay(target.page) };
  }
  outcomes.afterAttentionStepBack = {};
  for (const [name, target] of Object.entries({ link, documents })) {
    outcomes.afterAttentionStepBack[name] = { url: (await fixture(tabId => __attentionFixture.tab(tabId), target.tabId)).url,
      ...await committedView(target.page) };
  }
  console.log(JSON.stringify({ attentionPhase: outcomes }));
  for (const target of [push, replace, fragment, link, documents, inflight]) await target.page.close();
  await fixture(async () => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && (await chrome.tabs.query({})).length > 1) await new Promise(done => setTimeout(done, 25));
  });

  // Phase A2: a navigation starts while the Attention frame is being applied
  // and gets its turn in the policy queue only after Attention took effect.
  // It started before Attention, so it is not stepped back; it commits under
  // the Attention overlay.
  const race = await openTab('/race-start');
  await fixture(() => __attentionFixture.settle());
  await fixture(() => __attentionFixture.holdNextRuntimeAdoption());
  await fixture(() => __attentionFixture.startCommand('attention-mode', { active: true, message: 'Eyes up front' },
    { attentionMode: { active: true, message: 'Eyes up front' } }));
  const attentionWhileHeld = await fixture(() => __attentionFixture.runtimeAdoptionHeld());
  const raceMark = await fixture(() => __attentionFixture.counts());
  await race.page.evaluate(() => { location.href = '/race-destination'; }).catch(() => {});
  await bounded(raceHold.requested, 'the racing navigation never requested /race-destination');
  await fixture(({ tabId, url }) => __attentionFixture.waitForNavigation('onBeforeNavigate', tabId, url),
    { tabId: race.tabId, url: `${origin}/race-destination` });
  await fixture(() => __attentionFixture.releaseRuntimeAdoption());
  const raceAttention = await fixture(() => __attentionFixture.finishCommand());
  assert.ok(raceAttention.includes('completed:applied'), `racing Attention frame was not applied: ${JSON.stringify(raceAttention)}`);
  await fixture(() => __attentionFixture.settle());
  raceHold.release();
  await fixture(({ tabId, url }) => __attentionFixture.waitForNavigation('onCommitted', tabId, url),
    { tabId: race.tabId, url: `${origin}/race-destination` }).catch(() => {});
  await race.page.waitForSelector('#classpilot-attention-overlay', { state: 'attached', timeout: 10_000 }).catch(() => {});
  await fixture(() => __attentionFixture.settle());
  {
    const activity = await fixture(value => __attentionFixture.since(value), raceMark);
    outcomes.raceWithAttention = {
      attentionWhileHeld,
      url: (await fixture(tabId => __attentionFixture.tab(tabId), race.tabId)).url,
      destinationDocument: String(await documentToken(race.page)).startsWith('/race-destination:'),
      overlay: await overlay(race.page),
      stepBacks: activity.goBack.filter(tabId => tabId === race.tabId).length
        + activity.tabUrlUpdates.filter(update => update.tabId === race.tabId).length,
      notifications: activity.notifications.map(value => value.title),
      blockedTelemetry: activity.telemetry,
    };
  }
  const raceRelease = await fixture(() => __attentionFixture.command('attention-mode', { active: false }, { attentionMode: { active: false } }));
  assert.ok(raceRelease.includes('completed:applied'), `racing Attention release was not applied: ${JSON.stringify(raceRelease)}`);
  await race.page.close();
  await fixture(async () => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && (await chrome.tabs.query({})).length > 1) await new Promise(done => setTimeout(done, 25));
  });

  // Phase B: Focus active, Attention suspends it, an in-page URL change
  // happens during Attention, and Attention is released.
  const flightPath = { active: true, allowedDomains: ['example.test'], name: 'Lesson' };
  const focused = await openTab('/focus-lesson', '/focus-lesson/entry');
  const { tabRef, observedRevision } = await fixture(tabId => __attentionFixture.tabRef(tabId), focused.tabId);
  const focus = { active: true, assignmentId: 'attention-focus-assignment', tabRef, observedRevision,
    targetKind: 'snapshot', source: 'teacher', setAt: new Date().toISOString() };
  const focusAck = await fixture(value => __attentionFixture.command('focus-tab',
    { tabRef: value.focus.tabRef, observedRevision: value.focus.observedRevision }, value), { flightPath, focus });
  assert.ok(focusAck.includes('completed:applied'), `Focus frame was not applied: ${JSON.stringify(focusAck)}`);
  const focusStarted = await fixture(() => __attentionFixture.waitForFocus(['active', 'invalidated']));
  assert.equal(focusStarted.state, 'active', `Focus did not start: ${JSON.stringify(focusStarted)}`);
  const focusAttention = await fixture(value => __attentionFixture.command('attention-mode',
    { active: true, message: 'Eyes up front' }, value),
  { flightPath, focus, attentionMode: { active: true, message: 'Eyes up front' } });
  assert.ok(focusAttention.includes('completed:applied'), `Focus Attention frame was not applied: ${JSON.stringify(focusAttention)}`);
  const suspended = await fixture(async () => {
    const deadline = Date.now() + 10_000;
    while (Date.now() < deadline && focusStatus.reason !== 'attention') await new Promise(done => setTimeout(done, 25));
    return publicFocusStatus();
  });
  assert.deepEqual({ state: suspended.state, reason: suspended.reason }, { state: 'suspended', reason: 'attention' },
    'Attention must suspend Focus');
  await focused.page.waitForSelector('#classpilot-attention-overlay', { state: 'attached', timeout: 10_000 });
  await fixture(() => __attentionFixture.settle());
  const focusMark = await fixture(() => __attentionFixture.counts());
  outcomes.focusPushState = await runCase(focused, () => history.pushState({}, '', '/focus-lesson/during-attention'),
    { name: 'onHistoryStateUpdated', url: `${origin}/focus-lesson/during-attention` });
  const focusRelease = await fixture(value => __attentionFixture.command('attention-mode', { active: false }, value),
    { flightPath, focus, attentionMode: { active: false } });
  assert.ok(focusRelease.includes('completed:applied'), `Focus Attention release was not applied: ${JSON.stringify(focusRelease)}`);
  const resumed = await fixture(() => __attentionFixture.waitForFocus(['active', 'invalidated', 'inactive']));
  await focused.page.waitForSelector('#classpilot-attention-overlay', { state: 'detached', timeout: 10_000 }).catch(() => {});
  await fixture(() => __attentionFixture.settle());
  const focusActivity = await fixture(value => __attentionFixture.since(value), focusMark);
  const focusRuntime = await fixture(() => __attentionFixture.runtime());
  const focusTab = await fixture(tabId => __attentionFixture.tab(tabId), focused.tabId);
  outcomes.focusAfterAttention = {
    focusStatus: resumed.state, focusReason: resumed.reason ?? null,
    assignedTab: focusRuntime.focusTabId === focused.tabId,
    url: focusTab.url, foreground: focusTab.active,
    sameDocument: await documentToken(focused.page) === focused.documentToken,
    stepBacks: focusActivity.goBack.filter(tabId => tabId === focused.tabId).length
      + focusActivity.tabUrlUpdates.filter(update => update.tabId === focused.tabId).length,
    notifications: focusActivity.notifications.map(value => value.title),
  };

  // Phase C: a precise Waypoint around Attention. Attention has priority, so an
  // in-page move off the resource during Attention is left alone; releasing
  // Attention reconciles the tab back to the Waypoint, and outside Attention
  // the same move is still redirected at once.
  await focused.page.close();
  const section = { type: 'section', hostname: 'example.test', includeSubdomains: false, pathPrefix: '/lesson' };
  const waypoint = { screenLock: { active: true, url: `${origin}/lesson`, domain: 'example.test', resource: section } };
  const lesson = await openTab('/lesson/reading', '/lesson/reading/part-1');
  const waypointApplied = await fixture(value => __attentionFixture.state(value), waypoint);
  assert.deepEqual(waypointApplied.resource, section, `precise Waypoint was not applied: ${JSON.stringify(waypointApplied)}`);
  await fixture(() => __attentionFixture.settle());
  const waypointAttention = await fixture(value => __attentionFixture.state(value),
    { ...waypoint, attentionMode: { active: true, message: 'Eyes up front' } });
  assert.equal(waypointAttention.attention, true, `Attention over the Waypoint was not applied: ${JSON.stringify(waypointAttention)}`);
  await lesson.page.waitForSelector('#classpilot-attention-overlay', { state: 'attached', timeout: 10_000 });
  await fixture(() => __attentionFixture.settle());
  outcomes.waypointPushState = await runCase(lesson, () => history.pushState({}, '', '/outside/during-attention'),
    { name: 'onHistoryStateUpdated', url: `${origin}/outside/during-attention` });
  await fixture(value => __attentionFixture.state(value), waypoint);
  const releasedUrl = await fixture(tabId => __attentionFixture.waitForTabUrl(tabId, 'https://example.test/lesson'), lesson.tabId);
  await fixture(() => __attentionFixture.settle());
  const controlMark = await fixture(() => __attentionFixture.counts());
  await lesson.page.evaluate(() => history.pushState({}, '', '/outside/without-attention')).catch(() => {});
  await fixture(({ tabId, url }) => __attentionFixture.waitForNavigation('onHistoryStateUpdated', tabId, url),
    { tabId: lesson.tabId, url: `${origin}/outside/without-attention` });
  await fixture(() => __attentionFixture.settle());
  const controlActivity = await fixture(value => __attentionFixture.since(value), controlMark);
  outcomes.waypointEnforcement = { afterAttention: releasedUrl,
    withoutAttention: await fixture(tabId => __attentionFixture.waitForTabUrl(tabId, 'https://example.test/lesson'), lesson.tabId),
    redirected: controlActivity.tabUrlUpdates.some(update => update.tabId === lesson.tabId && update.url === `${origin}/lesson`),
    blockedTelemetry: controlActivity.telemetry };

  const report = JSON.stringify(outcomes, null, 2);
  const untouched = (outcome, url) => {
    assert.equal(outcome.url, url, `in-page URL change during Attention was moved: ${report}`);
    assert.equal(outcome.sameDocument, true, `the document changed during Attention: ${report}`);
    assert.equal(outcome.overlay, true, `the Attention overlay left the page: ${report}`);
    assert.equal(outcome.stepBacks, 0, `an in-page URL change was stepped back: ${report}`);
    assert.deepEqual(outcome.notifications, [], `Attention showed a notification: ${report}`);
    assert.deepEqual(outcome.blockedTelemetry, [], `an in-page URL change was recorded as blocked: ${report}`);
  };
  untouched(outcomes.pushState, `${origin}/spa-push/during-attention`);
  untouched(outcomes.replaceState, `${origin}/spa-replace/entry?autosave=1`);
  untouched(outcomes.fragment, `${origin}/spa-fragment/entry#slide-2`);
  assert.deepEqual(outcomes.inflightCommit, { url: `${origin}/inflight-destination`, destinationDocument: true,
    stepBacks: 0, notifications: [], blockedTelemetry: [] }, `navigation in flight when Attention began was disturbed: ${report}`);
  assert.deepEqual(outcomes.raceWithAttention, { attentionWhileHeld: false, url: `${origin}/race-destination`,
    destinationDocument: true, overlay: true, stepBacks: 0, notifications: [], blockedTelemetry: [] },
  `a navigation that started while Attention was being applied was stepped back: ${report}`);
  assert.equal(outcomes.linkNavigation.destinationServed, false, `Attention DNR let a new load through: ${report}`);
  assert.equal(outcomes.linkNavigation.destinationCommitted, false, `a link navigation committed during Attention: ${report}`);
  assert.equal(outcomes.linkNavigation.destinationDocument, false, `a link destination rendered during Attention: ${report}`);
  assert.deepEqual(outcomes.linkNavigation.blockedTelemetry, [{ url: `${origin}/link-destination`, policySource: 'attention_mode' }],
    `a blocked Attention navigation must be recorded exactly once: ${report}`);
  assert.deepEqual(outcomes.linkNavigation.notifications, [], `Attention blocks silently, as in 2.9.6: ${report}`);
  assert.ok(outcomes.linkNavigation.stepBacks <= 1, `an Attention step-back retriggered itself: ${report}`);
  // What the student is left with is the kept 2.9.6 step-back, measured, not
  // assumed. With Attention's main-frame DNR rule in force (and no
  // back/forward cache with the extension loaded), the step-back's own load
  // of the earlier page is blocked too, so the tab shows Chrome's "blocked"
  // error page for that earlier URL, or about:blank when Chrome had no earlier
  // entry yet (goBackOrBlankForAuth's fallback). Chrome versions differ in
  // whether the blocked load's error entry commits before the step-back.
  // Releasing Attention does not reload it; that is a product decision.
  const errorOrBlank = shown => shown.document === null && shown.overlay === false
    && ['chrome-error', 'about:blank'].includes(shown.committed);
  assert.ok([`${origin}/link-source`, 'about:blank'].includes(outcomes.linkNavigation.url)
    && errorOrBlank(outcomes.linkNavigation.shown)
    && (outcomes.linkNavigation.url === 'about:blank') === (outcomes.linkNavigation.shown.committed === 'about:blank')
    && outcomes.linkNavigation.reloadedSource === false,
  `the link tab after the Attention step-back is not the measured 2.9.6 outcome: ${report}`);
  // The single step-back is itself a cross-document traversal. It must not be
  // blocked and stepped back again on its way to about:blank. Chrome versions
  // differ in whether the blocked load's error entry commits first, so that one
  // step returns to /history-c or /history-b, never further, and Chrome shows
  // its error page for that URL.
  const { url: historyUrl, shown: historyShown, ...historyOutcome } = outcomes.multiDocumentLink;
  assert.deepEqual(historyOutcome, { destinationServed: false, stepBacks: 1, notifications: [],
    blockedTelemetry: [{ url: `${origin}/history-destination`, policySource: 'attention_mode' }], reloadedHistory: false },
  `an Attention step-back retriggered itself: ${report}`);
  assert.ok([`${origin}/history-c`, `${origin}/history-b`].includes(historyUrl),
    `an Attention step-back walked past the student's last pages: ${report}`);
  assert.deepEqual(historyShown, { committed: 'chrome-error', document: null, overlay: false },
    `the multi-document tab after the Attention step-back is not the measured outcome: ${report}`);
  assert.deepEqual(outcomes.afterAttentionStepBack, {
    link: { url: outcomes.linkNavigation.url, ...outcomes.linkNavigation.shown },
    documents: { url: historyUrl, ...historyShown },
  }, `a stepped-back tab changed when Attention ended: ${report}`);
  assert.deepEqual(outcomes.afterAttention, {
    push: { url: `${origin}/spa-push/during-attention`, overlay: false },
    replace: { url: `${origin}/spa-replace/entry?autosave=1`, overlay: false },
    fragment: { url: `${origin}/spa-fragment/entry#slide-2`, overlay: false },
    inflight: { url: `${origin}/inflight-destination`, overlay: false },
  }, `tabs did not keep their pages after Attention ended: ${report}`);
  untouched(outcomes.focusPushState, `${origin}/focus-lesson/during-attention`);
  assert.deepEqual(outcomes.focusAfterAttention, { focusStatus: 'active', focusReason: null, assignedTab: true,
    url: `${origin}/focus-lesson/during-attention`, foreground: true, sameDocument: true, stepBacks: 0, notifications: [] },
  `Focus did not resume on its intact tab after Attention: ${report}`);
  untouched(outcomes.waypointPushState, `${origin}/outside/during-attention`);
  assert.deepEqual(outcomes.waypointEnforcement, { afterAttention: `${origin}/lesson`, withoutAttention: `${origin}/lesson`,
    redirected: true, blockedTelemetry: [{ url: `${origin}/outside/without-attention`, policySource: 'resource' }] },
  `the precise Waypoint was not enforced around Attention: ${report}`);
  console.log(JSON.stringify({ attentionNavigation: outcomes }, null, 2));
  console.log('PASS Attention leaves in-page and in-flight navigation alone, blocks new loads silently once, resumes Focus and keeps a precise Waypoint enforced');
} finally {
  releaseInflight();
  raceHoldRelease();
  if (context) await context.close().catch(() => {});
  rmSync(profile, { recursive: true, force: true });
}
