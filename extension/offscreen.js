// ClassPilot - Offscreen Document
// Handles WebRTC peer connections and screen capture in a page context
// (Service workers don't have access to WebRTC/Media APIs in MV3)

let peerConnection = null;
let localStream = null;
let teacherId = null;
let iceQueue = []; // Queue ICE candidates until peer is ready

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];

console.log('[Offscreen] Document loaded');

// Signal ready state to service worker
window.addEventListener('DOMContentLoaded', () => {
  console.log('[Offscreen] Sending READY signal');
  chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' });
});

// Immediately send ready if already loaded
if (document.readyState === 'complete' || document.readyState === 'interactive') {
  chrome.runtime.sendMessage({ type: 'OFFSCREEN_READY' });
}

// Listen for messages from service worker (only handle types meant for offscreen)
const OFFSCREEN_MESSAGE_TYPES = new Set(['START_SHARE', 'SIGNAL', 'STOP_SHARE']);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Ignore messages not intended for the offscreen document
  if (!OFFSCREEN_MESSAGE_TYPES.has(message.type)) {
    return; // Don't call sendResponse, let other listeners handle it
  }

  console.log('[Offscreen] Received message:', message.type);

  (async () => {
    try {
      if (message.type === 'START_SHARE') {
        const result = await startScreenCapture(message.deviceId, message.mode, message.streamId);
        sendResponse(result);
        return;
      }

      if (message.type === 'SIGNAL') {
        const result = await handleSignal(message.payload);
        sendResponse(result);
        return;
      }

      if (message.type === 'STOP_SHARE') {
        stopScreenShare();
        sendResponse({ success: true });
        return;
      }
    } catch (error) {
      console.error('[Offscreen] Unexpected error handling message:', error);
      sendResponse({ success: false, error: error.message });
    }
  })();

  // Return true to indicate we'll send response asynchronously
  return true;
});

// Start screen capture
// streamId: provided by service worker via chrome.tabCapture.getMediaStreamId() (MV3 approach)
// Falls back to getDisplayMedia() if no streamId available
async function startScreenCapture(deviceId, mode = 'auto', streamId = null) {
  console.log('[Offscreen] Starting screen capture, mode:', mode, 'streamId:', !!streamId);

  // Clean up any previous capture
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }

  try {
    // Method 1: Use streamId from service worker (MV3 tab capture)
    if (streamId) {
      try {
        console.log('[Offscreen] Using streamId from service worker for tab capture...');
        localStream = await navigator.mediaDevices.getUserMedia({
          video: {
            mandatory: {
              chromeMediaSource: 'tab',
              chromeMediaSourceId: streamId
            }
          },
          audio: false
        });
        console.log('[Offscreen] Tab capture via streamId succeeded');
      } catch (streamIdError) {
        console.info('[Offscreen] streamId capture failed:', streamIdError.message);
        // Fall through to getDisplayMedia fallback
      }
    }

    // Method 2: Fall back to getDisplayMedia (shows picker on unmanaged devices)
    if (!localStream && (mode === 'auto' || mode === 'screen')) {
      console.log('[Offscreen] Using getDisplayMedia (screen picker)...');
      try {
        localStream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            frameRate: 15,
            width: { ideal: 1280 },
            height: { ideal: 720 }
          },
          audio: false
        });
        console.log('[Offscreen] getDisplayMedia succeeded');
      } catch (pickerError) {
        if (pickerError.name === 'NotAllowedError' || pickerError.name === 'AbortError') {
          console.info('[Offscreen] User denied screen share or closed picker (expected)');
          chrome.runtime.sendMessage({
            type: 'CAPTURE_ERROR',
            error: 'Student denied screen share request'
          });
          return { success: false, status: 'user-denied' };
        }
        console.error('[Offscreen] getDisplayMedia error:', pickerError);
        chrome.runtime.sendMessage({
          type: 'CAPTURE_ERROR',
          error: pickerError.message
        });
        return { success: false, status: 'failed', error: pickerError.message };
      }
    }

    // No stream obtained
    if (!localStream) {
      const msg = mode === 'tab'
        ? 'Silent tab capture not available on this device'
        : 'No capture method succeeded';
      console.warn('[Offscreen]', msg);
      chrome.runtime.sendMessage({ type: 'CAPTURE_ERROR', error: msg });
      return { success: false, status: 'tab-capture-unavailable' };
    }

    // Create peer connection
    peerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    // Handle ICE candidates - send to teacher via service worker
    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        console.log('[Offscreen] Got ICE candidate, sending to teacher');
        chrome.runtime.sendMessage({
          type: 'ICE_CANDIDATE',
          candidate: event.candidate.toJSON(),
        });
      }
    };

    // Handle connection state changes
    peerConnection.onconnectionstatechange = () => {
      console.log('[Offscreen] Connection state:', peerConnection.connectionState);
      if (peerConnection.connectionState === 'failed' ||
          peerConnection.connectionState === 'disconnected') {
        chrome.runtime.sendMessage({ type: 'CONNECTION_FAILED' });
      }
    };

    // Add tracks to peer connection
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });

    console.log('[Offscreen] Tracks added to peer connection, ready to receive offer');
    return { success: true };

  } catch (error) {
    console.error('[Offscreen] Unexpected screen capture error:', error);
    chrome.runtime.sendMessage({ type: 'CAPTURE_ERROR', error: error.message });
    return { success: false, status: 'failed', error: error.message };
  }
}

