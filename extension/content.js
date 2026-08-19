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
let activePollId = null;
const respondedPollIds = new Set(); // prevent re-showing polls already answered
const seenChatMsgIds = new Set(); // dedup chat-reply messages
let authGateActive = false;
let authGateBlockerInstalled = false;

// Listen for messages from service worker
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender?.id && sender.id !== chrome.runtime.id) {
    sendResponse?.({ success: false, error: 'Invalid sender' });
    return false;
  }

  if (message.type === 'CLASSPILOT_AUTH_REQUIRED') {
    showAuthGate(message.state || {});
    sendResponse?.({ success: true });
    return false;
  }

  if (message.type === 'CLASSPILOT_AUTH_COMPLETE') {
    removeAuthGate();
    updateFabIdentityState();
    sendResponse?.({ success: true });
    return false;
  }

  if (message.type === 'student-message-state-cleared') {
    seenChatMsgIds.clear();
    respondedPollIds.clear();
    chatMessages = [];
    chatClosed = false;
    persistFabChatState();
    document.getElementById('classpilot-message-modal')?.remove();
    renderChatMessages();
    hideMessageBox();
    sendResponse?.({ success: true });
    return false;
  }

  if (message.type === 'show-message') {
    // Broadcast messages (not replies) still show as modal
    if (!message.data.isTeacherReply) {
      showMessageModal(message.data);
    }
  }

  // Teacher reply — add to chat thread (ignore if teacher already closed the chat)
  if (message.type === 'chat-reply' && !chatClosed) {
    const activeFabSessions = currentFabContext?.activeSessionIds || [];
    if (message.data?.sessionId && activeFabSessions.length > 0
        && !activeFabSessions.includes(message.data.sessionId)) {
      return;
    }
    // Dedup: skip if we've already processed this exact message
    const msgId = message.data?._msgId;
    if (msgId) {
      if (seenChatMsgIds.has(msgId)) {
        console.log('[ClassPilot] Dedup: skipping duplicate chat-reply', msgId);
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
    if (!chatBox?.classList.contains('classpilot-fab-message-box-open')) {
      showMessageBox();
    }
    renderChatMessages();
  }

  // Teacher closed the chat — only act if chat is active (dedup replays)
  if (message.type === 'chat-closed' && !chatClosed) {
    chatMessages = [];
    chatClosed = true;
    persistFabChatState();
    renderChatMessages();
    hideMessageBox();
    closeFabMenu();
    showFabNotification('Teacher ended the chat.');
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
    showLicenseBanner(message.planStatus);
  }

  if (message.type === 'CLASSPILOT_LICENSE_ACTIVE') {
    removeLicenseBanner();
  }

  // Attention Mode handlers
  if (message.type === 'attention-mode') {
    if (message.data.active) {
      showAttentionOverlay(message.data.message || 'Please look up!');
    } else {
      hideAttentionOverlay();
    }
  }

  // Timer handlers
  if (message.type === 'timer') {
    if (message.data.action === 'start') {
      startTimerOverlay(message.data.seconds, message.data.message, message.data.endsAt);
    } else if (message.data.action === 'stop') {
      stopTimerOverlay();
    }
  }

  // Poll handlers
  if (message.type === 'poll') {
    if (message.data.action === 'start') {
      showPollOverlay(message.data.pollId, message.data.question, message.data.options);
    } else if (message.data.action === 'close') {
      hidePollOverlay();
    }
  }

  if (message.type === 'poll-response-succeeded') {
    completePollResponse(message.data?.pollId, message.data?.selectedOption);
  }

  // Chat message notification
  if (message.type === 'chat-notification') {
    showChatNotification(message.data.message, message.data.fromName);
  }

  // Hand dismissed notification — only show if hand was actually raised (dedup replays)
  if (message.type === 'hand-dismissed' && handRaised) {
    chrome.storage.local.set({ handRaised: false });
    showChatNotification('Your teacher acknowledged your raised hand.', 'Teacher');
  }

  // Messaging toggle (enable/disable messaging)
  if (message.type === 'messaging-toggle') {
    applyFabState({ messagingEnabled: message.data.enabled, reason: 'messaging-toggle' });
  }

  // Complete FAB state pushed when a class session starts/ends.
  if (message.type === 'fab-state') {
    applyFabState(message.data || {});
  }
});

function requestAuthGateState() {
  chrome.runtime.sendMessage({ type: 'get-auth-state' }, (response) => {
    if (chrome.runtime.lastError) return;
    if (response?.state?.authRequired) {
      showAuthGate(response.state);
    } else {
      removeAuthGate();
    }
    updateFabIdentityState(response?.state);
  });
}

