// Teacher chat delivery proof (real Chrome, real frames, real pages).
//
// SchoolPilot lets a teacher start a conversation with any student (POST
// /api/classpilot/teacher/reply pushes a 'teacher-message' frame with no
// commandId and no timestamp) and end one ('chat-closed'). These behaviours
// were already in 2.9.x; content.js and popup.js are byte-identical in 2.9.6
// and 2.10.0. Before this change:
// - a chat the teacher ended dropped every later teacher message from the page
//   until the student clicked Message, so a new conversation never showed;
// - a paused class (SchoolPilot folds the pause into messagingEnabled) and a
//   class with messaging switched off both answered an incoming message with
//   the "disabled by your teacher" toast and no chat;
// - the worker ignored the pause carried by SchoolPilot's legacy
//   messaging-toggle, the only messaging state a late sign-in may get;
// - during Attention the chat opened under the overlay and was reported seen;
// - the system notification was titled "Reply from Teacher";
// - the popup inbox inserted teacher text as HTML (markup injection; the MV3
//   default extension CSP blocks inline script);
// - on Chrome 120, which tells pages about session-storage changes, each chat
//   save made the page re-read its chat state and treat it as a class change,
//   so a teacher message acknowledged delivered and seen vanished from the
//   open chat at once.
// Here a fresh message reopens an ended chat, while a message that arrived
// before the close and a redelivery do not. A repeated End chat stays quiet.
// A close ends only what came before it: a message persisted after the close
// keeps its new conversation when its backup (heartbeat) delivery reaches the
// page before the close does, or when the close reaches a reloaded page late.
// A paused class shows the message read-only, whether the pause came as a FAB
// snapshot or as the legacy toggle.
// A pause counts only while messagingChannelEnabled is on. Before lifecycle
// negotiation legacy private replies retain the older quiet-inbox behavior.
// After negotiation, hard-off and End Chat retire server-stamped generations;
// delayed private messages cannot reappear after reopening. Announcements use
// their own modal, notification and inbox, independently of private chat.
// Attention defers the chat and its notification, and sign-out leaves nothing
// of the previous student on the page. In a scheduled class SchoolPilot ends
// Attention with classroom-state-sync and then the class's FAB snapshot, and
// the held message is still reported seen and announced.
// Heartbeat delivery reaches the same private generation checks; authorized
// command-linked announcements use the separate modal, while legacy rows
// without a commandId stay in the inbox.
//
// The unpacked extension runs in Chromium with real content scripts on a real
// page and the real popup page. Frames enter through handleWsMessage; only the
// school transports are synthetic. Notifications are observed through a
// call-through wrapper; one is held once to order a delivery against a close.
// The close's page delivery (chrome.tabs.sendMessage to the lesson tab) is
// likewise held, through a call-through wrapper, to deliver it late.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { waitForExtensionWorkerDeclarations } from './extension-worker-test-readiness.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const extension = resolve(process.env.CLASSPILOT_EXTENSION_PATH || join(root, 'extension'));
const profile = mkdtempSync(join(tmpdir(), 'classpilot-teacher-chat-'));
const executablePath = [process.env.CLASSPILOT_CHROME_PATH, chromium.executablePath(),
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'].find(path => path && existsSync(path));
assert.ok(executablePath, 'Chrome/Chromium is required');
const origin = 'https://example.test';
const classId = 'teacher-chat-class';
const PAUSED_REASON = "Your teacher paused messages. You can read, but you can't reply right now.";
const DISABLED_TOAST = 'Messaging is currently disabled by your teacher.';
const ENDED_TOAST = 'Teacher ended the chat.';
const MARKUP = '<b id="injected-markup">Bold</b> & <i>more</i>';

const launchExtensionContext = profileDir => chromium.launchPersistentContext(profileDir, { executablePath,
  headless: true, args: ['--headless=new', '--enable-automation', '--no-proxy-server',
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1',
    `--disable-extensions-except=${extension}`, `--load-extension=${extension}`] });
const lessonPage = '<!doctype html><title>Chat fixture</title><h1>Lesson</h1>';

// A scheduled class (a SchoolPilot supervision context; scheduledClassroomV1).
// SchoolPilot ends its Attention with classroom-state-sync and then the class's
// FAB snapshot carrying the new ownership revision
// (syncClasspilotControlStatesToActiveDevices); its teacher reply carries the
// student's control revision (chat.ts). A message held during Attention must
// still be reported seen and announced once Attention ends, in that order and
// with the FAB snapshot first. Runs in its own browser profile.
async function runScheduledClassAttention() {
  const scheduledProfile = mkdtempSync(join(tmpdir(), 'classpilot-teacher-chat-scheduled-'));
  let scheduledContext;
  try {
    scheduledContext = await launchExtensionContext(scheduledProfile);
    await scheduledContext.route(/^https:\/\//, route => route.fulfill({ status: 200, contentType: 'text/html',
      body: lessonPage }).catch(() => {}));
    const worker = scheduledContext.serviceWorkers()[0]
      || await scheduledContext.waitForEvent('serviceworker', { timeout: 15_000 });
    await waitForExtensionWorkerDeclarations(worker);
    await worker.evaluate(async () => {
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
      Object.assign(CONFIG, { serverUrl: 'http://127.0.0.1:1', schoolId: 'chat-school', deviceId: 'chat-device',
        activeStudentId: 'chat-student', activeStudentSessionId: 'chat-login', studentToken: 'synthetic-token',
        identitySource: 'integration_test' });
      studentAuthInvalidating = false; studentAuthCommitPending = false;
      activateAuthenticatedContext('teacher-chat-scheduled-auth');
      const auth = captureAuthenticatedContext('Scheduled teacher chat fixture');
      adoptLicenseState(true, 'active', auth);
      schoolSettings = { enableTrackingHours: false, afterHoursMode: 'off' };
      schoolSettingsScope = schoolPolicyScopeForAuthContext(auth); schoolSettingsFetchedAt = Date.now();
      trackingState = TRACKING_STATES.ACTIVE;
      await kv.set({ [SCHOOL_SETTINGS_CACHE_KEY]: schoolSettings, [SCHOOL_SETTINGS_SCOPE_KEY]: schoolSettingsScope,
        [SCHOOL_SETTINGS_FETCHED_AT_KEY]: schoolSettingsFetchedAt });
      adoptNegotiatedProtocolState({ serverProtocolVersion: 3, acceptedCapabilities: ['scopedAuthorityChecksV1',
        'classroomStateV1', 'scheduledClassroomV1'] }, auth);
      const sent = [];
      wsConnected = true;
      wsSend = value => { sent.push(value); return true; };
      const notifications = [];
      const nativeCreate = chrome.notifications.create;
      chrome.notifications.create = function (id, options, ...rest) {
        notifications.push(options?.title ?? null);
        return nativeCreate.call(this, id, options, ...rest);
      };
      const supervisionContextId = 'teacher-chat-testing-block';
      const endsAt = Date.now() + 600_000;
      const binding = { studentId: auth.studentId, studentSessionId: auth.studentSessionId };
      const exactBinding = value => ({ bindingVersion: 2, schoolId: auth.schoolId, deviceId: auth.deviceId,
        studentId: auth.studentId, studentSessionId: auth.studentSessionId, controlRevision: value });
      const deliver = frame => handleWsMessage(JSON.stringify(frame), wsConnectionGeneration, auth);
      const acks = () => sent.filter(item => item.type === 'chat-message-ack')
        .map(item => `${item.messageId}:${item.deliveryStatus}`);
      globalThis.__scheduledChat = {
        // classpilotClassroomStatePushFrame (classroom-state-sync).
        state(value, restrictions) {
          return deliver({ type: 'classroom-state-sync', _msgId: `scheduled-state-${value}`, ...binding,
            exactBinding: exactBinding(value), classroomState: { schemaVersion: 1, revision: value, supervisionContextId,
              hardExpiresAt: endsAt, scheduledEndAt: endsAt, restrictions } })
            .then(() => ({ revision: currentClassroomState?.revision ?? null, attention: attentionModeActive }));
        },
        // classpilotFabStatePushFrame with buildStudentFabState's scheduled data.
        fab(value) {
          return deliver({ type: 'fab-state-sync', _msgId: `scheduled-fab-${value}`, exactBinding: exactBinding(value),
            data: { schemaVersion: 1, ...binding, ownershipRevision: value, teachingSessionId: null, supervisionContextId,
              contextSource: 'scheduled_testing', contextName: 'Testing block', contextAuthorityRevision: '7',
              activeSessionIds: [], activeContexts: [{ supervisionContextId }], lifecycleRevision: 3, revision: 3,
              messagingEnabled: true, messagingChannelEnabled: true, handRaisingEnabled: true, messagesPaused: false,
              pauseReason: null, handRaised: false, activeHands: [], classTools: null, sessions: [],
              reason: 'control_ownership_transition' } })
            .then(() => currentFabState?.ownershipRevision ?? null);
        },
        // The scheduled POST /api/classpilot/teacher/reply frame (chat.ts).
        reply(id, text, value) {
          return deliver({ type: 'teacher-message', _msgId: id, chatMessageId: id, messageId: id, supervisionContextId,
            ...binding, studentControlRevision: value, message: text, fromName: 'Teacher' }).then(() => true);
        },
        counts: () => ({ notifications: notifications.length, acks: acks().length }),
        // The ACK outbox re-sends unreceipted ACKs; each is reported once.
        since(mark) {
          const all = acks();
          const earlier = new Set(all.slice(0, mark.acks));
          return { notifications: notifications.slice(mark.notifications),
            acks: [...new Set(all.slice(mark.acks))].filter(key => !earlier.has(key)).sort() };
        },
        async settle() {
          await studentAuthMutationTail.catch(() => {});
          await messageInboxMutation.catch(() => {});
          return true;
        },
      };
    });
    const fx = (body, arg) => worker.evaluate(body, arg);
    const page = await scheduledContext.newPage();
    await page.goto(`${origin}/testing`, { waitUntil: 'load' });
    await page.waitForSelector('#classpilot-fab-message-box', { state: 'attached', timeout: 15_000 });
    const view = () => page.evaluate(() => ({
      open: Boolean(document.getElementById('classpilot-fab-message-box')?.classList.contains('classpilot-fab-message-box-open')),
      thread: [...document.querySelectorAll('#classpilot-fab-chat-messages .classpilot-chat-bubble')]
        .map(bubble => bubble.firstChild?.textContent ?? ''),
      overlay: Boolean(document.getElementById('classpilot-attention-overlay')),
    }));
    const settle = async (quietMs = 500, limitMs = 15_000) => {
      const deadline = Date.now() + limitMs;
      let previous = null;
      while (Date.now() < deadline) {
        await fx(() => __scheduledChat.settle());
        const current = JSON.stringify(await view());
        if (current === previous) return JSON.parse(current);
        previous = current;
        await new Promise(done => setTimeout(done, quietMs));
      }
      return view();
    };
    const step = async (action) => {
      const mark = await fx(() => __scheduledChat.counts());
      await action();
      const shown = await settle();
      return { ...shown, ...(await fx(value => __scheduledChat.since(value), mark)) };
    };
    const closeChat = async () => {
      await page.evaluate(() => document.getElementById('classpilot-fab-message-close')?.click());
      await settle();
    };
    const attention = async (value) => {
      const applied = await fx(revision => __scheduledChat.state(revision, {
        attentionMode: { active: true, message: 'Eyes up front' } }), value);
      assert.equal(applied.attention, true, `Attention was not applied: ${JSON.stringify(applied)}`);
      await fx(revision => __scheduledChat.fab(revision), value);
      await page.waitForSelector('#classpilot-attention-overlay', { state: 'attached', timeout: 10_000 });
      await settle();
    };
    const release = async (value) => {
      const applied = await fx(revision => __scheduledChat.state(revision, { attentionMode: { active: false } }), value);
      assert.equal(applied.attention, false, `Attention was not released: ${JSON.stringify(applied)}`);
      await page.waitForSelector('#classpilot-attention-overlay', { state: 'detached', timeout: 10_000 });
    };
    const outcomes = {};
    assert.deepEqual(await fx(() => __scheduledChat.state(50, {})), { revision: 50, attention: false });
    assert.equal(await fx(() => __scheduledChat.fab(50)), 50);
    await settle();
    outcomes.outside = await step(() => fx(() => __scheduledChat.reply('scheduled-r1', 'Outside Attention', 50)));
    await closeChat();
    // SchoolPilot's order: classroom-state-sync, then the FAB snapshot. The
    // page shows the held chat as the overlay goes, before that snapshot.
    await attention(51);
    outcomes.during = await step(() => fx(() => __scheduledChat.reply('scheduled-r2', 'During Attention', 51)));
    outcomes.released = await step(async () => {
      await release(52);
      assert.equal(await fx(() => __scheduledChat.fab(52)), 52);
    });
    await closeChat();
    // The FAB snapshot reaches the device first, while Attention is still on.
    await attention(53);
    outcomes.duringAgain = await step(() => fx(() => __scheduledChat.reply('scheduled-r3', 'During the next Attention', 53)));
    outcomes.releasedFabFirst = await step(async () => {
      assert.equal(await fx(() => __scheduledChat.fab(54)), 54);
      await settle();
      await release(54);
    });
    return outcomes;
  } finally {
    if (scheduledContext) await scheduledContext.close().catch(() => {});
    rmSync(scheduledProfile, { recursive: true, force: true });
  }
}

