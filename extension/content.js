// ClassPilot - Content Script
// Displays messages as full-screen modals on student screens
// Handles attention mode, timers, and polls
// Monitors camera usage

// Prevent double-injection
if (window.__CLASSPILOT_CONTENT_LOADED__) {
  // Script already loaded, exit early
} else {
  window.__CLASSPILOT_CONTENT_LOADED__ = true;

// Track active camera streams
let activeCameraStreams = new Set();
let cameraActive = false;

// Track overlay states
let attentionModeActive = false;
let timerInterval = null;
let timerEndTime = null;
let timerAutoHideTimeout = null;
let activeTimerIdentity = null;
let activePollId = null;
let activePollTeachingSessionId = null;
const pollCompletionTimeouts = new Set();
const respondedPollIds = new Set(); // prevent re-showing polls already answered
const seenChatMsgIds = new Set(); // dedup chat-reply messages
let authGateActive = false;
let authGateBlockerInstalled = false;
let authGateRosterRequestGeneration = 0;
let authGateStateRequestGeneration = 0;
let authGateLatestRevision = -1;
let authGateRetryTimer = null;
let authGateRetryFallbackIndex = 0;
let authGateLiveRosterLoaded = false;
let authGateRosterSnapshot = null;
let authGateRosterRefreshTimer = null;
let authGateCurrentState = null;
let authGateSecureShadow = null;
let authGateSecureFrame = null;
let authGateTrustedRoot = null;
let authGateTrustedPhase = 'loading';
let authGateSecureFallback = null;
let authGateSecureFrameNonce = '';
let authGateSecureFrameReady = false;
let authGateSecureFrameTrusted = false;
let authGateSecureFramePendingPhase = 'loading';
let authGateSecureFrameRecoveryTimer = null;
let authGateConnectionObserver = null;
let authGateWatchdogScheduled = false;
let authGateWatchdogRecovering = false;
let authGateWatchdogDeferredTimer = null;
let authGateWatchdogWindowStartedAt = 0;
let authGateWatchdogRecoveryCount = 0;
let authGateWatchdogRecoverySerial = 0;
let authGateFullscreenExitPending = false;
let authGateManagedPolicyFenceSerial = 0;
let authGatePendingManagedPolicyFence = 0;
let authGateManagedPolicyFenceRetryTimer = null;
let studentMessageEpoch = 0;
let currentStudentMessageContext = null;
let currentFabAuthorityBinding = null;
const authGateQuarantinedElements = new Map();
const authGateDetachedBrowsingContexts = new Map();
const AUTH_GATE_FRAME_ORIGIN = chrome.runtime.getURL('').replace(/\/$/, '');
const AUTH_GATE_ROSTER_REFRESH_MIN_MS = 25_000;
const AUTH_GATE_ROSTER_REFRESH_MAX_MS = 35_000;
const AUTH_GATE_ROSTER_REFRESH_BACKOFF_MAX_MS = 5 * 60_000;
const AUTH_GATE_PRESENCE_PULSE_MS = 10_000;
const authGatePresenceInstanceId = (() => {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
})();
let authGatePresencePulseTimer = null;
let authGatePresenceSignalActive = false;
let authGatePresenceLastSignaledRosterContextGeneration = null;

function authGatePresenceSignalIsEligible() {
  const generation = authGateRosterContextGeneration(authGateCurrentState || {});
  return Boolean(
    authGateActive
    && authGateTrustedRoot?.isConnected
    && authGateSecureFrame?.isConnected
    && authGateSecureFrameReady
    && authGateSecureFrameTrusted
    && authGateTrustedPhase === 'ready'
    && authGatePhase(authGateCurrentState || {}) === 'ready'
    && authGateCurrentState?.authRequired !== false
    && !isAuthGateManagedPolicyFencePending()
    && document.visibilityState === 'visible'
    && generation !== null
  );
}

function dispatchAuthGatePresenceSignal(present) {
  const generation = present === true
    ? authGateRosterContextGeneration(authGateCurrentState || {})
    : authGatePresenceLastSignaledRosterContextGeneration;
  if (generation === null) return;
  if (present === true) authGatePresenceLastSignaledRosterContextGeneration = generation;
  chrome.runtime.sendMessage({
    type: 'student-auth-gate-presence',
    present: present === true,
    instanceId: authGatePresenceInstanceId,
    rosterContextGeneration: generation,
  }, () => {
    void chrome.runtime.lastError;
  });
  if (present !== true) authGatePresenceLastSignaledRosterContextGeneration = null;
}

function stopAuthGatePresenceSignal() {
  if (authGatePresencePulseTimer !== null) {
    clearTimeout(authGatePresencePulseTimer);
    authGatePresencePulseTimer = null;
  }
  if (authGatePresenceSignalActive) {
    authGatePresenceSignalActive = false;
    dispatchAuthGatePresenceSignal(false);
  }
}

function reconcileAuthGatePresenceSignal() {
  if (!authGatePresenceSignalIsEligible()) {
    stopAuthGatePresenceSignal();
    return;
  }
  authGatePresenceSignalActive = true;
  dispatchAuthGatePresenceSignal(true);
  if (authGatePresencePulseTimer !== null) clearTimeout(authGatePresencePulseTimer);
  authGatePresencePulseTimer = setTimeout(() => {
    authGatePresencePulseTimer = null;
    reconcileAuthGatePresenceSignal();
  }, AUTH_GATE_PRESENCE_PULSE_MS);
}

function withCurrentStudentMessageContext(message, apply, sendResponse) {
  const studentMessageContext = message?.studentMessageContext;
  const expectedMessageEpoch = studentMessageEpoch;
  if (!studentMessageContext?.authContextId) {
    sendResponse?.({ success: false, ignored: true });
    return false;
  }
  chrome.runtime.sendMessage({
    type: 'validate-student-message-context',
    studentMessageContext,
  }, (response) => {
    if (
      expectedMessageEpoch === studentMessageEpoch
      && !chrome.runtime.lastError
      && response?.success
      && response.current === true
    ) {
      currentStudentMessageContext = { ...studentMessageContext };
      currentFabAuthorityBinding = response.fabBinding || null;
      apply();
      sendResponse?.({ success: true });
      return;
    }
    sendResponse?.({ success: false, ignored: true });
  });
  return true;
}

function sameStudentMessageContext(left, right) {
  return Boolean(
    left?.authContextId
    && right?.authContextId
    && left.authContextId === right.authContextId
    && left.schoolId === right.schoolId
    && left.studentId === right.studentId
    && left.studentSessionId === right.studentSessionId
  );
}

function captureStudentActionContext(preferredSessionId = null) {
  const sessions = Array.isArray(currentFabContext?.activeSessionIds)
    ? currentFabContext.activeSessionIds.map((value) => String(value || '').trim()).filter(Boolean)
    : [];
  const requestedSessionId = String(preferredSessionId || '').trim();
  const fabSessionId = String(currentFabContext?.teachingSessionId || '').trim();
  const sessionId = requestedSessionId && sessions.includes(requestedSessionId)
    ? requestedSessionId
    : fabSessionId && sessions.includes(fabSessionId)
      ? fabSessionId
      : sessions.length === 1 ? sessions[0] : null;
  if (
    !currentStudentMessageContext?.authContextId
    || !currentFabAuthorityBinding
    || !sessionId
  ) return null;
  return Object.freeze({
    studentMessageContext: { ...currentStudentMessageContext },
    fabBinding: currentFabAuthorityBinding,
    sessionId,
    epoch: studentMessageEpoch,
  });
}

function studentActionContextIsCurrent(context) {
  const sessions = Array.isArray(currentFabContext?.activeSessionIds)
    ? currentFabContext.activeSessionIds
    : [];
  return Boolean(
    context
    && context.epoch === studentMessageEpoch
    && sameStudentMessageContext(context.studentMessageContext, currentStudentMessageContext)
    && context.fabBinding === currentFabAuthorityBinding
    && sessions.includes(context.sessionId)
  );
}

function studentActionAuthorityPayload(context) {
  return {
    studentMessageContext: { ...context.studentMessageContext },
    fabBinding: context.fabBinding,
    sessionId: context.sessionId,
  };
}

function clearPollCompletionTimeouts() {
  for (const timeoutId of pollCompletionTimeouts) clearTimeout(timeoutId);
  pollCompletionTimeouts.clear();
}

function clearStudentBoundUiForIdentityTransition() {
  if (timerInterval) clearInterval(timerInterval);
  timerInterval = null;
  if (timerAutoHideTimeout) clearTimeout(timerAutoHideTimeout);
  timerAutoHideTimeout = null;
  timerEndTime = null;
  activeTimerIdentity = null;
  clearPollCompletionTimeouts();
  activePollId = null;
  activePollTeachingSessionId = null;
  attentionModeActive = false;
  handRaised = false;
  messagingEnabled = false;
  handRaisingEnabled = false;
  currentFabContext = null;
  fabExpanded = false;
  for (const id of [
    'classpilot-attention-overlay',
    'classpilot-timer-overlay',
    'classpilot-poll-overlay',
    'classpilot-message-modal',
    'classpilot-chat-notification',
  ]) document.getElementById(id)?.remove();
  hideMessageBox();
  closeFabMenu();
  updateFabHandState();
  updateFabMessageState();
}

// Listen for messages from service worker
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender?.id && sender.id !== chrome.runtime.id) {
    sendResponse?.({ success: false, error: 'Invalid sender' });
    return false;
  }

  if (message.type === 'CLASSPILOT_AUTH_REQUIRED') {
    if (isAuthGateManagedPolicyFencePending()) {
      sendResponse?.({ success: true, fenced: true });
      return false;
    }
    reconcileKioskFabSuppression(message.state?.kioskOrigin);
    applyAuthGateState(message.state || {});
    sendResponse?.({ success: true });
    return false;
  }

  if (message.type === 'CLASSPILOT_AUTH_COMPLETE') {
    if (isAuthGateManagedPolicyFencePending()) {
      sendResponse?.({ success: true, fenced: true });
      return false;
    }
    reconcileKioskFabSuppression(message.state?.kioskOrigin);
    applyAuthGateState({ ...(message.state || {}), phase: 'authenticated', authRequired: false });
    updateFabIdentityState(message.state);
    sendResponse?.({ success: true });
    return false;
  }

  if (message.type === 'student-message-state-cleared') {
    const retiredContext = message.data?.retiredStudentMessageContext || null;
    if (
      retiredContext?.authContextId
      && currentStudentMessageContext?.authContextId
      && !sameStudentMessageContext(retiredContext, currentStudentMessageContext)
    ) {
      sendResponse?.({ success: true, ignored: true });
      return false;
    }
    // Invalidate validation callbacks synchronously. A retired teacher message
    // must not render after the worker has already cleared identity-bound UI.
    studentMessageEpoch += 1;
    currentStudentMessageContext = null;
    currentFabAuthorityBinding = null;
    seenChatMsgIds.clear();
    respondedPollIds.clear();
    chatMessages = [];
    chatClosed = false;
    clearStudentBoundUiForIdentityTransition();
    renderChatMessages();
    sendResponse?.({ success: true });
    return false;
  }

  if (message.type === 'student-message-status') {
    return withCurrentStudentMessageContext(message, () => {
      const update = message.data || {};
      const clientMessageId = String(update.clientMessageId || '');
      const chatMessage = chatMessages.find((item) =>
        item.sender === 'student' && item.clientMessageId === clientMessageId
      );
      if (chatMessage) {
        chatMessage.status = ['Sending', 'Retrying', 'Delivered', 'Failed'].includes(update.status)
          ? update.status
          : chatMessage.status;
        if (update.messageId) chatMessage.id = update.messageId;
        persistFabChatState();
        renderChatMessages();
      }
    }, sendResponse);
  }

  if (message.type === 'classroom-overlay-state-sync') {
    return withCurrentStudentMessageContext(message, () => {
      if (
        message.data?.studentMessageContext
        && !sameStudentMessageContext(
          message.data.studentMessageContext,
          message.studentMessageContext,
        )
      ) return;
      if ((message.data?.fabBinding || null) !== (currentFabAuthorityBinding || null)) return;
      applyClassroomUiSnapshot(message.data || {});
    }, sendResponse);
  }

  if (message.type === 'show-message') {
    // Kiosk purity (2.6.8): classroom broadcasts must never render over a
    // hall-pass kiosk — there is no signed-in student there to address.
    if (isPassPilotKioskPage()) return false;
    return withCurrentStudentMessageContext(message, () => {
      // Broadcast messages (not replies) still show as modal.
      if (!message.data.isTeacherReply) showMessageModal(message.data);
    }, sendResponse);
  }

  // Teacher reply — add to chat thread (ignore if teacher already closed the chat)
  if (message.type === 'chat-reply') {
    return withCurrentStudentMessageContext(message, () => {
      // Both checks intentionally live after the asynchronous worker
      // validation; either value can change while that request is pending.
      if (chatClosed) return;
      const activeFabSessions = currentFabContext?.activeSessionIds || [];
      if (message.data?.sessionId && activeFabSessions.length > 0
          && !activeFabSessions.includes(message.data.sessionId)) return;
      // Dedup: skip if we've already processed this exact message.
      const msgId = message.data?._msgId;
      if (msgId) {
        if (seenChatMsgIds.has(msgId)) {
          console.log('[ClassPilot] Dedup: skipping duplicate chat reply');
          return;
        }
        seenChatMsgIds.add(msgId);
        setTimeout(() => seenChatMsgIds.delete(msgId), 60000);
      }
      chatMessages.push({
        id: message.data?.chatMessageId || message.data?.messageId || msgId,
        sessionId: message.data?.sessionId,
        sender: 'teacher',
        text: message.data.message,
        fromName: message.data.fromName,
        time: Date.now(),
      });
      persistFabChatState();
      const chatBox = document.getElementById('classpilot-fab-message-box');
      if (!chatBox?.classList.contains('classpilot-fab-message-box-open')) showMessageBox();
      renderChatMessages();
    }, sendResponse);
  }

  // Teacher closed the chat — only act if chat is active (dedup replays)
  if (message.type === 'chat-closed') {
    return withCurrentStudentMessageContext(message, () => {
      if (chatClosed) return;
      chatMessages = [];
      chatClosed = true;
      persistFabChatState();
      renderChatMessages();
      hideMessageBox();
      closeFabMenu();
      showFabNotification('Teacher ended the chat.');
    }, sendResponse);
  }

  if (message.type === 'check-blocked-domain') {
    const currentDomain = window.location.hostname;
    sendResponse({ domain: currentDomain });
    return true; // async sendResponse
  }

  if (message.type === 'get-camera-status') {
    sendResponse({ cameraActive: cameraActive });
    return true; // async sendResponse
  }

  if (message.type === 'CLASSPILOT_LICENSE_INACTIVE') {
    return withCurrentStudentMessageContext(message, () => {
      showLicenseBanner(message.data?.planStatus ?? message.planStatus);
    }, sendResponse);
  }

  if (message.type === 'CLASSPILOT_LICENSE_ACTIVE') {
    return withCurrentStudentMessageContext(message, () => {
      removeLicenseBanner();
    }, sendResponse);
  }

  // Attention Mode handlers (kiosk-filtered: overlays never cover a kiosk)
  if (message.type === 'attention-mode') {
    if (isPassPilotKioskPage()) return false;
    return withCurrentStudentMessageContext(message, () => {
      if (message.data.active) {
        showAttentionOverlay(message.data.message || 'Please look up!');
      } else {
        hideAttentionOverlay();
      }
    }, sendResponse);
  }

  // Timer handlers (kiosk-filtered)
  if (message.type === 'timer') {
    if (isPassPilotKioskPage()) return false;
    return withCurrentStudentMessageContext(message, () => {
      if (message.data.action === 'start') {
        startTimerOverlay(message.data.seconds, message.data.message, message.data.endsAt);
      } else if (message.data.action === 'stop') {
        stopTimerOverlay();
      }
    }, sendResponse);
  }

  // Poll handlers (kiosk-filtered)
  if (message.type === 'poll') {
    if (isPassPilotKioskPage()) return false;
    return withCurrentStudentMessageContext(message, () => {
      if (message.data.action === 'start') {
        showPollOverlay(
          message.data.pollId,
          message.data.question,
          message.data.options,
          message.data.teachingSessionId,
        );
      } else if (message.data.action === 'close') {
        hidePollOverlay();
      }
    }, sendResponse);
  }

  if (message.type === 'poll-response-succeeded') {
    return withCurrentStudentMessageContext(message, () => {
      completePollResponse(message.data?.pollId, message.data?.selectedOption);
    }, sendResponse);
  }

  // Chat message notification
  if (message.type === 'chat-notification') {
    return withCurrentStudentMessageContext(message, () => {
      showChatNotification(message.data.message, message.data.fromName);
    }, sendResponse);
  }

  // Hand dismissed notification — only show if hand was actually raised (dedup replays)
  if (message.type === 'hand-dismissed') {
    return withCurrentStudentMessageContext(message, () => {
      if (!handRaised) return;
      handRaised = false;
      updateFabHandState();
      showChatNotification('Your teacher acknowledged your raised hand.', 'Teacher');
    }, sendResponse);
  }

  // Messaging toggle (enable/disable messaging)
  if (message.type === 'messaging-toggle') {
    return withCurrentStudentMessageContext(message, () => {
      applyFabState({ messagingEnabled: message.data.enabled, reason: 'messaging-toggle' });
    }, sendResponse);
  }

  // Complete FAB state pushed when a class session starts/ends.
  if (message.type === 'fab-state') {
    return withCurrentStudentMessageContext(message, () => {
      applyFabState(message.data || {});
    }, sendResponse);
  }
});

function requestAuthGateState() {
  if (isAuthGateManagedPolicyFencePending()) {
    if (authGatePendingManagedPolicyFence === 0) beginAuthGateManagedPolicyFence();
    return;
  }
  const requestGeneration = ++authGateStateRequestGeneration;
  chrome.runtime.sendMessage({ type: 'get-auth-state' }, (response) => {
    if (requestGeneration !== authGateStateRequestGeneration ||
        isAuthGateManagedPolicyFencePending()) return;
    if (chrome.runtime.lastError || !response?.success || !response.state) {
      if (globalThis.__classpilotAuthGateBootstrap?.active) {
        showAuthGate({ phase: 'loading', authRequired: true });
      }
      return;
    }
    reconcileKioskFabSuppression(response?.state?.kioskOrigin);
    applyAuthGateState(response.state);
    updateFabIdentityState(response?.state);
  });
}

function isAuthGateManagedPolicyFencePending() {
  return authGatePendingManagedPolicyFence > 0 ||
    globalThis.__classpilotAuthGateBootstrap?.managedPolicyFencePending === true;
}

function nextAuthGateManagedPolicyFence() {
  authGateManagedPolicyFenceSerial = authGateManagedPolicyFenceSerial >= Number.MAX_SAFE_INTEGER
    ? 1
    : authGateManagedPolicyFenceSerial + 1;
  return authGateManagedPolicyFenceSerial;
}

function scheduleAuthGateManagedPolicyFenceRetry(fence) {
  if (authGatePendingManagedPolicyFence !== fence ||
      authGateManagedPolicyFenceRetryTimer !== null) return;
  authGateManagedPolicyFenceRetryTimer = setTimeout(() => {
    authGateManagedPolicyFenceRetryTimer = null;
    requestAuthGateManagedPolicyRevalidation(fence);
  }, 250);
}

function requestAuthGateManagedPolicyRevalidation(fence) {
  if (authGatePendingManagedPolicyFence !== fence) return;
  chrome.runtime.sendMessage({
    type: 'get-auth-state',
    revalidateManagedPolicy: true,
    managedPolicyFence: fence,
  }, (response) => {
    if (authGatePendingManagedPolicyFence !== fence) return;
    const responseRevision = authGateRevision(response?.state);
    const workerGeneration = Number(response?.managedPolicyGeneration);
    const validFenceAck = !chrome.runtime.lastError && response?.success === true &&
      response?.managedPolicyFence === fence &&
      Number.isSafeInteger(workerGeneration) && workerGeneration >= 0 &&
      responseRevision !== null && responseRevision >= authGateLatestRevision;
    if (!validFenceAck) {
      showAuthGate({
        phase: 'loading',
        authRequired: true,
        revision: authGateLatestRevision >= 0 ? authGateLatestRevision : undefined,
      });
      markSecureAuthGateFrameUntrusted();
      scheduleAuthGateManagedPolicyFenceRetry(fence);
      return;
    }

    authGatePendingManagedPolicyFence = 0;
    if (authGateManagedPolicyFenceRetryTimer !== null) {
      clearTimeout(authGateManagedPolicyFenceRetryTimer);
      authGateManagedPolicyFenceRetryTimer = null;
    }
    reconcileKioskFabSuppression(response.state.kioskOrigin);
    applyAuthGateState(response.state, { managedPolicyFenceValidated: true });
    updateFabIdentityState(response.state);
    if (authGateActive) resetSecureAuthGateFrame();
  });
}

