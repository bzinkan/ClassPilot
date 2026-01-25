// ClassPilot - Service Worker
// Handles background heartbeat sending and tab monitoring

importScripts('config.js');
importScripts('vendor/sentry.browser.min.js');

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
const DEFAULT_SERVER_URL = 'https://www.classpilot.net';
const INJECTED_SERVER_URL = typeof globalThis.CLASSPILOT_SERVER_URL === 'string'
  ? globalThis.CLASSPILOT_SERVER_URL
  : '';

let CONFIG = {
  serverUrl: DEFAULT_SERVER_URL,
  deviceId: null,
  studentName: null,
  studentEmail: null,
  classId: null,
  isSharing: false,
  activeStudentId: null,
};

let ws = null;
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

let trackingState = TRACKING_STATES.OFF;
let idleState = 'active';
let schoolSettings = null;
let schoolSettingsFetchedAt = 0;
let wsReconnectBackoffMs = 5000;
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
let isScheduleHardOff = false;

// WebRTC: Offscreen document handles all WebRTC in MV3
// Service worker only orchestrates via messaging
let creatingOffscreen = null;
let offscreenReady = false;

// Storage helpers
const kv = {
  get: (keys) => new Promise(resolve => chrome.storage.local.get(keys, resolve)),
  set: (obj) => new Promise(resolve => chrome.storage.local.set(obj, resolve)),
};

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

  licenseActive = false;
  trackingState = TRACKING_STATES.OFF;
  if (observedHeartbeatTimer) {
    clearInterval(observedHeartbeatTimer);
    observedHeartbeatTimer = null;
  }
  scheduleHeartbeat(null);
  disconnectWebSocket();
  chrome.alarms.clear('ws-reconnect');
  chrome.alarms.clear('health-check');
  chrome.alarms.clear('settings-refresh');
  settingsAlarmScheduled = false;
  chrome.action.setBadgeText({ text: 'OFF' });

  await kv.set({ licenseActive: false, planStatus, licenseDisabledAt: Date.now() });
  notifyLicenseState({ type: 'CLASSPILOT_LICENSE_INACTIVE', planStatus });
}

