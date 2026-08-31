// ClassPilot - Offscreen Document
// Handles WebRTC peer connections and screen capture in a page context
// (Service workers don't have access to WebRTC/Media APIs in MV3)

let peerConnection = null;
let localStream = null;
let teacherId = null;
let iceQueue = []; // Queue ICE candidates until peer is ready
let activeNegotiationId = null;
let activeLiveViewStartGeneration = 0;
let activeLiveViewAuthContextId = null;
let activeLiveViewAuthGeneration = 0;
let activeLiveViewConnectionGeneration = 0;
let activeLiveViewServerOrigin = null;
let activeLiveViewStudentSessionId = null;
let activeLiveViewRestartGeneration = 0;
let activeLiveViewContext = null;
let latestLiveViewIdentity = null;
let liveViewDisconnectTimer = null;
let liveViewRestartAttempts = [];
let liveViewAttemptStartedAt = 0;
let liveViewTelemetryAttempts = new Set();
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
let proxyAuthContextId = null;
let proxyServerOrigin = null;
let screenshotCadenceTimer = null;
let screenshotCadenceExpiryTimer = null;
let screenshotCadenceTickInFlight = false;
let screenshotCadenceSchedule = null;
let latestScreenshotCadenceIssuedAt = 0;

const SCREENSHOT_ACTIVE_CADENCE_INTERVAL_MS = 5000;
const SCREENSHOT_ACTIVE_CADENCE_MAX_LEASE_MS = 90 * 1000;

function clearScreenshotCadenceTimers() {
  if (screenshotCadenceTimer) clearInterval(screenshotCadenceTimer);
  if (screenshotCadenceExpiryTimer) clearTimeout(screenshotCadenceExpiryTimer);
  screenshotCadenceTimer = null;
  screenshotCadenceExpiryTimer = null;
  screenshotCadenceTickInFlight = false;
}

function stopScreenshotCadence() {
  clearScreenshotCadenceTimers();
  screenshotCadenceSchedule = null;
}

function normalizeScreenshotCadenceRequest(message = {}) {
  const cadenceId = String(message.cadenceId || '').trim();
  const generation = Number(message.generation);
  const issuedAt = Number(message.issuedAt);
  const expiresAt = Number(message.expiresAt);
  const intervalMs = Number(message.intervalMs);
  const now = Date.now();
  if (
    !/^[A-Za-z0-9._-]{8,128}$/.test(cadenceId)
    || !Number.isSafeInteger(generation)
    || generation < 1
    || !Number.isSafeInteger(issuedAt)
    || issuedAt < 1
    || !Number.isFinite(expiresAt)
    || expiresAt <= now
    || expiresAt > now + SCREENSHOT_ACTIVE_CADENCE_MAX_LEASE_MS
    || intervalMs !== SCREENSHOT_ACTIVE_CADENCE_INTERVAL_MS
  ) return null;
  return Object.freeze({ cadenceId, generation, issuedAt, expiresAt, intervalMs });
}

async function expireScreenshotCadence(schedule) {
  if (screenshotCadenceSchedule !== schedule) return false;
  stopScreenshotCadence();
  await chrome.runtime.sendMessage({
    type: 'SCREENSHOT_CADENCE_EXPIRED',
    cadenceId: schedule.cadenceId,
    generation: schedule.generation,
  }).catch(() => {});
  return true;
}

async function emitScreenshotCadenceTick(schedule) {
  if (screenshotCadenceSchedule !== schedule || screenshotCadenceTickInFlight) return false;
  if (Date.now() >= schedule.expiresAt) {
    await expireScreenshotCadence(schedule);
    return false;
  }
  screenshotCadenceTickInFlight = true;
  try {
    await chrome.runtime.sendMessage({
      type: 'SCREENSHOT_CADENCE_TICK',
      cadenceId: schedule.cadenceId,
      generation: schedule.generation,
    });
    return true;
  } catch {
    return false;
  } finally {
    if (screenshotCadenceSchedule === schedule) screenshotCadenceTickInFlight = false;
  }
}

function startScreenshotCadence(message = {}) {
  const schedule = normalizeScreenshotCadenceRequest(message);
  if (!schedule) return { success: false, status: 'invalid-cadence' };
  if (schedule.issuedAt < latestScreenshotCadenceIssuedAt) {
    return { success: false, status: 'stale-cadence' };
  }
  if (schedule.issuedAt === latestScreenshotCadenceIssuedAt) {
    const current = screenshotCadenceSchedule;
    const idempotent = Boolean(
      current
      && current.cadenceId === schedule.cadenceId
      && current.generation === schedule.generation
      && current.expiresAt === schedule.expiresAt
      && current.intervalMs === schedule.intervalMs
    );
    return idempotent
      ? { success: true, status: 'active' }
      : { success: false, status: 'stale-cadence' };
  }
  latestScreenshotCadenceIssuedAt = schedule.issuedAt;
  stopScreenshotCadence();
  screenshotCadenceSchedule = schedule;
  screenshotCadenceTimer = setInterval(() => {
    emitScreenshotCadenceTick(schedule).catch(() => {});
  }, schedule.intervalMs);
  screenshotCadenceExpiryTimer = setTimeout(() => {
    expireScreenshotCadence(schedule).catch(() => {});
  }, Math.max(0, schedule.expiresAt - Date.now()));
  return { success: true, status: 'active' };
}

