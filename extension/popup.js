// Popup script for ClassPilot
// EMAIL-FIRST: No manual registration - auto-detect from Chrome profile

let currentConfig = null;
let currentAuthState = null;
let statusIntervalId = null;
let handRaisingEnabled = true;
let messagingEnabled = true;
let popupStudentActionEpoch = 0;

// Initialize popup
document.addEventListener('DOMContentLoaded', async () => {
  refreshPopupConfig();

  // Load and display messages
  loadMessages();

  // Initialize raise hand functionality
  initRaiseHand();

  // Initialize chat UI
  initChatUI();

  document.getElementById('sign-out-btn')?.addEventListener('click', signOutStudent);

  // Listen for storage changes to update messages in real-time
  chrome.storage.onChanged.addListener((changes, namespace) => {
    if (namespace === 'local' && changes.messages) {
      loadMessages();
    }
    if (namespace === 'local' && (changes.licenseActive || changes.planStatus)) {
      updateLicenseBanner();
    }
    if (namespace === 'local' && changes.connectivityHealthV1) {
      updateStatus();
    }
    if (namespace === 'local' && (changes.handRaisingEnabled || changes.messagingEnabled || changes.handRaised)) {
      if (changes.handRaisingEnabled) handRaisingEnabled = changes.handRaisingEnabled.newValue !== false;
      if (changes.messagingEnabled) messagingEnabled = changes.messagingEnabled.newValue !== false;
      if (changes.handRaised) handRaised = changes.handRaised.newValue === true;
      updateRaiseHandUI(handRaised, handRaisingEnabled);
      updateChatUI(messagingEnabled);
    }
    if ((namespace === 'local' || namespace === 'session') &&
        (changes.studentToken || changes.studentEmail || changes.studentName)) {
      popupStudentActionEpoch += 1;
      refreshAuthState();
    }
  });
});

function refreshPopupConfig() {
  const requestEpoch = popupStudentActionEpoch;
  chrome.runtime.sendMessage({ type: 'get-config' }, (response) => {
    if (
      requestEpoch !== popupStudentActionEpoch
      || chrome.runtime.lastError
      || !response?.config
    ) {
      return;
    }

    currentConfig = response.config;

    // ALWAYS show main view with auto-detected info (no manual registration)
    showMainView(currentConfig);
    refreshAuthState();
    updateLicenseBanner();
  });
}

function showMainView(config) {
  const setupView = document.getElementById('setup-view');
  if (setupView) setupView.classList.add('hidden');
  document.getElementById('main-view').classList.remove('hidden');
  
  // Update UI with config
  document.getElementById('school-name').textContent = config.schoolId || 'School';
  document.getElementById('student-name-display').textContent = config.studentName || '-';
  document.getElementById('class-id-display').textContent = config.classId || '-';
  
  // Update auto-detected student info
  if (config.studentEmail) {
    document.getElementById('detected-student-name').textContent = config.studentName || 'Auto-detected Student';
    document.getElementById('detected-student-email').textContent = config.studentEmail;
  } else if (config.hasStudentToken && config.studentName) {
    document.getElementById('detected-student-name').textContent = config.studentName;
    document.getElementById('detected-student-email').textContent = 'ClassPilot shared sign-in';
  } else {
    // Fallback if no email detected
    document.getElementById('detected-student-name').textContent = config.studentName || '-';
    document.getElementById('detected-student-email').textContent = 'No email detected';
  }
  
  // Update status
  updateStatus();
  
  // Update status every 5 seconds
  if (!statusIntervalId) {
    statusIntervalId = setInterval(updateStatus, 5000);
  }
}

function refreshAuthState() {
  const requestEpoch = popupStudentActionEpoch;
  chrome.runtime.sendMessage({ type: 'get-auth-state' }, (response) => {
    if (
      requestEpoch !== popupStudentActionEpoch
      || chrome.runtime.lastError
      || !response?.success
    ) {
      return;
    }
    currentAuthState = response.state;
    updateAuthUI();
  });
}

function updateAuthUI() {
  const signOutBtn = document.getElementById('sign-out-btn');
  const authRequiredCard = document.getElementById('auth-required-card');
  const raiseHandSection = document.getElementById('raise-hand-section');
  const chatSection = document.getElementById('chat-section');
  if (!signOutBtn || !authRequiredCard) return;

  if (currentAuthState?.authRequired) {
    authRequiredCard.classList.remove('hidden');
    signOutBtn.classList.add('hidden');
    raiseHandSection?.classList.add('hidden');
    chatSection?.classList.add('hidden');
  } else {
    authRequiredCard.classList.add('hidden');
    signOutBtn.classList.remove('hidden');
    raiseHandSection?.classList.remove('hidden');
    chatSection?.classList.remove('hidden');
  }
}

