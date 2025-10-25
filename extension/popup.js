// Popup script for Classroom Screen Awareness

let mediaStream = null;
let peerConnection = null;

// Initialize popup
document.addEventListener('DOMContentLoaded', async () => {
  // Get config from background
  chrome.runtime.sendMessage({ type: 'get-config' }, (response) => {
    const config = response.config;
    
    if (config.studentName && config.deviceId) {
      // Already registered, show main view
      showMainView(config);
    } else {
      // Need to register
      showSetupView();
    }
  });
  
  // Setup form submission
  document.getElementById('setup-submit').addEventListener('click', handleSetup);
  
  // Share button
  document.getElementById('share-button').addEventListener('click', startScreenShare);
  
  // Stop button
  document.getElementById('stop-button').addEventListener('click', stopScreenShare);
  
  // Privacy link
  document.getElementById('privacy-link').addEventListener('click', (e) => {
    e.preventDefault();
    showPrivacyInfo();
  });
});

function showSetupView() {
  document.getElementById('setup-view').classList.remove('hidden');
  document.getElementById('main-view').classList.add('hidden');
}

function showMainView(config) {
  document.getElementById('setup-view').classList.add('hidden');
  document.getElementById('main-view').classList.remove('hidden');
  
  // Update UI with config
  document.getElementById('school-name').textContent = config.schoolId || 'School';
  document.getElementById('student-name-display').textContent = config.studentName || '-';
  document.getElementById('class-id-display').textContent = config.classId || '-';
  
  // Update status
  updateStatus();
  
  // Update status every 5 seconds
  setInterval(updateStatus, 5000);
  
  // Automatically start screen sharing (automatic monitoring mode)
  setTimeout(() => {
    autoStartScreenShare();
  }, 1000);
}

async function handleSetup() {
  const studentName = document.getElementById('student-name').value.trim();
  const classId = document.getElementById('class-id').value.trim();
  
  if (!studentName || !classId) {
    alert('Please fill in all fields');
    return;
  }
  
  const button = document.getElementById('setup-submit');
  button.disabled = true;
  button.textContent = 'Connecting...';
  
  // Send registration to background
  chrome.runtime.sendMessage({
    type: 'register',
    studentName,
    classId,
  }, (response) => {
    if (response.success) {
      showMainView({
        studentName,
        classId,
        deviceId: response.data.student.deviceId,
      });
    } else {
      alert('Registration failed: ' + response.error);
      button.disabled = false;
      button.textContent = 'Connect to Classroom';
    }
  });
}

function updateStatus() {
  chrome.action.getBadgeText({}, (text) => {
    const statusDot = document.getElementById('status-dot');
    const statusText = document.getElementById('status-text');
    
    if (text === '●') {
      statusDot.className = 'status-dot online';
      statusText.textContent = 'Connected';
    } else if (text === '◉') {
      statusDot.className = 'status-dot online';
      statusText.textContent = 'Connected & Sharing';
    } else {
      statusDot.className = 'status-dot offline';
      statusText.textContent = 'Disconnected';
    }
  });
  
  // Update last update time
  const now = new Date();
  document.getElementById('last-update').textContent = now.toLocaleTimeString();
}

async function autoStartScreenShare() {
  try {
    // Use desktopCapture API for automatic screen sharing (requires force-install by admin)
    chrome.desktopCapture.chooseDesktopMedia(['screen'], (streamId) => {
      if (!streamId) {
        console.log('No stream selected, will retry on next popup open');
        return;
      }
      
      // Get media stream from streamId
      navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          mandatory: {
            chromeMediaSource: 'desktop',
            chromeMediaSourceId: streamId,
          },
        },
      }).then((stream) => {
        mediaStream = stream;
        console.log('Automatic screen sharing started');
        
        // Update UI
        document.getElementById('share-section').classList.add('hidden');
        document.getElementById('sharing-section').classList.remove('hidden');
        
        // Notify background
        chrome.runtime.sendMessage({ type: 'sharing-started' });
        
        // Setup WebRTC
        setupWebRTC(mediaStream);
        
        // Handle stream end - auto-restart
        mediaStream.getVideoTracks()[0].addEventListener('ended', () => {
          console.log('Screen sharing ended, will restart on next popup open');
          stopScreenShare();
        });
      }).catch((error) => {
        console.error('Failed to get user media:', error);
      });
    });
  } catch (error) {
    console.error('Automatic screen sharing error:', error);
  }
}

