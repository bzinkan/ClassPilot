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

// Listen for messages from service worker
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[Offscreen] Received message:', message.type);
  
  (async () => {
    try {
      if (message.type === 'START_SHARE') {
        const result = await startScreenCapture(message.deviceId, message.mode);
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
      
      console.warn('[Offscreen] Unknown message type:', message.type);
      sendResponse({ success: false, error: 'Unknown message type' });
      
    } catch (error) {
      // Unexpected errors only (expected ones are handled in functions)
      console.error('[Offscreen] Unexpected error handling message:', error);
      sendResponse({ success: false, error: error.message });
    }
  })();
  
  // Return true to indicate we'll send response asynchronously
  return true;
});

// Start screen capture - try silent tab capture first, fallback to picker
async function startScreenCapture(deviceId, mode = 'auto') {
  console.log('[Offscreen] Starting screen capture, mode:', mode);
  
  try {
    // Try silent tab capture first (works on managed Chromebooks with policy)
    if (mode === 'auto' || mode === 'tab') {
      try {
        console.log('[Offscreen] Attempting silent tab capture...');
        localStream = await new Promise((resolve, reject) => {
          chrome.tabCapture.capture(
            { video: true, audio: false },
            stream => {
              if (stream) {
                console.log('[Offscreen] ✅ Silent tab capture succeeded!');
                resolve(stream);
              } else {
                const error = chrome.runtime.lastError;
                // Expected on unmanaged devices - not a real error
                console.info('[Offscreen] Silent tab capture not available (expected on unmanaged devices):', error?.message);
                reject(error);
              }
            }
          );
        });
        
        console.log('[Offscreen] Got media stream from tab capture, creating peer connection');
      } catch (tabCaptureError) {
        // Tab capture failed - fall back to picker only if mode is 'auto'
        if (mode === 'auto') {
          console.info('[Offscreen] Falling back to screen picker (expected on unmanaged devices)...');
          
          try {
            localStream = await navigator.mediaDevices.getDisplayMedia({
              video: {
                frameRate: 15,
                width: { ideal: 1280 },
                height: { ideal: 720 }
              },
              audio: false
            });
            console.log('[Offscreen] Got media stream from screen picker, creating peer connection');
          } catch (pickerError) {
            // User denied or closed picker - expected behavior
            if (pickerError.name === 'NotAllowedError' || pickerError.name === 'AbortError') {
              console.info('[Offscreen] User denied screen share or closed picker (expected)');
              chrome.runtime.sendMessage({
                type: 'CAPTURE_ERROR',
                error: 'Student denied screen share request'
              });
              return { success: false, status: 'user-denied' };
            }
            // Unexpected error
            console.error('[Offscreen] Unexpected screen picker error:', pickerError);
            chrome.runtime.sendMessage({
              type: 'CAPTURE_ERROR',
              error: pickerError.message
            });
            return { success: false, status: 'failed', error: pickerError.message };
          }
        } else {
          // Mode is 'tab' only, no fallback allowed
          console.warn('[Offscreen] Silent tab capture failed and fallback not allowed in mode:', mode);
          chrome.runtime.sendMessage({
            type: 'CAPTURE_ERROR',
            error: 'Silent tab capture not available on this device'
          });
          return { success: false, status: 'tab-capture-unavailable' };
        }
      }
    } else if (mode === 'screen') {
      // Explicitly requested screen/window picker
      console.log('[Offscreen] Using screen picker (explicit request)...');
      
      try {
        localStream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            frameRate: 15,
            width: { ideal: 1280 },
            height: { ideal: 720 }
          },
          audio: false
        });
        console.log('[Offscreen] Got media stream from screen picker, creating peer connection');
      } catch (pickerError) {
        // User denied or closed picker - expected behavior
        if (pickerError.name === 'NotAllowedError' || pickerError.name === 'AbortError') {
          console.info('[Offscreen] User denied screen share or closed picker (expected)');
          chrome.runtime.sendMessage({
            type: 'CAPTURE_ERROR',
            error: 'Student denied screen share request'
          });
          return { success: false, status: 'user-denied' };
        }
        // Unexpected error
        console.error('[Offscreen] Unexpected screen picker error:', pickerError);
        chrome.runtime.sendMessage({
          type: 'CAPTURE_ERROR',
          error: pickerError.message
        });
        return { success: false, status: 'failed', error: pickerError.message };
      }
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
        chrome.runtime.sendMessage({
          type: 'CONNECTION_FAILED'
        });
      }
    };
    
    // Add tracks to peer connection
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
    });
    
    console.log('[Offscreen] Tracks added to peer connection, ready to receive offer');
    
    return { success: true };
    
  } catch (error) {
    // Only unexpected errors reach here (expected ones are handled above)
    console.error('[Offscreen] Unexpected screen capture error:', error);
    chrome.runtime.sendMessage({
      type: 'CAPTURE_ERROR',
      error: error.message
    });
    return { success: false, status: 'failed', error: error.message };
  }
}

// Handle signaling messages (offer, answer, ICE)
async function handleSignal(signal) {
  try {
    console.log('[Offscreen] Handling signal:', signal.type);
    
    if (signal.type === 'offer') {
      if (!peerConnection) {
        console.warn('[Offscreen] Received offer before peer connection ready, queueing...');
        // Queue the offer and wait for peer connection
        setTimeout(() => handleSignal(signal), 100);
        return { success: false, status: 'queued' };
      }
      
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
    // Only log unexpected signaling errors
    console.error('[Offscreen] Unexpected signaling error:', error);
    return { success: false, error: error.message };
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
  
  console.log('[Offscreen] Cleanup complete');
}