function handleScreenshotCadenceStop(message = {}) {
  const issuedAt = Number(message.issuedAt);
  const generation = Number(message.generation);
  if (
    !Number.isSafeInteger(issuedAt)
    || issuedAt < latestScreenshotCadenceIssuedAt
    || !Number.isSafeInteger(generation)
    || generation < 1
  ) return { success: false, status: 'stale-cadence' };
  latestScreenshotCadenceIssuedAt = issuedAt;
  stopScreenshotCadence();
  return { success: true, status: 'stopped' };
}

function safeDiagnosticLabel(value) {
  const label = typeof value === 'string' ? value.trim() : '';
  return new Set(['auto', 'ice', 'offer', 'screen', 'tab']).has(label) ? label : 'unknown';
}

function safeCaptureError(error) {
  if (error?.name === 'NotAllowedError' || error?.name === 'AbortError') {
    return {
      code: 'SCREEN_CAPTURE_DENIED',
      message: 'Student denied screen share request',
    };
  }
  return {
    code: 'SCREEN_CAPTURE_FAILED',
    message: 'Screen capture failed',
  };
}

function normalizedOrigin(value) {
  try {
    const parsed = new URL(String(value || ''));
    if (parsed.protocol === 'wss:') parsed.protocol = 'https:';
    if (parsed.protocol === 'ws:') parsed.protocol = 'http:';
    return parsed.origin;
  } catch {
    return null;
  }
}

function liveViewIdentityPayload() {
  return {
    negotiationId: activeNegotiationId,
    startGeneration: activeLiveViewStartGeneration,
    authContextId: activeLiveViewAuthContextId,
    authGeneration: activeLiveViewAuthGeneration,
    connectionGeneration: activeLiveViewConnectionGeneration,
    serverOrigin: activeLiveViewServerOrigin,
    studentSessionId: activeLiveViewStudentSessionId,
    restartGeneration: activeLiveViewRestartGeneration,
  };
}

function normalizeLiveViewIdentity(message = {}) {
  const negotiationId = String(message.negotiationId || '').trim();
  const startGeneration = Number(message.startGeneration ?? message.authGeneration);
  const authContextId = String(message.authContextId || '').trim();
  const authGeneration = Number(message.authGeneration);
  const connectionGeneration = Number(message.connectionGeneration);
  const serverOrigin = normalizedOrigin(message.serverOrigin);
  const studentSessionId = String(message.studentSessionId || '').trim();
  if (!negotiationId
    || !Number.isSafeInteger(startGeneration)
    || startGeneration < 1
    || !authContextId
    || !Number.isSafeInteger(authGeneration)
    || authGeneration < 0
    || !Number.isSafeInteger(connectionGeneration)
    || connectionGeneration < 1
    || !serverOrigin
    || !studentSessionId) return null;
  return {
    negotiationId,
    startGeneration,
    authContextId,
    authGeneration,
    connectionGeneration,
    serverOrigin,
    studentSessionId,
  };
}

function liveViewIdentityMatches(message = {}) {
  const identity = normalizeLiveViewIdentity(message);
  return Boolean(identity
    && identity.negotiationId === activeNegotiationId
    && identity.startGeneration === activeLiveViewStartGeneration
    && identity.authContextId === activeLiveViewAuthContextId
    && identity.authGeneration === activeLiveViewAuthGeneration
    && identity.connectionGeneration === activeLiveViewConnectionGeneration
    && identity.serverOrigin === activeLiveViewServerOrigin
    && identity.studentSessionId === activeLiveViewStudentSessionId);
}

function createLiveViewContext(identity) {
  return Object.freeze({
    negotiationId: identity.negotiationId,
    startGeneration: identity.startGeneration,
    authContextId: identity.authContextId,
    authGeneration: identity.authGeneration,
    connectionGeneration: identity.connectionGeneration,
    serverOrigin: identity.serverOrigin,
    studentSessionId: identity.studentSessionId,
  });
}

function liveViewContextIsCurrent(context, {
  peer = undefined,
  stream = undefined,
  restartGeneration = undefined,
} = {}) {
  if (!context || activeLiveViewContext !== context) return false;
  if (context.negotiationId !== activeNegotiationId
    || context.startGeneration !== activeLiveViewStartGeneration
    || context.authContextId !== activeLiveViewAuthContextId
    || context.authGeneration !== activeLiveViewAuthGeneration
    || context.connectionGeneration !== activeLiveViewConnectionGeneration
    || context.serverOrigin !== activeLiveViewServerOrigin
    || context.studentSessionId !== activeLiveViewStudentSessionId) return false;
  if (peer !== undefined && peerConnection !== peer) return false;
  if (stream !== undefined && localStream !== stream) return false;
  if (restartGeneration !== undefined
    && activeLiveViewRestartGeneration !== restartGeneration) return false;
  return true;
}

function liveViewContextPayload(context, restartGeneration = activeLiveViewRestartGeneration) {
  return {
    negotiationId: context.negotiationId,
    startGeneration: context.startGeneration,
    authContextId: context.authContextId,
    authGeneration: context.authGeneration,
    connectionGeneration: context.connectionGeneration,
    serverOrigin: context.serverOrigin,
    studentSessionId: context.studentSessionId,
    restartGeneration,
  };
}

