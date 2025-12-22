// ClassPilot - Service Worker
// Handles background heartbeat sending and tab monitoring

// Production server URL - can be overridden in extension settings
const DEFAULT_SERVER_URL = 'https://classpilot.replit.app';

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
const HEARTBEAT_ACTIVE_MINUTES = 1;
const HEARTBEAT_IDLE_MINUTES = 10;

let trackingState = TRACKING_STATES.OFF;
let idleState = 'active';
let schoolSettings = null;
let schoolSettingsFetchedAt = 0;
let wsReconnectBackoffMs = 5000;
let navigationDebounceTimer = null;
let pendingNavigationEvent = null;
let lastLoggedUrl = null;
let lastLoggedAt = 0;
let idleListenerReady = false;
let settingsAlarmScheduled = false;

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
    const headers = {};
    if (CONFIG.studentToken) {
      headers['x-student-token'] = CONFIG.studentToken;
    }
    const response = await fetch(`${CONFIG.serverUrl}/api/settings`, {
      cache: 'no-store',
      headers,
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
  // School hours enforcement is based solely on admin-configured /api/settings values.
  const withinHours = isWithinTrackingHours(
    effectiveSettings.enableTrackingHours,
    effectiveSettings.trackingStartTime,
    effectiveSettings.trackingEndTime,
    effectiveSettings.schoolTimezone,
    effectiveSettings.trackingDays
  );

  if (!withinHours) {
    return TRACKING_STATES.OFF;
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
  chrome.alarms.clear('heartbeat');
  if (periodInMinutes) {
    chrome.alarms.create('heartbeat', { periodInMinutes });
    sendHeartbeat();
  }
}

async function updateTrackingState(reason = 'state-check') {
  const nextState = determineTrackingState();
  if (trackingState === nextState) {
    return;
  }

  trackingState = nextState;
  console.log(`[Tracking] State updated to ${trackingState} (${reason})`);

  if (trackingState === TRACKING_STATES.ACTIVE) {
    scheduleHeartbeat(HEARTBEAT_ACTIVE_MINUTES);
    connectWebSocket();
  } else if (trackingState === TRACKING_STATES.IDLE) {
    scheduleHeartbeat(HEARTBEAT_IDLE_MINUTES);
    disconnectWebSocket();
  } else {
    scheduleHeartbeat(null);
    disconnectWebSocket();
  }
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
  if (trackingState !== TRACKING_STATES.ACTIVE) {
    return;
  }
  if (!isHttpUrl(url)) {
    return;
  }

  pendingNavigationEvent = { eventType, url, title, metadata };
  if (navigationDebounceTimer) {
    clearTimeout(navigationDebounceTimer);
  }

  navigationDebounceTimer = setTimeout(async () => {
    const event = pendingNavigationEvent;
    pendingNavigationEvent = null;
    navigationDebounceTimer = null;

    if (!event || trackingState !== TRACKING_STATES.ACTIVE) {
      return;
    }

    const now = Date.now();
    if (event.url === lastLoggedUrl && now - lastLoggedAt < 5000) {
      return;
    }
    lastLoggedUrl = event.url;
    lastLoggedAt = now;

    if (!CONFIG.deviceId) return;

    try {
      await fetch(`${CONFIG.serverUrl}/api/event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: CONFIG.deviceId,
          eventType: event.eventType,
          metadata: {
            url: event.url,
            title: event.title,
            ...event.metadata,
          },
        }),
      });
    } catch (error) {
      console.error('Event logging error:', error);
    }
  }, 1000);
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
    const configUrl = `${DEFAULT_SERVER_URL}/api/client-config`;
    const serverConfig = await fetch(configUrl, { cache: 'no-store' })
      .then(r => r.json())
      .catch(() => ({ baseUrl: DEFAULT_SERVER_URL }));
    
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
          console.log('[Service Worker] Auto-detected email:', stored.studentEmail);
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
        console.log('[Service Worker] Registering student with server:', stored.studentEmail);
        const response = await fetch(`${CONFIG.serverUrl}/api/register-student`, {
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
        console.log('[Service Worker] Student registered successfully:', data);
        
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
      console.log('[Service Worker] Already registered:', stored.studentEmail);
    }
    
    console.log('[Service Worker] Registration complete:', {
      email: stored.studentEmail,
      deviceId: stored.deviceId,
      registered: stored.registered || needsRegistration,
    });
    
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
  ensureRegistered();
  setTimeout(() => initializeAdaptiveTracking('install'), 2000);
});

if (chrome.runtime.onStartup) {
  chrome.runtime.onStartup.addListener(() => {
    console.log('[Service Worker] Browser started');
    ensureRegistered();
    setTimeout(() => initializeAdaptiveTracking('startup'), 2000);
  });
}

// Run immediately on service worker load/wake-up
// This is CRITICAL: service worker can wake up after being terminated, not just on install/startup
(async () => {
  console.log('[Service Worker] Waking up...');
  await ensureRegistered();
  
  // MIGRATION: Clear any persisted serverUrl overrides from testing
  // Force all extensions to use production URL (classpilot.replit.app)
  const stored = await chrome.storage.local.get(['deviceId', 'config', 'activeStudentId', 'studentEmail', 'flightPathState', 'lockScreenState']);
  if (stored.config?.serverUrl) {
    console.log('[Service Worker] MIGRATION: Clearing persisted serverUrl override:', stored.config.serverUrl);
    delete stored.config.serverUrl;
    await chrome.storage.local.set({ config: stored.config });
  }
  
  // Restore state from storage (but serverUrl now always uses DEFAULT_SERVER_URL)
  if (stored.config) {
    const { serverUrl, ...safeConfig } = stored.config;
    CONFIG = { ...CONFIG, ...safeConfig };
  }
  // Always enforce production URL
  CONFIG.serverUrl = DEFAULT_SERVER_URL;
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
  
  console.log('[Service Worker] State restored:', { 
    deviceId: CONFIG.deviceId, 
    studentEmail: CONFIG.studentEmail,
    flightPathActive: allowedDomains.length > 0,
    screenLocked: screenLocked
  });
  
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
  if (result.config) {
    CONFIG = { ...CONFIG, ...result.config };
    console.log('Loaded config:', CONFIG);
  }
  
  // Ensure serverUrl is set (use stored config, or fall back to default production URL)
  if (!CONFIG.serverUrl) {
    CONFIG.serverUrl = DEFAULT_SERVER_URL;
  }
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
    const response = await fetch(`${CONFIG.serverUrl}/api/register-student`, {
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
async function sendHeartbeat() {
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
    // Get active tab (prefer current window, fallback to global)
    let tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    
    // If no tab in current window, try global query
    if (tabs.length === 0) {
      tabs = await chrome.tabs.query({ active: true });
    }
    
    // Determine tab data or use fallback for "no active tab" state
    // IMPORTANT: Use empty strings instead of null for Zod schema validation
    let activeTabUrl = '';
    let activeTabTitle = '';
    let favicon = null;
    
    // Only report tab if we have exactly one active tab with HTTP URL
    // Avoid reporting arbitrary tabs from multi-window scenarios
    if (tabs.length === 1) {
      const activeTab = tabs[0];
      // Skip chrome-internal URLs (chrome://, chrome-extension://, etc.)
      if (activeTab.url && activeTab.url.startsWith('http')) {
        activeTabUrl = activeTab.url;
        activeTabTitle = activeTab.title || '';
        favicon = activeTab.favIconUrl || null;
      }
      // Otherwise keep empty strings (Chrome internal page = no monitored activity)
    } else if (tabs.length > 1) {
      // Multiple active tabs across windows - indeterminate state
      console.log('Multiple active tabs detected (' + tabs.length + ') - reporting as no active tab');
    }
    // If tabs.length === 0, keep empty strings
    
    // Collect ALL open tabs for teacher dashboard
    let allOpenTabs = [];
    try {
      const allTabs = await chrome.tabs.query({});
      allOpenTabs = allTabs
        .filter(tab => tab.url && tab.url.startsWith('http')) // Only HTTP(S), skip chrome://
        .slice(0, 20) // Limit to 20 tabs
        .map(tab => ({
          url: (tab.url || '').substring(0, 512), // Truncate to 512 chars
          title: (tab.title || 'Untitled').substring(0, 512), // Truncate to 512 chars
        }));
    } catch (error) {
      console.warn('Failed to collect all tabs:', error);
      // Continue with empty array
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
    
    // ✅ JWT AUTHENTICATION: Include studentToken if available (INDUSTRY STANDARD)
    if (CONFIG.studentToken) {
      heartbeatData.studentToken = CONFIG.studentToken;
      console.log('Sending JWT-authenticated heartbeat for email:', CONFIG.studentEmail, '| deviceId:', CONFIG.deviceId);
    } else {
      console.log('⚠️  Sending legacy heartbeat (no JWT) for email:', CONFIG.studentEmail, '| deviceId:', CONFIG.deviceId);
    }
    
    const response = await fetch(`${CONFIG.serverUrl}/api/heartbeat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(heartbeatData),
    });
    
    if (response.status === 401 || response.status === 403) {
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
    console.error('Heartbeat network error:', error);
    chrome.action.setBadgeBackgroundColor({ color: '#ef4444' });
    chrome.action.setBadgeText({ text: '!' });
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
    sendHeartbeat();
  } else if (alarm.name === 'ws-reconnect') {
    // WebSocket reconnection alarm - reliable even if service worker was terminated
    console.log('WebSocket reconnection alarm triggered');
    connectWebSocket();
  } else if (alarm.name === 'health-check') {
    // Periodic health check to ensure heartbeat and WebSocket are running
    // This recovers from service worker restarts without needing manual reload
    healthCheck();
  } else if (alarm.name === 'settings-refresh') {
    refreshSchoolSettings({ force: false }).then(() => {
      updateTrackingState('settings-refresh');
    });
  }
});

// Remote Control Handlers (Phase 1: GoGuardian-style features)
let screenLocked = false;
let lockedUrl = null;
let lockedDomain = null; // Single domain for lock-screen (e.g., "ixl.com")
let allowedDomains = []; // Multiple domains for apply-flight-path (e.g., ["ixl.com", "khanacademy.org"])
let activeFlightPathName = null; // Name of the currently active scene
let currentMaxTabs = null;

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
    sendResponse({ success: true });
  }
  
  // Handle capture errors
  if (message.type === 'CAPTURE_ERROR') {
    safeNotify({
      title: 'Screen Sharing Error',
      message: message.error || 'Failed to capture screen',
    });
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
    // Authenticate as student with email as primary identity
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
          type: 'auth',
          role: 'student',
          studentEmail: CONFIG.studentEmail,  // 🟢 Primary identity - backend determines schoolId from domain
          deviceId: CONFIG.deviceId,          // Internal tracking
        }));
        console.log('WebSocket auth sent for:', CONFIG.studentEmail);
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

