// offscreen.js - Keeps WebRTC peer connection alive even when popup closes

let peerConnection = null;
let localStream = null;
let websocket = null;
let config = null;
let studentId = null;
let teacherId = null;
let classId = null;
let deviceId = null;
let queuedIceCandidates = [];
let remoteDescriptionSet = false;

// Fetch configuration from server
async function getConfig() {
  if (config) return config;
  try {
    const response = await fetch('https://classpilot.replit.app/api/client-config', { 
      cache: 'no-store' 
    });
    config = await response.json();
    return config;
  } catch (error) {
    console.error('[Offscreen] Failed to fetch config:', error);
    // Fallback to default STUN server
    return {
      baseUrl: 'https://classpilot.replit.app',
      iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
    };
  }
}

// Initialize WebSocket connection
async function initWebSocket() {
  if (websocket && websocket.readyState === WebSocket.OPEN) {
    return websocket;
  }

  const cfg = await getConfig();
  const wsUrl = cfg.baseUrl.replace('https://', 'wss://').replace('http://', 'ws://') + '/ws';
  
  return new Promise((resolve, reject) => {
    websocket = new WebSocket(wsUrl);
    
    websocket.onopen = () => {
      console.log('[Offscreen] WebSocket connected');
      resolve(websocket);
    };
    
    websocket.onerror = (error) => {
      console.error('[Offscreen] WebSocket error:', error);
      reject(error);
    };
    
    websocket.onmessage = async (event) => {
      try {
        const message = JSON.parse(event.data);
        await handleSignal(message);
      } catch (error) {
        console.error('[Offscreen] WebSocket message error:', error);
      }
    };
    
    websocket.onclose = () => {
      console.log('[Offscreen] WebSocket closed, will reconnect on next share');
      websocket = null;
    };
  });
}

// Send signal via WebSocket
function sendSignal(message) {
  if (websocket && websocket.readyState === WebSocket.OPEN) {
    websocket.send(JSON.stringify(message));
    console.log('[Offscreen] Sent signal:', message.type);
  } else {
    console.error('[Offscreen] WebSocket not ready, cannot send signal');
  }
}

// Handle incoming WebRTC signals
async function handleSignal(message) {
  if (message.type === 'webrtc-signal') {
    const { signal } = message;
    
    if (signal.to !== studentId) {
      return; // Not for us
    }
    
    console.log('[Offscreen] Received signal:', signal.type, 'from:', signal.from);
    
    if (signal.type === 'answer' && signal.sdp) {
      try {
        await peerConnection.setRemoteDescription(new RTCSessionDescription(signal.sdp));
        console.log('[Offscreen] Set remote description (answer)');
        remoteDescriptionSet = true;
        
        // Process queued ICE candidates
        if (queuedIceCandidates.length > 0) {
          console.log('[Offscreen] Processing', queuedIceCandidates.length, 'queued ICE candidates');
          for (const candidate of queuedIceCandidates) {
            try {
              await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
            } catch (e) {
              console.warn('[Offscreen] Failed to add queued ICE candidate:', e);
            }
          }
          queuedIceCandidates = [];
        }
      } catch (error) {
        console.error('[Offscreen] Error setting remote description:', error);
      }
    } else if (signal.type === 'ice' && signal.candidate) {
      try {
        if (remoteDescriptionSet && peerConnection.remoteDescription) {
          await peerConnection.addIceCandidate(new RTCIceCandidate(signal.candidate));
          console.log('[Offscreen] Added ICE candidate');
        } else {
          console.log('[Offscreen] Queuing ICE candidate (remote description not set yet)');
          queuedIceCandidates.push(signal.candidate);
        }
      } catch (error) {
        console.error('[Offscreen] Error adding ICE candidate:', error);
      }
    }
  }
}

