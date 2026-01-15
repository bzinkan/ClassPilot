// ClassPilot - Content Script
// Displays messages as full-screen modals on student screens
// Handles attention mode, timers, and polls
// Monitors camera usage

// Track active camera streams
let activeCameraStreams = new Set();
let cameraActive = false;

// Track overlay states
let attentionModeActive = false;
let timerInterval = null;
let timerEndTime = null;
let activePollId = null;

// Listen for messages from service worker
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'show-message') {
    showMessageModal(message.data);
  }

  if (message.type === 'check-blocked-domain') {
    const currentDomain = window.location.hostname;
    sendResponse({ domain: currentDomain });
  }

  if (message.type === 'get-camera-status') {
    sendResponse({ cameraActive: cameraActive });
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
      startTimerOverlay(message.data.seconds, message.data.message);
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

  // Chat message notification
  if (message.type === 'chat-notification') {
    showChatNotification(message.data.message, message.data.fromName);
  }

  return true;
});

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
  const { message, fromName, timestamp } = data;
  
  // Remove any existing message modal first
  const existingModal = document.getElementById('classpilot-message-modal');
  if (existingModal) {
    existingModal.remove();
  }
  
  // Create modal overlay
  const modal = document.createElement('div');
  modal.id = 'classpilot-message-modal';
  modal.innerHTML = `
    <div class="classpilot-modal-overlay">
      <div class="classpilot-modal-content classpilot-message">
        <div class="classpilot-modal-header">
          <div class="classpilot-modal-icon">💬</div>
          <h2>Message from ${escapeHtml(fromName || 'Teacher')}</h2>
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

function startTimerOverlay(seconds, message) {
  // Clear any existing timer
  stopTimerOverlay();

  timerEndTime = Date.now() + (seconds * 1000);

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
  // Visual feedback
  const allButtons = document.querySelectorAll('.classpilot-poll-option');
  allButtons.forEach(btn => {
    btn.disabled = true;
    btn.classList.add('classpilot-poll-disabled');
  });
  button.classList.add('classpilot-poll-selected');

  // Send response to service worker
  chrome.runtime.sendMessage({
    type: 'poll-response',
    pollId: pollId,
    selectedOption: selectedIndex
  }).catch(err => {
    console.log('[ClassPilot] Could not send poll response:', err);
  });

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
    }, 500);
  }

  // Auto-close after 2 seconds
  setTimeout(() => {
    hidePollOverlay();
  }, 2500);
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

console.log('ClassPilot content script loaded');