async function signOutStudent() {
  const signOutBtn = document.getElementById('sign-out-btn');
  if (signOutBtn) {
    signOutBtn.disabled = true;
    signOutBtn.textContent = 'Signing out...';
  }

  const requestEpoch = popupStudentActionEpoch;
  const contextResponse = await requestServiceWorker({ type: 'get-student-message-context' });
  const studentMessageContext = contextResponse?.success === true
    ? contextResponse.studentMessageContext
    : null;
  if (
    requestEpoch !== popupStudentActionEpoch
    || !studentMessageContext?.authContextId
  ) {
    if (signOutBtn) {
      signOutBtn.disabled = false;
      signOutBtn.textContent = 'Log out';
    }
    alert('The signed-in student changed. Please try again.');
    return;
  }

  chrome.runtime.sendMessage({
    type: 'student-sign-out',
    studentMessageContext: { ...studentMessageContext },
  }, (response) => {
    if (requestEpoch !== popupStudentActionEpoch) return;
    if (signOutBtn) {
      signOutBtn.disabled = false;
      signOutBtn.textContent = 'Log out';
    }
    if (chrome.runtime.lastError || !response?.success) {
      alert(response?.error || 'Could not sign out. Please try again.');
      return;
    }
    refreshAuthState();
  });
}

function updateStatus() {
  chrome.runtime.sendMessage({ type: 'get-connectivity-health' }, (response) => {
    const statusDot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');

    if (chrome.runtime.lastError || !response?.success) {
      statusDot.className = 'status-dot offline';
      statusText.textContent = 'Checking school server';
      return;
    }

    const dotClass = {
      connected: 'online',
      reconnecting: 'reconnecting',
      unreachable: 'unreachable',
      rate_limited: 'reconnecting',
    }[response.state] || 'offline';
    statusDot.className = `status-dot ${dotClass}`;
    statusText.textContent = response.label || 'Checking school server';

    const lastSuccessAt = Number(response.health?.lastSuccessAt || 0);
    document.getElementById('last-update').textContent = lastSuccessAt
      ? new Date(lastSuccessAt).toLocaleString()
      : 'No successful heartbeat yet';
  });
}

async function updateLicenseBanner() {
  const stored = await chrome.storage.local.get(['licenseActive', 'planStatus']);
  const bannerTitle = document.getElementById('license-banner-title');
  const bannerText = document.getElementById('license-banner-text');
  if (!bannerTitle || !bannerText) {
    return;
  }

  if (stored.licenseActive === false) {
    const planStatus = stored.planStatus ? ` (planStatus=${stored.planStatus})` : '';
    bannerTitle.textContent = 'Monitoring Disabled';
    bannerText.textContent = `ClassPilot disabled: school license inactive${planStatus}.`;
  } else {
    bannerTitle.textContent = 'Monitoring Active';
    bannerText.textContent = 'Your school can see active tab titles, URLs, timestamps, and periodic screen thumbnails while ClassPilot is active.';
  }
}

async function loadStudents(deviceId) {
  try {
    const serverUrl = currentConfig.serverUrl;
    const response = await fetch(`${serverUrl}/api/device/${deviceId}/students`);
    
    if (!response.ok) {
      throw new Error('Failed to load students');
    }
    
    const data = await response.json();
    const { students, activeStudentId } = data;
    
    const selectElement = document.getElementById('student-select');
    const currentStudentDisplay = document.getElementById('current-student-display');
    const currentStudentName = document.getElementById('current-student-name');
    const noStudentsMessage = document.getElementById('no-students-message');
    
    if (!students || students.length === 0) {
      selectElement.innerHTML = '<option value="">No students assigned</option>';
      selectElement.disabled = true;
      noStudentsMessage.classList.remove('hidden');
      currentStudentDisplay.classList.add('hidden');
      return;
    }
    
    // Populate dropdown
    selectElement.innerHTML = '<option value="">Select your name...</option>';
    students.forEach(student => {
      const option = document.createElement('option');
      option.value = student.id;
      option.textContent = student.studentName;
      selectElement.appendChild(option);
    });
    
    selectElement.disabled = false;
    noStudentsMessage.classList.add('hidden');
    
    // If there's an active student, show it
    if (activeStudentId) {
      const activeStudent = students.find(s => s.id === activeStudentId);
      if (activeStudent) {
        selectElement.value = activeStudentId;
        currentStudentName.textContent = activeStudent.studentName;
        currentStudentDisplay.classList.remove('hidden');
      }
    }
    
  } catch (error) {
    console.error('Error loading students');
    const selectElement = document.getElementById('student-select');
    selectElement.innerHTML = '<option value="">Error loading students</option>';
    selectElement.disabled = true;
  }
}