function beginAuthGateManagedPolicyFence() {
  const fence = nextAuthGateManagedPolicyFence();
  authGatePendingManagedPolicyFence = fence;
  authGateStateRequestGeneration += 1;
  if (authGateManagedPolicyFenceRetryTimer !== null) {
    clearTimeout(authGateManagedPolicyFenceRetryTimer);
    authGateManagedPolicyFenceRetryTimer = null;
  }
  showAuthGate({
    phase: 'loading',
    authRequired: true,
    revision: authGateLatestRevision >= 0 ? authGateLatestRevision : undefined,
  });
  clearSecureAuthGateFrameRecovery();
  markSecureAuthGateFrameUntrusted();
  requestAuthGateManagedPolicyRevalidation(fence);
}

const AUTH_GATE_PHASES = new Set([
  'authenticated',
  'loading',
  'ready',
  'setup_required',
  'unavailable',
]);

function authGatePhase(state = {}) {
  if (AUTH_GATE_PHASES.has(state.phase)) return state.phase;
  if (state.authRequired === false) return 'authenticated';
  if (state.setupRequired === true) return 'setup_required';
  // Compatibility with 2.6.5 workers and test fixtures, whose auth-required
  // state represented a fully fetched form without an explicit phase.
  return state.loginMethod === 'email_id' || state.loginMethod === 'name_pin'
    ? 'ready'
    : 'loading';
}

function authGateRevision(state = {}) {
  const revision = Number(state.revision);
  return Number.isSafeInteger(revision) && revision >= 0 ? revision : null;
}

function authGateRosterContextGeneration(state = {}) {
  const generation = Number(state.rosterContextGeneration);
  return Number.isSafeInteger(generation) && generation >= 0 ? generation : null;
}

function isAuthGateStateStale(state = {}) {
  const revision = authGateRevision(state);
  return revision !== null && revision < authGateLatestRevision;
}

function applyAuthGateState(state = {}, options = {}) {
  if (isAuthGateManagedPolicyFencePending() && options.managedPolicyFenceValidated !== true) return;
  if (isAuthGateStateStale(state)) return;
  const revision = authGateRevision(state);
  if (revision !== null) authGateLatestRevision = Math.max(authGateLatestRevision, revision);

  const phase = authGatePhase(state);
  if (phase === 'authenticated' || state.authRequired === false) {
    recordAuthGateOutcome({ ...state, phase: 'authenticated', authRequired: false });
    removeAuthGate();
    return;
  }

  // The emergency policy restores 2.6.5's wait-before-paint behavior. Its
  // eventual ready/setup state still renders through this same content script.
  if (state.fastAuthGateEnabled === false && phase === 'loading') {
    removeAuthGate();
    return;
  }

  showAuthGate({ ...state, phase, authRequired: true });
}

// ============================================================================
// PassPilot kiosk FAB suppression
// ============================================================================
// A shared hall-pass kiosk has no signed-in student to message, raise a hand
// for, or sign out — the interactive student FAB is suppressed on the kiosk
// pages while the "Monitored by school" disclosure indicator stays visible.
// Any full navigation back to a normal page re-evaluates and restores the
// full FAB. The path is known at mount time; the authoritative kiosk origin
// arrives with the auth-gate state and reconciles the decision.
let knownKioskOrigin = null;

function isPassPilotKioskPath() {
  return window.location.pathname === '/passpilot/kiosk' ||
    window.location.pathname.startsWith('/passpilot/kiosk/');
}

function isPassPilotKioskPage() {
  // Path match alone suppresses (2.6.8 ratchet). The old origin comparison
  // was an un-suppress escape: once the auth-gate state delivered a kiosk
  // origin that mismatched window.location.origin (vanity managed serverUrl,
  // www↔apex canonical redirects), reconcile REBUILT the full student FAB on
  // a live hall-pass kiosk. Teacher-facing kiosk purity wins over the
  // theoretical false positive of a third-party site that happens to serve a
  // /passpilot/kiosk/ path — worst case there is a missing FAB, not student
  // UI on a kiosk.
  return isPassPilotKioskPath();
}

function reconcileKioskFabSuppression(kioskOrigin) {
  if (typeof kioskOrigin === 'string' && kioskOrigin) {
    knownKioskOrigin = kioskOrigin;
  }
  const container = document.getElementById('classpilot-fab-container');
  if (!container) return;
  const suppressed = isPassPilotKioskPage();
  const hasStudentFab = Boolean(document.getElementById('classpilot-fab-main'));
  if (suppressed === !hasStudentFab) return;
  createFloatingActionButton();
}

function applyClassroomUiSnapshot(snapshot = {}) {
    const attention = snapshot.classroomState?.restrictions?.attentionMode;
    if (attention?.active) {
      showAttentionOverlay(attention.message || 'Please look up!');
    } else {
      hideAttentionOverlay();
    }
    const timer = snapshot.overlays?.timer;
    if (timer?.endsAt > Date.now()) {
      startTimerOverlay(null, timer.message, timer.endsAt);
    } else {
      stopTimerOverlay();
    }
    const poll = snapshot.overlays?.poll;
    if (poll && !poll.response && poll.expiresAt > Date.now()) {
      showPollOverlay(poll.pollId, poll.question, poll.options, poll.teachingSessionId);
    } else if (!poll) {
      hidePollOverlay();
    }
    if (snapshot.fabContext) currentFabContext = snapshot.fabContext;
    if (snapshot.fabState) {
      applyFabState({ ...snapshot.fabState, context: snapshot.fabContext });
    }
}

function requestClassroomOverlayState() {
  const requestEpoch = studentMessageEpoch;
  chrome.runtime.sendMessage({ type: 'get-student-message-context' }, (contextResponse) => {
    if (
      requestEpoch !== studentMessageEpoch
      || chrome.runtime.lastError
      || contextResponse?.success !== true
      || !contextResponse.studentMessageContext?.authContextId
    ) return;
    const expectedContext = contextResponse.studentMessageContext;
    chrome.runtime.sendMessage({
      type: 'get-classroom-overlay-state',
      studentMessageContext: expectedContext,
    }, (response) => {
      if (
        requestEpoch !== studentMessageEpoch
        || chrome.runtime.lastError
        || response?.success !== true
        || !sameStudentMessageContext(response.studentMessageContext, expectedContext)
      ) return;
      chrome.runtime.sendMessage({
        type: 'validate-student-message-context',
        studentMessageContext: expectedContext,
      }, (validation) => {
        if (
          requestEpoch !== studentMessageEpoch
          || chrome.runtime.lastError
          || validation?.success !== true
          || validation.current !== true
          || (validation.fabBinding || null) !== (response.fabBinding || null)
        ) return;
        currentStudentMessageContext = { ...expectedContext };
        currentFabAuthorityBinding = response.fabBinding || null;
        applyClassroomUiSnapshot(response);
      });
    });
  });
}

const AUTH_GATE_BLOCKED_INPUT_EVENTS = [
  'pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick',
  'contextmenu', 'keydown', 'keyup', 'keypress', 'beforeinput', 'input',
  'wheel', 'touchstart', 'touchmove', 'touchend', 'dragstart', 'drop', 'submit',
];

function installAuthGateEventContainment(gate) {
  if (!gate || gate.dataset.classpilotAuthContainmentInstalled === 'true') return;
  gate.dataset.classpilotAuthContainmentInstalled = 'true';
  for (const eventName of AUTH_GATE_BLOCKED_INPUT_EVENTS) {
    gate.addEventListener(eventName, (event) => event.stopPropagation());
  }
}

function installAuthGateBlockers() {
  const gate = authGateTrustedRoot?.isConnected ? authGateTrustedRoot : null;
  if (globalThis.__classpilotAuthGateBootstrap?.active) {
    return;
  }
  if (authGateBlockerInstalled) return;
  const focusInsideGate = (preferLast = false) => {
    const currentGate = authGateTrustedRoot?.isConnected ? authGateTrustedRoot : null;
    if (!currentGate) return;
    if (authGateSecureFrame?.isConnected) {
      authGateSecureFrame.focus({ preventScroll: true });
      return;
    }
    const focusable = getAuthGateFocusableElements(currentGate);
    const panel = currentGate.querySelector('.classpilot-auth-panel');
    const target = preferLast ? focusable[focusable.length - 1] : focusable[0];
    (target || panel)?.focus({ preventScroll: true });
  };
  const blockBehindGate = (event) => {
    const gate = authGateTrustedRoot?.isConnected ? authGateTrustedRoot : null;
    const loadingPhase = authGateTrustedPhase === 'loading';
    if (gate && event.target === gate && !loadingPhase) {
      event.stopImmediatePropagation();
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    if (event.type === 'keydown' && event.key === 'Tab') {
      focusInsideGate(event.shiftKey);
    }
  };
  const containAuthGateFocus = (event) => {
    const gate = authGateTrustedRoot?.isConnected ? authGateTrustedRoot : null;
    if (gate && event.target === gate) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    focusInsideGate(false);
  };
  for (const eventName of AUTH_GATE_BLOCKED_INPUT_EVENTS) {
    const options = eventName === 'wheel' || eventName.startsWith('touch')
      ? { capture: true, passive: false }
      : true;
    window.addEventListener(eventName, blockBehindGate, options);
    document.addEventListener(eventName, blockBehindGate, options);
  }
  window.addEventListener('focusin', containAuthGateFocus, true);
  document.addEventListener('focusin', containAuthGateFocus, true);
  window.__classpilotAuthGateBlocker = blockBehindGate;
  window.__classpilotAuthGateFocusContainment = containAuthGateFocus;
  window.__classpilotAuthGateBlockedEvents = AUTH_GATE_BLOCKED_INPUT_EVENTS;
  authGateBlockerInstalled = true;
}

function removeAuthGateBlockers() {
  if (!authGateBlockerInstalled || !window.__classpilotAuthGateBlocker) return;
  const blockBehindGate = window.__classpilotAuthGateBlocker;
  for (const eventName of window.__classpilotAuthGateBlockedEvents || []) {
    window.removeEventListener(eventName, blockBehindGate, true);
    document.removeEventListener(eventName, blockBehindGate, true);
  }
  if (window.__classpilotAuthGateFocusContainment) {
    window.removeEventListener('focusin', window.__classpilotAuthGateFocusContainment, true);
    document.removeEventListener('focusin', window.__classpilotAuthGateFocusContainment, true);
  }
  delete window.__classpilotAuthGateBlocker;
  delete window.__classpilotAuthGateFocusContainment;
  delete window.__classpilotAuthGateBlockedEvents;
  authGateBlockerInstalled = false;
}

function getAuthGateFocusableElements(gate) {
  if (!gate) return [];
  return Array.from(gate.querySelectorAll(
    'button:not([disabled]), input:not([disabled]), select:not([disabled]), [href], [tabindex]:not([tabindex="-1"])'
  )).filter((element) => element.getClientRects().length > 0 && element.getAttribute('aria-hidden') !== 'true');
}

function installAuthGateFocusManagement(gate) {
  const panel = gate?.querySelector('.classpilot-auth-panel');
  if (!gate || !panel) return;

  if (gate.dataset.classpilotFocusManagerInstalled !== 'true') {
    gate.dataset.classpilotFocusManagerInstalled = 'true';
    gate.addEventListener('keydown', (event) => {
      if (event.key !== 'Tab') return;
      const currentPanel = gate.querySelector('.classpilot-auth-panel');
      const focusable = getAuthGateFocusableElements(gate);
      if (!focusable.length) {
        event.preventDefault();
        currentPanel?.focus({ preventScroll: true });
        return;
      }

      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      const active = document.activeElement;
      if (event.shiftKey && (active === first || !gate.contains(active))) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    });
  }

  requestAnimationFrame(() => {
    if (!gate.isConnected) return;
    if (gate.contains(document.activeElement) && document.activeElement !== panel) return;
    const initialControl = gate.querySelector('#classpilot-auth-email:not([disabled])') ||
      gate.querySelector('#classpilot-auth-grade:not([disabled])');
    (initialControl || panel).focus({ preventScroll: true });
  });
}

function showAuthGate(state = {}) {
  if (!/^https?:$/.test(window.location.protocol)) {
    return;
  }

  // Never paint the gate over the PassPilot kiosk pages — a locked student
  // Chromebook can be used as a hall-pass kiosk (the kiosk has its own PIN
  // gate). Everything else stays locked; leaving the kiosk re-gates the tab.
  // The skip stays ORIGIN-VERIFIED (a lookalike origin serving a kiosk path
  // must remain gated — path-only skipping would be an auth-gate bypass), but
  // falls back to the sticky knownKioskOrigin (2.6.8): the managed-policy
  // fence calls showAuthGate with loading states that carry NO kioskOrigin,
  // which previously painted "Connecting to ClassPilot" over live kiosks on
  // every policy change.
  const kioskOriginForGateSkip =
    (typeof state.kioskOrigin === 'string' && state.kioskOrigin)
      ? state.kioskOrigin
      : knownKioskOrigin;
  if (kioskOriginForGateSkip &&
      window.location.origin === kioskOriginForGateSkip &&
      (window.location.pathname === '/passpilot/kiosk' ||
        window.location.pathname.startsWith('/passpilot/kiosk/'))) {
    removeAuthGate();
    return;
  }

  clearAuthGateRetryTimer();
  const preserveRosterSnapshot = authGatePhase(authGateCurrentState || {}) === 'ready' &&
    authGatePhase(state) === 'ready' &&
    (authGateCurrentState?.loginMethod === 'email_id' ? 'email_id' : 'name_pin') ===
      (state.loginMethod === 'email_id' ? 'email_id' : 'name_pin') &&
    authGateRosterContextGeneration(authGateCurrentState || {}) ===
      authGateRosterContextGeneration(state);
  authGateActive = true;
  authGateCurrentState = state;
  if (!preserveRosterSnapshot) {
    authGateLiveRosterLoaded = false;
    authGateRosterSnapshot = null;
    clearAuthGateRosterRefreshTimer();
  }
  document.documentElement.classList.add('classpilot-auth-locked');
  document.body?.classList.add('classpilot-auth-locked');
  const fab = document.getElementById('classpilot-fab-container');
  if (fab) fab.style.display = 'none';

  const bootstrapGate = globalThis.__classpilotAuthGateBootstrap?.gateRoot;
  const existing = authGateTrustedRoot?.isConnected
    ? authGateTrustedRoot
    : bootstrapGate?.isConnected
      ? bootstrapGate
      : null;
  if (!preserveRosterSnapshot) authGateRosterRequestGeneration += 1;

  const gate = existing || document.createElement('div');
  if (!existing) {
    gate.id = 'classpilot-auth-gate';
    document.documentElement.appendChild(gate);
  } else if (gate.parentElement !== document.documentElement) {
    document.documentElement.appendChild(gate);
  }
  const requestedPhase = authGatePhase(state);
  gate.dataset.classpilotAuthOwner = 'content';
  authGateTrustedRoot = gate;
  restoreAuthGateQuarantinedElement(gate);
  authGateTrustedRoot.setAttribute('tabindex', '-1');
  authGateTrustedPhase = authGateSecureFrameTrusted ? requestedPhase : 'loading';
  gate.dataset.classpilotAuthPhase = authGateTrustedPhase;
  globalThis.__classpilotAuthGateBootstrap?.adoptSecureGate?.(gate, {
    ...state,
    phase: authGateTrustedPhase,
  });
  installAuthGateEventContainment(gate);
  installAuthGateBlockers();
  ensureSecureAuthGateFrame(gate);
  installAuthGateConnectionWatchdog();
  reconcileAuthGatePresenceSignal();
}

function quarantineAuthGatePageChildren() {
  const documentRoot = document.documentElement;
  const body = document.body;
  if (!documentRoot) return;

  const quarantineElement = (element) => {
    if (!(element instanceof Element) || element === authGateTrustedRoot) return;
    if (!authGateQuarantinedElements.has(element)) {
      authGateQuarantinedElements.set(element, {
        hadInertAttribute: element.hasAttribute('inert'),
        inertAttributeValue: element.getAttribute('inert'),
        pointerEventsValue: element.style?.getPropertyValue('pointer-events') || '',
        pointerEventsPriority: element.style?.getPropertyPriority('pointer-events') || '',
        displayValue: element.style?.getPropertyValue('display') || '',
        displayPriority: element.style?.getPropertyPriority('display') || '',
      });
    }
    if (!element.hasAttribute('inert')) element.setAttribute('inert', '');
    // SVG/MathML do not consistently implement HTMLElement.inert. Disable
    // their full hit-test subtree too, including foreignObject iframes.
    if (element.style?.getPropertyValue('pointer-events') !== 'none' ||
        element.style?.getPropertyPriority('pointer-events') !== 'important') {
      element.style?.setProperty('pointer-events', 'none', 'important');
    }
    // Inert and pointer hit-testing do not stop a child browsing context from
    // stealing keyboard focus programmatically. Keep every page-owned surface
    // capable of rendering descendants out of layout until authentication;
    // leave <head> metadata active so styles/configuration continue loading.
    const isHeadMetadata = element.parentElement === document.head &&
      ['BASE', 'LINK', 'META', 'NOSCRIPT', 'SCRIPT', 'STYLE', 'TEMPLATE', 'TITLE']
        .includes(element.tagName);
    if (element !== document.head && !isHeadMetadata &&
        (element.style?.getPropertyValue('display') !== 'none' ||
         element.style?.getPropertyPriority('display') !== 'important')) {
      element.style?.setProperty('display', 'none', 'important');
    }
  };

  for (const element of Array.from(documentRoot.children)) {
    if (element === authGateTrustedRoot) continue;
    quarantineElement(element);
  }
  for (const element of Array.from(body?.children || [])) {
    if (element === authGateTrustedRoot) continue;
    quarantineElement(element);
  }
  for (const element of Array.from(document.head?.querySelectorAll('*') || [])) {
    quarantineElement(element);
  }
  detachAuthGatePageBrowsingContexts();

  // A same-max-z sibling inserted later would otherwise paint above the gate.
  // Re-appending the authentic host is safe and settles after one observer
  // callback because it is already last on the next reconciliation.
  if (authGateTrustedRoot?.isConnected &&
      authGateTrustedRoot.parentElement === documentRoot &&
      documentRoot.lastElementChild !== authGateTrustedRoot) {
    documentRoot.appendChild(authGateTrustedRoot);
  }

  // Top-layer UI paints above every z-index. Remove page-owned dialogs and
  // popovers from the top layer while sign-in is locked; their containing
  // body subtree remains inert and can be rendered normally after release.
  for (const dialog of document.querySelectorAll('dialog[open]')) {
    if (dialog !== authGateTrustedRoot) {
      try { dialog.close(); } catch (_error) { /* already closing */ }
    }
  }
  for (const popover of document.querySelectorAll('[popover]')) {
    try {
      if (popover.matches(':popover-open')) popover.hidePopover();
    } catch (_error) {
      // Older Chromium builds may not expose the popover pseudo-class.
    }
  }
  if (document.fullscreenElement && !authGateFullscreenExitPending) {
    authGateFullscreenExitPending = true;
    Promise.resolve(document.exitFullscreen?.())
      .catch(() => {})
      .finally(() => {
        authGateFullscreenExitPending = false;
      });
  }
  if (authGateTrustedRoot?.isConnected &&
      document.activeElement !== authGateTrustedRoot &&
      !authGateTrustedRoot.contains(document.activeElement)) {
    if (authGateSecureFrameTrusted && authGateSecureFrame?.isConnected) {
      authGateSecureFrame.focus({ preventScroll: true });
    } else {
      authGateTrustedRoot.focus({ preventScroll: true });
    }
  }
}

function detachAuthGatePageBrowsingContexts() {
  for (const contextElement of document.querySelectorAll('iframe, frame, object, embed')) {
    if (!authGateDetachedBrowsingContexts.has(contextElement)) {
      authGateDetachedBrowsingContexts.set(contextElement, {
        parent: contextElement.parentNode,
        nextSibling: contextElement.nextSibling,
      });
    }
    contextElement.remove();
  }
}

function restoreAuthGateDetachedBrowsingContexts() {
  for (const [contextElement, placement] of authGateDetachedBrowsingContexts) {
    if (contextElement.isConnected || !placement.parent) continue;
    const anchor = placement.nextSibling?.parentNode === placement.parent
      ? placement.nextSibling
      : null;
    try {
      placement.parent.insertBefore(contextElement, anchor);
    } catch (_error) {
      // Preserve the retired subtree rather than guessing a new page location.
    }
  }
  authGateDetachedBrowsingContexts.clear();
}

function restoreAuthGateQuarantinedElement(element) {
  const original = authGateQuarantinedElements.get(element);
  if (!original) return;
  if (original.hadInertAttribute) {
    element.setAttribute('inert', original.inertAttributeValue ?? '');
  } else {
    element.removeAttribute('inert');
  }
  if (element.style) {
    if (original.pointerEventsValue) {
      element.style.setProperty(
        'pointer-events',
        original.pointerEventsValue,
        original.pointerEventsPriority
      );
    } else {
      element.style.removeProperty('pointer-events');
    }
    if (original.displayValue) {
      element.style.setProperty(
        'display',
        original.displayValue,
        original.displayPriority
      );
    } else {
      element.style.removeProperty('display');
    }
  }
  authGateQuarantinedElements.delete(element);
}

function isTrustedAuthGateHostMounted() {
  const gate = authGateTrustedRoot;
  return Boolean(
    gate?.isConnected &&
    gate.parentElement === document.documentElement
  );
}

function scheduleAuthGateWatchdogReconcile() {
  if (!authGateActive || authGateWatchdogScheduled) return;
  authGateWatchdogScheduled = true;
  queueMicrotask(() => {
    authGateWatchdogScheduled = false;
    reconcileAuthGateConnection();
  });
}

function reconcileAuthGateConnection() {
  if (!authGateActive || authGateWatchdogRecovering) return;
  quarantineAuthGatePageChildren();
  if (isTrustedAuthGateHostMounted()) return;

  const now = performance.now();
  if (now - authGateWatchdogWindowStartedAt > 250) {
    authGateWatchdogWindowStartedAt = now;
    authGateWatchdogRecoveryCount = 0;
  }
  if (authGateWatchdogRecoveryCount >= 4) {
    if (authGateWatchdogDeferredTimer === null) {
      authGateWatchdogDeferredTimer = setTimeout(() => {
        authGateWatchdogDeferredTimer = null;
        reconcileAuthGateConnection();
      }, 50);
    }
    return;
  }
  authGateWatchdogRecoveryCount += 1;
  recoverTrustedAuthGateHost();
}

function recoverTrustedAuthGateHost() {
  if (!authGateActive || authGateWatchdogRecovering) return;
  authGateWatchdogRecovering = true;
  try {
    clearSecureAuthGateFrameRecovery();
    authGateTrustedRoot?.remove();
    authGateTrustedRoot = null;
    authGateTrustedPhase = 'loading';
    authGateSecureShadow = null;
    authGateSecureFrame = null;
    authGateSecureFallback = null;
    authGateSecureFrameNonce = '';
    authGateSecureFrameReady = false;
    authGateSecureFrameTrusted = false;
    authGateSecureFramePendingPhase = 'loading';

    const recoveryState = {
      ...(authGateCurrentState || {}),
      phase: 'loading',
      authRequired: true,
    };
    showAuthGate(recoveryState);
    if (authGateTrustedRoot) {
      authGateWatchdogRecoverySerial += 1;
      authGateTrustedRoot.dataset.classpilotAuthRecovery = 'restored';
      authGateTrustedRoot.dataset.classpilotAuthRecoverySerial = String(authGateWatchdogRecoverySerial);
    }
    quarantineAuthGatePageChildren();
  } finally {
    authGateWatchdogRecovering = false;
  }
}

function installAuthGateConnectionWatchdog() {
  quarantineAuthGatePageChildren();
  if (authGateConnectionObserver) return;
  authGateConnectionObserver = new MutationObserver(() => {
    scheduleAuthGateWatchdogReconcile();
  });
  // Observe Document rather than the current <html> node. A hostile page can
  // replace documentElement wholesale; observing the old subtree would leave
  // the replacement and any child frame outside the recovery watchdog.
  authGateConnectionObserver.observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['inert', 'open', 'style'],
  });
  document.addEventListener('fullscreenchange', scheduleAuthGateWatchdogReconcile, true);
  document.addEventListener('toggle', scheduleAuthGateWatchdogReconcile, true);
  document.addEventListener('beforetoggle', preventPagePopoverWhileAuthLocked, true);
}