let context;
try {
  context = await launchExtensionContext(profile);
  // Page-side observer for the FAB toast the content script adds and removes.
  await context.addInitScript(() => {
    window.__chatToasts = [];
    new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node.id === 'classpilot-fab-notification') window.__chatToasts.push(node.textContent);
        }
      }
    }).observe(document, { childList: true, subtree: true });
  });
  await context.route(/^https:\/\//, route => route.fulfill({ status: 200, contentType: 'text/html',
    body: lessonPage }).catch(() => {}));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', { timeout: 15_000 });
  await waitForExtensionWorkerDeclarations(worker);
  assert.equal(await worker.evaluate(() => chrome.runtime.getManifest().version),
    JSON.parse(readFileSync(join(extension, 'manifest.json'), 'utf8')).version);

  await worker.evaluate(async ({ classId }) => {
    await authStateRestorePromise.catch(() => {}); await classroomStateRestorePromise.catch(() => {});
    await studentAuthMutationTail.catch(() => {});
    const wakeDeadline = Date.now() + 15_000;
    while (!workerWakeSettled && Date.now() < wakeDeadline) await new Promise(done => setTimeout(done, 25));
    if (!workerWakeSettled) throw new Error('Synthetic transport setup requires completed production worker wake');
    CONFIG.autoRegistrationPaused = true;
    if (chromeProfileRegistrationInFlight) await chromeProfileRegistrationInFlight.catch(() => {});
    advanceStudentAuthMutationGeneration();
    // School transports only. Inbox, notifications, page broadcasts, the
    // content script and the popup stay native.
    const studentPosts = [];
    fetchWithBackoff = async (url, options) => {
      if (String(url).endsWith('/api/student/send-message')) studentPosts.push(JSON.parse(options.body));
      return new Response('{}', { status: 503 });
    };
    sendHeartbeat = async () => {}; connectWebSocket = async () => {}; scheduleEventHeartbeat = () => {};
    recoverOffscreenWebSocketStatus = async () => true;
    if (wsConnectInFlight) await wsConnectInFlight.catch(() => {});
    Object.assign(CONFIG, { serverUrl: 'http://127.0.0.1:1', schoolId: 'chat-school', deviceId: 'chat-device',
      activeStudentId: 'chat-student', activeStudentSessionId: 'chat-login', studentToken: 'synthetic-token',
      identitySource: 'integration_test' });
    studentAuthInvalidating = false; studentAuthCommitPending = false;
    activateAuthenticatedContext('teacher-chat-auth');
    const auth = captureAuthenticatedContext('Teacher chat fixture');
    adoptLicenseState(true, 'active', auth);
    schoolSettings = { enableTrackingHours: false, afterHoursMode: 'off' };
    schoolSettingsScope = schoolPolicyScopeForAuthContext(auth); schoolSettingsFetchedAt = Date.now();
    trackingState = TRACKING_STATES.ACTIVE;
    await kv.set({ [SCHOOL_SETTINGS_CACHE_KEY]: schoolSettings, [SCHOOL_SETTINGS_SCOPE_KEY]: schoolSettingsScope,
      [SCHOOL_SETTINGS_FETCHED_AT_KEY]: schoolSettingsFetchedAt });
    adoptNegotiatedProtocolState({ serverProtocolVersion: 3, acceptedCapabilities: ['scopedAuthorityChecksV1',
      'classroomStateV1'] }, auth);
    const sent = [];
    wsConnected = true;
    wsSend = value => { sent.push(value); return true; };
    const notifications = [];
    let hold = null;
    const nativeCreate = chrome.notifications.create;
    chrome.notifications.create = function (id, options, ...rest) {
      notifications.push({ title: options?.title ?? null, message: options?.message ?? null });
      if (!hold) return nativeCreate.call(this, id, options, ...rest);
      const gate = hold;
      hold = null;
      gate.reached();
      gate.released.then(() => {
        try {
          nativeCreate.call(this, id, options, ...rest);
        } catch {
          // safeNotify waits for this callback; never strand the held delivery.
          rest.find(value => typeof value === 'function')?.();
        }
      });
      return undefined;
    };
    // One held page delivery of a chat close to the lesson tab: the close's
    // page message reaches that tab late (other tabs first, or a broadcast
    // retry into a tab that was navigating).
    let pageCloseHold = null;
    const nativeTabsSendMessage = chrome.tabs.sendMessage;
    chrome.tabs.sendMessage = function (tabId, payload, ...rest) {
      const gate = pageCloseHold;
      if (!gate || payload?.type !== 'chat-closed' || tabId !== gate.tabId) {
        return nativeTabsSendMessage.call(chrome.tabs, tabId, payload, ...rest);
      }
      pageCloseHold = null;
      gate.reached();
      return gate.released.then(() => nativeTabsSendMessage.call(chrome.tabs, tabId, payload, ...rest));
    };
    let pendingClose = null;
    // Pages load their chat state from the worker; counting those reads lets
    // a reloaded page finish loading before the next frame.
    let uiStateReads = 0;
    const nativeGetStudentSessionUiState = getStudentSessionUiState;
    getStudentSessionUiState = (...args) => { uiStateReads += 1; return nativeGetStudentSessionUiState(...args); };

    let revision = 40;
    let sequence = 0;
    let lifecycle = null;
    const binding = { studentId: auth.studentId, studentSessionId: auth.studentSessionId };
    const exactBinding = value => ({ bindingVersion: 2, schoolId: auth.schoolId, deviceId: auth.deviceId,
      studentId: auth.studentId, studentSessionId: auth.studentSessionId, controlRevision: value });
    const authority = { authority: { teachingSessionId: classId, supervisionContextId: null },
      teachingSessionId: classId, supervisionContextId: null };
    const deliver = frame => handleWsMessage(JSON.stringify(frame), wsConnectionGeneration, auth);
    const pending = new Map();
    const fabSummary = () => ({ messagingEnabled: currentFabState?.messagingEnabled ?? null,
      messagesPaused: currentFabState?.messagesPaused ?? null,
      messagingChannelEnabled: currentFabState?.messagingChannelEnabled ?? null });
    globalThis.__chatFixture = {
      // SchoolPilot's FAB snapshot frame. getEffectiveFabToggles folds a soft
      // pause into messagingEnabled, so a paused class is messagingEnabled
      // false with messagesPaused true. messagingChannelEnabled carries only
      // the hard switches (school-wide and the class's own); SchoolPilot also
      // reports a pause while a switch is off. Omitting it models a server
      // that predates the field.
      async fab({ messagingEnabled, messagingChannelEnabled, messagesPaused = false, pauseReason = null, omitLifecycle = false,
        emptyAuthority = false, staleGeneration = null }) {
        const value = revision++;
        const channel = messagingChannelEnabled === undefined ? {} : { messagingChannelEnabled };
        await deliver({ type: 'fab-state-sync', _msgId: `chat-fab-${value}`, exactBinding: exactBinding(value), data: {
          schemaVersion: 1, ...binding, ownershipRevision: value, teachingSessionId: emptyAuthority ? null : classId, lifecycleRevision: value,
          revision: value, activeSessionIds: emptyAuthority ? [] : [classId], activeContexts: emptyAuthority ? [] : [{ teachingSessionId: classId }], messagingEnabled,
          ...(lifecycle && !omitLifecycle ? { privateChatLifecycleState: { schoolEpoch: lifecycle.schoolEpoch,
            threads: emptyAuthority ? [] : [{ ...lifecycle, threadGeneration: staleGeneration ?? lifecycle.threadGeneration,
              teachingSessionId: classId, supervisionContextId: null }] } } : {}),
          ...channel, handRaisingEnabled: true, messagesPaused, pauseReason, handRaised: false, activeHands: [], classTools: null,
          sessions: [{ sessionId: classId, messagingEnabled, ...channel, handRaisingEnabled: true, messagesPaused, pauseReason,
            handRaised: false, lifecycleRevision: value }] } });
        return fabSummary();
      },
      // SchoolPilot's legacy messaging-toggle (updateAndFanoutSessionFabSettings):
      // a remote-control frame with no commandId and no exact binding. It is
      // always sent, and it is the only messaging state a late sign-in gets
      // when SchoolPilot skips the full FAB snapshot.
      async toggle({ enabled, messagingChannelEnabled, messagesPaused, pauseReason = null }) {
        const value = revision++;
        await deliver({ type: 'remote-control', _msgId: `chat-toggle-${value}`, ...binding, command: {
          type: 'messaging-toggle', data: { sessionId: classId, ...binding, enabled, messagingEnabled: enabled,
            ...(messagingChannelEnabled === undefined ? {} : { messagingChannelEnabled }), messagesPaused, pauseReason,
            revision: value },
          ...binding, ...authority } });
        return fabSummary();
      },
      // SchoolPilot's announcement: a 'teacher-message' command frame from the
      // command dispatcher, with a commandId.
      announce(id, text) {
        return deliver({ type: 'teacher-message', _msgId: id, messageId: id, commandId: `chat-command-${id}`, ...binding,
          deliveryPolicy: 'durable_message', expiresAt: null, ...authority, messageKind: 'announcement', message: text, fromName: 'Teacher' });
      },
      // Command ACK states in first-sent order (the outbox may re-send).
      commandAcks: commandId => [...new Set(sent.filter(item => item.type === 'command-ack' && item.commandId === commandId)
        .map(item => `${item.ackState}:${item.outcome}`))],
      // SchoolPilot's classroom-state push frame (Attention).
      async state(restrictions) {
        const value = revision++;
        await deliver({ type: 'classroom-state', _msgId: `chat-state-${value}`, ...binding, exactBinding: exactBinding(value),
          classroomState: { schemaVersion: 1, revision: value, teachingSessionId: classId,
            hardExpiresAt: Date.now() + 600_000, restrictions } });
        return { revision: currentClassroomState?.revision ?? null, attention: attentionModeActive };
      },
      // The frame POST /api/classpilot/teacher/reply pushes (chat.ts): no
      // commandId, no creation time.
      replyFrame: (id, text, overrides = {}) => ({ type: 'teacher-message', _msgId: id, chatMessageId: id, messageId: id,
        sessionId: classId, ...binding, message: text, fromName: 'Teacher',
        ...(lifecycle ? { messageKind: 'private', privateChatLifecycle: { ...lifecycle } } : {}), ...overrides }),
      reply(id, text, overrides = {}) { return deliver(this.replyFrame(id, text, overrides)); },
      startReply(id, text) { pending.set(id, deliver(this.replyFrame(id, text)).then(() => 'done')); return true; },
      finish(id) { return pending.get(id); },
      // The frame POST /api/classpilot/teacher/close-chat pushes.
      close() {
        if (lifecycle) lifecycle = { ...lifecycle, threadGeneration: lifecycle.threadGeneration + 1 };
        return deliver({ type: 'chat-closed', _msgId: `chat-close-${++sequence}`, sessionId: classId, ...binding, ...authority,
          ...(lifecycle ? { privateChatLifecycle: { ...lifecycle } } : {}) });
      },
      deliverFrame: frame => deliver(frame),
      async enableLifecycle() {
        lifecycle = { threadId: 'opaque-private-thread', schoolEpoch: 1, activityEpoch: 1, threadGeneration: 1 };
        adoptNegotiatedProtocolState({ serverProtocolVersion: 3,
          acceptedCapabilities: ['scopedAuthorityChecksV1', 'classroomStateV1', 'privateChatLifecycleV1', 'studentChatIdempotencyV1'] }, auth);
        return this.fab({ messagingEnabled: true, messagingChannelEnabled: true });
      },
      async lifecycleOff() {
        lifecycle = { ...lifecycle, schoolEpoch: lifecycle.schoolEpoch + 1 };
        return this.fab({ messagingEnabled: false, messagingChannelEnabled: false });
      },
      async lifecycleReadAfterMemoryRetirement() {
        currentPrivateChatLifecycle = null;
        await loadPrivateChatLifecycle(auth);
        return { schoolEpoch: currentPrivateChatLifecycle?.schoolEpoch,
          generation: currentPrivateChatLifecycle?.threads[0]?.threadGeneration,
          localPresent: Boolean((await rawLocalKv.get(PRIVATE_CHAT_LIFECYCLE_STORAGE_KEY))[PRIVATE_CHAT_LIFECYCLE_STORAGE_KEY]),
          sessionPresent: Boolean((await durableSessionKv.get(PRIVATE_CHAT_LIFECYCLE_STORAGE_KEY))[PRIVATE_CHAT_LIFECYCLE_STORAGE_KEY]) };
      },
      async activityReturnWithStaleSnapshot() {
        await this.fab({ messagingEnabled: false, messagingChannelEnabled: false, emptyAuthority: true });
        currentPrivateChatLifecycle = null;
        await loadPrivateChatLifecycle(auth);
        await this.fab({ messagingEnabled: true, messagingChannelEnabled: true, staleGeneration: 1 });
        const floor = privateChatThreadFor({ teachingSessionId: classId }, auth)?.threadGeneration;
        const old = this.replyFrame('lifecycle-return-old', 'Old activity generation', {
          privateChatLifecycle: { ...lifecycle, threadGeneration: 1 } });
        await this.deliverFrame(old);
        return { floor, oldDelivered: sent.some(entry => entry.type === 'chat-message-ack'
          && entry.messageId === 'lifecycle-return-old' && entry.deliveryStatus === 'delivered') };
      },
      async queuedStudentAcrossClose() {
        const initial = await queueAndSendStudentChatMessage({ clientMessageId: 'lifecycle-student-queued',
          message: 'Queued student reply', sessionId: classId, teachingSessionId: classId }, auth);
        const stored = (await durableLocalKv.get(STUDENT_CHAT_OUTBOX_KEY))[STUDENT_CHAT_OUTBOX_KEY];
        const frozen = stored.find(entry => entry.clientMessageId === 'lifecycle-student-queued')?.expectedPrivateChatLifecycle;
        await this.close();
        await flushStudentChatOutbox();
        const remaining = (await durableLocalKv.get(STUDENT_CHAT_OUTBOX_KEY))[STUDENT_CHAT_OUTBOX_KEY];
        return { queued: initial.queued, frozenGeneration: frozen?.threadGeneration,
          postGeneration: studentPosts.at(-1)?.expectedPrivateChatLifecycle?.threadGeneration,
          transmissions: studentPosts.filter(entry => entry.clientMessageId === 'lifecycle-student-queued').length,
          remainsQueued: remaining.some(entry => entry.clientMessageId === 'lifecycle-student-queued') };
      },
      async terminalAckReceipts() {
        const token = { ...lifecycle };
        for (const id of ['expired', 'stale']) await enqueueChatAck({ ackId: `lifecycle-ack-${id}`,
          messageId: `lifecycle-message-${id}`, teachingSessionId: classId, deliveryStatus: 'delivered', privateChatLifecycle: token }, auth);
        const before = (await durableLocalKv.get(CHAT_ACK_OUTBOX_KEY))[CHAT_ACK_OUTBOX_KEY];
        await removeAcceptedChatAckReceipts([
          { ackId: 'lifecycle-ack-expired', messageId: 'lifecycle-message-expired', accepted: false, code: 'PRIVATE_CHAT_EXPIRED' },
          { ackId: 'lifecycle-ack-stale', messageId: 'lifecycle-message-stale', accepted: false, code: 'CHAT_ACK_STALE' },
        ], auth);
        const after = (await durableLocalKv.get(CHAT_ACK_OUTBOX_KEY))[CHAT_ACK_OUTBOX_KEY];
        const storedToken = before.find(entry => entry.ackId === 'lifecycle-ack-expired')?.privateChatLifecycle;
        return { tokenRetained: Object.keys(token).every(key => storedToken?.[key] === token[key]),
          expiredDrained: !after.some(entry => entry.ackId === 'lifecycle-ack-expired'),
          authorityStaleRetained: after.some(entry => entry.ackId === 'lifecycle-ack-stale') };
      },
      withdrawLifecycle() {
        adoptNegotiatedProtocolState({ serverProtocolVersion: 3,
          acceptedCapabilities: ['scopedAuthorityChecksV1', 'classroomStateV1'] }, auth); return true;
      },
      withdrawIdempotency() {
        adoptNegotiatedProtocolState({ serverProtocolVersion: 3,
          acceptedCapabilities: ['scopedAuthorityChecksV1', 'classroomStateV1', 'privateChatLifecycleV1'] }, auth);
        return hasNegotiatedCapability('privateChatLifecycleV1', auth);
      },
      async refusedStudentAfterWithdrawal() {
        const count = studentPosts.length;
        let code = null;
        try { await queueAndSendStudentChatMessage({ message: 'Must not use legacy after withdrawal', sessionId: classId,
          teachingSessionId: classId }, auth); } catch (error) { code = error.code; }
        return { code, transmitted: studentPosts.length !== count };
      },
      startClose() { pendingClose = this.close(); return true; },
      finishClose() { return pendingClose.then(() => true, () => false); },
      async holdPageClose(url) {
        const [tab] = await chrome.tabs.query({ url });
        if (!tab) throw new Error(`no tab is open on ${url}`);
        let reached; let release;
        const reachedPromise = new Promise(done => { reached = done; });
        pageCloseHold = { tabId: tab.id, reached, released: new Promise(done => { release = done; }) };
        this.releasePageClose = () => { release(); return true; };
        // Bounded, so a change that stops this delivery fails here instead of
        // hanging the CI job.
        this.pageCloseHeld = () => new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('the chat close was never sent to the lesson tab')), 15_000);
          reachedPromise.then(() => { clearTimeout(timer); resolve(true); });
        });
        return true;
      },
      async storedChat() {
        const stored = await kv.get(['fabChatMessages', 'fabChatClosed']);
        return { thread: (stored.fabChatMessages || []).map(item => item.text), closed: stored.fabChatClosed === true };
      },
      uiStateReads: () => uiStateReads,
      // The worker's heartbeat inbox entry point with SchoolPilot's
      // pendingMessages row shape (devices.ts): a command-linked announcement
      // and a legacy row without a commandId.
      heartbeat(rows) {
        return handleHeartbeatPendingMessages(rows.map(row => ({ studentId: auth.studentId,
          studentSessionId: auth.studentSessionId, teachingSessionId: classId, supervisionContextId: null,
          authority: row.commandId ? { teachingSessionId: classId, supervisionContextId: null } : null, ...row })),
        monitoringEventAuthBindingForContext(auth), auth).then(result => result.addedMessageIds);
      },
      holdNextNotification() {
        let reached; let release;
        const gate = { reached: null, released: new Promise(done => { release = done; }) };
        const reachedPromise = new Promise(done => { reached = done; });
        gate.reached = reached;
        hold = gate;
        this.releaseNotification = () => release();
        // Bounded, so a change that stops this notification fails here
        // instead of hanging the CI job.
        this.notificationHeld = () => new Promise((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error('the held teacher-message notification was never created')), 15_000);
          reachedPromise.then(() => { clearTimeout(timer); resolve(true); });
        });
        return true;
      },
      counts: () => ({ notifications: notifications.length, acks: sent.filter(item => item.type === 'chat-message-ack').length }),
      // The ACK outbox re-sends unreceipted ACKs on its flush timer; each
      // receipt is reported once, when it first appears.
      since(mark) {
        const acks = sent.filter(item => item.type === 'chat-message-ack')
          .map(item => `${item.messageId}:${item.deliveryStatus}`);
        const earlier = new Set(acks.slice(0, mark.acks));
        return {
          notifications: notifications.slice(mark.notifications),
          acks: [...new Set(acks.slice(mark.acks))].filter(key => !earlier.has(key)).sort(),
        };
      },
      async inbox() {
        return ((await kv.get(MESSAGE_INBOX_STORAGE_KEY))[MESSAGE_INBOX_STORAGE_KEY] || []).map(item => item.id);
      },
      async settle() {
        await studentAuthMutationTail.catch(() => {});
        await messageInboxMutation.catch(() => {});
        return true;
      },
      async signOut() {
        await clearStudentAuth('teacher-chat-sign-out', { notifyBackend: false, pauseAutoRegistration: true });
        return { signedIn: hasStudentAuth() };
      },
      // A frame for the previous student arriving after sign-out.
      async lateFrameForRetiredStudent(id, text) {
        await deliver(this.replyFrame(id, text)).catch(() => {});
        return true;
      },
    };
  }, { classId });

  const fixture = (body, arg) => worker.evaluate(body, arg);
  const page = await context.newPage();
  await page.goto(`${origin}/lesson`, { waitUntil: 'load' });
  await page.waitForSelector('#classpilot-fab-message-box', { state: 'attached', timeout: 15_000 });
  const readChatView = () => page.evaluate(() => {
    const box = document.getElementById('classpilot-fab-message-box');
    const input = document.getElementById('classpilot-fab-chat-input');
    const banner = document.getElementById('classpilot-fab-chat-pause');
    return {
      open: Boolean(box?.classList.contains('classpilot-fab-message-box-open')),
      thread: [...document.querySelectorAll('#classpilot-fab-chat-messages .classpilot-chat-bubble')]
        .map(bubble => bubble.firstChild?.textContent ?? ''),
      messageButton: document.querySelector('#classpilot-fab-message .classpilot-fab-label')?.textContent ?? null,
      inputDisabled: input?.disabled ?? null,
      inputFocused: Boolean(input) && document.activeElement === input,
      banner: banner?.classList.contains('classpilot-fab-chat-pause-visible') ? banner.textContent : '',
      toasts: [...(window.__chatToasts || [])],
      overlay: Boolean(document.getElementById('classpilot-attention-overlay')),
      visibility: document.visibilityState,
      announcement: document.querySelector('#classpilot-message-modal .classpilot-modal-body')?.textContent.trim() || '',
    };
  });
  // Sign-out may move the page through the sign-in gate; read it once settled.
  const chatView = async () => {
    for (let attempt = 0; ; attempt++) {
      try { return await readChatView(); } catch (error) {
        if (attempt >= 40) throw error;
        await new Promise(done => setTimeout(done, 250));
      }
    }
  };
  // Return once the worker queues are idle and the page has been quiet for a
  // full window (content persistence and storage-driven hydration included).
  const settle = async (quietMs = 500, limitMs = 15_000) => {
    const deadline = Date.now() + limitMs;
    let previous = null;
    while (Date.now() < deadline) {
      await fixture(() => __chatFixture.settle());
      const current = JSON.stringify(await chatView());
      if (current === previous) return JSON.parse(current);
      previous = current;
      await new Promise(done => setTimeout(done, quietMs));
    }
    return chatView();
  };
  const step = async (action) => {
    const mark = await fixture(() => __chatFixture.counts());
    const before = await chatView();
    await action();
    const view = await settle();
    const activity = await fixture(value => __chatFixture.since(value), mark);
    return { ...view, newToasts: view.toasts.slice(before.toasts.length), notifications: activity.notifications,
      acks: activity.acks };
  };
  const clickFab = id => page.evaluate(target => document.getElementById(target)?.click(), id);
  const outcomes = {};
  // Setup assertions compare only the fields every version keeps.
  const toggles = ({ messagingEnabled, messagesPaused }) => ({ messagingEnabled, messagesPaused });

  // Phase A: messaging on; the teacher starts a conversation.
  assert.deepEqual(toggles(await fixture(() => __chatFixture.fab({ messagingEnabled: true, messagingChannelEnabled: true }))),
    { messagingEnabled: true, messagesPaused: false });
  await settle();
  assert.equal((await chatView()).visibility, 'visible', 'the lesson page must be visible for seen receipts');
  outcomes.start = await step(() => fixture(() => __chatFixture.reply('chat-r1', 'Can you show me your work?')));

  // Phase B: the teacher ends the chat. A message persisted before the close
  // whose page delivery lands after it, and a redelivery, never reopen it; a
  // fresh message does, without the old thread.
  outcomes.delayedBeforeClose = {};
  {
    const mark = await fixture(() => __chatFixture.counts());
    const before = await chatView();
    await fixture(() => __chatFixture.holdNextNotification());
    await fixture(() => __chatFixture.startReply('chat-r2', 'Finish question 3 first.'));
    await fixture(() => __chatFixture.notificationHeld());
    await fixture(() => __chatFixture.close());
    const closed = await settle();
    await fixture(() => { __chatFixture.releaseNotification(); return true; });
    await fixture(() => __chatFixture.finish('chat-r2'));
    const after = await settle();
    const activity = await fixture(value => __chatFixture.since(value), mark);
    outcomes.delayedBeforeClose = { closed: { open: closed.open, thread: closed.thread,
      newToasts: closed.toasts.slice(before.toasts.length) }, after: { open: after.open, thread: after.thread },
    acks: activity.acks };
  }
  // The teacher presses End chat again (each press is a new close frame).
  outcomes.repeatClose = await step(() => fixture(() => __chatFixture.close()));
  outcomes.redelivery = await step(() => fixture(() => __chatFixture.reply('chat-r1', 'Can you show me your work?')));
  outcomes.fresh = await step(() => fixture(() => __chatFixture.reply('chat-r3', 'New question: what is 3/4 of 12?')));
  outcomes.otherClass = await step(() => fixture(() => __chatFixture.reply('chat-other-class', 'Wrong class',
    { sessionId: 'another-class' })));
  outcomes.otherStudentSession = await step(() => fixture(() => __chatFixture.reply('chat-other-session', 'Wrong login',
    { studentSessionId: 'another-login' })));
  outcomes.inboxAfterClose = await fixture(() => __chatFixture.inbox());

  // Phase B4: the heartbeat inbox path runs beside the WebSocket frames, so a
  // teacher message the worker persisted after a close can reach the page
  // before the close's own page message. The close ended the thread on
  // screen; the message starts the next conversation, and the late close
  // leaves that conversation alone.
  {
    const before = await chatView();
    await fixture(url => __chatFixture.holdPageClose(url), `${origin}/lesson`);
    await fixture(() => __chatFixture.startClose());
    await fixture(() => __chatFixture.pageCloseHeld());
    await fixture(() => __chatFixture.heartbeat([{ id: 'chat-backup-after-close', message: 'Backup delivery after the close',
      commandId: 'chat-backup-command' }]));
    const overtaken = await settle();
    await fixture(() => __chatFixture.releasePageClose());
    await fixture(() => __chatFixture.finishClose());
    const after = await settle();
    outcomes.backupBeforeClose = { overtaken: { open: overtaken.open, thread: overtaken.thread, announcement: overtaken.announcement },
      after: { open: after.open, thread: after.thread, newToasts: after.toasts.slice(before.toasts.length) },
      stored: await fixture(() => __chatFixture.storedChat()) };
  }

  // Phase B5: the tab reloads while the close's page message is on its way
  // (the worker retries a broadcast into a tab that was navigating). The new
  // page loads the ended chat from storage and shows a fresh message; the
  // close then reaches it late and leaves the new conversation alone.
  {
    await fixture(url => __chatFixture.holdPageClose(url), `${origin}/lesson`);
    await fixture(() => __chatFixture.startClose());
    await fixture(() => __chatFixture.pageCloseHeld());
    const readsBeforeReload = await fixture(() => __chatFixture.uiStateReads());
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('#classpilot-fab-message-box', { state: 'attached', timeout: 15_000 });
    for (const deadline = Date.now() + 15_000; await fixture(() => __chatFixture.uiStateReads()) <= readsBeforeReload;) {
      assert.ok(Date.now() < deadline, 'the reloaded page never loaded its chat state');
      await new Promise(done => setTimeout(done, 50));
    }
    const reloaded = await settle();
    await fixture(() => __chatFixture.reply('chat-after-reload', 'Fresh message after the reload'));
    const shown = await settle();
    await fixture(() => __chatFixture.releasePageClose());
    await fixture(() => __chatFixture.finishClose());
    const after = await settle();
    outcomes.lateCloseAfterReload = { reloaded: { open: reloaded.open, thread: reloaded.thread },
      shown: { open: shown.open, thread: shown.thread },
      after: { open: after.open, thread: after.thread, newToasts: after.toasts.slice(shown.toasts.length) },
      stored: await fixture(() => __chatFixture.storedChat()) };
  }

  // Phase C: soft pause. SchoolPilot sends messagingEnabled false with
  // messagesPaused true; the class channel is still on. The student first
  // opens the chat themselves, which leaves no ended chat behind on any
  // version, so this phase does not depend on the B1 outcome above.
  await clickFab('classpilot-fab-main');
  await clickFab('classpilot-fab-message');
  await settle();
  await clickFab('classpilot-fab-message-close');
  await settle();
  assert.deepEqual(toggles(await fixture(() => __chatFixture.fab({ messagingEnabled: false, messagingChannelEnabled: true,
    messagesPaused: true, pauseReason: 'teacher' }))), { messagingEnabled: false, messagesPaused: true });
  await settle();
  outcomes.paused = await step(() => fixture(() => __chatFixture.reply('chat-r4', 'Please read page 12.')));
  await clickFab('classpilot-fab-message-close');
  await settle();
  outcomes.pausedStudentOpen = await step(async () => { await clickFab('classpilot-fab-main'); await clickFab('classpilot-fab-message'); });

  // Phase C2: the pause reaches the device only as SchoolPilot's legacy
  // messaging-toggle, as for a late sign-in that gets no FAB snapshot.
  await clickFab('classpilot-fab-message-close');
  await settle();
  assert.deepEqual(toggles(await fixture(() => __chatFixture.fab({ messagingEnabled: true, messagingChannelEnabled: true }))),
    { messagingEnabled: true, messagesPaused: false });
  await settle();
  outcomes.toggledPauseState = await fixture(() => __chatFixture.toggle({ enabled: false, messagingChannelEnabled: true,
    messagesPaused: true, pauseReason: 'teacher' }));
  await settle();
  outcomes.toggledPause = await step(() => fixture(() => __chatFixture.reply('chat-r4b', 'Paused, but please read this.')));
  await clickFab('classpilot-fab-message-close');
  await settle();

  // Phase D: the class switch is off.
  assert.deepEqual(toggles(await fixture(() => __chatFixture.fab({ messagingEnabled: false, messagingChannelEnabled: false }))),
    { messagingEnabled: false, messagesPaused: false });
  await settle();
  outcomes.off = await step(() => fixture(() => __chatFixture.reply('chat-r5', 'Messaging is off for this one.')));
  outcomes.inboxWhileOff = await fixture(() => __chatFixture.inbox());
  outcomes.offStudentOpen = await step(async () => { await clickFab('classpilot-fab-main'); await clickFab('classpilot-fab-message'); });

  // Phase D2: a switch is off while a pause is still set. SchoolPilot reports
  // the pause on its own: a teacher pause left on, or a scheduled testing
  // block with pauseChatDuringTesting (the default). A reply, an announcement
  // and the student's own click all find messaging off.
  assert.deepEqual(toggles(await fixture(() => __chatFixture.fab({ messagingEnabled: false, messagingChannelEnabled: false,
    messagesPaused: true, pauseReason: 'testing' }))), { messagingEnabled: false, messagesPaused: true });
  await settle();
  outcomes.offPaused = await step(() => fixture(() => __chatFixture.reply('chat-r5b', 'Off, with a pause still set.')));
  outcomes.offPausedAnnouncement = await step(() => fixture(() => __chatFixture.announce('chat-a1', 'An announcement while off.')));
  outcomes.offPausedAnnouncement.commandAcks = await fixture(() => __chatFixture.commandAcks('chat-command-chat-a1'));
  outcomes.offPausedStudentOpen = await step(async () => { await clickFab('classpilot-fab-main'); await clickFab('classpilot-fab-message'); });

  // Phase D3: from a soft pause, the legacy toggle switches the class off and
  // leaves the pause set.
  assert.deepEqual(toggles(await fixture(() => __chatFixture.fab({ messagingEnabled: false, messagingChannelEnabled: true,
    messagesPaused: true, pauseReason: 'teacher' }))), { messagingEnabled: false, messagesPaused: true });
  await settle();
  outcomes.toggledOffState = await fixture(() => __chatFixture.toggle({ enabled: false, messagingChannelEnabled: false,
    messagesPaused: true, pauseReason: 'teacher' }));
  await settle();
  outcomes.toggledOff = await step(() => fixture(() => __chatFixture.reply('chat-r5c', 'Switched off while paused.')));

  // Phase D4: a server without messagingChannelEnabled cannot tell a pause
  // from an off switch, so a paused class stays off, as before the pause.
  assert.deepEqual(toggles(await fixture(() => __chatFixture.fab({ messagingEnabled: false, messagesPaused: true,
    pauseReason: 'teacher' }))), { messagingEnabled: false, messagesPaused: true });
  await settle();
  outcomes.unknownChannel = await step(() => fixture(() => __chatFixture.reply('chat-r5d', 'Paused by a server without the switch field.')));
  outcomes.inboxAfterOff = await fixture(() => __chatFixture.inbox());

  // Phase E: Attention keeps the screen; the chat waits for it to end. The
  // chat starts closed, so only the message during Attention could open it.
  assert.deepEqual(toggles(await fixture(() => __chatFixture.fab({ messagingEnabled: true, messagingChannelEnabled: true }))),
    { messagingEnabled: true, messagesPaused: false });
  await clickFab('classpilot-fab-message-close');
  await settle();
  const attentionOn = await fixture(() => __chatFixture.state({ attentionMode: { active: true, message: 'Eyes up front' } }));
  assert.equal(attentionOn.attention, true, `Attention was not applied: ${JSON.stringify(attentionOn)}`);
  await page.waitForSelector('#classpilot-attention-overlay', { state: 'attached', timeout: 10_000 });
  await settle();
  outcomes.duringAttention = await step(() => fixture(() => __chatFixture.reply('chat-r6', 'After this, open the quiz.')));
  outcomes.afterAttention = await step(async () => {
    const released = await fixture(() => __chatFixture.state({ attentionMode: { active: false } }));
    assert.equal(released.attention, false, `Attention was not released: ${JSON.stringify(released)}`);
    await page.waitForSelector('#classpilot-attention-overlay', { state: 'detached', timeout: 10_000 });
  });

  // Phase H: the heartbeat inbox path (SchoolPilot pendingMessages rows).
  outcomes.heartbeat = await step(() => fixture(() => __chatFixture.heartbeat([
    { id: 'heartbeat-announcement', message: 'Heartbeat announcement', commandId: 'heartbeat-command' },
    { id: 'heartbeat-legacy-row', message: 'Legacy inbox row', commandId: null },
  ])));
  outcomes.heartbeat.inbox = await fixture(() => __chatFixture.inbox());

  // Phase F: the popup inbox shows teacher text as text.
  outcomes.markupOnPage = await step(() => fixture(text => __chatFixture.reply('chat-r7', text), MARKUP));
  const popup = await context.newPage();
  await popup.goto(`chrome-extension://${new URL(worker.url()).host}/popup.html`, { waitUntil: 'load' });
  await popup.waitForSelector('#messages-container .message-item', { timeout: 15_000 });
  outcomes.popup = await popup.evaluate((markup) => {
    const container = document.getElementById('messages-container');
    const contents = [...container.querySelectorAll('.message-content')];
    return {
      injectedElements: container.querySelectorAll('#injected-markup, b, i, img, script').length,
      shownAsText: contents.some(node => node.textContent === markup),
      texts: contents.map(node => node.textContent),
    };
  }, MARKUP);
  await popup.close();

  // Negotiated lifecycle: the server's generations, not arrival timestamps,
  // fence Redis/heartbeat retries, late closes and hard switch transitions.
  await fixture(() => __chatFixture.enableLifecycle());
  await settle();
  const delayedPrivate = await fixture(() => __chatFixture.replyFrame('lifecycle-old', 'Queued before End Chat'));
  outcomes.lifecycleClose = await step(() => fixture(() => __chatFixture.close()));
  outcomes.lifecycleExpired = await step(() => fixture(frame => __chatFixture.deliverFrame(frame), delayedPrivate));
  await fixture(url => __chatFixture.holdPageClose(url), `${origin}/lesson`);
  await fixture(() => __chatFixture.startClose());
  await fixture(() => __chatFixture.pageCloseHeld());
  const freshBackup = await fixture(() => ({ ...__chatFixture.replyFrame('lifecycle-fresh', 'A fresh generation'), id: 'lifecycle-fresh' }));
  outcomes.lifecycleFresh = await step(() => fixture(frame => __chatFixture.heartbeat([frame]), freshBackup));
  outcomes.lifecycleLateClose = await step(async () => {
    await fixture(() => __chatFixture.releasePageClose()); await fixture(() => __chatFixture.finishClose());
  });
  const beforeOff = await fixture(() => __chatFixture.replyFrame('lifecycle-before-off', 'Queued before hard-off'));
  await fixture(() => __chatFixture.lifecycleOff()); await settle();
  outcomes.lifecycleOffExpired = await step(() => fixture(frame => __chatFixture.deliverFrame(frame), beforeOff));
  outcomes.lifecycleOffAnnouncement = await step(() => fixture(() => __chatFixture.announce('lifecycle-announcement', 'Announcements remain available')));
  await fixture(() => __chatFixture.fab({ messagingEnabled: true, messagingChannelEnabled: true })); await settle();
  outcomes.lifecycleOldEpoch = await step(() => fixture(frame => __chatFixture.deliverFrame(frame), beforeOff));
  outcomes.lifecycleRecovery = await fixture(() => __chatFixture.lifecycleReadAfterMemoryRetirement());
  outcomes.lifecycleRecoveredFresh = await step(() => fixture(() => __chatFixture.reply('lifecycle-recovered', 'Current after protected recovery')));
  outcomes.lifecycleActivityReturn = await fixture(() => __chatFixture.activityReturnWithStaleSnapshot());
  outcomes.lifecycleMissingSnapshot = await step(async () => {
    await fixture(() => __chatFixture.fab({ messagingEnabled: true, messagingChannelEnabled: true, omitLifecycle: true }));
    await fixture(() => __chatFixture.reply('lifecycle-without-state', 'Must wait for known ownership'));
  });
  await fixture(() => __chatFixture.fab({ messagingEnabled: true, messagingChannelEnabled: true }));
  outcomes.lifecycleStudentRetry = await fixture(() => __chatFixture.queuedStudentAcrossClose());
  outcomes.lifecycleTerminalReceipts = await fixture(() => __chatFixture.terminalAckReceipts());
  outcomes.lifecycleMissingDependency = await fixture(() => __chatFixture.withdrawIdempotency());
  await fixture(() => __chatFixture.withdrawLifecycle());
  outcomes.lifecycleWithdrawal = await step(() => fixture(() => __chatFixture.reply('lifecycle-withdrawn', 'Must stay retired after withdrawal')));
  outcomes.lifecycleStudentWithdrawal = await fixture(() => __chatFixture.refusedStudentAfterWithdrawal());

  // Phase G: sign-out leaves nothing of the previous student on the page, and
  // a late frame for that student shows nothing.
  outcomes.signOut = await step(() => fixture(() => __chatFixture.signOut()));
  outcomes.lateRetiredFrame = await step(() => fixture(() => __chatFixture.lateFrameForRetiredStudent('chat-r8',
    'Late message for the previous student')));

  // Phase S: Attention in a scheduled class, in a fresh browser profile.
  await context.close();
  context = null;
  outcomes.scheduled = await runScheduledClassAttention();

  // Every requirement is checked and reported, so one run shows each failure.
  const failures = [];
  const check = (requirement, actual, expected) => {
    try { assert.deepEqual(actual, expected); } catch { failures.push({ requirement, actual, expected }); }
  };
  const titles = list => list.map(item => item.title);
  const has = (list, value) => list.includes(value);

  // B3 and the ordinary path.
  check('a teacher message opens the chat', { open: outcomes.start.open, thread: outcomes.start.thread,
    newToasts: outcomes.start.newToasts, acks: outcomes.start.acks },
  { open: true, thread: ['Can you show me your work?'], newToasts: [], acks: ['chat-r1:delivered', 'chat-r1:seen'] });
  check('B3: the notification reads "Message from Teacher"', outcomes.start.notifications,
    [{ title: 'Message from Teacher', message: 'Can you show me your work?' }]);

  // B1: ending a chat wipes it; a message that arrived before the close and a
  // redelivery never reopen it; a fresh message does, on a new thread.
  check('B1: ending the chat wipes and closes it', outcomes.delayedBeforeClose.closed,
    { open: false, thread: [], newToasts: [ENDED_TOAST] });
  check('B1: a message that arrived before the close does not reopen the chat', {
    ...outcomes.delayedBeforeClose.after, acks: outcomes.delayedBeforeClose.acks,
    inInbox: has(outcomes.inboxAfterClose, 'chat-r2') }, { open: false, thread: [], acks: ['chat-r2:delivered'], inInbox: true });
  check('B1: a redelivery does not reopen the chat', { open: outcomes.redelivery.open, thread: outcomes.redelivery.thread,
    notifications: outcomes.redelivery.notifications }, { open: false, thread: [], notifications: [] });
  check('B1: a fresh teacher message reopens the ended chat on a new thread', { open: outcomes.fresh.open,
    thread: outcomes.fresh.thread, newToasts: outcomes.fresh.newToasts, notifications: titles(outcomes.fresh.notifications),
    acks: outcomes.fresh.acks }, { open: true, thread: ['New question: what is 3/4 of 12?'], newToasts: [],
    notifications: ['Message from Teacher'], acks: ['chat-r3:delivered', 'chat-r3:seen'] });
  for (const [name, id] of [['otherClass', 'chat-other-class'], ['otherStudentSession', 'chat-other-session']]) {
    check(`B1: a message outside the current student session (${name}) changes nothing`, {
      open: outcomes[name].open, thread: outcomes[name].thread, notifications: outcomes[name].notifications,
      inInbox: has(outcomes.inboxAfterClose, id) }, { open: outcomes.fresh.open, thread: outcomes.fresh.thread,
      notifications: [], inInbox: false });
  }
  check('B1: a repeated End chat leaves the ended chat quiet', { open: outcomes.repeatClose.open,
    thread: outcomes.repeatClose.thread, newToasts: outcomes.repeatClose.newToasts }, { open: false, thread: [], newToasts: [] });
  // A close ends only what came before it, in every delivery order.
  check('B1: a command-linked announcement overtakes a close independently of the private conversation',
    outcomes.backupBeforeClose, { overtaken: { open: true, thread: ['New question: what is 3/4 of 12?'], announcement: 'Backup delivery after the close' },
      after: { open: false, thread: [], newToasts: [ENDED_TOAST] },
      stored: { thread: [], closed: true } });
  check('B1: a close that reaches a reloaded page late keeps the conversation that followed it',
    outcomes.lateCloseAfterReload, { reloaded: { open: false, thread: [] },
      shown: { open: true, thread: ['Fresh message after the reload'] },
      after: { open: true, thread: ['Fresh message after the reload'], newToasts: [] },
      stored: { thread: ['Fresh message after the reload'], closed: false } });

  // B2 soft pause: shown read-only with the reason, never the disabled toast.
  check('B2: a paused class shows the teacher message read-only', { open: outcomes.paused.open,
    last: outcomes.paused.thread.at(-1), inputDisabled: outcomes.paused.inputDisabled, banner: outcomes.paused.banner,
    newToasts: outcomes.paused.newToasts, notifications: titles(outcomes.paused.notifications), acks: outcomes.paused.acks },
  { open: true, last: 'Please read page 12.', inputDisabled: true, banner: PAUSED_REASON, newToasts: [],
    notifications: ['Message from Teacher'], acks: ['chat-r4:delivered', 'chat-r4:seen'] });
  check('B2: a paused class still lets the student open the chat to read', { open: outcomes.pausedStudentOpen.open,
    banner: outcomes.pausedStudentOpen.banner, newToasts: outcomes.pausedStudentOpen.newToasts },
  { open: true, banner: PAUSED_REASON, newToasts: [] });

  // B2 off: no chat, no toast, no notification; the inbox keeps it.
  check('B2: with messaging off an incoming message stays quietly in the inbox', { open: outcomes.off.open,
    inThread: has(outcomes.off.thread, 'Messaging is off for this one.'), newToasts: outcomes.off.newToasts,
    notifications: outcomes.off.notifications, acks: outcomes.off.acks, inInbox: has(outcomes.inboxWhileOff, 'chat-r5') },
  { open: false, inThread: false, newToasts: [], notifications: [], acks: ['chat-r5:delivered'], inInbox: true });
  check("B2: the student's own Message click while off keeps today's toast", { open: outcomes.offStudentOpen.open,
    newToasts: outcomes.offStudentOpen.newToasts }, { open: false, newToasts: [DISABLED_TOAST] });

  // B2 with SchoolPilot's hard-switch field: a pause counts only while the
  // channel is on. A pause sent only as the legacy toggle (late sign-ins)
  // still shows read-only; a switch that is off hides the chat even with a
  // pause set; a server without the field keeps a paused class off.
  check('B2: a pause sent only as the legacy messaging-toggle shows the teacher message read-only', {
    worker: outcomes.toggledPauseState, open: outcomes.toggledPause.open, last: outcomes.toggledPause.thread.at(-1),
    inputDisabled: outcomes.toggledPause.inputDisabled, banner: outcomes.toggledPause.banner,
    newToasts: outcomes.toggledPause.newToasts, notifications: titles(outcomes.toggledPause.notifications),
    acks: outcomes.toggledPause.acks },
  { worker: { messagingEnabled: false, messagesPaused: true, messagingChannelEnabled: true }, open: true,
    last: 'Paused, but please read this.', inputDisabled: true, banner: PAUSED_REASON, newToasts: [],
    notifications: ['Message from Teacher'], acks: ['chat-r4b:delivered', 'chat-r4b:seen'] });
  const quiet = (outcome, text) => ({ open: outcome.open, inThread: has(outcome.thread, text),
    messageButton: outcome.messageButton, newToasts: outcome.newToasts, notifications: outcome.notifications });
  const quietExpected = { open: false, inThread: false, messageButton: 'Unavailable', newToasts: [], notifications: [] };
  check('B2: with a switch off and a pause still set, a reply stays quietly in the inbox', {
    ...quiet(outcomes.offPaused, 'Off, with a pause still set.'), acks: outcomes.offPaused.acks },
  { ...quietExpected, acks: ['chat-r5b:delivered'] });
  check('B2: with a switch off and a pause still set, an announcement uses its independent surface', {
    ...quiet(outcomes.offPausedAnnouncement, 'An announcement while off.'),
    commandAcks: outcomes.offPausedAnnouncement.commandAcks },
  { ...quietExpected, notifications: [{ title: 'Message from Teacher', message: 'An announcement while off.' }],
    commandAcks: ['received:pending', 'completed:applied'] });
  check("B2: with a switch off and a pause still set, the student's Message click keeps today's toast", {
    open: outcomes.offPausedStudentOpen.open, messageButton: outcomes.offPausedStudentOpen.messageButton,
    newToasts: outcomes.offPausedStudentOpen.newToasts }, { open: false, messageButton: 'Unavailable', newToasts: [DISABLED_TOAST] });
  check('B2: a legacy messaging-toggle that switches a paused class off hides its chat', {
    worker: outcomes.toggledOffState, ...quiet(outcomes.toggledOff, 'Switched off while paused.'), acks: outcomes.toggledOff.acks },
  { worker: { messagingEnabled: false, messagesPaused: true, messagingChannelEnabled: false }, ...quietExpected,
    acks: ['chat-r5c:delivered'] });
  check('B2: a pause from a server without the switch field keeps the chat off', {
    ...quiet(outcomes.unknownChannel, 'Paused by a server without the switch field.'), acks: outcomes.unknownChannel.acks },
  { ...quietExpected, acks: ['chat-r5d:delivered'] });
  check('B2: messages that arrive while messaging is off stay in the popup inbox',
    ['chat-r5b', 'chat-a1', 'chat-r5c', 'chat-r5d'].map(id => has(outcomes.inboxAfterOff, id)), [true, true, true, true]);

  // Attention: deferred while the overlay is up, shown and seen after it.
  check('Attention: a teacher message neither opens nor is seen under the overlay', { open: outcomes.duringAttention.open,
    overlay: outcomes.duringAttention.overlay, inputFocused: outcomes.duringAttention.inputFocused,
    notifications: outcomes.duringAttention.notifications, acks: outcomes.duringAttention.acks },
  { open: false, overlay: true, inputFocused: false, notifications: [], acks: ['chat-r6:delivered'] });
  check('Attention: the deferred message is shown, seen and announced once Attention ends', { open: outcomes.afterAttention.open,
    overlay: outcomes.afterAttention.overlay, last: outcomes.afterAttention.thread.at(-1), acks: outcomes.afterAttention.acks,
    notifications: titles(outcomes.afterAttention.notifications) },
  { open: true, overlay: false, last: 'After this, open the quiz.', acks: ['chat-r6:seen'], notifications: ['Message from Teacher'] });
  // A scheduled class: the release advances the student's control revision
  // before SchoolPilot's FAB snapshot catches the class up.
  const scheduledView = outcome => ({ open: outcome.open, overlay: outcome.overlay, last: outcome.thread.at(-1),
    acks: outcome.acks, notifications: outcome.notifications });
  check('scheduled class: a teacher message outside Attention is shown, seen and announced',
    scheduledView(outcomes.scheduled.outside), { open: true, overlay: false, last: 'Outside Attention',
      acks: ['scheduled-r1:delivered', 'scheduled-r1:seen'], notifications: ['Message from Teacher'] });
  check('scheduled class: a teacher message neither opens nor is seen under the overlay', {
    during: scheduledView(outcomes.scheduled.during), duringAgain: scheduledView(outcomes.scheduled.duringAgain) }, {
    during: { open: false, overlay: true, last: 'During Attention', acks: ['scheduled-r2:delivered'], notifications: [] },
    duringAgain: { open: false, overlay: true, last: 'During the next Attention', acks: ['scheduled-r3:delivered'],
      notifications: [] } });
  check('scheduled class: the held message is shown, seen and announced once Attention ends (classroom-state-sync, then FAB)',
    scheduledView(outcomes.scheduled.released), { open: true, overlay: false, last: 'During Attention',
      acks: ['scheduled-r2:seen'], notifications: ['Message from Teacher'] });
  check('scheduled class: the held message is shown, seen and announced once Attention ends (FAB snapshot first)',
    scheduledView(outcomes.scheduled.releasedFabFirst), { open: true, overlay: false, last: 'During the next Attention',
      acks: ['scheduled-r3:seen'], notifications: ['Message from Teacher'] });

  // Heartbeat announcements use the modal; legacy rows stay in the inbox.
  check('heartbeat: an announcement reaches its modal and a legacy row stays in the inbox', {
    announcement: outcomes.heartbeat.announcement, legacyInThread: has(outcomes.heartbeat.thread, 'Legacy inbox row'),
    inbox: ['heartbeat-announcement', 'heartbeat-legacy-row'].map(id => has(outcomes.heartbeat.inbox, id)) },
  { announcement: 'Heartbeat announcement', legacyInThread: false, inbox: [true, true] });

  check('lifecycle: queued private message before End Chat never opens or ACKs delivered', {
    open: outcomes.lifecycleExpired.open, thread: outcomes.lifecycleExpired.thread,
    notifications: outcomes.lifecycleExpired.notifications, delivered: outcomes.lifecycleExpired.acks.includes('lifecycle-old:delivered') },
  { open: false, thread: [], notifications: [], delivered: false });
  check('lifecycle: fresh G survives delayed close G', { fresh: outcomes.lifecycleFresh.thread,
    afterClose: outcomes.lifecycleLateClose.thread, open: outcomes.lifecycleLateClose.open },
  { fresh: ['A fresh generation'], afterClose: ['A fresh generation'], open: true });
  for (const key of ['lifecycleOffExpired', 'lifecycleOldEpoch', 'lifecycleWithdrawal'])
    check(`lifecycle: ${key} never delivers private content`, {
      contains: outcomes[key].thread.some(text => text.includes('Queued before hard-off') || text.includes('Must stay retired')),
      notifications: outcomes[key].notifications, delivered: outcomes[key].acks.some(ack => ack.endsWith(':delivered')) },
    { contains: false, notifications: [], delivered: false });
  check('lifecycle: hard-off leaves announcements available', { announcement: outcomes.lifecycleOffAnnouncement.announcement,
    notifications: titles(outcomes.lifecycleOffAnnouncement.notifications) },
  { announcement: 'Announcements remain available', notifications: ['Message from Teacher'] });
  check('lifecycle: watermarks survive memory retirement only in protected session storage', outcomes.lifecycleRecovery,
    { schoolEpoch: 2, generation: 3, localPresent: false, sessionPresent: true });
  check('lifecycle: protected recovery permits only a current generation', outcomes.lifecycleRecoveredFresh.thread,
    ['Current after protected recovery']);
  check('lifecycle: typed activity return cannot lower the retired generation after protected reload', outcomes.lifecycleActivityReturn,
    { floor: 3, oldDelivered: false });
  check('lifecycle: missing full-state ownership does not ACK private delivery', {
    newText: outcomes.lifecycleMissingSnapshot.thread.includes('Must wait for known ownership'),
    delivered: outcomes.lifecycleMissingSnapshot.acks.some(ack => ack.endsWith(':delivered')),
    notifications: outcomes.lifecycleMissingSnapshot.notifications }, { newText: false, delivered: false, notifications: [] });
  check('lifecycle: a queued student reply keeps its token and never retries across End Chat', outcomes.lifecycleStudentRetry,
    { queued: true, frozenGeneration: 3, postGeneration: 3, transmissions: 1, remainsQueued: false });
  check('lifecycle: terminal expiry drains ACK while ordinary stale authority remains retryable', outcomes.lifecycleTerminalReceipts,
    { tokenRetained: true, expiredDrained: true, authorityStaleRetained: true });
  check('lifecycle: admission requires student idempotency support', outcomes.lifecycleMissingDependency, false);
  check('lifecycle: capability withdrawal never sends a new student reply through legacy transport', outcomes.lifecycleStudentWithdrawal,
    { code: 'PRIVATE_CHAT_LIFECYCLE_UNAVAILABLE', transmitted: false });

  // B4: teacher text stays text on the page and in the popup inbox.
  check('the page chat shows teacher markup as text', outcomes.markupOnPage.thread.at(-1), MARKUP);
  check('B4: the popup inbox shows teacher markup as text', { injectedElements: outcomes.popup.injectedElements,
    shownAsText: outcomes.popup.shownAsText }, { injectedElements: 0, shownAsText: true });

  // Sign-out cleanup.
  check('sign-out leaves no chat of the previous student', { open: outcomes.signOut.open, thread: outcomes.signOut.thread },
    { open: false, thread: [] });
  check('a late frame for the previous student shows nothing', { open: outcomes.lateRetiredFrame.open,
    thread: outcomes.lateRetiredFrame.thread, notifications: outcomes.lateRetiredFrame.notifications },
  { open: false, thread: [], notifications: [] });

  console.log(JSON.stringify({ teacherChat: outcomes }, null, 2));
  if (failures.length > 0) {
    console.error(JSON.stringify({ failures }, null, 2));
    throw new Error(`${failures.length} teacher chat requirement(s) failed: ${failures.map(item => item.requirement).join('; ')}`);
  }
  console.log('PASS teacher messages reopen an ended chat only when fresh, survive a late close, follow pause, off and Attention (live and scheduled classes), read "Message from Teacher", stay text in the popup, and clear on sign-out');
} finally {
  if (context) await context.close().catch(() => {});
  rmSync(profile, { recursive: true, force: true });
}