function requestClassroomOverlayState() {
  chrome.runtime.sendMessage({ type: 'get-classroom-overlay-state' }, (response) => {
    if (chrome.runtime.lastError || !response?.success) return;
    const attention = response.classroomState?.restrictions?.attentionMode;
    if (attention?.active) {
      showAttentionOverlay(attention.message || 'Please look up!');
    } else {
      hideAttentionOverlay();
    }
    const timer = response.overlays?.timer;
    if (timer?.endsAt > Date.now()) {
      startTimerOverlay(null, timer.message, timer.endsAt);
    } else {
      stopTimerOverlay();
    }
    const poll = response.overlays?.poll;
    if (poll && !poll.response && poll.expiresAt > Date.now()) {
      showPollOverlay(poll.pollId, poll.question, poll.options);
    } else if (!poll) {
      hidePollOverlay();
    }
    if (response.fabContext) currentFabContext = response.fabContext;
    if (response.fabState) {
      applyFabState({ ...response.fabState, context: response.fabContext });
    }
  });
}

function installAuthGateBlockers() {
  if (authGateBlockerInstalled) return;
  const blockBehindGate = (event) => {
    const gate = document.getElementById('classpilot-auth-gate');
    if (!gate) return;
    if (gate.contains(event.target)) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };
  document.addEventListener('keydown', blockBehindGate, true);
  document.addEventListener('wheel', blockBehindGate, { capture: true, passive: false });
  document.addEventListener('touchmove', blockBehindGate, { capture: true, passive: false });
  window.__classpilotAuthGateBlocker = blockBehindGate;
  authGateBlockerInstalled = true;
}

function removeAuthGateBlockers() {
  if (!authGateBlockerInstalled || !window.__classpilotAuthGateBlocker) return;
  const blockBehindGate = window.__classpilotAuthGateBlocker;
  document.removeEventListener('keydown', blockBehindGate, true);
  document.removeEventListener('wheel', blockBehindGate, true);
  document.removeEventListener('touchmove', blockBehindGate, true);
  delete window.__classpilotAuthGateBlocker;
  authGateBlockerInstalled = false;
}

function showAuthGate(state = {}) {
  if (window.location.protocol === 'chrome-extension:' ||
      window.location.protocol === 'chrome:' ||
      window.location.protocol === 'about:') {
    return;
  }

  authGateActive = true;
  document.documentElement.classList.add('classpilot-auth-locked');
  document.body?.classList.add('classpilot-auth-locked');
  const fab = document.getElementById('classpilot-fab-container');
  if (fab) fab.style.display = 'none';

  const existing = document.getElementById('classpilot-auth-gate');
  if (existing) existing.remove();

  const gate = document.createElement('div');
  gate.id = 'classpilot-auth-gate';
  gate.innerHTML = buildAuthGateMarkup(state);
  (document.body || document.documentElement).appendChild(gate);
  installAuthGateBlockers();
  attachAuthGateHandlers(state);
}

function removeAuthGate() {
  authGateActive = false;
  const gate = document.getElementById('classpilot-auth-gate');
  if (gate) gate.remove();
  document.documentElement.classList.remove('classpilot-auth-locked');
  document.body?.classList.remove('classpilot-auth-locked');
  const fab = document.getElementById('classpilot-fab-container');
  if (fab) fab.style.display = '';
  removeAuthGateBlockers();
}