function preventPagePopoverWhileAuthLocked(event) {
  if (!authGateActive || event.target === authGateTrustedRoot) return;
  if (event.newState === 'open' && event.cancelable) event.preventDefault();
  scheduleAuthGateWatchdogReconcile();
}

function stopAuthGateConnectionWatchdog() {
  authGateConnectionObserver?.disconnect();
  authGateConnectionObserver = null;
  document.removeEventListener('fullscreenchange', scheduleAuthGateWatchdogReconcile, true);
  document.removeEventListener('toggle', scheduleAuthGateWatchdogReconcile, true);
  document.removeEventListener('beforetoggle', preventPagePopoverWhileAuthLocked, true);
  authGateWatchdogScheduled = false;
  authGateWatchdogRecovering = false;
  if (authGateWatchdogDeferredTimer !== null) {
    clearTimeout(authGateWatchdogDeferredTimer);
    authGateWatchdogDeferredTimer = null;
  }
  authGateWatchdogWindowStartedAt = 0;
  authGateWatchdogRecoveryCount = 0;
  authGateFullscreenExitPending = false;
  restoreAuthGateDetachedBrowsingContexts();
  for (const element of Array.from(authGateQuarantinedElements.keys())) {
    restoreAuthGateQuarantinedElement(element);
  }
}

function ensureSecureAuthGateFrame(gate) {
  if (!gate) return;
  if (authGateSecureShadow?.host !== gate) {
    authGateSecureShadow = null;
    authGateSecureFrame = null;
    authGateSecureFallback = null;
    authGateSecureFrameNonce = '';
    authGateSecureFrameReady = false;
    authGateSecureFrameTrusted = false;
    authGateSecureFramePendingPhase = 'loading';
  }
  if (authGateSecureFrame?.isConnected) return;

  // The bootstrap gate starts in light DOM so it can paint at document_start.
  // Replace it synchronously with a closed shadow tree before mounting the
  // extension-origin frame. Host-page JavaScript cannot traverse the shadow
  // tree or inspect the credential controls inside the cross-origin frame.
  gate.replaceChildren();
  try {
    authGateSecureShadow = gate.attachShadow({ mode: 'closed' });
  } catch (_error) {
    // A hostile page can race document_idle and attach its own shadow root to
    // the bootstrap host. Never render into or authorize that unverifiable
    // host: replace it with a fresh extension-owned node and keep the closure
    // phase at loading until the nonce-authenticated frame responds.
    const replacement = document.createElement('div');
    replacement.id = 'classpilot-auth-gate';
    replacement.dataset.classpilotAuthOwner = 'content';
    replacement.dataset.classpilotAuthPhase = 'loading';
    replacement.dataset.classpilotAuthFrameStatus = 'verifying';
    if (gate.isConnected) gate.replaceWith(replacement);
    else document.documentElement.appendChild(replacement);
    authGateTrustedRoot = replacement;
    authGateTrustedPhase = 'loading';
    authGateSecureShadow = null;
    authGateSecureFrame = null;
    globalThis.__classpilotAuthGateBootstrap?.adoptSecureGate?.(replacement, {
      ...(authGateCurrentState || {}),
      phase: 'loading',
      authRequired: true,
    });
    installAuthGateEventContainment(replacement);
    ensureSecureAuthGateFrame(replacement);
    return;
  }

  const style = document.createElement('style');
  style.textContent = `
    :host {
      position: fixed !important;
      inset: 0 !important;
      z-index: 2147483647 !important;
      display: block !important;
      width: 100vw !important;
      height: 100vh !important;
      height: 100dvh !important;
      overflow: hidden !important;
      background: linear-gradient(180deg, rgba(14, 42, 87, .94), rgba(25, 55, 100, .88)) !important;
      color-scheme: light !important;
      contain: strict !important;
      isolation: isolate !important;
    }
    .classpilot-auth-frame-fallback {
      position: absolute;
      inset: 0;
      display: grid;
      place-items: center;
      padding: 24px;
      color: #fff;
      font: 700 20px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      text-align: center;
    }
    .classpilot-auth-frame-fallback span {
      display: block;
      margin-top: 8px;
      color: #dbe6f7;
      font-size: 15px;
      font-weight: 500;
    }
    iframe {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      border: 0;
      background: transparent;
      opacity: 0;
      pointer-events: none;
    }
    iframe.classpilot-auth-frame-loaded {
      opacity: 1;
      pointer-events: auto;
    }
  `;

  const fallback = document.createElement('div');
  fallback.className = 'classpilot-auth-frame-fallback';
  fallback.setAttribute('role', 'status');
  fallback.setAttribute('aria-live', 'polite');
  fallback.innerHTML = 'Connecting to ClassPilot…<span>Browsing will stay locked until ClassPilot is ready.</span>';

  const frame = document.createElement('iframe');
  frame.title = 'ClassPilot student sign-in';
  frame.referrerPolicy = 'origin';
  authGateSecureFrameNonce = createAuthGateFrameNonce();
  frame.src = secureAuthGateFrameUrl(authGateSecureFrameNonce);
  frame.addEventListener('load', () => {
    if (!frame.isConnected) return;
    beginSecureAuthGateFrameVerification();
  });

  authGateSecureShadow.append(style, fallback, frame);
  authGateSecureFrame = frame;
  authGateSecureFallback = fallback;
  gate.dataset.classpilotAuthFrameStatus = 'verifying';
}