async function checkLicenseStatus(reason = 'manual') {
  if (!CONFIG.serverUrl) {
    return;
  }

  try {
    const response = await fetch(`${CONFIG.serverUrl}/api/school/status`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        studentToken: CONFIG.studentToken || null,
        studentEmail: CONFIG.studentEmail || null,
      }),
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
  let managedConfig = {};
  if (chrome.storage?.managed) {
    try {
      managedConfig = await new Promise(resolve => chrome.storage.managed.get(['serverUrl'], resolve));
    } catch (error) {
      console.warn('[Service Worker] Managed config read failed:', error);
    }
  }

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
    const response = await fetch(primaryUrl, { cache: 'no-store' });
    if (response.ok) {
      return await response.json();
    }
    if (response.status === 404) {
      const fallbackResponse = await fetch(fallbackUrl, { cache: 'no-store' });
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
  if (!enableTrackingHours) {
    return true;
  }

  const startTime = trackingStartTime || '00:00';
  const endTime = trackingEndTime || '23:59';
  const timezone = schoolTimezone || 'America/New_York';
  const activeDays = trackingDays || ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'];

  try {
    const now = new Date();
    const schoolDayName = now.toLocaleString('en-US', {
      timeZone: timezone,
      weekday: 'long',
    });

    if (!activeDays.includes(schoolDayName)) {
      return false;
    }

    const schoolTimeString = now.toLocaleString('en-US', {
      timeZone: timezone,
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
    });

    const currentTime = schoolTimeString.split(', ')[1] || schoolTimeString;
    return currentTime >= startTime && currentTime <= endTime;
  } catch (error) {
    console.error('[School Hours] Error checking tracking hours:', error);
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
    const response = await fetch(`${CONFIG.serverUrl}/api/extension/settings`, {
      cache: 'no-store',
      headers: {
        'Authorization': `Bearer ${CONFIG.studentToken}`,
      },
    });
    if (!response.ok) {
      throw new Error(`Settings fetch failed (${response.status})`);
    }
    const settings = await response.json();
    schoolSettings = settings;
    schoolSettingsFetchedAt = now;
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
  chrome.alarms.clear('health-check');
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
  offHoursNetworkPaused = false;
  await refreshSchoolSettings({ force: true });
  await checkLicenseStatus('resume');
  await updateTrackingState('resume');
}

async function safeSendHeartbeat(reason) {
  try {
    await sendHeartbeat(reason);
  } catch (error) {
    if (globalThis.Sentry?.captureException) {
      globalThis.Sentry.captureException(error);
    }
    console.error(`[Heartbeat] Failed (${reason}):`, error);
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

async function updateTrackingState(reason = 'state-check') {
  if (!licenseActive) {
    if (trackingState !== TRACKING_STATES.OFF) {
      trackingState = TRACKING_STATES.OFF;
      scheduleHeartbeat(null);
      scheduleScreenshotCapture(false);  // Disable screenshots when license inactive
      disconnectWebSocket();
      syncObservedHeartbeat('license-inactive');
    }
    return;
  }

  const nextState = determineTrackingState();
  if (nextState === TRACKING_STATES.OFF && isScheduleHardOff) {
    if (trackingState !== nextState) {
      trackingState = nextState;
      console.log(`[Tracking] State updated to ${trackingState} (${reason})`);
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

  trackingState = nextState;
  console.log(`[Tracking] State updated to ${trackingState} (${reason})`);

  if (trackingState === TRACKING_STATES.ACTIVE) {
    scheduleHeartbeat(HEARTBEAT_ACTIVE_MINUTES);
    scheduleScreenshotCapture(true);  // Enable screenshot capture when active
    connectWebSocket();
  } else if (trackingState === TRACKING_STATES.IDLE) {
    // Keep same heartbeat frequency and WebSocket connected even when Chrome reports idle
    // Chrome's idle detection (no keyboard/mouse) doesn't mean student is away
    scheduleHeartbeat(HEARTBEAT_IDLE_MINUTES);
    scheduleScreenshotCapture(true);  // Keep screenshots even when idle
    connectWebSocket();
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
      idleState = state;
      updateTrackingState('idle-initial'); // Idle behavior: switch states based on idle/locked signal.
    });
    chrome.idle.onStateChanged.addListener((state) => {
      idleState = state;
      updateTrackingState('idle-change'); // Idle behavior: switch states based on idle/locked signal.
    });
    idleListenerReady = true;
  }

  if (!settingsAlarmScheduled) {
    chrome.alarms.create('settings-refresh', { periodInMinutes: 60 });
    settingsAlarmScheduled = true;
  }

  updateTrackingState(reason);
}

function queueNavigationEvent(eventType, url, title, metadata = {}) {
  // Allow both ACTIVE and IDLE states (IDLE just means no keyboard/mouse, not away)
  if (!licenseActive || trackingState === TRACKING_STATES.OFF) {
    return;
  }
  if (!isHttpUrl(url)) {
    return;
  }

  const key = `${eventType}:${metadata.tabId ?? 'unknown'}`;
  pendingNavigationEvents.set(key, { eventType, url, title, metadata });

  if (navigationDebounceTimers.has(key)) {
    clearTimeout(navigationDebounceTimers.get(key));
  }

  navigationDebounceTimers.set(key, setTimeout(async () => {
    const event = pendingNavigationEvents.get(key);
    pendingNavigationEvents.delete(key);
    navigationDebounceTimers.delete(key);

    if (!event || trackingState === TRACKING_STATES.OFF) {
      return;
    }

    if (!CONFIG.deviceId) return;

    try {
      const headers = buildDeviceAuthHeaders();
      const payload = {
        deviceId: CONFIG.deviceId,
        eventType: event.eventType,
        metadata: {
          url: event.url,
          title: event.title,
          ...event.metadata,
        },
      };
      attachLegacyStudentToken(payload, headers);

      const response = await fetch(`${CONFIG.serverUrl}/api/device/event`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      });
      if (response.status === 402) {
        const data = await response.json().catch(() => ({}));
        await disableForInactiveLicense(data.planStatus);
      }
    } catch (error) {
      console.error('Event logging error:', error);
    }
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
    console.error('[Service Worker] Email normalization failed:', err);
    return null;
  }
}

// Auto-registration: ensures extension always has IDs before sharing
// EMAIL-FIRST IDENTITY: Email is required, deviceId is internal tracking only
async function ensureRegistered() {
  console.log('[Service Worker] Ensuring registration...');
  
  try {
    // Load config from server
    const serverUrl = CONFIG.serverUrl || DEFAULT_SERVER_URL;
    await fetchClientConfig(serverUrl);
    
    // Get or create IDs (including studentToken for consistent state)
    let stored = await kv.get(['studentEmail', 'deviceId', 'registered', 'lastRegisteredEmail', 'studentToken']);
    
    // Get student email from Chrome profile (managed devices)
    if (!stored.studentEmail && chrome.identity?.getProfileUserInfo) {
      try {
        const profile = await new Promise(resolve => 
          chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' }, resolve)
        );
        if (profile?.email) {
          stored.studentEmail = normalizeEmail(profile.email);
          console.log('[Service Worker] Auto-detected email');
        }
      } catch (err) {
        console.log('[Service Worker] Could not get profile info:', err);
      }
    }
    
    // If we still have no email, this is probably a dev machine
    // For production, bail out. For dev, use a test email.
    if (!stored.studentEmail) {
      console.warn('[Service Worker] No studentEmail detected – running in dev mode');
      // Uncomment for dev testing: stored.studentEmail = 'dev-student@example.com';
    }
    
    // Always create a deviceId internally (never exposed to teachers)
    if (!stored.deviceId) {
      stored.deviceId = 'device-' + crypto.randomUUID().slice(0, 11);
    }
    
    // Save to storage
    await kv.set(stored);
    
    // Update CONFIG (email is primary identity - backend will determine schoolId from email domain)
    CONFIG.studentEmail = stored.studentEmail;
    CONFIG.studentName = stored.studentEmail ? stored.studentEmail.split('@')[0] : stored.studentEmail;
    CONFIG.deviceId = stored.deviceId;
    CONFIG.classId = 'auto'; // Backend determines this from email domain
    
    // ✅ JWT FIX: Load existing studentToken BEFORE deciding to skip registration
    // This prevents timing issues where service worker wakes up without token in memory
    if (stored.studentToken) {
      CONFIG.studentToken = stored.studentToken;
      console.log('✅ [JWT] Loaded existing studentToken in ensureRegistered()');
    }
    
    // Register with server if we have email and haven't registered yet (or email changed)
    const emailChanged = stored.lastRegisteredEmail !== stored.studentEmail;
    const needsRegistration = stored.studentEmail && (!stored.registered || emailChanged);
    
    if (needsRegistration) {
      try {
        console.log('[Service Worker] Registering student with server');
        const response = await fetch(`${CONFIG.serverUrl}/api/extension/register`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            deviceId: stored.deviceId,
            deviceName: null, // No device name needed
            studentEmail: stored.studentEmail,
            studentName: CONFIG.studentName,
          }),
        });
        
        if (!response.ok) {
          const errorData = await response.json().catch(() => ({ error: 'Unknown error' }));
          throw new Error(errorData.error || 'Student registration failed');
        }
        
        const data = await response.json();
        console.log('[Service Worker] Student registered successfully');
        
        // ✅ JWT AUTHENTICATION: Store studentToken for secure authentication
        if (data.studentToken) {
          console.log('✅ [JWT] Received studentToken from server - storing for future heartbeats');
          await kv.set({ studentToken: data.studentToken });
          CONFIG.studentToken = data.studentToken; // Cache in memory too
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
      } catch (error) {
        console.error('[Service Worker] Student registration error:', error);
        // ✅ JWT FIX: Clear BOTH registered flag AND token so we retry next time
        // This prevents getting stuck if re-registration fails after token expiry
        await kv.set({ registered: false, studentToken: null });
        CONFIG.studentToken = null;
        // Don't throw - extension can still try to send heartbeats
        // Schedule retry with backoff to prevent infinite loops
        setTimeout(() => {
          console.log('[Service Worker] Retrying registration after error...');
          ensureRegistered();
        }, 5000); // 5 second delay before retry
      }
    } else if (stored.studentEmail) {
      console.log('[Service Worker] Already registered');
    }
    
    console.log('[Service Worker] Registration complete');

    await checkLicenseStatus('registration');
    
    return stored;
  } catch (error) {
    console.error('[Service Worker] Registration failed:', error);
    // Don't throw - extension can still work with defaults
    return {};
  }
}

// Run auto-registration on install and startup
chrome.runtime.onInstalled.addListener(() => {
  console.log('[Service Worker] Extension installed/updated');
  resolveServerUrl().then((serverUrl) => {
    CONFIG.serverUrl = serverUrl;
    scheduleLicenseCheck();
    ensureRegistered();
    setTimeout(() => initializeAdaptiveTracking('install'), 2000);
  });
});

if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    console.log('[Service Worker] Browser started');
    resolveServerUrl().then((serverUrl) => {
      CONFIG.serverUrl = serverUrl;
      scheduleLicenseCheck();
      ensureRegistered();
      setTimeout(() => initializeAdaptiveTracking('startup'), 2000);
    });
  });
}