async function startScreenShare() {
  try {
    // Manual screen sharing (fallback if auto-start fails)
    mediaStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        cursor: 'always',
      },
      audio: false,
    });
    
    console.log('Screen sharing started');
    
    // Update UI
    document.getElementById('share-section').classList.add('hidden');
    document.getElementById('sharing-section').classList.remove('hidden');
    
    // Notify background
    chrome.runtime.sendMessage({ type: 'sharing-started' });
    
    // Setup WebRTC (simplified - full implementation would need signaling)
    setupWebRTC(mediaStream);
    
    // Handle stream end
    mediaStream.getVideoTracks()[0].addEventListener('ended', () => {
      stopScreenShare();
    });
    
  } catch (error) {
    console.error('Screen sharing error:', error);
    alert('Failed to start screen sharing. Permission may have been denied.');
  }
}

function stopScreenShare() {
  if (mediaStream) {
    mediaStream.getTracks().forEach(track => track.stop());
    mediaStream = null;
  }
  
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  
  // Update UI
  document.getElementById('share-section').classList.remove('hidden');
  document.getElementById('sharing-section').classList.add('hidden');
  
  // Notify background
  chrome.runtime.sendMessage({ type: 'sharing-stopped' });
  
  console.log('Screen sharing stopped');
}

function setupWebRTC(stream) {
  // Create peer connection
  peerConnection = new RTCPeerConnection({
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
    ],
  });
  
  // Add stream tracks
  stream.getTracks().forEach(track => {
    peerConnection.addTrack(track, stream);
  });
  
  // Handle ICE candidates
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      // Send ICE candidate to teacher via WebSocket
      chrome.runtime.sendMessage({
        type: 'webrtc-send-signal',
        signal: {
          type: 'ice-candidate',
          data: event.candidate,
        },
      });
    }
  };
  
  // Create and send offer
  peerConnection.createOffer().then(offer => {
    peerConnection.setLocalDescription(offer);
    
    // Send offer to teacher
    chrome.runtime.sendMessage({
      type: 'webrtc-send-signal',
      signal: {
        type: 'offer',
        data: offer,
      },
    });
  });
  
  console.log('WebRTC setup complete');
}

// Listen for WebRTC signals from background
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'webrtc-signal') {
    const signal = message.data;
    
    if (signal.type === 'answer' && peerConnection) {
      peerConnection.setRemoteDescription(new RTCSessionDescription(signal.data));
    } else if (signal.type === 'ice-candidate' && peerConnection) {
      peerConnection.addIceCandidate(new RTCIceCandidate(signal.data));
    }
    
    sendResponse({ success: true });
  }
  return true;
});

function showPrivacyInfo() {
  alert(`What's Being Collected?

✓ Screen Display - Your full screen is automatically shared with your teacher
✓ Active Tab Title - The title of the webpage you're viewing
✓ Active Tab URL - The web address you're visiting
✓ Timestamps - When you visited each page
✓ Favicon - The small icon from the website

✗ NOT Collected:
- Keystrokes or what you type (unless visible on screen)
- Microphone or camera access
- Private messages or passwords (unless visible on screen)
- Anything from incognito/private windows

Automatic Screen Sharing:
- Screen sharing starts automatically when the extension is active
- Your teacher can view your screen in real-time for classroom management
- A red indicator shows when sharing is active
- This is required by your school policy for managed Chromebooks

Data Retention:
- Your activity data is automatically deleted after 24 hours
- Your teacher can export reports for educational purposes

This monitoring is required by your school for classroom management. All activity is visible and disclosed to you through this extension.`);
}