function createAuthGateFrameNonce() {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function secureAuthGateFrameUrl(nonce) {
  return `${chrome.runtime.getURL('auth-gate-frame.html')}#${encodeURIComponent(nonce)}`;
}

function clearSecureAuthGateFrameRecovery() {
  if (authGateSecureFrameRecoveryTimer !== null) {
    clearTimeout(authGateSecureFrameRecoveryTimer);
    authGateSecureFrameRecoveryTimer = null;
  }
}

function markSecureAuthGateFrameUntrusted() {
  authGateSecureFrameReady = false;
  authGateSecureFrameTrusted = false;
  authGateSecureFramePendingPhase = 'loading';
  authGateTrustedPhase = 'loading';
  authGateSecureFrame?.classList.remove('classpilot-auth-frame-loaded');
  if (authGateSecureFallback) authGateSecureFallback.hidden = false;
  if (authGateTrustedRoot) {
    authGateTrustedRoot.dataset.classpilotAuthFrameStatus = 'verifying';
    authGateTrustedRoot.dataset.classpilotAuthPhase = 'loading';
    globalThis.__classpilotAuthGateBootstrap?.adoptSecureGate?.(authGateTrustedRoot, {
      ...(authGateCurrentState || {}),
      phase: 'loading',
      authRequired: true,
    });
    globalThis.__classpilotAuthGateBootstrap?.setSecureFrameFocusTarget?.(null);
  }
  reconcileAuthGatePresenceSignal();
}

function beginSecureAuthGateFrameVerification() {
  if (!authGateSecureFrame?.contentWindow || !authGateSecureFrameNonce) return;
  markSecureAuthGateFrameUntrusted();
  try {
    authGateSecureFrame.contentWindow.postMessage({
      type: 'CLASSPILOT_AUTH_FRAME_INIT',
      nonce: authGateSecureFrameNonce,
    }, AUTH_GATE_FRAME_ORIGIN);
  } catch (_error) {
    // The recovery timer below restores the genuine extension document.
  }
  clearSecureAuthGateFrameRecovery();
  authGateSecureFrameRecoveryTimer = setTimeout(() => {
    authGateSecureFrameRecoveryTimer = null;
    if (!authGateSecureFrameTrusted) resetSecureAuthGateFrame();
  }, 300);
}

function resetSecureAuthGateFrame() {
  if (!authGateSecureFrame?.isConnected) return;
  markSecureAuthGateFrameUntrusted();
  authGateSecureFrameNonce = createAuthGateFrameNonce();
  authGateSecureFrame.src = secureAuthGateFrameUrl(authGateSecureFrameNonce);
}

function applyTrustedAuthGateFramePhase(phase) {
  if (!AUTH_GATE_PHASES.has(phase) || !authGateTrustedRoot?.isConnected) return;
  if (isAuthGateManagedPolicyFencePending()) {
    markSecureAuthGateFrameUntrusted();
    return;
  }
  authGateSecureFramePendingPhase = phase;
  if (!authGateSecureFrameReady) return;
  if (phase === 'authenticated') {
    // The message is accepted only from the nonce-bound extension document,
    // whose phase came from a direct worker response. This closes the gate if
    // a tabs.sendMessage completion broadcast misses the extension subframe.
    recordAuthGateOutcome({
      ...(authGateCurrentState || {}),
      phase: 'authenticated',
      authRequired: false,
    });
    removeAuthGate();
    return;
  }
  authGateSecureFrameTrusted = true;
  authGateTrustedPhase = phase;
  authGateTrustedRoot.dataset.classpilotAuthFrameStatus = 'trusted';
  authGateTrustedRoot.dataset.classpilotAuthPhase = phase;
  authGateSecureFrame?.classList.add('classpilot-auth-frame-loaded');
  if (authGateSecureFallback) authGateSecureFallback.hidden = true;
  clearSecureAuthGateFrameRecovery();
  globalThis.__classpilotAuthGateBootstrap?.adoptSecureGate?.(authGateTrustedRoot, {
    ...(authGateCurrentState || {}),
    phase,
    authRequired: phase !== 'authenticated',
  });
  globalThis.__classpilotAuthGateBootstrap?.setSecureFrameFocusTarget?.(authGateSecureFrame);
  authGateSecureFrame?.focus({ preventScroll: true });
  reconcileAuthGatePresenceSignal();
}

window.addEventListener('message', (event) => {
  if (!event.isTrusted || event.source !== authGateSecureFrame?.contentWindow ||
      event.origin !== AUTH_GATE_FRAME_ORIGIN ||
      event.data?.nonce !== authGateSecureFrameNonce) {
    return;
  }
  if (event.data.type === 'CLASSPILOT_AUTH_FRAME_PHASE' &&
      AUTH_GATE_PHASES.has(event.data.phase)) {
    applyTrustedAuthGateFramePhase(event.data.phase);
    return;
  }
  if (event.data.type === 'CLASSPILOT_AUTH_FRAME_READY') {
    authGateSecureFrameReady = true;
    applyTrustedAuthGateFramePhase(authGateSecureFramePendingPhase);
    return;
  }
  if (event.data.type === 'CLASSPILOT_AUTH_FRAME_LEAVING') {
    markSecureAuthGateFrameUntrusted();
    clearSecureAuthGateFrameRecovery();
    authGateSecureFrameRecoveryTimer = setTimeout(resetSecureAuthGateFrame, 100);
  }
}, true);

function removeAuthGate() {
  stopAuthGatePresenceSignal();
  clearAuthGateRetryTimer();
  clearAuthGateRosterRefreshTimer();
  authGatePendingManagedPolicyFence = 0;
  if (authGateManagedPolicyFenceRetryTimer !== null) {
    clearTimeout(authGateManagedPolicyFenceRetryTimer);
    authGateManagedPolicyFenceRetryTimer = null;
  }
  authGateActive = false;
  stopAuthGateConnectionWatchdog();
  authGateCurrentState = null;
  authGateLiveRosterLoaded = false;
  authGateRosterSnapshot = null;
  authGateSecureShadow = null;
  authGateSecureFrame = null;
  authGateSecureFallback = null;
  authGateSecureFrameNonce = '';
  authGateSecureFrameReady = false;
  authGateSecureFrameTrusted = false;
  authGateSecureFramePendingPhase = 'loading';
  clearSecureAuthGateFrameRecovery();
  authGateStateRequestGeneration += 1;
  authGateRosterRequestGeneration += 1;
  const gate = authGateTrustedRoot;
  if (typeof globalThis.__classpilotAuthGateBootstrap?.release === 'function') {
    // Unwind the content-owned quarantine first, then authorize bootstrap to
    // restore its document_start snapshot. Its independent policy fence may
    // have resolved earlier, but it deliberately stays locked after adoption
    // so neither layer can preserve the other's temporary inert/display state.
    globalThis.__classpilotAuthGateBootstrap.release({ fromContent: true });
  }
  if (gate) gate.remove();
  authGateTrustedRoot = null;
  authGateTrustedPhase = 'loading';
  document.documentElement.classList.remove('classpilot-auth-locked');
  document.body?.classList.remove('classpilot-auth-locked');
  const fab = document.getElementById('classpilot-fab-container');
  if (fab) fab.style.display = '';
  removeAuthGateBlockers();
}

function buildAuthGateMarkup(state) {
  const phase = authGatePhase(state);
  const loginMethod = state.loginMethod === 'email_id' ? 'email_id' : 'name_pin';
  const title = phase === 'loading'
    ? 'Connecting to ClassPilot…'
    : phase === 'unavailable'
      ? 'ClassPilot can’t connect right now'
      : phase === 'setup_required'
        ? 'Ask your teacher to set up this Chromebook'
        : 'Sign in to this Chromebook';
  const subtitle = phase === 'loading'
    ? 'Checking your school’s sign-in settings. Browsing will stay locked until ClassPilot is ready.'
    : phase === 'unavailable'
      ? 'Browsing stays locked until ClassPilot reconnects. Check the connection, then try again.'
      : phase === 'setup_required'
        ? 'This Chromebook needs the school setup key and Shared Chromebook Sign-In enabled before browsing can start.'
        : loginMethod === 'name_pin'
          ? 'Choose your grade and name, then enter your 4-digit PIN.'
          : 'Enter your school email and student ID to continue.';
  const phaseMarkup = phase === 'loading'
    ? buildAuthGateLoadingMarkup(loginMethod)
    : phase === 'unavailable'
      ? buildAuthGateUnavailableMarkup(state)
      : phase === 'setup_required'
        ? buildSetupRequiredMarkup()
        : loginMethod === 'name_pin'
          ? buildPinLoginMarkup()
          : buildEmailLoginMarkup();

  return `
    <style>
      html.classpilot-auth-locked,
      body.classpilot-auth-locked {
        overflow: hidden !important;
      }
      #classpilot-auth-gate {
        position: fixed !important;
        inset: 0 !important;
        z-index: 2147483647 !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        width: 100vw !important;
        height: 100vh !important;
        height: 100dvh !important;
        min-height: 0 !important;
        padding: 24px !important;
        overflow: auto !important;
        overscroll-behavior: contain !important;
        background: linear-gradient(180deg, rgba(14, 42, 87, 0.90), rgba(25, 55, 100, 0.82)) !important;
        backdrop-filter: blur(12px) !important;
        font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif !important;
        color: #0e2a57 !important;
        box-sizing: border-box !important;
      }
      #classpilot-auth-gate * {
        box-sizing: border-box !important;
      }
      .classpilot-auth-panel {
        position: relative !important;
        width: min(1040px, 100%) !important;
        height: min(680px, calc(100vh - 48px)) !important;
        height: min(680px, calc(100dvh - 48px)) !important;
        min-height: 0 !important;
        max-height: 100% !important;
        background: #ffffff !important;
        border-radius: 28px !important;
        box-shadow: 0 25px 70px rgba(15, 23, 42, 0.35) !important;
        border: 1px solid rgba(216, 222, 232, 0.8) !important;
        display: grid !important;
        grid-template-columns: 250px minmax(0, 1fr) !important;
        overflow: hidden !important;
        outline: none !important;
      }
      .classpilot-auth-side {
        min-width: 0 !important;
        min-height: 100% !important;
        padding: 28px !important;
        background: linear-gradient(180deg, #0b2854 0%, #0e2a57 100%) !important;
        color: #ffffff !important;
        display: flex !important;
        flex-direction: column !important;
        justify-content: space-between !important;
      }
      .classpilot-auth-panel--has-kiosk .classpilot-auth-side {
        padding-bottom: 94px !important;
      }
      .classpilot-auth-small-logo {
        flex: 0 0 auto !important;
        width: 44px !important;
        height: 44px !important;
        border-radius: 12px !important;
        background: #f5b81f !important;
        color: #0e2a57 !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        font-weight: 900 !important;
        letter-spacing: 0 !important;
      }
      .classpilot-auth-small-logo svg,
      .classpilot-auth-safe-note svg,
      .classpilot-auth-field-icon svg,
      .classpilot-auth-footnote svg {
        width: 1em !important;
        height: 1em !important;
        display: block !important;
        stroke: currentColor !important;
      }
      .classpilot-auth-promise {
        margin-top: 72px !important;
      }
      .classpilot-auth-side h2 {
        margin: 0 !important;
        max-width: 220px !important;
        font-size: 36px !important;
        line-height: 1.08 !important;
        font-weight: 800 !important;
        color: #ffffff !important;
        letter-spacing: 0 !important;
      }
      .classpilot-auth-side p {
        margin: 18px 0 0 !important;
        max-width: 205px !important;
        font-size: 15px !important;
        line-height: 1.55 !important;
        color: #dbe7f7 !important;
      }
      .classpilot-auth-safe-note {
        display: flex !important;
        align-items: center !important;
        gap: 10px !important;
        color: #e8eef7 !important;
        font-size: 14px !important;
      }
      .classpilot-auth-main {
        min-width: 0 !important;
        min-height: 0 !important;
        padding: 40px !important;
        display: flex !important;
        align-items: center !important;
        background: #ffffff !important;
        overflow-y: auto !important;
        scrollbar-gutter: stable !important;
      }
      .classpilot-auth-content {
        width: 100% !important;
        max-width: 520px !important;
        margin: 0 auto !important;
      }
      .classpilot-auth-product {
        display: flex !important;
        align-items: center !important;
        gap: 12px !important;
        margin-bottom: 22px !important;
        color: #0e2a57 !important;
        font-size: 20px !important;
        font-weight: 800 !important;
      }
      .classpilot-auth-small-logo {
        background: #0e2a57 !important;
        color: #f5b81f !important;
      }
      .classpilot-auth-main h1 {
        margin: 0 !important;
        font-size: 40px !important;
        line-height: 1.05 !important;
        font-weight: 800 !important;
        color: #0e2a57 !important;
        letter-spacing: 0 !important;
      }
      .classpilot-auth-main p {
        margin: 10px 0 22px !important;
        max-width: 520px !important;
        font-size: 17px !important;
        line-height: 1.55 !important;
        color: #6b7a90 !important;
      }
      .classpilot-auth-divider {
        height: 1px !important;
        width: 100% !important;
        background: #e2e8f0 !important;
        margin: 0 0 22px !important;
      }
      .classpilot-auth-form {
        display: grid !important;
        gap: 18px !important;
      }
      .classpilot-auth-field {
        display: grid !important;
        gap: 8px !important;
      }
      .classpilot-auth-field label {
        display: flex !important;
        align-items: center !important;
        gap: 12px !important;
        font-size: 15px !important;
        font-weight: 700 !important;
        color: #0f172a !important;
      }
      .classpilot-auth-field-icon {
        width: 36px !important;
        height: 36px !important;
        border-radius: 999px !important;
        background: #fdf2c8 !important;
        color: #0e2a57 !important;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
        font-weight: 800 !important;
      }
      .classpilot-auth-field input,
      .classpilot-auth-field select {
        width: 100% !important;
        min-height: 52px !important;
        border: 1px solid #d8dee8 !important;
        border-radius: 12px !important;
        padding: 12px 18px !important;
        font-size: 15px !important;
        color: #223a5e !important;
        background: #ffffff !important;
        outline: none !important;
      }
      .classpilot-auth-field input:focus,
      .classpilot-auth-field select:focus {
        border-color: #0e2a57 !important;
        box-shadow: 0 0 0 3px rgba(245, 184, 31, 0.28) !important;
      }
      .classpilot-auth-button {
        min-height: 52px !important;
        border: 0 !important;
        border-radius: 12px !important;
        background: #f5b81f !important;
        color: #0e2a57 !important;
        font-weight: 800 !important;
        font-size: 20px !important;
        cursor: pointer !important;
        margin-top: 4px !important;
      }
      .classpilot-auth-button:disabled {
        opacity: 0.65 !important;
        cursor: not-allowed !important;
      }
      .classpilot-auth-button:focus-visible,
      .classpilot-auth-kiosk-button:focus-visible,
      .classpilot-auth-refresh-names:focus-visible,
      .classpilot-auth-retry:focus-visible {
        outline: 3px solid #0e2a57 !important;
        outline-offset: 3px !important;
        box-shadow: 0 0 0 6px rgba(245, 184, 31, 0.34) !important;
      }
      .classpilot-auth-kiosk-button {
        position: absolute !important;
        z-index: 3 !important;
        bottom: 28px !important;
        left: 28px !important;
        min-width: 120px !important;
        min-height: 44px !important;
        padding: 0 16px !important;
        border: 1px solid #d8dee8 !important;
        border-radius: 10px !important;
        background: rgba(255, 255, 255, 0.08) !important;
        color: #e6edf7 !important;
        font-weight: 750 !important;
        font-size: 13px !important;
        cursor: pointer !important;
      }
      .classpilot-auth-kiosk-button:hover:not(:disabled) {
        border-color: rgba(255, 255, 255, 0.72) !important;
        background: rgba(255, 255, 255, 0.16) !important;
      }
      .classpilot-auth-error {
        display: none;
        padding: 12px 14px !important;
        border-radius: 12px !important;
        background: #fef2f2 !important;
        color: #991b1b !important;
        font-size: 13px !important;
        line-height: 1.4 !important;
        margin-bottom: 18px !important;
      }
      .classpilot-auth-roster-note {
        min-height: 40px !important;
        border-radius: 12px !important;
        background: #f8fafc !important;
        color: #6b7a90 !important;
        padding: 12px 14px !important;
        font-size: 13px !important;
        line-height: 1.45 !important;
      }
      .classpilot-auth-roster-note:empty {
        display: none !important;
      }
      .classpilot-auth-roster-controls {
        grid-column: 1 / -1 !important;
        display: flex !important;
        min-width: 0 !important;
        align-items: center !important;
        justify-content: space-between !important;
        gap: 12px !important;
      }
      .classpilot-auth-roster-controls .classpilot-auth-roster-note {
        flex: 1 1 auto !important;
      }
      .classpilot-auth-roster-note--warning {
        border: 1px solid #f0cc69 !important;
        background: #fff8dc !important;
        color: #775500 !important;
        font-weight: 650 !important;
      }
      .classpilot-auth-refresh-names {
        min-height: 36px !important;
        flex: 0 0 auto !important;
        padding: 0 12px !important;
        border: 1px solid #aebdce !important;
        border-radius: 9px !important;
        background: #fff !important;
        color: #0e2a57 !important;
        cursor: pointer !important;
        font-size: 13px !important;
        font-weight: 750 !important;
      }
      .classpilot-auth-refresh-names:hover:not(:disabled) {
        border-color: #0e2a57 !important;
        background: #fff8dc !important;
      }
      .classpilot-auth-refresh-names:disabled {
        cursor: wait !important;
        opacity: .58 !important;
      }
      .classpilot-auth-state-card {
        min-height: 104px !important;
        border: 1px solid #d8dee8 !important;
        border-radius: 14px !important;
        background: #f8fafc !important;
        color: #334155 !important;
        padding: 18px !important;
        display: flex !important;
        align-items: center !important;
        gap: 14px !important;
        font-size: 14px !important;
        line-height: 1.5 !important;
      }
      .classpilot-auth-state-card strong {
        display: block !important;
        margin-bottom: 3px !important;
        color: #0f172a !important;
        font-size: 15px !important;
      }
      .classpilot-auth-state-card > span:first-child:not(.classpilot-auth-spinner) {
        flex: 0 0 auto !important;
        width: 36px !important;
        height: 36px !important;
        border-radius: 999px !important;
        background: #fdf2c8 !important;
        color: #0e2a57 !important;
        display: inline-flex !important;
        align-items: center !important;
        justify-content: center !important;
      }
      .classpilot-auth-state-card > span:first-child:not(.classpilot-auth-spinner) svg {
        width: 20px !important;
        height: 20px !important;
        stroke: currentColor !important;
      }
      .classpilot-auth-spinner {
        flex: 0 0 auto !important;
        width: 34px !important;
        height: 34px !important;
        border: 4px solid #e2e8f0 !important;
        border-top-color: #f5b81f !important;
        border-radius: 999px !important;
        animation: classpilot-auth-spin 0.9s linear infinite !important;
      }
      @keyframes classpilot-auth-spin {
        to { transform: rotate(360deg); }
      }
      .classpilot-auth-loading-form {
        margin-top: 16px !important;
        opacity: 0.62 !important;
      }
      .classpilot-auth-loading-form input:disabled,
      .classpilot-auth-loading-form select:disabled,
      .classpilot-auth-loading-form button:disabled {
        cursor: wait !important;
      }
      .classpilot-auth-retry {
        width: 100% !important;
        min-height: 52px !important;
        margin-top: 16px !important;
        border: 0 !important;
        border-radius: 12px !important;
        background: #f5b81f !important;
        color: #0e2a57 !important;
        cursor: pointer !important;
        font-size: 18px !important;
        font-weight: 800 !important;
      }
      .classpilot-auth-retry:disabled {
        cursor: wait !important;
        opacity: 0.7 !important;
      }
      .classpilot-auth-retry-status {
        min-height: 20px !important;
        margin-top: 10px !important;
        color: #6b7a90 !important;
        font-size: 13px !important;
        text-align: center !important;
      }
      @media (prefers-reduced-motion: reduce) {
        .classpilot-auth-spinner {
          animation-duration: 1.8s !important;
        }
      }
      .classpilot-auth-footnote {
        margin: 22px 0 0 !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 8px !important;
        color: #6b7a90 !important;
        font-size: 14px !important;
      }
      @media (max-width: 900px), (max-height: 820px) {
        #classpilot-auth-gate {
          padding: 12px !important;
        }
        .classpilot-auth-panel {
          width: min(1040px, 100%) !important;
          height: min(600px, calc(100vh - 24px)) !important;
          height: min(600px, calc(100dvh - 24px)) !important;
          max-height: calc(100vh - 24px) !important;
          max-height: calc(100dvh - 24px) !important;
          grid-template-rows: minmax(0, 1fr) !important;
          border-radius: 20px !important;
        }
        .classpilot-auth-side {
          padding: 22px !important;
        }
        .classpilot-auth-panel--has-kiosk .classpilot-auth-side {
          padding-bottom: 84px !important;
        }
        .classpilot-auth-promise {
          margin-top: 28px !important;
        }
        .classpilot-auth-side h2 {
          max-width: 180px !important;
          font-size: 30px !important;
        }
        .classpilot-auth-side p {
          margin-top: 14px !important;
          max-width: 175px !important;
          font-size: 14px !important;
          line-height: 1.45 !important;
        }
        .classpilot-auth-safe-note {
          gap: 8px !important;
          font-size: 12px !important;
        }
        .classpilot-auth-main {
          padding: 22px 28px !important;
          align-items: flex-start !important;
        }
        .classpilot-auth-content {
          max-width: 680px !important;
          margin: auto !important;
        }
        .classpilot-auth-product {
          gap: 10px !important;
          margin-bottom: 10px !important;
          font-size: 18px !important;
        }
        .classpilot-auth-small-logo {
          width: 34px !important;
          height: 34px !important;
          border-radius: 10px !important;
        }
        .classpilot-auth-main h1 {
          font-size: 34px !important;
        }
        .classpilot-auth-main p {
          margin: 6px 0 14px !important;
          max-width: 620px !important;
          font-size: 15px !important;
          line-height: 1.4 !important;
        }
        .classpilot-auth-divider {
          margin-bottom: 16px !important;
        }
        .classpilot-auth-form {
          gap: 12px 16px !important;
        }
        .classpilot-auth-field {
          gap: 6px !important;
        }
        .classpilot-auth-field label {
          gap: 8px !important;
          font-size: 14px !important;
        }
        .classpilot-auth-field-icon {
          width: 30px !important;
          height: 30px !important;
        }
        .classpilot-auth-field input,
        .classpilot-auth-field select {
          min-height: 48px !important;
          padding: 10px 14px !important;
        }
        #classpilot-auth-pin-form {
          grid-template-columns: minmax(0, 0.85fr) minmax(0, 1.15fr) !important;
          grid-template-areas:
            "grade student"
            "status status"
            "pin submit" !important;
        }
        #classpilot-auth-email-form {
          grid-template-columns: repeat(2, minmax(0, 1fr)) !important;
        }
        #classpilot-auth-email-form .classpilot-auth-button {
          grid-column: 1 / -1 !important;
        }
        .classpilot-auth-field--grade {
          grid-area: grade !important;
        }
        .classpilot-auth-field--student {
          grid-area: student !important;
        }
        .classpilot-auth-field--pin {
          grid-area: pin !important;
        }
        #classpilot-auth-pin-form .classpilot-auth-roster-controls {
          grid-area: status !important;
        }
        #classpilot-auth-pin-submit {
          grid-area: submit !important;
          align-self: end !important;
          margin-top: 0 !important;
        }
        .classpilot-auth-button {
          min-height: 48px !important;
          font-size: 18px !important;
        }
        .classpilot-auth-error {
          padding: 10px 12px !important;
          margin-bottom: 12px !important;
        }
        .classpilot-auth-roster-note {
          min-height: 0 !important;
          padding: 10px 12px !important;
        }
        .classpilot-auth-footnote {
          margin-top: 16px !important;
          font-size: 13px !important;
        }
      }
      @media (max-width: 900px) {
        .classpilot-auth-panel {
          width: min(720px, 100%) !important;
          grid-template-columns: minmax(0, 1fr) !important;
        }
        .classpilot-auth-side {
          display: none !important;
        }
        .classpilot-auth-panel--has-kiosk .classpilot-auth-main {
          padding-bottom: 84px !important;
        }
        .classpilot-auth-kiosk-button {
          bottom: 18px !important;
          left: 22px !important;
          border-color: #aebdce !important;
          background: #fff !important;
          color: #0e2a57 !important;
        }
        .classpilot-auth-kiosk-button:hover:not(:disabled) {
          border-color: #0e2a57 !important;
          background: #fdf2c8 !important;
        }
      }
      @media (max-height: 820px) and (min-width: 901px) {
        .classpilot-auth-panel {
          grid-template-columns: 220px minmax(0, 1fr) !important;
        }
      }
      @media (max-width: 640px) {
        #classpilot-auth-gate {
          padding: 8px !important;
        }
        .classpilot-auth-panel {
          max-height: calc(100vh - 16px) !important;
          max-height: calc(100dvh - 16px) !important;
          border-radius: 16px !important;
        }
        .classpilot-auth-main {
          padding: 20px !important;
        }
        .classpilot-auth-panel--has-kiosk .classpilot-auth-main {
          padding-bottom: 80px !important;
        }
        .classpilot-auth-kiosk-button {
          bottom: 16px !important;
          left: 20px !important;
        }
        .classpilot-auth-main h1 {
          font-size: 30px !important;
        }
        #classpilot-auth-pin-form {
          grid-template-columns: minmax(0, 1fr) !important;
          grid-template-areas:
            "grade"
            "status"
            "student"
            "pin"
            "submit" !important;
        }
        #classpilot-auth-email-form {
          grid-template-columns: minmax(0, 1fr) !important;
        }
        .classpilot-auth-roster-controls {
          align-items: stretch !important;
          flex-direction: column !important;
        }
        .classpilot-auth-refresh-names {
          width: 100% !important;
        }
        .classpilot-auth-loading-form {
          display: none !important;
        }
      }
    </style>
    <div class="classpilot-auth-panel${phase === 'ready' && state.kioskUrl ? ' classpilot-auth-panel--has-kiosk' : ''}" role="dialog" aria-modal="true" aria-labelledby="classpilot-auth-title" aria-describedby="classpilot-auth-subtitle" ${phase === 'loading' ? 'aria-busy="true"' : ''} tabindex="-1">
      <div class="classpilot-auth-side" aria-hidden="true">
        <div>
          <div class="classpilot-auth-promise">
            <h2>Safe. Focused.<br />Ready to learn.</h2>
            <p>ClassPilot helps your school keep browsing safe, on-task, and distraction-free.</p>
          </div>
        </div>
        <div class="classpilot-auth-safe-note"><span>${authIcon('shield')}</span><span>Protected student browsing</span></div>
      </div>
      <div class="classpilot-auth-main">
        <div class="classpilot-auth-content">
          <div class="classpilot-auth-product">
            <div class="classpilot-auth-small-logo">${authIcon('send')}</div>
            <span>ClassPilot</span>
          </div>
          <h1 id="classpilot-auth-title">${escapeHtml(title)}</h1>
          <p id="classpilot-auth-subtitle">${escapeHtml(subtitle)}</p>
          <div class="classpilot-auth-divider"></div>
          <div class="classpilot-auth-error" id="classpilot-auth-error" role="alert" aria-live="assertive"></div>
          ${phaseMarkup}
          <div class="classpilot-auth-footnote"><span>${authIcon('shield')}</span><span>Shared Chromebook sign-in</span></div>
        </div>
      </div>
      ${phase === 'ready' && state.kioskUrl ? buildKioskLaunchMarkup() : ''}
    </div>
  `;
}

function authIcon(name) {
  const iconAttrs = 'viewBox="0 0 24 24" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"';
  const icons = {
    send: '<path d="m22 2-7 20-4-9-9-4Z"></path><path d="M22 2 11 13"></path>',
    shield: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.68 0C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.5 3.8 17 5 19 5a1 1 0 0 1 1 1Z"></path><path d="m9 12 2 2 4-4"></path>',
    graduation: '<path d="M22 10v6"></path><path d="M2 10l10-5 10 5-10 5Z"></path><path d="M6 12v5c3 3 9 3 12 0v-5"></path>',
    user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"></path><circle cx="12" cy="7" r="4"></circle>',
    lock: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"></rect><path d="M7 11V7a5 5 0 0 1 10 0v4"></path>',
    mail: '<rect width="20" height="16" x="2" y="4" rx="2"></rect><path d="m22 7-10 6L2 7"></path>',
    badge: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10"></path><path d="m9 12 2 2 4-4"></path>',
  };
  return `<svg ${iconAttrs}>${icons[name] || icons.shield}</svg>`;
}

function buildAuthGateLoadingMarkup(loginMethod) {
  const disabledForm = loginMethod === 'email_id'
    ? buildEmailLoginMarkup({ disabled: true })
    : buildPinLoginMarkup({ disabled: true });
  return `
    <div class="classpilot-auth-state-card" role="status" aria-live="polite">
      <span class="classpilot-auth-spinner" aria-hidden="true"></span>
      <span><strong>Verifying live school settings</strong>Sign-in controls will unlock only after ClassPilot reconnects to your school.</span>
    </div>
    <div class="classpilot-auth-loading-form" aria-hidden="true">${disabledForm}</div>
  `;
}

function buildAuthGateUnavailableMarkup(state = {}) {
  const retryAt = Number(state.retryAt);
  const retryMessage = Number.isFinite(retryAt) && retryAt > Date.now()
    ? 'ClassPilot will retry automatically. You can also retry now.'
    : 'Use Retry now after checking the Chromebook’s connection.';
  return `
    <div class="classpilot-auth-state-card" role="status" aria-live="polite">
      <span>${authIcon('shield')}</span>
      <span><strong>Your browsing is still protected</strong>ClassPilot could not reach the live sign-in service. No cached information can be used to sign in.</span>
    </div>
    <button class="classpilot-auth-retry" id="classpilot-auth-retry" type="button">Retry now</button>
    <div class="classpilot-auth-retry-status" id="classpilot-auth-retry-status" aria-live="polite">${escapeHtml(retryMessage)}</div>
  `;
}

function buildSetupRequiredMarkup() {
  return `
    <div class="classpilot-auth-roster-note">
      This Chromebook is missing the managed ClassPilot school setup policy, or Shared Chromebook Sign-In is turned off.
    </div>
  `;
}

// Staff shortcut: turn this locked Chromebook into a PassPilot hall-pass
// kiosk. Rendered only when the service worker confirmed the school's kiosk
// is usable (state.kioskUrl non-null); the kiosk page itself is PIN-gated.
function buildKioskLaunchMarkup() {
  return `
    <button class="classpilot-auth-kiosk-button" id="classpilot-auth-kiosk-launch" type="button">Kiosk mode</button>
  `;
}

function buildEmailLoginMarkup(options = {}) {
  const disabled = options.disabled === true;
  const disabledAttribute = disabled ? ' disabled' : '';
  return `
    <form class="classpilot-auth-form" id="classpilot-auth-email-form"${disabled ? ' aria-disabled="true"' : ''}>
      <div class="classpilot-auth-field">
        <label for="classpilot-auth-email"><span class="classpilot-auth-field-icon">${authIcon('mail')}</span><span>School email</span></label>
        <input id="classpilot-auth-email" name="studentEmail" type="email" autocomplete="username" spellcheck="false" placeholder="student@school.edu" required${disabledAttribute} />
      </div>
      <div class="classpilot-auth-field">
        <label for="classpilot-auth-student-id"><span class="classpilot-auth-field-icon">${authIcon('badge')}</span><span>Student ID Number</span></label>
        <input id="classpilot-auth-student-id" name="studentIdNumber" type="text" autocomplete="off" spellcheck="false" placeholder="Student ID" required${disabledAttribute} />
      </div>
      <button class="classpilot-auth-button" id="classpilot-auth-email-submit" type="submit"${disabledAttribute}>Sign In</button>
    </form>
  `;
}

function buildPinLoginMarkup(options = {}) {
  const disabled = options.disabled === true;
  return `
    <form class="classpilot-auth-form" id="classpilot-auth-pin-form"${disabled ? ' aria-disabled="true"' : ''}>
      ${buildGradeChoiceMarkup({ disabled })}
      <div class="classpilot-auth-roster-controls">
        <div class="classpilot-auth-roster-note" id="classpilot-auth-roster-status" aria-live="polite">${disabled ? 'Waiting for live roster access…' : ''}</div>
        ${disabled ? '' : '<button class="classpilot-auth-refresh-names" id="classpilot-auth-roster-refresh" type="button" disabled>Refresh names</button>'}
      </div>
      <div class="classpilot-auth-field classpilot-auth-field--student">
        <label for="classpilot-auth-student"><span class="classpilot-auth-field-icon">${authIcon('user')}</span><span>Student</span></label>
        <select id="classpilot-auth-student" name="studentId" disabled required>
          <option value="">${disabled ? 'Waiting for ClassPilot…' : 'Select a grade first...'}</option>
        </select>
      </div>
      <div class="classpilot-auth-field classpilot-auth-field--pin">
        <label for="classpilot-auth-pin"><span class="classpilot-auth-field-icon">${authIcon('lock')}</span><span>4-digit PIN</span></label>
        <input id="classpilot-auth-pin" name="pin" inputmode="numeric" maxlength="4" autocomplete="off" spellcheck="false" placeholder="Enter your 4-digit PIN" required${disabled ? ' disabled' : ''} />
      </div>
      <button class="classpilot-auth-button" id="classpilot-auth-pin-submit" type="submit" disabled>Sign In</button>
    </form>
  `;
}

function buildGradeChoiceMarkup(options = {}) {
  return `
    <div class="classpilot-auth-field classpilot-auth-field--grade">
      <label for="classpilot-auth-grade"><span class="classpilot-auth-field-icon">${authIcon('graduation')}</span><span>Grade</span></label>
      <select id="classpilot-auth-grade" name="gradeLevel" disabled required>
        <option value="">${options.disabled ? 'Waiting for ClassPilot…' : 'Loading grades...'}</option>
      </select>
    </div>
  `;
}

function setAuthGateError(message) {
  const errorEl = document.getElementById('classpilot-auth-error');
  if (!errorEl) return;
  errorEl.textContent = message || '';
  errorEl.style.display = message ? 'block' : 'none';
}

function clearAuthGateRetryTimer() {
  if (authGateRetryTimer !== null) {
    clearTimeout(authGateRetryTimer);
    authGateRetryTimer = null;
  }
}

function clearAuthGateRosterRefreshTimer() {
  if (authGateRosterRefreshTimer !== null) {
    clearTimeout(authGateRosterRefreshTimer);
    authGateRosterRefreshTimer = null;
  }
}

function nextAuthGateRosterRefreshDelay(refreshAfterMs) {
  const hintedDelay = Number(refreshAfterMs);
  if (Number.isFinite(hintedDelay) && hintedDelay > 0) {
    return Math.min(
      AUTH_GATE_ROSTER_REFRESH_BACKOFF_MAX_MS,
      Math.max(5_000, hintedDelay),
    );
  }
  return AUTH_GATE_ROSTER_REFRESH_MIN_MS + Math.floor(
    Math.random() * (AUTH_GATE_ROSTER_REFRESH_MAX_MS - AUTH_GATE_ROSTER_REFRESH_MIN_MS + 1),
  );
}

function scheduleAuthGateRosterRefresh(refreshAfterMs) {
  clearAuthGateRosterRefreshTimer();
  const gradeSelect = document.getElementById('classpilot-auth-grade');
  if (!authGateActive || authGatePhase(authGateCurrentState || {}) !== 'ready' ||
      authGateCurrentState?.loginMethod === 'email_id' || document.visibilityState === 'hidden' ||
      !gradeSelect) {
    return;
  }
  authGateRosterRefreshTimer = setTimeout(() => {
    authGateRosterRefreshTimer = null;
    refreshAuthGateRosterOrGrades({ background: true });
  }, nextAuthGateRosterRefreshDelay(refreshAfterMs));
}

function setAuthGateRosterStatus(message, warning = false) {
  const status = document.getElementById('classpilot-auth-roster-status');
  if (!status) return;
  status.textContent = message || '';
  status.classList.toggle('classpilot-auth-roster-note--warning', warning);
}

function hasCurrentAuthGateRosterSnapshot(gradeLevel) {
  return authGateRosterSnapshot?.gradeLevel === gradeLevel &&
    Array.isArray(authGateRosterSnapshot.students);
}

function showCachedAuthGateRosterWarning() {
  setAuthGateRosterStatus(
    'Names may be out of date. ClassPilot will try again automatically.',
    true,
  );
}

function restoreAuthGateRosterFocus(control) {
  if (!control?.isConnected || control.disabled || document.activeElement === control) return;
  control.focus({ preventScroll: true });
}

function refreshAuthGateRosterOrGrades(options = {}) {
  const gradeSelect = document.getElementById('classpilot-auth-grade');
  if (!gradeSelect) return;
  if (gradeSelect.value) loadAuthGateRoster(options);
  else loadAuthGateGradeOptions(options);
}

function refreshVisibleAuthGateRoster() {
  const gradeSelect = document.getElementById('classpilot-auth-grade');
  if (!authGateActive || document.visibilityState === 'hidden' ||
      authGatePhase(authGateCurrentState || {}) !== 'ready' ||
      authGateCurrentState?.loginMethod === 'email_id' || !gradeSelect) {
    return;
  }
  refreshAuthGateRosterOrGrades({ forceRefresh: true, background: true });
}

function fallbackAuthGateRetryDelay() {
  const delays = [2_000, 5_000, 15_000, 30_000];
  const delay = delays[Math.min(authGateRetryFallbackIndex, delays.length - 1)];
  authGateRetryFallbackIndex += 1;
  return delay;
}

function scheduleAuthGateRetry(state = {}) {
  clearAuthGateRetryTimer();
  if (!authGateActive || authGatePhase(state) !== 'unavailable') return;

  const retryAt = Number(state.retryAt);
  const delay = Number.isFinite(retryAt) && retryAt > Date.now()
    ? Math.max(0, retryAt - Date.now())
    : fallbackAuthGateRetryDelay();
  authGateRetryTimer = setTimeout(() => {
    authGateRetryTimer = null;
    requestAuthGateRefresh(false);
  }, delay);
}

function requestAuthGateRefresh(userInitiated) {
  clearAuthGateRetryTimer();
  const retryButton = document.getElementById('classpilot-auth-retry');
  const retryStatus = document.getElementById('classpilot-auth-retry-status');
  if (retryButton) {
    retryButton.disabled = true;
    retryButton.textContent = 'Connecting…';
    retryButton.setAttribute('aria-busy', 'true');
  }
  if (retryStatus) retryStatus.textContent = 'Checking the live ClassPilot sign-in service…';

  const message = {
    type: 'refresh-auth-state',
    reason: userInitiated ? 'user' : 'page_timer',
  };
  if (authGateLatestRevision >= 0) message.revision = authGateLatestRevision;
  const requestGeneration = authGateStateRequestGeneration;

  chrome.runtime.sendMessage(message, (response) => {
    const runtimeError = chrome.runtime.lastError;
    if (requestGeneration !== authGateStateRequestGeneration ||
        isAuthGateManagedPolicyFencePending()) return;
    if (!runtimeError && response?.state) {
      applyAuthGateState(response.state);
      return;
    }

    const currentRetryButton = document.getElementById('classpilot-auth-retry');
    const currentRetryStatus = document.getElementById('classpilot-auth-retry-status');
    if (currentRetryButton) {
      currentRetryButton.disabled = false;
      currentRetryButton.textContent = 'Retry now';
      currentRetryButton.setAttribute('aria-busy', 'false');
    }
    if (currentRetryStatus) {
      currentRetryStatus.textContent = response?.error || 'ClassPilot is still unavailable. Browsing remains locked.';
    }
    scheduleAuthGateRetry(authGateCurrentState || { phase: 'unavailable' });
  });
}

function recordAuthGateOutcome(state = {}) {
  const phase = authGatePhase(state);
  if (phase === 'loading') return;
  if (typeof globalThis.__classpilotAuthGateBootstrap?.recordOutcome === 'function') {
    globalThis.__classpilotAuthGateBootstrap.recordOutcome(state);
    return;
  }
  chrome.runtime.sendMessage({
    type: 'record-auth-gate-timing',
    timing: {
      loadingPaintMs: null,
      configReadyMs: null,
      outcome: phase,
      coldWorker: state.coldWorker === true,
      timestamp: Date.now(),
    },
  }, () => {
    void chrome.runtime.lastError;
  });
}

function updatePinAuthSubmitState() {
  const studentSelect = document.getElementById('classpilot-auth-student');
  const pinInput = document.getElementById('classpilot-auth-pin');
  const submit = document.getElementById('classpilot-auth-pin-submit');
  if (!studentSelect || !pinInput || !submit) return;
  const selectedStudent = studentSelect.selectedOptions?.[0];
  const selectedStudentHasPin = Boolean(
    selectedStudent && selectedStudent.value && selectedStudent.disabled !== true
  );
  submit.disabled = !authGateLiveRosterLoaded || studentSelect.disabled ||
    !selectedStudentHasPin || !/^\d{4}$/.test(pinInput.value);
}

function attachAuthGateHandlers(state) {
  const phase = authGatePhase(state);
  if (phase === 'unavailable') {
    document.getElementById('classpilot-auth-retry')?.addEventListener('click', () => {
      requestAuthGateRefresh(true);
    });
    scheduleAuthGateRetry(state);
    recordAuthGateOutcome(state);
    return;
  }
  if (phase !== 'ready') {
    recordAuthGateOutcome(state);
    return;
  }

  authGateRetryFallbackIndex = 0;
  recordAuthGateOutcome(state);
  const emailForm = document.getElementById('classpilot-auth-email-form');
  const pinForm = document.getElementById('classpilot-auth-pin-form');

  if (emailForm) {
    emailForm.addEventListener('submit', (event) => {
      event.preventDefault();
      submitAuthGateLogin({
        mode: 'email_id',
        studentEmail: document.getElementById('classpilot-auth-email')?.value || '',
        studentIdNumber: document.getElementById('classpilot-auth-student-id')?.value || '',
      }, event.submitter);
    });
  }

  if (pinForm) {
    const gradeSelect = document.getElementById('classpilot-auth-grade');
    const studentSelect = document.getElementById('classpilot-auth-student');
    if (gradeSelect) {
      gradeSelect.addEventListener('change', () => {
        authGateRosterSnapshot = null;
        clearAuthGateRosterRefreshTimer();
        loadAuthGateRoster();
      });
    }
    studentSelect?.addEventListener('change', updatePinAuthSubmitState);
    document.getElementById('classpilot-auth-roster-refresh')?.addEventListener('click', () => {
      refreshAuthGateRosterOrGrades({ forceRefresh: true });
    });
    const pinInput = document.getElementById('classpilot-auth-pin');
    pinInput?.addEventListener('input', () => {
      pinInput.value = pinInput.value.replace(/\D/g, '').slice(0, 4);
      updatePinAuthSubmitState();
    });
    pinForm.addEventListener('submit', (event) => {
      event.preventDefault();
      submitAuthGateLogin({
        mode: 'pin',
        studentId: document.getElementById('classpilot-auth-student')?.value || '',
        pin: pinInput?.value || '',
        ...(authGateRosterSnapshot?.recoveryGrantId
          ? { recoveryGrantId: authGateRosterSnapshot.recoveryGrantId }
          : {}),
      }, event.submitter);
    });
    loadAuthGateGradeOptions();
  }

  const kioskButton = document.getElementById('classpilot-auth-kiosk-launch');
  if (kioskButton && typeof state.kioskUrl === 'string' && state.kioskUrl) {
    // Current-tab navigation; the click originates inside the gate element so
    // the input blockers permit it, and the URL is built by the service
    // worker (never from page-controlled data).
    kioskButton.addEventListener('click', () => {
      const requestGeneration = authGateStateRequestGeneration;
      const expectedRevision = authGateRevision(state);
      const expectedKioskUrl = state.kioskUrl;
      const launchStateIsCurrent = () => Boolean(
        requestGeneration === authGateStateRequestGeneration
        && !isAuthGateManagedPolicyFencePending()
        && authGateRevision(authGateCurrentState || {}) === expectedRevision
        && authGateCurrentState?.kioskUrl === expectedKioskUrl
      );
      kioskButton.disabled = true;
      chrome.runtime.sendMessage({ type: 'request-kiosk-launch' }, (response) => {
        if (!launchStateIsCurrent()) return;
        kioskButton.disabled = false;
        if (chrome.runtime.lastError || response?.success !== true || !response.url) {
          setAuthGateError('PassPilot kiosk is unavailable. Please try again.');
          return;
        }
        chrome.runtime.sendMessage({
          type: 'validate-kiosk-launch',
          url: response.url,
          launchGuard: response.launchGuard,
        }, (validation) => {
          if (!launchStateIsCurrent()) return;
          if (
            chrome.runtime.lastError
            || validation?.success !== true
            || validation.current !== true
          ) {
            setAuthGateError('PassPilot kiosk is unavailable. Please try again.');
            return;
          }
          try {
            const parsed = new URL(response.url);
            if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error();
            window.location.assign(parsed.href);
          } catch {
            setAuthGateError('PassPilot kiosk is unavailable. Please try again.');
          }
        });
      });
    });
  }
}

function loadAuthGateGradeOptions(options = {}) {
  const gradeSelect = document.getElementById('classpilot-auth-grade');
  const studentSelect = document.getElementById('classpilot-auth-student');
  const status = document.getElementById('classpilot-auth-roster-status');
  const submit = document.getElementById('classpilot-auth-pin-submit');
  const refreshButton = document.getElementById('classpilot-auth-roster-refresh');
  if (!gradeSelect || !studentSelect || !status || !submit) return;
  clearAuthGateRosterRefreshTimer();
  authGateLiveRosterLoaded = false;
  authGateRosterSnapshot = null;
  const requestGeneration = ++authGateRosterRequestGeneration;
  const preserveControls = options.background === true || options.forceRefresh === true;
  const previousGrade = gradeSelect.value;
  const focusedControl = preserveControls && document.activeElement instanceof HTMLElement
    ? document.activeElement
    : null;

  setAuthGateRosterStatus(preserveControls ? 'Refreshing grades…' : 'Loading grades...');
  status.setAttribute('aria-busy', 'true');
  if (!preserveControls) {
    gradeSelect.innerHTML = '<option value="">Loading grades...</option>';
    gradeSelect.disabled = true;
    studentSelect.innerHTML = '<option value="">Select a grade first...</option>';
  }
  studentSelect.disabled = true;
  submit.disabled = true;
  if (refreshButton) {
    refreshButton.disabled = true;
    refreshButton.textContent = 'Refreshing…';
    refreshButton.setAttribute('aria-busy', 'true');
  }

  chrome.runtime.sendMessage({
    type: 'get-login-roster',
    ...(options.forceRefresh === true ? { forceRefresh: true } : {}),
    ...(options.forceRecovery === true ? { forceRecovery: true } : {}),
  }, (response) => {
    const runtimeError = chrome.runtime.lastError;
    if (requestGeneration !== authGateRosterRequestGeneration || !status.isConnected) return;
    status.setAttribute('aria-busy', 'false');
    if (refreshButton) {
      refreshButton.disabled = false;
      refreshButton.textContent = 'Refresh names';
      refreshButton.setAttribute('aria-busy', 'false');
    }
    if (runtimeError || !response?.success) {
      const failurePhase = response?.phase === 'setup_required'
        ? 'setup_required'
        : response?.phase === 'unavailable' || runtimeError
          ? 'unavailable'
          : null;
      if (failurePhase) {
        applyAuthGateState({
          ...(authGateCurrentState || {}),
          phase: failurePhase,
          authRequired: true,
          setupRequired: failurePhase === 'setup_required',
          retryAt: failurePhase === 'unavailable' ? Date.now() + 2_000 : null,
        });
        return;
      }
      setAuthGateRosterStatus(response?.error || 'Could not load roster grades.');
      if (!preserveControls) {
        gradeSelect.innerHTML = '<option value="">Grades unavailable</option>';
        gradeSelect.disabled = true;
      }
      scheduleAuthGateRosterRefresh(response?.refreshAfterMs);
      restoreAuthGateRosterFocus(focusedControl);
      return;
    }

    const grades = Array.isArray(response.grades) ? response.grades.filter((grade) => grade?.value) : [];
    if (!grades.length) {
      setAuthGateRosterStatus(
        response.cached === true && response.warning
          ? 'No roster grades are currently available. Names may be out of date; ClassPilot will try again automatically.'
          : 'No roster grades are currently available.',
        response.cached === true && Boolean(response.warning),
      );
      gradeSelect.innerHTML = '<option value="">No grades available</option>';
      gradeSelect.disabled = true;
      studentSelect.innerHTML = '<option value="">Select a grade first...</option>';
      studentSelect.disabled = true;
      submit.disabled = true;
      scheduleAuthGateRosterRefresh(response.refreshAfterMs);
      restoreAuthGateRosterFocus(focusedControl);
      return;
    }

    setAuthGateRosterStatus('');
    gradeSelect.innerHTML = '<option value="">Select your grade</option>' +
      grades
        .map((grade) => `<option value="${escapeHtml(grade.value)}">${escapeHtml(grade.label || `Grade ${grade.value}`)}</option>`)
        .join('');
    gradeSelect.disabled = false;

    const panel = document.querySelector('.classpilot-auth-panel');
    if (panel && document.activeElement === panel) {
      gradeSelect.focus({ preventScroll: true });
    }

    if (previousGrade && grades.some((grade) => String(grade.value) === previousGrade)) {
      gradeSelect.value = previousGrade;
    } else if (grades.length === 1) {
      gradeSelect.value = String(grades[0].value);
    }
    restoreAuthGateRosterFocus(focusedControl);
    if (gradeSelect.value) {
      loadAuthGateRoster();
    }
  });
}

function loadAuthGateRoster(options = {}) {
  const select = document.getElementById('classpilot-auth-student');
  const status = document.getElementById('classpilot-auth-roster-status');
  const submit = document.getElementById('classpilot-auth-pin-submit');
  const gradeSelect = document.getElementById('classpilot-auth-grade');
  const refreshButton = document.getElementById('classpilot-auth-roster-refresh');
  const selectedGrade = gradeSelect?.value || '';
  if (!select || !status || !submit) return;
  clearAuthGateRosterRefreshTimer();
  const hasSnapshot = hasCurrentAuthGateRosterSnapshot(selectedGrade);
  authGateLiveRosterLoaded = hasSnapshot;
  const requestGeneration = ++authGateRosterRequestGeneration;

  if (gradeSelect && !selectedGrade) {
    authGateRosterSnapshot = null;
    setAuthGateRosterStatus('');
    status.setAttribute('aria-busy', 'false');
    select.innerHTML = '<option value="">Select a grade first...</option>';
    select.disabled = true;
    submit.disabled = true;
    if (refreshButton) {
      refreshButton.disabled = false;
      refreshButton.textContent = 'Refresh names';
      refreshButton.setAttribute('aria-busy', 'false');
    }
    scheduleAuthGateRosterRefresh();
    return;
  }

  if (refreshButton) {
    refreshButton.disabled = true;
    refreshButton.textContent = 'Refreshing…';
    refreshButton.setAttribute('aria-busy', 'true');
  }
  setAuthGateRosterStatus(hasSnapshot ? 'Refreshing names…' : 'Loading roster…');
  status.setAttribute('aria-busy', 'true');
  if (!hasSnapshot) {
    select.innerHTML = '<option value="">Loading students...</option>';
    select.disabled = true;
    submit.disabled = true;
  }

  chrome.runtime.sendMessage({
    type: 'get-login-roster',
    gradeLevel: selectedGrade,
    ...(options.forceRefresh === true ? { forceRefresh: true } : {}),
    ...(options.forceRecovery === true ? { forceRecovery: true } : {}),
  }, (response) => {
    const runtimeError = chrome.runtime.lastError;
    if (requestGeneration !== authGateRosterRequestGeneration ||
        !status.isConnected || !gradeSelect?.isConnected || gradeSelect.value !== selectedGrade) {
      return;
    }
    status.setAttribute('aria-busy', 'false');
    if (refreshButton) {
      refreshButton.disabled = false;
      refreshButton.textContent = 'Refresh names';
      refreshButton.setAttribute('aria-busy', 'false');
    }
    if (runtimeError || !response?.success) {
      if (response?.phase === 'setup_required') {
        applyAuthGateState({
          ...(authGateCurrentState || {}),
          phase: 'setup_required',
          authRequired: true,
          setupRequired: true,
          retryAt: null,
        });
        return;
      }
      if (hasCurrentAuthGateRosterSnapshot(selectedGrade)) {
        showCachedAuthGateRosterWarning();
        updatePinAuthSubmitState();
        scheduleAuthGateRosterRefresh(response?.refreshAfterMs);
        return;
      }
      const failurePhase = response?.phase === 'setup_required'
        ? 'setup_required'
        : response?.phase === 'unavailable' || runtimeError
          ? 'unavailable'
          : null;
      if (failurePhase) {
        applyAuthGateState({
          ...(authGateCurrentState || {}),
          phase: failurePhase,
          authRequired: true,
          setupRequired: failurePhase === 'setup_required',
          retryAt: failurePhase === 'unavailable' ? Date.now() + 2_000 : null,
        });
        return;
      }
      status.textContent = response?.error || 'Could not load the classroom roster.';
      select.innerHTML = '<option value="">Roster unavailable</option>';
      select.disabled = true;
      submit.disabled = true;
      scheduleAuthGateRosterRefresh(response?.refreshAfterMs);
      return;
    }

    const students = Array.isArray(response.students)
      ? response.students.filter((student) => student && student.id)
      : [];
    const previousStudentId = select.value;
    authGateRosterSnapshot = {
      gradeLevel: selectedGrade,
      students,
      recoveryGrantId: typeof response.recoveryGrantId === 'string'
        ? response.recoveryGrantId
        : null,
    };
    authGateLiveRosterLoaded = true;
    if (!students.length) {
      if (response.cached === true && response.warning) {
        setAuthGateRosterStatus(
          'No students are currently available. Names may be out of date; ClassPilot will try again automatically.',
          true,
        );
      } else {
        setAuthGateRosterStatus('No students are currently available.');
      }
      select.innerHTML = '<option value="">No students available</option>';
      select.disabled = true;
      submit.disabled = true;
      scheduleAuthGateRosterRefresh(response.refreshAfterMs);
      return;
    }

    select.innerHTML = '<option value="">Select your name...</option>' +
      students
        .map((student) => `<option value="${escapeHtml(student.id)}" ${student.hasPin ? '' : 'disabled'}>${escapeHtml(student.name || 'Unknown')}${student.reclaimable === true ? ' — Resume on this Chromebook' : ''}${student.hasPin ? '' : ' (PIN missing)'}</option>`)
        .join('');
    select.disabled = false;
    if (students.some((student) => String(student.id) === previousStudentId)) {
      select.value = previousStudentId;
    }
    if (response.cached === true && response.warning) showCachedAuthGateRosterWarning();
    else setAuthGateRosterStatus('');
    updatePinAuthSubmitState();
    scheduleAuthGateRosterRefresh(response.refreshAfterMs);
  });
}

function submitAuthGateLogin(payload, submitButton) {
  setAuthGateError('');
  const submit = submitButton || document.getElementById(payload.mode === 'pin' ? 'classpilot-auth-pin-submit' : 'classpilot-auth-email-submit');
  if (submit) {
    submit.disabled = true;
    submit.textContent = 'Signing in…';
    submit.setAttribute('aria-busy', 'true');
  }

  const requestGeneration = authGateStateRequestGeneration;
  chrome.runtime.sendMessage({ type: 'manual-student-login', payload }, (response) => {
    if (requestGeneration !== authGateStateRequestGeneration) return;
    if (chrome.runtime.lastError || !response?.success) {
      if (submit) {
        submit.textContent = 'Sign In';
        submit.setAttribute('aria-busy', 'false');
      }
      const activeSessionConflict = response?.status === 409
        || response?.code === 'STUDENT_SESSION_ACTIVE';
      if (activeSessionConflict) {
        setAuthGateError('This Chromebook or student already has an active ClassPilot session. ClassPilot is refreshing available names.');
        const pinInput = document.getElementById('classpilot-auth-pin');
        if (pinInput) pinInput.value = '';
        if (payload.mode === 'pin') {
          updatePinAuthSubmitState();
          refreshAuthGateRosterOrGrades({
            forceRefresh: true,
            forceRecovery: true,
            background: true,
          });
        } else if (submit) {
          submit.disabled = false;
        }
        pinInput?.focus({ preventScroll: true });
        return;
      }
      if (response?.status === 503 || response?.code === 'STUDENT_SESSION_TRANSFER_UNAVAILABLE') {
        setAuthGateError('ClassPilot sign-in is temporarily unavailable. Your selection was kept; please try again.');
        if (submit) {
          if (payload.mode === 'pin') updatePinAuthSubmitState();
          else submit.disabled = false;
        }
        const retryField = document.getElementById(
          payload.mode === 'pin' ? 'classpilot-auth-pin' : 'classpilot-auth-email',
        );
        retryField?.focus({ preventScroll: true });
        retryField?.select?.();
        return;
      }
      setAuthGateError(response?.error || 'Invalid student credentials');
      if (submit) {
        if (payload.mode === 'pin') {
          updatePinAuthSubmitState();
        } else {
          submit.disabled = false;
        }
      }
      const retryField = document.getElementById(payload.mode === 'pin' ? 'classpilot-auth-pin' : 'classpilot-auth-email');
      retryField?.focus({ preventScroll: true });
      retryField?.select?.();
      return;
    }
    if (isAuthGateManagedPolicyFencePending()) {
      if (authGatePendingManagedPolicyFence === 0) beginAuthGateManagedPolicyFence();
      return;
    }
    removeAuthGate();
  });
}

// Monitor camera usage by wrapping getUserMedia
(function() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    return; // Browser doesn't support getUserMedia
  }
  
  const originalGetUserMedia = navigator.mediaDevices.getUserMedia.bind(navigator.mediaDevices);
  
  navigator.mediaDevices.getUserMedia = async function(constraints) {
    const stream = await originalGetUserMedia(constraints);
    
    // Check if video (camera) was requested
    if (constraints && constraints.video) {
      console.log('[ClassPilot] Camera access granted');
      activeCameraStreams.add(stream);
      updateCameraStatus(true);
      
      // Monitor when stream ends
      const videoTracks = stream.getVideoTracks();
      videoTracks.forEach(track => {
        track.addEventListener('ended', () => {
          console.log('[ClassPilot] Camera track ended');
          activeCameraStreams.delete(stream);
          
          // Check if any other streams are still active
          const stillActive = Array.from(activeCameraStreams).some(s => {
            return s.getVideoTracks().some(t => t.readyState === 'live');
          });
          
          if (!stillActive) {
            updateCameraStatus(false);
          }
        });
      });
    }
    
    return stream;
  };
})();

