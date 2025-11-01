// ClassPilot - Offscreen Document
// Handles WebRTC peer connections and screen capture in a page context
// (Service workers don't have access to WebRTC/Media APIs in MV3)

let peerConnection = null;
let localStream = null;
let teacherId = null;

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
        await startScreenCapture(message.deviceId);
        sendResponse({ success: true });
        return;
      }
      
      if (message.type === 'SIGNAL') {
        await handleSignal(message.payload);
        sendResponse({ success: true });
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
      console.error('[Offscreen] Error handling message:', error);
      sendResponse({ success: false, error: error.message });
    }
  })();
  
  // Return true to indicate we'll send response asynchronously
  return true;
});

// Start screen capture using getDisplayMedia
async function startScreenCapture(deviceId) {
  try {
    console.log('[Offscreen] Starting screen capture with getDisplayMedia');
    
    // Use getDisplayMedia - shows user picker for screen/window/tab
    // This is more robust than tabCapture and works on all pages
    localStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        frameRate: 15,  // Reasonable framerate for classroom monitoring
        width: { ideal: 1280 },
        height: { ideal: 720 }
      },
      audio: false
    });
    
    console.log('[Offscreen] Got media stream, creating peer connection');
    
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
    
    console.log('[Offscreen] Tracks added to peer connection, ready for offer');
    
  } catch (error) {
    console.error('[Offscreen] Screen capture error:', error);
    chrome.runtime.sendMessage({
      type: 'CAPTURE_ERROR',
      error: error.message
    });
    throw error;
  }
}

// Handle signaling messages (offer, answer, ICE)
async function handleSignal(signal) {
  try {
    console.log('[Offscreen] Handling signal:', signal.type);
    
    if (signal.type === 'offer') {
      teacherId = signal.from;
      
      if (!peerConnection) {
        throw new Error('Peer connection not initialized');
      }
      
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
      
    } else if (signal.type === 'ice') {
      if (!peerConnection) {
        console.warn('[Offscreen] No peer connection, ignoring ICE candidate');
        return;
      }
      
      await peerConnection.addIceCandidate(new RTCIceCandidate(signal.candidate));
      console.log('[Offscreen] Added ICE candidate');
    }
    
  } catch (error) {
    console.error('[Offscreen] Error handling signal:', error);
    throw error;
  }
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
  
  teacherId = null;
  
  console.log('[Offscreen] Cleanup complete');
}