function sendLiveViewMessageForContext(
  context,
  type,
  payload = {},
  restartGeneration = activeLiveViewRestartGeneration,
) {
  if (!liveViewContextIsCurrent(context, { restartGeneration })) return false;
  chrome.runtime.sendMessage({
    type,
    ...payload,
    ...liveViewContextPayload(context, restartGeneration),
  });
  return true;
}

function disposeDetachedStream(stream) {
  if (!stream || stream === localStream) return;
  stream.getTracks().forEach((track) => {
    track.onended = null;
    track.stop();
  });
}

function disposeDetachedPeer(peer) {
  if (!peer || peer === peerConnection) return;
  peer.onicecandidate = null;
  peer.onconnectionstatechange = null;
  peer.close();
}

function sendLiveViewMessage(type, payload = {}) {
  return chrome.runtime.sendMessage({
    type,
    ...liveViewIdentityPayload(),
    ...payload,
  });
}

function boundedLiveViewConnectionTime(nowValue = Date.now()) {
  if (!liveViewAttemptStartedAt) return 0;
  return Math.max(0, Math.min(90000, Math.round(nowValue - liveViewAttemptStartedAt)));
}

function candidateTelemetryFromStats(stats) {
  let selectedPair = null;
  for (const report of stats?.values?.() || []) {
    if (report?.type === 'transport' && report.selectedCandidatePairId) {
      selectedPair = stats.get(report.selectedCandidatePairId) || null;
      break;
    }
    if (report?.type === 'candidate-pair' && (report.selected === true || report.nominated === true)) {
      selectedPair = report;
    }
  }
  const local = selectedPair?.localCandidateId ? stats.get(selectedPair.localCandidateId) : null;
  const typeMap = { host: 'host', srflx: 'server_reflexive', relay: 'relay' };
  const selectedCandidateType = typeMap[String(local?.candidateType || '')] || 'unknown';
  let relayTransport;
  if (selectedCandidateType === 'relay') {
    const relayProtocol = String(local?.relayProtocol || '').toLowerCase();
    const protocol = String(local?.protocol || '').toLowerCase();
    const url = String(local?.url || '').toLowerCase();
    relayTransport = url.startsWith('turns:') || relayProtocol === 'tls'
      ? 'tls'
      : relayProtocol === 'udp' || protocol === 'udp'
        ? 'udp'
        : relayProtocol === 'tcp' || protocol === 'tcp'
          ? 'tcp'
          : 'unknown';
  }
  return { selectedCandidateType, ...(relayTransport ? { relayTransport } : {}) };
}

async function sendLiveViewAttemptTelemetry(outcome, expectedPeer = peerConnection) {
  const context = activeLiveViewContext;
  const attempt = Math.max(0, Math.min(2, Number(activeLiveViewRestartGeneration || 0)));
  const key = String(attempt);
  if (!context || liveViewTelemetryAttempts.has(key)) return false;
  let candidate = { selectedCandidateType: 'unknown' };
  if (outcome === 'connected' && expectedPeer?.getStats) {
    try {
      const stats = await expectedPeer.getStats();
      if (!liveViewContextIsCurrent(context, { peer: expectedPeer, restartGeneration: attempt })) {
        return false;
      }
      candidate = candidateTelemetryFromStats(stats);
    } catch {
      if (!liveViewContextIsCurrent(context, { peer: expectedPeer, restartGeneration: attempt })) {
        return false;
      }
    }
  }
  if (!liveViewContextIsCurrent(context, { peer: expectedPeer, restartGeneration: attempt })) {
    return false;
  }
  liveViewTelemetryAttempts.add(key);
  return sendLiveViewMessageForContext(context, 'LIVE_VIEW_ATTEMPT_TERMINAL', {
    attempt,
    outcome,
    connectionTimeMs: boundedLiveViewConnectionTime(),
    ...candidate,
  }, attempt);
}