// Update camera status and notify service worker
function updateCameraStatus(isActive) {
  if (cameraActive !== isActive) {
    cameraActive = isActive;
    console.log('[ClassPilot] Camera status changed:', isActive);
    const expectedEpoch = studentMessageEpoch;
    const studentMessageContext = currentStudentMessageContext?.authContextId
      ? { ...currentStudentMessageContext }
      : null;
    if (!studentMessageContext) return;
    // The exact content authority is captured before dispatch. A delayed A
    // message is rejected by the worker after an A→B transition.
    chrome.runtime.sendMessage({
      type: 'camera-status-changed',
      cameraActive: isActive,
      studentMessageContext,
    }).then(() => {
      if (expectedEpoch !== studentMessageEpoch) return;
    }).catch(() => {
      // Ignore errors if extension context is invalidated
      console.log('[ClassPilot] Could not notify service worker');
    });
  }
}

function showLicenseBanner(planStatus) {
  const existingBanner = document.getElementById('classpilot-license-banner');
  const statusText = planStatus ? ` (planStatus=${planStatus})` : '';

  if (existingBanner) {
    existingBanner.textContent = `ClassPilot disabled: school license inactive${statusText}`;
    return;
  }

  const banner = document.createElement('div');
  banner.id = 'classpilot-license-banner';
  banner.textContent = `ClassPilot disabled: school license inactive${statusText}`;
  banner.style.position = 'fixed';
  banner.style.top = '0';
  banner.style.left = '0';
  banner.style.right = '0';
  banner.style.zIndex = '2147483647';
  banner.style.background = '#fee2e2';
  banner.style.color = '#7f1d1d';
  banner.style.fontSize = '14px';
  banner.style.fontWeight = '600';
  banner.style.padding = '10px 16px';
  banner.style.textAlign = 'center';
  banner.style.boxShadow = '0 2px 6px rgba(0,0,0,0.2)';
  document.body.appendChild(banner);
}

