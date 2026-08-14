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
  schoolId: null,
  schoolSlug: null,
  enrollmentKey: null,
  identitySource: null,
  manualLoginLastSeenAt: null,
  autoRegistrationPaused: false,
};

let ws = null; // Legacy reference, kept for compatibility checks
let wsConnected = false; // Tracks WebSocket connection state (actual WS lives in offscreen doc)

// Send a message via the WebSocket proxy in the offscreen document
function wsSend(data) {
  if (!wsConnected) return;
  const str = typeof data === 'string' ? data : JSON.stringify(data);
  sendToOffscreen({ type: 'WS_SEND', data: str }).catch(() => {});
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

function sendCommandAck(commandId, ackState, options = {}) {
  const normalizedCommandId = normalizeCommandId(commandId);
  if (!normalizedCommandId) return;

  const defaultOutcome = {
    received: 'pending',
    completed: 'applied',
    failed: 'failed',
    expired: 'expired',
  }[ackState] || 'pending';

  wsSend({
    type: 'command-ack',
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
  });
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
const MANUAL_LOGIN_STALE_MS = 5 * 60 * 1000;
const SHARED_AUTH_LOCK_TIMEOUT_MS = MANUAL_LOGIN_STALE_MS;
const SHARED_AUTH_LOCK_ALARM_NAME = 'shared-auth-lock-timeout';
const SHARED_SIGN_IN_CONFIG_FETCH_INTERVAL_MS = 5 * 60 * 1000;
const HEALTH_CHECK_ALARM_NAME = 'health-check';
const CONNECTIVITY_HEALTH_STORAGE_KEY = 'connectivityHealthV1';
const CONNECTIVITY_HEALTH_ALARM_NAME = 'connectivity-health-boundary';
const SCREENSHOT_HEALTH_STORAGE_KEY = 'screenshotHealthV1';
const MESSAGE_INBOX_STORAGE_KEY = 'messages';
const MESSAGE_INBOX_BINDING_KEY = 'messageInboxAuthBindingV1';
const MESSAGE_INBOX_DEDUP_KEY = 'messageInboxSeenIdsV1';
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
let screenshotCaptureInFlight = false;
let isScheduleHardOff = false;
let sharedAuthLockedSinceAt = 0;
let sharedSignInLoginConfig = {
  fetchedAt: 0,
  setupRequired: false,
  sharedSignInEnabled: false,
  loginMethod: 'name_pin',
  pinLoginEnabled: false,
};
let sharedSignInConfigPromise = null;

function resetSharedSignInLoginConfigCache() {
  sharedSignInLoginConfig = {
    fetchedAt: 0,
    setupRequired: false,
    sharedSignInEnabled: false,
    loginMethod: 'name_pin',
    pinLoginEnabled: false,
  };
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

// Storage helpers
const kv = {
  get: (keys) => new Promise(resolve => chrome.storage.local.get(keys, resolve)),
  set: (obj) => new Promise(resolve => chrome.storage.local.set(obj, resolve)),
  remove: (keys) => new Promise(resolve => chrome.storage.local.remove(keys, resolve)),
};

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

const AUTH_STATE_KEYS = [
  'studentToken',
  'activeStudentId',
  'studentEmail',
  'studentName',
  'registered',
  'lastRegisteredEmail',
  'identitySource',
  'manualLoginLastSeenAt',
  'autoRegistrationPaused',
  'sharedAuthLockedSinceAt',
];

function hasSessionStorage() {
  return Boolean(chrome.storage?.session);
}

const sessionKv = {
  get: (keys) => new Promise(resolve => chrome.storage.session.get(keys, resolve)),
  set: (obj) => new Promise(resolve => chrome.storage.session.set(obj, resolve)),
  remove: (keys) => new Promise(resolve => chrome.storage.session.remove(keys, resolve)),
};

async function getStoredAuthState(keys) {
  const local = await kv.get(keys);
  if (!hasSessionStorage()) return local;
  const session = await sessionKv.get(keys);
  return { ...local, ...session };
}

async function setManualAuthState(obj) {
  if (hasSessionStorage()) {
    await sessionKv.set(obj);
    await kv.remove(Object.keys(obj));
  } else {
    await kv.set(obj);
  }
}

async function clearStoredAuthState(localOverrides = {}) {
  const cleared = Object.fromEntries(AUTH_STATE_KEYS.map((key) => [key, null]));
  await kv.set({ ...cleared, ...localOverrides });
  if (hasSessionStorage()) {
    await sessionKv.remove(AUTH_STATE_KEYS);
  }
}

function isHttpUrl(url) {
  return Boolean(url && /^https?:\/\//i.test(url));
}

// Refresh the tab cache - called when tabs change to keep cache accurate
async function refreshTabCache() {
  try {
    const allTabs = await chrome.tabs.query({});
    const httpTabs = allTabs.filter(tab => tab.url && tab.url.startsWith('http'));
    if (httpTabs.length > 0) {
      lastKnownTabs = httpTabs.slice(0, 20).map(tab => ({
        url: (tab.url || '').substring(0, 512),
        title: (tab.title || 'Untitled').substring(0, 512),
      }));
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

async function readManagedConfig() {
  if (!chrome.storage?.managed) {
    return {};
  }
  try {
    return await new Promise(resolve => chrome.storage.managed.get(MANAGED_CONFIG_KEYS, resolve));
  } catch (error) {
    console.warn('[Service Worker] Managed config read failed:', error);
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

async function disableForInactiveLicense(planStatus) {
  if (!licenseActive) {
    await kv.set({ licenseActive: false, planStatus });
    return;
  }

  // Persist and attempt delivery while the authenticated device context is
  // still available. A retryable failure remains in the bounded outbox and
  // can be delivered after the license/session recovers.
  await transitionTrackingState(TRACKING_STATES.OFF, 'license_inactive');
  licenseActive = false;
  if (observedHeartbeatTimer) {
    clearInterval(observedHeartbeatTimer);
    observedHeartbeatTimer = null;
  }
  scheduleHeartbeat(null);
  disconnectWebSocket();
  chrome.alarms.clear('ws-reconnect');
  chrome.alarms.clear(HEALTH_CHECK_ALARM_NAME);
  chrome.alarms.clear(CONNECTIVITY_HEALTH_ALARM_NAME);
  chrome.alarms.clear('settings-refresh');
  settingsAlarmScheduled = false;
  await setConnectivityBadge(connectivityStatus());

  await kv.set({ licenseActive: false, planStatus, licenseDisabledAt: Date.now() });
  notifyLicenseState({ type: 'CLASSPILOT_LICENSE_INACTIVE', planStatus });
}

async function checkLicenseStatus(reason = 'manual') {
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

    if (response.status === 402 || response.status === 403) {
      const data = await response.json().catch(() => ({}));
      await disableForInactiveLicense(data.planStatus);
      return;
    }

    if (!response.ok) {
      return;
    }

    const data = await response.json();
    if (!data.schoolActive) {
      await disableForInactiveLicense(data.planStatus);
      return;
    }

    const wasInactive = !licenseActive;
    licenseActive = true;
    await kv.set({ licenseActive: true, planStatus: data.planStatus });
    if (wasInactive) {
      notifyLicenseState({ type: 'CLASSPILOT_LICENSE_ACTIVE', planStatus: data.planStatus });
      initializeAdaptiveTracking(`license-active:${reason}`);
    }
  } catch (error) {
    console.warn('[License] Status check failed:', error);
  }
}

async function resolveServerUrl() {
  const managedConfig = await readManagedConfig();
  applyManagedSchoolConfig(managedConfig);

  const managedUrl = extractManagedValue(managedConfig?.serverUrl);
  if (isHttpUrl(managedUrl)) {
    return managedUrl;
  }

  let syncConfig = {};
  if (chrome.storage?.sync) {
    try {
      syncConfig = await new Promise(resolve => chrome.storage.sync.get(['config'], resolve));
    } catch (error) {
      console.warn('[Service Worker] Sync config read failed:', error);
    }
  }

  const localConfig = await chrome.storage.local.get(['config']);
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

async function refreshSchoolSettings({ force = false } = {}) {
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
    const response = await fetchWithBackoff(`${CONFIG.serverUrl}/api/extension/settings`, {
      cache: 'no-store',
      headers: {
        'Authorization': `Bearer ${CONFIG.studentToken}`,
      },
    }, {
      context: 'extension settings',
      maxAttempts: 2,
    });
    if (!response.ok) {
      throw new Error(`Settings fetch failed (${response.status})`);
    }
    const settings = await response.json();
    schoolSettings = settings;
    schoolSettingsFetchedAt = now;
    await applyFabSettings(settings.fab || settings);
    await kv.set({
      [SCHOOL_SETTINGS_CACHE_KEY]: settings,
      [SCHOOL_SETTINGS_FETCHED_AT_KEY]: now,
    });
    console.log('[School Hours] Settings updated:', settings);
    return settings;
  } catch (error) {
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

async function applyFabSettings(fabState) {
  if (!fabState || typeof fabState !== 'object') return {};
  const updates = {};
  if (typeof fabState.messagingEnabled === 'boolean') {
    updates.messagingEnabled = fabState.messagingEnabled;
  }
  if (typeof fabState.handRaisingEnabled === 'boolean') {
    updates.handRaisingEnabled = fabState.handRaisingEnabled;
  }
  if (typeof fabState.handRaised === 'boolean') {
    updates.handRaised = fabState.handRaised;
  }
  if (Array.isArray(fabState.activeSessionIds)) {
    updates.fabActiveSessionIds = fabState.activeSessionIds;
  }
  if (Array.isArray(fabState.activeHands)) {
    updates.fabActiveHands = fabState.activeHands;
  }
  if (Array.isArray(fabState.sessions)) {
    updates.fabSessions = fabState.sessions;
  }
  if (typeof fabState.sessionId === 'string') {
    updates.fabLifecycleSessionId = fabState.sessionId;
  }
  if (typeof fabState.reason === 'string') {
    updates.fabLifecycleReason = fabState.reason;
  }
  if (Object.keys(updates).length > 0) {
    await chrome.storage.local.set(updates);
  }
  return updates;
}

function sendChatDeliveryAck(message, deliveryStatus, errorMessage) {
  const messageId = message.chatMessageId || message.messageId;
  if (!messageId) return;
  wsSend({
    type: 'chat-message-ack',
    messageId,
    chatMessageId: messageId,
    sessionId: message.sessionId,
    deliveryStatus,
    status: deliveryStatus,
    errorMessage: errorMessage || null,
  });
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
  wsConnected = false;
  // Tell offscreen document to close the WebSocket
  sendToOffscreen({ type: 'WS_CLOSE' }).catch(() => {});
  if (ws) {
    try {
      ws.close();
    } catch (error) {
      console.warn('WebSocket close failed:', error);
    }
  }
  ws = null;
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

function pauseNetworkForOffHours(reason) {
  if (offHoursNetworkPaused) {
    return;
  }
  console.log(`[Network] Pausing off-hours traffic (${reason})`);
  clearNetworkAlarms();
  scheduleHeartbeat(null);
  disconnectWebSocket();
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
    console.log(`[Heartbeat] Skipping ${reason}; previous heartbeat still in flight`);
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
  }
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
      disconnectWebSocket();
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
      disconnectWebSocket();
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
    pauseNetworkForOffHours(reason);
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
    disconnectWebSocket();
  }

  syncObservedHeartbeat('tracking-state');
}

async function initializeAdaptiveTracking(reason) {
  await loadCachedSchoolSettings();
  await refreshSchoolSettings({ force: false });

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

  updateTrackingState(reason);
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

function generateMonitoringEventId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return `evt-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function monitoringEventAuthBinding() {
  if (!CONFIG.studentToken || !CONFIG.deviceId || !CONFIG.activeStudentId) return null;
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
    'v1',
    CONFIG.activeStudentId,
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

function hasStudentAuth() {
  return Boolean(CONFIG.deviceId && CONFIG.studentToken && (CONFIG.activeStudentId || CONFIG.studentEmail));
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
  return Boolean((CONFIG.schoolId || CONFIG.schoolSlug) && CONFIG.enrollmentKey);
}

async function refreshSharedSignInLoginConfig(options = {}) {
  const force = options.force === true;
  applyManagedSchoolConfig(await readManagedConfig());

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

  sharedSignInConfigPromise = (async () => {
    if (!hasManagedSchoolSetup()) {
      sharedSignInLoginConfig = {
        fetchedAt: Date.now(),
        setupRequired: true,
        sharedSignInEnabled: false,
        loginMethod: 'name_pin',
        pinLoginEnabled: false,
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
      sharedSignInLoginConfig = {
        fetchedAt: Date.now(),
        setupRequired: !response.ok,
        sharedSignInEnabled: response.ok && data.sharedSignInEnabled === true,
        loginMethod: response.ok && data.loginMethod === 'email_id' ? 'email_id' : 'name_pin',
        pinLoginEnabled: response.ok && data.loginMethod !== 'email_id',
      };
      return sharedSignInLoginConfig;
    } catch (error) {
      console.warn('[Auth Gate] Shared sign-in config check failed:', error?.message || error);
      sharedSignInLoginConfig = {
        fetchedAt: Date.now(),
        setupRequired: true,
        sharedSignInEnabled: false,
        loginMethod: 'name_pin',
        pinLoginEnabled: false,
      };
      return sharedSignInLoginConfig;
    }
  })().finally(() => {
    sharedSignInConfigPromise = null;
  });

  return sharedSignInConfigPromise;
}

function getAuthGateState() {
  const hasSchoolSetup = hasManagedSchoolSetup();
  return {
    authRequired: !hasStudentAuth(),
    setupRequired: !hasSchoolSetup || sharedSignInLoginConfig.setupRequired === true,
    studentName: CONFIG.studentName || null,
    studentEmail: CONFIG.studentEmail || null,
    sharedSignInEnabled: sharedSignInLoginConfig.sharedSignInEnabled === true,
    loginMethod: sharedSignInLoginConfig.loginMethod === 'email_id' ? 'email_id' : 'name_pin',
    pinLoginEnabled: sharedSignInLoginConfig.loginMethod === 'name_pin',
    hasManagedSchoolSetup: hasSchoolSetup,
    manualExpiresInSeconds: Math.floor(MANUAL_LOGIN_STALE_MS / 1000),
  };
}

async function ensureDeviceId() {
  if (CONFIG.deviceId) return CONFIG.deviceId;
  const stored = await kv.get(['deviceId']);
  const deviceId = stored.deviceId || ('device-' + crypto.randomUUID().slice(0, 11));
  CONFIG.deviceId = deviceId;
  await kv.set({ deviceId });
  return deviceId;
}

async function notifyAuthGateStateToTabs() {
  try {
    const tabs = await chrome.tabs.query({});
    await Promise.all(tabs.map((tab) => enforceAuthGateForTab(tab)));
  } catch (error) {
    console.warn('[Auth Gate] Failed to notify tabs:', error?.message || error);
  }
}

if (chrome.storage?.onChanged) {
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'managed') return;

    const managedConfig = {};
    for (const [key, change] of Object.entries(changes)) {
      if (MANAGED_CONFIG_KEYS.includes(key)) {
        managedConfig[key] = change.newValue;
      }
    }

    applyManagedSchoolConfig(managedConfig);
    resetSharedSignInLoginConfigCache();
    notifyAuthGateStateToTabs().catch(() => {});
  });
}

async function enforceAuthGateForTab(tabOrId) {
  try {
    const tab = typeof tabOrId === 'number' ? await chrome.tabs.get(tabOrId) : tabOrId;
    if (!tab?.id || !isHttpUrl(tab.url || '')) {
      return;
    }
    if (!hasStudentAuth()) {
      await refreshSharedSignInLoginConfig();
    }

    const message = hasStudentAuth()
      ? { type: 'CLASSPILOT_AUTH_COMPLETE', state: getAuthGateState() }
      : { type: 'CLASSPILOT_AUTH_REQUIRED', state: getAuthGateState() };

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

async function clearStudentAuth(reason = 'manual-clear', options = {}) {
  const tokenToEnd = CONFIG.studentToken;
  const pauseAutoRegistration = options.pauseAutoRegistration === true;
  const disconnect = options.disconnectWebSocket !== false;
  sharedAuthLockedSinceAt = 0;
  chrome.alarms.clear(SHARED_AUTH_LOCK_ALARM_NAME);

  // A confirmed student sign-out/profile change ends the student-bound
  // classroom context. Clear only teacher-session ranges; school policy stays.
  await clearTeacherSessionStateForSignOut().catch((error) => {
    console.warn('[Auth] Classroom state clear failed:', error?.message || error);
  });
  await clearStudentMessageState(reason).catch((error) => {
    console.warn('[Auth] Student message state clear failed:', error?.message || error);
  });
  // Best-effort the final bounded batch while the old token is still valid,
  // then discard anything unsent. Retrying it under a later student's token
  // would misattribute the prior student's activity.
  await flushMonitoringEventOutbox().catch(() => {});
  await discardMonitoringEventOutbox().catch(() => {});

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

  CONFIG.studentToken = null;
  CONFIG.studentEmail = null;
  CONFIG.studentName = null;
  CONFIG.activeStudentId = null;
  CONFIG.identitySource = null;
  CONFIG.manualLoginLastSeenAt = null;
  CONFIG.autoRegistrationPaused = pauseAutoRegistration;
  CONFIG.sharedAuthLockedSinceAt = null;

  // A heartbeat begun under the old token may still finish while sign-out is
  // unwinding. Clear again after invalidating the in-memory identity so that
  // no late response can repopulate the old student's inbox.
  await clearStudentMessageState(`${reason}-final`);

  await clearStoredAuthState({
    registered: false,
    autoRegistrationPaused: pauseAutoRegistration,
  });

  scheduleHeartbeat(null);
  scheduleScreenshotCapture(false);
  chrome.alarms.clear(CONNECTIVITY_HEALTH_ALARM_NAME);
  if (disconnect) {
    disconnectWebSocket();
  }
  await setConnectivityBadge(connectivityStatus());
  await notifyAuthGateStateToTabs();
}

async function expireManualAuthIfStale(reason = 'stale-check') {
  const source = CONFIG.identitySource;
  if (!isManualIdentitySource(source)) {
    return false;
  }

  const lastSeen = Number(CONFIG.manualLoginLastSeenAt || 0);
  if (lastSeen && Date.now() - lastSeen <= MANUAL_LOGIN_STALE_MS) {
    return false;
  }

  console.log(`[Auth] Manual login expired (${reason})`);
  await clearStudentAuth('auto_stale_wake', { notifyBackend: true, pauseAutoRegistration: true });
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
  if (!hasManagedSchoolSetup()) {
    return { success: false, setupRequired: true, error: 'Shared Chromebook setup required' };
  }
  const requestedGradeLevel = String(options.gradeLevel || '').trim();

  const params = new URLSearchParams();
  if (requestedGradeLevel) params.set('gradeLevel', requestedGradeLevel);
  if (CONFIG.schoolId) params.set('schoolId', CONFIG.schoolId);
  if (CONFIG.schoolSlug) params.set('schoolSlug', CONFIG.schoolSlug);

  const response = await fetchWithBackoff(`${CONFIG.serverUrl}/api/extension/login-roster?${params.toString()}`, {
    cache: 'no-store',
    headers: {
      'X-ClassPilot-Enrollment-Key': CONFIG.enrollmentKey,
    },
  }, {
    context: 'login roster',
    maxAttempts: 2,
    respectGlobalBackoff: false,
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    return {
      success: false,
      setupRequired: response.status === 401 || response.status === 404,
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

async function applyClassroomStateFromAuthResponse(data, reason) {
  if (!data || !Object.prototype.hasOwnProperty.call(data, 'classroomState')) return;
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
    await clearTeacherSessionStateForSignOut({ emitEvent: false, reason: `${reason}_no_state` });
    if (CONFIG.activeStudentId) {
      await kv.set({ [CLASSROOM_STATE_STUDENT_BINDING_KEY]: CONFIG.activeStudentId });
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
    // Authentication remains valid even if local enforcement fails. The
    // failed ACK/heartbeat outcome tells the server the restriction is not
    // synchronized, and the normal reconciliation loop can retry it.
    console.warn('[Classroom State] Login snapshot failed:', error?.message || error);
    requestClassroomStateSync(`${reason}-failed`, true);
  }
}

async function manualStudentLogin(payload) {
  const deviceId = await ensureDeviceId();
  const isPinLogin = payload.mode === 'pin';
  const body = {
    deviceId,
    deviceName: null,
    classId: 'auto',
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
  const data = await response.json().catch(() => ({}));
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
  const now = Date.now();

  CONFIG.studentToken = data.studentToken;
  CONFIG.activeStudentId = student.id || null;
  CONFIG.studentEmail = studentEmail;
  CONFIG.studentName = studentName;
  CONFIG.classId = 'auto';
  CONFIG.identitySource = isPinLogin ? 'manual_pin' : 'manual_email_id';
  CONFIG.manualLoginLastSeenAt = now;
  CONFIG.autoRegistrationPaused = false;

  await kv.set({
    deviceId,
    classId: 'auto',
  });
  await setManualAuthState({
    studentToken: data.studentToken,
    activeStudentId: CONFIG.activeStudentId,
    studentEmail,
    studentName,
    registered: true,
    lastRegisteredEmail: studentEmail,
    identitySource: CONFIG.identitySource,
    manualLoginLastSeenAt: now,
    autoRegistrationPaused: false,
  });
  await reconcileMessageInboxIdentity('student-login');

  await applyClassroomStateFromAuthResponse(data, 'student_login');

  await checkLicenseStatus('manual-login');
  await initializeAdaptiveTracking('manual-login');
  await notifyAuthGateStateToTabs();

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
async function ensureRegistered() {
  console.log('[Service Worker] Ensuring registration...');
  
  try {
    await expireManualAuthIfStale('ensure-registered');

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
      'identitySource',
      'manualLoginLastSeenAt',
      'autoRegistrationPaused',
      'sharedAuthLockedSinceAt',
    ]);

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
      if (profileEmail && stored.studentEmail && stored.studentEmail !== profileEmail) {
        console.log(`[Service Worker] Chrome profile changed from ${stored.studentEmail} to ${profileEmail}; re-registering`);
        await clearStudentAuth('chrome-profile-email-changed', { notifyBackend: true });
        stored = {
          ...stored,
          studentEmail: profileEmail,
          studentName: null,
          registered: false,
          lastRegisteredEmail: null,
          studentToken: null,
          activeStudentId: null,
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
    
    // Update CONFIG (email is primary identity - backend will determine schoolId from email domain)
    CONFIG.studentEmail = stored.studentEmail;
    CONFIG.studentName = stored.studentName || (stored.studentEmail ? stored.studentEmail.split('@')[0] : stored.studentEmail);
    CONFIG.deviceId = stored.deviceId;
    CONFIG.classId = 'auto'; // Backend determines this from email domain
    CONFIG.activeStudentId = stored.activeStudentId || CONFIG.activeStudentId;
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
        registrationRetryCount = 0; // Reset on success
        
        // ✅ JWT AUTHENTICATION: Store studentToken for secure authentication
        if (data.studentToken) {
          console.log('✅ [JWT] Received studentToken from server - storing for future heartbeats');
          await kv.set({ studentToken: data.studentToken, identitySource: 'chrome_profile', manualLoginLastSeenAt: null, autoRegistrationPaused: false });
          CONFIG.studentToken = data.studentToken; // Cache in memory too
          CONFIG.identitySource = 'chrome_profile';
          CONFIG.manualLoginLastSeenAt = null;
          CONFIG.autoRegistrationPaused = false;
        } else {
          console.warn('⚠️  No studentToken in registration response - legacy mode');
        }
        
        // Mark as registered and save the email we registered with
        await kv.set({ registered: true, lastRegisteredEmail: stored.studentEmail });
        
        // Update CONFIG with student ID from server
        if (data.student?.id) {
          CONFIG.activeStudentId = data.student.id;
          await kv.set({ activeStudentId: data.student.id });
        }
        await reconcileMessageInboxIdentity('student-registration');
        await applyClassroomStateFromAuthResponse(data, 'student_registration');
      } catch (error) {
        console.warn('[Service Worker] Student registration error:', error);
        await kv.set({ registered: false, studentToken: null });
        if (hasSessionStorage()) await sessionKv.remove(['studentToken']);
        CONFIG.studentToken = null;
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
  resolveServerUrl().then((serverUrl) => {
    CONFIG.serverUrl = serverUrl;
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
    resolveServerUrl().then((serverUrl) => {
      CONFIG.serverUrl = serverUrl;
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

// Run immediately on service worker load/wake-up
// This is CRITICAL: service worker can wake up after being terminated, not just on install/startup
(async () => {
  console.log('[Service Worker] Waking up...');
  disableToolbarAction();
  const stored = await getStoredAuthState([
    'deviceId',
    'config',
    'activeStudentId',
    'studentEmail',
    'studentName',
    'studentToken',
    'identitySource',
    'manualLoginLastSeenAt',
    'autoRegistrationPaused',
    'sharedAuthLockedSinceAt',
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
  ]);
  const resolvedServerUrl = await resolveServerUrl();

  // Restore state from storage (do not override resolved serverUrl)
  if (stored.config) {
    const { serverUrl, ...safeConfig } = stored.config;
    CONFIG = { ...CONFIG, ...safeConfig };
  }
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
  if (stored.deviceId) {
    CONFIG.deviceId = stored.deviceId;
  }
  if (stored.activeStudentId) {
    CONFIG.activeStudentId = stored.activeStudentId;
  }
  if (stored.studentEmail) {
    CONFIG.studentEmail = stored.studentEmail;
  }
  if (stored.studentName) {
    CONFIG.studentName = stored.studentName;
  }
  if (stored.studentToken) {
    CONFIG.studentToken = stored.studentToken;
  }
  if (stored.identitySource) {
    CONFIG.identitySource = stored.identitySource;
  }
  if (stored.manualLoginLastSeenAt) {
    CONFIG.manualLoginLastSeenAt = stored.manualLoginLastSeenAt;
  }
  CONFIG.autoRegistrationPaused = stored.autoRegistrationPaused === true;
  sharedAuthLockedSinceAt = Number(stored.sharedAuthLockedSinceAt || sharedAuthLockedSinceAt || 0);
  await reconcileMessageInboxIdentity('worker-wake');

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

  if (stored.licenseActive === false) {
    await disableForInactiveLicense(stored.planStatus);
  }

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
}).finally(() => markClassroomStateRestored());

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
      screenLock: { active: screenLocked && !allowedDomains.length, url: lockedUrl, domain: lockedDomain },
      flightPath: { active: screenLocked && allowedDomains.length > 0, allowedDomains },
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
  applyManagedSchoolConfig(await readManagedConfig());
  const authPause = await chrome.storage.local.get(['autoRegistrationPaused']);
  if (authPause.autoRegistrationPaused) {
    console.log('[Auth] Auto-detect registration paused until manual sign-in');
    await notifyAuthGateStateToTabs();
    return;
  }

  const userInfo = await getLoggedInUserInfo();
  
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
        await ensureRegistered();
        await notifyAuthGateStateToTabs();
      }
    } catch (error) {
      console.warn('[Auth] Failed to refresh registration after Chrome sign-in change:', error?.message || error);
    }
  });
}

// Load config from storage on startup
getStoredAuthState([
  'config',
  'activeStudentId',
  'studentEmail',
  'studentName',
  'studentToken',
  'identitySource',
  'manualLoginLastSeenAt',
  'autoRegistrationPaused',
  'sharedAuthLockedSinceAt',
]).then(async (result) => {
  try {
    const resolvedServerUrl = await resolveServerUrl();

    if (result.config) {
      const { serverUrl, ...safeConfig } = result.config;
      CONFIG = { ...CONFIG, ...safeConfig };
      console.log('Loaded config:', CONFIG);
    }

    CONFIG.serverUrl = resolvedServerUrl;
    console.log('Using server URL:', CONFIG.serverUrl);

    // Load active student ID
    if (result.activeStudentId) {
      CONFIG.activeStudentId = result.activeStudentId;
      console.log('Loaded active student ID:', CONFIG.activeStudentId);
    }

    // Load student email
    if (result.studentEmail) {
      CONFIG.studentEmail = result.studentEmail;
    }
    if (result.studentName) {
      CONFIG.studentName = result.studentName;
    }
    if (result.identitySource) {
      CONFIG.identitySource = result.identitySource;
    }
    if (result.manualLoginLastSeenAt) {
      CONFIG.manualLoginLastSeenAt = result.manualLoginLastSeenAt;
    }
    CONFIG.autoRegistrationPaused = result.autoRegistrationPaused === true;
    sharedAuthLockedSinceAt = Number(result.sharedAuthLockedSinceAt || sharedAuthLockedSinceAt || 0);

    // ✅ JWT AUTHENTICATION: Load studentToken from storage
    if (result.studentToken) {
      CONFIG.studentToken = result.studentToken;
      console.log('✅ [JWT] Loaded studentToken from storage');
    }

    if (await expireManualAuthIfStale('config-loaded')) {
      return;
    }

    // Auto-detect logged-in user and register
    if (!CONFIG.autoRegistrationPaused && !isManualIdentitySource(CONFIG.identitySource)) {
      await autoDetectAndRegister();
    } else if (CONFIG.autoRegistrationPaused) {
      await notifyAuthGateStateToTabs();
    }

    // Initialize adaptive tracking once config is loaded
    if (CONFIG.deviceId) {
      initializeAdaptiveTracking('config-loaded');
    }
    await notifyAuthGateStateToTabs();
  } catch (error) {
    console.warn('[Service Worker] Config load error (will retry):', error?.message || error);
  }
});

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
      config: CONFIG,
      registered: true,
    });
    
    return data;
  } catch (error) {
    console.warn('Registration error:', error);
    throw error;
  }
}

// Register device with student email auto-detection
async function registerDeviceWithStudent(deviceId, deviceName, classId, studentEmail, studentName) {
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
    
    // Save config with student info
    CONFIG.deviceId = deviceId;
    CONFIG.studentName = studentName;
    CONFIG.studentEmail = studentEmail;
    CONFIG.classId = classId;
    CONFIG.activeStudentId = data.student?.id || null;
    CONFIG.studentToken = data.studentToken || CONFIG.studentToken;
    CONFIG.identitySource = 'chrome_profile';
    CONFIG.manualLoginLastSeenAt = null;
    
    await chrome.storage.local.set({ 
      config: CONFIG,
      registered: true,
      activeStudentId: data.student?.id || null,
      studentToken: data.studentToken || null,
      lastRegisteredEmail: studentEmail,
      identitySource: 'chrome_profile',
      manualLoginLastSeenAt: null,
      autoRegistrationPaused: false,
    });
    await reconcileMessageInboxIdentity('student-registration');

    await applyClassroomStateFromAuthResponse(data, 'student_registration');
    
    // Start adaptive tracking after registration
    initializeAdaptiveTracking('student-registered');
    
    return data;
  } catch (error) {
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
    try {
      const allTabs = await chrome.tabs.query({});
      const httpTabs = allTabs.filter(tab => tab.url && tab.url.startsWith('http'));

      if (httpTabs.length > 0) {
        allOpenTabs = httpTabs
          .slice(0, 20) // Limit to 20 tabs
          .map(tab => ({
            url: (tab.url || '').substring(0, 512),
            title: (tab.title || 'Untitled').substring(0, 512),
          }));
        // Update cache with new tabs
        lastKnownTabs = allOpenTabs;
      } else if (lastKnownTabs.length > 0) {
        // Query returned no HTTP tabs but we have cached tabs
        // This can happen during tab loading or service worker restart
        allOpenTabs = lastKnownTabs;
        console.log(`[Heartbeat] Using cached ${lastKnownTabs.length} tabs (query returned 0 HTTP tabs)`);
      }
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
      screenLocked: screenLocked,
      flightPathActive: screenLocked && allowedDomains.length > 0,
      activeFlightPathName: activeFlightPathName,
      isSharing: false,
      cameraActive: cameraActive,
      status: trackingState.toLowerCase(),
      extensionVersion: chrome.runtime.getManifest().version,
      chromeVersion: currentChromiumVersion(),
      classroomStateRevision: currentClassroomState?.revision ?? 0,
      appliedClassroomStateRevision: lastClassroomStateAckRevision || currentClassroomState?.revision || 0,
      classroomStateOutcome: lastClassroomStateOutcome,
      classroomStateSessionId: currentClassroomState?.teachingSessionId || undefined,
      classroomStateSupervisionContextId: currentClassroomState?.supervisionContextId || undefined,
      requestClassroomState: requestClassroomStateOnHeartbeat(),
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
      if (data?.error === "school_not_entitled") {
        await disableForInactiveLicense(data.planStatus);
        return;
      }
      if (isManualIdentitySource()) {
        await clearStudentAuth('manual-token-invalid', { notifyBackend: false });
        return;
      }
      // ✅ JWT INVALID/EXPIRED: Token expired (401) or invalid (403) - need to re-register
      console.warn(`❌ [JWT] Token ${response.status === 401 ? 'expired' : 'invalid'} (${response.status}) - clearing token and re-registering`);
      await clearStudentMessageState('student-token-invalid');
      await kv.set({ studentToken: null, registered: false });
      if (hasSessionStorage()) await sessionKv.remove(['studentToken']);
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
      } else if (screenshotScheduled) {
        // Capture immediately on first heartbeat (avoids chrome.alarms delay on cold start)
        captureAndSendScreenshot();
      }
      // Check for pending messages missed during WebSocket disconnection
      try {
        const data = await response.json();
        await applyClassroomStateFromAuthResponse(data, 'heartbeat_reconcile');
        if (Array.isArray(data.pendingMessages) && data.pendingMessages.length > 0) {
          const inboxResult = await persistHeartbeatPendingMessages(
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

  // Re-schedule screenshot capture if alarm was lost after service worker restart
  if ((trackingState === TRACKING_STATES.ACTIVE || trackingState === TRACKING_STATES.IDLE) && !screenshotScheduled) {
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
  } else if (alarm.name === 'screenshot-capture') {
    captureAndSendScreenshot();
  }
});

// Screenshot Thumbnail Capture (for teacher dashboard grid view)
// Uses chrome.alarms (30s minimum) instead of setInterval so it survives
// MV3 service worker termination. setInterval dies when the SW goes inactive.
const SCREENSHOT_ALARM_NAME = 'screenshot-capture';
let screenshotScheduled = false;

function scheduleScreenshotCapture(enable) {
  if (enable && !screenshotScheduled) {
    screenshotScheduled = true;
    // chrome.alarms minimum is 30 seconds; use 0.5 min (30s) for near-real-time
    chrome.alarms.create(SCREENSHOT_ALARM_NAME, { periodInMinutes: 0.5 });
    // Also capture immediately when enabled
    captureAndSendScreenshot();
    console.log('[Screenshot] Scheduled periodic capture via chrome.alarms (every 30s)');
  } else if (!enable && screenshotScheduled) {
    screenshotScheduled = false;
    chrome.alarms.clear(SCREENSHOT_ALARM_NAME);
    console.log('[Screenshot] Stopped periodic capture');
  }
}

async function captureAndSendScreenshot() {
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
      active: screenLocked && !allowedDomains.length,
      url: lockedUrl,
      domain: lockedDomain,
    },
    flightPath: {
      active: screenLocked && allowedDomains.length > 0,
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
  screenLocked = Boolean(restrictions.flightPath.active || restrictions.screenLock.active);
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

function cleanupTeacherBroadcast(reason = 'stopped', options = {}) {
  if (!teacherBroadcastActive && !teacherBroadcastSessionId) {
    return;
  }
  const previousSessionId = teacherBroadcastSessionId;
  teacherBroadcastActive = false;
  teacherBroadcastSessionId = null;
  if (options.notifyTeacher && wsConnected) {
    wsSend({
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

function handleBroadcastStart(message = {}) {
  const nextSessionId = message.sessionId || message.broadcastSessionId || null;
  if (teacherBroadcastActive && teacherBroadcastSessionId !== nextSessionId) {
    cleanupTeacherBroadcast('replaced-by-new-broadcast', { notifyTeacher: true });
  }
  teacherBroadcastActive = true;
  teacherBroadcastSessionId = nextSessionId;
  wsSend({
    type: 'broadcast-join',
    sessionId: nextSessionId || undefined,
  });
}

function handleBroadcastStop() {
  cleanupTeacherBroadcast('teacher-stop', { notifyTeacher: false });
}

function handleBroadcastOffer(sdp) {
  if (!teacherBroadcastActive) {
    console.warn('[Broadcast] Ignoring offer because no broadcast session is active');
    return;
  }
  if (!sdp) {
    console.warn('[Broadcast] Ignoring empty broadcast offer');
    return;
  }
  console.warn('[Broadcast] Student-side teacher broadcast viewing is not available in this extension build; leaving broadcast');
  cleanupTeacherBroadcast('unsupported-broadcast-offer', { notifyTeacher: true });
}

function handleBroadcastIce(candidate) {
  if (!teacherBroadcastActive || !candidate) {
    return;
  }
  console.log('[Broadcast] Ignoring broadcast ICE after cleanup-only handling');
}

async function getClassroomCommandStateSnapshot() {
  const snapshot = {
    screenLocked,
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
    return {
      ...snapshot,
      tabCount: tabs.length,
      activeTab: activeTab ? {
        id: activeTab.id,
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
  broadcastToAllTabs('timer', { action: 'stop' });
  broadcastToAllTabs('poll', { action: 'close' });
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

async function handleRemoteControl(command, envelope = {}) {
  const commandId = getCommandIdFromMessage(envelope, command);
  const commandType = command?.type || 'unknown';
  const delivery = RuntimeCore.commandDeliveryState(command, envelope, Date.now());

  // One-shot actions never become a reconnect queue. If the device did not
  // receive the envelope before its deadline, report expiry without executing.
  if (delivery.expired) {
    if (commandId) {
      sendCommandAck(commandId, 'expired', {
        commandType,
        deliveryPolicy: delivery.deliveryPolicy,
        expiresAt: delivery.expiresAt,
        state: await getClassroomCommandStateSnapshot(),
        outcome: 'expired',
      });
    }
    return { expired: true, expiresAt: delivery.expiresAt };
  }

  if (commandId) {
    sendCommandAck(commandId, 'received', {
      commandType,
      deliveryPolicy: delivery.deliveryPolicy,
      expiresAt: delivery.expiresAt,
    });
  }

  try {
    const classroomState = envelope?.classroomState
      || envelope?.stateSnapshot
      || command?.classroomState
      || command?.data?.classroomState;
    let application = null;
    let result;
    if (classroomState && STATEFUL_COMMAND_TYPES.has(commandType)) {
      application = await applyClassroomState(classroomState, { reason: 'stateful_command' });
      result = {
        commandType,
        stateReconciled: true,
        appliedRevision: application.appliedRevision,
        outcome: application.outcome,
        completedAt: new Date().toISOString(),
      };
    } else if (STATEFUL_COMMAND_TYPES.has(commandType)) {
      result = await enqueueClassroomStateOperation(async () => {
        const runtimeBackup = classroomRuntimeBackup();
        const stateBackup = currentClassroomState;
        try {
          const legacyResult = await executeRemoteControlCommand(command || {});
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
      result = await executeRemoteControlCommand(command || {});
    }
    if (commandId) {
      sendCommandAck(commandId, 'completed', {
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
      sendCommandAck(commandId, 'failed', {
        commandType,
        error: commandErrorMessage(error),
        state: await getClassroomCommandStateSnapshot(),
        appliedRevision: currentClassroomState?.revision ?? 0,
        outcome: error?.code === 'UNSUPPORTED_CLASSROOM_STATE_SCHEMA' ? 'unsupported' : 'failed',
        deliveryPolicy: delivery.deliveryPolicy,
        expiresAt: delivery.expiresAt,
      });
    }
  }
}

async function executeRemoteControlCommand(command) {
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
          result.openedUrl = command.data.url;
          result.tabId = tab.id;
          console.log('Opened tab:', command.data.url);
          // Capture screenshot after tab loads so dashboard updates fast
          setTimeout(() => captureAndSendScreenshot(), 2000);
        }
        break;
        
      case 'close-tab':
        if (command.data.closeAll) {
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
        setTimeout(() => captureAndSendScreenshot(), 1500);
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
        allowedDomains = []; // Clear scene domains when locking to single domain
        
        // Persist lock-screen state to survive service worker restarts
        await chrome.storage.local.set({
          lockScreenState: {
            screenLocked: true,
            lockedUrl,
            lockedDomain,
            timestamp: Date.now()
          }
        });
        // Clear Flight Path state when locking screen
        await chrome.storage.local.remove('flightPathState');
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
        screenLocked = false;
        lockedUrl = null;
        lockedDomain = null;
        allowedDomains = []; // Clear all lock state
        activeFlightPathName = null; // Clear Flight Path name
        
        // Clear persisted lock-screen and Flight Path state
        await chrome.storage.local.remove(['lockScreenState', 'flightPathState']);
        console.log('[Unlock Screen] State cleared from storage');
        
        // Clear network-level blocking rules
        await clearBlockingRules();
        
        safeNotify({
          title: 'Screen Unlocked',
          message: 'Your screen has been unlocked. You can now browse freely.',
          priority: 1,
        });
        
        result.screenLocked = false;
        result.clearedStates = ['screen-lock', 'flight-path'];
        console.log('Screen unlocked');
        break;
        
      case 'apply-flight-path':
        {
          const requestedAllowedDomains = command.data.allowedDomains || [];
          if (!Array.isArray(requestedAllowedDomains) || requestedAllowedDomains.length === 0) {
            throw new Error('Missing allowed domains for Flight Path');
          }

          allowedDomains = RuntimeCore.normalizeDomainList(requestedAllowedDomains, 'Flight Path domains');
          activeFlightPathName = command.data.flightPathName || null;
        }
        screenLocked = true;
        lockedUrl = null; // Flight Path uses multiple domains, not a single URL
        lockedDomain = null; // Clear single domain when applying Flight Path
        
        // Persist Flight Path state to survive service worker restarts
        await chrome.storage.local.set({
          flightPathState: {
            screenLocked: true,
            allowedDomains,
            activeFlightPathName,
            timestamp: Date.now()
          }
        });
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
        
        result.screenLocked = true;
        result.allowedDomains = allowedDomains;
        result.activeFlightPathName = activeFlightPathName;
        console.log('Flight Path applied with allowed domains:', allowedDomains, 'Name:', activeFlightPathName);
        break;
        
      case 'remove-flight-path':
        screenLocked = false;
        lockedUrl = null;
        lockedDomain = null;
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
        
        result.screenLocked = false;
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
          teacherMaxTabs = Number.isSafeInteger(requestedLimit) && requestedLimit > 0
            ? Math.min(requestedLimit, 1000)
            : null;
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
        // Start/stop timer overlay on all tabs (fire-and-forget for instant response)
        const timerAction = command.data.action;
        const timerSeconds = command.data.seconds;
        const timerMessage = command.data.message || '';

        // Fire-and-forget - don't await to avoid any delay
        broadcastToAllTabs('timer', { action: timerAction, seconds: timerSeconds, message: timerMessage });

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
        console.log('Timer:', timerAction, timerSeconds, 'seconds');
        break;

      case 'poll':
        // Show/hide poll overlay on all tabs (fire-and-forget for instant response)
        const pollAction = command.data.action;
        const pollId = command.data.pollId;
        const pollQuestion = command.data.question;
        const pollOptions = command.data.options;

        // Dedup: skip if we already processed this exact poll start
        if (pollAction === 'start' && seenPollIds.has(pollId)) {
          console.log('Poll dedup: already shown', pollId);
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

        // Fire-and-forget - don't await to avoid any delay
        broadcastToAllTabs('poll', { action: pollAction, pollId, question: pollQuestion, options: pollOptions });

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
        chrome.storage.local.set({ handRaised: false });

        // Fire-and-forget - don't await to avoid any delay
        broadcastToAllTabs('hand-dismissed', command.data || {});

        result.handRaised = false;
        console.log('Hand dismissed notification sent');
        break;

      case 'messaging-toggle':
        // Update local storage with messaging enabled state
        const messagingEnabled = command.data.messagingEnabled ?? command.data.enabled;
        chrome.storage.local.set({ messagingEnabled });

        // Fire-and-forget - don't await to avoid any delay
        broadcastToAllTabs('messaging-toggle', { ...(command.data || {}), enabled: messagingEnabled });

        result.messagingEnabled = messagingEnabled;
        console.log('Messaging toggle sent:', messagingEnabled);
        break;

      case 'hand-raising-toggle':
        // Update local storage with hand raising enabled state
        const handRaisingEnabled = command.data.enabled;
        chrome.storage.local.set({ handRaisingEnabled });

        // Fire-and-forget - don't await to avoid any delay
        broadcastToAllTabs('hand-raising-toggle', { ...(command.data || {}), enabled: handRaisingEnabled });

        result.handRaisingEnabled = handRaisingEnabled;
        console.log('Hand raising toggle sent:', handRaisingEnabled);
        break;

      case 'fab-state':
        // Apply session lifecycle state pushed by SchoolPilot when classes start/end.
        const fabStateData = command.data || {};
        const appliedFabState = await applyFabSettings(fabStateData);

        // Fire-and-forget - content scripts update open FAB UI immediately.
        broadcastToAllTabs('fab-state', fabStateData);

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
async function handleChatMessage(message) {
  console.log('Chat message received:', message);

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

async function handleDurableTeacherMessage(message) {
  const expectedBinding = messageInboxAuthBinding();
  const commandId = getCommandIdFromMessage(message);
  const delivery = RuntimeCore.commandDeliveryState(
    { type: 'teacher-message', ...message.command },
    message,
    Date.now()
  );
  if (commandId) {
    sendCommandAck(commandId, 'received', {
      commandType: 'teacher-message',
      deliveryPolicy: delivery.deliveryPolicy,
      expiresAt: delivery.expiresAt,
    });
  }

  try {
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

    sendChatDeliveryAck(message, 'delivered');
    if (commandId) {
      sendCommandAck(commandId, 'completed', {
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
  } catch (error) {
    if (commandId) {
      sendCommandAck(commandId, 'failed', {
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
  
  // Check screen lock
  if (screenLocked) {
    let isAllowed = false;
    let blockedMessage = '';
    
    // Check if navigation is allowed based on lock type
    if (allowedDomains.length > 0) {
      // Scene mode: check against multiple allowed domains
      isAllowed = allowedDomains.some(domain => isOnSameDomain(details.url, domain));
      blockedMessage = `You can only access: ${allowedDomains.join(', ')}`;
    } else if (lockedDomain) {
      // Lock mode: check against single domain
      isAllowed = isOnSameDomain(details.url, lockedDomain);
      blockedMessage = `You can only browse within ${lockedDomain}`;
    }
    
    if (!isAllowed) {
      // Redirect back to locked URL or prevent navigation
      console.log('Blocked navigation to:', details.url);
      enqueueMonitoringEvent('navigation_blocked', {
        url: details.url,
        title: '',
        policySource: allowedDomains.length > 0 ? 'flight_path' : 'screen_lock',
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
    if (screenLocked && lockedDomain && allowedDomains.length === 0) {
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
  // Check if document already exists
  if (await chrome.offscreen.hasDocument?.()) {
    return;
  }
  
  // Prevent multiple creation attempts
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['USER_MEDIA', 'DISPLAY_MEDIA', 'BLOBS'],
      justification: 'Screen capture, WebRTC, and WebSocket must run in page context for MV3 compatibility'
    }).then(() => {
      console.log('[Service Worker] Offscreen document created');
    }).catch(error => {
      console.warn('[Service Worker] Offscreen document creation failed (will retry):', error?.message || error);
      creatingOffscreen = null;
    });
  }
  
  await creatingOffscreen;
}

async function closeOffscreenDocument() {
  if (await chrome.offscreen.hasDocument?.()) {
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
  
  try {
    return await chrome.runtime.sendMessage(message);
  } catch (error) {
    // Expected: offscreen might not be ready yet or connection lost
    console.info('[Service Worker] Offscreen communication deferred (expected during initialization):', error.message);
    return { success: false, error: error.message };
  }
}

// WebRTC: Handle screen share request from teacher (orchestrate via offscreen)
async function handleScreenShareRequest(mode = 'auto') {
  try {
    console.log('[WebRTC] Teacher requested screen share, mode:', mode);
    setObservedState(true, 'teacher-request');

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
      streamId: streamId
    });

    if (!result?.success) {
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

    console.log('[WebRTC] Screen capture initiated in offscreen document');

  } catch (error) {
    // Only unexpected errors reach here
    console.warn('[WebRTC] Unexpected screen share request error:', error);
    safeNotify({
      title: 'Screen Sharing Error',
      message: 'Unable to share screen: ' + error.message,
    });
  }
}

// WebRTC: Handle stop screen share request from teacher
async function handleStopScreenShare() {
  try {
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
    
  } catch (error) {
    console.warn('[WebRTC] Error stopping screen share:', error);
  }
}

// WebRTC: Handle offer from teacher (forward to offscreen)
async function handleOffer(sdp, from) {
  try {
    console.log('[WebRTC] Forwarding offer to offscreen document');
    
    const response = await sendToOffscreen({
      type: 'SIGNAL',
      payload: { type: 'offer', sdp: sdp, from: from }
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
async function handleIceCandidate(candidate) {
  try {
    const response = await sendToOffscreen({
      type: 'SIGNAL',
      payload: { type: 'ice', candidate: candidate }
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
async function stopScreenShare() {
  try {
    console.log('[WebRTC] Stopping screen share');
    await sendToOffscreen({
      type: 'STOP_SHARE'
    });
    await closeOffscreenDocument();
  } catch (error) {
    console.warn('[WebRTC] Error stopping screen share:', error);
  }
}

// Listen for messages FROM offscreen document
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
  
  // Handle WebSocket events from offscreen proxy
  if (message.type === 'WS_EVENT') {
    handleWsEvent(message.event, message.data);
    sendResponse({ success: true });
  }

  // Forward ICE candidates to teacher
  if (message.type === 'ICE_CANDIDATE') {
    wsSend({ type: 'ice', to: 'teacher', candidate: message.candidate });
    sendResponse({ success: true });
  }

  // Forward answer to teacher
  if (message.type === 'ANSWER') {
    wsSend({ type: 'answer', to: 'teacher', sdp: message.sdp });
    sendResponse({ success: true });
  }
  
  // Handle connection failures
  if (message.type === 'CONNECTION_FAILED') {
    console.log('[WebRTC] Connection failed, cleaning up');
    // Don't close offscreen document — it also hosts the WebSocket proxy
    setObservedState(false, 'connection-failed');
    sendResponse({ success: true });
  }
  
  // Handle capture errors
  if (message.type === 'CAPTURE_ERROR') {
    safeNotify({
      title: 'Screen Sharing Error',
      message: message.error || 'Failed to capture screen',
    });
    setObservedState(false, 'capture-error');
    sendResponse({ success: true });
  }
  
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
async function connectWebSocket() {
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

  const protocol = CONFIG.serverUrl.startsWith('https') ? 'wss' : 'ws';
  const wsUrl = `${protocol}://${new URL(CONFIG.serverUrl).host}/ws`;

  // Build auth payload to send immediately on connection
  const authPayload = {
    type: 'auth',
    role: 'student',
    deviceId: CONFIG.deviceId,
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
  try {
    await sendToOffscreen({ type: 'WS_CONNECT', url: wsUrl, authPayload });
    console.log('[WebSocket] Connection request sent to offscreen document');
  } catch (error) {
    console.warn('[WebSocket] Failed to send connect request to offscreen:', error?.message || error);
    scheduleWsReconnect();
  }
}

// Handle WebSocket events relayed from offscreen document
function handleWsEvent(event, data) {
  if (event === 'open') {
    console.log('WebSocket connected (via offscreen)');
    wsConnected = true;
    wsReconnectBackoffMs = 10000;
  } else if (event === 'error') {
    console.warn('WebSocket connection issue');
  } else if (event === 'close') {
    console.log('WebSocket disconnected');
    wsConnected = false;
    setObservedState(false, 'ws-closed');
    cleanupTeacherBroadcast('ws-closed', { notifyTeacher: false });
    scheduleWsReconnect();
  } else if (event === 'message') {
    handleWsMessage(data).catch((error) => {
      console.warn('Error processing WebSocket message:', error);
    });
  }
}

// Process incoming WebSocket message (same logic as before, just extracted)
async function handleWsMessage(rawData) {
    try {
      const message = JSON.parse(rawData);
      console.log('WebSocket message:', message);
      
      // Handle authentication success with settings
      if (message.type === 'auth-success') {
        console.log('WebSocket authenticated successfully');
        
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
            (async () => {
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
            })();
          }
        }

        // Handle global blocked domains (school-wide blacklist)
        if (message.settings && message.settings.globalBlockedDomains) {
          const receivedGlobalBlockedDomains = message.settings.globalBlockedDomains;
          console.log('[Blacklist] Received from server:', receivedGlobalBlockedDomains);

          // Apply blacklist rules and persist to storage
          (async () => {
            try {
              await updateGlobalBlacklistRules(receivedGlobalBlockedDomains);
              await chrome.storage.local.set({ globalBlockedDomains });
              console.log('[Blacklist] Persisted to storage');
            } catch (error) {
              console.warn('[Blacklist] Error applying rules:', error);
            }
          })();
        }

        if (message.settings?.fab) {
          applyFabSettings(message.settings.fab).catch((error) => {
            console.warn('[FAB] Failed to apply initial state:', error);
          });
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
        }
        requestClassroomStateSync('websocket-auth', true);
      }

      if (['classroom-state', 'classroom-state-sync', 'student-control-state'].includes(message.type)) {
        if (Object.prototype.hasOwnProperty.call(message, 'classroomState')) {
          await applyClassroomStateFromAuthResponse(message, 'websocket_reconcile').catch((error) => {
            console.warn('[Classroom State] WebSocket snapshot failed:', error?.message || error);
          });
        } else {
          const snapshot = message.state || message.snapshot;
          if (!snapshot) return;
          applyClassroomState(snapshot, { reason: 'websocket_reconcile' }).catch((error) => {
            console.warn('[Classroom State] WebSocket snapshot failed:', error?.message || error);
          });
        }
      }

      // Handle global blacklist updates from server
      if (message.type === 'update-global-blacklist') {
        const receivedGlobalBlockedDomains = message.blockedDomains || [];
        console.log('[Blacklist] Update received from server:', receivedGlobalBlockedDomains);
        
        // Apply updated blacklist rules and persist to storage
        (async () => {
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
        })();
      }
      
      // Handle WebRTC signaling - teacher requesting to view screen
      if (message.type === 'request-stream') {
        console.log('[WebRTC] Teacher requested screen share');
        // mode: 'auto' (default) = try silent tab capture, fallback to picker
        // mode: 'tab' = only silent tab capture
        // mode: 'screen' = only picker
        const mode = message.mode || 'auto';
        handleScreenShareRequest(mode);
      }
      
      // Handle stop-share request from teacher
      if (message.type === 'stop-share') {
        console.log('[WebRTC] Teacher requested to stop screen share');
        handleStopScreenShare();
      }

      if (message.type === 'student-session-replaced') {
        console.warn('[Auth] This student signed in on another Chromebook');
        clearStudentAuth('session-replaced', { notifyBackend: false, pauseAutoRegistration: true }).catch(() => {});
      }
      
      // Handle WebRTC offer from teacher
      if (message.type === 'offer') {
        console.log('[WebRTC] Received offer from teacher');
        handleOffer(message.sdp, message.from);
      }
      
      // Handle WebRTC ICE candidate from teacher
      if (message.type === 'ice') {
        console.log('[WebRTC] Received ICE candidate from teacher');
        if (message.candidate) {
          handleIceCandidate(message.candidate);
        }
      }
      
      // Handle ping notifications
      if (message.type === 'ping') {
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
        handleRemoteControl(message.command, message).catch((error) => {
          console.warn('Unhandled remote control command error:', error);
        });
      }
      
      // Handle chat messages (Phase 2)
      if (message.type === 'chat') {
        handleChatMessage(message);
      }

      // Handle teacher reply messages — send to chat thread
      // A storage-backed, identity-bound ledger deduplicates local + Redis
      // delivery as well as later heartbeat inbox retries across worker restarts.
      if (message.type === 'teacher-message') {
        handleDurableTeacherMessage(message).catch((error) => {
          console.warn('Teacher message delivery failed:', error?.message || error);
        });
      }

      // Handle teacher closing the chat
      // Dedup: local + Redis both deliver the same message
      if (message.type === 'chat-closed') {
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
        handleCheckInRequest(message);
      }

      // ====================================
      // TEACHER BROADCAST (Receiving teacher's screen)
      // ====================================

      // Teacher started broadcasting - request to join
      if (message.type === 'teacher-broadcast-start') {
        console.log('[Broadcast] Teacher started broadcasting, requesting to join');
        handleBroadcastStart(message);
      }

      // Teacher stopped broadcasting
      if (message.type === 'teacher-broadcast-stop') {
        console.log('[Broadcast] Teacher stopped broadcasting');
        handleBroadcastStop();
      }

      // Received broadcast offer from teacher
      if (message.type === 'broadcast-offer') {
        console.log('[Broadcast] Received offer from teacher');
        handleBroadcastOffer(message.sdp);
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

  if (message.type === 'get-auth-state') {
    expireManualAuthIfStale('get-auth-state')
      .then(() => hasStudentAuth() ? null : refreshSharedSignInLoginConfig())
      .then(() => {
        const response = { success: true, state: getAuthGateState() };
        if (message.includeConfig) response.config = CONFIG;
        sendResponse(response);
      })
      .catch((error) => {
        const response = { success: false, error: error.message, state: getAuthGateState() };
        if (message.includeConfig) response.config = CONFIG;
        sendResponse(response);
      });
    return true;
  }

  if (message.type === 'get-login-roster') {
    fetchLoginRosterForGate({ gradeLevel: message.gradeLevel })
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
    clearStudentAuth('explicit_sign_out', { notifyBackend: true, pauseAutoRegistration: isManualIdentitySource() })
      .then(() => sendResponse({ success: true }))
      .catch((error) => sendResponse({ success: false, error: error.message || 'Could not sign out' }));
    return true;
  }

  // Handle poll response from content script
  if (message.type === 'poll-response') {
    const { pollId, selectedOption } = message;
    console.log('Poll response received:', pollId, selectedOption);

    // Send poll response to server
    if (CONFIG.deviceId && CONFIG.serverUrl) {
      const headers = buildDeviceAuthHeaders();
      headers['Content-Type'] = 'application/json';

      fetchWithBackoff(`${CONFIG.serverUrl}/api/polls/${pollId}/respond`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          deviceId: CONFIG.deviceId,
          studentId: CONFIG.activeStudentId,
          selectedOption,
        }),
      }, {
        context: 'poll response',
        maxAttempts: 2,
        respectGlobalBackoff: false,
      })
        .then(res => res.json())
        .then(data => {
          console.log('Poll response submitted:', data);
        })
        .catch(err => {
          console.warn('Failed to submit poll response:', err);
        });
    }

    sendResponse({ success: true });
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
      .then(data => {
        console.log('Hand raised:', data);
        chrome.storage.local.set({ handRaised: true });
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
      .then(data => {
        console.log('Hand lowered:', data);
        chrome.storage.local.set({ handRaised: false });
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

    const headers = buildDeviceAuthHeaders();
    headers['Content-Type'] = 'application/json';

    fetchWithBackoff(`${CONFIG.serverUrl}/api/student/send-message`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        message: message.message.trim(),
        messageType: message.messageType || 'message',
      }),
    }, {
      context: 'student message',
      maxAttempts: 2,
      respectGlobalBackoff: false,
    })
      .then(parseJsonResponse)
      .then(data => {
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
      chrome.storage.local.set({ config: CONFIG }, () => {
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
