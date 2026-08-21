// ClassPilot - Service Worker
// Handles background heartbeat sending and tab monitoring

try {
  importScripts('config.js');
} catch (error) {
  console.info('[Config] No config.js override loaded; using managed policy or defaults');
}
importScripts('classroom-runtime-core.js');
importScripts('vendor/sentry.browser.min.js');

const RuntimeCore = globalThis.ClassPilotRuntimeCore;

const SENTRY_DSN_EXTENSION = globalThis.SENTRY_DSN_EXTENSION || '';
const SENTRY_ENV = globalThis.SENTRY_ENV || 'development';
const SENTRY_DEV_MODE = globalThis.SENTRY_DEV_MODE === true;
let devExceptionSent = false;

const SENTRY_SENSITIVE_KEY_REGEX = /(email|student|name)/i;
const SENTRY_URL_KEY_REGEX = /url/i;
const SENTRY_EMAIL_REGEX = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const SENTRY_URL_REGEX = /https?:\/\/\S+/i;

function sanitizeSentryUrl(value) {
  if (typeof value !== 'string') return undefined;
  try {
    const parsed = new URL(value);
    return `${parsed.protocol}//${parsed.host}`;
  } catch (error) {
    const withoutQuery = value.split('?')[0];
    if (withoutQuery && withoutQuery !== value) {
      return withoutQuery;
    }
    return '[redacted]';
  }
}

function scrubSentryString(value, key) {
  if (SENTRY_EMAIL_REGEX.test(value)) {
    return '[redacted]';
  }
  if (SENTRY_URL_REGEX.test(value)) {
    return sanitizeSentryUrl(value);
  }
  if (key && SENTRY_SENSITIVE_KEY_REGEX.test(key)) {
    return '[redacted]';
  }
  if (key && SENTRY_URL_KEY_REGEX.test(key)) {
    return sanitizeSentryUrl(value);
  }
  return value;
}

function scrubSentryData(value, key) {
  if (typeof value === 'string') {
    return scrubSentryString(value, key);
  }
  if (Array.isArray(value)) {
    return value.map((item) => scrubSentryData(item, key));
  }
  if (value && typeof value === 'object') {
    const cleaned = {};
    for (const [childKey, childValue] of Object.entries(value)) {
      cleaned[childKey] = scrubSentryData(childValue, childKey);
    }
    return cleaned;
  }
  return value;
}

if (!globalThis.__classpilotSentryInitialized && globalThis.Sentry?.init && SENTRY_DSN_EXTENSION) {
  globalThis.Sentry.init({
    dsn: SENTRY_DSN_EXTENSION,
    environment: SENTRY_ENV,
    tracesSampleRate: 0,
    sendDefaultPii: false,
    beforeSend(event) {
      if (event.request?.url) {
        event.request.url = sanitizeSentryUrl(event.request.url);
      }
      if (event.request) {
        delete event.request.headers;
        delete event.request.cookies;
        delete event.request.query_string;
      }
      if (event.breadcrumbs) {
        event.breadcrumbs = event.breadcrumbs.map((crumb) => ({
          ...crumb,
          message: crumb.message ? scrubSentryString(crumb.message, 'message') : crumb.message,
          data: crumb.data ? scrubSentryData(crumb.data) : crumb.data,
        }));
      }
      if (event.extra) {
        event.extra = scrubSentryData(event.extra);
      }
      if (event.tags) {
        event.tags = scrubSentryData(event.tags);
      }
      return event;
    },
  });
  globalThis.__classpilotSentryInitialized = true;
}

// Production server URL - can be overridden in extension settings
const DEFAULT_SERVER_URL = 'https://school-pilot.net';
const INJECTED_SERVER_URL = typeof globalThis.CLASSPILOT_SERVER_URL === 'string'
  ? globalThis.CLASSPILOT_SERVER_URL
  : '';

let CONFIG = {
  serverUrl: DEFAULT_SERVER_URL,
  deviceId: null,
  studentName: null,
  studentEmail: null,
  studentToken: null,
  classId: null,
  isSharing: false,
  activeStudentId: null,
  activeStudentSessionId: null,
  schoolId: null,
  schoolSlug: null,
  enrollmentKey: null,
  identitySource: null,
  manualLoginLastSeenAt: null,
  autoRegistrationPaused: false,
};

let ws = null; // Legacy reference, kept for compatibility checks
let wsConnected = false; // True only after the current WebSocket generation is authenticated
let wsTransportConnected = false;
let wsConnectionGeneration = 0;
let wsAuthenticatedGeneration = 0;
let wsConnectInFlight = null;
let wsMessageProcessingGeneration = 0;
let wsMessageProcessingTail = Promise.resolve();
let wsAuthenticatedResponseGuard = null;
let studentAuthInvalidating = false;
let studentAuthCommitPending = false;
let studentAuthCommitPendingGeneration = 0;
let authCommitRecoveryPromise = Promise.resolve();
let resolveAuthCommitRecovery = null;
let rejectAuthCommitRecovery = null;
let studentAuthMutationGeneration = 0;
let studentAuthMutationTail = Promise.resolve();
let chromeProfileRegistrationInFlight = null;
let manualStudentLoginPendingGeneration = 0;

const CLIENT_PROTOCOL_VERSION = 2;
const EXTENSION_CAPABILITIES = Object.freeze([
  'classroomStateV1',
  'fabStateRevisionV1',
  'exactTabCloseV1',
  'screenOnlyUnlockV1',
  'durableChatAckV1',
  'commandAckReceiptV1',
  'classroomOverlayRestoreV1',
  'liveViewNegotiationV1',
]);

function extensionProtocolDescriptor() {
  return {
    clientProtocolVersion: CLIENT_PROTOCOL_VERSION,
    extensionVersion: chrome.runtime.getManifest().version,
    capabilities: [...EXTENSION_CAPABILITIES],
  };
}

// Send a message via the WebSocket proxy in the offscreen document
async function wsSend(data) {
  if (!wsConnected || wsAuthenticatedGeneration !== wsConnectionGeneration) return false;
  const str = typeof data === 'string' ? data : JSON.stringify(data);
  try {
    const response = await sendToOffscreen({
      type: 'WS_SEND',
      data: str,
      connectionGeneration: wsConnectionGeneration,
    });
    return response?.success === true;
  } catch (error) {
    console.warn('[WebSocket] Send deferred:', error?.message || error);
    return false;
  }
}

function normalizeCommandId(commandId) {
  return String(commandId || '').trim();
}

function getCommandIdFromMessage(message, command) {
  return normalizeCommandId(
    message?.commandId ||
    message?.data?.commandId ||
    message?.command?.commandId ||
    command?.commandId ||
    command?.data?.commandId
  );
}

function commandErrorMessage(error) {
  return error?.message || String(error || 'Command failed');
}

function currentChromiumVersion() {
  const match = /(?:Chrome|Chromium)\/([0-9.]+)/.exec(globalThis.navigator?.userAgent || '');
  return match?.[1] || null;
}

async function sendCommandAck(commandId, ackState, options = {}) {
  const normalizedCommandId = normalizeCommandId(commandId);
  if (!normalizedCommandId) return false;

  const defaultOutcome = {
    received: 'pending',
    completed: 'applied',
    failed: 'failed',
    expired: 'expired',
  }[ackState] || 'pending';

  const ack = {
    type: 'command-ack',
    ackId: `${normalizedCommandId}:${ackState}`,
    commandId: normalizedCommandId,
    ackState,
    commandType: options.commandType,
    studentId: CONFIG.activeStudentId || undefined,
    deviceId: CONFIG.deviceId || undefined,
    result: options.result,
    state: options.state,
    error: options.error,
    deliveryPolicy: options.deliveryPolicy,
    expiresAt: options.expiresAt,
    appliedRevision: options.appliedRevision ?? currentClassroomState?.revision ?? 0,
    outcome: options.outcome || defaultOutcome,
    extensionVersion: chrome.runtime.getManifest().version,
    timestamp: new Date().toISOString(),
  };

  await enqueueCommandAck(ack);
  await wsSend(ack);
  scheduleCommandAckFlush();
  return true;
}
let cameraActive = false; // Track camera usage across all tabs

// Adaptive tracking state machine
// ACTIVE: within school hours and user active
// IDLE: within school hours but user idle/locked
// OFF: outside school hours (unless monitoring outside hours is allowed)
const TRACKING_STATES = {
  ACTIVE: 'ACTIVE',
  IDLE: 'IDLE',
  OFF: 'OFF',
};

const SCHOOL_SETTINGS_CACHE_KEY = 'schoolSettings';
const SCHOOL_SETTINGS_FETCHED_AT_KEY = 'schoolSettingsFetchedAt';
const SETTINGS_FETCH_INTERVAL_MS = 60 * 60 * 1000;
const IDLE_DETECTION_SECONDS = 180;
// Heartbeat frequency: 30s for both active and idle states
// We keep the same frequency because Chrome's "idle" detection (no keyboard/mouse)
// doesn't mean the student is away - they could be watching a video or reading.
// The server will display the student's actual activity regardless of idle state.
const HEARTBEAT_INTERVAL_MS = 10000;  // 10 seconds - using setInterval to bypass Chrome alarms minimum
const HEARTBEAT_ACTIVE_MINUTES = 0.5;  // 30 seconds - fallback for Chrome alarms
const HEARTBEAT_IDLE_MINUTES = 0.5;    // 30 seconds - fallback for Chrome alarms
const OBSERVED_HEARTBEAT_SECONDS = 10;  // Faster updates when teacher is watching
const NAVIGATION_DEBOUNCE_MS = 50;      // Reduced from 350ms for near-instant tracking
const LICENSE_CHECK_INTERVAL_MS = 10 * 60 * 1000;
const LICENSE_CONTROL_CLEANUP_ALARM = 'license-control-cleanup';
const LICENSE_CONTROL_CLEANUP_RETRY_MS = 15 * 1000;
const MANUAL_LOGIN_STALE_MS = 5 * 60 * 1000;
// Permit only sub-second scheduling/serialization skew. A larger future value
// usually means the Chromebook clock moved backwards and must not extend a
// shared-device login indefinitely.
const MANUAL_LOGIN_FUTURE_SKEW_MS = 1000;
const SHARED_AUTH_LOCK_TIMEOUT_MS = MANUAL_LOGIN_STALE_MS;
const SHARED_AUTH_LOCK_ALARM_NAME = 'shared-auth-lock-timeout';
const SHARED_SIGN_IN_CONFIG_FETCH_INTERVAL_MS = 5 * 60 * 1000;
const SHARED_SIGN_IN_CONFIG_CACHE_KEY = 'sharedSignInConfigCacheV1';
const MANAGED_AUTH_GATE_BINDING_KEY = 'managedAuthGateBindingV1';
const SHARED_SIGN_IN_CONFIG_CACHE_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const SHARED_SIGN_IN_CONFIG_RETRY_ALARM = 'shared-sign-in-config-retry';
const SHARED_SIGN_IN_CONFIG_RETRY_DELAYS_MS = Object.freeze([2000, 5000, 15000, 30000]);
const AUTH_GATE_REQUEST_TIMEOUT_MS = 5000;
const AUTH_GATE_TIMING_STORAGE_KEY = 'authGateTimingV1';
const AUTH_GATE_REVISION_STORAGE_KEY = 'authGateRevisionV1';
// Each worker durably reserves its own numeric range before auth-state replies
// are released. A later worker therefore starts above every revision its
// predecessor could have emitted, even if the device clock moved backwards.
const AUTH_GATE_REVISION_BLOCK_SIZE = 1000000;
const AUTH_GATE_REVISION_RESERVE_THRESHOLD = 10000;
const CLASSPILOT_PRODUCTION_EXTENSION_ID = 'iggbfegfcjkfieoemeolfmfnapepalca';
const HEALTH_CHECK_ALARM_NAME = 'health-check';
const CONNECTIVITY_HEALTH_STORAGE_KEY = 'connectivityHealthV1';
const CONNECTIVITY_HEALTH_ALARM_NAME = 'connectivity-health-boundary';
const SCREENSHOT_HEALTH_STORAGE_KEY = 'screenshotHealthV1';
const MESSAGE_INBOX_STORAGE_KEY = 'messages';
const MESSAGE_INBOX_BINDING_KEY = 'messageInboxAuthBindingV1';
const MESSAGE_INBOX_DEDUP_KEY = 'messageInboxSeenIdsV1';
const FAB_STATE_STORAGE_KEY = 'fabStateV1';
const FAB_CONTEXT_STORAGE_KEY = 'fabContextV1';
const FAB_CHAT_CONTEXT_STORAGE_KEY = 'fabChatContextV1';
const CLASSROOM_OVERLAY_STORAGE_KEY = 'classroomOverlayStateV1';
const CLASSROOM_OVERLAY_EXPIRY_ALARM = 'classroom-overlay-expiry';
const API_RETRY_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);
const API_RETRY_MAX_ATTEMPTS = 3;
const API_RETRY_BASE_DELAY_MS = 1000;
const API_RETRY_RATE_LIMIT_DELAY_MS = 10000;
const API_RETRY_MAX_DELAY_MS = 30000;
const STARTUP_JITTER_MIN_MS = 1500;
const STARTUP_JITTER_MAX_MS = 12000;
const MANAGED_CONFIG_KEYS = [
  'serverUrl',
  'classpilotServerUrl',
  'schoolId',
  'classpilotSchoolId',
  'schoolSlug',
  'classpilotSchoolSlug',
  'enrollmentKey',
  'classpilotEnrollmentKey',
  'fastAuthGateEnabled',
];

let trackingState = TRACKING_STATES.OFF;
let idleState = 'active';
let schoolSettings = null;
let schoolSettingsFetchedAt = 0;
const MONITORING_STATE_STORAGE_KEY = 'monitoringStateV1';
let persistedMonitoringState = {
  state: TRACKING_STATES.OFF,
  changedAt: Date.now(),
  reason: 'worker_default',
};

let connectivityHealth = RuntimeCore.emptyConnectivityHealth();
let screenshotHealth = RuntimeCore.emptyScreenshotHealth();

// Screenshot health tracking (sent with heartbeat for dashboard diagnostics)
let lastScreenshotAttemptAt = 0;
let lastScreenshotSuccessAt = 0;
let lastScreenshotErrorAt = 0;
let lastScreenshotError = '';
let screenshotAttemptCount = 0;
let screenshotSuccessCount = 0;
let wsReconnectBackoffMs = 10000; // Start with 10s to reduce console noise during deploys
let navigationDebounceTimers = new Map();
let pendingNavigationEvents = new Map();
let idleListenerReady = false;
let lastKnownTabs = []; // Cache tabs to prevent flickering when query returns partial results
const TAB_SNAPSHOT_STORAGE_KEY = 'tabSnapshotV1';
let tabSnapshotMutation = Promise.resolve();
let currentTabSnapshotRevision = 0;
let settingsAlarmScheduled = false;
let heartbeatIntervalId = null;
let observedHeartbeatTimer = null;
let observedByTeacher = false;
let lastObservedSignature = null;
let lastObservedSentAt = 0;
let licenseActive = true;
let offHoursNetworkPaused = false;
let registrationRetryCount = 0;
const MAX_REGISTRATION_RETRIES = 5;
let apiBackoffUntilMs = 0;
let heartbeatInFlight = false;
let heartbeatPendingReason = null;
let screenshotCaptureInFlight = false;
let currentFabState = null;
let isScheduleHardOff = false;
let sharedAuthLockedSinceAt = 0;
let fastAuthGateEnabled = true;
let authGateStateRevision = Date.now();
let authGateStateRevisionCeiling = 0;
let authGateStatePendingRevisionBumps = 0;
let authGateRevisionExtensionPromise = null;
let authGateRevisionReady = false;
let resolveAuthGateRevisionReady;
let rejectAuthGateRevisionReady;
const authGateRevisionReadyPromise = new Promise((resolve, reject) => {
  resolveAuthGateRevisionReady = resolve;
  rejectAuthGateRevisionReady = reject;
});
authGateRevisionReadyPromise.catch(() => {});
let lastAuthGateAuthRequired = null;
let authGateStateColdWorker = false;
let ordinaryAuthStateColdCohortOpen = true;
let sharedSignInConfigGeneration = 0;
let sharedSignInConfigRetryAttempt = 0;
let managedAuthGatePolicyGeneration = 0;
let managedAuthGateSetupUnavailable = false;
let managedAuthGatePolicyRestorePromise = Promise.resolve({});
let managedAuthGateDirectRevalidationInFlight = null;
let sharedSignInLoginConfig = {
  phase: 'loading',
  fetchedAt: 0,
  retryAt: null,
  setupRequired: false,
  sharedSignInEnabled: false,
  loginMethod: 'name_pin',
  pinLoginEnabled: false,
  schoolId: null,
  passpilotKioskAvailable: false,
};
let sharedSignInConfigPromise = null;
// Managed-device kiosk identity (2.6.9): the enrolled Chromebook's directory
// id, hashed into UUID shape and appended to the kiosk launch URL so PassPilot
// kiosk device memory survives the per-profile storage wipes on shared
// devices. null until resolved; stays null on unmanaged/consumer installs
// (the enterprise API object is undefined there).
let managedKioskDeviceId = null;
let managedKioskDeviceIdProbe = null;

function bumpAuthGateStateRevision() {
  // The reserved block is intentionally far larger than a worker can consume
  // in its lifetime. Do not consult Date.now() here: a forward clock jump could
  // escape the durable range and make the next worker's revision go backwards.
  if (!authGateRevisionReady) {
    authGateStateRevision += 1;
    return authGateStateRevision;
  }
  if (authGateStateRevision >= authGateStateRevisionCeiling) {
    authGateStatePendingRevisionBumps += 1;
    extendAuthGateRevisionReservation().catch(() => {});
    return authGateStateRevision;
  }
  authGateStateRevision += 1;
  if (
    authGateStateRevisionCeiling - authGateStateRevision
    <= AUTH_GATE_REVISION_RESERVE_THRESHOLD
  ) {
    extendAuthGateRevisionReservation().catch(() => {});
  }
  return authGateStateRevision;
}

function extendAuthGateRevisionReservation() {
  if (authGateRevisionExtensionPromise) return authGateRevisionExtensionPromise;
  const run = (async () => {
    do {
      const nextCeiling = authGateStateRevisionCeiling + AUTH_GATE_REVISION_BLOCK_SIZE;
      if (!Number.isSafeInteger(nextCeiling)) {
        throw new Error('Auth gate revision space exhausted');
      }
      await durableLocalKv.set({ [AUTH_GATE_REVISION_STORAGE_KEY]: nextCeiling });
      authGateStateRevisionCeiling = nextCeiling;
      const bumpsToApply = Math.min(
        authGateStatePendingRevisionBumps,
        authGateStateRevisionCeiling - authGateStateRevision,
      );
      authGateStateRevision += bumpsToApply;
      authGateStatePendingRevisionBumps -= bumpsToApply;
    } while (authGateStatePendingRevisionBumps > 0);
    return authGateStateRevision;
  })();
  authGateRevisionExtensionPromise = run.finally(() => {
    if (authGateRevisionExtensionPromise === trackedRun) {
      authGateRevisionExtensionPromise = null;
    }
  });
  const trackedRun = authGateRevisionExtensionPromise;
  trackedRun.catch(() => {});
  return trackedRun;
}

async function awaitAuthGateRevisionPublicationReady() {
  await authGateRevisionReadyPromise;
  while (authGateStatePendingRevisionBumps > 0) {
    await extendAuthGateRevisionReservation();
  }
}

async function reserveAuthGateRevisionBlock(storedRevisionCeiling) {
  const parsedCeiling = Number(storedRevisionCeiling);
  const priorCeiling = Number.isSafeInteger(parsedCeiling) && parsedCeiling >= 0
    ? parsedCeiling
    : 0;
  const nextRevision = Math.max(authGateStateRevision, Date.now(), priorCeiling + 1);
  if (!Number.isSafeInteger(nextRevision + AUTH_GATE_REVISION_BLOCK_SIZE)) {
    throw new Error('Auth gate revision space exhausted');
  }
  const nextCeiling = nextRevision + AUTH_GATE_REVISION_BLOCK_SIZE;
  // Persist the end of the range, not merely the first emitted value. A crash
  // at any point in this worker's lifetime still forces its successor above
  // every revision this worker was allowed to publish.
  await durableLocalKv.set({ [AUTH_GATE_REVISION_STORAGE_KEY]: nextCeiling });
  authGateStateRevision = Math.max(authGateStateRevision, nextRevision);
  authGateStateRevisionCeiling = nextCeiling;
  authGateRevisionReady = true;
  resolveAuthGateRevisionReady(authGateStateRevision);
  return authGateStateRevision;
}

function resetSharedSignInLoginConfigCache(options = {}) {
  sharedSignInConfigGeneration += 1;
  sharedSignInConfigRetryAttempt = 0;
  sharedSignInConfigPromise = null;
  authGateStateColdWorker = false;
  chrome.alarms?.clear?.(SHARED_SIGN_IN_CONFIG_RETRY_ALARM);
  sharedSignInLoginConfig = {
    phase: 'loading',
    fetchedAt: 0,
    retryAt: null,
    setupRequired: false,
    sharedSignInEnabled: false,
    loginMethod: 'name_pin',
    pinLoginEnabled: false,
    schoolId: null,
    passpilotKioskAvailable: false,
  };
  bumpAuthGateStateRevision();
  if (options.clearPersisted !== false) {
    kv.remove(SHARED_SIGN_IN_CONFIG_CACHE_KEY).catch(() => {});
  }
}

function sleepMs(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function randomIntBetween(min, max) {
  return Math.floor(min + Math.random() * (max - min + 1));
}

function parseRetryAfterMs(response) {
  const rawValue = response?.headers?.get?.('Retry-After');
  if (!rawValue) return 0;
  const numericValue = Number(rawValue);
  if (Number.isFinite(numericValue)) {
    return Math.max(0, numericValue * 1000);
  }
  const dateValue = Date.parse(rawValue);
  if (Number.isFinite(dateValue)) {
    return Math.max(0, dateValue - Date.now());
  }
  return 0;
}

function calculateRetryDelayMs(response, attempt) {
  const retryAfterMs = parseRetryAfterMs(response);
  const isRateLimited = response?.status === 429;
  const baseRetryDelayMs = isRateLimited ? API_RETRY_RATE_LIMIT_DELAY_MS : API_RETRY_BASE_DELAY_MS;
  const exponentialMs = Math.min(
    baseRetryDelayMs * Math.pow(2, Math.max(0, attempt - 1)),
    API_RETRY_MAX_DELAY_MS
  );
  const baseDelay = retryAfterMs || exponentialMs;
  const jitterMs = randomIntBetween(0, Math.min(1000, Math.floor(baseDelay * 0.2)));
  return Math.min(baseDelay + jitterMs, API_RETRY_MAX_DELAY_MS);
}

function noteApiBackoff(response, context) {
  if (response?.status !== 429) return 0;
  const delayMs = calculateRetryDelayMs(response, 1);
  apiBackoffUntilMs = Math.max(apiBackoffUntilMs, Date.now() + delayMs);
  setConnectivityBadge(connectivityStatus()).catch(() => {});
  console.warn(`[Rate Limit] ${context || 'request'} received 429; backing off for ${Math.ceil(delayMs / 1000)}s`);
  return delayMs;
}

async function waitForApiBackoff(context) {
  const delayMs = apiBackoffUntilMs - Date.now();
  if (delayMs > 0) {
    console.warn(`[Rate Limit] Delaying ${context || 'request'} for ${Math.ceil(delayMs / 1000)}s`);
    await sleepMs(Math.min(delayMs, API_RETRY_MAX_DELAY_MS));
  }
}

async function fetchWithBackoff(url, init = {}, options = {}) {
  const maxAttempts = options.maxAttempts || API_RETRY_MAX_ATTEMPTS;
  const context = options.context || 'request';
  const retryStatuses = options.retryStatuses || API_RETRY_STATUS_CODES;
  const respectGlobalBackoff = options.respectGlobalBackoff !== false;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (respectGlobalBackoff) {
      await waitForApiBackoff(context);
    }

    try {
      const response = await fetch(url, init);
      if (response.status === 429) {
        noteApiBackoff(response, context);
      }
      if (!retryStatuses.has(response.status) || attempt >= maxAttempts) {
        return response;
      }
      await sleepMs(calculateRetryDelayMs(response, attempt));
    } catch (error) {
      if (attempt >= maxAttempts) {
        throw error;
      }
      console.warn(`[Network] ${context} failed; retrying (${attempt}/${maxAttempts})`, error?.message || error);
      await sleepMs(calculateRetryDelayMs(null, attempt));
    }
  }

  throw new Error(`${context} failed`);
}

function scheduleHealthCheckAlarm() {
  chrome.alarms.create(HEALTH_CHECK_ALARM_NAME, { periodInMinutes: 1 });
}

function scheduleJitteredStartup(reason, callback) {
  const delayMs = randomIntBetween(STARTUP_JITTER_MIN_MS, STARTUP_JITTER_MAX_MS);
  console.log(`[Startup] Scheduling ${reason} initialization in ${Math.round(delayMs / 1000)}s`);
  setTimeout(callback, delayMs);
}

// General-purpose message dedup: track recent _msgId values to prevent double-processing
const recentMsgIds = new Set();
const MSG_DEDUP_TTL = 30_000; // 30 seconds

// WebRTC: Offscreen document handles all WebRTC in MV3
// Service worker only orchestrates via messaging
let creatingOffscreen = null;
let offscreenReady = false;
let activeLiveViewNegotiationId = null;
let activeLiveViewTeachingSessionId = null;

// Storage helpers
const kv = {
  get: (keys) => new Promise(resolve => chrome.storage.local.get(keys, resolve)),
  set: (obj) => new Promise(resolve => chrome.storage.local.set(obj, resolve)),
  remove: (keys) => new Promise(resolve => chrome.storage.local.remove(keys, resolve)),
};

function strictStorageArea(area, label) {
  const call = (method, value, fallback) => new Promise((resolve, reject) => {
    area[method](value, (result) => {
      const runtimeError = chrome.runtime?.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message || `${label} ${method} failed`));
        return;
      }
      resolve(result === undefined ? fallback : result);
    });
  });
  return {
    get: (keys) => call('get', keys, {}),
    set: (obj) => call('set', obj),
    remove: (keys) => call('remove', keys),
  };
}

const durableLocalKv = strictStorageArea(chrome.storage.local, 'local storage');

function connectivityStatus(nowValue = Date.now(), options = {}) {
  if (!licenseActive) {
    return { state: 'inactive', label: 'Monitoring disabled', health: connectivityHealth };
  }
  if (!hasStudentAuth()) {
    return { state: 'auth_required', label: 'Authentication required', health: connectivityHealth };
  }
  if (nowValue < apiBackoffUntilMs) {
    return { state: 'rate_limited', label: 'School server retry scheduled', health: connectivityHealth };
  }
  const persistedMonitoringExpected = options.allowPersistedMonitoring === true
    && (persistedMonitoringState.state === TRACKING_STATES.ACTIVE
      || persistedMonitoringState.state === TRACKING_STATES.IDLE);
  if (trackingState === TRACKING_STATES.OFF && !persistedMonitoringExpected) {
    return { state: 'inactive', label: 'Monitoring inactive', health: connectivityHealth };
  }

  const derived = RuntimeCore.connectivityHealthState(connectivityHealth, nowValue);
  const labels = {
    checking: 'Checking school server',
    connected: 'Connected',
    reconnecting: 'Reconnecting',
    unreachable: 'School server unreachable',
  };
  return { ...derived, label: labels[derived.state] };
}

async function setConnectivityBadge(status = connectivityStatus()) {
  const styles = {
    connected: { text: '●', color: '#22c55e' },
    reconnecting: { text: '…', color: '#f59e0b' },
    unreachable: { text: '!', color: '#ef4444' },
    checking: { text: '…', color: '#94a3b8' },
    rate_limited: { text: '429', color: '#f59e0b' },
    auth_required: { text: 'AUTH', color: '#f59e0b' },
    inactive: { text: 'OFF', color: '#64748b' },
  };
  const style = styles[status.state] || styles.checking;
  try {
    await Promise.all([
      Promise.resolve(chrome.action.setBadgeBackgroundColor({ color: style.color })),
      Promise.resolve(chrome.action.setBadgeText({ text: style.text })),
      Promise.resolve(chrome.action.setTitle({ title: `ClassPilot — ${status.label}` })),
    ]);
  } catch {
    // Badge state is advisory; heartbeat and classroom enforcement continue.
  }
  return status;
}

async function scheduleConnectivityHealthBoundary(nowValue = Date.now()) {
  await chrome.alarms.clear(CONNECTIVITY_HEALTH_ALARM_NAME);
  if (trackingState === TRACKING_STATES.OFF || !hasStudentAuth() || !licenseActive) return;
  const { boundaryAt } = RuntimeCore.connectivityHealthState(connectivityHealth, nowValue);
  if (!boundaryAt) return;
  if (boundaryAt <= nowValue) {
    await setConnectivityBadge(connectivityStatus(nowValue));
    return;
  }
  chrome.alarms.create(CONNECTIVITY_HEALTH_ALARM_NAME, { when: boundaryAt });
}

async function recordHeartbeatSuccess(nowValue = Date.now()) {
  const prior = RuntimeCore.connectivityHealthState(connectivityHealth, nowValue);
  const recovered = connectivityHealth.consecutiveFailures > 0 || prior.state === 'unreachable';
  apiBackoffUntilMs = 0;
  connectivityHealth = RuntimeCore.connectivityHealthAfterSuccess(connectivityHealth, nowValue);
  await kv.set({ [CONNECTIVITY_HEALTH_STORAGE_KEY]: connectivityHealth });
  await setConnectivityBadge(connectivityStatus(nowValue));
  await scheduleConnectivityHealthBoundary(nowValue);

  if (recovered) {
    flushMonitoringEventOutbox().catch(() => {});
    requestClassroomStateSync('heartbeat-recovery', true);
    // If WebSocket recovery trails HTTP recovery, force the next heartbeat to
    // ask for the authoritative full snapshot as well.
    lastClassroomHeartbeatSyncRequestAt = 0;
    lastFabHeartbeatSyncRequestAt = 0;
  }
  return recovered;
}

async function recordHeartbeatFailure(errorCategory, nowValue = Date.now()) {
  connectivityHealth = RuntimeCore.connectivityHealthAfterFailure(
    connectivityHealth,
    errorCategory,
    nowValue
  );
  await kv.set({ [CONNECTIVITY_HEALTH_STORAGE_KEY]: connectivityHealth });
  await setConnectivityBadge(connectivityStatus(nowValue));
  await scheduleConnectivityHealthBoundary(nowValue);
  return connectivityHealth;
}

function syncScreenshotHealthGlobals() {
  lastScreenshotAttemptAt = screenshotHealth.lastAttemptAt || 0;
  lastScreenshotSuccessAt = screenshotHealth.lastSuccessAt || 0;
  lastScreenshotErrorAt = screenshotHealth.lastErrorAt || 0;
  lastScreenshotError = screenshotHealth.lastErrorCode || '';
}

async function persistScreenshotHealth(nextHealth) {
  screenshotHealth = RuntimeCore.normalizeScreenshotHealth(nextHealth);
  syncScreenshotHealthGlobals();
  await kv.set({ [SCREENSHOT_HEALTH_STORAGE_KEY]: screenshotHealth });
  return screenshotHealth;
}

async function recordScreenshotAttempt(nowValue = Date.now()) {
  return persistScreenshotHealth({
    ...screenshotHealth,
    schemaVersion: RuntimeCore.SCREENSHOT_HEALTH_SCHEMA_VERSION,
    lastAttemptAt: nowValue,
  });
}

async function recordScreenshotError(errorCode, nowValue = Date.now()) {
  return persistScreenshotHealth({
    ...screenshotHealth,
    schemaVersion: RuntimeCore.SCREENSHOT_HEALTH_SCHEMA_VERSION,
    lastErrorAt: nowValue,
    lastErrorCode: errorCode,
  });
}

async function recordScreenshotSuccess(nowValue = Date.now()) {
  return persistScreenshotHealth({
    ...screenshotHealth,
    schemaVersion: RuntimeCore.SCREENSHOT_HEALTH_SCHEMA_VERSION,
    lastSuccessAt: nowValue,
  });
}

const STUDENT_AUTH_INVALIDATING_KEY = 'studentAuthInvalidatingV1';
const STUDENT_AUTH_COMMIT_PENDING_KEY = 'studentAuthCommitPendingV1';
const PERSISTED_CONFIG_KEYS = Object.freeze([
  'serverUrl',
  'deviceId',
  'classId',
  'schoolId',
  'schoolSlug',
  'enrollmentKey',
]);
const AUTH_STATE_KEYS = [
  'studentToken',
  'activeStudentId',
  'activeStudentSessionId',
  'studentEmail',
  'studentName',
  'registered',
  'lastRegisteredEmail',
  'identitySource',
  'manualLoginLastSeenAt',
  'autoRegistrationPaused',
  'sharedAuthLockedSinceAt',
];

function persistedNonAuthConfig(raw = {}) {
  return Object.fromEntries(PERSISTED_CONFIG_KEYS.flatMap((key) => (
    Object.prototype.hasOwnProperty.call(raw, key) ? [[key, raw[key]]] : []
  )));
}

function hasSessionStorage() {
  return Boolean(chrome.storage?.session);
}

const sessionKv = {
  get: (keys) => new Promise(resolve => chrome.storage.session.get(keys, resolve)),
  set: (obj) => new Promise(resolve => chrome.storage.session.set(obj, resolve)),
  remove: (keys) => new Promise(resolve => chrome.storage.session.remove(keys, resolve)),
};
const durableSessionKv = hasSessionStorage()
  ? strictStorageArea(chrome.storage.session, 'session storage')
  : null;

async function getStoredAuthState(keys) {
  if (!hasSessionStorage()) return durableLocalKv.get(keys);
  const [local, session] = await Promise.all([
    durableLocalKv.get(keys),
    durableSessionKv.get(keys),
  ]);
  const merged = { ...local, ...session };
  const localAuthorityKeys = [
    STUDENT_AUTH_INVALIDATING_KEY,
    STUDENT_AUTH_COMMIT_PENDING_KEY,
    AUTH_GATE_REVISION_STORAGE_KEY,
  ];
  const staleSessionAuthorityKeys = [];
  for (const key of localAuthorityKeys) {
    if (!Array.isArray(keys) || !keys.includes(key)) continue;
    if (Object.prototype.hasOwnProperty.call(local, key)) {
      merged[key] = local[key];
    } else {
      delete merged[key];
    }
    if (Object.prototype.hasOwnProperty.call(session, key)) {
      staleSessionAuthorityKeys.push(key);
    }
  }
  if (staleSessionAuthorityKeys.length > 0) {
    durableSessionKv.remove(staleSessionAuthorityKeys).catch(() => {});
  }
  return merged;
}

async function setManualAuthState(obj) {
  if (hasSessionStorage()) {
    await durableSessionKv.set(obj);
    await durableLocalKv.remove(Object.keys(obj));
  } else {
    await durableLocalKv.set(obj);
  }
}

async function clearStoredAuthState(localOverrides = {}) {
  const cleared = Object.fromEntries(AUTH_STATE_KEYS.map((key) => [key, null]));
  const stored = await durableLocalKv.get(['config']);
  await durableLocalKv.set({
    ...cleared,
    config: persistedNonAuthConfig(stored.config || CONFIG),
    ...localOverrides,
  });
  if (hasSessionStorage()) {
    await durableSessionKv.remove([
      ...AUTH_STATE_KEYS,
      STUDENT_AUTH_INVALIDATING_KEY,
      STUDENT_AUTH_COMMIT_PENDING_KEY,
    ]);
  }
  // Remove crash-recovery markers last. If the worker dies during either auth
  // store cleanup, the surviving local marker keeps the next worker locked.
  await durableLocalKv.remove([STUDENT_AUTH_INVALIDATING_KEY, STUDENT_AUTH_COMMIT_PENDING_KEY]);
}

function isHttpUrl(url) {
  if (typeof url !== 'string' || !url.trim()) return false;
  try {
    const parsed = new URL(url);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && Boolean(parsed.hostname);
  } catch {
    return false;
  }
}

// PassPilot kiosk launch from the auth gate: the kiosk pages live at
// <serverOrigin>/passpilot/kiosk (badge) and /passpilot/kiosk/simple. They are
// public, kiosk-PIN-gated pages, so the auth gate never paints over them —
// otherwise a locked student Chromebook could not be used as a hall-pass kiosk.
function kioskGateOrigin() {
  try {
    return new URL(CONFIG.serverUrl || DEFAULT_SERVER_URL).origin;
  } catch {
    return null;
  }
}

function isKioskGateUrl(url) {
  const origin = kioskGateOrigin();
  if (!origin || typeof url !== 'string') return false;
  try {
    const parsed = new URL(url);
    return parsed.origin === origin &&
      (parsed.pathname === '/passpilot/kiosk' || parsed.pathname.startsWith('/passpilot/kiosk/'));
  } catch {
    return false;
  }
}

function kioskLaunchUrl() {
  const origin = kioskGateOrigin();
  if (fastAuthGateEnabled && sharedSignInLoginConfig.phase !== 'ready') return null;
  if (!origin || !sharedSignInLoginConfig.schoolId) return null;
  if (sharedSignInLoginConfig.passpilotKioskAvailable !== true) return null;
  // launch=gate tells the kiosk page to keep the staff PIN in sessionStorage
  // so it dies with the tab instead of persisting in the student profile.
  // device= (managed installs only) is the durable kiosk identity the page
  // adopts so its teacher memory survives profile wipes; appended after
  // launch=gate so that literal stays contiguous for the release contract.
  const deviceParam = managedKioskDeviceId
    ? `&device=${encodeURIComponent(managedKioskDeviceId)}`
    : '';
  return `${origin}/passpilot/kiosk/simple?school=${encodeURIComponent(sharedSignInLoginConfig.schoolId)}&launch=gate${deviceParam}`;
}

// Resolve the enrolled device's directory id (managed ChromeOS +
// policy-installed only — chrome.enterprise is undefined everywhere else)
// and hash it into UUID shape: the raw id never leaves the worker, and the
// hashed form matches the kiosk API's existing device-id validation.
// Single-flight and cached for the worker's lifetime; resolution bumps the
// auth-gate state revision so an already-painted gate re-renders its kiosk
// button with the device param.
function detectManagedKioskDeviceId() {
  if (managedKioskDeviceIdProbe) return managedKioskDeviceIdProbe;
  managedKioskDeviceIdProbe = (async () => {
    try {
      if (!chrome.enterprise?.deviceAttributes?.getDirectoryDeviceId) return null;
      // Timeout-raced: on some unmanaged runtimes the API surface exists but
      // the callback never fires, and a pending extension API call would pin
      // the MV3 worker alive. The probe must always settle.
      const rawId = await Promise.race([
        new Promise((resolve) => {
          try {
            chrome.enterprise.deviceAttributes.getDirectoryDeviceId((value) => {
              if (chrome.runtime.lastError) {
                resolve(null);
                return;
              }
              resolve(typeof value === 'string' ? value.trim() : null);
            });
          } catch {
            resolve(null);
          }
        }),
        new Promise((resolve) => setTimeout(() => resolve(null), 3000)),
      ]);
      if (!rawId) return null;
      if (!globalThis.crypto?.subtle?.digest) return null;
      const digest = await globalThis.crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(`classpilot-kiosk-device:${rawId}`),
      );
      const hex = Array.from(new Uint8Array(digest).slice(0, 16))
        .map((byte) => byte.toString(16).padStart(2, '0'))
        .join('');
      const hashed = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
      if (hashed !== managedKioskDeviceId) {
        managedKioskDeviceId = hashed;
        bumpAuthGateStateRevision();
        notifyAuthGateStateToTabs().catch(() => {});
      }
      return managedKioskDeviceId;
    } catch (err) {
      console.log('[Kiosk] Managed device id unavailable:', err?.message || err);
      return null;
    }
  })();
  return managedKioskDeviceIdProbe;
}

// Refresh the tab cache - called when tabs change to keep cache accurate
async function refreshTabCache() {
  try {
    const allTabs = await chrome.tabs.query({});
    const httpTabs = allTabs.filter(tab => tab.url && tab.url.startsWith('http'));
    if (httpTabs.length > 0) {
      const snapshot = await buildOpaqueTabSnapshot(httpTabs);
      lastKnownTabs = snapshot.tabs;
    }
  } catch (error) {
    // Ignore errors - cache will be updated on next successful query
  }
}

function extractManagedValue(value) {
  if (value && typeof value === 'object' && 'Value' in value) {
    return value.Value;
  }
  return value;
}

function normalizeManagedString(value) {
  const extracted = extractManagedValue(value);
  if (extracted === undefined || extracted === null) return null;
  const normalized = String(extracted).trim();
  return normalized || null;
}

async function readManagedConfig(options = {}) {
  if (!chrome.storage?.managed) {
    return {};
  }
  try {
    return await new Promise((resolve, reject) => chrome.storage.managed.get(MANAGED_CONFIG_KEYS, (config) => {
      const runtimeError = chrome.runtime?.lastError;
      if (runtimeError) {
        reject(new Error(runtimeError.message || 'Managed configuration is unavailable'));
        return;
      }
      resolve(config || {});
    }));
  } catch (error) {
    console.warn('[Service Worker] Managed config read failed:', error);
    if (options.failClosed === true) throw error;
    return {};
  }
}

function applyManagedSchoolConfig(managedConfig = {}) {
  const managedServerUrl = normalizeManagedString(managedConfig.serverUrl) ||
    normalizeManagedString(managedConfig.classpilotServerUrl);
  if (isHttpUrl(managedServerUrl)) {
    CONFIG.serverUrl = managedServerUrl;
  }
  CONFIG.schoolId = normalizeManagedString(managedConfig.schoolId) ||
    normalizeManagedString(managedConfig.classpilotSchoolId) ||
    CONFIG.schoolId;
  CONFIG.schoolSlug = normalizeManagedString(managedConfig.schoolSlug) ||
    normalizeManagedString(managedConfig.classpilotSchoolSlug) ||
    CONFIG.schoolSlug;
  CONFIG.enrollmentKey = normalizeManagedString(managedConfig.enrollmentKey) ||
    normalizeManagedString(managedConfig.classpilotEnrollmentKey) ||
    CONFIG.enrollmentKey;
  if (Object.prototype.hasOwnProperty.call(managedConfig, 'fastAuthGateEnabled')) {
    fastAuthGateEnabled = extractManagedValue(managedConfig.fastAuthGateEnabled) !== false;
  }
}

function applyManagedAuthGatePolicySnapshot(managedConfig = {}) {
  const priorFastAuthGateEnabled = fastAuthGateEnabled;
  const priorBindingKey = authGateConfigBindingKey();
  applyManagedSchoolConfig(managedConfig);
  if (
    priorFastAuthGateEnabled !== fastAuthGateEnabled
    || priorBindingKey !== authGateConfigBindingKey()
  ) {
    resetSharedSignInLoginConfigCache({ clearPersisted: true });
  }
  return managedConfig;
}

function normalizedServerOrigin(value) {
  if (!isHttpUrl(value)) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function managedAuthGatePolicyDescriptor(managedConfig = {}) {
  const serverUrl = normalizeManagedString(managedConfig.serverUrl)
    || normalizeManagedString(managedConfig.classpilotServerUrl);
  const serverOrigin = normalizedServerOrigin(serverUrl);
  const schoolId = normalizeManagedString(managedConfig.schoolId)
    || normalizeManagedString(managedConfig.classpilotSchoolId);
  const schoolSlug = normalizeManagedString(managedConfig.schoolSlug)
    || normalizeManagedString(managedConfig.classpilotSchoolSlug);
  const enrollmentKey = normalizeManagedString(managedConfig.enrollmentKey)
    || normalizeManagedString(managedConfig.classpilotEnrollmentKey);
  return {
    schemaVersion: 1,
    serverOrigin,
    serverManaged: Boolean(serverUrl),
    serverValid: !serverUrl || Boolean(serverOrigin),
    schoolId,
    schoolIdManaged: Boolean(schoolId),
    schoolSlug,
    schoolSlugManaged: Boolean(schoolSlug),
    enrollmentKeyManaged: Boolean(enrollmentKey),
    hasManagedSetup: Boolean(
      (schoolId || schoolSlug)
      && enrollmentKey
      && (!serverUrl || serverOrigin)
    ),
    enrollmentKey,
  };
}

function isExplicitUnmanagedDevelopmentServer(serverUrl) {
  try {
    const hostname = new URL(serverUrl).hostname.toLowerCase();
    return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1';
  } catch {
    return false;
  }
}

function isExplicitUnmanagedDevelopmentRuntime() {
  const runtimeId = String(chrome.runtime?.id || '').trim();
  return Boolean(runtimeId && runtimeId !== CLASSPILOT_PRODUCTION_EXTENSION_ID);
}

function persistedManagedAuthGateDescriptor(descriptor) {
  return {
    schemaVersion: 1,
    serverOrigin: descriptor.serverOrigin,
    serverManaged: descriptor.serverManaged,
    serverValid: descriptor.serverValid,
    schoolId: descriptor.schoolId,
    schoolIdManaged: descriptor.schoolIdManaged,
    schoolSlug: descriptor.schoolSlug,
    schoolSlugManaged: descriptor.schoolSlugManaged,
    enrollmentKeyManaged: descriptor.enrollmentKeyManaged,
  };
}

function applyAuthoritativeManagedAuthGateSnapshot(
  managedConfig,
  priorManagedBinding,
  allowUnmanagedFallback,
  options = {},
) {
  const descriptor = managedAuthGatePolicyDescriptor(managedConfig);
  const policyIsAuthoritative = !allowUnmanagedFallback || Boolean(priorManagedBinding)
    || descriptor.hasManagedSetup || descriptor.serverManaged;
  const priorFastAuthGateEnabled = fastAuthGateEnabled;
  const priorBindingKey = authGateConfigBindingKey();
  applyManagedSchoolConfig(managedConfig);
  if (policyIsAuthoritative) {
    CONFIG.schoolId = descriptor.schoolId;
    CONFIG.schoolSlug = descriptor.schoolSlug;
    CONFIG.enrollmentKey = descriptor.enrollmentKey;
    if (!descriptor.serverManaged || !descriptor.serverValid) {
      // In an authoritative production snapshot, an omitted server means the
      // ClassPilot production origin. This must not inherit a custom endpoint
      // persisted by a pre-2.6.6 build that has no managed binding record yet.
      CONFIG.serverUrl = DEFAULT_SERVER_URL;
    }
  }
  if (
    priorFastAuthGateEnabled !== fastAuthGateEnabled
    || priorBindingKey !== authGateConfigBindingKey()
  ) {
    // The cached login-config also carries kiosk availability/school data.
    // Drop it before any tab can combine the old origin with the new policy.
    resetSharedSignInLoginConfigCache({ clearPersisted: true });
  }
  managedAuthGateSetupUnavailable = policyIsAuthoritative && !descriptor.hasManagedSetup;
  if (policyIsAuthoritative && !descriptor.hasManagedSetup) {
    updateSharedSignInLoginConfig({
      phase: 'setup_required',
      fetchedAt: 0,
      retryAt: null,
      setupRequired: true,
      sharedSignInEnabled: false,
      pinLoginEnabled: false,
      schoolId: null,
      passpilotKioskAvailable: false,
      bindingKey: authGateConfigBindingKey(),
    });
  }
  const persistedDescriptor = persistedManagedAuthGateDescriptor(descriptor);
  if (policyIsAuthoritative && options.persist !== false) {
    kv.set({ [MANAGED_AUTH_GATE_BINDING_KEY]: persistedDescriptor }).catch(() => {});
  }
  return { descriptor, persistedDescriptor, policyIsAuthoritative };
}

function managedPolicyConflictsWithStoredAuth(
  stored = {},
  managedConfig = {},
  fallbackServerUrl,
  options = {},
) {
  if (
    stored[STUDENT_AUTH_INVALIDATING_KEY] === true
    || stored[STUDENT_AUTH_COMMIT_PENDING_KEY] === true
    || ![
      stored.deviceId || stored.config?.deviceId,
      stored.studentToken,
      stored.activeStudentId,
      stored.activeStudentSessionId,
    ].every((value) => typeof value === 'string' && value.trim().length > 0)
  ) {
    return false;
  }

  const storedConfig = stored.config || {};
  const descriptor = managedAuthGatePolicyDescriptor(managedConfig);
  const priorManagedBinding = stored[MANAGED_AUTH_GATE_BINDING_KEY];
  const policyIsAuthoritative = options.managedReadFailed === true
    || !options.allowUnmanagedFallback
    || Boolean(priorManagedBinding)
    || descriptor.hasManagedSetup
    || descriptor.serverManaged;
  const storedServerOrigin = normalizedServerOrigin(storedConfig.serverUrl || fallbackServerUrl);
  const authoritativeServerOrigin = descriptor.serverManaged
    ? descriptor.serverOrigin
    : normalizedServerOrigin(DEFAULT_SERVER_URL);

  return Boolean(
    options.managedReadFailed === true
    || (policyIsAuthoritative && !descriptor.hasManagedSetup)
    || (policyIsAuthoritative && authoritativeServerOrigin !== storedServerOrigin)
    || (descriptor.schoolIdManaged && descriptor.schoolId !== normalizeManagedString(storedConfig.schoolId))
    || (descriptor.schoolSlugManaged && descriptor.schoolSlug !== normalizeManagedString(storedConfig.schoolSlug))
    || (descriptor.enrollmentKeyManaged
      && descriptor.enrollmentKey !== normalizeManagedString(storedConfig.enrollmentKey))
  );
}

function scheduleLicenseCheck() {
  const periodInMinutes = LICENSE_CHECK_INTERVAL_MS / 60000;
  chrome.alarms.create('license-check', { periodInMinutes });
}

function notifyLicenseState(message) {
  chrome.tabs.query({}, (tabs) => {
    tabs.forEach((tab) => {
      if (!tab.id) return;
      chrome.tabs.sendMessage(tab.id, message).catch(() => null);
    });
  });
}

function isClassPilotNotEntitledResponse(data = {}) {
  const identifiers = [data?.code, data?.error]
    .map((value) => String(value || '').trim())
    .filter(Boolean);
  return identifiers.includes('CLASSPILOT_NOT_ENTITLED')
    || identifiers.includes('school_not_entitled');
}

async function disableForInactiveLicense(planStatus) {
  // Persist and attempt delivery while the authenticated device context is
  // still available. A retryable failure remains in the bounded outbox and
  // can be delivered after the license/session recovers.
  if (licenseActive) {
    await transitionTrackingState(TRACKING_STATES.OFF, 'license_inactive');
  }
  // Product entitlement revocation must remove teacher-authored controls even
  // after a worker restart. Preserve the independently managed school policy
  // range while clearing classroom, teacher, and temporary rules/state.
  try {
    await clearTeacherSessionStateForSignOut({
      reason: 'entitlement-inactive',
      emitEvent: false,
    });
    await chrome.alarms.clear(LICENSE_CONTROL_CLEANUP_ALARM);
  } catch (error) {
    console.warn('[License] Classroom control cleanup deferred:', error?.message || error);
    chrome.alarms.create(LICENSE_CONTROL_CLEANUP_ALARM, {
      when: Date.now() + LICENSE_CONTROL_CLEANUP_RETRY_MS,
    });
  }
  await clearFabAndOverlayState('entitlement-inactive', { closeChat: true }).catch(() => {});
  licenseActive = false;
  if (observedHeartbeatTimer) {
    clearInterval(observedHeartbeatTimer);
    observedHeartbeatTimer = null;
  }
  scheduleHeartbeat(null);
  await disconnectWebSocket();
  chrome.alarms.clear('ws-reconnect');
  chrome.alarms.clear(HEALTH_CHECK_ALARM_NAME);
  chrome.alarms.clear(CONNECTIVITY_HEALTH_ALARM_NAME);
  chrome.alarms.clear('settings-refresh');
  settingsAlarmScheduled = false;
  await setConnectivityBadge(connectivityStatus());

  await kv.set({ licenseActive: false, planStatus, licenseDisabledAt: Date.now() });
  notifyLicenseState({ type: 'CLASSPILOT_LICENSE_INACTIVE', planStatus });
}

async function checkLicenseStatus(reason = 'manual', options = {}) {
  const assertCurrent = () => {
    if (options.authMutationGeneration === undefined) return;
    assertAuthMutationBindingCurrent(
      options.authMutationGeneration,
      options.authBinding,
      `license check:${reason}`,
    );
  };
  const applyForCurrentAuth = (mutation) => {
    if (options.authMutationGeneration === undefined) return mutation();
    return enqueueStudentAuthMutation(async () => {
      assertCurrent();
      const result = await mutation();
      assertCurrent();
      return result;
    });
  };
  assertCurrent();
  if (!CONFIG.serverUrl) {
    return;
  }

  try {
    const response = await fetchWithBackoff(`${CONFIG.serverUrl}/api/school/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        studentToken: CONFIG.studentToken || null,
        studentEmail: CONFIG.studentEmail || null,
      }),
    }, {
      context: 'license status',
      maxAttempts: 2,
    });
    assertCurrent();

    if (response.status === 402 || response.status === 403) {
      const data = await response.json().catch(() => ({}));
      assertCurrent();
      if (response.status === 402 || isClassPilotNotEntitledResponse(data)) {
        await applyForCurrentAuth(() => disableForInactiveLicense(data.planStatus));
        assertCurrent();
      }
      return;
    }

    if (!response.ok) {
      return;
    }

    const data = await response.json();
    assertCurrent();
    if (!data.schoolActive) {
      await applyForCurrentAuth(() => disableForInactiveLicense(data.planStatus));
      assertCurrent();
      return;
    }

    const wasInactive = await applyForCurrentAuth(async () => {
      const inactiveBeforeUpdate = !licenseActive;
      licenseActive = true;
      await chrome.alarms.clear(LICENSE_CONTROL_CLEANUP_ALARM);
      await kv.set({ licenseActive: true, planStatus: data.planStatus });
      return inactiveBeforeUpdate;
    });
    assertCurrent();
    if (wasInactive) {
      notifyLicenseState({ type: 'CLASSPILOT_LICENSE_ACTIVE', planStatus: data.planStatus });
      if (options.deferTrackingInitialization !== true) {
        initializeAdaptiveTracking(`license-active:${reason}`);
      }
    }
  } catch (error) {
    if (error?.code === 'AUTH_MUTATION_SUPERSEDED') throw error;
    console.warn('[License] Status check failed:', error);
  }
}

async function resolveServerUrl() {
  if (isExplicitUnmanagedDevelopmentServer(CONFIG.serverUrl || INJECTED_SERVER_URL)) {
    return CONFIG.serverUrl || INJECTED_SERVER_URL;
  }
  const managedConfig = await readManagedConfig();
  applyManagedSchoolConfig(managedConfig);

  const managedUrl = normalizeManagedString(managedConfig?.serverUrl)
    || normalizeManagedString(managedConfig?.classpilotServerUrl);
  if (managedUrl) {
    // Presence is authoritative. A malformed managed URL must never fall
    // through to a stale locally persisted endpoint from an older policy.
    return isHttpUrl(managedUrl) ? managedUrl : DEFAULT_SERVER_URL;
  }

  let syncConfig = {};
  if (chrome.storage?.sync) {
    try {
      syncConfig = await new Promise(resolve => chrome.storage.sync.get(['config'], resolve));
    } catch (error) {
      console.warn('[Service Worker] Sync config read failed:', error);
    }
  }

  const localConfig = await chrome.storage.local.get([
    'config',
    MANAGED_AUTH_GATE_BINDING_KEY,
  ]);
  if (localConfig?.[MANAGED_AUTH_GATE_BINDING_KEY]?.serverManaged) {
    // The prior managed endpoint was removed. Absence is authoritative and
    // cannot fall back to the endpoint persisted by that former policy.
    return DEFAULT_SERVER_URL;
  }
  const storedUrl = localConfig?.config?.serverUrl || syncConfig?.config?.serverUrl;
  if (isHttpUrl(storedUrl)) {
    return storedUrl;
  }

  if (isHttpUrl(INJECTED_SERVER_URL)) {
    return INJECTED_SERVER_URL;
  }

  return DEFAULT_SERVER_URL;
}

async function fetchClientConfig(serverUrl) {
  const primaryUrl = `${serverUrl}/api/client-config`;
  const fallbackUrl = `${serverUrl}/client-config.json`;

  try {
    const response = await fetchWithBackoff(primaryUrl, { cache: 'no-store' }, {
      context: 'client config',
      maxAttempts: 2,
    });
    if (response.ok) {
      return await response.json();
    }
    if (response.status === 404) {
      const fallbackResponse = await fetchWithBackoff(fallbackUrl, { cache: 'no-store' }, {
        context: 'client config fallback',
        maxAttempts: 2,
      });
      if (fallbackResponse.ok) {
        return await fallbackResponse.json();
      }
    }
  } catch (error) {
    console.warn('[Service Worker] Failed to fetch client config:', error);
  }

  return { baseUrl: serverUrl };
}

// Keep logic in sync with shared/utils.ts isWithinTrackingHours (server-side).
function isWithinTrackingHours(
  enableTrackingHours,
  trackingStartTime,
  trackingEndTime,
  schoolTimezone,
  trackingDays
) {
  try {
    return RuntimeCore.isWithinTrackingWindow({
      enabled: enableTrackingHours,
      startTime: trackingStartTime || '00:00',
      endTime: trackingEndTime || '23:59',
      timezone: schoolTimezone || 'America/New_York',
      activeDays: trackingDays || ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'],
      now: Date.now(),
    });
  } catch (error) {
    console.warn('[School Hours] Error checking tracking hours:', error);
    return true;
  }
}

async function loadCachedSchoolSettings() {
  const stored = await kv.get([SCHOOL_SETTINGS_CACHE_KEY, SCHOOL_SETTINGS_FETCHED_AT_KEY]);
  if (stored[SCHOOL_SETTINGS_CACHE_KEY]) {
    schoolSettings = stored[SCHOOL_SETTINGS_CACHE_KEY];
  }
  if (stored[SCHOOL_SETTINGS_FETCHED_AT_KEY]) {
    schoolSettingsFetchedAt = stored[SCHOOL_SETTINGS_FETCHED_AT_KEY];
  }
}

async function refreshSchoolSettings(options = {}) {
  const force = options.force === true;
  const assertCurrent = () => {
    if (options.authMutationGeneration === undefined) return;
    assertAuthMutationBindingCurrent(
      options.authMutationGeneration,
      options.authBinding,
      'school settings refresh',
    );
  };
  const applyForCurrentAuth = (mutation) => {
    if (options.authMutationGeneration === undefined) return mutation();
    return enqueueStudentAuthMutation(async () => {
      assertCurrent();
      const result = await mutation();
      assertCurrent();
      return result;
    });
  };
  assertCurrent();
  const now = Date.now();
  if (!force && schoolSettingsFetchedAt && now - schoolSettingsFetchedAt < SETTINGS_FETCH_INTERVAL_MS) {
    return schoolSettings;
  }

  try {
    // Tracking hours are configured by admins via /api/settings in the ClassPilot admin UI
    // (enableTrackingHours, trackingStartTime, trackingEndTime, trackingDays, schoolTimezone).
    // Requires the "idle" permission in manifest.json to respect ACTIVE/IDLE states.
    // Use /api/extension/settings endpoint which accepts student token authentication
    if (!CONFIG.studentToken) {
      console.log('[School Hours] No student token, skipping settings fetch');
      if (!schoolSettings) {
        schoolSettings = { enableTrackingHours: false };
      }
      return schoolSettings;
    }
    const authenticatedResponseGuard = captureAuthenticatedResponseGuard();
    const response = await fetchWithBackoff(`${CONFIG.serverUrl}/api/extension/settings`, {
      cache: 'no-store',
      headers: {
        'Authorization': `Bearer ${CONFIG.studentToken}`,
      },
    }, {
      context: 'extension settings',
      maxAttempts: 2,
    });
    assertCurrent();
    if (!response.ok) {
      throw new Error(`Settings fetch failed (${response.status})`);
    }
    const settings = await response.json();
    assertCurrent();
    await adoptAuthenticatedStudentBinding(
      settings,
      'extension settings',
      authenticatedResponseGuard,
    );
    assertCurrent();
    await applyForCurrentAuth(async () => {
      schoolSettings = settings;
      schoolSettingsFetchedAt = now;
      await applyFabSettings(settings.fab || settings);
      await kv.set({
        [SCHOOL_SETTINGS_CACHE_KEY]: settings,
        [SCHOOL_SETTINGS_FETCHED_AT_KEY]: now,
      });
    });
    console.log('[School Hours] Settings updated:', settings);
    return settings;
  } catch (error) {
    if (error?.code === 'AUTH_MUTATION_SUPERSEDED') throw error;
    console.warn('[School Hours] Failed to fetch settings:', error);
    if (!schoolSettings) {
      schoolSettings = { enableTrackingHours: false };
    }
    return schoolSettings;
  }
}

async function parseJsonResponse(response) {
  let data = {};
  try {
    data = await response.json();
  } catch {
    data = {};
  }
  if (!response.ok) {
    throw buildResponseError(response, data, `Request failed (${response.status})`);
  }
  return data;
}

function buildResponseError(response, data = {}, fallbackMessage = 'Request failed') {
  const error = new Error(data.error || data.message || fallbackMessage);
  error.status = response?.status;
  if (response?.status === 429) {
    error.retryAfterMs = parseRetryAfterMs(response) || API_RETRY_BASE_DELAY_MS;
  }
  return error;
}

function normalizeIdList(values) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))].sort();
}

function fabIdentityBinding() {
  if (!CONFIG.activeStudentId || !CONFIG.activeStudentSessionId || !CONFIG.deviceId) return null;
  return [
    'v2',
    CONFIG.schoolId || 'school',
    CONFIG.activeStudentId,
    CONFIG.activeStudentSessionId,
    CONFIG.deviceId,
  ].join(':');
}

function exactStudentBinding(raw = {}) {
  const candidates = [
    raw,
    raw?.data,
    raw?.command,
    raw?.command?.data,
    raw?.fab,
    raw?.fabState,
    raw?.state,
    raw?.settings?.fab,
  ].filter((candidate) => candidate && typeof candidate === 'object');
  const firstValue = (key) => {
    for (const candidate of candidates) {
      const value = String(candidate[key] || '').trim();
      if (value) return value;
    }
    return null;
  };
  return {
    studentId: firstValue('studentId'),
    studentSessionId: firstValue('studentSessionId'),
  };
}

function assertCurrentStudentBinding(raw = {}, label = 'message') {
  const binding = exactStudentBinding(raw);
  if (
    studentAuthInvalidating
    || !CONFIG.activeStudentId
    || !CONFIG.activeStudentSessionId
    || binding.studentId !== CONFIG.activeStudentId
    || binding.studentSessionId !== CONFIG.activeStudentSessionId
  ) {
    const error = new Error(`${label} belongs to a retired student session`);
    error.code = 'STUDENT_BINDING_MISMATCH';
    throw error;
  }
  return binding;
}

function acceptsCurrentStudentBinding(raw = {}, label = 'message') {
  try {
    assertCurrentStudentBinding(raw, label);
    return true;
  } catch (error) {
    console.warn(`[Binding] Ignoring ${label}:`, error?.message || error);
    return false;
  }
}

function authMutationSuperseded(reason) {
  const error = new Error(`${reason} was superseded by a newer authentication mutation`);
  error.code = 'AUTH_MUTATION_SUPERSEDED';
  return error;
}

function assertChromeProfileRegistrationAllowed(reason) {
  if (manualStudentLoginPendingGeneration) {
    throw authMutationSuperseded(`${reason} while a manual login is pending`);
  }
}

function assertAuthMutationCurrent(generation, reason, options = {}) {
  if (
    generation !== studentAuthMutationGeneration
    || (studentAuthInvalidating && options.allowInvalidating !== true)
  ) {
    throw authMutationSuperseded(reason);
  }
}

function captureAuthenticatedResponseGuard() {
  return {
    mutationGeneration: studentAuthMutationGeneration,
    authGateBindingKey: authGateConfigBindingKey(),
  };
}

function assertAuthenticatedResponseGuardCurrent(guard, reason) {
  if (
    !guard
    || guard.mutationGeneration !== studentAuthMutationGeneration
    || guard.authGateBindingKey !== authGateConfigBindingKey()
  ) {
    throw authMutationSuperseded(reason);
  }
}

function adoptAuthenticatedStudentBinding(
  raw = {},
  reason = 'authenticated-response',
  responseGuard = captureAuthenticatedResponseGuard(),
) {
  assertAuthenticatedResponseGuardCurrent(responseGuard, reason);
  return enqueueStudentAuthMutation(() => adoptAuthenticatedStudentBindingNow(
    raw,
    reason,
    responseGuard,
  ));
}

async function adoptAuthenticatedStudentBindingNow(raw, reason, responseGuard) {
  const mutationGeneration = responseGuard.mutationGeneration;
  assertAuthMutationCurrent(mutationGeneration, reason);
  assertAuthenticatedResponseGuardCurrent(responseGuard, reason);
  const wasAuthenticated = hasStudentAuth();
  const priorStudentId = CONFIG.activeStudentId;
  const priorStudentSessionId = CONFIG.activeStudentSessionId;
  const binding = exactStudentBinding(raw);
  const authenticatedSchoolId = String(
    raw.schoolId || raw.settings?.schoolId || raw.school?.id || ''
  ).trim() || null;
  if (!binding.studentId || !binding.studentSessionId) {
    throw new Error(`${reason} omitted the exact student binding`);
  }
  if (CONFIG.activeStudentId && CONFIG.activeStudentId !== binding.studentId) {
    throw new Error(`${reason} returned a different student`);
  }
  if (
    CONFIG.activeStudentSessionId
    && CONFIG.activeStudentSessionId !== binding.studentSessionId
  ) {
    throw new Error(`${reason} returned a retired student session`);
  }
  const update = {
    activeStudentId: binding.studentId,
    activeStudentSessionId: binding.studentSessionId,
  };
  const persistedConfig = authenticatedSchoolId
    ? persistedNonAuthConfig({ ...CONFIG, schoolId: authenticatedSchoolId })
    : null;
  if (isManualIdentitySource()) {
    // Dispatch the local marker removal before awaiting session storage. A
    // later clear writes `true` afterward and therefore remains fail-closed.
    const markerCleared = durableLocalKv.remove(STUDENT_AUTH_INVALIDATING_KEY);
    const configPersisted = persistedConfig
      ? durableLocalKv.set({ config: persistedConfig })
      : Promise.resolve();
    await setManualAuthState(update);
    await Promise.all([markerCleared, configPersisted]);
  } else {
    await durableLocalKv.set({
      ...update,
      ...(persistedConfig ? { config: persistedConfig } : {}),
      [STUDENT_AUTH_INVALIDATING_KEY]: null,
    });
  }
  assertAuthMutationCurrent(mutationGeneration, reason);
  assertAuthenticatedResponseGuardCurrent(responseGuard, reason);
  CONFIG.activeStudentId = binding.studentId;
  CONFIG.activeStudentSessionId = binding.studentSessionId;
  if (authenticatedSchoolId) CONFIG.schoolId = authenticatedSchoolId;
  studentAuthInvalidating = false;
  if (
    !wasAuthenticated
    || priorStudentId !== binding.studentId
    || priorStudentSessionId !== binding.studentSessionId
  ) {
    resetSharedSignInLoginConfigCache({ clearPersisted: true });
  }
  return binding;
}

function normalizeFabState(rawState = {}, fallbackState = {}) {
  const hasSessionField = Object.prototype.hasOwnProperty.call(rawState, 'teachingSessionId')
    || Object.prototype.hasOwnProperty.call(rawState, 'sessionId');
  const teachingSessionId = String(hasSessionField
    ? (rawState.teachingSessionId || rawState.sessionId || '')
    : (fallbackState.teachingSessionId || '')).trim() || null;
  const activeSessionIds = normalizeIdList(
    Array.isArray(rawState.activeSessionIds) || Array.isArray(rawState.sessionIds)
      ? (rawState.activeSessionIds || rawState.sessionIds)
      : hasSessionField
        ? (rawState.teachingSessionId || rawState.sessionId ? [rawState.teachingSessionId || rawState.sessionId] : [])
        : fallbackState.activeSessionIds
  );
  const revisionValue = rawState.revision ?? rawState.lifecycleRevision ?? fallbackState.revision ?? 0;
  const revision = Number.isSafeInteger(Number(revisionValue)) && Number(revisionValue) >= 0
    ? Number(revisionValue)
    : 0;
  const hasOwnershipRevision = [
    'ownershipRevision',
    'studentControlRevision',
    'student_control_revision',
  ].some((key) => Object.prototype.hasOwnProperty.call(rawState, key));
  const ownershipRevisionValue = rawState.ownershipRevision
    ?? rawState.studentControlRevision
    ?? rawState.student_control_revision
    ?? fallbackState.ownershipRevision
    ?? 0;
  const ownershipRevision = Number.isSafeInteger(Number(ownershipRevisionValue))
    && Number(ownershipRevisionValue) >= 0
    ? Number(ownershipRevisionValue)
    : 0;
  return {
    schemaVersion: 1,
    revision,
    lifecycleRevision: revision,
    ownershipRevision,
    ownershipRevisionKnown: hasOwnershipRevision || fallbackState.ownershipRevisionKnown === true,
    studentId: String(rawState.studentId || fallbackState.studentId || '').trim() || null,
    studentSessionId: String(
      rawState.studentSessionId || fallbackState.studentSessionId || ''
    ).trim() || null,
    teachingSessionId,
    activeSessionIds,
    messagingEnabled: typeof rawState.messagingEnabled === 'boolean'
      ? rawState.messagingEnabled
      : fallbackState.messagingEnabled !== false,
    handRaisingEnabled: typeof rawState.handRaisingEnabled === 'boolean'
      ? rawState.handRaisingEnabled
      : fallbackState.handRaisingEnabled !== false,
    handRaised: typeof rawState.handRaised === 'boolean'
      ? rawState.handRaised
      : fallbackState.handRaised === true,
    activeHands: Array.isArray(rawState.activeHands)
      ? rawState.activeHands.slice(0, 100)
      : Array.isArray(fallbackState.activeHands) ? fallbackState.activeHands.slice(0, 100) : [],
    sessions: Array.isArray(rawState.sessions)
      ? rawState.sessions.slice(0, 100)
      : Array.isArray(fallbackState.sessions) ? fallbackState.sessions.slice(0, 100) : [],
    reason: String(rawState.reason || '').slice(0, 80),
  };
}

let fabStateMutation = Promise.resolve();

function enqueueFabStateMutation(operation) {
  const next = fabStateMutation.then(operation, operation);
  fabStateMutation = next.catch(() => {});
  return next;
}

async function clearFabAndOverlayStateNow(reason = 'identity-cleared', options = {}) {
  const closeChat = options.closeChat === true;
  currentFabState = null;
  lastFabHeartbeatSyncRequestAt = 0;
  await classroomOverlayMutation;
  await chrome.alarms.clear(CLASSROOM_OVERLAY_EXPIRY_ALARM);
  await kv.set({
    [FAB_STATE_STORAGE_KEY]: null,
    [FAB_CONTEXT_STORAGE_KEY]: null,
    [FAB_CHAT_CONTEXT_STORAGE_KEY]: null,
    [CLASSROOM_OVERLAY_STORAGE_KEY]: null,
    fabChatMessages: [],
    fabChatClosed: closeChat,
    handRaised: false,
    messagingEnabled: false,
    handRaisingEnabled: false,
  });
  notifyStudentMessageStateCleared(reason);
  broadcastToAllTabs('fab-state', {
    schemaVersion: 1,
    revision: 0,
    lifecycleRevision: 0,
    activeSessionIds: [],
    messagingEnabled: false,
    handRaisingEnabled: false,
    handRaised: false,
    reason,
  });
  broadcastToAllTabs('timer', { action: 'stop', reason });
  broadcastToAllTabs('poll', { action: 'close', reason });
}

function clearFabAndOverlayState(reason = 'identity-cleared', options = {}) {
  return enqueueFabStateMutation(() => clearFabAndOverlayStateNow(reason, options));
}

async function applyFabSettingsNow(rawFabState, options = {}) {
  if (!rawFabState || typeof rawFabState !== 'object') return {};
  const binding = fabIdentityBinding();
  if (!binding) return {};
  const stored = await kv.get([
    FAB_STATE_STORAGE_KEY,
    FAB_CONTEXT_STORAGE_KEY,
    FAB_CHAT_CONTEXT_STORAGE_KEY,
  ]);
  const rawBinding = exactStudentBinding(rawFabState);
  if (rawBinding.studentId || rawBinding.studentSessionId) {
    assertCurrentStudentBinding(rawFabState, 'FAB state');
  }
  const priorState = stored[FAB_STATE_STORAGE_KEY] || currentFabState || {};
  const priorContext = stored[FAB_CONTEXT_STORAGE_KEY] || {};
  const nextState = normalizeFabState(rawFabState, priorState);
  const priorSessionIds = normalizeIdList(priorContext.activeSessionIds);
  const sessionSetChanged = JSON.stringify(priorSessionIds) !== JSON.stringify(nextState.activeSessionIds);
  if (priorContext.binding === binding) {
    const priorOwnershipKnown = priorContext.ownershipRevisionKnown === true;
    const nextOwnershipKnown = nextState.ownershipRevisionKnown === true;
    const priorOwnershipRevision = Number(priorContext.ownershipRevision || 0);
    const nextOwnershipRevision = Number(nextState.ownershipRevision || 0);

    // Session FAB revisions are scoped to one teaching session and can reset
    // when a replacement class starts. The student's control-state revision is
    // the monotonic ownership watermark across class and coverage transitions.
    // Once that watermark is available, never let a delayed snapshot for the
    // previous owner replace the current session set.
    if (priorOwnershipKnown && nextOwnershipKnown) {
      if (nextOwnershipRevision < priorOwnershipRevision) return priorState;
      if (nextOwnershipRevision === priorOwnershipRevision && sessionSetChanged) return priorState;
      if (
        nextOwnershipRevision === priorOwnershipRevision
        && Number(priorContext.revision || 0) > Number(nextState.revision || 0)
      ) return priorState;
    } else if (priorOwnershipKnown && sessionSetChanged) {
      // A legacy payload may still update toggles for the current owner, but it
      // cannot replace an ownership-bound session set.
      return priorState;
    } else if (
      !sessionSetChanged
      && Number(nextState.revision || 0) > 0
      && Number(priorContext.revision || 0) > Number(nextState.revision || 0)
    ) {
      return priorState;
    }
  }

  const bindingChanged = priorContext.binding !== binding;
  const lifecycleEnded = ['session-ended', 'entitlement-inactive']
    .includes(nextState.reason) || nextState.activeSessionIds.length === 0;
  const lifecycleChanged = bindingChanged || sessionSetChanged;
  const context = {
    schemaVersion: 1,
    binding,
    teachingSessionId: nextState.teachingSessionId,
    activeSessionIds: nextState.activeSessionIds,
    revision: nextState.revision,
    lifecycleRevision: nextState.lifecycleRevision,
    ownershipRevision: nextState.ownershipRevision,
    ownershipRevisionKnown: nextState.ownershipRevisionKnown,
  };
  const updates = {
    [FAB_STATE_STORAGE_KEY]: nextState,
    [FAB_CONTEXT_STORAGE_KEY]: context,
    messagingEnabled: nextState.messagingEnabled,
    handRaisingEnabled: nextState.handRaisingEnabled,
    handRaised: nextState.handRaised,
    fabActiveSessionIds: nextState.activeSessionIds,
    fabActiveHands: nextState.activeHands,
    fabSessions: nextState.sessions,
    fabLifecycleSessionId: nextState.teachingSessionId,
    fabLifecycleReason: nextState.reason,
  };
  if (lifecycleChanged) {
    updates.fabChatMessages = [];
    updates.fabChatClosed = lifecycleEnded;
    updates[FAB_CHAT_CONTEXT_STORAGE_KEY] = context;
  } else if (!stored[FAB_CHAT_CONTEXT_STORAGE_KEY]) {
    updates[FAB_CHAT_CONTEXT_STORAGE_KEY] = context;
  }
  if (lifecycleEnded) {
    updates.handRaised = false;
    nextState.handRaised = false;
  }
  await kv.set(updates);
  currentFabState = nextState;
  if (lifecycleChanged) {
    await clearClassroomOverlayState(`fab:${nextState.reason || 'lifecycle-change'}`);
  }
  if (options.broadcast !== false) {
    broadcastToAllTabs('fab-state', { ...nextState, context });
  }
  return nextState;
}

function applyFabSettings(rawFabState, options = {}) {
  return enqueueFabStateMutation(() => applyFabSettingsNow(rawFabState, options));
}

async function updateLocalFabHandRaised(handRaised, reason) {
  if (!currentFabState) {
    await kv.set({ handRaised: handRaised === true });
    return;
  }
  await applyFabSettings({
    ...currentFabState,
    handRaised: handRaised === true,
    reason,
  });
}

let classroomOverlayMutation = Promise.resolve();

function activeTeachingSessionIds() {
  const fabSessions = normalizeIdList(currentFabState?.activeSessionIds);
  if (currentFabState) return fabSessions;
  return normalizeIdList(currentClassroomState?.teachingSessionId
    ? [currentClassroomState.teachingSessionId]
    : []);
}

function commandTeachingSessionId(command = {}) {
  return String(
    command.data?.teachingSessionId ||
    command.data?.sessionId ||
    currentFabState?.teachingSessionId ||
    currentClassroomState?.teachingSessionId ||
    ''
  ).trim() || null;
}

function overlayExpiresAt(value, fallback) {
  const parsed = typeof value === 'number' ? value : Date.parse(value || '');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function mutateClassroomOverlayState(operation) {
  classroomOverlayMutation = classroomOverlayMutation.then(async () => {
    const binding = fabIdentityBinding();
    const stored = await kv.get(CLASSROOM_OVERLAY_STORAGE_KEY);
    const prior = stored[CLASSROOM_OVERLAY_STORAGE_KEY];
    const state = prior?.binding === binding
      ? prior
      : { schemaVersion: 1, binding, timer: null, poll: null, updatedAt: Date.now() };
    const next = await operation(state, binding);
    await kv.set({ [CLASSROOM_OVERLAY_STORAGE_KEY]: next });
    scheduleClassroomOverlayExpiry(next);
    return next;
  }, async () => null);
  return classroomOverlayMutation;
}

function scheduleClassroomOverlayExpiry(state) {
  chrome.alarms.clear(CLASSROOM_OVERLAY_EXPIRY_ALARM);
  const candidates = [
    state?.timer?.endsAt ? Number(state.timer.endsAt) + 5000 : null,
    state?.poll?.expiresAt ? Number(state.poll.expiresAt) : null,
  ].filter((value) => Number.isFinite(value) && value > Date.now());
  if (candidates.length > 0) {
    chrome.alarms.create(CLASSROOM_OVERLAY_EXPIRY_ALARM, {
      when: Math.min(...candidates),
    });
  }
}

function persistTimerOverlay(command, executionContext = {}) {
  const action = command.data?.action;
  return mutateClassroomOverlayState(async (state, binding) => {
    if (!binding || action !== 'start') {
      return { ...state, binding, timer: null, updatedAt: Date.now() };
    }
    const seconds = Math.max(0, Number(command.data?.seconds || 0));
    const endsAt = overlayExpiresAt(
      command.data?.endsAt ?? command.data?.endAt,
      Date.now() + seconds * 1000
    );
    if (!Number.isFinite(endsAt) || endsAt <= Date.now()) {
      throw new Error('Timer end time is missing or expired');
    }
    return {
      ...state,
      binding,
      timer: {
        commandId: executionContext.commandId || null,
        teachingSessionId: commandTeachingSessionId(command),
        endsAt,
        message: String(command.data?.message || '').slice(0, 500),
        receivedAt: Date.now(),
      },
      updatedAt: Date.now(),
    };
  });
}

function persistPollOverlay(command, executionContext = {}) {
  const action = command.data?.action;
  const pollId = String(command.data?.pollId || '').trim();
  return mutateClassroomOverlayState(async (state, binding) => {
    if (!binding || action !== 'start') {
      if (pollId && state.poll?.pollId && state.poll.pollId !== pollId) return state;
      return { ...state, binding, poll: null, updatedAt: Date.now() };
    }
    if (!pollId) throw new Error('Poll start requires a pollId');
    const classExpiry = currentClassroomState
      ? RuntimeCore.classroomStateExpiry(currentClassroomState, Date.now()).expiresAt
      : null;
    const defaultExpiry = Math.min(
      Date.now() + 2 * 60 * 60 * 1000,
      Number(classExpiry || Number.MAX_SAFE_INTEGER)
    );
    const expiresAt = overlayExpiresAt(
      command.data?.pollExpiresAt ?? command.data?.expiresAt,
      defaultExpiry
    );
    return {
      ...state,
      binding,
      poll: {
        commandId: executionContext.commandId || null,
        pollId,
        teachingSessionId: commandTeachingSessionId(command),
        question: String(command.data?.question || '').slice(0, 1000),
        options: (Array.isArray(command.data?.options) ? command.data.options : [])
          .slice(0, 20)
          .map((option) => String(option).slice(0, 500)),
        expiresAt,
        receivedAt: Date.now(),
        response: null,
      },
      updatedAt: Date.now(),
    };
  });
}

async function clearClassroomOverlayState(reason = 'cleared') {
  classroomOverlayMutation = classroomOverlayMutation.then(async () => {
    await chrome.alarms.clear(CLASSROOM_OVERLAY_EXPIRY_ALARM);
    await kv.set({ [CLASSROOM_OVERLAY_STORAGE_KEY]: null });
  }, async () => {
    await kv.set({ [CLASSROOM_OVERLAY_STORAGE_KEY]: null });
  });
  await classroomOverlayMutation;
  broadcastToAllTabs('timer', { action: 'stop', reason });
  broadcastToAllTabs('poll', { action: 'close', reason });
}

async function getRestorableClassroomOverlayState() {
  await classroomOverlayMutation;
  const binding = fabIdentityBinding();
  const stored = await kv.get(CLASSROOM_OVERLAY_STORAGE_KEY);
  const state = stored[CLASSROOM_OVERLAY_STORAGE_KEY];
  if (!binding || state?.binding !== binding) {
    if (state) await kv.set({ [CLASSROOM_OVERLAY_STORAGE_KEY]: null });
    return { timer: null, poll: null };
  }
  const now = Date.now();
  const sessionIds = activeTeachingSessionIds();
  const sessionMatches = (overlay) => !overlay?.teachingSessionId
    || sessionIds.includes(overlay.teachingSessionId);
  const timer = state.timer && Number(state.timer.endsAt) > now && sessionMatches(state.timer)
    ? state.timer
    : null;
  const poll = state.poll && Number(state.poll.expiresAt) > now && sessionMatches(state.poll)
    ? state.poll
    : null;
  if (timer !== state.timer || poll !== state.poll) {
    const next = { ...state, timer, poll, updatedAt: now };
    await kv.set({ [CLASSROOM_OVERLAY_STORAGE_KEY]: next });
    scheduleClassroomOverlayExpiry(next);
  }
  return { timer, poll };
}

async function expireClassroomOverlays() {
  await mutateClassroomOverlayState(async (state) => {
    const now = Date.now();
    const timerExpired = state.timer && Number(state.timer.endsAt) + 5000 <= now;
    const pollExpired = state.poll && Number(state.poll.expiresAt) <= now;
    if (timerExpired) broadcastToAllTabs('timer', { action: 'stop', reason: 'expired' });
    if (pollExpired) broadcastToAllTabs('poll', { action: 'close', reason: 'expired' });
    return {
      ...state,
      timer: timerExpired ? null : state.timer,
      poll: pollExpired ? null : state.poll,
      updatedAt: now,
    };
  });
}

function markPollResponsePersisted(pollId, selectedOption) {
  return mutateClassroomOverlayState(async (state) => {
    if (state.poll?.pollId !== pollId) return state;
    return {
      ...state,
      poll: {
        ...state.poll,
        response: { selectedOption, submittedAt: Date.now() },
      },
      updatedAt: Date.now(),
    };
  });
}

async function sendChatDeliveryAck(message, deliveryStatus, errorMessage) {
  const messageId = message.chatMessageId || message.messageId;
  if (!messageId) return false;
  const ack = {
    type: 'chat-message-ack',
    ackId: `chat:${messageId}:${deliveryStatus}`,
    messageId,
    chatMessageId: messageId,
    sessionId: message.sessionId,
    deliveryStatus,
    status: deliveryStatus,
    errorMessage: errorMessage || null,
    timestamp: new Date().toISOString(),
  };
  await enqueueChatAck(ack);
  await wsSend(ack);
  scheduleChatAckFlush();
  return true;
}

function determineTrackingState() {
  const effectiveSettings = schoolSettings || { enableTrackingHours: false };
  const afterHoursMode = effectiveSettings.afterHoursMode || 'off';
  // School hours enforcement is based solely on admin-configured /api/settings values.
  const withinHours = isWithinTrackingHours(
    effectiveSettings.enableTrackingHours,
    effectiveSettings.trackingStartTime,
    effectiveSettings.trackingEndTime,
    effectiveSettings.schoolTimezone,
    effectiveSettings.trackingDays
  );

  if (!withinHours) {
    if (afterHoursMode === 'off') {
      isScheduleHardOff = true;
      return TRACKING_STATES.OFF;
    }
    isScheduleHardOff = false;
  } else {
    isScheduleHardOff = false;
  }

  if (idleState === 'idle' || idleState === 'locked') {
    return TRACKING_STATES.IDLE;
  }

  return TRACKING_STATES.ACTIVE;
}

function disconnectWebSocket() {
  chrome.alarms.clear('ws-reconnect');
  cleanupTeacherBroadcast('websocket-disconnect', { notifyTeacher: false });
  const hadActiveLiveView = Boolean(activeLiveViewNegotiationId);
  if (hadActiveLiveView) {
    setObservedState(false, 'websocket-disconnect');
  }
  wsConnected = false;
  wsTransportConnected = false;
  wsAuthenticatedGeneration = 0;
  // Tell offscreen document to close the WebSocket
  const closePromise = sendToOffscreen({
    type: 'WS_CLOSE',
    connectionGeneration: wsConnectionGeneration,
  }).then((response) => {
    activeLiveViewNegotiationId = null;
    activeLiveViewTeachingSessionId = null;
    return response;
  }).catch(() => {});
  if (ws) {
    try {
      ws.close();
    } catch (error) {
      console.warn('WebSocket close failed:', error);
    }
  }
  ws = null;
  return closePromise;
}

function scheduleHeartbeat(periodInMinutes) {
  // Clear any existing heartbeat mechanisms
  chrome.alarms.clear('heartbeat');
  if (heartbeatIntervalId) {
    clearInterval(heartbeatIntervalId);
    heartbeatIntervalId = null;
  }

  if (periodInMinutes) {
    // Use setInterval for 10-second heartbeats (Chrome alarms minimum is 30 seconds)
    heartbeatIntervalId = setInterval(() => {
      safeSendHeartbeat('interval');
    }, HEARTBEAT_INTERVAL_MS);
    // Chrome alarms survive MV3 worker suspension. They cannot provide the
    // 10-second foreground cadence, so they are the independent 30-second
    // recovery path rather than a replacement for the interval.
    chrome.alarms.create('heartbeat', {
      periodInMinutes: Math.max(0.5, Number(periodInMinutes) || 0.5),
    });
    // Send immediately when starting
    safeSendHeartbeat('schedule');
    console.log('[Heartbeat] Scheduled every 10 seconds');
  }
}

function clearNetworkAlarms() {
  chrome.alarms.clear('settings-refresh');
  chrome.alarms.clear('license-check');
  chrome.alarms.clear('ws-reconnect');
  chrome.alarms.clear(HEALTH_CHECK_ALARM_NAME);
  chrome.alarms.clear(CONNECTIVITY_HEALTH_ALARM_NAME);
  chrome.alarms.clear('heartbeat');
  // Also clear setInterval-based heartbeat
  if (heartbeatIntervalId) {
    clearInterval(heartbeatIntervalId);
    heartbeatIntervalId = null;
  }
  settingsAlarmScheduled = false;
}

async function pauseNetworkForOffHours(reason) {
  if (offHoursNetworkPaused) {
    return;
  }
  console.log(`[Network] Pausing off-hours traffic (${reason})`);
  clearNetworkAlarms();
  scheduleHeartbeat(null);
  await disconnectWebSocket();
  chrome.alarms.create('wake-up', { periodInMinutes: 5 });
  offHoursNetworkPaused = true;
}

async function resumeNetworkAfterOffHours(reason) {
  if (!offHoursNetworkPaused) {
    return;
  }
  console.log(`[Network] Resuming traffic (${reason})`);
  chrome.alarms.clear('wake-up');
  chrome.alarms.create('settings-refresh', { periodInMinutes: 60 });
  settingsAlarmScheduled = true;
  scheduleLicenseCheck();
  scheduleHealthCheckAlarm();
  offHoursNetworkPaused = false;
  await refreshSchoolSettings({ force: true });
  await checkLicenseStatus('resume');
  await updateTrackingState('resume');
}

async function safeSendHeartbeat(reason) {
  if (heartbeatInFlight) {
    heartbeatPendingReason = reason;
    console.log(`[Heartbeat] Coalescing ${reason}; previous heartbeat still in flight`);
    return;
  }
  if (Date.now() < apiBackoffUntilMs) {
    console.log(`[Heartbeat] Skipping ${reason}; API backoff active`);
    return;
  }
  heartbeatInFlight = true;
  try {
    await sendHeartbeat(reason);
  } catch (error) {
    if (globalThis.Sentry?.captureException) {
      globalThis.Sentry.captureException(error);
    }
    console.warn(`[Heartbeat] Failed (${reason}):`, error?.message || error);
  } finally {
    heartbeatInFlight = false;
    if (heartbeatPendingReason) {
      const pendingReason = heartbeatPendingReason;
      heartbeatPendingReason = null;
      setTimeout(() => safeSendHeartbeat(`coalesced:${pendingReason}`), 0);
    }
  }
}

function generateOpaqueTabRef() {
  const random = globalThis.crypto?.randomUUID?.()
    || `${Date.now()}-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
  return `tab_${String(random).replace(/[^a-zA-Z0-9]/g, '')}`;
}

function tabSnapshotAuthBinding() {
  return monitoringEventAuthBinding();
}

function buildOpaqueTabSnapshot(rawTabs) {
  const tabs = (Array.isArray(rawTabs) ? rawTabs : [])
    .filter((tab) => Number.isInteger(tab?.id) && isHttpUrl(tab?.url))
    .slice(0, 20);
  const binding = tabSnapshotAuthBinding();
  if (!binding) {
    return Promise.resolve({ schemaVersion: 1, revision: 0, tabs: [], localEntries: [] });
  }

  tabSnapshotMutation = tabSnapshotMutation.then(async () => {
    const stored = await kv.get(TAB_SNAPSHOT_STORAGE_KEY);
    const prior = stored[TAB_SNAPSHOT_STORAGE_KEY];
    const bindingMatches = prior?.binding === binding;
    const priorById = new Map((bindingMatches && Array.isArray(prior.entries) ? prior.entries : [])
      .map((entry) => [entry.tabId, entry]));
    const localEntries = tabs.map((tab) => ({
      tabId: tab.id,
      tabRef: priorById.get(tab.id)?.tabRef || generateOpaqueTabRef(),
      url: String(tab.url || '').slice(0, 512),
      title: String(tab.title || 'Untitled').slice(0, 512),
    }));
    const previousProjection = (bindingMatches && Array.isArray(prior.entries) ? prior.entries : [])
      .map(({ tabId, tabRef, url, title }) => ({ tabId, tabRef, url, title }));
    const changed = JSON.stringify(previousProjection) !== JSON.stringify(localEntries);
    const priorRevision = bindingMatches ? Number(prior.revision || 0) : 0;
    const revision = Math.max(1, priorRevision + (changed ? 1 : 0));
    const next = {
      schemaVersion: 1,
      binding,
      revision,
      entries: localEntries,
      updatedAt: Date.now(),
    };
    await kv.set({ [TAB_SNAPSHOT_STORAGE_KEY]: next });
    currentTabSnapshotRevision = revision;
    return {
      schemaVersion: 1,
      revision,
      tabs: localEntries.map(({ tabRef, url, title }) => ({ tabRef, url, title })),
      localEntries,
    };
  }, async () => ({ schemaVersion: 1, revision: 0, tabs: [], localEntries: [] }));
  return tabSnapshotMutation;
}

async function resolveExactTabRefs(rawTabRefs, expectedRevision) {
  const tabRefs = [...new Set((Array.isArray(rawTabRefs) ? rawTabRefs : [])
    .map((value) => String(value || '').trim())
    .filter(Boolean))];
  if (tabRefs.length === 0) throw new Error('Missing exact tab references');
  const currentTabs = await chrome.tabs.query({});
  const snapshot = await buildOpaqueTabSnapshot(currentTabs);
  const parsedExpected = Number(expectedRevision);
  if (Number.isSafeInteger(parsedExpected) && parsedExpected > 0 && parsedExpected !== snapshot.revision) {
    const error = new Error('Tab snapshot is stale; refresh before closing tabs');
    error.code = 'STALE_TAB_SNAPSHOT';
    throw error;
  }
  const byRef = new Map(snapshot.localEntries.map((entry) => [entry.tabRef, entry.tabId]));
  const missing = tabRefs.filter((tabRef) => !byRef.has(tabRef));
  if (missing.length > 0) {
    const error = new Error('One or more exact tab references are no longer open');
    error.code = 'TAB_REF_NOT_FOUND';
    throw error;
  }
  return {
    revision: snapshot.revision,
    targets: tabRefs.map((tabRef) => ({ tabRef, tabId: byRef.get(tabRef) })),
  };
}

function syncObservedHeartbeat(reason) {
  if (trackingState === TRACKING_STATES.ACTIVE && observedByTeacher) {
    if (!observedHeartbeatTimer) {
      observedHeartbeatTimer = setInterval(() => {
        safeSendHeartbeat('observed-interval');
      }, OBSERVED_HEARTBEAT_SECONDS * 1000);
      console.log(`[Heartbeat] Observed mode enabled (${reason})`);
      safeSendHeartbeat('observed-start');
    }
    return;
  }

  if (observedHeartbeatTimer) {
    clearInterval(observedHeartbeatTimer);
    observedHeartbeatTimer = null;
    console.log(`[Heartbeat] Observed mode disabled (${reason})`);
  }
}

function setObservedState(isObserved, reason) {
  if (observedByTeacher === isObserved) {
    return;
  }
  observedByTeacher = isObserved;
  syncObservedHeartbeat(reason);
}

async function transitionTrackingState(nextState, reason) {
  if (trackingState === nextState && persistedMonitoringState.state === nextState) return false;
  const changedAt = Date.now();
  trackingState = nextState;
  persistedMonitoringState = { state: nextState, changedAt, reason };
  await kv.set({ [MONITORING_STATE_STORAGE_KEY]: persistedMonitoringState });
  const queued = await enqueueMonitoringEvent('monitoring_state_changed', {
    state: nextState.toLowerCase(),
    reason,
  }, { occurredAt: changedAt });
  // Make a best-effort authenticated delivery while the socket/token/network
  // context is still intact. A retryable failure remains in the outbox.
  if (nextState === TRACKING_STATES.OFF && queued) {
    await flushMonitoringEventOutbox();
  }
  if (nextState === TRACKING_STATES.OFF) {
    await chrome.alarms.clear(CONNECTIVITY_HEALTH_ALARM_NAME);
  } else {
    await scheduleConnectivityHealthBoundary();
  }
  await setConnectivityBadge(connectivityStatus());
  console.log(`[Tracking] State updated to ${trackingState} (${reason})`);
  return true;
}

async function updateTrackingState(reason = 'state-check') {
  if (!licenseActive) {
    if (trackingState !== TRACKING_STATES.OFF) {
      await transitionTrackingState(TRACKING_STATES.OFF, 'license_inactive');
      scheduleHeartbeat(null);
      scheduleScreenshotCapture(false);  // Disable screenshots when license inactive
      await disconnectWebSocket();
      syncObservedHeartbeat('license-inactive');
    }
    return;
  }

  if (await expireManualAuthIfStale(`tracking:${reason}`)) {
    return;
  }

  if (!hasStudentAuth()) {
    if (trackingState !== TRACKING_STATES.OFF) {
      await transitionTrackingState(TRACKING_STATES.OFF, 'auth_required');
      scheduleHeartbeat(null);
      scheduleScreenshotCapture(false);
      await disconnectWebSocket();
      syncObservedHeartbeat('auth-required');
    }
    await notifyAuthGateStateToTabs();
    return;
  }

  const nextState = determineTrackingState();
  if (nextState === TRACKING_STATES.OFF && isScheduleHardOff) {
    if (trackingState !== nextState) {
      await transitionTrackingState(nextState, reason);
    }
    await pauseNetworkForOffHours(reason);
    syncObservedHeartbeat('tracking-state');
    return;
  }

  if (offHoursNetworkPaused) {
    await resumeNetworkAfterOffHours(reason);
    return;
  }

  if (trackingState === nextState) {
    return;
  }

  await transitionTrackingState(nextState, reason);

  if (trackingState === TRACKING_STATES.ACTIVE) {
    scheduleHeartbeat(HEARTBEAT_ACTIVE_MINUTES);
    scheduleScreenshotCapture(true);  // Enable screenshot capture when active
    connectWebSocket().catch(() => {});
  } else if (trackingState === TRACKING_STATES.IDLE) {
    // Keep same heartbeat frequency and WebSocket connected even when Chrome reports idle
    // Chrome's idle detection (no keyboard/mouse) doesn't mean student is away
    scheduleHeartbeat(HEARTBEAT_IDLE_MINUTES);
    scheduleScreenshotCapture(true);  // Keep screenshots even when idle
    connectWebSocket().catch(() => {});
  } else {
    scheduleHeartbeat(null);
    scheduleScreenshotCapture(false);  // Disable screenshots when tracking is off
    await disconnectWebSocket();
  }

  syncObservedHeartbeat('tracking-state');
}

async function initializeAdaptiveTracking(reason, options = {}) {
  const assertCurrent = () => {
    if (options.authMutationGeneration === undefined) return;
    assertAuthMutationBindingCurrent(
      options.authMutationGeneration,
      options.authBinding,
      `tracking initialization:${reason}`,
    );
  };
  assertCurrent();
  await loadCachedSchoolSettings();
  assertCurrent();
  await refreshSchoolSettings({
    force: false,
    authMutationGeneration: options.authMutationGeneration,
    authBinding: options.authBinding,
  });
  assertCurrent();

  if (!idleListenerReady && chrome.idle) {
    chrome.idle.setDetectionInterval(IDLE_DETECTION_SECONDS);
    chrome.idle.queryState(IDLE_DETECTION_SECONDS, (state) => {
      handleIdleStateChanged(state, 'idle-initial').catch(() => {});
    });
    chrome.idle.onStateChanged.addListener((state) => {
      handleIdleStateChanged(state, 'idle-change').catch(() => {});
    });
    idleListenerReady = true;
  }

  if (!settingsAlarmScheduled) {
    chrome.alarms.create('settings-refresh', { periodInMinutes: 60 });
    settingsAlarmScheduled = true;
  }
  scheduleHealthCheckAlarm();

  assertCurrent();
  if (options.authMutationGeneration === undefined) {
    updateTrackingState(reason).catch((error) => {
      console.warn('[Tracking] State initialization failed:', error?.message || error);
    });
  } else {
    await updateTrackingState(reason);
    assertCurrent();
  }
}

const MONITORING_EVENT_OUTBOX_KEY = 'monitoringEventOutboxV1';
const MONITORING_EVENT_DROPPED_KEY = 'monitoringEventOutboxDropped';
const MONITORING_EVENT_AUTH_BINDING_KEY = 'monitoringEventOutboxAuthBindingV1';
const MONITORING_EVENT_FLUSH_ALARM = 'monitoring-event-flush';
const MONITORING_EVENT_FLUSH_MS = 5000;
let monitoringEventFlushTimer = null;
let monitoringEventFlushInFlight = false;
let monitoringEventMutation = Promise.resolve();
let messageInboxMutation = Promise.resolve();

const COMMAND_ACK_OUTBOX_KEY = 'commandAckOutboxV1';
const COMMAND_ACK_BINDING_KEY = 'commandAckOutboxAuthBindingV1';
const COMMAND_ACK_FLUSH_ALARM = 'command-ack-flush';
const COMMAND_ACK_HTTP_FALLBACK_MS = 5000;
const COMMAND_ACK_MAX_ENTRIES = 200;
const COMMAND_ACK_MAX_AGE_MS = 24 * 60 * 60 * 1000;
const COMMAND_ACK_MAX_BYTES = 512 * 1024;
let commandAckMutation = Promise.resolve();
let commandAckFlushInFlight = false;
let commandAckRetryDelayMs = COMMAND_ACK_HTTP_FALLBACK_MS;
const CHAT_ACK_OUTBOX_KEY = 'chatAckOutboxV1';
const CHAT_ACK_BINDING_KEY = 'chatAckOutboxAuthBindingV1';
const CHAT_ACK_FLUSH_ALARM = 'chat-ack-flush';
let chatAckMutation = Promise.resolve();
let chatAckFlushInFlight = false;

function boundedAckObject(value, maxBytes = 16 * 1024) {
  if (value === undefined) return undefined;
  try {
    const serialized = JSON.stringify(value);
    if (RuntimeCore.utf8ByteLength(serialized) > maxBytes) {
      return { truncated: true };
    }
    return JSON.parse(serialized);
  } catch {
    return { serializationError: true };
  }
}

function normalizeCommandAckForStorage(rawAck, nowValue = Date.now()) {
  const commandId = normalizeCommandId(rawAck?.commandId);
  const ackState = String(rawAck?.ackState || '').trim();
  if (!commandId || !['received', 'completed', 'failed', 'expired'].includes(ackState)) return null;
  const ackId = String(rawAck?.ackId || `${commandId}:${ackState}`).trim().slice(0, 512);
  return {
    type: 'command-ack',
    ackId,
    commandId,
    ackState,
    commandType: String(rawAck?.commandType || '').slice(0, 80) || undefined,
    studentId: CONFIG.activeStudentId || undefined,
    deviceId: CONFIG.deviceId || undefined,
    result: boundedAckObject(rawAck?.result),
    state: boundedAckObject(rawAck?.state),
    error: rawAck?.error ? String(rawAck.error).slice(0, 500) : undefined,
    deliveryPolicy: rawAck?.deliveryPolicy,
    expiresAt: rawAck?.expiresAt,
    appliedRevision: Number(rawAck?.appliedRevision || 0),
    outcome: String(rawAck?.outcome || 'pending').slice(0, 80),
    extensionVersion: chrome.runtime.getManifest().version,
    timestamp: rawAck?.timestamp || new Date(nowValue).toISOString(),
    queuedAt: nowValue,
    lastWsAttemptAt: null,
  };
}

function boundCommandAckOutbox(entries, nowValue = Date.now()) {
  let bounded = (Array.isArray(entries) ? entries : [])
    .filter((ack) => ack?.ackId && Number(ack.queuedAt || 0) >= nowValue - COMMAND_ACK_MAX_AGE_MS)
    .slice(-COMMAND_ACK_MAX_ENTRIES);
  while (bounded.length > 0 && RuntimeCore.utf8ByteLength(bounded) > COMMAND_ACK_MAX_BYTES) {
    bounded.shift();
  }
  return bounded;
}

function scheduleCommandAckFlush(delayMs = COMMAND_ACK_HTTP_FALLBACK_MS) {
  chrome.alarms.get(COMMAND_ACK_FLUSH_ALARM, (existing) => {
    const when = Date.now() + Math.max(1000, Number(delayMs || 0));
    if (!existing || existing.scheduledTime > when) {
      chrome.alarms.create(COMMAND_ACK_FLUSH_ALARM, { when });
    }
  });
}

function enqueueCommandAck(rawAck) {
  const binding = monitoringEventAuthBinding();
  const normalized = normalizeCommandAckForStorage(rawAck);
  if (!binding || !normalized) return Promise.resolve(false);

  commandAckMutation = commandAckMutation.then(async () => {
    const stored = await kv.get([COMMAND_ACK_OUTBOX_KEY, COMMAND_ACK_BINDING_KEY]);
    let entries = stored[COMMAND_ACK_BINDING_KEY] === binding
      ? boundCommandAckOutbox(stored[COMMAND_ACK_OUTBOX_KEY])
      : [];
    const terminal = normalized.ackState !== 'received';
    if (terminal) {
      entries = entries.filter((ack) => ack.commandId !== normalized.commandId);
    } else if (entries.some((ack) => ack.commandId === normalized.commandId && ack.ackState !== 'received')) {
      return false;
    } else {
      entries = entries.filter((ack) => ack.ackId !== normalized.ackId);
    }
    entries = boundCommandAckOutbox([...entries, normalized]);
    await kv.set({
      [COMMAND_ACK_OUTBOX_KEY]: entries,
      [COMMAND_ACK_BINDING_KEY]: binding,
    });
    return true;
  }, async () => false);
  return commandAckMutation;
}

function removeCommandAcks(ackIds) {
  const acknowledged = new Set((Array.isArray(ackIds) ? ackIds : []).filter(Boolean));
  commandAckMutation = commandAckMutation.then(async () => {
    const stored = await kv.get([COMMAND_ACK_OUTBOX_KEY]);
    const remaining = boundCommandAckOutbox(stored[COMMAND_ACK_OUTBOX_KEY])
      .filter((ack) => !acknowledged.has(ack.ackId));
    await kv.set({ [COMMAND_ACK_OUTBOX_KEY]: remaining });
    if (remaining.length === 0) {
      commandAckRetryDelayMs = COMMAND_ACK_HTTP_FALLBACK_MS;
      await kv.remove(COMMAND_ACK_BINDING_KEY);
      await chrome.alarms.clear(COMMAND_ACK_FLUSH_ALARM);
    }
    return remaining.length;
  });
  return commandAckMutation;
}

async function discardCommandAckOutbox() {
  commandAckMutation = commandAckMutation.then(async () => {
    await kv.set({ [COMMAND_ACK_OUTBOX_KEY]: [] });
    await kv.remove(COMMAND_ACK_BINDING_KEY);
    await chrome.alarms.clear(COMMAND_ACK_FLUSH_ALARM);
  });
  return commandAckMutation;
}

async function flushCommandAckOutbox(options = {}) {
  if (commandAckFlushInFlight || !hasStudentAuth()) return;
  commandAckFlushInFlight = true;
  try {
    await commandAckMutation;
    const binding = monitoringEventAuthBinding();
    const stored = await kv.get([COMMAND_ACK_OUTBOX_KEY, COMMAND_ACK_BINDING_KEY]);
    if (!binding || stored[COMMAND_ACK_BINDING_KEY] !== binding) {
      await discardCommandAckOutbox();
      return;
    }
    const batch = boundCommandAckOutbox(stored[COMMAND_ACK_OUTBOX_KEY]).slice(0, 50);
    if (batch.length === 0) {
      await chrome.alarms.clear(COMMAND_ACK_FLUSH_ALARM);
      return;
    }

    let wsAttempted = false;
    if (wsConnected) {
      for (const ack of batch) {
        wsAttempted = (await wsSend(ack)) || wsAttempted;
      }
    }
    const oldestAge = Date.now() - Math.min(...batch.map((ack) => Number(ack.queuedAt || 0)));
    if (wsAttempted && oldestAge < COMMAND_ACK_HTTP_FALLBACK_MS && options.forceHttp !== true) {
      scheduleCommandAckFlush(COMMAND_ACK_HTTP_FALLBACK_MS - oldestAge);
      return;
    }

    const payload = {
      acks: batch.map(({ queuedAt, lastWsAttemptAt, ...ack }) => ack),
    };
    const response = await fetchWithBackoff(`${CONFIG.serverUrl}/api/classpilot/device/command-acks`, {
      method: 'POST',
      headers: buildDeviceAuthHeaders(),
      body: JSON.stringify(payload),
    }, {
      context: 'command acknowledgement',
      maxAttempts: 1,
      retryStatuses: new Set([429, 503]),
    });
    if (!response.ok) {
      commandAckRetryDelayMs = Math.min(commandAckRetryDelayMs * 2, 5 * 60 * 1000);
      scheduleCommandAckFlush(commandAckRetryDelayMs);
      return;
    }
    const data = await response.json().catch(() => ({}));
    const receiptIds = (Array.isArray(data.receipts) ? data.receipts : [])
      .map((receipt) => receipt?.ackId)
      .filter(Boolean);
    if (receiptIds.length === 0) {
      commandAckRetryDelayMs = Math.min(commandAckRetryDelayMs * 2, 5 * 60 * 1000);
      scheduleCommandAckFlush(commandAckRetryDelayMs);
      return;
    }
    if (binding !== monitoringEventAuthBinding()) {
      await discardCommandAckOutbox();
      return;
    }
    const remaining = await removeCommandAcks(receiptIds);
    commandAckRetryDelayMs = COMMAND_ACK_HTTP_FALLBACK_MS;
    if (remaining > 0) scheduleCommandAckFlush();
  } catch (error) {
    console.warn('[Command ACK] Flush deferred:', error?.message || error);
    commandAckRetryDelayMs = Math.min(commandAckRetryDelayMs * 2, 5 * 60 * 1000);
    scheduleCommandAckFlush(commandAckRetryDelayMs);
  } finally {
    commandAckFlushInFlight = false;
  }
}

function scheduleChatAckFlush(delayMs = COMMAND_ACK_HTTP_FALLBACK_MS) {
  chrome.alarms.get(CHAT_ACK_FLUSH_ALARM, (existing) => {
    const when = Date.now() + Math.max(1000, Number(delayMs || 0));
    if (!existing || existing.scheduledTime > when) {
      chrome.alarms.create(CHAT_ACK_FLUSH_ALARM, { when });
    }
  });
}

function enqueueChatAck(rawAck) {
  const binding = monitoringEventAuthBinding();
  if (!binding || !rawAck?.ackId || !rawAck?.messageId) return Promise.resolve(false);
  const ack = {
    type: 'chat-message-ack',
    ackId: String(rawAck.ackId).slice(0, 512),
    messageId: String(rawAck.messageId).slice(0, 256),
    chatMessageId: String(rawAck.messageId).slice(0, 256),
    sessionId: rawAck.sessionId ? String(rawAck.sessionId).slice(0, 256) : undefined,
    deliveryStatus: rawAck.deliveryStatus === 'failed' ? 'failed' : 'delivered',
    status: rawAck.deliveryStatus === 'failed' ? 'failed' : 'delivered',
    errorMessage: rawAck.errorMessage ? String(rawAck.errorMessage).slice(0, 500) : null,
    timestamp: rawAck.timestamp || new Date().toISOString(),
    queuedAt: Date.now(),
  };
  chatAckMutation = chatAckMutation.then(async () => {
    const stored = await kv.get([CHAT_ACK_OUTBOX_KEY, CHAT_ACK_BINDING_KEY]);
    let entries = stored[CHAT_ACK_BINDING_KEY] === binding && Array.isArray(stored[CHAT_ACK_OUTBOX_KEY])
      ? stored[CHAT_ACK_OUTBOX_KEY]
      : [];
    entries = entries.filter((item) => item.ackId !== ack.ackId);
    if (ack.status === 'delivered') {
      entries = entries.filter((item) => item.messageId !== ack.messageId);
    }
    entries.push(ack);
    entries = entries
      .filter((item) => Number(item.queuedAt || 0) >= Date.now() - COMMAND_ACK_MAX_AGE_MS)
      .slice(-COMMAND_ACK_MAX_ENTRIES);
    while (entries.length > 0 && RuntimeCore.utf8ByteLength(entries) > COMMAND_ACK_MAX_BYTES) entries.shift();
    await kv.set({ [CHAT_ACK_OUTBOX_KEY]: entries, [CHAT_ACK_BINDING_KEY]: binding });
    return true;
  });
  return chatAckMutation;
}

function removeChatAcks(ackIds) {
  const acknowledged = new Set(ackIds || []);
  chatAckMutation = chatAckMutation.then(async () => {
    const stored = await kv.get(CHAT_ACK_OUTBOX_KEY);
    const remaining = (stored[CHAT_ACK_OUTBOX_KEY] || [])
      .filter((ack) => !acknowledged.has(ack.ackId));
    await kv.set({ [CHAT_ACK_OUTBOX_KEY]: remaining });
    if (remaining.length === 0) {
      await kv.remove(CHAT_ACK_BINDING_KEY);
      await chrome.alarms.clear(CHAT_ACK_FLUSH_ALARM);
    }
    return remaining.length;
  });
  return chatAckMutation;
}

async function discardChatAckOutbox() {
  chatAckMutation = chatAckMutation.then(async () => {
    await kv.set({ [CHAT_ACK_OUTBOX_KEY]: [] });
    await kv.remove(CHAT_ACK_BINDING_KEY);
    await chrome.alarms.clear(CHAT_ACK_FLUSH_ALARM);
  });
  return chatAckMutation;
}

async function flushChatAckOutbox(options = {}) {
  if (chatAckFlushInFlight || !hasStudentAuth()) return;
  chatAckFlushInFlight = true;
  try {
    await chatAckMutation;
    const binding = monitoringEventAuthBinding();
    const stored = await kv.get([CHAT_ACK_OUTBOX_KEY, CHAT_ACK_BINDING_KEY]);
    if (!binding || stored[CHAT_ACK_BINDING_KEY] !== binding) {
      await discardChatAckOutbox();
      return;
    }
    const batch = (stored[CHAT_ACK_OUTBOX_KEY] || []).slice(0, 50);
    if (batch.length === 0) {
      await chrome.alarms.clear(CHAT_ACK_FLUSH_ALARM);
      return;
    }
    let wsAttempted = false;
    if (wsConnected) {
      for (const ack of batch) wsAttempted = (await wsSend(ack)) || wsAttempted;
    }
    const oldestAge = Date.now() - Math.min(...batch.map((ack) => Number(ack.queuedAt || 0)));
    if (wsAttempted && oldestAge < COMMAND_ACK_HTTP_FALLBACK_MS && options.forceHttp !== true) {
      scheduleChatAckFlush(COMMAND_ACK_HTTP_FALLBACK_MS - oldestAge);
      return;
    }
    const response = await fetchWithBackoff(`${CONFIG.serverUrl}/api/classpilot/device/chat-acks`, {
      method: 'POST',
      headers: buildDeviceAuthHeaders(),
      body: JSON.stringify({
        acks: batch.map(({ queuedAt, type, chatMessageId, deliveryStatus, timestamp, sessionId, ...ack }) => ack),
      }),
    }, {
      context: 'chat acknowledgement',
      maxAttempts: 1,
      retryStatuses: new Set([429, 503]),
    });
    if (!response.ok) {
      scheduleChatAckFlush(30 * 1000);
      return;
    }
    const data = await response.json().catch(() => ({}));
    const receiptIds = (Array.isArray(data.receipts) ? data.receipts : [])
      .map((receipt) => receipt?.ackId)
      .filter(Boolean);
    if (binding !== monitoringEventAuthBinding()) {
      await discardChatAckOutbox();
      return;
    }
    if (receiptIds.length === 0) {
      scheduleChatAckFlush(30 * 1000);
      return;
    }
    const remaining = await removeChatAcks(receiptIds);
    if (remaining > 0) scheduleChatAckFlush();
  } catch (error) {
    console.warn('[Chat ACK] Flush deferred:', error?.message || error);
    scheduleChatAckFlush(30 * 1000);
  } finally {
    chatAckFlushInFlight = false;
  }
}

function generateMonitoringEventId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `evt-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function monitoringEventAuthBinding() {
  if (
    !CONFIG.studentToken
    || !CONFIG.deviceId
    || !CONFIG.activeStudentId
    || !CONFIG.activeStudentSessionId
  ) return null;
  // This is a local correlation guard, not an authentication primitive. Hash
  // the already-authenticated token so the outbox never persists another copy
  // of the credential, especially for session-only manual sign-ins.
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let index = 0; index < CONFIG.studentToken.length; index += 1) {
    const code = CONFIG.studentToken.charCodeAt(index);
    first = Math.imul(first ^ code, 0x01000193) >>> 0;
    second = Math.imul(second ^ code, 0x85ebca6b) >>> 0;
  }
  return [
    'v2',
    CONFIG.activeStudentId,
    CONFIG.activeStudentSessionId,
    CONFIG.deviceId,
    first.toString(16).padStart(8, '0'),
    second.toString(16).padStart(8, '0'),
  ].join(':');
}

function messageInboxAuthBinding() {
  // The monitoring binding already captures the exact student, device, and
  // token-backed session without persisting the raw credential.
  return monitoringEventAuthBinding();
}

function enqueueMessageInboxMutation(operation) {
  messageInboxMutation = messageInboxMutation.then(operation, operation);
  return messageInboxMutation;
}

function messageWithStableLocalId(rawMessage, prefix = 'message') {
  const stableId = RuntimeCore.teacherMessageId(rawMessage);
  return {
    ...(rawMessage || {}),
    id: stableId
      || `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`}`,
  };
}

function notifyStudentMessageStateCleared(reason) {
  broadcastToAllTabs('student-message-state-cleared', { reason });
}

async function reconcileMessageInboxIdentityNow(reason = 'identity-check') {
  const binding = messageInboxAuthBinding();
  const stored = await kv.get([
    MESSAGE_INBOX_STORAGE_KEY,
    MESSAGE_INBOX_BINDING_KEY,
    MESSAGE_INBOX_DEDUP_KEY,
    'fabChatMessages',
    'fabChatClosed',
  ]);
  const storedBinding = stored[MESSAGE_INBOX_BINDING_KEY] || null;
  const bindingChanged = storedBinding !== binding;

  if (!binding || bindingChanged) {
    await kv.set({
      [MESSAGE_INBOX_STORAGE_KEY]: [],
      [MESSAGE_INBOX_DEDUP_KEY]: [],
      fabChatMessages: [],
      fabChatClosed: false,
      ...(binding ? { [MESSAGE_INBOX_BINDING_KEY]: binding } : {}),
    });
    if (!binding) await kv.remove(MESSAGE_INBOX_BINDING_KEY);
    if (
      storedBinding
      || (Array.isArray(stored[MESSAGE_INBOX_STORAGE_KEY]) && stored[MESSAGE_INBOX_STORAGE_KEY].length > 0)
      || (Array.isArray(stored.fabChatMessages) && stored.fabChatMessages.length > 0)
    ) {
      notifyStudentMessageStateCleared(reason);
    }
    return { binding, bindingChanged, messages: [], seenIds: [] };
  }

  return {
    binding,
    bindingChanged: false,
    messages: Array.isArray(stored[MESSAGE_INBOX_STORAGE_KEY])
      ? stored[MESSAGE_INBOX_STORAGE_KEY]
      : [],
    seenIds: Array.isArray(stored[MESSAGE_INBOX_DEDUP_KEY])
      ? stored[MESSAGE_INBOX_DEDUP_KEY]
      : [],
  };
}

function reconcileMessageInboxIdentity(reason = 'identity-check') {
  return enqueueMessageInboxMutation(() => reconcileMessageInboxIdentityNow(reason));
}

function persistTeacherMessages(rawMessages, options = {}) {
  return enqueueMessageInboxMutation(async () => {
    const identity = await reconcileMessageInboxIdentityNow(options.reason || 'message-delivery');
    if (!identity.binding) {
      return { messages: [], seenIds: [], addedMessageIds: [] };
    }
    if (
      Object.prototype.hasOwnProperty.call(options, 'expectedBinding')
      && options.expectedBinding !== identity.binding
    ) {
      // The response belonged to an earlier authenticated student/session.
      // Never attach its inbox rows to whoever is signed in now.
      return { messages: identity.messages, seenIds: identity.seenIds, addedMessageIds: [] };
    }
    const merged = RuntimeCore.mergeTeacherMessageInbox(
      identity.messages,
      identity.seenIds,
      rawMessages,
      options.nowValue ?? Date.now()
    );
    await kv.set({
      [MESSAGE_INBOX_STORAGE_KEY]: merged.messages,
      [MESSAGE_INBOX_DEDUP_KEY]: merged.seenIds,
      [MESSAGE_INBOX_BINDING_KEY]: identity.binding,
    });
    if (merged.addedMessageIds.length > 0) {
      chrome.runtime.sendMessage({ type: 'messages-updated' }).catch(() => {});
    }
    return merged;
  });
}

function persistHeartbeatPendingMessages(rawMessages, expectedBinding = messageInboxAuthBinding()) {
  // Heartbeat inbox rows must carry a backend-stable id. Do not synthesize an
  // id here: a malformed row repeated on every heartbeat would otherwise be
  // displayed repeatedly.
  return persistTeacherMessages(rawMessages, {
    reason: 'heartbeat-pending-messages',
    expectedBinding,
  });
}

function getCurrentMessageInbox() {
  return enqueueMessageInboxMutation(async () => {
    const identity = await reconcileMessageInboxIdentityNow('message-inbox-read');
    return identity.messages;
  });
}

function markCurrentMessageInboxRead() {
  return enqueueMessageInboxMutation(async () => {
    const identity = await reconcileMessageInboxIdentityNow('message-inbox-read-state');
    if (!identity.binding || !identity.messages.some((message) => message?.read !== true)) {
      return identity.messages;
    }
    const messages = identity.messages.map((message) => ({ ...message, read: true }));
    await kv.set({ [MESSAGE_INBOX_STORAGE_KEY]: messages });
    return messages;
  });
}

function clearCurrentMessageInboxDisplay() {
  return enqueueMessageInboxMutation(async () => {
    const identity = await reconcileMessageInboxIdentityNow('message-inbox-clear-display');
    if (!identity.binding) return [];
    // Keep the bounded seen-id ledger so a backend retry cannot resurrect a
    // message the student deliberately cleared from the display.
    await kv.set({ [MESSAGE_INBOX_STORAGE_KEY]: [] });
    return [];
  });
}

function clearStudentMessageState(reason = 'student-auth-cleared') {
  return enqueueMessageInboxMutation(async () => {
    await kv.set({
      [MESSAGE_INBOX_STORAGE_KEY]: [],
      [MESSAGE_INBOX_DEDUP_KEY]: [],
      fabChatMessages: [],
      fabChatClosed: false,
    });
    await kv.remove(MESSAGE_INBOX_BINDING_KEY);
    notifyStudentMessageStateCleared(reason);
  });
}

function getMonitoringEventScope() {
  return {
    teachingSessionId: currentClassroomState?.teachingSessionId || null,
    supervisionContextId: currentClassroomState?.supervisionContextId || null,
  };
}

function scheduleMonitoringEventFlush(delayMs = MONITORING_EVENT_FLUSH_MS) {
  const normalizedDelay = Math.max(0, delayMs);
  // This is a bounded flush interval, not a trailing debounce. Continuous tab
  // activity must not keep moving delivery five seconds into the future.
  if (!monitoringEventFlushTimer) {
    monitoringEventFlushTimer = setTimeout(() => {
      monitoringEventFlushTimer = null;
      flushMonitoringEventOutbox().catch(() => {});
    }, normalizedDelay);
  }
  chrome.alarms.get(MONITORING_EVENT_FLUSH_ALARM, (existing) => {
    if (existing) return;
    chrome.alarms.create(MONITORING_EVENT_FLUSH_ALARM, {
      when: Date.now() + Math.max(MONITORING_EVENT_FLUSH_MS, normalizedDelay),
    });
  });
}

function enqueueMonitoringEvent(type, metadata = {}, options = {}) {
  if (!hasStudentAuth() && !options.allowWithoutAuth) return Promise.resolve(false);
  const authBinding = monitoringEventAuthBinding();
  if (!authBinding) return Promise.resolve(false);
  const scope = getMonitoringEventScope();
  const event = RuntimeCore.createMonitoringEvent({
    type,
    metadata,
    occurredAt: options.occurredAt,
    teachingSessionId: options.teachingSessionId ?? scope.teachingSessionId,
    supervisionContextId: options.supervisionContextId ?? scope.supervisionContextId,
  }, generateMonitoringEventId);
  if (!event) return Promise.resolve(false);

  monitoringEventMutation = monitoringEventMutation.then(async () => {
    const stored = await kv.get([
      MONITORING_EVENT_OUTBOX_KEY,
      MONITORING_EVENT_DROPPED_KEY,
      MONITORING_EVENT_AUTH_BINDING_KEY,
    ]);
    const storedEntries = Array.isArray(stored[MONITORING_EVENT_OUTBOX_KEY])
      ? stored[MONITORING_EVENT_OUTBOX_KEY]
      : [];
    const bindingMatches = stored[MONITORING_EVENT_AUTH_BINDING_KEY] === authBinding;
    const discardedForIdentityChange = storedEntries.length > 0 && !bindingMatches
      ? storedEntries.length
      : 0;
    const bounded = RuntimeCore.boundEventOutbox(bindingMatches ? storedEntries : [], event);
    await kv.set({
      [MONITORING_EVENT_OUTBOX_KEY]: bounded.entries,
      [MONITORING_EVENT_DROPPED_KEY]: Number(stored[MONITORING_EVENT_DROPPED_KEY] || 0)
        + discardedForIdentityChange
        + bounded.dropped,
      [MONITORING_EVENT_AUTH_BINDING_KEY]: authBinding,
    });
    scheduleMonitoringEventFlush();
    return true;
  }).catch((error) => {
    console.warn('[Monitoring Events] Failed to queue event:', error?.message || error);
    return false;
  });
  return monitoringEventMutation;
}

async function removeMonitoringEventBatch(sourceEventIds) {
  const acknowledged = new Set(sourceEventIds);
  monitoringEventMutation = monitoringEventMutation.then(async () => {
    const stored = await kv.get([MONITORING_EVENT_OUTBOX_KEY]);
    const remaining = (stored[MONITORING_EVENT_OUTBOX_KEY] || [])
      .filter((event) => !acknowledged.has(event?.sourceEventId));
    await kv.set({ [MONITORING_EVENT_OUTBOX_KEY]: remaining });
    if (remaining.length === 0) await kv.remove(MONITORING_EVENT_AUTH_BINDING_KEY);
    return remaining.length;
  });
  return monitoringEventMutation;
}

async function discardMonitoringEventOutbox() {
  monitoringEventMutation = monitoringEventMutation.then(async () => {
    const stored = await kv.get([MONITORING_EVENT_OUTBOX_KEY, MONITORING_EVENT_DROPPED_KEY]);
    const discarded = Array.isArray(stored[MONITORING_EVENT_OUTBOX_KEY])
      ? stored[MONITORING_EVENT_OUTBOX_KEY].length
      : 0;
    await kv.set({
      [MONITORING_EVENT_OUTBOX_KEY]: [],
      [MONITORING_EVENT_DROPPED_KEY]: Number(stored[MONITORING_EVENT_DROPPED_KEY] || 0) + discarded,
    });
    await kv.remove(MONITORING_EVENT_AUTH_BINDING_KEY);
    return discarded;
  });
  return monitoringEventMutation;
}

async function flushMonitoringEventOutbox() {
  if (monitoringEventFlushInFlight || !hasStudentAuth()) return;
  monitoringEventFlushInFlight = true;
  try {
    await monitoringEventMutation;
    const stored = await kv.get([MONITORING_EVENT_OUTBOX_KEY, MONITORING_EVENT_AUTH_BINDING_KEY]);
    const batch = (stored[MONITORING_EVENT_OUTBOX_KEY] || []).slice(0, 50);
    if (batch.length === 0) {
      chrome.alarms.clear(MONITORING_EVENT_FLUSH_ALARM);
      return;
    }
    const currentBinding = monitoringEventAuthBinding();
    if (!currentBinding || stored[MONITORING_EVENT_AUTH_BINDING_KEY] !== currentBinding) {
      await discardMonitoringEventOutbox();
      chrome.alarms.clear(MONITORING_EVENT_FLUSH_ALARM);
      return;
    }

    const payload = { events: batch };
    const headers = buildDeviceAuthHeaders();
    attachLegacyStudentToken(payload, headers);
    const response = await fetchWithBackoff(`${CONFIG.serverUrl}/api/classpilot/device/events`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    }, {
      context: 'device event',
      maxAttempts: 1,
      retryStatuses: new Set([429, 503]),
    });

    if (response.status === 429 || response.status === 503) {
      scheduleMonitoringEventFlush();
      return;
    }
    if (response.status === 402) {
      const data = await response.json().catch(() => ({}));
      await disableForInactiveLicense(data.planStatus);
    }

    // A successful batch acknowledges each source event independently. Keep
    // any event omitted from the response queued: ingestion is idempotent, so
    // retrying it is safer than silently losing telemetry after a partial or
    // malformed response. Other non-retryable responses are discarded so one
    // rejected batch cannot permanently block later telemetry.
    let acknowledgedIds = batch.map((event) => event.sourceEventId);
    if (response.ok) {
      const data = await response.json().catch(() => null);
      acknowledgedIds = RuntimeCore.acknowledgedMonitoringEventIds(batch, data);
      if (acknowledgedIds.length === 0) {
        scheduleMonitoringEventFlush();
        return;
      }
    }
    const remaining = await removeMonitoringEventBatch(acknowledgedIds);
    if (remaining > 0) scheduleMonitoringEventFlush();
  } catch (error) {
    console.warn('[Monitoring Events] Flush deferred:', error?.message || error);
    scheduleMonitoringEventFlush();
  } finally {
    monitoringEventFlushInFlight = false;
  }
}

function queueNavigationEvent(eventType, url, title, metadata = {}) {
  if (!licenseActive || trackingState === TRACKING_STATES.OFF || !hasStudentAuth() || !isHttpUrl(url)) {
    return;
  }
  const normalizedType = eventType === 'tab_change' ? 'tab_changed' : 'navigation_changed';
  const key = `${normalizedType}:${metadata.tabId ?? 'unknown'}`;
  pendingNavigationEvents.set(key, { eventType: normalizedType, url, title });

  if (navigationDebounceTimers.has(key)) clearTimeout(navigationDebounceTimers.get(key));
  navigationDebounceTimers.set(key, setTimeout(() => {
    const event = pendingNavigationEvents.get(key);
    pendingNavigationEvents.delete(key);
    navigationDebounceTimers.delete(key);
    if (!event || trackingState === TRACKING_STATES.OFF) return;
    enqueueMonitoringEvent(event.eventType, { url: event.url, title: event.title }).catch(() => {});
  }, NAVIGATION_DEBOUNCE_MS));
}

function buildDeviceAuthHeaders() {
  const headers = { 'Content-Type': 'application/json' };
  if (CONFIG.studentToken) {
    headers.Authorization = `Bearer ${CONFIG.studentToken}`;
  }
  return headers;
}

function attachLegacyStudentToken(payload, headers) {
  if (CONFIG.studentToken && !headers.Authorization) {
    payload.studentToken = CONFIG.studentToken;
  }
}

function isManualIdentitySource(source = CONFIG.identitySource) {
  return source === 'manual_email_id' || source === 'manual_pin';
}

function isManualLoginTimestampFresh(value, now = Date.now()) {
  const lastSeen = Number(value);
  const age = Number(now) - lastSeen;
  return Number.isFinite(lastSeen)
    && lastSeen > 0
    && Number.isFinite(age)
    && age >= -MANUAL_LOGIN_FUTURE_SKEW_MS
    && age <= MANUAL_LOGIN_STALE_MS;
}

function hasStudentAuth() {
  return Boolean(
    !studentAuthInvalidating
    && !studentAuthCommitPending
    && (!isManualIdentitySource() || isManualLoginTimestampFresh(CONFIG.manualLoginLastSeenAt))
    && [
      CONFIG.deviceId,
      CONFIG.studentToken,
      CONFIG.activeStudentId,
      CONFIG.activeStudentSessionId,
    ].every((value) => typeof value === 'string' && value.trim().length > 0)
  );
}

function disableToolbarAction() {
  try {
    if (!chrome.action?.disable) return;
    const maybePromise = chrome.action.disable();
    if (maybePromise?.catch) maybePromise.catch(() => {});
  } catch {
    // Toolbar action disablement is best-effort; the in-page FAB remains active.
  }
}

function hasManagedSchoolSetup() {
  return Boolean(
    !managedAuthGateSetupUnavailable
    && (CONFIG.schoolId || CONFIG.schoolSlug)
    && CONFIG.enrollmentKey
    && isHttpUrl(CONFIG.serverUrl)
  );
}

function canUseStudentLoginAuthority() {
  if (!isHttpUrl(CONFIG.serverUrl)) return false;
  if (!managedAuthGateSetupUnavailable) return true;
  return isExplicitUnmanagedDevelopmentRuntime()
    || isExplicitUnmanagedDevelopmentServer(CONFIG.serverUrl);
}

function authGateConfigBinding() {
  let serverOrigin = null;
  try {
    serverOrigin = new URL(CONFIG.serverUrl || DEFAULT_SERVER_URL).origin;
  } catch {
    serverOrigin = null;
  }
  return {
    serverOrigin,
    schoolId: String(CONFIG.schoolId || '').trim() || null,
    schoolSlug: String(CONFIG.schoolSlug || '').trim() || null,
  };
}

function authGateConfigBindingKey(binding = authGateConfigBinding()) {
  return JSON.stringify([
    binding.serverOrigin || '',
    binding.schoolId || '',
    binding.schoolSlug || '',
  ]);
}

function captureAuthGatePolicyGuard() {
  return {
    managedPolicyGeneration: managedAuthGatePolicyGeneration,
    configGeneration: sharedSignInConfigGeneration,
    bindingKey: authGateConfigBindingKey(),
  };
}

function assertAuthGatePolicyGuardCurrent(guard, reason) {
  if (
    !guard
    || guard.managedPolicyGeneration !== managedAuthGatePolicyGeneration
    || guard.configGeneration !== sharedSignInConfigGeneration
    || guard.bindingKey !== authGateConfigBindingKey()
  ) {
    throw authMutationSuperseded(reason);
  }
}

async function awaitManagedAuthGatePolicyStable() {
  while (true) {
    const generation = managedAuthGatePolicyGeneration;
    const pending = managedAuthGatePolicyRestorePromise;
    try {
      await pending;
    } catch (error) {
      if (
        generation !== managedAuthGatePolicyGeneration
        || pending !== managedAuthGatePolicyRestorePromise
      ) {
        continue;
      }
      throw error;
    }
    if (
      generation === managedAuthGatePolicyGeneration
      && pending === managedAuthGatePolicyRestorePromise
    ) {
      return;
    }
  }
}

function assertManagedPolicyRevalidationCurrent(policyGeneration, policyBarrier, reason) {
  if (
    policyGeneration !== managedAuthGatePolicyGeneration
    || managedAuthGatePolicyRestorePromise !== policyBarrier
  ) {
    throw authMutationSuperseded(reason);
  }
}

function hasStoredStudentAuthMaterial(stored = {}) {
  return Boolean(
    stored[STUDENT_AUTH_INVALIDATING_KEY] === true
    || stored[STUDENT_AUTH_COMMIT_PENDING_KEY] === true
    || [
      stored.studentToken,
      stored.activeStudentId,
      stored.activeStudentSessionId,
      CONFIG.studentToken,
      CONFIG.activeStudentId,
      CONFIG.activeStudentSessionId,
    ].some((value) => typeof value === 'string' && value.trim().length > 0)
  );
}

async function runManagedAuthGatePolicyRevalidation() {
  // One shared direct-revalidation cycle owns a new policy generation. Any
  // older storage-change reread or login adoption is superseded before this
  // fresh managed snapshot is requested.
  const policyGeneration = ++managedAuthGatePolicyGeneration;
  let resolvePolicyRestore;
  let rejectPolicyRestore;
  const policyBarrier = new Promise((resolve, reject) => {
    resolvePolicyRestore = resolve;
    rejectPolicyRestore = reject;
  });
  managedAuthGatePolicyRestorePromise = policyBarrier;
  policyBarrier.catch(() => {});

  const run = (async () => {
    const priorBindingKey = authGateConfigBindingKey();
    const priorEnrollmentKey = normalizeManagedString(CONFIG.enrollmentKey);
    const [managedConfig, stored] = await Promise.all([
      readManagedConfig({ failClosed: true }),
      getStoredAuthState([
        'config',
        'deviceId',
        'studentToken',
        'activeStudentId',
        'activeStudentSessionId',
        'identitySource',
        'manualLoginLastSeenAt',
        STUDENT_AUTH_INVALIDATING_KEY,
        STUDENT_AUTH_COMMIT_PENDING_KEY,
        MANAGED_AUTH_GATE_BINDING_KEY,
      ]),
    ]);
    assertManagedPolicyRevalidationCurrent(
      policyGeneration,
      policyBarrier,
      'managed policy direct reread',
    );

    const storedAuthConflicts = managedPolicyConflictsWithStoredAuth(
      stored,
      managedConfig,
      CONFIG.serverUrl || DEFAULT_SERVER_URL,
      { allowUnmanagedFallback: false },
    );
    const descriptor = managedAuthGatePolicyDescriptor(managedConfig);
    const nextBindingKey = authGateConfigBindingKey({
      serverOrigin: descriptor.serverManaged && descriptor.serverValid
        ? descriptor.serverOrigin
        : normalizedServerOrigin(DEFAULT_SERVER_URL),
      schoolId: descriptor.schoolId,
      schoolSlug: descriptor.schoolSlug,
    });
    const authorityChanged = priorBindingKey !== nextBindingKey
      || priorEnrollmentKey !== descriptor.enrollmentKey;
    const manualTimestampInvalid = isManualIdentitySource(
      stored.identitySource || CONFIG.identitySource,
    ) && !isManualLoginTimestampFresh(
      stored.manualLoginLastSeenAt ?? CONFIG.manualLoginLastSeenAt,
    );
    const mustClearAuth = storedAuthConflicts
      || authorityChanged
      || !descriptor.hasManagedSetup
      || manualTimestampInvalid
      || studentAuthInvalidating
      || studentAuthCommitPending;

    if (mustClearAuth && (hasStoredStudentAuthMaterial(stored)
      || studentAuthInvalidating || studentAuthCommitPending)) {
      // Drain an older auth mutation before reserving this cleanup marker. An
      // older queued clear removes its own marker last and must never erase the
      // marker protecting this newer policy transition.
      await studentAuthMutationTail;
      assertManagedPolicyRevalidationCurrent(
        policyGeneration,
        policyBarrier,
        'managed policy direct auth cleanup reservation',
      );

      // clearStudentAuth synchronously raises the in-memory fence and starts
      // the strict durable invalidation write before its queued cleanup. Await
      // the whole local clear before applyAuthoritative... is allowed to write
      // the new binding/config, closing the crash window between those steps.
      await clearStudentAuth('managed_policy_direct_revalidation', {
        notifyBackend: false,
        localOnly: true,
        notifyAuthGateTabs: false,
        pauseAutoRegistration: true,
        disconnectWebSocket: true,
      });
      assertManagedPolicyRevalidationCurrent(
        policyGeneration,
        policyBarrier,
        'managed policy direct auth cleanup',
      );
    }

    const appliedPolicy = applyAuthoritativeManagedAuthGateSnapshot(
      managedConfig,
      stored[MANAGED_AUTH_GATE_BINDING_KEY],
      false,
      { persist: false },
    );
    assertManagedPolicyRevalidationCurrent(
      policyGeneration,
      policyBarrier,
      'managed policy direct apply',
    );

    if (authorityChanged) {
      resetSharedSignInLoginConfigCache({ clearPersisted: true });
    }

    // The acknowledgement is not valid until the exact effective authority
    // and binding descriptor are durably recorded. This is a local-only read
    // and write; managed revalidation never contacts the SchoolPilot API.
    await durableLocalKv.set({
      config: persistedNonAuthConfig(CONFIG),
      [MANAGED_AUTH_GATE_BINDING_KEY]: appliedPolicy.persistedDescriptor,
    });
    assertManagedPolicyRevalidationCurrent(
      policyGeneration,
      policyBarrier,
      'managed policy direct persistence',
    );

    // Always advance the state revision for the direct proof. Clients may
    // receive a delayed pre-change push with the prior (or equal locally held)
    // revision, but only this correlated response can acknowledge the fence.
    bumpAuthGateStateRevision();
    const state = await getPublishableAuthGateState();
    assertManagedPolicyRevalidationCurrent(
      policyGeneration,
      policyBarrier,
      'managed policy direct publication',
    );
    return {
      state,
      managedPolicyGeneration: policyGeneration,
    };
  })().catch(async (error) => {
    if (
      policyGeneration === managedAuthGatePolicyGeneration
      && managedAuthGatePolicyRestorePromise === policyBarrier
    ) {
      // A failed local read/write cannot prove the policy snapshot. Keep every
      // client fenced and fail closed without attaching an acknowledgement.
      managedAuthGateSetupUnavailable = true;
      CONFIG.serverUrl = DEFAULT_SERVER_URL;
      CONFIG.schoolId = null;
      CONFIG.schoolSlug = null;
      CONFIG.enrollmentKey = null;
      resetSharedSignInLoginConfigCache({ clearPersisted: true });
      updateSharedSignInLoginConfig({
        phase: 'setup_required',
        fetchedAt: 0,
        retryAt: null,
        setupRequired: true,
        sharedSignInEnabled: false,
        pinLoginEnabled: false,
        schoolId: null,
        passpilotKioskAvailable: false,
        bindingKey: authGateConfigBindingKey(),
      });
      if (hasStoredStudentAuthMaterial() || studentAuthInvalidating || studentAuthCommitPending) {
        await clearStudentAuth('managed_policy_direct_revalidation_failed', {
          notifyBackend: false,
          localOnly: true,
          notifyAuthGateTabs: false,
          pauseAutoRegistration: true,
          disconnectWebSocket: true,
        }).catch(() => {});
      }
      bumpAuthGateStateRevision();
      await awaitAuthGateRevisionPublicationReady().catch(() => {});
    }
    throw error;
  });

  run.then(resolvePolicyRestore, rejectPolicyRestore);
  return run;
}

async function revalidateManagedAuthGatePolicy(managedPolicyFence) {
  if (!Number.isSafeInteger(managedPolicyFence) || managedPolicyFence <= 0) {
    const error = new Error('Managed policy fence must be a positive safe integer');
    error.code = 'AUTH_GATE_INVALID_POLICY_FENCE';
    throw error;
  }

  await authStateRestorePromise;

  if (!managedAuthGateDirectRevalidationInFlight) {
    const run = runManagedAuthGatePolicyRevalidation();
    const trackedRun = run.finally(() => {
      if (managedAuthGateDirectRevalidationInFlight === trackedRun) {
        managedAuthGateDirectRevalidationInFlight = null;
      }
    });
    managedAuthGateDirectRevalidationInFlight = trackedRun;
    trackedRun.catch(() => {});
  }

  const result = await managedAuthGateDirectRevalidationInFlight;
  return {
    ...result,
    // The expensive authoritative cycle is shared, but each direct caller
    // receives only its own correlation fence. Broadcasts remain marker-free.
    managedPolicyFence,
  };
}

function restoreSharedSignInPresentationCache(rawCache) {
  if (!fastAuthGateEnabled || !rawCache || typeof rawCache !== 'object') return false;
  const ageMs = Date.now() - Number(rawCache.cachedAt || 0);
  const currentBinding = authGateConfigBinding();
  const cacheBinding = rawCache.binding || {};
  if (
    rawCache.schemaVersion !== 1
    || !Number.isFinite(ageMs)
    || ageMs < 0
    || ageMs > SHARED_SIGN_IN_CONFIG_CACHE_MAX_AGE_MS
    || authGateConfigBindingKey(cacheBinding) !== authGateConfigBindingKey(currentBinding)
  ) {
    kv.remove(SHARED_SIGN_IN_CONFIG_CACHE_KEY).catch(() => {});
    return false;
  }

  // Local cache is presentation-only. A worker restart always begins in the
  // loading phase and requires a live response before sign-in can be enabled.
  sharedSignInLoginConfig = {
    ...sharedSignInLoginConfig,
    phase: 'loading',
    fetchedAt: Number(rawCache.configFetchedAt || 0),
    retryAt: null,
    setupRequired: false,
    sharedSignInEnabled: rawCache.sharedSignInEnabled === true,
    loginMethod: rawCache.loginMethod === 'email_id' ? 'email_id' : 'name_pin',
    pinLoginEnabled: rawCache.loginMethod !== 'email_id',
    schoolId: typeof rawCache.schoolId === 'string' ? rawCache.schoolId : null,
    passpilotKioskAvailable: rawCache.passpilotKioskAvailable === true,
    bindingKey: authGateConfigBindingKey(currentBinding),
  };
  bumpAuthGateStateRevision();
  return true;
}

async function persistSharedSignInPresentationCache(config) {
  const binding = authGateConfigBinding();
  await kv.set({
    [SHARED_SIGN_IN_CONFIG_CACHE_KEY]: {
      schemaVersion: 1,
      cachedAt: Date.now(),
      configFetchedAt: Number(config.fetchedAt || Date.now()),
      binding,
      sharedSignInEnabled: config.sharedSignInEnabled === true,
      loginMethod: config.loginMethod === 'email_id' ? 'email_id' : 'name_pin',
      schoolId: typeof config.schoolId === 'string' ? config.schoolId : null,
      passpilotKioskAvailable: config.passpilotKioskAvailable === true,
    },
  });
}

function updateSharedSignInLoginConfig(nextState) {
  sharedSignInLoginConfig = { ...sharedSignInLoginConfig, ...nextState };
  bumpAuthGateStateRevision();
  return sharedSignInLoginConfig;
}

function sanitizedAuthGateTimingLabel(value, fallback) {
  const normalized = String(value || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 40);
  return normalized || fallback;
}

function recordAuthGateTiming({ outcome, startedAt, coldWorker = false }) {
  const completedAt = Date.now();
  kv.get([AUTH_GATE_TIMING_STORAGE_KEY]).then((stored) => {
    const prior = stored[AUTH_GATE_TIMING_STORAGE_KEY] || {};
    const loadingPaintMs = Number(prior.loadingPaintMs);
    const priorTimestamp = Number(prior.timestamp);
    const navigationStartedAt = Number.isFinite(loadingPaintMs) && Number.isFinite(priorTimestamp)
      ? priorTimestamp - loadingPaintMs
      : Number(startedAt || completedAt);
    const record = {
      loadingPaintMs: Number.isFinite(loadingPaintMs)
        ? Math.max(0, Math.round(loadingPaintMs))
        : null,
      configReadyMs: Math.max(0, completedAt - navigationStartedAt),
      outcome: sanitizedAuthGateTimingLabel(outcome, 'unknown'),
      coldWorker: prior.coldWorker === true || coldWorker === true,
      timestamp: completedAt,
    };
    console.info('[AuthGatePerf]', record);
    return kv.set({ [AUTH_GATE_TIMING_STORAGE_KEY]: record });
  }).catch(() => {});
}

async function fetchAuthGateRequest(url, init = {}) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), AUTH_GATE_REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    let data = {};
    let jsonValid = true;
    try {
      data = await response.json();
      if (!data || typeof data !== 'object' || Array.isArray(data)) {
        data = {};
        jsonValid = false;
      }
    } catch (error) {
      if (controller.signal.aborted) throw error;
      jsonValid = false;
    }
    return { response, data, jsonValid };
  } catch (error) {
    if (controller.signal.aborted) {
      const timeoutError = new Error('ClassPilot request timed out');
      timeoutError.code = 'AUTH_GATE_TIMEOUT';
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

function assertAuthMutationBindingCurrent(generation, binding, reason) {
  assertAuthMutationCurrent(generation, reason);
  if (
    CONFIG.activeStudentId !== binding.studentId
    || CONFIG.activeStudentSessionId !== binding.studentSessionId
    || CONFIG.deviceId !== binding.deviceId
    || CONFIG.studentToken !== binding.studentToken
  ) {
    throw authMutationSuperseded(reason);
  }
}

function isUnavailableAuthGateResponse(response) {
  return response?.status === 408 || response?.status === 429 || response?.status >= 500;
}

function isValidSharedSignInConfigPayload(data) {
  return Boolean(
    data
    && typeof data === 'object'
    && !Array.isArray(data)
    && typeof data.sharedSignInEnabled === 'boolean'
  );
}

function isValidLoginRosterPayload(data) {
  return Boolean(
    data
    && typeof data === 'object'
    && !Array.isArray(data)
    && Array.isArray(data.students)
    && Array.isArray(data.grades)
  );
}

function clearSharedSignInConfigRetry() {
  sharedSignInConfigRetryAttempt = 0;
  chrome.alarms.clear(SHARED_SIGN_IN_CONFIG_RETRY_ALARM);
}

function scheduleSharedSignInConfigRetry() {
  const delayIndex = Math.min(
    sharedSignInConfigRetryAttempt,
    SHARED_SIGN_IN_CONFIG_RETRY_DELAYS_MS.length - 1,
  );
  const delayMs = SHARED_SIGN_IN_CONFIG_RETRY_DELAYS_MS[delayIndex];
  sharedSignInConfigRetryAttempt += 1;
  const retryAt = Date.now() + delayMs;
  chrome.alarms.create(SHARED_SIGN_IN_CONFIG_RETRY_ALARM, { when: retryAt });
  return retryAt;
}

async function refreshSharedSignInLoginConfigFast(options = {}) {
  const force = options.force === true;
  if (options.managedConfigAlreadyApplied !== true) {
    applyManagedAuthGatePolicySnapshot(await readManagedConfig());
  }
  if (!fastAuthGateEnabled) {
    return refreshSharedSignInLoginConfigLegacy({
      ...options,
      managedConfigAlreadyApplied: true,
    });
  }
  if (hasStudentAuth()) {
    clearSharedSignInConfigRetry();
    return sharedSignInLoginConfig;
  }

  const now = Date.now();
  const bindingKey = authGateConfigBindingKey();
  const coldWorker = options.coldWorker === true;
  const canUseCurrentConfig = !force
    && sharedSignInLoginConfig.bindingKey === bindingKey
    && (sharedSignInLoginConfig.phase === 'ready' || sharedSignInLoginConfig.phase === 'setup_required')
    && sharedSignInLoginConfig.fetchedAt
    && now - sharedSignInLoginConfig.fetchedAt < SHARED_SIGN_IN_CONFIG_FETCH_INTERVAL_MS;
  if (canUseCurrentConfig) {
    authGateStateColdWorker = coldWorker;
    return sharedSignInLoginConfig;
  }
  if (
    !force
    && sharedSignInLoginConfig.phase === 'unavailable'
    && Number(sharedSignInLoginConfig.retryAt || 0) > now
  ) {
    authGateStateColdWorker = coldWorker;
    return sharedSignInLoginConfig;
  }
  if (sharedSignInConfigPromise) return sharedSignInConfigPromise;

  const requestGeneration = sharedSignInConfigGeneration;
  const requestAuthMutationGeneration = studentAuthMutationGeneration;
  const startedAt = Date.now();
  authGateStateColdWorker = coldWorker;
  if (!hasManagedSchoolSetup()) {
    clearSharedSignInConfigRetry();
    const state = updateSharedSignInLoginConfig({
      phase: 'setup_required',
      fetchedAt: 0,
      retryAt: null,
      setupRequired: true,
      sharedSignInEnabled: false,
      pinLoginEnabled: false,
      schoolId: null,
      passpilotKioskAvailable: false,
      bindingKey,
    });
    recordAuthGateTiming({ outcome: 'setup_required_local', startedAt, coldWorker });
    await notifyAuthGateStateToTabs({ triggerRefresh: false });
    return state;
  }

  updateSharedSignInLoginConfig({
    phase: 'loading',
    retryAt: null,
    setupRequired: false,
    bindingKey,
  });

  const params = new URLSearchParams();
  if (CONFIG.schoolId) params.set('schoolId', CONFIG.schoolId);
  if (CONFIG.schoolSlug) params.set('schoolSlug', CONFIG.schoolSlug);

  const run = (async () => {
    try {
      const { response, data, jsonValid } = await fetchAuthGateRequest(
        `${CONFIG.serverUrl}/api/extension/login-config?${params.toString()}`,
        {
          cache: 'no-store',
          headers: { 'X-ClassPilot-Enrollment-Key': CONFIG.enrollmentKey },
        },
      );
      if (
        requestGeneration !== sharedSignInConfigGeneration
        || requestAuthMutationGeneration !== studentAuthMutationGeneration
        || hasStudentAuth()
        || bindingKey !== authGateConfigBindingKey()
      ) {
        return sharedSignInLoginConfig;
      }

      if (response.ok && (!jsonValid || !isValidSharedSignInConfigPayload(data))) {
        const retryAt = scheduleSharedSignInConfigRetry();
        updateSharedSignInLoginConfig({
          phase: 'unavailable',
          retryAt,
          setupRequired: false,
          sharedSignInEnabled: false,
          pinLoginEnabled: false,
          bindingKey,
        });
        recordAuthGateTiming({ outcome: 'unavailable_invalid_config', startedAt, coldWorker });
      } else if (response.ok) {
        clearSharedSignInConfigRetry();
        const sharedSignInEnabled = data.sharedSignInEnabled;
        const state = updateSharedSignInLoginConfig({
          phase: sharedSignInEnabled ? 'ready' : 'setup_required',
          fetchedAt: Date.now(),
          retryAt: null,
          setupRequired: !sharedSignInEnabled,
          sharedSignInEnabled,
          loginMethod: data.loginMethod === 'email_id' ? 'email_id' : 'name_pin',
          pinLoginEnabled: sharedSignInEnabled && data.loginMethod !== 'email_id',
          schoolId: typeof data.schoolId === 'string' ? data.schoolId : null,
          passpilotKioskAvailable: data.passpilotKioskAvailable === true,
          bindingKey,
        });
        await persistSharedSignInPresentationCache(state).catch(() => {});
        if (
          requestGeneration !== sharedSignInConfigGeneration
          || requestAuthMutationGeneration !== studentAuthMutationGeneration
          || hasStudentAuth()
          || bindingKey !== authGateConfigBindingKey()
        ) {
          await kv.remove(SHARED_SIGN_IN_CONFIG_CACHE_KEY).catch(() => {});
          return sharedSignInLoginConfig;
        }
        recordAuthGateTiming({
          outcome: sharedSignInEnabled ? 'ready' : 'setup_required_disabled',
          startedAt,
          coldWorker,
        });
      } else if (isUnavailableAuthGateResponse(response)) {
        const retryAt = scheduleSharedSignInConfigRetry();
        updateSharedSignInLoginConfig({
          phase: 'unavailable',
          retryAt,
          setupRequired: false,
          sharedSignInEnabled: false,
          pinLoginEnabled: false,
          bindingKey,
        });
        recordAuthGateTiming({ outcome: 'unavailable_http', startedAt, coldWorker });
      } else {
        clearSharedSignInConfigRetry();
        updateSharedSignInLoginConfig({
          phase: 'setup_required',
          fetchedAt: Date.now(),
          retryAt: null,
          setupRequired: true,
          sharedSignInEnabled: false,
          pinLoginEnabled: false,
          schoolId: null,
          passpilotKioskAvailable: false,
          bindingKey,
        });
        recordAuthGateTiming({ outcome: 'setup_required_server', startedAt, coldWorker });
      }
    } catch (error) {
      if (
        requestGeneration !== sharedSignInConfigGeneration
        || requestAuthMutationGeneration !== studentAuthMutationGeneration
        || hasStudentAuth()
        || bindingKey !== authGateConfigBindingKey()
      ) {
        return sharedSignInLoginConfig;
      }
      console.warn('[Auth Gate] Shared sign-in config unavailable:', error?.message || error);
      const retryAt = scheduleSharedSignInConfigRetry();
      updateSharedSignInLoginConfig({
        phase: 'unavailable',
        retryAt,
        setupRequired: false,
        sharedSignInEnabled: false,
        pinLoginEnabled: false,
        bindingKey,
      });
      recordAuthGateTiming({
        outcome: error?.code === 'AUTH_GATE_TIMEOUT' ? 'unavailable_timeout' : 'unavailable_network',
        startedAt,
        coldWorker,
      });
    }

    await notifyAuthGateStateToTabs({ triggerRefresh: false });
    return sharedSignInLoginConfig;
  })();

  const trackedRun = run.finally(() => {
    if (sharedSignInConfigPromise === trackedRun) sharedSignInConfigPromise = null;
  });
  sharedSignInConfigPromise = trackedRun;
  return trackedRun;
}

async function refreshSharedSignInLoginConfigLegacy(options = {}) {
  const force = options.force === true;
  if (options.managedConfigAlreadyApplied !== true) {
    applyManagedAuthGatePolicySnapshot(await readManagedConfig());
  }
  if (fastAuthGateEnabled) {
    return refreshSharedSignInLoginConfigFast({
      ...options,
      managedConfigAlreadyApplied: true,
    });
  }

  const now = Date.now();
  const hasSchoolSetup = hasManagedSchoolSetup();
  const canUseCachedConfig = !force &&
    hasSchoolSetup &&
    sharedSignInLoginConfig.setupRequired !== true &&
    sharedSignInLoginConfig.fetchedAt &&
    now - sharedSignInLoginConfig.fetchedAt < SHARED_SIGN_IN_CONFIG_FETCH_INTERVAL_MS;
  if (canUseCachedConfig) {
    return sharedSignInLoginConfig;
  }
  if (sharedSignInConfigPromise) {
    return sharedSignInConfigPromise;
  }

  const requestGeneration = sharedSignInConfigGeneration;
  const requestAuthMutationGeneration = studentAuthMutationGeneration;
  const requestBindingKey = authGateConfigBindingKey();
  const requestIsStale = () => (
    requestGeneration !== sharedSignInConfigGeneration
    || requestAuthMutationGeneration !== studentAuthMutationGeneration
    || requestBindingKey !== authGateConfigBindingKey()
    || fastAuthGateEnabled
    || hasStudentAuth()
  );
  const run = (async () => {
    if (!hasManagedSchoolSetup()) {
      if (requestIsStale()) return sharedSignInLoginConfig;
      sharedSignInLoginConfig = {
        fetchedAt: Date.now(),
        setupRequired: true,
        sharedSignInEnabled: false,
        loginMethod: 'name_pin',
        pinLoginEnabled: false,
        schoolId: null,
        passpilotKioskAvailable: false,
      };
      return sharedSignInLoginConfig;
    }

    const params = new URLSearchParams();
    if (CONFIG.schoolId) params.set('schoolId', CONFIG.schoolId);
    if (CONFIG.schoolSlug) params.set('schoolSlug', CONFIG.schoolSlug);

    try {
      const response = await fetchWithBackoff(`${CONFIG.serverUrl}/api/extension/login-config?${params.toString()}`, {
        cache: 'no-store',
        headers: {
          'X-ClassPilot-Enrollment-Key': CONFIG.enrollmentKey,
        },
      }, {
        context: 'login config',
        maxAttempts: 2,
      });
      const data = await response.json().catch(() => ({}));
      if (requestIsStale()) return sharedSignInLoginConfig;
      sharedSignInLoginConfig = {
        fetchedAt: Date.now(),
        setupRequired: !response.ok,
        sharedSignInEnabled: response.ok && data.sharedSignInEnabled === true,
        loginMethod: response.ok && data.loginMethod === 'email_id' ? 'email_id' : 'name_pin',
        pinLoginEnabled: response.ok && data.loginMethod !== 'email_id',
        // PassPilot kiosk launch: the auth gate offers a kiosk button when the
        // server says the school's kiosk is usable. Kept in this cache (not
        // CONFIG.schoolId, which is auth-scoped and persisted).
        schoolId: response.ok && typeof data.schoolId === 'string' ? data.schoolId : null,
        passpilotKioskAvailable: response.ok && data.passpilotKioskAvailable === true,
      };
      return sharedSignInLoginConfig;
    } catch (error) {
      if (requestIsStale()) return sharedSignInLoginConfig;
      console.warn('[Auth Gate] Shared sign-in config check failed:', error?.message || error);
      sharedSignInLoginConfig = {
        fetchedAt: Date.now(),
        setupRequired: true,
        sharedSignInEnabled: false,
        loginMethod: 'name_pin',
        pinLoginEnabled: false,
        schoolId: null,
        passpilotKioskAvailable: false,
      };
      return sharedSignInLoginConfig;
    }
  });
  const trackedRun = run().finally(() => {
    if (sharedSignInConfigPromise === trackedRun) sharedSignInConfigPromise = null;
  });
  sharedSignInConfigPromise = trackedRun;
  return trackedRun;
}

function refreshSharedSignInLoginConfig(options = {}) {
  return fastAuthGateEnabled
    ? refreshSharedSignInLoginConfigFast(options)
    : refreshSharedSignInLoginConfigLegacy(options);
}

function getAuthGateState() {
  const hasSchoolSetup = hasManagedSchoolSetup();
  const authRequired = !hasStudentAuth();
  if (lastAuthGateAuthRequired !== authRequired) {
    lastAuthGateAuthRequired = authRequired;
    bumpAuthGateStateRevision();
  }
  const phase = authRequired
    ? (fastAuthGateEnabled
      ? sharedSignInLoginConfig.phase
      : (!hasSchoolSetup || sharedSignInLoginConfig.setupRequired === true
        ? 'setup_required'
        : sharedSignInLoginConfig.fetchedAt ? 'ready' : 'loading'))
    : 'authenticated';
  return {
    authRequired,
    setupRequired: !hasSchoolSetup || sharedSignInLoginConfig.setupRequired === true,
    studentName: authRequired ? null : (CONFIG.studentName || null),
    studentEmail: authRequired ? null : (CONFIG.studentEmail || null),
    sharedSignInEnabled: sharedSignInLoginConfig.sharedSignInEnabled === true,
    loginMethod: sharedSignInLoginConfig.loginMethod === 'email_id' ? 'email_id' : 'name_pin',
    pinLoginEnabled: fastAuthGateEnabled
      ? sharedSignInLoginConfig.pinLoginEnabled === true
      : sharedSignInLoginConfig.loginMethod === 'name_pin',
    hasManagedSchoolSetup: hasSchoolSetup,
    manualExpiresInSeconds: Math.floor(MANUAL_LOGIN_STALE_MS / 1000),
    fastAuthGateEnabled,
    coldWorker: fastAuthGateEnabled && authGateStateColdWorker,
    phase,
    revision: authGateStateRevision,
    configFetchedAt: sharedSignInLoginConfig.fetchedAt || null,
    retryAt: sharedSignInLoginConfig.retryAt || null,
    // kioskUrl is null unless the school's PassPilot kiosk is usable;
    // kioskOrigin is always present so the content script can skip painting
    // the gate on kiosk pages even when the button is hidden.
    kioskUrl: kioskLaunchUrl(),
    kioskOrigin: kioskGateOrigin(),
  };
}

async function getPublishableAuthGateState() {
  await awaitAuthGateRevisionPublicationReady();
  while (true) {
    const state = getAuthGateState();
    await awaitAuthGateRevisionPublicationReady();
    if (
      authGateStatePendingRevisionBumps === 0
      && state.revision === authGateStateRevision
    ) {
      return state;
    }
  }
}

async function ensureDeviceId() {
  if (CONFIG.deviceId) return CONFIG.deviceId;
  const stored = await durableLocalKv.get(['deviceId']);
  const deviceId = stored.deviceId || ('device-' + crypto.randomUUID().slice(0, 11));
  CONFIG.deviceId = deviceId;
  await durableLocalKv.set({ deviceId });
  return deviceId;
}

async function notifyAuthGateStateToTabs(options = {}) {
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.map((tab) => enforceAuthGateForTab(tab, options)));
  } catch (error) {
    console.warn('[Auth Gate] Failed to notify tabs:', error?.message || error);
  }
}

function handleManagedAuthGateStorageChange(changes = {}, areaName = 'managed') {
    if (areaName !== 'managed') return null;
    if (!Object.keys(changes).some((key) => MANAGED_CONFIG_KEYS.includes(key))) return null;

    const serverUrlChanged = ['serverUrl', 'classpilotServerUrl'].some((key) => (
      Object.prototype.hasOwnProperty.call(changes, key)
    ));
    const schoolIdChanged = ['schoolId', 'classpilotSchoolId'].some((key) => (
      Object.prototype.hasOwnProperty.call(changes, key)
    ));
    const schoolSlugChanged = ['schoolSlug', 'classpilotSchoolSlug'].some((key) => (
      Object.prototype.hasOwnProperty.call(changes, key)
    ));
    const enrollmentKeyChanged = ['enrollmentKey', 'classpilotEnrollmentKey'].some((key) => (
      Object.prototype.hasOwnProperty.call(changes, key)
    ));
    const schoolIdRemoved = ['schoolId', 'classpilotSchoolId'].some((key) => (
      Object.prototype.hasOwnProperty.call(changes, key) && changes[key].newValue == null
    ));
    const schoolSlugRemoved = ['schoolSlug', 'classpilotSchoolSlug'].some((key) => (
      Object.prototype.hasOwnProperty.call(changes, key) && changes[key].newValue == null
    ));
    const enrollmentKeyRemoved = ['enrollmentKey', 'classpilotEnrollmentKey'].some((key) => (
      Object.prototype.hasOwnProperty.call(changes, key) && changes[key].newValue == null
    ));
    const authAuthorityChanged = serverUrlChanged || schoolIdChanged
      || schoolSlugChanged || enrollmentKeyChanged;
    const policyGeneration = ++managedAuthGatePolicyGeneration;
    let resolvePolicyRestore;
    let rejectPolicyRestore;
    const policyBarrier = new Promise((resolve, reject) => {
      resolvePolicyRestore = resolve;
      rejectPolicyRestore = reject;
    });
    managedAuthGatePolicyRestorePromise = policyBarrier;
    policyBarrier.catch(() => {});

    let authorityAuthClearPromise = Promise.resolve();
    if (authAuthorityChanged) {
      managedAuthGateSetupUnavailable = true;
      // Raise the in-memory fence and begin the strict durable invalidation
      // write synchronously. The policy transition below awaits the complete
      // local clear before it may apply or persist the new authority.
      authorityAuthClearPromise = clearStudentAuth('managed_auth_authority_changed', {
        notifyBackend: false,
        localOnly: true,
        notifyAuthGateTabs: false,
        pauseAutoRegistration: true,
        disconnectWebSocket: true,
      });
      authorityAuthClearPromise.catch(() => {});
    }

    // A changed server value is untrusted until the complete managed snapshot
    // proves it is a valid URL. Never retain the previous managed endpoint
    // through a removal or a malformed replacement.
    if (serverUrlChanged) CONFIG.serverUrl = DEFAULT_SERVER_URL;
    if (schoolIdRemoved) CONFIG.schoolId = null;
    if (schoolSlugRemoved) CONFIG.schoolSlug = null;
    if (enrollmentKeyRemoved) CONFIG.enrollmentKey = null;

    const managedConfig = {};
    for (const [key, change] of Object.entries(changes)) {
      if (MANAGED_CONFIG_KEYS.includes(key)) {
        managedConfig[key] = change.newValue;
      }
    }

    if (authAuthorityChanged) {
      // Preserve an immediate kill-switch transition, but keep every new
      // authority field out of CONFIG until durable auth cleanup completes.
      if (Object.prototype.hasOwnProperty.call(managedConfig, 'fastAuthGateEnabled')) {
        fastAuthGateEnabled = extractManagedValue(managedConfig.fastAuthGateEnabled) !== false;
      }
    } else {
      applyManagedSchoolConfig(managedConfig);
    }
    resetSharedSignInLoginConfigCache({ clearPersisted: true });

    // Publish the transitional state immediately. In particular, a true→false
    // kill-switch change releases fast bootstrap without waiting for a managed
    // storage reread or the legacy network request.
    notifyAuthGateStateToTabs({
      triggerRefresh: false,
      skipManagedPolicyWait: true,
    }).catch(() => {});

    let transitionLegacyRefresh = null;
    if (!fastAuthGateEnabled && !hasStudentAuth() && !authAuthorityChanged) {
      transitionLegacyRefresh = refreshSharedSignInLoginConfigLegacy({
        force: true,
        managedConfigAlreadyApplied: true,
      });
    }

    // Reapply any surviving alias from the complete policy snapshot. Until
    // that local read completes the state remains loading/setup-required. The
    // pending promise is installed synchronously, so a login cannot adopt a
    // response under the partial or uncertain authority above.
    const storedPolicyAtChange = durableLocalKv.get([MANAGED_AUTH_GATE_BINDING_KEY, 'config']);
    const policyRestore = Promise.all([
      readManagedConfig({ failClosed: true }),
      storedPolicyAtChange,
      authorityAuthClearPromise,
    ]).then(async ([currentManagedConfig, persisted]) => {
      if (policyGeneration !== managedAuthGatePolicyGeneration) {
        throw authMutationSuperseded('managed policy reread');
      }
      const appliedPolicy = applyAuthoritativeManagedAuthGateSnapshot(
        currentManagedConfig,
        persisted[MANAGED_AUTH_GATE_BINDING_KEY],
        false,
        { persist: false },
      );
      if (policyGeneration !== managedAuthGatePolicyGeneration) {
        throw authMutationSuperseded('managed policy reread');
      }

      const policyPersistence = {
        [MANAGED_AUTH_GATE_BINDING_KEY]: appliedPolicy.persistedDescriptor,
      };
      if (authAuthorityChanged) {
        // The snapshot was read in parallel with cleanup and may predate auth
        // removal. Persist only the non-auth allowlist so no legacy token or
        // session field can be resurrected with the new authority.
        const config = persistedNonAuthConfig({
          ...(persisted.config || {}),
          serverUrl: CONFIG.serverUrl,
          schoolId: CONFIG.schoolId,
          schoolSlug: CONFIG.schoolSlug,
          enrollmentKey: CONFIG.enrollmentKey,
        });
        policyPersistence.config = config;
      }
      await durableLocalKv.set(policyPersistence);
      if (policyGeneration !== managedAuthGatePolicyGeneration) {
        throw authMutationSuperseded('managed policy persistence');
      }

      if (fastAuthGateEnabled && !hasStudentAuth()) {
        refreshSharedSignInLoginConfig({ reason: 'managed_policy_change' }).catch(() => {});
        await notifyAuthGateStateToTabs({
          triggerRefresh: false,
          skipManagedPolicyWait: true,
        });
        return currentManagedConfig;
      }
      if (!fastAuthGateEnabled && !hasStudentAuth()) {
        const legacyRefresh = transitionLegacyRefresh || refreshSharedSignInLoginConfigLegacy({
          force: true,
          managedConfigAlreadyApplied: true,
        });
        await legacyRefresh;
        await notifyAuthGateStateToTabs({
          triggerRefresh: false,
          skipManagedPolicyWait: true,
        });
        return currentManagedConfig;
      }
      await notifyAuthGateStateToTabs({
        triggerRefresh: false,
        skipManagedPolicyWait: true,
      });
      return currentManagedConfig;
    }).catch((error) => {
      if (policyGeneration === managedAuthGatePolicyGeneration) {
        managedAuthGateSetupUnavailable = true;
        CONFIG.serverUrl = DEFAULT_SERVER_URL;
        CONFIG.schoolId = null;
        CONFIG.schoolSlug = null;
        CONFIG.enrollmentKey = null;
        resetSharedSignInLoginConfigCache({ clearPersisted: true });
        updateSharedSignInLoginConfig({
          phase: 'setup_required',
          fetchedAt: 0,
          retryAt: null,
          setupRequired: true,
          sharedSignInEnabled: false,
          pinLoginEnabled: false,
          schoolId: null,
          passpilotKioskAvailable: false,
          bindingKey: authGateConfigBindingKey(),
        });
        if (!studentAuthInvalidating && (CONFIG.studentToken || studentAuthCommitPending)) {
          clearStudentAuth('managed_policy_reread_failed', {
            notifyBackend: false,
            localOnly: true,
            pauseAutoRegistration: true,
          }).catch(() => {});
        }
        notifyAuthGateStateToTabs({ triggerRefresh: false }).catch(() => {});
      }
      throw error;
    });
    policyRestore.then(resolvePolicyRestore, rejectPolicyRestore);
    return {
      policyGeneration,
      policyRestorePromise: policyBarrier,
    };
}

if (chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    handleManagedAuthGateStorageChange(changes, areaName);
  });
}

async function enforceAuthGateForTab(tabOrId, options = {}) {
  try {
    const tab = typeof tabOrId === 'number' ? await chrome.tabs.get(tabOrId) : tabOrId;
    if (!tab?.id || !isHttpUrl(tab.url || '')) {
      return;
    }
    // Never push (or force-inject) the auth gate onto a PassPilot kiosk page.
    // Prefix-only match, not availability-gated: a transient login-config
    // failure must not repaint the gate over a kiosk mid-hall-pass.
    if (isKioskGateUrl(tab.url || '')) {
      return;
    }
    // Auth restoration also durably reserves this worker's revision range.
    // Never publish an authenticated or invalidated state before that floor is
    // safe across a subsequent MV3 restart.
    await authStateRestorePromise;
    if (!hasStudentAuth() && options.skipManagedPolicyWait !== true) {
      await awaitManagedAuthGatePolicyStable().catch(() => {});
    }
    if (!hasStudentAuth()) {
      if (fastAuthGateEnabled) {
        if (options.triggerRefresh !== false) {
          refreshSharedSignInLoginConfig({ reason: options.reason || 'tab_enforcement' }).catch(() => {});
        }
      } else if (options.triggerRefresh !== false) {
        await refreshSharedSignInLoginConfig();
      }
    }

    const publishableState = await getPublishableAuthGateState();
    const message = publishableState.authRequired
      ? { type: 'CLASSPILOT_AUTH_REQUIRED', state: publishableState }
      : { type: 'CLASSPILOT_AUTH_COMPLETE', state: publishableState };

    try {
      await chrome.tabs.sendMessage(tab.id, message);
    } catch (error) {
      if (!hasStudentAuth() && chrome.scripting) {
        try {
          await chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['content.js'],
          });
          await chrome.tabs.sendMessage(tab.id, message);
        } catch {
          // Some pages reject extension scripts; the gate will apply on the next normal page.
        }
      }
    }
  } catch {
    // Tabs can disappear while we are enforcing the gate.
  }
}

function enqueueStudentAuthMutation(mutation) {
  const run = studentAuthMutationTail.then(mutation, mutation);
  studentAuthMutationTail = run.catch(() => undefined);
  return run;
}

function startAuthCommitRecoveryBarrier() {
  if (resolveAuthCommitRecovery || rejectAuthCommitRecovery) return authCommitRecoveryPromise;
  authCommitRecoveryPromise = new Promise((resolve, reject) => {
    resolveAuthCommitRecovery = resolve;
    rejectAuthCommitRecovery = reject;
  });
  authCommitRecoveryPromise.catch(() => {});
  return authCommitRecoveryPromise;
}

function completeAuthCommitRecoveryBarrier() {
  const resolve = resolveAuthCommitRecovery;
  resolveAuthCommitRecovery = null;
  rejectAuthCommitRecovery = null;
  if (resolve) resolve();
}

function failAuthCommitRecoveryBarrier(error) {
  const reject = rejectAuthCommitRecovery;
  resolveAuthCommitRecovery = null;
  rejectAuthCommitRecovery = null;
  if (reject) reject(error);
}

async function beginStudentAuthCommit(mutationGeneration, reason) {
  assertAuthMutationCurrent(mutationGeneration, reason, { allowInvalidating: true });
  // Raise the in-memory fence before persisting it. Credentials are written
  // only after the durable marker lands, so a worker crash in the following
  // enforcement window cannot expose a partially committed login on restart.
  studentAuthCommitPending = true;
  studentAuthCommitPendingGeneration = mutationGeneration;
  startAuthCommitRecoveryBarrier();
  await durableLocalKv.set({ [STUDENT_AUTH_COMMIT_PENDING_KEY]: true });
  assertAuthMutationCurrent(mutationGeneration, reason, { allowInvalidating: true });
  if (studentAuthCommitPendingGeneration !== mutationGeneration) {
    throw authMutationSuperseded(reason);
  }
}

async function completeStudentAuthCommit(mutationGeneration, reason) {
  assertAuthMutationCurrent(mutationGeneration, reason);
  if (studentAuthCommitPendingGeneration !== mutationGeneration) {
    throw authMutationSuperseded(reason);
  }
  await durableLocalKv.remove(STUDENT_AUTH_COMMIT_PENDING_KEY);
  assertAuthMutationCurrent(mutationGeneration, reason);
  if (studentAuthCommitPendingGeneration !== mutationGeneration) {
    throw authMutationSuperseded(reason);
  }
  studentAuthCommitPending = false;
  studentAuthCommitPendingGeneration = 0;
  completeAuthCommitRecoveryBarrier();
}

function restoreWorkerWakeAuthState(stored, resolvedServerUrl, restoreGeneration, options = {}) {
  const interruptedAuthClear = stored?.[STUDENT_AUTH_INVALIDATING_KEY] === true;
  const interruptedAuthCommit = stored?.[STUDENT_AUTH_COMMIT_PENDING_KEY] === true;
  const manualAuthTimestampInvalid = isManualIdentitySource(stored?.identitySource)
    && !isManualLoginTimestampFresh(stored?.manualLoginLastSeenAt);
  const authRestoreBlocked = interruptedAuthClear
    || interruptedAuthCommit
    || manualAuthTimestampInvalid;
  return enqueueStudentAuthMutation(async () => {
    const assertCurrent = () => assertAuthMutationCurrent(
      restoreGeneration,
      'worker wake auth restore',
      { allowInvalidating: authRestoreBlocked },
    );
    assertCurrent();

    if (authRestoreBlocked) {
      studentAuthInvalidating = true;
      studentAuthCommitPending = interruptedAuthCommit;
      if (interruptedAuthCommit) startAuthCommitRecoveryBarrier();
      CONFIG.autoRegistrationPaused = true;
    }

    if (stored?.config) {
      const { serverUrl, ...safeConfig } = persistedNonAuthConfig(stored.config);
      if (options.persistConfig !== false) {
        await kv.set({ config: { serverUrl, ...safeConfig } });
        assertCurrent();
      }
      CONFIG = { ...CONFIG, ...safeConfig };
    }

    CONFIG.serverUrl = resolvedServerUrl;
    if (stored?.deviceId) CONFIG.deviceId = stored.deviceId;
    if (!authRestoreBlocked) {
      if (stored?.activeStudentId) CONFIG.activeStudentId = stored.activeStudentId;
      if (stored?.activeStudentSessionId) CONFIG.activeStudentSessionId = stored.activeStudentSessionId;
      if (stored?.studentEmail) CONFIG.studentEmail = stored.studentEmail;
      if (stored?.studentName) CONFIG.studentName = stored.studentName;
      if (stored?.studentToken) CONFIG.studentToken = stored.studentToken;
      if (stored?.identitySource) CONFIG.identitySource = stored.identitySource;
      if (stored?.manualLoginLastSeenAt) CONFIG.manualLoginLastSeenAt = stored.manualLoginLastSeenAt;
    }
    CONFIG.autoRegistrationPaused = authRestoreBlocked
      || stored?.autoRegistrationPaused === true;
    sharedAuthLockedSinceAt = Number(stored?.sharedAuthLockedSinceAt || sharedAuthLockedSinceAt || 0);
    if (
      !authRestoreBlocked
      && CONFIG.studentToken
      && CONFIG.activeStudentId
      && CONFIG.activeStudentSessionId
    ) {
      studentAuthInvalidating = false;
    }
    return { interruptedAuthClear, interruptedAuthCommit, manualAuthTimestampInvalid };
  });
}

function clearStudentAuth(reason = 'manual-clear', options = {}) {
  // Reserve the mutation and revoke the current authority synchronously. A
  // login already waiting on the network must not briefly reinstall its old
  // response before this cleanup reaches the queue.
  studentAuthMutationGeneration += 1;
  studentAuthInvalidating = true;
  if (fastAuthGateEnabled) {
    resetSharedSignInLoginConfigCache({ clearPersisted: true });
  }
  if (options.disconnectWebSocket !== false) disconnectWebSocket();
  const invalidationPersisted = durableLocalKv.set({ [STUDENT_AUTH_INVALIDATING_KEY]: true });
  return enqueueStudentAuthMutation(() => clearStudentAuthNow(
    reason,
    options,
    invalidationPersisted,
  ));
}

async function clearStudentAuthNow(reason = 'manual-clear', options = {}, invalidationPersisted) {
  await invalidationPersisted;
  const tokenToEnd = CONFIG.studentToken;
  const pauseAutoRegistration = options.pauseAutoRegistration === true;
  const disconnect = options.disconnectWebSocket !== false;
  // Revoke the in-memory authority before the first await. Cleanup and the
  // captured-token flush may take time; old exact-bound frames must fail
  // closed throughout that window.
  studentAuthInvalidating = true;
  sharedAuthLockedSinceAt = 0;
  chrome.alarms.clear(SHARED_AUTH_LOCK_ALARM_NAME);

  // A confirmed student sign-out/profile change ends the student-bound
  // classroom context. Clear only teacher-session ranges; school policy stays.
  await clearTeacherSessionStateForSignOut().catch((error) => {
    console.warn('[Auth] Classroom state clear failed:', error?.message || error);
  });
  await clearFabAndOverlayState(reason, { closeChat: true }).catch((error) => {
    console.warn('[Auth] FAB/overlay state clear failed:', error?.message || error);
  });
  await clearStudentMessageState(reason).catch((error) => {
    console.warn('[Auth] Student message state clear failed:', error?.message || error);
  });
  // Best-effort the final bounded batch while the old token is still valid,
  // then discard anything unsent. Retrying it under a later student's token
  // would misattribute the prior student's activity.
  if (options.localOnly !== true) {
    await flushMonitoringEventOutbox().catch(() => {});
  }
  await discardMonitoringEventOutbox().catch(() => {});
  if (options.localOnly !== true) {
    await flushCommandAckOutbox({ forceHttp: true }).catch(() => {});
  }
  await discardCommandAckOutbox().catch(() => {});
  if (options.localOnly !== true) {
    await flushChatAckOutbox({ forceHttp: true }).catch(() => {});
  }
  await discardChatAckOutbox().catch(() => {});
  await kv.remove(TAB_SNAPSHOT_STORAGE_KEY);
  currentTabSnapshotRevision = 0;
  lastKnownTabs = [];

  if (options.notifyBackend && tokenToEnd && CONFIG.serverUrl) {
    try {
      await fetchWithBackoff(`${CONFIG.serverUrl}/api/extension/sign-out`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${tokenToEnd}`,
        },
        body: JSON.stringify({ deviceId: CONFIG.deviceId, reason }),
      }, {
        context: 'student sign-out',
        maxAttempts: 1,
        respectGlobalBackoff: false,
      });
    } catch (error) {
      console.warn('[Auth] Session-end call failed:', error?.message || error);
    }
  }

  // 2.6.8: the pause fence is MONOTONIC across clears — a later clear (e.g.
  // a second sign-out tap after identity was already nulled) must never lower
  // a pause an earlier clear raised, or the next worker wake auto-registers
  // the student straight back in. Only a deliberate credentialed login (or a
  // chrome-profile email CHANGE, which clears the stored pause explicitly)
  // re-enables auto-registration.
  const nextAutoRegistrationPaused =
    pauseAutoRegistration || CONFIG.autoRegistrationPaused === true;

  CONFIG.studentToken = null;
  CONFIG.studentEmail = null;
  CONFIG.studentName = null;
  CONFIG.activeStudentId = null;
  CONFIG.activeStudentSessionId = null;
  CONFIG.identitySource = null;
  CONFIG.manualLoginLastSeenAt = null;
  CONFIG.autoRegistrationPaused = nextAutoRegistrationPaused;
  CONFIG.sharedAuthLockedSinceAt = null;

  // A heartbeat begun under the old token may still finish while sign-out is
  // unwinding. Clear again after invalidating the in-memory identity so that
  // no late response can repopulate the old student's inbox.
  await clearStudentMessageState(`${reason}-final`);

  await clearStoredAuthState({
    registered: false,
    autoRegistrationPaused: nextAutoRegistrationPaused,
  });
  studentAuthCommitPending = false;
  studentAuthCommitPendingGeneration = 0;
  completeAuthCommitRecoveryBarrier();
  if (!nextAutoRegistrationPaused) {
    // Chrome-profile transitions immediately continue into a fresh,
    // generation-fenced registration. Explicit/shared-device sign-outs keep
    // the fence raised until the next deliberate student login.
    studentAuthInvalidating = false;
  }

  scheduleHeartbeat(null);
  scheduleScreenshotCapture(false);
  chrome.alarms.clear(CONNECTIVITY_HEALTH_ALARM_NAME);
  if (disconnect) {
    await disconnectWebSocket();
  }
  await setConnectivityBadge(connectivityStatus());
  if (options.notifyAuthGateTabs !== false) {
    await notifyAuthGateStateToTabs({
      triggerRefresh: false,
      // Auth invalidation is itself authoritative and safe to publish while a
      // managed-policy barrier is pending. Waiting for that barrier here can
      // deadlock a revalidation that is deliberately awaiting this cleanup.
      skipManagedPolicyWait: true,
    });
  }
}

async function expireManualAuthIfStale(reason = 'stale-check') {
  const source = CONFIG.identitySource;
  if (!isManualIdentitySource(source)) {
    return false;
  }

  if (isManualLoginTimestampFresh(CONFIG.manualLoginLastSeenAt)) {
    return false;
  }

  console.log(`[Auth] Manual login expired (${reason})`);
  await clearStudentAuth('auto_stale_wake', { notifyBackend: true, pauseAutoRegistration: true });
  return true;
}

function expireManualAuthIfStaleFailClosed(reason = 'stale-check') {
  if (!isManualIdentitySource()) return false;
  if (isManualLoginTimestampFresh(CONFIG.manualLoginLastSeenAt)) return false;

  console.log(`[Auth] Manual login expired (${reason}); raising local auth fence`);
  // clearStudentAuth synchronously sets studentAuthInvalidating before doing
  // any async classroom/backend cleanup, so this call makes hasStudentAuth()
  // false before the latency-critical auth-state response is composed.
  clearStudentAuth('auto_stale_wake', {
    notifyBackend: true,
    pauseAutoRegistration: true,
  }).catch(() => {});
  return true;
}

async function clearSharedAuthLockTimer() {
  sharedAuthLockedSinceAt = 0;
  chrome.alarms.clear(SHARED_AUTH_LOCK_ALARM_NAME);
  if (isManualIdentitySource()) {
    await setManualAuthState({ sharedAuthLockedSinceAt: null });
  } else {
    await kv.set({ sharedAuthLockedSinceAt: null });
    if (hasSessionStorage()) await sessionKv.remove(['sharedAuthLockedSinceAt']);
  }
}

async function scheduleSharedAuthLockTimer(reason = 'locked') {
  if (!hasStudentAuth() || !isManualIdentitySource()) {
    await clearSharedAuthLockTimer();
    return;
  }
  if (!sharedAuthLockedSinceAt) {
    sharedAuthLockedSinceAt = Date.now();
    await setManualAuthState({ sharedAuthLockedSinceAt });
  }
  chrome.alarms.create(SHARED_AUTH_LOCK_ALARM_NAME, {
    delayInMinutes: SHARED_AUTH_LOCK_TIMEOUT_MS / 60000,
  });
  console.log(`[Auth] Shared-device lock timeout scheduled (${reason})`);
}

async function handleIdleStateChanged(state, reason = 'idle-change') {
  idleState = state;
  if (state === 'locked') {
    await scheduleSharedAuthLockTimer(reason);
  } else {
    await clearSharedAuthLockTimer();
  }
  await updateTrackingState(reason);
}

async function handleSharedAuthLockTimeout() {
  if (!hasStudentAuth() || !isManualIdentitySource()) {
    await clearSharedAuthLockTimer();
    return;
  }
  const currentState = await new Promise(resolve => {
    if (!chrome.idle?.queryState) {
      resolve(idleState);
      return;
    }
    chrome.idle.queryState(IDLE_DETECTION_SECONDS, resolve);
  });
  idleState = currentState || idleState;
  if (idleState !== 'locked') {
    await clearSharedAuthLockTimer();
    await updateTrackingState('lock-timeout-cancelled');
    return;
  }

  const stored = await getStoredAuthState(['sharedAuthLockedSinceAt']);
  const lockedSince = Number(sharedAuthLockedSinceAt || stored.sharedAuthLockedSinceAt || 0);
  if (!lockedSince || Date.now() - lockedSince < SHARED_AUTH_LOCK_TIMEOUT_MS) {
    chrome.alarms.create(SHARED_AUTH_LOCK_ALARM_NAME, {
      delayInMinutes: SHARED_AUTH_LOCK_TIMEOUT_MS / 60000,
    });
    return;
  }

  console.log('[Auth] Shared-device student auth cleared after lock timeout');
  await clearStudentAuth('auto_locked_timeout', { notifyBackend: true, pauseAutoRegistration: true });
}

async function fetchLoginRosterForGate(options = {}) {
  const useFastAuthGate = fastAuthGateEnabled;
  const requestAuthMutationGeneration = studentAuthMutationGeneration;
  const requestConfigGeneration = sharedSignInConfigGeneration;
  const requestPolicyGeneration = managedAuthGatePolicyGeneration;
  const requestBindingKey = authGateConfigBindingKey();
  const requestIsStale = () => (
    requestAuthMutationGeneration !== studentAuthMutationGeneration
    || requestConfigGeneration !== sharedSignInConfigGeneration
    || requestPolicyGeneration !== managedAuthGatePolicyGeneration
    || requestBindingKey !== authGateConfigBindingKey()
    || hasStudentAuth()
  );
  const staleResult = () => ({
    success: false,
    stale: true,
    phase: hasStudentAuth() ? 'authenticated' : getAuthGateState().phase,
    error: 'Sign-in state changed while loading the roster',
  });

  if (hasStudentAuth()) return staleResult();
  if (!hasManagedSchoolSetup()) {
    return { success: false, setupRequired: true, error: 'Shared Chromebook setup required' };
  }
  if (useFastAuthGate && sharedSignInLoginConfig.phase !== 'ready') {
    return {
      success: false,
      setupRequired: sharedSignInLoginConfig.phase === 'setup_required',
      unavailable: sharedSignInLoginConfig.phase === 'unavailable',
      phase: sharedSignInLoginConfig.phase,
      error: sharedSignInLoginConfig.phase === 'unavailable'
        ? 'ClassPilot is temporarily unavailable'
        : 'ClassPilot sign-in setup is still loading',
    };
  }
  const requestedGradeLevel = String(options.gradeLevel || '').trim();

  const params = new URLSearchParams();
  if (requestedGradeLevel) params.set('gradeLevel', requestedGradeLevel);
  if (CONFIG.schoolId) params.set('schoolId', CONFIG.schoolId);
  if (CONFIG.schoolSlug) params.set('schoolSlug', CONFIG.schoolSlug);

  const requestUrl = `${CONFIG.serverUrl}/api/extension/login-roster?${params.toString()}`;
  let response;
  let data;
  let jsonValid = true;
  try {
    if (useFastAuthGate) {
      ({ response, data, jsonValid } = await fetchAuthGateRequest(requestUrl, {
        cache: 'no-store',
        headers: { 'X-ClassPilot-Enrollment-Key': CONFIG.enrollmentKey },
      }));
    } else {
      response = await fetchWithBackoff(requestUrl, {
        cache: 'no-store',
        headers: { 'X-ClassPilot-Enrollment-Key': CONFIG.enrollmentKey },
      }, {
        context: 'login roster',
        maxAttempts: 2,
        respectGlobalBackoff: false,
      });
      data = await response.json().catch(() => ({}));
    }
  } catch (error) {
    if (requestIsStale()) return staleResult();
    if (!useFastAuthGate) throw error;
    return {
      success: false,
      setupRequired: false,
      unavailable: true,
      phase: 'unavailable',
      error: error?.code === 'AUTH_GATE_TIMEOUT'
        ? 'Roster request timed out'
        : 'Could not reach ClassPilot to load the roster',
    };
  }
  if (requestIsStale()) return staleResult();
  if (useFastAuthGate && response.ok && (!jsonValid || !isValidLoginRosterPayload(data))) {
    return {
      success: false,
      setupRequired: false,
      unavailable: true,
      phase: 'unavailable',
      error: 'ClassPilot returned an invalid roster response',
    };
  }
  if (!response.ok) {
    const unavailable = useFastAuthGate && isUnavailableAuthGateResponse(response);
    return {
      success: false,
      setupRequired: useFastAuthGate
        ? !unavailable && (response.status === 400 || response.status === 401 ||
          response.status === 403 || response.status === 404 || response.status === 422)
        : response.status === 401 || response.status === 404,
      unavailable,
      phase: unavailable ? 'unavailable' : 'setup_required',
      pinLoginEnabled: data.loginMethod !== 'email_id',
      loginMethod: data.loginMethod === 'email_id' ? 'email_id' : 'name_pin',
      error: data.error || 'Could not load roster',
    };
  }
  return {
    success: true,
    students: data.students || [],
    grades: Array.isArray(data.grades) ? data.grades : [],
    loginMethod: data.loginMethod === 'email_id' ? 'email_id' : 'name_pin',
    pinLoginEnabled: data.loginMethod !== 'email_id',
  };
}

async function applyClassroomStateFromAuthResponse(data, reason, options = {}) {
  if (!data) return;
  const fabState = data.fabState || data.fab || data.settings?.fab;
  if (!Object.prototype.hasOwnProperty.call(data, 'classroomState')) {
    if (fabState) {
      await applyFabSettings({ ...fabState, reason: fabState.reason || reason });
    }
    return;
  }
  const snapshot = data.classroomState;
  await classroomStateRestorePromise;
  const storedBinding = await kv.get(CLASSROOM_STATE_STUDENT_BINDING_KEY);
  const boundStudentId = storedBinding[CLASSROOM_STATE_STUDENT_BINDING_KEY] || null;
  if (
    currentClassroomState
    && (!boundStudentId || boundStudentId !== CONFIG.activeStudentId)
  ) {
    await clearTeacherSessionStateForSignOut({ emitEvent: false, reason: `${reason}_student_changed` });
  }
  if (!snapshot) {
    await clearTeacherSessionStateForSignOut({
      emitEvent: false,
      reason: `${reason}_no_state`,
      preserveTransientOverlays: true,
    });
    if (CONFIG.activeStudentId) {
      await kv.set({ [CLASSROOM_STATE_STUDENT_BINDING_KEY]: CONFIG.activeStudentId });
    }
    if (fabState) {
      await applyFabSettings({ ...fabState, reason: fabState.reason || reason });
    }
    return;
  }
  try {
    // This response was read only after the server revalidated the exact new
    // student/session/device token binding. It is authoritative across student
    // changes on a shared device, where revisions are not comparable between
    // the old and new student's independent control rows.
    await applyClassroomState(snapshot, { reason });
    if (CONFIG.activeStudentId) {
      await kv.set({ [CLASSROOM_STATE_STUDENT_BINDING_KEY]: CONFIG.activeStudentId });
    }
  } catch (error) {
    console.warn('[Classroom State] Login snapshot failed:', error?.message || error);
    requestClassroomStateSync(`${reason}-failed`, true);
    if (options.requireApplied === true) throw error;
  }
  if (fabState) {
    await applyFabSettings({ ...fabState, reason: fabState.reason || reason });
  }
}

async function manualStudentLogin(payload) {
  await authStateRestorePromise;
  // A managed-policy change installs its pending reread promise in the same
  // synchronous storage event. Never build or send credentials against the
  // partial snapshot visible during that reread.
  await awaitManagedAuthGatePolicyStable();
  await authCommitRecoveryPromise;
  if (studentAuthCommitPending) {
    throw new Error('Authentication recovery is still in progress');
  }
  if (!canUseStudentLoginAuthority()) {
    const setupError = new Error('ClassPilot student sign-in is not configured');
    setupError.code = 'AUTH_GATE_SETUP_REQUIRED';
    throw setupError;
  }

  const policyGuard = captureAuthGatePolicyGuard();
  assertAuthGatePolicyGuardCurrent(policyGuard, 'student login policy');
  const mutationGeneration = ++studentAuthMutationGeneration;
  manualStudentLoginPendingGeneration = mutationGeneration;
  CONFIG.autoRegistrationPaused = true;
  const priorChromeProfileRegistration = chromeProfileRegistrationInFlight;
  try {
    // Let a request already accepted by the server finish before issuing the
    // manual login, so the manual session is always the last server binding.
    // Its client adoption is generation-rejected while the auth queue is free.
    if (priorChromeProfileRegistration) await priorChromeProfileRegistration.catch(() => {});
    assertAuthMutationCurrent(mutationGeneration, 'student login', { allowInvalidating: true });
    assertAuthGatePolicyGuardCurrent(policyGuard, 'student login policy');
    return await enqueueStudentAuthMutation(() => manualStudentLoginNow(
      payload,
      mutationGeneration,
      policyGuard,
    ));
  } catch (error) {
    if (studentAuthCommitPendingGeneration === mutationGeneration) {
      // Raising clearStudentAuth's fence is synchronous. Comprehensive local
      // and backend cleanup can finish behind the rejected login response.
      clearStudentAuth('student_login_commit_failed', {
        notifyBackend: true,
        pauseAutoRegistration: true,
      }).catch((cleanupError) => {
        failAuthCommitRecoveryBarrier(cleanupError);
        console.warn('[Auth] Failed login commit cleanup:', cleanupError?.message || cleanupError);
      });
    }
    throw error;
  } finally {
    if (manualStudentLoginPendingGeneration === mutationGeneration) {
      manualStudentLoginPendingGeneration = 0;
    }
  }
}

async function manualStudentLoginNow(payload, mutationGeneration, policyGuard) {
  assertAuthGatePolicyGuardCurrent(policyGuard, 'student login request');
  if (!canUseStudentLoginAuthority()) {
    throw new Error('ClassPilot student sign-in is not configured');
  }
  const deviceId = await ensureDeviceId();
  assertAuthGatePolicyGuardCurrent(policyGuard, 'student login request');
  if (!canUseStudentLoginAuthority()) {
    throw new Error('ClassPilot student sign-in is not configured');
  }
  const isPinLogin = payload.mode === 'pin';
  const body = {
    deviceId,
    deviceName: null,
    classId: 'auto',
    ...extensionProtocolDescriptor(),
  };

  if (isPinLogin) {
    body.studentId = payload.studentId;
    body.pin = payload.pin;
    body.schoolId = CONFIG.schoolId || undefined;
    body.schoolSlug = CONFIG.schoolSlug || undefined;
    body.enrollmentKey = CONFIG.enrollmentKey || undefined;
  } else {
    body.studentEmail = normalizeEmail(payload.studentEmail);
    body.studentIdNumber = String(payload.studentIdNumber || '').trim();
    body.schoolId = CONFIG.schoolId || undefined;
    body.schoolSlug = CONFIG.schoolSlug || undefined;
    if (CONFIG.enrollmentKey) body.enrollmentKey = CONFIG.enrollmentKey;
  }

  const response = await fetchWithBackoff(`${CONFIG.serverUrl}/api/extension/student-login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(CONFIG.enrollmentKey ? { 'X-ClassPilot-Enrollment-Key': CONFIG.enrollmentKey } : {}),
    },
    body: JSON.stringify(body),
  }, {
    context: 'student login',
    maxAttempts: 1,
    respectGlobalBackoff: false,
  });
  assertAuthMutationCurrent(mutationGeneration, 'student login response', { allowInvalidating: true });
  assertAuthGatePolicyGuardCurrent(policyGuard, 'student login response');
  const data = await response.json().catch(() => ({}));
  assertAuthMutationCurrent(mutationGeneration, 'student login response', { allowInvalidating: true });
  assertAuthGatePolicyGuardCurrent(policyGuard, 'student login response');
  if (!response.ok || !data.studentToken) {
    throw buildResponseError(response, data, 'Invalid student credentials');
  }

  const student = data.student || {};
  const studentName = [student.firstName, student.lastName].filter(Boolean).join(' ') ||
    student.studentName ||
    student.email ||
    body.studentEmail ||
    'Student';
  const studentEmail = student.email || body.studentEmail || null;
  const authenticatedSchoolId = String(data.schoolId || student.schoolId || '').trim() || null;
  const now = Date.now();

  assertAuthMutationCurrent(mutationGeneration, 'student login', { allowInvalidating: true });
  const studentId = String(student.id || '').trim() || null;
  const studentSessionId = String(
    data.studentSessionId || data.fab?.studentSessionId || ''
  ).trim() || null;
  if (!studentId || !studentSessionId) {
    throw new Error('Student login omitted the exact student binding');
  }
  const identitySource = isPinLogin ? 'manual_pin' : 'manual_email_id';

  await beginStudentAuthCommit(mutationGeneration, 'student login commit');

  // Clear the local crash-recovery marker before dispatching the session
  // storage commit. A reset requested later writes `true` afterward and wins.
  const markerCleared = durableLocalKv.remove(STUDENT_AUTH_INVALIDATING_KEY);
  await durableLocalKv.set({
    deviceId,
    classId: 'auto',
    config: persistedNonAuthConfig({
      ...CONFIG,
      deviceId,
      classId: 'auto',
      ...(authenticatedSchoolId ? { schoolId: authenticatedSchoolId } : {}),
    }),
  });
  await setManualAuthState({
    studentToken: data.studentToken,
    activeStudentId: studentId,
    activeStudentSessionId: studentSessionId,
    studentEmail,
    studentName,
    registered: true,
    lastRegisteredEmail: studentEmail,
    identitySource,
    manualLoginLastSeenAt: now,
    autoRegistrationPaused: false,
  });
  await markerCleared;
  assertAuthMutationCurrent(mutationGeneration, 'student login', { allowInvalidating: true });
  assertAuthGatePolicyGuardCurrent(policyGuard, 'student login adoption');
  CONFIG.studentToken = data.studentToken;
  CONFIG.activeStudentId = studentId;
  CONFIG.activeStudentSessionId = studentSessionId;
  CONFIG.studentEmail = studentEmail;
  CONFIG.studentName = studentName;
  CONFIG.classId = 'auto';
  CONFIG.identitySource = identitySource;
  if (authenticatedSchoolId) CONFIG.schoolId = authenticatedSchoolId;
  CONFIG.manualLoginLastSeenAt = now;
  CONFIG.autoRegistrationPaused = false;
  studentAuthInvalidating = false;
  resetSharedSignInLoginConfigCache({ clearPersisted: true });
  // Authentication intentionally invalidates the pre-login presentation
  // generation, and a slug-based setup may learn its canonical schoolId from
  // this authoritative response. Capture that expected post-adoption binding
  // while retaining the managed-policy generation that authorized the request.
  const committedPolicyGuard = captureAuthGatePolicyGuard();
  if (committedPolicyGuard.managedPolicyGeneration !== policyGuard.managedPolicyGeneration) {
    throw authMutationSuperseded('student login adoption');
  }
  await reconcileMessageInboxIdentity('student-login');

  // Login-provided classroom restrictions are local enforcement authority and
  // must be reconciled before any page unlocks. License/settings refreshes are
  // not part of that critical path.
  await applyClassroomStateFromAuthResponse(data, 'student_login', { requireApplied: true });
  assertAuthMutationCurrent(mutationGeneration, 'student login');
  assertAuthGatePolicyGuardCurrent(committedPolicyGuard, 'student login adoption');
  await completeStudentAuthCommit(mutationGeneration, 'student login commit');
  assertAuthGatePolicyGuardCurrent(committedPolicyGuard, 'student login adoption');

  const committedAuthBinding = {
    deviceId: CONFIG.deviceId,
    studentToken: CONFIG.studentToken,
    studentId: CONFIG.activeStudentId,
    studentSessionId: CONFIG.activeStudentSessionId,
  };
  // Start the cross-tab authenticated push immediately, but do not make the
  // initiating tab wait for every tab message/injection attempt to settle.
  notifyAuthGateStateToTabs({ triggerRefresh: false }).catch((error) => {
    console.warn('[Auth Gate] Post-login broadcast failed:', error?.message || error);
  });

  Promise.resolve().then(async () => {
    assertAuthMutationBindingCurrent(
      mutationGeneration,
      committedAuthBinding,
      'post-login initialization',
    );
    await checkLicenseStatus('manual-login', {
      authMutationGeneration: mutationGeneration,
      authBinding: committedAuthBinding,
      deferTrackingInitialization: true,
    });
    assertAuthMutationBindingCurrent(
      mutationGeneration,
      committedAuthBinding,
      'post-login initialization',
    );
    await initializeAdaptiveTracking('manual-login', {
      authMutationGeneration: mutationGeneration,
      authBinding: committedAuthBinding,
    });
  }).catch((error) => {
    if (error?.code === 'AUTH_MUTATION_SUPERSEDED') {
      console.info('[Auth] Post-login initialization superseded');
      return;
    }
    console.warn('[Auth] Post-login initialization failed:', error?.message || error);
  });

  return {
    success: true,
    student: {
      id: CONFIG.activeStudentId,
      name: studentName,
      email: studentEmail,
    },
    manualExpiresInSeconds: data.manualExpiresInSeconds || Math.floor(MANUAL_LOGIN_STALE_MS / 1000),
  };
}

// Email normalization: ensures consistent student identity
function normalizeEmail(raw) {
  if (!raw) return null;
  try {
    const email = raw.trim().toLowerCase();
    const [local, domain] = email.split('@');
    if (!local || !domain) return null;
    // Strip +tags from email (e.g., john+test@school.org → john@school.org)
    const baseLocal = local.split('+')[0];
    return `${baseLocal}@${domain}`;
  } catch (err) {
    console.warn('[Service Worker] Email normalization failed:', err);
    return null;
  }
}

async function detectChromeProfileEmail() {
  if (chrome.identity?.getProfileUserInfo) {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const profile = await new Promise(resolve =>
          chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' }, resolve)
        );
        if (profile?.email) {
          return normalizeEmail(profile.email);
        }
      } catch (err) {
        console.log(`[Service Worker] Could not get profile info (attempt ${attempt + 1}):`, err);
      }
      if (attempt < 2) {
        await new Promise(r => setTimeout(r, 2000));
      }
    }
  }

  if (chrome.identity?.getAuthToken) {
    try {
      const token = await new Promise((resolve, reject) =>
        chrome.identity.getAuthToken({ interactive: false }, (t) => {
          if (chrome.runtime.lastError) {
            reject(new Error(chrome.runtime.lastError.message));
          } else if (t) {
            resolve(t);
          } else {
            reject(new Error('No token retrieved'));
          }
        })
      );
      if (token) {
        const resp = await fetch('https://www.googleapis.com/oauth2/v1/userinfo?alt=json', {
          headers: { Authorization: `Bearer ${token}` },
        });
        const info = await resp.json();
        if (info?.email) {
          return normalizeEmail(info.email);
        }
      }
    } catch {
      // Fallback failed; continue without email.
    }
  }

  return null;
}

// Auto-registration: ensures extension always has IDs before sharing
// EMAIL-FIRST IDENTITY: Email is required, deviceId is internal tracking only
function runChromeProfileRegistration(registration) {
  if (chromeProfileRegistrationInFlight) return chromeProfileRegistrationInFlight;
  const run = Promise.resolve().then(registration);
  chromeProfileRegistrationInFlight = run.finally(() => {
    if (chromeProfileRegistrationInFlight === runWithCleanup) {
      chromeProfileRegistrationInFlight = null;
    }
  });
  const runWithCleanup = chromeProfileRegistrationInFlight;
  return runWithCleanup;
}

function ensureRegistered() {
  return runChromeProfileRegistration(() => ensureRegisteredNow());
}

async function refreshRegistrationAfterIdentityChange() {
  const inFlight = chromeProfileRegistrationInFlight;
  if (inFlight) await inFlight.catch(() => {});
  return ensureRegistered();
}

async function ensureRegisteredNow() {
  console.log('[Service Worker] Ensuring registration...');
  
  try {
    assertChromeProfileRegistrationAllowed('student registration');
    let registrationGeneration = studentAuthMutationGeneration;
    await expireManualAuthIfStale('ensure-registered');
    registrationGeneration = studentAuthMutationGeneration;
    assertAuthMutationCurrent(registrationGeneration, 'student registration restore');

    // Load config from server
    const serverUrl = CONFIG.serverUrl || DEFAULT_SERVER_URL;
    await fetchClientConfig(serverUrl);
    applyManagedSchoolConfig(await readManagedConfig());
    
    // Get or create IDs (including studentToken for consistent state)
    let stored = await getStoredAuthState([
      'studentEmail',
      'studentName',
      'deviceId',
      'registered',
      'lastRegisteredEmail',
      'studentToken',
      'activeStudentId',
      'activeStudentSessionId',
      'identitySource',
      'manualLoginLastSeenAt',
      'autoRegistrationPaused',
      'sharedAuthLockedSinceAt',
      STUDENT_AUTH_INVALIDATING_KEY,
    ]);
    assertAuthMutationCurrent(registrationGeneration, 'student registration restore');

    if (stored[STUDENT_AUTH_INVALIDATING_KEY] === true) {
      studentAuthInvalidating = true;
      CONFIG.autoRegistrationPaused = true;
      return stored;
    }

    if (stored.studentToken) {
      CONFIG.studentToken = stored.studentToken;
    }
    if (stored.deviceId) {
      CONFIG.deviceId = stored.deviceId;
    }
    
    // Get the current Chrome profile email on every Chrome-profile auth pass.
    // If student A signs out and student B signs in, stale stored email/token
    // must not keep attributing B's browsing to A.
    if (!isManualIdentitySource(stored.identitySource)) {
      const profileEmail = await detectChromeProfileEmail();
      assertAuthMutationCurrent(registrationGeneration, 'student registration profile lookup');
      if (profileEmail && stored.studentEmail && stored.studentEmail !== profileEmail) {
        console.log(`[Service Worker] Chrome profile changed from ${stored.studentEmail} to ${profileEmail}; re-registering`);
        await clearStudentAuth('chrome-profile-email-changed', { notifyBackend: true });
        registrationGeneration = studentAuthMutationGeneration;
        assertAuthMutationCurrent(registrationGeneration, 'student registration profile change');
        stored = {
          ...stored,
          studentEmail: profileEmail,
          studentName: null,
          registered: false,
          lastRegisteredEmail: null,
          studentToken: null,
          activeStudentId: null,
          activeStudentSessionId: null,
          identitySource: null,
          manualLoginLastSeenAt: null,
          autoRegistrationPaused: false,
        };
      } else if (profileEmail) {
        stored.studentEmail = profileEmail;
      } else if (stored.identitySource === 'chrome_profile' && stored.studentEmail) {
        console.log('[Service Worker] Chrome profile email disappeared; clearing Chrome-profile student auth');
        await clearStudentAuth('chrome-profile-email-missing', { notifyBackend: true });
        return await kv.get(['deviceId']);
      }
    }

    // If we still have no email after retries
    if (!stored.studentEmail) {
      console.warn('[Service Worker] No Chrome profile email detected — shared sign-in gate will be required');
    }
    
    // Always create a deviceId internally (never exposed to teachers)
    if (!stored.deviceId) {
      stored.deviceId = 'device-' + crypto.randomUUID().slice(0, 11);
    }
    
    // Save to storage
    if (isManualIdentitySource(stored.identitySource)) {
      const manualState = {};
      for (const key of AUTH_STATE_KEYS) {
        if (key in stored) manualState[key] = stored[key];
      }
      await setManualAuthState(manualState);
      await kv.set({ deviceId: stored.deviceId });
    } else {
      await kv.set(stored);
    }
    assertAuthMutationCurrent(registrationGeneration, 'student registration restore');
    
    // Update CONFIG (email is primary identity - backend will determine schoolId from email domain)
    CONFIG.studentEmail = stored.studentEmail;
    CONFIG.studentName = stored.studentName || (stored.studentEmail ? stored.studentEmail.split('@')[0] : stored.studentEmail);
    CONFIG.deviceId = stored.deviceId;
    CONFIG.classId = 'auto'; // Backend determines this from email domain
    CONFIG.activeStudentId = stored.activeStudentId || CONFIG.activeStudentId;
    CONFIG.activeStudentSessionId = stored.activeStudentSessionId || CONFIG.activeStudentSessionId;
    CONFIG.identitySource = stored.identitySource || CONFIG.identitySource;
    CONFIG.manualLoginLastSeenAt = stored.manualLoginLastSeenAt || CONFIG.manualLoginLastSeenAt;
    CONFIG.autoRegistrationPaused = stored.autoRegistrationPaused === true;
    sharedAuthLockedSinceAt = Number(stored.sharedAuthLockedSinceAt || sharedAuthLockedSinceAt || 0);

    if (await expireManualAuthIfStale('ensure-registered-storage')) {
      return await kv.get(['deviceId']);
    }
    
    // ✅ JWT FIX: Load existing studentToken BEFORE deciding to skip registration
    // This prevents timing issues where service worker wakes up without token in memory
    if (stored.studentToken) {
      CONFIG.studentToken = stored.studentToken;
      console.log('✅ [JWT] Loaded existing studentToken in ensureRegistered()');
    }

    if (CONFIG.autoRegistrationPaused && !CONFIG.studentToken) {
      console.log('[Auth] Auto-registration paused until the student signs in again');
      await notifyAuthGateStateToTabs();
      return stored;
    }
    
    // Register with server if we have email and haven't registered yet (or email changed)
    const emailChanged = stored.lastRegisteredEmail !== stored.studentEmail;
    const needsRegistration =
      stored.studentEmail &&
      !isManualIdentitySource(stored.identitySource) &&
      (!stored.registered || emailChanged);
    
    if (needsRegistration) {
      try {
        assertAuthMutationCurrent(registrationGeneration, 'student registration');
        console.log('[Service Worker] Registering student with server');
        const response = await fetchWithBackoff(`${CONFIG.serverUrl}/api/extension/register`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(CONFIG.enrollmentKey ? { 'X-ClassPilot-Enrollment-Key': CONFIG.enrollmentKey } : {}),
          },
          body: JSON.stringify({
            deviceId: stored.deviceId,
            deviceName: null, // No device name needed
            studentEmail: stored.studentEmail,
            studentName: CONFIG.studentName,
            schoolId: CONFIG.schoolId || undefined,
            schoolSlug: CONFIG.schoolSlug || undefined,
            enrollmentKey: CONFIG.enrollmentKey || undefined,
            ...extensionProtocolDescriptor(),
          }),
        }, {
          context: 'student registration',
          maxAttempts: 1,
        });
        
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
          throw buildResponseError(response, errorData, 'Student registration failed');
        }
        
        const data = await response.json();
        console.log('[Service Worker] Student registered successfully');
        const studentId = String(data.student?.id || '').trim() || null;
        const studentSessionId = String(
          data.studentSessionId || data.fab?.studentSessionId || ''
        ).trim() || null;
        const authenticatedSchoolId = String(
          data.schoolId || data.student?.schoolId || ''
        ).trim() || null;
        if (!data.studentToken || !studentId || !studentSessionId) {
          throw new Error('Student registration omitted the exact authenticated binding');
        }
        await enqueueStudentAuthMutation(async () => {
          assertAuthMutationCurrent(registrationGeneration, 'student registration');
          await beginStudentAuthCommit(
            registrationGeneration,
            'student registration commit',
          );
          await durableLocalKv.set({
            studentToken: data.studentToken,
            activeStudentId: studentId,
            activeStudentSessionId: studentSessionId,
            identitySource: 'chrome_profile',
            manualLoginLastSeenAt: null,
            autoRegistrationPaused: false,
            registered: true,
            lastRegisteredEmail: stored.studentEmail,
            ...(authenticatedSchoolId ? {
              config: persistedNonAuthConfig({ ...CONFIG, schoolId: authenticatedSchoolId }),
            } : {}),
            [STUDENT_AUTH_INVALIDATING_KEY]: null,
          });
          assertAuthMutationCurrent(registrationGeneration, 'student registration');
          CONFIG.studentToken = data.studentToken;
          CONFIG.activeStudentId = studentId;
          CONFIG.activeStudentSessionId = studentSessionId;
          CONFIG.identitySource = 'chrome_profile';
          if (authenticatedSchoolId) CONFIG.schoolId = authenticatedSchoolId;
          CONFIG.manualLoginLastSeenAt = null;
          CONFIG.autoRegistrationPaused = false;
          studentAuthInvalidating = false;
          await reconcileMessageInboxIdentity('student-registration');
          await applyClassroomStateFromAuthResponse(
            data,
            'student_registration',
            { requireApplied: true },
          );
          assertAuthMutationCurrent(registrationGeneration, 'student registration');
          await completeStudentAuthCommit(
            registrationGeneration,
            'student registration commit',
          );
        });
        registrationRetryCount = 0; // Reset on success
      } catch (error) {
        if (studentAuthCommitPendingGeneration === registrationGeneration) {
          try {
            // The durable pending marker keeps get-auth-state locked while the
            // critical classroom snapshot is being applied. Any failure must
            // remove the partially committed Chrome-profile credentials before
            // this registration can be retried.
            await clearStudentAuth('student_registration_commit_failed', {
              notifyBackend: false,
              localOnly: true,
              pauseAutoRegistration: false,
            });
            registrationGeneration = studentAuthMutationGeneration;
          } catch (cleanupError) {
            failAuthCommitRecoveryBarrier(cleanupError);
            console.warn(
              '[Auth] Failed Chrome-profile registration commit cleanup:',
              cleanupError?.message || cleanupError,
            );
            return stored;
          }
        }
        if (error?.code === 'AUTH_MUTATION_SUPERSEDED') {
          console.info('[Auth] Ignoring superseded student registration response');
          return stored;
        }
        console.warn('[Service Worker] Student registration error:', error);
        await enqueueStudentAuthMutation(async () => {
          assertAuthMutationCurrent(registrationGeneration, 'student registration failure');
          await durableLocalKv.set({ registered: false, studentToken: null });
          if (hasSessionStorage()) await durableSessionKv.remove(['studentToken']);
          assertAuthMutationCurrent(registrationGeneration, 'student registration failure');
          CONFIG.studentToken = null;
        }).catch((mutationError) => {
          if (mutationError?.code !== 'AUTH_MUTATION_SUPERSEDED') throw mutationError;
        });
        if (
          registrationGeneration !== studentAuthMutationGeneration
          || studentAuthInvalidating
        ) {
          return stored;
        }
        // Retry with exponential backoff, max 5 retries to prevent server flooding
        registrationRetryCount++;
        if (registrationRetryCount <= MAX_REGISTRATION_RETRIES) {
          const retryAfterMs = error?.retryAfterMs || 0;
          const backoff = Math.max(retryAfterMs, Math.min(5000 * Math.pow(2, registrationRetryCount - 1), 300000)); // 5s, 10s, 20s, 40s, 80s max 5min
          console.log(`[Service Worker] Retrying registration (${registrationRetryCount}/${MAX_REGISTRATION_RETRIES}) in ${backoff/1000}s`);
          setTimeout(() => ensureRegistered().catch(() => {}), backoff);
        } else {
          console.warn(`[Service Worker] Registration failed after ${MAX_REGISTRATION_RETRIES} retries — will retry on next heartbeat`);
          registrationRetryCount = 0; // Reset for next heartbeat cycle
        }
      }
    } else if (stored.studentEmail) {
      console.log('[Service Worker] Already registered');
    }
    
    console.log('[Service Worker] Registration complete');

    await checkLicenseStatus('registration');
    await notifyAuthGateStateToTabs();
    
    return stored;
  } catch (error) {
    console.warn('[Service Worker] Registration failed:', error);
    // Don't throw - extension can still work with defaults
    return {};
  }
}

// Run auto-registration on install and startup
chrome.runtime.onInstalled.addListener(() => {
  console.log('[Service Worker] Extension installed/updated');
  disableToolbarAction();
  authStateRestorePromise
    .then(() => awaitManagedAuthGatePolicyStable())
    .then(() => {
      scheduleLicenseCheck();
      ensureRegistered().catch(() => {});
      scheduleJitteredStartup('install', () => initializeAdaptiveTracking('install').catch(() => {}));
    }).catch(err => {
      console.warn('[Service Worker] Install init error (will retry):', err?.message || err);
    });
});

if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    console.log('[Service Worker] Browser started');
    disableToolbarAction();
    authStateRestorePromise
      .then(() => awaitManagedAuthGatePolicyStable())
      .then(() => {
        scheduleLicenseCheck();
        ensureRegistered().catch(() => {});
        scheduleJitteredStartup('startup', () => initializeAdaptiveTracking('startup').catch(() => {}));
      }).catch(err => {
        console.warn('[Service Worker] Startup init error (will retry):', err?.message || err);
      });
  });
}

let markClassroomStateRestored;
const classroomStateRestorePromise = new Promise((resolve) => {
  let settled = false;
  markClassroomStateRestored = () => {
    if (settled) return;
    settled = true;
    resolve();
  };
});

let markAuthStateRestored;
const authStateRestorePromise = new Promise((resolve) => {
  let settled = false;
  markAuthStateRestored = () => {
    if (settled) return;
    settled = true;
    resolve();
  };
});

// Run immediately on service worker load/wake-up
// This is CRITICAL: service worker can wake up after being terminated, not just on install/startup
(async () => {
  console.log('[Service Worker] Waking up...');
  disableToolbarAction();
  const wakePolicyGeneration = ++managedAuthGatePolicyGeneration;
  let resolveWakePolicyRestore;
  let rejectWakePolicyRestore;
  const wakePolicyRestore = new Promise((resolve, reject) => {
    resolveWakePolicyRestore = resolve;
    rejectWakePolicyRestore = reject;
  });
  managedAuthGatePolicyRestorePromise = wakePolicyRestore;
  wakePolicyRestore.catch(() => {});
  // Start the local managed-policy read in parallel with auth restoration.
  const explicitUnmanagedDevelopment = isExplicitUnmanagedDevelopmentRuntime()
    || isExplicitUnmanagedDevelopmentServer(INJECTED_SERVER_URL);
  const managedConfigReadAtWake = explicitUnmanagedDevelopment
    ? Promise.resolve({ config: {}, error: null })
    : readManagedConfig({ failClosed: true }).then(
      (config) => ({ config, error: null }),
      (error) => ({ config: {}, error }),
    );
  // Resolve the managed kiosk device identity in parallel too — it never
  // blocks the cold-auth path; kioskLaunchUrl() reads the cached value
  // synchronously and the resolution bumps the gate revision itself.
  detectManagedKioskDeviceId().catch(() => {});
  // Reserve the revision range in parallel with both auth stores and managed
  // policy. This keeps the required durable write off the sequential cold-auth
  // path as much as Chrome's storage implementation permits.
  const authGateRevisionReservationAtWake = durableLocalKv.get([AUTH_GATE_REVISION_STORAGE_KEY])
    .then((stored) => reserveAuthGateRevisionBlock(stored[AUTH_GATE_REVISION_STORAGE_KEY]))
    .catch((error) => {
      rejectAuthGateRevisionReady(error);
      throw error;
    });
  let workerWakeRestoreGeneration = studentAuthMutationGeneration;
  const authStored = await getStoredAuthState([
    'deviceId',
    'config',
    'activeStudentId',
    'activeStudentSessionId',
    'studentEmail',
    'studentName',
    'studentToken',
    'identitySource',
    'manualLoginLastSeenAt',
    'autoRegistrationPaused',
    'sharedAuthLockedSinceAt',
    STUDENT_AUTH_INVALIDATING_KEY,
    STUDENT_AUTH_COMMIT_PENDING_KEY,
    SHARED_SIGN_IN_CONFIG_CACHE_KEY,
    MANAGED_AUTH_GATE_BINDING_KEY,
  ]);
  const storedServerUrl = authStored.config?.serverUrl;
  const fastResolvedServerUrl = isHttpUrl(storedServerUrl)
    ? storedServerUrl
    : isHttpUrl(INJECTED_SERVER_URL) ? INJECTED_SERVER_URL : DEFAULT_SERVER_URL;
  const [restoredAuth] = await Promise.all([
    restoreWorkerWakeAuthState(
      authStored,
      fastResolvedServerUrl,
      workerWakeRestoreGeneration,
      { persistConfig: false },
    ),
    authGateRevisionReservationAtWake,
  ]);
  const {
    interruptedAuthClear,
    interruptedAuthCommit,
    manualAuthTimestampInvalid,
  } = restoredAuth;
  const allowUnmanagedFallback = (explicitUnmanagedDevelopment
    || isExplicitUnmanagedDevelopmentServer(fastResolvedServerUrl))
    && !authStored[MANAGED_AUTH_GATE_BINDING_KEY];
  let managedAuthBindingChanged = false;
  let managedSetupUnavailable = false;
  const applyWorkerWakeManagedPolicy = ({ config, error }, notifyAfter = false) => {
    managedAuthBindingChanged = managedPolicyConflictsWithStoredAuth(
      authStored,
      config,
      fastResolvedServerUrl,
      { allowUnmanagedFallback, managedReadFailed: Boolean(error) },
    );
    if (error) {
      managedSetupUnavailable = true;
      managedAuthGateSetupUnavailable = true;
      CONFIG.serverUrl = DEFAULT_SERVER_URL;
      CONFIG.schoolId = null;
      CONFIG.schoolSlug = null;
      CONFIG.enrollmentKey = null;
      resetSharedSignInLoginConfigCache({ clearPersisted: true });
      updateSharedSignInLoginConfig({
        phase: 'setup_required',
        fetchedAt: 0,
        retryAt: null,
        setupRequired: true,
        sharedSignInEnabled: false,
        pinLoginEnabled: false,
        schoolId: null,
        passpilotKioskAvailable: false,
        bindingKey: authGateConfigBindingKey(),
      });
    } else {
      const appliedPolicy = applyAuthoritativeManagedAuthGateSnapshot(
        config,
        authStored[MANAGED_AUTH_GATE_BINDING_KEY],
        allowUnmanagedFallback,
      );
      managedSetupUnavailable = appliedPolicy.policyIsAuthoritative
        && !appliedPolicy.descriptor.hasManagedSetup;
    }
    if (managedAuthBindingChanged && hasStudentAuth()) {
      // The locally restored token belongs to the previous managed authority.
      // Raise the auth fence before releasing the startup promise; cleanup stays
      // asynchronous so a stale profile can never briefly unlock the page.
      clearStudentAuth('managed_identity_changed_while_worker_asleep', {
        notifyBackend: false,
        localOnly: true,
        pauseAutoRegistration: true,
        disconnectWebSocket: false,
      }).catch(() => {});
      workerWakeRestoreGeneration = studentAuthMutationGeneration;
    }
    if (notifyAfter) notifyAuthGateStateToTabs({ triggerRefresh: false }).catch(() => {});
    return config;
  };
  if (allowUnmanagedFallback) {
    // Unpacked loopback development is an explicit unmanaged mode. It keeps
    // the local auth SLA and applies any real managed snapshot when available.
    if (wakePolicyGeneration === managedAuthGatePolicyGeneration) {
      applyWorkerWakeManagedPolicy({ config: {}, error: null });
      resolveWakePolicyRestore({});
    } else {
      rejectWakePolicyRestore(authMutationSuperseded('worker wake managed policy'));
    }
    managedConfigReadAtWake.then((outcome) => {
      if (wakePolicyGeneration !== managedAuthGatePolicyGeneration) return;
      applyWorkerWakeManagedPolicy(outcome, true);
    });
  } else {
    const managedOutcome = await managedConfigReadAtWake;
    if (wakePolicyGeneration === managedAuthGatePolicyGeneration) {
      const appliedConfig = applyWorkerWakeManagedPolicy(managedOutcome);
      if (managedOutcome.error) rejectWakePolicyRestore(managedOutcome.error);
      else resolveWakePolicyRestore(appliedConfig);
    } else {
      rejectWakePolicyRestore(authMutationSuperseded('worker wake managed policy'));
      await awaitManagedAuthGatePolicyStable().catch(() => {});
    }
  }
  restoreSharedSignInPresentationCache(authStored[SHARED_SIGN_IN_CONFIG_CACHE_KEY]);
  if (managedSetupUnavailable) {
    updateSharedSignInLoginConfig({
      phase: 'setup_required',
      fetchedAt: 0,
      retryAt: null,
      setupRequired: true,
      sharedSignInEnabled: false,
      pinLoginEnabled: false,
      schoolId: null,
      passpilotKioskAvailable: false,
      bindingKey: authGateConfigBindingKey(),
    });
  }
  markAuthStateRestored();
  const assertWorkerWakeCurrent = () => assertAuthMutationCurrent(
    workerWakeRestoreGeneration,
    'worker wake restore',
    {
      allowInvalidating: interruptedAuthClear
        || interruptedAuthCommit
        || manualAuthTimestampInvalid
        || managedAuthBindingChanged,
    },
  );

  // Classroom/DNR/FAB restoration can be substantially heavier than the
  // local authentication read above. It intentionally continues after the
  // auth-state promise has been released.
  const stored = await getStoredAuthState([
    'flightPathState',
    'lockScreenState',
    'licenseActive',
    'planStatus',
    'globalBlockedDomains',
    'teacherBlockListState',
    'classroomControlStateV1',
    'classroomStateFailSafeExpiryAt',
    'classroomStateStudentBindingV1',
    MONITORING_STATE_STORAGE_KEY,
    MONITORING_EVENT_OUTBOX_KEY,
    CONNECTIVITY_HEALTH_STORAGE_KEY,
    SCREENSHOT_HEALTH_STORAGE_KEY,
    FAB_STATE_STORAGE_KEY,
    FAB_CONTEXT_STORAGE_KEY,
    CLASSROOM_OVERLAY_STORAGE_KEY,
    COMMAND_ACK_OUTBOX_KEY,
    COMMAND_ACK_BINDING_KEY,
    CHAT_ACK_OUTBOX_KEY,
    CHAT_ACK_BINDING_KEY,
    TAB_SNAPSHOT_STORAGE_KEY,
    STUDENT_AUTH_INVALIDATING_KEY,
    SHARED_SIGN_IN_CONFIG_CACHE_KEY,
  ]);
  // The authoritative managed snapshot above has already selected or reset
  // the endpoint. Re-running the legacy fallback resolver here could resurrect
  // a stale locally persisted URL after policy removal or malformed input.
  const resolvedServerUrl = isHttpUrl(CONFIG.serverUrl)
    ? CONFIG.serverUrl
    : DEFAULT_SERVER_URL;
  assertWorkerWakeCurrent();
  CONFIG.serverUrl = resolvedServerUrl;
  scheduleLicenseCheck();
  const storedMonitoringState = stored[MONITORING_STATE_STORAGE_KEY];
  if (
    storedMonitoringState
    && Object.values(TRACKING_STATES).includes(storedMonitoringState.state)
    && Number.isFinite(Number(storedMonitoringState.changedAt))
  ) {
    persistedMonitoringState = {
      state: storedMonitoringState.state,
      changedAt: Number(storedMonitoringState.changedAt),
      reason: typeof storedMonitoringState.reason === 'string'
        ? storedMonitoringState.reason.slice(0, 80)
        : 'restored',
    };
  }
  connectivityHealth = RuntimeCore.normalizeConnectivityHealth(
    stored[CONNECTIVITY_HEALTH_STORAGE_KEY]
  );
  screenshotHealth = RuntimeCore.normalizeScreenshotHealth(
    stored[SCREENSHOT_HEALTH_STORAGE_KEY]
  );
  syncScreenshotHealthGlobals();
  assertWorkerWakeCurrent();
  await reconcileMessageInboxIdentity('worker-wake');
  assertWorkerWakeCurrent();
  if (stored[FAB_CONTEXT_STORAGE_KEY]?.binding === fabIdentityBinding()) {
    currentFabState = normalizeFabState(stored[FAB_STATE_STORAGE_KEY] || {});
    scheduleClassroomOverlayExpiry(stored[CLASSROOM_OVERLAY_STORAGE_KEY]);
  } else if (stored[FAB_STATE_STORAGE_KEY] || stored[CLASSROOM_OVERLAY_STORAGE_KEY]) {
    await clearFabAndOverlayState('worker-identity-reconcile', { closeChat: true });
  }
  if (Array.isArray(stored[COMMAND_ACK_OUTBOX_KEY]) && stored[COMMAND_ACK_OUTBOX_KEY].length > 0) {
    scheduleCommandAckFlush();
  }
  if (Array.isArray(stored[CHAT_ACK_OUTBOX_KEY]) && stored[CHAT_ACK_OUTBOX_KEY].length > 0) {
    scheduleChatAckFlush();
  }
  if (stored[TAB_SNAPSHOT_STORAGE_KEY]?.binding === tabSnapshotAuthBinding()) {
    currentTabSnapshotRevision = Number(stored[TAB_SNAPSHOT_STORAGE_KEY].revision || 0);
  }

  // Load school policy into memory first. The classroom-state composer will
  // include it in the same atomic DNR update without allowing the two ranges
  // to erase one another.
  try {
    if (!Object.prototype.hasOwnProperty.call(stored, 'globalBlockedDomains')) {
      throw new Error('Stored school block list is unavailable');
    }
    globalBlockedDomains = RuntimeCore.normalizeDomainList(
      stored.globalBlockedDomains,
      'school block list'
    );
    globalBlockedDomainsStateTrusted = true;
  } catch (error) {
    globalBlockedDomainsStateTrusted = false;
    console.warn('[Service Worker] Stored school block list is invalid; retaining existing Chrome rules');
  }

  assertWorkerWakeCurrent();
  if (stored[CLASSROOM_STATE_STORAGE_KEY]) {
    try {
      await applyClassroomState(stored[CLASSROOM_STATE_STORAGE_KEY], { force: true, reason: 'worker_wake' });
      console.log('[Service Worker] Restored revisioned classroom state');
    } catch (error) {
      // DNR rules survive an MV3 worker restart. If storage is corrupt, do not
      // clear those rules; request the authoritative server snapshot instead.
      // A separately stored deadline still prevents orphaned rules from
      // surviving forever if the server remains unreachable.
      const storedFailSafeExpiryAt = Number(stored.classroomStateFailSafeExpiryAt);
      const failSafeExpiryAt = Number.isFinite(storedFailSafeExpiryAt) && storedFailSafeExpiryAt > 0
        ? storedFailSafeExpiryAt
        : Date.now();
      await kv.set({ classroomStateFailSafeExpiryAt: failSafeExpiryAt });
      if (failSafeExpiryAt > Date.now()) {
        chrome.alarms.create(CLASSROOM_STATE_EXPIRY_ALARM, { when: failSafeExpiryAt });
      } else {
        // Never invent a fresh twelve-hour window when the independently
        // stored original cutoff is missing or already elapsed.
        await checkClassroomStateExpiry();
        await kv.remove(CLASSROOM_STATE_STORAGE_KEY);
      }
      console.warn('[Service Worker] Stored classroom state is invalid; existing rules retained:', error?.message || error);
    }
  } else if (stored.flightPathState || stored.lockScreenState || stored.teacherBlockListState) {
    // One-time migration for controls persisted by older extension versions.
    const legacyTimestamp = Number(
      stored.flightPathState?.timestamp || stored.lockScreenState?.timestamp || Date.now()
    );
    const legacyState = {
      schemaVersion: 1,
      revision: 0,
      receivedAt: legacyTimestamp,
      hardExpiresAt: legacyTimestamp + RuntimeCore.CLASSROOM_STATE_MAX_LIFETIME_MS,
      restrictions: {
        screenLock: stored.lockScreenState ? {
          active: true,
          url: stored.lockScreenState.lockedUrl,
          domain: stored.lockScreenState.lockedDomain,
        } : { active: false },
        flightPath: stored.flightPathState ? {
          active: true,
          allowedDomains: stored.flightPathState.allowedDomains,
          name: stored.flightPathState.activeFlightPathName,
        } : { active: false },
        blockList: stored.teacherBlockListState ? {
          active: true,
          blockedDomains: stored.teacherBlockListState.blockedDomains,
          name: stored.teacherBlockListState.name,
        } : { active: false },
      },
    };
    try {
      await applyClassroomState(legacyState, { force: true, reason: 'legacy_migration' });
      console.log('[Service Worker] Migrated legacy classroom restrictions');
    } catch (error) {
      console.warn('[Service Worker] Legacy classroom state could not be restored:', error?.message || error);
    }
  } else {
    // No teacher state is known. Reconcile only the school range; never clear
    // teacher ranges merely because the worker was restarted.
    if (globalBlockedDomainsStateTrusted) {
      await updateGlobalBlacklistRules(globalBlockedDomains).catch((error) => {
        console.warn('[Service Worker] School block list restore failed:', error?.message || error);
      });
    }
  }
  assertWorkerWakeCurrent();

  console.log('[Service Worker] State restored:', {
    deviceId: CONFIG.deviceId,
    studentEmail: CONFIG.studentEmail,
    flightPathActive: allowedDomains.length > 0,
    screenLocked: screenLocked,
    globalBlockedDomains: globalBlockedDomains.length,
    teacherBlockedDomains: teacherBlockedDomains.length,
    classroomRevision: currentClassroomState?.revision ?? 0,
  });
  markClassroomStateRestored();

  if (interruptedAuthClear || interruptedAuthCommit || manualAuthTimestampInvalid) {
    assertWorkerWakeCurrent();
    const recoveryReason = interruptedAuthCommit
      ? 'interrupted-auth-commit'
      : manualAuthTimestampInvalid
        ? 'manual-login-timestamp-invalid'
        : 'interrupted-auth-clear';
    await clearStudentAuth(
      recoveryReason,
      {
      notifyBackend: false,
      pauseAutoRegistration: true,
      },
    );
    await setConnectivityBadge(connectivityStatus());
    return;
  }

  if (stored.licenseActive === false) {
    assertWorkerWakeCurrent();
    await disableForInactiveLicense(stored.planStatus);
  }

  assertWorkerWakeCurrent();
  await ensureRegistered();
  scheduleMonitoringEventFlush(1000);
  requestClassroomStateSync('worker-wake', true);
  await setConnectivityBadge(connectivityStatus());
  await scheduleConnectivityHealthBoundary();

  // Initialize adaptive tracking after state is restored
  scheduleJitteredStartup('wake', () => {
    console.log('[Service Worker] Initializing adaptive tracking...');
    initializeAdaptiveTracking('wake').catch(() => {});
  });
})().catch(err => {
  // Silently handle wake-up errors (network issues, server deploys)
  // The extension will self-heal via alarms and retries
  console.warn('[Service Worker] Wake-up error (will retry):', err?.message || err);
  if (studentAuthCommitPending) failAuthCommitRecoveryBarrier(err);
}).finally(() => {
  if (authGateRevisionReady) markAuthStateRestored();
  markClassroomStateRestored();
});

// Centralized, safe notifications (never throw, never produce red errors)
async function safeNotify(opts) {
  // If notifications permission is missing or blocked, silently skip
  if (!chrome?.notifications) return;

  // Required defaults
  const options = {
    type: 'basic',
    iconUrl: 'icons/icon48.png',
    title: 'ClassPilot',
    message: '',
    priority: 0,
    ...opts, // allow caller to override title/message/iconUrl if needed
  };

  try {
    // In MV3, callbacks can surface runtime.lastError; prefer Promises
    await new Promise((resolve) => {
      chrome.notifications.create('', options, () => {
        // swallow runtime.lastError quietly
        void chrome.runtime.lastError;
        resolve();
      });
    });
  } catch (e) {
    // Never use console.warn for expected conditions; keep the Errors panel clean
    console.warn('notify skipped:', e?.message || e);
  }
}

// Declarative Net Request rules are composed through one serialized writer.
// Each feature owns a half-open ID range, so changing teacher controls cannot
// erase school policy or unrelated extension rules.
let dynamicRuleCompositionTail = Promise.resolve();

function runtimeClassroomStateForRules() {
  return {
    restrictions: {
      screenLock: { active: screenLocked, url: lockedUrl, domain: lockedDomain },
      flightPath: { active: allowedDomains.length > 0, allowedDomains },
      blockList: { active: teacherBlockedDomains.length > 0, blockedDomains: teacherBlockedDomains },
      attentionMode: { active: attentionModeActive },
      temporaryAllows: temporaryAllowedDomains,
    },
  };
}

function composeDynamicRules(rangeNames) {
  const requestedRanges = [...new Set(rangeNames)].filter((name) => RuntimeCore.DNR_RANGES[name]);
  if (requestedRanges.length === 0) return Promise.resolve();

  const run = async () => {
    // Validate and build before changing Chrome state. Oversized or malformed
    // lists therefore leave the previous complete ruleset intact.
    const addRules = RuntimeCore.buildDnrRules({
      classroomState: runtimeClassroomStateForRules(),
      globalBlockedDomains,
    }, requestedRanges, Date.now());
    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    const removeRuleIds = existingRules
      .filter((rule) => requestedRanges.some((range) => RuntimeCore.isRuleInRange(rule.id, range)))
      .map((rule) => rule.id);
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  };

  dynamicRuleCompositionTail = dynamicRuleCompositionTail.then(run, run);
  return dynamicRuleCompositionTail;
}

async function updateBlockingRules(requestedAllowedDomains) {
  RuntimeCore.normalizeDomainList(requestedAllowedDomains, 'classroom allowed domains');
  await composeDynamicRules(['classroom']);
}

async function clearBlockingRules() {
  await composeDynamicRules(['classroom']);
}

async function clearClassroomBlockingRule() {
  await composeDynamicRules(['classroom']);
}

async function updateGlobalBlacklistRules(blockedDomains) {
  const previous = globalBlockedDomains;
  const previousTrusted = globalBlockedDomainsStateTrusted;
  const normalized = RuntimeCore.normalizeDomainList(blockedDomains, 'school block list');
  globalBlockedDomains = normalized;
  globalBlockedDomainsStateTrusted = true;
  try {
    await composeDynamicRules(['school']);
  } catch (error) {
    globalBlockedDomains = previous;
    globalBlockedDomainsStateTrusted = previousTrusted;
    throw error;
  }
}

async function updateTeacherBlockListRules(blockedDomains) {
  const previous = teacherBlockedDomains;
  const normalized = RuntimeCore.normalizeDomainList(blockedDomains, 'teacher block list');
  teacherBlockedDomains = normalized;
  try {
    await composeDynamicRules(['teacher']);
  } catch (error) {
    teacherBlockedDomains = previous;
    throw error;
  }
}

async function clearTeacherBlockListRules() {
  const previous = teacherBlockedDomains;
  teacherBlockedDomains = [];
  try {
    await composeDynamicRules(['teacher']);
  } catch (error) {
    teacherBlockedDomains = previous;
    throw error;
  }
}

async function updateTemporaryAllowRules(temporaryAllows) {
  const previous = temporaryAllowedDomains;
  const normalized = RuntimeCore.normalizeTemporaryAllows(temporaryAllows, Date.now());
  temporaryAllowedDomains = normalized;
  try {
    await composeDynamicRules(['temporary']);
  } catch (error) {
    temporaryAllowedDomains = previous;
    throw error;
  }
}

async function composeAllManagedDynamicRules() {
  const ranges = ['classroom', 'teacher', 'temporary'];
  // A malformed local school-policy snapshot must not turn an unrelated
  // classroom-state restore into authority to delete DNR rules that survived
  // the worker restart. Only an explicitly validated policy may replace them.
  if (globalBlockedDomainsStateTrusted) ranges.push('school');
  await composeDynamicRules(ranges);
}

// Get logged-in Chromebook user info using Chrome Identity API
async function getLoggedInUserInfo() {
  try {
    const email = await detectChromeProfileEmail();
    return {
      email: email || null,
      id: null,
    };
  } catch (error) {
    console.warn('Error getting logged-in user info:', error);
    return { email: null, id: null };
  }
}

// Auto-detect and register student based on Chromebook login
async function autoDetectAndRegister() {
  assertChromeProfileRegistrationAllowed('student auto-detection');
  applyManagedSchoolConfig(await readManagedConfig());
  const authPause = await chrome.storage.local.get(['autoRegistrationPaused']);
  if (authPause.autoRegistrationPaused) {
    console.log('[Auth] Auto-detect registration paused until manual sign-in');
    await notifyAuthGateStateToTabs();
    return;
  }

  const userInfo = await getLoggedInUserInfo();
  assertChromeProfileRegistrationAllowed('student auto-detection');
  
  if (userInfo.email) {
    console.log('Auto-detected student email:', userInfo.email);
    
    // Extract name from email (e.g., john.smith@school.edu -> john.smith)
    const emailName = userInfo.email.split('@')[0];
    const displayName = emailName.replace(/\./g, ' ').replace(/\b\w/g, l => l.toUpperCase());
    
    const normalizedEmail = normalizeEmail(userInfo.email);
    CONFIG.studentEmail = normalizedEmail;
    CONFIG.studentName = displayName;
    
    await chrome.storage.local.set({ 
      studentEmail: normalizedEmail,
      studentName: displayName,
    });
    
    // Auto-register if not already registered or if the Chrome profile changed.
    const stored = await chrome.storage.local.get(['registered', 'lastRegisteredEmail', 'studentEmail', 'identitySource']);
    const emailChanged = stored.lastRegisteredEmail && stored.lastRegisteredEmail !== normalizedEmail;
    if (emailChanged && !isManualIdentitySource(stored.identitySource)) {
      await clearStudentAuth('chrome-profile-email-changed', { notifyBackend: true });
    }
    if (!stored.registered || emailChanged) {
      try {
        // Get or create device ID
        const deviceId = await getOrCreateDeviceId();
        
        // Register with auto-detected info
        await registerDeviceWithStudent(deviceId, null, 'default-class', normalizedEmail, displayName);
        console.log('Auto-registered student:', normalizedEmail);
      } catch (error) {
        console.warn('Auto-registration failed:', error);
      }
    }
  } else {
    console.warn('Could not detect logged-in user email - manual registration required');
  }
}

if (chrome.identity?.onSignInChanged) {
  chrome.identity.onSignInChanged.addListener(async () => {
    try {
      if (!CONFIG.autoRegistrationPaused && !isManualIdentitySource(CONFIG.identitySource)) {
        await refreshRegistrationAfterIdentityChange();
        await notifyAuthGateStateToTabs();
      }
    } catch (error) {
      console.warn('[Auth] Failed to refresh registration after Chrome sign-in change:', error?.message || error);
    }
  });
}

// Generate unique device ID if not exists
async function getOrCreateDeviceId() {
  const stored = await chrome.storage.local.get(['deviceId']);
  if (stored.deviceId) {
    return stored.deviceId;
  }
  
  const deviceId = 'device-' + Math.random().toString(36).substring(2, 15);
  await chrome.storage.local.set({ deviceId });
  return deviceId;
}

// Register device with server
async function registerDevice(deviceId, deviceName, classId) {
  // Use provided deviceId or generate new one
  if (!deviceId) {
    deviceId = await getOrCreateDeviceId();
  } else {
    // Save the provided deviceId
    await chrome.storage.local.set({ deviceId });
  }
  
  try {
    const response = await fetchWithBackoff(`${CONFIG.serverUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId,
        deviceName, // Device name instead of student name
        classId,
      }),
    }, {
      context: 'legacy device registration',
      maxAttempts: 1,
    });
    
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw buildResponseError(response, errorData, 'Registration failed');
    }
    
    const data = await response.json();
    console.log('Device registered:', data);
    
    // Save config (using deviceName as studentName for now)
    CONFIG.deviceId = deviceId;
    CONFIG.studentName = deviceName; // Display device name until teacher assigns student
    CONFIG.classId = classId;
    
    await chrome.storage.local.set({ 
      config: persistedNonAuthConfig(CONFIG),
      registered: true,
    });
    
    return data;
  } catch (error) {
    console.warn('Registration error:', error);
    throw error;
  }
}

// Register device with student email auto-detection
function registerDeviceWithStudent(deviceId, deviceName, classId, studentEmail, studentName) {
  return runChromeProfileRegistration(() => registerDeviceWithStudentNow(
    deviceId,
    deviceName,
    classId,
    studentEmail,
    studentName,
  ));
}

async function registerDeviceWithStudentNow(deviceId, deviceName, classId, studentEmail, studentName) {
  assertChromeProfileRegistrationAllowed('student auto-registration');
  const registrationGeneration = studentAuthMutationGeneration;
  assertAuthMutationCurrent(registrationGeneration, 'student auto-registration');
  // Use provided deviceId or generate new one
  if (!deviceId) {
    deviceId = await getOrCreateDeviceId();
  } else {
    // Save the provided deviceId
    await chrome.storage.local.set({ deviceId });
  }
  
  try {
    const response = await fetchWithBackoff(`${CONFIG.serverUrl}/api/extension/register`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(CONFIG.enrollmentKey ? { 'X-ClassPilot-Enrollment-Key': CONFIG.enrollmentKey } : {}),
      },
      body: JSON.stringify({
        deviceId,
        deviceName,
        classId,
        studentEmail,
        studentName,
        schoolId: CONFIG.schoolId || undefined,
        schoolSlug: CONFIG.schoolSlug || undefined,
        enrollmentKey: CONFIG.enrollmentKey || undefined,
        ...extensionProtocolDescriptor(),
      }),
    }, {
      context: 'student registration',
      maxAttempts: 1,
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      throw buildResponseError(response, errorData, 'Student registration failed');
    }
    
    const data = await response.json();
    console.log('Student auto-registered:', data);
    const studentId = String(data.student?.id || '').trim() || null;
    const studentSessionId = String(
      data.studentSessionId || data.fab?.studentSessionId || ''
    ).trim() || null;
    const authenticatedSchoolId = String(
      data.schoolId || data.student?.schoolId || ''
    ).trim() || null;
    if (!data.studentToken || !studentId || !studentSessionId) {
      throw new Error('Student registration omitted the exact authenticated binding');
    }
    await enqueueStudentAuthMutation(async () => {
      assertAuthMutationCurrent(registrationGeneration, 'student auto-registration');
      await beginStudentAuthCommit(
        registrationGeneration,
        'student auto-registration commit',
      );
      const persistedConfig = persistedNonAuthConfig({
        ...CONFIG,
        deviceId,
        classId,
        ...(authenticatedSchoolId ? { schoolId: authenticatedSchoolId } : {}),
      });
      await durableLocalKv.set({
        config: persistedConfig,
        registered: true,
        activeStudentId: studentId,
        activeStudentSessionId: studentSessionId,
        studentToken: data.studentToken,
        lastRegisteredEmail: studentEmail,
        identitySource: 'chrome_profile',
        manualLoginLastSeenAt: null,
        autoRegistrationPaused: false,
        [STUDENT_AUTH_INVALIDATING_KEY]: null,
      });
      assertAuthMutationCurrent(registrationGeneration, 'student auto-registration');
      CONFIG.deviceId = deviceId;
      CONFIG.studentName = studentName;
      CONFIG.studentEmail = studentEmail;
      CONFIG.classId = classId;
      CONFIG.activeStudentId = studentId;
      CONFIG.activeStudentSessionId = studentSessionId;
      CONFIG.studentToken = data.studentToken;
      CONFIG.identitySource = 'chrome_profile';
      if (authenticatedSchoolId) CONFIG.schoolId = authenticatedSchoolId;
      CONFIG.manualLoginLastSeenAt = null;
      CONFIG.autoRegistrationPaused = false;
      studentAuthInvalidating = false;
      resetSharedSignInLoginConfigCache({ clearPersisted: true });
      await reconcileMessageInboxIdentity('student-registration');
      await applyClassroomStateFromAuthResponse(
        data,
        'student_registration',
        { requireApplied: true },
      );
      assertAuthMutationCurrent(registrationGeneration, 'student auto-registration');
      await completeStudentAuthCommit(
        registrationGeneration,
        'student auto-registration commit',
      );
    });
    
    // Start adaptive tracking after registration
    initializeAdaptiveTracking('student-registered');
    
    return data;
  } catch (error) {
    if (studentAuthCommitPendingGeneration === registrationGeneration) {
      try {
        await clearStudentAuth('student_auto_registration_commit_failed', {
          notifyBackend: false,
          localOnly: true,
          pauseAutoRegistration: false,
        });
      } catch (cleanupError) {
        failAuthCommitRecoveryBarrier(cleanupError);
        console.warn(
          '[Auth] Failed student auto-registration commit cleanup:',
          cleanupError?.message || cleanupError,
        );
      }
    }
    console.warn('Student registration error:', error);
    throw error;
  }
}

// Send heartbeat with current tab info
async function sendHeartbeat(reason = 'manual') {
  await classroomStateRestorePromise;
  if (!licenseActive) {
    return;
  }
  if (trackingState === TRACKING_STATES.OFF) {
    return;
  }
  if (await expireManualAuthIfStale(`heartbeat:${reason}`)) {
    return;
  }
  if (!hasStudentAuth()) {
    console.log('Skipping heartbeat - student authentication required');
    await notifyAuthGateStateToTabs();
    return;
  }
  
  if (!CONFIG.deviceId) {
    console.log('Skipping heartbeat - no deviceId');
    return;
  }

  let heartbeatRequestStarted = false;
  let heartbeatResponseReceived = false;

  try {
    // Get the active tab from the LAST FOCUSED window (the one the user is actually looking at)
    // Service workers don't have a "current window", so we must query for lastFocusedWindow
    let tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });

    // Determine tab data or use fallback for "no active tab" state
    // IMPORTANT: Use empty strings instead of null for Zod schema validation
    let activeTabUrl = '';
    let activeTabTitle = '';
    let activeTabId = null;
    let activeTabRef = null;
    let favicon = null;

    // Get the active tab from the focused window
    if (tabs.length >= 1) {
      // Find first tab with HTTP URL (should normally be just one tab from focused window)
      const httpTab = tabs.find(t => t.url && t.url.startsWith('http'));
      if (httpTab) {
        activeTabUrl = httpTab.url;
        activeTabTitle = httpTab.title || '';
        activeTabId = httpTab.id ?? null;
        favicon = httpTab.favIconUrl || null;
      }
      // Otherwise keep empty strings (Chrome internal pages only = no monitored activity)
    }
    // If tabs.length === 0, keep empty strings (no focused window or all windows minimized)
    
    const isObservedHeartbeat = reason.startsWith('observed');
    const now = Date.now();
    const observedSignature = `${activeTabUrl}|${activeTabTitle}|${activeTabId ?? 'none'}`;

    if (
      isObservedHeartbeat &&
      observedSignature === lastObservedSignature &&
      now - lastObservedSentAt < OBSERVED_HEARTBEAT_SECONDS * 1000
    ) {
      return;
    }

    // Collect ALL open tabs for teacher dashboard
    // Use caching to prevent flickering when chrome.tabs.query returns inconsistent results
    let allOpenTabs = [];
    let tabSnapshotRevision = currentTabSnapshotRevision;
    try {
      const allTabs = await chrome.tabs.query({});
      const httpTabs = allTabs.filter(tab => tab.url && tab.url.startsWith('http'));
      const tabSnapshot = await buildOpaqueTabSnapshot(httpTabs);
      allOpenTabs = tabSnapshot.tabs;
      tabSnapshotRevision = tabSnapshot.revision;
      activeTabRef = tabSnapshot.localEntries.find((entry) => entry.tabId === activeTabId)?.tabRef || null;
      lastKnownTabs = allOpenTabs;
    } catch (error) {
      console.warn('[Heartbeat] Failed to collect tabs:', error);
      // Use cached tabs on error to prevent flickering
      if (lastKnownTabs.length > 0) {
        allOpenTabs = lastKnownTabs;
        console.log(`[Heartbeat] Using cached ${lastKnownTabs.length} tabs after error`);
      }
    }
    
    // Send heartbeat even without active tab (keeps student "online")
    // Server will display "No active tab" when title/URL are empty strings
    const heartbeatData = {
      studentEmail: CONFIG.studentEmail || '', // JWT is the authority for manual shared-device login
      deviceId: CONFIG.deviceId,            // Internal device tracking
      activeTabTitle: activeTabTitle,       // '' = no monitored tab
      activeTabUrl: activeTabUrl,           // '' = no monitored tab
      favicon: favicon,
      allOpenTabs: allOpenTabs,             // 🆕 ALL tabs (in-memory only, not persisted)
      activeTabRef,
      tabSnapshotRevision,
      tabSnapshot: {
        schemaVersion: 1,
        revision: tabSnapshotRevision,
      },
      screenLocked: screenLockIsActive(),
      flightPathActive: flightPathIsActive(),
      activeFlightPathName: activeFlightPathName,
      isSharing: false,
      cameraActive: cameraActive,
      status: trackingState.toLowerCase(),
      ...extensionProtocolDescriptor(),
      chromeVersion: currentChromiumVersion(),
      classroomStateRevision: currentClassroomState?.revision ?? 0,
      appliedClassroomStateRevision: lastClassroomStateAckRevision || currentClassroomState?.revision || 0,
      classroomStateOutcome: lastClassroomStateOutcome,
      classroomStateSessionId: currentClassroomState?.teachingSessionId || undefined,
      classroomStateSupervisionContextId: currentClassroomState?.supervisionContextId || undefined,
      requestClassroomState: requestClassroomStateOnHeartbeat(),
      fabStateRevision: currentFabState?.revision ?? 0,
      requestFabState: requestFabStateOnHeartbeat(),
      // Screenshot health diagnostics (helps dashboard show why screenshots may be missing)
      screenshotHealth: {
        lastAttemptAt: lastScreenshotAttemptAt,
        lastSuccessAt: lastScreenshotSuccessAt,
        lastErrorAt: lastScreenshotErrorAt,
        lastError: lastScreenshotError,
        lastErrorCode: lastScreenshotError,
        attempts: screenshotAttemptCount,
        successes: screenshotSuccessCount,
        alarmActive: screenshotScheduled,
      },
    };
    
    const headers = buildDeviceAuthHeaders();
    const heartbeatMessageBinding = messageInboxAuthBinding();
    const heartbeatAuthResponseGuard = captureAuthenticatedResponseGuard();
    attachLegacyStudentToken(heartbeatData, headers);
    if (headers.Authorization) {
      console.log('Sending JWT-authenticated heartbeat');
    } else {
      console.log('⚠️  Sending legacy heartbeat (no JWT)');
    }

    if (isObservedHeartbeat) {
      lastObservedSignature = observedSignature;
      lastObservedSentAt = now;
    }
    
    heartbeatRequestStarted = true;
    const response = await fetchWithBackoff(`${CONFIG.serverUrl}/api/device/heartbeat`, {
      method: 'POST',
      headers,
      body: JSON.stringify(heartbeatData),
    }, {
      context: 'device heartbeat',
      maxAttempts: 2,
    });
    heartbeatResponseReceived = true;

    const currentHeartbeatBinding = messageInboxAuthBinding();
    if (heartbeatMessageBinding && heartbeatMessageBinding !== currentHeartbeatBinding) {
      // Authentication changed while this request was in flight. Every field
      // in the response belongs to the earlier student/session, including
      // classroom controls, connectivity success, and pending messages.
      console.warn('[Heartbeat] Ignoring response for a retired student/session binding');
      if (currentHeartbeatBinding) {
        lastClassroomHeartbeatSyncRequestAt = 0;
        lastFabHeartbeatSyncRequestAt = 0;
        requestClassroomStateSync('heartbeat-identity-changed', true);
        // safeSendHeartbeat is still marked in flight until this call returns.
        // Queue the new identity's authoritative heartbeat for the next task.
        setTimeout(() => safeSendHeartbeat('identity-changed-reconcile'), 0);
      }
      return;
    }

    if (response.status === 402) {
      const data = await response.json().catch(() => ({}));
      await disableForInactiveLicense(data.planStatus);
      return;
    } else if (response.status === 409) {
      const data = await response.json().catch(() => ({}));
      if (data?.error === 'student_session_replaced') {
        console.warn('[Auth] Student session was replaced on another Chromebook');
        await clearStudentAuth('session-replaced', { notifyBackend: false, pauseAutoRegistration: true });
        return;
      }
      console.warn('Heartbeat conflict:', data?.error || response.status);
      return;
    } else if (response.status === 401 || response.status === 403) {
      const data = await response.json().catch(() => ({}));
      if (isClassPilotNotEntitledResponse(data)) {
        await disableForInactiveLicense(data.planStatus);
        return;
      }
      if (isManualIdentitySource()) {
        // 2.6.8: a server-invalidated manual session (teacher signed the
        // student out server-side, session replaced) must not leave
        // auto-registration enabled — that re-signed the student in on the
        // next worker wake.
        await clearStudentAuth('manual-token-invalid', { notifyBackend: false, pauseAutoRegistration: true });
        return;
      }
      // ✅ JWT INVALID/EXPIRED: Token expired (401) or invalid (403) - need to re-register
      console.warn(`❌ [JWT] Token ${response.status === 401 ? 'expired' : 'invalid'} (${response.status}) - clearing token and re-registering`);
      await clearStudentMessageState('student-token-invalid');
      await durableLocalKv.set({ studentToken: null, registered: false });
      if (hasSessionStorage()) await durableSessionKv.remove(['studentToken']);
      CONFIG.studentToken = null;
      // Trigger re-registration with backoff (shares retry counter with registration)
      registrationRetryCount++;
      if (registrationRetryCount <= MAX_REGISTRATION_RETRIES) {
        const backoff = Math.min(5000 * Math.pow(2, registrationRetryCount - 1), 300000);
        setTimeout(() => ensureRegistered().catch(() => {}), backoff);
      }
      return; // Skip rest of error handling
    } else if (response.status === 408 || response.status >= 500) {
      await recordHeartbeatFailure('server_unavailable');
      console.warn('Heartbeat server responded:', response.status);
    } else if (response.ok) {
      await recordHeartbeatSuccess();
      if (isManualIdentitySource()) {
        CONFIG.manualLoginLastSeenAt = Date.now();
        await setManualAuthState({ manualLoginLastSeenAt: CONFIG.manualLoginLastSeenAt });
      }
      // Ensure screenshot alarm is running after every successful heartbeat
      // This recovers from cases where the alarm was lost (SW restart, Chrome killed it)
      if (!screenshotScheduled && (trackingState === TRACKING_STATES.ACTIVE || trackingState === TRACKING_STATES.IDLE)) {
        console.log('[Screenshot] Recovering lost screenshot alarm after heartbeat');
        scheduleScreenshotCapture(true);
      }
      // Check for pending messages missed during WebSocket disconnection
      try {
        const data = await response.json();
        await adoptAuthenticatedStudentBinding(
          data,
          'heartbeat response',
          heartbeatAuthResponseGuard,
        );
        await applyClassroomStateFromAuthResponse(data, 'heartbeat_reconcile');
        if (Object.prototype.hasOwnProperty.call(data, 'fab')) {
          await applyFabSettings(data.fab || {}, {
            reason: 'heartbeat-reconcile',
            broadcast: true,
          });
        }
        if (Array.isArray(data.pendingMessages) && data.pendingMessages.length > 0) {
          const inboxResult = await handleHeartbeatPendingMessages(
            data.pendingMessages,
            heartbeatMessageBinding
          );
          if (inboxResult.addedMessageIds.length > 0) {
            console.log('[Heartbeat] Stored new pending messages:', inboxResult.addedMessageIds.length);
          }
        }
      } catch { /* response may not be JSON in some edge cases */ }
    } else {
      // Client error (400s) - log but don't retry
      console.warn('Heartbeat client error:', response.status);
    }
    
  } catch (error) {
    if (heartbeatRequestStarted && !heartbeatResponseReceived) {
      await recordHeartbeatFailure('network_error').catch(() => {});
    }
    // This means only that the school server could not be reached. It is not
    // evidence that Wi-Fi was intentionally disabled or that a student acted.
    console.warn('Heartbeat network issue:', error?.message || error);
  }
}

// Health check: refreshes tracking state after service worker restarts
async function healthCheck() {
  console.log('[Health Check] Running...');
  if (!CONFIG.deviceId) {
    console.log('[Health Check] No deviceId - extension not yet configured');
    return;
  }
  await refreshSchoolSettings({ force: false });
  await updateTrackingState('health-check');
  await setConnectivityBadge(connectivityStatus());
  await scheduleConnectivityHealthBoundary();

  const heartbeatAlarm = await chrome.alarms.get('heartbeat');
  if (trackingState === TRACKING_STATES.ACTIVE && !heartbeatAlarm) {
    scheduleHeartbeat(HEARTBEAT_ACTIVE_MINUTES);
  } else if (trackingState === TRACKING_STATES.IDLE && !heartbeatAlarm) {
    scheduleHeartbeat(HEARTBEAT_IDLE_MINUTES);
  } else if (trackingState === TRACKING_STATES.OFF && heartbeatAlarm) {
    scheduleHeartbeat(null);
  }

  const screenshotAlarm = await chrome.alarms.get(SCREENSHOT_ALARM_NAME);
  screenshotScheduled = Boolean(screenshotAlarm);
  // Re-schedule screenshot capture if alarm was lost after service worker restart
  if ((trackingState === TRACKING_STATES.ACTIVE || trackingState === TRACKING_STATES.IDLE) && !screenshotAlarm) {
    scheduleScreenshotCapture(true);
  }

  // Reconnect WebSocket if lost (e.g. after service worker restart where ws is null but tracking is still ACTIVE)
  if ((trackingState === TRACKING_STATES.ACTIVE || trackingState === TRACKING_STATES.IDLE) && !wsConnected) {
    console.log('[Health Check] WebSocket not connected, reconnecting...');
    connectWebSocket().catch(() => {});
  }

  console.log('[Health Check] Complete - tracking state checked');
}

// Alarm listener for heartbeat and WebSocket reconnection
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'heartbeat') {
    safeSendHeartbeat('alarm');
    // Re-schedule screenshot alarm if lost after service worker restart
    if ((trackingState === TRACKING_STATES.ACTIVE || trackingState === TRACKING_STATES.IDLE) && !screenshotScheduled) {
      scheduleScreenshotCapture(true);
    }
  } else if (alarm.name === 'ws-reconnect') {
    // WebSocket reconnection alarm - reliable even if service worker was terminated
    console.log('WebSocket reconnection alarm triggered');
    connectWebSocket().catch(() => {});
  } else if (alarm.name === HEALTH_CHECK_ALARM_NAME) {
    // Periodic health check to ensure heartbeat and WebSocket are running
    // This recovers from service worker restarts without needing manual reload
    healthCheck().catch(() => {});
  } else if (alarm.name === CONNECTIVITY_HEALTH_ALARM_NAME) {
    classroomStateRestorePromise.then(() => setConnectivityBadge(connectivityStatus(Date.now(), {
      allowPersistedMonitoring: true,
    }))).catch(() => {});
  } else if (alarm.name === 'wake-up') {
    loadCachedSchoolSettings().then(() => {
      updateTrackingState('wake-up');
    }).catch(() => {});
  } else if (alarm.name === 'settings-refresh') {
    refreshSchoolSettings({ force: false }).then(() => {
      updateTrackingState('settings-refresh');
    }).catch(() => {});
  } else if (alarm.name === 'license-check') {
    checkLicenseStatus('alarm').catch(() => {});
  } else if (alarm.name === LICENSE_CONTROL_CLEANUP_ALARM) {
    kv.get(['planStatus']).then((stored) => (
      disableForInactiveLicense(stored.planStatus)
    )).catch(() => {
      chrome.alarms.create(LICENSE_CONTROL_CLEANUP_ALARM, {
        when: Date.now() + LICENSE_CONTROL_CLEANUP_RETRY_MS,
      });
    });
  } else if (alarm.name === SHARED_SIGN_IN_CONFIG_RETRY_ALARM) {
    authStateRestorePromise.then(() => {
      if (!fastAuthGateEnabled || hasStudentAuth()) {
        clearSharedSignInConfigRetry();
        return;
      }
      refreshSharedSignInLoginConfig({ force: true, reason: 'retry_alarm' }).catch(() => {});
    }).catch(() => {});
  } else if (alarm.name === SHARED_AUTH_LOCK_ALARM_NAME) {
    handleSharedAuthLockTimeout().catch(() => {});
  } else if (alarm.name === CLASSROOM_STATE_EXPIRY_ALARM) {
    classroomStateRestorePromise.then(() => checkClassroomStateExpiry()).catch((error) => {
      console.warn('[Classroom State] Expiry check failed:', error?.message || error);
    });
  } else if (alarm.name === CLASSROOM_STATE_RECONCILE_ALARM) {
    classroomStateRestorePromise.then(() => enqueueClassroomStateOperation(async () => {
      if (!currentClassroomState) {
        await chrome.alarms.clear(CLASSROOM_STATE_RECONCILE_ALARM);
        return;
      }
      await reconcileClassroomStateTabsBestEffort(currentClassroomState);
    })).catch((error) => {
      console.warn('[Classroom State] Reconciliation retry failed:', error?.message || error);
      scheduleClassroomStateReconciliationRetry();
    });
  } else if (alarm.name === MONITORING_EVENT_FLUSH_ALARM) {
    flushMonitoringEventOutbox().catch(() => {});
  } else if (alarm.name === COMMAND_ACK_FLUSH_ALARM) {
    flushCommandAckOutbox({ forceHttp: true }).catch(() => {});
  } else if (alarm.name === CHAT_ACK_FLUSH_ALARM) {
    flushChatAckOutbox({ forceHttp: true }).catch(() => {});
  } else if (alarm.name === CLASSROOM_OVERLAY_EXPIRY_ALARM) {
    expireClassroomOverlays().catch(() => {});
  } else if (alarm.name === 'screenshot-capture') {
    captureAndSendScreenshot({ reason: 'alarm' });
  }
});

// Screenshot Thumbnail Capture (for teacher dashboard grid view)
// Uses chrome.alarms (30s minimum) instead of setInterval so it survives
// MV3 service worker termination. setInterval dies when the SW goes inactive.
const SCREENSHOT_ALARM_NAME = 'screenshot-capture';
const SCREENSHOT_PERIOD_MS = 30 * 1000;
const SCREENSHOT_SCHEDULED_MIN_GAP_MS = 25 * 1000;
const SCREENSHOT_COMMAND_MIN_GAP_MS = 5 * 1000;
let screenshotScheduled = false;

function scheduleScreenshotCapture(enable) {
  if (enable && !screenshotScheduled) {
    screenshotScheduled = true;
    // chrome.alarms minimum is 30 seconds; use 0.5 min (30s) for near-real-time
    chrome.alarms.create(SCREENSHOT_ALARM_NAME, { periodInMinutes: 0.5 });
    // A single cold-start capture is useful, but only if the persisted health
    // proves the last attempt did not already occur in this cadence window.
    if (!lastScreenshotAttemptAt || Date.now() - lastScreenshotAttemptAt >= SCREENSHOT_PERIOD_MS) {
      captureAndSendScreenshot({ reason: 'startup' });
    }
    console.log('[Screenshot] Scheduled periodic capture via chrome.alarms (every 30s)');
  } else if (!enable && screenshotScheduled) {
    screenshotScheduled = false;
    chrome.alarms.clear(SCREENSHOT_ALARM_NAME);
    console.log('[Screenshot] Stopped periodic capture');
  }
}

async function captureAndSendScreenshot(options = {}) {
  const reason = options.reason || 'scheduled';
  const minimumGap = reason === 'command'
    ? SCREENSHOT_COMMAND_MIN_GAP_MS
    : SCREENSHOT_SCHEDULED_MIN_GAP_MS;
  if (lastScreenshotAttemptAt && Date.now() - lastScreenshotAttemptAt < minimumGap) {
    console.log(`[Screenshot] Coalescing ${reason} capture; cadence guard active`);
    return;
  }
  if (screenshotCaptureInFlight) {
    console.log('[Screenshot] Skipping capture; previous capture still in flight');
    return;
  }
  screenshotAttemptCount++;
  await recordScreenshotAttempt();
  if (Date.now() < apiBackoffUntilMs) {
    await recordScreenshotError('rate_limited_backoff');
    console.log('[Screenshot] Skipping capture during API backoff');
    return;
  }

  if (!licenseActive || trackingState === TRACKING_STATES.OFF) {
    await recordScreenshotError('tracking_off');
    return;
  }
  if (await expireManualAuthIfStale('screenshot-capture')) {
    await recordScreenshotError('auth_stale');
    return;
  }
  if (!hasStudentAuth()) {
    await recordScreenshotError('no_config');
    await notifyAuthGateStateToTabs();
    return;
  }

  screenshotCaptureInFlight = true;
  let screenshotPhase = 'capture';
  try {
    // Get the last focused window
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || !tab.windowId) {
      await recordScreenshotError('no_active_tab');
      console.log('[Screenshot] No active tab in focused window');
      return;
    }

    // Skip chrome:// and other non-HTTP pages
    if (!tab.url || !tab.url.startsWith('http')) {
      await recordScreenshotError('non_http_page');
      console.log('[Screenshot] Skipping non-HTTP page:', tab.url?.slice(0, 30));
      return;
    }

    // Capture the visible tab as JPEG with quality for compression
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: 'jpeg',
      quality: 50  // Lower quality for smaller file size (~30-50KB)
    });

    if (!dataUrl) {
      await recordScreenshotError('capture_empty');
      console.log('[Screenshot] Capture returned empty');
      return;
    }

    // Send screenshot to server with tab metadata
    screenshotPhase = 'upload';
    const headers = buildDeviceAuthHeaders();
    const response = await fetchWithBackoff(`${CONFIG.serverUrl}/api/device/screenshot`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        deviceId: CONFIG.deviceId,
        screenshot: dataUrl,  // base64 data URL
        timestamp: Date.now(),
        tabTitle: tab.title || '',
        tabUrl: tab.url || '',
        tabFavicon: tab.favIconUrl || '',
      }),
    }, {
      context: 'screenshot upload',
      maxAttempts: 2,
    });

    if (!response.ok) {
      await recordScreenshotError(response.status >= 500
        ? 'upload_server_error'
        : 'upload_client_error');
      console.warn('[Screenshot] Upload failed:', response.status);
    } else {
      await recordScreenshotSuccess();
      screenshotSuccessCount++;
      console.log('[Screenshot] Uploaded successfully');
    }
  } catch (error) {
    await recordScreenshotError(screenshotPhase === 'upload' ? 'upload_failed' : 'capture_failed');
    console.warn('[Screenshot] Capture error:', error.message);
  } finally {
    screenshotCaptureInFlight = false;
  }
}

// Remote Control Handlers (Phase 1: GoGuardian-style features)
let screenLocked = false;
let lockedUrl = null;
let lockedDomain = null; // Single domain for lock-screen (e.g., "ixl.com")
let allowedDomains = []; // Multiple domains for apply-flight-path (e.g., ["ixl.com", "khanacademy.org"])
let activeFlightPathName = null; // Name of the currently active scene
let currentMaxTabs = null;
let teacherMaxTabs = null;
let schoolMaxTabs = null;
const seenPollIds = new Set(); // dedup: prevent broadcasting same poll twice

function screenLockIsActive() {
  return screenLocked;
}

function flightPathIsActive() {
  return allowedDomains.length > 0;
}
let globalBlockedDomains = []; // School-wide blacklist (e.g., ["lens.google.com", "chat.openai.com"])
let globalBlockedDomainsStateTrusted = false;
let teacherBlockedDomains = []; // Teacher-applied session blacklist
let activeBlockListName = null; // Name of the currently active teacher block list
let temporaryAllowedDomains = []; // Temporarily unblocked domains with expiry times: [{ domain, expiresAt }]
let attentionModeActive = false; // When true, blocks navigation and new tabs
let teacherBroadcastActive = false;
let teacherBroadcastSessionId = null;
const CLASSROOM_STATE_STORAGE_KEY = 'classroomControlStateV1';
const CLASSROOM_STATE_FAILSAFE_EXPIRY_KEY = 'classroomStateFailSafeExpiryAt';
const CLASSROOM_STATE_STUDENT_BINDING_KEY = 'classroomStateStudentBindingV1';
const CLASSROOM_STATE_EXPIRY_ALARM = 'classroom-state-expiry';
const CLASSROOM_STATE_RECONCILE_ALARM = 'classroom-state-reconcile';
const CLASSROOM_STATE_RECONCILE_RETRY_MS = 15 * 1000;
const CLASSROOM_STATE_EXPIRY_RETRY_MS = 15 * 1000;
const CLASSROOM_STATE_SYNC_INTERVAL_MS = 30 * 1000;
const STATEFUL_COMMAND_TYPES = new Set([
  'lock-screen',
  'unlock-screen',
  'apply-flight-path',
  'remove-flight-path',
  'temp-unblock',
  'apply-block-list',
  'remove-block-list',
  'limit-tabs',
  'attention-mode',
]);
let currentClassroomState = null;
let lastClassroomStateSyncRequestAt = 0;
let lastClassroomHeartbeatSyncRequestAt = 0;
let lastFabHeartbeatSyncRequestAt = 0;
const FAB_HEARTBEAT_DISCONNECTED_SYNC_INTERVAL_MS = 30 * 1000;
const FAB_HEARTBEAT_CONNECTED_SYNC_INTERVAL_MS = 5 * 60 * 1000;
let lastClassroomStateOutcome = 'pending';
let lastClassroomStateAckRevision = 0;
let classroomStateApplicationTail = Promise.resolve();

function enqueueClassroomStateOperation(operation) {
  const run = () => operation();
  classroomStateApplicationTail = classroomStateApplicationTail.then(run, run);
  return classroomStateApplicationTail;
}

function effectiveTabLimit() {
  const limits = [teacherMaxTabs, schoolMaxTabs]
    .filter((value) => Number.isSafeInteger(value) && value > 0);
  return limits.length ? Math.min(...limits) : null;
}

function classroomRuntimeBackup() {
  return {
    screenLocked,
    lockedUrl,
    lockedDomain,
    allowedDomains: [...allowedDomains],
    activeFlightPathName,
    currentMaxTabs,
    teacherMaxTabs,
    teacherBlockedDomains: [...teacherBlockedDomains],
    activeBlockListName,
    temporaryAllowedDomains: temporaryAllowedDomains.map((item) => ({ ...item })),
    attentionModeActive,
  };
}

function restoreClassroomRuntimeBackup(backup) {
  screenLocked = backup.screenLocked;
  lockedUrl = backup.lockedUrl;
  lockedDomain = backup.lockedDomain;
  allowedDomains = backup.allowedDomains;
  activeFlightPathName = backup.activeFlightPathName;
  currentMaxTabs = backup.currentMaxTabs;
  teacherMaxTabs = backup.teacherMaxTabs;
  teacherBlockedDomains = backup.teacherBlockedDomains;
  activeBlockListName = backup.activeBlockListName;
  temporaryAllowedDomains = backup.temporaryAllowedDomains;
  attentionModeActive = backup.attentionModeActive;
}

function classroomRestrictionTypes(state = currentClassroomState) {
  const restrictions = state?.restrictions;
  if (!restrictions) return [];
  const types = [];
  if (restrictions.screenLock?.active) types.push('screen_lock');
  if (restrictions.flightPath?.active) types.push('flight_path');
  if (restrictions.blockList?.active) types.push('block_list');
  if (restrictions.attentionMode?.active) types.push('attention_mode');
  if (restrictions.tabLimit) types.push('tab_limit');
  if (restrictions.temporaryAllows?.length) types.push('temporary_allow');
  return types;
}

function classroomStateAckTarget(rawState) {
  const rawRevision = rawState?.revision
    ?? rawState?.studentControlRevision
    ?? rawState?.student_control_revision;
  const parsedRevision = Number(rawRevision);
  const session = rawState?.session && typeof rawState.session === 'object' ? rawState.session : {};
  const safeScopeId = (value) => typeof value === 'string' && value.trim()
    ? value.trim().slice(0, 128)
    : null;
  return {
    revision: Number.isSafeInteger(parsedRevision) && parsedRevision >= 0
      ? parsedRevision
      : currentClassroomState?.revision ?? 0,
    teachingSessionId: safeScopeId(
      rawState?.teachingSessionId ?? rawState?.sessionId ?? session.teachingSessionId ?? session.id
    ),
    supervisionContextId: safeScopeId(
      rawState?.supervisionContextId ?? session.supervisionContextId
    ),
  };
}

function sendClassroomStateAck(state, outcome, error) {
  lastClassroomStateOutcome = outcome;
  if (Number.isSafeInteger(Number(state?.revision)) && Number(state.revision) >= 0) {
    lastClassroomStateAckRevision = Number(state.revision);
  }
  if (!wsConnected || !state) return;
  wsSend({
    type: 'classroom-state-ack',
    appliedRevision: state.revision,
    outcome,
    teachingSessionId: state.teachingSessionId || undefined,
    supervisionContextId: state.supervisionContextId || undefined,
    error: error ? commandErrorMessage(error).slice(0, 200) : undefined,
    extensionVersion: chrome.runtime.getManifest().version,
    timestamp: new Date().toISOString(),
  });
}

function classroomRestrictionsFromRuntime() {
  return {
    screenLock: {
      active: screenLocked,
      url: lockedUrl,
      domain: lockedDomain,
    },
    flightPath: {
      active: allowedDomains.length > 0,
      allowedDomains,
      name: activeFlightPathName,
    },
    blockList: {
      active: teacherBlockedDomains.length > 0,
      blockedDomains: teacherBlockedDomains,
      name: activeBlockListName,
    },
    attentionMode: {
      active: attentionModeActive,
      message: currentClassroomState?.restrictions?.attentionMode?.message || '',
    },
    tabLimit: teacherMaxTabs,
    temporaryAllows: temporaryAllowedDomains,
  };
}

function scheduleClassroomStateExpiry(state = currentClassroomState) {
  chrome.alarms.clear(CLASSROOM_STATE_EXPIRY_ALARM);
  if (!state) return;
  const stateExpiry = RuntimeCore.classroomStateExpiry(state, Date.now()).expiresAt;
  const temporaryExpiry = (state.restrictions?.temporaryAllows || [])
    .map((item) => Number(item.expiresAt))
    .filter((value) => Number.isFinite(value) && value > Date.now())
    .sort((a, b) => a - b)[0];
  const nextExpiry = [stateExpiry, temporaryExpiry]
    .filter((value) => Number.isFinite(value) && value > Date.now())
    .sort((a, b) => a - b)[0];
  if (nextExpiry) chrome.alarms.create(CLASSROOM_STATE_EXPIRY_ALARM, { when: nextExpiry });
}

function scheduleClassroomStateExpiryRetry() {
  chrome.alarms.create(CLASSROOM_STATE_EXPIRY_ALARM, {
    when: Date.now() + CLASSROOM_STATE_EXPIRY_RETRY_MS,
  });
}

async function enforceCurrentTabLimit() {
  if (!currentMaxTabs || currentMaxTabs < 1) return;
  const tabs = await chrome.tabs.query({});
  const closeable = tabs.filter((tab) => tab.id && !tab.url?.startsWith('chrome://'));
  const excess = Math.max(0, tabs.length - currentMaxTabs);
  for (const tab of closeable.slice(0, excess)) {
    await chrome.tabs.remove(tab.id).catch(() => {});
  }
}

async function setRuntimeFromClassroomState(state) {
  const restrictions = state.restrictions;
  const backup = classroomRuntimeBackup();
  screenLocked = Boolean(restrictions.screenLock.active);
  allowedDomains = restrictions.flightPath.active ? [...restrictions.flightPath.allowedDomains] : [];
  activeFlightPathName = restrictions.flightPath.active ? restrictions.flightPath.name : null;
  lockedUrl = restrictions.screenLock.active ? restrictions.screenLock.url : null;
  lockedDomain = restrictions.screenLock.active ? restrictions.screenLock.domain : null;
  teacherBlockedDomains = restrictions.blockList.active ? [...restrictions.blockList.blockedDomains] : [];
  activeBlockListName = restrictions.blockList.active ? restrictions.blockList.name : null;
  temporaryAllowedDomains = restrictions.temporaryAllows.map((item) => ({ ...item }));
  attentionModeActive = restrictions.attentionMode.active;
  teacherMaxTabs = restrictions.tabLimit;
  currentMaxTabs = effectiveTabLimit();

  try {
    await composeAllManagedDynamicRules();
  } catch (error) {
    restoreClassroomRuntimeBackup(backup);
    throw error;
  }

  try {
    broadcastToAllTabs('attention-mode', {
      active: attentionModeActive,
      message: restrictions.attentionMode.message || 'Please look up!',
    });
  } catch (error) {
    console.warn('[Classroom State] Attention overlay reconciliation failed:', error?.message || error);
  }
  // DNR is the durable enforcement boundary. Browser tabs are inherently
  // racy, so failure to query/update one must never roll back or clear the
  // newly composed rules. Retry tab reconciliation independently instead.
  await reconcileClassroomStateTabsBestEffort(state);
}

function scheduleClassroomStateReconciliationRetry() {
  chrome.alarms.create(CLASSROOM_STATE_RECONCILE_ALARM, {
    when: Date.now() + CLASSROOM_STATE_RECONCILE_RETRY_MS,
  });
}

async function reconcileClassroomStateTabsBestEffort(state) {
  try {
    await reconcileExistingTabsForClassroomState(state);
    await enforceCurrentTabLimit();
    await chrome.alarms.clear(CLASSROOM_STATE_RECONCILE_ALARM);
    return true;
  } catch (error) {
    console.warn('[Classroom State] Existing-tab reconciliation deferred:', error?.message || error);
    scheduleClassroomStateReconciliationRetry();
    return false;
  }
}

async function reconcileExistingTabsForClassroomState(state) {
  const tabs = await chrome.tabs.query({});
  const plan = RuntimeCore.planClassroomTabReconciliation(state, tabs);
  let updateSucceeded = plan.updates.length === 0;
  for (const update of plan.updates) {
    try {
      await chrome.tabs.update(update.tabId, { url: update.url });
      updateSucceeded = true;
    } catch (error) {
      // A tab may disappear between query and update. A replacement below
      // prevents that race from leaving the student without the lock target.
      console.warn('[Classroom State] Retained tab disappeared during reconciliation:', error?.message || error);
    }
  }
  for (const tabId of plan.removeTabIds) {
    try {
      await chrome.tabs.remove(tabId);
    } catch (error) {
      // Closed-by-user races are already compliant with the desired state.
      console.info('[Classroom State] Tab already closed during reconciliation:', tabId);
    }
  }
  const fallbackUrl = plan.createUrl || (!updateSucceeded ? plan.updates[0]?.url : null);
  if (fallbackUrl) await chrome.tabs.create({ url: fallbackUrl, active: true });
  await refreshTabCache();
}

async function resolveCurrentUrlMarker(rawState) {
  const cloned = JSON.parse(JSON.stringify(rawState));
  const restrictions = cloned.restrictions || cloned.desiredRestrictions || cloned.desiredState;
  const screenLock = restrictions?.screenLock || restrictions?.screen_lock;
  if (screenLock?.url !== 'CURRENT_URL' && screenLock?.lockedUrl !== 'CURRENT_URL') return cloned;
  const tabs = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  const activeTab = tabs.find((tab) => isHttpUrl(tab.url));
  if (!activeTab?.url) throw new Error('No active web tab is available for the screen lock');
  screenLock.url = activeTab.url;
  screenLock.lockedUrl = activeTab.url;
  screenLock.domain = extractDomain(activeTab.url);
  screenLock.lockedDomain = screenLock.domain;
  return cloned;
}

async function applyClassroomStateNow(rawState, options = {}) {
  let normalized;
  try {
    const prepared = await resolveCurrentUrlMarker(rawState);
    normalized = RuntimeCore.normalizeClassroomState(prepared, Date.now());
  } catch (error) {
    const ackState = classroomStateAckTarget(rawState);
    const outcome = error?.code === 'UNSUPPORTED_CLASSROOM_STATE_SCHEMA'
      ? 'unsupported'
      : 'failed';
    sendClassroomStateAck(ackState, outcome, error);
    enqueueMonitoringEvent('restriction_state_failed', {
      revision: ackState.revision,
      restrictionTypes: [],
      errorCode: error?.code || error?.name || 'invalid_snapshot',
    }, {
      teachingSessionId: ackState.teachingSessionId,
      supervisionContextId: ackState.supervisionContextId,
    }).catch(() => {});
    throw error;
  }
  const previousState = currentClassroomState;
  if (!options.force && !RuntimeCore.shouldApplyClassroomState(currentClassroomState, normalized)) {
    const currentExpiry = RuntimeCore.classroomStateExpiry(currentClassroomState, Date.now());
    const outcome = currentExpiry.expired
      ? 'expired'
      : normalized.revision === currentClassroomState?.revision
        ? 'applied'
        : 'stale';
    // `stale` is useful to the command caller but is not an enforcement-health
    // state. Acknowledge the higher revision that remains actively applied.
    sendClassroomStateAck(currentClassroomState, currentExpiry.expired ? 'expired' : 'applied');
    return {
      outcome,
      appliedRevision: currentClassroomState?.revision ?? 0,
    };
  }

  const expiry = RuntimeCore.classroomStateExpiry(normalized, Date.now());
  if (expiry.expired) {
    currentClassroomState = normalized;
    await expireClassroomState(expiry.reason);
    return { outcome: 'expired', appliedRevision: normalized.revision };
  }

  const runtimeBackup = classroomRuntimeBackup();
  let statePersisted = false;
  try {
    await setRuntimeFromClassroomState(normalized);
    currentClassroomState = normalized;
    await kv.set({
      [CLASSROOM_STATE_STORAGE_KEY]: normalized,
      [CLASSROOM_STATE_FAILSAFE_EXPIRY_KEY]: normalized.hardExpiresAt,
      ...(CONFIG.activeStudentId
        ? { [CLASSROOM_STATE_STUDENT_BINDING_KEY]: CONFIG.activeStudentId }
        : {}),
    });
    statePersisted = true;
    await kv.remove([
      'lockScreenState',
      'flightPathState',
      'teacherBlockListState',
    ]).catch((error) => {
      console.warn('[Classroom State] Legacy state cleanup failed:', error?.message || error);
    });
    scheduleClassroomStateExpiry(normalized);
    sendClassroomStateAck(normalized, 'applied');
    const restrictionTypes = classroomRestrictionTypes(normalized);
    const eventScope = normalized.teachingSessionId || normalized.supervisionContextId
      ? {
          teachingSessionId: normalized.teachingSessionId,
          supervisionContextId: normalized.supervisionContextId,
        }
      : {
          teachingSessionId: previousState?.teachingSessionId || null,
          supervisionContextId: previousState?.supervisionContextId || null,
        };
    enqueueMonitoringEvent(
      restrictionTypes.length ? 'restriction_state_applied' : 'restriction_state_cleared',
      { revision: normalized.revision, restrictionTypes, reason: options.reason || 'state_sync' },
      eventScope
    ).catch(() => {});
    const scopeChanged = normalized.teachingSessionId !== previousState?.teachingSessionId
      || normalized.supervisionContextId !== previousState?.supervisionContextId;
    if (
      activeLiveViewNegotiationId
      && (
        scopeChanged
        || normalized.supervisionContextId
        || normalized.teachingSessionId !== activeLiveViewTeachingSessionId
      )
    ) {
      await stopScreenShare({ reason: 'classroom-authority-changed' });
    }
    if (scopeChanged && (normalized.teachingSessionId || normalized.supervisionContextId)) {
      await enqueueMonitoringEvent('monitoring_state_changed', {
        state: persistedMonitoringState.state.toLowerCase(),
        reason: 'scope_initialized',
      }, {
        teachingSessionId: normalized.teachingSessionId,
        supervisionContextId: normalized.supervisionContextId,
        // This is a snapshot of the current state in the new scope. Using the
        // old transition timestamp could precede the scope and be rejected by
        // the server's authoritative scope resolver.
        occurredAt: Date.now(),
      }).catch((error) => {
        console.warn('[Classroom State] Scope monitoring event was deferred:', error?.message || error);
      });
    }
    return { outcome: 'applied', appliedRevision: normalized.revision };
  } catch (error) {
    // Once the snapshot and its fail-safe deadline are durable, retain them.
    // Non-critical notification/event failures must never clear enforcement
    // or resurrect the previous revision.
    if (statePersisted) {
      currentClassroomState = normalized;
      scheduleClassroomStateExpiry(normalized);
      sendClassroomStateAck(normalized, 'applied');
      console.warn('[Classroom State] Snapshot persisted with a deferred side effect:', error?.message || error);
      return { outcome: 'applied', appliedRevision: normalized.revision };
    }
    restoreClassroomRuntimeBackup(runtimeBackup);
    currentClassroomState = previousState;
    await composeAllManagedDynamicRules().catch((rollbackError) => {
      console.warn('[Classroom State] Snapshot rule rollback failed:', rollbackError?.message || rollbackError);
    });
    broadcastToAllTabs('attention-mode', {
      active: attentionModeActive,
      message: previousState?.restrictions?.attentionMode?.message || '',
    });
    if (previousState) {
      await kv.set({
        [CLASSROOM_STATE_STORAGE_KEY]: previousState,
        [CLASSROOM_STATE_FAILSAFE_EXPIRY_KEY]: previousState.hardExpiresAt,
        ...(CONFIG.activeStudentId
          ? { [CLASSROOM_STATE_STUDENT_BINDING_KEY]: CONFIG.activeStudentId }
          : {}),
      }).catch(() => {});
      scheduleClassroomStateExpiry(previousState);
    } else {
      await kv.remove([
        CLASSROOM_STATE_STORAGE_KEY,
        CLASSROOM_STATE_FAILSAFE_EXPIRY_KEY,
        CLASSROOM_STATE_STUDENT_BINDING_KEY,
      ]).catch(() => {});
      chrome.alarms.clear(CLASSROOM_STATE_EXPIRY_ALARM);
    }
    sendClassroomStateAck(normalized, 'failed', error);
    enqueueMonitoringEvent('restriction_state_failed', {
      revision: normalized.revision,
      restrictionTypes: classroomRestrictionTypes(normalized),
      errorCode: error?.name || 'apply_failed',
    }, {
      teachingSessionId: normalized.teachingSessionId,
      supervisionContextId: normalized.supervisionContextId,
    }).catch(() => {});
    throw error;
  }
}

function applyClassroomState(rawState, options = {}) {
  return enqueueClassroomStateOperation(() => applyClassroomStateNow(rawState, options));
}

async function expireClassroomState(reason = 'hard_expiry') {
  if (!currentClassroomState) return;
  if (activeLiveViewNegotiationId) {
    await stopScreenShare({ reason: `classroom-state-${reason}` });
  }
  const expiredState = {
    ...currentClassroomState,
    restrictions: RuntimeCore.emptyRestrictions(),
    expiredAt: Date.now(),
    expiryReason: reason,
  };
  await setRuntimeFromClassroomState(expiredState);
  currentClassroomState = expiredState;
  await kv.set({ [CLASSROOM_STATE_STORAGE_KEY]: expiredState });
  await kv.remove(CLASSROOM_STATE_FAILSAFE_EXPIRY_KEY);
  scheduleClassroomStateExpiry(expiredState);
  sendClassroomStateAck(expiredState, 'expired');
  enqueueMonitoringEvent('restriction_state_cleared', {
    revision: expiredState.revision,
    restrictionTypes: [],
    reason,
  }).catch(() => {});
}

async function checkClassroomStateExpiryNow() {
  if (!currentClassroomState) {
    const stored = await kv.get([CLASSROOM_STATE_FAILSAFE_EXPIRY_KEY]);
    const failSafeExpiryAt = Number(stored[CLASSROOM_STATE_FAILSAFE_EXPIRY_KEY] || 0);
    if (!failSafeExpiryAt) return;
    if (Date.now() < failSafeExpiryAt) {
      chrome.alarms.create(CLASSROOM_STATE_EXPIRY_ALARM, { when: failSafeExpiryAt });
      return;
    }
    screenLocked = false;
    lockedUrl = null;
    lockedDomain = null;
    allowedDomains = [];
    activeFlightPathName = null;
    teacherMaxTabs = null;
    currentMaxTabs = effectiveTabLimit();
    teacherBlockedDomains = [];
    activeBlockListName = null;
    temporaryAllowedDomains = [];
    attentionModeActive = false;
    await composeDynamicRules(['classroom', 'teacher', 'temporary']);
    broadcastToAllTabs('attention-mode', { active: false, message: '' });
    await kv.remove(CLASSROOM_STATE_FAILSAFE_EXPIRY_KEY);
    return;
  }
  const expiry = RuntimeCore.classroomStateExpiry(currentClassroomState, Date.now());
  if (expiry.expired) {
    await expireClassroomState(expiry.reason);
    return;
  }
  const validAllows = RuntimeCore.normalizeTemporaryAllows(
    currentClassroomState.restrictions.temporaryAllows,
    Date.now()
  );
  if (validAllows.length !== currentClassroomState.restrictions.temporaryAllows.length) {
    const stateWithoutExpiredAllows = {
      ...currentClassroomState,
      restrictions: { ...currentClassroomState.restrictions, temporaryAllows: validAllows },
    };
    await updateTemporaryAllowRules(validAllows);
    // Commit the durable snapshot only after Chrome accepted the corresponding
    // DNR update. On failure, the retry must still see the expired entry and
    // attempt the clear again rather than treating the in-memory mutation as
    // already enforced.
    currentClassroomState = stateWithoutExpiredAllows;
    await kv.set({ [CLASSROOM_STATE_STORAGE_KEY]: currentClassroomState });
  }
  scheduleClassroomStateExpiry(currentClassroomState);
}

function checkClassroomStateExpiry() {
  return enqueueClassroomStateOperation(checkClassroomStateExpiryNow).catch((error) => {
    // A transient DNR/storage failure must not turn a scheduled or absolute
    // cutoff into a permanent restriction. Retain the original deadline and
    // retry the teacher/class/temporary range clear until it succeeds.
    scheduleClassroomStateExpiryRetry();
    throw error;
  });
}

async function persistLegacyClassroomState(command, envelope = {}) {
  const now = Date.now();
  const base = currentClassroomState || {
    schemaVersion: 1,
    revision: 0,
    receivedAt: now,
    hardExpiresAt: now + RuntimeCore.CLASSROOM_STATE_MAX_LIFETIME_MS,
  };
  const normalized = RuntimeCore.normalizeClassroomState({
    ...base,
    teachingSessionId: envelope.teachingSessionId || envelope.sessionId || command?.data?.teachingSessionId || base.teachingSessionId,
    restrictions: classroomRestrictionsFromRuntime(),
  }, now);
  currentClassroomState = normalized;
  await kv.set({
    [CLASSROOM_STATE_STORAGE_KEY]: normalized,
    [CLASSROOM_STATE_FAILSAFE_EXPIRY_KEY]: normalized.hardExpiresAt,
    ...(CONFIG.activeStudentId
      ? { [CLASSROOM_STATE_STUDENT_BINDING_KEY]: CONFIG.activeStudentId }
      : {}),
  });
  await kv.remove([
    'lockScreenState',
    'flightPathState',
    'teacherBlockListState',
  ]);
  scheduleClassroomStateExpiry(normalized);
}

function requestClassroomStateSync(reason = 'periodic', force = false) {
  const now = Date.now();
  if (!force && now - lastClassroomStateSyncRequestAt < CLASSROOM_STATE_SYNC_INTERVAL_MS) return false;
  if (wsConnected) {
    lastClassroomStateSyncRequestAt = now;
    wsSend({
      type: 'classroom-state-request',
      appliedRevision: currentClassroomState?.revision ?? 0,
      teachingSessionId: currentClassroomState?.teachingSessionId || undefined,
      supervisionContextId: currentClassroomState?.supervisionContextId || undefined,
      reason,
    });
  }
  return true;
}

function requestClassroomStateOnHeartbeat() {
  const now = Date.now();
  if (now - lastClassroomHeartbeatSyncRequestAt < CLASSROOM_STATE_SYNC_INTERVAL_MS) return false;
  lastClassroomHeartbeatSyncRequestAt = now;
  return true;
}

async function cleanupTeacherBroadcast(reason = 'stopped', options = {}) {
  if (!teacherBroadcastActive && !teacherBroadcastSessionId) {
    return;
  }
  const previousSessionId = teacherBroadcastSessionId;
  teacherBroadcastActive = false;
  teacherBroadcastSessionId = null;
  if (options.notifyTeacher && wsConnected) {
    await wsSend({
      type: 'broadcast-leave',
      sessionId: previousSessionId || undefined,
      reason,
    });
  }
  broadcastToAllTabs('teacher-broadcast-stop', {
    sessionId: previousSessionId,
    reason,
  });
}

async function handleBroadcastStart(message = {}) {
  const nextSessionId = message.sessionId || message.broadcastSessionId || null;
  if (teacherBroadcastActive && teacherBroadcastSessionId !== nextSessionId) {
    await cleanupTeacherBroadcast('replaced-by-new-broadcast', { notifyTeacher: true });
  }
  teacherBroadcastActive = true;
  teacherBroadcastSessionId = nextSessionId;
  await wsSend({
    type: 'broadcast-join',
    sessionId: nextSessionId || undefined,
  });
}

async function handleBroadcastStop() {
  await cleanupTeacherBroadcast('teacher-stop', { notifyTeacher: false });
}

async function handleBroadcastOffer(sdp) {
  if (!teacherBroadcastActive) {
    console.warn('[Broadcast] Ignoring offer because no broadcast session is active');
    return;
  }
  if (!sdp) {
    console.warn('[Broadcast] Ignoring empty broadcast offer');
    return;
  }
  console.warn('[Broadcast] Student-side teacher broadcast viewing is not available in this extension build; leaving broadcast');
  await cleanupTeacherBroadcast('unsupported-broadcast-offer', { notifyTeacher: true });
}

function handleBroadcastIce(candidate) {
  if (!teacherBroadcastActive || !candidate) {
    return;
  }
  console.log('[Broadcast] Ignoring broadcast ICE after cleanup-only handling');
}

async function getClassroomCommandStateSnapshot() {
  const snapshot = {
    screenLocked: screenLockIsActive(),
    flightPathActive: flightPathIsActive(),
    lockedUrl,
    lockedDomain,
    allowedDomains,
    activeFlightPathName,
    activeBlockListName,
    teacherBlockedDomains,
    temporaryAllowedDomains,
    attentionModeActive,
    currentMaxTabs,
  };

  try {
    const tabs = await chrome.tabs.query({});
    const activeTab = tabs.find(tab => tab.active) || tabs[0];
    const tabSnapshot = await buildOpaqueTabSnapshot(tabs);
    const activeEntry = tabSnapshot.localEntries.find((entry) => entry.tabId === activeTab?.id);
    return {
      ...snapshot,
      tabCount: tabs.length,
      tabSnapshotRevision: tabSnapshot.revision,
      activeTab: activeTab ? {
        tabRef: activeEntry?.tabRef || null,
        url: activeTab.url || null,
        title: activeTab.title || null,
      } : null,
    };
  } catch (error) {
    return {
      ...snapshot,
      tabError: commandErrorMessage(error),
    };
  }
}

async function clearTeacherSessionStateForSignOutNow(options = {}) {
  const eventScope = getMonitoringEventScope();
  if (activeLiveViewNegotiationId) {
    await stopScreenShare({ reason: options.reason || 'student-sign-out' });
  }
  screenLocked = false;
  lockedUrl = null;
  lockedDomain = null;
  allowedDomains = [];
  activeFlightPathName = null;
  teacherMaxTabs = null;
  currentMaxTabs = effectiveTabLimit();
  teacherBlockedDomains = [];
  activeBlockListName = null;
  temporaryAllowedDomains = [];
  attentionModeActive = false;
  seenPollIds.clear();

  const clearedRevision = currentClassroomState?.revision ?? 0;
  await composeDynamicRules(['classroom', 'teacher', 'temporary']);
  currentClassroomState = null;
  await chrome.storage.local.remove([
    'lockScreenState',
    'flightPathState',
    'teacherBlockListState',
    CLASSROOM_STATE_STORAGE_KEY,
    CLASSROOM_STATE_FAILSAFE_EXPIRY_KEY,
    CLASSROOM_STATE_STUDENT_BINDING_KEY,
  ]);
  chrome.alarms.clear(CLASSROOM_STATE_EXPIRY_ALARM);
  if (options.emitEvent !== false) {
    enqueueMonitoringEvent('restriction_state_cleared', {
      revision: clearedRevision,
      restrictionTypes: [],
      reason: options.reason || 'student_sign_out',
    }, eventScope).catch(() => {});
  }

  broadcastToAllTabs('attention-mode', { active: false, message: '' });
  if (options.preserveTransientOverlays !== true) {
    await clearClassroomOverlayState(options.reason || 'classroom-state-cleared');
  }
}

function requestFabStateOnHeartbeat() {
  const now = Date.now();
  const interval = wsConnected
    ? FAB_HEARTBEAT_CONNECTED_SYNC_INTERVAL_MS
    : FAB_HEARTBEAT_DISCONNECTED_SYNC_INTERVAL_MS;
  if (now - lastFabHeartbeatSyncRequestAt < interval) return false;
  lastFabHeartbeatSyncRequestAt = now;
  return true;
}

function clearTeacherSessionStateForSignOut(options = {}) {
  return enqueueClassroomStateOperation(() => clearTeacherSessionStateForSignOutNow(options));
}

// Helper function to extract domain from URL
function extractDomain(url) {
  try {
    const urlObj = new URL(url);
    // Remove 'www.' prefix for consistent matching
    return urlObj.hostname.replace(/^www\./, '');
  } catch (error) {
    console.warn('Invalid URL:', url, error);
    return null;
  }
}

// Helper function to check if URL is on the same domain (exact match only)
function isOnSameDomain(url, domain) {
  if (!url || !domain) return false;
  const urlDomain = extractDomain(url);
  if (!urlDomain) return false;

  // Use exact domain matching for precise control
  // e.g., "classroom.google.com" only matches "classroom.google.com"
  return urlDomain === domain;
}

const AUTHORITY_BOUND_COMMAND_TYPES = new Set([
  'open-tab',
  'close-tabs',
  'close-tab',
  'lock-screen',
  'unlock-screen',
  'apply-flight-path',
  'remove-flight-path',
  'temp-unblock',
  'apply-block-list',
  'remove-block-list',
  'limit-tabs',
  'attention-mode',
  'timer',
  'poll',
  'student-sign-out',
  'messaging-toggle',
  'hand-raising-toggle',
  'hand-dismissed',
  'teacher-message',
]);

function commandAuthority(command = {}, envelope = {}) {
  const authority = command.authority || envelope.authority || {};
  const state = envelope.classroomState || envelope.stateSnapshot || command.classroomState || {};
  const teachingSessionId = String(
    authority.teachingSessionId
    || command.teachingSessionId
    || envelope.teachingSessionId
    || state.teachingSessionId
    || ''
  ).trim() || null;
  const supervisionContextId = String(
    authority.supervisionContextId
    || command.supervisionContextId
    || envelope.supervisionContextId
    || state.supervisionContextId
    || ''
  ).trim() || null;
  return {
    kind: String(authority.kind || '').trim() || null,
    schoolId: String(authority.schoolId || '').trim() || null,
    source: String(authority.source || '').trim() || null,
    teachingSessionId,
    supervisionContextId,
  };
}

function assertCurrentCommandAuthority(command = {}, envelope = {}) {
  const commandType = String(command.type || '').trim();
  if (!AUTHORITY_BOUND_COMMAND_TYPES.has(commandType)) return null;
  const authority = commandAuthority(command, envelope);
  if (authority.kind === 'school_policy') {
    const allowedSource = (
      (commandType === 'close-tab' || commandType === 'close-tabs')
        && authority.source === 'ai_safety'
    ) || (
      commandType === 'limit-tabs'
        && authority.source === 'school_settings'
    );
    if (!allowedSource || !authority.schoolId || authority.schoolId !== CONFIG.schoolId) {
      const error = new Error('Command has invalid school-policy authority');
      error.code = 'COMMAND_AUTHORITY_MISMATCH';
      throw error;
    }
    return authority;
  }
  if (Boolean(authority.teachingSessionId) === Boolean(authority.supervisionContextId)) {
    const error = new Error('Command is missing one immutable classroom authority');
    error.code = 'COMMAND_AUTHORITY_MISSING';
    throw error;
  }

  if (authority.teachingSessionId) {
    const stateScope = currentClassroomState?.supervisionContextId
      ? null
      : currentClassroomState?.teachingSessionId || null;
    const activeSessionIds = activeTeachingSessionIds();
    if (
      (stateScope
        ? stateScope !== authority.teachingSessionId
        : !activeSessionIds.includes(authority.teachingSessionId))
      || currentClassroomState?.supervisionContextId
    ) {
      const error = new Error('Command belongs to an inactive teaching session');
      error.code = 'COMMAND_AUTHORITY_MISMATCH';
      throw error;
    }
    return authority;
  }

  if (currentClassroomState?.supervisionContextId !== authority.supervisionContextId) {
    const error = new Error('Command belongs to an inactive supervision context');
    error.code = 'COMMAND_AUTHORITY_MISMATCH';
    throw error;
  }
  return authority;
}

async function handleRemoteControl(command, envelope = {}) {
  const commandId = getCommandIdFromMessage(envelope, command);
  const commandType = command?.type || 'unknown';
  const delivery = RuntimeCore.commandDeliveryState(command, envelope, Date.now());

  // One-shot actions never become a reconnect queue. If the device did not
  // receive the envelope before its deadline, report expiry without executing.
  if (delivery.expired) {
    if (commandId) {
      await sendCommandAck(commandId, 'expired', {
        commandType,
        deliveryPolicy: delivery.deliveryPolicy,
        expiresAt: delivery.expiresAt,
        state: await getClassroomCommandStateSnapshot(),
        outcome: 'expired',
      });
    }
    return { expired: true, expiresAt: delivery.expiresAt };
  }

  let authority = null;
  try {
    assertCurrentStudentBinding(envelope, 'remote-control command');
    authority = assertCurrentCommandAuthority(command, envelope);
  } catch (error) {
    if (commandId) {
      await sendCommandAck(commandId, 'failed', {
        commandType,
        error: commandErrorMessage(error),
        errorCode: error?.code || 'COMMAND_AUTHORITY_MISMATCH',
        state: await getClassroomCommandStateSnapshot(),
        outcome: 'failed',
        deliveryPolicy: delivery.deliveryPolicy,
        expiresAt: delivery.expiresAt,
      });
    }
    return { rejected: true, error: commandErrorMessage(error) };
  }

  if (commandId) {
    await sendCommandAck(commandId, 'received', {
      commandType,
      deliveryPolicy: delivery.deliveryPolicy,
      expiresAt: delivery.expiresAt,
    });
  }

  try {
    // Re-check after the asynchronous receipt write. A class replacement may
    // have arrived while the durable ACK was being persisted.
    assertCurrentStudentBinding(envelope, 'remote-control command');
    assertCurrentCommandAuthority(command, envelope);
    if (authority?.teachingSessionId) {
      command.data = {
        ...(command.data || {}),
        teachingSessionId: authority.teachingSessionId,
      };
    }
    const classroomState = envelope?.classroomState
      || envelope?.stateSnapshot
      || command?.classroomState
      || command?.data?.classroomState;
    // School-policy commands (currently the administrator's global tab limit)
    // are not classroom state. Persisting them through the legacy classroom
    // reducer would incorrectly attach a school setting to whichever class is
    // active on the device.
    const isClassroomStatefulCommand = STATEFUL_COMMAND_TYPES.has(commandType)
      && authority?.kind !== 'school_policy';
    let application = null;
    let result;
    if (classroomState && isClassroomStatefulCommand) {
      application = await applyClassroomState(classroomState, { reason: 'stateful_command' });
      result = {
        commandType,
        stateReconciled: true,
        appliedRevision: application.appliedRevision,
        outcome: application.outcome,
        completedAt: new Date().toISOString(),
      };
    } else if (isClassroomStatefulCommand) {
      result = await enqueueClassroomStateOperation(async () => {
        const runtimeBackup = classroomRuntimeBackup();
        const stateBackup = currentClassroomState;
        try {
          const legacyResult = await executeRemoteControlCommand(command || {}, { commandId, envelope, delivery });
          await persistLegacyClassroomState(command, envelope);
          application = {
            outcome: 'applied',
            appliedRevision: currentClassroomState?.revision ?? 0,
          };
          enqueueMonitoringEvent('restriction_state_applied', {
            revision: application.appliedRevision,
            restrictionTypes: classroomRestrictionTypes(),
            reason: 'legacy_command',
          }).catch(() => {});
          return legacyResult;
        } catch (error) {
          restoreClassroomRuntimeBackup(runtimeBackup);
          currentClassroomState = stateBackup;
          await composeAllManagedDynamicRules().catch((rollbackError) => {
            console.warn('[Classroom State] Legacy command rule rollback failed:', rollbackError?.message || rollbackError);
          });
          broadcastToAllTabs('attention-mode', {
            active: attentionModeActive,
            message: stateBackup?.restrictions?.attentionMode?.message || '',
          });
          await kv.remove(['lockScreenState', 'flightPathState', 'teacherBlockListState']);
          scheduleClassroomStateExpiry(stateBackup);
          throw error;
        }
      });
    } else {
      result = await executeRemoteControlCommand(command || {}, { commandId, envelope, delivery });
    }
    if (commandId) {
      await sendCommandAck(commandId, 'completed', {
        commandType,
        result,
        state: await getClassroomCommandStateSnapshot(),
        appliedRevision: application?.appliedRevision,
        outcome: application?.outcome || 'applied',
        deliveryPolicy: delivery.deliveryPolicy,
        expiresAt: delivery.expiresAt,
      });
    }
  } catch (error) {
    console.warn('Error handling remote control command:', error);
    if (commandId) {
      await sendCommandAck(commandId, 'failed', {
        commandType,
        error: commandErrorMessage(error),
        state: await getClassroomCommandStateSnapshot(),
        appliedRevision: currentClassroomState?.revision ?? 0,
        outcome: error?.code === 'UNSUPPORTED_CLASSROOM_STATE_SCHEMA' ? 'unsupported' : 'failed',
        deliveryPolicy: delivery.deliveryPolicy,
        expiresAt: delivery.expiresAt,
      });
    }
    return { rejected: true, error: commandErrorMessage(error) };
  }
}

async function executeRemoteControlCommand(command, executionContext = {}) {
  console.log('Remote control command received:', command);
  const result = {
    commandType: command.type || 'unknown',
    completedAt: new Date().toISOString(),
  };
  command.data = command.data || {};

  switch (command.type) {
      case 'open-tab':
        if (!command.data.url) {
          throw new Error('Missing URL for open-tab command');
        }
        {
          const tab = await chrome.tabs.create({ url: command.data.url, active: true });
          const tabSnapshot = await buildOpaqueTabSnapshot(await chrome.tabs.query({}));
          const openedEntry = tabSnapshot.localEntries.find((entry) => entry.tabId === tab.id);
          result.openedUrl = command.data.url;
          result.tabRef = openedEntry?.tabRef || null;
          result.tabSnapshotRevision = tabSnapshot.revision;
          console.log('Opened tab:', command.data.url);
          // Capture screenshot after tab loads so dashboard updates fast
          setTimeout(() => captureAndSendScreenshot({ reason: 'command' }), 2000);
        }
        break;
        
      case 'close-tabs':
      case 'close-tab':
        if (Array.isArray(command.data.tabRefs) || command.data.tabRef) {
          const exact = await resolveExactTabRefs(
            command.data.tabRefs || [command.data.tabRef],
            command.data.snapshotRevision ?? command.data.tabSnapshotRevision
          );
          let closedCount = 0;
          for (const target of exact.targets) {
            try {
              await chrome.tabs.remove(target.tabId);
              closedCount += 1;
            } catch (error) {
              const closeError = new Error(`Exact tab ${target.tabRef} could not be closed`);
              closeError.code = 'TAB_CLOSE_FAILED';
              throw closeError;
            }
          }
          result.closedTabRefs = exact.targets.map((target) => target.tabRef);
          result.closedCount = closedCount;
          result.tabSnapshotRevision = exact.revision;
          await refreshTabCache();
        } else if (command.data.closeAll) {
          // Close all tabs except chrome:// system tabs and optionally allowed domains
          const tabs = await chrome.tabs.query({});
          const allowedDomains = command.data.allowedDomains || [];
          
          let closedCount = 0;
          for (const tab of tabs) {
            try {
              // Skip chrome:// system pages
              if (tab.url?.startsWith('chrome://')) {
                continue;
              }
              
              // If there are allowed domains, check if tab is on an allowed domain
              if (allowedDomains.length > 0) {
                const tabDomain = extractDomain(tab.url);
                if (tabDomain && allowedDomains.some(allowed => tabDomain.includes(allowed) || allowed.includes(tabDomain))) {
                  continue; // Don't close tabs on allowed domains
                }
              }
              
              // Close the tab
              await chrome.tabs.remove(tab.id);
              closedCount++;
            } catch (error) {
              console.warn('Could not close tab:', tab.id, error);
            }
          }
          result.closeAll = true;
          result.closedCount = closedCount;
          result.allowedDomains = allowedDomains;
          console.log(`Closed ${closedCount} tabs (allowed domains: ${allowedDomains.length > 0 ? allowedDomains.join(', ') : 'none'})`);
        } else if (command.data.specificUrls && Array.isArray(command.data.specificUrls)) {
          // Close tabs matching specific URLs
          const tabs = await chrome.tabs.query({});
          let closedCount = 0;
          for (const tab of tabs) {
            // Skip chrome:// system pages
            if (tab.url?.startsWith('chrome://')) {
              continue;
            }
            
            // Check if this tab's URL matches any of the specificUrls
            if (command.data.specificUrls.includes(tab.url)) {
              try {
                await chrome.tabs.remove(tab.id);
                closedCount++;
                console.log('Closed specific tab:', tab.url);
              } catch (error) {
                console.warn('Could not close tab:', tab.id, error);
              }
            }
          }
          result.specificUrls = command.data.specificUrls;
          result.closedCount = closedCount;
          console.log(`Closed ${closedCount} specific tabs`);
        } else if (command.data.pattern) {
          // Close tabs matching pattern
          const tabs = await chrome.tabs.query({});
          let closedCount = 0;
          for (const tab of tabs) {
            if (tab.url && tab.url.includes(command.data.pattern)) {
              try {
                await chrome.tabs.remove(tab.id);
                closedCount++;
                console.log('Closed tab matching pattern:', tab.url);
              } catch (error) {
                console.warn('Could not close tab:', tab.id, error);
              }
            }
          }
          result.pattern = command.data.pattern;
          result.closedCount = closedCount;
        } else {
          throw new Error('Missing close-tab target');
        }
        // Capture screenshot immediately after closing tabs so dashboard updates fast
        setTimeout(() => captureAndSendScreenshot({ reason: 'command' }), 1500);
        break;

      case 'lock-screen':
        // Handle "CURRENT_URL" special marker - lock to current active tab
        let urlToLock = command.data.url;
        if (urlToLock === "CURRENT_URL") {
          const allTabs = await chrome.tabs.query({});
          const activeTab = allTabs.find(t => t.active) || allTabs[0];
          if (activeTab && activeTab.url) {
            urlToLock = activeTab.url;
            console.log('[Lock Screen] Using current tab URL:', urlToLock);
          } else {
            throw new Error('No active tab found to lock to current URL');
          }
        }
        if (!urlToLock) {
          throw new Error('Missing URL for lock-screen command');
        }
        
        lockedUrl = urlToLock;
        lockedDomain = extractDomain(lockedUrl); // Extract domain for domain-based locking
        if (!lockedDomain) {
          throw new Error('Could not determine locked domain');
        }
        screenLocked = true;
        
        // Persist lock-screen state to survive service worker restarts
        await chrome.storage.local.set({
          lockScreenState: {
            screenLocked: true,
            lockedUrl,
            lockedDomain,
            timestamp: Date.now()
          }
        });
        // Keep any independently applied Flight Path durable underneath the
        // screen-lock overlay. Screen Lock wins enforcement while active;
        // screen-only Unlock recomposes the retained path.
        console.log('[Lock Screen] State persisted to storage');
        
        // Apply network-level blocking rules for single domain
        await updateBlockingRules([lockedDomain]);
        
        // Close all other tabs - keep only the current tab
        const allTabs = await chrome.tabs.query({});
        const activeTab = allTabs.find(t => t.active) || allTabs[0];
        
        if (activeTab) {
          // Close all other tabs
          for (const tab of allTabs) {
            if (tab.id !== activeTab.id && tab.id && !tab.url?.startsWith('chrome://')) {
              try {
                await chrome.tabs.remove(tab.id);
              } catch (error) {
                console.warn('Could not close tab:', tab.id, error);
              }
            }
          }
        }
        
        // Show notification with domain
        safeNotify({
          title: 'Screen Locked',
          message: `Your teacher has locked your screen to the current domain: ${lockedDomain}. You cannot open new tabs or navigate to other websites.`,
          priority: 2,
        });
        
        result.screenLocked = true;
        result.lockedUrl = lockedUrl;
        result.lockedDomain = lockedDomain;
        console.log('Screen locked to domain:', lockedDomain, '(from URL:', lockedUrl + ')');
        break;
        
      case 'unlock-screen':
        {
        const screenOnly = command.data.screenOnly === true || command.screenOnly === true;
        const preserveFlightPath = screenOnly && allowedDomains.length > 0;
        screenLocked = false;
        lockedUrl = null;
        lockedDomain = null;
        if (!screenOnly) {
          allowedDomains = []; // Legacy full unlock clears all lock state
          activeFlightPathName = null;
        }
        
        // Screen-only unlock deliberately preserves an independently applied
        // Flight Path. Legacy clients/commands retain the historical full
        // unlock behavior for mixed 2.5.7 deployments.
        await chrome.storage.local.remove(screenOnly
          ? ['lockScreenState']
          : ['lockScreenState', 'flightPathState']);
        console.log('[Unlock Screen] State cleared from storage');
        
        // Recompose the retained Flight Path immediately. Clearing all
        // classroom rules here would make a screen-only unlock silently lift
        // the still-active path until a later reconciliation.
        if (preserveFlightPath) {
          await updateBlockingRules(allowedDomains);
          await reconcileClassroomStateTabsBestEffort({
            restrictions: classroomRestrictionsFromRuntime(),
          });
        } else {
          await clearBlockingRules();
        }
        
        safeNotify({
          title: 'Screen Unlocked',
          message: preserveFlightPath
            ? 'Your screen lock was removed. Your class Flight Path is still active.'
            : 'Your screen has been unlocked. You can now browse freely.',
          priority: 1,
        });
        
        result.screenLocked = false;
        result.flightPathActive = preserveFlightPath;
        result.screenLockActive = false;
        result.clearedStates = screenOnly ? ['screen-lock'] : ['screen-lock', 'flight-path'];
        result.flightPathPreserved = preserveFlightPath;
        console.log('Screen unlocked');
        break;
        }
        
      case 'apply-flight-path':
        {
          const requestedAllowedDomains = command.data.allowedDomains || [];
          if (!Array.isArray(requestedAllowedDomains) || requestedAllowedDomains.length === 0) {
            throw new Error('Missing allowed domains for Flight Path');
          }

          allowedDomains = RuntimeCore.normalizeDomainList(requestedAllowedDomains, 'Flight Path domains');
          activeFlightPathName = command.data.flightPathName || null;
        }
        // Applying a Flight Path replaces the foreground screen lock while
        // establishing its own independent browsing restriction.
        screenLocked = false;
        lockedUrl = null; // Flight Path uses multiple domains, not a single URL
        lockedDomain = null; // Clear single domain when applying Flight Path
        
        // Persist Flight Path state to survive service worker restarts
        await chrome.storage.local.set({
          flightPathState: {
            screenLocked: false,
            allowedDomains,
            activeFlightPathName,
            timestamp: Date.now()
          }
        });
        await chrome.storage.local.remove('lockScreenState');
        console.log('[Flight Path] State persisted to storage');
        
        // Apply network-level blocking rules
        await updateBlockingRules(allowedDomains);
        
        // Close all tabs except one and navigate to the first allowed domain
        if (allowedDomains.length > 0) {
          const allTabs = await chrome.tabs.query({});
          const activeTab = allTabs.find(t => t.active) || allTabs[0];
          
          // Navigate the first tab to the first allowed domain (prepend https:// if needed)
          const firstDomain = allowedDomains[0];
          const firstUrl = firstDomain.startsWith('http') ? firstDomain : `https://${firstDomain}`;
          
          if (activeTab) {
            // Update the active tab to the first domain
            await chrome.tabs.update(activeTab.id, { url: firstUrl });
            
            // Close all other tabs
            for (const tab of allTabs) {
              if (tab.id !== activeTab.id && !tab.url?.startsWith('chrome://')) {
                await chrome.tabs.remove(tab.id);
              }
            }
          } else {
            // No tabs exist, create one
            await chrome.tabs.create({ url: firstUrl, active: true });
          }
          
          safeNotify({
            title: 'Flight Path Applied',
            message: `Your teacher has applied a flight path. You can only access: ${allowedDomains.join(', ')}`,
            priority: 2,
          });
        }
        
        result.screenLocked = false;
        result.flightPathActive = true;
        result.allowedDomains = allowedDomains;
        result.activeFlightPathName = activeFlightPathName;
        console.log('Flight Path applied with allowed domains:', allowedDomains, 'Name:', activeFlightPathName);
        break;
        
      case 'remove-flight-path':
        allowedDomains = []; // Clear all flight path domains
        activeFlightPathName = null; // Clear Flight Path name
        
        // Clear persisted Flight Path state
        await chrome.storage.local.remove('flightPathState');
        console.log('[Flight Path] State cleared from storage');
        
        // Clear network-level blocking rules
        await clearBlockingRules();
        
        safeNotify({
          title: 'Flight Path Removed',
          message: 'Your teacher has removed the flight path. You can now browse freely.',
          priority: 1,
        });
        
        result.screenLocked = screenLocked;
        result.flightPathActive = false;
        result.clearedStates = ['flight-path'];
        console.log('Flight Path removed - all restrictions cleared');
        break;

      case 'temp-unblock':
        // Temporarily allow access to a blocked domain
        const tempDomain = RuntimeCore.normalizeDomain(command.data.domain);
        const tempExpiresAt = command.data.expiresAt || (Date.now() + 5 * 60 * 1000);
        const tempDuration = command.data.durationMinutes || 5;
        if (!tempDomain) {
          throw new Error('Missing domain for temporary unblock');
        }

        // Add to temporary allowed list
        temporaryAllowedDomains = temporaryAllowedDomains.filter(d => d.domain !== tempDomain);
        temporaryAllowedDomains.push({ domain: tempDomain, expiresAt: tempExpiresAt });
        await updateTemporaryAllowRules(temporaryAllowedDomains);

        safeNotify({
          title: 'Temporary Access Granted',
          message: `Your teacher has temporarily unblocked ${tempDomain} for ${tempDuration} minutes.`,
          priority: 1,
        });

        result.domain = tempDomain;
        result.expiresAt = tempExpiresAt;
        result.durationMinutes = tempDuration;
        console.log('[Temp Unblock] Temporarily allowed domain:', tempDomain, 'until', new Date(tempExpiresAt));
        break;

      case 'apply-block-list':
        if (!Array.isArray(command.data.blockedDomains || [])) {
          throw new Error('Invalid block list domains');
        }
        teacherBlockedDomains = RuntimeCore.normalizeDomainList(
          command.data.blockedDomains || [],
          'teacher block list'
        );
        activeBlockListName = command.data.blockListName || null;

        // The revisioned full snapshot is persisted after this legacy command.
        await updateTeacherBlockListRules(teacherBlockedDomains);

        if (teacherBlockedDomains.length > 0) {
          safeNotify({
            title: 'Block List Applied',
            message: `Your teacher has blocked: ${teacherBlockedDomains.slice(0, 3).join(', ')}${teacherBlockedDomains.length > 3 ? '...' : ''}`,
            priority: 1,
          });
        }

        result.activeBlockListName = activeBlockListName;
        result.blockedDomains = teacherBlockedDomains;
        console.log('[Block List] Teacher block list applied (session-based):', activeBlockListName, teacherBlockedDomains);
        break;

      case 'remove-block-list':
        teacherBlockedDomains = [];
        activeBlockListName = null;

        // Clear teacher block list rules (keeps global blacklist)
        await clearTeacherBlockListRules();
        
        safeNotify({
          title: 'Block List Removed',
          message: 'Your teacher has removed the block list.',
          priority: 1,
        });
        
        result.activeBlockListName = null;
        result.blockedDomains = [];
        result.clearedStates = ['block-list'];
        console.log('[Block List] Teacher block list removed');
        break;
        
      case 'limit-tabs':
        {
          const requestedLimit = Number(command.data.maxTabs);
          const normalizedLimit = Number.isSafeInteger(requestedLimit) && requestedLimit > 0
            ? Math.min(requestedLimit, 1000)
            : null;
          const authority = commandAuthority(command, executionContext.envelope);
          if (authority.kind === 'school_policy') {
            schoolMaxTabs = normalizedLimit;
          } else {
            teacherMaxTabs = normalizedLimit;
          }
          currentMaxTabs = effectiveTabLimit();
        }
        
        // Close excess tabs if over limit
        if (currentMaxTabs) {
          const tabs = await chrome.tabs.query({});
          if (tabs.length > currentMaxTabs) {
            // Close oldest tabs first (keep most recent)
            const tabsToClose = tabs.slice(0, tabs.length - currentMaxTabs);
            for (const tab of tabsToClose) {
              if (!tab.url.startsWith('chrome://')) {
                await chrome.tabs.remove(tab.id);
              }
            }
          }
        }
        
        result.currentMaxTabs = currentMaxTabs;
        console.log('Tab limit set to:', currentMaxTabs);
        break;

      case 'attention-mode':
        // Show/hide attention overlay on all tabs (fire-and-forget for instant response)
        const attentionActive = command.data.active;
        const attentionMessage = command.data.message || 'Please look up!';

        // Update attention mode state (blocks navigation and new tabs when active)
        attentionModeActive = attentionActive;
        await composeDynamicRules(['classroom']);

        // Fire-and-forget - don't await to avoid any delay
        broadcastToAllTabs('attention-mode', { active: attentionActive, message: attentionMessage });

        if (attentionActive) {
          safeNotify({
            title: 'Attention Required',
            message: attentionMessage,
            priority: 2,
          });
        }

        result.active = attentionActive;
        result.message = attentionMessage;
        console.log('Attention mode:', attentionActive ? 'ON' : 'OFF', attentionMessage);
        break;

      case 'timer':
        const timerAction = command.data.action;
        const timerSeconds = command.data.seconds;
        const timerMessage = command.data.message || '';
        const timerState = await persistTimerOverlay(command, executionContext);
        const timerEndsAt = timerState?.timer?.endsAt || null;

        broadcastToAllTabs('timer', {
          action: timerAction,
          seconds: timerSeconds,
          message: timerMessage,
          endsAt: timerEndsAt,
          teachingSessionId: timerState?.timer?.teachingSessionId || null,
        });

        if (timerAction === 'start') {
          safeNotify({
            title: 'Timer Started',
            message: `${Math.floor(timerSeconds / 60)}:${String(timerSeconds % 60).padStart(2, '0')} remaining`,
            priority: 1,
          });
        }

        result.action = timerAction;
        result.seconds = timerSeconds;
        result.message = timerMessage;
        result.endsAt = timerEndsAt;
        console.log('Timer:', timerAction, timerSeconds, 'seconds');
        break;

      case 'poll':
        // Show/hide poll overlay on all tabs (fire-and-forget for instant response)
        const pollAction = command.data.action;
        const pollId = command.data.pollId;
        const pollQuestion = command.data.question;
        const pollOptions = command.data.options;

        // The persisted poll is the restart-safe dedup boundary. The short
        // in-memory set only avoids duplicate same-turn broadcasts.
        if (pollAction === 'start' && seenPollIds.has(pollId)) {
          console.log('Poll dedup: already shown', pollId);
          result.action = pollAction;
          result.pollId = pollId;
          result.deduplicated = true;
          break;
        }
        if (pollAction === 'start') {
          seenPollIds.add(pollId);
          // Clean up after 60 seconds
          setTimeout(() => seenPollIds.delete(pollId), 60000);
        }
        if (pollAction === 'close') {
          seenPollIds.delete(pollId);
        }

        const pollState = await persistPollOverlay(command, executionContext);

        broadcastToAllTabs('poll', {
          action: pollAction,
          pollId,
          question: pollQuestion,
          options: pollOptions,
          expiresAt: pollState?.poll?.expiresAt || null,
          teachingSessionId: pollState?.poll?.teachingSessionId || null,
        });

        if (pollAction === 'start') {
          safeNotify({
            title: 'Poll',
            message: pollQuestion,
            priority: 2,
          });
        }

        result.action = pollAction;
        result.pollId = pollId;
        result.question = pollQuestion;
        console.log('Poll:', pollAction, pollId);
        break;

      case 'chat-notification':
        // Show chat notification overlay on all tabs (fire-and-forget for instant response)
        const chatMessage = command.data.message;
        const chatFromName = command.data.fromName;

        // Fire-and-forget - don't await to avoid any delay
        broadcastToAllTabs('chat-notification', { message: chatMessage, fromName: chatFromName });

        result.messageDelivered = true;
        result.fromName = chatFromName;
        console.log('Chat notification sent:', chatFromName, chatMessage);
        break;

      case 'hand-dismissed':
        // Notify student their hand was acknowledged
        await updateLocalFabHandRaised(false, 'hand-dismissed');

        // Fire-and-forget - don't await to avoid any delay
        broadcastToAllTabs('hand-dismissed', command.data || {});

        result.handRaised = false;
        console.log('Hand dismissed notification sent');
        break;

      case 'messaging-toggle':
        // Update local storage with messaging enabled state
        const messagingEnabled = command.data.messagingEnabled ?? command.data.enabled;
        const messagingRevision = Number(command.data.revision);
        await applyFabSettings({
          ...(currentFabState || {}),
          messagingEnabled,
          ...(Number.isSafeInteger(messagingRevision) && messagingRevision >= 0
            ? { revision: messagingRevision, lifecycleRevision: messagingRevision }
            : {}),
          reason: 'messaging-toggle',
        });

        // Fire-and-forget - don't await to avoid any delay
        broadcastToAllTabs('messaging-toggle', { ...(command.data || {}), enabled: messagingEnabled });

        result.messagingEnabled = messagingEnabled;
        console.log('Messaging toggle sent:', messagingEnabled);
        break;

      case 'hand-raising-toggle':
        // Update local storage with hand raising enabled state
        const handRaisingEnabled = command.data.enabled;
        const handRevision = Number(command.data.revision);
        await applyFabSettings({
          ...(currentFabState || {}),
          handRaisingEnabled,
          ...(Number.isSafeInteger(handRevision) && handRevision >= 0
            ? { revision: handRevision, lifecycleRevision: handRevision }
            : {}),
          reason: 'hand-raising-toggle',
        });

        // Fire-and-forget - don't await to avoid any delay
        broadcastToAllTabs('hand-raising-toggle', { ...(command.data || {}), enabled: handRaisingEnabled });

        result.handRaisingEnabled = handRaisingEnabled;
        console.log('Hand raising toggle sent:', handRaisingEnabled);
        break;

      case 'fab-state-sync':
      case 'fab-state':
        // Apply session lifecycle state pushed by SchoolPilot when classes start/end.
        const fabStateData = command.data || {};
        const appliedFabState = await applyFabSettings(fabStateData);

        result.fabState = appliedFabState;
        console.log('FAB state updated:', fabStateData.reason || 'state-refresh');
        break;

      case 'student-sign-out':
        {
          const signOutReason = command.data.reason || 'teacher-sign-out';
          await applyFabSettings({
            messagingEnabled: false,
            handRaisingEnabled: false,
            handRaised: false,
            activeSessionIds: [],
            activeHands: [],
            sessions: [],
            sessionId: command.data.sessionId || '',
            reason: signOutReason,
          });
          await chrome.storage.local.set({
            fabChatMessages: [],
            fabChatClosed: false,
          });
          await clearStudentAuth(signOutReason, {
            notifyBackend: false,
            pauseAutoRegistration: true,
            disconnectWebSocket: false,
          });
          setTimeout(() => {
            disconnectWebSocket();
          }, 250);

          result.signedOut = true;
          result.reason = signOutReason;
          result.sessionId = command.data.sessionId || null;
          console.log('[Sign Out] Teacher-forced student sign-out applied');
        }
        break;

      default:
        throw new Error(`Unsupported remote control command: ${command.type || 'unknown'}`);
    }

  return {
    ...result,
    state: await getClassroomCommandStateSnapshot(),
  };
}

// Track which tabs have content script injected to avoid repeated injection attempts
const injectedTabs = new Set();

// Helper function to ensure content script is injected (optimized for speed)
async function ensureContentScriptInjected(tabId) {
  // Skip if we already know content script is injected
  if (injectedTabs.has(tabId)) {
    return;
  }

  // Try to inject the content script directly (faster than ping-then-inject)
  try {
    await chrome.scripting.executeScript({
      target: { tabId: tabId },
      files: ['content.js']
    });
    injectedTabs.add(tabId);
  } catch (injectError) {
    // Script might already be injected or tab doesn't support scripting
    // Either way, mark as "attempted" to avoid repeated failures
    injectedTabs.add(tabId);
  }
}

// Clean up injectedTabs when tabs are closed
chrome.tabs.onRemoved.addListener((tabId) => {
  injectedTabs.delete(tabId);
});

// Helper function to broadcast message to all tabs in parallel (fastest delivery)
async function broadcastToAllTabs(messageType, messageData) {
  const tabs = await chrome.tabs.query({});
  const validTabs = tabs.filter(tab =>
    tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')
  );

  // Immediate fire-and-forget to all tabs for fastest possible delivery
  // Don't wait for injection - just try to send immediately
  for (const tab of validTabs) {
    // Try to send message immediately (content script might already be loaded)
    chrome.tabs.sendMessage(tab.id, {
      type: messageType,
      data: messageData
    }).catch(() => {
      // If send fails, inject content script and retry once
      chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ['content.js']
      }).then(() => {
        injectedTabs.add(tab.id);
        // Retry sending after injection
        chrome.tabs.sendMessage(tab.id, {
          type: messageType,
          data: messageData
        }).catch(() => {}); // Ignore final errors
      }).catch(() => {}); // Ignore injection errors
    });
  }
}

// Chat/Message Handlers (Phase 2)
function messageMatchesActiveFabSession(message = {}) {
  const sessionId = String(message.sessionId || message.teachingSessionId || '').trim();
  if (!sessionId) return true; // Legacy 2.5.7-compatible announcements
  if (currentClassroomState?.teachingSessionId || currentClassroomState?.supervisionContextId) {
    return !currentClassroomState.supervisionContextId
      && currentClassroomState.teachingSessionId === sessionId;
  }
  const activeSessions = activeTeachingSessionIds();
  if (activeSessions.length === 0) return !currentFabState;
  return activeSessions.includes(sessionId);
}

async function handleChatMessage(message) {
  console.log('Chat message received:', message);

  if (!acceptsCurrentStudentBinding(message, 'teacher chat message')) return;

  if (!messageMatchesActiveFabSession(message)) {
    console.warn('[FAB] Ignoring chat for an inactive teaching session');
    return;
  }

  const expectedBinding = messageInboxAuthBinding();
  const inboxMessage = messageWithStableLocalId(message, 'chat');
  const inboxResult = await persistTeacherMessages([inboxMessage], {
    reason: 'websocket-chat',
    expectedBinding,
  });
  if (!inboxResult.addedMessageIds.includes(inboxMessage.id)) {
    console.log('Dedup: skipping duplicate chat message', inboxMessage.id);
    return;
  }

  // Show browser notification immediately (fastest feedback)
  safeNotify({
    title: `Message from ${inboxMessage.fromName || 'Teacher'}`,
    message: inboxMessage.message,
    priority: 2,
    requireInteraction: false,
  });

  // Fire-and-forget broadcast to all tabs for instant delivery
  broadcastToAllTabs('show-message', {
    id: inboxMessage.id,
    message: inboxMessage.message,
    fromName: inboxMessage.fromName || 'Teacher',
    timestamp: inboxMessage.timestamp || Date.now(),
  });
}

async function handleDurableTeacherMessage(message, options = {}) {
  const expectedBinding = options.expectedBinding || messageInboxAuthBinding();
  const commandId = getCommandIdFromMessage(message);
  const hasChatDelivery = !commandId || Boolean(message.chatDeliveryId || message.deliveryId);
  const delivery = RuntimeCore.commandDeliveryState(
    { type: 'teacher-message', ...message.command },
    message,
    Date.now()
  );
  try {
    assertCurrentStudentBinding(message, 'durable teacher message');
    if (!expectedBinding || expectedBinding !== messageInboxAuthBinding()) {
      throw new Error('Teacher message belongs to a retired student session');
    }
    if (commandId) {
      assertCurrentCommandAuthority({
        type: 'teacher-message',
        authority: message.authority,
        teachingSessionId: message.teachingSessionId,
        supervisionContextId: message.supervisionContextId,
        ...message.command,
      }, message);
    }
    if (!messageMatchesActiveFabSession(message)) {
      throw new Error('Teacher message belongs to an inactive teaching session');
    }
    if (commandId) {
      await sendCommandAck(commandId, 'received', {
        commandType: 'teacher-message',
        deliveryPolicy: delivery.deliveryPolicy,
        expiresAt: delivery.expiresAt,
      });
    }
    assertCurrentStudentBinding(message, 'durable teacher message');
    const inboxMessage = messageWithStableLocalId(message, 'teacher-message');
    const inboxResult = await persistTeacherMessages([inboxMessage], {
      reason: 'websocket-teacher-message',
      expectedBinding,
    });
    const deduplicated = !inboxResult.addedMessageIds.includes(inboxMessage.id);

    if (deduplicated) {
      console.log('Dedup: skipping duplicate teacher-message', inboxMessage.id);
    } else {
      safeNotify({
        title: 'Reply from Teacher',
        message: inboxMessage.message || 'New message',
        priority: 2,
        requireInteraction: false,
      });
      broadcastToAllTabs('chat-reply', {
        _msgId: inboxMessage.id,
        chatMessageId: message.chatMessageId || message.messageId || inboxMessage.id,
        messageId: message.chatMessageId || message.messageId || inboxMessage.id,
        sessionId: message.sessionId,
        studentId: message.studentId,
        message: inboxMessage.message,
        fromName: inboxMessage.fromName || 'Teacher',
        timestamp: inboxMessage.timestamp || Date.now(),
      });
    }

    if (hasChatDelivery) {
      await sendChatDeliveryAck(message, 'delivered').catch((error) => {
        console.warn('[Chat ACK] Could not persist delivered acknowledgement:', error?.message || error);
      });
    }
    if (commandId) {
      await sendCommandAck(commandId, 'completed', {
        commandType: 'teacher-message',
        result: deduplicated
          ? { deduplicated: true }
          : {
              delivered: true,
              messageLength: String(inboxMessage.message || '').length,
            },
        state: await getClassroomCommandStateSnapshot(),
        deliveryPolicy: delivery.deliveryPolicy,
        expiresAt: delivery.expiresAt,
      });
    }
    return { messageId: inboxMessage.id, deduplicated };
  } catch (error) {
    if (hasChatDelivery) {
      await sendChatDeliveryAck(message, 'failed', commandErrorMessage(error)).catch(() => {});
    }
    if (commandId) {
      await sendCommandAck(commandId, 'failed', {
        commandType: 'teacher-message',
        error: commandErrorMessage(error),
        state: await getClassroomCommandStateSnapshot(),
        deliveryPolicy: delivery.deliveryPolicy,
        expiresAt: delivery.expiresAt,
      });
    }
    throw error;
  }
}

async function handleHeartbeatPendingMessages(rawMessages, expectedBinding) {
  const legacyMessages = [];
  const addedMessageIds = [];
  for (const rawMessage of rawMessages || []) {
    if (!getCommandIdFromMessage(rawMessage)) {
      legacyMessages.push(rawMessage);
      continue;
    }
    const teachingSessionId = String(rawMessage.teachingSessionId || '').trim() || null;
    const supervisionContextId = String(rawMessage.supervisionContextId || '').trim() || null;
    try {
      const result = await handleDurableTeacherMessage({
        ...rawMessage,
        type: 'teacher-message',
        _msgId: rawMessage.id,
        messageId: rawMessage.id,
        chatMessageId: rawMessage.id,
        sessionId: teachingSessionId,
        teachingSessionId,
        supervisionContextId,
        authority: rawMessage.authority || { teachingSessionId, supervisionContextId },
        studentId: CONFIG.activeStudentId,
        fromName: rawMessage.fromName || 'Teacher',
      }, { expectedBinding });
      if (!result.deduplicated) addedMessageIds.push(result.messageId);
    } catch (error) {
      console.warn('[Heartbeat] Durable teacher message was not applied:', error?.message || error);
    }
  }

  if (legacyMessages.length > 0) {
    const legacyResult = await persistHeartbeatPendingMessages(legacyMessages, expectedBinding);
    addedMessageIds.push(...legacyResult.addedMessageIds);
  }
  return { addedMessageIds };
}

// Check-in Request Handler (Phase 3)
async function handleCheckInRequest(request) {
  console.log('Check-in request received:', request);
  
  // Show notification with check-in question
  safeNotify({
    title: 'Teacher Check-in',
    message: request.question,
    priority: 2,
    requireInteraction: true,
  });
  
  // Store check-in request for popup to display
  await chrome.storage.local.set({
    pendingCheckIn: {
      question: request.question,
      options: request.options,
      timestamp: Date.now(),
    },
  });
}

// Prevent navigation when screen is locked (domain-based blocking)
chrome.webNavigation.onBeforeNavigate.addListener(async (details) => {
  try {
  await classroomStateRestorePromise;
  // Only check main frame navigations
  if (details.frameId !== 0) return;

  // Allow chrome:// URLs
  if (details.url.startsWith('chrome://') || details.url.startsWith('about:')) {
    return;
  }

  // Block ALL navigation when attention mode is active
  if (attentionModeActive) {
    console.log('[Attention Mode] Blocked navigation to:', details.url);
    enqueueMonitoringEvent('navigation_blocked', {
      url: details.url,
      title: '',
      policySource: 'attention_mode',
    }).catch(() => {});

    chrome.tabs.goBack(details.tabId).catch(() => {
      // If can't go back, just stay on current page
    });

    return;
  }

  const targetDomain = extractDomain(details.url);
  if (!targetDomain) return;

  // Clean up expired temporary allowed domains
  const now = Date.now();
  if (temporaryAllowedDomains.some((item) => item.expiresAt <= now)) {
    await checkClassroomStateExpiry();
  }

  // School policy is authoritative. A teacher temporary allow may bypass a
  // teacher block, but it must never bypass a school-wide block. Keep this
  // imperative fallback in the same order as the serialized DNR priorities.
  if (globalBlockedDomains.length > 0) {
    const isBlacklisted = globalBlockedDomains.some(blockedDomain => {
      const normalizedBlocked = blockedDomain.replace(/^www./, '');
      return targetDomain === normalizedBlocked || targetDomain.endsWith('.' + normalizedBlocked);
    });
    
    if (isBlacklisted) {
      console.log('[Blacklist] Blocked navigation to:', details.url);
      enqueueMonitoringEvent('navigation_blocked', {
        url: details.url,
        title: '',
        policySource: 'school',
      }).catch(() => {});
      
      // Go back or close the tab
      chrome.tabs.goBack(details.tabId).catch(() => {
        // If can't go back, try to navigate to a safe page
        chrome.tabs.update(details.tabId, { url: 'about:blank' });
      });
      
      // Show notification
      safeNotify({
        title: 'Website Blocked',
        message: `Access to ${targetDomain} is blocked by your school.`,
        priority: 2,
      });
      return;
    }
  }

  // Screen Lock is the foreground teacher control. It permits only its exact
  // target domain and cannot be widened by a retained temporary unblock or
  // teacher block-list state. School policy above remains authoritative.
  if (screenLocked) {
    if (lockedDomain && isOnSameDomain(details.url, lockedDomain)) return;
    console.log('[Screen Lock] Blocked navigation to:', details.url);
    enqueueMonitoringEvent('navigation_blocked', {
      url: details.url,
      title: '',
      policySource: 'screen_lock',
    }).catch(() => {});
    if (lockedUrl) {
      chrome.tabs.update(details.tabId, { url: lockedUrl });
    } else {
      chrome.tabs.goBack(details.tabId).catch(() => {
        chrome.tabs.update(details.tabId, { url: 'about:blank' });
      });
    }
    safeNotify({
      title: 'Navigation Blocked',
      message: lockedDomain
        ? `You can only browse within ${lockedDomain}`
        : 'Your screen is locked by your teacher.',
      priority: 2,
    });
    return;
  }

  // Check if domain is temporarily allowed after school policy has had the
  // opportunity to block it.
  const isTempAllowed = temporaryAllowedDomains.some(d => {
    const normalizedAllowed = d.domain.replace(/^www\./, '');
    return targetDomain === normalizedAllowed || targetDomain.endsWith('.' + normalizedAllowed);
  });

  if (isTempAllowed) {
    console.log('[Temp Unblock] Allowing temporarily unblocked domain:', targetDomain);
    return; // Allow navigation
  }

  // Check teacher block list (session-based)
  if (teacherBlockedDomains.length > 0) {
    const isTeacherBlocked = teacherBlockedDomains.some(blockedDomain => {
      const normalizedBlocked = blockedDomain.replace(/^www./, '');
      return targetDomain === normalizedBlocked || targetDomain.endsWith('.' + normalizedBlocked);
    });
    
    if (isTeacherBlocked) {
      console.log('[Teacher Block List] Blocked navigation to:', details.url);
      enqueueMonitoringEvent('navigation_blocked', {
        url: details.url,
        title: '',
        policySource: 'teacher',
      }).catch(() => {});
      
      chrome.tabs.goBack(details.tabId).catch(() => {
        chrome.tabs.update(details.tabId, { url: 'about:blank' });
      });
      
      safeNotify({
        title: 'Website Blocked',
        message: `Access to ${targetDomain} is blocked by your teacher.`,
        priority: 2,
      });
      return;
    }
  }
  
  // With no foreground Screen Lock, the independently retained Flight Path
  // continues to constrain navigation (subject to temporary allows above).
  if (allowedDomains.length > 0) {
    let isAllowed = false;
    let blockedMessage = '';
    
    isAllowed = allowedDomains.some(domain => isOnSameDomain(details.url, domain));
    blockedMessage = `You can only access: ${allowedDomains.join(', ')}`;
    
    if (!isAllowed) {
      // Redirect back to locked URL or prevent navigation
      console.log('Blocked navigation to:', details.url);
      enqueueMonitoringEvent('navigation_blocked', {
        url: details.url,
        title: '',
        policySource: 'flight_path',
      }).catch(() => {});
      
      // If we have a single locked URL, redirect to it
      if (lockedUrl) {
        chrome.tabs.update(details.tabId, { url: lockedUrl });
      } else {
        // For scenes without a specific locked URL, just prevent navigation
        chrome.tabs.goBack(details.tabId).catch(() => {
          // If can't go back, stay where we are
        });
      }
      
      // Show warning notification
      safeNotify({
        title: 'Navigation Blocked',
        message: blockedMessage,
        priority: 1,
      });
      return;
    }
  }
  } catch (error) {
    console.warn('[Service Worker] Navigation handler error:', error?.message || error);
  }
});

// Track navigation commits for instant URL updates (fires immediately when navigation commits)
chrome.webNavigation.onCommitted.addListener(async (details) => {
  try {
    await classroomStateRestorePromise;
    // Only track main frame navigations
    if (details.frameId !== 0) return;
    if (isHttpUrl(details.url)) {
      enforceAuthGateForTab(details.tabId).catch(() => {});
    }
    if (trackingState === TRACKING_STATES.OFF) return;

    // Skip Chrome internal pages
    if (!details.url.startsWith('http')) return;

    // Send immediate heartbeat - this fires the moment navigation commits
    // (before page is loaded, so teacher sees URL change instantly)
    safeSendHeartbeat('navigation-committed');
  } catch (error) {
    console.warn('[Service Worker] Navigation committed handler error:', error?.message || error);
  }
});

// Enforce tab limit and screen lock
chrome.tabs.onCreated.addListener(async (tab) => {
  try {
    await classroomStateRestorePromise;
    enforceAuthGateForTab(tab).catch(() => {});

    // Block new tabs when attention mode is active
    if (attentionModeActive) {
      if (tab.id) {
        enqueueMonitoringEvent('navigation_blocked', {
          url: tab.pendingUrl || tab.url || '',
          title: tab.title || '',
          policySource: 'attention_mode',
        }).catch(() => {});
        chrome.tabs.remove(tab.id);
        console.log('[Attention Mode] Blocked new tab creation');
      }
      return;
    }

    // First check: if screen is locked to a SINGLE domain/URL, prevent opening new tabs entirely
    // BUT if it's a scene (multiple allowed domains), allow new tabs - navigation will be checked separately
    if (screenLocked && lockedDomain) {
      // Single domain lock mode - block all new tabs
      if (tab.id) {
        enqueueMonitoringEvent('navigation_blocked', {
          url: tab.pendingUrl || tab.url || '',
          title: tab.title || '',
          policySource: 'screen_lock',
        }).catch(() => {});
        chrome.tabs.remove(tab.id);

        let message = `Your screen is locked to ${lockedDomain}. You cannot open new tabs.`;

        safeNotify({
          title: 'Screen Locked',
          message: message,
          priority: 2,
        });
      }
      return; // Don't check tab limit if screen is locked
    }

    // For scene mode (allowedDomains.length > 0), allow new tabs
    // Navigation restrictions will be enforced by onBeforeNavigate listener

    // Second check: enforce tab limit (only if screen is not locked)
    if (currentMaxTabs) {
      const tabs = await chrome.tabs.query({});
      if (tabs.length > currentMaxTabs) {
        // Close the newly created tab if over limit
        enqueueMonitoringEvent('navigation_blocked', {
          url: tab.pendingUrl || tab.url || '',
          title: tab.title || '',
          policySource: 'tab_limit',
        }).catch(() => {});
        chrome.tabs.remove(tab.id);

        safeNotify({
          title: 'Tab Limit Reached',
          message: `You can only have ${currentMaxTabs} tabs open at a time.`,
          priority: 1,
        });
      }
    }

    // Refresh tab cache when a new tab is created
    refreshTabCache();
  } catch (error) {
    console.warn('[Service Worker] Tab created handler error:', error?.message || error);
  }
});

// Refresh tab cache when tabs are removed
chrome.tabs.onRemoved.addListener(() => {
  refreshTabCache();
});

// ============================================================================
// OFFSCREEN DOCUMENT MANAGEMENT (MV3 WebRTC)
// ============================================================================
// In MV3, service workers don't have access to WebRTC/Media APIs
// All WebRTC logic moved to offscreen.js which runs in a page context

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) return;
  if (creatingOffscreen) return creatingOffscreen;

  creatingOffscreen = (async () => {
    try {
      await chrome.offscreen.createDocument({
        url: 'offscreen.html',
        reasons: ['USER_MEDIA', 'DISPLAY_MEDIA', 'BLOBS'],
        justification: 'Screen capture, WebRTC, and WebSocket must run in page context for MV3 compatibility'
      });
      console.log('[Service Worker] Offscreen document created');
    } catch (error) {
      // Chrome reports an existing-document error if another worker wake won
      // the race. Verify the context before treating it as a real failure.
      if (!await hasOffscreenDocument()) {
        console.warn('[Service Worker] Offscreen document creation failed:', error?.message || error);
        throw error;
      }
    } finally {
      creatingOffscreen = null;
    }
  })();
  return creatingOffscreen;
}

async function hasOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL('offscreen.html');
  if (typeof chrome.runtime.getContexts === 'function') {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [offscreenUrl],
    });
    return contexts.length > 0;
  }
  if (typeof chrome.offscreen.hasDocument === 'function') {
    return chrome.offscreen.hasDocument();
  }
  if (globalThis.clients?.matchAll) {
    const clients = await globalThis.clients.matchAll();
    return clients.some((client) => client.url === offscreenUrl);
  }
  return offscreenReady;
}

async function closeOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    await chrome.offscreen.closeDocument();
  }
  creatingOffscreen = null;
  offscreenReady = false;
}

// Send message to offscreen with retry if not ready
async function sendToOffscreen(message) {
  await ensureOffscreenDocument();
  
  // Wait for offscreen to be ready if not yet
  if (!offscreenReady) {
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  
  let response;
  try {
    response = await chrome.runtime.sendMessage(message);
  } catch (error) {
    offscreenReady = false;
    const rpcError = new Error(`Offscreen RPC failed: ${error?.message || error}`);
    rpcError.code = 'OFFSCREEN_RPC_FAILED';
    throw rpcError;
  }
  if (!response || response.success !== true) {
    const rpcError = new Error(response?.error || `Offscreen ${message.type} failed`);
    rpcError.code = response?.code || 'OFFSCREEN_RPC_REJECTED';
    throw rpcError;
  }
  return response;
}

// WebRTC: Handle screen share request from teacher (orchestrate via offscreen)
async function handleScreenShareRequest(
  mode = 'auto',
  negotiationId = null,
  setupExpiresAt = null,
  expiresAt = null,
) {
  try {
    if (!negotiationId || negotiationId !== activeLiveViewNegotiationId) return;
    console.log('[WebRTC] Teacher requested screen share, mode:', mode);

    // Ensure offscreen document exists
    await ensureOffscreenDocument();

    // MV3: Get a stream ID from the service worker via tabCapture.getMediaStreamId
    // This is the correct MV3 approach - tabCapture.capture() doesn't work in offscreen docs
    // On managed browsers with TabCaptureAllowedByOrigins policy, this enables silent capture
    let streamId = null;
    if (mode === 'auto' || mode === 'tab') {
      try {
        const [activeTab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (activeTab?.id) {
          // Try without consumerTabId first (for offscreen document consumption)
          try {
            streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: activeTab.id });
            console.log('[WebRTC] Got tab capture stream ID (method 1) for tab:', activeTab.id);
          } catch (e1) {
            console.info('[WebRTC] Method 1 failed:', e1.message, '- trying without targetTabId');
            // Some Chrome versions need no targetTabId for offscreen docs
            try {
              streamId = await chrome.tabCapture.getMediaStreamId({});
              console.log('[WebRTC] Got tab capture stream ID (method 2, no target)');
            } catch (e2) {
              console.info('[WebRTC] Method 2 also failed:', e2.message);
            }
          }
        } else {
          console.info('[WebRTC] No active tab found for tab capture');
        }
      } catch (tabErr) {
        console.info('[WebRTC] tabCapture.getMediaStreamId failed:', tabErr.message);
      }
    }

    // Tell offscreen to start capture with the streamId (if available)
    const result = await sendToOffscreen({
      type: 'START_SHARE',
      deviceId: CONFIG.deviceId,
      mode: mode,
      streamId: streamId,
      negotiationId,
      setupExpiresAt,
      expiresAt,
    });

    if (!result?.success) {
      await stopScreenShare({ reason: result?.status || 'capture-start-failed' });
      // Check if this is an expected failure (user denied, etc.)
      if (result?.status === 'user-denied') {
        console.info('[WebRTC] User denied screen share (expected behavior)');
        return;
      } else if (result?.status === 'tab-capture-unavailable') {
        console.info('[WebRTC] Silent tab capture not available (expected on unmanaged devices)');
        return;
      } else {
        // Unexpected error
        console.warn('[WebRTC] Unexpected screen share error:', result?.error);
        safeNotify({
          title: 'Screen Sharing Error',
          message: 'Unable to share screen: ' + (result?.error || 'Unknown error'),
        });
        return;
      }
    }

    if (negotiationId !== activeLiveViewNegotiationId) {
      await sendToOffscreen({ type: 'STOP_SHARE' }).catch(() => {});
      return;
    }
    setObservedState(true, 'teacher-request');
    console.log('[WebRTC] Screen capture initiated in offscreen document');

  } catch (error) {
    await stopScreenShare({ reason: 'capture-start-error' });
    // Only unexpected errors reach here
    console.warn('[WebRTC] Unexpected screen share request error:', error);
    safeNotify({
      title: 'Screen Sharing Error',
      message: 'Unable to share screen: ' + error.message,
    });
  }
}

// WebRTC: Handle stop screen share request from teacher
async function handleStopScreenShare(negotiationId = null) {
  try {
    if (!negotiationId || negotiationId !== activeLiveViewNegotiationId) return;
    console.log('[WebRTC] Teacher requested to stop screen share');
    setObservedState(false, 'teacher-stop');
    
    // Tell offscreen to stop sharing and clean up
    const result = await sendToOffscreen({
      type: 'STOP_SHARE'
    });
    
    if (result?.success) {
      console.log('[WebRTC] Screen share stopped successfully');
    } else {
      console.info('[WebRTC] Stop share completed with status:', result?.status);
    }
    if (activeLiveViewNegotiationId === negotiationId) {
      activeLiveViewNegotiationId = null;
      activeLiveViewTeachingSessionId = null;
    }
    
  } catch (error) {
    console.warn('[WebRTC] Error stopping screen share:', error);
  } finally {
    if (activeLiveViewNegotiationId === negotiationId) {
      activeLiveViewNegotiationId = null;
      activeLiveViewTeachingSessionId = null;
    }
  }
}

// WebRTC: Handle offer from teacher (forward to offscreen)
async function handleOffer(sdp, from, negotiationId) {
  try {
    if (!negotiationId || negotiationId !== activeLiveViewNegotiationId) return;
    console.log('[WebRTC] Forwarding offer to offscreen document');
    
    const response = await sendToOffscreen({
      type: 'SIGNAL',
      payload: { type: 'offer', sdp: sdp, from: from, negotiationId }
    });
    
    if (!response?.success) {
      // Expected: peer connection not ready yet (normal when student hasn't started sharing)
      if (response?.status === 'no-peer-yet') {
        console.info('[WebRTC] Offer received before peer ready (expected - ignoring)');
        return;
      }
      // Expected: queued for later processing
      if (response?.status === 'queued') {
        console.info('[WebRTC] Offer queued until peer connection ready (expected)');
        return;
      }
      // Unexpected error only
      console.warn('[WebRTC] Unexpected offer handling error:', response?.error);
      return;
    }
    
    console.log('[WebRTC] Offer handled in offscreen document');
  } catch (error) {
    // Only unexpected errors reach here
    console.warn('[WebRTC] Unexpected error handling offer:', error);
  }
}

// WebRTC: Handle ICE candidate from teacher (forward to offscreen)
async function handleIceCandidate(candidate, negotiationId) {
  try {
    if (!negotiationId || negotiationId !== activeLiveViewNegotiationId) return;
    const response = await sendToOffscreen({
      type: 'SIGNAL',
      payload: { type: 'ice', candidate: candidate, negotiationId }
    });
    
    // Expected: ICE candidates can arrive before peer is ready or be queued
    if (response?.status === 'queued' || response?.status === 'late-candidate') {
      console.info('[WebRTC] ICE candidate queued/late (expected)');
      return;
    }
    
  } catch (error) {
    // Expected: ICE candidates can arrive when offscreen isn't ready
    console.info('[WebRTC] ICE candidate handling deferred (expected during initialization)');
  }
}

// WebRTC: Stop screen sharing (cleanup in offscreen)
async function stopScreenShare(options = {}) {
  const negotiationId = activeLiveViewNegotiationId;
  if (negotiationId && options.notifyServer !== false) {
    wsSend({
      type: 'stop-share',
      to: 'teacher',
      negotiationId,
      reason: options.reason || 'student-capture-stopped',
    });
  }
  try {
    console.log('[WebRTC] Stopping screen share');
    await sendToOffscreen({
      type: 'STOP_SHARE'
    });
    // The offscreen document also owns the durable student WebSocket. Keep it
    // alive while monitoring is ACTIVE/IDLE; OFF/sign-out performs the close.
    if (trackingState === TRACKING_STATES.OFF) {
      await closeOffscreenDocument();
    }
  } catch (error) {
    console.warn('[WebRTC] Error stopping screen share:', error);
  } finally {
    if (!negotiationId || activeLiveViewNegotiationId === negotiationId) {
      activeLiveViewNegotiationId = null;
      activeLiveViewTeachingSessionId = null;
    }
  }
}

async function handleOffscreenMessage(message) {
  if (message.type === 'WS_EVENT') {
    await handleWsEvent(message.event, message.data, message.connectionGeneration);
    return { success: true };
  }

  if (message.type === 'ICE_CANDIDATE') {
    if (message.negotiationId && message.negotiationId === activeLiveViewNegotiationId) {
      await wsSend({
        type: 'ice',
        to: 'teacher',
        negotiationId: message.negotiationId,
        candidate: message.candidate,
      });
    }
    return { success: true };
  }

  if (message.type === 'ANSWER') {
    if (message.negotiationId && message.negotiationId === activeLiveViewNegotiationId) {
      await wsSend({
        type: 'answer',
        to: 'teacher',
        negotiationId: message.negotiationId,
        sdp: message.sdp,
      });
    }
    return { success: true };
  }

  if (message.type === 'CONNECTION_FAILED') {
    console.log('[WebRTC] Connection failed, cleaning up');
    await stopScreenShare();
    setObservedState(false, 'connection-failed');
    return { success: true };
  }

  if (message.type === 'CAPTURE_ERROR') {
    safeNotify({
      title: 'Screen Sharing Error',
      message: message.error || 'Failed to capture screen',
    });
    await stopScreenShare();
    setObservedState(false, 'capture-error');
    return { success: true };
  }

  if (message.type === 'LIVE_VIEW_EXPIRED') {
    const negotiationId = String(message.negotiationId || '').trim();
    if (negotiationId) {
      await wsSend({
        type: 'stop-share',
        to: 'teacher',
        negotiationId,
        reason: message.reason || 'student-capture-expired',
      });
    }
    if (negotiationId && negotiationId === activeLiveViewNegotiationId) {
      activeLiveViewNegotiationId = null;
      activeLiveViewTeachingSessionId = null;
    }
    setObservedState(false, message.reason || 'live-view-expired');
    return { success: true };
  }

  return { success: false, ignored: true };
}

// Listen for messages FROM offscreen document. Keep the response channel open
// until the relayed event's storage, ACK, auth, or Live View work has settled;
// otherwise MV3 may suspend the worker immediately after a premature reply.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Handle OFFSCREEN_READY from offscreen document
  if (message.type === 'OFFSCREEN_READY') {
    console.log('[Service Worker] Offscreen document is ready');
    offscreenReady = true;
    sendResponse({ success: true });
    return true;
  }

  // Only handle other messages from offscreen document
  if (!sender.url?.includes('offscreen.html')) {
    return;
  }

  console.log('[Service Worker] Message from offscreen:', message.type);

  handleOffscreenMessage(message)
    .then(sendResponse)
    .catch((error) => sendResponse({
      success: false,
      error: error?.message || 'Offscreen message failed',
    }));
  return true;
});

// Schedule WebSocket reconnection with exponential backoff
function scheduleWsReconnect() {
  if (trackingState === TRACKING_STATES.OFF) {
    return;
  }
  const delay = Math.min(wsReconnectBackoffMs, 120000);
  // Add jitter (0-20% of delay) to prevent thundering herd
  const jitter = Math.floor(Math.random() * delay * 0.2);
  const actualDelay = delay + jitter;
  console.log(`WebSocket will reconnect in ${Math.round(actualDelay / 1000)}s...`);
  chrome.alarms.create('ws-reconnect', {
    when: Date.now() + actualDelay,
  });
  wsReconnectBackoffMs = Math.min(wsReconnectBackoffMs * 2, 120000);
}

// Connect to WebSocket via offscreen document proxy
// MV3 service workers can't maintain persistent WebSocket connections (Chrome 145+),
// so the actual WebSocket lives in the offscreen document and relays messages here.
async function queryOffscreenWebSocketStatus() {
  try {
    return await sendToOffscreen({ type: 'WS_STATUS' });
  } catch {
    return null;
  }
}

async function recoverOffscreenWebSocketStatus() {
  const status = await queryOffscreenWebSocketStatus();
  if (!status) return false;
  const generation = Number(status.connectionGeneration || 0);
  if (generation < wsConnectionGeneration) return false;
  if (Number.isSafeInteger(generation) && generation > wsConnectionGeneration) {
    wsConnectionGeneration = generation;
  }
  wsTransportConnected = status.transportOpen === true;
  if (status.transportOpen === true && status.authenticated === true) {
    wsConnected = true;
    wsAuthenticatedGeneration = wsConnectionGeneration;
    wsReconnectBackoffMs = 10000;
    await chrome.alarms.clear('ws-reconnect');
    flushCommandAckOutbox().catch(() => {});
    flushChatAckOutbox().catch(() => {});
    return true;
  }
  wsConnected = false;
  wsAuthenticatedGeneration = 0;
  return false;
}

async function connectWebSocket() {
  if (wsConnectInFlight) return wsConnectInFlight;
  wsConnectInFlight = connectWebSocketNow();
  try {
    return await wsConnectInFlight;
  } finally {
    wsConnectInFlight = null;
  }
}

async function connectWebSocketNow() {
  if (trackingState === TRACKING_STATES.OFF) {
    console.log('Skipping WebSocket - tracking state is OFF');
    return;
  }
  if (await expireManualAuthIfStale('websocket-connect')) {
    return;
  }
  if (!hasStudentAuth()) {
    console.log('Skipping WebSocket - student authentication required');
    await notifyAuthGateStateToTabs();
    return;
  }

  // Clear any pending reconnection alarm since we're connecting now
  chrome.alarms.clear('ws-reconnect');

  // Ensure offscreen document exists (it hosts the WebSocket)
  await ensureOffscreenDocument();

  if (await recoverOffscreenWebSocketStatus()) {
    console.log('[WebSocket] Recovered authenticated offscreen transport');
    return true;
  }

  const protocol = CONFIG.serverUrl.startsWith('https') ? 'wss' : 'ws';
  const wsUrl = `${protocol}://${new URL(CONFIG.serverUrl).host}/ws`;

  // Build auth payload to send immediately on connection
  const authPayload = {
    type: 'auth',
    role: 'student',
    deviceId: CONFIG.deviceId,
    ...extensionProtocolDescriptor(),
  };
  if (CONFIG.studentToken) {
    authPayload.studentToken = CONFIG.studentToken;
    console.log('WebSocket auth: using JWT token');
  } else {
    console.log('Skipping WebSocket - student token required');
    await notifyAuthGateStateToTabs();
    return;
  }

  // Tell offscreen document to create the WebSocket
  wsConnected = false;
  wsTransportConnected = false;
  wsAuthenticatedGeneration = 0;
  wsConnectionGeneration += 1;
  wsAuthenticatedResponseGuard = {
    connectionGeneration: wsConnectionGeneration,
    responseGuard: captureAuthenticatedResponseGuard(),
  };
  try {
    const response = await sendToOffscreen({
      type: 'WS_CONNECT',
      url: wsUrl,
      authPayload,
      connectionGeneration: wsConnectionGeneration,
    });
    console.log('[WebSocket] Connection request sent to offscreen document, generation',
      response.connectionGeneration);
    return true;
  } catch (error) {
    console.warn('[WebSocket] Failed to send connect request to offscreen:', error?.message || error);
    scheduleWsReconnect();
    return false;
  }
}

// Handle WebSocket events relayed from the offscreen document in transport
// order. Offscreen emits frames without awaiting runtime.sendMessage, so an
// explicit per-generation tail is required to keep auth/state/commands causal.
function handleWsEvent(event, data, connectionGeneration) {
  const generation = Number(connectionGeneration || 0);
  if (generation !== wsConnectionGeneration) {
    console.info('[WebSocket] Ignoring stale transport event for generation', generation);
    return Promise.resolve({ ignored: true });
  }
  if (wsMessageProcessingGeneration !== generation) {
    wsMessageProcessingGeneration = generation;
    wsMessageProcessingTail = Promise.resolve();
  }
  const processing = wsMessageProcessingTail.then(
    () => processWsEvent(event, data, generation),
    () => processWsEvent(event, data, generation),
  );
  wsMessageProcessingTail = processing.catch(() => undefined);
  return processing;
}

async function processWsEvent(event, data, generation) {
  if (generation !== wsConnectionGeneration) return { ignored: true };
  if (event === 'open') {
    console.log('WebSocket transport connected (via offscreen)');
    wsTransportConnected = true;
    wsConnected = false;
  } else if (event === 'error') {
    console.warn('WebSocket connection issue');
    scheduleWsReconnect();
  } else if (event === 'close') {
    console.log('WebSocket disconnected');
    wsConnected = false;
    wsTransportConnected = false;
    wsAuthenticatedGeneration = 0;
    setObservedState(false, 'ws-closed');
    await cleanupTeacherBroadcast('ws-closed', { notifyTeacher: false });
    if (activeLiveViewNegotiationId) {
      await stopScreenShare({ notifyServer: false, reason: 'student-websocket-closed' });
    }
    scheduleWsReconnect();
  } else if (event === 'message') {
    await handleWsMessage(data, generation);
  }
  return { handled: true };
}

// Process incoming WebSocket message (same logic as before, just extracted)
async function handleWsMessage(rawData, connectionGeneration = wsConnectionGeneration) {
    if (Number(connectionGeneration) !== wsConnectionGeneration) return;
    try {
      const message = JSON.parse(rawData);
      console.log('WebSocket message:', message);

      if (message.type === 'command-ack-receipt') {
        if (message.ackId) {
          await removeCommandAcks([message.ackId]);
          if (message.accepted === false) {
            console.warn('[Command ACK] Server rejected acknowledgement:', message.ackId);
          }
        }
        return;
      }

      if (message.type === 'chat-message-ack-receipt') {
        if (message.ackId) {
          await removeChatAcks([message.ackId]);
          if (message.accepted === false) {
            console.warn('[Chat ACK] Server rejected acknowledgement:', message.ackId);
          }
        }
        return;
      }

      if (message.type === 'auth-error' || message.type === 'auth-failed') {
        wsConnected = false;
        wsAuthenticatedGeneration = 0;
        if (activeLiveViewNegotiationId) {
          await stopScreenShare({ notifyServer: false, reason: 'student-websocket-auth-rejected' });
        }
        scheduleWsReconnect();
        return;
      }
      
      // Handle authentication success with settings
      if (message.type === 'auth-success') {
        console.log('WebSocket authenticated successfully');
        try {
          const responseGuard = wsAuthenticatedResponseGuard?.connectionGeneration === connectionGeneration
            ? wsAuthenticatedResponseGuard.responseGuard
            : null;
          await adoptAuthenticatedStudentBinding(message, 'websocket auth', responseGuard);
        } catch (error) {
          console.warn('[WebSocket] Exact student binding was rejected:', error?.message || error);
          wsConnected = false;
          wsAuthenticatedGeneration = 0;
          await disconnectWebSocket();
          return;
        }
        wsTransportConnected = true;
        wsConnected = true;
        wsAuthenticatedGeneration = wsConnectionGeneration;
        wsReconnectBackoffMs = 10000;
        chrome.alarms.clear('ws-reconnect');
        await flushCommandAckOutbox().catch(() => {});
        await flushChatAckOutbox().catch(() => {});
        
        // Always update maxTabsPerStudent setting (including null for unlimited)
        if (message.settings && message.settings.hasOwnProperty('maxTabsPerStudent')) {
          const newLimit = message.settings.maxTabsPerStudent;
          
          // Update currentMaxTabs (null or non-positive means unlimited)
          // Treat 0 and negative as unlimited by converting to null
          schoolMaxTabs = (newLimit !== null && newLimit > 0) ? Math.min(Number(newLimit), 1000) : null;
          currentMaxTabs = effectiveTabLimit();
          console.log('Applied tab limit from settings:', currentMaxTabs === null ? 'unlimited' : currentMaxTabs);
          
          // Immediately enforce the limit if set (null or non-positive means no limit)
          if (currentMaxTabs !== null && currentMaxTabs > 0) {
            try {
              const tabs = await chrome.tabs.query({});
              if (tabs.length > currentMaxTabs) {
                // Close oldest tabs first (keep most recent)
                const tabsToClose = tabs.slice(0, tabs.length - currentMaxTabs);
                for (const tab of tabsToClose) {
                  try {
                    // Only close if it's not a protected chrome:// URL and has a valid id
                    if (tab.id && !tab.url?.startsWith('chrome://')) {
                      await chrome.tabs.remove(tab.id);
                    }
                  } catch (tabError) {
                    console.warn('Failed to close tab:', tab.id, tabError);
                    // Continue closing other tabs even if one fails
                  }
                }

                safeNotify({
                  title: 'Tab Limit Enforced',
                  message: `Your teacher has set a limit of ${currentMaxTabs} tab${currentMaxTabs === 1 ? '' : 's'}. Extra tabs have been closed.`,
                  priority: 1,
                });
              }
            } catch (error) {
              console.warn('Error enforcing tab limit:', error);
            }
          }
        }

        // Handle global blocked domains (school-wide blacklist)
        if (message.settings && message.settings.globalBlockedDomains) {
          const receivedGlobalBlockedDomains = message.settings.globalBlockedDomains;
          console.log('[Blacklist] Received from server:', receivedGlobalBlockedDomains);

          // Apply blacklist rules and persist to storage
          try {
            await updateGlobalBlacklistRules(receivedGlobalBlockedDomains);
            await chrome.storage.local.set({ globalBlockedDomains });
            console.log('[Blacklist] Persisted to storage');
          } catch (error) {
            console.warn('[Blacklist] Error applying rules:', error);
          }
        }

        const authStateEnvelope = Object.prototype.hasOwnProperty.call(message, 'classroomState')
          ? message
          : message.settings && Object.prototype.hasOwnProperty.call(message.settings, 'classroomState')
            ? { classroomState: message.settings.classroomState }
            : null;
        if (authStateEnvelope) {
          await applyClassroomStateFromAuthResponse(authStateEnvelope, 'websocket_auth').catch((error) => {
            console.warn('[Classroom State] Auth snapshot failed:', error?.message || error);
          });
        } else if (message.settings?.fab) {
          await applyFabSettings(message.settings.fab).catch((error) => {
            console.warn('[FAB] Failed to apply initial state:', error);
          });
        }
        requestClassroomStateSync('websocket-auth', true);
      }

      if (['classroom-state', 'classroom-state-sync', 'student-control-state'].includes(message.type)) {
        if (!acceptsCurrentStudentBinding(message, 'classroom state')) return;
        if (Object.prototype.hasOwnProperty.call(message, 'classroomState')) {
          await applyClassroomStateFromAuthResponse(message, 'websocket_reconcile').catch((error) => {
            console.warn('[Classroom State] WebSocket snapshot failed:', error?.message || error);
          });
        } else {
          const snapshot = message.state || message.snapshot;
          if (!snapshot) return;
          await applyClassroomState(snapshot, { reason: 'websocket_reconcile' }).catch((error) => {
            console.warn('[Classroom State] WebSocket snapshot failed:', error?.message || error);
          });
        }
      }

      if (message.type === 'fab-state-sync' || message.type === 'fab-state') {
        if (!acceptsCurrentStudentBinding(message, 'FAB state')) return;
        const fabState = message.fabState || message.state || message.data || message;
        await applyFabSettings(fabState).catch((error) => {
          console.warn('[FAB] WebSocket snapshot failed:', error?.message || error);
        });
      }

      if (message.type === 'student-session-ended' || message.type === 'session-ended') {
        if (!acceptsCurrentStudentBinding(message, 'student session lifecycle')) return;
        const authoritativeFabState = message.fabState || message.state || null;
        const endedSessionId = String(
          message.teachingSessionId || message.sessionId || message.data?.teachingSessionId || ''
        ).trim() || null;
        const activeSessionIds = normalizeIdList(currentFabState?.activeSessionIds);
        if (authoritativeFabState) {
          await applyFabSettings({
            ...authoritativeFabState,
            reason: authoritativeFabState.reason || 'session-ended',
          }).catch((error) => {
            console.warn('[FAB] Session-end snapshot failed:', error?.message || error);
          });
        } else if (!endedSessionId || activeSessionIds.includes(endedSessionId)) {
          const remainingSessionIds = endedSessionId
            ? activeSessionIds.filter((sessionId) => sessionId !== endedSessionId)
            : [];
          await applyFabSettings({
            ...(currentFabState || {}),
            revision: message.revision ?? currentFabState?.revision ?? 0,
            ownershipRevision: message.ownershipRevision
              ?? message.studentControlRevision
              ?? currentFabState?.ownershipRevision
              ?? 0,
            teachingSessionId: remainingSessionIds.length === 1 ? remainingSessionIds[0] : null,
            activeSessionIds: remainingSessionIds,
            messagingEnabled: remainingSessionIds.length > 0 && currentFabState?.messagingEnabled === true,
            handRaisingEnabled: remainingSessionIds.length > 0 && currentFabState?.handRaisingEnabled === true,
            handRaised: false,
            reason: 'session-ended',
          }).catch((error) => {
            console.warn('[FAB] Session-end snapshot failed:', error?.message || error);
          });
        }
      }

      // Handle global blacklist updates from server
      if (message.type === 'update-global-blacklist') {
        const receivedGlobalBlockedDomains = message.blockedDomains || [];
        console.log('[Blacklist] Update received from server:', receivedGlobalBlockedDomains);
        
        // Apply updated blacklist rules and persist to storage
        try {
          await updateGlobalBlacklistRules(receivedGlobalBlockedDomains);
          await chrome.storage.local.set({ globalBlockedDomains });
          console.log('[Blacklist] Persisted updated blacklist to storage');

          // Notify user if blacklist was updated
          if (globalBlockedDomains.length > 0) {
            safeNotify({
              title: 'Website Restrictions Updated',
              message: `Your school has blocked access to: ${globalBlockedDomains.slice(0, 3).join(', ')}${globalBlockedDomains.length > 3 ? '...' : ''}`,
              priority: 1,
            });
          }
        } catch (error) {
          console.warn('[Blacklist] Error applying updated rules:', error);
        }
      }
      
      // Handle WebRTC signaling - teacher requesting to view screen
      if (message.type === 'request-stream') {
        console.log('[WebRTC] Teacher requested screen share');
        // mode: 'auto' (default) = try silent tab capture, fallback to picker
        // mode: 'tab' = only silent tab capture
        // mode: 'screen' = only picker
        const mode = message.mode || 'auto';
        const negotiationId = String(message.negotiationId || '').trim();
        const teachingSessionId = String(message.teachingSessionId || '').trim();
        const authorityMatches = Boolean(
          acceptsCurrentStudentBinding(message, 'live-view request')
          && negotiationId
          && teachingSessionId
          && currentClassroomState?.teachingSessionId === teachingSessionId
          && !currentClassroomState?.supervisionContextId
        );
        if (authorityMatches) {
          if (
            activeLiveViewNegotiationId
            && activeLiveViewNegotiationId !== negotiationId
          ) {
            await stopScreenShare({ reason: 'live-view-replaced' });
          }
          activeLiveViewNegotiationId = negotiationId;
          activeLiveViewTeachingSessionId = teachingSessionId;
          await handleScreenShareRequest(
            mode,
            negotiationId,
            message.setupExpiresAt,
            message.expiresAt,
          );
        } else if (negotiationId) {
          wsSend({
            type: 'stop-share',
            to: 'teacher',
            negotiationId,
            reason: 'classroom-authority-mismatch',
          });
        }
      }
      
      // Handle stop-share request from teacher
      if (message.type === 'stop-share') {
        if (!acceptsCurrentStudentBinding(message, 'live-view stop')) return;
        console.log('[WebRTC] Teacher requested to stop screen share');
        await handleStopScreenShare(String(message.negotiationId || '').trim());
      }

      if (message.type === 'student-session-replaced') {
        if (!acceptsCurrentStudentBinding(message, 'student session replacement')) return;
        console.warn('[Auth] This student signed in on another Chromebook');
        await clearStudentAuth('session-replaced', {
          notifyBackend: false,
          pauseAutoRegistration: true,
        });
      }
      
      // Handle WebRTC offer from teacher
      if (message.type === 'offer') {
        if (!acceptsCurrentStudentBinding(message, 'live-view offer')) return;
        console.log('[WebRTC] Received offer from teacher');
        await handleOffer(message.sdp, message.from, String(message.negotiationId || '').trim());
      }
      
      // Handle WebRTC ICE candidate from teacher
      if (message.type === 'ice') {
        if (!acceptsCurrentStudentBinding(message, 'live-view ICE')) return;
        console.log('[WebRTC] Received ICE candidate from teacher');
        if (message.candidate) {
          await handleIceCandidate(message.candidate, String(message.negotiationId || '').trim());
        }
      }
      
      // Handle ping notifications
      if (message.type === 'ping') {
        if (!acceptsCurrentStudentBinding(message, 'teacher notification')) return;
        const { message: pingMessage } = message.data;
        
        // Show browser notification
        safeNotify({
          title: 'Teacher Notification',
          message: pingMessage || 'Your teacher is requesting your attention',
          priority: 2,
          requireInteraction: true, // Keeps notification visible until user dismisses
        });
        
        // Also play a sound (beep)
        // Note: Service workers cannot play audio directly, but the notification will make a sound
      }
      
      // Handle remote control commands (Phase 1: GoGuardian-style features)
      if (message.type === 'remote-control') {
        // General _msgId dedup: skip if this exact message was already processed
        const msgId = message._msgId;
        if (msgId) {
          if (recentMsgIds.has(msgId)) {
            console.log('Dedup: skipping duplicate remote-control _msgId', msgId);
            return;
          }
          recentMsgIds.add(msgId);
          setTimeout(() => recentMsgIds.delete(msgId), MSG_DEDUP_TTL);
        }
        await handleRemoteControl(message.command, message).catch((error) => {
          console.warn('Unhandled remote control command error:', error);
        });
      }
      
      // Handle chat messages (Phase 2)
      if (message.type === 'chat') {
        await handleChatMessage(message);
      }

      // Handle teacher reply messages — send to chat thread
      // A storage-backed, identity-bound ledger deduplicates local + Redis
      // delivery as well as later heartbeat inbox retries across worker restarts.
      if (message.type === 'teacher-message') {
        await handleDurableTeacherMessage(message).catch((error) => {
          console.warn('Teacher message delivery failed:', error?.message || error);
        });
      }

      // Handle teacher closing the chat
      // Dedup: local + Redis both deliver the same message
      if (message.type === 'chat-closed') {
        if (!acceptsCurrentStudentBinding(message, 'chat close')) return;
        if (!messageMatchesActiveFabSession(message)) {
          console.warn('[FAB] Ignoring chat close for an inactive teaching session');
          return;
        }
        const dedupKey = message._msgId || ('cc:' + Date.now().toString().slice(0, -3));
        if (!recentMsgIds.has(dedupKey)) {
          recentMsgIds.add(dedupKey);
          setTimeout(() => recentMsgIds.delete(dedupKey), MSG_DEDUP_TTL);
          broadcastToAllTabs('chat-closed', {
            sessionId: message.sessionId,
            studentId: message.studentId,
          });
        }
      }

      // Handle check-in requests (Phase 3)
      if (message.type === 'check-in-request') {
        if (!acceptsCurrentStudentBinding(message, 'check-in request')) return;
        await handleCheckInRequest(message);
      }

      // ====================================
      // TEACHER BROADCAST (Receiving teacher's screen)
      // ====================================

      // Teacher started broadcasting - request to join
      if (message.type === 'teacher-broadcast-start') {
        console.log('[Broadcast] Teacher started broadcasting, requesting to join');
        await handleBroadcastStart(message);
      }

      // Teacher stopped broadcasting
      if (message.type === 'teacher-broadcast-stop') {
        console.log('[Broadcast] Teacher stopped broadcasting');
        await handleBroadcastStop();
      }

      // Received broadcast offer from teacher
      if (message.type === 'broadcast-offer') {
        console.log('[Broadcast] Received offer from teacher');
        await handleBroadcastOffer(message.sdp);
      }

      // Received ICE candidate for broadcast
      if (message.type === 'broadcast-ice') {
        console.log('[Broadcast] Received ICE candidate from teacher');
        if (message.candidate) {
          handleBroadcastIce(message.candidate);
        }
      }
    } catch (error) {
      console.warn('Error processing WebSocket message:', error);
    }
}

// Tab change listener - send immediate heartbeat when user switches tabs
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  await classroomStateRestorePromise;
  enforceAuthGateForTab(activeInfo.tabId).catch(() => {});
  // Allow both ACTIVE and IDLE states (user switching tabs means they're present)
  if (trackingState === TRACKING_STATES.OFF) return;
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    queueNavigationEvent('tab_change', tab.url, tab.title || 'No title', { tabId: activeInfo.tabId });
    // Send immediate heartbeat to update teacher dashboard quickly
    safeSendHeartbeat('tab-activated');
  } catch (error) {
    console.warn('Failed to read active tab info:', error);
  }
});

// Tab update listener - send heartbeat on URL/title change
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  try {
    await classroomStateRestorePromise;
    if (changeInfo.status === 'complete') {
      enforceAuthGateForTab(tab).catch(() => {});
    }
    // Allow both ACTIVE and IDLE states
    if (trackingState === TRACKING_STATES.OFF) return;
    if (!tab.active || !(changeInfo.url || changeInfo.title)) return;
    if (changeInfo.url) {
      queueNavigationEvent('url_change', changeInfo.url, tab.title || 'No title', { tabId });
      // Send immediate heartbeat to update teacher dashboard quickly
      safeSendHeartbeat('url-changed');
    }
  } catch (error) {
    console.warn('[Service Worker] Tab updated handler error:', error?.message || error);
  }
});

// Window focus change listener - detect when user switches windows or leaves Chrome
chrome.windows.onFocusChanged.addListener(async (windowId) => {
  if (trackingState === TRACKING_STATES.OFF) return;

  if (windowId === chrome.windows.WINDOW_ID_NONE) {
    // User switched to a different application (not Chrome)
    // Send heartbeat with current state - teacher will see last known tab
    safeSendHeartbeat('window-unfocused');
  } else {
    // User focused a Chrome window - get the active tab in that window
    try {
      const tabs = await chrome.tabs.query({ active: true, windowId });
      if (tabs.length > 0 && tabs[0].url?.startsWith('http')) {
        safeSendHeartbeat('window-focused');
      }
    } catch (error) {
      console.warn('Failed to query focused window tabs:', error);
    }
  }
});

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'dev-throw') {
    if (!SENTRY_DEV_MODE) {
      sendResponse({ success: false, error: 'Sentry dev mode is disabled' });
      return true;
    }
    if (devExceptionSent) {
      sendResponse({ success: false, error: 'Sentry dev exception already sent' });
      return true;
    }
    devExceptionSent = true;
    const error = new Error('Sentry dev test error (extension)');
    if (globalThis.Sentry?.captureException) {
      globalThis.Sentry.captureException(error);
    }
    console.warn('[Sentry] Dev exception captured for verification.');
    sendResponse({ success: true });
    return true;
  }

  if (message.type === 'register') {
    registerDevice(message.deviceId, message.deviceName, message.classId)
      .then(async (data) => {
        initializeAdaptiveTracking('manual-register');
        
        // Refresh the current page to apply privacy banner
        try {
          const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
          if (tabs[0]?.id) {
            chrome.tabs.reload(tabs[0].id);
          }
        } catch (error) {
          console.warn('Failed to refresh tab:', error);
        }
        
        sendResponse({ success: true, data });
      })
      .catch((error) => {
        sendResponse({ success: false, error: error.message });
      });
    return true; // Will respond asynchronously
  }
  
  if (message.type === 'get-config') {
    sendResponse({ config: CONFIG });
    return true;
  }

  if (message.type === 'get-connectivity-health') {
    sendResponse({ success: true, ...connectivityStatus() });
    return true;
  }

  if (message.type === 'refresh-connectivity-badge') {
    setConnectivityBadge(connectivityStatus())
      .then((status) => sendResponse({ success: true, ...status }))
      .catch((error) => sendResponse({ success: false, error: error?.message || 'Status unavailable' }));
    return true;
  }

  if (message.type === 'get-message-inbox') {
    classroomStateRestorePromise
      .then(() => getCurrentMessageInbox())
      .then((messages) => sendResponse({ success: true, messages }))
      .catch((error) => sendResponse({ success: false, error: error?.message || 'Messages unavailable' }));
    return true;
  }

  if (message.type === 'mark-message-inbox-read') {
    classroomStateRestorePromise
      .then(() => markCurrentMessageInboxRead())
      .then((messages) => sendResponse({ success: true, messages }))
      .catch((error) => sendResponse({ success: false, error: error?.message || 'Messages unavailable' }));
    return true;
  }

  if (message.type === 'clear-message-inbox-display') {
    classroomStateRestorePromise
      .then(() => clearCurrentMessageInboxDisplay())
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error?.message || 'Messages unavailable' }));
    return true;
  }

  if (message.type === 'get-classroom-state') {
    classroomStateRestorePromise
      .then(() => checkClassroomStateExpiry())
      .then(() => sendResponse({
        success: true,
        classroomState: currentClassroomState,
        appliedRevision: currentClassroomState?.revision ?? 0,
      }))
      .catch((error) => sendResponse({ success: false, error: error?.message || 'State unavailable' }));
    return true;
  }

  if (message.type === 'get-classroom-overlay-state') {
    Promise.all([
      classroomStateRestorePromise,
      getRestorableClassroomOverlayState(),
      kv.get([FAB_STATE_STORAGE_KEY, FAB_CONTEXT_STORAGE_KEY]),
    ])
      .then(([, overlays, stored]) => sendResponse({
        success: true,
        classroomState: currentClassroomState,
        overlays,
        fabState: stored[FAB_STATE_STORAGE_KEY] || currentFabState,
        fabContext: stored[FAB_CONTEXT_STORAGE_KEY] || null,
      }))
      .catch((error) => sendResponse({ success: false, error: error?.message || 'Overlay state unavailable' }));
    return true;
  }

  if (message.type === 'get-auth-state') {
    if (message.revalidateManagedPolicy === true) {
      revalidateManagedAuthGatePolicy(message.managedPolicyFence)
        .then(({ state, managedPolicyFence, managedPolicyGeneration }) => {
          const response = {
            success: true,
            state,
            // These proof fields exist only on this correlated direct reply.
            // Broadcast CLASSPILOT_* messages never carry either field.
            managedPolicyFence,
            managedPolicyGeneration,
          };
          if (message.includeConfig) response.config = CONFIG;
          sendResponse(response);
        })
        .catch(async (error) => {
          try {
            const response = {
              success: false,
              error: error?.message || 'Managed policy revalidation failed',
              state: await getPublishableAuthGateState(),
            };
            if (message.includeConfig) response.config = CONFIG;
            sendResponse(response);
          } catch {
            sendResponse({ success: false, error: 'Authentication state is unavailable' });
          }
        });
      return true;
    }

    // All ordinary callers that arrive before the first ordinary reply belong
    // to the same cold-worker cohort. Local restoration can finish between
    // concurrent messages, so its completion is not a reliable cohort fence.
    const authStateWasCold = ordinaryAuthStateColdCohortOpen;
    const sendOrdinaryAuthStateResponse = (response) => {
      sendResponse(response);
      ordinaryAuthStateColdCohortOpen = false;
    };
    authStateRestorePromise
      .then(async () => {
        expireManualAuthIfStaleFailClosed('get-auth-state');
        authGateStateColdWorker = authStateWasCold;
        if (hasStudentAuth()) return;

        await awaitManagedAuthGatePolicyStable();
        if (fastAuthGateEnabled) {
          refreshSharedSignInLoginConfig({
            reason: 'get_auth_state',
            coldWorker: authStateWasCold,
          }).catch(() => {});
          return;
        }

        await expireManualAuthIfStale('get-auth-state');
        if (!hasStudentAuth()) {
          await refreshSharedSignInLoginConfig({ managedConfigAlreadyApplied: true });
        }
      })
      .then(async () => {
        const state = await getPublishableAuthGateState();
        state.coldWorker = state.fastAuthGateEnabled && authStateWasCold;
        const response = { success: true, state };
        if (message.includeConfig) response.config = CONFIG;
        sendOrdinaryAuthStateResponse(response);
      })
      .catch(async (error) => {
        try {
          const state = await getPublishableAuthGateState();
          state.coldWorker = state.fastAuthGateEnabled && authStateWasCold;
          const response = {
            success: false,
            error: error.message,
            state,
          };
          if (message.includeConfig) response.config = CONFIG;
          sendOrdinaryAuthStateResponse(response);
        } catch {
          sendOrdinaryAuthStateResponse({
            success: false,
            error: 'Authentication state is unavailable',
          });
        }
      });
    return true;
  }

  if (message.type === 'refresh-auth-state') {
    authStateRestorePromise
      .then(async () => {
        expireManualAuthIfStaleFailClosed('refresh-auth-state');
        if (!hasStudentAuth()) await awaitManagedAuthGatePolicyStable();
        if (!fastAuthGateEnabled) await expireManualAuthIfStale('refresh-auth-state');
        if (!hasStudentAuth()) {
          await refreshSharedSignInLoginConfig({
            force: true,
            reason: 'retry_now',
            managedConfigAlreadyApplied: true,
          });
        }
        const state = await getPublishableAuthGateState();
        sendResponse({ success: state.phase !== 'unavailable', state });
      })
      .catch(async () => {
        try {
          sendResponse({ success: false, state: await getPublishableAuthGateState() });
        } catch {
          sendResponse({ success: false, error: 'Authentication state is unavailable' });
        }
      });
    return true;
  }

  if (message.type === 'get-login-roster') {
    authStateRestorePromise
      .then(async () => {
        await awaitManagedAuthGatePolicyStable();
        return fetchLoginRosterForGate({ gradeLevel: message.gradeLevel });
      })
      .then((data) => sendResponse(data))
      .catch((error) => sendResponse({ success: false, error: error.message || 'Could not load roster' }));
    return true;
  }

  if (message.type === 'manual-student-login') {
    manualStudentLogin(message.payload || {})
      .then((data) => sendResponse(data))
      .catch((error) => sendResponse({ success: false, error: error.message || 'Invalid student credentials' }));
    return true;
  }

  if (message.type === 'student-sign-out') {
    // 2.6.8: a deliberate sign-out ALWAYS parks the device at the gate. The
    // pause was previously conditional on isManualIdentitySource(), so a
    // chrome_profile student (or a sign-out racing an already-cleared
    // identity) left auto-registration enabled and the next worker wake —
    // the 5-minute 'wake-up' alarm — silently signed the student back in.
    clearStudentAuth('explicit_sign_out', { notifyBackend: true, pauseAutoRegistration: true })
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error.message || 'Could not sign out' }));
    return true;
  }

  // Handle poll response from content script
  if (message.type === 'poll-response') {
    const { pollId, selectedOption } = message;
    console.log('Poll response received:', pollId, selectedOption);

    (async () => {
      if (!CONFIG.deviceId || !CONFIG.serverUrl || !hasStudentAuth()) {
        throw new Error('Not connected to server');
      }

      const expectedBinding = fabIdentityBinding();
      const overlays = await getRestorableClassroomOverlayState();
      if (!overlays.poll || overlays.poll.pollId !== pollId) {
        throw new Error('This poll is no longer active for the signed-in student');
      }
      const option = Number(selectedOption);
      if (!Number.isSafeInteger(option) || option < 0 || option >= overlays.poll.options.length) {
        throw new Error('Invalid poll option');
      }
      const response = await fetchWithBackoff(`${CONFIG.serverUrl}/api/polls/${encodeURIComponent(pollId)}/respond`, {
        method: 'POST',
        headers: buildDeviceAuthHeaders(),
        body: JSON.stringify({
          deviceId: CONFIG.deviceId,
          studentId: CONFIG.activeStudentId,
          selectedOption: option,
        }),
      }, {
        context: 'poll response',
        maxAttempts: 2,
        respectGlobalBackoff: false,
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw buildResponseError(response, data, response.status === 409
          ? 'A response was already recorded for this poll'
          : 'Could not submit poll response');
      }
      if (expectedBinding !== fabIdentityBinding()) {
        throw new Error('Student identity changed while submitting the poll');
      }
      await markPollResponsePersisted(pollId, option);
      broadcastToAllTabs('poll-response-succeeded', { pollId, selectedOption: option });
      console.log('Poll response submitted:', data);
      return data;
    })()
      .then((data) => sendResponse({ success: true, data }))
      .catch((error) => {
        console.warn('Failed to submit poll response:', error?.message || error);
        sendResponse({ success: false, error: error?.message || 'Could not submit poll response' });
      });
    return true;
  }

  // Handle raise hand from popup
  if (message.type === 'raise-hand') {
    console.log('Raise hand requested');

    if (!CONFIG.deviceId || !CONFIG.serverUrl) {
      sendResponse({ success: false, error: 'Not connected to server' });
      return true;
    }

    const headers = buildDeviceAuthHeaders();
    headers['Content-Type'] = 'application/json';
    const fabBindingAtRaise = fabIdentityBinding();
    const fabSessionsAtRaise = activeTeachingSessionIds();
    if (currentFabState && fabSessionsAtRaise.length === 0) {
      sendResponse({ success: false, error: 'No active class session for hand raising' });
      return true;
    }

    fetchWithBackoff(`${CONFIG.serverUrl}/api/student/raise-hand`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        deviceId: CONFIG.deviceId,
        studentId: CONFIG.activeStudentId,
        studentEmail: CONFIG.studentEmail,
        studentName: CONFIG.studentName,
      }),
    }, {
      context: 'raise hand',
      maxAttempts: 2,
      respectGlobalBackoff: false,
    })
      .then(parseJsonResponse)
      .then(async data => {
        if (
          fabBindingAtRaise !== fabIdentityBinding() ||
          JSON.stringify(fabSessionsAtRaise) !== JSON.stringify(activeTeachingSessionIds())
        ) throw new Error('Class session changed while raising the hand');
        console.log('Hand raised:', data);
        await updateLocalFabHandRaised(true, 'student-raised-hand');
        sendResponse({ success: true, data });
      })
      .catch(err => {
        console.warn('Failed to raise hand:', err);
        sendResponse({ success: false, error: err.message });
      });

    return true;
  }

  // Handle lower hand from popup
  if (message.type === 'lower-hand') {
    console.log('Lower hand requested');

    if (!CONFIG.deviceId || !CONFIG.serverUrl) {
      sendResponse({ success: false, error: 'Not connected to server' });
      return true;
    }

    const headers = buildDeviceAuthHeaders();
    headers['Content-Type'] = 'application/json';
    const fabBindingAtLower = fabIdentityBinding();
    const fabSessionsAtLower = activeTeachingSessionIds();

    fetchWithBackoff(`${CONFIG.serverUrl}/api/student/lower-hand`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        deviceId: CONFIG.deviceId,
        studentId: CONFIG.activeStudentId,
      }),
    }, {
      context: 'lower hand',
      maxAttempts: 2,
      respectGlobalBackoff: false,
    })
      .then(parseJsonResponse)
      .then(async data => {
        if (
          fabBindingAtLower !== fabIdentityBinding() ||
          JSON.stringify(fabSessionsAtLower) !== JSON.stringify(activeTeachingSessionIds())
        ) throw new Error('Class session changed while lowering the hand');
        console.log('Hand lowered:', data);
        await updateLocalFabHandRaised(false, 'student-lowered-hand');
        sendResponse({ success: true, data });
      })
      .catch(err => {
        console.warn('Failed to lower hand:', err);
        sendResponse({ success: false, error: err.message });
      });

    return true;
  }

  // Handle send message from popup (two-way chat)
  if (message.type === 'send-student-message') {
    console.log('Send message requested:', message.messageType);

    if (!CONFIG.deviceId || !CONFIG.serverUrl) {
      sendResponse({ success: false, error: 'Not connected to server' });
      return true;
    }

    if (!message.message || message.message.trim().length === 0) {
      sendResponse({ success: false, error: 'Message is required' });
      return true;
    }

    const fabBindingAtSend = fabIdentityBinding();
    const activeSessionIdsAtSend = activeTeachingSessionIds();
    if (currentFabState && activeSessionIdsAtSend.length === 0) {
      sendResponse({ success: false, error: 'No active class session for messaging' });
      return true;
    }

    const headers = buildDeviceAuthHeaders();
    headers['Content-Type'] = 'application/json';

    fetchWithBackoff(`${CONFIG.serverUrl}/api/student/send-message`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        message: message.message.trim(),
        messageType: message.messageType || 'message',
        sessionId: activeSessionIdsAtSend[0] || undefined,
      }),
    }, {
      context: 'student message',
      maxAttempts: 2,
      respectGlobalBackoff: false,
    })
      .then(parseJsonResponse)
      .then(data => {
        if (
          fabBindingAtSend !== fabIdentityBinding() ||
          JSON.stringify(activeSessionIdsAtSend) !== JSON.stringify(activeTeachingSessionIds())
        ) {
          sendResponse({ success: false, error: 'Class session changed while sending the message' });
          return;
        }
        if (data.error) {
          console.warn('Failed to send message:', data.error);
          sendResponse({ success: false, error: data.error });
        } else {
          console.log('Message sent:', data);
          sendResponse({ success: true, messageId: data.messageId });
        }
      })
      .catch(err => {
        console.warn('Failed to send message:', err);
        sendResponse({ success: false, error: err.message });
      });

    return true;
  }

  if (message.type === 'update-server-url') {
    const newServerUrl = message.serverUrl;
    if (newServerUrl) {
      CONFIG.serverUrl = newServerUrl;
      // The cached login-config (incl. kiosk schoolId/availability) came from
      // the old server — drop it so kiosk URLs never mix origins and configs.
      resetSharedSignInLoginConfigCache();
      chrome.storage.local.set({ config: persistedNonAuthConfig(CONFIG) }, () => {
        console.log('Server URL updated to:', newServerUrl);
        // Refresh school settings and tracking state with new server URL
        refreshSchoolSettings({ force: true }).then(() => {
          updateTrackingState('server-url-update');
        }).catch(() => {});
        sendResponse({ success: true });
      });
    } else {
      sendResponse({ success: false, error: 'Invalid server URL' });
    }
    return true;
  }
  
  if (message.type === 'student-changed') {
    // Update active student ID
    const previousStudentId = CONFIG.activeStudentId;
    CONFIG.activeStudentId = message.studentId;
    
    console.log('Student changed:', previousStudentId, '->', message.studentId);
    
    reconcileMessageInboxIdentity('student-changed')
      .then(() => {
        // Send immediate heartbeat only after prior-student messages are gone.
        safeSendHeartbeat('student-changed');
        sendResponse({ success: true });
      })
      .catch((error) => sendResponse({ success: false, error: error?.message || 'Could not change student' }));
    return true;
  }
  
  if (message.type === 'camera-status-changed') {
    // Update camera status from content script
    cameraActive = message.cameraActive;
    console.log('[Service Worker] Camera status updated:', cameraActive);
    
    // Send immediate heartbeat with camera status
    safeSendHeartbeat('camera-status');
    
    sendResponse({ success: true });
    return true;
  }
});

console.log('ClassPilot service worker loaded');