async function setActiveStudent(studentId) {
  if (!currentConfig || !currentConfig.deviceId) {
    console.error('No device ID available');
    return false;
  }
  
  try {
    const response = await requestServiceWorker({
      type: 'student-changed',
      studentId,
    });
    if (!response?.success) {
      throw new Error(response?.error || 'Student changes require a new sign-in');
    }
    return true;
  } catch (error) {
    console.error('Error setting active student');
    alert('To change students, sign out and sign in as the selected student.');
    await loadStudents();
    return false;
  }
}

async function handleStudentSelection(event) {
  const studentId = event.target.value;
  
  if (!studentId) {
    document.getElementById('current-student-display').classList.add('hidden');
    return;
  }
  
  // Get student name from selected option
  const selectedOption = event.target.options[event.target.selectedIndex];
  const studentName = selectedOption.textContent;
  
  // Update UI immediately
  document.getElementById('current-student-name').textContent = studentName;
  document.getElementById('current-student-display').classList.remove('hidden');
  
  // Call API to set active student
  await setActiveStudent(studentId);
}

function requestServiceWorker(payload) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(payload, (response) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(response || null);
    });
  });
}

async function capturePopupStudentActionContext() {
  const epoch = popupStudentActionEpoch;
  const response = await requestServiceWorker({ type: 'get-student-message-context' });
  if (
    epoch !== popupStudentActionEpoch
    || response?.success !== true
    || !response.studentMessageContext?.authContextId
    || !response.fabBinding
    || !response.activeTeachingSessionId
  ) return null;
  return Object.freeze({
    epoch,
    studentMessageContext: { ...response.studentMessageContext },
    fabBinding: response.fabBinding,
    sessionId: response.activeTeachingSessionId,
  });
}

function popupStudentActionPayload(context) {
  return {
    studentMessageContext: { ...context.studentMessageContext },
    fabBinding: context.fabBinding,
    sessionId: context.sessionId,
  };
}

async function popupStudentActionContextIsCurrent(context) {
  if (!context || context.epoch !== popupStudentActionEpoch) return false;
  const response = await requestServiceWorker({
    type: 'validate-student-message-context',
    studentMessageContext: context.studentMessageContext,
  });
  return Boolean(
    context.epoch === popupStudentActionEpoch
    && response?.success === true
    && response.current === true
    && response.fabBinding === context.fabBinding
    && Array.isArray(response.activeTeachingSessionIds)
    && response.activeTeachingSessionIds.includes(context.sessionId)
  );
}

async function loadMessages() {
  const actionContext = await capturePopupStudentActionContext();
  if (!actionContext) return;
  const response = await requestServiceWorker({
    type: 'get-message-inbox',
    ...popupStudentActionPayload(actionContext),
  });
  if (!(await popupStudentActionContextIsCurrent(actionContext))) return;
  const messages = response?.success && Array.isArray(response.messages) ? response.messages : [];
  
  const container = document.getElementById('messages-container');
  
  if (messages.length === 0) {
    container.innerHTML = `
      <p style="font-size: 12px; color: #94a3b8; text-align: center; padding: 20px;">
        No messages yet
      </p>
    `;
    return;
  }
  
  // Sort messages by timestamp (newest first)
  const sortedMessages = messages.sort((a, b) => b.timestamp - a.timestamp);
  
  // Build HTML for all messages
  let html = '';
  sortedMessages.forEach((msg, index) => {
    const unreadClass = msg.read ? '' : 'unread';
    
    const time = new Date(msg.timestamp).toLocaleString('en-US', {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
    });
    
    html += `
      <div class="message-item ${unreadClass}">
        <div class="message-header">
          <span class="message-title">💬 MESSAGE</span>
          <span class="message-time">${time}</span>
        </div>
        <div class="message-content">${msg.message}</div>
      </div>
    `;
  });
  
  // Add clear button
  html += `
    <button class="clear-messages" id="clear-messages-btn">
      Clear All Messages
    </button>
  `;
  
  container.innerHTML = html;
  
  // Add event listener to clear button
  document.getElementById('clear-messages-btn')?.addEventListener('click', clearMessages);
  
  // Mark all messages as read
  markMessagesAsRead(actionContext);
}