// Run immediately on service worker load/wake-up
// This is CRITICAL: service worker can wake up after being terminated, not just on install/startup
(async () => {
  console.log('[Service Worker] Waking up...');
  const stored = await chrome.storage.local.get([
    'deviceId',
    'config',
    'activeStudentId',
    'studentEmail',
    'flightPathState',
    'lockScreenState',
    'licenseActive',
    'planStatus',
    'globalBlockedDomains',
    'teacherBlockListState',
  ]);
  const resolvedServerUrl = await resolveServerUrl();

  // Restore state from storage (do not override resolved serverUrl)
  if (stored.config) {
    const { serverUrl, ...safeConfig } = stored.config;
    CONFIG = { ...CONFIG, ...safeConfig };
  }
  CONFIG.serverUrl = resolvedServerUrl;
  scheduleLicenseCheck();
  if (stored.deviceId) {
    CONFIG.deviceId = stored.deviceId;
  }
  if (stored.activeStudentId) {
    CONFIG.activeStudentId = stored.activeStudentId;
  }
  if (stored.studentEmail) {
    CONFIG.studentEmail = stored.studentEmail;
  }
  
  // Restore Flight Path state if it was active
  if (stored.flightPathState) {
    console.log('[Service Worker] Restoring Flight Path state:', stored.flightPathState);
    screenLocked = stored.flightPathState.screenLocked;
    allowedDomains = stored.flightPathState.allowedDomains || [];
    activeFlightPathName = stored.flightPathState.activeFlightPathName;
    
    // Re-apply blocking rules if Flight Path was active
    if (allowedDomains.length > 0) {
      await updateBlockingRules(allowedDomains);
      console.log('[Service Worker] Flight Path blocking rules re-applied');
    }
  }
  // Restore Lock Screen state if it was active
  else if (stored.lockScreenState) {
    console.log('[Service Worker] Restoring Lock Screen state:', stored.lockScreenState);
    screenLocked = stored.lockScreenState.screenLocked;
    lockedUrl = stored.lockScreenState.lockedUrl;
    lockedDomain = stored.lockScreenState.lockedDomain;
    
    // Re-apply blocking rules if screen was locked
    if (lockedDomain) {
      await updateBlockingRules([lockedDomain]);
      console.log('[Service Worker] Lock Screen blocking rules re-applied');
    }
  }
  
  // Restore global blacklist state
  if (stored.globalBlockedDomains && stored.globalBlockedDomains.length > 0) {
    globalBlockedDomains = stored.globalBlockedDomains;
    await updateGlobalBlacklistRules(globalBlockedDomains);
    console.log('[Service Worker] Global blacklist rules re-applied:', globalBlockedDomains);
  }

  // Teacher block lists are SESSION-BASED and NOT restored on wake
  // They only apply while the student is actively in a teacher's class session
  // Clear any stale teacher block list state from storage
  if (stored.teacherBlockListState) {
    await chrome.storage.local.remove('teacherBlockListState');
    console.log('[Service Worker] Cleared stale teacher block list state (session-based, not persisted)');
  }
  // Reset in-memory teacher block list state
  teacherBlockedDomains = [];
  activeBlockListName = null;
  // Clear any existing teacher block list rules
  await clearTeacherBlockListRules();

  console.log('[Service Worker] State restored:', {
    deviceId: CONFIG.deviceId,
    studentEmail: CONFIG.studentEmail,
    flightPathActive: allowedDomains.length > 0,
    screenLocked: screenLocked,
    globalBlockedDomains: globalBlockedDomains.length,
    teacherBlockedDomains: 0 // Always 0 on wake - session-based
  });

  if (stored.licenseActive === false) {
    await disableForInactiveLicense(stored.planStatus);
  }

  await ensureRegistered();
  
  // Initialize adaptive tracking after state is restored
  setTimeout(() => {
    console.log('[Service Worker] Initializing adaptive tracking...');
    initializeAdaptiveTracking('wake');
  }, 2000);
})();

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
    // Never use console.error for expected conditions; keep the Errors panel clean
    console.warn('notify skipped:', e?.message || e);
  }
}

// Declarative Net Request - Block unauthorized domains
const BLOCK_RULE_ID = 1;

// Prevent race conditions with a simple lock
let blockingRulesUpdateInProgress = false;
let pendingBlockingRulesUpdate = null;

async function updateBlockingRules(allowedDomains) {
  // If an update is in progress, queue this one
  if (blockingRulesUpdateInProgress) {
    pendingBlockingRulesUpdate = allowedDomains;
    return;
  }
  
  blockingRulesUpdateInProgress = true;
  
  try {
    // Remove existing rules first
    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    const ruleIdsToRemove = existingRules.map(rule => rule.id);
    
    if (ruleIdsToRemove.length > 0) {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: ruleIdsToRemove
      });
    }
    
    // If no allowed domains, we're done (unlocked state)
    if (!allowedDomains || allowedDomains.length === 0) {
      console.log('Blocking rules cleared - navigation is unrestricted');
      return;
    }
    
    // Create a blocking rule for everything EXCEPT allowed domains
    const rules = [
      {
        id: BLOCK_RULE_ID,
        priority: 1,
        action: {
          type: "block"
        },
        condition: {
          resourceTypes: ["main_frame"],
          excludedRequestDomains: allowedDomains.map(d => d.replace(/^https?:\/\//, '').replace(/\/$/, ''))
        }
      }
    ];
    
    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: rules
    });
    
    console.log('Blocking rules updated. Allowed domains:', allowedDomains);
  } catch (error) {
    // Only log if it's not a duplicate ID error (which we now prevent)
    if (!error.message.includes('unique ID')) {
      console.warn('Error updating blocking rules:', error.message);
    }
  } finally {
    blockingRulesUpdateInProgress = false;
    
    // If there's a pending update, process it now
    if (pendingBlockingRulesUpdate !== null) {
      const pending = pendingBlockingRulesUpdate;
      pendingBlockingRulesUpdate = null;
      await updateBlockingRules(pending);
    }
  }
}

async function clearBlockingRules() {
  await updateBlockingRules([]);
}

// Global Blacklist - blocks specific domains school-wide (independent of Flight Path)
// Uses rule IDs starting from 1000 to avoid conflicts with Flight Path rules (ID 1)
const BLACKLIST_RULE_START_ID = 1000;

async function updateGlobalBlacklistRules(blockedDomains) {
  try {
    // Get all existing rules to find blacklist rules (IDs >= 1000)
    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    const blacklistRuleIds = existingRules
      .filter(rule => rule.id >= BLACKLIST_RULE_START_ID)
      .map(rule => rule.id);
    
    // Remove existing blacklist rules
    if (blacklistRuleIds.length > 0) {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: blacklistRuleIds
      });
    }
    
    // If no blocked domains, we're done
    if (!blockedDomains || blockedDomains.length === 0) {
      console.log('[Blacklist] Cleared - no domains blocked');
      return;
    }
    
    // Create blocking rules for each domain
    const rules = blockedDomains.map((domain, index) => ({
      id: BLACKLIST_RULE_START_ID + index,
      priority: 10, // Higher priority than Flight Path (priority 1)
      action: {
        type: "block"
      },
      condition: {
        resourceTypes: ["main_frame"],
        requestDomains: [domain.replace(/^https?:\/\//, '').replace(/\/$/, '')]
      }
    }));
    
    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: rules
    });
    
    console.log('[Blacklist] Updated. Blocked domains:', blockedDomains);
  } catch (error) {
    console.error('[Blacklist] Error updating rules:', error.message);
  }
}

// Teacher Block List - blocks specific domains during teacher session
// Uses rule IDs starting from 2000 to avoid conflicts with global blacklist (1000+) and Flight Path (1)
const TEACHER_BLOCKLIST_RULE_START_ID = 2000;

