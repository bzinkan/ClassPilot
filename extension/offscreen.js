// ClassPilot - Offscreen Document
// Handles WebRTC peer connections and screen capture in a page context
// (Service workers don't have access to WebRTC/Media APIs in MV3)

let peerConnection = null;
let localStream = null;
let teacherId = null;
let iceQueue = []; // Queue ICE candidates until peer is ready
let activeNegotiationId = null;
let liveViewSetupTimer = null;
let liveViewHardExpiryTimer = null;

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

// ============================================================================
// WebSocket proxy — runs here because MV3 service workers can't maintain
// persistent WebSocket connections (Chrome 145+ enforces this strictly).
// The service worker sends WS_CONNECT / WS_SEND / WS_CLOSE messages here,
// and we relay incoming WS messages back via chrome.runtime.sendMessage.
// ============================================================================
let proxyWs = null;
let wsKeepAliveTimer = null;
let proxyConnectionGeneration = 0;
let proxyAuthenticated = false;
let proxyUrl = null;

function relayWsEvent(event, data) {
  chrome.runtime.sendMessage({
    type: 'WS_EVENT',
    event,
    data,
    connectionGeneration: proxyConnectionGeneration,
  });
}

function wsStatus() {
  return {
    success: true,
    connectionGeneration: proxyConnectionGeneration,
    readyState: proxyWs?.readyState ?? WebSocket.CLOSED,
    transportOpen: proxyWs?.readyState === WebSocket.OPEN,
    authenticated: proxyAuthenticated,
    url: proxyUrl,
  };
}

function handleWsConnect(url, authPayload, requestedGeneration) {
  const connectionGeneration = Number(requestedGeneration || 0);
  if (!Number.isSafeInteger(connectionGeneration) || connectionGeneration < 1) {
    throw new Error('WS_CONNECT requires a positive connection generation');
  }
  if (
    proxyWs &&
    proxyConnectionGeneration === connectionGeneration &&
    proxyUrl === url &&
    (proxyWs.readyState === WebSocket.CONNECTING || proxyWs.readyState === WebSocket.OPEN)
  ) {
    return wsStatus();
  }

  // Close any existing connection and keepalive
  if (wsKeepAliveTimer) { clearInterval(wsKeepAliveTimer); wsKeepAliveTimer = null; }
  if (proxyWs) {
    try { proxyWs.onclose = null; proxyWs.close(); } catch (e) { /* ignore */ }
    proxyWs = null;
  }

  proxyConnectionGeneration = connectionGeneration;
  proxyAuthenticated = false;
  proxyUrl = url;
  console.log('[Offscreen-WS] Connecting generation', connectionGeneration, 'to', url);
  proxyWs = new WebSocket(url);
  const connection = proxyWs;

  proxyWs.onopen = () => {
    if (connection !== proxyWs || connectionGeneration !== proxyConnectionGeneration) return;
    console.log('[Offscreen-WS] Connected');
    relayWsEvent('open');
    // Send auth immediately if provided
    if (authPayload && proxyWs.readyState === WebSocket.OPEN) {
      proxyWs.send(JSON.stringify(authPayload));
      console.log('[Offscreen-WS] Auth sent');
    }
    // Start application-level keepalive ping every 25 seconds.
    // This serves two purposes:
    // 1. Prevents Chrome from considering the offscreen document "inactive" and killing it
    // 2. Keeps the WebSocket connection alive through proxies/load balancers
    if (wsKeepAliveTimer) clearInterval(wsKeepAliveTimer);
    wsKeepAliveTimer = setInterval(() => {
      if (proxyWs && proxyWs.readyState === WebSocket.OPEN) {
        proxyWs.send(JSON.stringify({ type: 'ping' }));
      }
    }, 25000);
  };

  proxyWs.onmessage = (event) => {
    if (connection !== proxyWs || connectionGeneration !== proxyConnectionGeneration) return;
    try {
      const payload = JSON.parse(event.data);
      if (payload?.type === 'auth-success') proxyAuthenticated = true;
      if (payload?.type === 'auth-error' || payload?.type === 'auth-failed') {
        proxyAuthenticated = false;
        stopScreenShare();
      }
    } catch { /* payload is relayed unchanged */ }
    // Relay raw message to service worker
    relayWsEvent('message', event.data);
  };

  proxyWs.onerror = () => {
    if (connection !== proxyWs || connectionGeneration !== proxyConnectionGeneration) return;
    console.warn('[Offscreen-WS] Connection issue');
    proxyAuthenticated = false;
    relayWsEvent('error');
  };

  proxyWs.onclose = () => {
    if (connection !== proxyWs || connectionGeneration !== proxyConnectionGeneration) return;
    console.log('[Offscreen-WS] Disconnected');
    if (wsKeepAliveTimer) { clearInterval(wsKeepAliveTimer); wsKeepAliveTimer = null; }
    proxyWs = null;
    proxyAuthenticated = false;
    stopScreenShare();
    relayWsEvent('close');
  };
  return wsStatus();
}