function relayWsEvent(event, data) {
  chrome.runtime.sendMessage({
    type: 'WS_EVENT',
    event,
    data,
    connectionGeneration: proxyConnectionGeneration,
    authContextId: proxyAuthContextId,
    serverOrigin: proxyServerOrigin,
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
    authContextId: proxyAuthContextId,
    serverOrigin: proxyServerOrigin,
    liveViewIdentity: activeLiveViewContext
      ? liveViewContextPayload(activeLiveViewContext)
      : null,
  };
}

function handleWsConnect(url, authPayload, requestedGeneration, authContextId, serverOrigin) {
  const connectionGeneration = Number(requestedGeneration || 0);
  const normalizedAuthContextId = String(authContextId || '').trim();
  const normalizedServerOrigin = normalizedOrigin(serverOrigin);
  const socketOrigin = normalizedOrigin(url);
  if (!Number.isSafeInteger(connectionGeneration) || connectionGeneration < 1) {
    throw new Error('WS_CONNECT requires a positive connection generation');
  }
  if (!normalizedAuthContextId || !normalizedServerOrigin || socketOrigin !== normalizedServerOrigin) {
    throw new Error('WS_CONNECT requires one exact authentication context and server origin');
  }
  if (
    proxyWs &&
    proxyConnectionGeneration === connectionGeneration &&
    proxyUrl === url &&
    proxyAuthContextId === normalizedAuthContextId &&
    proxyServerOrigin === normalizedServerOrigin &&
    (proxyWs.readyState === WebSocket.CONNECTING || proxyWs.readyState === WebSocket.OPEN)
  ) {
    return wsStatus();
  }

  // A socket identity change is an authority transition. Revoke any capture
  // owned by the retired socket before detaching its close handler; otherwise
  // an MV3 worker restart could strand the old student's MediaStream.
  if (activeLiveViewContext) stopScreenShare();

  // Close any existing connection and keepalive
  if (wsKeepAliveTimer) { clearInterval(wsKeepAliveTimer); wsKeepAliveTimer = null; }
  if (proxyWs) {
    try { proxyWs.onclose = null; proxyWs.close(); } catch (e) { /* ignore */ }
    proxyWs = null;
  }

  proxyConnectionGeneration = connectionGeneration;
  proxyAuthenticated = false;
  proxyUrl = url;
  proxyAuthContextId = normalizedAuthContextId;
  proxyServerOrigin = normalizedServerOrigin;
  console.log('[Offscreen-WS] Connecting generation', connectionGeneration, 'to configured origin');
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

function handleWsSend(data, requestedGeneration, authContextId, serverOrigin) {
  if (
    proxyWs &&
    proxyWs.readyState === WebSocket.OPEN &&
    Number(requestedGeneration) === proxyConnectionGeneration &&
    String(authContextId || '').trim() === proxyAuthContextId &&
    normalizedOrigin(serverOrigin) === proxyServerOrigin
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

function handleWsClose(requestedGeneration, authContextId, serverOrigin) {
  if (requestedGeneration && Number(requestedGeneration) !== proxyConnectionGeneration) {
    return wsStatus();
  }
  if (authContextId && String(authContextId).trim() !== proxyAuthContextId) return wsStatus();
  if (serverOrigin && normalizedOrigin(serverOrigin) !== proxyServerOrigin) return wsStatus();
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
  proxyAuthContextId = null;
  proxyServerOrigin = null;
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
  'SCREENSHOT_CADENCE_START',
  'SCREENSHOT_CADENCE_STOP',
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
          message.mode,
          message.streamId,
          message,
          message.setupExpiresAt,
          message.expiresAt,
          message.iceServers,
          message.iceConfigurationExpiresAt,
        );
        sendResponse(result);
        return;
      }

      if (message.type === 'SIGNAL') {
        if (!liveViewIdentityMatches(message)) {
          sendResponse({ success: false, status: 'stale-negotiation' });
          return;
        }
        const result = await handleSignal(message.payload, activeLiveViewContext);
        sendResponse(result);
        return;
      }

      if (message.type === 'STOP_SHARE') {
        const identity = normalizeLiveViewIdentity(message);
        if (!identity || (activeNegotiationId && !liveViewIdentityMatches(identity))) {
          sendResponse({ success: false, status: 'stale-negotiation' });
          return;
        }
        if (!tombstoneLiveViewIdentity(identity)) {
          sendResponse({ success: false, status: 'stale-negotiation' });
          return;
        }
        stopScreenShare();
        sendResponse({ success: true });
        return;
      }

      if (message.type === 'WS_CONNECT') {
        sendResponse(handleWsConnect(
          message.url,
          message.authPayload,
          message.connectionGeneration,
          message.authContextId,
          message.serverOrigin
        ));
        return;
      }

      if (message.type === 'WS_SEND') {
        sendResponse(handleWsSend(
          message.data,
          message.connectionGeneration,
          message.authContextId,
          message.serverOrigin
        ));
        return;
      }

      if (message.type === 'WS_CLOSE') {
        sendResponse(handleWsClose(
          message.connectionGeneration,
          message.authContextId,
          message.serverOrigin
        ));
        return;
      }

      if (message.type === 'WS_STATUS') {
        sendResponse(wsStatus());
        return;
      }

      if (message.type === 'SCREENSHOT_CADENCE_START') {
        sendResponse(startScreenshotCadence(message));
        return;
      }

      if (message.type === 'SCREENSHOT_CADENCE_STOP') {
        sendResponse(handleScreenshotCadenceStop(message));
        return;
      }
    } catch (error) {
      console.error('[Offscreen] Unexpected error handling message');
      sendResponse({ success: false, error: 'OFFSCREEN_REQUEST_FAILED' });
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
  if (liveViewDisconnectTimer) clearTimeout(liveViewDisconnectTimer);
  liveViewSetupTimer = null;
  liveViewHardExpiryTimer = null;
  liveViewDisconnectTimer = null;
}

function parseFutureExpiry(value, fallbackMs, maximumMs) {
  const now = Date.now();
  const absent = value === undefined || value === null || String(value).trim() === '';
  if (absent) return now + fallbackMs;
  const parsed = typeof value === 'number' ? value : Date.parse(String(value || ''));
  if (!Number.isFinite(parsed) || parsed <= now || parsed > now + maximumMs) return 0;
  return parsed;
}

function sameLiveViewIdentity(left, right) {
  return Boolean(left && right
    && left.negotiationId === right.negotiationId
    && left.startGeneration === right.startGeneration
    && left.authContextId === right.authContextId
    && left.authGeneration === right.authGeneration
    && left.connectionGeneration === right.connectionGeneration
    && left.serverOrigin === right.serverOrigin
    && left.studentSessionId === right.studentSessionId);
}

function liveViewIdentityMatchesProxy(identity) {
  return Boolean(
    identity
    && proxyWs
    && proxyWs.readyState === WebSocket.OPEN
    && proxyAuthenticated === true
    && identity.authContextId === proxyAuthContextId
    && identity.connectionGeneration === proxyConnectionGeneration
    && identity.serverOrigin === proxyServerOrigin
  );
}

function sameLiveViewProxyAuthority(left, right) {
  return Boolean(left && right
    && left.authContextId === right.authContextId
    && left.connectionGeneration === right.connectionGeneration
    && left.serverOrigin === right.serverOrigin);
}

function liveViewIdentityIsNewer(candidate, prior) {
  if (!liveViewIdentityMatchesProxy(candidate)) return false;
  if (!prior || !sameLiveViewProxyAuthority(candidate, prior)) return true;
  return candidate.startGeneration > prior.startGeneration;
}

function tombstoneLiveViewIdentity(identity) {
  if (!liveViewIdentityMatchesProxy(identity)) return false;
  if (
    latestLiveViewIdentity
    && sameLiveViewProxyAuthority(identity, latestLiveViewIdentity)
    && identity.startGeneration < latestLiveViewIdentity.startGeneration
  ) return false;
  latestLiveViewIdentity = Object.freeze({ ...identity });
  return true;
}

function expireLiveView(reason, negotiationId) {
  if (!negotiationId || negotiationId !== activeNegotiationId) return;
  const identity = liveViewIdentityPayload();
  stopScreenShare();
  chrome.runtime.sendMessage({
    ...identity,
    type: 'LIVE_VIEW_EXPIRED',
    reason,
  });
}

function resolveLiveViewExpirySchedule(setupExpiresAt, expiresAt, iceConfigurationExpiresAt) {
  const now = Date.now();
  const sessionHardExpiry = parseFutureExpiry(expiresAt, 15 * 60 * 1000, 15 * 60 * 1000);
  const iceHardExpiry = iceConfigurationExpiresAt !== undefined
    && iceConfigurationExpiresAt !== null
    && String(iceConfigurationExpiresAt).trim() !== ''
    ? parseFutureExpiry(iceConfigurationExpiresAt, 10 * 60 * 1000, 11 * 60 * 1000)
    : sessionHardExpiry;
  if (!sessionHardExpiry || !iceHardExpiry) return null;
  const hardExpiry = Math.min(sessionHardExpiry, iceHardExpiry);
  const parsedSetupExpiry = parseFutureExpiry(setupExpiresAt, 90 * 1000, 90 * 1000);
  if (!parsedSetupExpiry) return null;
  const setupExpiry = Math.min(parsedSetupExpiry, hardExpiry);
  if (setupExpiry <= now || hardExpiry <= now) return null;
  return { setupExpiry, hardExpiry };
}

function scheduleLiveViewExpiry(
  setupExpiresAt,
  expiresAt,
  iceConfigurationExpiresAt,
  negotiationId,
  resolvedSchedule = null,
) {
  const schedule = resolvedSchedule || resolveLiveViewExpirySchedule(
    setupExpiresAt,
    expiresAt,
    iceConfigurationExpiresAt,
  );
  if (!schedule) return false;
  clearLiveViewExpiryTimers();
  const now = Date.now();
  liveViewSetupTimer = setTimeout(() => {
    if (!offerProcessed) expireLiveView('setup-expired', negotiationId);
  }, Math.max(0, schedule.setupExpiry - now));
  liveViewHardExpiryTimer = setTimeout(() => {
    expireLiveView('maximum-duration', negotiationId);
  }, Math.max(0, schedule.hardExpiry - now));
  return true;
}

function failLiveViewConnection(reason) {
  const identity = liveViewIdentityPayload();
  sendLiveViewAttemptTelemetry('failed', peerConnection);
  stopScreenShare();
  chrome.runtime.sendMessage({
    ...identity,
    type: 'CONNECTION_FAILED',
    reason,
  });
}

function attemptLiveViewIceRestart(expectedPeer) {
  if (peerConnection !== expectedPeer || !activeNegotiationId) return;
  if (expectedPeer.connectionState === 'connected') {
    if (liveViewDisconnectTimer) clearTimeout(liveViewDisconnectTimer);
    liveViewDisconnectTimer = null;
    return;
  }
  const now = Date.now();
  liveViewRestartAttempts = liveViewRestartAttempts.filter((attemptedAt) => attemptedAt >= now - 30000);
  if (liveViewRestartAttempts.length >= 2 || typeof expectedPeer.restartIce !== 'function') {
    failLiveViewConnection('ice-restart-exhausted');
    return;
  }
  sendLiveViewAttemptTelemetry('failed', expectedPeer);
  liveViewRestartAttempts.push(now);
  activeLiveViewRestartGeneration += 1;
  liveViewAttemptStartedAt = now;
  offerProcessed = false;
  iceQueue = [];
  try {
    expectedPeer.restartIce();
  } catch {
    failLiveViewConnection('ice-restart-failed');
    return;
  }
  sendLiveViewMessage('ICE_RESTART_REQUIRED');
  liveViewDisconnectTimer = setTimeout(() => {
    liveViewDisconnectTimer = null;
    attemptLiveViewIceRestart(expectedPeer);
  }, 5000);
}

function handleLiveViewConnectionInterruption(expectedPeer, connectionState) {
  if (peerConnection !== expectedPeer) return;
  if (connectionState === 'connected') {
    if (liveViewDisconnectTimer) clearTimeout(liveViewDisconnectTimer);
    liveViewDisconnectTimer = null;
    sendLiveViewAttemptTelemetry('connected', expectedPeer);
    return;
  }
  if (connectionState !== 'disconnected' && connectionState !== 'failed') return;
  if (liveViewDisconnectTimer) return;
  liveViewDisconnectTimer = setTimeout(() => {
    liveViewDisconnectTimer = null;
    attemptLiveViewIceRestart(expectedPeer);
  }, connectionState === 'disconnected' ? 5000 : 0);
}

async function startScreenCapture(
  mode = 'auto',
  streamId = null,
  identityMessage = null,
  setupExpiresAt = null,
  expiresAt = null,
  providedIceServers = null,
  iceConfigurationExpiresAt = null,
) {
  console.log('[Offscreen] Starting screen capture, mode:', safeDiagnosticLabel(mode), 'streamId:', !!streamId);

  const identity = normalizeLiveViewIdentity(identityMessage || {});
  if (!identity) {
    return { success: false, status: 'missing-negotiation', error: 'Missing Live View authority' };
  }
  if (!liveViewIdentityMatchesProxy(identity)) {
    return { success: false, status: 'stale-negotiation', error: 'Retired Live View transport' };
  }
  const iceServers = providedIceServers === null
    ? ICE_SERVERS
    : Array.isArray(providedIceServers) && providedIceServers.length > 0
      ? providedIceServers
      : null;
  if (!iceServers) {
    return { success: false, status: 'invalid-ice-configuration', error: 'Invalid ICE configuration' };
  }
  const expirySchedule = resolveLiveViewExpirySchedule(
    setupExpiresAt,
    expiresAt,
    iceConfigurationExpiresAt,
  );
  if (!expirySchedule) {
    return { success: false, status: 'expired-request', error: 'Live View request expired' };
  }
  if (activeLiveViewContext && liveViewIdentityMatches(identity)) {
    return { success: true, status: 'already-active' };
  }
  if (!liveViewIdentityIsNewer(identity, latestLiveViewIdentity)) {
    return { success: false, status: 'stale-negotiation', error: 'Stale Live View request' };
  }
  latestLiveViewIdentity = Object.freeze({ ...identity });

  // Every capture attempt is a new negotiation. Reset the duplicate-offer
  // guard, queued ICE, teacher identity, tracks, and peer together so a failed
  // or stopped attempt can be retried without restarting the extension.
  stopScreenShare();
  activeNegotiationId = identity.negotiationId;
  activeLiveViewStartGeneration = identity.startGeneration;
  activeLiveViewAuthContextId = identity.authContextId;
  activeLiveViewAuthGeneration = identity.authGeneration;
  activeLiveViewConnectionGeneration = identity.connectionGeneration;
  activeLiveViewServerOrigin = identity.serverOrigin;
  activeLiveViewStudentSessionId = identity.studentSessionId;
  activeLiveViewRestartGeneration = 0;
  const captureContext = createLiveViewContext(identity);
  activeLiveViewContext = captureContext;
  liveViewRestartAttempts = [];
  liveViewAttemptStartedAt = Date.now();
  liveViewTelemetryAttempts = new Set();
  if (!scheduleLiveViewExpiry(
    setupExpiresAt,
    expiresAt,
    iceConfigurationExpiresAt,
    activeNegotiationId,
    expirySchedule,
  )) {
    stopScreenShare();
    return { success: false, status: 'expired-request', error: 'Live View request expired' };
  }

  let capturedStream = null;
  let createdPeer = null;
  try {
    if (Date.now() >= expirySchedule.setupExpiry || Date.now() >= expirySchedule.hardExpiry) {
      stopScreenShare();
      return { success: false, status: 'expired-request', error: 'Live View request expired' };
    }
    // Method 1: Use streamId from service worker (MV3 tab capture)
    if (streamId) {
      try {
        console.log('[Offscreen] Using streamId from service worker for tab capture...');
        const stream = await navigator.mediaDevices.getUserMedia({
          video: {
            mandatory: {
              chromeMediaSource: 'tab',
              chromeMediaSourceId: streamId
            }
          },
          audio: false
        });
        if (!liveViewContextIsCurrent(captureContext)) {
          disposeDetachedStream(stream);
          return { success: false, status: 'stale-negotiation' };
        }
        capturedStream = stream;
        console.log('[Offscreen] Tab capture via streamId succeeded');
      } catch (streamIdError) {
        if (!liveViewContextIsCurrent(captureContext)) {
          return { success: false, status: 'stale-negotiation' };
        }
        console.info('[Offscreen] streamId capture failed');
        // Fall through to getDisplayMedia fallback
      }
    }

    // Method 2: Fall back to getDisplayMedia (shows picker on unmanaged devices)
    if (!capturedStream && (mode === 'auto' || mode === 'screen')) {
      console.log('[Offscreen] Using getDisplayMedia (screen picker)...');
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          video: {
            frameRate: 15,
            width: { ideal: 1280 },
            height: { ideal: 720 }
          },
          audio: false
        });
        if (!liveViewContextIsCurrent(captureContext)) {
          disposeDetachedStream(stream);
          return { success: false, status: 'stale-negotiation' };
        }
        capturedStream = stream;
        console.log('[Offscreen] getDisplayMedia succeeded');
      } catch (pickerError) {
        if (!liveViewContextIsCurrent(captureContext)) {
          return { success: false, status: 'stale-negotiation' };
        }
        if (pickerError.name === 'NotAllowedError' || pickerError.name === 'AbortError') {
          console.info('[Offscreen] User denied screen share or closed picker (expected)');
          sendLiveViewMessageForContext(captureContext, 'CAPTURE_ERROR', {
            error: 'Student denied screen share request'
          });
          stopScreenShare();
          return { success: false, status: 'user-denied' };
        }
        const safeError = safeCaptureError(pickerError);
        console.error('[Offscreen] getDisplayMedia failed');
        sendLiveViewMessageForContext(captureContext, 'CAPTURE_ERROR', {
          error: safeError.message,
          errorCode: safeError.code,
        });
        stopScreenShare();
        return { success: false, status: 'failed', error: safeError.code };
      }
    }

    // No stream obtained
    if (!capturedStream) {
      const msg = mode === 'tab'
        ? 'Silent tab capture not available on this device'
        : 'No capture method succeeded';
      console.warn('[Offscreen]', msg);
      sendLiveViewMessageForContext(captureContext, 'CAPTURE_ERROR', { error: msg });
      stopScreenShare();
      return { success: false, status: 'tab-capture-unavailable' };
    }

    // Create peer connection
    createdPeer = new RTCPeerConnection({ iceServers });
    if (!liveViewContextIsCurrent(captureContext)) {
      disposeDetachedStream(capturedStream);
      disposeDetachedPeer(createdPeer);
      return { success: false, status: 'stale-negotiation' };
    }
    localStream = capturedStream;
    peerConnection = createdPeer;
    const activePeerConnection = createdPeer;
    const activeStream = capturedStream;

    // Handle ICE candidates - send to teacher via service worker
    activePeerConnection.onicecandidate = (event) => {
      if (event.candidate && liveViewContextIsCurrent(captureContext, {
        peer: activePeerConnection,
        stream: activeStream,
      })) {
        console.log('[Offscreen] Got ICE candidate, sending to teacher');
        sendLiveViewMessageForContext(captureContext, 'ICE_CANDIDATE', {
          candidate: event.candidate.toJSON(),
        });
      }
    };

    // Handle connection state changes
    activePeerConnection.onconnectionstatechange = () => {
      const connectionState = activePeerConnection.connectionState;
      console.log('[Offscreen] Connection state:', connectionState);
      handleLiveViewConnectionInterruption(activePeerConnection, connectionState);
    };

    // Add tracks to peer connection
    activeStream.getTracks().forEach(track => {
      track.onended = () => {
        if (!liveViewContextIsCurrent(captureContext, {
          peer: activePeerConnection,
          stream: activeStream,
        })) return;
        const identityPayload = liveViewContextPayload(captureContext);
        stopScreenShare();
        chrome.runtime.sendMessage({
          ...identityPayload,
          type: 'CONNECTION_FAILED',
          reason: 'capture-track-ended',
        });
      };
      activePeerConnection.addTrack(track, activeStream);
    });

    console.log('[Offscreen] Tracks added to peer connection, ready to receive offer');
    return { success: true };

  } catch (error) {
    if (!liveViewContextIsCurrent(captureContext)) {
      disposeDetachedStream(capturedStream);
      disposeDetachedPeer(createdPeer);
      return { success: false, status: 'stale-negotiation' };
    }
    disposeDetachedStream(capturedStream);
    disposeDetachedPeer(createdPeer);
    const safeError = safeCaptureError(error);
    console.error('[Offscreen] Unexpected screen capture error');
    sendLiveViewMessageForContext(captureContext, 'CAPTURE_ERROR', {
      error: safeError.message,
      errorCode: safeError.code,
    });
    stopScreenShare();
    return { success: false, status: 'failed', error: safeError.code };
  }
}