async function updateTeacherBlockListRules(blockedDomains) {
  try {
    // Get all existing rules to find teacher blocklist rules (IDs >= 2000)
    const existingRules = await chrome.declarativeNetRequest.getDynamicRules();
    const teacherRuleIds = existingRules
      .filter(rule => rule.id >= TEACHER_BLOCKLIST_RULE_START_ID)
      .map(rule => rule.id);
    
    // Remove existing teacher blocklist rules
    if (teacherRuleIds.length > 0) {
      await chrome.declarativeNetRequest.updateDynamicRules({
        removeRuleIds: teacherRuleIds
      });
    }
    
    // If no blocked domains, we're done
    if (!blockedDomains || blockedDomains.length === 0) {
      console.log('[Teacher Block List] Cleared - no domains blocked');
      return;
    }
    
    // Create blocking rules for each domain
    const rules = blockedDomains.map((domain, index) => ({
      id: TEACHER_BLOCKLIST_RULE_START_ID + index,
      priority: 15, // Higher priority than global blacklist (10) and Flight Path (1)
      action: {
        type: "block"
      },
      condition: {
        resourceTypes: ["main_frame"],
        requestDomains: [domain.replace(/^https?:\/\//, '').replace(/\/$/, '')]
      }
    }));
    
    await chrome.declarativeNetRequest.updateDynamicRules({
      addRules: rules
    });
    
    console.log('[Teacher Block List] Updated. Blocked domains:', blockedDomains);
  } catch (error) {
    console.error('[Teacher Block List] Error updating rules:', error.message);
  }
}

async function clearTeacherBlockListRules() {
  await updateTeacherBlockListRules([]);
}

// Get logged-in Chromebook user info using Chrome Identity API
async function getLoggedInUserInfo() {
  try {
    const userInfo = await chrome.identity.getProfileUserInfo({ accountStatus: 'ANY' });
    console.log('Logged-in user info:', userInfo);
    return {
      email: userInfo.email || null,
      id: userInfo.id || null,
    };
  } catch (error) {
    console.error('Error getting logged-in user info:', error);
    return { email: null, id: null };
  }
}

// Auto-detect and register student based on Chromebook login
async function autoDetectAndRegister() {
  const userInfo = await getLoggedInUserInfo();
  
  if (userInfo.email) {
    console.log('Auto-detected student email:', userInfo.email);
    
    // Extract name from email (e.g., john.smith@school.edu -> john.smith)
    const emailName = userInfo.email.split('@')[0];
    const displayName = emailName.replace(/\./g, ' ').replace(/\b\w/g, l => l.toUpperCase());
    
    CONFIG.studentEmail = userInfo.email;
    CONFIG.studentName = displayName;
    
    await chrome.storage.local.set({ 
      studentEmail: userInfo.email,
      studentName: displayName,
    });
    
    // Auto-register if not already registered
    const stored = await chrome.storage.local.get(['registered']);
    if (!stored.registered) {
      try {
        // Get or create device ID
        const deviceId = await getOrCreateDeviceId();
        
        // Register with auto-detected info
        await registerDeviceWithStudent(deviceId, null, 'default-class', userInfo.email, displayName);
        console.log('Auto-registered student:', userInfo.email);
      } catch (error) {
        console.error('Auto-registration failed:', error);
      }
    }
  } else {
    console.warn('Could not detect logged-in user email - manual registration required');
  }
}

// Load config from storage on startup
chrome.storage.local.get(['config', 'activeStudentId', 'studentEmail', 'studentToken'], async (result) => {
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

  // ✅ JWT AUTHENTICATION: Load studentToken from storage
  if (result.studentToken) {
    CONFIG.studentToken = result.studentToken;
    console.log('✅ [JWT] Loaded studentToken from storage');
  }

  // Auto-detect logged-in user and register
  await autoDetectAndRegister();

  // Initialize adaptive tracking once config is loaded
  if (CONFIG.deviceId) {
    initializeAdaptiveTracking('config-loaded');
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
    const response = await fetch(`${CONFIG.serverUrl}/api/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId,
        deviceName, // Device name instead of student name
        classId,
      }),
    });
    
    if (!response.ok) throw new Error('Registration failed');
    
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
    console.error('Registration error:', error);
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
    const response = await fetch(`${CONFIG.serverUrl}/api/extension/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        deviceId,
        deviceName,
        classId,
        studentEmail,
        studentName,
      }),
    });
    
    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(errorData.message || 'Student registration failed');
    }
    
    const data = await response.json();
    console.log('Student auto-registered:', data);
    
    // Save config with student info
    CONFIG.deviceId = deviceId;
    CONFIG.studentName = studentName;
    CONFIG.studentEmail = studentEmail;
    CONFIG.classId = classId;
    CONFIG.activeStudentId = data.student?.id || null;
    
    await chrome.storage.local.set({ 
      config: CONFIG,
      registered: true,
      activeStudentId: data.student?.id || null,
    });
    
    // Start adaptive tracking after registration
    initializeAdaptiveTracking('student-registered');
    
    return data;
  } catch (error) {
    console.error('Student registration error:', error);
    throw error;
  }
}

// Send heartbeat with current tab info
async function sendHeartbeat(reason = 'manual') {
  if (!licenseActive) {
    return;
  }
  if (trackingState === TRACKING_STATES.OFF) {
    return;
  }
  // EMAIL-FIRST: Require email before sending heartbeats
  if (!CONFIG.studentEmail) {
    console.log('Skipping heartbeat - no studentEmail (dev mode or not logged in)');
    return;
  }
  
  if (!CONFIG.deviceId) {
    console.log('Skipping heartbeat - no deviceId');
    return;
  }
  
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
      studentEmail: CONFIG.studentEmail,    // 🟢 Primary identity - backend determines schoolId from domain
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
    };
    
    const headers = buildDeviceAuthHeaders();
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
    
    const response = await fetch(`${CONFIG.serverUrl}/api/device/heartbeat`, {
      method: 'POST',
      headers,
      body: JSON.stringify(heartbeatData),
    });
    
    if (response.status === 402) {
      const data = await response.json().catch(() => ({}));
      await disableForInactiveLicense(data.planStatus);
      return;
    } else if (response.status === 401 || response.status === 403) {
      const data = await response.json().catch(() => ({}));
      if (data?.error === "school_not_entitled") {
        await disableForInactiveLicense(data.planStatus);
        return;
      }
      // ✅ JWT INVALID/EXPIRED: Token expired (401) or invalid (403) - need to re-register
      console.warn(`❌ [JWT] Token ${response.status === 401 ? 'expired' : 'invalid'} (${response.status}) - clearing token and re-registering`);
      await kv.set({ studentToken: null, registered: false });
      CONFIG.studentToken = null;
      // Trigger re-registration (with backoff to prevent infinite loops)
      setTimeout(() => ensureRegistered(), 2000); // 2 second delay before re-registering
      return; // Skip rest of error handling
    } else if (response.status >= 500) {
      // Server error - log and wait for next scheduled heartbeat
      console.error('Heartbeat server error:', response.status);
      chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' });
      chrome.action.setBadgeText({ text: '!' });
    } else if (response.ok) {
      chrome.action.setBadgeBackgroundColor({ color: '#22c55e' });
      chrome.action.setBadgeText({ text: '●' });
    } else {
      // Client error (400s) - log but don't retry
      console.error('Heartbeat client error:', response.status);
      chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
      chrome.action.setBadgeText({ text: '!' });
    }
    
  } catch (error) {
    if (globalThis.Sentry?.captureException) {
      globalThis.Sentry.captureException(error);
    }
    console.error('Heartbeat network error:', error);
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
    chrome.action.setBadgeText({ text: '!' });
    throw error;
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
  updateTrackingState('health-check');

  const heartbeatAlarm = await chrome.alarms.get('heartbeat');
  if (trackingState === TRACKING_STATES.ACTIVE && !heartbeatAlarm) {
    scheduleHeartbeat(HEARTBEAT_ACTIVE_MINUTES);
  } else if (trackingState === TRACKING_STATES.IDLE && !heartbeatAlarm) {
    scheduleHeartbeat(HEARTBEAT_IDLE_MINUTES);
  } else if (trackingState === TRACKING_STATES.OFF && heartbeatAlarm) {
    scheduleHeartbeat(null);
  }
  console.log('[Health Check] Complete - tracking state checked');
}