function removeLicenseBanner() {
  const existingBanner = document.getElementById('classpilot-license-banner');
  if (existingBanner) {
    existingBanner.remove();
  }
}

// Show regular message as modal
function showMessageModal(data) {
  const { message, fromName, timestamp, isTeacherReply } = data;

  // Remove any existing message modal first
  const existingModal = document.getElementById('classpilot-message-modal');
  if (existingModal) {
    existingModal.remove();
  }

  const icon = isTeacherReply ? '📩' : '💬';
  const headerStyle = isTeacherReply
    ? 'background: linear-gradient(135deg, #10b981, #059669); border-left: 4px solid #10b981;'
    : '';
  const title = isTeacherReply ? 'Reply from Teacher' : `Message from ${escapeHtml(fromName || 'Teacher')}`;

  // Create modal overlay
  const modal = document.createElement('div');
  modal.id = 'classpilot-message-modal';
  modal.innerHTML = `
    <div class="classpilot-modal-overlay">
      <div class="classpilot-modal-content classpilot-message">
        <div class="classpilot-modal-header" style="${headerStyle}">
          <div class="classpilot-modal-icon">${icon}</div>
          <h2>${title}</h2>
        </div>
        <div class="classpilot-modal-body">
          <p>${escapeHtml(message)}</p>
        </div>
        <div class="classpilot-modal-footer">
          <button class="classpilot-modal-button" id="classpilot-close-msg-btn">
            Close
          </button>
        </div>
      </div>
    </div>
  `;
  
  // Add styles
  addModalStyles();
  
  // Add to page
  document.body.appendChild(modal);
  
  // Add event listener to close button - use querySelector on modal element
  const closeBtn = modal.querySelector('#classpilot-close-msg-btn');
  if (closeBtn) {
    closeBtn.addEventListener('click', () => {
      modal.remove();
    });
  }
}

// Add modal styles to page (only once)
function addModalStyles() {
  if (document.getElementById('classpilot-modal-styles')) {
    return; // Already added
  }
  
  const style = document.createElement('style');
  style.id = 'classpilot-modal-styles';
  style.textContent = `
    .classpilot-modal-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.85);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 2147483647;
      animation: classpilot-fade-in 0.3s ease-out;
    }
    
    @keyframes classpilot-fade-in {
      from {
        opacity: 0;
      }
      to {
        opacity: 1;
      }
    }
    
    .classpilot-modal-content {
      background: white;
      border-radius: 16px;
      max-width: 500px;
      width: 90%;
      box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
      animation: classpilot-slide-up 0.3s ease-out;
      overflow: hidden;
    }
    
    @keyframes classpilot-slide-up {
      from {
        transform: translateY(50px);
        opacity: 0;
      }
      to {
        transform: translateY(0);
        opacity: 1;
      }
    }
    
    .classpilot-modal-content.classpilot-announcement {
      border-top: 6px solid #f59e0b;
    }
    
    .classpilot-modal-content.classpilot-message {
      border-top: 6px solid #3b82f6;
    }
    
    .classpilot-modal-header {
      padding: 24px 24px 16px;
      text-align: center;
      background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%);
    }
    
    .classpilot-modal-content.classpilot-message .classpilot-modal-header {
      background: linear-gradient(135deg, #dbeafe 0%, #bfdbfe 100%);
    }
    
    .classpilot-modal-icon {
      font-size: 48px;
      margin-bottom: 12px;
      animation: classpilot-bounce 0.6s ease-in-out;
    }
    
    @keyframes classpilot-bounce {
      0%, 100% {
        transform: scale(1);
      }
      50% {
        transform: scale(1.1);
      }
    }
    
    .classpilot-modal-header h2 {
      margin: 0;
      font-size: 24px;
      font-weight: 700;
      color: #92400e;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
    
    .classpilot-modal-content.classpilot-message .classpilot-modal-header h2 {
      color: #1e40af;
    }
    
    .classpilot-modal-body {
      padding: 32px 24px;
      text-align: center;
    }
    
    .classpilot-modal-body p {
      margin: 0;
      font-size: 18px;
      line-height: 1.6;
      color: #1e293b;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      white-space: pre-wrap;
    }
    
    .classpilot-modal-footer {
      padding: 16px 24px 24px;
      text-align: center;
    }
    
    .classpilot-modal-button {
      background: #f59e0b;
      color: white;
      border: none;
      padding: 14px 32px;
      font-size: 16px;
      font-weight: 600;
      border-radius: 8px;
      cursor: pointer;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      transition: all 0.2s;
      box-shadow: 0 4px 12px rgba(245, 158, 11, 0.4);
    }
    
    .classpilot-modal-button:hover {
      background: #d97706;
      transform: translateY(-2px);
      box-shadow: 0 6px 16px rgba(245, 158, 11, 0.5);
    }
    
    .classpilot-modal-button:active {
      transform: translateY(0);
    }
    
    .classpilot-modal-content.classpilot-message .classpilot-modal-button {
      background: #3b82f6;
      box-shadow: 0 4px 12px rgba(59, 130, 246, 0.4);
    }
    
    .classpilot-modal-content.classpilot-message .classpilot-modal-button:hover {
      background: #2563eb;
      box-shadow: 0 6px 16px rgba(59, 130, 246, 0.5);
    }
  `;
  
  document.head.appendChild(style);
}

// Escape HTML to prevent XSS
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}


// ============================================
// ATTENTION MODE OVERLAY
// ============================================

function showAttentionOverlay(message) {
  attentionModeActive = true;

  // Remove any existing attention overlay
  const existing = document.getElementById('classpilot-attention-overlay');
  if (existing) {
    existing.remove();
  }

  const overlay = document.createElement('div');
  overlay.id = 'classpilot-attention-overlay';
  overlay.innerHTML = `
    <div class="classpilot-attention-content">
      <div class="classpilot-attention-icon">👀</div>
      <h1 class="classpilot-attention-title">${escapeHtml(message)}</h1>
      <p class="classpilot-attention-subtitle">Your teacher needs your attention</p>
    </div>
  `;

  addAttentionStyles();
  document.body.appendChild(overlay);
}

function hideAttentionOverlay() {
  attentionModeActive = false;
  const overlay = document.getElementById('classpilot-attention-overlay');
  if (overlay) {
    overlay.classList.add('classpilot-fade-out');
    setTimeout(() => overlay.remove(), 300);
  }
}

function addAttentionStyles() {
  if (document.getElementById('classpilot-attention-styles')) {
    return;
  }

  const style = document.createElement('style');
  style.id = 'classpilot-attention-styles';
  style.textContent = `
    #classpilot-attention-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: linear-gradient(135deg, #1e3a8a 0%, #3730a3 50%, #6d28d9 100%);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 2147483647;
      animation: classpilot-attention-in 0.5s ease-out;
    }

    #classpilot-attention-overlay.classpilot-fade-out {
      animation: classpilot-attention-out 0.3s ease-in forwards;
    }

    @keyframes classpilot-attention-in {
      from { opacity: 0; transform: scale(1.1); }
      to { opacity: 1; transform: scale(1); }
    }

    @keyframes classpilot-attention-out {
      from { opacity: 1; }
      to { opacity: 0; }
    }

    .classpilot-attention-content {
      text-align: center;
      color: white;
      animation: classpilot-attention-pulse 2s ease-in-out infinite;
    }

    @keyframes classpilot-attention-pulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.02); }
    }

    .classpilot-attention-icon {
      font-size: 120px;
      margin-bottom: 24px;
      animation: classpilot-attention-bounce 1s ease-in-out infinite;
    }

    @keyframes classpilot-attention-bounce {
      0%, 100% { transform: translateY(0); }
      50% { transform: translateY(-10px); }
    }

    .classpilot-attention-title {
      font-size: 64px;
      font-weight: 800;
      margin: 0 0 16px 0;
      text-shadow: 0 4px 20px rgba(0,0,0,0.3);
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }

    .classpilot-attention-subtitle {
      font-size: 24px;
      opacity: 0.9;
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
  `;

  document.head.appendChild(style);
}

// ============================================
// TIMER OVERLAY
// ============================================

function startTimerOverlay(seconds, message, absoluteEndsAt = null) {
  // Clear any existing timer
  stopTimerOverlay();

  const parsedEndsAt = typeof absoluteEndsAt === 'number'
    ? absoluteEndsAt
    : Date.parse(absoluteEndsAt || '');
  timerEndTime = Number.isFinite(parsedEndsAt) && parsedEndsAt > 0
    ? parsedEndsAt
    : Date.now() + (Math.max(0, Number(seconds || 0)) * 1000);
  activeTimerIdentity = Object.freeze({
    epoch: studentMessageEpoch,
    endsAt: timerEndTime,
  });

  // Remove any existing timer overlay
  const existing = document.getElementById('classpilot-timer-overlay');
  if (existing) {
    existing.remove();
  }

  const overlay = document.createElement('div');
  overlay.id = 'classpilot-timer-overlay';
  overlay.innerHTML = `
    <div class="classpilot-timer-content">
      <div class="classpilot-timer-display">00:00</div>
      ${message ? `<div class="classpilot-timer-message">${escapeHtml(message)}</div>` : ''}
    </div>
  `;

  addTimerStyles();
  document.body.appendChild(overlay);

  // Update timer display
  updateTimerDisplay();
  timerInterval = setInterval(updateTimerDisplay, 1000);
}

function updateTimerDisplay() {
  const timerDisplay = document.querySelector('#classpilot-timer-overlay .classpilot-timer-display');
  if (!timerDisplay || !timerEndTime) {
    return;
  }

  const remaining = Math.max(0, timerEndTime - Date.now());
  const minutes = Math.floor(remaining / 60000);
  const seconds = Math.floor((remaining % 60000) / 1000);

  timerDisplay.textContent = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;

  if (remaining <= 0) {
    // Timer finished
    timerDisplay.classList.add('classpilot-timer-finished');
    timerDisplay.textContent = "Time's up!";
    clearInterval(timerInterval);
    timerInterval = null;

    // Flash effect
    const overlay = document.getElementById('classpilot-timer-overlay');
    if (overlay) {
      overlay.classList.add('classpilot-timer-flash');
    }

    // Auto-hide after 5 seconds
    const completedIdentity = activeTimerIdentity;
    timerAutoHideTimeout = setTimeout(() => {
      timerAutoHideTimeout = null;
      if (
        completedIdentity?.epoch !== studentMessageEpoch
        || activeTimerIdentity !== completedIdentity
        || timerEndTime !== completedIdentity.endsAt
      ) return;
      stopTimerOverlay();
    }, 5000);
  }
}

function stopTimerOverlay() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  if (timerAutoHideTimeout) {
    clearTimeout(timerAutoHideTimeout);
    timerAutoHideTimeout = null;
  }
  timerEndTime = null;
  activeTimerIdentity = null;

  const overlay = document.getElementById('classpilot-timer-overlay');
  if (overlay) {
    overlay.classList.add('classpilot-timer-out');
    setTimeout(() => overlay.remove(), 300);
  }
}

function addTimerStyles() {
  if (document.getElementById('classpilot-timer-styles')) {
    return;
  }

  const style = document.createElement('style');
  style.id = 'classpilot-timer-styles';
  style.textContent = `
    #classpilot-timer-overlay {
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 2147483646;
      animation: classpilot-timer-in 0.3s ease-out;
    }

    #classpilot-timer-overlay.classpilot-timer-out {
      animation: classpilot-timer-out-anim 0.3s ease-in forwards;
    }

    @keyframes classpilot-timer-in {
      from { opacity: 0; transform: translateY(20px); }
      to { opacity: 1; transform: translateY(0); }
    }

    @keyframes classpilot-timer-out-anim {
      from { opacity: 1; transform: translateY(0); }
      to { opacity: 0; transform: translateY(20px); }
    }

    .classpilot-timer-content {
      background: linear-gradient(135deg, #1e293b 0%, #0f172a 100%);
      border-radius: 16px;
      padding: 16px 24px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.4);
      border: 2px solid #334155;
    }

    .classpilot-timer-display {
      font-size: 48px;
      font-weight: 700;
      color: #f8fafc;
      font-family: 'SF Mono', 'Monaco', 'Inconsolata', monospace;
      text-align: center;
      text-shadow: 0 2px 10px rgba(59, 130, 246, 0.5);
    }

    .classpilot-timer-display.classpilot-timer-finished {
      color: #f87171;
      animation: classpilot-timer-pulse 0.5s ease-in-out infinite;
    }

    @keyframes classpilot-timer-pulse {
      0%, 100% { transform: scale(1); }
      50% { transform: scale(1.05); }
    }

    .classpilot-timer-message {
      font-size: 14px;
      color: #94a3b8;
      text-align: center;
      margin-top: 8px;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }

    #classpilot-timer-overlay.classpilot-timer-flash {
      animation: classpilot-timer-flash-anim 0.3s ease-in-out 3;
    }

    @keyframes classpilot-timer-flash-anim {
      0%, 100% { background: transparent; }
      50% { background: rgba(239, 68, 68, 0.2); }
    }
  `;

  document.head.appendChild(style);
}

// ============================================
// POLL OVERLAY
// ============================================

function showPollOverlay(pollId, question, options, teachingSessionId = null) {
  // Skip if student already responded to this poll
  if (respondedPollIds.has(pollId)) {
    return;
  }
  clearPollCompletionTimeouts();
  activePollId = pollId;
  activePollTeachingSessionId = String(teachingSessionId || '').trim() || null;

  // Remove any existing poll overlay
  const existing = document.getElementById('classpilot-poll-overlay');
  if (existing) {
    existing.remove();
  }

  const optionsHtml = options.map((option, index) => `
    <button class="classpilot-poll-option" data-index="${index}">
      <span class="classpilot-poll-option-letter">${String.fromCharCode(65 + index)}</span>
      <span class="classpilot-poll-option-text">${escapeHtml(option)}</span>
    </button>
  `).join('');

  const overlay = document.createElement('div');
  overlay.id = 'classpilot-poll-overlay';
  overlay.innerHTML = `
    <div class="classpilot-poll-content">
      <div class="classpilot-poll-header">
        <div class="classpilot-poll-icon">📊</div>
        <h2 class="classpilot-poll-title">Quick Poll</h2>
      </div>
      <div class="classpilot-poll-body">
        <p class="classpilot-poll-question">${escapeHtml(question)}</p>
        <div class="classpilot-poll-options">
          ${optionsHtml}
        </div>
      </div>
    </div>
  `;

  addPollStyles();
  document.body.appendChild(overlay);

  // Add click handlers to options
  overlay.querySelectorAll('.classpilot-poll-option').forEach(button => {
    button.addEventListener('click', () => {
      const selectedIndex = parseInt(button.dataset.index, 10);
      submitPollResponse(pollId, selectedIndex, button);
    });
  });
}