async function markMessagesAsRead(existingContext = null) {
  const actionContext = existingContext || await capturePopupStudentActionContext();
  if (!actionContext) return;
  await requestServiceWorker({
    type: 'mark-message-inbox-read',
    ...popupStudentActionPayload(actionContext),
  });
  if (!(await popupStudentActionContextIsCurrent(actionContext))) return;
  
  // Connectivity owns the badge; reading messages must not erase its warning.
  chrome.runtime.sendMessage({ type: 'refresh-connectivity-badge' }, () => {});
}

async function clearMessages() {
  if (confirm('Are you sure you want to clear all messages?')) {
    const actionContext = await capturePopupStudentActionContext();
    if (!actionContext) return;
    await requestServiceWorker({
      type: 'clear-message-inbox-display',
      ...popupStudentActionPayload(actionContext),
    });
    if (!(await popupStudentActionContextIsCurrent(actionContext))) return;
    loadMessages();
  }
}

// Raise hand functionality
let handRaised = false;

async function initRaiseHand() {
  const stored = await chrome.storage.local.get(['handRaised', 'handRaisingEnabled']);
  handRaised = stored.handRaised || false;
  handRaisingEnabled = stored.handRaisingEnabled !== false;

  updateRaiseHandUI(handRaised, handRaisingEnabled);

  // Add event listeners
  document.getElementById('raise-hand-btn')?.addEventListener('click', raiseHand);
  document.getElementById('lower-hand-btn')?.addEventListener('click', lowerHand);
}

function updateRaiseHandUI(isRaised, enabled = true) {
  const raiseBtn = document.getElementById('raise-hand-btn');
  const raisedStatus = document.getElementById('hand-raised-status');
  const disabledMsg = document.getElementById('messaging-disabled');

  if (!enabled) {
    raiseBtn?.classList.add('hidden');
    raisedStatus?.classList.add('hidden');
    disabledMsg?.classList.remove('hidden');
    return;
  }

  disabledMsg?.classList.add('hidden');

  if (isRaised) {
    raiseBtn?.classList.add('hidden');
    raisedStatus?.classList.remove('hidden');
  } else {
    raiseBtn?.classList.remove('hidden');
    raisedStatus?.classList.add('hidden');
  }
}

async function raiseHand() {
  if (!handRaisingEnabled) {
    updateRaiseHandUI(handRaised, false);
    return;
  }
  const btn = document.getElementById('raise-hand-btn');
  btn.disabled = true;
  btn.textContent = 'Raising...';

  try {
    const actionContext = await capturePopupStudentActionContext();
    if (!actionContext) throw new Error('No active class session');
    const response = await requestServiceWorker({
      type: 'raise-hand',
      ...popupStudentActionPayload(actionContext),
    });
    if (!(await popupStudentActionContextIsCurrent(actionContext))) return;
    if (response?.success) {
      handRaised = true;
      updateRaiseHandUI(true, handRaisingEnabled);
    } else {
      btn.disabled = false;
      btn.textContent = '✋ Raise Hand';
      alert(response?.error || 'Failed to raise hand. Please try again.');
    }
  } catch (error) {
    console.error('Error raising hand');
    btn.disabled = false;
    btn.textContent = '✋ Raise Hand';
    alert('Failed to raise hand. Please try again.');
  }
}

async function lowerHand() {
  try {
    const actionContext = await capturePopupStudentActionContext();
    if (!actionContext) throw new Error('No active class session');
    const response = await requestServiceWorker({
      type: 'lower-hand',
      ...popupStudentActionPayload(actionContext),
    });
    if (!(await popupStudentActionContextIsCurrent(actionContext))) return;
    if (response?.success) {
      handRaised = false;
      updateRaiseHandUI(false, handRaisingEnabled);
    } else {
      alert(response?.error || 'Failed to lower hand. Please try again.');
    }
  } catch (error) {
    console.error('Error lowering hand');
    alert('Failed to lower hand. Please try again.');
  }
}