// Alarm listener for heartbeat and WebSocket reconnection
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'heartbeat') {
    safeSendHeartbeat('alarm');
  } else if (alarm.name === 'ws-reconnect') {
    // WebSocket reconnection alarm - reliable even if service worker was terminated
    console.log('WebSocket reconnection alarm triggered');
    connectWebSocket();
  } else if (alarm.name === 'health-check') {
    // Periodic health check to ensure heartbeat and WebSocket are running
    // This recovers from service worker restarts without needing manual reload
    healthCheck();
  } else if (alarm.name === 'wake-up') {
    loadCachedSchoolSettings().then(() => {
      updateTrackingState('wake-up');
    });
  } else if (alarm.name === 'settings-refresh') {
    refreshSchoolSettings({ force: false }).then(() => {
      updateTrackingState('settings-refresh');
    });
  } else if (alarm.name === 'license-check') {
    checkLicenseStatus('alarm');
  } else if (alarm.name === 'screenshot-capture') {
    captureAndSendScreenshot();
  }
});

// Screenshot Thumbnail Capture (for teacher dashboard grid view)
const SCREENSHOT_INTERVAL_MS = 10000; // 10 seconds
let screenshotIntervalId = null;

function scheduleScreenshotCapture(enable) {
  if (enable && !screenshotIntervalId) {
    // Use setInterval for 10-second captures (Chrome alarms minimum is 30 seconds)
    screenshotIntervalId = setInterval(() => {
      captureAndSendScreenshot();
    }, SCREENSHOT_INTERVAL_MS);
    // Also capture immediately when enabled
    captureAndSendScreenshot();
    console.log('[Screenshot] Scheduled periodic capture every 10 seconds');
  } else if (!enable && screenshotIntervalId) {
    clearInterval(screenshotIntervalId);
    screenshotIntervalId = null;
    console.log('[Screenshot] Stopped periodic capture');
  }
}

async function captureAndSendScreenshot() {
  if (!licenseActive || trackingState === TRACKING_STATES.OFF) {
    return;
  }
  if (!CONFIG.studentEmail || !CONFIG.deviceId) {
    return;
  }

  try {
    // Get the last focused window
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || !tab.windowId) {
      console.log('[Screenshot] No active tab in focused window');
      return;
    }

    // Skip chrome:// and other non-HTTP pages
    if (!tab.url || !tab.url.startsWith('http')) {
      console.log('[Screenshot] Skipping non-HTTP page');
      return;
    }

    // Capture the visible tab as JPEG with quality for compression
    const dataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: 'jpeg',
      quality: 50  // Lower quality for smaller file size (~30-50KB)
    });

    if (!dataUrl) {
      console.log('[Screenshot] Capture returned empty');
      return;
    }

    // Send screenshot to server with tab metadata
    const headers = buildDeviceAuthHeaders();
    const response = await fetch(`${CONFIG.serverUrl}/api/device/screenshot`, {
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
    });

    if (!response.ok) {
      console.warn('[Screenshot] Upload failed:', response.status);
    } else {
      console.log('[Screenshot] Uploaded successfully');
    }
  } catch (error) {
    // Common errors: tab might be closed, permission denied for some pages
    console.log('[Screenshot] Capture error:', error.message);
  }
}

// Remote Control Handlers (Phase 1: GoGuardian-style features)
let screenLocked = false;
let lockedUrl = null;
let lockedDomain = null; // Single domain for lock-screen (e.g., "ixl.com")
let allowedDomains = []; // Multiple domains for apply-flight-path (e.g., ["ixl.com", "khanacademy.org"])
let activeFlightPathName = null; // Name of the currently active scene
let currentMaxTabs = null;
let globalBlockedDomains = []; // School-wide blacklist (e.g., ["lens.google.com", "chat.openai.com"])
let teacherBlockedDomains = []; // Teacher-applied session blacklist
let activeBlockListName = null; // Name of the currently active teacher block list
let temporaryAllowedDomains = []; // Temporarily unblocked domains with expiry times: [{ domain, expiresAt }]