function handleWsSend(data, requestedGeneration) {
  if (
    proxyWs &&
    proxyWs.readyState === WebSocket.OPEN &&
    Number(requestedGeneration) === proxyConnectionGeneration
  ) {
    proxyWs.send(data);
    return { success: true, connectionGeneration: proxyConnectionGeneration };
  }
  return {
    success: false,
    code: 'WS_NOT_OPEN',
    error: 'WebSocket transport is not open for this generation',
    connectionGeneration: proxyConnectionGeneration,
  };
}

function handleWsClose(requestedGeneration) {
  if (requestedGeneration && Number(requestedGeneration) !== proxyConnectionGeneration) {
    return wsStatus();
  }
  // An intentional transport shutdown (tracking OFF, sign-out, entitlement
  // revocation, or off-hours) must revoke the peer-to-peer capture too. The
  // socket's onclose handler is detached below, so this cleanup cannot rely on
  // the normal WebSocket close event.
  stopScreenShare();
  if (wsKeepAliveTimer) { clearInterval(wsKeepAliveTimer); wsKeepAliveTimer = null; }
  if (proxyWs) {
    try { proxyWs.onclose = null; proxyWs.close(); } catch (e) { /* ignore */ }
    proxyWs = null;
  }
  proxyAuthenticated = false;
  proxyUrl = null;
  return wsStatus();
}