function submitPollResponse(pollId, selectedIndex, button) {
  if (button.dataset.submitting === 'true') return;
  const actionContext = captureStudentActionContext(activePollTeachingSessionId);
  if (!actionContext || pollId !== activePollId) return;
  button.dataset.submitting = 'true';

  // Visual feedback
  const allButtons = document.querySelectorAll('.classpilot-poll-option');
  allButtons.forEach(btn => {
    btn.disabled = true;
    btn.classList.add('classpilot-poll-disabled');
  });
  button.classList.add('classpilot-poll-selected');

  const body = document.querySelector('.classpilot-poll-body');
  let status = document.getElementById('classpilot-poll-submit-status');
  if (!status && body) {
    status = document.createElement('p');
    status.id = 'classpilot-poll-submit-status';
    status.setAttribute('role', 'status');
    body.appendChild(status);
  }
  if (status) status.textContent = 'Submitting response…';

  // Wait for an actual successful HTTP result. Network/server failure leaves
  // the options enabled for an idempotent retry.
  chrome.runtime.sendMessage({
    type: 'poll-response',
    pollId: pollId,
    selectedOption: selectedIndex,
    ...studentActionAuthorityPayload(actionContext),
  }, (response) => {
    if (!studentActionContextIsCurrent(actionContext) || activePollId !== pollId) return;
    const error = chrome.runtime.lastError?.message || response?.error;
    if (error || !response?.success) {
      button.dataset.submitting = 'false';
      allButtons.forEach(btn => {
        btn.disabled = false;
        btn.classList.remove('classpilot-poll-disabled', 'classpilot-poll-selected');
      });
      if (status) status.textContent = error || 'Could not submit. Choose an answer to retry.';
      return;
    }
    completePollResponse(pollId, selectedIndex);
  });
}

function completePollResponse(pollId, selectedIndex) {
  if (!pollId || (activePollId && activePollId !== pollId)) return;
  respondedPollIds.add(pollId);
  // Show thank you message
  const body = document.querySelector('.classpilot-poll-body');
  const completedEpoch = studentMessageEpoch;
  if (body) {
    const thanksTimeout = setTimeout(() => {
      pollCompletionTimeouts.delete(thanksTimeout);
      if (completedEpoch !== studentMessageEpoch || activePollId !== pollId) return;
      body.innerHTML = `
        <div class="classpilot-poll-thanks">
          <div class="classpilot-poll-thanks-icon">✓</div>
          <p>Response submitted!</p>
        </div>
      `;
    }, 150);
    pollCompletionTimeouts.add(thanksTimeout);
  }

  // Auto-close after 2 seconds
  const closeTimeout = setTimeout(() => {
    pollCompletionTimeouts.delete(closeTimeout);
    if (completedEpoch !== studentMessageEpoch || activePollId !== pollId) return;
    hidePollOverlay();
  }, 2150);
  pollCompletionTimeouts.add(closeTimeout);
}

function hidePollOverlay() {
  clearPollCompletionTimeouts();
  activePollId = null;
  activePollTeachingSessionId = null;
  const overlay = document.getElementById('classpilot-poll-overlay');
  if (overlay) {
    overlay.classList.add('classpilot-poll-out');
    setTimeout(() => overlay.remove(), 300);
  }
}

function addPollStyles() {
  if (document.getElementById('classpilot-poll-styles')) {
    return;
  }

  const style = document.createElement('style');
  style.id = 'classpilot-poll-styles';
  style.textContent = `
    #classpilot-poll-overlay {
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      bottom: 0;
      background: rgba(0, 0, 0, 0.85);
      display: flex;
      align-items: center;
      justify-content: center;
      z-index: 2147483647;
      animation: classpilot-poll-in 0.3s ease-out;
    }

    #classpilot-poll-overlay.classpilot-poll-out {
      animation: classpilot-poll-out-anim 0.3s ease-in forwards;
    }

    @keyframes classpilot-poll-in {
      from { opacity: 0; }
      to { opacity: 1; }
    }

    @keyframes classpilot-poll-out-anim {
      from { opacity: 1; }
      to { opacity: 0; }
    }

    .classpilot-poll-content {
      background: white;
      border-radius: 20px;
      max-width: 500px;
      width: 90%;
      box-shadow: 0 25px 80px rgba(0, 0, 0, 0.5);
      overflow: hidden;
      animation: classpilot-poll-slide 0.3s ease-out;
    }

    @keyframes classpilot-poll-slide {
      from { transform: translateY(30px); opacity: 0; }
      to { transform: translateY(0); opacity: 1; }
    }

    .classpilot-poll-header {
      background: linear-gradient(135deg, #8b5cf6 0%, #6366f1 100%);
      padding: 24px;
      text-align: center;
    }

    .classpilot-poll-icon {
      font-size: 48px;
      margin-bottom: 8px;
    }

    .classpilot-poll-title {
      margin: 0;
      font-size: 24px;
      font-weight: 700;
      color: white;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }

    .classpilot-poll-body {
      padding: 24px;
    }

    .classpilot-poll-question {
      font-size: 20px;
      font-weight: 600;
      color: #1e293b;
      margin: 0 0 20px 0;
      text-align: center;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }

    .classpilot-poll-options {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .classpilot-poll-option {
      display: flex;
      align-items: center;
      gap: 16px;
      padding: 16px 20px;
      border: 2px solid #e2e8f0;
      border-radius: 12px;
      background: white;
      cursor: pointer;
      transition: all 0.2s;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }

    .classpilot-poll-option:hover:not(:disabled) {
      border-color: #8b5cf6;
      background: #faf5ff;
      transform: translateX(4px);
    }

    .classpilot-poll-option.classpilot-poll-selected {
      border-color: #22c55e;
      background: #f0fdf4;
    }

    .classpilot-poll-option.classpilot-poll-disabled {
      cursor: not-allowed;
      opacity: 0.6;
    }

    .classpilot-poll-option-letter {
      width: 36px;
      height: 36px;
      border-radius: 50%;
      background: #f1f5f9;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-size: 16px;
      color: #64748b;
      flex-shrink: 0;
    }

    .classpilot-poll-option.classpilot-poll-selected .classpilot-poll-option-letter {
      background: #22c55e;
      color: white;
    }

    .classpilot-poll-option-text {
      font-size: 16px;
      color: #334155;
      text-align: left;
    }

    .classpilot-poll-thanks {
      text-align: center;
      padding: 40px 20px;
    }

    .classpilot-poll-thanks-icon {
      width: 64px;
      height: 64px;
      border-radius: 50%;
      background: #22c55e;
      color: white;
      font-size: 32px;
      display: flex;
      align-items: center;
      justify-content: center;
      margin: 0 auto 16px;
      animation: classpilot-poll-check 0.5s ease-out;
    }

    @keyframes classpilot-poll-check {
      from { transform: scale(0); }
      to { transform: scale(1); }
    }

    .classpilot-poll-thanks p {
      font-size: 20px;
      font-weight: 600;
      color: #22c55e;
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }
  `;

  document.head.appendChild(style);
}

// ============================================
// CHAT NOTIFICATION OVERLAY
// ============================================

function showChatNotification(message, fromName) {
  // Remove any existing chat notification
  const existing = document.getElementById('classpilot-chat-notification');
  if (existing) {
    existing.remove();
  }

  const notification = document.createElement('div');
  notification.id = 'classpilot-chat-notification';
  notification.innerHTML = `
    <div class="classpilot-chat-notification-content">
      <div class="classpilot-chat-notification-header">
        <span class="classpilot-chat-notification-icon">💬</span>
        <span class="classpilot-chat-notification-from">${escapeHtml(fromName || 'Teacher')}</span>
        <button class="classpilot-chat-notification-close">×</button>
      </div>
      <div class="classpilot-chat-notification-body">
        ${escapeHtml(message)}
      </div>
    </div>
  `;

  addChatNotificationStyles();
  document.body.appendChild(notification);

  // Add close handler
  notification.querySelector('.classpilot-chat-notification-close').addEventListener('click', () => {
    notification.classList.add('classpilot-chat-notification-out');
    setTimeout(() => notification.remove(), 300);
  });

  // Auto-hide after 10 seconds
  setTimeout(() => {
    if (document.getElementById('classpilot-chat-notification')) {
      notification.classList.add('classpilot-chat-notification-out');
      setTimeout(() => notification.remove(), 300);
    }
  }, 10000);
}

function addChatNotificationStyles() {
  if (document.getElementById('classpilot-chat-notification-styles')) {
    return;
  }

  const style = document.createElement('style');
  style.id = 'classpilot-chat-notification-styles';
  style.textContent = `
    #classpilot-chat-notification {
      position: fixed;
      top: 20px;
      right: 20px;
      z-index: 2147483646;
      animation: classpilot-chat-in 0.3s ease-out;
    }

    #classpilot-chat-notification.classpilot-chat-notification-out {
      animation: classpilot-chat-out 0.3s ease-in forwards;
    }

    @keyframes classpilot-chat-in {
      from { opacity: 0; transform: translateX(20px); }
      to { opacity: 1; transform: translateX(0); }
    }

    @keyframes classpilot-chat-out {
      from { opacity: 1; transform: translateX(0); }
      to { opacity: 0; transform: translateX(20px); }
    }

    .classpilot-chat-notification-content {
      background: white;
      border-radius: 12px;
      box-shadow: 0 10px 40px rgba(0,0,0,0.2);
      max-width: 350px;
      overflow: hidden;
      border-left: 4px solid #3b82f6;
    }

    .classpilot-chat-notification-header {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 12px 16px;
      background: #f8fafc;
      border-bottom: 1px solid #e2e8f0;
    }

    .classpilot-chat-notification-icon {
      font-size: 20px;
    }

    .classpilot-chat-notification-from {
      font-weight: 600;
      color: #1e293b;
      flex: 1;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }

    .classpilot-chat-notification-close {
      background: none;
      border: none;
      font-size: 24px;
      color: #94a3b8;
      cursor: pointer;
      padding: 0;
      line-height: 1;
    }

    .classpilot-chat-notification-close:hover {
      color: #64748b;
    }

    .classpilot-chat-notification-body {
      padding: 16px;
      font-size: 15px;
      color: #334155;
      line-height: 1.5;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      white-space: pre-wrap;
    }
  `;

  document.head.appendChild(style);
}

// ============================================
// FLOATING ACTION BUTTON (FAB)
// ============================================

let fabExpanded = false;
let handRaised = false;
let messagingEnabled = true;
let handRaisingEnabled = true;
let chatMessages = []; // { sender: 'student'|'teacher', text: string, time: number }
let chatClosed = false; // Set when teacher closes chat — prevents re-opening old conversation
const FAB_CHAT_MESSAGES_KEY = 'fabChatMessages';
const FAB_CHAT_CLOSED_KEY = 'fabChatClosed';
const FAB_STATE_KEY = 'fabStateV1';
const FAB_CONTEXT_KEY = 'fabContextV1';
const FAB_CHAT_CONTEXT_KEY = 'fabChatContextV1';
let currentFabContext = null;

const FAB_STORAGE_KEYS = [
  'handRaised',
  'messagingEnabled',
  'handRaisingEnabled',
  FAB_CHAT_MESSAGES_KEY,
  FAB_CHAT_CLOSED_KEY,
  FAB_STATE_KEY,
  FAB_CONTEXT_KEY,
  FAB_CHAT_CONTEXT_KEY,
];

function readFabStorageForCurrentContext(apply) {
  const expectedEpoch = studentMessageEpoch;
  chrome.runtime.sendMessage({ type: 'get-student-message-context' }, (contextResponse) => {
    if (
      expectedEpoch !== studentMessageEpoch
      || chrome.runtime.lastError
      || contextResponse?.success !== true
      || !contextResponse.studentMessageContext?.authContextId
    ) return;
    const expectedContext = contextResponse.studentMessageContext;
    const expectedFabBinding = contextResponse.fabBinding || null;
    chrome.runtime.sendMessage({
      type: 'get-student-session-ui-state',
      studentMessageContext: expectedContext,
    }, (stateResponse) => {
      if (
        expectedEpoch !== studentMessageEpoch
        || chrome.runtime.lastError
        || stateResponse?.success !== true
        || (stateResponse.fabBinding || null) !== expectedFabBinding
      ) return;
      currentStudentMessageContext = { ...expectedContext };
      currentFabAuthorityBinding = expectedFabBinding;
      apply(stateResponse.stored || {}, expectedFabBinding);
    });
  });
}

function hydrateFabStateFromStorage(stored, expectedFabBinding) {
  const storedFabContext = stored[FAB_CONTEXT_KEY] || null;
  const storedChatContext = stored[FAB_CHAT_CONTEXT_KEY] || null;
  const fabStateCurrent = !stored[FAB_STATE_KEY]
    || Boolean(expectedFabBinding && storedFabContext?.binding === expectedFabBinding);
  const chatStateCurrent = !(
    (Array.isArray(stored[FAB_CHAT_MESSAGES_KEY]) && stored[FAB_CHAT_MESSAGES_KEY].length > 0)
    || stored[FAB_CHAT_CLOSED_KEY] === true
  ) || Boolean(expectedFabBinding && storedChatContext?.binding === expectedFabBinding);
  if (!fabStateCurrent || !chatStateCurrent) {
    handRaised = false;
    messagingEnabled = false;
    handRaisingEnabled = false;
    chatMessages = [];
    chatClosed = true;
    currentFabContext = null;
  } else {
    handRaised = stored.handRaised === true;
    messagingEnabled = stored.messagingEnabled !== false;
    handRaisingEnabled = stored.handRaisingEnabled !== false;
    chatMessages = Array.isArray(stored[FAB_CHAT_MESSAGES_KEY])
      ? stored[FAB_CHAT_MESSAGES_KEY]
      : [];
    chatClosed = stored[FAB_CHAT_CLOSED_KEY] === true;
    currentFabContext = storedChatContext || storedFabContext || null;
    if (stored[FAB_STATE_KEY]) {
      applyFabState({ ...stored[FAB_STATE_KEY], context: storedFabContext });
    }
  }
  updateFabHandState();
  updateFabMessageState();
  updateFabChatControls();
  updateFabIdentityState();
  renderChatMessages();
  if (!messagingEnabled || chatClosed) hideMessageBox();
}

function persistFabChatState() {
  const actionContext = captureStudentActionContext();
  if (!actionContext) return;
  chrome.runtime.sendMessage({
    type: 'persist-fab-chat-state',
    messages: chatMessages.slice(-50),
    chatClosed,
    ...studentActionAuthorityPayload(actionContext),
  }, () => {
    // Durable state is advisory UI history but identity-bound. The worker owns
    // the serialized write and rejects a callback delivered after transition.
    void chrome.runtime.lastError;
  });
}

function updateFabChatControls() {
  const input = document.getElementById('classpilot-fab-chat-input');
  const sendButton = document.getElementById('classpilot-fab-chat-send-btn');
  if (input) input.disabled = !messagingEnabled;
  if (sendButton) sendButton.disabled = !messagingEnabled;
}

function applyFabState(state = {}) {
  const reason = state.reason || '';
  const wasMessagingEnabled = messagingEnabled;
  const priorContext = currentFabContext;
  const nextContext = state.context || priorContext;
  const priorSessions = [...new Set(priorContext?.activeSessionIds || [])].sort();
  const nextSessions = [...new Set(
    nextContext?.activeSessionIds || state.activeSessionIds ||
    (state.teachingSessionId ? [state.teachingSessionId] : [])
  )].sort();
  const bindingChanged = Boolean(priorContext?.binding && nextContext?.binding
    && priorContext.binding !== nextContext.binding);
  const sessionSetChanged = Boolean(priorContext)
    && JSON.stringify(priorSessions) !== JSON.stringify(nextSessions);
  const sessionEnded = reason === 'session-ended'
    || (Boolean(nextContext) && nextSessions.length === 0);

  if (
    priorContext?.binding === nextContext?.binding &&
    !sessionSetChanged &&
    Number(state.revision || 0) > 0 &&
    Number(priorContext?.revision || 0) > Number(state.revision || 0)
  ) {
    return;
  }
  if (nextContext) {
    currentFabContext = {
      ...nextContext,
      activeSessionIds: nextSessions,
      revision: Number(state.revision ?? nextContext.revision ?? 0),
      lifecycleRevision: Number(state.lifecycleRevision ?? nextContext.lifecycleRevision ?? 0),
    };
  }

  if (typeof state.messagingEnabled === 'boolean') {
    messagingEnabled = state.messagingEnabled;
  }
  if (typeof state.handRaisingEnabled === 'boolean') {
    handRaisingEnabled = state.handRaisingEnabled;
  }
  if (typeof state.handRaised === 'boolean') {
    handRaised = state.handRaised;
  }

  if (bindingChanged || sessionSetChanged) {
    respondedPollIds.clear();
    chatMessages = [];
    chatClosed = sessionEnded;
    persistFabChatState();
    renderChatMessages();
  } else if (sessionEnded && (chatMessages.length > 0 || !chatClosed)) {
    chatMessages = [];
    chatClosed = true;
    persistFabChatState();
    renderChatMessages();
  } else if (messagingEnabled && (!wasMessagingEnabled || reason === 'messaging-toggle')) {
    chatClosed = false;
    persistFabChatState();
    renderChatMessages();
  }

  if (!messagingEnabled || sessionEnded) {
    hideMessageBox();
    closeFabMenu();
  }

  updateFabHandState();
  updateFabMessageState();
  updateFabChatControls();
}

function createFloatingActionButton() {
  // Don't create FAB on extension pages or special pages
  if (window.location.protocol === 'chrome-extension:' ||
      window.location.protocol === 'chrome:' ||
      window.location.protocol === 'about:') {
    return;
  }

  // Remove existing FAB if present
  const existing = document.getElementById('classpilot-fab-container');
  if (existing) {
    existing.remove();
  }

  // PassPilot kiosk pages: keep only the monitoring disclosure — no student
  // controls (message / raise hand / sign out) on a shared hall-pass kiosk.
  const kioskSuppressed = isPassPilotKioskPage();

  const fabContainer = document.createElement('div');
  fabContainer.id = 'classpilot-fab-container';
  if (kioskSuppressed) {
    fabContainer.innerHTML = `
      <div class="classpilot-monitoring-indicator" title="ClassPilot is active. Your school can see active tab titles, URLs, timestamps, and periodic screen thumbnails.">
        <span class="classpilot-monitoring-dot" aria-hidden="true"></span>
        <span>Monitored by school</span>
      </div>
    `;
    addFabStyles();
    document.body.appendChild(fabContainer);
    return;
  }
  fabContainer.innerHTML = `
    <div class="classpilot-monitoring-indicator" title="ClassPilot is active. Your school can see active tab titles, URLs, timestamps, and periodic screen thumbnails.">
      <span class="classpilot-monitoring-dot" aria-hidden="true"></span>
      <span>Monitored by school</span>
    </div>
    <div class="classpilot-fab-menu" id="classpilot-fab-menu">
      <div class="classpilot-fab-identity" id="classpilot-fab-identity" style="display:none;">
        <span class="classpilot-fab-identity-kicker">Monitoring as</span>
        <span class="classpilot-fab-identity-name" id="classpilot-fab-identity-name"></span>
      </div>
      <button class="classpilot-fab-item classpilot-fab-message" id="classpilot-fab-message" title="Message Teacher">
        <span class="classpilot-fab-icon">💬</span>
        <span class="classpilot-fab-label">Message</span>
      </button>
      <button class="classpilot-fab-item classpilot-fab-hand" id="classpilot-fab-hand" title="Raise Hand">
        <span class="classpilot-fab-icon">✋</span>
        <span class="classpilot-fab-label">Raise Hand</span>
      </button>
      <button class="classpilot-fab-item classpilot-fab-signout" id="classpilot-fab-signout" title="Log out">
        <span class="classpilot-fab-icon">⎋</span>
        <span class="classpilot-fab-label">Log out</span>
      </button>
    </div>
    <button class="classpilot-fab-main" id="classpilot-fab-main" title="ClassPilot">
      <span class="classpilot-fab-main-icon">🎓</span>
    </button>
    <div class="classpilot-fab-message-box" id="classpilot-fab-message-box">
      <div class="classpilot-fab-message-header">
        <span>💬 Chat with Teacher</span>
        <button class="classpilot-fab-message-close" id="classpilot-fab-message-close">×</button>
      </div>
      <div class="classpilot-fab-chat-messages" id="classpilot-fab-chat-messages"></div>
      <div class="classpilot-fab-chat-input-area">
        <input type="text" class="classpilot-fab-chat-input" id="classpilot-fab-chat-input" placeholder="Type a message..." />
        <button class="classpilot-fab-chat-send-btn" id="classpilot-fab-chat-send-btn">➤</button>
      </div>
    </div>
  `;

  addFabStyles();
  document.body.appendChild(fabContainer);

  // Get initial state
  readFabStorageForCurrentContext(hydrateFabStateFromStorage);

  // Main FAB click - toggle menu
  document.getElementById('classpilot-fab-main').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleFabMenu();
  });

  // Raise Hand button
  document.getElementById('classpilot-fab-hand').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!handRaisingEnabled) {
      showFabNotification('Hand raising is currently disabled by your teacher.', true);
      return;
    }
    if (handRaised) {
      lowerHand();
    } else {
      raiseHand();
    }
  });

  // Message button - show message box
  document.getElementById('classpilot-fab-message').addEventListener('click', (e) => {
    e.stopPropagation();
    if (!messagingEnabled) {
      showFabNotification('Messaging is currently disabled by your teacher.', true);
      return;
    }
    // If teacher closed the previous chat, start fresh
    if (chatClosed) {
      chatClosed = false;
      chatMessages = [];
      persistFabChatState();
    }
    showMessageBox();
  });

  document.getElementById('classpilot-fab-signout').addEventListener('click', (e) => {
    e.stopPropagation();
    signOutStudent();
  });

  // Close message box
  document.getElementById('classpilot-fab-message-close').addEventListener('click', (e) => {
    e.stopPropagation();
    hideMessageBox();
  });

  // Send message via button click
  document.getElementById('classpilot-fab-chat-send-btn').addEventListener('click', () => {
    sendMessage();
  });

  // Send message via Enter key
  document.getElementById('classpilot-fab-chat-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // Prevent clicks on message box from closing it
  document.getElementById('classpilot-fab-message-box').addEventListener('click', (e) => {
    e.stopPropagation();
  });

  // Close menu when clicking outside (but keep chat open)
  document.addEventListener('click', (e) => {
    if (!fabContainer.contains(e.target)) {
      closeFabMenu();
    }
  });
}