// Handle signaling messages (offer, answer, ICE)
let offerProcessed = false; // Guard against duplicate offer processing from setTimeout retries

async function handleSignal(signal, expectedContext = activeLiveViewContext) {
  const signalContext = expectedContext;
  try {
    console.log('[Offscreen] Handling signal:', safeDiagnosticLabel(signal.type));
    const restartGeneration = Number(signal.restartGeneration || 0);
    if (!Number.isSafeInteger(restartGeneration)
      || !liveViewContextIsCurrent(signalContext, { restartGeneration })) {
      return { success: false, status: 'stale-negotiation' };
    }

    if (signal.type === 'offer') {
      if (!signal.negotiationId || signal.negotiationId !== activeNegotiationId) {
        return { success: false, status: 'stale-negotiation' };
      }
      if (!peerConnection) {
        console.log('[Offscreen] Received offer before peer connection ready, queueing (expected)...');
        setTimeout(() => {
          if (!liveViewContextIsCurrent(signalContext, { restartGeneration })) return;
          void handleSignal(signal, signalContext);
        }, 500);
        return { success: true, status: 'queued' };
      }

      const signalPeer = peerConnection;
      const signalIceQueue = iceQueue;

      // Prevent duplicate processing from multiple setTimeout retries
      if (offerProcessed) {
        console.log('[Offscreen] Offer already processed, skipping duplicate');
        return { success: true, status: 'already-processed' };
      }
      offerProcessed = true;

      teacherId = signal.from;
      await signalPeer.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      if (!liveViewContextIsCurrent(signalContext, {
        peer: signalPeer,
        restartGeneration,
      })) return { success: false, status: 'stale-negotiation' };
      console.log('[Offscreen] Set remote description (offer)');

      const answer = await signalPeer.createAnswer();
      if (!liveViewContextIsCurrent(signalContext, {
        peer: signalPeer,
        restartGeneration,
      })) return { success: false, status: 'stale-negotiation' };
      await signalPeer.setLocalDescription(answer);
      if (!liveViewContextIsCurrent(signalContext, {
        peer: signalPeer,
        restartGeneration,
      })) return { success: false, status: 'stale-negotiation' };
      console.log('[Offscreen] Created and set local description (answer)');
      if (liveViewSetupTimer) clearTimeout(liveViewSetupTimer);
      liveViewSetupTimer = null;

      // Send answer back to teacher via service worker
      sendLiveViewMessageForContext(signalContext, 'ANSWER', {
        sdp: signalPeer.localDescription.toJSON(),
      }, restartGeneration);

      // Flush queued ICE candidates now that remote description is set
      const queueFlushed = await flushIceQueue(
        signalContext,
        signalPeer,
        signalIceQueue,
        restartGeneration,
      );
      if (!queueFlushed) return { success: false, status: 'stale-negotiation' };

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
      
      const signalPeer = peerConnection;
      const signalIceQueue = iceQueue;
      if (!signalPeer.remoteDescription) {
        console.info('[Offscreen] Remote description not set yet, queueing ICE candidate');
        signalIceQueue.push(signal.candidate);
        return { success: true, status: 'queued' };
      }
      
      try {
        await signalPeer.addIceCandidate(new RTCIceCandidate(signal.candidate));
        if (!liveViewContextIsCurrent(signalContext, {
          peer: signalPeer,
          restartGeneration,
        })) return { success: false, status: 'stale-negotiation' };
        console.log('[Offscreen] Added ICE candidate');
        return { success: true };
      } catch (iceError) {
        if (!liveViewContextIsCurrent(signalContext, {
          peer: signalPeer,
          restartGeneration,
        })) return { success: false, status: 'stale-negotiation' };
        // Late ICE candidates are expected and safe to ignore
        console.info('[Offscreen] ICE candidate add failed (expected for late candidates)');
        return { success: true, status: 'late-candidate' };
      }
    }
    
    return { success: true };
    
  } catch (error) {
    if (!liveViewContextIsCurrent(signalContext)) {
      return { success: false, status: 'stale-negotiation' };
    }
    // Log with name + message for DOMExceptions
    console.error('[Offscreen] Unexpected signaling error');
    return { success: false, error: error.message || String(error) };
  }
}

