// ClassPilot - Content Script
// Displays messages as full-screen modals on student screens
// Monitors camera usage

// Track active camera streams
let activeCameraStreams = new Set();
let cameraActive = false;

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


console.log('ClassPilot content script loaded');