// Start screen sharing
async function startShare(ids) {
  try {
    console.log('[Offscreen] Starting screen share with IDs:', ids);
    
    // Validate IDs were passed from service worker
    if (!ids || !ids.studentId || !ids.teacherId) {
      console.error('[Offscreen] Missing IDs from service worker');
      return { success: false, error: 'Missing student or teacher ID' };
    }
    
    // Store IDs in module scope
    studentId = ids.studentId;
    teacherId = ids.teacherId;
    classId = ids.classId;
    deviceId = ids.deviceId;
    
    // Load configuration
    const cfg = await getConfig();
    
    // Initialize WebSocket
    await initWebSocket();
    
    // Get screen stream
    localStream = await navigator.mediaDevices.getDisplayMedia({
      video: {
        displaySurface: 'monitor',
        cursor: 'always'
      },
      audio: false
    });
    
    console.log('[Offscreen] Got display media stream');
    
    // Create peer connection with ICE servers
    peerConnection = new RTCPeerConnection({
      iceServers: cfg.iceServers || [{ urls: 'stun:stun.l.google.com:19302' }]
    });
    
    // Reset state
    queuedIceCandidates = [];
    remoteDescriptionSet = false;
    
    // Add debugging logs
    peerConnection.oniceconnectionstatechange = () => {
      console.log('[Offscreen] ICE connection state:', peerConnection.iceConnectionState);
    };
    
    peerConnection.onconnectionstatechange = () => {
      console.log('[Offscreen] Connection state:', peerConnection.connectionState);
    };
    
    peerConnection.onsignalingstatechange = () => {
      console.log('[Offscreen] Signaling state:', peerConnection.signalingState);
    };
    
    // Handle ICE candidates
    peerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        console.log('[Offscreen] Sending ICE candidate to teacher');
        sendSignal({
          type: 'webrtc-signal',
          signal: {
            type: 'ice',
            candidate: event.candidate,
            from: studentId,
            to: teacherId
          }
        });
      }
    };
    
    // Add tracks to peer connection
    localStream.getTracks().forEach(track => {
      peerConnection.addTrack(track, localStream);
      console.log('[Offscreen] Added track:', track.kind);
    });
    
    // Handle track ending (user stops sharing)
    localStream.getTracks()[0].onended = () => {
      console.log('[Offscreen] User stopped sharing via browser UI');
      stopShare();
    };
    
    // Create and send offer
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    console.log('[Offscreen] Created offer, sending to teacher');
    
    sendSignal({
      type: 'webrtc-signal',
      signal: {
        type: 'offer',
        sdp: peerConnection.localDescription,
        from: studentId,
        to: teacherId
      }
    });
    
    // Notify server that sharing is active
    try {
      await fetch(`${cfg.baseUrl}/api/events`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          type: 'share_status',
          deviceId: deviceId,
          studentId: studentId,
          classId: classId,
          isSharing: true,
          timestamp: new Date().toISOString()
        })
      });
      console.log('[Offscreen] Notified server: sharing=true');
    } catch (error) {
      console.warn('[Offscreen] Failed to notify server:', error);
    }
    
    // No need to update storage - service worker handles this
    return { success: true };
  } catch (error) {
    console.error('[Offscreen] Error starting share:', error);
    return { success: false, error: error.message };
  }
}

// Stop screen sharing
async function stopShare() {
  try {
    console.log('[Offscreen] Stopping screen share...');
    
    // Stop all tracks
    if (localStream) {
      localStream.getTracks().forEach(track => track.stop());
      localStream = null;
    }
    
    // Close peer connection
    if (peerConnection) {
      peerConnection.close();
      peerConnection = null;
    }
    
    // Close WebSocket
    if (websocket) {
      websocket.close();
      websocket = null;
    }
    
    // Reset state
    queuedIceCandidates = [];
    remoteDescriptionSet = false;
    
    // Notify server that sharing stopped
    if (config && deviceId) {
      try {
        await fetch(`${config.baseUrl}/api/events`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            type: 'share_status',
            deviceId: deviceId,
            studentId: studentId,
            classId: classId,
            isSharing: false,
            timestamp: new Date().toISOString()
          })
        });
        console.log('[Offscreen] Notified server: sharing=false');
      } catch (error) {
        console.warn('[Offscreen] Failed to notify server:', error);
      }
    }
    
    // No need to update storage - service worker handles this
    return { success: true };
  } catch (error) {
    console.error('[Offscreen] Error stopping share:', error);
    return { success: false, error: error.message };
  }
}

// Listen for messages from service worker
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only process messages directed to offscreen
  if (message.to !== 'offscreen') {
    return;
  }
  
  console.log('[Offscreen] Received message:', message.type);
  
  if (message.type === 'START_SHARE') {
    // IDs are passed from service worker to avoid storage access issues
    startShare(message.ids)
      .then(sendResponse)
      .catch(error => {
        console.error('[Offscreen] Error in startShare:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true; // Keep channel open for async response
  } else if (message.type === 'STOP_SHARE') {
    stopShare()
      .then(sendResponse)
      .catch(error => {
        console.error('[Offscreen] Error in stopShare:', error);
        sendResponse({ success: false, error: error.message });
      });
    return true;
  }
});

console.log('[Offscreen] Script loaded and ready');