// Listen for messages from service worker (only handle types meant for offscreen)
const OFFSCREEN_MESSAGE_TYPES = new Set([
  'START_SHARE',
  'SIGNAL',
  'STOP_SHARE',
  'WS_CONNECT',
  'WS_SEND',
  'WS_CLOSE',
  'WS_STATUS',
]);

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Ignore messages not intended for the offscreen document
  if (!OFFSCREEN_MESSAGE_TYPES.has(message.type)) {
    return; // Don't call sendResponse, let other listeners handle it
  }

  console.log('[Offscreen] Received message:', message.type);

  (async () => {
    try {
      if (message.type === 'START_SHARE') {
        const result = await startScreenCapture(
          message.deviceId,
          message.mode,
          message.streamId,
          message.negotiationId,
          message.setupExpiresAt,
          message.expiresAt,
        );
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

      if (message.type === 'WS_CONNECT') {
        sendResponse(handleWsConnect(
          message.url,
          message.authPayload,
          message.connectionGeneration
        ));
        return;
      }

      if (message.type === 'WS_SEND') {
        sendResponse(handleWsSend(message.data, message.connectionGeneration));
        return;
      }

      if (message.type === 'WS_CLOSE') {
        sendResponse(handleWsClose(message.connectionGeneration));
        return;
      }

      if (message.type === 'WS_STATUS') {
        sendResponse(wsStatus());
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
function clearLiveViewExpiryTimers() {
  if (liveViewSetupTimer) clearTimeout(liveViewSetupTimer);
  if (liveViewHardExpiryTimer) clearTimeout(liveViewHardExpiryTimer);
  liveViewSetupTimer = null;
  liveViewHardExpiryTimer = null;
}

function parseFutureExpiry(value, fallbackMs, maximumMs) {
  const now = Date.now();
  const parsed = typeof value === 'number' ? value : Date.parse(String(value || ''));
  const candidate = Number.isFinite(parsed) && parsed > now ? parsed : now + fallbackMs;
  return Math.min(candidate, now + maximumMs);
}

function expireLiveView(reason, negotiationId) {
  if (!negotiationId || negotiationId !== activeNegotiationId) return;
  stopScreenShare();
  chrome.runtime.sendMessage({
    type: 'LIVE_VIEW_EXPIRED',
    reason,
    negotiationId,
  });
}

function scheduleLiveViewExpiry(setupExpiresAt, expiresAt, negotiationId) {
  clearLiveViewExpiryTimers();
  const now = Date.now();
  const hardExpiry = parseFutureExpiry(expiresAt, 15 * 60 * 1000, 15 * 60 * 1000);
  const setupExpiry = Math.min(
    parseFutureExpiry(setupExpiresAt, 90 * 1000, 90 * 1000),
    hardExpiry,
  );
  liveViewSetupTimer = setTimeout(() => {
    if (!offerProcessed) expireLiveView('setup-expired', negotiationId);
  }, Math.max(0, setupExpiry - now));
  liveViewHardExpiryTimer = setTimeout(() => {
    expireLiveView('maximum-duration', negotiationId);
  }, Math.max(0, hardExpiry - now));
}

async function startScreenCapture(
  deviceId,
  mode = 'auto',
  streamId = null,
  negotiationId = null,
  setupExpiresAt = null,
  expiresAt = null,
) {
  console.log('[Offscreen] Starting screen capture, mode:', mode, 'streamId:', !!streamId);

  // Every capture attempt is a new negotiation. Reset the duplicate-offer
  // guard, queued ICE, teacher identity, tracks, and peer together so a failed
  // or stopped attempt can be retried without restarting the extension.
  stopScreenShare();
  activeNegotiationId = String(negotiationId || '').trim() || null;
  if (!activeNegotiationId) {
    return { success: false, status: 'missing-negotiation', error: 'Missing live-view negotiation' };
  }
  scheduleLiveViewExpiry(setupExpiresAt, expiresAt, activeNegotiationId);

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
          stopScreenShare();
          return { success: false, status: 'user-denied' };
        }
        console.error('[Offscreen] getDisplayMedia error:', pickerError);
        chrome.runtime.sendMessage({
          type: 'CAPTURE_ERROR',
          error: pickerError.message
        });
        stopScreenShare();
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
      stopScreenShare();
      return { success: false, status: 'tab-capture-unavailable' };
    }

    // Create peer connection
    peerConnection = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    const activePeerConnection = peerConnection;
    const activeStream = localStream;

    // Handle ICE candidates - send to teacher via service worker
    activePeerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        console.log('[Offscreen] Got ICE candidate, sending to teacher');
        chrome.runtime.sendMessage({
          type: 'ICE_CANDIDATE',
          negotiationId: activeNegotiationId,
          candidate: event.candidate.toJSON(),
        });
      }
    };

    // Handle connection state changes
    activePeerConnection.onconnectionstatechange = () => {
      const connectionState = activePeerConnection.connectionState;
      console.log('[Offscreen] Connection state:', connectionState);
      if (connectionState === 'failed' || connectionState === 'disconnected') {
        if (peerConnection === activePeerConnection) stopScreenShare();
        chrome.runtime.sendMessage({ type: 'CONNECTION_FAILED' });
      }
    };

    // Add tracks to peer connection
    activeStream.getTracks().forEach(track => {
      track.onended = () => {
        if (localStream !== activeStream) return;
        stopScreenShare();
        chrome.runtime.sendMessage({ type: 'CONNECTION_FAILED', reason: 'capture-track-ended' });
      };
      activePeerConnection.addTrack(track, activeStream);
    });

    console.log('[Offscreen] Tracks added to peer connection, ready to receive offer');
    return { success: true };

  } catch (error) {
    console.error('[Offscreen] Unexpected screen capture error:', error);
    chrome.runtime.sendMessage({ type: 'CAPTURE_ERROR', error: error.message });
    stopScreenShare();
    return { success: false, status: 'failed', error: error.message };
  }
}

// Handle signaling messages (offer, answer, ICE)
let offerProcessed = false; // Guard against duplicate offer processing from setTimeout retries

async function handleSignal(signal) {
  try {
    console.log('[Offscreen] Handling signal:', signal.type);

    if (signal.type === 'offer') {
      if (!signal.negotiationId || signal.negotiationId !== activeNegotiationId) {
        return { success: false, status: 'stale-negotiation' };
      }
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
      if (liveViewSetupTimer) clearTimeout(liveViewSetupTimer);
      liveViewSetupTimer = null;

      // Send answer back to teacher via service worker
      chrome.runtime.sendMessage({
        type: 'ANSWER',
        negotiationId: activeNegotiationId,
        sdp: peerConnection.localDescription.toJSON(),
      });

      // Flush queued ICE candidates now that remote description is set
      await flushIceQueue();

      return { success: true };

    } else if (signal.type === 'ice') {
      if (!signal.negotiationId || signal.negotiationId !== activeNegotiationId) {
        return { success: false, status: 'stale-negotiation' };
      }
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
  clearLiveViewExpiryTimers();
  
  if (localStream) {
    localStream.getTracks().forEach(track => {
      track.onended = null;
      track.stop();
    });
    localStream = null;
  }
  
  if (peerConnection) {
    peerConnection.onicecandidate = null;
    peerConnection.onconnectionstatechange = null;
    peerConnection.close();
    peerConnection = null;
  }
  
  iceQueue = [];
  teacherId = null;
  offerProcessed = false;
  activeNegotiationId = null;
  
  console.log('[Offscreen] Cleanup complete');
}
