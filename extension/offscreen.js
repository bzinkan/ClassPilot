// ClassPilot - Offscreen Document
// Handles WebRTC peer connections and screen capture in a page context
// (Service workers don't have access to WebRTC/Media APIs in MV3)

let peerConnection = null;
let localStream = null;
let ws = null;
let deviceId = null;

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' }
];

console.log('[Offscreen] Document loaded');

// Listen for messages from service worker
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[Offscreen] Received message:', message.type);
  
  (async () => {
    try {
      switch (message.type) {
        case 'OFFSCREEN_START_CAPTURE':
          await startScreenCapture(message.streamId);
          sendResponse({ success: true });
          break;
          
        case 'OFFSCREEN_CREATE_PEER':
          await createPeerConnection(message.wsUrl, message.deviceId);
          sendResponse({ success: true });
          break;
          
        case 'OFFSCREEN_HANDLE_OFFER':
          await handleOffer(message.sdp);
          sendResponse({ success: true });
          break;
          
        case 'OFFSCREEN_HANDLE_ICE':
          await handleIceCandidate(message.candidate);
          sendResponse({ success: true });
          break;
          
        case 'OFFSCREEN_STOP':
          stopScreenShare();
          sendResponse({ success: true });
          break;
          
        default:
          console.warn('[Offscreen] Unknown message type:', message.type);
          sendResponse({ success: false, error: 'Unknown message type' });
      }
    } catch (error) {
      console.error('[Offscreen] Error handling message:', error);
      sendResponse({ success: false, error: error.message });
    }
  })();
  
  // Return true to indicate we'll send response asynchronously
  return true;
});

// Create WebRTC peer connection
async function createPeerConnection(wsUrl, devId) {
  console.log('[Offscreen] Creating peer connection');
  
  deviceId = devId;
  
  // Clean up any existing connection
  if (peerConnection) {
    peerConnection.close();
  }
  
  // Create new peer connection
  peerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  
  // Handle ICE candidates - send to teacher via service worker
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      console.log('[Offscreen] Got ICE candidate, sending to teacher');
      // Send to service worker which will forward via WebSocket
      chrome.runtime.sendMessage({
        type: 'OFFSCREEN_ICE_CANDIDATE',
        candidate: event.candidate.toJSON(),
      });
    }
  };
  
  // Handle connection state changes
  peerConnection.onconnectionstatechange = () => {
    console.log('[Offscreen] Connection state:', peerConnection.connectionState);
    if (peerConnection.connectionState === 'failed' || 
        peerConnection.connectionState === 'disconnected') {
      stopScreenShare();
      // Notify service worker
      chrome.runtime.sendMessage({
        type: 'OFFSCREEN_CONNECTION_FAILED'
      });
    }
  };
  
  console.log('[Offscreen] Peer connection created');
}

// Start screen capture using getDisplayMedia (works in offscreen document)
async function startScreenCapture(streamId) {
  try {
    console.log('[Offscreen] Starting screen capture with streamId:', streamId);
    
    // Use getUserMedia with the streamId from tabCapture
    localStream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      }
    });
    
    console.log('[Offscreen] Got media stream, adding tracks to peer connection');
    
    // Add tracks to peer connection
    if (peerConnection) {
      localStream.getTracks().forEach(track => {
        peerConnection.addTrack(track, localStream);
      });
      console.log('[Offscreen] Tracks added to peer connection');
    }
    
  } catch (error) {
    console.error('[Offscreen] Screen capture error:', error);
    // Notify service worker of error
    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_CAPTURE_ERROR',
      error: error.message
    });
    throw error;
  }
}

// Handle offer from teacher
async function handleOffer(sdp) {
  try {
    console.log('[Offscreen] Handling offer from teacher');
    
    if (!peerConnection) {
      throw new Error('Peer connection not initialized');
    }
    
    await peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
    console.log('[Offscreen] Set remote description');
    
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    console.log('[Offscreen] Created and set local description (answer)');
    
    // Send answer back to teacher via service worker
    chrome.runtime.sendMessage({
      type: 'OFFSCREEN_ANSWER',
      sdp: peerConnection.localDescription.toJSON(),
    });
    
  } catch (error) {
    console.error('[Offscreen] Error handling offer:', error);
    throw error;
  }
}

// Handle ICE candidate from teacher
async function handleIceCandidate(candidate) {
  try {
    if (!peerConnection) {
      console.warn('[Offscreen] No peer connection, ignoring ICE candidate');
      return;
    }
    
    await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    console.log('[Offscreen] Added ICE candidate');
    
  } catch (error) {
    console.error('[Offscreen] Error adding ICE candidate:', error);
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
  
  console.log('[Offscreen] Cleanup complete');
}