function toggleFabMenu() {
  const menu = document.getElementById('classpilot-fab-menu');
  const main = document.getElementById('classpilot-fab-main');
  fabExpanded = !fabExpanded;

  if (fabExpanded) {
    menu.classList.add('classpilot-fab-menu-open');
    main.classList.add('classpilot-fab-main-active');
    updateFabIdentityState();
  } else {
    menu.classList.remove('classpilot-fab-menu-open');
    main.classList.remove('classpilot-fab-main-active');
  }
}

function closeFabMenu() {
  const menu = document.getElementById('classpilot-fab-menu');
  const main = document.getElementById('classpilot-fab-main');
  fabExpanded = false;
  menu?.classList.remove('classpilot-fab-menu-open');
  main?.classList.remove('classpilot-fab-main-active');
}

function showMessageBox() {
  if (!messagingEnabled) {
    showFabNotification('Messaging is currently disabled by your teacher.', true);
    return;
  }
  const messageBox = document.getElementById('classpilot-fab-message-box');
  messageBox?.classList.add('classpilot-fab-message-box-open');
  renderChatMessages();
  updateFabChatControls();
  document.getElementById('classpilot-fab-chat-input')?.focus();
}

function hideMessageBox() {
  const messageBox = document.getElementById('classpilot-fab-message-box');
  messageBox?.classList.remove('classpilot-fab-message-box-open');
}

function raiseHand() {
  const actionContext = captureStudentActionContext();
  if (!actionContext) {
    showFabNotification('No active class session for hand raising.', true);
    return;
  }
  try {
    chrome.runtime.sendMessage({
      type: 'raise-hand',
      ...studentActionAuthorityPayload(actionContext),
    }, (response) => {
      if (!studentActionContextIsCurrent(actionContext)) return;
      if (chrome.runtime.lastError) {
        showFabNotification('Extension updated — please refresh the page.', true);
        return;
      }
      if (response?.success) {
        handRaised = true;
        updateFabHandState();
        showFabNotification('✋ Hand raised! Your teacher has been notified.');
        closeFabMenu();
      } else {
        showFabNotification('Could not raise hand. Please try again.', true);
      }
    });
  } catch (e) {
    showFabNotification('Extension updated — please refresh the page.', true);
  }
}

function lowerHand() {
  const actionContext = captureStudentActionContext();
  if (!actionContext) return;
  try {
    chrome.runtime.sendMessage({
      type: 'lower-hand',
      ...studentActionAuthorityPayload(actionContext),
    }, (response) => {
      if (!studentActionContextIsCurrent(actionContext)) return;
      if (chrome.runtime.lastError) {
        showFabNotification('Extension updated — please refresh the page.', true);
        return;
      }
      if (response?.success) {
        handRaised = false;
        updateFabHandState();
        showFabNotification('Hand lowered.');
        closeFabMenu();
      }
    });
  } catch (e) {
    showFabNotification('Extension updated — please refresh the page.', true);
  }
}

function updateFabHandState() {
  const handBtn = document.getElementById('classpilot-fab-hand');
  const label = handBtn?.querySelector('.classpilot-fab-label');

  // Handle disabled state
  if (!handRaisingEnabled) {
    handBtn?.classList.add('classpilot-fab-disabled');
    handBtn?.classList.remove('classpilot-fab-hand-raised');
    if (label) label.textContent = 'Unavailable';
    return;
  }

  handBtn?.classList.remove('classpilot-fab-disabled');

  if (handRaised) {
    handBtn?.classList.add('classpilot-fab-hand-raised');
    if (label) label.textContent = 'Lower Hand';
  } else {
    handBtn?.classList.remove('classpilot-fab-hand-raised');
    if (label) label.textContent = 'Raise Hand';
  }
}

function updateFabMessageState() {
  const messageBtn = document.getElementById('classpilot-fab-message');
  const label = messageBtn?.querySelector('.classpilot-fab-label');

  if (!messagingEnabled) {
    messageBtn?.classList.add('classpilot-fab-disabled');
    if (label) label.textContent = 'Unavailable';
  } else {
    messageBtn?.classList.remove('classpilot-fab-disabled');
    if (label) label.textContent = 'Message';
  }
}

function updateFabIdentityState(state) {
  const identity = document.getElementById('classpilot-fab-identity');
  const nameEl = document.getElementById('classpilot-fab-identity-name');
  if (!identity || !nameEl) return;

  const applyState = (nextState) => {
    const authRequired = nextState?.authRequired === true;
    const name =
      nextState?.studentName ||
      nextState?.studentEmail ||
      '';
    if (!authRequired && name) {
      nameEl.textContent = name;
      identity.style.display = 'grid';
    } else {
      nameEl.textContent = '';
      identity.style.display = 'none';
    }
  };

  if (state) {
    applyState(state);
    return;
  }

  const requestGeneration = authGateStateRequestGeneration;
  chrome.runtime.sendMessage({ type: 'get-auth-state' }, (response) => {
    if (requestGeneration !== authGateStateRequestGeneration ||
        isAuthGateManagedPolicyFencePending() || chrome.runtime.lastError || !response?.success) {
      identity.style.display = 'none';
      return;
    }
    applyState(response.state);
  });
}

function sendMessage() {
  const input = document.getElementById('classpilot-fab-chat-input');
  const message = input?.value?.trim();

  if (!messagingEnabled) {
    showFabNotification('Messaging is currently disabled by your teacher.', true);
    return;
  }

  if (!message) {
    return;
  }

  const actionContext = captureStudentActionContext();
  if (!actionContext) {
    showFabNotification('No active class session for messaging.', true);
    return;
  }

  const clientMessageId = globalThis.crypto?.randomUUID?.()
    || `chat-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  chatMessages.push({
    id: clientMessageId,
    clientMessageId,
    sender: 'student',
    text: message,
    time: Date.now(),
    status: 'Sending',
  });
  persistFabChatState();
  input.value = '';
  renderChatMessages();

  // Keep this compose box serialized until the worker has durably queued the
  // message. A network response is not required for the user to keep working.
  input.disabled = true;

  try {
    chrome.runtime.sendMessage({
      type: 'send-student-message',
      clientMessageId,
      message: message,
      messageType: 'message',
      ...studentActionAuthorityPayload(actionContext),
    }, (response) => {
      if (!studentActionContextIsCurrent(actionContext)) return;
      const optimistic = chatMessages.find((item) => item.clientMessageId === clientMessageId);
      if (chrome.runtime.lastError) {
        input.disabled = false;
        if (optimistic) optimistic.status = 'Failed';
        persistFabChatState();
        renderChatMessages();
        showFabNotification('Extension updated — please refresh the page.', true);
        return;
      }
      input.disabled = false;
      if (response?.success) {
        if (optimistic) {
          optimistic.id = response.messageId || optimistic.id;
          optimistic.status = response.status || (response.queued ? 'Retrying' : 'Delivered');
        }
        persistFabChatState();
        renderChatMessages();
        input.focus();
      } else {
        if (optimistic) optimistic.status = 'Failed';
        persistFabChatState();
        renderChatMessages();
        showFabNotification('Could not send message. Please try again.', true);
      }
    });
  } catch (e) {
    input.disabled = false;
    const optimistic = chatMessages.find((item) => item.clientMessageId === clientMessageId);
    if (optimistic) optimistic.status = 'Failed';
    persistFabChatState();
    renderChatMessages();
    showFabNotification('Extension updated — please refresh the page.', true);
  }
}

function renderChatMessages() {
  const container = document.getElementById('classpilot-fab-chat-messages');
  if (!container) return;

  if (chatMessages.length === 0) {
    container.innerHTML = '<div class="classpilot-chat-empty">Send a message to your teacher</div>';
    return;
  }

  container.innerHTML = chatMessages.map(msg => {
    const isStudent = msg.sender === 'student';
    const bubbleClass = isStudent ? 'classpilot-chat-bubble-student' : 'classpilot-chat-bubble-teacher';
    const text = msg.text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const deliveryStatus = isStudent && ['Sending', 'Retrying', 'Delivered', 'Failed'].includes(msg.status)
      ? `<span class="classpilot-chat-delivery-status">${msg.status}</span>`
      : '';
    return `<div class="classpilot-chat-bubble ${bubbleClass}">${text}${deliveryStatus}</div>`;
  }).join('');

  container.scrollTop = container.scrollHeight;
}

function showFabNotification(message, isError = false) {
  // Remove existing notification
  const existing = document.getElementById('classpilot-fab-notification');
  if (existing) existing.remove();

  const notification = document.createElement('div');
  notification.id = 'classpilot-fab-notification';
  notification.className = isError ? 'classpilot-fab-notification-error' : '';
  notification.textContent = message;
  document.body.appendChild(notification);

  setTimeout(() => {
    notification.classList.add('classpilot-fab-notification-out');
    setTimeout(() => notification.remove(), 300);
  }, 3000);
}

function addFabStyles() {
  if (document.getElementById('classpilot-fab-styles')) {
    return;
  }

  const style = document.createElement('style');
  style.id = 'classpilot-fab-styles';
  style.textContent = `
    #classpilot-fab-container {
      position: fixed;
      bottom: 20px;
      right: 20px;
      z-index: 2147483640;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }

    .classpilot-fab-main {
      width: 56px;
      height: 56px;
      border-radius: 50%;
      background: #E9A31E;
      border: none;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      box-shadow: 0 4px 20px rgba(233, 163, 30, 0.4);
      transition: all 0.3s ease;
    }

    .classpilot-monitoring-indicator {
      position: absolute;
      right: 0;
      bottom: 66px;
      display: flex;
      align-items: center;
      gap: 7px;
      min-width: 176px;
      padding: 8px 11px;
      border-radius: 999px;
      background: #0f172a;
      color: #ffffff;
      box-shadow: 0 4px 18px rgba(15, 23, 42, 0.22);
      font-size: 12px;
      font-weight: 700;
      letter-spacing: 0;
      white-space: nowrap;
    }

    .classpilot-monitoring-dot {
      width: 8px;
      height: 8px;
      border-radius: 50%;
      background: #22c55e;
      box-shadow: 0 0 0 4px rgba(34, 197, 94, 0.18);
      flex: 0 0 auto;
    }

    .classpilot-fab-main:hover {
      transform: scale(1.1);
      box-shadow: 0 6px 25px rgba(233, 163, 30, 0.5);
    }

    .classpilot-fab-main.classpilot-fab-main-active {
      transform: rotate(45deg);
      background: linear-gradient(135deg, #64748b 0%, #475569 100%);
    }

    .classpilot-fab-main-icon {
      font-size: 24px;
      transition: transform 0.3s ease;
    }

    .classpilot-fab-main.classpilot-fab-main-active .classpilot-fab-main-icon {
      transform: rotate(-45deg);
    }

    .classpilot-fab-menu {
      position: absolute;
      bottom: 104px;
      right: 0;
      display: flex;
      flex-direction: column;
      gap: 12px;
      opacity: 0;
      visibility: hidden;
      transform: translateY(20px);
      transition: all 0.3s ease;
    }

    .classpilot-fab-menu.classpilot-fab-menu-open {
      opacity: 1;
      visibility: visible;
      transform: translateY(0);
    }

    .classpilot-fab-identity {
      min-width: 220px;
      max-width: 280px;
      padding: 12px 14px;
      background: #0f172a;
      color: white;
      border-radius: 18px;
      box-shadow: 0 4px 15px rgba(0, 0, 0, 0.18);
      gap: 2px;
      justify-items: end;
    }

    .classpilot-fab-identity-kicker {
      font-size: 11px;
      font-weight: 700;
      color: #cbd5e1;
      text-transform: uppercase;
      letter-spacing: 0;
    }

    .classpilot-fab-identity-name {
      max-width: 252px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
      font-size: 14px;
      font-weight: 700;
      color: #ffffff;
    }

    .classpilot-fab-item {
      display: flex;
      align-items: center;
      gap: 10px;
      padding: 12px 16px;
      background: white;
      border: none;
      border-radius: 28px;
      cursor: pointer;
      box-shadow: 0 4px 15px rgba(0, 0, 0, 0.15);
      transition: all 0.2s ease;
      white-space: nowrap;
    }

    .classpilot-fab-item:hover {
      transform: translateX(-5px);
      box-shadow: 0 6px 20px rgba(0, 0, 0, 0.2);
    }

    .classpilot-fab-hand {
      background: linear-gradient(135deg, #fef3c7 0%, #fde68a 100%);
    }

    .classpilot-fab-hand.classpilot-fab-hand-raised {
      background: linear-gradient(135deg, #fca5a5 0%, #f87171 100%);
    }

    .classpilot-fab-message {
      background: linear-gradient(135deg, #dbeafe 0%, #bfdbfe 100%);
    }

    .classpilot-fab-signout {
      background: linear-gradient(135deg, #fee2e2 0%, #fecaca 100%);
    }

    .classpilot-fab-disabled {
      background: linear-gradient(135deg, #e5e7eb 0%, #d1d5db 100%) !important;
      opacity: 0.6;
      cursor: not-allowed;
    }

    .classpilot-fab-disabled .classpilot-fab-label {
      color: #6b7280 !important;
    }

    .classpilot-fab-disabled:hover {
      transform: none !important;
      box-shadow: 0 4px 15px rgba(0, 0, 0, 0.1) !important;
    }

    .classpilot-fab-icon {
      font-size: 20px;
    }

    .classpilot-fab-label {
      font-size: 14px;
      font-weight: 600;
      color: #1e293b;
    }

    .classpilot-fab-message-box {
      position: absolute;
      bottom: 70px;
      right: 0;
      width: 320px;
      height: 400px;
      background: white;
      border-radius: 16px;
      box-shadow: 0 10px 40px rgba(0, 0, 0, 0.2);
      opacity: 0;
      visibility: hidden;
      transform: translateY(20px) scale(0.95);
      transition: all 0.3s ease;
      overflow: hidden;
      display: flex;
      flex-direction: column;
    }

    .classpilot-fab-message-box.classpilot-fab-message-box-open {
      opacity: 1;
      visibility: visible;
      transform: translateY(0) scale(1);
    }

    .classpilot-fab-message-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 12px 16px;
      background: linear-gradient(135deg, #3b82f6 0%, #2563eb 100%);
      color: white;
      font-weight: 600;
      font-size: 14px;
      flex-shrink: 0;
    }

    .classpilot-fab-message-close {
      background: none;
      border: none;
      color: white;
      font-size: 24px;
      cursor: pointer;
      padding: 0;
      line-height: 1;
      opacity: 0.8;
    }

    .classpilot-fab-message-close:hover {
      opacity: 1;
    }

    .classpilot-fab-chat-messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      background: #f8fafc;
    }

    .classpilot-chat-empty {
      text-align: center;
      color: #94a3b8;
      font-size: 13px;
      padding: 40px 16px;
    }

    .classpilot-chat-bubble {
      max-width: 80%;
      padding: 8px 12px;
      border-radius: 12px;
      font-size: 13px;
      line-height: 1.4;
      word-wrap: break-word;
    }

    .classpilot-chat-bubble-student {
      align-self: flex-end;
      background: #3b82f6;
      color: white;
      border-bottom-right-radius: 4px;
    }

    .classpilot-chat-delivery-status {
      display: block;
      margin-top: 3px;
      font-size: 10px;
      line-height: 1.2;
      opacity: 0.82;
      text-align: right;
    }

    .classpilot-chat-bubble-teacher {
      align-self: flex-start;
      background: #10b981;
      color: white;
      border-bottom-left-radius: 4px;
    }

    .classpilot-fab-chat-input-area {
      display: flex;
      gap: 8px;
      padding: 10px 12px;
      border-top: 1px solid #e2e8f0;
      background: white;
      flex-shrink: 0;
    }

    .classpilot-fab-chat-input {
      flex: 1;
      padding: 8px 12px;
      border: 1px solid #e2e8f0;
      border-radius: 20px;
      font-size: 13px;
      font-family: inherit;
      outline: none;
      box-sizing: border-box;
    }

    .classpilot-fab-chat-input:focus {
      border-color: #3b82f6;
    }

    .classpilot-fab-chat-send-btn {
      width: 36px;
      height: 36px;
      border: none;
      border-radius: 50%;
      background: #3b82f6;
      color: white;
      font-size: 16px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: background 0.2s;
    }

    .classpilot-fab-chat-send-btn:hover {
      background: #2563eb;
    }

    #classpilot-fab-notification {
      position: fixed;
      bottom: 90px;
      right: 20px;
      background: #1e293b;
      color: white;
      padding: 12px 20px;
      border-radius: 8px;
      font-size: 14px;
      font-weight: 500;
      box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
      z-index: 2147483641;
      animation: classpilot-fab-notif-in 0.3s ease-out;
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
    }

    #classpilot-fab-notification.classpilot-fab-notification-error {
      background: #dc2626;
    }

    #classpilot-fab-notification.classpilot-fab-notification-out {
      animation: classpilot-fab-notif-out 0.3s ease-in forwards;
    }

    @keyframes classpilot-fab-notif-in {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }

    @keyframes classpilot-fab-notif-out {
      from { opacity: 1; transform: translateY(0); }
      to { opacity: 0; transform: translateY(10px); }
    }
  `;

  document.head.appendChild(style);
}

// Listen for storage changes to update FAB state
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'managed' && [
    'fastAuthGateEnabled',
    'serverUrl',
    'classpilotServerUrl',
    'schoolSlug',
    'classpilotSchoolSlug',
    'schoolId',
    'classpilotSchoolId',
    'enrollmentKey',
    'classpilotEnrollmentKey',
  ].some((key) => Object.prototype.hasOwnProperty.call(changes, key))) {
    beginAuthGateManagedPolicyFence();
  }
  if (namespace === 'local' || namespace === 'session') {
    const fabStateChanged = FAB_STORAGE_KEYS.some((key) => (
      Object.prototype.hasOwnProperty.call(changes, key)
    ));
    if (fabStateChanged) {
      readFabStorageForCurrentContext(hydrateFabStateFromStorage);
    }
  }
  if ((namespace === 'local' || namespace === 'session') &&
      (changes.studentToken || changes.studentEmail || changes.studentName || changes.activeStudentId)) {
    updateFabIdentityState();
  }
});

window.addEventListener('focus', () => {
  refreshVisibleAuthGateRoster();
  reconcileAuthGatePresenceSignal();
});
window.addEventListener('pageshow', () => {
  refreshVisibleAuthGateRoster();
  reconcileAuthGatePresenceSignal();
});
window.addEventListener('online', () => {
  refreshVisibleAuthGateRoster();
  reconcileAuthGatePresenceSignal();
});
window.addEventListener('pagehide', stopAuthGatePresenceSignal);
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    clearAuthGateRosterRefreshTimer();
    stopAuthGatePresenceSignal();
    return;
  }
  refreshVisibleAuthGateRoster();
  reconcileAuthGatePresenceSignal();
});

// Initialize FAB when DOM is ready
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => {
    createFloatingActionButton();
    requestAuthGateState();
    requestClassroomOverlayState();
  });
} else {
  createFloatingActionButton();
  requestAuthGateState();
  requestClassroomOverlayState();
}

async function signOutStudent() {
  closeFabMenu();
  hideMessageBox();
  const requestEpoch = studentMessageEpoch;
  const contextResponse = await new Promise((resolve) => {
    chrome.runtime.sendMessage({ type: 'get-student-message-context' }, (response) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(response || null);
    });
  });
  const studentMessageContext = contextResponse?.success === true
    ? contextResponse.studentMessageContext
    : null;
  if (
    requestEpoch !== studentMessageEpoch
    || !studentMessageContext?.authContextId
  ) {
    showFabNotification('The signed-in student changed. Please try again.', true);
    return;
  }
  chrome.runtime.sendMessage({
    type: 'student-sign-out',
    studentMessageContext: { ...studentMessageContext },
  }, (response) => {
    if (requestEpoch !== studentMessageEpoch) return;
    if (chrome.runtime.lastError || !response?.success) {
      showFabNotification(response?.error || 'Could not sign out. Please try again.', true);
      return;
    }
    showFabNotification('Signed out.');
    requestAuthGateState();
  });
}

console.log('ClassPilot content script loaded');

} // End of double-injection guard