// Tab change listener - send immediate heartbeat
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  if (trackingState !== TRACKING_STATES.ACTIVE) return;
  try {
    const tab = await chrome.tabs.get(activeInfo.tabId);
    queueNavigationEvent('tab_change', tab.url, tab.title || 'No title', { tabId: activeInfo.tabId });
  } catch (error) {
    console.warn('Failed to read active tab info:', error);
  }
});

// Tab update listener - send heartbeat on URL/title change
chrome.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (trackingState !== TRACKING_STATES.ACTIVE) return;
  if (!tab.active || !(changeInfo.url || changeInfo.title)) return;
  if (changeInfo.url) {
    queueNavigationEvent('url_change', changeInfo.url, tab.title || 'No title', { tabId });
  }
});

// Listen for messages from popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
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
    sendHeartbeat();
    
    // Log student_switched event
    if (CONFIG.deviceId) {
      fetch(`${CONFIG.serverUrl}/api/event`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          deviceId: CONFIG.deviceId,
          eventType: 'student_switched',
          metadata: { 
            previousStudentId,
            newStudentId: message.studentId,
            timestamp: new Date().toISOString(),
          },
        }),
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
    sendHeartbeat();
    
    sendResponse({ success: true });
    return true;
  }
});

console.log('ClassPilot service worker loaded');