// Handle signaling messages (offer, answer, ICE)
let offerProcessed = false; // Guard against duplicate offer processing from setTimeout retries

async function handleSignal(signal) {
  try {
    console.log('[Offscreen] Handling signal:', signal.type);

    if (signal.type === 'offer') {
      if (!peerConnection) {
        console.log('[Offscreen] Received offer before peer connection ready, queueing (expected)...');
        setTimeout(() => handleSignal(signal), 500);
        return { success: true, status: 'queued' };
      }

      // Prevent duplicate processing from multiple setTimeout retries
      if (offerProcessed || peerConnection.remoteDescription) {
        console.log('[Offscreen] Offer already processed, skipping duplicate');
        return { success: true, status: 'already-processed' };
      }
      offerProcessed = true;

      teacherId = signal.from;
      await peerConnection.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      console.log('[Offscreen] Set remote description (offer)');

      const answer = await peerConnection.createAnswer();
      await peerConnection.setLocalDescription(answer);
      console.log('[Offscreen] Created and set local description (answer)');

      // Send answer back to teacher via service worker
      chrome.runtime.sendMessage({
        type: 'ANSWER',
        sdp: peerConnection.localDescription.toJSON(),
      });

      // Flush queued ICE candidates now that remote description is set
      await flushIceQueue();

      return { success: true };

    } else if (signal.type === 'ice') {
      if (!peerConnection) {
        console.info('[Offscreen] No peer connection yet, queueing ICE candidate');
        iceQueue.push(signal.candidate);
        return { success: true, status: 'queued' };
      }
      
      if (!peerConnection.remoteDescription) {
        console.info('[Offscreen] Remote description not set yet, queueing ICE candidate');
        iceQueue.push(signal.candidate);
        return { success: true, status: 'queued' };
      }
      
      try {
        await peerConnection.addIceCandidate(new RTCIceCandidate(signal.candidate));
        console.log('[Offscreen] Added ICE candidate');
        return { success: true };
      } catch (iceError) {
        // Late ICE candidates are expected and safe to ignore
        console.info('[Offscreen] ICE candidate add failed (expected for late candidates):', iceError.message);
        return { success: true, status: 'late-candidate' };
      }
    }
    
    return { success: true };
    
  } catch (error) {
    // Log with name + message for DOMExceptions
    console.error('[Offscreen] Unexpected signaling error:', error.name || 'Error', error.message || error);
    return { success: false, error: error.message || String(error) };
  }
}

// Flush queued ICE candidates after remote description is set
async function flushIceQueue() {
  if (iceQueue.length === 0) return;
  
  console.log(`[Offscreen] Flushing ${iceQueue.length} queued ICE candidates`);
  
  while (iceQueue.length > 0) {
    const candidate = iceQueue.shift();
    try {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } catch (error) {
      // Late candidates are safe to ignore
      console.info('[Offscreen] Queued ICE candidate add failed (safe to ignore):', error.message);
    }
  }
  
  console.log('[Offscreen] ICE queue flushed');
}

// Stop screen sharing and cleanup
function stopScreenShare() {
  console.log('[Offscreen] Stopping screen share');
  
  if (localStream) {
    localStream.getTracks().forEach(track => track.stop());
    localStream = null;
  }
  
  if (peerConnection) {
    peerConnection.close();
    peerConnection = null;
  }
  
  iceQueue = [];
  teacherId = null;
  offerProcessed = false;
  
  console.log('[Offscreen] Cleanup complete');
}