// Two-way chat functions
async function sendStudentMessage(messageType = 'message') {
  const input = document.getElementById('chat-input');
  const message = input?.value?.trim();
  const sendBtn = document.getElementById('send-message-btn');
  const questionBtn = document.getElementById('send-question-btn');

  if (!messagingEnabled) {
    updateChatUI(false);
    return;
  }

  if (!message) {
    alert('Please enter a message');
    return;
  }

  if (message.length > 500) {
    alert('Message is too long (max 500 characters)');
    return;
  }

  // Disable buttons while sending
  if (sendBtn) sendBtn.disabled = true;
  if (questionBtn) questionBtn.disabled = true;
  const clientMessageId = globalThis.crypto?.randomUUID?.()
    || `chat-${Date.now()}-${Math.random().toString(16).slice(2)}`;

  try {
    const actionContext = await capturePopupStudentActionContext();
    if (!actionContext) throw new Error('No active class session');
    const response = await requestServiceWorker({
      type: 'send-student-message',
      clientMessageId,
      message,
      messageType,
      ...popupStudentActionPayload(actionContext),
    });
    if (!(await popupStudentActionContextIsCurrent(actionContext))) return;
    // Re-enable buttons
    if (sendBtn) sendBtn.disabled = false;
    if (questionBtn) questionBtn.disabled = false;

    if (response?.success) {
      input.value = '';
      const sentStatus = document.getElementById('message-sent-status');
      if (sentStatus) {
        sentStatus.textContent = response.queued ? 'Message queued — retrying' : 'Message delivered';
      }
      sentStatus?.classList.remove('hidden');
      const statusEpoch = actionContext.epoch;
      setTimeout(() => {
        if (statusEpoch === popupStudentActionEpoch) sentStatus?.classList.add('hidden');
      }, 3000);
    } else {
      alert(response?.error || 'Failed to send message. Please try again.');
    }
  } catch (error) {
    console.error('Error sending message');
    if (sendBtn) sendBtn.disabled = false;
    if (questionBtn) questionBtn.disabled = false;
    alert('Failed to send message. Please try again.');
  }
}

async function initChatUI() {
  const stored = await chrome.storage.local.get(['messagingEnabled']);
  messagingEnabled = stored.messagingEnabled !== false;
  updateChatUI(messagingEnabled);
  document.getElementById('send-message-btn')?.addEventListener('click', () => sendStudentMessage('message'));
  document.getElementById('send-question-btn')?.addEventListener('click', () => sendStudentMessage('question'));
}

function updateChatUI(enabled = true) {
  const input = document.getElementById('chat-input');
  const sendBtn = document.getElementById('send-message-btn');
  const questionBtn = document.getElementById('send-question-btn');
  const disabledMsg = document.getElementById('chat-disabled');
  for (const control of [input, sendBtn, questionBtn]) {
    if (!control) continue;
    control.disabled = !enabled;
    control.classList.toggle('hidden', !enabled);
  }
  disabledMsg?.classList.toggle('hidden', enabled);
}

function showPrivacyInfo() {
  alert(`What's Being Collected?

✓ Active Tab Title - The title of the webpage you're viewing
✓ Active Tab URL - The web address you're visiting
✓ Timestamps - When you visited each page
✓ Favicon - The small icon from the website
✓ Observation-bound screen thumbnails - Images of the active visible tab while an authorized teacher or administrator is observing
✓ Safety evidence - A single exact-tab image may be requested immediately before a safety tab closure
✓ Messages you choose to send through ClassPilot chat

✗ NOT Collected:
- Keystrokes or what you type
- Microphone or camera access
- Passwords or messages typed outside ClassPilot chat
- Anything from incognito/private windows

Automatic Monitoring:
- Tab titles and URLs are automatically collected and sent to your teacher
- This happens every 10 seconds while you browse
- Screen thumbnails are captured about every 30 seconds only while the exact student session is actively observed (or during an explicitly selected legacy rollout mode)
- Activity time comes from heartbeats; screenshots do not determine monitored or off-task time
- This is required by your school policy for classroom management

Live Screen Viewing:
- Teachers may request live screen viewing during active class sessions
- Managed devices can allow silent tab capture under school Chrome policy
- Encrypted Live View media may use SchoolPilot relay servers when a direct connection is unavailable
- ClassPilot keeps visible monitoring indicators active while monitoring is on

Data Retention:
- Raw activity and screenshots are retained only for the periods configured by your school and SchoolPilot
- Your teacher can export reports for educational purposes

This monitoring is required by your school for classroom management. All activity is visible and disclosed to you through this extension.`);
}