function buildAuthGateMarkup(state) {
  const loginMethod = state.loginMethod === 'email_id' ? 'email_id' : 'name_pin';
  const title = state.setupRequired
    ? 'Ask your teacher to set up this Chromebook'
    : 'Sign in to continue';
  const subtitle = state.setupRequired
    ? 'This Chromebook needs the school setup key and Shared Chromebook Sign-In enabled before browsing can start.'
    : 'This shared Chromebook needs you to sign in before browsing can begin.';

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
        min-height: 100vh !important;
        padding: 24px !important;
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
        width: min(980px, calc(100vw - 32px)) !important;
        min-height: min(680px, calc(100vh - 48px)) !important;
        background: #ffffff !important;
        border-radius: 28px !important;
        box-shadow: 0 25px 70px rgba(15, 23, 42, 0.35) !important;
        border: 1px solid rgba(216, 222, 232, 0.8) !important;
        display: grid !important;
        grid-template-columns: 0.85fr 1.35fr !important;
        overflow: hidden !important;
      }
      .classpilot-auth-side {
        min-height: 100% !important;
        padding: 32px !important;
        background: linear-gradient(180deg, #0b2854 0%, #0e2a57 100%) !important;
        color: #ffffff !important;
        display: flex !important;
        flex-direction: column !important;
        justify-content: space-between !important;
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
        margin-top: 96px !important;
      }
      .classpilot-auth-side h2 {
        margin: 0 !important;
        max-width: 260px !important;
        font-size: 40px !important;
        line-height: 1.08 !important;
        font-weight: 800 !important;
        color: #ffffff !important;
        letter-spacing: 0 !important;
      }
      .classpilot-auth-side p {
        margin: 22px 0 0 !important;
        max-width: 285px !important;
        font-size: 17px !important;
        line-height: 1.7 !important;
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
        padding: 48px !important;
        display: flex !important;
        align-items: center !important;
        background: #ffffff !important;
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
        margin-bottom: 28px !important;
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
        font-size: 44px !important;
        line-height: 1.05 !important;
        font-weight: 800 !important;
        color: #0e2a57 !important;
        letter-spacing: 0 !important;
      }
      .classpilot-auth-main p {
        margin: 12px 0 28px !important;
        max-width: 420px !important;
        font-size: 18px !important;
        line-height: 1.55 !important;
        color: #6b7a90 !important;
      }
      .classpilot-auth-divider {
        height: 1px !important;
        width: 100% !important;
        background: #e2e8f0 !important;
        margin: 0 0 28px !important;
      }
      .classpilot-auth-form {
        display: grid !important;
        gap: 22px !important;
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
        width: 40px !important;
        height: 40px !important;
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
        min-height: 56px !important;
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
        min-height: 56px !important;
        border: 0 !important;
        border-radius: 12px !important;
        background: #f5b81f !important;
        color: #0e2a57 !important;
        font-weight: 800 !important;
        font-size: 22px !important;
        cursor: pointer !important;
        margin-top: 4px !important;
      }
      .classpilot-auth-button:disabled {
        opacity: 0.65 !important;
        cursor: not-allowed !important;
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
      .classpilot-auth-footnote {
        margin: 28px 0 0 !important;
        display: flex !important;
        align-items: center !important;
        justify-content: center !important;
        gap: 8px !important;
        color: #6b7a90 !important;
        font-size: 14px !important;
      }
      @media (max-width: 760px) {
        #classpilot-auth-gate {
          padding: 14px !important;
          align-items: stretch !important;
        }
        .classpilot-auth-panel {
          width: 100% !important;
          min-height: auto !important;
          grid-template-columns: 1fr !important;
          border-radius: 20px !important;
        }
        .classpilot-auth-side {
          display: none !important;
        }
        .classpilot-auth-main {
          padding: 28px !important;
          align-items: flex-start !important;
        }
        .classpilot-auth-main h1 {
          font-size: 34px !important;
        }
        .classpilot-auth-main p {
          font-size: 16px !important;
        }
      }
    </style>
    <div class="classpilot-auth-panel" role="dialog" aria-modal="true" aria-labelledby="classpilot-auth-title">
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
          <p>${escapeHtml(subtitle)}</p>
          <div class="classpilot-auth-divider"></div>
          <div class="classpilot-auth-error" id="classpilot-auth-error"></div>
          ${state.setupRequired ? buildSetupRequiredMarkup() : (
            loginMethod === 'name_pin' ? buildPinLoginMarkup() : buildEmailLoginMarkup()
          )}
          <div class="classpilot-auth-footnote"><span>${authIcon('shield')}</span><span>Shared Chromebook sign-in</span></div>
        </div>
      </div>
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

function buildSetupRequiredMarkup() {
  return `
    <div class="classpilot-auth-roster-note">
      This Chromebook is missing the managed ClassPilot school setup policy, or Shared Chromebook Sign-In is turned off.
    </div>
  `;
}

function buildEmailLoginMarkup() {
  return `
    <form class="classpilot-auth-form" id="classpilot-auth-email-form">
      <div class="classpilot-auth-field">
        <label for="classpilot-auth-email"><span class="classpilot-auth-field-icon">${authIcon('mail')}</span><span>School email</span></label>
        <input id="classpilot-auth-email" type="email" autocomplete="username" placeholder="student@school.edu" required />
      </div>
      <div class="classpilot-auth-field">
        <label for="classpilot-auth-student-id"><span class="classpilot-auth-field-icon">${authIcon('badge')}</span><span>Student ID Number</span></label>
        <input id="classpilot-auth-student-id" type="text" autocomplete="off" placeholder="Student ID" required />
      </div>
      <button class="classpilot-auth-button" id="classpilot-auth-email-submit" type="submit">Sign In</button>
    </form>
  `;
}

function buildPinLoginMarkup() {
  return `
    <form class="classpilot-auth-form" id="classpilot-auth-pin-form">
      ${buildGradeChoiceMarkup()}
      <div class="classpilot-auth-roster-note" id="classpilot-auth-roster-status" aria-live="polite"></div>
      <div class="classpilot-auth-field">
        <label for="classpilot-auth-student"><span class="classpilot-auth-field-icon">${authIcon('user')}</span><span>Student</span></label>
        <select id="classpilot-auth-student" disabled required>
          <option value="">Select a grade first...</option>
        </select>
      </div>
      <div class="classpilot-auth-field">
        <label for="classpilot-auth-pin"><span class="classpilot-auth-field-icon">${authIcon('lock')}</span><span>4-digit PIN</span></label>
        <input id="classpilot-auth-pin" inputmode="numeric" maxlength="4" autocomplete="off" placeholder="Enter your 4-digit PIN" required />
      </div>
      <button class="classpilot-auth-button" id="classpilot-auth-pin-submit" type="submit" disabled>Sign In</button>
    </form>
  `;
}

function buildGradeChoiceMarkup() {
  return `
    <div class="classpilot-auth-field">
      <label for="classpilot-auth-grade"><span class="classpilot-auth-field-icon">${authIcon('graduation')}</span><span>Grade</span></label>
      <select id="classpilot-auth-grade" disabled required>
        <option value="">Loading grades...</option>
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

function attachAuthGateHandlers(state) {
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
    if (gradeSelect) {
      gradeSelect.addEventListener('change', () => loadAuthGateRoster());
    }
    const pinInput = document.getElementById('classpilot-auth-pin');
    pinInput?.addEventListener('input', () => {
      pinInput.value = pinInput.value.replace(/\D/g, '').slice(0, 4);
    });
    pinForm.addEventListener('submit', (event) => {
      event.preventDefault();
      submitAuthGateLogin({
        mode: 'pin',
        studentId: document.getElementById('classpilot-auth-student')?.value || '',
        pin: pinInput?.value || '',
      }, event.submitter);
    });
    loadAuthGateGradeOptions();
  }
}

function loadAuthGateGradeOptions() {
  const gradeSelect = document.getElementById('classpilot-auth-grade');
  const studentSelect = document.getElementById('classpilot-auth-student');
  const status = document.getElementById('classpilot-auth-roster-status');
  const submit = document.getElementById('classpilot-auth-pin-submit');
  if (!gradeSelect || !studentSelect || !status || !submit) return;

  status.textContent = 'Loading grades...';
  gradeSelect.innerHTML = '<option value="">Loading grades...</option>';
  gradeSelect.disabled = true;
  studentSelect.innerHTML = '<option value="">Select a grade first...</option>';
  studentSelect.disabled = true;
  submit.disabled = true;

  chrome.runtime.sendMessage({ type: 'get-login-roster' }, (response) => {
    if (chrome.runtime.lastError || !response?.success) {
      status.textContent = response?.error || 'Could not load roster grades.';
      gradeSelect.innerHTML = '<option value="">Grades unavailable</option>';
      gradeSelect.disabled = true;
      return;
    }

    const grades = Array.isArray(response.grades) ? response.grades.filter((grade) => grade?.value) : [];
    if (!grades.length) {
      status.textContent = 'No roster grades are ready for PIN sign-in.';
      gradeSelect.innerHTML = '<option value="">No grades available</option>';
      gradeSelect.disabled = true;
      return;
    }

    status.textContent = '';
    gradeSelect.innerHTML = '<option value="">Select your grade</option>' +
      grades
        .map((grade) => `<option value="${escapeHtml(grade.value)}">${escapeHtml(grade.label || `Grade ${grade.value}`)}</option>`)
        .join('');
    gradeSelect.disabled = false;

    if (grades.length === 1) {
      gradeSelect.value = grades[0].value;
      loadAuthGateRoster();
    }
  });
}

function loadAuthGateRoster() {
  const select = document.getElementById('classpilot-auth-student');
  const status = document.getElementById('classpilot-auth-roster-status');
  const submit = document.getElementById('classpilot-auth-pin-submit');
  const gradeSelect = document.getElementById('classpilot-auth-grade');
  const selectedGrade = gradeSelect?.value || '';
  if (!select || !status || !submit) return;

  if (gradeSelect && !selectedGrade) {
    status.textContent = '';
    select.innerHTML = '<option value="">Select a grade first...</option>';
    select.disabled = true;
    submit.disabled = true;
    return;
  }

  status.textContent = 'Loading roster...';
  select.innerHTML = '<option value="">Loading students...</option>';
  select.disabled = true;
  submit.disabled = true;

  chrome.runtime.sendMessage({ type: 'get-login-roster', gradeLevel: selectedGrade }, (response) => {
    if (chrome.runtime.lastError || !response?.success) {
      status.textContent = response?.error || 'Could not load the classroom roster.';
      select.innerHTML = '<option value="">Roster unavailable</option>';
      select.disabled = true;
      submit.disabled = true;
      return;
    }

    const students = response.students || [];
    if (!students.length) {
      status.textContent = 'No students are ready for PIN sign-in in this grade.';
      select.innerHTML = '<option value="">No students available</option>';
      select.disabled = true;
      submit.disabled = true;
      return;
    }

    status.textContent = '';
    select.innerHTML = '<option value="">Select your name...</option>' +
      students
        .filter((student) => student && student.id)
        .map((student) => `<option value="${escapeHtml(student.id)}" ${student.hasPin ? '' : 'disabled'}>${escapeHtml(student.name || 'Unknown')}${student.hasPin ? '' : ' (PIN missing)'}</option>`)
        .join('');
    select.disabled = false;
    submit.disabled = false;
  });
}

function submitAuthGateLogin(payload, submitButton) {
  setAuthGateError('');
  const submit = submitButton || document.getElementById(payload.mode === 'pin' ? 'classpilot-auth-pin-submit' : 'classpilot-auth-email-submit');
  if (submit) {
    submit.disabled = true;
    submit.textContent = 'Signing In...';
  }

  chrome.runtime.sendMessage({ type: 'manual-student-login', payload }, (response) => {
    if (chrome.runtime.lastError || !response?.success) {
      setAuthGateError(response?.error || 'Invalid student credentials');
      if (submit) {
        submit.disabled = false;
        submit.textContent = 'Sign In';
      }
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
    
    // Notify service worker
    chrome.runtime.sendMessage({
      type: 'camera-status-changed',
      cameraActive: isActive
    }).catch(err => {
      // Ignore errors if extension context is invalidated
      console.log('[ClassPilot] Could not notify service worker:', err);
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
    setTimeout(() => {
      stopTimerOverlay();
    }, 5000);
  }
}

function stopTimerOverlay() {
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  timerEndTime = null;

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

function showPollOverlay(pollId, question, options) {
  // Skip if student already responded to this poll
  if (respondedPollIds.has(pollId)) {
    return;
  }
  activePollId = pollId;

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
    selectedOption: selectedIndex
  }, (response) => {
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
  if (body) {
    setTimeout(() => {
      body.innerHTML = `
        <div class="classpilot-poll-thanks">
          <div class="classpilot-poll-thanks-icon">✓</div>
          <p>Response submitted!</p>
        </div>
      `;
    }, 150);
  }

  // Auto-close after 2 seconds
  setTimeout(() => {
    hidePollOverlay();
  }, 2150);
}

function hidePollOverlay() {
  activePollId = null;
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

function persistFabChatState() {
  chrome.storage.local.set({
    [FAB_CHAT_MESSAGES_KEY]: chatMessages.slice(-50),
    [FAB_CHAT_CLOSED_KEY]: chatClosed,
    [FAB_CHAT_CONTEXT_KEY]: currentFabContext,
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

  const fabContainer = document.createElement('div');
  fabContainer.id = 'classpilot-fab-container';
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
  chrome.storage.local.get([
    'handRaised',
    'messagingEnabled',
    'handRaisingEnabled',
    FAB_CHAT_MESSAGES_KEY,
    FAB_CHAT_CLOSED_KEY,
    FAB_STATE_KEY,
    FAB_CONTEXT_KEY,
    FAB_CHAT_CONTEXT_KEY,
  ], (result) => {
    handRaised = result.handRaised || false;
    messagingEnabled = result.messagingEnabled !== false;
    handRaisingEnabled = result.handRaisingEnabled !== false;
    chatMessages = Array.isArray(result[FAB_CHAT_MESSAGES_KEY]) ? result[FAB_CHAT_MESSAGES_KEY] : [];
    chatClosed = result[FAB_CHAT_CLOSED_KEY] === true;
    currentFabContext = result[FAB_CHAT_CONTEXT_KEY] || result[FAB_CONTEXT_KEY] || null;
    if (result[FAB_STATE_KEY]) {
      applyFabState({ ...result[FAB_STATE_KEY], context: result[FAB_CONTEXT_KEY] });
    }
    updateFabHandState();
    updateFabMessageState();
    updateFabChatControls();
    updateFabIdentityState();
    renderChatMessages();
  });

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
  try {
    chrome.runtime.sendMessage({ type: 'raise-hand' }, (response) => {
      if (chrome.runtime.lastError) {
        showFabNotification('Extension updated — please refresh the page.', true);
        return;
      }
      if (response?.success) {
        handRaised = true;
        chrome.storage.local.set({ handRaised: true });
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
  try {
    chrome.runtime.sendMessage({ type: 'lower-hand' }, (response) => {
      if (chrome.runtime.lastError) {
        showFabNotification('Extension updated — please refresh the page.', true);
        return;
      }
      if (response?.success) {
        handRaised = false;
        chrome.storage.local.set({ handRaised: false });
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

  const applyState = (nextState, config = {}) => {
    const authRequired = nextState?.authRequired === true;
    const name =
      nextState?.studentName ||
      config.studentName ||
      nextState?.studentEmail ||
      config.studentEmail ||
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

  chrome.runtime.sendMessage({ type: 'get-auth-state', includeConfig: true }, (response) => {
    if (chrome.runtime.lastError || !response?.success) {
      identity.style.display = 'none';
      return;
    }
    applyState(response.state, response.config || {});
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

  // Disable input while sending
  input.disabled = true;

  try {
    chrome.runtime.sendMessage({
      type: 'send-student-message',
      message: message,
      messageType: 'message'
    }, (response) => {
      if (chrome.runtime.lastError) {
        input.disabled = false;
        showFabNotification('Extension updated — please refresh the page.', true);
        return;
      }
      input.disabled = false;
      if (response?.success) {
        chatMessages.push({
          id: response.messageId,
          sender: 'student',
          text: message,
          time: Date.now(),
        });
        persistFabChatState();
        input.value = '';
        renderChatMessages();
        input.focus();
      } else {
        showFabNotification('Could not send message. Please try again.', true);
      }
    });
  } catch (e) {
    input.disabled = false;
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
    return `<div class="classpilot-chat-bubble ${bubbleClass}">${text}</div>`;
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
  if (namespace === 'local') {
    if (changes.handRaised) {
      handRaised = changes.handRaised.newValue || false;
      updateFabHandState();
    }
    if (changes.messagingEnabled) {
      messagingEnabled = changes.messagingEnabled.newValue !== false;
      updateFabMessageState();
      updateFabChatControls();
      if (!messagingEnabled) {
        hideMessageBox();
        closeFabMenu();
      }
    }
    if (changes.handRaisingEnabled) {
      handRaisingEnabled = changes.handRaisingEnabled.newValue !== false;
      updateFabHandState();
    }
    if (changes[FAB_CHAT_MESSAGES_KEY]) {
      chatMessages = Array.isArray(changes[FAB_CHAT_MESSAGES_KEY].newValue)
        ? changes[FAB_CHAT_MESSAGES_KEY].newValue
        : [];
      renderChatMessages();
    }
    if (changes[FAB_CHAT_CLOSED_KEY]) {
      chatClosed = changes[FAB_CHAT_CLOSED_KEY].newValue === true;
    }
    if (changes[FAB_CONTEXT_KEY] || changes[FAB_STATE_KEY]) {
      chrome.storage.local.get([FAB_STATE_KEY, FAB_CONTEXT_KEY], (stored) => {
        if (stored[FAB_STATE_KEY]) {
          applyFabState({ ...stored[FAB_STATE_KEY], context: stored[FAB_CONTEXT_KEY] });
        } else {
          currentFabContext = null;
          chatMessages = [];
          chatClosed = true;
          renderChatMessages();
          hideMessageBox();
        }
      });
    }
  }
  if ((namespace === 'local' || namespace === 'session') &&
      (changes.studentToken || changes.studentEmail || changes.studentName || changes.activeStudentId)) {
    updateFabIdentityState();
  }
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

function signOutStudent() {
  closeFabMenu();
  hideMessageBox();
  chrome.runtime.sendMessage({ type: 'student-sign-out' }, (response) => {
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