// Helper function to extract domain from URL
function extractDomain(url) {
  try {
    const urlObj = new URL(url);
    // Remove 'www.' prefix for consistent matching
    return urlObj.hostname.replace(/^www\./, '');
  } catch (error) {
    console.error('Invalid URL:', url, error);
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

async function handleRemoteControl(command) {
  console.log('Remote control command received:', command);
  
  try {
    switch (command.type) {
      case 'open-tab':
        if (command.data.url) {
          await chrome.tabs.create({ url: command.data.url, active: true });
          console.log('Opened tab:', command.data.url);
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
          console.log(`Closed ${closedCount} specific tabs`);
        } else if (command.data.pattern) {
          // Close tabs matching pattern
          const tabs = await chrome.tabs.query({});
          for (const tab of tabs) {
            if (tab.url && tab.url.includes(command.data.pattern)) {
              try {
                await chrome.tabs.remove(tab.id);
                console.log('Closed tab matching pattern:', tab.url);
              } catch (error) {
                console.warn('Could not close tab:', tab.id, error);
              }
            }
          }
        }
        break;
        
      case 'lock-screen':
        screenLocked = true;
        
        // Handle "CURRENT_URL" special marker - lock to current active tab
        let urlToLock = command.data.url;
        if (urlToLock === "CURRENT_URL") {
          const allTabs = await chrome.tabs.query({});
          const activeTab = allTabs.find(t => t.active) || allTabs[0];
          if (activeTab && activeTab.url) {
            urlToLock = activeTab.url;
            console.log('[Lock Screen] Using current tab URL:', urlToLock);
          } else {
            console.warn('[Lock Screen] No active tab found, cannot lock to current URL');
            break;
          }
        }
        
        lockedUrl = urlToLock;
        lockedDomain = extractDomain(lockedUrl); // Extract domain for domain-based locking
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
        
        console.log('Screen unlocked');
        break;
        
      case 'apply-flight-path':
        screenLocked = true;
        lockedUrl = null; // Flight Path uses multiple domains, not a single URL
        lockedDomain = null; // Clear single domain when applying Flight Path
        
        // Store allowed domains and Flight Path name
        allowedDomains = command.data.allowedDomains || [];
        activeFlightPathName = command.data.flightPathName || null;
        
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
        
        console.log('Flight Path removed - all restrictions cleared');
        break;

      case 'temp-unblock':
        // Temporarily allow access to a blocked domain
        const tempDomain = command.data.domain;
        const tempExpiresAt = command.data.expiresAt || (Date.now() + 5 * 60 * 1000);
        const tempDuration = command.data.durationMinutes || 5;

        // Add to temporary allowed list
        temporaryAllowedDomains = temporaryAllowedDomains.filter(d => d.domain !== tempDomain);
        temporaryAllowedDomains.push({ domain: tempDomain, expiresAt: tempExpiresAt });

        safeNotify({
          title: 'Temporary Access Granted',
          message: `Your teacher has temporarily unblocked ${tempDomain} for ${tempDuration} minutes.`,
          priority: 1,
        });

        console.log('[Temp Unblock] Temporarily allowed domain:', tempDomain, 'until', new Date(tempExpiresAt));
        break;

      case 'apply-block-list':
        teacherBlockedDomains = command.data.blockedDomains || [];
        activeBlockListName = command.data.blockListName || null;

        // NOTE: Teacher block lists are SESSION-BASED and NOT persisted to storage
        // They only apply while the student is in the teacher's active session
        // When service worker restarts or student joins another class, they're cleared

        // Update blocking rules (merges with global blacklist)
        await updateTeacherBlockListRules(teacherBlockedDomains);

        if (teacherBlockedDomains.length > 0) {
          safeNotify({
            title: 'Block List Applied',
            message: `Your teacher has blocked: ${teacherBlockedDomains.slice(0, 3).join(', ')}${teacherBlockedDomains.length > 3 ? '...' : ''}`,
            priority: 1,
          });
        }

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
        
        console.log('[Block List] Teacher block list removed');
        break;
        
      case 'limit-tabs':
        currentMaxTabs = command.data.maxTabs;
        
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
        
        console.log('Tab limit set to:', currentMaxTabs);
        break;

      case 'attention-mode':
        // Show/hide attention overlay on all tabs (parallel for speed)
        const attentionActive = command.data.active;
        const attentionMessage = command.data.message || 'Please look up!';

        await broadcastToAllTabs('attention-mode', { active: attentionActive, message: attentionMessage });

        if (attentionActive) {
          safeNotify({
            title: 'Attention Required',
            message: attentionMessage,
            priority: 2,
          });
        }

        console.log('Attention mode:', attentionActive ? 'ON' : 'OFF', attentionMessage);
        break;

      case 'timer':
        // Start/stop timer overlay on all tabs (parallel for speed)
        const timerAction = command.data.action;
        const timerSeconds = command.data.seconds;
        const timerMessage = command.data.message || '';

        await broadcastToAllTabs('timer', { action: timerAction, seconds: timerSeconds, message: timerMessage });

        if (timerAction === 'start') {
          safeNotify({
            title: 'Timer Started',
            message: `${Math.floor(timerSeconds / 60)}:${String(timerSeconds % 60).padStart(2, '0')} remaining`,
            priority: 1,
          });
        }

        console.log('Timer:', timerAction, timerSeconds, 'seconds');
        break;

      case 'poll':
        // Show/hide poll overlay on all tabs (parallel for speed)
        const pollAction = command.data.action;
        const pollId = command.data.pollId;
        const pollQuestion = command.data.question;
        const pollOptions = command.data.options;

        await broadcastToAllTabs('poll', { action: pollAction, pollId, question: pollQuestion, options: pollOptions });

        if (pollAction === 'start') {
          safeNotify({
            title: 'Poll',
            message: pollQuestion,
            priority: 2,
          });
        }

        console.log('Poll:', pollAction, pollId);
        break;

      case 'chat-notification':
        // Show chat notification overlay on all tabs (parallel for speed)
        const chatMessage = command.data.message;
        const chatFromName = command.data.fromName;

        await broadcastToAllTabs('chat-notification', { message: chatMessage, fromName: chatFromName });

        console.log('Chat notification sent:', chatFromName, chatMessage);
        break;

      case 'hand-dismissed':
        // Notify student their hand was acknowledged
        chrome.storage.local.set({ handRaised: false });

        await broadcastToAllTabs('hand-dismissed', {});

        console.log('Hand dismissed notification sent');
        break;

      case 'messaging-toggle':
        // Update local storage with messaging enabled state
        const messagingEnabled = command.data.enabled;
        chrome.storage.local.set({ messagingEnabled });

        await broadcastToAllTabs('messaging-toggle', { enabled: messagingEnabled });

        console.log('Messaging toggle sent:', messagingEnabled);
        break;
    }
  } catch (error) {
    console.error('Error handling remote control command:', error);
  }
}

// Helper function to ensure content script is injected
async function ensureContentScriptInjected(tabId) {
  try {
    // Try to ping the content script
    await chrome.tabs.sendMessage(tabId, { type: 'ping-test' });
  } catch (error) {
    // Content script not loaded, inject it
    try {
      await chrome.scripting.executeScript({
        target: { tabId: tabId },
        files: ['content.js']
      });
      console.log('Content script injected into tab:', tabId);
    } catch (injectError) {
      console.log('Could not inject content script into tab:', tabId, injectError);
      throw injectError;
    }
  }
}

// Helper function to broadcast message to all tabs in parallel (faster delivery)
async function broadcastToAllTabs(messageType, messageData) {
  const tabs = await chrome.tabs.query({});
  const validTabs = tabs.filter(tab =>
    tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')
  );

  // Process all tabs in parallel for faster delivery
  await Promise.allSettled(validTabs.map(async (tab) => {
    try {
      await ensureContentScriptInjected(tab.id);
      await chrome.tabs.sendMessage(tab.id, {
        type: messageType,
        data: messageData
      });
    } catch (error) {
      console.log(`Could not send ${messageType} to tab:`, tab.id, error);
    }
  }));
}

// Chat/Message Handlers (Phase 2)
async function handleChatMessage(message) {
  console.log('Chat message received:', message);
  
  // Show full-screen modal on all active tabs
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    // Skip chrome:// URLs and extension pages
    if (tab.url && !tab.url.startsWith('chrome://') && !tab.url.startsWith('chrome-extension://')) {
      try {
        // Ensure content script is injected before sending message
        await ensureContentScriptInjected(tab.id);
        
        await chrome.tabs.sendMessage(tab.id, {
          type: 'show-message',
          data: {
            message: message.message,
            fromName: message.fromName || 'Teacher',
            timestamp: message.timestamp || Date.now(),
          },
        });
      } catch (error) {
        console.log('Could not send message to tab:', tab.id, error);
      }
    }
  }
  
  // Also show browser notification as backup
  safeNotify({
    title: `Message from ${message.fromName || 'Teacher'}`,
    message: message.message,
    priority: 2,
    requireInteraction: false,
  });
  
  // Store message in local storage for popup to display
  const stored = await chrome.storage.local.get(['messages']);
  const messages = stored.messages || [];
  messages.push({
    ...message,
    timestamp: Date.now(),
    read: false,
  });
  
  // Keep only last 50 messages
  if (messages.length > 50) {
    messages.shift();
  }
  
  await chrome.storage.local.set({ messages });
  
  // Update badge to show unread count
  const unreadCount = messages.filter(m => !m.read).length;
  chrome.action.setBadgeText({ text: unreadCount > 0 ? String(unreadCount) : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#3b82f6' }); // Blue for messages
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
  // Only check main frame navigations
  if (details.frameId !== 0) return;
  
  // Allow chrome:// URLs
  if (details.url.startsWith('chrome://') || details.url.startsWith('about:')) {
    return;
  }
  
  const targetDomain = extractDomain(details.url);
  if (!targetDomain) return;

  // Clean up expired temporary allowed domains
  const now = Date.now();
  temporaryAllowedDomains = temporaryAllowedDomains.filter(d => d.expiresAt > now);

  // Check if domain is temporarily allowed (bypass blocking)
  const isTempAllowed = temporaryAllowedDomains.some(d => {
    const normalizedAllowed = d.domain.replace(/^www\./, '');
    return targetDomain === normalizedAllowed || targetDomain.endsWith('.' + normalizedAllowed);
  });

  if (isTempAllowed) {
    console.log('[Temp Unblock] Allowing temporarily unblocked domain:', targetDomain);
    return; // Allow navigation
  }

  // Check global blacklist first (school-wide blocked domains)
  if (globalBlockedDomains.length > 0) {
    const isBlacklisted = globalBlockedDomains.some(blockedDomain => {
      const normalizedBlocked = blockedDomain.replace(/^www./, '');
      return targetDomain === normalizedBlocked || targetDomain.endsWith('.' + normalizedBlocked);
    });
    
    if (isBlacklisted) {
      console.log('[Blacklist] Blocked navigation to:', details.url);
      
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

  // Check teacher block list (session-based)
  if (teacherBlockedDomains.length > 0) {
    const isTeacherBlocked = teacherBlockedDomains.some(blockedDomain => {
      const normalizedBlocked = blockedDomain.replace(/^www./, '');
      return targetDomain === normalizedBlocked || targetDomain.endsWith('.' + normalizedBlocked);
    });
    
    if (isTeacherBlocked) {
      console.log('[Teacher Block List] Blocked navigation to:', details.url);
      
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
});

// Track navigation commits for instant URL updates (fires immediately when navigation commits)
chrome.webNavigation.onCommitted.addListener(async (details) => {
  // Only track main frame navigations
  if (details.frameId !== 0) return;
  if (trackingState === TRACKING_STATES.OFF) return;

  // Skip Chrome internal pages
  if (!details.url.startsWith('http')) return;

  // Send immediate heartbeat - this fires the moment navigation commits
  // (before page is loaded, so teacher sees URL change instantly)
  safeSendHeartbeat('navigation-committed');
});

// Enforce tab limit and screen lock
chrome.tabs.onCreated.addListener(async (tab) => {
  // First check: if screen is locked to a SINGLE domain/URL, prevent opening new tabs entirely
  // BUT if it's a scene (multiple allowed domains), allow new tabs - navigation will be checked separately
  if (screenLocked && lockedDomain && allowedDomains.length === 0) {
    // Single domain lock mode - block all new tabs
    if (tab.id) {
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
      reasons: ['USER_MEDIA'],
      justification: 'Screen capture and WebRTC must run in page context for MV3 compatibility'
    }).then(() => {
      console.log('[Service Worker] Offscreen document created');
    }).catch(error => {
      console.error('[Service Worker] Error creating offscreen document:', error);
      creatingOffscreen = null;
      throw error;
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
    
    // Tell offscreen to start capture
    // mode: 'auto' = try silent tab capture, fallback to picker
    // mode: 'tab' = only silent tab capture
    // mode: 'screen' = only picker
    const result = await sendToOffscreen({
      type: 'START_SHARE',
      deviceId: CONFIG.deviceId,
      mode: mode
    });
    
    if (!result?.success) {
      // Check if this is an expected failure (user denied, etc.)
      if (result?.status === 'user-denied') {
        console.info('[WebRTC] User denied screen share (expected behavior)');
        // Don't notify - this is normal
        return;
      } else if (result?.status === 'tab-capture-unavailable') {
        console.info('[WebRTC] Silent tab capture not available (expected on unmanaged devices)');
        // This is expected, just log it
        return;
      } else {
        // Unexpected error
        console.error('[WebRTC] Unexpected screen share error:', result?.error);
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
    console.error('[WebRTC] Unexpected screen share request error:', error);
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
    console.error('[WebRTC] Error stopping screen share:', error);
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
      console.error('[WebRTC] Unexpected offer handling error:', response?.error);
      return;
    }
    
    console.log('[WebRTC] Offer handled in offscreen document');
  } catch (error) {
    // Only unexpected errors reach here
    console.error('[WebRTC] Unexpected error handling offer:', error);
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
    console.error('[WebRTC] Error stopping screen share:', error);
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
  
  // Forward ICE candidates to teacher
  if (message.type === 'ICE_CANDIDATE') {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'ice',
        to: 'teacher',
        candidate: message.candidate,
      }));
    }
    sendResponse({ success: true });
  }
  
  // Forward answer to teacher
  if (message.type === 'ANSWER') {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'answer',
        to: 'teacher',
        sdp: message.sdp,
      }));
    }
    sendResponse({ success: true });
  }
  
  // Handle connection failures
  if (message.type === 'CONNECTION_FAILED') {
    console.log('[WebRTC] Connection failed, cleaning up');
    closeOffscreenDocument();
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

// Connect to WebSocket for signaling
function connectWebSocket() {
  if (trackingState !== TRACKING_STATES.ACTIVE) {
    console.log('Skipping WebSocket - tracking state is not ACTIVE');
    return;
  }
  // EMAIL-FIRST: Require both email and deviceId for WebSocket
  if (!CONFIG.studentEmail || !CONFIG.deviceId) {
    console.log('Skipping WebSocket - missing email or deviceId');
    return;
  }
  
  // Clear any pending reconnection alarm since we're connecting now
  chrome.alarms.clear('ws-reconnect');
  
  const protocol = CONFIG.serverUrl.startsWith('https') ? 'wss' : 'ws';
  const wsUrl = `${protocol}://${new URL(CONFIG.serverUrl).host}/ws`;
  
  ws = new WebSocket(wsUrl);
  
  ws.onopen = () => {
    console.log('WebSocket connected');
    wsReconnectBackoffMs = 5000;
    // Authenticate as student - prefer JWT token (faster), fallback to email lookup
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        const authPayload = {
          type: 'auth',
          role: 'student',
          deviceId: CONFIG.deviceId,
        };

        // Prefer JWT token authentication (avoids email domain lookup)
        if (CONFIG.studentToken) {
          authPayload.studentToken = CONFIG.studentToken;
          console.log('WebSocket auth: using JWT token');
        } else {
          // Fallback to email-based authentication
          authPayload.studentEmail = CONFIG.studentEmail;
          console.log('WebSocket auth: using email (no JWT token)');
        }

        ws.send(JSON.stringify(authPayload));
        console.log('WebSocket auth sent');
      } else {
        console.warn('WebSocket not ready yet, will retry on next connection');
      }
    } catch (error) {
      console.error('Failed to send auth message:', error);
    }
  };
  
  ws.onmessage = (event) => {
    try {
      const message = JSON.parse(event.data);
      console.log('WebSocket message:', message);
      
      // Handle authentication success with settings
      if (message.type === 'auth-success') {
        console.log('WebSocket authenticated successfully');
        
        // Always update maxTabsPerStudent setting (including null for unlimited)
        if (message.settings && message.settings.hasOwnProperty('maxTabsPerStudent')) {
          const newLimit = message.settings.maxTabsPerStudent;
          
          // Update currentMaxTabs (null or non-positive means unlimited)
          // Treat 0 and negative as unlimited by converting to null
          currentMaxTabs = (newLimit !== null && newLimit > 0) ? newLimit : null;
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
                console.error('Error enforcing tab limit:', error);
              }
            })();
          }
        }

        // Handle global blocked domains (school-wide blacklist)
        if (message.settings && message.settings.globalBlockedDomains) {
          globalBlockedDomains = message.settings.globalBlockedDomains;
          console.log('[Blacklist] Received from server:', globalBlockedDomains);

          // Apply blacklist rules and persist to storage
          (async () => {
            try {
              await updateGlobalBlacklistRules(globalBlockedDomains);
              await chrome.storage.local.set({ globalBlockedDomains });
              console.log('[Blacklist] Persisted to storage');
            } catch (error) {
              console.error('[Blacklist] Error applying rules:', error);
            }
          })();
        }

        // Clear any existing teacher block list on new auth
        // Teacher block lists are session-based and tied to specific teacher sessions
        if (teacherBlockedDomains.length > 0) {
          console.log('[Block List] Clearing teacher block list on new auth (session-based)');
          teacherBlockedDomains = [];
          activeBlockListName = null;
          (async () => {
            try {
              await clearTeacherBlockListRules();
            } catch (error) {
              console.error('[Block List] Error clearing rules on auth:', error);
            }
          })();
        }
      }

      // Handle global blacklist updates from server
      if (message.type === 'update-global-blacklist') {
        globalBlockedDomains = message.blockedDomains || [];
        console.log('[Blacklist] Update received from server:', globalBlockedDomains);
        
        // Apply updated blacklist rules and persist to storage
        (async () => {
          try {
            await updateGlobalBlacklistRules(globalBlockedDomains);
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
            console.error('[Blacklist] Error applying updated rules:', error);
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
        handleRemoteControl(message.command);
      }
      
      // Handle chat messages (Phase 2)
      if (message.type === 'chat') {
        handleChatMessage(message);
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
        if (ws && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'broadcast-join' }));
        }
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
      console.error('Error processing WebSocket message:', error);
    }
  };
  
  ws.onerror = (error) => {
    console.error('WebSocket error:', error);
  };
  
  ws.onclose = () => {
    console.log('WebSocket disconnected');
    ws = null; // Clear the reference
    setObservedState(false, 'ws-closed');
    
    if (trackingState !== TRACKING_STATES.ACTIVE) {
      return;
    }

    const delay = Math.min(wsReconnectBackoffMs, 120000);
    console.log(`WebSocket will reconnect in ${Math.round(delay / 1000)}s...`);
    chrome.alarms.create('ws-reconnect', {
      when: Date.now() + delay,
    });
    wsReconnectBackoffMs = Math.min(wsReconnectBackoffMs * 2, 120000);
  };
}