// Flush queued ICE candidates after remote description is set
async function flushIceQueue(context, expectedPeer, expectedQueue, restartGeneration) {
  if (!liveViewContextIsCurrent(context, {
    peer: expectedPeer,
    restartGeneration,
  })) return false;
  if (expectedQueue.length === 0) return true;

  console.log(`[Offscreen] Flushing ${expectedQueue.length} queued ICE candidates`);

  while (expectedQueue.length > 0) {
    if (!liveViewContextIsCurrent(context, {
      peer: expectedPeer,
      restartGeneration,
    })) return false;
    const candidate = expectedQueue.shift();
    try {
      await expectedPeer.addIceCandidate(new RTCIceCandidate(candidate));
      if (!liveViewContextIsCurrent(context, {
        peer: expectedPeer,
        restartGeneration,
      })) return false;
    } catch (error) {
      if (!liveViewContextIsCurrent(context, {
        peer: expectedPeer,
        restartGeneration,
      })) return false;
      // Late candidates are safe to ignore
      console.info('[Offscreen] Queued ICE candidate add failed (safe to ignore)');
    }
  }
  
  console.log('[Offscreen] ICE queue flushed');
  return true;
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
  activeLiveViewStartGeneration = 0;
  activeLiveViewAuthContextId = null;
  activeLiveViewAuthGeneration = 0;
  activeLiveViewConnectionGeneration = 0;
  activeLiveViewServerOrigin = null;
  activeLiveViewStudentSessionId = null;
  activeLiveViewRestartGeneration = 0;
  activeLiveViewContext = null;
  liveViewRestartAttempts = [];
  liveViewAttemptStartedAt = 0;
  liveViewTelemetryAttempts = new Set();
  
  console.log('[Offscreen] Cleanup complete');
}