// Tab change listener - send immediate heartbeat when user switches tabs
chrome.tabs.onActivated.addListener(async (activeInfo) => {
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
  // Allow both ACTIVE and IDLE states
  if (trackingState === TRACKING_STATES.OFF) return;
  if (!tab.active || !(changeInfo.url || changeInfo.title)) return;
  if (changeInfo.url) {
    queueNavigationEvent('url_change', changeInfo.url, tab.title || 'No title', { tabId });
    // Send immediate heartbeat to update teacher dashboard quickly
    safeSendHeartbeat('url-changed');
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
          console.error('Failed to refresh tab:', error);
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

  // Handle poll response from content script
  if (message.type === 'poll-response') {
    const { pollId, selectedOption } = message;
    console.log('Poll response received:', pollId, selectedOption);

    // Send poll response to server
    if (CONFIG.deviceId && CONFIG.serverUrl) {
      const headers = buildDeviceAuthHeaders();
      headers['Content-Type'] = 'application/json';

      fetch(`${CONFIG.serverUrl}/api/polls/${pollId}/respond`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          deviceId: CONFIG.deviceId,
          studentId: CONFIG.activeStudentId,
          selectedOption,
        }),
      })
        .then(res => res.json())
        .then(data => {
          console.log('Poll response submitted:', data);
        })
        .catch(err => {
          console.error('Failed to submit poll response:', err);
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

    fetch(`${CONFIG.serverUrl}/api/student/raise-hand`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        deviceId: CONFIG.deviceId,
        studentId: CONFIG.activeStudentId,
        studentEmail: CONFIG.studentEmail,
        studentName: CONFIG.studentName,
      }),
    })
      .then(res => res.json())
      .then(data => {
        console.log('Hand raised:', data);
        sendResponse({ success: true, data });
      })
      .catch(err => {
        console.error('Failed to raise hand:', err);
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

    fetch(`${CONFIG.serverUrl}/api/student/lower-hand`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        deviceId: CONFIG.deviceId,
        studentId: CONFIG.activeStudentId,
      }),
    })
      .then(res => res.json())
      .then(data => {
        console.log('Hand lowered:', data);
        sendResponse({ success: true, data });
      })
      .catch(err => {
        console.error('Failed to lower hand:', err);
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

    fetch(`${CONFIG.serverUrl}/api/student/send-message`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        message: message.message.trim(),
        messageType: message.messageType || 'message',
      }),
    })
      .then(res => res.json())
      .then(data => {
        if (data.error) {
          console.error('Failed to send message:', data.error);
          sendResponse({ success: false, error: data.error });
        } else {
          console.log('Message sent:', data);
          sendResponse({ success: true, messageId: data.messageId });
        }
      })
      .catch(err => {
        console.error('Failed to send message:', err);
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
        });
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
    
    // Send immediate heartbeat with new studentId
    safeSendHeartbeat('student-changed');
    
    // Log student_switched event
    if (licenseActive && CONFIG.deviceId) {
      const headers = buildDeviceAuthHeaders();
      const payload = {
        deviceId: CONFIG.deviceId,
        eventType: 'student_switched',
        metadata: { 
          previousStudentId,
          newStudentId: message.studentId,
          timestamp: new Date().toISOString(),
        },
      };
      attachLegacyStudentToken(payload, headers);

      fetch(`${CONFIG.serverUrl}/api/device/event`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload),
      }).then(async (response) => {
        if (response.status === 402) {
          const data = await response.json().catch(() => ({}));
          await disableForInactiveLicense(data.planStatus);
        }
      }).catch(error => {
        console.error('Error logging student_switched event:', error);
      });
    }
    
    sendResponse({ success: true });
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
